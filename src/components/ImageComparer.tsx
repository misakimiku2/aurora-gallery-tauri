import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { Maximize, RefreshCcw, Sidebar, PanelRight, ChevronLeft, Magnet, Move, X, Scan, Eye } from 'lucide-react';
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import { FileNode, Person, Topic, FileType } from '../types';
import { setWindowMinSize } from '../api/tauri-bridge';
import { isTauriEnvironment } from '../utils/environment';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ComparisonItem, Annotation, ComparisonSession } from './comparer/types';
import { EditOverlay } from './comparer/EditOverlay';
import { AnnotationLayer } from './comparer/AnnotationLayer';
import { ComparerContextMenu } from './comparer/ComparerContextMenu';
import { AddImageModal } from './modals/AddImageModal';
import { writeTextFile, readTextFile, writeFile, readFile } from '@tauri-apps/plugin-fs';
import { save, open } from '@tauri-apps/plugin-dialog';
import { Plus, Save, FolderOpen, Trash2 } from 'lucide-react';
import JSZip from 'jszip';
import { ComparisonSessionManifest, ComparisonSessionViewport, ComparisonSessionLayout } from './comparer/types';
import { invoke } from '@tauri-apps/api/core';
import { useToasts } from '../hooks/useToasts';

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
}

interface ImageLayoutInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
}

// 多级 Mipmap 缓存结构
interface MipmapCache {
  original: HTMLImageElement;
  levels: {
    scale: number;
    canvas: HTMLCanvasElement;
  }[];
}

// 获取最适合当前缩放比例的缓存级别
function getBestMipmapLevel(cache: MipmapCache, targetScale: number): HTMLImageElement | HTMLCanvasElement {
  // 如果目标缩放比例 >= 0.8，使用原图以获得最佳清晰度
  if (targetScale >= 0.8) {
    return cache.original;
  }

  // 找到最适合的缩小级别
  let bestLevel = cache.levels[0];
  let bestScore = Infinity;

  for (const level of cache.levels) {
    const effectiveScale = targetScale / level.scale;
    const score = Math.abs(Math.log(effectiveScale));
    if (score < bestScore) {
      bestScore = score;
      bestLevel = level;
    }
  }

  return bestLevel.canvas;
}

