/**
 * 自由变换纯几何测试(上游 transform_tool.rs tests 的 TS 移植;测试名照上游钉语义)。
 * session = 100×50 框,pivot 中心(上游 tests::session)。
 */
import { describe, expect, it } from 'vitest';
import {
  acceptsOutsideClick, applyDrag, applyModeDrag, carryPivot, corners, handleTolerance, hitTest, Homography,
  keepConvex, matchingAnchor, modeAllows, nudgeTransform, pointOnQuad, quadIsAffine, quadScale, quadUnchanged,
  readout, rotateAboutPivot, scaleAboutPivot, skewAboutPivot, movePivotTo, setPivotAnchor, turns, insideQuad,
  type Gesture, type Quad, type RectF, type TransformMods, type TransformSession,
} from '../transformLogic';

const NONE: TransformMods = { shift: false, alt: false, command: false };
const SHIFT: TransformMods = { shift: true, alt: false, command: false };
const ALT: TransformMods = { shift: false, alt: true, command: false };
const ALT_SHIFT: TransformMods = { shift: true, alt: true, command: false };
const COMMAND: TransformMods = { shift: false, alt: false, command: true };
const COMMAND_ALT_SHIFT: TransformMods = { shift: true, alt: true, command: true };

function session(): TransformSession {
  const rect: RectF = [0, 0, 100, 50];
  return { layer: 1, rect, quad: corners(rect), pivot: [50, 25], interpolation: 'bicubic', mode: 'free', targetMask: false, skewV: 0 };
}

/** 上游 tests::drag(tol=8.0):对 start 命中,快照手势,applyDrag 到 end。 */
function drag(s: TransformSession, from: [number, number], to: [number, number], mods: TransformMods, tol = 8): void {
  const g: Gesture = { hit: hitTest(s, from, tol), start: from, quad0: s.quad, pivot0: s.pivot };
  const next = applyDrag(s, g, to, mods);
  s.quad = next.quad;
  s.pivot = next.pivot;
}

const close = (q: Quad, want: Quad): boolean =>
  q.every((p, i) => Math.abs(p[0] - want[i][0]) < 1e-6 && Math.abs(p[1] - want[i][1]) < 1e-6);
const near = (a: [number, number], b: [number, number]): boolean => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
const eq6 = (a: number, b: number): boolean => Math.abs(a - b) < 5e-7;

describe('命中(上游 hit/inside)', () => {
  it('最近把手赢(小框重叠)', () => {
    const s = session();
    s.rect = [0, 0, 6, 6];
    s.quad = corners(s.rect);
    s.pivot = [3, 3];
    // (3,3) 恰在 pivot 上:离角 0 距离 √18、边中点 3 —— pivot 赢
    expect(hitTest(s, [3, 3], 12).kind).toBe('pivot');
  });
  it('容差外落入框内/框外', () => {
    const s = session();
    expect(hitTest(s, [50, 25], 1)).toEqual({ kind: 'pivot' });
    expect(hitTest(s, [51, 26], 1e-9)).toEqual({ kind: 'inside' });
    expect(hitTest(s, [150, 25], 4)).toEqual({ kind: 'outside' });
    // 命中边中点(容差内)
    expect(hitTest(s, [50, 0], 4)).toEqual({ kind: 'edge', i: 0 });
    expect(hitTest(s, [0, 0], 4)).toEqual({ kind: 'corner', i: 0 });
  });
  it('斜置框的点积射线 inside', () => {
    const q: Quad = [[10, 10], [50, 0], [60, 40], [20, 50]];
    expect(insideQuad(q, [30, 25])).toBe(true);
    expect(insideQuad(q, [55, 45])).toBe(false);
  });
  it('框外单击=提交(位移 ≤2 屏幕 point;拖拽旋转不误触)', () => {
    const g: Gesture = { hit: { kind: 'outside' }, start: [0, 0], quad0: corners([0, 0, 10, 10]), pivot0: [5, 5] };
    expect(acceptsOutsideClick(g, [1, 0], 12)).toBe(true);
    expect(acceptsOutsideClick(g, [30, 0], 12)).toBe(false);
    const rot: Gesture = { ...g, hit: { kind: 'corner', i: 0 } };
    expect(acceptsOutsideClick(rot, [1, 0], 12)).toBe(false);
  });
});

