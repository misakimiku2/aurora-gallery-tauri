
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { FileNode, FileType, LayoutMode } from '../types';
import { useInView } from '../hooks/useInView';
import { getGlobalCache } from '../utils/thumbnailCache';
import { performanceMonitor } from '../utils/performanceMonitor';
import { Folder, ImageIcon } from 'lucide-react';
import { Folder3DIcon } from './Folder3DIcon';
import { isThumbnailUpgrading, getGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge';
import { GetFileNode } from './useLayoutHook';

const findImagesDeeply = (
    rootFolder: FileNode,
    getFileNode: GetFileNode,
    limit: number = 3
): FileNode[] => {
    const images: FileNode[] = [];
    const stack: string[] = [...(rootFolder.children || [])];
    const visited = new Set<string>();

    let traversalCount = 0;
    const MAX_TRAVERSAL = 500;

    while (stack.length > 0 && traversalCount < MAX_TRAVERSAL) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        traversalCount++;

        const node = getFileNode(id);
        if (!node) continue;

        if (node.type === FileType.IMAGE) {
            images.push(node);
        } else if (node.type === FileType.FOLDER && node.children) {
            stack.push(...node.children);
        }
    }

    return images
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        .slice(0, limit);
};

const AndroidFolderPlaceholder: React.FC<{ file: FileNode }> = React.memo(({ file }) => {
  const count = file.children?.length ?? file.imageCount ?? 0;
  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-200 dark:from-gray-800 dark:to-gray-750">
      <Folder size={48} className="text-gray-400 dark:text-gray-500" strokeWidth={1.2} />
      {count > 0 && (
        <div className="mt-1 flex items-center gap-0.5 text-gray-400 dark:text-gray-500">
          <ImageIcon size={10} />
          <span className="text-[10px]">{count}</span>
        </div>
      )}
    </div>
  );
});

