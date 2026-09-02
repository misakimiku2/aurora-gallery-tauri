// 经典 3D 文件夹图标的 Canvas 预合成引擎。
//
// 目标：把「后板 + 前板 + 图标 + 角标 + 三张堆叠预览卡」预先绘制成单张位图，
//       运行时只贴一张图 → 每个文件夹卡片 1 个合成层，滚动成本与图片卡同级。
// 悬停：用 drawHoverFrame 逐帧复刻 DOM 的 CSS transition（300ms ease + 扇形摊开 + 容器位移放大），
//       与静止位图共用同一 drawCard / drawBadge 实现，保证静止↔动画结构上无缝衔接。
//
// 背板/前板形状与 icon.svg 完全一致（含圆弧圆角与透视梯形；尺寸/3D 透视已烘焙进路径，
// 绘制时不再做二次投影或矩阵变换）。背板纯色、前板垂直渐变（0→front，1→back），
// 与 icon.svg 的 linearGradient 一致；两板均无投影/描边。
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

// 背板 / 前板路径直接取自 icon.svg 的 id="back" / id="front" 的 d 属性。
// 新版 icon.svg 已将尺寸/3D 透视烘焙进路径：无 transform，坐标即 viewBox 0 0 67.733332 67.733333 空间。
const BACK_PATH =
  'm 2.1518046,14.812232 v 2.645833 l 0,40.849487 0,5.820833 a 1.5875,1.5875 45 0 0 1.5875,1.5875 H 63.994029 a 1.5875,1.5875 135 0 0 1.5875,-1.5875 l 0,-43.49532 a 1.5875,1.5875 45 0 0 -1.5875,-1.5875 H 18.780985 a 3.1031383,3.1031383 27.093326 0 1 -2.51642,-1.287348 l -2.342339,-3.246138 a 3.1031383,3.1031383 27.093326 0 0 -2.51642,-1.287347 l -7.6665014,0 a 1.5875,1.5875 135 0 0 -1.5875,1.5875 z';
const FRONT_PATH =
  'm 1.7507975,32.240139 c -0.85398955,5e-6 -1.52498916,0.730941 -1.45210772,1.581815 L 2.0164144,64.13407 c 0.076516,0.894612 0.8250135,1.58182 1.7228922,1.581815 H 63.994027 c 0.897879,5e-6 1.646376,-0.687203 1.722892,-1.581815 l 1.717725,-30.312116 c 0.07288,-0.850874 -0.598118,-1.58181 -1.452108,-1.581815 z';

// icon.svg 几何常量（viewBox 尺寸 / 前板梯形与渐变坐标，均已烘焙进路径）
const SVG_SIZE = 67.733333;
// 前板梯形：顶部 y≈32.24(0.476S)、底部 y≈65.72(0.970S)；右边缘顶部 x≈0.974S → 底部 x≈0.945S
const FRONT_TOP_F = 0.476;
const FRONT_BOTTOM_F = 0.9703;
const FRONT_RIGHT_TOP_F = 0.9741;
const FRONT_RIGHT_BOTTOM_F = 0.9448;
// 图标中心 = 前板质心 ≈ (0.5S, 0.726S)，取 0.723S（略上移为底部角标留位）
const FRONT_CENTER_Y_F = 0.723;
// 前板垂直渐变（icon.svg linearGradient13：userSpaceOnUse，2 段 #60a5fa→#2563eb，y 37.65 → 77.36）
const GRAD_Y1 = 37.648235;
const GRAD_Y2 = 77.358284;

// ---------- 数量角标位置规则 ----------
// 默认尺寸（含）以上：沿用固定 12px 右间距 / 8px 下间距（不偏移）。
// 低于默认尺寸：角标向右线性偏移，最小尺寸最多右移 BADGE_MAX_SHIFT px，
// 补偿固定像素边距在小图标上把角标推向中间的问题。
const BADGE_DEFAULT_SIZE = 160; // 图标默认尺寸（S ≥ 此值不偏移）
const BADGE_MIN_SIZE = 80;      // 图标最小尺寸（S ≤ 此值偏移达到上限）
const BADGE_MAX_SHIFT = 15;     // 最小尺寸时的最大右移量（px）

