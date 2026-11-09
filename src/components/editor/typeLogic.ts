/**
 * 文字工具纯逻辑(二期 二-6,上游 crates/ui-egui/src/type_tool.rs 移植)。
 * 编辑会话是编辑器态:所有文字改动都是带 `coalesce` 键的 type.* 引擎命令——整段输入
 * 合并成一条「编辑文字」历史步;caret 几何/命中/导航不在这排(引擎 type.hitTest /
 * type.caret / type.navigate 查询,文档像素、字符索引),这里只有字符索引的纯逻辑。
 * 字符索引=Unicode 标量值(JS 展开运算符口径,与 Rust chars() 一致)。
 */

/** 文字工具集合(横排/竖排;上游 Tool::Type|VerticalType。Type Mask 族 S6 后置)。 */
export const TYPE_TOOLS: ReadonlySet<string> = new Set(['type', 'typeVertical']);

export interface TextEditSession {
  layer: number;
  /** 编辑归属文档 id(跨文档 tab 的 layer id 可重复;null=活动文档)。 */
  docId: number | null;
  caret: number;
  anchor: number;
  /** 历史合并键:type.create 时生成,整会话一条历史步(上游 session_key)。 */
  session: string;
  /** 图层由本会话创建:提交时空=删层,非空=按文字重命名(上游 created)。 */
  created: boolean;
  /** IME 组字进行中:(组字起点,组字长度)字符索引;preedit 文本在图层里排版回流。 */
  preedit: [number, number] | null;
  /** 按下拖拽选字中(上游 dragging;亮 caret 不闪)。 */
  dragging: boolean;
}

export const emptyTextEdit = (): TextEditSession => ({
  layer: 0, docId: null, caret: 0, anchor: 0, session: '', created: false, preedit: null, dragging: false,
});

/** 偏好「新文字图层填占位文本」(上游 fill_new_type_layers_with_placeholder 默认开)。 */
export const TYPE_PLACEHOLDER = 'Lorem Ipsum';
/** caret 闪烁节奏(上游 period 0.530s)。 */
export const CARET_BLINK_MS = 530;
/** 段落框把手拖缩的最小框宽/高(文字空间 px,上游 MIN_BOX)。 */
export const TYPE_MIN_BOX = 4.0;

export const charCount = (text: string): number => [...text].length;

/** 字符索引处的码点;越界=undefined。 */
export const charAt = (text: string, i: number): string | undefined => [...text][i];

/** 字符区间 [a,b) 的文本。 */
export const textSlice = (text: string, a: number, b: number): string => [...text].slice(a, Math.max(a, b)).join('');

/** 引擎 norm_text:\r\n 与孤立 \r 归一成 \n(type.create/edit 入口口径)。 */
export const normText = (s: string): string => s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

/** 提交时新图层名(上游 type_cmds::layer_name):首个非空行裁剪、截 40 字符,空=Type Layer。 */
export function layerNameFromText(text: string): string {
  const first = text.split('\n').map((l) => l.trim()).find((l) => l !== '') ?? '';
  const name = [...first].slice(0, 40).join('');
  return name === '' ? 'Type Layer' : name;
}

// -------------------------------------------------------------------------------------------
// 词边界/段落(上游 photocraft_text::word_boundary / split_paragraphs / paragraph_of)
// -------------------------------------------------------------------------------------------

/** 前/后词边界(上游 word_boundary):连续字母数字 run;汉字算字母数字,连成一词。 */
export function wordBoundary(text: string, idx: number, forward: boolean): number {
  const chars = [...text];
  let i = Math.min(idx, chars.length);
  if (forward) {
    while (i < chars.length && !isWordChar(chars[i])) i += 1;
    while (i < chars.length && isWordChar(chars[i])) i += 1;
  } else {
    while (i > 0 && !isWordChar(chars[i - 1])) i -= 1;
    while (i > 0 && isWordChar(chars[i - 1])) i -= 1;
  }
  return i;
}

const isWordChar = (ch: string | undefined): boolean => ch !== undefined && /[\p{L}\p{N}_]/u.test(ch);

/** 段落字符区间(含结尾换行;上游 split_paragraphs 以字符为单位移植:\r\n/\r/\n 断段)。 */
export function splitParagraphs(text: string): [number, number][] {
  const chars = [...text];
  const out: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === '\r' || chars[i] === '\n') {
      const end = chars[i] === '\r' && chars[i + 1] === '\n' ? i + 2 : i + 1;
      out.push([start, end]);
      start = end;
      i = end - 1;
    }
  }
  if (start < chars.length) out.push([start, chars.length]);
  return out;
}

