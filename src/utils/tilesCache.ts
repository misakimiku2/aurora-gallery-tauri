// 简洁瓷砖文件夹图标（FolderTilesIconCanvas）的位图缓存与串行合成调度。
//
// 与 spriteCache（经典 3D 文件夹）同构但独立、更精简：
//   - static 层：三槽全灰块的静止兜底位图，按 (category, theme, size, res) 全局共享，同步合成；
//   - full 层：含真缩略图的完整位图，按 folderId 有界 LRU，异步合成；
//   - 合成调度：串行队列 + macrotask 让出 + 滚动隔离 + 心跳超时强制跳过 + Abort 取消。
// 角标不进位图缓存：由组件在绘制后即时补画（drawTilesBadge），避免按 count 缓存爆炸。

import { isSpriteSupported } from './spriteComposer';
import {
  composeTilesFull,
  composeTilesStatic,
  type IconCategory,
  type IconTheme,
} from './tilesComposer';
import { spriteWorkerClient } from './spriteWorkerClient';
import { getGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge/state';

// 渲染分辨率：合成位图统一 ≥2x 像素密度（与 spriteCache.renderRes 同策略），GPU 缩小显示保证锐利
const renderRes = (): number => {
  const dpr = typeof window !== 'undefined' && window.devicePixelRatio
    ? window.devicePixelRatio : 1;
  return Math.max(2, dpr);
};

// ---------- static 层缓存（同步） ----------
const staticCache = new Map<string, ImageBitmap>();

const staticKey = (category: IconCategory, theme: IconTheme, size: number, res: number) =>
  `tstatic|${category}|${theme}|${Math.round(size)}|${res}`;

/** 灰块静止兜底位图（滚动/换档后即时显示，不依赖异步队列）；无图时即最终态 */
export const getTilesStatic = (
  category: IconCategory,
  theme: IconTheme,
  size: number,
  _dpr: number
): ImageBitmap | null => {
  if (!isSpriteSupported() || size <= 0) return null;
  const res = renderRes();
  const ss = Math.round(size);
  const key = staticKey(category, theme, ss, res);
  let bmp: ImageBitmap | null | undefined = staticCache.get(key);
  if (!bmp) {
    bmp = composeTilesStatic(category, theme, ss, res);
    if (bmp) staticCache.set(key, bmp);
  }
  return bmp ?? null;
};

// ---------- full 缓存（有界 LRU） ----------
const fullCache = new Map<string, ImageBitmap>();
const FULL_LIMIT = 96;

export interface TilesFullParams {
  folderId: string;
  srcs: string[];
  category: IconCategory;
  theme: IconTheme;
  size: number;
  signal?: AbortSignal;
}

const fullKey = (p: TilesFullParams, res: number): string =>
  `${p.folderId}|${p.theme}|${Math.round(p.size)}|${res}|${(p.srcs || []).slice(0, 3).join('|')}`;

const cacheFull = (key: string, bmp: ImageBitmap) => {
  if (fullCache.size >= FULL_LIMIT) {
    const oldest = fullCache.keys().next().value;
    if (oldest !== undefined) fullCache.delete(oldest);
  }
  fullCache.set(key, bmp);
};

// ---------- 串行合成调度（心跳泵 + 滚动隔离，复制 spriteCache 的可靠结构） ----------
interface PendingTask extends TilesFullParams {
  key: string;
  resolvers: ((bmp: ImageBitmap | null) => void)[];
}

// 队列只在 idle（滚动停止）时被使用与排空；快速滚动不再入队（组件侧滚动门控），
// 因此静态时队列规模 ≈ 视口内可见卡数，512 足够容纳虚拟化缓冲，避免挤兑丢任务
const MAX_PENDING = 512;
const pendingQueue: PendingTask[] = [];
let current: { task: PendingTask; startedAt: number } | null = null;
let pumpTimer: number | null = null;
const TASK_TIMEOUT_MS = 6000;
const HEARTBEAT_MS = 300;

// 合成统计（供性能报告/调试）
export const tilesStats = {
  composed: 0,
  hit: 0,
  null: 0,
  cancel: 0,
};
export const tilesQueueLen = () => pendingQueue.length;
export const tilesCacheSize = () => fullCache.size;

const tryResolve = (resolve: (bmp: ImageBitmap | null) => void, bmp: ImageBitmap | null) => {
  try { resolve(bmp); } catch { /* 组件已卸载 */ }
};

const resolveTask = (task: PendingTask, bmp: ImageBitmap | null) => {
  for (const r of task.resolvers) tryResolve(r, bmp);
};

// ---------- Worker 合成接入 ----------
// full 合成优先交给 sprite-worker（tiles 消息走 kind='tiles'）：预览图 fetch+createImageBitmap
// 解码 + OffscreenCanvas 绘制全部离主线程。主线程只保留排队/门控与结果落缓存/贴图。
// worker 不可用（不支持/asset:// 等资源协议无法 fetch）时回退主线程内联合成。
let tilesWorkerUsable: boolean | null = null;
let tilesProbeDone = false;

const ensureWorkerReady = async (): Promise<boolean> => {
  if (tilesWorkerUsable === null) {
    tilesWorkerUsable = await spriteWorkerClient.init();
    if (tilesWorkerUsable) console.log('[tiles] Web Worker 合成已启用（简洁版 full 合成离主线程）');
  }
  return tilesWorkerUsable;
};

/** worker 合成是否已确认可用（未确认/已回退主线程均为 false）——供组件决定滚动中是否发起请求 */
export const getTilesWorkerUsable = (): boolean => tilesWorkerUsable === true;

/** 预热：尽早 spawn worker，使首次滚动即可用（幂等，init 内部去重） */
export const warmTilesWorker = (): void => {
  void ensureWorkerReady();
};

// 主线程内联合成（回退路径 / worker 探针对拍）
const composeInline = (task: PendingTask, res: number): Promise<ImageBitmap | null> =>
  composeTilesFull(
    (task.srcs || []).filter(s => !!s).slice(0, 3),
    task.category,
    task.theme,
    Math.round(task.size),
    res,
    () => task.signal?.aborted ?? false,
  );

const runTask = async (task: PendingTask): Promise<void> => {
  const done = fullCache.get(task.key);
  if (done) {
    tilesStats.hit++;
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
    const srcs = (task.srcs || []).filter(s => !!s).slice(0, 3);
    const useWorker = await ensureWorkerReady();
    if (useWorker && !tilesProbeDone && srcs.length > 0) {
      // 能力探针（仅一次）：worker 与主线程并行各合成一次，取成功者。
      // worker 失败而主线程成功 → 该资源协议（如 asset://）worker 不支持 → 永久回退主线程
      tilesProbeDone = true;
      const [w, i] = await Promise.all([
        spriteWorkerClient.requestFull({
          previewSrcs: srcs,
          count: undefined,
          category: task.category,
          theme: task.theme,
          size: Math.round(task.size),
          dpr: res,
        }, 'tiles').catch(() => null),
        composeInline(task, res).catch(() => null),
      ]);
      bmp = w ?? i;
      if (!w && i) {
        console.warn('[tiles] Worker 无法解码当前资源协议，已回退主线程合成');
        spriteWorkerClient.disable();
        tilesWorkerUsable = false;
      }
    } else if (useWorker) {
      bmp = await spriteWorkerClient.requestFull({
        previewSrcs: srcs,
        count: undefined,
        category: task.category,
        theme: task.theme,
        size: Math.round(task.size),
        dpr: res,
      }, 'tiles').catch(() => null);
      // worker 解码失败但主线程能成 → 回退主线程并永久禁用 worker
      if (!bmp && srcs.length > 0) {
        const inline = await composeInline(task, res).catch(() => null);
        if (inline) {
          console.warn('[tiles] Worker 无法解码当前资源协议，已回退主线程合成');
          spriteWorkerClient.disable();
          tilesWorkerUsable = false;
          bmp = inline;
        }
      }
    } else {
      bmp = await composeInline(task, res);
    }
  } catch (e) {
    console.error('[tiles] composeTilesFull threw:', e);
  }
  if (task.signal?.aborted) {
    resolveTask(task, null);
    return;
  }
  if (bmp) {
    tilesStats.composed++;
    cacheFull(task.key, bmp);
  } else {
    tilesStats.null++;
  }
  resolveTask(task, bmp);
};

const pump = () => {
  pumpTimer = null;
  // 滚动隔离是「按合成执行位置」动态的：
  //  - worker 合成可用（tilesWorkerUsable===true）→ 滚动中也可启动（解码/绘制都在 worker，
  //    不占主线程），保证滚动中卡片即时升级真缩略图（需求：滚动时就显示缩略图）；
  //  - worker 未确认/不可用 → 合成回退主线程，滚动中绝不同步启动（避免与滚动帧赛跑，
  //    实测掉帧 46% 的来源），滚动停止后由 subscribeScrollState(idle) 续泵排空。
  if (getGlobalScrollState() !== 'idle' && tilesWorkerUsable !== true) return;
  if (current) {
    if (performance.now() - current.startedAt > TASK_TIMEOUT_MS) {
      const t = current.task;
      current = null;
      tilesStats.null++;
      resolveTask(t, null);
    } else {
      return;
    }
  }
  if (pendingQueue.length === 0) return;
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
    if (pendingQueue.length > 0) {
      pumpTimer = window.setTimeout(pump, 0);
    }
  });
};

