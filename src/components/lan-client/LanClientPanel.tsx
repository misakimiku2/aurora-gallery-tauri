import React, { useState, useEffect, useCallback } from 'react';
import {
  Wifi,
  Scan,
  RefreshCw,
  AlertCircle,
  Loader2,
  Trash2,
  LogOut,
  Monitor,
  Clock,
  Link2,
  Check,
  ArrowRight,
} from 'lucide-react';
import { LanShareSettings, SavedServer } from '../../types';
import { lanClientApi } from './lanClientApi';
import { ensureCameraPermission } from '../../utils/androidPlatform';
import { lanShareSaveServer, lanShareRemoveServer } from '../../api/tauri-bridge';
import { QrScannerModal } from './QrScannerModal';
import { parseQrData } from './qrParseUtils';

interface LanClientPanelProps {
  t: (key: string) => string;
  settings: LanShareSettings;
  onUpdateSettings: (settings: LanShareSettings) => void;
  onOpenBrowser?: () => void;
}

const DEFAULT_PORT = 8080;
const DEVICE_NAME_KEY = 'aurora_lan_device_name';

const formatLastConnected = (ts: number): string => {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    })}`;
  } catch {
    return '';
  }
};

export const LanClientPanel: React.FC<LanClientPanelProps> = ({
  t,
  settings,
  onUpdateSettings,
  onOpenBrowser,
}) => {
  const [host, setHost] = useState(settings.serverHost || '');
  const [port, setPort] = useState(String(settings.serverPort || DEFAULT_PORT));
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(DEVICE_NAME_KEY);
      if (saved && saved.trim()) return saved;
    } catch {}
    return lanClientApi.getDeviceName();
  });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [deviceCount, setDeviceCount] = useState<number | null>(null);
  const [scanning, setScanning] = useState(false);

  const refreshDevices = useCallback(async () => {
    try {
      const devices = await lanClientApi.getDevices();
      setDeviceCount(devices.length);
      // 同步自己的设备名：桌面端可能修改了名称，这里拉取后更新本地
      const myId = lanClientApi.getDeviceId();
      const me = devices.find((d) => d.id === myId);
      if (me && me.name) {
        try {
          localStorage.setItem(DEVICE_NAME_KEY, me.name);
        } catch {}
        setDeviceName(me.name);
      }
    } catch {
      setDeviceCount(null);
    }
  }, []);

  useEffect(() => {
    if (
      settings.serverAccessToken &&
      settings.serverHost &&
      settings.serverPort
    ) {
      lanClientApi.setBaseUrl(
        `http://${settings.serverHost}:${settings.serverPort}`
      );
      lanClientApi.setToken(settings.serverAccessToken);
      setConnected(true);
      refreshDevices();
    } else {
      // token 被清除（如过期失效）时同步显示未连接
      setConnected(false);
      setDeviceCount(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.serverAccessToken, settings.serverHost, settings.serverPort]);

  const handleConnect = useCallback(async () => {
    setError(null);
    const trimmedHost = host.trim();
    const portNum = parseInt(port, 10);
    const trimmedCode = code.trim();
    if (!trimmedHost || !Number.isFinite(portNum) || portNum <= 0) {
      setError(
        t('settings.lanShare.client.invalidAddress') || '请填写正确的服务器地址和端口'
      );
      return;
    }
    if (!trimmedCode) {
      setError(t('settings.lanShare.client.enterCode') || '请输入访问码');
      return;
    }

    setConnecting(true);
    try {
      lanClientApi.setBaseUrl(`http://${trimmedHost}:${portNum}`);
      const res = await lanClientApi.authenticate(
        trimmedCode,
        deviceName.trim() || undefined
      );
      if (res.success && res.token) {
        const saved = lanShareSaveServer(settings, trimmedHost, portNum, res.server_name);
        onUpdateSettings({
          ...saved,
          clientMode: true,
          serverHost: trimmedHost,
          serverPort: portNum,
          serverAccessToken: res.token,
        });
        setConnected(true);
        refreshDevices();
      } else {
        setError(
          res.error ||
            t('settings.lanShare.client.authFailed') ||
            '访问码错误，连接失败'
        );
      }
    } catch (e: any) {
      setError(
        e?.message ||
          t('settings.lanShare.client.connectFailed') ||
          '连接失败，请检查地址与网络'
      );
    } finally {
      setConnecting(false);
    }
  }, [host, port, code, deviceName, settings, onUpdateSettings, refreshDevices, t]);

  const handleDisconnect = useCallback(async () => {
    await lanClientApi.disconnect();
    onUpdateSettings({
      ...settings,
      serverAccessToken: undefined,
      serverHost: undefined,
      serverPort: undefined,
    });
    setConnected(false);
    setDeviceCount(null);
    setCode('');
    setError(null);
  }, [settings, onUpdateSettings]);

  const handleScan = useCallback(async () => {
    setError(null);
    const granted = await ensureCameraPermission();
    if (!granted) {
      setError(
        t('settings.lanShare.client.cameraDenied') || '需要摄像头权限以扫描 QR 码'
      );
      return;
    }
    setScanning(true);
  }, [t]);

  const handleScanResult = useCallback(async (rawData: string) => {
    setScanning(false);
    const parsed = parseQrData(rawData);

    if (!parsed) {
      setError(
        t('settings.lanShare.client.invalidQr') || '无法识别二维码内容，请确保扫描的是桌面端的连接二维码'
      );
      return;
    }

    setHost(parsed.host);
    setPort(String(parsed.port));

    if (!parsed.code) {
      setError(t('settings.lanShare.client.enterCode') || '请输入访问码');
      return;
    }

    setCode(parsed.code);
    setConnecting(true);
    try {
      lanClientApi.setBaseUrl(`http://${parsed.host}:${parsed.port}`);
      const res = await lanClientApi.authenticate(
        parsed.code,
        deviceName.trim() || undefined
      );
      if (res.success && res.token) {
        const saved = lanShareSaveServer(settings, parsed.host, parsed.port, res.server_name);
        onUpdateSettings({
          ...saved,
          clientMode: true,
          serverHost: parsed.host,
          serverPort: parsed.port,
          serverAccessToken: res.token,
        });
        setConnected(true);
        refreshDevices();
      } else {
        setError(
          res.error ||
            t('settings.lanShare.client.authFailed') ||
            '访问码错误，连接失败'
        );
      }
    } catch (e: any) {
      setError(
        e?.message ||
          t('settings.lanShare.client.connectFailed') ||
          '连接失败，请检查地址与网络'
      );
    } finally {
      setConnecting(false);
    }
  }, [deviceName, settings, onUpdateSettings, refreshDevices, t]);

  const handleSelectServer = useCallback((s: SavedServer) => {
    setHost(s.host);
    setPort(String(s.port));
    setError(null);
  }, []);

  const handleRemoveServer = useCallback(
    (s: SavedServer) => {
      onUpdateSettings(lanShareRemoveServer(settings, s.host, s.port));
    },
    [settings, onUpdateSettings]
  );

  const savedServers = settings.savedServers || [];
  const currentHost = settings.serverHost || host;
  const currentPort = settings.serverPort || parseInt(port, 10) || DEFAULT_PORT;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white flex items-center">
          <Wifi size={20} className="mr-2 text-blue-500" />
          {t('settings.lanShare.client.title') || '局域网客户端'}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('settings.lanShare.client.description') ||
            '连接到桌面端服务器，浏览和管理远程图库'}
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {connected ? (
        <div className="space-y-4">
          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-6 border border-gray-200 dark:border-gray-700">
            <div className="flex items-center gap-3 mb-4">
              <div className="w-10 h-10 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center">
                <Check size={20} className="text-green-500" />
              </div>
              <div>
                <div className="text-sm font-medium text-gray-800 dark:text-white">
                  {t('settings.lanShare.client.connected') || '已连接'}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400 flex items-center mt-0.5">
                  <Monitor size={12} className="mr-1" />
                  {currentHost}:{currentPort}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 pt-4 border-t border-gray-200 dark:border-gray-700">
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t('settings.lanShare.client.onlineDevices') || '在线设备'}
                </div>
                <div className="text-lg font-semibold text-gray-800 dark:text-white mt-1">
                  {deviceCount !== null ? deviceCount : '--'}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {t('settings.lanShare.client.serverAddress') || '服务器地址'}
                </div>
                <div className="text-sm font-mono text-gray-800 dark:text-white mt-1 truncate">
                  {currentHost}:{currentPort}
                </div>
              </div>
            </div>
          </div>

          <div className="flex gap-3">
            {onOpenBrowser && (
              <button
                onClick={onOpenBrowser}
                className="flex-1 h-[55px] flex items-center justify-center gap-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
              >
                {t('settings.lanShare.client.openBrowser') || '进入浏览'}
                <ArrowRight size={16} />
              </button>
            )}
            <button
              onClick={handleDisconnect}
              className="flex-1 h-[55px] flex items-center justify-center gap-2 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 text-red-600 dark:text-red-400 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium transition-colors"
            >
              <LogOut size={16} />
              {t('settings.lanShare.client.disconnect') || '断开'}
            </button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-6 border border-gray-200 dark:border-gray-700 space-y-4">
            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center mb-2">
                <Monitor size={14} className="mr-1.5" />
                {t('settings.lanShare.client.serverHost') || '服务器地址'}
              </label>
              <input
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
                inputMode="decimal"
                className="w-full h-[55px] px-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-base text-gray-800 dark:text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
                {t('settings.lanShare.client.port') || '端口'}
              </label>
              <input
                type="text"
                value={port}
                onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
                placeholder="8080"
                inputMode="numeric"
                className="w-full h-[55px] px-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-base text-gray-800 dark:text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
                {t('settings.lanShare.client.accessCode') || '访问码'}
              </label>
              <input
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
                placeholder="----"
                inputMode="numeric"
                maxLength={4}
                className="w-full h-[55px] px-4 bg-gray-900 text-white border border-gray-200 dark:border-gray-700 rounded-lg text-2xl font-mono font-bold tracking-[0.5em] text-center placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <div>
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
                {t('settings.lanShare.client.deviceName') || '设备名称'}
              </label>
              <input
                type="text"
                value={deviceName}
                onChange={(e) => {
                  const v = e.target.value;
                  setDeviceName(v);
                  try {
                    localStorage.setItem(DEVICE_NAME_KEY, v);
                  } catch {}
                }}
                placeholder={
                  t('settings.lanShare.client.deviceNamePlaceholder') || '如：三星Tab S8+'
                }
                maxLength={30}
                className="w-full h-[55px] px-4 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-base text-gray-800 dark:text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 transition-colors"
              />
            </div>

            <button
              onClick={handleConnect}
              disabled={connecting}
              className="w-full h-[55px] flex items-center justify-center gap-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
            >
              {connecting ? (
                <>
                  <Loader2 size={16} className="animate-spin" />
                  {t('settings.lanShare.client.connecting') || '连接中...'}
                </>
              ) : (
                <>
                  <Link2 size={16} />
                  {t('settings.lanShare.client.connect') || '连接'}
                </>
              )}
            </button>

            <button
              onClick={handleScan}
              disabled={connecting}
              className="w-full h-[55px] flex items-center justify-center gap-2 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 text-gray-700 dark:text-gray-300 border border-gray-200 dark:border-gray-700 rounded-lg text-sm font-medium transition-colors"
            >
              <Scan size={16} />
              {t('settings.lanShare.client.scanToConnect') || '扫码连接'}
            </button>
          </div>

          {savedServers.length > 0 && (
            <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3 flex items-center">
                <Clock size={14} className="mr-1.5" />
                {t('settings.lanShare.client.recentServers') || '最近服务器'}
              </h4>
              <div className="space-y-2">
                {savedServers.map((s) => (
                  <div
                    key={`${s.host}:${s.port}`}
                    className="flex items-center justify-between h-[55px] px-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
                  >
                    <button
                      onClick={() => handleSelectServer(s)}
                      className="flex-1 flex items-center justify-between min-w-0 text-left"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-gray-800 dark:text-white truncate">
                          {s.name ? `${s.name} · ` : ''}{s.host}:{s.port}
                        </div>
                        {s.lastConnected > 0 && (
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            {formatLastConnected(s.lastConnected)}
                          </div>
                        )}
                      </div>
                      <RefreshCw size={14} className="text-gray-400 flex-shrink-0 ml-2" />
                    </button>
                    <button
                      onClick={() => handleRemoveServer(s)}
                      className="ml-2 p-2 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors flex-shrink-0"
                      title={t('settings.lanShare.client.remove') || '移除'}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg">
            <AlertCircle size={14} className="mt-0.5 text-blue-500 flex-shrink-0" />
            <p>
              {t('settings.lanShare.client.tip') ||
                '确保手机与电脑连接到同一 Wi-Fi 网络，并在桌面端开启局域网共享'}
            </p>
          </div>
        </div>
      )}

      <QrScannerModal
        open={scanning}
        onScanResult={handleScanResult}
        onCancel={() => setScanning(false)}
        onError={(msg) => {
          setScanning(false);
          setError(msg);
        }}
        t={t}
      />
    </div>
  );
};

export default LanClientPanel;
