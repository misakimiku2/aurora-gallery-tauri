import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Maximize, Maximize2, Minimize2, RefreshCcw, Magnet, Move, Scan } from 'lucide-react';
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import { FileNode, Person, Topic, FileType } from '../types';
import { setWindowMinSize, setAndroidImmersiveMode, setAndroidStatusBar } from '../api/tauri-bridge';
import { isTauriEnvironment } from '../utils/environment';
import { isAndroidSync } from '../utils/androidPlatform';
import { ComparisonItem, Annotation, ComparisonSession } from './comparer/types';
import { resolveImageSrc } from './comparer/imageSource';
import { getBestMipmapLevel, createMipmapLevels } from './comparer/mipmap';
import { rotatePointAround, pointInRotatedItem, worldToLocalPoint, computeAABB, aabbOverlap } from './comparer/geometry';
import { packImages } from './comparer/layout';
import { getFileExtension, getMimeType, serializeSessionToZip, readSessionFile, extractZipImage } from './comparer/session-io';
import { zoomAtPoint, computeFitTransform } from './comparer/viewport';
import { EditOverlay } from './comparer/EditOverlay';
import { AnnotationLayer } from './comparer/AnnotationLayer';
import { ComparerContextMenu } from './comparer/ComparerContextMenu';
import { ComparerToolbar } from './comparer/ComparerToolbar';
import { AddImageModal } from './modals/AddImageModal';
import { writeFile } from '@tauri-apps/plugin-fs';
import { save, open } from '@tauri-apps/plugin-dialog';
import { Plus, Save, FolderOpen, Trash2 } from 'lucide-react';
import { useToasts } from '../hooks/useToasts';
import { useImageLoader } from '../hooks/useImageLoader';
import { useComparerShortcuts } from '../hooks/useComparerShortcuts';

interface ImageComparerProps {
  selectedFileIds: string[];
  files: Record<string, FileNode>;
  people?: Record<string, Person>;
  topics?: Record<string, Topic>;
  customTags?: string[];
  resourceRoot?: string;
  cachePath?: string;
  onClose: () => void;
  onReady?: () => void;
  onLayoutToggle?: (part: 'sidebar' | 'metadata') => void;
  onNavigateBack?: () => void;
  onCloseTab?: () => void;
  layoutProp?: { isSidebarVisible?: boolean; isMetadataVisible?: boolean };
  canGoBack?: boolean;
  t: (key: string) => string;
  onSelect?: (id: string) => void;
  onSelectedFileIdsChange?: (ids: string[]) => void;
  sessionName?: string;
  onSessionNameChange?: (name: string) => void;
  onReferenceModeChange?: (isReferenceMode: boolean) => void;
  isReferenceMode?: boolean;
  isActiveTab?: boolean;
}

