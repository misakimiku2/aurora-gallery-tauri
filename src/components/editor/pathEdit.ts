/**
 * 路径点级编辑纯几何(二期 二-3,上游 crates/vector/src/edit.rs 逐行移植):
 * 直接选择的移动锚点/拖方向柄/拖段变形、转换点、加减锚点,与命中测试。
 * 引擎 path.* 编辑命令与画布预览共用同一套几何——预览即提交内容。
 * 锚点寻址 [subpath, knot];所有编辑校验下标,非法返回 null/错误而不是抛异常。
 * 曲率钢笔族(curvature_knots/move_anchors_curvature)属 S6,未移植。
 */

export type Pt = [number, number];
export type Handle = 'in' | 'out';

export interface EditKnot {
  anchor: Pt;
  in: Pt;
  out: Pt;
  smooth: boolean;
}

export interface EditSubpath {
  closed: boolean;
  knots: EditKnot[];
  op?: string;
}

export interface EditPath {
  subpaths: EditSubpath[];
}

export type KnotRef = [number, number];

/** 指针下的路径部件(上游 Hit):手柄最上,其次锚点,再次段;同类内取最近。 */
export type PathHit =
  | { kind: 'anchor'; knot: KnotRef }
  | { kind: 'handle'; knot: KnotRef; handle: Handle }
  | { kind: 'segment'; knot: KnotRef; t: number };

const dist = (a: Pt, b: Pt): number => Math.hypot(a[0] - b[0], a[1] - b[1]);

export const clonePath = (p: EditPath): EditPath => ({
  subpaths: p.subpaths.map((sp) => ({
    closed: sp.closed,
    op: sp.op,
    knots: sp.knots.map((k) => ({ anchor: [...k.anchor] as Pt, in: [...k.in] as Pt, out: [...k.out] as Pt, smooth: k.smooth })),
  })),
});

const knotAt = (p: EditPath, [s, k]: KnotRef): EditKnot | null => p.subpaths[s]?.knots[k] ?? null;

/** 段 [s,k] 的终点锚(闭合子路径回绕;上游 segment_end)。 */
export function segmentEnd(p: EditPath, [s, k]: KnotRef): KnotRef | null {
  const sp = p.subpaths[s];
  if (!sp || k >= sp.knots.length) return null;
  const next = k + 1;
  if (next < sp.knots.length) return [s, next];
  return sp.closed && sp.knots.length > 1 ? [s, 0] : null;
}

const handleOf = (k: EditKnot, h: Handle): Pt => (h === 'in' ? k.in : k.out);
const setHandle = (k: EditKnot, h: Handle, v: Pt): void => {
  (h === 'in' ? k.in : (k.out as Pt))[0] = v[0];
  (h === 'in' ? k.in : (k.out as Pt))[1] = v[1];
};
const other = (h: Handle): Handle => (h === 'in' ? 'out' : 'in');

/** 段是否直线:两端手柄都收回(上游 straight)。 */
export function straight(a: EditKnot, b: EditKnot): boolean {
  return dist(handleOf(a, 'out'), a.anchor) < 1e-9 && dist(handleOf(b, 'in'), b.anchor) < 1e-9;
}

/** 平滑锚保持共线:对侧手柄反向延伸保持原长(收回的对侧保持收回,PS 口径;上游 keep_smooth)。 */
function keepSmooth(k: EditKnot, h: Handle): void {
  if (!k.smooth) return;
  const a = k.anchor;
  const moved = handleOf(k, h);
  const opp = handleOf(k, other(h));
  const len = dist(opp, a);
  const d = dist(moved, a);
  if (len > 1e-9 && d > 1e-9) {
    opp[0] = a[0] - ((moved[0] - a[0]) / d) * len;
    opp[1] = a[1] - ((moved[1] - a[1]) / d) * len;
  }
}

/** 移动锚点(连带手柄),同一锚列多次只动一次;下标非法返回 null(上游 move_anchors)。 */
export function moveAnchors(p: EditPath, anchors: KnotRef[], d: Pt): EditPath | null {
  const list = [...anchors].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  for (let i = 1; i < list.length; i++) {
    if (list[i][0] === list[i - 1][0] && list[i][1] === list[i - 1][1]) list.splice(i--, 1);
  }
  for (const r of list) if (!knotAt(p, r)) return null;
  for (const [s, k] of list) {
    const kn = knotAt(p, [s, k])!;
    kn.anchor = [kn.anchor[0] + d[0], kn.anchor[1] + d[1]];
    kn.in = [kn.in[0] + d[0], kn.in[1] + d[1]];
    kn.out = [kn.out[0] + d[0], kn.out[1] + d[1]];
  }
  return p;
}

