import { MemoryPressureLevel } from './memoryPressureMonitor';

export class LRUCache<T> {
  private cache: Map<string, { value: T; timestamp: number }>;
  private maxSize: number;
  private readonly defaultMaxSize: number;
  private readonly minSize: number;
  private imageBitmaps: Map<string, ImageBitmap> = new Map();
  private visibleKeys: Set<string> = new Set();

  constructor(maxSize: number, minSize: number = 200) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.defaultMaxSize = maxSize;
    this.minSize = minSize;
  }

  get(key: string): T | undefined {
    const item = this.cache.get(key);
    if (item) {
      this.cache.set(key, { ...item, timestamp: Date.now() });
      return item.value;
    }
    return undefined;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxSize && !this.cache.has(key)) {
      this.evictOldest();
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  delete(key: string): boolean {
    this.releaseBitmapForKey(key);
    return this.cache.delete(key);
  }

  /**
   * 按前缀批量删除。用于远程连接变化后清理失效的远程缩略图 URL
   * （URL 内嵌访问 token，重连后会更换；断线期间生成的还可能是空串）。
   */
  deleteByPrefix(prefix: string): number {
    let removed = 0;
    for (const key of Array.from(this.cache.keys())) {
      if (key.startsWith(prefix)) {
        this.releaseBitmapForKey(key);
        this.cache.delete(key);
        removed++;
      }
    }
    return removed;
  }

  clear(): void {
    this.releaseAllBitmaps();
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  registerBitmap(key: string, bitmap: ImageBitmap): void {
    const existing = this.imageBitmaps.get(key);
    if (existing && existing !== bitmap) {
      try { existing.close(); } catch {}
    }
    this.imageBitmaps.set(key, bitmap);
  }

  unregisterBitmap(key: string): void {
    const bitmap = this.imageBitmaps.get(key);
    if (bitmap) {
      try { bitmap.close(); } catch {}
      this.imageBitmaps.delete(key);
    }
  }

  getBitmap(key: string): ImageBitmap | undefined {
    return this.imageBitmaps.get(key);
  }

  setVisibleKeys(keys: Set<string>): void {
    this.visibleKeys = keys;
  }

  adjustSize(level: MemoryPressureLevel): void {
    let newMaxSize: number;
    switch (level) {
      case 'critical':
        newMaxSize = this.minSize;
        break;
      case 'warning':
        newMaxSize = Math.floor(this.defaultMaxSize * 0.5);
        break;
      case 'normal':
        newMaxSize = this.defaultMaxSize;
        break;
    }

    this.maxSize = newMaxSize;

    if (this.cache.size > this.maxSize) {
      this.evictToSize(this.maxSize);
    }

    if (level === 'critical') {
      this.releaseNonVisibleBitmaps();
    }
  }

  releaseNonVisibleBitmaps(): void {
    for (const [key, bitmap] of this.imageBitmaps) {
      if (!this.visibleKeys.has(key)) {
        try { bitmap.close(); } catch {}
        this.imageBitmaps.delete(key);
      }
    }
  }

  releaseAllBitmaps(): void {
    for (const [, bitmap] of this.imageBitmaps) {
      try { bitmap.close(); } catch {}
    }
    this.imageBitmaps.clear();
  }

  private evictOldest(): void {
    let oldestKey: string | undefined;
    let oldestTimestamp = Date.now() + 1;

    for (const [k, v] of this.cache.entries()) {
      if (v.timestamp < oldestTimestamp) {
        oldestTimestamp = v.timestamp;
        oldestKey = k;
      }
    }

    if (oldestKey) {
      this.releaseBitmapForKey(oldestKey);
      this.cache.delete(oldestKey);
    }
  }

  private evictToSize(targetSize: number): void {
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = this.cache.size - targetSize;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      const [key] = entries[i];
      this.releaseBitmapForKey(key);
      this.cache.delete(key);
    }
  }

  private releaseBitmapForKey(key: string): void {
    const bitmap = this.imageBitmaps.get(key);
    if (bitmap) {
      try { bitmap.close(); } catch {}
      this.imageBitmaps.delete(key);
    }
  }
}

declare global {
  interface Window {
    __AURORA_THUMBNAIL_CACHE__?: LRUCache<string>;
    __AURORA_THUMBNAIL_PATH_CACHE__?: LRUCache<string>;
  }
}

export const getGlobalCache = () => {
  if (!window.__AURORA_THUMBNAIL_CACHE__) {
    // 大图库（数万张）滚动时 LRU 太小会导致"刚滚过又滚回"时重复回源，
    // 1000→5000 仅存 URL 字符串，内存开销可忽略，但显著减少滚动往返的重复请求
    window.__AURORA_THUMBNAIL_CACHE__ = new LRUCache<string>(5000);
  }
  return window.__AURORA_THUMBNAIL_CACHE__;
};

export const getThumbnailPathCache = () => {
  if (!window.__AURORA_THUMBNAIL_PATH_CACHE__) {
    window.__AURORA_THUMBNAIL_PATH_CACHE__ = new LRUCache<string>(5000);
  }
  return window.__AURORA_THUMBNAIL_PATH_CACHE__;
};
