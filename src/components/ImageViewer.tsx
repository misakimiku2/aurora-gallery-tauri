import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import React, { useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { FileNode, SlideshowConfig, SearchScope, TabState, FileType } from '../types';
import { debounce } from '../utils/debounce';
import { isRemotePath, getRemoteImageUrl, getRemotePalette, getRemoteThumbnailUrl, subscribeRemoteChange } from '../utils/remoteSource';
import { isTextEditingTarget } from '../utils/keyboardTarget';
import { ColorPickerPopover } from './ColorPickerPopover';
import { VideoControls } from './viewer/VideoControls';
import { useToasts } from '../hooks/useToasts';
import { isWebDecodableVideo } from '../utils/mediaExtensions';
import { isAndroidSync } from '../utils/androidPlatform';
import { openWithDefaultApp } from '../api/tauri-bridge/files';
import {
  X, ChevronLeft, ChevronRight, Search, Sidebar, PanelRight,
  RotateCw, RotateCcw, Maximize, Minimize, ArrowLeft, ArrowRight,
  Play, Square, Settings, Sliders, Globe, FileText, Tag, Folder as FolderIcon, ChevronDown, Loader2,
  Copy, ExternalLink, Image as ImageIcon, Save, Move, Trash2, FolderOpen, Palette, Clipboard,
  Scan, AlertTriangle
} from 'lucide-react';


// 全局高分辨率图片 Blob 缓存 - 增大容量�?200 �?
const blobCache = new Map<string, string>();
const MAX_CACHE_SIZE = 50;

// 视频全屏时，顶部工具栏与底部控制条静止多久后自动隐藏
const CHROME_IDLE_MS = 1500;

const loadingPromises = new Map<string, Promise<string>>();

// Blob 大小追踪（与 blobCache 平行，用于统计内存占用）
const blobCacheSizes = new Map<string, number>();

const evictBlobCache = (): void => {
  while (blobCache.size > MAX_CACHE_SIZE) {
    const firstKey = blobCache.keys().next().value;
    if (firstKey) {
      const url = blobCache.get(firstKey);
      blobCache.delete(firstKey);
      const size = blobCacheSizes.get(firstKey);
      if (size !== undefined) {
        totalBlobBytes -= size;
        blobCacheSizes.delete(firstKey);
      }
      if (url && url.startsWith('blob:')) {
        try { URL.revokeObjectURL(url); } catch {}
      }
    }
  }
};

// 同步获取缓存（如果存在）- 用于无闪烁切换
export const getBlobCacheSync = (path: string): string | null => {
  if (blobCache.has(path)) {
    const url = blobCache.get(path)!;
    // LRU: 移动到最后
    blobCache.delete(path);
    blobCache.set(path, url);
    // size 也同步移动
    const size = blobCacheSizes.get(path);
    if (size !== undefined) {
      blobCacheSizes.delete(path);
      blobCacheSizes.set(path, size);
    }
    return url;
  }
  return null;
};

// 检查缓存是否存在
export const hasBlobCache = (path: string): boolean => {
  return blobCache.has(path);
};

// Blob 缓存总内存占用（字节）
let totalBlobBytes = 0;

// 预加载 Image 对象缓存：持有 Image 引用防止 GC，让浏览器保留解码后的位图。
// 切换时 <img> 使用相同 URL，浏览器复用内存中的解码位图，跳过下载+解码。
// 仅用于 LAN 图片（本地图片已有 native preview 缓存）。
const preloadedImages = new Map<string, HTMLImageElement>();
const MAX_PRELOADED_IMAGES = 6;

const preloadLanImage = (path: string, httpUrl: string, priority: 'high' | 'low'): void => {
  // 只对高优先级（immediate 邻居）触发预下载。
  // 低优先级（nearby）只缓存 URL，避免并发下载过多拖慢当前图片。
  // 无线网络下 7 个并发下载会导致每张 13-19 秒；限制为 immediate（2张）+ 当前（1张）= 3 个并发。
  if (priority === 'low') return;

  if (preloadedImages.has(path)) return;

  const doPreload = () => {
    if (preloadedImages.has(path)) return;
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => {
      if (typeof img.decode === 'function') {
        img.decode().catch(() => {});
      }
    };
    img.src = httpUrl;
    preloadedImages.set(path, img);

    while (preloadedImages.size > MAX_PRELOADED_IMAGES) {
      const firstKey = preloadedImages.keys().next().value;
      if (firstKey) preloadedImages.delete(firstKey);
    }
  };

  // 延迟 1.5 秒，让当前图片先占用带宽下载
  setTimeout(doPreload, 1500);
};

// 远程连接变化（设备重连/token 刷新）：缓存的远程原图 URL 内嵌旧 token，
// 必须整体失效，否则重连后查看器仍用旧 URL 请求 → 401 → 裂图。
subscribeRemoteChange(() => {
  for (const key of Array.from(blobCache.keys())) {
    if (isRemotePath(key)) {
      blobCache.delete(key);
      blobCacheSizes.delete(key);
    }
  }
  preloadedImages.clear();
});

const loadToCache = async (path: string, priority: 'high' | 'low' = 'low'): Promise<string> => {
  const cached = getBlobCacheSync(path);
  if (cached) return cached;

  // 远程来源（桌面端服务/安卓设备）：直接缓存 HTTP URL，跳过 fetch blob。
  // 原因：在 Android WebView 中，response.blob() 对 3-4MB 的 LAN 图片极其缓慢
  // （实测 5-8 秒），而 <img> 直接加载 HTTP URL 时浏览器只需 300-1000ms 下载。
  // 浏览器会自动缓存已下载的 HTTP 响应，不需要手动创建 blob URL。
  if (isRemotePath(path)) {
    const httpUrl = getRemoteImageUrl(path);

    // 设备断开时客户端不在注册表，解析结果为空串——绝不写入缓存，
    // 否则重连后命中缓存拿到空串，原图永久裂图。
    if (httpUrl) {
      blobCache.set(path, httpUrl);
      blobCacheSizes.set(path, 0);
      evictBlobCache();
      // 触发预下载+预解码：持有 Image 对象引用，让浏览器保留解码位图。
      // 切换时 <img> 命中浏览器内部缓存，跳过下载+解码（DECODE 从 3.2s 降到 ~0ms）。
      preloadLanImage(path, httpUrl, priority);
    }
    return httpUrl;
  }

  if (loadingPromises.has(path)) {
    return loadingPromises.get(path)!;
  }

  const loadPromise = (async () => {
    try {
      if (path.toLowerCase().endsWith('.jxl')) {
        const previewUrl = await invoke<string>('get_jxl_preview', { path });
        blobCache.set(path, previewUrl);
        blobCacheSizes.set(path, 0);
        evictBlobCache();
        return previewUrl;
      }

      if (path.toLowerCase().endsWith('.avif')) {
        const previewUrl = await invoke<string>('get_avif_preview', { path });
        blobCache.set(path, previewUrl);
        blobCacheSizes.set(path, 0);
        evictBlobCache();
        return previewUrl;
      }

      const url = convertFileSrc(path);
      blobCache.set(path, url);
      blobCacheSizes.set(path, 0);
      evictBlobCache();
      return url;
    } catch (e) {
      console.error("Failed to load image to cache", path, e);
      return convertFileSrc(path);
    } finally {
      loadingPromises.delete(path);
    }
  })();

  loadingPromises.set(path, loadPromise);
  return loadPromise;
};

// 预加载图片到缓存（静默，不返回结果）
const isAnimatedFile = (path: string): boolean => {
  const ext = path.toLowerCase();
  return ext.endsWith('.webp') || ext.endsWith('.gif');
};

export const preloadToCache = (path: string, priority: 'high' | 'low' = 'low'): void => {
  if (!blobCache.has(path) && !loadingPromises.has(path)) {
    loadToCache(path, priority).catch(() => {});
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
      let hexColors: string[] = [];

      if (isRemotePath(path)) {
        // 远程图片（桌面端服务/安卓设备）：从服务端按需获取 palette
        // （browse 时不返回 palette 以节省传输）
        hexColors = await getRemotePalette(path);
      } else {
        // 本地图片：通过 Tauri 命令提取主色调
        const { getDominantColors } = await import('../api/tauri-bridge');
        const colors = await getDominantColors(path, 8);
        if (colors && colors.length > 0) {
          hexColors = colors.map(c => c.hex);
        }
      }

      if (hexColors.length > 0) {
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
    loadPaletteToCache(path, existingPalette).catch(() => { });
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
  // 图片对比功能相关
  tabs?: TabState[];
  handleOpenCompareInNewTab?: (imageIds: string[]) => void;
  handleAddToCompareCanvas?: (tabId: string, imageIds: string[]) => void;
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
  activeTab,
  tabs = [],
  handleOpenCompareInNewTab,
  handleAddToCompareCanvas,
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

  // 统一容器：按 file.type 分派渲染层（设计文档 §1.1）——
  // 顶层容器（顶栏/右侧面板/键盘/导航）不卸载，只有渲染层与底部控制条随类型切换。
  const isVideo = file.type === FileType.VIDEO;
  const videoRef = useRef<HTMLVideoElement>(null);
  // 视频拖拽（平移）判定：拖拽后抑制尾随的 click，避免「平移顺带暂停」
  const videoDragMovedRef = useRef(false);

  // 复制帧的结果提醒（指挥官 2026-10-14 要求）：成功/失败都要有反馈，不再静默
  const { toast: frameToast, showToast: showFrameToast } = useToasts();

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
  const animateTransformTo = (toScale: number, toX: number, toY: number, duration = 320, easing: 'back' | 'smooth' = 'back') => {
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
    const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);

    const start = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / computedDuration);
      const k = easing === 'back' ? easeOutBack(t) : easeOutQuint(t);
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
  const [isImmersiveMode, setIsImmersiveMode] = useState(false);
  const [immersiveFlip, setImmersiveFlip] = useState<{
    oldCenterX: number;
    oldCenterY: number;
  } | null>(null);
  const [isFlipAnimating, setIsFlipAnimating] = useState(false);
  const [isTransformAnimating, setIsTransformAnimating] = useState(false);
  const [showSearch, setShowSearch] = useState(false);
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [scopeMenuPos, setScopeMenuPos] = useState({ top: 0, left: 0 });

  const [isWheeling, setIsWheeling] = useState(false);
  const wheelTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [localQuery, setLocalQuery] = useState(searchQuery);
  const lastFileIdRef = useRef(file.id);

  const onNextRef = useRef(onNext);
  const onPrevRef = useRef(onPrev);
  const sortedFileIdsRef = useRef(sortedFileIds);
  const filesRef = useRef(files);
  const fileIdRef = useRef(file.id);

  useEffect(() => { onNextRef.current = onNext; }, [onNext]);
  useEffect(() => { onPrevRef.current = onPrev; }, [onPrev]);
  useEffect(() => { sortedFileIdsRef.current = sortedFileIds; }, [sortedFileIds]);
  useEffect(() => { filesRef.current = files; }, [files]);
  useEffect(() => { fileIdRef.current = file.id; }, [file.id]);

  const isImmersiveModeRef = useRef(isImmersiveMode);
  useEffect(() => {
    isImmersiveModeRef.current = isImmersiveMode;
    (window as any).__isImmersive = isImmersiveMode;
  }, [isImmersiveMode]);

  // ── 视频可播性（2026-10-22 改口径）──
  // 容器不在 WebView2 可解清单内（avi/wmv/flv/mpg/3gp/ts…）→ **不进 <video>**，直接占位符。
  // 原「转封装换容器」链路已整体移除：remux 只换容器不改编码，这类文件转完照样播不了，
  // 却要白等几十秒并占一份等大副本。现口径统一为占位符 + 提示用外部播放器打开。
  // 远程（LAN）与安卓端不在本判定内 —— 那两处的可播性由各自的播放器/服务端决定。
  const videoUnsupported = useMemo(() => {
    if (!isVideo || !file.path) return false;
    if (isRemotePath(file.path) || isAndroidSync()) return false;
    return !isWebDecodableVideo(file.path);
  }, [isVideo, file.path]);

  // ── 视频：播放源分派 ──
  // ① 本地可解容器（mp4/m4v/mov/webm/mkv）→ convertFileSrc(源文件)；
  // ② 本地不可解容器 → 不给 src（占位符接管，见下方提示卡）；
  // ③ 远程：沿用图片的远程 URL 解析（LAN 视频串流走服务端 Range）。
  const videoSrc = useMemo(() => {
    if (!isVideo || !file.path) return '';
    if (videoUnsupported) return '';
    if (isRemotePath(file.path)) return getRemoteImageUrl(file.path);
    return convertFileSrc(file.path);
  }, [isVideo, file.path, videoUnsupported]);

  // 视频缓冲/seek 等待状态：驱动媒体区中央的等待遮罩（§3「seek 中/缓冲中显示 waiting 状态」）
  // 稳定化：总文档 §3.2 的 asset protocol 按 ≤1MB 分片返回，单次 seek/播放会多次触发
  // waiting↔canplay；直连 boolean 会让遮罩反复挂载、animate-spin 每次从 0° 重播（闪烁）。
  // 故同样采用「延迟显示 + 最短展示」吸收抖动。图片模式不涉及，行为保持不变。
  const [isVideoBuffering, setIsVideoBuffering] = useState(false);
  // 播放失败态（2026-10-15）：MKV/AVI 等 Web 不解容器点开此前是「黑屏无提示」——
  // onError 时显示降级提示卡（SRC_NOT_SUPPORTED(4) →「格式不支持」；其余 →「加载失败」）。
  const [videoErrorCode, setVideoErrorCode] = useState<number | null>(null);
  useEffect(() => { setVideoErrorCode(null); }, [file.id]);
  // 拖拽进度条中（尚未 seek，§3）：由 VideoControls 回调同步，期间不显示中央遮罩
  const [isVideoScrubbing, setIsVideoScrubbing] = useState(false);
  const isVideoScrubbingRef = useRef(false);
  useEffect(() => { isVideoScrubbingRef.current = isVideoScrubbing; }, [isVideoScrubbing]);
  const handleVideoScrubbingChange = useCallback((scrubbing: boolean) => { setIsVideoScrubbing(scrubbing); }, []);

  const videoBufRef = useRef(false);          // 中央遮罩当前是否已「显示」
  const videoBufShownAtRef = useRef(0);       // 显示时刻
  const videoBufShowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 延迟显示
  const videoBufHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null); // 延迟隐藏
  useEffect(() => {
    const clearTimers = () => {
      if (videoBufShowTimerRef.current) { clearTimeout(videoBufShowTimerRef.current); videoBufShowTimerRef.current = null; }
      if (videoBufHideTimerRef.current) { clearTimeout(videoBufHideTimerRef.current); videoBufHideTimerRef.current = null; }
    };
    // 与 VideoControls 同一套稳定化策略：120ms 内自愈的等待不显示；显示的至少保持 320ms
    const applyWaiting = (next: boolean) => {
      if (next) {
        if (videoBufHideTimerRef.current) { clearTimeout(videoBufHideTimerRef.current); videoBufHideTimerRef.current = null; }
        if (videoBufRef.current || videoBufShowTimerRef.current) return;
        videoBufShowTimerRef.current = setTimeout(() => {
          videoBufShowTimerRef.current = null;
          videoBufRef.current = true;
          videoBufShownAtRef.current = performance.now();
          setIsVideoBuffering(true);
        }, 120);
        return;
      }
      if (videoBufShowTimerRef.current) { clearTimeout(videoBufShowTimerRef.current); videoBufShowTimerRef.current = null; }
      if (!videoBufRef.current) return;
      const remain = 320 - (performance.now() - videoBufShownAtRef.current);
      if (remain <= 0) {
        videoBufRef.current = false;
        setIsVideoBuffering(false);
      } else if (!videoBufHideTimerRef.current) {
        videoBufHideTimerRef.current = setTimeout(() => {
          videoBufHideTimerRef.current = null;
          videoBufRef.current = false;
          setIsVideoBuffering(false);
        }, remain);
      }
    };

    if (!isVideo) {
      clearTimers();
      videoBufRef.current = false;
      setIsVideoBuffering(false);
      return;
    }
    const v = videoRef.current;
    if (!v) return;
    // 拖拽中不显示遮罩（尚未 seek，此时 waiting 只是播放流下的背景缓冲噪声）
    const onWaiting = () => { if (!isVideoScrubbingRef.current) applyWaiting(true); };
    const onReady = () => applyWaiting(false);
    v.addEventListener('waiting', onWaiting);
    v.addEventListener('stalled', onWaiting);
    v.addEventListener('seeking', onWaiting);
    v.addEventListener('playing', onReady);
    v.addEventListener('seeked', onReady);
    v.addEventListener('canplay', onReady);
    return () => {
      v.removeEventListener('waiting', onWaiting);
      v.removeEventListener('stalled', onWaiting);
      v.removeEventListener('seeking', onWaiting);
      v.removeEventListener('playing', onReady);
      v.removeEventListener('seeked', onReady);
      v.removeEventListener('canplay', onReady);
      clearTimers();
    };
  }, [isVideo, file.id]);

  // ── B4 / §5：切换文件或关闭查看器时必须 pause() + 重置 currentTime，否则会后台出声 ──
  // 用 effect cleanup 兜住所有路径（file.id 变化 + 组件卸载）；捕获元素引用避免误伤新元素。
  useEffect(() => {
    const v = videoRef.current;
    return () => {
      if (v) {
        try {
          v.pause();
          v.currentTime = 0;
        } catch {
          // ignore
        }
      }
    };
  }, [file.id, isVideo]);

  // Color Picker State
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isColorSearching, setIsColorSearching] = useState(false);
  const colorPickerContainerRef = useRef<HTMLDivElement>(null);

  // 图片对比二级菜单状态
  const [compareSubmenuOpen, setCompareSubmenuOpen] = useState(false);
  const compareMenuTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const compareMenuItemRef = useRef<HTMLDivElement | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState({ x: 0, y: 0 });

  // 获取所有图片对比标签页
  const compareTabs = tabs.filter(tab => tab.isCompareMode);
  const hasCompareTabs = compareTabs.length > 0;

  // 计算二级菜单位置
  useEffect(() => {
    if (compareSubmenuOpen && compareMenuItemRef.current) {
      const menuItemRect = compareMenuItemRef.current.getBoundingClientRect();
      const screenWidth = window.innerWidth;
      const screenHeight = window.innerHeight;
      
      // 预估二级菜单尺寸
      const menuWidth = 200;
      const menuHeight = compareTabs.length * 36 + 40; // 每个画布项约36px + 新建画布区域
      
      let x = menuItemRect.right + 4;
      let y = menuItemRect.top;

      // 如果超出屏幕右侧，显示在左侧
      if (x + menuWidth > screenWidth) {
        x = menuItemRect.left - menuWidth - 4;
      }

      // 如果超出屏幕底部，向上调整
      if (y + menuHeight > screenHeight) {
        y = screenHeight - menuHeight - 10;
      }

      setSubmenuPosition({ x, y });
    }
  }, [compareSubmenuOpen, compareTabs.length]);

  // 简化的单图层机制：当前显示的 URL + 正在加载的路径
  const [displayUrl, setDisplayUrl] = useState<string>(() => {
    if (file.path) {
      const cached = getBlobCacheSync(file.path);
      if (cached) {
        return cached;
      }
    }
    return '';
  });
  const displayPathRef = useRef<string>(file.path || '');
  const loadingPathRef = useRef<string>('');

  // LAN 缩略图→原图渐变过渡：先显示 256px 缩略图（服务端已缓存，下载快），
  // 原图下载完成后渐变替换。lanThumbUrl 为缩略图 URL，lanFadeIn 控制主图透明度过渡。
  const [lanThumbUrl, setLanThumbUrl] = useState<string>('');
  const [lanFadeIn, setLanFadeIn] = useState<boolean>(false);
  const lanFadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lanThumbUrlRef = useRef<string>('');
  useEffect(() => { lanThumbUrlRef.current = lanThumbUrl; }, [lanThumbUrl]);

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

  // 远程连接变化（设备重连/token 刷新）时自增，强制重新解析当前图片 URL，
  // 否则查看器会一直显示断线时解析出的空 URL / 旧 token URL。
  const [remoteEpoch, setRemoteEpoch] = useState(0);
  useEffect(() => subscribeRemoteChange(() => setRemoteEpoch((n) => n + 1)), []);

  // 简化的图片加载逻辑：缓存命中时立即切换，未命中时保留当前图片直到新图就绪
  useEffect(() => {
    // 视频不走图片加载管线（<video> 自行加载，见 §1.1 渲染层分派）
    if (isVideo) {
      setDisplayUrl('');
      displayPathRef.current = '';
      return;
    }
    if (!file.path) {
      setDisplayUrl('');
      displayPathRef.current = '';
      return;
    }

    const path = file.path;

    // 清理上一次 LAN 缩略图渐变状态（防止跨图片残留）
    if (lanFadeTimerRef.current) {
      clearTimeout(lanFadeTimerRef.current);
      lanFadeTimerRef.current = null;
    }
    setLanThumbUrl('');
    setLanFadeIn(false);

    if (file.meta?.palette && file.meta.palette.length > 0 && !file.meta.palette.every(c => c === '#000000')) {
      if (!paletteCache.has(path)) {
        if (paletteCache.size >= MAX_PALETTE_CACHE_SIZE) {
          const firstKey = paletteCache.keys().next().value;
          if (firstKey) paletteCache.delete(firstKey);
        }
        paletteCache.set(path, file.meta.palette);
      }
    }

    // 远程图片（桌面端服务/安卓设备，非幻灯片模式）：先立即显示 256px 缩略图，
    // 原图下载后渐变替换。无论 blobCache 命中与否，浏览器可能尚未下载原图字节，
    // 所以总是先显示缩略图。
    const isLan = isRemotePath(path) && !slideshowActiveRef.current;
    if (isLan) {
      const thumbUrl = getRemoteThumbnailUrl(path);
      setLanThumbUrl(thumbUrl);
      setLanFadeIn(true);
    }

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

      loadingPathRef.current = path;
      const preloadImg = new Image();
      preloadImg.onload = () => {
        if (loadingPathRef.current !== path) return;

        // LAN 缩略图→原图渐变：用 lanFadeIn 控制透明度过渡
        if (isLan && lanThumbUrlRef.current) {
          setDisplayUrl(cachedUrl);
          displayPathRef.current = path;
          loadingPathRef.current = '';
          // 双重 rAF：确保浏览器先以 opacity:0 渲染原图，再触发渐变到 opacity:1
          requestAnimationFrame(() => {
            requestAnimationFrame(() => setLanFadeIn(false));
          });
          if (lanFadeTimerRef.current) clearTimeout(lanFadeTimerRef.current);
          lanFadeTimerRef.current = setTimeout(() => {
            setLanThumbUrl('');
            lanFadeTimerRef.current = null;
          }, 500);
          return;
        }

        setDisplayUrl(cachedUrl);
        displayPathRef.current = path;
        loadingPathRef.current = '';
      };
      preloadImg.onerror = () => {
        if (loadingPathRef.current !== path) return;

        // LAN 缩略图→原图渐变（错误回退：直接显示，不渐变）
        if (isLan && lanThumbUrlRef.current) {
          setDisplayUrl(cachedUrl);
          displayPathRef.current = path;
          loadingPathRef.current = '';
          setLanFadeIn(false);
          setLanThumbUrl('');
          return;
        }

        setDisplayUrl(cachedUrl);
        displayPathRef.current = path;
        loadingPathRef.current = '';
      };
      preloadImg.src = cachedUrl;
    } else {
      loadingPathRef.current = path;

      // 使用高优先级：取消所有 LAN 预加载请求，让当前图片独占网络带宽
      loadToCache(path, 'high').then(url => {
        // 被取消的请求返回空字符串，跳过
        if (!url) {
          return;
        }
        if (loadingPathRef.current === path) {
          const oldDisplayUrl = displayUrlRef.current;
          const preloadImg2 = new Image();
          preloadImg2.onload = () => {
            if (loadingPathRef.current !== path) return;

            // LAN 缩略图→原图渐变：用 lanFadeIn 控制透明度过渡
            if (isLan && lanThumbUrlRef.current) {
              setDisplayUrl(url);
              displayPathRef.current = path;
              loadingPathRef.current = '';
              // 双重 rAF：确保浏览器先以 opacity:0 渲染原图，再触发渐变到 opacity:1
              requestAnimationFrame(() => {
                requestAnimationFrame(() => setLanFadeIn(false));
              });
              if (lanFadeTimerRef.current) clearTimeout(lanFadeTimerRef.current);
              lanFadeTimerRef.current = setTimeout(() => {
                setLanThumbUrl('');
                lanFadeTimerRef.current = null;
              }, 500);
              return;
            }

            if (slideshowActiveRef.current && oldDisplayUrl && slideshowTransitionRef.current !== 'none') {
              if (slideshowTransitionRef.current === 'fade' && slideshowConfig.enableZoom) {
                const currentImg = imgRef.current;
                if (currentImg) {
                  const computedStyle = window.getComputedStyle(currentImg);
                  setPrevTransform(computedStyle.transform);
                }
              } else {
                setPrevTransform('none');
              }
              setPrevDisplayUrl(oldDisplayUrl);
              setIsTransitioning(true);
              if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
              transitionTimerRef.current = setTimeout(() => {
                setIsTransitioning(false);
                setPrevDisplayUrl('');
              }, 600);
            }
            setDisplayUrl(url);
            displayPathRef.current = path;
            loadingPathRef.current = '';
          };
          preloadImg2.onerror = () => {
            if (loadingPathRef.current !== path) return;

            // LAN 缩略图→原图渐变（错误回退：直接显示，不渐变）
            if (isLan && lanThumbUrlRef.current) {
              setDisplayUrl(url);
              displayPathRef.current = path;
              loadingPathRef.current = '';
              setLanFadeIn(false);
              setLanThumbUrl('');
              return;
            }

            if (slideshowActiveRef.current && oldDisplayUrl && slideshowTransitionRef.current !== 'none') {
              if (slideshowTransitionRef.current === 'fade' && slideshowConfig.enableZoom) {
                const currentImg = imgRef.current;
                if (currentImg) {
                  const computedStyle = window.getComputedStyle(currentImg);
                  setPrevTransform(computedStyle.transform);
                }
              } else {
                setPrevTransform('none');
              }
              setPrevDisplayUrl(oldDisplayUrl);
              setIsTransitioning(true);
              if (transitionTimerRef.current) clearTimeout(transitionTimerRef.current);
              transitionTimerRef.current = setTimeout(() => {
                setIsTransitioning(false);
                setPrevDisplayUrl('');
              }, 600);
            }
            setDisplayUrl(url);
            displayPathRef.current = path;
            loadingPathRef.current = '';
          };
          preloadImg2.src = url;
        }
      });
    }
  }, [file.path, remoteEpoch, isVideo]);

  // 清理过渡计时器
  useEffect(() => {
    return () => {
      if (transitionTimerRef.current) {
        clearTimeout(transitionTimerRef.current);
      }
      if (lanFadeTimerRef.current) {
        clearTimeout(lanFadeTimerRef.current);
      }
    };
  }, []);


  // --- Calculate Preload Nodes ---
  const preloadImages = useMemo(() => {
    if (!sortedFileIds || sortedFileIds.length === 0) return { immediate: [] as FileNode[], nearby: [] as FileNode[], key: '' };

    const currentIdx = sortedFileIds.indexOf(file.id);
    if (currentIdx === -1) return { immediate: [] as FileNode[], nearby: [] as FileNode[], key: '' };

    const getNeighbor = (offset: number) => {
      const idx = (currentIdx + offset + sortedFileIds.length) % sortedFileIds.length;
      return files[sortedFileIds[idx]];
    };

    const immediateRange = 3;
    const nearbyRange = 5;

    const immediate: FileNode[] = [];
    const pathKeys: string[] = [];
    for (let i = 1; i <= immediateRange; i++) {
      const prev = getNeighbor(-i);
      const next = getNeighbor(i);
      if (prev?.path) { immediate.push(prev); pathKeys.push(prev.path); }
      if (next?.path) { immediate.push(next); pathKeys.push(next.path); }
    }

    const nearby: FileNode[] = [];
    for (let i = immediateRange + 1; i <= nearbyRange; i++) {
      const prev = getNeighbor(-i);
      const next = getNeighbor(i);
      if (prev?.path) { nearby.push(prev); pathKeys.push(prev.path); }
      if (next?.path) { nearby.push(next); pathKeys.push(next.path); }
    }

    return { immediate, nearby, key: pathKeys.join('|') };
  }, [file.id, sortedFileIds, files]);

  useEffect(() => {
    const { immediate, nearby } = preloadImages;
    if (!preloadImages.key) return;

    immediate.forEach(node => {
      // 视频不预加载缩略图/调色板（图片管线不适用 mp4）
      if (node.path && node.type !== FileType.VIDEO) {
        preloadToCache(node.path, 'high');
        preloadPaletteToCache(node.path, node.meta?.palette);
      }
    });

    nearby.forEach(node => {
      if (node.path && node.type !== FileType.VIDEO) {
        preloadToCache(node.path, 'low');
        preloadPaletteToCache(node.path, node.meta?.palette);
      }
    });
  }, [preloadImages.key]);
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
          setCompareSubmenuOpen(false);
        }
      }
    };

    const handleWheel = (e: WheelEvent) => {
      if (contextMenu.visible) {
        setContextMenu({ ...contextMenu, visible: false });
        setCompareSubmenuOpen(false);
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

  // 清理二级菜单的定时器
  useEffect(() => {
    return () => {
      if (compareMenuTimeoutRef.current) {
        clearTimeout(compareMenuTimeoutRef.current);
      }
    };
  }, []);

  // 打开二级菜单（带延迟关闭保护）
  const openCompareSubmenu = () => {
    if (compareMenuTimeoutRef.current) {
      clearTimeout(compareMenuTimeoutRef.current);
      compareMenuTimeoutRef.current = null;
    }
    setCompareSubmenuOpen(true);
  };

  // 关闭二级菜单（带延迟）
  const closeCompareSubmenu = () => {
    compareMenuTimeoutRef.current = setTimeout(() => {
      setCompareSubmenuOpen(false);
    }, 150); // 150ms 延迟，给用户足够时间移动到二级菜单
  };

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
      if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
    };
  }, []);

  useEffect(() => {
    if (lastFileIdRef.current !== file.id) {
      setRotation(0);
      setPosition({ x: 0, y: 0 });
      setScale(1);
      lastFileIdRef.current = file.id;
    }
  }, [file.id]);

  useLayoutEffect(() => {
    if (!immersiveFlip || !containerRef.current) return;

    const rect = containerRef.current.getBoundingClientRect();

    const newCenterX = rect.left + rect.width / 2;
    const newCenterY = rect.top + rect.height / 2;

    const offsetX = immersiveFlip.oldCenterX - newCenterX;
    const offsetY = immersiveFlip.oldCenterY - newCenterY;

    const newPos = { x: offsetX, y: offsetY };
    setPosition(newPos);
    positionRef.current = newPos;
    setScale(1);
    scaleRef.current = 1;
    setImmersiveFlip(null);
    setIsFlipAnimating(true);

    requestAnimationFrame(() => {
      animateTransformTo(1, 0, 0, 200, 'smooth');
      setTimeout(() => {
        setIsFlipAnimating(false);
      }, 220);
    });
  }, [immersiveFlip]);

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

      const direction = Math.sign(e.deltaY);
      if (direction === 0) return;

      // 视频：滚轮 = 音量（播放器直觉），Shift+滚轮才沿用图片的缩放。
      // 音量变化由 <video> 的 volumechange 事件回流到 VideoControls，无需额外 HUD。
      if (isVideo && !e.shiftKey) {
        const v = videoRef.current;
        if (!v) return;
        v.muted = false;
        const next = Math.round((v.volume + (direction < 0 ? 0.05 : -0.05)) * 100) / 100;
        v.volume = Math.max(0, Math.min(1, next));
        return;
      }

      const ZOOM_SPEED = 0.3; // 显著提高缩放步长，提升缩放效率

      if (!containerRef.current) return;

      const rect = container.getBoundingClientRect();
      // 视频用 videoWidth/Height，图片用 naturalWidth/Height（此前只认 imgRef，视频上滚轮等于失效）
      const natural = getMediaNaturalSize();
      if (!natural) return;
      const { w: naturalWidth, h: naturalHeight } = natural;

      // 1. 计算当前逻辑上的图片边界（不依赖实时 DOM，消除抖动）
      const containerW = rect.width;
      const containerH = rect.height;
      const fitScale = Math.min(containerW / naturalWidth, containerH / naturalHeight);

      const currentScale = scaleRef.current;
      const currentPos = positionRef.current;

      const logicalW = naturalWidth * fitScale * currentScale;
      const logicalH = naturalHeight * fitScale * currentScale;
      const centerX = containerW / 2;
      const centerY = containerH / 2;

      // 图片逻辑中心坐标（相对于容器左上角）
      const imgCenterX = centerX + currentPos.x;
      const imgCenterY = centerY + currentPos.y;

      // 图片逻辑边界
      const imgLeft = imgCenterX - logicalW / 2;
      const imgTop = imgCenterY - logicalH / 2;
      const imgRight = imgCenterX + logicalW / 2;
      const imgBottom = imgCenterY + logicalH / 2;

      // 2. 找到图片上距离鼠标最近的点作为缩放中心
      const mouseX = e.clientX - rect.left;
      const mouseY = e.clientY - rect.top;
      const anchorX = Math.min(Math.max(mouseX, imgLeft), imgRight);
      const anchorY = Math.min(Math.max(mouseY, imgTop), imgBottom);

      // 3. 计算新缩放比例
      let newScale = direction < 0 ? currentScale * (1 + ZOOM_SPEED) : currentScale / (1 + ZOOM_SPEED);
      newScale = Math.max(0.01, Math.min(newScale, 15)); // 扩大缩放范围

      const scaleFactor = newScale / currentScale;
      if (scaleFactor === 1) return;

      // 4. 计算为保持锚点不动所需的新位移
      // 向量：中心 -> 锚点
      const vecX = anchorX - imgCenterX;
      const vecY = anchorY - imgCenterY;

      // 新位移应让锚点在缩放后依然处于原来的容器坐标
      // 公式推导：(anchor - center) * scaleFactor + newCenter = anchor
      // newCenter = anchor - (anchor - center) * scaleFactor
      // newPos = newCenter - defaultCenter
      const targetX = currentPos.x + vecX * (1 - scaleFactor);
      const targetY = currentPos.y + vecY * (1 - scaleFactor);

      // 5. 执行平滑变换动画
      // 激活滚轮缩放状态，用于禁用 CSS 过渡
      setIsWheeling(true);
      if (wheelTimeoutRef.current) clearTimeout(wheelTimeoutRef.current);
      wheelTimeoutRef.current = setTimeout(() => setIsWheeling(false), 350);

      // 使用 280ms 和五次方缓出曲线 (smooth)，提供类似于“原始尺寸”的高级质感但无回弹
      animateTransformTo(newScale, targetX, targetY, 280, 'smooth');
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
      container.removeEventListener('wheel', handleWheel);
      if (positionAnimRef.current) cancelAnimationFrame(positionAnimRef.current);
    };
    // isVideo 必须进依赖：滚轮命令按类型分派，闭包不能停留在挂载时的类型上
  }, [slideshowActive, isVideo]);

  // 幻灯片间隔驱动（图片/视频通用）。加入 file.id：每个条目获得完整间隔，
  // 配合下方视频「播完」事件实现 U5/R2：切换条件 = 播完 或 播满间隔，取二者较小。
  useEffect(() => {
    let intervalId: ReturnType<typeof setTimeout>;
    if (slideshowActive) {
      intervalId = setInterval(() => {
        onNext(slideshowConfig.isRandom);
      }, slideshowConfig.interval);
    }
    return () => clearInterval(intervalId);
  }, [slideshowActive, onNext, slideshowConfig, file.id]);

  // 视频进幻灯片：自动播放，并在「播完」时立即切换（U5/R2，§8）
  useEffect(() => {
    if (!isVideo || !slideshowActive) return;
    const v = videoRef.current;
    if (!v) return;
    const onEnded = () => onNextRef.current(slideshowConfig.isRandom);
    v.addEventListener('ended', onEnded);
    const p = v.play();
    if (p && typeof p.catch === 'function') {
      p.catch(() => {
        // 自动播放被策略拦截时退化为静音播放（幻灯片场景可接受）
        v.muted = true;
        v.play().catch(() => {});
      });
    }
    return () => {
      v.removeEventListener('ended', onEnded);
    };
  }, [isVideo, slideshowActive, file.id, slideshowConfig.isRandom]);

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) {
      await rootRef.current?.requestFullscreen();
      setIsFullscreen(true);
    } else {
      await document.exitFullscreen();
      setIsFullscreen(false);
    }
  };

  // ── 视频全屏：顶部工具栏与底部控制条自动隐藏 ──
  // 全屏时两条工具条改成浮层（absolute），画面占满整屏；显隐因此不改变容器尺寸，
  // 画面不会跟着跳。隐藏后任意鼠标移动即唤回；指针停在工具条上时不隐藏，
  // 否则进度条拖到一半条就消失了。
  const chromeOverlay = isFullscreen && isVideo && !slideshowActive;
  const [chromeHidden, setChromeHidden] = useState(false);
  const chromeIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const topBarRef = useRef<HTMLDivElement>(null);
  const bottomBarRef = useRef<HTMLDivElement>(null);
  // 最近一次鼠标位置：到点隐藏前用它判断指针是否正停在某条工具条上
  const pointerRef = useRef<{ x: number; y: number } | null>(null);

  const wakeChrome = useCallback(() => {
    setChromeHidden(false);
    if (chromeIdleTimerRef.current) clearTimeout(chromeIdleTimerRef.current);
    chromeIdleTimerRef.current = setTimeout(() => {
      const p = pointerRef.current;
      if (p) {
        const inside = (el: HTMLDivElement | null) => {
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom;
        };
        // 指针停在工具条上（含拖进度条、悬停音量弹窗）→ 这一轮不隐藏，
        // 也不重新计时：下一次鼠标移动会再来一轮
        if (inside(topBarRef.current) || inside(bottomBarRef.current)) return;
      }
      setChromeHidden(true);
    }, CHROME_IDLE_MS);
  }, []);

  // 唤回手段堆得比较满：window 与 document 两处、鼠标移动/指针/按下/滚轮/键盘/触摸/右键都听，
  // 且都在捕获阶段。事后看这一堆并不都是必需的（真凶是硬件视频层盖住 UI，见 §2），
  // 但多挂几类事件对「静止判定」本身有用：光听 mousemove 会漏掉只用键盘的人。
  useEffect(() => {
    if (!chromeOverlay) {
      setChromeHidden(false);
      return;
    }
    const wake = (e: Event) => {
      const p = e as MouseEvent;
      if (typeof p.clientX === 'number') pointerRef.current = { x: p.clientX, y: p.clientY };
      wakeChrome();
    };
    const targets: EventTarget[] = [window, document];
    const types = ['mousemove', 'pointermove', 'mousedown', 'wheel', 'keydown', 'touchstart', 'contextmenu', 'pointerover'];
    targets.forEach((t) => types.forEach((type) => t.addEventListener(type, wake, true)));
    wakeChrome();
    return () => {
      targets.forEach((t) => types.forEach((type) => t.removeEventListener(type, wake, true)));
      if (chromeIdleTimerRef.current) clearTimeout(chromeIdleTimerRef.current);
    };
  }, [chromeOverlay, wakeChrome]);

  // 卸载时收掉可能还挂着的静止计时
  useEffect(() => () => {
    if (chromeIdleTimerRef.current) clearTimeout(chromeIdleTimerRef.current);
  }, []);

  // 正在拖进度条、或右键菜单开着时，不隐藏
  const chromeGone = chromeOverlay && chromeHidden && !contextMenu.visible && !isVideoScrubbing;

  const immersivePrevLayoutRef = useRef<{ sidebar: boolean; metadata: boolean }>({ sidebar: false, metadata: false });

  const toggleImmersiveMode = () => {
    if (!isImmersiveModeRef.current) {
      immersivePrevLayoutRef.current = {
        sidebar: layout.isSidebarVisible,
        metadata: layout.isMetadataVisible,
      };

      const imgRect = imgRef.current?.getBoundingClientRect();
      if (imgRect) {
        setImmersiveFlip({
          oldCenterX: imgRect.left + imgRect.width / 2,
          oldCenterY: imgRect.top + imgRect.height / 2,
        });
      }

      setIsImmersiveMode(true);
      setRotation(0);

      document.documentElement.requestFullscreen({ navigationUI: 'hide' } as FullscreenOptions).catch(() => {
        rootRef.current?.requestFullscreen().catch(() => {});
      });
    } else {
      const imgRect = imgRef.current?.getBoundingClientRect();
      if (imgRect) {
        setImmersiveFlip({
          oldCenterX: imgRect.left + imgRect.width / 2,
          oldCenterY: imgRect.top + imgRect.height / 2,
        });
      }

      setIsImmersiveMode(false);

      if (immersivePrevLayoutRef.current.sidebar && !layout.isSidebarVisible) onLayoutToggle('sidebar');
      if (immersivePrevLayoutRef.current.metadata && !layout.isMetadataVisible) onLayoutToggle('metadata');

      if (document.fullscreenElement) {
        document.exitFullscreen().catch(() => {});
      }
    }
  };

  const toggleImmersiveModeRef = useRef(toggleImmersiveMode);
  useEffect(() => { toggleImmersiveModeRef.current = toggleImmersiveMode; });

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

  // 复制当前帧（§7.2）：把当前播放位置画面经 <video> → <canvas> 抓帧后写入剪贴板
  const handleCopyVideoFrame = async () => {
    try {
      const v = videoRef.current;
      if (!v || !v.videoWidth || !v.videoHeight) return;

      const canvas = document.createElement('canvas');
      canvas.width = v.videoWidth;
      canvas.height = v.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(v, 0, 0, canvas.width, canvas.height);

      const blob: Blob | null = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      if (!blob) {
        showFrameToast(t('video.frameCopyFailed'));
        return;
      }
      await navigator.clipboard.write([
        new ClipboardItem({ [blob.type]: blob })
      ]);
      showFrameToast(t('video.frameCopied'));
    } catch (err) {
      // 跨域视频会污染 canvas 导致 toBlob 抛 SecurityError（crossOrigin 修复后不应再发生，
      // 保留兜底）：给出可见失败提醒，不再静默
      console.error('Failed to copy video frame: ', err);
      showFrameToast(t('video.frameCopyFailed'));
    }
  };

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (showSearch && document.activeElement === searchInputRef.current) {
        if (e.key === 'Enter') handleSearchSubmit();
        return;
      }
      // 焦点在标签/描述/重命名等文本框里，或输入法正在组合：键位原样放行。
      // 否则打个 "film" 就会触发全屏与静音，字符本身还被 preventDefault 吞掉。
      if (e.isComposing || isTextEditingTarget(e.target)) return;

      // ── 视频键位（设计文档 §4，2026-10-16 定稿）──
      // 播放器口径：← → = 快退/快进 5s；上/下一个文件让给 Shift+← →（以及 [ ]）。
      // 带 Ctrl/Meta/Alt 的组合一律不属于这里（Ctrl+F 搜索由下方共用逻辑接手），
      // 否则 Ctrl+L 会变成前进 5s、Ctrl+M 会变成静音。
      if (isVideo && !e.ctrlKey && !e.metaKey && !e.altKey) {
        const v = videoRef.current;
        const duration = v && isFinite(v.duration) ? v.duration : 0;

        // 0-9：跳到全片 0%…90%
        if (/^[0-9]$/.test(e.key)) {
          e.preventDefault();
          if (v && duration > 0) v.currentTime = (duration * Number(e.key)) / 10;
          return;
        }

        switch (e.key) {
          case ' ':
          case 'Spacebar':
          case 'k':
          case 'K':
            e.preventDefault();
            if (v) { if (v.paused) v.play().catch(() => {}); else v.pause(); }
            return;
          case ',':
            e.preventDefault();
            videoStepFrame(-1);
            return;
          case '.':
            e.preventDefault();
            videoStepFrame(1);
            return;
          case 'j':
          case 'J':
            e.preventDefault();
            videoNudge(-5);
            return;
          case 'l':
          case 'L':
            e.preventDefault();
            videoNudge(5);
            return;
          case 'ArrowLeft':
            if (e.shiftKey) break; // Shift+← → 落到下方「上一个/下一个文件」
            e.preventDefault();
            videoNudge(-5);
            return;
          case 'ArrowRight':
            if (e.shiftKey) break;
            e.preventDefault();
            videoNudge(5);
            return;
          case '[':
            e.preventDefault();
            onPrevRef.current();
            return;
          case ']':
            e.preventDefault();
            onNextRef.current();
            return;
          case 'Home':
            e.preventDefault();
            if (v) v.currentTime = 0;
            return;
          case 'End':
            e.preventDefault();
            if (v && duration > 0) v.currentTime = duration;
            return;
          case '<':
            e.preventDefault();
            if (v) v.playbackRate = Math.max(0.25, Math.round((v.playbackRate - 0.25) * 100) / 100);
            return;
          case '>':
            e.preventDefault();
            if (v) v.playbackRate = Math.min(4, Math.round((v.playbackRate + 0.25) * 100) / 100);
            return;
          case 'ArrowUp':
            e.preventDefault();
            if (v) { v.muted = false; v.volume = Math.min(1, v.volume + 0.1); }
            return;
          case 'ArrowDown':
            e.preventDefault();
            if (v) { v.volume = Math.max(0, v.volume - 0.1); }
            return;
          case 'm':
          case 'M':
            e.preventDefault();
            if (v) v.muted = !v.muted;
            return;
          case 'f':
          case 'F':
            e.preventDefault();
            toggleFullscreen();
            return;
          default:
            break;
        }
        // Esc：全屏时先退全屏（§4「退出全屏优先于关闭」）
        if (e.key === 'Escape' && document.fullscreenElement) {
          document.exitFullscreen().catch(() => {});
          return;
        }
      }

      if (e.key === 'ArrowRight') onNextRef.current();
      if (e.key === 'ArrowLeft') onPrevRef.current();
      if (e.key === 'Escape') {
        if (isImmersiveModeRef.current) {
          return;
        }
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
  }, [onClose, onNavigateBack, canGoBack, slideshowActive, showSlideshowSettings, showSearch, localQuery, isVideo, file.meta?.frameRate]);

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
      toggleOriginalFit(e.clientX, e.clientY);
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
    if (isVideo) videoDragMovedRef.current = false;
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (slideshowActive) return;
    if (!isDragging) return;
    e.preventDefault();
    const dx = e.clientX - dragStart.x;
    const dy = e.clientY - dragStart.y;
    // 视频：超过阈值即视为拖拽平移，用于抑制尾随的 click（否则平移会顺带暂停）
    if (isVideo && Math.abs(dx) + Math.abs(dy) > 3) videoDragMovedRef.current = true;
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
      const margin = 10;

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
      // 同步全屏状态（Esc 退出全屏时也要更新，否则视频控制条/顶栏图标会残留）
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement) {
        if (slideshowActiveRef.current) {
          stopSlideshow();
        }
        if (isImmersiveModeRef.current) {
          setIsImmersiveMode(false);
        }
      }
    };
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  // Safety: ensure settings modal is closed whenever slideshow becomes active
  useEffect(() => { if (slideshowActive) setShowSlideshowSettings(false); }, [slideshowActive]);

  const rotate = (deg: number) => setRotation(r => r + deg);

  // 当前媒体元素（图片或视频），供缩放/平移类操作共用
  const getMediaEl = (): HTMLImageElement | HTMLVideoElement | null =>
    isVideo ? videoRef.current : imgRef.current;

  // 当前媒体自然尺寸（图片 naturalWidth/Height；视频 videoWidth/Height）
  const getMediaNaturalSize = (): { w: number; h: number } | null => {
    if (isVideo) {
      const v = videoRef.current;
      return v && v.videoWidth && v.videoHeight ? { w: v.videoWidth, h: v.videoHeight } : null;
    }
    const img = imgRef.current;
    return img && img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null;
  };

  const handleReset = () => {
    // animate to fit-window (scale=1, center)
    animateTransformTo(1, 0, 0, 260);
    setRotation(0);
  };

  const handleFitWindow = () => handleReset();

  // 原始尺寸：图片 = 1:1 像素；视频语义为「1:1 播放」（同一条数学路径，§7.2）
  const handleOriginalSize = () => {
    if (!containerRef.current) return;
    const size = getMediaNaturalSize();
    if (!size) return;
    const { width: containerWidth, height: containerHeight } = containerRef.current.getBoundingClientRect();

    const scaleX = containerWidth / size.w;
    const scaleY = containerHeight / size.h;
    const fitScale = Math.min(scaleX, scaleY);

    // Calculate new scale. 
    // If fitScale < 1 (media larger than window), we scale UP by 1/fitScale to reach 1.0 (original size).
    // If fitScale > 1 (media smaller than window), we scale DOWN.
    const newScale = 1 / fitScale;

    animateTransformTo(newScale, 0, 0, 320);
  };

  // Toggle between fit-window (scale ~= 1) and original-size (scale = 1/fitScale).
  const toggleOriginalFit = (clientX?: number, clientY?: number) => {
    if (!containerRef.current) return;
    const mediaEl = getMediaEl();
    const size = getMediaNaturalSize();
    if (!mediaEl || !size) return;
    const containerRect = containerRef.current.getBoundingClientRect();
    const { width: containerWidth, height: containerHeight } = containerRect;

    const scaleX = containerWidth / size.w;
    const scaleY = containerHeight / size.h;
    const fitScale = Math.min(scaleX, scaleY);
    const originalScale = 1 / fitScale;

    const current = scaleRef.current;
    // if currently close to original, go to fit; otherwise go to original
    const toOriginal = Math.abs(current - originalScale) > Math.abs(current - 1);

    if (toOriginal) {
      // 检测鼠标是否在媒体内容内
      const mediaRect = mediaEl.getBoundingClientRect();
      const isMouseInImage =
        clientX !== undefined && clientY !== undefined &&
        clientX >= mediaRect.left &&
        clientX <= mediaRect.right &&
        clientY >= mediaRect.top &&
        clientY <= mediaRect.bottom;

      if (isMouseInImage && clientX !== undefined && clientY !== undefined) {
        // 鼠标在媒体内：以鼠标位置为中心
        // 将鼠标位置转换为相对于容器中心的向量
        const centerX = containerWidth / 2;
        const centerY = containerHeight / 2;
        const dx = clientX - (containerRect.left + centerX);
        const dy = clientY - (containerRect.top + centerY);

        // 计算目标位移，使缩放时鼠标位置下的内容保持不变
        // 公式：targetPos = mouseOffset * (1 - originalScale)
        const targetX = dx * (1 - originalScale);
        const targetY = dy * (1 - originalScale);
        animateTransformTo(originalScale, targetX, targetY, 360);
      } else {
        // 鼠标在媒体外或没有鼠标位置信息：保持原逻辑（居中）
        animateTransformTo(originalScale, 0, 0, 360);
      }
    } else {
      animateTransformTo(1, 0, 0, 260);
    }
  };

  // 点击视频画面 = 播放/暂停切换（U2）；拖拽平移之后抑制尾随 click
  const handleVideoSurfaceClick = () => {
    const v = videoRef.current;
    if (!v) return;
    if (videoDragMovedRef.current) {
      videoDragMovedRef.current = false;
      return;
    }
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };

  // 视频键位专用的 ±5s / 逐帧（与 VideoControls 共用同一 video 元素）
  const videoNudge = (delta: number) => {
    const v = videoRef.current;
    if (!v) return;
    const max = isFinite(v.duration) ? v.duration : v.currentTime + Math.abs(delta);
    v.currentTime = Math.max(0, Math.min(v.currentTime + delta, max));
  };
  const videoStepFrame = (dir: 1 | -1) => {
    const v = videoRef.current;
    const fps = file.meta?.frameRate;
    if (!v || typeof fps !== 'number' || fps <= 0) return;
    v.pause();
    const next = v.currentTime + dir / fps;
    const max = isFinite(v.duration) ? v.duration : next;
    v.currentTime = Math.max(0, Math.min(next, max));
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
      className={`flex flex-col h-full select-none overflow-hidden transition-colors duration-300 ${isImmersiveMode ? 'fixed inset-0 z-[300]' : 'relative flex-1'} ${slideshowActive || isImmersiveMode || chromeOverlay ? 'bg-black' : 'bg-white dark:bg-[#262626]'} ${chromeGone ? 'cursor-none' : ''} ${chromeOverlay ? 'dark' : ''}`}
      onClick={(e) => {
        setContextMenu({ ...contextMenu, visible: false });
        setIsColorPickerOpen(false);
      }}
    >
      {/* Preloading handled in useEffect now */}

      {/* 复制帧结果提醒（指挥官 2026-10-14 要求）：成功/失败均有可见反馈。
          fixed 定位保证沉浸模式（z-[300]）下也在最上层。 */}
      {frameToast.visible && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[400] bg-black/80 text-white text-sm px-4 py-2 rounded-full shadow-lg backdrop-blur-sm animate-toast-up pointer-events-none">
          {frameToast.msg}
        </div>
      )}


      <div
        ref={topBarRef}
        className={`h-14 flex items-center px-4 justify-between shrink-0 transition-all duration-300 ${
          chromeOverlay
            // 全屏：条子本身也是黑的（与画面同色），文字/图标走 dark 变体 —— 根节点已挂 .dark
            ? `bg-black absolute inset-x-0 z-[45] ${chromeGone ? 'top-[-3.5rem] opacity-0 pointer-events-none' : 'top-0'}`
            : `bg-white dark:bg-[#262626] z-20 ${slideshowActive || isImmersiveMode ? '-translate-y-full absolute w-full top-0 opacity-0 pointer-events-none' : ''}`
        }`}
      >

        {/* 全屏视频：侧栏/信息面板的展开按钮与前进后退都没意义（面板本身不在屏上），整组不渲染 */}
        {!chromeOverlay && (
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
        )}

        <div className="flex-1 text-center truncate px-4 font-medium text-gray-800 dark:text-gray-200 flex justify-center items-center">
          {showSearch ? (
            <div className="relative w-full max-w-[672px] animate-fade-in" onClick={(e) => e.stopPropagation()}>
              <div className={`flex items-center bg-gray-100 dark:bg-[#3a3a3a] rounded-full px-3 py-1.5 transition-all border ${isColorSearchQuery
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
                    <ChevronDown size={12} className="ml-1 opacity-70" />
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
                      title={t('search.byColor')}
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

          <>
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
          </>

          {!chromeOverlay && (
          <button
            onClick={() => onLayoutToggle('metadata')}
            className={`p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${layout.isMetadataVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
            title={t('viewer.toggleMeta')}
          >
            <PanelRight size={18} />
          </button>
          )}
        </div>
      </div>

      <div
        ref={containerRef}
        className={`flex-1 overflow-hidden relative transition-colors ${
          chromeOverlay
            // 视频全屏：一进全屏就是纯黑底，不跟随工具条显隐（因此这里不需要颜色过渡）
            ? 'bg-black duration-0'
            : `${slideshowActive ? 'bg-black cursor-none' : isImmersiveMode ? 'bg-black' : 'bg-white dark:bg-[#262626]'} duration-300`
        } ${!slideshowActive && !isVideo ? 'cursor-grab active:cursor-grabbing' : ''}`}
        style={{
          ...(slideshowActive ? { cursor: 'none' } : {}),
        }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        // 点击视频画面 = 播放/暂停切换（U2，§3；与图片只有拖拽/缩放区分）
        onClick={isVideo && !slideshowActive ? handleVideoSurfaceClick : undefined}
        onContextMenu={handleContextMenu}
      >
        {/* 只有在完全没有图片时才显示加载指示器（视频由 <video> 自身加载） */}
        {!isVideo && !displayUrl && (
          <div className="absolute inset-0 flex items-center justify-center z-0">
            <Loader2 className="animate-spin text-gray-400 dark:text-gray-600" size={48} />
          </div>
        )}

        {/* 单图层渲染 - 简洁高效（普通模式） */}
        {/* 幻灯片模式下使用双图层实现过渡效果 */}
        <div className="w-full h-full flex items-center justify-center pointer-events-none relative overflow-hidden">
          {/* 视频渲染层：统一容器内按类型分派（§1.1） */}
          {isVideo && (
            <video
              ref={videoRef}
              key={file.id}
              src={videoSrc || undefined}
              // 视频 P1.5 修复：必须以 CORS 模式加载，否则 <video> 会把 canvas 标记为 tainted，
              // drawImage 后 toBlob/toDataURL 直接抛 SecurityError
              // ——「复制当前帧」此前因此一直静默失败（指挥官 2026-10-14 实测报错原文：
              // "Failed to execute 'toBlob' on 'HTMLCanvasElement': Tainted canvases may not be exported"）。
              // 安全性已核实：Tauri 2.11.6 的 asset 协议对每个响应都写
              // `Access-Control-Allow-Origin: <window_origin>`（src/protocol/asset.rs:39），
              // Windows 上 window_origin = http://tauri.localhost，与页面自身源精确吻合；
              // LAN 源走 tower_http 的 CorsLayer::allow_origin(Any) 给的是 `*`。
              // ——两边都允许 anonymous 模式，不影响播放，只是请求改成 CORS 模式。
              crossOrigin="anonymous"
              className="max-w-none absolute inset-0 m-auto"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                // 与图片同一底色：信箱区透出容器主题色（bg-white / dark:#262626），
                // 幻灯片与沉浸模式容器本身是 bg-black，因此仍为黑。
                background: 'transparent',
                transformOrigin: 'center center',
                // 外层媒体包裹是 pointer-events-none，这里必须显式打开（否则视频自身收不到
                // 事件）；点击/滚轮/拖拽的处理挂在容器上，靠冒泡接住。
                pointerEvents: 'auto',
                // 影院态下强制取消硬件视频 overlay（真因见 docs/视频播放UI设计.md §2）：
                // overlay 平面直接扫出、压在 UI 层之上，16:9 视频铺满整屏时把上下两条
                // 工具栏整个盖住 —— CSS 侧量出来 op=1 / vis=visible / z=45 全对，就是看不见。
                // 实测否掉的两条路：pointerEvents:none（事件本来就正常派发，与病无关）、
                // opacity<1（D3D overlay 支持 alpha，取不到资格）。filter 要走独立渲染通道，
                // Blink 便不再把它当 overlay 候选；亮度 1.0001 肉眼不可见。
                filter: chromeOverlay ? 'brightness(1.0001)' : 'none',
                zIndex: 2,
                // 复用图片的变换状态：支持滚轮/拖拽平移与 1:1 缩放（§7.2 原始尺寸/适应窗口）
                transform: `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
              }}
              playsInline
              preload="metadata"
              draggable={false}
              onError={(e) => {
                // 2026-10-22：转封装兜底已移除 —— 播不出来就是播不出来，直接出提示卡
                //（提示卡里给「用外部播放器打开」，用户总有一条能看到画面的路）。
                setVideoErrorCode(e.currentTarget.error?.code ?? 0);
              }}
            />
          )}

          {/* 图片渲染层：既有 <img> 管线保持不变 */}
          {!isVideo && (
          <>
          {/* 幻灯片过渡：前一张图片（淡出/滑出） */}
          {slideshowActive && prevDisplayUrl && (
            <img
              key={`prev-${prevDisplayUrl}`}
              src={prevDisplayUrl}
              alt=""
              className={`max-w-none absolute inset-0 m-auto ${slideshowConfig.transition === 'fade'
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

          {/* LAN 缩略图图层：原图下载期间显示 256px 缩略图，原图就绪后渐变替换 */}
          {!slideshowActive && lanThumbUrl && (
            <img
              key={`lan-thumb-${lanThumbUrl}`}
              src={lanThumbUrl}
              alt=""
              className="max-w-none absolute inset-0 m-auto"
              loading="eager"
              decoding="async"
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'contain',
                pointerEvents: 'none',
                zIndex: 1,
              }}
              draggable={false}
            />
          )}

          <img
            ref={imgRef}
            key={slideshowActive && slideshowConfig.transition !== 'none' ? `current-${displayUrl}` : 'main'}
            src={displayUrl || 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'}
            alt={file.name}
            className={`max-w-none absolute inset-0 m-auto ${slideshowActive && slideshowConfig.enableZoom && !isTransitioning ? 'animate-ken-burns' : ''
              } ${slideshowActive && isTransitioning && slideshowConfig.transition === 'fade'
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
              objectFit: 'contain' as const,
              ...(!slideshowActive || slideshowConfig.transition === 'none' || !isTransitioning ? {
                transform: slideshowActive && slideshowConfig.enableZoom
                  ? undefined
                  : `translate(${position.x}px, ${position.y}px) rotate(${rotation}deg) scale(${scale})`,
                transition: lanThumbUrl
                  ? ((isDragging || isWheeling || isFlipAnimating) ? 'opacity 0.4s ease' : 'transform 0.1s linear, opacity 0.4s ease')
                  : ((isDragging || isWheeling || isFlipAnimating) ? 'none' : 'transform 0.1s linear'),
              } : {}),
              transformOrigin: 'center center',
              pointerEvents: slideshowActive ? 'none' : 'auto',
              zIndex: 2,
              opacity: lanFadeIn ? 0 : 1,
              ...filterStyle
            }}
            draggable={false}
          />
          </>
          )}
        </div>

        {/* 视频缓冲/seek 等待遮罩：1MB 分片上限使大文件 seek 有等待，必须给反馈（§3）；
            拖拽进度条中（未 seek）不显示，避免拖拽期闪烁；加载失败时不显示（改出错误卡） */}
        {isVideo && isVideoBuffering && !isVideoScrubbing && videoErrorCode === null && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[3]">
            <div className="p-3 rounded-full bg-black/40">
              <Loader2 className="animate-spin text-white/90" size={36} />
            </div>
          </div>
        )}

        {/* 不可播 / 播放失败提示（2026-10-22 改口径）：
            ① 容器不在可解清单（avi/wmv/flv/…）→ 直接占位符，不再转封装；
            ② 可解容器但直播报错 → SRC_NOT_SUPPORTED(4) 与其它错误分开文案。
            两种情况都给「用系统播放器打开」兜底。 */}
        {isVideo && (videoUnsupported || videoErrorCode !== null) && (
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[3]">
            <div className="px-5 py-4 rounded-xl bg-black/70 text-white flex flex-col items-center text-center max-w-md mx-4 pointer-events-auto">
              <AlertTriangle size={28} className="mb-2 text-amber-400" />
              <div className="text-sm font-medium">
                {videoUnsupported || videoErrorCode === 4
                  ? t('video.cannotPlay')
                  : t('video.cannotPlayFailed')}
              </div>
              <div className="text-xs text-white/70 mt-1">
                {videoUnsupported || videoErrorCode === 4
                  ? t('video.cannotPlayHint')
                  : t('video.cannotPlayFailedHint')}
              </div>
              {/* D5 兜底：无论哪种原因，用户总有一条能真正看到视频的路 */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  // ⚠️ openPath(path, true) 是「在文件管理器中选中」（只跳文件夹），
                  //    这里要的是交给系统默认程序播放
                  if (file.path) openWithDefaultApp(file.path).catch(() => {});
                }}
                className="mt-3 px-3 py-1.5 text-xs rounded-lg bg-white/15 hover:bg-white/25 transition-colors flex items-center gap-1.5"
              >
                <ExternalLink size={14} />
                {t('video.openExternalPlayer')}
              </button>
            </div>
          </div>
        )}

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

      {/* 视频控制条：仅视频时显示，图片时隐藏（§1.1：只有底部控制条随类型切换，容器不卸载）。
          全屏时这层壳把它变成浮层，与顶部工具栏一起随静止计时显隐。
          （2026-10-22：容器不可播时一并隐藏 —— 没有 src，留一条空进度条只会误导。） */}
      {isVideo && !videoUnsupported && !slideshowActive && (
        <div
          ref={bottomBarRef}
          className={
            chromeOverlay
              ? `absolute inset-x-0 z-[45] transition-all duration-300 ${chromeGone ? 'bottom-[-3rem] opacity-0 pointer-events-none' : 'bottom-0'}`
              : 'shrink-0'
          }
        >
          <VideoControls
            key={file.id}
            videoRef={videoRef}
            file={file}
            isFullscreen={isFullscreen}
            onToggleFullscreen={toggleFullscreen}
            t={t}
            onScrubbingChange={handleVideoScrubbingChange}
          />
        </div>
      )}

      {contextMenu.visible && (() => {
        const menuItemClass = 'mx-2 px-4 py-2 rounded hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center';
        const iconSize = 14;
        const deleteItemClass = 'mx-2 px-4 py-2 rounded hover:bg-red-600 dark:hover:bg-red-700 hover:text-white text-red-500 dark:text-red-400 cursor-pointer flex items-center';
        const purpleItemClass = 'mx-2 px-4 py-2 rounded hover:bg-purple-600 dark:hover:bg-purple-700 hover:text-white cursor-pointer flex items-center';
        const closeMenu = () => setContextMenu({ ...contextMenu, visible: false });

        return (
        <div
          data-testid="viewer-context-menu"
          className="fixed bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md rounded-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-sm py-1 text-gray-800 dark:text-gray-200 min-w-[220px] z-[60] max-h-[80vh] overflow-y-auto animate-zoom-in"
          style={{
            top: menuPos.top,
            left: menuPos.left,
            position: 'fixed',
            zIndex: 60,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* 原始尺寸 / 适应窗口：视频语义为 1:1 播放 / 适应窗口（§7.2） */}
          <div className={menuItemClass} onClick={() => { handleOriginalSize(); closeMenu(); }}>
            <Maximize size={iconSize} className="mr-2 opacity-70" /> {isVideo ? t('video.original') : t('viewer.original')}
          </div>
          <div className={menuItemClass} onClick={() => { handleFitWindow(); closeMenu(); }}>
            <Minimize size={iconSize} className="mr-2 opacity-70" /> {isVideo ? t('video.fit') : t('viewer.fit')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

          <div className={menuItemClass} onClick={() => { onViewInExplorer(file.id); closeMenu(); }}>
            <ExternalLink size={iconSize} className="mr-2 opacity-70" /> {t('context.viewInExplorer')}
          </div>
          {(() => {
            const parentId = file.parentId;
            const isUnavailable = activeTab.viewMode === 'browser' && activeTab.folderId === parentId;
            if (isUnavailable) return null;
            const cls = 'mx-2 px-4 py-2 rounded hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center';
            return (
              <>
                <div
                  className={cls}
                  onClick={() => {
                    if (parentId) {
                      onNavigateToFolder(parentId, { targetId: file.id });
                      closeMenu();
                    }
                  }}
                >
                  <FolderOpen size={iconSize} className="mr-2 opacity-70" />
                  {t('context.openFolder')}
                </div>
                <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>
              </>
            );
          })()}

          <div className={menuItemClass} onClick={() => { onEditTags(); closeMenu(); }}>
            <Tag size={iconSize} className="mr-2 opacity-70" /> {t('context.editTags')}
          </div>

          <div className={menuItemClass} onClick={() => { onCopyTags(); closeMenu(); }}>
            <Tag size={iconSize} className="mr-2 opacity-70" /> {t('context.copyTag')}
          </div>
          <div className={menuItemClass} onClick={() => { onPasteTags(file.id); closeMenu(); }}>
            <Tag size={iconSize} className="mr-2 opacity-70" /> {t('context.pasteTag')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

          {/* 复制图片 / 复制当前帧：视频改为抓取当前播放位置的画面（§7.2） */}
          <div className={menuItemClass} onClick={() => { isVideo ? handleCopyVideoFrame() : handleCopyImage(); closeMenu(); }}>
            <Clipboard size={iconSize} className="mr-2 opacity-70" /> {isVideo ? t('video.copyFrame') : t('context.copyImage')}
          </div>

          <div className={menuItemClass} onClick={() => { onCopyToFolder(file.id); closeMenu(); }}>
            <Copy size={iconSize} className="mr-2 opacity-70" /> {t('context.copyTo')}
          </div>
          <div className={menuItemClass} onClick={() => { onMoveToFolder(file.id); closeMenu(); }}>
            <Move size={iconSize} className="mr-2 opacity-70" /> {t('context.moveTo')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

          {/* AI 分析：视频不跑 AI（B3 / §7.2 必须补类型门禁，旧实现只看连接状态会误显示） */}
          {!isVideo && (
            <div className={purpleItemClass} onClick={() => { onAIAnalysis(file.id); closeMenu(); }}>
              <Sliders size={iconSize} className="mr-2 opacity-70" /> {t('context.aiAnalyze')}
            </div>
          )}

          {/* 图片对比菜单项 - 仅当有图片对比标签页时显示；用枚举判定（§7.5：旧实现用字符串 'image'，视频进来易漏） */}
          {hasCompareTabs && handleOpenCompareInNewTab && handleAddToCompareCanvas && file.type === FileType.IMAGE && (() => {
            const imageIds = [file.id];
            const canCompare = imageIds.length >= 1 && imageIds.length <= 24;
            const compareCls = 'mx-2 px-4 py-2 rounded hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center';
            const itemClass = canCompare
              ? compareCls
              : 'px-4 py-2 flex items-center text-gray-400 cursor-default opacity-60';

            return (
              <>
                <div
                  className={itemClass}
                  onMouseEnter={openCompareSubmenu}
                  onMouseLeave={closeCompareSubmenu}
                  ref={compareMenuItemRef}
                >
                  <Scan size={iconSize} className="mr-2 opacity-70" />
                  <div className="flex-1">{t('context.compareImages')}</div>
                  <ChevronRight size={iconSize} className="ml-2 opacity-70" />
                </div>
                {/* 二级菜单 - 使用 Portal 渲染到 body 避免被父容器裁剪 */}
                {compareSubmenuOpen && createPortal(
                  <div
                    className="fixed bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md rounded-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-sm py-2 min-w-[200px] z-[9999]"
                    style={{ left: submenuPosition.x, top: submenuPosition.y }}
                    onMouseEnter={openCompareSubmenu}
                    onMouseLeave={closeCompareSubmenu}
                  >
                    {/* 现有画布列表 */}
                    {compareTabs.map(tab => {
                      const currentCount = tab.selectedFileIds.length;
                      const maxCount = 24;
                      const remainingSpace = maxCount - currentCount;
                      const canAdd = remainingSpace > 0 && imageIds.length <= remainingSpace;
                      const canvasName = tab.sessionName || `画布${tab.id.slice(0, 4)}`;
                      const subCls = 'mx-2 px-4 py-2 rounded hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer flex items-center justify-between';

                      return (
                        <div
                          key={tab.id}
                          className={canAdd
                            ? subCls
                            : 'px-4 py-2 flex items-center justify-between text-gray-400 cursor-default opacity-60'
                          }
                          onClick={canAdd ? () => {
                            handleAddToCompareCanvas(tab.id, imageIds);
                            closeMenu();
                            setCompareSubmenuOpen(false);
                          } : undefined}
                        >
                          <span className="truncate max-w-[120px]">{t('context.addToCanvas').replace('{name}', canvasName)}</span>
                          <span className="text-xs ml-2">{`${currentCount}/${maxCount}`}</span>
                        </div>
                      );
                    })}
                  </div>,
                  document.body
                )}
              </>
            );
          })()}

          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

          <div
            className={menuItemClass}
            onClick={() => { setShowSlideshowSettings(true); closeMenu(); }}
          >
            <Settings size={iconSize} className="mr-2 opacity-70" />
            {t('context.slideshowSettings')}
          </div>
          <div
            className={menuItemClass}
            onClick={toggleSlideshow}
          >
            {slideshowActive ? <Square size={iconSize} className="mr-2" /> : <Play size={iconSize} className="mr-2" />}
            {slideshowActive ? t('context.stopSlideshow') : t('context.startSlideshow')}
          </div>

          <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>

          <div className={deleteItemClass} onClick={() => { onDelete(file.id); closeMenu(); }}>
            <Trash2 size={iconSize} className="mr-2 opacity-70" /> {t('context.delete')}
          </div>
        </div>
        );
      })()}

      {scopeMenuOpen && (
        <>
          <div className="fixed inset-0 z-[60]" onClick={(e) => { e.stopPropagation(); setScopeMenuOpen(false); }}></div>
          <div
            className="fixed bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] z-[61] overflow-hidden py-2 text-left w-36 animate-fade-in"
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
                <opt.icon size={14} className="mr-2" /> {opt.label}
              </button>
            ))}
          </div>
        </>
      )}

      {showSlideshowSettings && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center">
          <div className="bg-white dark:bg-[#3a3a3a] border border-gray-200 dark:border-gray-700 rounded-lg w-80 shadow-[0_12px_40px_rgba(0,0,0,0.15)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.7)] p-4 animate-zoom-in" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-4 border-b border-gray-200 dark:border-gray-800 pb-2">
              <h3 className="font-bold text-gray-800 dark:text-gray-200 flex items-center"><Sliders size={16} className="mr-2" /> {t('context.slideshowSettings')}</h3>
              <button onClick={() => setShowSlideshowSettings(false)} className="text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white"><X size={18} /></button>
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
                <Play size={12} className="mr-1" /> {t('context.startSlideshow')}
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
