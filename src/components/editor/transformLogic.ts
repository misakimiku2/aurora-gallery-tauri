/**
 * 自由变换纯几何(上游 ui-egui/src/transform_tool.rs 逐行移植,零 UI 依赖)。
 *
 * 口径:唯一事实源 = TransformSession{rect 源框, quad 四角(顺时针自左上,文档像素),
 * pivot 参考点};所有拖拽从按下快照 Gesture 重算,修饰键中途切换天然生效。
 * 单位:内部角度弧度;命令面 rotate 是度;scaleX/Y 是百分数;quad/rect/pivot 文档像素。
 * Homography 数学 = vendor crates/algo/src/transform.rs 1:1。
 */

import type { WarpObject } from './warpLogic';

// ---- Homography(vendor algo/transform.rs 1:1,行主序 3×3)----

export class Homography {
  constructor(readonly m: [number, number, number, number, number, number, number, number, number]) {}

  static IDENTITY = new Homography([1, 0, 0, 0, 1, 0, 0, 0, 1]);

  isIdentity(): boolean {
    const m = this.m;
    if (Math.abs(m[8]) < 1e-12) return false;
    const w = m[8];
    return (
      Math.abs(m[0] / w - 1) < 1e-9 && Math.abs(m[4] / w - 1) < 1e-9 &&
      Math.abs(m[1] / w) < 1e-9 && Math.abs(m[2] / w) < 1e-9 &&
      Math.abs(m[3] / w) < 1e-9 && Math.abs(m[5] / w) < 1e-9 &&
      Math.abs(m[6] / w) < 1e-9 && Math.abs(m[7] / w) < 1e-9
    );
  }

  apply(x: number, y: number): [number, number] {
    const m = this.m;
    const w = m[6] * x + m[7] * y + m[8];
    return [(m[0] * x + m[1] * y + m[2]) / w, (m[3] * x + m[4] * y + m[5]) / w];
  }

  /** 齐次 w(x,y):符号 = 点映射到地平线哪一侧(0 = 地平线上)。 */
  w(x: number, y: number): number {
    const m = this.m;
    return m[6] * x + m[7] * y + m[8];
  }

  mul(o: Homography): Homography {
    const a = this.m, b = o.m;
    const r = [0, 0, 0, 0, 0, 0, 0, 0, 0] as Homography['m'];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        let s = 0;
        for (let k = 0; k < 3; k++) s += a[i * 3 + k] * b[k * 3 + j];
        r[i * 3 + j] = s;
      }
    }
    return new Homography(r);
  }

  inverse(): Homography | null {
    const m = this.m;
    const c: Homography['m'] = [
      m[4] * m[8] - m[5] * m[7],
      m[2] * m[7] - m[1] * m[8],
      m[1] * m[5] - m[2] * m[4],
      m[5] * m[6] - m[3] * m[8],
      m[0] * m[8] - m[2] * m[6],
      m[2] * m[3] - m[0] * m[5],
      m[3] * m[7] - m[4] * m[6],
      m[1] * m[6] - m[0] * m[7],
      m[0] * m[4] - m[1] * m[3],
    ];
    const det = m[0] * c[0] + m[1] * c[3] + m[2] * c[6];
    if (Math.abs(det) < 1e-12) return null;
    return new Homography(c.map((v) => v / det) as Homography['m']);
  }

  /** 单位方块 → 四角((0,0),(1,0),(1,1),(0,1) 顺时针)。仿射快路径(对边平行)。 */
  static squareToQuad(q: Quad): Homography | null {
    const [x0, y0] = q[0], [x1, y1] = q[1], [x2, y2] = q[2], [x3, y3] = q[3];
    const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
    if (Math.abs(sx) < 1e-12 && Math.abs(sy) < 1e-12) {
      return new Homography([x1 - x0, x3 - x0, x0, y1 - y0, y3 - y0, y0, 0, 0, 1]);
    }
    const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2;
    const den = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(den) < 1e-12) return null;
    const g = (sx * dy2 - dx2 * sy) / den;
    const h = (dx1 * sy - sx * dy1) / den;
    return new Homography([x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1]);
  }

  /** rect (x0,y0,x1,y1) → quad(顺时针自左上)的映射;退化 quad = null。 */
  static rectToQuad(r: RectF, quad: Quad): Homography | null {
    const w = r[2] - r[0], h = r[3] - r[1];
    if (w <= 0 || h <= 0) return null;
    const toUnit = new Homography([1 / w, 0, -r[0] / w, 0, 1 / h, -r[1] / h, 0, 0, 1]);
    const sq = Homography.squareToQuad(quad);
    return sq ? sq.mul(toUnit) : null;
  }
}

