import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getGlobalCache } from './thumbnailCache';
import { performanceMonitor } from './performanceMonitor';

interface BatchThumbnailResult {
  path: string;
  thumbnailPath: string | null;
  width: number;
  height: number;
  upgrading: boolean;
}

class ThumbnailPrefetcher {
  private prefetchedIds: Set<number> = new Set();
  private isPrefetching = false;
  private batchSize = 50;
  private pendingIds: number[] = [];
  private cacheRoot: string | null = null;

  setCacheRoot(cacheRoot: string): void {
    this.cacheRoot = cacheRoot;
  }

  updateVisibleIds(
    visibleIds: Array<{ mediaStoreId?: number; filePath: string }>,
    bufferIds: Array<{ mediaStoreId?: number; filePath: string }>
  ): void {
    if (!this.cacheRoot) return;

    const cache = getGlobalCache();

    const idsToPrefetch: number[] = [];
    for (const item of bufferIds) {
      if (!item.mediaStoreId) continue;
      if (this.prefetchedIds.has(item.mediaStoreId)) continue;
      if (cache.has(item.filePath)) continue;
      idsToPrefetch.push(item.mediaStoreId);
    }

    if (idsToPrefetch.length === 0) return;

    this.pendingIds = idsToPrefetch.filter(
      id => !this.prefetchedIds.has(id)
    );

    if (!this.isPrefetching) {
      this.prefetchBatch();
    }
  }

  private async prefetchBatch(): Promise<void> {
    if (this.isPrefetching || this.pendingIds.length === 0 || !this.cacheRoot) return;

    this.isPrefetching = true;

    const batch = this.pendingIds.splice(0, this.batchSize);

    try {
      const results = await invoke<BatchThumbnailResult[]>(
        'android_batch_get_thumbnails',
        { imageIds: batch, cacheRoot: this.cacheRoot }
      );

      const cache = getGlobalCache();

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const id = batch[i];
        this.prefetchedIds.add(id);

        if (result.thumbnailPath) {
          const src = convertFileSrc(result.thumbnailPath);
          const filePath = result.path || `media_store_id:${id}`;

          if (!cache.has(filePath)) {
            cache.set(filePath, src);
          }

          performanceMonitor.increment('thumbnailPrefetchHit');
        }
      }
    } catch (e) {
      console.warn('[ThumbnailPrefetcher] Batch prefetch failed:', e);
      for (const id of batch) {
        this.prefetchedIds.add(id);
      }
    } finally {
      this.isPrefetching = false;

      if (this.pendingIds.length > 0) {
        this.prefetchBatch();
      }
    }
  }

  reset(): void {
    this.prefetchedIds.clear();
    this.pendingIds = [];
    this.isPrefetching = false;
  }
}

let _prefetcher: ThumbnailPrefetcher | null = null;

export const getThumbnailPrefetcher = (): ThumbnailPrefetcher => {
  if (!_prefetcher) {
    _prefetcher = new ThumbnailPrefetcher();
  }
  return _prefetcher;
};

export { ThumbnailPrefetcher };
