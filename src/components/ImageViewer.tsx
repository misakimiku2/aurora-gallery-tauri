import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { FileNode, SlideshowConfig, SearchScope } from '../types';
import { debounce } from '../utils/debounce';
import { ColorPickerPopover } from './ColorPickerPopover';
import { 
  X, ChevronLeft, ChevronRight, Search, Sidebar, PanelRight, 
  RotateCw, RotateCcw, Maximize, Minimize, ArrowLeft, ArrowRight, 
  Play, Square, Settings, Sliders, Globe, FileText, Tag, Folder as FolderIcon, ChevronDown, Loader2,
  Copy, ExternalLink, Image as ImageIcon, Save, Move, Trash2, FolderOpen, Palette
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

// ============ 全局调色板缓存 ============
// 用于预加载和快速获取图片主色调
const paletteCache = new Map<string, string[]>();
const paletteLoadingPromises = new Map<string, Promise<string[]>>();
const MAX_PALETTE_CACHE_SIZE = 200;

// 调色板缓存更新事件名
export const PALETTE_CACHE_UPDATE_EVENT = 'aurora-palette-cache-update';

// 同步获取调色板缓存
export const getPaletteCacheSync = (path: string): string[] | null => {
    if (paletteCache.has(path)) {
        const palette = paletteCache.get(path)!;
        // LRU: 移动到最后
        paletteCache.delete(path);
        paletteCache.set(path, palette);
        return palette;
    }
    return null;
};

// 检查调色板缓存是否存在
export const hasPaletteCache = (path: string): boolean => {
    return paletteCache.has(path);
};

// 加载调色板到缓存
const loadPaletteToCache = async (path: string, existingPalette?: string[]): Promise<string[]> => {
    // 如果已在缓存中，直接返回
    const cached = getPaletteCacheSync(path);
    if (cached) return cached;

    // 如果已经在加载中，等待现有的 Promise
    if (paletteLoadingPromises.has(path)) {
        return paletteLoadingPromises.get(path)!;
    }
    
    // 如果已有有效的调色板数据，直接缓存
    if (existingPalette && existingPalette.length > 0 && !existingPalette.every(c => c === '#000000')) {
        // 检查是否是有效调色板（非全黑、非重复）
        const isValidPalette = existingPalette.length >= 2;
        if (isValidPalette) {
            // 缓存管理
            if (paletteCache.size >= MAX_PALETTE_CACHE_SIZE) {
                const firstKey = paletteCache.keys().next().value;
                if (firstKey) paletteCache.delete(firstKey);
            }
            paletteCache.set(path, existingPalette);
            // 触发事件通知其他组件
            window.dispatchEvent(new CustomEvent(PALETTE_CACHE_UPDATE_EVENT, { detail: { path, palette: existingPalette } }));
            return existingPalette;
        }
    }

    // 创建新的加载 Promise
    const loadPromise = (async () => {
        try {
            const { getDominantColors } = await import('../api/tauri-bridge');
            const colors = await getDominantColors(path, 8);
            
            if (colors && colors.length > 0) {
                const hexColors = colors.map(c => c.hex);
                
                // 缓存管理
                if (paletteCache.size >= MAX_PALETTE_CACHE_SIZE) {
                    const firstKey = paletteCache.keys().next().value;
                    if (firstKey) paletteCache.delete(firstKey);
                }
                paletteCache.set(path, hexColors);
                // 触发事件通知其他组件
                window.dispatchEvent(new CustomEvent(PALETTE_CACHE_UPDATE_EVENT, { detail: { path, palette: hexColors } }));
                return hexColors;
            }
            return [];
        } catch (e) {
            console.error("Failed to load palette to cache", path, e);
            return [];
        } finally {
            paletteLoadingPromises.delete(path);
        }
    })();
    
    paletteLoadingPromises.set(path, loadPromise);
    return loadPromise;
};

// 预加载调色板到缓存（静默，不返回结果）
export const preloadPaletteToCache = (path: string, existingPalette?: string[]): void => {
    if (!paletteCache.has(path) && !paletteLoadingPromises.has(path)) {
        loadPaletteToCache(path, existingPalette).catch(() => {});
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
  const lastFileIdRef = useRef(file.id);

  // Color Picker State
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isColorSearching, setIsColorSearching] = useState(false);
  const colorPickerContainerRef = useRef<HTMLDivElement>(null);
  
  // 简化的单图层机制：当前显示的 URL + 正在加载的路径
  const [displayUrl, setDisplayUrl] = useState<string>(() => {
    if (file.path) {
      const cached = getBlobCacheSync(file.path);
      if (cached) return cached;
    }
    return '';
  });
  // 追踪当前显示的文件路径（用于验证）
  const displayPathRef = useRef<string>(file.path || '');
  // 追踪正在加载的文件路径
  const loadingPathRef = useRef<string>('');
  
  // 幻灯片模式专用：前一张图片的 URL（用于过渡效果）
  const [prevDisplayUrl, setPrevDisplayUrl] = useState<string>('');
  // 幻灯片过渡状态：是否正在过渡中
  const [isTransitioning, setIsTransitioning] = useState(false);
  // 幻灯片过渡专用：存储前一张图片的最后变换状态，实现“暂停”效果
  const [prevTransform, setPrevTransform] = useState<string>('none');
  // 过渡计时器
  const transitionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 使用 ref 存储最新的状态值，避免 useEffect 闭包问题
  const slideshowActiveRef = useRef(slideshowActive);
  const slideshowTransitionRef = useRef(slideshowConfig.transition);
  const displayUrlRef = useRef(displayUrl);
  
  // 保持 ref 与 state 同步
  useEffect(() => { slideshowActiveRef.current = slideshowActive; }, [slideshowActive]);
  useEffect(() => { slideshowTransitionRef.current = slideshowConfig.transition; }, [slideshowConfig.transition]);
  useEffect(() => { displayUrlRef.current = displayUrl; }, [displayUrl]);

  // 简化的图片加载逻辑：缓存命中时立即切换，未命中时保留当前图片直到新图就绪
  useEffect(() => {
    if (!file.path) {
      setDisplayUrl('');
      displayPathRef.current = '';
      return;
    }
    
    const path = file.path;
    
    // 尝试同步获取缓存
    const cachedUrl = getBlobCacheSync(path);
    
    if (cachedUrl) {
      // 幻灯片模式下，保存当前图片作为过渡的起始图
      const shouldTransition = slideshowActiveRef.current && displayUrlRef.current && slideshowTransitionRef.current !== 'none';
      
      if (shouldTransition) {
        // 捕获当前图片的最后变换状态，用于实现幻灯片切换时的“暂停效果”
        // 仅在淡入淡出模式且开启了缩放时生效
        if (slideshowTransitionRef.current === 'fade' && slideshowConfig.enableZoom) {
          const currentImg = imgRef.current;
          if (currentImg) {
            const computedStyle = window.getComputedStyle(currentImg);
            setPrevTransform(computedStyle.transform);
          }
        } else {
          setPrevTransform('none');
        }

        setPrevDisplayUrl(displayUrlRef.current);
        setIsTransitioning(true);
        // 清除之前的计时器
        if (transitionTimerRef.current) {
          clearTimeout(transitionTimerRef.current);
        }
        // 过渡完成后清除状态
        transitionTimerRef.current = setTimeout(() => {
          setIsTransitioning(false);
          setPrevDisplayUrl('');
        }, 600); // 与 CSS 过渡时长一致
      }
      
      // 缓存命中：立即切换，无需等待
      setDisplayUrl(cachedUrl);
      displayPathRef.current = path;
      loadingPathRef.current = '';
    } else {
      // 缓存未命中：保留当前图片，异步加载新图
      loadingPathRef.current = path;
      
      loadToCache(path).then(url => {
        // 只有当这仍然是我们想要的图片时才更新
        if (loadingPathRef.current === path) {
          // 幻灯片模式下的过渡处理
          if (slideshowActiveRef.current && displayUrlRef.current && slideshowTransitionRef.current !== 'none') {
            // 捕获当前图片的最后变换状态
            if (slideshowTransitionRef.current === 'fade' && slideshowConfig.enableZoom) {
              const currentImg = imgRef.current;
              if (currentImg) {
                const computedStyle = window.getComputedStyle(currentImg);
                setPrevTransform(computedStyle.transform);
              }
            } else {
              setPrevTransform('none');
            }

            setPrevDisplayUrl(displayUrlRef.current);
            setIsTransitioning(true);
            if (transitionTimerRef.current) {
              clearTimeout(transitionTimerRef.current);
            }
            transitionTimerRef.current = setTimeout(() => {
              setIsTransitioning(false);
              setPrevDisplayUrl('');
            }, 600);
          }
          
          setDisplayUrl(url);
          displayPathRef.current = path;
          loadingPathRef.current = '';
        }
      });
    }
  }, [file.path]);
  
  // 清理过渡计时器
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
    };
  }, []);


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

  // Preload neighbors into Blob Cache - 使用优化后的静默预加载
  useEffect(() => {
     // 优先预加载前后各3张（最可能被访问的）
     const priorityCount = 3;
     const priorityNodes = preloadImages.slice(0, priorityCount * 2);
     const restNodes = preloadImages.slice(priorityCount * 2);
     
     // 立即预加载优先级高的图片和调色板
     priorityNodes.forEach(node => {
        if (node.path) {
           preloadToCache(node.path);
           // 同时预加载调色板（使用文件已有的 palette 数据，如果有的话）
           preloadPaletteToCache(node.path, node.meta?.palette);
        }
     });
     
     // 延迟预加载其余图片和调色板，避免阻塞
     const timeoutId = setTimeout(() => {
         restNodes.forEach(node => {
            if (node.path) {
               preloadToCache(node.path);
               preloadPaletteToCache(node.path, node.meta?.palette);
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
      // 重置视图状态（缩放、旋转、位置）
      setRotation(0);
      setPosition({ x: 0, y: 0 });
      setScale(1); 
      lastFileIdRef.current = file.id;
    }
  }, [file.id]);

  useEffect(() => {
    if (!isColorPickerOpen) return;
    
    const handleClickOutside = (event: MouseEvent) => {
      if (colorPickerContainerRef.current && !colorPickerContainerRef.current.contains(event.target as Node)) {
        setIsColorPickerOpen(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isColorPickerOpen]);

  const isColorSearchQuery = useMemo(() => localQuery.startsWith('color:'), [localQuery]);
  const currentSearchColor = useMemo(() => isColorSearchQuery ? localQuery.replace('color:', '') : '', [isColorSearchQuery, localQuery]);

  const pickerInitialColor = useMemo(() => {
    if (currentSearchColor) return currentSearchColor;
    return '#3b82f6'; // 默认蓝色
  }, [currentSearchColor]);

  // Debounce color search to prevent event flooding
  const debouncedColorSearch = useMemo(() => 
    debounce(async (color: string) => {
       setIsColorSearching(true);
       try {
         onSearch(`color:${color}`);
       } catch (e) {
         console.error(e);
       } finally {
         setIsColorSearching(false);
       }
    }, 300)
  , [onSearch]);

  const handleColorSelect = (color: string) => {
    setLocalQuery(`color:${color}`);
    debouncedColorSearch(color);
  };

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
    onNext();
  };

  const handlePrev = () => {
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
      onClick={(e) => {
        setContextMenu({ ...contextMenu, visible: false });
        setIsColorPickerOpen(false);
      }}
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
            <div className="relative w-full max-w-[672px] animate-fade-in" onClick={(e) => e.stopPropagation()}>
              <div className={`flex items-center bg-gray-100 dark:bg-gray-800 rounded-full px-3 py-1.5 transition-all border ${
                isColorSearchQuery
                  ? 'border-blue-500 shadow-sm'
                  : isAISearchEnabled 
                    ? 'border-purple-500 shadow-sm shadow-purple-500/20' 
                    : localQuery 
                      ? 'border-blue-500 shadow-sm' 
                      : 'border-transparent'
              }`}>
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
                <div className="relative flex items-center" ref={colorPickerContainerRef}>
                   {isColorSearching ? (
                      <Loader2 size={16} className="mr-2 flex-shrink-0 text-blue-500 animate-spin" />
                   ) : (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          e.preventDefault(); // 添加 preventDefault 以防万一
                          setIsColorPickerOpen(!isColorPickerOpen);
                        }}
                        className={`mr-2 flex-shrink-0 cursor-pointer hover:text-blue-500 transition-colors ${isAISearchEnabled ? 'text-purple-500' : 'text-gray-400'} flex items-center relative z-[110]`}
                        title="Search by color"
                        >
                        <Palette size={16} />
                      </button>
                   )}
                   
                   {isColorPickerOpen && (
                      <div 
                        className="fixed z-[9999]" 
                        style={{ 
                          top: colorPickerContainerRef.current ? colorPickerContainerRef.current.getBoundingClientRect().bottom + 8 : 'auto',
                          left: colorPickerContainerRef.current ? colorPickerContainerRef.current.getBoundingClientRect().left : 'auto'
                        }}
                        onClick={(e) => e.stopPropagation()}
                      >
                          <ColorPickerPopover 
                             onChange={handleColorSelect}
                             onClose={() => setIsColorPickerOpen(false)}
                             initialColor={pickerInitialColor}
                            t={t}
                          />
                      </div>
                   )}
                </div>

                {isColorSearchQuery && (
                  <div 
                      className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-700 mr-2 flex-shrink-0 shadow-sm"
                      style={{ backgroundColor: currentSearchColor }}
                  />
                )}

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
        {!displayUrl && (
           <div className="absolute inset-0 flex items-center justify-center z-0">
               <Loader2 className="animate-spin text-gray-400 dark:text-gray-600" size={48} />
           </div>
        )}

        {/* 单图层渲染 - 简洁高效（普通模式） */}
        {/* 幻灯片模式下使用双图层实现过渡效果 */}
        <div className="w-full h-full flex items-center justify-center pointer-events-none relative overflow-hidden">
           {/* 幻灯片过渡：前一张图片（淡出/滑出） */}
           {slideshowActive && prevDisplayUrl && (
             <img 
               key={`prev-${prevDisplayUrl}`}
               src={prevDisplayUrl} 
               alt=""
               className={`max-w-none absolute inset-0 m-auto ${
                 slideshowConfig.transition === 'fade' 
                   ? 'animate-slideshow-fade-out' 
                   : slideshowConfig.transition === 'slide'
                     ? 'animate-slideshow-slide-out'
                     : ''
               }`}
               loading="eager"
               decoding="sync"
               style={{
                 width: '100%',
                 height: '100%',
                 objectFit: 'contain',
                 pointerEvents: 'none',
                 zIndex: 1,
                 transform: slideshowConfig.transition === 'fade' ? prevTransform : undefined,
               }}
               draggable={false}
             />
           )}
           
           {/* 当前图片 */}
           <img 
             ref={imgRef}
             key={slideshowActive && slideshowConfig.transition !== 'none' ? `current-${displayUrl}` : 'main'}
             src={displayUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'} 
             alt={file.name}
             className={`max-w-none absolute inset-0 m-auto ${
               slideshowActive && slideshowConfig.enableZoom && !isTransitioning ? 'animate-ken-burns' : ''
             } ${
               slideshowActive && isTransitioning && slideshowConfig.transition === 'fade' 
                 ? 'animate-slideshow-fade-in' 
                 : slideshowActive && isTransitioning && slideshowConfig.transition === 'slide'
                   ? 'animate-slideshow-slide-in'
                   : ''
             }`}
             loading="eager"
             decoding="sync"
             style={{
               width: '100%',
               height: '100%',
               objectFit: 'contain',
               // 普通模式或幻灯片无过渡时的 transform
               ...(!slideshowActive || slideshowConfig.transition === 'none' || !isTransitioning ? {
                 transform: slideshowActive && slideshowConfig.enableZoom ? undefined : `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
                 transition: isDragging ? 'none' : 'transform 0.1s linear',
               } : {}),
               pointerEvents: slideshowActive ? 'none' : 'auto',
               transformOrigin: 'center center',
               zIndex: 2,
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
