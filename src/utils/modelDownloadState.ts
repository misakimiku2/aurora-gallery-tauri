// 全局模型下载状态管理
// 用于在设置界面关闭后仍然保持下载进度

import { listenClipModelDownloadProgress, ClipModelDownloadProgress, ClipModelStatus } from '../api/tauri-bridge';

export interface ModelDownloadInfo {
  modelName: string;
  displayName: string;
  fileName: string;
  fileIndex: number;
  totalFiles: number;
  progress: number;
  downloaded: number;
  total: number;
  speed: number;
  status: 'downloading' | 'completed' | 'error' | 'idle';
  errorMessage?: string;
}

// 全局下载状态
export const globalModelDownloadState: {
  downloads: Record<string, ModelDownloadInfo>;
  listeners: Set<(modelName: string, info: ModelDownloadInfo) => void>;
  isListening: boolean;
  currentModelName: string | null;
  currentDisplayName: string | null;
} = {
  downloads: {},
  listeners: new Set(),
  isListening: false,
  currentModelName: null,
  currentDisplayName: null,
};

// 启动全局 Tauri 事件监听
async function startGlobalListener() {
  if (globalModelDownloadState.isListening) return;
  globalModelDownloadState.isListening = true;

  try {
    await listenClipModelDownloadProgress((data: ClipModelDownloadProgress) => {
      // 使用当前正在下载的模型名称
      const modelName = globalModelDownloadState.currentModelName || data.file_name;
      const displayName = globalModelDownloadState.currentDisplayName || data.file_name;
      
      const info: ModelDownloadInfo = {
        modelName,
        displayName,
        fileName: data.file_name,
        fileIndex: data.file_index,
        totalFiles: data.total_files,
        progress: data.progress,
        downloaded: data.downloaded,
        total: data.total,
        speed: data.speed,
        status: 'downloading',
      };
      
      globalModelDownloadState.downloads[modelName] = info;
      
      // 通知所有监听器
      globalModelDownloadState.listeners.forEach(listener => {
        listener(modelName, info);
      });
    });
  } catch (error) {
    console.error('Failed to start global model download listener:', error);
  }
}

// 设置当前正在下载的模型信息
export function setCurrentDownloadingModel(modelName: string, displayName: string) {
  globalModelDownloadState.currentModelName = modelName;
  globalModelDownloadState.currentDisplayName = displayName;
  
  // 启动全局监听（如果还没启动）
  startGlobalListener();
}

// 更新下载进度
export function updateModelDownloadProgress(
  modelName: string,
  displayName: string,
  fileName: string,
  fileIndex: number,
  totalFiles: number,
  progress: number,
  downloaded: number,
  total: number,
  speed: number,
  status: ModelDownloadInfo['status'] = 'downloading',
  errorMessage?: string
): void {
  const info: ModelDownloadInfo = {
    modelName,
    displayName,
    fileName,
    fileIndex,
    totalFiles,
    progress,
    downloaded,
    total,
    speed,
    status,
    errorMessage,
  };
  
  globalModelDownloadState.downloads[modelName] = info;
  
  // 通知所有监听器
  globalModelDownloadState.listeners.forEach(listener => {
    listener(modelName, info);
  });
}

// 标记下载完成
export function completeModelDownload(modelName: string): void {
  if (globalModelDownloadState.downloads[modelName]) {
    globalModelDownloadState.downloads[modelName].status = 'completed';
    globalModelDownloadState.downloads[modelName].progress = 100;
    
    // 通知所有监听器
    globalModelDownloadState.listeners.forEach(listener => {
      listener(modelName, globalModelDownloadState.downloads[modelName]);
    });
    
    // 清理当前模型
    if (globalModelDownloadState.currentModelName === modelName) {
      globalModelDownloadState.currentModelName = null;
      globalModelDownloadState.currentDisplayName = null;
    }
    
    // 3秒后清理已完成的下载状态
    setTimeout(() => {
      delete globalModelDownloadState.downloads[modelName];
      globalModelDownloadState.listeners.forEach(listener => {
        listener(modelName, {
          modelName,
          displayName: '',
          fileName: '',
          fileIndex: 0,
          totalFiles: 0,
          progress: 0,
          downloaded: 0,
          total: 0,
          speed: 0,
          status: 'idle',
        });
      });
    }, 3000);
  }
}

// 标记下载错误
export function errorModelDownload(modelName: string, errorMessage: string): void {
  if (globalModelDownloadState.downloads[modelName]) {
    globalModelDownloadState.downloads[modelName].status = 'error';
    globalModelDownloadState.downloads[modelName].errorMessage = errorMessage;
    
    // 清理当前模型
    if (globalModelDownloadState.currentModelName === modelName) {
      globalModelDownloadState.currentModelName = null;
      globalModelDownloadState.currentDisplayName = null;
    }
    
    globalModelDownloadState.listeners.forEach(listener => {
      listener(modelName, globalModelDownloadState.downloads[modelName]);
    });
  }
}

