import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Wifi, Copy, RefreshCw, Shield, Smartphone, ExternalLink, Check, AlertCircle, Loader2, Monitor, Tablet, Link2, LogOut } from 'lucide-react';
import { listen } from '@tauri-apps/api/event';
import { LanShareSettings, ConnectedDevice, AndroidClientConnection } from '../../types';
import {
  lanShareStart,
  lanShareStop,
  lanShareGetStatus,
  lanShareGetDevices,
  lanShareRenameDevice,
  lanShareUpdateConfig,
  lanShareGetLocalIp,
  lanShareRemoveDevice,
  LanShareStatus,
} from '../../api/tauri-bridge';
import { isAndroidPlatform } from '../../utils/androidPlatform';
import { LanClientPanel } from '../lan-client/LanClientPanel';
import { androidClientRegistry } from '../android-client/androidClientApi';

interface LanSharePanelProps {
  t: (key: string) => string;
  settings: LanShareSettings;
  onUpdateSettings: (settings: LanShareSettings) => void;
  rootPath?: string;
}

const generateAccessCode = (): string => {
  return Math.floor(1000 + Math.random() * 9000).toString();
};

const generateQRCodeUrl = (text: string): string => {
  return `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(text)}`;
};

const getDeviceIcon = (deviceType: string) => {
  switch (deviceType) {
    case 'desktop': return Monitor;
    case 'tablet': return Tablet;
    case 'phone': return Smartphone;
    default: return Smartphone;
  }
};

