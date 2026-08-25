// 多级 Mipmap 缓存结构
export interface MipmapCache {
  original: HTMLImageElement;
  levels: {
    scale: number;
    canvas: HTMLCanvasElement;
  }[];
}

// 获取最适合当前缩放比例的缓存级别
export function getBestMipmapLevel(cache: MipmapCache, targetScale: number): HTMLImageElement | HTMLCanvasElement {
  if (targetScale >= 0.8 || cache.levels.length === 0) {
    return cache.original;
  }

  let bestLevel = cache.levels[0];
  let bestScore = Infinity;

  for (const level of cache.levels) {
    const effectiveScale = targetScale / level.scale;
    const score = Math.abs(Math.log(effectiveScale));
    if (score < bestScore) {
      bestScore = score;
      bestLevel = level;
    }
  }

  return bestLevel.canvas;
}

// 创建多级 Mipmap
export function createMipmapLevels(img: HTMLImageElement, originalWidth: number, originalHeight: number, androidOptimized = false): MipmapCache['levels'] {
  const levels: MipmapCache['levels'] = [];
  // 安卓端减少级别数量以节省内存和创建时间
  const scales = androidOptimized
    ? [0.5, 0.25, 0.125, 0.0625]
    : [0.75, 0.5, 0.375, 0.25, 0.1875, 0.125, 0.0625];

  for (const scale of scales) {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.floor(originalWidth * scale));
    canvas.height = Math.max(1, Math.floor(originalHeight * scale));
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    }
    levels.push({ scale, canvas });
  }

  return levels;
}