// ---------- 图标整体变换 ----------
// 新版 icon.svg 已将尺寸烘焙进路径，故两系数为 1.0（不缩放），canvas 渲染 = SVG 原生大小。
// 如需再次整体等比放大/竖直拉高，调整以下系数即可（作用于背板/前板/预览卡/图标/角标全部元素）。
const ICON_SCALE = 1; // 等比放大倍数
const ICON_STRETCH_Y = 1; // 竖直拉长系数（在等比基础上再纵向拉伸）

const applyIconTransform = (ctx: Ctx2D, S: number) => {
  ctx.translate(S / 2, S / 2);
  ctx.scale(ICON_SCALE, ICON_SCALE * ICON_STRETCH_Y);
  ctx.translate(-S / 2, -S / 2);
};

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

// SVG 圆弧（endpoint → center 参数化）采样为点集，支持 rx/ry/旋转/large-arc/sweep。
const arcToPoints = (
  x1: number, y1: number,
  rx: number, ry: number,
  phiDeg: number, largeArc: number, sweep: number,
  x2: number, y2: number,
  samples: number
): number[][] => {
  if (Math.abs(x1 - x2) < 1e-9 && Math.abs(y1 - y2) < 1e-9) return [];
  rx = Math.abs(rx); ry = Math.abs(ry);
  const phi = (phiDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi), sinPhi = Math.sin(phi);
  // 平移旋转到与轴对齐的坐标系
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const x1p = cosPhi * dx + sinPhi * dy;
  const y1p = -sinPhi * dx + cosPhi * dy;
  // 半径过小时按比例放大
  const lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lam > 1) {
    const s = Math.sqrt(lam);
    rx *= s; ry *= s;
  }
  // 计算圆心
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  let radicand = den === 0 ? 0 : num / den;
  if (radicand < 0) radicand = 0;
  const coef = (largeArc === sweep ? -1 : 1) * Math.sqrt(radicand);
  const cxp = (coef * rx * y1p) / ry;
  const cyp = (coef * -ry * x1p) / rx;
  // 起始角与扫过角（angle(u,v) = atan2(u×v, u·v)）
  const ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
  const startAngle = Math.atan2(uy, ux);
  let deltaAngle = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  if (!sweep && deltaAngle > 0) deltaAngle -= 2 * Math.PI;
  else if (sweep && deltaAngle < 0) deltaAngle += 2 * Math.PI;
  // 采样点：先画旋转坐标系内的圆，再旋转回原始坐标系并平移到中点半程
  const pts: number[][] = [];
  const n = Math.max(2, Math.ceil((samples * Math.abs(deltaAngle)) / (Math.PI / 2)));
  for (let i = 1; i <= n; i++) {
    const t = startAngle + (deltaAngle * i) / n;
    const ex = cxp + rx * Math.cos(t);
    const ey = cyp + ry * Math.sin(t);
    pts.push([
      cosPhi * ex - sinPhi * ey + (x1 + x2) / 2,
      sinPhi * ex + cosPhi * ey + (y1 + y2) / 2,
    ]);
  }
  return pts;
};

