/**
 * Warp 纯几何测试(引擎 geom/warp.rs + ui-egui/warp_preview.rs + warp_cmds.rs 测试语义的 TS 移植;
 * 测试名钉上游语义)。
 */
import { describe, expect, it } from 'vitest';
import {
  meshDragPoint, meshEval, meshFit, meshIdentity, meshNx, meshParamAt, meshPoint,
  meshPull, meshRemoveSplitU, meshRemoveSplitV, meshSplitU, meshSplitV, previewSamples,
  quickSplitKind, resetWarp, resizeWarp, splitWarp, styleWarpApply, styleWarpMesh, styleWarpNew,
  surfaceAt, triangleOrder, warpGridId, warpHit, warpIsIdentity, warpMap, warpToMesh,
  WARP_PRESETS, type Pt, type WarpMesh,
} from '../warpLogic';

const B: [number, number, number, number] = [10, 20, 110, 70]; // 100×50 盒

/** 任一内部网格线两侧切线最大失配(引擎 tests::tangent_defect)。 */
function tangentDefect(m: WarpMesh): number {
  const nx = meshNx(m);
  let worst = 0;
  for (let a = 1; a < m.us.length - 1; a++) {
    const [hl, hr] = [m.us[a] - m.us[a - 1], m.us[a + 1] - m.us[a]];
    for (let j = 0; j < meshNx(m) * 0 + (3 * (m.vs.length - 1) + 1); j++) {
      const idx = (k: number) => m.points[j * nx + k];
      const l = idx(3 * a - 1), c = idx(3 * a), r = idx(3 * a + 1);
      const dl = Math.abs((c[0] - l[0]) / hl - (r[0] - c[0]) / hr) + Math.abs((c[1] - l[1]) / hl - (r[1] - c[1]) / hr);
      worst = Math.max(worst, dl / 2);
    }
  }
  for (let b = 1; b < m.vs.length - 1; b++) {
    const [hv, hw] = [m.vs[b] - m.vs[b - 1], m.vs[b + 1] - m.vs[b]];
    const ny = 3 * (m.vs.length - 1) + 1;
    for (let i = 0; i < nx; i++) {
      const l = m.points[(3 * b - 1) * nx + i], c = m.points[3 * b * nx + i], r = m.points[(3 * b + 1) * nx + i];
      const d = Math.abs((c[0] - l[0]) / hv - (r[0] - c[0]) / hw) + Math.abs((c[1] - l[1]) / hv - (r[1] - c[1]) / hw);
      worst = Math.max(worst, d / 2);
    }
  }
  return worst;
}

/** Jacobian 行列式最小值(折叠=负;cell 中点采样避开边界零向量)。 */
function minFold(m: WarpMesh, n = 40): number {
  let worst = Infinity;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const s = (i + 0.5) / n, t = (j + 0.5) / n;
      const h = 1e-4;
      const p = meshEval(m, s, t);
      const ps = meshEval(m, Math.min(1, s + h), t);
      const pt = meshEval(m, s, Math.min(1, t + h));
      const du = [(ps[0] - p[0]) / h, (ps[1] - p[1]) / h];
      const dv = [(pt[0] - p[0]) / h, (pt[1] - p[1]) / h];
      const det = du[0] * dv[1] - du[1] * dv[0];
      worst = Math.min(worst, det);
    }
  }
  return worst;
}

describe('mesh identity/fit/eval', () => {
  it('identity 精确、fit 对仿射精确(引擎 identity_mesh_is_exact_and_fit_reproduces_affine)', () => {
    const m = meshIdentity(B, 1, 1);
    for (const [s, t] of [[0, 0], [0.5, 0.5], [1, 1], [0.3, 0.7]] as const) {
      const p = meshEval(m, s, t);
      expect(p[0]).toBeCloseTo(B[0] + s * 100, 9);
      expect(p[1]).toBeCloseTo(B[1] + t * 50, 9);
    }
    const aff = (s: number, t: number): Pt => [12 + 3 * s - 2 * t, 5 - s + 4 * t];
    const f = meshFit(aff, [0, 0.5, 1], [0, 1]);
    for (const [s, t] of [[0.1, 0.2], [0.75, 0.5], [0.5, 0.9]] as const) {
      const p = meshEval(f, s, t);
      expect(p[0]).toBeCloseTo(aff(s, t)[0], 9);
      expect(p[1]).toBeCloseTo(aff(s, t)[1], 9);
    }
  });

  it('多 patch 网格求值跨面片连续', () => {
    const m = meshIdentity(B, 3, 2);
    const p1 = meshEval(m, 1 / 3 - 1e-7, 0.5);
    const p2 = meshEval(m, 1 / 3 + 1e-7, 0.5);
    expect(Math.hypot(p1[0] - p2[0], p1[1] - p2[1])).toBeLessThan(1e-4);
  });
});