/** 字符 c 所在段落(去结尾硬回车;越界落最后一段;上游 paragraph_of)。 */
export function paragraphOf(text: string, c: number): [number, number] {
  const n = charCount(text);
  const paras = splitParagraphs(text);
  const r = paras.find(([s, e]) => c >= s && c < e) ?? paras[paras.length - 1];
  if (!r) return [c, c];
  const body = textSlice(text, r[0], r[1]).replace(/[\r\n]+$/, '');
  return [r[0], r[0] + [...body].length];
}

// -------------------------------------------------------------------------------------------
// 连击选词(上游 next_click_count / click_selection / multi_click)
// -------------------------------------------------------------------------------------------

/** 连击计数的最大值:2=词,3=行,4=段落,5=全部;下一次快击从头开始(上游 MAX_CLICKS)。 */
export const MAX_CLICKS = 5;

/**
 * 本次单击在连击串里的序号。`detail` 是 DOM UIEvent.detail(1 单击,2 双击,3 三击,
 * 自带时限与距离判定);`prev` 是上次序号(0=无)。慢/移开的点击(detail 1)开新串,
 * 五连击后从头(上游 next_click_count,egui_count 对应 DOM detail)。
 */
export function nextClickCount(prev: number, detail: number): number {
  if (detail <= 1) return 1;
  if (prev === 0) return Math.min(detail, MAX_CLICKS);
  return (prev % MAX_CLICKS) + 1;
}

/** type.info 的一行(字符索引区间;文字空间盒)。 */
export interface TypeInfoLine {
  start: number;
  end: number;
  baseline: number;
  x0: number;
  x1: number;
  ascent: number;
  descent: number;
}

/**
 * 连击 `count` 次在字符 `caret` 处的选区 [anchor, caret]:1=caret,2=词,3=所在排版行
 * (`lines` 来自 type.info;`line`=命中行下标,软换行处归属后一行;无行=按段落),
 * 4=段落,5=全部。越界收紧,空层/陈旧 caret 不炸(上游 click_selection)。
 */
export function clickSelection(
  text: string,
  caret: number,
  lines: TypeInfoLine[] | null,
  line: number | null,
  count: number,
): [number, number] {
  const n = charCount(text);
  const c = Math.min(caret, n);
  if (count === 2) {
    return wordRun([...text], c);
  }
  if (count === 3) {
    // 三击=所在排版行(命中行下标优先;caret 所在行兜底,c 在末尾落最后一行);
    // 无排版信息=按段落(上游 count 3 无 layout 回落 paragraph_of)。
    if (lines && lines.length) {
      const ln = (line != null && lines[line]) || lines.find((l) => l.start <= c && c <= l.end) || lines[lines.length - 1];
      return [Math.min(ln.start, n), Math.min(ln.end, n)];
    }
    return paragraphOf(text, c);
  }
  if (count === 4) return paragraphOf(text, c);
  if (count === 5) return [0, n];
  return [c, c];
}

function wordRun(chars: string[], c: number): [number, number] {
  let a = c;
  let b = c;
  while (a > 0 && isWordChar(chars[a - 1])) a -= 1;
  while (b < chars.length && isWordChar(chars[b])) b += 1;
  return [a, b];
}

// -------------------------------------------------------------------------------------------
// 智能引号(上游 smart_quotes,偏好默认开;粘贴的文本不改写,只有键入走这里)
// -------------------------------------------------------------------------------------------

/** 直引号变排版引号:空白/括号/破折号后=开引号,字母旁=闭引号。`prev`=caret 前一字符。 */
export function smartQuotes(s: string, prev?: string): string {
  const chars = [...s];
  const out: string[] = [];
  let p = prev;
  for (const c of chars) {
    let ch = c;
    if (c === '"') ch = opensQuote(p) ? '\u{201c}' : '\u{201d}';
    else if (c === '\'') ch = opensQuote(p) ? '\u{2018}' : '\u{2019}';
    out.push(ch);
    p = ch;
  }
  return out.join('');
}

function opensQuote(prev: string | undefined): boolean {
  return prev === undefined || /\s/.test(prev) || ['(', '[', '{', '-', '\u{2013}', '\u{2014}'].includes(prev);
}

// -------------------------------------------------------------------------------------------
// 段落框:把手/拖缩/内部判定(上游 box_handle_at / resize_box / inside_box / makes_box)
// -------------------------------------------------------------------------------------------

