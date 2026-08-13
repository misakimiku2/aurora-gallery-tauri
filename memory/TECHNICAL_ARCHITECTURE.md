# Aurora Gallery Tauri 技术架构文档

## 系统架构概览

### 整体架构图
```
┌─────────────────────────────────────────────────────────────┐
│                    用户界面层 (React)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ App      │  │组件库    │  │服务层    │  │工具库    │   │
│  │          │  │          │  │          │  │          │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┴──────────┘   │
│       │             │             │                      │
│       └─────────────┴─────────────┴──────────────────────┘
│                              │                              │
│                    Tauri IPC Bridge                         │
│                              │                              │
┌──────────────────────────────┼──────────────────────────────┐
│                              │                              │
│                  Rust 后端层 (Native)                       │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Main     │  │Color DB  │  │Color     │  │Color     │   │
│  │ Entry    │  │          │  │Extractor │  │Worker    │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │             │             │          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │Thumbnail │  │Color     │  │File      │  │Topic     │   │
│  │Generator │  │Search    │  │Index     │  │DB        │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │             │             │          │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │  CLIP    │  │ Update   │  │  Db      │  │ LanShare │   │
│  │ Commands │  │ Commands │  │ Commands │  │ Server   │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │             │             │          │
│  ┌──────────┐  ┌──────────┐                                   │
│  │ Work     │  │ LanShare │                                   │
│  │ Extractor│  │ Handlers │                                   │
│  └────┬─────┘  └────┬─────┘                                   │
│       │             │                                          │
│       └─────────────┴─────────────────────────────────────────┘
│                              │                              │
│                    SQLite 数据库                             │
│                    文件系统                                   │
│                    AI API (OpenAI/Ollama/LM Studio)         │
│                    CLIP 模型 (ONNX Runtime)                  │
│                    HTTP 服务器 (局域网共享)                   │
└─────────────────────────────────────────────────────────────┘
```

## 分层架构设计

### 1. 表现层 (Presentation Layer)

#### React 组件架构
```typescript
// 组件层次结构
App (根组件 - 4362 行) （以源码为准 · 已同步）
├── TabBar (标签页管理 - 456 行)
├── TopBar (工具栏 - 1141 行)
├── Sidebar (侧边栏)
│   ├── TreeSidebar (文件树 - 1518 行)
│   └── TaskProgressModal (任务进度 - 78 行)
├── MainContent (主内容区)
│   ├── PersonGrid (人物网格 - 440 行) （以源码为准 · 已同步）
│   ├── PeopleCanvas (人物画布 - 342 行) [新增]
│   ├── FileGrid (文件网格 - 1414 行) （以源码为准 · 已同步）
│   ├── ImageViewer (图片查看器 - 1482 行)
│   ├── ImageComparer (图片对比 - 2039 行)
│   ├── TopicModule (专题模块 - 2485 行)
│   └── TagsList (标签列表 - 312 行)
├── MetadataPanel (元数据面板 - 2409 行)
├── SettingsModal (设置模态框 - 3774 行) （以源码为准 · 已同步）
├── Modals (模态框集合 - src/components/modals/) [重构]
│   ├── FolderPickerModal (文件夹选择 - 141 行)
│   ├── BatchRenameModal (批量重命名 - 57 行)
│   ├── AIBatchRenameModal (AI 批量重命名 - 376 行) [新增]
│   ├── AddImageModal (添加图片 - 1163 行) [新增]
│   ├── AutoGenerateTagsModal (自动生成标签 - 410 行) [新增]
│   ├── SmartCreatePersonModal (智能创建人物 - 921 行) [新增]
│   ├── SmartCreateTopicModal (智能创建专题 - 691 行) [新增]
│   ├── SmartAddToPersonModal (智能添加到人物 - 505 行) [新增]
│   ├── UpdateModal (更新模态框 - 360 行) [新增]
│   ├── WelcomeModal (欢迎向导 - 187 行)
│   ├── CreateTopicModal (创建专题 - 66 行)
│   ├── RenameTopicModal (重命名专题 - 68 行)
│   └── [其他 10+ 模态框...]
├── Settings (设置面板 - src/components/settings/)
│   └── LanSharePanel (局域网共享设置 - 346 行) [新增]
├── AIRenameButton (AI 重命名按钮 - 36 行) [新增]
├── AIRenamePreview (AI 重命名预览 - 38 行) [新增]
└── Toasts (通知)
```

