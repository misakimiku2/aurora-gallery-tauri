
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Sidebar } from './components/TreeSidebar';
import { lanClientApi } from './components/lan-client/lanClientApi';
import { downloadLanImagesBatched } from './components/lan-client/lanDownload';
import { MetadataPanel } from './components/MetadataPanel';
import { ImageViewer } from './components/ImageViewer';
import { ImageComparer } from './components/ImageComparer';
import { TabBar } from './components/TabBar';
import { TopBar } from './components/TopBar';
import { AndroidSelectionBar } from './components/AndroidSelectionBar';
import { FileGrid } from './components/FileGrid';
import { InlineRenameInput } from './components/InlineRenameInput';
import { ImageThumbnail } from './components/ImageThumbnail';
import { TopicModule } from './components/TopicModule';
import { FoldersOverview } from './components/FoldersOverview';
import { SettingsModal } from './components/SettingsModal';
import { AuroraLogo } from './components/Logo';
import { CloseConfirmationModal } from './components/CloseConfirmationModal';
import { initializeFileSystem, formatSize } from './utils/mockFileSystem';
import { debug as logDebug, info as logInfo, warn as logWarn } from './utils/logger';
import { translations } from './utils/translations';
import { debounce } from './utils/debounce';
import { performanceMonitor } from './utils/performanceMonitor';
import { lanNavStart, lanNavStep } from './utils/lanNavTrace';
import { scanDirectory, scanFile, openDirectory, saveUserData as tauriSaveUserData, loadUserData as tauriLoadUserData, getDefaultPaths as tauriGetDefaultPaths, ensureDirectory, createFolder, renameFile, deleteFile, deleteAndroidFiles, clearScanCache, getThumbnail, hideWindow, showWindow, exitApp, copyFile, moveFile, writeFileFromBytes, pauseColorExtraction, resumeColorExtraction, searchByColor, searchByPalette, getAssetUrl, openPath, dbGetAllPeople, dbUpsertPerson, dbDeletePerson, dbUpdatePersonAvatar, dbUpsertFileMetadata, dbGetAllFileMetadata, addPendingFilesToDb, switchRootDatabase, dbGetAllTopics, dbUpsertTopic, dbDeleteTopic, copyImageToClipboard, getColorDbStats, lanShareStart, setAndroidStatusBar, androidUpdateTaskNotification, androidHideTaskNotification, isAndroidPlatformCached, androidCheckStorageManager, androidRequestAllFilesAccess } from './api/tauri-bridge';
import { AppState, FileNode, FileType, SlideshowConfig, AppSettings, SearchScope, SortOption, TabState, LayoutMode, SUPPORTED_EXTENSIONS, DateFilter, SettingsCategory, AiData, TaskProgress, Person, Topic, HistoryItem, AiFace, GroupByOption, FileGroup, DeletionTask, AiSearchFilter, PersonSortOption, PersonGroupByOption, SortDirection } from './types';
import { Search, Folder, Image as ImageIcon, ArrowUp, X, FolderOpen, Tag, Folder as FolderIcon, Settings, Moon, Sun, Monitor, RotateCcw, Copy, Move, ChevronLeft, ChevronDown, FileText, Filter, Trash2, Undo2, Globe, Shield, QrCode, Smartphone, ExternalLink, Sliders, Plus, Layout, List, Grid, Maximize, AlertTriangle, Merge, FilePlus, ChevronRight, HardDrive, ChevronsDown, ChevronsUp, FolderPlus, Calendar, Server, Loader2, Database, Palette, Check, RefreshCw, Scan, Cpu, Cloud, FileCode, Edit3, Minus, User, Type, Brain, Sparkles, Crop, LogOut, XCircle, Pause, MoveHorizontal, Clipboard, Link } from 'lucide-react';
import { aiService } from './services/aiService';
import md5 from 'md5';

import { isAndroidPlatform, ensureAndroidPermissionAndScan, scanAndroidMedia, initAndroidPermissionListener, isAndroidSync } from './utils/androidPlatform';

// Helper: normalize path to use forward slashes consistently
const normalizePath = (path: string) => path.replace(/\\/g, '/');

// Helper: generate a stable ID from a path (compat with Rust backend)
const generateId = (path: string) => md5(normalizePath(path)).substring(0, 9);

// ... (helper components remain unchanged)
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
import { GlobalToasts } from './components/GlobalToasts';
import { asyncPool } from './utils/async';

import { ToastItem } from './components/ToastItem';
import { TaskProgressModal } from './components/TaskProgressModal';

import { getPinyinGroup } from './utils/textUtils';
import { DUMMY_TAB, DEFAULT_LAYOUT_SETTINGS } from './constants';


import SplashScreen from './components/SplashScreen';
import { DragDropOverlay, DropAction } from './components/DragDropOverlay';
import { ContextMenu } from './components/ContextMenu';
import { AppModals } from './components/AppModals';

// 锟斤拷锟斤拷统一锟侥伙拷锟斤拷锟斤拷夤わ拷锟?
import { isTauriEnvironment, detectTauriEnvironmentAsync } from './utils/environment';

// 锟斤拷展 Window 锟接匡拷锟皆帮拷锟斤拷锟斤拷锟角碉拷全锟街猴拷锟斤拷
declare global {
  interface Window {
    __UPDATE_FILE_COLORS__?: (filePath: string, colors: string[]) => void;
  }
}

// Global initialization guard to prevent double execution in React Strict Mode
let isAppInitialized = false;

// LAN 根目录虚拟文件夹 ID：容纳资源根目录下未归入子文件夹的散落图片
const LAN_ROOT_IMAGES_ID = '__lan_root_images__';

