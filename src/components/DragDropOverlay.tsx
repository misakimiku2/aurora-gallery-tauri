import React from 'react';
import { Copy, Move } from 'lucide-react';

interface DragDropOverlayProps {
  isVisible: boolean;
  cursorX: number;
  fileCount: number;
  t: (key: string) => string;
}

export const DragDropOverlay: React.FC<DragDropOverlayProps> = ({ 
  isVisible, 
  cursorX, 
  fileCount, 
  t 
}) => {
  if (!isVisible) return null;

  const containerRef = React.useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = React.useState(0);

  React.useEffect(() => {
    const updateWidth = () => {
      if (containerRef.current) {
        setContainerWidth(containerRef.current.offsetWidth);
      }
    };

    updateWidth();
    window.addEventListener('resize', updateWidth);
    return () => window.removeEventListener('resize', updateWidth);
  }, []);

  const isLeftHalf = containerWidth > 0 && cursorX < containerWidth / 2;

  return (
    <div 
      ref={containerRef}
      // 降低全屏遮罩模糊度，从 md 改为更轻微的定制值 (4px)
      className="fixed inset-0 z-[50] bg-black/30 backdrop-blur-[4px] flex flex-col items-center justify-center pointer-events-none transition-opacity duration-300"
    >
      {/* 顶部提示气泡 */}
      <div className="mb-8 bg-white/95 dark:bg-gray-800/95 px-8 py-3 rounded-full shadow-2xl border border-white/20">
        <p className="text-base font-semibold text-gray-800 dark:text-gray-100">
          {t('drag.releaseToComplete')} ({fileCount} {fileCount === 1 ? t('meta.file') : t('meta.files')})
        </p>
      </div>
      
      {/* 主面板容器：改为响应式宽度与高度 */}
      <div className="w-[85%] max-w-7xl h-[45vh] min-h-[320px] max-h-[500px] bg-white/90 dark:bg-gray-900/90 backdrop-blur-xl rounded-[40px] shadow-[0_32px_64px_-12px_rgba(0,0,0,0.4)] overflow-hidden flex pointer-events-auto border border-white/20">
        
        {/* 左侧 - 复制面板 */}
        <div 
          className={`flex-1 flex flex-col items-center justify-center transition-all duration-500 relative ${
            isLeftHalf 
              ? 'bg-blue-50/80 dark:bg-blue-900/40 z-10 shadow-inner' 
              : 'bg-transparent opacity-40'
          }`}
        >
          <div className="mb-6 relative">
            {isLeftHalf && (
              <div className="absolute inset-0 bg-blue-500/20 rounded-3xl animate-ping" />
            )}
            {/* 图标形变动画 */}
            <div className={`relative p-6 rounded-3xl transition-all duration-500 shadow-lg ${
              isLeftHalf 
                ? 'bg-blue-600 text-white scale-110 rotate-0' 
                : 'bg-white dark:bg-gray-800 text-blue-600 scale-90 -rotate-12'
            }`}>
              <Copy size={48} />
            </div>
          </div>
          <h3 className={`text-3xl font-bold mb-2 transition-all duration-500 ${isLeftHalf ? 'text-blue-700 dark:text-blue-300 translate-y-0' : 'text-gray-400 translate-y-2'}`}>
            {t('context.copy')}
          </h3>
          <p className={`text-base transition-opacity duration-500 ${isLeftHalf ? 'text-blue-600/70 dark:text-blue-200/60 opacity-100' : 'opacity-0'}`}>
            {t('drag.copyHint')}
          </p>
        </div>

        {/* 分割线 */}
        <div className="w-px h-[60%] self-center bg-gray-200 dark:bg-gray-700 relative z-20">
          <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-10 h-10 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-full flex items-center justify-center shadow-md">
            <div className="w-2 h-2 bg-gray-300 dark:bg-gray-600 rounded-full" />
          </div>
        </div>

        {/* 右侧 - 移动面板 */}
        <div 
          className={`flex-1 flex flex-col items-center justify-center transition-all duration-500 relative ${
            !isLeftHalf 
              ? 'bg-green-50/80 dark:bg-green-900/40 z-10 shadow-inner' 
              : 'bg-transparent opacity-40'
          }`}
        >
          <div className="mb-6 relative">
            {!isLeftHalf && (
              <div className="absolute inset-0 bg-green-500/20 rounded-3xl animate-ping" />
            )}
            {/* 图标形变动画 */}
            <div className={`relative p-6 rounded-3xl transition-all duration-500 shadow-lg ${
              !isLeftHalf 
                ? 'bg-green-600 text-white scale-110 rotate-0' 
                : 'bg-white dark:bg-gray-800 text-green-600 scale-90 rotate-12'
            }`}>
              <Move size={48} />
            </div>
          </div>
          <h3 className={`text-3xl font-bold mb-2 transition-all duration-500 ${!isLeftHalf ? 'text-green-700 dark:text-green-300 translate-y-0' : 'text-gray-400 translate-y-2'}`}>
            {t('context.move')}
          </h3>
          <p className={`text-base transition-opacity duration-500 ${!isLeftHalf ? 'text-green-600/70 dark:text-green-200/60 opacity-100' : 'opacity-0'}`}>
            {t('drag.moveHint')}
          </p>
        </div>
      </div>
    </div>
  );
};