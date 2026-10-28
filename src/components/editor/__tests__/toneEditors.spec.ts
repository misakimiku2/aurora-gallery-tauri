/**
 * 色阶/曲线/渐变映射编辑器纯函数单测。
 * 用例照 photocraft 上游:point_curve.rs tests、adjust_editors.rs auto_levels、
 * tone.rs 直方图缩放、compose/adjust.rs curve_lut 行为。
 */
import {
  CURVE_MAX_POINTS, curveCanDelete, curveDelete, curveFromParams, curveHit, curveInsert,
  curveLut, curveMoveTo, identityCurveMap, isIdentityMap, mapFromParams, mapToFitPoints,
  mapToParams, pencilLine, pointsToMap, smoothCurveMap,
} from '../panels/curvePoints';
import { autoLevels, gammaFromPos, gammaPos, nearestHandle, readLevels, writeLevels } from '../panels/levelsMath';
import { moveMapStop, sampleStops, stopsFromParams, stopsToParams, widestGapMid } from '../panels/gradientStops';
import { featherFromPos, featherToPos } from '../panels/AdjustmentProps';

const line = (): [number, number][] => [[0, 0], [255, 255]];

describe('曲线点交互(上游 point_curve.rs 口径)', () => {
  it('insert 保序/去重/上限/钳制', () => {
    const p = line();
    expect(curveInsert(p, [128, 150])).toBe(1);
    expect(curveInsert(p, [64, 40])).toBe(1);
    expect(p).toEqual([[0, 0], [64, 40], [128, 150], [255, 255]]);
    // 已有 input 处点击 = 选中旧点,不堆叠
    expect(curveInsert(p, [129, 10])).toBe(2);
    expect(p).toHaveLength(4);
    const full: [number, number][] = Array.from({ length: CURVE_MAX_POINTS }, (_, i) => [i * 10, 0]);
    expect(curveInsert(full, [255, 0])).toBeNull();
    // 非法值钳到黑点
    expect(curveInsert(p, [-50, 900])).toBe(0);
  });

  it('端点与不足三点不可删', () => {
    const p: [number, number][] = [[0, 0], [100, 120], [255, 255]];
    expect(curveCanDelete(p, 0)).toBe(false);
    expect(curveCanDelete(p, 2)).toBe(false);
    expect(curveDelete(p, 7)).toBe(false);
    expect(curveDelete(p, 1)).toBe(true);
    expect(p).toEqual(line());
    expect(curveDelete(p, 1)).toBe(false);
    expect(curveDelete(p, 0)).toBe(false);
    expect(p).toHaveLength(2);
  });

  it('移动严格夹在左右邻点之间、output 钳 0..255、round 整电平', () => {
    const p: [number, number][] = [[0, 0], [100, 120], [200, 180], [255, 255]];
    expect(curveMoveTo(p, 1, [250, 300])).toBe(true);
    expect(p[1]).toEqual([199, 255]);
    curveMoveTo(p, 0, [150, 10]);
    expect(p[0]).toEqual([150, 10]);
    curveMoveTo(p, 3, [10, 5]);
    expect(p[3]).toEqual([201, 5]);
    expect(curveMoveTo(p, 9, [0, 0])).toBe(false);
  });

  it('hit 取半径内最近点(上游 hit_test 用例)', () => {
    const p: [number, number][] = [[0, 0], [100, 100], [110, 110], [255, 255]];
    const toX = (v: number) => v;
    const toY = (v: number) => 255 - v;
    expect(curveHit(p, toX, toY, 108, 146, 9)).toBe(2);
    expect(curveHit(p, toX, toY, 50, 50, 9)).toBeNull();
  });

  it('自然三次样条:过点/端点外恒值/恒等线', () => {
    const lut = curveLut([[0, 0], [255, 255]]);
    expect(lut).toHaveLength(256);
    expect(lut[0]).toBeCloseTo(0);
    expect(lut[64]).toBeCloseTo(0.25, 2);
    expect(lut[255]).toBeCloseTo(1);
    // 中点提亮的单调曲线过点:x=128 → y=150
    const lut2 = curveLut([[0, 0], [128, 150], [255, 255]]);
    expect(lut2[Math.round(128 / 255 * 255)] * 255).toBeCloseTo(150, 0);
    // 端点外恒值:首点 input=64(output 电平 51≈0.2×255)时 0..63 都是首点 output
    const lut3 = curveLut([[64, 51], [192, 204]]);
    expect(lut3[10]).toBeCloseTo(0.2, 5);
    expect(lut3[250]).toBeCloseTo(0.8, 5);
    // 过冲:陡 S 曲线在两邻点间可以超过两端 output(自然样条与 PS 一致),但钳 0..1
    const lut4 = curveLut([[0, 0.5], [128, 0], [255, 0.5]]);
    expect(lut4.every((v) => v >= 0 && v <= 1)).toBe(true);
    // 非法输入回退恒等
    expect(curveLut([])[100]).toBeCloseTo(100 / 255, 5);
    expect(curveFromParams(null)).toEqual(line());
    expect(curveFromParams([[10, 20]])).toEqual(line());
    expect(curveFromParams([[0, 0], [128, 150], [255, 255]])).toHaveLength(3);
  });
});

