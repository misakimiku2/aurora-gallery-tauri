import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { Channel } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { startDrag as tauriStartDrag } from '@crabnebula/tauri-plugin-drag';
import { FileNode, FileType } from '../types';
import { isTauriEnvironment } from '../utils/environment';

/**
 * 获取文件的资源 URL (用于直接在 img 标签中显示本地文件)
 * @param filePath 文件路径
 * @returns 资源 URL
 */
export const getAssetUrl = (filePath: string): string => {
  return convertFileSrc(filePath);
};

/**
 * Tauri API Bridge
 * 提供与 Rust 后端通信的接口
 */

// Rust 返回的 FileNode 类型（类型枚举是字符串，使用 camelCase）
interface RustFileNode {
  id: string;
  parentId: string | null;
  name: string;
  type: 'image' | 'folder' | 'unknown';  // camelCase 序列化
  path: string;
  size?: number;
  children?: string[] | null;
  tags: string[];
  createdAt?: string | null;
  updatedAt?: string | null;
  url?: string | null;
  meta?: {
    width: number;
    height: number;
    sizeKb: number;
    created: string;
    modified: string;
    format: string;
  } | null;
}

/**
 * 扫描目录并返回文件列表
 * @param path 目录路径
 * @param forceRefresh 是否强制刷新（暂时未使用，保留以兼容现有代码）
 * @returns 包含 roots 和 files 的对象
 */
export const scanDirectory = async (
  path: string,
  forceRefresh?: boolean
): Promise<{ roots: string[]; files: Record<string, FileNode> }> => {
  try {
    // 调用 Rust 的 scan_directory 命令
    const rustFiles = await invoke<Record<string, RustFileNode>>('scan_directory', { path });
    
    // 找到根目录节点（parentId 为 null 且类型为目录的节点）
    const rootIds: string[] = [];
    const fileMap: Record<string, FileNode> = {};
    
    // 转换 Rust 返回的数据格式
    Object.entries(rustFiles).forEach(([id, node]) => {
        // 转换类型枚举（注意：Rust 使用 camelCase 序列化，所以是 'image', 'folder', 'unknown'）
        let fileType: FileType = FileType.UNKNOWN;
        if (node.type === 'image') {
            fileType = FileType.IMAGE;
        } else if (node.type === 'folder') {
            fileType = FileType.FOLDER;
        }
        
        // Note: In Tauri, node.url is a file path, not a usable URL
        // We should not use it directly as an image src to avoid thumbnail:// protocol errors
        
        const fileNode: FileNode = {
            id: node.id,
            parentId: node.parentId || null,
            name: node.name,
            type: fileType,
            path: node.path,
            size: node.size,
            children: node.children && node.children.length > 0 ? node.children : undefined,
            tags: node.tags || [],
            createdAt: node.createdAt || undefined,
            updatedAt: node.updatedAt || undefined,
            // In Tauri, url is a file path, not a usable URL. Set to undefined to prevent misuse.
            url: undefined, // Don't use file path as URL - use getThumbnail() instead
            meta: node.meta ? {
                width: node.meta.width || 0,
                height: node.meta.height || 0,
                sizeKb: node.meta.sizeKb || 0,
                created: node.meta.created,
                modified: node.meta.modified,
                format: node.meta.format,
            } : undefined,
        };
        
        fileMap[id] = fileNode;
        
        // 如果是根目录（parentId 为 null）且类型为目录，添加到 roots
        if (!fileNode.parentId && fileNode.type === FileType.FOLDER) {
            rootIds.push(id);
        }
    });
    
    
    return {
      roots: rootIds,
      files: fileMap,
    };
  } catch (error) {
    console.error('Failed to scan directory:', error);
    throw error;
  }
};

/**
 * 打开文件夹选择对话框
 * @returns 选择的文件夹路径，如果取消则返回 null
 */


export const openDirectory = async (): Promise<string | null> => {
  try {
    const selected = await open({
      directory: true,
      multiple: false,
      title: '选择文件夹',
    });
    
    if (selected && typeof selected === 'string') {
      return selected;
    }
    
    return null;
  } catch (error) {
    console.error('Failed to open directory dialog:', error);
    return null;
  }
};