describe('角拖缩放(上游 corner_drag_scales_proportionally_about_opposite_corner)', () => {
  it('无修饰=等比(锚=对角);⇧=单轴', () => {
    const s = session();
    drag(s, [100, 50], [200, 60], NONE);
    expect(close(s.quad, corners([0, 0, 200, 100]))).toBe(true);
    const s2 = session();
    drag(s2, [100, 50], [200, 60], SHIFT);
    expect(close(s2.quad, corners([0, 0, 200, 60]))).toBe(true);
  });
});

describe('边拖缩放(上游 edge_drag_scales_proportionally_about_the_opposite_edge)', () => {
  it('右边缘等比绕对边中点;顶边 2x 高=2x 宽;越过对边=该轴翻转另一轴缩;⇧ 单轴', () => {
    const s = session();
    drag(s, [100, 25], [150, 25], NONE);
    expect(close(s.quad, corners([0, -12.5, 150, 62.5]))).toBe(true);
    expect(near(s.pivot, [75, 25])).toBe(true);
    const s2 = session();
    drag(s2, [50, 0], [50, -50], NONE);
    expect(close(s2.quad, corners([-50, -50, 150, 50]))).toBe(true);
    const s3 = session();
    drag(s3, [100, 25], [-50, 25], NONE);
    expect(close(s3.quad, corners([0, 12.5, -50, 37.5]))).toBe(true);
    const s4 = session();
    drag(s4, [50, 50], [50, 80], SHIFT);
    expect(close(s4.quad, corners([0, 0, 100, 80]))).toBe(true);
  });
});

describe('⌥ 绕参考点缩放(上游 alt_scales_edges_about_reference_point / alt_scales_about_a_moved_reference_point)', () => {
  it('⌥ 边拖绕参考点等比;⌥⇧ 单轴', () => {
    const s = session();
    drag(s, [100, 25], [150, 25], ALT);
    expect(close(s.quad, corners([-50, -25, 150, 75]))).toBe(true);
    const s2 = session();
    drag(s2, [100, 25], [150, 25], ALT_SHIFT);
    expect(close(s2.quad, corners([-50, 0, 150, 50]))).toBe(true);
  });
  it('移过的参考点是 ⌥ 缩放中心(pivot 不动)', () => {
    const s = session();
    s.pivot = [0, 0];
    drag(s, [100, 50], [200, 100], ALT);
    expect(close(s.quad, corners([0, 0, 200, 100]))).toBe(true);
    expect(near(s.pivot, [0, 0])).toBe(true);
    const s2 = session();
    s2.pivot = [25, 25];
    drag(s2, [100, 25], [175, 25], ALT);
    expect(close(s2.quad, corners([-25, -25, 175, 75]))).toBe(true);
    const s3 = session();
    s3.pivot = [25, 25];
    drag(s3, [100, 25], [175, 25], ALT_SHIFT);
    expect(close(s3.quad, corners([-25, 0, 175, 50]))).toBe(true);
    // 参考点与拖角同水平线:该轴没得缩保持,另一轴绕它 2x
    const s4 = session();
    s4.pivot = [100, 50];
    drag(s4, [100, 0], [150, -50], ALT_SHIFT);
    expect(close(s4.quad, corners([0, -50, 100, 50]))).toBe(true);
  });
});

