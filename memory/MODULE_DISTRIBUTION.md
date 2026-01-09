# Aurora Gallery Tauri 模块分布详解

## 前端模块分布 (src/)

### 1. API 桥接层 (`src/api/`)

#### `tauri-bridge.ts` - 核心桥接模块
**位置**: `src/api/tauri-bridge.ts`  
**行数**: ~200 行  
**功能分类**:

**文件系统操作**:
```typescript
// 目录扫描
export async function scanDirectory(path: string, recursive?: boolean): Promise<ScanResult>
export async function scanFile(filePath: string, parentId?: string): Promise<FileNode>

// 文件操作
export async function renameFile(oldPath: string, newPath: string): Promise<void>
export async function deleteFile(path: string): Promise<void>
export async function copyFile(source: string, destination: string): Promise<void>
export async function moveFile(source: string, destination: string): Promise<void>
export async function writeFileFromBytes(path: string, bytes: Uint8Array): Promise<void>

// 目录管理
export async function openDirectory(): Promise<string | null>
export async function ensureDirectory(path: string): Promise<void>
export async function createFolder(path: string): Promise<void>
export async function openPath(path: string, isFile?: boolean): Promise<void>
```

**用户数据管理**:
```typescript
export async function saveUserData(data: any): Promise<boolean>
export async function loadUserData(): Promise<any>
export async function getDefaultPaths(): Promise<{ resourceRoot: string, cacheRoot: string }>
```

**缩略图和图像处理**:
```typescript
export async function getThumbnail(
  filePath: string, 
  updatedAt: string, 
  resourceRoot: string
): Promise<string>
```

**窗口管理**:
```typescript
export async function hideWindow(): Promise<void>
export async function showWindow(): Promise<void>
export async function exitApp(): Promise<void>
```

**色彩提取控制**:
```typescript
export async function pauseColorExtraction(): Promise<void>
export async function resumeColorExtraction(): Promise<void>
```

**辅助功能**:
```typescript
export async function readFileAsBase64(path: string): Promise<string>
```

### 2. 组件库 (`src/components/`)

#### `App.tsx` - 主应用组件
**位置**: `src/App.tsx`  
**行数**: 6000+ 行  
**核心功能**:

**状态管理**:
```typescript
// 应用状态
const [state, setState] = useState<AppState>({...})

// 派生状态
const activeTab = useMemo(() => {...})
const displayFileIds = useMemo(() => {...})
const groupedTags = useMemo(() => {...})
const personCounts = useMemo(() => {...})
```

**核心 Hooks**:
```typescript
// 初始化
useEffect(() => {
  // Tauri 环境检测
  // 用户数据加载
  // 目录扫描
  // 事件监听器设置
}, [])

// 色彩提取进度监听
useEffect(() => {
  // 监听 'color-extraction-progress' 事件
  // 更新任务进度
}, [])

// 窗口关闭处理
useEffect(() => {
  // 监听 CloseRequested 事件
  // 处理退出逻辑
}, [])

// 键盘快捷键
useEffect(() => {
  // Ctrl+Tab: 切换标签
  // Ctrl+W: 关闭标签
  // Ctrl+T: 新标签
  // Ctrl+R: 刷新
  // Delete: 删除选中
}, [dependencies])
```

**主要处理函数**:

**文件操作**:
```typescript
const handleFileClick = (e: React.MouseEvent, id: string) => {...}
const handleMouseDown = (e: React.MouseEvent) => {...}
const handleMouseMove = useCallback(throttle((e: React.MouseEvent) => {...}), 16)
const handleMouseUp = useCallback((e: React.MouseEvent) => {...})
const handleRefresh = async (folderId?: string) => {...}
const handleOpenFolder = async () => {...}
```

