import { useState, useCallback } from 'react';
import { Layout } from 'lucide-react';
import { Topic } from '../../types';
import { cropToImgStyle, centerCrop, CropRect } from '../../utils/cropStyle';

const TopicCoverImage = ({ topic, coverUrl, className = '' }: {
    topic: Topic;
    coverUrl: string | null;
    className?: string;
}) => {
    const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);

    const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        setImgDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    }, []);

    const hasCrop = topic.coverCrop && topic.coverCrop.width > 0 && topic.coverCrop.height > 0;

    let renderCrop: CropRect | null = null;

    if (hasCrop) {
        renderCrop = topic.coverCrop!;
    } else if (imgDimensions) {
        renderCrop = centerCrop(imgDimensions.width, imgDimensions.height, 3 / 4);
    }

    if (!coverUrl) {
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
                    src={coverUrl}
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
                    src={coverUrl}
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
