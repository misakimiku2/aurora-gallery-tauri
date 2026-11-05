/** 导出为对话框纯函数测试(上游 export_dialog.rs tests 的 TS 移植)。 */
import { describe, expect, it } from 'vitest';
import { exportPixels, humanBytes, resizeFromScale, resizeFromSide, validSetting } from '../exportDialogMath';

describe('导出为·尺寸数学(上游 export_dialog.rs 口径)', () => {
  it('scale 模式逐边独立 round,永不低于 1(上游 scaled_size)', () => {
    expect(resizeFromScale(101, 101, 50)).toEqual({ width: 51, height: 51, scale: 50 });
    expect(resizeFromScale(8, 100, 50)).toEqual({ width: 4, height: 50, scale: 50 });
    // 1% 的小图:每边 clamp 到 1
    expect(resizeFromScale(3, 200, 1)).toEqual({ width: 1, height: 2, scale: 1 });
  });

  it('pixels 模式显式 W/H 优先,scale 模式忽略显式尺寸(上游 export_pixels)', () => {
    expect(exportPixels(1000, 500, { sizing: 'pixels', width: 300, height: 100, scale: 100 })).toEqual({ w: 300, h: 100 });
    expect(exportPixels(1000, 500, { sizing: 'scale', width: 300, height: 100, scale: 100 })).toEqual({ w: 1000, h: 500 });
  });

  it('exact pixels lock aspect and leave the source(上游 resize_from_side)', () => {
    // 锁比例:编辑宽,高按源纵横比,scale 同步
    expect(resizeFromSide(200, 100, 100, 999, true, true)).toEqual({ width: 100, height: 50, scale: 50 });
    // 编辑高同理
    expect(resizeFromSide(200, 100, 999, 40, true, false)).toEqual({ width: 80, height: 40, scale: 40 });
    // 不锁:另一边保持
    expect(resizeFromSide(200, 100, 100, 70, false, true)).toEqual({ width: 100, height: 70, scale: 50 });
  });

  it('rounds to whole pixels and clamps to 1..300000(上游 finite_px)', () => {
    const r = resizeFromSide(3, 7, 10, 999, true, true);
    expect(r).toEqual({ width: 10, height: 23, scale: expect.closeTo(1000 / 3, 6) });
    expect(resizeFromScale(100, 100, 500)).toEqual({ width: 500, height: 500, scale: 500 });
    expect(resizeFromScale(100, 100, 1001)).toBeNull();
    expect(resizeFromScale(100, 100, 0.5)).toBeNull();
    expect(resizeFromSide(100, 100, 0, 50, false, true)).toBeNull();
    expect(resizeFromSide(100, 100, 300001, 50, false, true)).toBeNull();
  });

  it('export_document_proxy_limits_both_dimensions_before_rounding(上游 #代理先压长边)', () => {
    expect(exportPixels(2000, 1000, { sizing: 'scale', scale: 100 }, 512)).toEqual({ w: 512, h: 256 });
    // pixels 模式同样压长边(上游 export_pixels 的 max_side 分支)
    expect(exportPixels(2000, 1000, { sizing: 'pixels', width: 2000, height: 1000, scale: 100 }, 512)).toEqual({ w: 512, h: 256 });
    // 小图不受代理影响
    expect(exportPixels(300, 200, { sizing: 'scale', scale: 100 }, 512)).toEqual({ w: 300, h: 200 });
  });

  it('height-only scaling still resamples when width rounds unchanged(上游 #1353)', () => {
    // 宽 round 后不变、高变:仍按两维发 imageSize(桥层 (w-src).abs>=1 判据)
    const f = { sizing: 'pixels' as const, width: 100, height: 51, scale: 100 };
    expect(exportPixels(100, 50, f)).toEqual({ w: 100, h: 51 });
  });
});

describe('导出为·记忆值校验(上游 valid_setting 真值表)', () => {
  it('范围与枚举逐键校验,非法值拒绝(种子回落默认)', () => {
    expect(validSetting('format', 'webp')).toBe(true);
    expect(validSetting('format', 'exe')).toBe(false);
    expect(validSetting('quality', 85)).toBe(true);
    expect(validSetting('quality', 0)).toBe(false);
    expect(validSetting('quality', 101)).toBe(false);
    expect(validSetting('scale', 1000)).toBe(true);
    expect(validSetting('scale', 1000.5)).toBe(false);
    expect(validSetting('width', 1)).toBe(true);
    expect(validSetting('width', 300001)).toBe(false);
    expect(validSetting('lossless', true)).toBe(true);
    expect(validSetting('lossless', 'true')).toBe(false);
    expect(validSetting('resample', 'nearest')).toBe(true);
    expect(validSetting('resample', 'lanczos')).toBe(false);
    expect(validSetting('metadata', 'exif')).toBe(true);
    expect(validSetting('metadata', 'some')).toBe(false);
    expect(validSetting('tgaBits', '32')).toBe(true);
    expect(validSetting('tgaBits', '16')).toBe(false);
    expect(validSetting('sizing', 'pixels')).toBe(true);
    expect(validSetting('profile', 'srgb')).toBe(true);
    expect(validSetting('profile', 'adobeRGB')).toBe(false);
    expect(validSetting('embedProfile', false)).toBe(true);
    expect(validSetting('unknown', 1)).toBe(false);
  });
});

describe('导出为·字节人性化', () => {
  it('B/KB/MB 三段', () => {
    expect(humanBytes(512)).toBe('512 B');
    expect(humanBytes(2048)).toBe('2.0 KB');
    expect(humanBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