describe('移动/旋转/斜切(上游 move_rotate_and_distort)', () => {
  it('内拖平移 quad+pivot 同步', () => {
    const s = session();
    drag(s, [40, 20], [50, 30], NONE);
    expect(close(s.quad, corners([10, 10, 110, 60]))).toBe(true);
    expect(s.pivot).toEqual([60, 35]);
  });
  it('框外拖绕 pivot 旋转;⇧ 吸附 15°(50° 落 45°)', () => {
    const s = session();
    drag(s, [150, 25], [50, 125], NONE);
    expect(Math.abs(readout(s).angleDeg - 90) < 1e-6).toBe(true);
    const s2 = session();
    const a = (50 * Math.PI) / 180;
    drag(s2, [150, 25], [50 + 100 * Math.cos(a), 25 + 100 * Math.sin(a)], SHIFT);
    expect(Math.abs(readout(s2).angleDeg - 45) < 1e-6).toBe(true);
  });
  it('⇧ 内拖锁 8 向并可切换(上游 shift_body_drag_locks_to_eight_directions_and_switches)', () => {
    const s = session();
    const g: Gesture = { hit: { kind: 'inside' }, start: [40, 20], quad0: s.quad, pivot0: s.pivot };
    let next = applyDrag(s, g, [60, 23], SHIFT);
    s.quad = next.quad;
    expect(close(s.quad, corners([20, 0, 120, 50]))).toBe(true);
    next = applyDrag(s, g, [60, 39], SHIFT);
    s.quad = next.quad;
    expect(Math.abs(s.quad[0][0] - s.quad[0][1]) < 1e-9 && s.quad[0][0] > 15).toBe(true);
    next = applyDrag(s, g, [41, 60], SHIFT);
    s.quad = next.quad;
    expect(close(s.quad, corners([0, 40, 100, 90]))).toBe(true);
  });
});

describe('⌘ 斜切/扭曲/透视(上游 alt_click_moves_the_reference_point_and_edges_skew 等)', () => {
  it('⌘ 边拖=两端同移;⌘⇧ 只沿边', () => {
    const s = session();
    drag(s, [50, 0], [70, 5], COMMAND);
    expect(s.quad[0]).toEqual([20, 5]);
    expect(s.quad[1]).toEqual([120, 5]);
    expect(s.quad[2]).toEqual([100, 50]);
    const s2 = session();
    drag(s2, [50, 0], [70, 5], { shift: true, alt: false, command: true });
    expect(s2.quad[0]).toEqual([20, 0]);
    expect(s2.quad[1]).toEqual([120, 0]);
  });
  it('⌘⌥⇧ 角拖=透视(共边角反向)', () => {
    const s = session();
    drag(s, [100, 0], [120, 0], COMMAND_ALT_SHIFT);
    // TR 沿 x +20,TL 反向 -20(主导轴水平)
    expect(s.quad[1][0]).toEqual(120);
    expect(s.quad[0][0]).toEqual(-20);
  });
  it('⌘ 角拖=扭曲,翻折前二分停住(上游 a_distort_corner_stops_before_the_box_folds_over)', () => {
    const s = session();
    s.rect = [0, 0, 32, 32];
    s.quad = corners(s.rect);
    s.pivot = [16, 16];
    drag(s, [0, 0], [60, 60], COMMAND);
    // TL 拖向 BR 越过对角线:停在 x+y=32 之前,其他角不动,保持凸
    const sign = Math.sign(turns(corners([0, 0, 32, 32]))[0]);
    expect(turns(s.quad).every((t) => t * sign > 0)).toBe(true);
    expect(s.quad[1]).toEqual([32, 0]);
    expect(s.quad[2]).toEqual([32, 32]);
    expect(s.quad[3]).toEqual([0, 32]);
    expect(s.quad[0][0] > 15 && s.quad[0][0] < 16 && Math.abs(s.quad[0][0] - s.quad[0][1]) < 1e-6).toBe(true);
    // 不翻折的拖拽不受限
    const q0 = [...s.quad] as Quad;
    drag(s, q0[0], [2, 4], COMMAND);
    expect(s.quad[0]).toEqual([2, 4]);
  });
  it('keep_convex 对退化起点不约束(上游 keep_convex_leaves_a_degenerate_start_alone)', () => {
    const flat: Quad = [[0, 0], [1, 0], [2, 0], [3, 0]];
    const to: Quad = [[5, 5], [1, 0], [2, 0], [3, 0]];
    expect(keepConvex(flat, to)).toEqual(to);
  });
});

