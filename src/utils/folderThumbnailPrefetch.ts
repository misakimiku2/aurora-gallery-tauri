// 桌面端文件夹封面缩略图预取器：
// 在滚动过程中，把【视口下方 AHEAD_PX 内】的文件夹封面前 3 张子图缩略图提前
// 送入 ThumbnailBatcher（复用现有批量接口与 Rust 解码并发限制）。
// 这样缩略图解码发生在卡片进入视口【之前】，而不是在窗口边界批量挂载那一刻
// 集中爆发（那是滚动掉帧尖峰的主要来源）。滚动到达时 getGlobalCache 已命中，
// 文件夹卡片挂载即可直接显示三图拼贴，无需现场生成。

import { FileNode, FileType } from '../types';
import { isRemotePath } from './remoteSource';
import { getGlobalCache } from './thumbnailCache';
import { getThumbnail } from '../api/tauri-bridge/thumbnail';

// 预取提前量：约 1.2 屏（配合虚拟化 ±400px 缓冲，卡片进入 DOM 前早已缓存就绪）
const AHEAD_PX = 1200;
// 单次滚动步进最多预取文件夹数，控制每批解码负载
const MAX_FOLDERS_PER_PASS = 8;
const MAX_IMAGES_PER_FOLDER = 3;
const MAX_DEPTH_TRAVERSAL = 200;

interface PrefetchLayoutItem {
  id: string;
  y: number;
  height: number;
}

class FolderThumbnailPrefetcher {
  private prefetched = new Set<string>();
  private root: string | null = null;

  setRoot(root: string | null): void {
    this.root = root;
  }

  reset(): void {
    this.prefetched.clear();
  }

  /**
   * 扫描视口下方 AHEAD_PX 内的文件夹并预热缩略图。
   * layout 是 useLayout 的输出（按输入顺序），sortedByY 提供按 y 升序的索引
   * （useLayout 已维护，迭代该索引数组可提前 break）。幂等：已预取的文件夹跳过。
   */
  prefetchAhead(
    layout: PrefetchLayoutItem[],
    sortedByY: number[],
    getFileNode: (id: string) => FileNode | undefined,
    viewBottom: number
  ): void {
    if (!this.root || this.root === 'android_media_store') return;
    if (!layout || layout.length === 0 || !sortedByY) return;

    // 二分定位视口底部后的第一个元素，避免对超大型布局每次从头扫描
    let lo = 0;
    let hi = sortedByY.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const item = layout[sortedByY[mid]];
      if (!item || item.y < viewBottom) lo = mid + 1;
      else hi = mid;
    }

    let count = 0;
    for (let k = lo; k < sortedByY.length; k++) {
      const item = layout[sortedByY[k]];
      if (!item) continue;
      if (item.y > viewBottom + AHEAD_PX) break; // 按 y 升序，越过窗口即停
      if (this.prefetched.has(item.id)) continue;
      this.prefetched.add(item.id);
      count++;
      this.warmFolder(item.id, getFileNode);
      if (count >= MAX_FOLDERS_PER_PASS) break;
    }
  }

  private warmFolder(folderId: string, getFileNode: (id: string) => FileNode | undefined): void {
    const folder = getFileNode(folderId);
    if (!folder || folder.type !== FileType.FOLDER) return;

    // 深搜取前几张子图（与 FolderThumbnail 的 findImagesDeeply 逻辑一致）
    const images: FileNode[] = [];
    const stack = [...(folder.children || [])];
    const visited = new Set<string>();
    let traversals = 0;
    while (
      stack.length > 0 &&
      traversals < MAX_DEPTH_TRAVERSAL &&
      images.length < MAX_IMAGES_PER_FOLDER
    ) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      traversals++;
      const node = getFileNode(id);
      if (!node) continue;
      if (node.type === FileType.IMAGE) {
        images.push(node);
      } else if (node.type === FileType.FOLDER && node.children) {
        stack.push(...node.children);
      }
    }

    images
      .sort((a, b) =>
        (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '')
      )
      .slice(0, MAX_IMAGES_PER_FOLDER)
      .forEach(img => this.warmOne(img));
  }

  private warmOne(img: FileNode): void {
    if (!img.path || isRemotePath(img.path)) return;
    const cache = getGlobalCache();
    if (cache.has(img.path)) return; // 已就绪
    // fire-and-forget：走 ThumbnailBatcher 聚合，完成时自动写入 getGlobalCache
    getThumbnail(img.path, img.updatedAt, this.root ?? undefined).catch(() => {});
  }
}

let _instance: FolderThumbnailPrefetcher | null = null;

export const getFolderThumbnailPrefetcher = (): FolderThumbnailPrefetcher => {
  if (!_instance) _instance = new FolderThumbnailPrefetcher();
  return _instance;
};

export { FolderThumbnailPrefetcher };
