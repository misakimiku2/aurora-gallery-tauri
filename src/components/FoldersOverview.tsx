import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { FileNode, LayoutMode } from '../types';
import { useInView } from '../hooks/useInView';
import { getThumbnail, isThumbnailUpgrading, getGlobalScrollState, setGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge';
import { getGlobalCache } from '../utils/thumbnailCache';
import { useLayout, LayoutItem } from './useLayoutHook';
import { Folder } from 'lucide-react';

interface FoldersOverviewProps {
  roots: string[];
  files: Record<string, FileNode>;
  resourceRoot?: string;
  cachePath?: string;
  onFolderClick: (folderId: string) => void;
  thumbnailSize: number;
  t: (key: string) => string;
  isLoadingImages?: boolean;
  layoutMode?: LayoutMode;
  onLayoutModeChange?: (mode: LayoutMode) => void;
  isVisible?: boolean;
  scrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
}

const FolderCard = React.memo(({
  folder,
  resourceRoot,
  onClick,
  thumbnailSize,
  layoutMode,
}: {
  folder: FileNode;
  files: Record<string, FileNode>;
  resourceRoot?: string;
  cachePath?: string;
  onClick: () => void;
  thumbnailSize: number;
  layoutMode?: LayoutMode;
}) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '2000px' });
  const [coverSrc, setCoverSrc] = useState<string | null>(() => {
    if (!folder.coverImagePath) return null;
    const cache = getGlobalCache();
    return cache.get(folder.coverImagePath) || null;
  });
  const [upgrading, setUpgrading] = useState(() =>
    folder.coverImagePath ? isThumbnailUpgrading(folder.coverImagePath) : false
  );
  const [scrollState, setScrollState] = useState(getGlobalScrollState());

  const isAndroid = resourceRoot === 'android_media_store';
  const imageCount = folder.imageCount ?? folder.children?.length ?? 0;
  const coverImagePathRef = useRef(folder.coverImagePath);
  coverImagePathRef.current = folder.coverImagePath;

  useEffect(() => {
    if (!isAndroid) return;
    return subscribeScrollState(setScrollState);
  }, [isAndroid]);

  useEffect(() => {
    if (!(isInView || wasInView)) return;
    if (!folder.coverImagePath || !resourceRoot) return;

    const cache = getGlobalCache();
    const cached = cache.get(folder.coverImagePath);
    if (cached) {
      if (cached !== coverSrc) setCoverSrc(cached);
      return;
    }

    let cancelled = false;
    const loadCover = async () => {
      try {
        const url = await getThumbnail(
          folder.coverImagePath!,
          undefined,
          resourceRoot,
          undefined,
          undefined,
          undefined,
          folder.coverImageMediaStoreId
        );
        if (!cancelled && url) {
          cache.set(folder.coverImagePath!, url);
          setCoverSrc(url);
          setUpgrading(isThumbnailUpgrading(folder.coverImagePath!));
        }
      } catch {}
    };

    loadCover();
    return () => { cancelled = true; };
  }, [isInView, wasInView, folder.coverImagePath, folder.coverImageMediaStoreId, resourceRoot]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { filePath, thumbnailSrc } = (e as CustomEvent).detail;
      if (filePath === coverImagePathRef.current && thumbnailSrc !== coverSrc) {
        setCoverSrc(thumbnailSrc);
        setUpgrading(false);
      }
    };
    const failHandler = (e: Event) => {
      const { filePath } = (e as CustomEvent).detail;
      if (filePath === coverImagePathRef.current) {
        setUpgrading(false);
      }
    };
    window.addEventListener('aurora:thumbnail-upgraded', handler);
    window.addEventListener('aurora:thumbnail-upgrade-failed', failHandler);
    return () => {
      window.removeEventListener('aurora:thumbnail-upgraded', handler);
      window.removeEventListener('aurora:thumbnail-upgrade-failed', failHandler);
    };
  }, [coverSrc]);

  useEffect(() => {
    if (!upgrading || !folder.coverImagePath || !resourceRoot) return;
    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelay = 5000;

    const checkUpgrade = async () => {
      if (cancelled || retryCount >= maxRetries) return;
      retryCount++;
      await new Promise<void>(resolve => setTimeout(resolve, retryDelay));
      if (cancelled) return;
      try {
        const thumbnail = await getThumbnail(folder.coverImagePath!, undefined, resourceRoot, undefined, undefined, undefined, folder.coverImageMediaStoreId);
        if (cancelled) return;
        if (thumbnail && !isThumbnailUpgrading(folder.coverImagePath!)) {
          const cache = getGlobalCache();
          cache.set(folder.coverImagePath!, thumbnail);
          setCoverSrc(thumbnail);
          setUpgrading(false);
        } else if (isThumbnailUpgrading(folder.coverImagePath!)) {
          checkUpgrade();
        }
      } catch {
        if (!cancelled) checkUpgrade();
      }
    };

    checkUpgrade();
    return () => { cancelled = true; };
  }, [upgrading, folder.coverImagePath, folder.coverImageMediaStoreId, resourceRoot]);

  const isGridMode = !layoutMode || layoutMode === 'grid';

  return (
    <div
      ref={ref}
      className="file-item cursor-pointer select-none flex flex-col items-center px-1"
      data-id={folder.id}
      onClick={onClick}
      style={{
        willChange: 'transform',
        contain: 'paint',
      }}
    >
      <div
        className="relative overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-800"
        style={isGridMode
          ? { width: thumbnailSize, height: thumbnailSize }
          : { width: '100%', height: '100%' }
        }
      >
        {coverSrc ? (
          <img
            src={coverSrc}
            className="w-full h-full object-cover"
            decoding="async"
            loading="eager"
            draggable={false}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-200 dark:from-gray-800 dark:to-gray-750">
            <Folder size={thumbnailSize * 0.3} className="text-gray-400 dark:text-gray-500" strokeWidth={1.2} />
          </div>
        )}

        {upgrading && (scrollState === 'idle' || !isAndroid) && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-10 rounded-lg">
            <svg className="animate-spin h-5 w-5 text-white/70" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
          </div>
        )}

        <div className="absolute bottom-1.5 right-1.5 z-20 flex flex-col items-end gap-0.5">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" className="text-blue-400">
            <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
          </svg>
          {imageCount > 0 && (
            <span className="bg-black/50 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full leading-none">
              {imageCount}
            </span>
          )}
        </div>
      </div>

      <div className="mt-1 w-full text-center px-1">
        <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate leading-tight" title={folder.name}>
          {folder.name}
        </div>
      </div>
    </div>
  );
});

