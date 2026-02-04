import React, { memo, useMemo, useState, useEffect, useRef } from 'react';
import { Folder, Book, Film } from 'lucide-react';
import { FileNode, LayoutMode, FileType } from '../types';

// Intersection Observer 单例管理�?
class IntersectionObserverManager {
  private static instance: IntersectionObserverManager;
  private observers: Map<string, { observer: IntersectionObserver; callbacks: WeakMap<Element, Set<(entry: IntersectionObserverEntry) => void>> }>;
  private defaultOptions: IntersectionObserverInit;

  private constructor() {
    this.observers = new Map();
    this.defaultOptions = {
      rootMargin: '300px',
      threshold: 0.01
    };
  }

  public static getInstance(): IntersectionObserverManager {
    if (!IntersectionObserverManager.instance) {
      IntersectionObserverManager.instance = new IntersectionObserverManager();
    }
    return IntersectionObserverManager.instance;
  }

  public observe(
    element: Element,
    callback: (entry: IntersectionObserverEntry) => void,
    options: IntersectionObserverInit = {}
  ): void {
    if (typeof IntersectionObserver === 'undefined') {
      callback({ isIntersecting: true } as IntersectionObserverEntry);
      return;
    }

    const mergedOptions = { ...this.defaultOptions, ...options };
    const optionsKey = JSON.stringify(mergedOptions);

    let observerInfo = this.observers.get(optionsKey);
    if (!observerInfo) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          const callbacks = observerInfo?.callbacks.get(entry.target);
          if (callbacks) {
            callbacks.forEach((cb) => cb(entry));
          }
        });
      }, mergedOptions);

      observerInfo = {
        observer,
        callbacks: new WeakMap()
      };
      this.observers.set(optionsKey, observerInfo);
    }

    let elementCallbacks = observerInfo.callbacks.get(element);
    if (!elementCallbacks) {
      elementCallbacks = new Set();
      observerInfo.callbacks.set(element, elementCallbacks);
      observerInfo.observer.observe(element);
    }

    elementCallbacks.add(callback);
  }

  public unobserve(
    element: Element,
    callback: (entry: IntersectionObserverEntry) => void,
    options: IntersectionObserverInit = {}
  ): void {
    if (typeof IntersectionObserver === 'undefined') {
      return;
    }

    const mergedOptions = { ...this.defaultOptions, ...options };
    const optionsKey = JSON.stringify(mergedOptions);

    const observerInfo = this.observers.get(optionsKey);
    if (!observerInfo) {
      return;
    }

    const elementCallbacks = observerInfo.callbacks.get(element);
    if (elementCallbacks) {
      elementCallbacks.delete(callback);

      if (elementCallbacks.size === 0) {
        observerInfo.observer.unobserve(element);
        observerInfo.callbacks.delete(element);
      }
    }
  }

  public disconnect(): void {
    this.observers.forEach((observerInfo) => {
      observerInfo.observer.disconnect();
    });
    this.observers.clear();
  }
}

// 简化的useInView Hook
const useInView = (options: IntersectionObserverInit = {}) => {
  const [isInView, setIsInView] = useState(false);
  const [wasInView, setWasInView] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const currentRef = ref.current;
    if (!currentRef) return;

    if (typeof IntersectionObserver === 'undefined') {
      setIsInView(true);
      setWasInView(true);
      return;
    }

    const observerManager = IntersectionObserverManager.getInstance();

    const handleIntersection = (entry: IntersectionObserverEntry) => {
      const intersecting = entry.isIntersecting;
      setIsInView(intersecting);
      if (intersecting) {
        setWasInView(true);
      }
    };

    observerManager.observe(currentRef, handleIntersection, options);

    return () => {
      observerManager.unobserve(currentRef, handleIntersection, options);
    };
  }, [options]);

  return [ref, isInView, wasInView] as const;
};

