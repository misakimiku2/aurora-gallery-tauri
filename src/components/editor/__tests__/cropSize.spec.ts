/** W×H×分辨率模式纯函数测试(上游 crop_size.rs tests 的 TS 移植)。 */
import { describe, expect, it } from 'vitest';
import {
  formatLength, isWhrKey, normalizeLength, normalizeResolution, parseLength, resolutionPpi,
  whrCommitParams, whrPresetFields, whrRatio, whrTarget,
} from '../cropSize';

const fields = (w: string, h: string, res: string, unit = 'px/in') => ({
  cropRatio: 'whr', cropWidth: w, cropHeight: h, cropResolution: res, cropResolutionUnit: unit,
});

describe('长度解析(上游 parse_length)', () => {
  it('数字+可选单位;裸数字取 fallback;逗号小数', () => {
    expect(parseLength('4 in', 'px')).toEqual({ v: 4, unit: 'in' });
    expect(parseLength('4in', 'px')).toEqual({ v: 4, unit: 'in' });
    expect(parseLength('1024', 'px')).toEqual({ v: 1024, unit: 'px' });
    expect(parseLength('1024', 'in')).toEqual({ v: 1024, unit: 'in' });
    expect(parseLength('10,5 cm', 'px')).toEqual({ v: 10.5, unit: 'cm' });
    expect(parseLength('2.54 mm', 'px')).toEqual({ v: 2.54, unit: 'mm' });
    expect(parseLength('', 'px')).toBeNull();
    expect(parseLength('0', 'px')).toBeNull();
    expect(parseLength('-3 in', 'px')).toBeNull();
    expect(parseLength('4 市寸', 'px')).toBeNull();
  });
});

describe('字段规范化(上游 normalize_length/normalize_resolution)', () => {
  it('输入规范为 数字+单位;非法保留旧值;空=清空', () => {
    expect(normalizeLength('4in', '1024 px')).toBe('4 in');
    expect(normalizeLength('1024', '4 in')).toBe('1024 in');
    expect(normalizeLength('', '4 in')).toBe('');
    expect(normalizeLength('abc', '4 in')).toBe('4 in');
    expect(normalizeLength('-1 in', '4 in')).toBe('4 in');
    expect(normalizeResolution('96', '')).toBe('96');
    expect(normalizeResolution('96.24', '')).toBe('96.24');
    expect(normalizeResolution('', '300')).toBe('');
    expect(normalizeResolution('0', '300')).toBe('300');
    expect(normalizeResolution('abc', '300')).toBe('300');
  });
  it('formatLength:整数 px 不带尾零,inch 两位', () => {
    expect(formatLength(4, 'in')).toBe('4 in');
    expect(formatLength(8.5, 'in')).toBe('8.5 in');
    expect(formatLength(1024, 'px')).toBe('1024 px');
  });
});

describe('W×H 目标(上游 target/ratio 换算)', () => {
  it('px 直取;物理单位按所填分辨率换算;未填分辨率用文档 ppi', () => {
    expect(whrTarget(fields('1024 px', '768 px', ''), 72)).toEqual({ w: 1024, h: 768, res: null });
    // 4 in @300ppi = 1200px
    expect(whrTarget(fields('4 in', '5 in', '300'), 72)).toEqual({ w: 1200, h: 1500, res: 300 });
    // 未填分辨率:4 in @72 = 288px
    expect(whrTarget(fields('4 in', '2 in', ''), 72)).toEqual({ w: 288, h: 144, res: null });
    // cm @96: 2.54cm = 96px
    expect(whrTarget(fields('2.54 cm', '2.54 cm', '96'), 72)).toEqual({ w: 96, h: 96, res: 96 });
    // px/cm 字段单位
    expect(resolutionPpi({ cropResolution: '100', cropResolutionUnit: 'px/cm' })).toBeCloseTo(254, 6);
    // W 或 H 空/非法 → null(自由裁剪,不重采样)
    expect(whrTarget(fields('', '5 in', '300'), 72)).toBeNull();
    expect(whrTarget(fields('4 in', 'x', '300'), 72)).toBeNull();
    // 模式未开 → null
    expect(whrTarget({ ...fields('4 in', '5 in', '300'), cropRatio: '1:1' }, 72)).toBeNull();
    // ratio = w/h
    expect(whrRatio(fields('1024 px', '768 px', ''), 72)).toBeCloseTo(1024 / 768, 12);
  });
});

describe('提交参数(上游 commit_params)', () => {
  it('W/H 全填=round 的 targetWidth/Height;分辨率非空=resolution;仅分辨率=只改 ppi', () => {
    expect(whrCommitParams(fields('1024 px', '767.6 px', '300.4'), 72)).toEqual({ targetWidth: 1024, targetHeight: 768, resolution: 300.4 });
    expect(whrCommitParams(fields('4 in', '5 in', ''), 300)).toEqual({ targetWidth: 1200, targetHeight: 1500 });
    expect(whrCommitParams(fields('', '', '300'), 72)).toEqual({ resolution: 300 });
    expect(whrCommitParams(fields('', '', ''), 72)).toEqual({});
  });
});

describe('预设与 key 判定', () => {
  it('preset key 前缀判定与字段回填', () => {
    expect(isWhrKey('whr')).toBe(true);
    expect(isWhrKey('preset:4x5in')).toBe(true);
    expect(isWhrKey('1:1')).toBe(false);
    expect(isWhrKey('')).toBe(false);
    expect(whrPresetFields('preset:4x5in')).toMatchObject({ w: '4 in', h: '5 in', res: '300' });
    expect(whrPresetFields('preset:无')).toBeNull();
  });
});
