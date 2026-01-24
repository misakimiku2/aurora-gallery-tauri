
import React, { useState, useMemo, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { LayoutMode, FileNode, FileType, TabState, Person, GroupByOption, FileGroup } from '../types';
import { getFolderPreviewImages, formatSize } from '../utils/mockFileSystem';
import { Image as ImageIcon, Check, Folder, Tag, User, ChevronDown, Book, Film } from 'lucide-react';
import md5 from 'md5';
import { startDragToExternal } from '../api/tauri-bridge';
import { isTauriEnvironment } from '../utils/environment';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useLayout, LayoutItem } from './useLayoutHook';
import { PersonGrid } from './PersonGrid';
import { performanceMonitor } from '../utils/performanceMonitor';

// 扩展 Window 接口以包含我们的全局缓存
declare global {
  interface Window {
    __AURORA_THUMBNAIL_CACHE__?: LRUCache<string>;
    __AURORA_THUMBNAIL_PATH_CACHE__?: LRUCache<string>; // 缩略图原始文件路径缓存（用于外部拖拽�?
  }
}

// LRU缓存类，带大小限�?
class LRUCache<T> {
  private cache: Map<string, { value: T; timestamp: number }>;
  private maxSize: number;

  constructor(maxSize: number) {
    this.cache = new Map();
    this.maxSize = maxSize;
  }

  get(key: string): T | undefined {
    const item = this.cache.get(key);
    if (item) {
      // 更新访问时间
      this.cache.set(key, { ...item, timestamp: Date.now() });
      return item.value;
    }
    return undefined;
  }

  set(key: string, value: T): void {
    // 检查是否超过最大容�?
    if (this.cache.size >= this.maxSize) {
      // 找出最久未使用的项
      let oldestKey: string | undefined;
      let oldestTimestamp = Date.now() + 1;

      for (const [k, v] of this.cache.entries()) {
        if (v.timestamp < oldestTimestamp) {
          oldestTimestamp = v.timestamp;
          oldestKey = k;
        }
      }

      // 删除最久未使用的项
      if (oldestKey) {
        this.cache.delete(oldestKey);
      }
    }

    this.cache.set(key, { value, timestamp: Date.now() });
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

// 获取或初始化全局缓存 (挂载�?window 上以防热更新丢失)
const getGlobalCache = () => {
  if (!window.__AURORA_THUMBNAIL_CACHE__) {
    // 限制缓存大小�?000个项目，�?0-100MB内存
    window.__AURORA_THUMBNAIL_CACHE__ = new LRUCache<string>(1000);
  }
  return window.__AURORA_THUMBNAIL_CACHE__;
};

// 获取缩略图原始路径缓存（用于外部拖拽时作为图标）
const getThumbnailPathCache = () => {
  if (!window.__AURORA_THUMBNAIL_PATH_CACHE__) {
    window.__AURORA_THUMBNAIL_PATH_CACHE__ = new LRUCache<string>(1000);
  }
  return window.__AURORA_THUMBNAIL_PATH_CACHE__;
};

// --- Folder 3D Icon Component ---
export const Folder3DIcon = ({ previewSrcs, count, category = 'general', className = "", onImageError }: { previewSrcs?: string[], count?: number, category?: string, className?: string, onImageError?: (index: number) => void }) => {
    const styles: any = {
        general: { back: 'text-blue-600 dark:text-blue-500', front: 'text-blue-400 dark:text-blue-400' },
        book: { back: 'text-amber-600 dark:text-amber-500', front: 'text-amber-400 dark:text-amber-400' },
        sequence: { back: 'text-purple-600 dark:text-purple-500', front: 'text-purple-400 dark:text-purple-400' },
    };
    const style = styles[category] || styles.general;
    
    const Icon = category === 'book' ? Book : (category === 'sequence' ? Film : Folder);

    // Use whatever valid URLs are passed (base64 or asset://)
    const images = (previewSrcs || []).filter(src => !!src);
    
    return (
        <div className={`relative w-full h-full group select-none flex items-center justify-center ${className}`}>
            {/* Square container to maintain aspect ratio */}
            <div className="relative w-full aspect-square">
                {/* Back Plate */}
                <svg viewBox="0 0 100 100" className={`absolute w-full h-full drop-shadow-sm transition-colors ${style.back}`} preserveAspectRatio="none">
                    <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" fill="currentColor" />
                </svg>

                {/* Preview Images */}
                <div className="absolute left-[15%] right-[15%] top-[20%] bottom-[20%] z-10 transition-transform duration-300 group-hover:-translate-y-3 group-hover:scale-105">
                    {images[2] && (
                        <div className="absolute inset-0 bg-white shadow-md z-0 border-[2px] border-white rounded-sm overflow-hidden transform rotate-6 translate-x-2 -translate-y-3 scale-90 opacity-80">
                            <img 
                                src={images[2]} 
                                className="w-full h-full object-cover" 
                                loading="lazy" 
                                draggable="false"
                                onError={() => onImageError?.(2)}
                            />
                        </div>
                    )}
                    {images[1] && (
                        <div className="absolute inset-0 bg-white shadow-md z-10 border-[2px] border-white rounded-sm overflow-hidden transform -rotate-3 -translate-x-1 -translate-y-1.5 scale-95">
                            <img 
                                src={images[1]} 
                                className="w-full h-full object-cover" 
                                loading="lazy" 
                                draggable="false"
                                onError={() => onImageError?.(1)}
                            />
                        </div>
                    )}
                    {images[0] && (
                        <div className="absolute inset-0 bg-white shadow-md z-20 border-[2px] border-white rounded-sm overflow-hidden transform rotate-0 scale-100">
                            <img 
                                src={images[0]} 
                                className="w-full h-full object-cover" 
                                loading="lazy" 
                                draggable="false"
                                onError={() => onImageError?.(0)}
                            />
                        </div>
                    )}
                </div>

                {/* Front Plate */}
                <div 
                    className="absolute left-0 right-0 bottom-0 h-[60%] z-20 transition-transform duration-300 origin-bottom"
                    style={{ transform: 'perspective(800px) rotateX(-10deg)' }}
                >
                    <svg viewBox="0 0 100 65" className={`w-full h-full drop-shadow-lg ${style.front}`} preserveAspectRatio="none">
                        <path d="M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z" fill="currentColor" />
                    </svg>
                    
                    <div className="absolute inset-0 flex items-center justify-center opacity-50 mix-blend-overlay">
                        <Icon size={32} className="text-white" strokeWidth={1.5} />
                    </div>
                    
                    {count !== undefined && (
                        <div className="absolute bottom-2 right-3 bg-black/20 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full backdrop-blur-sm shadow-sm">
                            {count}
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const useInView = (options: IntersectionObserverInit = {}) => {
  const [isInView, setIsInView] = useState(false); // Default to false to avoid initial load spike
  const [wasInView, setWasInView] = useState(false); // Track if it was ever in view
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      setWasInView(true);
      return;
    }

    // More efficient observer with larger rootMargin to prevent flickering
    const observer = new IntersectionObserver(([entry]) => {
      const intersecting = entry.isIntersecting;
      setIsInView(intersecting);
      // If it was once in view, keep it marked as wasInView
      if (intersecting) {
        setWasInView(true);
      }
    }, {
      rootMargin: '300px', // Larger root margin to prevent flickering when scrolling
      threshold: 0.01,     // Lower threshold for more sensitivity
      ...options
    });

    const currentRef = ref.current;
    if (currentRef) {
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        observer.unobserve(currentRef);
      }
      observer.disconnect();
    };
  }, [options]);

  // Return wasInView as well to track if it was ever loaded
  return [ref, isInView, wasInView] as const;
};

const sortKeys = (keys: string[]) => keys.sort((a, b) => {
    if (a === '0-9') return -1; if (b === '0-9') return 1;
    if (a === '#') return 1; if (b === '#') return -1;
    return a.localeCompare(b);
});

export const ImageThumbnail = React.memo(({ src, alt, isSelected, filePath, modified, size, isHovering, fileMeta, resourceRoot, cachePath }: { 
  src: string; 
  alt: string; 
  isSelected: boolean;
  filePath?: string;
  modified?: string;
  size?: number;
  isHovering?: boolean;
  fileMeta?: { format?: string };
  resourceRoot?: string;
  cachePath?: string;
}) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '100px' }); 
  
  // 初始化时尝试从全局缓存读取
  // 简�?Key: 只使�?filePath，提高命中率。文件修改后 getThumbnail 仍会更新图片�?
  const [thumbnailSrc, setThumbnailSrc] = React.useState<string | null>(() => {
      if (!filePath) return null;
      // const key = `${filePath}|${modified || ''}`; 
      const key = filePath; 
      const cache = getGlobalCache();
      return cache.get(key) || null;
  });
  
  const [animSrc, setAnimSrc] = React.useState<string | null>(null);
  // 如果有缓存，初始 loading �?false
  const [loading, setLoading] = React.useState(!thumbnailSrc);

  const hitRecordedRef = useRef(false);
  const missRecordedRef = useRef(false);

  // 如果初始就有 thumbnailSrc（来自缓存），在 mount 时也计为 hit
  React.useEffect(() => {
    if (thumbnailSrc && !hitRecordedRef.current) {
      performanceMonitor.increment('thumbnailCacheHit');
      hitRecordedRef.current = true;
    }
  }, [thumbnailSrc]);

  React.useEffect(() => {
    // Only load thumbnail if the component is in view or was previously in view
    if ((isInView || wasInView) && filePath && resourceRoot) {
      const cache = getGlobalCache();
      const key = filePath; // 保持 Key 一�?

      // 如果已经有图了（比如从缓存中读到的），且 URL 没变，就不用重新加载
      if (thumbnailSrc && cache.get(key) === thumbnailSrc) {
          // 缓存命中，直接返回，避免不必要的请求
          if (!hitRecordedRef.current) {
              performanceMonitor.increment('thumbnailCacheHit');
              hitRecordedRef.current = true;
          }
          return;
      }

      const controller = new AbortController();
      const loadThumbnail = async () => {
        // 只有当没有当前数据时才显�?loading
        if (!thumbnailSrc) setLoading(true);
        
        try {
          const { getThumbnail } = await import('../api/tauri-bridge');


          const thumbnail = await getThumbnail(filePath, modified, resourceRoot, controller.signal);
          
          if (!controller.signal.aborted && thumbnail) {
            // 更新全局缓存
            if (cache.get(key) !== thumbnail) {
                cache.set(key, thumbnail);
                setThumbnailSrc(thumbnail);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error('Failed to load thumbnail:', error);
          }
        } finally {
          if (!controller.signal.aborted) {
            setLoading(false);
          }
        }
      };

      loadThumbnail();

      return () => {
        controller.abort();
      };
    }
  }, [filePath, modified, resourceRoot, isInView, wasInView]);



  React.useEffect(() => {
    let isMounted = true;

    const loadAnimation = async () => {
      if (isHovering && filePath) {
        // 从文件路径提取格�?
        const fileName = filePath.split(/[\\/]/).pop() || '';
        const fileExt = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
        const isAnimationFormat = (fileMeta?.format === 'gif' || fileMeta?.format === 'webp') || (fileExt === 'gif' || fileExt === 'webp');
        
        if (isAnimationFormat) {
          try {
            // 使用readFileAsBase64直接读取文件内容，避免使用http://asset.localhost/协议
            const { readFileAsBase64 } = await import('../api/tauri-bridge');
            
            if (!isMounted) return;

            const dataUrl = await readFileAsBase64(filePath);
            
            if (isMounted) {
              if (dataUrl) {
                setAnimSrc(dataUrl);
              } else {
                setAnimSrc(null);
              }
            }
          } catch (e) {
            setAnimSrc(null);
          }
        } else {
          if (isMounted) {
            setAnimSrc(null);
          }
        }
      } else {
        if (isMounted) {
          setAnimSrc(null);
        }
      }
    };

    loadAnimation();

    return () => {
      isMounted = false;
    };
  }, [isHovering, filePath, fileMeta]);

  const finalSrc = animSrc || thumbnailSrc;

  return (
    <div ref={ref} className="w-full h-full relative overflow-hidden">
      {/* Placeholder Icon */}
      <div className="absolute inset-0 bg-gray-200 dark:bg-gray-800 flex items-center justify-center pointer-events-none">
        {loading && !thumbnailSrc ? (
          <ImageIcon className="text-gray-400 dark:text-gray-600 animate-pulse" size={24} />
        ) : finalSrc ? (
          <img 
            src={finalSrc} 
            alt={alt} 
            className="absolute inset-0 w-full h-full object-cover" 
            loading="eager" 
            draggable="false"
          />
        ) : (
          <ImageIcon className="text-gray-400 dark:text-gray-600" size={24} />
        )}
      </div>
    </div>
  );
});