#### 状态管理策略
```typescript
// 使用 React Hooks 进行状态管理
const [state, setState] = useState<AppState>({
  // ... (基础状态)
})

// 任务状态管理 (extracted to useTasks.ts)
const { tasks, startTask, updateTask } = useTasks(t);
// tasks: 包含所有后台任务 (复制/移动/AI/色彩提取)
// updateTask: 负责处理进度更新、防抖和自动完成清理

// 导航历史管理 (extracted to useNavigation.ts)
const { navigateTo, goBack, goForward, history } = useNavigation();
// 支持前进/后退导航，自动保存滚动位置和选中状态

// AI 智能重命名 (extracted to useAIRename.ts) [新增]
const { isGenerating, previewName, generateName, applyRename, cancelRename } = useAIRename({
  settings, people, onUpdate, showToast, t
});
// 支持根据图片内容生成语义化文件名

// 更新检查 (extracted to useUpdateCheck.ts) [新增]
const { updateInfo, isChecking, isDownloading, downloadProgress, checkUpdate, startDownload, installUpdate } = useUpdateCheck();
// 支持应用更新检查和下载

// 实时元数据同步
// - 监听 'metadata-updated' 全局事件以更新 App 状态中的文件元数据。
// - 用于处理后台扫描、AI 标签生成等异步数据的即时反馈。

// 其他重要自定义 Hooks:
// - useAIAnalysis: 封装文件/文件夹级别 AI 分析流程并与 aiService 协作
// - useFileOperations: 统一封装复制/移动/重命名/删除等文件操作
// - useContextMenu: 管理右键菜单的位置/项与交互
// - useFileSearch: 搜索逻辑（处理 color:/palette: 前缀）
// - useMarqueeSelection: 框选与范围选择逻辑
// - useKeyboardShortcuts: 键盘快捷键管理
// - useInView: 视口检测
// - useToasts: Toast 通知管理

// 文件系统状态
  roots: [],
  files: {},
  expandedFolderIds: [],
  
  // UI 状态
  tabs: [],
  activeTabId: '',
  layout: { isSidebarVisible: true, isMetadataVisible: true },
  
  // 业务状态
  people: {},
  topics: {},  // [新增] 专题数据
  customTags: [],
  tasks: [],
  
  // 设置
  settings: {
    theme: 'system',
    language: 'zh',
    ai: { 
      provider: 'ollama',
      systemPrompt: '',
      promptPresets: [], // 系统提示预设
      currentPresetId: undefined
    }
  }
})

// 派生状态（useMemo）
const activeTab = useMemo(() => {
  return state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB
}, [state.tabs, state.activeTabId])

const displayFileIds = useMemo(() => {
  // 复杂的过滤、排序、分组逻辑
}, [state.files, activeTab, state.sortBy, state.sortDirection])
```

#### Web Worker 架构
```typescript
// 布局计算 Worker
// src/workers/layout.worker.ts (252 行)
// 功能: 在 Worker 线程中执行布局计算，避免阻塞主线程
// 支持: Grid、Masonry、Adaptive、List、Tags Overview 布局

// 搜索计算 Worker
// src/workers/search.worker.ts (125 行)
// 功能: 在 Worker 线程中执行搜索过滤

// 使用示例
const worker = new Worker(new URL('./workers/layout.worker.ts', import.meta.url));
worker.postMessage({
  type: 'calculate',
  files: fileList,
  containerWidth: 1200,
  thumbnailSize: 200,
  layoutMode: 'masonry'
});
```

### 2. 业务逻辑层 (Business Logic Layer)

#### 服务层架构

##### AI 服务 (aiService.ts)
**位置**: `src/services/aiService.ts`  
**行数**: 727 行（以源码为准 · 已同步）  
**功能**: OpenAI/Ollama/LM Studio/Gemini/智谱AI 集成

**支持的 AI 提供商**:
- OpenAI (GPT-4o, GPT-4o-mini, GPT-4 Turbo)
- Gemini (Gemini 2.0/2.5/3.0 系列)
- 智谱 AI (GLM-4V, GLM-4)
- Ollama (本地 LLM)
- LM Studio (本地模型管理)
- 自定义 API 端点

