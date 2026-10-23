/**
 * 图层定界框 ↔ 仿射矩阵的换算——纯函数，无 React / DOM 依赖，可单测。
 *
 * 设计依据：《图片编辑-最小图层模型设计》§3。
 *
 * ## 为什么是"定界框存、矩阵算"
 *
 * 存定界框（`x/y/w/h/rotation/flip/skew`）是因为：面板要显示的正是这些数、八向控制点
 * 拖动直接改 `w/h`、以及要复用的 comparer `EditOverlay` 本就是这套字段。
 * 渲染时转成一个仿射矩阵，是为了让**两端用同一组数**——前端把它喂 CSS `matrix()`，
 * Rust 拿它做逆映射重采样，谁都不再自己从 rotation/flip 推导。
 *
 * 这一条是架构事实第 1、3 条的反向应用：调色被迫把公式写成两份再用单测锁死；
 * 变换干脆不写两份，直接传同一组六参，"两端顺序不一致"这整类 bug 从根上消失。
 */
import type { LayerBox } from '../../types';

/** CSS 与 Rust 同序的 `matrix(a,b,c,d,e,f)`：`x' = a·x + c·y + e`，`y' = b·x + d·y + f`。 */
export type AffineMatrix = [number, number, number, number, number, number];

export interface Size {
  width: number;
  height: number;
}

const DEG = Math.PI / 180;

