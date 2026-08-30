// 安卓端三档固定图标大小（小/中/大）。
// thumbnailSize 在网格布局中作为「最小列宽」参与列数计算，实际图标宽度由
// 容器宽度自动铺满。为避免手机/平板宽度差异导致档位失效，这里按当前容器
// 宽度自适应换算：每个档位对应一个目标列数，再反推出 thumbnailSize。
//  - 平板（≥600px，如三星 Tab S8+ 约 1322px）：小/中/大 ≈ 9/6/4 列（约 127/199/307px）
//  - 手机（<600px，约 390px）：小/中/大 ≈ 3/2/1 列
// 中档为默认，等价于原有 180 的默认布局（Tab S8+ 上 6 列 × 199px）。

export type AndroidThumbnailLevel = 'small' | 'medium' | 'large';

export const ANDROID_THUMBNAIL_LEVELS: AndroidThumbnailLevel[] = ['small', 'medium', 'large'];

export const DEFAULT_ANDROID_THUMBNAIL_LEVEL: AndroidThumbnailLevel = 'medium';

// 与 layout.worker.ts 保持一致的间距/内边距策略（手机端更紧凑）
function getAndroidGapPadding(containerWidth: number): { gap: number; padding: number } {
  const isPhone = containerWidth < 600;
  return { gap: isPhone ? 10 : 16, padding: isPhone ? 8 : 24 };
}

// 各档位目标列数随宽度自适应，保证任何屏幕都能铺满且网格得体
export function getAndroidLevelTargetCols(containerWidth: number, level: AndroidThumbnailLevel): number {
  const w = Math.max(containerWidth, 1);
  switch (level) {
    case 'small':
      return Math.max(3, Math.round(w / 150));
    case 'medium':
      return Math.max(2, Math.round(w / 220));
    case 'large':
      return Math.max(1, Math.round(w / 330));
  }
}

// 将某档位换算为 thumbnailSize（最小列宽）：使网格列数≈该档位目标列数
export function androidLevelToThumbnailSize(containerWidth: number, level: AndroidThumbnailLevel): number {
  const { gap, padding } = getAndroidGapPadding(containerWidth);
  const availableWidth = Math.max(100, containerWidth - padding * 2);
  const target = getAndroidLevelTargetCols(containerWidth, level);
  const minColWidth = (availableWidth + gap) / target - gap;
  return Math.max(100, Math.min(480, minColWidth));
}

// 三个档位对应的 thumbnailSize 预设（升序：小 < 中 < 大）
export function getAndroidThumbnailPresets(containerWidth: number): number[] {
  return ANDROID_THUMBNAIL_LEVELS
    .map(level => androidLevelToThumbnailSize(containerWidth, level))
    .sort((a, b) => a - b);
}

// 返回 value 最接近的档位下标（0=小, 1=中, 2=大）
export function nearestAndroidLevelIndex(value: number, containerWidth: number): number {
  const presets = getAndroidThumbnailPresets(containerWidth);
  let best = 0;
  let bestDist = Math.abs(value - presets[0]);
  for (let i = 1; i < presets.length; i++) {
    const dist = Math.abs(value - presets[i]);
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}