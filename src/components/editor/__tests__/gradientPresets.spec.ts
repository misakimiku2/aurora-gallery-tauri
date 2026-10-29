/**
 * 渐变预设库测试:数据完整性(与引擎 builtin() 同构)、活引用解析、透明度合并(引擎
 * apply_opacity 同款数学)、提交参数形态(from_params 可解析的同构 JSON)、渐变映射取色。
 */
import {
  applyOpacityStops, clonePreset, DEFAULT_GRADIENT_PRESET, defaultGradient, findPreset, GRADIENT_GROUPS, hex01, hexOf01,
  moveStopAt, presetCss, presetMapStops, presetPaintParams, resolvePreset, sampleResolved, stopGapMid,
} from '../gradientPresets';

describe('预设数据(photocraft engine builtin() 同构)', () => {
  it('10 组 56 个预设(Basics 3 + 8 色系×6 + Rainbows 5),名字唯一,每个预设 ≥2 个按位置有序的停靠点', () => {
    expect(GRADIENT_GROUPS).toHaveLength(10);
    const all = GRADIENT_GROUPS.flatMap((g) => g.presets);
    expect(all).toHaveLength(56);
    expect(new Set(all.map((p) => p.name)).size).toBe(56);
    for (const p of all) {
      expect(p.stops.length).toBeGreaterThanOrEqual(2);
      for (let i = 1; i < p.stops.length; i++) {
        expect(p.stops[i][0]).toBeGreaterThanOrEqual(p.stops[i - 1][0]);
        expect(p.stops[i][0]).toBeLessThanOrEqual(1);
      }
    }
  });
  it('均匀分布:Blue 02 三色位于 0/0.5/1;家族命名 Blue 01..06', () => {
    const blues = GRADIENT_GROUPS.find((g) => g.name === 'Blues')!;
    expect(blues.presets.map((p) => p.name)).toEqual(['Blue 01', 'Blue 02', 'Blue 03', 'Blue 04', 'Blue 05', 'Blue 06']);
    const b02 = blues.presets[1];
    expect(b02.stops.map(([t]) => t)).toEqual([0, 0.5, 1]);
    expect(b02.stops[0][1]).toEqual(hex01('#1c2a5a'));
    expect(b02.stops[2][1]).toEqual(hex01('#a8d4ff'));
  });
  it('findPreset:默认前景→背景;查不到回 null', () => {
    expect(findPreset(DEFAULT_GRADIENT_PRESET)!.name).toBe('Foreground to Background');
    expect(findPreset('Nope')).toBeNull();
  });
  it('hex01/hexOf01 往返(引擎 hex/hex_of 同款)', () => {
    expect(hex01('#0b3d91')).toEqual([0x0b / 255, 0x3d / 255, 0x91 / 255]);
    expect(hexOf01(hex01('#Ec13Ec'))).toBe('#ec13ec');
    expect(hexOf01([1.5, -0.2, 0.504])).toBe('#ff0081');
  });
});

describe('resolvePreset(引擎 resolve():活引用解析 + apply_opacity)', () => {
  it('前景→背景:活引用按当前前景/背景解析,alpha=1', () => {
    const p = findPreset(DEFAULT_GRADIENT_PRESET)!;
    expect(resolvePreset(p, [1, 0, 0], [0, 0, 1])).toEqual([
      [0, [1, 0, 0, 1]],
      [1, [0, 0, 1, 1]],
    ]);
  });
  it('前景→透明:透明度乘进 alpha 加密采样,中点 alpha≈0.5', () => {
    const p = findPreset('Foreground to Transparent')!;
    const rs = resolvePreset(p, [0.25, 0.5, 0.75], [1, 1, 1]);
    expect(rs.map(([t]) => t)).toEqual([0, 0.25, 0.5, 0.75, 1]); // 区间 4 分加密
    for (const [, c] of rs) expect(c.slice(0, 3)).toEqual([0.25, 0.5, 0.75]);
    expect(rs[0][1][3]).toBeCloseTo(1);
    expect(rs[2][1][3]).toBeCloseTo(0.5);
    expect(rs[4][1][3]).toBeCloseTo(0);
  });
  it('Rainbow Fade:不透明度斜坡落位 0.125/0.875,两端透明', () => {
    const p = findPreset('Rainbow Fade')!;
    const rs = resolvePreset(p, [0, 0, 0], [0, 0, 0]);
    const at = (t: number) => rs.find(([q]) => Math.abs(q - t) < 1e-9);
    expect(at(0.125)![1][3]).toBeCloseTo(1);
    expect(at(0.875)![1][3]).toBeCloseTo(1);
    expect(rs[0][1][3]).toBeCloseTo(0);
    expect(rs[rs.length - 1][1][3]).toBeCloseTo(0);
  });
});

