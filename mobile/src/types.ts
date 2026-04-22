export interface AndroidImageInfo {
  id: number;
  path: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  date_added: number;
  date_modified: number;
  mime_type: string;
}

export interface AndroidFolderInfo {
  id: number;
  name: string;
  path: string;
  image_count: number;
  cover_image_width?: number;
  cover_image_height?: number;
}

export interface AndroidThumbnailResult {
  path: string;
  thumbnail_path?: string;
  width: number;
  height: number;
}

export interface AndroidPermissionResult {
  granted: boolean;
  shouldShowRationale: boolean;
}

export interface MobileImageItem {
  name: string;
  path: string;
  type: 'image';
  size: number;
  width?: number;
  height?: number;
}

export interface MobileFolderItem {
  id: string;
  name: string;
  path: string;
  children: MobileFolderItem[];
}
