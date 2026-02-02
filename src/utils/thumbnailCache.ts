
// LRU Cache for thumbnails
export class LRUCache<T> {
  private cache: Map<string, { value: T; timestamp: number }>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const item = this.cache.get(key);
    if (item) {
      // Update timestamp on access
      this.cache.set(key, { ...item, timestamp: Date.now() });
      return item.value;
    }
    return undefined;
  }

  set(key: string, value: T): void {
    if (this.cache.size >= this.maxSize) {
      // Evict oldest item
      let oldestKey: string | undefined;
      let oldestTimestamp = Date.now() + 1;

      for (const [k, v] of this.cache.entries()) {
        if (v.timestamp < oldestTimestamp) {
          oldestTimestamp = v.timestamp;
          oldestKey = k;
        }
      }

      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

declare global {
  interface Window {
    __AURORA_THUMBNAIL_CACHE__?: LRUCache<string>;
    __AURORA_THUMBNAIL_PATH_CACHE__?: LRUCache<string>;
  }
}

// Get or initialize global thumbnail cache
export const getGlobalCache = () => {
  if (!window.__AURORA_THUMBNAIL_CACHE__) {
    // Max 1000 items, roughly 50-100MB
    window.__AURORA_THUMBNAIL_CACHE__ = new LRUCache<string>(1000);
  }
  return window.__AURORA_THUMBNAIL_CACHE__;
};

// Get or initialize thumbnail path cache (for external drag)
export const getThumbnailPathCache = () => {
  if (!window.__AURORA_THUMBNAIL_PATH_CACHE__) {
    window.__AURORA_THUMBNAIL_PATH_CACHE__ = new LRUCache<string>(1000);
  }
  return window.__AURORA_THUMBNAIL_PATH_CACHE__;
};
