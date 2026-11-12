// 轻量非破坏图片调整 —— 前端契约与纯函数。
//
// ⚠️ 权威公式在 src-tauri/src/image_adjust.rs(apply_tone_rgb / apply_geo /
//    straighten_image),本文件逐项对齐,两端由 Rust 单测 + 本目录 spec 测试双面钉住。
//    改任何公式必须两端同步,否则预览 ≠ 缩略图 ≠ 导出。
//
// 钉死的约定:
// - 应用顺序:EXIF 方向(前端由 WebView 自动转正)→ flipH/flipV → rotate90×n(顺时针)
//   → 拉直 → 裁剪 → 影调 → 编码;
// - 影调顺序:亮度 → 对比度 → 饱和度 → 色温 → 色调,**每步后 clamp 到 [0,1]**;
// - luma 系数 Rec709 (0.213, 0.715, 0.072) —— 与 SVG feColorMatrix saturate 一致;
// - 亮度/对比度/饱和度用 CSS 内建 filter 函数(语义与公式完全一致,GPU 加速);
//   色温/色调无 CSS 内建,走 SVG `#aurora-adjust-tt` 对角增益矩阵(见 AdjustFilterDefs);
// - 拉直:正角度 = 图像内容视觉逆时针(Canvas `ctx.rotate(-rad)` 同向);
// - cropNorm 基于几何矫正完成后的正向图归一化坐标。

