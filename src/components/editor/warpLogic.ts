/**
 * Warp 变换纯几何(photocraft-vendor/crates/geom/src/warp.rs 逐行移植)。
 *
 * BezierMesh = bicubic Bezier 面片网格:us/vs 是面片边界(0..1 递增,首 0 末 1),
 * 控制点是 (3·面片数+1)² 的网格、行优先、文档像素;相邻面片共享边界行。
 * 预设 = 单个 bicubic 面片(Photoshop 27.11 实测数学,见 presetGrid)。
 * 交互核心 pull(拖面片内部)/dragPoint(拖控制点保切线连续)。
 */
import type { RectF } from './transformLogic';

export type Pt = [number, number];

/** 网格面片:边界 knots + 行优先控制点(document px)。 */
export interface WarpMesh {
  us: number[];
  vs: number[];
  points: Pt[];
}

/** 引擎 WarpStyle id 空间(cylinder 引擎在但上游无编辑器,不进下拉)。 */
export type WarpStyleId =
  | 'none' | 'custom' | 'arc' | 'arcLower' | 'arcUpper' | 'arch' | 'bulge'
  | 'shellLower' | 'shellUpper' | 'flag' | 'wave' | 'fish' | 'rise'
  | 'fisheye' | 'inflate' | 'squeeze' | 'twist' | 'cylinder';

/** 上游 PRESETS(geom/warp.rs:52)= 15 个弯曲预设,下拉顺序同此。 */
export const WARP_PRESETS: WarpStyleId[] = [
  'arc', 'arcUpper', 'arcLower', 'arch', 'bulge', 'shellUpper', 'shellLower',
  'flag', 'wave', 'fish', 'rise', 'fisheye', 'inflate', 'squeeze', 'twist',
];

/** PS 中文风格名(照 Warp Text 下拉顺序)。 */
export const WARP_STYLE_ZH: Record<WarpStyleId, string> = {
  none: '无', custom: '自定', arc: '拱形', arcUpper: '上弧', arcLower: '下弧',
  arch: '拱门', bulge: '凸出', shellUpper: '上壳', shellLower: '下壳',
  flag: '旗帜', wave: '波浪', fish: '鱼', rise: '上升', fisheye: '鱼眼',
  inflate: '膨胀', squeeze: '挤压', twist: '扭转', cylinder: '圆柱',
};

const PI = Math.PI;

const bernstein = (t: number): [number, number, number, number] => {
  const s = 1 - t;
  return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t];
};

const lerp2 = (a: Pt, b: Pt, t: number): Pt => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

/** De Casteljau 三次分割:7 点(左 0..=3、右 3..=6)。 */
export function splitCubic(p: [Pt, Pt, Pt, Pt], t: number): Pt[] {
  const a = lerp2(p[0], p[1], t);
  const b = lerp2(p[1], p[2], t);
  const c = lerp2(p[2], p[3], t);
  const d = lerp2(a, b, t);
  const e = lerp2(b, c, t);
  const f = lerp2(d, e, t);
  return [p[0], a, d, f, e, c, p[3]];
}

type Grid = Pt[][]; // 4×4(box 单位 0..1,y 向下)

const restGrid = (): Grid =>
  [0, 1, 2, 3].map((j) => [0, 1, 2, 3].map((i) => [i / 3, j / 3] as Pt));

/**
 * box 单位高度 y(0..1 横跨)的水平边弯成 |b|·π 圆弧、保持弦长;
 * up == (b>0) 时向上弓;h = 盒高/盒宽,让圆弧在像素空间成圆。
 */
function edgeArc(y: number, b: number, up: boolean, h: number): [Pt, Pt, Pt, Pt] {
  if (Math.abs(b) < 1e-9) return [[0, y], [1 / 3, y], [2 / 3, y], [1, y]];
  const th = Math.abs(b) * PI;
  const k = (4 / 3) * Math.tan(th / 4) * 0.5 / Math.sin(th / 2);
  const s = (b > 0) === up ? -1 : 1;
  const c = Math.cos(th / 2), n = Math.sin(th / 2);
  const dy = (s * k * n) / h;
  return [[0, y], [k * c, y + dy], [1 - k * c, y + dy], [1, y]];
}

/** Arc:每行都是绕同一圆心的 |b|·π 圆弧,半径向对边按盒高增长;内侧边保持弦。 */
function arcGrid(b: number, h: number): Grid {
  if (Math.abs(b) < 1e-9) return restGrid();
  const up = b > 0;
  const th = Math.abs(b) * PI;
  const r = 0.5 / Math.sin(th / 2);
  const k = (4 / 3) * Math.tan(th / 4);
  const s = up ? -1 : 1;
  const cy = up ? h + r * Math.cos(th / 2) : -r * Math.cos(th / 2);
  return [0, 1, 2, 3].map((j) => {
    const v = j / 3;
    const big = r + h * (up ? 1 - v : v);
    const at = (a: number): Pt => [0.5 + big * Math.sin(a), cy + s * big * Math.cos(a)];
    const tangent = (a: number): Pt => [Math.cos(a), -s * Math.sin(a)];
    const p0 = at(-th / 2), p3 = at(th / 2);
    const t0 = tangent(-th / 2), t1 = tangent(th / 2);
    const l = k * big;
    const pts: [Pt, Pt, Pt, Pt] = [
      p0,
      [p0[0] + l * t0[0], p0[1] + l * t0[1]],
      [p3[0] - l * t1[0], p3[1] - l * t1[1]],
      p3,
    ];
    return pts.map((p) => [p[0], p[1] / h] as Pt);
  });
}

/** 行间从 top 到 bottom 线性混合。 */
function blendRows(top: Pt[], bottom: Pt[]): Grid {
  return [0, 1, 2, 3].map((j) => {
    const t = j / 3;
    return [0, 1, 2, 3].map(
      (i) => [top[i][0] + (bottom[i][0] - top[i][0]) * t, top[i][1] + (bottom[i][1] - top[i][1]) * t] as Pt,
    );
  });
}

/**
 * Photoshop 的 warp 预设为 Bezier 控制网格(Photoshop 27.11 实测,单面片 0.5px 内)。
 * b/hd/vd 均 -1..1;aspect = 盒高/盒宽;vertical 时轴(与两畸变)互换。
 */