export const App: React.FC = () => {
  const getInitialLayout = () => {
    const isAndroid = isAndroidSync();
    if (isAndroid) {
      const isPortrait = typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches;
      return { isSidebarVisible: !isPortrait, isMetadataVisible: false };
    }
    return { isSidebarVisible: true, isMetadataVisible: true };
  };

  const [state, setState] = useState<AppState>({
    roots: [], files: {}, people: {}, topics: {}, expandedFolderIds: [], tabs: [], activeTabId: '', sortBy: 'name', sortDirection: 'asc', thumbnailSize: 180, renamingId: null, clipboard: { action: null, items: { type: 'file', ids: [] } }, customTags: [], folderSettings: {}, layout: getInitialLayout(),
    slideshowConfig: { interval: 3000, transition: 'fade', isRandom: false, enableZoom: true },
    settings: {
      theme: 'system',
      language: 'zh',
      autoStart: false,
      exitAction: 'ask',
      animateOnHover: true,
      openInImmersiveByDefault: false,
      paths: { resourceRoot: 'C:\\Users\\User\\Pictures\\AuroraGallery', cacheRoot: 'C:\\AppData\\Local\\Aurora\\Cache' },
      search: { isAISearchEnabled: false },
      performance: {
        refreshInterval: 5000 // 默锟斤拷5锟斤拷刷锟斤拷一锟斤拷
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
      defaultLayoutSettings: DEFAULT_LAYOUT_SETTINGS
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
  const [lanRoots, setLanRoots] = useState<string[]>([]);
  const [lanLoading, setLanLoading] = useState(false);
  const [lanConnected, setLanConnected] = useState(false);
  const [lanAllowUpload, setLanAllowUpload] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const lanUploadInputRef = useRef<HTMLInputElement | null>(null);
  const [lanDownloadProgress, setLanDownloadProgress] = useState<{ active: boolean; completed: number; total: number }>({ active: false, completed: 0, total: 0 });
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
      }, 100);

      if (state.roots.length === 0) {
        const hasOnboarded = localStorage.getItem('aurora_onboarded');
        if (!hasOnboarded) {
          setShowWelcome(true);
        }
      }
    }
  }, [isLoading, state.roots.length]);

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

    // 恢复后台颜色提取，让主色处理开始
    (async () => {
      try {
        await resumeColorExtraction();
      } catch (err) {
        console.warn('Failed to resume color extraction:', err);
      }
    })();
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
  const currentLanFolder = state.files[activeTab.folderId];
  const showLanUpload = isAndroidDevice && !!currentLanFolder && currentLanFolder.source === 'lan' && lanAllowUpload && !isUploading;

  const isModalOpen = state.activeModal.type !== null || state.isSettingsOpen;
  const showDragHint = selectedCount > 1 && activeTab.viewMode !== 'topics-overview' && activeTaskCount === 0 && !isScrolling && !isModalOpen && !isAndroidDevice;

  const {
    isSelecting,
    selectionBox,
    selectionRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp
  } = useMarqueeSelection({
    activeTab,
    state,
    updateActiveTab,
    closeContextMenu
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
    console.log('[LAN useEffect] token/host/port:', ls.serverAccessToken, ls.serverHost, ls.serverPort);
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
  // 客户端关闭后心跳停止，服务端在 ONLINE_TIMEOUT_SECS（15s）后将其从列表移除。
  useEffect(() => {
    if (!lanConnected) return;
    const sendHeartbeat = () => {
      lanClientApi.heartbeat().catch((err) => {
        console.warn('[LAN] Heartbeat failed:', (err as Error).message);
      });
    };
    sendHeartbeat();
    const interval = setInterval(sendHeartbeat, 5000);
    return () => clearInterval(interval);
  }, [lanConnected]);

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
    handleOpenCompareInNewTab(imageIds);
    if (isAndroidSelectionMode) {
      setIsAndroidSelectionMode(false);
    }
  }, [handleOpenCompareInNewTab, isAndroidSelectionMode]);

  const handleDeselectAllAndroid = useCallback(() => {
    updateActiveTab({ selectedFileIds: [], lastSelectedId: null });
  }, [updateActiveTab]);

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
                viewingFileId: t.viewingFileId && ids.includes(t.viewingFileId) ? null : t.viewingFileId
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

              return { ...s, files: newFiles, tabs: updatedTabs, activeModal: { type: null } };
            });

            handleExitAndroidSelectionMode();
          },
          onCancel: () => {
            setState(s => ({ ...s, activeModal: { type: null } }));
          }
        }
      }
    }));
  }, [state.files, t, showToast, handleExitAndroidSelectionMode]);

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
    setIsLoading, setShowSplash, setShowWelcome, exitActionRef, setGroupBy,
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
    if (isAndroidSync() && next && state.layout.isMetadataVisible) {
      setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: next, isMetadataVisible: false } }));
    } else {
      setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: next } }));
    }
  };

  const toggleMetadata = () => {
    const next = !state.layout.isMetadataVisible;
    if (isAndroidSync() && next && state.layout.isSidebarVisible) {
      setState(s => ({ ...s, layout: { ...s.layout, isMetadataVisible: next, isSidebarVisible: false } }));
    } else {
      setState(s => ({ ...s, layout: { ...s.layout, isMetadataVisible: next } }));
    }
  };

  const onLayoutToggle = (part: 'sidebar' | 'metadata') => {
    if (part === 'sidebar') toggleSidebar(); else toggleMetadata();
  };

  // Track layout state changes (sidebar / metadata)
  const prevLayoutRef = useRef(state.layout);
  useEffect(() => {
    prevLayoutRef.current = state.layout;
  }, [state.layout.isSidebarVisible, state.layout.isMetadataVisible]);

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
  const exitActionRef2 = useRef(exitActionRef.current);
  exitActionRef2.current = exitActionRef.current;

  useEffect(() => {
    const handleAndroidBackPress = () => {
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

  const handleCloseAllTabs = () => { /* ... */ };
  const handleCloseOtherTabs = (id: string) => { /* ... */ };

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
  const panelWidthRem = (state.layout.isSidebarVisible ? 16 : 0) + (state.layout.isMetadataVisible ? 20 : 0);

  return (
    <div
      className="w-full h-full flex flex-col bg-white dark:bg-gray-900 text-gray-900 dark:text-gray-100 overflow-hidden font-sans transition-colors duration-300"
      onClick={closeContextMenu}
      onDragEnter={handleExternalDragEnter}
      onDragOver={handleExternalDragOver}
      onDrop={handleExternalDrop}
      onDragLeave={handleExternalDragLeave}
    >
      {/* 锟斤拷锟斤拷锟斤拷锟斤拷 */}
      <SplashScreen isVisible={showSplash} loadingInfo={loadingInfo} />

      {/* LAN 桌面图片下载进度遮罩 */}
      {lanDownloadProgress.active && (
        <div className="fixed inset-0 z-[400] bg-black/50 backdrop-blur-sm flex items-center justify-center pointer-events-auto">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-2xl px-8 py-6 flex flex-col items-center min-w-[220px]">
            <Loader2 size={28} className="text-blue-500 animate-spin mb-3" />
            <div className="text-sm font-medium text-gray-700 dark:text-gray-200 mb-2">
              {t('lanClient.downloading') || '正在下载桌面图片'}
            </div>
            <div className="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-200"
                style={{ width: `${lanDownloadProgress.total > 0 ? (lanDownloadProgress.completed / lanDownloadProgress.total) * 100 : 0}%` }}
              />
            </div>
            <div className="text-xs text-gray-500 dark:text-gray-400 mt-2">
              {lanDownloadProgress.completed} / {lanDownloadProgress.total}
            </div>
          </div>
        </div>
      )}

      {/* 锟解部锟斤拷拽锟斤拷锟角诧拷 */}
      <DragDropOverlay
        isVisible={isExternalDragging && !activeTab.isCompareMode}
        fileCount={externalDragItems.length}
        hoveredAction={hoveredDropAction}
        onHoverAction={setHoveredDropAction}
        t={t}
        targetPath={state.files[activeTab.folderId]?.path}
      />

      {/* ... (SVG filters) ... */}
      <svg style={{ display: 'none' }}><defs><filter id="channel-r"><feColorMatrix type="matrix" values="1 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter><filter id="channel-g"><feColorMatrix type="matrix" values="0 0 0 0 0  0 1 0 0 0  0 0 0 0 0  0 0 0 1 0" /></filter><filter id="channel-b"><feColorMatrix type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 1 0 0  0 0 0 1 0" /></filter><filter id="channel-l"><feColorMatrix type="saturate" values="0" /></filter></defs></svg>
      <TabBar tabs={state.tabs} activeTabId={state.activeTabId} files={state.files} topics={state.topics} people={peopleWithDisplayCounts} onSwitchTab={handleSwitchTab} onCloseTab={handleCloseTab} onNewTab={handleNewTab} onContextMenu={(e, id) => handleContextMenu(e, 'tab', id)} onCloseWindow={async () => {
        // Check user's exit action preference from ref (always latest value)
        const exitAction = exitActionRef.current;

        if (exitAction === 'minimize') {
          // Minimize to tray
          await hideWindow();
        } else if (exitAction === 'exit') {
          // Exit immediately
          await exitApp();
        } else {
          // Ask user (default behavior)
          setShowCloseConfirmation(true);
        }
      }} t={t} showWindowControls={!showSplash} isReferenceMode={isReferenceMode} onHoverChange={handleTopBarHoverChange} />
      <div className="flex-1 flex overflow-hidden relative"
        style={{ transition: 'width 300ms ease-out, height 300ms ease-out' }}>
        <div
          className="shrink-0 z-40 overflow-hidden bg-gray-50 dark:bg-gray-850"
          style={{ width: state.layout.isSidebarVisible ? '16rem' : '0rem', transition: 'width 300ms ease-out' }}>
          <div
            className="h-full flex flex-col border-r border-gray-200 dark:border-gray-800"
            style={{ width: '16rem', transform: state.layout.isSidebarVisible ? 'translateX(0)' : 'translateX(-100%)', transition: 'transform 300ms ease-out' }}>
            <Sidebar roots={state.roots} files={state.files} people={peopleWithDisplayCounts} customTags={state.customTags} currentFolderId={activeTab.folderId} expandedIds={state.expandedFolderIds} tasks={tasks} onToggle={handleToggleFolder} onNavigate={handleNavigateFolder} onTagSelect={enterTagView} onNavigateAllTags={enterTagsOverview} onPersonSelect={enterPersonView} onNavigateAllPeople={enterPeopleOverview} onContextMenu={handleContextMenu} isCreatingTag={isCreatingTag} onStartCreateTag={handleCreateNewTag} onSaveNewTag={handleSaveNewTag} onCancelCreateTag={handleCancelCreateTag} onOpenSettings={toggleSettings} onRestoreTask={onRestoreTask} onPauseResume={onPauseResume} onStartRenamePerson={onStartRenamePerson} onCreatePerson={handleCreatePerson} onNavigateTopics={handleNavigateTopics} onCreateTopic={handleCreateRootTopic} onDropOnFolder={handleDropOnFolder} onOpenCanvas={handleOpenCanvas} onNavigateHome={isAndroidPlatformCached() ? handleNavigateHome : undefined} activeViewMode={activeTab.viewMode} aiConnectionStatus={state.aiConnectionStatus} t={t} filesVersion={filesVersion} lanRoots={lanRoots} lanConnected={lanConnected} lanLoading={lanLoading} onNavigateNetworkFolder={handleNavigateNetworkFolder} onNavigateNetworkHome={handleNavigateNetworkHome} onOpenLanSettings={handleOpenLanSettings} />
          </div>
        </div>

        <div className="flex-1 flex flex-col min-w-0 relative bg-white dark:bg-gray-900">
          {activeTab.viewingFileId && (
            <ImageViewer
              file={state.files[activeTab.viewingFileId]}
              sortedFileIds={displayFileIds.filter(id => state.files[id].type === FileType.IMAGE)}
              files={state.files}
              layout={state.layout}
              slideshowConfig={state.slideshowConfig}
              onLayoutToggle={onLayoutToggle}
              onClose={closeViewer}
              onNext={(random) => handleViewerNavigate(random ? 'random' : 'next')}
              onPrev={() => handleViewerNavigate('prev')}
              onNavigateBack={goBack}
              onNavigateForward={goForward}
              canGoBack={activeTab.history.currentIndex > 0}
              canGoForward={activeTab.history.currentIndex < activeTab.history.stack.length - 1}
              onDelete={(id) => isAndroidDevice ? handleAndroidDelete([id]) : requestDelete([id])}
              onViewInExplorer={handleViewInExplorer}
              onCopyToFolder={(fileId) => setState(s => ({ ...s, activeModal: { type: 'copy-to-folder', data: { fileIds: [fileId] } } }))}
              onMoveToFolder={(fileId) => setState(s => ({ ...s, activeModal: { type: 'move-to-folder', data: { fileIds: [fileId] } } }))}
              onNavigateToFolder={(fid, options) => enterFolder(fid, options && options.targetId ? { scrollToItemId: options.targetId } : undefined)}
              searchQuery={activeTab.searchQuery}
              onSearch={handleViewerSearch}
              searchScope={activeTab.searchScope}
              onSearchScopeChange={(scope) => updateActiveTab({ searchScope: scope })}
              onUpdateSlideshowConfig={(cfg) => setState(s => ({ ...s, slideshowConfig: cfg }))}
              onPasteTags={(id) => handlePasteTags([id])}
              onEditTags={() => setState(s => ({ ...s, activeModal: { type: 'edit-tags', data: { fileId: activeTab.viewingFileId } } }))}
              onCopyTags={() => handleCopyTags([activeTab.viewingFileId!])}
              onAIAnalysis={(id) => handleAIAnalysis([id])}
              isAISearchEnabled={state.settings.search.isAISearchEnabled}
              onToggleAISearch={() => setState(s => ({ ...s, settings: { ...s.settings, search: { ...s.settings.search, isAISearchEnabled: !s.settings.search.isAISearchEnabled } } }))}
              t={t}
              activeTab={activeTab}
              tabs={state.tabs}
              handleOpenCompareInNewTab={handleOpenCompareAndClearSelection}
              handleAddToCompareCanvas={handleAddToCompareCanvas}
              enterImmersiveOnMount={state.settings.openInImmersiveByDefault}
            />
          )}
          {state.tabs.map(tab => tab.isCompareMode && (
            <div key={tab.id} className={`w-full h-full flex-1 flex flex-col overflow-hidden ${tab.id === state.activeTabId ? 'flex' : 'hidden'}`}>
              <ImageComparer
                selectedFileIds={tab.selectedFileIds}
                files={state.files}
                people={state.people}
                topics={state.topics}
                customTags={state.customTags}
                resourceRoot={state.settings.paths.resourceRoot}
                cachePath={state.settings.paths.cacheRoot}
                isActiveTab={tab.id === state.activeTabId}
                onClose={() => {
                  updateTabById(tab.id, { isCompareMode: false });
                  setIsReferenceMode(false);
                }}
                onCloseTab={() => {
                  handleCloseTab({ stopPropagation: () => { } } as any, tab.id);
                  setIsReferenceMode(false);
                }}
                onReady={() => {
                  // 图片加载完成后的回调，不需要清空 selectedFileIds
                  // 保留此回调用于未来可能的用途
                }}
                onLayoutToggle={onLayoutToggle}
                onNavigateBack={goBack}
                onSelect={(id) => updateTabById(tab.id, { selectedFileIds: [id] })}
                onSelectedFileIdsChange={(ids) => updateTabById(tab.id, { selectedFileIds: ids })}
                sessionName={tab.sessionName}
                onSessionNameChange={(name) => updateTabById(tab.id, { sessionName: name })}
                layoutProp={state.layout}
                canGoBack={tab.history.currentIndex > 0}
                t={t}
                onReferenceModeChange={handleReferenceModeChange}
                isReferenceMode={isReferenceMode}
              />
            </div>
          ))}
          <div className={`flex-1 flex flex-col min-w-0 relative ${activeTab.viewingFileId || activeTab.isCompareMode ? 'hidden' : 'flex'}`} style={{ height: '100%' }}>
            <input
              type="file"
              accept="image/*"
              multiple
              ref={lanUploadInputRef}
              onChange={handleUploadFilesSelected}
              className="hidden"
              aria-hidden="true"
            />
            {isAndroidDevice && isAndroidSelectionMode ? (
              <AndroidSelectionBar
                selectedCount={activeTab.selectedFileIds.length}
                totalCount={activeTab.viewMode === 'folders-overview' ? state.roots.filter(rid => state.files[rid]?.type === 'folder').length : displayFileIds.length}
                selectedFileIds={activeTab.selectedFileIds}
                files={state.files}
                activeTab={activeTab}
                peopleWithDisplayCounts={peopleWithDisplayCounts}
                t={t}
                onSelectAll={() => {
                  if (activeTab.viewMode === 'folders-overview') {
                    const folderIds = state.roots.filter(rid => state.files[rid]?.type === 'folder');
                    updateActiveTab({ selectedFileIds: folderIds });
                  } else {
                    updateActiveTab({ selectedFileIds: displayFileIds });
                  }
                }}
                onClearSelection={handleExitAndroidSelectionMode}
                onDeselectAll={handleDeselectAllAndroid}
                onDelete={handleAndroidDelete}
                onShowContextMenu={(x: number, y: number) => {
                  const selectedItems = activeTab.selectedFileIds.map(fileId => state.files[fileId]);
                  const allAreFolders = selectedItems.every(item => item && item.type === FileType.FOLDER);
                  let menuType: 'file-single' | 'file-multi' | 'folder-single' | 'folder-multi';
                  if (activeTab.selectedFileIds.length === 1) {
                    const file = state.files[activeTab.selectedFileIds[0]];
                    menuType = file?.type === FileType.FOLDER ? 'folder-single' : 'file-single';
                  } else {
                    menuType = allAreFolders ? 'folder-multi' : 'file-multi';
                  }
                  setContextMenu({ visible: true, x, y, type: menuType, targetId: activeTab.selectedFileIds[0] });
                }}
              />
            ) : (
            <TopBar
              activeTab={activeTab}
              state={state}
              toolbarQuery={toolbarQuery}
              groupedTags={groupedTags}
              tagSearchQuery={tagSearchQuery}
              onToggleSidebar={toggleSidebar}
              onGoBack={goBack}
              onGoForward={goForward}
              onNavigateUp={handleNavigateUp}
              onSetTagSearchQuery={setTagSearchQuery}
              onTagClick={handleTagClick}
              onRefresh={handleRefresh}
              onSearchScopeChange={(scope) => updateActiveTab({ searchScope: scope })}
              onPerformSearch={handlePerformSearch}
              onSetToolbarQuery={setToolbarQuery}
              onSetPersonSearchQuery={setPersonSearchQuery}
              personSearchQuery={personSearchQuery}
              onLayoutModeChange={(mode) => {
                updateActiveTab({ layoutMode: mode });
                // If not remembering this folder, update global default
                if (!state.folderSettings[activeTab.folderId]) {
                  setState(s => ({
                    ...s,
                    settings: {
                      ...s.settings,
                      defaultLayoutSettings: {
                        ...(s.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS),
                        layoutMode: mode
                      }
                    }
                  }));
                }
              }}
              onSortOptionChange={(opt) => {
                setState(s => ({ ...s, sortBy: opt }));
                // If not remembering this folder, update global default
                if (!state.folderSettings[activeTab.folderId]) {
                  setState(s => ({
                    ...s,
                    settings: {
                      ...s.settings,
                      defaultLayoutSettings: {
                        ...(s.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS),
                        sortBy: opt
                      }
                    }
                  }));
                }
              }}
              onSortDirectionChange={() => {
                const newDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
                setState(s => ({ ...s, sortDirection: newDirection }));
                // If not remembering this folder, update global default
                if (!state.folderSettings[activeTab.folderId]) {
                  setState(s => ({
                    ...s,
                    settings: {
                      ...s.settings,
                      defaultLayoutSettings: {
                        ...(s.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS),
                        sortDirection: newDirection
                      }
                    }
                  }));
                }
              }}
              onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
              onToggleMetadata={toggleMetadata}
              onToggleSettings={toggleSettings}
              onUpdateDateFilter={(f) => updateActiveTab({ dateFilter: f })}
              // Pagination
              totalResults={totalResults}
              pageSize={pageSize}
              onPageChange={(page) => updateActiveTab({ currentPage: page, scrollTop: 0 })}
              groupBy={groupBy}
              onGroupByChange={(groupByOption) => {
                setGroupBy(groupByOption);
                // If not remembering this folder, update global default
                if (!state.folderSettings[activeTab.folderId]) {
                  setState(s => ({
                    ...s,
                    settings: {
                      ...s.settings,
                      defaultLayoutSettings: {
                        ...(s.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS),
                        groupBy: groupByOption
                      }
                    }
                  }));
                }
              }}
              isAISearchEnabled={state.settings.search.isAISearchEnabled}
              onToggleAISearch={() => setState(s => ({ ...s, settings: { ...s.settings, search: { ...s.settings.search, isAISearchEnabled: !s.settings.search.isAISearchEnabled } } }))}
              onRememberFolderSettings={activeTab.viewMode === 'browser' ? handleRememberFolderSettings : undefined}
              // Topic layout control (used when in topics-overview)
              topicLayoutMode={topicLayoutMode}
              onTopicLayoutModeChange={handleTopicLayoutModeChange}
              folderLayoutMode={folderLayoutMode}
              onFolderLayoutModeChange={handleFolderLayoutModeChange}
              hasFolderSettings={activeTab.viewMode === 'browser' ? !!state.folderSettings[activeTab.folderId] : false}
              // People view sort and group
              personSortBy={personSortBy}
              personSortDirection={personSortDirection}
              personGroupBy={personGroupBy}
              onPersonSortByChange={handlePersonSortByChange}
              onPersonSortDirectionChange={handlePersonSortDirectionChange}
              onPersonGroupByChange={handlePersonGroupByChange}
              t={t}
              // CLIP Search
              isClipSearchEnabled={isClipSearchEnabled}
              onToggleClipSearch={() => setIsClipSearchEnabled(!isClipSearchEnabled)}
              clipEnabled={state.settings.clip.enabled}
              clipModelName={state.settings.clip.modelName}
              onOpenClipSettings={openClipSettings}
              showToast={showToast}
              showLanUpload={showLanUpload}
              onUploadToLan={handleUploadToLan}
            />
            )}
            {/* ... (Filter UI, same as before) ... */}
            {(activeTab.activeTags.length > 0 || activeTab.dateFilter.start || activeTab.activePersonId || activeTab.aiFilter || activeTab.searchQuery || totalResults > pageSize) && (
              <div className="flex items-center px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 space-x-2 overflow-x-auto shrink-0 z-20">
                <div className="flex items-center text-xs text-gray-500 dark:text-gray-400 mr-2 shrink-0">
                  <Filter size={12} className="mr-1" />
                  {t('context.filters')}
                </div>

                {activeTab.searchQuery && !activeTab.aiFilter && (
                  <div className="flex items-center bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs border border-blue-200 dark:border-blue-800 whitespace-nowrap">
                    {activeTab.searchScope === 'file' ? <FileText size={10} className="mr-1" /> :
                      activeTab.searchScope === 'tag' ? <Tag size={10} className="mr-1" /> :
                        activeTab.searchScope === 'folder' ? <Folder size={10} className="mr-1" /> :
                          <Globe size={10} className="mr-1" />}
                    <span>{activeTab.searchQuery}</span>
                    <button onClick={() => { setToolbarQuery(''); onPerformSearch(''); }} className="ml-1.5 hover:text-red-500 font-bold"><X size={12} /></button>
                  </div>
                )}

                {activeTab.aiFilter && (
                  activeTab.aiFilter.originalQuery.startsWith('color:') ? (
                    <div className="flex items-center bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-2 py-0.5 rounded-full text-xs border border-gray-200 dark:border-gray-700 whitespace-nowrap shadow-sm">
                      <div
                        className="w-3 h-3 rounded-full border border-gray-300 dark:border-gray-500 mr-1.5 flex-shrink-0 shadow-sm"
                        style={{ backgroundColor: activeTab.aiFilter.originalQuery.replace('color:', '').startsWith('#') ? activeTab.aiFilter.originalQuery.replace('color:', '') : '#' + activeTab.aiFilter.originalQuery.replace('color:', '') }}
                      />
                      <span className="font-mono">{activeTab.aiFilter.originalQuery.replace('color:', '')}</span>
                      <button onClick={() => updateActiveTab({ aiFilter: null })} className="ml-1.5 hover:text-red-500 text-gray-400"><X size={12} /></button>
                    </div>
                  ) : activeTab.aiFilter.originalQuery.startsWith('palette:') ? (
                    <div className="flex items-center bg-gray-100 dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-2 py-0.5 rounded-full text-xs border border-gray-200 dark:border-gray-700 whitespace-nowrap shadow-sm">
                      <div className="flex -space-x-1 mr-1.5">
                        {activeTab.aiFilter.originalQuery.replace('palette:', '').split(',').map((c, i) => (
                          <div
                            key={i}
                            className="w-3 h-3 rounded-full border border-white dark:border-gray-700 flex-shrink-0 shadow-sm z-10"
                            style={{ backgroundColor: c.startsWith('#') ? c : '#' + c }}
                          />
                        ))}
                      </div>
                      <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400">{t('meta.atmosphere')}</span>
                      <button onClick={() => updateActiveTab({ aiFilter: null })} className="ml-1.5 hover:text-red-500 text-gray-400"><X size={12} /></button>
                    </div>
                  ) : (
                    <div className="flex items-center bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 px-2 py-0.5 rounded-full text-xs border border-purple-200 dark:border-purple-800 whitespace-nowrap">
                      <Brain size={10} className="mr-1" />
                      <span>{t('settings.aiSmartSearch')}: "{activeTab.aiFilter.originalQuery}"</span>
                      <button onClick={() => updateActiveTab({ aiFilter: null })} className="ml-1.5 hover:text-red-500"><X size={12} /></button>
                    </div>
                  )
                )}

                {activeTab.dateFilter.start && (
                  <div className="flex items-center bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs border border-blue-200 dark:border-blue-800 whitespace-nowrap">
                    <Calendar size={10} className="mr-1" />
                    <span>{new Date(activeTab.dateFilter.start).toLocaleDateString()} {activeTab.dateFilter.end ? `- ${new Date(activeTab.dateFilter.end).toLocaleDateString()}` : ''}</span>
                    <button onClick={() => updateActiveTab({ dateFilter: { start: null, end: null, mode: 'created' as const } })} className="ml-1.5 hover:text-red-500"><X size={12} /></button>
                  </div>
                )}

                {activeTab.activePersonId && peopleWithDisplayCounts[activeTab.activePersonId] && (
                  <div className="flex items-center bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 px-2 py-0.5 rounded-full text-xs border border-purple-200 dark:border-purple-800 whitespace-nowrap">
                    <Brain size={10} className="mr-1" />
                    <span>{peopleWithDisplayCounts[activeTab.activePersonId].name}</span>
                    <button onClick={() => handleClearPersonFilter()} className="ml-1.5 hover:text-red-500"><X size={12} /></button>
                  </div>
                )}

                {activeTab.activeTags.map(tag => (
                  <div key={tag} className="flex items-center bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs border border-blue-200 dark:border-blue-800 whitespace-nowrap">
                    <span>{tag}</span>
                    <button onClick={() => handleClearTagFilter(tag)} className="ml-1.5 hover:text-red-500"><X size={12} /></button>
                  </div>
                ))}

                <button onClick={() => {
                  setToolbarQuery('');
                  updateActiveTab({
                    activeTags: [],
                    activePersonId: null,
                    searchQuery: '',
                    dateFilter: { start: null, end: null, mode: 'created' as const },
                    aiFilter: null
                  });
                }} className="text-xs text-gray-500 hover:text-red-500 underline ml-2 whitespace-nowrap">{t('context.clearAll')}</button>

                {/* Pagination & Count Display */}
                <div className="flex-1" />
                {totalResults > 0 && (
                  totalResults > pageSize ? (
                    <div className="flex items-center gap-1 ml-4 pr-1 px-1 bg-white/50 dark:bg-black/20 rounded shadow-sm border border-gray-200 dark:border-gray-800">
                      <button
                        disabled={(activeTab.currentPage || 1) <= 1}
                        onClick={() => updateActiveTab({ currentPage: (activeTab.currentPage || 1) - 1, scrollTop: 0 })}
                        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-20 rounded transition-colors"
                        title={t('search.prevPage')}
                      >
                        <ChevronLeft size={14} />
                      </button>
                      <div className="flex items-center text-[11px] font-medium px-2 min-w-[60px] justify-center select-none">
                        <span className="text-blue-500 font-bold">{activeTab.currentPage || 1}</span>
                        <span className="mx-1 text-gray-400">/</span>
                        <span className="text-gray-600 dark:text-gray-400">{Math.ceil(totalResults / pageSize)}</span>
                        <span className="ml-1 text-[9px] text-gray-400 font-normal">({totalResults})</span>
                      </div>
                      <button
                        disabled={(activeTab.currentPage || 1) >= Math.ceil(totalResults / pageSize)}
                        onClick={() => updateActiveTab({ currentPage: (activeTab.currentPage || 1) + 1, scrollTop: 0 })}
                        className="p-1 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-20 rounded transition-colors"
                        title={t('search.nextPage')}
                      >
                        <ChevronRight size={14} />
                      </button>
                    </div>
                  ) : (
                    (activeTab.searchQuery || activeTab.aiFilter || activeTab.activeTags.length > 0 || activeTab.activePersonId) && (
                      <div className="flex items-center text-[11px] font-medium px-2 py-0.5 bg-white/50 dark:bg-black/20 rounded border border-gray-200 dark:border-gray-800 text-gray-500">
                        {totalResults} {t('context.items')}
                      </div>
                    )
                  )
                )}
              </div>
            )}

            <div className="flex-1 flex flex-col relative bg-white dark:bg-gray-900 overflow-hidden">
              {activeTab.viewMode !== 'topics-overview' && activeTab.viewMode !== 'folders-overview' && state.settings.paths.resourceRoot !== 'android_media_store' && (
                <div className="h-14 flex items-center justify-between px-4 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900/50 backdrop-blur shrink-0 relative z-20">
                  {activeTab.viewMode === 'tags-overview' ? (
                    <div className="flex items-center w-full">
                      <div className="flex items-center">
                        <Tag size={12} className="mr-1" />
                        <span className="font-medium">{t('context.allTagsOverview')}</span>
                      </div>
                      <div className="flex-1 flex justify-end">
                        <button
                          onClick={() => setState(s => ({ ...s, activeModal: { type: 'auto-generate-tags' } }))}
                          className="flex items-center px-3 py-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 hover:bg-purple-100 dark:hover:bg-purple-900/50 rounded-lg transition-colors"
                        >
                          <Sparkles size={14} className="mr-1.5" />
                          {t('tags.autoGenerate') || '自动生成标签'}
                        </button>
                      </div>
                    </div>
                  ) : activeTab.viewMode === 'people-overview' ? (
                    <div className="flex items-center w-full">
                      <div className="flex items-center">
                        <User size={12} className="mr-1" />
                        <span>{t('context.allPeople')}</span>
                      </div>
                      <div className="flex-1 flex justify-end items-center gap-3">
                        <span className="text-[10px] opacity-60">
                          {Object.keys(peopleWithDisplayCounts).length} {t('context.items')}
                        </span>
                        <button
                          onClick={() => setState(s => ({ ...s, activeModal: { type: 'smart-create-person', data: {} } }))}
                          className="flex items-center px-3 py-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 hover:bg-purple-100 dark:hover:bg-purple-900/50 rounded-lg transition-colors"
                        >
                          <Sparkles size={14} className="mr-1.5" />
                          {t('context.smartCreatePerson') || '智能生成人物'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center w-full justify-between">
                      <div className="flex items-center space-x-1 overflow-hidden">
                        {!(activeTab.searchQuery || activeTab.aiFilter || activeTab.activeTags.length > 0 || activeTab.activePersonId || (activeTab.dateFilter.start && activeTab.dateFilter.end)) ? (
                          <>
                            <HardDrive size={12} />
                            <span>/</span>
                            {state.files[activeTab.folderId]?.path || state.files[activeTab.folderId]?.name}
                          </>
                        ) : (
                          <>
                            <Search size={12} className="text-blue-500" />
                            <span className="font-medium text-blue-500">{t('search.scopeAll')}</span>
                          </>
                        )}
                        {activeTab.activeTags.length > 0 && activeTab.searchScope !== 'tag' && <span className="text-blue-600 font-bold ml-2">{t('context.filtered')}</span>}
                      </div>
                      <div className="text-[10px] opacity-60">
                        {displayFileIds.length} {t('context.items')}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="flex-1 overflow-hidden relative" id="main-content-area">
                <div style={{ display: activeTab.viewMode === 'folders-overview' ? 'contents' : 'none' }}>
                  <FoldersOverview
                    roots={state.roots}
                    getFileNode={getFileNode}
                    resourceRoot={state.settings.paths.resourceRoot}
                    cachePath={state.settings.paths.cacheRoot}
                    onFolderClick={enterFolder}
                    thumbnailSize={state.thumbnailSize}
                    onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
                    t={t}
                    isLoadingImages={state.isScanning}
                    layoutMode={folderLayoutMode}
                    onLayoutModeChange={handleFolderLayoutModeChange}
                    isVisible={activeTab.viewMode === 'folders-overview'}
                    scrollTop={activeTab.viewMode === 'folders-overview' ? activeTab.scrollTop : undefined}
                    onScrollTopChange={handleFolderScrollTopChange}
                    isAndroidSelectionMode={isAndroidSelectionMode}
                    selectedFileIds={activeTab.selectedFileIds}
                    onFileLongPress={handleFolderLongPress}
                    onShowContextMenuForFile={handleShowContextMenuForFile}
                    onAndroidRangeSelect={handleFolderAndroidRangeSelect}
                    onFolderSelect={handleFolderSelect}
                    sortBy={state.sortBy}
                    sortDirection={state.sortDirection}
                    dateFilter={activeTab.dateFilter}
                    onRefresh={() => handleRefresh()}
                    panelWidthRem={panelWidthRem}
                  />
                </div>
                <div style={{ display: activeTab.viewMode === 'lan-folders-overview' ? 'contents' : 'none' }}>
                  <FoldersOverview
                    roots={lanRoots}
                    getFileNode={getFileNode}
                    resourceRoot={state.settings.paths.resourceRoot}
                    cachePath={state.settings.paths.cacheRoot}
                    onFolderClick={handleNavigateNetworkFolder}
                    thumbnailSize={state.thumbnailSize}
                    onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
                    t={t}
                    isLoadingImages={lanLoading}
                    layoutMode={folderLayoutMode}
                    onLayoutModeChange={handleFolderLayoutModeChange}
                    isVisible={activeTab.viewMode === 'lan-folders-overview'}
                    isAndroidSelectionMode={isAndroidSelectionMode}
                    selectedFileIds={activeTab.selectedFileIds}
                    onFileLongPress={handleFolderLongPress}
                    onShowContextMenuForFile={handleShowContextMenuForFile}
                    onAndroidRangeSelect={handleFolderAndroidRangeSelect}
                    onFolderSelect={handleFolderSelect}
                    sortBy={state.sortBy}
                    sortDirection={state.sortDirection}
                    onRefresh={handleLanRefresh}
                    panelWidthRem={panelWidthRem}
                  />
                </div>
                {activeTab.viewMode === 'topics-overview' ? (
                  <TopicModule
                    topics={state.topics}
                    files={state.files}
                    people={peopleForOverview}
                    currentTopicId={activeTab.activeTopicId || null}
                    selectedTopicIds={activeTab.selectedTopicIds || []} // Pass selectedTopicIds
                    onNavigateTopic={handleNavigateTopic}
                    onUpdateTopic={handleUpdateTopic}
                    onCreateTopic={handleCreateTopic}
                    onDeleteTopic={handleDeleteTopic}
                    onSelectTopics={(ids, lastId) => {
                      updateActiveTab({ selectedTopicIds: ids, selectedFileIds: [], selectedPersonIds: [], lastSelectedId: lastId ?? null });
                    }}
                    // onSelectFiles now accepts lastSelectedId; update to set both selectedFileIds and lastSelectedId
                    onSelectFiles={(ids, lastId) => {
                      updateActiveTab({ selectedFileIds: ids, selectedTopicIds: [], selectedPersonIds: [], lastSelectedId: lastId ?? null });
                    }}
                    onSelectPeople={(ids) => {
                      updateActiveTab({ selectedPersonIds: ids, selectedFileIds: [], selectedTopicIds: [] });
                    }}
                    onSelectPerson={(pid, e) => {
                      const isMultiSelect = e.ctrlKey || e.metaKey || e.shiftKey;
                      if (!isMultiSelect) {
                        updateActiveTab({ selectedFileIds: [], selectedTopicIds: [] });
                      }
                      handlePersonClick(pid, e);
                    }}
                    onNavigatePerson={handleNavigatePerson}
                    onOpenTopicInNewTab={handleOpenTopicInNewTab}
                    // New-tab & open-folder handlers for people/files inside TopicModule
                    onOpenPersonInNewTab={handleOpenPersonInNewTab}
                    onOpenFileInNewTab={handleOpenInNewTab}
                    onOpenFileFolder={handleNavigateFolder}
                    selectedFileIds={activeTab.selectedFileIds}
                    selectedPersonIds={activeTab.selectedPersonIds}
                    lastSelectedId={activeTab.lastSelectedId}
                    // Provide resource root / cache for thumbnails and open action
                    resourceRoot={state.settings.paths.resourceRoot}
                    cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)}
                    onOpenFile={handleFileDoubleClick}
                    onFileLongPress={handleFileLongPress}
                    t={t}
                    scrollTop={activeTab.scrollTop}
                    onScrollTopChange={(scrollTop) => { updateActiveTab({ scrollTop }); }}
                    isVisible={!activeTab.viewingFileId}
                    topicLayoutMode={(topicLayoutMode === 'grid' || topicLayoutMode === 'adaptive' || topicLayoutMode === 'masonry') ? topicLayoutMode : 'grid'}
                    onTopicLayoutModeChange={handleTopicLayoutModeChange}
                    onShowToast={showToast}
                    hoverPlayingId={hoverPlayingId}
                    onSetHoverPlayingId={setHoverPlayingId}
                    onSmartCreateTopic={() => setState(prev => ({ ...prev, activeModal: { type: 'smart-create-topic', data: {} } }))}
                  />
                ) : (
                  <FileGrid
                    displayFileIds={displayFileIds}
                    isVisible={!activeTab.viewingFileId}
                    getFileNode={getFileNode}
                    files={activeTab.viewMode === 'tags-overview' || activeTab.viewMode === 'people-overview' ? state.files : undefined}
                    activeTab={activeTab}
                    renamingId={state.renamingId}
                    thumbnailSize={state.thumbnailSize}
                    resourceRoot={state.settings.paths.resourceRoot}
                    cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)}
                    hoverPlayingId={hoverPlayingId}
                    onSetHoverPlayingId={setHoverPlayingId}
                    onFileClick={handleFileClick}
                    onFileDoubleClick={handleFileDoubleClick}
                    onContextMenu={(e, id) => handleContextMenu(e, 'file', id)}
                    onRenameSubmit={handleRenameSubmit}
                    onRenameCancel={() => setState(s => ({ ...s, renamingId: null }))}
                    onStartRename={startRename}
                    settings={state.settings}
                    containerRef={selectionRef}
                    onMouseDown={handleMouseDown}
                    onMouseMove={handleMouseMove}
                    onMouseUp={handleMouseUp}
                    onBackgroundContextMenu={(e) => handleContextMenu(e, 'background', '')}
                    people={peopleForOverview}
                    topics={state.topics}
                    groupedTags={groupedTags}
                    onPersonClick={(pid, e) => handlePersonClick(pid, e)}
                    onPersonContextMenu={(e, pid) => handleContextMenu(e, 'person', pid)}
                    onPersonDoubleClick={(pid) => enterPersonView(pid)}
                    onStartRenamePerson={(personId) => setState(s => ({ ...s, activeModal: { type: 'rename-person', data: { personId } } }))}
                    onTagClick={(tag, e) => handleOverviewTagClick(tag, e)}
                    onTagContextMenu={(e, tag) => handleContextMenu(e, 'tag', tag)}
                    onTagDoubleClick={(tag) => enterTagView(tag)}
                    groupedFiles={groupedFiles}
                    groupBy={groupBy}
                    collapsedGroups={collapsedGroups}
                    onToggleGroup={toggleGroup}
                    isSelecting={isSelecting}
                    selectionBox={selectionBox}
                    onScrollTopChange={(scrollTop) => { updateActiveTab({ scrollTop }); }}
                    onConsumeScrollToItem={() => updateActiveTab({ scrollToItemId: undefined })}
                    onScroll={handleScroll}
                    t={t}
                    onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
                    onUpdateFile={handleUpdateFile}
                    onDropOnFolder={handleDropOnFolder}
                    onDragStart={(fileIds) => setState(s => ({ ...s, dragState: { ...s.dragState, isDragging: true, draggedFileIds: fileIds } }))}
                    onDragEnd={() => setState(s => ({ ...s, dragState: { ...s.dragState, isDragging: false } }))}
                    isDraggingOver={isExternalDragging}
                    dragOverTarget={state.dragState.dragOverFolderId}
                    isDraggingInternal={isDraggingInternal}
                    setIsDraggingInternal={setIsDraggingInternal}
                    setDraggedFilePaths={setDraggedFilePaths}
                    onFileLongPress={handleFileLongPress}
                    onShowContextMenuForFile={handleShowContextMenuForFile}
                    isAndroidSelectionMode={isAndroidSelectionMode}
                    onAndroidRangeSelect={handleAndroidRangeSelect}
                    personSortBy={personSortBy}
                    personSortDirection={personSortDirection}
                    personGroupBy={personGroupBy}
                    onRefresh={() => handleRefresh(activeTab.folderId)}
                    panelWidthRem={panelWidthRem}
                  />
                )}
              </div>
            </div>
          </div>
        </div>
        <div
          className="metadata-panel-container shrink-0 z-40 overflow-hidden bg-gray-50 dark:bg-gray-850"
          style={{ width: state.layout.isMetadataVisible ? '20rem' : '0rem', transition: 'width 300ms ease-out' }}>
          <div
            className="h-full flex flex-col border-l border-gray-200 dark:border-gray-800"
            style={{ width: '20rem', transform: state.layout.isMetadataVisible ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 300ms ease-out' }}>
            <MetadataPanel
              files={state.files}
              selectedFileIds={activeTab.selectedFileIds}
              people={peopleWithDisplayCounts}
              topics={state.topics}
              selectedPersonIds={activeTab.selectedPersonIds}
              selectedTopicIds={activeTab.selectedTopicIds}
              onUpdate={handleUpdateFile}
              onUpdatePerson={handleUpdatePerson}
              onUpdateTopic={handleUpdateTopic}
              onDeleteTopic={handleDeleteTopic}
              onSelectTopic={handleNavigateTopic}
              onSelectPerson={handleNavigatePerson}
              onNavigateToFolder={handleNavigateFolder}
              onNavigateToTag={enterTagView}
              onSearch={onPerformSearch}
              t={t}
              activeTab={activeTab}
              resourceRoot={state.settings.paths.resourceRoot}
              cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)}
              filesVersion={filesVersion}
              settings={state.settings}
              aiConnectionStatus={state.aiConnectionStatus}
            />
          </div>
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
