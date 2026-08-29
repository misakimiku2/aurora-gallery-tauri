// 简洁瓷砖文件夹图标的 Canvas 预合成：
// 将 3 张瓷砖图片 + 底部渐变 + 数量角标合成到一张 PNG（内存 blob URL 缓存），
// 文件网格中每张文件夹卡片从 10+ DOM 节点 / 3 张 <img> 降为 1 张 <img>。
//
// 性能约束（重要）：
// 合成需要解码 3 张缩略图 + canvas 绘制 + PNG 编码，若在滚动期间并发执行会
// 产生 50ms+ 的长任务、卡顿滚动帧。因此所有合成请求统一进入【串行队列】：
//   - 只在全局滚动状态为 idle 时执行（getGlobalScrollState）
//   - 滚动中只排队不执行；滚动停止后延迟 400ms 再排空，避让滚动会话收尾
//   - 每处理一张就让出主线程（宏任务），绝不批量并发
//   - 同一 key 只合成一次，重复请求直接返回缓存

import { getGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge/state';

const TILE_PNG_SIZE = 384; // 合成分辨率：卡片显示尺寸约 120~300px，384 足够清晰
const CACHE_LIMIT = 200;   // 缓存上限，超限整体清空并回收 blob URL（控制内存）
const IDLE_DELAY = 400;    // 滚动停止后延迟多少 ms 才开始合成

const tilesPngCache = new Map<string, string>();

interface PendingTask {
  key: string;
  srcs: string[];
  count: number | undefined;
  category: string;
  signal?: AbortSignal;
  resolve: (url: string | null) => void;
}

const pendingQueue: PendingTask[] = [];
let drainTimer: number | null = null;

const isScrollActive = (): boolean => getGlobalScrollState() !== 'idle';

export const isDarkTheme = (): boolean =>
  typeof document !== 'undefined' && document.documentElement.classList.contains('dark');

// 分类渐变配色（对应经典 3D 文件夹颜色：常规=深色、图书=琥珀黄、视频=紫）
// 与 Folder3DIcon 中 FolderTilesIcon 的 Tailwind 渐变类保持数值一致。
const CATEGORY_GRADIENT: Record<string, { mid: string; bottom: string }> = {
  general: { mid: 'rgba(0,0,0,0.2)', bottom: 'rgba(0,0,0,0.55)' },
  book: { mid: 'rgba(251,191,36,0.30)', bottom: 'rgba(245,158,11,0.70)' },      // amber-400 / amber-500
  sequence: { mid: 'rgba(168,85,247,0.30)', bottom: 'rgba(147,51,234,0.70)' },  // purple-500 / purple-600
};
const getGradient = (category: string) => CATEGORY_GRADIENT[category] || CATEGORY_GRADIENT.general;

const buildKey = (srcs: string[], count: number | undefined, dark: boolean, category: string): string =>
  `${dark ? 'd' : 'l'}|${category}|${count ?? '-'}|${srcs.join('|')}`;

const loadImage = (src: string): Promise<HTMLImageElement | null> =>
  new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });

// 等价 CSS object-cover：填满目标矩形并居中裁剪
const drawCover = (
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
  dx: number, dy: number, dw: number, dh: number
) => {
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  if (!iw || !ih) return;
  const scale = Math.max(dw / iw, dh / ih);
  const sw = dw / scale;
  const sh = dh / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, dx, dy, dw, dh);
};

const roundRectPath = (
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number
) => {
  ctx.beginPath();
  const c = ctx as CanvasRenderingContext2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
  if (typeof c.roundRect === 'function') {
    c.roundRect(x, y, w, h, r);
    return;
  }
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
};

