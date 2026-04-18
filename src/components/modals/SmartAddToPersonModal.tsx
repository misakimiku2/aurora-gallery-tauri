import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { User, Sparkles, X, Plus, Check, CheckSquare, Square, AlertCircle, RefreshCw } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { FileNode, Person as PersonType, ClipSearchResult, FileType } from '../../types';
import { clipSearchByCharacterTag, getThumbnail, clipGetEmbeddingStatus, clipGenerateEmbeddingsBatch } from '../../api/tauri-bridge';
import { ImageThumbnail } from '../ImageThumbnail';

const THUMBNAIL_SIZE = 120;
const GRID_GAP = 8;

interface SmartAddToPersonModalProps {
  person: PersonType;
  files: Record<string, FileNode>;
  resourceRoot: string;
  cachePath: string;
  language: 'zh' | 'en';
  clipSettings: {
    minScore: number;
    modelName: string;
    enabled: boolean;
  };
  onConfirm: (newFileIds: string[]) => void;
  onClose: () => void;
  t: (key: string) => string;
}

export const SmartAddToPersonModal: React.FC<SmartAddToPersonModalProps> = ({
  person,
  files,
  resourceRoot,
  cachePath,
  language,
  clipSettings,
  onConfirm,
  onClose,
  t
}) => {
  const [threshold, setThreshold] = useState(0.1);
  const [matchedResults, setMatchedResults] = useState<ClipSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selectedFileIds, setSelectedFileIds] = useState<Set<string>>(new Set());
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarOriginalSrc, setAvatarOriginalSrc] = useState<string | null>(null);
  const [filesWithoutEmbedding, setFilesWithoutEmbedding] = useState<string[]>([]);
  const [checkingEmbeddings, setCheckingEmbeddings] = useState(true);
  const [generatingEmbeddings, setGeneratingEmbeddings] = useState(false);
  const [embeddingProgress, setEmbeddingProgress] = useState<{ current: number; total: number } | null>(null);
  
  const gridContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerRect, setContainerRect] = useState({ width: 600, height: 300 });
  
  const debounceTimerRef = useRef<NodeJS.Timeout | null>(null);

  const existingFileIds = useMemo(() => {
    const ids = new Set<string>();
    Object.values(files || {}).forEach(file => {
      if (file.aiData?.faces?.some(f => f.personId === person.id)) {
        ids.add(file.id);
      }
    });
    return ids;
  }, [files, person.id]);

  const allImageFiles = useMemo(() => {
    return Object.values(files || {}).filter(file => 
      file.type === FileType.IMAGE && file.path && !existingFileIds.has(file.id)
    );
  }, [files, existingFileIds]);

  const searchImages = useCallback(async (searchThreshold: number) => {
    if (person.characterTagIndex === undefined) {
      setMatchedResults([]);
      return;
    }
    
    setLoading(true);
    try {
      const results = await clipSearchByCharacterTag(person.characterTagIndex, searchThreshold, 500);
      const filtered = results.filter(r => !existingFileIds.has(r.file_id));
      setMatchedResults(filtered);
    } catch (error) {
      console.error('Failed to search images:', error);
    } finally {
      setLoading(false);
    }
  }, [person.characterTagIndex, existingFileIds]);

  useEffect(() => {
    const checkEmbeddings = async () => {
      if (!clipSettings.enabled || allImageFiles.length === 0) {
        setCheckingEmbeddings(false);
        return;
      }

      setCheckingEmbeddings(true);
      const withoutEmbedding: string[] = [];

      for (const file of allImageFiles) {
        try {
          const hasEmbedding = await clipGetEmbeddingStatus(file.id);
          if (!hasEmbedding) {
            withoutEmbedding.push(file.id);
          }
        } catch (e) {
          console.error('Failed to check embedding status:', e);
        }
      }

      setFilesWithoutEmbedding(withoutEmbedding);
      setCheckingEmbeddings(false);
    };

    checkEmbeddings();
  }, [allImageFiles, clipSettings.enabled]);

  const handleGenerateEmbeddings = useCallback(async () => {
    if (filesWithoutEmbedding.length === 0) return;

    setGeneratingEmbeddings(true);
    setEmbeddingProgress({ current: 0, total: filesWithoutEmbedding.length });

    const fileTuples: [string, string][] = filesWithoutEmbedding
      .map(id => {
        const file = files[id];
        return file?.path ? [file.path, id] as [string, string] : null;
      })
      .filter((t): t is [string, string] => t !== null);

    try {
      await clipGenerateEmbeddingsBatch(
        fileTuples,
        false,
        clipSettings.modelName,
        false,
        0.3,
        language
      );
      
      setFilesWithoutEmbedding([]);
      searchImages(threshold);
    } catch (error) {
      console.error('Failed to generate embeddings:', error);
    } finally {
      setGeneratingEmbeddings(false);
      setEmbeddingProgress(null);
    }
  }, [filesWithoutEmbedding, files, clipSettings.modelName, language, searchImages, threshold]);

  useEffect(() => {
    const updateRect = () => {
      if (gridContainerRef.current) {
        const rect = gridContainerRef.current.getBoundingClientRect();
        setContainerRect({ width: rect.width, height: rect.height });
      }
    };
    
    updateRect();
    window.addEventListener('resize', updateRect);
    return () => window.removeEventListener('resize', updateRect);
  }, []);

  useEffect(() => {
    if (person.coverFileId && files[person.coverFileId]?.path) {
      const coverFile = files[person.coverFileId];
      const coverPath = coverFile.path!;
      
      getThumbnail(coverPath, undefined, resourceRoot)
        .then(url => setAvatarUrl(url))
        .catch(e => console.error('Failed to load avatar thumbnail:', e));
      
      setAvatarOriginalSrc(convertFileSrc(coverPath));
    }
  }, [person.coverFileId, files, resourceRoot]);

  useEffect(() => {
    searchImages(threshold);
  }, []);

  const handleThresholdChange = useCallback((newThreshold: number) => {
    setThreshold(newThreshold);
    
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    
    debounceTimerRef.current = setTimeout(() => {
      searchImages(newThreshold);
    }, 200);
  }, [searchImages]);

  const toggleFileSelection = useCallback((fileId: string) => {
    setSelectedFileIds(prev => {
      const newSet = new Set(prev);
      if (newSet.has(fileId)) {
        newSet.delete(fileId);
      } else {
        newSet.add(fileId);
      }
      return newSet;
    });
  }, []);

  const selectAllFiles = useCallback(() => {
    setSelectedFileIds(new Set(matchedResults.map(r => r.file_id)));
  }, [matchedResults]);

  const deselectAllFiles = useCallback(() => {
    setSelectedFileIds(new Set());
  }, []);

  const handleConfirm = useCallback(() => {
    if (selectedFileIds.size === 0) return;
    onConfirm(Array.from(selectedFileIds));
  }, [selectedFileIds, onConfirm]);

  const visibleItems = useMemo(() => {
    const buffer = 400;
    const cols = Math.floor((containerRect.width - 32) / (THUMBNAIL_SIZE + GRID_GAP));
    const itemWidth = (containerRect.width - 32 - (cols - 1) * GRID_GAP) / cols;
    
    return matchedResults
      .map((result, index) => {
        const col = index % cols;
        const row = Math.floor(index / cols);
        return {
          id: result.file_id,
          x: 16 + col * (itemWidth + GRID_GAP),
          y: row * (itemWidth + GRID_GAP),
          width: itemWidth,
          height: itemWidth,
          score: result.score,
          index
        };
      })
      .filter(item => {
        const minY = scrollTop - buffer;
        const maxY = scrollTop + containerRect.height + buffer;
        return item.y < maxY && item.y + item.height > minY;
      });
  }, [matchedResults, scrollTop, containerRect]);

  const totalHeight = useMemo(() => {
    const cols = Math.max(1, Math.floor((containerRect.width - 32) / (THUMBNAIL_SIZE + GRID_GAP)));
    const rows = Math.ceil(matchedResults.length / cols);
    return rows * (THUMBNAIL_SIZE + GRID_GAP) + 16;
  }, [matchedResults.length, containerRect.width]);

  useEffect(() => {
    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
    };
  }, []);

  if (!clipSettings.enabled || clipSettings.modelName !== 'WD-EVA02-Large-Tagger-V3') {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-[500px] animate-zoom-in">
        <div className="flex items-center justify-center h-40 text-gray-500 dark:text-gray-400">
          <div className="text-center">
            <Sparkles size={40} className="mx-auto mb-3 opacity-50" />
            <p>{t('smartCreate.wd14Required') || '此功能需要启用 WD14 模型'}</p>
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            {t('settings.cancel')}
          </button>
        </div>
      </div>
    );
  }

  if (person.characterTagIndex === undefined) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-[500px] animate-zoom-in">
        <div className="flex items-center justify-center h-40 text-gray-500 dark:text-gray-400">
          <div className="text-center">
            <User size={40} className="mx-auto mb-3 opacity-50" />
            <p>{t('smartAddToPerson.noTagIndex') || '此人物未关联角色标签，无法使用智能添加功能'}</p>
          </div>
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={onClose} className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
            {t('settings.cancel')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl w-full max-w-4xl h-[75vh] flex flex-col animate-zoom-in">
      <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
        <h3 className="font-bold text-lg text-gray-900 dark:text-white flex items-center gap-2">
          <Plus size={20} className="text-blue-500" />
          {t('smartAddToPerson.title') || '智能添加图片'} - {person.name}
        </h3>
        <button onClick={onClose} className="p-1 hover:bg-gray-100 dark:hover:bg-gray-700 rounded">
          <X size={18} className="text-gray-500" />
        </button>
      </div>

      <div className="flex flex-1 overflow-hidden">
        <div className="w-72 flex-shrink-0 border-r border-gray-200 dark:border-gray-700 p-4 flex flex-col">
          <div className="flex flex-col items-center mb-4">
            <div className="w-[180px] h-[180px] rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden border-4 border-white dark:border-gray-600 shadow-lg">
              {avatarOriginalSrc ? (
                <div className="w-full h-full overflow-hidden relative">
                  <img
                    src={avatarOriginalSrc}
                    alt={person.name}
                    className="absolute"
                    style={person.faceBox ? {
                      width: `${10000 / person.faceBox.w}%`,
                      height: `${10000 / person.faceBox.h}%`,
                      maxWidth: 'none',
                      minWidth: 'unset',
                      left: `${-person.faceBox.x / person.faceBox.w * 100}%`,
                      top: `${-person.faceBox.y / person.faceBox.h * 100}%`,
                      imageRendering: 'auto'
                    } : {
                      width: '100%',
                      height: '100%',
                      objectFit: 'cover',
                      left: 0,
                      top: 0,
                      imageRendering: 'auto'
                    }}
                  />
                </div>
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <User size={32} className="text-gray-400 dark:text-gray-500" />
                </div>
              )}
            </div>
            <div className="mt-2 text-center">
              <div className="font-medium text-gray-900 dark:text-white">{person.name}</div>
              <div className="text-sm text-gray-500 dark:text-gray-400">
                {person.count} {language === 'zh' ? '张图片' : 'images'}
              </div>
            </div>
          </div>

          {checkingEmbeddings ? (
            <div className="flex items-center justify-center py-3">
              <div className="w-5 h-5 border-2 border-gray-300 dark:border-gray-500 border-t-blue-500 dark:border-t-blue-400 rounded-full animate-spin" />
              <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">
                {t('smartAddToPerson.checkingEmbeddings') || '检测新图片...'}
              </span>
            </div>
          ) : filesWithoutEmbedding.length > 0 ? (
            <div className="mb-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-2">
                <AlertCircle size={18} className="text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                  <p className="text-sm text-amber-800 dark:text-amber-200 font-medium">
                    {t('smartAddToPerson.newImagesDetected') || '检测到新图片'}
                  </p>
                  <p className="text-xs text-amber-700 dark:text-amber-300 mt-1">
                    {language === 'zh' 
                      ? `${filesWithoutEmbedding.length} 张新图片尚未生成嵌入向量，无法被智能识别`
                      : `${filesWithoutEmbedding.length} new images without embeddings, cannot be recognized`}
                  </p>
                  <button
                    onClick={handleGenerateEmbeddings}
                    disabled={generatingEmbeddings}
                    className="mt-2 w-full px-3 py-1.5 text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 rounded transition-colors flex items-center justify-center gap-2"
                  >
                    {generatingEmbeddings ? (
                      <>
                        <RefreshCw size={14} className="animate-spin" />
                        {language === 'zh' 
                          ? `生成中... (${embeddingProgress?.current || 0}/${embeddingProgress?.total || 0})`
                          : `Generating... (${embeddingProgress?.current || 0}/${embeddingProgress?.total || 0})`}
                      </>
                    ) : (
                      <>
                        <Sparkles size={14} />
                        {t('smartAddToPerson.generateEmbeddings') || '生成嵌入向量'}
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          ) : null}

          <div className="mb-4">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              {t('smartCreate.similarityThreshold') || '相似度阈值'}: {threshold.toFixed(3)}
            </label>
            <input
              type="range"
              min="0.01"
              max="0.5"
              step="0.01"
              value={threshold}
              onChange={(e) => handleThresholdChange(parseFloat(e.target.value))}
              className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer"
            />
          </div>

          <div className="flex-1" />

          <div className="mt-auto pt-4 border-t border-gray-200 dark:border-gray-700">
            <div className="text-sm text-gray-600 dark:text-gray-400 mb-3">
              {t('smartAddToPerson.selected') || '已选择'}: {selectedFileIds.size} {language === 'zh' ? '张' : ''} {language === 'zh' ? '图片' : 'images'}
            </div>
            <div className="flex gap-2">
              <button
                onClick={onClose}
                className="flex-1 px-4 py-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm"
              >
                {t('settings.cancel')}
              </button>
              <button
                onClick={handleConfirm}
                disabled={selectedFileIds.size === 0}
                className={`flex-1 px-4 py-2 rounded text-sm text-white transition-colors ${
                  selectedFileIds.size > 0
                    ? 'bg-blue-600 hover:bg-blue-700'
                    : 'bg-gray-400 cursor-not-allowed'
                }`}
              >
                {t('smartAddToPerson.add') || '添加'}
              </button>
            </div>
          </div>
        </div>

        <div className="flex-1 flex flex-col overflow-hidden bg-gray-50 dark:bg-gray-900">
          <div className="p-3 border-b border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800">
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('smartAddToPerson.availableImages') || '可添加的图片'}
              </span>
              <div className="flex items-center gap-2">
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {matchedResults.length} {language === 'zh' ? '张' : ''} {language === 'zh' ? '新图片' : 'new images'}
                </span>
                {matchedResults.length > 0 && (
                  <>
                    <button
                      onClick={selectedFileIds.size === matchedResults.length ? deselectAllFiles : selectAllFiles}
                      className={`p-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors ${
                        selectedFileIds.size === matchedResults.length
                          ? 'text-blue-600 dark:text-blue-400'
                          : 'text-gray-600 dark:text-gray-400'
                      }`}
                      title={selectedFileIds.size === matchedResults.length ? '取消全选' : '全选'}
                    >
                      {selectedFileIds.size === matchedResults.length ? (
                        <CheckSquare size={14} />
                      ) : (
                        <Square size={14} />
                      )}
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
          <div
            ref={gridContainerRef}
            className="flex-1 overflow-auto p-4"
            onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
          >
            {loading ? (
              <div className="flex items-center justify-center h-full">
                <div className="w-8 h-8 border-2 border-gray-300 dark:border-gray-500 border-t-blue-500 dark:border-t-blue-400 rounded-full animate-spin" />
              </div>
            ) : matchedResults.length === 0 ? (
              <div className="flex items-center justify-center h-full text-gray-500">
                <div className="text-center">
                  <User size={48} className="mx-auto mb-3 opacity-30" />
                  <p>{t('smartAddToPerson.noNewImages') || '没有可添加的新图片'}</p>
                  <p className="text-sm mt-1">{t('smartAddToPerson.tryLowerThreshold') || '尝试降低阈值以找到更多图片'}</p>
                </div>
              </div>
            ) : (
              <div className="relative" style={{ height: totalHeight }}>
                {visibleItems.map((item) => {
                  const file = files[item.id];
                  const isSelected = selectedFileIds.has(item.id);
                  
                  return (
                    <div
                      key={item.id}
                      className="absolute group cursor-pointer"
                      style={{
                        left: item.x,
                        top: item.y,
                        width: item.width,
                        height: item.height
                      }}
                      onClick={() => toggleFileSelection(item.id)}
                    >
                      <div className={`w-full h-full rounded overflow-hidden border-2 transition-all ${
                        isSelected
                          ? 'border-blue-500 shadow-lg ring-2 ring-blue-300 dark:ring-blue-600'
                          : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                      }`}>
                        {file?.path ? (
                          <ImageThumbnail
                            src=""
                            alt={file.name || ""}
                            isSelected={isSelected}
                            filePath={file.path}
                            modified={file.updatedAt}
                            resourceRoot={resourceRoot}
                            cachePath={cachePath}
                          />
                        ) : (
                          <div className="w-full h-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
                            <User size={24} className="text-gray-400" />
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <div className="absolute top-1 right-1 w-5 h-5 bg-blue-500 rounded-full flex items-center justify-center shadow">
                          <Check size={12} className="text-white" />
                        </div>
                      )}
                      <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/60 to-transparent p-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <span className="text-xs text-white">{(item.score * 100).toFixed(0)}%</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
