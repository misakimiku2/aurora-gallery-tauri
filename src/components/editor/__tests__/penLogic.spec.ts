import { describe, expect, it } from 'vitest';
import {
  closing, curvePoints, foldClose, onClosingAnchor, overFirstAnchor, penBreakHandle, penDown, penGrabHandle,
  penMove, penToJson, penUndoLastPoint, penUp,
} from '../penLogic';

const TOL = 6; // 命中半径(文档 px;zoom=1)

describe('钢笔状态机(上游 vector_ui.rs PenPath 移植)', () => {
  it('首次按下=加锚(anchor=in=out);⇧ 从上一锚 45° 投影(取最近 45° 射线)', () => {
    let pen = penDown(null, 100, 100, false, TOL);
    expect(pen.knots).toEqual([{ anchor: [100, 100], in: [100, 100], out: [100, 100] }]);
    pen = penDown(pen, 200, 60, true, TOL); // -22° → 最近 0° 射线:投影回 y=100
    expect(pen.knots[1].anchor).toEqual([200, 100]);
    pen = penDown(pen, 260, 40, true, TOL); // 恰 -45°(从 (200,100) 出发 (60,-60))
    expect(pen.knots[2].anchor).toEqual([260, 40]);
  });

  it('拖拽拉出手柄:in=2a-out 对称;⇧ 实时转 45°', () => {
    let pen = penDown(null, 100, 100, false, TOL);
    penMove(pen, 150, 100, false);
    expect(pen.knots[0].out).toEqual([150, 100]);
    expect(pen.knots[0].in).toEqual([50, 100]);
    penMove(pen, 150, 130, true); // 32° → 45°
    expect(pen.knots[0].out[0]).toBeCloseTo(pen.knots[0].out[1], 6);
    expect(pen.knots[0].in[0]).toBeCloseTo(200 - pen.knots[0].out[0], 6);
  });

  it('点击末锚=断开 out 手柄(重拖只改 out,#1482)', () => {
    let pen = penDown(null, 100, 100, false, TOL);
    penMove(pen, 150, 100, false); // out=(150,100) in=(50,100)
    penUp(pen, 2);
    pen = penDown(pen, 100, 100, false, TOL); // 末锚上再按
    expect(pen.knots[0].out).toEqual([100, 100]); // out 归锚点
    expect(pen.knots[0].in).toEqual([50, 100]); // in 曲线保持
    expect(pen.unlinked).toContain(0);
    expect(pen.adjustingLast).toBe(true);
    penMove(pen, 130, 140, false);
    expect(pen.knots[0].out).toEqual([130, 140]);
    expect(pen.knots[0].in).toEqual([50, 100]); // 不再对称
  });

  it('Alt 拖拽中=断手柄对;Alt 按在手柄上=只抓那只(#3306/#6077)', () => {
    let pen = penDown(null, 100, 100, false, TOL);
    penMove(pen, 150, 100, false);
    penBreakHandle(pen);
    expect(pen.unlinked).toContain(0);
    expect(pen.adjustingLast).toBe(true);
    penMove(pen, 160, 120, false);
    expect(pen.knots[0].out).toEqual([160, 120]);
    expect(pen.knots[0].in).toEqual([50, 100]);
    // 抓柄只作用于末锚:in=(50,100) 离指针(52,101)更近 → 抓 in
    expect(penGrabHandle(pen, 52, 101, TOL)).toBe(true);
    expect(pen.adjustingIn).toBe(true);
    penMove(pen, 20, 130, false);
    expect(pen.knots[0].in).toEqual([20, 130]); // 只有 in 跟指针
    expect(pen.knots[0].out).toEqual([160, 120]);
  });

  it('首锚上按下=压入替身锚;拖拽弯出闭合段;松手抖动内收回替身手柄并提交闭合(#3306)', () => {
    let pen = penDown(null, 100, 100, false, TOL);
    penUp(pen, 2);
    pen = penDown(pen, 300, 100, false, TOL);
    penUp(pen, 2);
    expect(onClosingAnchor(pen, 100, 100, TOL)).toBe(true);
    pen = penDown(pen, 100, 100, false, TOL);
    expect(pen.knots.length).toBe(3); // 替身锚
    expect(closing(pen)).toBe(true);
    penMove(pen, 100, 60, false); // 替身 out 向上弯
    const up = penUp(pen, 2);
    expect(up.closed).toBe(true); // 替身手柄移出抖动 → 保持,折进首锚
    expect(pen.knots.length).toBe(3);
    const folded = foldClose(pen)!;
    expect(folded.knots.length).toBe(2);
    expect(folded.knots[0].out).toEqual([100, 60]);
    const json = penToJson(pen, true);
    expect(json.subpaths[0].closed).toBe(true);
    expect(json.subpaths[0].knots).toHaveLength(2);
  });

  it('替身松手未拉动(抖动内)=手柄收回成直线闭合', () => {
    let pen = penDown(null, 100, 100, false, TOL);
    penUp(pen, 2);
    pen = penDown(pen, 300, 100, false, TOL);
    penUp(pen, 2);
    pen = penDown(pen, 100, 100, false, TOL);
    penMove(pen, 100.5, 100.2, false);
    const up = penUp(pen, 2);
    expect(up.closed).toBe(true);
    const folded = foldClose(pen)!;
    expect(folded.knots[0].in).toEqual([100, 100]);
    expect(folded.knots[0].out).toEqual([100, 100]);
  });

  it('Enter/Esc 前的 Ctrl+Z/Backspace=逐点回退;空了=草稿取消', () => {
    let pen = penDown(null, 100, 100, false, TOL);
    penUp(pen, 2);
    pen = penDown(pen, 300, 300, false, TOL);
    penUp(pen, 2);
    pen = penUndoLastPoint(pen)!;
    expect(pen.knots).toHaveLength(1);
    expect(penUndoLastPoint(pen)).toBeNull();
  });

  it('penToJson:smooth=非尖角且手柄有伸出;折线闭合两锚 smooth', () => {
    let pen = penDown(null, 0, 0, false, TOL);
    penUp(pen, 2);
    pen = penDown(pen, 100, 0, false, TOL);
    penMove(pen, 150, 50, false);
    penUp(pen, 2);
    const json = penToJson(pen, false);
    expect(json.subpaths[0].closed).toBe(false);
    expect(json.subpaths[0].knots[1]).toMatchObject({ anchor: [100, 0], in: [50, -50], out: [150, 50], smooth: true });
    // 直线点击(无拖拽)的锚=手柄全在锚点上 → smooth=false
    let pen2 = penDown(null, 0, 0, false, TOL);
    penUp(pen2, 2);
    pen2 = penDown(pen2, 40, 0, false, TOL);
    penUp2(pen2);
    const j2 = penToJson(pen2, false);
    expect(j2.subpaths[0].knots[0].smooth).toBe(false);
  });

  it('曲线细分:直线段=2 点(1 弦);弯曲线随容差加密;上限 1024', () => {
    const id = (q: [number, number]): [number, number] => q;
    expect(curvePoints([0, 0], [10, 0], [20, 0], [30, 0], id)).toEqual([[0, 0], [30, 0]]);
    const arc = curvePoints([0, 0], [0, 300], [300, 300], [300, 0], id);
    expect(arc.length).toBeGreaterThan(8);
    const huge = curvePoints([0, 0], [0, 1e6], [1e6, 1e6], [1e6, 0], id);
    expect(huge.length).toBeLessThanOrEqual(1025);
    expect(huge[0]).toEqual([0, 0]);
    expect(huge[huge.length - 1]).toEqual([1e6, 0]);
  });

  it('overFirstAnchor:两锚以上、非拖拽中', () => {
    let pen = penDown(null, 100, 100, false, TOL);
    expect(overFirstAnchor(pen, [102, 102], TOL)).toBe(false); // 单锚不闭合
    penUp(pen, 2);
    pen = penDown(pen, 300, 300, false, TOL);
    penUp(pen, 2); // 抬笔清 dragging(悬停判定要求非拖拽)
    expect(overFirstAnchor(pen, [102, 102], TOL)).toBe(true);
    expect(overFirstAnchor(pen, [130, 130], TOL)).toBe(false);
  });
});

function penUp2(pen: ReturnType<typeof penDown>): void {
  penUp(pen, 2);
}
