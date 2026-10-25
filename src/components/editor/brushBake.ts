/**
 * 画笔烘焙的文件面（2026-10-26 架构轮：**空闲合并烘焙**）。
 *
 * ## 相对性能轮（2026-10-25）的变化
 *
 * 性能轮是"每笔一个预分配路径 + 串行队列逐笔落盘"——撤销目标指向还没落盘的文件
 * 就是"整图消失"的元凶，缩略图/全览还得排队等它。现在位图仓（`layerBitmaps`）
 * 是像素真身，烘焙降级为**影子**：
 *
 * - 每键一个**稳定文件名**（`allocatePaintName`），重烤覆写同名文件；
 * - 像素变更后**防抖 800ms** 才烤（连画十笔 = 停手后烤一次），失败保脏、下次再试；
 * - 崩溃恢复粒度 = 距上次烘焙（可接受：未保存的工作本来就会丢）；
 * - **唯一正确性依赖方**是导出/保存工程：它们 `await flushPaintBakes()` 把脏位图
 *   全部落盘，再用 `remapDocBitmapSources` 把读文件的载荷指向烘焙文件——
 *   会话内 `layer.source` 永不切换（撤销栈/预览键全程稳定）。
 *
 * ⚠️ 字节通道不变：读 `read_file_as_base64`（返回完整 dataUrl 要剥前缀）、写
 * `editor_write_paint_png`（base64 进、`std::fs::write` 天然覆写同名文件）——
 * plugin-fs 的 scope 拦绝对路径（2026-10-24 实测），自定义命令不受限。
 */
import type { EditorDocument } from '../../types';
import {
  bitmapMeta,
  bitmapVersion,
  dirtyBitmapKeys,
  ensurePaintName,
  markBaked,
  maskKey,
  onStrokesSettled,
  peekBitmap,
  strokeActive,
  subscribeBitmaps,
} from './layerBitmaps';

/** 缓存目录只问一次（会话级缓存；失败不缓存，下次重试）。 */
let paintDirPromise: Promise<string> | null = null;

export function getPaintDir(): Promise<string> {
  if (!paintDirPromise) {
    paintDirPromise = (async () => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke<string>('editor_paint_cache_dir');
    })();
    paintDirPromise.catch(() => {
      paintDirPromise = null; // 失败不粘住：下次重问
    });
  }
  return paintDirPromise;
}

/** 键 → 烘焙文件名里的安全字符（layerId 本就只含字母数字和连字符，蒙版键的 `::` 换掉）。 */
function sanitizeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '-');
}

let nameSeq = 0;

/**
 * 给一个位图键分配**稳定**的烘焙文件名（同一键重烤永远同名）。
 * 纯函数（不碰 IPC），调用方把它存进位图元数据与图层 source。
 */
export function allocatePaintName(key: string): string {
  nameSeq += 1;
  return `p${Date.now().toString(36)}-${nameSeq}-${sanitizeKey(key)}.png`;
}

/** 键的烘焙文件绝对路径（paintName 已分配时；与 Rust 写盘落点一致）。 */
export async function paintPathOf(key: string): Promise<string | null> {
  const meta = bitmapMeta(key);
  if (!meta?.paintName) return null;
  if (meta.bakedPath) return meta.bakedPath;
  const dir = await getPaintDir();
  return `${dir.replace(/[\\/]+$/, '')}/${meta.paintName}`;
}

async function encodeAndWrite(canvas: HTMLCanvasElement, name: string): Promise<string> {
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('canvas 无法编码为 PNG');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  // 分块转 base64：String.fromCharCode 一次吃几十 MB 会爆调用栈
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<string>('editor_write_paint_png', { base64: btoa(bin), name });
}

// ---- 空闲合并调度：像素变更 → 防抖 → 串行烤所有脏位图 ----

const IDLE_BAKE_DELAY_MS = 800;
let idleTimer: number | null = null;
let bakeChain: Promise<unknown> = Promise.resolve();

