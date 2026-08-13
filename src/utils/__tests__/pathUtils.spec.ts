import { describe, it, expect } from 'vitest';
import { normalizePath, generateId } from '../pathUtils';

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\Misaki\\a.jpg')).toBe('C:/Users/Misaki/a.jpg');
  });

  it('leaves forward-slash paths unchanged', () => {
    expect(normalizePath('C:/Users/Misaki/a.jpg')).toBe('C:/Users/Misaki/a.jpg');
  });
});

describe('generateId', () => {
  it('produces a stable 9-char id for the same path', () => {
    const id = generateId('C:/photos/photo.jpg');
    expect(id).toHaveLength(9);
    expect(generateId('C:/photos/photo.jpg')).toBe(id);
  });

  it('produces different ids for different paths', () => {
    expect(generateId('C:/photos/a.jpg')).not.toBe(generateId('C:/photos/b.jpg'));
  });

  it('normalizes separators before hashing (backslash == forward slash)', () => {
    expect(generateId('C:\\photos\\a.jpg')).toBe(generateId('C:/photos/a.jpg'));
  });

  it('is deterministic across calls', () => {
    const first = generateId('D:/x/y/z/folder');
    const second = generateId('D:/x/y/z/folder');
    expect(first).toBe(second);
  });
});
