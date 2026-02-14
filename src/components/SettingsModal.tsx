import React, { useState, useEffect, useRef } from 'react';
import { Settings, Sliders, Palette, Database, Globe, Check, Sun, Moon, Monitor, WifiOff, Download, Upload, Brain, Activity, Zap, Server, ChevronRight, XCircle, LogOut, HelpCircle, Languages, BarChart2, RefreshCw, FileText, MemoryStick, Timer, Save, PlusCircle, Trash2, LayoutGrid, List, Grid, LayoutTemplate, ArrowUp, ArrowDown, Type, Calendar, HardDrive, Layers, AlertCircle, ChevronDown, ChevronUp, Play, Image, Eye, Trash, FolderOpen, X, Info, Github, ExternalLink, RefreshCw as RefreshCwIcon, Heart, Code2, Shield, FileCode } from 'lucide-react';
import { AppState, SettingsCategory, AppSettings, LayoutMode, SortOption, SortDirection, GroupByOption, UpdateInfo, DownloadProgress, AI_SERVICE_PRESETS, AIServicePreset, AIModelOption } from '../types';
import { AuroraLogo } from './Logo';
import { performanceMonitor, PerformanceMetric } from '../utils/performanceMonitor';
import { aiService } from '../services/aiService';
import { getColorDbStats, getColorDbErrorFiles, retryColorExtraction, deleteColorDbErrorFiles, ColorDbStats, ColorDbErrorFile, getAssetUrl, deleteFile, openExternalLink } from '../api/tauri-bridge';

// 关于面板组件
interface AboutPanelProps {
  t: (key: string) => string;
  onCheckUpdate: () => void;
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  downloadProgress?: DownloadProgress | null;
  onInstallUpdate?: () => void;
  onOpenDownloadFolder?: () => void;
}

