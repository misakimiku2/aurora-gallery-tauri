
import React, { useRef, useState, useEffect, useMemo, useCallback } from 'react';
import { useInView } from '../hooks/useInView';
import { getGlobalCache } from '../utils/thumbnailCache';
import { performanceMonitor } from '../utils/performanceMonitor';
import { isThumbnailUpgrading } from '../api/tauri-bridge';
import { isRemotePath, getRemoteThumbnailUrl, subscribeRemoteChange } from '../utils/remoteSource';
import { lanNavStep, lanNavActive } from '../utils/lanNavTrace';
import { Image as ImageIcon, Video as VideoIcon } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { isVideoFile, formatVideoDuration } from '../utils/mediaExtensions';

// 视频扩展名判定已收敛到 `src/utils/mediaExtensions.ts`（与 core/src/file_types.rs 同步）。
// 视频 P1（设计方案 §2.7 口径 C / UI 设计 §5.2）。

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
  fileMeta?: { format?: string; durationMs?: number };
  resourceRoot?: string;
  cachePath?: string;
  mediaStoreId?: number;
}) => {
  const [ref, isInView, wasInView] = useInView({ rootMargin: '800px' }); 

  // 视频判定（UI 设计 §5.2）：组件级常量，供各 effect 门禁与渲染复用。
  // mime format 优先，否则按扩展名（真源见 utils/mediaExtensions.ts）。
  const isVideo = isVideoFile(filePath, fileMeta?.format);
  
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(() => {
      if (!filePath) return null;
      // 视频文件没有缩略图端点，直接返回 null（由 renderThumbnail 显示视频图标）
      if (isVideo) return null;
      // 远程来源：直接使用远程缩略图 URL（无需本地生成）
      if (isRemote(filePath)) {
        return getRemoteThumbnailUrl(filePath);
      }
      const cache = getGlobalCache();
      return cache.get(filePath) || null;
  });
  
  const [animSrc, setAnimSrc] = useState<string | null>(null);
  // 视频悬停预览（P1.5 配套）：存 asset URL 交给 <video> 播放，不存 base64
  const [videoPreviewSrc, setVideoPreviewSrc] = useState<string | null>(null);
  // 视频是否已解出第一帧：未就绪时保持透明，让底层封面继续显示（消除闪空）
  const [videoPreviewReady, setVideoPreviewReady] = useState(false);
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
    // 视频不参与缩略图管线（UI 设计 §5.2）：远程视频也不刷新缩略图 URL
    if (isVideo) return;
    if (!filePath || !isRemote(filePath)) return;
    const path = filePath;
    const refresh = () => {
      const url = getRemoteThumbnailUrl(path);
      setThumbnailSrc((prev) => (prev === url ? prev : url));
    };
    refresh();
    return subscribeRemoteChange(refresh);
  }, [filePath, isVideo]);

  useEffect(() => {
    // 远程来源：缩略图 URL 直连，跳过本地生成
    if (isRemote(filePath)) return;
    // 视频门禁（UI 设计 §5.2）：视频无缩略图端点。绝不读缩略图缓存 / 请求 getThumbnail /
    // setThumbnailSrc——否则会命中被污染的缓存（mp4 的 asset:// 地址）把视频喂给 <img>，
    // 对大型视频还会引发海量读取。视频统一走 renderThumbnail 的 VideoIcon 占位。
    if (isVideo) return;
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
  }, [filePath, modified, resourceRoot, isInView, wasInView, isVideo]);

  // 视频封面（P1.5-A）
  // 视频**不**参与图片缩略图管线（后端 `process_single_thumbnail` 对视频不解图），
  // 走专门的前端抽帧链路：<video> seek → canvas → JPEG → save_remote_thumbnail 落同一套磁盘缓存。
  //
  // ⚠️ 三条不可回退的红线（记忆 §2.1 事故）：
  //   ① 写进 / 读出缓存的必须是封面 JPEG 的 URL，**绝不能**是源视频的 asset:// 地址；
  //      故从缓存取值时显式排除「等于 convertFileSrc(filePath)」的情况（历史上的污染形态）。
  //   ② 抽帧失败一律返回 null —— 保持 thumbnailSrc 为空，renderThumbnail 落到 VideoIcon 占位，
  //      绝不 fallback 到视频路径去喂 <img>。
  //   ③ 并发控制：队列化在 utils/videoCover 内部已经串行，这里只负责不并发触发。
  useEffect(() => {
    if (!isVideo || !filePath || !resourceRoot) return;
    // 远程（LAN / 安卓）视频暂不支持前端抽帧：Thumbnail 需要本地文件，保持占位
    if (isRemote(filePath)) return;
    // 刻意**不**按 isInView 门控：图片缩略图路径同样不门控（挂载即请求），
    // FileGrid 本身是虚拟化窗口，挂载的卡片本就在渲染窗口内；
    // 抽帧的并发压力由 utils/videoCover 的串行队列 + 体积上限兜底。
    // （2026-10-14 排障记录：曾按视口门控，与图片路径行为不一致，先对齐排除变量。）

    const cache = getGlobalCache();
    const videoUrl = convertFileSrc(filePath);
    const cached = cache.get(filePath);
    if (cached) {
      // 防御：历史污染可能留下视频自身的 asset:// 地址（见①），剔除而不是拿来用
      if (cached === videoUrl) {
        cache.delete(filePath);
      } else {
        setThumbnailSrc(cached);
        return;
      }
    }

    const controller = new AbortController();
    let cancelled = false;

    const loadCover = async () => {
      try {
        const { getVideoCover } = await import('../api/tauri-bridge');
        const cover = await getVideoCover(
          filePath,
          resourceRoot,
          controller.signal,
          undefined,
          cachePath,
          size
        );
        if (cancelled || !cover || controller.signal.aborted) return;
        if (cover === videoUrl) return; // 双保险：绝不让视频地址落到 <img>
        if (mountedRef.current) setThumbnailSrc(cover);
      } catch {
        // 静默降级：抽不出来就维持占位图标
      }
    };

    loadCover();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [filePath, resourceRoot, isInView, wasInView, isVideo, cachePath, size]);

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
    // 视频门禁（UI 设计 §5.2）：视频不参与缩略图升级，避免 setThumbnailSrc 把视频喂给 <img>
    if (isVideo) return;
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
  }, [upgrading, filePath, resourceRoot, modified, cachePath, mediaStoreId, isVideo]);

  useEffect(() => {
    let isMounted = true;

    const loadAnimation = async () => {
      // 远程来源：动画预览需要本地文件访问；远程文件跳过
      if (isRemote(filePath)) {
        if (isMounted) {
          setAnimSrc(null);
          setVideoPreviewSrc(null);
          setVideoPreviewReady(false);
        }
        return;
      }
      if (isHovering && filePath) {
        if (isVideo) {
          // 视频悬停预览：直接把 asset URL 交给 <video> 流式播放。
          // ⚠️ 这里刻意不走 readFileAsBase64——那会把整个文件读进内存，
          //    对 GB 级视频正是 §14.7 崩溃事故的形态（体积上限由 FileGrid 侧把关）。
          if (isMounted) {
            // 换源必须重置就绪标记，否则上一个视频的 ready 会让新视频一开始就显示（又是闪空）
            setVideoPreviewReady(false);
            setVideoPreviewSrc(convertFileSrc(filePath));
            setAnimSrc(null);
          }
          return;
        }
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
            setVideoPreviewSrc(null);
            setVideoPreviewReady(false);
          }
        }
      } else {
        if (isMounted) {
          setAnimSrc(null);
          setVideoPreviewSrc(null);
          setVideoPreviewReady(false);
        }
      }
    };

    loadAnimation();

    return () => {
      isMounted = false;
    };
  }, [isHovering, filePath, fileMeta, isVideo]);

  const finalSrc = animSrc || thumbnailSrc;

  // 视频 P1（UI 设计 §5.2）：视频卡片右下角时长角标。非视频或无 durationMs 为空串（不渲染）
  const durationLabel = isVideo ? formatVideoDuration(fileMeta?.durationMs) : '';

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
    // 视频悬停预览（P1.5 配套）：静音循环播放。这是唯一一处「<video> 出现在卡片里」的路径，
    // 它渲染的是真正的视频流，与缩略图 <img> 完全无关（不构成记忆 §2.1 所说的管线污染）。
    //
    // ⚠️ 修复「封面 → 空白 → 视频」的闪空（指挥官 2026-10-14 反馈）：
    // 不能用 <video> 直接**替换**封面 <img>——视频元素创建后到解出第一帧之间有空窗
    // （机械盘上大文件尤其明显），那一瞬间卡片就是空的。
    // 正确做法：封面留在底层，视频叠在上层且初始 opacity-0，
    // 等 `loadeddata`/`playing` 确认真的有画面了再淡入。
    if (videoPreviewSrc) {
      return (
        <div className="absolute inset-0 w-full h-full">
          {finalSrc ? (
            <img
              src={finalSrc}
              alt={alt}
              className="absolute inset-0 w-full h-full object-cover"
              decoding="async"
              draggable="false"
            />
          ) : (
            // 还没有封面的视频（如 mkv —— 要等 P1.5-B 的 ffmpeg）：底层继续显示占位图标，
            // 否则悬停时照样是一块空白
            <div className="w-full h-full flex items-center justify-center">
              <VideoIcon className="w-8 h-8 text-gray-400 dark:text-gray-600" />
            </div>
          )}
          <video
            src={videoPreviewSrc}
            className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-150 ${
              videoPreviewReady ? 'opacity-100' : 'opacity-0'
            }`}
            autoPlay
            muted
            loop
            playsInline
            preload="auto"
            crossOrigin="anonymous"
            onLoadedData={() => setVideoPreviewReady(true)}
            onPlaying={() => setVideoPreviewReady(true)}
          />
        </div>
      );
    }

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
    if (isVideo) {
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
      {durationLabel && (
        // 视频 P1（UI 设计 §5.2）：右下角时长角标，mm:ss / h:mm:ss。无 durationMs 不显示
        <div className="absolute bottom-1 right-1 z-10 px-1 py-px rounded bg-black/60 text-white text-[10px] font-medium leading-none pointer-events-none tabular-nums">
          {durationLabel}
        </div>
      )}
    </div>
  );
});
