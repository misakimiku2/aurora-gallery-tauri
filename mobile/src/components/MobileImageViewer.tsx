import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { convertFileSrc } from '@tauri-apps/api/core';
import { X, ChevronLeft, ChevronRight, ZoomIn, ZoomOut, RotateCw, Share2, Trash2, Info } from 'lucide-react';
import { AndroidImageInfo } from '../types';

interface MobileImageViewerProps {
  image: AndroidImageInfo;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  currentIndex: number;
  totalCount: number;
  images: AndroidImageInfo[];
  cacheRoot: string;
}

const PRELOAD_RANGE = 3;

interface PreviewCacheEntry {
  previewUrl: string;
  originalWidth: number;
  originalHeight: number;
  isDownsampled: boolean;
  isAnimatedWebp: boolean;
}

const previewCache = new Map<string, PreviewCacheEntry>();
const previewLoadingPromises = new Map<string, Promise<PreviewCacheEntry | null>>();
const MAX_PREVIEW_CACHE = 50;

function evictPreviewCache() {
  if (previewCache.size > MAX_PREVIEW_CACHE) {
    const keysToDelete = Array.from(previewCache.keys()).slice(0, previewCache.size - MAX_PREVIEW_CACHE);
    keysToDelete.forEach(k => previewCache.delete(k));
  }
}

async function loadImagePreview(imagePath: string, cacheRoot: string): Promise<PreviewCacheEntry | null> {
  const cached = previewCache.get(imagePath);
  if (cached) return cached;

  if (previewLoadingPromises.has(imagePath)) {
    return previewLoadingPromises.get(imagePath)!;
  }

  const loadPromise = (async () => {
    try {
      const result = await invoke<{
        previewPath: string;
        originalWidth: number;
        originalHeight: number;
        isDownsampled: boolean;
        isAnimatedWebp: boolean;
      }>('android_get_image_preview', {
        filePath: imagePath,
        cacheRoot,
      });

      const previewUrl = result.previewPath.startsWith('/')
        ? convertFileSrc(result.previewPath)
        : result.previewPath.startsWith('http')
          ? result.previewPath
          : convertFileSrc(result.previewPath);

      const entry: PreviewCacheEntry = {
        previewUrl,
        originalWidth: result.originalWidth,
        originalHeight: result.originalHeight,
        isDownsampled: result.isDownsampled,
        isAnimatedWebp: result.isAnimatedWebp,
      };

      previewCache.set(imagePath, entry);
      evictPreviewCache();
      return entry;
    } catch (e) {
      console.warn('Failed to load preview, falling back to direct URL:', e);
      const fallbackUrl = convertFileSrc(imagePath);
      const entry: PreviewCacheEntry = {
        previewUrl: fallbackUrl,
        originalWidth: 0,
        originalHeight: 0,
        isDownsampled: false,
        isAnimatedWebp: false,
      };
      previewCache.set(imagePath, entry);
      return entry;
    } finally {
      previewLoadingPromises.delete(imagePath);
    }
  })();

  previewLoadingPromises.set(imagePath, loadPromise);
  return loadPromise;
}

function preloadImage(imagePath: string, cacheRoot: string): void {
  if (!previewCache.has(imagePath) && !previewLoadingPromises.has(imagePath)) {
    loadImagePreview(imagePath, cacheRoot).catch(() => {});
  }
}

function getAnimatedUrl(imagePath: string): string {
  return convertFileSrc(imagePath);
}

