import React, { useState, useEffect, useRef } from 'react';
import { Annotation, ComparisonItem } from './types';
import { Trash2, Save } from 'lucide-react';

interface AnnotationLayerProps {
    annotations: Annotation[];
    layoutItems: ComparisonItem[];
    zOrderIds: string[];
    transform: { x: number; y: number; scale: number };
    onUpdateAnnotation: (id: string, text: string) => void;
    onRemoveAnnotation: (id: string) => void;
    pendingAnnotation?: { imageId: string, x: number, y: number } | null;
    onSavePending: (text: string) => void;
    onCancelPending: () => void;
}

const rotatePointAround = (x: number, y: number, cx: number, cy: number, angleDeg: number) => {
    const rad = angleDeg * Math.PI / 180;
    const dx = x - cx;
    const dy = y - cy;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
    return { x: rx + cx, y: ry + cy };
};

const pointInRotatedItem = (worldX: number, worldY: number, it: ComparisonItem) => {
    const cx = it.x + it.width / 2;
    const cy = it.y + it.height / 2;
    const rad = (-it.rotation * Math.PI) / 180;
    const dx = worldX - cx;
    const dy = worldY - cy;
    const rx = dx * Math.cos(rad) - dy * Math.sin(rad) + cx;
    const ry = dx * Math.sin(rad) + dy * Math.cos(rad) + cy;
    return rx >= it.x && rx <= it.x + it.width && ry >= it.y && ry <= it.y + it.height;
};

export const AnnotationLayer: React.FC<AnnotationLayerProps> = ({
    annotations,
    layoutItems,
    zOrderIds,
    transform,
    onUpdateAnnotation,
    onRemoveAnnotation,
    pendingAnnotation,
    onSavePending,
    onCancelPending
}) => {
    const worldToScreen = (wx: number, wy: number) => ({
        x: wx * transform.scale + transform.x,
        y: wy * transform.scale + transform.y
    });

    const itemMap = React.useMemo(() => {
        const m: Record<string, ComparisonItem> = {};
        layoutItems.forEach(it => m[it.id] = it);
        return m;
    }, [layoutItems]);

    return (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
            {annotations.map(anno => {
                const item = itemMap[anno.imageId];
                if (!item) return null;

                // 计算注释在世界坐标中的位置（考虑图片旋转）
                const localX = item.x + (anno.x / 100) * item.width;
                const localY = item.y + (anno.y / 100) * item.height;
                const centerX = item.x + item.width / 2;
                const centerY = item.y + item.height / 2;
                const rotated = rotatePointAround(localX, localY, centerX, centerY, item.rotation);

                // 检查是否被更高层的图片遮挡
                const imgIdx = zOrderIds.indexOf(anno.imageId);
                const isCovered = zOrderIds.slice(imgIdx + 1).some(id => {
                    const other = itemMap[id];
                    return other && pointInRotatedItem(rotated.x, rotated.y, other);
                });

                if (isCovered || transform.scale < 0.25) return null;

                const screen = worldToScreen(rotated.x, rotated.y);

                return (
                    <AnnotationItem
                        key={anno.id}
                        annotation={anno}
                        position={screen}
                        onUpdate={(text) => onUpdateAnnotation(anno.id, text)}
                        onRemove={() => onRemoveAnnotation(anno.id)}
                    />
                );
            })}

            {pendingAnnotation && (() => {
                const item = itemMap[pendingAnnotation.imageId];
                if (!item) return null;

                const localX = item.x + (pendingAnnotation.x / 100) * item.width;
                const localY = item.y + (pendingAnnotation.y / 100) * item.height;
                const rotated = rotatePointAround(localX, localY, item.x + item.width / 2, item.y + item.height / 2, item.rotation);
                const screen = worldToScreen(rotated.x, rotated.y);

                return (
                    <PendingAnnotationItem
                        position={screen}
                        onSave={onSavePending}
                        onCancel={onCancelPending}
                    />
                );
            })()}
        </div>
    );
};

