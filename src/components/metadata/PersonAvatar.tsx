import { useState, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { User } from 'lucide-react';
import { Person, FileNode } from '../../types';

const PersonAvatar = ({ person, coverFile, size = 80, className = '' }: {
    person: Person;
    coverFile?: FileNode;
    size?: number;
    className?: string;
}) => {
    const [imgDimensions, setImgDimensions] = useState<{ width: number; height: number } | null>(null);

    const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        setImgDimensions({ width: img.naturalWidth, height: img.naturalHeight });
    }, []);

    const coverUrl = coverFile?.path ? convertFileSrc(coverFile.path) : null;
    const hasFaceBox = person.faceBox && person.faceBox.w > 0 && person.faceBox.h > 0;

    let renderCrop: { x: number; y: number; width: number; height: number } | null = null;

    if (hasFaceBox) {
        renderCrop = {
            x: person.faceBox!.x,
            y: person.faceBox!.y,
            width: person.faceBox!.w,
            height: person.faceBox!.h
        };
    } else if (imgDimensions) {
        const { width: imgW, height: imgH } = imgDimensions;
        const minDim = Math.min(imgW, imgH);
        const cropX = (imgW - minDim) / 2;
        const cropY = (imgH - minDim) / 2;

        const cropWPercent = (minDim / imgW) * 100;
        const cropHPercent = (minDim / imgH) * 100;
        const cropXPercent = (cropX / imgW) * 100;
        const cropYPercent = (cropY / imgH) * 100;

        renderCrop = { x: cropXPercent, y: cropYPercent, width: cropWPercent, height: cropHPercent };
    }

    if (!coverUrl) {
        return (
            <div
                className={`w-full h-full flex items-center justify-center bg-surface text-gray-400 ${className}`}
                style={{ width: size, height: size }}
            >
                <User size={size * 0.4} strokeWidth={1.5} />
            </div>
        );
    }

    return (
        <div
            className={`overflow-hidden relative ${className}`}
            style={{ width: size, height: size }}
        >
            {renderCrop ? (
                <img
                    src={coverUrl}
                    alt={person.name}
                    className="absolute"
                    decoding="async"
                    onLoad={!hasFaceBox ? handleImageLoad : undefined}
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
                    alt={person.name}
                    className="absolute"
                    decoding="async"
                    onLoad={!hasFaceBox ? handleImageLoad : undefined}
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

export default PersonAvatar;
