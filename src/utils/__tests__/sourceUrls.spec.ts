import { describe, it, expect } from 'vitest';
import {
  getSourceUrls,
  normalizeSourceUrls,
  toSourceUrlFields,
  appendSourceUrl,
  removeSourceUrl,
  replaceSourceUrl,
  dedupeSourceUrls,
} from '../sourceUrls';

describe('sourceUrls', () => {
  it('有数组时以数组为准，单值只是首项', () => {
    expect(getSourceUrls({ sourceUrls: ['a', 'b'], sourceUrl: 'a' })).toEqual(['a', 'b']);
  });

  it('只有旧的单值时退化成长度 1 的数组', () => {
    expect(getSourceUrls({ sourceUrl: 'https://x' })).toEqual(['https://x']);
    expect(getSourceUrls({})).toEqual([]);
    expect(getSourceUrls(undefined)).toEqual([]);
  });

  it('空数组不覆盖单值（老数据只有 sourceUrl 时不会被清掉）', () => {
    expect(getSourceUrls({ sourceUrls: [], sourceUrl: 'https://legacy' })).toEqual(['https://legacy']);
  });

  it('normalizeSourceUrls：有值给数组，没值给 undefined', () => {
    expect(normalizeSourceUrls(['a'], 'a')).toEqual(['a']);
    expect(normalizeSourceUrls(undefined, 'b')).toEqual(['b']);
    expect(normalizeSourceUrls([], null)).toBeUndefined();
  });

  it('toSourceUrlFields 同步首项，两边不会分叉', () => {
    expect(toSourceUrlFields(['a', 'b'])).toEqual({ sourceUrls: ['a', 'b'], sourceUrl: 'a' });
    expect(toSourceUrlFields([])).toEqual({ sourceUrls: [], sourceUrl: undefined });
  });

  it('appendSourceUrl 去空、去重，已在里面就原样返回', () => {
    expect(appendSourceUrl(['a'], 'b')).toEqual(['a', 'b']);
    expect(appendSourceUrl(['a'], 'a')).toEqual(['a']);
    expect(appendSourceUrl(['a'], '   ')).toEqual(['a']);
    expect(appendSourceUrl(undefined, 'https://x')).toEqual(['https://x']);
  });

  it('removeSourceUrl 只删命中的那条', () => {
    expect(removeSourceUrl(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
    expect(removeSourceUrl(undefined, 'b')).toEqual([]);
  });

  it('replaceSourceUrl 原地替换，顺序不变', () => {
    expect(replaceSourceUrl(['a', 'b', 'c'], 'b', 'B')).toEqual(['a', 'B', 'c']);
  });

  it('replaceSourceUrl 清空 = 放弃编辑（原值不动）', () => {
    expect(replaceSourceUrl(['a', 'b'], 'b', '   ')).toEqual(['a', 'b']);
  });

  it('replaceSourceUrl 与其它条撞了就并成一条', () => {
    expect(replaceSourceUrl(['a', 'b'], 'b', 'a')).toEqual(['a']);
  });

  it('replaceSourceUrl 对不存在的旧值不动手', () => {
    expect(replaceSourceUrl(['a'], 'zzz', 'x')).toEqual(['a']);
  });

  it('dedupeSourceUrls 去空去重保序', () => {
    expect(dedupeSourceUrls(['a', ' a ', 'b', '', 'a'])).toEqual(['a', 'b']);
  });
});
