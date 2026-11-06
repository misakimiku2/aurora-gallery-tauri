import { describe, it, expect } from 'vitest';
import { pruneRescannedSubtree } from './scanPrune';
import { FileType } from '../types';
import type { FileNode } from '../types';

const folder = (id: string, children: string[], parentId: string | null = null): FileNode => ({
  id, parentId, name: id, type: FileType.FOLDER, path: `/${id}`, children, tags: [],
});
const image = (id: string, parentId: string): FileNode => ({
  id, parentId, name: id, type: FileType.IMAGE, path: `/${parentId}/${id}`, tags: [],
});

describe('pruneRescannedSubtree', () => {
  it('剪掉重扫后消失的文件,保留结果里的条目', () => {
    const prev = {
      root: folder('root', ['a', 'gone']),
      a: image('a', 'root'),
      gone: image('gone', 'root'),
    };
    const incoming = { root: folder('root', ['a']), a: image('a', 'root') };
    const out = pruneRescannedSubtree(prev, ['root'], incoming);
    expect(out).not.toBe(prev);
    expect(Object.keys(out).sort()).toEqual(['a', 'root']);
  });

  it('文件夹整体删除时,其子树(经旧 children 数组可达)一并剪掉', () => {
    const prev = {
      root: folder('root', ['sub']),
      sub: folder('sub', ['x', 'y'], 'root'),
      x: image('x', 'sub'),
      y: image('y', 'sub'),
      other: image('other', 'root2'),
      root2: folder('root2', ['other']),
    };
    const incoming = { root: folder('root', []) };
    const out = pruneRescannedSubtree(prev, ['root'], incoming);
    // root 本身被结果保留(整体刷新),只有 sub 子树被剪
    expect(Object.keys(out).sort()).toEqual(['other', 'root', 'root2']);
  });

  it('其他根目录的条目不受影响', () => {
    const prev = {
      root: folder('root', ['a']),
      a: image('a', 'root'),
      rootB: folder('rootB', ['b']),
      b: image('b', 'rootB'),
    };
    const incoming = { root: folder('root', ['a']), a: image('a', 'root') };
    const out = pruneRescannedSubtree(prev, ['root'], incoming);
    expect(Object.keys(out).sort()).toEqual(['a', 'b', 'root', 'rootB']);
  });

  it('游离节点(parentId=null,LAN 下载落盘件)不被剪', () => {
    const lanNode: FileNode = { ...image('lan1', ''), parentId: null, path: 'C:\\lib\\.Aurora_Cache\\lan1.jpg' };
    const prev = {
      root: folder('root', ['a']),
      a: image('a', 'root'),
      lan1: lanNode,
    };
    const incoming = { root: folder('root', ['a']), a: image('a', 'root') };
    const out = pruneRescannedSubtree(prev, ['root'], incoming);
    expect(out.lan1).toBe(lanNode);
  });

  it('扫描根不在旧图(首次扫描)时恒等返回', () => {
    const prev = { root: folder('root', ['a']), a: image('a', 'root') };
    const out = pruneRescannedSubtree(prev, ['fresh'], {});
    expect(out).toBe(prev);
  });

  it('无陈旧条目时恒等返回(不产生新对象,避免无谓重渲)', () => {
    const prev = {
      root: folder('root', ['a']),
      a: image('a', 'root'),
    };
    const incoming = { root: folder('root', ['a']), a: image('a', 'root') };
    const out = pruneRescannedSubtree(prev, ['root'], incoming);
    expect(out).toBe(prev);
  });

  it('脏数据成环不炸(深度上限兜底)', () => {
    const loop: FileNode = { ...folder('loop', ['loop']) };
    const prev = { loop, root: folder('root', []) };
    const incoming = { root: folder('root', []) };
    expect(() => pruneRescannedSubtree(prev, ['root'], incoming)).not.toThrow();
  });
});
