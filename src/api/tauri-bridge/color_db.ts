import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '../../utils/environment';

// ==========================================
// Color Database Management APIs
// ==========================================

export interface ColorDbStats {
  total: number;
  extracted: number;
  error: number;
  pending: number;
  processing: number;
  dbSize: number;
  walSize: number;
}

export interface ColorDbErrorFile {
  path: string;
  timestamp: number;
}

/**
 * 获取主色调数据库统计信息
 * @returns 数据库统计信息
 */
export const cleanupStaleColorRecords = async (): Promise<number> => {
  if (!isTauriEnvironment()) return 0;
  try {
    const result = await invoke<number>('cleanup_stale_color_records');
    return result;
  } catch (e) {
    console.error('Failed to cleanup stale color records:', e);
    return 0;
  }
};

export const getColorDbStats = async (): Promise<ColorDbStats | null> => {
  if (!isTauriEnvironment()) return null;
  try {
    const result = await invoke<ColorDbStats>('get_color_db_stats');
    return result;
  } catch (error) {
    console.error('Failed to get color db stats:', error);
    return null;
  }
};

/**
 * 获取错误文件列表
 * @returns 错误文件列表
 */
export const getColorDbErrorFiles = async (): Promise<ColorDbErrorFile[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    const result = await invoke<ColorDbErrorFile[]>('get_color_db_error_files');
    return result;
  } catch (error) {
    console.error('Failed to get color db error files:', error);
    return [];
  }
};

/**
 * 重新处理错误文件
 * @param filePaths 要重新处理的文件路径列表，如果为 null 则处理所有错误文件
 * @returns 成功重置的文件数量
 */
export const retryColorExtraction = async (filePaths?: string[]): Promise<number> => {
  if (!isTauriEnvironment()) return 0;
  try {
    const result = await invoke<number>('retry_color_extraction', { filePaths: filePaths || null });
    return result;
  } catch (error) {
    console.error('Failed to retry color extraction:', error);
    return 0;
  }
};

/**
 * 从数据库中删除错误文件记录
 * @param filePaths 要删除的文件路径列表
 * @returns 成功删除的记录数量
 */
export const deleteColorDbErrorFiles = async (filePaths: string[]): Promise<number> => {
  if (!isTauriEnvironment()) return 0;
  try {
    const result = await invoke<number>('delete_color_db_error_files', { filePaths });
    return result;
  } catch (error) {
    console.error('Failed to delete color db error files:', error);
    return 0;
  }
};
