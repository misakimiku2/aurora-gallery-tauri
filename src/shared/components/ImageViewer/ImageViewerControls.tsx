import React, { useCallback } from 'react';
import { SlideshowConfig, TransitionType } from '../../hooks/useSlideshow';

export interface ImageViewerControlsProps {
  imageName: string;
  currentIndex: number;
  totalCount: number;
  rotation: number;
  isFullscreen: boolean;
  slideshowActive: boolean;
  slideshowConfig: SlideshowConfig;
  onClose: () => void;
  onNavigate: (direction: number) => void;
  onRotate: (deg: number) => void;
  onToggleFullscreen: () => void;
  onToggleSlideshow: () => void;
  onUpdateSlideshowConfig: (config: Partial<SlideshowConfig>) => void;
  showSlideshowSettings: boolean;
  onShowSlideshowSettings: (show: boolean) => void;
  showNavigation?: boolean;
  allowEdit?: boolean;
  onDelete?: () => void;
  t?: (key: string) => string;
}

const defaultT = (key: string): string => {
  const translations: Record<string, string> = {
    'viewer.close': '关闭',
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

export const ImageViewerControls: React.FC<ImageViewerControlsProps> = ({
  imageName,
  currentIndex,
  totalCount,
  rotation,
  isFullscreen,
  slideshowActive,
  slideshowConfig,
  onClose,
  onNavigate,
  onRotate,
  onToggleFullscreen,
  onToggleSlideshow,
  onUpdateSlideshowConfig,
  showSlideshowSettings,
  onShowSlideshowSettings,
  showNavigation = true,
  allowEdit = false,
  onDelete,
  t = defaultT,
}) => {
  const handlePrev = useCallback(() => onNavigate(-1), [onNavigate]);
  const handleNext = useCallback(() => onNavigate(1), [onNavigate]);

  const headerClass = `h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 
    flex items-center px-4 justify-between z-20 shrink-0 transition-all duration-300 
    ${(isFullscreen && slideshowActive) || slideshowActive 
      ? '-translate-y-full absolute w-full top-0 opacity-0 pointer-events-none' 
      : ''}`;

  return (
    <>
      <header className={headerClass}>
        <div className="flex items-center space-x-2">
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
            title={t('viewer.close')}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 text-center truncate px-4 font-medium text-gray-800 dark:text-gray-200">
          {imageName}
        </div>

        <div className="flex items-center space-x-2 justify-end">
          <button
            onClick={() => onRotate(-90)}
            className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block"
            title={t('viewer.rotateLeft')}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M1 4v6h6M23 20v-6h-6" />
              <path d="M20.49 9A9 9 0 005.64 5.64L1 10m22 4l-4.64 4.36A9 9 0 013.51 15" />
            </svg>
          </button>
          
          <button
            onClick={() => onRotate(90)}
            className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400 hidden sm:block"
            title={t('viewer.rotateRight')}
          >
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
          </button>
          
          <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>

          <button
            onClick={onToggleSlideshow}
            className={`p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 ${
              slideshowActive ? 'text-blue-500' : 'text-gray-500 dark:text-gray-400'
            }`}
            title={t('viewer.slideshow')}
          >
            {slideshowActive ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <rect x="6" y="4" width="4" height="16" rx="1" />
                <rect x="14" y="4" width="4" height="16" rx="1" />
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
                <path d="M8 5v14l11-7z" />
              </svg>
            )}
          </button>

          <button
            onClick={onToggleFullscreen}
            className="p-2 rounded hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-500 dark:text-gray-400"
            title={isFullscreen ? t('viewer.exitFullscreen') : t('viewer.fullscreen')}
          >
            {isFullscreen ? (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
            ) : (
              <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3m0 18h3a2 2 0 002-2v-3M3 16v3a2 2 0 002 2h3" />
              </svg>
            )}
          </button>
        </div>
      </header>

      {showNavigation && (
        <>
          <div className="absolute inset-y-0 left-0 w-24 flex items-center justify-start pl-2 opacity-0 hover:opacity-100 transition-opacity duration-300 bg-gradient-to-r from-black/30 to-transparent z-10 pointer-events-auto">
            <button
              onClick={(e) => { e.stopPropagation(); handlePrev(); }}
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
              onClick={(e) => { e.stopPropagation(); handleNext(); }}
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

      {showSlideshowSettings && (
        <div className="fixed inset-0 bg-black/50 z-[70] flex items-center justify-center">
          <div 
            className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg w-80 shadow-2xl p-4 animate-zoom-in" 
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-4 border-b border-gray-200 dark:border-gray-800 pb-2">
              <h3 className="font-bold text-gray-800 dark:text-gray-200 flex items-center">
                <svg className="w-4 h-4 mr-2" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z" />
                </svg>
                {t('viewer.slideshowSettings')}
              </h3>
              <button 
                onClick={() => onShowSlideshowSettings(false)} 
                className="text-gray-500 dark:text-gray-400 hover:text-black dark:hover:text-white"
              >
                <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="space-y-4">
              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {t('viewer.slideshowInterval')} ({slideshowConfig.interval / 1000}s)
                </label>
                <input
                  type="range"
                  min="1000"
                  max="10000"
                  step="500"
                  value={slideshowConfig.interval}
                  onChange={(e) => onUpdateSlideshowConfig({ interval: Number(e.target.value) })}
                  className="w-full"
                />
              </div>

              <div>
                <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">
                  {t('viewer.transition')}
                </label>
                <select
                  value={slideshowConfig.transition}
                  onChange={(e) => onUpdateSlideshowConfig({ transition: e.target.value as TransitionType })}
                  className="w-full bg-gray-100 dark:bg-gray-700 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                >
                  <option value="none">{t('viewer.none')}</option>
                  <option value="fade">{t('viewer.fade')}</option>
                  <option value="slide">{t('viewer.slide')}</option>
                </select>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-300">{t('viewer.enableZoom')}</span>
                <button
                  onClick={() => onUpdateSlideshowConfig({ enableZoom: !slideshowConfig.enableZoom })}
                  className={`w-10 h-5 rounded-full relative transition-colors ${
                    slideshowConfig.enableZoom ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-600'
                  }`}
                >
                  <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${
                    slideshowConfig.enableZoom ? 'left-6' : 'left-1'
                  }`}></div>
                </button>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-sm text-gray-700 dark:text-gray-300">{t('viewer.random')}</span>
                <button
                  onClick={() => onUpdateSlideshowConfig({ isRandom: !slideshowConfig.isRandom })}
                  className={`w-10 h-5 rounded-full relative transition-colors ${
                    slideshowConfig.isRandom ? 'bg-blue-600' : 'bg-gray-400 dark:bg-gray-600'
                  }`}
                >
                  <div className={`absolute top-1 w-3 h-3 rounded-full bg-white transition-all ${
                    slideshowConfig.isRandom ? 'left-6' : 'left-1'
                  }`}></div>
                </button>
              </div>
            </div>

            <div className="mt-6 flex justify-end space-x-2">
              <button
                onClick={() => { onToggleSlideshow(); onShowSlideshowSettings(false); }}
                className="bg-green-600 hover:bg-green-500 text-white px-4 py-1.5 rounded text-sm flex items-center"
              >
                <svg className="w-3 h-3 mr-1" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                {t('viewer.startSlideshow')}
              </button>
              <button
                onClick={() => onShowSlideshowSettings(false)}
                className="bg-gray-200 hover:bg-gray-300 dark:bg-gray-700 dark:hover:bg-gray-600 text-gray-800 dark:text-white px-4 py-1.5 rounded text-sm"
              >
                {t('viewer.done')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ImageViewerControls;
