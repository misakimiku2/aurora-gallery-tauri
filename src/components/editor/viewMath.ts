/** 视图变换纯函数:文档像素坐标 ↔ 画布 CSS 像素。screen = doc * scale + o */

export interface ViewTransform {
  scale: number;
  ox: number;
  oy: number;
}

export const ZOOM_MIN = 0.005;
export const ZOOM_MAX = 32;
export const ZOOM_STEP = 1.1;

export const clampScale = (s: number): number => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s));

export function docToScreen(v: ViewTransform, x: number, y: number): [number, number] {
  return [x * v.scale + v.ox, y * v.scale + v.oy];
}

export function screenToDoc(v: ViewTransform, sx: number, sy: number): [number, number] {
  return [(sx - v.ox) / v.scale, (sy - v.oy) / v.scale];
}

/** 绕屏幕点 (sx,sy) 缩放 factor 倍(指针锚定缩放)。 */
export function zoomAbout(v: ViewTransform, factor: number, sx: number, sy: number): ViewTransform {
  const scale = clampScale(v.scale * factor);
  const dx = (sx - v.ox) / v.scale;
  const dy = (sy - v.oy) / v.scale;
  return { scale, ox: sx - dx * scale, oy: sy - dy * scale };
}

/** 适配视口:整幅文档可见并居中。 */
export function fitToView(docW: number, docH: number, viewW: number, viewH: number, padding = 32): ViewTransform {
  const scale = clampScale(Math.min((viewW - padding * 2) / docW, (viewH - padding * 2) / docH));
  return { scale, ox: (viewW - docW * scale) / 2, oy: (viewH - docH * scale) / 2 };
}

/** 100% 显示并居中。 */
export function actualPixels(docW: number, docH: number, viewW: number, viewH: number): ViewTransform {
  return { scale: 1, ox: (viewW - docW) / 2, oy: (viewH - docH) / 2 };
}

export const clampPan = (v: ViewTransform, docW: number, docH: number, viewW: number, viewH: number): ViewTransform => {
  // 不许把文档完全拖出视野:文档任一角至多贴到视口对边
  const w = docW * v.scale;
  const h = docH * v.scale;
  const margin = Math.max(200, Math.min(viewW, viewH) * 0.6);
  let { ox, oy } = v;
  if (w + ox < margin) ox = margin - w;
  if (ox > viewW - margin) ox = viewW - margin;
  if (h + oy < margin) oy = margin - h;
  if (oy > viewH - margin) oy = viewH - margin;
  return { scale: v.scale, ox, oy };
};
