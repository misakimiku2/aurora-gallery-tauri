import React, { useState } from 'react';
import { Annotation, ComparisonItem } from './types';
import { MessageSquare, X } from 'lucide-react';

interface AnnotationLayerProps {
    activeItem: ComparisonItem | null;
    annotations: Annotation[];
    transform: { x: number; y: number; scale: number };
    onAddAnnotation: (imageId: string, x: number, y: number, text: string) => void;
    onRemoveAnnotation: (id: string) => void;
}

export const AnnotationLayer: React.FC<AnnotationLayerProps> = ({
    activeItem,
    annotations,
    transform,
    onAddAnnotation,
    onRemoveAnnotation
}) => {
    const [editingId, setEditingId] = useState<string | null>(null);

    return (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
            {annotations.map(anno => {
                // 查找关联的图片布局信息
                // 注意：这里需要根据图片 ID 实时计算屏幕位置，因为图片可能在移动
                return <AnnotationItem
                    key={anno.id}
                    anno={anno}
                    transform={transform}
                    onRemove={() => onRemoveAnnotation(anno.id)}
                />;
            })}
        </div>
    );
};

const AnnotationItem: React.FC<{
    anno: Annotation,
    transform: any,
    onRemove: () => void
}> = ({ anno, transform, onRemove }) => {
    // 简化的渲染：直接基于全局坐标，实际需要传入 layout 信息映射
    // 这里假设我们能拿到对应图片的 x, y, w, h, rotation
    // 暂略：待与 ImageComparer 整合时完善计算逻辑
    return null;
};
