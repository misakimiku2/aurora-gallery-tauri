import React, { useState, useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { Database, Download, Upload, Palette, RefreshCw, Pause, Play, Square, AlertCircle, ChevronUp, ChevronDown, Trash, List, Grid, Image, Eye, FolderOpen, Check, X } from 'lucide-react';
import { AppState, AppSettings, FileType } from '../../types';
import {
  getColorDbStats,
  cleanupStaleColorRecords,
  getColorDbErrorFiles,
  retryColorExtraction,
  deleteColorDbErrorFiles,
  ColorDbStats,
  ColorDbErrorFile,
  getAssetUrl,
  deleteFile,
  addPendingFilesToDb,
  resumeColorExtraction,
  pauseColorExtraction,
  shutdownColorExtraction,
  cancelColorExtraction,
  androidBatchExtractColors,
  isAndroidPlatformCached,
  getGlobalCacheRoot,
  androidHideTaskNotification,
  androidUpdateTaskNotification,
  androidGetCacheSize,
  androidClearThumbnailCache,
  writeFileFromBytes,
} from '../../api/tauri-bridge';
import { getGlobalCache, getThumbnailPathCache } from '../../utils/thumbnailCache';
import { formatFileSize, formatEstimatedTimeMs } from './utils';

// 存储设置 + 主色调数据库管理面板组件
interface StoragePanelProps {
  t: (key: string) => string;
  state: AppState;
  settings: AppSettings;
  isAndroid: boolean;
  onUpdateSettings: (updates: Partial<AppState>) => void;
  onUpdatePath: (type: 'resource') => void;
  onClose: () => void;
  onShowToast?: (msg: string, duration?: number) => void;
  onRefresh?: () => void;
  onNavigateToFile?: (filePath: string) => void;
}

const StoragePanel: React.FC<StoragePanelProps> = ({ t, state, settings, isAndroid, onUpdateSettings, onUpdatePath, onClose, onShowToast, onRefresh, onNavigateToFile }) => {
  // Color database management state
  const [colorDbStats, setColorDbStats] = useState<ColorDbStats | null>(null);
  const [errorFiles, setErrorFiles] = useState<ColorDbErrorFile[]>([]);
  const [showErrorFiles, setShowErrorFiles] = useState(false);
  const [isLoadingStats, setIsLoadingStats] = useState(false);
  const [isRetrying, setIsRetrying] = useState(false);
  const [retrySuccess, setRetrySuccess] = useState<string | null>(null);

  // Corrupted files management state
  const [previewFile, setPreviewFile] = useState<ColorDbErrorFile | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteSuccess, setDeleteSuccess] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');

  // 主色调提取任务状态
  const [isColorExtracting, setIsColorExtracting] = useState(false);
  const [isColorPaused, setIsColorPaused] = useState(false);
  const [colorExtractProgress, setColorExtractProgress] = useState<{
    current: number;
    total: number;
    estimatedTime?: number;
  } | null>(null);
  const colorExtractStartTimeRef = useRef<number>(0);
  const colorExtractLastUpdateRef = useRef<number>(0);
  const colorExtractLastProgressRef = useRef<number>(0);
  const androidColorExtractCancelledRef = useRef<boolean>(false);
  const staleCleanupDoneRef = useRef<boolean>(false);

  const [androidCacheSize, setAndroidCacheSize] = useState<number | null>(null);
  const [isDeletingCache, setIsDeletingCache] = useState(false);

  useEffect(() => {
    if (isAndroid && settings.paths.cacheRoot) {
      androidGetCacheSize(settings.paths.cacheRoot).then(setAndroidCacheSize);
    }
  }, [isAndroid, settings.paths.cacheRoot]);

  // 监听主色调提取进度事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen('color-extraction-progress', (event: any) => {
        const progress = event.payload as {
          batchId: number;
          current: number;
          total: number;
          pending: number;
          currentFile: string;
          batchCompleted: boolean;
          cancelled?: boolean;
          isPaused?: boolean;
        };

        if (progress.total === 0) return;

        if (isAndroidPlatformCached() && androidColorExtractCancelledRef.current) {
          if (progress.batchCompleted) {
            androidColorExtractCancelledRef.current = false;
            loadColorDbStats();
          }
          return;
        }

        setIsColorExtracting(true);

        if (progress.isPaused === true) {
          setIsColorPaused(true);
        } else if (progress.isPaused === false) {
          setIsColorPaused(false);
        }

        const now = Date.now();
        let estimatedTime: number | undefined = undefined;

        if (progress.current > 0 && colorExtractStartTimeRef.current > 0) {
          const elapsed = now - colorExtractStartTimeRef.current;
          const speed = progress.current / elapsed;
          const remaining = progress.total - progress.current;
          if (speed > 0 && remaining > 0) {
            estimatedTime = remaining / speed;
          }
        }

        setColorExtractProgress({
          current: progress.current,
          total: progress.total,
          estimatedTime
        });

        if (progress.batchCompleted) {
          setTimeout(() => {
            setIsColorExtracting(false);
            setIsColorPaused(false);
            setColorExtractProgress(null);
            colorExtractStartTimeRef.current = 0;
            loadColorDbStats();
          }, 500);
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  // 监听通知栏操作事件（暂停/恢复/取消），确保按钮状态即时同步
  useEffect(() => {
    let unlisten: (() => void) | null = null;

    const setupListener = async () => {
      unlisten = await listen('color-extraction-notification-action', (event: any) => {
        const { action } = event.payload as { action: string };

        if (action === 'pause') {
          setIsColorPaused(true);
          setIsColorExtracting(true);
        } else if (action === 'resume') {
          setIsColorPaused(false);
          setIsColorExtracting(true);
        } else if (action === 'cancel') {
          setIsColorExtracting(false);
          setIsColorPaused(false);
          setColorExtractProgress(null);
          colorExtractStartTimeRef.current = 0;
          androidColorExtractCancelledRef.current = true;
          loadColorDbStats();
        }
      });
    };

    setupListener();

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  const handleStartColorExtraction = useCallback(async () => {
    if (isColorPaused) {
      await resumeColorExtraction();
      setIsColorPaused(false);
      return;
    }

    if (isColorExtracting) {
      return;
    }

    const imagePaths = Object.values(state.files || {})
      .filter(f => f.type === FileType.IMAGE)
      .map(f => f.path);

    if (imagePaths.length === 0) {
      onShowToast?.(t('settings.noImagesToExtract') || '没有图片需要提取主色调');
      return;
    }

    colorExtractStartTimeRef.current = Date.now();
    androidColorExtractCancelledRef.current = false;
    setIsColorExtracting(true);
    setIsColorPaused(false);
    setColorExtractProgress({ current: 0, total: imagePaths.length });

    try {
      if (isAndroidPlatformCached()) {
        const cacheRoot = getGlobalCacheRoot() || '';
        if (!cacheRoot) {
          setIsColorExtracting(false);
          setColorExtractProgress(null);
          onShowToast?.(t('settings.colorExtractionStartFailed') || '启动主色调提取失败');
          return;
        }
        await androidBatchExtractColors(imagePaths, cacheRoot);
      } else {
        const addedCount = await addPendingFilesToDb(imagePaths);

        if (addedCount === 0 && colorDbStats && colorDbStats.pending === 0) {
          setIsColorExtracting(false);
          setColorExtractProgress(null);
          onShowToast?.(t('settings.colorExtractionNoPendingHint') || '当前目录所有图片的主色调已提取完成');
          return;
        }

        await resumeColorExtraction();
      }
    } catch (error) {
      console.error('Failed to start color extraction:', error);
      setIsColorExtracting(false);
      setIsColorPaused(false);
      setColorExtractProgress(null);
      onShowToast?.(t('settings.colorExtractionStartFailed') || '启动主色调提取失败');
    }
  }, [isColorExtracting, isColorPaused, state.files, colorDbStats, t, onShowToast]);

  const handlePauseColorExtraction = useCallback(async () => {
    if (!isColorExtracting || isColorPaused) return;
    await pauseColorExtraction();
    if (isAndroidPlatformCached()) {
      androidUpdateTaskNotification(0, 0, true);
    }
    setIsColorPaused(true);
  }, [isColorExtracting, isColorPaused]);

  const handleResumeColorExtraction = useCallback(async () => {
    if (!isColorPaused) return;
    await resumeColorExtraction();
    if (isAndroidPlatformCached()) {
      androidUpdateTaskNotification(0, 0, false);
    }
    setIsColorPaused(false);
  }, [isColorPaused]);

  const handleStopColorExtraction = useCallback(async () => {
    if (!isColorExtracting) return;
    if (isAndroidPlatformCached()) {
      await cancelColorExtraction();
      androidHideTaskNotification();
      androidColorExtractCancelledRef.current = true;
    } else {
      // 桌面端"停止"为彻底停止：终止 worker 并丢弃内存任务队列
      await shutdownColorExtraction();
    }
    setIsColorExtracting(false);
    setIsColorPaused(false);
    setColorExtractProgress(null);
    colorExtractStartTimeRef.current = 0;
  }, [isColorExtracting]);

  // 加载主色调数据库统计信息
  const loadColorDbStats = async () => {
    setIsLoadingStats(true);
    try {
      // 首次打开存储面板时先清理一次残留记录（磁盘上已不存在的文件），
      // 使统计反映当前目录真实文件数；清理成功后再读取最新数据
      if (!staleCleanupDoneRef.current) {
        staleCleanupDoneRef.current = true;
        await cleanupStaleColorRecords();
      }
      const stats = await getColorDbStats();
      if (stats) {
        setColorDbStats(stats);
      }
    } catch (error) {
      console.error('Failed to load color db stats:', error);
    } finally {
      setIsLoadingStats(false);
    }
  };

  // 加载错误文件列表
  const loadErrorFiles = async () => {
    try {
      const files = await getColorDbErrorFiles();
      setErrorFiles(files);
    } catch (error) {
      console.error('Failed to load error files:', error);
    }
  };

  // 重新处理错误文件
  const handleRetryErrors = async (specificFiles?: string[]) => {
    setIsRetrying(true);
    setRetrySuccess(null);
    try {
      const count = await retryColorExtraction(specificFiles);
      if (count > 0) {
        setRetrySuccess(t('settings.colorDbRetrySuccess').replace('{count}', count.toString()));
        setTimeout(() => setRetrySuccess(null), 3000);

        if (isAndroidPlatformCached() && specificFiles && specificFiles.length > 0) {
          const cacheRoot = getGlobalCacheRoot() || '';
          if (cacheRoot) {
            await androidBatchExtractColors(specificFiles, cacheRoot);
          }
        }

        // 轮询检查处理状态，直到所有文件处理完成
        const checkProcessingStatus = async () => {
          const stats = await getColorDbStats();
          if (stats) {
            setColorDbStats(stats);
            // 如果还有 pending 或 processing 状态的文件，继续轮询
            if (stats.pending > 0 || stats.processing > 0) {
              setTimeout(checkProcessingStatus, 2000); // 每2秒检查一次
            } else {
              // 处理完成，刷新错误文件列表
              await loadErrorFiles();
              setIsRetrying(false);
            }
          }
        };

        // 开始轮询
        setTimeout(checkProcessingStatus, 1000); // 1秒后开始第一次检查
      } else {
        setIsRetrying(false);
      }
    } catch (error) {
      console.error('Failed to retry errors:', error);
      setIsRetrying(false);
    }
  };

  // 处理文件选择
  const toggleFileSelection = (path: string) => {
    const newSelected = new Set(selectedFiles);
    if (newSelected.has(path)) {
      newSelected.delete(path);
    } else {
      newSelected.add(path);
    }
    setSelectedFiles(newSelected);
  };

  // 全选/取消全选
  const toggleSelectAll = () => {
    if (selectedFiles.size === errorFiles.length) {
      setSelectedFiles(new Set());
    } else {
      setSelectedFiles(new Set(errorFiles.map(f => f.path)));
    }
  };

  // 删除选中的文件
  const handleDeleteSelected = async () => {
    if (selectedFiles.size === 0) return;

    const confirmed = window.confirm(t('settings.colorDbDeleteConfirm').replace('{count}', selectedFiles.size.toString()));
    if (!confirmed) return;

    setIsDeleting(true);
    setDeleteSuccess(null);
    try {
      const pathsToDelete = Array.from(selectedFiles);

      // 1. 删除物理文件
      let deletedCount = 0;
      for (const path of pathsToDelete) {
        try {
          await deleteFile(path);
          deletedCount++;
        } catch (e) {
          console.error(`Failed to delete file ${path}:`, e);
        }
      }

      // 2. 从数据库中删除记录
      await deleteColorDbErrorFiles(pathsToDelete);

      if (deletedCount > 0) {
        setDeleteSuccess(t('settings.colorDbDeleteSuccess').replace('{count}', deletedCount.toString()));
        // 刷新数据
        await loadColorDbStats();
        await loadErrorFiles();
        setSelectedFiles(new Set());
        setTimeout(() => setDeleteSuccess(null), 3000);
      }
    } catch (error) {
      console.error('Failed to delete files:', error);
    } finally {
      setIsDeleting(false);
    }
  };

  // 删除单个文件
  const handleDeleteSingle = async (file: ColorDbErrorFile) => {
    const confirmed = window.confirm(t('settings.colorDbDeleteSingleConfirm').replace('{name}', file.path.split(/[\\/]/).pop() || ''));
    if (!confirmed) return;

    setIsDeleting(true);
    try {
      // 1. 删除物理文件
      await deleteFile(file.path);

      // 2. 从数据库中删除记录
      await deleteColorDbErrorFiles([file.path]);

      // 3. 如果正在预览这个文件，关闭预览
      if (previewFile?.path === file.path) {
        setPreviewFile(null);
        setPreviewError(false);
      }

      // 4. 从选中列表中移除
      const newSelected = new Set(selectedFiles);
      newSelected.delete(file.path);
      setSelectedFiles(newSelected);

      // 刷新数据
      await loadColorDbStats();
      await loadErrorFiles();

      setDeleteSuccess(t('settings.colorDbDeleteSuccess').replace('{count}', '1'));
      setTimeout(() => setDeleteSuccess(null), 3000);
    } catch (error) {
      console.error('Failed to delete file:', error);
      alert(t('settings.colorDbDeleteFailed'));
    } finally {
      setIsDeleting(false);
    }
  };

  // 在文件管理器中打开
  const openInExplorer = (path: string) => {
    if (isAndroid && onNavigateToFile) {
      onClose();
      onNavigateToFile(path);
      return;
    }
    import('../../api/tauri-bridge').then(({ openPath }) => {
      openPath(path, true);
    });
  };

  // 打开预览并重置错误状态
  const openPreview = (file: ColorDbErrorFile) => {
    setPreviewFile(file);
    setPreviewError(false);
  };

  // 关闭预览
  const closePreview = () => {
    setPreviewFile(null);
    setPreviewError(false);
  };

  // 当切换到 storage 页面时加载统计信息
  useEffect(() => {
    loadColorDbStats();
  }, []);

  // 格式化文件大小
  const handleExportData = async () => {
    const simplifiedTopics: Record<string, any> = {};
    Object.values(state.topics || {}).forEach(topic => {
      simplifiedTopics[topic.id] = {
        id: topic.id,
        name: topic.name,
        parentId: topic.parentId,
        description: topic.description,
        type: topic.type,
        peopleIds: topic.peopleIds || [],
      };
    });

    const dataToExport = {
      tags: state.customTags,
      people: state.people,
      topics: simplifiedTopics
    };
    const jsonStr = JSON.stringify(dataToExport, null, 2);
    const fileName = `aurora_metadata_backup_${new Date().toISOString().split('T')[0]}.json`;

    if (isAndroid) {
      try {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(jsonStr);
        const downloadsDir = '/storage/emulated/0/Download';
        const filePath = `${downloadsDir}/${fileName}`;
        await writeFileFromBytes(filePath, new Uint8Array(bytes));
        onShowToast?.(`已导出到 ${filePath}`);
      } catch (error) {
        console.error('Failed to export data on Android:', error);
        try {
          const cacheRoot = settings.paths.cacheRoot;
          if (cacheRoot) {
            const encoder = new TextEncoder();
            const bytes = encoder.encode(jsonStr);
            const filePath = `${cacheRoot}/../${fileName}`;
            await writeFileFromBytes(filePath, new Uint8Array(bytes));
            onShowToast?.(`已导出到 ${filePath}`);
          }
        } catch (fallbackError) {
          console.error('Fallback export also failed:', fallbackError);
          onShowToast?.(t('settings.exportError') || '导出失败');
        }
      }
    } else {
      const blob = new Blob([jsonStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const handleImportData = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const json = JSON.parse(event.target?.result as string);
        if (json.tags || json.people || json.topics) {
          const newTags = json.tags && Array.isArray(json.tags) ? json.tags : [];
          const newPeople = json.people && typeof json.people === 'object' ? json.people : {};
          const newTopics = json.topics && typeof json.topics === 'object' ? json.topics : {};

          const combinedTags = Array.from(new Set([...state.customTags, ...newTags]));
          const combinedPeople = { ...state.people, ...newPeople };

          // 对于专题，根据 ID 去重合并
          const combinedTopics = { ...state.topics };
          Object.keys(newTopics).forEach(id => {
            if (!combinedTopics[id]) {
              combinedTopics[id] = newTopics[id];
            }
          });

          onUpdateSettings({
            customTags: combinedTags,
            people: combinedPeople,
            topics: combinedTopics
          });
          alert(t('settings.importSuccess'));
        } else {
          throw new Error('Invalid format');
        }
      } catch (err) {
        console.error(err);
        alert(t('settings.importError'));
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  return (
    <>
    <div className="space-y-8 animate-fade-in">
      <section>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 border-subtle pb-2 flex items-center"><Database size={20} className="mr-2 text-blue-500" /> {t('settings.catStorage')}</h3>
        <div className="space-y-4">
          {!isAndroid && (
          <div>
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.resourceRoot')}</label>
            <div className="flex items-center">
              <div className="flex-1 bg-[#e5e7eb] dark:bg-[#404040] rounded-l px-3 py-2 text-sm text-gray-600 dark:text-gray-300 truncate font-mono">
                {settings.paths.resourceRoot}
              </div>
              <button
                onClick={() => onUpdatePath('resource')}
                className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-medium rounded-r"
              >
                {t('settings.change')}
              </button>
            </div>
          </div>
          )}
          <div>
            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{isAndroid ? t('settings.cacheRootAndroid') : t('settings.cacheRoot')}</label>
            <div className="flex items-center">
              <div className="flex-1 bg-[#e5e7eb] dark:bg-[#404040] rounded-l px-3 py-2 text-sm text-gray-600 dark:text-gray-300 truncate font-mono">
                {isAndroid
                  ? (settings.paths.cacheRoot || t('settings.notSet'))
                  : (settings.paths.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : t('settings.notSet'))
                }
              </div>
              {isAndroid ? (
                <button
                  onClick={async () => {
                    if (!settings.paths.cacheRoot) return;
                    if (!confirm(t('settings.deleteCacheConfirm'))) return;
                    setIsDeletingCache(true);
                    try {
                      const freed = await androidClearThumbnailCache(settings.paths.cacheRoot);
                      if (freed >= 0) {
                        getGlobalCache().clear();
                        getThumbnailPathCache().clear();
                        setAndroidCacheSize(0);
                        onRefresh?.();
                        onShowToast?.(t('settings.cacheDeleted'));
                      } else {
                        onShowToast?.(t('settings.cacheDeleteFailed'));
                      }
                    } catch {
                      onShowToast?.(t('settings.cacheDeleteFailed'));
                    } finally {
                      setIsDeletingCache(false);
                    }
                  }}
                  disabled={isDeletingCache || !settings.paths.cacheRoot}
                  className="bg-red-600 hover:bg-red-500 disabled:bg-red-400 text-white px-4 py-2 text-sm font-medium rounded-r border border-l-0 border-red-600"
                >
                  {isDeletingCache ? '...' : t('settings.deleteCache')}
                </button>
              ) : (
                <button
                  onClick={() => {
                    const cachePath = settings.paths.resourceRoot ? `${settings.paths.resourceRoot}${settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : '';
                    if (cachePath) {
                      import('../../api/tauri-bridge').then(({ openPath }) => {
                        openPath(cachePath);
                      });
                    }
                  }}
                  disabled={!settings.paths.resourceRoot}
                  className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-medium rounded-r border border-l-0 border-blue-600"
                >
                  打开
                </button>
              )}
            </div>
            {isAndroid && (
              <div className="mt-2 text-xs text-gray-500 dark:text-gray-400">
                {t('settings.cacheSize')}：{androidCacheSize !== null ? formatFileSize(androidCacheSize) : '...'}
              </div>
            )}
          </div>
        </div>
      </section>

      <section className="mt-10 pt-2">
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><Download size={20} className="mr-2 text-blue-500" /> {t('settings.dataBackup')}</h3>
        <div className="flex space-x-4">
          <button
            onClick={handleExportData}
            className="flex items-center px-4 py-2 bg-surface hover:bg-surface/70 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-subtle"
          >
            <Download size={16} className="mr-2" />
            {t('settings.exportTags')}
          </button>
          <div className="relative">
            <input
              type="file"
              id="import-file"
              name="import-file"
              accept=".json"
              onChange={handleImportData}
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
            <button
              className="flex items-center px-4 py-2 bg-surface hover:bg-surface/70 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-subtle pointer-events-none"
            >
              <Upload size={16} className="mr-2" />
              {t('settings.importTags')}
            </button>
          </div>
        </div>
      </section>

      {/* 主色调数据库管理 */}
      <section className="mt-10 pt-2">
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center justify-between">
          <div className="flex items-center">
            <Palette size={20} className="mr-2 text-purple-500" />
            {t('settings.colorDbTitle')}
          </div>
          <button
            onClick={async () => {
              setIsLoadingStats(true);
              const startTime = Date.now();
              await loadErrorFiles();
              await loadColorDbStats();
              setIsLoadingStats(true);
              const elapsed = Date.now() - startTime;
              if (elapsed < 600) {
                await new Promise(r => setTimeout(r, 600 - elapsed));
              }
              setIsLoadingStats(false);
            }}
            disabled={isLoadingStats}
            className="text-sm flex items-center px-3 py-1 bg-surface hover:bg-surface/70 rounded-full transition-colors text-gray-700 dark:text-gray-200"
          >
            <RefreshCw size={14} className={`mr-1 ${isLoadingStats ? 'animate-spin' : ''}`} />
            {t('settings.refresh')}
          </button>
        </h3>

        {colorDbStats && (
          <div className="space-y-4">
            {/* 统计卡片 */}
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-surface rounded-lg p-3 border border-subtle">
                <div className="text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbTotalRecords')}</div>
                <div className="text-xl font-bold text-gray-800 dark:text-white">{colorDbStats.total.toLocaleString()}</div>
              </div>
              <div className="bg-surface rounded-lg p-3 border border-subtle">
                <div className="text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbFileSize')}</div>
                <div className="text-xl font-bold text-gray-800 dark:text-white">{formatFileSize(colorDbStats.dbSize + colorDbStats.walSize)}</div>
              </div>
            </div>

            {/* 状态分布 */}
            <div className="bg-surface rounded-lg p-4 border border-subtle">
              <div className="flex justify-between items-center mb-3">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.colorDbStatusDistribution')}</span>
              </div>
              <div className="space-y-2">
                {/* 已提取 */}
                <div className="flex items-center">
                  <div className="w-20 text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbExtracted')}</div>
                  <div className="flex-1 mx-2">
                    <div className="h-2 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-green-500 rounded-full"
                        style={{ width: `${colorDbStats.total > 0 ? (colorDbStats.extracted / colorDbStats.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-16 text-right text-sm font-medium text-gray-700 dark:text-gray-300">
                    {colorDbStats.extracted.toLocaleString()}
                  </div>
                </div>

                {/* 待处理 */}
                <div className="flex items-center">
                  <div className="w-20 text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbPending')}</div>
                  <div className="flex-1 mx-2">
                    <div className="h-2 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-blue-500 rounded-full"
                        style={{ width: `${colorDbStats.total > 0 ? (colorDbStats.pending / colorDbStats.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-16 text-right text-sm font-medium text-gray-700 dark:text-gray-300">
                    {colorDbStats.pending.toLocaleString()}
                  </div>
                </div>

                {/* 处理中 */}
                {colorDbStats.processing > 0 && (
                  <div className="flex items-center">
                    <div className="w-20 text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbProcessing')}</div>
                    <div className="flex-1 mx-2">
                      <div className="h-2 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-yellow-500 rounded-full"
                          style={{ width: `${colorDbStats.total > 0 ? (colorDbStats.processing / colorDbStats.total) * 100 : 0}%` }}
                        />
                      </div>
                    </div>
                    <div className="w-16 text-right text-sm font-medium text-gray-700 dark:text-gray-300">
                      {colorDbStats.processing.toLocaleString()}
                    </div>
                  </div>
                )}

                {/* 错误 */}
                <div className="flex items-center">
                  <div className="w-20 text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbErrors')}</div>
                  <div className="flex-1 mx-2">
                    <div className="h-2 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-red-500 rounded-full"
                        style={{ width: `${colorDbStats.total > 0 ? (colorDbStats.error / colorDbStats.total) * 100 : 0}%` }}
                      />
                    </div>
                  </div>
                  <div className="w-16 text-right text-sm font-medium text-gray-700 dark:text-gray-300">
                    {colorDbStats.error.toLocaleString()}
                  </div>
                </div>
              </div>
            </div>

            {/* 主色调提取任务控制 */}
            <div className="bg-surface rounded-lg p-4 border border-subtle">
              <div className="flex items-center justify-between mb-3">
                <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.colorExtractionTask')}</span>
                <div className="flex items-center space-x-2">
                  {isColorExtracting && !isColorPaused && (
                    <button
                      onClick={handlePauseColorExtraction}
                      className="text-sm flex items-center px-3 py-1.5 bg-yellow-100 dark:bg-yellow-800 hover:bg-yellow-200 dark:hover:bg-yellow-700 text-yellow-700 dark:text-yellow-300 rounded-lg transition-colors"
                    >
                      <Pause size={14} className="mr-1" />
                      {t('settings.pauseColorExtraction')}
                    </button>
                  )}
                  {isColorPaused && (
                    <button
                      onClick={handleResumeColorExtraction}
                      className="text-sm flex items-center px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors"
                    >
                      <Play size={14} className="mr-1" />
                      {t('settings.resumeColorExtraction')}
                    </button>
                  )}
                  {isColorExtracting && (
                    <button
                      onClick={handleStopColorExtraction}
                      className="text-sm flex items-center px-3 py-1.5 bg-red-100 dark:bg-red-800 hover:bg-red-200 dark:hover:bg-red-700 text-red-700 dark:text-red-300 rounded-lg transition-colors"
                    >
                      <Square size={14} className="mr-1" />
                      {t('settings.stopColorExtraction')}
                    </button>
                  )}
                  {!isColorExtracting && (
                    <button
                      onClick={handleStartColorExtraction}
                      disabled={!colorExtractProgress && Object.values(state.files || {}).filter(f => f.type === FileType.IMAGE).length === 0}
                      className="text-sm flex items-center px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      style={isAndroid ? { height: '55px' } : undefined}
                    >
                      <Play size={14} className="mr-1" />
                      {t('settings.startColorExtraction')}
                    </button>
                  )}
                </div>
              </div>

              {/* 进度显示 */}
              {isColorExtracting && colorExtractProgress && (
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-600 dark:text-gray-400">{t('settings.colorExtracting')}</span>
                    <span className="text-xs text-gray-600 dark:text-gray-400">
                      {Math.round((colorExtractProgress.current / Math.max(colorExtractProgress.total, 1)) * 100)}%
                    </span>
                  </div>
                  <div className="text-xs text-gray-500 dark:text-gray-500">
                    {colorExtractProgress.current} / {colorExtractProgress.total}
                  </div>
                  {colorExtractProgress.estimatedTime && colorExtractProgress.estimatedTime > 0 && (
                    <div className="text-xs text-gray-500 dark:text-gray-500">
                      {t('settings.estimatedTimeRemaining')}: {formatEstimatedTimeMs(colorExtractProgress.estimatedTime)}
                    </div>
                  )}
                  <div className="w-full bg-black/10 dark:bg-white/10 h-2 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${isColorPaused ? 'bg-yellow-500' : 'bg-blue-500'}`}
                      style={{ width: `${(colorExtractProgress.current / Math.max(colorExtractProgress.total, 1)) * 100}%` }}
                    />
                  </div>
                </div>
              )}

              {/* 提示信息 */}
              {!isColorExtracting && (() => {
                // 计算当前目录的图片总数
                const totalImagesInDir = Object.values(state.files || {}).filter(f => f.type === FileType.IMAGE).length;
                const extractedCount = colorDbStats?.extracted || 0;
                const pendingCount = colorDbStats?.pending || 0;

                // 判断是否还有未处理的图片
                // 如果目录图片数 > 已提取数 + 待处理数，说明有图片还没加入数据库
                const untrackedCount = Math.max(0, totalImagesInDir - extractedCount - pendingCount);

                let hintText = '';
                if (pendingCount > 0) {
                  hintText = t('settings.colorExtractionPendingHint').replace('{count}', pendingCount.toString());
                } else if (untrackedCount > 0) {
                  // 有图片还没加入数据库（新目录或部分图片未处理）
                  hintText = t('settings.colorExtractionUntrackedHint').replace('{count}', untrackedCount.toString()) || `有 ${untrackedCount} 个图片待提取主色调`;
                } else if (extractedCount > 0) {
                  hintText = t('settings.colorExtractionNoPendingHint');
                } else {
                  hintText = t('settings.colorExtractionNewDirectoryHint') || '点击按钮开始提取当前目录图片的主色调';
                }

                return <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">{hintText}</div>;
              })()}
            </div>

            {/* 错误文件管理 */}
            {colorDbStats.error > 0 && (
              <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4">
                <div className="flex items-center justify-between mb-3">
                  <div className="flex items-center">
                    <AlertCircle size={18} className="text-red-500 mr-2" />
                    <span className="text-sm font-medium text-red-700 dark:text-red-400">
                      {t('settings.colorDbHasErrors').replace('{count}', colorDbStats.error.toString())}
                    </span>
                  </div>
                  <div className="flex items-center space-x-2">
                    <button
                      onClick={() => handleRetryErrors()}
                      disabled={isRetrying}
                      className="text-sm flex items-center px-3 py-1.5 bg-red-100 dark:bg-red-800 hover:bg-red-200 dark:hover:bg-red-700 text-red-700 dark:text-red-300 rounded-lg transition-colors"
                    >
                      <RefreshCw size={14} className={`mr-1 ${isRetrying ? 'animate-spin' : ''}`} />
                      {t('settings.colorDbRetryAll')}
                    </button>
                    <button
                      onClick={() => {
                        setShowErrorFiles(!showErrorFiles);
                        if (!showErrorFiles) loadErrorFiles();
                      }}
                      className="text-sm flex items-center px-3 py-1.5 bg-surface hover:bg-surface/70 text-gray-700 dark:text-gray-300 rounded-lg transition-colors"
                    >
                      {showErrorFiles ? <ChevronUp size={14} className="mr-1" /> : <ChevronDown size={14} className="mr-1" />}
                      {showErrorFiles ? t('settings.hide') : t('settings.show')}
                    </button>
                  </div>
                </div>

                {retrySuccess && (
                  <div className="mb-3 p-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-sm rounded">
                    {retrySuccess}
                  </div>
                )}

                {deleteSuccess && (
                  <div className="mb-3 p-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 text-sm rounded">
                    {deleteSuccess}
                  </div>
                )}

                {/* 错误文件列表 */}
                {showErrorFiles && (
                  <div className="mt-3">
                    {/* 工具栏 */}
                    <div className="flex items-center justify-between mb-3 pb-3 border-b border-red-200 dark:border-red-800">
                      <div className="flex items-center space-x-2">
                        <label className="flex items-center text-sm text-gray-700 dark:text-gray-300 cursor-pointer">
                          <input
                            type="checkbox"
                            checked={selectedFiles.size === errorFiles.length && errorFiles.length > 0}
                            onChange={toggleSelectAll}
                            className={`mr-2 text-red-600 focus:ring-red-500 ${isAndroid ? 'rounded-full appearance-none w-5 h-5 border-2 border-gray-300 checked:bg-red-600 checked:border-red-600 relative after:content-[\'✓\'] after:absolute after:text-white after:text-xs after:top-0 after:left-0.5 after:opacity-0 checked:after:opacity-100' : 'rounded border-gray-300'}`}
                          />
                          {t('settings.selectAll')} ({selectedFiles.size}/{errorFiles.length})
                        </label>
                      </div>
                      <div className="flex items-center space-x-2">
                        {/* 视图切换 */}
                        <div className="flex items-center bg-surface rounded-lg p-0.5">
                          <button
                            onClick={() => setViewMode('list')}
                            className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-content shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}
                            style={isAndroid ? { width: '50px', height: '50px', display: 'flex', alignItems: 'center', justifyContent: 'center' } : undefined}
                            title={t('layout.list')}
                          >
                            <List size={isAndroid ? 20 : 14} />
                          </button>
                          <button
                            onClick={() => setViewMode('grid')}
                            className={`p-1.5 rounded ${viewMode === 'grid' ? 'bg-content shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}
                            style={isAndroid ? { width: '50px', height: '50px', display: 'flex', alignItems: 'center', justifyContent: 'center' } : undefined}
                            title={t('layout.grid')}
                          >
                            <Grid size={isAndroid ? 20 : 14} />
                          </button>
                        </div>
                        {/* 删除选中按钮 */}
                        {selectedFiles.size > 0 && (
                          <button
                            onClick={handleDeleteSelected}
                            disabled={isDeleting}
                            className="text-sm flex items-center px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
                          >
                            <Trash size={14} className="mr-1" />
                            {t('settings.deleteSelected')} ({selectedFiles.size})
                          </button>
                        )}
                      </div>
                    </div>

                    {/* 文件列表 */}
                    {errorFiles.length === 0 ? (
                      <div className="text-sm text-gray-500 dark:text-gray-400 text-center py-4">
                        {t('settings.loading')}
                      </div>
                    ) : viewMode === 'grid' ? (
                      /* 网格视图 */
                      <div className="grid grid-cols-4 gap-3 max-h-96 overflow-y-auto p-1">
                        {errorFiles.map((file, index) => (
                          <div
                            key={index}
                            className={`relative group rounded-lg border-2 overflow-hidden cursor-pointer transition-all ${selectedFiles.has(file.path)
                              ? 'border-red-500 ring-2 ring-red-500/20'
                              : 'border-subtle hover:border-red-300'
                              }`}
                            onClick={() => toggleFileSelection(file.path)}
                          >
                            {/* 缩略图 */}
                            <div className="aspect-square bg-surface flex items-center justify-center relative">
                              <img
                                src={getAssetUrl(file.path)}
                                alt=""
                                className="w-full h-full object-cover absolute inset-0"
                                onError={(e) => {
                                  (e.target as HTMLImageElement).style.display = 'none';
                                }}
                              />
                              <Image size={24} className="text-gray-400 relative z-10" />
                            </div>

                            {/* 复选框 */}
                            <div className="absolute top-2 left-2 z-20">
                              <input
                                type="checkbox"
                                checked={selectedFiles.has(file.path)}
                                onChange={(e) => {
                                  e.stopPropagation();
                                  toggleFileSelection(file.path);
                                }}
                                className={`text-red-600 focus:ring-red-500 ${isAndroid ? 'rounded-full appearance-none w-5 h-5 border-2 border-gray-300 checked:bg-red-600 checked:border-red-600 relative after:content-[\'✓\'] after:absolute after:text-white after:text-xs after:top-0 after:left-0.5 after:opacity-0 checked:after:opacity-100' : 'rounded border-gray-300'}`}
                              />
                            </div>

                            {/* 操作按钮 */}
                            {!isAndroid && (
                              <div className="absolute top-2 right-2 flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openPreview(file);
                                  }}
                                  className="p-1.5 bg-surface rounded shadow-sm hover:bg-surface"
                                  title={t('settings.preview')}
                                >
                                  <Eye size={12} className="text-gray-600 dark:text-gray-400" />
                                </button>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    openInExplorer(file.path);
                                  }}
                                  className="p-1.5 bg-surface rounded shadow-sm hover:bg-surface"
                                  title={t('context.openFolder')}
                                >
                                  <FolderOpen size={12} className="text-gray-600 dark:text-gray-400" />
                                </button>
                              </div>
                            )}

                            {/* 文件名 */}
                            <div className="p-2 bg-surface">
                              <div className="text-xs text-gray-600 dark:text-gray-300 truncate" title={file.path}>
                                {file.path.split(/[\\/]/).pop()}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : (
                      /* 列表视图 */
                      <div className="max-h-60 overflow-y-auto space-y-2">
                        {errorFiles.map((file, index) => (
                          <div key={index} className="flex items-center p-2 bg-surface rounded border border-red-100 dark:border-red-800 hover:bg-surface transition-colors">
                            <input
                              type="checkbox"
                              checked={selectedFiles.has(file.path)}
                              onChange={() => toggleFileSelection(file.path)}
                              className={`mr-3 text-red-600 focus:ring-red-500 ${isAndroid ? 'rounded-full appearance-none w-5 h-5 border-2 border-gray-300 checked:bg-red-600 checked:border-red-600 relative after:content-[\'✓\'] after:absolute after:text-white after:text-xs after:top-0 after:left-0.5 after:opacity-0 checked:after:opacity-100' : 'rounded border-gray-300'}`}
                            />
                            <div className="flex-1 min-w-0 mr-2">
                              <div className="text-xs text-gray-600 dark:text-gray-300 truncate" title={file.path}>
                                {file.path.split(/[\\/]/).pop()}
                              </div>
                              <div className="text-xs text-gray-400">
                                {new Date(file.timestamp * 1000).toLocaleString()}
                              </div>
                            </div>
                            <div className="flex items-center space-x-1">
                              <button
                                onClick={() => openPreview(file)}
                                className="p-1.5 text-gray-600 dark:text-gray-400 hover:bg-surface rounded transition-colors"
                                style={isAndroid ? { width: '45px', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center' } : undefined}
                                title={t('settings.preview')}
                              >
                                <Eye size={isAndroid ? 18 : 14} />
                              </button>
                              <button
                                onClick={() => openInExplorer(file.path)}
                                className="p-1.5 text-gray-600 dark:text-gray-400 hover:bg-surface rounded transition-colors"
                                style={isAndroid ? { width: '45px', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center' } : undefined}
                                title={t('context.openFolder')}
                              >
                                <FolderOpen size={isAndroid ? 18 : 14} />
                              </button>
                              <button
                                onClick={() => handleRetryErrors([file.path])}
                                disabled={isRetrying}
                                className="p-1.5 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded transition-colors"
                                style={isAndroid ? { width: '45px', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center' } : undefined}
                                title={t('settings.colorDbRetrySingle')}
                              >
                                <Play size={isAndroid ? 18 : 14} />
                              </button>
                              <button
                                onClick={() => handleDeleteSingle(file)}
                                disabled={isDeleting}
                                className="p-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors"
                                style={isAndroid ? { width: '45px', height: '45px', display: 'flex', alignItems: 'center', justifyContent: 'center' } : undefined}
                                title={t('context.delete')}
                              >
                                <Trash size={isAndroid ? 18 : 14} />
                              </button>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {colorDbStats.error === 0 && colorDbStats.total > 0 && (
              <div className={`rounded-lg p-4 border flex items-center ${isRetrying ? 'bg-yellow-50 dark:bg-yellow-900/20 border-yellow-200 dark:border-yellow-800' : 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'}`}>
                {isRetrying ? (
                  <>
                    <RefreshCw size={18} className="text-yellow-500 mr-2 animate-spin" />
                    <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                      {t('settings.colorDbRetrying')}
                    </span>
                  </>
                ) : (
                  <>
                    <Check size={18} className="text-green-500 mr-2" />
                    <span className="text-sm font-medium text-green-700 dark:text-green-400">
                      {t('settings.colorDbAllGood')}
                    </span>
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {!colorDbStats && !isLoadingStats && (
          <div className="text-center py-8 text-gray-500 dark:text-gray-400">
            <Database size={32} className="mx-auto mb-2 opacity-50" />
            <p className="text-sm">{t('settings.colorDbNoData')}</p>
          </div>
        )}
      </section>
    </div>

    {/* 图片预览模态框 - 使用 Portal 渲染到 body，脱离设置弹窗的限制 */}
    {previewFile && createPortal(
      <div
        className="fixed inset-0 z-[500] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm"
        onClick={closePreview}
      >
        <div
          className="bg-content rounded-xl max-w-4xl max-h-[90vh] w-full overflow-hidden shadow-2xl"
          onClick={e => e.stopPropagation()}
        >
          {/* 标题栏 */}
          <div className="flex items-center justify-between p-4 border-b border-subtle">
            <div className="flex-1 min-w-0 mr-4">
              <h4 className="text-sm font-medium text-gray-800 dark:text-white truncate">
                {previewFile.path.split(/[\\/]/).pop()}
              </h4>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {new Date(previewFile.timestamp * 1000).toLocaleString()}
              </p>
            </div>
            <div className="flex items-center space-x-2">
              <button
                onClick={() => openInExplorer(previewFile.path)}
                className="p-2 text-gray-600 dark:text-gray-400 hover:bg-surface rounded-lg transition-colors"
                title={t('context.openFolder')}
              >
                <FolderOpen size={18} />
              </button>
              <button
                onClick={() => handleDeleteSingle(previewFile)}
                disabled={isDeleting}
                className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                title={t('context.delete')}
              >
                <Trash size={18} />
              </button>
              <button
                onClick={closePreview}
                className="p-2 text-gray-600 dark:text-gray-400 hover:bg-surface rounded-lg transition-colors"
              >
                <X size={18} />
              </button>
            </div>
          </div>

          {/* 图片预览区域 */}
          <div className="p-4 bg-panel flex items-center justify-center" style={{ minHeight: '300px', maxHeight: '60vh' }}>
            {!previewError ? (
              <img
                src={getAssetUrl(previewFile.path)}
                alt=""
                className="max-w-full max-h-[50vh] object-contain rounded-lg shadow-lg"
                onError={() => {
                  setPreviewError(true);
                }}
              />
            ) : (
              <div className="text-center">
                <Image size={48} className="mx-auto mb-3 text-gray-400 dark:text-gray-600" />
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t('settings.previewError')}
                </p>
              </div>
            )}
          </div>

          {/* 底部信息 */}
          <div className="p-4 border-t border-subtle bg-surface">
            <p className="text-xs text-gray-500 dark:text-gray-400 break-all">
              {t('settings.filePath')}: {previewFile.path}
            </p>
          </div>
        </div>
      </div>,
      document.body
    )}
  </>
  );
};

export default StoragePanel;
