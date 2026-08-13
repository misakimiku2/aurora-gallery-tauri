import { describe, it, expect } from 'vitest';
import { getPinyinGroup } from '../textUtils';

describe('getPinyinGroup', () => {
  it('groups latin letters by uppercase first char', () => {
    expect(getPinyinGroup('apple')).toBe('A');
    expect(getPinyinGroup('Zebra')).toBe('Z');
    expect(getPinyinGroup('miku')).toBe('M');
  });

  it('groups digits as-is', () => {
    expect(getPinyinGroup('9nine')).toBe('9');
    expect(getPinyinGroup('0')).toBe('0');
  });

  it('groups common Chinese chars into the right bucket', () => {
    expect(getPinyinGroup('安')).toBe('A');
    expect(getPinyinGroup('妈')).toBe('M');
    expect(getPinyinGroup('拉')).toBe('L');
    expect(getPinyinGroup('张')).toBe('Z');
    expect(getPinyinGroup('啊')).toBe('A');
  });

  it('falls back to # for empty/symbols', () => {
    expect(getPinyinGroup('')).toBe('#');
    expect(getPinyinGroup('!')).toBe('#');
    expect(getPinyinGroup('★')).toBe('#');
  });
});
