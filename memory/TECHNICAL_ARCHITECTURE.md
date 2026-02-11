# Aurora Gallery Tauri 技术架构文档

## 系统架构概览

### 整体架构图
```
┌─────────────────────────────────────────────────────────────┐
│                    用户界面层 (React)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │   │  │组件库    │  │服务层    │  │工具库    │   │
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
│       └─────────────┴─────────────┴─────────────┴──────────┘
│                              │                              │
│                    SQLite 数据库                             │
│                    文件系统                                   │
│                    AI API (OpenAI/Ollama/LM Studio)         │
└─────────────────────────────────────────────────────────────┘
```

## 分层架构设计

### 1. 表现层 (Presentation Layer)

#### React 组件架构
```typescript
// 组件层次结构
App (根组件 - 4248 行) （以源码为准 · 已同步）
├── TabBar (标签页管理 - 249 行)
├── TopBar (工具栏 - 921 行)
├── Sidebar (侧边栏)
│   ├── TreeSidebar (文件树 - 654 行)
│   └── TaskProgressModal (任务进度 - 200 行)
├── MainContent (主内容区)
│   ├── PersonGrid (人物网格 - 224 行) （以源码为准 · 已同步）
│   ├── FileGrid (文件网格 - 1457 行) （以源码为准 · 已同步）
│   ├── ImageViewer (图片查看器 - 1542 行)
│   ├── ImageComparer (图片对比 - 2600+ 行)
│   ├── TopicModule (专题模块 - 2618 行)
│   └── TagsList (标签列表 - 470 行)
├── MetadataPanel (元数据面板 - 2607 行)
├── SettingsModal (设置模态框 - 1347 行) （以源码为准 · 已同步）
├── Modals (模态框集合 - src/components/modals/) [重构]
│   ├── FolderPickerModal (文件夹选择)
│   ├── BatchRenameModal (批量重命名)
│   ├── AIBatchRenameModal (AI 批量重命名 - 387 行) [新增]
│   ├── AddImageModal (添加图片 - 1262 行) [新增]
│   ├── WelcomeModal (欢迎向导)
│   ├── CreateTopicModal (创建专题)
│   ├── RenameTopicModal (重命名专题)
│   └── [其他 10+ 模态框...]
├── AIRenameButton (AI 重命名按钮 - 38 行) [新增]
├── AIRenamePreview (AI 重命名预览 - 40 行) [新增]
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
**行数**: 99 行（以源码为准 · 已同步）  
**功能**: OpenAI/Ollama/LM Studio 集成

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

**支持的 AI 提供商**:
- OpenAI (GPT-4, GPT-3.5)
- Ollama (本地 LLM)
- LM Studio (本地模型管理)

##### 人脸识别服务 (faceRecognitionService.ts)
**位置**: `src/services/faceRecognitionService.ts`  
**行数**: 86 行（以源码为准 · 已同步）  
**功能**: 基于 face-api.js 的人脸识别

### 3. 数据访问层 (Data Access Layer)

#### Tauri Bridge API
**位置**: `src/api/tauri-bridge.ts`  
**行数**: 1208 行（以源码为准 · 已同步）  
**功能**: 前后端通信桥接

**核心功能**:
```typescript
// 文件系统操作
export const scanDirectory = async (path: string, forceRefresh?: boolean): Promise<{ roots: string[]; files: Record<string, FileNode> }> => { ... }
export const forceRescan = async (path: string): Promise<{ roots: string[]; files: Record<string, FileNode> }> => { ... }
export const scanFile = async (filePath: string, parentId?: string | null): Promise<FileNode> => { ... }

// 文件操作
export const copyImageToClipboard = async (filePath: string): Promise<void> => { ... }  // [新增]

// 窗口管理
export const setWindowMinSize = async (width: number, height: number): Promise<void> => { ... }  // [新增]
export const isWindowMaximized = async (): Promise<boolean> => { ... }  // [新增]

// 缩略图
export const getThumbnail = async (filePath: string, modified?: string, rootPath?: string, signal?: AbortSignal, onColors?: (colors: DominantColor[] | null) => void): Promise<string | null> => { ... }
export const generateDragPreview = async (thumbnailPaths: string[], totalCount: number, cacheRoot: string): Promise<string | null> => { ... }
getAssetUrl(filePath: string): string

// 颜色相关
export const getDominantColors = async (filePath: string, count?: number, thumbnailPath?: string): Promise<DominantColor[]> => { ... }
export const searchByColor = async (color: string): Promise<string[]> => { ... }
export const searchByPalette = async (palette: string[]): Promise<string[]> => { ... }

// 数据库操作
export const dbGetAllPeople = async (): Promise<Person[]> => { ... }
export const dbUpsertPerson = async (person: Person): Promise<void> => { ... }
export const dbCopyFileMetadata = async (srcPath: string, destPath: string): Promise<void> => { ... }
export const switchRootDatabase = async (newRootPath: string): Promise<void> => { ... }
export const addPendingFilesToDb = async (filePaths: string[]): Promise<number> => { ... }

// 专题数据库操作 [新增]
export const dbGetAllTopics = async (): Promise<Topic[]> => { ... }
export const dbUpsertTopic = async (topic: Topic): Promise<void> => { ... }
export const dbDeleteTopic = async (id: string): Promise<void> => { ... }
```

### 4. 基础设施层 (Infrastructure Layer)

#### Rust 后端架构
**位置**: `src-tauri/src/`  
**总行数**: ~6700 行

##### 主程序 (main.rs)
**行数**: 2440 行（以源码为准 · 已同步）  
**功能**: Tauri 应用入口，命令处理器

**架构特点**:
- 基于 Tokio 的异步运行时
- 多线程任务处理（使用 Rayon）
- SQLite 数据库集成
- 事件驱动的进度通知
- 缩略图生成（支持 JXL、AVIF 格式）
- 专题数据库支持 [新增]

##### 颜色处理模块
- **color_db.rs** (871 行): 颜色数据存储和管理 （以源码为准 · 已同步）
- **color_extractor.rs** (258 行): 颜色提取算法
- **color_search.rs** (796 行): 颜色搜索算法
- **color_worker.rs** (796 行): 后台颜色处理工作器 （以源码为准 · 已同步）

##### 缩略图模块
- **thumbnail.rs** (529 行): 缩略图生成和管理
  - 单文件/批量缩略图生成
  - JXL 格式支持（使用 jxl-oxide）
  - AVIF 格式降级处理
  - 拖拽预览生成
  - 智能格式选择（JPEG/WebP）

##### 数据库模块
- **db/mod.rs** (150 行): 数据库模块入口
- **db/persons.rs** (118 行): 人物数据 CRUD 操作
- **db/topics.rs** (175 行): 专题数据 CRUD 操作 [新增]
- **db/file_metadata.rs** (87 行): 文件元数据存储
- **db/file_index.rs** (200 行): 文件索引数据库
- **集成**: Rusqlite 0.30，带 JSON 支持

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
- AI 智能重命名提升用户体验 [新增]
- 专题管理系统支持图片分类组织 [新增]

**架构优势**:
- 性能优异: Rust 后端 + 并行处理 + Web Worker
- 用户体验佳: 响应式设计 + 流畅交互 + 导航历史 + AI 智能重命名
- 开发效率高: 现代化工具链 + 热重载
- 维护性好: 分层架构 + 类型安全
- 扩展性强: 插件化设计 + 模块化组件

---

**文档版本**: 1.2  
**更新日期**: 2026-02-11  
**维护者**: Aurora Gallery Team
