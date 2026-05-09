import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { FileNode, LayoutMode, SortOption, SortDirection, FileType, DateFilter } from '../types';
import { useInView } from '../hooks/useInView';
import { usePinchZoom } from '../hooks/usePinchZoom';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { getThumbnail, isThumbnailUpgrading, getGlobalScrollState, setGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge';
import { getGlobalCache } from '../utils/thumbnailCache';
import { useLayout, LayoutItem } from './useLayoutHook';
import { Folder, Check } from 'lucide-react';
import { CircularProgressOverlay } from './CircularProgressOverlay';
import { PullToRefreshIndicator } from './PullToRefreshIndicator';

interface FoldersOverviewProps {
  roots: string[];
  files: Record<string, FileNode>;
  resourceRoot?: string;
  cachePath?: string;
  onFolderClick: (folderId: string) => void;
  thumbnailSize: number;
  onThumbnailSizeChange?: (size: number) => void;
  t: (key: string) => string;
  isLoadingImages?: boolean;
  layoutMode?: LayoutMode;
  onLayoutModeChange?: (mode: LayoutMode) => void;
  isVisible?: boolean;
  scrollTop?: number;
  onScrollTopChange?: (scrollTop: number) => void;
  isAndroidSelectionMode?: boolean;
  selectedFileIds?: string[];
  onFileLongPress?: (id: string) => void;
  onShowContextMenuForFile?: (id: string, x: number, y: number) => void;
  onAndroidRangeSelect?: (id: string) => void;
  onFolderSelect?: (id: string) => void;
  sortBy?: SortOption;
  sortDirection?: SortDirection;
  dateFilter?: DateFilter;
  onRefresh?: () => Promise<void>;
}

const FolderCard = React.memo(({
  folder,
  resourceRoot,
  onClick,
  thumbnailSize,
  layoutMode,
  isSelected,
  isAndroidSelectionMode,
  onFileLongPress,
  onShowContextMenuForFile,
  onAndroidRangeSelect,
  onFolderSelect,
  coverOverridePath,
  coverOverrideMediaStoreId,
}: {
  folder: FileNode;
  files?: Record<string, FileNode>;
  resourceRoot?: string;
  cachePath?: string;
  onClick: () => void;
  thumbnailSize: number;
  layoutMode?: LayoutMode;
  isSelected?: boolean;
  isAndroidSelectionMode?: boolean;
  onFileLongPress?: (id: string) => void;
  onShowContextMenuForFile?: (id: string, x: number, y: number) => void;
  onAndroidRangeSelect?: (id: string) => void;
  onFolderSelect?: (id: string) => void;
  coverOverridePath?: string;
  coverOverrideMediaStoreId?: number;
}) => {
  const effectiveCoverPath = coverOverridePath || folder.coverImagePath;
  const effectiveCoverMediaStoreId = coverOverrideMediaStoreId ?? folder.coverImageMediaStoreId;

  const [ref, isInView, wasInView] = useInView({ rootMargin: '2000px' });
  const [coverSrc, setCoverSrc] = useState<string | null>(() => {
    if (!effectiveCoverPath) return null;
    const cache = getGlobalCache();
    return cache.get(effectiveCoverPath) || null;
  });
  const [upgrading, setUpgrading] = useState(() =>
    effectiveCoverPath ? isThumbnailUpgrading(effectiveCoverPath) : false
  );
  const [scrollState, setScrollState] = useState(getGlobalScrollState());

  const isAndroid = resourceRoot === 'android_media_store';
  const imageCount = folder.imageCount ?? folder.children?.length ?? 0;
  const coverImagePathRef = useRef(effectiveCoverPath);
  coverImagePathRef.current = effectiveCoverPath;

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressTriggeredRef = useRef(false);
  const contextMenuTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const contextMenuTriggeredRef = useRef(false);
  const rangeSelectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rangeSelectTriggeredRef = useRef(false);
  const animShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const [showContextMenuAnim, setShowContextMenuAnim] = useState(false);
  const [contextMenuAnimPos, setContextMenuAnimPos] = useState({ x: 0, y: 0 });

  useEffect(() => {
    if (!isAndroid) return;
    return subscribeScrollState(setScrollState);
  }, [isAndroid]);

  useEffect(() => {
    if (!(isInView || wasInView)) return;
    if (!effectiveCoverPath || !resourceRoot) return;

    const cache = getGlobalCache();
    const cached = cache.get(effectiveCoverPath);
    if (cached) {
      if (cached !== coverSrc) setCoverSrc(cached);
      return;
    }

    let cancelled = false;
    const loadCover = async () => {
      try {
        const url = await getThumbnail(
          effectiveCoverPath,
          undefined,
          resourceRoot,
          undefined,
          undefined,
          undefined,
          effectiveCoverMediaStoreId
        );
        if (!cancelled && url) {
          cache.set(effectiveCoverPath, url);
          setCoverSrc(url);
          setUpgrading(isThumbnailUpgrading(effectiveCoverPath));
        }
      } catch {}
    };

    loadCover();
    return () => { cancelled = true; };
  }, [isInView, wasInView, effectiveCoverPath, effectiveCoverMediaStoreId, resourceRoot]);

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
    if (!upgrading || !effectiveCoverPath || !resourceRoot) return;
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
        const thumbnail = await getThumbnail(effectiveCoverPath, undefined, resourceRoot, undefined, undefined, undefined, effectiveCoverMediaStoreId);
        if (cancelled) return;
        if (thumbnail && !isThumbnailUpgrading(effectiveCoverPath)) {
          const cache = getGlobalCache();
          cache.set(effectiveCoverPath, thumbnail);
          setCoverSrc(thumbnail);
          setUpgrading(false);
        } else if (isThumbnailUpgrading(effectiveCoverPath)) {
          checkUpgrade();
        }
      } catch {
        if (!cancelled) checkUpgrade();
      }
    };

    checkUpgrade();
    return () => { cancelled = true; };
  }, [upgrading, effectiveCoverPath, effectiveCoverMediaStoreId, resourceRoot]);

  const isGridMode = !layoutMode || layoutMode === 'grid';

  const clearAllTimers = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (contextMenuTimerRef.current) {
      clearTimeout(contextMenuTimerRef.current);
      contextMenuTimerRef.current = null;
    }
    if (rangeSelectTimerRef.current) {
      clearTimeout(rangeSelectTimerRef.current);
      rangeSelectTimerRef.current = null;
    }
    if (animShowTimerRef.current) {
      clearTimeout(animShowTimerRef.current);
      animShowTimerRef.current = null;
    }
    setShowContextMenuAnim(false);
  }, []);

  return (
    <div
      ref={ref}
      className="file-item cursor-pointer select-none flex flex-col items-center px-1 h-full"
      data-id={folder.id}
      onClick={(e) => {
        if (isAndroid && longPressTriggeredRef.current) {
          longPressTriggeredRef.current = false;
          return;
        }
        if (isAndroid && contextMenuTriggeredRef.current) {
          contextMenuTriggeredRef.current = false;
          return;
        }
        if (isAndroid && rangeSelectTriggeredRef.current) {
          rangeSelectTriggeredRef.current = false;
          return;
        }
        if (isAndroid && isAndroidSelectionMode && onFolderSelect) {
          onFolderSelect(folder.id);
          return;
        }
        onClick();
      }}
      onContextMenu={isAndroid ? undefined : undefined}
      onTouchStart={isAndroid ? ((e: React.TouchEvent) => {
        longPressTriggeredRef.current = false;
        contextMenuTriggeredRef.current = false;
        rangeSelectTriggeredRef.current = false;
        const touchX = e.touches[0].clientX;
        const touchY = e.touches[0].clientY;
        touchStartPosRef.current = { x: touchX, y: touchY };
        if (isSelected && isAndroidSelectionMode) {
          animShowTimerRef.current = setTimeout(() => {
            setContextMenuAnimPos({ x: touchX, y: touchY });
            setShowContextMenuAnim(true);
          }, 150);
          contextMenuTimerRef.current = setTimeout(() => {
            contextMenuTriggeredRef.current = true;
            if (onShowContextMenuForFile) {
              onShowContextMenuForFile(folder.id, touchX, touchY);
            }
            requestAnimationFrame(() => {
              setShowContextMenuAnim(false);
            });
          }, 500);
        } else if (isAndroidSelectionMode && !isSelected) {
          animShowTimerRef.current = setTimeout(() => {
            setContextMenuAnimPos({ x: touchX, y: touchY });
            setShowContextMenuAnim(true);
          }, 150);
          rangeSelectTimerRef.current = setTimeout(() => {
            rangeSelectTriggeredRef.current = true;
            if (onAndroidRangeSelect) {
              onAndroidRangeSelect(folder.id);
            }
            requestAnimationFrame(() => {
              setShowContextMenuAnim(false);
            });
          }, 500);
        } else {
          longPressTimerRef.current = setTimeout(() => {
            longPressTriggeredRef.current = true;
            if (onFileLongPress) onFileLongPress(folder.id);
          }, 500);
        }
      }) : undefined}
      onTouchMove={isAndroid ? ((e: React.TouchEvent) => {
        if (!touchStartPosRef.current) return;
        const dx = Math.abs(e.touches[0].clientX - touchStartPosRef.current.x);
        const dy = Math.abs(e.touches[0].clientY - touchStartPosRef.current.y);
        if (dx > 10 || dy > 10) {
          clearAllTimers();
        }
      }) : undefined}
      onTouchEnd={isAndroid ? (() => {
        clearAllTimers();
      }) : undefined}
      style={{
        willChange: 'transform',
        contain: 'paint',
      }}
    >
      <div
        className={`relative overflow-hidden rounded-lg bg-gray-100 dark:bg-gray-800 transition-all duration-300 ${
          isSelected ? 'border-2 border-blue-500 ring-4 ring-blue-300/60 dark:ring-blue-700/60 shadow-lg shadow-blue-200/50 dark:shadow-blue-900/30' : 'border-2 border-transparent'
        }`}
        style={isGridMode
          ? { width: thumbnailSize, height: thumbnailSize }
          : { width: '100%', flex: 1 }
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

        <div className={`absolute top-2 left-2 transition-opacity duration-200 z-20 ${isSelected ? 'opacity-100' : isAndroidSelectionMode ? 'opacity-0' : 'opacity-0'}`}>
          {isSelected ? (
            <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center border-2 border-white shadow-lg ring-2 ring-blue-400/50">
              <Check size={14} className="text-white" strokeWidth={3} />
            </div>
          ) : isAndroidSelectionMode ? (
            <div className="w-5 h-5 bg-black/30 hover:bg-black/50 rounded-full border border-white/50 backdrop-blur-sm"></div>
          ) : null}
        </div>

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

      {isAndroid && showContextMenuAnim && (
        <CircularProgressOverlay
          x={contextMenuAnimPos.x}
          y={contextMenuAnimPos.y}
          duration={350}
        />
      )}
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
  onThumbnailSizeChange,
  t,
  isLoadingImages,
  layoutMode = 'grid',
  onLayoutModeChange,
  isVisible = true,
  scrollTop: targetScrollTop,
  onScrollTopChange,
  isAndroidSelectionMode,
  selectedFileIds,
  onFileLongPress,
  onShowContextMenuForFile,
  onAndroidRangeSelect,
  onFolderSelect,
  sortBy = 'name',
  sortDirection = 'asc',
  dateFilter,
  onRefresh,
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
  const prevSortedIdsRef = useRef<string[]>([]);
  const prevAspectRatiosRef = useRef<Record<string, number>>({});
  const prevLayoutInputsRef = useRef({ containerWidth: 0, thumbnailSize: 0, layoutMode: '', sortBy: '', sortDirection: '', folderCount: 0, filesCount: 0 });

  const {
    pullDistance: pullRefreshDistance,
    isRefreshing: isPullRefreshing,
    canRefresh: canPullRefresh,
    isComplete: isPullComplete,
  } = usePullToRefresh({
    containerRef,
    onRefresh: onRefresh || (async () => {}),
    enabled: isAndroid,
  });

  const pinchStartSizeRef = useRef(thumbnailSize);

  usePinchZoom(containerRef, {
    onPinchStart: useCallback(() => {
      pinchStartSizeRef.current = thumbnailSize;
    }, [thumbnailSize]),
    onPinchZoom: useCallback((totalScale: number) => {
      if (!onThumbnailSizeChange) return;
      const maxLimit = 480;
      const minLimit = 100;
      const newSize = Math.max(minLimit, Math.min(maxLimit, Math.round(pinchStartSizeRef.current * totalScale)));
      onThumbnailSizeChange(newSize);
    }, [onThumbnailSizeChange]),
  });

  const folderNodes = useMemo(() => {
    const nodes = roots
      .map(id => files[id])
      .filter((f): f is FileNode => !!f && f.type === 'folder');

    if (!dateFilter?.start || !dateFilter?.end) return nodes;

    const start = new Date(dateFilter.start).getTime();
    const end = new Date(dateFilter.end).getTime();
    const min = Math.min(start, end);
    const max = Math.max(start, end) + 86400000;

    const hasMatchingChild = (folder: FileNode): boolean => {
      const children = folder.children || [];
      for (const childId of children) {
        const child = files[childId];
        if (!child) continue;
        if (child.type === FileType.FOLDER) {
          if (hasMatchingChild(child)) return true;
        } else {
          const dStr = dateFilter.mode === 'created' ? child.createdAt : child.updatedAt;
          if (dStr) {
            const t = new Date(dStr).getTime();
            if (t >= min && t < max) return true;
          }
        }
      }
      return false;
    };

    return nodes.filter(hasMatchingChild);
  }, [roots, files, dateFilter]);

  const sortedFolderIds = useMemo(() => {
    return [...folderNodes]
      .sort((a, b) => {
        let res = 0;
        if (sortBy === 'date') {
          res = (a.createdAt || '').localeCompare(b.createdAt || '');
        } else if (sortBy === 'size') {
          res = (a.size || 0) - (b.size || 0);
        } else {
          res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        }
        return res * (sortDirection === 'asc' ? 1 : -1);
      })
      .map(f => f.id);
  }, [folderNodes, sortBy, sortDirection]);

  if (isAndroid) {
    const prev = prevSortedIdsRef.current;
    if (prev.length !== sortedFolderIds.length || prev.some((id, i) => id !== sortedFolderIds[i])) {
      const added = sortedFolderIds.filter(id => !prev.includes(id));
      const removed = prev.filter(id => !sortedFolderIds.includes(id));
      const moved: string[] = [];
      if (added.length === 0 && removed.length === 0 && prev.length === sortedFolderIds.length) {
        for (let i = 0; i < prev.length; i++) {
          if (prev[i] !== sortedFolderIds[i]) {
            moved.push(`${files[prev[i]]?.name || prev[i]}→${files[sortedFolderIds[i]]?.name || sortedFolderIds[i]}`);
          }
        }
      }
      console.log(`[FoldersOverview] sortedFolderIds CHANGED: ${prev.length}→${sortedFolderIds.length}, sortBy=${sortBy}, sortDir=${sortDirection}, layout=${layoutMode}, filesCount=${Object.keys(files).length}` +
        (added.length > 0 ? `, added=${added.length}` : '') +
        (removed.length > 0 ? `, removed=${removed.length}` : '') +
        (moved.length > 0 ? `, orderChanged=${moved.length}` : ''));
      prevSortedIdsRef.current = sortedFolderIds;
    }
  }

  const sortCoverOverrides = useMemo(() => {
    const overrides: Record<string, { path: string; mediaStoreId?: number; width?: number; height?: number }> = {};
    for (const folder of folderNodes) {
      const children = (folder.children || [])
        .map(id => files[id])
        .filter((f): f is FileNode => !!f && f.type === FileType.IMAGE);
      if (children.length === 0) continue;
      const sorted = [...children].sort((a, b) => {
        let res = 0;
        if (sortBy === 'date') {
          res = (a.createdAt || '').localeCompare(b.createdAt || '');
        } else if (sortBy === 'size') {
          res = (a.size || 0) - (b.size || 0);
        } else {
          res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        }
        return res * (sortDirection === 'asc' ? 1 : -1);
      });
      const firstImage = sorted[0];
      overrides[folder.id] = {
        path: firstImage.path,
        mediaStoreId: firstImage.mediaStoreId,
        width: firstImage.meta?.width || undefined,
        height: firstImage.meta?.height || undefined,
      };
    }
    return overrides;
  }, [folderNodes, files, sortBy, sortDirection]);

  const folderAspectRatios = useMemo(() => {
    const ratios: Record<string, number> = {};
    for (const folder of folderNodes) {
      if (folder.coverImageWidth && folder.coverImageHeight) {
        ratios[folder.id] = folder.coverImageWidth / folder.coverImageHeight;
      } else {
        const override = sortCoverOverrides[folder.id];
        if (override?.width && override?.height) {
          ratios[folder.id] = override.width / override.height;
        } else {
          ratios[folder.id] = 1;
        }
      }
    }
    return ratios;
  }, [folderNodes, sortCoverOverrides]);

  if (isAndroid) {
    const prev = prevAspectRatiosRef.current;
    const changedIds = Object.keys(folderAspectRatios).filter(id => prev[id] !== folderAspectRatios[id]);
    const newIds = Object.keys(folderAspectRatios).filter(id => !(id in prev));
    const removedIds = Object.keys(prev).filter(id => !(id in folderAspectRatios));
    if (changedIds.length > 0 || newIds.length > 0 || removedIds.length > 0) {
      console.log(`[FoldersOverview] aspectRatios CHANGED: ${Object.keys(prev).length}→${Object.keys(folderAspectRatios).length}` +
        `, changed=${changedIds.length}` +
        `, new=${newIds.length}` +
        `, removed=${removedIds.length}` +
        (changedIds.length > 0 && changedIds.length <= 5 ? ` [${changedIds.map(id => `${files[id]?.name}:${prev[id]?.toFixed(2)}→${folderAspectRatios[id]?.toFixed(2)}`).join(', ')}]` : ''));
      prevAspectRatiosRef.current = folderAspectRatios;
    }
  }

  if (isAndroid) {
    const prev = prevLayoutInputsRef.current;
    const curr = { containerWidth, thumbnailSize, layoutMode, sortBy, sortDirection, folderCount: sortedFolderIds.length, filesCount: Object.keys(files).length };
    if (prev.containerWidth !== curr.containerWidth || prev.thumbnailSize !== curr.thumbnailSize || prev.layoutMode !== curr.layoutMode || prev.sortBy !== curr.sortBy || prev.sortDirection !== curr.sortDirection || prev.folderCount !== curr.folderCount || prev.filesCount !== curr.filesCount) {
      const changes: string[] = [];
      if (prev.containerWidth !== curr.containerWidth) changes.push(`width=${prev.containerWidth}→${curr.containerWidth}`);
      if (prev.thumbnailSize !== curr.thumbnailSize) changes.push(`thumbSize=${prev.thumbnailSize}→${curr.thumbnailSize}`);
      if (prev.layoutMode !== curr.layoutMode) changes.push(`layout=${prev.layoutMode}→${curr.layoutMode}`);
      if (prev.sortBy !== curr.sortBy) changes.push(`sortBy=${prev.sortBy}→${curr.sortBy}`);
      if (prev.sortDirection !== curr.sortDirection) changes.push(`sortDir=${prev.sortDirection}→${curr.sortDirection}`);
      if (prev.folderCount !== curr.folderCount) changes.push(`folders=${prev.folderCount}→${curr.folderCount}`);
      if (prev.filesCount !== curr.filesCount) changes.push(`files=${prev.filesCount}→${curr.filesCount}`);
      console.log(`[FoldersOverview] LAYOUT INPUTS CHANGED: ${changes.join(', ')}`);
      prevLayoutInputsRef.current = curr;
    }
  }

  const { layout, totalHeight } = useLayout(
    sortedFolderIds,
    files,
    layoutMode,
    containerWidth,
    thumbnailSize,
    'folders-overview',
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    folderAspectRatios
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
      const buffer = 400;
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
      {isAndroid && (pullRefreshDistance > 0 || isPullRefreshing || isPullComplete) && (
        <PullToRefreshIndicator
          pullDistance={pullRefreshDistance}
          isRefreshing={isPullRefreshing}
          canRefresh={canPullRefresh}
          isComplete={isPullComplete}
        />
      )}
      <div
        className="relative w-full"
        style={{
          height: totalHeight > 0 ? totalHeight : 'auto',
          minHeight: '100%',
          transform: isAndroid && pullRefreshDistance > 0 ? `translateY(${pullRefreshDistance}px)` : undefined,
          transition: isAndroid && pullRefreshDistance === 0 && !isPullRefreshing && !isPullComplete ? 'transform 300ms cubic-bezier(0.25, 0.46, 0.45, 0.94)' : undefined,
        }}
      >
        {visibleItems.map(pos => (
            <div
              key={pos.id}
              className="absolute"
              style={{
                transform: `translate(${pos.x}px, ${pos.y}px)`,
                width: pos.width,
                height: pos.height,
                willChange: 'transform',
                transition: 'transform 300ms ease-out',
                ...(!isAndroid && {
                  contentVisibility: 'auto' as const,
                  containIntrinsicSize: `${pos.width}px ${pos.height}px`
                })
              }}
            >
              <FolderCard
                key={pos.id}
                folder={files[pos.id]}
                resourceRoot={resourceRoot}
                cachePath={cachePath}
                onClick={() => stableOnFolderClick(pos.id)}
                thumbnailSize={Math.min(pos.width - 2, pos.height - 28)}
                layoutMode={layoutMode}
                isSelected={selectedFileIds?.includes(pos.id)}
                isAndroidSelectionMode={isAndroidSelectionMode}
                onFileLongPress={onFileLongPress}
                onShowContextMenuForFile={onShowContextMenuForFile}
                onAndroidRangeSelect={onAndroidRangeSelect}
                onFolderSelect={onFolderSelect}
                coverOverridePath={isAndroid ? undefined : sortCoverOverrides[pos.id]?.path}
                coverOverrideMediaStoreId={isAndroid ? undefined : sortCoverOverrides[pos.id]?.mediaStoreId}
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
