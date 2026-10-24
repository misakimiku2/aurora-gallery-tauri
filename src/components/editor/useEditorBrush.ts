/**
 * 画笔/橡皮的**命令式流程**（2026-10-24 画笔轮）：落笔 → 笔划缓冲 → 抬笔合成换源。
 *
 * ## 架构：bake-on-stroke-end + 显示/落盘分离（2026-10-25 性能轮）
 *
 * 落笔时按目标的**当前 source** 建（或复用）内存像素缓冲（paintBuffers 注册表），
 * 笔划期间图章先画进独立**笔划缓冲**（一笔之内不叠深），抬笔时合成进像素缓冲：
 *
 * - **图层目标（快路径）**：预分配新路径 → 缓冲登记 → `layer.source` 立刻换过去
 *   → 画面由 EditorCanvasLayers **直接渲染内存画布**（零编码、即时）→ PNG 编码
 *   与落盘进**串行后台队列**（enqueueBake）。大层编码 + IPC 要几百毫秒到秒级，
 *   挡在抬笔路径上就是"画完等 1–2 秒才显示"的元凶。
 * - **蒙版目标（慢路径，刻意）**：CSS `mask-image` 只认 URL，文件缺失的一瞬蒙版
 *   会整个失效（图层闪烁成无蒙版）——所以蒙版**等文件真的落盘才换源**，笔划预览
 *   一直顶到换源完成（避免笔迹消失再出现）。
 *
 * ## 坐标（与渲染侧同一套数学，见 brushPaint.paintTargetOf）
 *
 * 图章永远画在**文档坐标**：笔划缓冲是画布尺寸、恒等变换；目标缓冲通过
 * `ctx.setTransform(target.transform)` 接收同样的图章——图层带旋转/缩放时
 * 笔触自动落成正确的形状。
 *
 * ## 预览（已知近似，进度文档 §6）
 *
 * 笔划缓冲镜像到画布上盖着的预览 canvas（文档尺寸）：图层目标每帧重画
 * "目标缓冲 + 笔划"；**蒙版目标只画笔划本体**（蒙版是亮度语义，把它的位图当
 * RGB 铺出来会被看成"蒙版原图被拉伸出现"）。
 */
import { useCallback, useRef } from 'react';
import type { EditorDocument, EditorLayer } from '../../types';
import { layerLocks, resolveActiveLayer } from './layerModel';
import {
  allocatePaintPath,
  bakeCanvasToPath,
  blankCanvas,
  enqueueBake,
} from './brushBake';
import { forgetPaintBuffer, getPaintBuffer, rememberPaintBuffer } from './paintBuffers';
import {
  colorLuminance,
  luminanceToHex,
  paintTargetOf,
  strokeStamps,
  type PaintTarget,
  type StampPoint,
} from './brushPaint';
import { invertAffine, type AffineMatrix } from './layerTransform';

/** 画笔设置（选项条_owned，ImageEditor 持有）。 */
export interface BrushSettings {
  /** 笔径（文档像素，1..300） */
  size: number;
  /** 硬度（0..100：100 = 硬边，0 = 全柔） */
  hardness: number;
  /** 笔画不透明度（1..100；一笔只乘一次，不在图章间叠深） */
  opacity: number;
}

export interface BrushSessionDeps {
  tool: 'brush' | 'eraser';
  settings: BrushSettings;
  foreground: string;
  background: string;
  doc: EditorDocument | undefined;
  transform: { x: number; y: number; scale: number };
  onDocumentChange: (next: EditorDocument) => void;
  flashNotice: (next: { status: 'done' | 'error'; text: string }, ttl?: number) => void;
}

/** 按文件路径建缓冲：读原图走 `read_file_as_base64`（自定义 IPC）——plugin-fs 的
 * `readFile` 会被 capabilities 的 scope 拦掉（forbidden path，2026-10-24 实测）。
 * 返回值是**完整 dataUrl**（`data:image/xxx;base64,....`），要剥前缀再 atob。
 * 字节 → createImageBitmap，不碰 asset 协议，canvas 永不污染。 */
async function loadBuffer(source: string, width: number, height: number): Promise<HTMLCanvasElement> {
  const hit = getPaintBuffer(source);
  if (hit) {
    rememberPaintBuffer(source, hit); // 触碰 LRU
    return hit;
  }
  const { invoke } = await import('@tauri-apps/api/core');
  let b64: string | null = null;
  try {
    b64 = await invoke<string | null>('read_file_as_base64', { filePath: source });
  } catch (e) {
    (await import('../../utils/logger')).error(`[画笔] 读原图 IPC 失败（read_file_as_base64）: ${source}`, String(e));
    throw e;
  }
  if (!b64) {
    (await import('../../utils/logger')).error(`[画笔] 读原图返回空（文件不存在/不可读/超 128MiB 上限）: ${source}`);
    throw new Error(`无法读取图层文件：${source}`);
  }
  const payload = b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(payload);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  const canvas = blankCanvas(width, height);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 上下文');
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  rememberPaintBuffer(source, canvas);
  (await import('../../utils/logger')).info(`[画笔] 像素缓冲就绪 ${width}x${height}：${source}`);
  return canvas;
}

