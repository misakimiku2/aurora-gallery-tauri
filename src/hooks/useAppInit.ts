import { useEffect } from 'react';
import { AppState, FileNode, FileType, Person, Topic, TabState } from '../types';
import { DUMMY_TAB, DEFAULT_LAYOUT_SETTINGS } from '../constants';
import { isTauriEnvironment, detectTauriEnvironmentAsync } from '../utils/environment';
import { isAndroidPlatform, ensureAndroidPermissionAndScan, ensureAndroidPermission, scanAndroidFolders, scanAndroidImages, loadFolderCache, loadScanCache, saveScanCache } from '../utils/androidPlatform';
import { initializeFileSystem } from '../utils/mockFileSystem';
import { performanceMonitor } from '../utils/performanceMonitor';
import { memoryPressureMonitor } from '../utils/memoryPressureMonitor';
import { getGlobalCache } from '../utils/thumbnailCache';
import { aiService } from '../services/aiService';
import { setGlobalCacheRoot, setAndroidPlatform } from '../api/tauri-bridge';
import {
  loadUserData as tauriLoadUserData,
  getDefaultPaths as tauriGetDefaultPaths,
  scanDirectory,
  dbGetAllPeople,
  dbGetAllTopics,
  lanShareStart,
  batchGetColors,
} from '../api/tauri-bridge';

let isAppInitialized = false;

interface UseAppInitProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  savedDataLoadedRef: React.MutableRefObject<boolean>;
  setSavedDataLoaded: (v: boolean) => void;
  setIsLoading: (v: boolean) => void;
  setShowSplash: (v: boolean) => void;
  setShowWelcome: (v: boolean) => void;
  exitActionRef: React.MutableRefObject<'ask' | 'minimize' | 'exit'>;
  setGroupBy: (groupBy: any) => void;
}

