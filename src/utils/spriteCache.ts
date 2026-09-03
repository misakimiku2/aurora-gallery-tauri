// 经典 3D 文件夹 Sprite 缓存与调度（对应 Folder3DIconCanvas）。
//
//  - 图层缓存：back（后板）/ front（前板+图标）按 (category, theme, size, dpr) 全局缓存，
//    同步合成，滚动瞬间兜底用；shell 由 back+front 组合同步合成（单层贴图最省）。
//  - full 缓存：每文件夹一张完整位图（后板+堆叠预览卡+前板+角标），有界 LRU。
//  - 合成调度：串行队列 + macrotask 让出——滚动中也持续合成（缩略图滚动时即开始加载），
//    每张让出主线程、同 key 只合成一次、可 Abort 取消；单任务超时强制跳过 + 心跳兜底，
//    保证队列任何情况下最终排空。

import { composeStaticBody, composeBack, composeFront, composeFull, isSpriteSupported, type IconCategory, type IconTheme } from './spriteComposer';
import { spriteWorkerClient } from './spriteWorkerClient';
import { subscribeScrollState } from '../api/tauri-bridge/state';

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
  // 同 key 去重：多个请求（同文件夹多次挂载/多组件）合并到同一任务，各自收到结果
  resolvers: ((bmp: ImageBitmap | null) => void)[];
}

const MAX_PENDING = 192; // 队列上限：超出丢最旧（组件会在容纳后重试，不会永久卡在占位态）

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

// ---------- Worker 合成接入 ----------
// full 合成优先交给 Web Worker（预览图解码 + OffscreenCanvas 绘制全部离主线程），
// 主线程只保留排队/门控与结果落缓存。worker 不可用（不支持/资源无法解码）时回退主线程。
let workerReady: boolean | null = null;
let workerProbeDone = false;

const ensureWorkerReady = async (): Promise<boolean> => {
  if (workerReady === null) {
    workerReady = await spriteWorkerClient.init();
    if (workerReady) console.log('[sprite] Web Worker 合成已启用（full 合成离主线程）');
  }
  return workerReady;
};

// 主线程内联合成（回退路径）：复用 layerCache + 滚动中断检查
const composeInline = (
  task: PendingTask,
  res: number
): Promise<ImageBitmap | null> => {
  const back = getBack(task.category, task.theme, task.size, res);
  const front = getFront(task.category, task.theme, task.size, res);
  return composeFull(
    task.previewSrcs,
    task.count,
    task.category,
    task.theme,
    task.size,
    res,
    back && front ? { back, front } : undefined,
    undefined // 滚动中不取消：允许滚动同时继续加载缩略图（队列串行 + macrotask 让出，避免抢占滚动帧）
  );
};

const tryResolve = (resolve: (bmp: ImageBitmap | null) => void, bmp: ImageBitmap | null) => {
  try { resolve(bmp); } catch { /* 组件已卸载 */ }
};

const resolveTask = (task: PendingTask, bmp: ImageBitmap | null) => {
  for (const r of task.resolvers) tryResolve(r, bmp);
};

