import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FileNode, FileType } from '../../types';

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
    palette?: string[] | null;
  } | null;
  description?: string | null;
  sourceUrl?: string | null;
  category?: string | null;     // <--- ADDED THIS FIELD
  aiData?: any | null;
}

/**
 * 扫描目录并返回文件列表
 * @param path 目录路径
 * @param forceRefresh 是否强制刷新
 * @returns 包含 roots 和 files 的对象
 */
export const scanDirectory = async (
  path: string,
  forceRefresh?: boolean
): Promise<{ roots: string[]; files: Record<string, FileNode> }> => {
  try {
    // 调用 Rust 的 scan_directory 命令
    const rustFiles = await invoke<Record<string, RustFileNode>>('scan_directory', { path, forceRescan: forceRefresh });

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
        // Map persistent fields from backend
        description: node.description || undefined,
        sourceUrl: node.sourceUrl || undefined,
        category: (node.category === 'general' || node.category === 'book' || node.category === 'sequence') ? node.category : undefined,
        aiData: node.aiData || undefined,

        // In Tauri, url is a file path, not a usable URL. Set to undefined to prevent misuse.
        url: undefined, // Don't use file path as URL - use getThumbnail() instead
        // If backend hasn't populated valid dimensions yet, keep `meta` undefined so
        // frontend falls back to optimistic/layout defaults instead of showing 0x0.
        meta: node.meta ? {
          width: node.meta.width || 0,
          height: node.meta.height || 0,
          sizeKb: node.meta.sizeKb || 0,
          created: node.meta.created || '',
          modified: node.meta.modified || '',
          format: node.meta.format || '',
          palette: node.meta.palette || undefined,
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
 * 强制完整扫描（只做了 thin wrapper，以后可以单独实现更细粒度的逻辑）
 * @param path 目录路径
 */
export const forceRescan = async (path: string): Promise<{ roots: string[]; files: Record<string, FileNode> }> => {
  try {
    const rustFiles = await invoke<Record<string, RustFileNode>>('force_rescan', { path });

    const rootIds: string[] = [];
    const fileMap: Record<string, FileNode> = {};

    Object.entries(rustFiles).forEach(([id, node]) => {
      let fileType: FileType = FileType.UNKNOWN;
      if (node.type === 'image') fileType = FileType.IMAGE;
      else if (node.type === 'folder') fileType = FileType.FOLDER;

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
        url: undefined,
        // If backend hasn't populated valid dimensions yet, keep `meta` undefined so
        // frontend falls back to optimistic/layout defaults instead of showing 0x0.
        meta: node.meta ? {
          width: node.meta.width || 0,
          height: node.meta.height || 0,
          sizeKb: node.meta.sizeKb || 0,
          created: node.meta.created || '',
          modified: node.meta.modified || '',
          format: node.meta.format || '',
          palette: node.meta.palette || undefined,
        } : undefined,
        description: node.description || undefined,
        sourceUrl: node.sourceUrl || undefined,
        aiData: node.aiData || undefined,
      };

      fileMap[id] = fileNode;
      if (!fileNode.parentId && fileNode.type === FileType.FOLDER) rootIds.push(id);
    });

    return { roots: rootIds, files: fileMap };
  } catch (error) {
    console.error('Failed to force rescan:', error);
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
    // Defensive: strip large file-level payloads before sending to backend.
    const payload = { ...data };
    if (payload.fileMetadata) {
      // never send whole-file metadata via IPC — it's stored in metadata.db
      delete payload.fileMetadata;
    }
    if (payload.files) {
      delete payload.files;
    }

    const result = await invoke<boolean>('save_user_data', { data: payload });
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
/**
 * 在系统文件管理器中打开路径
 * @param path 要打开的路径
 * @param isFile 是否是文件。如果提供此参数，将在文件管理器中选中该项；如果未提供，则直接打开该路径。
 */
export const openPath = async (path: string, isFile?: boolean): Promise<void> => {
  try {
    await invoke('open_path', { path, isFile });
  } catch (error) {
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

export const deleteAndroidFiles = async (mediaIds: number[]): Promise<{ deleted: number; failed: number; error?: string }> => {
  try {
    const result = await invoke('android_delete_files', { mediaIds: mediaIds.map(Number) });
    return JSON.parse(result as string);
  } catch (error) {
    console.error('Failed to delete Android files:', error);
    throw error;
  }
};

export const clearScanCache = async (appDataDir: string): Promise<void> => {
  try {
    await invoke('android_clear_scan_cache', { appDataDir });
  } catch (error) {
    console.error('Failed to clear scan cache:', error);
  }
};

/**
 * 复制文件 — 返回实际写入的目标路径（Rust 可能在同目录自复制时生成唯一文件名）
 * @param srcPath 源文件路径
 * @param destPath 目标文件路径（请求的）
 * @returns 实际写入的目标路径
 */
export const copyFile = async (srcPath: string, destPath: string): Promise<string> => {
  try {
    const finalPath = await invoke<string>('copy_file', { srcPath, destPath });
    return finalPath;
  } catch (error) {
    console.error('Failed to copy file:', error);
    throw error;
  }
};

/**
 * 复制图片颜色信息
 * @param srcPath 源文件路径
 * @param destPath 目标文件路径
 */
export const copyImageColors = async (srcPath: string, destPath: string): Promise<boolean> => {
  try {
    return await invoke<boolean>('copy_image_colors', { srcPath, destPath });
  } catch (error) {
    console.error('Failed to copy image colors:', error);
    return false;
  }
};

/**
 * 复制图片到剪贴板
 * @param filePath 图片文件路径
 */
export const copyImageToClipboard = async (filePath: string): Promise<void> => {
  try {
    await invoke('copy_image_to_clipboard', { filePath });
  } catch (error) {
    console.error('Failed to copy image to clipboard:', error);
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
        width: rustFile.meta.width || 0,
        height: rustFile.meta.height || 0,
        sizeKb: rustFile.meta.sizeKb || 0,
        created: rustFile.meta.created || '',
        modified: rustFile.meta.modified || '',
        format: rustFile.meta.format || '',
        palette: rustFile.meta.palette || undefined,
      } : undefined,
      description: rustFile.description || undefined,
      sourceUrl: rustFile.sourceUrl || undefined,
      aiData: rustFile.aiData || undefined,
    };
  } catch (error) {
    console.error('Failed to scan file:', error);
    throw error;
  }
};
