/**
 * 钢笔工具纯逻辑(二期 二-2,上游 vector_ui.rs PenPath 状态机逐行移植)。
 * 草稿是编辑器态、不进文档历史:Enter/Esc(=提交保留开放,上游 #1769)/闭合拖拽/切工具
 * 才提交——path.set 一条命令一步(工作路径,追加 op:"combine")。
 * knots[i] = {anchor,in,out}(文档 px,in/out=方向手柄);unlinked=尖角锚下标(手柄不成对)。
 */
import { snap45 } from './toolLogic';

export interface PenKnot {
  anchor: [number, number];
  in: [number, number];
  out: [number, number];
}

export interface PenPath {
  knots: PenKnot[];
  /** 尖角锚下标:in/out 手柄不联动(上游 unlinked)。 */
  unlinked: number[];
  dragging: boolean;
  /** 重拖末锚:只改 out 手柄,in 曲线保持不动(上游 #1482)。 */
  adjustingLast: boolean;
  /** Alt 拖末锚的 in 手柄:它单独转(上游 #6077)。 */
  adjustingIn: boolean;
}

export const emptyPen = (): PenPath => ({ knots: [], unlinked: [], dragging: false, adjustingLast: false, adjustingIn: false });

const dist = (a: [number, number], b: [number, number]): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** `p`,或 ⇧ 投影到自 origin 的最近 45° 射线(钢笔约束,上游 shift_45)。 */
export const shift45 = (origin: [number, number], p: [number, number], shift: boolean): [number, number] =>
  shift ? snap45(origin, p) : p;

/** 点是否在首锚上:两锚以上才谈闭合(上游 on_closing_anchor)。tol=锚命中半径(文档 px)。 */
export function onClosingAnchor(pen: PenPath, x: number, y: number, tol: number): boolean {
  return pen.knots.length >= 2 && dist(pen.knots[0].anchor, [x, y]) < tol;
}

/** 悬停首锚=闭合提示(两锚以上且不在拖拽中;上游 over_first_anchor)。 */
export function overFirstAnchor(pen: PenPath, at: [number, number], tol: number): boolean {
  return !pen.dragging && pen.knots.length >= 2 && dist(pen.knots[0].anchor, at) < tol;
}

/** 闭合拖拽进行中:路径以首锚替身结尾(上游 closing)。 */
export function closing(pen: PenPath): boolean {
  const n = pen.knots.length;
  if (n < 3) return false;
  const f = pen.knots[0].anchor;
  const l = pen.knots[n - 1].anchor;
  return f[0] === l[0] && f[1] === l[1];
}

/** 钢笔按下(上游 pen_down):首锚上=压入替身锚(闭合拖拽,#3306);末锚上=断开 out 手柄
 * (重拖只改 out,#1482);否则加新锚(⇧=自上一锚 45° 投影)。 */
export function penDown(pen: PenPath | null, x: number, y: number, shift: boolean, tol: number): PenPath {
  const p = pen ?? emptyPen();
  p.adjustingIn = false;
  if (onClosingAnchor(p, x, y, tol)) {
    const first = p.knots[0].anchor;
    p.knots.push({ anchor: [first[0], first[1]], in: [first[0], first[1]], out: [first[0], first[1]] });
    p.dragging = true;
    p.adjustingLast = false;
    return p;
  }
  const li = p.knots.length - 1;
  const last = p.knots[li];
  if (last && dist(last.anchor, [x, y]) < tol) {
    last.out = [last.anchor[0], last.anchor[1]];
    if (!p.unlinked.includes(li)) p.unlinked.push(li);
    p.dragging = true;
    p.adjustingLast = true;
    return p;
  }
  const pt = p.knots.length ? shift45(p.knots[p.knots.length - 1].anchor, [x, y], shift) : [x, y];
  p.knots.push({ anchor: [pt[0], pt[1]], in: [pt[0], pt[1]], out: [pt[0], pt[1]] });
  p.dragging = true;
  p.adjustingLast = false;
  return p;
}