/** 手柄 h 置于 to:平滑锚对侧共线跟随;independent(Convert Point/⌥)=断成尖角(上游 move_handle)。 */
export function moveHandle(p: EditPath, knot: KnotRef, h: Handle, to: Pt, independent: boolean): EditPath | null {
  const k = knotAt(p, knot);
  if (!k) return null;
  setHandle(k, h, to);
  if (independent) k.smooth = false;
  keepSmooth(k, h);
  return p;
}

/** 转换点(上游 convert_point):out=null=收回手柄成角点;out=平滑锚,out 与镜像成对。 */
export function convertPoint(p: EditPath, knot: KnotRef, out: Pt | null): EditPath | null {
  const k = knotAt(p, knot);
  if (!k) return null;
  const a = k.anchor;
  if (out) {
    k.anchor = [...a] as Pt;
    k.in = [2.0 * a[0] - out[0], 2.0 * a[1] - out[1]];
    k.out = [...out] as Pt;
    k.smooth = true;
  } else {
    k.in = [...a] as Pt;
    k.out = [...a] as Pt;
    k.smooth = false;
  }
  return p;
}

/** 三次贝塞尔取点(上游 eval)。 */
export function evalSeg(seg: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1.0 - t;
  const c0 = u * u * u;
  const c1 = 3.0 * u * u * t;
  const c2 = 3.0 * u * t * t;
  const c3 = t * t * t;
  return [
    c0 * seg[0][0] + c1 * seg[1][0] + c2 * seg[2][0] + c3 * seg[3][0],
    c0 * seg[0][1] + c1 * seg[1][1] + c2 * seg[2][1] + c3 * seg[3][1],
  ];
}

/** 子路径的立方段序列 [anchor,out,in,anchor](闭合回绕)。 */
export function subpathSegments(sp: EditSubpath): [Pt, Pt, Pt, Pt][] {
  const n = sp.knots.length;
  const out: [Pt, Pt, Pt, Pt][] = [];
  for (let i = 0; i < n; i++) {
    if (!sp.closed && i + 1 >= n) break;
    const a = sp.knots[i];
    const b = sp.knots[(i + 1) % n];
    out.push([a.anchor, a.out, b.in, b.anchor]);
  }
  return out;
}

/** 拖段变形(上游 bend_segment):直线段=两锚随动;曲线=使 t 处点精确随指针
 * (3t(1−t)((1−t)²+t²)·s=1 解出 s),端部钳 0.05..0.95;平滑端锚保持共线。 */
export function bendSegment(p: EditPath, knot: KnotRef, t: number, d: Pt): EditPath | null {
  const end = segmentEnd(p, knot);
  if (!end) return null;
  const a = knotAt(p, knot)!;
  const b = knotAt(p, end)!;
  if (straight(a, b)) return moveAnchors(p, [knot, end], d);
  const tc = Number.isFinite(t) ? Math.min(0.95, Math.max(0.05, t)) : 0.5;
  const u = 1.0 - tc;
  const s = 1.0 / (3.0 * tc * u * (u * u + tc * tc));
  const w1 = u * s;
  const w2 = tc * s;
  a.out = [a.out[0] + d[0] * w1, a.out[1] + d[1] * w1];
  keepSmooth(a, 'out');
  b.in = [b.in[0] + d[0] * w2, b.in[1] + d[1] * w2];
  keepSmooth(b, 'in');
  return p;
}

/** 加锚点(上游 add_anchor):严格 0<t<1 处插入;曲线 de Casteljau 分割(形状不变,新锚平滑),
 * 直线段=线上角点;返回新锚 [s,k]。 */
