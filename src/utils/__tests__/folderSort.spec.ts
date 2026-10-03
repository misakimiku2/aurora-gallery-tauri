import { describe, it, expect, beforeEach } from 'vitest';
import {
  getFolderDateKey,
  buildFolderDateKeys,
  compareNodesBySort,
  compareInMainPipeline,
} from '../folderSort';
import { findImagesDeeply, clearFolderCoverCache } from '../folderCoverImages';
import { FileNode, FileType, SortOption, SortDirection } from '../../types';

const img = (id: string, extra: Partial<FileNode> = {}): FileNode => ({
  id,
  parentId: null,
  name: id,
  type: FileType.IMAGE,
  path: `/root/${id}`,
  tags: [],
  ...extra,
});

const folder = (id: string, children: string[], extra: Partial<FileNode> = {}): FileNode => ({
  id,
  parentId: null,
  name: id,
  type: FileType.FOLDER,
  path: `/root/${id}`,
  children,
  tags: [],
  ...extra,
});

describe('getFolderDateKey（文件夹按时间排序 = 直接子图最新时间）', () => {
  const files: Record<string, FileNode> = {
    'img-old': img('img-old', { createdAt: '2024-01-01T00:00:00Z' }),
    'img-mid': img('img-mid', { createdAt: '2024-05-01T00:00:00Z' }),
    'img-new': img('img-new', { createdAt: '2024-09-01T00:00:00Z' }),
    'subfolder-1': folder('subfolder-1', ['img-new'], { createdAt: '2023-01-01T00:00:00Z' }),
    'nested': folder('nested', ['img-old']),
  };
  const lookup = (id: string) => files[id];

  it('取直接子图的 MAX(createdAt)', () => {
    const f = folder('f1', ['img-old', 'img-mid', 'img-new']);
    expect(getFolderDateKey(f, lookup)).toBe('2024-09-01T00:00:00Z');
  });

  it('不递归嵌套子文件夹（子文件夹里的图不算）', () => {
    const f = folder('f2', ['subfolder-1', 'img-old']);
    // 只有 img-old 是直接子图；subfolder-1 内的 img-new 不参与
    expect(getFolderDateKey(f, lookup)).toBe('2024-01-01T00:00:00Z');
  });

  it('无直接子图的文件夹返回空串（无日期）', () => {
    expect(getFolderDateKey(folder('f3', ['nested']), lookup)).toBe('');
    expect(getFolderDateKey(folder('f4', []), lookup)).toBe('');
  });

  it('远程文件夹（lan/android）用节点自身 createdAt（= 协议 latest_created_at）', () => {
    const lan = folder('lan1', [], {
      source: 'lan',
      createdAt: '2024-08-08T00:00:00Z',
    });
    expect(getFolderDateKey(lan, lookup)).toBe('2024-08-08T00:00:00Z');

    const android = folder('and1', [], { source: 'android' });
    expect(getFolderDateKey(android, lookup)).toBe('');
  });

  it('buildFolderDateKeys 批量建表且跳过非文件夹节点', () => {
    const nodes = [
      folder('f1', ['img-old', 'img-mid']),
      img('img-new', { createdAt: '2024-09-01T00:00:00Z' }),
      folder('f2', []),
    ];
    const keys = buildFolderDateKeys(nodes, lookup);
    expect(keys.get('f1')).toBe('2024-05-01T00:00:00Z');
    expect(keys.get('f2')).toBe('');
    expect(keys.has('img-new')).toBe(false);
  });
});

describe('compareInMainPipeline（主排序管道：无日期恒最后 + 文件夹在前）', () => {
  const folderA = folder('fa', [], { createdAt: '2020-01-01T00:00:00Z' }); // 无直接子图
  const folderB = folder('fb', ['b1']);
  const folderC = folder('fc', ['c1']);
  const files: Record<string, FileNode> = {
    'b1': img('b1', { createdAt: '2024-01-01T00:00:00Z' }),
    'c1': img('c1', { createdAt: '2024-06-01T00:00:00Z' }),
  };
  const keys = buildFolderDateKeys([folderA, folderB, folderC], (id) => files[id]);

  it('文件夹按内容最新时间排序：asc 旧的在前', () => {
    expect(compareInMainPipeline(folderB, folderC, 'date', 'asc', keys)).toBeLessThan(0);
    expect(compareInMainPipeline(folderC, folderB, 'date', 'asc', keys)).toBeGreaterThan(0);
  });

  it('desc 反转先后', () => {
    expect(compareInMainPipeline(folderB, folderC, 'date', 'desc', keys)).toBeGreaterThan(0);
  });

  it('无日期的文件夹恒排最后，不随 asc/desc 翻转', () => {
    expect(compareInMainPipeline(folderB, folderA, 'date', 'asc', keys)).toBeLessThan(0);
    expect(compareInMainPipeline(folderA, folderB, 'date', 'asc', keys)).toBeGreaterThan(0);
    expect(compareInMainPipeline(folderB, folderA, 'date', 'desc', keys)).toBeLessThan(0);
    expect(compareInMainPipeline(folderA, folderB, 'date', 'desc', keys)).toBeGreaterThan(0);
  });

  it('文件夹仍恒排图片前（与历史行为一致）', () => {
    const image = img('i1', { createdAt: '2020-01-01T00:00:00Z' });
    expect(compareInMainPipeline(folderA, image, 'date', 'asc', keys)).toBeLessThan(0);
    expect(compareInMainPipeline(folderA, image, 'date', 'desc', keys)).toBeLessThan(0);
  });

  it('图片 date 分支仍用自身 createdAt', () => {
    const oldImg = img('i-old', { createdAt: '2020-01-01T00:00:00Z' });
    const newImg = img('i-new', { createdAt: '2025-01-01T00:00:00Z' });
    expect(compareInMainPipeline(oldImg, newImg, 'date', 'asc', null)).toBeLessThan(0);
    expect(compareInMainPipeline(oldImg, newImg, 'date', 'desc', null)).toBeGreaterThan(0);
  });
});

