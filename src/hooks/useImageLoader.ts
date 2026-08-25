import { useEffect, useMemo, useRef, useState } from 'react';
import { FileNode } from '../types';
import { MipmapCache, createMipmapLevels } from '../components/comparer/mipmap';
import { resolveImageSrc } from '../components/comparer/imageSource';

// 图片加载与多级 Mipmap 缓存管理。
// 负责将 imageFiles 逐个加载进 imagesCache，并维护加载进度状态。
export function useImageLoader(imageFiles: FileNode[], isAndroid: boolean) {
  // 多级 Mipmap 缓存
  const imagesCache = useRef<Map<string, MipmapCache>>(new Map());
  const loadingIdsRef = useRef<Set<string>>(new Set());
  const [loadedCount, setLoadedCount] = useState(0);

  // 基于实际缓存状态判断加载进度，loadedCount 作为触发器确保重渲染
  const isLoadingCanvas = useMemo(() => {
    if (imageFiles.length === 0) return false;
    const cachedCount = imageFiles.filter(file => imagesCache.current.has(file.id)).length;
    return cachedCount < imageFiles.length;
  }, [imageFiles, loadedCount]);

  // 同步 loadedCount 与实际缓存，避免计数器不同步导致加载覆盖层卡住
  const realLoadedCount = useMemo(() => {
    return imageFiles.filter(file => imagesCache.current.has(file.id)).length;
  }, [imageFiles, loadedCount]);

  // Load images & create mipmap levels (batch loading on Android)
  useEffect(() => {
    const filesToLoad = imageFiles.filter(
      file => !imagesCache.current.has(file.id) && !loadingIdsRef.current.has(file.id)
    );

    if (filesToLoad.length === 0) return;

    const batchSize = isAndroid ? 4 : 8;
    let loadIndex = 0;
    let cancelled = false;
    const pendingRafs: number[] = [];
    const pendingTimeouts: ReturnType<typeof setTimeout>[] = [];

    const loadNextBatch = () => {
      if (cancelled) return;
      const batch = filesToLoad.slice(loadIndex, loadIndex + batchSize);
      if (batch.length === 0) return;
      loadIndex += batchSize;

      batch.forEach(file => {
        if (cancelled || loadingIdsRef.current.has(file.id)) return;
        loadingIdsRef.current.add(file.id);
        const img = new Image();
        const loadStart = performance.now();
        img.src = resolveImageSrc(file);
        img.onload = () => {
          if (cancelled) return;
          const w = file.meta?.width || img.width;
          const h = file.meta?.height || img.height;
          const loadTime = performance.now() - loadStart;

          if (isAndroid) {
            console.log(`[Canvas] Image loaded: ${w}x${h} (${(w * h / 1000000).toFixed(1)}MP) in ${loadTime.toFixed(0)}ms - ${file.path.split('/').pop()}`);
          }

          if (isAndroid && w * h > 2000000) {
            const cacheStart = performance.now();
            const thumbScale = Math.min(256 / w, 256 / h, 1);
            const thumbCanvas = document.createElement('canvas');
            thumbCanvas.width = Math.round(w * thumbScale);
            thumbCanvas.height = Math.round(h * thumbScale);
            const thumbCtx = thumbCanvas.getContext('2d')!;
            thumbCtx.imageSmoothingEnabled = true;
            thumbCtx.imageSmoothingQuality = 'high';
            thumbCtx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);
            imagesCache.current.set(file.id, {
              original: img,
              levels: [{ canvas: thumbCanvas, scale: thumbScale }]
            });
            setLoadedCount(prev => prev + 1);
            console.log(`[Canvas] Cache with thumbnail: ${thumbCanvas.width}x${thumbCanvas.height} in ${(performance.now() - cacheStart).toFixed(0)}ms`);
            const rafId = requestAnimationFrame(() => {
              if (cancelled) return;
              const mipmapStart = performance.now();
              const levels = createMipmapLevels(img, w, h, true);
              const mipmapTime = performance.now() - mipmapStart;
              console.log(`[Canvas] Mipmap created: ${levels.length} levels in ${mipmapTime.toFixed(0)}ms for ${w}x${h}`);
              if (!cancelled && imagesCache.current.has(file.id)) {
                imagesCache.current.set(file.id, { original: img, levels });
              }
            });
            pendingRafs.push(rafId);
          } else {
            const cacheStart = performance.now();
            const levels = createMipmapLevels(img, w, h, isAndroid);
            imagesCache.current.set(file.id, {
              original: img,
              levels
            });
            if (isAndroid) {
              console.log(`[Canvas] Cache with mipmap: ${levels.length} levels in ${(performance.now() - cacheStart).toFixed(0)}ms`);
            }
            setLoadedCount(prev => prev + 1);
          }
        };
        img.onerror = () => {
          if (cancelled) return;
          console.warn(`[Canvas] Failed to load: ${file.path}`);
          setLoadedCount(prev => prev + 1);
        };
      });

      if (loadIndex < filesToLoad.length) {
        const tid = setTimeout(loadNextBatch, isAndroid ? 200 : 50);
        pendingTimeouts.push(tid);
      }
    };

    loadNextBatch();

    return () => {
      cancelled = true;
      pendingRafs.forEach(id => cancelAnimationFrame(id));
      pendingTimeouts.forEach(id => clearTimeout(id));
      // 清理正在加载的ID，防止下次加载时跳过这些已被取消的图片
      loadingIdsRef.current.clear();
    };
  }, [imageFiles]);

  return { imagesCache, loadingIdsRef, loadedCount, setLoadedCount, isLoadingCanvas, realLoadedCount };
}
