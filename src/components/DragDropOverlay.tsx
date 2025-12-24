import React from 'react';
import { Copy, UploadCloud } from 'lucide-react';

export type DropAction = 'copy' | null;

interface DragDropOverlayProps {
  isVisible: boolean;
  fileCount: number;
  hoveredAction: DropAction;
  onHoverAction: (action: DropAction) => void;
  t: (key: string) => string;
}

export const DragDropOverlay: React.FC<DragDropOverlayProps> = ({ 
  isVisible, 
  fileCount, 
  hoveredAction,
  onHoverAction,
  t 
}) => {
  if (!isVisible) return null;

  return (
    <div 
      className="fixed inset-0 z-[50] bg-black/30 backdrop-blur-[6px] flex flex-col items-center justify-center pointer-events-none transition-opacity duration-300"
    >
      {/* 顶部提示气泡 */}
      <div className="mb-8 bg-white/95 dark:bg-gray-800/95 px-6 py-2.5 rounded-full shadow-xl border border-white/20">
        <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {t('drag.releaseToComplete')}
        </p>
      </div>
      
      {/* 单一复制区域 */}
      <div 
        className="relative group pointer-events-auto"
        onDragEnter={() => onHoverAction('copy')}
        onDragOver={(e) => { e.preventDefault(); onHoverAction('copy'); }}
        onDragLeave={() => onHoverAction(null)}
      >
        {/* 背景装饰流光 */}
        <div className={`absolute -inset-1 bg-gradient-to-r from-blue-600 to-cyan-500 rounded-[48px] blur transition-all duration-300 ${
          hoveredAction === 'copy' ? 'opacity-60 scale-105' : 'opacity-25'
        } animate-pulse`}></div>
        
        <div className={`relative w-[400px] h-[400px] md:w-[480px] md:h-[480px] bg-white/90 dark:bg-gray-900/95 backdrop-blur-2xl rounded-[44px] shadow-2xl border-2 flex flex-col items-center justify-center overflow-hidden transition-all duration-300 ${
          hoveredAction === 'copy' 
            ? 'border-blue-400 dark:border-blue-500 scale-[1.02]' 
            : 'border-white/40 dark:border-white/10'
        }`}>
          
          {/* 内部装饰性背景色块 */}
          <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
            <div className={`absolute -top-24 -left-24 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl transition-opacity duration-300 animate-blob ${
              hoveredAction === 'copy' ? 'opacity-100' : 'opacity-50'
            }`}></div>
            <div className={`absolute -bottom-24 -right-24 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl transition-opacity duration-300 animate-blob animation-delay-2000 ${
              hoveredAction === 'copy' ? 'opacity-100' : 'opacity-50'
            }`}></div>
          </div>

          {/* 图标区域 */}
          <div className="mb-8 relative">
            {/* 外圈波纹动画 */}
            {hoveredAction === 'copy' && (
              <div className="absolute inset-0 bg-blue-500/30 rounded-full animate-ping opacity-75" />
            )}
            <div className={`absolute -inset-4 rounded-[40px] transition-all duration-300 ${
              hoveredAction === 'copy' ? 'bg-blue-500/10 scale-110' : 'bg-blue-500/5'
            }`} />
            
            <div className={`relative w-32 h-32 bg-gradient-to-br from-blue-500 to-blue-700 rounded-[36px] shadow-2xl flex items-center justify-center transform transition-all duration-500 ${
              hoveredAction === 'copy' ? 'scale-110 rotate-3' : ''
            }`}>
              <Copy size={56} className="text-white" />
              {/* 叠加一个小图标表示"存入"感 */}
              <div className="absolute -bottom-2 -right-2 w-12 h-12 bg-white dark:bg-gray-800 rounded-2xl shadow-lg flex items-center justify-center border-4 border-blue-50 dark:border-gray-900">
                <UploadCloud size={24} className="text-blue-600" />
              </div>
            </div>
          </div>

          {/* 文字区域 */}
          <div className="text-center z-10 px-8">
            <h3 className={`text-4xl font-black mb-4 bg-clip-text text-transparent transition-all duration-300 ${
              hoveredAction === 'copy' 
                ? 'bg-gradient-to-b from-blue-600 to-cyan-600 dark:from-blue-400 dark:to-cyan-400' 
                : 'bg-gradient-to-b from-gray-900 to-gray-600 dark:from-white dark:to-gray-400'
            }`}>
              {t('context.copy')}
            </h3>
            
            <div className={`flex items-center justify-center space-x-2 px-4 py-2 rounded-2xl transition-colors duration-300 ${
              hoveredAction === 'copy' 
                ? 'bg-blue-100 dark:bg-blue-900/30' 
                : 'bg-gray-100 dark:bg-gray-800/50'
            }`}>
              <span className={`font-bold text-lg transition-colors duration-300 ${
                hoveredAction === 'copy' ? 'text-blue-600 dark:text-blue-300' : 'text-gray-600 dark:text-gray-300'
              }`}>
                {fileCount}
              </span>
              <span className={`text-sm font-medium transition-colors duration-300 ${
                hoveredAction === 'copy' ? 'text-blue-600/80 dark:text-blue-300/80' : 'text-gray-500 dark:text-gray-400'
              }`}>
                {fileCount === 1 ? t('meta.file') : t('meta.files')}
              </span>
            </div>

            <p className="mt-6 text-gray-400 dark:text-gray-500 text-sm max-w-[280px] leading-relaxed">
              {t('drag.copyHint')}
            </p>
          </div>

          {/* 底部装饰条 */}
          <div className={`absolute bottom-0 left-0 w-full h-1.5 bg-gradient-to-r from-transparent via-blue-500 to-transparent transition-opacity duration-300 ${
            hoveredAction === 'copy' ? 'opacity-80' : 'opacity-50'
          }`}></div>
        </div>
      </div>
    </div>
  );
};
