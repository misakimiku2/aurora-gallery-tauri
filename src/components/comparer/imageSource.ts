import { convertFileSrc } from '@tauri-apps/api/core';
import { FileNode } from '../../types';
import { isRemotePath, getRemoteImageUrl } from '../../utils/remoteSource';

// Resolve a FileNode's full-image URL: remote files (desktop server / android
// device) load from the remote HTTP server, local files use convertFileSrc.
// FileNode.path 对远程文件已带 lan:// 或 android:// 前缀。
export const resolveImageSrc = (file: FileNode): string =>
  isRemotePath(file.path)
    ? getRemoteImageUrl(file.path)
    : convertFileSrc(file.path);
