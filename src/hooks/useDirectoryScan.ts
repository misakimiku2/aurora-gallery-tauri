import { listen } from '@tauri-apps/api/event';
import { AppState, FileNode, FileType, TabState, SearchScope } from '../types';
import { DUMMY_TAB } from '../constants';
import { isTauriEnvironment } from '../utils/environment';
import { normalizePath, generateId } from '../utils/pathUtils';
import { reloadPeople, reloadTopics } from '../utils/peopleTopics';
import { performanceMonitor } from '../utils/performanceMonitor';
import { getGlobalCache } from '../utils/thumbnailCache';
import { pushRootHistory } from '../utils/rootHistory';
import { getSourceUrls, normalizeSourceUrls, toSourceUrlFields } from '../utils/sourceUrls';
import {
  scanDirectory,
  openDirectory,
  saveUserData as tauriSaveUserData,
  ensureDirectory,
  switchRootDatabase,
  shutdownColorExtraction,
  addPendingFilesToDb,
  dbGetAllFileMetadata,
} from '../api/tauri-bridge';

interface UseDirectoryScanProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  t: (key: string) => string;
  showToast: (msg: string) => void;
  startTask: (type: string, fileIds: string[], label: string, autoProgress: boolean) => string;
  updateTask: (taskId: string, update: Partial<import('../types').TaskProgress>) => void;
}

const saveUserData = async (data: any) => {
  if (!isTauriEnvironment()) return false;
  try {
    const result = await tauriSaveUserData(data);
    return result;
  } catch (error) {
    console.error('Failed to save user data via Tauri:', error);
    return false;
  }
};