/** 归一化到 [0, 360)，免得连点几次旋转之后角度变成 720 这种数。 */
export function normalizeDegrees(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/**
 * 定界框 + 内容自然尺寸 → 仿射矩阵。
 *
 * 变换链（从内容坐标到画布坐标）：
 *
 * ```
 * T(-nw/2, -nh/2)  →  S(sx, sy)（含翻转的负缩放）  →  K(skew)  →  R(rotation)  →  T(x + w/2, y + h/2)
 * ```
 *
 * 旋转中心是**定界框中心**（PS 行为），不是左上角。
 */
export function composeMatrix(
  box: LayerBox,
  natural: Size,
): AffineMatrix {
  const nw = natural.width;
  const nh = natural.height;
  const sx = nw > 0 ? ((box.flipH ? -1 : 1) * box.w) / nw : 0;
  const sy = nh > 0 ? ((box.flipV ? -1 : 1) * box.h) / nh : 0;

  const rad = box.rotation * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const kx = Math.tan(box.skewX * DEG);
  const ky = Math.tan(box.skewY * DEG);

  // 线性部分 L = R · K · S
  const a = sx * (cos - sin * ky);
  const c = sy * (cos * kx - sin);
  const b = sx * (sin + cos * ky);
  const d = sy * (sin * kx + cos);

  // 平移：把内容中心先搬回原点，再搬到定界框中心
  const e = box.x + box.w / 2 - (a * nw + c * nh) / 2;
  const f = box.y + box.h / 2 - (b * nw + d * nh) / 2;

  return [a, b, c, d, e, f];
}

/** 六参 → CSS `matrix(...)` 字符串。 */
export function toCssMatrix(m: AffineMatrix): string {
  return `matrix(${m[0]}, ${m[1]}, ${m[2]}, ${m[3]}, ${m[4]}, ${m[5]})`;
}

/**
 * 用矩阵变换一个点（与 CSS 同一套语义）。
 *
 * 当前只有单测在用（验证六参的语义正确）；生产端由浏览器 CSS 与 Rust `warp_affine`
 * 各自执行，不需要在 JS 里逐点算。
 */
export function applyMatrix(m: AffineMatrix, x: number, y: number): { x: number; y: number } {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

/**
 * 点是否落在**旋转后的定界框**内（画布坐标系）。
 *
 * 把点反旋到框的本地坐标再比矩形——翻转不改变占位，所以不用管 flip。
 * 用途：移动工具下判断"这一下点在图层上还是画布空白处"，前者选中、后者取消选中。
 */
export function pointInBox(box: LayerBox, px: number, py: number): boolean {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rad = -box.rotation * DEG;
  const dx = px - cx;
  const dy = py - cy;
  const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
  return Math.abs(lx) <= box.w / 2 && Math.abs(ly) <= box.h / 2;
}

/**
 * 旋转后的包围盒。
 *
 * ⚠️ **当前只有单测在用**（含与 v1 `rotateCropRect` 的交叉验证）。生产端的吸附走
 * comparer 的 `getRotatedAABB`，命中判定走本文件的 `pointInBox`——不要把这里当成
 * "已经在跑的吸附实现"。留着是因为它是那两组等价关系的对照物。
 *
 * `w/h` 本身是**未旋转**的内容尺寸。
 */
export function layerAABB(box: LayerBox): {
  l: number;
  t: number;
  r: number;
  b: number;
  cx: number;
  cy: number;
  width: number;
  height: number;
} {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const rad = box.rotation * DEG;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const hw = box.w / 2;
  const hh = box.h / 2;

  const xs: number[] = [];
  const ys: number[] = [];
  for (const [dx, dy] of [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ] as const) {
    xs.push(cx + (dx * cos - dy * sin));
    ys.push(cy + (dx * sin + dy * cos));
  }

  const l = Math.min(...xs);
  const r = Math.max(...xs);
  const t = Math.min(...ys);
  const b = Math.max(...ys);
  return { l, t, r, b, cx, cy, width: r - l, height: b - t };
}

/**
 * **画布级**旋转 90°：画布宽高互换 + 每个图层定界框换算（§5.1）。
 *
 * 这是"一次性换算"，不是持久的文档级 rotation 字段——算完之后状态自描述：
 * 画布就是 H×W，图层就以新角度摆在上面。屏幕上始终只有一个角度可读。
 *
 * 顺时针的点映射：`(px,py) → (H - py, px)`；逆时针是其反函数。
 *
 * ⚠️ **`w/h` 保持不变，只映射中心**。定界框里的 `w/h` 是**未旋转的内容尺寸**，
 * 旋转后"看起来变高变宽"是 `rotation` 带来的包围盒效果，不是尺寸变了。
 * 早期版本在这里交换了 `w/h`，等于把内容凭空拉伸一次——`composeMatrix` 的
 * `sx = w/naturalW` 立刻变成非等比缩放，表现为「转一下就变形」。
 * （v1 的 `rotateCropRect` 确实交换 `w/h`，但那是**轴对齐矩形**的语义，不是定界框。）
 *
 * `skew ≠ 0` 时这个换算是精确的（矩阵层面无损失）；skew 只在最小模型里存、
 * 不接 UI——见设计稿 §10 第 3 条。
 */
export function rotateDocumentCanvas<T extends LayerBox>(
  canvas: Size,
  layers: T[],
  clockwise: boolean,
): { canvas: Size; layers: T[] } {
  const { width: W, height: H } = canvas;
  const delta = clockwise ? 90 : -90;

  return {
    canvas: { width: H, height: W },
    layers: layers.map(box => {
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      // 中心映射：顺时针 (cx,cy) → (H−cy, cx)；逆时针 → (cy, W−cx)
      const ncx = clockwise ? H - cy : cy;
      const ncy = clockwise ? cx : W - cx;
      return {
        ...box,
        x: ncx - box.w / 2,
        y: ncy - box.h / 2,
        rotation: normalizeDegrees(box.rotation + delta),
      };
    }),
  };
}

/**
 * **画布级**翻转：画布尺寸不变，每个图层按对称边映射（§5.1 同源）。
 *
 * 镜像会翻转手性，所以 `rotation` 与 `skew` 一并取反。
 */
export function flipDocumentCanvas<T extends LayerBox>(
  canvas: Size,
  layers: T[],
  horizontal: boolean,
  vertical: boolean,
): { canvas: Size; layers: T[] } {
  return {
    canvas: { ...canvas },
    layers: layers.map(box => ({
      ...box,
      x: horizontal ? canvas.width - box.x - box.w : box.x,
      y: vertical ? canvas.height - box.y - box.h : box.y,
      rotation: horizontal || vertical ? normalizeDegrees(-box.rotation) : box.rotation,
      skewX: horizontal || vertical ? -box.skewX : box.skewX,
      skewY: horizontal || vertical ? -box.skewY : box.skewY,
    })),
  };
}