**拖拽处理**:
```typescript
const handleExternalDragEnter = (e: React.DragEvent) => {...}
const handleExternalDragOver = (e: React.DragEvent) => {...}
const handleExternalDrop = async (e: React.DragEvent) => {...}
const handleDropOnFolder = async (targetFolderId: string, sourceIds: string[]) => {...}
```

**AI 和人脸识别**:
```typescript
const handleAIAnalysis = async (fileIds: string | string[], folderId?: string) => {...}
const handleFolderAIAnalysis = async (folderId: string) => {...}
const handleManualAddPerson = (personId: string) => {...}
const handleClearPersonInfo = (fileIds: string[], personIdsToClear?: string[]) => {...}
```

**色彩提取**:
```typescript
const onPauseResume = async (id: string, taskType: string) => {...}
const startTask = (type: TaskType, fileIds: string[], title: string, autoProgress?: boolean) => {...}
const updateTask = (id: string, updates: Partial<TaskProgress>) => {...}
```

**导航和历史**:
```typescript
const pushHistory = (folderId: string, viewingId: string | null, ...) => {...}
const goBack = () => {...}
const goForward = () => {...}
const enterFolder = (folderId: string) => {...}
const closeViewer = () => {...}
const enterViewer = (fileId: string) => {...}
```

**搜索**:
```typescript
const performAiSearch = async (query: string) => {...}
const onPerformSearch = async (query: string) => {...}
```

**上下文菜单**:
```typescript
const handleContextMenu = (e: React.MouseEvent, type: string, id: string) => {...}
const closeContextMenu = () => {...}
```

#### `MetadataPanel.tsx` - 元数据面板
**位置**: `src/components/MetadataPanel.tsx`  
**功能**: 显示选中文件的详细信息

**主要 Props**:
```typescript
interface MetadataPanelProps {
  files: Record<string, FileNode>
  selectedFileIds: string[]
  people: Record<string, Person>
  selectedPersonIds: string[]
  onUpdate: (id: string, updates: Partial<FileNode>) => void
  onUpdatePerson: (personId: string, updates: Partial<Person>) => void
  onNavigateToFolder: (folderId: string) => void
  onNavigateToTag: (tagName: string) => void
  onSearch: (query: string) => void
  t: (key: string) => string
  activeTab: TabState
  resourceRoot: string
  cachePath: string
}
```

**显示内容**:
- 文件基本信息（名称、路径、大小、格式）
- 图像元数据（尺寸、色彩、创建时间）
- 用户标签（可编辑）
- AI 分析结果（描述、标签、物体、场景）
- 人脸信息（人物、置信度）
- 色彩提取结果（调色板）

#### `ImageViewer.tsx` - 图片查看器
**位置**: `src/components/ImageViewer.tsx`  
**功能**: 全屏图片查看和操作

**主要功能**:
- 图片缩放（滚轮、按钮）
- 图片平移（拖拽）
- 上一张/下一张导航
- 幻灯片模式
- 旋转、翻转
- 信息面板切换
- 标签编辑
- AI 分析
- 人物管理

#### `FileGrid.tsx` - 文件网格视图
**位置**: `src/components/FileGrid.tsx`  
**功能**: 文件/文件夹的网格展示

**主要功能**:
- 虚拟滚动（性能优化）
- 多选（Ctrl+Click, Shift+Click）
- 拖拽选择（框选）
- 重命名内联编辑
- 右键菜单
- 拖拽上传/移动
- 缩略图生成
- 分组显示

#### `TopicModule.tsx` - 专题模块
**位置**: `src/components/TopicModule.tsx`

**功能（白话说明）**:
- 在「画廊」视图中展示所有专题，双击或点击专题可以进入该专题的详情页，详情页显示专题下的图片和相关人物。
- 支持用户创建、重命名和删除专题；可以为专题选择封面并对封面进行裁剪来调整显示区域。
- 支持多选（Ctrl/Shift）、框选与右键菜单，方便对多个专题执行批量操作（例如删除、设置封面等）。
- 支持子专题（父/子层级）、把文件加入/移出专题，以及在新标签中打开专题进行并行查看。
- 与人物数据库联动，可以查看专题中出现的人物并为专题关联或解除人物。

