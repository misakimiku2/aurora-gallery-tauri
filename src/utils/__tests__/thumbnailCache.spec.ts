import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LRUCache } from '../thumbnailCache';

describe('LRUCache', () => {
  // LRUCache 用 Date.now() 做 LRU 时间戳，同毫秒内操作会无法区分新旧，
  // 因此用 fake timers + setSystemTime 保证时间严格递增
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
  });
  afterEach(() => { vi.useRealTimers(); });

  const tick = () => vi.setSystemTime(Date.now() + 1000);

  it('stores and retrieves values', () => {
    const cache = new LRUCache<string>(3);
    cache.set('a', '1');
    expect(cache.get('a')).toBe('1');
    expect(cache.has('a')).toBe(true);
    expect(cache.size).toBe(1);
  });

  it('evicts the least recently used entry when over capacity', () => {
    const cache = new LRUCache<string>(3);
    cache.set('a', '1'); tick();
    cache.set('b', '2'); tick();
    cache.set('c', '3'); tick();
    cache.get('a'); tick(); // refresh 'a' timestamp
    cache.set('d', '4'); // must evict oldest ('b')
    expect(cache.has('b')).toBe(false);
    expect(cache.has('a')).toBe(true);
    expect(cache.has('c')).toBe(true);
    expect(cache.has('d')).toBe(true);
  });

  it('does not evict when re-setting an existing key', () => {
    const cache = new LRUCache<string>(2);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.set('a', '1-updated'); // in-place update, no eviction
    expect(cache.size).toBe(2);
    expect(cache.get('a')).toBe('1-updated');
  });

  it('clear() empties the cache', () => {
    const cache = new LRUCache<string>(3);
    cache.set('a', '1');
    cache.set('b', '2');
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.has('a')).toBe(false);
  });

  it('adjustSize shrinks to the target size', () => {
    const cache = new LRUCache<string>(10);
    for (let i = 0; i < 6; i++) cache.set(`k${i}`, String(i));
    cache.adjustSize('warning'); // 50% of default (10) => 5
    expect(cache.size).toBe(5);
    cache.adjustSize('critical'); // minSize (default 200) — larger, no eviction needed
    expect(cache.size).toBe(5);
  });

  it('adjustSize with a small minSize can evict aggressively', () => {
    const cache = new LRUCache<string>(10, 2);
    for (let i = 0; i < 6; i++) cache.set(`k${i}`, String(i));
    cache.adjustSize('critical'); // minSize = 2
    expect(cache.size).toBe(2);
  });

  it('registerBitmap closes replaced bitmaps', () => {
    const cache = new LRUCache<string>(3);
    const closed = vi.fn();
    const first = { close: closed } as unknown as ImageBitmap;
    const second = { close: vi.fn() } as unknown as ImageBitmap;
    cache.registerBitmap('k', first);
    cache.registerBitmap('k', second);
    expect(closed).toHaveBeenCalledTimes(1);
    expect(cache.getBitmap('k')).toBe(second);
  });

  it('unregisterBitmap removes and closes', () => {
    const cache = new LRUCache<string>(3);
    const closed = vi.fn();
    cache.registerBitmap('k', { close: closed } as unknown as ImageBitmap);
    cache.unregisterBitmap('k');
    expect(closed).toHaveBeenCalledTimes(1);
    expect(cache.getBitmap('k')).toBeUndefined();
  });

  it('releaseNonVisibleBitmaps keeps only visible keys', () => {
    const cache = new LRUCache<string>(3);
    const closedA = vi.fn();
    const closedB = vi.fn();
    cache.registerBitmap('a', { close: closedA } as unknown as ImageBitmap);
    cache.registerBitmap('b', { close: closedB } as unknown as ImageBitmap);
    cache.setVisibleKeys(new Set(['a']));
    cache.releaseNonVisibleBitmaps();
    expect(closedB).toHaveBeenCalledTimes(1);
    expect(closedA).not.toHaveBeenCalled();
    expect(cache.getBitmap('a')).toBeDefined();
  });
});