export function addAnchor(p: EditPath, knot: KnotRef, t: number): KnotRef | null {
  if (!(Number.isFinite(t) && t > 0.0 && t < 1.0)) return null;
  const end = segmentEnd(p, knot);
  if (!end) return null;
  const a = knotAt(p, knot)!;
  const b = knotAt(p, end)!;
  const lerp = (u: Pt, v: Pt, w: number): Pt => [u[0] + (v[0] - u[0]) * w, u[1] + (v[1] - u[1]) * w];
  let nk: EditKnot;
  if (straight(a, b)) {
    // 命中/悬停都用三次参数(直线时非线性),新角点落在同一点
    const pt = evalSeg([a.anchor, a.out, b.in, b.anchor], t);
    nk = { anchor: pt, in: [...pt] as Pt, out: [...pt] as Pt, smooth: false };
  } else {
    const p01 = lerp(a.anchor, a.out, t);
    const p12 = lerp(a.out, b.in, t);
    const p23 = lerp(b.in, b.anchor, t);
    const p012 = lerp(p01, p12, t);
    const p123 = lerp(p12, p23, t);
    a.out = p01;
    b.in = p23;
    nk = { anchor: lerp(p012, p123, t), in: p012, out: p123, smooth: true };
  }
  const [s, k] = knot;
  const sp = p.subpaths[s];
  if (!sp || k >= sp.knots.length) return null;
  const at = Math.min(k + 1, sp.knots.length);
  sp.knots.splice(at, 0, nk);
  return [s, at];
}

/** 删锚点(上游 delete_anchor):邻锚以原 out/in 手柄接续;闭合子路径保持闭合;删到空=删子路径;
 * 全路径只剩一锚=拒绝(返回 null);返回是否删掉了整个子路径。 */
export function deleteAnchor(p: EditPath, [s, k]: KnotRef): boolean | null {
  if (!knotAt(p, [s, k])) return null;
  const total = p.subpaths.reduce((n, sp) => n + sp.knots.length, 0);
  if (total <= 1) return null;
  const sp = p.subpaths[s];
  if (!sp) return null;
  if (sp.knots.length <= 1) {
    p.subpaths.splice(s, 1);
    return true;
  }
  sp.knots.splice(k, 1);
  return false;
}

/** 子路径全部锚(⌥ 点选整条子路径;上游 subpath_anchors)。 */
export function subpathAnchors(p: EditPath, s: number): KnotRef[] {
  const sp = p.subpaths[s];
  return sp ? sp.knots.map((_, k) => [s, k] as KnotRef) : [];
}

/** 框内锚点(直接选择框选,路径序;上游 anchors_in)。 */
export function anchorsIn(p: EditPath, [x0, y0, x1, y1]: [number, number, number, number]): KnotRef[] {
  const [ax0, ax1, ay0, ay1] = [Math.min(x0, x1), Math.max(x0, x1), Math.min(y0, y1), Math.max(y0, y1)];
  const out: KnotRef[] = [];
  p.subpaths.forEach((sp, s) => {
    sp.knots.forEach((kn, k) => {
      if (kn.anchor[0] >= ax0 && kn.anchor[0] <= ax1 && kn.anchor[1] >= ay0 && kn.anchor[1] <= ay1) out.push([s, k]);
    });
  });
  return out;
}

/** 命中测试(上游 hit):handles(悬浮其上)>锚点>段;段=64 采样取最近+邻域 16 细化。 */
export function hitPath(p: EditPath, point: Pt, tol: number, handles: { knot: KnotRef; handle: Handle }[]): PathHit | null {
  const nearest = <T>(it: { d: number; v: T }[]): T | null => {
    let best: { d: number; v: T } | null = null;
    for (const it2 of it) {
      if (it2.d > tol) continue;
      if (!best || it2.d < best.d) best = it2;
    }
    return best ? best.v : null;
  };
  const onHandle = nearest(
    handles
      .map(({ knot: r, handle: h }) => {
        const k = knotAt(p, r);
        return k ? { d: dist(handleOf(k, h), point), v: { kind: 'handle', knot: r, handle: h } as PathHit } : null;
      })
      .filter((x): x is { d: number; v: PathHit } => x !== null),
  );
  if (onHandle) return onHandle;
  const anchorList: { d: number; v: PathHit }[] = [];
  p.subpaths.forEach((sp, s) => {
    sp.knots.forEach((kn, k) => anchorList.push({ d: dist(kn.anchor, point), v: { kind: 'anchor', knot: [s, k] } }));
  });
  const onAnchor = nearest(anchorList);
  if (onAnchor) return onAnchor;
  const N = 64;
  const segList: { d: number; v: PathHit }[] = [];
  p.subpaths.forEach((sp, s) => {
    subpathSegments(sp).forEach((seg, k) => {
      let bd = Infinity;
      let bt = 0.5;
      for (let i = 0; i <= N; i++) {
        const t = i / N;
        const d = dist(evalSeg(seg, t), point);
        if (d < bd) {
          bd = d;
          bt = t;
        }
      }
      const step = 1.0 / N;
      for (let i = 0; i <= 16; i++) {
        const t = Math.min(1.0, Math.max(0.0, bt - step + 2.0 * step * (i / 16)));
        const d = dist(evalSeg(seg, t), point);
        if (d < bd) {
          bd = d;
          bt = t;
        }
      }
      segList.push({ d: bd, v: { kind: 'segment', knot: [s, k], t: bt } });
    });
  });
  return nearest(segList);
}