// ---- 基本类型 ----

export type RectF = [number, number, number, number];
export type Pt = [number, number];
/** 四角顺时针自左上:TL, TR, BR, BL(文档像素)。 */
export type Quad = [Pt, Pt, Pt, Pt];

export const corners = (r: RectF): Quad => [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]];

/** quad 与 corners(rect) 全等(位相等):未改动 = 零历史提交短路。 */
export const quadUnchanged = (rect: RectF, quad: Quad): boolean => {
  const c = corners(rect);
  return quad.every((q, i) => q[0] === c[i][0] && q[1] === c[i][1]);
};

export type TransformMode = 'free' | 'rotate' | 'skew' | 'distort' | 'perspective';

export interface TransformSession {
  layer: number;
  /** 源框 [x0,y0,x1,y1](引擎 transform_frame 口径,可超画布)。 */
  rect: RectF;
  quad: Quad;
  pivot: Pt;
  interpolation: string;
  mode: TransformMode;
  /** 蒙版目标(提交带 target:"mask")。 */
  targetMask: boolean;
  /** 选项栏键入的 V 斜切(度),Parts 分解保持显示。 */
  skewV: number;
  /** 目标层 kind("Pixel"/"Type"/…;Type 层 Distort/Perspective 降级)。 */
  kind?: string;
  /** Warp 模式(上游 t.warp.is_some()):正在编辑的 warp 对象;null/缺省=框模式。 */
  warp?: WarpObject | null;
  /** 变换选区(上游 t.selection):只变换选区蒙版,像素不动;提交 select.transformSelection。 */
  selection?: boolean;
  /** ⌥⌘T 复制出的层(上游 t.made=Copy):提交成功后折叠复制步,取消时收回。 */
  madeLayer?: number | null;
  /** ⌥⌘T 复制**前**的历史步数(折叠条件 before+2 守卫用)。 */
  madeBefore?: number;
}

export type Hit =
  | { kind: 'corner'; i: number }
  | { kind: 'edge'; i: number }
  | { kind: 'pivot' }
  | { kind: 'inside' }
  | { kind: 'outside' };

export interface Gesture {
  hit: Hit;
  start: Pt;
  quad0: Quad;
  pivot0: Pt;
}

/** 拖拽修饰键(画布指针事件 + 键盘 ref 折算后的有效值)。 */
export interface TransformMods {
  shift: boolean;
  alt: boolean;
  command: boolean;
}

/** 把手抓取半径(屏幕 px;上游 HANDLE_PX)。 */
export const HANDLE_PX = 12;

/** 文档空间的把手容差(HANDLE_PX / 缩放)。 */
export const handleTolerance = (zoom: number): number => HANDLE_PX / Math.max(0.01, zoom);

// ---- 命中(上游 1397-1430)----

