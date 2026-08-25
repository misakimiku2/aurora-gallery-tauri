import { useState, useEffect } from 'react';
import { Image as ImageIcon } from 'lucide-react';
import { FileNode } from '../../types';
import { getBlobCacheSync } from '../ImageViewer';
import { getGlobalCache } from '../../utils/thumbnailCache';

const ImagePreview = ({ file, resourceRoot, cachePath }: { file: FileNode, resourceRoot?: string, cachePath?: string }) => {
    // 初始化时优先从 ImageViewer 的高分辨率 Blob 缓存获取
    const [imageUrl, setImageUrl] = useState<string | null>(() => {
        if (!file.path) return null;
        // 优先使用高分辨率缓存
        const blobUrl = getBlobCacheSync(file.path);
        if (blobUrl) return blobUrl;
        // 其次使用缩略图缓存
        const cache = getGlobalCache();
        return cache?.get(file.path) || null;
    });

    const [isLoading, setIsLoading] = useState(!imageUrl);

    useEffect(() => {
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
    }, [file.path, file.id, resourceRoot]);

    return (
        <div className="flex flex-col items-center">
            <div className="w-full rounded-lg overflow-hidden bg-surface border border-subtle flex justify-center items-center p-2 mb-2 shadow-sm min-h-[200px]">
                {isLoading ? (
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