**2026-01-14 更新**: AI 分析优化
```typescript
// 优化前：AI 分析包含 dominantColors（消耗 tokens）
const aiAnalysis = await analyzeImageWithAI(imagePath, {
  includeColors: true, // 消耗 AI tokens
  // ...
});

// 优化后：dominantColors 通过专用算法提取，不消耗 AI tokens
const aiAnalysis = await analyzeImageWithAI(imagePath, {
  includeColors: false, // 关闭 AI 颜色分析
  // ...
});

// 颜色通过专用算法提取
const dominantColors = await getDominantColors(imagePath, 8);
```

**2026-02-07 更新**: 新增 OCR 和翻译功能
```typescript
// AI 分析支持 OCR 和翻译
const aiAnalysis = await analyzeImageWithAI(imagePath, {
  performOCR: true,        // 提取图片中的文字
  translateText: true,     // 翻译提取的文字
  targetLanguage: 'zh'     // 目标语言
});
// 结果包含 extractedText 和 translatedText
```

**2026-02-11 更新**: 新增 AI 智能重命名功能
```typescript
// 单文件重命名
const newName = await aiService.generateSingleFileName(
  filePath,
  currentName,
  settings,
  personNames  // 可选的人物名称列表
);

// 批量重命名
const results = await aiService.generateFileNames(
  files,
  settings,
  (progress) => console.log(`${progress}%`)  // 进度回调
);
```

##### 人脸识别服务 (faceRecognitionService.ts)
**位置**: `src/services/faceRecognitionService.ts`  
**行数**: 86 行（以源码为准 · 已同步）  
**功能**: 基于 face-api.js 的人脸识别

### 3. 数据访问层 (Data Access Layer)

#### Tauri Bridge API
**位置**: `src/api/tauri-bridge/`（目录，原单文件 `src/api/tauri-bridge.ts` 已按领域拆分，`index.ts` 聚合导出）  
**功能**: 前后端通信桥接