**主要 Props（白话说明）**:
- `topics`: 专题对象的字典（id -> Topic），包含专题名、文件 id 列表、关联人物 id 等信息
- `files`: 文件对象字典（id -> FileNode），用于显示封面和专题内的图片
- `people`: 人物对象字典（id -> Person），用于在专题详情中显示和关联人物
- `currentTopicId`: 当前打开的专题 id；为 `null` 时显示专题画廊
- `selectedTopicIds`: 当前被选中的专题 id 列表（用于批量操作）
- 回调（在父组件中实现，用于状态变更）:
  - `onNavigateTopic(topicId | null)`: 打开或关闭专题详情
  - `onCreateTopic(parentId | null, name?)`: 在指定父专题下创建新专题
  - `onUpdateTopic(topicId, updates)`: 更新专题信息（如名称、描述、封面等）
  - `onDeleteTopic(topicId)`: 删除指定专题
  - `onSelectTopics(ids)`: 更新选中的专题集合
  - `onSelectFiles(fileIds)`: 更新专题内被选中文件的状态

#### `TreeSidebar.tsx` - 树形侧边栏
**位置**: `src/components/TreeSidebar.tsx`  
**功能**: 文件夹树形导航

**主要功能**:
- 展开/折叠文件夹
- 当前路径高亮
- 右键菜单（创建子文件夹、展开/折叠全部）
- 拖拽目标（文件移动）
- 任务进度显示
- 标签和人物快捷入口

#### `TopBar.tsx` - 顶部工具栏
**位置**: `src/components/TopBar.tsx`  
**功能**: 主要操作工具栏

**包含功能**:
- 导航按钮（返回、前进、向上）
- 搜索框（普通/AI 搜索）
- 视图模式切换（网格/列表）
- 排序选项
- 缩略图大小调节
- 元数据面板开关
- 设置按钮
- 文件夹设置记忆

#### `TabBar.tsx` - 标签页管理
**位置**: `src/components/TabBar.tsx`  
**功能**: 多标签页管理

**主要功能**:
- 标签页切换
- 标签页关闭
- 新标签页
- 右键菜单（关闭其他、关闭全部）
- 拖拽排序（可选）

#### `SettingsModal.tsx` - 设置模态框
**位置**: `src/components/SettingsModal.tsx`  
**功能**: 应用设置管理

**设置分类**:
- **通用设置**: 语言、主题、退出行为
- **AI 设置**: 提供商、API 密钥、模型选择、功能开关
- **路径设置**: 资源根目录、缓存目录
- **性能设置**: 刷新间隔

#### `DragDropOverlay.tsx` - 拖拽覆盖层
**位置**: `src/components/DragDropOverlay.tsx`  
**功能**: 外部文件拖拽提示

**显示内容**:
- 拖拽文件数量
- 操作提示（复制/移动）
- 悬停状态反馈

#### `SplashScreen.tsx` - 启动画面
**位置**: `src/components/SplashScreen.tsx`  
**功能**: 应用启动时的加载画面

**显示内容**:
- Logo 和品牌信息
- 加载状态
- 进度指示器

#### `SequenceViewer.tsx` - 序列查看器
**位置**: `src/components/SequenceViewer.tsx`  
**功能**: 特殊序列文件查看

**用于**: 特定文件夹分类（如时间序列）

#### `CloseConfirmationModal.tsx` - 关闭确认
**位置**: `src/components/CloseConfirmationModal.tsx`  
**功能**: 窗口关闭前确认

**选项**:
- 最小化到托盘
- 立即退出
- 记住选择

#### `Logo.tsx` - Logo 组件
**位置**: `src/components/Logo.tsx`  
**功能**: 品牌 Logo 展示

### 3. 业务服务层 (`src/services/`)