export function presetGrid(style: WarpStyleId, b: number, hd: number, vd: number, vertical: boolean, aspect: number): Grid {
  const h = vertical ? 1 / aspect : aspect;
  const [hdv, vdv] = vertical ? [vd, hd] : [hd, vd];
  const g = restGrid();
  switch (style) {
    case 'arc':
      return finish(arcGrid(b, h), hdv, vdv, vertical);
    case 'arch':
      for (let j = 0; j < 4; j++) g[j] = edgeArc(j / 3, b, true, h);
      break;
    case 'bulge':
      return finish(blendRows(edgeArc(0, b, true, h), edgeArc(1, b, false, h)), hdv, vdv, vertical);
    case 'arcLower':
      return finish(blendRows(g[0], edgeArc(1, b, false, h)), hdv, vdv, vertical);
    case 'arcUpper':
      return finish(blendRows(edgeArc(0, b, true, h), g[3]), hdv, vdv, vertical);
    // 凸出的边与相邻行外点来自 Arc(ShellLower 反向弯曲);其余不动。
    case 'shellLower': {
      const a = arcGrid(-b, h);
      g[3] = a[3];
      g[2][0] = a[2][0];
      g[2][3] = a[2][3];
      break;
    }
    case 'shellUpper': {
      const a = arcGrid(b, h);
      g[0] = a[0];
      g[1][0] = a[1][0];
      g[1][3] = a[1][3];
      break;
    }
    case 'flag':
      for (const row of g) {
        row[1][1] -= 2 * b;
        row[2][1] += 2 * b;
      }
      break;
    case 'wave':
      for (let j = 1; j <= 2; j++) {
        g[j][1][1] += (4 / 3) * b;
        g[j][2][1] -= (4 / 3) * b;
      }
      break;
    case 'fish':
      for (const [j, f] of [[0, -2], [1, -2 / 3], [2, 2 / 3], [3, 2]] as const) {
        g[j][1][1] += f * b;
        g[j][2][1] -= f * b;
      }
      break;
    case 'rise':
      for (const row of g) {
        row[0][1] += 2 * b;
        row[1][1] += 2 * b;
      }
      break;
    case 'fisheye':
      for (const [j, i, dx, dy] of [[1, 1, -1, -1], [1, 2, 1, -1], [2, 1, -1, 1], [2, 2, 1, 1]] as const) {
        g[j][i][0] += (dx * 2) / 3 * b;
        g[j][i][1] += (dy * 2) / 3 * b;
      }
      break;
    // 边中点外移(Inflate)或侧边内移(Squeeze)b/3,内点 b/9。
    case 'inflate':
    case 'squeeze': {
      const s = style === 'inflate' ? 1 : -1;
      for (const i of [1, 2]) g[0][i][1] -= b / 3;
      for (const i of [1, 2]) g[3][i][1] += b / 3;
      for (let j = 1; j <= 2; j++) {
        g[j][0][0] -= (s * b) / 3;
        g[j][3][0] += (s * b) / 3;
      }
      for (const [j, i, dx, dy] of [[1, 1, -1, -1], [1, 2, 1, -1], [2, 1, -1, 1], [2, 2, 1, 1]] as const) {
        g[j][i][0] += (s * dx * b) / 9;
        g[j][i][1] += (dy * b) / 9;
      }
      break;
    }
    // 内点绕中心旋转(负 bend 反向)。
    case 'twist': {
      const a = Math.abs(b);
      if (b >= 0) {
        g[1][1][0] += a;
        g[1][2][1] += a;
        g[2][1][1] -= a;
        g[2][2][0] -= a;
      } else {
        g[1][1][1] += a;
        g[1][2][0] -= a;
        g[2][1][0] += a;
        g[2][2][1] -= a;
      }
      break;
    }
  }
  return finish(g, hdv, vdv, vertical);

  /** 畸变后处理 + 垂直转置(引擎 preset_grid 376-403)。 */
  function finish(grid: Grid, hd2: number, vd2: number, vert: boolean): Grid {
    const out = grid.map((row) => row.map((p) => [...p] as Pt));
    // 垂直畸变:顶/底行绕各自端点中点缩放(1∓vd),中间行按 t 混合。
    if (vd2 !== 0) {
      const moved = (row: [Pt, Pt, Pt, Pt], s: number): [Pt, Pt, Pt, Pt] => {
        const m: Pt = [(row[0][0] + row[3][0]) / 2, (row[0][1] + row[3][1]) / 2];
        return [0, 1, 2, 3].map((i) => [m[0] + (row[i][0] - m[0]) * s - row[i][0], m[1] + (row[i][1] - m[1]) * s - row[i][1]] as Pt) as [Pt, Pt, Pt, Pt];
      };
      const d0 = moved(out[0] as [Pt, Pt, Pt, Pt], 1 - vd2);
      const d3 = moved(out[3] as [Pt, Pt, Pt, Pt], 1 + vd2);
      for (let j = 0; j < 4; j++) {
        const t = j / 3;
        for (let i = 0; i < 4; i++) {
          out[j][i][0] += d0[i][0] + (d3[i][0] - d0[i][0]) * t;
          out[j][i][1] += d0[i][1] + (d3[i][1] - d0[i][1]) * t;
        }
      }
    }
    // 水平畸变:每列绕端点中点缩放 1 + hd·(2i/3 − 1)。
    if (hd2 !== 0) {
      for (let i = 0; i < 4; i++) {
        const s = 1 + hd2 * ((2 * i) / 3 - 1);
        const m: Pt = [(out[0][i][0] + out[3][i][0]) / 2, (out[0][i][1] + out[3][i][1]) / 2];
        for (let j = 0; j < 4; j++) {
          out[j][i] = [m[0] + (out[j][i][0] - m[0]) * s, m[1] + (out[j][i][1] - m[1]) * s];
        }
      }
    }
    // 垂直方向:轴互换(畸变已换位)。
    if (vert) {
      return [0, 1, 2, 3].map((j) => [0, 1, 2, 3].map((i) => [out[i][j][1], out[i][j][0]] as Pt));
    }
    return out;
  }
}

/** 单个 bicubic 面片的风格 warp(presets only)。 */
export interface StyleWarp {
  grid: Grid;
  o: Pt;
  size: Pt;
}

