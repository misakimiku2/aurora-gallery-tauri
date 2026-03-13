import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { BrowseItem, ImageApi, LayoutMode } from '../../api/types';
import { useLayout } from '../../hooks/useLayout';
import { FileCard } from './FileCard';
import { LayoutSwitcher } from './LayoutSwitcher';

const STORAGE_KEY_LAYOUT_MODE = 'lan-share-layout-mode';
const DEFAULT_THUMBNAIL_SIZE = 200;

export interface FileGridProps {
  folders: BrowseItem[];
  images: BrowseItem[];
  api: ImageApi;
  onFolderClick: (folder: BrowseItem) => void;
  onImageClick: (image: BrowseItem, index: number) => void;
  className?: string;
  layoutMode?: LayoutMode;
  onLayoutModeChange?: (mode: LayoutMode) => void;
  showLayoutSwitcher?: boolean;
}

export const FileGrid: React.FC<FileGridProps> = ({
  folders,
  images,
  api,
  onFolderClick,
  onImageClick,
  className = '',
  layoutMode: externalLayoutMode,
  onLayoutModeChange: externalOnLayoutModeChange,
  showLayoutSwitcher = true,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const [internalLayoutMode, setInternalLayoutMode] = useState<LayoutMode>(() => {
    const saved = localStorage.getItem(STORAGE_KEY_LAYOUT_MODE);
    return (saved as LayoutMode) || 'grid';
  });

  const layoutMode = externalLayoutMode ?? internalLayoutMode;

  const handleLayoutModeChange = useCallback((mode: LayoutMode) => {
    if (externalOnLayoutModeChange) {
      externalOnLayoutModeChange(mode);
    } else {
      setInternalLayoutMode(mode);
      localStorage.setItem(STORAGE_KEY_LAYOUT_MODE, mode);
    }
  }, [externalOnLayoutModeChange]);

  const allItems = useMemo(() => [...folders, ...images], [folders, images]);
  const itemIds = useMemo(() => allItems.map((item) => item.path), [allItems]);
  const itemsMap = useMemo(
    () => new Map(allItems.map((item) => [item.path, item])),
    [allItems]
  );

  const aspectRatios = useMemo(() => {
    const ratios: Record<string, number> = {};
    images.forEach((img) => {
      if (img.width && img.height && img.height > 0) {
        ratios[img.path] = img.width / img.height;
      } else {
        ratios[img.path] = 1;
      }
    });
    folders.forEach((folder) => {
      ratios[folder.path] = 1;
    });
    return ratios;
  }, [images, folders]);

  useEffect(() => {
    const handleResize = () => {
      if (containerRef.current) {
        const rect = containerRef.current.getBoundingClientRect();
        setContainerWidth(rect.width);
        setContainerHeight(rect.height);
      }
    };

    handleResize();
    window.addEventListener('resize', handleResize);

    const observer = new ResizeObserver(handleResize);
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }

    return () => {
      window.removeEventListener('resize', handleResize);
      observer.disconnect();
    };
  }, []);

  const { layout, totalHeight } = useLayout(itemIds, containerWidth, {
    mode: layoutMode,
    thumbnailSize: DEFAULT_THUMBNAIL_SIZE,
    aspectRatios,
  });

  const [scrollTop, setScrollTop] = useState(0);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const visibleItems = useMemo(() => {
    const bufferSize = 400;
    const minY = scrollTop - bufferSize;
    const maxY = scrollTop + containerHeight + bufferSize;

    return layout.filter((item) => {
      return item.y < maxY && item.y + item.height > minY;
    });
  }, [layout, scrollTop, containerHeight]);

  const handleItemClick = useCallback(
    (item: BrowseItem) => {
      if (item.type === 'folder') {
        onFolderClick(item);
      }
    },
    [onFolderClick]
  );

  const handleImageClick = useCallback(
    (image: BrowseItem) => {
      const index = images.findIndex((img) => img.path === image.path);
      onImageClick(image, index);
    },
    [images, onImageClick]
  );

  return (
    <div className={`flex flex-col h-full ${className}`}>
      <div
        ref={containerRef}
        className="flex-1 overflow-y-auto overflow-x-hidden"
        onScroll={handleScroll}
      >
        {allItems.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-600">
            此文件夹为空
          </div>
        ) : (
          <div
            className="relative w-full"
            style={{ height: totalHeight, minHeight: '100%' }}
          >
            {visibleItems.map((layoutItem) => {
              const item = itemsMap.get(layoutItem.id);
              if (!item) return null;

              return (
                <FileCard
                  key={item.path}
                  item={item}
                  layout={layoutItem}
                  api={api}
                  onClick={() => handleItemClick(item)}
                  onDoubleClick={() =>
                    item.type === 'image' && handleImageClick(item)
                  }
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
};

export default FileGrid;