/** 9 把手(4 角+4 边中点+pivot)取最近且 < tol 者,否则点积射线 inside/outside。 */
export function hitTest(t: Pick<TransformSession, 'quad' | 'pivot'>, p: Pt, tol: number): Hit {
  const d = (a: Pt) => Math.hypot(a[0] - p[0], a[1] - p[1]);
  const mid = (i: number): Pt => {
    const [a, b] = [t.quad[i], t.quad[(i + 1) % 4]];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  const handles: Array<[Pt, Hit]> = [
    ...([0, 1, 2, 3] as const).map((i) => [t.quad[i], { kind: 'corner', i } as Hit] as [Pt, Hit]),
    ...([0, 1, 2, 3] as const).map((i) => [mid(i), { kind: 'edge', i } as Hit] as [Pt, Hit]),
    [t.pivot, { kind: 'pivot' } as Hit] as [Pt, Hit],
  ];
  let best: { dist: number; hit: Hit } | null = null;
  for (const [q, h] of handles) {
    const dist = d(q);
    if (dist < tol && (best === null || dist < best.dist)) best = { dist, hit: h };
  }
  if (best) return best.hit;
  return insideQuad(t.quad, p) ? { kind: 'inside' } : { kind: 'outside' };
}

/** 点积射线奇偶规则(上游 inside)。 */
export function insideQuad(q: Quad, p: Pt): boolean {
  let c = false;
  for (let i = 0; i < 4; i++) {
    const a = q[i], b = q[(i + 3) % 4];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}

/** 框外单击=提交(#2851):hit=Outside 且位移 ≤ 2 屏幕点(吸收指针抖动,拖拽旋转不误触)。 */
export const acceptsOutsideClick = (g: Gesture, end: Pt, tol: number): boolean =>
  g.hit.kind === 'outside' && Math.hypot(end[0] - g.start[0], end[1] - g.start[1]) <= (2 * tol) / HANDLE_PX;

// ---- 凸性(上游 1688-1718)----

/** 每角转向(连续边叉积):全同号 = 凸四边形。 */
export function turns(q: Quad): [number, number, number, number] {
  return [0, 1, 2, 3].map((k) => {
    const [a, b, c] = [q[k], q[(k + 1) % 4], q[(k + 2) % 4]];
    return (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
  }) as [number, number, number, number];
}

const convexWith = (q: Quad, sign: number, minTurn: number): boolean =>
  turns(q).every((t) => t * sign > minTurn);

/** Distort/透视在框将翻转处停下(#1323):从 from 向 to 插值到凸为止;起始非凸不约束。 */
export function keepConvex(from: Quad, to: Quad): Quad {
  const t0 = turns(from);
  const sign = Math.sign(t0[0]);
  const minTurn = Math.min(...t0.map((t) => Math.abs(t))) * 1e-3;
  if (!(Number.isFinite(minTurn) && minTurn > 0 && convexWith(from, sign, 0)) || convexWith(to, sign, minTurn)) {
    return to;
  }
  const lerp = (t: number): Quad =>
    [0, 1, 2, 3].map((k) => [from[k][0] + (to[k][0] - from[k][0]) * t, from[k][1] + (to[k][1] - from[k][1]) * t] as Pt) as Quad;
  let lo = 0, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (convexWith(lerp(mid), sign, minTurn)) lo = mid;
    else hi = mid;
  }
  return lerp(lo);
}

// ---- 参考点(上游 1868-1915)----

export function anchorUv(anchor: number): [number, number] {
  const t: Record<number, [number, number]> = {
    0: [0, 0], 1: [0.5, 0], 2: [1, 0], 3: [0, 0.5], 4: [0.5, 0.5],
    5: [1, 0.5], 6: [0, 1], 7: [0.5, 1], 8: [1, 1],
  };
  return t[anchor] ?? [0.5, 0.5];
}

/** 9 宫格锚点(0..8 = TL,TM,TR,ML,C,MR,BL,BM,BR)落在 quad 上的文档坐标;退化用均值兜底。 */
export function pointOnQuad(quad: Quad, anchor: number): Pt {
  const [u, v] = anchorUv(anchor);
  const h = Homography.rectToQuad([0, 0, 1, 1], quad);
  if (h) {
    const [x, y] = h.apply(u, v);
    if (Number.isFinite(x) && Number.isFinite(y)) return [x, y];
  }
  const avg = (pts: Pt[]): Pt => [
    pts.reduce((s, p) => s + p[0], 0) / pts.length,
    pts.reduce((s, p) => s + p[1], 0) / pts.length,
  ];
  switch (anchor) {
    case 0: return quad[0];
    case 1: return avg([quad[0], quad[1]]);
    case 2: return quad[1];
    case 3: return avg([quad[0], quad[3]]);
    case 4: return avg(quad);
    case 5: return avg([quad[1], quad[2]]);
    case 6: return quad[3];
    case 7: return avg([quad[2], quad[3]]);
    case 8: return quad[2];
    default: return avg(quad);
  }
}

/** pivot 在 9 宫格上的当前锚点(0.05 px 内);未对齐 = null。 */
export function matchingAnchor(quad: Quad, pivot: Pt): number | null {
  for (let i = 0; i < 9; i++) {
    const p = pointOnQuad(quad, i);
    if (Math.abs(p[0] - pivot[0]) <= 0.05 && Math.abs(p[1] - pivot[1]) <= 0.05) return i;
  }
  return null;
}

/** 框从 quad0 变到 quad 时 pivot 保持它在框内的相对位置(#1329);框塌了原地不动。 */
export function carryPivot(quad0: Quad, quad: Quad, pivot0: Pt): Pt {
  const unit: RectF = [0, 0, 1, 1];
  const h0 = Homography.rectToQuad(unit, quad0);
  const h1 = Homography.rectToQuad(unit, quad);
  if (!h0 || !h1) return pivot0;
  const inv = h0.inverse();
  if (!inv) return pivot0;
  const [u, v] = inv.apply(pivot0[0], pivot0[1]);
  const [x, y] = h1.apply(u, v);
  return Number.isFinite(x) && Number.isFinite(y) ? [x, y] : pivot0;
}

// ---- 拖拽几何(上游 apply_drag 1720-1866)----

/** ⇧ 锁 8 向(轴+斜向;不取整——变换框要小数;迟滞 8° 同 move_mods::constrain)。 */
export function constrainDrag(d: Pt, prev: Pt | null): Pt {
  const len = Math.hypot(d[0], d[1]);
  if (!Number.isFinite(len) || len === 0) return d;
  const step = (Math.PI * 2) / 8;
  const a = Math.atan2(d[1], d[0]);
  let k = Math.round(a / step);
  if (prev && Math.hypot(prev[0], prev[1]) > 0) {
    const kp = Math.round(Math.atan2(prev[1], prev[0]) / step);
    const off = ((a - kp * step) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
    if (off < step / 2 + (8 * Math.PI) / 180) k = kp;
  }
  const s = Math.sin(k * step), c = Math.cos(k * step);
  const t = Math.max(0, d[0] * c + d[1] * s);
  return [t * c, t * s];
}

/** 一个手势在当前修饰键下的新 quad/pivot(从按下快照重算;原 session 原样返回当几何不可解)。 */
export function applyDrag(
  s: Pick<TransformSession, 'quad' | 'pivot'>,
  g: Gesture,
  p: Pt,
  mods: TransformMods,
): { quad: Quad; pivot: Pt } {
  const dx = p[0] - g.start[0];
  const dy = p[1] - g.start[1];
  const { hit } = g;

  if (hit.kind === 'inside') {
    let [ndx, ndy] = [dx, dy];
    if (mods.shift) {
      const prev: Pt = [s.quad[0][0] - g.quad0[0][0], s.quad[0][1] - g.quad0[0][1]];
      [ndx, ndy] = constrainDrag([dx, dy], prev);
    }
    return {
      quad: g.quad0.map((q) => [q[0] + ndx, q[1] + ndy] as Pt) as Quad,
      pivot: [g.pivot0[0] + ndx, g.pivot0[1] + ndy],
    };
  }

  if (hit.kind === 'pivot') return { quad: s.quad, pivot: p };

  if (hit.kind === 'outside') {
    const a0 = Math.atan2(g.start[1] - g.pivot0[1], g.start[0] - g.pivot0[0]);
    const a1 = Math.atan2(p[1] - g.pivot0[1], p[0] - g.pivot0[0]);
    let da = a1 - a0;
    if (mods.shift) {
      // 结果角吸附 15° 步(基准=框自身顶边方向,再反解 da)。
      const base = Math.atan2(g.quad0[1][1] - g.quad0[0][1], g.quad0[1][0] - g.quad0[0][0]);
      const step = (15 * Math.PI) / 180;
      da = Math.round((base + da) / step) * step - base;
    }
    const sn = Math.sin(da), cs = Math.cos(da);
    const c = g.pivot0;
    return {
      quad: g.quad0.map((q) => {
        const x = q[0] - c[0], y = q[1] - c[1];
        return [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs] as Pt;
      }) as Quad,
      pivot: s.pivot,
    };
  }

  if (hit.kind === 'corner' && mods.command && mods.alt && mods.shift) {
    // 透视:角沿主导轴动,共边角反向同量。
    const i = hit.i;
    const horizontal = Math.abs(dx) >= Math.abs(dy);
    const j = horizontal
      ? [1, 0, 3, 2][i]
      : [3, 2, 1, 0][i];
    const [mx, my] = horizontal ? [dx, 0] : [0, dy];
    const q = g.quad0.map((q) => [...q] as Pt) as Quad;
    q[i] = [g.quad0[i][0] + mx, g.quad0[i][1] + my];
    q[j] = [g.quad0[j][0] - mx, g.quad0[j][1] - my];
    const quad = keepConvex(g.quad0, q);
    return { quad, pivot: carryPivot(g.quad0, quad, g.pivot0) };
  }

  if (hit.kind === 'corner' && mods.command) {
    // Distort:角自由动,到框翻转为止。
    const i = hit.i;
    const q = g.quad0.map((q) => [...q] as Pt) as Quad;
    q[i] = [g.quad0[i][0] + dx, g.quad0[i][1] + dy];
    const quad = keepConvex(g.quad0, q);
    return { quad, pivot: carryPivot(g.quad0, quad, g.pivot0) };
  }

  if (hit.kind === 'edge' && mods.command) {
    // Skew:边两端同移(⇧ 只沿边;⌥ 对边反向)。
    const i = hit.i;
    const a = i, b = (i + 1) % 4;
    let [mx, my] = [dx, dy];
    if (mods.shift) {
      const e: Pt = [g.quad0[b][0] - g.quad0[a][0], g.quad0[b][1] - g.quad0[a][1]];
      const l2 = e[0] * e[0] + e[1] * e[1];
      const t = l2 > 0 ? (dx * e[0] + dy * e[1]) / l2 : 0;
      [mx, my] = [t * e[0], t * e[1]];
    }
    const quad = g.quad0.map((q) => [...q] as Pt) as Quad;
    quad[a] = [g.quad0[a][0] + mx, g.quad0[a][1] + my];
    quad[b] = [g.quad0[b][0] + mx, g.quad0[b][1] + my];
    if (mods.alt) {
      const c = (i + 2) % 4, d = (i + 3) % 4;
      quad[c] = [g.quad0[c][0] - mx, g.quad0[c][1] - my];
      quad[d] = [g.quad0[d][0] - mx, g.quad0[d][1] - my];
    }
    return { quad, pivot: carryPivot(g.quad0, quad, g.pivot0) };
  }

  if (hit.kind === 'corner' || hit.kind === 'edge') {
    // 比例缩放:在框自身(单位)坐标系工作,旋转/斜切框沿自身轴缩放。
    const h = Homography.rectToQuad([0, 0, 1, 1], g.quad0);
    const inv = h?.inverse();
    if (!h || !inv) return { quad: s.quad, pivot: s.pivot };
    const [u, v] = inv.apply(p[0], p[1]);
    const [pu, pv] = inv.apply(g.pivot0[0], g.pivot0[1]);
    // 单位框被拖动的边:(u=0, u=1) 与 (v=0, v=1)。
    let mu: [boolean, boolean], mv: [boolean, boolean];
    if (hit.kind === 'corner') {
      [mu, mv] = hit.i === 0 ? [[true, false], [true, false]]
        : hit.i === 1 ? [[false, true], [true, false]]
        : hit.i === 2 ? [[false, true], [false, true]]
        : [[true, false], [false, true]];
    } else {
      [mu, mv] = hit.i === 0 ? [[false, false], [true, false]]
        : hit.i === 1 ? [[false, true], [false, false]]
        : hit.i === 2 ? [[false, false], [false, true]]
        : [[true, false], [false, false]];
    }
    // 每轴绕锚(对边;⌥=参考点)缩放,把手跟手。
    const axis = (moving: [boolean, boolean], at: number, pivot: number): [number, number] => {
      if (!moving[0] && !moving[1]) return [0.5, 1];
      const handle = moving[0] ? 0 : 1;
      const anchor = mods.alt ? pivot : 1 - handle;
      const d = handle - anchor;
      const k = Math.abs(d) > 1e-9 ? (at - anchor) / d : 1;
      return [anchor, Number.isFinite(k) ? k : 1];
    };
    let [au, ku] = axis(mu, u, pu);
    let [av, kv] = axis(mv, v, pv);
    const corner = hit.kind === 'corner';
    if (!corner && !mods.shift) {
      // 边定自身轴,另一轴随同因子(绕框中;⌥=绕参考点)缩放。
      if (mu[0] || mu[1]) {
        av = mods.alt ? pv : 0.5;
        kv = Math.abs(ku);
      } else {
        au = mods.alt ? pu : 0.5;
        ku = Math.abs(kv);
      }
    }
    if (corner && !mods.shift) {
      // 角默认等比(max(|ku|,|kv|) 共享);⇧ 释放单轴。
      const k = Math.max(Math.abs(ku), Math.abs(kv));
      ku = k * Math.sign(ku);
      kv = k * Math.sign(kv);
    }
    const r: RectF = [au - au * ku, av - av * kv, au + (1 - au) * ku, av + (1 - av) * kv];
    const map = (a: number, b: number): Pt => {
      const [x, y] = h.apply(a, b);
      return [x, y];
    };
    const quad: Quad = [map(r[0], r[1]), map(r[2], r[1]), map(r[2], r[3]), map(r[0], r[3])];
    return { quad, pivot: mods.alt ? g.pivot0 : carryPivot(g.quad0, quad, g.pivot0) };
  }

  return { quad: s.quad, pivot: s.pivot };
}

// ---- Edit›Transform 模式(上游 apply_mode_drag/mode_allows/mode_mods)----

/** 模式下手势许可:Distort 只认角+内拖;Skew 不认框外(旋转)。 */
export function modeAllows(mode: TransformMode, h: Hit): boolean {
  if (mode === 'distort') return h.kind !== 'outside' && h.kind !== 'edge';
  if (mode === 'skew') return h.kind !== 'outside';
  return true;
}

/** Distort/Perspective 模式把角拖改写为带修饰键的手势。 */
export function modeMods(mode: TransformMode, hit: Hit, mods: TransformMods): TransformMods {
  const m = { ...mods };
  if (mode === 'distort' && hit.kind === 'corner') m.command = true;
  if (mode === 'perspective' && hit.kind === 'corner') {
    m.command = true;
    m.alt = true;
    m.shift = true;
  }
  return m;
}

/** 模式手势分派(Skew 角拖沿邻边滑动、Rotate 把角/边改写为框外旋转;其余套 modeMods)。 */
export function applyModeDrag(
  s: Pick<TransformSession, 'quad' | 'pivot' | 'mode'>,
  g: Gesture,
  p: Pt,
  typeLayer: boolean,
  mods: TransformMods,
): { quad: Quad; pivot: Pt } {
  if (!modeAllows(s.mode, g.hit)) return { quad: s.quad, pivot: s.pivot };
  if (s.mode === 'skew' && g.hit.kind === 'corner') {
    // Skew:角沿两条邻边中拖动投影较大者单独移动;⌥ 对角反向;类型层整边一起滑。
    const i = g.hit.i;
    const d: Pt = [p[0] - g.start[0], p[1] - g.start[1]];
    const along = (j: number): Pt => {
      const e: Pt = [g.quad0[i][0] - g.quad0[j][0], g.quad0[i][1] - g.quad0[j][1]];
      const l = Math.hypot(e[0], e[1]);
      const u: Pt = l > 0 ? [e[0] / l, e[1] / l] : [0, 0];
      const t = d[0] * u[0] + d[1] * u[1];
      return [t * u[0], t * u[1]];
    };
    const hn = [1, 0, 3, 2][i], vn = [3, 2, 1, 0][i];
    const h = along(hn), v = along(vn);
    const [m, partner] = Math.hypot(h[0], h[1]) >= Math.hypot(v[0], v[1]) ? [h, hn] : [v, vn];
    const moved = typeLayer ? [i, partner] : [i];
    const quad = g.quad0.map((q) => [...q] as Pt) as Quad;
    for (let k = 0; k < 4; k++) {
      let sign: number;
      if (moved.includes(k)) sign = 1;
      else if (mods.alt && (typeLayer || k === (i + 2) % 4)) sign = -1;
      else continue;
      quad[k] = [g.quad0[k][0] + sign * m[0], g.quad0[k][1] + sign * m[1]];
    }
    const kept = keepConvex(g.quad0, quad);
    return { quad: kept, pivot: carryPivot(g.quad0, kept, g.pivot0) };
  }
  if (s.mode === 'rotate' && (g.hit.kind === 'corner' || g.hit.kind === 'edge')) {
    return applyDrag(s, { ...g, hit: { kind: 'outside' } }, p, mods);
  }
  if (s.mode === 'skew' && g.hit.kind === 'edge') {
    return applyDrag(s, g, p, { ...mods, command: true, shift: true });
  }
  return applyDrag(s, g, p, modeMods(s.mode, g.hit, mods));
}

// ---- 仿射分解与数值变换(上游 Parts/readout 2680-2830)----

/** quad 是否平行四边形(仿射;提交 path.transform/预览单次贴图用)。 */
export function quadIsAffine(r: RectF, q: Quad): boolean {
  const w = r[2] - r[0], h = r[3] - r[1];
  if (w <= 0 || h <= 0) return false;
  const tol = 1e-3 * (1 + Math.max(w, h));
  return (
    Math.abs(q[0][0] + q[2][0] - q[1][0] - q[3][0]) <= tol &&
    Math.abs(q[0][1] + q[2][1] - q[1][1] - q[3][1]) <= tol
  );
}

/** `v` 保号避零(负 W/H 缩放的除数)。 */
const nonzero = (v: number): number => (Math.abs(v) < 1e-9 ? 1e-9 * Math.sign(v || 1) : v);

/** 框的列(单位 X/Y 边的去向);退化 null。 */
function partsColumns(t: Pick<TransformSession, 'rect' | 'quad'>): [[number, number], [number, number]] | null {
  const w0 = t.rect[2] - t.rect[0], h0 = t.rect[3] - t.rect[1];
  if (Math.abs(w0) < 1e-9 || Math.abs(h0) < 1e-9) return null;
  const q = t.quad;
  const m: [[number, number], [number, number]] = [
    [(q[1][0] - q[0][0]) / w0, (q[1][1] - q[0][1]) / w0],
    [(q[3][0] - q[0][0]) / h0, (q[3][1] - q[0][1]) / h0],
  ];
  return m.every((c) => c.every((v) => Number.isFinite(v))) ? m : null;
}

/** `c` 逆时针转回 angle。 */
const unturn = (c: Pt, angle: number): [number, number] => {
  const sn = Math.sin(angle), cs = Math.cos(angle);
  return [c[0] * cs + c[1] * sn, -c[0] * sn + c[1] * cs];
};

export interface Parts {
  sx: number;
  /** 相对旋转方向垂直翻转时为负。 */
  sy: number;
  angle: number;
  skewH: number;
  skewV: number;
}

/** 列 → scale·skew·rotate 分解(X 边方向 = angle + skewV)。 */
function partsFromColumns([c0, c1]: [[number, number], [number, number]], skewV: number): Parts {
  const angle = Math.atan2(c0[1], c0[0]) - skewV;
  const sx = Math.hypot(c0[0], c0[1]) * Math.cos(skewV);
  const [gx, gy] = unturn(c1, angle);
  const skewH = Math.abs(gy) < 1e-12 ? 0 : Math.atan(-gx / gy);
  return { sx, sy: gy, angle, skewH, skewV };
}

function partsToColumns(p: Parts): [[number, number], [number, number]] {
  const sn = Math.sin(p.angle), cs = Math.cos(p.angle);
  const rot = (x: number, y: number): Pt => [x * cs - y * sn, x * sn + y * cs];
  const c0 = rot(p.sx, p.sx * Math.tan(p.skewV));
  const c1 = rot(-p.sy * Math.tan(p.skewH), p.sy);
  return [c0, c1];
}

/** 选项栏读数(W/H %, angle°, skewH°):镜像读作负 W/H,取角度更近 0 的表示。 */
export function readout(t: Pick<TransformSession, 'rect' | 'quad' | 'skewV'>): { wPct: number; hPct: number; angleDeg: number; skewHDeg: number } {
  const skewV = t.skewV * (Math.PI / 180);
  const none: Parts = { sx: 1, sy: 1, angle: 0, skewH: 0, skewV };
  const p = partsColumns(t) ? partsFromColumns(partsColumns(t)!, skewV) : none;
  const wrap = (a: number): number => {
    const w = ((a % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
    return w > Math.PI ? w - Math.PI * 2 : w;
  };
  const turned = wrap(p.angle + Math.PI);
  let { sx, sy, angle } = p;
  if (p.sy < 0 && Math.abs(turned) < Math.abs(wrap(p.angle))) {
    sx = -p.sx;
    sy = -p.sy;
    angle = turned;
  }
  return { wPct: sx * 100, hPct: sy * 100, angleDeg: (angle * 180) / Math.PI, skewHDeg: (p.skewH * 180) / Math.PI };
}

const SKEW_LIMIT = 89;

/** 绕参考点缩放(框自身轴;选项栏 W/H 用)。 */
export function scaleAboutPivot(s: TransformSession, kx: number, ky: number): TransformSession {
  const h = Homography.rectToQuad([0, 0, 1, 1], s.quad);
  const inv = h?.inverse();
  if (!h || !inv) return s;
  const [pu, pv] = inv.apply(s.pivot[0], s.pivot[1]);
  const m = (u: number, v: number): Pt => {
    const [x, y] = h.apply(pu + (u - pu) * kx, pv + (v - pv) * ky);
    return [x, y];
  };
  return { ...s, quad: [m(0, 0), m(1, 0), m(1, 1), m(0, 1)] };
}

/** 绕参考点旋转 da 弧度(选项栏角度用)。 */
export function rotateAboutPivot(s: TransformSession, da: number): TransformSession {
  const sn = Math.sin(da), cs = Math.cos(da);
  const c = s.pivot;
  return {
    ...s,
    quad: s.quad.map((q) => {
      const x = q[0] - c[0], y = q[1] - c[1];
      return [c[0] + x * cs - y * sn, c[1] + x * sn + y * cs] as Pt;
    }) as Quad,
  };
}

/** 设 H/V 斜切(度),保缩放/角度/参考点;限 ±89°。 */
export function skewAboutPivot(s: TransformSession, skewH: number, skewV: number): TransformSession {
  const m = partsColumns(s);
  if (!m) return s;
  const limit = SKEW_LIMIT;
  const sh = Math.max(-limit, Math.min(limit, skewH)) * (Math.PI / 180);
  const sv = Math.max(-limit, Math.min(limit, skewV)) * (Math.PI / 180);
  const from = partsFromColumns(m, s.skewV * (Math.PI / 180));
  const to = partsToColumns({ ...from, skewH: sh, skewV: sv });
  const det = m[0][0] * m[1][1] - m[1][0] * m[0][1];
  if (Math.abs(det) < 1e-12) return s;
  const inv: [[number, number], [number, number]] = [[m[1][1] / det, -m[0][1] / det], [-m[1][0] / det, m[0][0] / det]];
  const l = (x: number, y: number): Pt => {
    const u = inv[0][0] * x + inv[1][0] * y;
    const v = inv[0][1] * x + inv[1][1] * y;
    return [to[0][0] * u + to[1][0] * v, to[0][1] * u + to[1][1] * v];
  };
  const c = s.pivot;
  const quad = s.quad.map((q) => {
    const d = l(q[0] - c[0], q[1] - c[1]);
    return [c[0] + d[0], c[1] + d[1]] as Pt;
  }) as Quad;
  if (quad.every((q) => q.every((v) => Number.isFinite(v)))) return { ...s, quad, skewV: skewV };
  return s;
}

/** 参考点 X/Y 字段:平移 quad+pivot 使 pivot 到位。 */
export function movePivotTo(s: TransformSession, x: number, y: number): TransformSession {
  const dx = x - s.pivot[0], dy = y - s.pivot[1];
  return {
    ...s,
    quad: s.quad.map((q) => [q[0] + dx, q[1] + dy] as Pt) as Quad,
    pivot: [x, y],
  };
}

/** 9 宫格锚点设 pivot。 */
export function setPivotAnchor(s: TransformSession, anchor: number): TransformSession {
  return { ...s, pivot: pointOnQuad(s.quad, anchor) };
}

/** 方向键微移(框+pivot 同移;上游 nudge)。 */
export function nudgeTransform(s: TransformSession, dx: number, dy: number): TransformSession {
  return {
    ...s,
    quad: s.quad.map((q) => [q[0] + dx, q[1] + dy] as Pt) as Quad,
    pivot: [s.pivot[0] + dx, s.pivot[1] + dy],
  };
}

/** 框相对原尺寸的放大倍数(最长边比;预览贴图 filter 选择用)。 */
export function quadScale(t: Pick<TransformSession, 'rect' | 'quad'>): number {
  const w0 = Math.max(1e-9, t.rect[2] - t.rect[0]);
  const h0 = Math.max(1e-9, t.rect[3] - t.rect[1]);
  const len = (a: Pt, b: Pt) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  const q = t.quad;
  const s = Math.max(len(q[0], q[1]) / w0, len(q[3], q[2]) / w0, len(q[0], q[3]) / h0, len(q[1], q[2]) / h0);
  return Number.isFinite(s) ? s : 1;
}

/** 提交参数:quad 优先,仿射退化为 matrix(引擎 quad > matrix > relative 同序)。 */
export function transformCommitParams(t: TransformSession): Record<string, unknown> {
  const p: Record<string, unknown> = {
    layer: t.layer,
    rect: t.rect,
    quad: t.quad,
    interpolation: t.interpolation,
  };
  if (t.targetMask) p.target = 'mask';
  return p;
}

// ---- 会话内步骤(Undo/Redo,上游 Steps;步快照含 warp 整体克隆)----

export interface TransformStep {
  rect: RectF;
  quad: Quad;
  pivot: Pt;
  skewV: number;
  warp: WarpObject | null;
}

const cloneWarp = (w: WarpObject | null | undefined): WarpObject | null =>
  w ? { ...w, bounds: [...w.bounds] as RectF, mesh: w.mesh ? { us: [...w.mesh.us], vs: [...w.mesh.vs], points: w.mesh.points.map((p) => [...p] as Pt) } : null } : null;

export const stepOf = (t: TransformSession): TransformStep => ({ rect: [...t.rect] as RectF, quad: t.quad.map((q) => [...q] as Pt) as Quad, pivot: [...t.pivot] as Pt, skewV: t.skewV, warp: cloneWarp(t.warp) });

export const restoreStep = (t: TransformSession, st: TransformStep): TransformSession => ({
  ...t,
  rect: [...st.rect] as RectF,
  quad: st.quad.map((q) => [...q] as Pt) as Quad,
  pivot: [...st.pivot] as Pt,
  skewV: st.skewV,
  warp: cloneWarp(st.warp),
});

const warpEq = (a: WarpObject | null, b: WarpObject | null): boolean => {
  if (a === b) return true;
  if (!a || !b) return false;
  const sameMesh = !a.mesh && !b.mesh ? true : !!a.mesh && !!b.mesh && a.mesh.us.length === b.mesh.us.length && a.mesh.vs.length === b.mesh.vs.length && a.mesh.points.length === b.mesh.points.length &&
    a.mesh.points.every((p, i) => p[0] === b.mesh!.points[i][0] && p[1] === b.mesh!.points[i][1]);
  return a.style === b.style && a.bend === b.bend && a.hDistort === b.hDistort && a.vDistort === b.vDistort && a.vertical === b.vertical &&
    a.bounds.every((v, i) => v === b.bounds[i]) && sameMesh;
};

export const stepEq = (a: TransformStep, b: TransformStep): boolean =>
  a.skewV === b.skewV && a.pivot[0] === b.pivot[0] && a.pivot[1] === b.pivot[1] &&
  warpEq(a.warp, b.warp) &&
  a.rect.every((v, i) => v === b.rect[i]) &&
  a.quad.every((q, i) => q[0] === b.quad[i][0] && q[1] === b.quad[i][1]);
