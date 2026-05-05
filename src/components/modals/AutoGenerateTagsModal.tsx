import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Tag, Image as ImageIcon, Loader2, Sparkles, ArrowLeft, Check, AlertCircle } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Grid } from 'react-window';
import { FileNode, FileType, PreviewTag, TagsPreviewResult } from '../../types';
import { clipPreviewTagsFromEmbeddings, clipGenerateTagsFromEmbeddings, getThumbnail } from '../../api/tauri-bridge';
import { getGlobalCache } from '../../utils/thumbnailCache';

interface TagPreviewThumbnailProps {
  file: FileNode;
  resourceRoot?: string;
}

const TagPreviewThumbnail = ({ file, resourceRoot }: TagPreviewThumbnailProps) => {
  const [src, setSrc] = useState<string | null>(() => {
    if (!file.path) return null;
    return getGlobalCache().get(file.path) || null;
  });

  useEffect(() => {
    let active = true;
    if (file.type === FileType.IMAGE && resourceRoot && !src) {
      getThumbnail(file.path, file.meta?.modified, resourceRoot).then(url => {
        if (active && url) {
          setSrc(url);
          getGlobalCache().set(file.path, url);
        }
      });
    }
    return () => { active = false; };
  }, [file.path, file.meta?.modified, resourceRoot, src]);

  const displaySrc = src || convertFileSrc(file.path);

  return (
    <img 
      src={displaySrc} 
      alt="" 
      className="w-full h-full object-cover"
      style={{ imageRendering: 'high-quality' as any, transform: 'translateZ(0)' }}
      loading="lazy"
    />
  );
};

interface AutoGenerateTagsModalProps {
  files: Record<string, FileNode>;
  resourceRoot: string;
  cachePath: string;
  language: 'zh' | 'en';
  clipSettings: {
    minScore: number;
    modelName: string;
    enabled: boolean;
  };
  onConfirm: () => void;
  onClose: () => void;
  t: (key: string) => string;
}

const COLUMNS = 4;
const CELL_HEIGHT = 72;
const CELL_GAP = 12;
const PADDING = 16;