const AboutPanel: React.FC<AboutPanelProps> = ({ t, onCheckUpdate, updateInfo, isChecking, downloadProgress, onInstallUpdate, onOpenDownloadFolder }) => {
  const appVersion = '1.0.0';
  const tauriVersion = '2.0';
  const reactVersion = '18.2.0';

  const handleOpenLink = (url: string) => {
    openExternalLink(url);
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* 软件信息卡片 */}
      <section>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 border-b border-gray-100 dark:border-gray-800 pb-2 flex items-center">
          <Info size={20} className="mr-2 text-blue-500"/>
          {t('settings.catAbout')}
        </h3>
        
        <div className="bg-gradient-to-br from-blue-500/10 to-purple-500/10 rounded-2xl p-8 border border-white/10">
          <div className="flex items-center gap-6">
            <AuroraLogo size={115} className="rounded-2xl"/>
            <div>
              <h2 className="text-2xl font-bold text-gray-800 dark:text-white mb-1">Aurora Gallery</h2>
              <p className="text-gray-500 dark:text-gray-400 text-sm mb-2">{t('settings.about.tagline')}</p>
              <div className="flex items-center gap-2">
                <span className="px-2.5 py-1 bg-blue-500/20 text-blue-400 text-xs font-medium rounded-full">
                  v{appVersion}
                </span>
                <span className="px-2.5 py-1 bg-green-500/20 text-green-600 dark:text-green-400 text-xs font-medium rounded-full">
                  {t('settings.about.stable')}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* 版本信息 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <Code2 size={16} className="mr-2"/>
          {t('settings.about.versions')}
        </h4>
        <div className="grid grid-cols-3 gap-4">
          <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">{t('settings.about.appVersion')}</div>
            <div className="text-lg font-semibold text-gray-800 dark:text-white">{appVersion}</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">Tauri</div>
            <div className="text-lg font-semibold text-gray-800 dark:text-white">{tauriVersion}</div>
          </div>
          <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
            <div className="text-xs text-gray-500 dark:text-gray-400 mb-1">React</div>
            <div className="text-lg font-semibold text-gray-800 dark:text-white">{reactVersion}</div>
          </div>
        </div>
      </section>

      {/* 检查更新 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <RefreshCwIcon size={16} className="mr-2"/>
          {t('settings.about.update')}
        </h4>
        <div className="bg-white dark:bg-gray-800 rounded-xl p-6 border border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-white mb-1">
                {t('settings.about.currentVersion')}: {appVersion}
                {/* 下载完成时显示新版本号 */}
                {downloadProgress?.state === 'completed' && (
                  <span className="ml-2 text-green-500">
                    → {updateInfo?.latestVersion || t('settings.about.newVersion')}
                  </span>
                )}
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {downloadProgress?.state === 'completed'
                  ? t('settings.about.downloadComplete')
                  : updateInfo?.hasUpdate
                    ? t('settings.about.newVersionAvailable').replace('{version}', updateInfo.latestVersion)
                    : t('settings.about.upToDate')
                }
              </div>
            </div>
            {/* 下载完成时显示安装按钮，否则显示检查更新按钮 */}
            {downloadProgress?.state === 'completed' ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={onInstallUpdate}
                  className="flex items-center gap-2 px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-lg text-sm font-medium transition-colors"
                >
                  <Check size={16}/>
                  {t('settings.about.installNow')}
                </button>
                <button
                  onClick={onOpenDownloadFolder}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/20 text-gray-700 dark:text-white/80 rounded-lg text-sm font-medium transition-colors"
                  title={t('settings.about.openFolder')}
                >
                  <FolderOpen size={16}/>
                </button>
              </div>
            ) : (
              <button
                onClick={onCheckUpdate}
                disabled={isChecking}
                className="flex items-center gap-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-blue-500/50 text-white rounded-lg text-sm font-medium transition-colors"
              >
                <RefreshCwIcon size={16} className={isChecking ? 'animate-spin' : ''}/>
                {isChecking ? t('settings.about.checking') : t('settings.about.checkUpdate')}
              </button>
            )}
          </div>

          {/* 有更新但未下载完成时显示更新信息 */}
          {updateInfo?.hasUpdate && downloadProgress?.state !== 'completed' && (
            <div className="mt-4 p-4 bg-blue-500/10 border border-blue-500/20 rounded-lg">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-blue-400 mb-1">
                    {t('settings.about.newVersion')}: {updateInfo.latestVersion}
                  </div>
                  {updateInfo?.publishedAt && (
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {t('settings.about.publishedAt')}: {new Date(updateInfo.publishedAt).toLocaleDateString()}
                    </div>
                  )}
                </div>
                {/* 根据下载状态显示不同按钮 */}
                {downloadProgress && downloadProgress.state !== 'idle' ? (
                  // 下载中/暂停/错误/准备中：显示查看下载进度按钮
                  <button
                    onClick={() => {
                      // 打开更新弹窗查看进度
                      window.dispatchEvent(new CustomEvent('open-update-modal'));
                    }}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors"
                  >
                    <Download size={14}/>
                    {downloadProgress.state === 'downloading'
                      ? t('settings.about.downloading')
                      : downloadProgress.state === 'paused'
                        ? t('settings.about.paused')
                        : downloadProgress.state === 'error'
                          ? t('settings.about.downloadFailed')
                          : t('settings.about.preparing')}
                  </button>
                ) : (
                  // 未开始下载：显示下载按钮
                  <button
                    onClick={() => handleOpenLink(updateInfo.downloadUrl)}
                    className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors"
                  >
                    <Download size={14}/>
                    {t('settings.about.download')}
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </section>

      {/* 链接 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <ExternalLink size={16} className="mr-2"/>
          {t('settings.about.links')}
        </h4>
        <div className="grid grid-cols-2 gap-3">
          <button
            onClick={() => handleOpenLink('https://github.com/misakimiku2/aurora-gallery-tauri')}
            className="flex items-center gap-3 p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/5 transition-all text-left"
          >
            <Github size={20} className="text-gray-600 dark:text-gray-400"/>
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-white">GitHub</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{t('settings.about.viewSource')}</div>
            </div>
          </button>
          <button
            onClick={() => handleOpenLink('https://github.com/misakimiku2/aurora-gallery-tauri/issues')}
            className="flex items-center gap-3 p-4 bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 hover:border-blue-500/50 hover:bg-blue-500/5 transition-all text-left"
          >
            <Shield size={20} className="text-gray-600 dark:text-gray-400"/>
            <div>
              <div className="text-sm font-medium text-gray-800 dark:text-white">{t('settings.about.issues')}</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">{t('settings.about.reportBug')}</div>
            </div>
          </button>
        </div>
      </section>

      {/* 致谢 */}
      <section>
        <div className="flex items-center justify-center gap-1 text-xs text-gray-500 dark:text-gray-400 pt-4 border-t border-gray-200 dark:border-gray-800">
          <span>{t('settings.about.madeWith')}</span>
          <Heart size={12} className="text-red-500 fill-red-500"/>
          <span>{t('settings.about.by')}</span>
          <span className="font-medium text-gray-700 dark:text-gray-300">MISAKIMIKU</span>
        </div>
      </section>
    </div>
  );
};

interface SettingsModalProps {
  state: AppState;
  onClose: () => void;
  onUpdateSettings: (updates: Partial<AppState>) => void;
  onUpdateSettingsData: (updates: Partial<AppSettings>) => void;
  onUpdatePath: (type: 'resource') => void;
  t: (key: string) => string;
  onUpdateAIConnectionStatus: (status: 'checking' | 'connected' | 'disconnected') => void;
  // About panel props
  updateInfo?: UpdateInfo | null;
  onCheckUpdate?: () => void;
  isCheckingUpdate?: boolean;
  downloadProgress?: DownloadProgress | null;
  onInstallUpdate?: () => void;
  onOpenDownloadFolder?: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ state, onClose, onUpdateSettings, onUpdateSettingsData, onUpdatePath, onUpdateAIConnectionStatus, t, updateInfo, onCheckUpdate, isCheckingUpdate, downloadProgress, onInstallUpdate, onOpenDownloadFolder }) => {
  // ... (keep existing state and checkConnection logic)
  const [isTesting, setIsTesting] = useState(false);
  const [testStatus, setTestStatus] = useState<'idle' | 'testing' | 'success' | 'failed'>('idle');
  // Use AI connection status from AppState instead of local state
  const connectionStatus = state.aiConnectionStatus;

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

  const [editingPresetName, setEditingPresetName] = useState('');

  useEffect(() => {
      const currentPreset = state.settings.ai.promptPresets?.find(p => p.id === state.settings.ai.currentPresetId);
      if (currentPreset) {
          setEditingPresetName(currentPreset.name);
      } else {
          setEditingPresetName(t('settings.newPresetName'));
      }
  }, [state.settings.ai.currentPresetId, state.settings.ai.promptPresets?.length]);

  const checkConnection = async (manual: boolean = false) => {
      if (manual) {
          setIsTesting(true);
          setTestStatus('testing');
      } else {
          onUpdateAIConnectionStatus('checking');
      }

      try {
          const res = await aiService.checkConnection(state.settings.ai);

          if (res.status === 'connected') {
              if (manual) setTestStatus('success');
              onUpdateAIConnectionStatus('connected');
          } else {
              if (manual) setTestStatus('failed');
              onUpdateAIConnectionStatus('disconnected');
          }

          if (state.settings.ai.provider === 'lmstudio' && res.result && res.result.data && Array.isArray(res.result.data) && res.result.data.length > 0) {
              const detectedModel = res.result.data[0].id;
              if (detectedModel !== state.settings.ai.lmstudio.model) {
                  onUpdateSettingsData({ ai: { ...state.settings.ai, lmstudio: { ...state.settings.ai.lmstudio, model: detectedModel } } });
              }
          }
      } catch (e) {
          console.error(e);
          if (manual) setTestStatus('failed');
          onUpdateAIConnectionStatus('disconnected');
      } finally {
          if (manual) setIsTesting(false);
      }
  };

  useEffect(() => {
      if (state.settingsCategory === 'ai') {
          const timer = setTimeout(() => {
              checkConnection(false);
          }, 500); 
          return () => clearTimeout(timer);
      }
  }, [state.settingsCategory, state.settings.ai.provider, state.settings.ai.openai.endpoint, state.settings.ai.ollama.endpoint, state.settings.ai.lmstudio.endpoint, state.settings.ai.openai.apiKey]);

  // 性能监控刷新状�?
  const [refreshKey, setRefreshKey] = useState(0);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // 动态模型列表状态
  const [dynamicModels, setDynamicModels] = useState<Record<string, AIModelOption[]>>({});
  const [isFetchingModels, setIsFetchingModels] = useState(false);
  const [fetchModelsError, setFetchModelsError] = useState<string | null>(null);
  const [lastFetchedPresetId, setLastFetchedPresetId] = useState<string | null>(null);

  // 加载缓存的模型列表
  useEffect(() => {
    const loadCachedModels = () => {
      const cached: Record<string, AIModelOption[]> = {};
      AI_SERVICE_PRESETS.forEach(preset => {
        if (preset.id !== 'custom') {
          const models = aiService.getCachedModels(preset.id);
          if (models && models.length > 0) {
            cached[preset.id] = models;
          }
        }
      });
      setDynamicModels(cached);
    };
    loadCachedModels();
  }, []);

  // 获取当前的刷新间隔（毫秒�?
  const refreshInterval = state.settings.performance?.refreshInterval || 5000;

  // 手动刷新性能数据
  const handleRefreshPerformance = () => {
    setRefreshKey(prev => prev + 1);
  };

  // 刷新模型列表
  const handleFetchModels = async () => {
    const presetId = state.settings.ai.onlineServicePreset;
    if (!presetId || presetId === 'custom') return;

    const preset = AI_SERVICE_PRESETS.find(p => p.id === presetId);
    if (!preset) return;

    // 如果没有 API Key，提示用户
    if (!state.settings.ai.openai.apiKey) {
      setFetchModelsError(t('settings.apiKeyRequired') || '请先输入 API Key');
      return;
    }

    setIsFetchingModels(true);
    setFetchModelsError(null);
    setLastFetchedPresetId(null);

    try {
      const { models, fromApi } = await aiService.fetchModels(
        presetId,
        state.settings.ai.openai.apiKey,
        presetId === 'custom' ? state.settings.ai.openai.endpoint : undefined
      );

      if (models.length > 0) {
        setDynamicModels(prev => ({
          ...prev,
          [presetId]: models
        }));
        // 只有真正从 API 获取成功才显示成功提示
        if (fromApi) {
          setLastFetchedPresetId(presetId);
        } else {
          setFetchModelsError(t('settings.fetchModelsFailed') || '获取模型列表失败，显示预设模型');
        }
      } else {
        setFetchModelsError(t('settings.fetchModelsEmpty') || '未获取到模型列表');
      }
    } catch (error) {
      console.error('Failed to fetch models:', error);
      setFetchModelsError(t('settings.fetchModelsFailed') || '获取模型列表失败');
    } finally {
      setIsFetchingModels(false);
    }
  };

  // 设置自动刷新定时�?
  useEffect(() => {
    // 只有在性能监控页面才启用自动刷�?
    if (state.settingsCategory === 'performance') {
      // 清除之前的定时器
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
      
      // 创建新的定时�?
      refreshTimerRef.current = setInterval(() => {
        setRefreshKey(prev => prev + 1);
      }, refreshInterval);
    }
    
    // 清理函数
    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [state.settingsCategory, refreshInterval]);

  // 加载主色调数据库统计信息
  const loadColorDbStats = async () => {
    setIsLoadingStats(true);
    try {
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
        // 3秒后清除成功消息
        setTimeout(() => setRetrySuccess(null), 3000);

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
        closePreview();
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
    import('../api/tauri-bridge').then(({ openPath }) => {
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
    if (state.settingsCategory === 'storage') {
      loadColorDbStats();
    }
  }, [state.settingsCategory]);

  // 组件挂载时，如果在 storage 页面，自动刷新统计信息
  useEffect(() => {
    if (state.settingsCategory === 'storage') {
      loadColorDbStats();
    }
  }, []);

  // 格式化文件大小
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const handleExportData = () => {
    // 过滤专题信息，只保留基本属性、子专题结构和人物关联，剔除文件关联
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
    const blob = new Blob([JSON.stringify(dataToExport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `aurora_metadata_backup_${new Date().toISOString().split('T')[0]}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
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
    <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-8 backdrop-blur-sm">
      <div className="bg-white dark:bg-gray-800 rounded-xl w-[900px] h-[calc(100vh-200px)] min-h-[400px] shadow-2xl border border-gray-100 dark:border-gray-700 flex overflow-hidden animate-zoom-in" onClick={e => e.stopPropagation()}>
          
          <div className="w-64 bg-gray-50 dark:bg-gray-900 border-r border-gray-200 dark:border-gray-800 flex flex-col">
              {/* ... (Sidebar buttons, same as before) ... */}
              <div className="p-6">
                 <h2 className="text-xl font-bold text-gray-800 dark:text-white flex items-center">
                     <Settings size={24} className="mr-2 text-blue-500"/> {t('settings.title')}
                 </h2>
              </div>
              <div className="flex-1 px-4 space-y-1">
                  <button
                    onClick={() => onUpdateSettings({ settingsCategory: 'general' })}
                    className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'general' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                  >
                    <Sliders size={18} className="mr-3"/> {t('settings.catGeneral')}
                  </button>
                  <button
                    onClick={() => onUpdateSettings({ settingsCategory: 'storage' })}
                    className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'storage' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                  >
                    <Database size={18} className="mr-3"/> {t('settings.catStorage')}
                  </button>
                  <button
                    onClick={() => onUpdateSettings({ settingsCategory: 'ai' })}
                    className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'ai' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                  >
                    <Brain size={18} className="mr-3"/> {t('settings.catAi')}
                  </button>
                  <button
                    onClick={() => onUpdateSettings({ settingsCategory: 'performance' })}
                    className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'performance' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                  >
                    <BarChart2 size={18} className="mr-3"/> {t('settings.catPerformance')}
                  </button>
                  <button
                    onClick={() => onUpdateSettings({ settingsCategory: 'about' })}
                    className={`w-full flex items-center px-4 py-3 rounded-lg text-sm font-medium transition-colors ${state.settingsCategory === 'about' ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                  >
                    <Info size={18} className="mr-3"/> {t('settings.catAbout')}
                  </button>
              </div>
              <div className="p-4 border-t border-gray-200 dark:border-gray-800">
                  <button 
                     onClick={onClose} 
                     className="w-full py-2 bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 rounded text-sm text-gray-800 dark:text-gray-200 transition-colors"
                  >
                     {t('viewer.done')}
                  </button>
              </div>
          </div>

          <div className="flex-1 overflow-y-auto p-8">
              {state.settingsCategory === 'general' && (
                 /* ... General Settings Content ... */
                 <div className="space-y-8 animate-fade-in">
                     <section>
                         <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 border-b border-gray-100 dark:border-gray-800 pb-2">{t('settings.catGeneral')}</h3>
                         <div className="space-y-6">
                             <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.language')}</label>
                                <div className="flex space-x-3">
                                    {['zh', 'en'].map(lang => (
                                        <button
                                            key={lang}
                                            onClick={() => onUpdateSettingsData({ language: lang as any })}
                                            className={`px-4 py-2 rounded border text-sm flex items-center ${state.settings.language === lang ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'border-gray-200 dark:border-gray-800'}`}
                                        >
                                            <Globe size={14} className="mr-2"/>
                                            {lang === 'zh' ? '中文' : 'English'}
                                        </button>
                                    ))}
                                </div>
                             </div>
                             
                             <div className="bg-gray-50 dark:bg-gray-700/30 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
                                 <div className="flex items-center justify-between mb-3">
                                     <div>
                                        <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.autoStart')}</div>
                                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.autoStartDesc')}</div>
                                     </div>
                                     <button 
                                        onClick={() => {
                                        const newValue = !state.settings.autoStart;
                                        onUpdateSettingsData({ autoStart: newValue });
                                    }}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${state.settings.autoStart ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                      >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${state.settings.autoStart ? 'translate-x-6' : 'translate-x-1'}`} />
                                      </button>
                                 </div>
                                 
                                 <div className="flex items-center justify-between mb-3 pt-3 border-t border-gray-200 dark:border-gray-700">
                                     <div>
                                        <div className="font-bold text-gray-800 dark:text-gray-200">{t('settings.animateOnHover')}</div>
                                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{t('settings.animateOnHoverDesc')}</div>
                                     </div>
                                     <button 
                                        onClick={() => {
                                            const newValue = !state.settings.animateOnHover;
                                            onUpdateSettingsData({ animateOnHover: newValue });
                                        }}
                                        className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${state.settings.animateOnHover ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                      >
                                        <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${state.settings.animateOnHover ? 'translate-x-6' : 'translate-x-1'}`} />
                                      </button>
                                 </div>
                                 
                                 <div className="pt-3 border-t border-gray-200 dark:border-gray-700">
                                     <div className="flex items-center justify-between">
                                         <span className="font-bold text-gray-800 dark:text-gray-200">{t('settings.exitAction')}</span>
                                         <select 
                                            value={state.settings.exitAction || 'ask'} 
                                            onChange={(e) => onUpdateSettingsData({ exitAction: e.target.value as any })}
                                            className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-sm outline-none text-gray-800 dark:text-gray-200"
                                         >
                                             <option value="ask">{t('settings.exitActionAsk')}</option>
                                             <option value="minimize">{t('settings.exitActionMinimize')}</option>
                                             <option value="exit">{t('settings.exitActionExit')}</option>
                                         </select>
                                     </div>
                                 </div>
                             </div>
                         </div>
                     </section>

                     <section className="mt-8 border-t border-gray-100 dark:border-gray-800 pt-6">
                         <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><Palette size={20} className="mr-2 text-blue-500"/> {t('settings.catAppearance')}</h3>
                         <div>
                            <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-4">{t('settings.theme')}</label>
                            <div className="grid grid-cols-3 gap-4">
                                {['light', 'dark', 'system'].map(mode => (
                                    <button
                                        key={mode}
                                        onClick={() => onUpdateSettingsData({ theme: mode as any })}
                                        className={`relative rounded-lg border-2 p-1 overflow-hidden group ${state.settings.theme === mode ? 'border-blue-500' : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'}`}
                                    >
                                        <div className={`h-24 rounded flex items-center justify-center mb-2 ${mode === 'light' ? 'bg-white border border-gray-200' : mode === 'dark' ? 'bg-gray-900 border border-gray-700' : 'bg-gradient-to-br from-gray-200 to-gray-800'}`}>
                                             {mode === 'light' && <Sun size={24} className="text-gray-400"/>}
                                             {mode === 'dark' && <Moon size={24} className="text-gray-500"/>}
                                             {mode === 'system' && <Monitor size={24} className="text-gray-300"/>}
                                        </div>
                                        <div className="text-center text-xs font-medium text-gray-600 dark:text-gray-400 py-1">
                                            {mode === 'light' ? t('settings.themeLight') : mode === 'dark' ? t('settings.themeDark') : t('settings.themeSystem')}
                                        </div>
                                        {state.settings.theme === mode && (
                                            <div className="absolute top-2 right-2 bg-blue-500 text-white rounded-full p-0.5">
                                                <Check size={12} strokeWidth={3}/>
                                            </div>
                                        )}
                                    </button>
                                ))}
                            </div>
                         </div>
                     </section>

                     <section className="mt-8 border-t border-gray-100 dark:border-gray-800 pt-6">
                        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><LayoutGrid size={20} className="mr-2 text-blue-500"/> {t('settings.defaultLayout') || '默认布局设置'}</h3>
                        <div className="space-y-6">
                            {/* Layout Mode Selection */}
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.defaultLayoutMode') || '默认视图模式'}</label>
                                <div className="grid grid-cols-4 gap-3">
                                    {[
                                        { id: 'grid', label: t('layout.grid') || '网格', icon: Grid },
                                        { id: 'adaptive', label: t('layout.adaptive') || '自适应', icon: LayoutGrid },
                                        { id: 'list', label: t('layout.list') || '列表', icon: List },
                                        { id: 'masonry', label: t('layout.masonry') || '瀑布流', icon: LayoutTemplate }
                                    ].map(mode => {
                                        const Icon = mode.icon;
                                        const isSelected = state.settings.defaultLayoutSettings?.layoutMode === mode.id;
                                        return (
                                            <button
                                                key={mode.id}
                                                onClick={() => onUpdateSettingsData({
                                                    defaultLayoutSettings: {
                                                        ...(state.settings.defaultLayoutSettings || { layoutMode: 'grid', sortBy: 'name', sortDirection: 'asc', groupBy: 'none' }),
                                                        layoutMode: mode.id as LayoutMode
                                                    }
                                                })}
                                                className={`flex flex-col items-center p-3 rounded-lg border-2 transition-all ${
                                                    isSelected
                                                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                                                }`}
                                            >
                                                <Icon size={24} className={`mb-2 ${isSelected ? 'text-blue-500' : 'text-gray-400'}`} />
                                                <span className={`text-xs font-medium ${isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
                                                    {mode.label}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            {/* Sort Options */}
                            <div className="grid grid-cols-2 gap-6">
                                <div>
                                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.defaultSortBy') || '默认排序方式'}</label>
                                    <div className="space-y-2">
                                        {[
                                            { id: 'name', label: t('sort.name') || '名称', icon: Type },
                                            { id: 'date', label: t('sort.date') || '日期', icon: Calendar },
                                            { id: 'size', label: t('sort.size') || '大小', icon: HardDrive }
                                        ].map(sort => {
                                            const Icon = sort.icon;
                                            const isSelected = state.settings.defaultLayoutSettings?.sortBy === sort.id;
                                            return (
                                                <button
                                                    key={sort.id}
                                                    onClick={() => onUpdateSettingsData({
                                                        defaultLayoutSettings: {
                                                            ...(state.settings.defaultLayoutSettings || { layoutMode: 'grid', sortBy: 'name', sortDirection: 'asc', groupBy: 'none' }),
                                                            sortBy: sort.id as SortOption
                                                        }
                                                    })}
                                                    className={`w-full flex items-center px-3 py-2 rounded-lg border transition-all ${
                                                        isSelected
                                                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                                                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 text-gray-700 dark:text-gray-300'
                                                    }`}
                                                >
                                                    <Icon size={16} className="mr-2" />
                                                    <span className="text-sm">{sort.label}</span>
                                                    {isSelected && <Check size={14} className="ml-auto text-blue-500" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>

                                <div>
                                    <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.defaultSortDirection') || '默认排序方向'}</label>
                                    <div className="space-y-2">
                                        {[
                                            { id: 'asc', label: t('sort.ascending') || '升序', icon: ArrowUp },
                                            { id: 'desc', label: t('sort.descending') || '降序', icon: ArrowDown }
                                        ].map(dir => {
                                            const Icon = dir.icon;
                                            const isSelected = state.settings.defaultLayoutSettings?.sortDirection === dir.id;
                                            return (
                                                <button
                                                    key={dir.id}
                                                    onClick={() => onUpdateSettingsData({
                                                        defaultLayoutSettings: {
                                                            ...(state.settings.defaultLayoutSettings || { layoutMode: 'grid', sortBy: 'name', sortDirection: 'asc', groupBy: 'none' }),
                                                            sortDirection: dir.id as SortDirection
                                                        }
                                                    })}
                                                    className={`w-full flex items-center px-3 py-2 rounded-lg border transition-all ${
                                                        isSelected
                                                            ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400'
                                                            : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 text-gray-700 dark:text-gray-300'
                                                    }`}
                                                >
                                                    <Icon size={16} className="mr-2" />
                                                    <span className="text-sm">{dir.label}</span>
                                                    {isSelected && <Check size={14} className="ml-auto text-blue-500" />}
                                                </button>
                                            );
                                        })}
                                    </div>
                                </div>
                            </div>

                            {/* Group By Option */}
                            <div>
                                <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.defaultGroupBy') || '默认分组方式'}</label>
                                <div className="grid grid-cols-4 gap-3">
                                    {[
                                        { id: 'none', label: t('groupBy.none') || '不分组', icon: Layers },
                                        { id: 'type', label: t('groupBy.type') || '按类型', icon: Grid },
                                        { id: 'date', label: t('groupBy.date') || '按日期', icon: Calendar },
                                        { id: 'size', label: t('groupBy.size') || '按大小', icon: HardDrive }
                                    ].map(group => {
                                        const Icon = group.icon;
                                        const isSelected = state.settings.defaultLayoutSettings?.groupBy === group.id;
                                        return (
                                            <button
                                                key={group.id}
                                                onClick={() => onUpdateSettingsData({
                                                    defaultLayoutSettings: {
                                                        ...(state.settings.defaultLayoutSettings || { layoutMode: 'grid', sortBy: 'name', sortDirection: 'asc', groupBy: 'none' }),
                                                        groupBy: group.id as GroupByOption
                                                    }
                                                })}
                                                className={`flex flex-col items-center p-3 rounded-lg border-2 transition-all ${
                                                    isSelected
                                                        ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                                                        : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
                                                }`}
                                            >
                                                <Icon size={20} className={`mb-2 ${isSelected ? 'text-blue-500' : 'text-gray-400'}`} />
                                                <span className={`text-xs font-medium text-center ${isSelected ? 'text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400'}`}>
                                                    {group.label}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>
                        </div>
                     </section>

                 </div>
              )}

              {state.settingsCategory === 'storage' && (
                 <div className="space-y-8 animate-fade-in">
                     <section>
                         <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 border-b border-gray-100 dark:border-gray-800 pb-2 flex items-center"><Database size={20} className="mr-2 text-blue-500"/> {t('settings.catStorage')}</h3>
                         <div className="space-y-4">
                             <div>
                                 <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.resourceRoot')}</label>
                                 <div className="flex items-center">
                                     <div className="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-l px-3 py-2 text-sm text-gray-600 dark:text-gray-300 truncate font-mono">
                                         {state.settings.paths.resourceRoot}
                                     </div>
                                     <button 
                                         onClick={() => onUpdatePath('resource')}
                                         className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-medium rounded-r"
                                     >
                                         {t('settings.change')}
                                     </button>
                                 </div>
                             </div>
                             <div>
                                 <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-2">{t('settings.cacheRoot')}</label>
                                 <div className="flex items-center">
                                     <div className="flex-1 bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-l px-3 py-2 text-sm text-gray-600 dark:text-gray-300 truncate font-mono">
                                         {state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : t('settings.notSet')}
                                     </div>
                                     <button 
                                         onClick={() => {
                                             const cachePath = state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : '';
                                             if (cachePath) {
                                                 import('../api/tauri-bridge').then(({ openPath }) => {
                                                     openPath(cachePath);
                                                 });
                                             }
                                         }}
                                         disabled={!state.settings.paths.resourceRoot}
                                         className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 text-sm font-medium rounded-r border border-l-0 border-blue-600"
                                     >
                                         打开
                                     </button>
                                 </div>
                             </div>
                         </div>
                     </section>

                     <section className="mt-8 border-t border-gray-100 dark:border-gray-800 pt-6">
                         <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center"><Download size={20} className="mr-2 text-blue-500"/> {t('settings.dataBackup')}</h3>
                         <div className="flex space-x-4">
                             <button 
                                 onClick={handleExportData}
                                 className="flex items-center px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-gray-200 dark:border-gray-800"
                             >
                                 <Download size={16} className="mr-2"/>
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
                                     className="flex items-center px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-gray-200 dark:border-gray-800 pointer-events-none"
                                 >
                                     <Upload size={16} className="mr-2"/>
                                     {t('settings.importTags')}
                                 </button>
                             </div>
                         </div>
                     </section>

                     {/* 主色调数据库管理 */}
                     <section className="mt-8 border-t border-gray-100 dark:border-gray-800 pt-6">
                         <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 flex items-center justify-between">
                             <div className="flex items-center">
                                 <Palette size={20} className="mr-2 text-purple-500"/> 
                                 {t('settings.colorDbTitle')}
                             </div>
                             <button
                                onClick={async () => {
                                    // 先加载错误文件列表（会触发清理不存在的文件）
                                    await loadErrorFiles();
                                    // 然后再加载统计信息
                                    await loadColorDbStats();
                                }}
                                disabled={isLoadingStats}
                                className="text-sm flex items-center px-3 py-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors text-gray-700 dark:text-gray-200"
                            >
                                <RefreshCw size={14} className={`mr-1 ${isLoadingStats ? 'animate-spin' : ''}`}/>
                                {t('settings.refresh')}
                            </button>
                         </h3>
                         
                         {colorDbStats && (
                             <div className="space-y-4">
                                 {/* 统计卡片 */}
                                 <div className="grid grid-cols-2 gap-3">
                                     <div className="bg-gray-50 dark:bg-gray-700/30 rounded-lg p-3 border border-gray-200 dark:border-gray-800">
                                         <div className="text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbTotalRecords')}</div>
                                         <div className="text-xl font-bold text-gray-800 dark:text-white">{colorDbStats.total.toLocaleString()}</div>
                                     </div>
                                     <div className="bg-gray-50 dark:bg-gray-700/30 rounded-lg p-3 border border-gray-200 dark:border-gray-800">
                                         <div className="text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbFileSize')}</div>
                                         <div className="text-xl font-bold text-gray-800 dark:text-white">{formatFileSize(colorDbStats.dbSize + colorDbStats.walSize)}</div>
                                     </div>
                                 </div>
                                 
                                 {/* 状态分布 */}
                                 <div className="bg-gray-50 dark:bg-gray-700/30 rounded-lg p-4 border border-gray-200 dark:border-gray-800">
                                     <div className="flex justify-between items-center mb-3">
                                         <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.colorDbStatusDistribution')}</span>
                                     </div>
                                     <div className="space-y-2">
                                         {/* 已提取 */}
                                         <div className="flex items-center">
                                             <div className="w-20 text-xs text-gray-500 dark:text-gray-400">{t('settings.colorDbExtracted')}</div>
                                             <div className="flex-1 mx-2">
                                                 <div className="h-2 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
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
                                                 <div className="h-2 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
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
                                                     <div className="h-2 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
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
                                                 <div className="h-2 bg-gray-200 dark:bg-gray-600 rounded-full overflow-hidden">
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
                                 
                                 {/* 错误文件管理 */}
                                 {colorDbStats.error > 0 && (
                                     <div className="bg-red-50 dark:bg-red-900/20 rounded-lg p-4 border border-red-200 dark:border-red-800">
                                         <div className="flex items-center justify-between mb-3">
                                             <div className="flex items-center">
                                                 <AlertCircle size={18} className="text-red-500 mr-2"/>
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
                                                     <RefreshCw size={14} className={`mr-1 ${isRetrying ? 'animate-spin' : ''}`}/>
                                                     {t('settings.colorDbRetryAll')}
                                                 </button>
                                                 <button
                                                     onClick={() => {
                                                         setShowErrorFiles(!showErrorFiles);
                                                         if (!showErrorFiles) loadErrorFiles();
                                                     }}
                                                     className="text-sm flex items-center px-3 py-1.5 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg transition-colors"
                                                 >
                                                     {showErrorFiles ? <ChevronUp size={14} className="mr-1"/> : <ChevronDown size={14} className="mr-1"/>}
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
                                                                className="mr-2 rounded border-gray-300 text-red-600 focus:ring-red-500"
                                                            />
                                                            {t('settings.selectAll')} ({selectedFiles.size}/{errorFiles.length})
                                                        </label>
                                                    </div>
                                                    <div className="flex items-center space-x-2">
                                                        {/* 视图切换 */}
                                                        <div className="flex items-center bg-gray-100 dark:bg-gray-800 rounded-lg p-0.5">
                                                            <button
                                                                onClick={() => setViewMode('list')}
                                                                className={`p-1.5 rounded ${viewMode === 'list' ? 'bg-white dark:bg-gray-700 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}
                                                                title={t('layout.list')}
                                                            >
                                                                <List size={14} />
                                                            </button>
                                                            <button
                                                                onClick={() => setViewMode('grid')}
                                                                className={`p-1.5 rounded ${viewMode === 'grid' ? 'bg-white dark:bg-gray-700 shadow-sm' : 'text-gray-500 dark:text-gray-400'}`}
                                                                title={t('layout.grid')}
                                                            >
                                                                <Grid size={14} />
                                                            </button>
                                                        </div>
                                                        {/* 删除选中按钮 */}
                                                        {selectedFiles.size > 0 && (
                                                            <button
                                                                onClick={handleDeleteSelected}
                                                                disabled={isDeleting}
                                                                className="text-sm flex items-center px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors"
                                                            >
                                                                <Trash size={14} className="mr-1"/>
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
                                                                className={`relative group rounded-lg border-2 overflow-hidden cursor-pointer transition-all ${
                                                                    selectedFiles.has(file.path) 
                                                                        ? 'border-red-500 ring-2 ring-red-500/20' 
                                                                        : 'border-gray-200 dark:border-gray-700 hover:border-red-300'
                                                                }`}
                                                                onClick={() => toggleFileSelection(file.path)}
                                                            >
                                                                {/* 缩略图 */}
                                                                <div className="aspect-square bg-gray-100 dark:bg-gray-800 flex items-center justify-center relative">
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
                                                                        className="rounded border-gray-300 text-red-600 focus:ring-red-500"
                                                                    />
                                                                </div>
                                                                
                                                                {/* 操作按钮 */}
                                                                <div className="absolute top-2 right-2 flex space-x-1 opacity-0 group-hover:opacity-100 transition-opacity z-20">
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            openPreview(file);
                                                                        }}
                                                                        className="p-1.5 bg-white dark:bg-gray-800 rounded shadow-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                                                                        title={t('settings.preview')}
                                                                    >
                                                                        <Eye size={12} className="text-gray-600 dark:text-gray-400" />
                                                                    </button>
                                                                    <button
                                                                        onClick={(e) => {
                                                                            e.stopPropagation();
                                                                            openInExplorer(file.path);
                                                                        }}
                                                                        className="p-1.5 bg-white dark:bg-gray-800 rounded shadow-sm hover:bg-gray-100 dark:hover:bg-gray-700"
                                                                        title={t('context.openFolder')}
                                                                    >
                                                                        <FolderOpen size={12} className="text-gray-600 dark:text-gray-400" />
                                                                    </button>
                                                                </div>
                                                                
                                                                {/* 文件名 */}
                                                                <div className="p-2 bg-white dark:bg-gray-800">
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
                                                            <div key={index} className="flex items-center p-2 bg-white dark:bg-gray-800 rounded border border-red-100 dark:border-red-800 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors">
                                                                <input
                                                                    type="checkbox"
                                                                    checked={selectedFiles.has(file.path)}
                                                                    onChange={() => toggleFileSelection(file.path)}
                                                                    className="mr-3 rounded border-gray-300 text-red-600 focus:ring-red-500"
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
                                                                        className="p-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                                                                        title={t('settings.preview')}
                                                                    >
                                                                        <Eye size={14}/>
                                                                    </button>
                                                                    <button
                                                                        onClick={() => openInExplorer(file.path)}
                                                                        className="p-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded transition-colors"
                                                                        title={t('context.openFolder')}
                                                                    >
                                                                        <FolderOpen size={14}/>
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleRetryErrors([file.path])}
                                                                        disabled={isRetrying}
                                                                        className="p-1.5 text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 rounded transition-colors"
                                                                        title={t('settings.colorDbRetrySingle')}
                                                                    >
                                                                        <Play size={14}/>
                                                                    </button>
                                                                    <button
                                                                        onClick={() => handleDeleteSingle(file)}
                                                                        disabled={isDeleting}
                                                                        className="p-1.5 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded transition-colors"
                                                                        title={t('context.delete')}
                                                                    >
                                                                        <Trash size={14}/>
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
                                                <RefreshCw size={18} className="text-yellow-500 mr-2 animate-spin"/>
                                                <span className="text-sm font-medium text-yellow-700 dark:text-yellow-400">
                                                    {t('settings.colorDbRetrying')}
                                                </span>
                                            </>
                                        ) : (
                                            <>
                                                <Check size={18} className="text-green-500 mr-2"/>
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
                                 <Database size={32} className="mx-auto mb-2 opacity-50"/>
                                 <p className="text-sm">{t('settings.colorDbNoData')}</p>
                             </div>
                         )}
                     </section>
                 </div>
              )}

              {state.settingsCategory === 'ai' && (
                  <div className="space-y-8 animate-fade-in">
                      <section>
                          {/* ... Provider selection ... */}
                          <div className="flex items-center justify-between border-b border-gray-100 dark:border-gray-800 pb-2 mb-4">
                              <h3 className="text-lg font-bold text-gray-800 dark:text-white flex items-center">
                                  <Brain size={20} className="mr-2 text-purple-500"/> {t('settings.catAi')}
                              </h3>
                              <div className="flex items-center space-x-3">
                                  <div className={`flex items-center px-2 py-1 rounded text-xs font-bold ${
                                      connectionStatus === 'connected' ? 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400' :
                                      connectionStatus === 'disconnected' ? 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400' :
                                      'bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400'
                                  }`}>
                                      {connectionStatus === 'connected' && <Check size={12} className="mr-1"/>}
                                      {connectionStatus === 'disconnected' && <XCircle size={12} className="mr-1"/>}
                                      {connectionStatus === 'checking' && <Activity size={12} className="mr-1 animate-spin"/>}
                                      {connectionStatus === 'connected' ? t('settings.statusConnected') : 
                                       connectionStatus === 'disconnected' ? t('settings.statusDisconnected') : 
                                       t('settings.statusChecking')}
                                  </div>
                                  <button
                                      onClick={() => checkConnection(true)}
                                      disabled={isTesting}
                                      title={t('settings.testConnection')}
                                      className={`inline-flex items-center px-3 py-1 text-xs font-bold rounded transition-colors bg-purple-600 hover:bg-purple-500 text-white disabled:opacity-60 disabled:cursor-not-allowed`}
                                  >
                                      {isTesting ? <Activity size={12} className="mr-1 animate-spin"/> : <Zap size={12} className="mr-1"/>}
                                      <span className="hidden sm:inline text-[11px]">{isTesting ? t('settings.testing') : t('settings.testConnection')}</span>
                                  </button>
                              </div>
                          </div>
                          
                          {/* ... (Existing Provider UI) ... */}
                          <label className="block text-sm font-bold text-gray-700 dark:text-gray-300 mb-3">{t('settings.aiProvider')}</label>
                          <div className="grid grid-cols-3 gap-3 mb-6">
                              {[
                                  { id: 'ollama', icon: Zap, label: t('settings.aiProviderLocal') },
                                  { id: 'openai', icon: Globe, label: t('settings.aiProviderOnline') },
                                  { id: 'lmstudio', icon: Server, label: t('settings.aiProviderLmStudio') }
                              ].map((item) => (
                                  <button
                                      key={item.id}
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, provider: item.id as any } })}
                                      className={`relative flex flex-col items-center justify-center p-4 rounded-xl border-2 transition-all ${
                                          state.settings.ai.provider === item.id 
                                          ? 'border-purple-500 bg-purple-50 dark:bg-purple-900/20 text-purple-700 dark:text-purple-300' 
                                          : 'border-gray-200 dark:border-gray-800 hover:border-purple-300 dark:hover:border-purple-700 text-gray-600 dark:text-gray-400'
                                      }`}
                                  >
                                      <item.icon size={24} className="mb-2"/>
                                      <span className="text-xs font-bold text-center">{item.label}</span>
                                      {state.settings.ai.provider === item.id && (
                                          <div className="absolute top-2 right-2 bg-purple-500 text-white rounded-full p-0.5">
                                              <Check size={10} strokeWidth={3}/>
                                          </div>
                                      )}
                                  </button>
                              ))}
                          </div>

                          {/* AI Model Connection Steps */}
                          <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-5 border border-blue-200 dark:border-blue-800 space-y-3 mb-6">
                              <h4 className="text-sm font-bold text-blue-700 dark:text-blue-400 flex items-center">
                                  <HelpCircle size={16} className="mr-2"/>
                                  {t('settings.connectionSteps')}
                              </h4>
                              
                              {state.settings.ai.provider === 'ollama' && (
                                  <div className="space-y-2 text-sm text-blue-800 dark:text-blue-300">
                                      <ol className="list-decimal list-inside space-y-1">
                                          <li>{t('settings.ollamaStep1')}</li>
                                          <li>{t('settings.ollamaStep2')}</li>
                                          <li>{t('settings.ollamaStep3')}</li>
                                          <li>{t('settings.ollamaStep4')}</li>
                                          <li>{t('settings.ollamaStep5')}</li>
                                      </ol>
                                  </div>
                              )}
                              
                              {state.settings.ai.provider === 'openai' && (
                                  <div className="space-y-2 text-sm text-blue-800 dark:text-blue-300">
                                      <ol className="list-decimal list-inside space-y-1">
                                          <li>{t('settings.openaiStep1')}</li>
                                          <li>{t('settings.openaiStep2')}</li>
                                          <li>{t('settings.openaiStep3')}</li>
                                          <li>{t('settings.openaiStep4')}</li>
                                          <li>{t('settings.openaiStep5')}</li>
                                      </ol>
                                  </div>
                              )}
                              
                              {state.settings.ai.provider === 'lmstudio' && (
                                  <div className="space-y-2 text-sm text-blue-800 dark:text-blue-300">
                                      <ol className="list-decimal list-inside space-y-1">
                                          <li>{t('settings.lmStudioStep1')}</li>
                                          <li>{t('settings.lmStudioStep2')}</li>
                                          <li>{t('settings.lmStudioStep3')}</li>
                                          <li>{t('settings.lmStudioStep4')}</li>
                                          <li>{t('settings.lmStudioStep5')}</li>
                                      </ol>
                                  </div>
                              )}
                          </div>

                          <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-5 border border-gray-200 dark:border-gray-800 space-y-4">
                              {state.settings.ai.provider === 'openai' && (
                                  <>
                                      {/* 服务商和模型选择 - 左右布局 */}
                                      <div className="grid grid-cols-2 gap-4">
                                          {/* 服务商下拉选择 */}
                                          <div>
                                              <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-2">{t('settings.aiService') || 'AI 服务商'}</label>
                                              <select
                                                  value={state.settings.ai.onlineServicePreset || ''}
                                                  onChange={(e) => {
                                                      const presetId = e.target.value;
                                                      const preset = AI_SERVICE_PRESETS.find(p => p.id === presetId);
                                                      if (preset) {
                                                          // 切换服务商时清除错误状态和成功提示
                                                          setFetchModelsError(null);
                                                          setLastFetchedPresetId(null);
                                                          
                                                          const newSettings = { 
                                                              ...state.settings.ai, 
                                                              onlineServicePreset: presetId,
                                                              openai: {
                                                                  ...state.settings.ai.openai,
                                                                  endpoint: preset.endpoint,
                                                                  model: preset.models.find(m => m.recommended)?.id || preset.models[0].id
                                                              }
                                                          };
                                                          onUpdateSettingsData({ ai: newSettings });
                                                      }
                                                  }}
                                                  className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              >
                                                  {AI_SERVICE_PRESETS.map((preset) => (
                                                      <option key={preset.id} value={preset.id}>
                                                          {preset.name}
                                                      </option>
                                                  ))}
                                              </select>
                                          </div>

                                          {/* 模型下拉选择 */}
                                          <div>
                                              <div className="flex items-center justify-between mb-2">
                                                  <label className="text-xs font-bold text-gray-500 dark:text-gray-400">{t('settings.aiModel')}</label>
                                                  {state.settings.ai.onlineServicePreset && state.settings.ai.onlineServicePreset !== 'custom' && (
                                                      <div className="flex items-center gap-2">
                                                          {dynamicModels[state.settings.ai.onlineServicePreset] && (
                                                              <button
                                                                  onClick={() => {
                                                                      aiService.clearModelsCache(state.settings.ai.onlineServicePreset);
                                                                      setDynamicModels(prev => {
                                                                          const newModels = { ...prev };
                                                                          delete newModels[state.settings.ai.onlineServicePreset!];
                                                                          return newModels;
                                                                      });
                                                                  }}
                                                                  className="flex items-center gap-1 text-[10px] text-gray-500 hover:text-red-500 transition-colors"
                                                                  title={t('settings.clearModelsCache') || '清除模型缓存'}
                                                              >
                                                                  <Trash2 size={10} />
                                                                  {t('settings.clearCache') || '清除'}
                                                              </button>
                                                          )}
                                                          <button
                                                              onClick={handleFetchModels}
                                                              disabled={isFetchingModels}
                                                              className="flex items-center gap-1 text-[10px] text-blue-500 hover:text-blue-600 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
                                                              title={t('settings.fetchModels') || '获取最新模型列表'}
                                                          >
                                                              <RefreshCw size={10} className={isFetchingModels ? 'animate-spin' : ''} />
                                                              {isFetchingModels ? (t('settings.fetchingModels') || '获取中...') : (t('settings.refreshModels') || '刷新')}
                                                          </button>
                                                      </div>
                                                  )}
                                              </div>
                                              {state.settings.ai.onlineServicePreset && state.settings.ai.onlineServicePreset !== 'custom' ? (
                                                  <>
                                                      <select
                                                          value={state.settings.ai.openai.model}
                                                          onChange={(e) => onUpdateSettingsData({ 
                                                              ai: { 
                                                                  ...state.settings.ai, 
                                                                  openai: { ...state.settings.ai.openai, model: e.target.value } 
                                                              } 
                                                          })}
                                                          className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                                      >
                                                          {/* 优先显示动态获取的模型列表 */}
                                                          {(dynamicModels[state.settings.ai.onlineServicePreset] || 
                                                            AI_SERVICE_PRESETS.find(p => p.id === state.settings.ai.onlineServicePreset)?.models || []
                                                          ).map((model) => (
                                                              <option key={model.id} value={model.id}>
                                                                  {model.name} {model.recommended ? '(推荐)' : ''}
                                                              </option>
                                                          ))}
                                                      </select>
                                                      {fetchModelsError && (
                                                          <div className="text-[10px] text-red-500 mt-1">{fetchModelsError}</div>
                                                      )}
                                                      {lastFetchedPresetId === state.settings.ai.onlineServicePreset && !fetchModelsError && (
                                                          <div className="text-[10px] text-green-600 dark:text-green-400 mt-1">
                                                              {t('settings.modelsUpdated') || '已获取最新模型列表'}
                                                          </div>
                                                      )}
                                                  </>
                                              ) : (
                                                  <input 
                                                      type="text" 
                                                      value={state.settings.ai.openai.model}
                                                      onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, openai: { ...state.settings.ai.openai, model: e.target.value } } })}
                                                      className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                                      placeholder="输入模型名称..."
                                                  />
                                              )}
                                          </div>
                                      </div>

                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="openai-endpoint">{t('settings.endpoint')}</label>
                                          <input 
                                              type="text" 
                                              id="openai-endpoint"
                                              name="openai-endpoint"
                                              value={state.settings.ai.openai.endpoint}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, openai: { ...state.settings.ai.openai, endpoint: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="https://api.openai.com/v1"
                                          />
                                      </div>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="openai-api-key">{t('settings.apiKey')}</label>
                                          <div className="flex gap-2">
                                              <input 
                                                  type="password" 
                                                  id="openai-api-key"
                                                  name="openai-api-key"
                                                  value={state.settings.ai.openai.apiKey}
                                                  onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, openai: { ...state.settings.ai.openai, apiKey: e.target.value } } })}
                                                  className="flex-1 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                                  placeholder={AI_SERVICE_PRESETS.find(p => p.id === state.settings.ai.onlineServicePreset)?.apiKeyPlaceholder || 'sk-...'}
                                              />
                                              {AI_SERVICE_PRESETS.find(p => p.id === state.settings.ai.onlineServicePreset)?.apiKeyHelpUrl && (
                                                  <button
                                                      onClick={() => openExternalLink(AI_SERVICE_PRESETS.find(p => p.id === state.settings.ai.onlineServicePreset)?.apiKeyHelpUrl || '')}
                                                      className="px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded text-xs font-medium transition-colors"
                                                      title="获取 API Key"
                                                  >
                                                      获取 Key
                                                  </button>
                                              )}
                                          </div>
                                      </div>
                                  </>
                              )}

                              {state.settings.ai.provider === 'ollama' && (
                                  <>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ollama-endpoint">{t('settings.endpoint')}</label>
                                          <input 
                                              type="text" 
                                              id="ollama-endpoint"
                                              name="ollama-endpoint"
                                              value={state.settings.ai.ollama.endpoint}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, ollama: { ...state.settings.ai.ollama, endpoint: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="http://localhost:11434"
                                          />
                                      </div>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ollama-model">{t('settings.aiModelVision')}</label>
                                          <input 
                                              type="text" 
                                              id="ollama-model"
                                              name="ollama-model"
                                              value={state.settings.ai.ollama.model}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, ollama: { ...state.settings.ai.ollama, model: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="llava"
                                          />
                                      </div>
                                  </>
                              )}

                              {state.settings.ai.provider === 'lmstudio' && (
                                  <>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="lmstudio-endpoint">{t('settings.lmStudioEndpoint')}</label>
                                          <input 
                                              type="text" 
                                              id="lmstudio-endpoint"
                                              name="lmstudio-endpoint"
                                              value={state.settings.ai.lmstudio.endpoint}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, lmstudio: { ...state.settings.ai.lmstudio, endpoint: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="http://localhost:1234/v1"
                                          />
                                          <div className="text-[10px] text-gray-400 mt-1">{t('settings.lmStudioVersionHint')}</div>
                                      </div>
                                      <div>
                                          <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="lmstudio-model">{t('settings.aiModelOptional')}</label>
                                          <input 
                                              type="text" 
                                              id="lmstudio-model"
                                              name="lmstudio-model"
                                              value={state.settings.ai.lmstudio.model}
                                              onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, lmstudio: { ...state.settings.ai.lmstudio, model: e.target.value } } })}
                                              className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200"
                                              placeholder="local-model"
                                          />
                                      </div>
                                  </>
                              )}

                          </div>

                          <div className="mt-6">
                              <h4 className="text-sm font-bold text-gray-800 dark:text-white mb-2">{t('settings.systemPrompt')}</h4>
                              <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-4 border border-gray-200 dark:border-gray-800">
                                  <textarea
                                      id="ai-system-prompt"
                                      value={state.settings.ai.systemPrompt || ''}
                                      onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, systemPrompt: e.target.value } })}
                                      className="w-full bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-2 text-sm outline-none text-gray-800 dark:text-gray-200 min-h-[80px]"
                                      placeholder="..."
                                  />
                                  
                                  {/* 预设工具�?*/}
                                  <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-700 flex flex-wrap items-center gap-2">
                                      <select 
                                          id="ai-preset-select"
                                          value={state.settings.ai.currentPresetId || ''}
                                          onChange={(e) => {
                                              const pid = e.target.value;
                                              const preset = state.settings.ai.promptPresets?.find(p => p.id === pid);
                                              if (preset) {
                                                  onUpdateSettingsData({ ai: { ...state.settings.ai, currentPresetId: pid, systemPrompt: preset.content } });
                                              } else {
                                                  onUpdateSettingsData({ ai: { ...state.settings.ai, currentPresetId: undefined } });
                                              }
                                          }}
                                          className="flex-1 min-w-[120px] bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-1.5 text-xs outline-none text-gray-800 dark:text-gray-200"
                                      >
                                          <option value="">{t('settings.selectPreset')}</option>
                                          {state.settings.ai.promptPresets?.map(p => (
                                              <option key={p.id} value={p.id}>{p.name}</option>
                                          ))}
                                      </select>

                                      <input 
                                          type="text"
                                          value={editingPresetName}
                                          onChange={(e) => setEditingPresetName(e.target.value)}
                                          placeholder={t('settings.presetName')}
                                          className="flex-1 min-w-[120px] bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded p-1.5 text-xs outline-none text-gray-800 dark:text-gray-200"
                                      />

                                      <div className="flex items-center gap-1">
                                          <button 
                                              onClick={() => {
                                                  const currentPresets = state.settings.ai.promptPresets || [];
                                                  const pid = state.settings.ai.currentPresetId;
                                                  if (pid) {
                                                      const updated = currentPresets.map(p => p.id === pid ? { ...p, name: editingPresetName, content: state.settings.ai.systemPrompt || '' } : p);
                                                      onUpdateSettingsData({ ai: { ...state.settings.ai, promptPresets: updated } });
                                                  }
                                              }}
                                              disabled={!state.settings.ai.currentPresetId}
                                              title={t('settings.savePreset')}
                                              className="p-1.5 rounded bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-800/50 disabled:opacity-50"
                                          >
                                              <Save size={16} />
                                          </button>
                                          
                                          <button 
                                              onClick={() => {
                                                  const newId = `preset_${Date.now()}`;
                                                  const newPreset = { id: newId, name: editingPresetName || t('settings.newPresetName'), content: state.settings.ai.systemPrompt || '' };
                                                  const updated = [...(state.settings.ai.promptPresets || []), newPreset];
                                                  onUpdateSettingsData({ ai: { ...state.settings.ai, promptPresets: updated, currentPresetId: newId } });
                                              }}
                                              title={t('settings.saveAsNewPreset')}
                                              className="p-1.5 rounded bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-800/50"
                                          >
                                              <PlusCircle size={16} />
                                          </button>

                                          <button 
                                              onClick={() => {
                                                  const pid = state.settings.ai.currentPresetId;
                                                  if (pid) {
                                                      const updated = (state.settings.ai.promptPresets || []).filter(p => p.id !== pid);
                                                      onUpdateSettingsData({ ai: { ...state.settings.ai, promptPresets: updated, currentPresetId: undefined } });
                                                  }
                                              }}
                                              disabled={!state.settings.ai.currentPresetId}
                                              title={t('settings.deletePreset')}
                                              className="p-1.5 rounded bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 hover:bg-red-200 dark:hover:bg-red-800/50 disabled:opacity-50"
                                          >
                                              <Trash2 size={16} />
                                          </button>
                                      </div>
                                  </div>
                              </div>
                          </div>

                          <div className="mt-6 space-y-3">
                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoTag')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, autoTag: !state.settings.ai.autoTag } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.autoTag ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.autoTag ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoDescription')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, autoDescription: !state.settings.ai.autoDescription } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.autoDescription ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.autoDescription ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              <div className="flex items-center justify-between pl-4 border-l-2 border-gray-200 dark:border-gray-800">
                                  <span className={`text-sm font-medium ${state.settings.ai.autoDescription ? 'text-gray-700 dark:text-gray-300' : 'text-gray-400 dark:text-gray-500'}`}>{t('settings.aiEnhancePersonDesc')}</span>
                                  <button 
                                      onClick={() => {
                                          if (state.settings.ai.autoDescription) {
                                              onUpdateSettingsData({ ai: { ...state.settings.ai, enhancePersonDescription: !state.settings.ai.enhancePersonDescription } });
                                          }
                                      }}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors cursor-pointer ${state.settings.ai.autoDescription ? (state.settings.ai.enhancePersonDescription ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600') : 'bg-gray-300 dark:bg-gray-600 cursor-not-allowed'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.enhancePersonDescription ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiFaceRec')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, enableFaceRecognition: !state.settings.ai.enableFaceRecognition } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.enableFaceRecognition ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.enableFaceRecognition ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              
                              <div className="flex items-center justify-between pl-4 border-l-2 border-gray-200 dark:border-gray-800">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiAutoAddPeople')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, autoAddPeople: !state.settings.ai.autoAddPeople } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.autoAddPeople ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.autoAddPeople ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>

                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiEnableOCR')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, enableOCR: !state.settings.ai.enableOCR } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.enableOCR ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.enableOCR ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>

                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiEnableTranslation')}</span>
                                  <button 
                                      onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, enableTranslation: !state.settings.ai.enableTranslation } })}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${state.settings.ai.enableTranslation ? 'bg-purple-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${state.settings.ai.enableTranslation ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>

                              {state.settings.ai.enableTranslation && (
                                  <div className="flex items-center justify-between pl-4 border-l-2 border-gray-200 dark:border-gray-800 animate-fade-in">
                                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.aiTargetLang')}</span>
                                      <div className="flex space-x-2">
                                          {[
                                              { code: 'zh', label: '中文' },
                                              { code: 'en', label: 'English' },
                                              { code: 'ja', label: '日本語' },
                                              { code: 'ko', label: '한국어' }
                                          ].map(lang => (
                                              <button
                                                  key={lang.code}
                                                  onClick={() => onUpdateSettingsData({ ai: { ...state.settings.ai, targetLanguage: lang.code as any } })}
                                                  className={`text-xs px-2 py-1 rounded border transition-colors ${
                                                      state.settings.ai.targetLanguage === lang.code
                                                          ? 'bg-purple-500 text-white border-purple-500'
                                                          : 'bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-400 border-gray-300 dark:border-gray-700 hover:border-purple-400'
                                                  }`}
                                              >
                                                  {lang.label}
                                              </button>
                                          ))}
                                      </div>
                                  </div>
                              )}
                              
                              <div className="pt-4">
                                  <label className="block text-xs font-bold text-gray-500 dark:text-gray-400 mb-1" htmlFor="ai-confidence">{t('settings.aiConfidence')} ({Math.round(state.settings.ai.confidenceThreshold * 100)}%)</label>
                                  <input 
                                      type="range" 
                                      id="ai-confidence"
                                      name="ai-confidence"
                                      min="0.1" 
                                      max="0.9" 
                                      step="0.05"
                                      value={state.settings.ai.confidenceThreshold}
                                      onChange={(e) => onUpdateSettingsData({ ai: { ...state.settings.ai, confidenceThreshold: parseFloat(e.target.value) } })}
                                      className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-purple-500"
                                  />
                              </div>
                          </div>


                      </section>
                  </div>
              )}

              {state.settingsCategory === 'performance' && (
                  <div className="space-y-8 animate-fade-in">
                      <section>
                          <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-6 border-b border-gray-100 dark:border-gray-800 pb-2 flex items-center justify-between">
                              <div className="flex items-center">
                                  <BarChart2 size={20} className="mr-2 text-blue-500"/>
                                  {t('settings.catPerformance')}
                              </div>
                              <button 
                                  onClick={handleRefreshPerformance}
                                  className="text-sm flex items-center px-3 py-1 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full transition-colors text-gray-700 dark:text-gray-200"
                              >
                                  <RefreshCw size={14} className="mr-1 animate-spin-on-hover"/>
                                  {t('settings.performance.refreshNow')}
                              </button>
                          </h3>
                          
                          {/* 性能指标概览 */}
                          <div className="grid grid-cols-2 gap-4 mb-8">
                              {/* 实时内存使用 */}
                              <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-4 border border-gray-200 dark:border-gray-800">
                                  <div className="flex items-center justify-between mb-3">
                                      <div>
                                          <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('settings.performance.memoryUsage')}</span>
                                      </div>
                                      <div className="flex items-center text-sm">
                                          <MemoryStick size={14} className="mr-1 text-blue-500"/>
                                          <span className="font-bold text-gray-800 dark:text-white">
                                              {(() => {
                                                  // 使用当前内存值而非平均�?
                                                  const currentMemory = performanceMonitor.getCurrentMemory();
                                                  return currentMemory ? `${Math.round(currentMemory)} MB` : 'N/A';
                                              })()}
                                          </span>
                                      </div>
                                  </div>
                                  
                                  {/* 内存使用历史可视�?*/}
                                  <div className="h-24 bg-gray-200 dark:bg-gray-600 rounded overflow-hidden relative">
                                      {(() => {
                                          // 获取内存历史并确保包含当前内存数�?
                                          let memoryHistory = performanceMonitor.getMemoryHistory();
                                          const currentMemory = performanceMonitor.getCurrentMemory();
                                          
                                          // 如果没有历史数据但有当前内存数据，创建初始数据点
                                          if (memoryHistory.length === 0) {
                                              if (currentMemory !== null) {
                                                  memoryHistory = [{ timestamp: Date.now(), memory: currentMemory }];
                                              } else {
                                                  return <div className="flex items-center justify-center h-full text-sm text-gray-500 dark:text-gray-400">暂无历史数据</div>;
                                              }
                                          } else if (currentMemory !== null) {
                                              // 确保最新的数据点是当前内存数据
                                              const lastPoint = memoryHistory[memoryHistory.length - 1];
                                              const currentTime = Date.now();
                                              // 如果最后一个数据点是旧的（超过1秒），添加当前内存数�?
                                              if (currentTime - lastPoint.timestamp > 1000) {
                                                  memoryHistory = [...memoryHistory, { timestamp: currentTime, memory: currentMemory }];
                                              } else {
                                                  // 否则更新最后一个数据点
                                                  memoryHistory = [...memoryHistory.slice(0, -1), { timestamp: currentTime, memory: currentMemory }];
                                              }
                                          }
                                                
                                          // 获取最大值和最小值，添加一些余量以确保曲线不会贴边
                                          const allMemoryValues = memoryHistory.map(item => item.memory);
                                          const maxMemory = Math.max(...allMemoryValues) * 1.1; // 增加10%的余�?
                                          const minMemory = Math.max(0, Math.min(...allMemoryValues) * 0.9); // 减少10%的余量，最低为0
                                          const range = maxMemory - minMemory || 1;
                                          
                                          // 创建SVG路径
                                          let pathData = '';
                                          if (memoryHistory.length > 1) {
                                              pathData = memoryHistory.map((item, index) => {
                                                  const x = (index / (memoryHistory.length - 1)) * 200;
                                                  const y = 100 - ((item.memory - minMemory) / range) * 100;
                                                  return `${index === 0 ? 'M' : 'L'} ${x} ${y}`;
                                              }).join(' ');
                                          } else if (memoryHistory.length === 1) {
                                              // 只有一个数据点，绘制一个点
                                              const y = 100 - ((memoryHistory[0].memory - minMemory) / range) * 100;
                                              pathData = `M 100 ${y}`;
                                          }
                                          
                                          return (
                                              <svg className="w-full h-full" viewBox="0 0 200 100" preserveAspectRatio="none">
                                                  {/* 背景网格�?*/}
                                                  <g opacity="0.2">
                                                      <line x1="0" y1="25" x2="200" y2="25" stroke="currentColor" strokeWidth="0.5" />
                                                      <line x1="0" y1="50" x2="200" y2="50" stroke="currentColor" strokeWidth="0.5" />
                                                      <line x1="0" y1="75" x2="200" y2="75" stroke="currentColor" strokeWidth="0.5" />
                                                  </g>
                                                  
                                                  {/* 内存使用曲线 */}
                                                  {pathData && (
                                                      <path 
                                                          d={pathData} 
                                                          fill="none" 
                                                          stroke="#3b82f6" 
                                                          strokeWidth="2" 
                                                          strokeLinecap="round"
                                                          strokeLinejoin="round"
                                                      />
                                                  )}
                                                  
                                                  {/* 填充区域 */}
                                                  {pathData && memoryHistory.length > 1 && (
                                                      <path 
                                                          d={`${pathData} L 200 100 L 0 100 Z`} 
                                                          fill="#3b82f6" 
                                                          opacity="0.2" 
                                                      />
                                                  )}
                                                  
                                                  {/* 当前值标�?*/}
                                                  {memoryHistory.length > 0 && (
                                                      <circle 
                                                          cx={memoryHistory.length > 1 ? 200 : 100} 
                                                          cy={100 - ((memoryHistory[memoryHistory.length - 1].memory - minMemory) / range) * 100} 
                                                          r="4" 
                                                          fill="#3b82f6" 
                                                          stroke="white" 
                                                          strokeWidth="1.5" 
                                                          strokeLinecap="round"
                                                          strokeLinejoin="round"
                                                      />
                                                  )}
                                              </svg>
                                          );
                                      })()}
                                  </div>
                              </div>
                              
                              {/* 缩略图缓存命中率 */}
                              <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-4 border border-gray-200 dark:border-gray-800">
                                  <div className="flex items-center justify-between mb-3">
                                      <div>
                                          <span className="text-sm font-medium text-gray-600 dark:text-gray-400">{t('settings.performance.cacheHitRate')}</span>
                                      </div>
                                      <div className="flex items-center text-sm">
                                          <Database size={14} className="mr-1 text-blue-500"/>
                                          <span className="font-bold text-gray-800 dark:text-white">
                                              {(() => {
                                                  const hitCount = performanceMonitor.getCounter('thumbnailCacheHit');
                                                  const missCount = performanceMonitor.getCounter('thumbnailCacheMiss');
                                                  const total = hitCount + missCount;
                                                  return total > 0 ? `${Math.round((hitCount / total) * 100)}%` : '0%';
                                              })()}
                                          </span>
                                      </div>
                                  </div>
                                  
                                  {/* 缓存命中率可视化 */}
                                  <div className="h-10 bg-gray-200 dark:bg-gray-600 rounded overflow-hidden flex">
                                      {(() => {
                                          const hitCount = performanceMonitor.getCounter('thumbnailCacheHit');
                                          const missCount = performanceMonitor.getCounter('thumbnailCacheMiss');
                                          const total = hitCount + missCount;
                                          const hitRate = total > 0 ? (hitCount / total) * 100 : 0;
                                          return (
                                              <>
                                                  <div 
                                                      className="h-full bg-green-500 transition-all duration-300 ease-out" 
                                                      style={{ width: `${hitRate}%` }}
                                                  />
                                                  <div 
                                                      className="h-full bg-red-500 transition-all duration-300 ease-out" 
                                                      style={{ width: `${100 - hitRate}%` }}
                                                  />
                                              </>
                                          );
                                      })()}
                                  </div>
                              </div>
                          </div>
                          
                          {/* 性能指标详细数据 */}
                          <div className="space-y-6">
                              {/* 缩略图加载性能 */}
                              <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-4 border border-gray-200 dark:border-gray-800">
                                  <h4 className="text-md font-semibold text-gray-800 dark:text-white mb-3 flex items-center">
                                      <FileText size={16} className="mr-2 text-blue-500"/>
                                      {t('settings.performance.thumbnailLoading')}
                                  </h4>
                                  
                                  <div className="grid grid-cols-3 gap-3">
                                      <div>
                                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.average')}</span>
                                          <span className="text-lg font-bold text-gray-800 dark:text-white">
                                              {performanceMonitor.getAggregated('getThumbnail') ? 
                                                  `${Math.round(performanceMonitor.getAggregated('getThumbnail')?.average || 0)} ms` : 
                                                  '0 ms'}
                                          </span>
                                      </div>
                                      <div>
                                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.min')}</span>
                                          <span className="text-lg font-bold text-gray-800 dark:text-white">
                                              {performanceMonitor.getAggregated('getThumbnail') ? 
                                                  `${Math.round(performanceMonitor.getAggregated('getThumbnail')?.min || 0)} ms` : 
                                                  '0 ms'}
                                          </span>
                                      </div>
                                      <div>
                                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.max')}</span>
                                          <span className="text-lg font-bold text-gray-800 dark:text-white">
                                              {performanceMonitor.getAggregated('getThumbnail') ? 
                                                  `${Math.round(performanceMonitor.getAggregated('getThumbnail')?.max || 0)} ms` : 
                                                  '0 ms'}
                                          </span>
                                      </div>
                                  </div>
                                  
                                  {/* 缓存命中�?*/}
                                  <div className="mt-4">
                                      <div className="flex justify-between items-center text-sm mb-1">
                                          <span className="text-gray-600 dark:text-gray-400">{t('settings.performance.cacheHitRate')}</span>
                                          <span className="font-medium text-gray-800 dark:text-white">
                                              {(() => {
                                                  const hitCount = performanceMonitor.getCounter('thumbnailCacheHit');
                                                  const missCount = performanceMonitor.getCounter('thumbnailCacheMiss');
                                                  const total = hitCount + missCount;
                                                  return total > 0 ? `${Math.round((hitCount / total) * 100)}%` : '0%';
                                              })()}
                                          </span>
                                      </div>
                                      <div className="h-2 bg-gray-200 dark:bg-gray-600 rounded overflow-hidden">
                                          {(() => {
                                              const hitCount = performanceMonitor.getCounter('thumbnailCacheHit');
                                              const missCount = performanceMonitor.getCounter('thumbnailCacheMiss');
                                              const total = hitCount + missCount;
                                              const hitRate = total > 0 ? (hitCount / total) * 100 : 0;
                                              return (
                                                  <>
                                                      <div 
                                                          className="h-full bg-green-500 transition-all duration-300 ease-out" 
                                                          style={{ width: `${hitRate}%` }}
                                                      />
                                                      <div 
                                                          className="h-full bg-red-500 transition-all duration-300 ease-out" 
                                                          style={{ width: `${100 - hitRate}%` }}
                                                      />
                                                  </>
                                              );
                                          })()}
                                      </div>
                                  </div>
                              </div>
                              
                              {/* 文件扫描性能 */}
                              <div className="bg-gray-50 dark:bg-gray-700/30 rounded-xl p-4 border border-gray-200 dark:border-gray-800">
                                  <h4 className="text-md font-semibold text-gray-800 dark:text-white mb-3 flex items-center">
                                      <Timer size={16} className="mr-2 text-blue-500"/>
                                      {t('settings.performance.fileScanning')}
                                  </h4>
                                  
                                  <div className="grid grid-cols-3 gap-3">
                                      <div>
                                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.average')}</span>
                                          <span className="text-lg font-bold text-gray-800 dark:text-white">
                                              {performanceMonitor.getAggregated('scanDirectory') ? 
                                                  `${Math.round(performanceMonitor.getAggregated('scanDirectory')?.average || 0)} ms` : 
                                                  '0 ms'}
                                          </span>
                                      </div>
                                      <div>
                                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.min')}</span>
                                          <span className="text-lg font-bold text-gray-800 dark:text-white">
                                              {performanceMonitor.getAggregated('scanDirectory') ? 
                                                  `${Math.round(performanceMonitor.getAggregated('scanDirectory')?.min || 0)} ms` : 
                                                  '0 ms'}
                                          </span>
                                      </div>
                                      <div>
                                          <span className="text-xs font-medium text-gray-500 dark:text-gray-400 block mb-1">{t('settings.performance.max')}</span>
                                          <span className="text-lg font-bold text-gray-800 dark:text-white">
                                              {performanceMonitor.getAggregated('scanDirectory') ? 
                                                  `${Math.round(performanceMonitor.getAggregated('scanDirectory')?.max || 0)} ms` : 
                                                  '0 ms'}
                                          </span>
                                      </div>
                                  </div>
                                  
                                  {/* 扫描文件总数 */}
                                  <div className="mt-4">
                                      <div className="flex justify-between items-center text-sm">
                                          <span className="text-gray-600 dark:text-gray-400">{t('settings.performance.filesScanned')}</span>
                                          <span className="font-bold text-gray-800 dark:text-white">
                                              {(() => {
                                                  const scanMetrics = performanceMonitor.getMetrics(undefined, 'filesScanned');
                                                  if (scanMetrics.length > 0) {
                                                      // 显示最近一次扫描的文件数，而不是累计数
                                                      const latestMetric = scanMetrics.reduce((latest, current) => 
                                                          current.timestamp > latest.timestamp ? current : latest
                                                      );
                                                      return latestMetric.value;
                                                  }
                                                  return 0;
                                              })()}
                                          </span>
                                      </div>
                                  </div>
                              </div>
                          </div>
                          
                          {/* 性能监控控制 */}
                          <div className="mt-8 space-y-4">
                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.performance.enabled')}</span>
                                  <button 
                                      onClick={() => {
                                          const currentConfig = performanceMonitor.getConfig();
                                          performanceMonitor.updateConfig({ enabled: !currentConfig.enabled });
                                      }}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${performanceMonitor.getConfig().enabled ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${performanceMonitor.getConfig().enabled ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              
                              <div className="flex items-center justify-between">
                                  <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.performance.memoryMonitoring')}</span>
                                  <button 
                                      onClick={() => {
                                          const currentConfig = performanceMonitor.getConfig();
                                          performanceMonitor.updateConfig({ enableMemoryMonitoring: !currentConfig.enableMemoryMonitoring });
                                      }}
                                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${performanceMonitor.getConfig().enableMemoryMonitoring ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
                                  >
                                      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${performanceMonitor.getConfig().enableMemoryMonitoring ? 'translate-x-5' : 'translate-x-1'}`} />
                                  </button>
                              </div>
                              
                              <div className="space-y-4 pt-4">
                                  {/* 自动刷新频率 */}
                                  <div className="flex items-center justify-between">
                                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.performance.refreshInterval')}</span>
                                      <select 
                                          value={refreshInterval / 1000} 
                                          onChange={(e) => {
                                              const newInterval = parseInt(e.target.value) * 1000;
                                              onUpdateSettingsData({
                                                  ...state.settings,
                                                  performance: {
                                                      ...state.settings.performance,
                                                      refreshInterval: newInterval
                                                  }
                                              });
                                          }}
                                          className="bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded px-2 py-1 text-sm outline-none text-gray-800 dark:text-gray-200"
                                      >
                                          <option value="1">1秒</option>
                                          <option value="5">5秒</option>
                                          <option value="10">10秒</option>
                                          <option value="30">30秒</option>
                                          <option value="60">1分钟</option>
                                      </select>
                                  </div>
                                  
                                  {/* 清除数据按钮 */}
                                  <div className="flex space-x-3">
                                      <button 
                                          onClick={() => performanceMonitor.clearMetrics()}
                                          className="flex-1 px-4 py-2 bg-gray-100 dark:bg-gray-800 hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-lg transition-colors border border-gray-200 dark:border-gray-800 text-sm flex items-center justify-center"
                                      >
                                          <RefreshCw size={14} className="mr-2"/>
                                          {t('settings.performance.clearData')}
                                      </button>
                                  </div>
                              </div>
                          </div>
                      </section>
                  </div>
              )}

              {state.settingsCategory === 'about' && (
                  <AboutPanel
                      t={t}
                      onCheckUpdate={onCheckUpdate || (() => {})}
                      updateInfo={updateInfo || null}
                      isChecking={isCheckingUpdate || false}
                      downloadProgress={downloadProgress}
                      onInstallUpdate={onInstallUpdate}
                      onOpenDownloadFolder={onOpenDownloadFolder}
                  />
              )}
          </div>
      </div>
      
      {/* 图片预览模态框 */}
      {previewFile && (
          <div 
              className="fixed inset-0 z-[200] bg-black/80 flex items-center justify-center p-4 backdrop-blur-sm"
              onClick={closePreview}
          >
              <div 
                  className="bg-white dark:bg-gray-800 rounded-xl max-w-4xl max-h-[90vh] w-full overflow-hidden shadow-2xl"
                  onClick={e => e.stopPropagation()}
              >
                  {/* 标题栏 */}
                  <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-700">
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
                              className="p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                              title={t('context.openFolder')}
                          >
                              <FolderOpen size={18}/>
                          </button>
                          <button
                              onClick={() => handleDeleteSingle(previewFile)}
                              disabled={isDeleting}
                              className="p-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 rounded-lg transition-colors"
                              title={t('context.delete')}
                          >
                              <Trash size={18}/>
                          </button>
                          <button
                              onClick={closePreview}
                              className="p-2 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
                          >
                              <X size={18}/>
                          </button>
                      </div>
                  </div>
                  
                  {/* 图片预览区域 */}
                  <div className="p-4 bg-gray-100 dark:bg-gray-900 flex items-center justify-center" style={{ minHeight: '300px', maxHeight: '60vh' }}>
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
                              <Image size={48} className="mx-auto mb-3 text-gray-400 dark:text-gray-600"/>
                              <p className="text-sm text-gray-500 dark:text-gray-400">
                                  {t('settings.previewError')}
                              </p>
                          </div>
                      )}
                  </div>
                  
                  {/* 底部信息 */}
                  <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50">
                      <p className="text-xs text-gray-500 dark:text-gray-400 break-all">
                          {t('settings.filePath')}: {previewFile.path}
                      </p>
                  </div>
              </div>
          </div>
      )}
    </div>
  );
};