async function bakeKey(key: string): Promise<void> {
  const canvas = peekBitmap(key);
  if (!canvas) {
    // 脏位图理论上常驻（逐出只逐 clean 的）；真丢了就放弃这次，等下次
    return;
  }
  const sinceVersion = bitmapVersion(key); // 快照时刻的版本（encode 期间落笔用它判脏）
  const name = ensurePaintName(key, () => allocatePaintName(key));
  const path = await encodeAndWrite(canvas, name);
  markBaked(key, path, sinceVersion);
  (await import('../../utils/logger')).info(
    `[画笔] 空闲烘焙完成 ${canvas.width}x${canvas.height}：${path}`,
  );
}

function pumpIdleBake(): void {
  bakeChain = bakeChain.then(async () => {
    for (const key of dirtyBitmapKeys()) {
      try {
        await bakeKey(key);
      } catch (e) {
        // 保脏：下次任何像素变更/flush 再试；导出/保存的 flush 会把它暴露成明确报错
        (await import('../../utils/logger')).error(`[画笔] 空闲烘焙失败（key=${key}）：`, String(e));
      }
    }
  });
}

/** 像素有任何变更 → 防抖后合并烤一次（模块加载即订阅位图仓）。
 *
 * 笔划进行中让路（strokeActive）：图层笔划逐帧合成 = 版本每帧 +1，照常防抖会
 * 在长笔画中途到期，陷入"编码 → 版本又变 → 再编码"的空转；笔划全部结束后由
 * onStrokesSettled 补排一轮。 */
subscribeBitmaps(() => {
  if (strokeActive()) {
    if (idleTimer !== null) {
      window.clearTimeout(idleTimer);
      idleTimer = null;
    }
    return;
  }
  if (dirtyBitmapKeys().length === 0) return;
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    pumpIdleBake();
  }, IDLE_BAKE_DELAY_MS);
});

onStrokesSettled(() => {
  if (dirtyBitmapKeys().length === 0) return;
  if (idleTimer !== null) window.clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    idleTimer = null;
    pumpIdleBake();
  }, IDLE_BAKE_DELAY_MS);
});

/**
 * 立刻把所有脏位图烤完（取消防抖，排进串行链尾部），并**断言全清**——烘焙是
 * 导出/保存的唯一文件来源，还有脏的（磁盘写失败）就必须报错，而不是让导出
 * 指向缺笔迹/不存在的文件（审计 P1#4）。缩略图路径的 flush 用 `.catch(() => …)`
 * 包一层，失败容忍（缩略图落后一拍不打扰编辑）。
 */
export async function flushPaintBakes(): Promise<void> {
  if (idleTimer !== null) {
    window.clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (dirtyBitmapKeys().length > 0) pumpIdleBake();
  await bakeChain;
  const remaining = dirtyBitmapKeys();
  if (remaining.length > 0) {
    throw new Error(`画笔烘焙未完成（${remaining.length} 个图层写盘失败），请稍后重试`);
  }
}

/**
 * 把文档里"位图领先于 source"的图层/蒙版指向烘焙文件（flush 后调用）。
 * 会话内 `layer.source` 恒为打开时的来源——导出/保存的载荷在这里换算成真身文件。
 * 没有任何位图的文档原样返回（同一引用，不惊动 React）。
 */
export async function remapDocBitmapSources(doc: EditorDocument): Promise<EditorDocument> {
  const layers = doc.layers ?? [];
  let changed = false;
  const next = await Promise.all(
    layers.map(async l => {
      let out = l;
      if (l.source) {
        const p = await paintPathOf(l.id);
        if (p && p !== l.source) {
          out = { ...out, source: p };
        }
      }
      if (out.mask) {
        const mp = await paintPathOf(maskKey(l.id));
        if (mp && mp !== out.mask.source) {
          out = { ...out, mask: { ...out.mask, source: mp } };
        }
      }
      return out;
    }),
  );
  changed = next.some((l, i) => l !== layers[i]);
  return changed ? { ...doc, layers: next } : doc;
}

/** 一张全透明的空白画布（新建空白图层/蒙版的初始像素，进位图仓即时显示）。
 *  进位图仓的画布会被引擎上传泵逐帧 getImageData（M3）：willReadFrequently 只在
 *  第一次 getContext 时生效，所以这里先占住带读优化属性的上下文。 */
export function blankCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  canvas.getContext('2d', { willReadFrequently: true });
  return canvas;
}
