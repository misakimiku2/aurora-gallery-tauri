import { describe, expect, it } from 'vitest';
import {
  addAnchor, anchorsIn, bendSegment, convertPoint, deleteAnchor, evalSeg, hitPath, moveAnchors, moveHandle,
  segmentEnd, subpathAnchors, subpathSegments, translatePath,
  pickShapeAt, pointInSubpath, type EditPath,
} from '../pathEdit';

/** 三个角点的三角(上游 tri)。 */
const tri = (): EditPath => ({
  subpaths: [{ closed: true, knots: [
    { anchor: [0, 10], in: [0, 10], out: [0, 10], smooth: false },
    { anchor: [100, 0], in: [100, 0], out: [100, 0], smooth: false },
    { anchor: [50, 90], in: [50, 90], out: [50, 90], smooth: false },
  ] }],
});

/** 角点(0,50)-(50,80) 之间一个平滑锚 (50,0),手柄两侧 20px(上游 curve)。 */
const curve = (): EditPath => ({
  subpaths: [{ closed: true, knots: [
    { anchor: [0, 50], in: [0, 50], out: [0, 50], smooth: false },
    { anchor: [50, 0], in: [30, 0], out: [70, 0], smooth: true },
    { anchor: [50, 80], in: [50, 80], out: [50, 80], smooth: false },
  ] }],
});

