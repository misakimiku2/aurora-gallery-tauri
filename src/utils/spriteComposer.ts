// 经典 3D 文件夹图标的 Canvas 预合成引擎（对应 Folder3DIcon variant='classic' 的 DOM 渲染）。
//
// 目标：把「后板 + 3D 透视前板 + 图标 + 角标 + 三张堆叠预览卡」预先绘制成单张位图，
//       运行时只贴一张图 → 每个文件夹卡片 1 个合成层，滚动成本与图片卡同级。
// 悬停：用 drawHoverFrame 逐帧复刻 DOM 的 CSS transition（300ms ease + 扇形摊开 + 容器位移放大），
//       与静止位图共用同一 drawCard / drawBadge 实现，保证静止↔动画结构上无缝衔接。
//
// 关键约束（与 folderTilesRenderer 不同）：
//   - 导出一律走 OffscreenCanvas.transferToImageBitmap（不检查 origin-clean）。
//     asset:// 图片会污染 canvas，toDataURL/toBlob 会抛 SecurityError，本文件绝不调用。
//   - 图标用 Path2D 同步绘制（无 Image 异步依赖），因此 shell 可同步合成，用作滚动兜底。
//   - 合成坐标空间 = 实际显示尺寸 size（CSS 逻辑像素），固定像素值（8px/12px 等）直接使用，
//     不按比例缩放，保证与 DOM 在不同尺寸下观感一致。

// ---------- 能力检测 ----------
export const isSpriteSupported = (): boolean =>
  typeof OffscreenCanvas !== 'undefined' &&
  typeof (OffscreenCanvas.prototype as any).transferToImageBitmap === 'function';

// ---------- 视觉常量（与 Folder3DIcon classic 逐项对应） ----------
export type IconTheme = 'light' | 'dark';
export type IconCategory = 'general' | 'book' | 'sequence';

const COLORS: Record<IconCategory, { backLight: string; backDark: string; front: string }> = {
  general: { backLight: '#2563eb', backDark: '#3b82f6', front: '#60a5fa' },
  book: { backLight: '#d97706', backDark: '#f59e0b', front: '#fbbf24' },
  sequence: { backLight: '#9333ea', backDark: '#a855f7', front: '#c084fc' },
};

const BACK_PATH =
  'M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z';
const FRONT_PATH =
  'M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z';

// 3D 透视（CSS perspective(800px) rotateX(-10deg)，transform-origin: bottom）
const PERSPECTIVE = 800;
const ROTATE_X = -10; // 度
const COS = Math.cos((ROTATE_X * Math.PI) / 180); // 0.98481
const SIN = Math.sin((ROTATE_X * Math.PI) / 180); // -0.17365

// 堆叠态（静止）与悬停扇形态（cardBase / cardHover）。tx/ty 为固定像素（px）；
// CARD_FAN 的 tx/ty 为相对卡片尺寸（w=0.70S × h=0.60S）的系数。
const CARD_BASE = [
  { rotate: 0, tx: 0, ty: 0, scale: 1, alpha: 1 }, // [0] 前
  { rotate: -3, tx: -4, ty: -6, scale: 0.95, alpha: 1 }, // [1] 中
  { rotate: 6, tx: 8, ty: -12, scale: 0.9, alpha: 0.8 }, // [2] 后
];
const CARD_FAN = [
  { rotate: 14, tx: 0.18, ty: -0.04, scale: 0.9, alpha: 1 }, // [0] 前（右侧扇形）
  { rotate: 0, tx: 0, ty: -0.1, scale: 1, alpha: 1 }, // [1] 中（居中上抬）
  { rotate: -14, tx: -0.18, ty: -0.04, scale: 0.9, alpha: 1 }, // [2] 后（左侧扇形）
];

// 无预览图时的灰阶占位（对应 DOM images.length===0 的三张占位卡；light / dark）
const PLACEHOLDER_COLORS = [
  '#ffffff', // 前 white | dark gray-500 #6b7280
  '#d1d5db', // 中 gray-300 | dark gray-700 #374151
  '#9ca3af', // 后 gray-400 | dark gray-600 #4b5563
];
const PLACEHOLDER_COLORS_DARK = ['#6b7280', '#374151', '#4b5563'];