const drawTiles = (
  ctx: CanvasRenderingContext2D,
  imgs: (HTMLImageElement | null)[],
  count: number | undefined,
  S: number,
  category: string
) => {
  const dark = isDarkTheme();
  const r = S * 0.05;
  const gap = Math.max(2, S * 0.01);
  const border = Math.max(1, S / 192);

  // 背板（瓷砖缝隙间露出，对应 DOM 版 bg-gray-100 / bg-gray-800）
  ctx.fillStyle = dark ? '#1f2937' : '#f3f4f6';
  roundRectPath(ctx, 0, 0, S, S, r);
  ctx.fill();

  // 三张瓷砖布局：左侧 62% 大图 + 右侧上下两张（与 FolderTilesIcon 的 flex 布局一致）
  const leftW = S * 0.62;
  const rightW = S - gap - leftW;
  const rightH = (S - gap) / 2;
  const rects = [
    { x: 0, y: 0, w: leftW, h: S },
    { x: leftW + gap, y: 0, w: rightW, h: rightH },
    { x: leftW + gap, y: rightH + gap, w: rightW, h: rightH },
  ];
  // 占位色（对应 FolderTilesIcon 的 placeholderShades）
  // light: gray-300 / gray-400 / gray-300@80% ；dark: gray-600 / gray-500 / gray-600@80%
  const shades = dark
    ? ['#4b5563', '#6b7280', '#4b5563cc']
    : ['#d1d5db', '#9ca3af', '#d1d5dbcc'];

  rects.forEach((rc, i) => {
    ctx.save();
    ctx.beginPath();
    ctx.rect(rc.x, rc.y, rc.w, rc.h);
    ctx.clip();
    if (imgs[i]) {
      drawCover(ctx, imgs[i]!, rc.x, rc.y, rc.w, rc.h);
    } else {
      // 缺图占位（对应 DOM 版灰阶占位）
      ctx.fillStyle = shades[i];
      ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
    }
    ctx.restore();
  });

  // 底部渐变（对应 DOM 版 bg-gradient-to-t，颜色随分类：常规=深色、图书=黄、视频=紫）
  const { mid, bottom } = getGradient(category);
  const gh = S * 0.45;
  const grad = ctx.createLinearGradient(0, S - gh, 0, S);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.55, mid);
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, S - gh, S, gh);

  // 数量角标
  if (count !== undefined && count > 0) {
    const fs = S * 0.055;
    ctx.font = `700 ${fs}px system-ui, sans-serif`;
    const text = String(count);
    const tw = ctx.measureText(text).width;
    const padX = fs * 0.55;
    const bh = fs * 1.6;
    const bw = tw + padX * 2;
    const bx = S - bw - S * 0.03;
    const by = S - bh - S * 0.022;
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    roundRectPath(ctx, bx, by, bw, bh, bh / 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)';
    ctx.lineWidth = Math.max(1, S / 384);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.95)';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, bx + padX, by + bh / 2 + fs * 0.05);
  }

  // 外描边（对应 border-gray-200 / dark:border-gray-700）
  ctx.strokeStyle = dark ? '#374151' : '#e5e7eb';
  ctx.lineWidth = border;
  roundRectPath(ctx, border / 2, border / 2, S - border, S - border, Math.max(0, r - border / 2));
  ctx.stroke();
};

const processOne = async (task: PendingTask): Promise<void> => {
  try {
    if (task.signal?.aborted) {
      task.resolve(null);
      return;
    }
    const imgs = await Promise.all(task.srcs.map(loadImage));
    if (task.signal?.aborted) {
      task.resolve(null);
      return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = TILE_PNG_SIZE;
    canvas.height = TILE_PNG_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      task.resolve(null);
      return;
    }
    drawTiles(ctx, imgs, task.count, TILE_PNG_SIZE, task.category);
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) {
      task.resolve(null);
      return;
    }
    const url = URL.createObjectURL(blob);
    if (tilesPngCache.size >= CACHE_LIMIT) {
      tilesPngCache.forEach(u => URL.revokeObjectURL(u));
      tilesPngCache.clear();
    }
    tilesPngCache.set(task.key, url);
    task.resolve(url);
  } catch {
    // 远程跨域图片会污染 canvas 导致 toBlob 抛错：静默回退 DOM 版
    task.resolve(null);
  }
};

// 排空队列：滚动中暂停；每处理一张就让出主线程，下一张放宏任务
const drain = () => {
  if (pendingQueue.length === 0) return;
  if (isScrollActive()) return; // 滚动中暂停，等 idle 后再触发

  const task = pendingQueue.shift()!;
  processOne(task).then(() => {
    drainTimer = window.setTimeout(drain, 0); // 让出主线程，给渲染帧让路
  });
};

const scheduleDrain = (delay = 0) => {
  if (drainTimer !== null) return;
  drainTimer = window.setTimeout(() => {
    drainTimer = null;
    drain();
  }, delay);
};

// 滚动结束后（idle）延迟片刻再排空，避开滚动会话收尾的渲染/重渲染工作
subscribeScrollState(state => {
  if (state === 'idle') scheduleDrain(IDLE_DELAY);
});

/**
 * 获取瓷砖图标的预合成 PNG（blob URL）。
 * 请求会进入全局串行队列，滚动期间不执行；同一 key 只合成一次。
 * 失败（如跨域图污染 canvas）返回 null，调用方回退为 DOM 版渲染。
 * 可通过 signal 在挂载前取消（组件卸载时）。
 */
export const getFolderTilesPng = (
  srcs: string[],
  count?: number,
  signal?: AbortSignal,
  category: string = 'general'
): Promise<string | null> => {
  const dark = isDarkTheme();
  const key = buildKey(srcs.slice(0, 3), count, dark, category);
  const cached = tilesPngCache.get(key);
  if (cached) return Promise.resolve(cached);
  if (signal?.aborted) return Promise.resolve(null);

  return new Promise(resolve => {
    pendingQueue.push({ key, srcs: srcs.slice(0, 3), count, category, signal, resolve });
    scheduleDrain();
  });
};