describe('pathEdit(二期 二-3,上游 crates/vector/src/edit.rs 移植)', () => {
  it('moveAnchors:锚连带手柄移动;同锚列多次只动一次;非法下标拒绝且不动任何锚', () => {
    const p = moveAnchors(curve(), [[0, 1], [0, 1]], [5, -2])!;
    expect(p.subpaths[0].knots[1].anchor).toEqual([55, -2]);
    expect(p.subpaths[0].knots[1].in).toEqual([35, -2]);
    expect(p.subpaths[0].knots[0].anchor).toEqual([0, 50]);
    expect(moveAnchors(tri(), [[0, 0], [0, 9]], [1, 1])).toBeNull();
    expect(moveAnchors(tri(), [[0, 0]], [1, 1])!.subpaths[0].knots[1].anchor).toEqual([100, 0]);
  });

  it('moveHandle:平滑锚对侧共线保长;independent=断成尖角', () => {
    const p = moveHandle(curve(), [0, 1], 'out', [50, 30], false)!;
    expect(p.subpaths[0].knots[1].out).toEqual([50, 30]);
    expect(p.subpaths[0].knots[1].in).toEqual([50, -20]); // 反向延伸保长 20
    expect(p.subpaths[0].knots[1].smooth).toBe(true);
    const q = moveHandle(curve(), [0, 1], 'in', [40, 20], true)!;
    expect(q.subpaths[0].knots[1].in).toEqual([40, 20]);
    expect(q.subpaths[0].knots[1].out).toEqual([70, 0]);
    expect(q.subpaths[0].knots[1].smooth).toBe(false);
    expect(moveHandle(tri(), [3, 0], 'in', [0, 0], false)).toBeNull();
  });

  it('convertPoint:null=收回成角点;out=平滑镜像手柄', () => {
    const p = convertPoint(curve(), [0, 1], null)!;
    expect(p.subpaths[0].knots[1]).toMatchObject({ anchor: [50, 0], in: [50, 0], out: [50, 0], smooth: false });
    const q = convertPoint(curve(), [0, 0], [10, 60])!;
    expect(q.subpaths[0].knots[0]).toMatchObject({ anchor: [0, 50], in: [-10, 40], out: [10, 60], smooth: true });
  });

  it('bendSegment:直线段=两锚随动(闭合回绕段也是)', () => {
    const p = bendSegment(tri(), [0, 2], 0.5, [0, 10])!;
    expect(p.subpaths[0].knots[2].anchor).toEqual([50, 100]);
    expect(p.subpaths[0].knots[0].anchor).toEqual([0, 20]);
    expect(p.subpaths[0].knots[1].anchor).toEqual([100, 0]);
  });

  it('bendSegment:曲线 t 处点精确随指针;端部锚位不动', () => {
    const before = curve();
    const p = bendSegment(curve(), [0, 0], 0.5, [0, 10])!;
    const segs = subpathSegments(p.subpaths[0]);
    const mid = evalSeg(segs[0], 0.5);
    const midBefore = evalSeg(subpathSegments(before.subpaths[0])[0], 0.5);
    expect(mid[1] - midBefore[1]).toBeCloseTo(10, 6); // t=0.5 处正好位移 10
    expect(mid[0]).toBeCloseTo(midBefore[0], 6);
    expect(p.subpaths[0].knots[0].anchor).toEqual([0, 50]); // 端锚不动
    expect(p.subpaths[0].knots[1].anchor).toEqual([50, 0]);
  });

  it('addAnchor:曲线 de Casteljau 分割形状不变+新锚平滑;直线段=线上角点', () => {
    const before = curve();
    const p = curve();
    expect(addAnchor(p, [0, 0], 0.5)).toEqual([0, 1]); // 返回新锚引用
    expect(p.subpaths[0].knots).toHaveLength(4);
    const nk = p.subpaths[0].knots[1];
    expect(nk.smooth).toBe(true);
    for (const t of [0.2, 0.5, 0.8]) {
      // 分割后参数重映射:原 t 落在前半段(×2)或后半段((t−0.5)×2),形状不变=点重合
      const a = evalSeg(subpathSegments(before.subpaths[0])[0], t);
      const b = t <= 0.5
        ? evalSeg(subpathSegments(p.subpaths[0])[0], t * 2)
        : evalSeg(subpathSegments(p.subpaths[0])[1], (t - 0.5) * 2);
      expect(b[0]).toBeCloseTo(a[0], 6);
      expect(b[1]).toBeCloseTo(a[1], 6);
    }
    const straightPath: EditPath = { subpaths: [{ closed: false, knots: [
      { anchor: [0, 0], in: [0, 0], out: [0, 0], smooth: false },
      { anchor: [100, 0], in: [100, 0], out: [100, 0], smooth: false },
    ] }] };
    expect(addAnchor(straightPath, [0, 0], 0.25)).toEqual([0, 1]);
    // 直线段的三次参数非线性(收缩手柄):插入点=eval(seg,t)=15.625 而非线性 25
    // (上游注释:命中/悬停都用三次参数,角点保持在同一点)
    expect(straightPath.subpaths[0].knots[1].anchor[0]).toBeCloseTo(15.625, 6);
    expect(straightPath.subpaths[0].knots[1].anchor[1]).toBe(0);
    expect(straightPath.subpaths[0].knots[1].smooth).toBe(false);
  });

  it('deleteAnchor:邻锚以原手柄接续;删空子路径;只剩一锚拒绝', () => {
    const p = curve();
    expect(deleteAnchor(p, [0, 1])).toBe(false);
    expect(p.subpaths[0].knots).toHaveLength(2);
    expect(p.subpaths[0].knots[1].anchor).toEqual([50, 80]); // 原 knot2 前移
    expect(p.subpaths[0].knots[0].out).toEqual([0, 50]);
    const two: EditPath = { subpaths: [
      { closed: false, knots: tri().subpaths[0].knots },
      { closed: false, knots: [{ anchor: [5, 5], in: [5, 5], out: [5, 5], smooth: false }] },
    ] };
    expect(deleteAnchor(two, [1, 0])).toBe(true); // 单锚子路径整条删
    expect(two.subpaths).toHaveLength(1);
    const one: EditPath = { subpaths: [{ closed: false, knots: [{ anchor: [1, 1], in: [1, 1], out: [1, 1], smooth: false }] }] };
    expect(deleteAnchor(one, [0, 0])).toBeNull();
  });

  it('anchorsIn/subpathAnchors/segmentEnd:归一化框与回绕', () => {
    expect(anchorsIn(tri(), [60, 80, 40, 100])).toEqual([[0, 2]]); // 框归一化(含 (50,90))
    expect(subpathAnchors(tri(), 0)).toEqual([[0, 0], [0, 1], [0, 2]]);
    expect(segmentEnd(tri(), [0, 2])).toEqual([0, 0]); // 闭合回绕
    expect(segmentEnd({ subpaths: [{ closed: false, knots: tri().subpaths[0].knots }] }, [0, 2])).toBeNull();
  });

  it('hitPath:手柄>锚点>段;段 64 采样+细化;同类取最近', () => {
    const p = curve();
    const handles = [{ knot: [0, 1] as [number, number], handle: 'out' as const }];
    // 手柄(70,0)最上:即使锚点也近
    const h = hitPath(p, [70, 1], 8, handles)!;
    expect(h.kind).toBe('handle');
    // 锚点比段优先:靠近 (50,0) 但不在手柄上
    const a = hitPath(p, [52, 2], 8, [])!;
    expect(a.kind).toBe('anchor');
    // 段:seg0 的 t=0.5 处 (17.5,25) 是曲线上的点
    const s = hitPath(p, [17.5, 25], 8, [])!;
    expect(s.kind).toBe('segment');
    expect(s.knot).toEqual([0, 0]);
    if (s.kind === 'segment') expect(s.t).toBeCloseTo(0.5, 1);
    // 全部脱靶
    expect(hitPath(p, [500, 500], 8, [])).toBeNull();
  });
});

