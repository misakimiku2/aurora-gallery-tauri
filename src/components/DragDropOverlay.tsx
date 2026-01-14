import React from 'react';
import { Copy, UploadCloud, FileText, ImageIcon, FileCode } from 'lucide-react';

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
      className="fixed inset-0 z-[50] bg-black/20 backdrop-blur-[4px] flex flex-col items-center justify-center transition-opacity duration-300"
      onDragOver={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {/* 顶部提示 */}
      <div className="mb-8 bg-white/95 dark:bg-gray-800/95 px-6 py-2.5 rounded-full shadow-xl border border-white/20 pointer-events-none">
        <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
          {t('drag.releaseToComplete')}
        </p>
      </div>
      
      <div className="relative group w-[70%] max-w-6xl h-[45vh] min-h-[340px] max-h-[500px]">
        {/* 外围流光 */}
        <div className={`absolute -inset-1 bg-gradient-to-r from-blue-600 to-cyan-500 rounded-[48px] blur transition-all duration-500 pointer-events-none ${
          hoveredAction === 'copy' ? 'opacity-40 scale-[1.01]' : 'opacity-0'
        } animate-pulse`}></div>
        
        <div 
          className={`relative w-full h-full bg-white/90 dark:bg-gray-900/95 backdrop-blur-2xl rounded-[44px] shadow-2xl border-2 flex items-center overflow-hidden transition-all duration-500 pointer-events-auto px-16 ${
            hoveredAction === 'copy' 
              ? 'border-blue-400 dark:border-blue-500 scale-[1.02]' 
              : 'border-white/40 dark:border-white/10'
          }`}
          onDragEnter={(e) => { 
            e.preventDefault();
            e.stopPropagation(); 
            onHoverAction('copy'); 
          }}
          onDragOver={(e) => { 
            e.preventDefault(); 
            e.stopPropagation(); 
            onHoverAction('copy'); 
          }}
          onDragLeave={(e) => {
            e.preventDefault();
            e.stopPropagation();
            onHoverAction(null);
          }}
        >
          {/* 背景装饰：右侧加入超大水印图标填充空�?*/}
          <div className="absolute top-0 left-0 w-full h-full overflow-hidden pointer-events-none">
            <div className={`absolute -top-32 -left-32 w-96 h-96 bg-blue-500/10 rounded-full blur-3xl transition-opacity duration-700 ${hoveredAction === 'copy' ? 'opacity-100' : 'opacity-30'}`}></div>
            {/* 右侧水印图标：解决“太�?太空”的问题 */}
            <Copy size={400} className={`absolute -right-20 -bottom-20 text-blue-500/[0.03] dark:text-blue-400/[0.03] transition-transform duration-1000 ${hoveredAction === 'copy' ? 'scale-110 rotate-12' : 'scale-100 rotate-0'}`} />
          </div>

          <div className="flex items-center justify-between w-full z-10 pointer-events-none">
            
            {/* 左侧：核心图�?*/}
            <div className="relative flex-shrink-0">
              {hoveredAction === 'copy' && (
                <div className="absolute inset-0 bg-blue-500/20 rounded-full animate-ping opacity-75" />
              )}
              <div className={`relative w-44 h-44 bg-gradient-to-br from-blue-500 to-blue-700 rounded-[44px] shadow-2xl flex items-center justify-center transform transition-all duration-700 ${
                hoveredAction === 'copy' ? 'scale-110 rotate-3 shadow-blue-500/40' : 'scale-100'
              }`}>
                <Copy size={72} className="text-white" />
                <div className="absolute -bottom-2 -right-2 w-16 h-16 bg-white dark:bg-gray-800 rounded-2xl shadow-lg flex items-center justify-center border-4 border-blue-50 dark:border-gray-900">
                  <UploadCloud size={32} className="text-blue-600" />
                </div>
              </div>
            </div>

            {/* 右侧：文�?+ 动态修�?*/}
            <div className="flex-1 ml-20 flex justify-between items-center">
              <div className="text-left">
                <h3 className={`text-6xl font-black mb-6 bg-clip-text text-transparent transition-all duration-500 ${
                  hoveredAction === 'copy' 
                    ? 'bg-gradient-to-r from-blue-600 to-cyan-600 dark:from-blue-400 dark:to-cyan-400' 
                    : 'bg-gradient-to-r from-gray-900 to-gray-600 dark:from-white dark:to-gray-400'
                }`}>
                  {t('context.copy')}
                </h3>
                
                <div className="inline-flex items-center space-x-3 px-5 py-2.5 rounded-2xl bg-blue-50/50 dark:bg-blue-900/30 border border-blue-100/50 dark:border-blue-800/50">
                  <span className="font-bold text-2xl text-blue-600 dark:text-blue-300">
                    {fileCount}
                  </span>
                  <span className="text-base font-medium text-blue-600/70 dark:text-blue-300/70">
                    {fileCount === 1 ? t('meta.file') : t('meta.files')}
                  </span>
                </div>
                <p className="mt-6 text-gray-400 dark:text-gray-500 text-lg font-medium leading-relaxed">
                  {t('drag.copyHint')}
                </p>
              </div>

              {/* 新增：右侧装饰性文件堆叠感，填补极右侧空白 */}
              <div className={`hidden lg:flex flex-col gap-4 transition-all duration-700 ${hoveredAction === 'copy' ? 'opacity-100 translate-x-0' : 'opacity-0 translate-x-10'}`}>
                <div className="w-16 h-20 bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-800 flex items-center justify-center -rotate-6 shadow-sm">
                  <ImageIcon size={28} className="text-blue-400" />
                </div>
                <div className="w-16 h-20 bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-800 flex items-center justify-center rotate-12 shadow-md -translate-x-4">
                  <FileText size={28} className="text-cyan-400" />
                </div>
                <div className="w-16 h-20 bg-gray-100 dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-800 flex items-center justify-center -rotate-3 shadow-sm">
                  <FileCode size={28} className="text-indigo-400" />
                </div>
              </div>
            </div>

          </div>

          <div className={`absolute bottom-0 left-0 w-full h-2 bg-gradient-to-r from-transparent via-blue-500 to-transparent transition-all duration-700 pointer-events-none ${
            hoveredAction === 'copy' ? 'opacity-100' : 'opacity-0'
          }`}></div>
        </div>
      </div>
    </div>
  );
};