// 批量请求管理器
class ThumbnailBatcher {
    private batch: Map<string, {
        resolve: (value: string | null) => void;
        reject: (reason?: any) => void;
        cacheRoot: string;
    }> = new Map();
    private timeoutId: ReturnType<typeof setTimeout> | null = null;
    private readonly BATCH_DELAY = 50; // 50ms 聚合时间

    add(filePath: string, cacheRoot: string): Promise<string | null> {
        return new Promise((resolve, reject) => {
            // 如果已经在队列中，暂不处理覆盖，假设相同请求会得到相同结果
            if (this.batch.has(filePath)) {
               // 可选：将新请求关联到旧请求的 Promise，但这里简化处理
            }
            
            this.batch.set(filePath, { resolve, reject, cacheRoot });

            if (!this.timeoutId) {
                this.timeoutId = setTimeout(() => this.processBatch(), this.BATCH_DELAY);
            }
        });
    }

    private async processBatch() {
        this.timeoutId = null;
        if (this.batch.size === 0) return;

        // 取出所有待处理项
        const currentBatch = new Map(this.batch);
        this.batch.clear();

        try {
            // 按照 cacheRoot 分组
            const batchesByRoot: Record<string, string[]> = {};
            
            for (const [path, item] of currentBatch.entries()) {
                if (!batchesByRoot[item.cacheRoot]) {
                    batchesByRoot[item.cacheRoot] = [];
                }
                batchesByRoot[item.cacheRoot].push(path);
            }

            // 并行发送所有分组的批量请求
            await Promise.all(Object.entries(batchesByRoot).map(async ([cacheRoot, paths]) => {
                try {
                    // 创建通道
                    const channel = new Channel<{ path: string; url: string | null }>();
                    
                    // 监听通道消息 (流式结果！)
                    channel.onmessage = ({ path, url }) => {
                        const item = currentBatch.get(path);
                        if (item) {
                            if (url) {
                                // 同时缓存原始路径（用于外部拖拽时作为图标）
                                const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
                                if (pathCache && typeof pathCache.set === 'function') {
                                    pathCache.set(path, url);
                                }
                                item.resolve(convertFileSrc(url));
                            } else {
                                item.resolve(null);
                            }
                        }
                    };

                    // 调用 Rust 的流式批量接口
                    await invoke('get_thumbnails_batch', {
                        filePaths: paths,
                        cacheRoot: cacheRoot,
                        onEvent: channel // 传递通道
                    });
                } catch (err) {
                    console.error('Batch processing failed:', err);
                    // 局部失败
                    paths.forEach(path => {
                        const item = currentBatch.get(path);
                        if (item) item.resolve(null);
                    });
                }
            }));
            
        } catch (error) {
            console.error('Global batch error:', error);
            // 全局失败
            for (const item of currentBatch.values()) {
                item.resolve(null);
            }
        }
    }
}

const thumbnailBatcher = new ThumbnailBatcher();

/**
 * 获取图片缩略图
 * @param filePath 图片文件路径
 * @param modified 文件修改时间（可选，用于缓存）
 * @param rootPath 资源根目录路径（可选，用于计算缓存目录）
 * @param signal AbortSignal (可选，用于取消请求)
 * @returns 缩略图 Asset URL，如果失败则返回 null
 */
