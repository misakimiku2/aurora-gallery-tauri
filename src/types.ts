
export enum FileType {
  IMAGE = 'image',
  /** 视频（P1 视频功能引入）。序列化口径与 Rust 侧 `FileType::Video` 对齐（'video'） */
  VIDEO = 'video',
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
  /** 视频时长（毫秒）。图片无此字段（视频 P1 元数据） */
  durationMs?: number;
  /** 视频帧率。逐帧功能的前置依赖；拿不到时逐帧按钮应置灰（视频 P1 元数据） */
  frameRate?: number;
  /** 视频旋转标记（0/90/180/270）。width/height 存编码尺寸，显示尺寸按 rotation 派生（视频 P1 元数据） */
  rotation?: number;
  /** 视频编码（如 AVC / HEVC；2026-10-16 补，信息块展开区展示） */
  videoCodec?: string;
  /** 总码率（bps；2026-10-16 补） */
  bitRate?: number;
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
  size?: number;
  children?: string[];

  category?: 'general' | 'book' | 'sequence';
  author?: string;

  url?: string;
  previewUrl?: string;
  tags: string[];
  description?: string;
  /** 第一条来源网址（= `sourceUrls[0]`），给只读场景与老代码用 */
  sourceUrl?: string;
  /** 全部来源网址（P1(b)：一张图可以有多个）。顺序即 UI 显示顺序 */
  sourceUrls?: string[];
  meta?: ImageMeta;
  aiData?: AiData;

  contentUri?: string;
  mediaStoreId?: number;
  imageCount?: number;
  coverImagePath?: string;
  coverImageMediaStoreId?: number;
  coverImageWidth?: number;
  coverImageHeight?: number;
  /** 文件夹封面的多张候选图（远程设备/LAN 由服务端提供），用于堆叠显示最多 3 张封面 */
  coverImagePaths?: string[];

  createdAt?: string;
  updatedAt?: string;
  lastRefresh?: number;
  isRefreshing?: boolean;
  source?: 'local' | 'lan' | 'android';
  remotePath?: string;
  /** 远程设备标识（安卓多设备支持）：android://<key>/<id> 中的 <key> */
  remoteDeviceKey?: string;
}

export interface Person {
  id: string;
  name: string;
  coverFileId: string;
  count: number;
  description?: string;
  faceBox?: { x: number; y: number; w: number; h: number };
  characterTagName?: string;
  characterTagIndex?: number;
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
  /** 缓存的成员数量。列表查询时填充（fileIds 此时为空）。 */
  fileCount?: number;
  sourceUrl?: string;
  createdAt?: string;
  updatedAt?: string;
  sourceType?: 'manual' | 'auto_work' | 'auto_content' | 'auto_cluster' | 'auto_person' | 'folder_set';
  workName?: string;
  workNameCn?: string;
}

export interface WorkCharacter {
  tagName: string;
  tagNameCn?: string;
  personId?: string;
  imageCount: number;
  coverFileId?: string;
}

export interface WorkTopicInfo {
  workName: string;
  workNameCn?: string;
  characterCount: number;
  imageCount: number;
  characters: WorkCharacter[];
  existingTopicId?: string;
  coverFileId?: string;
  sampleFileIds?: string[];
  fileIds?: string[];
}

export interface WorkToCreate {
  name: string;
  topicType?: string;
  coverFileId?: string;
}

export interface CreateWorkTopicsResult {
  topics: Topic[];
  people: Person[];
}

// ============ P1 自动内容分类 ============

export interface CategoryCount {
  category: string;
  labelCn: string;
  count: number;
}

export interface ClassifyResult {
  total: number;
  classified: number;
  skipped: number;
  categoryCounts: CategoryCount[];
  topicsCreated: number;
}

export interface CategoryStat {
  category: string;
  count: number;
  topicId?: string;
}

export interface ClassificationOverview {
  totalIndexed: number;
  totalWithTags: number;
  categories: CategoryStat[];
}

