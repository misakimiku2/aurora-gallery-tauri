
import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useInView } from '../hooks/useInView';
import { getGlobalCache } from '../utils/thumbnailCache';
import { performanceMonitor } from '../utils/performanceMonitor';
import { isThumbnailUpgrading } from '../api/tauri-bridge';
import { isRemotePath, getRemoteThumbnailUrl, subscribeRemoteChange } from '../utils/remoteSource';
import { lanNavStep, lanNavActive } from '../utils/lanNavTrace';
import { Image as ImageIcon, Video as VideoIcon } from 'lucide-react';

const VIDEO_EXTENSIONS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv', 'm4v', 'mpg', 'mpeg', '3gp', 'ts']);
const isVideoFile = (filePath?: string, format?: string): boolean => {
  if (format && format.startsWith('video/')) return true;
  if (!filePath) return false;
  const ext = filePath.split('.').pop()?.toLowerCase();
  return ext ? VIDEO_EXTENSIONS.has(ext) : false;
};

// 远程来源文件使用合成路径标记：`lan://<remotePath>`（桌面端服务）
// 或 `android://<mediaStoreId>`（安卓设备）。
const isRemote = (p?: string | null): boolean => isRemotePath(p);

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
  const [ref, isInView, wasInView] = useInView({ rootMargin: '800px' }); 
  
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(() => {
      if (!filePath) return null;
      // 视频文件没有缩略图端点，直接返回 null（由 renderThumbnail 显示视频图标）
      if (isVideoFile(filePath, fileMeta?.format)) return null;
      // 远程来源：直接使用远程缩略图 URL（无需本地生成）
      if (isRemote(filePath)) {
        return getRemoteThumbnailUrl(filePath);
      }
      const cache = getGlobalCache();
      return cache.get(filePath) || null;
  });
  
  const [animSrc, setAnimSrc] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(() => filePath ? isThumbnailUpgrading(filePath) : false);

  const isAndroid = resourceRoot === 'android_media_store';
  const hitRecordedRef = useRef(false);
  const lanThumbReqLoggedRef = useRef(false);
  const loadedRef = useRef<string | null>(null); // 跟踪已成功加载的 URL，避免重复 setState / 重跑 effect
  const mountedRef = useRef(true); // 跟踪当前 effect 实例是否还挂载（防止卸载后 setState 警告 + 失效）

  useEffect(() => {
    if (thumbnailSrc && !hitRecordedRef.current) {
      performanceMonitor.increment('thumbnailCacheHit');
      hitRecordedRef.current = true;
    }
  }, [thumbnailSrc]);

  // LAN 导航管道：首个 LAN 缩略图 URL 就绪时记录「Thumbnail 请求开始」
  useEffect(() => {
    if (lanNavActive() && filePath && isRemote(filePath) && thumbnailSrc && !lanThumbReqLoggedRef.current) {
      lanThumbReqLoggedRef.current = true;
      const fileName = filePath.split('/').pop() || filePath;
      lanNavStep('===== FIRST THUMB REQUEST =====', `file=${fileName}`);
    }
  }, [thumbnailSrc, filePath]);

  // 远程来源：设备重连/token 刷新后重新解析缩略图 URL。
  // 断线期间解析到的是空串（或过期 token 的 URL），不重算就会一直裂图。
  useEffect(() => {
    if (!filePath || !isRemote(filePath)) return;
    const path = filePath;
    const refresh = () => {
      const url = getRemoteThumbnailUrl(path);
      setThumbnailSrc((prev) => (prev === url ? prev : url));
    };
    refresh();
    return subscribeRemoteChange(refresh);
  }, [filePath]);

  useEffect(() => {
    // 远程来源：缩略图 URL 直连，跳过本地生成
    if (isRemote(filePath)) return;
    if (!filePath || !resourceRoot) return;
    mountedRef.current = true; // 本次 effect 实例挂载中

    const cache = getGlobalCache();
    const key = filePath;

    // 缓存恢复：上次请求可能被 abort（滚动离开视口），但后端已生成并写入了
    // 内存缓存。组件重新进入视口时，若缓存已有则直接恢复显示，不再重新请求。
    const cachedNow = cache.get(key);
    if (cachedNow && thumbnailSrc !== cachedNow) {
      setThumbnailSrc(cachedNow);
      return;
    }

    if (thumbnailSrc && cache.get(key) === thumbnailSrc) {
        if (!hitRecordedRef.current) {
            performanceMonitor.increment('thumbnailCacheHit');
            hitRecordedRef.current = true;
        }
        return;
    }

    // 注意：依赖数组故意省略 thumbnailSrc，否则 setThumbnailSrc 会
    // 立刻重跑 effect 并 abort 当前 controller，导致已 resolve 的
    // thumbnailSrc 被回滚为 null（页面看不到缩略图）。

    const controller = new AbortController();
    const loadThumbnail = async () => {
      try {
        const { getThumbnail } = await import('../api/tauri-bridge');

        const thumbnail = await getThumbnail(filePath, modified, resourceRoot, controller.signal, undefined, cachePath, mediaStoreId);

        if (controller.signal.aborted || !thumbnail) return;

        // 写缓存：组件已卸载也照写，下次重挂载通过 loadedRef 恢复
        if (cache.get(key) !== thumbnail) {
          cache.set(key, thumbnail);
        }
        if (loadedRef.current === thumbnail) return; // 已经是同一个 URL，跳过 setState

        loadedRef.current = thumbnail;
        if (mountedRef.current) {
          // 组件仍挂载：正常 setState 触发渲染
          setThumbnailSrc(thumbnail);
          setUpgrading(isThumbnailUpgrading(filePath));
        }
        // 组件已卸载：不调用 setState（避免 React 警告 + 无效更新）
        // 下次重挂载 effect 会从 cache 读取恢复显示
      } catch (error) {
        if (!controller.signal.aborted) {
          console.error('Failed to load thumbnail:', error);
        }
      }
    };

    loadThumbnail();

    return () => {
      mountedRef.current = false;
      controller.abort();
    };
  }, [filePath, modified, resourceRoot, isInView, wasInView]);

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
    // 远程来源：无本地缩略图升级管线
    if (isRemote(filePath)) return;
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
      // 远程来源：动画预览需要本地文件访问；远程文件跳过
      if (isRemote(filePath)) {
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
    if (lanNavActive() && filePath && isRemote(filePath) && !lanThumbLoadLoggedRef.current) {
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
