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
    }, 10000);
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

    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
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

    for (let i = 0; i < 5; i++) {
      await new Promise(r => setTimeout(r, 1000));
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

export async function scanAndroidFolders(): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  try {
    const folders = await invoke<Array<{
      id: number;
      name: string;
      path: string;
      image_count: number;
      cover_image_path: string | null;
      cover_image_id: number | null;
    }>>('android_scan_folders');

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
        imageCount: folder.image_count,
        coverImagePath: folder.cover_image_path || undefined,
        coverImageMediaStoreId: folder.cover_image_id || undefined,
      };
      roots.push(folderId);
    }

    return (roots.length > 0) ? { files, roots } : null;
  } catch (e) {
    console.error('[Android] scanAndroidFolders failed:', e);
    return null;
  }
}

export async function scanAndroidImages(): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  try {
    const folders = await invoke<Array<{
      id: number;
      name: string;
      path: string;
      image_count: number;
      cover_image_path: string | null;
      cover_image_id: number | null;
    }>>('android_scan_folders');
    const images = await invoke<Array<{
      id: number;
      path: string;
      content_uri: string;
      name: string;
      size: number;
      width: number | null;
      height: number | null;
      date_modified: number;
      mime_type: string;
    }>>('android_scan_images');

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
        imageCount: folder.image_count,
        coverImagePath: folder.cover_image_path || undefined,
        coverImageMediaStoreId: folder.cover_image_id || undefined,
      };
      roots.push(folderId);
    }

    const folderMap = new Map<string, string>();
    for (const folder of folders) {
      if (folder.path) {
        folderMap.set(folder.path, generateId(folder.path || `folder_${folder.id}`));
      }
    }

    for (const img of images) {
      const fileId = generateId(img.path);
      const parentDir = img.path.substring(0, img.path.lastIndexOf('/'));
      const parentId = folderMap.get(parentDir);

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

    return (roots.length > 0 && Object.keys(files).length > 0) ? { files, roots } : null;
  } catch (e) {
    console.error('[Android] scanAndroidImages failed:', e);
    return null;
  }
}

export async function scanAndroidMedia(): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  return scanAndroidImages();
}

initAndroidPermissionListener();
