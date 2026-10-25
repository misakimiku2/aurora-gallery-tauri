/**
 * 引擎显示桥（管线换血 M3 前端半边，设计稿 §6/§7）。
 *
 * ## 职责
 *
 * 把 React 的文档状态翻译成引擎的显示载荷（`DisplayDocument`），把位图仓的像素
 * 变更泵成上传（脏矩形 → base64 → `editor_engine_upload_region`），并驱动两档
 * 帧的调度：settle 整帧（低频、防抖）+ 视口交互帧（rAF、拉取 `editor-frame`）。
 *
 * ## 两条铁律
 *
 * 1. **本模块的纯函数不许 import tauri**——`buildDisplayDocument` 要进 vitest；
 *    invoke/convertFileSrc 全部动态 import（与 layerBitmaps 的 readFileBytes 同款）。
 * 2. **双路开关 = localStorage `aurora-editor-engine`**：关掉时本模块的一切调度
 *    都不启动（ImageEditor 渲染旧 DOM 路径），出问题一键切回。
 *
 * ## 与六轮架构的接缝
 *
 * 位图仓仍是像素真身（mutatePixels/applyBitmapPatch 不动语义），只在变更处记
 * 脏矩形（`takeEngineDirty` 泵走）；MaskedPixels/LayerPixels 的 DOM 显示被
 * EngineCanvas 替代，但行缩略图/全览/烘焙照旧走原路（阶段 3 才换）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { EditorCanvas, EditorLayer } from '../../types';
import { splitSegments } from './EditorCanvasLayers';
import { composeMatrix } from './layerTransform';
import { layerBlend, layerOpacity } from './layerModel';
import {
  bitmapMeta,
  displaySourceOf,
  layerKey,
  maskKey,
  readBitmap,
  subscribeBitmaps,
  takeEngineDirty,
} from './layerBitmaps';
import { getEditorView, subscribeEditorView } from './editorViewStore';

type Mat6 = [number, number, number, number, number, number];

// ---- 开关 ----------------------------------------------------------------------

const ENGINE_FLAG = 'aurora-editor-engine';
const TOGGLE_EVENT = 'aurora-engine-toggle';

export function engineDisplayEnabled(): boolean {
  return typeof localStorage !== 'undefined' && localStorage.getItem(ENGINE_FLAG) === '1';
}

export function setEngineDisplayEnabled(on: boolean): void {
  if (on) localStorage.setItem(ENGINE_FLAG, '1');
  else localStorage.removeItem(ENGINE_FLAG);
  window.dispatchEvent(new Event(TOGGLE_EVENT));
}

/** React 侧读开关（自定义事件 + storage 驱动重渲染）。 */
export function useEngineDisplayEnabled(): boolean {
  const [on, setOn] = useState(engineDisplayEnabled);
  useEffect(() => {
    const sync = () => setOn(engineDisplayEnabled());
    window.addEventListener(TOGGLE_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(TOGGLE_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);
  return on;
}

// ---- DisplayDocument 构建（纯函数，vitest 锁形状）------------------------------

/** 引擎显示载荷的图层（与 Rust `DisplayLayer` 的 serde 形状一一对应）。 */
export interface DisplayLayerJson {
  id: string;
  source: { mode: 'file'; path: string } | { mode: 'store' };
  pixelWidth: number;
  pixelHeight: number;
  matrix: [number, number, number, number, number, number];
  adjust: { brightness: number; contrast: number; saturation: number; temperature: number } | null;
  blend: string | null;
  opacity: number | null;
  mask: {
    source:
      | { mode: 'file'; path: string; matrix: [number, number, number, number, number, number] | null }
      | { mode: 'store'; matrix: [number, number, number, number, number, number] | null };
    disabled: boolean;
  } | null;
  clipped: boolean;
}

export interface DisplayDocJson {
  width: number;
  height: number;
  background: string | null;
  groups: { opacity: number; blend: string | null; layers: DisplayLayerJson[] }[];
}

/** editor-frame 协议的 URL（平台分叉与 tauri convertFileSrc 相同，但**不做编码**）。
 *
 * ⚠️ 不能用 convertFileSrc：它把整段路径 encodeURIComponent，`upload?tab_id=…`
 * 的 `?` 会被吃进路径（`/upload%3Ftab_id%3D…`），Rust 侧 path 匹配失败、query
 * 为空——上传请求全被当成视口帧 GET 应答（还是 200），**一个字节都没上传**
 * （2026-10-26 用户实测"画上去画面直接消失"的根因）。键值都是 URL 安全字符
 * （uuid/`::mask`/数字），直插即可。
 */
export function editorFrameUrl(pathAndQuery: string): string {
  return navigator.userAgent.includes('Windows')
    ? `http://editor-frame.localhost/${pathAndQuery}`
    : `editor-frame://localhost/${pathAndQuery}`;
}

/**
 * 已完成上传的像素键（图层键与蒙版键）。**store 模式的唯一依据**——位图常驻只
 * 说明"可以开始上传"，上传完成前层保持 file 模式读烘焙文件（画面不中断）；
 * 否则"store 模式 + 引擎无像素"会渲染成整层透明（本次事故的第二半）。
 * forgetBitmap（像素身份变了）后的重传会重新加入；被遗忘但未重传的键会残留
 * 旧判定（蒙版替换后不再作画的边角），阶段 2 真身迁移后整个问题消失。
 */
const uploadedKeys = new Set<string>();

/** 位图的引擎像素源：**上传已完成**（`uploaded` 集合里有键）→ store 模式；否则
 * file 模式读文件（`displaySourceOf` = 烘焙文件优先——逐出后笔迹在烘焙文件里）。 */
export function layerPixelSource(
  key: string,
  docSource: string,
  uploaded: ReadonlySet<string>,
): DisplayLayerJson['source'] {
  return uploaded.has(key)
    ? { mode: 'store' }
    : { mode: 'file', path: displaySourceOf(key, docSource) };
}

/**
 * 文档状态 → 引擎显示载荷。分段/可见性/蒙版停用口径与 `buildRenderGroups`
 * （导出/全览）同一份逻辑来源（splitSegments），差异只有：多 id、像素源双模、
 * file 蒙版路径走 `displaySourceOf`（烘焙文件优先——笔迹不丢）。
 */
export function buildDisplayDocument(
  canvas: EditorCanvas,
  layers: EditorLayer[],
  uploaded: ReadonlySet<string> = uploadedKeys,
): DisplayDocJson {
  const groups = splitSegments(layers)
    .filter(seg => (seg.type === 'group' ? seg.row : seg.layer).visible !== false)
    .map(seg => {
      const row = seg.type === 'group' ? seg.row : seg.layer;
      const members = seg.type === 'group' ? seg.members : [seg.layer];
      return {
        opacity: layerOpacity(row),
        blend: layerBlend(row),
        layers: members
          .filter(m => m.source && m.visible && m.kind !== 'group')
          .map<DisplayLayerJson>(m => {
            const lKey = layerKey(m.id);
            const matrix = composeMatrix(m.box, {
              width: m.naturalWidth,
              height: m.naturalHeight,
            }) as Mat6;
            const mask = m.mask && !m.mask.disabled ? m.mask : null;
            const maskMatrix: Mat6 | null = mask?.box
              ? (composeMatrix(mask.box, {
                  width: mask.naturalWidth,
                  height: mask.naturalHeight,
                }) as Mat6)
              : null;
            return {
              id: m.id,
              source: layerPixelSource(lKey, m.source as string, uploaded),
              pixelWidth: m.naturalWidth,
              pixelHeight: m.naturalHeight,
              matrix,
              adjust: m.adjust ?? null,
              blend: layerBlend(m),
              opacity: layerOpacity(m),
              mask: mask
                ? {
                    // store 只看**上传已完成**（引擎真有像素）；没上传/烘焙后被
                    // 逐出的蒙版走 file 模式读烘焙文件（displaySourceOf）——内容一样
                    source: uploaded.has(maskKey(m.id))
                      ? { mode: 'store' as const, matrix: maskMatrix }
                      : {
                          mode: 'file' as const,
                          path: displaySourceOf(maskKey(m.id), mask.source),
                          matrix: maskMatrix,
                        },
                    disabled: false,
                  }
                : null,
              clipped: m.clipped === true,
            };
          }),
      };
    })
    .filter(g => g.layers.length > 0);
  return {
    width: canvas.width,
    height: canvas.height,
    background: canvas.background ?? null,
    groups,
  };
}

// ---- 调度泵（模块级，多标签各一份 tabId 维度状态在 hook 里）---------------------

const APPLY_DEBOUNCE_MS = 60;const SETTLE_DEBOUNCE_MS = 250;
/** 单次上传的分条上限（裸字节）：POST 直传没有 base64/JSON 膨胀，6MB/条把
 * 整层物化的往返次数压到个位数（24MP ≈ 7 条）。 */
const ENGINE_CHUNK_BYTES = 6_000_000;

/** 位图仓 → 引擎的上传泵（drain 待办矩形 → 分条直传）。串行化：同刻只跑一个。
 *
 * 传输走 **editor-frame 协议 POST 裸字节**（无 base64/JSON——base64+JSON 的
 * 主线程开销曾把大笔刷拖卡，2026-10-26 用户实测后改的；fetch body 直接吃
 * ImageData.data，主线程只剩 getImageData 一次 unavoidable 拷贝）。
 */
let pumpInFlight = false;
let pumpAgain = false;

async function pumpUploads(tabId: string, onUploaded: () => void): Promise<void> {
  if (pumpInFlight) {
    pumpAgain = true;
    return;
  }
  pumpInFlight = true;
  try {
    for (let round = 0; round < 8; round += 1) {
      const dirty = takeEngineDirty();
      if (dirty.size === 0) break;
      for (const [key, rect] of dirty) {
        const bmp = readBitmap(key);
        const meta = bitmapMeta(key);
        if (!bmp || !meta) continue; // 已逐出/清空：引擎侧由 apply 的 store 集合对账
        const ctx = bmp.getContext('2d');
        if (!ctx) continue;
        const x0 = Math.max(0, rect.x);
        const y0 = Math.max(0, rect.y);
        const x1 = Math.min(meta.width, rect.x + rect.w);
        const y1 = Math.min(meta.height, rect.y + rect.h);
        if (x1 <= x0 || y1 <= y0) continue;
        const cw = x1 - x0;
        const ch = y1 - y0;
        const rowsPerChunk = Math.max(1, Math.floor(ENGINE_CHUNK_BYTES / (cw * 4)));
        for (let y = y0; y < y1; y += rowsPerChunk) {
          const rows = Math.min(rowsPerChunk, y1 - y);
          const imageData = ctx.getImageData(x0, y, cw, rows);
          // 键值直插：内部 id 是 uuid/`::mask`，无需 URL 编码（Rust 侧白名单校验）
          const qs =
            `upload?tab_id=${tabId}&key=${key}&lw=${meta.width}&lh=${meta.height}` +
            `&x=${x0}&y=${y}&rw=${cw}&rh=${rows}`;
          const res = await fetch(editorFrameUrl(qs), {
            method: 'POST',
            body: imageData.data,
          });
          const text = await res.text();
          if (!res.ok || text !== 'ok') {
            // 上传端点的应答是 "ok" 令牌——收到别的（比如视口帧的 200）说明
            // 请求根本没到上传分支，绝不能当成功（2026-10-26 的静默灾难）
            throw new Error(`引擎上传失败: HTTP ${res.status} body=${text.slice(0, 32)}`);
          }
        }
        uploadedKeys.add(key);
      }
      onUploaded();
    }
  } catch (e) {
    // 引擎显示是辅助通路：失败降级不中断编辑（旧 DOM 路径随时可切回）
    console.warn('[引擎显示] 上传失败（可切回 DOM 显示）:', e);
  } finally {
    pumpInFlight = false;
    if (pumpAgain) {
      pumpAgain = false;
      void pumpUploads(tabId, onUploaded);
    }
  }
}

// ---- React 接口 ----------------------------------------------------------------

export interface EngineViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EngineDisplayState {
  /** settle 基底帧的 asset URL（null = 还没出帧） */
  settleUrl: string | null;
  /** 视口细节帧画布的落位（文档空间） */
  viewport: EngineViewportRect | null;
  /** 视口画布 ref（putImageData 目标） */
  viewportRef: React.RefObject<HTMLCanvasElement>;
}

/**
 * 引擎显示的调度核心。挂载即建引擎文档（apply）并出首帧；位图/文档/视口任一
 * 变化 → 重调度。React 状态只有 settleUrl 与 viewport 落位（低频），像素帧
 * 全走 putImageData 命令式更新——不触发重渲染。
 */
export function useEngineDisplay(
  tabId: string,
  canvas: EditorCanvas,
  layers: EditorLayer[],
  transform: { x: number; y: number; scale: number },
): EngineDisplayState {
  const [settleUrl, setSettleUrl] = useState<string | null>(null);
  const [viewport, setViewport] = useState<EngineViewportRect | null>(null);
  const viewportRef = useRef<HTMLCanvasElement | null>(null);

  // 最新 props 的 ref（订阅回调里读，避免重挂订阅）
  const stateRef = useRef({ tabId, canvas, layers, transform });
  stateRef.current = { tabId, canvas, layers, transform };

  const applyTimer = useRef<number | null>(null);
  const settleTimer = useRef<number | null>(null);
  const vpScheduled = useRef(false);
  const vpInFlight = useRef(false);
  const vpDirtyAgain = useRef(false);
  /** 变更纪元：apply/上传/视口任何一环完成后，别的环节据此重调度 */
  const docRev = useRef(0);
  const lastAppliedJson = useRef<string | null>(null);
  const lastSettleRev = useRef(-1);
  /** 第一次 apply 成功前，视口/settle 都不去打引擎（"文档未应用"的启动竞争，
   * 2026-10-26 用户日志实测：视口订阅比 apply 防抖先到，白打一次还刷屏告警） */
  const appliedOnce = useRef(false);

  const scheduleApply = useCallback(() => {
    docRev.current += 1;
    if (applyTimer.current !== null) return;
    applyTimer.current = window.setTimeout(() => {
      applyTimer.current = null;
      void (async () => {
        const { tabId: tid, canvas: cv, layers: ls } = stateRef.current;
        const doc = buildDisplayDocument(cv, ls);
        const json = JSON.stringify(doc);
        if (json === lastAppliedJson.current) return;
        lastAppliedJson.current = json;
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          await invoke('editor_engine_apply', { tabId: tid, doc });
          appliedOnce.current = true;
          scheduleSettle();
          scheduleViewport();
        } catch (e) {
          console.warn('[引擎显示] apply 失败（可切回 DOM 显示）:', e);
        }
      })();
    }, APPLY_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleSettle = useCallback(() => {
    if (!appliedOnce.current) return; // 首次 apply 前引擎还没有文档
    if (settleTimer.current !== null) return;
    settleTimer.current = window.setTimeout(() => {
      settleTimer.current = null;
      void (async () => {
        const tid = stateRef.current.tabId;
        const rev = docRev.current;
        if (rev === lastSettleRev.current) return;
        lastSettleRev.current = rev;
        try {
          const { invoke, convertFileSrc } = await import('@tauri-apps/api/core');
          const frame = await invoke<{ path: string }>('editor_engine_render_settle', {
            tabId: tid,
          });
          // settle 帧走内容哈希文件名：新帧 = 新路径 = <img> 必然重载（URL 级缓存免费）
          setSettleUrl(convertFileSrc(frame.path));
        } catch (e) {
          console.warn('[引擎显示] settle 帧失败:', e);
        }
      })();
    }, SETTLE_DEBOUNCE_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scheduleViewport = useCallback(() => {
    if (vpScheduled.current) return;
    vpScheduled.current = true;
    requestAnimationFrame(() => {
      vpScheduled.current = false;
      void runViewport();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const runViewport = useCallback(async () => {
    if (!appliedOnce.current) return; // 首次 apply 前引擎还没有文档
    if (vpInFlight.current) {
      vpDirtyAgain.current = true;
      return;
    }
    vpInFlight.current = true;
    try {
      const { tabId: tid, canvas: cv, transform: tf } = stateRef.current;
      const view = getEditorView(tid);
      const cw = view?.containerWidth ?? 0;
      const chh = view?.containerHeight ?? 0;
      const scale = tf.scale > 0 ? tf.scale : 1;
      if (cw <= 0 || chh <= 0 || cv.width === 0 || cv.height === 0) return;
      // 可视区域（文档空间）∩ 画布
      const rx0 = Math.max(0, -tf.x / scale);
      const ry0 = Math.max(0, -tf.y / scale);
      const rx1 = Math.min(cv.width, (-tf.x + cw) / scale);
      const ry1 = Math.min(cv.height, (-tf.y + chh) / scale);
      if (rx1 <= rx0 || ry1 <= ry0) return;
      // 输出分辨率：zoom ≥ 100% 按 1:1 文档像素（CSS 放大与现 DOM 行为一致）；
      // zoom < 100% 按屏幕分辨率（引擎降采样，无质量损失）
      const outScale = Math.min(1, scale);
      const outW = Math.max(1, Math.round((rx1 - rx0) * outScale));
      const outH = Math.max(1, Math.round((ry1 - ry0) * outScale));
      const { invoke } = await import('@tauri-apps/api/core');
      await invoke('editor_engine_render_viewport', {
        tabId: tid,
        x: rx0,
        y: ry0,
        width: Math.round(rx1 - rx0),
        height: Math.round(ry1 - ry0),
        scale: outScale,
      });
      const res = await fetch(editorFrameUrl('viewport'));
      if (!res.ok) return;
      const buf = await res.arrayBuffer();
      if (buf.byteLength < 16) return;
      const head = new DataView(buf);
      if (head.getUint32(0, true) !== 0x41524644) return; // "ARFD"
      const fw = head.getUint32(8, true);
      const fh = head.getUint32(12, true);
      if (fw === 0 || fh === 0 || buf.byteLength < 16 + fw * fh * 4) return;
      const target = viewportRef.current;
      if (!target) return;
      if (target.width !== fw) target.width = fw;
      if (target.height !== fh) target.height = fh;
      const ctx = target.getContext('2d');
      if (!ctx) return;
      const clamped = new Uint8ClampedArray(buf, 16, fw * fh * 4);
      ctx.putImageData(new ImageData(clamped, fw, fh), 0, 0);
      setViewport({ left: rx0, top: ry0, width: rx1 - rx0, height: ry1 - ry0 });
    } catch (e) {
      console.warn('[引擎显示] 视口帧失败:', e);
    } finally {
      vpInFlight.current = false;
      if (vpDirtyAgain.current) {
        vpDirtyAgain.current = false;
        scheduleViewport();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 挂载/文档变化：apply + settle
  useEffect(() => {
    scheduleApply();
    scheduleSettle();
  }, [tabId, canvas.width, canvas.height, layers, scheduleApply, scheduleSettle]);

  // 位图变更：先泵上传（画的是最新像素），**上传落地后再渲染视口**——帧序曾
  // 是"通知即渲染"，视口帧可能赶上一次还没落地的上传，画面永远滞后一帧。
  // settle 期间跳过（strokeActive）——笔划结束后由烘焙让路回调补一帧。
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    void (async () => {
      const { strokeActive } = await import('./layerBitmaps');
      if (cancelled) return;
      unsub = subscribeBitmaps(() => {
        if (!strokeActive()) scheduleSettle();
        void pumpUploads(tabId, () => {
          scheduleApply();
          scheduleViewport();
        });
      });
    })();
    return () => {
      cancelled = true;
      unsub();
    };
  }, [tabId, scheduleApply, scheduleSettle, scheduleViewport]);

  // 视口变化（平移/缩放/容器尺寸）
  useEffect(() => {
    const unsub = subscribeEditorView(() => scheduleViewport());
    // transform 直接变化（ImageEditor state）也触发
    scheduleViewport();
    return () => {
      unsub();
    };
  }, [transform.x, transform.y, transform.scale, scheduleViewport]);

  return { settleUrl, viewport, viewportRef };
}
