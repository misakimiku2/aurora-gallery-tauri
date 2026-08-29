import { useCallback, useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { lanClientApi } from '../components/lan-client/lanClientApi';
import {
  isAndroidPlatformCached,
  lanShareAndroidStop,
  lanShareAndroidGetStatus,
} from '../api/tauri-bridge';
import { lanNavStart, lanNavStep } from '../utils/lanNavTrace';
import { notifyRemoteChange } from '../utils/remoteSource';
import { LAN_ROOT_IMAGES_ID } from '../constants';
import { AppState, FileNode, FileType, TabState } from '../types';

interface UseLanClientSyncParams {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  t: (key: string) => string;
  showToast: (msg: string) => void;
  enterFolder: (folderId: string, options?: { scrollToItemId?: string, resetScroll?: boolean }) => void;
}

/**
 * LAN 客户端同步：连接恢复、根目录加载（含指数退避重试）、周期性重试、心跳、
 * 文件夹浏览、刷新、上传等全部 LAN 客户端逻辑。
 */
export const useLanClientSync = ({
  state,
  setState,
  activeTab,
  t,
  showToast,
  enterFolder,
}: UseLanClientSyncParams) => {
  const [lanRoots, setLanRoots] = useState<string[]>([]);
  const [lanLoading, setLanLoading] = useState(false);
  const [lanConnected, setLanConnected] = useState(false);
  const [lanAllowUpload, setLanAllowUpload] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const lanUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [lanDownloadProgress, setLanDownloadProgress] = useState<{ active: boolean; completed: number; total: number }>({ active: false, completed: 0, total: 0 });

  // LAN client: restore connection on mount + load roots when connected
  // 关键：token 变化（首次连接/断开后重连/重启恢复）时总是重新加载 lanRoots，
  // 不依赖 lanRoots 是否为空——否则断开时残留的旧 lanRoots 会阻止重连后刷新。
  const lanLoadingRef = useRef(false);
  const lanTokenRef = useRef<string | undefined>(undefined);
  // 记录 lanLoadingRef 置 true 的时间戳，供周期性重试检测卡死
  const lanLoadingSinceRef = useRef<number>(0);
  useEffect(() => {
    const ls = state.settings.lanShare;
    lanTokenRef.current = ls.serverAccessToken;
    console.log('[LAN useEffect] host/port:', ls.serverHost, ls.serverPort);
    if (ls.serverAccessToken && ls.serverHost && ls.serverPort) {
      // 卡死保护：如果 lanLoadingRef 被某个挂起的 fetch 卡住超过 25s，强制重置
      if (lanLoadingRef.current) {
        const stuckMs = Date.now() - lanLoadingSinceRef.current;
        if (stuckMs < 25000) {
          console.log(`[LAN useEffect] load already in progress (${Math.round(stuckMs / 1000)}s), skipping`);
          return;
        }
        console.warn(`[LAN useEffect] lanLoadingRef stuck for ${Math.round(stuckMs / 1000)}s, force resetting`);
        lanLoadingRef.current = false;
      }
      lanLoadingRef.current = true;
      lanLoadingSinceRef.current = Date.now();
      setLanLoading(true);
      setLanConnected(false);

      lanClientApi.setBaseUrl(`http://${ls.serverHost}:${ls.serverPort}`);
      lanClientApi.setToken(ls.serverAccessToken);

      // 指数退避重试：2s, 4s, 8s, 12s, 20s（共 ~46s），应对安卓启动时网络未就绪
      const backoff = [2000, 4000, 8000, 12000, 20000];
      const loadRoots = async (attempt: number): Promise<void> => {
        // 如果 token 已被其他流程清除，停止重试
        if (lanTokenRef.current !== ls.serverAccessToken) return;
        console.log(`[LAN loadRoots] attempt ${attempt + 1}/${backoff.length + 1}, baseUrl=${lanClientApi.getBaseUrl()}`);
        try {
          const { folders, rootImages, allowUpload } = await lanClientApi.getAllImageFolders();
          applyLanRoots(folders, rootImages, allowUpload);
          setLanConnected(true);
          // 重连后 token 可能已更换：失效缓存的远程 URL 并让缩略图重新解析
          notifyRemoteChange();
          console.log(`[LAN loadRoots] success: ${folders.length} folders, ${rootImages.length} root images`);
        } catch (err) {
          const msg = (err as Error).message || '';
          // token 过期/失效：清除连接状态，让用户重新连接
          if (msg.includes('Authentication failed') || msg.includes('token expired') || msg.includes('HTTP 401')) {
            console.warn('[LAN] Token expired/invalid, clearing connection');
            lanClientApi.disconnect();
            setState(s => ({
              ...s,
              settings: {
                ...s.settings,
                lanShare: { ...s.settings.lanShare, serverAccessToken: undefined },
              },
            }));
            return;
          }
          // 网络错误：指数退避重试
          if (attempt < backoff.length) {
            console.warn(`[LAN] Load roots failed (attempt ${attempt + 1}/${backoff.length + 1}), retrying in ${backoff[attempt]}ms:`, msg);
            await new Promise(r => setTimeout(r, backoff[attempt]));
            return loadRoots(attempt + 1);
          }
          console.error('[LAN] Failed to load roots after all retries:', err);
          setLanConnected(false);
        }
      };

      loadRoots(0).finally(() => {
        lanLoadingRef.current = false;
        setLanLoading(false);
      });
    } else {
      // token 被清除（断开连接/过期）时清空 lanRoots，确保下次重连能重新加载
      setLanRoots([]);
      setLanConnected(false);
    }
  }, [state.settings.lanShare.serverAccessToken, state.settings.lanShare.serverHost, state.settings.lanShare.serverPort]);

  // 周期性重试：token 存在但未连接成功时，每 15 秒重试一次（应对安卓启动时网络未就绪）
  useEffect(() => {
    const ls = state.settings.lanShare;
    if (!ls.serverAccessToken || !ls.serverHost || !ls.serverPort) return;
    if (lanConnected) return;

    const interval = setInterval(() => {
      const currentLs = state.settings.lanShare;
      if (!currentLs.serverAccessToken || lanConnected) return;
      // 卡死保护：lanLoadingRef 超过 25s 仍未释放，说明上一次 fetch 可能挂起
      // （虽有 fetchWithTimeout 兜底，这里作为第二道防线），强制重置后继续重试
      if (lanLoadingRef.current) {
        const stuckMs = Date.now() - lanLoadingSinceRef.current;
        if (stuckMs < 25000) return;
        console.warn(`[LAN] Periodic retry: lanLoadingRef stuck for ${Math.round(stuckMs / 1000)}s, force resetting`);
        lanLoadingRef.current = false;
      }
      console.log('[LAN] Periodic retry: attempting to load roots...');
      lanLoadingRef.current = true;
      lanLoadingSinceRef.current = Date.now();
      setLanLoading(true);
      lanClientApi.setBaseUrl(`http://${currentLs.serverHost}:${currentLs.serverPort}`);
      lanClientApi.setToken(currentLs.serverAccessToken);
      lanClientApi.getAllImageFolders()
        .then(({ folders, rootImages, allowUpload }) => {
          applyLanRoots(folders, rootImages, allowUpload);
          setLanConnected(true);
          notifyRemoteChange();
          console.log(`[LAN] Periodic retry: roots loaded (${folders.length} folders, ${rootImages.length} root images)`);
        })
        .catch((err) => {
          const msg = (err as Error).message || '';
          if (msg.includes('Authentication failed') || msg.includes('token expired') || msg.includes('HTTP 401')) {
            console.warn('[LAN] Periodic retry: token invalid, clearing');
            lanClientApi.disconnect();
            setState(s => ({
              ...s,
              settings: {
                ...s.settings,
                lanShare: { ...s.settings.lanShare, serverAccessToken: undefined },
              },
            }));
          } else {
            console.warn('[LAN] Periodic retry failed:', msg);
          }
        })
        .finally(() => {
          lanLoadingRef.current = false;
          setLanLoading(false);
        });
    }, 15000);

    return () => clearInterval(interval);
  }, [state.settings.lanShare.serverAccessToken, state.settings.lanShare.serverHost, state.settings.lanShare.serverPort, lanConnected]);

  // 心跳：连接成功后每 5s 发送一次，保持服务端设备列表中本设备"在线"。
  // 双向连接融合：与桌面端清理手机设备（连续 3 次失败）的逻辑对称——
  // 401（被桌面端踢出）立即清理；连续 3 次失败（约 15s，桌面端服务已停止）
  // 自动清理本机连接状态并提示，避免 UI 永远停留在"已连接"。
  const heartbeatFailuresRef = useRef(0);

  // 本机服务端在本会话中是否曾处于运行状态：
  // 用于区分"用户通过通知栏停止了共享"（曾运行 → 已停止 → 需断开整条链路）
  // 与"App 重启后服务端未自动恢复"（从未运行 → 保持现状，见文档已知限制）。
  const ownServerWasRunningRef = useRef(false);

  // 彻底断开与桌面端的连接并停止本机共享服务端（双向融合：
  // 本机共享与桌面端连接是一个整体，任何一侧断开都整条链路断开）。
  const clearConnection = useCallback(() => {
    heartbeatFailuresRef.current = 0;
    // 同步清除 token 引用，避免状态事件监听器重复触发清理
    lanTokenRef.current = undefined;
    lanClientApi.disconnect();
    if (isAndroidPlatformCached()) {
      lanShareAndroidStop().catch(() => {});
    }
    setState((s) => ({
      ...s,
      settings: {
        ...s.settings,
        lanShare: { ...s.settings.lanShare, serverAccessToken: undefined },
      },
    }));
    showToast((t('settings.lanShare.client.connectionLost') || '与桌面端的连接已断开'));
  }, [setState, showToast, t]);

  useEffect(() => {
    if (!lanConnected) {
      heartbeatFailuresRef.current = 0;
      return;
    }
    const sendHeartbeat = () => {
      lanClientApi
        .heartbeat()
        .then(() => {
          heartbeatFailuresRef.current = 0;
        })
        .catch((err) => {
          const msg = (err as Error).message || '';
          const isAuthFailure =
            msg.includes('Authentication failed') ||
            msg.includes('token expired') ||
            msg.includes('HTTP 401');
          heartbeatFailuresRef.current += 1;
          console.warn(
            `[LAN] Heartbeat failed (${heartbeatFailuresRef.current}/3):`,
            msg
          );
          if (isAuthFailure || heartbeatFailuresRef.current >= 3) {
            clearConnection();
          }
        });
      // 融合兜底校验：通知栏"停止共享"时 App 通常处于后台，状态事件可能
      // 到不了被挂起的 WebView——待 App 回到前台后由心跳周期检测"本机服务端
      // 曾运行、现已停止"并彻底断开整条链路，不再停留在"等待桌面端连接"的
      // 中间态（与 App 重启后服务端未恢复的情形区分开）。
      if (isAndroidPlatformCached()) {
        lanShareAndroidGetStatus()
          .then((status) => {
            if (status.is_running) {
              ownServerWasRunningRef.current = true;
              return;
            }
            if (ownServerWasRunningRef.current && lanTokenRef.current) {
              clearConnection();
            }
          })
          .catch(() => {});
      }
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 5000);
    return () => clearInterval(interval);
  }, [lanConnected, clearConnection]);

  // 通知栏"停止共享"（或任何路径停止本机服务端）时，同步清理与桌面端的连接：
  // 双向融合下本机共享与桌面端连接是一个整体，服务端停止即彻底断开。
  // 注意：注册时不拦截 isAndroidPlatformCached()——App 异步初始化完成前该缓存
  // 仍为 false，会导致监听器漏注册；事件只在安卓端产生，桌面端注册无害。
  useEffect(() => {
    let disposed = false;
    let unlistenFn: (() => void) | undefined;
    listen('lan-share-android-status-changed', () => {
      if (disposed || !isAndroidPlatformCached()) return;
      lanShareAndroidGetStatus()
        .then((status) => {
          if (disposed) return;
          ownServerWasRunningRef.current =
            ownServerWasRunningRef.current || status.is_running;
          if (status.is_running) return;
          if (lanTokenRef.current) {
            clearConnection();
          }
        })
        .catch(() => {});
    })
      .then((un) => {
        unlistenFn = un;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlistenFn?.();
    };
  }, [clearConnection]);

  // 统一处理 LAN 根目录加载结果：文件夹 + 散落图片（聚合成虚拟文件夹）
  const applyLanRoots = useCallback((folders: FileNode[], images: FileNode[], allowUpload: boolean) => {
    const newFiles: Record<string, FileNode> = {};
    const rootIds: string[] = [];

    for (const f of folders) {
      newFiles[f.id] = f;
      rootIds.push(f.id);
    }

    // 根目录下的散落图片：聚合成虚拟文件夹，使总览视图卡片网格也能展示
    if (images.length > 0) {
      for (const img of images) {
        newFiles[img.id] = { ...img, parentId: LAN_ROOT_IMAGES_ID };
      }
      newFiles[LAN_ROOT_IMAGES_ID] = {
        id: LAN_ROOT_IMAGES_ID,
        parentId: null,
        name: '根目录图片',
        type: FileType.FOLDER,
        path: 'lan://__root_images__',
        remotePath: '__root_images__',
        source: 'lan',
        children: images.map(img => img.id),
        tags: [],
        coverImagePath: images[0]?.path,
        coverImagePaths: images.slice(0, 3).map(img => img.path),
        imageCount: images.length,
      };
      rootIds.push(LAN_ROOT_IMAGES_ID);
    }

    setState(s => ({ ...s, files: { ...s.files, ...newFiles } }));
    setLanRoots(rootIds);
    setLanAllowUpload(allowUpload);
  }, [setState]);

  const handleNavigateNetworkFolder = useCallback(async (folderId: string) => {
    const folder = state.files[folderId];
    if (!folder || folder.source !== 'lan' || !folder.remotePath) return;

    if (folder.children && folder.children.length > 0) {
      lanNavStart(folder.name);
      lanNavStep('CACHE HIT (folder already loaded)');
      enterFolder(folderId, { resetScroll: true });
      return;
    }

    // 未缓存的 LAN 文件夹：立即切换视图（显示加载状态），而非等待网络请求完成。
    // 这样用户点击后立刻进入文件夹，避免"点击后没反应"的延迟感。
    lanNavStart(folder.name);
    setState(s => ({
      ...s,
      files: {
        ...s.files,
        [folderId]: { ...s.files[folderId], children: [], isRefreshing: true },
      },
    }));
    enterFolder(folderId, { resetScroll: true });
    setLanLoading(true);

    try {
      lanNavStep('FETCH START');
      const __fetchStart = performance.now();
      const { folders, images, allowUpload } = await lanClientApi.browseToFolderNodes(folder.remotePath);
      const __fetchEnd = performance.now();
      lanNavStep('FETCH END', `(${(__fetchEnd - __fetchStart).toFixed(0)}ms, folders=${folders.length} images=${images.length})`);
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
      setState(s => ({
        ...s,
        files: {
          ...s.files,
          ...newFiles,
          [folderId]: { ...s.files[folderId], children: childIds, isRefreshing: false },
        },
      }));
      lanNavStep('setFiles()', `children=${childIds.length}`);
      setLanAllowUpload(allowUpload);
    } catch (err) {
      console.error('[LAN] Failed to load folder:', err);
      setState(s => ({
        ...s,
        files: {
          ...s.files,
          [folderId]: { ...s.files[folderId], isRefreshing: false },
        },
      }));
    } finally {
      setLanLoading(false);
      lanNavStep('Loading hidden (lanLoading=false)');
    }
  }, [state.files, enterFolder, setState]);

  const handleOpenLanSettings = useCallback(() => {
    setState(s => ({ ...s, isSettingsOpen: true, settingsCategory: 'lanShare' }));
  }, [setState]);

  // 网络总览视图下拉刷新：重新拉取桌面端根目录文件夹
  const handleLanRefresh = useCallback(async () => {
    if (!lanConnected) return;
    setLanLoading(true);
    try {
      const { folders, rootImages, allowUpload } = await lanClientApi.getAllImageFolders();
      applyLanRoots(folders, rootImages, allowUpload);
    } catch (err) {
      console.error('[LAN] Refresh failed:', err);
    } finally {
      setLanLoading(false);
    }
  }, [lanConnected, setState, applyLanRoots]);

  const reloadCurrentLanFolder = useCallback(async () => {
    const folder = state.files[activeTab.folderId];
    if (!folder || folder.source !== 'lan' || !folder.remotePath) return;
    // 虚拟文件夹内容来自根目录加载，不单独 browse
    if (folder.id === LAN_ROOT_IMAGES_ID) return;
    setLanLoading(true);
    try {
      const { folders, images, allowUpload } = await lanClientApi.browseToFolderNodes(folder.remotePath);
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
      setState(s => ({
        ...s,
        files: { ...s.files, ...newFiles, [folder.id]: { ...s.files[folder.id], children: childIds } },
      }));
      setLanAllowUpload(allowUpload);
    } catch (err) {
      console.error('[LAN] Failed to refresh folder:', err);
    } finally {
      setLanLoading(false);
    }
  }, [state.files, activeTab.folderId, setState]);

  const handleUploadToLan = useCallback(() => {
    lanUploadInputRef.current?.click();
  }, []);

  const handleUploadFilesSelected = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const fileList = e.target.files;
    if (!fileList || fileList.length === 0) return;
    const folder = state.files[activeTab.folderId];
    if (!folder || folder.source !== 'lan' || !folder.remotePath) return;
    const targetDir = folder.remotePath;
    const files = Array.from(fileList);
    setIsUploading(true);
    let success = 0;
    const total = files.length;
    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        try {
          const res = await lanClientApi.uploadFile(file, targetDir, file.name);
          if (res.success) {
            success++;
          } else {
            console.error('[LAN] Upload failed:', res.error);
            showToast((res.error || (t('lanClient.uploadFailed') || '上传失败')));
          }
        } catch (err) {
          console.error('[LAN] Upload error:', err);
          showToast((err as Error).message || (t('lanClient.uploadFailed') || '上传失败'));
        }
        const uploadingMsg = t('lanClient.uploading') || '正在上传 {x}/{n}';
        showToast(uploadingMsg.replace('{x}', String(i + 1)).replace('{n}', String(total)));
      }
      if (success === total) {
        showToast((t('lanClient.uploadDone') || `上传完成 ${success}/${total}`).replace('{x}', String(success)).replace('{n}', String(total)));
      } else {
        showToast((t('lanClient.uploadPartial') || `上传完成 ${success}/${total}`).replace('{x}', String(success)).replace('{n}', String(total)));
      }
      await reloadCurrentLanFolder();
    } finally {
      e.target.value = '';
      setIsUploading(false);
    }
  }, [state.files, activeTab.folderId, showToast, t, reloadCurrentLanFolder]);

  return {
    lanRoots,
    lanLoading,
    lanConnected,
    lanAllowUpload,
    isUploading,
    lanUploadInputRef,
    lanDownloadProgress,
    setLanDownloadProgress,
    applyLanRoots,
    handleNavigateNetworkFolder,
    handleOpenLanSettings,
    handleLanRefresh,
    reloadCurrentLanFolder,
    handleUploadToLan,
    handleUploadFilesSelected,
  };
};
