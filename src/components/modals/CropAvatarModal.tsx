import React, { useState, useRef, useEffect } from 'react';
import { Search, Image as ImageIcon, Check } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Person, FileNode } from '../../types';
import { ImageThumbnail } from '../FileGrid';

interface CropAvatarModalProps {
    fileUrl: string;
    initialBox: { x: number; y: number; w: number; h: number } | null;
    personId: string;
    allFiles: Record<string, FileNode>;
    people: Record<string, Person>;
    onConfirm: (box: { x: number; y: number; w: number; h: number; imageId: string | null }) => void;
    onClose: () => void;
    t: (key: string) => string;
    resourceRoot?: string;
    cachePath?: string;
}

export const CropAvatarModal: React.FC<CropAvatarModalProps> = ({ fileUrl, initialBox, personId, allFiles, people, onConfirm, onClose, t, resourceRoot, cachePath }) => {
    // 基础状态
    const [scale, setScale] = useState(1);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const imgRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // 文件列表状态
    const [selectedFile, setSelectedFile] = useState<string | null>(null);
    const [currentImageId, setCurrentImageId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');

    // 初始化时设置当前图片ID
    useEffect(() => {
        // 找到与fileUrl对应的文件
        const initialFile: any = Object.values(allFiles).find((file: any) => {
            return file.url === fileUrl || convertFileSrc(file.path) === fileUrl;
        });

        if (initialFile) {
            setSelectedFile(initialFile.id);
            setCurrentImageId(initialFile.id);
        }
    }, [fileUrl, allFiles]);

    // 获取该人物下的所有图片
    const getPersonImages = () => {
        const images: any[] = [];

        Object.values(allFiles).forEach((file: any) => {
            if (file.type === 'image' && file.aiData?.faces) {
                const hasPerson = file.aiData.faces.some((face: any) => face.personId === personId);
                if (hasPerson) {
                    images.push(file);
                }
            }
        });

        return images;
    };

    const personImages = getPersonImages();

    // 过滤图片
    const filteredImages = personImages.filter(img =>
        img.name.toLowerCase().includes(searchQuery.toLowerCase())
    );

    // 处理图片选择
    const handleImageSelect = (file: any) => {
        setSelectedFile(file.id);
        setCurrentImageId(file.id);
        // 重置缩放和位置
        setScale(1);
        setPosition({ x: 0, y: 0 });
        // 更新当前显示的图片URL
        const newFileUrl = convertFileSrc(file.path);
        // 触发重新渲染
        if (imgRef.current) {
            imgRef.current.src = newFileUrl;
        }
    };

    const VIEWPORT_SIZE = 400;
    const CROP_SIZE = 250;
    const OFFSET = (VIEWPORT_SIZE - CROP_SIZE) / 2;

    const handleMouseDown = (e: React.MouseEvent) => {
        e.preventDefault();
        setIsDragging(true);
        setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    };

    const handleMouseMove = (e: React.MouseEvent) => {
        if (isDragging && imgRef.current) {
            let newX = e.clientX - dragStart.x;
            let newY = e.clientY - dragStart.y;

            const w = imgRef.current.naturalWidth * scale;
            const h = imgRef.current.naturalHeight * scale;

            const minX = OFFSET + CROP_SIZE - w;
            const maxX = OFFSET;
            const minY = OFFSET + CROP_SIZE - h;
            const maxY = OFFSET;

            if (newX > maxX) newX = maxX;
            if (newX < minX) newX = minX;
            if (newY > maxY) newY = maxY;
            if (newY < minY) newY = minY;

            setPosition({ x: newX, y: newY });
        }
    };

    const handleMouseUp = () => setIsDragging(false);

    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        let initialScale;
        let initialPosition = { x: 0, y: 0 };

        if (initialBox) {
            // 如果有初始人脸框，根据人脸框计算缩放和位置
            const boxWidth = img.naturalWidth * (initialBox.w / 100);
            const boxHeight = img.naturalHeight * (initialBox.h / 100);
            const boxAspect = boxWidth / boxHeight;

            // 计算适合裁剪区域的缩放比例
            const scaleX = CROP_SIZE * 1.5 / boxWidth;
            const scaleY = CROP_SIZE * 1.5 / boxHeight;
            initialScale = Math.max(scaleX, scaleY);

            // 计算位置，使人脸框中心对准裁剪区域中心
            const boxCenterX = img.naturalWidth * (initialBox.x / 100) + boxWidth / 2;
            const boxCenterY = img.naturalHeight * (initialBox.y / 100) + boxHeight / 2;

            initialPosition = {
                x: VIEWPORT_SIZE / 2 - boxCenterX * initialScale,
                y: VIEWPORT_SIZE / 2 - boxCenterY * initialScale
            };
        } else {
            // 默认行为：居中显示
            const minScale = CROP_SIZE / Math.min(img.naturalWidth, img.naturalHeight);
            initialScale = Math.max(minScale, 0.5);

            initialPosition = {
                x: (VIEWPORT_SIZE - img.naturalWidth * initialScale) / 2,
                y: (VIEWPORT_SIZE - img.naturalHeight * initialScale) / 2
            };
        }

        setScale(initialScale);
        setPosition(initialPosition);
    };

    const handleWheel = (e: React.WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!imgRef.current) return;

        const ZOOM_SPEED = 0.1;
        const direction = Math.sign(e.deltaY);
        let newScale = scale;

        if (direction < 0) {
            newScale = scale * (1 + ZOOM_SPEED);
        } else {
            newScale = scale / (1 + ZOOM_SPEED);
        }

        const minScale = CROP_SIZE / Math.min(imgRef.current.naturalWidth, imgRef.current.naturalHeight);
        newScale = Math.max(minScale, Math.min(newScale, 5));

        const w = imgRef.current.naturalWidth * newScale;
        const h = imgRef.current.naturalHeight * newScale;

        let newX = position.x;
        let newY = position.y;

        const cx = (OFFSET + CROP_SIZE / 2 - position.x) / scale;
        const cy = (OFFSET + CROP_SIZE / 2 - position.y) / scale;

        newX = OFFSET + CROP_SIZE / 2 - cx * newScale;
        newY = OFFSET + CROP_SIZE / 2 - cy * newScale;

        const minX = OFFSET + CROP_SIZE - w;
        const maxX = OFFSET;
        const minY = OFFSET + CROP_SIZE - h;
        const maxY = OFFSET;

        if (newX > maxX) newX = maxX;
        if (newX < minX) newX = minX;
        if (newY > maxY) newY = maxY;
        if (newY < minY) newY = minY;

        setScale(newScale);
        setPosition({ x: newX, y: newY });
    };

    const handleSave = () => {
        if (!imgRef.current) return;
        const natW = imgRef.current.naturalWidth;
        const natH = imgRef.current.naturalHeight;

        const x = (OFFSET - position.x) / scale;
        const y = (OFFSET - position.y) / scale;
        const w = CROP_SIZE / scale;
        const h = CROP_SIZE / scale;

        onConfirm({
            x: (x / natW) * 100,
            y: (y / natH) * 100,
            w: (w / natW) * 100,
            h: (h / natH) * 100,
            imageId: currentImageId
        });
    };

    useEffect(() => {
        const el = containerRef.current;
        if (el) {
            const wheelListener = (e: WheelEvent) => handleWheel(e as any);
            el.addEventListener('wheel', wheelListener, { passive: false });
            return () => el.removeEventListener('wheel', wheelListener);
        }
    }, [scale, position]);

    return (
        <div className="fixed inset-0 z-[150] bg-black/70 flex items-center justify-center p-4 animate-fade-in" onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
            <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden flex flex-col w-full max-w-5xl h-[85vh]" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-black/20">
                    <h3 className="font-bold text-lg text-gray-800 dark:text-white">
                        {t('context.setAvatar') || '设置头像'}
                    </h3>
                </div>

                {/* Main Content Area */}
                <div className="flex-1 flex flex-row overflow-hidden">
                    {/* Left: Crop Preview */}
                    <div className="flex-none p-6 flex flex-col items-center justify-center bg-gray-100 dark:bg-black/20 border-r border-gray-200 dark:border-gray-800">
                        <div
                            ref={containerRef}
                            className="relative bg-gray-200 dark:bg-black overflow-hidden cursor-move select-none shadow-lg rounded-full mb-6"
                            style={{ width: VIEWPORT_SIZE, height: VIEWPORT_SIZE }}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                        >
                            <img
                                ref={imgRef}
                                src={fileUrl}
                                draggable={false}
                                onLoad={handleImageLoad}
                                className="max-w-none absolute origin-top-left pointer-events-none"
                                style={{
                                    transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`
                                }}
                                alt="Avatar preview"
                            />
                            <div className="absolute inset-0 pointer-events-none">
                                <svg width="100%" height="100%">
                                    <defs>
                                        <mask id="cropMask">
                                            <rect x="0" y="0" width="100%" height="100%" fill="white" />
                                            <circle cx={VIEWPORT_SIZE / 2} cy={VIEWPORT_SIZE / 2} r={CROP_SIZE / 2} fill="black" />
                                        </mask>
                                    </defs>
                                    <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.6)" mask="url(#cropMask)" />

                                    <circle
                                        cx={VIEWPORT_SIZE / 2}
                                        cy={VIEWPORT_SIZE / 2}
                                        r={CROP_SIZE / 2}
                                        fill="none"
                                        stroke="white"
                                        strokeWidth="2"
                                        style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }}
                                    />
                                </svg>
                            </div>
                        </div>

                        <div className="text-xs text-gray-500 text-center bg-white dark:bg-gray-800 px-3 py-1.5 rounded-full shadow-sm border border-gray-200 dark:border-gray-800">
                            {t('context.cropHint') || '拖拽图片调整位置 • 滚轮缩放'}
                        </div>
                    </div>

                    {/* Right: File Selection */}
                    <div className="flex-1 overflow-hidden flex flex-col bg-white dark:bg-gray-900">
                        <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50/50 dark:bg-black/10">
                            <div className="relative">
                                <input
                                    type="text"
                                    placeholder={t('search.placeholder') || '搜索...'}
                                    value={searchQuery}
                                    onChange={(e) => setSearchQuery(e.target.value)}
                                    className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm shadow-sm"
                                />
                                <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                            </div>
                        </div>

                        <div className="flex-1 overflow-y-auto p-4">
                            {filteredImages.length === 0 ? (
                                <div className="text-center text-gray-500 dark:text-gray-400 py-12 flex flex-col items-center">
                                    <ImageIcon size={48} className="mb-4 opacity-10" />
                                    <p>{t('context.noImagesFound')}</p>
                                </div>
                            ) : (
                                <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                    {filteredImages.map((file) => {
                                        const isSelected = selectedFile === file.id;
                                        return (
                                            <div
                                                key={file.id}
                                                onClick={() => handleImageSelect(file)}
                                                className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all duration-200 shadow-sm ${isSelected ? 'border-blue-500 ring-2 ring-blue-500/20 shadow-md' : 'border-transparent hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md'
                                                    }`}
                                            >
                                                <div className="relative aspect-square">
                                                    <ImageThumbnail
                                                        src={''}
                                                        alt={file.name}
                                                        isSelected={isSelected}
                                                        filePath={file.path}
                                                        modified={file.updatedAt}
                                                        isHovering={false}
                                                        fileMeta={file.meta}
                                                        resourceRoot={resourceRoot}
                                                        cachePath={cachePath}
                                                    />
                                                    {isSelected && (
                                                        <div className="absolute inset-0 bg-blue-500/30 flex items-center justify-center pointer-events-none">
                                                            <div className="bg-blue-500 rounded-full p-1 shadow-lg">
                                                                <Check size={20} className="text-white" />
                                                            </div>
                                                        </div>
                                                    )}
                                                </div>
                                                <div className="p-2 bg-gray-50 dark:bg-black/20 border-t border-gray-100 dark:border-gray-800">
                                                    <p className="text-xs text-gray-600 dark:text-gray-300 truncate font-medium">
                                                        {file.name}
                                                    </p>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-black/30 rounded-b-xl flex items-center justify-between">
                    {/* Zoom Control */}
                    <div className="flex-1 max-w-xs">
                        <div className="flex items-center space-x-3 bg-white dark:bg-gray-800 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm">
                            <span className="text-xs font-medium text-gray-500 whitespace-nowrap">{t('context.zoom') || '缩放'}</span>
                            <input
                                type="range"
                                min="0.1"
                                max="5"
                                step="0.01"
                                value={scale}
                                onChange={(e) => {
                                    const newScale = parseFloat(e.target.value);
                                    if (imgRef.current) {
                                        const minScale = CROP_SIZE / Math.min(imgRef.current.naturalWidth, imgRef.current.naturalHeight);
                                        if (newScale >= minScale) setScale(newScale);
                                    } else {
                                        setScale(newScale);
                                    }
                                }}
                                className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
                            />
                        </div>
                    </div>

                    <div className="flex space-x-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition shadow-sm"
                        >
                            {t('settings.cancel') || '取消'}
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={!selectedFile}
                            className="px-8 py-2 text-sm font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg transform active:scale-95"
                        >
                            {t('settings.confirm') || '确认'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