export const getThumbnail = async (filePath: string, modified?: string, rootPath?: string, signal?: AbortSignal): Promise<string | null> => {
    // 验证参数
    if (!filePath || filePath.trim() === '') return null;
    if (!rootPath || rootPath.trim() === '') return null;

    // 计算缓存目录路径
    const cachePath = `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;

    // 使用批量处理器
    return thumbnailBatcher.add(filePath, cachePath);
};

/**
 * 读取完整图片文件并转换为 Base64 数据 URL
 * @param filePath 图片文件路径
 * @returns Base64 编码的完整图片数据 URL，如果失败则返回 null
 */
export const readFileAsBase64 = async (filePath: string): Promise<string | null> => {
  try {
    // 验证 filePath 参数
    if (!filePath || filePath.trim() === '') {
      console.error('readFileAsBase64: filePath is empty or invalid');
      return null;
    }
    
    // Tauri 2.0 会自动将 TypeScript 的 camelCase (filePath) 转换为 Rust 的 snake_case (file_path)
    const dataUrl = await invoke<string | null>('read_file_as_base64', { filePath });
    return dataUrl;
  } catch (error) {
    console.error('Failed to read file as base64:', error);
    return null;
  }
};

/**
 * 确保目录存在
 * @param path 目录路径
 */
export const ensureDirectory = async (path: string): Promise<void> => {
  try {
    await invoke('ensure_directory', { path });
  } catch (error) {
    console.error('Failed to ensure directory:', error);
    // 不抛出错误
  }
};

// Deprecated: use ensureDirectory instead
export const ensureCacheDirectory = async (rootPath: string): Promise<void> => {
    // Adapter to new function logic if needed, or just keep as is but utilizing new rust command if logic matches
    // But since we changed rust command name, we must update this or just replace usage.
    // Let's replace usage in App.tsx mainly.
    // But for safety, let's make this function call ensureDirectory with the appended path
    const path = rootPath.endsWith('.Aurora_Cache') || rootPath.endsWith('.Aurora_Cache\\') || rootPath.endsWith('.Aurora_Cache/')
        ? rootPath 
        : `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
    return ensureDirectory(path);
};

/**
 * 保存用户数据到持久化存储
 * @param data 要保存的用户数据（JSON 对象）
 * @returns 是否保存成功
 */
export const saveUserData = async (data: any): Promise<boolean> => {
  try {
    const result = await invoke<boolean>('save_user_data', { data });
    return result;
  } catch (error) {
    console.error('Failed to save user data:', error);
    return false;
  }
};

/**
 * 从持久化存储加载用户数据
 * @returns 用户数据，如果不存在则返回 null
 */
export const loadUserData = async (): Promise<any | null> => {
  try {
    const result = await invoke<any | null>('load_user_data');
    return result;
  } catch (error) {
    console.error('Failed to load user data:', error);
    return null;
  }
};

/**
 * 获取默认路径配置
 * @returns 包含默认路径的对象
 */
export const getDefaultPaths = async (): Promise<Record<string, string>> => {
  try {
    const result = await invoke<Record<string, string>>('get_default_paths');
    return result;
  } catch (error) {
    console.error('Failed to get default paths:', error);
    return {};
  }
};

/**
 * 打开指定路径的文件夹或文件
 * @param path 要打开的路径
 * @param isFile 是否为文件（可选，如果未提供则根据路径判断）
 */
export const openPath = async (path: string, isFile?: boolean): Promise<void> => {
  try {
    console.log('tauri-bridge.openPath called:', { path, isFile });
    await invoke('open_path', { path, isFile });
  } catch (error) {
    console.error('Failed to open path:', error, { path, isFile });
    throw error;
  }
};

/**
 * 创建新文件夹
 * @param path 要创建的文件夹路径
 */
export const createFolder = async (path: string): Promise<void> => {
  try {
    await invoke('create_folder', { path });
  } catch (error) {
    console.error('Failed to create folder:', error);
    throw error;
  }
};

/**
 * 重命名文件或文件夹
 * @param oldPath 旧路径
 * @param newPath 新路径
 */
export const renameFile = async (oldPath: string, newPath: string): Promise<void> => {
  try {
    await invoke('rename_file', { oldPath, newPath });
  } catch (error) {
    console.error('Failed to rename file:', error);
    throw error;
  }
};

/**
 * 删除文件或文件夹
 * @param path 要删除的文件或文件夹路径
 */
export const deleteFile = async (path: string): Promise<void> => {
  try {
    await invoke('delete_file', { path });
  } catch (error) {
    console.error('Failed to delete file:', error);
    throw error;
  }
};