/** 把手 i 拖动的边(左,右,上,下):0-3 角自左上顺时针,4-7 上/右/下/左边中点(上游 handle_sides)。 */
export function handleSides(i: number): [boolean, boolean, boolean, boolean] {
  switch (i) {
    case 0: return [true, false, true, false];
    case 1: return [false, true, true, false];
    case 2: return [false, true, false, true];
    case 3: return [true, false, false, true];
    case 4: return [false, false, true, false];
    case 5: return [false, true, false, false];
    case 6: return [false, false, false, true];
    default: return [true, false, false, false];
  }
}

/** 引擎 Affine([a,b,c,d,e,f])作用一点:kurbo 约定 x'=a·x+c·y+e,y'=b·x+d·y+f。 */
export function affApply(m: number[], x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 仿射逆(退化=恒等;上游 aff.inverse().unwrap_or(IDENTITY) 口径)。 */
export function affInvert(m: number[]): number[] {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return [1, 0, 0, 1, 0, 0];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/** 字符级原位替换 [a,b)→t(会话侧文本镜像;文档真值在引擎,type.info 刷新对齐)。 */
export function applyReplace(text: string, a: number, b: number, t: string): string {
  const chars = [...text];
  return [...chars.slice(0, a), ...[...t], ...chars.slice(Math.max(a, b))].join('');
}

/** 段落框 shape('Point' 文字无框):[x, y, w, h](文字空间 px)。 */
export type TextShapeBox = [number, number, number, number];

/** type.info 的 shape 字段(serde 外标签)→ 段落框;点文本/沿路径/区域=无框。 */
export function boxOfShape(shape: unknown): TextShapeBox | null {
  if (shape && typeof shape === 'object' && 'Box' in (shape as Record<string, unknown>)) {
    const b = (shape as { Box: { x: number; y: number; width: number; height: number } }).Box;
    return [b.x, b.y, b.width, b.height];
  }
  return null;
}

/** 段落框 8 把手的文字空间位置:4 角自左上顺时针,4 边中点(上游 box_handle_at spots)。 */
export function boxHandleSpots([bx, by, w, h]: TextShapeBox): [number, number][] {
  const [r, b] = [bx + w, by + h];
  const [mx, my] = [bx + w / 2, by + h / 2];
  return [[bx, by], [r, by], [r, b], [bx, b], [mx, by], [r, my], [mx, b], [bx, my]];
}

/** 文档点落哪个把手上(tol=文档 px 命中半径;把手经层变换映射到文档再比对)。 */
export function boxHandleAt(shape: TextShapeBox, transform: number[], x: number, y: number, tol: number): number | null {
  const i = boxHandleSpots(shape).findIndex(([sx, sy]) => {
    const [px, py] = affApply(transform, sx, sy);
    return Math.abs(px - x) <= tol && Math.abs(py - y) <= tol;
  });
  return i < 0 ? null : i;
}

/**
 * 拖缩段落框(上游 resize_box 纯数学):按下时快照的 shape 上,把手跟随指针,其余边不动;
 * ⌥=对边镜像围绕按下时的中心(拖中切换按从头按住算)。返回 [x0, y0, w, h] 文字空间。
 */
export function resizeBoxCalc(handle: number, shape: TextShapeBox, px: number, py: number, alt: boolean): TextShapeBox {
  const [l, r, t, b] = handleSides(handle);
  const [bx, by, w, h] = shape;
  let [x0, y0, x1, y1] = [bx, by, bx + w, by + h];
  const [cx, cy] = [bx + w / 2, by + h / 2];
  if (l) x0 = Math.min(px, x1 - TYPE_MIN_BOX);
  if (r) x1 = Math.max(px, x0 + TYPE_MIN_BOX);
  if (t) y0 = Math.min(py, y1 - TYPE_MIN_BOX);
  if (b) y1 = Math.max(py, y0 + TYPE_MIN_BOX);
  if (alt) {
    if (l) { x0 = Math.min(px, cx - TYPE_MIN_BOX / 2); x1 = 2 * cx - x0; }
    if (r) { x1 = Math.max(px, cx + TYPE_MIN_BOX / 2); x0 = 2 * cx - x1; }
    if (t) { y0 = Math.min(py, cy - TYPE_MIN_BOX / 2); y1 = 2 * cy - y0; }
    if (b) { y1 = Math.max(py, cy + TYPE_MIN_BOX / 2); y0 = 2 * cy - y1; }
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/** 文档点在段落框内(点文本恒 false;上游 inside_box,坐标已转到文字空间)。 */
export function insideBox(shape: TextShapeBox, tx: number, ty: number): boolean {
  const [bx, by, w, h] = shape;
  return tx >= bx && tx <= bx + w && ty >= by && ty <= by + h;
}

/** 按下-抬起位移是否拖出段落框:两向都 ≥ minPx(文档 px;上游 makes_box 的 4 屏幕 px)。 */
export function makesBox(start: [number, number], end: [number, number], minPx: number): boolean {
  return Math.abs(end[0] - start[0]) >= minPx && Math.abs(end[1] - start[1]) >= minPx;
}

// -------------------------------------------------------------------------------------------
// IME 组字(上游 ime_update 的区间选择纯逻辑;type.edit replace 在画布接线)
// -------------------------------------------------------------------------------------------

/**
 * 组字替换的 [start, end):上次组字区间仍有效=原位替换;否则=当前选区。空组字且无
 * 进行中组字=不动(输入法状态扰动防御,#1381)。返回 null=无需替换(上游 ime_update 前置)。
 */
export function imeRange(
  preedit: [number, number] | null,
  caret: number,
  anchor: number,
  n: number,
  s: string,
): [number, number, number] | null {
  const len = charCount(s);
  if (len === 0 && preedit === null) return null;
  // preedit=(起点,长度):区间有效=原位替换;否则落当前选区。
  const [start, end] = preedit && preedit[0] + preedit[1] <= n ? [preedit[0], preedit[0] + preedit[1]] : [Math.min(Math.min(caret, anchor), n), Math.min(Math.max(caret, anchor), n)];
  if (start === end && len === 0) return null;
  return [start, end, len];
}

// -------------------------------------------------------------------------------------------
// 竖排方向键(上游 flow_key:竖排字流 ↑/↓=列内前/后字,←/→=换列,列自右向左)
// -------------------------------------------------------------------------------------------

/** 竖排时把方向键映射成横排同义键;其余键(Home/End 等)原样返回。 */
export function flowKey(key: string, vertical: boolean): string {
  if (!vertical) return key;
  switch (key) {
    case 'ArrowUp': return 'ArrowLeft';
    case 'ArrowDown': return 'ArrowRight';
    case 'ArrowLeft': return 'ArrowDown';
    case 'ArrowRight': return 'ArrowUp';
    default: return key;
  }
}

// -------------------------------------------------------------------------------------------
// 选区亮块几何(type.info 行盒 + type.caret 段;上游 draw_overlay 选区段移植)
// -------------------------------------------------------------------------------------------

/** type.caret 的返回段:文档像素两端点(caret 竖线;上游 segment [[x,y],[x,y]])。 */
export type CaretSegment = [[number, number], [number, number]];

/**
 * 选区 [a,b) 在一行上的字符区间(上游 per-line cluster 过滤的等价):
 * 行与 [a,b) 相交才画;返回 [max(start,a), min(end,b)) 与「选中行尾换行的延伸尾巴」标记
 * (上游换行小细条: b>行end 且 a≤行end)。空=该行无选中。
 */
export function lineSelectionSpan(line: TypeInfoLine, a: number, b: number): { span: [number, number]; tail: boolean } | null {
  const s = Math.max(line.start, a);
  const e = Math.min(line.end, b);
  if (s >= e) return null;
  const tail = b > line.end && a <= line.end;
  return { span: [s, e], tail };
}

/**
 * 竖排列选区的加宽向量:行盒宽(列宽)在**行空间**沿 +x,先转文字空间(竖排 to_text
 * 口径 (x,y)→(−y,x):方向 (w,0)→(0,w)),再经层变换线性部分转成文档向量
 * (上游按簇逐字画;这里按列盒加宽,部分选中画整列——竖排第一刀的等价近似)。
 */
export function columnWidthVec(transform: number[], line: TypeInfoLine, vertical: boolean): [number, number] {
  const w = line.x1 - line.x0;
  const [dx, dy] = vertical ? [0, w] : [w, 0];
  return [transform[0] * dx + transform[2] * dy, transform[1] * dx + transform[3] * dy];
}

/** 行空间点 → 文字空间(type.info 的行数据是行空间;竖排 to_text 口径 (x,y)→(−y,x))。 */
export function lineToText(x: number, y: number, vertical: boolean): [number, number] {
  return vertical ? [-y, x] : [x, y];
}
