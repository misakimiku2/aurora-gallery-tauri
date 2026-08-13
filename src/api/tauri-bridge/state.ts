import { convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { getGlobalCache } from '../../utils/thumbnailCache';
import { getThumbnailPrefetcher } from '../../utils/thumbnailPrefetch';

export let _globalCacheRoot: string | null = null;
export const _upgradingThumbnails = new Set<string>();
export let _isAndroid: boolean = false;

export function setGlobalCacheRoot(cacheRoot: string) {
  _globalCacheRoot = cacheRoot;
  getThumbnailPrefetcher().setCacheRoot(cacheRoot);
}

export function getGlobalCacheRoot(): string | null {
  return _globalCacheRoot;
}

export function setAndroidPlatform(isAndroid: boolean) {
  _isAndroid = isAndroid;
  if (isAndroid) {
    initAndroidThumbnailUpgradeListener();
  }
}

function initAndroidThumbnailUpgradeListener() {
  listen<{ filePath: string; thumbnailPath: string }>('android:thumbnail-upgraded', (event) => {
    const { filePath, thumbnailPath } = event.payload;
    const newSrc = convertFileSrc(thumbnailPath);
    const cache = getGlobalCache();
    const currentSrc = cache.get(filePath);
    _upgradingThumbnails.delete(filePath);
    if (currentSrc !== newSrc) {
      cache.set(filePath, newSrc);
      window.dispatchEvent(new CustomEvent('aurora:thumbnail-upgraded', {
        detail: { filePath, thumbnailSrc: newSrc }
      }));
    }
  }).catch(() => {});

  listen<{ filePath: string; error: string }>('android:thumbnail-upgrade-failed', (event) => {
    const { filePath } = event.payload;
    _upgradingThumbnails.delete(filePath);
    window.dispatchEvent(new CustomEvent('aurora:thumbnail-upgrade-failed', {
      detail: { filePath }
    }));
  }).catch(() => {});
}

export function isThumbnailUpgrading(filePath: string): boolean {
  return _upgradingThumbnails.has(filePath);
}

type ScrollState = 'idle' | 'scrolling' | 'fast';
let _globalScrollState: ScrollState = 'idle';
const _scrollStateListeners = new Set<(state: ScrollState) => void>();

export function setGlobalScrollState(state: ScrollState) {
  if (_globalScrollState === state) return;
  _globalScrollState = state;
  for (const listener of _scrollStateListeners) {
    try { listener(state); } catch {}
  }
}

export function getGlobalScrollState(): ScrollState {
  return _globalScrollState;
}

export function subscribeScrollState(listener: (state: ScrollState) => void): () => void {
  _scrollStateListeners.add(listener);
  return () => { _scrollStateListeners.delete(listener); };
}

export function isAndroidPlatformCached(): boolean {
  return _isAndroid;
}