/** 非预设/全零 warp/空盒 → null(引擎 StyleWarp::new)。 */
export function styleWarpNew(style: WarpStyleId, bend: number, hDistort: number, vDistort: number, vertical: boolean, bounds: RectF): StyleWarp | null {
  const isPreset = (WARP_PRESETS as string[]).includes(style);
  if (!isPreset) return null;
  const [x0, y0, x1, y1] = bounds;
  const hw = (x1 - x0) / 2, hh = (y1 - y0) / 2;
  if (!(hw > 0 && hh > 0)) return null;
  const pct = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(-1, v / 100)) : 0);
  const b = pct(bend), hd = pct(hDistort), vd = pct(vDistort);
  if (b === 0 && hd === 0 && vd === 0) return null;
  const grid = presetGrid(style, b, hd, vd, vertical, hh / hw);
  return { grid, o: [x0, y0], size: [2 * hw, 2 * hh] };
}

/** 映射一个点(引擎 StyleWarp::apply)。 */
export function styleWarpApply(sw: StyleWarp, x: number, y: number): Pt {
  const u = (x - sw.o[0]) / sw.size[0], v = (y - sw.o[1]) / sw.size[1];
  const bu = bernstein(u), bv = bernstein(v);
  let px = 0, py = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const k = bu[i] * bv[j];
      px += k * sw.grid[j][i][0];
      py += k * sw.grid[j][i][1];
    }
  }
  return [sw.o[0] + px * sw.size[0], sw.o[1] + py * sw.size[1]];
}

/** 风格 = 其盒上的单个 Bezier 面片(每个预设恰是)。 */
export function styleWarpMesh(sw: StyleWarp): WarpMesh {
  const points: Pt[] = [];
  for (const row of sw.grid) for (const p of row) points.push([sw.o[0] + p[0] * sw.size[0], sw.o[1] + p[1] * sw.size[1]]);
  return { us: [0, 1], vs: [0, 1], points };
}

/** Bernstein 插值逆矩阵(t = 0,1/3,2/3,1;行=控制点,列=采样)。 */
const BERN_INV: number[][] = [
  [1, 0, 0, 0],
  [-5 / 6, 3, -1.5, 1 / 3],
  [1 / 3, -1.5, 3, -5 / 6],
  [0, 0, 0, 1],
];

/** bounds 上 cols×rows 面片的恒等网格(PS 默认 1×1 = 4×4 控制点)。 */
export function meshIdentity(bounds: RectF, cols: number, rows: number): WarpMesh {
  const c = Math.min(64, Math.max(1, cols)), r = Math.min(64, Math.max(1, rows));
  const us = Array.from({ length: c + 1 }, (_, i) => i / c);
  const vs = Array.from({ length: r + 1 }, (_, i) => i / r);
  return meshFit((s, t) => [bounds[0] + s * (bounds[2] - bounds[0]), bounds[1] + t * (bounds[3] - bounds[1])], us, vs);
}

/** 以面片三分点采样映射 f 拟合网格;对 bicubic(含仿射)精确。 */
export function meshFit(f: (s: number, t: number) => Pt, us: number[], vs: number[]): WarpMesh {
  const pc = us.length - 1, pr = vs.length - 1;
  const nx = 3 * pc + 1;
  const points: Pt[] = Array.from({ length: nx * (3 * pr + 1) }, () => [0, 0]);
  for (let pj = 0; pj < pr; pj++) {
    for (let pi = 0; pi < pc; pi++) {
      const s: Pt[][] = [[0, 0], [0, 0], [0, 0], [0, 0]].map(() => [[0, 0], [0, 0], [0, 0], [0, 0]]);
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const u = us[pi] + (us[pi + 1] - us[pi]) * (i / 3);
          const t = vs[pj] + (vs[pj + 1] - vs[pj]) * (j / 3);
          s[j][i] = f(u, t);
        }
      }
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          let ax = 0, ay = 0;
          for (let a = 0; a < 4; a++) {
            for (let bb = 0; bb < 4; bb++) {
              const k = BERN_INV[j][a] * BERN_INV[i][bb];
              ax += k * s[a][bb][0];
              ay += k * s[a][bb][1];
            }
          }
          points[(3 * pj + j) * nx + 3 * pi + i] = [ax, ay];
        }
      }
    }
  }
  return { us, vs, points };
}

export const meshNx = (m: WarpMesh): number => 3 * (m.us.length - 1) + 1;
export const meshNy = (m: WarpMesh): number => 3 * (m.vs.length - 1) + 1;
export const meshPoint = (m: WarpMesh, i: number, j: number): Pt => m.points[j * meshNx(m) + i] ?? [0, 0];

/** 不变量校验(knots 数量 2..=65、首 0 末 1、严格递增、点数与有限性)。 */
export function meshIsValid(m: WarpMesh): boolean {
  const knotsOk = (k: number[]) => k.length >= 2 && k.length <= 65 && k[0] === 0 && k[k.length - 1] === 1 && k.every((v, i) => i === 0 || v > k[i - 1]);
  if (!knotsOk(m.us) || !knotsOk(m.vs)) return false;
  const nx = 3 * (m.us.length - 1) + 1;
  const ny = 3 * (m.vs.length - 1) + 1;
  return m.points.length === nx * ny && m.points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
}

/** knots 二分定位:所在面片下标 + 面片内参数。 */
function locate(knots: number[], s: number): [number, number] {
  if (knots.length < 2) return [0, 0];
  const n = knots.length - 1;
  const v = Number.isFinite(s) ? Math.min(1, Math.max(0, s)) : 0;
  let lo = 1, hi = n; // partition_point(knots[1..n] < v)
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (knots[mid] < v) lo = mid + 1;
    else hi = mid;
  }
  const i = lo - 1;
  const w = knots[i + 1] - knots[i];
  return [i, w > 0 ? (v - knots[i]) / w : 0];
}

/** 归一化 (s,t) 处求值曲面(引擎 eval)。 */
export function meshEval(m: WarpMesh, s: number, t: number): Pt {
  if (m.us.length < 2 || m.vs.length < 2) return [0, 0];
  const [pi, a] = locate(m.us, s);
  const [pj, b] = locate(m.vs, t);
  const ba = bernstein(a), bb = bernstein(b);
  const nx = meshNx(m);
  let x = 0, y = 0;
  for (let j = 0; j < 4; j++) {
    for (let i = 0; i < 4; i++) {
      const idx = (3 * pj + j) * nx + 3 * pi + i;
      const p = m.points[idx];
      if (!p) return [0, 0];
      const k = ba[i] * bb[j];
      x += p[0] * k;
      y += p[1] * k;
    }
  }
  return [x, y];
}