describe('compareNodesBySort（封面选图比较语义）', () => {
  it('name 用 lowercase localeCompare', () => {
    const a = img('Apple', { name: 'Apple' });
    const b = img('banana', { name: 'banana' });
    expect(compareNodesBySort(a, b, 'name', 'asc')).toBeLessThan(0);
    expect(compareNodesBySort(a, b, 'name', 'desc')).toBeGreaterThan(0);
  });

  it('date 用 createdAt 字符串比较', () => {
    const a = img('a', { createdAt: '2024-01-01T00:00:00Z' });
    const b = img('b', { createdAt: '2024-06-01T00:00:00Z' });
    expect(compareNodesBySort(a, b, 'date', 'asc')).toBeLessThan(0);
    expect(compareNodesBySort(a, b, 'date', 'desc')).toBeGreaterThan(0);
  });

  it('size 用 meta.sizeKb 数值比较', () => {
    const small = img('s', { meta: { width: 0, height: 0, sizeKb: 100, created: '', modified: '', format: 'jpg' } });
    const large = img('l', { meta: { width: 0, height: 0, sizeKb: 9000, created: '', modified: '', format: 'jpg' } });
    expect(compareNodesBySort(small, large, 'size', 'asc')).toBeLessThan(0);
    expect(compareNodesBySort(small, large, 'size', 'desc')).toBeGreaterThan(0);
  });
});

describe('findImagesDeeply（封面按排序选图）', () => {
  beforeEach(() => clearFolderCoverCache());

  const files: Record<string, FileNode> = {
    'a': img('a', { name: 'a.jpg', createdAt: '2024-01-01T00:00:00Z', meta: { width: 0, height: 0, sizeKb: 300, created: '', modified: '', format: 'jpg' } }),
    'b': img('b', { name: 'b.jpg', createdAt: '2024-06-01T00:00:00Z', meta: { width: 0, height: 0, sizeKb: 100, created: '', modified: '', format: 'jpg' } }),
    'c': img('c', { name: 'c.jpg', createdAt: '2024-03-01T00:00:00Z', meta: { width: 0, height: 0, sizeKb: 500, created: '', modified: '', format: 'jpg' } }),
  };
  const root = folder('root', ['a', 'b', 'c']);
  const lookup = (id: string) => files[id];

  it('date desc → 最新在前；date asc → 最旧在前', () => {
    expect(findImagesDeeply(root, lookup, 3, 'date', 'desc').map(n => n.id)).toEqual(['b', 'c', 'a']);
    expect(findImagesDeeply(root, lookup, 3, 'date', 'asc').map(n => n.id)).toEqual(['a', 'c', 'b']);
  });

  it('size desc → 最大文件在前', () => {
    expect(findImagesDeeply(root, lookup, 3, 'size', 'desc').map(n => n.id)).toEqual(['c', 'a', 'b']);
  });

  it('name desc → 名称最大在前', () => {
    expect(findImagesDeeply(root, lookup, 3, 'name', 'desc').map(n => n.id)).toEqual(['c', 'b', 'a']);
  });

  it('limit 截断取排序最优的前 N 张', () => {
    expect(findImagesDeeply(root, lookup, 1, 'date', 'desc').map(n => n.id)).toEqual(['b']);
    expect(findImagesDeeply(root, lookup, 1, 'size', 'desc').map(n => n.id)).toEqual(['c']);
  });

  it('同一文件夹切换排序后结果跟随变化（缓存指纹含排序参数）', () => {
    const first = findImagesDeeply(root, lookup, 1, 'date', 'desc');
    const second = findImagesDeeply(root, lookup, 1, 'name', 'asc');
    expect(first.map(n => n.id)).toEqual(['b']);
    expect(second.map(n => n.id)).toEqual(['a']);
  });

  it('不传排序时保持旧语义（updatedAt||createdAt 降序）', () => {
    const withUpdated: Record<string, FileNode> = {
      'a': img('a', { updatedAt: '2024-01-01T00:00:00Z' }),
      'b': img('b', { updatedAt: '2024-09-01T00:00:00Z' }),
    };
    const r = folder('root2', ['a', 'b']);
    expect(findImagesDeeply(r, (id) => withUpdated[id], 2).map(n => n.id)).toEqual(['b', 'a']);
  });
});