const FoldersOverview = React.memo(({
  roots,
  files,
  resourceRoot,
  cachePath,
  onFolderClick,
  thumbnailSize,
  t,
  isLoadingImages,
  layoutMode = 'grid',
  onLayoutModeChange,
  isVisible = true,
  scrollTop: targetScrollTop,
  onScrollTopChange,
}: FoldersOverviewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const hasRestoredRef = useRef(false);
  const isRestoringScrollRef = useRef(false);
  const scrollbarStyleInjectedRef = useRef(false);

  const isAndroid = resourceRoot === 'android_media_store';
  const scrollStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTimeRef = useRef(0);
  const lastScrollTopRef = useRef(0);

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
    layoutMode,
    containerWidth,
    thumbnailSize,
    'folders-overview'
  );

  const stableOnFolderClick = useCallback((folderId: string) => {
    onFolderClick(folderId);
  }, [onFolderClick]);

  useEffect(() => {
    if (!scrollbarStyleInjectedRef.current && isAndroid) {
      const style = document.createElement('style');
      style.textContent = '#folders-scroll::-webkit-scrollbar{display:none;width:0!important;height:0!important}';
      document.head.appendChild(style);
      scrollbarStyleInjectedRef.current = true;
    }
  }, [isAndroid]);

  useEffect(() => {
    if (!isVisible) {
      hasRestoredRef.current = false;
      return;
    }
    if (hasRestoredRef.current) return;
    if (targetScrollTop && targetScrollTop > 0 && containerRef.current && layout.length > 0) {
      isRestoringScrollRef.current = true;
      containerRef.current.scrollTop = targetScrollTop;
      setScrollTop(targetScrollTop);
      requestAnimationFrame(() => {
        isRestoringScrollRef.current = false;
      });
      hasRestoredRef.current = true;
    } else {
      hasRestoredRef.current = true;
    }
  }, [isVisible, targetScrollTop, layout]);

  useEffect(() => {
    const observer = new ResizeObserver(entries => {
      for (const entry of entries) {
        setContainerWidth(entry.contentRect.width);
        setContainerHeight(entry.contentRect.height);
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
      setContainerWidth(containerRef.current.clientWidth);
      setContainerHeight(containerRef.current.clientHeight);
    }

    const handleScroll = () => {
      if (containerRef.current) {
        const currentScroll = containerRef.current.scrollTop;

        if (isRestoringScrollRef.current) return;

        setScrollTop(currentScroll);
        onScrollTopChange?.(currentScroll);

        if (isAndroid) {
          const now = Date.now();
          const dt = now - lastScrollTimeRef.current;
          const dy = Math.abs(currentScroll - lastScrollTopRef.current);
          lastScrollTimeRef.current = now;
          lastScrollTopRef.current = currentScroll;

          if (dt > 0) {
            const velocity = dy / dt;
            if (velocity > 3 || dt < 32) {
              setGlobalScrollState('fast');
            } else if (velocity > 0.5 || dt < 150) {
              setGlobalScrollState('scrolling');
            } else {
              setGlobalScrollState('idle');
            }
          }

          if (scrollStateTimerRef.current) clearTimeout(scrollStateTimerRef.current);
          scrollStateTimerRef.current = setTimeout(() => {
            setGlobalScrollState('idle');
          }, 300);
        }
      }
    };
    containerRef.current?.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      observer.disconnect();
      containerRef.current?.removeEventListener('scroll', handleScroll);
      if (scrollStateTimerRef.current) clearTimeout(scrollStateTimerRef.current);
    };
  }, [isAndroid, onScrollTopChange]);

  const visibleItems = useMemo(() => {
      const buffer = Math.max(3000, containerHeight * 3);
      const minY = scrollTop - buffer;
      const maxY = scrollTop + containerHeight + buffer;
      return layout.filter(item => item.y < maxY && item.y + item.height > minY);
  }, [layout, scrollTop, containerHeight]);

  return (
    <div
      id="folders-scroll"
      ref={containerRef}
      className="w-full h-full overflow-y-auto overflow-x-hidden relative"
      style={isAndroid ? { scrollbarWidth: 'none', msOverflowStyle: 'none' } : undefined}
    >
      <div
        className="relative w-full"
        style={{ height: totalHeight > 0 ? totalHeight : 'auto', minHeight: '100%' }}
      >
        {visibleItems.map(pos => (
            <div
              key={pos.id}
              className="absolute transition-all duration-300 ease-out"
              style={{
                left: pos.x,
                top: pos.y,
                width: pos.width,
                height: pos.height,
                willChange: 'transform',
                ...(!isAndroid && {
                  contentVisibility: 'auto' as const,
                  containIntrinsicSize: `${pos.width}px ${pos.height}px`
                })
              }}
            >
              <FolderCard
                key={pos.id}
                folder={files[pos.id]}
                files={files}
                resourceRoot={resourceRoot}
                cachePath={cachePath}
                onClick={() => stableOnFolderClick(pos.id)}
                thumbnailSize={Math.min(pos.width - 2, pos.height - 28)}
                layoutMode={layoutMode}
              />
            </div>
        ))}
      </div>

      {sortedFolderIds.length === 0 && !isLoadingImages && (
        <div className="flex flex-col items-center justify-center h-64 text-gray-400 dark:text-gray-500">
          <Folder size={48} strokeWidth={1} />
          <p className="mt-3 text-sm">{t('empty.noFolders') || '没有找到相册'}</p>
        </div>
      )}
    </div>
  );
});

export { FoldersOverview };