**核心功能**:
```typescript
// 文件系统操作
export const scanDirectory = async (path: string, forceRefresh?: boolean): Promise<{ roots: string[]; files: Record<string, FileNode> }> => { ... }
export const forceRescan = async (path: string): Promise<{ roots: string[]; files: Record<string, FileNode> }> => { ... }
export const scanFile = async (filePath: string, parentId?: string | null): Promise<FileNode> => { ... }
export const renameFile = async (oldPath: string, newPath: string): Promise<void> => { ... }
export const deleteFile = async (path: string): Promise<void> => { ... }
export const copyFile = async (src: string, dest: string): Promise<string> => { ... }
export const copyImageColors = async (src: string, dest: string): Promise<void> => { ... }
export const copyImageToClipboard = async (filePath: string): Promise<void> => { ... }
export const moveFile = async (src: string, dest: string): Promise<void> => { ... }
export const writeFileFromBytes = async (path: string, bytes: number[]): Promise<void> => { ... }

// 窗口管理
export const setWindowMinSize = async (width: number, height: number): Promise<void> => { ... }
export const isWindowMaximized = async (): Promise<boolean> => { ... }
export const hideWindow = async (): Promise<void> => { ... }
export const showWindow = async (): Promise<void> => { ... }
export const exitApp = async (): Promise<void> => { ... }

// 缩略图
export const getThumbnail = async (filePath: string, modified?: string, rootPath?: string, signal?: AbortSignal, onColors?: (colors: DominantColor[] | null) => void): Promise<string | null> => { ... }
export const generateDragPreview = async (thumbnailPaths: string[], totalCount: number, cacheRoot: string): Promise<string | null> => { ... }
getAssetUrl(filePath: string): string

// 颜色相关
export const getDominantColors = async (filePath: string, count?: number, thumbnailPath?: string): Promise<DominantColor[]> => { ... }
export const searchByColor = async (color: string): Promise<string[]> => { ... }
export const searchByPalette = async (palette: string[]): Promise<string[]> => { ... }
export const pauseColorExtraction = async (): Promise<void> => { ... }
export const resumeColorExtraction = async (): Promise<void> => { ... }

// 颜色数据库管理
export const getColorDbStats = async (): Promise<ColorDbStats> => { ... }
export const getColorDbErrorFiles = async (): Promise<ColorDbErrorFile[]> => { ... }
export const retryColorExtraction = async (filePaths?: string[]): Promise<number> => { ... }
export const deleteColorDbErrorFiles = async (filePaths: string[]): Promise<number> => { ... }

// 数据库操作
export const dbGetAllPeople = async (): Promise<Person[]> => { ... }
export const dbUpsertPerson = async (person: Person): Promise<void> => { ... }
export const dbDeletePerson = async (id: string): Promise<void> => { ... }
export const dbUpdatePersonAvatar = async (personId: string, coverFileId: string, faceBox?: FaceBox): Promise<void> => { ... }
export const dbCopyFileMetadata = async (srcPath: string, destPath: string): Promise<void> => { ... }
export const switchRootDatabase = async (newRootPath: string): Promise<void> => { ... }
export const addPendingFilesToDb = async (filePaths: string[]): Promise<number> => { ... }
export const dbGetAllFileMetadata = async (): Promise<FileMetadata[]> => { ... }
export const dbUpsertFileMetadata = async (metadata: FileMetadata): Promise<void> => { ... }

// 专题数据库操作
export const dbGetAllTopics = async (): Promise<Topic[]> => { ... }
export const dbUpsertTopic = async (topic: Topic): Promise<void> => { ... }
export const dbDeleteTopic = async (id: string): Promise<void> => { ... }

// CLIP 向量搜索
export const clipSearchByText = async (text: string, options?: ClipSearchOptions, modelName?: string): Promise<ClipSearchResult[]> => { ... }
export const clipSearchByImage = async (imagePath: string, options?: ClipSearchOptions, modelName?: string): Promise<ClipSearchResult[]> => { ... }
export const clipGenerateEmbedding = async (filePath: string, fileId?: string, autoAddTags?: boolean, tagThreshold?: number, language?: string): Promise<number[]> => { ... }
export const clipLoadModel = async (modelName: string): Promise<void> => { ... }
export const clipUnloadModel = async (): Promise<void> => { ... }
export const clipIsModelLoaded = async (): Promise<boolean> => { ... }
export const clipGetEmbeddingCount = async (): Promise<number> => { ... }
export const clipGenerateEmbeddingsBatch = async (files: [string, string][], useGpu: boolean, modelName?: string, autoAddTags?: boolean, tagThreshold?: number, language?: string): Promise<ClipBatchEmbeddingResult> => { ... }
export const clipGetCharacterTags = async (language?: string): Promise<CharacterTag[]> => { ... }
export const clipGetDetectedCharacters = async (minScore: number, minCount?: number, language?: string): Promise<DetectedCharacter[]> => { ... }
export const clipGetModelStatus = async (modelName: string): Promise<ModelStatus> => { ... } // [新增]
export const clipDeleteModel = async (modelName: string): Promise<void> => { ... } // [新增]
export const clipGetWorkTopics = async (minScore: number, language?: string): Promise<WorkTopic[]> => { ... } // [新增]
export const clipCreateWorkTopics = async (workIds: string[], topicType?: string): Promise<void> => { ... } // [新增]
export const clipPreviewTagsFromEmbeddings = async (fileIds: string[], threshold: number): Promise<TagPreview[]> => { ... } // [新增]
export const clipGenerateTagsFromEmbeddings = async (fileIds: string[], threshold: number): Promise<void> => { ... } // [新增]

// 局域网共享 [新增]
export const lanShareStart = async (password: string, port?: number, allowEdit?: boolean): Promise<void> => { ... }
export const lanShareStop = async (): Promise<void> => { ... }
export const lanShareGetStatus = async (): Promise<LanShareStatus> => { ... }
export const lanShareGetDevices = async (): Promise<LanDevice[]> => { ... }
export const lanShareGetLocalIp = async (): Promise<string> => { ... }
export const lanShareCheckPort = async (port: number): Promise<boolean> => { ... }
export const lanShareUpdateConfig = async (password?: string, port?: number, allowEdit?: boolean): Promise<void> => { ... }

// 更新检查
export const checkForUpdates = async (): Promise<UpdateCheckResult> => { ... }
export const startUpdateDownload = async (installerUrl: string, version: string): Promise<void> => { ... }
export const getUpdateDownloadProgress = async (): Promise<DownloadProgressResult> => { ... }
export const installUpdate = async (): Promise<void> => { ... }

// 其他
export const openExternalLink = async (url: string): Promise<void> => { ... }
export const proxyHttpRequest = async (url: string, method?: string, headers?: Record<string, string>, body?: string): Promise<string> => { ... }
```

