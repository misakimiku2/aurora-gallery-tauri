
import React, { useRef } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { useInView } from '../hooks/useInView';
import { getGlobalCache } from '../utils/thumbnailCache';
import { performanceMonitor } from '../utils/performanceMonitor';

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
  
  const [thumbnailSrc, setThumbnailSrc] = React.useState<string | null>(() => {
      if (!filePath) return null;
      const key = filePath; 
      const cache = getGlobalCache();
      return cache.get(key) || null;
  });
  
  const [animSrc, setAnimSrc] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(!thumbnailSrc);

  const hitRecordedRef = useRef(false);

  React.useEffect(() => {
    if (thumbnailSrc && !hitRecordedRef.current) {
      performanceMonitor.increment('thumbnailCacheHit');
      hitRecordedRef.current = true;
    }
  }, [thumbnailSrc]);

  React.useEffect(() => {
    if ((isInView || wasInView) && filePath && resourceRoot) {
      const cache = getGlobalCache();
      const key = filePath; 

      if (thumbnailSrc && cache.get(key) === thumbnailSrc) {
          if (!hitRecordedRef.current) {
              performanceMonitor.increment('thumbnailCacheHit');
              hitRecordedRef.current = true;
          }
          return;
      }

      const controller = new AbortController();
      const loadThumbnail = async () => {
        if (!thumbnailSrc) setLoading(true);
        
        try {
          const { getThumbnail } = await import('../api/tauri-bridge');

          const thumbnail = await getThumbnail(filePath, modified, resourceRoot, controller.signal);
          
          if (!controller.signal.aborted && thumbnail) {
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
  }, [filePath, modified, resourceRoot, isInView, wasInView, thumbnailSrc]);

  React.useEffect(() => {
    let isMounted = true;

    const loadAnimation = async () => {
      if (isHovering && filePath) {
        const fileName = filePath.split(/[\\/]/).pop() || '';
        const fileExt = fileName.substring(fileName.lastIndexOf('.') + 1).toLowerCase();
        const isAnimationFormat = (fileMeta?.format === 'gif' || fileMeta?.format === 'webp') || (fileExt === 'gif' || fileExt === 'webp');
        
        if (isAnimationFormat) {
          try {
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
