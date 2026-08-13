import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { lanClientApi } from './components/lan-client/lanClientApi';
import { downloadLanImagesBatched } from './components/lan-client/lanDownload';
import { InlineRenameInput } from './components/InlineRenameInput';
import { ImageThumbnail } from './components/ImageThumbnail';
import { SettingsModal } from './components/SettingsModal';
import { AuroraLogo } from './components/Logo';
import { CloseConfirmationModal } from './components/CloseConfirmationModal';
import { initializeFileSystem, formatSize } from './utils/mockFileSystem';
import { debug as logDebug, info as logInfo, warn as logWarn } from './utils/logger';
import { translations } from './utils/translations';
import { debounce } from './utils/debounce';
import { performanceMonitor } from './utils/performanceMonitor';
import { scanDirectory, scanFile, openDirectory, saveUserData as tauriSaveUserData, loadUserData as tauriLoadUserData, getDefaultPaths as tauriGetDefaultPaths, ensureDirectory, createFolder, renameFile, deleteFile, deleteAndroidFiles, clearScanCache, getThumbnail, hideWindow, showWindow, exitApp, copyFile, moveFile, writeFileFromBytes, pauseColorExtraction, resumeColorExtraction, searchByColor, searchByPalette, getAssetUrl, openPath, dbGetAllPeople, dbUpsertPerson, dbDeletePerson, dbUpdatePersonAvatar, dbUpsertFileMetadata, dbGetAllFileMetadata, addPendingFilesToDb, switchRootDatabase, dbGetAllTopics, dbUpsertTopic, dbDeleteTopic, copyImageToClipboard, getColorDbStats, lanShareStart, setAndroidStatusBar, setAndroidImmersiveMode, androidUpdateTaskNotification, androidHideTaskNotification, isAndroidPlatformCached, androidCheckStorageManager, androidRequestAllFilesAccess } from './api/tauri-bridge';
import { AppState, FileNode, FileType, SlideshowConfig, AppSettings, SearchScope, SortOption, TabState, LayoutMode, SUPPORTED_EXTENSIONS, DateFilter, SettingsCategory, AiData, TaskProgress, Person, Topic, HistoryItem, AiFace, GroupByOption, FileGroup, DeletionTask, AiSearchFilter, PersonSortOption, PersonGroupByOption, SortDirection, ImageMeta } from './types';
import { ArrowUp, Moon, Sun, Monitor, RotateCcw, Copy, Move, ChevronDown, Trash2, Undo2, Shield, QrCode, Smartphone, ExternalLink, Sliders, Plus, Layout, List, Grid, Maximize, AlertTriangle, Merge, FilePlus, ChevronsDown, ChevronsUp, FolderPlus, Server, Loader2, Database, Palette, Check, RefreshCw, Scan, Cpu, Cloud, FileCode, Edit3, Minus, Type, Crop, LogOut, XCircle, Pause, MoveHorizontal, Clipboard, Link } from 'lucide-react';
import { aiService } from './services/aiService';

import { isAndroidPlatform, ensureAndroidPermissionAndScan, scanAndroidMedia, initAndroidPermissionListener, isAndroidSync } from './utils/androidPlatform';
import { generateId } from './utils/pathUtils';
import { useTasks } from './hooks/useTasks';
import { useFileSearch } from './hooks/useFileSearch';
import { useFileOperations } from './hooks/useFileOperations';
import { useMarqueeSelection } from './hooks/useMarqueeSelection';
import { useAIAnalysis } from './hooks/useAIAnalysis';
import { useContextMenu } from './hooks/useContextMenu';
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts';
import { useToasts } from './hooks/useToasts';
import { useNavigation } from './hooks/useNavigation';
import { useUpdateCheck } from './hooks/useUpdateCheck';
import { useAppInit } from './hooks/useAppInit';
import { useDirectoryScan } from './hooks/useDirectoryScan';
import { useWindowLifecycle } from './hooks/useWindowLifecycle';
import { useSearch } from './hooks/useSearch';
import { usePeople } from './hooks/usePeople';
import { useTopics } from './hooks/useTopics';
import { useTags } from './hooks/useTags';
import { useExternalDragDrop } from './hooks/useExternalDragDrop';
import { usePersistence } from './hooks/usePersistence';
import { useFileSelection } from './hooks/useFileSelection';
import { useFolderSettings } from './hooks/useFolderSettings';
import { usePanelSwipeGesture } from './hooks/usePanelSwipeGesture';
import { useLanClientSync } from './hooks/useLanClientSync';
import { GlobalToasts } from './components/GlobalToasts';
import { asyncPool } from './utils/async';
import { ToastItem } from './components/ToastItem';
import { TaskProgressModal } from './components/TaskProgressModal';
import { getPinyinGroup } from './utils/textUtils';
import { DUMMY_TAB, DEFAULT_LAYOUT_SETTINGS } from './constants';
import SplashScreen from './components/SplashScreen';
import { SvgColorFilters } from './components/SvgColorFilters';
import { LanDownloadOverlay } from './components/LanDownloadOverlay';
import { DragDropOverlay, DropAction } from './components/DragDropOverlay';
import { ContextMenu } from './components/ContextMenu';
import { AppModals } from './components/AppModals';
import { TabBarWrapper } from './components/app/TabBarWrapper';
import { SidebarPane } from './components/app/SidebarPane';
import { ViewerPane } from './components/app/ViewerPane';
import { ToolbarPane } from './components/app/ToolbarPane';
import { FilterChipsBar } from './components/app/FilterChipsBar';
import { OverviewBar } from './components/app/OverviewBar';
import { MainContentArea } from './components/app/MainContentArea';
import { RightPanel } from './components/app/RightPanel';
import { isTauriEnvironment, detectTauriEnvironmentAsync } from './utils/environment';
import { getInitialLayout } from './utils/layoutSettings';

// 锟斤拷展 Window 锟接匡拷锟皆帮拷锟斤拷锟斤拷锟角碉拷全锟街猴拷锟斤拷
declare global {
  interface Window {
    __UPDATE_FILE_COLORS__?: (filePath: string, colors: string[]) => void;
  }
}

// Global initialization guard to prevent double execution in React Strict Mode
let isAppInitialized = false;

