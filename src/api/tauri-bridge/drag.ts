import { invoke } from '@tauri-apps/api/core';
import { startDrag as tauriStartDrag } from '@crabnebula/tauri-plugin-drag';
import { isTauriEnvironment } from '../../utils/environment';

/**
 * 生成拖拽预览图（用于外部拖拽时显示）
 * @param thumbnailPaths 缩略图路径数组（最多3个）
 * @param totalCount 总文件数
 * @param cacheRoot 缓存目录
 * @returns 预览图文件路径
 */
export const generateDragPreview = async (
  thumbnailPaths: string[],
  totalCount: number,
  cacheRoot: string
): Promise<string | null> => {
  try {
    const result = await invoke<string | null>('generate_drag_preview', {
      thumbnailPaths,
      totalCount,
      cacheRoot,
    });
    return result;
  } catch (error) {
    console.error('Failed to generate drag preview:', error);
    return null;
  }
};

/**
 * 启动从应用拖拽文件到外部的操作
 * 这个函数需要在 mousedown 事件中调用（不是 dragstart）
 * 因为 tauri-plugin-drag 会接管整个拖拽过程
 * 
 * 使用方法：按住 Alt 键并拖拽文件，可以将文件复制到外部应用（如文件管理器、聊天软件等）
 * 
 * @param filePaths 要拖拽的文件路径数组
 * @param thumbnailPaths 缩略图路径数组（用于生成预览图）
 * @param cacheRoot 缓存目录
 * @param onDragEnd 拖拽结束后的回调（可选）
 * @returns Promise<void>
 */
export const startDragToExternal = async (
  filePaths: string[],
  thumbnailPaths?: string[],
  cacheRoot?: string,
  onDragEnd?: () => void
): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }

  if (!filePaths || filePaths.length === 0) {
    return;
  }

  try {
    let finalIconPath: string | undefined;

    // 如果提供了缩略图路径和缓存目录，生成组合预览图
    if (thumbnailPaths && thumbnailPaths.length > 0 && cacheRoot) {
      // 过滤掉空路径
      const validPaths = thumbnailPaths.filter(p => p && p.trim() !== '');
      if (validPaths.length > 0) {
        finalIconPath = await generateDragPreview(validPaths, filePaths.length, cacheRoot) || undefined;
      }
    }

    // 如果没有生成预览图，尝试从缩略图缓存获取单个缩略图
    if (!finalIconPath) {
      const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
      if (pathCache && pathCache.get) {
        const cachedPath = pathCache.get(filePaths[0]);
        if (cachedPath) {
          finalIconPath = cachedPath;
        }
      }
    }

    // 如果还是没有缩略图，使用原始文件（仅对图片）
    if (!finalIconPath) {
      const firstFilePath = filePaths[0];
      const isImage = /\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(firstFilePath);
      if (isImage) {
        finalIconPath = firstFilePath;
      }
    }

    // 调用 tauri-plugin-drag 的 startDrag
    // item 是文件路径数组，icon 是预览图标路径
    await tauriStartDrag(
      {
        item: filePaths,
        icon: finalIconPath || filePaths[0], // 使用组合预览图或第一个文件作为图标
        mode: 'copy', // 复制模式
      },
      () => {
        // 拖拽结束后调用回调
        if (onDragEnd) {
          onDragEnd();
        }
      }
    );
  } catch (error) {
    // 拖拽失败也要调用回调
    if (onDragEnd) {
      onDragEnd();
    }
  }
};