describe('split/remove(引擎 splits_are_exact_and_removable)', () => {
  it('分割前后曲面逐点一致,remove 后完全还原', () => {
    const base = meshIdentity(B, 1, 1);
    const m: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    expect(meshSplitU(m, 0.4)).toBe(true);
    expect(meshSplitV(m, 0.6)).toBe(true);
    for (let j = 0; j <= 11; j++) {
      for (let i = 0; i <= 11; i++) {
        const p1 = meshEval(base, i / 11, j / 11);
        const p2 = meshEval(m, i / 11, j / 11);
        expect(Math.hypot(p1[0] - p2[0], p1[1] - p2[1])).toBeLessThan(1e-9);
      }
    }
    // us=[0,0.4,1] 中 0.4 是内部边界 k=1;vs 同理
    expect(meshRemoveSplitU(m, 1)).toBe(true);
    expect(meshRemoveSplitV(m, 1)).toBe(true);
    expect(m.us).toEqual(base.us);
    expect(m.vs).toEqual(base.vs);
    expect(m.points.every((p, i) => Math.hypot(p[0] - base.points[i][0], p[1] - base.points[i][1]) < 1e-9)).toBe(true);
  });

  it('贴近既有 knot 的分割是 no-op(split_u 拒绝 patch 内参数 <0.01)', () => {
    const m = meshIdentity(B, 2, 1);
    expect(meshSplitU(m, 0.5)).toBe(false); // 0.5 已是 knot
    expect(meshSplitU(m, 0.504)).toBe(false); // patch 内参数 0.008 < 0.01
    expect(meshSplitU(m, 0.505)).toBe(true); // 恰 0.01 = 含边界(引擎 0.01..=0.99)
    expect(meshSplitU(m, 0.53)).toBe(true);
  });

  it('param_at 回代:曲面点求回 (s,t)(引擎 48 粗搜+牛顿)', () => {
    const m = meshIdentity(B, 2, 2);
    for (const [s, t] of [[0.25, 0.75], [0.6, 0.3], [0.9, 0.9]] as const) {
      const p = meshEval(m, s, t);
      const [s2, t2] = meshParamAt(m, p);
      expect(Math.hypot(s2 - s, t2 - t)).toBeLessThan(1e-4);
    }
  });
});

describe('pull(引擎 pull 测试族)', () => {
  it('中部拉拽边界不动、拉点精确落位(a_pull_in_the_middle_leaves_the_border_where_it_is)', () => {
    const base = meshIdentity(B, 4, 4);
    const m: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    meshPull(m, base.points, 0.5, 0.5, [12, -7]);
    const nx = meshNx(m);
    // 边框控制点(i=0|nx-1 或 j=0|ny-1 的锚与柄)不动
    const ny = 3 * 4 + 1;
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        if (i !== 0 && i !== nx - 1 && j !== 0 && j !== ny - 1) continue;
        const a = meshPoint(m, i, j), b = meshPoint(base, i, j);
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-6);
      }
    }
    const got = meshEval(m, 0.5, 0.5);
    const want = meshEval(base, 0.5, 0.5);
    expect(Math.hypot(got[0] - (want[0] + 12), got[1] - (want[1] - 7))).toBeLessThan(1e-4);
  });

  it('远处拉拽不移动边框(a_pull_anywhere_away_from_the_border…)', () => {
    const base = meshIdentity(B, 1, 1);
    const m: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    meshPull(m, base.points, 0.35, 0.55, [-25, 15]);
    const cornersIdx = [0, 3, 12, 15]; // 4×4 网格四角
    for (const i of cornersIdx) {
      expect(Math.hypot(m.points[i][0] - base.points[i][0], m.points[i][1] - base.points[i][1])).toBeLessThan(1e-6);
    }
    const got = meshEval(m, 0.35, 0.55);
    const want = meshEval(base, 0.35, 0.55);
    expect(Math.hypot(got[0] - (want[0] - 25), got[1] - (want[1] + 15))).toBeLessThan(1e-4);
  });

  it('1/4 cell 内拖拽不折叠曲面(a_pull_within_a_quarter_cell_never_folds)', () => {
    const base = meshIdentity(B, 4, 4);
    const m: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    meshPull(m, base.points, 0.47, 0.5, [-18, 9]);
    expect(minFold(m, 30)).toBeGreaterThan(0);
    expect(tangentDefect(m)).toBeLessThan(1e-6);
  });

  it('同 base 重复 pull 是替换不是累加(pull_moves_the_grabbed_surface_point_exactly…)', () => {
    const base = meshIdentity(B, 2, 2);
    const m1: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    meshPull(m1, base.points, 0.4, 0.6, [10, 5]);
    meshPull(m1, base.points, 0.4, 0.6, [10, 5]);
    const m2: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    meshPull(m2, base.points, 0.4, 0.6, [10, 5]);
    expect(m1.points.every((p, i) => p[0] === m2.points[i][0] && p[1] === m2.points[i][1])).toBe(true);
  });
});

