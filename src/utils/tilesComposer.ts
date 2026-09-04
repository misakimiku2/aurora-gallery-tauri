// 简洁瓷砖文件夹图标（Folder3DIcon variant='tiles'）的 Canvas 预合成引擎。
//
// 目标与经典版（spriteComposer）一致：把「圆角外框 + 左大右二 2×2 瓷砖 + 底部分类渐变 +
// 数量角标」预先绘制成单张位图，运行时只贴一张 → 滚动成本与图片卡同级，绕开
// folderTilesRenderer 用 canvas.toBlob 读回像素被 asset:// 污染的致命缺陷。
//
// DOM 参考实现：Folder3DIcon.tsx 的 FolderTilesIcon（三态：PNG 就绪 / DOM 拼贴 / 灰块占位）。
// 本引擎复刻的是 DOM 拼贴态：
//   - 外框：rounded-lg(8px) + border 1px + 容器底色（light #f3f4f6 / dark #1f2937），
//     hover 时外框/渐变/角标不动，仅三张瓷砖各自 scale(1.05)（300ms ease），被各自槽位裁剪；
//   - 三槽：左 62% 大图 + 右上/右下各半（gap-0.5=2px），图 object-cover，缺图用灰阶占位色；
//   - 底部渐变：h-[45%] bg-gradient-to-t，颜色随分类（general/book/sequence），与
//     FolderTilesIcon 的 Tailwind 渐变类及 folderTilesRenderer 的 CATEGORY_GRADIENT 数值一致；
//   - 数量角标：bottom-1.5 right-2，仅 count>0 显示。
//
// 关键约束（与 spriteComposer 相同）：导出一律走 OffscreenCanvas.transferToImageBitmap，
// 绝不调用 toDataURL/toBlob/getImageData —— asset:// 图会污染画布，读回抛 SecurityError。

import {
  applySmoothing,
  drawCover,
  isSpriteSupported,
  loadImages,
  roundRectPath,
  type Ctx2D,
  type IconCategory,
  type IconTheme,
} from './spriteComposer';

export { easeCss, loadImages } from './spriteComposer';
export type { IconCategory, IconTheme } from './spriteComposer';

// ---------- 视觉常量（对应 FolderTilesIcon 的 DOM，固定 px + 百分比） ----------
// rounded-lg 外框圆角（极小尺寸保护上限 r = S/4）
const OUTER_RADIUS = 8;
// gap-0.5（左右/上下缝隙）
const SLOT_GAP = 2;
// border 1px
const BORDER_W = 1;
// 容器底色 bg-gray-100 / dark:bg-gray-800
const BG = { light: '#f3f4f6', dark: '#1f2937' } as const;
// 外框描边 border-gray-200 / dark:border-gray-700
const BORDER_COLOR = { light: '#e5e7eb', dark: '#374151' } as const;
// 缺图灰块占位（按下标：0 左大 / 1 右上 / 2 右下），对应 DOM placeholderShades：
// light gray-300 / gray-400 / gray-300@80%；dark gray-600 / gray-500 / gray-600@80%
const SHADES = {
  light: ['#d1d5db', '#9ca3af', '#d1d5dbcc'],
  dark: ['#4b5563', '#6b7280', '#4b5563cc'],
} as const;
// 底部分类渐变（DOM from/via：general 黑、book 琥珀、sequence 紫）：
// mid=via 中段、bottom=from 底部最强色；顶部透明（to-transparent）
const GRADIENT: Record<IconCategory, { mid: string; bottom: string }> = {
  general: { mid: 'rgba(0,0,0,0.2)', bottom: 'rgba(0,0,0,0.55)' },
  book: { mid: 'rgba(251,191,36,0.30)', bottom: 'rgba(245,158,11,0.70)' },
  sequence: { mid: 'rgba(168,85,247,0.30)', bottom: 'rgba(147,51,234,0.70)' },
};
// 渐变覆盖高度 h-[45%]
const GRADIENT_H = 0.45;

// 三张瓷砖的源（null/undefined = 灰块占位）
export type TilesImage = HTMLImageElement | ImageBitmap | null | undefined;

