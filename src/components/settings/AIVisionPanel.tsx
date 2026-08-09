import React, { useState, useEffect, useRef } from 'react';
import { Sparkles, Info, ChevronUp, ChevronDown, Download, Check, AlertCircle, Zap, HardDrive, Activity, RefreshCw, Trash, Play, Pause, Square, Brain, Cpu, XCircle, FolderOpen, Trash2 } from 'lucide-react';
import { ClipSettings, ClipModelName, ModelSeries } from '../../types';
import { MODEL_SERIES, FEATURE_LABELS, CLIP_MODELS, globalEmbeddingState } from './constants';
import { formatEstimatedTime, formatSpeed, formatBytes } from './utils';
import { ConfirmModal } from '../modals/ConfirmModal';
import {
  clipGetModelStatus,
  clipDeleteModel,
  clipLoadModel,
  clipUnloadModel,
  clipCancelModelDownload,
  clipPauseModelDownload,
  clipResumeModelDownload,
  clipGenerateEmbeddingsBatch,
  clipGetEmbeddingStats,
  getAllImageFiles,
  clipCancelEmbeddingGeneration,
  clipPauseEmbeddingGeneration,
  clipResumeEmbeddingGeneration,
  listenClipEmbeddingProgress,
  listenClipEmbeddingCompleted,
  listenClipEmbeddingCancelled,
  ClipModelStatus,
} from '../../api/tauri-bridge';
import {
  getCachedModelStatuses,
  setCachedModelStatuses,
  getCachedModelStatus,
  markModelAsCorrupted,
  markModelAsNormal,
  getCorruptedModels,
  pauseModelDownload,
  resumeModelDownload,
  getPausedDownloads,
  getDownloadError,
  subscribeToModelDownload,
  getActiveDownloads,
  setCurrentDownloadingModel,
  completeModelDownload,
  errorModelDownload,
} from '../../utils/modelDownloadState';

// AI视觉面板组件
interface AIVisionPanelProps {
  t: (key: string) => string;
  settings: ClipSettings;
  onUpdateSettings: (settings: ClipSettings) => void;
  onShowToast?: (msg: string, duration?: number) => void;
  onEnabledChange?: (enabled: boolean) => void;
  onClipSearchDisabled?: () => void;
  clipLoading?: boolean;
  onRefresh?: () => void;
  language?: 'zh' | 'en';
}