describe('drag_point(引擎 dragging_an_anchor_or_handle_keeps_the_surface_smooth)', () => {
  it('锚点带周围 3×3 块;切线连续 <1e-6;点落在指针处', () => {
    const base = meshIdentity(B, 3, 3);
    const m: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    const nx = meshNx(m);
    const idx = 3 * nx + 6; // 内部锚 (i=6, j=3):i%3==0 && j%3==0
    meshDragPoint(m, base.points, idx, [8, -5]);
    const [i, j] = [idx % nx, (idx / nx) | 0];
    const want = meshPoint(base, i, j);
    const got = meshPoint(m, i, j);
    expect(got[0]).toBeCloseTo(want[0] + 8, 9);
    expect(got[1]).toBeCloseTo(want[1] - 5, 9);
    expect(tangentDefect(m)).toBeLessThan(1e-6);
    // 周围 3×3 块同位移
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const q = meshPoint(m, i + di, j + dj), b = meshPoint(base, i + di, j + dj);
        expect(q[0]).toBeCloseTo(b[0] + 8, 9);
        expect(q[1]).toBeCloseTo(b[1] - 5, 9);
      }
    }
  });

  it('柄拖动时对面柄反向(网格线直穿过锚不折角)', () => {
    const base = meshIdentity(B, 3, 3);
    const m: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    const nx = meshNx(m);
    // 竖线上的柄 (i=3, j=4,r=1):同锚 (3,3) 的对面柄 (3,2) 反向(同跨度比)
    const idx = 4 * nx + 3;
    meshDragPoint(m, base.points, idx, [10, 0]);
    const moved = m.points[idx], baseP = base.points[idx];
    expect(moved[0]).toBeCloseTo(baseP[0] + 10, 9);
    const opp = m.points[2 * nx + 3], oppBase = base.points[2 * nx + 3];
    expect(opp[0]).toBeCloseTo(oppBase[0] - 10, 6);
    expect(tangentDefect(m)).toBeLessThan(1e-6);
  });
});

