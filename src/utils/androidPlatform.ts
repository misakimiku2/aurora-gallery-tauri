import { invoke } from '@tauri-apps/api/core';
import { FileType } from '../types';
import { generateId } from './pathUtils';

let _isAndroidCached: boolean | null = null;
export async function isAndroidPlatform(): Promise<boolean> {
  if (_isAndroidCached !== null) return _isAndroidCached;
  try {
    const platform = await invoke<string>('get_platform');
    _isAndroidCached = platform === 'android';
  } catch (e) {
    _isAndroidCached = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
  }
  return _isAndroidCached;
}

let _androidPermissionResolve: ((result: string) => void) | null = null;
let _androidPermissionPromise: Promise<string> | null = null;
let _lastPermissionResult: string | null = null;

export function initAndroidPermissionListener() {
  if (typeof window === 'undefined') return;
  (window as any).__onAndroidPermissionResult = (result: string) => {
    _lastPermissionResult = result;
    if (_androidPermissionResolve) {
      _androidPermissionResolve(result);
      _androidPermissionResolve = null;
      _androidPermissionPromise = null;
    }
  };
}

export function waitForAndroidPermission(): Promise<string> {
  if (_lastPermissionResult) {
    const result = _lastPermissionResult;
    _lastPermissionResult = null;
    return Promise.resolve(result);
  }
  if (_androidPermissionPromise) return _androidPermissionPromise;
  _androidPermissionPromise = new Promise<string>((resolve) => {
    _androidPermissionResolve = resolve;
    setTimeout(() => {
      if (_androidPermissionResolve) {
        _androidPermissionResolve('timeout');
        _androidPermissionResolve = null;
        _androidPermissionPromise = null;
      }
    }, 3000);
  });
  return _androidPermissionPromise;
}

export async function ensureAndroidPermissionAndScan(): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  try {
    _lastPermissionResult = null;
    let permStatus = await invoke<string>('check_android_permissions');
    if (permStatus === 'granted' || permStatus === 'granted_partial') {
      return await scanAndroidMedia();
    }

    const permissionResult = await waitForAndroidPermission();
    if (permissionResult === 'granted' || permissionResult === 'granted_partial') {
      return await scanAndroidMedia();
    }

    if (permissionResult === 'denied' || permissionResult === 'denied_permanently' || permissionResult === 'timeout') {
      try {
        await invoke<string>('request_android_permissions');
        const retryResult = await waitForAndroidPermission();
        if (retryResult === 'granted' || retryResult === 'granted_partial') {
          return await scanAndroidMedia();
        }
      } catch (e) {
        console.error('[Android] Re-request permissions failed:', e);
      }
    }

    for (let i = 0; i < 2; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        permStatus = await invoke<string>('check_android_permissions');
        if (permStatus === 'granted' || permStatus === 'granted_partial') {
          return await scanAndroidMedia();
        }
      } catch {}
    }

    return null;
  } catch (e) {
    console.error('[Android] ensureAndroidPermissionAndScan failed:', e);
    return null;
  }
}

export async function ensureAndroidPermission(): Promise<boolean> {
  try {
    _lastPermissionResult = null;
    let permStatus = await invoke<string>('check_android_permissions');
    if (permStatus === 'granted' || permStatus === 'granted_partial') {
      return true;
    }

    const permissionResult = await waitForAndroidPermission();
    if (permissionResult === 'granted' || permissionResult === 'granted_partial') {
      return true;
    }

    if (permissionResult === 'denied' || permissionResult === 'denied_permanently' || permissionResult === 'timeout') {
      try {
        await invoke<string>('request_android_permissions');
        const retryResult = await waitForAndroidPermission();
        if (retryResult === 'granted' || retryResult === 'granted_partial') {
          return true;
        }
      } catch (e) {
        console.error('[Android] Re-request permissions failed:', e);
      }
    }

    for (let i = 0; i < 2; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        permStatus = await invoke<string>('check_android_permissions');
        if (permStatus === 'granted' || permStatus === 'granted_partial') {
          return true;
        }
      } catch {}
    }

    return false;
  } catch (e) {
    console.error('[Android] ensureAndroidPermission failed:', e);
    return false;
  }
}

interface AndroidFolderRaw {
  id: number;
  name: string;
  path: string;
  image_count: number;
  cover_image_path: string | null;
  cover_image_id: number | null;
}

