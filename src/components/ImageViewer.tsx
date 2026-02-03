import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { FileNode, SlideshowConfig, SearchScope } from '../types';
import { 
  X, ChevronLeft, ChevronRight, Search, Sidebar, PanelRight, 
  RotateCw, RotateCcw, Maximize, Minimize, ArrowLeft, ArrowRight, 
  Play, Square, Settings, Sliders, Globe, FileText, Tag, Folder as FolderIcon, ChevronDown, Loader2,
  Copy, ExternalLink, Image as ImageIcon, Save, Move, Trash2, FolderOpen
} from 'lucide-react';


// 全局高分辨率图片 Blob 缓存 - 增大容量�?200 �?
const blobCache = new Map<string, string>();
const MAX_CACHE_SIZE = 200;

// 正在加载中的 Promise 缓存，防止重复请�?
const loadingPromises = new Map<string, Promise<string>>();

// 同步获取缓存（如果存在）- 用于无闪烁切�?
export const getBlobCacheSync = (path: string): string | null => {
    if (blobCache.has(path)) {
        const url = blobCache.get(path)!;
        // LRU: 移动到最�?
        blobCache.delete(path);
        blobCache.set(path, url);
        return url;
    }
    return null;
};

// 检查缓存是否存�?
export const hasBlobCache = (path: string): boolean => {
    return blobCache.has(path);
};

const loadToCache = async (path: string): Promise<string> => {
    // 如果已在缓存中，直接返回
    const cached = getBlobCacheSync(path);
    if (cached) return cached;

    // 如果已经在加载中，等待现有的 Promise
    if (loadingPromises.has(path)) {
        return loadingPromises.get(path)!;
    }

    // 创建新的加载 Promise
    const loadPromise = (async () => {
      try {
        // 直接使用 convertFileSrc 返回的 URL，不需要 fetch
        const url = convertFileSrc(path);

        // 缓存 URL（虽然不是 blob，但仍然可以重用）
        blobCache.set(path, url);
        return url;
      } catch (e) {
        console.error("Failed to load image to cache", path, e);
        // 出错时也返回 convertFileSrc URL
        return convertFileSrc(path);
      } finally {
        loadingPromises.delete(path);
      }
    })();
    
    loadingPromises.set(path, loadPromise);
    return loadPromise;
};

// 预加载图片到缓存（静默，不返回结果）
export const preloadToCache = (path: string): void => {
    if (!blobCache.has(path) && !loadingPromises.has(path)) {
        loadToCache(path).catch(() => {});
    }
};

interface ViewerProps {
  file: FileNode;
  prevFile?: FileNode; // Optional now, mostly legacy or direct neighbor specific
  nextFile?: FileNode; // Optional now
  sortedFileIds?: string[]; // New: Full list for calculating neighbors
  files: Record<string, FileNode>;
  layout: { isSidebarVisible: boolean; isMetadataVisible: boolean };
  slideshowConfig: SlideshowConfig;
  activeChannel?: 'original' | 'r' | 'g' | 'b' | 'l'; 
  onLayoutToggle: (part: 'sidebar' | 'metadata') => void;
  onClose: () => void; 
  onNext: (random?: boolean) => void;
  onPrev: () => void;
  onNavigateBack: () => void;
  onNavigateForward: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  onDelete: (id: string) => void;
  onViewInExplorer: (id: string) => void;
  onCopyToFolder: (fileId: string) => void;
  onMoveToFolder: (fileId: string) => void;
  onNavigateToFolder: (folderId: string, options?: { targetId?: string }) => void;
  searchQuery: string;
  onSearch: (query: string) => void; 
  searchScope: SearchScope;
  onSearchScopeChange: (scope: SearchScope) => void;
  onUpdateSlideshowConfig: (config: SlideshowConfig) => void;
  onPasteTags: (targetId: string) => void; 
  onEditTags: () => void;
  onCopyTags: () => void;
  onAIAnalysis: (fileId: string) => void;
  isAISearchEnabled: boolean;
  onToggleAISearch: () => void;
  t: (key: string) => string;
  activeTab: any; // Added for open folder availability check
}

interface ContextMenuState {
  x: number;
  y: number;
  visible: boolean;
}