/** 在 s 处切分所在面片列(精确);s 贴近既有边界返回 false。 */
export function meshSplitU(m: WarpMesh, s: number): boolean {
  const [pi, a] = locate(m.us, s);
  if (!(a >= 0.01 && a <= 0.99)) return false;
  const nx = meshNx(m), ny = meshNy(m);
  const pts: Pt[] = [];
  for (let j = 0; j < ny; j++) {
    const row = m.points.slice(j * nx, (j + 1) * nx);
    pts.push(...row.slice(0, 3 * pi));
    pts.push(...splitCubic([row[3 * pi], row[3 * pi + 1], row[3 * pi + 2], row[3 * pi + 3]], a));
    pts.push(...row.slice(3 * pi + 4));
  }
  m.points = pts;
  m.us.splice(pi + 1, 0, Math.min(1, Math.max(0, s)));
  return true;
}

const meshTranspose = (m: WarpMesh): void => {
  const nx = meshNx(m), ny = meshNy(m);
  const pts: Pt[] = Array.from({ length: nx * ny }, () => [0, 0]);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      pts[i * ny + j] = m.points[j * nx + i];
    }
  }
  m.points = pts;
  const t = m.us;
  m.us = m.vs;
  m.vs = t;
};

/** 在 t 处切分面片行(经转置复用 splitU)。 */
export function meshSplitV(m: WarpMesh, t: number): boolean {
  meshTranspose(m);
  const ok = meshSplitU(m, t);
  meshTranspose(m);
  return ok;
}

/** 去除内部竖边界 k(合并两列面片;De Casteljau 逆推)。 */
export function meshRemoveSplitU(m: WarpMesh, k: number): boolean {
  if (k === 0 || k >= m.us.length - 1) return false;
  const a = (m.us[k] - m.us[k - 1]) / (m.us[k + 1] - m.us[k - 1]);
  const nx = meshNx(m), ny = meshNy(m);
  const pts: Pt[] = [];
  const c0 = 3 * (k - 1);
  for (let j = 0; j < ny; j++) {
    const row = m.points.slice(j * nx, (j + 1) * nx);
    const p0 = row[c0], q1 = row[c0 + 1], r2 = row[c0 + 5], p3 = row[c0 + 6];
    const p1: Pt = [(q1[0] - (1 - a) * p0[0]) / a, (q1[1] - (1 - a) * p0[1]) / a];
    const p2: Pt = [(r2[0] - a * p3[0]) / (1 - a), (r2[1] - a * p3[1]) / (1 - a)];
    pts.push(...row.slice(0, c0), p0, p1, p2, p3, ...row.slice(c0 + 7));
  }
  m.points = pts;
  m.us.splice(k, 1);
  return true;
}

export function meshRemoveSplitV(m: WarpMesh, k: number): boolean {
  meshTranspose(m);
  const ok = meshRemoveSplitU(m, k);
  meshTranspose(m);
  return ok;
}

/** 曲面点最接近 p 的归一化 (s,t)(48×48 粗搜 + 12 步牛顿)。 */
export function meshParamAt(m: WarpMesh, p: Pt): [number, number] {
  const n = 48;
  let best: [number, number, number] = [0.5, 0.5, Infinity];
  for (let j = 0; j <= n; j++) {
    for (let i = 0; i <= n; i++) {
      const s = i / n, t = j / n;
      const q = meshEval(m, s, t);
      const d = (q[0] - p[0]) ** 2 + (q[1] - p[1]) ** 2;
      if (d < best[2]) best = [s, t, d];
    }
  }
  let [s, t] = [best[0], best[1]];
  for (let it = 0; it < 12; it++) {
    const h = 1e-5;
    const q = meshEval(m, s, t);
    const qs = meshEval(m, s + h, t), qt = meshEval(m, s, t + h);
    const a = (qs[0] - q[0]) / h, b = (qt[0] - q[0]) / h, c = (qs[1] - q[1]) / h, d = (qt[1] - q[1]) / h;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-12) break;
    const ex = p[0] - q[0], ey = p[1] - q[1];
    s = Math.min(1, Math.max(0, s + (d * ex - b * ey) / det));
    t = Math.min(1, Math.max(0, t + (a * ey - c * ex) / det));
  }
  return [s, t];
}

const BORDER_ZONE = 0.12; // 距网格边界(盒单位)此距离内抓取开始带动边界
const REACH = 1.8; // 松散跟随衰减半径(被抓面片大小)

/**
 * 拖拽 (s,t) 处的曲面点位移 d(画布在面片内任意拖拽的语义)。
 * base 是拖拽开始时的控制网格;每次调用从 base 重放(替换而非累加)。
 */
