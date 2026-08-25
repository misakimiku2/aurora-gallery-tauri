// 视口变换
export interface Transform {
  x: number;
  y: number;
  scale: number;
}

// 内容边界（世界坐标）
export interface ContentBounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

// 以指定点（屏幕坐标）为中心缩放视口，保持该点下的内容不动
export function zoomAtPoint(
  transform: Transform,
  pointX: number,
  pointY: number,
  factor: number,
  minScale = 0.01,
  maxScale = 20
): Transform {
  const newScale = Math.min(Math.max(transform.scale * factor, minScale), maxScale);
  const newX = pointX - (pointX - transform.x) * (newScale / transform.scale);
  const newY = pointY - (pointY - transform.y) * (newScale / transform.scale);
  return { x: newX, y: newY, scale: newScale };
}

// 计算使内容边界适应容器并居中的视口变换。
// 内容尺寸无效（<=0）时返回 null。
export function computeFitTransform(
  containerWidth: number,
  containerHeight: number,
  bounds: ContentBounds,
  padding = 60,
  maxScale = 1.2
): Transform | null {
  const contentWidth = bounds.maxX - bounds.minX;
  const contentHeight = bounds.maxY - bounds.minY;
  if (contentWidth <= 0 || contentHeight <= 0) return null;

  const scaleX = (containerWidth - padding * 2) / contentWidth;
  const scaleY = (containerHeight - padding * 2) / contentHeight;
  const scale = Math.min(scaleX, scaleY, maxScale);

  const centerX = bounds.minX + contentWidth / 2;
  const centerY = bounds.minY + contentHeight / 2;

  return {
    x: containerWidth / 2 - centerX * scale,
    y: containerHeight / 2 - centerY * scale,
    scale
  };
}
