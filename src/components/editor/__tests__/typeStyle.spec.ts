import { describe, expect, it } from 'vitest';
import {
  aaKey, ALIGN_ITEMS, axisLabel, axisValue, fauxToggleProps, kerningAt, kerningLabel, leadingShown,
  noteRecentFont, paraAt, parseKerning, selectedStyleName, shownScale, sliderAxes, styleAt,
  styleColorHex, styleLabel, styleNames, weightName, CHAR_TOGGLE_KEYS, type CharStyleJson, type FaceInfoJson,
} from '../typeStyle';

const face = (style: string, weight: number, italic = false, axes: FaceInfoJson['axes'] = []): FaceInfoJson =>
  ({ family: 'Test', style, postscriptName: `Test-${style.replace(' ', '')}`, weight, italic, axes });

const style = (over: Partial<CharStyleJson> = {}): CharStyleJson => ({
  font_family: 'Inter', font_style: '', postscript_name: null, weight: 400, italic: false,
  size_pt: 12, color: { mode: 'Rgb', c: [0, 0, 0, 0], alpha: 1 }, tracking: 0, leading_pt: null,
  baseline_shift_pt: 0, horizontal_scale: 1, vertical_scale: 1, underline: false, strikethrough: false,
  faux_bold: false, faux_italic: false, kerning: 'Metrics', kern: 0, caps: 'Normal', baseline: 'Normal',
  ligatures: true, discretionary_ligatures: false,
  ...over,
});

