import React, { useState, useCallback } from 'react';
import {
  Smartphone,
  RefreshCw,
  AlertCircle,
  Loader2,
  Trash2,
  LogOut,
  Clock,
  Link2,
  Check,
  Plus,
} from 'lucide-react';
import { LanShareSettings, SavedAndroidDevice, AndroidClientConnection } from '../../types';
import {
  androidClientRegistry,
  androidDeviceKeyOf,
  getAndroidDesktopDeviceName,
} from './androidClientApi';

interface AndroidClientPanelProps {
  t: (key: string) => string;
  settings: LanShareSettings;
  onUpdateSettings: (settings: LanShareSettings) => void;
}

const DEFAULT_PORT = 8080;
const DEVICE_NAME_KEY = 'aurora_desktop_device_name';

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

/**
 * 桌面端"连接安卓设备"面板（多设备）：
 * - 表单连接新设备（IP/端口/验证码）
 * - 已连接设备列表：每台设备独立断开
 * - 最近设备列表
 * 连接后侧边栏网络分区每台设备一个节点，可同时浏览多台设备。
 */
export const AndroidClientPanel: React.FC<AndroidClientPanelProps> = ({
  t,
  settings,
  onUpdateSettings,
}) => {
  const connectedDevices: AndroidClientConnection[] = settings.androidClients || [];
  const [host, setHost] = useState('');
  const [port, setPort] = useState(String(DEFAULT_PORT));
  const [code, setCode] = useState('');
  const [deviceName, setDeviceName] = useState<string>(() => {
    try {
      const saved = localStorage.getItem(DEVICE_NAME_KEY);
      if (saved && saved.trim()) return saved;
    } catch {}
    return getAndroidDesktopDeviceName();
  });
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const saveDevice = (
    list: SavedAndroidDevice[] | undefined,
    hostName: string,
    portNum: number,
    name?: string
  ): SavedAndroidDevice[] => {
    const next = (list || []).filter((s) => !(s.host === hostName && s.port === portNum));
    next.unshift({ host: hostName, port: portNum, name, lastConnected: Date.now() });
    return next.slice(0, 10);
  };

  const handleConnect = useCallback(async () => {
    setError(null);
    const trimmedHost = host.trim();
    const portNum = parseInt(port, 10);
    const trimmedCode = code.trim();
    if (!trimmedHost || !Number.isFinite(portNum) || portNum <= 0 || portNum > 65535) {
      setError(t('settings.lanShare.androidClient.invalidAddress') || '请填写正确的 IP 地址和端口');
      return;
    }
    if (trimmedHost === '127.0.0.1' || trimmedHost === 'localhost' || trimmedHost === '::1') {
      setError(
        t('settings.lanShare.androidClient.localhostHint') ||
          '这是电脑本机地址。请填写手机上"局域网共享"页面显示的 IP（如 192.168.x.x）'
      );
      return;
    }
    if (!trimmedCode) {
      setError(t('settings.lanShare.androidClient.enterCode') || '请输入验证码');
      return;
    }

    setConnecting(true);
    try {
      const key = androidDeviceKeyOf(trimmedHost, portNum);
      const client = androidClientRegistry.register(
        key,
        `http://${trimmedHost}:${portNum}`,
        null
      );
      // 双向连接融合：桌面端服务运行中时，携带本机服务端信息让手机自动反向连接桌面
      const peerServer =
        settings.enabled && settings.accessCode
          ? { port: settings.port, accessCode: settings.accessCode }
          : undefined;
      const res = await client.authenticate(
        trimmedCode,
        deviceName.trim() || undefined,
        peerServer
      );
      if (res.success && res.token) {
        client.setToken(res.token);
        const savedDevices = saveDevice(
          settings.savedAndroidDevices,
          trimmedHost,
          portNum,
          res.server_name
        );
        const conn: AndroidClientConnection = {
          key,
          host: trimmedHost,
          port: portNum,
          accessToken: res.token,
          serverName: res.server_name,
          connectedAt: Date.now(),
        };
        const others = (settings.androidClients || []).filter((c) => c.key !== key);
        onUpdateSettings({
          ...settings,
          savedAndroidDevices: savedDevices,
          androidClients: [...others, conn],
        });
        setCode('');
      } else {
        setError(
          res.error ||
            t('settings.lanShare.androidClient.authFailed') ||
            '验证码错误，连接失败'
        );
      }
    } catch (e: any) {
      setError(
        e?.message ||
          t('settings.lanShare.androidClient.connectFailed') ||
          '连接失败，请检查地址与网络'
      );
    } finally {
      setConnecting(false);
    }
  }, [host, port, code, deviceName, settings, onUpdateSettings, t]);

  const handleDisconnectDevice = useCallback(
    async (key: string) => {
      const client = androidClientRegistry.get(key);
      if (client) {
        await client.disconnect().catch(() => {});
      }
      androidClientRegistry.unregister(key);
      onUpdateSettings({
        ...settings,
        androidClients: (settings.androidClients || []).filter((c) => c.key !== key),
      });
    },
    [settings, onUpdateSettings]
  );

  const handleSelectDevice = useCallback((s: SavedAndroidDevice) => {
    setHost(s.host);
    setPort(String(s.port));
    setError(null);
  }, []);

  const handleRemoveDevice = useCallback(
    (s: SavedAndroidDevice) => {
      onUpdateSettings({
        ...settings,
        savedAndroidDevices: (settings.savedAndroidDevices || []).filter(
          (d) => !(d.host === s.host && d.port === s.port)
        ),
      });
    },
    [settings, onUpdateSettings]
  );

  const savedDevices = settings.savedAndroidDevices || [];

  return (
    <div className="space-y-4 animate-fade-in">
      <div>
        <h4 className="text-base font-bold text-gray-800 dark:text-white flex items-center">
          <Smartphone size={18} className="mr-2 text-green-500" />
          {t('settings.lanShare.androidClient.title') || '连接安卓设备'}
        </h4>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t('settings.lanShare.androidClient.description') ||
            '输入安卓端显示的 IP、端口与验证码，可同时连接多台设备'}
        </p>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {connectedDevices.length > 0 && (
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
          <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center">
            <Smartphone size={14} className="mr-1.5 text-green-500" />
            {t('settings.lanShare.androidClient.connectedDevices') || '已连接设备'}
            <span className="ml-2 px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 text-xs font-medium rounded-full">
              {connectedDevices.length}
            </span>
          </h5>
          <div className="space-y-1.5">
            {connectedDevices.map((conn) => (
              <div
                key={conn.key}
                className="flex items-center justify-between p-2.5 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <div className="w-8 h-8 bg-green-100 dark:bg-green-900/30 rounded-lg flex items-center justify-center shrink-0">
                    <Check size={16} className="text-green-500" />
                  </div>
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 dark:text-white truncate">
                      {conn.serverName || '安卓设备'}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 font-mono">
                      {conn.host}:{conn.port}
                    </div>
                  </div>
                </div>
                <button
                  onClick={() => handleDisconnectDevice(conn.key)}
                  className="ml-2 px-2.5 py-1.5 flex items-center gap-1 text-xs text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors shrink-0"
                >
                  <LogOut size={12} />
                  {t('settings.lanShare.androidClient.disconnect') || '断开'}
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 border border-gray-200 dark:border-gray-700 space-y-3">
        <div className="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300">
          <Plus size={14} />
          {t('settings.lanShare.androidClient.addDevice') || '连接新设备'}
        </div>
        <div className="flex gap-3">
          <div className="flex-1">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center mb-1.5">
              <Smartphone size={14} className="mr-1.5" />
              {t('settings.lanShare.androidClient.ipAddress') || 'IP 地址'}
            </label>
            <input
              type="text"
              value={host}
              onChange={(e) => setHost(e.target.value)}
              placeholder="192.168.1.100"
              className="w-full h-10 px-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-800 dark:text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
          <div className="w-24">
            <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">
              {t('settings.lanShare.androidClient.port') || '端口'}
            </label>
            <input
              type="text"
              value={port}
              onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
              placeholder="8080"
              inputMode="numeric"
              className="w-full h-10 px-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-800 dark:text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 transition-colors"
            />
          </div>
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">
            {t('settings.lanShare.androidClient.accessCode') || '验证码'}
          </label>
          <input
            type="text"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^0-9]/g, '').slice(0, 4))}
            placeholder="----"
            inputMode="numeric"
            maxLength={4}
            className="w-full h-10 px-4 bg-gray-900 text-white border border-gray-200 dark:border-gray-700 rounded-lg text-xl font-mono font-bold tracking-[0.5em] text-center placeholder-gray-500 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        <div>
          <label className="text-sm font-medium text-gray-700 dark:text-gray-300 block mb-1.5">
            {t('settings.lanShare.androidClient.deviceName') || '本机名称（显示在手机上）'}
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
            placeholder="如：我的电脑"
            maxLength={30}
            className="w-full h-10 px-3 bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg text-sm text-gray-800 dark:text-white placeholder-gray-400 focus:outline-none focus:border-blue-500 transition-colors"
          />
        </div>

        <button
          onClick={handleConnect}
          disabled={connecting}
          className="w-full h-11 flex items-center justify-center gap-2 bg-blue-500 hover:bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-lg text-sm font-medium transition-colors"
        >
          {connecting ? (
            <>
              <Loader2 size={16} className="animate-spin" />
              {t('settings.lanShare.androidClient.connecting') || '连接中...'}
            </>
          ) : (
            <>
              <Link2 size={16} />
              {t('settings.lanShare.androidClient.connect') || '连接'}
            </>
          )}
        </button>
      </div>

      {savedDevices.length > 0 && (
        <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-4 border border-gray-200 dark:border-gray-700">
          <h5 className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 flex items-center">
            <Clock size={14} className="mr-1.5" />
            {t('settings.lanShare.androidClient.recentDevices') || '最近设备'}
          </h5>
          <div className="space-y-1.5">
            {savedDevices.map((s) => (
              <div
                key={`${s.host}:${s.port}`}
                className="flex items-center justify-between h-10 px-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-200 dark:border-gray-700"
              >
                <button
                  onClick={() => handleSelectDevice(s)}
                  className="flex-1 flex items-center justify-between min-w-0 text-left"
                >
                  <div className="min-w-0">
                    <div className="text-sm font-medium text-gray-800 dark:text-white truncate">
                      {s.name ? `${s.name} · ` : ''}{s.host}:{s.port}
                    </div>
                    {s.lastConnected > 0 && (
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {formatLastConnected(s.lastConnected)}
                      </div>
                    )}
                  </div>
                  <RefreshCw size={14} className="text-gray-400 flex-shrink-0 ml-2" />
                </button>
                <button
                  onClick={() => handleRemoveDevice(s)}
                  className="ml-2 p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors flex-shrink-0"
                  title={t('settings.lanShare.androidClient.remove') || '移除'}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg">
        <AlertCircle size={14} className="mt-0.5 text-blue-500 flex-shrink-0" />
        <p>
          {t('settings.lanShare.androidClient.tip') ||
            '在安卓端开启"局域网共享"后，将手机显示的 IP、端口与验证码填入上方即可连接；扫码连接的设备会自动出现在列表中'}
        </p>
      </div>
    </div>
  );
};

export default AndroidClientPanel;
