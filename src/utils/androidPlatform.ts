import { invoke } from '@tauri-apps/api/core';
import { FileType } from '../types';
import { generateId } from './pathUtils';

let _isAndroidCached: boolean | null = null;
export async function isAndroidPlatform(): Promise<boolean> {
  if (_isAndroidCached !== null) return _isAndroidCached;
  try {
    const platform = await invoke<string>('get_platform');
    console.error('[Android] get_platform returned:', platform);
    _isAndroidCached = platform === 'android';
  } catch (e) {
    console.error('[Android] get_platform failed:', e);
    _isAndroidCached = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
    console.error('[Android] fallback userAgent detection:', _isAndroidCached, 'userAgent:', navigator?.userAgent);
  }
  return _isAndroidCached;
}

let _androidPermissionResolve: ((result: string) => void) | null = null;
let _androidPermissionPromise: Promise<string> | null = null;
let _lastPermissionResult: string | null = null;

export function initAndroidPermissionListener() {
  if (typeof window === 'undefined') return;
  (window as any).__onAndroidPermissionResult = (result: string) => {
    console.error('[Android] Permission result received:', result);
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
    }, 10000);
  });
  return _androidPermissionPromise;
}

export async function ensureAndroidPermissionAndScan(): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  try {
    _lastPermissionResult = null;
    console.error('[Android] ensureAndroidPermissionAndScan: checking permissions...');
    let permStatus = await invoke<string>('check_android_permissions');
    console.error('[Android] check_android_permissions result:', permStatus);
    if (permStatus === 'granted' || permStatus === 'granted_partial') {
      return await scanAndroidMedia();
    }

    console.error('[Android] Waiting for permission callback from Kotlin...');
    const permissionResult = await waitForAndroidPermission();
    console.error('[Android] Permission callback result:', permissionResult);
    if (permissionResult === 'granted' || permissionResult === 'granted_partial') {
      return await scanAndroidMedia();
    }

    if (permissionResult === 'denied' || permissionResult === 'denied_permanently' || permissionResult === 'timeout') {
      console.error('[Android] Permission not granted, trying to request again...');
      try {
        await invoke<string>('request_android_permissions');
        const retryResult = await waitForAndroidPermission();
        console.error('[Android] Re-request permission result:', retryResult);
        if (retryResult === 'granted' || retryResult === 'granted_partial') {
          return await scanAndroidMedia();
        }
      } catch (e) {
        console.error('[Android] Re-request permissions failed:', e);
      }
    }

    console.error('[Android] Falling back to polling permission status...');
    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
      try {
        permStatus = await invoke<string>('check_android_permissions');
        console.error(`[Android] Poll ${i + 1}: permission status =`, permStatus);
        if (permStatus === 'granted' || permStatus === 'granted_partial') {
          return await scanAndroidMedia();
        }
      } catch {}
    }

    console.error('[Android] All permission attempts failed');
    return null;
  } catch (e) {
    console.error('[Android] ensureAndroidPermissionAndScan failed:', e);
    return null;
  }
}

export async function scanAndroidMedia(): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  try {
    console.error('[Android] scanAndroidMedia: invoking android_scan_folders...');
    const folders = await invoke<Array<{ id: number; name: string; path: string; image_count: number }>>('android_scan_folders');
    console.error('[Android] scanAndroidMedia: got', folders.length, 'folders');
    console.error('[Android] scanAndroidMedia: invoking android_scan_images...');
    const images = await invoke<Array<{ id: number; path: string; content_uri: string; name: string; size: number; width: number | null; height: number | null; date_modified: number; mime_type: string }>>('android_scan_images');
    console.error('[Android] scanAndroidMedia: got', images.length, 'images');

    const files: Record<string, any> = {};
    const roots: string[] = [];

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
      };
      roots.push(folderId);
    }

    const folderMap = new Map<string, string>();
    for (const folder of folders) {
      if (folder.path) {
        folderMap.set(folder.path, generateId(folder.path || `folder_${folder.id}`));
      }
    }

    let matchedCount = 0;
    let unmatchedCount = 0;
    let firstUnmatchedDirs: string[] = [];

    for (const img of images) {
      const fileId = generateId(img.path);
      const parentDir = img.path.substring(0, img.path.lastIndexOf('/'));
      const parentId = folderMap.get(parentDir);

      if (parentId) {
        matchedCount++;
      } else {
        unmatchedCount++;
        if (firstUnmatchedDirs.length < 5) {
          firstUnmatchedDirs.push(parentDir);
        }
      }

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

    console.error('[Android] Image-folder matching: matched=', matchedCount, 'unmatched=', unmatchedCount, 'firstUnmatchedDirs=', firstUnmatchedDirs);

    const foldersWithChildren = roots.filter(id => files[id]?.children?.length > 0).length;
    console.error('[Android] Folders with children:', foldersWithChildren, 'out of', roots.length);
    if (folders.length > 0) {
      const sampleFolder = folders[0];
      const sampleFolderId = generateId(sampleFolder.path || `folder_${sampleFolder.id}`);
      console.error('[Android] Sample folder: path=', sampleFolder.path, 'id=', sampleFolderId, 'children=', files[sampleFolderId]?.children?.length);
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

    console.error('[Android] scanAndroidMedia: returning', Object.keys(files).length, 'files,', roots.length, 'roots');
    return (roots.length > 0 && Object.keys(files).length > 0) ? { files, roots } : null;
  } catch (e) {
    console.error('[Android] scanAndroidMedia failed:', e);
    return null;
  }
}

initAndroidPermissionListener();