describe('参考点随框走(上游 the_reference_point_moves_with_the_box)', () => {
  it('角缩后中心仍在中心;角上的参考点钉在角上', () => {
    const s = session();
    drag(s, [100, 50], [50, 25], NONE);
    expect(close(s.quad, corners([0, 0, 50, 25]))).toBe(true);
    expect(near(s.pivot, [25, 12.5])).toBe(true);
    const s2 = session();
    s2.pivot = [100, 0];
    drag(s2, [50, 50], [50, 80], SHIFT);
    expect(near(s2.pivot, [100, 0])).toBe(true);
    drag(s2, [100, 40], [150, 40], SHIFT);
    expect(near(s2.pivot, s2.quad[1])).toBe(true);
    drag(s2, [150, 40], [180, 40], NONE);
    expect(near(s2.pivot, s2.quad[1])).toBe(true);
  });
  it('斜切/扭曲/透视/⌥ 缩放/旋转下的参考点行为', () => {
    const s1 = session();
    drag(s1, [50, 0], [70, 0], COMMAND);
    expect(near(s1.pivot, [60, 25])).toBe(true);
    const s2 = session();
    s2.pivot = [0, 50];
    drag(s2, [0, 50], [-20, 70], COMMAND);
    expect(near(s2.pivot, [-20, 70])).toBe(true);
    const s3 = session();
    drag(s3, [100, 0], [120, 0], COMMAND_ALT_SHIFT);
    const h = Homography.rectToQuad([0, 0, 1, 1], s3.quad)!;
    const [cx, cy] = h.apply(0.5, 0.5);
    expect(near(s3.pivot, [cx, cy])).toBe(true);
    const s4 = session();
    drag(s4, [100, 50], [150, 75], ALT);
    expect(near(s4.pivot, [50, 25])).toBe(true);
    const s5 = session();
    drag(s5, [150, 25], [50, 125], NONE);
    expect(near(s5.pivot, [50, 25])).toBe(true);
    // 塌缩框无相对位置:原地不动
    expect(carryPivot([[0, 0], [0, 0], [0, 0], [0, 0]], corners([0, 0, 10, 10]), [5, 5])).toEqual([5, 5]);
  });
});

describe('模式手势(上游 apply_mode_drag/mode_allows)', () => {
  it('Distort 模式只认角与内拖;Skew 模式不认框外', () => {
    expect(modeAllows('distort', { kind: 'edge', i: 0 })).toBe(false);
    expect(modeAllows('distort', { kind: 'outside' })).toBe(false);
    expect(modeAllows('distort', { kind: 'corner', i: 0 })).toBe(true);
    expect(modeAllows('skew', { kind: 'outside' })).toBe(false);
    expect(modeAllows('skew', { kind: 'corner', i: 0 })).toBe(true);
    expect(modeAllows('free', { kind: 'outside' })).toBe(true);
  });
  it('Rotate 模式角/边拖=改写为框外旋转(上游 drag_in rotate 口径)', () => {
    const s = { ...session(), mode: 'rotate' as const };
    const g: Gesture = { hit: { kind: 'corner', i: 2 }, start: [150, 25], quad0: s.quad, pivot0: s.pivot };
    const next = applyModeDrag(s, g, [50, 125], false, NONE);
    const s2 = { ...s, quad: next.quad, pivot: next.pivot };
    expect(Math.abs(readout(s2).angleDeg - 90) < 1e-6).toBe(true);
  });
});

describe('9 宫格与 pivot(上游 anchor_grid_point_on_quad_and_carry_pivot)', () => {
  it('锚点落在 quad 上;matchingAnchor 回显', () => {
    const s = session();
    expect(pointOnQuad(s.quad, 0)).toEqual([0, 0]);
    expect(pointOnQuad(s.quad, 4)).toEqual([50, 25]);
    expect(pointOnQuad(s.quad, 8)).toEqual([100, 50]);
    expect(pointOnQuad(s.quad, 1)).toEqual([50, 0]);
    expect(matchingAnchor(s.quad, [50, 25])).toBe(4);
    expect(matchingAnchor(s.quad, [13, 37])).toBeNull();
  });
  it('设锚点=参考点到位', () => {
    const s = setPivotAnchor(session(), 6);
    expect(s.pivot).toEqual([0, 50]);
  });
  it('X/Y 字段=平移 quad+pivot 使参考点到位', () => {
    const s = movePivotTo(session(), 30, 40);
    expect(s.pivot).toEqual([30, 40]);
    expect(close(s.quad, corners([-20, 15, 80, 65]))).toBe(true);
  });
});

