import type { CSSProperties } from 'react';

/**
 * 裁剪框（百分比坐标）。统一 coverCrop 与 faceBox 的语义：
 * - x / y：裁剪区域左上角相对原图的百分比
 * - width / height：裁剪区域占原图的百分比
 *
 * 注意：这些裁剪都是「运行时 CSS 变换」，不真正裁切/保存图片，
 * 只是通过放大 + 偏移让容器只露出裁剪区域。
 */
export interface CropRect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** 人物头像 faceBox 的字段名是 w/h，统一映射到 CropRect 的 width/height */
export interface FaceBox {
    x: number;
    y: number;
    w: number;
    h: number;
}

/** 统一防零 + 上限夹紧，避免 10000 / 极小值 溢出、以及 crop 接近 100% 时位置溢出 */
const clamp = (v: number): number => Math.min(Math.max(v, 0.1), 99.9);

/**
 * 生成 <img> 绝对定位的裁剪样式：把图片放大到裁剪框填满容器，并偏移到只露出裁剪区域。
 * 与 background 版（cropToBackgroundStyle）数学等价，只是渲染路径不同。
 */
export function cropToImgStyle(crop: CropRect): CSSProperties {
    const w = clamp(crop.width);
    const h = clamp(crop.height);
    return {
        width: `${10000 / w}%`,
        height: `${10000 / h}%`,
        maxWidth: 'none',
        minWidth: 'unset',
        left: `${(-crop.x / w) * 100}%`,
        top: `${(-crop.y / h) * 100}%`,
    };
}

/** 生成 background-image 的裁剪样式（backgroundSize / backgroundPosition） */
export function cropToBackgroundStyle(crop: CropRect): CSSProperties {
    const w = clamp(crop.width);
    const h = clamp(crop.height);
    return {
        backgroundSize: `${10000 / w}% ${10000 / h}%`,
        backgroundPosition: `${(crop.x / (100 - w)) * 100}% ${(crop.y / (100 - h)) * 100}%`,
    };
}

/** faceBox(w/h) → CropRect(width/height) */
export function faceBoxToCrop(fb: FaceBox): CropRect {
    return { x: fb.x, y: fb.y, width: fb.w, height: fb.h };
}

/**
 * 无显式裁剪框时，按目标宽高比在图片中心取最大裁剪区域（百分比坐标）。
 * targetAspect 默认 1（正方形，用于人物头像），专题封面用 3/4。
 */
export function centerCrop(imgW: number, imgH: number, targetAspect: number = 1): CropRect {
    const imgAspect = imgW / imgH;
    const aspect = targetAspect;

    let cropW: number;
    let cropH: number;
    let cropX: number;
    let cropY: number;

    if (imgAspect > aspect) {
        // 图比目标宽，裁宽度
        cropH = 100;
        cropW = (aspect / imgAspect) * 100;
        cropX = (100 - cropW) / 2;
        cropY = 0;
    } else {
        // 图比目标高，裁高度
        cropW = 100;
        cropH = (imgAspect / aspect) * 100;
        cropX = 0;
        cropY = (100 - cropH) / 2;
    }

    return { x: cropX, y: cropY, width: cropW, height: cropH };
}