describe('曲线铅笔模式(上游 pencil_line + adjust_params.rs 口径)', () => {
  it('pencilLine:整段反转铺满每一级,快拖不留缝', () => {
    const map = identityCurveMap();
    expect(pencilLine(map, [0, 255], [255, 0])).toBe(true);
    expect(map[0]).toBe(255);
    expect(map[255]).toBe(0);
    for (const k of [1, 64, 128, 200, 254]) expect(map[k]).toBeCloseTo(255 - k, 3);
  });

  it('pencilLine:单点取该点值、x/y 钳 0..255、非法输入不动', () => {
    const map = identityCurveMap();
    // from==to(单点):i0==i1,t=1 → 该电平=to 的 y
    expect(pencilLine(map, [100, 30], [100, 30])).toBe(true);
    expect(map[100]).toBe(30);
    expect(map[99]).toBe(99);
    // output 钳 0..255
    expect(pencilLine(map, [50, 999], [60, 999])).toBe(true);
    expect(map[55]).toBe(255);
    // input 负值钳 0(改 0..5 段)
    expect(pencilLine(map, [-5, 200], [5, 200])).toBe(true);
    expect(map[0]).toBe(200);
    expect(pencilLine(map, [NaN, 0], [10, 0])).toBe(false);
    expect(pencilLine([], [0, 0], [1, 1])).toBe(false);
  });

  it('smooth:台阶两遍后中间过渡、端点不动、直线段不变(上游用例)', () => {
    const step = Array.from({ length: 256 }, (_, k) => (k < 128 ? 0 : 255));
    smoothCurveMap(step);
    smoothCurveMap(step);
    expect(step[127]).toBeGreaterThan(0.2 * 255);
    expect(step[128]).toBeLessThan(0.8 * 255);
    expect(step[0]).toBe(0);
    expect(step[255]).toBe(255);
    const flat = Array.from({ length: 256 }, () => 50);
    smoothCurveMap(flat);
    expect(flat.every((v) => v === 50)).toBe(true);
  });

  it('点↔map 往返:map 采样自样条;拟合 ≤16 点且曲线仍反转', () => {
    const map = pointsToMap([[0, 255], [255, 0]]);
    expect(map).toHaveLength(256);
    expect(map[64]).toBeCloseTo(191, 0);
    const fitted = mapToFitPoints(map);
    expect(fitted.length).toBeGreaterThanOrEqual(2);
    expect(fitted.length).toBeLessThanOrEqual(16);
    expect(fitted[0]).toEqual([0, 255]);
    expect(fitted[fitted.length - 1]).toEqual([255, 0]);
    const lut = curveLut(fitted, 256);
    expect(Math.abs(lut[64] * 255 - 191)).toBeLessThan(2);
    // 恒等图拟合回恒等两点线(上游:误差 ≤1 电平即止于两端点)
    expect(mapToFitPoints(identityCurveMap())).toEqual(line());
  });

  it('map 参数读写:非 256 数组回退恒等、写出 2 位小数、恒等判定半电平阈值', () => {
    expect(mapFromParams(null)).toHaveLength(256);
    expect(mapFromParams([1, 2, 3])[10]).toBe(10);
    // 点对数组不是 map → 恒等回退
    expect(mapFromParams([[0, 0], [255, 255]])[7]).toBe(7);
    const m = mapFromParams(Array.from({ length: 256 }, (_, k) => k + 0.25));
    expect(m[10]).toBeCloseTo(10.25, 5);
    expect(mapToParams([10.256, 3.14159])).toEqual([10.26, 3.14]);
    expect(isIdentityMap(identityCurveMap())).toBe(true);
    expect(isIdentityMap(mapFromParams(Array.from({ length: 256 }, (_, k) => k + 0.4)))).toBe(true);
    const bump = identityCurveMap();
    bump[128] = 180;
    expect(isIdentityMap(bump)).toBe(false);
  });
});

