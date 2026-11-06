/**
 * 工具交互的纯函数层:拖拽几何、选区模式、取色。
 * 画布指针交互(EditorCanvas)只做坐标采集与提交,数学全部在这里(可单测)。
 * 修饰键时序照 photocraft 上游口径(canvas.rs Drag::marquee_mods / tool_feedback selection_mode):
 * - 按下时就按住的修饰键 → 选区运算模式(Shift 添加 / Alt 减去 / Shift+Alt 相交),
 *   直到松开并再次按下为止不做形状约束;
 * - 拖拽中途才新按下的修饰键(fresh)→ 形状约束(Shift 正方形 / Alt 从中心)。
 */
import type { EditorTool } from './editorTypes';
import type { ToolOptions } from './editorStore';
import { presetPaintParams } from './gradientPresets';

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
export type SelectionMode = 'replace' | 'add' | 'subtract' | 'intersect';
export function selectMode(shift: boolean, alt: boolean): SelectionMode {
  if (shift && alt) return 'intersect';
  if (shift) return 'add';
  if (alt) return 'subtract';
  return 'replace';
}

/**
 * 选区模式总解析(上游 tool_feedback::document_selection_mode 口径):
 * 按下时有修饰键 → 修饰键模式(空选区时减/交降级 replace,#1106);
 * 无修饰键 → 选项条显式模式(显式选了减/交则**保留**,不降级)。
 */
export function resolveSelectionMode(
  m: { pressShift: boolean; pressAlt: boolean },
  barMode: SelectionMode,
  hasSelection: boolean,
): SelectionMode {
  if (m.pressShift || m.pressAlt) return effectiveMode(selectMode(m.pressShift, m.pressAlt), hasSelection);
  return barMode;
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

/**
 * 单行/单列选框(select.rect 的 line:"row"|"column",历史名 Single Row/Column Marquee):
 * 整幅宽/高 × 1px;位置=释放点坐标取整钳进画布。点击即定位(PS 口径,不取消选择)。
 */
export function singleLineParams(
  shape: 'row' | 'column',
  pos: number,
  docW: number,
  docH: number,
  opts: ToolOptions,
  mode: 'replace' | 'add' | 'subtract' | 'intersect',
): Record<string, unknown> {
  const p = Math.round(pos);
  return shape === 'row'
    ? { x: 0, y: Math.min(docH - 1, Math.max(0, p)), width: docW, height: 1, line: 'row', mode, antiAlias: opts.antiAlias, feather: opts.feather }
    : { x: Math.min(docW - 1, Math.max(0, p)), y: 0, width: 1, height: docH, line: 'column', mode, antiAlias: opts.antiAlias, feather: opts.feather };
}

/** 选框组 M 键循环顺序(PS 口径:矩形→椭圆→单行→单列)。 */
export const MARQUEE_CYCLE = ['rect', 'ellipse', 'row', 'column'] as const;
export function nextMarqueeShape(shape: ToolOptions['marqueeShape']): ToolOptions['marqueeShape'] {
  const i = MARQUEE_CYCLE.indexOf(shape);
  return MARQUEE_CYCLE[(i + 1) % MARQUEE_CYCLE.length];
}

export function constrain45(from: [number, number], to: [number, number]): [number, number] {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return to;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + Math.cos(angle) * len, from[1] + Math.sin(angle) * len];
}

/**
 * 渐变提交参数(paint.gradient):from/to 文档坐标取整;stops 来自当前渐变
 * (gradientCurrent,含 "foreground"/"background" 活引用,引擎提交时按当前前景/背景解析)、
 * 透明度以 0..100 的 transparency 下发(apply_opacity 合并在引擎内);Shift 吸附 45° 方向
 * (长度不变);<2px 拖拽由调用方忽略。
 */
export function gradientParams(
  from: [number, number],
  to: [number, number],
  opts: ToolOptions,
  targetMask = false,
): Record<string, unknown> {
  const { stops, transparency } = presetPaintParams(opts.gradientCurrent);
  return {
    from: [Math.round(from[0]), Math.round(from[1])],
    to: [Math.round(to[0]), Math.round(to[1])],
    style: opts.gradientStyle,
    stops,
    ...(transparency ? { transparency } : {}),
    reverse: opts.gradientReverse,
    dither: opts.gradientDither,
    opacity: Math.max(1, Math.min(100, Math.round(opts.gradientOpacity * 100))),
    mode: opts.gradientBlend,
    ...(targetMask ? { target: 'mask' } : {}),
  };
}

