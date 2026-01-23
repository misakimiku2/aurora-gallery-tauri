import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Maximize, RefreshCcw, Sidebar, PanelRight, ChevronLeft, Mouse, Move, X } from 'lucide-react';
import { FileNode } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { ComparisonItem, Annotation, ComparisonSession } from './comparer/types';
import { EditOverlay } from './comparer/EditOverlay';
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
  layoutProp?: { isSidebarVisible?: boolean; isMetadataVisible?: boolean };
  canGoBack?: boolean;
  t: (key: string) => string;
  onSelect?: (id: string) => void;
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
  layoutProp,
  canGoBack,
  onSelect
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  const [activeImageId, setActiveImageId] = useState<string | null>(null);
  const [manualLayouts, setManualLayouts] = useState<Record<string, { x: number, y: number, width: number, height: number, rotation: number }>>({});
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

  const layoutItemMap = useMemo(() => {
    const m: Record<string, ComparisonItem> = {};
    layout.items.forEach(it => (m[it.id] = it));
    return m;
  }, [layout.items]);

  // Helper: rotate a point (x,y) around center (cx,cy) by angle degrees
  const rotatePointAround = (x: number, y: number, cx: number, cy: number, angleDeg: number) => {
    const rad = angleDeg * Math.PI / 180;
    const dx = x - cx;
    const dy = y - cy;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return { x: rx + cx, y: ry + cy };
  };

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
        if (currentEffectiveScale < 0.2 * (item.width / 1000) && cache.small) {
          ctx.drawImage(cache.small, 0, 0, item.width, item.height);
        } else {
          ctx.drawImage(cache.original, 0, 0, item.width, item.height);
        }

        // 绘制边框
        if (item.id === activeImageId) {
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
  }, [transform, layout, containerSize, loadedCount, isDarkMode, activeImageId, zOrderIds, layoutItemMap]);

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

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    // Only call preventDefault if the native event is cancelable.
    // In some browsers the wheel event may be passive; calling preventDefault
    // on a passive listener throws: "Unable to preventDefault inside passive event listener invocation.".
    const native = e.nativeEvent as WheelEvent | any;
    if (native && native.cancelable) {
      e.preventDefault();
    }
    // mark manual interaction
    userInteractedRef.current = true;
    const zoomSpeed = 0.0015;
    const factor = Math.exp(-e.deltaY * zoomSpeed);

    const newScale = Math.min(Math.max(transform.scale * factor, 0.04), 20);

    const rect = containerRef.current?.getBoundingClientRect();
    if (rect) {
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;

      const newX = mouseX - (mouseX - transform.x) * (newScale / transform.scale);
      const newY = mouseY - (mouseY - transform.y) * (newScale / transform.scale);

      setTransform({ x: newX, y: newY, scale: newScale });
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
          setActiveImageId(clickedId);
          onSelect?.(clickedId);
        } else {
          setActiveImageId(null);
          onSelect?.(''); // Clear selection in parent
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
  };

  const handleMouseUp = () => setIsDragging(false);

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
        setActiveImageId(targetId);
        onSelect?.(targetId);
      }
    }

    setMenuTargetId(targetId);
    setContextMenu({ x: e.clientX, y: e.clientY });
  };

  const handleSaveSession = async () => {
    try {
      const path = await save({
        filters: [{ name: 'Aurora Comparison', extensions: ['aurora'] }],
        defaultPath: 'comparison_session.aurora'
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
    const id = menuTargetId || activeImageId;
    if (!id) return;
    setInternalSelectedIds(prev => prev.filter(i => i !== id));
    setZOrderIds(prev => prev.filter(i => i !== id));
    setManualLayouts(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setActiveImageId(null);
    setMenuTargetId(null);
    setContextMenu(null);
  };

  const handleResetItem = () => {
    const id = menuTargetId || activeImageId;
    if (!id) return;
    setManualLayouts(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setContextMenu(null);
    setMenuTargetId(null);
  };

  const handleReorder = (type: 'top' | 'bottom' | 'up' | 'down') => {
    const id = menuTargetId || activeImageId;
    if (!id) return;

    setZOrderIds(prev => {
      const visible = prev.filter(i => layoutItemMap[i]);
      const idx = visible.indexOf(id);
      if (idx === -1) return prev;
      const next = [...prev];

      // Helper to move id to position pos (in next array)
      const moveToPos = (pos: number) => {
        const curIdx = next.indexOf(id);
        if (curIdx === -1) return next;
        next.splice(curIdx, 1);
        // clamp pos
        const p = Math.max(0, Math.min(pos, next.length));
        next.splice(p, 0, id);
        return next;
      };

      if (type === 'top') {
        // find highest overlapping index in visible, move id above it
        let highestOverlapIdx = -1;
        for (let i = visible.length - 1; i >= 0; i--) {
          const otherId = visible[i];
          if (otherId === id) continue;
          if (itemsOverlap(id, otherId)) {
            highestOverlapIdx = i;
            break;
          }
        }
        if (highestOverlapIdx === -1) {
          // no overlap found, move to global top
          return moveToPos(next.length);
        }
        // compute position in next array relative to highestOverlapIdx
        const refId = visible[highestOverlapIdx];
        const refPos = next.indexOf(refId);
        return moveToPos(refPos + 1);
      } else if (type === 'bottom') {
        // find lowest overlapping index and move id just below it
        let lowestOverlapIdx = -1;
        for (let i = 0; i < visible.length; i++) {
          const otherId = visible[i];
          if (otherId === id) continue;
          if (itemsOverlap(id, otherId)) {
            lowestOverlapIdx = i;
            break;
          }
        }
        if (lowestOverlapIdx === -1) {
          // no overlap found, move to global bottom
          return moveToPos(0);
        }
        const refId = visible[lowestOverlapIdx];
        const refPos = next.indexOf(refId);
        return moveToPos(refPos);
      } else if (type === 'up') {
        // move id up within overlapping stack first; otherwise move one step up
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
          // fallback: single-step up in global z-order
          const curPos = next.indexOf(id);
          if (curPos < next.length - 1) {
            [next[curPos], next[curPos + 1]] = [next[curPos + 1], next[curPos]];
          }
        }
        return next;
      } else if (type === 'down') {
        // move id down within overlapping stack first; otherwise move one step down
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
          if (curPos > 0) {
            [next[curPos], next[curPos - 1]] = [next[curPos - 1], next[curPos]];
          }
        }
        return next;
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

  const menuOptions = [
    { label: '重置变换', onClick: handleResetItem, icon: <RefreshCcw size={14} /> },
    { divider: true, label: '', onClick: () => { } },
    { label: '放置到最顶层', onClick: () => handleReorder('top'), icon: <Maximize size={14} className="rotate-45" /> },
    { label: '放置到上方', onClick: () => handleReorder('up'), icon: <Maximize size={14} className="rotate-45" /> }, // Use appropriate icons
    { label: '放置到下方', onClick: () => handleReorder('down'), icon: <Maximize size={14} className="rotate-45" /> },
    { label: '放置到最底层', onClick: () => handleReorder('bottom'), icon: <Maximize size={14} className="rotate-45" /> },
    { divider: true, label: '', onClick: () => { } },
    { label: '添加注释', onClick: handleStartAddAnnotation, icon: <Plus size={14} /> },
    { label: '保存对比信息', onClick: handleSaveSession, icon: <Save size={14} /> },
    { label: '读取对比信息', onClick: handleLoadSession, icon: <FolderOpen size={14} /> },
    { divider: true, label: '', onClick: () => { } },
    { label: '从对比中移除', onClick: handleRemoveImage, icon: <Trash2 size={14} />, style: 'text-red-500 hover:bg-red-50' }
  ];

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

  // Keyboard support
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="w-full h-full flex-1 flex flex-col overflow-hidden select-none"
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

          <div className="flex space-x-1">
            <button
              onClick={() => onClose()}
              className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
              title={t('viewer.close')}
            >
              <ChevronLeft size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 text-center truncate px-4 font-medium text-gray-800 dark:text-gray-200 flex justify-center items-center">
          <div className="text-gray-900 dark:text-gray-100 font-semibold flex items-center text-lg">
            <Maximize size={20} className="mr-3 text-blue-500" />
            {t('context.compareImages')}
            <span className="ml-3 text-sm font-normal text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-gray-800 px-3 py-1 rounded-full">
              {imageFiles.length} / 24
            </span>
          </div>
        </div>

        <div className="flex items-center space-x-3">
          <button
            onClick={handleReset}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
            title={t('viewer.fit')}
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

        {/* 编辑层 Overlay */}
        <EditOverlay
          activeItem={layout.items.find(it => it.id === activeImageId) || null}
          allItems={layout.items}
          transform={transform}
          onUpdateItem={(id, updates) => {
            setManualLayouts(prev => ({
              ...prev,
              [id]: { ...(prev[id] || layout.items.find(it => it.id === id) || { rotation: 0 }), ...updates }
            }));
          }}
          onRemoveItem={handleRemoveImage}
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

        {/* 注释层 - 渲染已存在的注释 */}
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
          {layout.items.map(item => {
            const itemAnnos = annotations.filter(a => a.imageId === item.id);
            return itemAnnos.map(anno => {
              // 计算注释在屏幕上的绝对位置
              // Compute annotation world position then rotate around item's center
              const localX = item.x + (anno.x / 100) * item.width;
              const localY = item.y + (anno.y / 100) * item.height;
              const centerX = item.x + item.width / 2;
              const centerY = item.y + item.height / 2;
              const rotated = rotatePointAround(localX, localY, centerX, centerY, item.rotation);
              const screen = worldToScreen(rotated.x, rotated.y);
              const ax = screen.x;
              const ay = screen.y;
              return (
                <div
                  key={anno.id}
                  className="absolute px-2 py-1 bg-yellow-100 dark:bg-yellow-900/80 border border-yellow-400 dark:border-yellow-600 rounded shadow-md text-xs text-yellow-900 dark:text-yellow-100 whitespace-nowrap z-40 pointer-events-auto group"
                  style={{ left: ax, top: ay, transform: 'translate(-50%, -100%)' }}
                >
                  {anno.text}
                  <button
                    onClick={() => setAnnotations(prev => prev.filter(a => a.id !== anno.id))}
                    className="ml-2 opacity-0 group-hover:opacity-100 hover:text-red-500 transition-opacity"
                  >
                    <X size={10} />
                  </button>
                </div>
              );
            });
          })}
        </div>

        {/* 添加注释输入框 */}
        {pendingAnnotation && (
          <div
            className="absolute z-[200] p-3 bg-white dark:bg-gray-800 rounded-lg shadow-2xl border border-gray-200 dark:border-gray-700 pointer-events-auto"
            style={{
              // rotation-aware position
              left: (() => {
                const it = layout.items.find(i => i.id === pendingAnnotation.imageId)!;
                const localX = it.x + (pendingAnnotation.x / 100) * it.width;
                const localY = it.y + (pendingAnnotation.y / 100) * it.height;
                const rotated = rotatePointAround(localX, localY, it.x + it.width / 2, it.y + it.height / 2, it.rotation);
                return worldToScreen(rotated.x, rotated.y).x;
              })(),
              top: (() => {
                const it = layout.items.find(i => i.id === pendingAnnotation.imageId)!;
                const localX = it.x + (pendingAnnotation.x / 100) * it.width;
                const localY = it.y + (pendingAnnotation.y / 100) * it.height;
                const rotated = rotatePointAround(localX, localY, it.x + it.width / 2, it.y + it.height / 2, it.rotation);
                return worldToScreen(rotated.x, rotated.y).y;
              })(),
              transform: 'translate(-50%, -120%)'
            }}
          >
            <input
              autoFocus
              className="px-2 py-1 bg-gray-50 dark:bg-gray-900 border border-gray-300 dark:border-gray-600 rounded text-sm focus:ring-2 focus:ring-blue-500 outline-none min-w-[150px] dark:text-gray-100"
              placeholder="输入注释并回车..."
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  const val = (e.target as HTMLInputElement).value;
                  if (val.trim()) {
                    setAnnotations(prev => [...prev, {
                      id: Math.random().toString(36).substr(2, 9),
                      imageId: pendingAnnotation.imageId,
                      x: pendingAnnotation.x,
                      y: pendingAnnotation.y,
                      text: val.trim(),
                      createdAt: Date.now()
                    }]);
                  }
                  setPendingAnnotation(null);
                } else if (e.key === 'Escape') {
                  setPendingAnnotation(null);
                }
              }}
            />
          </div>
        )}
      </div>

      {/* Shortcuts Hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md rounded-full border border-gray-200 dark:border-gray-700/50 text-sm text-gray-500 dark:text-gray-400 pointer-events-none shadow-2xl animate-fade-in-up transition-opacity flex items-center space-x-4">
        <div className="flex items-center">
          <Mouse size={14} className="mr-1.5 text-blue-500 dark:text-blue-400" />
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