// 获取下载信息
export function getModelDownloadInfo(modelName: string): ModelDownloadInfo | undefined {
  return globalModelDownloadState.downloads[modelName];
}

// 获取所有活跃的下载
export function getActiveDownloads(): ModelDownloadInfo[] {
  return Object.values(globalModelDownloadState.downloads).filter(
    d => d.status === 'downloading'
  );
}

// 是否有正在进行的下载
export function hasActiveDownloads(): boolean {
  return Object.values(globalModelDownloadState.downloads).some(
    d => d.status === 'downloading'
  );
}

// 订阅下载进度变化
export function subscribeToModelDownload(
  callback: (modelName: string, info: ModelDownloadInfo) => void
): () => void {
  globalModelDownloadState.listeners.add(callback);
  
  // 返回取消订阅函数
  return () => {
    globalModelDownloadState.listeners.delete(callback);
  };
}

// 清理下载状态
export function clearModelDownload(modelName: string): void {
  delete globalModelDownloadState.downloads[modelName];
}

// ==================== 全局模型状态缓存 ====================
// 用于在组件重新挂载时保持模型状态，避免"加载中..."一直显示

export interface ModelStatusCache {
  statuses: Record<string, ClipModelStatus>;
  isLoaded: boolean;
  lastLoadTime: number;
}

export const globalModelStatusState: ModelStatusCache = {
  statuses: {},
  isLoaded: false,
  lastLoadTime: 0,
};

// 缓存过期时间（5分钟）
const CACHE_EXPIRY_MS = 5 * 60 * 1000;

/**
 * 获取缓存的模型状态
 * @returns 如果缓存有效则返回状态对象，否则返回 null
 */
export function getCachedModelStatuses(): Record<string, ClipModelStatus> | null {
  if (!globalModelStatusState.isLoaded) {
    return null;
  }
  
  const now = Date.now();
  if (now - globalModelStatusState.lastLoadTime > CACHE_EXPIRY_MS) {
    // 缓存已过期
    globalModelStatusState.isLoaded = false;
    return null;
  }
  
  return globalModelStatusState.statuses;
}

/**
 * 设置模型状态缓存
 * @param statuses 模型状态对象
 */
export function setCachedModelStatuses(statuses: Record<string, ClipModelStatus>): void {
  globalModelStatusState.statuses = statuses;
  globalModelStatusState.isLoaded = true;
  globalModelStatusState.lastLoadTime = Date.now();
}

/**
 * 清除模型状态缓存
 */
export function clearCachedModelStatuses(): void {
  globalModelStatusState.statuses = {};
  globalModelStatusState.isLoaded = false;
  globalModelStatusState.lastLoadTime = 0;
}

/**
 * 获取单个模型的缓存状态
 * @param modelName 模型名称
 * @returns 模型状态或 undefined
 */
export function getCachedModelStatus(modelName: string): ClipModelStatus | undefined {
  if (!globalModelStatusState.isLoaded) {
    return undefined;
  }
  
  const now = Date.now();
  if (now - globalModelStatusState.lastLoadTime > CACHE_EXPIRY_MS) {
    return undefined;
  }
  
  return globalModelStatusState.statuses[modelName];
}

/**
 * 检查缓存是否有效
 */
export function isModelStatusCacheValid(): boolean {
  if (!globalModelStatusState.isLoaded) {
    return false;
  }
  
  const now = Date.now();
  return now - globalModelStatusState.lastLoadTime <= CACHE_EXPIRY_MS;
}

// ==================== 全局损坏模型状态 ====================
// 用于在组件重新挂载时保持损坏模型状态

interface CorruptedModelsState {
  models: Set<string>;
}

const globalCorruptedModelsState: CorruptedModelsState = {
  models: new Set(),
};

/**
 * 将模型标记为损坏
 * @param modelName 模型名称
 */
export function markModelAsCorrupted(modelName: string): void {
  globalCorruptedModelsState.models.add(modelName);
}

/**
 * 将模型标记为正常（从损坏列表中移除）
 * @param modelName 模型名称
 */
export function markModelAsNormal(modelName: string): void {
  globalCorruptedModelsState.models.delete(modelName);
}

/**
 * 获取所有损坏的模型
 * @returns 损坏模型名称的数组
 */
export function getCorruptedModels(): string[] {
  return Array.from(globalCorruptedModelsState.models);
}

/**
 * 检查模型是否已损坏
 * @param modelName 模型名称
 * @returns 是否损坏
 */
export function isModelCorrupted(modelName: string): boolean {
  return globalCorruptedModelsState.models.has(modelName);
}

/**
 * 清除所有损坏模型状态
 */
export function clearCorruptedModels(): void {
  globalCorruptedModelsState.models.clear();
}