#### `aiService.ts` - AI 服务
**位置**: `src/services/aiService.ts`  
**功能**: 统一的 AI 分析接口

**支持提供商**:
```typescript
type AIProvider = 'openai' | 'ollama' | 'lmstudio'
```

**核心功能**:
```typescript
class AIService {
  // 图像分析
  async analyzeImage(
    imagePath: string, 
    settings: AppSettings, 
    currentPeople: Record<string, Person>
  ): Promise<{ aiData: AiData; faceDescriptors: any[] }>
  
  // 智能搜索
  async performSearch(
    query: string, 
    settings: AppSettings
  ): Promise<AiSearchFilter>
  
  // 生成分析报告
  async generateFolderSummary(
    folderId: string,
    settings: AppSettings
  ): Promise<string>
}
```

**支持的分析类型**:
- 描述生成
- 标签提取
- 物体检测
- 场景分类
- OCR 文字提取
- 翻译
- 人物识别
- 年龄/性别识别
- 表情识别

#### `faceRecognitionService.ts` - 人脸识别服务
**位置**: `src/services/faceRecognitionService.ts`  
**功能**: 基于 face-api.js 的人脸识别

**核心功能**:
```typescript
class FaceRecognitionService {
  // 人脸检测
  async detectFaces(imagePath: string): Promise<FaceDetection[]>
  
  // 人脸识别
  async recognizeFaces(
    imagePath: string, 
    knownPeople: Record<string, Person>
  ): Promise<AiFace[]>
  
  // 人脸特征提取
  async extractDescriptors(imagePath: string): Promise<any[]>
  
  // 人脸匹配
  async matchFaces(
    descriptor1: any, 
    descriptor2: any
  ): Promise<number> // 相似度
}
```

### 4. 工具函数库 (`src/utils/`)

#### `debounce.ts` - 防抖函数
**位置**: `src/utils/debounce.ts`  
**功能**: 函数防抖

```typescript
export function debounce<T extends (...args: any[]) => any>(
  func: T, 
  wait: number
): (...args: Parameters<T>) => void

// 使用示例
const debouncedSearch = debounce((query: string) => {
  // 执行搜索
}, 300)
```

#### `environment.ts` - 环境检测
**位置**: `src/utils/environment.ts`  
**功能**: 检测运行环境

```typescript
// 同步检测
export function isTauriEnvironment(): boolean

// 异步检测
export async function detectTauriEnvironmentAsync(): Promise<boolean>

// 平台检测
export function getPlatform(): string
```

#### `logger.ts` - 日志工具
**位置**: `src/utils/logger.ts`  
**功能**: 统一日志记录

```typescript
export const logger = {
  debug: (...args: any[]) => console.log('[DEBUG]', ...args),
  info: (...args: any[]) => console.info('[INFO]', ...args),
  warn: (...args: any[]) => console.warn('[WARN]', ...args),
  error: (...args: any[]) => console.error('[ERROR]', ...args)
}
```

#### `mockFileSystem.ts` - 模拟文件系统
**位置**: `src/utils/mockFileSystem.ts`  
**功能**: 开发环境下的模拟数据

```typescript
export function initializeFileSystem(): { roots: string[], files: Record<string, FileNode> }
```

#### `performanceMonitor.ts` - 性能监控
**位置**: `src/utils/performanceMonitor.ts`  
**功能**: 性能指标收集

```typescript
class PerformanceMonitor {
  start(label: string, sampleRate?: number): string
  end(timerId: string, label: string, metadata?: any): void
  timing(label: string, duration: number, metadata?: any): void
  increment(counter: string, value: number): void
}
```

#### `translations.ts` - 多语言支持
**位置**: `src/utils/translations.ts`  
**功能**: UI 文本翻译

```typescript
export const translations = {
  zh: {
    common: { ... },
    settings: { ... },
    context: { ... },
    tasks: { ... }
  },
  en: {
    common: { ... },
    settings: { ... },
    context: { ... },
    tasks: { ... }
  }
}
```

