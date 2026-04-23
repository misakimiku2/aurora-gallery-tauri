export class LRUCache<T> {
  private cache: Map<string, { value: T; timestamp: number }>;
  private maxSize: number;
  private readonly defaultMaxSize: number;
  private readonly minSize: number;

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

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }

  adjustSize(level: 'normal' | 'warning' | 'critical'): void {
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
      this.cache.delete(oldestKey);
    }
  }

  private evictToSize(targetSize: number): void {
    const entries = Array.from(this.cache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp);

    const toRemove = this.cache.size - targetSize;
    for (let i = 0; i < toRemove && i < entries.length; i++) {
      const [key] = entries[i];
      this.cache.delete(key);
    }
  }
}

export const createCache = <T>(maxSize: number = 1000): LRUCache<T> => {
  return new LRUCache<T>(maxSize);
};