describe('预设(引擎 preset 族测试)', () => {
  it('bend 0 = identity(presets_at_bend_zero_are_identity)', () => {
    for (const style of WARP_PRESETS) {
      expect(warpMap({ ...resetWarp(B), style, bend: 0 }, B[0] + 37, B[1] + 19)).toEqual([B[0] + 37, B[1] + 19]);
    }
  });

  it('arc 50:底角保持、顶边中点上升(引擎 arc_warps_pixels 口径)', () => {
    const sw = styleWarpNew('arc', 50, 0, 0, false, B);
    expect(sw).not.toBeNull();
    const bl = styleWarpApply(sw!, B[0], B[1] + 50); // 左下角
    expect(bl[0]).toBeCloseTo(B[0], 6);
    expect(bl[1]).toBeCloseTo(B[1] + 50, 6);
    const tm = styleWarpApply(sw!, B[0] + 50, B[1]); // 顶边中点
    expect(tm[1]).toBeLessThan(B[1]); // 向上(b>0 弓向上)
  });

  it('15 预设都是合法单面片且 warpToMesh 拆分保形(preset_fits_closely_as_mesh)', () => {
    for (const style of WARP_PRESETS) {
      const w = { ...resetWarp(B), style, bend: 50 };
      const m = warpToMesh(w, 4, 4);
      for (let j = 0; j <= 8; j++) {
        for (let i = 0; i <= 8; i++) {
          const s = i / 8, t = j / 8;
          const a = warpMap(w, B[0] + s * 100, B[1] + t * 50);
          const b = meshEval(m, s, t);
          expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(0.5);
        }
      }
    }
  });

  it('vertical 转置后畸变互换(引擎 presets_match_photoshop wide/tall 组)', () => {
    const h = styleWarpNew('arc', 60, 0, 0, false, B)!;
    const v = styleWarpNew('arc', 60, 0, 0, true, B)!;
    const ph = styleWarpApply(h, B[0] + 30, B[1]);
    const pv = styleWarpApply(v, B[0], B[1] + 15); // 转置盒的"顶边中点"
    expect(ph[1]).toBeLessThan(B[1]);
    expect(pv[0]).toBeLessThan(B[0]); // 垂直弧向左弓
  });
});

describe('splitWarp/resizeWarp/warpGridId(engine warp_cmds 纯函数)', () => {
  it('identity custom 1×1 十字分割=4×4、knots {0,1/3,1/2,2/3,1}(crosswise_split_of_an_identity_custom_warp)', () => {
    const w = resetWarp(B);
    const out = splitWarp(w, [B[0] + 50, B[1] + 25], 'cross');
    expect(out).not.toBeNull();
    expect(out!.mesh!.us.map((v) => +v.toFixed(4))).toEqual([0, 0.3333, 0.5, 0.6667, 1]);
    expect(out!.mesh!.vs.map((v) => +v.toFixed(4))).toEqual([0, 0.3333, 0.5, 0.6667, 1]);
  });

  it('预设分割物化为 custom 且曲面不变(split_of_a_grid_cuts_one_section)', () => {
    const w = { ...resetWarp(B), style: 'arc' as const, bend: 50 };
    const before = warpMap(w, B[0] + 40, B[1] + 20);
    const out = splitWarp(w, null, 'horizontal');
    expect(out).not.toBeNull();
    expect(out!.style).toBe('custom');
    const after = warpMap(out!, B[0] + 40, B[1] + 20);
    expect(Math.hypot(before[0] - after[0], before[1] - after[1])).toBeLessThan(0.6);
    expect(out!.mesh!.vs.length).toBe(3); // [0, 1/2, 1]
  });

  it('resizeWarp 偶数重拟后曲面不变(warp_grid_fits_the_surface)', () => {
    const w = { ...resetWarp(B), style: 'bulge' as const, bend: 40 };
    const out = resizeWarp(w, 4);
    expect(out.style).toBe('custom');
    expect(out.mesh!.us).toEqual([0, 0.25, 0.5, 0.75, 1]);
    for (let j = 0; j <= 5; j++) {
      for (let i = 0; i <= 5; i++) {
        const a = warpMap(w, B[0] + (i / 5) * 100, B[1] + (j / 5) * 50);
        const b = meshEval(out.mesh!, i / 5, j / 5);
        expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThan(1e-3);
      }
    }
  });

  it('warpGridId 读出:default/3/custom(grid_menu_reads_default_and_even_presets)', () => {
    expect(warpGridId(meshIdentity(B, 1, 1))).toBe('default');
    expect(warpGridId(meshIdentity(B, 3, 3))).toBe('3');
    const m = meshIdentity(B, 3, 3);
    meshSplitU(m, 0.45);
    expect(warpGridId(m)).toBe('custom');
  });

  it('quickSplitKind:开阔=十字、近竖线=水平分割(ctrl_click_cuts_the_grid_both_ways)', () => {
    const m = meshIdentity(B, 3, 1); // us=[0,1/3,2/3,1]
    expect(quickSplitKind(m, B, 0.5, 0.5)).toBe('cross');
    expect(quickSplitKind(m, B, 1 / 3 + 0.005, 0.5)).toBe('horizontal');
    // 1×1 的三分导引也算已有线;恰在横竖导引交点=十字(引擎 (true,true)→Cross)
    expect(quickSplitKind(meshIdentity(B, 1, 1), B, 1 / 3, 0.5)).toBe('horizontal');
    expect(quickSplitKind(meshIdentity(B, 1, 1), B, 1 / 3, 1 / 3)).toBe('cross');
  });
});