export const AutoGenerateTagsModal: React.FC<AutoGenerateTagsModalProps> = ({
  files,
  resourceRoot,
  cachePath,
  language,
  clipSettings,
  onConfirm,
  onClose,
  t
}) => {
  const [threshold, setThreshold] = useState(0.35);
  const [previewResult, setPreviewResult] = useState<TagsPreviewResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hoveredTag, setHoveredTag] = useState<PreviewTag | null>(null);
  const [hoveredTagPos, setHoveredTagPos] = useState<{ top: number; left: number } | null>(null);
  const [modalHeight, setModalHeight] = useState(600);
  const [modalWidth, setModalWidth] = useState(768);
  const [gridSize, setGridSize] = useState({ height: 400, width: 700 });
  
  const modalRef = useRef<HTMLDivElement>(null);
  const gridContainerRef = useRef<HTMLDivElement>(null);
  
  useEffect(() => {
    const updateSize = () => {
      const windowHeight = window.innerHeight;
      const windowWidth = window.innerWidth;
      const maxHeight = Math.min(windowHeight * 0.85, 800);
      const minHeight = 400;
      const maxWidth = Math.min(windowWidth * 0.9, 896);
      setModalHeight(Math.max(minHeight, maxHeight));
      setModalWidth(maxWidth);
    };
    
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);
  
  useEffect(() => {
    if (gridContainerRef.current && previewResult && previewResult.tags.length > 0) {
      const rect = gridContainerRef.current.getBoundingClientRect();
      setGridSize({
        height: rect.height,
        width: rect.width
      });
    }
  }, [previewResult, modalHeight, modalWidth]);
  
  const handlePreview = async () => {
    if (!clipSettings.enabled || clipSettings.modelName !== 'WD-EVA02-Large-Tagger-V3') {
      setError(t('tags.wd14Required') || '需要 WD-EVA02-Large-Tagger-V3 模型');
      return;
    }
    
    setLoading(true);
    setError(null);
    setPreviewResult(null);
    
    try {
      const result = await clipPreviewTagsFromEmbeddings(
        clipSettings.modelName,
        threshold,
        language
      );
      setPreviewResult(result);
    } catch (err: any) {
      console.error('Failed to preview tags:', err);
      setError(err?.message || t('tags.previewFailed') || '预览失败');
    } finally {
      setLoading(false);
    }
  };
  
  const handleApply = async () => {
    if (!previewResult) return;
    
    setApplying(true);
    setError(null);
    
    try {
      await clipGenerateTagsFromEmbeddings(
        clipSettings.modelName,
        threshold,
        language
      );
      onConfirm();
      onClose();
    } catch (err: any) {
      console.error('Failed to apply tags:', err);
      setError(err?.message || t('tags.applyFailed') || '应用失败');
    } finally {
      setApplying(false);
    }
  };
  
  const handleTagHover = useCallback((tag: PreviewTag | null, e: React.MouseEvent | null) => {
    if (!tag || !e) {
      setHoveredTag(null);
      setHoveredTagPos(null);
      return;
    }
    
    const rect = e.currentTarget.getBoundingClientRect();
    const PREVIEW_WIDTH = 256;
    const PREVIEW_HEIGHT = 120;
    
    let left = rect.right + 10;
    let top = rect.top;
    
    if (left + PREVIEW_WIDTH > window.innerWidth) {
      left = rect.left - PREVIEW_WIDTH - 10;
    }
    if (top + PREVIEW_HEIGHT > window.innerHeight) {
      top = window.innerHeight - PREVIEW_HEIGHT - 10;
    }
    
    setHoveredTag(tag);
    setHoveredTagPos({ top, left });
  }, []);
  
  const previewImages = useMemo(() => {
    if (!hoveredTag) return [];
    return hoveredTag.sample_file_ids
      .map(id => files[id])
      .filter(Boolean);
  }, [hoveredTag, files]);
  
  const headerHeight = 180;
  const footerHeight = 64;
  const statsBarHeight = 36;
  
  const tags = previewResult?.tags || [];
  const rowCount = Math.ceil(tags.length / COLUMNS);
  const columnWidth = (gridSize.width - PADDING * 2) / COLUMNS;
  
  const CellComponent = useCallback(({ columnIndex, rowIndex, style }: { columnIndex: number; rowIndex: number; style: React.CSSProperties }) => {
    const index = rowIndex * COLUMNS + columnIndex;
    if (index >= tags.length) return null;
    
    const tag = tags[index];
    const displayName = language === 'zh' && tag.name_cn ? tag.name_cn : tag.name;
    
    return (
      <div
        style={{
          ...style,
          left: Number(style.left) + PADDING,
          top: Number(style.top) + PADDING,
          width: Number(style.width) - CELL_GAP,
          height: Number(style.height) - CELL_GAP,
        }}
        className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 border border-gray-200 dark:border-gray-700 hover:border-blue-400 dark:hover:border-blue-500 hover:shadow-md transition-all cursor-default group"
        onMouseEnter={(e) => handleTagHover(tag, e)}
        onMouseLeave={() => handleTagHover(null, null)}
      >
        <div className="flex items-center justify-between mb-1">
          <Tag size={14} className="text-blue-500 dark:text-blue-400 group-hover:scale-110 transition-transform" />
          <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 px-1.5 py-0.5 rounded-full font-medium">
            {tag.count}
          </span>
        </div>
        <span className="text-sm text-gray-800 dark:text-gray-200 line-clamp-2 break-all" title={displayName}>
          {displayName}
        </span>
      </div>
    );
  }, [tags, language, handleTagHover]);
  
  type CellProps = Record<string, never>;
  
  return (
    <div className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/50">
      <div 
        ref={modalRef}
        className="bg-white dark:bg-gray-900 rounded-2xl shadow-2xl w-full flex flex-col overflow-hidden"
        style={{ height: modalHeight, maxWidth: modalWidth }}
      >
        <div className="p-6 border-b border-gray-200 dark:border-gray-700 shrink-0">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center">
              <Sparkles size={24} className="mr-2 text-purple-500" />
              {t('tags.autoGenerate') || '自动生成标签'}
            </h2>
          </div>
          
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                  {t('tags.threshold') || '置信度阈值'}
                </label>
                <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
                  {threshold.toFixed(2)}
                </span>
              </div>
              <input
                type="range"
                min="0.1"
                max="0.9"
                step="0.05"
                value={threshold}
                onChange={(e) => setThreshold(parseFloat(e.target.value))}
                className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
              />
              <div className="flex justify-between text-xs text-gray-400 mt-1">
                <span>0.10</span>
                <span>0.50</span>
                <span>0.90</span>
              </div>
            </div>
            
            {!clipSettings.enabled || clipSettings.modelName !== 'WD-EVA02-Large-Tagger-V3' ? (
              <div className="flex items-center p-3 bg-yellow-50 dark:bg-yellow-900/20 rounded-lg text-sm text-yellow-700 dark:text-yellow-300">
                <AlertCircle size={16} className="mr-2 flex-shrink-0" />
                {t('tags.wd14Required') || '此功能需要启用 WD-EVA02-Large-Tagger-V3 模型'}
              </div>
            ) : (
              <button
                onClick={handlePreview}
                disabled={loading}
                className="w-full py-2.5 bg-purple-500 hover:bg-purple-600 disabled:bg-purple-400 text-white rounded-lg font-medium transition-colors flex items-center justify-center"
              >
                {loading ? (
                  <>
                    <Loader2 size={18} className="mr-2 animate-spin" />
                    {t('tags.loading') || '加载中...'}
                  </>
                ) : (
                  <>
                    <Tag size={18} className="mr-2" />
                    {t('tags.generatePreview') || '生成预览'}
                  </>
                )}
              </button>
            )}
          </div>
        </div>
        
        <div className="flex-1 overflow-hidden relative flex flex-col">
          {previewResult && previewResult.tags.length > 0 && (
            <div className="px-4 py-2 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 shrink-0">
              {t('tags.detectedTags') || '检测到的标签'}: {previewResult.tags.length} | 
              {t('tags.filesWithTags') || '有标签的文件'}: {previewResult.files_with_tags} / {previewResult.total_files}
            </div>
          )}
          
          <div 
            ref={gridContainerRef}
            className="flex-1 relative"
            style={{ minHeight: modalHeight - headerHeight - footerHeight - statsBarHeight }}
          >
            {error && (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <div className="text-center text-red-500">
                  <AlertCircle size={48} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{error}</p>
                </div>
              </div>
            )}
            
            {!error && !previewResult && !loading && (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <div className="text-center text-gray-400 dark:text-gray-500">
                  <Tag size={48} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{t('tags.generateFirst') || '请先点击"生成预览"查看标签'}</p>
                </div>
              </div>
            )}
            
            {loading && (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <div className="text-center text-gray-400 dark:text-gray-500">
                  <Loader2 size={48} className="mx-auto mb-2 animate-spin" />
                  <p className="text-sm">{t('tags.analyzing') || '正在分析嵌入向量...'}</p>
                </div>
              </div>
            )}
            
            {previewResult && previewResult.tags.length > 0 && gridSize.height > 0 && gridSize.width > 0 && (
              <Grid<CellProps>
                columnCount={COLUMNS}
                columnWidth={columnWidth}
                rowCount={rowCount}
                rowHeight={CELL_HEIGHT}
                style={{ height: gridSize.height, width: gridSize.width }}
                cellComponent={CellComponent}
                cellProps={{} as CellProps}
              />
            )}
            
            {previewResult && previewResult.tags.length === 0 && (
              <div className="absolute inset-0 flex items-center justify-center p-4">
                <div className="text-center text-gray-400 dark:text-gray-500">
                  <Tag size={48} className="mx-auto mb-2 opacity-50" />
                  <p className="text-sm">{t('tags.noTagsDetected') || '未检测到标签，请尝试降低阈值'}</p>
                </div>
              </div>
            )}
          </div>
        </div>
        
        <div className="p-4 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200 transition-colors flex items-center"
          >
            <ArrowLeft size={16} className="mr-1" />
            {t('tags.back') || '返回'}
          </button>
          
          <button
            onClick={handleApply}
            disabled={applying || !previewResult || previewResult.tags.length === 0}
            className="px-4 py-2 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 dark:disabled:bg-gray-600 text-white rounded-lg font-medium transition-colors flex items-center"
          >
            {applying ? (
              <Loader2 size={16} className="mr-1.5 animate-spin" />
            ) : (
              <Check size={16} className="mr-1.5" />
            )}
            {t('tags.applyTags') || '应用标签'}
          </button>
        </div>
        
        {hoveredTag && previewImages.length > 0 && hoveredTagPos && createPortal(
          <div 
            className="fixed z-[110] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl p-3 w-64 animate-fade-in pointer-events-none" 
            style={{ top: hoveredTagPos.top, left: hoveredTagPos.left }}
          >
            <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 border-b border-gray-200 dark:border-gray-700 pb-1 font-bold flex items-center justify-between">
              <span className="truncate">{language === 'zh' && hoveredTag.name_cn ? hoveredTag.name_cn : hoveredTag.name}</span>
              <span className="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 rounded ml-2 shrink-0">{previewImages.length}</span>
            </div>
            <div className="grid grid-cols-3 gap-2">
              {previewImages.map((f) => (
                <div key={f.id} className="aspect-square bg-gray-100 dark:bg-black rounded border border-gray-200 dark:border-gray-800 overflow-hidden relative">
                  <TagPreviewThumbnail file={f} resourceRoot={resourceRoot} />
                  <div className="absolute inset-0 flex items-center justify-center bg-gray-200 dark:bg-gray-700 -z-10">
                    <ImageIcon className="text-gray-400 dark:text-gray-500" size={20} />
                  </div>
                </div>
              ))}
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>
  );
};