export function MobileImageViewer({
  image,
  onClose,
  onPrev,
  onNext,
  currentIndex,
  totalCount,
  images,
  cacheRoot,
}: MobileImageViewerProps) {
  const [scale, setScale] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [showControls, setShowControls] = useState(true);
  const [previewUrl, setPreviewUrl] = useState<string>('');
  const [animatedUrl, setAnimatedUrl] = useState<string>('');
  const [isAnimatedLoaded, setIsAnimatedLoaded] = useState(false);
  const [isPreviewLoaded, setIsPreviewLoaded] = useState(false);
  const [imageInfo, setImageInfo] = useState<PreviewCacheEntry | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const touchStartRef = useRef<{ x: number; y: number } | null>(null);
  const currentPathRef = useRef<string>(image.path);
  const preloadedImagesRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    invoke('android_pause_thumbnail_workers').catch(() => {});
    return () => {
      invoke('android_resume_thumbnail_workers').catch(() => {});
    };
  }, []);

  useEffect(() => {
    if (!image?.path) return;

    const path = image.path;
    currentPathRef.current = path;

    setScale(1);
    setRotation(0);
    setPreviewUrl('');
    setAnimatedUrl('');
    setIsAnimatedLoaded(false);
    setIsPreviewLoaded(false);
    setImageInfo(null);

    const cached = previewCache.get(path);
    if (cached) {
      setPreviewUrl(cached.previewUrl);
      setImageInfo(cached);
      setIsPreviewLoaded(true);

      if (cached.isAnimatedWebp) {
        const animUrl = getAnimatedUrl(path);
        setAnimatedUrl(animUrl);
      }
    } else {
      loadImagePreview(path, cacheRoot).then(entry => {
        if (currentPathRef.current === path && entry) {
          setPreviewUrl(entry.previewUrl);
          setImageInfo(entry);
          setIsPreviewLoaded(true);

          if (entry.isAnimatedWebp) {
            const animUrl = getAnimatedUrl(path);
            setAnimatedUrl(animUrl);
          }
        }
      });
    }
  }, [image?.path, cacheRoot]);

  useEffect(() => {
    if (!images || images.length === 0 || !cacheRoot) return;

    const currentIdx = images.findIndex(img => img.path === image.path);
    if (currentIdx === -1) return;

    const start = Math.max(0, currentIdx - PRELOAD_RANGE);
    const end = Math.min(images.length - 1, currentIdx + PRELOAD_RANGE);

    for (let i = start; i <= end; i++) {
      if (i === currentIdx) continue;
      const imgPath = images[i].path;
      if (!preloadedImagesRef.current.has(imgPath)) {
        preloadedImagesRef.current.add(imgPath);
        preloadImage(imgPath, cacheRoot);
      }
    }
  }, [image?.path, images, cacheRoot]);

  useEffect(() => {
    if (!animatedUrl || !imageInfo?.isAnimatedWebp) return;

    const img = new Image();
    img.onload = () => {
      if (currentPathRef.current === image.path) {
        setIsAnimatedLoaded(true);
      }
    };
    img.src = animatedUrl;
  }, [animatedUrl, image?.path, imageInfo?.isAnimatedWebp]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose();
          break;
        case 'ArrowLeft':
          onPrev?.();
          break;
        case 'ArrowRight':
          onNext?.();
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onPrev, onNext]);

  const handleZoomIn = useCallback(() => {
    setScale(prev => Math.min(prev * 1.5, 5));
  }, []);

  const handleZoomOut = useCallback(() => {
    setScale(prev => Math.max(prev / 1.5, 0.5));
  }, []);

  const handleRotate = useCallback(() => {
    setRotation(prev => (prev + 90) % 360);
  }, []);

  const handleReset = useCallback(() => {
    setScale(1);
    setRotation(0);
  }, []);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      touchStartRef.current = {
        x: e.touches[0].clientX,
        y: e.touches[0].clientY,
      };
    }
  }, []);

  const handleTouchEnd = useCallback((e: React.TouchEvent) => {
    if (touchStartRef.current && e.changedTouches.length === 1) {
      const deltaX = e.changedTouches[0].clientX - touchStartRef.current.x;
      const deltaY = e.changedTouches[0].clientY - touchStartRef.current.y;

      if (Math.abs(deltaX) > 50 && Math.abs(deltaX) > Math.abs(deltaY)) {
        if (deltaX > 0) {
          onPrev?.();
        } else {
          onNext?.();
        }
      }
    }
    touchStartRef.current = null;
  }, [onPrev, onNext]);

  const toggleControls = useCallback(() => {
    setShowControls(prev => !prev);
  }, []);

  const displaySrc = useMemo(() => {
    if (imageInfo?.isAnimatedWebp && isAnimatedLoaded && animatedUrl) {
      return animatedUrl;
    }
    return previewUrl;
  }, [imageInfo?.isAnimatedWebp, isAnimatedLoaded, animatedUrl, previewUrl]);

  const isLoading = !isPreviewLoaded && !previewUrl;

  return (
    <div className="mobile-viewer-overlay">
      {showControls && (
        <div className="mobile-viewer-header">
          <button className="back-btn" onClick={onClose}>
            <ChevronLeft size={24} />
          </button>
          <span className="title">{image.name}</span>
          <button className="close-btn" onClick={onClose}>
            <X size={24} />
          </button>
        </div>
      )}

      <div
        ref={containerRef}
        className="mobile-viewer-content"
        onClick={toggleControls}
        onTouchStart={handleTouchStart}
        onTouchEnd={handleTouchEnd}
      >
        {isLoading && (
          <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <div style={{
              width: 36,
              height: 36,
              border: '3px solid rgba(255,255,255,0.3)',
              borderTopColor: 'white',
              borderRadius: '50%',
              animation: 'spin 0.8s linear infinite',
            }} />
          </div>
        )}

        {displaySrc && (
          <img
            src={displaySrc}
            alt={image.name}
            decoding={imageInfo?.isAnimatedWebp && isAnimatedLoaded ? 'sync' : 'async'}
            loading="eager"
            style={{
              transform: `scale(${scale}) rotate(${rotation}deg)`,
              transition: scale === 1 && rotation % 360 === 0 ? 'none' : 'transform 0.3s ease',
              opacity: isPreviewLoaded ? 1 : 0,
              willChange: 'transform',
              contain: 'layout paint',
            }}
            draggable={false}
          />
        )}

        {imageInfo?.isAnimatedWebp && !isAnimatedLoaded && isPreviewLoaded && (
          <div style={{
            position: 'absolute',
            bottom: '120px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0,0,0,0.6)',
            padding: '4px 12px',
            borderRadius: '12px',
            fontSize: '12px',
            color: 'rgba(255,255,255,0.8)',
            pointerEvents: 'none',
          }}>
            加载动画中...
          </div>
        )}
      </div>

      {showControls && (
        <>
          {onPrev && (
            <button
              className="mobile-viewer-nav prev"
              onClick={(e) => { e.stopPropagation(); onPrev(); }}
            >
              <ChevronLeft size={32} />
            </button>
          )}
          {onNext && (
            <button
              className="mobile-viewer-nav next"
              onClick={(e) => { e.stopPropagation(); onNext(); }}
            >
              <ChevronRight size={32} />
            </button>
          )}

          <div className="mobile-viewer-footer">
            <button onClick={handleZoomOut}>
              <ZoomOut size={24} />
              <span>缩小</span>
            </button>
            <button onClick={handleZoomIn}>
              <ZoomIn size={24} />
              <span>放大</span>
            </button>
            <button onClick={handleRotate}>
              <RotateCw size={24} />
              <span>旋转</span>
            </button>
            <button onClick={handleReset}>
              <span style={{ fontSize: '18px' }}>1:1</span>
              <span>重置</span>
            </button>
          </div>

          <div style={{
            position: 'absolute',
            bottom: '80px',
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'rgba(0, 0, 0, 0.5)',
            padding: '4px 12px',
            borderRadius: '12px',
            fontSize: '14px',
          }}>
            {currentIndex} / {totalCount}
          </div>
        </>
      )}

      <style>{`
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}

export default MobileImageViewer;
