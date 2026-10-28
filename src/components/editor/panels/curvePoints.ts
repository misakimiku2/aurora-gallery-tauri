/**
 * 曲线点交互纯函数(photocraft point_curve.rs 逐行移植)+ 自然三次样条 LUT
 * (photocraft compose/adjust.rs curve_lut 移植——前端画线必须和引擎实际像素
 * 效果一致:同一条自然三次样条,可过冲,两端恒值,钳 0..1)。
 * 坐标一律 0..255 电平;宿主持手势状态,这里只改点数据。
 */

/** 点距小于此(input 电平)视为同一点。 */
export const CURVE_MIN_GAP = 2.0;
/** 曲线最多点数(Photoshop 上限)。 */
export const CURVE_MAX_POINTS = 16;
/** 点命中半径(屏幕像素)。 */
export const CURVE_HIT_RADIUS = 9.0;
/** 内部点拖出图外此像素外消失、同手势拖回恢复。 */
export const CURVE_DRAG_OFF = 12.0;

export type CurvePoint = [number, number];

/** input 电平最近 `x` 的点下标(距离 ≤ radius);无命中为 null。 */
export function curveHit(pts: CurvePoint[], toX: (v: number) => number, toY: (v: number) => number, x: number, y: number, radius: number): number | null {
  let best: number | null = null;
  let bestD = radius;
  for (let i = 0; i < pts.length; i++) {
    const dx = toX(pts[i][0]) - x;
    const dy = toY(pts[i][1]) - y;
    const d = Math.hypot(dx, dy);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** 在 `v` 处加点(保持有序):已有同 input 点则只返回其下标(选中而非堆叠);满 16 点拒绝。 */
export function curveInsert(pts: CurvePoint[], v: [number, number]): number | null {
  if (!Number.isFinite(v[0]) || !Number.isFinite(v[1])) return null;
  const cl: CurvePoint = [Math.min(255, Math.max(0, v[0])), Math.min(255, Math.max(0, v[1]))];
  const dup = pts.findIndex((q) => Math.abs(q[0] - cl[0]) < CURVE_MIN_GAP);
  if (dup >= 0) return dup;
  if (pts.length >= CURVE_MAX_POINTS) return null;
  let i = pts.findIndex((q) => q[0] > cl[0]);
  if (i < 0) i = pts.length;
  pts.splice(i, 0, cl);
  return i;
}

/** 端点不可删,且曲线恒 ≥2 点。 */
export function curveCanDelete(pts: unknown[], i: number): boolean {
  return pts.length > 2 && i > 0 && i < pts.length - 1;
}

/** 删内部点;失败(端点/越界)不动并返回 false。 */
export function curveDelete(pts: CurvePoint[], i: number): boolean {
  if (!Number.isInteger(i) || i < 0 || i >= pts.length || !curveCanDelete(pts, i)) return false;
  pts.splice(i, 1);
  return true;
}

/** 移动点 `i`,input round 后严格夹在左右邻点之间,output 钳 0..255;返回是否变化。 */
export function curveMoveTo(pts: CurvePoint[], i: number, v: [number, number]): boolean {
  const old = pts[i];
  if (!old || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) return false;
  const lo = i > 0 && pts[i - 1] ? pts[i - 1][0] + 1 : 0;
  const hi = i + 1 < pts.length && pts[i + 1] ? pts[i + 1][0] - 1 : 255;
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return false;
  const next: CurvePoint = [
    Math.min(Math.max(Math.round(v[0]), lo), Math.max(hi, lo)),
    Math.min(255, Math.max(0, Math.round(v[1]))),
  ];
  if (next[0] === old[0] && next[1] === old[1]) return false;
  pts[i] = next;
  return true;
}

/** 自然三次样条 LUT(引擎 curve_lut 移植):过点、可过冲、首尾点外恒值、钳 0..1。
 * 入点为 0..255 电平;返回 256 项 0..1(与引擎 LUT 同域:内部点归一化到 0..1 再采样)。 */
export function curveLut(points: CurvePoint[], size = 256): number[] {
  const pts = points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [p[0] / 255, p[1] / 255] as CurvePoint)
    .sort((a, b) => a[0] - b[0]);
  for (let i = pts.length - 1; i > 0; i--) {
    if (Math.abs(pts[i][0] - pts[i - 1][0]) < 1e-6) pts.splice(i, 1);
  }
  if (pts.length < 2) {
    return Array.from({ length: size }, (_, i) => i / (size - 1));
  }
  const n = pts.length;
  // 自然样条二阶导(三对角求解)
  const m2 = new Float64Array(n);
  if (n > 2) {
    const c = new Float64Array(n);
    const d = new Float64Array(n);
    for (let i = 1; i < n - 1; i++) {
      const h0 = pts[i][0] - pts[i - 1][0];
      const h1 = pts[i + 1][0] - pts[i][0];
      const a = h0 / 6;
      const b = (h0 + h1) / 3;
      const cc = h1 / 6;
      const r = (pts[i + 1][1] - pts[i][1]) / h1 - (pts[i][1] - pts[i - 1][1]) / h0;
      const denom = b - a * c[i - 1];
      c[i] = cc / denom;
      d[i] = (r - a * d[i - 1]) / denom;
    }
    for (let i = n - 2; i >= 1; i--) {
      m2[i] = d[i] - c[i] * m2[i + 1];
    }
  }
  const lut: number[] = new Array(size);
  for (let k = 0; k < size; k++) {
    const xv = k / (size - 1);
    if (xv <= pts[0][0]) {
      lut[k] = Math.min(1, Math.max(0, pts[0][1]));
      continue;
    }
    if (xv >= pts[n - 1][0]) {
      lut[k] = Math.min(1, Math.max(0, pts[n - 1][1]));
      continue;
    }
    let i = 0;
    while (i < n - 2 && xv > pts[i + 1][0]) i++;
    const x0 = pts[i][0];
    const y0 = pts[i][1];
    const x1 = pts[i + 1][0];
    const y1 = pts[i + 1][1];
    const h = x1 - x0;
    const a = (x1 - xv) / h;
    const b = (xv - x0) / h;
    const y = a * y0 + b * y1 + ((a * a * a - a) * m2[i] + (b * b * b - b) * m2[i + 1]) * h * h / 6;
    lut[k] = Math.min(1, Math.max(0, y));
  }
  return lut;
}

/** 引擎参数里的点数组 → 点对(非法/不足两点回退恒等线)。 */
export function curveFromParams(v: unknown): CurvePoint[] {
  const pts: CurvePoint[] = Array.isArray(v)
    ? v
        .filter((q): q is number[] => Array.isArray(q) && Number.isFinite(q[0]) && Number.isFinite(q[1]))
        .map((q) => [q[0], q[1]] as CurvePoint)
    : [];
  return pts.length < 2 ? [[0, 0], [255, 255]] : pts;
}

// -------------------------------------------------------------------------------------------
// 铅笔模式(photocraft point_curve.rs pencil_line + adjust_params.rs map 互转/Smooth 口径)

/** 铅笔模式 map 长度:每个输入电平一个输出值。 */
export const CURVE_MAP_LEN = 256;
/** 铅笔图切回点模式时的拟合点上限(Photoshop 同款;上游 MAX_FITTED_POINTS)。 */
export const CURVE_MAP_MAX_FITTED = 16;

/** 恒等铅笔 map(0..255)。 */
export function identityCurveMap(): number[] {
  return Array.from({ length: CURVE_MAP_LEN }, (_, k) => k);
}

/** 铅笔一笔的直线段:按 x 每 level 填一个输出值(快拖不留缝),返回是否有改动。
 * from/to 为 0..255 电平对;i1==i0(单点/垂直)取 x 较大一端的 y(上游 pencil_line 逐行移植)。 */
export function pencilLine(map: number[], from: CurvePoint, to: CurvePoint): boolean {
  if (![from[0], from[1], to[0], to[1]].every(Number.isFinite) || map.length === 0) return false;
  const last = map.length - 1;
  const level = (x: number) => (Math.min(255, Math.max(0, x)) / 255) * last;
  const [a, b] = from[0] <= to[0] ? [from, to] : [to, from];
  const i0 = Math.round(level(a[0]));
  const i1 = Math.round(level(b[0]));
  let changed = false;
  for (let i = i0; i <= i1; i++) {
    const t = i1 > i0 ? (i - i0) / (i1 - i0) : 1.0;
    const o = Math.min(255, Math.max(0, a[1] + (b[1] - a[1]) * t));
    if (i >= 0 && i <= last && map[i] !== o) {
      map[i] = o;
      changed = true;
    }
  }
  return changed;
}

/** Smooth 一遍:每值=两侧最多 3 邻居对称窗口的均值,直线段与两端不动(上游 smooth_curve_map)。 */
export function smoothCurveMap(map: number[]): void {
  const RADIUS = 3;
  const src = map.slice();
  const n = src.length;
  for (let k = 0; k < n; k++) {
    const r = Math.min(RADIUS, k, n - 1 - k);
    if (r === 0) continue;
    let sum = 0;
    for (let i = k - r; i <= k + r; i++) sum += src[i];
    map[k] = sum / (2 * r + 1);
  }
}

/** 引擎参数 → 铅笔 map(非 256 数组/含非法值回退恒等;上游 read_map)。 */
export function mapFromParams(v: unknown): number[] {
  if (Array.isArray(v) && v.length === CURVE_MAP_LEN && v.every((o) => typeof o === 'number' && Number.isFinite(o))) {
    return v.map((o) => Math.min(255, Math.max(0, o as number)));
  }
  return identityCurveMap();
}

/** 铅笔 map → 引擎参数(每值 round 2 位小数;上游 write_map / map_arr 精度)。 */
export function mapToParams(map: number[]): number[] {
  return map.map((o) => Math.round(o * 100) / 100);
}

/** 点曲线 → 铅笔 map:自然样条在 256 级上采样(上游 points_to_map)。 */
export function pointsToMap(pts: CurvePoint[]): number[] {
  return curveLut(pts, CURVE_MAP_LEN).map((o) => o * 255);
}

/** 铅笔 map → 点曲线:先放两端点,再反复放当前样条偏差最大的电平,直到误差 ≤1 电平
 * 或放满 16 点(上游 map_to_points,Photoshop 切回点编辑;并列偏差取后者同 Rust max_by)。 */
export function mapToFitPoints(map: number[]): CurvePoint[] {
  const target = (k: number) =>
    k >= 0 && k < map.length && Number.isFinite(map[k]) ? Math.min(255, Math.max(0, map[k])) : 0;
  const pts: CurvePoint[] = [
    [0, target(0)],
    [CURVE_MAP_LEN - 1, target(CURVE_MAP_LEN - 1)],
  ];
  while (pts.length < CURVE_MAP_MAX_FITTED) {
    const lut = curveLut(pts, CURVE_MAP_LEN);
    let worst = 0;
    let worstErr = -1;
    for (let k = 0; k < CURVE_MAP_LEN; k++) {
      const err = Math.abs(lut[k] * 255 - target(k));
      if (err >= worstErr) {
        worstErr = err;
        worst = k;
      }
    }
    if (worstErr <= 1.0) break; // 阈值 1 电平(上游 1/255)
    if (pts.some((q) => Math.abs(q[0] - worst) < 0.5)) break; // 判重半个电平(上游 0.5/255)
    pts.push([worst, target(worst)]);
    pts.sort((a, b) => a[0] - b[0]);
  }
  return pts;
}

/** 铅笔 map 是否恒等(每级映射自身,阈值半电平;上游 is_identity_map)——叠加显示跳过恒等通道。 */
export function isIdentityMap(map: number[]): boolean {
  return map.every((o, k) => Math.abs(o - k) < 0.5);
}
