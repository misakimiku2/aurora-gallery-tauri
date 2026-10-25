/**
 * 工具交互的纯函数层:拖拽几何、选区模式、取色。
 * 画布指针交互(EditorCanvas)只做坐标采集与提交,数学全部在这里(可单测)。
 * 修饰键时序照 photocraft 上游口径(canvas.rs Drag::marquee_mods / tool_feedback selection_mode):
 * - 按下时就按住的修饰键 → 选区运算模式(Shift 添加 / Alt 减去 / Shift+Alt 相交),
 *   直到松开并再次按下为止不做形状约束;
 * - 拖拽中途才新按下的修饰键(fresh)→ 形状约束(Shift 正方形 / Alt 从中心)。
 */
import type { ToolOptions } from './editorStore';

export interface DragPoint {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 拖拽手势的修饰键跟踪(live=现在按着;press=按下时按着;released=按下后松开过)。 */
export interface DragMods {
  pressShift: boolean;
  pressAlt: boolean;
  liveShift: boolean;
  liveAlt: boolean;
  releasedShift: boolean;
  releasedAlt: boolean;
}

export function initialMods(shift: boolean, alt: boolean): DragMods {
  return { pressShift: shift, pressAlt: alt, liveShift: shift, liveAlt: alt, releasedShift: false, releasedAlt: false };
}

/** 每个 pointer 事件后更新:live 跟随当前,松开过的记下来(再按时变"新按")。 */
export function trackMods(m: DragMods, shift: boolean, alt: boolean): DragMods {
  return {
    ...m,
    liveShift: shift,
    liveAlt: alt,
    releasedShift: m.releasedShift || (m.pressShift && !shift),
    releasedAlt: m.releasedAlt || (m.pressAlt && !alt),
  };
}

/** 上游 Drag::marquee_mods 的 fresh 判定:现在按着,且(按下时没按 或 松开过)= 拖拽中新按。 */
function fresh(now: boolean, atPress: boolean, released: boolean): boolean {
  return now && (!atPress || released);
}

/** 拖拽中的形状约束:正方形 / 从中心。 */
export function constraintMods(m: DragMods): { square: boolean; fromCenter: boolean } {
  return {
    square: fresh(m.liveShift, m.pressShift, m.releasedShift),
    fromCenter: fresh(m.liveAlt, m.pressAlt, m.releasedAlt),
  };
}

/** Alt 从中心:把起点反射到对侧(起点为圆心,终点定另一半)。 */
export function reflectFromCenter(d: DragPoint): DragPoint {
  return { x0: 2 * d.x0 - d.x1, y0: 2 * d.y0 - d.y1, x1: d.x1, y1: d.y1 };
}

/** Shift 约束:以起点为角的正方形(取 |dx|、|dy| 较大者,保方向)。 */
export function constrainSquare(d: DragPoint): DragPoint {
  const dx = d.x1 - d.x0;
  const dy = d.y1 - d.y0;
  const m = Math.max(Math.abs(dx), Math.abs(dy));
  return { x0: d.x0, y0: d.y0, x1: d.x0 + Math.sign(dx || 1) * m, y1: d.y0 + Math.sign(dy || 1) * m };
}

/** 拖拽几何 → 提交/预览用的矩形(先应用约束,再归一化取整);不足 1px 视为点击返回 null。 */
export function marqueeRect(d: DragPoint, mods: DragMods): { x: number; y: number; w: number; h: number } | null {
  let p: DragPoint = d;
  const { square, fromCenter } = constraintMods(mods);
  if (fromCenter) p = reflectFromCenter(p);
  if (square) p = constrainSquare(p);
  const x = Math.round(Math.min(p.x0, p.x1));
  const y = Math.round(Math.min(p.y0, p.y1));
  const w = Math.round(Math.max(p.x0, p.x1)) - x;
  const h = Math.round(Math.max(p.y0, p.y1)) - y;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
}

/** 按下时的修饰键 → select.rect 的 mode(Photoshop:Shift 添加,Alt 减去,Shift+Alt 相交)。 */
export function selectMode(shift: boolean, alt: boolean): 'replace' | 'add' | 'subtract' | 'intersect' {
  if (shift && alt) return 'intersect';
  if (shift) return 'add';
  if (alt) return 'subtract';
  return 'replace';
}

/** 上游 tool_feedback::document_selection_mode 的口径:无现有选区时,减去/相交落回新选区。 */
export function effectiveMode(mode: 'replace' | 'add' | 'subtract' | 'intersect', hasSelection: boolean): 'replace' | 'add' | 'subtract' | 'intersect' {
  return !hasSelection && (mode === 'subtract' || mode === 'intersect') ? 'replace' : mode;
}

/** 拖拽结束 → select.rect 参数;点击(近零位移)返回 null(调用方走 deselect)。 */
export function marqueeParams(
  r: { x: number; y: number; w: number; h: number },
  opts: ToolOptions,
  mode: 'replace' | 'add' | 'subtract' | 'intersect',
): Record<string, unknown> {
  return {
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    ellipse: opts.marqueeShape === 'ellipse',
    mode,
    antiAlias: opts.antiAlias,
    feather: opts.feather,
  };
}

/** 任意拖拽矩形归一化(套索等后续工具也用);不足 1px 返回 null。 */
export function normalizeRect(d: DragPoint): { x: number; y: number; w: number; h: number } | null {
  const x = Math.round(Math.min(d.x0, d.x1));
  const y = Math.round(Math.min(d.y0, d.y1));
  const w = Math.round(Math.max(d.x0, d.x1)) - x;
  const h = Math.round(Math.max(d.y0, d.y1)) - y;
  if (w < 1 || h < 1) return null;
  return { x, y, w, h };
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

/** 工具单键快捷键(输入框聚焦时不触发,由调用方过滤)。M 键不在表内:选框组内循环,由画布层处理。 */
export const TOOL_KEYS: Record<string, string> = {
  v: 'move', l: 'lasso', c: 'crop', i: 'eyedropper',
  b: 'brush', e: 'eraser', g: 'gradient', k: 'bucket',
  r: 'blur', u: 'sharpen', s: 'smudge', h: 'hand', z: 'zoom',
};

/**
 * 边界段串接成连续折线(蚂蚁线的虚线必须沿连续路径跑:canvas 的 setLineDash 在每个
 * moveTo 子路径重置相位,离散的 1-2px 台阶段会全部显示为实线,只有长段才是虚线)。
 * 输入 outline 段集 [x0,y0,x1,y1]…,输出若干条折线的扁平点列 [x0,y0,x1,y1,…];
 * mask 边界段首尾相接(闭合环),接龙自然还原;文档边缘等开放端走到无路即停。
 */
export function chainSegments(segs: number[][]): number[][] {
  const key = (x: number, y: number) => `${x},${y}`;
  const adj = new Map<string, number[][]>();
  const push = (k: string, s: number[]) => {
    const list = adj.get(k);
    if (list) list.push(s);
    else adj.set(k, [s]);
  };
  for (const s of segs) {
    const a = key(s[0], s[1]);
    const b = key(s[2], s[3]);
    push(a, s);
    if (a !== b) push(b, s);
  }
  const used = new Set<number[]>();
  const otherEnd = (s: number[], x: number, y: number): [number, number] =>
    s[0] === x && s[1] === y ? [s[2], s[3]] : [s[0], s[1]];
  const polys: number[][] = [];
  for (const start of segs) {
    if (used.has(start)) continue;
    used.add(start);
    const pts: number[] = [start[0], start[1], start[2], start[3]];
    for (const dir of [0, 1]) {
      for (;;) {
        const ex = dir === 0 ? pts[pts.length - 2] : pts[0];
        const ey = dir === 0 ? pts[pts.length - 1] : pts[1];
        const next = (adj.get(key(ex, ey)) ?? []).find((s) => !used.has(s));
        if (!next) break;
        used.add(next);
        const [ox, oy] = otherEnd(next, ex, ey);
        if (dir === 0) pts.push(ox, oy);
        else pts.unshift(ox, oy);
      }
    }
    polys.push(pts);
  }
  return polys;
};
