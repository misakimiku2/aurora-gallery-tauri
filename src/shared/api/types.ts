import { DominantColor } from '../types/image';

export type { DominantColor };

export type LayoutMode = 'grid' | 'masonry' | 'adaptive';

export type SortOption = 'name' | 'date' | 'size';

export type SortDirection = 'asc' | 'desc';

export type SearchScope = 'all' | 'file' | 'folder';

export interface BrowseItem {
  name: string;
  path: string;
  type: 'folder' | 'image';
  size?: number;
  thumbnail?: string;
  preview_images?: string[];
  width?: number;
  height?: number;
}

export interface BrowseResponse {
  current_path: string;
  folders: BrowseItem[];
  images: BrowseItem[];
  allow_edit?: boolean;
}

export interface ImageApi {
  getImageUrl(path: string): string;
  getThumbnailUrl(path: string): string;
  getAnimationData?(path: string): Promise<string | null>;
  getSpecialFormatPreview?(path: string, format: 'jxl' | 'avif'): Promise<string>;
}

export interface FileApi {
  deleteFile(path: string): Promise<void>;
  renameFile(oldPath: string, newPath: string): Promise<void>;
  moveFile?(src: string, dest: string): Promise<void>;
  copyFile?(src: string, dest: string): Promise<string>;
}

export interface BrowseApi {
  browse(path: string): Promise<BrowseResponse>;
}

export interface ExtendedApi {
  getDominantColors?(path: string, count: number): Promise<DominantColor[]>;
  startDragExternal?(paths: string[], thumbnails: string[]): Promise<void>;
  copyToClipboard?(path: string): Promise<void>;
  getDevices?(): Promise<ConnectedDevice[]>;
}

export interface SharedApi extends ImageApi, FileApi, BrowseApi, ExtendedApi {}

export interface ConnectedDevice {
  id: string;
  name: string;
  ip: string;
  connectedAt: number;
  lastActiveAt: number;
}

export interface AuthResult {
  success: boolean;
  token?: string;
  expiresIn?: number;
  error?: string;
}

export interface LayoutItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}
