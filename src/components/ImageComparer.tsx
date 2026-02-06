import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Maximize, RefreshCcw, Sidebar, PanelRight, ChevronLeft, Magnet, Move, X, Scan } from 'lucide-react';
import { FileNode } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ComparisonItem, Annotation, ComparisonSession } from './comparer/types';
import { EditOverlay } from './comparer/EditOverlay';
import { AnnotationLayer } from './comparer/AnnotationLayer';
import { ComparerContextMenu } from './comparer/ComparerContextMenu';
import { writeTextFile, readTextFile } from '@tauri-apps/plugin-fs';
import { save, open } from '@tauri-apps/plugin-dialog';
import { Plus, Save, FolderOpen, Trash2 } from 'lucide-react';

interface ImageComparerProps {
  selectedFileIds: string[];
  files: Record<string, FileNode>;
  onClose: () => void;
  onReady?: () => void;
  // Optional layout/navigation handlers to mirror ImageViewer
  onLayoutToggle?: (part: 'sidebar' | 'metadata') => void;
  onNavigateBack?: () => void;
  // Called when comparer requests closing the entire tab (e.g., back/ESC should close tab)
  onCloseTab?: () => void;
  layoutProp?: { isSidebarVisible?: boolean; isMetadataVisible?: boolean };
  canGoBack?: boolean;
  t: (key: string) => string;
  onSelect?: (id: string) => void;
  sessionName?: string;
  onSessionNameChange?: (name: string) => void;
}

interface ImageLayoutInfo {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  src: string;
}

