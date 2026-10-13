import { useState, useEffect } from 'react';
import { Image as ImageIcon, Video as VideoIcon } from 'lucide-react';
import { FileNode } from '../../types';
import { getBlobCacheSync } from '../ImageViewer';
import { getGlobalCache } from '../../utils/thumbnailCache';
import { useVideoCover } from '../../hooks/useVideoCover';

// 视频 P1（UI 设计 §5 / §6）：视频大预览显示抽帧封面（P1.5 生成）。
// 在封面就绪前，绝不对 mp4 走 getThumbnail / convertFileSrc / 缩略图缓存——
// 否则会把 asset://…/xxx.mp4 当作图片喂给 <img>（破图），并污染全局缩略图缓存，
// 进而扩散到网格卡片（ImageThumbnail 从同一缓存读出 mp4 地址）。
const ImagePreview = ({ file, resourceRoot, cachePath, t }: { file: FileNode, resourceRoot?: string, cachePath?: string, t?: (key: string) => string }) => {
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

    return (
        <div className="flex flex-col items-center">
            <div className="w-full rounded-lg overflow-hidden bg-surface border border-subtle flex flex-col justify-center items-center p-2 mb-2 shadow-sm min-h-[200px]">
                {isVideo ? (
                    // 视频占位 / 抽帧封面（P1.5-A）：封面就绪显示封面 JPEG；
                    // 未就绪（mkv 等 8 种容器要等 P1.5-B 的 ffmpeg）或抽帧失败 → VideoIcon + 说明
                    coverUrl ? (
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
                                {t ? t('video.coverPlaceholder') : '抽帧封面生成后显示'}
                            </span>
                        </div>
                    )
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