export interface ClassifyProgress {
  current: number;
  total: number;
  progress: number;
  classified?: number;
  skipped?: number;
  stage?: string;
  topicCreated?: string;
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

// ==================== CLIP 模型设置 ====================

export type ClipModelName = 'SigLIP2-Base' | 'SigLIP2-So400M' | 'WD-EVA02-Large-Tagger-V3' | '';
export type ClipDownloadStatus = 'not_started' | 'downloading' | 'completed' | 'error';

// 模型系列类型
export type ModelSeries = 'siglip' | 'wd-tagger';

// 模型功能特性
export interface ModelFeatures {
  textSearch: boolean;      // 文本搜索
  imageSearch: boolean;     // 以图搜图
  autoTagging: boolean;     // 自动标签
  multilingual: boolean;    // 多语言支持
  animeOptimized?: boolean; // 二次元优化（可选）
}

// 系列信息
export interface ModelSeriesInfo {
  id: ModelSeries;
  name: string;
  description: string;
  color: string; // 主题色
}

export interface ClipModelInfo {
  name: ClipModelName;
  displayName: string;
  description: string;
  size: number; // 字节
  sizeDisplay: string;
  embeddingDim: number;
  isRecommended: boolean;
  series: ModelSeries; // 所属系列
  isHighPrecision?: boolean; // 是否为高精度模型
  features: ModelFeatures; // 功能特性
}

export interface ClipSettings {
  enabled: boolean;
  modelName: ClipModelName;
  useGpu: boolean;

  downloadStatus: ClipDownloadStatus;
  downloadProgress: number;
  downloadError?: string;

  modelVersion: string;
  downloadedAt?: number;

  minScore: number;        // 相似度阈值 (0.0 - 1.0)
  maxResults: number;      // 最大返回结果数
  unlimitedResults: boolean; // 是否无限制结果数

