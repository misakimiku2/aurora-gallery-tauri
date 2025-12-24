import React from 'react';
import { Copy, UploadCloud } from 'lucide-react';

interface DragDropOverlayProps {
  isVisible: boolean;
  fileCount: number;
  t: (key: string) => string;
}

export const DragDropOverlay: React.FC<DragDropOverlayProps> = ({ 
  isVisible, 
  fileCount, 
  t 
}) => {
  if (!isVisible) return null;

  return (
    <div 
      className="fixed inset-0 z-[50] bg-black/20 backdrop-blur-[4px] flex flex-col items-center justify-center pointer-events-none transition-opacity duration-300"
    >
      {/* 顶部提示气泡 */}
      <div className="mb-6 bg-white/95 dark:bg-gray-800/95 px-6 py-2 rounded-full shadow-xl border border-white/20">
        <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {t('drag.releaseToComplete')}
        </p>
      </div>
      
      {/* 单一面板容器：调整为更紧凑的比例，增加流光感 */}
      <div className="relative group pointer-events-auto">
        {/* 背景装饰流光 - 让单调的背景动起来 */}
        <div className="absolute -inset-1 bg-gradient-to-r from-blue-600 to-cyan-500 rounded-[48px] blur opacity-25 group-hover:opacity-50 transition duration-1000 group-hover:duration-200 animate-pulse"></div>
        
        <div className="relative w-[400px] h-[400px] md:w-[500px] md:h-[500px] bg-white/90 dark:bg-gray-900/95 backdrop-blur-2xl rounded-[44px] shadow-2xl border border-white/40 dark:border-white/10 flex flex-col items-center justify-center overflow-hidden">
          
          {/* 内部装饰性背景色块 */}
          <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
            <div className="absolute -top-24 -left-24 w-64 h-64 bg-blue-500/10 rounded-full blur-3xl animate-blob"></div>
            <div className="absolute -bottom-24 -right-24 w-64 h-64 bg-cyan-500/10 rounded-full blur-3xl animate-blob animation-delay-2000"></div>
          </div>

          {/* 图标区域：组合图标增强视觉丰富度 */}
          <div className="mb-8 relative">
            {/* 外圈波纹动画 */}
            <div className="absolute inset-0 bg-blue-500/20 rounded-full animate-ping opacity-75" />
            <div className="absolute -inset-4 bg-blue-500/5 rounded-[40px] scale-110" />
            
            <div className="relative w-32 h-32 bg-gradient-to-br from-blue-500 to-blue-700 rounded-[36px] shadow-2xl flex items-center justify-center transform transition-transform duration-500 group-hover:scale-105 group-hover:rotate-3">
              <Copy size={56} className="text-white" />
              {/* 叠加一个小图标表示“存入”感 */}
              <div className="absolute -bottom-2 -right-2 w-12 h-12 bg-white dark:bg-gray-800 rounded-2xl shadow-lg flex items-center justify-center border-4 border-blue-50 dark:border-gray-900">
                <UploadCloud size={24} className="text-blue-600" />
              </div>
            </div>
          </div>

          {/* 文字区域 */}
          <div className="text-center z-10 px-8">
            <h3 className="text-4xl font-black mb-4 bg-clip-text text-transparent bg-gradient-to-b from-gray-900 to-gray-600 dark:from-white dark:to-gray-400">
              {t('context.copy')}
            </h3>
            
            <div className="flex items-center justify-center space-x-2 bg-blue-50 dark:bg-blue-900/30 px-4 py-2 rounded-2xl">
              <span className="text-blue-600 dark:text-blue-300 font-bold text-lg">
                {fileCount}
              </span>
              <span className="text-blue-600/80 dark:text-blue-300/80 text-sm font-medium">
                {fileCount === 1 ? t('meta.file') : t('meta.files')}
              </span>
            </div>

            <p className="mt-6 text-gray-400 dark:text-gray-500 text-sm max-w-[240px] leading-relaxed">
              {t('drag.copyHint')}
            </p>
          </div>

          {/* 底部装饰条 */}
          <div className="absolute bottom-0 left-0 w-full h-1.5 bg-gradient-to-r from-transparent via-blue-500 to-transparent opacity-50"></div>
        </div>
      </div>
    </div>
  );
};