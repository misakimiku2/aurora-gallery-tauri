
import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useInView } from '../hooks/useInView';
import { getGlobalCache } from '../utils/thumbnailCache';
import { performanceMonitor } from '../utils/performanceMonitor';
import { isThumbnailUpgrading, getGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge';
import { lanClientApi } from './lan-client/lanClientApi';
import { lanNavStep, lanNavActive } from '../utils/lanNavTrace';
import { Image as ImageIcon, Video as VideoIcon } from 'lucide-react';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts']);
const isVideoFile = (filePath?: string, format?: string): boolean => {
  if (format && format.startsWith('video/')) return true;
  if (!filePath) return false;
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? VIDEO_EXTENSIONS.has(ext) : false;
};

// LAN source files use a synthetic `lan://<remotePath>` path marker.
const LAN_PREFIX = 'lan://';
const isLanPath = (p?: string): boolean => !!p && p.startsWith(LAN_PREFIX);
const lanRemotePath = (p: string): string => p.slice(LAN_PREFIX.length);

export const ImageThumbnail = React.memo(({ src, alt, isSelected, filePath, modified, size, isHovering, fileMeta, resourceRoot, cachePath, mediaStoreId }: { 
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
  mediaStoreId?: number;
}) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '2000px' }); 
  
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(() => {
      if (!filePath) return null;
      // 视频文件没有缩略图端点，直接返回 null（由 renderThumbnail 显示视频图标）
      if (isVideoFile(filePath, fileMeta?.format)) return null;
      // LAN source: use remote thumbnail URL directly (no local generation)
      if (isLanPath(filePath)) {
        return lanClientApi.getThumbnailUrl(lanRemotePath(filePath));
      }
      const cache = getGlobalCache();
      return cache.get(filePath) || null;
  });
  
  const [animSrc, setAnimSrc] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(() => filePath ? isThumbnailUpgrading(filePath) : false);

  const isAndroid = resourceRoot === 'android_media_store';
  const hitRecordedRef = useRef(false);
  const lanThumbReqLoggedRef = useRef(false);

  useEffect(() => {
    if (thumbnailSrc && !hitRecordedRef.current) {
      performanceMonitor.increment('thumbnailCacheHit');
      hitRecordedRef.current = true;
    }
  }, [thumbnailSrc]);

  // LAN 导航管道：首个 LAN 缩略图 URL 就绪时记录「Thumbnail 请求开始」
  useEffect(() => {
    if (lanNavActive() && filePath && isLanPath(filePath) && thumbnailSrc && !lanThumbReqLoggedRef.current) {
      lanThumbReqLoggedRef.current = true;
      const fileName = filePath.split('/').pop() || filePath;
      lanNavStep('===== FIRST THUMB REQUEST =====', `file=${fileName}`);
    }
  }, [thumbnailSrc, filePath]);

  useEffect(() => {
    // LAN source: thumbnail URL is resolved directly, skip local generation
    if (isLanPath(filePath)) return;
    if (!(isInView || wasInView) || !filePath || !resourceRoot) return;

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
      try {
        const { getThumbnail } = await import('../api/tauri-bridge');

        const thumbnail = await getThumbnail(filePath, modified, resourceRoot, controller.signal, undefined, cachePath, mediaStoreId);
        
        if (!controller.signal.aborted && thumbnail) {
          if (cache.get(key) !== thumbnail) {
              cache.set(key, thumbnail);
              setThumbnailSrc(thumbnail);
          }
          setUpgrading(isThumbnailUpgrading(filePath));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('Failed to load thumbnail:', error);
        }
      }
    };

    loadThumbnail();

    return () => {
      controller.abort();
    };
  }, [filePath, modified, resourceRoot, isInView, wasInView, thumbnailSrc]);

  useEffect(() => {
    if (!filePath) return;
    const handler = (e: Event) => {
      const { filePath: upgradedPath, thumbnailSrc: upgradedSrc } = (e as CustomEvent).detail;
      if (upgradedPath === filePath && upgradedSrc !== thumbnailSrc) {
        setThumbnailSrc(upgradedSrc);
        setUpgrading(false);
      }
    };
    const failHandler = (e: Event) => {
      const { filePath: failedPath } = (e as CustomEvent).detail;
      if (failedPath === filePath) {
        setUpgrading(false);
      }
    };
    window.addEventListener('aurora:thumbnail-upgraded', handler);
    window.addEventListener('aurora:thumbnail-upgrade-failed', failHandler);
    return () => {
      window.removeEventListener('aurora:thumbnail-upgraded', handler);
      window.removeEventListener('aurora:thumbnail-upgrade-failed', failHandler);
    };
  }, [filePath, thumbnailSrc]);

  useEffect(() => {
    // LAN source: no local thumbnail upgrade pipeline
    if (isLanPath(filePath)) return;
    if (!upgrading || !filePath || !resourceRoot) return;
    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelay = 5000;

    const checkUpgrade = async () => {
      if (cancelled || retryCount >= maxRetries) return;
      retryCount++;
      await new Promise<void>(resolve => setTimeout(resolve, retryDelay));
      if (cancelled) return;
      try {
        const { getThumbnail, isThumbnailUpgrading: isUpgrading } = await import('../api/tauri-bridge');
        const thumbnail = await getThumbnail(filePath, modified, resourceRoot, undefined, undefined, cachePath, mediaStoreId);
        if (cancelled) return;
        if (thumbnail && !isUpgrading(filePath)) {
          const cache = getGlobalCache();
          cache.set(filePath, thumbnail);
          setThumbnailSrc(thumbnail);
          setUpgrading(false);
        } else if (isUpgrading(filePath)) {
          checkUpgrade();
        }
      } catch {
        if (!cancelled) checkUpgrade();
      }
    };

    checkUpgrade();
    return () => { cancelled = true; };
  }, [upgrading, filePath, resourceRoot, modified, cachePath, mediaStoreId]);

  useEffect(() => {
    let isMounted = true;

    const loadAnimation = async () => {
      // LAN source: animation preview needs local file access; skip for remote files
      if (isLanPath(filePath)) {
        if (isMounted) setAnimSrc(null);
        return;
      }
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

  // LAN 导航管道：首个缩略图 <img> onLoad 时记录「Thumbnail 加载完成」
  const lanThumbLoadLoggedRef = useRef(false);
  const handleThumbLoad = useCallback(() => {
    if (lanNavActive() && filePath && isLanPath(filePath) && !lanThumbLoadLoggedRef.current) {
      lanThumbLoadLoggedRef.current = true;
      const fileName = filePath.split('/').pop() || filePath;
      lanNavStep('===== FIRST THUMB LOADED =====', `file=${fileName}`);
    }
  }, [filePath]);

  const renderThumbnail = () => {
    if (animSrc) {
      return (
        <img
          src={animSrc}
          alt={alt}
          className="absolute inset-0 w-full h-full object-cover"
          loading="eager"
          draggable="false"
        />
      );
    }

    if (finalSrc) {
      return (
        <img
          src={finalSrc}
          alt={alt}
          className="absolute inset-0 w-full h-full object-cover"
          decoding="async"
          loading="eager"
          draggable="false"
          onLoad={handleThumbLoad}
        />
      );
    }

    // 视频文件显示视频图标
    if (isVideoFile(filePath, fileMeta?.format)) {
      return (
        <div className="w-full h-full flex items-center justify-center">
          <VideoIcon className="w-8 h-8 text-gray-400 dark:text-gray-600" />
        </div>
      );
    }

    return (
      <div className="w-full h-full flex items-center justify-center">
        <ImageIcon className="w-6 h-6 text-gray-400 dark:text-gray-600" />
      </div>
    );
  };

  return (
    <div ref={ref} className="w-full h-full relative overflow-hidden">
      <div className="absolute inset-0 pointer-events-none">
        {renderThumbnail()}
      </div>
      {upgrading && finalSrc && (
        <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10">
          <svg className="animate-spin h-6 w-6 text-white/80" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
          </svg>
        </div>
      )}
    </div>
  );
});
