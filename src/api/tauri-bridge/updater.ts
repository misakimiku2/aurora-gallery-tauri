import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '../../utils/environment';
import { isAndroidPlatformCached } from './state';

// ==========================================
// Update Checker APIs
// ==========================================

export interface UpdateCheckResult {
  has_update: boolean;
  current_version: string;
  latest_version: string;
  download_url: string;
  installer_url?: string;
  installer_size?: number;
  release_name: string;
  release_notes: string;
  published_at: string;
}

export interface DownloadProgressResult {
  state: string;
  progress: number;
  downloaded_bytes: number;
  total_bytes: number;
  speed_bytes_per_sec: number;
  file_path: string;
  error_message?: string;
}

/**
 * 检查应用更新
 * @returns 更新检查结果
 */
export const checkForUpdates = async (): Promise<UpdateCheckResult | null> => {
  if (!isTauriEnvironment()) return null;
  if (isAndroidPlatformCached()) return null;
  try {
    const result = await invoke<UpdateCheckResult>('check_for_updates_command');
    return result;
  } catch (error) {
    console.error('Failed to check for updates:', error);
    return null;
  }
};

/**
 * 使用系统默认浏览器打开外部链接
 * @param url 要打开的链接
 */
export const openExternalLink = async (url: string): Promise<void> => {
  if (!isTauriEnvironment()) {
    window.open(url, '_blank');
    return;
  }
  try {
    await invoke('open_external_link', { url });
  } catch (error) {
    console.error('Failed to open external link:', error);
    // 后备方案：使用浏览器打开
    window.open(url, '_blank');
  }
};

/**
 * 开始下载更新
 * @param installerUrl 安装程序下载链接
 * @param version 版本号
 */
export const startUpdateDownload = async (installerUrl: string, version: string): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('start_update_download', { installerUrl, version });
  } catch (error) {
    console.error('Failed to start update download:', error);
    throw error;
  }
};

/**
 * 暂停下载更新
 */
export const pauseUpdateDownload = async (): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('pause_update_download');
  } catch (error) {
    console.error('Failed to pause update download:', error);
    throw error;
  }
};

/**
 * 继续下载更新
 */
export const resumeUpdateDownload = async (): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('resume_update_download');
  } catch (error) {
    console.error('Failed to resume update download:', error);
    throw error;
  }
};

/**
 * 取消下载更新
 */
export const cancelUpdateDownload = async (): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('cancel_update_download');
  } catch (error) {
    console.error('Failed to cancel update download:', error);
    throw error;
  }
};

/**
 * 获取下载进度
 * @returns 下载进度信息
 */
export const getUpdateDownloadProgress = async (): Promise<DownloadProgressResult | null> => {
  if (!isTauriEnvironment()) return null;
  if (isAndroidPlatformCached()) return null;
  try {
    const result = await invoke<DownloadProgressResult>('get_update_download_progress');
    return result;
  } catch (error) {
    console.error('Failed to get download progress:', error);
    return null;
  }
};

/**
 * 安装更新（运行安装程序）
 */
export const installUpdate = async (): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('install_update');
  } catch (error) {
    console.error('Failed to install update:', error);
    throw error;
  }
};

/**
 * 打开下载文件夹
 */
export const openUpdateDownloadFolder = async (): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('open_update_download_folder');
  } catch (error) {
    console.error('Failed to open download folder:', error);
    throw error;
  }
};
