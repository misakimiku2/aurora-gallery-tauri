import React, { useState, useEffect } from 'react';
import { Folder3DIcon } from './Folder3DIcon';
import { useInView } from '../../hooks/useInView';
import { ImageApi, BrowseItem } from '../../api/types';

const thumbnailCache = new Map<string, string>();

export interface FolderThumbnailProps {
  folder: BrowseItem;
  api: ImageApi;
  previewPaths?: string[];
  className?: string;
  onClick?: () => void;
  onDoubleClick?: () => void;
}

export const FolderThumbnail: React.FC<FolderThumbnailProps> = ({
  folder,
  api,
  previewPaths = [],
  className = '',
  onClick,
  onDoubleClick,
}) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '400px' });
  const [previewSrcs, setPreviewSrcs] = useState<string[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (loaded) return;
    if (!isInView && !wasInView) return;
    if (previewPaths.length === 0) {
      setLoaded(true);
      return;
    }

    const urls: string[] = [];
    for (const path of previewPaths.slice(0, 3)) {
      if (thumbnailCache.has(path)) {
        urls.push(thumbnailCache.get(path)!);
      } else {
        const url = api.getThumbnailUrl(path);
        thumbnailCache.set(path, url);
        urls.push(url);
      }
    }
    setPreviewSrcs(urls);
    setLoaded(true);
  }, [previewPaths, api, isInView, wasInView, loaded]);

  return (
    <div
      ref={ref}
      className={`w-full h-full relative flex flex-col items-center justify-center bg-transparent cursor-pointer ${className}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
    >
      <div className="relative w-full aspect-square p-2" style={{ maxHeight: '100%' }}>
        <Folder3DIcon
          previewSrcs={previewSrcs}
          count={folder.size}
          category="general"
        />
      </div>
    </div>
  );
};

export default FolderThumbnail;
