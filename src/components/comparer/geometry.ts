import { ComparisonItem } from './types';

// 轴对齐包围盒（Axis-Aligned Bounding Box）
export interface AABB {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// 绕中心点 (cx, cy) 旋转一个点 (x, y)，angleDeg 单位为度
export function rotatePointAround(x: number, y: number, cx: number, cy: number, angleDeg: number): { x: number; y: number } {
  const rad = angleDeg * Math.PI / 180;
  const dx = x - cx;
  const dy = y - cy;
  const rx = dx * Math.cos(rad) - dy * Math.sin(rad);
  const ry = dx * Math.sin(rad) + dy * Math.cos(rad);
  return { x: rx + cx, y: ry + cy };
}

// 判断世界坐标点是否落在（已旋转的）图片内部
export function pointInRotatedItem(worldX: number, worldY: number, it: ComparisonItem): boolean {
  const cx = it.x + it.width / 2;
  const cy = it.y + it.height / 2;
  const local = rotatePointAround(worldX, worldY, cx, cy, -it.rotation);
  return local.x >= it.x && local.x <= it.x + it.width && local.y >= it.y && local.y <= it.y + it.height;
}

// 世界坐标 -> 图片局部坐标（消除旋转）
export function worldToLocalPoint(worldX: number, worldY: number, it: ComparisonItem): { x: number; y: number } {
  const cx = it.x + it.width / 2;
  const cy = it.y + it.height / 2;
  return rotatePointAround(worldX, worldY, cx, cy, -it.rotation);
}

// 计算（已旋转的）图片的轴对齐包围盒 AABB
export function computeAABB(it: ComparisonItem): AABB {
  const cx = it.x + it.width / 2;
  const cy = it.y + it.height / 2;
  const corners = [
    { x: it.x, y: it.y },
    { x: it.x + it.width, y: it.y },
    { x: it.x + it.width, y: it.y + it.height },
    { x: it.x, y: it.y + it.height }
  ].map(c => rotatePointAround(c.x, c.y, cx, cy, it.rotation));
  const xs = corners.map(c => c.x);
  const ys = corners.map(c => c.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

// 判断两个 AABB 是否重叠
export function aabbOverlap(a: AABB, b: AABB): boolean {
  return !(a.maxX < b.minX || a.minX > b.maxX || a.maxY < b.minY || a.minY > b.maxY);
}