const runTask = async (task: PendingTask): Promise<void> => {
  // 已由其他任务合成完成（同 key 去重）
  const done = fullCache.get(task.key);
  if (done) {
    spriteStats.hit++;
    resolveTask(task, done);
    return;
  }
  if (task.signal?.aborted) {
    resolveTask(task, null);
    return;
  }
  let bmp: ImageBitmap | null = null;
  try {
    const res = renderRes();
    const useWorker = await ensureWorkerReady();
    const srcs = (task.previewSrcs || []).filter(s => !!s).slice(0, 3);
    if (useWorker && !workerProbeDone && srcs.length > 0) {
      // 能力探针（仅一次）：worker 与主线程并行各合成一次，取成功者。
      // 若 worker 合成失败而主线程成功 → 该资源协议（如 asset://）worker 不支持 → 永久回退主线程。
      workerProbeDone = true;
      const [w, i] = await Promise.all([
        spriteWorkerClient.requestFull({
          previewSrcs: srcs,
          count: task.count,
          category: task.category,
          theme: task.theme,
          size: task.size,
          dpr: res,
        }).catch(() => null),
        composeInline(task, res).catch(() => null),
      ]);
      bmp = w ?? i;
      if (!w && i) {
        // worker 解码不了该资源协议（如 asset:// 不支持 fetch）→ 永久回退主线程
        console.warn('[sprite] Worker 无法解码当前资源协议，已回退主线程合成');
        spriteWorkerClient.disable();
        workerReady = false;
      }
    } else if (useWorker) {
      bmp = await spriteWorkerClient.requestFull({
        previewSrcs: srcs,
        count: task.count,
        category: task.category,
        theme: task.theme,
        size: task.size,
        dpr: res,
      }).catch(() => null);
      // Worker 解码失败（如 asset:// 自定义协议不被 worker fetch 支持）但主线程能成：
      // 回退主线程内联合成，并永久禁用 worker（避免后续每次都走失败路径）。
      // 若主线程也失败（缩略图尚未就绪/冷却中）则保持 worker，等待组件退避重试。
      if (!bmp && srcs.length > 0) {
        const inline = await composeInline(task, res).catch(() => null);
        if (inline) {
          console.warn('[sprite] Worker 无法解码当前资源协议，已回退主线程合成');
          spriteWorkerClient.disable();
          workerReady = false;
          bmp = inline;
        }
      }
    } else {
      bmp = await composeInline(task, res);
    }
  } catch (e) {
    console.error('[sprite] composeFull threw:', e);
  }
  if (task.signal?.aborted) {
    resolveTask(task, null);
    return;
  }
  if (bmp) {
    spriteStats.composed++;
    cacheFull(task.key, bmp);
  } else {
    spriteStats.null++;
  }
  resolveTask(task, bmp);
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
      resolveTask(t, null);
    } else {
      return;
    }
  }
  // 队列非空即启动（滚动中也继续合成，缩略图滚动时就开始加载；
  // 串行 + 每张让出一个 macrotask，保证不连续占用主线程、不抢占滚动帧）
  if (pendingQueue.length === 0) return;
  // 剔除已取消（组件卸载）的任务，避免空转
  let task: PendingTask | null = null;
  while (pendingQueue.length > 0) {
    const t = pendingQueue.shift()!;
    if (t.signal?.aborted) {
      resolveTask(t, null);
      continue;
    }
    task = t;
    break;
  }
  if (!task) return;
  current = { task, startedAt: performance.now() };
  runTask(task).finally(() => {
    if (current?.task !== task) return;
    current = null;
    // 队列非空：下一 macrotask 续泵，让浏览器有机会插帧渲染
    if (pendingQueue.length > 0) {
      pumpTimer = window.setTimeout(pump, 0);
    }
  });
};

// 心跳：超时强制跳 + 链断裂兜底（仅当无合成进行时尝试；滚动中也继续泵，支持滚动时加载）
setInterval(() => {
  if (pendingQueue.length === 0) return;
  if (current) {
    if (performance.now() - current.startedAt > TASK_TIMEOUT_MS) pump();
    return;
  }
  if (pumpTimer !== null) return;
  pump();
}, HEARTBEAT_MS);

subscribeScrollState(state => {
  if (state !== 'idle') {
    // 滚动开始：清掉排队中已失效（组件已卸载）的任务，减轻滚动停止后的排空压力
    if (pendingQueue.length > 0) {
      const remain: PendingTask[] = [];
      for (const t of pendingQueue) {
        if (t.signal?.aborted) resolveTask(t, null);
        else remain.push(t);
      }
      pendingQueue.length = 0;
      pendingQueue.push(...remain);
    }
    return;
  }
  if (pendingQueue.length > 0 && !current && pumpTimer === null) pump();
});

/**
 * 获取完整态位图。命中缓存直接返回；未命中入队，由心跳泵在滚动停止后串行合成。
 * 同 key 已有排队任务时合并 resolver（只合成一次）；队列超上限丢最旧。
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
  // 同 key 已在队列中：合并 resolver，避免重复合成；
  // 但若旧任务已被取消（组件早于回队前卸载、Abort 未触发清理），合并会吞掉新请求
  // → 移除旧任务、以新请求重新入队
  const existingIdx = pendingQueue.findIndex(t => t.key === key);
  if (existingIdx !== -1) {
    const existing = pendingQueue[existingIdx];
    if (existing.signal?.aborted) {
      pendingQueue.splice(existingIdx, 1);
      for (const r of existing.resolvers) tryResolve(r, null);
      while (pendingQueue.length >= MAX_PENDING) {
        const dropped = pendingQueue.shift()!;
        resolveTask(dropped, null);
      }
      const fresh: PendingTask = { ...p, key, resolvers: [] };
      pendingQueue.push(fresh);
      return new Promise(resolve => {
        fresh.resolvers.push(resolve);
        if (!current && pumpTimer === null) pump();
      });
    }
    return new Promise(resolve => existing.resolvers.push(resolve));
  }
  // 队列上限：驱逐最旧的未开始任务（保持 pending 有界，防洪峰；被丢的卡片由组件重试）
  while (pendingQueue.length >= MAX_PENDING) {
    const dropped = pendingQueue.shift()!;
    resolveTask(dropped, null);
  }
  return new Promise(resolve => {
    pendingQueue.push({ ...p, key, resolvers: [resolve] });
    if (!current && pumpTimer === null) pump();
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