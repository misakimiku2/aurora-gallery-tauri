
import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Sidebar } from './components/TreeSidebar';
import { MetadataPanel } from './components/MetadataPanel';
import { ImageViewer } from './components/ImageViewer';
import { ImageComparer } from './components/ImageComparer';
import { SequenceViewer } from './components/SequenceViewer';
import { TabBar } from './components/TabBar';
import { TopBar } from './components/TopBar';
import { FileGrid, InlineRenameInput, ImageThumbnail } from './components/FileGrid';
import { TopicModule } from './components/TopicModule';
import { SettingsModal } from './components/SettingsModal';
import { AuroraLogo } from './components/Logo';
import { CloseConfirmationModal } from './components/CloseConfirmationModal';
import { initializeFileSystem, formatSize } from './utils/mockFileSystem';
import { debug as logDebug, info as logInfo, warn as logWarn } from './utils/logger';
import { translations } from './utils/translations';
import { debounce } from './utils/debounce';
import { performanceMonitor } from './utils/performanceMonitor';
import { scanDirectory, scanFile, openDirectory, saveUserData as tauriSaveUserData, loadUserData as tauriLoadUserData, getDefaultPaths as tauriGetDefaultPaths, ensureDirectory, createFolder, renameFile, deleteFile, getThumbnail, hideWindow, showWindow, exitApp, copyFile, moveFile, writeFileFromBytes, pauseColorExtraction, resumeColorExtraction, searchByColor, searchByPalette, getAssetUrl, openPath, dbGetAllPeople, dbUpsertPerson, dbDeletePerson, dbUpdatePersonAvatar, dbUpsertFileMetadata, addPendingFilesToDb } from './api/tauri-bridge';
import { AppState, FileNode, FileType, SlideshowConfig, AppSettings, SearchScope, SortOption, TabState, LayoutMode, SUPPORTED_EXTENSIONS, DateFilter, SettingsCategory, AiData, TaskProgress, Person, Topic, HistoryItem, AiFace, GroupByOption, FileGroup, DeletionTask, AiSearchFilter } from './types';
import { Search, Folder, Image as ImageIcon, ArrowUp, X, FolderOpen, Tag, Folder as FolderIcon, Settings, Moon, Sun, Monitor, RotateCcw, Copy, Move, ChevronDown, FileText, Filter, Trash2, Undo2, Globe, Shield, QrCode, Smartphone, ExternalLink, Sliders, Plus, Layout, List, Grid, Maximize, AlertTriangle, Merge, FilePlus, ChevronRight, HardDrive, ChevronsDown, ChevronsUp, FolderPlus, Calendar, Server, Loader2, Database, Palette, Check, RefreshCw, Scan, Cpu, Cloud, FileCode, Edit3, Minus, User, Type, Brain, Sparkles, Crop, LogOut, XCircle, Pause, MoveHorizontal, Clipboard, Link } from 'lucide-react';
import { aiService } from './services/aiService';
import md5 from 'md5';

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
import { asyncPool } from './utils/async';

import { ToastItem } from './components/ToastItem';
import { TaskProgressModal } from './components/TaskProgressModal';

import { getPinyinGroup } from './utils/textUtils';
import { DUMMY_TAB } from './constants';


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

