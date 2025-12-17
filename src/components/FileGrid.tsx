
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { LayoutMode, FileNode, FileType, TabState, Person, GroupByOption, FileGroup } from '../types';
import { getFolderPreviewImages, formatSize } from '../utils/mockFileSystem';
import { Image as ImageIcon, Check, Folder, Tag, User, ChevronDown, Book, Film } from 'lucide-react';
import md5 from 'md5';

// 扩展 Window 接口以包含我们的全局缓存
declare global {
  interface Window {
    __AURORA_THUMBNAIL_CACHE__?: Map<string, string>;
  }
}

// 获取或初始化全局缓存 (挂载在 window 上以防热更新丢失)
const getGlobalCache = () => {
  if (!window.__AURORA_THUMBNAIL_CACHE__) {
    window.__AURORA_THUMBNAIL_CACHE__ = new Map<string, string>();
  }
  return window.__AURORA_THUMBNAIL_CACHE__;
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
        <div className={`relative w-full h-full group select-none ${className}`}>
             {/* Back Plate */}
             <svg viewBox="0 0 100 85" className={`absolute w-full h-full drop-shadow-sm transition-colors ${style.back}`} style={{top: 0}} preserveAspectRatio="none">
                 <path d="M5,15 L35,15 L45,25 L95,25 C97,25 99,27 99,30 L99,80 C99,83 97,85 95,85 L5,85 C3,85 1,83 1,80 L1,20 C1,17 3,15 5,15 Z" fill="currentColor" />
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
                 <svg viewBox="0 0 100 55" className={`w-full h-full drop-shadow-lg ${style.front}`} preserveAspectRatio="none">
                     <path d="M0,8 Q0,5 3,5 L97,5 Q100,5 100,8 L100,50 Q100,55 95,55 L5,55 Q0,55 0,50 Z" fill="currentColor" />
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
  // 简化 Key: 只使用 filePath，提高命中率。文件修改后 getThumbnail 仍会更新图片。
  const [thumbnailSrc, setThumbnailSrc] = React.useState<string | null>(() => {
      if (!filePath) return null;
      // const key = `${filePath}|${modified || ''}`; 
      const key = filePath; 
      const cache = getGlobalCache();
      return cache.get(key) || null;
  });
  
  const [animSrc, setAnimSrc] = React.useState<string | null>(null);
  // 如果有缓存，初始 loading 为 false
  const [loading, setLoading] = React.useState(!thumbnailSrc);

  React.useEffect(() => {
    // Only load thumbnail if the component is in view or was previously in view
    if ((isInView || wasInView) && filePath && resourceRoot) {
      const cache = getGlobalCache();
      const key = filePath; // 保持 Key 一致

      // 如果已经有图了（比如从缓存中读到的），且 URL 没变，就不用重新加载
      if (thumbnailSrc && cache.get(key) === thumbnailSrc) {
          // 这里可以不做任何事，但为了应对文件修改的情况，
          // 可以选择继续请求，或者信任缓存。
          // 考虑到用户对“闪烁”敏感，我们优先信任缓存。
          // 如果真的需要更新，可以通过文件修改时间对比（这里略过，优先流畅度）
          // return; 
      }

      const controller = new AbortController();
      const loadThumbnail = async () => {
        // 只有当没有当前数据时才显示 loading
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
        // 从文件路径提取格式
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
    // 使用栈进行 DFS，或者队列进行 BFS
    const stack: string[] = [...(rootFolder.children || [])];
    const visited = new Set<string>(); // 防止循环引用
    
    // 设置一个遍历上限，防止超大文件夹卡死 UI
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
    
    // 排序并切片
    return images
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        .slice(0, limit);
};

export const FolderThumbnail = React.memo(({ file, files, mode, resourceRoot, cachePath }: { file: FileNode; files: Record<string, FileNode>, mode: LayoutMode, resourceRoot?: string, cachePath?: string }) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '200px' });
  
  // 1. 同步计算需要展示的子文件 (改为深度查找)
  const imageChildren = useMemo(() => {
      if (!file.children || file.children.length === 0) return [];
      return findImagesDeeply(file, files, 3);
  }, [file, files]);

  // 2. 初始化时尝试从全局缓存同步读取
  const [previewSrcs, setPreviewSrcs] = useState<string[]>(() => {
      const cache = getGlobalCache();
      // 尝试映射所有子文件到缓存中的 URL
      const cachedUrls = imageChildren.map(child => {
          // 使用与 ImageThumbnail 相同的 Key 生成逻辑 (仅 filePath)
          return cache.get(child.path) || null; 
      });
      
      // 只有当所有需要的图片都有缓存时，才视为命中 (或者至少有一张？)
      // 为了体验最好，只要有缓存就先用。过滤掉 null。
      const validUrls = cachedUrls.filter((url): url is string => !!url);
      
      // 如果没有缓存，返回空数组
      return validUrls;
  });

  // 如果初始就有数据（哪怕只有一张），就不设为 loaded=false，避免闪烁
  const [loaded, setLoaded] = useState(previewSrcs.length > 0);

  useEffect(() => {
    // 如果已经加载过了，且数量足够（或者等于子文件总数），就不再请求
    // 注意：这里简单判断，如果缓存里不够 3 张但实际有 3 张，还是会触发请求补全
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
              // 先查缓存，如果有就不请求了 (虽然 getThumbnail 内部也有 batcher，但这里拦截更快)
              const cache = getGlobalCache();
              const cached = cache.get(img.path);
              if (cached) return cached;

              // 请求新图
              const url = await getThumbnail(img.path, img.updatedAt, resourceRoot, controller.signal);
              if (url) {
                  cache.set(img.path, url); // 更新缓存
              }
              return url;
          });

          const thumbnails = await Promise.all(promises);
          
          if (!controller.signal.aborted) {
            const validThumbnails = thumbnails.filter((t): t is string => !!t);
            // 只有当结果不同时才更新状态
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
          <div className="relative w-full h-full p-2">
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
      className={`tag-item rounded-lg p-4 border cursor-pointer group transition-all relative ${isSelected ? 'bg-blue-100 dark:bg-blue-900/40 border-blue-500' : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-700 hover:border-blue-500 dark:hover:border-blue-500'}`} 
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
      {isSelected && (<div className="absolute top-2 left-2 w-2 h-2 bg-blue-500 rounded-full"></div>)}
    </div>
  );
});

const TagsList = React.memo(({ groupedTags, keys, files, selectedTagIds, onTagClick, onTagDoubleClick, onTagContextMenu, t }: any) => {
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);
  const [hoveredTagPos, setHoveredTagPos] = useState<{ top: number, left: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
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

  return (
    <div className="relative">
      {/* 字母索引栏 */}
      {keys.length > 0 && (
        <div className="fixed top-1/2 transform -translate-y-1/2 z-20 bg-white/80 dark:bg-gray-950/80 backdrop-blur-sm rounded-full px-1 py-2 shadow-md border border-gray-200 dark:border-gray-800 transition-all duration-300"
             style={{ 
               right: 'calc(20px + var(--metadata-panel-width, 0px))',
               transform: 'translateY(-50%) translateY(10px)' // 向下调整10px，使其居中
             }}
             onMouseEnter={() => {
              // 鼠标悬停时，确保索引栏显示在最前面
              const metadataPanel = document.querySelector('.metadata-panel-container') as HTMLElement | null;
              if (metadataPanel) {
                metadataPanel.style.zIndex = '10';
              }
            }}
            onMouseLeave={() => {
              // 鼠标离开时，恢复详情面板的z-index
              const metadataPanel = document.querySelector('.metadata-panel-container') as HTMLElement | null;
              if (metadataPanel) {
                metadataPanel.style.zIndex = '40';
              }
            }}
        >
          <div className="flex flex-col items-center space-y-1">
            {keys.map((group: string) => (
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
        </div>
      )}
      
      {/* 标签列表内容 */}
      {keys.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <Tag size={64} className="mb-4 opacity-20"/>
              <p>{t('sidebar.noTagsFound')}</p>
          </div>
      )}
      {keys.map((group: string) => {
          const tagsInGroup = groupedTags[group];
          return (
              <div id={`tag-group-${group}`} key={group} className="mb-8 scroll-mt-4">
                   <div className="flex items-center mb-0 border-b border-gray-100 dark:border-gray-800 pt-3 pb-3 sticky top-0 bg-white/95 dark:bg-gray-950/95 z-10 backdrop-blur-sm transition-colors h-16">
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
          className="fixed z-[100] bg-white dark:bg-[#2d3748] border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 w-64 animate-fade-in pointer-events-none" 
          style={{ top: hoveredTagPos.top, left: hoveredTagPos.left }}
        >
          <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 border-b border-gray-200 dark:border-gray-600 pb-1 font-bold flex items-center justify-between">
             <span>{t('sidebar.tagPreview')} "{hoveredTag}"</span>
             <span className="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 rounded">{previewImages.length} {t('sidebar.recent')}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {previewImages.map((f: any) => (
              <div key={f.id} className="aspect-square bg-gray-100 dark:bg-black rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
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
           prev.keys === next.keys; 
});

const FileListItem = React.memo(({
  file,
  isSelected,
  renamingId,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDropOnFolder,
  onDropExternal,
  t,
  dragTargetId
}: any) => {
  if (!file) return null;
  return (
    <div
        data-id={file.id}
        draggable={renamingId !== file.id}
        className={`
            file-item flex items-center p-2 rounded text-sm cursor-pointer border transition-colors mb-1
            ${isSelected ? 'bg-blue-100 dark:bg-blue-900/30 border-blue-500/50' : 'bg-white dark:bg-gray-900 border-transparent hover:bg-gray-50 dark:hover:bg-gray-800/50'}
            ${dragTargetId === file.id ? 'border-green-500 bg-green-50 dark:bg-green-900/20' : ''}
        `}
        onMouseDown={(e) => {
            if (e.button === 0) e.stopPropagation();
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
        onDragStart={(e) => onDragStart && onDragStart(e, file.id)}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation(); // 阻止事件冒泡，防止触发外层的 Drop

            if (file.type === FileType.FOLDER) {
                // 尝试获取 JSON 数据 (虽然后面 startDrag 可能会清空它，但保留这个逻辑兼容 Web 模式)
                const data = e.dataTransfer.getData('application/json');
                let parsedIds: string[] = [];

                if (data) {
                    try { parsedIds = JSON.parse(data); } catch (err) {}
                }

                // 逻辑分流：
                if (parsedIds.length > 0) {
                    // 情况1: 明确读到了 ID，肯定是内部移动
                    onDropOnFolder(file.id, parsedIds);
                } else {
                    // 情况2: 没读到 ID。
                    // 此时可能是：
                    // A. 内部原生拖拽 (startDrag 导致数据被清空)
                    // B. 真正的外部文件拖入
                    
                    // 我们直接传空数组 [] 给 onDropOnFolder。
                    // App.tsx 会检查 isInternalDragRef：
                    //   - 如果是 true -> 视为内部移动，使用 selectedFileIds
                    //   - 如果是 false -> 视为外部文件
                    onDropOnFolder(file.id, []);
                    
                    // 补充：如果是外部文件，且 App.tsx 的 onDropOnFolder 没处理(因为它判断不是内部)，
                    // 我们还需要给外部文件一个入口。
                    // 但由于我们在 onDropOnFolder 里做了判断，如果 App.tsx 发现不是内部拖拽，
                    // 它可以选择忽略，然后我们需要在这里手动触发 external。
                    
                    // 更稳妥的写法是结合父组件的逻辑。
                    // 简单方案：
                    if (e.dataTransfer.files.length > 0) {
                         // 把文件路径提取出来传出去，让父组件再次通过 Ref 判断
                         const filePaths = Array.from(e.dataTransfer.files).map((f: any) => f.path).filter(Boolean);
                         if (onDropExternal) {
                             onDropExternal(file.id, filePaths);
                         }
                    }
                }
            }
        }}
    >
        <div className="flex-1 flex items-center overflow-hidden min-w-0 pointer-events-none">
            {file.type === FileType.FOLDER ? (
            <Folder className="text-blue-500 mr-3 shrink-0" size={18} />
            ) : (
            <div className="w-6 h-6 mr-3 bg-gray-200 dark:bg-gray-700 rounded overflow-hidden shrink-0">
                {/* Note: file.url is a file path in Tauri, not a usable URL. We'll use a placeholder or load thumbnail separately if needed */}
                <div className="w-full h-full bg-gray-300 dark:bg-gray-600 flex items-center justify-center">
                    <ImageIcon className="text-gray-400 dark:text-gray-500" size={14} />
                </div>
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

const PersonCard = React.memo(({
  person,
  files,
  isSelected,
  onPersonClick,
  onPersonDoubleClick,
  onStartRenamePerson,
  onPersonContextMenu,
  t,
  style
}: {
  person: Person;
  files: Record<string, FileNode>;
  isSelected: boolean;
  onPersonClick: (id: string, e: React.MouseEvent) => void;
  onPersonDoubleClick: (id: string) => void;
  onStartRenamePerson?: (id: string) => void;
  onPersonContextMenu: (e: React.MouseEvent, id: string) => void;
  t: (key: string) => string;
  style: any;
}) => {
  if (!person) return null;
  
  const coverFile = files[person.coverFileId];
  const hasCover = !!coverFile;
  const { width, height, x, y } = style;
  const avatarSize = Math.min(width, height - 60); // Allow space for text

  return (
    <div
      className="absolute flex flex-col items-center group cursor-pointer transition-all duration-300"
      style={{ left: x, top: y, width, height }}
      onClick={(e) => onPersonClick(person.id, e)}
      onContextMenu={(e) => onPersonContextMenu(e, person.id)}
    >
      <div 
        className={`rounded-full p-1 transition-all duration-300 relative shadow-md group-hover:shadow-xl group-hover:-translate-y-1
          ${isSelected 
            ? 'bg-blue-600 scale-105' 
            : 'bg-gradient-to-tr from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-600 hover:from-blue-400 hover:to-blue-600'
          }
        `}
        style={{ width: avatarSize, height: avatarSize }}
        onDoubleClick={() => onPersonDoubleClick(person.id)}
      >
        <div className="w-full h-full rounded-full bg-white dark:bg-gray-800 overflow-hidden border-[3px] border-white dark:border-gray-800 relative">
          {hasCover ? (
            person.faceBox ? (
              <div 
                className="w-full h-full"
                style={{
                  // Note: In Tauri, file.url is a file path. We need to load thumbnail separately.
                  // For now, use a placeholder background
                  backgroundSize: `${10000 / Math.min(person.faceBox.w, 99.9)}% ${10000 / Math.min(person.faceBox.h, 99.9)}%`,
                  backgroundPosition: `${person.faceBox.x / (100 - Math.min(person.faceBox.w, 99.9)) * 100}% ${person.faceBox.y / (100 - Math.min(person.faceBox.h, 99.9)) * 100}%`,
                  backgroundRepeat: 'no-repeat',
                  backgroundColor: 'rgba(0,0,0,0.1)'
                }}
              />
            ) : (
              // Note: In Tauri, file.url is a file path, not a usable URL. Use placeholder for now.
              <div className="w-full h-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                <User size={avatarSize * 0.4} className="text-gray-400 dark:text-gray-500" />
              </div>
            )
          ) : (
            <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-700 text-gray-300 dark:text-gray-500">
              <User size={avatarSize * 0.4} strokeWidth={1.5} />
            </div>
          )}
        </div>
        
        {/* Selection Checkmark */}
        {isSelected && (
          <div className="absolute bottom-0 right-0 bg-blue-600 text-white rounded-full p-1 border-2 border-white dark:border-gray-900">
            <Check size={Math.max(12, avatarSize * 0.15)} strokeWidth={3} />
          </div>
        )}
      </div>
      
      <div className="mt-4 text-center w-full px-2">
        <div 
          className={`font-bold text-base truncate transition-colors px-2 rounded-md ${isSelected ? 'text-blue-600 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/30' : 'text-gray-800 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400'}`}
          onDoubleClick={() => onStartRenamePerson?.(person.id)}
        >
          {person.name}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-medium">
          {person.count} {t('context.files')}
        </div>
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
  dragTargetId,
  onFileClick,
  onFileDoubleClick,
  onContextMenu,
  onStartRename,
  onRenameSubmit,
  onRenameCancel,
  onSetHoverPlayingId,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDropOnFolder,
  onDropExternal,
  style,
  settings,
  resourceRoot,
  cachePath
}: any) => {
  if (!file) return null;

  // Extract layout positioning
  const { x, y, width, height } = style || { x: 0, y: 0, width: 200, height: 200 };
  
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);

  return (
    <div
        data-id={file.id}
        draggable={renamingId !== file.id}
        onDragStart={(e) => onDragStart(e, file.id)}
        onDragEnd={onDragEnd}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={(e) => {
            e.preventDefault();
            e.stopPropagation(); // 阻止事件冒泡，防止触发外层的 Drop

            if (file.type === FileType.FOLDER) {
                // 尝试获取 JSON 数据 (虽然后面 startDrag 可能会清空它，但保留这个逻辑兼容 Web 模式)
                const data = e.dataTransfer.getData('application/json');
                let parsedIds: string[] = [];

                if (data) {
                    try { parsedIds = JSON.parse(data); } catch (err) {}
                }

                // 逻辑分流：
                if (parsedIds.length > 0) {
                    // 情况1: 明确读到了 ID，肯定是内部移动
                    onDropOnFolder(file.id, parsedIds);
                } else {
                    // 情况2: 没读到 ID。
                    // 此时可能是：
                    // A. 内部原生拖拽 (startDrag 导致数据被清空)
                    // B. 真正的外部文件拖入
                    
                    // 我们直接传空数组 [] 给 onDropOnFolder。
                    // App.tsx 会检查 isInternalDragRef：
                    //   - 如果是 true -> 视为内部移动，使用 selectedFileIds
                    //   - 如果是 false -> 视为外部文件
                    onDropOnFolder(file.id, []);
                    
                    // 补充：如果是外部文件，且 App.tsx 的 onDropOnFolder 没处理(因为它判断不是内部)，
                    // 我们还需要给外部文件一个入口。
                    // 但由于我们在 onDropOnFolder 里做了判断，如果 App.tsx 发现不是内部拖拽，
                    // 它可以选择忽略，然后我们需要在这里手动触发 external。
                    
                    // 更稳妥的写法是结合父组件的逻辑。
                    // 简单方案：
                    if (e.dataTransfer.files.length > 0) {
                         // 把文件路径提取出来传出去，让父组件再次通过 Ref 判断
                         const filePaths = Array.from(e.dataTransfer.files).map((f: any) => f.path).filter(Boolean);
                         if (onDropExternal) {
                             onDropExternal(file.id, filePaths);
                         }
                    }
                }
            }
        }}
        className={`
            file-item group cursor-pointer transition-all duration-300 ease-out flex flex-col items-center
            ${isSelected ? 'z-10' : 'z-0 hover:scale-[1.01]'}
        `}
        style={{
            position: 'absolute',
            left: `${x}px`,
            top: `${y}px`,
            width: `${width}px`,
            height: `${height}px`,
            willChange: 'transform'
        }}
        onMouseDown={(e) => {
            if (e.button === 0) e.stopPropagation();
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
                ${isSelected ? 'border-blue-500 ring-2 ring-blue-200 dark:ring-blue-900' : 'border-gray-200 dark:border-gray-700 hover:border-gray-400 dark:hover:border-gray-500 bg-gray-100 dark:bg-gray-800'}
                ${dragTargetId === file.id ? 'border-green-500 bg-green-50 dark:bg-green-900/20 scale-105' : ''}
            `}
            style={{ height: height ? (height - 40) : '100%' }}
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
                    <div className="w-5 h-5 bg-blue-600 rounded-full flex items-center justify-center border border-white shadow-sm">
                    <Check size={12} className="text-white" />
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
  dragTargetId,
  handleFileClick,
  handleFileDoubleClick,
  handleContextMenu,
  handleStartRename,
  handleRenameSubmit,
  handleRenameCancel,
  handleSetHoverPlayingId,
  handleDragStart,
  handleDragEnd,
  handleDragOverFolder,
  handleDragLeaveFolder,
  handleDropOnFolderWrapper,
  settings,
  containerRect,
  t,
  resourceRoot,
  cachePath
}: any) => {
  // Fallback to settings if direct props are missing
  const effectiveResourceRoot = resourceRoot || settings?.paths?.resourceRoot;
  const effectiveCachePath = cachePath || settings?.paths?.cacheRoot || (settings?.paths?.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined);
  
  // Calculate layout for this group
  const { layout } = useLayout(
    group.fileIds,
    files,
    activeTab.layoutMode,
    containerRect.width,
    thumbnailSize,
    'browser'
  );

  return (
    <div className="p-6">
      {activeTab.layoutMode === 'list' ? (
        // List layout
        <div className="overflow-hidden">
          {group.fileIds.map((id: string) => {
            const file = files[id];
            if (!file) return null;
            return (
              <FileListItem
                  key={file.id}
                  file={file}
                  isSelected={activeTab.selectedFileIds.includes(file.id)}
                  renamingId={renamingId}
                  onFileClick={handleFileClick}
                  onFileDoubleClick={handleFileDoubleClick}
                  onContextMenu={handleContextMenu}
                  onStartRename={handleStartRename}
                  onRenameSubmit={handleRenameSubmit}
                  onRenameCancel={handleRenameCancel}
                  onDragStart={handleDragStart}
                  onDragEnd={handleDragEnd}
                  onDragOver={(e: React.DragEvent) => handleDragOverFolder(e, file.id)}
                  onDragLeave={(e: React.DragEvent) => handleDragLeaveFolder(e, file.id)}
                  onDropOnFolder={handleDropOnFolderWrapper}
                  onDropExternal={null}
                  t={t}
                  dragTargetId={dragTargetId}
              />
            );
          })}
        </div>
      ) : (
        // Grid, adaptive, or masonry layout
        <div 
          className="relative" 
          style={{ 
            width: '100%', 
            height: layout.reduce((max, item) => Math.max(max, item.y + item.height), 0) 
          }}
        >
          {layout.map((item) => {
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
                    dragTargetId={dragTargetId}
                    onFileClick={handleFileClick}
                    onFileDoubleClick={handleFileDoubleClick}
                    onContextMenu={handleContextMenu}
                    onStartRename={handleStartRename}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={handleRenameCancel}
                    onSetHoverPlayingId={handleSetHoverPlayingId}
                    onDragStart={handleDragStart}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e: React.DragEvent) => handleDragOverFolder(e, file.id)}
                    onDragLeave={(e: React.DragEvent) => handleDragLeaveFolder(e, file.id)}
                    onDropOnFolder={handleDropOnFolderWrapper}
                    onDropExternal={null}
                    style={item}
                    settings={settings}
                    resourceRoot={effectiveResourceRoot}
                    cachePath={effectiveCachePath}
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
      className="flex items-center p-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors sticky top-0 z-20"
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

interface LayoutItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

const useLayout = (
  items: string[],
  files: Record<string, FileNode>,
  layoutMode: LayoutMode,
  containerWidth: number,
  thumbnailSize: number,
  viewMode: 'browser' | 'tags-overview' | 'people-overview',
  groupedTags?: Record<string, string[]>,
  people?: Record<string, Person>
) => {
  const aspectRatios = useMemo(() => {
    const ratios: Record<string, number> = {};
    if (viewMode === 'browser') {
      items.forEach(id => {
        const file = files[id];
        ratios[id] = file?.meta?.width && file?.meta?.height 
          ? file.meta.width / file.meta.height 
          : (file?.type === FileType.FOLDER ? 1.5 : 1);
      });
    }
    return ratios;
  }, [items, files, viewMode]);

  return useMemo(() => {
    const layout: LayoutItem[] = [];
    let totalHeight = 0;
    const GAP = 16;
    const PADDING = 24;
    
    // Ensure we have a reasonable width. If containerWidth is 0 (initial render), fall back to window width.
    const safeContainerWidth = containerWidth > 0 ? containerWidth : (typeof window !== 'undefined' ? window.innerWidth - 300 : 1200); 
    const availableWidth = Math.max(100, safeContainerWidth - (PADDING * 2));

    if (viewMode === 'browser') {
        if (layoutMode === 'list') {
            const itemHeight = 44;
            items.forEach((id, index) => {
                layout.push({ id, x: PADDING, y: PADDING + index * itemHeight, width: availableWidth, height: itemHeight });
            });
            totalHeight = PADDING + items.length * itemHeight;
        } else if (layoutMode === 'grid') {
            const minColWidth = thumbnailSize;
            const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
            const itemWidth = (availableWidth - (cols - 1) * GAP) / cols;
            const itemHeight = itemWidth + 40;

            items.forEach((id, index) => {
                const row = Math.floor(index / cols);
                const col = index % cols;
                layout.push({
                    id,
                    x: PADDING + col * (itemWidth + GAP),
                    y: PADDING + row * (itemHeight + GAP),
                    width: itemWidth,
                    height: itemHeight
                });
            });
            const rows = Math.ceil(items.length / cols);
            totalHeight = PADDING + rows * (itemHeight + GAP);
        } else if (layoutMode === 'adaptive') {
            let currentRow: any[] = [];
            let currentWidth = 0;
            let y = PADDING;
            const targetHeight = thumbnailSize;

            items.forEach((id, index) => {
                const aspect = aspectRatios[id];
                const w = targetHeight * aspect;
                
                if (currentWidth + w + GAP > availableWidth) {
                    const scale = (availableWidth - (currentRow.length - 1) * GAP) / currentWidth;
                    const rowHeight = targetHeight * scale;
                    
                    let x = PADDING;
                    currentRow.forEach(item => {
                        const finalW = item.w * scale;
                        layout.push({ id: item.id, x, y, width: finalW, height: rowHeight + 40 });
                        x += finalW + GAP;
                    });
                    
                    y += rowHeight + 40 + GAP;
                    currentRow = [];
                    currentWidth = 0;
                }
                
                currentRow.push({ id, w });
                currentWidth += w;
            });

            if (currentRow.length > 0) {
                let x = PADDING;
                currentRow.forEach(item => {
                    layout.push({ id: item.id, x, y, width: item.w, height: targetHeight + 40 });
                    x += item.w + GAP;
                });
                y += targetHeight + 40 + GAP;
            }
            totalHeight = y;

        } else if (layoutMode === 'masonry') {
            const minColWidth = thumbnailSize;
            const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
            const itemWidth = (availableWidth - (cols - 1) * GAP) / cols;
            const colHeights = new Array(cols).fill(PADDING);

            items.forEach(id => {
                const aspect = aspectRatios[id];
                const imgHeight = itemWidth / aspect;
                const totalItemHeight = imgHeight + 40;

                let minCol = 0;
                let minHeight = colHeights[0];
                for (let i = 1; i < cols; i++) {
                    if (colHeights[i] < minHeight) {
                        minCol = i;
                        minHeight = colHeights[i];
                    }
                }

                layout.push({
                    id,
                    x: PADDING + minCol * (itemWidth + GAP),
                    y: colHeights[minCol],
                    width: itemWidth,
                    height: totalItemHeight
                });

                colHeights[minCol] += totalItemHeight + GAP;
            });
            totalHeight = Math.max(...colHeights);
        }
    } else if (viewMode === 'people-overview') {
        // Use provided people dictionary to generate IDs, ignore 'items' prop
        const itemsList = Object.values(people || {});
        const minColWidth = thumbnailSize;
        const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
        const itemWidth = (availableWidth - (cols - 1) * GAP) / cols;
        const itemHeight = itemWidth + 60; // Extra space for text

        itemsList.forEach((person, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;
            layout.push({
                id: person.id,
                x: PADDING + col * (itemWidth + GAP),
                y: PADDING + row * (itemHeight + GAP),
                width: itemWidth,
                height: itemHeight
            });
        });
        const rows = Math.ceil(itemsList.length / cols);
        totalHeight = PADDING + rows * (itemHeight + GAP);
    } 

    return { layout, totalHeight };
  }, [items, files, layoutMode, containerWidth, thumbnailSize, viewMode, aspectRatios, people]);
};

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
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDropOnFolder: (targetId: string, sourceIds: string[]) => void;
  onDropExternal?: (targetId: string, paths: string[]) => void;
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
  onDragEnd?: (e: React.DragEvent) => void;
  resourceRoot?: string;
  cachePath?: string;
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
  onDragStart,
  onDragEnd,
  onDropOnFolder,
  onDropExternal,
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
  settings
}) => {
  // #region agent log
  // Removed debug logs
  // #endregion

  const [dragTargetId, setDragTargetId] = useState<string | null>(null);
  
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
  
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
      onDragStart(e, id);
  }, [onDragStart]);
  
  const handleDragEnd = useCallback((e: React.DragEvent) => {
      onDragEnd?.(e);
  }, [onDragEnd]);
  
  const handleDropOnFolderWrapper = useCallback((targetId: string, sourceIds: string[]) => {
      setDragTargetId(null);
      onDropOnFolder(targetId, sourceIds);
  }, [onDropOnFolder]);

  const handleDropExternalWrapper = useCallback((targetId: string, paths: string[]) => {
      setDragTargetId(null);
      onDropExternal?.(targetId, paths);
  }, [onDropExternal]);
  
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

  const handleDragOverFolder = useCallback((e: React.DragEvent, id: string) => {
      const file = files[id];
      if (file?.type === FileType.FOLDER) {
          // 总是调用 e.preventDefault()，确保 onDrop 事件能够触发
          // 移除 e.stopPropagation()，确保事件能够传递到 onDrop 处理函数
          e.preventDefault();
          setDragTargetId(id);
      }
  }, [files]);

  const handleDragLeaveFolder = useCallback((e: React.DragEvent, id: string) => {
      // 无论 relatedTarget 是什么，都清除 dragTargetId
      setDragTargetId(null);
  }, []);
  
  useEffect(() => {
      if (containerRef?.current && activeTab.scrollTop > 0) {
          requestAnimationFrame(() => {
              if(containerRef.current) {
                  if (Math.abs(containerRef.current.scrollTop - activeTab.scrollTop) > 50) {
                      containerRef.current.scrollTop = activeTab.scrollTop;
                  }
              }
          });
      }
  }, [activeTab.id, activeTab.folderId, activeTab.viewMode]);

  useEffect(() => {
    const container = containerRef?.current;
    if (!container) return;

    const handleWheel = (e: WheelEvent) => {
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
    
    const handleScroll = () => {
        if (containerRef.current) setScrollTop(containerRef.current.scrollTop);
    };
    containerRef.current.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
        if (animationFrameId) cancelAnimationFrame(animationFrameId);
        observer.disconnect();
        containerRef?.current?.removeEventListener('scroll', handleScroll);
    };
  }, [containerRef]);

  const { layout, totalHeight } = useLayout(
      displayFileIds,
      files,
      activeTab.layoutMode,
      containerRect.width, 
      thumbnailSize,
      activeTab.viewMode,
      groupedTags,
      people
  );

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
              className="w-full h-full overflow-auto px-6 pb-6 relative"
              onContextMenu={onBackgroundContextMenu}
              onMouseDown={onMouseDown}
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
              />
          </div>
      );
  }

  return (
      <div
          ref={containerRef}
          className={`relative w-full h-full overflow-auto`}
          onContextMenu={onBackgroundContextMenu}
          onMouseDown={onMouseDown}
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

          {activeTab.viewMode === 'people-overview' ? (
              <div className="w-full" style={{ position: 'relative', minHeight: '100%' }}>
                  <div style={{ position: 'relative' }}>
                      <div
                          className="relative"
                          style={{
                              width: '100%',
                              height: totalHeight,
                              position: 'relative'
                          }}
                      >
                          {visibleItems.map((item) => {
                              const person = people ? people[item.id] : null;
                              if (!person) return null;
                              return (
                                  <PersonCard
                                      key={person.id}
                                      person={person}
                                      files={files}
                                      isSelected={activeTab.selectedPersonIds.includes(person.id)}
                                      onPersonClick={handlePersonClick}
                                      onPersonDoubleClick={handlePersonDoubleClick}
                                      onStartRenamePerson={onStartRenamePerson || (() => {})}
                                      onPersonContextMenu={handlePersonContextMenu}
                                      t={t}
                                      style={item}
                                  />
                              );
                          })}
                      </div>
                  </div>
              </div>
          ) : groupBy !== 'none' && groupedFiles && groupedFiles.length > 0 ? (
              <div className="w-full">
                  {groupedFiles.map((group) => (
                      <div key={group.id} className="mb-8">
                          <GroupHeader
                              group={group}
                              collapsed={collapsedGroups[group.id] || false}
                              onToggle={handleToggleGroup}
                          />
                          {!(collapsedGroups[group.id] || false) && (
                              <GroupContent
                                  group={group}
                                  files={files}
                                  activeTab={activeTab}
                                  renamingId={renamingId}
                                  thumbnailSize={thumbnailSize}
                                  hoverPlayingId={hoverPlayingId}
                                  dragTargetId={dragTargetId}
                                  handleFileClick={handleFileClick}
                                  handleFileDoubleClick={handleFileDoubleClick}
                                  handleContextMenu={handleContextMenu}
                                  handleStartRename={handleStartRename}
                                  handleRenameSubmit={handleRenameSubmit}
                                  handleRenameCancel={handleRenameCancel}
                                  handleSetHoverPlayingId={handleSetHoverPlayingId}
                                  handleDragStart={handleDragStart}
                                  handleDragEnd={handleDragEnd}
                                  handleDragOverFolder={handleDragOverFolder}
                                  handleDragLeaveFolder={handleDragLeaveFolder}
                                  handleDropOnFolderWrapper={handleDropOnFolderWrapper}
                                  settings={settings}
                                  containerRect={containerRect}
                                  t={t}
                                  resourceRoot={effectiveResourceRoot}
                                  cachePath={effectiveCachePath}
                              />
                          )}
                      </div>
                  ))}
              </div>
          ) : activeTab.layoutMode === 'list' ? (
              <div className="w-full h-full overflow-auto">
                  <div className="p-6">
                      {displayFileIds.map((id) => {
                          const file = files[id];
                          if (!file) return null;
                          return (
                              <FileListItem
                                  key={file.id}
                                  file={file}
                                  isSelected={activeTab.selectedFileIds.includes(file.id)}
                                  renamingId={renamingId}
                                  onFileClick={handleFileClick}
                                  onFileDoubleClick={handleFileDoubleClick}
                                  onContextMenu={handleContextMenu}
                                  onStartRename={onStartRename}
                                  onRenameSubmit={handleRenameSubmit}
                                  onRenameCancel={handleRenameCancel}
                                  onDragStart={handleDragStart}
                                  onDragEnd={handleDragEnd}
                                  onDragOver={(e: React.DragEvent) => handleDragOverFolder(e, file.id)}
                                  onDragLeave={(e: React.DragEvent) => handleDragLeaveFolder(e, file.id)}
                                  onDropOnFolder={handleDropOnFolderWrapper}
                                  onDropExternal={handleDropExternalWrapper}
                                  t={t}
                                  dragTargetId={dragTargetId}
                              />
                          );
                      })}
                  </div>
              </div>
          ) : (
              <div className="w-full" style={{ position: 'relative', minHeight: '100%' }}>
                  <div style={{ position: 'relative' }}>
                      {/* Fixed height container to prevent scroll bounce */}
                      <div
                          className="relative"
                          style={{
                              width: '100%',
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
                                      dragTargetId={dragTargetId}
                                      onFileClick={handleFileClick}
                                      onFileDoubleClick={handleFileDoubleClick}
                                      onContextMenu={handleContextMenu}
                                      onStartRename={onStartRename}
                                      onRenameSubmit={handleRenameSubmit}
                                      onRenameCancel={handleRenameCancel}
                                      onSetHoverPlayingId={handleSetHoverPlayingId}
                                      onDragStart={handleDragStart}
                                      onDragEnd={handleDragEnd}
                                      onDragOver={(e: React.DragEvent) => handleDragOverFolder(e, file.id)}
                                      onDragLeave={handleDragLeaveFolder}
                                      onDropOnFolder={handleDropOnFolderWrapper}
                                      onDropExternal={handleDropExternalWrapper}
                                      settings={settings}
                                      style={item}
                                      resourceRoot={effectiveResourceRoot}
                                      cachePath={effectiveCachePath}
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
