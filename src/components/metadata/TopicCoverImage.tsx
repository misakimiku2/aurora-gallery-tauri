import { useState, useCallback } from 'react';
import { Layout } from 'lucide-react';
import { Topic, FileNode } from '../../types';
import { cropToImgStyle, centerCrop, CropRect } from '../../utils/cropStyle';
import { useVideoCover } from '../../hooks/useVideoCover';

const TopicCoverImage = ({ topic, coverUrl, coverFile, resourceRoot, className = '' }: {
    topic: Topic;
    coverUrl: string | null;
    /** 封面文件节点（P1.5-A 消费方）：传入且为视频时走抽帧链路，忽略 coverUrl */
    coverFile?: FileNode;
    resourceRoot?: string;
    className?: string;
}) => {
    const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);

    const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        setImgDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    }, []);

    // 视频封面（P1.5-A 消费方）：封面文件是视频时走抽帧链路，绝不 convertFileSrc 喂 <img>（记忆 §2.1）
    const { isVideo, coverUrl: videoCoverUrl } = useVideoCover(
        coverFile?.path,
        resourceRoot,
        coverFile?.meta?.format,
        coverFile?.size
    );
    const effectiveCoverUrl = isVideo ? videoCoverUrl : coverUrl;
    // coverCrop 是用户在封面**图片**上画的裁剪框；视频封面不适用（坐标对不上），退回居中裁剪
    const hasCrop = !isVideo && topic.coverCrop && topic.coverCrop.width > 0 && topic.coverCrop.height > 0;

    let renderCrop: CropRect | null = null;

    if (hasCrop) {
        renderCrop = topic.coverCrop!;
    } else if (imgDimensions) {
        renderCrop = centerCrop(imgDimensions.width, imgDimensions.height, 3 / 4);
    }

    if (!effectiveCoverUrl) {
        return (
            <div className={`w-full h-full flex flex-col items-center justify-center text-gray-300 dark:text-gray-600 ${className}`}>
                <Layout size={64} className="mb-4 opacity-20" />
                <span className="text-xs uppercase tracking-[0.2em] font-medium">Topic</span>
            </div>
        );
    }

    return (
        <div className={`overflow-hidden relative ${className}`}>
            {renderCrop ? (
                <img
                    src={effectiveCoverUrl}
                    alt={topic.name}
                    className="absolute"
                    decoding="async"
                    onLoad={!hasCrop ? handleImageLoad : undefined}
                    style={{
                        ...cropToImgStyle(renderCrop),
                        imageRendering: 'auto'
                    }}
                />
            ) : (
                <img
                    src={effectiveCoverUrl}
                    alt={topic.name}
                    className="absolute"
                    decoding="async"
                    onLoad={!hasCrop ? handleImageLoad : undefined}
                    style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        objectPosition: 'center',
                        left: 0,
                        top: 0,
                        imageRendering: 'auto'
                    }}
                />
            )}
        </div>
    );
};

export default TopicCoverImage;