export const useDirectoryScan = ({
  state,
  setState,
  activeTab,
  t,
  showToast,
  startTask,
  updateTask,
}: UseDirectoryScanProps) => {

  // 切换资源根目录后重置与目录相关的性能统计（文件扫描、缩略图加载等），
  // 使性能面板反映新目录的数据，而不是旧目录的累积统计
  const resetDirectoryPerformanceStats = () => {
    performanceMonitor.clearMetricsByNames([
      'scanDirectory',
      'filesScanned',
      'getThumbnail',
      'thumbnailCacheHit',
      'thumbnailCacheMiss',
    ]);
    // 清空缩略图内存缓存，避免新目录复用旧目录的缩略图
    getGlobalCache().clear();
  };

  const scanAndMerge = async (path: string, force: boolean = false) => {
    const scanTimer = performanceMonitor.start('scanDirectory', undefined, true);
    try {
      const result = await scanDirectory(path, force);

      // 只统计图片节点（不含文件夹），使"扫描文件数"反映真实图片数量
      const imageCount = Object.values(result.files || {}).filter(f => f.type === FileType.IMAGE).length;

      performanceMonitor.end(scanTimer, 'scanDirectory', {
        path,
        fileCount: imageCount,
        rootCount: result.roots.length
      });

      performanceMonitor.increment('filesScanned', imageCount);

      const imagePaths: string[] = [];
      Object.values(result.files || {}).forEach(file => {
        if (file.type === FileType.IMAGE) {
          imagePaths.push(file.path);
        }
      });

      if (imagePaths.length > 0) {
        addPendingFilesToDb(imagePaths).catch(err => {
          console.error('Failed to add pending files to database:', err);
        });
      }

      setState(prev => {
        const newRoots = Array.from(new Set([...prev.roots, ...result.roots]));
        const newFiles = { ...prev.files, ...result.files };
        const updatedTabs = prev.tabs.map(t => t.id === prev.activeTabId ? { ...t, folderId: result.roots[0], history: { stack: [{ folderId: result.roots[0], viewingId: null, viewMode: 'browser' as const, searchQuery: '', searchScope: 'all' as SearchScope, activeTags: [], activePersonId: null }], currentIndex: 0 } } : t);
        return {
          ...prev,
          roots: newRoots,
          files: newFiles,
          expandedFolderIds: Array.from(new Set([...prev.expandedFolderIds, ...result.roots])),
          tabs: updatedTabs,
          settings: {
            ...prev.settings,
            paths: {
              ...prev.settings.paths,
              resourceRoot: path,
              // 同步缓存目录：统一放到资源根目录下的 .Aurora_Cache
              cacheRoot: `${path}${path.includes('\\') ? '\\' : '/'}.Aurora_Cache`
            }
          },
          isScanning: false
        };
      });
    } catch (err) {
      console.error("Failed to reload root: ", path, err);
      setState(prev => ({ ...prev, isScanning: false }));
    }
  };

  const handleOpenFolder = async () => {
    try {
      const path = await openDirectory();
      if (path) {
        await openKnownPath(path);
      }
    } catch (e) { console.error("Failed to open directory", e); }
  };

  /**
   * 与 `handleOpenFolder` 同一条链，但目录是**已知的**（不弹系统选择框），并且可 await
   * 到扫描结束。设计方案 §6.1 第 3 条：welcome 那颗「使用 PixCall 库」的语义是
   * 「接管 PixCall 库」= 读库根 → 复用这条链（switchRootDatabase + scanAndMerge）→
   * 扫完才自动 probe。第 1 步还没选目录时 `file_index` 是空的，没东西可匹配，
   * 必须先把扫描 await 住。
   */
  const openKnownPath = async (path: string) => {
    try {
        if (isTauriEnvironment()) {
          const cachePath = `${path}${path.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
          await ensureDirectory(cachePath);
          // 彻底停止当前主色调提取，切换后提取将服务于新目录
          await shutdownColorExtraction();
          await switchRootDatabase(path);
          // 重置文件扫描/缩略图加载等性能统计，使其反映新目录
          resetDirectoryPerformanceStats();
        }

        const skeletonId = generateId(path);
        const skeletonRoot: FileNode = {
          id: skeletonId,
          parentId: null,
          name: path.split(/[\\\/]/).pop() || path,
          type: FileType.FOLDER,
          path: normalizePath(path),
          children: [],
          tags: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        };

        setState(prev => {
          let updatedTabs = prev.tabs;
          if (prev.tabs.length === 0) {
            const defaultTab: TabState = {
              ...DUMMY_TAB,
              id: 'tab-default',
              folderId: skeletonId,
              history: { stack: [{ folderId: skeletonId, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }
            };
            updatedTabs = [defaultTab];
          } else {
            updatedTabs = prev.tabs.map(t => t.id === prev.activeTabId ? { ...t, folderId: skeletonId, history: { stack: [{ folderId: skeletonId, viewingId: null, viewMode: 'browser' as const, searchQuery: '', searchScope: 'all' as SearchScope, activeTags: [], activePersonId: null }], currentIndex: 0 } } : t);
          }

          return {
            ...prev,
            roots: [skeletonId, ...prev.roots.filter(r => r !== skeletonId)],
            files: { ...prev.files, [skeletonId]: skeletonRoot },
            expandedFolderIds: Array.from(new Set([...prev.expandedFolderIds, skeletonId])),
            tabs: updatedTabs,
            activeTabId: updatedTabs[0].id,
            settings: {
              ...prev.settings,
              paths: {
                ...prev.settings.paths,
                resourceRoot: path,
                // 同步缓存目录：统一放到资源根目录下的 .Aurora_Cache
                cacheRoot: `${path}${path.includes('\\') ? '\\' : '/'}.Aurora_Cache`,
                // 这条链同样是切根（welcome 的「使用 PixCall 库」走的就是它），一并记进历史
                rootHistory: pushRootHistory(prev.settings.paths.rootHistory, path)
              }
            },
            isScanning: true
          };
        });

      // 人物/专题表整体重读自公共函数（M6a 阶段 2 抽取，供事件回拉复用）
      try {
        await reloadPeople(setState);
      } catch (e) {
        console.error('Failed to reload people after switching root:', e);
      }

      try {
        await reloadTopics(setState);
      } catch (e) {
        console.error('Failed to reload topics after switching root:', e);
      }

      // 与改动前唯一的差别：这里 await 到扫描结束才 resolve。welcome 的「使用 PixCall 库」
      // 必须在扫描完成后才 probe（第 1 步还没选目录时 file_index 是空的，没东西可匹配，
      // 设计方案 §6.3 前置条件）。state 更新的次序没变。
      await scanAndMerge(path, true);
    } catch (e) { console.error("Failed to open directory", e); }
  };

  const handleRefresh = async (folderId?: string) => {
    const targetFolderId = folderId || activeTab.folderId;
    const folder = state.files[targetFolderId];

    if (folder?.path) {
      const path = folder.path;
      try {
        const result = await scanDirectory(path, true);

        if (isTauriEnvironment()) {
          const imagePaths = Object.values(result.files || {})
            .filter(f => f.type === FileType.IMAGE)
            .map(f => f.path);

          if (imagePaths.length > 0) {
            addPendingFilesToDb(imagePaths).catch(err => {
              console.error('Failed to add pending files on refresh:', err);
            });
          }
        }

        setState(prev => {
          const mergedFiles = { ...prev.files };

          const filesToRemove = new Set<string>();
          const traverseAndMark = (fileId: string) => {
            filesToRemove.add(fileId);
            const file = prev.files[fileId];
            if (file && file.children) {
              file.children.forEach(childId => traverseAndMark(childId));
            }
          };
          traverseAndMark(targetFolderId);

          filesToRemove.forEach(fileId => {
            delete mergedFiles[fileId];
          });

          Object.entries(result.files).forEach(([fileId, newFile]) => {
            const existingFile = prev.files[fileId];
            if (existingFile) {
              mergedFiles[fileId] = {
                ...newFile,
                tags: existingFile.tags,
                description: existingFile.description,
                url: existingFile.url,
                aiData: existingFile.aiData,
                ...toSourceUrlFields(getSourceUrls(existingFile)),
                author: existingFile.author,
                category: existingFile.category,
                meta: existingFile.meta || newFile.meta,
                children: newFile.children || existingFile.children,
                parentId: (fileId === targetFolderId) ? existingFile.parentId : newFile.parentId,
                isRefreshing: false
              };
            } else {
              mergedFiles[fileId] = { ...newFile, isRefreshing: false };
            }
          });

          return { ...prev, files: mergedFiles };
        });
      } catch (e) {
        console.error("Failed to refresh directory", e);
      }
    } else if (folder) {
      setState(prev => {
        const files = { ...prev.files };
        files[targetFolderId] = {
          ...folder,
          lastRefresh: Date.now()
        };

        return { ...prev, files };
      });
    }
  };

  /**
   * 全表重读 `file_metadata` 回写内存：**标签 + 描述 + 来源网址**，并重建词表。
   *
   * 凡是「绕过前端直接写库」的路径（PixCall 导入、LAN/安卓在线写入）之后都必须调一次，
   * 否则 `state.files` 还停在旧值上。2026-10-05 实测：PixCall 导入确实把第 3 条来源网址
   * 写进了库（sqlite 里能看到 3 条），但详情页仍只显示 2 条——就是缺这一步。
   *
   * 只覆盖「库里有值」的列：内存里那些库里没有的（`aiData` 之类）不动。
   */
  const handleRefreshMetadata = async () => {
    try {
      const allMetadata = await dbGetAllFileMetadata();

      setState(prev => {
        const newFiles = { ...prev.files };
        // 以现词表为底做并集：以前是空 Set 重建，会把「加了词但还没贴到任何文件上」的词冲掉
        const newCustomTags = new Set<string>(prev.customTags);

        allMetadata.forEach(meta => {
          const file = newFiles[meta.fileId];
          if (!file) return;

          const patch: Partial<FileNode> = {};
          if (meta.tags && meta.tags.length > 0) {
            patch.tags = meta.tags;
            meta.tags.forEach(tag => newCustomTags.add(tag));
          }
          if (meta.description) patch.description = meta.description;
          const urls = normalizeSourceUrls(meta.sourceUrls, meta.sourceUrl);
          if (urls) {
            patch.sourceUrls = urls;
            patch.sourceUrl = urls[0];
          }

          if (Object.keys(patch).length > 0) {
            newFiles[meta.fileId] = { ...file, ...patch };
          }
        });

        return {
          ...prev,
          files: newFiles,
          customTags: Array.from(newCustomTags)
        };
      });
    } catch (error) {
      console.error('Failed to refresh file metadata:', error);
    }
  };

  /** 旧名：语义已经是「刷新元数据」，调用点还没跟着改名，指向同一个实现。 */
  const handleRefreshTags = handleRefreshMetadata;

  const switchToRoot = async (selectedPath: string) => {
    try {
      if (!selectedPath) {
        return;
      }

      if (isTauriEnvironment()) {
        const cachePath = `${selectedPath}${selectedPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
        await ensureDirectory(cachePath);
        // 彻底停止当前主色调提取（旧目录的任务/弹窗一并终止），切换后提取将服务于新目录
        await shutdownColorExtraction();
        await switchRootDatabase(selectedPath);
        // 重置文件扫描/缩略图加载等性能统计，使其反映新目录
        resetDirectoryPerformanceStats();
      }

      // 切根即换库（S1）：旧库的标注/专题留在旧库那份 metadata.db 里。把这次的根记进
      // 历史，用户随时可以从「历史」弹窗切回去（设计方案 §5 X1 → P3）。
      const newSettings = {
        ...state.settings,
        paths: {
          ...state.settings.paths,
          resourceRoot: selectedPath,
          cacheRoot: '',
          rootHistory: pushRootHistory(state.settings.paths.rootHistory, selectedPath)
        }
      };

      setState(prev => ({
        ...prev,
        files: {},
        roots: [],
        tabs: [],
        settings: newSettings,
        settingsCategory: 'general',
        isSettingsOpen: false
      }));

      const taskId = startTask('ai', [], t('tasks.scanning'), false);
      updateTask(taskId, { total: 100, current: 0, currentStep: t('tasks.preparing') });

      let unlistenProgress: (() => void) | undefined;
      try {
        unlistenProgress = await listen('scan-progress', (event: any) => {
          const payload = event.payload as { processed: number; total: number };
          if (!payload) return;

          updateTask(taskId, {
            total: payload.total || 1000,
            current: payload.processed,
            currentStep: `${t('welcome.scanning')} ${payload.processed}`
          });
        });
      } catch (e) {
        console.warn('Failed to listen for scan-progress in handleChangePath', e);
      }

      try {
        const scanTimer = performanceMonitor.start('scanDirectory', undefined, true);
        const result = await scanDirectory(selectedPath);
        // 只统计图片节点（不含文件夹），使"扫描文件数"反映真实图片数量
        const imageCount = Object.values(result.files || {}).filter(f => f.type === FileType.IMAGE).length;
        performanceMonitor.end(scanTimer, 'scanDirectory', {
          path: selectedPath,
          fileCount: imageCount,
          rootCount: result.roots.length
        });
        performanceMonitor.increment('filesScanned', imageCount);

        if (unlistenProgress) unlistenProgress();

        try {
          // 人物/专题表整体重读自公共函数（M6a 阶段 2 抽取，供事件回拉复用）
          await reloadPeople(setState);
        } catch (e) {
          console.error('Failed to reload people after switching root:', e);
        }

        try {
          await reloadTopics(setState);
        } catch (e) {
          console.error('Failed to reload topics after switching root:', e);
        }

        const actualFileCount = Object.values(result.files || {}).filter(f => f.type === FileType.IMAGE).length;
        updateTask(taskId, { current: actualFileCount, total: actualFileCount, status: 'completed' });

        setTimeout(() => {
          setState(prev => ({
            ...prev,
            tasks: prev.tasks.filter(t => t.id !== taskId)
          }));
        }, 1000);

        setState(prev => {
          const newRoots = result.roots;
          const newFiles = result.files;
          const newRootId = newRoots.length > 0 ? newRoots[0] : '';

          if (!newRootId) return { ...prev, roots: newRoots, files: newFiles };

          const newTab: TabState = {
            ...DUMMY_TAB,
            id: Math.random().toString(36).substr(2, 9),
            folderId: newRootId,
            history: {
              stack: [{
                folderId: newRootId,
                viewingId: null,
                viewMode: 'browser',
                searchQuery: '',
                searchScope: 'all',
                activeTags: [],
                activePersonId: null
              }],
              currentIndex: 0
            }
          };
          return {
            ...prev,
            roots: newRoots,
            files: newFiles,
            expandedFolderIds: [newRootId],
            tabs: [newTab],
            activeTabId: newTab.id,
          };
        });

        const resultRootPaths = result.roots.map(id => result.files[id]?.path).filter(Boolean);
        const updatedRootPaths = resultRootPaths.length > 0 ? resultRootPaths : [selectedPath];

        const dataToSave = {
          rootPaths: updatedRootPaths,
          customTags: state.customTags,
          people: state.people,
          settings: newSettings,
          fileMetadata: {}
        };

        const saveResult = await saveUserData(dataToSave);

        if (!saveResult) {
          console.error('[HANDLE_CHANGE_PATH] saveUserData returned false!');
        }

        showToast(t('settings.success'));

        // 主色调提取为手动功能：切换根目录后保持暂停状态，由用户手动启动

      } catch (e) {
        if (unlistenProgress) unlistenProgress();
        updateTask(taskId, { status: 'completed' });
        setTimeout(() => {
          setState(prev => ({
            ...prev,
            tasks: prev.tasks.filter(t => t.id !== taskId)
          }));
        }, 3000);

        console.error("Change path failed", e);
        showToast("Error changing path: " + e);
      }
    } catch (e) {
      console.error("Change path failed", e);
      showToast("Error changing path");
    }
  };

  /** 弹系统目录选择框，选完交给 `switchToRoot`。 */
  const handleChangePath = async (type: 'resource' | 'cache') => {
    try {
      const selectedPath = await openDirectory();
      if (!selectedPath) {
        return;
      }
      await switchToRoot(selectedPath);
    } catch (e) {
      console.error("Change path failed", e);
      showToast("Error changing path");
    }
  };

  /**
   * 只弹系统目录选择框，**不切根**（§13 的切根确认弹窗需要先拿到目标路径再问用户）。
   * 拿到就返回路径，用户取消返回 null；调用方负责确认后走 `handleSwitchRoot`。
   */
  const pickRootDirectory = async (): Promise<string | null> => {
    try {
      return await openDirectory();
    } catch (e) {
      console.error("Failed to open directory", e);
      showToast("Error opening directory");
      return null;
    }
  };

  /**
   * 从「历史资源根」弹窗里选一个以前用过的根。语义与现选一个目录完全一致
   * （同一条切库链路），只是目录已知、不再弹系统选择框。
   */
  const handleSwitchRoot = async (path: string) => {
    await switchToRoot(path);
  };

  return {
    handleOpenFolder,
    openKnownPath,
    scanAndMerge,
    handleRefresh,
    handleRefreshMetadata,
    handleRefreshTags,
    handleChangePath,
    pickRootDirectory,
    handleSwitchRoot,
  };
};
