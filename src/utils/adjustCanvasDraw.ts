// 调整渲染的共享画布工具:几何帧构建 + 自动增强取样。
// AdjustCanvas(查看器预览)与 AVIF 兜底缩略图生成器(thumbnail.ts)共用,
// 保证「查看器所见 = 网格缩略图 = 导出」三方一致(公式权威见 image_adjust.rs)。

import { AdjustParams, cssFilterForTone, inscribedRect, isDefaultAdjustParams } from './adjust';

export interface AdjustedFrame {
  canvas: HTMLCanvasElement;
  width: number;
  height: number;
}

/**
 * 构建几何矫正后的「帧画布」:flip → rotate90(顺时针)→ 拉直(内接矩形,边缘复制)。
 * 浏览器解码的 <img> 已按 EXIF 自动转正,这里无需处理方向。
 * 裁剪与影调不在此步(裁剪是帧内归一化子矩形;影调由调用方 ctx.filter 施加,
 * 以便交互态把滤镜只作用于内容、不作用于裁剪覆盖层)。
 */
export function buildAdjustedFrame(img: HTMLImageElement, params: AdjustParams, maxLongEdge = 2048): AdjustedFrame {
  const scale0 = Math.min(1, maxLongEdge / Math.max(img.naturalWidth, img.naturalHeight));
  const iw = Math.max(1, Math.round(img.naturalWidth * scale0));
  const ih = Math.max(1, Math.round(img.naturalHeight * scale0));
  const rot = ((Math.round(params.geo.rotate90) % 4) + 4) % 4;
  const swap = rot % 2 === 1;
  const bw = swap ? ih : iw;
  const bh = swap ? iw : ih;

  const base = document.createElement('canvas');
  base.width = bw;
  base.height = bh;
  const bctx = base.getContext('2d');
  if (!bctx) return { canvas: base, width: bw, height: bh };
  bctx.imageSmoothingEnabled = true;
  bctx.imageSmoothingQuality = 'high';
  bctx.save();
  bctx.translate(bw / 2, bh / 2);
  bctx.rotate((rot * Math.PI) / 2);
  bctx.scale(params.geo.flipH ? -1 : 1, params.geo.flipV ? -1 : 1);
  bctx.drawImage(img, -iw / 2, -ih / 2, iw, ih);
  bctx.restore();

  const deg = params.geo.straightenDeg;
  if (Math.abs(deg) < 0.01) {
    return { canvas: base, width: bw, height: bh };
  }

  // 拉直:输出取同长宽比最大内接矩形(与 Rust straighten_image 同公式);
  // 正角度 = 内容视觉逆时针(canvas y-down 下 rotate(-rad))
  const ins = inscribedRect(bw, bh, deg);
  const fw = Math.max(1, Math.round(ins.w));
  const fh = Math.max(1, Math.round(ins.h));
  const frame = document.createElement('canvas');
  frame.width = fw;
  frame.height = fh;
  const fctx = frame.getContext('2d');
  if (!fctx) return { canvas: base, width: bw, height: bh };
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  fctx.translate(fw / 2, fh / 2);
  fctx.rotate((-deg * Math.PI) / 180);
  fctx.drawImage(base, -bw / 2, -bh / 2);
  return { canvas: frame, width: fw, height: fh };
}

/** 帧内裁剪子矩形的像素坐标。 */
export function frameCropRect(frame: AdjustedFrame, params: AdjustParams): { sx: number; sy: number; sw: number; sh: number } {
  const crop = params.geo.cropNorm;
  if (!crop) return { sx: 0, sy: 0, sw: frame.width, sh: frame.height };
  return {
    sx: crop.x * frame.width,
    sy: crop.y * frame.height,
    sw: Math.max(1, crop.w * frame.width),
    sh: Math.max(1, crop.h * frame.height),
  };
}

/** 供调用方直接把「帧+影调+裁剪结果」画进任意目标画布(如 AVIF 兜底缩略图)。 */
export function drawAdjustedToCtx(
  ctx: CanvasRenderingContext2D,
  frame: AdjustedFrame,
  params: AdjustParams,
  dx: number,
  dy: number,
  dw: number,
  dh: number
): void {
  const { sx, sy, sw, sh } = frameCropRect(frame, params);
  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const filter = cssFilterForTone(params.tone);
  if (filter !== 'none') ctx.filter = filter;
  ctx.drawImage(frame.canvas, sx, sy, sw, sh, dx, dy, dw, dh);
  ctx.restore();
}

export interface AutoEnhanceStats {
  p2: number;
  p98: number;
  meanR: number;
  meanG: number;
  meanB: number;
}

/**
 * 自动增强取样:对源图下采样(短边 ≤256)取亮度直方图分位与通道均值。
 * 透明像素(alpha<8)跳过,不污染统计。
 */
export function computeAutoEnhanceStats(img: HTMLImageElement): AutoEnhanceStats | null {
  const long = Math.max(img.naturalWidth, img.naturalHeight);
  const scale = long > 0 ? Math.min(1, 256 / long) : 1;
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, w, h);
  let data: Uint8ClampedArray;
  try {
    data = ctx.getImageData(0, 0, w, h).data;
  } catch {
    return null; // tainted(理论不该发生:asset 协议带 CORS)
  }
  const hist = new Array<number>(256).fill(0);
  let sumR = 0, sumG = 0, sumB = 0, n = 0;
  const lumaCoef = [0.213, 0.715, 0.072];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 8) continue;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const l = lumaCoef[0] * r + lumaCoef[1] * g + lumaCoef[2] * b;
    hist[Math.min(255, Math.round(l))]++;
    sumR += r; sumG += g; sumB += b; n++;
  }
  if (n === 0) return null;
  const total = n;
  const percentile = (q: number): number => {
    const target = total * q;
    let acc = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= target) return v / 255;
    }
    return 1;
  };
  return {
    p2: percentile(0.02),
    p98: percentile(0.98),
    meanR: sumR / n / 255,
    meanG: sumG / n / 255,
    meanB: sumB / n / 255,
  };
}

/** 有参数且非默认(决定 AVIF 兜底是否走套参路径)。 */
export function hasActiveAdjust(params: AdjustParams | null): boolean {
  return !!params && !isDefaultAdjustParams(params);
}