### 4. 基础设施层 (Infrastructure Layer)

#### Rust 后端架构

##### 模块结构 (2026-03-14 更新)
```
src-tauri/src/
├── main.rs              # 入口文件 (359 行) （以源码为准 · 已同步）
│
├── 📁 核心模块
│   ├── file_types.rs    # 类型定义 (FileType, FileNode, ImageMeta) - 62 行
│   ├── image_utils.rs   # 图像工具 (JXL/AVIF 支持) - 137 行
│   └── scanner.rs       # 目录扫描 (HDD 检测优化) - 547 行
│
├── 📁 命令模块
│   ├── file_operations.rs  # 文件操作命令 - 763 行
│   ├── clip_commands.rs    # CLIP AI 搜索 - 2155 行 （以源码为准 · 已同步）
│   ├── db_commands.rs      # 数据库命令 - 221 行
│   ├── system_commands.rs  # 系统工具 - 226 行
│   ├── window_commands.rs  # 窗口控制 - 87 行
│   ├── color_commands.rs   # 颜色提取 - 93 行
│   ├── update_commands.rs  # 应用更新 - 51 行
│   └── lan_share_commands.rs # 局域网共享 - 164 行 [新增]
│
├── 📁 功能模块
│   ├── thumbnail.rs        # 缩略图生成 - 479 行
│   ├── color_db.rs         # 颜色数据库 - 1124 行
│   ├── color_extractor.rs  # 颜色提取 - 239 行
│   ├── color_search.rs     # 颜色搜索 - 422 行
│   ├── color_worker.rs     # 后台处理 - 797 行
│   ├── updater.rs          # 更新检查 - 749 行
│   ├── update_downloader.rs # 更新下载 - 499 行
│   └── work_extractor.rs   # 作品提取器 - 199 行 [新增]
│
├── 📁 db/                  # 数据库模块
│   ├── mod.rs              # 入口 - 132 行
│   ├── persons.rs          # 人物 - 118 行
│   ├── topics.rs           # 专题 - 233 行
│   ├── file_metadata.rs    # 元数据 - 214 行
│   └── file_index.rs       # 索引 - 526 行
│
├── 📁 clip/                # CLIP AI 模块
│   ├── mod.rs              # 模块入口 - 206 行
│   ├── model.rs            # 模型封装 - 1099 行
│   ├── embedding.rs        # 嵌入向量 - 397 行
│   ├── preprocessor.rs     # 图像预处理 - 272 行
│   ├── search.rs           # 相似度搜索 - 451 行
│   └── 📁 models/          # 模型实现
│       ├── mod.rs          # 模型规范 - 197 行
│       ├── siglip2_base.rs # SigLIP2-Base - 140 行
│       ├── siglip2.rs      # SigLIP2-So400M - 164 行
│       └── wd14.rs         # WD-EVA02-Large-Tagger-V3 - 68 行
│
├── 📁 lan_share/           # 局域网共享模块 [新增]
│   ├── mod.rs              # 模块入口 - 9 行
│   ├── server.rs           # HTTP 服务器 - 293 行
│   ├── handlers.rs         # 请求处理器 - 903 行
│   ├── session.rs          # 会话管理 - 105 行
│   ├── device_manager.rs   # 设备管理 - 74 行
│   └── types.rs            # 类型定义 - 129 行
│
└── 📁 bin/                 # 工具
    └── dump_persons.rs     # 人物数据导出 - 35 行
```

##### 架构特点
- 基于 Tokio 的异步运行时
- 多线程任务处理（使用 Rayon）
- SQLite 数据库集成
- 事件驱动的进度通知
- 模块化命令处理（已拆分到独立模块）

## 技术实现细节

### 并发模型

#### 生产者-消费者模式
```
颜色提取任务处理:
文件扫描线程 → 任务队列 → 颜色处理工作线程池 → 结果队列 → 主线程更新UI

线程配置:
- 生产者: 1个 (文件扫描)
- 消费者: 4-8个 (颜色提取，由 CPU 核心数决定)
- 队列: 无界通道 (crossbeam-channel)
```

