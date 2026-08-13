import { invoke } from '@tauri-apps/api/core';
import { DominantColor } from '../../types';
import { _globalCacheRoot, isAndroidPlatformCached } from './state';

/**
 * 从图片文件中提取多个主色调
 * @param filePath 图片文件路径
 * @param count 要提取的颜色数量
 * @param thumbnailPath 可选的缩略图路径，如果提供则使用缩略图进行提取
 * @returns 主色调数组，如果失败则返回空数组
 */
export const getDominantColors = async (filePath: string, count: number = 8, thumbnailPath?: string): Promise<DominantColor[]> => {
  // LAN 图片存在于远程服务器，本地文件系统无法访问 lan:// 路径。
  // 不加判断会触发 Kotlin/Rust 后端的文件访问，产生 "File not found" /
  // "No such file or directory" 红色错误日志。
  if (filePath.startsWith('lan://')) {
    return [];
  }
  if (isAndroidPlatformCached()) {
    try {
      const cacheRoot = _globalCacheRoot || '';
      if (!cacheRoot) return [];
      const result = await invoke('android_get_dominant_colors', { filePath, count, cacheRoot });
      return result as DominantColor[];
    } catch (error) {
      console.error('Failed to get dominant colors (Android):', error);
      return [];
    }
  }
  try {
    if (filePath.toLowerCase().endsWith('.avif') && !thumbnailPath) {
      const cachedPath = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__?.get(filePath);
      if (cachedPath) {
        thumbnailPath = cachedPath;
      }
    }

    const result = await invoke('get_dominant_colors', { filePath, count, thumbnailPath });
    return result as DominantColor[];
  } catch (error) {
    console.error('Failed to get dominant colors:', error);
    return [];
  }
};

export const batchGetColors = async (filePaths: string[]): Promise<Record<string, string[]>> => {
  if (filePaths.length === 0) return {};
  try {
    const result = await invoke<Record<string, string[]>>('batch_get_colors', { filePaths });
    return result;
  } catch (error) {
    console.error('Failed to batch get colors:', error);
    return {};
  }
};


/**
 * 暂停主色调提取后台任务
 * @returns 是否成功暂停
 */
export const pauseColorExtraction = async (): Promise<boolean> => {
  if (isAndroidPlatformCached()) {
    try {
      return await invoke<boolean>('android_pause_color_extraction');
    } catch (error) {
      console.error('Failed to pause color extraction (Android):', error);
      return false;
    }
  }
  try {
    const result = await invoke<boolean>('pause_color_extraction');
    return result;
  } catch (error) {
    console.error('Failed to pause color extraction:', error);
    return false;
  }
};

/**
 * 恢复主色调提取后台任务
 * @returns 是否成功恢复
 */
export const resumeColorExtraction = async (): Promise<boolean> => {
  if (isAndroidPlatformCached()) {
    try {
      return await invoke<boolean>('android_resume_color_extraction');
    } catch (error) {
      console.error('Failed to resume color extraction (Android):', error);
      return false;
    }
  }
  try {
    const result = await invoke<boolean>('resume_color_extraction');
    return result;
  } catch (error) {
    console.error('Failed to resume color extraction:', error);
    return false;
  }
};

export const cancelColorExtraction = async (): Promise<boolean> => {
  if (isAndroidPlatformCached()) {
    try {
      return await invoke<boolean>('android_cancel_color_extraction');
    } catch (error) {
      console.error('Failed to cancel color extraction (Android):', error);
      return false;
    }
  }
  return true;
};

/**
 * 彻底停止主色调提取（桌面端）：终止 worker 并丢弃其内存任务队列。
 * 用于切换资源根目录、手动"停止"按钮等场景。
 */
export const shutdownColorExtraction = async (): Promise<boolean> => {
  if (isAndroidPlatformCached()) {
    // Android 使用独立的取消机制
    return cancelColorExtraction();
  }
  try {
    const result = await invoke<boolean>('shutdown_color_extraction');
    return result;
  } catch (error) {
    console.error('Failed to shutdown color extraction:', error);
    return false;
  }
};

/**
 * 批量添加文件到 pending 表（用于首次扫描）
 * @param filePaths 文件路径列表
 * @returns 实际添加的文件数量
 */
export const addPendingFilesToDb = async (filePaths: string[]): Promise<number> => {
  try {
    const result = await invoke<number>('add_pending_files_to_db', { filePaths });
    return result;
  } catch (error) {
    console.error('Failed to add pending files to database:', error);
    return 0;
  }
};

export const androidBatchExtractColors = async (filePaths: string[], cacheRoot: string): Promise<number> => {
  if (!isAndroidPlatformCached()) return 0;
  try {
    const result = await invoke<number>('android_batch_extract_colors', { filePaths, cacheRoot });
    return result;
  } catch (error) {
    console.error('Failed to batch extract colors (Android):', error);
    return 0;
  }
};

export const androidShowTaskNotification = async (title: string, current: number, total: number): Promise<void> => {
  if (!isAndroidPlatformCached()) return;
  try {
    await invoke('android_show_task_notification', { title, current, total });
  } catch (error) {
    console.error('Failed to show task notification (Android):', error);
  }
};

export const androidUpdateTaskNotification = async (current: number, total: number, isPaused: boolean): Promise<void> => {
  if (!isAndroidPlatformCached()) return;
  try {
    await invoke('android_update_task_notification', { current, total, isPaused });
  } catch (error) {
    console.error('Failed to update task notification (Android):', error);
  }
};

export const androidHideTaskNotification = async (): Promise<void> => {
  if (!isAndroidPlatformCached()) return;
  try {
    await invoke('android_hide_task_notification');
  } catch (error) {
    console.error('Failed to hide task notification (Android):', error);
  }
};

export const androidGetCacheSize = async (cacheRoot: string): Promise<number> => {
  if (!isAndroidPlatformCached()) return 0;
  try {
    const result = await invoke<number>('android_get_cache_size', { cacheRoot });
    return result;
  } catch (error) {
    console.error('Failed to get cache size (Android):', error);
    return 0;
  }
};

export const androidClearThumbnailCache = async (cacheRoot: string): Promise<number> => {
  if (!isAndroidPlatformCached()) return 0;
  try {
    const result = await invoke<number>('android_clear_thumbnail_cache', { cacheRoot });
    return result;
  } catch (error) {
    console.error('Failed to clear thumbnail cache (Android):', error);
    return 0;
  }
};