describe('translatePath(二-5,上游 Path::transform translate 分支)', () => {
  it('锚与双手柄同移;原路径不动(纯函数)', () => {
    const src = tri();
    const out = translatePath(src, [5, -3])!;
    expect(out.subpaths[0].knots[0].anchor).toEqual([5, 7]);
    expect(out.subpaths[0].knots[1].anchor).toEqual([105, -3]);
    expect(out.subpaths[0].knots[1].in).toEqual([105, -3]);
    // 原路径不被修改
    expect(src.subpaths[0].knots[1].anchor).toEqual([100, 0]);
    // 负位移与平滑标记保持
    expect(out.subpaths[0].knots[2].anchor).toEqual([55, 87]);
    expect(out.subpaths[0].knots[1].smooth).toBe(src.subpaths[0].knots[1].smooth);
  });
});

describe('pickShapeAt / pointInSubpath(二-5,上游 pick_shape_at 移植)', () => {
  it('pointInSubpath:闭合三角形内部真/外部假;开放或 <3 锚恒假', () => {
    const triSp = tri().subpaths[0];
    expect(pointInSubpath(triSp, [50, 40])).toBe(true);
    expect(pointInSubpath(triSp, [200, 40])).toBe(false);
    expect(pointInSubpath({ closed: false, knots: triSp.knots }, [50, 40])).toBe(false);
  });

  it('pickShapeAt:自上而下首个命中胜;描边几何容差内命中(无填充不测内部);填充矩形/子路径内部命中', () => {
    const a = { id: 1, path: tri(), fill: true, live: null };
    // 描边线(无填充):线外 4px 容差内命中,10px 外不中
    const line = { id: 2, path: { subpaths: [{ closed: false, knots: [
      { anchor: [0, 100] as [number, number], in: [0, 100] as [number, number], out: [100, 100] as [number, number], smooth: false },
      { anchor: [100, 100] as [number, number], in: [100, 100] as [number, number], out: [200, 100] as [number, number], smooth: false },
    ] }] }, fill: false, live: null };
    expect(pickShapeAt([line], [50, 103], 4)).toBe(2);
    expect(pickShapeAt([line], [50, 113], 4)).toBeNull();
    // a 在前:a 的填充内部命中(即使线也在下面)
    expect(pickShapeAt([a, line], [50, 40], 4)).toBe(1);
    // a 内部不中、线中 → 2
    expect(pickShapeAt([a, line], [50, 103], 4)).toBe(2);
  });
});
