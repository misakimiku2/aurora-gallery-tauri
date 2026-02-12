import React, { useState, useCallback, useEffect } from 'react';
import { Sparkles, Loader2, RefreshCw, Check, X, ImageIcon, ArrowLeft } from 'lucide-react';
import { FileNode, AppSettings, Person } from '../../types';
import { aiService } from '../../services/aiService';
import { getThumbnail } from '../../api/tauri-bridge';

interface AIBatchRenameModalProps {
  files: FileNode[];
  settings: AppSettings;
  people: Record<string, Person>;
  onConfirm: (newNames: Record<string, string>) => void;
  onClose: () => void;
  onBack?: () => void;
  t: (key: string) => string;
}

interface RenameItem {
  file: FileNode;
  newName: string;
  status: 'pending' | 'generating' | 'completed' | 'error';
  thumbnailUrl?: string;
}

export const AIBatchRenameModal: React.FC<AIBatchRenameModalProps> = ({
  files,
  settings,
  people,
  onConfirm,
  onClose,
  onBack,
  t,
}) => {
  const [items, setItems] = useState<RenameItem[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);
  const [progress, setProgress] = useState(0);
  const [hasGenerated, setHasGenerated] = useState(false);

  // Initialize items with thumbnails
  useEffect(() => {
    const initItems = async () => {
      const cacheRoot = settings.paths.cacheRoot || `${settings.paths.resourceRoot}/.Aurora_Cache`;
      
      const initialItems = await Promise.all(
        files.map(async (file) => {
          // 使用生成的缩略图，提高图片质量
          let thumbnailUrl: string | undefined;
          try {
            const thumb = await getThumbnail(file.path, file.updatedAt, settings.paths.resourceRoot);
            thumbnailUrl = thumb ?? undefined;
          } catch (e) {
            // 如果获取缩略图失败，使用原始路径
            thumbnailUrl = file.path ? `asset://localhost/${file.path}` : undefined;
          }
          
          return {
            file,
            newName: '',
            status: 'pending' as const,
            thumbnailUrl,
          };
        })
      );
      setItems(initialItems);
    };
    initItems();
  }, [files, settings]);

  const handleGenerate = useCallback(async () => {
    if (isGenerating) return;

    setIsGenerating(true);
    setProgress(0);

    const filePaths = items.map((item) => item.file.path);

    // 构建文件路径到人物名称列表的映射
    const filePersonMap = new Map<string, string[]>();
    items.forEach((item) => {
      const personNames: string[] = [];
      if (item.file.aiData?.faces && item.file.aiData.faces.length > 0) {
        item.file.aiData.faces.forEach((face) => {
          // 使用face中的name，或者从people中查找
          const personName = face.name || people[face.personId]?.name;
          if (personName && personName !== '未知人物' && !personNames.includes(personName)) {
            personNames.push(personName);
          }
        });
      }
      if (personNames.length > 0) {
        filePersonMap.set(item.file.path, personNames);
      }
    });

    try {
      const results = await aiService.generateFileNames(
        filePaths,
        settings,
        people,
        filePersonMap,
        (current, total, result) => {
          setProgress(Math.round((current / total) * 100));
          setItems((prev) =>
            prev.map((item, index) => {
              if (index < current - 1) {
                // 已完成的文件
                return { ...item, status: 'completed' };
              } else if (index === current - 1 && result) {
                // 当前刚完成的文件，实时更新新文件名
                return {
                  ...item,
                  newName: result,
                  status: 'completed'
                };
              } else if (index === current) {
                // 正在生成的文件
                return { ...item, status: 'generating' };
              }
              return item;
            })
          );
        }
      );

      // 最终同步确保所有文件名都正确设置
      setItems((prev) =>
        prev.map((item, index) => ({
          ...item,
          newName: results[index] || item.file.name,
          status: results[index] ? 'completed' : 'error',
        }))
      );
      setHasGenerated(true);
    } catch (error) {
      console.error('AI generation failed:', error);
      setItems((prev) =>
        prev.map((item) =>
          item.status === 'generating' ? { ...item, status: 'error' } : item
        )
      );
    } finally {
      setIsGenerating(false);
      setProgress(100);
    }
  }, [items, settings, isGenerating]);

  const handleApply = useCallback(() => {
    const newNames: Record<string, string> = {};
    items.forEach((item) => {
      if (item.newName && item.status === 'completed') {
        newNames[item.file.id] = item.newName;
      }
    });
    onConfirm(newNames);
  }, [items, onConfirm]);

  const handleRegenerate = useCallback(() => {
    setItems((prev) =>
      prev.map((item) => ({
        ...item,
        newName: '',
        status: 'pending',
      }))
    );
    setHasGenerated(false);
    setProgress(0);
    handleGenerate();
  }, [handleGenerate]);

  const handleBack = useCallback(() => {
    if (onBack) {
      onBack();
    } else {
      onClose();
    }
  }, [onBack, onClose]);

  const getFileExtension = (filename: string): string => {
    const match = filename.match(/\.[^.]+$/);
    return match ? match[0] : '';
  };

  // 渲染文件行组件 - 左右两侧结构一致
  const renderFileRow = (item: RenameItem, isRightSide: boolean) => {
    const baseClasses = "flex items-center gap-3 p-2 rounded-lg min-h-[64px]";
    const statusClasses = isRightSide
      ? item.status === 'completed'
        ? 'bg-green-50 dark:bg-green-900/20'
        : item.status === 'error'
        ? 'bg-red-50 dark:bg-red-900/20'
        : item.status === 'generating'
        ? 'bg-blue-50 dark:bg-blue-900/20'
        : 'bg-gray-50 dark:bg-gray-700/30'
      : 'bg-gray-50 dark:bg-gray-700/30';

    return (
      <div
        key={item.file.id}
        className={`${baseClasses} ${statusClasses}`}
      >
        {/* 缩略图 - 两侧都显示 */}
        <div className="w-12 h-12 rounded-lg bg-gray-200 dark:bg-gray-600 flex items-center justify-center overflow-hidden flex-shrink-0">
          {item.thumbnailUrl ? (
            <img
              src={item.thumbnailUrl}
              alt={item.file.name}
              className="w-full h-full object-cover"
              style={{
                imageRendering: '-webkit-optimize-contrast',
                transform: 'translateZ(0) scale(1.01)',
                backfaceVisibility: 'hidden',
                willChange: 'transform',
                WebkitFontSmoothing: 'antialiased',
                perspective: '1000px',
              }}
              loading="lazy"
              decoding="async"
            />
          ) : (
            <ImageIcon className="w-6 h-6 text-gray-400" />
          )}
        </div>
        
        {/* 文件名区域 */}
        <div className="flex-1 min-w-0">
          {isRightSide ? (
            // 右侧 - 新文件名
            item.status === 'completed' ? (
              <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
                {item.newName}
              </p>
            ) : item.status === 'generating' ? (
              <div className="flex items-center gap-2">
                <Loader2 className="w-4 h-4 text-blue-500 animate-spin" />
                <span className="text-sm text-gray-500">
                  {t('context.aiGenerating')}
                </span>
              </div>
            ) : item.status === 'error' ? (
              <p className="text-sm text-red-500">
                {t('context.failed')}
              </p>
            ) : (
              <p className="text-sm text-gray-400">
                {t('context.pending')}
              </p>
            )
          ) : (
            // 左侧 - 原文件名
            <p className="text-sm text-gray-900 dark:text-gray-100 truncate">
              {item.file.name}
            </p>
          )}
        </div>
        
        {/* 状态图标 */}
        {isRightSide && item.status === 'completed' && (
          <Check className="w-4 h-4 text-green-500 flex-shrink-0" />
        )}
        {!isRightSide && item.status === 'generating' && (
          <Loader2 className="w-4 h-4 text-blue-500 animate-spin flex-shrink-0" />
        )}
      </div>
    );
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-[900px] max-w-[95vw] max-h-[90vh] flex flex-col animate-zoom-in">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b dark:border-gray-700">
        <div className="flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-purple-500" />
          <h3 className="font-bold text-lg text-gray-900 dark:text-white">
            {t('context.aiBatchRename')}
          </h3>
        </div>
        <button
          onClick={onClose}
          className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-full transition-colors"
        >
          <X className="w-5 h-5 text-gray-500" />
        </button>
      </div>

      {/* Description */}
      <div className="px-4 py-2 bg-purple-50 dark:bg-purple-900/20 border-b dark:border-gray-700">
        <p className="text-sm text-purple-700 dark:text-purple-300">
          {t('context.aiRenameDesc')}
        </p>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-hidden flex">
        {/* Left side - Original files */}
        <div className="w-1/2 border-r dark:border-gray-700 flex flex-col">
          <div className="px-4 py-2 bg-gray-50 dark:bg-gray-700/50 border-b dark:border-gray-700">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('context.originalName')} ({items.length})
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {items.map((item) => renderFileRow(item, false))}
          </div>
        </div>

        {/* Right side - AI generated names */}
        <div className="w-1/2 flex flex-col">
          <div className="px-4 py-2 bg-gray-50 dark:bg-gray-700/50 border-b dark:border-gray-700">
            <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
              {t('context.newName')}
            </span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-2">
            {items.map((item) => renderFileRow(item, true))}
          </div>
        </div>
      </div>

      {/* Progress bar */}
      {isGenerating && (
        <div className="px-4 py-2 border-t dark:border-gray-700">
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className="bg-purple-500 h-2 rounded-full transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1 text-center">
            {progress}%
          </p>
        </div>
      )}

      {/* Footer */}
      <div className="flex justify-between items-center p-4 border-t dark:border-gray-700">
        {/* 左侧 - 返回按钮（替换原来的取消按钮位置） */}
        <button
          onClick={handleBack}
          className="flex items-center gap-2 px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('context.backToManualRename')}
        </button>

        {/* 右侧 - 操作按钮 */}
        <div className="flex gap-2">
          {!hasGenerated ? (
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isGenerating ? (
                <>
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t('context.aiGenerating')}
                </>
              ) : (
                <>
                  <Sparkles className="w-4 h-4" />
                  {t('context.startGenerating')}
                </>
              )}
            </button>
          ) : (
            <>
              <button
                onClick={handleRegenerate}
                disabled={isGenerating}
                className="flex items-center gap-2 px-4 py-2 text-purple-600 dark:text-purple-400 hover:bg-purple-50 dark:hover:bg-purple-900/20 rounded-lg transition-colors"
              >
                <RefreshCw className="w-4 h-4" />
                {t('context.regenerate')}
              </button>
              <button
                onClick={handleApply}
                disabled={isGenerating || !items.some((i) => i.status === 'completed')}
                className="flex items-center gap-2 px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                <Check className="w-4 h-4" />
                {t('context.applyRename')}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