  autoAddTags: boolean;    // WD14 模型是否自动添加标签
  tagThreshold: number;    // WD14 标签置信度阈值 (0.0 - 1.0)
}

// 局域网共享设置
export interface LanShareSettings {
  // 服务器配置（桌面端使用，安卓端忽略）
  enabled: boolean;           // 是否启用局域网共享
  port: number;              // 服务端口
  accessCode: string;        // 访问验证码
  allowEdit: boolean;        // 允许编辑和删除
  allowUpload: boolean;      // 允许上传
  d32UploadMigrated?: boolean; // D32 一次性迁移标记：存量 allowUpload=false 已升新默认 true（此后手改 false 会被尊重）
  serverName?: string;       // 服务器名称（显示给客户端）
  // 客户端配置（安卓端使用，桌面端忽略）
  clientMode?: boolean;
  serverHost?: string;
  serverPort?: number;
  serverAccessToken?: string;
  savedServers?: SavedServer[];
  // 桌面端 → 安卓设备客户端配置（桌面端使用，安卓端忽略）
  androidClient?: AndroidClientSettings;
  // 多设备支持：桌面端同时连接的多台安卓设备
  androidClients?: AndroidClientConnection[];
  // 桌面端保存的安卓设备连接记录（最近设备，无 token）
  savedAndroidDevices?: SavedAndroidDevice[];
}

/** 桌面端保存的安卓设备连接记录。 */
export interface SavedAndroidDevice {
  host: string;
  port: number;
  name?: string;
  lastConnected: number;
}

/** 桌面端安卓客户端连接配置（持久化于 settings.lanShare.androidClient）。 */
export interface AndroidClientSettings {
  host?: string;
  port?: number;
  accessToken?: string;
  deviceName?: string;
  serverName?: string;
  savedDevices?: SavedAndroidDevice[];
  lastConnectedAt?: number;
}

/** 桌面端已连接的单台安卓设备（多设备支持）。 */
export interface AndroidClientConnection {
  /** 设备唯一标识 = "host:port" */
  key: string;
  host: string;
  port: number;
  accessToken?: string;
  /** 设备显示名（手机端自报，如"三星Tab S8+"） */
  serverName?: string;
  connectedAt?: number;
}

export interface SavedServer {
  host: string;
  port: number;
  name?: string;
  lastConnected: number;
  // 上次成功连接使用的访问码（用于"最近服务器"一键重连；桌面端重新生成验证码后重连失败会回退到手动填写）
  accessCode?: string;
}

// 已连接设备信息
export interface ConnectedDevice {
  id: string;                // 设备唯一标识
  name: string;              // 设备名称
  ip: string;                // IP地址
  connectedAt: number;       // 连接时间戳
  lastActiveAt: number;      // 最后活跃时间
  deviceType: string;        // 设备类型: "desktop", "tablet", "phone"
}

// 文件夹图标样式：classic = 经典 3D 文件夹（DOM）；tiles = 简洁图片瓷砖拼贴；canvas = 经典 3D 文件夹（Canvas 预合成）
export type FolderIconStyle = 'classic' | 'tiles' | 'canvas';

export interface AppSettings {
  theme: 'light' | 'dark' | 'system';
  language: 'zh' | 'en';
  folderIconStyle?: FolderIconStyle;
  autoStart: boolean;
  exitAction: 'ask' | 'minimize' | 'exit';
  animateOnHover: boolean;
  /**
   * 悬停播放视频（P1.5 配套）：鼠标悬停在视频卡片上时静音循环预览。
   * 与 GIF/WebP 的 `animateOnHover` 分开——视频解码重得多，用户可能只想开前者。
   */
  hoverPlayVideos: boolean;
  autoExtractPalette: boolean;
  paths: {
    resourceRoot: string;
    cacheRoot: string;
    /** 历史资源根（最近的在前）。切根即换库，留一份列表让用户可以切回去。 */
    rootHistory?: string[];
  };
  search: SearchSettings;
  ai: AIConfig;
  clip: ClipSettings;
  performance: {
    refreshInterval: number; // 毫秒
    scrollProfiling?: boolean; // 滚动性能记录（默认关闭）
  };
  lanShare: LanShareSettings;
  people?: Record<string, Person>; // 临时存储人物数据库，用于AI分析
  topics?: Record<string, Topic>;
  defaultLayoutSettings: {
    layoutMode: LayoutMode;
    sortBy: SortOption;
    sortDirection: SortDirection;
    groupBy: GroupByOption;
  };
}

/** U3 媒体类型筛选（2026-10-16）：undefined / 'all' = 不筛选；image / video = 仅该类型（均排除文件夹） */
export type MediaTypeFilter = 'all' | 'image' | 'video';

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
  viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview' | 'folders-overview' | 'lan-folders-overview';
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

/**
 * 编辑器画布（最小图层模型 v2）。
 *
 * 画布是**先于图层存在**的一等公民：新建空白文档时画布有尺寸、图层为空。
 * 这与 v1 的"图即画布"根本不同——那套模型下没有图层概念，图永远铺满画布。
 *
 * 设计依据：《图片编辑-最小图层模型设计》§2。
 */
export interface EditorCanvas {
  width: number;
  height: number;
  /** `'transparent'` 由前端画棋盘格；`'white'` / `'black'` 直接填实 */
  background: 'transparent' | 'white' | 'black';
}

/**
 * 图层定界框（PS 口径：屏幕上拖的那个框）。
 *
 * `w/h` 是**未旋转**的内容尺寸，旋转后的包围盒由它派生。几何部分与 `ComparisonItem`
 * 的 `x/y/width/height/rotation` 同构，所以自由变换能直接复用 comparer 的 `EditOverlay`
 * （只做一次字段改名）。`flipH/flipV/skewX/skewY` 是 `LayerBox` 独有的，它表达不了。
 */
export interface LayerBox {
  /** 定界框左上在**画布坐标系**中的位置 */
  x: number;
  y: number;
  w: number;
  h: number;
  /** 顺时针角度，任意实数（v1 只支持 90 档） */
  rotation: number;
  flipH: boolean;
  flipV: boolean;
  /**
   * 倾斜。**最小模型只存不接 UI**（已拍板）：`EditOverlay` 只用 CSS `rotate` 画框，
   * 表达不了 skew，所以自由变形先只做 移动 / 缩放 / 旋转 / 翻转 四项（画布旋转 90° 对 skew 本身是精确的）。
   */
  skewX: number;
  skewY: number;
}

/** 编辑器图层（`image` = 普通图层；`group` = 组行，见下面编组字段）。 */
export interface EditorLayer {
  id: string;
  /**
   * 缺省 `'image'`（普通图层）；`'group'` = **组行**——不是像素，是"文件夹"条目：
   * 没有 source，box 为零框占位，面板上显示为可折叠的文件夹行，
   * 成员层的 `groupId` 指向它。
   */
  kind?: 'image' | 'group';
  /** 源文件路径；空层为 undefined */
  source?: string;
  /** 源图自然尺寸。由 Rust 回传，前端不猜 */
  naturalWidth: number;
  naturalHeight: number;
  box: LayerBox;
  /** 调色：v1 挂在文档上，v2 下沉到图层（设计稿 §4.1 本就说它是图层属性） */
  adjust?: { brightness: number; contrast: number; saturation: number; temperature: number };
  visible: boolean;
  /** 组行 id。只在 `kind === 'group'` 时有意义（成员层指向它，见 `groupId`）。 */
  groupId?: string;
  /** 组行可折叠（纯 UI 态：折叠只影响面板显示，渲染/导出照常） */
  collapsed?: boolean;
  /**
   * 锁像素：禁一切**修改像素内容**的操作——现阶段 = 禁自由变换（Ctrl+T），
   * 等画笔/橡皮/填充进来后它们也归这格管。移动仍允许（PS 的"锁像素"画笔格口径）。
   */
  lockPixel?: boolean;
  /**
   * 锁位置：禁移动与变换（PS 的"锁位置"十字格口径）。画布上拖不动，
   * Ctrl+T 进不去；面板里的参数（不透明度/混合模式/调色）不受影响。
   */
  lockPosition?: boolean;
  /**
   * 混合模式，缺省 `'normal'`（普通 src-over）。
   *
   * 取值是 **CSS `mix-blend-mode` 同名的英文串**（`multiply` / `color-dodge`…）：
   * 预览直接交给 CSS、导出原样交给 Rust，两端不再各翻译一次。
   * 未知值一律落 `normal`（`normalizeBlendMode`）。
   */
  blend?: string;
  /**
   * 不透明度**百分比**（0–100，缺省 100 = 完全不透明）。
   *
   * 用百分比而不是 0–1 的浮点：与 PS 的滑杆同口径，`.aurora` 里也是人能读的整数。
   * 读的时候一律走 `layerOpacity()` / Rust 的 `unwrap_or(100)`，不要各处自己 `?? 100`。
   */
  opacity?: number;
  /**
   * **图层蒙版**（undefined = 无蒙版）。v1 蒙版 = 一张现成图片：
   * 亮度 × alpha 作为覆盖度（白 = 显示 / 黑 = 隐藏），与图层共用变换；
   * **解链**（`box` 存在）后蒙版有自己独立的定界框，可单独移动/变换。
   *
   * `naturalWidth/Height` 是蒙版图的自然尺寸（添加时从 Rust 代理取回）：
   * 解链后的变换框要按它算矩阵。蒙版上作画要等画笔工具。
   */
  mask?: {
    source: string;
    naturalWidth: number;
    naturalHeight: number;
    /** 缺省 = 链接（跟图层同框）；解链后为蒙版自己的框（画布坐标系） */
    box?: LayerBox;
    /**
     * **停用蒙版**（PS 的 Shift+点蒙版缩略图）：true = 蒙版暂时不参与合成
     * （预览按无蒙版渲染、导出载荷 mask 发 null），但蒙版数据保留——再切回来
     * 就恢复。缺省 = 启用。
     */
    disabled?: boolean;
  };
  /**
   * **剪贴蒙版**（PS 的 Clipping Mask，Alt+点行 / Ctrl+Alt+G）：这一层只显示在
   * **同分段内下方最近的基础层**（非剪贴层）有像素的地方——吃的是基础层的
   * alpha，与图层蒙版的黑白语义无关。连续多个剪贴层全部裁进同一个基础层。
   * 删除式字段：false 不落。
   */
  clipped?: boolean;
  name: string;
}

/**
 * 图片编辑（C11）文档句柄（UI 设计 §1.1）。
 *
 * 挂在 Tab 上而不是全局：一个 Tab 一个文档，多文档靠多 Tab——与本应用既有心智一致，
 * 也避免在 Tab 内再造一层文档切换 UI。
 */
export interface EditorDocument {
  /** 源文件路径；未保存的新文档为 undefined */
  path?: string;
  /** Tab 标题用 */
  name: string;
  /** 未保存圆点 */
  dirty: boolean;

