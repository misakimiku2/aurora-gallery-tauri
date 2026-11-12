// 轻量快调纯函数测试(与 src-tauri/src/image_adjust.rs 的 Rust 单测双面钉住两端一致性)。
// 权威公式在 Rust;这里验证 TS 侧逐项对齐 + 自动增强推导的数学正确性。

import {
  ADJUST_LUMA,
  ADJUST_DEFAULT,
  AdjustCropNorm,
  AdjustParams,
  applyToneRGBFloat,
  autoEnhanceFromStats,
  cloneDefault,
  cssFilterForTone,
  fitCropToAspect,
  inscribedRect,
  isDefaultAdjustParams,
  sanitizeAdjustParams,
} from '../adjust';

describe('adjust 影调公式(对齐 Rust apply_tone_rgb)', () => {
  test('luma 系数 = Rec709,与 SVG feColorMatrix saturate 一致', () => {
    expect(ADJUST_LUMA).toEqual([0.213, 0.715, 0.072]);
  });

  test('亮度:0.6×2 顶格 clamp;纯黑乘亮度仍是黑', () => {
    const t = { brightness: 1, contrast: 0, saturation: 0, temperature: 0, tint: 0 };
    const rgb: [number, number, number] = [0.6, 0.6, 0.6];
    applyToneRGBFloat(rgb, t);
    expect(rgb).toEqual([1, 1, 1]);
    const black: [number, number, number] = [0, 0, 0];
    applyToneRGBFloat(black, t);
    expect(black).toEqual([0, 0, 0]);
  });

  test('对比度:中灰不动;contrast=-1 压到 0.5', () => {
    const t = { brightness: 0, contrast: 0.8, saturation: 0, temperature: 0, tint: 0 };
    const mid: [number, number, number] = [0.5, 0.5, 0.5];
    applyToneRGBFloat(mid, t);
    expect(mid[0]).toBeCloseTo(0.5, 10);
    const t2 = { brightness: 0, contrast: -1, saturation: 0, temperature: 0, tint: 0 };
    const rgb: [number, number, number] = [0.2, 0.7, 0.4];
    applyToneRGBFloat(rgb, t2);
    expect(rgb).toEqual([0.5, 0.5, 0.5]);
  });

  test('饱和度:-1 → Rec709 luma;0 不变', () => {
    const t = { brightness: 0, contrast: 0, saturation: -1, temperature: 0, tint: 0 };
    const rgb: [number, number, number] = [1, 0, 0];
    applyToneRGBFloat(rgb, t);
    expect(rgb[0]).toBeCloseTo(ADJUST_LUMA[0], 10);
    expect(rgb[1]).toBeCloseTo(ADJUST_LUMA[0], 10);
    expect(rgb[2]).toBeCloseTo(ADJUST_LUMA[0], 10);
    const t0 = { brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0 };
    const keep: [number, number, number] = [1, 0, 0];
    applyToneRGBFloat(keep, t0);
    expect(keep).toEqual([1, 0, 0]);
  });

  test('色温/色调:暖 R↑B↓、绿 G↑;白点加暖 = [1,1,0.75]', () => {
    const t = { brightness: 0, contrast: 0, saturation: 0, temperature: 1, tint: -1 };
    const white: [number, number, number] = [1, 1, 1];
    applyToneRGBFloat(white, t);
    expect(white).toEqual([1, 1, 0.75]);
  });

  test('每步 clamp:亮度顶格后加对比不会回落(Rust 同口径)', () => {
    const t = { brightness: 1, contrast: -1, saturation: 0, temperature: 0, tint: 0 };
    const rgb: [number, number, number] = [0.6, 0.6, 0.6];
    applyToneRGBFloat(rgb, t);
    // 亮度后 clamp 到 1 → 对比度 -1 → (1-0.5)*0+0.5 = 0.5(而不是 1.2 回落路径)
    expect(rgb).toEqual([0.5, 0.5, 0.5]);
  });
});

describe('cssFilterForTone(CSS 内建 + SVG 引用,与 Rust 公式对齐)', () => {
  test('全默认 → none', () => {
    expect(cssFilterForTone(ADJUST_DEFAULT.tone)).toBe('none');
  });

  test('顺序钉死:brightness → contrast → saturate → url(#aurora-adjust-tt)', () => {
    const f = cssFilterForTone({ brightness: 0.1, contrast: -0.2, saturation: 0.3, temperature: 0.4, tint: 0 });
    const parts = f.split(' ');
    expect(parts[0]).toBe('brightness(1.100000)');
    expect(parts[1]).toBe('contrast(0.800000)');
    expect(parts[2]).toBe('saturate(1.300000)');
    expect(parts[3]).toBe('url(#aurora-adjust-tt)');
  });

  test('temp/tint 默认时不引用 SVG;单独 tint 也要引用', () => {
    expect(cssFilterForTone({ brightness: 0.1, contrast: 0, saturation: 0, temperature: 0, tint: 0 })).toBe('brightness(1.100000)');
    expect(cssFilterForTone({ brightness: 0, contrast: 0, saturation: 0, temperature: 0, tint: 0.2 })).toContain('url(#aurora-adjust-tt)');
  });
});

