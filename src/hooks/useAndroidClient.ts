import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  androidClientRegistry,
  androidDeviceKeyOf,
} from '../components/android-client/androidClientApi';
import { AndroidDeviceInfo } from '../components/android-client/androidClientTypes';
import { ANDROID_ROOT_IMAGES_ID, ANDROID_DEVICE_ROOT_PREFIX, androidDeviceRootId } from '../constants';
import { notifyRemoteChange } from '../utils/remoteSource';
import { AppState, AndroidClientConnection, FileNode, FileType, TabState } from '../types';

/**
 * 失效连接判定阈值：本次会话中从未连通的设备，连续重连失败达到该次数后
 * 视为上次运行遗留的失效记录并移除（对端 App 重启后服务端不会自动恢复，
 * 不清理会永远残留一个反复重连的灰节点）。
 * 本次会话中成功连通过的设备不在此列——那类掉线由心跳（连续 3 次失败）处理。
 */
const MAX_STALE_ATTEMPTS = 4;

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
  // 供定时器/异步回调读取最新设备状态（避免闭包读到过期值）
  const androidDevicesRef = useRef<AndroidDeviceInfo[]>(androidDevices);
  androidDevicesRef.current = androidDevices;

  // 每台设备正在进行的加载任务（key → Promise），复用而非重复发起
  const pendingLoadsRef = useRef<Map<string, Promise<boolean>>>(new Map());
  // 每台设备连续失败次数 / 本次会话是否曾成功连通
  const staleAttemptsRef = useRef<Map<string, number>>(new Map());
  const everConnectedRef = useRef<Set<string>>(new Set());
  // 本次会话内由用户主动建立（扫码/手动连接）的设备 key。
  // 只有这些连接会被保留、加载与自动重连；其余一律视为磁盘残留并清理。
  const sessionEstablishedRef = useRef<Set<string>>(new Set());

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

  /**
   * 重启恢复策略：从磁盘恢复的 `androidClients` 记录**不再自动重连**，直接清理。
   *
   * 桌面端会记住多台安卓设备，若开机即逐台自动重连，侧边栏会冒出一堆用户
   * 本次并未连接的设备节点；且对端 App 重启后服务端不会自动恢复，这类重连
   * 注定失败，只会留下一个反复重试的灰节点。因此需要重新访问某台设备时，
   * 在手机端重新扫码即可（扫码为主动建立，会被标记为本会话连接并正常重连）。
   */
  useEffect(() => {
    const restored = conns.filter((c) => !sessionEstablishedRef.current.has(c.key));
    if (restored.length === 0) return;
    for (const c of restored) {
      androidClientRegistry.unregister(c.key);
      cleanupDeviceFiles(c.key);
    }
    setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        lanShare: {
          ...s.settings.lanShare,
          androidClients: (s.settings.lanShare.androidClients || []).filter((c) =>
            sessionEstablishedRef.current.has(c.key)
          ),
        },
      },
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connKeys]);

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
    // 每台设备都要有一个根节点，桌面端才能用文件界面进入它
    for (const [key, c] of current) {
      ensureDeviceRoot(key, c.serverName || undefined);
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
  // 侧边栏设备行、文件界面标题与设备根节点都要同步显示新名字（key 未变，单独监听名称变化）。
  useEffect(() => {
    const renamed: Array<{ key: string; name: string }> = [];
    for (const d of androidDevicesRef.current) {
      const c = conns.find((cc) => cc.key === d.key);
      if (c?.serverName && c.serverName !== d.name) {
        renamed.push({ key: d.key, name: c.serverName });
      }
    }
    if (renamed.length === 0) return;

    setAndroidDevices((prev) =>
      prev.map((d) => {
        const hit = renamed.find((r) => r.key === d.key);
        return hit ? { ...d, name: hit.name } : d;
      })
    );
    setState((s) => {
      const files = { ...s.files };
      let changed = false;
      for (const { key, name } of renamed) {
        const rootId = androidDeviceRootId(key);
        const node = files[rootId];
        if (node && node.name !== name) {
          files[rootId] = { ...node, name };
          changed = true;
        }
      }
      return changed ? { ...s, files } : s;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conns.map((c) => `${c.key}:${c.serverName || ''}`).join('|')]);

  // 根目录加载（指数退避重试 + 定时自动重连）统一在 loadDeviceRoots 中实现，
  // 定义见下方（需依赖 applyDeviceRoots / removeConnectionFromSettings 等）。

  const setDeviceLoading = useCallback(
    (key: string, loading: boolean) => {
      setAndroidDevices((prev) =>
        prev.map((d) => (d.key === key ? { ...d, loading } : d))
      );
      // 同步到设备根节点：桌面端用文件界面浏览设备根时，空态会据此显示刷新指示
      const rootId = androidDeviceRootId(key);
      setState((s) => {
        const node = s.files[rootId];
        if (!node || node.isRefreshing === loading) return s;
        return { ...s, files: { ...s.files, [rootId]: { ...node, isRefreshing: loading } } };
      });
    },
    [setState]
  );

  const setDeviceConnected = useCallback((key: string, connected: boolean) => {
    setAndroidDevices((prev) =>
      prev.map((d) => (d.key === key ? { ...d, connected } : d))
    );
  }, []);

  const setDeviceError = useCallback((key: string, lastError: string) => {
    setAndroidDevices((prev) =>
      prev.map((d) => (d.key === key ? { ...d, lastError } : d))
    );
  }, []);

  /**
   * 确保某台设备的根节点存在（children 可能仍为空，等待根目录加载完成）。
   * 桌面端以常规文件界面浏览该设备时，activeTab.folderId 就是这个节点。
   */
  const ensureDeviceRoot = useCallback(
    (key: string, name?: string) => {
      const deviceRootId = androidDeviceRootId(key);
      setState((s) => {
        if (s.files[deviceRootId]) return s;
        return {
          ...s,
          files: {
            ...s.files,
            [deviceRootId]: {
              id: deviceRootId,
              parentId: null,
              name: name || t('sidebar.network.androidDevice') || '安卓设备',
              type: FileType.FOLDER,
              path: `android://${key}/__device_root__`,
              remotePath: '__device_root__',
              remoteDeviceKey: key,
              source: 'android',
              children: [],
              tags: [],
            },
          },
        };
      });
    },
    [setState, t]
  );

  const applyDeviceRoots = useCallback(
    (key: string, folders: FileNode[], images: FileNode[], deviceName?: string) => {
      const deviceRootId = androidDeviceRootId(key);
      const newFiles: Record<string, FileNode> = {};
      const rootIds: string[] = [];

      for (const f of folders) {
        // 顶层文件夹挂在设备根节点下，便于文件界面"向上一级"回到设备根
        newFiles[f.id] = { ...f, parentId: deviceRootId };
        rootIds.push(f.id);
      }

      const virtualRootId = `${ANDROID_ROOT_IMAGES_ID}:${key}`;
      if (images.length > 0) {
        for (const img of images) {
          newFiles[img.id] = { ...img, parentId: virtualRootId };
        }
        newFiles[virtualRootId] = {
          id: virtualRootId,
          parentId: deviceRootId,
          name: '根目录图片',
          type: FileType.FOLDER,
          path: `android://${key}/__root_images__`,
          remotePath: '__root_images__',
          remoteDeviceKey: key,
          source: 'android',
          children: images.map((img) => img.id),
          tags: [],
          coverImagePath: images[0]?.path,
          coverImagePaths: images.slice(0, 3).map((img) => img.path),
          imageCount: images.length,
        };
        rootIds.push(virtualRootId);
      }

      // 设备根节点：子节点 = 该设备的顶层文件夹，桌面端直接用 FileGrid 渲染
      newFiles[deviceRootId] = {
        id: deviceRootId,
        parentId: null,
        name: deviceName || t('sidebar.network.androidDevice') || '安卓设备',
        type: FileType.FOLDER,
        path: `android://${key}/__device_root__`,
        remotePath: '__device_root__',
        remoteDeviceKey: key,
        source: 'android',
        children: rootIds,
        tags: [],
      };

      setState((s) => {
        const prevRoot = s.files[deviceRootId];
        return {
          ...s,
          files: {
            ...s.files,
            ...newFiles,
            [deviceRootId]: {
              ...newFiles[deviceRootId],
              name: deviceName || prevRoot?.name || newFiles[deviceRootId].name,
              // 重连期间保持根节点上的刷新态，文件区空态才会显示刷新指示
              isRefreshing: prevRoot?.isRefreshing ?? false,
            },
          },
        };
      });
      setAndroidDevices((prev) =>
        prev.map((d) => (d.key === key ? { ...d, roots: rootIds } : d))
      );
    },
    [setState, t]
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

  /**
   * 单台设备的根目录加载（指数退避重试），返回是否成功。
   * 成功即视为该设备已连通（侧边栏转绿）；失败仅记录错误，由自动重连定时器
   * 或用户点击再次尝试（手机端可能尚未开启共享/首次扫描超时）。
   * 例外：本次会话从未连通且连续失败达上限 → 判定为失效的遗留记录并移除。
   */
  const runDeviceRootsLoad = useCallback(
    async (
      c: AndroidClientConnection,
      // 重试退避序列；传空数组表示只尝试一次（自动重连/手动重连，避免长时间占用）
      backoff: number[] = [2000, 4000, 8000, 12000, 20000]
    ): Promise<boolean> => {
      if (!c.accessToken || !c.host || !c.port) return false;
      const client = androidClientRegistry.register(
        c.key,
        `http://${c.host}:${c.port}`,
        c.accessToken
      );
      setDeviceLoading(c.key, true);

      const loadRoots = async (attempt: number): Promise<boolean> => {
        try {
          const { folders, rootImages } = await client.getAllImageFolders();
          const device = androidDevicesRef.current.find((d) => d.key === c.key);
          const wasConnected = device?.connected ?? false;
          applyDeviceRoots(c.key, folders, rootImages, device?.name);
          setDeviceConnected(c.key, true);
          setDeviceError(c.key, '');
          staleAttemptsRef.current.delete(c.key);
          everConnectedRef.current.add(c.key);
          // 由断线恢复为连通：远程 URL 里的 token 已更换，失效缓存并让
          // 已渲染的缩略图/封面重新解析，避免重连后仍是裂图。
          if (!wasConnected) notifyRemoteChange();
          return true;
        } catch (err) {
          const msg = (err as Error).message || '';
          if (
            msg.includes('Authentication failed') ||
            msg.includes('token expired') ||
            msg.includes('HTTP 401')
          ) {
            // token 失效：清除该设备连接
            console.warn(`[AndroidClient] device ${c.key} token invalid, removing`);
            staleAttemptsRef.current.delete(c.key);
            client.disconnect();
            removeConnectionFromSettings(c.key);
            return false;
          }

          const failures = (staleAttemptsRef.current.get(c.key) || 0) + 1;
          staleAttemptsRef.current.set(c.key, failures);

          // 失效连接清理：本次会话中从未连通过的设备（基本都是上次运行遗留的
          // 连接记录——对端 App 重启后服务端不会自动恢复）在连续失败达上限后
          // 直接移除，侧边栏回到"移动设备"占位、设置面板"已连接设备"同步清空，
          // 不再长期残留一个反复重连却永远连不上的灰节点。
          if (!everConnectedRef.current.has(c.key) && failures >= MAX_STALE_ATTEMPTS) {
            console.warn(
              `[AndroidClient] device ${c.key} unreachable after ${failures} attempts, dropping stale connection`
            );
            staleAttemptsRef.current.delete(c.key);
            androidClientRegistry.unregister(c.key);
            cleanupDeviceFiles(c.key);
            removeConnectionFromSettings(c.key);
            return false;
          }

          if (attempt < backoff.length) {
            await new Promise((r) => setTimeout(r, backoff[attempt]));
            return loadRoots(attempt + 1);
          }
          console.error(`[AndroidClient] device ${c.key} failed to load roots:`, err);
          setDeviceConnected(c.key, false);
          setDeviceError(c.key, msg);
          return false;
        }
      };

      try {
        return await loadRoots(0);
      } finally {
        setDeviceLoading(c.key, false);
      }
    },
    [
      applyDeviceRoots,
      cleanupDeviceFiles,
      removeConnectionFromSettings,
      setDeviceConnected,
      setDeviceError,
      setDeviceLoading,
    ]
  );

  /**
   * 对外的加载入口：同一设备已有加载在进行时**复用其 Promise**，
   * 而不是立刻返回 false——否则点击"加载中"的设备会被误判为连接失败。
   */
  const loadDeviceRoots = useCallback(
    async (
      c: AndroidClientConnection,
      backoff?: number[]
    ): Promise<boolean> => {
      const pending = pendingLoadsRef.current.get(c.key);
      if (pending) return pending;

      const task = backoff ? runDeviceRootsLoad(c, backoff) : runDeviceRootsLoad(c);
      pendingLoadsRef.current.set(c.key, task);
      try {
        return await task;
      } finally {
        pendingLoadsRef.current.delete(c.key);
      }
    },
    [runDeviceRootsLoad]
  );

  // 连接配置变化时，为本会话主动建立的设备触发一次根目录加载
  // （从磁盘恢复的记录不在此列，已在上方被清理）
  useEffect(() => {
    for (const c of conns) {
      if (!sessionEstablishedRef.current.has(c.key)) continue;
      if (!c.accessToken || !c.host || !c.port) continue;
      void loadDeviceRoots(c);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connKeys]);

  // 自动重连：未连通的设备每 15s 重试一次。
  // 覆盖"手机端共享尚未开启/服务刚启动/首次全量扫描超时/息屏后恢复"等场景，
  // 手机端恢复共享后侧边栏节点会自动转绿，无需重新扫码或重启桌面端。
  useEffect(() => {
    if (conns.length === 0) return;
    let cancelled = false;
    const retry = async () => {
      for (const c of conns) {
        if (cancelled) return;
        // 仅重连本次会话主动建立的连接
        if (!sessionEstablishedRef.current.has(c.key)) continue;
        if (!c.accessToken || !c.host || !c.port) continue;
        const dev = androidDevicesRef.current.find((d) => d.key === c.key);
        if (!dev || dev.connected || dev.loading) continue;
        // 单次尝试：定时器每 15s 会再次触发，无需在此长时间退避
        await loadDeviceRoots(c, []);
      }
    };
    const timer = setTimeout(retry, 15000);
    const interval = setInterval(retry, 15000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connKeys]);

  /** 手动重连指定设备（侧边栏点击未连通节点时调用）。 */
  const reconnectDevice = useCallback(
    async (key: string): Promise<boolean> => {
      const c = conns.find((cc) => cc.key === key);
      if (!c) return false;
      // 手动重连只尝试一次，失败立即反馈（有自动重连定时器兜底后续恢复）
      return loadDeviceRoots(c, []);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [connKeys]
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
    async (folderId: string, options?: { resetScroll?: boolean; scrollToItemId?: string }) => {
      const folder = state.files[folderId];
      if (!folder || folder.source !== 'android' || !folder.remotePath) return;
      const key = folder.remoteDeviceKey || '';
      const enter = (resetScroll: boolean) =>
        enterFolder(folderId, { resetScroll, scrollToItemId: options?.scrollToItemId });

      // 设备根节点 / 根目录图片虚拟文件夹：子节点已在本地，无需请求设备即可进入
      // （设备掉线时仍可进入，避免点击没反应）
      if (
        folder.id.startsWith(ANDROID_DEVICE_ROOT_PREFIX) ||
        folder.id.startsWith(`${ANDROID_ROOT_IMAGES_ID}:`)
      ) {
        enter(true);
        return;
      }

      if (folder.children && folder.children.length > 0) {
        enter(options?.resetScroll ?? true);
        return;
      }

      // 需要向设备请求目录内容
      const client = androidClientRegistry.get(key);
      if (!client) return;

      setState((s) => ({
        ...s,
        files: {
          ...s.files,
          [folderId]: { ...s.files[folderId], children: [], isRefreshing: true },
        },
      }));
      enter(true);
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
        const device = androidDevicesRef.current.find((d) => d.key === key);
        applyDeviceRoots(key, folders, rootImages, device?.name);
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
    // 设备根节点：重新拉取整台设备的顶层文件夹
    if (folder.id.startsWith(ANDROID_DEVICE_ROOT_PREFIX)) {
      await handleAndroidRefresh(key);
      return;
    }
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
  }, [state.files, activeTab.folderId, setState, setDeviceLoading, handleAndroidRefresh]);

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

  /**
   * 标记某台设备为"本次会话主动建立"：扫码/手动连接成功后调用。
   * 未标记的连接记录会在下一次 connKeys 变化时被视为磁盘残留直接清理，
   * 不加载、不重连、不显示。
   */
  const markDeviceEstablished = useCallback((key: string) => {
    sessionEstablishedRef.current.add(key);
  }, []);

  // 对外只暴露本会话主动建立的设备：从磁盘恢复的记录即使尚未被清理 effect
  // 移除（useEffect 在绘制后执行），也不会在侧边栏/面板上闪现。
  const visibleDevices = useMemo(
    () => androidDevices.filter((d) => sessionEstablishedRef.current.has(d.key)),
    [androidDevices]
  );

  const androidConnectedCount = visibleDevices.filter((d) => d.connected).length;

  return {
    androidDevices: visibleDevices,
    androidConnectedCount,
    getDeviceRoots: (key: string): string[] =>
      visibleDevices.find((d) => d.key === key)?.roots || [],
    getDeviceState: (key: string): AndroidDeviceInfo | undefined =>
      visibleDevices.find((d) => d.key === key),
    handleNavigateAndroidFolder,
    handleAndroidRefresh,
    reloadCurrentAndroidFolder,
    handleAndroidDisconnect,
    handleOpenAndroidSettings,
    reconnectDevice,
    markDeviceEstablished,
  };
};