/** 油漆桶提交参数(paint.bucket):容差 0..255,连续默认开;颜色=前景色。 */
export function bucketParams(
  x: number,
  y: number,
  opts: ToolOptions,
  foregroundHex: string,
  targetMask = false,
): Record<string, unknown> {
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    tolerance: Math.min(255, Math.max(0, Math.round(opts.tolerance))),
    contiguous: true,
    antiAlias: opts.antiAlias,
    contents: 'foreground',
    color: foregroundHex,
    opacity: Math.max(1, Math.min(100, Math.round(opts.brushOpacity * 100))),
    ...(targetMask ? { target: 'mask' } : {}),
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

/** 工具单键快捷键(输入框聚焦时不触发,由调用方过滤)。M/L/G/U 键不在表内:选框/套索/渐变/
 * 形状组内循环,由画布层处理。上游 Blur/Sharpen/Smudge 无单键(state.rs key()='\0'),我们
 * phase-1 曾自造 u→锐化,二期形状组要占用 U,锐化回上游口径(仅工具栏可达)。 */
export const TOOL_KEYS: Record<string, string> = {
  v: 'move', c: 'crop', i: 'eyedropper',
  b: 'brush', e: 'eraser',
  r: 'blur', s: 'smudge', h: 'hand', z: 'zoom',
};

/** 套索组工具(L 键循环,上游 Tool::Lasso/PolygonLasso/MagneticLasso 同键)。 */
export const LASSO_GROUP: ReadonlySet<EditorTool> = new Set(['lasso', 'polygonLasso', 'magneticLasso']);

/** L 键:组内循环到下一套索工具(自由→多边形→磁性→自由);当前不在组内 → 回自由套索。 */
export function nextLassoTool(current: EditorTool | undefined): EditorTool {
  if (current === 'lasso') return 'polygonLasso';
  if (current === 'polygonLasso') return 'magneticLasso';
  return 'lasso';
}

/** 渐变组工具(G 键循环,上游 Tool::Gradient|Tool::PaintBucket 同键 'G';我们旧版把油漆桶
 * 挂在 K 上是自造偏离,统一回 PS 口径)。 */
export const GRADIENT_GROUP: ReadonlySet<EditorTool> = new Set(['gradient', 'bucket']);

/** G 键:组内循环 渐变→油漆桶→渐变;当前不在组内 → 回渐变。 */
export function nextGradientTool(current: EditorTool | undefined): EditorTool {
  return current === 'gradient' ? 'bucket' : 'gradient';
}

/** 磁性套索压感宽度(上游 magnetic_lasso_ui::settings):开=笔设备压强调制检测宽度,
 * **压得越重宽度越窄** `width=1+(base-1)*(1-pressure)`;鼠标无压感(恒 0.5)不调制——
 * 上游 `app.stylus.sample().is_some()` 门控=只有笔设备生效。 */
export function magneticPressureWidth(base: number, pressure: number | undefined, hasPen: boolean, enabled: boolean): number {
  if (!enabled || !hasPen || pressure == null || !Number.isFinite(pressure)) return base;
  return 1.0 + (base - 1.0) * (1.0 - Math.min(1, Math.max(0, pressure)));
}

// -------------------------------------------------------------------------------------------
// 形状族(二期矢量线 二-1,上游 vector_ui.rs shape_geometry/shape_bounds + shape_dialog)
// -------------------------------------------------------------------------------------------

/** 形状组工具(U 键循环,上游 Tool::Rectangle|EllipseShape|Triangle|Polygon|Line 同键 'U';
 * CustomShape 依赖预设库,后置另做)。 */
export const SHAPE_GROUP: ReadonlySet<EditorTool> = new Set(['rectShape', 'ellipseShape', 'triangleShape', 'polygonShape', 'lineShape']);

/** U 键:组内循环(上游 Tool::ALL 顺序 Rectangle→EllipseShape→Triangle→Polygon→Line;
 * 当前不在组内 → 回矩形)。 */
export function nextShapeTool(current: EditorTool | undefined): EditorTool {
  const order: EditorTool[] = ['rectShape', 'ellipseShape', 'triangleShape', 'polygonShape', 'lineShape'];
  const i = current ? order.indexOf(current) : -1;
  return i < 0 ? 'rectShape' : order[(i + 1) % order.length];
}

/** shape.create 的几何参数(不含 fill/stroke;上游 shape_geometry 逐行移植)。
 * **修饰键=实时状态**(上游传 d.live,与选区族的 press/fresh 语义不同):⇧ 等比(直线=45°
 * 吸附)、⌥ 从中心。几何过小(<1px/长度<1)返回 null=不提交不预览。 */
export interface ShapeGeom {
  kind: 'rect' | 'roundedRect' | 'ellipse' | 'polygon' | 'line';
  rect?: [number, number, number, number];
  radii?: number[];
  sides?: number;
  starRatio?: number;
  from?: [number, number];
  to?: [number, number];
  weight?: number;
}

export function shapeGeometry(
  o: Pick<ToolOptions, 'cornerRadius' | 'polygonSides' | 'lineWeight'>,
  tool: EditorTool,
  start: [number, number],
  end: [number, number],
  shift: boolean,
  alt: boolean,
): ShapeGeom | null {
  if (tool === 'lineShape') {
    let [dx, dy] = [end[0] - start[0], end[1] - start[1]];
    if (shift) {
      // Snap to 45°.
      const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
      const len = Math.hypot(dx, dy);
      [dx, dy] = [len * Math.cos(a), len * Math.sin(a)];
    }
    if (Math.hypot(dx, dy) < 1.0) return null;
    return { kind: 'line', from: [start[0], start[1]], to: [start[0] + dx, start[1] + dy], weight: Math.max(1.0, o.lineWeight) };
  }
  let [w, h] = [end[0] - start[0], end[1] - start[1]];
  if (shift) {
    const m = Math.max(Math.abs(w), Math.abs(h));
    [w, h] = [m * Math.sign(w), m * Math.sign(h)];
  }
  const [x0, y0] = alt ? [start[0] - w, start[1] - h] : [start[0], start[1]];
  const [ww, hh] = alt ? [w * 2.0, h * 2.0] : [w, h];
  const rect: [number, number, number, number] = [
    Math.round(Math.min(x0, x0 + ww)),
    Math.round(Math.min(y0, y0 + hh)),
    Math.round(Math.abs(ww)),
    Math.round(Math.abs(hh)),
  ];
  if (rect[2] < 1.0 || rect[3] < 1.0) return null;
  if (tool === 'rectShape' && o.cornerRadius > 0) return { kind: 'roundedRect', rect, radii: [o.cornerRadius, o.cornerRadius, o.cornerRadius, o.cornerRadius] };
  if (tool === 'rectShape') return { kind: 'rect', rect };
  if (tool === 'ellipseShape') return { kind: 'ellipse', rect };
  if (tool === 'triangleShape') return { kind: 'polygon', rect, sides: 3 };
  return { kind: 'polygon', rect, sides: Math.max(3, Math.round(o.polygonSides)) };
}

/** 形状拖拽的外接框 [x0,y0,x1,y1](直线的=两端点的外接);过小几何返回 null。 */
export function shapeBounds(g: ShapeGeom): [number, number, number, number] | null {
  if (g.kind === 'line' && g.from && g.to) {
    return [Math.min(g.from[0], g.to[0]), Math.min(g.from[1], g.to[1]), Math.max(g.from[0], g.to[0]), Math.max(g.from[1], g.to[1])];
  }
  if (!g.rect) return null;
  return [g.rect[0], g.rect[1], g.rect[0] + g.rect[2], g.rect[1] + g.rect[3]];
}

/** 点击 vs 拖拽:全程位移都在 3px/zoom 内=点击(上游 shape_dialog::is_click;
 * zoom=point_zoom,文档像素距离)。直线点击无对话框=直接无操作(上游 open 对 Line 返 None)。 */
export const SHAPE_CLICK_SLOP = 3.0;

export function isShapeClick(maxDeviation: number, zoom: number): boolean {
  return maxDeviation <= SHAPE_CLICK_SLOP / Math.max(0.01, zoom);
}

/** 形状数值对话框的上限(上游 shape_dialog MAX_PX,Width/Height 1..300000)。 */
export const SHAPE_DIALOG_MAX_PX = 300_000.0;

export interface ShapeDialogValues {
  width: number;
  height: number;
  fromCenter: boolean;
  /** 仅 rectangle:四角圆角(联动时同值)。 */
  radii?: [number, number, number, number];
  linkRadii?: boolean;
  /** 仅 polygon(含 triangle 无此项):边数 3..100、星形比率 %(1..100,引擎 /100)。 */
  sides?: number;
  starRatio?: number;
}

/** 点击落点的对话框默认值(上游 shape_dialog::open;width/height=100、fromCenter=false、
 * radii 取选项 cornerRadius、sides 取选项 polygonSides 钳 3..100、starRatio=100;
 * Line 无对话框返回 null)。偏好记忆(上游 prefs.dialogs 按 kind)由组件层 localStorage 合并。 */
export function shapeDialogDefaults(o: Pick<ToolOptions, 'cornerRadius' | 'polygonSides'>, tool: EditorTool): ShapeDialogValues | null {
  if (tool === 'lineShape') return null;
  const base: ShapeDialogValues = { width: 100.0, height: 100.0, fromCenter: false };
  if (tool === 'rectShape') {
    base.radii = [o.cornerRadius, o.cornerRadius, o.cornerRadius, o.cornerRadius];
    base.linkRadii = true;
  } else if (tool === 'polygonShape') {
    base.sides = Math.min(100, Math.max(3, Math.round(o.polygonSides)));
    base.starRatio = 100.0;
  }
  return base;
}

/** 对话框 kind 名(上游 shape_dialog MARK,与引擎 kind 不同名)。 */
export function shapeDialogKind(tool: EditorTool): 'rectangle' | 'ellipse' | 'triangle' | 'polygon' | null {
  if (tool === 'rectShape') return 'rectangle';
  if (tool === 'ellipseShape') return 'ellipse';
  if (tool === 'triangleShape') return 'triangle';
  if (tool === 'polygonShape') return 'polygon';
  return null;
}

/** 对话框值 → shape.create 几何(上游 shape_dialog::geometry 逐行移植:width/height 钳
 * 1..300000 否则报错文案;fromCenter 以落点为中心展开;radii 每项钳 0..min(w,h)/2、
 * 全 0=rect;triangle 恒 sides=3;polygon sides round 钳 3..100、starRatio 钳 1..100→/100)。
 * 返回 [几何, null] 或 [null, 错误文案]。 */
export function shapeDialogGeometry(
  kind: 'rectangle' | 'ellipse' | 'triangle' | 'polygon',
  at: [number, number],
  v: ShapeDialogValues,
): [ShapeGeom | null, string | null] {
  const ok = (x: number) => Number.isFinite(x) && x >= 1.0 && x <= SHAPE_DIALOG_MAX_PX;
  if (!ok(v.width)) return [null, `宽度必须在 1 到 ${SHAPE_DIALOG_MAX_PX} 像素之间`];
  if (!ok(v.height)) return [null, `高度必须在 1 到 ${SHAPE_DIALOG_MAX_PX} 像素之间`];
  if (!(Math.abs(at[0]) <= SHAPE_DIALOG_MAX_PX && Math.abs(at[1]) <= SHAPE_DIALOG_MAX_PX)) return [null, '形状位置超出范围'];
  const [x0, y0] = v.fromCenter ? [at[0] - v.width / 2.0, at[1] - v.height / 2.0] : [at[0], at[1]];
  const rect: [number, number, number, number] = [x0, y0, v.width, v.height];
  if (kind === 'rectangle') {
    const cap = Math.min(v.width, v.height) / 2.0;
    const radii = (v.radii ?? [0, 0, 0, 0]).map((r) => Math.min(cap, Math.max(0.0, Number.isFinite(r) ? r : 0.0)));
    return [radii.some((r) => r > 0) ? { kind: 'roundedRect', rect, radii } : { kind: 'rect', rect }, null];
  }
  if (kind === 'ellipse') return [{ kind: 'ellipse', rect }, null];
  if (kind === 'triangle') return [{ kind: 'polygon', rect, sides: 3 }, null];
  const sides = Math.min(100, Math.max(3, Math.round(Number.isFinite(v.sides ?? 5) ? (v.sides as number) : 5)));
  const ratio = Math.min(100, Math.max(1, Number.isFinite(v.starRatio ?? 100) ? (v.starRatio as number) : 100));
  return [{ kind: 'polygon', rect, sides, starRatio: ratio / 100.0 }, null];
}

/** shape.create 的 fill/stroke 参数(上游 create_shape/stroke_param:fill=选项开时取前景色、
 * 关时不传;stroke=宽度>0 时取背景色+引擎默认描边属性,=0 不传)。 */
export function shapeFillStroke(
  o: Pick<ToolOptions, 'shapeFill' | 'strokeWidth'>,
  foreground: number[] | undefined,
  background: number[] | undefined,
): { fill?: string; stroke?: Record<string, unknown> } {
  const hex = (c: number[] | undefined): string | undefined =>
    c && c.length >= 3 ? `#${[c[0], c[1], c[2]].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}` : undefined;
  const out: { fill?: string; stroke?: Record<string, unknown> } = {};
  if (o.shapeFill) out.fill = hex(foreground);
  if (o.strokeWidth > 0) {
    out.stroke = {
      width: o.strokeWidth,
      color: hex(background),
      // 引擎 ShapeStroke::default(上游 StrokeOptions::params 恒带全套)
      align: 'center', cap: 'butt', join: 'miter', miterLimit: 100, dashes: [], dashOffset: 0, opacity: 100,
    };
  }
  return out;
}


/** 多边形套索 Shift 45° 约束(上游 constrained_polygon_point 逐行移植:角度取 45° 整数倍,
 * 长度保持;零长度/非有限值原样返回)。 */
export function constrainPolygonPoint(from: number[], point: number[]): number[] {
  const dx = point[0] - from[0];
  const dy = point[1] - from[1];
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) return point;
  const length = Math.hypot(dx, dy);
  if (length === 0) return point;
  const angle = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [from[0] + length * Math.cos(angle), from[1] + length * Math.sin(angle)];
}