describe('数值变换(上游 scale_about_pivot/rotate_about_pivot/skew_about_pivot)', () => {
  it('绕参考点缩放', () => {
    const s = scaleAboutPivot(session(), 2, 2);
    expect(close(s.quad, corners([-50, -25, 150, 75]))).toBe(true);
  });
  it('绕参考点旋转 90°', () => {
    const s = rotateAboutPivot(session(), Math.PI / 2);
    // 绕 (50,25) 屏幕顺时针 90°:TL 相对 (-50,-25) → (25,-50) → 绝对 (75,-25)
    expect(near(s.quad[0], [75, -25])).toBe(true);
    expect(Math.abs(readout(s).angleDeg - 90) < 1e-6).toBe(true);
  });
  it('斜切保持 W/H/角度,只动 skew(上游 a_sheared_box_reads_as_horizontal_skew)', () => {
    const d = 50 * Math.tan((20 * Math.PI) / 180);
    const t = session();
    t.quad = [[0, 0], [100, 0], [100 - d, 50], [-d, 50]];
    const r = readout(t);
    expect(eq6(r.wPct, 100) && eq6(r.hPct, 100) && eq6(r.angleDeg, 0)).toBe(true);
    expect(eq6(r.skewHDeg, 20)).toBe(true);
  });
  it('翻转读作负 W/H(上游 a_flipped_box_reads_as_a_negative_scale_on_that_axis)', () => {
    const t1 = session();
    t1.quad = [[100, 0], [0, 0], [0, 50], [100, 50]];
    let r = readout(t1);
    expect(eq6(r.wPct, -100) && eq6(r.hPct, 100) && eq6(r.angleDeg, 0)).toBe(true);
    const t2 = session();
    t2.quad = [[0, 50], [100, 50], [100, 0], [0, 0]];
    r = readout(t2);
    expect(eq6(r.wPct, 100) && eq6(r.hPct, -100) && eq6(r.angleDeg, 0)).toBe(true);
    // 双向翻转=半转
    const t3 = session();
    t3.quad = [[100, 50], [0, 50], [0, 0], [100, 0]];
    r = readout(t3);
    expect(eq6(r.wPct, 100) && eq6(r.hPct, 100) && Math.abs(Math.abs(r.angleDeg) - 180) < 1e-6).toBe(true);
  });
});

describe('quad 性质', () => {
  it('quadIsAffine:平行四边形 true,扭曲 false', () => {
    expect(quadIsAffine([0, 0, 100, 50], corners([0, 0, 100, 50]))).toBe(true);
    expect(quadIsAffine([0, 0, 100, 50], [[0, 0], [100, 0], [120, 50], [0, 50]])).toBe(false);
  });
  it('quadUnchanged 位相等;quadScale 最长边比', () => {
    expect(quadUnchanged([0, 0, 100, 50], corners([0, 0, 100, 50]))).toBe(true);
    expect(quadUnchanged([0, 0, 100, 50], corners([1, 0, 101, 50]))).toBe(false);
    const t = { rect: [0, 0, 100, 50] as RectF, quad: corners([0, 0, 200, 100]) as Quad };
    expect(Math.abs(quadScale(t) - 2) < 1e-9).toBe(true);
  });
  it('Homography 往返:rectToQuad 后逆映射回源点', () => {
    const h = Homography.rectToQuad([0, 0, 100, 50], corners([10, 10, 110, 70]))!;
    const inv = h.inverse()!;
    const [x, y] = inv.apply(...h.apply(37, 19));
    expect(Math.abs(x - 37) < 1e-9 && Math.abs(y - 19) < 1e-9).toBe(true);
  });
});

describe('微移与容差', () => {
  it('nudge 平移框+pivot;handleTolerance = 12/zoom', () => {
    const s = nudgeTransform(session(), 5, -3);
    expect(close(s.quad, corners([5, -3, 105, 47]))).toBe(true);
    expect(s.pivot).toEqual([55, 22]);
    expect(handleTolerance(2)).toEqual(6);
  });
});
