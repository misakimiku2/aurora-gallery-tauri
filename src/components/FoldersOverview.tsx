import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { FileNode } from '../types';
import { useInView } from '../hooks/useInView';
import { getThumbnail } from '../api/tauri-bridge';
import { getGlobalCache } from '../utils/thumbnailCache';
import { useLayout, LayoutItem } from './useLayoutHook';
import { Folder, Loader2, ImageIcon } from 'lucide-react';

interface FoldersOverviewProps {
  roots: string[];
  files: Record<string, FileNode>;
  resourceRoot?: string;
  cachePath?: string;
  onFolderClick: (folderId: string) => void;
  thumbnailSize: number;
  t: (key: string) => string;
  isLoadingImages?: boolean;
}

const FolderCard = React.memo(({
  folder,
  resourceRoot,
  onClick,
  thumbnailSize,
}: {
  folder: FileNode;
  files: Record<string, FileNode>;
  resourceRoot?: string;
  cachePath?: string;
  onClick: () => void;
  thumbnailSize: number;
}) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '200px' });
  const [coverSrc, setCoverSrc] = useState<string | null>(null);
  const [coverLoaded, setCoverLoaded] = useState(false);

  const imageCount = folder.imageCount ?? folder.children?.length ?? 0;

  useEffect(() => {
    if (!(isInView || wasInView)) return;
    if (coverLoaded) return;

    const loadCover = async () => {
      if (folder.coverImagePath && resourceRoot) {
        const cache = getGlobalCache();
        const cached = cache.get(folder.coverImagePath);
        if (cached) {
          setCoverSrc(cached);
          setCoverLoaded(true);
          return;
        }

        try {
          const url = await getThumbnail(
            folder.coverImagePath,
            undefined,
            resourceRoot,
            undefined,
            undefined,
            undefined,
            folder.coverImageMediaStoreId
          );
          if (url) {
            cache.set(folder.coverImagePath, url);
            setCoverSrc(url);
          }
        } catch (e) {
          // ignore
        }
      }
      setCoverLoaded(true);
    };

    loadCover();
  }, [isInView, wasInView, coverLoaded, folder.coverImagePath, folder.coverImageMediaStoreId, resourceRoot]);

  return (
    <div
      ref={ref}
      className="file-item group cursor-pointer select-none"
      data-id={folder.id}
      onClick={onClick}
    >
      <div
        className="relative overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-800 shadow-sm hover:shadow-md transition-shadow duration-200"
        style={{ width: thumbnailSize, height: thumbnailSize }}
      >
        {coverSrc ? (
          <img
            src={coverSrc}
            className="w-full h-full object-cover"
            loading="lazy"
            draggable={false}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-200 dark:from-gray-800 dark:to-gray-750">
            <Folder size={thumbnailSize * 0.3} className="text-gray-400 dark:text-gray-500" strokeWidth={1.2} />
            {imageCount > 0 && (
              <div className="mt-1 flex items-center gap-0.5 text-gray-400 dark:text-gray-500">
                <ImageIcon size={10} />
                <span className="text-[10px]">{imageCount}</span>
              </div>
            )}
          </div>
        )}

        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 via-black/30 to-transparent pt-8 pb-2 px-2">
          <div className="text-white text-xs font-medium truncate leading-tight">
            {folder.name}
          </div>
          <div className="text-white/70 text-[10px] mt-0.5">
            {imageCount} 项
          </div>
        </div>
      </div>
    </div>
  );
});

export const FoldersOverview: React.FC<FoldersOverviewProps> = ({
  roots,
  files,
  resourceRoot,
  cachePath,
  onFolderClick,
  thumbnailSize,
  t,
  isLoadingImages,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);

  const folderNodes = useMemo(() => {
    return roots
      .map(id => files[id])
      .filter((f): f is FileNode => !!f && f.type === 'folder');
  }, [roots, files]);

  const sortedFolderIds = useMemo(() => {
    return [...folderNodes]
      .sort((a, b) => {
        const countA = a.imageCount ?? a.children?.length ?? 0;
        const countB = b.imageCount ?? b.children?.length ?? 0;
        return countB - countA;
      })
      .map(f => f.id);
  }, [folderNodes]);

  const { layout, totalHeight } = useLayout(
    sortedFolderIds,
    files,
    'grid',
    containerWidth,
    thumbnailSize,
    'browser' as any
  );

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
      setContainerWidth(containerRef.current.clientWidth);
    }

    return () => observer.disconnect();
  }, []);

  const itemMap = useMemo(() => {
    const map = new Map<string, LayoutItem>();
    for (const item of layout) {
      map.set(item.id, item);
    }
    return map;
  }, [layout]);

  return (
    <div
      ref={containerRef}
      className="w-full h-full overflow-y-auto overflow-x-hidden p-4 relative"
    >
      {isLoadingImages && (
        <div className="flex items-center gap-2 px-2 mb-3 text-xs text-gray-500 dark:text-gray-400 z-10 relative">
          <Loader2 size={14} className="animate-spin" />
          <span>{t('loading.images') || '正在加载图片...'}</span>
        </div>
      )}

      <div
        className="relative w-full"
        style={{ height: totalHeight > 0 ? totalHeight : 'auto', minHeight: '100%' }}
      >
        {sortedFolderIds.map(id => {
          const pos = itemMap.get(id);
          if (!pos) return null;

          return (
            <div
              key={id}
              className="absolute transition-all duration-300 ease-out"
              style={{
                left: pos.x,
                top: pos.y,
                width: pos.width,
                height: pos.height,
              }}
            >
              <FolderCard
                key={id}
                folder={files[id]}
                files={files}
                resourceRoot={resourceRoot}
                cachePath={cachePath}
                onClick={() => onFolderClick(id)}
                thumbnailSize={Math.min(pos.width - 8, pos.height - 40)}
              />
            </div>
          );
        })}
      </div>

      {sortedFolderIds.length === 0 && !isLoadingImages && (
        <div className="flex flex-col items-center justify-center h-64 text-gray-400 dark:text-gray-500">
          <Folder size={48} strokeWidth={1} />
          <p className="mt-3 text-sm">{t('empty.noFolders') || '没有找到相册'}</p>
        </div>
      )}
    </div>
  );
};
