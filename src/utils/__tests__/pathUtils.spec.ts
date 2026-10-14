import { describe, it, expect } from 'vitest';
import { normalizePath, generateId, isAbsolutePath } from '../pathUtils';

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

describe('isAbsolutePath', () => {
  it('接受 Windows 盘符路径（反斜杠 / 正斜杠）', () => {
    expect(isAbsolutePath('C:\\Users\\Misaki\\a.mp4')).toBe(true);
    expect(isAbsolutePath('E:/桌面备份/git/aurora-gallery-tauri')).toBe(true);
  });

  it('接受 UNC 路径与 Unix 根路径', () => {
    expect(isAbsolutePath('\\\\server\\share\\a.mp4')).toBe(true);
    expect(isAbsolutePath('/home/user/a.mp4')).toBe(true);
  });

  it('拒绝 9 位节点 id（generateId 产物）——这正是本函数要拦截的误传', () => {
    const id = generateId('E:/photos');
    expect(id).toHaveLength(9);
    expect(isAbsolutePath(id)).toBe(false);
  });

  it('拒绝其余相对路径', () => {
    expect(isAbsolutePath('491b65a0d/.Aurora_Cache')).toBe(false);
    expect(isAbsolutePath('.Aurora_Cache')).toBe(false);
    expect(isAbsolutePath('C:relative')).toBe(false); // 盘符相对路径（无分隔符）
  });

  it('任何 generateId 产物都不会被误判为绝对路径', () => {
    for (const p of ['C:/a', 'E:/桌面备份/git', '/tmp/x', '\\\\srv\\share']) {
      expect(isAbsolutePath(generateId(p))).toBe(false);
    }
  });
});