// 简化的文件夹图标组�?- 优化DOM结构
export const SimpleFolderIcon = memo(({ 
  category = 'general', 
  className = "" 
}: { 
  category?: string, 
  className?: string 
}) => {
  const styles: any = {
    general: { color: 'text-blue-500', bg: 'bg-blue-100' },
    book: { color: 'text-amber-500', bg: 'bg-amber-100' },
    sequence: { color: 'text-purple-500', bg: 'bg-purple-100' },
  };
  const style = styles[category] || styles.general;
  const Icon = category === 'book' ? Book : (category === 'sequence' ? Film : Folder);

  return (
    <div className={`relative w-full h-full flex items-center justify-center ${className}`}>
      {/* 简化的文件夹图�?- 使用单个SVG */}
      <div className={`relative w-full aspect-square ${style.bg} rounded-lg overflow-hidden border border-gray-200 dark:border-gray-800`}>
        {/* 背景�?*/}
        <div className="absolute inset-0 opacity-20">
          <svg viewBox="0 0 100 100" className="w-full h-full" preserveAspectRatio="none">
            <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" fill="currentColor" />
          </svg>
        </div>
        
        {/* 图标�?*/}
        <div className="absolute inset-0 flex items-center justify-center">
          <Icon size={24} className={style.color} strokeWidth={1.5} />
        </div>
      </div>
    </div>
  );
});

// 预览图片容器 - 延迟加载（只显示一张图片）
export const FolderPreviewImages = memo(({
  previewSrcs,
  onImageError
}: {
  previewSrcs?: string[],
  onImageError?: (index: number) => void
}) => {
  const images = (previewSrcs || []).filter(src => !!src).slice(0, 1); // 只取第一�?
  
  if (images.length === 0) return null;

  return (
    <div className="absolute left-[15%] right-[15%] top-[20%] bottom-[20%] z-10 group-hover:-translate-y-2 transition-transform duration-300">
      <div
        className="absolute inset-0 bg-white shadow-md border-[2px] border-white rounded-sm overflow-hidden"
        style={{ zIndex: 20, transform: 'rotate(0deg) scale(1)', opacity: 1 }}
      >
        <img
          src={images[0]}
          className="w-full h-full object-cover"
          loading="lazy"
          draggable="false"
          onError={() => onImageError?.(0)}
        />
      </div>
    </div>
  );
});

