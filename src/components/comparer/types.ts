import { FileNode } from '../types';

export interface ComparisonItem extends ImageLayoutInfo {
    rotation: number; // 旋转角度（度）
    opacity: number;
}

export interface ImageLayoutInfo {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    src: string;
}

export interface Annotation {
    id: string;
    imageId: string; // 关联的图片 ID
    x: number; // 相对于图片左上角的百分比 (0-100)
    y: number;
    text: string;
    createdAt: number;
}

export interface ComparisonSession {
    version: string;
    items: {
        id: string;
        path: string;
        x: number;
        y: number;
        width: number;
        height: number;
        rotation: number;
    }[];
    annotations: Annotation[];
}