// 把 SVG path 命令字符串解析采样为点集。
// 支持绝对/相对命令 M/m L/l H/h V/v Q/q C/c A/a Z/z（Q/C 按步长细分、A 走 arcToPoints），
// 并处理命令后的隐式参数重复（如 "m x,y x2,y2" 的隐式 lineto）。
const pathToPoints = (d: string, curveSamples = 10): number[][] => {
  const tokens: (string | number)[] = [];
  const re = /[MmLlHhVvQqCcAaZz]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d))) {
    const t = m[0];
    tokens.push(/^[MmLlHhVvQqCcAaZz]$/.test(t) ? t : Number(t));
  }
  const pts: number[][] = [];
  let i = 0;
  let cur: [number, number] = [0, 0];
  let start: [number, number] = [0, 0];

  const nextIsNumber = () => typeof tokens[i] === 'number';
  const readNum = () => (typeof tokens[i] === 'number' ? (tokens[i++] as number) : 0);
  const readPair = (rel: boolean): [number, number] => {
    const x = readNum(), y = readNum();
    return rel ? [cur[0] + x, cur[1] + y] : [x, y];
  };

  while (i < tokens.length) {
    const c = tokens[i++] as string;
    const rel = c === c.toLowerCase();
    const up = c.toUpperCase();
    if (up === 'Z') {
      cur = [start[0], start[1]];
    } else if (up === 'M') {
      cur = readPair(rel);
      pts.push([...cur]);
      start = [cur[0], cur[1]];
      while (nextIsNumber()) { cur = readPair(rel); pts.push([...cur]); }
    } else if (up === 'L') {
      while (nextIsNumber()) { cur = readPair(rel); pts.push([...cur]); }
    } else if (up === 'H') {
      while (nextIsNumber()) {
        const x = readNum();
        cur = rel ? [cur[0] + x, cur[1]] : [x, cur[1]];
        pts.push([...cur]);
      }
    } else if (up === 'V') {
      while (nextIsNumber()) {
        const y = readNum();
        cur = rel ? [cur[0], cur[1] + y] : [cur[0], y];
        pts.push([...cur]);
      }
    } else if (up === 'Q') {
      while (nextIsNumber()) {
        const [c1x, c1y] = readPair(rel);
        const [ex, ey] = readPair(rel);
        for (let k = 1; k <= curveSamples; k++) {
          const t = k / curveSamples;
          const mt = 1 - t;
          pts.push([
            mt * mt * cur[0] + 2 * mt * t * c1x + t * t * ex,
            mt * mt * cur[1] + 2 * mt * t * c1y + t * t * ey,
          ]);
        }
        cur = [ex, ey];
      }
    } else if (up === 'C') {
      while (nextIsNumber()) {
        const [c1x, c1y] = readPair(rel);
        const [c2x, c2y] = readPair(rel);
        const [ex, ey] = readPair(rel);
        for (let k = 1; k <= curveSamples; k++) {
          const t = k / curveSamples;
          const mt = 1 - t;
          pts.push([
            mt * mt * mt * cur[0] + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * ex,
            mt * mt * mt * cur[1] + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * ey,
          ]);
        }
        cur = [ex, ey];
      }
    } else if (up === 'A') {
      while (nextIsNumber()) {
        const rx = readNum(), ry = readNum(), rot = readNum(), laf = readNum(), sf = readNum();
        const [ex, ey] = readPair(rel);
        pts.push(...arcToPoints(cur[0], cur[1], rx, ry, rot, laf, sf, ex, ey, curveSamples));
        cur = [ex, ey];
      }
    }
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

// ---------- 后板 / 前板（形状取自 icon.svg，已烘焙，直接缩放平铺绘制） ----------
// 把 icon.svg 路径点（viewBox 空间，无 transform）缩放到 size 画布
const svgPathToCanvas = (d: string, S: number, samples: number): number[][] => {
  const k = S / SVG_SIZE;
  return pathToPoints(d, samples).map(([x, y]) => [x * k, y * k]);
};

// 背板：纯色实心（无投影/描边，与 icon.svg 一致）
const drawBackPlate = (ctx: Ctx2D, S: number, color: string) => {
  const pts = svgPathToCanvas(BACK_PATH, S, 6);
  ctx.save();
  applyIconTransform(ctx, S);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  ctx.restore();
};

// 前板：垂直渐变（0→front，1→back），对应 icon.svg linearGradient13（2 段）
const drawFrontPlate = (ctx: Ctx2D, S: number, front: string, back: string) => {
  const pts = svgPathToCanvas(FRONT_PATH, S, 6);
  ctx.save();
  applyIconTransform(ctx, S);
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.closePath();
  const k = S / SVG_SIZE;
  const grad = ctx.createLinearGradient(0, GRAD_Y1 * k, 0, GRAD_Y2 * k);
  grad.addColorStop(0, front);
  grad.addColorStop(1, back);
  ctx.fillStyle = grad;
  ctx.fill();
  ctx.restore();
};

// ---------- lucide 图标（Path2D 同步绘制，平铺于前板质心） ----------
const drawIcon = (
  ctx: Ctx2D,
  S: number,
  icon: 'Folder' | 'Book' | 'Film',
  theme: IconTheme
) => {
  ctx.save();
  applyIconTransform(ctx, S);
  const iconSize = 32;
  ctx.translate(S / 2 - iconSize / 2, FRONT_CENTER_Y_F * S - iconSize / 2);
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

// ---------- 数量角标（前板内 bottom-2 right-3，平铺绘制） ----------
// 导出供组件在 staticBody 上即时补画（不依赖异步 full 队列）
export const drawBadge = (ctx: Ctx2D, S: number, count: number) => {
  const fs = 9;
  ctx.save();
  applyIconTransform(ctx, S);
  ctx.font = `700 ${fs}px system-ui, -apple-system, 'Segoe UI', sans-serif`;
  const tw = ctx.measureText(String(count)).width;
  const padX = 6, padY = 2;
  const bh = fs * 1.6;
  const bw = tw + padX * 2;
  // 前板底部 8px、右侧 12px（默认规则），右边缘随前板梯形内收
  const by = FRONT_BOTTOM_F * S - 8 - bh;
  const fy = (by + bh / 2) / S;
  const xRight =
    (FRONT_RIGHT_TOP_F + (FRONT_RIGHT_BOTTOM_F - FRONT_RIGHT_TOP_F) * (fy - FRONT_TOP_F) / (FRONT_BOTTOM_F - FRONT_TOP_F)) * S;
  let bx = xRight - 12 - bw;
  // 低于默认尺寸：角标向右偏移，最小尺寸最多右移 BADGE_MAX_SHIFT px（见 BADGE_* 常量）
  if (S < BADGE_DEFAULT_SIZE) {
    const t = Math.min(1, Math.max(0, (BADGE_DEFAULT_SIZE - S) / (BADGE_DEFAULT_SIZE - BADGE_MIN_SIZE)));
    bx += BADGE_MAX_SHIFT * t;
  }
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
// S 为图标尺寸（用于整体放大/上移变换，保持卡片与背板/前板同步缩放）。
export const drawCard = (
  ctx: Ctx2D,
  S: number,
  img: HTMLImageElement | ImageBitmap | null,
  rect: { x: number; y: number; w: number; h: number },
  p: CardParams,
  placeholderColor: string
) => {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  ctx.save();
  applyIconTransform(ctx, S);
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
  drawBackPlate(ctx, size, back);
  return off.transferToImageBitmap();
};

export const composeFront = (
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
  drawFrontPlate(ctx, size, c.front, back);
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
    drawCard(ctx, size, null, g, CARD_BASE[2], placeholders[2]);
    drawCard(ctx, size, null, g, CARD_BASE[1], placeholders[1]);
    drawCard(ctx, size, null, g, CARD_BASE[0], placeholders[0]);
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
      drawCard(ctx, size, null, g, CARD_BASE[2], placeholders[2]);
      drawCard(ctx, size, null, g, CARD_BASE[1], placeholders[1]);
      drawCard(ctx, size, null, g, CARD_BASE[0], placeholders[0]);
    } else {
      for (let i = srcs.length - 1; i >= 0; i--) {
        drawCard(ctx, size, imgs[i], g, CARD_BASE[i], placeholders[i]);
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
    drawCard(ctx, S, imgs[i] ?? null, g, {
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
