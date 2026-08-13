import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '../../utils/environment';

/**
 * 搜索指定色彩氛围的图片 (Search by Palette)
 * @param palette Hex 颜色数组
 * @returns 图片文件路径列表 (按相似度排序)
 */
export const searchByPalette = async (palette: string[]): Promise<string[]> => {
  if (!isTauriEnvironment()) {
    return Promise.resolve([]); // 浏览器环境不支持
  }

  try {
    const results = await invoke('search_by_palette', { targetPalette: palette });
    if (Array.isArray(results) && results.every(item => typeof item === 'string')) {
      return results as string[];
    }
    return [];
  } catch (error) {
    console.error('Failed to search by palette:', error);
    return [];
  }
};

/**
 * 搜索单色图片 (Search by Color)
 * @param color Hex 颜色 string
 * @returns 图片文件路径列表 (按相似度排序)
 */
export const searchByColor = async (color: string): Promise<string[]> => {
  if (!isTauriEnvironment()) {
    return Promise.resolve([]);
  }

  try {
    const results = await invoke('search_by_color', { color });
    if (Array.isArray(results) && results.every(item => typeof item === 'string')) {
      return results as string[];
    }
    return [];
  } catch (error) {
    console.error('Failed to search by color:', error);
    return [];
  }
};
