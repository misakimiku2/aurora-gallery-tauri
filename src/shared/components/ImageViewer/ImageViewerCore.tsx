import React, { useEffect, useCallback, useState, useMemo, useRef } from 'react';
import { useImageTransform } from '../../hooks/useImageTransform';
import { useSlideshow, SlideshowConfig } from '../../hooks/useSlideshow';
import { SharedApi } from '../../api/types';
import { LoadingSpinner } from '../UI/LoadingSpinner';
import { ImageViewerControls } from './ImageViewerControls';
import { SlideshowManager } from './SlideshowManager';

export interface ImageViewerCoreProps {
  imagePath: string;
  imageName: string;
  currentIndex: number;
  totalCount: number;
  api: SharedApi;
  allowEdit?: boolean;
  showNavigation?: boolean;
  enableSlideshow?: boolean;
  enableFullscreen?: boolean;
  onClose: () => void;
  onNavigate?: (direction: number, random?: boolean) => void;
  onDelete?: () => void;
  onPreload?: (paths: string[]) => void;
  slideshowConfig?: Partial<SlideshowConfig>;
  onSlideshowConfigChange?: (config: SlideshowConfig) => void;
  renderHeader?: (props: HeaderRenderProps) => React.ReactNode;
  renderFooter?: (props: FooterRenderProps) => React.ReactNode;
  t?: (key: string) => string;
}

export interface HeaderRenderProps {
  imageName: string;
  onClose: () => void;
  onDelete?: () => void;
  allowEdit?: boolean;
}

export interface FooterRenderProps {
  currentIndex: number;
  totalCount: number;
  scale: number;
}

const defaultT = (key: string): string => {
  const translations: Record<string, string> = {
    'viewer.close': '关闭',
    'viewer.original': '原始尺寸',
    'viewer.fit': '适应窗口',
    'viewer.rotateLeft': '向左旋转',
    'viewer.rotateRight': '向右旋转',
    'viewer.slideshow': '幻灯片',
    'viewer.slideshowSettings': '幻灯片设置',
    'viewer.slideshowInterval': '间隔时间',
    'viewer.transition': '过渡效果',
    'viewer.none': '无',
    'viewer.fade': '淡入淡出',
    'viewer.slide': '滑动',
    'viewer.enableZoom': 'Ken Burns 效果',
    'viewer.random': '随机播放',
    'viewer.startSlideshow': '开始播放',
    'viewer.stopSlideshow': '停止播放',
    'viewer.done': '完成',
    'viewer.delete': '删除',
    'viewer.fullscreen': '全屏',
    'viewer.exitFullscreen': '退出全屏',
  };
  return translations[key] || key;
};

const DEFAULT_SLIDESHOW_CONFIG: SlideshowConfig = {
  interval: 3000,
  transition: 'fade',
  enableZoom: true,
  isRandom: false,
};

