import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Wifi,
  Copy,
  RefreshCw,
  Check,
  AlertCircle,
  Loader2,
  Play,
  Square,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { LanShareSettings } from '../../types';
import {
  lanShareAndroidStart,
  lanShareAndroidStop,
  lanShareAndroidGetStatus,
  lanShareAndroidGetDevices,
  lanShareAndroidUpdateConfig,
  AndroidLanServerStatus,
} from '../../api/tauri-bridge';

interface AndroidLanServerPanelProps {
  t: (key: string) => string;
  settings: LanShareSettings;
  onUpdateSettings: (settings: LanShareSettings) => void;
}

const generateAccessCode = (): string => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

/**
 * 安卓端本机共享紧凑状态卡（无切换开关）：
 * - 未开启：一行提示 + 「开启」小按钮（扫码连接桌面端时会自动开启）
 * - 共享中：一行状态（访问地址 / 验证码 / 复制 / 停止共享）
 */
export const AndroidLanServerPanel: React.FC<AndroidLanServerPanelProps> = ({
  t,
  settings,
  onUpdateSettings,
}) => {
  const [status, setStatus] = useState<AndroidLanServerStatus | null>(null);
  const [deviceCount, setDeviceCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const serverUrl = status?.is_running && status.local_ip
    ? `http://${status.local_ip}:${status.port}`
    : null;

  useEffect(() => {
    lanShareAndroidGetStatus().then(setStatus).catch(console.error);
  }, []);

  // 共享中：轮询已连接设备数（5s）
  useEffect(() => {
    if (!status?.is_running) {
      setDeviceCount(0);
      return;
    }
    const poll = () => {
      lanShareAndroidGetDevices()
        .then((devices) => setDeviceCount(devices.length))
        .catch(() => {});
    };
    poll();
    pollIntervalRef.current = setInterval(poll, 5000);
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }
    };
  }, [status?.is_running]);

  // 状态变化事件（含通知栏停止共享）
  useEffect(() => {
    const unlistenPromise = listen('lan-share-android-status-changed', () => {
      lanShareAndroidGetStatus().then(setStatus).catch(console.error);
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  const handleStart = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      const updates: LanShareSettings = {
        ...settings,
        enabled: true,
        accessCode: settings.accessCode || generateAccessCode(),
      };
      const info = await lanShareAndroidStart({
        enabled: true,
        port: updates.port,
        access_code: updates.accessCode,
        server_name: updates.serverName || '',
      });
      onUpdateSettings(updates);
      setStatus({
        is_running: true,
        port: info.port,
        local_ip: info.local_ip,
        device_count: 0,
      });
    } catch (e: any) {
      console.error('Failed to start Android LAN share server:', e);
      setError(
        e.message || (t('settings.lanShare.startFailed') || '启动失败，请检查端口是否被占用')
      );
      lanShareAndroidGetStatus().then(setStatus).catch(() => {});
    } finally {
      setBusy(false);
    }
  }, [settings, onUpdateSettings, t]);

  const handleStop = useCallback(async () => {
    setError(null);
    setBusy(true);
    try {
      await lanShareAndroidStop();
      onUpdateSettings({ ...settings, enabled: false });
      setStatus((prev) => ({
        is_running: false,
        port: prev?.port ?? settings.port,
        local_ip: null,
        device_count: 0,
      }));
      setDeviceCount(0);
    } catch (e: any) {
      console.error('Failed to stop Android LAN share server:', e);
      setError(e.message || (t('settings.lanShare.stopFailed') || '停止失败'));
    } finally {
      setBusy(false);
    }
  }, [settings, onUpdateSettings, t]);

  const handleRegenerateCode = useCallback(() => {
    const newCode = generateAccessCode();
    const newSettings = { ...settings, accessCode: newCode };
    onUpdateSettings(newSettings);
    if (status?.is_running) {
      lanShareAndroidUpdateConfig({
        enabled: true,
        port: newSettings.port,
        access_code: newCode,
        server_name: newSettings.serverName || '',
      }).catch(console.error);
    }
  }, [settings, onUpdateSettings, status?.is_running]);

  const handleCopyUrl = useCallback(() => {
    if (serverUrl) {
      navigator.clipboard.writeText(serverUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [serverUrl]);

  return (
    <div className="space-y-2 animate-fade-in">
      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {status?.is_running ? (
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-3.5 border border-gray-200 dark:border-gray-700 space-y-2.5">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-sm font-medium text-green-600 dark:text-green-400 min-w-0">
              <Wifi size={14} className="shrink-0" />
              <span className="truncate">
                {t('settings.lanShare.androidServer.running') || '共享中'}
                {deviceCount > 0
                  ? ` · ${deviceCount} ${t('settings.lanShare.online') || '在线'}`
                  : ''}
              </span>
            </div>
            <button
              onClick={handleStop}
              disabled={busy}
              className="px-2.5 py-1.5 flex items-center gap-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors shrink-0 disabled:opacity-50"
            >
              {busy ? <Loader2 size={12} className="animate-spin" /> : <Square size={12} />}
              {t('settings.lanShare.androidServer.stop') || '停止共享'}
            </button>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex-1 min-w-0 bg-white dark:bg-gray-900 rounded-lg px-3 py-2 text-sm font-mono text-gray-600 dark:text-gray-400 border border-gray-200 dark:border-gray-700 truncate">
              {serverUrl || '...'}
            </div>
            {serverUrl && (
              <button
                onClick={handleCopyUrl}
                className="px-2.5 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-xs font-medium transition-colors shrink-0"
              >
                {copied
                  ? (t('settings.lanShare.copied') || '已复制')
                  : (t('settings.lanShare.copy') || '复制')}
              </button>
            )}
          </div>

          <div className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
            <span>
              {t('settings.lanShare.androidServer.accessCode') || '访问验证码'}：
            </span>
            <span className="font-mono font-bold text-base text-gray-800 dark:text-white">
              {settings.accessCode || '----'}
            </span>
            <button
              onClick={handleRegenerateCode}
              className="p-1 text-gray-400 hover:text-blue-500 rounded transition-colors"
              title={t('settings.lanShare.regenerate') || '重新生成'}
            >
              <RefreshCw size={13} />
            </button>
          </div>

          <p className="text-[11px] text-amber-600 dark:text-amber-400">
            {t('settings.lanShare.androidServer.keepAliveTip') ||
              '息屏后共享仍会保持在线。建议将本应用加入电池优化白名单，以保证息屏后共享稳定'}
          </p>
        </div>
      ) : (
        <div className="flex items-center justify-between gap-2 text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/50 rounded-xl px-3.5 py-3 border border-gray-200 dark:border-gray-700">
          <span className="min-w-0">
            {t('settings.lanShare.androidServer.notRunningHint') ||
              '扫码连接桌面端后自动开启本机共享，建立双向连接'}
          </span>
          <button
            onClick={handleStart}
            disabled={busy}
            className="px-2.5 py-1.5 flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors shrink-0 disabled:opacity-50"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : <Play size={12} />}
            {t('settings.lanShare.androidServer.start') || '开启'}
          </button>
        </div>
      )}
    </div>
  );
};

export default AndroidLanServerPanel;
