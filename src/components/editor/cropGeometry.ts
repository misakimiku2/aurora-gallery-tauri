/**
 * 裁剪框的几何计算（纯函数，无 React / DOM 依赖，可单测）。
 *
 * 抽出来的理由：比例约束的数学很容易写错，而错了以后**看起来是对的**——
 * 框还是能拖、数字还是在变，只是拖出来的比例差了零点几，或者在靠近边界时
 * 悄悄把比例拧歪。这类错误肉眼几乎看不出来，靠单测锁。
 *
 * 坐标一律是**画布像素**（v2 里画布坐标 = 文档坐标，不再是"源图像素 × 代理倍率"）。
 *
 * ## 文件里的两套函数
 *
 * - **在用**：`normalizeRect` / `clampNumber` / `computeRatioRect` —— 裁剪框的比例约束。
 * - **v1 遗留**：`rotateCropRect` / `flipCropRect`。v2 的旋转/翻转走
 *   `layerTransform.rotateDocumentCanvas`（只映射中心、不换 w/h），不再需要它们。
 *   保留是因为它们仍是**新实现的黄金标准**：`layerTransform.spec.ts` 用
 *   "定界框旋转后的包围盒 == v1 矩形" 做交叉验证。别删，也别在新的生产路径里用。
 */

export interface CropArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CropHandle = 'n' | 's' | 'w' | 'e' | 'nw' | 'ne' | 'sw' | 'se';

export const clampNumber = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

const roundRect = (r: CropArea): CropArea => ({
  x: Math.round(r.x),
  y: Math.round(r.y),
  w: Math.round(r.w),
  h: Math.round(r.h),
});

/** 把矩形规整成非负宽高（自由裁剪时鼠标往左上拖会产生负值）。 */
export function normalizeRect(a: CropArea): CropArea {
  const x = Math.min(a.x, a.x + a.w);
  const y = Math.min(a.y, a.y + a.h);
  return { x, y, w: Math.abs(a.w), h: Math.abs(a.h) };
}

/**
 * 在比例约束下求新的裁剪矩形。
 *
 * - `mode === 'new'`：从 `start` 往 `cur` 的方向拉框
 * - 角把手：锚定**对角点**，按「更大的一边」定尺寸
 * - 边把手：主维度变化，另一维以框中心对称扩展（PS 手感）
 *
 * 全程保证不越出画布；越界时**按比例收缩**而不是各自截断——否则比例会被拧歪。
 */