interface AndroidImageRaw {
  id: number;
  path: string;
  content_uri: string;
  name: string;
  size: number;
  width: number | null;
  height: number | null;
  date_modified: number;
  mime_type: string;
}

interface AndroidScanAllRaw {
  folders: AndroidFolderRaw[];
  images: AndroidImageRaw[];
}

interface ScanCache {
  version: number;
  timestamp: number;
  folders: AndroidFolderRaw[];
  images: AndroidImageRaw[];
}

interface FolderScanCache {
  version: number;
  timestamp: number;
  folders: AndroidFolderRaw[];
}

const SCAN_CACHE_VERSION = 2;
const FOLDER_CACHE_VERSION = 1;

function buildFolderNodes(folders: AndroidFolderRaw[]): { files: Record<string, any>; roots: string[]; folderPathMap: Map<string, string> } {
  const files: Record<string, any> = {};
  const roots: string[] = [];
  const folderPathMap = new Map<string, string>();

  for (const folder of folders) {
    const folderId = generateId(folder.path || `folder_${folder.id}`);
    files[folderId] = {
      id: folderId,
      parentId: null,
      name: folder.name,
      type: 'folder',
      path: folder.path,
      children: [] as string[],
      tags: [],
      imageCount: folder.image_count,
      coverImagePath: folder.cover_image_path || undefined,
      coverImageMediaStoreId: folder.cover_image_id || undefined,
    };
    roots.push(folderId);
    if (folder.path) {
      folderPathMap.set(folder.path, folderId);
    }
  }

  return { files, roots, folderPathMap };
}

function attachImageNodes(
  files: Record<string, any>,
  images: AndroidImageRaw[],
  folderPathMap: Map<string, string>,
  roots: string[]
): void {
  for (const img of images) {
    const fileId = generateId(img.path);
    const parentDir = img.path.substring(0, img.path.lastIndexOf('/'));
    const parentId = folderPathMap.get(parentDir);

    files[fileId] = {
      id: fileId,
      parentId: parentId || null,
      name: img.name,
      type: 'image' as FileType,
      path: img.path,
      contentUri: img.content_uri,
      mediaStoreId: img.id,
      size: img.size,
      width: img.width,
      height: img.height,
      dateModified: img.date_modified,
      mimeType: img.mime_type,
      tags: [],
    };

    if (parentId && files[parentId]) {
      files[parentId].children.push(fileId);
    }
  }

  if (images.length > 0 && roots.length === 0) {
    const defaultFolderId = generateId('android_all_images');
    files[defaultFolderId] = {
      id: defaultFolderId,
      parentId: null,
      name: '所有图片',
      type: 'folder',
      path: '',
      children: [] as string[],
      tags: [],
    };
    roots.push(defaultFolderId);
    for (const img of images) {
      const fileId = generateId(img.path);
      if (!files[fileId]) continue;
      files[fileId].parentId = defaultFolderId;
      files[defaultFolderId].children.push(fileId);
    }
  }
}

export async function loadFolderCache(appDataDir: string): Promise<{ files: Record<string, any>; roots: string[]; cacheTimestamp?: number } | null> {
  try {
    const t0 = performance.now();
    const jsonStr = await invoke<string>('android_load_scan_cache', { appDataDir, cacheType: 'folders' });
    const cache: FolderScanCache = JSON.parse(jsonStr);

    if (!cache || cache.version !== FOLDER_CACHE_VERSION || !cache.folders) {
      console.log('[Android] Folder cache version mismatch or invalid, ignoring');
      return null;
    }

    console.log(`[Perf] loadFolderCache: ${cache.folders.length} folders in ${(performance.now() - t0).toFixed(0)}ms`);

    const { files, roots } = buildFolderNodes(cache.folders);
    return (roots.length > 0) ? { files, roots, cacheTimestamp: cache.timestamp } : null;
  } catch (e) {
    console.log('[Android] No folder cache available');
    return null;
  }
}