export function meshPull(m: WarpMesh, base: Pt[], s: number, t: number, d: Pt): void {
  if (base.length !== m.points.length || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) return;
  m.points = base.map((p) => [...p] as Pt);
  const cols = m.us.length - 1, rows = m.vs.length - 1;
  const [pi, a] = locate(m.us, s);
  const [pj, b] = locate(m.vs, t);
  const ba = bernstein(a), bb = bernstein(b);
  const nx = meshNx(m);
  const anchor = (ai: number, aj: number): Pt => base[3 * aj * nx + 3 * ai] ?? [0, 0];
  const at0 = meshEval(m, s, t);
  const target: Pt = [at0[0] + d[0], at0[1] + d[1]];
  // 被抓面片大小与其"内部度":中心 1、边上 0。
  let size = 1;
  for (const k of [0, 1] as const) {
    const vals = [anchor(pi, pj)[k], anchor(pi + 1, pj)[k], anchor(pi, pj + 1)[k], anchor(pi + 1, pj + 1)[k]];
    const lo = Math.min(...vals), hi = Math.max(...vals);
    size = Math.max(size, hi - lo);
  }
  const radius = REACH * size;
  const innerW = (ba[1] + ba[2]) * (bb[1] + bb[2]);
  const interior = Math.min(1, Math.max(0, innerW / 0.5625));
  const toBorder = Math.min(s, 1 - s, t, 1 - t);
  const nearBorder = Math.min(1, Math.max(0, 1 - toBorder / BORDER_ZONE));
  const meshCorner = (ai: number, aj: number) => (ai === 0 || ai === cols) && (aj === 0 || aj === rows);
  const reach = (ai: number, aj: number, wa: number, wb: number): number => {
    const border = ai === 0 || ai === cols || aj === 0 || aj === rows;
    return meshCorner(ai, aj) ? 0 : wa * wb * (border ? nearBorder : 1);
  };
  const corner: Array<[number, number, number]> = [
    [pi, pj, reach(pi, pj, ba[0] + ba[1], bb[0] + bb[1])],
    [pi + 1, pj, reach(pi + 1, pj, ba[2] + ba[3], bb[0] + bb[1])],
    [pi, pj + 1, reach(pi, pj + 1, ba[0] + ba[1], bb[2] + bb[3])],
    [pi + 1, pj + 1, reach(pi + 1, pj + 1, ba[2] + ba[3], bb[2] + bb[3])],
  ];
  // 每个锚分担 d 的份额。
  const share: number[] = new Array((cols + 1) * (rows + 1)).fill(0);
  for (let aj = 0; aj <= rows; aj++) {
    for (let ai = 0; ai <= cols; ai++) {
      const p = anchor(ai, aj);
      const x = Math.min(1, Math.max(0, Math.hypot(p[0] - at0[0], p[1] - at0[1]) / radius));
      const fall = 0.5 * (1 + Math.cos(PI * x));
      const border = ai === 0 || ai === cols || aj === 0 || aj === rows;
      const edge = meshCorner(ai, aj) ? 0 : border ? nearBorder : 1;
      share[aj * (cols + 1) + ai] = fall * edge;
    }
  }
  // 被抓面片自己的角:靠近某角时该角跟随指针。
  for (const [ai, aj, w] of corner) {
    const idx = aj * (cols + 1) + ai;
    share[idx] = Math.max(share[idx], (1 - interior) * w);
  }
  // 每个控制点跟着最近的锚移动。
  for (let j = 0; j < meshNy(m); j++) {
    for (let i = 0; i < nx; i++) {
      const ai = Math.min(cols, (i + 1) / 3 | 0);
      const aj = Math.min(rows, (j + 1) / 3 | 0);
      const k = share[aj * (cols + 1) + ai];
      m.points[j * nx + i][0] += d[0] * k;
      m.points[j * nx + i][1] += d[1] * k;
    }
  }
  // 精确闭合缺口:内四点 / 角块 / 近边界时的边柄三组分担,平滑后重闭。
  let norm = 0;
  for (const j of [1, 2]) for (const i of [1, 2]) norm += (ba[i] * bb[j]) ** 2;
  const cornerNorm = corner.reduce((acc, c) => acc + c[2] * c[2], 0);
  const innerPart = cornerNorm > 1e-12 ? Math.min(1, innerW / 0.15) : 1;
  const edge: Array<[number, number]> = [];
  for (const k of [1, 2] as const) {
    if (pi === 0) edge.push([(3 * pj + k) * nx + 3 * pi, ba[0] * bb[k]]);
    if (pi + 1 === cols) edge.push([(3 * pj + k) * nx + 3 * pi + 3, ba[3] * bb[k]]);
    if (pj === 0) edge.push([3 * pj * nx + 3 * pi + k, ba[k] * bb[0]]);
    if (pj + 1 === rows) edge.push([(3 * pj + 3) * nx + 3 * pi + k, ba[k] * bb[3]]);
  }
  const edgeNorm = edge.reduce((acc, e) => acc + e[1] * e[1], 0);
  const edgePart = edgeNorm > 1e-12 ? nearBorder : 0;
  const innerShare = (1 - edgePart) * innerPart;
  const cornerShare = (1 - edgePart) * (1 - innerPart);
  for (let iter = 0; iter < 60; iter++) {
    const now = meshEval(m, s, t);
    const rem: Pt = [target[0] - now[0], target[1] - now[1]];
    if (Math.hypot(rem[0], rem[1]) < 1e-9) break;
    if (innerShare > 0 && norm > 0) {
      for (const j of [1, 2] as const) {
        for (const i of [1, 2] as const) {
          const k = ((ba[i] * bb[j]) / norm) * innerShare;
          m.points[(3 * pj + j) * nx + 3 * pi + i][0] += rem[0] * k;
          m.points[(3 * pj + j) * nx + 3 * pi + i][1] += rem[1] * k;
        }
      }
    }
    if (edgePart > 0) {
      for (const [idx, w] of edge) {
        const p = m.points[idx];
        if (p) {
          const k = (w / edgeNorm) * edgePart;
          p[0] += rem[0] * k;
          p[1] += rem[1] * k;
        }
      }
    }
    if (cornerShare > 0 && cornerNorm > 0) {
      for (const [ai, aj, w] of corner) {
        const k = (w / cornerNorm) * cornerShare;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const i = 3 * ai + di, j = 3 * aj + dj;
            if (i >= 0 && j >= 0 && i < nx && j < meshNy(m)) {
              m.points[j * nx + i][0] += rem[0] * k;
              m.points[j * nx + i][1] += rem[1] * k;
            }
          }
        }
      }
    }
    for (let sm = 0; sm < 3; sm++) {
      meshSmoothLines(m, Math.max(0, 3 * pi - 3), 3 * pi + 7, Math.max(0, 3 * pj - 3), 3 * pj + 7);
    }
  }
}