export const LanSharePanel: React.FC<LanSharePanelProps> = ({
  t,
  settings,
  onUpdateSettings,
  rootPath,
}) => {
  const [copied, setCopied] = useState(false);
  const [qrCodeUrl, setQrCodeUrl] = useState<string>('');
  const [qrLoading, setQrLoading] = useState(false);
  const [serverStatus, setServerStatus] = useState<LanShareStatus | null>(null);
  const [connectedDevices, setConnectedDevices] = useState<ConnectedDevice[]>([]);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const [isAndroid, setIsAndroid] = useState(false);
  const [serverNameInput, setServerNameInput] = useState(settings.serverName || '');

  useEffect(() => {
    isAndroidPlatform().then(setIsAndroid);
  }, []);

  const serverUrl = serverStatus?.is_running && serverStatus.local_ip
    ? `http://${serverStatus.local_ip}:${serverStatus.port}`
    : null;

  const qrContent = serverUrl
    ? JSON.stringify({ type: 'aurora-lan', url: serverUrl, code: settings.accessCode })
    : null;

  useEffect(() => {
    if (qrContent) {
      setQrLoading(true);
      setQrCodeUrl(generateQRCodeUrl(qrContent));
    } else {
      setQrCodeUrl('');
      setQrLoading(false);
    }
  }, [qrContent]);

  useEffect(() => {
    lanShareGetStatus().then(setServerStatus).catch(console.error);
  }, []);

  // 服务器运行时拉取设备列表：Tauri 事件驱动即时刷新 + 3s 轮询兜底。
  // 事件由后端在设备认证/登出/清理时 emit，连接或断开几乎瞬间反映到 UI。
  useEffect(() => {
    if (settings.enabled && serverStatus?.is_running) {
      // 立即获取一次，避免打开设置面板时先显示"暂无设备"
      lanShareGetDevices().then(setConnectedDevices).catch(console.error);

      pollIntervalRef.current = setInterval(async () => {
        try {
          const devices = await lanShareGetDevices();
          setConnectedDevices(devices);
        } catch (e) {
          console.error('Failed to poll devices:', e);
        }
      }, 3000);

      return () => {
        if (pollIntervalRef.current) {
          clearInterval(pollIntervalRef.current);
        }
      };
    } else {
      setConnectedDevices([]);
    }
  }, [settings.enabled, serverStatus?.is_running]);

  // 监听后端推送的设备变化事件，收到后立即刷新列表（无需等待 3s 轮询）
  useEffect(() => {
    if (!settings.enabled || !serverStatus?.is_running) return;
    const unlistenPromise = listen('lan-share-devices-changed', () => {
      lanShareGetDevices().then(setConnectedDevices).catch(console.error);
    });
    return () => {
      unlistenPromise.then(unlisten => unlisten()).catch(() => {});
    };
  }, [settings.enabled, serverStatus?.is_running]);

  const handleToggle = useCallback(async () => {
    const newEnabled = !settings.enabled;
    setError(null);

    if (newEnabled) {
      if (!rootPath) {
        setError(t('settings.lanShare.noRootPath') || '请先选择图库根目录');
        return;
      }

      setIsStarting(true);
      try {
        const updates: LanShareSettings = {
          ...settings,
          enabled: true,
        };
        if (!settings.accessCode) {
          updates.accessCode = generateAccessCode();
        }

        const info = await lanShareStart(updates, rootPath);
        onUpdateSettings(updates);
        setServerStatus({
          is_running: true,
          port: info.port,
          local_ip: info.local_ip,
          device_count: 0,
        });
      } catch (e: any) {
        console.error('Failed to start LAN share:', e);
        setError(e.message || t('settings.lanShare.startFailed') || '启动失败');
        onUpdateSettings({ ...settings, enabled: false });
      } finally {
        setIsStarting(false);
      }
    } else {
      setIsStopping(true);
      try {
        await lanShareStop();
        onUpdateSettings({ ...settings, enabled: false });
        setServerStatus({
          is_running: false,
          port: settings.port,
          local_ip: null,
          device_count: 0,
        });
        setConnectedDevices([]);
      } catch (e: any) {
        console.error('Failed to stop LAN share:', e);
        setError(e.message || t('settings.lanShare.stopFailed') || '停止失败');
      } finally {
        setIsStopping(false);
      }
    }
  }, [settings, rootPath, onUpdateSettings, t]);

  const handleRegenerateCode = useCallback(() => {
    const newCode = generateAccessCode();
    onUpdateSettings({
      ...settings,
      accessCode: newCode,
    });
  }, [settings, onUpdateSettings]);

  const handleCopyUrl = useCallback(() => {
    if (serverUrl) {
      navigator.clipboard.writeText(serverUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }, [serverUrl]);

  const handleAllowEditToggle = useCallback(() => {
    onUpdateSettings({
      ...settings,
      allowEdit: !settings.allowEdit,
    });
  }, [settings, onUpdateSettings]);

  // 服务器名称编辑：失焦或回车时保存。服务运行中则实时推送到服务端，
  // 否则只存 settings，下次 lanShareStart 时生效。
  const handleServerNameCommit = useCallback(async () => {
    const trimmed = serverNameInput.trim();
    if (trimmed === (settings.serverName || '')) return;
    const newSettings = { ...settings, serverName: trimmed };
    onUpdateSettings(newSettings);
    if (serverStatus?.is_running) {
      try {
        await lanShareUpdateConfig(newSettings);
      } catch (e) {
        console.error('Failed to update server name:', e);
      }
    }
  }, [serverNameInput, settings, onUpdateSettings, serverStatus]);

  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');

  const handleStartEdit = useCallback((device: { id: string; name: string }) => {
    setEditingDeviceId(device.id);
    setEditingName(device.name);
  }, []);

  const handleCancelEdit = useCallback(() => {
    setEditingDeviceId(null);
    setEditingName('');
  }, []);

  const handleSaveEdit = useCallback(async (deviceId: string) => {
    const trimmed = editingName.trim();
    const original = connectedDevices.find(d => d.id === deviceId);
    // 空名或未变更时直接取消，不发请求
    if (!trimmed || (original && original.name === trimmed)) {
      setEditingDeviceId(null);
      setEditingName('');
      return;
    }
    const ok = await lanShareRenameDevice(deviceId, trimmed);
    if (ok) {
      setConnectedDevices(prev =>
        prev.map(d => (d.id === deviceId ? { ...d, name: trimmed } : d))
      );
      // 同步侧边栏设备名：按 IP 更新对应安卓设备连接的 serverName
      const device = connectedDevices.find(d => d.id === deviceId);
      if (device) {
        const clients = settings.androidClients || [];
        const idx = clients.findIndex(c => c.host === device.ip);
        if (idx >= 0) {
          const newClients = [...clients];
          newClients[idx] = { ...newClients[idx], serverName: trimmed };
          onUpdateSettings({ ...settings, androidClients: newClients });
        }
      }
    }
    setEditingDeviceId(null);
    setEditingName('');
  }, [editingName, connectedDevices, settings, onUpdateSettings]);

  const isLoading = isStarting || isStopping;

  // 融合后的设备列表：桌面端服务端已连接设备 + 桌面端反向连接的安卓设备（按 IP 去重）。
  // 扫码连接（双向融合）后，同一台手机在两个方向各有一条记录，这里合并为一行。
  // hasServerSession = 手机作为客户端连着桌面端；clientKey = 桌面端反向连着手机。
  const androidClients: AndroidClientConnection[] = settings.androidClients || [];
  const clientByHost = new Map(androidClients.map((c) => [c.host, c]));
  const mergedDevices: {
    id: string;
    name: string;
    ip: string;
    deviceType: string;
    clientKey?: string;
    hasServerSession: boolean;
    isEditable: boolean;
  }[] = [
    ...connectedDevices.map((d) => ({
      id: d.id,
      name: d.name,
      ip: d.ip,
      deviceType: d.deviceType,
      clientKey: clientByHost.get(d.ip)?.key,
      hasServerSession: true,
      isEditable: true,
    })),
    ...androidClients
      .filter((c) => !connectedDevices.some((d) => d.ip === c.host))
      .map((c) => ({
        id: c.key,
        name: c.serverName || '安卓设备',
        ip: c.host,
        deviceType: 'phone',
        clientKey: c.key,
        hasServerSession: false,
        isEditable: false,
      })),
  ];

  // 断开与某台设备的连接（双向融合：两个方向都彻底断开）。
  // 1. 桌面端 → 手机：注销反向客户端并移除连接配置；
  // 2. 手机 → 桌面端：踢出该设备在桌面端服务端的会话（手机心跳收到 401 后自动清理）。
  const handleDisconnectAndroidDevice = useCallback(
    async (device: {
      id: string;
      clientKey?: string;
      hasServerSession: boolean;
    }) => {
      if (device.clientKey) {
        const client = androidClientRegistry.get(device.clientKey);
        if (client) {
          await client.disconnect().catch(() => {});
        }
        androidClientRegistry.unregister(device.clientKey);
      }
      if (device.hasServerSession) {
        await lanShareRemoveDevice(device.id).catch(() => {});
      }
      onUpdateSettings({
        ...settings,
        androidClients: (settings.androidClients || []).filter(
          (c) => c.key !== device.clientKey
        ),
      });
    },
    [settings, onUpdateSettings]
  );

  if (isAndroid) {
    return (
      <div className="space-y-5 animate-fade-in">
        {/* 双向融合单面板：本机共享状态已并入连接卡片，不再有独立的
            "停止共享"卡（扫码连接自动开启本机共享，断开即彻底断开） */}
        <LanClientPanel
          t={t}
          settings={settings}
          onUpdateSettings={onUpdateSettings}
        />
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-lg font-bold text-gray-800 dark:text-white flex items-center">
            <Wifi size={20} className="mr-2 text-blue-500" />
            {t('settings.lanShare.title') || '局域网共享'}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t('settings.lanShare.description') || '允许同一 Wi-Fi 下的设备（手机、平板）访问和管理图库'}
          </p>
        </div>
        <button
          onClick={handleToggle}
          disabled={isLoading}
          className={`relative inline-flex h-7 w-12 items-center rounded-full transition-colors ${
            settings.enabled
              ? 'bg-green-500'
              : 'bg-gray-300 dark:bg-gray-600'
          } ${isLoading ? 'opacity-50 cursor-not-allowed' : ''}`}
        >
          {isLoading ? (
            <span className="inline-flex items-center justify-center h-5 w-5 mx-auto">
              <Loader2 size={14} className="animate-spin text-white" />
            </span>
          ) : (
            <span
              className={`inline-block h-5 w-5 transform rounded-full bg-white transition-transform ${
                settings.enabled ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          )}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 text-sm text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 p-3 rounded-lg">
          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
          <p>{error}</p>
        </div>
      )}

      {settings.enabled && (
        <div className="space-y-6">
          <div className="bg-surface rounded-xl p-6 border border-subtle">
            <div className="grid grid-cols-2 gap-6">
              <div className="space-y-3">
                <label className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center">
                  {t('settings.lanShare.scanToConnect') || '扫码连接'}
                </label>
                <div className="bg-white rounded-lg p-3 inline-block border border-subtle overflow-hidden relative">
                  {qrLoading && (
                    <div className="absolute top-3 left-3 w-36 h-36 bg-white rounded flex items-center justify-center z-10">
                      <Loader2 size={32} className="text-gray-400 animate-spin" />
                    </div>
                  )}
                  {qrCodeUrl ? (
                    <img
                      src={qrCodeUrl}
                      alt="QR Code"
                      className="w-36 h-36 object-contain block"
                      onLoad={() => setQrLoading(false)}
                      onError={() => setQrLoading(false)}
                    />
                  ) : (
                    <div className="w-36 h-36 bg-gray-100 rounded flex items-center justify-center">
                      {serverStatus?.is_running ? (
                        <Loader2 size={32} className="text-gray-400 animate-spin" />
                      ) : (
                        <Wifi size={32} className="text-gray-400" />
                      )}
                    </div>
                  )}
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2 text-center">
                  {t('settings.lanShare.qrTip') || '手机扫码即可自动连接，无需手动输入访问码'}
                </p>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center mb-2">
                    {t('settings.lanShare.serverName') || '服务器名称'}
                  </label>
                  <input
                    type="text"
                    value={serverNameInput}
                    onChange={(e) => setServerNameInput(e.target.value)}
                    onBlur={handleServerNameCommit}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        e.currentTarget.blur();
                      }
                    }}
                    placeholder={t('settings.lanShare.serverNamePlaceholder') || '如：我的图库'}
                    maxLength={30}
                    className="w-full px-3 py-2 bg-panel rounded-lg text-sm text-gray-800 dark:text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500/30 transition-colors"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium text-gray-700 dark:text-gray-300 flex items-center mb-2">
                    {t('settings.lanShare.accessCode') || '访问验证码'}
                  </label>
                  <div className="flex items-center gap-3">
                    <div className="bg-gray-900 text-white px-4 py-2 rounded-lg text-2xl font-mono font-bold tracking-wider w-[180px] text-center">
                      {settings.accessCode || '----'}
                    </div>
                    <button
                      onClick={handleRegenerateCode}
                      className="p-2 text-gray-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                      title={t('settings.lanShare.regenerate') || '重新生成'}
                    >
                      <RefreshCw size={18} />
                    </button>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-2">
                  <div className="flex items-center gap-2">
                    <Shield size={16} className="text-gray-400" />
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {t('settings.lanShare.allowEdit') || '允许编辑和删除'}
                    </span>
                  </div>
                  <button
                    onClick={handleAllowEditToggle}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                      settings.allowEdit
                        ? 'bg-blue-500'
                        : 'bg-gray-300 dark:bg-gray-600'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        settings.allowEdit ? 'translate-x-5' : 'translate-x-0.5'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            <div className="mt-6 pt-4 border-t border-gray-300 dark:border-gray-600">
              <label className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2 block">
                {t('settings.lanShare.accessUrl') || '访问地址'}
              </label>
              <div className="flex items-center gap-2">
                <div className="flex-1 bg-panel rounded-lg px-3 py-2 text-sm text-gray-600 dark:text-gray-400 font-mono">
                  {serverUrl || (t('settings.lanShare.notRunning') || '服务未启动')}
                </div>
                {serverUrl && (
                  <>
                    <button
                      onClick={handleCopyUrl}
                      className="flex items-center gap-1.5 px-3 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      {copied ? (
                        <>
                          <Check size={14} />
                          {t('settings.lanShare.copied') || '已复制'}
                        </>
                      ) : (
                        <>
                          <Copy size={14} />
                          {t('settings.lanShare.copy') || '复制'}
                        </>
                      )}
                    </button>
                    <button
                      onClick={() => window.open(serverUrl, '_blank')}
                      className="p-2 text-gray-500 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/20 rounded-lg transition-colors"
                      title={t('settings.lanShare.open') || '打开'}
                    >
                      <ExternalLink size={16} />
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="bg-surface rounded-xl p-4 border border-subtle">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                {t('settings.lanShare.connectedDevices') || '已连接设备'}
              </h4>
              <span className="px-2 py-0.5 bg-green-100 dark:bg-green-900/30 text-green-600 dark:text-green-400 text-xs font-medium rounded-full">
                {mergedDevices.length} {t('settings.lanShare.online') || '在线'}
              </span>
            </div>

            {mergedDevices.length > 0 ? (
              <div className="space-y-2">
                {mergedDevices.map((device) => {
                  const DeviceIcon = getDeviceIcon(device.deviceType);
                  const isEditing = editingDeviceId === device.id;
                  return (
                    <div
                      key={device.id}
                      className="flex items-center justify-between p-3 bg-surface rounded-lg border border-subtle"
                    >
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-8 h-8 bg-surface rounded-lg flex items-center justify-center shrink-0">
                          <DeviceIcon size={16} className="text-gray-500" />
                        </div>
                        <div className="min-w-0 flex-1">
                          {isEditing ? (
                            <input
                              type="text"
                              value={editingName}
                              onChange={(e) => setEditingName(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  handleSaveEdit(device.id);
                                } else if (e.key === 'Escape') {
                                  e.preventDefault();
                                  handleCancelEdit();
                                }
                              }}
                              onBlur={() => handleSaveEdit(device.id)}
                              autoFocus
                              maxLength={30}
                              className="w-full text-sm font-medium text-gray-800 dark:text-white bg-content border border-blue-500 rounded px-2 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-500"
                            />
                          ) : (
                            <div
                              className={`text-sm font-medium text-gray-800 dark:text-white truncate ${device.isEditable ? 'cursor-text hover:text-blue-500 transition-colors' : ''}`}
                              onClick={() => {
                                if (device.isEditable) handleStartEdit(device);
                              }}
                              title={device.isEditable ? (t('settings.lanShare.clickToEdit') || '点击编辑名称') : undefined}
                            >
                              {device.name}
                            </div>
                          )}
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {device.ip}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 ml-2">
                        {device.clientKey && device.hasServerSession && (
                          <span className="px-1.5 py-0.5 bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 text-[10px] font-medium rounded-full flex items-center gap-0.5">
                            <Link2 size={10} />
                            {t('settings.lanShare.bidirectional') || '双向'}
                          </span>
                        )}
                        <button
                          onClick={() =>
                            handleDisconnectAndroidDevice({
                              id: device.id,
                              clientKey: device.clientKey,
                              hasServerSession: device.hasServerSession,
                            })
                          }
                          className="p-1.5 text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                          title={t('settings.lanShare.androidClient.disconnect') || '断开'}
                        >
                          <LogOut size={13} />
                        </button>
                        <div className="w-2 h-2 bg-green-500 rounded-full animate-pulse" />
                        <span className="text-xs text-gray-500 dark:text-gray-400">
                          {device.hasServerSession
                            ? (t('settings.lanShare.active') || '活跃')
                            : (t('settings.lanShare.connected') || '已连接')}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-6 text-gray-500 dark:text-gray-400">
                <Wifi size={32} className="mx-auto mb-2 opacity-50" />
                <p className="text-sm">
                  {t('settings.lanShare.noDevices') || '暂无设备连接，等待安卓端扫码连接'}
                </p>
              </div>
            )}
          </div>

          <div className="flex items-start gap-2 text-xs text-gray-500 dark:text-gray-400 bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg">
            <AlertCircle size={14} className="mt-0.5 text-blue-500 flex-shrink-0" />
            <p>
              {t('settings.lanShare.tip') || '确保设备连接到同一 Wi-Fi 网络'}
              {' '}
              {t('settings.lanShare.androidConnectTip') || '安卓端扫码连接后自动建立双向互联，可在左侧边栏浏览手机图片'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};

export default LanSharePanel;
