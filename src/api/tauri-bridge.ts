import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
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

/**
 * 获取图片缩略图
 * @param filePath 图片文件路径
 * @param modified 文件修改时间（可选，用于缓存）
 * @param rootPath 资源根目录路径（可选，用于计算缓存目录）
 * @returns Base64 编码的缩略图数据 URL，如果失败则返回 null
 */
export const getThumbnail = async (filePath: string, modified?: string, rootPath?: string): Promise<string | null> => {
  try {
    // 验证 filePath 参数
    if (!filePath || filePath.trim() === '') {
      console.error('getThumbnail: filePath is empty or invalid');
      return null;
    }
    
    // 验证 rootPath 参数
    if (!rootPath || rootPath.trim() === '') {
      console.error('getThumbnail: rootPath is empty or invalid');
      return null;
    }
    
    // 计算缓存目录路径
    const cachePath = `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
    
    // 调用 Rust 的 get_thumbnail 命令
    const thumbnailPath = await invoke<string | null>('get_thumbnail', { 
      filePath, 
      cacheRoot: cachePath 
    });
    
    // 如果返回了缩略图路径，读取文件并转换为 Base64
    if (thumbnailPath) {
      // 使用现有的 readFileAsBase64 函数读取缩略图
      return await readFileAsBase64(thumbnailPath);
    }
    
    return null;
  } catch (error) {
    console.error('Failed to get thumbnail:', error);
    return null;
  }
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
 * 打开指定路径的文件夹
 * @param path 要打开的文件夹路径
 */
export const openPath = async (path: string): Promise<void> => {
  try {
    await invoke('open_path', { path });
  } catch (error) {
    console.error('Failed to open path:', error);
  }
};