export const App: React.FC = () => {
  const [state, setState] = useState<AppState>({
    roots: [], files: {}, people: {}, topics: {}, expandedFolderIds: [], tabs: [], activeTabId: '', sortBy: 'name', sortDirection: 'asc', thumbnailSize: 180, renamingId: null, clipboard: { action: null, items: { type: 'file', ids: [] } }, customTags: [], folderSettings: {}, layout: { isSidebarVisible: true, isMetadataVisible: true },
    slideshowConfig: { interval: 3000, transition: 'fade', isRandom: false, enableZoom: true },
    settings: {
      theme: 'system',
      language: 'zh',
      autoStart: false,
      exitAction: 'ask',
      animateOnHover: true,
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
      }
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
  const [isCreatingTag, setIsCreatingTag] = useState(false);
  const [tagSearchQuery, setTagSearchQuery] = useState('');
  const [personSearchQuery, setPersonSearchQuery] = useState('');
  const lastSelectedTagRef = useRef<string | null>(null);
  const [toast, setToast] = useState<{ msg: string, visible: boolean }>({ msg: '', visible: false });
  const [toolbarQuery, setToolbarQuery] = useState('');
  const [groupBy, setGroupBy] = useState<GroupByOption>('none');
  // Topic layout mode: controlled by TopBar when viewing topics overview
  const [topicLayoutMode, setTopicLayoutMode] = useState<LayoutMode>(() => ((localStorage.getItem('aurora_topic_layout_mode') as LayoutMode) || 'grid'));
  const handleTopicLayoutModeChange = (mode: LayoutMode) => { setTopicLayoutMode(mode); try { localStorage.setItem('aurora_topic_layout_mode', mode); } catch (e) { } };
  const [rememberExitChoice, setRememberExitChoice] = useState(false);
  // Ref to store the latest exit action preference (to avoid closure issues)
  const exitActionRef = useRef<'ask' | 'minimize' | 'exit'>('ask');
  // State for close confirmation modal
  const [showCloseConfirmation, setShowCloseConfirmation] = useState(false);

  // Translation helper
  const t = useCallback((key: string): string => {
    const keys = key.split('.');
    let val: any = translations[state.settings.language];
    for (const k of keys) { val = val?.[k]; }
    return typeof val === 'string' ? val : key;
  }, [state.settings.language]);

  // Toast helper
  const showToast = useCallback((msg: string) => {
    setToast({ msg, visible: true });
    if (msg) {
      setTimeout(() => setToast({ msg: '', visible: false }), 2000);
    }
  }, []);

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
  const [isExternalDragging, setIsExternalDragging] = useState(false);
  const [externalDragItems, setExternalDragItems] = useState<string[]>([]);
  const [externalDragPosition, setExternalDragPosition] = useState<{ x: number; y: number } | null>(null);
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
    // 锟斤拷锟饺硷拷锟?Tauri 锟斤拷锟斤拷锟斤拷锟届步锟斤拷猓拷锟绞碉拷实锟斤拷锟?API锟斤拷
    const isTauriEnv = await detectTauriEnvironmentAsync();

    if (isTauriEnv) {
      // Tauri 锟斤拷锟斤拷 - 使锟斤拷 Tauri API
      try {
        return await tauriSaveUserData(data);
      } catch (error) {
        console.error('Failed to save user data in Tauri:', error);
        return false;
      }
    } else {
      return false;
    }
  };

  useEffect(() => {
    // 只锟斤拷 Tauri 锟斤拷锟斤拷锟铰憋拷锟斤拷锟斤拷锟斤拷
    // 注锟解：锟斤拷锟斤拷使锟斤拷同锟斤拷锟斤拷猓拷锟轿?useEffect 锟斤拷锟斤拷锟斤拷 async
    // 锟斤拷 saveUserData 锟节诧拷锟斤拷锟斤拷锟斤拷觳斤拷锟斤拷
    const isTauriEnv = isTauriEnvironment();

    if (!isTauriEnv) {
      return;
    }

    const rootPaths = state.roots.map(id => state.files[id]?.path).filter(Boolean);

    const fileMetadata: Record<string, any> = {};
    Object.values(state.files).forEach((file) => {
      const hasUserTags = file.tags && file.tags.length > 0;
      const hasDesc = !!file.description;
      const hasSource = !!file.sourceUrl;
      const hasAiData = !!file.aiData;
      const hasCategory = file.category && file.category !== 'general';
      const hasHeavyMeta = file.meta && (file.meta.width > 0 || file.meta.palette);

      if (hasUserTags || hasDesc || hasSource || hasAiData || hasCategory || hasHeavyMeta) {
        fileMetadata[file.path] = {
          tags: file.tags,
          description: file.description,
          sourceUrl: file.sourceUrl,
          aiData: file.aiData,
          category: file.category,
          meta: file.meta ? {
            width: file.meta.width,
            height: file.meta.height,
            palette: file.meta.palette,
            format: file.meta.format,
          } : undefined
        };
      }
    });

    const dataToSave = {
      rootPaths,
      customTags: state.customTags,
      people: peopleWithDisplayCounts,
      topics: state.topics,
      folderSettings: state.folderSettings,
      settings: state.settings,
      fileMetadata
    };

    const timer = setTimeout(async () => {
      try {
        await saveUserData(dataToSave);
      } catch (err) {
        console.error('Auto save failed:', err);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [state.roots, state.files, state.customTags, state.people, state.topics, state.settings, state.folderSettings]);

  useEffect(() => {
    // Prevent double initialization
    if (isAppInitialized) return;
    isAppInitialized = true;

    const init = async () => {
      // 锟斤拷锟饺硷拷锟?Tauri 锟斤拷锟斤拷锟斤拷锟届步锟斤拷猓拷锟绞碉拷实锟斤拷锟?API锟斤拷
      const isTauriEnv = await detectTauriEnvironmentAsync();
      if (isTauriEnv) {
        // Tauri 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟?
        const isTauriSyncEnv = isTauriEnvironment();
        let isSavedDataLoaded = false;

        if (isTauriSyncEnv) {
          // Tauri 锟斤拷锟斤拷锟斤拷锟斤拷锟皆硷拷锟截憋拷锟斤拷锟斤拷锟斤拷锟?
          try {
            // 锟饺伙拷取默锟斤拷路锟斤拷
            const defaults = await tauriGetDefaultPaths();
            // 然锟斤拷锟饺★拷锟斤拷锟斤拷锟斤拷锟斤拷
            const savedData = await tauriLoadUserData();

            // 锟较诧拷锟斤拷锟矫ｏ拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟侥拷锟斤拷锟斤拷锟?
            let finalSettings = {
              ...state.settings,
              paths: {
                ...state.settings.paths,
                ...defaults,
              }
            };

            if (savedData) {
              isSavedDataLoaded = true;

              // 锟斤拷锟斤拷斜锟斤拷锟斤拷锟斤拷锟捷ｏ拷锟较诧拷锟斤拷锟斤拷锟斤拷锟斤拷荩锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷
              finalSettings = {
                ...finalSettings,
                ...savedData.settings,
                paths: {
                  ...finalSettings.paths,
                  ...(savedData.settings?.paths || {})
                },
                ai: {
                  ...finalSettings.ai,
                  ...(savedData.settings?.ai || {})
                }
              };

              // Load people from DB
              let peopleData = savedData.people || {};
              try {
                const dbPeople = await dbGetAllPeople();
                if (Array.isArray(dbPeople) && dbPeople.length > 0) {
                  const dbPeopleMap: Record<string, Person> = {};
                  dbPeople.forEach((p: any) => { dbPeopleMap[p.id] = p; });
                  peopleData = dbPeopleMap;
                }
              } catch (e) { console.error("Failed to load people from DB", e); }

              // 锟斤拷锟斤拷 state 锟叫碉拷 customTags 锟斤拷 people
              setState(prev => ({
                ...prev,
                customTags: savedData.customTags || [],
                people: peopleData,
                topics: savedData.topics || {},
                folderSettings: savedData.folderSettings || {},
                settings: finalSettings
              }));
              // 标记已加载保存的数据，防止后续 effect 在初始化阶段覆盖它
              savedDataLoadedRef.current = true;
              setSavedDataLoaded(true);
              console.debug('[Init] Loaded saved user data, folderSettings keys:', Object.keys(savedData.folderSettings || {}));

              // 自动检测并连接 AI 提供者（例如 LM Studio），在每次启动时尝试连接
              (async () => {
                try {
                  setState(prev => ({ ...prev, aiConnectionStatus: 'checking' }));
                  const res = await aiService.checkConnection(finalSettings.ai);
                  if (res.status === 'connected') {
                    setState(prev => ({ ...prev, aiConnectionStatus: 'connected' }));

                    // 如果是 LM Studio，尝试检测模型并自动选择（如有变化）
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

              // 锟斤拷锟斤拷锟斤拷锟斤拷 ref 锟斤拷确锟斤拷锟铰硷拷锟斤拷锟斤拷锟斤拷使锟斤拷锟斤拷确锟斤拷值
              exitActionRef.current = finalSettings.exitAction || 'ask';
            } else {
              // 只锟斤拷默锟斤拷路锟斤拷锟斤拷锟斤拷锟斤拷 state
              setState(prev => ({
                ...prev,
                settings: finalSettings
              }));
              // 锟斤拷锟斤拷锟斤拷锟斤拷 ref
              exitActionRef.current = finalSettings.exitAction || 'ask';
            }

            // 确锟斤拷要扫锟斤拷锟铰凤拷锟斤拷斜锟?
            let pathsToScan: string[] = [];
            let validRootPaths: string[] = [];

            if (savedData?.rootPaths && Array.isArray(savedData.rootPaths) && savedData.rootPaths.length > 0) {
              // 锟饺癸拷锟剿碉拷锟斤拷锟皆的凤拷目录路锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷募锟斤拷锟秸癸拷锟斤拷锟铰凤拷锟斤拷锟?
              validRootPaths = savedData.rootPaths.filter((path: string) => {
                // 锟斤拷锟铰凤拷锟斤拷欠锟斤拷锟斤拷锟侥硷拷锟斤拷展锟斤拷
                const lastDotIndex = path.lastIndexOf('.');
                const lastSlashIndex = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
                // 锟斤拷锟矫伙拷械悖拷锟斤拷叩锟斤拷锟斤拷锟斤拷一锟斤拷斜锟斤拷之前锟斤拷锟斤拷么锟斤拷锟斤拷一锟斤拷目录
                return lastDotIndex === -1 || lastDotIndex < lastSlashIndex;
              });
            }

            // 如果没有保存的数据（首次运行），视为首次安装：显示欢迎向导并跳过默认目录扫描
            if (!savedData) {
              // 保留合并后的默认设置但不要自动扫描默认目录，从而让欢迎流程先进行
              setState(prev => ({ ...prev, settings: finalSettings }));
              setIsLoading(false);
              setShowWelcome(true);
              // 迅速隐藏启动画面
              setTimeout(() => setShowSplash(false), 200);
              return;
            }

            // 锟斤拷锟斤拷锟斤拷锟缴秆★拷锟矫伙拷锟斤拷锟叫凤拷锟斤拷锟斤拷锟斤拷锟矫伙拷斜锟斤拷锟斤拷路锟斤拷锟斤拷使锟斤拷默锟斤拷锟斤拷源锟斤拷目录
            if (validRootPaths.length === 0) {
              if (finalSettings.paths.resourceRoot) {
                pathsToScan = [finalSettings.paths.resourceRoot];
              }
            } else {
              pathsToScan = validRootPaths;
            }

            if (pathsToScan.length > 0) {
              let allFiles: Record<string, FileNode> = {};
              let allRoots: string[] = [];
              const savedMetadata = savedData?.fileMetadata || {};
              for (const p of pathsToScan) {
                try {
                  // 锟斤拷始锟斤拷录锟侥硷拷扫锟斤拷锟斤拷锟杰ｏ拷锟狡癸拷锟斤拷锟斤拷锟斤拷
                  const scanTimer = performanceMonitor.start('scanDirectory', undefined, true);

                  const result = await scanDirectory(p);

                  // 锟斤拷锟斤拷锟斤拷时锟斤拷锟斤拷录锟斤拷锟斤拷指锟斤拷
                  performanceMonitor.end(scanTimer, 'scanDirectory', {
                    path: p,
                    fileCount: Object.keys(result.files).length,
                    rootCount: result.roots.length
                  });

                  // 锟斤拷录扫锟斤拷锟侥硷拷锟斤拷锟斤拷
                  performanceMonitor.increment('filesScanned', Object.keys(result.files).length);

                  Object.values(result.files).forEach((f: any) => {
                    const saved = savedMetadata[f.path];
                    if (saved) {
                      if (saved.tags) f.tags = saved.tags;
                      if (saved.description) f.description = saved.description;
                      if (saved.sourceUrl) f.sourceUrl = saved.sourceUrl;
                      if (saved.aiData) f.aiData = saved.aiData;
                      if (saved.category) f.category = saved.category;
                      if (saved.meta && f.meta) {
                        if (saved.meta.width) f.meta.width = saved.meta.width;
                        if (saved.meta.height) f.meta.height = saved.meta.height;
                        if (saved.meta.palette) f.meta.palette = saved.meta.palette;
                      }
                    }
                  });

                  Object.assign(allFiles, result.files);
                  allRoots.push(...result.roots);
                } catch (err) {
                  console.error(`Failed to reload root: ${p}`, err);
                }
              }
              if (allRoots.length > 0) {
                setState(prev => {
                  const initialFolder = allRoots[0];
                  const defaultTab: TabState = { ...DUMMY_TAB, id: 'tab-default', folderId: initialFolder };
                  defaultTab.history = { stack: [{ folderId: initialFolder, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 };

                  // If we have saved folder settings for this initial folder, apply them immediately to the default tab
                  const savedForRoot = (savedData && savedData.folderSettings && typeof savedData.folderSettings === 'object') ? savedData.folderSettings[initialFolder] : undefined;
                  if (savedForRoot) {
                    console.debug('[Init] Applying saved folder settings to default tab', initialFolder, savedForRoot);
                    if (savedForRoot.layoutMode) defaultTab.layoutMode = savedForRoot.layoutMode as any;
                  }

                  return {
                    ...prev,
                    roots: allRoots,
                    files: allFiles,
                    expandedFolderIds: allRoots,
                    tabs: [defaultTab],
                    activeTabId: defaultTab.id,
                    // initialize sort settings from saved folder settings if present
                    sortBy: savedForRoot?.sortBy || prev.sortBy,
                    sortDirection: savedForRoot?.sortDirection || prev.sortDirection
                  };
                });

                // If savedForRoot exists, also apply groupBy (it's held in component state)
                const savedForRootOutside = (savedData && savedData.folderSettings && typeof savedData.folderSettings === 'object') ? savedData.folderSettings[allRoots[0]] : undefined;
                if (savedForRootOutside && savedForRootOutside.groupBy) {
                  setGroupBy(savedForRootOutside.groupBy as any);
                }

                // Mark initialization complete (saved-data loading finished/handled)
                savedDataLoadedRef.current = true;
                setSavedDataLoaded(true);
                console.debug('[Init] Initialization complete (roots loaded)');
                setIsLoading(false);
                // 锟斤拷目录锟斤拷锟斤拷锟斤拷希锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟?
                setTimeout(() => {
                  setShowSplash(false);
                }, 500);
                return;
              } else {
                // 锟斤拷然锟叫憋拷锟斤拷锟斤拷锟斤拷荩锟斤拷锟斤拷锟矫伙拷锟斤拷锟叫э拷母锟侥柯硷拷锟斤拷锟揭癸拷锟侥拷铣锟绞硷拷锟?
                isSavedDataLoaded = false;
              }
            }
          } catch (e) {
            console.error("Tauri initialization failed", e);
            // 锟斤拷始锟斤拷失锟杰ｏ拷使锟斤拷默锟较筹拷始锟斤拷
            isSavedDataLoaded = false;
          }
        }

        if (!isSavedDataLoaded) {
          // 锟斤拷锟矫伙拷屑锟斤拷氐锟斤拷锟斤拷锟斤拷锟斤拷锟捷ｏ拷使锟斤拷默锟较筹拷始锟斤拷
          const { roots, files } = initializeFileSystem();
          const initialFolder = roots[0];
          const defaultTab: TabState = { ...DUMMY_TAB, id: 'tab-default', folderId: initialFolder, history: { stack: [{ folderId: initialFolder, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 } };
          setState(prev => ({ ...prev, roots, files, people: {}, expandedFolderIds: roots, tabs: [defaultTab], activeTabId: defaultTab.id }));
        }

        // Mark initialization complete (saved-data loading finished/handled)
        savedDataLoadedRef.current = true;
        setSavedDataLoaded(true);
        console.debug('[Init] Initialization complete (no saved data)');

        setIsLoading(false);
        // 锟斤拷始锟斤拷锟斤拷桑锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟?
        setTimeout(() => {
          setShowSplash(false);
        }, 500);
      }
    };
    init();
  }, []);

  // ... (keep exit handler)
  const handleExitConfirm = async (action: 'minimize' | 'exit') => {
    if (rememberExitChoice) {
      const newSettings = {
        ...state.settings,
        exitAction: action
      };
      setState(prev => ({ ...prev, settings: newSettings, activeModal: { type: null } }));
      await saveUserData({
        rootPaths: state.roots.map(id => state.files[id]?.path).filter(Boolean),
        customTags: state.customTags,
        people: state.people,
        settings: newSettings,
        fileMetadata: {}
      });
    } else {
      setState(s => ({ ...s, activeModal: { type: null } }));
    }
    // Tauri锟斤拷锟斤拷锟铰的达拷锟节关憋拷锟竭硷拷锟斤拷Tauri锟斤拷艽锟斤拷锟?
  };

  const activeTab = useMemo(() => {
    return state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB;
  }, [state.tabs, state.activeTabId]);

  // Use a ref for activeTab to provide stable callbacks
  const activeTabRef = useRef(activeTab);
  useEffect(() => { activeTabRef.current = activeTab; }, [activeTab]);

  // Handle Special Search Queries (palette:, color:)
  useEffect(() => {
    const query = activeTab.searchQuery?.trim() || '';

    if (query.startsWith('palette:') || query.startsWith('color:')) {
      const isPalette = query.startsWith('palette:');
      const content = query.replace(/^(palette:|color:)/, '').trim();

      console.log('[ColorSearch] Query detected:', { isPalette, query, content });

      if (!content) {
        console.log('[ColorSearch] Empty content, skipping');
        return;
      }

      const colors = content.split(/[,\s]+/).map(c => c.trim()).filter(Boolean);
      console.log('[ColorSearch] Parsed colors:', colors);

      if (colors.length === 0) {
        console.log('[ColorSearch] No valid colors, skipping');
        return;
      }

      // Fetch results from Rust backend
      const searchFn = isPalette ? searchByPalette : searchByColor;
      const arg = isPalette ? colors : colors[0];

      console.log('[ColorSearch] Calling backend with:', { isPalette, arg });

      // @ts-ignore - Argument types are handled inside wrapper functions
      searchFn(arg).then((paths: string[]) => {
        console.log('[ColorSearch] Backend returned:', paths.length, 'paths');
        if (paths.length > 0) {
          console.log('[ColorSearch] Sample paths:', paths.slice(0, 3));
        }

        // Update active tab with AI Filter results
        // We map the results to aiFilter.filePaths to drive the view
        updateActiveTab({
          aiFilter: {
            keywords: [],
            colors: colors,
            people: [],
            description: '',
            filePaths: paths,
            originalQuery: query
          }
        });
      }).catch(err => {
        console.error('[ColorSearch] Backend error:', err);
      });
    } else {
      // Clear AI filter if we exit special search mode
      if (activeTab.aiFilter?.filePaths && activeTab.aiFilter.colors?.length > 0) {
        // Only clear if it looks like a color search (no keywords/people)
        if (!activeTab.aiFilter.keywords.length && !activeTab.aiFilter.people.length) {
          updateActiveTab({ aiFilter: undefined });
        }
      }
    }
  }, [activeTab.searchQuery]);


  // Update exitActionRef when state changes
  useEffect(() => {
    exitActionRef.current = state.settings.exitAction;
  }, [state.settings.exitAction]);

  // Listen for window close requests (Tauri only)
  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupCloseListener = async () => {
      try {
        // Only set up listener in Tauri environment
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();

        unlisten = await currentWindow.onCloseRequested(async (event) => {
          // Prevent default close behavior
          event.preventDefault();

          // Check user's exit action preference from ref (always latest value)
          const exitAction = exitActionRef.current;

          if (exitAction === 'minimize') {
            // Minimize to tray
            await hideWindow();
          } else if (exitAction === 'exit') {
            // Exit immediately
            currentWindow.destroy();
          } else {
            // Ask user (default behavior)
            setShowCloseConfirmation(true);
          }
        });
      } catch (error) {
        // Not in Tauri environment or error occurred, ignore
        logWarn('Window close listener not available', error);
      }
    };

    setupCloseListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []); // Empty dependency array - ref is always current


  // ... (keep welcome modal logic)
  useEffect(() => {
    if (!isLoading) {
      // 锟斤拷锟斤拷什么锟斤拷锟斤拷锟斤拷锟绞硷拷锟斤拷锟缴猴拷要锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷
      setTimeout(() => {
        setShowSplash(false);
      }, 500);

      if (state.roots.length === 0) {
        const hasOnboarded = localStorage.getItem('aurora_onboarded');
        if (!hasOnboarded) {
          // 锟斤拷示锟斤拷迎锟斤拷锟斤拷
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

  // Listen for scan progress events emitted by backend during onboarding scan
  useEffect(() => {
    let unlisten: any;
    let isMounted = true;
    const listenProgress = async () => {
      try {
        unlisten = await listen('scan-progress', (event: any) => {
          if (!isMounted) return;
          const payload = event.payload as { processed: number; total: number };
          setState(prev => ({ ...prev, scanProgress: { processed: payload.processed, total: payload.total } }));
        });
      } catch (e) {
        console.warn('Failed to listen for scan-progress', e);
      }
    };
    listenProgress();
    return () => { isMounted = false; if (unlisten) unlisten(); };
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
    };
    applyTheme();
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleChange = () => { if (state.settings.theme === 'system') applyTheme(); };
    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, [state.settings.theme]);

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
  const showDragHint = selectedCount > 1 && activeTab.viewMode !== 'topics-overview' && activeTaskCount === 0;

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

  const {
    displayFileIds,
    groupedFiles,
    collapsedGroups,
    toggleGroup,
    allFiles
  } = useFileSearch({ state, activeTab, groupBy, t });

  const handleOpenFolder = async () => {
    try {
      const path = await openDirectory();
      if (path) {
        // 确锟斤拷锟斤拷锟斤拷目录锟斤拷锟节ｏ拷锟斤拷锟斤拷源锟斤拷目录锟铰达拷锟斤拷 .Aurora_Cache 锟侥硷拷锟叫ｏ拷
        if (isTauriEnvironment()) {
          const cachePath = `${path}${path.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
          await ensureDirectory(cachePath);
        }

        // --- UX: 立刻创建并显示占位根（skeleton），避免等待后端扫描完成才能看到路径或文件列表 ---
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
          // 如果没有任何 tab，则创建默认 tab；否则把当前激活 tab 指向 skeleton
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
            settings: { ...prev.settings, paths: { ...prev.settings.paths, resourceRoot: path } },
            isScanning: true
          };
        });

        // Pause backend color extraction while initial scan runs (we'll resume when user finishes onboarding)
        (async () => {
          try {
            await pauseColorExtraction();
          } catch (err) {
            console.warn('Failed to pause color extraction:', err);
          }
          // Start scanning immediately but colors remain paused until resume
          scanAndMerge(path);
        })();


      }
    } catch (e) { console.error("Failed to open directory", e); }
  };

  const scanAndMerge = async (path: string) => {
    const scanTimer = performanceMonitor.start('scanDirectory', undefined, true);
    try {
      const result = await scanDirectory(path, true);

      performanceMonitor.end(scanTimer, 'scanDirectory', {
        path,
        fileCount: Object.keys(result.files).length,
        rootCount: result.roots.length
      });

      performanceMonitor.increment('filesScanned', Object.keys(result.files).length);

      // Collect all image paths and add to pending database
      const imagePaths: string[] = [];
      Object.values(result.files).forEach(file => {
        if (file.type === FileType.IMAGE) {
          imagePaths.push(file.path);
        }
      });

      // Add image paths to pending database in background
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
              resourceRoot: path
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

  const handleRefresh = async (folderId?: string) => {
    const targetFolderId = folderId || activeTab.folderId;
    const folder = state.files[targetFolderId];

    // Handle both Electron and Tauri environments
    if (folder?.path) {
      const path = folder.path;
      try {
        const result = await scanDirectory(path, true);
        setState(prev => {
          // Create a copy of all files
          const mergedFiles = { ...prev.files };

          // 1. Remove all files in the refreshed folder's subtree
          // First, identify all files in the subtree
          const filesToRemove = new Set<string>();
          const traverseAndMark = (fileId: string) => {
            filesToRemove.add(fileId);
            const file = prev.files[fileId];
            if (file && file.children) {
              file.children.forEach(childId => traverseAndMark(childId));
            }
          };
          traverseAndMark(targetFolderId);

          // Then remove them from mergedFiles
          filesToRemove.forEach(fileId => {
            delete mergedFiles[fileId];
          });

          // 2. Merge new files with existing ones, preserving user data
          Object.entries(result.files).forEach(([fileId, newFile]) => {
            const existingFile = prev.files[fileId];
            if (existingFile) {
              // Merge files, preserving user-customized data
              mergedFiles[fileId] = {
                ...newFile,
                // Preserve user-added information
                tags: existingFile.tags,
                description: existingFile.description,
                url: existingFile.url,
                aiData: existingFile.aiData,
                sourceUrl: existingFile.sourceUrl,
                author: existingFile.author,
                category: existingFile.category,
                // Use new children from scan to reflect file system changes (add/remove)
                children: newFile.children || existingFile.children,
                // IMPORTANT: Preserve parentId for the scanned root to maintain tree structure
                parentId: (fileId === targetFolderId) ? existingFile.parentId : newFile.parentId
              };
            } else {
              // New file, add as-is
              mergedFiles[fileId] = newFile;
            }
          });

          return { ...prev, files: mergedFiles };
        });
      } catch (e) {
        console.error("Failed to refresh directory", e);
      }
    } else if (folder) {
      // Handle virtual folders with no actual path
      setState(prev => {
        // Force a complete re-render by updating the folder's lastRefresh timestamp
        const files = { ...prev.files };
        files[targetFolderId] = {
          ...folder,
          // Add a lastRefresh timestamp to force a re-render
          lastRefresh: Date.now()
        };

        return { ...prev, files };
      });
    }
  };


  const handleFileClick = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();

    // 锟截憋拷锟揭硷拷锟剿碉拷
    closeContextMenu();

    // If we just finished a selection box operation, don't process the click
    if (isSelecting) return;

    const isCtrl = e.ctrlKey || e.metaKey; // Ctrl for Windows/Linux, Command for macOS
    const isShift = e.shiftKey;

    let newSelectedFileIds: string[];
    let newLastSelectedId: string = id;

    if (isCtrl) {
      // Ctrl+Click: Toggle selection of this file
      if (activeTab.selectedFileIds.includes(id)) {
        // Remove from selection
        newSelectedFileIds = activeTab.selectedFileIds.filter(fileId => fileId !== id);
      } else {
        // Add to selection
        newSelectedFileIds = [...activeTab.selectedFileIds, id];
      }
    } else if (isShift && activeTab.lastSelectedId && activeTab.selectedFileIds.length > 0) {
      // Shift+Click: Select range from last selected to current
      const currentFolderId = activeTab.folderId;
      let allFiles: string[] = [];

      if (activeTab.searchQuery) {
        // Search results view
        allFiles = displayFileIds;
      } else {
        // Folder view - use displayFileIds which already contains the sorted and filtered list of files to display
        allFiles = displayFileIds;
      }

      const lastIndex = allFiles.indexOf(activeTab.lastSelectedId);
      const currentIndex = allFiles.indexOf(id);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        newSelectedFileIds = allFiles.slice(start, end + 1);
      } else {
        newSelectedFileIds = [id];
      }
    } else {
      // Normal click: Select only this file
      newSelectedFileIds = [id];
    }

    updateActiveTab({
      selectedFileIds: newSelectedFileIds,
      lastSelectedId: newLastSelectedId
    });
  };

  const groupedTags: Record<string, string[]> = useMemo(() => { const allTags = new Set<string>(state.customTags); (Object.values(state.files) as FileNode[]).forEach(f => f.tags.forEach(t => allTags.add(t))); const filteredTags = Array.from(allTags).filter(t => !tagSearchQuery || t.toLowerCase().includes(tagSearchQuery.toLowerCase())); const groups: Record<string, string[]> = {}; filteredTags.forEach(tag => { const key = getPinyinGroup(tag); if (!groups[key]) groups[key] = []; groups[key].push(tag); }); const sortedKeys = Object.keys(groups).sort(); return sortedKeys.reduce((obj, key) => { obj[key] = groups[key].sort((a, b) => a.localeCompare(b, state.settings.language)); return obj; }, {} as Record<string, string[]>); }, [state.files, state.settings.language, state.customTags, tagSearchQuery]);
  // Memoized person counts to avoid recalculating every time
  const personCounts = useMemo(() => {
    // 锟斤拷始锟斤拷录锟斤拷员锟斤拷锟斤拷锟斤拷锟斤拷
    const timer = performance.now();
    const counts = new Map<string, number>();

    // Initialize all people with 0 count
    Object.keys(state.people).forEach(personId => {
      counts.set(personId, 0);
    });

    // Count files per person
    Object.values(state.files).forEach(file => {
      if (file.type === FileType.IMAGE && file.aiData?.faces) {
        const personIds = new Set(file.aiData.faces.map(face => face.personId));
        personIds.forEach(personId => {
          counts.set(personId, (counts.get(personId) || 0) + 1);
        });
      }
    });

    // 锟斤拷录锟斤拷锟斤拷指锟斤拷
    const duration = performance.now() - timer;
    performanceMonitor.timing('personCounts', duration, {
      personCount: Object.keys(state.people).length,
      fileCount: Object.keys(state.files).length
    });

    return counts;
  }, [state.files, state.people]);

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

      // 锟街久伙拷锟斤拷锟斤拷锟捷匡拷
      if (updates.tags || updates.description || updates.sourceUrl || updates.aiData) {
        const file = prev.files[id];
        if (file) {
          const mergedFile = { ...file, ...updates };
          dbUpsertFileMetadata({
            fileId: id,
            path: mergedFile.path,
            tags: mergedFile.tags,
            description: mergedFile.description,
            sourceUrl: mergedFile.sourceUrl,
            aiData: mergedFile.aiData,
            updatedAt: Date.now()
          }).catch(err => console.error('Failed to persist file metadata:', err));
        }
      }

      return { ...prev, files: updatedFiles, people: updatedPeople };
    });
  };

  const {
    handleCopyFiles, handleMoveFiles, handleExternalCopyFiles, handleExternalMoveFiles,
    handleDropOnFolder, handleBatchRename, handleRenameSubmit, requestDelete,
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

  const handleExternalDragEnter = (e: React.DragEvent) => {
    // 如果当前正在进行由应用内部发起的“拖拽到外部”操作（通过 Alt 启动），忽略进入事件避免显示覆盖层
    // 有时候内部发起的拖拽会比 React state 更新更早触发 dragenter（race），因此也检查 Alt 修饰键作为备用判断
    if (isDraggingInternal || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    // 检查是否为外部文件拖拽(而不是内部拖拽)
    // 内部拖拽会设置 'application/json' 类型
    const hasFiles = e.dataTransfer.types.includes('Files');
    const hasInternalData = e.dataTransfer.types.includes('application/json');

    // 只有当是外部文件拖拽时才显示覆盖层
    if (hasFiles && !hasInternalData) {
      externalDragCounter.current++;
      if (externalDragCounter.current === 1) {
        setIsExternalDragging(true);
      }

      // 获取文件数量
      const itemCount = e.dataTransfer.items?.length || 0;
      if (itemCount > 0) {
        // 创建文件路径占位符数组(实际路径在 drop 时才能获取)
        setExternalDragItems(Array(itemCount).fill(''));
      }
    }
  };

  const handleExternalDragOver = (e: React.DragEvent) => {
    // 忽略应用内部发起的向外拖拽（Alt + 拖拽）以防止显示覆盖层
    // 考虑到 React state 更新可能滞后，额外使用 Alt 修饰键作为快速判定以避免 race condition
    if (isDraggingInternal || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    // 检查是否为外部文件拖拽
    const hasFiles = e.dataTransfer.types.includes('Files');
    const hasInternalData = e.dataTransfer.types.includes('application/json');

    if (hasFiles && !hasInternalData) {
      setExternalDragPosition({ x: e.clientX, y: e.clientY });
    }
  };

  const handleExternalDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    externalDragCounter.current--;
    if (externalDragCounter.current <= 0) {
      externalDragCounter.current = 0;
      setIsExternalDragging(false);
      setExternalDragPosition(null);
      setExternalDragItems([]);
    }
  };

  const handleExternalDrop = async (e: React.DragEvent) => {
    // 如果是内部发起的向外拖拽，则忽略 drop 事件
    // 同样防御 race：检查 Alt 修饰键
    if (isDraggingInternal || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    externalDragCounter.current = 0;
    setIsExternalDragging(false);
    setExternalDragPosition(null);
    setExternalDragItems([]);

    const files = Array.from(e.dataTransfer.files);
    const items = e.dataTransfer.items;

    // 如果没有文件但有 items,可能是文件夹拖拽
    if (files.length === 0 && items && items.length > 0) {
      // 尝试处理文件夹
      if (hoveredDropAction === 'copy') {
        await handleExternalCopyFiles(files, items);
      }
      return;
    }

    if (files.length === 0) return;

    if (hoveredDropAction === 'copy') {
      await handleExternalCopyFiles(files, items);
    } else {
      await handleExternalMoveFiles(files);
    }
  };

  // Helper function to limit concurrency
  // Moved to src/utils/async.ts

  const handleCopyImageToClipboard = async (fileId: string) => {
    const file = state.files[fileId];
    if (!file || file.type !== FileType.IMAGE) return;
    // TODO: Implement copyImage for Tauri
    showToast(t('context.imageCopied'));
  };

  const handleDropOnTag = (tag: string, sourceIds: string[]) => { /* ... */ };
  const startRename = (id: string) => setState(s => ({ ...s, renamingId: id }));
  const handleResolveExtensionChange = (id: string, name: string) => handleUpdateFile(id, { name });
  const handleResolveFileCollision = (fileId: string, desiredName: string) => { /* ... */ };
  const handleResolveFolderMerge = (sourceId: string, targetId: string) => { /* ... */ };

  const requestDeleteTags = (tags: string[]) => {
    setState(s => ({ ...s, activeModal: { type: 'confirm-delete-tag', data: { tags } } }));
  };

  const handleConfirmDeleteTags = (tags: string[]) => {
    setState(prev => {
      const newFiles = { ...prev.files };
      const newCustomTags = prev.customTags.filter(tag => !tags.includes(tag));

      // Update all files that use the deleted tags
      Object.values(newFiles).forEach(file => {
        if (file.tags) {
          file.tags = file.tags.filter(tag => !tags.includes(tag));
        }
      });

      return {
        ...prev,
        files: newFiles,
        customTags: newCustomTags
      };
    });
  };

  const handleCopyTags = (ids: string[]) => {
    const allTags = new Set<string>();
    ids.forEach(id => state.files[id]?.tags.forEach(t => allTags.add(t)));
    setState(s => ({ ...s, clipboard: { action: 'copy', items: { type: 'tag', ids: Array.from(allTags) } } }));
    showToast(t('context.copied'));
  };

  const handlePasteTags = (targetIds: string[]) => {
    if (state.clipboard.items.type !== 'tag') return;
    const tagsToAdd = state.clipboard.items.ids;
    setState(prev => {
      const newFiles = { ...prev.files };
      targetIds.forEach(id => {
        const file = newFiles[id];
        if (file) {
          const newTags = Array.from(new Set([...file.tags, ...tagsToAdd]));
          newFiles[id] = { ...file, tags: newTags };
        }
      });
      return { ...prev, files: newFiles };
    });
    showToast("Tags pasted");
  };

  const handleCreateNewTag = () => {
    setIsCreatingTag(true);
    if (!state.layout.isSidebarVisible) {
      logInfo('[App] ensureSidebarOpen', { action: 'ensureSidebarOpen' });
      setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: true } }));
    }
  };

  const handleSaveNewTag = (name: string) => {
    if (name && name.trim()) {
      const tag = name.trim();
      if (!state.customTags.includes(tag)) {
        setState(s => ({ ...s, customTags: [...s.customTags, tag] }));
      }
    }
    setIsCreatingTag(false);
  };

  const handleCancelCreateTag = () => {
    setIsCreatingTag(false);
  };

  const handleOverviewTagClick = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation();

    const isCtrl = e.ctrlKey || e.metaKey; // Ctrl for Windows/Linux, Command for macOS
    const isShift = e.shiftKey;

    let newSelectedTagIds: string[];

    // Get all tags in the current view, sorted
    const allTags = groupedTags ? Object.values(groupedTags).flat() : [];

    if (isCtrl) {
      // Ctrl+Click: Toggle selection of this tag
      if (activeTab.selectedTagIds.includes(tag)) {
        // Remove from selection
        newSelectedTagIds = activeTab.selectedTagIds.filter(tagId => tagId !== tag);
      } else {
        // Add to selection
        newSelectedTagIds = [...activeTab.selectedTagIds, tag];
      }
    } else if (isShift && activeTab.selectedTagIds.length > 0) {
      // Shift+Click: Select range from last selected to current
      const lastSelectedTag = activeTab.selectedTagIds[activeTab.selectedTagIds.length - 1];
      const lastIndex = allTags.indexOf(lastSelectedTag);
      const currentIndex = allTags.indexOf(tag);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        newSelectedTagIds = allTags.slice(start, end + 1);
      } else {
        newSelectedTagIds = [tag];
      }
    } else {
      // Normal click: Select only this tag
      newSelectedTagIds = [tag];
    }

    updateActiveTab({ selectedTagIds: newSelectedTagIds });
  };

  const handleTagClick = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeContextMenu();
    updateActiveTab({ activeTags: [tag] });
  };

  const handlePersonClick = (personId: string, e: React.MouseEvent) => {
    e.stopPropagation();

    closeContextMenu();

    // If we just finished a selection box operation, don't process the click
    if (isSelecting) return;

    const isCtrl = e.ctrlKey || e.metaKey; // Ctrl for Windows/Linux, Command for macOS
    const isShift = e.shiftKey;

    let newSelectedPersonIds: string[];
    let newLastSelectedId: string = personId;

    // Use derived peopleWithDisplayCounts to match UI sorting
    let allPeople = Object.values(peopleWithDisplayCounts);

    // Apply search filter if present, same as in FileGrid
    if (activeTab.searchQuery && activeTab.searchQuery.trim()) {
      const query = activeTab.searchQuery.toLowerCase().trim();
      allPeople = allPeople.filter(person =>
        person.name.toLowerCase().includes(query)
      );
    }

    // Sort people by count descending, same as in PersonGrid
    // We must match the display order for range selection to work correctly.
    allPeople.sort((a, b) => b.count - a.count);

    const allPersonIds = allPeople.map(person => person.id);

    if (isCtrl) {
      // Ctrl+Click: Toggle selection of this person
      if (activeTab.selectedPersonIds.includes(personId)) {
        // Remove from selection
        newSelectedPersonIds = activeTab.selectedPersonIds.filter(id => id !== personId);
      } else {
        // Add to selection
        newSelectedPersonIds = [...activeTab.selectedPersonIds, personId];
      }
      // Always set lastSelectedId to current click, same as file handling
      newLastSelectedId = personId;
    } else if (isShift) {
      // Shift+Click: Select range from last selected to current
      let lastSelectedId = activeTab.lastSelectedId;

      // If no lastSelectedId, use the first selected person or current person
      if (!lastSelectedId) {
        lastSelectedId = activeTab.selectedPersonIds.length > 0 ? activeTab.selectedPersonIds[0] : personId;
      }

      const lastIndex = allPersonIds.indexOf(lastSelectedId);
      const currentIndex = allPersonIds.indexOf(personId);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        newSelectedPersonIds = allPersonIds.slice(start, end + 1);
      } else {
        newSelectedPersonIds = [personId];
      }
    } else {
      // Normal click: Select only this person
      newSelectedPersonIds = [personId];
    }

    updateActiveTab({
      selectedPersonIds: newSelectedPersonIds,
      lastSelectedId: newLastSelectedId
    });
  };

  const handleRenameTag = (oldTag: string, newTag: string) => {
    if (!newTag.trim() || oldTag === newTag) return;

    const trimmedNewTag = newTag.trim();

    setState(prev => {
      const newFiles = { ...prev.files };
      let newCustomTags = [...prev.customTags];

      // Update all files that use the old tag
      Object.values(newFiles).forEach(file => {
        if (file.tags && file.tags.includes(oldTag)) {
          file.tags = file.tags.map(tag => tag === oldTag ? trimmedNewTag : tag);
        }
      });

      // Update custom tags list
      if (newCustomTags.includes(oldTag)) {
        newCustomTags = newCustomTags.map(tag => tag === oldTag ? trimmedNewTag : tag);
      }

      // Update tabs with tag references
      const newTabs = prev.tabs.map(tab => {
        let updatedTab = { ...tab };

        // Update tab's search query if it's searching for the old tag
        if (updatedTab.searchQuery === oldTag) {
          updatedTab.searchQuery = trimmedNewTag;
        }

        // Update tab's active tags if the old tag is active
        if (updatedTab.activeTags.includes(oldTag)) {
          updatedTab.activeTags = updatedTab.activeTags.map(tag => tag === oldTag ? trimmedNewTag : tag);
        }

        // Update tab's selected tag ids if the old tag is selected
        if (updatedTab.selectedTagIds.includes(oldTag)) {
          updatedTab.selectedTagIds = updatedTab.selectedTagIds.map(tag => tag === oldTag ? trimmedNewTag : tag);
        }

        return updatedTab;
      });

      return {
        ...prev,
        files: newFiles,
        customTags: newCustomTags,
        tabs: newTabs,
        activeModal: { type: null }
      };
    });
  };

  const handleRenamePerson = (personId: string, newName: string) => {
    if (!newName.trim()) return;
    setState(prev => {
      const updatedPerson = { ...prev.people[personId], name: newName };
      dbUpsertPerson(updatedPerson).catch(e => console.error("Failed to update person name in DB", e));

      return {
        ...prev,
        people: {
          ...prev.people,
          [personId]: updatedPerson
        },
        activeModal: { type: null }
      };
    });
  };

  const handleUpdatePerson = (personId: string, updates: Partial<Person>) => {
    setState(prev => {
      const updatedPerson = { ...prev.people[personId], ...updates };
      dbUpsertPerson(updatedPerson).catch(e => console.error("Failed to update person in DB", e));

      return {
        ...prev,
        people: {
          ...prev.people,
          [personId]: updatedPerson
        }
      };
    });
  };

  const handleCreatePerson = () => {
    const newId = Math.random().toString(36).substr(2, 9);
    const newPerson: Person = {
      id: newId,
      name: t('context.newPersonDefault'),
      coverFileId: '',
      count: 0,
      description: ''
    };

    // Save to database
    dbUpsertPerson(newPerson).catch(e => console.error("Failed to create person in DB", e));

    setState(prev => ({
      ...prev,
      people: { ...prev.people, [newId]: newPerson },
      activeModal: { type: 'rename-person', data: { personId: newId } }
    }));
  };

  const handleDeletePerson = (personId: string | string[]) => {
    const idsToDelete = typeof personId === 'string' ? [personId] : personId;
    idsToDelete.forEach(id => {
      dbDeletePerson(id).catch(e => console.error("Failed to delete person from DB", e));
    });

    setState(prev => {
      const newPeople = { ...prev.people };

      // Handle both single person and multiple people deletion
      idsToDelete.forEach(id => {
        delete newPeople[id];
      });

      return { ...prev, people: newPeople, activeModal: { type: null } };
    });
  };

  const handleManualAddPerson = (personId: string) => {
    const fileIds = activeTab.selectedFileIds;
    if (fileIds.length === 0) {
      setState(s => ({ ...s, activeModal: { type: null } }));
      return;
    }
    setState(prev => {
      const newFiles = { ...prev.files };
      const newPeople = { ...prev.people };
      const person = newPeople[personId];
      if (!person) return prev;

      let updated = false;
      let countIncrease = 0;

      fileIds.forEach(fid => {
        const file = newFiles[fid];
        if (file && file.type === FileType.IMAGE) {
          const currentFaces = file.aiData?.faces || [];
          if (!currentFaces.some(f => f.personId === personId)) {
            const newFace: AiFace = {
              id: Math.random().toString(36).substr(2, 9),
              personId: personId,
              name: person.name,
              confidence: 1.0,
              box: { x: 0, y: 0, w: 0, h: 0 }
            };
            const newAiData = file.aiData ? { ...file.aiData, faces: [...currentFaces, newFace] } : {
              analyzed: false,
              analyzedAt: new Date().toISOString(),
              description: '',
              tags: [],
              faces: [newFace],
              sceneCategory: '',
              confidence: 1.0,
              dominantColors: [],
              objects: []
            };
            newFiles[fid] = { ...file, aiData: newAiData };
            countIncrease++;
            updated = true;
          }
        }
      });

      if (updated) {
        // 一锟斤拷锟皆革拷锟斤拷锟斤拷锟斤拷锟絚ount
        newPeople[personId] = {
          ...person,
          count: person.count + countIncrease,
          coverFileId: person.coverFileId || fileIds[0]
        };

        return { ...prev, files: newFiles, people: newPeople, activeModal: { type: null } };
      }
      return { ...prev, activeModal: { type: null } };
    });
    showToast(t('context.saved'));
  };

  const handleManualAddToTopic = (topicId: string) => {
    // Get IDs from modal data or active selection
    let targetFileIds: string[] = [];
    let targetPersonIds: string[] = [];

    // Check modal data first
    if (state.activeModal.type === 'add-to-topic' && state.activeModal.data) {
      if (state.activeModal.data.fileIds) targetFileIds = state.activeModal.data.fileIds;
      if (state.activeModal.data.personIds) targetPersonIds = state.activeModal.data.personIds;
    }

    // Fallback to active selection if modal data is empty/null
    if (targetFileIds.length === 0 && targetPersonIds.length === 0) {
      if (activeTab.viewMode === 'people-overview') {
        targetPersonIds = activeTab.selectedPersonIds;
      } else {
        targetFileIds = activeTab.selectedFileIds;
      }
    }

    if (targetFileIds.length === 0 && targetPersonIds.length === 0) {
      setState(s => ({ ...s, activeModal: { type: null } }));
      return;
    }

    setState(current => {
      const topic = current.topics[topicId];
      if (!topic) return current;

      const updatedTopic = { ...topic };

      if (targetFileIds.length > 0) {
        const existingFiles = new Set(updatedTopic.fileIds || []);
        targetFileIds.forEach(id => existingFiles.add(id));
        updatedTopic.fileIds = Array.from(existingFiles);
      }

      if (targetPersonIds.length > 0) {
        const existingPeople = new Set(updatedTopic.peopleIds || []);
        targetPersonIds.forEach(id => existingPeople.add(id));
        updatedTopic.peopleIds = Array.from(existingPeople);
      }

      updatedTopic.updatedAt = new Date().toISOString();

      return {
        ...current,
        topics: {
          ...current.topics,
          [topicId]: updatedTopic
        },
        activeModal: { type: null }
      };
    });
    showToast(t('context.saved'));
  };

  // Handle close confirmation actions
  const handleCloseConfirmation = async (action: 'minimize' | 'exit', alwaysAsk: boolean) => {
    setShowCloseConfirmation(false);

    // Determine the exit action to save
    // If alwaysAsk is true: keep as 'ask' (always show confirmation)
    // If alwaysAsk is false: save the selected action (minimize or exit)
    const exitActionToSave: 'ask' | 'minimize' | 'exit' = alwaysAsk ? 'ask' : action;

    // Update state
    const newSettings = {
      ...state.settings,
      exitAction: exitActionToSave
    };

    // Update state and ref immediately
    setState(prev => ({
      ...prev,
      settings: newSettings
    }));

    // Immediately update ref to ensure event listener uses the latest value
    exitActionRef.current = exitActionToSave;

    // Immediately save the settings to ensure persistence
    try {
      const rootPaths = state.roots.map(id => state.files[id]?.path).filter(Boolean);
      await saveUserData({
        rootPaths,
        customTags: state.customTags,
        people: state.people,
        folderSettings: state.folderSettings,
        settings: newSettings,
        fileMetadata: {}
      });
    } catch (error) {
      console.error('Failed to save exit action preference:', error);
    }

    // Perform the selected action
    switch (action) {
      case 'minimize':
        await hideWindow();
        break;
      case 'exit':
        // Exit the application
        await exitApp();
        break;
    }
  };

  // Enhanced handleClearPersonInfo to support selective clearing
  const handleClearPersonInfo = (fileIds: string[], personIdsToClear?: string[]) => {
    setState(prev => {
      const newFiles = { ...prev.files };
      const newPeople = { ...prev.people };
      let updated = false;

      // 锟斤拷锟斤拷锟秸硷拷锟斤拷锟斤拷要锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟絀D
      const personIdsToUpdate = new Set<string>();

      // 锟斤拷锟斤拷募锟斤拷锟斤拷锟斤拷锟斤拷锟较?
      fileIds.forEach(fid => {
        const file = newFiles[fid];
        if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
          let updatedFaces: AiFace[];

          if (personIdsToClear && personIdsToClear.length > 0) {
            // 选锟斤拷锟斤拷锟斤拷锟街革拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷息
            updatedFaces = file.aiData.faces.filter(face => !personIdsToClear.includes(face.personId));
          } else {
            // 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟较?
            updatedFaces = [];
          }

          // 锟斤拷锟斤拷欠锟斤拷斜浠?
          if (updatedFaces.length !== file.aiData.faces.length) {
            // 锟斤拷锟斤拷要锟斤拷锟铰碉拷锟斤拷锟斤拷ID
            file.aiData.faces.forEach(face => {
              personIdsToUpdate.add(face.personId);
            });
            updatedFaces.forEach(face => {
              personIdsToUpdate.add(face.personId);
            });

            // 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷息
            const newAiData = { ...file.aiData, faces: updatedFaces };
            newFiles[fid] = { ...file, aiData: newAiData };
            updated = true;
          }
        }
      });

      // 锟斤拷锟斤拷锟斤拷影锟斤拷锟斤拷锟斤拷锟絚ount
      if (updated) {
        // 锟斤拷锟铰硷拷锟斤拷锟斤拷锟斤拷锟斤拷影锟斤拷锟斤拷锟斤拷锟絚ount
        personIdsToUpdate.forEach(personId => {
          let newCount = 0;
          // 锟斤拷锟斤拷锟斤拷锟斤拷锟侥硷拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟侥硷拷锟斤拷锟斤拷
          Object.values(newFiles).forEach(file => {
            if (file.type === FileType.IMAGE && file.aiData?.faces) {
              if (file.aiData.faces.some(face => face.personId === personId)) {
                newCount++;
              }
            }
          });
          // 锟斤拷锟斤拷锟斤拷锟斤拷count
          if (newPeople[personId]) {
            newPeople[personId] = { ...newPeople[personId], count: newCount };
          }
        });
      }

      if (updated) {
        return { ...prev, files: newFiles, people: newPeople };
      }
      return prev;
    });
  };

  const onStartRenamePerson = (personId: string) => { setState(s => ({ ...s, activeModal: { type: 'rename-person', data: { personId } } })); };

  const handleSetAvatar = (personId: string) => {
    const person = state.people[personId];
    if (person && person.coverFileId) {
      const coverFile = state.files[person.coverFileId];
      if (coverFile) {
        setState(s => ({
          ...s,
          activeModal: {
            type: 'crop-avatar',
            data: {
              personId: person.id,
              fileUrl: convertFileSrc(coverFile.path),
              initialBox: person.faceBox
            }
          }
        }));
      }
    }
  };

  const handleSaveAvatarCrop = (personId: string, box: { x: number, y: number, w: number, h: number, imageId?: string | null }) => {
    const updates: Partial<Person> = { faceBox: box };

    // 锟斤拷锟窖★拷锟斤拷锟斤拷碌锟酵计拷锟斤拷锟斤拷锟絚overFileId
    if (box.imageId) {
      updates.coverFileId = box.imageId;
    }

    handleUpdatePerson(personId, updates);
    setState(s => ({ ...s, activeModal: { type: null } }));
    showToast(t('context.saved'));
  };

  const toggleSettings = useCallback(() => setState(s => ({ ...s, isSettingsOpen: !s.isSettingsOpen })), []);

  const handleChangePath = async (type: 'resource' | 'cache') => {
    try {
      const selectedPath = await openDirectory();
      if (!selectedPath) {
        return;
      }

      // 确锟斤拷锟斤拷锟斤拷目录锟斤拷锟节ｏ拷锟斤拷锟斤拷源锟斤拷目录锟铰达拷锟斤拷 .Aurora_Cache 锟侥硷拷锟叫ｏ拷
      if (isTauriEnvironment()) {
        // 锟斤拷锟姐缓锟斤拷路锟斤拷
        const cachePath = `${selectedPath}${selectedPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
        await ensureDirectory(cachePath);
      }

      const newSettings = {
        ...state.settings,
        paths: {
          ...state.settings.paths,
          resourceRoot: selectedPath,
          // 锟斤拷锟?cacheRoot锟斤拷锟斤拷为锟斤拷锟斤拷锟斤拷锟斤拷锟角达拷 resourceRoot 锟斤拷锟斤拷
          cacheRoot: ''
        }
      };

      setState(prev => ({
        ...prev,
        settings: newSettings
      }));

      startTask('ai', [], t('tasks.processing'));
      const result = await scanDirectory(selectedPath);

      setState(prev => {
        const newRoots = result.roots;
        const newFiles = result.files;
        const newRootId = newRoots.length > 0 ? newRoots[0] : '';
        if (!newRootId) return prev;
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
          settings: newSettings
        };
      });

      // 锟斤拷要锟斤拷锟斤拷扫锟斤拷目录锟斤拷锟斤拷锟斤拷 state 锟斤拷锟劫憋拷锟斤拷锟斤拷锟斤拷
      // 使锟斤拷扫锟斤拷锟斤拷锟叫碉拷路锟斤拷锟斤拷确锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟矫碉拷目录
      const resultRootPaths = result.roots.map(id => result.files[id]?.path).filter(Boolean);
      // 锟斤拷锟缴拷锟斤拷锟斤拷锟矫伙拷锟铰凤拷锟斤拷锟绞癸拷锟?selectedPath
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
    } catch (e) {
      console.error("Change path failed", e);
      showToast("Error changing path");
    }
  };

  // Navigation helpers
  const handleOpenInNewTab = useCallback((fileId: string) => {
    const file = state.files[fileId];
    if (!file) return;
    const isFolder = file.type === FileType.FOLDER;
    const targetFolderId = isFolder ? fileId : (file.parentId || fileId);
    const targetViewingId = isFolder ? null : fileId;
    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: targetFolderId,
      viewingFileId: targetViewingId,
      selectedFileIds: [fileId],
      lastSelectedId: fileId,
      isCompareMode: false,
      history: { stack: [{ folderId: targetFolderId, viewingId: targetViewingId, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }
    };
    setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  }, [state.files, setState]);

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

  const pushHistory = useCallback((folderId: string, viewingId: string | null, viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview' = 'browser', searchQuery: string = '', searchScope: SearchScope = 'all', activeTags: string[] = [], activePersonId: string | null = null, nextScrollTop: number = 0, aiFilter: AiSearchFilter | null | undefined = null, activeTopicId: string | null = null, selectedTopicIds: string[] = [], selectedPersonIds: string[] = [], scrollToItemId?: string) => {
    // Set global navigation timestamp BEFORE state update
    (window as any).__AURORA_NAV_TIMESTAMP__ = Date.now();
    updateActiveTab(prevTab => {
      const currentScrollTop = selectionRef.current?.scrollTop ?? prevTab.scrollTop;
      const stackCopy = [...prevTab.history.stack];
      if (prevTab.history.currentIndex >= 0 && prevTab.history.currentIndex < stackCopy.length) {
        stackCopy[prevTab.history.currentIndex] = {
          ...stackCopy[prevTab.history.currentIndex],
          scrollTop: currentScrollTop,
          selectedTopicIds: prevTab.selectedTopicIds,
          selectedPersonIds: prevTab.selectedPersonIds
        };
      }
      const newStack = [...stackCopy.slice(0, prevTab.history.currentIndex + 1), { folderId, viewingId, viewMode, searchQuery, searchScope, activeTags, activePersonId, aiFilter, scrollTop: nextScrollTop, activeTopicId, selectedTopicIds, selectedPersonIds }];
      return { folderId, viewingFileId: viewingId, viewMode, searchQuery, searchScope, activeTags, activePersonId, aiFilter, scrollTop: nextScrollTop, activeTopicId, selectedTopicIds, selectedPersonIds, selectedFileIds: scrollToItemId ? [scrollToItemId] : (viewingId ? [viewingId] : []), scrollToItemId, selectedTagIds: [], history: { stack: newStack, currentIndex: newStack.length - 1 } };
    });
  }, []);



  const handleRememberFolderSettings = () => {
    if (activeTab.viewMode !== 'browser') return;
    const folderId = activeTab.folderId;
    const folder = state.files[folderId];
    if (!folder || folder.type !== FileType.FOLDER) return;

    const settings = {
      layoutMode: activeTab.layoutMode,
      sortBy: state.sortBy,
      sortDirection: state.sortDirection,
      groupBy: groupBy
    };

    const isCurrentlySaved = !!state.folderSettings[folderId];

    setState(prev => {
      const newFolderSettings = { ...prev.folderSettings };
      if (isCurrentlySaved) {
        // 锟斤拷锟斤拷汛锟斤拷冢锟缴撅拷锟斤拷锟斤拷谢锟斤拷乇眨锟?
        delete newFolderSettings[folderId];
      } else {
        // 锟斤拷锟斤拷锟斤拷锟斤拷冢锟斤拷锟斤拷樱锟斤拷谢锟斤拷锟斤拷锟斤拷锟?
        newFolderSettings[folderId] = settings;
      }
      return { ...prev, folderSettings: newFolderSettings };
    });

    showToast(isCurrentlySaved ? t('folderSettings.remember') : t('folderSettings.saved'));
  };

  // 锟斤拷锟斤拷锟侥硷拷锟叫变化锟斤拷锟皆讹拷应锟矫憋拷锟斤拷锟斤拷锟斤拷锟?
  // 使锟斤拷 ref 锟斤拷锟斤拷锟解将 folderSettings 锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷锟斤拷循锟斤拷
  const folderSettingsRef = useRef(state.folderSettings);
  // Guard to prevent overwriting saved folder settings during initial load
  const savedDataLoadedRef = useRef(false);
  const [savedDataLoaded, setSavedDataLoaded] = useState(false);

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

  const enterFolder = useCallback((folderId: string, options?: { scrollToItemId?: string, resetScroll?: boolean }) => {
    const scroll = selectionRef.current?.scrollTop || 0;
    logInfo('[App] enterFolder', { action: 'enterFolder', folderId, container: 'main', containerScroll: scroll, ...options });
    // If resetScroll is explicitly true, or implicitly we want to reset (default behavior for entering folder)
    const nextScroll = options?.resetScroll ? 0 : 0;
    pushHistory(folderId, null, 'browser', '', 'all', [], null, nextScroll, null, null, [], [], options?.scrollToItemId);
  }, [pushHistory]);

  const handleNavigateFolder = useCallback((id: string, options?: { targetId?: string, resetScroll?: boolean }) => {
    closeContextMenu();
    if (activeTabRef.current.isCompareMode) {
      handleOpenInNewTab(id);
    } else {
      enterFolder(id, { scrollToItemId: options?.targetId, resetScroll: options?.resetScroll });
    }
  }, [closeContextMenu, enterFolder, handleOpenInNewTab]);

  const handleOpenCompareInNewTab = useCallback((imageIds: string[]) => {
    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: activeTabRef.current.folderId,
      selectedFileIds: imageIds,
      isCompareMode: true,
      history: {
        stack: [{
          folderId: activeTabRef.current.folderId,
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
  }, [setState]);

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

  const handleCreateTopic = useCallback((parentId: string | null, name?: string, type?: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    const newTopic: Topic = {
      id,
      parentId,
      name: name || t('context.newTopicDefault') || 'New Topic',
      // 默锟斤拷锟斤拷锟斤拷为 TOPIC锟斤拷锟斤拷锟斤拷锟斤拷 type 锟斤拷囟系锟?12 锟街ｏ拷
      type: type ? type.slice(0, 12) : 'TOPIC',
      peopleIds: [],
      fileIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    setState(prev => ({ ...prev, topics: { ...prev.topics, [id]: newTopic } }));
  }, [t]);

  const handleUpdateTopic = useCallback((topicId: string, updates: Partial<Topic>) => {
    setState(prev => ({
      ...prev,
      topics: {
        ...prev.topics,
        [topicId]: { ...prev.topics[topicId], ...updates, updatedAt: new Date().toISOString() }
      }
    }));
  }, []);

  const handleDeleteTopic = useCallback((topicId: string) => {
    setState(prev => {
      const newTopics = { ...prev.topics };
      delete newTopics[topicId];
      return { ...prev, topics: newTopics };
    });
  }, []);

  const handleCreateRootTopic = useCallback(() => handleCreateTopic(null), [handleCreateTopic]);

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

  // Global navigation timestamp for scroll event filtering across component boundaries
  const setNavigationTimestamp = () => {
    (window as any).__AURORA_NAV_TIMESTAMP__ = Date.now();
  };

  const goBack = () => {
    setNavigationTimestamp(); // Set timestamp BEFORE state update
    const currentScroll = selectionRef.current?.scrollTop || 0;
    logDebug('[App] goBack.invoked', { action: 'goBack', currentIndex: activeTab.history.currentIndex, container: 'main', containerScroll: currentScroll });
    updateActiveTab(prevTab => {
      if (prevTab.history.currentIndex > 0) {
        const newIndex = prevTab.history.currentIndex - 1;
        const step = prevTab.history.stack[newIndex];
        logDebug('[App] goBack.target', { action: 'goBack.target', newIndex, restoreScroll: step.scrollTop || 0, viewingId: step.viewingId, folderId: step.folderId });
        return { folderId: step.folderId, viewingFileId: step.viewingId, viewMode: step.viewMode, searchQuery: step.searchQuery, searchScope: step.searchScope, activeTags: step.activeTags || [], activePersonId: step.activePersonId, activeTopicId: step.activeTopicId || null, selectedTopicIds: step.selectedTopicIds || [], selectedPersonIds: step.selectedPersonIds || [], aiFilter: step.aiFilter, scrollTop: step.scrollTop || 0, selectedFileIds: step.viewingId ? [step.viewingId] : [], selectedTagIds: [], history: { ...prevTab.history, currentIndex: newIndex } };
      }
      console.log('[App] goBack -> at history beginning, nothing to do');
      return {};
    });
  };
  const goForward = () => {
    setNavigationTimestamp(); // Set timestamp BEFORE state update
    const currentScroll = selectionRef.current?.scrollTop || 0;
    console.log(`[App] goForward invoked. currentIndex=${activeTab.history.currentIndex}, currentScrollTop=${currentScroll}`);
    updateActiveTab(prevTab => {
      if (prevTab.history.currentIndex < prevTab.history.stack.length - 1) {
        const newIndex = prevTab.history.currentIndex + 1;
        const step = prevTab.history.stack[newIndex];
        console.log(`[App] goForward -> newIndex=${newIndex}, restoreScroll=${step.scrollTop || 0}, viewingId=${step.viewingId}`);
        return { folderId: step.folderId, viewingFileId: step.viewingId, viewMode: step.viewMode, searchQuery: step.searchQuery, searchScope: step.searchScope, activeTags: step.activeTags || [], activePersonId: step.activePersonId, activeTopicId: step.activeTopicId || null, selectedTopicIds: step.selectedTopicIds || [], selectedPersonIds: step.selectedPersonIds || [], aiFilter: step.aiFilter, scrollTop: step.scrollTop || 0, selectedFileIds: step.viewingId ? [step.viewingId] : [], selectedTagIds: [], history: { ...prevTab.history, currentIndex: newIndex } };
      }
      console.log('[App] goForward -> at history end, nothing to do');
      return {};
    });
  };

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

  const enterViewer = (fileId: string) => {
    const scrollTop = selectionRef.current?.scrollTop || 0;
    logInfo('[App] enterViewer', { action: 'enterViewer', fileId, container: 'main', containerScroll: scrollTop });
    pushHistory(activeTab.folderId, fileId, 'browser', activeTab.searchQuery, activeTab.searchScope, activeTab.activeTags, activeTab.activePersonId, scrollTop, activeTab.aiFilter, activeTab.activeTopicId);
  };

  // Toggle helpers for sidebars
  const toggleSidebar = () => {
    const next = !state.layout.isSidebarVisible;
    logInfo('[App] toggleSidebar', { action: 'toggleSidebar', next });
    setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: next } }));
  };

  const toggleMetadata = () => {
    const next = !state.layout.isMetadataVisible;
    logInfo('[App] toggleMetadata', { action: 'toggleMetadata', next });
    setState(s => ({ ...s, layout: { ...s.layout, isMetadataVisible: next } }));
  };

  const onLayoutToggle = (part: 'sidebar' | 'metadata') => {
    if (part === 'sidebar') toggleSidebar(); else toggleMetadata();
  };

  // Log layout state changes (sidebar / metadata) for debugging layout issues
  const prevLayoutRef = useRef(state.layout);
  useEffect(() => {
    const prev = prevLayoutRef.current;
    if (prev.isSidebarVisible !== state.layout.isSidebarVisible) {
      logInfo('[App] sidebar.stateChange', { isSidebarVisible: state.layout.isSidebarVisible });
    }
    if (prev.isMetadataVisible !== state.layout.isMetadataVisible) {
      logInfo('[App] metadata.stateChange', { isMetadataVisible: state.layout.isMetadataVisible });
    }

    // Measure main grid & panels after layout change to help debug layout issues
    setTimeout(() => {
      try {
        const mainEl = document.getElementById('file-grid-container') as HTMLElement | null;
        const mainWidth = mainEl ? mainEl.clientWidth : null;
        const sidebarEl = document.querySelector('.border-r') as HTMLElement | null; // left sidebar
        const sidebarWidth = sidebarEl ? sidebarEl.clientWidth : null;
        const metadataEl = document.querySelector('.metadata-panel-container') as HTMLElement | null; // right panel
        const metadataWidth = metadataEl ? metadataEl.clientWidth : null;

        logDebug('[App] layout.measure', { mainWidth, sidebarWidth, metadataWidth, isSidebarVisible: state.layout.isSidebarVisible, isMetadataVisible: state.layout.isMetadataVisible });
      } catch (e) {
        logDebug('[App] layout.measure.failed', { error: String(e) });
      }
    }, 0);

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

  const performAiSearch = async (query: string) => {
    if (!query.trim()) {
      pushHistory(activeTab.folderId, null, 'browser', '', activeTab.searchScope, activeTab.activeTags, null, 0, null);
      return;
    }

    const taskId = startTask('ai', [], t('settings.aiSmartSearchThinking'), false);
    showToast(t('settings.aiSmartSearchThinking'));

    try {
      const aiConfig = state.settings.ai;
      const prompt = `
          Analyze this search query for a photo gallery: "${query}".
          Extract search intent and criteria into a JSON object.
          Return ONLY JSON.
          
          Expected JSON Structure:
          {
            "keywords": string[], // Synonyms, objects, tags
            "colors": string[], // Hex codes or color names
            "people": string[], // Names of people
            "description": string // A concise description of what to look for (optional)
          }
          `;

      let result: any = null;

      // Same logic as handleAIAnalysis but for search
      if (aiConfig.provider === 'openai') {
        const messages: any[] = [];
        if (aiConfig.systemPrompt) {
          messages.push({ role: "system", content: aiConfig.systemPrompt });
        }
        messages.push({ role: "user", content: prompt });

        const body = {
          model: aiConfig.openai.model,
          messages,
          max_tokens: 500
        };
        try {
          const res = await fetch(`${aiConfig.openai.endpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${aiConfig.openai.apiKey}` },
            body: JSON.stringify(body)
          });
          const resData = await res.json();
          if (resData?.choices?.[0]?.message?.content) {
            try {
              const text = resData.choices[0].message.content;
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
            } catch (e) { }
          }
        } catch (e) {
          console.error('AI search failed:', e);
        }
      } else if (aiConfig.provider === 'ollama') {
        const body: any = { model: aiConfig.ollama.model, prompt: prompt, stream: false, format: "json" };
        if (aiConfig.systemPrompt) {
          body.system = aiConfig.systemPrompt;
        }
        try {
          const res = await fetch(`${aiConfig.ollama.endpoint}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const resData = await res.json();
          if (resData?.response) {
            try {
              const text = resData.response;
              const jsonMatch = text.match(/\{[\s\S]*\}/);
              result = JSON.parse(jsonMatch ? jsonMatch[0] : text);
            } catch (e) { }
          }
        } catch (e) {
          console.error('AI search failed:', e);
        }
      } else if (aiConfig.provider === 'lmstudio') {
        const messages: any[] = [];
        if (aiConfig.systemPrompt) {
          messages.push({ role: "system", content: aiConfig.systemPrompt });
        }
        messages.push({ role: "user", content: prompt });

        const body = {
          model: aiConfig.lmstudio.model,
          messages,
          max_tokens: 500,
          stream: false
        };
        let endpoint = aiConfig.lmstudio.endpoint.replace(/\/+$/, '');
        if (!endpoint.endsWith('/v1')) endpoint += '/v1';
        try {
          const res = await fetch(`${endpoint}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          const resData = await res.json();
          if (resData?.choices?.[0]?.message?.content) {
            try { result = JSON.parse(resData.choices[0].message.content); } catch (e) { }
          }
        } catch (e) {
          console.error('AI search failed:', e);
        }
      }

      if (result) {
        const aiFilter = {
          originalQuery: query,
          keywords: result.keywords || [],
          colors: result.colors || [],
          people: result.people || [],
          description: result.description
        };

        // Apply the AI filter to the search
        pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);
        showToast("AI Search Applied");
      } else {
        // Fallback to normal search if AI fails
        pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, null);
        showToast("AI Search Failed, using standard search");
      }

    } catch (e) {
      console.error("AI Search Error", e);
      pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0, null);
      showToast("AI Search Error");
    } finally {
      updateTask(taskId, { current: 1, status: 'completed' });
      setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
    }
  };

  // 锟芥换 App.tsx 锟叫碉拷 onPerformSearch
  const onPerformSearch = async (query: string) => {

    // 1. 锟斤拷色锟斤拷锟斤拷锟竭硷拷
    if (query.startsWith('color:')) {
      let hex = query.replace('color:', '').trim();
      if (hex.startsWith('#')) hex = hex.substring(1);

      const taskId = startTask('ai', [], t('tasks.searchingColor'), false);

      try {
        const results = await searchByColor(`#${hex}`);

        const allFiles = Object.values(state.files);
        const validPaths: string[] = [];
        const missingPaths: string[] = [];
        const newFilesMap: Record<string, FileNode> = {};

        const normalize = (p: string) => {
          if (!p) return '';
          let clean = p.startsWith('\\\\?\\') ? p.slice(4) : p;
          clean = clean.replace(/\\/g, '/');
          return clean.toLowerCase();
        };

        results.forEach(rustPath => {
          const normRust = normalize(rustPath);
          const match = allFiles.find(f => {
            if (!f.path) return false;
            const normFront = normalize(f.path);
            return normFront === normRust;
          });
          if (match && match.path) {
            validPaths.push(match.path);
          } else {
            missingPaths.push(rustPath);
          }
        });

        // 锟斤拷锟斤拷缺失锟侥硷拷
        if (missingPaths.length > 0) {
          await asyncPool(10, missingPaths, async (path) => {
            try {
              const node = await scanFile(path);
              if (node) {
                newFilesMap[node.id] = node;
                validPaths.push(node.path);
              }
            } catch (e) { }
          });
        }

        // 锟斤拷锟斤拷 State
        if (Object.keys(newFilesMap).length > 0) {
          setState(prev => ({
            ...prev,
            files: { ...prev.files, ...newFilesMap }
          }));
        }

        if (validPaths.length === 0 && results.length > 0) {
          showToast(t('errors.fileNotFound'));
        }

        const aiFilter: AiSearchFilter = {
          keywords: [],
          colors: [hex],
          people: [],
          originalQuery: query,
          filePaths: validPaths
        };

        pushHistory(activeTab.folderId, null, 'browser', '', activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);

      } catch (e) {
        console.error("Color search failed", e);
        showToast("Color search failed");
      } finally {
        updateTask(taskId, { current: 1, status: 'completed' });
        setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
      }
      return;
    }

    // 1.5 锟斤拷围/色锟斤拷锟斤拷锟斤拷锟竭硷拷 (Palette)
    if (query.startsWith('palette:')) {
      const rawPalette = query.replace('palette:', '').trim();
      if (!rawPalette) return;

      const palette = rawPalette.split(',').map(c => {
        let hex = c.trim();
        if (!hex.startsWith('#')) hex = '#' + hex;
        return hex;
      });

      const taskId = startTask('ai', [], t('tasks.searchingPalette'), false);

      try {
        const results = await searchByPalette(palette);

        const allFiles = Object.values(state.files);
        const validPaths: string[] = [];
        const missingPaths: string[] = [];
        const newFilesMap: Record<string, FileNode> = {};

        const normalize = (p: string) => {
          if (!p) return '';
          let clean = p.startsWith('\\\\?\\') ? p.slice(4) : p;
          clean = clean.replace(/\\/g, '/');
          return clean.toLowerCase();
        };

        // 1. 锟斤拷锟斤拷锟节达拷锟叫诧拷锟斤拷
        results.forEach(rustPath => {
          const normRust = normalize(rustPath);
          const match = allFiles.find(f => {
            if (!f.path) return false;
            const normFront = normalize(f.path);
            return normFront === normRust;
          });
          if (match && match.path) {
            validPaths.push(match.path);
          } else {
            missingPaths.push(rustPath);
          }
        });

        // 2. 锟斤拷锟斤拷锟节达拷锟斤拷没锟叫碉拷锟侥硷拷锟斤拷锟斤拷锟皆帮拷锟斤拷扫锟斤拷
        if (missingPaths.length > 0) {
          // showToast(`锟斤拷锟节硷拷锟截讹拷锟斤拷锟?${missingPaths.length} 锟斤拷锟侥硷拷...`);
          // 锟斤拷锟斤拷扫锟借，锟斤拷锟狡诧拷锟斤拷锟斤拷
          await asyncPool(10, missingPaths, async (path) => {
            try {
              const node = await scanFile(path);
              if (node) {
                newFilesMap[node.id] = node;
                validPaths.push(node.path);
              }
            } catch (e) {
              // 锟斤拷锟斤拷扫锟斤拷失锟杰碉拷锟侥硷拷
              console.warn('Failed to load search result file:', path);
            }
          });
        }

        // 3. 锟斤拷锟斤拷锟斤拷录锟斤拷氐锟斤拷募锟斤拷锟斤拷锟斤拷碌锟饺拷锟?state
        if (Object.keys(newFilesMap).length > 0) {
          setState(prev => ({
            ...prev,
            files: { ...prev.files, ...newFilesMap }
          }));
        }

        if (validPaths.length === 0 && results.length > 0) {
          // 锟斤拷时锟斤拷锟斤拷锟斤拷也锟斤拷锟斤拷锟斤拷叨锟斤拷锟斤拷锟斤拷锟?
          showToast(t('errors.fileNotFound'));
        }

        const aiFilter: AiSearchFilter = {
          keywords: [],
          colors: palette,
          people: [],
          originalQuery: query,
          filePaths: validPaths
        };

        pushHistory(activeTab.folderId, null, 'browser', '', activeTab.searchScope, activeTab.activeTags, null, 0, aiFilter);

        if (validPaths.length > 0) {
          showToast(t('context.found') + ` ${validPaths.length} ` + t('context.files'));
        } else {
          showToast(t('context.noFiles'));
        }

      } catch (e) {
        console.error("Palette search failed", e);
        showToast("Palette search failed: " + e);
      } finally {
        updateTask(taskId, { current: 1, status: 'completed' });
        setTimeout(() => setState(prev => ({ ...prev, tasks: prev.tasks.filter(t => t.id !== taskId) })), 500);
      }
      return;
    }

    // 2. 原锟叫碉拷锟斤拷通锟斤拷锟斤拷锟竭硷拷
    if (state.settings.search.isAISearchEnabled) {
      await performAiSearch(query);
    } else {
      pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0);
    }
  };

  const handlePerformSearch = onPerformSearch;

  const handleViewerSearch = (query: string) => pushHistory(activeTab.folderId, null, 'browser', query, activeTab.searchScope, activeTab.activeTags, null, 0);
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

  const enterPeopleOverview = useCallback(() => {
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

  const enterPersonView = useCallback((personId: string) => {
    if (activeTabRef.current.isCompareMode) {
      handleOpenPersonInNewTab(personId);
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'browser', '', 'all', [], personId, 0);
    }
  }, [pushHistory, handleOpenPersonInNewTab]);
  const handleClearTagFilter = (tagToRemove: string) => updateActiveTab(prev => ({ activeTags: prev.activeTags.filter(t => t !== tagToRemove) }));
  const handleClearAllTags = () => updateActiveTab({ activeTags: [] });
  const handleClearPersonFilter = () => updateActiveTab({ activePersonId: null });

  const handleNavigateUp = () => {
    if (activeTab.activeTopicId) {
      const currentTopic = state.topics[activeTab.activeTopicId];
      if (currentTopic) handleNavigateTopic(currentTopic.parentId || null);
    } else if (activeTab.activePersonId) {
      enterPeopleOverview();
    } else if (activeTab.viewMode === 'people-overview' || activeTab.viewMode === 'tags-overview' || activeTab.viewMode === 'topics-overview') {
      enterFolder(activeTab.folderId);
    } else {
      const current = state.files[activeTab.folderId];
      if (current && current.parentId) {
        enterFolder(current.parentId);
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
    } else {
      await pauseColorExtraction();
      updateTask(id, { status: 'paused' });
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
        // Tauri 锟斤拷锟斤拷锟斤拷使锟斤拷 openPath API
        const { openPath } = await import('./api/tauri-bridge');
        // 锟斤拷锟斤拷 isFile 锟斤拷锟斤拷锟斤拷锟斤拷锟侥硷拷锟叫讹拷锟斤拷锟侥硷拷锟斤拷锟斤拷要选锟叫ｏ拷锟侥硷拷锟斤拷直锟接达拷
        const isFile = file.type !== FileType.FOLDER;
        logDebug('[App] callingOpenPath', { path: targetPath, isFile });
        await openPath(targetPath, isFile);
      }
    } catch (error) {
      console.error('Failed to open in explorer:', error);
    }
  };
  const handleSwitchTab = (id: string) => setState(s => ({ ...s, activeTabId: id }));
  const handleCloseTab = (e: React.MouseEvent, id: string) => { e.stopPropagation(); setState(prev => { const newTabs = prev.tabs.filter(t => t.id !== id); if (newTabs.length === 0) return prev; let newActiveId = prev.activeTabId; if (id === prev.activeTabId) { const index = prev.tabs.findIndex(t => t.id === id); newActiveId = newTabs[Math.max(0, index - 1)].id; } return { ...prev, tabs: newTabs, activeTabId: newActiveId }; }); };
  const handleNewTab = () => { const newTab: TabState = { ...DUMMY_TAB, id: Math.random().toString(36).substr(2, 9), folderId: state.roots[0] || '' }; newTab.history = { stack: [{ folderId: newTab.folderId, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }; setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id })); };

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+Tab: Switch to next tab
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        const currentIndex = state.tabs.findIndex(tab => tab.id === state.activeTabId);
        const nextIndex = (currentIndex + 1) % state.tabs.length;
        const nextTabId = state.tabs[nextIndex].id;
        handleSwitchTab(nextTabId);
      }
      // Ctrl+W: Close current tab
      else if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        if (state.tabs.length > 1) {
          handleCloseTab(e as any, state.activeTabId);
        }
      }
      // Ctrl+T: New tab
      else if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        handleNewTab();
      }
      // Ctrl+R: Refresh
      else if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        handleRefresh();
      }
      // Delete: Delete selected files/folders
      else if (e.key === 'Delete') {
        if (activeTab.selectedFileIds.length > 0) {
          e.preventDefault();
          requestDelete(activeTab.selectedFileIds);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [state.tabs, state.activeTabId, handleSwitchTab, handleCloseTab, handleNewTab, handleRefresh, activeTab.selectedFileIds, requestDelete]);

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

      {/* 锟解部锟斤拷拽锟斤拷锟角诧拷 */}
      <DragDropOverlay
        isVisible={isExternalDragging}
        fileCount={externalDragItems.length}
        hoveredAction={hoveredDropAction}
        onHoverAction={setHoveredDropAction}
        t={t}
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
      }} t={t} showWindowControls={!showSplash} />
      <div className="flex-1 flex overflow-hidden relative transition-all duration-300 ease-[cubic-bezier(0.25,0.1,0.25,1)]">
        <div className={`bg-gray-50 dark:bg-gray-850 border-r border-gray-200 dark:border-gray-800 flex flex-col transition-all duration-300 shrink-0 z-40 ${state.layout.isSidebarVisible ? 'w-64 translate-x-0 opacity-100' : 'w-0 -translate-x-full opacity-0 overflow-hidden'}`}>
          <Sidebar roots={state.roots} files={state.files} people={peopleWithDisplayCounts} customTags={state.customTags} currentFolderId={activeTab.folderId} expandedIds={state.expandedFolderIds} tasks={tasks} onToggle={handleToggleFolder} onNavigate={handleNavigateFolder} onTagSelect={enterTagView} onNavigateAllTags={enterTagsOverview} onPersonSelect={enterPersonView} onNavigateAllPeople={enterPeopleOverview} onContextMenu={handleContextMenu} isCreatingTag={isCreatingTag} onStartCreateTag={handleCreateNewTag} onSaveNewTag={handleSaveNewTag} onCancelCreateTag={handleCancelCreateTag} onOpenSettings={toggleSettings} onRestoreTask={onRestoreTask} onPauseResume={onPauseResume} onStartRenamePerson={onStartRenamePerson} onCreatePerson={handleCreatePerson} onNavigateTopics={handleNavigateTopics} onCreateTopic={handleCreateRootTopic} onDropOnFolder={handleDropOnFolder} aiConnectionStatus={state.aiConnectionStatus} t={t} />
        </div>

        <div className="flex-1 flex flex-col min-w-0 relative bg-white dark:bg-gray-900">
          {activeTab.viewingFileId && (
            (() => {
              const viewingFile = state.files[activeTab.viewingFileId];
              const parentFolder = viewingFile && viewingFile.parentId ? state.files[viewingFile.parentId] : null;

              if (parentFolder && parentFolder.category === 'sequence') {
                return (
                  <SequenceViewer
                    file={viewingFile}
                    folder={parentFolder}
                    files={state.files}
                    sortedFileIds={displayFileIds.filter(id => state.files[id].type === FileType.IMAGE)}
                    onClose={closeViewer}
                    onNavigate={handleViewerJump}
                    isSidebarOpen={state.layout.isSidebarVisible}
                    onToggleSidebar={toggleSidebar}
                    onDelete={(id) => requestDelete([id])}
                    onNavigateBack={goBack}
                    t={t}
                  />
                );
              }

              return (
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
                  onDelete={(id) => requestDelete([id])}
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
                />
              );
            })()
          )}
          {state.tabs.map(tab => tab.isCompareMode && (
            <div key={tab.id} className={`w-full h-full flex-1 flex flex-col overflow-hidden ${tab.id === state.activeTabId ? 'flex' : 'hidden'}`}>
              <ImageComparer
                selectedFileIds={tab.selectedFileIds}
                files={state.files}
                onClose={() => updateTabById(tab.id, { isCompareMode: false })}
                onCloseTab={() => handleCloseTab({ stopPropagation: () => { } } as any, tab.id)}
                onReady={() => updateTabById(tab.id, { selectedFileIds: [] })}
                onLayoutToggle={onLayoutToggle}
                onNavigateBack={goBack}
                onSelect={(id) => updateTabById(tab.id, { selectedFileIds: [id] })}
                sessionName={tab.sessionName}
                onSessionNameChange={(name) => updateTabById(tab.id, { sessionName: name })}
                layoutProp={state.layout}
                canGoBack={tab.history.currentIndex > 0}
                t={t}
              />
            </div>
          ))}
          <div className={`flex-1 flex flex-col min-w-0 relative ${activeTab.viewingFileId || activeTab.isCompareMode ? 'hidden' : 'flex'}`} style={{ height: '100%' }}>
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
              onLayoutModeChange={(mode) => updateActiveTab({ layoutMode: mode })}
              onSortOptionChange={(opt) => setState(s => ({ ...s, sortBy: opt }))}
              onSortDirectionChange={() => setState(s => ({ ...s, sortDirection: s.sortDirection === 'asc' ? 'desc' : 'asc' }))}
              onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
              onToggleMetadata={toggleMetadata}
              onToggleSettings={toggleSettings}
              onUpdateDateFilter={(f) => updateActiveTab({ dateFilter: f })}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              isAISearchEnabled={state.settings.search.isAISearchEnabled}
              onToggleAISearch={() => setState(s => ({ ...s, settings: { ...s.settings, search: { ...s.settings.search, isAISearchEnabled: !s.settings.search.isAISearchEnabled } } }))}
              onRememberFolderSettings={activeTab.viewMode === 'browser' ? handleRememberFolderSettings : undefined}
              // Topic layout control (used when in topics-overview)
              topicLayoutMode={topicLayoutMode}
              onTopicLayoutModeChange={handleTopicLayoutModeChange}
              hasFolderSettings={activeTab.viewMode === 'browser' ? !!state.folderSettings[activeTab.folderId] : false}
              t={t}
            />
            {/* ... (Filter UI, same as before) ... */}
            {(activeTab.activeTags.length > 0 || activeTab.dateFilter.start || activeTab.activePersonId || activeTab.aiFilter) && (
              <div className="flex items-center px-4 py-2 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 space-x-2 overflow-x-auto shrink-0 z-20">
                <div className="flex items-center text-xs text-gray-500 dark:text-gray-400 mr-2 shrink-0">
                  <Filter size={12} className="mr-1" /> {t('context.filters')}
                </div>

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

                <button onClick={() => { handleClearAllTags(); handleClearPersonFilter(); updateActiveTab({ dateFilter: { start: null, end: null, mode: 'created' as const }, aiFilter: null }); }} className="text-xs text-gray-500 hover:text-red-500 underline ml-2 whitespace-nowrap">{t('context.clearAll')}</button>
              </div>
            )}

            <div className="flex-1 flex flex-col relative bg-white dark:bg-gray-900 overflow-hidden">
              {activeTab.viewMode !== 'topics-overview' && (
                <div className="h-14 flex items-center justify-between px-4 text-xs text-gray-500 dark:text-gray-400 border-b border-gray-100 dark:border-gray-800 bg-white dark:bg-gray-900/50 backdrop-blur shrink-0 relative z-20">
                  {activeTab.viewMode === 'tags-overview' ? (
                    <div className="flex items-center w-full">
                      <div className="flex items-center">
                        <Tag size={12} className="mr-1" />
                        <span className="font-medium">{t('context.allTagsOverview')}</span>
                      </div>
                      <div className="flex-1 flex justify-end"></div>
                    </div>
                  ) : activeTab.viewMode === 'people-overview' ? (
                    <div className="flex items-center w-full justify-between">
                      <div className="flex items-center">
                        <User size={12} className="mr-1" />
                        <span>{t('context.allPeople')}</span>
                      </div>
                      <div className="text-[10px] opacity-60">
                        {Object.keys(peopleWithDisplayCounts).length} {t('context.items')}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center w-full justify-between">
                      <div className="flex items-center space-x-1 overflow-hidden">
                        <HardDrive size={12} />
                        <span>/</span>
                        {state.files[activeTab.folderId]?.path || state.files[activeTab.folderId]?.name}
                        {activeTab.activeTags.length > 0 && <span className="text-blue-600 font-bold ml-2">{t('context.filtered')}</span>}
                      </div>
                      <div className="text-[10px] opacity-60">
                        {displayFileIds.length} {t('context.items')}
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div className="flex-1 overflow-hidden relative" id="file-grid-container">
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
                    onOpenFile={(id) => state.files[id]?.type === FileType.FOLDER ? handleNavigateFolder(id) : enterViewer(id)}
                    t={t}
                    scrollTop={activeTab.scrollTop}
                    onScrollTopChange={(scrollTop) => { updateActiveTab({ scrollTop }); }}
                    isVisible={!activeTab.viewingFileId}
                    topicLayoutMode={(topicLayoutMode === 'grid' || topicLayoutMode === 'adaptive' || topicLayoutMode === 'masonry') ? topicLayoutMode : 'grid'}
                    onTopicLayoutModeChange={handleTopicLayoutModeChange}
                    onShowToast={showToast}
                  />
                ) : displayFileIds.length === 0 && activeTab.viewMode === 'browser' ? (
                  <div className="w-full h-full flex flex-col items-center justify-center text-gray-400" onMouseDown={handleMouseDown} onContextMenu={(e) => handleContextMenu(e, 'background', '')}>
                    <div className="text-6xl mb-4 opacity-20"><FolderOpen /></div>
                    <p>{t('context.noFiles')}</p>
                  </div>
                ) : (
                  <FileGrid
                    displayFileIds={displayFileIds}
                    isVisible={!activeTab.viewingFileId}
                    files={state.files}
                    activeTab={activeTab}
                    renamingId={state.renamingId}
                    thumbnailSize={state.thumbnailSize}
                    resourceRoot={state.settings.paths.resourceRoot}
                    cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)}
                    hoverPlayingId={hoverPlayingId}
                    onSetHoverPlayingId={setHoverPlayingId}
                    onFileClick={handleFileClick}
                    onFileDoubleClick={(id) => state.files[id]?.type === FileType.FOLDER ? handleNavigateFolder(id) : enterViewer(id)}
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
                    onScrollTopChange={(scrollTop) => updateActiveTab({ scrollTop })}
                    onConsumeScrollToItem={() => updateActiveTab({ scrollToItemId: undefined })}
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
                  />
                )}
              </div>
            </div>
          </div>
        </div>
        <div className={`metadata-panel-container bg-gray-50 dark:bg-gray-850 border-l border-gray-200 dark:border-gray-800 flex flex-col transition-all duration-300 shrink-0 z-40 ${state.layout.isMetadataVisible ? 'w-80 translate-x-0 opacity-100' : 'w-0 translate-x-full opacity-0 overflow-hidden'}`}>
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
              if (type === 'color') await pauseColorExtraction();
            } else {
              updateTask(taskId, { status: 'running' });
              if (type === 'color') await resumeColorExtraction();
            }
          }}
        />
        <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-[110] flex flex-col-reverse items-center gap-2 pointer-events-none">
          {deletionTasks.map(task => (<ToastItem key={task.id} task={task} onUndo={() => undoDelete(task.id)} onDismiss={() => dismissDelete(task.id)} t={t} />))}
          {toast.visible && (<div className="bg-black/80 text-white text-sm px-4 py-2 rounded-full shadow-lg backdrop-blur-sm animate-toast-up">{toast.msg}</div>)}
          {showDragHint && !activeTab.isCompareMode && (<div className="bg-blue-600 dark:bg-blue-700 text-white text-sm px-4 py-2.5 rounded-full shadow-lg backdrop-blur-sm animate-toast-up flex items-center gap-2 pointer-events-auto">
            <span>{t('drag.multiSelectHint')}</span>
          </div>)}
        </div>
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
        handleRenamePerson={handleRenamePerson}
        handleConfirmDeleteTags={handleConfirmDeleteTags}
        handleDeletePerson={handleDeletePerson}
        handleUpdateFile={handleUpdateFile}
        handleCopyFiles={handleCopyFiles}
        handleMoveFiles={handleMoveFiles}
        handleResolveFileCollision={handleResolveFileCollision}
        handleResolveFolderMerge={handleResolveFolderMerge}
        handleResolveExtensionChange={handleResolveExtensionChange}
        handleSaveAvatarCrop={handleSaveAvatarCrop}
        handleExitConfirm={handleExitConfirm}
        handleClearPersonInfo={handleClearPersonInfo}
        showToast={showToast}
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
      />

      <ContextMenu
        contextMenu={contextMenu}
        files={state.files}
        activeTab={activeTab}
        peopleWithDisplayCounts={peopleWithDisplayCounts}
        aiConnectionStatus={state.aiConnectionStatus}
        displayFileIds={displayFileIds}
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
        requestDelete={requestDelete}
        handleCreateFolder={handleCreateFolder}
        handleExpandAll={handleExpandAll}
        handleCollapseAll={handleCollapseAll}
        enterTagView={enterTagView}
        requestDeleteTags={requestDeleteTags}
        handleSetAvatar={handleSetAvatar}
        handleCreatePerson={handleCreatePerson}
        handleCloseTab={handleCloseTab}
        handleCloseOtherTabs={handleCloseOtherTabs}
        handleCloseAllTabs={handleCloseAllTabs}
        handleRefresh={handleRefresh}
        handleCreateNewTag={handleCreateNewTag}
        handleCopyTags={handleCopyTags}
        handlePasteTags={handlePasteTags}
        showToast={showToast}
        updateActiveTab={updateActiveTab}
        handleOpenCompareInNewTab={handleOpenCompareInNewTab}
      />
    </div>
  );
};

export default App;
