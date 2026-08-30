import React, { useState, useEffect, useMemo, useRef, useCallback, useLayoutEffect } from 'react';
import { FileNode, LayoutMode, SortOption, SortDirection, FileType, DateFilter } from '../types';
import { useInView } from '../hooks/useInView';
import { usePinchZoom } from '../hooks/usePinchZoom';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import { getThumbnail, isThumbnailUpgrading, getGlobalScrollState, setGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge';
import { getGlobalCache } from '../utils/thumbnailCache';
import { useLayout, LayoutItem, GetFileNode } from './useLayoutHook';
import { Folder, Check, Loader2 } from 'lucide-react';
import { CircularProgressOverlay } from './CircularProgressOverlay';
import { PullToRefreshIndicator } from './PullToRefreshIndicator';
import { getRemoteThumbnailUrl, subscribeRemoteChange } from '../utils/remoteSource';
import MarqueeText from './MarqueeText';

interface FoldersOverviewProps {
  roots: string[];
  getFileNode: GetFileNode;
  resourceRoot?: string;
  cachePath?: string;
  onFolderClick: (folderId: string) => void;
  thumbnailSize: number;
  onThumbnailSizeChange?: (size: number) => void;
  t: (key: string) => string;
  isLoadingImages?: boolean;
  /** 加载中提示文案（如"正在重新连接「平板」…"），缺省用 t('empty.loading')。 */
  loadingLabel?: string;
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
  panelWidthRem?: number;
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
    if (!effectiveCoverPath) return;

    // 远程封面（桌面端服务/安卓设备）：直接生成 URL，不走 Tauri getThumbnail。
    // 注意：URL 内嵌访问 token，**不写入** thumbnailCache——断线时解析为空串、
    // 重连后 token 也会更换，缓存下来会让封面在重连后依然是裂图。
    if (effectiveCoverPath.startsWith('lan://') || effectiveCoverPath.startsWith('android://')) {
      setCoverSrc(getRemoteThumbnailUrl(effectiveCoverPath));
      return;
    }

    const cache = getGlobalCache();
    const cached = cache.get(effectiveCoverPath);
    if (cached) {
      if (cached !== coverSrc) setCoverSrc(cached);
      return;
    }

    if (!resourceRoot) return;

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

  // 远程封面：设备重连/token 刷新后重新生成 URL（断线时拿到的是空串）
  useEffect(() => {
    if (!effectiveCoverPath) return;
    if (!effectiveCoverPath.startsWith('lan://') && !effectiveCoverPath.startsWith('android://')) return;
    const refresh = () => {
      const url = getRemoteThumbnailUrl(effectiveCoverPath);
      setCoverSrc((prev) => (prev === url ? prev : url));
    };
    refresh();
    return subscribeRemoteChange(refresh);
  }, [effectiveCoverPath]);

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
          isSelected
            ? 'bg-blue-100 dark:bg-blue-500/10 shadow-[0_4px_6px_-1px_rgba(59,130,246,0.2)] dark:shadow-[0_4px_6px_-1px_rgba(59,130,246,0.3)] after:absolute after:inset-0 after:rounded-lg after:border-[3px] after:border-blue-400 dark:after:border-blue-500 after:pointer-events-none after:z-10'
            : ''
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
        <div
          className={`inline-block max-w-full text-center px-2 py-0.5 rounded-md text-xs font-semibold leading-tight transition-colors duration-300 ${
            isSelected
              ? 'bg-[#2563EB] text-white'
              : 'text-gray-700 dark:text-gray-300'
          }`}
        >
          <MarqueeText active={isSelected} title={folder.name}>{folder.name}</MarqueeText>
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
  getFileNode,
  resourceRoot,
  cachePath,
  onFolderClick,
  thumbnailSize,
  onThumbnailSizeChange,
  t,
  isLoadingImages,
  loadingLabel,
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
  panelWidthRem,
}: FoldersOverviewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const pullDistanceRef = useRef(0);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const hasRestoredRef = useRef(false);
  const isRestoringScrollRef = useRef(false);
  const scrollbarStyleInjectedRef = useRef(false);
  const containerWidthRef = useRef(0);
  const widthDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevPanelWidthRemRef = useRef<number | undefined>(undefined);
  // 跟踪 isVisible：ResizeObserver 在容器隐藏时仍会触发（display:none→width=0），
  // 用 ref 在回调内读取最新值，避免把 0 写入 containerWidth 触发不必要的布局重算。
  const isVisibleRef = useRef(isVisible);
  isVisibleRef.current = isVisible;

  const isAndroid = resourceRoot === 'android_media_store';
  const scrollStateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastScrollTimeRef = useRef(0);
  const lastScrollTopRef = useRef(0);
  const prevSortedIdsRef = useRef<string[]>([]);
  const prevAspectRatiosRef = useRef<Record<string, number>>({});
  const prevLayoutInputsRef = useRef({ containerWidth: 0, thumbnailSize: 0, layoutMode: '', sortBy: '', sortDirection: '', folderCount: 0 });
  const prevLayoutPositionsRef = useRef<Map<string, { x: number; y: number }>>(new Map());
  const prevScrollTopForFlipRef = useRef(0);
  // Layout transition tracking: increases buffer so cards in the NEW viewport
  // are mounted before the FLIP WAAPI animation runs.
  const [isLayoutTransitioning, setIsLayoutTransitioning] = useState(false);
  const isLayoutTransitioningRef = useRef(false);
  const prevThumbnailSizeRef = useRef(thumbnailSize);
  const prevContainerWidthRef = useRef(containerWidth);
  const transitionBufferRef = useRef(400);
  const transitionResetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flipDebugLogRef = useRef(0);
  // Two-phase FLIP: when scrollDelta is large, phase 0 expands buffer + updates scrollTop
  // (mounts cards at new viewport), phase 1 runs the WAAPI animation.
  const [flipPhase, setFlipPhase] = useState(0);
  const pendingFlipDataRef = useRef<{ oldScrollTop: number; newScrollTop: number } | null>(null);

  const {
    isRefreshing: isPullRefreshing,
    isComplete: isPullComplete,
  } = usePullToRefresh({
    containerRef,
    contentRef,
    pullDistanceRef,
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
    // 隐藏时短路返回空数组，跳过 roots.map(getFileNode(id)) + 递归 hasMatchingChild。
    // 这会级联跳过 sortedFolderIds、sortCoverOverrides、folderAspectRatios、useLayout 的计算。
    if (!isVisible) return [];
    const nodes = roots
      .map(id => getFileNode(id))
      .filter((f): f is FileNode => !!f && f.type === 'folder');

    if (!dateFilter?.start || !dateFilter?.end) return nodes;

    const start = new Date(dateFilter.start).getTime();
    const end = new Date(dateFilter.end).getTime();
    const min = Math.min(start, end);
    const max = Math.max(start, end) + 86400000;

    const hasMatchingChild = (folder: FileNode): boolean => {
      const children = folder.children || [];
      for (const childId of children) {
        const child = getFileNode(childId);
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
  }, [roots, getFileNode, dateFilter, isVisible]);

  const sortedFolderIds = useMemo(() => {
    const sorted = [...folderNodes]
      .sort((a, b) => {
        let res = 0;
        if (sortBy === 'date') {
          res = (a.createdAt || '').localeCompare(b.createdAt || '');
        } else if (sortBy === 'size') {
          res = ((a.imageCount ?? a.size ?? 0) - (b.imageCount ?? b.size ?? 0));
        } else {
          res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
        }
        return res * (sortDirection === 'asc' ? 1 : -1);
      });
    // Pin __lan_root_images__ virtual folder to the top, unaffected by sort mode
    const rootImgIdx = sorted.findIndex(f => f.id === '__lan_root_images__');
    if (rootImgIdx > 0) {
      const [rootImg] = sorted.splice(rootImgIdx, 1);
      sorted.unshift(rootImg);
    }
    return sorted.map(f => f.id);
  }, [folderNodes, sortBy, sortDirection]);

  if (isAndroid && isVisible) {
    const prev = prevSortedIdsRef.current;
    if (prev.length !== sortedFolderIds.length || prev.some((id, i) => id !== sortedFolderIds[i])) {
      const added = sortedFolderIds.filter(id => !prev.includes(id));
      const removed = prev.filter(id => !sortedFolderIds.includes(id));
      const moved: string[] = [];
      if (added.length === 0 && removed.length === 0 && prev.length === sortedFolderIds.length) {
        for (let i = 0; i < prev.length; i++) {
          if (prev[i] !== sortedFolderIds[i]) {
            moved.push(`${getFileNode(prev[i])?.name || prev[i]}→${getFileNode(sortedFolderIds[i])?.name || sortedFolderIds[i]}`);
          }
        }
      }
      console.log(`[FoldersOverview] sortedFolderIds CHANGED: ${prev.length}→${sortedFolderIds.length}, sortBy=${sortBy}, sortDir=${sortDirection}, layout=${layoutMode}, folders=${folderNodes.length}` +
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
        .map(id => getFileNode(id))
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
  }, [folderNodes, getFileNode, sortBy, sortDirection]);

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

  if (isAndroid && isVisible) {
    const prev = prevAspectRatiosRef.current;
    const changedIds = Object.keys(folderAspectRatios).filter(id => prev[id] !== folderAspectRatios[id]);
    const newIds = Object.keys(folderAspectRatios).filter(id => !(id in prev));
    const removedIds = Object.keys(prev).filter(id => !(id in folderAspectRatios));
    if (changedIds.length > 0 || newIds.length > 0 || removedIds.length > 0) {
      console.log(`[FoldersOverview] aspectRatios CHANGED: ${Object.keys(prev).length}→${Object.keys(folderAspectRatios).length}` +
        `, changed=${changedIds.length}` +
        `, new=${newIds.length}` +
        `, removed=${removedIds.length}` +
        (changedIds.length > 0 && changedIds.length <= 5 ? ` [${changedIds.map(id => `${getFileNode(id)?.name}:${prev[id]?.toFixed(2)}→${folderAspectRatios[id]?.toFixed(2)}`).join(', ')}]` : ''));
      prevAspectRatiosRef.current = folderAspectRatios;
    }
  }

  if (isAndroid && isVisible) {
    const prev = prevLayoutInputsRef.current;
    const curr = { containerWidth, thumbnailSize, layoutMode, sortBy, sortDirection, folderCount: sortedFolderIds.length };
    if (prev.containerWidth !== curr.containerWidth || prev.thumbnailSize !== curr.thumbnailSize || prev.layoutMode !== curr.layoutMode || prev.sortBy !== curr.sortBy || prev.sortDirection !== curr.sortDirection || prev.folderCount !== curr.folderCount) {
      const changes: string[] = [];
      if (prev.containerWidth !== curr.containerWidth) changes.push(`width=${prev.containerWidth}→${curr.containerWidth}`);
      if (prev.thumbnailSize !== curr.thumbnailSize) changes.push(`thumbSize=${prev.thumbnailSize}→${curr.thumbnailSize}`);
      if (prev.layoutMode !== curr.layoutMode) changes.push(`layout=${prev.layoutMode}→${curr.layoutMode}`);
      if (prev.sortBy !== curr.sortBy) changes.push(`sortBy=${prev.sortBy}→${curr.sortBy}`);
      if (prev.sortDirection !== curr.sortDirection) changes.push(`sortDir=${prev.sortDirection}→${curr.sortDirection}`);
      if (prev.folderCount !== curr.folderCount) changes.push(`folders=${prev.folderCount}→${curr.folderCount}`);
      console.log(`[FoldersOverview] LAYOUT INPUTS CHANGED: ${changes.join(', ')}`);
      prevLayoutInputsRef.current = curr;
    }
  }

  const { layout, totalHeight } = useLayout(
    isVisible ? sortedFolderIds : [],
    getFileNode,
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

  // Sync isLayoutTransitioning to ref for use inside FLIP effect (avoids stale closure / extra deps)
  useEffect(() => {
    isLayoutTransitioningRef.current = isLayoutTransitioning;
  }, [isLayoutTransitioning]);

  // Watch layout input changes: set transition state + predict buffer size so the
  // new viewport's cards are mounted BEFORE the new layout arrives from the worker.
  // Only activates for thumbnail size changes — width changes (panel toggle) are
  // handled by CSS transition + predicted width, no buffer increase needed.
  useEffect(() => {
    const prevThumb = prevThumbnailSizeRef.current;
    const prevWidth = prevContainerWidthRef.current;
    const thumbChanged = prevThumb !== thumbnailSize;
    const widthChanged = prevWidth !== containerWidth && prevWidth > 0 && containerWidth > 0;

    if (!thumbChanged && !widthChanged) return;
    // Skip if container not visible (width=0)
    if (containerWidth <= 0) {
      prevThumbnailSizeRef.current = thumbnailSize;
      prevContainerWidthRef.current = containerWidth;
      return;
    }
    // Only increase buffer for thumbnail size changes (large scroll adjustments).
    // For width-only changes (panel toggle), CSS transition + predicted width handles it.
    if (!thumbChanged) {
      prevThumbnailSizeRef.current = thumbnailSize;
      prevContainerWidthRef.current = containerWidth;
      return;
    }

    const currentScroll = containerRef.current?.scrollTop || 0;
    const ratio = prevThumb > 0 ? thumbnailSize / prevThumb : 1;
    const predictedDelta = Math.abs(currentScroll * (1 - ratio));
    const buffer = Math.min(3000, Math.max(1500, predictedDelta + 800));

    transitionBufferRef.current = buffer;
    setIsLayoutTransitioning(true);
    console.log(`[FLIP-FoldersOverview] TRANSITION START: thumb=${prevThumb}→${thumbnailSize}, width=${prevWidth.toFixed(0)}→${containerWidth.toFixed(0)}, scroll=${currentScroll.toFixed(0)}, predictedDelta=${predictedDelta.toFixed(0)}, buffer=${buffer.toFixed(0)}`);

    if (transitionResetTimerRef.current) clearTimeout(transitionResetTimerRef.current);
    transitionResetTimerRef.current = setTimeout(() => {
      setIsLayoutTransitioning(false);
      transitionBufferRef.current = 400;
      console.log(`[FLIP-FoldersOverview] TRANSITION END (timeout 600ms)`);
    }, 600);

    prevThumbnailSizeRef.current = thumbnailSize;
    prevContainerWidthRef.current = containerWidth;
  }, [thumbnailSize, containerWidth]);

  // FLIP animation: anchor at viewport top instead of page top.
  // When layout changes, adjust scrollTop so the card at viewport top stays in place,
  // then use WAAPI to animate visible cards from old screen positions to new ones.
  useLayoutEffect(() => {
    const prevPositions = prevLayoutPositionsRef.current;
    const logId = ++flipDebugLogRef.current;

    // First render or empty layout: just record positions
    if (prevPositions.size === 0 || layout.length === 0) {
      const map = new Map<string, { x: number; y: number }>();
      layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
      prevLayoutPositionsRef.current = map;
      prevScrollTopForFlipRef.current = containerRef.current?.scrollTop || 0;
      return;
    }

    // Check if any position actually changed
    let hasPositionChanged = false;
    for (const item of layout) {
      const prev = prevPositions.get(item.id);
      if (!prev || Math.abs(prev.x - item.x) > 0.5 || Math.abs(prev.y - item.y) > 0.5) {
        hasPositionChanged = true;
        break;
      }
    }
    if (!hasPositionChanged) {
      prevScrollTopForFlipRef.current = containerRef.current?.scrollTop || 0;
      return;
    }

    // If most items changed (e.g., tab switch), skip FLIP to avoid animating unrelated cards
    const commonCount = layout.filter(item => prevPositions.has(item.id)).length;
    if (commonCount < layout.length * 0.5) {
      console.log(`[FLIP-FoldersOverview] #${logId} SKIP: too many new items (common=${commonCount}/${layout.length})`);
      const map = new Map<string, { x: number; y: number }>();
      layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
      prevLayoutPositionsRef.current = map;
      prevScrollTopForFlipRef.current = containerRef.current?.scrollTop || 0;
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    // BUG FIX #1: Use LIVE scrollTop from the DOM, not the stale prevScrollTopForFlipRef.
    // prevScrollTopForFlipRef only updates when this effect runs, so if the user scrolled
    // without a layout change, it holds an old value → wrong anchor → newScrollTop=0 → jump to top.
    const oldScrollTop = container.scrollTop;
    const staleScrollTop = prevScrollTopForFlipRef.current;

    console.log(`[FLIP-FoldersOverview] #${logId} START: layout=${layout.length}, prevPos=${prevPositions.size}, common=${commonCount}`);
    console.log(`[FLIP-FoldersOverview] #${logId}   scrollTop: live=${oldScrollTop.toFixed(1)}, staleRef=${staleScrollTop.toFixed(1)}, drift=${(oldScrollTop - staleScrollTop).toFixed(1)}`);

    // Find anchor card: the card closest to viewport top (oldScreenY >= 0) in previous layout
    let anchorId: string | null = null;
    let anchorOldScreenY = 0;
    let minScreenY = Infinity;
    prevPositions.forEach((pos, id) => {
      const screenY = pos.y - oldScrollTop;
      if (screenY >= -50 && screenY < minScreenY) {
        minScreenY = screenY;
        anchorId = id;
        anchorOldScreenY = screenY;
      }
    });

    // Calculate new scroll top so the anchor card stays at the same screen position
    let newScrollTop = oldScrollTop;
    if (anchorId) {
      const anchorNew = layout.find(item => item.id === anchorId);
      if (anchorNew) {
        newScrollTop = Math.max(0, anchorNew.y - anchorOldScreenY);
      }
    }

    const anchorOldY = anchorId ? prevPositions.get(anchorId)?.y : undefined;
    const anchorNewY = anchorId ? layout.find(i => i.id === anchorId)?.y : undefined;
    const scrollDelta = newScrollTop - oldScrollTop;
    console.log(`[FLIP-FoldersOverview] #${logId}   anchor: id=${(anchorId || '').slice(0, 12)}, oldY=${anchorOldY?.toFixed(0)}, screenY=${anchorOldScreenY.toFixed(0)}, newY=${anchorNewY?.toFixed(0)}, newScroll=${newScrollTop.toFixed(0)}, scrollDelta=${scrollDelta.toFixed(0)}`);

    // If scroll adjustment is negligible, CSS transition on transform handles the animation.
    // No need for WAAPI — this avoids perf cost on panel toggle (width-only changes).
    if (Math.abs(scrollDelta) <= 1) {
      console.log(`[FLIP-FoldersOverview] #${logId} SKIP WAAPI: |scrollDelta|≤1, CSS transition handles it`);
      const map = new Map<string, { x: number; y: number }>();
      layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
      prevLayoutPositionsRef.current = map;
      prevScrollTopForFlipRef.current = oldScrollTop;
      if (flipPhase === 1) setFlipPhase(0);
      return;
    }

    // Two-phase FLIP: when scrollDelta is large, the new viewport cards aren't mounted yet
    // (visibleItems was computed with old scrollTop). Phase 0 updates scrollTop state so
    // visibleItems includes new viewport cards. Phase 1 runs the WAAPI animation after
    // re-render. NOTE: buffer is NOT expanded here — old viewport cards' positions are
    // already recorded in prevPositions, so they don't need to be in the DOM. Only new
    // viewport cards need mounting, and the existing transition buffer handles that.
    // Skip Phase 0 when the new viewport is already covered by the current buffer (e.g.,
    // width-only changes with small scrollDelta) — avoids an unnecessary re-render that
    // causes mid-animation stutter.
    const containerHeight = container.clientHeight || 0;
    const currentBuffer = transitionBufferRef.current;
    const oldBufferMin = oldScrollTop - currentBuffer;
    const oldBufferMax = oldScrollTop + containerHeight + currentBuffer;
    const newViewportCovered = newScrollTop >= oldBufferMin && (newScrollTop + containerHeight) <= oldBufferMax;

    if (flipPhase === 0 && !newViewportCovered) {
      console.log(`[FLIP-FoldersOverview] #${logId} PHASE 0: scroll ${oldScrollTop.toFixed(0)}→${newScrollTop.toFixed(0)}, delta=${scrollDelta.toFixed(0)} (buffer kept at ${currentBuffer})`);
      pendingFlipDataRef.current = { oldScrollTop, newScrollTop };
      setScrollTop(newScrollTop);
      setFlipPhase(1);
      return;
    }

    // Phase 1: run FLIP animation
    let actualOldScrollTop = oldScrollTop;
    let actualNewScrollTop = newScrollTop;
    if (flipPhase === 1 && pendingFlipDataRef.current) {
      actualOldScrollTop = pendingFlipDataRef.current.oldScrollTop;
      actualNewScrollTop = pendingFlipDataRef.current.newScrollTop;
      pendingFlipDataRef.current = null;
      setFlipPhase(0);
      console.log(`[FLIP-FoldersOverview] #${logId} PHASE 1: oldScroll=${actualOldScrollTop.toFixed(0)}, newScroll=${actualNewScrollTop.toFixed(0)}`);
    }

    // Adjust scroll position instantly (before paint, so no visual jump)
    container.scrollTop = actualNewScrollTop;

    // Apply WAAPI FLIP animation only to cards near old OR new viewport.
    // visibleItems may include many cards (large buffer), but only animate relevant ones.
    const viewportPadding = 400;
    const oldVpMin = actualOldScrollTop - viewportPadding;
    const oldVpMax = actualOldScrollTop + containerHeight + viewportPadding;
    const newVpMin = actualNewScrollTop - viewportPadding;
    const newVpMax = actualNewScrollTop + containerHeight + viewportPadding;

    let animatedCount = 0;
    let notFoundCount = 0;
    let skippedCount = 0;
    visibleItems.forEach(item => {
      const prev = prevPositions.get(item.id);
      if (!prev) return;

      const inOldVp = item.y < oldVpMax && item.y + item.height > oldVpMin;
      const inNewVp = item.y < newVpMax && item.y + item.height > newVpMin;
      if (!inOldVp && !inNewVp) {
        skippedCount++;
        return;
      }

      const el = container.querySelector(`[data-flip-id="${item.id}"]`) as HTMLElement | null;
      if (!el) {
        notFoundCount++;
        return;
      }

      const oldScreenY = prev.y - actualOldScrollTop;
      const newScreenY = item.y - actualNewScrollTop;
      const deltaY = oldScreenY - newScreenY;
      const deltaX = prev.x - item.x;

      if (Math.abs(deltaY) < 1 && Math.abs(deltaX) < 1) {
        skippedCount++;
        return;
      }

      el.animate(
        [
          { transform: `translate(${item.x + deltaX}px, ${item.y + deltaY}px)` },
          { transform: `translate(${item.x}px, ${item.y}px)` },
        ],
        {
          duration: 300,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'none',
        }
      );
      animatedCount++;
    });

    console.log(`[FLIP-FoldersOverview] #${logId}   WAAPI: animated=${animatedCount}, notFound=${notFoundCount}, skipped=${skippedCount}, visibleTotal=${visibleItems.length}`);

    // Update refs for next layout change
    const map = new Map<string, { x: number; y: number }>();
    layout.forEach(item => map.set(item.id, { x: item.x, y: item.y }));
    prevLayoutPositionsRef.current = map;
    prevScrollTopForFlipRef.current = actualNewScrollTop;

    // Update scrollTop state (WAAPI animation overrides inline transform, so re-render is safe)
    setScrollTop(actualNewScrollTop);
    onScrollTopChange?.(actualNewScrollTop);

    // Reset transition state after animation completes
    if (isLayoutTransitioningRef.current) {
      if (transitionResetTimerRef.current) clearTimeout(transitionResetTimerRef.current);
      transitionResetTimerRef.current = setTimeout(() => {
        setIsLayoutTransitioning(false);
        transitionBufferRef.current = 400;
        console.log(`[FLIP-FoldersOverview] #${logId} TRANSITION END (post-FLIP 400ms)`);
      }, 400);
    }
  }, [layout, flipPhase]);

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
        const newWidth = entry.contentRect.width;
        const newHeight = entry.contentRect.height;
        setContainerHeight(newHeight);

        // 容器隐藏（display:none）会报告 width=0。如果当前已有非零宽度，
        // 不要把 0 写入 state——这会触发 useLayout 重算（items=0 分支清空布局），
        // 紧接着容器恢复可见时又触发一次重算（0→实际宽度）。日志中 1061.64→0→1062 即此问题。
        if (newWidth <= 0) continue;

        // 亚像素抖动（scrollbar 出现/消失导致 1062→1061.64）不会改变取整后的宽度，
        // useLayoutHook 已用 Math.round 处理；这里再加 1px 阈值提前过滤，
        // 避免触发 setContainerWidth → 组件重渲染 → LAYOUT INPUTS CHANGED 日志。
        if (Math.abs(newWidth - containerWidthRef.current) < 1) continue;

        containerWidthRef.current = newWidth;
        if (widthDebounceRef.current) clearTimeout(widthDebounceRef.current);
        widthDebounceRef.current = setTimeout(() => {
          // 二次检查可见性：debounce 期间视图可能已切走
          if (!isVisibleRef.current) return;
          setContainerWidth(containerWidthRef.current);
        }, 60);
      }
    });

    if (containerRef.current) {
      observer.observe(containerRef.current);
      setContainerWidth(containerRef.current.clientWidth);
      setContainerHeight(containerRef.current.clientHeight);
      containerWidthRef.current = containerRef.current.clientWidth;
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
      if (widthDebounceRef.current) clearTimeout(widthDebounceRef.current);
    };
  }, [isAndroid, onScrollTopChange]);

  // Re-measure container dimensions when the view becomes visible
  // (switching from display:none to display:contents leaves stale width/height=0)
  useEffect(() => {
    if (isVisible && containerRef.current) {
      const w = containerRef.current.clientWidth;
      const h = containerRef.current.clientHeight;
      if (w > 0) {
        setContainerWidth(w);
        setContainerHeight(h);
        containerWidthRef.current = w;
      }
    }
  }, [isVisible]);

  // Predict container width immediately when panels toggle, so card transitions
  // run simultaneously with the panel animation instead of waiting for ResizeObserver
  useEffect(() => {
    if (panelWidthRem === undefined) return;
    if (prevPanelWidthRemRef.current !== undefined && prevPanelWidthRemRef.current !== panelWidthRem) {
      const remPx = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      const deltaRem = prevPanelWidthRemRef.current - panelWidthRem;
      const deltaPx = deltaRem * remPx;
      if (containerWidthRef.current > 0) {
        const predictedWidth = containerWidthRef.current + deltaPx;
        setContainerWidth(predictedWidth);
        containerWidthRef.current = predictedWidth;
      }
    }
    prevPanelWidthRemRef.current = panelWidthRem;
  }, [panelWidthRem]);

  const visibleItems = useMemo(() => {
      const buffer = isLayoutTransitioning ? transitionBufferRef.current : 400;
      const minY = scrollTop - buffer;
      const maxY = scrollTop + containerHeight + buffer;
      return layout.filter(item => item.y < maxY && item.y + item.height > minY);
  }, [layout, scrollTop, containerHeight, isLayoutTransitioning]);

  return (
    <div
      id="folders-scroll"
      ref={containerRef}
      className="w-full h-full overflow-y-auto overflow-x-hidden relative"
      style={isAndroid ? { scrollbarWidth: 'none', msOverflowStyle: 'none' } : undefined}
    >
      {isAndroid && (
        <PullToRefreshIndicator
          isRefreshing={isPullRefreshing}
          isComplete={isPullComplete}
          pullDistanceRef={pullDistanceRef}
        />
      )}
      <div
        ref={contentRef}
        className="relative w-full"
        style={{
          height: totalHeight > 0 ? totalHeight : 'auto',
          minHeight: '100%',
        }}
      >
        {visibleItems.map(pos => {
            const folder = getFileNode(pos.id);
            if (!folder) return null;
            return (
            <div
              key={pos.id}
              data-flip-id={pos.id}
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
                folder={folder}
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
            );
        })}
      </div>

      {/*
        空状态 / 重连中：以绝对定位覆盖在滚动容器可视区中央，**不占文档高度**。
        原先它是普通块级元素，排在 min-height:100% 的内容区之后，被挤到首屏
        之外（必须滚动才能看到），并且凭空多出 256px 高度导致空列表也出滚动条。
      */}
      {sortedFolderIds.length === 0 && (
        <div className="absolute inset-0 flex flex-col items-center justify-center text-gray-400 dark:text-gray-500 pointer-events-none">
          {isLoadingImages ? (
            <>
              <Loader2 size={40} strokeWidth={1.5} className="animate-spin text-blue-500 dark:text-blue-400" />
              <p className="mt-3 text-sm">{loadingLabel || t('empty.loading')}</p>
            </>
          ) : (
            <>
              <Folder size={48} strokeWidth={1} />
              <p className="mt-3 text-sm">{t('empty.noFolders')}</p>
            </>
          )}
        </div>
      )}
    </div>
  );
});

export { FoldersOverview };
