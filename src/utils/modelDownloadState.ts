// 全局模型下载状态管理
// 用于在设置界面关闭后仍然保持下载进度

import { listenClipModelDownloadProgress, ClipModelDownloadProgress } from '../api/tauri-bridge';

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