// 创建多级 Mipmap
function createMipmapLevels(img: HTMLImageElement, originalWidth: number, originalHeight: number): MipmapCache['levels'] {
  const levels: MipmapCache['levels'] = [];
  // 增加更多中间级别以改善显示质量
  const scales = [0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.0625];

  for (const scale of scales) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(originalWidth * scale));
    canvas.height = Math.max(1, Math.floor(originalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    levels.push({ scale, canvas });
  }

  return levels;
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
  isReferenceMode: isReferenceModeProp
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // 变换状态
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
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
  const [isSnappingEnabled, setIsSnappingEnabled] = useState(true);
  const [sessionName, setSessionName] = useState(sessionNameProp || "画布01");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [isAddImageModalOpen, setIsAddImageModalOpen] = useState(false);
  const [sessionFiles, setSessionFiles] = useState<Record<string, FileNode>>({});
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; x: number; y: number; active: boolean } | null>(null);
  const potentialClearSelectionRef = useRef(false);
  const shouldAutoFitAfterLoadRef = useRef(false);
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
  // Use ref to store callbacks to avoid re-render issues
  const layoutPropRef = useRef(layoutProp);
  const onLayoutToggleRef = useRef(onLayoutToggle);
  const onReferenceModeChangeRef = useRef(onReferenceModeChange);
  useEffect(() => {
    layoutPropRef.current = layoutProp;
    onLayoutToggleRef.current = onLayoutToggle;
    onReferenceModeChangeRef.current = onReferenceModeChange;
  }, [layoutProp, onLayoutToggle, onReferenceModeChange]);

  // 多级 Mipmap 缓存
  const imagesCache = useRef<Map<string, MipmapCache>>(new Map());
  const [loadedCount, setLoadedCount] = useState(0);

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

  // Update container size on mount and resize
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setContainerSize({
          width: containerRef.current.clientWidth,
          height: containerRef.current.clientHeight
        });
      }
    };
    updateSize();
    let ro: ResizeObserver | null = null;
    if ((window as any).ResizeObserver && containerRef.current) {
      ro = new ResizeObserver(() => updateSize());
      ro.observe(containerRef.current);
    } else {
      window.addEventListener('resize', updateSize);
    }

    return () => {
      if (ro && containerRef.current) ro.unobserve(containerRef.current);
      if (!ro) window.removeEventListener('resize', updateSize);
    };
  }, []);

  // Keep previous container width for panel toggle handling
  const prevContainerWidthRef = useRef<number>(0);
  const prevMetadataVisibleRef = useRef<boolean | undefined>(layoutProp?.isMetadataVisible);

  useEffect(() => {
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

  // Load images & create mipmap levels
  useEffect(() => {
    imageFiles.forEach(file => {
      if (!imagesCache.current.has(file.id)) {
        const img = new Image();
        img.src = convertFileSrc(file.path);
        img.onload = () => {
          const w = file.meta?.width || img.width;
          const h = file.meta?.height || img.height;
          const levels = createMipmapLevels(img, w, h);

          imagesCache.current.set(file.id, {
            original: img,
            levels
          });
          setLoadedCount(prev => prev + 1);
        };
      }
    });
  }, [imageFiles]);

  // Initialize internal selection and respond to external changes
  useEffect(() => {
    if (!initializedRef.current) {
      // 首次初始化
      initializedRef.current = true;
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
    setLoadedCount(0);
    // 重置 onReady 状态，允许新的加载完成回调
    onReadyCalledRef.current = false;
  }, [selectedFileIds]); // 只监听 selectedFileIds

  // Notify parent when all images are loaded
  useEffect(() => {
    if (imageFiles.length > 0 && loadedCount >= imageFiles.length) {
      if (!onReadyCalledRef.current) {
        onReadyCalledRef.current = true;
        onReady?.();
      }
    }
  }, [loadedCount, imageFiles.length, onReady]);

  // Layout calculation
  const layout = useMemo(() => {
    if (imageFiles.length === 0)
      return { items: [], totalWidth: 0, totalHeight: 0 };

    const spacing = 40;
    const items: ImageLayoutInfo[] = [];

    const packOrder = imageFiles.slice().sort((a, b) => {
      const sizeA = (a.meta?.width || 0) * (a.meta?.height || 0);
      const sizeB = (b.meta?.width || 0) * (b.meta?.height || 0);
      return sizeB - sizeA;
    });

    const checkOverlap = (rect: { x: number; y: number; w: number; h: number }, existing: ImageLayoutInfo[]) => {
      for (const item of existing) {
        if (
          rect.x < item.x + item.width + spacing - 1 &&
          rect.x + rect.w + spacing - 1 > item.x &&
          rect.y < item.y + item.height + spacing - 1 &&
          rect.y + rect.h + spacing - 1 > item.y
        ) {
          return true;
        }
      }
      return false;
    };

    const first = packOrder[0];
    const firstW = first.meta?.width || 1000;
    const firstH = first.meta?.height || 750;

    items.push({
      id: first.id,
      x: -firstW / 2,
      y: -firstH / 2,
      width: firstW,
      height: firstH,
      src: convertFileSrc(first.path)
    });

    for (let i = 1; i < packOrder.length; i++) {
      const file = packOrder[i];
      const w = file.meta?.width || 1000;
      const h = file.meta?.height || 750;

      let bestPos = { x: 0, y: 0 };
      let minDistance = Infinity;
      const candidates: { x: number; y: number }[] = [];

      items.forEach(item => {
        candidates.push({ x: item.x + item.width + spacing, y: item.y });
        candidates.push({ x: item.x - w - spacing, y: item.y });
        candidates.push({ x: item.x, y: item.y + item.height + spacing });
        candidates.push({ x: item.x, y: item.y - h - spacing });
        candidates.push({ x: item.x + item.width + spacing, y: item.y + item.height - h });
        candidates.push({ x: item.x - w - spacing, y: item.y + item.height - h });
        candidates.push({ x: item.x + item.width - w, y: item.y + item.height + spacing });
        candidates.push({ x: item.x, y: item.y - h - spacing });
      });

      for (const cand of candidates) {
        if (!checkOverlap({ x: cand.x, y: cand.y, w: w, h: h }, items)) {
          const dist = Math.sqrt(Math.pow(cand.x + w / 2, 2) + Math.pow(cand.y + h / 2, 2));
          if (dist < minDistance) {
            minDistance = dist;
            bestPos = cand;
          }
        }
      }

      items.push({
        id: file.id,
        x: bestPos.x,
        y: bestPos.y,
        width: w,
        height: h,
        src: convertFileSrc(file.path)
      });
    }

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

  const rotatePointAround = (x: number, y: number, cx: number, cy: number, angleDeg: number) => {
    const rad = angleDeg * Math.PI / 180;
    const dx = x - cx;
    const dy = y - cy;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return { x: rx + cx, y: ry + cy };
  };

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

  const pointInRotatedItem = (worldX: number, worldY: number, it: ComparisonItem) => {
    const cx = it.x + it.width / 2;
    const cy = it.y + it.height / 2;
    const local = rotatePointAround(worldX, worldY, cx, cy, -it.rotation);
    return local.x >= it.x && local.x <= it.x + it.width && local.y >= it.y && local.y <= it.y + it.height;
  };

  const worldToLocalPoint = (worldX: number, worldY: number, it: ComparisonItem) => {
    const cx = it.x + it.width / 2;
    const cy = it.y + it.height / 2;
    return rotatePointAround(worldX, worldY, cx, cy, -it.rotation);
  };

  const worldToScreen = (wx: number, wy: number) => ({
    x: wx * transform.scale + transform.x,
    y: wy * transform.scale + transform.y
  });

  const computeAABB = (it: ComparisonItem) => {
    const cx = it.x + it.width / 2;
    const cy = it.y + it.height / 2;
    const corners = [
      { x: it.x, y: it.y },
      { x: it.x + it.width, y: it.y },
      { x: it.x + it.width, y: it.y + it.height },
      { x: it.x, y: it.y + it.height }
    ].map(c => rotatePointAround(c.x, c.y, cx, cy, it.rotation));
    const xs = corners.map(c => c.x);
    const ys = corners.map(c => c.y);
    return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
  };

  const aabbOverlap = (a: { minX: number; minY: number; maxX: number; maxY: number }, b: { minX: number; minY: number; maxX: number; maxY: number }) => {
    return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
  };

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
    const buffer = 100 / transform.scale;
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
    const bgColor = isDark ? '#0a0a0a' : '#f9fafb';
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
        // 根据当前缩放比例选择最佳 Mipmap 级别
        const imageToDraw = getBestMipmapLevel(cache, transform.scale);
        ctx.drawImage(imageToDraw, 0, 0, item.width, item.height);

        // 绘制边框
        if (activeImageIds.includes(item.id)) {
          ctx.strokeStyle = '#3b82f6';
          ctx.lineWidth = 4 / transform.scale;
          ctx.strokeRect(0, 0, item.width, item.height);
        } else {
          ctx.strokeStyle = 'rgba(255,255,255,0.08)';
          ctx.lineWidth = 1 / transform.scale;
          ctx.strokeRect(0, 0, item.width, item.height);
        }
      }
      ctx.restore();
    }

    ctx.restore();
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
      const padding = 60;
      const scaleX = (containerSize.width - padding * 2) / layout.totalWidth;
      const scaleY = (containerSize.height - padding * 2) / layout.totalHeight;
      const initialScale = Math.min(scaleX, scaleY, 1.2);

      const newTransform = {
        x: (containerSize.width - layout.totalWidth * initialScale) / 2,
        y: (containerSize.height - layout.totalHeight * initialScale) / 2,
        scale: initialScale
      };

      setTransform(newTransform);
      autoZoomAppliedRef.current = true;
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
    setTransform(prev => {
      const newScale = Math.min(Math.max(prev.scale * factor, 0.04), 20);
      const newX = mouseX - (mouseX - prev.x) * (newScale / prev.scale);
      const newY = mouseY - (mouseY - prev.y) * (newScale / prev.scale);
      return { x: newX, y: newY, scale: newScale };
    });
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
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;

      // 直接更新 transform，不使用动画
      setTransform(prev => ({
        ...prev,
        x: prev.x + dx,
        y: prev.y + dy
      }));

      setDragStart({ x: e.clientX, y: e.clientY });
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

  // 窗口大小恢复相关
  const originalWindowStateRef = useRef<{ width: number; height: number; x: number; y: number } | null>(null);
  const windowResizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 保存进入参考模式前的侧边栏状态
  const sidebarStateBeforeRef = useRef<{ isSidebarVisible: boolean; isMetadataVisible: boolean } | null>(null);

  // 右键菜单逻辑
  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();

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

  const getFileExtension = (filePath: string): string => {
    const match = filePath.match(/\.([^.]+)$/);
    return match ? match[1].toLowerCase() : 'png';
  };

  const handleSaveSession = async () => {
    try {
      const path = await save({
        filters: [{ name: 'Aurora Comparison', extensions: ['aurora'] }],
        defaultPath: `${sessionName}.aurora`
      });
      if (path) {
        const zip = new JSZip();

        const manifest: ComparisonSessionManifest = {
          version: '2.0',
          createdAt: Date.now(),
          sessionName
        };
        zip.file('manifest.json', JSON.stringify(manifest));

        const viewport: ComparisonSessionViewport = {
          scale: transform.scale,
          x: transform.x,
          y: transform.y
        };
        zip.file('viewport.json', JSON.stringify(viewport));

        const imagesFolder = zip.folder('images');
        const imageFileNames: Record<string, string> = {};

        for (let i = 0; i < layout.items.length; i++) {
          const item = layout.items[i];
          const file = files[item.id];
          if (file && file.path) {
            try {
              const base64Data = await invoke<string>('read_file_as_base64', { filePath: file.path });
              if (base64Data) {
                const base64Content = base64Data.includes(',')
                  ? base64Data.split(',')[1]
                  : base64Data;
                const imageBytes = Uint8Array.from(atob(base64Content), c => c.charCodeAt(0));
                const ext = getFileExtension(file.path);
                const fileName = `img_${i}.${ext}`;
                imageFileNames[item.id] = fileName;
                imagesFolder?.file(fileName, imageBytes);
              }
            } catch {}
          }
        }

        const layoutData: ComparisonSessionLayout = {
          items: layout.items.map(it => ({
            id: it.id,
            path: files[it.id]?.path || '',
            x: it.x,
            y: it.y,
            width: it.width,
            height: it.height,
            rotation: it.rotation,
            imageFileName: imageFileNames[it.id] || ''
          })),
          annotations: annotations,
          zOrder: zOrderIds
        };
        zip.file('layout.json', JSON.stringify(layoutData));

        const zipBlob = await zip.generateAsync({ type: 'uint8array' });
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
        let isZipFormat = false;
        try {
          const textContent = await readTextFile(path);
          const parsed = JSON.parse(textContent);
          if (parsed.version && parsed.items) {
            await loadLegacySession(parsed as ComparisonSession);
            return;
          }
        } catch {
          isZipFormat = true;
        }

        if (isZipFormat) {
          const zipBytes = await readFile(path);
          const zip = await JSZip.loadAsync(zipBytes);

          const manifestFile = zip.file('manifest.json');
          if (!manifestFile) {
            throw new Error('Invalid .aurora file: manifest.json not found');
          }
          const manifest: ComparisonSessionManifest = JSON.parse(await manifestFile.async('string'));

          const viewportFile = zip.file('viewport.json');
          let viewport: ComparisonSessionViewport | null = null;
          if (viewportFile) {
            viewport = JSON.parse(await viewportFile.async('string'));
          }

          const layoutFile = zip.file('layout.json');
          if (!layoutFile) {
            throw new Error('Invalid .aurora file: layout.json not found');
          }
          const layoutData: ComparisonSessionLayout = JSON.parse(await layoutFile.async('string'));

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
              const imageFile = zip.file(`images/${item.imageFileName}`);
              if (imageFile) {
                const imageBytes = await imageFile.async('uint8array');
                const ext = getFileExtension(item.imageFileName);
                const mimeType = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' :
                                 ext === 'png' ? 'image/png' :
                                 ext === 'gif' ? 'image/gif' :
                                 ext === 'webp' ? 'image/webp' : 'image/png';
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
                    format: getFileExtension(item.imageFileName)
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
              const levels = createMipmapLevels(img, w, h);
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
      Object.values(sessionFiles).forEach(file => {
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

  const handleReset = () => {
    setManualLayouts({});
    if (layout.totalWidth > 0) {
      const padding = 60;
      const scaleX = (containerSize.width - padding * 2) / layout.totalWidth;
      const scaleY = (containerSize.height - padding * 2) / layout.totalHeight;
      const initialScale = Math.min(scaleX, scaleY, 1.2);

      const newTransform = {
        x: (containerSize.width - layout.totalWidth * initialScale) / 2,
        y: (containerSize.height - layout.totalHeight * initialScale) / 2,
        scale: initialScale
      };

      startAnimation(newTransform);
      userInteractedRef.current = true;
      autoZoomAppliedRef.current = true;
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

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    if (contentWidth <= 0 || contentHeight <= 0) return;

    const padding = 60;
    const scaleX = (containerSize.width - padding * 2) / contentWidth;
    const scaleY = (containerSize.height - padding * 2) / contentHeight;
    const initialScale = Math.min(scaleX, scaleY, 1.2);

    const contentCenterX = minX + contentWidth / 2;
    const contentCenterY = minY + contentHeight / 2;

    const newTransform = {
      x: containerSize.width / 2 - contentCenterX * initialScale,
      y: containerSize.height / 2 - contentCenterY * initialScale,
      scale: initialScale
    };

    startAnimation(newTransform);
    userInteractedRef.current = true;
    autoZoomAppliedRef.current = true;
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

    const contentWidth = maxX - minX;
    const contentHeight = maxY - minY;

    if (contentWidth <= 0 || contentHeight <= 0) return;

    const padding = 60;
    const scaleX = (containerSize.width - padding * 2) / contentWidth;
    const scaleY = (containerSize.height - padding * 2) / contentHeight;
    const newScale = Math.min(scaleX, scaleY, 1.2);

    const contentCenterX = minX + contentWidth / 2;
    const contentCenterY = minY + contentHeight / 2;

    const newTransform = {
      x: containerSize.width / 2 - contentCenterX * newScale,
      y: containerSize.height / 2 - contentCenterY * newScale,
      scale: newScale
    };

    startAnimation(newTransform);
    userInteractedRef.current = true;
    setContextMenu(null);
    setMenuTargetId(null);
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
    { label: '添加注释', onClick: handleStartAddAnnotation, icon: <Plus size={14} /> },
    { divider: true, label: '', onClick: () => { } },
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

    // 通知父组件 selectedFileIds 已更改，以便右键菜单显示正确的数量
    onSelectedFileIdsChange?.(updatedIds);

    shouldAutoFitAfterLoadRef.current = true;

    let loadedImagesCount = 0;
    uniqueNewIds.forEach(id => {
      const file = files[id];
      if (file && file.path && !imagesCache.current.has(file.id)) {
        const img = new Image();
        img.src = convertFileSrc(file.path);
        img.onload = () => {
          const w = file.meta?.width || img.width;
          const h = file.meta?.height || img.height;
          const levels = createMipmapLevels(img, w, h);
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
    { label: '添加图片', onClick: handleOpenAddImageModal, icon: <Plus size={14} /> },
    { divider: true, label: '', onClick: () => { } },
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
  }, [isReferenceMode]);

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
      }
      if (e.key === 'a' || e.key === 'A') {
        setIsSnappingEnabled(prev => !prev);
      }
      if (e.key === 'r' || e.key === 'R') {
        toggleReferenceMode();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onCloseTab, toggleReferenceMode, isAddImageModalOpen, isReferenceMode]);

  // Handle mouse side buttons
  useEffect(() => {
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
  }, [onClose, onCloseTab, toggleReferenceMode, isAddImageModalOpen, isReferenceMode]);

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
      {/* Header - hidden in reference mode */}
      {!isReferenceMode && (
      <div
        className={`bg-white/90 dark:bg-gray-900/90 backdrop-blur-md border-b border-gray-200 dark:border-gray-800 flex items-center px-4 justify-between shrink-0 transition-transform duration-200 ease-out h-14 relative z-10`}
      >
        <div className="flex items-center space-x-2">
          {!isReferenceMode && (
            <button
              onClick={() => onLayoutToggle?.('sidebar')}
              className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${layoutProp?.isSidebarVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
              title={t('viewer.toggleSidebar')}
            >
              <Sidebar size={18} />
            </button>
          )}

          <button
            onClick={() => { onCloseTab ? onCloseTab() : onClose(); }}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
            title={t('viewer.close')}
          >
            <ChevronLeft size={18} />
          </button>
        </div>

        <div className="flex-1 text-center truncate px-4 font-medium text-gray-800 dark:text-gray-200 flex justify-center items-center">
          <div className="text-gray-900 dark:text-gray-100 font-semibold flex items-center text-lg">
            {isEditingTitle ? (
              <input
                autoFocus
                className="bg-transparent border-b-2 border-blue-500 outline-none text-center px-2 py-1 min-w-[200px]"
                value={sessionName}
                onChange={(e) => {
                  if (isEditingTitle) {
                    setSessionName(e.currentTarget.value);
                    onSessionNameChange?.(e.currentTarget.value);
                  }
                }}
                onBlur={() => setIsEditingTitle(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') setIsEditingTitle(false);
                }}
              />
            ) : (
              <div
                className="cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 px-4 py-1 rounded transition-colors flex items-center"
                onClick={() => setIsEditingTitle(true)}
              >
                <Scan size={20} className="mr-3 text-blue-500" />
                {sessionName}
              </div>
            )}
            <span className="ml-3 text-sm font-normal text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded-full">
              {imageFiles.length} / 24
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={() => setIsSnappingEnabled(!isSnappingEnabled)}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-all ${isSnappingEnabled ? 'text-blue-500' : 'text-gray-400'}`}
            title={`吸附功能 (A): ${isSnappingEnabled ? 'ON' : 'OFF'}`}
          >
            <Magnet size={18} className={isSnappingEnabled ? 'text-blue-500' : 'text-gray-400'} />
          </button>

          <button
            onClick={toggleReferenceMode}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-all ${isReferenceMode ? 'text-blue-500' : 'text-gray-400'}`}
            title={`参考模式 (R): ${isReferenceMode ? 'ON' : 'OFF'}`}
          >
            <Eye size={18} className={isReferenceMode ? 'text-blue-500' : 'text-gray-400'} />
          </button>

          <button
            onClick={handleSaveSession}
            disabled={imageFiles.length === 0}
            className={`p-2 rounded ${imageFiles.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-800'} text-gray-600 dark:text-gray-300`}
            title="保存对比信息"
          >
            <Save size={18} />
          </button>

          <button
            onClick={handleLoadSession}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
            title="读取对比信息"
          >
            <FolderOpen size={18} />
          </button>

          <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />

          <button
            onClick={handleViewAll}
            disabled={imageFiles.length === 0}
            className={`p-2 rounded ${imageFiles.length === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-800'} text-gray-600 dark:text-gray-300 transition-colors`}
            title="查看全部"
          >
            <Scan size={18} />
          </button>

          <button
            onClick={handleReset}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
            title="重置画布"
          >
            <RefreshCcw size={18} />
          </button>

          {!isReferenceMode && (
            <button
              onClick={() => onLayoutToggle?.('metadata')}
              className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${layoutProp?.isMetadataVisible ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}
              title={t('viewer.toggleMeta')}
            >
              <PanelRight size={18} />
            </button>
          )}
        </div>
      </div>
      )}

      {/* Canvas Container */}
      <div
        ref={containerRef}
        className="flex-1 relative cursor-grab active:cursor-grabbing overflow-hidden animate-fade-in"
      >
        <canvas
          ref={canvasRef}
          className="block absolute inset-0"
          style={{ width: '100%', height: '100%' }}
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
        />

        {/* Context Menu */}
        {contextMenu && (
          <ComparerContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={handleCloseContextMenu}
            options={menuOptions}
            compact={isReferenceMode}
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
        />

      </div>

      {/* Shortcuts Hint - hidden in reference mode */}
      {!isReferenceMode && (
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md rounded-full border border-gray-200 dark:border-gray-700/50 text-sm text-gray-500 dark:text-gray-400 pointer-events-none shadow-2xl animate-fade-in-up transition-opacity flex items-center space-x-4 z-[50]">
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
          <div className="flex items-center justify-center min-w-[32px] h-5 border border-gray-300 dark:border-gray-600 rounded text-[10px] font-bold mr-1.5 text-gray-900 dark:text-gray-100 bg-gray-100 dark:bg-gray-800 shadow-sm leading-none pt-0.5">ESC</div>
          <span className="text-gray-700 dark:text-gray-200 font-medium whitespace-nowrap">退出</span>
        </div>
      </div>
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
