import { useState, useEffect, useRef } from 'react';
import { Image as ImageIcon, Video as VideoIcon, Play, Loader2, ExternalLink } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { FileNode } from '../../types';
import { getBlobCacheSync } from '../ImageViewer';
import { getGlobalCache } from '../../utils/thumbnailCache';
import { useVideoCover } from '../../hooks/useVideoCover';
import { formatVideoDuration, isWebDecodableVideo } from '../../utils/mediaExtensions';
import { openWithDefaultApp } from '../../api/tauri-bridge/files';
import { MiniVideoControls } from './MiniVideoControls';

// 视频 P1（UI 设计 §5 / §6）：视频大预览显示抽帧封面（P1.5 生成）。
// 在封面就绪前，绝不对 mp4 走 getThumbnail / convertFileSrc / 缩略图缓存——
// 否则会把 asset://…/xxx.mp4 当作图片喂给 <img>（破图），并污染全局缩略图缓存，
// 进而扩散到网格卡片（ImageThumbnail 从同一缓存读出 mp4 地址）。
//
// 2026-10-16（UI 设计 §6「叠加时长角标与播放按钮」）：
// 视频预览叠加右下角时长角标 + 居中播放按钮；点播放 → 跳查看器播放（onPlay）。
const ImagePreview = ({ file, resourceRoot, cachePath, t, openedInViewer, viewerVideoOpen }: {
    file: FileNode,
    resourceRoot?: string,
    cachePath?: string,
    t?: (key: string) => string,
    /** 该文件正被查看器打开「播放查看」→ 小窗停播退回封面、不显示播放按钮（2026-10-16 指挥官指定） */
    openedInViewer?: boolean,
    /** 查看器正开着视频 → 小窗空格让路（防双触发） */
    viewerVideoOpen?: boolean,
}) => {
    // 2026-10-16 修正（指挥官实机反馈）：播放按钮**在面板内就地播放**，不是跳查看器。
    // 2026-10-22：转封装链路已移除 —— 可解容器就地播源；不可解容器**不给播放按钮**，
    // 直接给「用系统播放器打开」这一条真正走得通的出口（点了必然失败，不该让它出现）。
    const [playSrc, setPlaySrc] = useState<string | null>(null);
    const [preparing, setPreparing] = useState(false);
    const [playFailed, setPlayFailed] = useState(false);
    /** 容器不在 WebView2 可解清单内 → 应用内注定播不了（与 startInlinePlayback 同一判据） */
    const videoUnsupported = !!file.path && !isWebDecodableVideo(file.path, file.meta?.format);
    // startInlinePlayback 的异步流程要用最新值判断，
    // 闭包里的 openedInViewer 是点击时的旧值，所以走 ref。
    const openedInViewerRef = useRef(false);
    openedInViewerRef.current = !!openedInViewer;

    // 换文件即停止就地播放
    useEffect(() => {
        setPlaySrc(null);
        setPreparing(false);
        setPlayFailed(false);
    }, [file.id]);

    // 查看器打开本文件（播放查看）→ 小窗停播退回封面（与查看器双播/双入口是混乱之源）。
    // 用「清状态」而非仅隐藏渲染：否则关闭查看器后 playSrc 仍在 → 小窗会自动复播。
    useEffect(() => {
        if (openedInViewer) {
            setPlaySrc(null);
            setPreparing(false);
            setPlayFailed(false);
        }
    }, [openedInViewer]);

    const startInlinePlayback = async () => {
        if (playSrc || preparing || !file.path) return;
        // 2026-10-22：转封装链路已整体移除 —— 容器不在可解清单内就直接判失败，
        // 由 UI 出占位符 + 提示（不再让用户等一次注定无效的转换）。
        if (!isWebDecodableVideo(file.path, file.meta?.format)) {
            setPlayFailed(true);
            return;
        }
        setPreparing(true);
        setPlayFailed(false);
        try {
            // 异步准备期间查看器可能已接管本文件（播放查看）→ 放弃就地播，避免双播
            if (openedInViewerRef.current) return;
            setPlaySrc(convertFileSrc(file.path));
        } finally {
            setPreparing(false);
        }
    };

    // 就地播放的 <video> 句柄：MiniVideoControls 经它绑定事件 / 控制播放（查看器同款模式）
    const videoRef = useRef<HTMLVideoElement>(null);
    // 点击视频本体 = 播放/暂停（小窗常用交互；与控件栏按钮同一逻辑，各自独立入口）
    const toggleVideoPlayback = () => {
        const v = videoRef.current;
        if (!v) return;
        if (v.paused) void v.play().catch(() => { /* 自动播放策略 / 解码失败：忽略 */ });
        else v.pause();
    };
    // 视频判定 + 抽帧封面解析（P1.5-A 消费方）：hook 对非视频返回 null，图片路径不受影响
    const { isVideo, coverUrl } = useVideoCover(
        file.path,
        resourceRoot,
        file.meta?.format,
        file.size
    );

    // 初始化时优先从 ImageViewer 的高分辨率 Blob 缓存获取
    const [imageUrl, setImageUrl] = useState<string | null>(() => {
        // 视频无图片预览：直接返回 null（走占位/封面分支）
        if (isVideo) return null;
        if (!file.path) return null;
        // 优先使用高分辨率缓存
        const blobUrl = getBlobCacheSync(file.path);
        if (blobUrl) return blobUrl;
        // 其次使用缩略图缓存
        const cache = getGlobalCache();
        return cache?.get(file.path) || null;
    });

    const [isLoading, setIsLoading] = useState(!imageUrl && !isVideo);

    useEffect(() => {
        // 视频门禁（UI 设计 §5 / §6）：图片管线不请求 getThumbnail、不 fallback convertFileSrc、
        // 绝不写入缩略图缓存。视频的封面由上方 useVideoCover 独立链路负责。
        if (isVideo) {
            setImageUrl(null);
            setIsLoading(false);
            return;
        }

        const controller = new AbortController();

        const loadImage = async () => {
            if (!file.path) {
                setImageUrl(null);
                setIsLoading(false);
                return;
            }

            // 优先检查 ImageViewer 的高分辨率 Blob 缓存
            const blobUrl = getBlobCacheSync(file.path);
            if (blobUrl) {
                setImageUrl(blobUrl);
                setIsLoading(false);
                return;
            }

            // 检查全局缩略图缓存
            const cache = getGlobalCache();
            const cachedUrl = cache?.get(file.path);

            if (cachedUrl) {
                setImageUrl(cachedUrl);
                setIsLoading(false);
                return;
            }

            // 如果缓存中没有，才显示加载状态
            setIsLoading(true);

            try {
                // Use getThumbnail for preview (smaller, faster)
                const { getThumbnail } = await import('../../api/tauri-bridge');

                if (controller.signal.aborted) return;

                let dataUrl = await getThumbnail(file.path, undefined, resourceRoot, controller.signal);

                if (controller.signal.aborted) return;

                // Fallback or use full image if thumbnail generation fails or returns null
                // But do not fallback if it was aborted!
                if (!dataUrl && file.path && !controller.signal.aborted) {
                    const { convertFileSrc } = await import('@tauri-apps/api/core');
                    dataUrl = convertFileSrc(file.path);
                }

                if (dataUrl) {
                    // 更新全局缓存
                    if (cache) cache.set(file.path, dataUrl);
                    if (!controller.signal.aborted) setImageUrl(dataUrl);
                } else {
                    if (!controller.signal.aborted) setImageUrl(null);
                }
            } catch (error) {
                console.error('Failed to load preview image:', error);
                if (!controller.signal.aborted) setImageUrl(null);
            } finally {
                if (!controller.signal.aborted) setIsLoading(false);
            }
        };

        loadImage();

        return () => {
            controller.abort();
        };
    }, [file.path, file.id, resourceRoot, isVideo]);

    // UI 设计 §6：视频大预览叠加时长角标（时长缺失时不显示，与网格卡片一致）
    const durationLabel = isVideo ? formatVideoDuration(file.meta?.durationMs) : '';

    return (
        <div className="flex flex-col items-center">
            <div className="w-full rounded-lg overflow-hidden bg-surface border border-subtle flex flex-col justify-center items-center p-2 mb-2 shadow-sm min-h-[200px]">
                {isVideo ? (
                    // 视频占位 / 抽帧封面（P1.5-A）：封面就绪显示封面 JPEG；
                    // 抽帧失败 → VideoIcon + 说明。外层 relative 承载角标与播放按钮。
                    <div className="relative w-full flex flex-col items-center justify-center">
                        {playSrc ? (
                            // 就地播放（2026-10-16）：crossOrigin 必带，
                            // 否则 asset:// 会污染 canvas（记忆 §2.4），后续截图/取色会抛 SecurityError。
                            // 2026-10-16 二次修正（指挥官实机反馈）：浏览器原生 controls 过于繁杂，
                            // 换 MiniVideoControls 迷你控件（仅 播放/暂停 · 进度条 · 静音）。
                            <div className="relative inline-flex max-w-full">
                                <video
                                    ref={videoRef}
                                    src={playSrc}
                                    autoPlay
                                    playsInline
                                    crossOrigin="anonymous"
                                    className="max-w-full max-h-[300px] rounded bg-transparent cursor-pointer"
                                    onError={() => setPlayFailed(true)}
                                    onClick={toggleVideoPlayback}
                                />
                                {/* 播放失败（onError）时收起控件，让位给下方「用系统播放器打开」兜底按钮 */}
                                {!playFailed && <MiniVideoControls videoRef={videoRef} t={t} viewerVideoOpen={viewerVideoOpen} />}
                            </div>
                        ) : (<>
                        {coverUrl ? (
                            <img
                                src={coverUrl}
                                className="max-w-full max-h-[300px] object-contain rounded"
                                alt={file.name}
                                decoding="async"
                                style={{
                                    willChange: 'transform, width, height',
                                    WebkitBackfaceVisibility: 'hidden',
                                    backfaceVisibility: 'hidden',
                                    transform: 'translate3d(0, 0, 0)',
                                }}
                            />
                        ) : (
                            <div className="flex flex-col items-center justify-center gap-2">
                                <VideoIcon className="text-gray-400" size={32} />
                                <span className="text-xs text-gray-400 dark:text-gray-500">
                                    {/* 2026-10-22：不可播容器的封面**根本抽不出来**（WMV/ASF 实测
                                        逐候选 seek 6/6 失败），再写「生成后显示」是空头承诺。 */}
                                    {videoUnsupported
                                        ? (t ? t('video.noCoverForFormat') : '此格式无法生成封面')
                                        : (t ? t('video.coverPlaceholder') : '抽帧封面生成后显示')}
                                </span>
                            </div>
                        )}
                        {durationLabel && (
                            <span className="absolute bottom-1.5 right-1.5 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] font-medium tabular-nums pointer-events-none">
                                {durationLabel}
                            </span>
                        )}
                        {/* 播放按钮：查看器已打开本文件（播放查看）时不显示 —— 该视频的播放入口
                            已在查看器，小窗保留播放入口会造成双播/双入口（2026-10-16 指挥官指定）。
                            2026-10-22：不可播容器连按钮都不给（点了只是失败一次再出兜底）。 */}
                        {!openedInViewer && !videoUnsupported && (
                            <button
                                onClick={startInlinePlayback}
                                title={t ? t('video.playHere') : '在此处播放'}
                                className="absolute inset-0 flex items-center justify-center group cursor-pointer"
                            >
                                <span className="w-12 h-12 rounded-full bg-black/45 group-hover:bg-black/70 flex items-center justify-center transition-colors">
                                    {preparing ? (
                                        <Loader2 size={20} className="animate-spin text-white" />
                                    ) : (
                                        <Play size={22} className="text-white ml-0.5" fill="currentColor" />
                                    )}
                                </span>
                            </button>
                        )}
                        {/* 不可播容器：不给播放入口，直接给外部播放器这条真出口 */}
                        {!openedInViewer && videoUnsupported && file.path && (
                            <button
                                onClick={() => openWithDefaultApp(file.path).catch(() => {})}
                                className="mt-2 px-2.5 py-1 text-xs rounded border border-subtle text-gray-600 dark:text-gray-300 hover:bg-surface flex items-center gap-1.5"
                            >
                                <ExternalLink size={12} />
                                {t ? t('video.openExternalPlayer') : '用系统播放器打开'}
                            </button>
                        )}
                        {preparing && (
                            <span className="absolute bottom-1.5 left-1.5 px-1.5 py-0.5 rounded bg-black/70 text-white text-[11px] pointer-events-none">
                                {t ? t('video.preparing') : '正在准备播放…'}
                            </span>
                        )}
                        </>)}
                        {/* 就地播放失败 → 给「用系统播放器打开」兜底（与查看器/右键同一出口） */}
                        {playFailed && file.path && (
                            <button
                                onClick={() => openWithDefaultApp(file.path).catch(() => {})}
                                className="mt-2 px-2.5 py-1 text-xs rounded border border-subtle text-gray-600 dark:text-gray-300 hover:bg-surface flex items-center gap-1.5"
                            >
                                <ExternalLink size={12} />
                                {t ? t('video.openExternalPlayer') : '用系统播放器打开'}
                            </button>
                        )}
                    </div>
                ) : isLoading ? (
                    <div className="flex items-center justify-center">
                        <ImageIcon className="animate-pulse text-gray-400" size={32} />
                    </div>
                ) : imageUrl ? (
                    <img
                        src={imageUrl}
                        className="max-w-full max-h-[300px] object-contain rounded"
                        alt={file.name}
                        decoding="async"
                        style={{
                            willChange: 'transform, width, height',
                            WebkitBackfaceVisibility: 'hidden',
                            backfaceVisibility: 'hidden',
                            transform: 'translate3d(0, 0, 0)',
                        }}
                    />
                ) : (
                    <div className="flex items-center justify-center">
                        <ImageIcon className="text-gray-400" size={32} />
                    </div>
                )}
            </div>
        </div>
    );
};

export default ImagePreview;
