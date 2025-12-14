import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { FileNode, FileType } from '../types';

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
    
    // 找到根目录节点（parentId 为 null 的节点）
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
        url: node.url || undefined,
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
      
      // 如果是根目录（parentId 为 null），添加到 roots
      if (!fileNode.parentId) {
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

