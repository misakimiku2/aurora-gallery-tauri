import React, { useState, useEffect, useRef, useMemo } from 'react';
import { X, Maximize, RefreshCcw } from 'lucide-react';
import { FileNode } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';

interface ImageComparerProps {
  selectedFileIds: string[];
  files: Record<string, FileNode>;
  onClose: () => void;
  t: (key: string) => string;
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
  t
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [transform, setTransform] = useState({ x: 0, y: 0, scale: 1 });
  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
  
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
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Filter selected files to get only valid images, sorted by size (largest first)
  const imageFiles = useMemo(() => {
    return selectedFileIds
      .map(id => files[id])
      .filter(file => file && file.path)
      .sort((a, b) => {
        const sizeA = (a.meta?.width || 0) * (a.meta?.height || 0);
        const sizeB = (b.meta?.width || 0) * (b.meta?.height || 0);
        return sizeB - sizeA;
      });
  }, [selectedFileIds, files]);

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

  // Layout calculation (紧凑型环绕填充)
  const layout = useMemo(() => {
    if (imageFiles.length === 0) 
      return { items: [], totalWidth: 0, totalHeight: 0 };

    const spacing = 40; 
    const items: ImageLayoutInfo[] = [];

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

    // 第一张图（最大图）居中
    const first = imageFiles[0];
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

    for (let i = 1; i < imageFiles.length; i++) {
      const file = imageFiles[i];
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
      items: items.map(it => ({ ...it, x: it.x - minX, y: it.y - minY })), 
      totalWidth: maxX - minX, 
      totalHeight: maxY - minY 
    };
  }, [imageFiles]);

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

    // 检测主题颜色
    const isDark = document.documentElement.classList.contains('dark');
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

    layout.items.forEach(item => {
      const cache = imagesCache.current.get(item.id);
      
      // 绘制占位背景
      ctx.fillStyle = '#111827';
      ctx.fillRect(item.x, item.y, item.width, item.height);

      if (cache) {
        // Mipmap 策略：如果当前真实显示比例很小，则从 0.25 倍的预裁切 Canvas 绘图
        // 这样能有效避免从巨大原图直接下采样导致的像素丢失（锯齿）
        const currentEffectiveScale = transform.scale;
        if (currentEffectiveScale < 0.2 && cache.small) {
          ctx.drawImage(cache.small, item.x, item.y, item.width, item.height);
        } else {
          ctx.drawImage(cache.original, item.x, item.y, item.width, item.height);
        }
        
        // 绘制边框
        ctx.strokeStyle = 'rgba(255,255,255,0.08)';
        ctx.lineWidth = 1 / transform.scale;
        ctx.strokeRect(item.x, item.y, item.width, item.height);
      }
    });

    ctx.restore();
  }, [transform, layout, containerSize, loadedCount]);

  // Initial auto-zoom and center
  useEffect(() => {
    if (layout.totalWidth > 0 && containerSize.width > 0) {
      const padding = 60;
      const scaleX = (containerSize.width - padding * 2) / layout.totalWidth;
      const scaleY = (containerSize.height - padding * 2) / layout.totalHeight;
      const initialScale = Math.min(scaleX, scaleY, 1.2);
      
      setTransform({
        x: (containerSize.width - layout.totalWidth * initialScale) / 2,
        y: (containerSize.height - layout.totalHeight * initialScale) / 2,
        scale: initialScale
      });
    }
  }, [layout.totalWidth, layout.totalHeight, containerSize.width, containerSize.height]);

  // Mouse wheel zoom
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
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
    if (e.button === 0) {
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

  const handleReset = () => {
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
      ref={containerRef}
      className="fixed inset-0 z-[100] bg-gray-50 dark:bg-gray-950 flex flex-col overflow-hidden select-none animate-fade-in"
      onWheel={handleWheel}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
    >
      {/* Header */}
      <div className="h-14 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md border-b border-gray-200 dark:border-gray-800 flex items-center px-6 justify-between z-10 shrink-0">
        <div className="flex items-center space-x-4">
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
            className="p-2.5 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-500 dark:text-gray-400 transition-colors"
            title={t('viewer.fit')}
          >
            <RefreshCcw size={20} />
          </button>
          <div className="h-6 w-px bg-gray-200 dark:bg-gray-800 mx-2"></div>
          <button 
            onClick={onClose}
            className="p-2.5 rounded-lg hover:bg-red-500 text-gray-500 dark:text-gray-400 hover:text-white transition-all active:scale-95"
          >
            <X size={24} />
          </button>
        </div>
      </div>

      {/* Canvas */}
      <div className="flex-1 relative cursor-grab active:cursor-grabbing overflow-hidden">
        <canvas 
          ref={canvasRef}
          className="w-full h-full block"
        />
      </div>

      {/* Shortcuts Hint */}
      <div className="absolute bottom-6 left-1/2 -translate-x-1/2 px-5 py-2.5 bg-white/90 dark:bg-gray-900/90 backdrop-blur-md rounded-full border border-gray-200 dark:border-gray-700/50 text-sm text-gray-500 dark:text-gray-400 pointer-events-none shadow-2xl animate-fade-in-up transition-opacity">
        <span className="mx-2 text-gray-900 dark:text-gray-100 font-medium">滚轮</span> 缩放 · 
        <span className="mx-2 text-gray-900 dark:text-gray-100 font-medium">鼠标左键</span> 拖拽 · 
        <span className="mx-2 text-gray-900 dark:text-gray-100 font-medium">{imageFiles.length > 0 && `加载中 ${loadedCount}/${imageFiles.length}`}</span> 
        <span className="mx-2 text-gray-900 dark:text-gray-100 font-medium">Esc</span> 退出
      </div>
    </div>
  );
};