// -------------------------------------------------------------------------------------------
// 磁性套索(上游 magnetic_lasso_ui.rs 口径的纯函数部分)

/** 折线总长。 */
export function pathLength(points: number[][]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return len;
}

/** 自动落点间距(上游 spacing):频率 100→8 屏幕 px、0→98、默认 57→≈47,除以缩放折文档 px。 */
export function magneticSpacing(frequency: number, zoom: number): number {
  const f = Number.isFinite(frequency) ? Math.min(100, Math.max(0, frequency)) : 57;
  return (8.0 + (100.0 - f) * 0.9) / Math.max(0.01, zoom);
}

/** 沿折线截取 `len` 长度:返回 [截头(含截点), 截点];总长须 ≥ len+1(上游 cut 同口径),否则 null。 */
export function cutPathAtLength(points: number[][], len: number): [number[][], number[]] | null {
  if (points.length < 2 || pathLength(points) < len + 1.0) return null;
  const head: number[][] = [points[0]];
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (acc + seg >= len) {
      const t = seg === 0 ? 0 : (len - acc) / seg;
      const at = [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t];
      head.push(at);
      return [head, at];
    }
    acc += seg;
    head.push(points[i]);
  }
  return null;
}

/** 指针是否在磁性边框起点上(可闭合):距离 ≤ 半径且 path+live 总长 > 2×半径(防短边误闭合)。 */
export function nearMagneticStart(first: number[] | undefined, p: number[], closeRadius: number, totalLength: number): boolean {
  if (!first) return false;
  return Math.hypot(first[0] - p[0], first[1] - p[1]) <= closeRadius && totalLength > 2.0 * closeRadius;
}

/** 画笔族(live 描边工具):brush/eraser 走 LiveStroke,blur/sharpen/smudge 走 LiveDab。 */
export type BrushFamilyTool = 'brush' | 'eraser' | 'blur' | 'sharpen' | 'smudge';
export const BRUSH_FAMILY: ReadonlySet<BrushFamilyTool> = new Set(['brush', 'eraser', 'blur', 'sharpen', 'smudge']);