export interface AdjustCropNorm {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AdjustGeoParams {
  rotate90: number; // 顺时针 90° 步数 0..3
  flipH: boolean;
  flipV: boolean;
  straightenDeg: number; // -15..15,0=关
  cropNorm: AdjustCropNorm | null;
}

export interface AdjustToneParams {
  brightness: number; // -1..1,0=不调
  contrast: number;
  saturation: number;
  temperature: number; // -1(冷)..1(暖)
  tint: number; // -1(绿)..1(品红)
}

export interface AdjustParams {
  v: number;
  geo: AdjustGeoParams;
  tone: AdjustToneParams;
}

export const ADJUST_LUMA: [number, number, number] = [0.213, 0.715, 0.072];

export const ADJUST_DEFAULT: AdjustParams = {
  v: 1,
  geo: { rotate90: 0, flipH: false, flipV: false, straightenDeg: 0, cropNorm: null },
  tone: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function isDefaultAdjustParams(p: AdjustParams): boolean {
  const { geo, tone } = p;
  return (
    geo.rotate90 === 0 &&
    !geo.flipH &&
    !geo.flipV &&
    Math.abs(geo.straightenDeg) < 1e-6 &&
    geo.cropNorm === null &&
    tone.brightness === 0 &&
    tone.contrast === 0 &&
    tone.saturation === 0 &&
    tone.temperature === 0 &&
    tone.tint === 0
  );
}

export function cloneDefault(): AdjustParams {
  return {
    v: 1,
    geo: { rotate90: 0, flipH: false, flipV: false, straightenDeg: 0, cropNorm: null },
    tone: { brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 },
  };
}

/** 字段收敛(与 Rust AdjustParams::sanitize 同口径):脏数据不炸管线。 */
export function sanitizeAdjustParams(p: AdjustParams): AdjustParams {
  const out: AdjustParams = {
    v: p.v || 1,
    geo: { ...p.geo, cropNorm: p.geo.cropNorm ? { ...p.geo.cropNorm } : null },
    tone: { ...p.tone },
  };
  out.geo.rotate90 = ((Math.round(out.geo.rotate90) % 4) + 4) % 4;
  out.geo.straightenDeg = clamp(Number(out.geo.straightenDeg) || 0, -15, 15);
  out.geo.flipH = !!out.geo.flipH;
  out.geo.flipV = !!out.geo.flipV;
  for (const k of ['brightness', 'contrast', 'saturation', 'temperature', 'tint'] as const) {
    out.tone[k] = clamp(Number(out.tone[k]) || 0, -1, 1);
  }
  if (out.geo.cropNorm) {
    const c = out.geo.cropNorm;
    c.x = clamp(c.x, 0, 1);
    c.y = clamp(c.y, 0, 1);
    c.w = clamp(c.w, 0, 1 - c.x);
    c.h = clamp(c.h, 0, 1 - c.y);
    if (c.w <= 0 || c.h <= 0) out.geo.cropNorm = null;
  }
  return out;
}

/**
 * 单像素影调(权威对齐 Rust apply_tone_rgb)。rgb ∈ [0,1],**每步后 clamp**
 * (与 SVG 滤镜逐原语 clamp 语义一致)。前端主要用于测试与自动增强推导;
 * 渲染走 CSS/SVG 滤镜链(同公式、GPU 加速)。
 */
export function applyToneRGBFloat(rgb: [number, number, number], t: AdjustToneParams): void {
  // 亮度:v' = v × (1+p) —— CSS brightness(1+p)
  const b = 1 + t.brightness;
  for (let i = 0; i < 3; i++) rgb[i] = clamp(rgb[i] * b, 0, 1);
  // 对比度:v' = (v-0.5)(1+p)+0.5 —— CSS contrast(1+p)
  const c = 1 + t.contrast;
  for (let i = 0; i < 3; i++) rgb[i] = clamp((rgb[i] - 0.5) * c + 0.5, 0, 1);
  // 饱和度:v' = lerp(gray, v, 1+p) —— CSS saturate(1+p)(Rec709 luma)
  const s = 1 + t.saturation;
  const gray = ADJUST_LUMA[0] * rgb[0] + ADJUST_LUMA[1] * rgb[1] + ADJUST_LUMA[2] * rgb[2];
  for (let i = 0; i < 3; i++) rgb[i] = clamp(gray + (rgb[i] - gray) * s, 0, 1);
  // 色温/色调:对角增益 —— SVG #aurora-adjust-tt
  rgb[0] = clamp(rgb[0] * (1 + t.temperature * 0.25), 0, 1);
  rgb[2] = clamp(rgb[2] * (1 - t.temperature * 0.25), 0, 1);
  rgb[1] = clamp(rgb[1] * (1 - t.tint * 0.25), 0, 1);
}

/**
 * 影调 → CSS filter 字符串。亮度/对比度/饱和度走 CSS 内建(公式逐项一致);
 * 色温/色调引用 SVG 对角矩阵 `#aurora-adjust-tt`(AdjustFilterDefs 挂载)。
 * 全默认返回 'none'。
 */
export function cssFilterForTone(t: AdjustToneParams): string {
  const parts: string[] = [];
  if (t.brightness !== 0) parts.push(`brightness(${(1 + t.brightness).toFixed(6)})`);
  if (t.contrast !== 0) parts.push(`contrast(${(1 + t.contrast).toFixed(6)})`);
  if (t.saturation !== 0) parts.push(`saturate(${(1 + t.saturation).toFixed(6)})`);
  if (t.temperature !== 0 || t.tint !== 0) parts.push('url(#aurora-adjust-tt)');
  return parts.length ? parts.join(' ') : 'none';
}

/**
 * 拉直后同长宽比最大内接矩形(对齐 Rust straighten_image 的**精确解**)。
 * 中心对称多边形的最大内接中心对称矩形必居中,半高 y 受四条约束取最小:
 *   ① y ≤ (W/2)/(c·k + s)  ② (c·k−s>0 时) y ≤ (W/2)/(c·k−s)
 *   ③ y ≤ (H/2)/(c + s·k)  ④ (c−s·k>0 时) y ≤ (H/2)/(c−s·k)
 * (W=长边,H=短边,k=长/短;θ→0 退化为原尺寸)。返回源像素口径的 (w, h)。
 */
export function inscribedRect(w: number, h: number, deg: number): { w: number; h: number } {
  const theta = (Math.abs(deg) * Math.PI) / 180;
  const sin = Math.sin(theta);
  const cos = Math.cos(theta);
  if (sin < 1e-9) return { w, h };
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const k = long / short;
  const inf = Number.POSITIVE_INFINITY;
  const cands = [
    (long / 2) / (cos * k + sin),
    cos * k > sin ? (long / 2) / (cos * k - sin) : inf,
    (short / 2) / (cos + sin * k),
    cos > sin * k ? (short / 2) / (cos - sin * k) : inf,
  ];
  const y = Math.min(...cands);
  const short2 = Math.max(2 * y, 1);
  const long2 = k * short2;
  return w >= h ? { w: long2, h: short2 } : { w: short2, h: long2 };
}

/**
 * 自动增强参数推导(设计 §1 一期:直方图拉伸 + 灰世界白平衡,展开为具体参数值)。
 *
 * @param p2/p98 亮度通道 2%/98% 分位(0..1);meanR/G/B 三通道均值(0..1,透明像素跳过)
 *
 * 亮度+对比度合成目标:v' = slope·(v - mid) + 0.5。
 * 链式展开(亮度→对比度,无 clamp 激活时):v' = (1+pb)(1+pc)·v - 0.5·pc
 *   → pc = 2·slope·mid - 1;pb = slope/(1+pc) - 1。
 * 色温:灰世界假设,偏蓝(meanB>meanR)→ 加暖(正 p)。
 */
export function autoEnhanceFromStats(
  p2: number,
  p98: number,
  meanR: number,
  meanG: number,
  meanB: number
): AdjustToneParams {
  const span = Math.max(p98 - p2, 1e-4);
  const slope = clamp(1 / span, 0.5, 2.5);
  const mid = clamp((p2 + p98) / 2, 0.2, 0.8);
  const contrast = clamp(2 * slope * mid - 1, -1, 0.9);
  const brightness = clamp(slope / (1 + contrast) - 1, -1, 1);
  const temperature = clamp(((meanB - meanR) / Math.max(meanR + meanB, 1e-3)) * 2, -1, 1);
  return { brightness, contrast, saturation: 0, temperature, tint: 0 };
}

/** 把已有裁剪框调整为锁定比例(以保持 w 不变、居中缩放 h;超出边界则回推 w)。 */
export function fitCropToAspect(
  crop: AdjustCropNorm,
  aspect: number // w/h
): AdjustCropNorm {
  // 先按当前 w 推 h
  let w = crop.w;
  let h = w / aspect;
  if (h > 1 - crop.y) {
    h = 1 - crop.y;
    w = h * aspect;
    if (w > 1 - crop.x) {
      w = 1 - crop.x;
      h = w / aspect;
    }
  }
  if (h <= 0 || w <= 0) return { x: 0, y: 0, w: 1, h: 1 };
  // 保持中心
  const cx = crop.x + crop.w / 2;
  const cy = crop.y + crop.h / 2;
  const x = clamp(cx - w / 2, 0, 1 - w);
  const y = clamp(cy - h / 2, 0, 1 - h);
  return { x, y, w, h };
}
