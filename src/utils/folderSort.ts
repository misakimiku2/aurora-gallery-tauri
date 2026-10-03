// 文件夹/封面排序共享工具：
// useFileSearch 主排序管道、search.worker（备用路径）、FoldersOverview 总览排序、
// 文件夹封面选图（findImagesDeeply / FoldersOverview sortCoverOverrides）四处必须
// 保持同一套比较语义，此前各自内联实现已经出现过 size 用 sizeKb / size 的漂移，
// 抽到这里统一维护。
//
// 语义约定（与 useFileSearch 主管道完全一致）：
//   - name：lowercase localeCompare
//   - date：createdAt 字符串比较
//   - size：meta.sizeKb 数值比较
//   - asc 乘 1 / desc 乘 -1
//
// 文件夹按 date 排序的特殊语义（对齐 Kotlin 端 sortFolders 与 LAN 服务端口径）：
//   - key = 直接子图的 MAX(createdAt)，不递归嵌套子文件夹
//   - 无直接子图 = "无日期"，恒排在最后，不随 asc/desc 翻转
//   - 远程文件夹（lan/android，children 未在本地展开，children 为空数组）：
//     节点自身 createdAt 即 LAN 协议 latest_created_at（服务端已算好的直接子图
//     MAX(created_at)），直接作为 key 使用；缺省同样视为无日期。

import { FileNode, FileType, SortOption, SortDirection } from '../types';

/** 结构兼容 components/useLayoutHook 的 GetFileNode，避免 utils 反向依赖 components */
export type FileNodeLookup = (id: string) => FileNode | undefined;

/**
 * 文件夹按 date 排序的 key。
 * 返回 '' 表示"无日期"（调用方须让其恒排最后，不随方向翻转）。
 */
export const getFolderDateKey = (
  folder: FileNode,
  lookup?: FileNodeLookup,
): string => {
  const children = folder.children || [];
  const isRemote = folder.source === 'lan' || folder.source === 'android';
  // 本地文件夹，或 children 已在本地展开的远程文件夹：直接子图 MAX(createdAt)
  if (children.length > 0 || !isRemote) {
    let max = '';
    for (const childId of children) {
      const child = lookup ? lookup(childId) : undefined;
      if (!child || child.type !== FileType.IMAGE) continue;
      const c = child.createdAt || '';
      if (c && (!max || c > max)) max = c;
    }
    return max;
  }
  // 远程文件夹且 children 未展开：节点 createdAt = 协议 latest_created_at
  return folder.createdAt || '';
};

/**
 * 批量构建 folderId -> 内容最新时间 查表。只在排序前调用一次，
 * 避免在 comparator 里对每对元素反复遍历子节点。
 */
export const buildFolderDateKeys = (
  folders: FileNode[],
  lookup: FileNodeLookup,
): Map<string, string> => {
  const keys = new Map<string, string>();
  for (const folder of folders) {
    if (folder.type !== FileType.FOLDER) continue;
    keys.set(folder.id, getFolderDateKey(folder, lookup));
  }
  return keys;
};

/**
 * 同类型节点按 (sortBy, sortDirection) 比较 —— 封面选图等图片间比较统一走这里。
 */
export const compareNodesBySort = (
  a: FileNode,
  b: FileNode,
  sortBy: SortOption,
  sortDirection: SortDirection,
): number => {
  let res = 0;
  if (sortBy === 'date') res = (a.createdAt || '').localeCompare(b.createdAt || '');
  else if (sortBy === 'size') res = (a.meta?.sizeKb || 0) - (b.meta?.sizeKb || 0);
  else res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
  return res * (sortDirection === 'asc' ? 1 : -1);
};

/**
 * 主排序管道（useFileSearch / search.worker）的单对比较：
 *   - 不同类型：文件夹恒排图片前（与历史行为一致，本工具不改变这一点）
 *   - 同为文件夹且 sortBy==='date'：key = 查表 folderDateKeys；无日期恒最后（不随方向翻转）
 *   - 其余（含图片 date / size / name）：compareNodesBySort
 */
export const compareInMainPipeline = (
  a: FileNode,
  b: FileNode,
  sortBy: SortOption,
  sortDirection: SortDirection,
  folderDateKeys?: Map<string, string> | null,
): number => {
  if (a.type !== b.type) return a.type === FileType.FOLDER ? -1 : 1;
  if (sortBy === 'date' && a.type === FileType.FOLDER) {
    const ka = (folderDateKeys && folderDateKeys.get(a.id)) || '';
    const kb = (folderDateKeys && folderDateKeys.get(b.id)) || '';
    // 无日期恒最后，不随 asc/desc 翻转
    if (!ka && !kb) return 0;
    if (!ka) return 1;
    if (!kb) return -1;
    return ka.localeCompare(kb) * (sortDirection === 'asc' ? 1 : -1);
  }
  return compareNodesBySort(a, b, sortBy, sortDirection);
};
