import { DominantColor } from '../types';

/** 带 LAB 的完整色值（跨端传参加工前的中间形态） */
export interface DominantColorWithLab extends DominantColor {
  labL: number;
  labA: number;
  labB: number;
  percentage: number;
}

/**
 * 从 Canvas ImageData 中提取主色调（频率统计 + 5 位量化）。
 *
 * 最初是 `api/tauri-bridge/thumbnail.ts` 里 AVIF 回落路径的私有函数；视频抽帧（P1.5）
 * 要复用同一套口径，故抽到此处共享，避免两份实现出现色差。
 */
export function extractColorsFromImageData(data: Uint8ClampedArray, count: number): DominantColorWithLab[] {
  const colorMap: Record<string, number> = {};
  const step = 4 * 4; // 步进抽样提高性能

  for (let i = 0; i < data.length; i += step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 128) continue; // 忽略透明像素

    // 简单的颜色量化，减少 key 数量 (每 8 位取高 5 位)
    const qr = r & 0xF8;
    const qg = g & 0xF8;
    const qb = b & 0xF8;
    const key = `${qr},${qg},${qb}`;
    colorMap[key] = (colorMap[key] || 0) + 1;
  }

  const sorted = Object.entries(colorMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);

  return sorted.map(([key, _]) => {
    const [r, g, b] = key.split(',').map(Number);
    const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');

    const { l, a, b: lab_b } = rgbToLab(r, g, b);

    const rgb: [number, number, number] = [r, g, b];
    const isDark = (r * 0.299 + g * 0.587 + b * 0.114) < 128; // 感知亮度阈值

    return { hex, rgb, isDark, labL: l, labA: a, labB: lab_b, percentage: 0 };
  });
}

/** 简化的 RGB -> LAB 转换 */
export function rgbToLab(r: number, g: number, b: number) {
  let rf = r / 255, gf = g / 255, bf = b / 255;
  rf = rf > 0.04045 ? Math.pow((rf + 0.055) / 1.055, 2.4) : rf / 12.92;
  gf = gf > 0.04045 ? Math.pow((gf + 0.055) / 1.055, 2.4) : gf / 12.92;
  bf = bf > 0.04045 ? Math.pow((bf + 0.055) / 1.055, 2.4) : bf / 12.92;

  let x = (rf * 0.4124 + gf * 0.3576 + bf * 0.1805) * 100;
  let y = (rf * 0.2126 + gf * 0.7152 + bf * 0.0722) * 100;
  let z = (rf * 0.0193 + gf * 0.1192 + bf * 0.9505) * 100;

  x /= 95.047; y /= 100.0; z /= 108.883;
  x = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + (16 / 116);
  y = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + (16 / 116);
  z = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + (16 / 116);

  return { l: (116 * y) - 16, a: 500 * (x - y), b: 200 * (y - z) };
}

/** 计算一段 RGBA 像素的平均感知亮度（0~255），用于识别「近黑帧」 */
export function averageLuma(data: Uint8ClampedArray): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += 4 * 4) {
    sum += data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114;
    n++;
  }
  return n === 0 ? 0 : sum / n;
}