export const FolderThumbnail = React.memo(({ file, getFileNode, mode, resourceRoot, cachePath }: { file: FileNode; getFileNode: GetFileNode, mode: LayoutMode, resourceRoot?: string, cachePath?: string }) => {
  const isAndroid = resourceRoot === 'android_media_store';
  const [ref, isInView, wasInView] = useInView({ rootMargin: '1200px' });

  const imageChildren = useMemo(() => {
      if (!file.children || file.children.length === 0) return [];
      return findImagesDeeply(file, getFileNode, 3);
  }, [file, getFileNode]);

  const [previewSrcs, setPreviewSrcs] = useState<string[]>(() => {
      const cache = getGlobalCache();
      const cachedUrls = imageChildren.map(child => {
          return cache.get(child.path) || null; 
      });
      return cachedUrls.filter((url): url is string => !!url);
  });

  const [upgradingPaths, setUpgradingPaths] = useState<Set<string>>(() => {
    const set = new Set<string>();
    imageChildren.forEach(img => {
      if (isThumbnailUpgrading(img.path)) set.add(img.path);
    });
    return set;
  });

  const [scrollState, setScrollState] = useState(getGlobalScrollState());

  useEffect(() => {
    if (!isAndroid) return;
    return subscribeScrollState(setScrollState);
  }, [isAndroid]);

  const previewCountedRef = useRef<Set<string>>(new Set());
  const [loaded, setLoaded] = useState(previewSrcs.length > 0);

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
    if (loaded && previewSrcs.length === Math.min(3, imageChildren.length)) {
        return;
    }

    if ((isInView || wasInView) && resourceRoot && imageChildren.length > 0) {
      const controller = new AbortController();
      const loadPreviews = async () => {
        try {
          const { getThumbnail } = await import('../api/tauri-bridge');
          
          const promises = imageChildren.map(async (img: FileNode) => {
              const cache = getGlobalCache();
              const cached = cache.get(img.path);
              if (cached) {
                  return cached;
              }

              const url = await getThumbnail(img.path, img.updatedAt, resourceRoot, controller.signal, undefined, undefined, img.mediaStoreId);
              if (url) {
                  cache.set(img.path, url);
                  const isUpgrading = isThumbnailUpgrading(img.path);
                  console.log('[FolderThumbnail] getThumbnail result:', img.path, 'upgrading=', isUpgrading);
                  if (isUpgrading) {
                    setUpgradingPaths(prev => new Set(prev).add(img.path));
                  }
              }
              return url;
          });

          const thumbnails = await Promise.all(promises);
          
          if (!controller.signal.aborted) {
            const validThumbnails = thumbnails.filter((t): t is string => !!t);
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
  }, [isInView, wasInView, loaded, imageChildren, resourceRoot, previewSrcs.length]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { filePath, thumbnailSrc } = (e as CustomEvent).detail;
      const matchIndex = imageChildren.findIndex(img => img.path === filePath);
      console.log('[FolderThumbnail] aurora:thumbnail-upgraded:', filePath, 'matchIndex=', matchIndex, 'imageChildren.length=', imageChildren.length);
      if (matchIndex === -1) return;
      setUpgradingPaths(prev => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      const cache = getGlobalCache();
      const updated = imageChildren.slice(0, 3).map(img => cache.get(img.path)).filter((url): url is string => !!url);
      console.log('[FolderThumbnail] Updated URLs from cache:', updated, 'prev previewSrcs length=', previewSrcs.length);
      setPreviewSrcs(prev => {
        if (updated.length === prev.length && updated.every((val, idx) => val === prev[idx])) return prev;
        return updated;
      });
    };
    const failHandler = (e: Event) => {
      const { filePath: failedPath } = (e as CustomEvent).detail;
      const matchIndex = imageChildren.findIndex(img => img.path === failedPath);
      if (matchIndex === -1) return;
      setUpgradingPaths(prev => {
        const next = new Set(prev);
        next.delete(failedPath);
        return next;
      });
    };
    window.addEventListener('aurora:thumbnail-upgraded', handler);
    window.addEventListener('aurora:thumbnail-upgrade-failed', failHandler);
    return () => {
      window.removeEventListener('aurora:thumbnail-upgraded', handler);
      window.removeEventListener('aurora:thumbnail-upgrade-failed', failHandler);
    };
  }, [imageChildren]);

  useEffect(() => {
    if (upgradingPaths.size === 0 || !resourceRoot) return;
    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelay = 5000;

    const checkUpgrades = async () => {
      if (cancelled || retryCount >= maxRetries) return;
      retryCount++;
      await new Promise<void>(resolve => setTimeout(resolve, retryDelay));
      if (cancelled) return;
      try {
        const { getThumbnail, isThumbnailUpgrading: isUpgrading } = await import('../api/tauri-bridge');
        const stillUpgrading: string[] = [];
        for (const imgPath of upgradingPaths) {
          const img = imageChildren.find(i => i.path === imgPath);
          if (!img) continue;
          const thumbnail = await getThumbnail(img.path, img.updatedAt, resourceRoot, undefined, undefined, undefined, img.mediaStoreId);
          if (thumbnail && !isUpgrading(img.path)) {
            const cache = getGlobalCache();
            cache.set(img.path, thumbnail);
          } else if (isUpgrading(img.path)) {
            stillUpgrading.push(imgPath);
          }
        }
        if (!cancelled) {
          const cache = getGlobalCache();
          const updated = imageChildren.slice(0, 3).map(img => cache.get(img.path)).filter((url): url is string => !!url);
          setPreviewSrcs(prev => {
            if (updated.length === prev.length && updated.every((val, idx) => val === prev[idx])) return prev;
            return updated;
          });
          if (stillUpgrading.length < upgradingPaths.size) {
            setUpgradingPaths(new Set(stillUpgrading));
          }
          if (stillUpgrading.length > 0) {
            checkUpgrades();
          }
        }
      } catch {
        if (!cancelled) checkUpgrades();
      }
    };

    checkUpgrades();
    return () => { cancelled = true; };
  }, [upgradingPaths, imageChildren, resourceRoot]);

  const hasUpgrading = upgradingPaths.size > 0;

  if (isAndroid && imageChildren.length === 0) {
    return (
      <div ref={ref} className="w-full h-full relative flex flex-col items-center justify-center bg-transparent">
        <AndroidFolderPlaceholder file={file} />
      </div>
    );
  }

  return (
    <div ref={ref} className="w-full h-full relative flex flex-col items-center justify-center bg-transparent">
      <div className="relative w-full aspect-square p-2" style={{ maxHeight: '100%' }}>
         <Folder3DIcon  
            previewSrcs={previewSrcs}
            count={file.children?.length}
            category={file.category}
         />
         {hasUpgrading && (scrollState === 'idle' || !isAndroid) && (
           <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-10 rounded-lg">
             <svg className="animate-spin h-5 w-5 text-white/70" viewBox="0 0 24 24" fill="none">
               <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
               <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
             </svg>
           </div>
         )}
      </div>
    </div>
  );
});
