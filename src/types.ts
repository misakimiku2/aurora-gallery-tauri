
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
  /** Transient UI-only flag used to show a loading state for folder-level refreshes */
  isRefreshing?: boolean;
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
  // 在线服务商预设
  onlineServicePreset?: string; // 预设ID: 'openai' | 'gemini' | 'zhipu' | 'custom' 等
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
  defaultLayoutSettings: {
    layoutMode: LayoutMode;
    sortBy: SortOption;
    sortDirection: SortDirection;
    groupBy: GroupByOption;
  };
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

// 人物视图专用的排序和分组选项
export type PersonSortOption = 'name' | 'count' | 'created';
export type PersonGroupByOption = 'none' | 'name' | 'topic';

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
  currentPage?: number;
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
  currentPage: number;
  isCompareMode: boolean;
  sessionName?: string;
  scrollToItemId?: string;
  history: {
    stack: HistoryItem[];
    currentIndex: number;
  };
  scrollTop: number;
}

export type SettingsCategory = 'general' | 'appearance' | 'network' | 'storage' | 'ai' | 'performance' | 'about';

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
    type: 'copy-to-folder' | 'move-to-folder' | 'rename-tag' | 'rename-person' | 'add-to-person' | 'add-to-topic' | 'confirm-delete-person' | 'edit-tags' | 'confirm-rename-file' | 'confirm-merge-folder' | 'confirm-extension-change' | 'alert' | 'confirm-delete-tag' | 'ai-analyzing' | 'batch-rename' | 'ai-batch-rename' | 'crop-avatar' | 'exit-confirm' | 'clear-person' | 'confirm-overwrite-file' | 'create-topic' | 'rename-topic' | 'update' | null;
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
  'jpg', 'jpeg', 'tga', 'jft', 'png', 'bmp', 'webp', 'gif', 'psd', 'tif', 'tiff', 'raw', 'arw', 'dng', 'exr', 'hdr', 'avif', 'jxl'
];

// 更新检查相关类型
export type DownloadState = 'idle' | 'preparing' | 'downloading' | 'paused' | 'completed' | 'error';

export interface DownloadProgress {
  state: DownloadState;
  progress: number;        // 0.0 - 100.0
  downloadedBytes: number;
  totalBytes: number;
  speedBytesPerSec: number;
  filePath: string;
  errorMessage?: string;
}

export interface UpdateInfo {
  hasUpdate: boolean;
  currentVersion: string;
  latestVersion: string;
  downloadUrl: string;
  installerUrl?: string;
  installerSize?: number;
  releaseName?: string;
  releaseNotes: string;
  publishedAt: string;
}

export interface UpdateSettings {
  autoCheck: boolean;
  checkFrequency: 'startup' | 'daily' | 'weekly';
  ignoredVersions: string[];
  lastCheckTime?: number;
}

// AI 服务商预设接口
export interface AIModelOption {
  id: string;
  name: string;
  description: string;
  vision: boolean;
  recommended?: boolean;
}

export interface AIServicePreset {
  id: string;
  name: string;
  description: string;
  endpoint: string;
  requiresApiKey: boolean;
  apiKeyPlaceholder: string;
  apiKeyHelpUrl?: string;
  models: AIModelOption[];
}

