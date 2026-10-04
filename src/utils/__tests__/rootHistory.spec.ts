import { describe, it, expect } from 'vitest';
import {
  MAX_ROOT_HISTORY,
  normalizeRootPath,
  isSameRootPath,
  pushRootHistory,
  removeRootHistory,
  rootDisplayName,
} from '../rootHistory';

describe('rootHistory', () => {
  it('normalizeRootPath 去掉结尾分隔符与首尾空白', () => {
    expect(normalizeRootPath('  D:\\Library\\  ')).toBe('D:\\Library');
    expect(normalizeRootPath('/mnt/pics///')).toBe('/mnt/pics');
  });

  it('isSameRootPath 忽略大小写与结尾分隔符', () => {
    expect(isSameRootPath('D:\\Library', 'd:\\library\\')).toBe(true);
    expect(isSameRootPath('D:\\Library', 'D:\\Other')).toBe(false);
    expect(isSameRootPath('', '')).toBe(false);
  });

  it('pushRootHistory 新根排在最前且不重复', () => {
    expect(pushRootHistory(['A', 'B'], 'B')).toEqual(['B', 'A']);
    expect(pushRootHistory(['A', 'B'], 'C')).toEqual(['C', 'A', 'B']);
    expect(pushRootHistory(['D:\\Lib'], 'd:\\lib')).toEqual(['d:\\lib']);
  });

  it('pushRootHistory 空路径不入列', () => {
    expect(pushRootHistory(['A'], '   ')).toEqual(['A']);
    expect(pushRootHistory(undefined, '')).toEqual([]);
  });

  it('pushRootHistory 超出上限丢最久未用的', () => {
    const many = Array.from({ length: MAX_ROOT_HISTORY }, (_, i) => `root-${i}`);
    const next = pushRootHistory(many, 'new-root');
    expect(next).toHaveLength(MAX_ROOT_HISTORY);
    expect(next[0]).toBe('new-root');
    expect(next).not.toContain(`root-${MAX_ROOT_HISTORY - 1}`);
  });

  it('removeRootHistory 按路径移除（不分大小写）', () => {
    expect(removeRootHistory(['A', 'B', 'C'], 'b')).toEqual(['A', 'C']);
  });

  it('rootDisplayName 取最后一段目录名', () => {
    expect(rootDisplayName('D:\\Media\\PixCall 库')).toBe('PixCall 库');
    expect(rootDisplayName('/mnt/pics/')).toBe('pics');
    expect(rootDisplayName('C:\\')).toBe('C:');
    expect(rootDisplayName('')).toBe('');
  });
});
