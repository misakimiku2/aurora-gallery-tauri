
export enum FileType {
  IMAGE = 'image',
  FOLDER = 'folder',
  UNKNOWN = 'unknown'
}

export interface DominantColor {
  hex: string;
  rgb: [number, number, number];
  isDark: boolean;
}

export interface ImageMeta {
  width: number;
  height: number;
  sizeKb: number;
  created: string;
  modified: string;
  format: string;
  palette?: string[];
  dominantColors?: DominantColor[];
}

export interface AiFace {
  id: string;
  personId: string;
  name: string;
  confidence: number;
  box: { x: number; y: number; w: number; h: number };
}

export interface AiData {
  analyzed: boolean;
  analyzedAt: string;
  description: string;
  tags: string[];
  faces: AiFace[];
  sceneCategory: string;
  confidence: number;
  dominantColors: string[];
  objects: string[];
  extractedText?: string;
  translatedText?: string;
}

export interface FileNode {
  id: string;
  parentId: string | null;
  name: string;
  type: FileType;
  path: string;
  size?: number; // Size in bytes for cache key generation
  children?: string[];

  category?: 'general' | 'book' | 'sequence';
  author?: string;

  url?: string;
  previewUrl?: string;
  tags: string[];
  description?: string;
  sourceUrl?: string;
  meta?: ImageMeta;
  aiData?: AiData;

  createdAt?: string;
  updatedAt?: string;
  lastRefresh?: number;
}

export interface Person {
  id: string;
  name: string;
  coverFileId: string;
  count: number;
  description?: string;
  descriptor?: number[];
  faceBox?: { x: number; y: number; w: number; h: number }; // Percentages 0-100
}

export interface CoverCropData {
  x: number; // Top-left percentage relative to the original image
  y: number;
  width: number; // Width of the cropped area as a percentage of the original image
  height: number; // Height of the cropped area as a percentage of the original image
}

export interface Topic {
  id: string;
  parentId: string | null;
  name: string;
  description?: string;
  /** 可选：自定义显示的类型 / 标签，最多 12 字 */
  type?: string;
  coverFileId?: string;
  backgroundFileId?: string;
  coverCrop?: CoverCropData;
  peopleIds: string[];
  fileIds?: string[];
  sourceUrl?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface UserProfile {
  name: string;
  avatarUrl: string;
  ip: string;
}

export interface TaskProgress {
  id: string;
  type: 'ai' | 'copy' | 'move' | 'thumbnail' | 'color';
  title: string;
  total: number;
  current: number;
  startTime: number;
  status: 'running' | 'completed' | 'paused';
  minimized: boolean;
  currentStep?: string;
  currentFile?: string;
  estimatedTime?: number; // 预估剩余时间（毫秒）
  lastProgressUpdate?: number; // 上次进度更新时间
  lastProgress?: number; // 上次进度值
  initialTotal?: number; // 初始总数（用于颜色提取任务，表示初始待处理文件数）
  lastEstimatedTimeUpdate?: number; // 上次更新预估时间的时间戳
  totalProcessedTime?: number; // 累计有效处理时间（不包括暂停时间）
}

export interface DeletionTask {
  id: string;
  files: FileNode[];
}

export interface SlideshowConfig {
  interval: number;
  transition: 'fade' | 'slide' | 'none';
  isRandom: boolean;
  enableZoom: boolean;
}

export interface SearchSettings {
  isAISearchEnabled: boolean;
}

export type AIProvider = 'openai' | 'ollama' | 'lmstudio';

export interface PromptPreset {
  id: string;
  name: string;
  content: string;
}

export interface AIConfig {
  provider: AIProvider;
  openai: {
    apiKey: string;
    endpoint: string;
    model: string;
  };
  ollama: {
    endpoint: string;
    model: string;
  };
  lmstudio: {
    endpoint: string;
    model: string;
  };
  autoTag: boolean;
  autoDescription: boolean;
  enhancePersonDescription: boolean;
  enableFaceRecognition: boolean;
  autoAddPeople: boolean;
  enableOCR: boolean;
  enableTranslation: boolean;
  targetLanguage: 'zh' | 'en' | 'ja' | 'ko';
  confidenceThreshold: number;
  systemPrompt?: string;
  promptPresets?: PromptPreset[];
  currentPresetId?: string;
}

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  language: 'zh' | 'en';
  autoStart: boolean;
  exitAction: 'ask' | 'minimize' | 'exit';
  animateOnHover: boolean;
  paths: {
    resourceRoot: string;
    cacheRoot: string;
  };
  search: SearchSettings;
  ai: AIConfig;
  performance: {
    refreshInterval: number; // 毫秒
  };
  people?: Record<string, Person>; // 临时存储人物数据库，用于AI分析
  topics?: Record<string, Topic>;
}