describe('typeStyle(二期 二-7,上游 type_tool.rs 字符面板/选项条 移植)', () => {
  it('weightName/styleNames:字重段位名;faces 子名+变量轴标准权重,轻→重去重', () => {
    expect(weightName(100)).toBe('Thin');
    expect(weightName(400)).toBe('Regular');
    expect(weightName(700)).toBe('Bold');
    expect(weightName(900)).toBe('Black');
    // 静态族:实际子名
    expect(styleNames([face('Regular', 400), face('Bold', 700)])).toEqual(['Regular', 'Bold']);
    // 变量族:默认 Thin(300→Light)之外,wght 轴 100..900 的标准权重补齐(非斜体 face 无 Italic 名)
    const vf = face('Thin', 300, false, [['wght', 100, 300, 900]]);
    const names = styleNames([vf]);
    expect(names).toContain('Regular');
    expect(names).toContain('Bold');
    expect(names).not.toContain('Italic');
    expect(names[0]).toBe('Thin');
    // 斜体 face 的轴权重带 Italic 后缀(400=Regular 段惯例就叫 Italic)
    const vfI = face('Thin Italic', 300, true, [['wght', 100, 300, 900]]);
    const namesI = styleNames([vfI]);
    expect(namesI).toContain('Italic');
    expect(namesI).toContain('Bold Italic');
    expect(styleNames([])).toEqual(['Regular']);
    expect(styleLabel('SemiBold Italic')).toBe('半粗体 斜体');
    expect(styleLabel('FooBar')).toBe('FooBar');
  });

  it('selectedStyleName:PostScript 名优先;缺省 font_style/斜体推断', () => {
    const faces = [face('Regular', 400), face('SemiBold', 600)];
    expect(selectedStyleName(style({ postscript_name: 'Test-SemiBold' }), faces)).toBe('SemiBold');
    expect(selectedStyleName(style({ postscript_name: 'Nope-42' }), faces)).toBe('Regular');
    expect(selectedStyleName(style({ font_style: 'Book' }), faces)).toBe('Book');
    expect(selectedStyleName(style({ italic: true }), faces)).toBe('Italic');
  });

  it('shownScale/styleAt/paraAt/leadingShown:变换缩放与选区起点样式', () => {
    expect(shownScale([2, 0, 0, 2, 0, 0])).toBeCloseTo(2, 6);
    expect(shownScale([1, 0, 0, 1, 0, 0])).toBe(1);
    expect(shownScale(undefined)).toBe(1);
    const runs = [
      { start: 0, end: 3, style: style({ size_pt: 12 }) },
      { start: 3, end: 10, style: style({ size_pt: 24 }) },
    ];
    expect(styleAt(runs, 1)?.size_pt).toBe(12);
    expect(styleAt(runs, 5)?.size_pt).toBe(24);
    expect(styleAt(runs, 99)?.size_pt).toBe(24); // 末尾落最后一段
    expect(styleAt([], 0)).toBeNull();
    const paras = [
      { start: 0, end: 3, style: { align: 'left', first_line_indent_pt: 0, start_indent_pt: 0, end_indent_pt: 0, space_before_pt: 0, space_after_pt: 0, auto_leading: 1.2, direction: 'Auto', hyphenate: false } },
    ];
    expect(paraAt(paras, 1)?.align).toBe('left');
    expect(paraAt([], 0)?.auto_leading).toBeUndefined(); // null → 运算符兜底
    expect(leadingShown(style({ size_pt: 10, leading_pt: 14 }), paras[0].style, 1)).toBe(14);
    expect(leadingShown(style({ size_pt: 10, leading_pt: null }), paras[0].style, 1)).toBeCloseTo(12, 6); // 10×1.2
    expect(leadingShown(style({ size_pt: 10, leading_pt: null }), paras[0].style, 2)).toBeCloseTo(24, 6);
  });

  it('kerningAt/kerningLabel/parseKerning:折叠 caret 前对;Metrics/Optical/数值', () => {
    const runs = [{ start: 0, end: 5, style: style({ kern: -50, kerning: 'Off' }) }];
    expect(kerningAt(style(), 3, runs)).toEqual({ mode: 'Off', kern: -50 }); // 前对(caret-1 所在 run)
    expect(kerningAt(style(), 0, runs)).toEqual({ mode: 'Metrics', kern: 0 }); // caret 0 无前对
    expect(kerningLabel({ mode: 'Metrics', kern: 0 })).toBe('Metrics');
    expect(kerningLabel({ mode: 'Optical', kern: 0 })).toBe('Optical');
    expect(kerningLabel({ mode: 'Off', kern: 0 })).toBe('0');
    expect(kerningLabel({ mode: 'Off', kern: -75.4 })).toBe('-75');
    expect(parseKerning('metrics')).toBe('metrics');
    expect(parseKerning('Optical')).toBe('optical');
    expect(parseKerning('-25.6')).toBe(-26);
    expect(parseKerning('10001')).toBeNull();
    expect(parseKerning('abc')).toBeNull();
  });

  it('aaKey/styleColorHex/fauxToggleProps/CHAR_TOGGLE_KEYS:读回→命令键与伪样式参数', () => {
    expect(aaKey('Sharp')).toBe('sharp');
    expect(aaKey('WindowsLcd')).toBe('windowsLcd');
    expect(aaKey('nope')).toBe('sharp');
    expect(styleColorHex({ mode: 'Rgb', c: [1, 0.5, 0, 0], alpha: 1 })).toBe('#ff8000');
    const c = style();
    const toggles = fauxToggleProps(c);
    expect(toggles.map((t) => t.on)).toEqual([false, false, false, false, false, false]);
    expect(toggles[0].props).toEqual({ fauxBold: true });
    expect(toggles[2].props).toEqual({ caps: 'allCaps' });
    const on = fauxToggleProps(style({ faux_bold: true, caps: 'AllCaps', underline: true }));
    expect(on.map((t) => t.on)).toEqual([true, false, true, false, true, false]);
    expect(on[0].props).toEqual({ fauxBold: false });
    expect(on[2].props).toEqual({ caps: 'normal' });
    expect(CHAR_TOGGLE_KEYS.b.write(true)).toEqual({ fauxBold: true });
    expect(CHAR_TOGGLE_KEYS.k.write(false)).toEqual({ caps: 'normal' });
    expect(CHAR_TOGGLE_KEYS.k.read(style({ caps: 'AllCaps' }))).toBe(true);
  });

  it('sliderAxes/axisValue/axisLabel:斜体匹配 face,退化任意 face;wght 回显字重', () => {
    const up = face('Regular', 400, false, [['wght', 100, 400, 900], ['opsz', 9, 14, 144]]);
    const it = face('Italic', 400, true, [['ital', 0, 0, 1], ['wght', 100, 400, 900]]);
    expect(sliderAxes([up, it], false).map((a) => a[0])).toEqual(['wght']); // opsz 被滤
    expect(sliderAxes([up, it], true).map((a) => a[0])).toEqual(['ital', 'wght']);
    expect(sliderAxes([], false)).toEqual([]);
    expect(axisValue(style({ weight: 650 }), ['wght', 100, 400, 900], {})).toBe(650);
    expect(axisValue(style(), ['ital', 0, 0, 1], {})).toBe(0); // 非斜体=轴默认
    expect(axisValue(style({ italic: true }), ['ital', 0, 0, 1], {})).toBe(1); // 斜体=轴 max
    expect(axisValue(style(), ['wdth', 50, 100, 200], {})).toBe(100);
    expect(axisValue(style(), ['wdth', 50, 100, 200], { wdth: 80 })).toBe(80);
    expect(axisValue(style(), ['wdth', 50, 100, 200], { wdth: 10 })).toBe(50); // 钳
    expect(axisLabel('wght')).toBe('字重');
    expect(axisLabel('GRAD')).toBe('GRAD');
  });

  it('noteRecentFont:重挑移队首,上限截断,0=清空', () => {
    expect(noteRecentFont(['A', 'B', 'C'], 'B')).toEqual(['B', 'A', 'C']);
    expect(noteRecentFont(['A', 'B'], 'X', 2)).toEqual(['X', 'A']);
    expect(noteRecentFont(['A'], 'B', 0)).toEqual([]);
  });

  it('ALIGN_ITEMS:七态键序(对齐/方向共用段落样式键)', () => {
    expect(ALIGN_ITEMS.map((a) => a.key)).toEqual(['left', 'center', 'right', 'justifyLeft', 'justifyCenter', 'justifyRight', 'justifyAll']);
  });
});