export const useAppInit = ({
  state,
  setState,
  savedDataLoadedRef,
  setSavedDataLoaded,
  setIsLoading,
  setShowSplash,
  setShowWelcome,
  exitActionRef,
  setGroupBy,
}: UseAppInitProps) => {
  useEffect(() => {
    if (isAppInitialized) return;
    isAppInitialized = true;

    const init = async () => {
      const isTauriEnv = await detectTauriEnvironmentAsync();
      if (isTauriEnv) {
        const isTauriSyncEnv = isTauriEnvironment();
        let isSavedDataLoaded = false;

        if (isTauriSyncEnv) {
          try {
            const defaults = await tauriGetDefaultPaths();
            const savedData = await tauriLoadUserData();

            if (defaults.cacheRoot) {
              setGlobalCacheRoot(defaults.cacheRoot);
            }

            const isAndroidNow = await isAndroidPlatform();
            setAndroidPlatform(isAndroidNow);

            if (isAndroidNow && memoryPressureMonitor.isAvailable()) {
              memoryPressureMonitor.start();
              memoryPressureMonitor.subscribe((level) => {
                getGlobalCache().adjustSize(level);
              });
            }

            let finalSettings = {
              ...state.settings,
              paths: {
                ...state.settings.paths,
                ...defaults,
              }
            };

            if (savedData) {
              isSavedDataLoaded = true;

              let migratedSettings = { ...savedData.settings };
              if (migratedSettings.clip?.modelName === 'ViT-B-32' || migratedSettings.clip?.modelName === 'ViT-L-14') {
                console.log('[Migration] Migrating deprecated VIT model to SigLIP2-Base');
                migratedSettings.clip = {
                  ...migratedSettings.clip,
                  modelName: 'SigLIP2-Base'
                };
              }

              finalSettings = {
                ...finalSettings,
                ...migratedSettings,
                paths: {
                  ...finalSettings.paths,
                  ...(migratedSettings.paths || {}),
                  ...(isAndroidNow ? {
                    resourceRoot: defaults.resourceRoot,
                    cacheRoot: defaults.cacheRoot,
                    appDataDir: defaults.appDataDir,
                  } : {})
                },
                ai: {
                  ...finalSettings.ai,
                  ...(migratedSettings.ai || {})
                },
                defaultLayoutSettings: {
                  ...DEFAULT_LAYOUT_SETTINGS,
                  ...(migratedSettings.defaultLayoutSettings || {})
                }
              };

              let peopleData = savedData.people || {};
              try {
                const dbPeople = await dbGetAllPeople();
                if (Array.isArray(dbPeople) && dbPeople.length > 0) {
                  const dbPeopleMap: Record<string, Person> = {};
                  dbPeople.forEach((p: any) => { dbPeopleMap[p.id] = p; });
                  peopleData = dbPeopleMap;
                }
              } catch (e) { console.error("Failed to load people from DB", e); }

              let topicsData = savedData.topics || {};
              try {
                const dbTopics = await dbGetAllTopics();
                if (Array.isArray(dbTopics) && dbTopics.length > 0) {
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
                  topicsData = dbTopicsMap;
                }
              } catch (e) { console.error("Failed to load topics from DB", e); }

              setState(prev => ({
                ...prev,
                customTags: savedData.customTags || [],
                people: peopleData,
                topics: topicsData,
                folderSettings: savedData.folderSettings || {},
                settings: finalSettings
              }));
              savedDataLoadedRef.current = true;
              setSavedDataLoaded(true);

              (async () => {
                try {
                  setState(prev => ({ ...prev, aiConnectionStatus: 'checking' }));
                  const res = await aiService.checkConnection(finalSettings.ai);
                  if (res.status === 'connected') {
                    setState(prev => ({ ...prev, aiConnectionStatus: 'connected' }));

                    if (finalSettings.ai.provider === 'lmstudio' && res.result && res.result.data && Array.isArray(res.result.data) && res.result.data.length > 0) {
                      const detectedModel = res.result.data[0].id;
                      if (detectedModel && detectedModel !== finalSettings.ai.lmstudio.model) {
                        setState(prev => ({ ...prev, settings: { ...prev.settings, ai: { ...prev.settings.ai, lmstudio: { ...prev.settings.ai.lmstudio, model: detectedModel } } } }));
                      }
                    }
                  } else {
                    setState(prev => ({ ...prev, aiConnectionStatus: 'disconnected' }));
                  }
                } catch (e) {
                  console.error('Auto AI connection check failed:', e);
                  setState(prev => ({ ...prev, aiConnectionStatus: 'disconnected' }));
                }
              })();

              if (finalSettings.lanShare?.enabled && finalSettings.paths?.resourceRoot) {
                (async () => {
                  try {
                    console.log('[LAN Share] Auto-starting LAN share service...');
                    await lanShareStart(finalSettings.lanShare, finalSettings.paths.resourceRoot);
                    console.log('[LAN Share] Auto-started successfully');
                  } catch (e) {
                    console.error('[LAN Share] Auto-start failed:', e);
                  }
                })();
              }

              exitActionRef.current = finalSettings.exitAction || 'ask';
            } else {
              setState(prev => ({
                ...prev,
                settings: finalSettings
              }));
              exitActionRef.current = finalSettings.exitAction || 'ask';
            }

            let pathsToScan: string[] = [];
            let validRootPaths: string[] = [];

            if (savedData?.rootPaths && Array.isArray(savedData.rootPaths) && savedData.rootPaths.length > 0) {
              validRootPaths = savedData.rootPaths.filter((path: string) => {
                const lastDotIndex = path.lastIndexOf('.');
                const lastSlashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
                return lastDotIndex === -1 || lastDotIndex < lastSlashIndex;
              });
            }

            if (!savedData) {
              const isAndroid = await isAndroidPlatform();
              if (isAndroid) {
                localStorage.setItem('aurora_onboarded', 'true');
                setState(prev => ({ ...prev, settings: finalSettings }));

                const hasPermission = await ensureAndroidPermission();
                if (!hasPermission) {
                  setIsLoading(false);
                  setShowSplash(false);
                  return;
                }

                const appDataDir = defaults.appDataDir;

                const folderCachedResult = appDataDir ? await loadFolderCache(appDataDir) : null;
                if (folderCachedResult) {
                  const virtualRootId = '__android_folders_root__';
                  const defaultTab: TabState = {
                    ...DUMMY_TAB,
                    id: 'tab-default',
                    folderId: virtualRootId,
                    viewMode: 'folders-overview',
                  };
                  defaultTab.history = { stack: [{ folderId: virtualRootId, viewingId: null, viewMode: 'folders-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 };

                  setState(prev => ({
                    ...prev,
                    settings: finalSettings,
                    files: folderCachedResult.files,
                    roots: folderCachedResult.roots,
                    expandedFolderIds: folderCachedResult.roots,
                    tabs: [defaultTab],
                    activeTabId: defaultTab.id,
                    currentFolderId: virtualRootId,
                  }));

                  setIsLoading(false);

                  (async () => {
                    setState(prev => ({ ...prev, isScanning: true }));
                    const fullCachedResult = appDataDir ? await loadScanCache(appDataDir) : null;
                    if (fullCachedResult) {
                      setState(prev => ({
                        ...prev,
                        files: fullCachedResult.files,
                        roots: fullCachedResult.roots,
                      }));
                    }
                    const cacheTs = folderCachedResult.cacheTimestamp ? Math.floor(folderCachedResult.cacheTimestamp / 1000) : undefined;
                    const incrementalResult = await scanAndroidImages(undefined, cacheTs);
                    if (incrementalResult && incrementalResult.rawImages && incrementalResult.rawImages.length > 0) {
                      const fullResult = await scanAndroidImages();
                      if (fullResult) {
                        setState(prev => ({
                          ...prev,
                          files: fullResult.files,
                          roots: fullResult.roots,
                          isScanning: false,
                        }));
                        if (appDataDir && fullResult.rawFolders && fullResult.rawImages) {
                          saveScanCache(appDataDir, fullResult.rawFolders, fullResult.rawImages);
                        }
                      } else {
                        setState(prev => ({ ...prev, isScanning: false }));
                      }
                    } else {
                      setState(prev => ({ ...prev, isScanning: false }));
                    }
                    setShowSplash(false);
                  })();
                  return;
                }

                const folderResult = await scanAndroidFolders();
                if (folderResult) {
                  const virtualRootId = '__android_folders_root__';
                  const defaultTab: TabState = {
                    ...DUMMY_TAB,
                    id: 'tab-default',
                    folderId: virtualRootId,
                    viewMode: 'folders-overview',
                  };
                  defaultTab.history = { stack: [{ folderId: virtualRootId, viewingId: null, viewMode: 'folders-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 };

                  setState(prev => ({
                    ...prev,
                    settings: finalSettings,
                    files: folderResult.files,
                    roots: folderResult.roots,
                    expandedFolderIds: folderResult.roots,
                    tabs: [defaultTab],
                    activeTabId: defaultTab.id,
                    currentFolderId: virtualRootId,
                  }));

                  setIsLoading(false);

                  (async () => {
                    setState(prev => ({ ...prev, isScanning: true }));
                    const imageResult = await scanAndroidImages();
                    if (imageResult) {
                      setState(prev => ({
                        ...prev,
                        files: imageResult.files,
                        roots: imageResult.roots,
                        isScanning: false,
                      }));
                      if (appDataDir && imageResult.rawFolders && imageResult.rawImages) {
                        saveScanCache(appDataDir, imageResult.rawFolders, imageResult.rawImages);
                      }
                    } else {
                      setState(prev => ({ ...prev, isScanning: false }));
                    }
                    setShowSplash(false);
                  })();
                } else {
                  setIsLoading(false);
                  setShowSplash(false);
                }
              } else {
                setState(prev => ({ ...prev, settings: finalSettings }));
                setIsLoading(false);
                setShowWelcome(true);
                setTimeout(() => setShowSplash(false), 200);
              }
              return;
            }

            const isAndroid = await isAndroidPlatform();

            if (isAndroid) {
              setState(prev => ({ ...prev, settings: finalSettings }));

              const hasPermission = await ensureAndroidPermission();
              if (!hasPermission) {
                setIsLoading(false);
                setShowSplash(false);
                savedDataLoadedRef.current = true;
                setSavedDataLoaded(true);
                return;
              }

              const appDataDir = defaults.appDataDir;
              const globalLayoutSettings = savedData?.settings?.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS;

              const folderCachedResult = appDataDir ? await loadFolderCache(appDataDir) : null;
              if (folderCachedResult) {
                const virtualRootId = '__android_folders_root__';
                const defaultTab: TabState = {
                  ...DUMMY_TAB,
                  id: 'tab-default',
                  folderId: virtualRootId,
                  viewMode: 'folders-overview',
                  layoutMode: globalLayoutSettings.layoutMode as any
                };
                defaultTab.history = { stack: [{ folderId: virtualRootId, viewingId: null, viewMode: 'folders-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 };

                setState(prev => ({
                  ...prev,
                  files: folderCachedResult.files,
                  roots: folderCachedResult.roots,
                  expandedFolderIds: folderCachedResult.roots,
                  tabs: [defaultTab],
                  activeTabId: defaultTab.id,
                  currentFolderId: virtualRootId,
                  sortBy: savedData?.settings?.defaultLayoutSettings?.sortBy || globalLayoutSettings.sortBy,
                  sortDirection: savedData?.settings?.defaultLayoutSettings?.sortDirection || globalLayoutSettings.sortDirection,
                }));

                setIsLoading(false);

                (async () => {
                  setState(prev => ({ ...prev, isScanning: true }));
                  const fullCachedResult = appDataDir ? await loadScanCache(appDataDir) : null;
                  if (fullCachedResult) {
                    setState(prev => ({
                      ...prev,
                      files: fullCachedResult.files,
                      roots: fullCachedResult.roots,
                      sortBy: savedData?.settings?.defaultLayoutSettings?.sortBy || globalLayoutSettings.sortBy,
                      sortDirection: savedData?.settings?.defaultLayoutSettings?.sortDirection || globalLayoutSettings.sortDirection,
                    }));
                  }
                  const cacheTs = folderCachedResult.cacheTimestamp ? Math.floor(folderCachedResult.cacheTimestamp / 1000) : undefined;
                  const incrementalResult = await scanAndroidImages(undefined, cacheTs);
                  if (incrementalResult && incrementalResult.rawImages && incrementalResult.rawImages.length > 0) {
                    const fullResult = await scanAndroidImages();
                    if (fullResult) {
                      setState(prev => ({
                        ...prev,
                        files: fullResult.files,
                        roots: fullResult.roots,
                        sortBy: savedData?.settings?.defaultLayoutSettings?.sortBy || globalLayoutSettings.sortBy,
                        sortDirection: savedData?.settings?.defaultLayoutSettings?.sortDirection || globalLayoutSettings.sortDirection,
                        isScanning: false,
                      }));
                      if (appDataDir && fullResult.rawFolders && fullResult.rawImages) {
                        saveScanCache(appDataDir, fullResult.rawFolders, fullResult.rawImages);
                      }
                    } else {
                      setState(prev => ({ ...prev, isScanning: false }));
                    }
                  } else {
                    setState(prev => ({ ...prev, isScanning: false }));
                  }
                  setShowSplash(false);
                })();

                savedDataLoadedRef.current = true;
                setSavedDataLoaded(true);
                return;
              }

              const folderResult = await scanAndroidFolders();
              if (folderResult) {
                const virtualRootId = '__android_folders_root__';

                const defaultTab: TabState = {
                  ...DUMMY_TAB,
                  id: 'tab-default',
                  folderId: virtualRootId,
                  viewMode: 'folders-overview',
                  layoutMode: globalLayoutSettings.layoutMode as any
                };
                defaultTab.history = { stack: [{ folderId: virtualRootId, viewingId: null, viewMode: 'folders-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 };

                setState(prev => ({
                  ...prev,
                  files: folderResult.files,
                  roots: folderResult.roots,
                  expandedFolderIds: folderResult.roots,
                  tabs: [defaultTab],
                  activeTabId: defaultTab.id,
                  currentFolderId: virtualRootId,
                }));

                setIsLoading(false);

                (async () => {
                  setState(prev => ({ ...prev, isScanning: true }));
                  const imageResult = await scanAndroidImages();
                  if (imageResult) {
                    setState(prev => ({
                      ...prev,
                      files: imageResult.files,
                      roots: imageResult.roots,
                      sortBy: savedData?.settings?.defaultLayoutSettings?.sortBy || globalLayoutSettings.sortBy,
                      sortDirection: savedData?.settings?.defaultLayoutSettings?.sortDirection || globalLayoutSettings.sortDirection,
                      isScanning: false,
                    }));
                    if (appDataDir && imageResult.rawFolders && imageResult.rawImages) {
                      saveScanCache(appDataDir, imageResult.rawFolders, imageResult.rawImages);
                    }
                  } else {
                    setState(prev => ({ ...prev, isScanning: false }));
                  }
                  setShowSplash(false);
                })();
              } else {
                setIsLoading(false);
                setShowSplash(false);
              }

              savedDataLoadedRef.current = true;
              setSavedDataLoaded(true);
              return;
            }

            if (validRootPaths.length === 0) {
              if (finalSettings.paths.resourceRoot && finalSettings.paths.resourceRoot !== 'android_media_store') {
                pathsToScan = [finalSettings.paths.resourceRoot];
              }
            } else {
              pathsToScan = validRootPaths.filter((p: string) => p !== 'android_media_store');
            }

            if (pathsToScan.length > 0) {
              let allFiles: Record<string, FileNode> = {};
              let allRoots: string[] = [];
              const savedMetadata = savedData?.fileMetadata || {};
              for (const p of pathsToScan) {
                try {
                  const scanTimer = performanceMonitor.start('scanDirectory', undefined, true);

                  const result = await scanDirectory(p);

                  performanceMonitor.end(scanTimer, 'scanDirectory', {
                    path: p,
                    fileCount: Object.keys(result.files).length,
                    rootCount: result.roots.length
                  });

                  performanceMonitor.increment('filesScanned', Object.keys(result.files).length);

                  Object.values(result.files || {}).forEach((f: any) => {
                    const saved = savedMetadata[f.path];
                    if (!saved) return;

                    if ((!f.tags || f.tags.length === 0) && saved.tags) f.tags = saved.tags;
                    if (!f.description && saved.description) f.description = saved.description;
                    if (!f.sourceUrl && saved.sourceUrl) f.sourceUrl = saved.sourceUrl;
                    if (!f.aiData && saved.aiData) f.aiData = saved.aiData;
                    if (!f.category && saved.category) f.category = saved.category;

                    if (saved.meta && f.meta) {
                      if ((!f.meta.width || f.meta.width === 0) && saved.meta.width) f.meta.width = saved.meta.width;
                      if ((!f.meta.height || f.meta.height === 0) && saved.meta.height) f.meta.height = saved.meta.height;
                      if ((!f.meta.palette || f.meta.palette.length === 0) && saved.meta.palette) f.meta.palette = saved.meta.palette;
                    }
                  });

                  Object.assign(allFiles, result.files);
                  allRoots.push(...result.roots);
                } catch (err) {
                  console.error(`Failed to reload root: ${p}`, err);
                }
              }

              if (allRoots.length > 0) {
                const imagePaths: string[] = [];
                Object.values(allFiles).forEach((f: any) => {
                  if (f.type === FileType.IMAGE && f.path && (!f.meta?.palette || f.meta.palette.length === 0)) {
                    imagePaths.push(f.path);
                  }
                });

                if (imagePaths.length > 0) {
                  try {
                    const palettes = await batchGetColors(imagePaths);
                    for (const [dbPath, palette] of Object.entries(palettes)) {
                      if (palette.length === 0) continue;
                      const file = Object.values(allFiles).find((f: any) =>
                        f.path === dbPath || f.path?.replace(/\\/g, '/') === dbPath
                      );
                      if (file && file.meta) {
                        file.meta.palette = palette;
                      }
                    }
                  } catch (e) {
                    console.warn('Failed to batch load palettes:', e);
                  }
                }

                const globalLayoutSettings = savedData?.settings?.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS;

                setState(prev => {
                  const initialFolder = allRoots[0];

                  const savedForRoot = (savedData && savedData.folderSettings && typeof savedData.folderSettings === 'object') ? savedData.folderSettings[initialFolder] : undefined;

                  const layoutMode = savedForRoot?.layoutMode || globalLayoutSettings.layoutMode;
                  const sortBy = savedForRoot?.sortBy || globalLayoutSettings.sortBy;
                  const sortDirection = savedForRoot?.sortDirection || globalLayoutSettings.sortDirection;
                  const groupBySetting = savedForRoot?.groupBy || globalLayoutSettings.groupBy;

                  const defaultTab: TabState = {
                    ...DUMMY_TAB,
                    id: 'tab-default',
                    folderId: initialFolder,
                    layoutMode: layoutMode as any
                  };
                  defaultTab.history = { stack: [{ folderId: initialFolder, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 };

                  setGroupBy(groupBySetting as any);

                  return {
                    ...prev,
                    roots: allRoots,
                    files: allFiles,
                    expandedFolderIds: allRoots,
                    tabs: [defaultTab],
                    activeTabId: defaultTab.id,
                    sortBy: sortBy,
                    sortDirection: sortDirection
                  };
                });

                savedDataLoadedRef.current = true;
                setSavedDataLoaded(true);
                setIsLoading(false);
                setTimeout(() => {
                  setShowSplash(false);
                }, 500);
                return;
              } else {
                isSavedDataLoaded = false;
              }
            }
          } catch (e) {
            console.error("Tauri initialization failed", e);
            isSavedDataLoaded = false;
          }
        }

        if (!isSavedDataLoaded) {
          const { roots, files } = initializeFileSystem();
          const initialFolder = roots[0];
          const defaultTab: TabState = { ...DUMMY_TAB, id: 'tab-default', folderId: initialFolder, history: { stack: [{ folderId: initialFolder, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 } };
          setState(prev => ({ ...prev, roots, files, people: {}, expandedFolderIds: roots, tabs: [defaultTab], activeTabId: defaultTab.id }));
        }

        savedDataLoadedRef.current = true;
        setSavedDataLoaded(true);
        console.debug('[Init] Initialization complete (no saved data)');

        setIsLoading(false);
        setTimeout(() => {
          setShowSplash(false);
        }, 500);
      }
    };
    init();
  }, []);
};