export const ImageComparer: React.FC<ImageComparerProps> = ({
  selectedFileIds,
  files,
  onClose,
  onReady,
  t,
  onLayoutToggle,
  onNavigateBack,
  onCloseTab,
  layoutProp,
  canGoBack,
  onSelect,
  sessionName: sessionNameProp,
  onSessionNameChange
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [activeImageIds, setActiveImageIds] = useState<string[]>([]); const [manualLayouts, setManualLayouts] = useState<Record<string, { x: number, y: number, width: number, height: number, rotation: number }>>({});
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [pendingAnnotation, setPendingAnnotation] = useState<{ imageId: string, x: number, y: number } | null>(null);
  // zOrderIds controls drawing/interaction order (last = top)
  const [zOrderIds, setZOrderIds] = useState<string[]>([]);
  // menuTargetId stores the item id that the context menu was opened for
  const [menuTargetId, setMenuTargetId] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number, y: number } | null>(null);
  // Keep an internal snapshot of selected IDs so comparer remains visible
  // even if parent clears selection after images load.
  const initializedRef = useRef(false);
  const onReadyCalledRef = useRef(false);
  const userInteractedRef = useRef(false);
  const autoZoomAppliedRef = useRef(false);
  const [internalSelectedIds, setInternalSelectedIds] = useState<string[]>(() => selectedFileIds.slice());
  const [isSnappingEnabled, setIsSnappingEnabled] = useState(true);
  const [sessionName, setSessionName] = useState(sessionNameProp || "画布01");
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  // Marquee selection (screen coordinates)
  const [marquee, setMarquee] = useState<{ startX: number; startY: number; x: number; y: number; active: boolean } | null>(null);
  const potentialClearSelectionRef = useRef(false);
  // Animation state for smooth zoom transitions
  const [isAnimating, setIsAnimating] = useState(false);
  const animationFrameRef = useRef<number | null>(null);
  // 滚轮缩放的目标值，用于平滑过渡
  const wheelTargetRef = useRef<{ x: number; y: number; scale: number } | null>(null);
  const wheelAnimationRef = useRef<number | null>(null);

  useEffect(() => {
    if (sessionNameProp && sessionNameProp !== sessionName) {
      setSessionName(sessionNameProp);
    }
  }, [sessionNameProp]);

  // Track dark mode changes so canvas can redraw immediately when theme toggles
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

  // 缓存已加载的 HTMLImageElement 及其缩小版 (Mipmap) 以减少缩小时的锯齿
  const imagesCache = useRef<Map<string, { original: HTMLImageElement, small?: HTMLCanvasElement }>>(new Map());
  const [loadedCount, setLoadedCount] = useState(0);

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
    // Also observe element resize (e.g. sidebars toggling) to catch layout changes
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

  // Keep previous container width so we can adjust transform.x when panels toggle
  const prevContainerWidthRef = useRef<number>(0);
  const prevMetadataVisibleRef = useRef<boolean | undefined>(layoutProp?.isMetadataVisible);

  // General width change handling: keep a prev width and update it
  useEffect(() => {
    const prev = prevContainerWidthRef.current;
    const curr = containerSize.width;
    if (prev && curr && prev !== curr && !isDragging) {
      // If metadata visibility changed, shift by the full delta so content moves left/right
      const prevMeta = prevMetadataVisibleRef.current;
      const currMeta = layoutProp?.isMetadataVisible;
      if (typeof prevMeta !== 'undefined' && prevMeta !== currMeta) {
        const delta = curr - prev;
        setTransform(prevT => ({ ...prevT, x: prevT.x + delta }));
      } else {
        // Otherwise keep visual center stable by shifting half the change
        const delta = curr - prev;
        setTransform(prevT => ({ ...prevT, x: prevT.x + delta / 2 }));
      }
    }
    prevContainerWidthRef.current = curr;
    prevMetadataVisibleRef.current = layoutProp?.isMetadataVisible;
  }, [containerSize.width, isDragging, layoutProp?.isMetadataVisible]);

  // Filter selected files to get only valid images.
  // We respect the order of internalSelectedIds naturally.
  const imageFiles = useMemo(() => {
    return internalSelectedIds
      .map(id => files[id])
      .filter(file => file && file.path);
  }, [internalSelectedIds, files]);

  // Load images & create small versions for anti-aliasing
  useEffect(() => {
    imageFiles.forEach(file => {
      if (!imagesCache.current.has(file.id)) {
        const img = new Image();
        img.src = convertFileSrc(file.path);
        img.onload = () => {
          // 创建一个 0.25 倍的中间层 Canvas
          // 当图片缩小到很小时，从这个中间层绘图能大幅减少锯齿
          const smallCanvas = document.createElement('canvas');
          const scale = 0.25;
          const w = (file.meta?.width || img.width);
          const h = (file.meta?.height || img.height);
          smallCanvas.width = w * scale;
          smallCanvas.height = h * scale;
          const sctx = smallCanvas.getContext('2d');
          if (sctx) {
            sctx.imageSmoothingEnabled = true;
            sctx.imageSmoothingQuality = 'high';
            sctx.drawImage(img, 0, 0, smallCanvas.width, smallCanvas.height);
          }

          imagesCache.current.set(file.id, {
            original: img,
            small: smallCanvas
          });
          setLoadedCount(prev => prev + 1);
        };
      }
    });
  }, [imageFiles]);

  // Initialize internal selection once when component mounts
  // Initialize internal selection once when component mounts, and sort by size initially for better packing
  useEffect(() => {
    if (!initializedRef.current) {
      initializedRef.current = true;
      // Initial sort by size
      const sortedIds = selectedFileIds.slice().sort((idA, idB) => {
        const a = files[idA];
        const b = files[idB];
        if (!a || !b) return 0;
        const sizeA = (a.meta?.width || 0) * (a.meta?.height || 0);
        const sizeB = (b.meta?.width || 0) * (b.meta?.height || 0);
        return sizeB - sizeA;
      });
      setInternalSelectedIds(sortedIds);
      // Initialize z-order to the same deterministic order
      setZOrderIds(sortedIds);
      imagesCache.current.clear();
      setLoadedCount(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Notify parent when all images are loaded
  useEffect(() => {
    if (imageFiles.length > 0 && loadedCount >= imageFiles.length) {
      // Ensure onReady only fired once to avoid parent repeatedly clearing selection
      if (!onReadyCalledRef.current) {
        onReadyCalledRef.current = true;
        onReady?.();
      }
    }
  }, [loadedCount, imageFiles.length, onReady]);

  // Layout calculation (紧凑型环绕填充)
  const layout = useMemo(() => {
    if (imageFiles.length === 0)
      return { items: [], totalWidth: 0, totalHeight: 0 };

    const spacing = 40;
    const items: ImageLayoutInfo[] = [];

    // 按尺寸排序进行填充（与 z-order 无关）
    const packOrder = imageFiles.slice().sort((a, b) => {
      const sizeA = (a.meta?.width || 0) * (a.meta?.height || 0);
      const sizeB = (b.meta?.width || 0) * (b.meta?.height || 0);
      return sizeB - sizeA;
    });

    const checkOverlap = (rect: { x: number; y: number; w: number; h: number }, existing: ImageLayoutInfo[]) => {
      for (const item of existing) {
        // 增加一点容差避免数学计算误差
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

    // 第一张图（最大）居中
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
        // 主方位
        candidates.push({ x: item.x + item.width + spacing, y: item.y }); // 右
        candidates.push({ x: item.x - w - spacing, y: item.y }); // 左
        candidates.push({ x: item.x, y: item.y + item.height + spacing }); // 下
        candidates.push({ x: item.x, y: item.y - h - spacing }); // 上

        // 补角
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

  // Persist computed layout positions for any items that do not yet have manual overrides
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.items]);

  // Group transform state

  const layoutItemMap = useMemo(() => {
    const m: Record<string, ComparisonItem> = {};
    layout.items.forEach(it => (m[it.id] = it));
    return m;
  }, [layout.items]);

  // Group transform state
  const [groupBounds, setGroupBounds] = useState<{ x: number, y: number, width: number, height: number, rotation: number } | null>(null);
  // transientGroup tracks in-flight group updates while user drags (so overlay follows)
  const [transientGroup, setTransientGroup] = useState<ComparisonItem | null>(null);
  // flag to indicate group is being edited (prevents auto-recalc during drag)
  const isGroupEditingRef = useRef(false);

  // Re-calculate group bounds when selection changes (only if > 1 items)
  useEffect(() => {
    if (activeImageIds.length <= 1) {
      setGroupBounds(null);
      return;
    }

    // Compute AABB
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    // We use the 'layout' directly as it contains the freshest positions including manualLayouts
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeImageIds]); // Intentionally ignore layout changes to avoid re-calcing AABB during drag interaction

  // Helper: rotate a point (x,y) around center (cx,cy) by angle degrees
  const rotatePointAround = (x: number, y: number, cx: number, cy: number, angleDeg: number) => {
    const rad = angleDeg * Math.PI / 180;
    const dx = x - cx;
    const dy = y - cy;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return { x: rx + cx, y: ry + cy };
  };

  // Recompute group AABB from current item layouts (callable after interactions)
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

  // Ensure transientGroup is cleared and groupBounds recalculated when selection changes
  useEffect(() => {
    // If currently editing a group, don't override the in-flight state
    if (isGroupEditingRef.current) return;

    // Clear any leftover transient state from previous interactions
    setTransientGroup(null);

    if (activeImageIds.length > 1) {
      computeAndSetGroupBounds();
    } else {
      setGroupBounds(null);
    }
  }, [activeImageIds]);

  // Helper: test whether world point is inside a rotated rect item
  const pointInRotatedItem = (worldX: number, worldY: number, it: ComparisonItem) => {
    const cx = it.x + it.width / 2;
    const cy = it.y + it.height / 2;
    // rotate world point by -rotation to bring into item's local (unrotated) space
    const local = rotatePointAround(worldX, worldY, cx, cy, -it.rotation);
    return local.x >= it.x && local.x <= it.x + it.width && local.y >= it.y && local.y <= it.y + it.height;
  };

  // Helper: transform a world point to item's local (unrotated) coords
  const worldToLocalPoint = (worldX: number, worldY: number, it: ComparisonItem) => {
    const cx = it.x + it.width / 2;
    const cy = it.y + it.height / 2;
    return rotatePointAround(worldX, worldY, cx, cy, -it.rotation);
  };

  // Helper: transform a world point to screen pixel coords based on transform
  const worldToScreen = (wx: number, wy: number) => ({ x: wx * transform.scale + transform.x, y: wy * transform.scale + transform.y });

  // Helper: compute axis-aligned bounding box of a rotated item in world coords
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

  // Canvas drawing
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || containerSize.width === 0) return;

    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = containerSize.width * dpr;
    canvas.height = containerSize.height * dpr;
    ctx.scale(dpr, dpr);

    // Use tracked dark mode state so canvas redraws immediately when theme changes
    const isDark = isDarkMode;
    const bgColor = isDark ? '#0a0a0a' : '#f9fafb';
    const dotColor = isDark ? 'rgba(156, 163, 175, 0.25)' : 'rgba(107, 114, 128, 0.2)'; // 调高了点阵的可见度

    // 开启高质量平滑
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // 背景
    ctx.fillStyle = bgColor;
    ctx.fillRect(0, 0, containerSize.width, containerSize.height);

    // 智能点阵背景 (在任何缩放级别下保持可见且不卡顿)
    const baseSpacing = 40;
    let gridSize = baseSpacing * transform.scale;

    // 性能与视觉保护：如果点阵过密（间距小于 15px），则跨步显示（如每隔 2 个点显示一个）
    let step = 1;
    if (gridSize < 15) {
      step = Math.max(1, Math.floor(30 / gridSize));
      gridSize *= step;
    }

    ctx.fillStyle = dotColor;
    const offsetX = transform.x % gridSize;
    const offsetY = transform.y % gridSize;

    // 点的大小：缩小比例很大时，稍微增大点的大小以便看见
    const radius = transform.scale < 0.2 ? 1.5 : 1.2;

    for (let x = offsetX; x < containerSize.width; x += gridSize) {
      for (let y = offsetY; y < containerSize.height; y += gridSize) {
        ctx.beginPath();
        ctx.arc(x, y, radius, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 绘制图片
    ctx.save();
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.scale, transform.scale);

    // Draw according to z-order (last = top). If zOrderIds empty, fallback to layout.items order.
    const drawOrder = zOrderIds.length ? zOrderIds.filter(id => layoutItemMap[id]) : layout.items.map(it => it.id);
    for (const id of drawOrder) {
      const item = layoutItemMap[id];
      if (!item) continue;
      const cache = imagesCache.current.get(item.id);

      ctx.save();
      // 应用旋转和位移
      ctx.translate(item.x + item.width / 2, item.y + item.height / 2);
      ctx.rotate((item.rotation * Math.PI) / 180);
      ctx.translate(-item.width / 2, -item.height / 2);

      // 绘制占位背景
      ctx.fillStyle = '#111827';
      ctx.fillRect(0, 0, item.width, item.height);

      if (cache) {
        const currentEffectiveScale = transform.scale;
        if (currentEffectiveScale < 0.2 && cache.small) {
          ctx.drawImage(cache.small, 0, 0, item.width, item.height);
        } else {
          ctx.drawImage(cache.original, 0, 0, item.width, item.height);
        }

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
  }, [transform, layout, containerSize, loadedCount, isDarkMode, activeImageIds, zOrderIds, layoutItemMap]);

  // Initial auto-zoom and center
  useEffect(() => {
    // Only auto-fit if we haven't applied auto-zoom yet and user hasn't interacted
    if (layout.totalWidth > 0 && containerSize.width > 0 && !userInteractedRef.current && !autoZoomAppliedRef.current) {
      const padding = 60;
      const scaleX = (containerSize.width - padding * 2) / layout.totalWidth;
      const scaleY = (containerSize.height - padding * 2) / layout.totalHeight;
      const initialScale = Math.min(scaleX, scaleY, 1.2);

      setTransform({
        x: (containerSize.width - layout.totalWidth * initialScale) / 2,
        y: (containerSize.height - layout.totalHeight * initialScale) / 2,
        scale: initialScale
      });
      autoZoomAppliedRef.current = true;
    }
  }, [layout.totalWidth, layout.totalHeight, containerSize.width, containerSize.height]);

  // Mouse wheel zoom with smooth animation
  const handleWheel = (e: React.WheelEvent) => {
    // Only call preventDefault if the native event is cancelable.
    const native = e.nativeEvent as WheelEvent | any;
    if (native && native.cancelable) {
      e.preventDefault();
    }
    // mark manual interaction
    userInteractedRef.current = true;

    // 滚轮缩放时自动关闭右键菜单
    if (contextMenu) {
      setContextMenu(null);
    }

    const zoomSpeed = 0.0015;
    const factor = Math.exp(-e.deltaY * zoomSpeed);

    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;

    const mouseX = e.clientX - rect.left;
    const mouseY = e.clientY - rect.top;

    // 计算目标缩放值，基于当前目标或当前实际值
    const currentScale = wheelTargetRef.current?.scale || transform.scale;
    const newScale = Math.min(Math.max(currentScale * factor, 0.04), 20);

    // 计算新的位置，保持鼠标位置为缩放中心
    const currentX = wheelTargetRef.current?.x || transform.x;
    const currentY = wheelTargetRef.current?.y || transform.y;
    const newX = mouseX - (mouseX - currentX) * (newScale / currentScale);
    const newY = mouseY - (mouseY - currentY) * (newScale / currentScale);

    // 更新目标值
    wheelTargetRef.current = { x: newX, y: newY, scale: newScale };

    // 如果没有正在进行的滚轮动画，启动一个
    if (wheelAnimationRef.current === null) {
      const startTransform = { ...transform };
      const startTime = performance.now();
      const duration = 150; // 较短的动画时长，使滚轮响应更灵敏

      const animate = (currentTime: number) => {
        if (!wheelTargetRef.current) {
          wheelAnimationRef.current = null;
          return;
        }

        const elapsed = currentTime - startTime;
        const progress = Math.min(elapsed / duration, 1);

        // 使用 easeOutQuad 缓动函数，使滚轮缩放更加自然
        const eased = 1 - (1 - progress) * (1 - progress);

        const currentTransform = {
          x: startTransform.x + (wheelTargetRef.current.x - startTransform.x) * eased,
          y: startTransform.y + (wheelTargetRef.current.y - startTransform.y) * eased,
          scale: startTransform.scale + (wheelTargetRef.current.scale - startTransform.scale) * eased
        };

        setTransform(currentTransform);

        if (progress < 1) {
          wheelAnimationRef.current = requestAnimationFrame(animate);
        } else {
          // 动画结束，清理状态
          wheelAnimationRef.current = null;
          wheelTargetRef.current = null;
        }
      };

      wheelAnimationRef.current = requestAnimationFrame(animate);
    }
  };

  // Dragging
  const handleMouseDown = (e: React.MouseEvent) => {
    userInteractedRef.current = true;

    // 左键点击：选择图片
    if (e.button === 0) {
      const rect = containerRef.current?.getBoundingClientRect();
      if (rect) {
        const mouseX = e.clientX - rect.left;
        const mouseY = e.clientY - rect.top;

        // 转换画布坐标到世界坐标
        const worldX = (mouseX - transform.x) / transform.scale;
        const worldY = (mouseY - transform.y) / transform.scale;

        // 查找点击到了哪张图（根据 zOrder，从顶层向下查找）
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
            // Toggle selection
            if (isSelected) {
              setActiveImageIds(prev => prev.filter(id => id !== clickedId));
            } else {
              // Add to end (becomes new primary active)
              setActiveImageIds(prev => [...prev, clickedId!]);
            }
          } else {
            // No Ctrl
            if (isSelected) {
              // 如果点击的是已选中的项，保持当前多选状态不变
              // 并将被点击的项移到数组末尾使其成为“主控项”，方便 EditOverlay 对齐
              setActiveImageIds(prev => {
                const others = prev.filter(id => id !== clickedId);
                return [...others, clickedId!];
              });
            } else {
              // 点击未选中的项 -> 单选
              setActiveImageIds([clickedId]);
            }
          }

          if (!isCtrl && !isSelected) {
            onSelect?.(clickedId);
          }

          // Clicking an item cancels any pending marquee start
          potentialClearSelectionRef.current = false;
          setMarquee(null);
        } else {
          // Clicked empty space -> start marquee selection (don't clear immediately)
          const rect = containerRef.current?.getBoundingClientRect();
          if (rect) {
            setMarquee({ active: true, startX: mouseX, startY: mouseY, x: mouseX, y: mouseY });
            potentialClearSelectionRef.current = true;
          } else {
            setActiveImageIds([]);
            onSelect?.('');
          }
        }
      }
    }
    // 中键点击：执行拖拽
    else if (e.button === 1) {
      e.preventDefault(); // 防止中键自动滚动
      setIsDragging(true);
      setDragStart({ x: e.clientX, y: e.clientY });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (isDragging) {
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      setTransform(prev => ({ ...prev, x: prev.x + dx, y: prev.y + dy }));
      setDragStart({ x: e.clientX, y: e.clientY });
    }

    // Update marquee selection box (screen coords)
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
          onSelect?.(ids[ids.length - 1] || '');
        } else {
          // If it was a click (tiny box) and we set a potential clear, clear selection
          const dx = marquee.x - marquee.startX;
          const dy = marquee.y - marquee.startY;
          const distSq = dx * dx + dy * dy;
          if (distSq < 9 && potentialClearSelectionRef.current) {
            setActiveImageIds([]);
            onSelect?.('');
          }
        }
      }

      setMarquee(null);
      potentialClearSelectionRef.current = false;
    } else {
      potentialClearSelectionRef.current = false;
    }
  };

  // 右键菜单逻辑
  const handleContextMenu = (e: React.MouseEvent) => {
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
          onSelect?.(targetId);
        }
      }
    }

    setMenuTargetId(targetId);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleSaveSession = async () => {
    try {
      const path = await save({
        filters: [{ name: 'Aurora Comparison', extensions: ['aurora'] }],
        defaultPath: `${sessionName}.aurora`
      });
      if (path) {
        const session: ComparisonSession = {
          version: '1.0',
          items: layout.items.map(it => ({
            id: it.id,
            path: files[it.id]?.path || '',
            x: it.x,
            y: it.y,
            width: it.width,
            height: it.height,
            rotation: it.rotation
          })),
          annotations: annotations,
          zOrder: zOrderIds
        };
        await writeTextFile(path, JSON.stringify(session));
      }
    } catch (err) {
      console.error('Save failed', err);
    }
  };

  const handleLoadSession = async () => {
    try {
      const path = await open({
        filters: [{ name: 'Aurora Comparison', extensions: ['aurora'] }]
      });
      if (path && typeof path === 'string') {
        const content = await readTextFile(path);
        const session: ComparisonSession = JSON.parse(content);
        const newManuals: Record<string, any> = {};
        const newIds: string[] = [];

        session.items.forEach(it => {
          if (files[it.id]) {
            newManuals[it.id] = { x: it.x, y: it.y, width: it.width, height: it.height, rotation: it.rotation };
            newIds.push(it.id);
          } else {
            console.warn('Loaded session references missing file', it.id);
          }
        });

        // 这里的 logic 可能需要根据实际项目情况调整：是否合并当前选择还是替换
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
      }
    } catch (err) {
      console.error('Load failed', err);
    }
  };

  const handleRemoveImage = () => {
    const targetId = menuTargetId || (activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : null);
    if (!targetId) return;

    // Identify items to remove: if targetId is in selection, remove all selected. Else remove targetId only.
    const idsToRemove = activeImageIds.includes(targetId) ? activeImageIds : [targetId];

    setInternalSelectedIds(prev => prev.filter(i => !idsToRemove.includes(i)));
    setZOrderIds(prev => prev.filter(i => !idsToRemove.includes(i)));
    setManualLayouts(prev => {
      const next = { ...prev };
      idsToRemove.forEach(id => delete next[id]);
      return next;
    });
    setActiveImageIds([]);
    setMenuTargetId(null);
    setContextMenu(null);
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

  // 平滑动画辅助函数
  const animateTransform = (targetTransform: { x: number; y: number; scale: number }, duration: number = 400) => {
    // 取消之前的动画
    if (animationFrameRef.current !== null) {
      cancelAnimationFrame(animationFrameRef.current);
    }

    const startTransform = { ...transform };
    const startTime = performance.now();

    setIsAnimating(true);

    const animate = (currentTime: number) => {
      const elapsed = currentTime - startTime;
      const progress = Math.min(elapsed / duration, 1);

      // 使用 easeInOutCubic 缓动函数
      const eased = progress < 0.5
        ? 4 * progress * progress * progress
        : 1 - Math.pow(-2 * progress + 2, 3) / 2;

      const currentTransform = {
        x: startTransform.x + (targetTransform.x - startTransform.x) * eased,
        y: startTransform.y + (targetTransform.y - startTransform.y) * eased,
        scale: startTransform.scale + (targetTransform.scale - startTransform.scale) * eased
      };

      setTransform(currentTransform);

      if (progress < 1) {
        animationFrameRef.current = requestAnimationFrame(animate);
      } else {
        setIsAnimating(false);
        animationFrameRef.current = null;
      }
    };

    animationFrameRef.current = requestAnimationFrame(animate);
  };

  // 清理动画
  useEffect(() => {
    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      if (wheelAnimationRef.current !== null) {
        cancelAnimationFrame(wheelAnimationRef.current);
      }
    };
  }, []);

  const handleViewImage = () => {
    const targetId = menuTargetId || (activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : null);
    if (!targetId) return;

    const targetItem = layoutItemMap[targetId];
    if (!targetItem) return;

    // 计算图片的中心点
    const imageCenterX = targetItem.x + targetItem.width / 2;
    const imageCenterY = targetItem.y + targetItem.height / 2;

    // 计算合适的缩放比例，使图片适应容器大小
    const padding = 60;
    const scaleX = (containerSize.width - padding * 2) / targetItem.width;
    const scaleY = (containerSize.height - padding * 2) / targetItem.height;
    const newScale = Math.min(scaleX, scaleY, 1.2);

    // 计算新的变换，使图片居中显示
    const newX = containerSize.width / 2 - imageCenterX * newScale;
    const newY = containerSize.height / 2 - imageCenterY * newScale;

    // 使用平滑动画过渡
    animateTransform({
      x: newX,
      y: newY,
      scale: newScale
    }, 500); // 500ms 动画时长

    userInteractedRef.current = true;
    setContextMenu(null);
    setMenuTargetId(null);
  };

  const handleReorder = (type: 'top' | 'bottom' | 'up' | 'down') => {
    // For simplicity, reorder affects the primary target or all selected? 
    // Implementing "Group Reorder" is complex because they might be interleaved.
    // Current strategy: Only reorder the specific target (or primary active) to avoid chaos, 
    // OR iterate all selected. Let's iterate all selected if target is in selection.

    const targetId = menuTargetId || (activeImageIds.length > 0 ? activeImageIds[activeImageIds.length - 1] : null);
    if (!targetId) return;

    const idsToProcess = activeImageIds.includes(targetId) ? [...activeImageIds] : [targetId];

    // Process one by one. For 'top', we should process in original z-order to maintain relative order?
    // This is getting complicated. Let's stick to simplest: Reorder ONLY the targetId for now, 
    // or loop them. If we loop 'top', the last one processed ends up on very top.

    setZOrderIds(prev => {
      let next = [...prev];
      idsToProcess.forEach(id => {
        // Apply same logic as before for single item. 
        // Note: This nests the logic which is inefficient but functional.
        // ... (Reusing the previous logic block efficiently is hard without refactoring)
        // Let's refactor the core move logic into a helper if possible, or just copy-paste with slight mod.
        // Since we can't easily extract a function in this replace block, we will just process the `targetId` ONLY for now
        // to prevent bugs, as requested in strict mode. 
        // TODO: Enhance to group reorder later.
      });

      // Falling back to single item reorder to ensure stability, as Group Reorder logic was not fully detailed in plan.
      const id = targetId;
      const visible = next.filter(i => layoutItemMap[i]);
      const idx = visible.indexOf(id);
      if (idx === -1) return prev; // nothing to do

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
    setManualLayouts({}); // Global reset clears manual transforms
    if (layout.totalWidth > 0) {
      const padding = 60;
      const scaleX = (containerSize.width - padding * 2) / layout.totalWidth;
      const scaleY = (containerSize.height - padding * 2) / layout.totalHeight;
      const initialScale = Math.min(scaleX, scaleY, 1.2);

      setTransform({
        x: (containerSize.width - layout.totalWidth * initialScale) / 2,
        y: (containerSize.height - layout.totalHeight * initialScale) / 2,
        scale: initialScale
      });
      // Consider this a manual interaction to avoid future auto-fit on layout toggles
      userInteractedRef.current = true;
      autoZoomAppliedRef.current = true;
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
    { label: '添加注释', onClick: handleStartAddAnnotation, icon: <Plus size={14} /> },
    { divider: true, label: '', onClick: () => { } },
    { label: '从对比中移除', onClick: handleRemoveImage, icon: <Trash2 size={14} />, style: 'text-red-500 hover:bg-red-50' }
  ];

  const nonSelectedMenuOptions = [
    { label: '保存对比信息', onClick: handleSaveSession, icon: <Save size={14} /> },
    { label: '读取对比信息', onClick: handleLoadSession, icon: <FolderOpen size={14} /> },
    { divider: true, label: '', onClick: () => { } },
    { label: '重置窗口', onClick: handleReset, icon: <RefreshCcw size={14} /> },
  ];

  const menuOptions = menuTargetId ? selectedMenuOptions : nonSelectedMenuOptions;

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (onCloseTab) onCloseTab();
        else onClose();
      }
      if (e.key === 'a' || e.key === 'A') {
        setIsSnappingEnabled(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onCloseTab]);

  // Handle mouse side buttons (Back/Forward) override
  // We use capture phase to intercept events before TopBar receives them
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // 3: Back button, 4: Forward button
      if (e.button === 3) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (onCloseTab) onCloseTab();
        else onClose();
      } else if (e.button === 4) {
        // Block forward navigation
        e.stopImmediatePropagation();
        e.preventDefault();
      }
    };

    window.addEventListener('mouseup', handleMouseUp, { capture: true });
    return () => window.removeEventListener('mouseup', handleMouseUp, { capture: true });
  }, [onClose, onCloseTab]);

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
      {/* Header */}
      <div className="h-14 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md border-b border-gray-200 dark:border-gray-800 flex items-center px-4 justify-between z-10 shrink-0">
        <div className="flex items-center space-x-2">
          <button
            onClick={() => onLayoutToggle?.('sidebar')}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${layoutProp?.isSidebarVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
            title={t('viewer.toggleSidebar')}
          >
            <Sidebar size={18} />
          </button>

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
            onClick={handleSaveSession}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
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
            onClick={handleReset}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
            title="重置画布"
          >
            <RefreshCcw size={18} />
          </button>

          <button
            onClick={() => onLayoutToggle?.('metadata')}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${layoutProp?.isMetadataVisible ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}
            title={t('viewer.toggleMeta')}
          >
            <PanelRight size={18} />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div
        ref={containerRef}
        className="flex-1 relative cursor-grab active:cursor-grabbing overflow-hidden animate-fade-in"
      >
        <canvas
          ref={canvasRef}
          className="w-full h-full block"
        />

        {/* Marquee selection overlay (screen-space) */}
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

        {/* 编辑层 Overlay */}
        {/* 编辑层 Overlay */}
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
            // 支持群组编辑：当 id === 'GROUP_SELECTION' 且存在多个选中项时，
            // 将对群组边界的变换（平移 / 缩放 / 旋转）应用到每个成员。
            if (id === 'GROUP_SELECTION' && activeImageIds.length > 1 && (groupBounds || transientGroup)) {
              const oldGroup = transientGroup || groupBounds!;
              const newGroup = {
                x: updates.x !== undefined ? updates.x : oldGroup.x,
                y: updates.y !== undefined ? updates.y : oldGroup.y,
                width: updates.width !== undefined ? updates.width : oldGroup.width,
                height: updates.height !== undefined ? updates.height : oldGroup.height,
                rotation: updates.rotation !== undefined ? updates.rotation : (oldGroup.rotation || 0)
              };

              // Compute raw deltas
              const rawSX = newGroup.width / Math.max(1e-6, oldGroup.width);
              const rawSY = newGroup.height / Math.max(1e-6, oldGroup.height);
              const rawDR = newGroup.rotation - (oldGroup.rotation || 0);

              const oldCenter = { x: oldGroup.x + oldGroup.width / 2, y: oldGroup.y + oldGroup.height / 2 };
              const newCenter = { x: newGroup.x + newGroup.width / 2, y: newGroup.y + newGroup.height / 2 };
              const dCenter = { x: newCenter.x - oldCenter.x, y: newCenter.y - oldCenter.y };

              // Clamp per-event changes to avoid "飞出" 的行为
              const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

              // Determine whether edges were effectively fixed by the EditOverlay's computation (helps preserve pivot)
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

              // Update transient so overlay follows immediately
              setTransientGroup({ ...appliedNewGroup } as ComparisonItem);

              // Apply transforms to each member around the oldGroup center
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
              // 单项或回退到原来的按项更新逻辑（保持向后兼容）
              const oldItem = layoutItemMap[id];
              if (!oldItem) return;

              // 2. 计算增量
              // Position
              const dx = (updates.x !== undefined) ? updates.x - oldItem.x : 0;
              const dy = (updates.y !== undefined) ? updates.y - oldItem.y : 0;
              // Rotation
              const dr = (updates.rotation !== undefined) ? updates.rotation - oldItem.rotation : 0;
              // Scale (Ratio)
              const rw = (updates.width !== undefined) ? updates.width / oldItem.width : 1;
              const rh = (updates.height !== undefined) ? updates.height / oldItem.height : 1;

              setManualLayouts(prev => {
                const next = { ...prev };
                activeImageIds.forEach(targetId => {
                  const targetOld = layoutItemMap[targetId];
                  if (!targetOld) return; // Should not happen

                  // Base config from previous manual or default layout
                  const base = prev[targetId] || targetOld;

                  next[targetId] = {
                    ...base,
                    x: base.x + dx,
                    y: base.y + dy,
                    rotation: (base.rotation || 0) + dr,
                    // In-Place Scale: active target gets exact values, others get ratio applied
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

        {/* 右键菜单 */}
        {contextMenu && (
          <ComparerContextMenu
            x={contextMenu.x}
            y={contextMenu.y}
            onClose={() => setContextMenu(null)}
            options={menuOptions}
          />
        )}

        {/* 注释层 */}
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

      {/* Shortcuts Hint */}
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
    </div>
  );
};