  // ---- v2：最小图层模型 ----
  /**
   * 模型版本。**不存在或不是 2、且带着 v1 平铺字段** ⇒ v1 遗留数据（判据见
   * `isLegacyEditorDocument`：只看 version 会把「刚打开、画布还没建」的文档误判成旧文档）。
   *
   * 注：Tab 目前**并未持久化**（每次启动由 `useAppInit` 重建 `tabs: [defaultTab]`），
   * 所以这条今天是防御性设计——将来若给 Tab 加持久化，它就是迁移判据。
   */
  version?: 2;
  canvas?: EditorCanvas;
  /** 自底向上。v2 起可叠多层（导入图层、渲染、导出都支持）；面板仍只显示一行 */
  layers?: EditorLayer[];
  activeLayerId?: string;
  /**
   * 选中对象落在**图层本体**还是它的**蒙版**上（PS 点缩略图切换的那个状态）。
   * 缺省 `'image'`。影响：变换/拖动改谁的框（解链时）、Delete 删谁、面板缩略图
   * 的高亮框。**选区不是文档内容**：不进撤销签名、不落 `.aurora`（与
   * `activeLayerId` 同口径）。
   */
  activeTarget?: 'image' | 'mask';

  // ---- v1 遗留（v2 切换后已无人读取，待删）：crop / rotation / flipH / flipV / adjust ----
  /**
   * **v1 遗留字段**：v2 的画布/图层一律用 `canvas` + `layers`，全仓只有
   * `isLegacyEditorDocument` 读它做旧文档判定。
   * 保留只是为了让旧会话对象仍能通过类型检查（见 `isLegacyEditorDocument`）。
   *
   * 累积裁剪（v1 的"当前可见坐标系"像素坐标，左上原点）。undefined = 未裁剪。
   *
   * 注意"当前可见坐标系"：v1 的渲染顺序是 rotate → flip → crop，所以旋转/翻转之后
   * 这个矩形必须在同一时刻被换算到新坐标系（`rotateCropRect` / `flipCropRect`）。
   * 存绝对坐标而不是"上一次的增量"，是为了让后端永远只对原图处理一次，
   * 连裁多刀不累积重编码损失。
   */
  crop?: { x: number; y: number; w: number; h: number };
  /** 顺时针旋转角度：0 / 90 / 180 / 270 */
  rotation?: number;
  /** 水平镜像 */
  flipH?: boolean;
  /** 垂直镜像 */
  flipV?: boolean;
  /**
   * **v1 遗留字段**：调色参数（-100..100，0 = 不变）。
   *
   * 它已经**下沉到 `EditorLayer.adjust`**（语义上本来就是图层属性），这里不再被读取。
   * 见 `isLegacyEditorDocument`：这几个 v1 字段只要有一个非空，就说明是旧文档。
   */
  adjust?: { brightness: number; contrast: number; saturation: number; temperature: number };
}

/**
 * 编辑器工具（键位与语义照 Photoshop，UI 设计 §3）。
 *
 * 已放行 `move` / `transform` / `crop` / `hand` / `zoom`；其余是骨架占位，
 * 工具栏上灰显——**故意显示出来而不是藏起来**，因为 PS 的心智是"工具在那儿，
 * 我还没用到"，藏起来反而让人以为产品缺功能。
 */
export type EditorToolId =
  | 'move'
  | 'transform'
  | 'crop'
  | 'hand'
  | 'zoom'
  | 'eyedropper'
  | 'brush'
  | 'eraser'
  | 'fill'
  | 'text'
  | 'pen'
  | 'shape';

export interface TabState {
  id: string;
  folderId: string;
  viewingFileId: string | null;
  /**
   * `'editor'` = 图片编辑态（C11）。
   *
   * 它与 `isCompareMode` **互斥**——参考板与工作台不能共存于一个 Tab，两个独立布尔会
   * 产生「都为 true」的非法态，在 UI 上表现为随机崩一半（UI 设计 §1.1）。旧持久化数据
   * 没有这个取值，读出即浏览态。
   */
  viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview' | 'folders-overview' | 'lan-folders-overview' | 'editor';
  layoutMode: LayoutMode;
  searchQuery: string;
  searchScope: SearchScope;
  aiFilter?: AiSearchFilter | null;
  activeTags: string[];
  activePersonId: string | null;
  activeTopicId: string | null;
  selectedTopicIds: string[];
  dateFilter: DateFilter;
  /** U3 媒体类型筛选（2026-10-16）：旧持久化数据无此字段 = 不筛选 */
  mediaTypeFilter?: MediaTypeFilter;
  selectedFileIds: string[];
  lastSelectedId: string | null;
  selectedTagIds: string[];
  selectedPersonIds: string[];
  currentPage: number;
  isCompareMode: boolean;
  sessionName?: string;
  /** 图片编辑文档句柄；仅 `viewMode === 'editor'` 时有值，与 `isCompareMode` 互斥 */
  editorDocument?: EditorDocument;
  /**
   * 图片编辑：当前选中的工具。未设 = `move`（PS 默认工具）；**`null` = 不选任何工具**。
   *
   * 为什么允许"没有工具"：同一个快捷键再按一次就取消（用户 2026-10-24 的意见）——
   * 连续按 V 不该把人锁死在移动工具上。没有工具时画布只响应滚轮/空格平移，
   * 点图层什么都不发生（光标是普通箭头）。
   *
   * **进入编辑器一律不激活工具**（用户 2026-10-24 再确认）：新建空白文档、
   * 从画廊打开图片、打开 `.aurora` 工程三个入口都把这里置 `null`，
   * 不像 PS 那样默认落在移动工具上。
   */
  editorTool?: EditorToolId | null;
  scrollToItemId?: string;
  history: {
    stack: HistoryItem[];
    currentIndex: number;
  };
  scrollTop: number;
}

export type SettingsCategory = 'general' | 'video' | 'appearance' | 'network' | 'storage' | 'ai' | 'aiVision' | 'performance' | 'lanShare' | 'about';

export interface PreviewTag {
  name: string;
  name_cn: string;
  count: number;
  sample_file_ids: string[];
}

export interface TagsPreviewResult {
  tags: PreviewTag[];
  total_files: number;
  files_with_tags: number;
}

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
    isColorPickerVisible: boolean;
  };
  slideshowConfig: SlideshowConfig;
  settings: AppSettings;
  isSettingsOpen: boolean;
  settingsCategory: SettingsCategory;
  tasks: TaskProgress[];
  activeModal: {
    type: 'copy-to-folder' | 'move-to-folder' | 'rename-tag' | 'rename-person' | 'add-to-person' | 'add-to-topic' | 'confirm-delete-person' | 'confirm-delete-file' | 'edit-tags' | 'confirm-extension-change' | 'alert' | 'confirm-delete-tag' | 'ai-analyzing' | 'batch-rename' | 'ai-batch-rename' | 'crop-avatar' | 'exit-confirm' | 'clear-person' | 'confirm-overwrite-file' | 'create-topic' | 'create-person' | 'rename-topic' | 'smart-create-person' | 'smart-add-to-person' | 'smart-create-topic' | 'auto-generate-tags' | 'update' | null;
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

// 说明（视频 P1，设计方案 §2.7 口径 C）：原先此处的 SUPPORTED_EXTENSIONS（18 种，
// 含 psd/raw 等历史遗留）经全仓核实为死代码（无任何调用点），已删除。
// 前端扩展名真源迁至 `src/utils/mediaExtensions.ts`（与 core/src/file_types.rs 同步）。

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

// ==================== CLIP 相关类型 ====================

/// CLIP 搜索结果项
export interface ClipSearchResult {
  /// 文件 ID
  file_id: string;
  /// 相似度分数 (0.0 - 1.0)
  score: number;
  /// 排名
  rank: number;
}

/// CLIP 搜索选项
export interface ClipSearchOptions {
  /// 返回结果数量
  top_k?: number;
  /// 最小相似度阈值
  min_score?: number;
}

/// CLIP 模型配置
export interface ClipConfig {
  /// 模型名称
  model_name: string;
  /// 是否使用 GPU
  use_gpu: boolean;
  /// 向量维度
  embedding_dim: number;
}

/// CLIP 嵌入状态
export interface ClipEmbeddingStatus {
  /// 文件 ID
  file_id: string;
  /// 是否已有嵌入
  has_embedding: boolean;
  /// 模型版本（如果有）
  model_version?: string;
  /// 创建时间（如果有）
  created_at?: number;
}

/// CLIP 统计信息
export interface ClipStats {
  /// 嵌入向量总数
  embedding_count: number;
  /// 模型是否已加载
  is_model_loaded: boolean;
  /// 当前模型名称
  current_model?: string;
}

/// 角色标签（WD14 category=4）
export interface CharacterTag {
  tag_id: string;
  name: string;
  name_cn: string;
  index: number;
}

/// 已检测到的角色
export interface DetectedCharacter {
  tag_name: string;
  tag_name_cn: string;
  tag_index: number;
  file_count: number;
  max_score: number;
  sample_file_id: string;
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