export const ImageViewerCore: React.FC<ImageViewerCoreProps> = ({
  imagePath,
  imageName,
  currentIndex,
  totalCount,
  api,
  allowEdit = false,
  showNavigation = true,
  enableSlideshow = true,
  enableFullscreen = true,
  onClose,
  onNavigate,
  onDelete,
  onPreload,
  slideshowConfig: externalSlideshowConfig,
  onSlideshowConfigChange,
  renderHeader,
  renderFooter,
  t = defaultT,
}) => {
  const [loaded, setLoaded] = useState(false);
  const [showSlideshowSettings, setShowSlideshowSettings] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [prevImageUrl, setPrevImageUrl] = useState<string>('');
  const [isTransitioning, setIsTransitioning] = useState(false);
  const [prevTransform, setPrevTransform] = useState<string>('none');
  const [showPageIndicator, setShowPageIndicator] = useState(false);
  const [indicatorVisible, setIndicatorVisible] = useState(false);
  
  const rootRef = useRef<HTMLDivElement>(null);
  const displayUrlRef = useRef<string>('');
  const slideshowActiveRef = useRef(false);
  const indicatorTimeoutRef = useRef<ReturnType<typeof setTimeout>>();

  const {
    transform,
    isDragging,
    isWheeling,
    containerRef,
    imgRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    handleDoubleClick,
    reset,
    setScale,
    rotate,
    fitToWindow,
    setToOriginalSize,
  } = useImageTransform();

  const [internalSlideshowConfig, setInternalSlideshowConfig] = useState<SlideshowConfig>({
    ...DEFAULT_SLIDESHOW_CONFIG,
    ...externalSlideshowConfig,
  });

  const slideshowConfig = externalSlideshowConfig 
    ? { ...DEFAULT_SLIDESHOW_CONFIG, ...externalSlideshowConfig }
    : internalSlideshowConfig;

  const handleSlideshowNavigate = useCallback((random: boolean) => {
    if (onNavigate) {
      const direction = random ? (Math.random() > 0.5 ? 1 : -1) : 1;
      onNavigate(direction, random);
    }
  }, [onNavigate]);

  const {
    isActive: slideshowActive,
    start: startSlideshow,
    stop: stopSlideshow,
    toggle: toggleSlideshow,
    updateConfig: updateSlideshowConfig,
  } = useSlideshow({
    initialConfig: slideshowConfig,
    onNavigate: handleSlideshowNavigate,
    containerRef: rootRef,
  });

  slideshowActiveRef.current = slideshowActive;

  const imageUrl = useMemo(() => {
    return api.getImageUrl(imagePath);
  }, [api, imagePath]);

  useEffect(() => {
    displayUrlRef.current = imageUrl;
  }, [imageUrl]);

  useEffect(() => {
    setLoaded(false);
    reset();
    
    setShowPageIndicator(true);
    setIndicatorVisible(true);
    
    if (indicatorTimeoutRef.current) {
      clearTimeout(indicatorTimeoutRef.current);
    }
    
    indicatorTimeoutRef.current = setTimeout(() => {
      setIndicatorVisible(false);
      setTimeout(() => setShowPageIndicator(false), 300);
    }, 2000);
  }, [imagePath, reset]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' && onNavigate) {
        onNavigate(1, false);
      }
      if (e.key === 'ArrowLeft' && onNavigate) {
        onNavigate(-1, false);
      }
      if (e.key === 'Escape') {
        if (showSlideshowSettings) {
          setShowSlideshowSettings(false);
        } else if (slideshowActive) {
          stopSlideshow();
        } else {
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onNavigate, slideshowActive, showSlideshowSettings, stopSlideshow]);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(!!document.fullscreenElement);
      if (!document.fullscreenElement && slideshowActiveRef.current) {
        stopSlideshow();
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, [stopSlideshow]);

  useEffect(() => {
    return () => {
      if (indicatorTimeoutRef.current) {
        clearTimeout(indicatorTimeoutRef.current);
      }
    };
  }, []);

  const handleToggleFullscreen = useCallback(async () => {
    if (!enableFullscreen) return;
    
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        setIsFullscreen(false);
      } else {
        await rootRef.current?.requestFullscreen();
        setIsFullscreen(true);
      }
    } catch (err) {
      console.warn('Fullscreen toggle failed:', err);
    }
  }, [enableFullscreen]);

  const handleToggleSlideshow = useCallback(async () => {
    if (!enableSlideshow) return;
    
    if (!slideshowActive) {
      if (enableFullscreen && !document.fullscreenElement) {
        try {
          await rootRef.current?.requestFullscreen();
          setIsFullscreen(true);
        } catch (err) {
          console.warn('Failed to enter fullscreen:', err);
        }
      }
      setShowSlideshowSettings(false);
    }
    toggleSlideshow();
  }, [enableSlideshow, slideshowActive, enableFullscreen, toggleSlideshow]);

  const handleUpdateSlideshowConfig = useCallback((config: Partial<SlideshowConfig>) => {
    const newConfig = { ...slideshowConfig, ...config };
    if (onSlideshowConfigChange) {
      onSlideshowConfigChange(newConfig);
    } else {
      setInternalSlideshowConfig(newConfig);
    }
    updateSlideshowConfig(config);
  }, [slideshowConfig, onSlideshowConfigChange, updateSlideshowConfig]);

  const handleTransitionEnd = useCallback(() => {
    setIsTransitioning(false);
    setPrevImageUrl('');
  }, []);

  useEffect(() => {
    if (slideshowActive && displayUrlRef.current && slideshowConfig.transition !== 'none') {
      if (slideshowConfig.transition === 'fade' && slideshowConfig.enableZoom) {
        const currentImg = imgRef.current;
        if (currentImg) {
          const computedStyle = window.getComputedStyle(currentImg);
          setPrevTransform(computedStyle.transform);
        }
      } else {
        setPrevTransform('none');
      }
      setPrevImageUrl(displayUrlRef.current);
      setIsTransitioning(true);
    }
  }, [imagePath, slideshowActive, slideshowConfig.transition, slideshowConfig.enableZoom, imgRef]);

  const handleRotate = useCallback((deg: number) => {
    rotate(deg);
  }, [rotate]);

  const defaultHeader = useCallback(({ imageName, onClose, onDelete, allowEdit }: HeaderRenderProps) => (
    <header className="h-14 bg-gray-900/80 backdrop-blur-sm border-b border-gray-800 flex items-center px-4 justify-between shrink-0">
      <button
        onClick={onClose}
        className="flex items-center gap-2 px-3 py-1.5 text-gray-300 hover:text-white 
          bg-gray-800 hover:bg-gray-700 rounded-lg transition-colors"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        <span>返回</span>
      </button>
      
      <span className="text-gray-300 truncate max-w-[50%] text-center text-sm">
        {imageName}
      </span>
      
      <div className="flex items-center gap-2">
        {allowEdit && onDelete && (
          <button
            onClick={onDelete}
            className="px-3 py-1.5 text-white bg-red-500 hover:bg-red-600 rounded-lg transition-colors text-sm"
          >
            删除
          </button>
        )}
      </div>
    </header>
  ), []);

  const defaultFooter = useCallback(({ currentIndex, totalCount, scale }: FooterRenderProps) => (
    <footer className="h-12 bg-gray-900/80 backdrop-blur-sm border-t border-gray-800 flex items-center justify-center shrink-0 gap-4">
      <span className="px-4 py-1.5 bg-gray-800 rounded-full text-sm text-gray-300">
        {currentIndex + 1} / {totalCount}
      </span>
      <span className="px-2 py-1 bg-gray-800 rounded text-xs text-gray-400">
        {Math.round(scale * 100)}%
      </span>
    </footer>
  ), []);

  const containerBgClass = slideshowActive 
    ? 'bg-black cursor-none' 
    : 'bg-gray-200 dark:bg-gray-900';

  return (
    <div
      ref={rootRef}
      className={`fixed inset-0 z-50 flex flex-col select-none overflow-hidden transition-colors duration-300 ${
        slideshowActive ? 'bg-black' : 'bg-gray-50 dark:bg-gray-900'
      }`}
    >
      {renderHeader ? (
        renderHeader({ imageName, onClose, onDelete, allowEdit })
      ) : enableSlideshow ? (
        <ImageViewerControls
          imageName={imageName}
          currentIndex={currentIndex}
          totalCount={totalCount}
          rotation={transform.rotation}
          isFullscreen={isFullscreen}
          slideshowActive={slideshowActive}
          slideshowConfig={slideshowConfig}
          onClose={onClose}
          onNavigate={(dir) => onNavigate?.(dir, false)}
          onRotate={handleRotate}
          onToggleFullscreen={handleToggleFullscreen}
          onToggleSlideshow={handleToggleSlideshow}
          onUpdateSlideshowConfig={handleUpdateSlideshowConfig}
          showSlideshowSettings={showSlideshowSettings}
          onShowSlideshowSettings={setShowSlideshowSettings}
          showNavigation={showNavigation}
          allowEdit={allowEdit}
          onDelete={onDelete}
          t={t}
        />
      ) : (
        defaultHeader({ imageName, onClose, onDelete, allowEdit })
      )}

      <main
        ref={containerRef}
        className={`flex-1 relative overflow-hidden flex items-center justify-center ${containerBgClass}`}
        onMouseDown={slideshowActive ? undefined : handleMouseDown}
        onMouseMove={slideshowActive ? undefined : handleMouseMove}
        onMouseUp={slideshowActive ? undefined : handleMouseUp}
        onMouseLeave={slideshowActive ? undefined : handleMouseUp}
        style={slideshowActive ? { cursor: 'none' } : {}}
      >
        {!loaded && !slideshowActive && (
          <div className="absolute inset-0 flex items-center justify-center z-0">
            <LoadingSpinner size="lg" />
          </div>
        )}

        {slideshowActive ? (
          <SlideshowManager
            currentUrl={imageUrl}
            prevUrl={prevImageUrl}
            isTransitioning={isTransitioning}
            transition={slideshowConfig.transition}
            enableZoom={slideshowConfig.enableZoom}
            onTransitionEnd={handleTransitionEnd}
            prevTransform={prevTransform}
            imageName={imageName}
          />
        ) : (
          <img
            ref={imgRef}
            src={imageUrl}
            alt={imageName}
            onLoad={() => setLoaded(true)}
            onDoubleClick={handleDoubleClick}
            className={`max-w-full max-h-full object-contain select-none
              ${loaded ? 'opacity-100' : 'opacity-0'}
              ${isDragging ? 'cursor-grabbing' : transform.scale > 1 ? 'cursor-grab' : 'cursor-default'}
              ${!isWheeling && !isDragging ? 'transition-transform duration-200' : ''}`}
            style={{
              transformOrigin: 'center center',
            }}
            draggable={false}
          />
        )}

        {showNavigation && !slideshowActive && onNavigate && (
          <>
            <div className="absolute inset-y-0 left-0 w-24 flex items-center justify-start pl-2 opacity-0 hover:opacity-100 transition-opacity duration-300 bg-gradient-to-r from-black/30 to-transparent z-10 pointer-events-auto">
              <button
                onClick={(e) => { e.stopPropagation(); onNavigate(-1, false); }}
                disabled={currentIndex <= 0}
                className="p-3 rounded-full bg-black/50 text-white/80 hover:bg-black/80 hover:text-white backdrop-blur-sm transform transition-transform active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M15 19l-7-7 7-7" />
                </svg>
              </button>
            </div>
            <div className="absolute inset-y-0 right-0 w-24 flex items-center justify-end pr-2 opacity-0 hover:opacity-100 transition-opacity duration-300 bg-gradient-to-l from-black/30 to-transparent z-10 pointer-events-auto">
              <button
                onClick={(e) => { e.stopPropagation(); onNavigate(1, false); }}
                disabled={currentIndex >= totalCount - 1}
                className="p-3 rounded-full bg-black/50 text-white/80 hover:bg-black/80 hover:text-white backdrop-blur-sm transform transition-transform active:scale-95 disabled:opacity-30 disabled:cursor-not-allowed"
              >
                <svg className="w-8 h-8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 5l7 7-7 7" />
                </svg>
              </button>
            </div>
          </>
        )}

        {showPageIndicator && !slideshowActive && (
          <div 
            className={`absolute bottom-8 left-1/2 -translate-x-1/2 z-20 pointer-events-none transition-opacity duration-300 ${
              indicatorVisible ? 'opacity-100' : 'opacity-0'
            }`}
          >
            <span className="px-4 py-2 bg-black/60 backdrop-blur-sm rounded-full text-sm text-white/90 shadow-lg">
              {currentIndex + 1} / {totalCount}
            </span>
          </div>
        )}
      </main>

      {renderFooter ? (
        renderFooter({ currentIndex, totalCount, scale: transform.scale })
      ) : !enableSlideshow ? (
        defaultFooter({ currentIndex, totalCount, scale: transform.scale })
      ) : null}
    </div>
  );
};

export default ImageViewerCore;