export const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    roots: [], files: {}, people: {}, topics: {}, expandedFolderIds: [], tabs: [], activeTabId: '', sortBy: 'name', sortDirection: 'asc', thumbnailSize: 180, renamingId: null, clipboard: { action: null, items: { type: 'file', ids: [] } }, customTags: [], folderSettings: {}, layout: getInitialLayout(),
    slideshowConfig: { interval: 3000, transition: 'fade', isRandom: false, enableZoom: true },
    settings: {
      theme: 'system',
      language: 'zh',
      autoStart: false,
      exitAction: 'ask',
      animateOnHover: true,
      autoExtractPalette: true,
      paths: { resourceRoot: 'C:\\Users\\User\\Pictures\\AuroraGallery', cacheRoot: 'C:\\AppData\\Local\\Aurora\\Cache' },
      search: { isAISearchEnabled: false },
      performance: {
        refreshInterval: 5000, // 默锟斤拷5锟斤拷刷锟斤拷一锟斤拷
        scrollProfiling: false // 滚动性能记录（默认关闭，设置-性能界面可开启）
      },
      ai: {
        provider: 'ollama',
        openai: { apiKey: '', endpoint: 'https://api.openai.com/v1', model: 'gpt-4o' },
        ollama: { endpoint: 'http://localhost:11434', model: 'llava' },
        lmstudio: { endpoint: 'http://localhost:1234/v1', model: 'local-model' },
        autoTag: false,
        autoDescription: false,
        enhancePersonDescription: false,
        enableFaceRecognition: false,
        autoAddPeople: false,
        enableOCR: false,
        enableTranslation: false,
        targetLanguage: 'zh',
        confidenceThreshold: 0.6
      },
      clip: {
        enabled: true,
        modelName: 'SigLIP2-Base',
        useGpu: false,
        downloadStatus: 'not_started',
        downloadProgress: 0,
        modelVersion: '1.0.0',
        minScore: 0.4,
        maxResults: 200,
        unlimitedResults: true,
        autoAddTags: false,
        tagThreshold: 0.35,
      },
      lanShare: {
        enabled: false,
        port: 8080,
        accessCode: '',
        allowEdit: false,
        allowUpload: false,
      },
      defaultLayoutSettings: DEFAULT_LAYOUT_SETTINGS,
    },
    // Scan progress (onboarding)
    scanProgress: null,
    isScanning: false,
    isSettingsOpen: false, settingsCategory: 'general', activeModal: { type: null }, tasks: [],
    aiConnectionStatus: 'checking',
    // 锟斤拷拽状态
    dragState: {
      isDragging: false,
      draggedFileIds: [],
      sourceFolderId: null,
      dragOverFolderId: null,
      dragOverPosition: null
    }
  });

  // Track "major" updates to files (scan completion, delete, etc.)
  // to avoid O(N) recalculations on minor property updates (like palette, description)
  const [filesVersion, setFilesVersion] = useState(0);

  // Auto-increment filesVersion when state.files reference changes
  // This helps differentiate between structural file changes and selection/metadata updates
  useEffect(() => {
    setFilesVersion(v => v + 1);
  }, [state.files]);

  // P1: 监听自动分类完成事件，重新加载专题列表
  useEffect(() => {
    const handleTopicsChanged = async () => {
      try {
        const freshTopics = await dbGetAllTopics();
        const topicsMap: Record<string, Topic> = {};
        freshTopics.forEach(t => { topicsMap[t.id] = t; });
        setState(prev => ({ ...prev, topics: topicsMap }));
      } catch (e) {
        console.error('Failed to reload topics after classification:', e);
      }
    };
    window.addEventListener('topics-data-changed', handleTopicsChanged as EventListener);
    return () => window.removeEventListener('topics-data-changed', handleTopicsChanged as EventListener);
  }, []);

  // P1: 监听"前往 AI视觉"事件，打开设置弹窗并切换到 aiVision 分类
  useEffect(() => {
    const handleNavigateAiVision = () => {
      setState(s => ({ ...s, isSettingsOpen: true, settingsCategory: 'aiVision' }));
    };
    window.addEventListener('navigate-to-ai-vision', handleNavigateAiVision);
    return () => window.removeEventListener('navigate-to-ai-vision', handleNavigateAiVision);
  }, []);

  // ... (keep all state variables and hooks identical)
  const [isLoading, setIsLoading] = useState(true);
  const [showSplash, setShowSplash] = useState(true);
  const [hasShownWelcome, setHasShownWelcome] = useState(false);
  const [loadingInfo, setLoadingInfo] = useState<string[]>([]);

  // 锟斤拷锟叫讹拷锟绞憋拷锟斤拷锟斤拷呒锟?
  useEffect(() => {
    return () => {
      // 锟斤拷锟斤拷锟斤拷锟叫讹拷时锟斤拷
      // timerRefs.current.forEach((timer) => {
      //   clearInterval(timer);
      // });
      // timerRefs.current.clear();

      // 取锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟?
      // debouncedTaskUpdate.cancel();

      // 应锟斤拷锟斤拷锟斤拷锟捷达拷锟斤拷锟斤拷锟斤拷锟铰ｏ拷确锟斤拷锟斤拷锟斤拷一锟斤拷锟斤拷
      /*
      if (taskUpdatesRef.current.size > 0) {
        setState(prev => {
          const updatedTasks = prev.tasks.map(t => {
            const updates = taskUpdatesRef.current.get(t.id);
            if (updates) {
              return { ...t, ...updates };
            }
            return t;
          });

          taskUpdatesRef.current.clear();

          return { ...prev, tasks: updatedTasks };
        });
      }
      */
    };
  }, []);

  const [hoverPlayingId, setHoverPlayingId] = useState<string | null>(null);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [personSearchQuery, setPersonSearchQuery] = useState('');
  // People view sort and group settings - with localStorage persistence
  const [personSortBy, setPersonSortBy] = useState<PersonSortOption>(() => {
    try {
      const saved = localStorage.getItem('aurora_person_sort_by');
      return (saved as PersonSortOption) || 'count';
    } catch (e) {
      return 'count';
    }
  });
  const [personSortDirection, setPersonSortDirection] = useState<SortDirection>(() => {
    try {
      const saved = localStorage.getItem('aurora_person_sort_direction');
      return (saved as SortDirection) || 'desc';
    } catch (e) {
      return 'desc';
    }
  });
  const [personGroupBy, setPersonGroupBy] = useState<PersonGroupByOption>(() => {
    try {
      const saved = localStorage.getItem('aurora_person_group_by');
      return (saved as PersonGroupByOption) || 'none';
    } catch (e) {
      return 'none';
    }
  });

  // Handlers that persist to localStorage
  const handlePersonSortByChange = (option: PersonSortOption) => {
    setPersonSortBy(option);
    try { localStorage.setItem('aurora_person_sort_by', option); } catch (e) { }
  };

  const handlePersonSortDirectionChange = () => {
    setPersonSortDirection(prev => {
      const newDirection = prev === 'asc' ? 'desc' : 'asc';
      try { localStorage.setItem('aurora_person_sort_direction', newDirection); } catch (e) { }
      return newDirection;
    });
  };

  const handlePersonGroupByChange = (option: PersonGroupByOption) => {
    setPersonGroupBy(option);
    try { localStorage.setItem('aurora_person_group_by', option); } catch (e) { }
  };
  const lastSelectedTagRef = useRef<string | null>(null);
  const { toast, showToast } = useToasts();
  const [toolbarQuery, setToolbarQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupByOption>('none');
  // CLIP search state
  // Topic layout mode: controlled by TopBar when viewing topics overview
  const [topicLayoutMode, setTopicLayoutMode] = useState<LayoutMode>(() => ((localStorage.getItem('aurora_topic_layout_mode') as LayoutMode) || 'grid'));
  const handleTopicLayoutModeChange = (mode: LayoutMode) => { setTopicLayoutMode(mode); try { localStorage.setItem('aurora_topic_layout_mode', mode); } catch (e) { } };
  const [folderLayoutMode, setFolderLayoutMode] = useState<LayoutMode>(() => ((localStorage.getItem('aurora_folder_layout_mode') as LayoutMode) || 'grid'));
  const handleFolderLayoutModeChange = useCallback((mode: LayoutMode) => { setFolderLayoutMode(mode); try { localStorage.setItem('aurora_folder_layout_mode', mode); } catch (e) { } }, []);
  const [rememberExitChoice, setRememberExitChoice] = useState(false);
  // Ref to store the latest exit action preference (to avoid closure issues)
  const exitActionRef = useRef<'ask' | 'minimize' | 'exit'>('ask');
  // State for close confirmation modal
  const [showCloseConfirmation, setShowCloseConfirmation] = useState(false);
  const { handleExitConfirm, handleCloseConfirmation } = useWindowLifecycle({
    state, setState, exitActionRef, isLoading, setShowCloseConfirmation, rememberExitChoice,
  });
  // State for reference mode - controls TabBar visibility with hover detection
  const [isReferenceMode, setIsReferenceMode] = useState(false);
  const [isAndroidSelectionMode, setIsAndroidSelectionMode] = useState(false);
  const isAndroidSelectionModeRef = useRef(false);
  useEffect(() => { isAndroidSelectionModeRef.current = isAndroidSelectionMode; }, [isAndroidSelectionMode]);
  // State for tracking if user is hovering over the top bar area
  const [isHoveringTopBar, setIsHoveringTopBar] = useState(false);
  // Use ref to store the setter to avoid re-renders causing issues
  const isReferenceModeRef = useRef(setIsReferenceMode);
  useEffect(() => {
    isReferenceModeRef.current = setIsReferenceMode;
  }, []);
  const handleReferenceModeChange = useCallback((inReferenceMode: boolean) => {
    isReferenceModeRef.current(inReferenceMode);
  }, []);
  const handleTopBarHoverChange = useCallback((isHovering: boolean) => {
    setIsHoveringTopBar(isHovering);
  }, []);

  // Translation helper
  const t = useCallback((key: string): string => {
    const keys = key.split('.');
    let val: any = translations[state.settings.language];
    for (const k of keys) { val = val?.[k]; }
    return typeof val === 'string' ? val : key;
  }, [state.settings.language]);

  const updateActiveTab = useCallback((updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t => {
        if (t.id === prev.activeTabId) {
          const actualUpdates = typeof updates === 'function' ? updates(t) : updates;
          return { ...t, ...actualUpdates };
        }
        return t;
      })
    }));
  }, []);

  const handleFolderScrollTopChange = useCallback((scrollTop: number) => { updateActiveTab({ scrollTop }); }, [updateActiveTab]);

  const updateTabById = useCallback((tabId: string, updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => {
    setState(prev => ({
      ...prev,
      tabs: prev.tabs.map(t => {
        if (t.id === tabId) {
          const actualUpdates = typeof updates === 'function' ? updates(t) : updates;
          return { ...t, ...actualUpdates };
        }
        return t;
      })
    }));
  }, []);

  const { tasks } = state;

  const { startTask, updateTask } = useTasks(state, setState, t);

  // External drag and drop state
  const [hoveredDropAction, setHoveredDropAction] = useState<DropAction>(null);
  const externalDragCounter = useRef(0);

  // Internal drag state for tracking external drag operations
  const [isDraggingInternal, setIsDraggingInternal] = useState(false);
  const [draggedFilePaths, setDraggedFilePaths] = useState<string[]>([]);

  // 锟皆讹拷锟斤拷锟铰硷拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟节革拷锟斤拷锟侥硷拷锟斤拷色
  useEffect(() => {
    // 锟斤拷锟斤拷锟铰硷拷锟斤拷锟斤拷锟斤拷锟斤拷
    const handleColorUpdate = (event: CustomEvent) => {
      const { filePath, colors } = event.detail;
      if (!filePath || !colors) return;

      // 锟揭碉拷锟斤拷应锟斤拷锟侥硷拷ID
      const fileEntry = Object.entries(state.files).find(([id, file]) => file.path === filePath);
      if (fileEntry) {
        const [fileId, file] = fileEntry;
        // 锟斤拷锟斤拷锟侥硷拷锟斤拷 meta.palette锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷 meta 锟街段诧拷锟斤拷
        const currentMeta = file.meta;
        if (currentMeta) {
          handleUpdateFile(fileId, {
            meta: {
              ...currentMeta,
              palette: colors
            }
          });
        } else {
          // 锟斤拷锟矫伙拷锟?meta锟斤拷锟斤拷锟斤拷一锟斤拷锟斤拷锟斤拷锟斤拷 meta 锟斤拷锟斤拷
          handleUpdateFile(fileId, {
            meta: {
              width: 0,
              height: 0,
              sizeKb: 0,
              created: new Date().toISOString(),
              modified: new Date().toISOString(),
              format: '',
              palette: colors
            }
          });
        }
      }
    };

    // 锟斤拷锟斤拷锟铰硷拷锟斤拷锟斤拷锟斤拷
    window.addEventListener('color-update', handleColorUpdate as EventListener);

    // 锟斤拷锟斤拷锟斤拷锟斤拷
    return () => {
      window.removeEventListener('color-update', handleColorUpdate as EventListener);
    };
  }, [state.files]); // 锟斤拷锟斤拷 files锟斤拷确锟斤拷锟斤拷锟斤拷确锟揭碉拷锟侥硷拷

  // 锟斤拷锟斤拷锟斤拷色锟斤拷锟斤拷取锟斤拷锟斤拷锟铰硷拷 (moved to useTasks hook)

  const [showWelcome, setShowWelcome] = useState(false);

  // Expose showWelcomeModal for testing/dev
  useEffect(() => {
    (window as any).showWelcomeModal = () => setShowWelcome(true);
  }, []);


  // ... (keep persistence logic, init effect, exit logic, etc.)
  const saveUserData = async (data: any) => {
    // 调用 Tauri 后端的异步保存 API
    if (!isTauriEnvironment()) {
      return false;
    }

    try {
      const result = await tauriSaveUserData(data);
      return result;
    } catch (error) {
      console.error('Failed to save user data via Tauri:', error);
      return false;
    }
  };



  // ... (keep exit handler)

  const activeTab = useMemo(() => {
    return state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB;
  }, [state.tabs, state.activeTabId]);

  const activeTabIndex = useMemo(() => {
    return state.tabs.findIndex(t => t.id === state.activeTabId);
  }, [state.tabs, state.activeTabId]);

  const isLeftmostTab = activeTabIndex <= 0;

  // Use a ref for activeTab to provide stable callbacks
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // 更新检查
  const {
    updateInfo,
    isChecking: isCheckingUpdate,
    downloadProgress,
    checkUpdate,
    startDownload,
    pauseDownload,
    resumeDownload,
    cancelDownload,
    installUpdate,
    openDownloadFolder,
    ignoreVersion,
    dismissUpdate,
  } = useUpdateCheck();

  // 当检测到有更新时，显示更新模态框
  useEffect(() => {
    if (updateInfo?.hasUpdate && !showWelcome) {
      setState(s => ({ ...s, activeModal: { type: 'update' } }));
    }
  }, [updateInfo, showWelcome]);

  // 监听打开更新弹窗的事件（从设置页面触发）
  useEffect(() => {
    const handleOpenUpdateModal = () => {
      if (updateInfo?.hasUpdate) {
        setState(s => ({ ...s, activeModal: { type: 'update' } }));
      }
    };
    window.addEventListener('open-update-modal', handleOpenUpdateModal);
    return () => window.removeEventListener('open-update-modal', handleOpenUpdateModal);
  }, [updateInfo]);

  // Handle Special Search Queries (palette:, color:)
  // Note: Most of this is now handled more robustly via onPerformSearch which calls pushHistory.
  // We keep this only for potential direct searchQuery changes, but remove the auto-clear 
  // that conflicts with onPerformSearch's own pushHistory calls.





  // ... (keep welcome modal logic)
  useEffect(() => {
    if (!isLoading) {
      setTimeout(() => {
        setShowSplash(false);
        // 启动界面关闭后退出沉浸式全屏，显示系统状态栏，并同步当前软件主题色
        if (isAndroidPlatformCached()) {
          setAndroidImmersiveMode(false);
          const theme = state.settings.theme;
          let isDark = false;
          if (theme === 'dark') isDark = true;
          else if (theme === 'light') isDark = false;
          else {
            isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          }
          setAndroidStatusBar(isDark);
        }
      }, 100);

      if (state.roots.length === 0) {
        const hasOnboarded = localStorage.getItem('aurora_onboarded');
        if (!hasOnboarded) {
          setShowWelcome(true);
        }
      }
    }
  }, [isLoading, state.roots.length, state.settings.theme]);

  const handleWelcomeFinish = () => {
    localStorage.setItem('aurora_onboarded', 'true');
    setShowWelcome(false);

    // 如果用户已经在欢迎页选了目录但我们尚未完成扫描，点击完成后才开始后台扫描和处理
    const resource = state.settings.paths.resourceRoot;
    if (resource) {
      const rootId = generateId(resource);
      const fileEntry = state.files[rootId];
      if (!fileEntry || (fileEntry.children && fileEntry.children.length === 0)) {
        // 异步启动扫描（不阻塞 UI）
        scanAndMerge(resource);
      }
    }

    // 主色调提取为纯手动功能：启动/进入主界面时不再自动启动
  };

  // 锟斤拷锟斤拷CSS锟斤拷锟斤拷锟皆匡拷锟斤拷锟斤拷母锟斤拷锟斤拷锟斤拷位锟斤拷
  useEffect(() => {
    // 锟斤拷锟斤拷CSS锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟侥可硷拷锟皆碉拷锟斤拷锟斤拷锟斤拷锟斤拷位锟斤拷
    document.documentElement.style.setProperty(
      '--metadata-panel-width',
      state.layout.isMetadataVisible ? '20rem' : '0rem'
    );
  }, [state.layout.isMetadataVisible]);

  // ... (keep dimension loading, folder expanding, theme, sort, etc.)


  // Lazy load dimensions when file is selected
  useEffect(() => {
    // 目前锟斤拷锟斤拷Tauri锟斤拷锟斤拷锟斤拷支锟斤拷锟接迟硷拷锟斤拷图片锟竭达拷
  }, [activeTab.selectedFileIds, activeTab.viewingFileId]);

  // Listen for scan progress and scan mode events emitted by backend
  useEffect(() => {
    let unlistenProgress: any;
    let unlistenMode: any;
    let isMounted = true;
    const setupListeners = async () => {
      try {
        unlistenProgress = await listen('scan-progress', (event: any) => {
          if (!isMounted) return;
          const payload = event.payload as { processed: number; total: number };
          setState(prev => ({ ...prev, scanProgress: { processed: payload.processed, total: payload.total } }));
        });
      } catch (e) {
        console.warn('Failed to listen for scan-progress', e);
      }

      try {
        unlistenMode = await listen('scan-mode', (event: any) => {
          if (!isMounted) return;
          const payload = event.payload as { mode: string; count?: number };
          const mode = payload.mode as 'cache' | 'full' | 'incremental';
          setState(prev => ({ ...prev, scanMode: mode, isScanning: mode !== 'cache' }));

          // If cache load, hide any progress UI
          if (mode === 'cache') {
            setState(prev => ({ ...prev, scanProgress: null }));
          }
        });
      } catch (e) {
        console.warn('Failed to listen for scan-mode', e);
      }

      try {
        await listen('metadata-updated', (event: any) => {
          if (!isMounted) return;
          const updatedEntries = event.payload as any[];
          if (!updatedEntries || !updatedEntries.length) return;

          setState(prev => {
            const nextFiles = { ...prev.files };
            let changed = false;

            updatedEntries.forEach(entry => {
              const fileId = entry.fileId;
              if (nextFiles[fileId]) {
                const current = nextFiles[fileId];
                // Only update if width/height changed from 0
                if (entry.width > 0 && entry.height > 0 && (!current.meta || current.meta.width === 0)) {
                  nextFiles[fileId] = {
                    ...current,
                    meta: {
                      ...current.meta,
                      width: entry.width,
                      height: entry.height,
                      format: entry.format || current.meta?.format || '',
                      sizeKb: (entry.size / 1024) || current.meta?.sizeKb || 0,
                    } as any
                  };
                  changed = true;
                }
              }
            });

            return changed ? { ...prev, files: nextFiles } : prev;
          });
        });
      } catch (e) {
        console.warn('Failed to listen for metadata-updated', e);
      }
    };

    setupListeners();
    return () => { isMounted = false; if (unlistenProgress) unlistenProgress(); if (unlistenMode) unlistenMode(); };
  }, []);

  useEffect(() => {
    const currentFolderId = activeTab.folderId;
    if (!currentFolderId) return;
    setState(prev => {
      const files = prev.files;
      if (!files[currentFolderId]) return prev;
      const ancestorsToExpand = new Set<string>();
      let curr = files[currentFolderId];
      while (curr && curr.parentId) { ancestorsToExpand.add(curr.parentId); curr = files[curr.parentId]; }
      if (ancestorsToExpand.size === 0) return prev;
      const existingExpanded = new Set(prev.expandedFolderIds);
      let changed = false;
      ancestorsToExpand.forEach(id => { if (!existingExpanded.has(id)) { existingExpanded.add(id); changed = true; } });
      if (!changed) return prev;
      return { ...prev, expandedFolderIds: Array.from(existingExpanded) };
    });
  }, [activeTab.folderId]);

  useEffect(() => {
    const root = window.document.documentElement;
    const applyTheme = () => {
      const theme = state.settings.theme;
      let isDark = false;
      if (theme === 'dark') isDark = true;
      else if (theme === 'light') isDark = false;
      else {
        if (window.matchMedia('(prefers-color-scheme: dark)').matches) isDark = true;
        else isDark = false;
      }
      if (isDark) root.classList.add('dark');
      else root.classList.remove('dark');
      setAndroidStatusBar(isDark);
    };
    applyTheme();
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => { if (state.settings.theme === 'system') applyTheme(); };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [state.settings.theme]);

  useEffect(() => {
    if (!isAndroidSync()) return;
    const orientationQuery = window.matchMedia('(orientation: portrait)');
    const handleOrientationChange = (e: MediaQueryListEvent) => {
      const isPortrait = e.matches;
      setState(prev => ({
        ...prev,
        layout: {
          ...prev.layout,
          isSidebarVisible: !isPortrait,
        }
      }));
    };
    orientationQuery.addEventListener('change', handleOrientationChange);
    return () => orientationQuery.removeEventListener('change', handleOrientationChange);
  }, []);

  useEffect(() => { setToolbarQuery(activeTab.searchQuery); }, [activeTab.id, activeTab.searchQuery]);

  const {
    contextMenu,
    setContextMenu,
    closeContextMenu,
    handleContextMenu
  } = useContextMenu({ state, activeTab, updateActiveTab });

  // 锟斤拷锟斤拷锟斤拷锟侥硷拷选锟斤拷锟斤拷示锟街撅拷锟斤拷拽锟斤拷示
  const selectedCount = activeTab.selectedFileIds.length;
  // 锟斤拷锟斤拷专锟斤拷锟斤拷图锟斤拷锟斤拷示锟斤拷锟斤拷示锟斤拷专锟斤拷锟斤拷图没锟斤拷锟斤拷拽锟斤拷锟解部锟斤拷锟竭硷拷锟斤拷
  // 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷未锟斤拷小锟斤拷锟侥猴拷台锟斤拷锟今弹达拷时锟斤拷锟斤拷示锟斤拷锟斤拷锟斤拷锟节碉拷锟斤拷锟今弹达拷锟斤拷
  const activeTaskCount = state.tasks.filter(t => !t.minimized).length;

  // 锟斤拷锟斤拷状态锟斤拷锟斤拷锟斤拷锟斤拷示锟斤拷锟斤拷示锟斤拷息
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  // 锟斤拷锟斤拷锟斤拷锟斤拷锟铰硷拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷示锟斤拷锟斤拷示
  const handleScroll = useCallback(() => {
    setIsScrolling(true);
    if (scrollTimeoutRef.current) {
      clearTimeout(scrollTimeoutRef.current);
    }
    scrollTimeoutRef.current = setTimeout(() => {
      setIsScrolling(false);
    }, 150);
  }, []);

  // 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷时锟斤拷锟斤拷锟斤拷锟绞憋拷锟斤拷
  useEffect(() => {
    return () => {
      if (scrollTimeoutRef.current) {
        clearTimeout(scrollTimeoutRef.current);
      }
    };
  }, []);

  // 锟叫断讹拷锟斤拷锟角凤拷锟斤拷要锟斤拷锟斤拷锟斤拷锟斤拷示锟斤拷示锟斤拷息锟斤拷模态锟斤拷锟斤拷锟斤拷时锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷时锟斤拷锟斤拷锟斤拷
  const isAndroidDevice = state.settings.paths.resourceRoot === 'android_media_store';

  const isModalOpen = state.activeModal.type !== null || state.isSettingsOpen;
  const showDragHint = selectedCount > 1 && activeTab.viewMode !== 'topics-overview' && activeTaskCount === 0 && !isScrolling && !isModalOpen && !isAndroidDevice;

  // Ref to share FileGrid layout data with marquee selection for DOM-free collision detection
  const fileGridLayoutRef = useRef<import('./hooks/useMarqueeSelection').LayoutItem[]>([]);

  const {
    isSelecting,
    overlayRef,
    selectionRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp
  } = useMarqueeSelection({
    activeTab,
    state,
    updateActiveTab,
    closeContextMenu,
    layoutRef: fileGridLayoutRef,
  });

  // Navigation handlers (moved to hook). Keep hook invocation here so required refs exist.
  const {
    pushHistory,
    enterFolder,
    enterViewer,
    goBack,
    goForward,
    handleSwitchTab,
    handleCloseTab,
    handleNewTab,
    handleOpenCompareInNewTab,
    setNavigationTimestamp
  } = useNavigation(state, setState, { selectionRef, activeTabRef }, setGroupBy);

  // LAN 客户端同步（连接恢复/根目录加载/重试/心跳/浏览/刷新/上传）
  const {
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
  } = useLanClientSync({ state, setState, activeTab, t, showToast, enterFolder });

  // 锟叫断讹拷锟斤拷锟角凤拷锟斤拷要锟斤拷锟斤拷锟斤拷锟斤拷示锟斤拷示锟斤拷息锟斤拷模态锟斤拷锟斤拷锟斤拷时锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷时锟斤拷锟斤拷锟斤拷
  const currentLanFolder = state.files[activeTab.folderId];
  const showLanUpload = isAndroidDevice && !!currentLanFolder && currentLanFolder.source === 'lan' && lanAllowUpload && !isUploading;

  const {
    displayFileIds,
    totalResults,
    pageSize,
    groupedFiles,
    collapsedGroups,
    toggleGroup,
    allFiles
  } = useFileSearch({ state, activeTab, groupBy, t });

  const handleEnterAndroidSelectionMode = useCallback((id: string) => {
    setIsAndroidSelectionMode(true);
    updateActiveTab({ selectedFileIds: [id], lastSelectedId: id });
  }, [updateActiveTab]);

  const handleExitAndroidSelectionMode = useCallback(() => {
    setIsAndroidSelectionMode(false);
    updateActiveTab({ selectedFileIds: [], lastSelectedId: null });
  }, [updateActiveTab]);

  const handleOpenCompareAndClearSelection = useCallback((imageIds: string[]) => {
    // 安卓端：限制为单个画布，先关闭所有现有比较模式 tab（避免无 TabBar UI 切换导致画布堆积）
    if (isAndroidPlatformCached()) {
      setState(prev => {
        const newTabs = prev.tabs.filter(t => !t.isCompareMode);
        // 若过滤后无 tab（异常情况），保留原 tabs 不动
        if (newTabs.length === 0) return prev;
        return { ...prev, tabs: newTabs };
      });
    }
    handleOpenCompareInNewTab(imageIds);
    if (isAndroidSelectionMode) {
      setIsAndroidSelectionMode(false);
    }
  }, [handleOpenCompareInNewTab, isAndroidSelectionMode, setState]);

  const handleDeselectAllAndroid = useCallback(() => {
    updateActiveTab({ selectedFileIds: [], lastSelectedId: null });
  }, [updateActiveTab]);

  const performDeleteFiles = useCallback((ids: string[], filesToDelete: any[], closeModal: boolean = false) => {
    setState(s => {
      const newFiles = { ...s.files };
      const filePaths: string[] = [];

      ids.forEach(id => {
        const file = newFiles[id];
        if (file) {
          if (file.path) filePaths.push(file.path);
          if (file.parentId && newFiles[file.parentId]) {
            const parent = newFiles[file.parentId];
            newFiles[file.parentId] = { ...parent, children: parent.children?.filter(cid => cid !== id) };
          }
          delete newFiles[id];
        }
      });

      const updatedTabs = s.tabs.map(t => ({
        ...t,
        selectedFileIds: t.selectedFileIds.filter(fid => !ids.includes(fid)),
        // 原生查看器激活时，删除当前 viewingFileId 不设为 null（保持原值），
        // 由原生查看器的 onNavigate 在下一次 JS 执行中更新到正确的下一张 fileId；
        // 否则 viewingFileId=null 会立即触发关闭原生查看器的 useEffect，
        // 导致原生查看器在 onNavigate 到达前就被关闭。
        viewingFileId: t.viewingFileId && ids.includes(t.viewingFileId)
          ? (nativeViewerActiveRef.current ? t.viewingFileId : null)
          : t.viewingFileId
      }));

      (async () => {
        try {
          for (const filePath of filePaths) {
            if (isTauriEnvironment()) {
              await deleteFile(filePath);
            }
          }
          try {
            const defaults = await tauriGetDefaultPaths();
            if (defaults.appDataDir) {
              await clearScanCache(defaults.appDataDir);
            }
          } catch (_) { /* cache clear is best-effort */ }
          showToast(t('context.deletedItems').replace('{count}', filesToDelete.length.toString()));
        } catch (err) {
          console.error('Delete failed:', err);
          try { showToast(t('errors.deleteFailed') || 'Delete failed'); } catch (_) { showToast('Delete failed'); }
        }
      })();

      const newState: any = { ...s, files: newFiles, tabs: updatedTabs };
      if (closeModal) newState.activeModal = { type: null };
      return newState;
    });
  }, [t, showToast]);

  const handleAndroidDelete = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const filesToDelete = ids.map(id => state.files[id]).filter(Boolean);
    if (filesToDelete.length === 0) return;

    setState(prev => ({
      ...prev,
      activeModal: {
        type: 'confirm-delete-file',
        data: {
          fileIds: ids,
          files: filesToDelete,
          onConfirm: async () => {
            performDeleteFiles(ids, filesToDelete, true);
            handleExitAndroidSelectionMode();
          },
          onCancel: () => {
            setState(s => ({ ...s, activeModal: { type: null } }));
          }
        }
      }
    }));
  }, [state.files, performDeleteFiles, handleExitAndroidSelectionMode]);

  // 原生查看器内已弹窗确认后的删除入口：直接执行删除流程，不再弹 ConfirmModal
  const handleAndroidDeleteConfirmed = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    const filesToDelete = ids.map(id => state.files[id]).filter(Boolean);
    if (filesToDelete.length === 0) return;
    performDeleteFiles(ids, filesToDelete, false);
  }, [state.files, performDeleteFiles]);

  // 触发原生文件夹选择弹窗：收集 state.files 中的所有文件夹节点，序列化为 JSON，调用 Tauri 命令
  const invokeAndroidFolderPicker = useCallback(async (type: 'copy' | 'move', fileId: string) => {
    const folders: Array<{ id: string; name: string; parentId: string | null; children: string[] }> = [];
    Object.values(state.files).forEach(file => {
      if (file.type === FileType.FOLDER) {
        folders.push({
          id: file.id,
          name: file.name,
          parentId: file.parentId ?? null,
          children: (file.children ?? []).filter(cid => state.files[cid]?.type === FileType.FOLDER),
        });
      }
    });
    const folderTreeJson = JSON.stringify({ roots: state.roots, folders });
    try {
      await invoke('android_show_folder_picker', { pickerType: type, fileId, folderTreeJson });
    } catch (e) {
      console.error('[NativeViewer] invoke android_show_folder_picker failed:', e);
    }
  }, [state.files, state.roots]);
  const invokeAndroidFolderPickerRef = useRef(invokeAndroidFolderPicker);
  invokeAndroidFolderPickerRef.current = invokeAndroidFolderPicker;

  const handleFolderSelect = useCallback((id: string) => {
    if (!isAndroidSelectionMode) return;
    if (activeTab.selectedFileIds.includes(id)) {
      updateActiveTab({
        selectedFileIds: activeTab.selectedFileIds.filter(fileId => fileId !== id),
        lastSelectedId: id
      });
    } else {
      updateActiveTab({
        selectedFileIds: [...activeTab.selectedFileIds, id],
        lastSelectedId: id
      });
    }
  }, [isAndroidSelectionMode, activeTab, updateActiveTab]);

  const handleFolderLongPress = useCallback((id: string) => {
    if (!isAndroidDevice) return;
    handleEnterAndroidSelectionMode(id);
  }, [isAndroidDevice, handleEnterAndroidSelectionMode]);

  const handleFolderAndroidRangeSelect = useCallback((id: string) => {
    if (!isAndroidDevice || !isAndroidSelectionMode) return;
    const folderIds = state.roots
      .map(rid => state.files[rid])
      .filter((f): f is typeof state.files[string] => !!f && f.type === 'folder')
      .sort((a, b) => {
        const countA = a.imageCount ?? a.children?.length ?? 0;
        const countB = b.imageCount ?? b.children?.length ?? 0;
        return countB - countA;
      })
      .map(f => f.id);
    if (activeTab.lastSelectedId && activeTab.selectedFileIds.length > 0) {
      const lastIndex = folderIds.indexOf(activeTab.lastSelectedId);
      const currentIndex = folderIds.indexOf(id);
      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const rangeIds = folderIds.slice(start, end + 1);
        const merged = [...new Set([...activeTab.selectedFileIds, ...rangeIds])];
        updateActiveTab({
          selectedFileIds: merged,
          lastSelectedId: id
        });
      } else {
        updateActiveTab({
          selectedFileIds: [...activeTab.selectedFileIds, id],
          lastSelectedId: id
        });
      }
    } else {
      updateActiveTab({
        selectedFileIds: [...activeTab.selectedFileIds, id],
        lastSelectedId: id
      });
    }
  }, [isAndroidDevice, isAndroidSelectionMode, state.roots, state.files, activeTab, updateActiveTab]);

  const handleShowContextMenuForFile = useCallback((id: string, x: number, y: number) => {
    const file = state.files[id];
    if (!file) return;

    if (activeTab.selectedFileIds.includes(id) && activeTab.selectedFileIds.length > 1) {
      const selectedItems = activeTab.selectedFileIds.map(fileId => state.files[fileId]);
      const allAreFolders = selectedItems.every(item => item && item.type === FileType.FOLDER);
      const allAreFiles = selectedItems.every(item => item && item.type !== FileType.FOLDER);

      let menuType: 'file-multi' | 'folder-multi';
      if (allAreFolders) {
        menuType = 'folder-multi';
      } else {
        menuType = 'file-multi';
      }
      setContextMenu({ visible: true, x, y, type: menuType, targetId: id, source: 'long-press' });
    } else {
      const menuType = file.type === FileType.FOLDER ? 'folder-single' : 'file-single';
      setContextMenu({ visible: true, x, y, type: menuType, targetId: id, source: 'long-press' });
    }
  }, [state.files, activeTab.selectedFileIds, setContextMenu]);

  const { handleFileClick, handleFileLongPress, handleAndroidRangeSelect } = useFileSelection({
    activeTab, displayFileIds, closeContextMenu, isSelecting, updateActiveTab,
    isAndroid: isAndroidDevice,
    isAndroidSelectionMode,
    onOpenFile: (id) => state.files[id]?.type === FileType.FOLDER ? handleNavigateFolder(id) : enterViewer(id),
    onEnterAndroidSelectionMode: handleEnterAndroidSelectionMode,
  });







  const groupedTags: Record<string, string[]> = useMemo(() => {
    const allTags = new Set<string>(state.customTags);
    (Object.values(state.files) as FileNode[]).forEach(f => f.tags.forEach(t => allTags.add(t)));
    const filteredTags = Array.from(allTags).filter(t => !tagSearchQuery || t.toLowerCase().includes(tagSearchQuery.toLowerCase()));
    const groups: Record<string, string[]> = {};
    filteredTags.forEach(tag => {
      const key = getPinyinGroup(tag);
      if (!groups[key]) groups[key] = [];
      groups[key].push(tag);
    });
    const sortedKeys = Object.keys(groups).sort();
    return sortedKeys.reduce((obj, key) => {
      obj[key] = groups[key].sort((a, b) => a.localeCompare(b, state.settings.language));
      return obj;
    }, {} as Record<string, string[]>);
  }, [filesVersion, state.settings.language, state.customTags, tagSearchQuery, state.files]);

  const {
    isCreatingTag, requestDeleteTags, handleConfirmDeleteTags,
    handleCopyTags, handlePasteTags, handleCreateNewTag,
    handleSaveNewTag, handleCancelCreateTag, handleOverviewTagClick,
    handleTagClick, handleRenameTag, handleClearTagFilter, handleClearAllTags,
  } = useTags({
    state, setState, activeTab, t, showToast, groupedTags,
    closeContextMenu, updateActiveTab,
  });
  // Memoized person counts to avoid recalculating every time
  const personCounts = useMemo(() => {
    const timer = performance.now();
    const counts = new Map<string, number>();

    // Initialize all people with 0 count
    Object.keys(state.people).forEach(personId => {
      counts.set(personId, 0);
    });

    // Build a map from characterTagName to personId for faster lookup
    const tagToPersonId = new Map<string, string>();
    Object.values(state.people).forEach(person => {
      if (person.characterTagName) {
        tagToPersonId.set(person.characterTagName, person.id);
      }
    });

    // Count files per person
    Object.values(state.files).forEach(file => {
      if (file.type === FileType.IMAGE) {
        const personIds = new Set<string>();
        
        // Count from faces (face recognition)
        if (file.aiData?.faces) {
          file.aiData.faces.forEach(face => {
            if (face.personId) {
              personIds.add(face.personId);
            }
          });
        }
        
        // Count from WD14 tags (stored in file.tags)
        if (file.tags && file.tags.length > 0) {
          file.tags.forEach(tag => {
            const personId = tagToPersonId.get(tag);
            if (personId) {
              personIds.add(personId);
            }
          });
        }
        
        personIds.forEach(personId => {
          counts.set(personId, (counts.get(personId) || 0) + 1);
        });
      }
    });

    const duration = performance.now() - timer;
    performanceMonitor.timing('personCounts', duration, {
      personCount: Object.keys(state.people).length,
      fileCount: Object.keys(state.files).length
    });

    return counts;
  }, [filesVersion, state.people]);

  // Use a derived people object for UI that always has the correct counts based on files metadata
  const peopleWithDisplayCounts = useMemo(() => {
    const updatedPeople: Record<string, Person> = {};
    Object.keys(state.people).forEach(personId => {
      updatedPeople[personId] = {
        ...state.people[personId],
        count: personCounts.get(personId) || 0
      };
    });
    return updatedPeople;
  }, [state.people, personCounts]);

  // When in people-overview, allow filtering the people list by `personSearchQuery`.
  const peopleForOverview = useMemo(() => {
    if (activeTab.viewMode === 'people-overview' && personSearchQuery) {
      const q = personSearchQuery.toLowerCase();
      return Object.fromEntries(Object.entries(peopleWithDisplayCounts).filter(([, p]) => p.name.toLowerCase().includes(q)));
    }
    return peopleWithDisplayCounts;
  }, [peopleWithDisplayCounts, activeTab.viewMode, personSearchQuery]);

  usePersistence({ state, peopleWithDisplayCounts });

  const handleUpdateFile = (id: string, updates: Partial<FileNode>) => {
    setState(prev => {
      const updatedFiles = { ...prev.files, [id]: { ...prev.files[id], ...updates } };
      let updatedPeople = prev.people;

      // Check if we're updating aiData.faces
      if (updates.aiData?.faces || (updates.aiData && prev.files[id].aiData?.faces)) {
        updatedPeople = { ...prev.people };

        // Get the current and previous faces
        const currentFaces = updatedFiles[id].aiData?.faces || [];
        const prevFaces = prev.files[id].aiData?.faces || [];

        // Get person IDs from current and previous faces
        const currentPersonIds = new Set(currentFaces.map(face => face.personId));
        const prevPersonIds = new Set(prevFaces.map(face => face.personId));

        // Find added and removed person IDs
        const addedPersonIds = Array.from(currentPersonIds).filter(personId => !prevPersonIds.has(personId));
        const removedPersonIds = Array.from(prevPersonIds).filter(personId => !currentPersonIds.has(personId));

        // Update counts for all affected people
        const allAffectedPersonIds = new Set([...addedPersonIds, ...removedPersonIds]);

        // Create a copy of the current counts
        const currentCounts = new Map(personCounts);

        allAffectedPersonIds.forEach(personId => {
          let newCount = currentCounts.get(personId) || 0;

          // Adjust count based on changes
          if (addedPersonIds.includes(personId)) {
            newCount += 1;
          }
          if (removedPersonIds.includes(personId)) {
            newCount = Math.max(0, newCount - 1);
          }

          // Update the person's count and cover file if needed
          if (updatedPeople[personId]) {
            const updatedPerson = { ...updatedPeople[personId], count: newCount };

            // If person doesn't have a cover file and has a face in current file, set current file as cover
            if (!updatedPerson.coverFileId && currentPersonIds.has(personId)) {
              updatedPerson.coverFileId = id;

              // Find the first face for this person in current file
              const faceForPerson = currentFaces.find(face => face.personId === personId);
              if (faceForPerson?.box && faceForPerson.box.w > 0 && faceForPerson.box.h > 0) {
                updatedPerson.faceBox = faceForPerson.box;
              }
            }

            updatedPeople[personId] = updatedPerson;
          }
        });
      }

      // 持久化到数据库
      if (updates.tags || updates.description || updates.sourceUrl || updates.aiData || updates.category !== undefined) {
        const file = prev.files[id];
        if (file) {
          const mergedFile = { ...file, ...updates };
          dbUpsertFileMetadata({
            fileId: id,
            path: mergedFile.path,
            tags: mergedFile.tags,
            description: mergedFile.description,
            sourceUrl: mergedFile.sourceUrl,
            category: mergedFile.category,
            aiData: mergedFile.aiData,
            updatedAt: Date.now()
          }).catch(err => console.error('Failed to persist file metadata:', err));
        }
      }

      return { ...prev, files: updatedFiles, people: updatedPeople };
    });
  };

  const { handleOpenFolder, scanAndMerge, handleRefresh, handleRefreshTags, handleChangePath } = useDirectoryScan({
    state, setState, activeTab, t, showToast, startTask, updateTask,
  });

  const {
    handleCopyFiles, handleMoveFiles, handleExternalCopyFiles, handleExternalMoveFiles,
    handleDropOnFolder, handleBatchRename, handleAIBatchRename, handleRenameSubmit, requestDelete,
    undoDelete, dismissDelete, handleCreateFolder, deletionTasks
  } = useFileOperations({
    state, setState, activeTab, t, showToast, startTask, updateTask,
    handleRefresh, handleUpdateFile, displayFileIds
  });

  const { handleAIAnalysis, handleFolderAIAnalysis } = useAIAnalysis({
    files: state.files,
    people: state.people,
    settings: state.settings,
    startTask,
    updateTask,
    setState,
    t,
    showToast
  });

  const {
    isClipSearchEnabled, setIsClipSearchEnabled, clipLoading,
    performAiSearch, onPerformSearch, handlePerformSearch, handleViewerSearch,
    handleSearchSimilarImages, handleClipEnabledChange, openClipSettings,
  } = useSearch({
    state, setState, activeTab, t, showToast, startTask, updateTask,
    pushHistory, updateActiveTab,
  });

  const {
    isExternalDragging, externalDragItems, externalDragPosition,
    handleExternalDragEnter, handleExternalDragOver,
    handleExternalDragLeave, handleExternalDrop,
  } = useExternalDragDrop({ isDraggingInternal, hoveredDropAction, handleExternalCopyFiles, handleExternalMoveFiles });


  // Helper function to limit concurrency
  // Moved to src/utils/async.ts

  const handleCopyImageToClipboard = async (fileId: string) => {
    const file = state.files[fileId];
    if (!file || file.type !== FileType.IMAGE) return;
    try {
      await copyImageToClipboard(file.path);
      showToast(t('context.imageCopied'));
    } catch (error) {
      console.error('Failed to copy image to clipboard:', error);
      showToast(t('context.imageCopyFailed') || '复制图片失败');
    }
  };


  const handleDropOnTag = (tag: string, sourceIds: string[]) => { /* ... */ };
  const startRename = (id: string) => setState(s => ({ ...s, renamingId: id }));
  const handleResolveExtensionChange = (id: string, name: string) => handleUpdateFile(id, { name });
  const handleResolveFileCollision = (fileId: string, desiredName: string) => { /* ... */ };
  const handleResolveFolderMerge = (sourceId: string, targetId: string) => { /* ... */ };






















  // Handle close confirmation actions

  // Enhanced handleClearPersonInfo to support selective clearing









  // Navigation helpers
  const handleOpenInNewTab = useCallback((fileId: string) => {
    const file = state.files[fileId];
    if (!file) return;
    const isFolder = file.type === FileType.FOLDER;
    const targetFolderId = isFolder ? fileId : (file.parentId || fileId);
    const targetViewingId = isFolder ? null : fileId;

    // Check for folder-specific settings, otherwise use global defaults
    const savedFolderSettings = state.folderSettings[targetFolderId];
    const globalSettings = state.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS;

    const layoutMode = savedFolderSettings?.layoutMode || globalSettings.layoutMode;
    const sortBy = savedFolderSettings?.sortBy || globalSettings.sortBy;
    const sortDirection = savedFolderSettings?.sortDirection || globalSettings.sortDirection;
    const groupBySetting = savedFolderSettings?.groupBy || globalSettings.groupBy;

    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: targetFolderId,
      viewingFileId: targetViewingId,
      layoutMode: layoutMode as any,
      selectedFileIds: [fileId],
      lastSelectedId: fileId,
      isCompareMode: false,
      history: { stack: [{ folderId: targetFolderId, viewingId: targetViewingId, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }
    };

    // Apply groupBy and sort settings
    setGroupBy(groupBySetting as any);
    setState(prev => ({
      ...prev,
      tabs: [...prev.tabs, newTab],
      activeTabId: newTab.id,
      sortBy: sortBy,
      sortDirection: sortDirection
    }));
  }, [state.files, state.folderSettings, state.settings.defaultLayoutSettings, setState]);

  const handleNavigateToFile = useCallback((filePath: string) => {
    const fileEntry = Object.values(state.files).find(f => f.path === filePath);
    if (!fileEntry) return;
    const folderId = fileEntry.parentId || fileEntry.id;
    const fileId = fileEntry.id;
    setState(prev => ({ ...prev, isSettingsOpen: false }));
    pushHistory(folderId, null, 'browser', '', 'all', [], null, 0, null, null, [], [], fileId);
  }, [state.files, setState, pushHistory]);

  const handleOpenTopicInNewTab = useCallback((topicId: string) => {
    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: state.roots[0] || '',
      viewMode: 'topics-overview',
      activeTopicId: topicId,
      selectedTopicIds: [topicId],
      isCompareMode: false,
      history: { stack: [{ folderId: state.roots[0] || '', viewingId: null, viewMode: 'topics-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }
    };
    setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  }, [state.roots, setState]);

  const handleOpenPersonInNewTab = useCallback((personId: string) => {
    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: state.roots[0] || '',
      viewMode: 'people-overview',
      activePersonId: personId,
      selectedPersonIds: [personId],
      isCompareMode: false,
      history: { stack: [{ folderId: state.roots[0] || '', viewingId: null, viewMode: 'people-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: personId }], currentIndex: 0 }
    };
    setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  }, [state.roots, setState]);

  const handleOpenCanvas = useCallback(() => {
    // 生成新的画布名称
    const generateCanvasName = () => {
      const existingNames = state.tabs
        .filter(tab => tab.isCompareMode)
        .map(tab => tab.sessionName)
        .filter((name): name is string => !!name);

      let maxNum = 0;
      existingNames.forEach(name => {
        const match = name.match(/^画布(\d+)$/);
        if (match) {
          maxNum = Math.max(maxNum, parseInt(match[1], 10));
        }
      });

      return `画布${String(maxNum + 1).padStart(2, '0')}`;
    };

    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: state.roots[0] || '',
      selectedFileIds: [],
      isCompareMode: true,
      sessionName: generateCanvasName(),
      history: {
        stack: [{
          folderId: state.roots[0] || '',
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
    setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  }, [state.roots, state.tabs, setState]);

  /* pushHistory: delegated to `useNavigation` (see src/hooks/useNavigation.ts) */




  // 锟斤拷锟斤拷锟侥硷拷锟叫变化锟斤拷锟皆讹拷应锟矫憋拷锟斤拷锟斤拷锟斤拷锟?
  // 使锟斤拷 ref 锟斤拷锟斤拷锟解将 folderSettings 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷循锟斤拷
  const folderSettingsRef = useRef(state.folderSettings);
  // Guard to prevent overwriting saved folder settings during initial load
  const savedDataLoadedRef = useRef(false);
  const [savedDataLoaded, setSavedDataLoaded] = useState(false);

  useAppInit({
    state, setState, savedDataLoadedRef, setSavedDataLoaded,
    setIsLoading, setShowSplash, setShowWelcome, setLoadingInfo, exitActionRef, setGroupBy,
  });

  const { handleRememberFolderSettings } = useFolderSettings({
    state, setState, activeTab, groupBy, setGroupBy,
    updateActiveTab, savedDataLoaded, showToast, t,
  });

  useEffect(() => {
    folderSettingsRef.current = state.folderSettings;
  }, [state.folderSettings]);

  useEffect(() => {
    // Wait until saved data is loaded before applying saved folder settings
    if (!savedDataLoaded) return;
    if (activeTab.viewMode !== 'browser') return;
    const folderId = activeTab.folderId;
    const savedSettings = folderSettingsRef.current[folderId];

    if (savedSettings) {
      // Only apply if current tab differs from saved settings
      let hasChanges = false;
      if (activeTab.layoutMode !== savedSettings.layoutMode) hasChanges = true;
      if (state.sortBy !== savedSettings.sortBy) hasChanges = true;
      if (state.sortDirection !== savedSettings.sortDirection) hasChanges = true;
      if (groupBy !== savedSettings.groupBy) hasChanges = true;

      if (hasChanges) {
        console.debug('[FolderSettings] Applying saved settings for folder', folderId, savedSettings);
        setState(prev => ({
          ...prev,
          sortBy: savedSettings.sortBy,
          sortDirection: savedSettings.sortDirection,
        }));
        setGroupBy(savedSettings.groupBy);
        updateActiveTab({ layoutMode: savedSettings.layoutMode });
      }
    }
  }, [activeTab.folderId, activeTab.id, activeTab.viewMode, savedDataLoaded]);

  // 锟斤拷锟斤拷锟斤拷锟矫变化锟斤拷同锟斤拷锟斤拷锟斤拷锟窖憋拷锟斤拷锟斤拷募锟斤拷锟斤拷锟斤拷锟?
  useEffect(() => {
    // Prevent overwriting saved folder settings during initial data load
    if (!savedDataLoaded) return;

    if (activeTab.viewMode !== 'browser') return;
    const folderId = activeTab.folderId;
    const saved = state.folderSettings[folderId];

    if (saved) {
      const currentSettings = {
        layoutMode: activeTab.layoutMode,
        sortBy: state.sortBy,
        sortDirection: state.sortDirection,
        groupBy: groupBy
      };

      if (
        saved.layoutMode !== currentSettings.layoutMode ||
        saved.sortBy !== currentSettings.sortBy ||
        saved.sortDirection !== currentSettings.sortDirection ||
        saved.groupBy !== currentSettings.groupBy
      ) {
        setState(prev => ({
          ...prev,
          folderSettings: {
            ...prev.folderSettings,
            [folderId]: currentSettings
          }
        }));
      }
    }
  }, [activeTab.layoutMode, state.sortBy, state.sortDirection, groupBy, activeTab.folderId, activeTab.viewMode, state.folderSettings, savedDataLoaded]);

  /* enterFolder: delegated to `useNavigation` */

  const handleNavigateFolder = useCallback((id: string, options?: { targetId?: string, resetScroll?: boolean }) => {
    closeContextMenu();
    if (activeTabRef.current.isCompareMode) {
      handleOpenInNewTab(id);
    } else {
      enterFolder(id, { scrollToItemId: options?.targetId, resetScroll: options?.resetScroll });
    }
  }, [closeContextMenu, enterFolder, handleOpenInNewTab]);

  /* handleOpenCompareInNewTab: delegated to `useNavigation` */

  // 添加图片到现有的图片对比画布
  const handleAddToCompareCanvas = useCallback(async (tabId: string, imageIds: string[]) => {
    const targetTab = state.tabs.find(t => t.id === tabId);
    if (!targetTab || !targetTab.isCompareMode) return;

    const currentCount = targetTab.selectedFileIds.length;
    const maxCount = 24;
    const remainingSpace = maxCount - currentCount;

    if (remainingSpace <= 0) {
      showToast(t('context.canvasFull') || '画布已满');
      return;
    }

    // 只添加能容纳的图片
    let idsToAdd = imageIds.slice(0, remainingSpace);

    // 处理 LAN 来源图片：先下载到本地缓存，再以本地节点加入画布
    const lanIds = idsToAdd.filter(id => state.files[id]?.source === 'lan' && state.files[id]?.remotePath);
    if (lanIds.length > 0) {
      const cacheRoot = state.settings.paths.cacheRoot;
      if (!cacheRoot) {
        showToast(t('lanClient.downloadNoCache') || '缓存目录未配置，无法下载桌面图片');
        return;
      }
      const remotePaths = lanIds.map(id => state.files[id].remotePath!);
      setLanDownloadProgress({ active: true, completed: 0, total: lanIds.length });
      try {
        const results = await downloadLanImagesBatched(remotePaths, cacheRoot, (completed, total) => {
          setLanDownloadProgress({ active: true, completed, total });
        });

        // 为下载成功的图片创建本地 FileNode（复制 LAN 节点信息，改写路径与来源）
        const newLocalNodes: Record<string, FileNode> = {};
        const idMap: Record<string, string> = {};
        let failedCount = 0;
        results.forEach((res, idx) => {
          const lanId = lanIds[idx];
          const lanFile = state.files[lanId];
          if (res.success && lanFile) {
            const newId = generateId(res.localPath);
            newLocalNodes[newId] = {
              ...lanFile,
              id: newId,
              path: res.localPath,
              source: 'local',
              remotePath: undefined,
              parentId: null,
            };
            idMap[lanId] = newId;
          } else {
            failedCount++;
          }
        });

        // 合并本地节点到 state.files
        if (Object.keys(newLocalNodes).length > 0) {
          setState(prev => ({
            ...prev,
            files: { ...prev.files, ...newLocalNodes },
          }));
        }

        // 用新的本地 id 替换 LAN id；下载失败的 LAN id 予以剔除
        idsToAdd = idsToAdd
          .map(id => idMap[id] || id)
          .filter(id => !lanIds.includes(id) || idMap[id]);

        if (failedCount > 0) {
          showToast((t('lanClient.downloadPartialFail') || '部分桌面图片下载失败：{count} 张').replace('{count}', String(failedCount)));
        }
      } catch (err) {
        console.error('[LAN] Download failed:', err);
        showToast(t('lanClient.downloadFailed') || '下载桌面图片失败');
        // 下载整体失败时剔除所有 LAN id，仅添加本地图片
        idsToAdd = idsToAdd.filter(id => !lanIds.includes(id));
      } finally {
        setLanDownloadProgress({ active: false, completed: 0, total: 0 });
      }
    }

    const actuallyAdded = idsToAdd.length;
    if (actuallyAdded === 0) return;

    const sourceTabId = state.activeTabId;

    setState(prev => ({
      ...prev,
      activeTabId: tabId,
      tabs: prev.tabs.map(tab =>
        tab.id === tabId
          ? { ...tab, selectedFileIds: [...tab.selectedFileIds, ...idsToAdd] }
          : tab.id === sourceTabId
            ? { ...tab, selectedFileIds: [], lastSelectedId: null }
            : tab
      )
    }));

    // 退出 Android 多选模式
    if (isAndroidSelectionMode) {
      setIsAndroidSelectionMode(false);
    }

    // 显示提示
    if (actuallyAdded < imageIds.length) {
      showToast(t('context.partiallyAdded')?.replace('{added}', String(actuallyAdded)).replace('{total}', String(imageIds.length)) || `已添加 ${actuallyAdded}/${imageIds.length} 张图片（画布已满）`);
    } else {
      showToast(t('context.addedToCanvas') || '已添加到画布');
    }
  }, [state.tabs, state.files, state.settings.paths.cacheRoot, setState, showToast, t]);

  const handleNavigateTopic = useCallback((topicId: string | null) => {
    pushHistory(activeTab.folderId, null, 'topics-overview', '', 'all', [], null, 0, null, topicId, topicId ? [topicId] : []);
  }, [activeTab.folderId, pushHistory]);

  const handleNavigatePerson = useCallback((personId: string | null) => {
    pushHistory(activeTab.folderId, null, 'people-overview', '', 'all', [], null, 0, null, null, [], personId ? [personId] : []);
  }, [activeTab.folderId, pushHistory]);

  const handleNavigateTopics = useCallback(() => {
    if (activeTabRef.current.isCompareMode) {
      const newTab: TabState = {
        ...DUMMY_TAB,
        id: Math.random().toString(36).substr(2, 9),
        folderId: activeTabRef.current.folderId,
        viewMode: 'topics-overview',
        history: { stack: [{ folderId: activeTabRef.current.folderId, viewingId: null, viewMode: 'topics-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }
      };
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
    } else {
      handleNavigateTopic(null);
    }
  }, [handleNavigateTopic, setState]);

  const {
    handleSmartCreateTopic, handleManualAddToTopic,
    handleCreateTopic, handleUpdateTopic, handleDeleteTopic, handleCreateRootTopic,
  } = useTopics({
    state, setState, activeTab, t, showToast, handleNavigateTopics,
  });





  const handleToggleFolder = useCallback((id: string) => {
    setState(prev => {
      const isCurrentlyExpanded = prev.expandedFolderIds.includes(id);
      const newExpandedIds = isCurrentlyExpanded
        ? prev.expandedFolderIds.filter(fid => fid !== id)
        : [...prev.expandedFolderIds, id];

      // 锟斤拷锟斤拷锟斤拷锟斤拷欠锟斤拷锟侥凤拷锟斤拷锟剿变化 - 锟饺较筹拷锟饺猴拷锟斤拷锟斤拷
      if (newExpandedIds.length === prev.expandedFolderIds.length &&
        newExpandedIds.every(id => prev.expandedFolderIds.includes(id))) {
        return prev;
      }

      return {
        ...prev,
        expandedFolderIds: newExpandedIds
      };
    });
  }, []);

  const toggleSettings = useCallback(() => setState(s => ({ ...s, isSettingsOpen: !s.isSettingsOpen })), []);

  /* goBack / goForward / setNavigationTimestamp: delegated to `useNavigation` (see src/hooks/useNavigation.ts) */

  const closeViewer = () => {
    const currentScroll = selectionRef.current?.scrollTop || 0;
    if (activeTab.history.stack[activeTab.history.currentIndex].viewingId) {
      logInfo('[App] closeViewer.pop', { action: 'closeViewer', mode: 'pop', container: 'main', containerScroll: currentScroll });
      pushHistory(activeTab.folderId, null, activeTab.viewMode as any, activeTab.searchQuery, activeTab.searchScope, activeTab.activeTags, activeTab.activePersonId, activeTab.scrollTop, activeTab.aiFilter, activeTab.activeTopicId);
    } else {
      logInfo('[App] closeViewer.clear', { action: 'closeViewer', mode: 'clear', container: 'main', containerScroll: currentScroll });
      updateActiveTab({ viewingFileId: null });
    }
  };

  /* enterViewer: delegated to `useNavigation` */

  // Toggle helpers for sidebars
  const toggleSidebar = () => {
    const next = !state.layout.isSidebarVisible;
    if (isAndroidSync() && next && (state.layout.isMetadataVisible || state.layout.isColorPickerVisible)) {
      setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: next, isMetadataVisible: false, isColorPickerVisible: false } }));
    } else {
      setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: next } }));
    }
  };

  const toggleMetadata = () => {
    const next = !state.layout.isMetadataVisible;
    if (isAndroidSync() && next && (state.layout.isSidebarVisible || state.layout.isColorPickerVisible)) {
      setState(s => ({ ...s, layout: { ...s.layout, isMetadataVisible: next, isSidebarVisible: false, isColorPickerVisible: false } }));
    } else {
      setState(s => ({ ...s, layout: { ...s.layout, isMetadataVisible: next } }));
    }
  };

  // Android 端颜色选择器面板切换（与 sidebar/metadata 互斥）
  const toggleColorPicker = () => {
    const next = !state.layout.isColorPickerVisible;
    if (isAndroidSync() && next && (state.layout.isSidebarVisible || state.layout.isMetadataVisible)) {
      setState(s => ({ ...s, layout: { ...s.layout, isColorPickerVisible: next, isSidebarVisible: false, isMetadataVisible: false } }));
    } else {
      setState(s => ({ ...s, layout: { ...s.layout, isColorPickerVisible: next } }));
    }
  };

  const onLayoutToggle = (part: 'sidebar' | 'metadata') => {
    if (part === 'sidebar') toggleSidebar(); else toggleMetadata();
  };

  // Track layout state changes (sidebar / metadata / colorPicker)
  const prevLayoutRef = useRef(state.layout);
  useEffect(() => {
    prevLayoutRef.current = state.layout;
  }, [state.layout.isSidebarVisible, state.layout.isMetadataVisible, state.layout.isColorPickerVisible]);

  const handleViewerNavigate = (direction: 'next' | 'prev' | 'random') => {
    if (!activeTab.viewingFileId) return;

    // Filter to get only image file IDs
    const imageFileIds = displayFileIds.filter(id => state.files[id].type === FileType.IMAGE);
    if (imageFileIds.length === 0) return;

    const currentFile = state.files[activeTab.viewingFileId];
    let currentIndex = imageFileIds.indexOf(activeTab.viewingFileId);

    // If current file is not in image list (shouldn't happen), start from beginning
    if (currentIndex === -1) {
      currentIndex = 0;
    }

    let nextIndex = currentIndex;
    if (direction === 'random') {
      nextIndex = Math.floor(Math.random() * imageFileIds.length);
    } else if (direction === 'next') {
      nextIndex = (currentIndex + 1) % imageFileIds.length;
    } else {
      nextIndex = (currentIndex - 1 + imageFileIds.length) % imageFileIds.length;
    }

    const nextId = imageFileIds[nextIndex];
    updateActiveTab(prev => {
      const newStack = [...prev.history.stack];
      if (prev.history.currentIndex >= 0 && prev.history.currentIndex < newStack.length) {
        newStack[prev.history.currentIndex] = { ...newStack[prev.history.currentIndex], viewingId: nextId };
      }
      return { viewingFileId: nextId, selectedFileIds: [nextId], lastSelectedId: nextId, history: { ...prev.history, stack: newStack } };
    });
  };
  const handleViewerJump = (fileId: string) => {
    updateActiveTab(prev => {
      const newStack = [...prev.history.stack];
      if (prev.history.currentIndex >= 0 && prev.history.currentIndex < newStack.length) {
        newStack[prev.history.currentIndex] = { ...newStack[prev.history.currentIndex], viewingId: fileId };
      }
      return { viewingFileId: fileId, selectedFileIds: [fileId], lastSelectedId: fileId, history: { ...prev.history, stack: newStack } };
    });
  };


  // 锟芥换 App.tsx 锟叫碉拷 onPerformSearch


  const enterTagView = useCallback((tagName: string) => {
    if (activeTabRef.current.isCompareMode) {
      const newTab: TabState = {
        ...DUMMY_TAB,
        id: Math.random().toString(36).substr(2, 9),
        folderId: activeTabRef.current.folderId,
        viewMode: 'browser',
        searchScope: 'tag',
        activeTags: [tagName],
        history: { stack: [{ folderId: activeTabRef.current.folderId, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'tag', activeTags: [tagName], activePersonId: null }], currentIndex: 0 }
      };
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'browser', '', 'tag', [tagName], null, 0);
    }
  }, [pushHistory, setState]);


  const enterTagsOverview = useCallback(() => {
    if (activeTabRef.current.isCompareMode) {
      const newTab: TabState = {
        ...DUMMY_TAB,
        id: Math.random().toString(36).substr(2, 9),
        folderId: activeTabRef.current.folderId,
        viewMode: 'tags-overview',
        history: { stack: [{ folderId: activeTabRef.current.folderId, viewingId: null, viewMode: 'tags-overview', searchQuery: activeTabRef.current.searchQuery, searchScope: activeTabRef.current.searchScope, activeTags: activeTabRef.current.activeTags, activePersonId: null }], currentIndex: 0 }
      };
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'tags-overview', activeTabRef.current.searchQuery, activeTabRef.current.searchScope, activeTabRef.current.activeTags, null, 0);
    }
  }, [pushHistory, setState]);

  let enterPeopleOverview: () => void;

  enterPeopleOverview = useCallback(() => {
    if (activeTabRef.current.isCompareMode) {
      const newTab: TabState = {
        ...DUMMY_TAB,
        id: Math.random().toString(36).substr(2, 9),
        folderId: activeTabRef.current.folderId,
        viewMode: 'people-overview',
        history: { stack: [{ folderId: activeTabRef.current.folderId, viewingId: null, viewMode: 'people-overview', searchQuery: activeTabRef.current.searchQuery, searchScope: activeTabRef.current.searchScope, activeTags: activeTabRef.current.activeTags, activePersonId: null }], currentIndex: 0 }
      };
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'people-overview', activeTabRef.current.searchQuery, activeTabRef.current.searchScope, activeTabRef.current.activeTags, null, 0);
    }
  }, [pushHistory, setState]);

  const {
    handlePersonClick, handleRenamePerson, handleUpdatePerson,
    handleCreatePerson, handleConfirmCreatePerson,
    handleSmartCreatePerson, handleSmartAddToPerson,
    handleDeletePerson, handleManualAddPerson,
    handleClearPersonInfo, onStartRenamePerson,
    handleSetAvatar, handleOpenCropAvatar,
    handleSaveAvatarCrop, handleSaveAvatarCropForSmartCreate,
  } = usePeople({
    state, setState, activeTab, t, showToast,
    peopleWithDisplayCounts, personSortBy, personSortDirection,
    isSelecting, closeContextMenu, updateActiveTab, enterPeopleOverview,
  });

  const enterPersonView = useCallback((personId: string) => {
    if (activeTabRef.current.isCompareMode) {
      handleOpenPersonInNewTab(personId);
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'browser', '', 'all', [], personId, 0);
    }
  }, [pushHistory, handleOpenPersonInNewTab]);

  const handleClearPersonFilter = () => updateActiveTab({ activePersonId: null });

  const handleNavigateHome = useCallback(() => {
    pushHistory('__android_folders_root__', null, 'folders-overview', '', 'all', [], null, 0);
  }, [pushHistory]);

  const handleNavigateNetworkHome = useCallback(() => {
    if (!lanConnected) {
      handleOpenLanSettings();
      return;
    }
    pushHistory('__lan_folders_root__', null, 'lan-folders-overview', '', 'all', [], null, 0);
  }, [pushHistory, lanConnected, handleOpenLanSettings]);

  const handleNavigateUp = () => {
    if (activeTab.activeTopicId) {
      const currentTopic = state.topics[activeTab.activeTopicId];
      if (currentTopic) handleNavigateTopic(currentTopic.parentId || null);
    } else if (activeTab.activePersonId) {
      enterPeopleOverview();
    } else if (activeTab.viewMode === 'folders-overview') {
      return;
    } else if (activeTab.viewMode === 'lan-folders-overview') {
      return;
    } else if (activeTab.viewMode === 'people-overview' || activeTab.viewMode === 'tags-overview' || activeTab.viewMode === 'topics-overview') {
      const isAndroid = state.settings.paths.resourceRoot === 'android_media_store';
      if (isAndroid) {
        pushHistory('__android_folders_root__', null, 'folders-overview', '', 'all', [], null, 0);
      } else {
        enterFolder(activeTab.folderId);
      }
    } else {
      const current = state.files[activeTab.folderId];
      if (current && current.parentId) {
        enterFolder(current.parentId);
      } else if (current?.source === 'lan') {
        // LAN 子文件夹无父级时回到网络总览视图
        pushHistory('__lan_folders_root__', null, 'lan-folders-overview', '', 'all', [], null, 0);
      } else {
        const isAndroid = state.settings.paths.resourceRoot === 'android_media_store';
        if (isAndroid && activeTab.viewMode === 'browser') {
          pushHistory('__android_folders_root__', null, 'folders-overview', '', 'all', [], null, 0);
        }
      }
    }
  };
  const minimizeTask = (id: string) => updateTask(id, { minimized: true });
  const onRestoreTask = (id: string) => updateTask(id, { minimized: false });

  const onPauseResume = async (id: string, taskType: string) => {
    if (taskType !== 'color') return;

    const task = tasks.find(t => t.id === id);
    if (!task) return;

    if (task.status === 'paused') {
      await resumeColorExtraction();
      const now = Date.now();
      updateTask(id, {
        status: 'running',
        estimatedTime: undefined,
        lastProgressUpdate: now,
        lastProgress: task.current,
        lastEstimatedTimeUpdate: now
      });
      if (isAndroidPlatformCached()) {
        androidUpdateTaskNotification(task.current || 0, task.total || 0, false);
      }
    } else {
      await pauseColorExtraction();
      updateTask(id, { status: 'paused' });
      if (isAndroidPlatformCached()) {
        androidUpdateTaskNotification(task.current || 0, task.total || 0, true);
      }
    }
  };


  const handleGenerateThumbnails = async (folderIds: string[]) => {
    const getAllImageFilesInFolder = (folderId: string): string[] => {
      const folder = state.files[folderId];
      if (!folder) return [];

      let fileIds: string[] = [];

      // Use stack for DFS to avoid recursion depth issues
      const stack = [folderId];
      const visited = new Set<string>();

      while (stack.length > 0) {
        const currentId = stack.pop()!;
        if (visited.has(currentId)) continue;
        visited.add(currentId);

        const currentFolder = state.files[currentId];
        if (currentFolder && currentFolder.children) {
          for (const childId of currentFolder.children) {
            const child = state.files[childId];
            if (child) {
              if (child.type === FileType.FOLDER) {
                stack.push(childId);
              } else if (child.type === FileType.IMAGE) {
                fileIds.push(childId);
              }
            }
          }
        }
      }
      return fileIds;
    };

    // Collect all image IDs from selected folders
    let allImageIds: string[] = [];
    for (const fid of folderIds) {
      allImageIds = [...allImageIds, ...getAllImageFilesInFolder(fid)];
    }

    // Deduplicate
    allImageIds = Array.from(new Set(allImageIds));

    if (allImageIds.length === 0) {
      showToast(t('tasks.noImagesFound'));
      return;
    }

    const taskId = startTask('thumbnail', [], t('tasks.generatingThumbnails'), false);
    updateTask(taskId, { total: allImageIds.length, current: 0 });

    // Use a simple concurrency control
    let completed = 0;
    const MAX_CONCURRENT = 20;
    const queue = [...allImageIds];
    const activePromises: Promise<void>[] = [];

    const processNext = async () => {
      if (queue.length === 0) return;
      const id = queue.pop()!;
      const file = state.files[id];

      if (file) {
        try {
          // getThumbnail handles batching internally, but we await it to track progress
          await getThumbnail(file.path, file.updatedAt, state.settings.paths.resourceRoot);
        } catch (e) {
          console.error('Thumbnail gen error', e);
        }
      }

      completed++;
      updateTask(taskId, { current: completed });

      // Continue processing if queue not empty
      if (queue.length > 0) {
        await processNext();
      }
    };

    // Start initial batch
    for (let i = 0; i < Math.min(MAX_CONCURRENT, allImageIds.length); i++) {
      activePromises.push(processNext());
    }

    await Promise.all(activePromises);

    setTimeout(() => {
      setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) }));
      showToast(t('tasks.thumbnailsGenerated'));
    }, 1000);
  };

  const handleViewInExplorer = async (id: string) => {
    const file = state.files[id];
    if (!file?.path) {
      console.error('handleViewInExplorer: file or path not found', { id, file });
      return;
    }

    // 确锟斤拷路锟斤拷锟角撅拷锟斤拷路锟斤拷
    const targetPath = file.path;
    logDebug('[App] handleViewInExplorer', { id, path: targetPath, type: file.type, name: file.name });

    try {
      if (isTauriEnvironment()) {
        // Tauri 环境下使用 openPath API
        const { openPath } = await import('./api/tauri-bridge');
        // 传入 isFile 以便在文件管理器中选中该项（无论是文件还是文件夹）
        const isFile = file.type !== FileType.FOLDER;
        logDebug('[App] callingOpenPath', { path: targetPath, isFile });
        await openPath(targetPath, isFile);
      }
    } catch (error) {
      console.error('Failed to open in explorer:', error);
    }
  };
  /* handleSwitchTab / handleCloseTab / handleNewTab: delegated to `useNavigation` */

  useKeyboardShortcuts({
    tabs: state.tabs,
    activeTabId: state.activeTabId,
    onSwitchTab: handleSwitchTab,
    onCloseTab: handleCloseTab,
    onNewTab: handleNewTab,
    onRefresh: handleRefresh,
    onRequestDelete: requestDelete,
    selectedFileIds: activeTab.selectedFileIds,
    isReferenceMode
  });

  const pushHistoryRef = useRef(pushHistory);
  pushHistoryRef.current = pushHistory;
  const activeTabRef2 = useRef(activeTab);
  activeTabRef2.current = activeTab;
  const filesRef = useRef(state.files);
  filesRef.current = state.files;
  // getFileNode 引用永远不变（从 filesRef 读取），消费它的组件不会因 state.files
  // 引用变化而重渲染。组件只在 items/displayFileIds 等真正相关的 prop 变化时才重渲染，
  // 重渲染时 getFileNode 自然读到最新数据。
  const getFileNode = useCallback((id: string) => filesRef.current[id], []);
  // 稳定的双击回调：用 getFileNode 代替 state.files，避免 setFiles() 触发 FileGrid 重渲染。
  const handleFileDoubleClick = useCallback((id: string) => {
    const file = getFileNode(id);
    if (file?.type === FileType.FOLDER) {
      handleNavigateFolder(id);
    } else {
      enterViewer(id);
    }
  }, [getFileNode, handleNavigateFolder, enterViewer]);
  const closeViewerRef = useRef(closeViewer);
  closeViewerRef.current = closeViewer;
  const performSearchRef = useRef(handlePerformSearch);
  performSearchRef.current = handlePerformSearch;
  const exitActionRef2 = useRef(exitActionRef.current);
  exitActionRef2.current = exitActionRef.current;

  // ===== Android Native Viewer Integration =====
  const useNativeViewer = isAndroidPlatformCached();
  const [nativeViewerActive, setNativeViewerActive] = useState(false);
  // Refs 用于在事件处理器中访问最新值，避免闭包过期
  const useNativeViewerRef = useRef(useNativeViewer);
  useNativeViewerRef.current = useNativeViewer;
  const nativeViewerActiveRef = useRef(nativeViewerActive);
  nativeViewerActiveRef.current = nativeViewerActive;

  // 面板滑动手势所需的 DOM ref（安卓端左右面板跟手展开/收起）
  const panelRowRef = useRef<HTMLDivElement>(null);
  const sidebarOuterRef = useRef<HTMLDivElement>(null);
  const sidebarInnerRef = useRef<HTMLDivElement>(null);
  const metadataOuterRef = useRef<HTMLDivElement>(null);
  const metadataInnerRef = useRef<HTMLDivElement>(null);
  const colorPickerOuterRef = useRef<HTMLDivElement>(null);
  const colorPickerInnerRef = useRef<HTMLDivElement>(null);

  // 安卓端面板滑动手势的显式开关回调（与 toggle 逻辑一致，但不依赖当前可见状态）
  const openSidebarPanel = () => setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: true, isMetadataVisible: false, isColorPickerVisible: false } }));
  const closeSidebarPanel = () => setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: false } }));
  const openMetadataPanel = () => setState(s => ({ ...s, layout: { ...s.layout, isMetadataVisible: true, isSidebarVisible: false, isColorPickerVisible: false } }));
  const closeRightPanel = () => setState(s => ({ ...s, layout: { ...s.layout, isMetadataVisible: false, isColorPickerVisible: false } }));

  // 手势仅在安卓端、无弹窗/选择/原生查看器/右键菜单遮挡时启用
  // （原生查看器为覆盖在 WebView 之上的原生视图，触摸本就不会到达此处，nativeViewerActive 仅作额外保险）
  const panelGestureEnabled = isAndroidSync()
    && state.activeModal.type === null
    && !state.isSettingsOpen
    && !showCloseConfirmation
    && !isAndroidSelectionMode
    && !nativeViewerActive
    && !contextMenu.visible;

  usePanelSwipeGesture({
    rowRef: panelRowRef,
    sidebarOuterRef,
    sidebarInnerRef,
    metadataOuterRef,
    metadataInnerRef,
    colorPickerOuterRef,
    colorPickerInnerRef,
    enabled: panelGestureEnabled,
    isSidebarVisible: state.layout.isSidebarVisible,
    isMetadataVisible: state.layout.isMetadataVisible,
    isColorPickerVisible: state.layout.isColorPickerVisible,
    openSidebar: openSidebarPanel,
    closeSidebar: closeSidebarPanel,
    openMetadata: openMetadataPanel,
    closeRightPanel,
  });

  // 序列化图片列表供原生层使用
  const serializeImagesForNativeViewer = useCallback(() => {
    const imageFileIds = displayFileIds.filter(id => state.files[id]?.type === FileType.IMAGE);
    return imageFileIds.map(id => {
      const f = state.files[id];
      if (!f) return null;
      const isLan = f.path.startsWith('lan://');
      const base: any = {
        fileId: id,
        name: f.name,
        width: f.meta?.width || 0,
        height: f.meta?.height || 0,
        size: f.size || 0,
        format: f.meta?.format || '',
        createdAt: f.createdAt || f.meta?.created || '',
        updatedAt: f.updatedAt || f.meta?.modified || '',
        tags: f.tags || [],
        description: f.description || '',
        sourceUrl: f.sourceUrl || '',
        palette: f.meta?.palette || [],
        parentName: f.parentId ? state.files[f.parentId]?.name || '' : '',
        aiData: f.aiData ? {
          tags: f.aiData.tags || [],
          description: f.aiData.description || '',
          sceneCategory: f.aiData.sceneCategory || '',
          objects: f.aiData.objects || [],
        } : null,
      };
      if (isLan) {
        const remotePath = f.path.slice('lan://'.length);
        base.path = lanClientApi.getImageUrl(remotePath);
        base.isLan = true;
        base.thumbnailUrl = lanClientApi.getThumbnailUrl(remotePath);
      } else {
        base.path = f.path;
        base.contentUri = f.contentUri || '';
        base.isLan = false;
        base.thumbnailUrl = '';
      }
      return base;
    }).filter(Boolean) as any[];
  }, [displayFileIds, state.files]);

  // 监听 viewingFileId 变化，打开/关闭原生查看器
  useEffect(() => {
    if (!useNativeViewer) {
      setNativeViewerActive(false);
      return;
    }
    const viewingId = activeTab.viewingFileId;
    console.log('[NativeViewer] useEffect triggered, viewingId:', viewingId, 'useNativeViewer:', useNativeViewer);
    if (viewingId) {
      const imageFileIds = displayFileIds.filter(id => state.files[id]?.type === FileType.IMAGE);
      const startIndex = imageFileIds.indexOf(viewingId);
      if (startIndex < 0) {
        console.log('[NativeViewer] startIndex < 0, aborting');
        setNativeViewerActive(false);
        return;
      }
      const images = serializeImagesForNativeViewer();
      console.log('[NativeViewer] calling invoke, images count:', images.length, 'startIndex:', startIndex);
      const options = {
        slideshow: {
          enabled: false,
          interval: state.slideshowConfig.interval || 5000,
          transition: state.slideshowConfig.transition || 'fade',
          isRandom: state.slideshowConfig.isRandom || false,
          enableZoom: state.slideshowConfig.enableZoom || false,
        },
        isDark: (() => {
          const theme = state.settings.theme;
          if (theme === 'dark') return true;
          if (theme === 'light') return false;
          return document.documentElement.classList.contains('dark');
        })(),
      };
      invoke('android_open_native_viewer', {
        images: JSON.stringify(images),
        startIndex,
        options: JSON.stringify(options),
      }).then(() => {
        console.log('[NativeViewer] invoke succeeded, setting nativeViewerActive=true');
        setNativeViewerActive(true);
      }).catch((err) => {
        console.error('[NativeViewer] open failed, fallback to WebView:', err);
        setNativeViewerActive(false);
      });
    } else {
      console.log('[NativeViewer] no viewingId, closing native viewer');
      invoke('android_close_native_viewer').catch(() => {});
      setNativeViewerActive(false);
    }
  }, [activeTab.viewingFileId, useNativeViewer, serializeImagesForNativeViewer, state.slideshowConfig.interval, state.slideshowConfig.transition]);

  // 同步 LAN token 给原生层
  useEffect(() => {
    if (!useNativeViewer) return;
    const token = lanClientApi.getToken();
    if (token) {
      invoke('android_native_viewer_set_lan_token', { token }).catch(() => {});
    }
  }, [useNativeViewer, lanConnected]);

  // 预埋桥接函数：原生层通过 evaluateJavascript 调用这些方法
  useEffect(() => {
    if (!useNativeViewer) return;
    const bridge = {
      onClose: () => {
        setNativeViewerActive(false);
        closeViewerRef.current();
      },
      onNavigate: (index: number) => {
        const imageFileIds = displayFileIds.filter(id => state.files[id]?.type === FileType.IMAGE);
        const targetId = imageFileIds[index];
        if (targetId && targetId !== activeTabRef2.current.viewingFileId) {
          updateActiveTab({ viewingFileId: targetId });
        }
      },
      onMore: (fileId: string) => {
        // 关闭原生层，让 WebView 的 ImageViewer 显示完整 UI
        invoke('android_close_native_viewer').catch(() => {});
        setNativeViewerActive(false);
      },
      onDelete: (fileId: string) => {
        // 原生查看器内已弹窗确认；此处直接执行删除流程，不再关闭查看器、不再弹 ConfirmModal
        if (isAndroidDevice) handleAndroidDeleteConfirmed([fileId]);
        else requestDelete([fileId]);
      },
      onCopyToFolder: (fileId: string) => {
        // 触发原生文件夹选择弹窗（不弹 WebView FolderPickerModal，因 WebView 被原生查看器遮挡）
        invokeAndroidFolderPickerRef.current('copy', fileId);
      },
      onMoveToFolder: (fileId: string) => {
        invokeAndroidFolderPickerRef.current('move', fileId);
      },
      onEditTags: (fileId: string) => {
        setState(s => ({ ...s, activeModal: { type: 'edit-tags', data: { fileId } } }));
      },
      onUpdateFile: (fileId: string, updatesJson: string) => {
        try {
          const updates = JSON.parse(updatesJson);
          handleUpdateFile(fileId, updates);
        } catch (e) {
          console.error('[NativeViewer] onUpdateFile parse error:', e);
        }
      },
      onLongPress: (_fileId: string) => {
        // 长按图片：未来可触发选择模式或多操作菜单
      },
      onImmersiveToggle: (immersive: boolean) => {
        // 沉浸模式状态同步（可选）
      },
      onColorSearch: (colorHex: string) => {
        // viewer 已被 MainActivity.onColorSearch 关闭并触发 onClose
        // 直接发起颜色搜索
        const normalized = colorHex.startsWith('#') ? colorHex.slice(1) : colorHex;
        performSearchRef.current(`color:${normalized}`);
      },
      onExtractPalette: async (fileId: string, _filePath: string) => {
        // 用户在抽屉中点击了"提取主色调"按钮。
        // 复用 PC 端 MetadataPanel 的提取逻辑（local getDominantColors / LAN lanClientApi.getPalette）。
        // 完成后通过 handleUpdateFile 更新 meta.palette，
        // React→Native sync effect 会自动将 palette 推送到 NativeGalleryView。
        // 无论成功或失败，都必须通知 native 清除 loading 状态，否则脉冲动画永不停止。
        const file = state.files[fileId];
        if (!file?.path) return;
        let hexColors: string[] = [];
        try {
          if (file.path.startsWith('lan://')) {
            const { lanClientApi } = await import('./components/lan-client/lanClientApi');
            hexColors = await lanClientApi.getPalette(file.path.slice('lan://'.length));
          } else {
            const { getDominantColors } = await import('./api/tauri-bridge');
            const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
            let thumbnailPath: string | undefined = undefined;
            if (pathCache?.get) {
              thumbnailPath = pathCache.get(file.path);
            }
            const result = await getDominantColors(file.path, 8, thumbnailPath);
            if (result && result.length > 0) {
              hexColors = result.map(c => c.hex);
            }
          }
        } catch (err) {
          console.error('[NativeViewer] onExtractPalette failed:', err);
        }
        // 无论成功失败都更新 React state（即使 palette 为空也会触发 sync effect 清除 loading）
        if (hexColors.length > 0) {
          handleUpdateFile(fileId, {
            meta: { ...(file.meta || {}), palette: hexColors } as ImageMeta,
          });
        } else {
          // 提取失败/无结果：通知 native 清除 loading 并标记失败，
          // 使 autoExtractPalette 开启时显示"提取主色调"按钮而非永久 loading
          invoke('android_update_native_item', {
            fileId,
            updates: JSON.stringify({ palette: [], paletteLoadFailed: true }),
          }).catch(() => {});
        }
      },
      onUpdateSlideshowConfig: (configJson: string) => {
        try {
          const cfg = JSON.parse(configJson);
          setState(s => ({ ...s, slideshowConfig: cfg }));
        } catch (e) {
          console.error('[NativeViewer] onUpdateSlideshowConfig parse error:', e);
        }
      },
      onFolderPickerConfirm: (fileId: string, targetFolderId: string, type: string) => {
        // 用户在原生文件夹选择弹窗中确认了目标文件夹
        // type === 'copy' → 复制（图片仍在原文件夹，原生查看器不变）
        // type === 'move' → 移动（图片已离开当前文件夹，原生层会自动从 images 列表移除并切换下一张）
        if (type === 'copy') {
          handleCopyFiles([fileId], targetFolderId);
        } else if (type === 'move') {
          handleMoveFiles([fileId], targetFolderId);
        }
      },
    };
    (window as any).__androidViewerBridge = bridge;
    return () => {
      delete (window as any).__androidViewerBridge;
    };
  }, [useNativeViewer, displayFileIds, state.files, handleAIAnalysis, handleAndroidDeleteConfirmed, isAndroidDevice, requestDelete, enterFolder, setState, handleCopyFiles, handleMoveFiles]);

  // 组件卸载时关闭原生查看器
  useEffect(() => {
    return () => {
      if (useNativeViewer) {
        invoke('android_close_native_viewer').catch(() => {});
      }
    };
  }, [useNativeViewer]);

  // React → 原生：监听当前 viewingFile 的 FileNode 变化，增量推送更新
  useEffect(() => {
    if (!useNativeViewer || !nativeViewerActive) return;
    const viewingId = activeTab.viewingFileId;
    if (!viewingId) return;
    const file = state.files[viewingId];
    if (!file) return;
    const updates: Record<string, unknown> = {
      tags: file.tags || [],
      description: file.description || '',
      palette: file.meta?.palette || [],
      // 同步"浏览时自动提取主色调"开关到 native，控制 loading/按钮显示策略
      autoExtractPalette: !!state.settings.autoExtractPalette,
    };
    if (file.aiData) {
      updates.aiData = {
        tags: file.aiData.tags || [],
        description: file.aiData.description || '',
        sceneCategory: file.aiData.sceneCategory || '',
        objects: file.aiData.objects || [],
      };
    }
    invoke('android_update_native_item', {
      fileId: viewingId,
      updates: JSON.stringify(updates),
    }).catch(() => {});
  }, [useNativeViewer, nativeViewerActive, activeTab.viewingFileId, state.files[activeTab.viewingFileId || ''], state.settings.autoExtractPalette]);

  // React → 原生：浏览时自动提取主色调（当设置开启且当前图片无 palette 时）
  const autoExtractedPaletteRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (!useNativeViewer || !nativeViewerActive) {
      // 查看器关闭时清除缓存，下次打开可重新尝试提取失败的图片
      autoExtractedPaletteRef.current.clear();
      return;
    }
    if (!state.settings.autoExtractPalette) return;
    const viewingId = activeTab.viewingFileId;
    if (!viewingId) return;
    const file = state.files[viewingId];
    if (!file?.path) return;
    // 已有 palette 数据，无需提取
    if (file.meta?.palette && file.meta.palette.length > 0) return;
    // 同一张图片只自动提取一次（避免循环）
    if (autoExtractedPaletteRef.current.has(viewingId)) return;
    autoExtractedPaletteRef.current.add(viewingId);
    // 异步提取（复用 onExtractPalette 的逻辑）
    (async () => {
      let hexColors: string[] = [];
      try {
        if (file.path.startsWith('lan://')) {
          const { lanClientApi } = await import('./components/lan-client/lanClientApi');
          hexColors = await lanClientApi.getPalette(file.path.slice('lan://'.length));
        } else {
          const { getDominantColors } = await import('./api/tauri-bridge');
          const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
          let thumbnailPath: string | undefined = undefined;
          if (pathCache?.get) {
            thumbnailPath = pathCache.get(file.path);
          }
          const result = await getDominantColors(file.path, 8, thumbnailPath);
          if (result && result.length > 0) {
            hexColors = result.map(c => c.hex);
          }
        }
      } catch (err) {
        console.error('[NativeViewer] autoExtractPalette failed:', err);
      }
      if (hexColors.length > 0) {
        handleUpdateFile(viewingId, {
          meta: { ...(file.meta || {}), palette: hexColors } as ImageMeta,
        });
      } else {
        // 提取失败/返回空：通知 native 显示"提取主色调"按钮供用户手动重试
        invoke('android_update_native_item', {
          fileId: viewingId,
          updates: JSON.stringify({ palette: [], paletteLoadFailed: true }),
        }).catch(() => {});
      }
    })();
  }, [useNativeViewer, nativeViewerActive, activeTab.viewingFileId, state.files[activeTab.viewingFileId || ''], state.settings.autoExtractPalette]);

  useEffect(() => {
    const handleAndroidBackPress = async () => {
      if ((window as any).__androidBackHandled) {
        (window as any).__androidBackHandled = false;
        return;
      }

      const tab = activeTabRef2.current;

      if (state.activeModal.type !== null) {
        setState(s => ({ ...s, activeModal: { type: null } }));
        return;
      }

      if (state.isSettingsOpen) {
        setState(s => ({ ...s, isSettingsOpen: false }));
        return;
      }

      const searchInput = document.querySelector<HTMLInputElement>('#toolbar-search-input');
      if (searchInput && document.activeElement === searchInput) {
        window.dispatchEvent(new Event('close-android-search'));
        return;
      }

      if (showCloseConfirmation) {
        setShowCloseConfirmation(false);
        return;
      }

      if (isAndroidSelectionModeRef.current) {
        handleExitAndroidSelectionMode();
        return;
      }

      // 原生查看器：先收起抽屉，再关闭查看器
      if (useNativeViewerRef.current && nativeViewerActiveRef.current) {
        // 通过 Rust 命令让 Kotlin 收起抽屉（如果打开）或关闭查看器
        // Kotlin 侧 closeNativeDrawer 只在抽屉打开时收起，不关闭查看器
        // 这里先尝试收起抽屉，由 Kotlin 决定是否需要进一步操作
        try {
          await invoke('android_close_drawer');
        } catch (e) {
          console.error('[NativeViewer] close drawer failed:', e);
        }
        return;
      }

      if (tab.viewingFileId) {
        if ((window as any).__isImmersive) {
          (window as any).__androidBackHandled = true;
          return;
        }
        closeViewerRef.current();
        return;
      }

      if (tab.isCompareMode) {
        handleCloseTab({ stopPropagation: () => { } } as any, tab.id);
        setIsReferenceMode(false);
        return;
      }

      if (tab.viewMode === 'folders-overview' || tab.viewMode === 'lan-folders-overview') {
        // Already at main screen, fall through to exit behavior
      } else if (tab.viewMode === 'browser') {
        const current = filesRef.current[tab.folderId];
        if (current?.source === 'lan') {
          if (current.parentId) {
            pushHistoryRef.current(current.parentId, null, 'browser', '', 'all', [], null, 0);
          } else {
            pushHistoryRef.current('__lan_folders_root__', null, 'lan-folders-overview', '', 'all', [], null, 0);
          }
          return;
        }
        pushHistoryRef.current('__android_folders_root__', null, 'folders-overview', '', 'all', [], null, 0);
        return;
      } else {
        pushHistoryRef.current('__android_folders_root__', null, 'folders-overview', '', 'all', [], null, 0);
        return;
      }

      const exitAction = exitActionRef2.current;
      if (exitAction === 'minimize') {
        hideWindow();
      } else if (exitAction === 'exit') {
        exitApp();
      } else {
        setShowCloseConfirmation(true);
      }
    };

    window.addEventListener('android-back-press', handleAndroidBackPress);
    return () => window.removeEventListener('android-back-press', handleAndroidBackPress);
  }, [state.activeModal.type, state.isSettingsOpen, showCloseConfirmation, setState, setIsReferenceMode]);

  const handleCloseAllTabs = () => {
    setState(prev => {
      if (prev.tabs.length <= 1) return prev;
      // 保留第一个 tab，关闭其他所有 tab
      const firstTab = prev.tabs[0];
      return { ...prev, tabs: [firstTab], activeTabId: firstTab.id };
    });
  };
  const handleCloseOtherTabs = (id: string) => {
    setState(prev => {
      const keptTab = prev.tabs.find(t => t.id === id);
      if (!keptTab) return prev;
      return { ...prev, tabs: [keptTab], activeTabId: id };
    });
  };

  // 锟捷癸拷锟饺★拷锟斤拷锟斤拷锟斤拷募锟斤拷锟絀D
  const getAllSubFolderIds = (folderId: string): string[] => {
    const folder = state.files[folderId];
    if (!folder || folder.type !== FileType.FOLDER || !folder.children) {
      return [];
    }

    let allIds: string[] = [];
    for (const childId of folder.children) {
      const child = state.files[childId];
      if (child && child.type === FileType.FOLDER) {
        allIds.push(childId);
        allIds = [...allIds, ...getAllSubFolderIds(childId)];
      }
    }
    return allIds;
  };

  const handleExpandAll = (id: string) => {
    const allSubFolderIds = getAllSubFolderIds(id);
    setState(prev => ({
      ...prev,
      expandedFolderIds: [...new Set([...prev.expandedFolderIds, ...allSubFolderIds])]
    }));
  };

  const handleCollapseAll = (id: string) => {
    const allSubFolderIds = getAllSubFolderIds(id);
    setState(prev => ({
      ...prev,
      expandedFolderIds: prev.expandedFolderIds.filter(folderId =>
        !allSubFolderIds.includes(folderId)
      )
    }));
  };

  // Total visible side-panel width in rem (sidebar 16rem + metadata 20rem).
  // Passed to grid components so they can predict the target container width at
  // toggle moment and run card transitions simultaneously with panel animation.
  const panelWidthRem = (state.layout.isSidebarVisible ? 16 : 0) + (state.layout.isMetadataVisible ? 20 : 0) + (state.layout.isColorPickerVisible ? 20 : 0);

  return (
    <div
      className="w-full h-full flex flex-col bg-main text-gray-900 dark:text-gray-100 overflow-hidden font-sans transition-colors duration-300"
      onClick={closeContextMenu}
      onDragEnter={handleExternalDragEnter}
      onDragOver={handleExternalDragOver}
      onDrop={handleExternalDrop}
      onDragLeave={handleExternalDragLeave}
    >
      {/* 锟斤拷锟斤拷锟斤拷锟斤拷 */}
      <SplashScreen isVisible={showSplash} loadingInfo={loadingInfo} />

      {/* LAN 桌面图片下载进度遮罩 */}
      <LanDownloadOverlay progress={lanDownloadProgress} t={t} />

      {/* 锟解部锟斤拷拽锟斤拷锟角诧拷 */}
      <DragDropOverlay
        isVisible={isExternalDragging && !activeTab.isCompareMode}
        fileCount={externalDragItems.length}
        hoveredAction={hoveredDropAction}
        onHoverAction={setHoveredDropAction}
        t={t}
        targetPath={state.files[activeTab.folderId]?.path}
      />

      {/* 全局 SVG 颜色通道滤镜 */}
      <SvgColorFilters />
      <TabBarWrapper
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        files={state.files}
        topics={state.topics}
        people={peopleWithDisplayCounts}
        onSwitchTab={handleSwitchTab}
        onCloseTab={handleCloseTab}
        onNewTab={handleNewTab}
        onContextMenu={handleContextMenu}
        t={t}
        showWindowControls={!showSplash}
        isReferenceMode={isReferenceMode}
        onHoverChange={handleTopBarHoverChange}
        exitActionRef={exitActionRef}
        setShowCloseConfirmation={setShowCloseConfirmation}
      />
      <div className={`flex-1 flex flex-col m-2 mt-0 overflow-hidden bg-content ${isAndroidPlatformCached() ? 'rounded-xl' : isLeftmostTab ? 'rounded-bl-xl rounded-br-xl rounded-tr-xl' : 'rounded-xl'}`}>
        <div ref={panelRowRef} className="flex-1 flex overflow-hidden relative"
          style={{ transition: 'width 300ms ease-out, height 300ms ease-out' }}>
          <SidebarPane
            sidebarOuterRef={sidebarOuterRef}
            sidebarInnerRef={sidebarInnerRef}
            isSidebarVisible={state.layout.isSidebarVisible}
            roots={state.roots}
            files={state.files}
            people={peopleWithDisplayCounts}
            customTags={state.customTags}
            currentFolderId={activeTab.folderId}
            expandedIds={state.expandedFolderIds}
            tasks={tasks}
            onToggle={handleToggleFolder}
            onNavigate={handleNavigateFolder}
            onTagSelect={enterTagView}
            onNavigateAllTags={enterTagsOverview}
            onPersonSelect={enterPersonView}
            onNavigateAllPeople={enterPeopleOverview}
            onContextMenu={handleContextMenu}
            isCreatingTag={isCreatingTag}
            onStartCreateTag={handleCreateNewTag}
            onSaveNewTag={handleSaveNewTag}
            onCancelCreateTag={handleCancelCreateTag}
            onOpenSettings={toggleSettings}
            onRestoreTask={onRestoreTask}
            onPauseResume={onPauseResume}
            onStartRenamePerson={onStartRenamePerson}
            onCreatePerson={handleCreatePerson}
            onNavigateTopics={handleNavigateTopics}
            onCreateTopic={handleCreateRootTopic}
            onDropOnFolder={handleDropOnFolder}
            onOpenCanvas={handleOpenCanvas}
            onNavigateHome={isAndroidPlatformCached() ? handleNavigateHome : undefined}
            activeViewMode={activeTab.viewMode}
            aiConnectionStatus={state.aiConnectionStatus}
            t={t}
            filesVersion={filesVersion}
            lanRoots={lanRoots}
            lanConnected={lanConnected}
            lanLoading={lanLoading}
            onNavigateNetworkFolder={handleNavigateNetworkFolder}
            onNavigateNetworkHome={handleNavigateNetworkHome}
            onOpenLanSettings={handleOpenLanSettings}
          />

        <div className="flex-1 flex flex-col min-w-0 relative bg-content">
          <ViewerPane
            activeTab={activeTab}
            state={state}
            displayFileIds={displayFileIds}
            t={t}
            onLayoutToggle={onLayoutToggle}
            closeViewer={closeViewer}
            handleViewerNavigate={handleViewerNavigate}
            goBack={goBack}
            goForward={goForward}
            isAndroidDevice={isAndroidDevice}
            handleAndroidDelete={handleAndroidDelete}
            requestDelete={requestDelete}
            handleViewInExplorer={handleViewInExplorer}
            setState={setState}
            enterFolder={enterFolder}
            handleViewerSearch={handleViewerSearch}
            updateActiveTab={updateActiveTab}
            handlePasteTags={handlePasteTags}
            handleCopyTags={handleCopyTags}
            handleAIAnalysis={handleAIAnalysis}
            handleOpenCompareAndClearSelection={handleOpenCompareAndClearSelection}
            handleAddToCompareCanvas={handleAddToCompareCanvas}
            updateTabById={updateTabById}
            handleCloseTab={handleCloseTab}
            setIsReferenceMode={setIsReferenceMode}
            handleReferenceModeChange={handleReferenceModeChange}
            isReferenceMode={isReferenceMode}
          />
          <div className={`flex-1 flex flex-col min-w-0 relative ${activeTab.viewingFileId || activeTab.isCompareMode ? 'hidden' : 'flex'}`} style={{ height: '100%' }}>
            <ToolbarPane
              lanUploadInputRef={lanUploadInputRef}
              handleUploadFilesSelected={handleUploadFilesSelected}
              isAndroidDevice={isAndroidDevice}
              isAndroidSelectionMode={isAndroidSelectionMode}
              activeTab={activeTab}
              state={state}
              displayFileIds={displayFileIds}
              peopleWithDisplayCounts={peopleWithDisplayCounts}
              t={t}
              updateActiveTab={updateActiveTab}
              handleExitAndroidSelectionMode={handleExitAndroidSelectionMode}
              handleDeselectAllAndroid={handleDeselectAllAndroid}
              handleAndroidDelete={handleAndroidDelete}
              setContextMenu={setContextMenu}
              toolbarQuery={toolbarQuery}
              groupedTags={groupedTags}
              tagSearchQuery={tagSearchQuery}
              setTagSearchQuery={setTagSearchQuery}
              toggleSidebar={toggleSidebar}
              goBack={goBack}
              goForward={goForward}
              handleNavigateUp={handleNavigateUp}
              handleTagClick={handleTagClick}
              handleRefresh={handleRefresh}
              handlePerformSearch={handlePerformSearch}
              setToolbarQuery={setToolbarQuery}
              setPersonSearchQuery={setPersonSearchQuery}
              personSearchQuery={personSearchQuery}
              topicLayoutMode={topicLayoutMode}
              handleTopicLayoutModeChange={handleTopicLayoutModeChange}
              folderLayoutMode={folderLayoutMode}
              handleFolderLayoutModeChange={handleFolderLayoutModeChange}
              personSortBy={personSortBy}
              personSortDirection={personSortDirection}
              personGroupBy={personGroupBy}
              handlePersonSortByChange={handlePersonSortByChange}
              handlePersonSortDirectionChange={handlePersonSortDirectionChange}
              handlePersonGroupByChange={handlePersonGroupByChange}
              isClipSearchEnabled={isClipSearchEnabled}
              setIsClipSearchEnabled={setIsClipSearchEnabled}
              openClipSettings={openClipSettings}
              showToast={showToast}
              showLanUpload={showLanUpload}
              handleUploadToLan={handleUploadToLan}
              totalResults={totalResults}
              pageSize={pageSize}
              groupBy={groupBy}
              setGroupBy={setGroupBy}
              handleRememberFolderSettings={handleRememberFolderSettings}
              setState={setState}
              toggleMetadata={toggleMetadata}
              toggleColorPicker={toggleColorPicker}
              toggleSettings={toggleSettings}
            />
            <FilterChipsBar
              activeTab={activeTab}
              t={t}
              setToolbarQuery={setToolbarQuery}
              onPerformSearch={onPerformSearch}
              updateActiveTab={updateActiveTab}
              peopleWithDisplayCounts={peopleWithDisplayCounts}
              handleClearPersonFilter={handleClearPersonFilter}
              handleClearTagFilter={handleClearTagFilter}
              totalResults={totalResults}
              pageSize={pageSize}
            />

            <div className="flex-1 flex flex-col relative bg-content overflow-hidden">
            <OverviewBar
              activeTab={activeTab}
              state={state}
              t={t}
              setState={setState}
              peopleWithDisplayCounts={peopleWithDisplayCounts}
              displayFileIds={displayFileIds}
            />
              <MainContentArea
                activeTab={activeTab}
                state={state}
                displayFileIds={displayFileIds}
                getFileNode={getFileNode}
                t={t}
                peopleForOverview={peopleForOverview}
                groupedTags={groupedTags}
                groupBy={groupBy}
                collapsedGroups={collapsedGroups}
                toggleGroup={toggleGroup}
                isSelecting={isSelecting}
                fileGridLayoutRef={fileGridLayoutRef}
                overlayRef={overlayRef}
                selectionRef={selectionRef}
                handleScroll={handleScroll}
                enterFolder={enterFolder}
                handleFolderScrollTopChange={handleFolderScrollTopChange}
                handleFolderLayoutModeChange={handleFolderLayoutModeChange}
                folderLayoutMode={folderLayoutMode}
                isAndroidSelectionMode={isAndroidSelectionMode}
                handleFolderLongPress={handleFolderLongPress}
                handleShowContextMenuForFile={handleShowContextMenuForFile}
                handleFolderAndroidRangeSelect={handleFolderAndroidRangeSelect}
                handleFolderSelect={handleFolderSelect}
                handleRefresh={handleRefresh}
                panelWidthRem={panelWidthRem}
                lanRoots={lanRoots}
                handleNavigateNetworkFolder={handleNavigateNetworkFolder}
                lanLoading={lanLoading}
                handleLanRefresh={handleLanRefresh}
                handleNavigateTopic={handleNavigateTopic}
                handleUpdateTopic={handleUpdateTopic}
                handleCreateTopic={handleCreateTopic}
                handleDeleteTopic={handleDeleteTopic}
                updateActiveTab={updateActiveTab}
                handlePersonClick={handlePersonClick}
                handleNavigatePerson={handleNavigatePerson}
                handleOpenTopicInNewTab={handleOpenTopicInNewTab}
                handleOpenPersonInNewTab={handleOpenPersonInNewTab}
                handleOpenInNewTab={handleOpenInNewTab}
                handleNavigateFolder={handleNavigateFolder}
                handleFileDoubleClick={handleFileDoubleClick}
                handleFileLongPress={handleFileLongPress}
                topicLayoutMode={topicLayoutMode}
                handleTopicLayoutModeChange={handleTopicLayoutModeChange}
                showToast={showToast}
                hoverPlayingId={hoverPlayingId}
                setHoverPlayingId={setHoverPlayingId}
                handleFileClick={handleFileClick}
                handleContextMenu={handleContextMenu}
                handleRenameSubmit={handleRenameSubmit}
                startRename={startRename}
                handleMouseDown={handleMouseDown}
                handleMouseMove={handleMouseMove}
                handleMouseUp={handleMouseUp}
                handleOverviewTagClick={handleOverviewTagClick}
                enterPersonView={enterPersonView}
                enterTagView={enterTagView}
                groupedFiles={groupedFiles}
                setState={setState}
                handleUpdateFile={handleUpdateFile}
                handleDropOnFolder={handleDropOnFolder}
                isExternalDragging={isExternalDragging}
                isDraggingInternal={isDraggingInternal}
                setIsDraggingInternal={setIsDraggingInternal}
                setDraggedFilePaths={setDraggedFilePaths}
                handleAndroidRangeSelect={handleAndroidRangeSelect}
                personSortBy={personSortBy}
                personSortDirection={personSortDirection}
                personGroupBy={personGroupBy}
              />
            </div>
          </div>
        </div>
        <RightPanel
          metadataOuterRef={metadataOuterRef}
          metadataInnerRef={metadataInnerRef}
          colorPickerOuterRef={colorPickerOuterRef}
          colorPickerInnerRef={colorPickerInnerRef}
          state={state}
          activeTab={activeTab}
          peopleWithDisplayCounts={peopleWithDisplayCounts}
          filesVersion={filesVersion}
          t={t}
          handleUpdateFile={handleUpdateFile}
          handleUpdatePerson={handleUpdatePerson}
          handleUpdateTopic={handleUpdateTopic}
          handleDeleteTopic={handleDeleteTopic}
          handleNavigateTopic={handleNavigateTopic}
          handleNavigatePerson={handleNavigatePerson}
          handleNavigateFolder={handleNavigateFolder}
          enterTagView={enterTagView}
          onPerformSearch={onPerformSearch}
          handlePerformSearch={handlePerformSearch}
          toggleColorPicker={toggleColorPicker}
        />
        </div>
        <TaskProgressModal
          tasks={tasks}
          onMinimize={(id: string) => updateTask(id, { minimized: true })}
          onClose={(id?: string) => id && updateTask(id, { status: 'completed' })}
          t={t}
          onPauseResume={async (taskId: string, type: string) => {
            const task = tasks.find(t => t.id === taskId);
            if (!task) return;
            if (task.status === 'running') {
              updateTask(taskId, { status: 'paused' });
              if (type === 'color') {
                await pauseColorExtraction();
                if (isAndroidPlatformCached()) {
                  androidUpdateTaskNotification(task.current || 0, task.total || 0, true);
                }
              }
            } else {
              updateTask(taskId, { status: 'running' });
              if (type === 'color') {
                await resumeColorExtraction();
                if (isAndroidPlatformCached()) {
                  androidUpdateTaskNotification(task.current || 0, task.total || 0, false);
                }
              }
            }
          }}
        />
        <GlobalToasts
          deletionTasks={isAndroidDevice ? [] : deletionTasks}
          undoDelete={undoDelete}
          dismissDelete={dismissDelete}
          showDragHint={showDragHint}
          isCompareMode={activeTab.isCompareMode}
          toast={toast}
          t={t}
        />
      </div>

      <AppModals
        state={state}
        setState={setState}
        t={t}
        activeTab={activeTab}
        peopleWithDisplayCounts={peopleWithDisplayCounts}
        handleManualAddPerson={handleManualAddPerson}
        handleManualAddToTopic={handleManualAddToTopic}
        handleRenameTag={handleRenameTag}
        handleBatchRename={handleBatchRename}
        handleAIBatchRename={handleAIBatchRename}
        handleRenamePerson={handleRenamePerson}
        handleConfirmDeleteTags={handleConfirmDeleteTags}
        handleDeletePerson={handleDeletePerson}
        handleCreateTopic={handleCreateTopic}
        handleUpdateTopic={handleUpdateTopic}
        handleUpdateFile={handleUpdateFile}
        handleCopyFiles={handleCopyFiles}
        handleMoveFiles={handleMoveFiles}
        handleResolveFileCollision={handleResolveFileCollision}
        handleResolveFolderMerge={handleResolveFolderMerge}
        handleResolveExtensionChange={handleResolveExtensionChange}
        handleSaveAvatarCrop={handleSaveAvatarCrop}
        handleExitConfirm={handleExitConfirm}
        handleClearPersonInfo={handleClearPersonInfo}
        handleClipEnabledChange={handleClipEnabledChange}
        clipLoading={clipLoading}
        showToast={showToast}
        onClipSearchDisabled={() => setIsClipSearchEnabled(false)}
        rememberExitChoice={rememberExitChoice}
        setRememberExitChoice={setRememberExitChoice}
        handleChangePath={handleChangePath}
        showWelcome={showWelcome}
        handleWelcomeFinish={handleWelcomeFinish}
        handleOpenFolder={handleOpenFolder}
        scanProgress={state.scanProgress}
        showCloseConfirmation={showCloseConfirmation}
        setShowCloseConfirmation={setShowCloseConfirmation}
        handleCloseConfirmation={handleCloseConfirmation}
        updateInfo={updateInfo}
        downloadProgress={downloadProgress}
        onStartDownload={startDownload}
        onPauseDownload={pauseDownload}
        onResumeDownload={resumeDownload}
        onCancelDownload={cancelDownload}
        onInstallUpdate={installUpdate}
        onOpenDownloadFolder={openDownloadFolder}
        onIgnoreUpdate={() => updateInfo && ignoreVersion(updateInfo.latestVersion)}
        onDismissUpdate={dismissUpdate}
        onCheckUpdate={() => checkUpdate(true)}
        isCheckingUpdate={isCheckingUpdate}
        onRefreshTags={handleRefreshTags}
        onNavigateToFile={handleNavigateToFile}
        handleSmartCreatePerson={handleSmartCreatePerson}
        handleSmartAddToPerson={handleSmartAddToPerson}
        handleSmartCreateTopic={handleSmartCreateTopic}
        handleConfirmCreatePerson={handleConfirmCreatePerson}
      />

      <ContextMenu
        contextMenu={contextMenu}
        files={state.files}
        activeTab={activeTab}
        tabs={state.tabs}
        peopleWithDisplayCounts={peopleWithDisplayCounts}
        aiConnectionStatus={state.aiConnectionStatus}
        displayFileIds={displayFileIds}
        clipSettings={state.settings.clip}
        isAndroid={isAndroidDevice}
        t={t}
        closeContextMenu={closeContextMenu}
        handleOpenInNewTab={handleOpenInNewTab}
        handleViewInExplorer={handleViewInExplorer}
        enterFolder={enterFolder}
        setModal={(type, data) => setState(s => ({ ...s, activeModal: { type: type as any, data } }))}
        startRename={startRename}
        handleFolderAIAnalysis={handleFolderAIAnalysis}
        handleAIAnalysis={handleAIAnalysis}
        handleClearPersonInfo={handleClearPersonInfo}
        handleGenerateThumbnails={handleGenerateThumbnails}
        requestDelete={isAndroidDevice ? handleAndroidDelete : requestDelete}
        handleCreateFolder={handleCreateFolder}
        handleExpandAll={handleExpandAll}
        handleCollapseAll={handleCollapseAll}
        enterTagView={enterTagView}
        requestDeleteTags={requestDeleteTags}
        handleSetAvatar={handleSetAvatar}
        handleCreatePerson={handleCreatePerson}
        handleCreateTopic={() => setState(s => ({ ...s, activeModal: { type: 'create-topic', data: { parentId: null } } }))}
        handleCloseTab={handleCloseTab}
        handleCloseOtherTabs={handleCloseOtherTabs}
        handleCloseAllTabs={handleCloseAllTabs}
        handleRefresh={handleRefresh}
        handleCreateNewTag={handleCreateNewTag}
        handleCopyTags={handleCopyTags}
        handlePasteTags={handlePasteTags}
        showToast={showToast}
        updateActiveTab={updateActiveTab}
        handleOpenCompareInNewTab={handleOpenCompareAndClearSelection}
        handleAddToCompareCanvas={handleAddToCompareCanvas}
        handleCopyImageToClipboard={handleCopyImageToClipboard}
        handleSearchSimilarImages={handleSearchSimilarImages}
        openClipSettings={openClipSettings}
      />
    </div>
  );
};

export default App;
