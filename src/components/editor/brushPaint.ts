/**
 * 画笔的**纯函数**面：图章几何、颜色→灰度、作画目标的坐标变换。
 * 无 DOM / canvas 依赖，全部可单测（canvas 绘制本体在 useEditorBrush，jsdom 不可测）。
 *
 * 作画坐标系的拍板（设计稿画笔轮）：笔径是**文档像素**，图章永远画在**文档坐标**，
 * 由 canvas 变换矩阵换算进目标像素缓冲——`ctx.setTransform(target.transform)` 后
 * 画圆即可，图层带旋转/缩放时笔触自动跟着变椭圆落在正确的像素上。
 */
import type { EditorLayer } from '../../types';
import { composeMatrix, invertAffine, multiplyAffine, type AffineMatrix } from './layerTransform';

/** 相邻图章的间距 = 笔径 × 25%（PS 的默认间距口径）。 */
export const BRUSH_SPACING_RATIO = 0.25;

/**
 * `[` / `]` 调笔径的步长（PS 口径的分段：小笔细调、大笔粗调）。
 * ≤10 时 ±1，≤50 时 ±5，再往上 ±10。
 */
export function brushSizeStep(size: number): number {
  if (size <= 10) return 1;
  if (size <= 50) return 5;
  return 10;
}

/** 笔径 + 方向步进，钳在 1..300（选项条的同一范围）。 */
export function nextBrushSize(size: number, dir: 1 | -1): number {
  return Math.min(300, Math.max(1, Math.round(size + dir * brushSizeStep(size))));
}

export interface StampPoint {
  x: number;
  y: number;
}

/**
 * 沿折线按固定间距取图章点：首点必取，中间按弧长插值。
 *
 * `final = true`（抬笔时）额外强制补终点——最后一段不足一个间距也要封口，不然
 * 快速甩笔的尾巴缺一角。**绘制期间必须用 `final = false`**：等距序列是前缀稳定
 * 的（第 n 个图章永远落在 n×间距的弧长处），增量绘制只画尾巴才成立；强制终点
 * 会把"当前笔尖"硬塞进序列末尾，下一段一来它就换了位置，尾巴就漏画了。
 */
export function strokeStamps(points: StampPoint[], size: number, final = false): StampPoint[] {
  if (points.length === 0) return [];
  const spacing = Math.max(1, size * BRUSH_SPACING_RATIO);
  const out: StampPoint[] = [{ x: points[0].x, y: points[0].y }];
  let lastStampAt = 0; // 上一个图章在折线上的累计弧长
  let walked = 0; // 当前段末端的累计弧长
  for (let i = 1; i < points.length; i += 1) {
    const ax = points[i - 1].x;
    const ay = points[i - 1].y;
    const dx = points[i].x - ax;
    const dy = points[i].y - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) continue;
    walked += len;
    while (walked - lastStampAt >= spacing) {
      lastStampAt += spacing;
      const into = lastStampAt - (walked - len); // 该图章落在当前段内的距离
      const t = into / len;
      out.push({ x: ax + dx * t, y: ay + dy * t });
    }
  }
  if (!final) return out;
  const last = points[points.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last.x - tail.x, last.y - tail.y) > 1e-9) {
    out.push({ x: last.x, y: last.y });
  }
  return out;
}

/** 像素补丁的矩形（目标缓冲坐标，整数，已夹进缓冲范围）。 */
export interface DirtyRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 一笔的**脏矩形**（撤销补丁只存这一块，不存整层）：图章的外接框（文档坐标，
 * 半径外扩——径向渐变的羽化也到 r）经 `transform`（文档 → 目标缓冲）映射后
 * 取整数外接、夹进缓冲范围。整笔都画在缓冲外 → null（撤销步也不进栈）。
 */
