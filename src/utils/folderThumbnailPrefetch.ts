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
import { findImagesDeeply, clearFolderCoverCache, type NodeLookup } from './folderCoverImages';

// 预取提前量：约 1.3 屏（配合虚拟化 ±400px 缓冲，卡片进入 DOM 前早已缓存就绪）
const AHEAD_PX = 1200;
// 触发步进：与 FileGrid 滚动 handler 的 400px 阈值保持一致
// （见 FileGrid.tsx 中 lastFolderPrefetchRef 的判断）。
const STEP_PX = 400;
// 单次扫描的文件夹上限：= 每步进新进入窗口的文件夹数 × QUOTA_FACTOR，夹在 [MIN,MAX] 内。
//
// 旧实现是固定值 8，这是最主要的失配点：每 400px 进入视口的文件夹数
// ≈ STEP_PX × W / (thumbSize × (thumbSize + 40))，即 ∝ 1/thumbSize²：
//     thumbSize=150 → ~22 个（覆盖 36%）
//     thumbSize=100 → ~45 个（覆盖 18%）
//     thumbSize=64  → ~96 个（覆盖 8%）
// 图标越小覆盖率越低 —— 这正是「文件夹图标调得越小滚动越卡」的根因之一，
// 与 DOM / Canvas 图标实现的选择正交。改成按布局密度动态推算后自动适配。
const QUOTA_FACTOR = 1.5;
const MIN_FOLDERS_PER_PASS = 16;
const MAX_FOLDERS_PER_PASS = 256;
const MAX_IMAGES_PER_FOLDER = 3;
// 单次扫描的时间预算（ms）。配额放大后，深层嵌套文件夹的深搜可能把滚动
// handler 拖成 long task；超过预算立即中断，未完成的文件夹【不】标记为已预取，
// 留到下一轮继续（一帧 16.7ms，这里只占 4ms）。
const TIME_BUDGET_MS = 4;
// 已预取集合上限：超大目录长距离滚动时 Set 会持续膨胀，满了直接清空重来
// （只会导致重复预热，不影响正确性）。
const PREFETCHED_LIMIT = 20000;

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
    // 目录/视图已切换，旧的封面指纹随文件树一起失效
    clearFolderCoverCache();
  }

  /**
   * 扫描视口下方 AHEAD_PX 内的文件夹并预热缩略图。
   * layout 是 useLayout 的输出（按输入顺序），sortedByY 提供按 y 升序的索引
   * （useLayout 已维护，迭代该索引数组可提前 break）。幂等：已预取的文件夹跳过。
   */
  prefetchAhead(
    layout: PrefetchLayoutItem[],
    sortedByY: number[],
    getFileNode: NodeLookup,
    viewBottom: number
  ): void {
    if (!this.root || this.root === 'android_media_store') return;
    if (!layout || layout.length === 0 || !sortedByY) return;

    if (this.prefetched.size >= PREFETCHED_LIMIT) this.prefetched.clear();

    const windowEnd = viewBottom + AHEAD_PX;

    // 二分定位视口底部后的第一个元素，避免对超大型布局每次从头扫描
    let lo = 0;
    let hi = sortedByY.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const item = layout[sortedByY[mid]];
      if (!item || item.y < viewBottom) lo = mid + 1;
      else hi = mid;
    }

    // 第一遍：统计窗口内卡片密度（用于推算配额），并收集尚未预取的文件夹节点。
    // 这里复用组件同款的 findImagesDeeply —— 两份实现若在遍历上限上不一致
    // （旧的私有副本是 200、组件是 500），深层文件夹上预热到的图与组件最终
    // 要显示的图就对不上，预热结果会被白白浪费。
    const folders: FileNode[] = [];
    let itemsInWindow = 0;
    for (let k = lo; k < sortedByY.length; k++) {
      const item = layout[sortedByY[k]];
      if (!item) continue;
      if (item.y > windowEnd) break; // 按 y 升序，越过窗口即停
      itemsInWindow++;
      if (this.prefetched.has(item.id)) continue;
      const node = getFileNode(item.id);
      if (!node || node.type !== FileType.FOLDER) continue;
      folders.push(node);
    }
    if (folders.length === 0) return;

    // 动态配额：密度(个/px) × 每步进像素 = 每滚动 STEP_PX 新进入窗口的文件夹数
    const density = itemsInWindow / AHEAD_PX;
    const perStep = density * STEP_PX;
    const quota = Math.max(
      MIN_FOLDERS_PER_PASS,
      Math.min(MAX_FOLDERS_PER_PASS, Math.ceil(perStep * QUOTA_FACTOR))
    );

    const deadline = performance.now() + TIME_BUDGET_MS;
    const n = Math.min(folders.length, quota);
    for (let i = 0; i < n; i++) {
      // 预算耗尽：中断但不标记，下一轮继续（否则这些文件夹将永远不再被预热）
      if (i > 0 && performance.now() > deadline) break;
      const folder = folders[i];
      this.warmFolder(folder, getFileNode);
      this.prefetched.add(folder.id);
    }
  }

  private warmFolder(folder: FileNode, getFileNode: NodeLookup): void {
    // 与 FolderThumbnail 取封面用的是同一个函数（含模块级指纹缓存），
    // 因此预热到的 URL 必定是组件挂载后要用到的那几个。
    const images = findImagesDeeply(folder, getFileNode, MAX_IMAGES_PER_FOLDER);
    for (const img of images) this.warmOne(img);
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
