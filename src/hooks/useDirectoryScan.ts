import { listen } from '@tauri-apps/api/event';
import { AppState, FileNode, FileType, Person, Topic, TabState, SearchScope } from '../types';
import { DUMMY_TAB } from '../constants';
import { isTauriEnvironment } from '../utils/environment';
import { normalizePath, generateId } from '../utils/pathUtils';
import { performanceMonitor } from '../utils/performanceMonitor';
import { getGlobalCache } from '../utils/thumbnailCache';
import {
  scanDirectory,
  openDirectory,
  saveUserData as tauriSaveUserData,
  ensureDirectory,
  switchRootDatabase,
  shutdownColorExtraction,
  addPendingFilesToDb,
  dbGetAllPeople,
  dbGetAllTopics,
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
                cacheRoot: `${path}${path.includes('\\') ? '\\' : '/'}.Aurora_Cache`
              }
            },
            isScanning: true
          };
        });

        (async () => {
          try {
            const dbPeople = await dbGetAllPeople();
            if (Array.isArray(dbPeople)) {
              const dbPeopleMap: Record<string, Person> = {};
              dbPeople.forEach((p: any) => { dbPeopleMap[p.id] = p; });
              setState(prev => ({ ...prev, people: dbPeopleMap }));
            }
          } catch (e) {
            console.error('Failed to reload people after switching root:', e);
          }

          try {
            const dbTopics = await dbGetAllTopics();
            if (Array.isArray(dbTopics)) {
              const dbTopicsMap: Record<string, Topic> = {};
              dbTopics.forEach((t: any) => {
                dbTopicsMap[t.id] = {
                  id: t.id,
                  parentId: t.parentId,
                  name: t.name,
                  description: t.description,
                  type: t.topicType,
                  coverFileId: t.coverFileId,
                  backgroundFileId: t.backgroundFileId,
                  coverCrop: t.coverCrop,
                  peopleIds: t.peopleIds || [],
                  fileIds: t.fileIds || [],
                  fileCount: t.fileCount ?? 0,
                  sourceUrl: t.sourceUrl,
                  createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : undefined,
                  updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : undefined,
                };
              });
              setState(prev => ({ ...prev, topics: dbTopicsMap }));
            }
          } catch (e) {
            console.error('Failed to reload topics after switching root:', e);
          }

          scanAndMerge(path, true);
        })();

      }
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
                sourceUrl: existingFile.sourceUrl,
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

  const handleRefreshTags = async () => {
    try {
      const allMetadata = await dbGetAllFileMetadata();

      setState(prev => {
        const newFiles = { ...prev.files };
        const newCustomTags = new Set<string>();

        allMetadata.forEach(meta => {
          const file = newFiles[meta.fileId];
          if (file && meta.tags && meta.tags.length > 0) {
            newFiles[meta.fileId] = { ...file, tags: meta.tags };
            meta.tags.forEach(tag => newCustomTags.add(tag));
          }
        });

        return {
          ...prev,
          files: newFiles,
          customTags: Array.from(newCustomTags)
        };
      });
    } catch (error) {
      console.error('Failed to refresh tags:', error);
    }
  };

  const handleChangePath = async (type: 'resource' | 'cache') => {
    try {
      const selectedPath = await openDirectory();
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

      const newSettings = {
        ...state.settings,
        paths: {
          ...state.settings.paths,
          resourceRoot: selectedPath,
          cacheRoot: ''
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
          const dbPeople = await dbGetAllPeople();
          if (Array.isArray(dbPeople)) {
            const dbPeopleMap: Record<string, Person> = {};
            dbPeople.forEach((p: any) => { dbPeopleMap[p.id] = p; });
            setState(prev => ({ ...prev, people: dbPeopleMap }));
          }
        } catch (e) {
          console.error('Failed to reload people after switching root:', e);
        }

        try {
          const dbTopics = await dbGetAllTopics();
          if (Array.isArray(dbTopics)) {
            const dbTopicsMap: Record<string, Topic> = {};
            dbTopics.forEach((t: any) => {
              dbTopicsMap[t.id] = {
                id: t.id,
                parentId: t.parentId,
                name: t.name,
                description: t.description,
                type: t.topicType,
                coverFileId: t.coverFileId,
                backgroundFileId: t.backgroundFileId,
                coverCrop: t.coverCrop,
                peopleIds: t.peopleIds || [],
                fileIds: t.fileIds || [],
                sourceUrl: t.sourceUrl,
                createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : undefined,
                updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : undefined,
              };
            });
            setState(prev => ({ ...prev, topics: dbTopicsMap }));
          }
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

  return {
    handleOpenFolder,
    scanAndMerge,
    handleRefresh,
    handleRefreshTags,
    handleChangePath,
  };
};
