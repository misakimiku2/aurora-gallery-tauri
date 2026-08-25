import { useState, useCallback } from 'react';
import { Layout } from 'lucide-react';
import { Topic } from '../../types';

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

    let renderCrop: { x: number; y: number; width: number; height: number } | null = null;

    if (hasCrop) {
        renderCrop = topic.coverCrop!;
    } else if (imgDimensions) {
        const { width: imgW, height: imgH } = imgDimensions;
        const targetAspect = 3 / 4;
        const imgAspect = imgW / imgH;

        let cropW: number, cropH: number, cropX: number, cropY: number;

        if (imgAspect > targetAspect) {
            cropH = 100;
            cropW = (targetAspect / imgAspect) * 100;
            cropX = (100 - cropW) / 2;
            cropY = 0;
        } else {
            cropW = 100;
            cropH = (imgAspect / targetAspect) * 100;
            cropX = 0;
            cropY = (100 - cropH) / 2;
        }

        renderCrop = { x: cropX, y: cropY, width: cropW, height: cropH };
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
                        width: `${10000 / Math.max(renderCrop.width, 0.1)}%`,
                        height: `${10000 / Math.max(renderCrop.height, 0.1)}%`,
                        maxWidth: 'none',
                        minWidth: 'unset',
                        left: `${-renderCrop.x / Math.max(renderCrop.width, 0.1) * 100}%`,
                        top: `${-renderCrop.y / Math.max(renderCrop.height, 0.1) * 100}%`,
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