export interface SelectionLike {
  anchors: KnotRef[];
  segment: KnotRef | null;
}

const retracted = (k: EditKnot, h: Handle): boolean => {
  const c = handleOf(k, h);
  return Math.abs(c[0] - k.anchor[0]) < 1e-9 && Math.abs(c[1] - k.anchor[1]) < 1e-9;
};

/** 当前应显示的手柄(上游 shown_handles):选中锚的双手柄+点中段的出入口手柄;收回的不显。 */
export function shownHandles(sel: SelectionLike, p: EditPath): { knot: KnotRef; handle: Handle }[] {
  const out: { knot: KnotRef; handle: Handle }[] = [];
  for (const r of sel.anchors) out.push({ knot: r, handle: 'in' }, { knot: r, handle: 'out' });
  if (sel.segment) {
    const [s, k] = sel.segment;
    const sp = p.subpaths[s];
    if (sp) {
      const n = sp.knots.length;
      const next = k + 1 < n ? k + 1 : sp.closed && n > 1 ? 0 : null;
      out.push({ knot: [s, k], handle: 'out' });
      if (next != null) out.push({ knot: [s, next], handle: 'in' });
    }
  }
  return out.filter(({ knot: r, handle: h }) => {
    const k = knotAt(p, r);
    return k && !retracted(k, h);
  });
}

/** 整体平移(上游 Path::transform 的 translate 分支):锚与双手柄同移,PathSelection
 * 拖移工作路径用(整数位移,与 shape.edit move 同口径)。 */
export function translatePath(p: EditPath, d: Pt): EditPath {
  return {
    subpaths: p.subpaths.map((sp) => ({
      ...sp,
      knots: sp.knots.map((k) => ({
        anchor: [k.anchor[0] + d[0], k.anchor[1] + d[1]] as Pt,
        in: [k.in[0] + d[0], k.in[1] + d[1]] as Pt,
        out: [k.out[0] + d[0], k.out[1] + d[1]] as Pt,
        smooth: k.smooth,
      })),
    })),
  };
}

/** 点是否在闭合子路径内(上游 point_in_subpath:偶奇射线;闭合并 ≥3 锚才有效)。 */
export function pointInSubpath(sp: EditSubpath, pt: Pt): boolean {
  if (!sp.closed || sp.knots.length < 3) return false;
  let inside = false;
  const n = sp.knots.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = sp.knots[i].anchor[0];
    const yi = sp.knots[i].anchor[1];
    const xj = sp.knots[j].anchor[0];
    const yj = sp.knots[j].anchor[1];
    const intersect = yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

/** 路径选择的光标拾取(上游 pick_shape_at 的几何部分,自上而下首个命中胜):
 * path 几何命中容差内(peHit 手柄不参战),有填充时 Live 矩形/椭圆与闭合子路径
 * 内部点也算(逐像素面探查交由 layer.pickAt 快路径,这里纯几何)。 */
export function pickShapeAt(
  candidates: { id: number; path: EditPath; fill: boolean; live?: { kind?: string; rect?: [number, number, number, number] } | null }[],
  at: Pt,
  tol: number,
): number | null {
  for (const c of candidates) {
    if (hitPath(c.path, at, tol, [])) return c.id;
    if (!c.fill) continue;
    const live = c.live;
    if (live?.rect) {
      const [x, y, w, h] = live.rect;
      const x0 = Math.min(x, x + w);
      const x1 = Math.max(x, x + w);
      const y0 = Math.min(y, y + h);
      const y1 = Math.max(y, y + h);
      if (at[0] >= x0 && at[0] <= x1 && at[1] >= y0 && at[1] <= y1) return c.id;
      if (live.kind === 'ellipse') {
        const rx = Math.abs(w) / 2;
        const ry = Math.abs(h) / 2;
        if (rx > 1e-6 && ry > 1e-6) {
          const cx = x + w / 2;
          const cy = y + h / 2;
          const dx = (at[0] - cx) / rx;
          const dy = (at[1] - cy) / ry;
          if (dx * dx + dy * dy <= 1.0) return c.id;
        }
      }
    }
    if (c.path.subpaths.some((sp) => pointInSubpath(sp, at))) return c.id;
  }
  return null;
}