export function strokeDirtyRect(
  stamps: StampPoint[],
  radius: number,
  transform: AffineMatrix,
  bufferWidth: number,
  bufferHeight: number,
): DirtyRect | null {
  if (stamps.length === 0 || bufferWidth <= 0 || bufferHeight <= 0) return null;
  const pad = radius + 1; // +1：羽化边缘的插值与半像素
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of stamps) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  // 文档空间外接框的四个角映射进目标缓冲（变换含旋转时角点法最稳）
  const [a, b, c, d, e, f] = transform;
  const corners: StampPoint[] = [
    { x: minX - pad, y: minY - pad },
    { x: maxX + pad, y: minY - pad },
    { x: minX - pad, y: maxY + pad },
    { x: maxX + pad, y: maxY + pad },
  ];
  let bx0 = Infinity;
  let by0 = Infinity;
  let bx1 = -Infinity;
  let by1 = -Infinity;
  for (const q of corners) {
    const x = q.x * a + q.y * c + e;
    const y = q.x * b + q.y * d + f;
    if (x < bx0) bx0 = x;
    if (y < by0) by0 = y;
    if (x > bx1) bx1 = x;
    if (y > by1) by1 = y;
  }
  const x = Math.max(0, Math.floor(bx0));
  const y = Math.max(0, Math.floor(by0));
  const x1 = Math.min(bufferWidth - 1, Math.ceil(bx1));
  const y1 = Math.min(bufferHeight - 1, Math.ceil(by1));
  if (x1 < x || y1 < y) return null;
  return { x, y, w: x1 - x + 1, h: y1 - y + 1 };
}

/**
 * 颜色 → 灰度（0..255）。系数与 Rust `imaging::mask` 的 sRGB 亮度同款
 * （0.2126/0.7152/0.0722）——画蒙版时前端画的灰值与导出侧读出的亮度必须一致。
 * 非法输入按 255（白）处理：宁可全显示也不把图层弄没。
 */
export function colorLuminance(hex: string): number {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 255;
  const n = Number.parseInt(m[1], 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
}

/** 灰度 → `#rrggbb`（等值灰，选项条/面板显示"当前会画出的灰"用）。 */
export function luminanceToHex(value: number): string {
  const v = Math.min(255, Math.max(0, Math.round(value)));
  const hex = v.toString(16).padStart(2, '0');
  return `#${hex}${hex}${hex}`;
}

/** 作画目标：像素缓冲尺寸 + 文档坐标 → 缓冲坐标的仿射（喂 `ctx.setTransform`）。 */
export interface PaintTarget {
  kind: 'layer' | 'mask';
  width: number;
  height: number;
  transform: AffineMatrix;
}

/**
 * 算作画目标。返回 null = 画不进去（调用方给提示）：
 * - 图层本体：无 source（组行）、图层矩阵退化（被压成线）；
 * - 蒙版：没有蒙版 / 蒙版被停用 / 矩阵退化。
 *
 * 三种坐标换算（与渲染侧 `maskShellSpec` / `EditorCanvasLayers` 同一套数学）：
 * - 图层本体：`inv(M_layer)`；
 * - **链接**蒙版：`scale(蒙版自然/图层自然) ∘ inv(M_layer)`——链接语义 = 蒙版
 *   拉伸铺满图层内容框，画在"图层内容比例"位置再缩到蒙版自己的像素格；
 * - **解链**蒙版：`inv(M_mask)`。
 */
export function paintTargetOf(layer: EditorLayer, target: 'image' | 'mask'): PaintTarget | null {
  const mask = layer.mask;
  if (target === 'mask') {
    if (!mask || mask.disabled || mask.naturalWidth <= 0 || mask.naturalHeight <= 0) return null;
    if (mask.box) {
      const invMask = invertAffine(
        composeMatrix(mask.box, { width: mask.naturalWidth, height: mask.naturalHeight }),
      );
      return invMask
        ? { kind: 'mask', width: mask.naturalWidth, height: mask.naturalHeight, transform: invMask }
        : null;
    }
    const invLayer = invertAffine(
      composeMatrix(layer.box, { width: layer.naturalWidth, height: layer.naturalHeight }),
    );
    if (!invLayer || layer.naturalWidth <= 0 || layer.naturalHeight <= 0) return null;
    const sx = mask.naturalWidth / layer.naturalWidth;
    const sy = mask.naturalHeight / layer.naturalHeight;
    return {
      kind: 'mask',
      width: mask.naturalWidth,
      height: mask.naturalHeight,
      transform: multiplyAffine([sx, 0, 0, sy, 0, 0], invLayer),
    };
  }
  if (!layer.source || layer.naturalWidth <= 0 || layer.naturalHeight <= 0) return null;
  const invLayer = invertAffine(
    composeMatrix(layer.box, { width: layer.naturalWidth, height: layer.naturalHeight }),
  );
  return invLayer
    ? {
        kind: 'layer',
        width: layer.naturalWidth,
        height: layer.naturalHeight,
        transform: invLayer,
      }
    : null;
}