// 完整�?D文件夹图标组�?- 保持原有设计但优化性能
export const Folder3DIcon = memo(({
  previewSrcs,
  count,
  category = 'general',
  className = "",
  onImageError
}: {
  previewSrcs?: string[],
  count?: number,
  category?: string,
  className?: string,
  onImageError?: (index: number) => void
}) => {
  const styles: any = {
    general: { back: 'text-blue-600 dark:text-blue-500', front: 'text-blue-400 dark:text-blue-400' },
    book: { back: 'text-amber-600 dark:text-amber-500', front: 'text-amber-400 dark:text-amber-400' },
    sequence: { back: 'text-purple-600 dark:text-purple-500', front: 'text-purple-400 dark:text-purple-400' },
  };
  const style = styles[category] || styles.general;
  const Icon = category === 'book' ? Book : (category === 'sequence' ? Film : Folder);

  // 使用useMemo缓存计算结果
  const images = useMemo(() => (previewSrcs || []).filter(src => !!src), [previewSrcs]);

  return (
    <div className={`relative w-full h-full select-none flex items-center justify-center ${className}`}>
      {/* Square container to maintain aspect ratio */}
      <div className="relative w-full aspect-square">
        {/* Back Plate - 优化为CSS�?*/}
        <svg viewBox="0 0 100 100" className={`absolute w-full h-full drop-shadow-sm transition-colors ${style.back}`} preserveAspectRatio="none">
          <path d="M5,20 L35,20 L45,30 L95,30 C97,30 99,32 99,35 L99,85 C99,88 97,90 95,90 L5,90 C3,90 1,88 1,85 L1,25 C1,22 3,20 5,20 Z" fill="currentColor" />
        </svg>

        {/* Preview Images - 使用独立组件 */}
        {images.length > 0 && (
          <FolderPreviewImages previewSrcs={images} onImageError={onImageError} />
        )}

        {/* Front Plate - 使用group-hover从父组件继承 */}
        <div
          className="absolute left-0 right-0 bottom-0 h-[60%] z-20 transition-transform duration-300 origin-bottom group-hover:-translate-y-3"
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
});

// 性能优化的文件夹缩略图组�?
export const OptimizedFolderThumbnail = memo(({
  file,
  files,
  mode,
  resourceRoot,
  cachePath,
  enablePreview = true
}: {
  file: FileNode;
  files: Record<string, FileNode>,
  mode: LayoutMode,
  resourceRoot?: string,
  cachePath?: string,
  enablePreview?: boolean
}) => {
  // 使用useInView实现延迟加载
  const [ref, isInView, wasInView] = useInView({ rootMargin: '400px' });
  
  // 简化的图片查找逻辑 - 使用缓存
  const imageChildren = useMemo(() => {
    if (!file.children || file.children.length === 0 || !enablePreview) return [];
    
    // 限制遍历深度和数量（只取1张）
    const images: FileNode[] = [];
    const stack = [...(file.children || [])];
    const visited = new Set<string>();
    let traversalCount = 0;
    const MAX_TRAVERSAL = 100; // 降低上限
    const MAX_IMAGES = 1; // 只取1张图�?

    while (stack.length > 0 && traversalCount < MAX_TRAVERSAL && images.length < MAX_IMAGES) {
      const id = stack.pop()!;
      if (visited.has(id)) continue;
      visited.add(id);
      traversalCount++;

      const node = files[id];
      if (!node) continue;
      
      if (node.type === FileType.IMAGE) {
        images.push(node);
      } else if (node.type === FileType.FOLDER && node.children) {
        stack.push(...node.children);
      }
    }
    
    return images
      .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
      .slice(0, MAX_IMAGES);
  }, [file, files, enablePreview]);

  // 使用useState管理预览图片 - 初始化时尝试从全局缓存读取
  const [previewSrcs, setPreviewSrcs] = React.useState<string[]>(() => {
    if (!enablePreview || !imageChildren || imageChildren.length === 0) return [];
    
    // 尝试从全局缓存读取第一张图�?
    const firstChild = imageChildren[0];
    if (firstChild && firstChild.path && window.__AURORA_THUMBNAIL_CACHE__) {
      const cached = window.__AURORA_THUMBNAIL_CACHE__.get(firstChild.path);
      if (cached) return [cached];
    }
    return [];
  });
  
  const [loaded, setLoaded] = React.useState(() => {
    // 如果初始化时就有缓存数据，标记为已加�?
    if (!enablePreview || !imageChildren || imageChildren.length === 0) return true;
    
    const firstChild = imageChildren[0];
    if (firstChild && firstChild.path && window.__AURORA_THUMBNAIL_CACHE__) {
      return window.__AURORA_THUMBNAIL_CACHE__.has(firstChild.path);
    }
    return false;
  });

  // 延迟加载逻辑 - 只在组件进入视口时加�?
  React.useEffect(() => {
    // 如果不在视口内或已经加载，直接返�?
    if (!isInView || !wasInView || !enablePreview || !resourceRoot || imageChildren.length === 0 || loaded) return;
    
    // 如果已经有预览图片，不需要重新加�?
    if (previewSrcs.length > 0) return;

    const loadPreviews = async () => {
      try {
        const { getThumbnail } = await import('../api/tauri-bridge');
        const firstChild = imageChildren[0];
        
        if (!firstChild || !firstChild.path) return;

        // 先检查全局缓存
        if (window.__AURORA_THUMBNAIL_CACHE__) {
          const cached = window.__AURORA_THUMBNAIL_CACHE__.get(firstChild.path);
          if (cached) {
            setPreviewSrcs([cached]);
            setLoaded(true);
            return;
          }
        }
        
        // 缓存未命中，请求新图�?
        const url = await getThumbnail(firstChild.path, firstChild.updatedAt, resourceRoot);
        
        if (url) {
          setPreviewSrcs([url]);
          // getThumbnail内部会更新全局缓存
        }
      } catch (error) {
        console.error('Failed to load folder preview:', error);
      } finally {
        setLoaded(true);
      }
    };

    loadPreviews();
  }, [isInView, wasInView, enablePreview, resourceRoot, imageChildren, loaded, previewSrcs.length]);

  return (
    <div ref={ref} className="w-full h-full relative flex flex-col items-center justify-center bg-transparent">
      <div className="relative w-full aspect-square p-2 group" style={{ maxHeight: '100%' }}>
        <Folder3DIcon
          previewSrcs={previewSrcs}
          count={file.children?.length}
          category={file.category}
        />
      </div>
    </div>
  );
});