export const ImageViewer: React.FC<ViewerProps> = ({ 
  file, 
  prevFile: legacyPrev,
  nextFile: legacyNext,
  sortedFileIds,
  files,
  onClose, 
  onNext, 
  onPrev, 
  onDelete,
  layout,
  onLayoutToggle,
  onNavigateBack,
  onNavigateForward,
  canGoBack,
  canGoForward,
  searchQuery,
  onSearch,
  searchScope,
  onSearchScopeChange,
  slideshowConfig,
  onUpdateSlideshowConfig,
  activeChannel = 'original',
  onPasteTags,
  onEditTags,
  onCopyTags,
  onViewInExplorer,
  onCopyToFolder,
  onMoveToFolder,
  onNavigateToFolder,
  onAIAnalysis,
  isAISearchEnabled,
  onToggleAISearch,
  t,
  activeTab
}) => {
  // 如果 file 不存在，关闭查看�?
  if (!file) {
    onClose();
    return null;
  }
  
  const containerRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const scopeBtnRef = useRef<HTMLButtonElement>(null);
  
  const [scale, setScale] = useState(1); 
  const [rotation, setRotation] = useState(0);
  const [position, setPosition] = useState({ x: 0, y: 0 });
  const positionRef = useRef(position); // for reading latest position inside callbacks
  const positionAnimRef = useRef<number | null>(null); // RAF id for ongoing position animation

  // animate position from current to target (cancellable)
  const animatePositionTo = (toX: number, toY: number, duration = 220) => {
    // 更明显的“朝向移动”感：时长根据距离自适应，并使用带轻微回弹的 ease-out 曲线
    if (positionAnimRef.current) cancelAnimationFrame(positionAnimRef.current);
    const fromX = positionRef.current.x;
    const fromY = positionRef.current.y;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const dist = Math.hypot(dx, dy);
    if (dist === 0) return;

    // duration 基于距离伸缩：短距离更快，长距离更明显；并把传入 duration 作为基线
    const computedDuration = Math.max(120, Math.min(520, Math.round(duration + dist * 0.25)));

    // easeOutBack 提供快速起速和轻微回弹，更能传达“朝向移动”感
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const easeOutBack = (t: number) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / computedDuration);
      const k = easeOutBack(t);
      const nx = fromX + dx * k;
      const ny = fromY + dy * k;
      setPosition({ x: nx, y: ny });
      if (t < 1) {
        positionAnimRef.current = requestAnimationFrame(step);
      } else {
        positionAnimRef.current = null;
      }
    };

    positionAnimRef.current = requestAnimationFrame(step);
  };

  // animate both scale and position together (cancellable)
  const animateTransformTo = (toScale: number, toX: number, toY: number, duration = 320) => {
    if (positionAnimRef.current) cancelAnimationFrame(positionAnimRef.current);
    const fromX = positionRef.current.x;
    const fromY = positionRef.current.y;
    const fromScale = scaleRef.current;
    const dx = toX - fromX;
    const dy = toY - fromY;
    const ds = toScale - fromScale;
    const dist = Math.hypot(dx, dy) + Math.abs(ds) * 100;
    if (dist === 0) return;

    const computedDuration = Math.max(120, Math.min(520, Math.round(duration + dist * 0.2)));
    const c1 = 1.70158;
    const c3 = c1 + 1;
    const easeOutBack = (t: number) => 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / computedDuration);
      const k = easeOutBack(t);
      const nx = fromX + dx * k;
      const ny = fromY + dy * k;
      const ns = fromScale + ds * k;
      setPosition({ x: nx, y: ny });
      setScale(ns);
      if (t < 1) {
        positionAnimRef.current = requestAnimationFrame(step);
      } else {
        positionAnimRef.current = null;
      }
    };

    positionAnimRef.current = requestAnimationFrame(step);
  };

  // keep ref in sync with state
  useEffect(() => { positionRef.current = position; }, [position]);
  const scaleRef = useRef(scale);
  useEffect(() => { scaleRef.current = scale; }, [scale]);

  const [isDragging, setIsDragging] = useState(false);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ x: 0, y: 0, visible: false });
  // 计算后的菜单位置（避免被窗口裁剪）
  const [menuPos, setMenuPos] = useState<{ top: string; left: string }>({ top: '0px', left: '0px' });
  const [slideshowActive, setSlideshowActive] = useState(false);
  const [showSlideshowSettings, setShowSlideshowSettings] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [scopeMenuPos, setScopeMenuPos] = useState({ top: 0, left: 0 });
  
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const [animationClass, setAnimationClass] = useState('animate-zoom-in');
  const lastFileIdRef = useRef(file.id);
  
  // 真正的双缓冲机制：两个图层交替显�?
  // activeLayer: 0 �?1，表示当前显示的是哪个图�?
  const [activeLayer, setActiveLayer] = useState<0 | 1>(0);
  // 增加 Layer ID 状态，用于记录图层当前加载的是哪个文件路径，防止旧内容闪烁
  const [layer0Id, setLayer0Id] = useState<string>(file.path || '');
  const [layer1Id, setLayer1Id] = useState<string>('');
  
  const [layer0Url, setLayer0Url] = useState<string>(() => {
    if (file.path) {
      const cached = getBlobCacheSync(file.path);
      if (cached) return cached;
    }
    return '';
  });
  const [layer1Url, setLayer1Url] = useState<string>('');
  const [layer0Ready, setLayer0Ready] = useState(!!layer0Url);
  const [layer1Ready, setLayer1Ready] = useState(false);
  
  // 用于追踪当前正在加载的文件路�?
  const currentLoadingPath = useRef<string>('');
  // 追踪当前目标图层
  const targetLayerRef = useRef<0 | 1>(0);
  // 追踪每个图层期望�?URL，用于验�?onLoad 是否是我们期望的图片
  const expectedLayer0Url = useRef<string>(layer0Url);
  const expectedLayer1Url = useRef<string>('');

  // Load image using Blob Cache - 真正的双缓冲
  useEffect(() => {
    if (!file.path) {
      setLayer0Url('');
      setLayer1Url('');
      return;
    }
    
    const path = file.path;
    currentLoadingPath.current = path;
    
    // 确定目标图层（与当前显示的图层相反）
    const targetLayer = activeLayer === 0 ? 1 : 0;
    targetLayerRef.current = targetLayer;
    
    // 尝试同步获取缓存
    const cachedUrl = getBlobCacheSync(path);
    
    if (cachedUrl) {
      // 缓存命中：设置到目标图层，并重置 ready 状�?
      if (targetLayer === 0) {
        expectedLayer0Url.current = cachedUrl;
        setLayer0Ready(false); // 重置 ready，等待新图片�?onLoad
        setLayer0Url(cachedUrl);
        setLayer0Id(path); // 标记此图层的内容归属
      } else {
        expectedLayer1Url.current = cachedUrl;
        setLayer1Ready(false); // 重置 ready，等待新图片�?onLoad
        setLayer1Url(cachedUrl);
        setLayer1Id(path); // 标记此图层的内容归属
      }
    } else {
      // 缓存未命中：先重置目标图层的 ready 状�?
      if (targetLayer === 0) {
        setLayer0Ready(false);
      } else {
        setLayer1Ready(false);
      }
      
      // 异步加载到目标图�?
      loadToCache(path).then(url => {
        if (currentLoadingPath.current === path) {
          if (targetLayerRef.current === 0) {
            expectedLayer0Url.current = url;
            setLayer0Url(url);
            setLayer0Id(path); // 标记此图层的内容归属
          } else {
            expectedLayer1Url.current = url;
            setLayer1Url(url);
            setLayer1Id(path); // 标记此图层的内容归属
          }
        }
      });
    }
  }, [file.path]);
  
  // 处理图层 0 �?onLoad - 验证是期望的图片才设�?ready
  const handleLayer0Load = useCallback(() => {
    // 只有当加载的是我们期望的 URL 时才设置 ready
    if (layer0Url === expectedLayer0Url.current) {
      setLayer0Ready(true);
    }
  }, [layer0Url]);
  
  // 处理图层 1 �?onLoad
  const handleLayer1Load = useCallback(() => {
    if (layer1Url === expectedLayer1Url.current) {
      setLayer1Ready(true);
    }
  }, [layer1Url]);
  
  // 当目标图层准备好后，切换显示
  useEffect(() => {
    const targetLayer = targetLayerRef.current;
    
    // 只有当图�?URL、图层内�?ID 都匹配当前文件时，才允许切换
    if (targetLayer === 0 && layer0Ready && layer0Url && layer0Id === file.path && currentLoadingPath.current === file.path) {
      setActiveLayer(0);
    } else if (targetLayer === 1 && layer1Ready && layer1Url && layer1Id === file.path && currentLoadingPath.current === file.path) {
      setActiveLayer(1);
    }
  }, [layer0Ready, layer1Ready, layer0Url, layer1Url, layer0Id, layer1Id, file.path]);
  
  // 便捷变量：当前显示的 URL
  const displayUrl = activeLayer === 0 ? layer0Url : layer1Url;


  // --- Calculate Preload Nodes ---
  const preloadImages = useMemo(() => {
      if (!sortedFileIds || sortedFileIds.length === 0) return [];
      
      const currentIdx = sortedFileIds.indexOf(file.id);
      if (currentIdx === -1) return [];

      const getNeighbor = (offset: number) => {
          const idx = (currentIdx + offset + sortedFileIds.length) % sortedFileIds.length;
          return files[sortedFileIds[idx]];
      };

      const nodes = [];
      // 增加预加载范围到 +/- 10 张，确保快速切换时有足够的缓存
      for (let i = 1; i <= 10; i++) {
          nodes.push(getNeighbor(-i));
          nodes.push(getNeighbor(i));
      }

      return nodes.filter(node => node && node.path && node.id !== file.id);
  }, [file.id, sortedFileIds, files]);

  // Preload neighbors into Blob Cache - 使用优化后的静默预加�?
  useEffect(() => {
     // 优先预加载前后各3张（最可能被访问的�?
     const priorityCount = 3;
     const priorityNodes = preloadImages.slice(0, priorityCount * 2);
     const restNodes = preloadImages.slice(priorityCount * 2);
     
     // 立即预加载优先级高的图片
     priorityNodes.forEach(node => {
        if (node.path) {
           preloadToCache(node.path);
        }
     });
     
     // 延迟预加载其余图片，避免阻塞
     const timeoutId = setTimeout(() => {
         restNodes.forEach(node => {
            if (node.path) {
               preloadToCache(node.path);
            }
         });
     }, 100);
     
     return () => clearTimeout(timeoutId);
  }, [preloadImages]);
  // ------------------------------

  useEffect(() => {
    if (showSearch && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [showSearch]);

  // Context menu close handlers
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenu.visible) {
        // 检查点击目标是否在菜单内部，如果不是则关闭菜单
        const menuElement = document.querySelector('.fixed.bg-white[data-testid="viewer-context-menu"]');
        if (!menuElement || !menuElement.contains(e.target as Node)) {
          setContextMenu({ ...contextMenu, visible: false });
        }
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (contextMenu.visible) {
        setContextMenu({ ...contextMenu, visible: false });
      }
    };

    // 使用冒泡阶段，避免影响菜单内部点�?
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('wheel', handleWheel, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('wheel', handleWheel, true);
    };
  }, [contextMenu]);

  useEffect(() => {
    setLocalQuery(searchQuery);
  }, [searchQuery]);

  useEffect(() => {
    const handleResize = () => setScopeMenuOpen(false);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  // cleanup animations on unmount
  useEffect(() => {
    return () => {
      if (positionAnimRef.current) cancelAnimationFrame(positionAnimRef.current);
    };
  }, []);

  useEffect(() => {
    if (lastFileIdRef.current !== file.id) {
      if (slideshowActive) {
         if (slideshowConfig.transition === 'fade') setAnimationClass('animate-fade-in');
         else if (slideshowConfig.transition === 'slide') setAnimationClass('animate-slide-left');
         else setAnimationClass('');
      } else {
         if (!animationClass) setAnimationClass('animate-zoom-in');
      }

      setRotation(0);
      setPosition({ x: 0, y: 0 });
      setScale(1); 
      // Removed setIsLoaded(false) to prevent flickering (keep old image until new one loads)
      lastFileIdRef.current = file.id;
    }
  }, [file.id, slideshowActive, slideshowConfig]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || slideshowActive) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      e.stopPropagation();

      const ZOOM_SPEED = 0.1;
      const direction = Math.sign(e.deltaY);

      // 获取容器与当前可见图片的 DOMRect
      const rect = container.getBoundingClientRect();
      const imgEl = imgRef.current;
      const imgRect = imgEl ? imgEl.getBoundingClientRect() : rect;

      // 将鼠标位置夹到图片显示区域内（如果鼠标在图片外）。
      // 这样缩放锚点就是图片上离鼠标最近的点。
      const clientX = e.clientX;
      const clientY = e.clientY;
      const clampedClientX = Math.min(Math.max(clientX, imgRect.left), imgRect.right);
      const clampedClientY = Math.min(Math.max(clientY, imgRect.top), imgRect.bottom);

      // 转换为相对于容器左上角的坐标，然后再相对于容器中心
      const mouseX = clampedClientX - rect.left;
      const mouseY = clampedClientY - rect.top;
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;

      // 关键：计算鼠标相对于「图片中心」的向量（包含当前 position），
      // 而不是仅相对于容器中心。这样在图片已偏移或鼠标在图片外时，
      // 计算出的 delta 方向将确保图片朝鼠标移动（而非远离）。
      const dx = mouseX - centerX - positionRef.current.x;
      const dy = mouseY - centerY - positionRef.current.y;

      // 判断鼠标原始位置是否在图片外（用于触发平滑移动）
      const mouseWasOutside = clientX < imgRect.left || clientX > imgRect.right || clientY < imgRect.top || clientY > imgRect.bottom;

      // 使用 functional updater 保证读取到最新的 scale/position
      setScale(prevScale => {
        let newScale = prevScale;
        if (direction < 0) newScale = prevScale * (1 + ZOOM_SPEED);
        else newScale = prevScale / (1 + ZOOM_SPEED);

        newScale = Math.max(0.01, Math.min(newScale, 8));

        const scaleFactor = newScale / prevScale;
        // 如果缩放比例实际发生改变，则按指针（或图片边界上最近点）修正平移，保持该点像素不动
        if (scaleFactor !== 1) {
          const deltaX = (1 - scaleFactor) * dx;
          const deltaY = (1 - scaleFactor) * dy;

          // 放大：使用平滑动画过渡位置（现在也适用于鼠标在图片内）
          if (scaleFactor > 1) {
            const targetX = positionRef.current.x + deltaX;
            const targetY = positionRef.current.y + deltaY;
            animatePositionTo(targetX, targetY, 200);
          } else {
            // 缩小：计算夹取后的目标位置（最小修正），如果鼠标在图片外则用动画移动
            const naturalW = imgRef.current?.naturalWidth || 0;
            const naturalH = imgRef.current?.naturalHeight || 0;
            const containerW = rect.width;
            const containerH = rect.height;

            if (!naturalW || !naturalH || !containerW || !containerH) {
              animatePositionTo(0, 0, 200);
            } else {
              const fitScale = Math.min(containerW / naturalW, containerH / naturalH);
              const renderedW = naturalW * fitScale * newScale;
              const renderedH = naturalH * fitScale * newScale;

              const halfRenderedW = renderedW / 2;
              const halfRenderedH = renderedH / 2;
              const halfContainerW = containerW / 2;
              const halfContainerH = containerH / 2;

              const allowedOffsetX = Math.abs(halfRenderedW - halfContainerW);
              const allowedOffsetY = Math.abs(halfRenderedH - halfContainerH);

              const intendedX = positionRef.current.x + deltaX;
              const intendedY = positionRef.current.y + deltaY;

              const tx = Math.max(-allowedOffsetX, Math.min(allowedOffsetX, intendedX));
              const ty = Math.max(-allowedOffsetY, Math.min(allowedOffsetY, intendedY));

              animatePositionTo(tx, ty, 220);
            }
          }
        }

        return newScale;
      });

    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      if (positionAnimRef.current) cancelAnimationFrame(positionAnimRef.current);
    };
  }, [slideshowActive]);

  useEffect(() => {
    let intervalId: ReturnType<typeof setTimeout>;
    if (slideshowActive) {
      intervalId = setInterval(() => {
        onNext(slideshowConfig.isRandom);
      }, slideshowConfig.interval);
    }
    return () => clearInterval(intervalId);
  }, [slideshowActive, onNext, slideshowConfig]);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await rootRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  const handleSearchSubmit = () => {
    onSearch(localQuery);
  };

  const toggleScopeMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!scopeMenuOpen && scopeBtnRef.current) {
       const rect = scopeBtnRef.current.getBoundingClientRect();
       setScopeMenuPos({ top: rect.bottom + 8, left: rect.left });
    }
    setScopeMenuOpen(!scopeMenuOpen);
  };

  const handleCopyImage = async () => {
      try {
          if (!file.path) return;
          
          // Read file as base64 and convert to blob
          const { readFileAsBase64 } = await import('../api/tauri-bridge');
          const dataUrl = await readFileAsBase64(file.path);
          if (!dataUrl) return;
          
          // Convert data URL to blob
          const response = await fetch(dataUrl);
          const blob = await response.blob();
          await navigator.clipboard.write([
              new ClipboardItem({
                  [blob.type]: blob
              })
          ]);
      } catch (err) {
          console.error('Failed to copy image: ', err);
      }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSearch && document.activeElement === searchInputRef.current) {
        if (e.key === 'Enter') handleSearchSubmit();
        return;
      }

      if (e.key === 'ArrowRight') handleNext();
      if (e.key === 'ArrowLeft') handlePrev();
      if (e.key === 'Escape') {
        if (showSearch) setShowSearch(false);
        else if (showSlideshowSettings) setShowSlideshowSettings(false);
        else if (slideshowActive) stopSlideshow();
        else if (canGoBack) onNavigateBack();
        else onClose();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
        e.preventDefault();
        setShowSearch(prev => !prev);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNavigateBack, canGoBack, slideshowActive, showSlideshowSettings, showSearch, localQuery]); 

  const handleNext = () => {
    setAnimationClass('animate-slide-left');
    onNext();
  };

  const handlePrev = () => {
    setAnimationClass('animate-slide-right');
    onPrev();
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    if (slideshowActive) return;

    // Middle-button single click: toggle between original and fit (prevent default autoscroll)
    if (e.button === 1) {
      e.preventDefault();
      e.stopPropagation();
      toggleOriginalFit();
      return;
    }

    // Left-button: start drag
    if (e.button !== 0) return;
    e.preventDefault();
    // cancel any in-flight animation when user starts dragging
    if (positionAnimRef.current) {
      cancelAnimationFrame(positionAnimRef.current);
      positionAnimRef.current = null;
    }
    setIsDragging(true);
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (slideshowActive) return;
    if (!isDragging) return;
    e.preventDefault();
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    setPosition(prev => ({ x: prev.x + dx, y: prev.y + dy }));
    setDragStart({ x: e.clientX, y: e.clientY });
  };

  const handleMouseUp = () => setIsDragging(false);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({ x: e.clientX, y: e.clientY, visible: true });
    // 先设置为点击位置，后续 useEffect 会测量并修正（防止闪烁）
    setMenuPos({ top: `${e.clientY}px`, left: `${e.clientX}px` });
  };

  // 当 context menu 可见时，测量其尺寸并把位置夹到视口内，避免被窗口裁剪
  useEffect(() => {
    if (!contextMenu.visible) return;

    let rafId: number | null = null;
    const adjust = () => {
      const el = document.querySelector('[data-testid="viewer-context-menu"]') as HTMLElement | null;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const margin = 8; // 保留一点间距

      let left = contextMenu.x;
      let top = contextMenu.y;

      if (left + rect.width > window.innerWidth) {
        left = Math.max(margin, window.innerWidth - rect.width - margin);
      }
      if (top + rect.height > window.innerHeight) {
        top = Math.max(margin, window.innerHeight - rect.height - margin);
      }
      left = Math.max(margin, left);
      top = Math.max(margin, top);

      setMenuPos({ top: `${top}px`, left: `${left}px` });
    };

    rafId = requestAnimationFrame(adjust);

    // 也在短延迟时再做一次，以防样式变动导致测量不准确
    const timeoutId = setTimeout(adjust, 50);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      clearTimeout(timeoutId);
    };
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

    // Stop slideshow and ensure fullscreen / UI state is cleaned up immediately
    const stopSlideshow = async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        }
      } catch (err) {
        // ignore
      } finally {
        setIsFullscreen(false);
        setSlideshowActive(false);
        setContextMenu(prev => ({ ...prev, visible: false }));
        setShowSlideshowSettings(false);
      }
    };

    const toggleSlideshow = async () => {
      if (!slideshowActive) {
        setSlideshowActive(true);
        // try to enter fullscreen when starting slideshow
        if (!document.fullscreenElement) {
          try {
            await rootRef.current?.requestFullscreen();
            setIsFullscreen(true);
          } catch (err) {
            // ignore
          }
        }
        setContextMenu(prev => ({ ...prev, visible: false }));
        setShowSlideshowSettings(false);
      } else {
        await stopSlideshow();
      }
    };

    // Keep a ref for latest slideshowActive so fullscreenchange handler can act reliably
    const slideshowActiveRef = useRef(slideshowActive);
    useEffect(() => { slideshowActiveRef.current = slideshowActive; }, [slideshowActive]);

    // If user exits fullscreen (usually via Esc), stop the slideshow immediately
    useEffect(() => {
      const onFullscreenChange = () => {
        if (!document.fullscreenElement && slideshowActiveRef.current) {
          stopSlideshow();
        }
      };
      document.addEventListener('fullscreenchange', onFullscreenChange);
      return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
    }, []);

    // Safety: ensure settings modal is closed whenever slideshow becomes active
    useEffect(() => { if (slideshowActive) setShowSlideshowSettings(false); }, [slideshowActive]);

    const rotate = (deg: number) => setRotation(r => r + deg);

    const handleReset = () => {
      // animate to fit-window (scale=1, center)
      animateTransformTo(1, 0, 0, 260);
      setRotation(0);
    };
  
  const handleFitWindow = () => handleReset();

  const handleOriginalSize = () => {
      if (!imgRef.current || !containerRef.current) return;
      const { naturalWidth, naturalHeight } = imgRef.current;
      const { width: containerWidth, height: containerHeight } = containerRef.current.getBoundingClientRect();
      
      if (!naturalWidth || !naturalHeight) return;

      const scaleX = containerWidth / naturalWidth;
      const scaleY = containerHeight / naturalHeight;
      const fitScale = Math.min(scaleX, scaleY);
      
      // Calculate new scale. 
      // If fitScale < 1 (image larger than window), we scale UP by 1/fitScale to reach 1.0 (original size).
      // If fitScale > 1 (image smaller than window), we scale DOWN.
      const newScale = 1 / fitScale;

      animateTransformTo(newScale, 0, 0, 320);
  };

  // Toggle between fit-window (scale ~= 1) and original-size (scale = 1/fitScale).
  const toggleOriginalFit = () => {
    if (!imgRef.current || !containerRef.current) return;
    const { naturalWidth, naturalHeight } = imgRef.current;
    const { width: containerWidth, height: containerHeight } = containerRef.current.getBoundingClientRect();
    if (!naturalWidth || !naturalHeight) return;

    const scaleX = containerWidth / naturalWidth;
    const scaleY = containerHeight / naturalHeight;
    const fitScale = Math.min(scaleX, scaleY);
    const originalScale = 1 / fitScale;

    const current = scaleRef.current;
    // if currently close to original, go to fit; otherwise go to original
    const toOriginal = Math.abs(current - originalScale) > Math.abs(current - 1);
    if (toOriginal) animateTransformTo(originalScale, 0, 0, 360);
    else animateTransformTo(1, 0, 0, 260);
  };

  const getScopeIcon = () => {
    switch (searchScope) {
      case 'file': return <FileText size={14} />;
      case 'tag': return <Tag size={14} />;
      case 'folder': return <FolderIcon size={14} />;
      default: return <Globe size={14} />;
    }
  };

  const filterStyle = activeChannel === 'original' ? {} : { filter: `url(#channel-${activeChannel})` };

  return (
    <div 
      ref={rootRef}
      className={`flex-1 flex flex-col h-full relative select-none overflow-hidden transition-colors duration-300 ${slideshowActive ? 'bg-black' : 'bg-gray-50 dark:bg-gray-900'}`}
      onClick={() => setContextMenu({ ...contextMenu, visible: false })}
    >
      {/* Preloading handled in useEffect now */}

      <div className={`h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center px-4 justify-between z-20 shrink-0 transition-all duration-300 ${(isFullscreen && slideshowActive) || slideshowActive ? '-translate-y-full absolute w-full top-0 opacity-0 pointer-events-none' : ''}`}>
        
        <div className="flex items-center space-x-2">
          <button 
            onClick={() => onLayoutToggle('sidebar')}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${layout.isSidebarVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
            title={t('viewer.toggleSidebar')}
          >
            <Sidebar size={18} />
          </button>
          
          <div className="flex space-x-1">
            <button 
              onClick={onNavigateBack} disabled={!canGoBack}
              className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-600 dark:text-gray-300"
              title={t('viewer.back')}
            >
              <ChevronLeft size={18} />
            </button>
            <button 
              onClick={onNavigateForward} disabled={!canGoForward}
              className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-600 dark:text-gray-300"
              title={t('viewer.forward')}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>

        <div className="flex-1 text-center truncate px-4 font-medium text-gray-800 dark:text-gray-200 flex justify-center items-center">
          {showSearch ? (
            <div className="relative w-full max-w-[672px] animate-fade-in">
              <div className={`flex items-center bg-gray-100 dark:bg-gray-800 rounded-full px-3 py-1.5 transition-all border overflow-hidden ${localQuery ? 'border-blue-500 shadow-sm' : 'border-transparent'}`}>
                 <div className="relative flex-shrink-0">
                   <button 
                     ref={scopeBtnRef}
                     type="button"
                     onClick={toggleScopeMenu}
                     className="flex items-center text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mr-2 pr-2 border-r border-gray-300 dark:border-gray-800 whitespace-nowrap"
                   >
                     {getScopeIcon()}
                     <ChevronDown size={12} className="ml-1 opacity-70"/>
                   </button>
                 </div>
                <Search size={16} className="mr-2 flex-shrink-0 text-gray-400" />
                <input
                  id="viewer-search-input"
                  name="viewer-search-input"
                  ref={searchInputRef}
                  type="text"
                  value={localQuery}
                  onChange={(e) => setLocalQuery(e.target.value)}
                  placeholder={
                    searchScope === 'file' ? '搜索文件名' :
                    searchScope === 'tag' ? '搜索标签' :
                    searchScope === 'folder' ? '搜索文件夹' :
                    t('search.placeholder')
                  }
                  className="bg-transparent border-none flex-1 focus:outline-none text-sm text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 min-w-0"
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSearchSubmit(); }}
                />
                <div className="flex items-center space-x-1 ml-2 flex-shrink-0">
                  {localQuery && (
                    <button onClick={() => { setLocalQuery(''); onSearch(''); }} className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 flex-shrink-0">
                      <X size={14} />
                    </button>
                  )}
                  {/* AI 切换按钮已移除（保留 props 与逻辑）*/}
                </div>
              </div>
            </div>
          ) : (
            <span>{file.name}</span>
          )}
        </div>

        <div className="flex items-center space-x-2 justify-end">
          <div className="flex items-center space-x-2 mr-4 w-32 hidden min-[1580px]:flex">
            <Minimize size={14} className="text-gray-500" />
            <input 
              type="range" 
              min="0.01" 
              max="8" 
              step="0.01" 
              value={scale}
              onChange={(e) => {
                setScale(parseFloat(e.target.value));
              }}
              className="flex-1 h-1 bg-gray-300 dark:bg-gray-600 rounded-lg appearance-none cursor-pointer"
            />
            <Maximize size={14} className="text-gray-500" />
          </div>

          <button onClick={handleOriginalSize} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block" title={t('viewer.original')}>
             <span className="text-xs font-bold">1:1</span>
          </button>
          <button onClick={handleReset} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400" title={t('viewer.fit')}>
            <Maximize size={18} />
          </button>
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1 hidden sm:block"></div>
          <button onClick={() => rotate(-90)} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block" title={t('viewer.rotateLeft')}>
            <RotateCcw size={18} />
          </button>
          <button onClick={() => rotate(90)} className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block" title={t('viewer.rotateRight')}>
            <RotateCw size={18} />
          </button>
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>
          
          <button 
            onClick={() => setShowSearch(!showSearch)} 
            className={`p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${showSearch || localQuery ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`} 
            title={t('viewer.search')}
          >
            <Search size={18} />
          </button>
          
          <button 
            onClick={() => onLayoutToggle('metadata')}
            className={`p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${layout.isMetadataVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
            title={t('viewer.toggleMeta')}
          >
            <PanelRight size={18} />
          </button>
        </div>
      </div>

      <div 
        ref={containerRef}
        className={`flex-1 overflow-hidden relative cursor-grab active:cursor-grabbing transition-colors duration-300 ${slideshowActive ? 'bg-black cursor-none' : 'bg-gray-200 dark:bg-gray-900'}`}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onContextMenu={handleContextMenu}
        style={slideshowActive ? { cursor: 'none' } : {}}
      >
        {/* 只有在完全没有图片时才显示加载指示器 */}
        {!layer0Url && !layer1Url && (
           <div className="absolute inset-0 flex items-center justify-center z-0">
               <Loader2 className="animate-spin text-gray-400 dark:text-gray-600" size={48} />
           </div>
        )}

        <div className={`w-full h-full flex items-center justify-center pointer-events-none ${animationClass}`}>
           {/* 图层 0 - 始终存在 */}
           <img 
             ref={activeLayer === 0 ? imgRef : undefined}
             src={layer0Url || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'} 
             alt={activeLayer === 0 ? file.name : ''}
             className={`max-w-none absolute inset-0 m-auto ${slideshowActive && slideshowConfig.enableZoom && activeLayer === 0 ? 'animate-ken-burns' : ''}`}
             onLoad={handleLayer0Load}
             loading="eager"
             decoding="sync"
             style={{
               width: '100%',
               height: '100%',
               objectFit: 'contain',
               transform: slideshowActive && slideshowConfig.enableZoom ? undefined : `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
               transition: isDragging ? 'none' : (slideshowActive ? undefined : 'transform 0.1s linear'),
               pointerEvents: slideshowActive ? 'none' : (activeLayer === 0 ? 'auto' : 'none'),
               transformOrigin: 'center center',
               opacity: activeLayer === 0 && layer0Url ? 1 : 0,
               zIndex: activeLayer === 0 ? 2 : 1,
               ...filterStyle
             }}
             draggable={false}
           />
           
           {/* 图层 1 - 始终存在 */}
           <img 
             ref={activeLayer === 1 ? imgRef : undefined}
             src={layer1Url || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'} 
             alt={activeLayer === 1 ? file.name : ''}
             className={`max-w-none absolute inset-0 m-auto ${slideshowActive && slideshowConfig.enableZoom && activeLayer === 1 ? 'animate-ken-burns' : ''}`}
             onLoad={handleLayer1Load}
             loading="eager"
             decoding="sync"
             style={{
               width: '100%',
               height: '100%',
               objectFit: 'contain',
               transform: slideshowActive && slideshowConfig.enableZoom ? undefined : `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
               transition: isDragging ? 'none' : (slideshowActive ? undefined : 'transform 0.1s linear'),
               pointerEvents: slideshowActive ? 'none' : (activeLayer === 1 ? 'auto' : 'none'),
               transformOrigin: 'center center',
               opacity: activeLayer === 1 && layer1Url ? 1 : 0,
               zIndex: activeLayer === 1 ? 2 : 1,
               ...filterStyle
             }}
             draggable={false}
           />
        </div>

        {!slideshowActive && (
          <>
            <div className="absolute inset-y-0 left-0 w-24 flex items-center justify-start pl-2 opacity-0 hover:opacity-100 transition-opacity duration-300 bg-gradient-to-r from-black/30 to-transparent z-10 pointer-events-auto">
              <button 
                onClick={(e) => { e.stopPropagation(); handlePrev(); }}
                className="p-3 rounded-full bg-black/50 text-white/80 hover:bg-black/80 hover:text-white backdrop-blur-sm transform transition-transform active:scale-95"
              >
                <ChevronLeft size={32} />
              </button>
            </div>
            <div className="absolute inset-y-0 right-0 w-24 flex items-center justify-end pr-2 opacity-0 hover:opacity-100 transition-opacity duration-300 bg-gradient-to-l from-black/30 to-transparent z-10 pointer-events-auto">
              <button 
                onClick={(e) => { e.stopPropagation(); handleNext(); }}
                className="p-3 rounded-full bg-black/50 text-white/80 hover:bg-black/80 hover:text-white backdrop-blur-sm transform transition-transform active:scale-95"
              >
                <ChevronRight size={32} />
              </button>
            </div>
          </>
        )}
      </div>

      {contextMenu.visible && (
        <div
          data-testid="viewer-context-menu"
          className="fixed bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 min-w-[220px] z-[60] max-h-[80vh] overflow-y-auto animate-zoom-in"
          style={{
            top: menuPos.top,
            left: menuPos.left,
            position: 'fixed',
            zIndex: 60
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center" onClick={() => { handleOriginalSize(); setContextMenu({...contextMenu, visible: false}); }}>
             <Maximize size={14} className="mr-2 opacity-70"/> {t('viewer.original')}
          </div>
          <div className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center" onClick={() => { handleFitWindow(); setContextMenu({...contextMenu, visible: false}); }}>
             <Minimize size={14} className="mr-2 opacity-70"/> {t('viewer.fit')}
          </div>
          
          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

          <div className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center" onClick={() => { onViewInExplorer(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <ExternalLink size={14} className="mr-2 opacity-70"/> {t('context.viewInExplorer')}
          </div>
          {(() => {
            const parentId = file.parentId;
            const isUnavailable = activeTab.viewMode === 'browser' && activeTab.folderId === parentId;
            return (
              <div 
                className={`px-4 py-2 flex items-center ${isUnavailable ? 'text-gray-400 cursor-default' : 'hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer'}`} 
                onClick={() => { 
                  if (!isUnavailable && parentId) { 
                    onNavigateToFolder(parentId, { targetId: file.id }); 
                    setContextMenu({...contextMenu, visible: false}); 
                  }
                }}
              >
                <FolderOpen size={14} className={`mr-2 opacity-70 ${isUnavailable ? 'opacity-40' : 'opacity-70'}`}/> 
                {t('context.openFolder')}
              </div>
            );
          })()}

          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

          <div className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center" onClick={() => { onEditTags(); setContextMenu({...contextMenu, visible: false}); }}>
             <Tag size={14} className="mr-2 opacity-70"/> {t('context.editTags')}
          </div>

          <div className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center" onClick={() => { onCopyTags(); setContextMenu({...contextMenu, visible: false}); }}>
             <Tag size={14} className="mr-2 opacity-70"/> {t('context.copyTag')}
          </div>
          <div className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center" onClick={() => { onPasteTags(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Tag size={14} className="mr-2 opacity-70"/> {t('context.pasteTag')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

          <div className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center" onClick={() => { onCopyToFolder(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Copy size={14} className="mr-2 opacity-70"/> {t('context.copyTo')}
          </div>
          <div className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center" onClick={() => { onMoveToFolder(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Move size={14} className="mr-2 opacity-70"/> {t('context.moveTo')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>
          
           <div className="px-4 py-2 hover:bg-purple-600 dark:hover:bg-purple-700 hover:text-white cursor-pointer flex items-center" onClick={() => { onAIAnalysis(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Sliders size={14} className="mr-2 opacity-70"/> {t('context.aiAnalyze')}
           </div>
          
          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>
          
          <div 
            className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center justify-between"
            onClick={() => { setShowSlideshowSettings(true); setContextMenu({...contextMenu, visible: false}); }}
          >
            <div className="flex items-center">
                <Settings size={14} className="mr-2"/>
                {t('context.slideshowSettings')}
            </div>
          </div>
          <div 
            className="px-4 py-2 hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center justify-between"
            onClick={toggleSlideshow}
          >
            <div className="flex items-center">
                {slideshowActive ? <Square size={14} className="mr-2"/> : <Play size={14} className="mr-2"/>}
                {slideshowActive ? t('context.stopSlideshow') : t('context.startSlideshow')}
            </div>
          </div>
          
          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>
          
          <div className="px-4 py-2 hover:bg-red-600 dark:hover:bg-red-700 hover:text-white text-red-500 dark:text-red-400 cursor-pointer flex items-center" onClick={() => { onDelete(file.id); setContextMenu({...contextMenu, visible: false}); }}>
             <Trash2 size={14} className="mr-2 opacity-70"/> {t('context.delete')}
          </div>
        </div>
      )}

      {scopeMenuOpen && (
        <>
           <div className="fixed inset-0 z-[60]" onClick={(e) => { e.stopPropagation(); setScopeMenuOpen(false); }}></div>
           <div 
              className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl z-[61] overflow-hidden py-1 text-left w-36 animate-fade-in"
              style={{ top: scopeMenuPos.top, left: scopeMenuPos.left }}
           >
              {[
                 { id: 'all', icon: Globe, label: t('search.scopeAll') },
                 { id: 'file', icon: FileText, label: t('search.scopeFile') },
                 { id: 'tag', icon: Tag, label: t('search.scopeTag') },
                 { id: 'folder', icon: FolderIcon, label: t('search.scopeFolder') }
              ].map((opt) => (
                 <button
                    key={opt.id}
                    type="button"
                    onClick={(e) => { 
                      e.stopPropagation(); 
                      onSearchScopeChange(opt.id as SearchScope); 
                      setScopeMenuOpen(false); 
                    }}
                    className={`w-full text-left px-3 py-2 text-xs flex items-center hover:bg-blue-50 dark:hover:bg-blue-900/20 ${searchScope === opt.id ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-gray-700 dark:text-gray-300'}`}
                 >
                    <opt.icon size={14} className="mr-2"/> {opt.label}
                 </button>
              ))}
           </div>
        </>
      )}

      {showSlideshowSettings && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg w-80 shadow-2xl p-4 animate-zoom-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4 border-b border-gray-200 dark:border-gray-800 pb-2">
              <h3 className="font-bold text-gray-800 dark:text-gray-200 flex items-center"><Sliders size={16} className="mr-2"/> {t('context.slideshowSettings')}</h3>
              <button onClick={() => setShowSlideshowSettings(false)} className="text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white"><X size={18}/></button>
            </div>
            
            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('viewer.slideshowInterval')} ({slideshowConfig.interval / 1000}s)</label>
                <input 
                  type="range" 
                  min="1000" 
                  max="10000" 
                  step="500"
                  value={slideshowConfig.interval}
                  onChange={(e) => onUpdateSlideshowConfig({ ...slideshowConfig, interval: Number(e.target.value) })}
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">{t('viewer.transition')}</label>
                <select 
                  value={slideshowConfig.transition}
                  onChange={(e) => onUpdateSlideshowConfig({ ...slideshowConfig, transition: e.target.value as any })}
                  className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                >
                  <option value="none">{t('viewer.none')}</option>
                  <option value="fade">{t('viewer.fade')}</option>
                  <option value="slide">{t('viewer.slide')}</option>
                </select>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-300">{t('viewer.enableZoom')}</span>
                <button 
                  onClick={() => onUpdateSlideshowConfig({ ...slideshowConfig, enableZoom: !slideshowConfig.enableZoom })}
                  className={`w-10 h-5 rounded-full relative transition-colors ${slideshowConfig.enableZoom ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-600'}`}
                >
                  <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${slideshowConfig.enableZoom ? 'left-6' : 'left-1'}`}></div>
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-300">{t('viewer.random')}</span>
                <button 
                  onClick={() => onUpdateSlideshowConfig({ ...slideshowConfig, isRandom: !slideshowConfig.isRandom })}
                  className={`w-10 h-5 rounded-full relative transition-colors ${slideshowConfig.isRandom ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-600'}`}
                >
                  <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${slideshowConfig.isRandom ? 'left-6' : 'left-1'}`}></div>
                </button>
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-2">
               <button 
                onClick={() => { toggleSlideshow(); setShowSlideshowSettings(false); }}
                className="bg-green-600 hover:bg-green-500 text-white px-4 py-1.5 rounded text-sm flex items-center"
              >
                <Play size={12} className="mr-1"/> {t('context.startSlideshow')}
              </button>
              <button 
                onClick={() => setShowSlideshowSettings(false)}
                className="bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-white px-4 py-1.5 rounded text-sm"
              >
                {t('viewer.done')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