#### 异步操作处理
```rust
// 使用 Tokio 运行时处理异步任务
#[tokio::main]
async fn main() {
    // 异步文件 I/O
    // 数据库操作
    // HTTP 请求 (AI API)
}

// Rayon 并行处理 CPU 密集任务
files.par_iter().for_each(|file| {
    // 并行颜色提取
    // 图像处理
});
```

#### Web Worker 并发
```typescript
// 前端使用 Web Worker 处理计算密集型任务
// - 布局计算 (layout.worker.ts)
// - 搜索过滤 (search.worker.ts)

// Worker 通信协议
interface WorkerMessage {
  type: 'calculate' | 'search' | 'result' | 'error';
  payload: any;
  id: string;
}
```

### 数据存储架构

#### SQLite 数据库设计
```sql
-- 人物表
CREATE TABLE persons (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    cover_file_id TEXT,
    count INTEGER DEFAULT 0,
    description TEXT,
    descriptor BLOB, -- 人脸特征向量
    face_box TEXT,   -- 人脸位置 (JSON)
    character_tag_name TEXT,  -- 关联的角色标签名 [新增]
    character_tag_index INTEGER, -- 角色标签索引 [新增]
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 专题表 [新增]
CREATE TABLE topics (
    id TEXT PRIMARY KEY,
    parent_id TEXT,
    name TEXT NOT NULL,
    description TEXT,
    topic_type TEXT,
    source_type TEXT,  -- 来源类型: 'manual' | 'work' | 'character' [新增]
    work_name TEXT,    -- 作品名称 (英文) [新增]
    work_name_cn TEXT, -- 作品名称 (中文) [新增]
    cover_file_id TEXT,
    background_file_id TEXT,
    cover_crop_x REAL,
    cover_crop_y REAL,
    cover_crop_width REAL,
    cover_crop_height REAL,
    people_ids TEXT,  -- JSON 数组
    file_ids TEXT,    -- JSON 数组
    source_url TEXT,
    created_at INTEGER,
    updated_at INTEGER
);

-- 文件元数据表
CREATE TABLE file_metadata (
    file_id TEXT PRIMARY KEY,      -- 文件哈希 ID
    path TEXT NOT NULL,            -- 文件路径 (用于反推和验证)
    tags TEXT,                     -- 标签数组 (JSON)
    description TEXT,              -- 详细描述
    source_url TEXT,               -- 来源 URL
    ai_data TEXT,                  -- AI 分析全量数据 (JSON)
    updated_at INTEGER             -- 更新时间戳
);
CREATE INDEX idx_file_metadata_path ON file_metadata(path);

-- 文件索引表
CREATE TABLE file_index (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    parent_id TEXT,
    name TEXT NOT NULL,
    file_type TEXT,
    size INTEGER,
    modified_at INTEGER,
    created_at INTEGER,
    is_directory BOOLEAN DEFAULT 0
);
CREATE INDEX idx_file_index_path ON file_index(path);
CREATE INDEX idx_file_index_parent ON file_index(parent_id);

-- 颜色索引表
CREATE TABLE color_index (
    file_path TEXT PRIMARY KEY,
    colors TEXT, -- JSON 数组存储主色调
    histogram TEXT, -- 颜色直方图数据
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

#### 缓存策略
```typescript
// 缩略图缓存
const thumbnailCache = new Map<string, string>();
const THUMBNAIL_CACHE_DIR = `${rootPath}/.Aurora_Cache/thumbnails/`;

// 颜色数据缓存
const colorCache = new Map<string, DominantColor[]>();

