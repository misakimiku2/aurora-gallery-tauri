import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { _isAndroid } from './state';

export async function setAndroidStatusBar(isDark: boolean): Promise<void> {
  if (!_isAndroid) return;
  try {
    await invoke('set_android_status_bar', { isDark });
  } catch (e) {
    console.warn('Failed to set Android status bar style:', e);
  }
}

export async function setAndroidImmersiveMode(immersive: boolean): Promise<void> {
  if (!_isAndroid) return;
  try {
    await invoke('set_android_immersive_mode', { immersive });
  } catch (e) {
    console.warn('Failed to set Android immersive mode:', e);
  }
}

export async function androidShareImage(imagePath: string): Promise<void> {
  if (!_isAndroid) return;
  try {
    await invoke('android_share_image', { imagePath });
  } catch (e) {
    console.warn('Failed to share image:', e);
  }
}

export async function androidShareImages(imagePaths: string[]): Promise<void> {
  if (!_isAndroid) return;
  try {
    await invoke('android_share_images', { imagePaths });
  } catch (e) {
    console.warn('Failed to share images:', e);
  }
}

export async function androidCheckStorageManager(): Promise<boolean> {
  if (!_isAndroid) return true;
  try {
    return await invoke('android_check_storage_manager') as boolean;
  } catch (e) {
    console.warn('Failed to check storage manager:', e);
    return false;
  }
}

export async function androidRequestAllFilesAccess(): Promise<void> {
  if (!_isAndroid) return;
  try {
    await invoke('android_request_all_files_access');
  } catch (e) {
    console.warn('Failed to request all files access:', e);
  }
}

/**
 * 获取文件的资源 URL (用于直接在 img 标签中显示本地文件)
 * @param filePath 文件路径
 * @param contentUri Android 端的 content URI（可选，优先使用）
 * @returns 资源 URL
 */
export const getAssetUrl = (filePath: string, contentUri?: string): string => {
  if (contentUri && contentUri.startsWith('content://')) {
    return convertFileSrc(contentUri);
  }
  return convertFileSrc(filePath);
};