// 辅助函数：深度查找文件夹内的图片
const findImagesDeeply = (
    rootFolder: FileNode, 
    allFiles: Record<string, FileNode>, 
    limit: number = 3
): FileNode[] => {
    const images: FileNode[] = [];
    // 使用栈进�?DFS，或者队列进�?BFS
    const stack: string[] = [...(rootFolder.children || [])];
    const visited = new Set<string>(); // 防止循环引用
    
    // 设置一个遍历上限，防止超大文件夹卡�?UI
    let traversalCount = 0;
    const MAX_TRAVERSAL = 500; 

    while (stack.length > 0 && traversalCount < MAX_TRAVERSAL) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        traversalCount++;

        const node = allFiles[id];
        if (!node) continue;
        
        if (node.type === FileType.IMAGE) {
            images.push(node);
        } else if (node.type === FileType.FOLDER && node.children) {
            stack.push(...node.children);
        }
    }
    
    // 排序并切�?
    return images
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        .slice(0, limit);
};

export const FolderThumbnail = React.memo(({ file, files, mode, resourceRoot, cachePath }: { file: FileNode; files: Record<string, FileNode>, mode: LayoutMode, resourceRoot?: string, cachePath?: string }) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '200px' });
  
  // 1. 同步计算需要展示的子文�?(改为深度查找)
  const imageChildren = useMemo(() => {
      if (!file.children || file.children.length === 0) return [];
      return findImagesDeeply(file, files, 3);
  }, [file, files]);

  // 2. 初始化时尝试从全局缓存同步读取
  const [previewSrcs, setPreviewSrcs] = useState<string[]>(() => {
      const cache = getGlobalCache();
      // 尝试映射所有子文件到缓存中�?URL
      const cachedUrls = imageChildren.map(child => {
          // 使用�?ImageThumbnail 相同�?Key 生成逻辑 (�?filePath)
          return cache.get(child.path) || null; 
      });
      
      // 只有当所有需要的图片都有缓存时，才视为命�?(或者至少有一张？)
      // 为了体验最好，只要有缓存就先用。过滤掉 null�?
      const validUrls = cachedUrls.filter((url): url is string => !!url);
      
      // 如果没有缓存，返回空数组
      return validUrls;
  });

  const previewCountedRef = useRef<Set<string>>(new Set());

  // 如果初始就有数据（哪怕只有一张），就不设�?loaded=false，避免闪�?
  const [loaded, setLoaded] = useState(previewSrcs.length > 0);

  // 统计 imageChildren 中已缓存的项�?hit，防止初始缓存不计数
  useEffect(() => {
    const cache = getGlobalCache();
    imageChildren.forEach(img => {
      if (cache.get(img.path) && !previewCountedRef.current.has(img.path)) {
        performanceMonitor.increment('thumbnailCacheHit');
        previewCountedRef.current.add(img.path);
      }
    });
  }, [imageChildren]);
  useEffect(() => {
    // 如果已经加载过了，且数量足够（或者等于子文件总数），就不再请�?
    // 注意：这里简单判断，如果缓存里不�?3 张但实际�?3 张，还是会触发请求补�?
    if (loaded && previewSrcs.length === Math.min(3, imageChildren.length)) {
        return;
    }

    if ((isInView || wasInView) && resourceRoot && imageChildren.length > 0) {
      const controller = new AbortController();
      const loadPreviews = async () => {
        try {
          const { getThumbnail } = await import('../api/tauri-bridge');
          
          // 并行请求所有子文件的缩略图
          const promises = imageChildren.map(async (img: FileNode) => {
              // 先查缓存，如果有就不请求�?(虽然 getThumbnail 内部也有 batcher，但这里拦截更快)
              const cache = getGlobalCache();
              const cached = cache.get(img.path);
              if (cached) {
                  performanceMonitor.increment('thumbnailCacheHit');
                  return cached;
              }

              const url = await getThumbnail(img.path, img.updatedAt, resourceRoot, controller.signal);
              if (url) {
                  cache.set(img.path, url); // 更新缓存
              }
              return url;
          });

          const thumbnails = await Promise.all(promises);
          
          if (!controller.signal.aborted) {
            const validThumbnails = thumbnails.filter((t): t is string => !!t);
            // 只有当结果不同时才更新状�?
            // 简单的数组比较
            setPreviewSrcs(prev => {
                if (prev.length === validThumbnails.length && prev.every((val, index) => val === validThumbnails[index])) {
                    return prev;
                }
                return validThumbnails;
            });
          }
        } catch (error) {
          if (!controller.signal.aborted) {
            console.error('Failed to load folder previews:', error);
          }
        } finally {
          if (!controller.signal.aborted) {
            setLoaded(true);
          }
        }
      };

      loadPreviews();

      return () => {
        controller.abort();
      };
    }
  }, [isInView, wasInView, loaded, imageChildren, resourceRoot]);

  return (
    <div ref={ref} className="w-full h-full relative flex flex-col items-center justify-center bg-transparent">
      {(isInView || wasInView) && (
          <div className="relative w-full aspect-square p-2" style={{ maxHeight: '100%' }}>
             <Folder3DIcon  
                previewSrcs={previewSrcs}
                count={file.children?.length} 
                category={file.category} 
             />
          </div>
      )}
    </div>
  );
});

export const InlineRenameInput = ({ defaultValue, onCommit, onCancel }: { defaultValue: string, onCommit: (val: string) => void, onCancel: () => void }) => {
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) {
      inputRef.current.focus();
      const lastDot = defaultValue.lastIndexOf('.');
      if (lastDot > 0) {
        inputRef.current.setSelectionRange(0, lastDot);
      } else {
        inputRef.current.select();
      }
    }
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.stopPropagation();
      onCommit(inputRef.current?.value || defaultValue);
    }
    if (e.key === 'Escape') {
      e.stopPropagation();
      onCancel();
    }
  };

  return (
    <input
      ref={inputRef}
      type="text"
      defaultValue={defaultValue}
      onBlur={(e) => onCommit(e.target.value)}
      onKeyDown={handleKeyDown}
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      className="w-full text-center text-xs font-bold bg-white dark:bg-gray-700 border border-blue-500 rounded px-1 py-0.5 focus:outline-none shadow-sm cursor-text"
    />
  );
};