describe('applyOpacityStops(引擎 apply_opacity 同款数学)', () => {
  it('全不透明原样返回;透明度斜坡乘进 alpha', () => {
    const cs: Array<[number, [number, number, number, number]]> = [[0, [1, 1, 1, 1]], [1, [0, 0, 0, 1]]];
    expect(applyOpacityStops(cs, [])).toBe(cs);
    const rs = applyOpacityStops(cs, [[0, 0], [1, 1]]);
    expect(rs.map(([t]) => t)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect(rs[2][1][3]).toBeCloseTo(0.5);
    expect(rs[2][1].slice(0, 3)).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('presetPaintParams(from_params 可解析的同构参数)', () => {
  it('前景→背景:活引用字符串,无 transparency', () => {
    expect(presetPaintParams(findPreset(DEFAULT_GRADIENT_PRESET)!)).toEqual({
      stops: [[0, 'foreground'], [1, 'background']],
    });
  });
  it('前景→透明:transparency 以 0..100 下发', () => {
    expect(presetPaintParams(findPreset('Foreground to Transparent')!)).toEqual({
      stops: [[0, 'foreground'], [1, 'foreground']],
      transparency: [[0, 100], [1, 0]],
    });
  });
  it('固定色预设:hex 停靠点;Rainbow 13 停靠点均匀 t 保留 3 位', () => {
    const blue = presetPaintParams(findPreset('Blue 01')!);
    expect(blue.stops).toEqual([[0, '#0b3d91'], [1, '#4fa3e0']]);
    expect(blue.transparency).toBeUndefined();
    const rb = presetPaintParams(findPreset('Rainbow')!);
    expect(rb.stops).toHaveLength(13);
    expect(rb.stops[1][0]).toBe(Math.round((1 / 12) * 1000) / 1000);
    expect(rb.stops[12][0]).toBe(1);
  });
});

describe('presetMapStops(渐变映射:活引用解析为 hex,透明度丢弃)', () => {
  it('前景→背景解析为当前色;Rainbow Fade 不加密(RGB 曲线只由颜色停靠点决定)', () => {
    expect(presetMapStops(findPreset(DEFAULT_GRADIENT_PRESET)!, [1, 0, 0], [0, 0, 1])).toEqual([
      { at: 0, color: '#ff0000' },
      { at: 1, color: '#0000ff' },
    ]);
    expect(presetMapStops(findPreset('Rainbow Fade')!, [0, 0, 0], [0, 0, 0])).toHaveLength(13);
  });
});

describe('编辑面板纯函数(clone/move/gap/sample)', () => {
  it('defaultGradient/clonePreset:独立副本,改副本不动共享预设表', () => {
    const d = defaultGradient();
    expect(d.name).toBe('Foreground to Background');
    d.stops[0] = [0.5, [1, 1, 1]];
    expect(findPreset(DEFAULT_GRADIENT_PRESET)!.stops[0][0]).toBe(0);
    const src = findPreset('Blue 02')!;
    const c = clonePreset(src);
    c.stops[1][1] = [0, 0, 0];
    expect((src.stops[1][1] as [number, number, number])[0]).not.toBe(0);
  });
  it('moveStopAt:跨位重排返回新下标,round 0.001、钳 0..1、保序', () => {
    const stops: Array<[number, string]> = [[0, 'a'], [0.5, 'b'], [1, 'c']];
    expect(moveStopAt(stops, 1, 0.9)).toBe(1);
    expect(stops.map(([t]) => t)).toEqual([0, 0.9, 1]);
    expect(moveStopAt(stops, 0, 2)).toBe(1);
    expect(stops.map(([t]) => t)).toEqual([0.9, 1, 1]);
    expect(moveStopAt(stops, 9, 0.5)).toBeNull();
  });
  it('stopGapMid:最宽间隙中点;少于两点取 0.5', () => {
    expect(stopGapMid([[0, 0], [0.4, 0], [0.5, 0]])).toBeCloseTo(0.2);
    expect(stopGapMid([[0, 0]])).toBe(0.5);
  });
  it('sampleResolved:活引用解析 + 透明度乘进 alpha(两端外恒值=端点值)', () => {
    const fb = findPreset(DEFAULT_GRADIENT_PRESET)!;
    expect(sampleResolved(fb, [1, 0, 0], [0, 0, 1], 0.25).slice(0, 3)).toEqual([0.75, 0, 0.25]);
    expect(sampleResolved(fb, [1, 0, 0], [0, 0, 1], 0.25)[3]).toBe(1);
    const ft = findPreset('Foreground to Transparent')!;
    expect(sampleResolved(ft, [0, 0, 0], [0, 0, 0], 0.5)[3]).toBeCloseTo(0.5);
    expect(sampleResolved(ft, [0, 0, 0], [0, 0, 0], -1)[3]).toBeCloseTo(1);
    expect(sampleResolved(ft, [0, 0, 0], [0, 0, 0], 5)[3]).toBeCloseTo(0);
  });
});

describe('presetCss(色板预览)', () => {
  it('linear-gradient 文本含加密采样点;前景→透明末端 alpha=0', () => {
    const css = presetCss(findPreset('Foreground to Transparent')!, [0, 0, 0], [0, 0, 0]);
    expect(css.startsWith('linear-gradient(to right, ')).toBe(true);
    expect(css).toContain('rgba(0, 0, 0, 1.0000) 0.000%');
    expect(css).toContain('rgba(0, 0, 0, 0.0000) 100.000%');
  });
});