## 后端模块分布 (src-tauri/src/)

### 1. 主程序 (`main.rs`)

**位置**: `src-tauri/src/main.rs`  
**行数**: 400+ 行  
**功能**:

**应用初始化**:
```rust
fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_window::init())
        .setup(|app| {
            // 初始化数据库
            // 启动后台工作器
            // 注册命令
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // 文件操作命令
            scan_directory,
            scan_file,
            rename_file,
            delete_file,
            create_folder,
            
            // 数据库命令
            get_pending_files,
            update_status,
            batch_save_colors,
            
            // 色彩提取控制
            pause_color_extraction,
            resume_color_extraction,
            shutdown_color_extraction,
            
            // 窗口管理
            hide_window,
            show_window,
            exit_app,
            
            // 用户数据
            save_user_data,
            load_user_data,
            get_default_paths,
            
            // 其他工具
            get_thumbnail,
            ensure_directory,
            copy_file,
            move_file,
            write_file_from_bytes,
            open_path,
            read_file_as_base64,
            file_exists,
            
            // 数据库工具
            get_wal_info,
            force_wal_checkpoint,
            force_full_checkpoint,
            get_db_file_sizes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

**后台工作器启动**:
```rust
// 在 setup 钩子中启动
let pool_clone = pool.clone();
let app_handle_clone = app.handle().clone();

tokio::spawn(async move {
    color_worker::color_extraction_worker(
        pool_clone,
        50, // batch_size
        Some(Arc::new(app_handle_clone))
    ).await;
});
```

### 2. 色彩数据库 (`color_db.rs`)

**位置**: `src-tauri/src/color_db.rs`  
**行数**: 300+ 行  
**功能**:

**数据库连接池**:
```rust
pub struct ColorDbPool {
    pool: SqlitePool,
}

impl ColorDbPool {
    pub async fn new(db_path: &str) -> Result<Self> {
        // 创建连接池
        // 设置 WAL 模式
        // 创建表和索引
    }
    
    pub fn get_connection(&self) -> SqliteConnection {
        // 获取连接
    }
}
```

**核心操作**:
```rust
// 获取待处理文件
pub fn get_pending_files(conn: &mut SqliteConnection, limit: usize) -> Result<Vec<String>>

// 获取处理中文件数量
pub fn get_processing_files_count(conn: &mut SqliteConnection) -> Result<usize>

// 更新文件状态
pub fn update_status(conn: &mut SqliteConnection, file_path: &str, status: &str) -> Result<()>

// 批量保存色彩
pub fn batch_save_colors(
    conn: &mut SqliteConnection,
    colors: &[(&str, &[color_extractor::ColorResult])]
) -> Result<()>

// 获取待处理文件数量
pub fn get_pending_files_count(conn: &mut SqliteConnection) -> Result<usize>

// WAL 管理
pub fn get_wal_info(&self) -> Result<(u64, u64)>
pub fn force_wal_checkpoint(&self) -> Result<()>
pub fn force_full_checkpoint(&self) -> Result<()>
pub fn get_db_file_sizes(&self) -> Result<(u64, u64)>
```

### 3. 色彩提取算法 (`color_extractor.rs`)

**位置**: `src-tauri/src/color_extractor.rs`  
**行数**: 200+ 行  
**功能**:

**K-means 聚类算法**:
```rust
pub fn get_dominant_colors(img: &DynamicImage, k: usize) -> Vec<ColorResult> {
    // 1. 图像预处理
    // 2. 采样像素
    // 3. K-means 聚类
    // 4. 排序和格式化
}
```

**颜色结果结构**:
```rust
#[derive(Debug, Clone, Serialize)]
pub struct ColorResult {
    pub hex: String,
    pub rgb: (u8, u8, u8),
    pub count: usize,
    pub percentage: f32,
}
```

### 4. 后台工作器 (`color_worker.rs`)

**位置**: `src-tauri/src/color_worker.rs`  
**行数**: 760+ 行  
**功能**:

**生产者-消费者架构**:
```rust
// 生产者：从数据库获取待处理文件
async fn producer_loop(pool: Arc<ColorDbPool>, batch_size: usize, task_sender: Sender<Task>)

