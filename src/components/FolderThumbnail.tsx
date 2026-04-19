
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { FileNode, FileType, LayoutMode } from '../types';
import { useInView } from '../hooks/useInView';
import { getGlobalCache } from '../utils/thumbnailCache';
import { performanceMonitor } from '../utils/performanceMonitor';
import { Folder, ImageIcon } from 'lucide-react';
import { Folder3DIcon } from './Folder3DIcon';

const findImagesDeeply = (
    rootFolder: FileNode, 
    allFiles: Record<string, FileNode>, 
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

        const node = allFiles[id];
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

export const FolderThumbnail = React.memo(({ file, files, mode, resourceRoot, cachePath }: { file: FileNode; files: Record<string, FileNode>, mode: LayoutMode, resourceRoot?: string, cachePath?: string }) => {
  const isAndroid = resourceRoot === 'android_media_store';

  if (isAndroid) {
    return (
      <div className="w-full h-full relative flex flex-col items-center justify-center bg-transparent">
        <AndroidFolderPlaceholder file={file} />
      </div>
    );
  }

  const [ref, isInView, wasInView] = useInView({ rootMargin: '400px' });
  
  const imageChildren = useMemo(() => {
      if (!file.children || file.children.length === 0) return [];
      return findImagesDeeply(file, files, 3);
  }, [file, files]);

  const [previewSrcs, setPreviewSrcs] = useState<string[]>(() => {
      const cache = getGlobalCache();
      const cachedUrls = imageChildren.map(child => {
          return cache.get(child.path) || null; 
      });
      return cachedUrls.filter((url): url is string => !!url);
  });

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

              const url = await getThumbnail(img.path, img.updatedAt, resourceRoot, controller.signal);
              if (url) {
                  cache.set(img.path, url);
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

  return (
    <div ref={ref} className="w-full h-full relative flex flex-col items-center justify-center bg-transparent">
      <div className="relative w-full aspect-square p-2" style={{ maxHeight: '100%' }}>
         <Folder3DIcon  
            previewSrcs={previewSrcs}
            count={file.children?.length}
            category={file.category}
         />
      </div>
    </div>
  );
});
