export type FileType = 'image' | 'video' | 'folder';

export interface BaseFileItem {
  name: string;
  path: string;
  type: FileType;
}

export interface ImageItem extends BaseFileItem {
  type: 'image';
  width?: number;
  height?: number;
  size?: number;
  modified?: string;
}

export interface FolderItem extends BaseFileItem {
  type: 'folder';
  itemCount?: number;
}

export interface VideoItem extends BaseFileItem {
  type: 'video';
  duration?: number;
  width?: number;
  height?: number;
}

export type FileItem = ImageItem | FolderItem | VideoItem;

export interface BrowseResult {
  currentPath: string;
  folders: FolderItem[];
  images: ImageItem[];
  videos?: VideoItem[];
}
