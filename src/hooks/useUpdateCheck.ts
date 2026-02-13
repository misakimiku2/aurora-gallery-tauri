import { useState, useEffect, useCallback, useRef } from 'react';
import { 
  checkForUpdates, 
  openExternalLink, 
  UpdateCheckResult,
  startUpdateDownload,
  pauseUpdateDownload,
  resumeUpdateDownload,
  cancelUpdateDownload,
  getUpdateDownloadProgress,
  installUpdate,
  openUpdateDownloadFolder,
  DownloadProgressResult,
} from '../api/tauri-bridge';
import { UpdateInfo, UpdateSettings, DownloadState, DownloadProgress } from '../types';
import { listen } from '@tauri-apps/api/event';

const UPDATE_SETTINGS_KEY = 'aurora_update_settings';

// 最小检查间隔（5分钟），防止用户频繁点击
const MIN_CHECK_INTERVAL = 5 * 60 * 1000;

const defaultSettings: UpdateSettings = {
  autoCheck: true,
  checkFrequency: 'startup',
  ignoredVersions: [],
};

const loadSettings = (): UpdateSettings => {
  try {
    const saved = localStorage.getItem(UPDATE_SETTINGS_KEY);
    if (saved) {
      return { ...defaultSettings, ...JSON.parse(saved) };
    }
  } catch (e) {
    console.error('Failed to load update settings:', e);
  }
  return defaultSettings;
};