// 清整块画布（含外围留白，若有）：悬停逐帧时避免旧帧残影
const clearWhole = (ctx: Ctx2D) => {
  const cvs = ctx.canvas as { width: number; height: number };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  ctx.restore();
};

/**
 * 画 tiles 图标主体（背景 + 三槽 + 渐变 + 外框描边），不画角标。
 * 坐标空间 = CSS 逻辑像素 0..S（调用方需已把 ctx 缩放到渲染分辨率）。
 * scaleP：瓷砖放大系数（hover 动画 1→1.05，绕槽位中心放大并裁剪，与 DOM scale(1.05) 一致）。
 * 静止合成传 scaleP=1。
 */
export const paintTilesBase = (
  ctx: Ctx2D,
  S: number,
  theme: IconTheme,
  category: IconCategory,
  imgs: (TilesImage | undefined)[],
  scaleP = 1,
) => {
  if (S <= 0) return;
  const dark = theme === 'dark';
  const r = Math.min(OUTER_RADIUS, S * 0.25);

  ctx.save();
  // 外框圆角裁剪（等价 DOM 外层 rounded-lg overflow-hidden）
  roundRectPath(ctx, 0, 0, S, S, r);
  ctx.clip();

  // 容器底色
  ctx.fillStyle = dark ? BG.dark : BG.light;
  ctx.fillRect(0, 0, S, S);

  // 三槽布局：左 62% 大图 + 右侧上下两半，gap-0.5
  const gap = SLOT_GAP;
  const leftW = S * 0.62;
  const rightW = S - gap - leftW;
  const rightH = (S - gap) / 2;
  const rects = [
    { x: 0, y: 0, w: leftW, h: S },
    { x: leftW + gap, y: 0, w: rightW, h: rightH },
    { x: leftW + gap, y: rightH + gap, w: rightW, h: rightH },
  ];
  const shades = dark ? SHADES.dark : SHADES.light;

  for (let i = 0; i < 3; i++) {
    const rc = rects[i];
    const img = imgs[i];
    ctx.save();
    ctx.beginPath();
    ctx.rect(rc.x, rc.y, rc.w, rc.h);
    ctx.clip();
    if (img) {
      // DOM hover 语义：已填满槽位的 object-cover 图绕槽位中心 scale(scaleP)，
      // 放大后超出槽位的部分被 overflow-hidden 裁掉
      const dw = rc.w * scaleP;
      const dh = rc.h * scaleP;
      drawCover(ctx, img, rc.x - (dw - rc.w) / 2, rc.y - (dh - rc.h) / 2, dw, dh);
    } else {
      // 灰块占位为纯色，scale 前后视觉不变，直接铺满即可
      ctx.fillStyle = shades[i];
      ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
    }
    ctx.restore();
  }

  // 底部渐变（to top：顶透明 → 中段 via → 底部 from，盖在瓷砖之上，hover 不动）
  const { mid, bottom } = GRADIENT[category] || GRADIENT.general;
  const gh = S * GRADIENT_H;
  const grad = ctx.createLinearGradient(0, S - gh, 0, S);
  grad.addColorStop(0, 'rgba(0,0,0,0)');
  grad.addColorStop(0.5, mid);
  grad.addColorStop(1, bottom);
  ctx.fillStyle = grad;
  ctx.fillRect(0, S - gh, S, gh);

  ctx.restore(); // 出圆角裁剪

  // 外框描边（最上层，盖住圆角边缘的内容）
  ctx.strokeStyle = dark ? BORDER_COLOR.dark : BORDER_COLOR.light;
  ctx.lineWidth = BORDER_W;
  roundRectPath(ctx, BORDER_W / 2, BORDER_W / 2, S - BORDER_W, S - BORDER_W, Math.max(0, r - BORDER_W / 2));
  ctx.stroke();
};

/**
 * tiles 数量角标（DOM：bottom-1.5 right-2、bg-black/40、rounded-full、ring-1 ring-white/20，
 * text 9px bold white、px-1.5 py-0.5）。仅 count>0 绘制（与 DOM FolderTilesIcon 一致）。
 * 由调用方在静止位图 / 悬停帧上即时补画，不进入位图缓存。
 */