/**
 * 复制文件
 * @param srcPath 源文件路径
 * @param destPath 目标文件路径
 */
export const copyFile = async (srcPath: string, destPath: string): Promise<void> => {
  try {
    await invoke('copy_file', { srcPath, destPath });
  } catch (error) {
    console.error('Failed to copy file:', error);
    throw error;
  }
};

/**
 * 移动文件
 * @param srcPath 源文件路径
 * @param destPath 目标文件路径
 */
export const moveFile = async (srcPath: string, destPath: string): Promise<void> => {
  try {
    await invoke('move_file', { srcPath, destPath });
  } catch (error) {
    console.error('Failed to move file:', error);
    throw error;
  }
};

/**
 * 从字节数组写入文件
 * @param filePath 目标文件路径
 * @param bytes 文件内容的字节数组
 */
export const writeFileFromBytes = async (filePath: string, bytes: Uint8Array): Promise<void> => {
  try {
    await invoke('write_file_from_bytes', { filePath, bytes: Array.from(bytes) });
  } catch (error) {
    console.error('Failed to write file:', error);
    throw error;
  }
};

/**
 * 扫描单个文件并返回文件节点
 * @param filePath 文件路径
 * @param parentId 父文件夹ID（可选）
 * @returns 文件节点
 */
export const scanFile = async (filePath: string, parentId?: string | null): Promise<FileNode> => {
  try {
    const rustFile = await invoke<RustFileNode>('scan_file', { filePath, parentId: parentId || null });
    
    // Convert Rust FileNode to TypeScript FileNode
    return {
      id: rustFile.id,
      parentId: rustFile.parentId,
      name: rustFile.name,
      type: rustFile.type === 'image' ? FileType.IMAGE : rustFile.type === 'folder' ? FileType.FOLDER : FileType.UNKNOWN,
      path: rustFile.path,
      size: rustFile.size,
      children: rustFile.children || undefined,
      tags: rustFile.tags,
      createdAt: rustFile.createdAt || undefined,
      updatedAt: rustFile.updatedAt || undefined,
      url: rustFile.url || undefined,
      meta: rustFile.meta ? {
        width: rustFile.meta.width,
        height: rustFile.meta.height,
        sizeKb: rustFile.meta.sizeKb,
        created: rustFile.meta.created,
        modified: rustFile.meta.modified,
        format: rustFile.meta.format
      } : undefined
    };
  } catch (error) {
    console.error('Failed to scan file:', error);
    throw error;
  }
};

/**
 * 隐藏主窗口（最小化到托盘）
 */
export const hideWindow = async (): Promise<void> => {
  try {
    await invoke('hide_window');
  } catch (error) {
    console.error('Failed to hide window:', error);
    throw error;
  }
};

/**
 * 显示主窗口
 */
export const showWindow = async (): Promise<void> => {
  try {
    await invoke('show_window');
  } catch (error) {
    console.error('Failed to show window:', error);
    throw error;
  }
};

/**
 * 退出应用程序
 */
export const exitApp = async (): Promise<void> => {
  try {
    // 使用 Rust 后端的 exit_app 命令来正确退出应用
    await invoke('exit_app');
  } catch (error) {
    console.error('Failed to exit app:', error);
    // 如果 Tauri API 不可用，尝试使用 window.close() 作为后备
    if (typeof window !== 'undefined' && window.close) {
      window.close();
    }
  }
};

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
    console.warn('startDragToExternal is only available in Tauri environment');
    return;
  }
  
  if (!filePaths || filePaths.length === 0) {
    console.warn('No files to drag');
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
      if (pathCache && typeof pathCache.get === 'function') {
        finalIconPath = pathCache.get(filePaths[0]);
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
      (result) => {
        console.log('Drag result:', result);
        // 拖拽结束后调用回调
        if (onDragEnd) {
          onDragEnd();
        }
      }
    );
  } catch (error) {
    console.error('Failed to start drag:', error);
    // 拖拽失败也要调用回调
    if (onDragEnd) {
      onDragEnd();
    }
  }
};