interface StrokeSession {
  layerId: string;
  target: PaintTarget;
  /** 缓冲坐标 → 文档坐标（= inv(target.transform)，画预览时摆目标缓冲用） */
  bufferToDoc: AffineMatrix;
  /** 笔画不透明度 0..1（抬笔合成时一次乘上） */
  alpha: number;
  radius: number;
  hardnessInner: number; // 0..0.98：径向渐变的实心内圈比例
  /** 笔划颜色（#rrggbb；橡皮擦图层时无意义，只用 alpha） */
  color: string;
  /** 合成模式（抬笔时作用于目标缓冲）：普通 / 橡皮擦图层 / 锁透明像素 */
  composite: 'over' | 'erase' | 'atop';
  /** 笔划缓冲（画布尺寸、恒等变换，全 alpha 图章） */
  stroke: HTMLCanvasElement;
  strokeCtx: CanvasRenderingContext2D;
  /** 目标像素缓冲（异步加载；抬笔时必须就绪） */
  buffer: HTMLCanvasElement | null;
  bufferPromise: Promise<HTMLCanvasElement>;
  /** 预览 canvas（画布容器里挂着的那块） */
  preview: HTMLCanvasElement;
  previewCtx: CanvasRenderingContext2D;
  /** 原始指针轨迹（文档坐标）——每帧重算图章、只画新增的尾巴 */
  points: StampPoint[];
  stampsDrawn: number;
  toDoc: (clientX: number, clientY: number) => StampPoint;
  raf: number;
}