/** 钢笔拖拽(上游 pen_move):拉出刚放锚点的手柄。⇧(实时)转 45°;非重拖时 in=2a-out 对称;
 * adjustingIn 时只有 in 跟指针。 */
export function penMove(pen: PenPath, x: number, y: number, shift: boolean): void {
  if (!pen.dragging) return;
  const k = pen.knots[pen.knots.length - 1];
  if (!k) return;
  const a = k.anchor;
  const [px, py] = shift45(a, [x, y], shift);
  if (pen.adjustingIn) {
    k.in = [px, py];
    return;
  }
  k.out = [px, py];
  if (!pen.adjustingLast) {
    k.in = [2.0 * a[0] - px, 2.0 * a[1] - py];
  }
}

/** 钢笔抬起(上游 pen_up):闭合拖拽且替身手柄收回(抖动内)→ 替身手柄归锚点,提交闭合。 */
export function penUp(pen: PenPath, jitter: number): { closed: boolean } {
  pen.dragging = false;
  pen.adjustingLast = false;
  pen.adjustingIn = false;
  if (!closing(pen)) return { closed: false };
  const k = pen.knots[pen.knots.length - 1];
  if (k && dist(k.out, k.anchor) < jitter) {
    k.in = [k.anchor[0], k.anchor[1]];
    k.out = [k.anchor[0], k.anchor[1]];
  }
  return { closed: true };
}

/** Alt 拖拽中断开手柄对:此后只有 out 跟指针(上游 pen_break_handle,#3306)。 */
export function penBreakHandle(pen: PenPath): void {
  if (!pen.dragging || pen.adjustingLast) return;
  const i = pen.knots.length - 1;
  if (i < 0) return;
  if (!pen.unlinked.includes(i)) pen.unlinked.push(i);
  pen.adjustingLast = true;
}

/** Alt 按在末锚手柄上=只抓那只手柄拖(上游 pen_grab_handle,#3306/#6077);miss 返 false=走 penDown。 */
export function penGrabHandle(pen: PenPath, x: number, y: number, tol: number): boolean {
  const i = pen.knots.length - 1;
  const k = pen.knots[i];
  if (!k) return false;
  // 只有 out 已拉出才显示双手柄,也就只有那时能抓
  if (k.out[0] === k.anchor[0] && k.out[1] === k.anchor[1]) return false;
  const grabbed = (h: [number, number]): boolean => !(h[0] === k.anchor[0] && h[1] === k.anchor[1]) && dist(h, [x, y]) < tol && dist(h, [x, y]) < dist(k.anchor, [x, y]);
  const dOut = dist(k.out, [x, y]);
  const dIn = dist(k.in, [x, y]);
  let incoming: boolean;
  if (grabbed(k.out) && dOut <= dIn) {
    incoming = false;
  } else if (grabbed(k.in)) {
    incoming = true;
  } else {
    return false;
  }
  if (!pen.unlinked.includes(i)) pen.unlinked.push(i);
  pen.dragging = true;
  pen.adjustingLast = true;
  pen.adjustingIn = incoming;
  return true;
}

/** 撤销最后一锚(上游 pen_undo_last_point 的无 resume/无直选子集):空了=草稿取消。 */
export function penUndoLastPoint(pen: PenPath): PenPath | null {
  pen.knots.pop();
  pen.unlinked = pen.unlinked.filter((i) => i < pen.knots.length);
  pen.dragging = false;
  return pen.knots.length ? pen : null;
}

/** 闭合替身折进首锚:替身的手柄交给首锚(smooth,⌥ 断开后为尖角);非闭合=null(上游 fold_close)。 */
export function foldClose(pen: PenPath): PenPath | null {
  if (!closing(pen)) return null;
  const p: PenPath = {
    knots: pen.knots.map((k) => ({ anchor: [...k.anchor] as [number, number], in: [...k.in] as [number, number], out: [...k.out] as [number, number] })),
    unlinked: [...pen.unlinked],
    dragging: pen.dragging,
    adjustingLast: pen.adjustingLast,
    adjustingIn: pen.adjustingIn,
  };
  const standIn = p.knots.pop()!;
  const broken = p.unlinked.includes(p.knots.length);
  p.unlinked = p.unlinked.filter((i) => i < p.knots.length);
  if (standIn.in[0] !== standIn.anchor[0] || standIn.in[1] !== standIn.anchor[1] || standIn.out[0] !== standIn.anchor[0] || standIn.out[1] !== standIn.anchor[1]) {
    const first = p.knots[0];
    first.in = standIn.in;
    first.out = standIn.out;
    p.unlinked = p.unlinked.filter((i) => i !== 0);
    if (broken) p.unlinked.push(0);
  }
  return p;
}