/** 内部网格线两侧切线取平均(列 i0..i1、行 j0..j1,开区间,钳网格)。 */
export function meshSmoothLines(m: WarpMesh, i0: number, i1: number, j0: number, j1: number): void {
  const nx = meshNx(m), ny = meshNy(m);
  const e1 = Math.min(i1, nx), f1 = Math.min(j1, ny);
  const hu = (k: number) => m.us[k + 1] - m.us[k];
  const hv = (k: number) => m.vs[k + 1] - m.vs[k];
  const triples: Array<[number, number, number, number, number]> = [];
  for (let a = 1; a < m.us.length - 1; a++) {
    if (3 * a >= i0 && 3 * a < e1) {
      for (let j = j0; j < f1; j++) triples.push([j * nx + 3 * a - 1, j * nx + 3 * a, j * nx + 3 * a + 1, hu(a - 1), hu(a)]);
    }
  }
  for (let b2 = 1; b2 < m.vs.length - 1; b2++) {
    if (3 * b2 >= j0 && 3 * b2 < f1) {
      for (let i = i0; i < e1; i++) triples.push([(3 * b2 - 1) * nx + i, 3 * b2 * nx + i, (3 * b2 + 1) * nx + i, hv(b2 - 1), hv(b2)]);
    }
  }
  for (const [l, c, r, hl, hr] of triples) {
    const pl = m.points[l], pc = m.points[c], pr = m.points[r];
    const tan: Pt = [((pc[0] - pl[0]) / hl + (pr[0] - pc[0]) / hr) / 2, ((pc[1] - pl[1]) / hl + (pr[1] - pc[1]) / hr) / 2];
    m.points[l] = [pc[0] - tan[0] * hl, pc[1] - tan[1] * hl];
    m.points[r] = [pc[0] + tan[0] * hr, pc[1] + tan[1] * hr];
  }
}

/**
 * 拖控制点 index 位移 d(自 base 网格),保持曲面跨网格线平滑:
 * 锚=与其周围 8 点成块移动;柄=跨线两点同行移动、同锚对面的柄反向(线直穿过锚不折角)。
 */
export function meshDragPoint(m: WarpMesh, base: Pt[], index: number, d: Pt): void {
  if (base.length !== m.points.length || index >= base.length || !Number.isFinite(d[0]) || !Number.isFinite(d[1])) return;
  m.points = base.map((p) => [...p] as Pt);
  const nx = meshNx(m), ny = meshNy(m);
  const i = index % nx, j = (index / nx) | 0;
  const shift = (ii: number, jj: number, dd: Pt): void => {
    if (ii >= 0 && jj >= 0 && ii < nx && jj < ny) {
      m.points[jj * nx + ii][0] += dd[0];
      m.points[jj * nx + ii][1] += dd[1];
    }
  };
  const ii = i, jj = j;
  const span = (knots: number[], k: number): [number, number] | null =>
    k > 0 && k + 1 < knots.length ? [knots[k] - knots[k - 1], knots[k + 1] - knots[k]] : null;
  const mi = i % 3, mj = j % 3;
  if (mi === 0 && mj === 0) {
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) shift(ii + di, jj + dj, d);
  } else if (mi === 0) {
    // 竖线上的柄:带跨线两点;同锚对面柄反向。
    for (let di = -1; di <= 1; di++) shift(ii + di, jj, d);
    const r = mj;
    const sp = span(m.vs, (j / 3 | 0) + (r === 2 ? 1 : 0));
    if (sp) {
      const [hl, hr] = sp;
      const other = r === 1 ? jj - 2 : jj + 2;
      const k = r === 1 ? hl / hr : hr / hl;
      for (let di = -1; di <= 1; di++) shift(ii + di, other, [-d[0] * k, -d[1] * k]);
    }
  } else if (mj === 0) {
    for (let dj = -1; dj <= 1; dj++) shift(ii, jj + dj, d);
    const r = mi;
    const sp = span(m.us, (i / 3 | 0) + (r === 2 ? 1 : 0));
    if (sp) {
      const [hl, hr] = sp;
      const other = r === 1 ? ii - 2 : ii + 2;
      const k = r === 1 ? hl / hr : hr / hl;
      for (let dj = -1; dj <= 1; dj++) shift(other, jj + dj, [-d[0] * k, -d[1] * k]);
    }
  } else {
    // 面片内点没有自己的柄。
    shift(ii, jj, d);
  }
}

/** 控制点包围盒(曲面在其中)。 */
export function meshControlBounds(m: WarpMesh): RectF {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of m.points) {
    x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]);
    x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]);
  }
  return [x0, y0, x1, y1];
}

// ---- 完整 Warp 对象(引擎 Warp)----

export interface WarpObject {
  style: WarpStyleId;
  bend: number;
  hDistort: number;
  vDistort: number;
  vertical: boolean;
  bounds: RectF;
  mesh: WarpMesh | null;
}

export const warpNone = (bounds: RectF): WarpObject => ({ style: 'none', bend: 0, hDistort: 0, vDistort: 0, vertical: false, bounds, mesh: null });

export const warpPreset = (style: WarpStyleId, bend: number, bounds: RectF): WarpObject => ({ ...warpNone(bounds), style, bend });

export const warpCustom = (mesh: WarpMesh, bounds: RectF): WarpObject => ({ ...warpNone(bounds), style: 'custom', mesh });

const boxPoint = (b: RectF, s: number, t: number): Pt => [b[0] + s * (b[2] - b[0]), b[1] + t * (b[3] - b[1])];

/** 源点(盒内)映射到输出空间(引擎 Warp::map)。 */
export function warpMap(w: WarpObject, x: number, y: number): Pt {
  if (w.style === 'none') return [x, y];
  if (w.style === 'custom') {
    if (!w.mesh) return [x, y];
    const b = w.bounds;
    const bw = b[2] - b[0], bh = b[3] - b[1];
    if (bw <= 0 || bh <= 0) return [x, y];
    return meshEval(w.mesh, (x - b[0]) / bw, (y - b[1]) / bh);
  }
  const sw = styleWarpNew(w.style, w.bend, w.hDistort, w.vDistort, w.vertical, w.bounds);
  return sw ? styleWarpApply(sw, x, y) : [x, y];
}

/** warp 作为控制网格(预设精确拆分 cols×rows;custom 原样)。 */
export function warpToMesh(w: WarpObject, cols: number, rows: number): WarpMesh {
  if (w.style === 'custom' && w.mesh) return { us: [...w.mesh.us], vs: [...w.mesh.vs], points: w.mesh.points.map((p) => [...p] as Pt) };
  const c = Math.min(64, Math.max(1, cols)), r = Math.min(64, Math.max(1, rows));
  const sw = styleWarpNew(w.style, w.bend, w.hDistort, w.vDistort, w.vertical, w.bounds);
  if (sw) {
    const m = styleWarpMesh(sw);
    for (let i = 1; i < c; i++) meshSplitU(m, i / c);
    for (let j = 1; j < r; j++) meshSplitV(m, j / r);
    return m;
  }
  const us = Array.from({ length: c + 1 }, (_, i) => i / c);
  const vs = Array.from({ length: r + 1 }, (_, i) => i / r);
  return meshFit((s, t) => warpMap(w, ...boxPoint(w.bounds, s, t)), us, vs);
}

