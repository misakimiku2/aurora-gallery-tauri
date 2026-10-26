/** 调整层元数据纯函数单测(引擎 adjust_params 口径的补丁展开)。 */
import {
  ADJUSTMENT_KINDS, BW_DEFAULTS, COLOR_LOOKUP_BUILTINS, EDITOR_READY_KINDS, HUE_RANGES,
  PHOTO_FILTERS, SELECTIVE_RANGES, applyAdjustPatch, bool, num, photoFilterPresetFor,
  withArrayIndex, withRangeField,
} from '../panels/adjustments';

describe('调整层清单(上游 adjustments_grid 口径)', () => {
  it('16 种 kind,顺序与上游一致,无重复', () => {
    expect(ADJUSTMENT_KINDS.map((k) => k.kind)).toEqual([
      'brightnessContrast', 'levels', 'curves', 'exposure', 'vibrance', 'hueSaturation',
      'colorBalance', 'blackWhite', 'photoFilter', 'channelMixer', 'invert', 'posterize',
      'threshold', 'gradientMap', 'selectiveColor', 'colorLookup',
    ]);
    expect(new Set(ADJUSTMENT_KINDS.map((k) => k.kind)).size).toBe(16);
  });
  it('13 种有本切片参数编辑器;levels/curves/gradientMap 留待下一切片', () => {
    expect(EDITOR_READY_KINDS.size).toBe(13);
    expect(EDITOR_READY_KINDS.has('levels')).toBe(false);
    expect(EDITOR_READY_KINDS.has('curves')).toBe(false);
    expect(EDITOR_READY_KINDS.has('gradientMap')).toBe(false);
    expect(EDITOR_READY_KINDS.has('invert')).toBe(true);
  });
  it('照片滤镜 20 预设 / 颜色查找 8 内置 / 色相 6 范围 / 可选颜色 9 范围', () => {
    expect(PHOTO_FILTERS).toHaveLength(20);
    expect(COLOR_LOOKUP_BUILTINS).toHaveLength(8);
    expect(HUE_RANGES.map((r) => r.key)).toEqual(['reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas']);
    expect(SELECTIVE_RANGES.map((r) => r.key)).toEqual([
      'reds', 'yellows', 'greens', 'cyans', 'blues', 'magentas', 'whites', 'neutrals', 'blacks',
    ]);
    expect(BW_DEFAULTS).toEqual([40, 60, 40, 60, 20, 80]);
  });
});

describe('参数补丁展开(引擎 layer.setAdjustment 整键合并语义)', () => {
  it('applyAdjustPatch:浅合并,给出的键覆盖', () => {
    expect(applyAdjustPatch({ brightness: 0, contrast: 0, legacy: false }, { brightness: 42 })).toEqual({
      brightness: 42, contrast: 0, legacy: false,
    });
  });
  it('withArrayIndex:替换指定下标,其余保留(数组长短都兜住)', () => {
    expect(withArrayIndex([10, 0, -20, 5], 1, 33)).toEqual([10, 33, -20, 5]);
    expect(withArrayIndex(undefined, 2, 7)).toEqual([0, 0, 7]);
    expect(withArrayIndex([1, 2], 0, 9)).toEqual([9, 2]);
  });
  it('withRangeField:范围键整体替换但带全量字段(引擎该键不部分合并)', () => {
    const full = { hue: 5, saturation: -10, lightness: 0, range: [15, 45, 75, 105] };
    expect(withRangeField(full, 'saturation', 50)).toEqual({
      hue: 5, saturation: 50, lightness: 0, range: [15, 45, 75, 105],
    });
    // 缺失/坏数据的兜底(不产出 NaN 进引擎)
    expect(withRangeField(undefined, 'hue', 12)).toEqual({
      hue: 12, saturation: 0, lightness: 0,
    });
    expect(withRangeField({ hue: 3 }, 'lightness', 1)).toEqual({
      hue: 3, saturation: 0, lightness: 1,
    });
  });
  it('photoFilterPresetFor:当前颜色回显预设 id(自定义颜色返回 null)', () => {
    expect(photoFilterPresetFor('#ec8a00')).toBe('warming85');
    expect(photoFilterPresetFor('#EC8A00')).toBe('warming85'); // 大小写不敏感
    expect(photoFilterPresetFor('#123456')).toBe(null);
    expect(photoFilterPresetFor(undefined)).toBe(null);
  });
  it('num/bool:坏数据回退默认(不把 NaN 喂给引擎)', () => {
    expect(num({ level: 128 }, 'level', 4)).toBe(128);
    expect(num({}, 'level', 4)).toBe(4);
    expect(num({ level: 'x' }, 'level', 4)).toBe(4);
    expect(num({ level: NaN }, 'level', 4)).toBe(4);
    expect(bool({ colorize: true }, 'colorize')).toBe(true);
    expect(bool({}, 'colorize', true)).toBe(true);
    expect(bool({ colorize: 1 }, 'colorize')).toBe(false);
  });
});