export const drawTilesBadge = (ctx: Ctx2D, S: number, count: number) => {
  if (S <= 0 || count <= 0) return;
  const fs = 9;
  ctx.save();
  ctx.font = `700 ${fs}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  const text = String(count);
  const tw = ctx.measureText(text).width;
  const padX = 6;
  const bh = fs * 1.2 + 4; // ≈ DOM py-0.5(2px×2) + 9px 行高
  const bw = tw + padX * 2;
  const bx = S - 8 - bw; // right-2
  const by = S - 6 - bh; // bottom-1.5
  ctx.fillStyle = 'rgba(0,0,0,0.4)';
  roundRectPath(ctx, bx, by, bw, bh, bh / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1;
  roundRectPath(ctx, bx, by, bw, bh, bh / 2);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(text, bx + padX, by + bh / 2 + fs * 0.05);
  ctx.restore();
};

/** 灰块静止主体合成（同步，无异步依赖）：三槽全灰块，供滚动/换档后立即显示 */
export const composeTilesStatic = (
  category: IconCategory,
  theme: IconTheme,
  size: number,
  dpr = 1,
): ImageBitmap | null => {
  if (size <= 0) return null;
  try {
    const off = new OffscreenCanvas(Math.round(size * dpr), Math.round(size * dpr));
    const ctx = off.getContext('2d')!;
    applySmoothing(ctx);
    ctx.scale(dpr, dpr);
    paintTilesBase(ctx, size, theme, category, [null, null, null]);
    return off.transferToImageBitmap();
  } catch (e) {
    console.error('[tiles] composeStatic failed:', e);
    return null;
  }
};

/**
 * 完整态合成（异步）：解码三张预览图后绘制（缺槽灰块）。
 * 任一已声明图源解码失败则返回 null（不落缓存，由组件退避重试），
 * 与 spriteCache.composeFull 的策略一致，避免把"半灰卡"当最终态缓存。
 */
export const composeTilesFull = async (
  srcs: string[],
  category: IconCategory,
  theme: IconTheme,
  size: number,
  dpr = 1,
  shouldCancel?: () => boolean,
  // decode 可注入：主线程默认 new Image()（loadImages），Web Worker 用 fetch+createImageBitmap
  decode?: (srcs: string[]) => Promise<(HTMLImageElement | ImageBitmap | null)[]>,
): Promise<ImageBitmap | null> => {
  try {
    if (shouldCancel?.()) return null;
    const off = new OffscreenCanvas(Math.round(size * dpr), Math.round(size * dpr));
    const ctx = off.getContext('2d')!;
    applySmoothing(ctx);
    ctx.scale(dpr, dpr);
    const list = await (decode || loadImages)(srcs);
    if (shouldCancel?.()) return null;
    if (list.some(v => !v)) return null;
    const imgs: TilesImage[] = [list[0], list[1], list[2]];
    paintTilesBase(ctx, size, theme, category, imgs);
    return off.transferToImageBitmap();
  } catch (e) {
    console.error('[tiles] composeFull failed:', e);
    return null;
  }
};

/**
 * 逐帧绘制（悬停动画用）：清屏后重画全部图层（含角标）。
 * 坐标空间 = CSS 逻辑像素 0..S，调用方需已把 ctx 缩放到渲染分辨率。
 * scaleP 为瓷砖放大系数（1→1.05，由 easeCss(t/300) 插值得到）。
 */
export const drawTilesFrame = (
  ctx: Ctx2D,
  S: number,
  theme: IconTheme,
  category: IconCategory,
  imgs: (TilesImage | undefined)[],
  count: number | undefined,
  scaleP = 1,
) => {
  clearWhole(ctx);
  applySmoothing(ctx);
  paintTilesBase(ctx, S, theme, category, imgs, scaleP);
  if (count !== undefined && count > 0) drawTilesBadge(ctx, S, count);
};

/** 能力检测（与 spriteComposer 共用） */
export const isTilesSpriteSupported = (): boolean => isSpriteSupported();