export async function loadScanCache(appDataDir: string): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  try {
    const t0 = performance.now();
    const jsonStr = await invoke<string>('android_load_scan_cache', { appDataDir, cacheType: 'full' });
    const cache: ScanCache = JSON.parse(jsonStr);

    if (!cache || cache.version !== SCAN_CACHE_VERSION || !cache.folders || !cache.images) {
      console.log('[Android] Scan cache version mismatch or invalid, ignoring');
      return null;
    }

    console.log(`[Perf] loadScanCache: ${cache.folders.length} folders, ${cache.images.length} images in ${(performance.now() - t0).toFixed(0)}ms (cached at ${new Date(cache.timestamp).toLocaleTimeString()})`);

    const { files, roots, folderPathMap } = buildFolderNodes(cache.folders);
    attachImageNodes(files, cache.images, folderPathMap, roots);

    return (roots.length > 0 && Object.keys(files).length > 0) ? { files, roots } : null;
  } catch (e) {
    console.log('[Android] No scan cache available, will perform fresh scan');
    return null;
  }
}

export async function saveScanCache(appDataDir: string, folders: AndroidFolderRaw[], images: AndroidImageRaw[]): Promise<void> {
  try {
    const folderCache: FolderScanCache = {
      version: FOLDER_CACHE_VERSION,
      timestamp: Date.now(),
      folders,
    };
    const folderJsonStr = JSON.stringify(folderCache);
    await invoke('android_save_scan_cache', { appDataDir, data: folderJsonStr, cacheType: 'folders' });

    const fullCache: ScanCache = {
      version: SCAN_CACHE_VERSION,
      timestamp: Date.now(),
      folders,
      images,
    };
    const fullJsonStr = JSON.stringify(fullCache);
    await invoke('android_save_scan_cache', { appDataDir, data: fullJsonStr, cacheType: 'full' });

    console.log(`[Android] Scan cache saved: ${folders.length} folders, ${images.length} images`);
  } catch (e) {
    console.error('[Android] Failed to save scan cache:', e);
  }
}

export async function scanAndroidFolders(): Promise<{ files: Record<string, any>; roots: string[]; rawFolders?: AndroidFolderRaw[] } | null> {
  try {
    const t0 = performance.now();
    const folders = await invoke<AndroidFolderRaw[]>('android_scan_folders');
    console.log(`[Perf] scanAndroidFolders: ${folders.length} folders in ${(performance.now() - t0).toFixed(0)}ms`);

    const { files, roots } = buildFolderNodes(folders);
    return (roots.length > 0) ? { files, roots, rawFolders: folders } : null;
  } catch (e) {
    console.error('[Android] scanAndroidFolders failed:', e);
    return null;
  }
}

export async function scanAndroidImages(
  existingFolders?: AndroidFolderRaw[],
  sinceTimestamp?: number
): Promise<{ files: Record<string, any>; roots: string[]; rawFolders?: AndroidFolderRaw[]; rawImages?: AndroidImageRaw[] } | null> {
  try {
    const t0 = performance.now();

    let folders: AndroidFolderRaw[];
    let images: AndroidImageRaw[];

    if (sinceTimestamp && sinceTimestamp > 0) {
      const result = await invoke<AndroidScanAllRaw>('android_scan_all', { sinceTimestamp });
      folders = result.folders;
      images = result.images;
      console.log(`[Perf] scanAndroidImages (incremental, since ${new Date(sinceTimestamp * 1000).toLocaleTimeString()}): ${images.length} new images, ${folders.length} folders in ${(performance.now() - t0).toFixed(0)}ms`);
    } else if (existingFolders) {
      folders = existingFolders;
      images = await invoke<AndroidImageRaw[]>('android_scan_images');
      console.log(`[Perf] scanAndroidImages (reusing folders): ${images.length} images in ${(performance.now() - t0).toFixed(0)}ms`);
    } else {
      const result = await invoke<AndroidScanAllRaw>('android_scan_all');
      folders = result.folders;
      images = result.images;
      console.log(`[Perf] scanAndroidImages (scan_all): ${images.length} images, ${folders.length} folders in ${(performance.now() - t0).toFixed(0)}ms`);
    }

    const { files, roots, folderPathMap } = buildFolderNodes(folders);
    attachImageNodes(files, images, folderPathMap, roots);

    return (roots.length > 0 && Object.keys(files).length > 0) ? { files, roots, rawFolders: folders, rawImages: images } : null;
  } catch (e) {
    console.error('[Android] scanAndroidImages failed:', e);
    return null;
  }
}

export async function scanAndroidMedia(): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  return scanAndroidImages();
}

initAndroidPermissionListener();