// lucide 图标 Path2D（24 用户空间，strokeWidth=1.5）。图标颜色随主题：
//   light: blue-900 #1e3a8a @ alpha 0.7（容器 opacity-40 → 有效 0.28）
//   dark:  #ffffff @ alpha 0.8（容器 opacity-40 → 有效 0.32）
const LUCIDE_PATHS: Record<'Folder' | 'Book' | 'Film', string[]> = {
  Folder: [
    'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z',
  ],
  Book: [
    'M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20',
  ],
  Film: [
    'M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z',
    'M7 3v18',
    'M3 7.5h4',
    'M3 12h18',
    'M3 16.5h4',
    'M17 3v18',
    'M17 7.5h4',
    'M17 16.5h4',
  ],
};
const _path2dCache = new Map<string, Path2D>();
const getPath2D = (d: string): Path2D => {
  let p = _path2dCache.get(d);
  if (!p) {
    p = new Path2D(d);
    _path2dCache.set(d, p);
  }
  return p;
};

// ---------- 工具 ----------
// 2D 上下文统一类型（可见 canvas 与 OffscreenCanvas 共用同一套绘制逻辑）
export type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

const deg2rad = (deg: number) => (deg * Math.PI) / 180;

// 高质量缩放：canvas 默认 imageSmoothingQuality='low'（bilinear），放大缩略图明显发糊；
// 与浏览器 <img>（高质量重采样）对齐后可获得同等的清晰度
const applySmoothing = (ctx: Ctx2D) => {
  ctx.imageSmoothingEnabled = true;
  try {
    ctx.imageSmoothingQuality = 'high';
  } catch { /* 旧实现不支持 */ }
};

// CSS ease = cubic-bezier(0.25, 0.1, 0.25, 1)，数值解算（二分）
const _ease = (() => {
  const x1 = 0.25, y1 = 0.1, x2 = 0.25, y2 = 1;
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const sample = (t: number) => ((ax * t + bx) * t + cx) * t;
  const sampleY = (t: number) => ((ay * t + by) * t + cy) * t;
  return (x: number): number => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 12; i++) {
      const mid = (lo + hi) / 2;
      if (sample(mid) < x) lo = mid;
      else hi = mid;
    }
    return sampleY((lo + hi) / 2);
  };
})();

export const easeCss = (t: number) => _ease(Math.min(1, Math.max(0, t)));