/** 引擎 Warp::is_identity(每个三分采样点映射回原位)。 */
export function warpIsIdentity(w: WarpObject): boolean {
  if (w.style === 'none') return true;
  if (w.style === 'custom') {
    if (!w.mesh) return true;
    if (!meshIsValid(w.mesh)) return false;
    const m = w.mesh;
    const nx = meshNx(m);
    const pc = m.us.length - 1, pr = m.vs.length - 1;
    for (let pj = 0; pj < pr; pj++) {
      for (let j = 0; j < 4; j++) {
        const v = m.vs[pj] + (m.vs[pj + 1] - m.vs[pj]) * (j / 3);
        for (let pi = 0; pi < pc; pi++) {
          for (let i = 0; i < 4; i++) {
            const u = m.us[pi] + (m.us[pi + 1] - m.us[pi]) * (i / 3);
            const expected = boxPoint(w.bounds, u, v);
            const actual = m.points[(3 * pj + j) * nx + 3 * pi + i];
            const tol = (e: number) => Math.min(1e-6, 1e-9 * Math.max(1, Math.abs(e)));
            if (Math.abs(actual[0] - expected[0]) >= tol(expected[0]) || Math.abs(actual[1] - expected[1]) >= tol(expected[1])) return false;
          }
        }
      }
    }
    return true;
  }
  return styleWarpNew(w.style, w.bend, w.hDistort, w.vDistort, w.vertical, w.bounds) === null;
}

// ---- 预览采样(ui-egui/warp_preview.rs 逐行)----

const SEGMENT_PX = 6.0; // 每预览段的目标屏幕像素
const MIN_PER_CELL = 4;
const MAX_PER_CELL = 96;
const MAX_PER_AXIS = 240; // 单轴总采样上限(三角形数随乘积增长;GPU mesh 的上游预算)

/** 网格采样位置 (us, vs):每 cell 按控制点展开宽自适应细分;全部网格线都是采样。
 * maxPerAxis:单轴总采样上限(上游 MAX_PER_AXIS=240;Canvas2D 三角贴图帧预算外参)。 */
export function previewSamples(m: WarpMesh, zoom: number, maxPerAxis: number = MAX_PER_AXIS): [number[], number[]] {
  const z = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const cols = m.us.length - 1, rows = m.vs.length - 1;
  const nx = meshNx(m);
  const cu = new Array(cols).fill(MIN_PER_CELL);
  const cv = new Array(rows).fill(MIN_PER_CELL);
  for (let b = 0; b < rows; b++) {
    for (let a = 0; a < cols; a++) {
      const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
      for (let j = 0; j < 4; j++) {
        for (let i = 0; i < 4; i++) {
          const p = m.points[(3 * b + j) * nx + 3 * a + i];
          if (p) {
            lo[0] = Math.min(lo[0], p[0]); hi[0] = Math.max(hi[0], p[0]);
            lo[1] = Math.min(lo[1], p[1]); hi[1] = Math.max(hi[1], p[1]);
          }
        }
      }
      const ext = Math.abs(Math.max(hi[0] - lo[0], hi[1] - lo[1]) * z);
      const n = Number.isFinite(ext) ? Math.ceil(ext / SEGMENT_PX) : MIN_PER_CELL;
      const c = Math.min(MAX_PER_CELL, Math.max(MIN_PER_CELL, n));
      cu[a] = Math.max(cu[a], c);
      cv[b] = Math.max(cv[b], c);
    }
  }
  return [previewAxis(m.us, cu, maxPerAxis), previewAxis(m.vs, cv, maxPerAxis)];
}

/** 单轴采样:counts[k] 段割 knot 区间 k;总数超上限时等比压回(每段至少 2)。 */
function previewAxis(knots: number[], counts: number[], maxPerAxis: number): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total > maxPerAxis) {
    for (let i = 0; i < counts.length; i++) counts[i] = Math.max(2, (counts[i] * maxPerAxis / total) | 0);
  }
  const out: number[] = [];
  for (let k = 0; k < counts.length; k++) {
    const [a, b] = [knots[k], knots[k + 1]];
    for (let i = 0; i < counts[k]; i++) out.push(a + ((b - a) * i) / counts[k]);
  }
  out.push(1);
  return out;
}

/** 三角形索引:cell 按位移从大到小排(折叠时上层不被梳状覆盖)。 */
export function triangleOrder(pos: Pt[], rest: Pt[], row: number): number[] {
  if (row < 2 || pos.length !== rest.length) return [];
  const rows = (pos.length / row) | 0;
  const moved = (k: number) => (pos[k] && rest[k] ? Math.hypot(pos[k][0] - rest[k][0], pos[k][1] - rest[k][1]) : 0);
  const cells: Array<[number, number]> = [];
  for (let j = 0; j < Math.max(0, rows - 1); j++) {
    for (let i = 0; i < row - 1; i++) {
      const a = j * row + i;
      cells.push([(moved(a) + moved(a + 1) + moved(a + row) + moved(a + row + 1)) / 4, a]);
    }
  }
  cells.sort((x, y) => y[0] - x[0]);
  const out: number[] = [];
  for (const [, a] of cells) out.push(a, a + 1, a + row + 1, a, a + row + 1, a + row);
  return out;
}

// ---- 分割/网格(engine/warp_cmds.rs 纯函数部分)----

export type SplitKind = 'cross' | 'vertical' | 'horizontal' | 'remove';

/** 默认 warp 在单面片上画三分导引线;分割前先物化成真 knot(切分屏幕上的网格而非替换)。 */
function commitDefaultSections(mesh: WarpMesh): void {
  meshSplitU(mesh, 1 / 3);
  meshSplitU(mesh, 2 / 3);
  meshSplitV(mesh, 1 / 3);
  meshSplitV(mesh, 2 / 3);
}