describe('sanitize(对齐 Rust AdjustParams::sanitize)', () => {
  test('rotate90 取模/负数、角度与滑杆夹取、坏裁剪置空', () => {
    const p = cloneDefault();
    p.geo.rotate90 = -1;
    p.geo.straightenDeg = 30;
    p.tone.saturation = 1.5;
    p.geo.cropNorm = { x: 0.8, y: 0.9, w: 0.5, h: 0.5 };
    const s = sanitizeAdjustParams(p);
    expect(s.geo.rotate90).toBe(3);
    expect(s.geo.straightenDeg).toBe(15);
    expect(s.tone.saturation).toBe(1);
    // x+w = 0.8+0.5 > 1 → w 被夹到 0.2
    expect(s.geo.cropNorm!.w).toBeCloseTo(0.2, 10);
    const p2 = cloneDefault();
    p2.geo.cropNorm = { x: 0.5, y: 0.5, w: 0, h: 0.5 };
    expect(sanitizeAdjustParams(p2).geo.cropNorm).toBeNull();
  });

  test('isDefault 判定与默认常量一致', () => {
    expect(isDefaultAdjustParams(ADJUST_DEFAULT)).toBe(true);
    const p = cloneDefault();
    p.tone.brightness = 0.001;
    expect(isDefaultAdjustParams(sanitizeAdjustParams(p))).toBe(false);
  });
});

describe('inscribedRect(对齐 Rust straighten_image 内接矩形)', () => {
  test('0° 恒等', () => {
    expect(inscribedRect(200, 100, 0)).toEqual({ w: 200, h: 100 });
  });
  test('10° 严格变小且保持 2:1', () => {
    const r = inscribedRect(200, 100, 10);
    expect(r.w).toBeLessThan(200);
    expect(r.h).toBeLessThan(100);
    expect(r.w / r.h).toBeCloseTo(2, 1);
  });
  test('90° 退化(公式两端一致即可)', () => {
    const r = inscribedRect(200, 100, 90);
    expect(r.w).toBeCloseTo(100, 0);
    expect(r.h).toBeCloseTo(50, 0);
  });
});

describe('autoEnhanceFromStats(直方图拉伸 + 灰世界)', () => {
  test('亮度+对比度合成 = 目标线性映射 slope·(v-mid)+0.5', () => {
    const { brightness, contrast } = autoEnhanceFromStats(0.2, 0.8, 0.5, 0.5, 0.5);
    // 链式合成:v' = (1+pb)(1+pc)·v - 0.5·pc
    const a = (1 + brightness) * (1 + contrast);
    const b = -0.5 * contrast;
    const slope = 1 / Math.max(0.8 - 0.2, 1e-4);
    const mid = (0.2 + 0.8) / 2;
    expect(a).toBeCloseTo(slope, 6);
    expect(b).toBeCloseTo(0.5 - slope * mid, 6);
    // 温和统计不顶到 clamp 边界
    expect(Math.abs(brightness)).toBeLessThanOrEqual(1);
    expect(Math.abs(contrast)).toBeLessThanOrEqual(1);
  });

  test('偏蓝图 → 正色温(加暖);中性图 → 0', () => {
    const warm = autoEnhanceFromStats(0.1, 0.9, 0.5, 0.5, 0.7);
    expect(warm.temperature).toBeGreaterThan(0);
    const neutral = autoEnhanceFromStats(0.1, 0.9, 0.5, 0.5, 0.5);
    expect(neutral.temperature).toBe(0);
    expect(neutral.tint).toBe(0);
    expect(neutral.saturation).toBe(0);
  });
});

describe('fitCropToAspect(锁定比例)', () => {
  test('正方形保持、2:1 以宽推高并居中', () => {
    const c: AdjustCropNorm = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };
    expect(fitCropToAspect(c, 1)).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const wide = fitCropToAspect(c, 2);
    expect(wide.w).toBeCloseTo(0.5, 10);
    expect(wide.h).toBeCloseTo(0.25, 10);
    expect(wide.x).toBeCloseTo(0.25, 10);
    expect(wide.y).toBeCloseTo(0.375, 10);
  });

  test('贴边回推:贴右边时以高定宽', () => {
    const c: AdjustCropNorm = { x: 0.5, y: 0.5, w: 0.5, h: 0.5 };
    const r = fitCropToAspect(c, 2);
    expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
    expect(r.w / r.h).toBeCloseTo(2, 6);
  });
});

describe('契约默认(两端 JSON 同源)', () => {
  test('v=1 且全默认结构可 JSON 往返(sanitize 后与 Rust parse 对齐)', () => {
    const p: AdjustParams = JSON.parse(JSON.stringify(ADJUST_DEFAULT));
    const s = sanitizeAdjustParams(p);
    expect(JSON.parse(JSON.stringify(s))).toEqual(JSON.parse(JSON.stringify(ADJUST_DEFAULT)));
  });
});