// 心跳：超时强制跳 + 链断裂兜底。
// 滚动中是否启动新任务由 pump 顶部的动态门控决定（worker 可用则允许）。
setInterval(() => {
  if (pendingQueue.length === 0) return;
  if (current) {
    if (performance.now() - current.startedAt > TASK_TIMEOUT_MS) {
      // 超时强制跳过：需绕过滚动隔离门控（清 current + resolve null），直接内联处理
      const t = current.task;
      current = null;
      tilesStats.null++;
      resolveTask(t, null);
    }
    return;
  }
  if (pumpTimer !== null) return;
  pump();
}, HEARTBEAT_MS);

// 滚动隔离：滚动中不启动新合成（只排队），idle 后立即续泵
subscribeScrollState(state => {
  if (state !== 'idle') {
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
 * 获取完整态位图（含真缩略图）。命中缓存直接返回；未命中入队，由心跳泵串行合成。
 * 解码失败返回 null（组件保留灰块 static 态并退避重试）。
 */
export const getTilesFull = (p: TilesFullParams): Promise<ImageBitmap | null> => {
  if (!isSpriteSupported()) return Promise.resolve(null);
  const res = renderRes();
  const key = fullKey(p, res);
  const cached = fullCache.get(key);
  if (cached) {
    tilesStats.hit++;
    return Promise.resolve(cached);
  }
  if (p.signal?.aborted) return Promise.resolve(null);

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
  while (pendingQueue.length >= MAX_PENDING) {
    const dropped = pendingQueue.shift()!;
    resolveTask(dropped, null);
  }
  return new Promise(resolve => {
    pendingQueue.push({ ...p, key, resolvers: [resolve] });
    if (!current && pumpTimer === null) pump();
  });
};

// 挂到 window 供外部（滚动性能报告）读取
if (typeof window !== 'undefined') {
  (window as any).__TILES_SPRITE__ = {
    pending: tilesQueueLen,
    cache: tilesCacheSize,
    stats: tilesStats,
  };
}