/** 对 w 的 mesh 施加分割(或移除最近 at 的分割);预设先物化为 custom。曲面不变。 */
export function splitWarp(w: WarpObject, at: Pt | null, how: SplitKind): WarpObject | null {
  const mesh = warpToMesh(w, 1, 1);
  if (how !== 'remove' && w.style === 'custom' && mesh.us.length === 2 && mesh.vs.length === 2) {
    commitDefaultSections(mesh);
  }
  let [s, t] = at ? meshParamAt(mesh, at) : [0.5, 0.5];
  if (!at) {
    const mid = (k: number[], v: number): number => {
      let i = 0;
      for (let x = 0; x + 1 < k.length; x++) {
        if (v <= k[x + 1]) { i = x; break; }
        i = k.length - 2;
      }
      return (k[i] + k[i + 1]) / 2;
    };
    s = mid(mesh.us, s);
    t = mid(mesh.vs, t);
  }
  let ok: boolean;
  switch (how) {
    case 'cross': {
      const a = meshSplitU(mesh, s);
      const b = meshSplitV(mesh, t);
      ok = a || b;
      break;
    }
    // 水平分割线切行;垂直分割线切列。
    case 'horizontal':
      ok = meshSplitV(mesh, t);
      break;
    case 'vertical':
      ok = meshSplitU(mesh, s);
      break;
    default: {
      const near = (k: number[], v: number): number | null => {
        let best: number | null = null, bd = Infinity;
        for (let i = 1; i < k.length - 1; i++) {
          const d = Math.abs(k[i] - v);
          if (d < bd) { bd = d; best = i; }
        }
        return best;
      };
      const iu = near(mesh.us, s), iv = near(mesh.vs, t);
      const du = iu == null ? Infinity : Math.abs(mesh.us[iu] - s);
      const dv = iv == null ? Infinity : Math.abs(mesh.vs[iv] - t);
      if (iu != null && du <= dv) ok = meshRemoveSplitU(mesh, iu);
      else if (iv != null) ok = meshRemoveSplitV(mesh, iv);
      else ok = false;
    }
  }
  return ok ? warpCustom(mesh, w.bounds) : null;
}

/** 偶数 n×n 面片保形重拟(knot=i/n;曲面不变)。 */
export function resizeWarp(w: WarpObject, n: number): WarpObject {
  const mesh = warpToMesh(w, 1, 1);
  const knots = Array.from({ length: n + 1 }, (_, i) => i / n);
  return warpCustom(meshFit((s, t) => meshEval(mesh, s, t), knots, knots), w.bounds);
}

/** 网格读出:default=1×1,数字=均匀 n×n;手切过=custom。 */
export function warpGridId(mesh: WarpMesh): 'default' | '3' | '4' | '5' | 'custom' {
  const cols = mesh.us.length - 1, rows = mesh.vs.length - 1;
  const even = (k: number[]): boolean => {
    const n = k.length - 1;
    return n > 0 && k.every((v, i) => Math.abs(v - i / n) < 1e-4);
  };
  if (cols === rows && even(mesh.us) && even(mesh.vs)) {
    switch (cols) {
      case 1: return 'default';
      case 3: return '3';
      case 4: return '4';
      case 5: return '5';
      default: return 'custom';
    }
  }
  return 'custom';
}

/** 单面片(Grid›Default)画三分导引;更密的预设只有真实面片边界。 */
export const meshSinglePatch = (m: WarpMesh): boolean => m.us.length === 2 && m.vs.length === 2;

/** 网格线上的点(锚+柄;i%3==0 || j%3==0)内 tol 最近的控制点下标,否则 null。 */
export function warpHit(m: WarpMesh, p: Pt, tol: number): number | null {
  const nx = meshNx(m);
  let best: number | null = null, bd = Infinity;
  for (let i = 0; i < m.points.length; i++) {
    const gi = i % nx, gj = (i / nx) | 0;
    if (gi % 3 !== 0 && gj % 3 !== 0) continue;
    const d = Math.hypot(m.points[i][0] - p[0], m.points[i][1] - p[1]);
    if (d < tol && d < bd) { bd = d; best = i; }
  }
  return best;
}

/** p 在弯曲网格内的 (s,t);回代距离 ≥1px(面片外)→ null。 */
export function surfaceAt(m: WarpMesh, p: Pt): [number, number] | null {
  const [s, t] = meshParamAt(m, p);
  const q = meshEval(m, s, t);
  return Math.hypot(q[0] - p[0], q[1] - p[1]) < 1 ? [s, t] : null;
}

/** 柄所属的锚(控制格坐标;锚是其自身)。 */
export function handleAnchor(i: number, j: number): [number, number] {
  if (i % 3 === 0) {
    const aj = j % 3 === 0 ? j : j % 3 === 1 ? j - 1 : j + 1;
    return [i, aj];
  }
  return [i % 3 === 1 ? i - 1 : i + 1, j];
}

/** Ctrl/Alt 点击的分割选择:开阔处十字;靠近已有网格线取垂直分割。 */
export function quickSplitKind(mesh: WarpMesh, bounds: RectF, s: number, t: number): SplitKind {
  const w = Math.max(1, Math.abs(bounds[2] - bounds[0]));
  const h = Math.max(1, Math.abs(bounds[3] - bounds[1]));
  const su = Math.min(0.12, Math.max(0.02, 8 / w));
  const sv = Math.min(0.12, Math.max(0.02, 8 / h));
  const thirds = meshSinglePatch(mesh);
  const near = (knots: number[], v: number, tol: number): boolean =>
    knots.some((k) => k > 0 && k < 1 && Math.abs(k - v) < tol) ||
    (thirds && [1 / 3, 2 / 3].some((k) => Math.abs(k - v) < tol));
  const [nu, nv] = [near(mesh.us, s, su), near(mesh.vs, t, sv)];
  if (nu && !nv) return 'horizontal';
  if (!nu && nv) return 'vertical';
  return 'cross';
}

/** 回到未动过的盒:盒上默认单面片恒等网格(引擎 reset_warp)。 */
export function resetWarp(rect: RectF): WarpObject {
  return warpCustom(meshIdentity(rect, 1, 1), rect);
}

/** TextWarp 的 PSD 名("warpArcLower")→ 短 id("arcLower");"warpNone"→"none"。 */
export function psdWarpToShort(psd: string): WarpStyleId {
  if (psd === 'warpNone' || !psd.startsWith('warp')) return 'none';
  const rest = psd.slice(4);
  return (rest.charAt(0).toLowerCase() + rest.slice(1)) as WarpStyleId;
}