const TagItem = React.memo(({ tag, count, isSelected, onTagClick, onTagDoubleClick, onTagContextMenu, handleMouseEnter, handleMouseLeave }: any) => {
  return (
    <div 
      key={tag} 
      data-tag={tag}
      className={`tag-item rounded-lg p-4 border-2 cursor-pointer group transition-all relative ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50 border-blue-500 shadow-lg ring-2 ring-blue-300/50 dark:ring-blue-700/50' : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-800 hover:border-blue-500 dark:hover:border-blue-500'}`} 
      onClick={(e) => { e.stopPropagation(); onTagClick && onTagClick(tag, e); }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={() => onTagDoubleClick && onTagDoubleClick(tag)} 
      onContextMenu={(e) => onTagContextMenu && onTagContextMenu(e, tag)}
      onMouseEnter={(e) => handleMouseEnter(e, tag)}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex items-center justify-between mb-2">
        <Tag size={20} className={`${isSelected ? 'text-blue-600' : 'text-blue-500 dark:text-blue-400'} group-hover:scale-110 transition-transform`} />
        <span className={`${isSelected ? 'bg-blue-200 dark:bg-blue-800 text-blue-800 dark:text-blue-200' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'} text-xs px-2 py-0.5 rounded-full`}>{count}</span>
      </div>
      <div className="font-bold text-gray-800 dark:text-gray-200 truncate">{tag}</div>
      {isSelected && (<div className="absolute top-2 left-2 w-3 h-3 bg-blue-500 rounded-full ring-2 ring-white dark:ring-gray-900 shadow-md"></div>)}
    </div>
  );
});

const TagsList = React.memo(({ groupedTags, keys, files, selectedTagIds, onTagClick, onTagDoubleClick, onTagContextMenu, t, searchQuery }: any) => {
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);
  const [hoveredTagPos, setHoveredTagPos] = useState<{ top: number, left: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // 根据搜索查询过滤标签
  const filteredGroupedTags = useMemo(() => {
      if (!searchQuery || !searchQuery.trim()) {
          return groupedTags;
      }
      const query = searchQuery.toLowerCase().trim();
      const filtered: Record<string, string[]> = {};
      Object.entries(groupedTags).forEach(([key, tags]) => {
          const matchingTags = (tags as string[]).filter(tag => 
              tag.toLowerCase().includes(query)
          );
          if (matchingTags.length > 0) {
              filtered[key] = matchingTags;
          }
      });
      return filtered;
  }, [groupedTags, searchQuery]);

  // 根据过滤后的标签生成 keys
  const filteredKeys = useMemo(() => {
      return Object.keys(filteredGroupedTags).sort();
  }, [filteredGroupedTags]);

  const tagCounts = useMemo(() => {
      const counts: Record<string, number> = {};
      Object.values(files).forEach((f: any) => {
          if (f.tags) {
              f.tags.forEach((t: string) => {
                  counts[t] = (counts[t] || 0) + 1;
              });
          }
      });
      return counts;
  }, [files]);

  const previewImages = useMemo(() => {
    if (!hoveredTag) return [];
    return Object.values(files)
      .filter((f: any) => f.type === FileType.IMAGE && f.tags.includes(hoveredTag))
      .sort((a: any, b: any) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 3);
  }, [hoveredTag, files]);

  const handleMouseEnter = useCallback((e: React.MouseEvent, tag: string) => {
    const target = e.currentTarget as HTMLElement;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    
    hoverTimerRef.current = setTimeout(() => {
      const rect = target.getBoundingClientRect();
      const PREVIEW_WIDTH = 256; 
      const PREVIEW_HEIGHT = 120;
      
      let left = rect.left + (rect.width / 2) - (PREVIEW_WIDTH / 2);
      let top = rect.bottom + 10;

      if (left < 10) left = 10;
      if (left + PREVIEW_WIDTH > window.innerWidth) left = window.innerWidth - PREVIEW_WIDTH - 10;
      if (top + PREVIEW_HEIGHT > window.innerHeight) top = rect.top - PREVIEW_HEIGHT - 10;

      setHoveredTagPos({ top, left });
      setHoveredTag(tag);
    }, 600);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredTag(null);
    setHoveredTagPos(null);
  }, []);
  
  // 计算并维护字母索引栏相对于视口的 top（使其垂直居中于文件列表区域）
  const [indexTop, setIndexTop] = useState<number | null>(null);

  const computeIndexTop = useCallback(() => {
    try {
      const container = document.getElementById('file-grid-container');
      if (container) {
        const rect = container.getBoundingClientRect();
        const top = rect.top + rect.height / 2; // 相对于视口的 y
        setIndexTop(Math.round(top));
        return;
      }
    } catch (e) {
      // ignore
    }
    // fallback: 视口中心
    setIndexTop(Math.round(window.innerHeight / 2));
  }, []);

  useEffect(() => {
    computeIndexTop();
    const onResize = () => computeIndexTop();
    const onScroll = () => computeIndexTop();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    const ro = new MutationObserver(() => computeIndexTop());
    ro.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      ro.disconnect();
    };
  }, [computeIndexTop]);

  return (
    <div className="relative">
      {/* 字母索引�?*/}
      {filteredKeys.length > 0 && createPortal(
        <div className="fixed transform -translate-y-1/2 z-[110] bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm rounded-full px-1 py-2 shadow-md border border-gray-200 dark:border-gray-800 transition-all duration-300"
             style={{ right: 'calc(20px + var(--metadata-panel-width, 0px))', top: indexTop != null ? `${indexTop}px` : '50%' }}
             onMouseEnter={() => {
              const metadataPanel = document.querySelector('.metadata-panel-container') as HTMLElement | null;
              if (metadataPanel) {
                metadataPanel.style.zIndex = '10';
              }
            }}
            onMouseLeave={() => {
              const metadataPanel = document.querySelector('.metadata-panel-container') as HTMLElement | null;
              if (metadataPanel) {
                metadataPanel.style.zIndex = '40';
              }
            }}
        >
          <div className="flex flex-col items-center space-y-1">
            {filteredKeys.map((group: string) => (
              <button
                key={group}
                onClick={() => {
                  const element = document.getElementById(`tag-group-${group}`);
                  if (element) {
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                title={group}
              >
                {group}
              </button>
            ))}
          </div>
        </div>,
        // 渲染到 body，确保 fixed 相对于视口
        typeof document !== 'undefined' ? document.body : null
      )}
      
      {/* 标签列表内容 */}
      {filteredKeys.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <Tag size={64} className="mb-4 opacity-20"/>
              <p>{t('sidebar.noTagsFound')}</p>
          </div>
      )}
      {filteredKeys.map((group: string) => {
          const tagsInGroup = filteredGroupedTags[group];
          return (
              <div id={`tag-group-${group}`} key={group} className="mb-8 scroll-mt-4">
                   <div className="flex items-center mb-0 border-b border-gray-100 dark:border-gray-800 pt-3 pb-3 sticky top-0 bg-white/95 dark:bg-gray-900/95 z-10 backdrop-blur-sm transition-colors h-16">
                       <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold text-lg mr-3 shadow-sm border border-blue-100 dark:border-blue-900/50">
                          {group}
                       </div>
                       <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                          {tagsInGroup.length} {t('context.items')}
                       </span>
                   </div>
                   <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 2xl:grid-cols-6 gap-3">
                       {tagsInGroup.map((tag: string) => {
                           const count = tagCounts[tag] || 0;
                           const isSelected = selectedTagIds.includes(tag);
                           return (
                              <TagItem 
                                  key={tag}
                                  tag={tag}
                                  count={count}
                                  isSelected={isSelected}
                                  onTagClick={onTagClick}
                                  onTagDoubleClick={onTagDoubleClick}
                                  onTagContextMenu={onTagContextMenu}
                                  handleMouseEnter={handleMouseEnter}
                                  handleMouseLeave={handleMouseLeave}
                              />
                           );
                       })}
                   </div>
              </div>
          );
      })}

      {hoveredTag && previewImages.length > 0 && hoveredTagPos && createPortal(
        <div 
          className="fixed z-[100] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl p-3 w-64 animate-fade-in pointer-events-none" 
          style={{ top: hoveredTagPos.top, left: hoveredTagPos.left }}
        >
          <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 border-b border-gray-200 dark:border-gray-700 pb-1 font-bold flex items-center justify-between">
             <span>{t('sidebar.tagPreview')} "{hoveredTag}"</span>
             <span className="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 rounded">{previewImages.length} {t('sidebar.recent')}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {previewImages.map((f: any) => (
              <div key={f.id} className="aspect-square bg-gray-100 dark:bg-black rounded border border-gray-200 dark:border-gray-800 overflow-hidden">
                 {/* Note: In Tauri, file.url and file.previewUrl are file paths, not usable URLs. Use placeholder for now. */}
                 <div className="w-full h-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                   <ImageIcon className="text-gray-400 dark:text-gray-500" size={20} />
                 </div>
              </div>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}, (prev, next) => {
    return prev.groupedTags === next.groupedTags && 
           prev.files === next.files && 
           prev.selectedTagIds === next.selectedTagIds &&
           prev.keys === next.keys &&
           prev.searchQuery === next.searchQuery; 
});

const FileListItem = React.memo(({
  file,
  files,
  isSelected,
  renamingId,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  t,
  resourceRoot,
  cachePath,
  selectedFileIds,
  onDragStart,
  onDragEnd,
  thumbnailSize,
  setIsDraggingInternal,
  setDraggedFilePaths
}: any) => {
  if (!file) return null;
  
  // 列表视图下的拖拽处理
  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    
    // 如果文件未被选中，拖拽时自动选中�?
    if (!isSelected) {
      onFileClick(e, file.id);
    }
    
    // 设置拖拽数据：如果文件被选中，拖拽所有选中的文件；否则只拖拽当前文�?
    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
      ? selectedFileIds 
      : [file.id];
    
    // 收集被拖拽文件的实际路径
    const filePaths = filesToDrag.map((fileId: string) => files[fileId]?.path || '').filter(Boolean);
    
    // 设置内部拖拽标记
    if (setIsDraggingInternal && setDraggedFilePaths) {
      setIsDraggingInternal(true);
      setDraggedFilePaths(filePaths);
    }
    
    // 设置拖拽数据
    try {
      // 1. 设置JSON格式的拖拽数据，用于内部处理
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        internalDrag: true // 添加内部拖拽标记
      }));
      
      // 2. 设置text/uri-list格式，用于外部文件拖�?
      const uriList = filePaths.map((path: string) => `file://${path.replace(/\\/g, '/')}`).join('\n');
      e.dataTransfer.setData('text/uri-list', uriList);
      
      // 3. 设置简单的文本数据，用于显示拖拽信�?
      const textData = `${filesToDrag.length} file${filesToDrag.length > 1 ? 's' : ''} selected`;
      e.dataTransfer.setData('text/plain', textData);
      
      // 设置拖拽效果
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch (error) {
      // Error handling for drag data setup
    }
    
    // 列表视图下，拖拽缩略图固定为100px
    const dragThumbSize = 100;
    
    // 创建拖拽预览容器
    const dragImageContainer = document.createElement('div');
    dragImageContainer.style.position = 'absolute';
    dragImageContainer.style.left = '-9999px';
    dragImageContainer.style.top = '-9999px';
    dragImageContainer.style.pointerEvents = 'none';
    dragImageContainer.style.zIndex = '9999';
    dragImageContainer.style.width = `${dragThumbSize}px`;
    dragImageContainer.style.height = `${dragThumbSize}px`;
    dragImageContainer.style.display = 'flex';
    dragImageContainer.style.alignItems = 'center';
    dragImageContainer.style.justifyContent = 'center';
    dragImageContainer.style.borderRadius = '8px';
    dragImageContainer.style.background = 'transparent';
    dragImageContainer.style.boxShadow = 'none';
    dragImageContainer.style.padding = '0px';
    
    // 创建缩略图容�?
    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.style.position = 'relative';
    thumbnailsContainer.style.width = '100%';
    thumbnailsContainer.style.height = '100%';
    thumbnailsContainer.style.display = 'flex';
    thumbnailsContainer.style.alignItems = 'center';
    thumbnailsContainer.style.justifyContent = 'center';
    
    // 获取全局缓存
    const cache = getGlobalCache();
    
    // 最多显�?个缩略图
    const previewCount = Math.min(filesToDrag.length, 3);
    
    // 确保拖拽的文件显示在预览中，并且优先级最�?
    const previewFiles: string[] = [];
    previewFiles.push(file.id);
    
    // 从剩余选中的文件中添加其他文件，避免重�?
    for (const fileId of filesToDrag) {
      if (fileId !== file.id && previewFiles.length < previewCount) {
        previewFiles.push(fileId);
      }
    }
    
    // 绘制每个文件的缩略图
    for (let i = 0; i < previewFiles.length; i++) {
      const draggedFileId = previewFiles[i];
      const draggedFile = files[draggedFileId];
      if (!draggedFile) continue;
      
      // 获取缓存的缩略图
      const cachedThumb = draggedFile.type === FileType.IMAGE ? cache.get(draggedFile.path) : null;
      
      // 计算单个缩略图尺寸（基于拖拽容器大小�?
      const singleThumbSize = dragThumbSize * 0.9;
      
      // 创建单个缩略图元�?
      const thumbElement = document.createElement('div');
      thumbElement.style.position = 'absolute';
      thumbElement.style.width = `${singleThumbSize}px`;
      thumbElement.style.height = `${singleThumbSize}px`;
      thumbElement.style.borderRadius = '8px';
      thumbElement.style.background = 'transparent';
      thumbElement.style.border = '2px solid rgba(255, 255, 255, 0.4)';
      thumbElement.style.display = 'flex';
      thumbElement.style.alignItems = 'center';
      thumbElement.style.justifyContent = 'center';
      thumbElement.style.overflow = 'hidden';
      
      // 设置z-index，确保拖拽的文件显示在最前面
      thumbElement.style.zIndex = `${previewCount - i}`;
      
      // 计算位置和旋转（使用CSS变换�?
      const rotation = i === 0 ? 0 : (i === 1 ? -8 : 8);
      const offsetScale = singleThumbSize / 150;
      const offsetX = i === 0 ? 0 : (i === 1 ? -10 * offsetScale : 10 * offsetScale);
      const offsetY = i * 12 * offsetScale;
      thumbElement.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg)`;
      
      // 绘制缩略图或占位�?
      if (cachedThumb) {
        const img = document.createElement('img');
        img.src = cachedThumb;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.objectPosition = 'center';
        img.draggable = false;
        thumbElement.appendChild(img);
      } else {
        if (draggedFile.type === FileType.IMAGE) {
          thumbElement.innerHTML = `<div style="font-size: 32px;">🖼�?/div>`;
        } else if (draggedFile.type === FileType.FOLDER) {
          // 使用与软件内Folder3DIcon一致的设计
          thumbElement.innerHTML = `
            <div style="width: 100%; height: 100%; position: relative;">
              <svg viewBox="0 0 100 100" style="position: absolute; width: 100%; height: 100%; fill: #3b82f6; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));" preserveAspectRatio="none">
                <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" />
              </svg>
              <div style="position: absolute; left: 0; right: 0; bottom: 0; height: 60%; transform: perspective(800px) rotateX(-10deg);">
                <svg viewBox="0 0 100 65" style="width: 100%; height: 100%; fill: #2563eb; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.15));" preserveAspectRatio="none">
                  <path d="M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z" />
                </svg>
                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0.5; mix-blend-mode: overlay;">
                  <svg viewBox="0 0 24 24" style="width: 32px; height: 32px; fill: white; stroke: white; stroke-width: 1.5;" preserveAspectRatio="xMidYMid meet">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  </svg>
                </div>
              </div>
            </div>
          `;
        } else {
          thumbElement.innerHTML = `<div style="font-size: 32px;">📄</div>`;
        }
      }
      
      thumbnailsContainer.appendChild(thumbElement);
    }
    
    // 绘制文件计数（如果超�?个）
    if (filesToDrag.length > 3) {
      const count = filesToDrag.length - 3;
      const countBadge = document.createElement('div');
      countBadge.style.position = 'absolute';
      const badgeSize = 40 * (dragThumbSize / 200);
      countBadge.style.right = `${12 * (dragThumbSize / 200)}px`;
      countBadge.style.bottom = `${12 * (dragThumbSize / 200)}px`;
      countBadge.style.width = `${badgeSize}px`;
      countBadge.style.height = `${badgeSize}px`;
      countBadge.style.borderRadius = '50%';
      countBadge.style.background = '#2563eb';
      countBadge.style.color = 'white';
      countBadge.style.display = 'flex';
      countBadge.style.alignItems = 'center';
      countBadge.style.justifyContent = 'center';
      countBadge.style.font = `bold ${14 * (dragThumbSize / 200)}px Arial, sans-serif`;
      countBadge.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
      countBadge.textContent = `+${count}`;
      thumbnailsContainer.appendChild(countBadge);
    }
    
    // 添加到容�?
    dragImageContainer.appendChild(thumbnailsContainer);
    document.body.appendChild(dragImageContainer);
    
    // 设置拖拽图像
    try {
      // 拖拽图像偏移量应为容器尺寸的一半，确保鼠标指针在中�?
      const dragOffset = dragThumbSize / 2;
      e.dataTransfer.setDragImage(dragImageContainer, dragOffset, dragOffset);
    } catch (error) {
      // Error handling for drag image setup
    }
    
    // 设置拖拽效果为move，用于内部拖�?
    e.dataTransfer.effectAllowed = 'move';
    
    // 获取要拖拽的实际文件路径
    const draggedFiles = filesToDrag.map((fileId: string) => files[fileId]).filter((Boolean as unknown) as (file: FileNode | undefined) => file is FileNode);
    const draggedFilePaths = draggedFiles.map((file: FileNode) => file.path);
    
    // 设置内部拖拽标记
    if (setIsDraggingInternal) {
      setIsDraggingInternal(true);
    }
    
    // 保存拖拽的文件路�?
    if (setDraggedFilePaths) {
      setDraggedFilePaths(draggedFilePaths);
    }
    
    try {
      // 设置JSON格式的拖拽数据，用于内部处理
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        // 添加内部拖拽标记
        internalDrag: true
      }));
      
      // 不设置外部拖拽数据，避免触发外部拖拽行为
      // 我们将在拖拽结束时检测是否拖拽到了外�?
    } catch (error) {
      console.error('Drag data setup error:', error);
    }
    
    // 通知父组件开始拖�?
    if (onDragStart) {
      onDragStart(filesToDrag);
    }
    
    // 在拖拽结束后清理临时元素
    const cleanupDragImage = () => {
      if (dragImageContainer.parentNode) {
        dragImageContainer.parentNode.removeChild(dragImageContainer);
      }
      document.removeEventListener('dragend', cleanupDragImage);
      document.removeEventListener('dragleave', cleanupDragImage);
    };
    
    document.addEventListener('dragend', cleanupDragImage);
    document.addEventListener('dragleave', cleanupDragImage);
  };
  
  const handleDragEnd = (e: React.DragEvent) => {
    e.stopPropagation();
    
    // 清除内部拖拽标记
    if (setIsDraggingInternal) {
      setIsDraggingInternal(false);
    }
    
    if (onDragEnd) {
      onDragEnd();
    }
  };
  
  // 用于追踪外部拖拽状�?
  const [isExternalDragging, setIsExternalDragging] = useState(false);
  
  return (
    <div
        data-id={file.id}
        className={`
            file-item flex items-center p-2 rounded text-sm cursor-pointer border transition-colors mb-1 relative
            ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50 border-blue-500 border-l-4 shadow-md' : 'bg-white dark:bg-gray-900 border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'}
            ${isExternalDragging ? 'opacity-50' : ''}
        `}
        onMouseDown={async (e) => {
            if (e.button === 0) {
                e.stopPropagation();
                
                // 按住 Alt 键时，启动外部拖拽（复制文件到外部应用）
                if (e.altKey && isTauriEnvironment()) {
                    e.preventDefault();
                    
                    // 获取要拖拽的文件
                    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
                        ? selectedFileIds 
                        : [file.id];
                    
                    // 收集被拖拽文件的实际路径
                    const filePaths = filesToDrag
                        .map((fileId: string) => files[fileId]?.path || '')
                        .filter(Boolean);
                    
                    if (filePaths.length > 0) {
                        setIsExternalDragging(true);
                        
                        // 设置内部拖拽标记，防止触发外部拖入覆盖层
                        if (setIsDraggingInternal) {
                            setIsDraggingInternal(true);
                        }
                        
                        // 获取缩略图路径（最�?个）
                        const pathCache = getThumbnailPathCache();
                        const thumbnailPaths = filePaths
                            .slice(0, 3)
                            .map((fp: string) => pathCache.get(fp))
                            .filter((p: string | undefined): p is string => !!p);
                        
                        // 计算缓存目录
                        const cacheDir = resourceRoot 
                            ? `${resourceRoot}${resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache`
                            : undefined;
                        
                        try {
                            await startDragToExternal(filePaths, thumbnailPaths, cacheDir, () => {
                                setIsExternalDragging(false);
                                if (setIsDraggingInternal) {
                                    setIsDraggingInternal(false);
                                }
                            });
                        } catch (error) {
                            console.error('External drag failed:', error);
                            setIsExternalDragging(false);
                            if (setIsDraggingInternal) {
                                setIsDraggingInternal(false);
                            }
                        }
                    }
                }
            }
        }}
        onClick={(e) => {
            e.stopPropagation();
            onFileClick(e, file.id);
        }}
        onDoubleClick={(e) => {
            e.stopPropagation();
            onFileDoubleClick(file.id);
        }}
        onContextMenu={(e) => onContextMenu(e, file.id)}
        draggable={true}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}>
        <div className="flex-1 flex items-center overflow-hidden min-w-0 pointer-events-none">
            {file.type === FileType.FOLDER ? (
            <Folder className="text-blue-500 mr-3 shrink-0" size={18} />
            ) : (
            <div className="w-6 h-6 mr-3 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden shrink-0 relative">
                {file.type === FileType.IMAGE ? (
                    <div className="w-full h-full">
                        <ImageThumbnail
                            src={''}
                            alt={file.name}
                            isSelected={false}
                            filePath={file.path}
                            modified={file.updatedAt}
                            size={file.size}
                            isHovering={false}
                            fileMeta={file.meta}
                            resourceRoot={resourceRoot}
                            cachePath={cachePath}
                        />
                    </div>
                ) : (
                    <div className="w-full h-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                        <ImageIcon className="text-gray-400 dark:text-gray-500" size={14} />
                    </div>
                )}
            </div>
            )}
            {renamingId === file.id ? (
            <div className="w-64 pointer-events-auto">
                <InlineRenameInput
                    defaultValue={file.name}
                    onCommit={(val: string) => onRenameSubmit(val, file.id)}
                    onCancel={onRenameCancel}
                />
            </div>
            ) : (
            <span
                className="truncate text-gray-900 dark:text-gray-100 font-bold text-sm pointer-events-auto"
                onDoubleClick={(e) => {
                e.stopPropagation();
                onStartRename(file.id);
                }}
            >{file.name}</span>
            )}
        </div>
        <div className="w-32 text-xs text-gray-500 truncate hidden sm:block pointer-events-none">
            {file.updatedAt ? new Date(file.updatedAt).toLocaleDateString() : '-'}
        </div>
        <div className="w-24 text-xs text-gray-500 uppercase hidden md:block pointer-events-none">
            {file.type === FileType.FOLDER ? t('meta.folderType') : file.meta?.format || '-'}
        </div>
        <div className="w-20 text-xs text-gray-500 text-right font-mono hidden sm:block pointer-events-none">
            {file.type === FileType.IMAGE ? formatSize(file.meta?.sizeKb || 0) : '-'}
        </div>
    </div>
  );
});



const FileCard = React.memo(({
  file,
  files,
  isSelected,
  renamingId,
  layoutMode,
  hoverPlayingId,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onSetHoverPlayingId,
  style,
  settings,
  resourceRoot,
  cachePath,
  selectedFileIds,
  onDragStart,
  onDragEnd,
  thumbnailSize,
  setIsDraggingInternal,
  setDraggedFilePaths
}: any) => {
  const [isDragging, setIsDragging] = useState(false);
  if (!file) return null;

  // Extract layout positioning
  const { x, y, width, height } = style || { x: 0, y: 0, width: 200, height: 200 };
  
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);

  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    setIsDragging(true);
    
    // 如果文件未被选中，拖拽时自动选中�?
    if (!isSelected) {
      onFileClick(e, file.id);
    }
    
    // 设置拖拽数据：如果文件被选中，拖拽所有选中的文件；否则只拖拽当前文�?
    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
      ? selectedFileIds 
      : [file.id];
    
    // 收集被拖拽文件的实际路径
    const filePaths = filesToDrag.map((fileId: string) => files[fileId]?.path || '').filter(Boolean);
    
    // 设置内部拖拽标记
    if (setIsDraggingInternal && setDraggedFilePaths) {
      setIsDraggingInternal(true);
      setDraggedFilePaths(filePaths);
    }
    
    // 设置拖拽数据
    try {
      // 1. 设置JSON格式的拖拽数据，用于内部处理
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        internalDrag: true // 添加内部拖拽标记
      }));
      
      // 2. 设置text/uri-list格式，用于外部文件拖�?
      const uriList = filePaths.map((path: string) => `file://${path.replace(/\\/g, '/')}`).join('\n');
      e.dataTransfer.setData('text/uri-list', uriList);
      
      // 3. 设置简单的文本数据，用于显示拖拽信�?
      const textData = `${filesToDrag.length} file${filesToDrag.length > 1 ? 's' : ''} selected`;
      e.dataTransfer.setData('text/plain', textData);
      
      // 设置拖拽效果
      e.dataTransfer.effectAllowed = 'copyMove';
    } catch (error) {
      // Error handling for drag data setup
    }
    
    // 计算拖拽缩略图尺�?
    // 主界面图标大小范围：100px-480px
    // 拖拽缩略图大小范围：100px-380px
    // 线性映射：dragThumbSize = 100 + (mainThumbSize - 100) * (280 / 380)
    const mainThumbSize = thumbnailSize; // 主界面图标大�?
    const minMainSize = 100;
    const maxMainSize = 480;
    const minDragSize = 100;
    const maxDragSize = 380;
    
    // 线性映射计算拖拽缩略图大小
    const dragThumbSize = Math.min(maxDragSize, Math.max(minDragSize, 
        minDragSize + (mainThumbSize - minMainSize) * ((maxDragSize - minDragSize) / (maxMainSize - minMainSize))
    ));
    
    // 优化方案：创建临时DOM元素作为拖拽预览
    // 这种方法比Canvas更可靠，避免了Canvas绘制的时序问�?
    const dragImageContainer = document.createElement('div');
    dragImageContainer.style.position = 'absolute';
    dragImageContainer.style.left = '-9999px';
    dragImageContainer.style.top = '-9999px';
    dragImageContainer.style.pointerEvents = 'none';
    dragImageContainer.style.zIndex = '9999';
    dragImageContainer.style.width = `${dragThumbSize}px`;
    dragImageContainer.style.height = `${dragThumbSize}px`;
    dragImageContainer.style.display = 'flex';
    dragImageContainer.style.alignItems = 'center';
    dragImageContainer.style.justifyContent = 'center';
    dragImageContainer.style.borderRadius = '8px';
    dragImageContainer.style.background = 'transparent';
    dragImageContainer.style.boxShadow = 'none';
    dragImageContainer.style.padding = '0px';
    
    // 获取全局缓存
    const cache = getGlobalCache();
    
    // 创建缩略图容�?
    const thumbnailsContainer = document.createElement('div');
    thumbnailsContainer.style.position = 'relative';
    thumbnailsContainer.style.width = '100%';
    thumbnailsContainer.style.height = '100%';
    thumbnailsContainer.style.display = 'flex';
    thumbnailsContainer.style.alignItems = 'center';
    thumbnailsContainer.style.justifyContent = 'center';
    
    // 最多显�?个缩略图
    const previewCount = Math.min(filesToDrag.length, 3);
    
    // 确保拖拽的文件显示在预览中，并且优先级最�?
    // 1. 首先添加当前拖拽的文件（file变量代表用户正在拖拽的文件）
    // 2. 然后从剩余选中的文件中添加其他文件，最多显�?�?
    const previewFiles: string[] = [];
    
    // 确保当前拖拽的文件在预览�?
    previewFiles.push(file.id);
    
    // 从剩余选中的文件中添加其他文件，避免重�?
    for (const fileId of filesToDrag) {
      if (fileId !== file.id && previewFiles.length < previewCount) {
        previewFiles.push(fileId);
      }
    }
    
    // 绘制每个文件的缩略图
    for (let i = 0; i < previewFiles.length; i++) {
      const draggedFileId = previewFiles[i];
      const draggedFile = files[draggedFileId];
      if (!draggedFile) continue;
      
      // 获取缓存的缩略图
      const cachedThumb = draggedFile.type === FileType.IMAGE ? cache.get(draggedFile.path) : null;
      
      // 计算单个缩略图尺寸（基于拖拽容器大小�?
      // 增加单个缩略图尺寸，从容器的75%增加�?0%，确保内部显示的缩略图更�?
      const singleThumbSize = dragThumbSize * 0.9; // 单个缩略图尺寸为容器�?0%
      
      // 创建单个缩略图元�?
      const thumbElement = document.createElement('div');
      thumbElement.style.position = 'absolute';
      thumbElement.style.width = `${singleThumbSize}px`;
      thumbElement.style.height = `${singleThumbSize}px`;
      thumbElement.style.borderRadius = '8px';
      thumbElement.style.background = 'transparent';
      thumbElement.style.border = '2px solid rgba(255, 255, 255, 0.4)';
      thumbElement.style.display = 'flex';
      thumbElement.style.alignItems = 'center';
      thumbElement.style.justifyContent = 'center';
      thumbElement.style.overflow = 'hidden';
      
      // 设置z-index，确保拖拽的文件显示在最前面
      thumbElement.style.zIndex = `${previewCount - i}`;
      
      // 计算位置和旋转（使用CSS变换�?
      const rotation = i === 0 ? 0 : (i === 1 ? -8 : 8);
      // 偏移量按比例调整
      const offsetScale = singleThumbSize / 150; // 基于150px的基准尺�?
      const offsetX = i === 0 ? 0 : (i === 1 ? -10 * offsetScale : 10 * offsetScale);
      const offsetY = i * 12 * offsetScale;
      thumbElement.style.transform = `translate(${offsetX}px, ${offsetY}px) rotate(${rotation}deg)`;
      
      // 绘制缩略图或占位�?
      if (cachedThumb) {
        // 使用已缓存的缩略图URL
        const img = document.createElement('img');
        img.src = cachedThumb;
        img.style.width = '100%';
        img.style.height = '100%';
        img.style.objectFit = 'cover';
        img.style.objectPosition = 'center';
        img.draggable = false;
        thumbElement.appendChild(img);
      } else {
        // 绘制占位�?
        if (draggedFile.type === FileType.IMAGE) {
          // 图片占位�?
          thumbElement.innerHTML = `<div style="font-size: 32px;">🖼�?/div>`;
        } else if (draggedFile.type === FileType.FOLDER) {
          // 文件夹占位符：使用与软件内Folder3DIcon一致的设计
          thumbElement.innerHTML = `
            <div style="width: 100%; height: 100%; position: relative;">
              <!-- Back Plate -->
              <svg viewBox="0 0 100 100" style="position: absolute; width: 100%; height: 100%; fill: #3b82f6; filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.1));" preserveAspectRatio="none">
                <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" />
              </svg>
              
              <!-- Front Plate -->
              <div style="position: absolute; left: 0; right: 0; bottom: 0; height: 60%; transform: perspective(800px) rotateX(-10deg);">
                <svg viewBox="0 0 100 65" style="width: 100%; height: 100%; fill: #2563eb; filter: drop-shadow(0 4px 6px rgba(0, 0, 0, 0.15));" preserveAspectRatio="none">
                  <path d="M0,15 Q0,12 3,12 L97,12 Q100,12 100,15 L100,60 Q100,65 95,65 L5,65 Q0,65 0,60 Z" />
                </svg>
                
                <!-- Folder Icon -->
                <div style="position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; opacity: 0.5; mix-blend-mode: overlay;">
                  <svg viewBox="0 0 24 24" style="width: 32px; height: 32px; fill: white; stroke: white; stroke-width: 1.5;" preserveAspectRatio="xMidYMid meet">
                    <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />
                  </svg>
                </div>
              </div>
            </div>
          `;
        } else {
          // 其他文件类型占位�?
          thumbElement.innerHTML = `<div style="font-size: 32px;">📄</div>`;
        }
      }
      
      thumbnailsContainer.appendChild(thumbElement);
    }
    
    // 绘制文件计数（如果超�?个）
    if (filesToDrag.length > 3) {
      const count = filesToDrag.length - 3;
      const countBadge = document.createElement('div');
      countBadge.style.position = 'absolute';
      // 计数徽章位置按比例调�?
      const badgeSize = 40 * (dragThumbSize / 200); // 基于200px容器�?0px徽章
      countBadge.style.right = `${12 * (dragThumbSize / 200)}px`;
      countBadge.style.bottom = `${12 * (dragThumbSize / 200)}px`;
      countBadge.style.width = `${badgeSize}px`;
      countBadge.style.height = `${badgeSize}px`;
      countBadge.style.borderRadius = '50%';
      countBadge.style.background = '#2563eb';
      countBadge.style.color = 'white';
      countBadge.style.display = 'flex';
      countBadge.style.alignItems = 'center';
      countBadge.style.justifyContent = 'center';
      countBadge.style.font = `bold ${14 * (dragThumbSize / 200)}px Arial, sans-serif`;
      countBadge.style.boxShadow = '0 2px 4px rgba(0, 0, 0, 0.2)';
      countBadge.textContent = `+${count}`;
      thumbnailsContainer.appendChild(countBadge);
    }
    
    // 添加到容�?
    dragImageContainer.appendChild(thumbnailsContainer);
    document.body.appendChild(dragImageContainer);
    
    // 设置拖拽图像
    try {
      // 拖拽图像偏移量应为容器尺寸的一半，确保鼠标指针在中�?
      const dragOffset = dragThumbSize / 2;
      e.dataTransfer.setDragImage(dragImageContainer, dragOffset, dragOffset);
    } catch (error) {
      // Error handling for drag image setup
    }
    
    // 设置拖拽效果为move，用于内部拖�?
    e.dataTransfer.effectAllowed = 'move';
    
    // 获取要拖拽的实际文件路径
    const draggedFiles = filesToDrag.map((fileId: string) => files[fileId]).filter((Boolean as unknown) as (file: FileNode | undefined) => file is FileNode);
    const draggedFilePaths = draggedFiles.map((file: FileNode) => file.path);
    
    // 设置内部拖拽标记
    if (setIsDraggingInternal) {
      setIsDraggingInternal(true);
    }
    
    // 保存拖拽的文件路�?
    if (setDraggedFilePaths) {
      setDraggedFilePaths(draggedFilePaths);
    }
    
    try {
      // 设置JSON格式的拖拽数据，用于内部处理
      e.dataTransfer.setData('application/json', JSON.stringify({
        type: 'file',
        ids: filesToDrag,
        sourceFolderId: file.parentId,
        // 添加内部拖拽标记
        internalDrag: true
      }));
      
      // 不设置外部拖拽数据，避免触发外部拖拽行为
      // 我们将在拖拽结束时检测是否拖拽到了外�?
    } catch (error) {
      console.error('Drag data setup error:', error);
    }
    
    // 通知父组件开始拖�?
    if (onDragStart) {
      onDragStart(filesToDrag);
    }
    
    // 在拖拽结束后清理临时元素
    const cleanupDragImage = () => {
      if (dragImageContainer.parentNode) {
        dragImageContainer.parentNode.removeChild(dragImageContainer);
      }
      document.removeEventListener('dragend', cleanupDragImage);
      document.removeEventListener('dragleave', cleanupDragImage);
    };
    
    document.addEventListener('dragend', cleanupDragImage);
    document.addEventListener('dragleave', cleanupDragImage);
  };

  const handleDragEnd = (e: React.DragEvent) => {
    e.stopPropagation();
    setIsDragging(false);
    
    // 清除内部拖拽标记
    if (setIsDraggingInternal) {
      setIsDraggingInternal(false);
    }
    
    if (onDragEnd) {
      onDragEnd();
    }
  };

  return (
    <div
        data-id={file.id}
        className={`
            file-item group cursor-pointer transition-all duration-300 ease-out flex flex-col items-center rounded-xl
            ${isSelected ? 'z-10' : 'z-0 hover:scale-[1.01]'}
            ${isDragging ? 'opacity-50 scale-95 drop-shadow-lg' : ''}
        `}
        style={{
            position: 'absolute',
            left: `${x}px`,
            top: `${y}px`,
            width: `${width}px`,
            height: `${height}px`,
            willChange: 'transform'
        }}
        draggable={true}
        onDragStart={handleDragStart}
        onDragEnd={handleDragEnd}
        onMouseDown={async (e) => {
            if (e.button === 0) {
                e.stopPropagation();
                
                // 按住 Alt 键时，启动外部拖拽（复制文件到外部应用）
                if (e.altKey && isTauriEnvironment()) {
                    e.preventDefault();
                    
                    // 获取要拖拽的文件
                    const filesToDrag = isSelected && selectedFileIds && selectedFileIds.length > 0 
                        ? selectedFileIds 
                        : [file.id];
                    
                    // 收集被拖拽文件的实际路径
                    const filePaths = filesToDrag
                        .map((fileId: string) => files[fileId]?.path || '')
                        .filter(Boolean);
                    
                    if (filePaths.length > 0) {
                        setIsDragging(true);
                        
                        // 设置内部拖拽标记，防止触发外部拖入覆盖层
                        if (setIsDraggingInternal) {
                            setIsDraggingInternal(true);
                        }
                        
                        // 获取缩略图路径（最�?个）
                        const pathCache = getThumbnailPathCache();
                        const thumbnailPaths = filePaths
                            .slice(0, 3)
                            .map((fp: string) => pathCache.get(fp))
                            .filter((p: string | undefined): p is string => !!p);
                        
                        // 计算缓存目录
                        const cacheDir = effectiveResourceRoot 
                            ? `${effectiveResourceRoot}${effectiveResourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache`
                            : undefined;
                        
                        try {
                            await startDragToExternal(filePaths, thumbnailPaths, cacheDir, () => {
                                setIsDragging(false);
                                if (setIsDraggingInternal) {
                                    setIsDraggingInternal(false);
                                }
                            });
                        } catch (error) {
                            console.error('External drag failed:', error);
                            setIsDragging(false);
                            if (setIsDraggingInternal) {
                                setIsDraggingInternal(false);
                            }
                        }
                    }
                }
            }
        }}
        onClick={(e) => {
            e.stopPropagation();
            onFileClick(e, file.id);
        }}
        onDoubleClick={(e) => {
            e.stopPropagation();
            onFileDoubleClick(file.id);
        }}
        onContextMenu={(e) => onContextMenu(e, file.id)}
        onMouseEnter={() => {
            // 从文件名提取格式作为fallback
            const fileName = file.name;
            const fileExt = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
            const isAnimationFormat = (file.meta?.format === 'gif' || file.meta?.format === 'webp') || (fileExt === 'gif' || fileExt === 'webp');
            
            if (settings?.animateOnHover && isAnimationFormat) {
                onSetHoverPlayingId(file.id);
            }
        }}
        onMouseLeave={() => {
            onSetHoverPlayingId(null);
        }}>
        <div
            className={`
                w-full flex-1 rounded-lg overflow-hidden border shadow-sm relative transition-all duration-300
                ${isSelected ? 'border-blue-500 border-2 ring-4 ring-blue-300/60 dark:ring-blue-700/60 shadow-lg shadow-blue-200/50 dark:shadow-blue-900/30' : isDragging ? 'border-blue-400 border-2 dashed bg-blue-50 dark:bg-blue-900/20' : 'border-gray-200 dark:border-gray-800 hover:border-gray-400 dark:hover:border-gray-500 bg-gray-100 dark:bg-gray-800'}
            `}
            style={{ 
                height: height ? (height - 40) : '100%',
                overflow: 'hidden'
            }}
        >
            {file.type === FileType.FOLDER ? (
            <FolderThumbnail file={file} files={files} mode={layoutMode} resourceRoot={effectiveResourceRoot} cachePath={effectiveCachePath} />
            ) : (
            <ImageThumbnail
                src={''}
                alt={file.name}
                isSelected={isSelected}
                filePath={file.path}
                modified={file.updatedAt}
                size={file.size}
                isHovering={hoverPlayingId === file.id}
                fileMeta={file.meta}
                resourceRoot={effectiveResourceRoot}
                cachePath={effectiveCachePath}
            />
            )}
            
            <div className={`absolute top-2 left-2 transition-opacity duration-200 ${isSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                {isSelected ? (
                    <div className="w-6 h-6 bg-blue-600 rounded-full flex items-center justify-center border-2 border-white shadow-lg ring-2 ring-blue-400/50">
                    <Check size={14} className="text-white" strokeWidth={3} />
                    </div>
                ) : (
                    <div className="w-5 h-5 bg-black/30 hover:bg-black/50 rounded-full border border-white/50 backdrop-blur-sm"></div>
                )}
            </div>

            <div className="absolute bottom-1 right-1 flex space-x-1 pointer-events-none">
            {file.type === FileType.IMAGE && (file.meta?.format === 'gif' || file.meta?.format === 'webp') && (
                <span className="text-[9px] font-bold bg-black/60 text-white px-1 rounded shadow-sm">{file.meta.format.toUpperCase()}</span>
            )}
            </div>
        </div>
        
        <div className="mt-1.5 w-full text-center px-1 h-8 flex flex-col justify-start leading-tight">
            {renamingId === file.id ? (
            <InlineRenameInput
                defaultValue={file.name}
                onCommit={(val: string) => onRenameSubmit(val, file.id)}
                onCancel={onRenameCancel}
            />
            ) : (
            <div
                className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate w-full"
                title={file.name}
                onDoubleClick={(e) => {
                e.stopPropagation();
                onStartRename(file.id);
                }}
            >
                {file.name}
            </div>
            )}
            {file.type === FileType.IMAGE && layoutMode !== 'masonry' && (
            <div className="text-[9px] text-gray-400 truncate">{file.meta ? `${file.meta.width}x${file.meta.height}` : ''}</div>
            )}
        </div>
    </div>
  );
});

const GroupContent = React.memo(({
  group,
  files,
  activeTab,
  renamingId,
  thumbnailSize,
  hoverPlayingId,
  handleFileClick,
  handleFileDoubleClick,
  handleContextMenu,
  handleStartRename,
  handleRenameSubmit,
  handleRenameCancel,
  handleSetHoverPlayingId,
  settings,
  containerRect,
  t,
  resourceRoot,
  cachePath,
  onDragStart,
  onDragEnd
}: any) => {
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);
  
  // Calculate layout for this group
  const { layout, totalHeight } = useLayout(
    group.fileIds,
    files,
    activeTab.layoutMode,
    containerRect.width,
    thumbnailSize,
    'browser'
  );

  // 移除虚拟滚动逻辑，直接使用所有项�?
  const visibleItems = layout;

  return (
    <div>
      {activeTab.layoutMode === 'list' ? (
        // List layout: keep padding for visual spacing
        <div className="p-6 overflow-hidden">
          {group.fileIds.map((id: string) => {
            const file = files[id];
            if (!file) return null;
            return (
              <FileListItem
                  key={file.id}
                  file={file}
                  files={files}
                  isSelected={activeTab.selectedFileIds.includes(file.id)}
                  renamingId={renamingId}
                  onFileClick={handleFileClick}
                  onFileDoubleClick={handleFileDoubleClick}
                  onContextMenu={handleContextMenu}
                  onStartRename={handleStartRename}
                  onRenameSubmit={handleRenameSubmit}
                  onRenameCancel={handleRenameCancel}
                  t={t}
                  resourceRoot={effectiveResourceRoot}
                  cachePath={effectiveCachePath}
                  selectedFileIds={activeTab.selectedFileIds}
                  onDragStart={onDragStart}
                  onDragEnd={onDragEnd}
                  thumbnailSize={thumbnailSize}
              />
            );
          })}
        </div>
      ) : (
        // Grid, adaptive, or masonry layout - 使用虚拟滚动
        // No outer padding here because the layout worker already includes internal padding
        <div 
          className="relative" 
          style={{ 
            width: '100%', 
            height: totalHeight 
          }}
        >
          {visibleItems.map((item) => {
            const file = files[item.id];
            if (!file) return null;
            
            return (
              <FileCard
                key={file.id}
                file={file}
                files={files}
                isSelected={activeTab.selectedFileIds.includes(file.id)}
                renamingId={renamingId}
                layoutMode={activeTab.layoutMode}
                hoverPlayingId={hoverPlayingId}
                onFileClick={handleFileClick}
                onFileDoubleClick={handleFileDoubleClick}
                onContextMenu={handleContextMenu}
                onStartRename={handleStartRename}
                onRenameSubmit={handleRenameSubmit}
                onRenameCancel={handleRenameCancel}
                onSetHoverPlayingId={handleSetHoverPlayingId}
                settings={settings}
                style={item}
                resourceRoot={effectiveResourceRoot}
                cachePath={effectiveCachePath}
                selectedFileIds={activeTab.selectedFileIds}
                onDragStart={onDragStart}
                onDragEnd={onDragEnd}
                thumbnailSize={thumbnailSize}
            />
            );
          })}
        </div>
      )}
    </div>
  );
});

const GroupHeader = React.memo(({ group, collapsed, onToggle }: { group: FileGroup, collapsed: boolean, onToggle: (id: string) => void }) => {
  return (
    <div 
      className="flex items-center py-1 px-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors sticky top-0 z-20"
      onClick={() => onToggle(group.id)}
    >
      <div className={`mr-2 p-1 rounded-full transition-transform duration-200 ${collapsed ? '-rotate-90' : 'rotate-0'}`}>
        <ChevronDown size={16} className="text-gray-500" />
      </div>
      <span className="font-bold text-sm text-gray-700 dark:text-gray-200">{group.title}</span>
      <span className="ml-2 text-xs text-gray-400 bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded-full">{group.fileIds.length}</span>
    </div>
  );
});

// removed local useLayout
// import { useLayout } from './useLayoutHook';
// interface LayoutItem was imported from useLayoutHook



interface FileGridProps {
  displayFileIds: string[];
  files: Record<string, FileNode>;
  activeTab: TabState;
  renamingId: string | null;
  thumbnailSize: number;
  hoverPlayingId: string | null;
  onSetHoverPlayingId: (id: string | null) => void;
  onFileClick: (e: React.MouseEvent, id: string) => void;
  onFileDoubleClick: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, id: string) => void;
  onRenameSubmit: (val: string, id: string) => void;
  onRenameCancel: () => void;
  onStartRename: (id: string) => void;
  containerRef?: React.RefObject<HTMLDivElement>;
  onMouseDown?: (e: React.MouseEvent) => void;
  onMouseMove?: (e: React.MouseEvent) => void;
  onMouseUp?: (e: React.MouseEvent) => void;
  onBackgroundContextMenu?: (e: React.MouseEvent) => void;
  people?: Record<string, Person>;
  groupedTags?: Record<string, string[]>;
  onPersonClick?: (id: string, e: React.MouseEvent) => void;
  onPersonContextMenu?: (e: React.MouseEvent, id: string) => void;
  onPersonDoubleClick?: (id: string) => void;
  onStartRenamePerson?: (personId: string) => void;
  onTagClick?: (tag: string, e: React.MouseEvent) => void;
  onTagContextMenu?: (e: React.MouseEvent, tag: string) => void;
  onTagDoubleClick?: (tag: string) => void;
  groupedFiles?: FileGroup[];
  groupBy?: GroupByOption;
  collapsedGroups?: Record<string, boolean>;
  onToggleGroup?: (id: string) => void;
  isSelecting?: boolean;
  selectionBox?: { startX: number; startY: number; currentX: number; currentY: number } | null;
  t: (key: string) => string;
  onThumbnailSizeChange?: (size: number) => void;
  onUpdateFile?: (id: string, updates: Partial<FileNode>) => void;
  settings?: import('../types').AppSettings;
  resourceRoot?: string;
  cachePath?: string;
  onScrollTopChange?: (scrollTop: number) => void;
  onDragStart?: (ids: string[]) => void;
  onDragEnd?: () => void;
  onDropOnFolder?: (targetFolderId: string, sourceIds: string[]) => void;
  isDraggingOver?: boolean;
  dragOverTarget?: string | null;
  // New props for external drag handling
  isDraggingInternal?: boolean;
  setIsDraggingInternal?: (isDragging: boolean) => void;
  setDraggedFilePaths?: (paths: string[]) => void;
  isVisible?: boolean;
  onConsumeScrollToItem?: () => void;
}

export const FileGrid: React.FC<FileGridProps> = ({
  displayFileIds,
  files,
  activeTab,
  renamingId,
  thumbnailSize,
  resourceRoot,
  cachePath,
  hoverPlayingId,
  onSetHoverPlayingId,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onRenameSubmit,
  onRenameCancel,
  onStartRename,
  containerRef,
  onMouseDown,
  onMouseMove,
  onMouseUp,
  onBackgroundContextMenu,
  people,
  groupedTags,
  onPersonClick,
  onPersonContextMenu,
  onPersonDoubleClick,
  onStartRenamePerson,
  onTagClick,
  onTagContextMenu,
  onTagDoubleClick,
  groupedFiles = [],
  groupBy = 'none',
  collapsedGroups = {},
  onToggleGroup,
  isSelecting,
  selectionBox,
  t,
  onThumbnailSizeChange,
  onUpdateFile,
  settings,
  onScrollTopChange,
  onDragStart,
  onDragEnd,
  onDropOnFolder,
  isDraggingOver,
  dragOverTarget,
  isDraggingInternal,
  setIsDraggingInternal,
  setDraggedFilePaths,
  isVisible = true,
  onConsumeScrollToItem
}) => {
  // #region agent log
  // Removed debug logs
  // #endregion

  
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);

  // #region agent log
  useEffect(() => {
      // Use console.warn for visibility in terminal
      console.warn(`FRONTEND_DEBUG: FileGrid effective props: resourceRoot=${effectiveResourceRoot}, cachePath=${effectiveCachePath}`);
  }, [effectiveResourceRoot, effectiveCachePath]);
  // #endregion
  const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
  const [scrollTop, setScrollTop] = useState(0);

  const handleTagClickStable = useCallback((tag: string, e: React.MouseEvent) => {
      onTagClick?.(tag, e);
  }, [onTagClick]);
  
  const handleTagDoubleClickStable = useCallback((tag: string) => {
      onTagDoubleClick?.(tag);
  }, [onTagDoubleClick]);
  
  const handleTagContextMenuStable = useCallback((e: React.MouseEvent, tag: string) => {
      onTagContextMenu?.(e, tag);
  }, [onTagContextMenu]);
  
  const handleFileClick = useCallback((e: React.MouseEvent, id: string) => {
      onFileClick(e, id);
  }, [onFileClick]);
  
  const handleFileDoubleClick = useCallback((id: string) => {
      onFileDoubleClick(id);
  }, [onFileDoubleClick]);
  
  const handleContextMenu = useCallback((e: React.MouseEvent, id: string) => {
      onContextMenu(e, id);
  }, [onContextMenu]);
  
  const handleRenameSubmit = useCallback((val: string, id: string) => {
      onRenameSubmit(val, id);
  }, [onRenameSubmit]);
  
  const handleRenameCancel = useCallback(() => {
      onRenameCancel();
  }, [onRenameCancel]);
  
  const handleStartRename = useCallback((id: string) => {
      onStartRename(id);
  }, [onStartRename]);
  
  const handleSetHoverPlayingId = useCallback((id: string | null) => {
      onSetHoverPlayingId(id);
  }, [onSetHoverPlayingId]);
  
  const handlePersonClick = useCallback((id: string, e: React.MouseEvent) => {
      onPersonClick?.(id, e);
  }, [onPersonClick]);
  
  const handlePersonContextMenu = useCallback((e: React.MouseEvent, id: string) => {
      onPersonContextMenu?.(e, id);
  }, [onPersonContextMenu]);
  
  const handlePersonDoubleClick = useCallback((id: string) => {
      onPersonDoubleClick?.(id);
  }, [onPersonDoubleClick]);
  
  const handleToggleGroup = useCallback((id: string) => {
      onToggleGroup?.(id);
  }, [onToggleGroup]);
  
  // Track if we're in the middle of a programmatic scroll restore
  const isRestoringScrollRef = useRef(false);
  // Track if we have successfully restored scroll position for the current view
  const hasRestoredRef = useRef(false);
  const restoreTimeoutRef = useRef<any>(null);
  // Store target scroll in ref to avoid closure trap in scroll handler
  const targetScrollRef = useRef(activeTab.scrollTop);

  // Reset restoration flag when key view parameters change
  useLayoutEffect(() => {
    if (isVisible) {
        hasRestoredRef.current = false;
        // Clear any pending timeout when reseting
        if (restoreTimeoutRef.current) {
             clearTimeout(restoreTimeoutRef.current);
        }
        isRestoringScrollRef.current = false;
    }
  }, [activeTab.id, activeTab.folderId, activeTab.viewMode, isVisible, activeTab.viewingFileId, activeTab.history?.currentIndex]);

  // Keep targetScrollRef in sync with activeTab.scrollTop
  useEffect(() => {
      targetScrollRef.current = activeTab.scrollTop;
  }, [activeTab.scrollTop]);

  const handleMouseDownInternal = useCallback((e: React.MouseEvent) => {
      // If user interacts, assume restoration is done/overridden
      hasRestoredRef.current = true;
      onMouseDown?.(e);
  }, [onMouseDown]);

  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
        // Build-in interaction check
        if (!e.ctrlKey) {
             hasRestoredRef.current = true;
        }

        if (e.ctrlKey && onThumbnailSizeChange) {
            e.preventDefault();
            const maxLimit = activeTab.viewMode === 'people-overview' ? 450 : 480;
            const minLimit = activeTab.viewMode === 'people-overview' ? 140 : 100;
            const step = 20;
            const delta = e.deltaY > 0 ? -step : step;
            const newSize = Math.max(minLimit, Math.min(maxLimit, thumbnailSize + delta));
            onThumbnailSizeChange(newSize);
        }
    };

    container.addEventListener('wheel', handleWheel, { passive: false });

    return () => {
        container.removeEventListener('wheel', handleWheel);
    };
  }, [containerRef, thumbnailSize, onThumbnailSizeChange, activeTab.viewMode]);

  useEffect(() => {
    if (!containerRef?.current) return;

    const rect = containerRef.current.getBoundingClientRect();
    if (rect.width > 0) {
        setContainerRect({ width: rect.width, height: rect.height });
    }

    let animationFrameId: number;
    const observer = new ResizeObserver((entries) => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        
        animationFrameId = requestAnimationFrame(() => {
            for (const entry of entries) {
                if (entry.target === containerRef.current) {
                    setContainerRect({ width: entry.contentRect.width, height: entry.contentRect.height });
                }
            }
        });
    });
    observer.observe(containerRef.current);
    
    // Use a stable handler ref or check current status inside handler
    const handleScroll = () => {
        if (containerRef.current) {
            // Skip reporting scroll updates if we are in the middle of restoring
            // or if layout is likely invalid (width 0)
            if (isRestoringScrollRef.current || containerRef.current.clientWidth === 0) {
                return;
            }

            const currentScroll = containerRef.current.scrollTop;
            const targetScroll = targetScrollRef.current; // Use ref to avoid closure trap
            
            // Defense against clamping:
            // If we haven't successfully restored yet, and the current scroll is significantly smaller
            // than the target scroll, it's likely due to container height being insufficient (clamped).
            // In this case, we should NOT update the parent state, so the original target remains for
            // subsequent attempts (e.g. after layout resize).
            if (!hasRestoredRef.current && targetScroll > 0 && currentScroll < targetScroll - 100) {
                 return;
            }

            setScrollTop(currentScroll);
            onScrollTopChange?.(currentScroll);
        }
    };
    containerRef.current.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        observer.disconnect();
        containerRef?.current?.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef]);

  const { layout, totalHeight } = useLayout(
      activeTab.viewMode === 'people-overview' ? [] : displayFileIds,
      files,
      activeTab.layoutMode,
      containerRect.width,
      thumbnailSize,
      activeTab.viewMode as any,
      groupedTags,
      people,
      activeTab.searchQuery
  );

  useLayoutEffect(() => {
      if (!isVisible) return;

      if (containerRef?.current && !hasRestoredRef.current && containerRect.width > 0) {
           const targetScroll = activeTab.scrollTop;
          
           if(targetScroll > 0) {
               isRestoringScrollRef.current = true;
               containerRef.current.scrollTop = targetScroll;
               setScrollTop(targetScroll);
               
               if (restoreTimeoutRef.current) {
                   clearTimeout(restoreTimeoutRef.current);
               }

               restoreTimeoutRef.current = setTimeout(() => {
                   isRestoringScrollRef.current = false;
               }, 100);

               const currentScroll = containerRef.current.scrollTop;
               const isClamped = Math.abs(currentScroll - targetScroll) > 10;
               
               if (!isClamped) {
                   hasRestoredRef.current = true;
               }
           } else {
              // Explicitly reset scroll to 0 if target is 0, to handle component reuse
              if (containerRef.current.scrollTop !== 0) {
                  isRestoringScrollRef.current = true;
                  containerRef.current.scrollTop = 0;
                  setScrollTop(0);
                  
                  if (restoreTimeoutRef.current) {
                      clearTimeout(restoreTimeoutRef.current);
                  }
   
                  restoreTimeoutRef.current = setTimeout(() => {
                      isRestoringScrollRef.current = false;
                  }, 50);
              }
              hasRestoredRef.current = true;
           }
      }
  }, [activeTab.id, activeTab.folderId, activeTab.viewMode, activeTab.scrollTop, containerRect.width, totalHeight, isVisible]);

  // Handle scrolling to specific item
  useEffect(() => {
      // Only run if we have a target item ID and layout is ready
      // IMPORTANT: Must wait for containerRect.width > 0 to ensure layout is calculated correctly based on container width
      if (!isVisible || !activeTab.scrollToItemId || !containerRef?.current || layout.length === 0 || containerRect.width <= 0 || containerRect.height <= 0) return;

      const item = layout.find(i => i.id === activeTab.scrollToItemId);
      
      if (item) {
         const containerHeight = containerRect.height;
         const itemTop = item.y;
         const itemHeight = item.height;
         
         // Calculate scroll position to center the item
         let newScrollTop = itemTop - (containerHeight / 2) + (itemHeight / 2);
         
         // Clamp based on total layout height
         newScrollTop = Math.max(0, Math.min(newScrollTop, totalHeight - containerHeight));
         
         // If totalHeight is smaller than container, scrollTop should be 0
         if (totalHeight < containerHeight) {
            newScrollTop = 0;
         }

         // Log for debugging
         // console.log(`[FileGrid] ScrollToItem: ${activeTab.scrollToItemId}, itemY=${itemTop}, newScroll=${newScrollTop}, containerH=${containerHeight}`);
         
         // Temporarily block scroll updates to state
         isRestoringScrollRef.current = true;
         containerRef.current.scrollTop = newScrollTop;
         setScrollTop(newScrollTop);
         
         if (restoreTimeoutRef.current) {
             clearTimeout(restoreTimeoutRef.current);
         }
         
         // Slightly longer timeout to ensure scroll settles
         restoreTimeoutRef.current = setTimeout(() => {
             isRestoringScrollRef.current = false;
         }, 150);

         onConsumeScrollToItem?.();
      }
  }, [activeTab.scrollToItemId, layout, isVisible, containerRect.width, containerRect.height, totalHeight]);

  const visibleItems = useMemo(() => {
      const buffer = 800; 
      const minY = scrollTop - buffer;
      const maxY = scrollTop + containerRect.height + buffer;
      return layout.filter(item => item.y < maxY && item.y + item.height > minY);
  }, [layout, scrollTop, containerRect.height, totalHeight]);

  const sortedKeys = useMemo(() => {
      if (!groupedTags) return [];
      const keys = Object.keys(groupedTags);
      return sortKeys(keys);
  }, [groupedTags]);

  if (activeTab.viewMode === 'tags-overview') {
      return (
          <div
              ref={containerRef}
              className="w-full h-full overflow-y-auto overflow-x-hidden px-6 pb-6 relative"
              onContextMenu={onBackgroundContextMenu}
              onMouseDown={handleMouseDownInternal}
              onMouseMove={onMouseMove}
              onMouseUp={onMouseUp}
          >
              <div className="absolute inset-0 pointer-events-none z-50">
                  {selectionBox && (
                      <div
                          className="absolute border-2 border-blue-500 bg-blue-100 dark:bg-blue-900/20 opacity-50 pointer-events-none"
                          style={{
                              left: Math.min(selectionBox.startX, selectionBox.currentX),
                              top: Math.min(selectionBox.startY, selectionBox.currentY),
                              width: Math.abs(selectionBox.currentX - selectionBox.startX),
                              height: Math.abs(selectionBox.currentY - selectionBox.startY),
                          }}
                      />
                  )}
              </div>
              <TagsList
                  groupedTags={groupedTags || {}}
                  keys={sortedKeys}
                  files={files}
                  selectedTagIds={activeTab.selectedTagIds}
                  onTagClick={handleTagClickStable}
                  onTagDoubleClick={handleTagDoubleClickStable}
                  onTagContextMenu={handleTagContextMenuStable}
                  t={t}
                  searchQuery={activeTab.searchQuery}
              />
          </div>
      );
  }

  const handleDragOver = (e: React.DragEvent) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      
      // 检查是否拖拽到文件夹上
      const target = e.target as HTMLElement;
      const folderElement = target.closest('.file-item[data-id]');
      if (folderElement) {
          const folderId = folderElement.getAttribute('data-id');
          if (folderId) {
              const folder = files[folderId];
              if (folder && folder.type === FileType.FOLDER) {
                  // 添加拖拽悬停的视觉效�?
                  folderElement.classList.add('drop-target-active');
                  if (onDropOnFolder && dragOverTarget !== folderId) {
                      // 这里可以设置视觉反馈
                  }
              }
          }
      }
  };

  const handleDrop = (e: React.DragEvent) => {
      e.preventDefault();
      
      try {
          const data = e.dataTransfer.getData('application/json');
          if (!data) return;
          
          const { type, ids } = JSON.parse(data);
          if (type !== 'file' || !ids || ids.length === 0) return;
          
          // 清除所有悬停状�?
          const allFolders = document.querySelectorAll('.file-item[data-id]');
          allFolders.forEach(el => el.classList.remove('drop-target-active'));
          
          // 检查是否拖拽到特定文件�?
          const target = e.target as HTMLElement;
          const folderElement = target.closest('.file-item[data-id]');
          
          if (folderElement) {
              const targetFolderId = folderElement.getAttribute('data-id');
              if (targetFolderId) {
                  const targetFolder = files[targetFolderId];
                  
                  if (targetFolder && targetFolder.type === FileType.FOLDER) {
                      // 拖拽到文件夹
                      if (onDropOnFolder) {
                          onDropOnFolder(targetFolderId, ids);
                      }
                  }
              }
          } else {
              // 拖拽到空白区域（移动到当前目录）
              const currentFolderId = activeTab.folderId;
              if (currentFolderId && onDropOnFolder) {
                  // 检查是否所有文件都已经在当前文件夹�?
                  const allFilesInCurrentFolder = ids.every((id: string) => {
                      const file = files[id];
                      return file && file.parentId === currentFolderId;
                  });
                  
                  // 如果所有文件都在当前文件夹中，不执行任何操�?
                  if (allFilesInCurrentFolder) {
                      return;
                  }
                  
                  onDropOnFolder(currentFolderId, ids);
              }
          }
      } catch (error) {
          console.error('Drop handling error:', error);
      }
  };

  return (
      <div
          ref={containerRef}
          className={`relative w-full h-full min-w-0 overflow-y-auto overflow-x-hidden transition-all duration-200 ${isDraggingOver ? 'bg-gradient-to-b from-blue-50 to-transparent dark:from-blue-900/15 dark:to-transparent border-2 border-dashed border-blue-300 dark:border-blue-700/50' : ''}`}
          onContextMenu={onBackgroundContextMenu}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onDragOver={handleDragOver}
          onDrop={handleDrop}
          onDragLeave={() => {
              const allFolders = document.querySelectorAll('.file-item[data-id]');
              allFolders.forEach(el => el.classList.remove('drop-target-active'));
          }}
      >
          <div className="absolute inset-0 pointer-events-none z-50">
              {selectionBox && (
                  <div
                      className="absolute border-2 border-blue-500 bg-blue-100 dark:bg-blue-900/20 opacity-50 pointer-events-none"
                      style={{
                          left: Math.min(selectionBox.startX, selectionBox.currentX),
                          top: Math.min(selectionBox.startY, selectionBox.currentY),
                          width: Math.abs(selectionBox.currentX - selectionBox.startX),
                          height: Math.abs(selectionBox.currentY - selectionBox.startY),
                      }}
                  />
              )}
          </div>

          {activeTab.viewMode === 'people-overview' ? (
              <PersonGrid
                  people={people || {}}
                  files={files}
                  selectedPersonIds={activeTab.selectedPersonIds}
                  onPersonClick={handlePersonClick}
                  onPersonDoubleClick={handlePersonDoubleClick}
                  onPersonContextMenu={handlePersonContextMenu}
                  onStartRenamePerson={onStartRenamePerson}
                  t={t}
                  thumbnailSize={thumbnailSize}
                  containerRect={containerRect}
                  scrollTop={activeTab.scrollTop}
                  containerRef={containerRef}
              />
          ) : groupBy !== 'none' && groupedFiles && groupedFiles.length > 0 ? (
              <div className="w-full min-w-0">
                  {groupedFiles.map((group) => (
                      <div key={group.id} className={collapsedGroups[group.id] ? 'mb-2' : 'mb-8'}>
                          <GroupHeader
                              group={group}
                              collapsed={!!collapsedGroups[group.id]}
                              onToggle={handleToggleGroup}
                          />
                          {!collapsedGroups[group.id] && (
                              <GroupContent
                                  group={group}
                                  files={files}
                                  activeTab={activeTab}
                                  renamingId={renamingId}
                                  thumbnailSize={thumbnailSize}
                                  hoverPlayingId={hoverPlayingId}
                                  handleFileClick={handleFileClick}
                                  handleFileDoubleClick={handleFileDoubleClick}
                                  handleContextMenu={handleContextMenu}
                                  handleStartRename={handleStartRename}
                                  handleRenameSubmit={handleRenameSubmit}
                                  handleRenameCancel={handleRenameCancel}
                                  handleSetHoverPlayingId={handleSetHoverPlayingId}
                                  settings={settings}
                                  containerRect={containerRect}
                                  t={t}
                                  resourceRoot={effectiveResourceRoot}
                                  cachePath={effectiveCachePath}
                                  onDragStart={onDragStart}
                                  onDragEnd={onDragEnd}
                              />
                          )}
                      </div>
                  ))}
              </div>
          ) : activeTab.layoutMode === 'list' ? (
              <div className="w-full h-full min-w-0 overflow-y-auto overflow-x-hidden">
                  <div className="p-6">
                      {displayFileIds.map((id) => {
                          const file = files[id];
                          if (!file) return null;
                          return (
                              <FileListItem
                                  key={file.id}
                                  file={file}
                                  files={files}
                                  isSelected={activeTab.selectedFileIds.includes(file.id)}
                                  renamingId={renamingId}
                                  onFileClick={handleFileClick}
                                  onFileDoubleClick={handleFileDoubleClick}
                                  onContextMenu={handleContextMenu}
                                  onStartRename={onStartRename}
                                  onRenameSubmit={onRenameSubmit}
                                  onRenameCancel={onRenameCancel}
                                  t={t}
                                  resourceRoot={effectiveResourceRoot}
                                  cachePath={effectiveCachePath}
                                  selectedFileIds={activeTab.selectedFileIds}
                                  onDragStart={onDragStart}
                                  onDragEnd={onDragEnd}
                                  thumbnailSize={thumbnailSize}
                                  setIsDraggingInternal={setIsDraggingInternal}
                                  setDraggedFilePaths={setDraggedFilePaths}
                              />
                          );
                      })}
                  </div>
              </div>
          ) : (
              <div className="w-full min-w-0" style={{ position: 'relative', minHeight: '100%' }}>
                  <div className="min-w-0" style={{ position: 'relative' }}>
                      {/* Fixed height container to prevent scroll bounce */}
                      <div
                          className="relative min-w-0"
                          style={{
                              width: '100%',
                              maxWidth: '100%',
                              height: totalHeight,
                              position: 'relative'
                          }}
                      >
                          {visibleItems.map((item) => {
                              const file = files[item.id];
                              if (!file) return null;
                              
                              return (
                                  <FileCard
                                      key={file.id}
                                      file={file}
                                      files={files}
                                      isSelected={activeTab.selectedFileIds.includes(file.id)}
                                      renamingId={renamingId}
                                      layoutMode={activeTab.layoutMode}
                                      hoverPlayingId={hoverPlayingId}
                                      onFileClick={handleFileClick}
                                      onFileDoubleClick={handleFileDoubleClick}
                                      onContextMenu={handleContextMenu}
                                      onStartRename={onStartRename}
                                      onRenameSubmit={handleRenameSubmit}
                                      onRenameCancel={handleRenameCancel}
                                      onSetHoverPlayingId={handleSetHoverPlayingId}
                                      settings={settings}
                                      style={item}
                                      resourceRoot={effectiveResourceRoot}
                                      cachePath={effectiveCachePath}
                                      selectedFileIds={activeTab.selectedFileIds}
                                      onDragStart={onDragStart}
                                      onDragEnd={onDragEnd}
                                      thumbnailSize={thumbnailSize}
                                      setIsDraggingInternal={setIsDraggingInternal}
                                      setDraggedFilePaths={setDraggedFilePaths}
                                  />
                              );
                          })}
                      </div>
                  </div>
              </div>
          )}
      </div>
  );
};
