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
  Copy,
  ArrowRight,
} from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { LanShareSettings, SavedServer } from '../../types';
import { lanClientApi } from './lanClientApi';
import { ensureCameraPermission } from '../../utils/androidPlatform';
import {
  lanShareSaveServer,
  lanShareRemoveServer,
  lanShareAndroidStart,
  lanShareAndroidStop,
  lanShareAndroidGetStatus,
  lanShareAndroidGetDevices,
  AndroidLanServerStatus,
} from '../../api/tauri-bridge';
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
  // 双向连接融合：本机服务端上的设备数（>0 表示桌面端已反向连接本机）
  const [myServerDeviceCount, setMyServerDeviceCount] = useState<number | null>(null);
  // 双向连接融合：本机服务端运行状态（地址/验证码等，融合显示在连接卡片中）
  const [myServerStatus, setMyServerStatus] = useState<AndroidLanServerStatus | null>(null);
  const [serverCopied, setServerCopied] = useState(false);

  const myServerUrl = myServerStatus?.is_running && myServerStatus.local_ip
    ? `http://${myServerStatus.local_ip}:${myServerStatus.port}`
    : null;

  const generateLocalCode = (): string => {
    return Math.floor(1000 + Math.random() * 9000).toString();
  };

  /**
   * 双向连接融合：连接桌面端前确保本机共享服务端已运行，
   * 并返回本机服务端信息（供 authenticate 携带 peer_server，
   * 让桌面端自动反向连接本机）。
   * startedNow 表示服务端是否由本次调用自动开启（连接失败时用于回滚，
   * 避免留下无人消费的"孤儿服务端"）。
   * 服务端名称回退使用客户端设备名（如"三星Tab S8+"），
   * 保证桌面端侧边栏显示的设备名与局域网共享面板一致。
   */
  const ensureOwnServer = useCallback(async (): Promise<{ port: number; accessCode: string; startedNow: boolean } | null> => {
    try {
      const status = await lanShareAndroidGetStatus();
      if (status.is_running) {
        return { port: status.port, accessCode: settings.accessCode, startedNow: false };
      }
      const code = settings.accessCode || generateLocalCode();
      const serverName = settings.serverName || deviceName.trim();
      const updates: LanShareSettings = {
        ...settings,
        enabled: true,
        accessCode: code,
        serverName,
      };
      await lanShareAndroidStart({
        enabled: true,
        port: updates.port,
        access_code: code,
        server_name: serverName,
      });
      onUpdateSettings(updates);
      return { port: updates.port, accessCode: code, startedNow: true };
    } catch (e: any) {
      console.warn('[LAN Fusion] ensure own server failed:', e);
      // 服务已在运行（竞态）时仍返回当前配置
      if (String(e?.message || e).includes('already running')) {
        return { port: settings.port, accessCode: settings.accessCode, startedNow: false };
      }
      return null;
    }
  }, [settings, onUpdateSettings, deviceName]);

  // 连接失败时回滚本次自动开启的服务端（此前已在运行的服务端不受影响）
  const rollbackServerIfStarted = useCallback(
    (peer: { startedNow: boolean } | null | undefined) => {
      if (peer?.startedNow) {
        lanShareAndroidStop().catch(() => {});
      }
    },
    []
  );

  // 本机服务端状态：挂载时拉取一次，服务端启停（含通知栏"停止共享"）时实时刷新
  useEffect(() => {
    lanShareAndroidGetStatus().then(setMyServerStatus).catch(() => {});
    const unlistenPromise = listen('lan-share-android-status-changed', () => {
      lanShareAndroidGetStatus().then(setMyServerStatus).catch(() => {});
    });
    return () => {
      unlistenPromise.then((unlisten) => unlisten()).catch(() => {});
    };
  }, []);

  // 双向状态：已连接桌面端时轮询本机服务端的设备列表与运行状态
  useEffect(() => {
    if (!connected) {
      setMyServerDeviceCount(null);
      return;
    }
    const poll = () => {
      lanShareAndroidGetDevices()
        .then((devices) => setMyServerDeviceCount(devices.length))
        .catch(() => {});
      lanShareAndroidGetStatus().then(setMyServerStatus).catch(() => {});
    };
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [connected]);

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
    let peer: { port: number; accessCode: string; startedNow: boolean } | null = null;
    try {
      // 双向连接融合：先确保本机共享已开启，认证时携带本机服务端信息
      peer = await ensureOwnServer();
      lanClientApi.setBaseUrl(`http://${trimmedHost}:${portNum}`);
      const res = await lanClientApi.authenticate(
        trimmedCode,
        deviceName.trim() || undefined,
        peer ?? undefined
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
        // 连接失败：回滚本次自动开启的本机共享，避免留下"孤儿服务端"
        rollbackServerIfStarted(peer);
        setError(
          res.error ||
            t('settings.lanShare.client.authFailed') ||
            '访问码错误，连接失败'
        );
      }
    } catch (e: any) {
      rollbackServerIfStarted(peer);
      setError(
        e?.message ||
          t('settings.lanShare.client.connectFailed') ||
          '连接失败，请检查地址与网络'
      );
    } finally {
      setConnecting(false);
    }
  }, [host, port, code, deviceName, settings, onUpdateSettings, refreshDevices, ensureOwnServer, rollbackServerIfStarted, t]);

  const handleCopyServerUrl = useCallback(() => {
    if (myServerUrl) {
      navigator.clipboard.writeText(myServerUrl);
      setServerCopied(true);
      setTimeout(() => setServerCopied(false), 2000);
    }
  }, [myServerUrl]);

  const handleDisconnect = useCallback(async () => {
    await lanClientApi.disconnect();
    // 双向连接融合：断开与桌面端的连接时同步停止本机共享服务端，
    // 彻底断开整条链路（桌面端随后通过心跳失败自动移除本设备）。
    try {
      await lanShareAndroidStop();
    } catch (e) {
      console.warn('[LAN Fusion] stop own server on disconnect failed:', e);
    }
    onUpdateSettings({
      ...settings,
      enabled: false,
      serverAccessToken: undefined,
      serverHost: undefined,
      serverPort: undefined,
    });
    setConnected(false);
    setDeviceCount(null);
    setMyServerDeviceCount(null);
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
    let peer: { port: number; accessCode: string; startedNow: boolean } | null = null;
    try {
      // 双向连接融合：先确保本机共享已开启，认证时携带本机服务端信息
      peer = await ensureOwnServer();
      lanClientApi.setBaseUrl(`http://${parsed.host}:${parsed.port}`);
      const res = await lanClientApi.authenticate(
        parsed.code,
        deviceName.trim() || undefined,
        peer ?? undefined
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
        // 连接失败：回滚本次自动开启的本机共享，避免留下"孤儿服务端"
        rollbackServerIfStarted(peer);
        setError(
          res.error ||
            t('settings.lanShare.client.authFailed') ||
            '访问码错误，连接失败'
        );
      }
    } catch (e: any) {
      rollbackServerIfStarted(peer);
      setError(
        e?.message ||
          t('settings.lanShare.client.connectFailed') ||
          '连接失败，请检查地址与网络'
      );
    } finally {
      setConnecting(false);
    }
  }, [deviceName, settings, onUpdateSettings, refreshDevices, ensureOwnServer, rollbackServerIfStarted, t]);

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
          {t('settings.lanShare.client.title') || '连接桌面端'}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('settings.lanShare.client.description') ||
            '扫码连接桌面端后，桌面端可浏览本机图片（双向互联）'}
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

            {/* 双向连接状态 */}
            <div className="pt-3 mt-3 border-t border-gray-200 dark:border-gray-700">
              <div className={`flex items-center gap-2 text-xs ${myServerDeviceCount !== null && myServerDeviceCount > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-500 dark:text-gray-400'}`}>
                {myServerDeviceCount !== null && myServerDeviceCount > 0 ? (
                  <>
                    <Check size={14} className="shrink-0" />
                    <span>
                      {t('settings.lanShare.client.bidirectionalOn') || '双向连接已建立：桌面端已自动连接本机'}
                    </span>
                  </>
                ) : (
                  <>
                    <Loader2 size={14} className="shrink-0 animate-spin" />
                    <span>
                      {t('settings.lanShare.client.bidirectionalWaiting') || '等待桌面端自动连接本机…'}
                    </span>
                  </>
                )}
              </div>
            </div>

            {/* 本机共享状态（双向融合：与桌面端连接是一个整体，无独立停止按钮；
                断开即彻底断开，通知栏"停止共享"同样断开整条链路） */}
            {myServerStatus?.is_running && (
              <div className="pt-3 mt-3 border-t border-gray-200 dark:border-gray-700">
                <div className="flex items-center gap-2">
                  <div className="flex-1 min-w-0 text-xs text-gray-500 dark:text-gray-400">
                    <span className="text-green-600 dark:text-green-400 font-medium">
                      {t('settings.lanShare.androidServer.running') || '共享中'}
                    </span>
                    {myServerUrl && (
                      <span className="font-mono"> · {myServerUrl}</span>
                    )}
                    <span>
                      {' '}
                      · {t('settings.lanShare.androidServer.accessCode') || '访问验证码'}：
                      <span className="font-mono font-bold text-gray-800 dark:text-white">
                        {settings.accessCode || '----'}
                      </span>
                    </span>
                    {myServerDeviceCount !== null && myServerDeviceCount > 0 && (
                      <span> · {myServerDeviceCount} {t('settings.lanShare.online') || '在线'}</span>
                    )}
                  </div>
                  {myServerUrl && (
                    <button
                      onClick={handleCopyServerUrl}
                      className="px-2.5 py-1.5 flex items-center gap-1 text-xs bg-blue-500 hover:bg-blue-600 text-white rounded-lg transition-colors shrink-0"
                    >
                      {serverCopied
                        ? (t('settings.lanShare.copied') || '已复制')
                        : (t('settings.lanShare.copy') || '复制')}
                    </button>
                  )}
                </div>
              </div>
            )}
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
