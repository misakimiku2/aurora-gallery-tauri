import { useState, useCallback } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { User } from 'lucide-react';
import { Person, FileNode } from '../../types';
import { cropToImgStyle, faceBoxToCrop, centerCrop, CropRect } from '../../utils/cropStyle';

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

    let renderCrop: CropRect | null = null;

    if (hasFaceBox) {
        renderCrop = faceBoxToCrop(person.faceBox!);
    } else if (imgDimensions) {
        renderCrop = centerCrop(imgDimensions.width, imgDimensions.height, 1);
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
                        ...cropToImgStyle(renderCrop),
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
