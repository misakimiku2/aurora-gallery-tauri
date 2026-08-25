import { FileNode } from '../../types';
import { ImageLayoutInfo } from './types';
import { resolveImageSrc } from './imageSource';

// 矩形装箱布局：按面积降序排列，围绕已放置图片的边缘生成候选位置，
// 选择离原点最近且不与现有图片重叠的位置。
export function packImages(files: FileNode[], spacing = 40): ImageLayoutInfo[] {
  if (files.length === 0) return [];

  const packOrder = files.slice().sort((a, b) => {
    const sizeA = (a.meta?.width || 0) * (a.meta?.height || 0);
    const sizeB = (b.meta?.width || 0) * (b.meta?.height || 0);
    return sizeB - sizeA;
  });

  const checkOverlap = (rect: { x: number; y: number; w: number; h: number }, existing: ImageLayoutInfo[]) => {
    for (const item of existing) {
      if (
        rect.x < item.x + item.width + spacing - 1 &&
        rect.x + rect.w + spacing - 1 > item.x &&
        rect.y < item.y + item.height + spacing - 1 &&
        rect.y + rect.h + spacing - 1 > item.y
      ) {
        return true;
      }
    }
    return false;
  };

  const first = packOrder[0];
  const firstW = first.meta?.width || 1000;
  const firstH = first.meta?.height || 750;

  const items: ImageLayoutInfo[] = [{
    id: first.id,
    x: -firstW / 2,
    y: -firstH / 2,
    width: firstW,
    height: firstH,
    src: resolveImageSrc(first)
  }];

  for (let i = 1; i < packOrder.length; i++) {
    const file = packOrder[i];
    const w = file.meta?.width || 1000;
    const h = file.meta?.height || 750;

    let bestPos = { x: 0, y: 0 };
    let minDistance = Infinity;
    const candidates: { x: number; y: number }[] = [];

    items.forEach(item => {
      candidates.push({ x: item.x + item.width + spacing, y: item.y });
      candidates.push({ x: item.x - w - spacing, y: item.y });
      candidates.push({ x: item.x, y: item.y + item.height + spacing });
      candidates.push({ x: item.x, y: item.y - h - spacing });
      candidates.push({ x: item.x + item.width + spacing, y: item.y + item.height - h });
      candidates.push({ x: item.x - w - spacing, y: item.y + item.height - h });
      candidates.push({ x: item.x + item.width - w, y: item.y + item.height + spacing });
      candidates.push({ x: item.x, y: item.y - h - spacing });
    });

    for (const cand of candidates) {
      if (!checkOverlap({ x: cand.x, y: cand.y, w: w, h: h }, items)) {
        const dist = Math.sqrt(Math.pow(cand.x + w / 2, 2) + Math.pow(cand.y + h / 2, 2));
        if (dist < minDistance) {
          minDistance = dist;
          bestPos = cand;
        }
      }
    }

    items.push({
      id: file.id,
      x: bestPos.x,
      y: bestPos.y,
      width: w,
      height: h,
      src: resolveImageSrc(file)
    });
  }

  return items;
}
