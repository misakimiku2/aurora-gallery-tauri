// 注意：FileNode 类型定义在 src/types.ts

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
    zOrder?: string[];
}

// V2 版本：ZIP 格式存储
export interface ComparisonSessionManifest {
    version: '2.0';
    createdAt: number;
    sessionName: string;
}

export interface ComparisonSessionViewport {
    scale: number;
    x: number;
    y: number;
}

export interface ComparisonSessionLayout {
    items: {
        id: string;
        path: string;
        x: number;
        y: number;
        width: number;
        height: number;
        rotation: number;
        imageFileName: string; // ZIP 中的图片文件名
    }[];
    annotations: Annotation[];
    zOrder: string[];
}
