
// LRU (Least Recently Used) Cache implementation
// Stores up to 2000 thumbnails in memory to prevent repetitive IPC calls and Disk I/O
// This significantly speeds up navigating back to folders or scrolling through large lists.

const CACHE_LIMIT = 2000;
const cache = new Map<string, string>();

// Track cache usage statistics
let cacheHits = 0;
let cacheMisses = 0;

export const generateCacheKey = (path: string, modified: string | undefined) => {
    return `${path}::${modified || 'unknown'}`;
};

export const getCachedThumbnail = (key: string): string | undefined => {
    const val = cache.get(key);
    if (val) {
        cacheHits++;
        // Refresh item usage (move to end of Map)
        cache.delete(key);
        cache.set(key, val);
    } else {
        cacheMisses++;
    }
    return val;
};

// Export cache stats for debugging
export const getCacheStats = () => {
    return {
        hits: cacheHits,
        misses: cacheMisses,
        size: cache.size,
        limit: CACHE_LIMIT
    };
};

// Clear entire cache
export const clearCache = () => {
    cache.clear();
    cacheHits = 0;
    cacheMisses = 0;
};

export const setCachedThumbnail = (key: string, data: string) => {
    if (cache.has(key)) {
        // Refresh
        cache.delete(key);
    } else if (cache.size >= CACHE_LIMIT) {
        // Evict oldest (first item in Map)
        const firstKey = cache.keys().next().value;
        if (firstKey) cache.delete(firstKey);
    }
    cache.set(key, data);
};

export const hasCachedThumbnail = (key: string): boolean => {
    return cache.has(key);
};
