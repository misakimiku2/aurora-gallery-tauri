import { useCallback, useEffect, useRef, useState } from 'react';
import {
  androidClientRegistry,
  androidDeviceKeyOf,
} from '../components/android-client/androidClientApi';
import { AndroidDeviceInfo } from '../components/android-client/androidClientTypes';
import { ANDROID_ROOT_IMAGES_ID } from '../constants';
import { AppState, AndroidClientConnection, FileNode, FileType, TabState } from '../types';

interface UseAndroidClientParams {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  t: (key: string) => string;
  showToast: (msg: string) => void;
  enterFolder: (folderId: string, options?: { scrollToItemId?: string; resetScroll?: boolean }) => void;
}

/**
 * 桌面端 → 安卓设备客户端同步（多设备架构）：
 * 每台设备独立连接实例（androidClientRegistry），独立加载根目录/心跳/浏览，
 * 侧边栏每台设备一个节点，可同时浏览多台安卓设备。
 */
export const useAndroidClient = ({
  state,
  setState,
  activeTab,
  t,
  showToast,
  enterFolder,
}: UseAndroidClientParams) => {
  const [androidDevices, setAndroidDevices] = useState<AndroidDeviceInfo[]>([]);

  const loadingKeysRef = useRef<Set<string>>(new Set());

  const conns: AndroidClientConnection[] = state.settings.lanShare.androidClients || [];
  const connKeys = conns.map((c) => c.key).join('|');

  // 旧版单设备配置迁移：androidClient 存在而 androidClients 为空时转换
  useEffect(() => {
    const legacy = state.settings.lanShare.androidClient;
    if (
      legacy?.host &&
      legacy?.port &&
      legacy?.accessToken &&
      !state.settings.lanShare.androidClients
    ) {
      const key = androidDeviceKeyOf(legacy.host, legacy.port);
      const migrated: AndroidClientConnection = {
        key,
        host: legacy.host,
        port: legacy.port,
        accessToken: legacy.accessToken,
        serverName: legacy.serverName,
        connectedAt: legacy.lastConnectedAt || Date.now(),
      };
      setState((s) => ({
        ...s,
        settings: {
          ...s.settings,
          lanShare: {
            ...s.settings.lanShare,
            androidClients: [migrated],
            androidClient: undefined,
          },
        },
      }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.settings.lanShare.androidClient, state.settings.lanShare.androidClients]);

  // 同步设备状态列表与注册表（连接变化时重建）
  const prevKeysRef = useRef<string[]>([]);
  useEffect(() => {
    const current = new Map<string, AndroidClientConnection>();
    for (const c of conns) {
      if (c.host && c.port) current.set(c.key, c);
    }

    // 被移除的设备：注销注册表 + 清理其文件节点（在 updater 之外执行副作用）
    const removedKeys = prevKeysRef.current.filter((k) => !current.has(k));
    for (const k of removedKeys) {
      androidClientRegistry.unregister(k);
      cleanupDeviceFiles(k);
    }
    prevKeysRef.current = Array.from(current.keys());

    setAndroidDevices((prev) => {
      const next: AndroidDeviceInfo[] = [];
      for (const [key, c] of current) {
        const existing = prev.find((d) => d.key === key);
        next.push(
          existing
            ? { ...existing, host: c.host, port: c.port, name: c.serverName || existing.name }
            : {
                key,
                host: c.host,
                port: c.port,
                name: c.serverName || '我的手机',
                connected: false,
                loading: false,
                roots: [],
              }
        );
      }
      return next;
    });

    // 注册表同步：为每台设备注册/更新客户端与 token
    for (const c of conns) {
      if (!c.host || !c.port) continue;
      androidClientRegistry.register(
        c.key,
        `http://${c.host}:${c.port}`,
        c.accessToken || null
      );
    }
    for (const client of androidClientRegistry.getAll()) {
      if (!current.has(client.key)) {
        androidClientRegistry.unregister(client.key);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connKeys]);

  /** 清理指定设备的所有文件节点。 */
  const cleanupDeviceFiles = useCallback(
    (key: string) => {
      setState((s) => {
        const files = { ...s.files };
        let changed = false;
        for (const [id, f] of Object.entries(files)) {
          if (f.source === 'android' && (f.remoteDeviceKey === key || id.startsWith(`${ANDROID_ROOT_IMAGES_ID}:${key}`))) {
            delete files[id];
            changed = true;
          }
        }
        return changed ? { ...s, files } : s;
      });
    },
    [setState]
  );

  // 设备名同步：设置面板中重命名设备（更新 androidClients[].serverName）后，
  // 侧边栏设备行与总览标题需要同步显示新名字（key 未变，单独监听名称变化）。
  useEffect(() => {
    setAndroidDevices((prev) => {
      let changed = false;
      const next = prev.map((d) => {
        const c = conns.find((cc) => cc.key === d.key);
        if (c?.serverName && c.serverName !== d.name) {
          changed = true;
          return { ...d, name: c.serverName };
        }
        return d;
      });
      return changed ? next : prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns.map((c) => `${c.key}:${c.serverName || ''}`).join('|')]);

  // 每台设备的根目录加载（指数退避重试）
  useEffect(() => {
    for (const c of conns) {
      if (!c.accessToken || !c.host || !c.port) continue;
      if (loadingKeysRef.current.has(c.key)) continue;
      loadingKeysRef.current.add(c.key);
      const client = androidClientRegistry.register(
        c.key,
        `http://${c.host}:${c.port}`,
        c.accessToken
      );
      setDeviceLoading(c.key, true);

      const backoff = [2000, 4000, 8000, 12000, 20000];
      const loadRoots = async (attempt: number): Promise<void> => {
        try {
          const { folders, rootImages } = await client.getAllImageFolders();
          applyDeviceRoots(c.key, folders, rootImages);
          setDeviceConnected(c.key, true);
        } catch (err) {
          const msg = (err as Error).message || '';
          if (
            msg.includes('Authentication failed') ||
            msg.includes('token expired') ||
            msg.includes('HTTP 401')
          ) {
            // token 失效：清除该设备连接
            console.warn(`[AndroidClient] device ${c.key} token invalid, removing`);
            client.disconnect();
            removeConnectionFromSettings(c.key);
            return;
          }
          if (attempt < backoff.length) {
            await new Promise((r) => setTimeout(r, backoff[attempt]));
            return loadRoots(attempt + 1);
          }
          console.error(`[AndroidClient] device ${c.key} failed to load roots:`, err);
          setDeviceConnected(c.key, false);
        }
      };

      loadRoots(0).finally(() => {
        loadingKeysRef.current.delete(c.key);
        setDeviceLoading(c.key, false);
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connKeys]);

  const setDeviceLoading = useCallback((key: string, loading: boolean) => {
    setAndroidDevices((prev) =>
      prev.map((d) => (d.key === key ? { ...d, loading } : d))
    );
  }, []);

  const setDeviceConnected = useCallback((key: string, connected: boolean) => {
    setAndroidDevices((prev) =>
      prev.map((d) => (d.key === key ? { ...d, connected } : d))
    );
  }, []);

  const applyDeviceRoots = useCallback(
    (key: string, folders: FileNode[], images: FileNode[]) => {
      const newFiles: Record<string, FileNode> = {};
      const rootIds: string[] = [];

      for (const f of folders) {
        newFiles[f.id] = f;
        rootIds.push(f.id);
      }

      const virtualRootId = `${ANDROID_ROOT_IMAGES_ID}:${key}`;
      if (images.length > 0) {
        for (const img of images) {
          newFiles[img.id] = { ...img, parentId: virtualRootId };
        }
        newFiles[virtualRootId] = {
          id: virtualRootId,
          parentId: null,
          name: '根目录图片',
          type: FileType.FOLDER,
          path: `android://${key}/__root_images__`,
          remotePath: '__root_images__',
          remoteDeviceKey: key,
          source: 'android',
          children: images.map((img) => img.id),
          tags: [],
          coverImagePath: images[0]?.path,
          imageCount: images.length,
        };
        rootIds.push(virtualRootId);
      }

      setState((s) => ({ ...s, files: { ...s.files, ...newFiles } }));
      setAndroidDevices((prev) =>
        prev.map((d) => (d.key === key ? { ...d, roots: rootIds } : d))
      );
    },
    [setState]
  );

  const removeConnectionFromSettings = useCallback(
    (key: string) => {
      setState((s) => ({
        ...s,
        settings: {
          ...s.settings,
          lanShare: {
            ...s.settings.lanShare,
            androidClients: (s.settings.lanShare.androidClients || []).filter(
              (c) => c.key !== key
            ),
          },
        },
      }));
    },
    [setState]
  );

  // 心跳：为每台已连接的设备每 5s 发送一次。
  // 连续 3 次失败（约 15s，与服务端在线判定阈值一致）视为设备已离线
  // （如手机端"停止共享"），自动移除该设备连接并提示。
  const heartbeatFailuresRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    const connectedKeys = androidDevices.filter((d) => d.connected).map((d) => d.key);
    if (connectedKeys.length === 0) return;
    const sendHeartbeats = async () => {
      for (const key of connectedKeys) {
        const client = androidClientRegistry.get(key);
        if (!client) continue;
        try {
          await client.heartbeat();
          heartbeatFailuresRef.current.delete(key);
        } catch {
          const failures = (heartbeatFailuresRef.current.get(key) || 0) + 1;
          if (failures >= 3) {
            heartbeatFailuresRef.current.delete(key);
            const device = androidDevices.find((d) => d.key === key);
            androidClientRegistry.unregister(key);
            setDeviceConnected(key, false);
            removeConnectionFromSettings(key);
            showToast(
              (t('settings.lanShare.androidClient.connectionLost') || '与「{name}」的连接已断开')
                .replace('{name}', device?.name || '安卓设备')
            );
          } else {
            heartbeatFailuresRef.current.set(key, failures);
          }
        }
      }
    };
    sendHeartbeats();
    const interval = setInterval(sendHeartbeats, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [androidDevices.filter((d) => d.connected).map((d) => d.key).join('|')]);

  /** 浏览安卓端文件夹（按节点携带的设备 key 分发）。 */
  const handleNavigateAndroidFolder = useCallback(
    async (folderId: string) => {
      const folder = state.files[folderId];
      if (!folder || folder.source !== 'android' || !folder.remotePath) return;
      const key = folder.remoteDeviceKey || '';
      const client = androidClientRegistry.get(key);
      if (!client) return;

      if (folder.id.startsWith(`${ANDROID_ROOT_IMAGES_ID}:`)) {
        enterFolder(folderId, { resetScroll: true });
        return;
      }

      if (folder.children && folder.children.length > 0) {
        enterFolder(folderId, { resetScroll: true });
        return;
      }

      setState((s) => ({
        ...s,
        files: {
          ...s.files,
          [folderId]: { ...s.files[folderId], children: [], isRefreshing: true },
        },
      }));
      enterFolder(folderId, { resetScroll: true });
      setDeviceLoading(key, true);

      try {
        const { folders, images } = await client.browseToFolderNodes(folder.remotePath);
        const newFiles: Record<string, FileNode> = {};
        const childIds: string[] = [];
        for (const f of folders) {
          newFiles[f.id] = { ...f, parentId: folderId };
          childIds.push(f.id);
        }
        for (const img of images) {
          newFiles[img.id] = { ...img, parentId: folderId };
          childIds.push(img.id);
        }
        setState((s) => ({
          ...s,
          files: {
            ...s.files,
            ...newFiles,
            [folderId]: { ...s.files[folderId], children: childIds, isRefreshing: false },
          },
        }));
      } catch (err) {
        console.error('[AndroidClient] Failed to load folder:', err);
        showToast(
          (err as Error).message ||
            (t('settings.lanShare.androidClient.loadFailed') || '加载安卓设备文件夹失败')
        );
        setState((s) => ({
          ...s,
          files: {
            ...s.files,
            [folderId]: { ...s.files[folderId], isRefreshing: false },
          },
        }));
      } finally {
        setDeviceLoading(key, false);
      }
    },
    [state.files, enterFolder, setState, showToast, t, setDeviceLoading]
  );

  /** 指定设备总览视图下拉刷新。 */
  const handleAndroidRefresh = useCallback(
    async (key: string) => {
      const client = androidClientRegistry.get(key);
      if (!client) return;
      setDeviceLoading(key, true);
      try {
        const { folders, rootImages } = await client.getAllImageFolders();
        applyDeviceRoots(key, folders, rootImages);
      } catch (err) {
        console.error('[AndroidClient] Refresh failed:', err);
      } finally {
        setDeviceLoading(key, false);
      }
    },
    [applyDeviceRoots, setDeviceLoading]
  );

  /** 重载当前安卓文件夹（浏览器视图刷新）。 */
  const reloadCurrentAndroidFolder = useCallback(async () => {
    const folder = state.files[activeTab.folderId];
    if (!folder || folder.source !== 'android' || !folder.remotePath) return;
    const key = folder.remoteDeviceKey || '';
    if (folder.id.startsWith(`${ANDROID_ROOT_IMAGES_ID}:`)) return;
    const client = androidClientRegistry.get(key);
    if (!client) return;
    setDeviceLoading(key, true);
    try {
      const { folders, images } = await client.browseToFolderNodes(folder.remotePath);
      const newFiles: Record<string, FileNode> = {};
      const childIds: string[] = [];
      for (const f of folders) {
        newFiles[f.id] = { ...f, parentId: folder.id };
        childIds.push(f.id);
      }
      for (const img of images) {
        newFiles[img.id] = { ...img, parentId: folder.id };
        childIds.push(img.id);
      }
      setState((s) => ({
        ...s,
        files: { ...s.files, ...newFiles, [folder.id]: { ...s.files[folder.id], children: childIds } },
      }));
    } catch (err) {
      console.error('[AndroidClient] Failed to refresh folder:', err);
    } finally {
      setDeviceLoading(key, false);
    }
  }, [state.files, activeTab.folderId, setState, setDeviceLoading]);

  /** 断开指定设备：注销客户端 + 移除连接配置（文件清理由同步 effect 完成）。 */
  const handleAndroidDisconnect = useCallback(
    async (key: string) => {
      const client = androidClientRegistry.get(key);
      if (client) {
        await client.disconnect();
      }
      androidClientRegistry.unregister(key);
      setAndroidDevices((prev) => prev.filter((d) => d.key !== key));
      removeConnectionFromSettings(key);
      cleanupDeviceFiles(key);
    },
    [removeConnectionFromSettings, cleanupDeviceFiles]
  );

  const handleOpenAndroidSettings = useCallback(() => {
    setState((s) => ({ ...s, isSettingsOpen: true, settingsCategory: 'lanShare' }));
  }, [setState]);

  const androidConnectedCount = androidDevices.filter((d) => d.connected).length;

  return {
    androidDevices,
    androidConnectedCount,
    getDeviceRoots: (key: string): string[] =>
      androidDevices.find((d) => d.key === key)?.roots || [],
    getDeviceState: (key: string): AndroidDeviceInfo | undefined =>
      androidDevices.find((d) => d.key === key),
    handleNavigateAndroidFolder,
    handleAndroidRefresh,
    reloadCurrentAndroidFolder,
    handleAndroidDisconnect,
    handleOpenAndroidSettings,
  };
};