/** 草稿 → 引擎 path JSON(上游 pen_to_json:闭合替身折入;smooth=非尖角且手柄有伸出)。 */
export function penToJson(pen: PenPath, closed: boolean): { subpaths: [{ closed: boolean; knots: { anchor: [number, number]; in: [number, number]; out: [number, number]; smooth: boolean }[] }] } {
  const folded = foldClose(pen);
  const [p, isClosed] = folded ? [folded, true] : [pen, closed];
  return {
    subpaths: [
      {
        closed: isClosed,
        knots: p.knots.map((k, i) => ({
          anchor: k.anchor,
          in: k.in,
          out: k.out,
          smooth: !p.unlinked.includes(i) && !(k.in[0] === k.anchor[0] && k.in[1] === k.anchor[1] && k.out[0] === k.anchor[0] && k.out[1] === k.anchor[1]),
        })),
      },
    ],
  };
}

// -------------------------------------------------------------------------------------------
// 曲线细分(上游 curve_points:屏幕空间自适应弦数,#4084)
// -------------------------------------------------------------------------------------------

/** 屏幕像素容差:弦偏离真曲线的上限。 */
export const CURVE_TOLERANCE = 0.3;
/** 每段最多弦数:0.3px 容差撑得住约 140 万 px 屏幕弯曲。 */
export const MAX_CURVE_PIECES = 1024;

const bez = (p0: number, c0: number, c1: number, p1: number, t: number): number => {
  const u = 1.0 - t;
  return u * u * u * p0 + 3.0 * u * u * t * c0 + 3.0 * u * t * t * c1 + t * t * t * p1;
};

const onChord = (a: [number, number], q: [number, number], d: [number, number]): boolean => {
  const [dx, dy] = [d[0] - a[0], d[1] - a[1]];
  const [vx, vy] = [q[0] - a[0], q[1] - a[1]];
  const len = Math.hypot(dx, dy);
  if (len < 1e-9) return Math.hypot(vx, vy) < 1e-3;
  const t = (vx * dx + vy * dy) / (len * len);
  if (t < -1e-9 || t > 1.0 + 1e-9) return false;
  return Math.hypot(vx - t * dx, vy - t * dy) < 1e-3;
};

/** 一条三次贝塞尔段的屏幕折线(两端含):弦数按弯曲度自适应(直线=1 弦;缩放越大越顺滑)。
 * 界:max|B''|/8n² ≤ tol,max|B''| ≤ 6·max(|p0−2c0+c1|,|c0−2c1+p1|)。 */
export function curvePoints(
  p0: [number, number],
  c0: [number, number],
  c1: [number, number],
  p1: [number, number],
  toScr: (q: [number, number]) => [number, number],
): [number, number][] {
  const [a, b, c, d] = [p0, c0, c1, p1].map(toScr);
  const second = (p: [number, number], q: [number, number], r: [number, number]): number =>
    Math.hypot(p[0] - 2.0 * q[0] + r[0], p[1] - 2.0 * q[1] + r[1]);
  const raw = Math.sqrt((0.75 * Math.max(second(a, b, c), second(b, c, d))) / CURVE_TOLERANCE);
  const n = Number.isFinite(raw) && !(onChord(a, b, d) && onChord(a, c, d))
    ? Math.min(MAX_CURVE_PIECES, Math.max(1, Math.ceil(raw)))
    : 1;
  const out: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n;
    out.push([bez(a[0], b[0], c[0], d[0], t), bez(a[1], b[1], c[1], d[1], t)]);
  }
  return out;
}