const AIVisionPanel: React.FC<AIVisionPanelProps> = ({ t, settings, onUpdateSettings, onShowToast, onEnabledChange, onClipSearchDisabled, clipLoading, onRefresh, language }) => {
  const getInitialSeries = (): ModelSeries => {
    if (settings.modelName) {
      const currentModel = CLIP_MODELS.find(m => m.name === settings.modelName);
      if (currentModel) {
        return currentModel.series;
      }
    }
    return 'siglip';
  };

  const [showClipGuide, setShowClipGuide] = useState(false);
  const [activeSeries, setActiveSeries] = useState<ModelSeries>(getInitialSeries);

  // 从全局缓存初始化模型状态
  const [modelStatuses, setModelStatuses] = useState<Record<string, ClipModelStatus>>(() => {
    const cached = getCachedModelStatuses();
    return cached || {};
  });
  const [isLoading, setIsLoading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<Record<string, { fileName: string; fileIndex: number; totalFiles: number; progress: number; downloaded: number; total: number; speed: number }>>(() => {
    const activeDownloads = getActiveDownloads();
    const initial: Record<string, { fileName: string; fileIndex: number; totalFiles: number; progress: number; downloaded: number; total: number; speed: number }> = {};
    activeDownloads.forEach(d => {
      initial[d.modelName] = {
        fileName: d.fileName,
        fileIndex: d.fileIndex,
        totalFiles: d.totalFiles,
        progress: d.progress,
        downloaded: d.downloaded,
        total: d.total,
        speed: d.speed,
      };
    });
    return initial;
  });
  // loadingModel 也从全局状态初始化
  const [loadingModel, setLoadingModel] = useState<string | null>(() => {
    const activeDownloads = getActiveDownloads();
    return activeDownloads.length > 0 ? activeDownloads[0].modelName : null;
  });
  // 正在下载的模型集合（支持并发/排队时的正确状态）
  const [downloadingModels, setDownloadingModels] = useState<Set<string>>(() => {
    const activeDownloads = getActiveDownloads();
    return new Set(activeDownloads.map(d => d.modelName));
  });
  // 已暂停下载的模型集合（用于显示 暂停/继续 按钮状态）
  const [pausedDownloads, setPausedDownloads] = useState<Set<string>>(() => {
    const paused = getPausedDownloads();
    return new Set(paused.map(d => d.modelName));
  });
  // 下载失败的模型错误信息（模型名 -> 错误说明），用于在卡片中展示
  const [downloadErrors, setDownloadErrors] = useState<Record<string, string>>(() => {
    const errors: Record<string, string> = {};
    CLIP_MODELS.forEach(m => {
      const err = getDownloadError(m.name);
      if (err) {
        errors[m.name] = err;
      }
    });
    return errors;
  });
  const [embeddingCount, setEmbeddingCount] = useState(0);
  const [embeddingRootPath, setEmbeddingRootPath] = useState('');
  const [embeddingModelName, setEmbeddingModelName] = useState('');
  // 添加延迟显示加载状态，避免闪烁
  const [showLoadingDelay, setShowLoadingDelay] = useState(false);
  // 待删除确认的模型
  const [deleteTarget, setDeleteTarget] = useState<ClipModelName | null>(null);
  // 跟踪模型损坏状态 - 从全局状态初始化
  const [corruptedModels, setCorruptedModels] = useState<Set<string>>(() => {
    const corrupted = getCorruptedModels();
    return new Set(corrupted);
  });
  const [isGeneratingEmbeddings, setIsGeneratingEmbeddings] = useState(globalEmbeddingState.isGenerating);
  const [generationProgress, setGenerationProgress] = useState(globalEmbeddingState.progress);
  const [generationStats, setGenerationStats] = useState(globalEmbeddingState.stats);
  const [estimatedTime, setEstimatedTime] = useState(globalEmbeddingState.estimatedTimeRemaining);
  const [isCancelling, setIsCancelling] = useState(globalEmbeddingState.isCancelling);
  const [isPaused, setIsPaused] = useState(globalEmbeddingState.isPaused);
  const progressListenersRef = useRef<(() => void)[]>([]);
  const downloadListenerRef = useRef<(() => void) | null>(null);
  const isMountedRef = useRef(true);
  // 全局下载状态订阅
  const downloadUnsubscribeRef = useRef<(() => void) | null>(null);
  // 防止重复加载
  const isLoadingRef = useRef(false);

  // 同步状态到全局状态
  useEffect(() => {
    globalEmbeddingState.isGenerating = isGeneratingEmbeddings;
  }, [isGeneratingEmbeddings]);

  useEffect(() => {
    globalEmbeddingState.progress = generationProgress;
  }, [generationProgress]);

  useEffect(() => {
    globalEmbeddingState.stats = generationStats;
  }, [generationStats]);

  useEffect(() => {
    globalEmbeddingState.estimatedTimeRemaining = estimatedTime;
  }, [estimatedTime]);

  useEffect(() => {
    globalEmbeddingState.isPaused = isPaused;
  }, [isPaused]);

  useEffect(() => {
    globalEmbeddingState.isCancelling = isCancelling;
  }, [isCancelling]);

  // 订阅全局模型下载状态，保持进度在切换标签页时不丢失
  useEffect(() => {
    const unsubscribe = subscribeToModelDownload((modelName, info) => {
      setDownloadProgress(prev => ({
        ...prev,
        [modelName]: {
          fileName: info.fileName,
          fileIndex: info.fileIndex,
          totalFiles: info.totalFiles,
          progress: info.progress,
          downloaded: info.downloaded,
          total: info.total,
          speed: info.speed,
        }
      }));

      // 如果正在下载或暂停，更新 loadingModel 状态
      if (info.status === 'downloading' || info.status === 'paused') {
        setLoadingModel(modelName as ClipModelName);
        setDownloadingModels(prev => new Set(prev).add(modelName));
        if (info.status === 'paused') {
          setPausedDownloads(prev => new Set(prev).add(modelName));
        }
        // 重新下载/继续时清除该模型的错误提示
        setDownloadErrors(prev => {
          if (!prev[modelName]) return prev;
          const next = { ...prev };
          delete next[modelName];
          return next;
        });
      } else if (info.status === 'completed' || info.status === 'error') {
        // 下载完成或出错时，如果当前是这个模型，清除 loadingModel
        setLoadingModel(prev => prev === modelName ? null : prev);
        setDownloadingModels(prev => {
          const next = new Set(prev);
          next.delete(modelName);
          return next;
        });
        setPausedDownloads(prev => {
          const next = new Set(prev);
          next.delete(modelName);
          return next;
        });
        if (info.status === 'completed') {
          // 下载成功清除错误
          setDownloadErrors(prev => {
            if (!prev[modelName]) return prev;
            const next = { ...prev };
            delete next[modelName];
            return next;
          });
        } else if (info.status === 'error' && info.errorMessage) {
          // 下载失败记录错误说明
          const errorMsg: string = info.errorMessage;
          setDownloadErrors(prev => ({ ...prev, [modelName]: errorMsg }));
        }
      }
    });

    return () => {
      unsubscribe();
    };
  }, []);

  // 加载模型状态和嵌入数量
  useEffect(() => {
    isMountedRef.current = true;

    // 清除过期的下载错误状态（如果错误是之前的，现在应该清除）
    if (settings.downloadStatus === 'error') {
      onUpdateSettings({
        ...settings,
        downloadStatus: 'not_started',
        downloadError: undefined,
      });
    }

    // 检查是否有有效的缓存，如果有则跳过加载
    const cached = getCachedModelStatuses();
    if (cached) {
      setModelStatuses(cached);
    }
    // 拉取模型状态时使用静默模式，避免触发所有模型卡片显示"加载中..."
    loadModelStatuses(true);

    loadEmbeddingCount();

    return () => {
      isMountedRef.current = false;
    };
  }, []);

  // 当 GPU 设置变更时，刷新模型状态以显示“GPU 已激活”标签
  useEffect(() => {
    loadModelStatuses(true);
  }, [settings.useGpu]);

  // 延迟显示加载状态，避免闪烁
  useEffect(() => {
    if (isLoading) {
      const timer = setTimeout(() => {
        if (isMountedRef.current) {
          setShowLoadingDelay(true);
        }
      }, 300);
      return () => clearTimeout(timer);
    } else {
      setShowLoadingDelay(false);
    }
  }, [isLoading]);

  // 设置进度事件监听 - 使用全局单例模式确保只有一个监听实例
  useEffect(() => {
    // 如果全局已经初始化过监听器，只需要同步状态到本地
    if (globalEmbeddingState.isInitialized) {
      setIsGeneratingEmbeddings(globalEmbeddingState.isGenerating);
      setGenerationProgress(globalEmbeddingState.progress);
      setGenerationStats(globalEmbeddingState.stats);
      setEstimatedTime(globalEmbeddingState.estimatedTimeRemaining);
      setIsPaused(globalEmbeddingState.isPaused);
      setIsCancelling(globalEmbeddingState.isCancelling);
      return;
    }

    globalEmbeddingState.isInitialized = true;

    // 监听进度事件
    const setupListeners = async () => {
      try {
        const unlistenProgress = await listenClipEmbeddingProgress((data) => {
          console.log('CLIP progress:', data);
          globalEmbeddingState.isGenerating = true;
          globalEmbeddingState.progress = data.progress;
          globalEmbeddingState.stats = {
            current: data.current,
            total: data.total,
            success: data.success,
            failed: data.failed,
            skipped: data.skipped || 0,
            processed: data.processed || 0,
          };

          // 计算预估剩余时间
          if (data.timestamp && data.current > 0 && data.current < data.total) {
            const elapsedMs = data.timestamp;
            const elapsedSeconds = elapsedMs / 1000;
            const rate = data.current / elapsedSeconds; // 每秒处理的文件数
            const remainingFiles = data.total - data.current;
            const estimatedSeconds = remainingFiles / rate;
            globalEmbeddingState.estimatedTimeRemaining = Math.ceil(estimatedSeconds);
          }

          if (isMountedRef.current) {
            setIsGeneratingEmbeddings(true);
            setGenerationProgress(data.progress);
            setGenerationStats(globalEmbeddingState.stats);
            setEstimatedTime(globalEmbeddingState.estimatedTimeRemaining);
          }
        });

        const unlistenCompleted = await listenClipEmbeddingCompleted((data) => {
          console.log('CLIP completed:', data);
          globalEmbeddingState.isGenerating = false;
          globalEmbeddingState.progress = 0;
          globalEmbeddingState.estimatedTimeRemaining = 0;
          globalEmbeddingState.isCancelling = false;
          globalEmbeddingState.isPaused = false;

          if (isMountedRef.current) {
            setIsGeneratingEmbeddings(false);
            setGenerationProgress(0);
            setEstimatedTime(0);
            setIsCancelling(false);
            setIsPaused(false);
            loadEmbeddingCount();
            if (data.cancelled) {
              onShowToast?.(`生成已取消！成功: ${data.success}, 失败: ${data.failed}`, 4000);
            } else {
              onShowToast?.(`嵌入向量生成完成！成功: ${data.success}, 失败: ${data.failed}`, 4000);
            }
          }
        });

        const unlistenCancelled = await listenClipEmbeddingCancelled((data) => {
          console.log('CLIP cancelled:', data);
          globalEmbeddingState.isGenerating = false;
          globalEmbeddingState.estimatedTimeRemaining = 0;
          globalEmbeddingState.isCancelling = false;
          globalEmbeddingState.isPaused = false;

          if (isMountedRef.current) {
            setIsGeneratingEmbeddings(false);
            setEstimatedTime(0);
            setIsCancelling(false);
            setIsPaused(false);
          }
        });

        globalEmbeddingState.listeners = [unlistenProgress, unlistenCompleted, unlistenCancelled];
        progressListenersRef.current = [unlistenProgress, unlistenCompleted, unlistenCancelled];
      } catch (error) {
        console.error('Failed to setup progress listeners:', error);
      }
    };

    setupListeners();

    // 组件卸载时不清理全局监听器，只清理本地引用
    return () => {
      progressListenersRef.current = [];
    };
  }, [])

  const loadModelStatuses = async (silent: boolean = false) => {
    // 防止重复加载
    if (isLoadingRef.current) {
      return;
    }

    isLoadingRef.current = true;
    // 静默模式下不显示加载状态
    if (!silent) {
      setIsLoading(true);
    }

    try {
      const statuses: Record<string, ClipModelStatus> = {};
      for (const model of CLIP_MODELS) {
        if (!isMountedRef.current) {
          return;
        }
        const status = await clipGetModelStatus(model.name);
        statuses[model.name] = status;
      }
      if (isMountedRef.current) {
        setModelStatuses(statuses);
        // 保存到全局缓存
        setCachedModelStatuses(statuses);

        // 如果所有模型都已下载且没有错误，清除下载错误状态
        const allDownloaded = CLIP_MODELS.every(model => statuses[model.name]?.is_downloaded);
        if (allDownloaded && settings.downloadStatus === 'error') {
          onUpdateSettings({
            ...settings,
            downloadStatus: 'completed',
            downloadError: undefined,
          });
        }
      }
    } catch (error) {
      console.error('Failed to load model statuses:', error);
    } finally {
      isLoadingRef.current = false;
      if (isMountedRef.current) {
        setIsLoading(false);
      }
    }
  };

  const handleDownload = async (modelName: ClipModelName) => {
    setLoadingModel(modelName);

    // 开始全新下载，清除该模型的暂停状态与错误提示，避免显示错误的"已暂停"UI
    setPausedDownloads(prev => {
      const next = new Set(prev);
      next.delete(modelName);
      return next;
    });
    setDownloadErrors(prev => {
      if (!prev[modelName]) return prev;
      const next = { ...prev };
      delete next[modelName];
      return next;
    });

    // 清理之前的下载进度
    setDownloadProgress(prev => ({ ...prev, [modelName]: { fileName: '', fileIndex: 0, totalFiles: 3, progress: 0, downloaded: 0, total: 0, speed: 0 } }));

    onUpdateSettings({
      ...settings,
      modelName,
      downloadStatus: 'downloading',
      downloadProgress: 0,
    });

    // 设置下载进度监听
    if (downloadListenerRef.current) {
      downloadListenerRef.current();
      downloadListenerRef.current = null;
    }

    try {
      // 获取模型显示名称
      const modelDisplayName = CLIP_MODELS.find(m => m.name === modelName)?.displayName || modelName;

      // 设置当前正在下载的模型，启动全局 Tauri 事件监听
      setCurrentDownloadingModel(modelName, modelDisplayName);

      // 加载模型（会自动下载）
      await clipLoadModel(modelName);

      // 从损坏列表中移除（下载成功）
      setCorruptedModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });
      markModelAsNormal(modelName);

      onUpdateSettings({
        ...settings,
        modelName,
        downloadStatus: 'completed',
        downloadProgress: 100,
        downloadedAt: Date.now(),
      });

      // 标记下载完成
      completeModelDownload(modelName);

      // 刷新状态
      await loadModelStatuses();
    } catch (error) {
      console.error('Failed to download model:', error);
      const errorMsg = String(error);
      
      // 检测是否是文件损坏导致的错误（含 ONNX 反序列化失败 / 外部权重越界等）
      const isCorrupt = errorMsg.includes('模型文件可能已损坏') ||
        errorMsg.includes('Protobuf parsing failed') ||
        errorMsg.includes('Invalid protobuf') ||
        errorMsg.includes('ModelWrapper') ||
        errorMsg.includes('Deserialize tensor') ||
        errorMsg.includes('GetExtDataFromTensorProto') ||
        errorMsg.includes('out of bounds') ||
        errorMsg.includes('can not be read in full') ||
        errorMsg.includes('onnxruntime') ||
        errorMsg.includes('Failed to initialize ONNX');
      
      if (isCorrupt) {
        // 标记模型为损坏状态
        setCorruptedModels(prev => new Set(prev).add(modelName));
        markModelAsCorrupted(modelName);
        onShowToast?.(`模型文件下载不完整或已损坏，请点击"重新下载"`, 4000);
      }
      
      onUpdateSettings({
        ...settings,
        downloadStatus: 'error',
        downloadError: errorMsg,
      });

      // 标记下载错误
      errorModelDownload(modelName, errorMsg);
    } finally {
      setLoadingModel(null);
      // 注意：不再清理 Tauri 监听，因为全局监听器需要保持运行
      // 全局监听器会在组件挂载时自动复用
    }
  };

  // 取消当前正在进行的模型下载
  const handleCancelDownload = async () => {
    try {
      await clipCancelModelDownload();
      // 清空所有下载中的模型状态
      setLoadingModel(null);
      setDownloadingModels(new Set());
      setPausedDownloads(new Set());
      setDownloadProgress({});
      onShowToast?.(`已停止下载`, 3000);
    } catch (error) {
      console.error('Failed to cancel model download:', error);
      onShowToast?.(`取消失败: ${error}`, 4000);
    }
  };

  // 暂停当前正在进行的模型下载（断点续传）
  const handlePauseDownload = async (modelName: ClipModelName) => {
    try {
      await clipPauseModelDownload();
      // 标记该模型为暂停状态
      setPausedDownloads(prev => new Set(prev).add(modelName));
      pauseModelDownload(modelName);
      onShowToast?.(`已暂停下载，可随时继续`, 3000);
    } catch (error) {
      console.error('Failed to pause model download:', error);
      onShowToast?.(`暂停失败: ${error}`, 4000);
    }
  };

  // 继续已暂停的模型下载（基于 HTTP Range 断点续传）
  const handleResumeDownload = async (modelName: ClipModelName) => {
    try {
      await clipResumeModelDownload();
      // 恢复下载状态
      setPausedDownloads(prev => {
        const next = new Set(prev);
        next.delete(modelName);
        return next;
      });
      resumeModelDownload(modelName);
      onShowToast?.(`已继续下载`, 3000);
    } catch (error) {
      console.error('Failed to resume model download:', error);
      onShowToast?.(`继续失败: ${error}`, 4000);
    }
  };

  // 点击删除按钮：弹出确认框
  const handleDelete = (modelName: ClipModelName) => {
    setDeleteTarget(modelName);
  };

  // 确认删除：卸载（若为当前使用模型）→ 删除文件 → 刷新状态
  const confirmDeleteModel = async (modelName: ClipModelName) => {
    const isCurrent = settings.enabled && settings.modelName === modelName;

    try {
      // 如果是当前正在使用的模型，先卸载，避免文件被占用/状态错乱
      if (isCurrent) {
        await clipUnloadModel();
      }

      await clipDeleteModel(modelName);
      await loadModelStatuses();

      // 如果删除的是当前选中的模型，清空 modelName 并重置下载状态
      if (settings.modelName === modelName) {
        onUpdateSettings({
          ...settings,
          modelName: '',
          downloadStatus: 'not_started',
          downloadProgress: 0,
        });
      }
    } catch (error) {
      console.error('Failed to delete model:', error);
      onShowToast?.(`删除模型失败: ${error}`, 4000);
    } finally {
      setDeleteTarget(null);
    }
  };

  // 修复损坏的模型（删除并重新下载）
  const handleRepairModel = async (modelName: ClipModelName) => {
    try {
      setIsLoading(true);
      onShowToast?.(`正在修复 ${modelName} 模型...`, 3000);

      // 1. 删除模型
      await clipDeleteModel(modelName);

      // 2. 从损坏列表中移除
      setCorruptedModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });
      // 同步更新全局状态
      markModelAsNormal(modelName);

      // 3. 如果当前正在使用这个模型，清除选择
      if (settings.modelName === modelName) {
        onUpdateSettings({
          ...settings,
          downloadStatus: 'not_started',
          downloadProgress: 0,
        });
      }

      // 4. 刷新状态
      await loadModelStatuses();

      // 5. 开始下载
      onShowToast?.(`开始重新下载 ${modelName} 模型`, 3000);
      await handleDownload(modelName);

    } catch (error) {
      console.error('Failed to repair model:', error);
      onShowToast?.(`修复模型失败: ${error}`, 4000);
    } finally {
      setIsLoading(false);
    }
  };

  const loadEmbeddingCount = async () => {
    try {
      const stats = await clipGetEmbeddingStats();
      setEmbeddingCount(stats.total_count);
      setEmbeddingRootPath(stats.root_path);
      setEmbeddingModelName(stats.model_name);
    } catch (error) {
      console.error('Failed to load embedding count:', error);
    }
  };

  const handleSelectModel = async (modelName: ClipModelName) => {
    if (settings.modelName === modelName) return;

    onUpdateSettings({ ...settings, modelName });

    // 如果切换到 WD14 模型，关闭语义搜索
    if (modelName === 'WD-EVA02-Large-Tagger-V3') {
      onClipSearchDisabled?.();
    }

    try {
      setIsLoading(true);
      await clipLoadModel(modelName);
      // 加载成功，从损坏列表中移除
      setCorruptedModels(prev => {
        const newSet = new Set(prev);
        newSet.delete(modelName);
        return newSet;
      });
      // 同步更新全局状态
      markModelAsNormal(modelName);
      await loadModelStatuses();
      // 刷新嵌入向量统计信息
      await loadEmbeddingCount();
      onShowToast?.(`已切换到 ${modelName} 模型`, 3000);
    } catch (error) {
      console.error('Failed to load model:', error);
      const errorMsg = String(error);

      // 检测是否是文件损坏导致的错误（含 ONNX 反序列化失败 / 外部权重越界等）
      const isCorrupt = errorMsg.includes('模型文件可能已损坏') ||
        errorMsg.includes('Protobuf parsing failed') ||
        errorMsg.includes('Invalid protobuf') ||
        errorMsg.includes('ModelWrapper') ||
        errorMsg.includes('Deserialize tensor') ||
        errorMsg.includes('GetExtDataFromTensorProto') ||
        errorMsg.includes('out of bounds') ||
        errorMsg.includes('can not be read in full') ||
        errorMsg.includes('onnxruntime') ||
        errorMsg.includes('Failed to initialize ONNX');

      // 检测是否是网络/下载相关的错误
      const isNetworkError = errorMsg.includes('network') ||
        errorMsg.includes('timeout') ||
        errorMsg.includes('connection') ||
        errorMsg.includes('download') ||
        errorMsg.includes('HTTP') ||
        errorMsg.includes('请求');

      if (isCorrupt) {
        // 标记模型为损坏状态
        setCorruptedModels(prev => new Set(prev).add(modelName));
        // 同步更新全局状态
        markModelAsCorrupted(modelName);
        onShowToast?.(`模型文件可能已损坏，请点击"修复"按钮重新下载`, 4000);
      } else if (isNetworkError) {
        // 网络错误，设置下载错误状态以显示手动下载提示
        onUpdateSettings({
          ...settings,
          modelName,
          downloadStatus: 'error',
          downloadError: errorMsg,
        });
        onShowToast?.(`加载模型失败: ${error}`, 4000);
      } else {
        onShowToast?.(`加载模型失败: ${error}`, 4000);
      }
    } finally {
      setIsLoading(false);
    }
  };

  const handleGenerateEmbeddings = async () => {
    // 检查是否已选择模型
    if (!settings.modelName) {
      onShowToast?.('请先选择一个模型', 3000);
      return;
    }

    // 从数据库获取文件列表
    let imageFiles: { id: string; path: string; name: string; format?: string }[] = [];
    try {
      imageFiles = await getAllImageFiles();
    } catch (error: any) {
      console.error('Failed to get image files from database:', error);
      // 根据错误类型显示不同的提示
      const toastFn = onShowToast;
      if (error?.message?.includes('需要在 Tauri 应用环境中运行')) {
        toastFn?.('请在 Tauri 应用中使用此功能（而非浏览器）', 4000);
      } else {
        toastFn?.('获取图片文件列表失败，请确保已扫描目录', 3000);
      }
      return;
    }

    if (imageFiles.length === 0) {
      onShowToast?.('没有找到图片文件，请先扫描目录', 3000);
      return;
    }

    const confirmed = confirm(`将为 ${imageFiles.length} 张图片生成 CLIP 嵌入向量，这可能需要一些时间。是否继续？`);
    if (!confirmed) return;

    setIsGeneratingEmbeddings(true);
    setGenerationProgress(0);
    setGenerationStats({ current: 0, total: imageFiles.length, success: 0, failed: 0, skipped: 0, processed: 0 });

    try {
      // 一次性发送所有文件，后端会分批处理并发送进度事件
      const fileTuples: [string, string][] = imageFiles.map(f => [f.path, f.id]);
      await clipGenerateEmbeddingsBatch(
        fileTuples, 
        settings.useGpu, 
        settings.modelName,
        false,
        0.35,
        language
      );
      // 进度和完成通过事件处理
    } catch (error: any) {
      console.error('Failed to generate embeddings:', error);
      setIsGeneratingEmbeddings(false);
      // 根据错误类型显示不同的提示
      let errorMsg = '生成嵌入向量失败';
      if (error?.message?.includes('model not loaded') || error?.includes?.('model not loaded')) {
        errorMsg = 'CLIP 模型未加载，请先下载模型';
      } else if (error?.message?.includes('not initialized') || error?.includes?.('not initialized')) {
        errorMsg = 'CLIP 服务未初始化，请重启应用';
      } else if (error?.message || typeof error === 'string') {
        errorMsg += ': ' + (error.message || error);
      }
      onShowToast?.(errorMsg, 4000);
    }
  };

  const handleCancelGeneration = async () => {
    if (!isGeneratingEmbeddings) return;

    setIsCancelling(true);
    try {
      await clipCancelEmbeddingGeneration();
      onShowToast?.('正在取消生成...', 2000);
    } catch (error) {
      console.error('Failed to cancel generation:', error);
      onShowToast?.('取消生成失败', 3000);
      setIsCancelling(false);
    }
  };

  const handlePauseGeneration = async () => {
    if (!isGeneratingEmbeddings) return;

    try {
      await clipPauseEmbeddingGeneration();
      setIsPaused(true);
      onShowToast?.('生成已暂停', 2000);
    } catch (error) {
      console.error('Failed to pause generation:', error);
      onShowToast?.('暂停生成失败', 3000);
    }
  };

  const handleResumeGeneration = async () => {
    if (!isGeneratingEmbeddings) return;

    try {
      await clipResumeEmbeddingGeneration();
      setIsPaused(false);
      onShowToast?.('生成已继续', 2000);
    } catch (error) {
      console.error('Failed to resume generation:', error);
      onShowToast?.('继续生成失败', 3000);
    }
  };

  return (
    <>
    <div className="space-y-8 animate-fade-in">
      <section>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-4 border-subtle pb-2 flex items-center">
          <Sparkles size={20} className="mr-2 text-green-500" />
          AI视觉
        </h3>
      </section>

      <section>
        <div className="bg-surface rounded-xl p-4 border border-subtle">
          <div className="flex items-center justify-between">
            <div>
              <div className="font-medium text-gray-800 dark:text-white">启用 AI 视觉功能</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                {clipLoading
                  ? (settings.enabled ? '正在加载模型...' : '正在卸载模型...')
                  : '开启后可使用自然语言搜索图片，关闭后可释放内存'}
              </div>
            </div>
            <button
              onClick={() => {
                if (clipLoading) return;
                if (onEnabledChange) {
                  onEnabledChange(!settings.enabled);
                } else {
                  onUpdateSettings({ ...settings, enabled: !settings.enabled });
                }
              }}
              disabled={clipLoading}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${clipLoading
                ? 'opacity-70 cursor-wait'
                : ''
                } ${settings.enabled ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'}`}
            >
              {clipLoading ? (
                <span className="absolute inset-0 flex items-center justify-center">
                  <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                </span>
              ) : (
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.enabled ? 'translate-x-6' : 'translate-x-1'}`} />
              )}
            </button>
          </div>
        </div>
      </section>

      {/* 使用说明 */}
      <section className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-4 mt-4">
        <button
          onClick={() => setShowClipGuide(!showClipGuide)}
          className="w-full flex items-center justify-between text-sm font-semibold text-blue-800 dark:text-blue-300"
        >
          <span className="flex items-center">
            <Info size={16} className="mr-2" />
            如何使用 CLIP 搜索
          </span>
          {showClipGuide ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </button>
        {showClipGuide && (
        <div className="text-sm text-blue-700 dark:text-blue-400 space-y-2 mt-2">
          <p>CLIP 模型可以实现自然语言图片搜索和以图搜图功能。选择适合您需求的模型进行下载。</p>

          <p className="font-medium mt-3">1. 启用 CLIP 搜索：</p>
          <ul className="list-disc list-inside ml-2 space-y-1">
            <li>返回主界面，点击顶部搜索框右侧的 ✨ 图标</li>
            <li>搜索框边框会变成绿色，表示 CLIP 语义搜索已启用</li>
          </ul>

          <p className="font-medium mt-3">2. 自然语言搜索：</p>
          <ul className="list-disc list-inside ml-2 space-y-1">
            <li>在搜索框中输入自然语言描述，如："夕阳下的海滩"、"穿红色衣服的人"</li>
            <li>按回车或点击搜索按钮</li>
            <li>系统会返回语义相似的图片</li>
          </ul>

          <p className="font-medium mt-3">3. 以图搜图：</p>
          <ul className="list-disc list-inside ml-2 space-y-1">
            <li>右键点击图片，选择"搜索相似图片"</li>
            <li>系统会找到视觉上相似的图片</li>
          </ul>

          <p className="font-medium mt-3">4. 提示：</p>
          <ul className="list-disc list-inside ml-2 space-y-1">
            <li>ViT-B/32 速度更快，适合大多数用户</li>
            <li>ViT-L/14 准确度更高，但需要更多内存</li>
            <li>首次使用时会自动加载模型，可能需要几秒钟</li>
          </ul>
        </div>
        )}
      </section>

      <section className="space-y-4">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 flex items-center">
          <Download size={16} className="mr-2" />
          可用模型
        </h4>

        {/* 模型系列标签页 */}
        <div className="border-b border-subtle">
          <div className="flex">
            {MODEL_SERIES.map((series) => {
              const modelCount = CLIP_MODELS.filter(m => m.series === series.id).length;
              const isActive = activeSeries === series.id;
              // 检查当前使用的模型是否属于这个系列
              const currentModelInSeries = CLIP_MODELS.find(m => m.name === settings.modelName)?.series === series.id;
              return (
                <button
                  key={series.id}
                  onClick={() => setActiveSeries(series.id)}
                  className={`flex-1 py-3 px-2 text-sm font-medium text-center transition-colors relative ${
                    isActive
                      ? 'text-gray-900 dark:text-white'
                      : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300'
                  }`}
                >
                  <span className="flex items-center justify-center gap-1.5">
                    {series.name}
                    {currentModelInSeries && settings.enabled && (
                      <span 
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: series.color }}
                        title="当前使用的模型在此系列中"
                      />
                    )}
                  </span>
                  <span className="ml-1.5 text-xs opacity-60">({modelCount})</span>
                  {isActive && (
                    <div
                      className="absolute bottom-0 left-0 right-0 h-0.5"
                      style={{ backgroundColor: series.color }}
                    />
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* 当前系列的模型列表 */}
        <div className="space-y-4">
          {CLIP_MODELS.filter(model => model.series === activeSeries).map((model) => {
            const status = modelStatuses[model.name];
            const isDownloaded = status?.is_downloaded ?? false;
            const isLoadingModel = downloadingModels.has(model.name);
            const isPausedModel = pausedDownloads.has(model.name);
            // 是否有其他模型正在下载/暂停（用于禁用下载按钮，避免排队困惑）
            const hasOtherDownloading = downloadingModels.size > 0 && !isLoadingModel;
            const cachedStatus = getCachedModelStatus(model.name);
            const isStatusLoading = showLoadingDelay && !status && !cachedStatus;
            const isCorrupted = corruptedModels.has(model.name);
            // 该模型是否下载失败及错误说明
            const downloadError = downloadErrors[model.name];
            const hasDownloadError = !!downloadError;

            // 获取所有功能特性（包括支持和不支持的）
            const allFeatures = Object.entries(model.features);
            // 定义功能显示顺序（不包含高精度，高精度作为独立标签显示）
            const featureOrder = ['textSearch', 'imageSearch', 'autoTagging', 'multilingual', 'animeOptimized'];
            
            // 只有启用AI视觉功能且当前模型被选中时才显示外框
            const isSelectedModel = settings.enabled && settings.modelName === model.name;
            const showGreenBorder = isDownloaded && isSelectedModel && !isCorrupted && !clipLoading && !isLoading && !isLoadingModel;
            const showRedBorder = isSelectedModel && isCorrupted;
            
            // 按钮状态：只有启用AI视觉功能且当前模型被选中时才显示"使用中"
            const isInUse = isDownloaded && isSelectedModel && !isCorrupted && !clipLoading && !isLoading && !isLoadingModel;

            // 正在加载以切换到当前模型（点击"使用"后、加载完成前）
            const isUsingLoading = isLoading && isSelectedModel && !isCorrupted;

            return (
              <div
                key={model.name}
                className={`relative rounded-xl p-5 transition-all ${showGreenBorder
                  ? 'bg-[#22C55E]'
                  : showRedBorder
                    ? 'bg-red-50 dark:bg-red-950/30'
                    : 'bg-[#f7f8fa] dark:bg-[#3a3a3a] hover:bg-[#f0f1f4] dark:hover:bg-[#414141]'
                  }`}
              >
                {/* 第一行：标题、标签、按钮 */}
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex flex-wrap items-center gap-2 mb-1">
                      <h5 className={`font-semibold ${showGreenBorder ? 'text-white' : 'text-gray-800 dark:text-white'}`}>
                        {model.displayName}
                      </h5>
                      {model.isHighPrecision && (
                        <span className={`inline-flex items-center text-xs ${showGreenBorder ? 'text-white/80' : 'text-yellow-600 dark:text-yellow-400'}`}>
                          <Sparkles size={12} className="mr-1" />
                          高精度
                        </span>
                      )}
                      {model.isRecommended && (
                        <span className={`px-2 py-0.5 text-xs rounded-full ${showGreenBorder ? 'bg-white/20 text-white' : 'bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400'}`}>
                          推荐
                        </span>
                      )}
                      {isCorrupted && (
                        <span className="px-2 py-0.5 bg-red-100 dark:bg-red-900/30 text-red-600 dark:text-red-400 text-xs rounded-full flex items-center">
                          <AlertCircle size={12} className="mr-1" />
                          文件损坏
                        </span>
                      )}
                      {isDownloaded && status?.is_gpu_active && !isCorrupted && settings.enabled && !clipLoading && (
                        <span className={`px-2 py-0.5 text-xs rounded-full flex items-center ${showGreenBorder ? 'bg-white/20 text-white' : 'bg-orange-100 dark:bg-orange-900/30 text-orange-600 dark:text-orange-400'}`}>
                          <Zap size={12} className="mr-1" />
                          GPU 已激活
                        </span>
                      )}
                    </div>
                    <p className={`text-sm mb-2 ${showGreenBorder ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`}>
                      {model.description}
                    </p>
                    {hasDownloadError && (
                      <div className="mb-3 p-2.5 rounded-lg bg-red-50 dark:bg-red-950/40 border border-red-200 dark:border-red-900/50 text-xs text-red-600 dark:text-red-400">
                        <div className="flex items-start gap-1.5">
                          <AlertCircle size={14} className="mt-0.5 shrink-0" />
                          <div className="min-w-0">
                            <div className="font-medium mb-0.5">模型下载失败</div>
                            <div className="break-all leading-relaxed">{downloadError}</div>
                          </div>
                        </div>
                      </div>
                    )}
                    <div className={`flex items-center gap-4 text-xs ${showGreenBorder ? 'text-white/90' : 'text-gray-400'}`}>
                      <span className="flex items-center">
                        <HardDrive size={12} className="mr-1" />
                        {model.sizeDisplay}
                      </span>
                      <span className="flex items-center">
                        <Activity size={12} className="mr-1" />
                        {model.embeddingDim} 维向量
                      </span>
                      {isDownloaded && status && (
                        <span className={`flex items-center ${showGreenBorder ? 'text-white' : 'text-green-500'}`}>
                          <Check size={12} className="mr-1" />
                          已下载 {formatBytes(status.downloaded_size)}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <div className="flex items-center gap-2">
                      {isStatusLoading ? (
                        <div className="px-4 py-2 bg-surface text-gray-400 rounded-lg text-sm font-medium flex items-center">
                          <RefreshCw size={16} className="mr-2 animate-spin" />
                          加载中...
                        </div>
                      ) : isCorrupted ? (
                        <button
                          onClick={() => handleRepairModel(model.name)}
                          disabled={isLoading}
                          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium transition-colors flex items-center"
                        >
                          <RefreshCw size={16} className="mr-2" />
                          重新下载
                        </button>
                      ) : isDownloaded ? (
                        <>
                          <button
                            onClick={() => settings.enabled && handleSelectModel(model.name)}
                            disabled={isLoading || clipLoading || !settings.enabled}
                            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors inline-flex items-center ${isUsingLoading
                              ? 'bg-blue-100 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 cursor-wait'
                              : isInUse
                                ? 'bg-white/20 text-white hover:bg-white/30'
                                : 'bg-surface text-gray-700 dark:text-gray-300 hover:bg-surface/70'
                              } ${!isUsingLoading && (isLoading || clipLoading || !settings.enabled) ? 'disabled:opacity-50 disabled:cursor-not-allowed' : ''}`}
                          >
                            {isUsingLoading ? (
                              <RefreshCw size={16} className="animate-spin" />
                            ) : (
                              isInUse ? '使用中' : '使用'
                            )}
                          </button>
                          <button
                            onClick={() => handleDelete(model.name)}
                            disabled={clipLoading || !settings.enabled}
                            className={`p-2 rounded-lg transition-colors ${clipLoading || !settings.enabled ? 'text-gray-300 dark:text-gray-600 cursor-not-allowed' : showGreenBorder ? 'text-white hover:text-red-600 hover:bg-white/20' : 'text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20'}`}
                            title={clipLoading ? '模型正在加载中' : !settings.enabled ? '请先启用 AI 视觉功能' : '删除模型'}
                          >
                            <Trash size={18} />
                          </button>
                        </>
                      ) : isLoadingModel ? (
                        <>
                          {/* 暂停/继续 按钮 */}
                          <button
                            onClick={() => isPausedModel
                              ? handleResumeDownload(model.name)
                              : handlePauseDownload(model.name)}
                            className={`px-4 py-2 text-white rounded-lg text-sm font-medium transition-colors flex items-center ${
                              isPausedModel
                                ? 'bg-green-500 hover:bg-green-600'
                                : 'bg-yellow-500 hover:bg-yellow-600'
                            }`}
                            title={isPausedModel ? '继续下载' : '暂停下载'}
                          >
                            {isPausedModel ? <Play size={16} className="mr-2" /> : <Pause size={16} className="mr-2" />}
                            {isPausedModel ? '继续' : '暂停'}
                          </button>
                          {/* 停止下载按钮 */}
                          <button
                            onClick={() => handleCancelDownload()}
                            className="px-4 py-2 bg-orange-500 hover:bg-orange-600 text-white rounded-lg text-sm font-medium transition-colors flex items-center"
                            title="停止下载"
                          >
                            <Square size={16} className="mr-2" />
                            停止
                          </button>
                        </>
                      ) : hasDownloadError ? (
                        <button
                          onClick={() => settings.enabled && handleDownload(model.name)}
                          disabled={hasOtherDownloading || clipLoading || !settings.enabled}
                          className="px-4 py-2 bg-orange-500 hover:bg-orange-600 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium transition-colors flex items-center"
                          title={hasOtherDownloading ? '请先完成当前下载或停止后重试' : '下载失败，点击重试'}
                        >
                          <RefreshCw size={16} className="mr-2" />
                          重试下载
                        </button>
                      ) : (
                        <button
                          onClick={() => settings.enabled && handleDownload(model.name)}
                          disabled={hasOtherDownloading || clipLoading || !settings.enabled}
                          className="px-4 py-2 bg-green-500 hover:bg-green-600 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium transition-colors flex items-center"
                          title={hasOtherDownloading ? '请先完成当前下载或停止后重试' : undefined}
                        >
                          <Download size={16} className="mr-2" />
                          下载
                        </button>
                      )}
                    </div>
                  </div>
                </div>

                {/* 第二行：功能特性标签 - 使用完整宽度 */}
                <div className="flex flex-wrap gap-1.5 mt-3">
                  <span className={`text-xs mr-1 ${showGreenBorder ? 'text-white/80' : 'text-gray-500 dark:text-gray-400'}`}>功能特性:</span>
                  {featureOrder.map((featureKey) => {
                    const featureEntry = allFeatures.find(([key]) => key === featureKey);
                    if (!featureEntry) return null;
                    const [_, enabled] = featureEntry;
                    const config = FEATURE_LABELS[featureKey];
                    if (!config) return null;
                    const IconComponent = config.icon;
                    return (
                      <span
                        key={featureKey}
                        className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs whitespace-nowrap ${
                          showGreenBorder
                            ? enabled
                              ? config.color === 'green'
                                ? 'bg-white/20 text-white'
                                : `bg-${config.color}-100 dark:bg-${config.color}-900/40 text-${config.color}-600 dark:text-${config.color}-300`
                              : 'bg-white/10 text-white/60 line-through opacity-70'
                            : enabled
                              ? `bg-${config.color}-100 dark:bg-${config.color}-900/30 text-${config.color}-600 dark:text-${config.color}-400`
                              : 'bg-surface text-gray-400 dark:text-gray-500 line-through opacity-60'
                        }`}
                        title={enabled ? '支持' : '不支持'}
                      >
                        <IconComponent size={12} className="mr-1" />
                        {config.label}
                      </span>
                    );
                  })}
                </div>

                {isLoadingModel && (
                  <div className="mt-4 space-y-3">
                    <div className="flex items-center justify-between text-xs text-gray-500 mb-2">
                      <span>总体进度: {downloadProgress[model.name]?.fileIndex ?? 0} / {downloadProgress[model.name]?.totalFiles ?? (model.name === 'WD-EVA02-Large-Tagger-V3' ? 2 : 3)} 个文件</span>
                      {isPausedModel ? (
                        <span className="text-yellow-600 font-medium">
                          已暂停
                        </span>
                      ) : (
                        <span className="text-green-600 font-medium">
                          {Math.round(((downloadProgress[model.name]?.fileIndex ?? 0) + (downloadProgress[model.name]?.progress ?? 0) / 100) / (downloadProgress[model.name]?.totalFiles ?? (model.name === 'WD-EVA02-Large-Tagger-V3' ? 2 : 3)) * 100)}%
                        </span>
                      )}
                    </div>
                    {downloadProgress[model.name]?.fileName && (
                      <div className="bg-surface rounded-lg p-3">
                        <div className="flex items-center justify-between text-xs mb-1">
                          <span className="text-gray-700 dark:text-gray-300 truncate max-w-[60%]">
                            {downloadProgress[model.name].fileName}
                          </span>
                          <span className="text-gray-500">
                            {downloadProgress[model.name].progress}%
                          </span>
                        </div>
                        <div className="h-1.5 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden">
                          <div
                            className={`h-full transition-all duration-300 ${isPausedModel ? 'bg-yellow-500' : 'bg-green-500'}`}
                            style={{ width: `${downloadProgress[model.name].progress}%` }}
                          />
                        </div>
                        <div className="flex items-center justify-between text-[10px] text-gray-500 mt-1">
                          <span>
                            {(downloadProgress[model.name].downloaded / 1024 / 1024).toFixed(1)} MB /
                            {(downloadProgress[model.name].total / 1024 / 1024).toFixed(1)} MB
                          </span>
                          {isPausedModel ? (
                            <span className="text-yellow-600">已暂停，可继续</span>
                          ) : (
                            <span className={downloadProgress[model.name].speed > 0 ? "text-green-600" : "text-gray-400"}>
                              {formatSpeed(downloadProgress[model.name].speed)}
                            </span>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* 嵌入向量生成 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <Brain size={16} className="mr-2" />
          嵌入向量生成
        </h4>
        <div className="bg-surface rounded-xl p-4 border border-subtle">
          <div className="flex items-center justify-between mb-3">
            <div>
              <div className="font-medium text-gray-800 dark:text-white">生成图片嵌入向量</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                为所有图片生成嵌入向量，用于语义搜索、以图搜图和标签识别
              </div>
            </div>
            {!isGeneratingEmbeddings && (
              <div className="text-right">
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  已生成: <span className="font-semibold text-green-600">{embeddingCount}</span> 张
                </div>
                {embeddingModelName && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-1">
                    模型: {embeddingModelName}
                  </div>
                )}
                {embeddingRootPath && (
                  <div className="text-xs text-gray-400 dark:text-gray-500 mt-1 max-w-[200px] truncate" title={embeddingRootPath}>
                    目录: {embeddingRootPath.split(/[\\/]/).pop()}
                  </div>
                )}
              </div>
            )}
          </div>

          {isGeneratingEmbeddings ? (
            <div className="mt-3">
              <div className="flex items-center justify-between mb-2">
                <div className="text-sm text-gray-600 dark:text-gray-400">
                  {isCancelling ? (
                    <span className="font-semibold text-orange-600">正在取消...</span>
                  ) : isPaused ? (
                    <span className="font-semibold text-yellow-600">已暂停</span>
                  ) : (
                    <span className="font-semibold text-blue-600">{generationStats.current}</span>
                  )}
                  {!isCancelling && (
                    <span className="text-gray-400"> / {generationStats.total}</span>
                  )}
                  <span className="ml-2 text-xs">
                    (成功: <span className="text-green-600">{generationStats.success}</span>
                    {generationStats.failed > 0 && (
                      <>, 失败: <span className="text-red-600">{generationStats.failed}</span></>
                    )}
                    {generationStats.skipped > 0 && (
                      <>, 已存在: <span className="text-gray-500">{generationStats.skipped}</span></>
                    )})
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {/* 暂停/继续按钮 - 纯图标样式 */}
                  {!isCancelling && (
                    <button
                      onClick={isPaused ? handleResumeGeneration : handlePauseGeneration}
                      className={`p-1.5 rounded-md transition-colors ${isPaused
                        ? 'text-green-600 hover:bg-green-50 dark:text-green-400 dark:hover:bg-green-900/20'
                        : 'text-yellow-600 hover:bg-yellow-50 dark:text-yellow-400 dark:hover:bg-yellow-900/20'
                        }`}
                      title={isPaused ? '继续生成' : '暂停生成'}
                    >
                      {isPaused ? <Play size={16} fill="currentColor" /> : <Pause size={16} fill="currentColor" />}
                    </button>
                  )}
                  {/* 取消按钮 - 纯图标样式 */}
                  <button
                    onClick={handleCancelGeneration}
                    disabled={isCancelling}
                    className="p-1.5 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                    title="取消生成"
                  >
                    <XCircle size={16} fill={isCancelling ? "currentColor" : "none"} strokeWidth={isCancelling ? 2.5 : 2} />
                  </button>
                </div>
              </div>

              {/* 进度条 - 取消时显示发射动画 */}
              <div className="h-2 bg-black/10 dark:bg-white/10 rounded-full overflow-hidden relative">
                {isCancelling ? (
                  // 取消时的发射动画
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-orange-400 to-transparent animate-shimmer"
                    style={{
                      animation: 'shimmer 1.5s infinite',
                      background: 'linear-gradient(90deg, transparent 0%, rgba(251, 146, 60, 0.8) 50%, transparent 100%)',
                      backgroundSize: '200% 100%'
                    }}
                  />
                ) : (
                  // 正常进度条
                  <div
                    className={`h-full transition-all duration-300 ${isPaused ? 'bg-yellow-500' : 'bg-blue-500'}`}
                    style={{ width: `${generationProgress}%` }}
                  />
                )}
              </div>

              <p className="text-xs text-gray-500 mt-1">
                {isCancelling ? (
                  <span className="text-orange-600">正在取消生成，请稍候...</span>
                ) : isPaused ? (
                  <span className="text-yellow-600">生成已暂停，点击继续按钮恢复</span>
                ) : (
                  <>
                    正在生成嵌入向量... {generationProgress}%
                    {generationStats.processed > 0 && (
                      <span className="ml-2">(实际处理: {generationStats.processed} 张)</span>
                    )}
                    {estimatedTime > 0 && (
                      <span className="ml-2 text-blue-600">预计剩余: {formatEstimatedTime(estimatedTime)}</span>
                    )}
                  </>
                )}
              </p>
            </div>
          ) : (
            <button
              onClick={handleGenerateEmbeddings}
              disabled={isGeneratingEmbeddings || !(modelStatuses[settings.modelName]?.is_downloaded ?? false) || !settings.enabled}
              className="mt-2 px-4 py-2 bg-blue-500 hover:bg-blue-600 disabled:bg-gray-300 text-white rounded-lg text-sm font-medium transition-colors flex items-center"
            >
              <Brain size={16} className="mr-2" />
              开始生成
            </button>
          )}
        </div>
      </section>

      {/* 高级选项 */}
      <section>
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-4 flex items-center">
          <Cpu size={16} className="mr-2" />
          高级选项
        </h4>
        <div className="bg-surface rounded-xl p-4 border border-subtle space-y-4">
          {/* GPU 加速 */}
          <div className={`flex items-center justify-between ${settings.enabled ? '' : 'opacity-50'}`}>
            <div>
              <div className="font-medium text-gray-800 dark:text-white">启用 GPU 加速</div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                使用 DirectML 加速模型推理（需要支持 DirectX 12 的显卡）
              </div>
            </div>
            <button
              onClick={() => settings.enabled && onUpdateSettings({ ...settings, useGpu: !settings.useGpu })}
              disabled={!settings.enabled}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings.useGpu ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'} ${!settings.enabled ? 'cursor-not-allowed' : ''}`}
            >
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings.useGpu ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          
          {/* 相似度阈值 */}
          <div className={`pt-4 border-subtle ${settings.enabled ? '' : 'opacity-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="font-medium text-gray-800 dark:text-white">{t('settings.clip.minScore') || '相似度阈值'}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t('settings.clip.minScoreDesc') || '过滤相似度低于此值的结果，值越高结果越精准'}
                </div>
              </div>
              <div className="text-sm font-medium text-blue-600 dark:text-blue-400 min-w-[3rem] text-right">
                {(settings.minScore ?? 0.4).toFixed(2)}
              </div>
            </div>
            <input
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={settings.minScore ?? 0.4}
              onChange={(e) => settings.enabled && onUpdateSettings({ ...settings, minScore: parseFloat(e.target.value) })}
              disabled={!settings.enabled}
              className="w-full h-2 bg-black/10 dark:bg-white/10 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
            />
            <div className="flex justify-between text-xs text-gray-400 mt-1">
              <span>0.00</span>
              <span>0.50</span>
              <span>1.00</span>
            </div>
          </div>
          
          {/* 最大结果数 */}
          <div className={`pt-4 border-subtle ${settings.enabled ? '' : 'opacity-50'}`}>
            <div className="flex items-center justify-between mb-2">
              <div>
                <div className="font-medium text-gray-800 dark:text-white">{t('settings.clip.maxResults') || '最大结果数'}</div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t('settings.clip.maxResultsDesc') || '以图搜图返回的最大结果数量'}
                </div>
              </div>
              <div className="flex items-center gap-3">
                <div className="text-sm font-medium text-blue-600 dark:text-blue-400 min-w-[3rem] text-right">
                  {settings.unlimitedResults ? (t('settings.clip.unlimited') || '无限制') : (settings.maxResults ?? 200)}
                </div>
                <button
                  onClick={() => settings.enabled && onUpdateSettings({ ...settings, unlimitedResults: !settings.unlimitedResults })}
                  disabled={!settings.enabled}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${settings.unlimitedResults ? 'bg-green-500' : 'bg-gray-300 dark:bg-gray-600'} ${!settings.enabled ? 'cursor-not-allowed' : ''}`}
                  title={t('settings.clip.unlimitedToggle') || '无限制'}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${settings.unlimitedResults ? 'translate-x-5' : 'translate-x-0.5'}`} />
                </button>
              </div>
            </div>
            {!settings.unlimitedResults && (
              <>
                <input
                  type="range"
                  min="50"
                  max="1000"
                  step="50"
                  value={settings.maxResults ?? 200}
                  onChange={(e) => settings.enabled && onUpdateSettings({ ...settings, maxResults: parseInt(e.target.value) })}
                  disabled={!settings.enabled}
                  className="w-full h-2 bg-black/10 dark:bg-white/10 rounded-lg appearance-none cursor-pointer accent-blue-500 disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <div className="flex justify-between text-xs text-gray-400 mt-1">
                  <span>50</span>
                  <span>500</span>
                  <span>1000</span>
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      {/* 下载错误提示 */}
      {settings.downloadStatus === 'error' && settings.downloadError && (
        <section className="bg-red-50 dark:bg-red-900/20 rounded-xl p-4 border border-red-100 dark:border-red-800">
          <h4 className="text-sm font-semibold text-red-800 dark:text-red-300 mb-2 flex items-center">
            <AlertCircle size={16} className="mr-2" />
            下载失败
          </h4>
          <p className="text-sm text-red-700 dark:text-red-400 mb-3">
            {settings.downloadError}
          </p>
          <div className="text-sm text-red-700 dark:text-red-400 space-y-2">
            <p className="font-medium">手动下载步骤：</p>
            <ol className="list-decimal list-inside space-y-1 ml-2">
              <li>访问 Hugging Face 或其他模型仓库</li>
              <li>搜索 "CLIP ONNX" 或 "clip-vit-base-patch32"</li>
              <li>下载以下文件：
                <ul className="list-disc list-inside ml-4 mt-1 text-xs">
                  <li>image_encoder.onnx（图像编码器）</li>
                  <li>text_encoder.onnx（文本编码器）</li>
                  <li>tokenizer.json（分词器）</li>
                </ul>
              </li>
              <li>将文件放置在应用的缓存目录中</li>
            </ol>
          </div>
        </section>
      )}

      {/* 模型目录和操作 */}
      <section className="bg-surface rounded-xl p-4 border border-subtle">
        <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center">
          <FolderOpen size={16} className="mr-2" />
          模型目录
        </h4>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-3">
          模型文件保存在应用缓存目录中。您可以打开目录查看或手动管理模型文件。
        </p>
        <button
          onClick={async () => {
            try {
              // 调用后端命令打开模型目录
              const { invoke } = await import('@tauri-apps/api/core');
              await invoke('clip_open_model_folder');
            } catch (error) {
              console.error('Failed to open model folder:', error);
              alert('打开目录失败: ' + error);
            }
          }}
          className="px-4 py-2 bg-content border border-subtle text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-surface transition-colors flex items-center"
        >
          <FolderOpen size={16} className="mr-2" />
          打开模型目录
        </button>
      </section>

      {/* 使用说明已移至启用开关下方 */}

    </div>

    {/* 删除模型确认弹窗 */}
    {deleteTarget && (
      <div className="fixed inset-0 z-[300] bg-black/50 flex items-center justify-center p-4">
        <ConfirmModal
          title="删除模型"
          message={`确定要删除 ${CLIP_MODELS.find(m => m.name === deleteTarget)?.displayName || deleteTarget} 模型吗？`}
          subMessage="删除后将无法使用该模型，需重新下载。"
          confirmText="删除"
          confirmIcon={Trash2}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => confirmDeleteModel(deleteTarget)}
          t={t}
        />
      </div>
    )}

    </>
  );
};

export default AIVisionPanel;