// 在线 AI 服务商预设列表 - 2026年2月更新
export const AI_SERVICE_PRESETS: AIServicePreset[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    description: 'OpenAI 官方 API',
    endpoint: 'https://api.openai.com/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelpUrl: 'https://platform.openai.com/api-keys',
    models: [
      { id: 'gpt-5.2', name: 'GPT-5.2', description: '最新旗舰模型，支持视觉', vision: true, recommended: true },
      { id: 'gpt-5.3-codex-spark', name: 'GPT-5.3 Codex Spark', description: '实时编程专用', vision: false },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: '轻量快速，支持视觉', vision: true },
      { id: 'gpt-4-turbo', name: 'GPT-4 Turbo', description: '稳定的文本模型', vision: true }
    ]
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    description: 'Google AI 模型',
    endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai',
    requiresApiKey: true,
    apiKeyPlaceholder: 'AIza...',
    apiKeyHelpUrl: 'https://aistudio.google.com/app/apikey',
    models: [
      { id: 'gemini-2.5-pro-preview-03-25', name: 'Gemini 2.5 Pro Preview', description: '最强推理能力，2M上下文', vision: true, recommended: true },
      { id: 'gemini-2.5-flash-preview-04-17', name: 'Gemini 2.5 Flash Preview', description: '极速多模态', vision: true },
      { id: 'gemini-2.0-flash', name: 'Gemini 2.0 Flash', description: '稳定版快速模型', vision: true },
      { id: 'gemini-2.0-flash-lite', name: 'Gemini 2.0 Flash Lite', description: '轻量经济', vision: true }
    ]
  },
  {
    id: 'zhipu',
    name: '智谱 AI',
    description: '智谱大模型 - 2026年2月发布GLM-5',
    endpoint: 'https://open.bigmodel.cn/api/paas/v4',
    requiresApiKey: true,
    apiKeyPlaceholder: 'your-api-key',
    apiKeyHelpUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    models: [
      { id: 'glm-5', name: 'GLM-5', description: '最新旗舰，编程与Agent能力最强', vision: true, recommended: true },
      { id: 'glm-4v', name: 'GLM-4V', description: '视觉理解模型', vision: true },
      { id: 'glm-4', name: 'GLM-4', description: '通用大模型', vision: false },
      { id: 'glm-4v-flash', name: 'GLM-4V Flash', description: '轻量视觉模型', vision: true }
    ]
  },
  // 国内服务商
  {
    id: 'dashscope',
    name: '阿里云 通义千问',
    description: '阿里云 DashScope 大模型平台',
    endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelpUrl: 'https://dashscope.console.aliyun.com/apiKey',
    models: [
      { id: 'qwen3-max', name: 'Qwen3-Max', description: '万亿参数旗舰模型', vision: true, recommended: true },
      { id: 'qwen3-max-thinking', name: 'Qwen3-Max-Thinking', description: '推理增强版', vision: true },
      { id: 'qwen-vl-max', name: 'Qwen-VL Max', description: '视觉理解最强版', vision: true },
      { id: 'qwen-vl-plus', name: 'Qwen-VL Plus', description: '视觉理解增强版', vision: true },
      { id: 'qwen-plus', name: 'Qwen Plus', description: '通用大模型', vision: false }
    ]
  },
  {
    id: 'moonshot',
    name: '月之暗面 Kimi',
    description: 'Moonshot AI 大模型',
    endpoint: 'https://api.moonshot.cn/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelpUrl: 'https://platform.moonshot.cn/console/api-keys',
    models: [
      { id: 'moonshot-v1-8k', name: 'Kimi 8K', description: '8K 上下文', vision: false, recommended: true },
      { id: 'moonshot-v1-32k', name: 'Kimi 32K', description: '32K 上下文', vision: false },
      { id: 'moonshot-v1-128k', name: 'Kimi 128K', description: '128K 长文本', vision: false }
    ]
  },
  {
    id: 'siliconflow',
    name: '硅基流动',
    description: 'SiliconFlow 模型聚合平台',
    endpoint: 'https://api.siliconflow.cn/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-...',
    apiKeyHelpUrl: 'https://cloud.siliconflow.cn/account/ak',
    models: [
      { id: 'THUDM/glm-5', name: 'GLM-5', description: '智谱最新旗舰', vision: true, recommended: true },
      { id: 'Qwen/Qwen3-VL-Max', name: 'Qwen3-VL Max', description: '通义千问视觉', vision: true },
      { id: 'deepseek-ai/DeepSeek-V3', name: 'DeepSeek V3', description: 'DeepSeek 最强模型', vision: false }
    ]
  },
  // 国际服务商
  {
    id: 'anthropic',
    name: 'Anthropic Claude',
    description: 'Claude AI 模型 - 2026年2月发布Opus 4.6',
    endpoint: 'https://api.anthropic.com/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-ant-...',
    apiKeyHelpUrl: 'https://console.anthropic.com/settings/keys',
    models: [
      { id: 'claude-opus-4.6', name: 'Claude Opus 4.6', description: '最强编程与推理', vision: true, recommended: true },
      { id: 'claude-opus-4', name: 'Claude Opus 4', description: '强大的多模态模型', vision: true },
      { id: 'claude-sonnet-4', name: 'Claude Sonnet 4', description: '平衡性能与速度', vision: true },
      { id: 'claude-3.5-sonnet', name: 'Claude 3.5 Sonnet', description: '稳定版', vision: true }
    ]
  },
  {
    id: 'xai',
    name: 'xAI Grok',
    description: 'xAI Grok 模型',
    endpoint: 'https://api.x.ai/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'xai-...',
    apiKeyHelpUrl: 'https://x.ai/api',
    models: [
      { id: 'grok-4-vision', name: 'Grok 4 Vision', description: '视觉理解模型', vision: true, recommended: true },
      { id: 'grok-4', name: 'Grok 4', description: '通用模型', vision: false },
      { id: 'grok-2-vision-latest', name: 'Grok 2 Vision', description: '稳定版视觉', vision: true }
    ]
  },
  {
    id: 'azure',
    name: 'Azure OpenAI',
    description: '微软 Azure OpenAI 服务',
    endpoint: 'https://your-resource.openai.azure.com/openai/deployments/your-deployment',
    requiresApiKey: true,
    apiKeyPlaceholder: 'your-api-key',
    apiKeyHelpUrl: 'https://portal.azure.com/#blade/HubsExtension/BrowseResource/resourceType/Microsoft.CognitiveServices%2Faccounts',
    models: [
      { id: 'gpt-5.2', name: 'GPT-5.2', description: '最新多模态旗舰', vision: true, recommended: true },
      { id: 'gpt-4o-mini', name: 'GPT-4o Mini', description: '轻量视觉模型', vision: true },
      { id: 'gpt-4', name: 'GPT-4', description: '强大文本模型', vision: false }
    ]
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    description: 'OpenRouter 模型聚合平台',
    endpoint: 'https://openrouter.ai/api/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'sk-or-...',
    apiKeyHelpUrl: 'https://openrouter.ai/keys',
    models: [
      { id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', description: 'Anthropic 最强', vision: true, recommended: true },
      { id: 'google/gemini-2.5-pro-preview-03-25', name: 'Gemini 2.5 Pro Preview', description: 'Google 最强', vision: true },
      { id: 'openai/gpt-5.2', name: 'GPT-5.2', description: 'OpenAI 最新', vision: true },
      { id: 'thudm/glm-5', name: 'GLM-5', description: '智谱开源', vision: true }
    ]
  },
  {
    id: 'together',
    name: 'Together AI',
    description: 'Together AI 开源模型平台',
    endpoint: 'https://api.together.xyz/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'your-api-key',
    apiKeyHelpUrl: 'https://api.together.xyz/settings/api-keys',
    models: [
      { id: 'meta-llama/Llama-4-Vision-Instruct', name: 'Llama 4 Vision', description: 'Meta 最新视觉模型', vision: true, recommended: true },
      { id: 'meta-llama/Llama-3.3-70B-Instruct-Turbo', name: 'Llama 3.3 70B', description: 'Meta 大模型', vision: false },
      { id: 'Qwen/Qwen3-VL-Max', name: 'Qwen3-VL Max', description: '通义千问视觉', vision: true }
    ]
  },
  {
    id: 'fireworks',
    name: 'Fireworks AI',
    description: 'Fireworks AI 快速推理平台',
    endpoint: 'https://api.fireworks.ai/inference/v1',
    requiresApiKey: true,
    apiKeyPlaceholder: 'your-api-key',
    apiKeyHelpUrl: 'https://fireworks.ai/account/api-keys',
    models: [
      { id: 'accounts/fireworks/models/llama-4-vision-instruct', name: 'Llama 4 Vision', description: 'Meta 最新视觉模型', vision: true, recommended: true },
      { id: 'accounts/fireworks/models/qwen3-vl-max', name: 'Qwen3-VL Max', description: '通义千问视觉', vision: true }
    ]
  },
  {
    id: 'custom',
    name: '自定义',
    description: '其他 OpenAI 兼容服务',
    endpoint: '',
    requiresApiKey: true,
    apiKeyPlaceholder: 'your-api-key',
    models: [
      { id: 'custom-model', name: '自定义模型', description: '手动输入模型名称', vision: true }
    ]
  }
];