// 把 SVG path 命令字符串解析采样为点集（处理 M/L/Q/C/Z，Q/C 按步长细分）
const pathToPoints = (d: string, curveSamples = 10): number[][] => {
  const nums = d.match(/[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g)?.map(Number) ?? [];
  const cmds = d.match(/[MmLlQqCcZz]/g) ?? [];
  const pts: number[][] = [];
  let ci = 0; // 命令索引
  let ni = 0; // 数字索引
  let cur: [number, number] = [0, 0];

  const readPair = (): [number, number] => {
    const x = nums[ni++], y = nums[ni++];
    return [x, y];
  };

  while (ci < cmds.length) {
    const c = cmds[ci++];
    if (c === 'M') {
      cur = readPair();
      pts.push([...cur]);
    } else if (c === 'L') {
      cur = readPair();
      pts.push([...cur]);
    } else if (c === 'Q') {
      const [cx, cy] = readPair();
      const [ex, ey] = readPair();
      for (let i = 1; i <= curveSamples; i++) {
        const t = i / curveSamples;
        const mt = 1 - t;
        pts.push([
          mt * mt * cur[0] + 2 * mt * t * cx + t * t * ex,
          mt * mt * cur[1] + 2 * mt * t * cy + t * t * ey,
        ]);
      }
      cur = [ex, ey];
    } else if (c === 'C') {
      const [c1x, c1y] = readPair();
      const [c2x, c2y] = readPair();
      const [ex, ey] = readPair();
      for (let i = 1; i <= curveSamples; i++) {
        const t = i / curveSamples;
        const mt = 1 - t;
        pts.push([
          mt * mt * mt * cur[0] + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * ex,
          mt * mt * mt * cur[1] + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ey,
        ]);
      }
      cur = [ex, ey];
    }
    // Z 忽略（闭合回到起点，fill 自动闭合）
  }
  return pts;
};

const roundRectPath = (
  ctx: Ctx2D,
  x: number, y: number, w: number, h: number, r: number
) => {
  ctx.beginPath();
  const c = ctx as Ctx2D & { roundRect?: (x: number, y: number, w: number, h: number, r: number) => void };
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

// 等价 CSS object-cover：填满目标矩形并居中裁剪
const drawCover = (
  ctx: Ctx2D,
  img: HTMLImageElement | ImageBitmap,
  dx: number, dy: number, dw: number, dh: number
) => {
  const iw = img.width;
  const ih = img.height;
  if (!iw || !ih) return;
  const scale = Math.max(dw / iw, dh / ih);
  const sw = dw / scale;
  const sh = dh / scale;
  ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, dx, dy, dw, dh);
};

// ---------- 3D 透视投影 ----------
// 前板局部坐标 y∈[0, 0.60S]，底边中点 O=(S/2, 0.60S)。返回图标坐标（已加 0.40S 平移）。
const projectPoint = (x: number, y: number, S: number): [number, number] => {
  const xr = x - S / 2;
  const yr = y - 0.6 * S;
  const y1 = yr * COS;
  const z = yr * SIN;
  const f = PERSPECTIVE / (PERSPECTIVE - z);
  return [S / 2 + xr * f, 0.6 * S + y1 * f + 0.4 * S];
};

// 元素中心 yc（前板局部）处的仿射近似：scaleX = f0, scaleY = COS·f0，原点在 O
const affineAt = (yc: number, S: number): { f0: number; sy: number } => {
  const yr = yc - 0.6 * S;
  const z = yr * SIN;
  const f0 = PERSPECTIVE / (PERSPECTIVE - z);
  return { f0, sy: COS * f0 };
};

// ---------- 后板 / 前板 ----------
const drawBackPlate = (ctx: Ctx2D, S: number, color: string, theme: IconTheme) => {
  const pts = pathToPoints(BACK_PATH, 10).map(([x, y]) => [x * S / 100, y * S / 100]);
  ctx.save();
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  // drop-shadow-sm（仅 light；dark:drop-shadow-none）
  if (theme === 'light') {
    ctx.filter = 'drop-shadow(0 1px 1px rgba(0,0,0,0.05))';
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
};

const drawFrontPlate = (ctx: Ctx2D, S: number, color: string, theme: IconTheme) => {
  // 前板路径在 viewBox 0..100 × 0..65，缩放 + 平移到前板局部（0..S × 0..0.60S），再逐点投影
  const pts = pathToPoints(FRONT_PATH, 8).map(([x, y]) => projectPoint((x / 100) * S, (y / 65) * 0.6 * S, S));
  ctx.save();
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  if (theme === 'light') {
    // drop-shadow-lg = Tailwind 两层
    ctx.filter = 'drop-shadow(0 10px 8px rgba(0,0,0,0.04)) drop-shadow(0 4px 3px rgba(0,0,0,0.1))';
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
};

// ---------- lucide 图标（Path2D 同步绘制，在透视仿射内） ----------
const drawIcon = (
  ctx: Ctx2D,
  S: number,
  icon: 'Folder' | 'Book' | 'Film',
  theme: IconTheme
) => {
  const { f0, sy } = affineAt(0.3 * S, S); // 图标中心在前板局部 y=0.30S
  ctx.save();
  // 前板局部 → 图标坐标，再以 O 为原点应用仿射（scaleX=f0, scaleY=sy）
  ctx.translate(0, 0.4 * S);
  ctx.translate(S / 2, 0.6 * S);
  ctx.scale(f0, sy);
  ctx.translate(-S / 2, -0.6 * S);
  // 图标以 (S/2, 0.30S) 为中心、32px 渲染
  const iconSize = 32;
  ctx.translate(S / 2 - iconSize / 2, 0.3 * S - iconSize / 2);
  ctx.globalAlpha = theme === 'light' ? 0.28 : 0.32; // opacity-40 × 颜色 alpha
  ctx.strokeStyle = theme === 'light' ? '#1e3a8a' : '#ffffff';
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const scale24 = iconSize / 24;
  ctx.scale(scale24, scale24);
  for (const d of LUCIDE_PATHS[icon]) {
    ctx.stroke(getPath2D(d));
  }
  ctx.restore();
};

// ---------- 数量角标（前板内 bottom-2 right-3，含透视仿射） ----------
// 导出供组件在 staticBody 上即时补画（不依赖异步 full 队列）
export const drawBadge = (ctx: Ctx2D, S: number, count: number) => {
  const fs = 9;
  ctx.save();
  ctx.font = `700 ${fs}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  const tw = ctx.measureText(String(count)).width;
  const padX = 6, padY = 2;
  const bh = fs * 1.6;
  const bw = tw + padX * 2;
  const bx = S - 12 - bw; // right-3 = 12px
  const by = 0.6 * S - 8 - bh; // bottom-2 = 8px（前板局部）
  // 前板内元素受透视影响，角标中心 yc 处仿射
  const yc = by + bh / 2;
  const { f0, sy } = affineAt(yc, S);
  ctx.translate(0, 0.4 * S);
  ctx.translate(S / 2, 0.6 * S);
  ctx.scale(f0, sy);
  ctx.translate(-S / 2, -0.6 * S);
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(0,0,0,0.35)';
  roundRectPath(ctx, bx, by, bw, bh, bh / 2);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.lineWidth = 1;
  roundRectPath(ctx, bx, by, bw, bh, bh / 2);
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(String(count), bx + padX, by + bh / 2 + fs * 0.05);
  ctx.restore();
};

// ---------- 单张预览卡（静止位图与悬停动画共用同一实现） ----------
export interface CardParams {
  rotate: number;
  tx: number;
  ty: number;
  scale: number;
  alpha: number;
}

// 预烘焙「白色圆角卡 + shadow-md 两层阴影」位图：把每张卡绘制时的 ctx.filter 双 drop-shadow
// 成本变成每 (卡宽,卡高) 只付一次（进缓存）。滚动排空期与悬停逐帧都只做一次 drawImage。
// 阴影在 DOM 中属于 transform 后的合成层、随卡片一起旋转 —— 预烘整卡后 drawImage 跟随
// drawCard 的 rotate/translate，视觉与 DOM 一致。
// pad 需容纳阴影外溢（0 4px 6px + 0 2px 4px → 最远约 10px）。
const CARD_SHADOW_PAD = 10;
const _cardBmpCache = new Map<string, ImageBitmap>();
const getCardBaseBmp = (cardW: number, cardH: number, res: number): ImageBitmap | null => {
  if (!isSpriteSupported()) return null;
  const key = `${Math.round(cardW)}|${Math.round(cardH)}|${res}`;
  let bmp = _cardBmpCache.get(key);
  if (bmp) return bmp;
  const W = Math.ceil(cardW + CARD_SHADOW_PAD * 2);
  const H = Math.ceil(cardH + CARD_SHADOW_PAD * 2);
  const off = new OffscreenCanvas(W * res, H * res);
  const ctx = off.getContext('2d');
  if (!ctx) return null;
  applySmoothing(ctx);
  ctx.scale(res, res);
  ctx.save();
  ctx.filter = 'drop-shadow(0 4px 6px rgba(0,0,0,0.1)) drop-shadow(0 2px 4px rgba(0,0,0,0.1))';
  ctx.fillStyle = '#ffffff';
  roundRectPath(ctx, CARD_SHADOW_PAD, CARD_SHADOW_PAD, cardW, cardH, 2);
  ctx.fill();
  ctx.restore();
  bmp = off.transferToImageBitmap();
  _cardBmpCache.set(key, bmp);
  // 尺寸桶缓存有界（正常视图只有个位数档位，48 足够）
  if (_cardBmpCache.size > 48) {
    const oldest = _cardBmpCache.keys().next().value;
    if (oldest !== undefined) _cardBmpCache.delete(oldest);
  }
  return bmp;
};

// rect 为预览组容器（x,y,w,h）；px 为卡片相对容器的变换参数。占位色用于 imgs 为 null 时。
export const drawCard = (
  ctx: Ctx2D,
  img: HTMLImageElement | ImageBitmap | null,
  rect: { x: number; y: number; w: number; h: number },
  p: CardParams,
  placeholderColor: string
) => {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  ctx.save();
  ctx.globalAlpha = p.alpha;
  // Tailwind transform 语义（translate → rotate → scale，矩阵最左最后应用）绕卡片中心
  ctx.translate(cx, cy);
  ctx.translate(p.tx, p.ty);
  ctx.rotate(deg2rad(p.rotate));
  ctx.scale(p.scale, p.scale);
  ctx.translate(-cx, -cy);
  // 预烘焙「白卡+阴影」位图（替代原 ctx.filter 双 drop-shadow；阴影随卡旋转，与 DOM 一致）
  const cardBmp = getCardBaseBmp(rect.w, rect.h, 2);
  if (cardBmp) {
    ctx.drawImage(
      cardBmp,
      rect.x - CARD_SHADOW_PAD,
      rect.y - CARD_SHADOW_PAD,
      rect.w + CARD_SHADOW_PAD * 2,
      rect.h + CARD_SHADOW_PAD * 2
    );
  } else {
    // 兜底：无 OffscreenCanvas 时退化为纯白卡（无阴影）
    roundRectPath(ctx, rect.x, rect.y, rect.w, rect.h, 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  // 内侧 2px 裁图（对应 border-[2px] white）
  ctx.save();
  roundRectPath(ctx, rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4, 2);
  ctx.clip();
  if (img) {
    drawCover(ctx, img, rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4);
  } else {
    ctx.fillStyle = placeholderColor;
    ctx.fillRect(rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4);
  }
  ctx.restore();
  ctx.restore();
};

// ---------- 图层合成（同步，供组合出完整静止位图 / 逐帧悬停） ----------
// 拆三层：back（后板）→ front（前板+图标）。预览卡绘制在两层之间，才能让
// 前板遮挡预览卡的下半部分（与 DOM 版 z-10 < z-20 一致）。
export const composeBack = (
  category: IconCategory,
  theme: IconTheme,
  size: number,
  dpr = 1
): ImageBitmap => {
  const c = COLORS[category] || COLORS.general;
  const back = theme === 'dark' ? c.backDark : c.backLight;
  const off = new OffscreenCanvas(size * dpr, size * dpr);
  const ctx = off.getContext('2d')!;
  applySmoothing(ctx);
  ctx.scale(dpr, dpr);
  drawBackPlate(ctx, size, back, theme);
  return off.transferToImageBitmap();
};

export const composeFront = (
  category: IconCategory,
  theme: IconTheme,
  size: number,
  dpr = 1
): ImageBitmap => {
  const c = COLORS[category] || COLORS.general;
  const off = new OffscreenCanvas(size * dpr, size * dpr);
  const ctx = off.getContext('2d')!;
  applySmoothing(ctx);
  ctx.scale(dpr, dpr);
  drawFrontPlate(ctx, size, c.front, theme);
  const icon = category === 'book' ? 'Book' : category === 'sequence' ? 'Film' : 'Folder';
  drawIcon(ctx, size, icon, theme);
  return off.transferToImageBitmap();
};

// 外壳合成（同步）：后板 + 前板 + 图标（无预览图、无角标）。滚动兜底单层贴图用。
export const composeShell = (
  category: IconCategory,
  theme: IconTheme,
  size: number,
  dpr = 1
): ImageBitmap => {
  const off = new OffscreenCanvas(size * dpr, size * dpr);
  const ctx = off.getContext('2d')!;
  applySmoothing(ctx);
  ctx.scale(dpr, dpr); // 之后所有坐标以 CSS 逻辑像素为单位
  const back = composeBack(category, theme, size, dpr);
  const front = composeFront(category, theme, size, dpr);
  ctx.drawImage(back, 0, 0, size, size);
  ctx.drawImage(front, 0, 0, size, size);
  return off.transferToImageBitmap();
};

// 静止完整态主体（同步，无 await）：后板 + 三张灰阶占位卡 + 前板 + 图标。
// 用于滚动/换档后立即显示（不依赖异步 full 队列），真图由队列异步升级覆盖；
// 角标由调用方在绘制后即时补画（drawBadge），避免按 count 缓存爆炸。
export const composeStaticBody = (
  category: IconCategory,
  theme: IconTheme,
  size: number,
  dpr = 1
): ImageBitmap | null => {
  if (size <= 0) return null;
  try {
    const off = new OffscreenCanvas(size * dpr, size * dpr);
    const ctx = off.getContext('2d')!;
    applySmoothing(ctx);
    ctx.scale(dpr, dpr);
    const back = composeBack(category, theme, size, dpr);
    ctx.drawImage(back, 0, 0, size, size);
    const g = { x: 0.15 * size, y: 0.2 * size, w: 0.7 * size, h: 0.6 * size };
    const placeholders = theme === 'dark' ? PLACEHOLDER_COLORS_DARK : PLACEHOLDER_COLORS;
    drawCard(ctx, null, g, CARD_BASE[2], placeholders[2]);
    drawCard(ctx, null, g, CARD_BASE[1], placeholders[1]);
    drawCard(ctx, null, g, CARD_BASE[0], placeholders[0]);
    const front = composeFront(category, theme, size, dpr);
    ctx.drawImage(front, 0, 0, size, size);
    return off.transferToImageBitmap();
  } catch (e) {
    console.error('[sprite] composeStaticBody failed:', e);
    return null;
  }
};

// ---------- 完整态合成（异步）：后板 + 三张堆叠预览卡 + 前板 + 角标 ----------
// 图片加载超时：某些 URL（如断连的局域网设备）可能长时间不触发 onload/onerror，
// 若不兜底会卡死整条串行合成队列（drainRunning 永远 true → 后续所有 full 永不执行）
const IMAGE_TIMEOUT_MS = 5000;

// 预览图解码缓存（按解码像素字节有界 LRU）：避免同一 src 反复 new Image() 重新解码。
// 场景：长滚动遍历大文件夹，fullCache(LRU 96) 频繁逐出导致同一封面反复重合成；
// asset:// 图在 WebView2 主线程解码成本可观，缓存解码结果可显著降低排空期主线程占用。
const _imgUsed = new Map<string, HTMLImageElement>();
let _imgUsedBytes = 0;
const IMG_CACHE_BUDGET = 64 * 1024 * 1024; // 约 64MB 解码像素
const _imgLoading = new Map<string, Promise<HTMLImageElement | null>>();

const cacheUsedImg = (src: string, img: HTMLImageElement) => {
  if (_imgUsed.has(src)) return;
  _imgUsed.set(src, img);
  _imgUsedBytes += (img.naturalWidth || 0) * (img.naturalHeight || 0) * 4;
  while (_imgUsedBytes > IMG_CACHE_BUDGET && _imgUsed.size > 1) {
    const oldestKey = _imgUsed.keys().next().value;
    if (oldestKey === undefined) break;
    const oldest = _imgUsed.get(oldestKey)!;
    _imgUsedBytes -= (oldest.naturalWidth || 0) * (oldest.naturalHeight || 0) * 4;
    _imgUsed.delete(oldestKey);
  }
};

// 失败源冷却：断连/未就绪的缩略图（尤其重启后缓存未生成）会在每次合成重试，
// 若不加冷却，带 5s 超时的 loadImage 会反复拖住排空队列。冷却期内直接判 null 快速跳过。
const _srcCooldown = new Map<string, number>();
const SRC_COOLDOWN_MS = 8000;
const markSrcCooldown = (src: string) => _srcCooldown.set(src, performance.now() + SRC_COOLDOWN_MS);
const isSrcCooling = (src: string): boolean => {
  const until = _srcCooldown.get(src);
  if (until === undefined) return false;
  if (performance.now() < until) return true;
  _srcCooldown.delete(src);
  return false;
};

export const loadImage = (src: string): Promise<HTMLImageElement | null> => {
  if (!src) return Promise.resolve(null);
  if (isSrcCooling(src)) return Promise.resolve(null);
  const used = _imgUsed.get(src);
  if (used && used.complete && used.naturalWidth > 0) return Promise.resolve(used);
  // 同一 src 并发请求合并为一次解码
  const inflight = _imgLoading.get(src);
  if (inflight) return inflight;
  const p = new Promise<HTMLImageElement | null>(resolve => {
    const img = new Image();
    img.decoding = 'async';
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      console.warn(`[sprite] preview image load timeout:`, src);
      markSrcCooldown(src);
      resolve(null);
    }, IMAGE_TIMEOUT_MS);
    const finish = (v: HTMLImageElement | null, reason?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (reason) console.warn(`[sprite] preview image ${reason}:`, src);
      if (v) {
        _srcCooldown.delete(src);
        cacheUsedImg(src, v);
      } else {
        markSrcCooldown(src);
      }
      resolve(v);
    };
    img.onload = () => finish(img);
    img.onerror = () => finish(null, 'load failed');
    img.src = src;
  });
  _imgLoading.set(src, p);
  p.finally(() => _imgLoading.delete(src));
  return p;
};

export const loadImages = (srcs: string[]): Promise<(HTMLImageElement | null)[]> =>
  Promise.all(srcs.map(loadImage));

export const composeFull = async (
  previewSrcs: string[],
  count: number | undefined,
  category: IconCategory,
  theme: IconTheme,
  size: number,
  dpr = 1,
  layers?: { back: ImageBitmap; front: ImageBitmap },
  shouldCancel?: () => boolean,
  decode?: (srcs: string[]) => Promise<(HTMLImageElement | ImageBitmap | null)[]>
): Promise<ImageBitmap | null> => {
  try {
    if (shouldCancel?.()) return null;
    const off = new OffscreenCanvas(size * dpr, size * dpr);
    const ctx = off.getContext('2d')!;
    applySmoothing(ctx);
    ctx.scale(dpr, dpr); // 之后所有坐标以 CSS 逻辑像素为单位

    // 顺序与 DOM 一致：后板 → 预览卡（被前板遮挡下半部分）→ 前板+图标 → 角标
    // 优先复用 layerCache 的 back/front（spriteCache 传入），避免每次新合成+滤镜
    const back = layers?.back ?? composeBack(category, theme, size, dpr);
    ctx.drawImage(back, 0, 0, size, size);

    const srcs = (previewSrcs || []).filter(s => !!s).slice(0, 3);
    // decode 可注入（Web Worker 用 createImageBitmap 解码，主线程默认 new Image()）
    const imgs = await (decode || loadImages)(srcs);
    // 图片解码等待期间滚动已开始：放弃本次合成，避免与滚动抢主线程
    if (shouldCancel?.()) return null;
    // 预览图解码失败（重启后缩略图未就绪/断连/冷却中）：返回 null 不落 fullCache，
    // 卡片保持 staticBody 灰卡占位，后续组件重试可获得真图。否则占位结果会被永久缓存，
    // 一旦命中就再也等不到真缩略图（表现为重启后一部分文件夹缩略图空白）。
    if (srcs.length > 0 && imgs.some(i => !i)) return null;
    const g = { x: 0.15 * size, y: 0.2 * size, w: 0.7 * size, h: 0.6 * size };
    const placeholders = theme === 'dark' ? PLACEHOLDER_COLORS_DARK : PLACEHOLDER_COLORS;

    if (srcs.length === 0) {
      // 与 DOM 一致：无图时画三张灰阶占位卡（后→中→前）
      drawCard(ctx, null, g, CARD_BASE[2], placeholders[2]);
      drawCard(ctx, null, g, CARD_BASE[1], placeholders[1]);
      drawCard(ctx, null, g, CARD_BASE[0], placeholders[0]);
    } else {
      for (let i = srcs.length - 1; i >= 0; i--) {
        drawCard(ctx, imgs[i], g, CARD_BASE[i], placeholders[i]);
      }
    }

    const front = layers?.front ?? composeFront(category, theme, size, dpr);
    ctx.drawImage(front, 0, 0, size, size);

    if (count !== undefined) drawBadge(ctx, size, count);
    return off.transferToImageBitmap();
  } catch (e) {
    console.error('[sprite] composeFull failed:', e);
    return null;
  }
};

// ---------- 悬停动画帧（逐帧绘制，坐标空间 = size） ----------
export interface HoverFrameInput {
  back: ImageBitmap;
  front: ImageBitmap;
  imgs: (HTMLImageElement | ImageBitmap | null)[];
  count: number | undefined;
  theme: IconTheme;
  size: number;
}

// 清整块画布（含 CANVAS_SCALE 放大后的留白区；否则卡片动画每帧位置不同，残留叠加成黑影）
const clearWhole = (ctx: Ctx2D) => {
  const cvs = ctx.canvas as { width: number; height: number };
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cvs.width, cvs.height);
  ctx.restore();
};

export const drawHoverFrame = (
  ctx: Ctx2D,
  input: HoverFrameInput,
  t: number // 已进入悬停的毫秒数（0..300+）
) => {
  const { back, front, imgs, count, theme, size } = input;
  const S = size;
  clearWhole(ctx);
  applySmoothing(ctx);
  ctx.drawImage(back, 0, 0, S, S);

  const srcs = imgs.filter(Boolean);
  const p = easeCss(t / 300);
  const g = { x: 0.15 * S, y: 0.2 * S, w: 0.7 * S, h: 0.6 * S };
  const placeholders = theme === 'dark' ? PLACEHOLDER_COLORS_DARK : PLACEHOLDER_COLORS;

  ctx.save();
  // 预览组容器 hover 变换：translate(0,-12px)·scale(1.05) 绕容器中心
  const cx = g.x + g.w / 2;
  const cy = g.y + g.h / 2;
  ctx.translate(cx, cy);
  ctx.translate(0, -12 * p);
  ctx.scale(1 + 0.05 * p, 1 + 0.05 * p);
  ctx.translate(-cx, -cy);

  const fan = srcs.length >= 2; // 与 DOM 一致：仅 >=2 张才扇形
  const n = srcs.length === 0 ? 3 : srcs.length;
  const cardW = 0.7 * S, cardH = 0.6 * S;
  for (let i = n - 1; i >= 0; i--) {
    const from = CARD_BASE[i];
    const to = fan ? CARD_FAN[i] : CARD_BASE[i];
    // from 为固定像素；to 为相对卡片尺寸的系数（fan 时换算成像素）
    const toTx = fan ? to.tx * cardW : from.tx;
    const toTy = fan ? to.ty * cardH : from.ty;
    drawCard(ctx, imgs[i] ?? null, g, {
      rotate: from.rotate + (to.rotate - from.rotate) * p,
      tx: from.tx + (toTx - from.tx) * p,
      ty: from.ty + (toTy - from.ty) * p,
      scale: from.scale + (to.scale - from.scale) * p,
      alpha: from.alpha + (to.alpha - from.alpha) * p,
    }, placeholders[i]);
  }
  ctx.restore();

  ctx.drawImage(front, 0, 0, S, S);
  if (count !== undefined) drawBadge(ctx, S, count);
};
