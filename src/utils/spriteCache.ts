// 经典 3D 文件夹 Sprite 缓存与调度（对应 Folder3DIconCanvas）。
//
//  - 图层缓存：back（后板）/ front（前板+图标）按 (category, theme, size, dpr) 全局缓存，
//    同步合成，滚动瞬间兜底用；shell 由 back+front 组合同步合成（单层贴图最省）。
//  - full 缓存：每文件夹一张完整位图（后板+堆叠预览卡+前板+角标），有界 LRU。
//  - 合成调度：复用 folderTilesRenderer 的串行 idle 队列模式——滚动中只排队不执行，
//    滚动停止延迟 IDLE_DELAY 排空、每张让出主线程、同 key 只合成一次、可 Abort 取消；
//    队列被打断（滚动状态未复位）时用 RETRY 兜底重排，保证最终排空。

import { composeStaticBody, composeBack, composeFront, composeFull, isSpriteSupported, type IconCategory, type IconTheme } from './spriteComposer';
import { getGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge/state';

export const isSpriteSupportedSafe = isSpriteSupported;

// 渲染分辨率：合成位图统一使用至少 2x 像素密度（等同 retina 策略），
// 显示时 GPU 缩小到 1x——与 DOM <img> 的"源图纹理超采样"一致，保证锐利；
// canvas 元素本身仍按 1x 光栅，流畅度不受影响。
const renderRes = (): number => {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio
    ? window.devicePixelRatio : 1;
  return Math.max(2, dpr);
};

// 供滚动性能报告输出当前渲染分辨率/设备 dpr，确认修复是否生效
export const spriteRenderInfo = (): string => {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio
    ? window.devicePixelRatio : 1;
  return `渲染分辨率 ${Math.max(2, dpr)}x (设备 dpr ${dpr})`;
};

// ---------- 图层缓存（同步） ----------
const layerCache = new Map<string, ImageBitmap>();

const layerKey = (layer: 'back' | 'front', category: IconCategory, theme: IconTheme, size: number, res: number) =>
  `${layer}|${category}|${theme}|${Math.round(size)}|${res}`;

const getLayer = (
  layer: 'back' | 'front',
  category: IconCategory,
  theme: IconTheme,
  size: number,
  _dpr: number
): ImageBitmap | null => {
  if (!isSpriteSupported()) return null;
  const res = renderRes();
  const key = layerKey(layer, category, theme, size, res);
  let bmp = layerCache.get(key);
  if (!bmp) {
    bmp = (layer === 'back' ? composeBack : composeFront)(category, theme, size, res);
    layerCache.set(key, bmp);
  }
  return bmp;
};

export const getBack = (
  category: IconCategory, theme: IconTheme, size: number, dpr: number
): ImageBitmap | null => getLayer('back', category, theme, size, dpr);

export const getFront = (
  category: IconCategory, theme: IconTheme, size: number, dpr: number
): ImageBitmap | null => getLayer('front', category, theme, size, dpr);

export const getShell = (
  category: IconCategory, theme: IconTheme, size: number, _dpr: number
): ImageBitmap | null => {
  if (!isSpriteSupported()) return null;
  const res = renderRes();
  const key = `shell|${layerKey('back', category, theme, size, res)}`;
  let bmp = layerCache.get(key);
  if (!bmp) {
    const back = getBack(category, theme, size, res);
    const front = getFront(category, theme, size, res);
    if (!back || !front) return null;
    const off = new OffscreenCanvas(Math.round(size) * res, Math.round(size) * res);
    const ctx = off.getContext('2d')!;
    ctx.drawImage(back, 0, 0, size, size);
    ctx.drawImage(front, 0, 0, size, size);
    bmp = off.transferToImageBitmap();
    layerCache.set(key, bmp);
  }
  return bmp;
};

// 静止完整态主体（灰卡+前板，无角标）缓存：数量少（category×theme×size×res），
// 供组件立即显示，不依赖异步 full 队列；有图后由 full 位图升级覆盖。
export const getStaticBody = (
  category: IconCategory, theme: IconTheme, size: number, _dpr: number
): ImageBitmap | null => {
  if (!isSpriteSupported() || size <= 0) return null;
  const res = renderRes();
  const ss = Math.round(size);
  const key = `static|${category}|${theme}|${ss}|${res}`;
  let bmp: ImageBitmap | null | undefined = layerCache.get(key);
  if (!bmp) {
    bmp = composeStaticBody(category, theme, ss, res);
    if (bmp) layerCache.set(key, bmp);
  }
  return bmp ?? null;
};

// ---------- full 缓存（有界 LRU） ----------
const fullCache = new Map<string, ImageBitmap>();
// 2x 渲染下每张约 (size×2)²×4B（~156 显示 ≈ 390KB），256 张内存 ~100MB → 降为 96 张
const FULL_LIMIT = 96;

export interface FullParams {
  folderId: string;
  previewSrcs: string[];
  count: number | undefined;
  category: IconCategory;
  theme: IconTheme;
  size: number;
  dpr: number;
  signal?: AbortSignal;
}

const fullKey = (p: FullParams, res: number): string =>
  `${p.folderId}|${p.theme}|${Math.round(p.size)}|${res}|${p.count ?? '-'}|${(p.previewSrcs || []).slice(0, 3).join('|')}`;

const cacheFull = (key: string, bmp: ImageBitmap) => {
  if (fullCache.size >= FULL_LIMIT) {
    const oldest = fullCache.keys().next().value;
    if (oldest !== undefined) fullCache.delete(oldest);
  }
  fullCache.set(key, bmp);
};

// ---------- 串行合成调度（心跳泵 + 滚动隔离） ----------
// 核心原则：合成绝不与滚动赛跑。
//  - 滚动中（scrollState != idle）完全不启动新合成，只排队；滚动是最高优先级。
//  - 静止后 setTimeout(0) 链快速排空——每张完成后让出一个 macrotask，浏览器可插帧渲染。
//  - setInterval 心跳兜底：单任务超时（图片 promise 永不 settle）强制执行跳过，
//    链意外断裂时从心跳续泵——队列最终必然清空，绝不冻结。
interface PendingTask extends FullParams {
  key: string;
  resolve: (bmp: ImageBitmap | null) => void;
}

const pendingQueue: PendingTask[] = [];
let current: { task: PendingTask; startedAt: number } | null = null;
let pumpTimer: number | null = null;
const TASK_TIMEOUT_MS = 6000; // 单任务强制超时（> loadImage 的 5s 兜底，给足 Buffer）
const HEARTBEAT_MS = 300;

// 合成统计（供滚动性能报告/调试聚合）
export const spriteStats = {
  composed: 0, // 本次会话新合成的完整位图数
  hit: 0,      // 命中缓存直接返回数
  null: 0,     // 合成失败返回 null 数（图片缺失/超时等，显示占位灰卡）
  cancel: 0,   // 组件在位图就绪前已卸载/重挂载丢弃数
};
export const spriteQueueLen = () => pendingQueue.length;
export const spriteCacheSize = () => fullCache.size;

const isScrollActive = (): boolean => getGlobalScrollState() !== 'idle';

const tryResolve = (task: PendingTask, bmp: ImageBitmap | null) => {
  try { task.resolve(bmp); } catch { /* 组件已卸载 */ }
};

const runTask = async (task: PendingTask): Promise<void> => {
  // 已由其他任务合成完成（同 key 去重）
  const done = fullCache.get(task.key);
  if (done) {
    spriteStats.hit++;
    tryResolve(task, done);
    return;
  }
  if (task.signal?.aborted) {
    tryResolve(task, null);
    return;
  }
  let bmp: ImageBitmap | null = null;
  try {
    bmp = await composeFull(
      task.previewSrcs,
      task.count,
      task.category,
      task.theme,
      task.size,
      renderRes() // 合成分辨率固定 2x+，保证显示锐利
    );
  } catch (e) {
    console.error('[sprite] composeFull threw:', e);
  }
  if (task.signal?.aborted) {
    tryResolve(task, null);
    return;
  }
  if (bmp) {
    spriteStats.composed++;
    cacheFull(task.key, bmp);
  } else {
    spriteStats.null++;
  }
  tryResolve(task, bmp);
};

const pump = () => {
  pumpTimer = null;
  if (current) {
    // 当前任务超时：强制执行跳过（不阻塞后续）
    if (performance.now() - current.startedAt > TASK_TIMEOUT_MS) {
      console.warn(
        '[sprite] task force-skipped (timeout)',
        Math.round(performance.now() - current.startedAt), 'ms'
      );
      const t = current.task;
      current = null;
      spriteStats.null++;
      tryResolve(t, null);
    } else {
      return;
    }
  }
  // 滚动中绝不启动新合成（排队等待静止）
  if (isScrollActive() || pendingQueue.length === 0) return;
  const task = pendingQueue.shift()!;
  current = { task, startedAt: performance.now() };
  runTask(task).finally(() => {
    if (current?.task !== task) return;
    current = null;
    // 静止且队列非空：下一 macrotask 续泵，让浏览器有机会插帧渲染
    if (!isScrollActive() && pendingQueue.length > 0) {
      pumpTimer = window.setTimeout(pump, 0);
    }
  });
};

// 心跳：超时强制跳 + 链断裂兜底（不主动抢滚动帧，仅当无合成进行时尝试）
setInterval(() => {
  if (pendingQueue.length === 0) return;
  if (current) {
    if (performance.now() - current.startedAt > TASK_TIMEOUT_MS) pump();
    return;
  }
  if (pumpTimer !== null) return;
  if (!isScrollActive()) pump();
}, HEARTBEAT_MS);

subscribeScrollState(state => {
  if (state === 'idle' && pendingQueue.length > 0 && !current && pumpTimer === null) pump();
});

/**
 * 获取完整态位图。命中缓存直接返回；未命中入队，由心跳泵在滚动停止后串行合成。
 * 失败（如不可合成/图片缺失）返回 null，调用方保留 staticBody 占位态。
 */
export const getFull = (p: FullParams): Promise<ImageBitmap | null> => {
  if (!isSpriteSupported()) return Promise.resolve(null);
  const res = renderRes();
  const key = fullKey(p, res);
  const cached = fullCache.get(key);
  if (cached) {
    spriteStats.hit++;
    return Promise.resolve(cached);
  }
  if (p.signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    pendingQueue.push({ ...p, key, resolve });
    if (!isScrollActive() && !current && pumpTimer === null) pump();
  });
};

// 调试观察
export const _spriteDebug = {
  pendingCount: spriteQueueLen,
  fullCacheSize: spriteCacheSize,
};

// 挂到 window 供外部（滚动性能报告）读取
if (typeof window !== 'undefined') {
  (window as any).__SPRITE__ = {
    pending: spriteQueueLen,
    cache: spriteCacheSize,
    stats: spriteStats,
  };
}