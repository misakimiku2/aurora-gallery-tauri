/**
 * 工具交互的纯函数层:拖拽几何、选区模式、取色。
 * 画布指针交互(EditorCanvas)只做坐标采集与提交,数学全部在这里(可单测)。
 */
import type { ToolOptions } from './editorStore';

export interface DragPoint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  /** pointerdown 时的修饰键(Photoshop:按下时决定新选区的运算模式)。 */
  shift?: boolean;
  alt?: boolean;
}

/** Shift 约束:以起点为角的正方形(取 |dx|、|dy| 较大者,保方向)。 */
export function constrainSquare(d: DragPoint): DragPoint {
  const dx = d.x1 - d.x0;
  const dy = d.y1 - d.y0;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x0: d.x0, y0: d.y0, x1: d.x0 + Math.sign(dx || 1) * m, y1: d.y0 + Math.sign(dy || 1) * m };
}

/** 归一化为整数 x/y/w/h;宽或高不足 1px 视为点击,返回 null。 */
export function normalizeRect(d: DragPoint): { x: number; y: number; w: number; h: number } | null {
  const x = Math.round(Math.min(d.x0, d.x1));
  const y = Math.round(Math.min(d.y0, d.y1));
  const w = Math.round(Math.max(d.x0, d.x1)) - x;
  const h = Math.round(Math.max(d.y0, d.y1)) - y;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}

/** 修饰键 → select.rect 的 mode(Photoshop:Shift 添加,Alt 减去,Shift+Alt 相交)。 */
export function selectMode(shift: boolean, alt: boolean): 'replace' | 'add' | 'subtract' | 'intersect' {
  if (shift && alt) return 'intersect';
  if (shift) return 'add';
  if (alt) return 'subtract';
  return 'replace';
}

/** 拖拽结束 → select.rect 参数;点击(近零位移)返回 null(调用方走 deselect)。 */
export function marqueeParams(d: DragPoint, opts: ToolOptions): Record<string, unknown> | null {
  const r = normalizeRect(d);
  if (!r) return null;
  return {
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    ellipse: opts.marqueeShape === 'ellipse',
    mode: selectMode(d.shift ?? false, d.alt ?? false),
    antiAlias: opts.antiAlias,
    feather: opts.feather,
  };
}

/** 文档坐标 → 离屏位图像素坐标(rasterScale<1 为大图降采样保护)。 */
export function docToRaster(docX: number, docY: number, rasterScale: number): { px: number; py: number } {
  return { px: Math.floor(docX * rasterScale), py: Math.floor(docY * rasterScale) };
}

/** 取色 → #rrggbb;越界(画布外)返回 null。 */
export function sampleHex(
  ctx: CanvasRenderingContext2D,
  docX: number,
  docY: number,
  rasterScale: number,
): string | null {
  const { px, py } = docToRaster(docX, docY, rasterScale);
  if (px < 0 || py < 0 || px >= ctx.canvas.width || py >= ctx.canvas.height) return null;
  const [r, g, b] = ctx.getImageData(px, py, 1, 1).data;
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** 蚂蚁线形状:引擎只回 selectionBounds,矩形/椭圆形状由工具交互侧补记。 */
export interface SelectionShape {
  kind: 'rect' | 'ellipse';
  /** 与 selectionBounds 同口径的外接矩形 [x,y,w,h]。 */
  rect: [number, number, number, number];
}

/** shape 与引擎 bounds 完全一致时才可信(undo/全选/反选后退回 bounds 框)。 */
export function shapeMatchesBounds(
  shape: SelectionShape | null,
  bounds: [number, number, number, number] | null | undefined,
): shape is SelectionShape {
  if (!shape || !bounds) return false;
  return shape.rect[0] === bounds[0] && shape.rect[1] === bounds[1] && shape.rect[2] === bounds[2] && shape.rect[3] === bounds[3];
}

/** 工具单键快捷键(输入框聚焦时不触发,由调用方过滤)。 */
export const TOOL_KEYS: Record<string, string> = {
  v: 'move', m: 'marquee', l: 'lasso', c: 'crop', i: 'eyedropper',
  b: 'brush', e: 'eraser', g: 'gradient', k: 'bucket',
  r: 'blur', u: 'sharpen', s: 'smudge', h: 'hand', z: 'zoom',
};