export const ImageComparer: React.FC<ImageComparerProps> = ({
  selectedFileIds,
  files,
  people = {},
  topics = {},
  customTags = [],
  resourceRoot,
  cachePath,
  onClose,
  onReady,
  t,
  onLayoutToggle,
  onNavigateBack,
  onCloseTab,
  layoutProp,
  canGoBack,
  onSelect,
  onSelectedFileIdsChange,
  sessionName: sessionNameProp,
  onSessionNameChange,
  onReferenceModeChange,
  isReferenceMode: isReferenceModeProp,
  isActiveTab = true
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 变换状态
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });

  const [isDragging, setIsDragging] = useState(false);
  const isDraggingRef = useRef(false);
  const dragStartRef = useRef({ x: 0, y: 0 });
  const isAndroid = isAndroidSync();
  const [isEditMode, setIsEditMode] = useState(false);
  const isEditModeRef = useRef(false);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const pinchStateRef = useRef<{
    active: boolean;
    initialDistance: number;
    initialMidpoint: { x: number; y: number };
    initialTransform: { x: number; y: number; scale: number };
  }>({ active: false, initialDistance: 0, initialMidpoint: { x: 0, y: 0 }, initialTransform: { x: 0, y: 0, scale: 1 } });
  const singleFingerDragRef = useRef<{
    active: boolean;
    startX: number;
    startY: number;
    initialTransform: { x: number; y: number; scale: number };
  }>({ active: false, startX: 0, startY: 0, initialTransform: { x: 0, y: 0, scale: 1 } });
  const lastTapRef = useRef<{ x: number; y: number; time: number; targetId: string | null } | null>(null);
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [activeImageIds, setActiveImageIds] = useState<string[]>([]);
  const [manualLayouts, setManualLayouts] = useState<Record<string, { x: number, y: number, width: number, height: number, rotation: number }>>({});
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pendingAnnotation, setPendingAnnotation] = useState<{ imageId: string, x: number, y: number } | null>(null);
  const [zOrderIds, setZOrderIds] = useState<string[]>([]);
  const [menuTargetId, setMenuTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);
  const initializedRef = useRef(false);
  const onReadyCalledRef = useRef(false);
  const userInteractedRef = useRef(false);
  const autoZoomAppliedRef = useRef(false);
  const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>(() => selectedFileIds.slice());
  // 用于区分是外部 selectedFileIds 变化还是内部 activeImageIds 变化
  const isInternalSelectionChangeRef = useRef(false);
  const [isSnappingEnabled, setIsSnappingEnabled] = useState(true);
  const [sessionName, setSessionName] = useState(sessionNameProp || "画布01");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isAddImageModalOpen, setIsAddImageModalOpen] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<Record<string, FileNode>>({});
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; x: number; y: number; active: boolean } | null>(null);
  const potentialClearSelectionRef = useRef(false);
  const shouldAutoFitAfterLoadRef = useRef(false);

  useEffect(() => {
    if (isAndroid && activeImageIds.length === 0) {
      setIsEditMode(false);
      isEditModeRef.current = false;
    }
  }, [activeImageIds, isAndroid]);
  // Toast notifications
  const { toast, showToast } = useToasts();
  // Use internal state if props not provided, otherwise use props
  const [internalReferenceMode, setInternalReferenceMode] = useState(false);
  const isReferenceMode = isReferenceModeProp !== undefined ? isReferenceModeProp : internalReferenceMode;
  const setIsReferenceMode = (value: boolean) => {
    if (isReferenceModeProp === undefined) {
      setInternalReferenceMode(value);
    }
    onReferenceModeChange?.(value);
  };

  // Android 全屏按钮可见性
  const [fullscreenBtnVisible, setFullscreenBtnVisible] = useState(true);
  const fullscreenBtnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showFullscreenBtn = useCallback(() => {
    setFullscreenBtnVisible(true);
    if (fullscreenBtnTimerRef.current) {
      clearTimeout(fullscreenBtnTimerRef.current);
    }
    fullscreenBtnTimerRef.current = setTimeout(() => {
      setFullscreenBtnVisible(false);
    }, 3000);
  }, []);

  // 切换全屏模式时显示按钮
  useEffect(() => {
    if (isAndroid && isReferenceMode) {
      showFullscreenBtn();
    }
  }, [isAndroid, isReferenceMode, showFullscreenBtn]);

  // 清理定时器
  useEffect(() => {
    return () => {
      if (fullscreenBtnTimerRef.current) {
        clearTimeout(fullscreenBtnTimerRef.current);
      }
    };
  }, []);
  // Use ref to store callbacks to avoid re-render issues
  const layoutPropRef = useRef(layoutProp);
  const onLayoutToggleRef = useRef(onLayoutToggle);
  const onReferenceModeChangeRef = useRef(onReferenceModeChange);
  useEffect(() => {
    layoutPropRef.current = layoutProp;
    onLayoutToggleRef.current = onLayoutToggle;
    onReferenceModeChangeRef.current = onReferenceModeChange;
  }, [layoutProp, onLayoutToggle, onReferenceModeChange]);

  // 使用 ref 存储 transform 以避免动画循环中的闭包问题
  const transformRef = useRef(transform);
  useEffect(() => {
    transformRef.current = transform;
  }, [transform]);

  useEffect(() => {
    if (sessionNameProp && sessionNameProp !== sessionName) {
      setSessionName(sessionNameProp);
    }
  }, [sessionNameProp]);

  // Track dark mode changes
  const [isDarkMode, setIsDarkMode] = useState<boolean>(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const target = document.documentElement;
    const observer = new MutationObserver((mutations) => {
      for (const m of mutations) {
        if (m.type === 'attributes' && (m as any).attributeName === 'class') {
          const dark = target.classList.contains('dark');
          setIsDarkMode(dark);
          break;
        }
      }
    });
    observer.observe(target, { attributes: true });
    return () => observer.disconnect();
  }, []);

  const prevContainerWidthRef = useRef<number>(0);
  const prevMetadataVisibleRef = useRef<boolean | undefined>(layoutProp?.isMetadataVisible);
  const prevSidebarVisibleRef = useRef<boolean | undefined>(layoutProp?.isSidebarVisible);
  const activePanelTransitionRef = useRef<'metadata' | 'sidebar' | null>(null);
  const panelTransitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!isAndroid) return;
    const currMeta = layoutProp?.isMetadataVisible;
    const currSidebar = layoutProp?.isSidebarVisible;
    const prevMeta = prevMetadataVisibleRef.current;
    const prevSidebar = prevSidebarVisibleRef.current;
    if (currMeta !== prevMeta || currSidebar !== prevSidebar) {
      if (currMeta !== prevMeta) {
        activePanelTransitionRef.current = 'metadata';
      } else if (currSidebar !== prevSidebar) {
        activePanelTransitionRef.current = 'sidebar';
      }
      if (panelTransitionTimerRef.current) clearTimeout(panelTransitionTimerRef.current);
      panelTransitionTimerRef.current = setTimeout(() => {
        activePanelTransitionRef.current = null;
        prevMetadataVisibleRef.current = currMeta;
        prevSidebarVisibleRef.current = currSidebar;
      }, 350);
    }
    return () => {
      if (panelTransitionTimerRef.current) clearTimeout(panelTransitionTimerRef.current);
    };
  }, [layoutProp?.isMetadataVisible, layoutProp?.isSidebarVisible, isAndroid]);

  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        const newWidth = containerRef.current.clientWidth;
        const newHeight = containerRef.current.clientHeight;
        const prev = prevContainerWidthRef.current;
        if (prev && newWidth && prev !== newWidth && !isDraggingRef.current) {
          const delta = newWidth - prev;
          const transitionType = activePanelTransitionRef.current;
          if (transitionType === 'metadata') {
            setTransform(prevT => ({ ...prevT, x: prevT.x + delta }));
          } else {
            setTransform(prevT => ({ ...prevT, x: prevT.x + delta / 2 }));
          }
        }
        setContainerSize({ width: newWidth, height: newHeight });
        prevContainerWidthRef.current = newWidth;
      }
    };
    updateSize();
    let ro: ResizeObserver | null = null;
    if ((window as any).ResizeObserver && containerRef.current) {
      if (isAndroid) {
        let rafId: number | null = null;
        ro = new ResizeObserver(() => {
          if (rafId) cancelAnimationFrame(rafId);
          rafId = requestAnimationFrame(() => {
            updateSize();
            rafId = null;
          });
        });
      } else {
        ro = new ResizeObserver(() => updateSize());
      }
      ro.observe(containerRef.current);
    } else {
      window.addEventListener('resize', updateSize);
    }
    return () => {
      if (ro && containerRef.current) ro.unobserve(containerRef.current);
      if (!ro) window.removeEventListener('resize', updateSize);
    };
  }, []);

  useEffect(() => {
    if (isAndroid) return;
    const prev = prevContainerWidthRef.current;
    const curr = containerSize.width;
    if (prev && curr && prev !== curr && !isDragging) {
      const prevMeta = prevMetadataVisibleRef.current;
      const currMeta = layoutProp?.isMetadataVisible;
      if (typeof prevMeta !== 'undefined' && prevMeta !== currMeta) {
        const delta = curr - prev;
        setTransform(prevT => ({ ...prevT, x: prevT.x + delta }));
      } else {
        const delta = curr - prev;
        setTransform(prevT => ({ ...prevT, x: prevT.x + delta / 2 }));
      }
    }
    prevContainerWidthRef.current = curr;
    prevMetadataVisibleRef.current = layoutProp?.isMetadataVisible;
  }, [containerSize.width, isDragging, layoutProp?.isMetadataVisible]);

  // Filter selected files
  const imageFiles = useMemo(() => {
    return internalSelectedIds
      .map(id => sessionFiles[id] || files[id])
      .filter(file => file && file.path);
  }, [internalSelectedIds, files, sessionFiles]);

  const { imagesCache, loadingIdsRef, loadedCount, setLoadedCount, isLoadingCanvas, realLoadedCount } = useImageLoader(imageFiles, isAndroid);

  // Initialize internal selection and respond to external changes
  useEffect(() => {
    if (!initializedRef.current) {
      // 首次初始化
      initializedRef.current = true;
    }
    // 如果是内部选择变化导致的 selectedFileIds 更新，不重新初始化
    if (isInternalSelectionChangeRef.current) {
      isInternalSelectionChangeRef.current = false;
      return;
    }
    // 当 selectedFileIds 变化时，更新内部状态
    // 使用函数式更新避免依赖 files
    setInternalSelectedIds(prevIds => {
      const newIds = selectedFileIds.slice();
      // 只在有文件信息时排序，否则保持原顺序
      const sortedIds = newIds.sort((idA, idB) => {
        const a = files[idA];
        const b = files[idB];
        if (!a || !b) return 0;
        const sizeA = (a.meta?.width || 0) * (a.meta?.height || 0);
        const sizeB = (b.meta?.width || 0) * (b.meta?.height || 0);
        return sizeB - sizeA;
      });
      return sortedIds;
    });
    setZOrderIds(selectedFileIds.slice());
    imagesCache.current.clear();
    loadingIdsRef.current.clear();
    setLoadedCount(0);
    // 重置 onReady 状态，允许新的加载完成回调
    onReadyCalledRef.current = false;
  }, [selectedFileIds]); // 只监听 selectedFileIds

  // Notify parent when all images are loaded
  useEffect(() => {
    if (imageFiles.length > 0 && !isLoadingCanvas) {
      if (!onReadyCalledRef.current) {
        onReadyCalledRef.current = true;
        onReady?.();
      }
    }
  }, [isLoadingCanvas, imageFiles.length, onReady]);

  // Layout calculation
  const layout = useMemo(() => {
    if (imageFiles.length === 0)
      return { items: [], totalWidth: 0, totalHeight: 0 };

    const layoutStart = isAndroid ? performance.now() : 0;

    const items = packImages(imageFiles);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    items.forEach(item => {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.width);
      maxY = Math.max(maxY, item.y + item.height);
    });

    return {
      items: items.map(it => {
        const manual = manualLayouts[it.id];
        return {
          ...it,
          x: manual ? manual.x : it.x - minX,
          y: manual ? manual.y : it.y - minY,
          width: manual ? manual.width : it.width,
          height: manual ? manual.height : it.height,
          rotation: manual ? manual.rotation : 0
        };
      }) as ComparisonItem[],
      totalWidth: maxX - minX,
      totalHeight: maxY - minY
    };

    if (isAndroid && layoutStart > 0) {
      const layoutTime = performance.now() - layoutStart;
      console.log(`[Canvas] Layout computed: ${items.length} items, ${maxX - minX}x${maxY - minY} in ${layoutTime.toFixed(1)}ms`);
    }
  }, [imageFiles, manualLayouts]);

  // Persist computed layout positions
  useEffect(() => {
    if (layout.items.length === 0) return;
    setManualLayouts(prev => {
      let changed = false;
      const next = { ...prev };
      for (const it of layout.items) {
        if (!next[it.id]) {
          next[it.id] = { x: it.x, y: it.y, width: it.width, height: it.height, rotation: it.rotation || 0 };
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [layout.items]);

  // Auto-fit after load
  useEffect(() => {
    if (shouldAutoFitAfterLoadRef.current && layout.totalWidth > 0 && containerSize.width > 0) {
      shouldAutoFitAfterLoadRef.current = false;
      resetViewportOnly();
    }
  }, [layout.totalWidth, layout.totalHeight, containerSize.width, containerSize.height]);

  const layoutItemMap = useMemo(() => {
    const m: Record<string, ComparisonItem> = {};
    layout.items.forEach(it => (m[it.id] = it));
    return m;
  }, [layout.items]);

  const [groupBounds, setGroupBounds] = useState<{ x: number, y: number, width: number, height: number, rotation: number } | null>(null);
  const [transientGroup, setTransientGroup] = useState<ComparisonItem | null>(null);
  const isGroupEditingRef = useRef(false);

  // Re-calculate group bounds when selection changes
  useEffect(() => {
    if (activeImageIds.length <= 1) {
      setGroupBounds(null);
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const items = layout.items.filter(it => activeImageIds.includes(it.id));

    if (items.length === 0) return;

    items.forEach(it => {
      const cx = it.x + it.width / 2;
      const cy = it.y + it.height / 2;
      const corners = [
        { x: it.x, y: it.y },
        { x: it.x + it.width, y: it.y },
        { x: it.x + it.width, y: it.y + it.height },
        { x: it.x, y: it.y + it.height }
      ].map(p => rotatePointAround(p.x, p.y, cx, cy, it.rotation));

      corners.forEach(c => {
        minX = Math.min(minX, c.x);
        minY = Math.min(minY, c.y);
        maxX = Math.max(maxX, c.x);
        maxY = Math.max(maxY, c.y);
      });
    });

    setGroupBounds({
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0
    });
  }, [activeImageIds]);

  // 当 activeImageIds 变化时，同步更新父组件的 selectedFileIds
  // 这样右侧详情面板可以正确显示当前选中的图片详情
  useEffect(() => {
    // 标记为内部选择变化，避免触发 selectedFileIds 的 useEffect 重新初始化
    isInternalSelectionChangeRef.current = true;
    if (activeImageIds.length === 0) {
      // 取消选中时不发送空数组，避免覆盖 handleRemoveImage 等已发送的正确ID列表
      // 父组件的 selectedFileIds 应代表对比列表，而非当前活跃选中
      return;
    }
    // 选中了一个或多个图片，更新 selectedFileIds
    onSelectedFileIdsChange?.(activeImageIds);
  }, [activeImageIds]);

  const computeAndSetGroupBounds = () => {
    if (activeImageIds.length <= 1) {
      setGroupBounds(null);
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const items = layout.items.filter(it => activeImageIds.includes(it.id));
    if (items.length === 0) return;

    items.forEach(it => {
      const cx = it.x + it.width / 2;
      const cy = it.y + it.height / 2;
      const corners = [
        { x: it.x, y: it.y },
        { x: it.x + it.width, y: it.y },
        { x: it.x + it.width, y: it.y + it.height },
        { x: it.x, y: it.y + it.height }
      ].map(p => rotatePointAround(p.x, p.y, cx, cy, it.rotation));

      corners.forEach(c => {
        minX = Math.min(minX, c.x);
        minY = Math.min(minY, c.y);
        maxX = Math.max(maxX, c.x);
        maxY = Math.max(maxY, c.y);
      });
    });

    setGroupBounds({
      x: minX,
      y: minY,
      width: maxX - minX,
      height: maxY - minY,
      rotation: 0
    });
  };

  useEffect(() => {
    if (isGroupEditingRef.current) return;
    setTransientGroup(null);

    if (activeImageIds.length > 1) {
      computeAndSetGroupBounds();
    } else {
      setGroupBounds(null);
    }
  }, [activeImageIds]);

  const itemsOverlap = (idA: string, idB: string) => {
    const a = layoutItemMap[idA];
    const b = layoutItemMap[idB];
    if (!a || !b) return false;
    return aabbOverlap(computeAABB(a), computeAABB(b));
  };

  // 视口裁剪：计算可见图片
  const getVisibleItems = useCallback(() => {
    const viewport = {
      minX: -transform.x / transform.scale,
      minY: -transform.y / transform.scale,
      maxX: (containerSize.width - transform.x) / transform.scale,
      maxY: (containerSize.height - transform.y) / transform.scale
    };

    // 添加一些缓冲区域，避免边缘闪烁
    const buffer = Math.min(100 / transform.scale, 5000);
    viewport.minX -= buffer;
    viewport.minY -= buffer;
    viewport.maxX += buffer;
    viewport.maxY += buffer;

    const drawOrder = zOrderIds.length ? zOrderIds.filter(id => layoutItemMap[id]) : layout.items.map(it => it.id);
    return drawOrder.filter(id => {
      const item = layoutItemMap[id];
      if (!item) return false;
      const aabb = computeAABB(item);
      return aabbOverlap(aabb, viewport);
    });
  }, [transform, containerSize, zOrderIds, layoutItemMap, layout.items]);

  // Canvas 绘制函数 - 使用 requestAnimationFrame 实现平滑渲染
  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerSize.width === 0) return;

    const drawStart = isAndroid ? performance.now() : 0;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    // 只在尺寸变化时重新设置 canvas 尺寸
    if (canvas.width !== containerSize.width * dpr || canvas.height !== containerSize.height * dpr) {
      canvas.width = containerSize.width * dpr;
      canvas.height = containerSize.height * dpr;
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const isDark = isDarkMode;
    const bgColor = isDark ? '#262626' : '#ffffff';
    const dotColor = isDark ? 'rgba(156, 163, 175, 0.25)' : 'rgba(107, 114, 128, 0.2)';

    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 背景
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, containerSize.width, containerSize.height);

    // 智能点阵背景
    const baseSpacing = 40;
    let gridSize = baseSpacing * transform.scale;

    let step = 1;
    if (gridSize < 15) {
      step = Math.max(1, Math.floor(30 / gridSize));
      gridSize *= step;
    }

    if (gridSize >= 8) {
      ctx.fillStyle = dotColor;
      const offsetX = transform.x % gridSize;
      const offsetY = transform.y % gridSize;
      const radius = transform.scale < 0.2 ? 1.5 : 1.2;

      for (let x = offsetX; x < containerSize.width; x += gridSize) {
        for (let y = offsetY; y < containerSize.height; y += gridSize) {
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // 绘制图片 - 只绘制可见的
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    const visibleItems = getVisibleItems();

    for (const id of visibleItems) {
      const item = layoutItemMap[id];
      if (!item) continue;
      const cache = imagesCache.current.get(item.id);

      ctx.save();
      ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
      ctx.rotate((item.rotation * Math.PI) / 180);
      ctx.translate(-item.width / 2, -item.height / 2);

      // 绘制占位背景
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, item.width, item.height);

      if (cache) {
        const imageToDraw = getBestMipmapLevel(cache, transform.scale * (window.devicePixelRatio || 1));
        ctx.drawImage(imageToDraw, 0, 0, item.width, item.height);

        if (transform.scale > 0.05) {
          if (activeImageIds.includes(item.id)) {
            ctx.strokeStyle = '#3b82f6';
            ctx.lineWidth = 4 / transform.scale;
            ctx.strokeRect(0, 0, item.width, item.height);
          } else {
            ctx.strokeStyle = 'rgba(255,255,255,0.08)';
            ctx.lineWidth = 1 / transform.scale;
            ctx.strokeRect(0, 0, item.width, item.height);
          }
        } else if (activeImageIds.includes(item.id)) {
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 4 / transform.scale;
          ctx.strokeRect(0, 0, item.width, item.height);
        }
      }
      ctx.restore();
    }

    ctx.restore();

    if (isAndroid && drawStart > 0) {
      const drawTime = performance.now() - drawStart;
      if (drawTime > 16) {
        console.log(`[Canvas] drawCanvas: ${drawTime.toFixed(1)}ms, scale=${transform.scale.toFixed(4)}, visible=${visibleItems.length}/${layout.items.length}`);
      }
    }
  }, [transform, containerSize, isDarkMode, activeImageIds, zOrderIds, layoutItemMap, getVisibleItems, loadedCount]);

  // Canvas 绘制 effect
  useEffect(() => {
    drawCanvas();
  }, [drawCanvas]);

  // 动画系统 - 使用单个 requestAnimationFrame 循环
  const animationRef = useRef<number | null>(null);
  const animationTargetRef = useRef<{ x: number; y: number; scale: number } | null>(null);

  const startAnimation = useCallback((target: { x: number; y: number; scale: number }) => {
    // 取消之前的动画
    if (animationRef.current) {
      cancelAnimationFrame(animationRef.current);
    }

    animationTargetRef.current = target;

    let lastTime = performance.now();

    const animate = (currentTime: number) => {
      const deltaTime = currentTime - lastTime;
      lastTime = currentTime;

      const current = transformRef.current;
      const target = animationTargetRef.current;

      if (!target) return;

      // 线性插值 - 使用基于时间的缓动
      const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
      const ease = Math.min(1, deltaTime * 0.025); // 约 40ms 完成

      const newX = lerp(current.x, target.x, ease);
      const newY = lerp(current.y, target.y, ease);
      const newScale = lerp(current.scale, target.scale, ease);

      // 检查是否接近目标
      const isClose =
        Math.abs(newX - target.x) < 0.5 &&
        Math.abs(newY - target.y) < 0.5 &&
        Math.abs(newScale - target.scale) < 0.005;

      if (isClose) {
        setTransform(target);
        animationRef.current = null;
        animationTargetRef.current = null;
        return;
      }

      setTransform({ x: newX, y: newY, scale: newScale });
      animationRef.current = requestAnimationFrame(animate);
    };

    animationRef.current = requestAnimationFrame(animate);
  }, []);

  // 清理动画
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
    };
  }, []);

  // Initial auto-zoom and center
  useEffect(() => {
    if (layout.totalWidth > 0 && containerSize.width > 0 && !userInteractedRef.current && !autoZoomAppliedRef.current) {
      const newTransform = computeFitTransform(
        containerSize.width,
        containerSize.height,
        { minX: 0, minY: 0, maxX: layout.totalWidth, maxY: layout.totalHeight }
      );

      if (newTransform) {
        setTransform(newTransform);
        autoZoomAppliedRef.current = true;

        if (isAndroid) {
          console.log(`[Canvas] Auto-zoom: scale=${newTransform.scale.toFixed(4)}, content=${layout.totalWidth}x${layout.totalHeight}, container=${containerSize.width}x${containerSize.height}`);
        }
      }
    }
  }, [layout.totalWidth, layout.totalHeight, containerSize.width, containerSize.height]);

  // Mouse wheel zoom - 直接更新以获得即时响应
  const handleWheel = (e: React.WheelEvent) => {
    if (isAddImageModalOpen) return;

    const native = e.nativeEvent as WheelEvent | any;
    if (native && native.cancelable) {
      e.preventDefault();
    }
    userInteractedRef.current = true;

    if (contextMenu) {
      setContextMenu(null);
    }

    const zoomSpeed = 0.0012;
    const factor = Math.exp(-e.deltaY * zoomSpeed);

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // 直接更新 transform，不使用动画，以获得即时响应
    setTransform(prev => zoomAtPoint(prev, mouseX, mouseY, factor));
  };

  // Dragging
  const handleMouseDown = (e: React.MouseEvent) => {
    userInteractedRef.current = true;

    if (e.button === 0) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        const worldX = (mouseX - transform.x) / transform.scale;
        const worldY = (mouseY - transform.y) / transform.scale;

        const visible = zOrderIds.length ? zOrderIds.filter(id => layoutItemMap[id]) : layout.items.map(it => it.id);
        let clickedId: string | null = null;
        for (let i = visible.length - 1; i >= 0; i--) {
          const id = visible[i];
          const it = layoutItemMap[id];
          if (!it) continue;
          if (pointInRotatedItem(worldX, worldY, it)) {
            clickedId = id;
            break;
          }
        }

        if (clickedId) {
          const isCtrl = e.ctrlKey || e.metaKey;
          const isSelected = activeImageIds.includes(clickedId);

          if (isCtrl) {
            if (isSelected) {
              setActiveImageIds(prev => prev.filter(id => id !== clickedId));
            } else {
              setActiveImageIds(prev => [...prev, clickedId!]);
            }
          } else {
            if (isSelected) {
              setActiveImageIds(prev => {
                const others = prev.filter(id => id !== clickedId);
                return [...others, clickedId!];
              });
            } else {
              setActiveImageIds([clickedId]);
            }
          }

          // 在图片对比模式下，不通知父组件选择变化
          // 避免改变父组件的 selectedFileIds，从而保持画布中的所有图片
          // onSelect?.(clickedId);

          potentialClearSelectionRef.current = false;
          setMarquee(null);
        } else {
          setMarquee({ active: true, startX: mouseX, startY: mouseY, x: mouseX, y: mouseY });
          potentialClearSelectionRef.current = true;
        }
      }
    }
    else if (e.button === 1) {
      e.preventDefault();
      setIsDragging(true);
      isDraggingRef.current = true;
      dragStartRef.current = { x: e.clientX, y: e.clientY };
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;

      // 直接更新 transform，不使用动画
      setTransform(prev => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy
      }));

      dragStartRef.current = { x: e.clientX, y: e.clientY };
    }

    if (marquee && marquee.active) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;
        setMarquee(prev => prev ? { ...prev, x: mx, y: my } : prev);
      }
    }
  };

  const handleMouseUp = (e?: React.MouseEvent) => {
    setIsDragging(false);
    isDraggingRef.current = false;

    if (marquee && marquee.active) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const x1 = Math.min(marquee.startX, marquee.x);
        const y1 = Math.min(marquee.startY, marquee.y);
        const x2 = Math.max(marquee.startX, marquee.x);
        const y2 = Math.max(marquee.startY, marquee.y);

        const worldRect = {
          minX: (x1 - transform.x) / transform.scale,
          minY: (y1 - transform.y) / transform.scale,
          maxX: (x2 - transform.x) / transform.scale,
          maxY: (y2 - transform.y) / transform.scale
        };

        const ids = layout.items.filter(it => {
          const a = computeAABB(it);
          return !(a.maxX < worldRect.minX || a.minX > worldRect.maxX || a.maxY < worldRect.minY || a.minY > worldRect.maxY);
        }).map(it => it.id);

        if (ids.length > 0) {
          if (e && (e.ctrlKey || e.metaKey)) {
            setActiveImageIds(prev => {
              const set = new Set(prev);
              ids.forEach(id => set.add(id));
              return Array.from(set);
            });
          } else {
            setActiveImageIds(ids);
          }
          // 在图片对比模式下，不调用 onSelect，避免改变父组件的 selectedFileIds
          // onSelect?.(ids[ids.length - 1] || '');
        } else {
          const dx = marquee.x - marquee.startX;
          const dy = marquee.y - marquee.startY;
          const distSq = dx * dx + dy * dy;
          if (distSq < 9 && potentialClearSelectionRef.current) {
            setActiveImageIds([]);
            // 不要调用 onSelect('')，避免清空父组件的 selectedFileIds
            // 在图片对比模式下，点击空白处只是取消当前选中状态，不应该移除画布中的图片
          }
        }
      }

      setMarquee(null);
      potentialClearSelectionRef.current = false;
    } else {
      potentialClearSelectionRef.current = false;
    }
  };

  const clearLongPressTimer = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };

  const getTouchDistance = (t1: React.Touch, t2: React.Touch): number => {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const getTouchMidpoint = (t1: React.Touch, t2: React.Touch) => {
    return {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2
    };
  };

  const isTouchOnMenuOrToolbar = (target: EventTarget): boolean => {
    const el = target as HTMLElement;
    return !!(el.closest?.('[data-menu]') || el.closest?.('#comparer-toolbar'));
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (isAddImageModalOpen) return;
    if (pendingAnnotation) return;
    if (isTouchOnMenuOrToolbar(e.target)) return;
    showFullscreenBtn();

    if (e.touches.length === 2) {
      clearLongPressTimer();
      if (isEditMode) { setIsEditMode(false); isEditModeRef.current = false; }
      singleFingerDragRef.current.active = false;

      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const dist = getTouchDistance(t1, t2);
      const mid = getTouchMidpoint(t1, t2);
      const rect = containerRef.current?.getBoundingClientRect();

      pinchStateRef.current = {
        active: true,
        initialDistance: dist,
        initialMidpoint: rect ? { x: mid.x - rect.left, y: mid.y - rect.top } : { x: mid.x, y: mid.y },
        initialTransform: { ...transformRef.current }
      };

      e.preventDefault();
      return;
    }

    if (e.touches.length === 1) {
      const touch = e.touches[0];
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const mouseX = touch.clientX - rect.left;
      const mouseY = touch.clientY - rect.top;

      touchStartPosRef.current = { x: touch.clientX, y: touch.clientY, time: Date.now() };

      if (isAndroid) {
        const worldX = (mouseX - transform.x) / transform.scale;
        const worldY = (mouseY - transform.y) / transform.scale;

        const visible = zOrderIds.length ? zOrderIds.filter(id => layoutItemMap[id]) : layout.items.map(it => it.id);
        let touchedId: string | null = null;
        for (let i = visible.length - 1; i >= 0; i--) {
          const id = visible[i];
          const it = layoutItemMap[id];
          if (!it) continue;
          if (pointInRotatedItem(worldX, worldY, it)) {
            touchedId = id;
            break;
          }
        }

        if (isEditMode && touchedId && activeImageIds.includes(touchedId)) {
          // In edit mode, don't start canvas drag
        } else {
          singleFingerDragRef.current = {
            active: true,
            startX: touch.clientX,
            startY: touch.clientY,
            initialTransform: { ...transformRef.current }
          };
        }

        if (!isEditModeRef.current && activeImageIds.length > 0 && touchedId && activeImageIds.includes(touchedId)) {
          clearLongPressTimer();
          longPressTimerRef.current = setTimeout(() => {
            if (!isEditModeRef.current) {
              setIsEditMode(true);
              isEditModeRef.current = true;
              singleFingerDragRef.current.active = false;
            }
            longPressTimerRef.current = null;
          }, 500);
        }
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (isTouchOnMenuOrToolbar(e.target)) return;
    if (pinchStateRef.current.active && e.touches.length === 2) {
      e.preventDefault();
      const t1 = e.touches[0];
      const t2 = e.touches[1];
      const currentDist = getTouchDistance(t1, t2);
      const currentMid = getTouchMidpoint(t1, t2);
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;

      const midX = currentMid.x - rect.left;
      const midY = currentMid.y - rect.top;

      const { initialDistance, initialMidpoint, initialTransform } = pinchStateRef.current;
      const scaleRatio = currentDist / initialDistance;
      const newScale = Math.min(Math.max(initialTransform.scale * scaleRatio, 0.01), 20);

      const dx = midX - initialMidpoint.x;
      const dy = midY - initialMidpoint.y;

      const scaleChange = newScale / initialTransform.scale;
      const newX = midX - (initialMidpoint.x - initialTransform.x) * scaleChange + dx;
      const newY = midY - (initialMidpoint.y - initialTransform.y) * scaleChange + dy;

      setTransform({ x: newX, y: newY, scale: newScale });
      userInteractedRef.current = true;
      return;
    }

    if (isAndroid && singleFingerDragRef.current.active && e.touches.length === 1) {
      const touch = e.touches[0];
      const dx = touch.clientX - singleFingerDragRef.current.startX;
      const dy = touch.clientY - singleFingerDragRef.current.startY;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 5) {
        clearLongPressTimer();
        const { initialTransform } = singleFingerDragRef.current;
        setTransform({
          x: initialTransform.x + dx,
          y: initialTransform.y + dy,
          scale: initialTransform.scale
        });
        userInteractedRef.current = true;
      }
      return;
    }

    if (e.touches.length === 1 && touchStartPosRef.current) {
      const dx = e.touches[0].clientX - touchStartPosRef.current.x;
      const dy = e.touches[0].clientY - touchStartPosRef.current.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 10) {
        clearLongPressTimer();
      }
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    clearLongPressTimer();

    if (e.touches.length < 2) {
      pinchStateRef.current.active = false;
    }

    if (e.touches.length === 0 && touchStartPosRef.current) {
      const wasSingleFingerDrag = singleFingerDragRef.current.active;
      singleFingerDragRef.current.active = false;

      const start = touchStartPosRef.current;
      const elapsed = Date.now() - start.time;
      const changedTouch = e.changedTouches[0];
      const dx = changedTouch.clientX - start.x;
      const dy = changedTouch.clientY - start.y;
      const dist = Math.sqrt(dx * dx + dy * dy);

      if (dist < 10 && elapsed < 300) {
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) {
          const mouseX = changedTouch.clientX - rect.left;
          const mouseY = changedTouch.clientY - rect.top;
          const worldX = (mouseX - transform.x) / transform.scale;
          const worldY = (mouseY - transform.y) / transform.scale;

          const visible = zOrderIds.length ? zOrderIds.filter(id => layoutItemMap[id]) : layout.items.map(it => it.id);
          let clickedId: string | null = null;
          for (let i = visible.length - 1; i >= 0; i--) {
            const id = visible[i];
            const it = layoutItemMap[id];
            if (!it) continue;
            if (pointInRotatedItem(worldX, worldY, it)) {
              clickedId = id;
              break;
            }
          }

          if (isAndroid) {
            const now = Date.now();
            const lastTap = lastTapRef.current;
            const isDoubleTap = lastTap &&
              Math.abs(changedTouch.clientX - lastTap.x) < 30 &&
              Math.abs(changedTouch.clientY - lastTap.y) < 30 &&
              (now - lastTap.time) < 400;

            if (isDoubleTap) {
              if (clickedId && lastTap?.targetId === clickedId) {
                handleViewImageForId(clickedId);
              } else {
                handleViewAll();
              }
              lastTapRef.current = null;
            } else {
              lastTapRef.current = { x: changedTouch.clientX, y: changedTouch.clientY, time: now, targetId: clickedId };

              if (clickedId) {
                if (activeImageIds.includes(clickedId) && activeImageIds.length === 1) {
                  // tap on already-selected single item
                } else {
                  setActiveImageIds([clickedId]);
                  setIsEditMode(false);
                  isEditModeRef.current = false;
                }
              } else {
                setActiveImageIds([]);
                setIsEditMode(false);
                isEditModeRef.current = false;
              }
            }
          } else {
            if (clickedId) {
              const isSelected = activeImageIds.includes(clickedId);
              if (isSelected) {
                setActiveImageIds(prev => {
                  const others = prev.filter(id => id !== clickedId);
                  return [...others, clickedId!];
                });
              } else {
                setActiveImageIds([clickedId]);
              }
            } else {
              if (potentialClearSelectionRef.current) {
                setActiveImageIds([]);
              }
            }
          }
          potentialClearSelectionRef.current = false;
        }
      }

      touchStartPosRef.current = null;
    }
  };

  const touchHandlersRef = useRef({ handleTouchStart, handleTouchMove, handleTouchEnd });
  touchHandlersRef.current = { handleTouchStart, handleTouchMove, handleTouchEnd };

  useEffect(() => {
    if (!isAndroid) return;
    const el = containerRef.current;
    if (!el) return;

    const opts: AddEventListenerOptions = { passive: false };

    const onTouchStart = (e: TouchEvent) => touchHandlersRef.current.handleTouchStart(e as any);
    const onTouchMove = (e: TouchEvent) => touchHandlersRef.current.handleTouchMove(e as any);
    const onTouchEnd = (e: TouchEvent) => touchHandlersRef.current.handleTouchEnd(e as any);

    el.addEventListener('touchstart', onTouchStart, opts);
    el.addEventListener('touchmove', onTouchMove, opts);
    el.addEventListener('touchend', onTouchEnd, opts);
    el.addEventListener('touchcancel', onTouchEnd, opts);

    const onContextMenu = (e: Event) => e.preventDefault();
    el.addEventListener('contextmenu', onContextMenu);

    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('contextmenu', onContextMenu);
    };
  }, [isAndroid]);

  // 窗口大小恢复相关
  const originalWindowStateRef = useRef<{ width: number; height: number; x: number; y: number } | null>(null);
  const windowResizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 保存进入参考模式前的侧边栏状态
  const sidebarStateBeforeRef = useRef<{ isSidebarVisible: boolean; isMetadataVisible: boolean } | null>(null);

  // 右键菜单逻辑
  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();

    if (isAndroid) return;

    const rect = containerRef.current?.getBoundingClientRect();
    let targetId: string | null = null;
    if (rect) {
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const worldX = (mouseX - transform.x) / transform.scale;
      const worldY = (mouseY - transform.y) / transform.scale;

      const visible = zOrderIds.length ? zOrderIds.filter(id => layoutItemMap[id]) : layout.items.map(it => it.id);
      for (let i = visible.length - 1; i >= 0; i--) {
        const id = visible[i];
        const it = layoutItemMap[id];
        if (!it) continue;
        if (pointInRotatedItem(worldX, worldY, it)) {
          targetId = id;
          break;
        }
      }

      if (targetId) {
        if (!activeImageIds.includes(targetId)) {
          setActiveImageIds([targetId]);
          // 在图片对比模式下，不调用 onSelect，避免改变父组件的 selectedFileIds
          // onSelect?.(targetId);
        }
      }
    }

    setMenuTargetId(targetId);

    let menuX = e.clientX;
    let menuY = e.clientY;

    if (isReferenceMode && isTauriEnvironment()) {
      try {
        const window = getCurrentWindow();
        const windowSize = await window.innerSize();
        const windowPos = await window.outerPosition();
        const MENU_MIN_HEIGHT = 280;
        const MENU_PADDING = 20;

        if (windowSize.height < MENU_MIN_HEIGHT + MENU_PADDING) {
          const newHeight = MENU_MIN_HEIGHT + MENU_PADDING;
          const heightDelta = newHeight - windowSize.height;

          originalWindowStateRef.current = {
            width: windowSize.width,
            height: windowSize.height,
            x: windowPos.x,
            y: windowPos.y
          };

          const screenHeight = (window as any).screen?.height || 1080;
          const spaceBelow = screenHeight - (windowPos.y + windowSize.height);

          let newY = windowPos.y;
          if (spaceBelow >= heightDelta) {
            await window.setSize(new LogicalSize(windowSize.width, newHeight));
          } else if (windowPos.y >= heightDelta) {
            newY = windowPos.y - heightDelta;
            await window.setPosition(new LogicalPosition(windowPos.x, newY));
            await window.setSize(new LogicalSize(windowSize.width, newHeight));
          } else {
            const availableBelow = Math.max(0, spaceBelow);
            const availableAbove = Math.max(0, windowPos.y);
            const expandBelow = Math.min(availableBelow, heightDelta);
            const expandAbove = heightDelta - expandBelow;
            newY = windowPos.y - expandAbove;
            await window.setPosition(new LogicalPosition(windowPos.x, newY));
            await window.setSize(new LogicalSize(windowSize.width, newHeight));
          }

          const relativeMouseY = menuY;
          const newWindowCenterY = newHeight / 2;
          const menuOffset = Math.min(50, heightDelta / 2);
          menuY = Math.max(10, Math.min(newWindowCenterY - menuOffset, newHeight - MENU_MIN_HEIGHT - 10));
        }
      } catch {}
    }

    setContextMenu({ x: menuX, y: menuY });
  };

  const handleCloseContextMenu = () => {
    setContextMenu(null);

    if (originalWindowStateRef.current && isReferenceMode && isTauriEnvironment()) {
      if (windowResizeTimeoutRef.current) {
        clearTimeout(windowResizeTimeoutRef.current);
      }

      windowResizeTimeoutRef.current = setTimeout(async () => {
        try {
          const window = getCurrentWindow();
          const { width, height, x, y } = originalWindowStateRef.current!;
          await window.setSize(new LogicalSize(width, height));
          await window.setPosition(new LogicalPosition(x, y));
          originalWindowStateRef.current = null;
        } catch {}
      }, 300);
    }
  };

  const handleOpenAndroidMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (activeImageIds.length > 0) {
      const targetId = activeImageIds[activeImageIds.length - 1];
      setMenuTargetId(targetId);
    } else {
      setMenuTargetId(null);
    }
    const btn = e.currentTarget as HTMLElement;
    const rect = btn.getBoundingClientRect();
    setContextMenu({ x: rect.right - 10, y: rect.bottom + 20 });
  };

  const handleSaveSession = async () => {
    try {
      const path = await save({
        filters: [{ name: 'Aurora Comparison', extensions: ['aurora'] }],
        defaultPath: `${sessionName}.aurora`
      });
      if (path) {
        const zipBlob = await serializeSessionToZip({
          sessionName,
          viewport: { scale: transform.scale, x: transform.x, y: transform.y },
          items: layout.items,
          files,
          annotations,
          zOrder: zOrderIds
        });
        await writeFile(path, zipBlob);
      }
    } catch {}
  };

  const handleLoadSession = async () => {
    try {
      const path = await open({
        filters: [{ name: 'Aurora Comparison', extensions: ['aurora'] }]
      });
      if (path && typeof path === 'string') {
        const content = await readSessionFile(path);

        if (content.format === 'legacy') {
          await loadLegacySession(content.session);
          return;
        }

        if (content.format === 'zip') {
          const { manifest, layoutData, zip } = content;

          // 使用读取的文件名作为 sessionName
          const fileName = path.split(/[/\\]/).pop()?.replace(/\.aurora$/i, '') || manifest.sessionName || '画布01';
          setSessionName(fileName);
          onSessionNameChange?.(fileName);

          autoZoomAppliedRef.current = false;
          userInteractedRef.current = false;

          const newManuals: Record<string, any> = {};
          const newIds: string[] = [];
          const newZOrder: string[] = [];
          const imageBlobUrls: Record<string, string> = {};
          const newSessionFiles: Record<string, FileNode> = {};

          for (const item of layoutData.items) {
            if (item.imageFileName) {
              const imageBytes = await extractZipImage(zip, item.imageFileName);
              if (imageBytes) {
                const ext = getFileExtension(item.imageFileName);
                const mimeType = getMimeType(ext);
                const blob = new Blob([imageBytes.buffer as ArrayBuffer], { type: mimeType });
                const objectUrl = URL.createObjectURL(blob);
                imageBlobUrls[item.id] = objectUrl;

                newSessionFiles[item.id] = {
                  id: item.id,
                  parentId: null,
                  path: objectUrl,
                  name: item.imageFileName,
                  type: FileType.IMAGE,
                  tags: [],
                  meta: {
                    width: item.width,
                    height: item.height,
                    sizeKb: 0,
                    created: new Date().toISOString(),
                    modified: new Date().toISOString(),
                    format: ext
                  }
                } as FileNode;
              }
            }

            newManuals[item.id] = {
              x: item.x,
              y: item.y,
              width: item.width,
              height: item.height,
              rotation: item.rotation || 0
            };
            newIds.push(item.id);
          }

          Object.entries(imageBlobUrls).forEach(([id, url]) => {
            const img = new Image();
            img.src = url;
            img.onload = () => {
              const w = newSessionFiles[id]?.meta?.width || img.width;
              const h = newSessionFiles[id]?.meta?.height || img.height;
              const levels = createMipmapLevels(img, w, h, isAndroid);
              imagesCache.current.set(id, { original: img, levels });
              setLoadedCount(prev => prev + 1);
            };
          });

          if (layoutData.zOrder && Array.isArray(layoutData.zOrder)) {
            const filteredZ = layoutData.zOrder.filter(id => newIds.includes(id));
            const missing = newIds.filter(id => !filteredZ.includes(id));
            newZOrder.push(...filteredZ, ...missing);
          } else {
            newZOrder.push(...newIds);
          }

          setSessionFiles(newSessionFiles);
          setInternalSelectedIds(newIds);
          setManualLayouts(newManuals);
          setAnnotations(layoutData.annotations || []);
          setZOrderIds(newZOrder);
          initializedRef.current = true;

          shouldAutoFitAfterLoadRef.current = true;
        }
      }
    } catch {}
  };

  const loadLegacySession = async (session: ComparisonSession) => {
    const newManuals: Record<string, any> = {};
    const newIds: string[] = [];

    session.items.forEach(it => {
      if (files[it.id]) {
        newManuals[it.id] = { x: it.x, y: it.y, width: it.width, height: it.height, rotation: it.rotation };
        newIds.push(it.id);
      }
    });

    setInternalSelectedIds(newIds);
    setManualLayouts(newManuals);
    setAnnotations(session.annotations || []);

    if (session.zOrder && Array.isArray(session.zOrder)) {
      const filteredZ = session.zOrder.filter(id => newIds.includes(id));
      const missing = newIds.filter(id => !filteredZ.includes(id));
      setZOrderIds([...filteredZ, ...missing]);
    } else {
      setZOrderIds(newIds);
    }
  };

  const handleRemoveImage = () => {
    const targetId = menuTargetId || (activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : null);
    if (!targetId) return;

    const idsToRemove = activeImageIds.includes(targetId) ? activeImageIds : [targetId];

    const updatedIds = internalSelectedIds.filter(i => !idsToRemove.includes(i));
    setInternalSelectedIds(updatedIds);
    setZOrderIds(prev => prev.filter(i => !idsToRemove.includes(i)));
    setManualLayouts(prev => {
      const next = { ...prev };
      idsToRemove.forEach(id => delete next[id]);
      return next;
    });

    // 标记为内部选择变化，避免 selectedFileIds useEffect 重新初始化（清空缓存）
    isInternalSelectionChangeRef.current = true;
    setActiveImageIds([]);
    setMenuTargetId(null);
    setContextMenu(null);

    // 通知父组件 selectedFileIds 已更改
    onSelectedFileIdsChange?.(updatedIds);
  };

  const handleResetItem = () => {
    const targetId = menuTargetId || (activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : null);
    if (!targetId) return;

    const idsToReset = activeImageIds.includes(targetId) ? activeImageIds : [targetId];

    setManualLayouts(prev => {
      const next = { ...prev };
      idsToReset.forEach(id => delete next[id]);
      return next;
    });
    setContextMenu(null);
    setMenuTargetId(null);
  };

  // Cleanup on unmount - only run when component actually unmounts
  useEffect(() => {
    return () => {
      if (animationRef.current) {
        cancelAnimationFrame(animationRef.current);
      }
      // 清理图片缓存，释放 GPU 内存
      imagesCache.current.forEach(cache => {
        cache.levels.forEach(level => {
          level.canvas.width = 0;
          level.canvas.height = 0;
        });
      });
      imagesCache.current.clear();
      loadingIdsRef.current.clear();
      Object.values(sessionFiles || {}).forEach(file => {
        if (file.path?.startsWith('blob:')) {
          URL.revokeObjectURL(file.path);
        }
      });
    };
  }, [sessionFiles]);

  // Handle reference mode cleanup on unmount - separate effect to avoid triggering on sessionFiles changes
  useEffect(() => {
    return () => {
      // Only cleanup if component is actually unmounting and we're still in reference mode
      onReferenceModeChangeRef.current?.(false);
      const window = getCurrentWindow();
      window.setAlwaysOnTop(false);
      // Check if window is maximized, only set min size if not maximized
      window.isMaximized().then(isMaximized => {
        if (!isMaximized) {
          setWindowMinSize(1280, 800);
        }
      });
    };
  }, []); // Empty deps - only run on unmount



  const handleViewImage = () => {
    const targetId = menuTargetId || (activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : null);
    if (!targetId) return;

    const targetItem = layoutItemMap[targetId];
    if (!targetItem) return;

    const imageCenterX = targetItem.x + targetItem.width / 2;
    const imageCenterY = targetItem.y + targetItem.height / 2;

    const padding = 60;
    const scaleX = (containerSize.width - padding * 2) / targetItem.width;
    const scaleY = (containerSize.height - padding * 2) / targetItem.height;
    // 限制最大缩放比例，避免从极小缩放到极大导致的性能问题
    const newScale = Math.min(scaleX, scaleY, 1.2, 5.0);

    const newX = containerSize.width / 2 - imageCenterX * newScale;
    const newY = containerSize.height / 2 - imageCenterY * newScale;

    // 如果当前缩放比例与目标缩放比例差距过大，先进行一个中间步骤
    const currentScale = transform.scale;
    const scaleRatio = newScale / currentScale;

    if (scaleRatio > 10 || scaleRatio < 0.1) {
      // 缩放差距过大，使用中间步骤避免卡死
      const midScale = Math.sqrt(currentScale * newScale);
      const midX = containerSize.width / 2 - imageCenterX * midScale;
      const midY = containerSize.height / 2 - imageCenterY * midScale;

      // 先动画到中间状态
      startAnimation({
        x: midX,
        y: midY,
        scale: midScale
      });

      // 延迟后再动画到最终状态
      setTimeout(() => {
        startAnimation({
          x: newX,
          y: newY,
          scale: newScale
        });
      }, 50);
    } else {
      startAnimation({
        x: newX,
        y: newY,
        scale: newScale
      });
    }

    userInteractedRef.current = true;
    setContextMenu(null);
    setMenuTargetId(null);
  };

  const handleViewImageForId = (targetId: string) => {
    const targetItem = layoutItemMap[targetId];
    if (!targetItem) return;

    const imageCenterX = targetItem.x + targetItem.width / 2;
    const imageCenterY = targetItem.y + targetItem.height / 2;

    const padding = 60;
    const scaleX = (containerSize.width - padding * 2) / targetItem.width;
    const scaleY = (containerSize.height - padding * 2) / targetItem.height;
    const newScale = Math.min(scaleX, scaleY, 1.2, 5.0);

    const newX = containerSize.width / 2 - imageCenterX * newScale;
    const newY = containerSize.height / 2 - imageCenterY * newScale;

    const currentScale = transform.scale;
    const scaleRatio = newScale / currentScale;

    if (scaleRatio > 10 || scaleRatio < 0.1) {
      const midScale = Math.sqrt(currentScale * newScale);
      const midX = containerSize.width / 2 - imageCenterX * midScale;
      const midY = containerSize.height / 2 - imageCenterY * midScale;
      startAnimation({ x: midX, y: midY, scale: midScale });
      setTimeout(() => {
        startAnimation({ x: newX, y: newY, scale: newScale });
      }, 50);
    } else {
      startAnimation({ x: newX, y: newY, scale: newScale });
    }

    userInteractedRef.current = true;
  };

  const handleReorder = (type: 'top' | 'bottom' | 'up' | 'down') => {
    const targetId = menuTargetId || (activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : null);
    if (!targetId) return;

    setZOrderIds(prev => {
      let next = [...prev];

      const id = targetId;
      const visible = next.filter(i => layoutItemMap[i]);
      const idx = visible.indexOf(id);
      if (idx === -1) return prev;

      const moveToPos = (pos: number) => {
        const curIdx = next.indexOf(id);
        if (curIdx === -1) return;
        next.splice(curIdx, 1);
        const p = Math.max(0, Math.min(pos, next.length));
        next.splice(p, 0, id);
      };

      if (type === 'top') {
        let highestOverlapIdx = -1;
        for (let i = visible.length - 1; i >= 0; i--) {
          const otherId = visible[i];
          if (otherId === id) continue;
          if (itemsOverlap(id, otherId)) {
            highestOverlapIdx = i;
            break;
          }
        }
        if (highestOverlapIdx === -1) moveToPos(next.length);
        else {
          const refId = visible[highestOverlapIdx];
          const refPos = next.indexOf(refId);
          moveToPos(refPos + 1);
        }
      } else if (type === 'bottom') {
        let lowestOverlapIdx = -1;
        for (let i = 0; i < visible.length; i++) {
          const otherId = visible[i];
          if (otherId === id) continue;
          if (itemsOverlap(id, otherId)) {
            lowestOverlapIdx = i;
            break;
          }
        }
        if (lowestOverlapIdx === -1) moveToPos(0);
        else {
          const refId = visible[lowestOverlapIdx];
          const refPos = next.indexOf(refId);
          moveToPos(refPos);
        }
      } else if (type === 'up') {
        let found = false;
        for (let i = visible.indexOf(id) + 1; i < visible.length; i++) {
          const otherId = visible[i];
          if (itemsOverlap(id, otherId)) {
            const refPos = next.indexOf(otherId);
            moveToPos(refPos + 1);
            found = true;
            break;
          }
        }
        if (!found) {
          const curPos = next.indexOf(id);
          if (curPos < next.length - 1) [next[curPos], next[curPos + 1]] = [next[curPos + 1], next[curPos]];
        }
      } else if (type === 'down') {
        let found = false;
        for (let i = visible.indexOf(id) - 1; i >= 0; i--) {
          const otherId = visible[i];
          if (itemsOverlap(id, otherId)) {
            const refPos = next.indexOf(otherId);
            moveToPos(refPos);
            found = true;
            break;
          }
        }
        if (!found) {
          const curPos = next.indexOf(id);
          if (curPos > 0) [next[curPos], next[curPos - 1]] = [next[curPos - 1], next[curPos]];
        }
      }
      return next;
    });

    setContextMenu(null);
    setMenuTargetId(null);
  };

  const handleStartAddAnnotation = () => {
    if (!contextMenu) return;
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = contextMenu.x - rect.left;
    const mouseY = contextMenu.y - rect.top;
    const worldX = (mouseX - transform.x) / transform.scale;
    const worldY = (mouseY - transform.y) / transform.scale;

    const targetId = menuTargetId || (() => {
      const visible = zOrderIds.length ? zOrderIds.filter(id => layoutItemMap[id]) : layout.items.map(it => it.id);
      for (let i = visible.length - 1; i >= 0; i--) {
        const id = visible[i];
        const it = layoutItemMap[id];
        if (!it) continue;
        if (worldX >= it.x && worldX <= it.x + it.width && worldY >= it.y && worldY <= it.y + it.height) return id;
      }
      return null;
    })();

    if (targetId) {
      const target = layoutItemMap[targetId];
      const local = worldToLocalPoint(worldX, worldY, target);
      setPendingAnnotation({
        imageId: targetId,
        x: ((local.x - target.x) / target.width) * 100,
        y: ((local.y - target.y) / target.height) * 100
      });
    }
  };

  const editOverlayLongPressRef = useRef<(worldX: number, worldY: number) => void>(() => {});
  editOverlayLongPressRef.current = (worldX: number, worldY: number) => {
    const targetId = activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : null;
    if (targetId) {
      const target = layoutItemMap[targetId];
      if (target) {
        const local = worldToLocalPoint(worldX, worldY, target);
        setPendingAnnotation({
          imageId: targetId,
          x: ((local.x - target.x) / target.width) * 100,
          y: ((local.y - target.y) / target.height) * 100
        });
      }
    }
  };

  const handleEditOverlayLongPress = useCallback((worldX: number, worldY: number) => {
    editOverlayLongPressRef.current(worldX, worldY);
  }, []);

  const handleReset = () => {
    setManualLayouts({});
    if (layout.totalWidth > 0) {
      const newTransform = computeFitTransform(
        containerSize.width,
        containerSize.height,
        { minX: 0, minY: 0, maxX: layout.totalWidth, maxY: layout.totalHeight }
      );
      if (newTransform) {
        startAnimation(newTransform);
        userInteractedRef.current = true;
        autoZoomAppliedRef.current = true;
      }
    }
  };

  const resetViewportOnly = () => {
    if (layout.items.length === 0 || containerSize.width === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    layout.items.forEach(item => {
      minX = Math.min(minX, item.x);
      minY = Math.min(minY, item.y);
      maxX = Math.max(maxX, item.x + item.width);
      maxY = Math.max(maxY, item.y + item.height);
    });

    const newTransform = computeFitTransform(containerSize.width, containerSize.height, { minX, minY, maxX, maxY });
    if (newTransform) {
      startAnimation(newTransform);
      userInteractedRef.current = true;
      autoZoomAppliedRef.current = true;
    }
  };

  const handleViewAll = () => {
    if (layout.items.length === 0 || containerSize.width === 0) return;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    layout.items.forEach(item => {
      const cx = item.x + item.width / 2;
      const cy = item.y + item.height / 2;
      const corners = [
        { x: item.x, y: item.y },
        { x: item.x + item.width, y: item.y },
        { x: item.x + item.width, y: item.y + item.height },
        { x: item.x, y: item.y + item.height }
      ].map(p => rotatePointAround(p.x, p.y, cx, cy, item.rotation));

      corners.forEach(c => {
        minX = Math.min(minX, c.x);
        minY = Math.min(minY, c.y);
        maxX = Math.max(maxX, c.x);
        maxY = Math.max(maxY, c.y);
      });
    });

    const newTransform = computeFitTransform(containerSize.width, containerSize.height, { minX, minY, maxX, maxY });
    if (newTransform) {
      startAnimation(newTransform);
      userInteractedRef.current = true;
      setContextMenu(null);
      setMenuTargetId(null);
    }
  };

  const selectedMenuOptions = [
    { label: '查看此图', onClick: handleViewImage, icon: <Maximize size={14} /> },
    { label: '重置变换', onClick: handleResetItem, icon: <RefreshCcw size={14} /> },
    { divider: true, label: '', onClick: () => { } },
    { label: '放置到最顶层', onClick: () => handleReorder('top'), icon: <Maximize size={14} className="rotate-45" /> },
    { label: '放置到上方', onClick: () => handleReorder('up'), icon: <Maximize size={14} className="rotate-45" /> },
    { label: '放置到下方', onClick: () => handleReorder('down'), icon: <Maximize size={14} className="rotate-45" /> },
    { label: '放置到最底层', onClick: () => handleReorder('bottom'), icon: <Maximize size={14} className="rotate-45" /> },
    { divider: true, label: '', onClick: () => { } },
    ...(!isAndroid ? [
      { label: '添加注释', onClick: handleStartAddAnnotation, icon: <Plus size={14} /> },
      { divider: true, label: '', onClick: () => { } },
    ] : []),
    { label: '从对比中移除', onClick: handleRemoveImage, icon: <Trash2 size={14} />, style: 'text-red-500 hover:bg-red-50' }
  ];

  const handleOpenAddImageModal = () => {
    setIsAddImageModalOpen(true);
    setContextMenu(null);
  };

  const handleAddImages = (newIds: string[]) => {
    const existingIds = new Set(internalSelectedIds);
    const uniqueNewIds = newIds.filter(id => !existingIds.has(id));

    if (uniqueNewIds.length === 0) return;

    const updatedIds = [...internalSelectedIds, ...uniqueNewIds];
    setInternalSelectedIds(updatedIds);
    setZOrderIds(prev => [...prev, ...uniqueNewIds]);

    // 标记为内部选择变化，避免 selectedFileIds useEffect 重新初始化（清空缓存）
    isInternalSelectionChangeRef.current = true;
    // 通知父组件 selectedFileIds 已更改，以便右键菜单显示正确的数量
    onSelectedFileIdsChange?.(updatedIds);

    shouldAutoFitAfterLoadRef.current = true;

    let loadedImagesCount = 0;
    uniqueNewIds.forEach(id => {
      const file = files[id];
      if (file && file.path && !imagesCache.current.has(file.id)) {
        const img = new Image();
        img.src = resolveImageSrc(file);
        img.onload = () => {
          const w = file.meta?.width || img.width;
          const h = file.meta?.height || img.height;
          const levels = createMipmapLevels(img, w, h, isAndroid);
          imagesCache.current.set(file.id, { original: img, levels });
          loadedImagesCount++;
          setLoadedCount(prev => prev + 1);

          if (loadedImagesCount >= uniqueNewIds.length) {
            userInteractedRef.current = false;
            autoZoomAppliedRef.current = false;
          }
        };
      } else {
        loadedImagesCount++;
      }
    });

    setIsAddImageModalOpen(false);
  };

  const nonSelectedMenuOptions = [
    ...(isAndroid ? [
      { label: `吸附功能: ${isSnappingEnabled ? 'ON' : 'OFF'}`, onClick: () => setIsSnappingEnabled(!isSnappingEnabled), icon: <Magnet size={14} className={isSnappingEnabled ? 'text-blue-500' : 'text-gray-400'} /> },
      { divider: true, label: '', onClick: () => { } },
    ] : [
      { label: '添加图片', onClick: handleOpenAddImageModal, icon: <Plus size={14} /> },
      { divider: true, label: '', onClick: () => { } },
    ]),
    { label: '保存对比信息', onClick: handleSaveSession, icon: <Save size={14} />, disabled: imageFiles.length === 0 },
    { label: '读取对比信息', onClick: handleLoadSession, icon: <FolderOpen size={14} /> },
    { divider: true, label: '', onClick: () => { } },
    { label: '查看全部', onClick: handleViewAll, icon: <Scan size={14} />, disabled: imageFiles.length === 0 },
    { label: '重置窗口', onClick: handleReset, icon: <RefreshCcw size={14} /> },
  ];

  const menuOptions = menuTargetId ? selectedMenuOptions : nonSelectedMenuOptions;

  // Reference mode toggle
  const toggleReferenceMode = useCallback(async () => {
    const newMode = !isReferenceMode;
    setIsReferenceMode(newMode);
    onReferenceModeChangeRef.current?.(newMode);

    // Android 全屏模式
    if (isAndroid) {
      if (newMode) {
        // 进入全屏：关闭面板并进入沉浸模式
        const currentLayout = layoutPropRef.current;
        sidebarStateBeforeRef.current = {
          isSidebarVisible: currentLayout?.isSidebarVisible ?? false,
          isMetadataVisible: currentLayout?.isMetadataVisible ?? false
        };
        setAndroidImmersiveMode(true);
        setTimeout(() => {
          const currentLayout = layoutPropRef.current;
          const currentOnLayoutToggle = onLayoutToggleRef.current;
          if (currentLayout?.isSidebarVisible) {
            currentOnLayoutToggle?.('sidebar');
          }
          if (currentLayout?.isMetadataVisible) {
            currentOnLayoutToggle?.('metadata');
          }
        }, 50);
      } else {
        // 退出全屏：恢复面板并退出沉浸模式
        setAndroidImmersiveMode(false);
        const isDark = document.documentElement.classList.contains('dark');
        setAndroidStatusBar(isDark);
        const savedState = sidebarStateBeforeRef.current;
        if (savedState) {
          const currentLayout = layoutPropRef.current;
          const currentOnLayoutToggle = onLayoutToggleRef.current;
          if (savedState.isSidebarVisible && !currentLayout?.isSidebarVisible) {
            currentOnLayoutToggle?.('sidebar');
          }
          if (savedState.isMetadataVisible && !currentLayout?.isMetadataVisible) {
            currentOnLayoutToggle?.('metadata');
          }
          sidebarStateBeforeRef.current = null;
        }
      }
      return;
    }

    // Helper function to animate window resize
    const animateWindowResize = async (
      targetWidth: number,
      targetHeight: number,
      duration: number = 70
    ) => {
      const window = getCurrentWindow();
      const startSize = await window.innerSize();
      const startWidth = startSize.width;
      const startHeight = startSize.height;
      const startTime = performance.now();

      // ease-out cubic easing function for smooth animation
      const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

      return new Promise<void>((resolve) => {
        const animate = (currentTime: number) => {
          const elapsed = currentTime - startTime;
          const progress = Math.min(elapsed / duration, 1);
          const easedProgress = easeOutCubic(progress);

          const newWidth = Math.round(startWidth + (targetWidth - startWidth) * easedProgress);
          const newHeight = Math.round(startHeight + (targetHeight - startHeight) * easedProgress);

          window.setSize(new LogicalSize(newWidth, newHeight));

          if (progress < 1) {
            requestAnimationFrame(animate);
          } else {
            resolve();
          }
        };

        requestAnimationFrame(animate);
      });
    };

    try {
      const window = getCurrentWindow();
      await window.setAlwaysOnTop(newMode);

      // Set window min size based on mode
      if (newMode) {
        // Enter reference mode: save current sidebar state
        const currentLayout = layoutPropRef.current;
        sidebarStateBeforeRef.current = {
          isSidebarVisible: currentLayout?.isSidebarVisible ?? false,
          isMetadataVisible: currentLayout?.isMetadataVisible ?? false
        };

        // Check if window is maximized, only set min size if not maximized
        const isMaximized = await window.isMaximized();
        if (!isMaximized) {
          await setWindowMinSize(200, 200);
        }
        // Show toast notification
        showToast('解除窗口大小限制。', 2000);
        // Close side panels after a short delay to avoid re-render issues
        setTimeout(() => {
          const currentLayout = layoutPropRef.current;
          const currentOnLayoutToggle = onLayoutToggleRef.current;
          if (currentLayout?.isSidebarVisible) {
            currentOnLayoutToggle?.('sidebar');
          }
          if (currentLayout?.isMetadataVisible) {
            currentOnLayoutToggle?.('metadata');
          }
        }, 50);
      } else {
        // Exit reference mode: get saved sidebar state first
        const savedState = sidebarStateBeforeRef.current;

        // Check if window is maximized
        const isMaximized = await window.isMaximized();

        // Check window size and restore if smaller than 1280x800 with animation
        // Skip if window is maximized
        const currentSize = await window.innerSize();
        if (!isMaximized && (currentSize.width < 1280 || currentSize.height < 800)) {
          await animateWindowResize(1280, 800, 70);
        }

        // Restore sidebar state after animation completes
        if (savedState) {
          const currentLayout = layoutPropRef.current;
          const currentOnLayoutToggle = onLayoutToggleRef.current;

          // Restore sidebar if it was visible before
          if (savedState.isSidebarVisible && !currentLayout?.isSidebarVisible) {
            currentOnLayoutToggle?.('sidebar');
          }
          // Restore metadata panel if it was visible before
          if (savedState.isMetadataVisible && !currentLayout?.isMetadataVisible) {
            currentOnLayoutToggle?.('metadata');
          }
          sidebarStateBeforeRef.current = null;
        }

        // Show toast notification
        showToast('开启窗口大小限制。', 2000);

        // Only set min size if window is not maximized
        if (!isMaximized) {
          await setWindowMinSize(1280, 800);
        }
      }
    } catch {}
  }, [isReferenceMode, isAndroid]);

  // Keyboard support
  useComparerShortcuts({
    isActiveTab,
    isAddImageModalOpen,
    setIsAddImageModalOpen,
    isReferenceMode,
    toggleReferenceMode,
    onClose,
    onCloseTab,
    setIsSnappingEnabled
  });

  // Handle mouse side buttons
  useEffect(() => {
    if (!isActiveTab) return;
    const handleMouseUp = (e: MouseEvent) => {
      if (e.button === 3) {
        e.stopImmediatePropagation();
        e.preventDefault();
        // 优先级1: 如果添加图片窗口打开，关闭它
        if (isAddImageModalOpen) {
          setIsAddImageModalOpen(false);
          return;
        }
        // 优先级2: 如果处于参考模式，退出参考模式
        if (isReferenceMode) {
          toggleReferenceMode();
          return;
        }
        // 优先级3: 关闭标签页
        if (onCloseTab) onCloseTab();
        else onClose();
      } else if (e.button === 4) {
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };

    window.addEventListener('mouseup', handleMouseUp, { capture: true });
    return () => window.removeEventListener('mouseup', handleMouseUp, { capture: true });
  }, [onClose, onCloseTab, toggleReferenceMode, isAddImageModalOpen, isReferenceMode, isActiveTab]);

  const backPressStateRef = useRef({ contextMenu: null as { x: number; y: number } | null, isEditMode: false, activeImageIds: [] as string[], onClose: onClose, onCloseTab: onCloseTab, isActiveTab: isActiveTab, isReferenceMode: isReferenceMode });
  backPressStateRef.current = { contextMenu, isEditMode, activeImageIds, onClose, onCloseTab, isActiveTab, isReferenceMode };

  useEffect(() => {
    if (!isAndroid) return;
    const handler = () => {
      const state = backPressStateRef.current;
      if (!state.isActiveTab) return;
      if (state.contextMenu) {
        setContextMenu(null);
        setMenuTargetId(null);
        (window as any).__androidBackHandled = true;
        return;
      }
      // 全屏模式下，返回键退出全屏
      if (state.isReferenceMode) {
        toggleReferenceMode();
        (window as any).__androidBackHandled = true;
        return;
      }
      if (state.isEditMode && state.activeImageIds.length > 0) {
        setIsEditMode(false);
        isEditModeRef.current = false;
        (window as any).__androidBackHandled = true;
        return;
      }
      if (state.activeImageIds.length > 0) {
        setActiveImageIds([]);
        (window as any).__androidBackHandled = true;
        return;
      }
      (window as any).__androidBackHandled = true;
      if (state.onCloseTab) state.onCloseTab();
      else state.onClose();
    };
    window.addEventListener('android-back-press', handler);
    return () => window.removeEventListener('android-back-press', handler);
  }, [isAndroid, toggleReferenceMode]);

  return (
    <div
      className="w-full h-full flex-1 flex flex-col overflow-hidden select-none relative z-[100]"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onContextMenu={handleContextMenu}
    >
      {/* Loading Overlay */}
      {isLoadingCanvas && (
        <div className="absolute inset-0 z-[500] flex flex-col items-center justify-center bg-white dark:bg-[#262626]">
          <div className="flex flex-col items-center space-y-4">
            <div className="relative w-12 h-12">
              <div className="absolute inset-0 rounded-full border-4 border-gray-200 dark:border-gray-700" />
              <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-blue-500 animate-spin" />
            </div>
            <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
              正在加载图片...
            </p>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {realLoadedCount} / {imageFiles.length}
            </p>
          </div>
        </div>
      )}

      {/* Header - hidden in reference mode */}
      {!isReferenceMode && (
        <ComparerToolbar
          isReferenceMode={isReferenceMode}
          isAndroid={isAndroid}
          isSnappingEnabled={isSnappingEnabled}
          isEditingTitle={isEditingTitle}
          sessionName={sessionName}
          imageCount={imageFiles.length}
          layoutProp={layoutProp}
          t={t}
          onLayoutToggle={onLayoutToggle}
          onClose={onClose}
          onCloseTab={onCloseTab}
          setIsSnappingEnabled={setIsSnappingEnabled}
          toggleReferenceMode={toggleReferenceMode}
          handleOpenAddImageModal={handleOpenAddImageModal}
          handleOpenAndroidMenu={handleOpenAndroidMenu}
          handleSaveSession={handleSaveSession}
          handleLoadSession={handleLoadSession}
          handleViewAll={handleViewAll}
          handleReset={handleReset}
          setIsEditingTitle={setIsEditingTitle}
          setSessionName={setSessionName}
          onSessionNameChange={onSessionNameChange}
        />
      )}

      {/* Canvas Container */}
      <div
        ref={containerRef}
        className="flex-1 relative cursor-grab active:cursor-grabbing overflow-hidden animate-fade-in"
      >
        <canvas
          ref={canvasRef}
          className="block absolute inset-0"
          style={{ width: '100%', height: '100%', willChange: isAndroid ? 'transform' : undefined }}
        />

        {/* Empty state message */}
        {imageFiles.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <div className="text-center text-gray-400 dark:text-gray-500">
              <Scan size={64} className="mx-auto mb-6 opacity-40" />
              <h2 className="text-3xl font-bold mb-3">暂无图片</h2>
              <p className="text-sm text-gray-400 dark:text-gray-500">请使用右键菜单中的图片对比功能或者读取画布信息</p>
            </div>
          </div>
        )}

        {/* Marquee selection overlay */}
        {marquee && marquee.active && (
          <div className="absolute pointer-events-none" style={{
            left: Math.min(marquee.startX, marquee.x),
            top: Math.min(marquee.startY, marquee.y),
            width: Math.abs(marquee.x - marquee.startX),
            height: Math.abs(marquee.y - marquee.startY),
            border: '1px dashed rgba(59,130,246,0.9)',
            backgroundColor: 'rgba(59,130,246,0.06)',
            zIndex: 130
          }} />
        )}

        {/* Edit Overlay */}
        <EditOverlay
          activeItem={activeImageIds.length > 1 && (transientGroup || groupBounds) ? ({
            id: 'GROUP_SELECTION',
            x: (transientGroup || groupBounds)!.x,
            y: (transientGroup || groupBounds)!.y,
            width: (transientGroup || groupBounds)!.width,
            height: (transientGroup || groupBounds)!.height,
            rotation: (transientGroup || groupBounds)!.rotation || 0
          } as ComparisonItem) : layout.items.find(it => it.id === (activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : '')) || null}
          selectedItems={layout.items.filter(it => activeImageIds.includes(it.id))}
          allItems={layout.items}
          transform={transform}
          containerRef={containerRef}
          isSnappingEnabled={isSnappingEnabled}
          onInteractionStart={() => { isGroupEditingRef.current = true; setTransientGroup(null); }}
          onInteractionEnd={() => { isGroupEditingRef.current = false; computeAndSetGroupBounds(); setTransientGroup(null); }}
          onUpdateItem={(id, updates) => {
            if (id === 'GROUP_SELECTION' && activeImageIds.length > 1 && (groupBounds || transientGroup)) {
              const oldGroup = transientGroup || groupBounds!;
              const newGroup = {
                x: updates.x !== undefined ? updates.x : oldGroup.x,
                y: updates.y !== undefined ? updates.y : oldGroup.y,
                width: updates.width !== undefined ? updates.width : oldGroup.width,
                height: updates.height !== undefined ? updates.height : oldGroup.height,
                rotation: updates.rotation !== undefined ? updates.rotation : (oldGroup.rotation || 0)
              };

              const rawSX = newGroup.width / Math.max(1e-6, oldGroup.width);
              const rawSY = newGroup.height / Math.max(1e-6, oldGroup.height);
              const rawDR = newGroup.rotation - (oldGroup.rotation || 0);

              const oldCenter = { x: oldGroup.x + oldGroup.width / 2, y: oldGroup.y + oldGroup.height / 2 };
              const newCenter = { x: newGroup.x + newGroup.width / 2, y: newGroup.y + newGroup.height / 2 };

              const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

              const eps = 1e-3;
              const leftOld = oldGroup.x;
              const rightOld = oldGroup.x + oldGroup.width;
              const topOld = oldGroup.y;
              const bottomOld = oldGroup.y + oldGroup.height;

              const leftNew = newGroup.x;
              const rightNew = newGroup.x + newGroup.width;
              const topNew = newGroup.y;
              const bottomNew = newGroup.y + newGroup.height;

              const leftFixed = Math.abs(leftNew - leftOld) < eps;
              const rightFixed = Math.abs(rightNew - rightOld) < eps;
              const topFixed = Math.abs(topNew - topOld) < eps;
              const bottomFixed = Math.abs(bottomNew - bottomOld) < eps;

              const sX = clamp(rawSX, 0.85, 1.15);
              const sY = clamp(rawSY, 0.85, 1.15);
              const dr = clamp(rawDR, -30, 30);

              const appliedWidth = oldGroup.width * sX;
              const appliedHeight = oldGroup.height * sY;

              let appliedX: number;
              if (leftFixed) appliedX = leftOld;
              else if (rightFixed) appliedX = rightOld - appliedWidth;
              else {
                const rawCenterDx = newCenter.x - oldCenter.x;
                const maxMove = Math.max(oldGroup.width, oldGroup.height) * 0.5;
                const dcx = clamp(rawCenterDx, -maxMove, maxMove);
                appliedX = oldGroup.x + dcx - appliedWidth / 2 + oldGroup.width / 2;
              }

              let appliedY: number;
              if (topFixed) appliedY = topOld;
              else if (bottomFixed) appliedY = bottomOld - appliedHeight;
              else {
                const rawCenterDy = newCenter.y - oldCenter.y;
                const maxMove = Math.max(oldGroup.width, oldGroup.height) * 0.5;
                const dcy = clamp(rawCenterDy, -maxMove, maxMove);
                appliedY = oldGroup.y + dcy - appliedHeight / 2 + oldGroup.height / 2;
              }

              const appliedNewGroup = {
                x: appliedX,
                y: appliedY,
                width: appliedWidth,
                height: appliedHeight,
                rotation: (oldGroup.rotation || 0) + dr
              };

              setTransientGroup({ ...appliedNewGroup } as ComparisonItem);

              const rad = dr * Math.PI / 180;
              const cos = Math.cos(rad);
              const sin = Math.sin(rad);
              const newCenterApplied = { x: appliedNewGroup.x + appliedNewGroup.width / 2, y: appliedNewGroup.y + appliedNewGroup.height / 2 };

              setManualLayouts(prev => {
                const next = { ...prev };
                activeImageIds.forEach(targetId => {
                  const targetOld = layoutItemMap[targetId];
                  if (!targetOld) return;
                  const base = prev[targetId] || targetOld;

                  const itemCenter = { x: base.x + base.width / 2, y: base.y + base.height / 2 };
                  const vx = itemCenter.x - oldCenter.x;
                  const vy = itemCenter.y - oldCenter.y;

                  const sxv = vx * sX;
                  const syv = vy * sY;

                  const rx = sxv * cos - syv * sin;
                  const ry = sxv * sin + syv * cos;

                  const ncx = newCenterApplied.x + rx;
                  const ncy = newCenterApplied.y + ry;

                  const newW = base.width * sX;
                  const newH = base.height * sY;

                  next[targetId] = {
                    ...base,
                    x: ncx - newW / 2,
                    y: ncy - newH / 2,
                    width: newW,
                    height: newH,
                    rotation: (base.rotation || 0) + dr
                  };
                });
                return next;
              });

              return;
            } else {
              const oldItem = layoutItemMap[id];
              if (!oldItem) return;

              const dx = (updates.x !== undefined) ? updates.x - oldItem.x : 0;
              const dy = (updates.y !== undefined) ? updates.y - oldItem.y : 0;
              const dr = (updates.rotation !== undefined) ? updates.rotation - oldItem.rotation : 0;
              const rw = (updates.width !== undefined) ? updates.width / oldItem.width : 1;
              const rh = (updates.height !== undefined) ? updates.height / oldItem.height : 1;

              setManualLayouts(prev => {
                const next = { ...prev };
                activeImageIds.forEach(targetId => {
                  const targetOld = layoutItemMap[targetId];
                  if (!targetOld) return;

                  const base = prev[targetId] || targetOld;

                  next[targetId] = {
                    ...base,
                    x: base.x + dx,
                    y: base.y + dy,
                    rotation: (base.rotation || 0) + dr,
                    width: base.width * rw,
                    height: base.height * rh
                  };
                });
                return next;
              });
            }
          }}
          onRemoveItem={handleRemoveImage}
          isDarkMode={isDarkMode}
          isEditMode={!isAndroid || isEditMode}
          isAndroid={isAndroid}
          onLongPress={isAndroid && isEditMode ? handleEditOverlayLongPress : undefined}
        />

        {/* Context Menu */}
        {contextMenu && (
          <ComparerContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={handleCloseContextMenu}
            options={menuOptions}
            compact={isReferenceMode}
            isAndroid={isAndroid}
          />
        )}

        {/* Annotation Layer */}
        <AnnotationLayer
          annotations={annotations}
          layoutItems={layout.items}
          zOrderIds={zOrderIds}
          transform={transform}
          onUpdateAnnotation={(id, text) => {
            setAnnotations(prev => prev.map(a => a.id === id ? { ...a, text } : a));
          }}
          onRemoveAnnotation={(id) => {
            setAnnotations(prev => prev.filter(a => a.id !== id));
          }}
          pendingAnnotation={pendingAnnotation}
          onSavePending={(text) => {
            if (pendingAnnotation) {
              setAnnotations(prev => [...prev, {
                id: Math.random().toString(36).substr(2, 9),
                imageId: pendingAnnotation.imageId,
                x: pendingAnnotation.x,
                y: pendingAnnotation.y,
                text: text.trim(),
                createdAt: Date.now()
              }]);
              setPendingAnnotation(null);
            }
          }}
          onCancelPending={() => setPendingAnnotation(null)}
          containerSize={containerSize}
        />

      </div>

      {/* Shortcuts Hint - hidden in reference mode */}
      {!isReferenceMode && (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 bg-white/90 dark:bg-[#262626]/90 backdrop-blur-md rounded-full border border-gray-200 dark:border-gray-700/50 text-sm text-gray-500 dark:text-gray-400 pointer-events-none shadow-2xl animate-fade-in-up transition-opacity flex items-center space-x-4 z-[50]">
        {isAndroid ? (
          <>
            <div className="flex items-center">
              <Magnet size={14} className="mr-1.5 text-blue-500 dark:text-blue-400" />
              <span className="text-gray-700 dark:text-gray-200 font-medium whitespace-nowrap">点击 选择 / 双指 缩放</span>
            </div>
            <div className="w-px h-3 bg-gray-300 dark:bg-gray-700" />
            <div className="flex items-center">
              <Move size={14} className="mr-1.5 text-blue-500 dark:text-blue-400" />
              <span className="text-gray-700 dark:text-gray-200 font-medium whitespace-nowrap">单指 拖拽 / 长按 编辑</span>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center">
              <Magnet size={14} className="mr-1.5 text-blue-500 dark:text-blue-400" />
              <span className="text-gray-700 dark:text-gray-200 font-medium whitespace-nowrap">左键 选择 / 滚轮 缩放</span>
            </div>
            <div className="w-px h-3 bg-gray-300 dark:bg-gray-700" />
            <div className="flex items-center">
              <Move size={14} className="mr-1.5 text-blue-500 dark:text-blue-400" />
              <span className="text-gray-700 dark:text-gray-200 font-medium whitespace-nowrap">中键 拖拽</span>
            </div>
            <div className="w-px h-3 bg-gray-300 dark:bg-gray-700" />
            <div className="flex items-center">
              <div className="flex items-center justify-center min-w-[32px] h-5 border border-gray-300 dark:border-gray-600 rounded text-[10px] font-bold mr-1.5 text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-[#3a3a3a] shadow-sm leading-none pt-0.5">ESC</div>
              <span className="text-gray-700 dark:text-gray-200 font-medium whitespace-nowrap">退出</span>
            </div>
          </>
        )}
      </div>
      )}

      {/* Android 全屏按钮 */}
      {isAndroid && (
        <button
          onClick={toggleReferenceMode}
          className={`absolute bottom-8 right-6 z-[50] w-14 h-14 flex items-center justify-center rounded-full bg-black/50 dark:bg-white/20 backdrop-blur-sm text-white dark:text-white shadow-lg border border-white/20 transition-opacity duration-700 ease-out active:scale-90 ${
            fullscreenBtnVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'
          }`}
          style={{ touchAction: 'manipulation' }}
        >
          {isReferenceMode ? <Minimize2 size={24} /> : <Maximize2 size={24} />}
        </button>
      )}

      {/* Add Image Modal */}
      {isAddImageModalOpen && (
        <AddImageModal
          files={files}
          people={people}
          topics={topics}
          customTags={customTags}
          resourceRoot={resourceRoot}
          cachePath={cachePath}
          existingImageIds={internalSelectedIds}
          onConfirm={handleAddImages}
          onClose={() => setIsAddImageModalOpen(false)}
          t={t}
        />
      )}

      {/* Toast Notification */}
      {toast.visible && (
        <div
          className={`absolute bottom-20 left-1/2 -translate-x-1/2 bg-black/80 text-white text-sm px-4 py-2 rounded-full shadow-lg backdrop-blur-sm pointer-events-none z-[60] transition-all duration-300 ease-out ${
            toast.isLeaving
              ? 'opacity-0 translate-y-2'
              : 'opacity-100 translate-y-0 animate-fade-in-up'
          }`}
        >
          {toast.msg}
        </div>
      )}
    </div>
  );
};