// 布局缓存
const layoutCache = new Map<string, LayoutResult>();
// 缓存布局计算结果，避免重复计算
```

### 性能优化策略

#### 前端优化
1. **虚拟滚动**: 处理大量文件显示
2. **防抖**: 搜索和过滤操作
3. **懒加载**: 图片和组件按需加载
4. **内存管理**: 及时清理不用的资源
5. **Web Worker**: 布局计算卸载到 Worker 线程

#### 后端优化
1. **并行处理**: 使用 Rayon 进行 CPU 密集计算
2. **批处理**: 聚合多个小任务减少开销
3. **缓存**: 文件系统和内存双层缓存
4. **异步 I/O**: 非阻塞文件操作
5. **WAL 模式**: SQLite 预写日志提高并发性能

#### 数据库优化
1. **索引**: 为常用查询字段创建索引
2. **连接池**: 复用数据库连接
3. **批量操作**: 减少数据库往返
4. **WAL 模式**: 提高并发性能
5. **文件索引表**: 加速文件路径查询

### 错误处理策略

#### 分层错误处理
```typescript
// 前端错误边界
class ErrorBoundary extends React.Component {
  componentDidCatch(error, errorInfo) {
    // 记录错误，显示友好界面
  }
}

// API 错误处理
try {
  const result = await invoke('some_command', params);
} catch (error) {
  // 处理 Tauri 错误
  console.error('API 调用失败:', error);
}

// Rust 错误处理
#[tauri::command]
fn some_command() -> Result<ReturnType, String> {
    // 使用 ? 操作符传播错误
    let result = some_operation()?;
    Ok(result)
}
```

### 安全性考虑

#### 数据验证
- 前端: TypeScript 类型检查
- 后端: Serde 序列化验证
- 数据库: 参数化查询防止 SQL 注入

#### 权限管理
- Tauri 权限配置 (`capabilities/default.json`)
- 文件系统访问控制
- 网络请求限制

#### 数据隐私
- 本地数据存储 (SQLite)
- 可选的 AI 服务集成
- 用户数据导出功能

## 部署和分发

### 构建流程
```bash
# 前端构建
npm run build

# Rust 构建和打包
cargo tauri build

# 输出: 平台特定的安装包
# - Windows: .msi
# - macOS: .dmg
# - Linux: .AppImage
```

### CI/CD 考虑
- GitHub Actions 多平台构建
- 自动化测试和代码质量检查
- 版本管理和发布流程
- 更新机制 (Tauri Updater)

## 监控和调试

### 性能监控
```typescript
// 前端性能监控
const performanceMonitor = {
  startTiming: (label: string) => { ... },
  endTiming: (label: string) => { ... },
  logMetrics: () => { ... }
};

// 内存使用跟踪
const memoryUsage = performance.memory;
console.log(`内存使用: ${memoryUsage.usedJSHeapSize / 1024 / 1024} MB`);
```

### 日志系统
```typescript
// 结构化日志
const logger = {
  debug: (message: string, meta?: any) => console.log('[DEBUG]', message, meta),
  info: (message: string, meta?: any) => console.info('[INFO]', message, meta),
  warn: (message: string, meta?: any) => console.warn('[WARN]', message, meta),
  error: (message: string, meta?: any) => console.error('[ERROR]', message, meta)
};
```

## 扩展性设计

### 插件架构
- Tauri 插件系统支持
- 自定义 AI 提供商
- 第三方图像处理库

### API 设计
- RESTful 风格的命令命名
- 版本化 API 支持
- 向后兼容性保证

### 配置管理
- 环境变量支持
- 用户偏好存储
- 运行时配置热重载

## 总结

Aurora Gallery Tauri 采用现代化的分层架构，结合 React 前端和 Rust 后端的优势，提供高性能、跨平台的图片管理体验。通过精心设计的并发模型、缓存策略和错误处理机制，实现了流畅的用户体验和可靠的系统稳定性。

**关键技术决策**:
- React + TypeScript 提供类型安全和组件化开发
- Tauri 实现跨平台原生应用开发
- Rust 保证后端性能和内存安全
- SQLite 提供轻量级本地数据存储
- CIEDE2000 算法确保颜色搜索准确性
- Web Worker 实现前端计算卸载
- CLIP 模型支持自然语言搜索和以图搜图
- WD14 标签器支持自动标签生成和角色识别
- HTTP 服务器实现局域网图片共享
- 作品提取器从 WD14 标签自动提取作品/角色信息

**架构亮点**:
- 共享模块设计：主应用与 LAN Share 客户端共用组件和逻辑
- 智能模态框：基于 WD14 角色检测的智能创建人物/专题功能
- 模块化后端：清晰的命令/功能/数据库模块划分

---

**文档版本**: 1.5  
**更新日期**: 2026-03-14  
**维护者**: Aurora Gallery Team