const AnnotationItem: React.FC<{
    annotation: Annotation;
    position: { x: number, y: number };
    onUpdate: (text: string) => void;
    onRemove: () => void;
}> = ({ annotation, position, onUpdate, onRemove }) => {
    const [isHovered, setIsHovered] = useState(false);
    const [showInfo, setShowInfo] = useState(false);
    const [isEditing, setIsEditing] = useState(false);
    const [isSticky, setIsSticky] = useState(false);
    const hoverTimer = useRef<any>(null);

    const handleMouseEnter = () => {
        setIsHovered(true);
        hoverTimer.current = setTimeout(() => {
            setShowInfo(true);
        }, 1000); // 1秒后显示
    };

    const handleMouseLeave = () => {
        setIsHovered(false);
        setShowInfo(false);
        if (hoverTimer.current) clearTimeout(hoverTimer.current);
    };

    const handleSave = (text: string) => {
        onUpdate(text);
        setIsEditing(false);
        setShowInfo(false);
        setIsSticky(false);
    };

    return (
        <div
            className={`absolute pointer-events-auto transition-transform duration-200 ${isHovered || isEditing || isSticky ? 'z-[130]' : 'z-[105]'}`}
            style={{ left: position.x, top: position.y }}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
                e.stopPropagation();
                setIsSticky(prev => !prev);
            }}
        >
            {/* 注释点 */}
            <div
                className={`w-3 h-3 rounded-full border border-white shadow-lg cursor-pointer transform -translate-x-1/2 -translate-y-1/2 transition-all duration-200 ${isHovered || isSticky ? 'bg-blue-500 scale-125 opacity-100 animate-dot-pulse-active' : 'bg-gray-500/60 dark:bg-gray-400/60 opacity-80 animate-dot-pulse'
                    }`}
            />

            {/* 信息/编辑窗口 */}
            {(showInfo || isEditing || isSticky) && (
                <div
                    className="absolute top-4 left-4 min-w-[320px] bg-white/80 dark:bg-gray-800/80 backdrop-blur-md rounded-xl shadow-2xl border border-gray-200 dark:border-gray-700 overflow-hidden animate-zoom-in animate-fade-in"
                    onClick={(e) => e.stopPropagation()}
                >
                    {isEditing ? (
                        <div className="p-4">
                            <textarea
                                autoFocus
                                className="w-full h-32 p-3 text-sm bg-white/50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none dark:text-gray-100 placeholder-gray-400"
                                defaultValue={annotation.text}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter' && e.shiftKey) {
                                        e.preventDefault();
                                        handleSave(e.currentTarget.value);
                                    } else if (e.key === 'Escape') {
                                        setIsEditing(false);
                                    }
                                }}
                            />
                            <div className="mt-3">
                                <div className="flex items-center justify-end space-x-3 mb-2">
                                    <button
                                        onClick={() => {
                                            setIsEditing(false);
                                            setIsSticky(false);
                                        }}
                                        className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                                    >
                                        取消
                                    </button>
                                    <button
                                        onClick={(e) => {
                                            const textarea = (e.currentTarget.parentElement?.parentElement?.previousElementSibling as HTMLTextAreaElement);
                                            handleSave(textarea.value);
                                        }}
                                        className="px-4 py-1.5 text-xs font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 flex items-center shadow-lg shadow-blue-500/20 transition-all active:scale-95"
                                    >
                                        <Save size={14} className="mr-1.5" />
                                        保存
                                    </button>
                                </div>
                                <div className="text-[10px] text-gray-400 dark:text-gray-500 italic text-right px-1">
                                    Shift + Enter 保存
                                </div>
                            </div>
                        </div>
                    ) : (
                        <div
                            className="p-4 cursor-pointer group"
                            onClick={() => setIsEditing(true)}
                        >
                            <div className="flex justify-between items-start mb-2">
                                <span className="text-[10px] font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">点击进行编辑</span>
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        onRemove();
                                    }}
                                    className="opacity-0 group-hover:opacity-100 p-1 text-gray-400 hover:text-red-500 transition-all rounded-md hover:bg-red-50 dark:hover:bg-red-900/20"
                                >
                                    <Trash2 size={14} />
                                </button>
                            </div>
                            <p className="text-sm leading-relaxed text-gray-700 dark:text-gray-200 whitespace-pre-wrap break-words">
                                {annotation.text}
                            </p>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

const PendingAnnotationItem: React.FC<{
    position: { x: number, y: number };
    onSave: (text: string) => void;
    onCancel: () => void;
}> = ({ position, onSave, onCancel }) => {
    return (
        <div
            className="absolute z-[200] pointer-events-auto"
            style={{ left: position.x, top: position.y }}
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="w-3 h-3 rounded-full bg-blue-500 border-2 border-white shadow-lg transform -translate-x-1/2 -translate-y-1/2 scale-125 animate-pulse" />

            <div className="absolute top-4 left-4 min-w-[320px] bg-white/80 dark:bg-gray-800/80 backdrop-blur-md rounded-xl shadow-2xl border border-blue-400/50 p-4 animate-zoom-in animate-fade-in">
                <textarea
                    autoFocus
                    className="w-full h-32 p-3 text-sm bg-white/50 dark:bg-gray-900/50 border border-gray-300 dark:border-gray-600 rounded-lg focus:ring-2 focus:ring-blue-500 outline-none resize-none dark:text-gray-100 placeholder-gray-400"
                    placeholder="输入注释信息..."
                    onKeyDown={(e) => {
                        if (e.key === 'Enter' && e.shiftKey) {
                            e.preventDefault();
                            if (e.currentTarget.value.trim()) onSave(e.currentTarget.value);
                        } else if (e.key === 'Escape') {
                            onCancel();
                        }
                    }}
                />
                <div className="mt-3">
                    <div className="flex items-center justify-end space-x-3 mb-2">
                        <button
                            onClick={onCancel}
                            className="px-3 py-1.5 text-xs font-medium text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                        >
                            取消
                        </button>
                        <button
                            onClick={(e) => {
                                const textarea = (e.currentTarget.parentElement?.parentElement?.previousElementSibling as HTMLTextAreaElement);
                                if (textarea.value.trim()) onSave(textarea.value);
                            }}
                            className="px-4 py-1.5 text-xs font-medium bg-blue-500 text-white rounded-lg hover:bg-blue-600 flex items-center shadow-lg shadow-blue-500/20 transition-all active:scale-95"
                        >
                            <Save size={14} className="mr-1.5" />
                            保存
                        </button>
                    </div>
                    <div className="text-[10px] text-gray-400 dark:text-gray-500 italic text-right px-1">
                        Shift + Enter 保存
                    </div>
                </div>
            </div>
        </div>
    );
};