describe('色阶(上游 adjust_editors.rs 口径)', () => {
  it('Auto = 两端各裁 0.1%(计数 0 的 bin 不阻挡,上游同行为)', () => {
    // total=1000, clip=1:黑端 1 个像素被裁 → lo=1;白端 h[255]=1 被裁,其后全空 bin 推进到 h[3]=997 处停 → hi=3
    const h = new Array<number>(256).fill(0);
    h[0] = 1;
    h[1] = 998;
    h[3] = 997;
    h[255] = 1;
    expect(autoLevels(h)).toEqual([1, 3]);
    const empty = new Array<number>(256).fill(0);
    expect(autoLevels(empty)).toEqual([253, 255]); // 空直方图口径
  });
  it('gamma 手柄几何互逆', () => {
    expect(gammaPos(0, 255, 1)).toBeCloseTo(127.5);
    expect(gammaPos(0, 255, 2)).toBeCloseTo(63.75);
    expect(gammaFromPos(0, 255, 63.75)).toBeCloseTo(2, 1);
    // t 被钳 0.01 下限:ln(0.01)/ln(0.5) ≈ 6.64(上游 9.99 钳只是极端保险,正常到不了)
    expect(gammaFromPos(0, 255, 1)).toBeCloseTo(Math.log(0.01) / Math.log(0.5), 1);
  });
  it('手柄按最近抓取', () => {
    expect(nearestHandle([10, 50, 200], 48)).toBe(1);
    expect(nearestHandle([10, 50, 200], 130)).toBe(2);
  });
  it('read/write levels:复合平铺、单通道嵌套、round 与约束由调用方保证', () => {
    expect(readLevels({}, '')).toEqual([0, 1, 255, 0, 255]);
    const out = writeLevels({ red: { inBlack: 5 } }, '', [10.4, 1.234, 240.6, 0, 255]);
    expect(out.inBlack).toBe(10);
    expect(out.gamma).toBe(1.23);
    expect(out.inWhite).toBe(241);
    expect(out.red).toEqual({ inBlack: 5 });
    const out2 = writeLevels({}, 'green', [0, 1, 255, 0, 255]);
    expect(out2.green).toEqual({ inBlack: 0, gamma: 1, inWhite: 255, outBlack: 0, outWhite: 255 });
    expect(out2.inBlack).toBeUndefined();
  });
});

describe('渐变映射停靠点(上游 gradient_map 口径)', () => {
  it('参数往返:排序、round 0.001、非法回退黑白', () => {
    expect(stopsFromParams(undefined)).toEqual([{ at: 0, color: '#000000' }, { at: 1, color: '#ffffff' }]);
    const p = stopsToParams([{ at: 0.5, color: '#ff0000' }, { at: 0, color: '#000000' }]);
    expect(p).toEqual([[0, '#000000'], [0.5, '#ff0000']]);
  });
  it('插值色:段内线性、两端外恒值', () => {
    const stops = stopsFromParams([[0, '#000000'], [1, '#ffffff']]);
    expect(sampleStops(stops, 0.5)).toBe('#808080');
    expect(sampleStops(stops, -1)).toBe('#000000');
    expect(sampleStops(stops, 2)).toBe('#ffffff');
  });
  it('移动跨位重排且选中跟随(同位时原下标小的在前)', () => {
    const stops = stopsFromParams([[0, '#000000'], [0.5, '#ff0000'], [1, '#ffffff']]);
    expect(moveMapStop(stops, 2, 0.25)).toBe(1);
    expect(stops.map((s) => s.at)).toEqual([0, 0.25, 0.5]);
    // 末点移到 0:与首位同位,原下标小的(i=0)排前 → 新下标 1
    expect(moveMapStop(stops, 2, 0)).toBe(1);
    expect(stops.map((s) => s.at)).toEqual([0, 0, 0.25]);
    expect(moveMapStop(stops, 99, 0.5)).toBeNull();
  });
  it('Add Stop = 最宽间隙中点', () => {
    expect(widestGapMid(stopsFromParams([[0, '#000000'], [1, '#ffffff']]))).toBe(0.5);
    expect(widestGapMid(stopsFromParams([[0, '#000000'], [0.8, '#808080'], [1, '#ffffff']]))).toBeCloseTo(0.4);
  });
});

describe('蒙版羽化轨道(上游 #6545 x³ 曲线)', () => {
  it('位置→值:0/1 端点、低段精细(半程只到 ~12.6%)', () => {
    expect(featherFromPos(0)).toBe(0);
    expect(featherFromPos(1)).toBe(1000);
    expect(featherFromPos(0.5)).toBe(125); // 0.5³ = 0.125
    expect(featherFromPos(0.2)).toBe(8);
  });
  it('值→位置 与 位置→值 互逆', () => {
    for (const v of [0, 1, 8, 125, 500, 999, 1000]) {
      expect(featherFromPos(featherToPos(v))).toBe(v);
    }
    expect(featherToPos(125)).toBeCloseTo(0.5, 5);
  });
});