export interface DateFilter {
  start: string | null;
  end: string | null;
  mode: 'created' | 'updated';
}

export interface AiSearchFilter {
  keywords: string[];
  colors: string[];
  people: string[];
  originalQuery: string;
  description?: string;
  filePaths?: string[];
}

export type SearchScope = 'all' | 'file' | 'tag' | 'folder';
export type SortOption = 'name' | 'date' | 'size';
export type SortDirection = 'asc' | 'desc';
export type LayoutMode = 'grid' | 'adaptive' | 'list' | 'masonry';
export type GroupByOption = 'none' | 'type' | 'date' | 'size';

export interface FolderSettings {
  layoutMode: LayoutMode;
  sortBy: SortOption;
  sortDirection: SortDirection;
  groupBy: GroupByOption;
}

export interface FileGroup {
  id: string;
  title: string;
  fileIds: string[];
}

export interface HistoryItem {
  folderId: string;
  viewingId: string | null;
  viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview';
  searchQuery: string;
  searchScope: SearchScope;
  activeTags: string[];
  activePersonId: string | null;
  activeTopicId?: string | null;
  selectedTopicIds?: string[];
  selectedPersonIds?: string[];
  aiFilter?: AiSearchFilter | null;
  scrollTop?: number;
}

export interface TabState {
  id: string;
  folderId: string;
  viewingFileId: string | null;
  viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview';
  layoutMode: LayoutMode;
  searchQuery: string;
  searchScope: SearchScope;
  aiFilter?: AiSearchFilter | null;
  activeTags: string[];
  activePersonId: string | null;
  activeTopicId: string | null;
  selectedTopicIds: string[];
  dateFilter: DateFilter;
  selectedFileIds: string[];
  lastSelectedId: string | null;
  selectedTagIds: string[];
  selectedPersonIds: string[];
  isCompareMode: boolean;
  sessionName?: string;
  scrollToItemId?: string;
  history: {
    stack: HistoryItem[];
    currentIndex: number;
  };
  scrollTop: number;
}

export type SettingsCategory = 'general' | 'appearance' | 'network' | 'storage' | 'ai' | 'performance';

export interface DragState {
  isDragging: boolean;
  draggedFileIds: string[];
  sourceFolderId: string | null;
  dragOverFolderId: string | null;
  dragOverPosition: 'inside' | 'before' | 'after' | null;
}

export interface AppState {
  roots: string[];
  files: Record<string, FileNode>;
  topics: Record<string, Topic>;
  people: Record<string, Person>;
  expandedFolderIds: string[];
  tabs: TabState[];
  activeTabId: string;
  sortBy: SortOption;
  sortDirection: SortDirection;
  thumbnailSize: number;
  renamingId: string | null;
  clipboard: {
    action: 'copy' | 'move' | null;
    items: { type: 'file' | 'tag', ids: string[] };
  };
  customTags: string[];
  folderSettings: Record<string, FolderSettings>; // 文件夹ID -> 文件夹设置
  layout: {
    isSidebarVisible: boolean;
    isMetadataVisible: boolean;
  };
  slideshowConfig: SlideshowConfig;
  settings: AppSettings;
  isSettingsOpen: boolean;
  settingsCategory: SettingsCategory;
  tasks: TaskProgress[];
  activeModal: {
    type: 'copy-to-folder' | 'move-to-folder' | 'rename-tag' | 'rename-person' | 'add-to-person' | 'add-to-topic' | 'confirm-delete-person' | 'edit-tags' | 'confirm-rename-file' | 'confirm-merge-folder' | 'confirm-extension-change' | 'alert' | 'confirm-delete-tag' | 'ai-analyzing' | 'batch-rename' | 'crop-avatar' | 'exit-confirm' | 'clear-person' | 'confirm-overwrite-file' | null;
    data?: any;
  };
  aiConnectionStatus: 'checking' | 'connected' | 'disconnected';
  dragState: DragState;
  // Optional scan progress info (used during onboarding)
  scanProgress?: { processed: number; total: number } | null;
  // Scan mode: 'cache' when loading from cache, 'full' for a full scan, 'incremental' for partial updates
  scanMode?: 'cache' | 'full' | 'incremental' | null;
  // Flag to track if directory scan is in progress (used to disable "Next" button in welcome modal)
  isScanning: boolean;
}

declare global {
  interface Window {
    __TAURI__?: any;
  }
}

export const SUPPORTED_EXTENSIONS = [
  'jpg', 'jpeg', 'tga', 'jft', 'png', 'bmp', 'webp', 'gif', 'psd', 'tif', 'tiff', 'raw', 'arw', 'dng', 'exr', 'hdr'
];