/** 引擎前景色(0..1 浮点)→ #rrggbb(画笔描边的 color 参数)。 */
export function rgbToHex(c: number[] | undefined | null): string {
  if (!c || c.length < 3) return '#000000';
  return `#${[c[0], c[1], c[2]].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** 画笔族工具 → live 描边命令(与引擎 stroke_begin/commit 的命令族一致)。 */
export function strokeCommand(tool: BrushFamilyTool): string {
  return tool === 'blur' || tool === 'sharpen' || tool === 'smudge' ? `paint.${tool}` : 'paint.stroke';
}

/**
 * 当前编辑目标是否为活动图层的像素蒙版(引擎 channels.target;channel.target.layerMask /
 * channel.target.composite 切换,⌥-点蒙版缩略图同效)。蒙版目标下画笔/橡皮/修描/油漆桶/
 * 渐变都落进蒙版(引擎 routed 注入;live 描边走桥层直通不经注入,必须前端显式带 target)。
 */
export function isMaskTarget(state: { channels?: { target?: { kind?: string } } } | null | undefined): boolean {
  return state?.channels?.target?.kind === 'layerMask';
}

/**
 * 画笔族落笔参数(photocraft spec 口径;begin 原样传,commit 由桥层原样回放):
 * - brush/eraser → paint.stroke:橡皮 = erase:true(同一引擎管线);spacing 为小数(0.25=25%),
 *   平滑 0.1(上游各工具初始值,PS 口径);
 * - blur/sharpen/smudge → paint.<tool>:retouch 族单位是百分数(hardness/opacity/flow/spacing),
 *   强度走 strength(1..100)。
 */
export function strokeParams(
  tool: BrushFamilyTool,
  opts: ToolOptions,
  foregroundHex: string,
  zoom: number,
  targetMask: boolean,
): Record<string, unknown> {
  const target = targetMask ? { target: 'mask' } : {};
  if (tool === 'brush' || tool === 'eraser') {
    return {
      size: opts.brushSize,
      hardness: opts.brushHardness,
      opacity: opts.brushOpacity,
      flow: opts.brushFlow,
      spacing: 0.25,
      smoothing: 0.1,
      color: foregroundHex,
      erase: tool === 'eraser',
      zoom,
      ...target,
    };
  }
  return {
    size: opts.brushSize,
    hardness: Math.round(opts.brushHardness * 100),
    opacity: Math.max(1, Math.round(opts.brushOpacity * 100)),
    flow: 100,
    spacing: 25,
    strength: opts.retouchStrength,
    ...target,
  };
}

/** [ / ] 调笔径(上游 tools.in/decreaseBrushSize 口径:±25% 且至少 ±1px,钳 1..500)。 */
export function brushSizeStep(size: number, dir: 1 | -1): number {
  const step = Math.max(1, Math.round(size * 0.25));
  return Math.min(500, Math.max(1, Math.round(size + dir * step)));
}

// ---- 画笔族 ⇧ 直线约束(上游 stroke_constraint.rs 移植)----
//
// - 按住 Shift 拖动画笔类工具:描边锁定在自约束起点(描边起点,或拖动中按下 Shift 的那
//   一点)出发的 0°/45°/90° 直线上;指针移动 ≥3 屏幕像素后方向锁定并保持(带方向记忆);
//   未锁定且在锁距内时点吸附回起点;松开 Shift 解除锁定、后续点原样通过。
// - Shift+点击 = 从上一笔终点直线连到本次落点(同一笔、一步历史,由 begin 的点列承载,
//   引擎沿段插值 dabs)。该行为在 EditorCanvas 的 beginStroke 里接,这里只提供几何。

/** 画笔描边的 ⇧ 约束状态:origin=约束起点,dir=锁定后的单位方向(未锁定为 null)。 */
export interface StrokeAxis {
  origin: [number, number];
  dir: [number, number] | null;
}

/** 指针须移动的屏幕像素数,⇧ 约束的方向才锁定(上游 LOCK_DISTANCE)。 */
const STROKE_LOCK_DISTANCE = 3;

/** origin 指向 p 的单位方向,吸附到最近 45° 倍角;重合/非有限返回 null(上游 snapped_dir)。 */
export function snappedDir(origin: [number, number], p: [number, number]): [number, number] | null {
  const dx = p[0] - origin[0];
  const dy = p[1] - origin[1];
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || Math.hypot(dx, dy) < 1e-9) return null;
  const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
  return [Math.cos(a), Math.sin(a)];
}

/** p 在过 origin、沿单位方向 dir 的直线上的投影(上游 project)。 */
export function projectOn(origin: [number, number], dir: [number, number], p: [number, number]): [number, number] {
  const t = (p[0] - origin[0]) * dir[0] + (p[1] - origin[1]) * dir[1];
  return [origin[0] + dir[0] * t, origin[1] + dir[1] * t];
}

/** 吸附到过 origin 的最近 45° 射线(8 向;上游 stroke_constraint::snap45)。 */
export function snap45(origin: [number, number], p: [number, number]): [number, number] {
  const dir = snappedDir(origin, p);
  return dir ? projectOn(origin, dir, p) : p;
}

/** Live 渐变 widget 命中的抓取物(上游 Grab):stop/mid 的 index 是排序下标/段号,
 * line 的 t 是渐变空间位置(反向已折算)。 */
export type GradientLiveGrab =
  | { kind: 'end' }
  | { kind: 'start' }
  | { kind: 'stop'; index: number }
  | { kind: 'mid'; index: number }
  | { kind: 'line'; t: number };

/** 渐变空间位置 t 在方向线上的点(上游 Widget::at:reverse 把 t 映射成 1-t 再插值)。 */
export function gradientLiveAt(from: [number, number], to: [number, number], t: number, reverse: boolean): [number, number] {
  const u = reverse ? 1 - t : t;
  return [from[0] + (to[0] - from[0]) * u, from[1] + (to[1] - from[1]) * u];
}

/**
 * Live 渐变 widget 命中(上游 gradient_ui Widget::hit 完整版;tol 为文档 px,调用方传
 * 8 屏幕px/zoom)。优先级 End→Start→色标→中点→线;stops 升序、渐变空间位置;mids 为
 * 每段中点 0..1(缺省 0.5,段宽 ≤1e-4 无中点);线命中=投影钳 0..1 后距离 ≤tol。
 */
export function gradientLiveHit(
  from: [number, number],
  to: [number, number],
  stops: Array<[number, string]>,
  mids: number[],
  reverse: boolean,
  p: [number, number],
  tol: number,
): GradientLiveGrab | null {
  const d = (q: [number, number]) => Math.hypot(p[0] - q[0], p[1] - q[1]);
  if (d(to) <= tol) return { kind: 'end' };
  if (d(from) <= tol) return { kind: 'start' };
  const si = stops.findIndex((s) => d(gradientLiveAt(from, to, s[0], reverse)) <= tol);
  if (si >= 0) return { kind: 'stop', index: si };
  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i][0];
    const b = stops[i + 1][0];
    if (b - a <= 1e-4) continue;
    if (d(gradientLiveAt(from, to, a + (b - a) * (mids[i] ?? 0.5), reverse)) <= tol) return { kind: 'mid', index: i };
  }
  const vx = to[0] - from[0];
  const vy = to[1] - from[1];
  const len2 = vx * vx + vy * vy;
  if (len2 < 1e-9) return null;
  const u = Math.min(1, Math.max(0, ((p[0] - from[0]) * vx + (p[1] - from[1]) * vy) / len2));
  return Math.hypot(p[0] - (from[0] + vx * u), p[1] - (from[1] + vy * u)) <= tol ? { kind: 'line', t: reverse ? 1 - u : u } : null;
}

/**
 * 中点重映射(上游 compose midpoint_remap 逐行移植:分段线性——色在 m 处恰为一半,
 * 两侧各自由线性;0.5=不变)。属性页停靠点条与画布渲染共用同一公式,条带显示与引擎一致。
 */
export function midpointRemap(u: number, m: number): number {
  const mm = Math.min(0.95, Math.max(0.05, m));
  if (Math.abs(mm - 0.5) < 1e-6) return u;
  if (u <= mm) return (0.5 * u) / mm;
  return 0.5 + (0.5 * (u - mm)) / (1 - mm);
}

export type LayerRampFill = {
  stops: Array<[number, string]>;
  midpoints: number[];
  transparency: Array<[number, number]>;
};

/** "#rrggbb"/"#rrggbbaa" → 0..1 RGBA(非法输入回黑)。 */
export function hexToRgba01(hex: string): [number, number, number, number] {
  const h = hex.replace('#', '');
  const b = (i: number) => Number.parseInt(h.slice(i * 2, i * 2 + 2) || '00', 16) / 255;
  return [b(0), b(1), b(2), h.length >= 8 ? b(3) : 1];
}

/**
 * 渐变填充图层在渐变空间 t 处的 RGBA(引擎 Ramp::sample 移植:颜色停靠点带各自 alpha、
 * 按中点分段线性插值 × 透明度停靠点线性插值(空=全不透明))。属性页条带渲染用。
 */
export function sampleLayerRamp(fill: LayerRampFill, t: number): [number, number, number, number] {
  const stops = fill.stops.map(([p, hex]) => [p, hexToRgba01(hex)] as [number, [number, number, number, number]]).sort((x, y) => x[0] - y[0]);
  if (!stops.length) return [0, 0, 0, 0];
  const first = stops[0];
  const last = stops[stops.length - 1];
  let color: [number, number, number, number];
  if (t <= first[0]) {
    color = first[1];
  } else if (t >= last[0]) {
    color = last[1];
  } else {
    color = first[1];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i];
      const b = stops[i + 1];
      if (t <= b[0]) {
        const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
        const k = midpointRemap(u, fill.midpoints[i] ?? 0.5);
        color = [0, 1, 2, 3].map((c) => a[1][c] + (b[1][c] - a[1][c]) * k) as [number, number, number, number];
        break;
      }
    }
  }
  // 透明度停靠点(空=全不透明;线性、无中点)
  const os = fill.transparency.map(([p, a]) => [p, Math.min(1, Math.max(0, a / 100))] as [number, number]).sort((x, y) => x[0] - y[0]);
  let alpha = 1;
  if (os.length) {
    if (t <= os[0][0]) alpha = os[0][1];
    else if (t >= os[os.length - 1][0]) alpha = os[os.length - 1][1];
    else {
      for (let i = 0; i < os.length - 1; i++) {
        const a = os[i];
        const b = os[i + 1];
        if (t <= b[0]) {
          const u = b[0] > a[0] ? (t - a[0]) / (b[0] - a[0]) : 0;
          alpha = a[1] + (b[1] - a[1]) * u;
          break;
        }
      }
    }
  }
  return [color[0], color[1], color[2], color[3] * alpha];
}

/**
 * 层渐变条带的 CSS 渐变串(64 均匀采样,上游 stop_strip 的 paint_ramp n=64 同口径;
 * 中点分段线性在该密度下与逐像素渲染无可见差)。棋盘格垫底显透明由调用方叠加。
 */
export function layerRampCss(fill: LayerRampFill): string {
  const parts: string[] = [];
  for (let i = 0; i <= 64; i++) {
    const u = i / 64;
    const [r, g, b, a] = sampleLayerRamp(fill, u);
    parts.push(`rgba(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)},${a.toFixed(4)}) ${(u * 100).toFixed(2)}%`);
  }
  return `linear-gradient(to right, ${parts.join(', ')})`;
}

/**
 * 停靠点编辑后的排序下标(上游 selection_after_edit:move/add 后被编辑的停靠点会重排,
 * 选中跟随它的新位置;delete/其他 → null=清选中)。move 的并列位置只在原序在前时计入
 * (引擎稳定排序保持原相对序);add 的并列位置全计入(新标排在同位者之后)。
 */
export function stopIndexAfterEdit(
  locations: number[],
  params: { action: string; index?: number; location?: number },
): number | null {
  const sorted = [...locations].sort((a, b) => a - b);
  if (params.action === 'move' && params.index != null && params.location != null) {
    const loc = params.location;
    const old = params.index;
    return sorted.filter((l, i) => i !== old && (l < loc || (l === loc && i < old))).length;
  }
  if (params.action === 'add' && params.location != null) {
    const loc = params.location;
    return sorted.filter((l) => l <= loc).length;
  }
  return null;
}

/** 撕离删除阈值:被拖色标离线超过此屏幕距离且色标 >2 个即删除(上游 TEAR_OFF)。 */
export const GRADIENT_TEAR_OFF = 36;

/**
 * 被拖色标的排序下标(引擎 move/delete 按「当前排序下标」寻址;move 提交会重排,
 * 所以下标按引擎当前持有的位置=上一次发送的位置计算;其余色标在快照里不动)。
 * lastSent=null 时引擎还是原样,用 origIndex。
 */
export function gradientStopIndexAfter(stopLocations: number[], origIndex: number, t: number): number {
  return stopLocations.filter((l, i) => i !== origIndex && l < t).length;
}

/**
 * 色标拖拽提交参数(上游 drag_to Grab::Stop):沿线投影得渐变位置;离线 >36 屏幕 px 且
 * 色标 >2 个=撕离删除,否则移动(位置钳 0..1 由引擎做)。返回 null=退化(零长线)。
 * curIdx 是被拖色标当前在引擎里的排序下标;新下标由调用方在提交成功后用
 * gradientStopIndexAfter 重算。
 */
export function gradientStopDragParams(
  from: [number, number],
  to: [number, number],
  reverse: boolean,
  p: [number, number],
  zoom: number,
  stopLocations: number[],
  origIndex: number,
  curIdx: number,
): { action: 'move' | 'delete'; index: number; location?: number } | null {
  const vx = to[0] - from[0];
  const vy = to[1] - from[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-9) return null;
  const u = Math.min(1, Math.max(0, ((p[0] - from[0]) * vx + (p[1] - from[1]) * vy) / len2));
  const d = Math.hypot(p[0] - (from[0] + vx * u), p[1] - (from[1] + vy * u));
  const t = reverse ? 1 - u : u;
  if (d * zoom > GRADIENT_TEAR_OFF && stopLocations.length > 2) {
    // 撕离删除:下标=被拖色标当前位置(引擎里的最新位置)在其余色标中的排序位
    return { action: 'delete', index: curIdx };
  }
  return { action: 'move', index: curIdx, location: t };
}

/**
 * 中点菱形拖拽提交参数(上游 drag_to Grab::Mid):指针沿线投影的位置 t 折算到
 * 段内比值,钳 0.05..0.95。返回 null=段退化(两色标重合)或零长线。
 */
export function gradientMidDragParams(
  from: [number, number],
  to: [number, number],
  reverse: boolean,
  p: [number, number],
  seg: number,
  a: number,
  b: number,
): { action: 'midpoint'; index: number; location: number } | null {
  const vx = to[0] - from[0];
  const vy = to[1] - from[1];
  const len2 = vx * vx + vy * vy;
  if (len2 <= 1e-9 || b - a <= 1e-4) return null;
  const u = Math.min(1, Math.max(0, ((p[0] - from[0]) * vx + (p[1] - from[1]) * vy) / len2));
  const t = reverse ? 1 - u : u;
  return { action: 'midpoint', index: seg, location: Math.min(0.95, Math.max(0.05, (t - a) / (b - a))) };
}

/**
 * Live 渐变图层创建参数(gradient.fill.create):stops/transparency 来自当前渐变
 * (活引用交引擎解析),几何取整 + 样式/反向/仿色/不透明度(0..100,spec 与
 * paint.gradient 不同:允许 0)。
 */
export function gradientLiveCreateParams(
  from: [number, number],
  to: [number, number],
  opts: ToolOptions,
): Record<string, unknown> {
  const { stops, transparency } = presetPaintParams(opts.gradientCurrent);
  return {
    from: [Math.round(from[0]), Math.round(from[1])],
    to: [Math.round(to[0]), Math.round(to[1])],
    style: opts.gradientStyle,
    stops,
    ...(transparency ? { transparency } : {}),
    reverse: opts.gradientReverse,
    dither: opts.gradientDither,
    opacity: Math.max(0, Math.min(100, Math.round(opts.gradientOpacity * 100))),
    mode: opts.gradientBlend,
  };
}

/**
 * 画笔族 ⇧ 约束(上游 constrain):`last` 是上一个未约束的原始指针位置(Shift 刚按下时
 * 约束起点=它),`axis` 在一笔内携带锁定状态;zoom 把 3 屏幕像素锁距换算成文档像素。
 * 不按 Shift 时点原样通过并丢弃锁定。只对画笔族调用(上游 applies() 在调用侧判定)。
 */
export function constrainStrokePoint(
  axis: StrokeAxis | null,
  last: [number, number],
  p: [number, number],
  shift: boolean,
  zoom: number,
): { p: [number, number]; axis: StrokeAxis | null } {
  if (!shift) return { p, axis: null };
  const a = axis ?? { origin: last, dir: null };
  if (!a.dir) {
    const reach = STROKE_LOCK_DISTANCE / Math.max(zoom, 1e-3);
    if (Math.hypot(p[0] - a.origin[0], p[1] - a.origin[1]) < reach) return { p: a.origin, axis: a };
    a.dir = snappedDir(a.origin, p);
  }
  return { p: a.dir ? projectOn(a.origin, a.dir, p) : a.origin, axis: a };
}

// ---- 裁剪工具(上游 crop_ui.rs / crop_straighten.rs 移植)----
//
// 框模型:[x0,y0,x1,y1](文档 px,未转矩形)+ angle(屏幕顺时针度数,绕框中心);
// 提交 = 一条 image.crop {x,y,width,height,angle?},显式矩形允许超出画布,带角度时
// 引擎在一步内完成"逆时针转图→框转正→裁到框"。这里的几何全部是纯函数。

/** 裁剪框最小边(文档 px);松手时不满足则回退手势前矩形。 */
export const CROP_MIN_FRAME = 1.0;
/** 把手命中半径(屏幕 px);容差=HANDLE_PX/zoom。 */
export const CROP_HANDLE_PX = 8.0;
/** 拉直线最短长度(屏幕 px),短于则无效果。 */
export const CROP_MIN_LINE_PX = 3.0;

export type CropRect = [number, number, number, number];
export type CropHit = { kind: 'handle'; hx: -1 | 0 | 1; hy: -1 | 0 | 1 } | { kind: 'inside' } | { kind: 'outside' };

/** 正置框命中(上游 hit):距边 ≤tol 为把手(hx/hy=所在边 -1/0/1;框内侧容差收缩到
 * 边距的 1/4,小框仍可移动整框);严格在框内为 inside,否则 outside。 */
export function cropHit(r: CropRect, p: [number, number], tol: number): CropHit {
  const axis = (lo: number, hi: number, v: number, otherIn: boolean): -1 | 0 | 1 => {
    const t = Math.min(tol, (hi - lo) / 4.0);
    const near = (e: number, outward: number) => (v - e) * outward <= tol && (e - v) * outward <= t;
    if (!otherIn) return 0;
    if (near(lo, -1) && near(hi, 1)) return Math.abs(v - lo) <= Math.abs(v - hi) ? -1 : 1;
    if (near(lo, -1)) return -1;
    if (near(hi, 1)) return 1;
    return 0;
  };
  const inX = p[0] >= r[0] - tol && p[0] <= r[2] + tol;
  const inY = p[1] >= r[1] - tol && p[1] <= r[3] + tol;
  const hx = axis(r[0], r[2], p[0], inY);
  const hy = axis(r[1], r[3], p[1], inX);
  if (hx !== 0 || hy !== 0) return { kind: 'handle', hx, hy };
  if (p[0] > r[0] && p[0] < r[2] && p[1] > r[1] && p[1] < r[3]) return { kind: 'inside' };
  return { kind: 'outside' };
}

/** p 绕 c 顺时针转 deg 度(屏幕 y 向下;上游 turn)。 */
export function cropTurn(p: [number, number], c: [number, number], deg: number): [number, number] {
  const rad = (deg * Math.PI) / 180;
  const s = Math.sin(rad);
  const k = Math.cos(rad);
  const dx = p[0] - c[0];
  const dy = p[1] - c[1];
  return [c[0] + k * dx - s * dy, c[1] + s * dx + k * dy];
}

/** 框 r 转 deg 度后的四角:正置框的 左上/右上/右下/左下(上游 corners)。 */
export function cropCorners(r: CropRect, deg: number): [[number, number], [number, number], [number, number], [number, number]] {
  const c: [number, number] = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
  return [
    cropTurn([r[0], r[1]], c, deg),
    cropTurn([r[2], r[1]], c, deg),
    cropTurn([r[2], r[3]], c, deg),
    cropTurn([r[0], r[3]], c, deg),
  ];
}

/** 框 r 转 deg 度后的轴对齐外接矩形(上游 turned_bounds)。 */
export function cropTurnedBounds(r: CropRect, deg: number): CropRect {
  if (deg === 0) return r;
  const cs = cropCorners(r, deg);
  const xs = cs.map((p) => p[0]);
  const ys = cs.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/** 斜置框命中:点反转 -deg 到正置空间后按正置框判定(上游 hit_turned)。 */
export function cropHitTurned(r: CropRect, deg: number, p: [number, number], tol: number): CropHit {
  if (deg === 0) return cropHit(r, p, tol);
  const c: [number, number] = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
  return cropHit(r, cropTurn(p, c, -deg), tol);
}

/** 角度归一到 (-180,180];非有限=0(上游 normalized_angle)。 */
export function cropNormalizedAngle(deg: number): number {
  if (!Number.isFinite(deg)) return 0;
  const a = ((deg % 360) + 360) % 360;
  return a > 180 ? a - 360 : a;
}

/** 旋转光标在文档点 p 的弯向(上游 turn_cursor_dir):指向 p 所在象限的框角、沿框自身轴的
 * 对角线方向,随框转回 deg;四角四支光标。outside=悬停在框外或正在旋转拖拽。 */
export function cropTurnCursorDir(r: CropRect, deg: number, p: [number, number], outside: boolean): [number, number] | null {
  if (!outside || !p.every(Number.isFinite)) return null;
  const c: [number, number] = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
  const local = cropTurn(p, c, -deg);
  const sx = local[0] < c[0] ? 1.0 : -1.0;
  const sy = local[1] < c[1] ? 1.0 : -1.0;
  return cropTurn([sx * Math.SQRT1_2, sy * Math.SQRT1_2], [0, 0], deg);
}

/** 框从 from 度被指针绕 c 扫过 grab→p 后的新角度;⇧ 吸附 15°(上游 turned_angle)。 */
export function cropTurnedAngle(c: [number, number], grab: number, from: number, p: [number, number], snap: boolean): number {
  const now = Math.atan2(p[1] - c[1], p[0] - c[0]);
  const a = from + ((now - grab) * 180) / Math.PI;
  return cropNormalizedAngle(snap ? Math.round(a / 15) * 15 : a);
}

/** [x0,y0,x1,y1] 规范化(x0≤x1, y0≤y1)。 */
function cropNormalize(a: [number, number], b: [number, number]): CropRect {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1])];
}

/** 新画的框(上游 drawn + chrome_ui::marquee_end):有 ratio 固定比例(较大的延伸方向为
 * 主轴,另一轴按比例),无 ratio 时 ⇧ 正方形;alt=从锚点向两侧。 */
export function cropDrawn(anchor: [number, number], cur: [number, number], ratio: number | null, shift: boolean, alt: boolean): CropRect {
  const dx = cur[0] - anchor[0];
  const dy = cur[1] - anchor[1];
  const sx = dx < 0 ? -1 : 1;
  const sy = dy < 0 ? -1 : 1;
  let e: [number, number];
  if (ratio != null && Number.isFinite(ratio) && ratio > 0) {
    const k = Math.max(Math.abs(dx) / ratio, Math.abs(dy));
    e = [anchor[0] + sx * k * ratio, anchor[1] + sy * k];
  } else if (shift) {
    const m = Math.max(Math.abs(dx), Math.abs(dy));
    e = [anchor[0] + sx * m, anchor[1] + sy * m];
  } else {
    e = [cur[0], cur[1]];
  }
  if (alt) return cropNormalize([2 * anchor[0] - e[0], 2 * anchor[1] - e[1]], e);
  return cropNormalize(anchor, e);
}

/** 正置框把手调整(上游 resized):被拖边移动、对边固定;alt=绕中心;ratio(width/height)
 * 保持比例——角把手取"相对伸缩更大者"为主轴,边把手由另一轴推导。 */
export function cropResized(r: CropRect, hx: -1 | 0 | 1, hy: -1 | 0 | 1, d: [number, number], ratio: number | null, alt: boolean): CropRect {
  const axis = (lo: number, hi: number, h: -1 | 0 | 1, dv: number): [number, number, boolean] => {
    const c = (lo + hi) / 2;
    if (h === 1 && alt) return [c, hi + dv - c, true];
    if (h === 1) return [lo, hi + dv - lo, false];
    if (h === -1 && alt) return [c, lo + dv - c, true];
    if (h === -1) return [hi, lo + dv - hi, false];
    return [c, (hi - lo) / 2, true];
  };
  const [fx, ex0, cx] = axis(r[0], r[2], hx, d[0]);
  const [fy, ey0, cy] = axis(r[1], r[3], hy, d[1]);
  let ex = ex0;
  let ey = ey0;
  if (ratio != null && Number.isFinite(ratio) && ratio > 0) {
    const full = (e: number, c: boolean) => Math.abs(e) * (c ? 2 : 1);
    const w = full(ex, cx);
    const h = full(ey, cy);
    let sized: [number, number];
    if (hx !== 0 && hy !== 0) {
      const s = Math.max(w / ratio, h); // 角把手:相对伸缩更大者为主轴
      sized = [s * ratio, s];
    } else if (hx !== 0) {
      sized = [w, w / ratio];
    } else if (hy !== 0) {
      sized = [h * ratio, h];
    } else {
      sized = [w, h];
    }
    const back = (e: number, len: number, c: boolean) => (e < 0 ? -1 : 1) * (c ? len / 2 : len);
    ex = back(ex, sized[0], cx);
    ey = back(ey, sized[1], cy);
  }
  const span = (f: number, e: number, c: boolean): [number, number] => (c ? [f - e, f + e] : [f, f + e]);
  const [ax0, ax1] = span(fx, ex, cx);
  const [ay0, ay1] = span(fy, ey, cy);
  return cropNormalize([ax0, ay0], [ax1, ay1]);
}

/** 斜置框把手调整(上游 resized_turned):把手沿框自身轴移动、对边在页面上保持原位。 */
export function cropResizedTurned(r: CropRect, deg: number, hx: -1 | 0 | 1, hy: -1 | 0 | 1, d: [number, number], ratio: number | null, alt: boolean): CropRect {
  if (deg === 0) return cropResized(r, hx, hy, d, ratio, alt);
  const c: [number, number] = [(r[0] + r[2]) / 2, (r[1] + r[3]) / 2];
  const n = cropResized(r, hx, hy, cropTurn(d, [0, 0], -deg), ratio, alt);
  const nc = cropTurn([(n[0] + n[2]) / 2, (n[1] + n[3]) / 2], c, deg);
  const hw = (n[2] - n[0]) / 2;
  const hh = (n[3] - n[1]) / 2;
  return [nc[0] - hw, nc[1] - hh, nc[0] + hw, nc[1] + hh];
}

/** 最大居中、比例 width/height 的矩形,内含于当前框(只减不增;上游 fitted_ratio)。 */
export function cropFittedRatio(r: CropRect, ratio: number): CropRect | null {
  const w = r[2] - r[0];
  const h = r[3] - r[1];
  if (![...r, w, h].every(Number.isFinite) || w <= 0 || h <= 0 || !Number.isFinite(ratio) || ratio <= 0) return null;
  if (Math.abs(w / h / ratio - 1) < 1e-12) return r;
  const c: [number, number] = [r[0] + w / 2, r[1] + h / 2];
  const [fw, fh] = w / h > ratio ? [h * ratio, h] : [w, w / ratio];
  const fitted: CropRect = [c[0] - fw / 2, c[1] - fh / 2, c[0] + fw / 2, c[1] + fh / 2];
  return fitted.every(Number.isFinite) && fitted[2] > fitted[0] && fitted[3] > fitted[1] ? fitted : null;
}

/** 顺时针度数:把标尺线转到最近的水平/垂直轴(引擎 analysis_cmds::straighten_angle)。 */
export function cropStraightenAngle(dx: number, dy: number): number {
  const a = (Math.atan2(-dy, dx) * 180) / Math.PI;
  return a - 90 * Math.round(a / 90);
}

/** 拉直后框应转的角度(屏幕顺时针):线转平/转竖需要图像转 -rot(上游 frame_angle)。 */
export function cropFrameAngle(a: [number, number], b: [number, number], minLen: number): number | null {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (!Number.isFinite(len) || len < Math.max(minLen, Number.MIN_VALUE)) return null;
  return cropNormalizedAngle(-cropStraightenAngle(dx, dy));
}

/** 比例 w×h、转 deg 度后仍完全内含于 cw×ch 画布的最大居中框(上游 crop_straighten::fitted)。 */
export function cropFitted(w: number, h: number, cw: number, ch: number, deg: number): CropRect | null {
  if (![w, h, cw, ch, deg].every(Number.isFinite) || w <= 0 || h <= 0 || cw <= 0 || ch <= 0) return null;
  const rad = (deg * Math.PI) / 180;
  const s = Math.abs(Math.sin(rad));
  const c = Math.abs(Math.cos(rad));
  const k = Math.min(cw / (w * c + h * s), ch / (w * s + h * c));
  if (!Number.isFinite(k) || k <= 0) return null;
  const hw = (w * k) / 2;
  const hh = (h * k) / 2;
  const cx = cw / 2;
  const cy = ch / 2;
  return [cx - hw, cy - hh, cx + hw, cy + hh];
}

/**
 * 移动拖拽的 ⇧ 约束(上游 move_mods::constrain 原样移植):
 * - `dirs=4`(整层):锁到水平/垂直主轴;`dirs=8`(浮动选区像素):轴 + 45° 斜向;
 * - 迟滞 8°:上一帧锁定的方向在指针越过半程线再多 8° 前不切换(防对角线附近抖动);
 * - 结果精确落在锁定方向上(投影长度取模,浮点噪声钳 0)。
 * 无 ⇧(dirs=0)原样返回并取整。
 */
export function constrainMove(
  d: [number, number], prev: [number, number] | null, dirs: 0 | 4 | 8,
): { dx: number; dy: number } {
  const len = Math.hypot(d[0], d[1]);
  let [x, y] = d;
  if (dirs !== 0 && Number.isFinite(len) && len > 0) {
    const step = (Math.PI * 2) / dirs;
    const a = Math.atan2(d[1], d[0]);
    let k = Math.round(a / step);
    const p = prev && Math.hypot(prev[0], prev[1]) > 0 ? prev : null;
    if (p) {
      const kp = Math.round(Math.atan2(p[1], p[0]) / step);
      // 与上一方向的角度差,折到 [0, 2π);未过半程线+8° 迟滞则保持原方向
      const off = ((a - kp * step) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
      if (off < step / 2 + (8 * Math.PI) / 180) k = kp;
    }
    const [s, c] = [Math.sin(k * step), Math.cos(k * step)];
    const t = Math.max(0, d[0] * c + d[1] * s);
    const clean = (v: number) => (Math.abs(v) < 1e-9 ? 0 : v);
    x = clean(t * c);
    y = clean(t * s);
  }
  return { dx: Math.round(x), dy: Math.round(y) };
}

/**
 * 移动预览的脏矩形:bounds(选区/图层外接框,文档坐标)在上一帧偏移与当前偏移下
 * 的两个矩形取并,再钳进画布。空区域(w=0)表示无需合成。
 */
export function moveDirtyRect(
  bounds: [number, number, number, number] | null,
  prevDx: number, prevDy: number, dx: number, dy: number,
  docW: number, docH: number,
): { x: number; y: number; w: number; h: number } {
  if (!bounds) return { x: 0, y: 0, w: 0, h: 0 };
  const [bx, by, bw, bh] = bounds;
  const x0 = Math.min(bx + prevDx, bx + dx);
  const y0 = Math.min(by + prevDy, by + dy);
  const x1 = Math.max(bx + prevDx + bw, bx + dx + bw);
  const y1 = Math.max(by + prevDy + bh, by + dy + bh);
  const cx0 = Math.max(0, Math.floor(x0));
  const cy0 = Math.max(0, Math.floor(y0));
  const cx1 = Math.min(docW, Math.ceil(x1));
  const cy1 = Math.min(docH, Math.ceil(y1));
  if (cx1 <= cx0 || cy1 <= cy0) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
}

/** 活动层(或选中层并集)**连同链接层**的外接框,文档坐标;无 bounds(如空层)回退整幅画布。
 * 链接扩散 = 引擎 move_targets 的 with_links 口径:与任一根层同 linkGroup 的层一起动,
 * 脏矩形必须并上它们的 bounds,否则链接层拖出残影。 */
export function moveBounds(
  layers: { id: number; bounds: [number, number, number, number] | null; selected: boolean; linkGroup?: number | null }[],
  activeLayer: number | null,
  docW: number,
  docH: number,
): [number, number, number, number] | null {
  const ids = new Set(layers.filter((l) => l.selected).map((l) => l.id));
  const roots = layers.filter((l) => (ids.size > 0 ? ids.has(l.id) : l.id === activeLayer));
  if (!roots.length) return null;
  const groups = new Set(roots.map((l) => l.linkGroup).filter((g): g is number => g != null));
  const moving = groups.size
    ? layers.filter((l) => roots.includes(l) || (l.linkGroup != null && groups.has(l.linkGroup)))
    : roots;
  const boxes = moving.map((l) => l.bounds ?? [0, 0, docW, docH]);
  const x0 = Math.min(...boxes.map((b) => b[0]));
  const y0 = Math.min(...boxes.map((b) => b[1]));
  const x1 = Math.max(...boxes.map((b) => b[0] + b[2]));
  const y1 = Math.max(...boxes.map((b) => b[1] + b[3]));
  return [x0, y0, x1 - x0, y1 - y0];
}

/** Auto-Select 按下探测参数(layer.pickAt select:false;上游 canvas.rs 按下分发口径)。 */
export function movePickParams(
  x: number, y: number, opts: { moveTarget: 'layer' | 'group' }, select: boolean,
  mode: 'replace' | 'add' | 'toggle' = 'replace',
): Record<string, unknown> {
  return { x, y, target: opts.moveTarget, select, mode };
}

/** 层选框提交参数(layer.selectInRect;空白处拖框选层,引擎按需钳负宽高)。 */
export function moveSelectRectParams(
  start: [number, number], w: number, h: number, opts: { moveTarget: 'layer' | 'group' }, add: boolean,
): Record<string, unknown> {
  return { x: start[0], y: start[1], width: w, height: h, target: opts.moveTarget, mode: add ? 'add' : 'replace' };
}

/**
 * 套索提交参数(select.lasso;photocraft selection_cmds 口径):points 为文档坐标
 * [[x,y],…] 自由序列,mode 同选框四态,feather 引擎域 0..=1000 **越界报错**
 * (select.rect 是静默钳,lasso 不是——发送前必须钳住)。
 */
export function lassoParams(
  points: number[][],
  opts: ToolOptions,
  mode: 'replace' | 'add' | 'subtract' | 'intersect',
): Record<string, unknown> {
  return {
    points,
    mode,
    antiAlias: opts.antiAlias,
    feather: Math.min(1000, Math.max(0, opts.feather)),
  };
}

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

// ===== Select and Mask 边刷(上游 select_mask_view::paint 移植)=====

/** 边刷笔划(引擎 select.refineEdge 的 refineStrokes 形态;点=文档 px)。 */
export interface SelectMaskStroke {
  points: number[][];
  size: number;
  mode: 'add' | 'subtract';
}

/** vendor smartselect_cmds 上限(超出即拒收,前端同口径停笔)。 */
export const SELECT_MASK_MAX_STROKES = 4096;
export const SELECT_MASK_MAX_STROKE_POINTS = 100_000;

/** 边刷直径范围(上游 BRUSH_SIZES;滑杆与 [ ] 键共用)。 */
export const SELECT_MASK_BRUSH_SIZES: [number, number] = [1, 1000];

/** 在 `at` 画边刷:start=新开一笔,否则延最后一笔;距上点 < max(size/8,1) 的点跳过;
 * 总点数到上限停笔(上游 paint 逐行移植;返回新数组,不可变)。 */
export function selectMaskPaintStroke(
  strokes: SelectMaskStroke[],
  at: [number, number],
  start: boolean,
  subtract: boolean,
  size: number,
): SelectMaskStroke[] {
  if (!Number.isFinite(at[0]) || !Number.isFinite(at[1])) return strokes;
  if (strokes.reduce((n, s) => n + s.points.length, 0) >= SELECT_MASK_MAX_STROKE_POINTS) return strokes;
  const round = (v: number) => Math.round(v * 10) / 10;
  const pt = [round(at[0]), round(at[1])];
  const room = strokes.length < SELECT_MASK_MAX_STROKES;
  const last = strokes.length > 0 ? strokes[strokes.length - 1] : null;
  if (last && !start) {
    const prev = last.points[last.points.length - 1];
    if (!prev || Math.hypot(prev[0] - at[0], prev[1] - at[1]) >= Math.max(size / 8, 1)) {
      return [...strokes.slice(0, -1), { ...last, points: [...last.points, pt] }];
    }
    return strokes;
  }
  if (!room) return strokes;
  return [...strokes, { points: [pt], size, mode: subtract ? 'subtract' : 'add' }];
}