/** 画一批图章（径向渐变实现硬度：内圈实心 → 边缘淡出）。 */
function drawStamps(
  ctx: CanvasRenderingContext2D,
  stamps: StampPoint[],
  from: number,
  radius: number,
  inner: number,
  color: string,
) {
  const r = Math.max(0.5, radius);
  for (let i = from; i < stamps.length; i += 1) {
    const p = stamps[i];
    const g = ctx.createRadialGradient(p.x, p.y, r * inner, p.x, p.y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, `${color}00`); // 同色透明（#rrggbb → #rrggbb00）
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 预览重画（已知近似，见文件头"预览"）。
 *
 * **蒙版目标不画缓冲**：蒙版是亮度语义，把它的位图当 RGB 铺在画布上会被看成
 * "蒙版原图被拉伸着出现"（2026-10-24 用户实测）——蒙版笔划只预览笔划本体
 * （灰点/灰线），真实显隐效果抬笔烘焙后立刻可见。图层目标画"缓冲 + 笔划"。 */
function repaintPreview(s: StrokeSession) {
  const { previewCtx: p } = s;
  p.setTransform(1, 0, 0, 1, 0, 0);
  p.clearRect(0, 0, s.preview.width, s.preview.height);
  if (s.buffer && s.target.kind === 'layer') {
    // 目标缓冲按"缓冲→文档"摆进预览（bufferToDoc），笔划本身就是文档坐标
    const m = s.bufferToDoc;
    p.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    p.globalAlpha = 1;
    p.globalCompositeOperation = 'source-over';
    p.drawImage(s.buffer, 0, 0);
    p.setTransform(1, 0, 0, 1, 0, 0);
    p.globalAlpha = s.alpha;
    p.globalCompositeOperation = s.composite === 'erase' ? 'destination-out' : 'source-over';
    p.drawImage(s.stroke, 0, 0);
    p.globalAlpha = 1;
    p.globalCompositeOperation = 'source-over';
  } else {
    // 蒙版目标 / 缓冲还没解码：只显示笔划本体（浅反馈）
    p.globalAlpha = s.alpha;
    p.drawImage(s.stroke, 0, 0);
    p.globalAlpha = 1;
  }
}

export function useEditorBrush(opts: {
  previewCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  /** 每次渲染喂最新值（hook 内部 ref 化，不触发重挂） */
  deps: BrushSessionDeps;
}) {
  const depsRef = useRef(opts.deps);
  depsRef.current = opts.deps;
  const previewCanvasRef = opts.previewCanvasRef;
  const sessionRef = useRef<StrokeSession | null>(null);

  const finishStroke = useCallback(async () => {
    const s = sessionRef.current;
    sessionRef.current = null;
    window.removeEventListener('pointermove', onStrokeMove);
    window.removeEventListener('pointerup', onStrokeUp);
    if (!s) return;
    cancelAnimationFrame(s.raf);

    const d = depsRef.current;
    try {
      const buffer = await s.bufferPromise;
      // 补上最后一段的强制封口图章（绘制期间的前缀稳定序列见 brushPaint）
      const finalStamps = strokeStamps(s.points, s.radius * 2, true);
      drawStamps(s.strokeCtx, finalStamps, s.stampsDrawn, s.radius, s.hardnessInner, s.color);
      // 合成：目标缓冲坐标系下吃下整块笔划（globalAlpha 一次乘 = 笔画不透明度）
      const ctx = buffer.getContext('2d');
      if (!ctx) throw new Error('无法创建 2D 上下文');
      ctx.save();
      ctx.setTransform(
        s.target.transform[0], s.target.transform[1], s.target.transform[2],
        s.target.transform[3], s.target.transform[4], s.target.transform[5],
      );
      ctx.globalAlpha = s.alpha;
      ctx.globalCompositeOperation =
        s.composite === 'erase' ? 'destination-out' : s.composite === 'atop' ? 'source-atop' : 'source-over';
      ctx.drawImage(s.stroke, 0, 0);
      ctx.restore();

      const doc = d.doc;
      const layer = doc?.layers?.find(l => l.id === s.layerId);
      if (!doc || !layer) {
        // 笔画期间层被删了：只丢弃，不报错
        s.preview.style.display = 'none';
        return;
      }
      const oldSource =
        s.target.kind === 'mask' && layer.mask ? layer.mask.source : (layer.source as string);

      if (s.target.kind === 'layer') {
        // ---- 快路径：预分配路径，source 立刻换、画面走内存画布、文件后台补 ----
        const newPath = await allocatePaintPath();
        rememberPaintBuffer(newPath, buffer);
        // 旧 key 必须删：缓冲对象已被这一笔改写，撤销回旧 source 时要靠旧文件而不是它
        forgetPaintBuffer(oldSource);
        const layers = (doc.layers ?? []).map(l =>
          l.id === s.layerId ? { ...l, source: newPath } : l,
        );
        d.onDocumentChange({ ...doc, layers, dirty: true });
        // 图层已由缓冲直染，预览立刻退役
        s.preview.style.display = 'none';
        enqueueBake(() => bakeCanvasToPath(buffer, newPath));
        return;
      }

      // ---- 慢路径（蒙版）：等文件落盘再换源 ----
      // CSS mask-image 只认 URL，预分配的文件缺失时蒙版会闪成"无蒙版"。
      // 换源在串行队列里做（读**当时**的最新文档），笔划预览顶到换源完成。
      enqueueBake(async () => {
        const path = await bakeCanvasToPath(buffer, await allocatePaintPath());
        rememberPaintBuffer(path, buffer);
        forgetPaintBuffer(oldSource);
        const dd = depsRef.current;
        const docNow = dd.doc;
        const layerNow = docNow?.layers?.find(l => l.id === s.layerId);
        const maskNow = layerNow?.mask;
        if (docNow && layerNow && maskNow) {
          const layers = (docNow.layers ?? []).map(l =>
            l.id === s.layerId ? { ...l, mask: { ...maskNow, source: path } } : l,
          );
          dd.onDocumentChange({ ...docNow, layers, dirty: true });
        }
        s.preview.style.display = 'none';
        return path;
      });
    } catch (e) {
      // 完整错误进日志（控制台 + 日志文件）——提示条只露前半句，日志里能看全链路
      (await import('../../utils/logger')).error('[画笔] 这一笔保存失败：', String(e));
      s.preview.style.display = 'none';
      d.flashNotice({ status: 'error', text: `这一笔没能保存：${String(e)}` }, 8000);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStrokeMove = useCallback(
    (e: PointerEvent) => {
      const s = sessionRef.current;
      if (!s) return;
      if (e.buttons === 0) {
        void finishStroke(); // 指针在窗外抬起漏了事件：按结束处理
        return;
      }
      const p = s.toDoc(e.clientX, e.clientY);
      const last = s.points[s.points.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return; // 手抖去抖
      s.points.push(p);
      // 每帧重算图章序列、只画新增的尾巴（全量算很便宜，避免增量状态机）
      cancelAnimationFrame(s.raf);
      s.raf = requestAnimationFrame(() => {
        const stamps = strokeStamps(s.points, s.radius * 2);
        drawStamps(s.strokeCtx, stamps, s.stampsDrawn, s.radius, s.hardnessInner, s.color);
        s.stampsDrawn = stamps.length;
        repaintPreview(s);
      });
    },
    [finishStroke],
  );

  const onStrokeUp = useCallback(() => void finishStroke(), [finishStroke]);

  /**
   * 画布 mousedown 入口（brush/eraser 工具时由 ImageEditor 调）。
   * 返回 true = 事件已消费（不管有没有真的落笔，都别再走选层逻辑）。
   */
  const beginStroke = useCallback(
    (e: React.MouseEvent, container: HTMLElement): boolean => {
      const d = depsRef.current;
      const doc = d.doc;
      if (!doc?.canvas) return false;
      if (sessionRef.current) return true; // 上一笔还没结束（多点触控等）：忽略
      const layer = resolveActiveLayer(doc);
      if (!layer || layer.kind === 'group') {
        d.flashNotice({ status: 'error', text: '先在图层面板选中一个像素图层' });
        return true;
      }
      const locks = layerLocks(layer);
      if (locks.pixel) {
        d.flashNotice({ status: 'error', text: '该图层已锁定像素，不能作画' });
        return true;
      }
      const targetSel = doc.activeTarget === 'mask' && layer.mask ? 'mask' : 'image';
      const target = paintTargetOf(layer, targetSel);
      if (!target) {
        d.flashNotice({
          status: 'error',
          text:
            targetSel === 'mask'
              ? '蒙版不可作画（已停用或没有像素）'
              : '该图层不可作画（没有像素或被压成线）',
        });
        return true;
      }
      // 颜色：画图层 = 前景；橡皮擦图层 = 无色（只吃 alpha，锁透明像素时干脆禁用）；
      // 蒙版 = 灰度（画笔用前景亮度、橡皮用背景亮度——PS 的"橡皮=画背景色"在灰度
      // 蒙版上的口径）
      let color = '#ffffff';
      let composite: StrokeSession['composite'] = 'over';
      if (target.kind === 'mask') {
        color = luminanceToHex(colorLuminance(d.tool === 'brush' ? d.foreground : d.background));
      } else if (d.tool === 'brush') {
        color = d.foreground;
        if (locks.transparent) composite = 'atop'; // 锁透明像素：只画进已有像素
      } else {
        if (locks.transparent) {
          d.flashNotice({ status: 'error', text: '已锁定透明像素，橡皮不可用（不许改 alpha）' });
          return true;
        }
        composite = 'erase';
      }

      const size = Math.min(300, Math.max(1, Math.round(d.settings.size)));
      const preview = previewCanvasRef.current;
      if (!preview) return false;
      // 预览要把目标缓冲摆回文档空间：bufferToDoc = inv(target.transform)
      const bufferToDoc = invertAffine(target.transform);
      if (!bufferToDoc) return false; // 理论上到不了（target.transform 来自 inv(M)）
      preview.width = doc.canvas.width;
      preview.height = doc.canvas.height;
      preview.style.display = 'block';
      const previewCtx = preview.getContext('2d');
      const stroke = blankCanvas(doc.canvas.width, doc.canvas.height);
      const strokeCtx = stroke.getContext('2d');
      if (!previewCtx || !strokeCtx) return false;

      const sourcePath =
        target.kind === 'mask' && layer.mask
          ? layer.mask.source
          : (layer.source as string);
      const rect = container.getBoundingClientRect();
      const t = d.transform; // 视口变换取落笔瞬间（笔画中滚轮缩放极罕见，不追）
      const session: StrokeSession = {
        layerId: layer.id,
        target,
        bufferToDoc,
        alpha: Math.min(1, Math.max(0.01, d.settings.opacity / 100)),
        radius: size / 2,
        hardnessInner: Math.min(0.98, Math.max(0, d.settings.hardness / 100)),
        color,
        composite,
        stroke,
        strokeCtx,
        buffer: null,
        bufferPromise: loadBuffer(sourcePath, target.width, target.height).then(b => {
          if (sessionRef.current === session) {
            session.buffer = b;
            repaintPreview(session);
          }
          return b;
        }),
        preview,
        previewCtx,
        points: [],
        stampsDrawn: 0,
        toDoc: (clientX, clientY) => ({
          x: (clientX - rect.left - t.x) / t.scale,
          y: (clientY - rect.top - t.y) / t.scale,
        }),
        raf: 0,
      };
      sessionRef.current = session;
      window.addEventListener('pointermove', onStrokeMove);
      window.addEventListener('pointerup', onStrokeUp);
      onStrokeMove(e.nativeEvent as PointerEvent);
      return true;
    },
    [onStrokeMove, onStrokeUp, previewCanvasRef],
  );

  return { beginStroke, isPainting: () => !!sessionRef.current };
}
