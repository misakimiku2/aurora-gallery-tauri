// 文件夹封面图选取：组件渲染与滚动预取共用的唯一实现。
//
// 之前 FolderThumbnail（MAX_TRAVERSAL=500）与 folderThumbnailPrefetch
// （MAX_DEPTH_TRAVERSAL=200）各维护一份 DFS 副本，参数不一致 —— 在需要
// 遍历 200 次以上才能凑够 3 张图的深层文件夹上，预取器只能拿到 1~2 张，
// 与组件最终要显示的不是同一批，预热结果被白白浪费。
//
// 抽成共享模块后：
//   1. 两边语义 100% 一致，预热的数据必定被组件使用；
//   2. 预取器算过的 DFS 结果直接命中组件侧缓存，省掉卡片挂载时那次深搜
//      （快速滚动时虚拟化反复卸载/重挂载同一卡片，这一步原本每次都要重跑）。
//
// 排序感知封面（sortBy/sortDirection）：封面 = 文件夹内按当前排序的前 limit 张。
// 遍历时流式维护"当前排序意义下的 top-N"（O(n) 单次比较），不再先收集全量数组
// 再排序；缓存指纹包含排序参数，排序切换后自动失效重算。不传 sortBy 时保持
// 旧语义（updatedAt||createdAt 降序）。

import { FileNode, FileType, SortOption, SortDirection } from '../types';
import { compareNodesBySort } from './folderSort';

// 结构兼容 components/useLayoutHook 的 GetFileNode，避免 utils 反向依赖 components
export type NodeLookup = (id: string) => FileNode | undefined;

const childrenFingerprint = (rootFolder: FileNode): string => {
    const kids = rootFolder.children || [];
    const first = kids[0] || '';
    const last = kids[kids.length - 1] || '';
    return `${kids.length}|${first}|${last}|${rootFolder.updatedAt || rootFolder.createdAt || ''}`;
};

const MAX_TRAVERSAL = 500;

// 无界 Map 在上万文件夹的目录里会持续占内存；超过上限清掉最早插入的一半
// （Map 保持插入顺序，前半即最冷的一半）。
const CACHE_LIMIT = 4000;

const cache = new Map<string, { fingerprint: string; images: FileNode[] }>();

/**
 * 把候选图插入按排序从优到劣维护的 top-N 数组（limit 很小，线性插入即可）。
 * 返回复用同一数组。
 */
const insertIntoBest = (
    best: FileNode[],
    candidate: FileNode,
    limit: number,
    cmp: (a: FileNode, b: FileNode) => number,
): void => {
    if (best.length >= limit && cmp(candidate, best[best.length - 1]) >= 0) return;
    // 从尾部找第一个优于 candidate 的位置
    let idx = best.length;
    while (idx > 0 && cmp(candidate, best[idx - 1]) < 0) idx--;
    if (idx >= limit) return;
    if (best.length < limit) best.length = Math.min(best.length + 1, limit);
    for (let i = best.length - 1; i > idx; i--) best[i] = best[i - 1];
    best[idx] = candidate;
};

export const findImagesDeeply = (
    rootFolder: FileNode,
    getFileNode: NodeLookup,
    limit: number = 3,
    sortBy?: SortOption,
    sortDirection?: SortDirection,
): FileNode[] => {
    // 指纹必须包含排序参数：同一文件夹在不同排序下封面不同
    const fp = `${childrenFingerprint(rootFolder)}|${sortBy || ''}|${sortDirection || ''}`;
    const cached = cache.get(rootFolder.id);
    if (cached && cached.fingerprint === fp) return cached.images;

    const cmp = sortBy
        ? (a: FileNode, b: FileNode) => compareNodesBySort(a, b, sortBy, sortDirection || 'asc')
        : (a: FileNode, b: FileNode) =>
            (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');

    // 流式 top-N：遍历中只保留当前排序意义下最优的 limit 张，不收集全量数组
    const best: FileNode[] = [];
    const stack: string[] = [...(rootFolder.children || [])];
    const visited = new Set<string>();

    let traversalCount = 0;
    while (stack.length > 0 && traversalCount < MAX_TRAVERSAL) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        traversalCount++;

        const node = getFileNode(id);
        if (!node) continue;

        if (node.type === FileType.IMAGE) {
            insertIntoBest(best, node, limit, cmp);
        } else if (node.type === FileType.FOLDER && node.children) {
            stack.push(...node.children);
        }
    }

    const result = best;

    if (cache.size >= CACHE_LIMIT) {
        const keys = Array.from(cache.keys());
        const drop = Math.ceil(keys.length / 2);
        for (let i = 0; i < drop; i++) cache.delete(keys[i]);
    }
    cache.set(rootFolder.id, { fingerprint: fp, images: result });
    return result;
};

/** 目录切换 / 文件树重建后调用，避免指纹漂移导致取到过期封面 */
export const clearFolderCoverCache = (): void => {
    cache.clear();
};

export const folderCoverCacheSize = (): number => cache.size;
