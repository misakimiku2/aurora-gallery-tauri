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

import { FileNode, FileType } from '../types';

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

export const findImagesDeeply = (
    rootFolder: FileNode,
    getFileNode: NodeLookup,
    limit: number = 3,
): FileNode[] => {
    const fp = childrenFingerprint(rootFolder);
    const cached = cache.get(rootFolder.id);
    if (cached && cached.fingerprint === fp) return cached.images;

    const images: FileNode[] = [];
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
            images.push(node);
        } else if (node.type === FileType.FOLDER && node.children) {
            stack.push(...node.children);
        }
    }

    const result = images
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        .slice(0, limit);

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