describe('warpHit/surfaceAt/预览采样', () => {
  it('网格线上的点可命中,面片内点不可见(interior_patch_points_are_hidden)', () => {
    const m = meshIdentity(B, 1, 1); // 4×4
    const anchor = meshPoint(m, 0, 0);
    expect(warpHit(m, anchor, 8)).toBe(0);
    const inner = meshPoint(m, 1, 1); // (1,1) mod 3 ≠0 → 内点
    expect(warpHit(m, inner, 2)).toBeNull();
  });

  it('面片内 surfaceAt 命中,网格外 null(warp_press_outside_the_grid_grabs_nothing)', () => {
    const m = meshIdentity(B, 1, 1);
    expect(surfaceAt(m, [B[0] + 50, B[1] + 25])).not.toBeNull();
    expect(surfaceAt(m, [B[0] + 50, B[1] - 60])).toBeNull();
  });

  it('窄列强拉 cell 得到 ≥30 采样;网格线全是采样(a_narrow_pulled_cell…)', () => {
    const base = meshIdentity([0, 0, 900, 1100], 1, 1);
    const m: WarpMesh = { us: [...base.us], vs: [...base.vs], points: base.points.map((p) => [...p] as Pt) };
    meshSplitU(m, 0.45);
    meshSplitU(m, 0.5);
    meshPull(m, base.points, 0.47, 0.5, [-300, 0]);
    const [us] = previewSamples(m, 1);
    const inNarrow = us.filter((u) => u >= 0.45 && u < 0.5).length;
    expect(inNarrow).toBeGreaterThanOrEqual(30);
    for (const k of [0, 0.45, 0.5, 1]) expect(us.some((u) => Math.abs(u - k) < 1e-12)).toBe(true);
    expect(us.every((u, i) => i === 0 || u > us[i - 1])).toBe(true);
  });

  it('未弯网格便宜(an_unwarped_mesh_stays_cheap)', () => {
    const [us, vs] = previewSamples(meshIdentity([0, 0, 100, 100], 1, 1), 1);
    expect(us.length).toBeLessThanOrEqual(20);
    expect(vs.length).toBeLessThanOrEqual(20);
  });

  it('triangleOrder 位移降序(the_most_displaced_cells_are_drawn_first)', () => {
    const rest: Pt[] = [];
    for (let j = 0; j < 3; j++) for (let i = 0; i < 4; i++) rest.push([i * 10, j * 10]);
    const pos = rest.map((p, k) => (k % 4 === 1 || k % 4 === 2 ? [p[0] + 30, p[1]] as Pt : p));
    const idx = triangleOrder(pos, rest, 4);
    expect(idx.length).toBe(2 * 2 * 3 * 3);
    const moved = (k: number) => Math.abs(pos[k][0] - rest[k][0]);
    const perCell = Array.from({ length: idx.length / 6 }, (_, c) => idx.slice(c * 6, c * 6 + 6).reduce((a, k) => a + moved(k), 0));
    expect(perCell.every((v, i) => i === 0 || perCell[i - 1] >= v)).toBe(true);
  });
});

describe('WarpObject(引擎 Warp)', () => {
  it('identity 判定:未弯 mesh=identity;拖点后非 identity(is_identity_…)', () => {
    const w = resetWarp(B);
    expect(warpIsIdentity(w)).toBe(true);
    const m = w.mesh!;
    m.points[5] = [m.points[5][0] + 3, m.points[5][1]];
    expect(warpIsIdentity(w)).toBe(false);
  });

  it('预设 bend 0 是 identity;bend 50 不是', () => {
    expect(warpIsIdentity({ ...resetWarp(B), style: 'arc', bend: 0 })).toBe(true);
    expect(warpIsIdentity({ ...resetWarp(B), style: 'arc', bend: 50 })).toBe(false);
  });
});