// 消费者：处理图片提取色彩
fn consumer_loop(
    pool: Arc<ColorDbPool>,
    task_receiver: Receiver<Task>,
    result_sender: Sender<ProcessingResult>,
    current_file: Arc<Mutex<String>>
)

// 结果处理器：批量保存到数据库
async fn result_processor(
    pool: Arc<ColorDbPool>,
    result_receiver: Receiver<ProcessingResult>,
    app_handle: Option<Arc<AppHandle>>
)
```

**进度报告**:
```rust
#[derive(Debug, Clone, Serialize)]
pub struct ColorExtractionProgress {
    pub batch_id: u64,
    pub current: usize,
    pub total: usize,
    pub pending: usize,
    pub current_file: String,
    pub batch_completed: bool,
}
```

**控制机制**:
```rust
// 全局状态
static IS_PAUSED: AtomicBool
static IS_SHUTTING_DOWN: AtomicBool
static BATCH_ID_COUNTER: AtomicU64

// 控制命令
pub fn pause_color_extraction() -> bool
pub fn resume_color_extraction() -> bool
pub async fn shutdown_color_extraction() -> bool
```

## 数据流向图

### 1. 文件扫描流程
```
用户点击文件夹 → Tauri Bridge → scanDirectory() → Rust main.rs → 文件系统扫描 → 返回 FileNode[] → React State 更新 → UI 重渲染
```

### 2. AI 分析流程
```
用户触发分析 → AIService.analyzeImage() → 读取图片 → 转换 Base64 → 调用 AI API → 解析结果 → 更新 FileNode.aiData → React State 更新 → UI 显示结果
```

### 3. 色彩提取流程
```
文件添加到数据库 → Producer Loop → 获取待处理文件 → 更新状态为 processing → 发送到任务队列 → Consumer Loop → 提取色彩 → 发送到结果队列 → Result Processor → 批量保存 → 发送进度事件 → React 监听 → 更新 UI
```

### 4. 拖拽上传流程
```
外部文件拖入 → handleExternalDragEnter → 显示覆盖层 → handleExternalDrop → 读取文件 → writeFileFromBytes → scanFile → 更新 State → UI 显示新文件
```

## 依赖关系图

### 前端依赖
```
React 18
├── @tauri-apps/api (Tauri IPC)
├── @vladmandic/face-api (人脸识别)
├── lucide-react (图标)
├── md5 (哈希)
├── react-dom (DOM 渲染)
└── 自定义组件和工具
```

### 后端依赖
```
Tauri 2.0
├── tokio (异步运行时)
├── sqlx (SQLite 数据库)
├── image (图像处理)
├── serde (序列化)
├── crossbeam-channel (通道)
└── 自定义模块
```

## 性能关键点

### 1. 文件扫描
- **优化**: 递归扫描 + 防抖
- **瓶颈**: 大量小文件
- **解决方案**: 异步 + 进度报告

### 2. AI 分析
- **优化**: 批量处理 + 并发限制
- **瓶颈**: API 调用延迟
- **解决方案**: 队列 + 重试机制

### 3. 色彩提取
- **优化**: 多线程 + 批量保存
- **瓶颈**: CPU 密集型
- **解决方案**: 工作池 + WAL 优化

### 4. 内存管理
- **优化**: 虚拟滚动 + 懒加载
- **瓶颈**: 大文件列表
- **解决方案**: 分页 + 缓存

---

**文档版本**: 1.0  
**覆盖范围**: 所有核心模块  
**详细程度**: 高