export function computeRatioRect(
  mode: 'new' | CropHandle,
  start: { x: number; y: number },
  cur: { x: number; y: number },
  origin: CropArea,
  ratio: number,
  docWidth: number,
  docHeight: number,
): CropArea {
  if (mode === 'new') {
    const goingRight = cur.x >= start.x;
    const goingDown = cur.y >= start.y;
    const anchorX = clampNumber(start.x, 0, docWidth);
    const anchorY = clampNumber(start.y, 0, docHeight);

    // 从锚点出发两个方向各能走多远，再取「比例可行」的较小者
    const maxWByDir = goingRight ? docWidth - anchorX : anchorX;
    const maxHByDir = goingDown ? docHeight - anchorY : anchorY;
    const maxH = Math.min(maxHByDir, maxWByDir / ratio);
    const maxW = maxH * ratio;

    let w = Math.min(Math.abs(cur.x - start.x), maxW);
    let h = w / ratio;
    if (h > maxH) {
      h = Math.min(Math.abs(cur.y - start.y), maxH);
      w = h * ratio;
    }

    const x = goingRight ? anchorX : anchorX - w;
    const y = goingDown ? anchorY : anchorY - h;
    return roundRect({ x, y, w: Math.max(1, w), h: Math.max(1, h) });
  }

  // 角把手：锚定对角点
  if (mode.length === 2) {
    const dirX = mode.includes('e') ? 1 : -1;
    const dirY = mode.includes('s') ? 1 : -1;
    const anchorX = dirX > 0 ? origin.x : origin.x + origin.w;
    const anchorY = dirY > 0 ? origin.y : origin.y + origin.h;

    const maxW = dirX > 0 ? docWidth - anchorX : anchorX;
    const maxH = dirY > 0 ? docHeight - anchorY : anchorY;

    let w = Math.abs(cur.x - anchorX);
    let h = Math.abs(cur.y - anchorY);
    // 以更「大」的一边为准，避免鼠标斜向移动时框塌成一条线
    if (w / ratio > h) h = w / ratio;
    else w = h * ratio;
    // 越界按比例收缩
    if (w > maxW) {
      w = maxW;
      h = w / ratio;
    }
    if (h > maxH) {
      h = maxH;
      w = h * ratio;
    }

    const x = dirX > 0 ? anchorX : anchorX - w;
    const y = dirY > 0 ? anchorY : anchorY - h;
    return roundRect({ x, y, w: Math.max(1, w), h: Math.max(1, h) });
  }

  // 左右边：锚定对边，高度以框中心对称扩展
  if (mode === 'e' || mode === 'w') {
    const anchorX = mode === 'e' ? origin.x : origin.x + origin.w;
    const maxW = mode === 'e' ? docWidth - origin.x : origin.x + origin.w;
    let w = mode === 'e' ? cur.x - anchorX : anchorX - cur.x;
    w = clampNumber(w, 1, maxW);
    let h = w / ratio;
    if (h > docHeight) {
      h = docHeight;
      w = h * ratio;
    }
    const cy = origin.y + origin.h / 2;
    const y = clampNumber(cy - h / 2, 0, Math.max(0, docHeight - h));
    const x = mode === 'e' ? anchorX : anchorX - w;
    return roundRect({ x, y, w: Math.max(1, w), h: Math.max(1, h) });
  }

  // 上下边：锚定对边，宽度以框中心对称扩展
  const anchorY = mode === 's' ? origin.y : origin.y + origin.h;
  const maxH = mode === 's' ? docHeight - origin.y : origin.y + origin.h;
  let h = mode === 's' ? cur.y - anchorY : anchorY - cur.y;
  h = clampNumber(h, 1, maxH);
  let w = h * ratio;
  if (w > docWidth) {
    w = docWidth;
    h = w / ratio;
  }
  const cx = origin.x + origin.w / 2;
  const x = clampNumber(cx - w / 2, 0, Math.max(0, docWidth - w));
  const y = mode === 's' ? anchorY : anchorY - h;
  return roundRect({ x, y, w: Math.max(1, w), h: Math.max(1, h) });
}

/**
 * 把裁剪矩形换算到「顺时针旋转 90° 之后」的新坐标系。
 *
 * 为什么要转换：渲染顺序是 `rotate → flip → crop`，`crop` 是相对**当前可见坐标系**
 * 的矩形。用户点一次旋转，画面内容转了 90°，他仍然期望"还是我裁的那块内容"，
 * 所以矩形必须跟着转，否则会变成另一块区域。
 *
 * 顺时针 90° 的映射：源 (x,y) → 目标 (H-1-y, x)，矩形则
 * `x' = H - y - h, y' = x, w' = h, h' = w`（H 是**当前坐标系的像素高**）。
 * 逆时针就是它的反函数。
 */
export function rotateCropRect(
  crop: CropArea,
  currentWidth: number,
  currentHeight: number,
  clockwise: boolean,
): CropArea {
  return clockwise
    ? {
        x: currentHeight - crop.y - crop.h,
        y: crop.x,
        w: crop.h,
        h: crop.w,
      }
    : {
        x: crop.y,
        y: currentWidth - crop.x - crop.w,
        w: crop.h,
        h: crop.w,
      };
}

/**
 * 镜像时换算裁剪矩形（翻转不改尺寸，只把位置映射到对称边）。
 *
 * 可以同时水平和垂直，等价于 180° 旋转。
 */
export function flipCropRect(
  crop: CropArea,
  currentWidth: number,
  currentHeight: number,
  horizontal: boolean,
  vertical: boolean,
): CropArea {
  return {
    x: horizontal ? currentWidth - crop.x - crop.w : crop.x,
    y: vertical ? currentHeight - crop.y - crop.h : crop.y,
    w: crop.w,
    h: crop.h,
  };
}