const saveSettings = (settings: UpdateSettings) => {
  try {
    localStorage.setItem(UPDATE_SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    console.error('Failed to save update settings:', e);
  }
};

const shouldCheckUpdate = (settings: UpdateSettings): boolean => {
  if (!settings.autoCheck) return false;
  
  const now = Date.now();
  const lastCheck = settings.lastCheckTime || 0;
  
  switch (settings.checkFrequency) {
    case 'startup':
      return true;
    case 'daily':
      return now - lastCheck > 24 * 60 * 60 * 1000;
    case 'weekly':
      return now - lastCheck > 7 * 24 * 60 * 60 * 1000;
    default:
      return true;
  }
};

const convertUpdateResult = (result: UpdateCheckResult): UpdateInfo => ({
  hasUpdate: result.has_update,
  currentVersion: result.current_version,
  latestVersion: result.latest_version,
  downloadUrl: result.download_url,
  installerUrl: result.installer_url,
  installerSize: result.installer_size,
  releaseName: result.release_name,
  releaseNotes: result.release_notes,
  publishedAt: result.published_at,
});

const convertDownloadProgress = (result: DownloadProgressResult): DownloadProgress => ({
  state: result.state as DownloadState,
  progress: result.progress,
  downloadedBytes: result.downloaded_bytes,
  totalBytes: result.total_bytes,
  speedBytesPerSec: result.speed_bytes_per_sec,
  filePath: result.file_path,
  errorMessage: result.error_message,
});

export interface UseUpdateCheckReturn {
  updateInfo: UpdateInfo | null;
  isChecking: boolean;
  downloadProgress: DownloadProgress | null;
  settings: UpdateSettings;
  lastCheckTime: number;
  checkUpdate: (force?: boolean) => Promise<void>;
  ignoreVersion: (version: string) => void;
  startDownload: () => Promise<void>;
  pauseDownload: () => Promise<void>;
  resumeDownload: () => Promise<void>;
  cancelDownload: () => Promise<void>;
  installUpdate: () => Promise<void>;
  openDownloadFolder: () => Promise<void>;
  updateSettings: (newSettings: Partial<UpdateSettings>) => void;
  dismissUpdate: () => void;
}

export const useUpdateCheck = (): UseUpdateCheckReturn => {
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [isChecking, setIsChecking] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | null>(null);
  const [settings, setSettingsState] = useState<UpdateSettings>(loadSettings());
  const [lastCheckTime, setLastCheckTime] = useState<number>(settings.lastCheckTime || 0);
  const lastCheckRef = useRef<number>(0);

  // 监听下载进度事件
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    
    const setupListener = async () => {
      unlisten = await listen<DownloadProgressResult>('update-download-progress', (event) => {
        const progress = convertDownloadProgress(event.payload);
        setDownloadProgress(progress);
      });
    };
    
    setupListener();
    
    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  // 初始化时获取当前下载状态
  useEffect(() => {
    const initDownloadProgress = async () => {
      const progress = await getUpdateDownloadProgress();
      if (progress) {
        setDownloadProgress(convertDownloadProgress(progress));
      }
    };
    initDownloadProgress();
  }, []);

  const checkUpdate = useCallback(async (force: boolean = false) => {
    // 检查最小间隔限制（除非强制检查）
    const now = Date.now();
    if (!force && now - lastCheckRef.current < MIN_CHECK_INTERVAL) {
      console.log('Update check skipped: too frequent');
      return;
    }

    if (!force && !shouldCheckUpdate(settings)) {
      return;
    }

    setIsChecking(true);
    lastCheckRef.current = now;
    
    try {
      // 后端会自动使用默认的 GitHub Token
      const result = await checkForUpdates();
      
      if (result) {
        const info = convertUpdateResult(result);
        
        // 检查是否已忽略此版本
        if (settings.ignoredVersions.includes(info.latestVersion)) {
          setUpdateInfo(null);
        } else {
          setUpdateInfo(info);
        }
        
        // 更新最后检查时间
        const newSettings = { ...settings, lastCheckTime: now };
        setSettingsState(newSettings);
        setLastCheckTime(now);
        saveSettings(newSettings);
      }
    } catch (error) {
      console.error('Failed to check for updates:', error);
    } finally {
      setIsChecking(false);
    }
  }, [settings]);

  const ignoreVersion = useCallback((version: string) => {
    const newSettings = {
      ...settings,
      ignoredVersions: [...settings.ignoredVersions, version],
    };
    setSettingsState(newSettings);
    saveSettings(newSettings);
    setUpdateInfo(null);
  }, [settings]);

  const startDownload = useCallback(async () => {
    if (!updateInfo?.installerUrl) {
      // 如果没有安装程序链接，打开浏览器
      openExternalLink(updateInfo?.downloadUrl || '');
      return;
    }

    // 设置准备状态，在下载正式开始前显示
    setDownloadProgress({
      state: 'preparing',
      progress: 0,
      downloadedBytes: 0,
      totalBytes: updateInfo.installerSize || 0,
      speedBytesPerSec: 0,
      filePath: '',
    });

    try {
      await startUpdateDownload(updateInfo.installerUrl, updateInfo.latestVersion);
    } catch (error) {
      console.error('Failed to start download:', error);
      // 如果启动失败，重置状态
      setDownloadProgress({
        state: 'error',
        progress: 0,
        downloadedBytes: 0,
        totalBytes: updateInfo.installerSize || 0,
        speedBytesPerSec: 0,
        filePath: '',
        errorMessage: error instanceof Error ? error.message : 'Failed to start download',
      });
    }
  }, [updateInfo]);

  const pauseDownload = useCallback(async () => {
    try {
      await pauseUpdateDownload();
    } catch (error) {
      console.error('Failed to pause download:', error);
    }
  }, []);

  const resumeDownload = useCallback(async () => {
    try {
      await resumeUpdateDownload();
    } catch (error) {
      console.error('Failed to resume download:', error);
    }
  }, []);

  const cancelDownload = useCallback(async () => {
    try {
      await cancelUpdateDownload();
      setDownloadProgress(null);
    } catch (error) {
      console.error('Failed to cancel download:', error);
    }
  }, []);

  const installUpdateCallback = useCallback(async () => {
    try {
      await installUpdate();
    } catch (error) {
      console.error('Failed to install update:', error);
    }
  }, []);

  const openDownloadFolderCallback = useCallback(async () => {
    try {
      await openUpdateDownloadFolder();
    } catch (error) {
      console.error('Failed to open download folder:', error);
    }
  }, []);

  const updateSettings = useCallback((newSettings: Partial<UpdateSettings>) => {
    const updated = { ...settings, ...newSettings };
    setSettingsState(updated);
    saveSettings(updated);
  }, [settings]);

  const dismissUpdate = useCallback(() => {
    setUpdateInfo(null);
  }, []);

  // 组件挂载时自动检查更新
  useEffect(() => {
    checkUpdate();
  }, []);

  return {
    updateInfo,
    isChecking,
    downloadProgress,
    settings,
    lastCheckTime,
    checkUpdate,
    ignoreVersion,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    installUpdate: installUpdateCallback,
    openDownloadFolder: openDownloadFolderCallback,
    updateSettings,
    dismissUpdate,
  };
};

export default useUpdateCheck;
