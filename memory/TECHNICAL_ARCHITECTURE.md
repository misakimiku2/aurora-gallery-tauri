# Aurora Gallery Tauri 技术架构文档

## 系统架构概览

### 整体架构图
```
┌─────────────────────────────────────────────────────────────┐
│                    用户界面层 (React)                        │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ App.tsx  │  │组件库    │  │服务层    │  │工具库    │   │
│  │          │  │          │  │          │  │          │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘   │
│       │             │             │             │          │
│       └─────────────┴─────────────┴─────────────┴──────────┘
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
App (根组件)
├── TabBar (标签页管理)
├── TopBar (工具栏)
├── Sidebar (侧边栏)
│   ├── TreeSidebar (文件树)
│   └── TaskProgressModal (任务进度)
├── MainContent (主内容区)
│   ├── FileGrid (文件网格)
│   ├── ImageViewer (图片查看器)
│   └── SequenceViewer (序列查看器)
├── MetadataPanel (元数据面板)
├── Modals (模态框)
│   ├── SettingsModal (设置)
│   ├── DragDropOverlay (拖拽)
│   ├── CloseConfirmationModal (关闭确认)
│   └── WelcomeModal (欢迎界面)
└── Toasts (通知)
```

#### 状态管理策略
```typescript
// 使用 React Hooks 进行状态管理
const [state, setState] = useState<AppState>({
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
  customTags: [],
  tasks: [],
  
  // 设置
  settings: {
    theme: 'system',
    language: 'zh',
    ai: { provider: 'ollama', ... }
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

### 2. 业务逻辑层 (Business Logic Layer)

#### 服务层架构
```typescript
// AI 服务架构
class AIService {
  private provider: AIProvider
  private config: AIConfig
  
  async analyzeImage(imagePath: string, settings: AppSettings): Promise<AiData> {
    // 1. 读取图片并转换为 Base64
    // 2. 根据提供商调用对应 API
    // 3. 解析响应
    // 4. 返回结构化数据
  }
  
  private async callOpenAI(base64: string): Promise<any> { ... }
  private async callOllama(base64: string): Promise<any> { ... }
  private async callLMStudio(base64: string): Promise<any> { ... }
}

// 人脸识别服务架构
class FaceRecognitionService {
  private modelsLoaded: boolean = false
  
  async loadModels(): Promise<void> {
    // 加载 face-api.js 模型
  }
  
  async detectFaces(imagePath: string): Promise<FaceDetection[]> {
    // 1. 加载图片
    // 2. 运行人脸检测模型
    // 3. 返回人脸位置和特征
  }
  
  async recognizeFaces(
    imagePath: string, 
    knownPeople: Record<string, Person>
  ): Promise<AiFace[]> {
    // 1. 提取人脸特征
    // 2. 与已知人物匹配
    // 3. 返回识别结果
  }
}
```

#### 文件处理流程
```typescript
// 文件扫描流程
async function scanDirectory(path: string, recursive: boolean = false): Promise<ScanResult> {
  // 1. 读取目录内容
  // 2. 过滤支持的文件类型
  // 3. 递归处理子目录（如果需要）
  // 4. 构建文件树结构
  // 5. 返回结果
}

// 文件处理管道
File Path → Type Detection → Metadata Extraction → AI Analysis → Color Extraction → Database Storage
```

### 颜色相似度搜索（Color Similarity Search）

- **概述**: 后端的色彩提取模块（Color Extractor / Color Worker）会定期或按需分析图片并将色彩信息写入数据库（`file_colors` 表）。基于这些数据，提供按颜色相似度检索的能力。

- **后端返回格式**: 当触发颜色搜索时，Rust 后端会返回一个字符串数组，内容为匹配图片的绝对路径（示例: `C:\Users\...\photo.jpg` 或 `/home/user/.../photo.jpg`）。这个结果通过 Tauri 命令或事件发送到前端。

- **前端处理逻辑**:
  1. 接收后端返回的路径数组。
  2. 对每个路径进行标准化处理：
     - 移除 Windows 长路径前缀 `\\?\`（若存在）。
     - 将反斜杠 `\\` 替换为正斜杠 `/`。
     - 将字符串转换为小写以减少大小写不一致造成的匹配失败。
  3. 在当前前端索引 `state.files` 中查找匹配项（通过 `file.path` 字段，使用相同的标准化函数进行比较）。
  4. 将匹配到的路径收集为 `validPaths`，并把它们放入 `AiSearchFilter.filePaths`（或等效内部过滤器）中以驱动视图显示。

- **交互与 UX**:
  - 颜色搜索不会把 `color:#xxxxxx` 文本留在搜索框中（目前实现将搜索文本清空，但把查询信息放入 `aiFilter.originalQuery`）。
  - 如果后端返回的路径全部无法在前端索引中匹配，前端会弹出提示（Toast），提示后台找到 N 张但前端无法显示，提醒用户可能需要重新扫描或生成色彩数据。

- **注意与限制**:
  - 成功匹配依赖于前端索引中 `file.path` 的完整性与一致性（例如文件被移动或以不同方式导入后路径可能不一致）。
  - 在 Windows 系统上，路径可能含有前缀或不同的大小写，故前端做了归一化；若仍无法匹配，可考虑在导入/扫描阶段统一规范路径或在后端返回相对/ID 映射（更稳妥）。

---

### 3. 数据访问层 (Data Access Layer)

#### Tauri Bridge 模式
```typescript
// 桥接层设计模式
export class TauriBridge {
  // 文件系统操作
  static async scanDirectory(path: string): Promise<ScanResult> {
    return await invoke('scan_directory', { path, recursive: false })
  }
  
  // 数据库操作
  static async getPendingFiles(limit: number): Promise<string[]> {
    return await invoke('get_pending_files', { limit })
  }
  
  // 进度监听
  static async listenProgress(callback: (progress: any) => void): Promise<void> {
    const unlisten = await listen('color-extraction-progress', (event) => {
      callback(event.payload)
    })
    return unlisten
  }
}
```

#### Rust 后端架构
```rust
// 主程序入口
#[tauri::command]
async fn scan_directory(path: String, recursive: bool) -> Result<ScanResult, String> {
    // 1. 验证路径
    // 2. 读取目录
    // 3. 构建文件树
    // 4. 返回结果
}

// 数据库连接池
pub struct ColorDbPool {
    pool: SqlitePool,
}

impl ColorDbPool {
    pub async fn new(db_path: &str) -> Result<Self> {
        let options = SqliteConnectOptions::new()
            .filename(db_path)
            .journal_mode(SqliteJournalMode::Wal)  // WAL 模式
            .create_if_missing(true);
        
        let pool = SqlitePool::connect_with(options).await?;
        
        // 初始化表
        pool.execute(include_str!("schema.sql")).await?;
        
        Ok(Self { pool })
    }
}
```

### 4. 数据持久化层 (Data Persistence Layer)

#### 数据库设计
```sql
-- 主表：文件色彩信息
CREATE TABLE file_colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    colors TEXT NOT NULL,  -- JSON 格式存储
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 索引优化
CREATE INDEX idx_status ON file_colors(status);
CREATE INDEX idx_path ON file_colors(file_path);

-- WAL 模式配置
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA wal_autocheckpoint = 1000;
```

#### 数据访问模式
```rust
// Repository 模式
pub struct ColorRepository {
    pool: Arc<ColorDbPool>,
}

impl ColorRepository {
    pub async fn save_colors(
        &self,
        file_path: &str,
        colors: &[ColorResult]
    ) -> Result<()> {
        let json_colors = serde_json::to_string(colors)?;
        // 执行插入或更新
    }
    
    pub async fn batch_save_colors(
        &self,
        data: &[(&str, &[ColorResult])]
    ) -> Result<usize> {
        // 批量插入优化
    }
}
```

## 并发和异步模型

### 1. 前端异步模式
```typescript
// React + Tauri 异步模式
const handleAsyncOperation = async () => {
  try {
    // 显示加载状态
    setIsLoading(true)
    
    // 执行异步操作
    const result = await someAsyncOperation()
    
    // 更新状态
    setState(result)
    
  } catch (error) {
    // 错误处理
    showError(error)
  } finally {
    // 隐藏加载状态
    setIsLoading(false)
  }
}

// 防抖和节流
const debouncedSearch = debounce((query: string) => {
  performSearch(query)
}, 300)

const throttledScroll = throttle((scrollTop: number) => {
  updateScrollPosition(scrollTop)
}, 16)
```

### 2. 后端并发模型
```rust
// Tokio 多任务架构
pub async fn color_extraction_worker(
    pool: Arc<ColorDbPool>,
    batch_size: usize,
    app_handle: Option<Arc<AppHandle>>
) {
    // 1. 生产者任务（单个）
    let producer_handle = task::spawn(producer_loop(...));
    
    // 2. 消费者任务（多个）
    let mut consumer_handles = Vec::new();
    for _ in 0..num_workers {
        let handle = task::spawn_blocking(consumer_loop(...));
        consumer_handles.push(handle);
    }
    
    // 3. 结果处理任务（单个）
    let result_handle = task::spawn(result_processor(...));
    
    // 等待所有任务完成
    join_all([producer_handle, result_handle, ...consumer_handles]).await;
}

// 通道模式（生产者-消费者）
let (task_sender, task_receiver) = unbounded();
let (result_sender, result_receiver) = unbounded();

// 生产者发送任务
task_sender.send((batch_id, file_path)).unwrap();

// 消费者接收任务
match task_receiver.recv_timeout(Duration::from_millis(50)) {
    Ok(task) => process_task(task),
    Err(_) => continue,
}
```

## 性能优化策略

### 1. 内存优化
```typescript
// 虚拟滚动（大列表）
import { FixedSizeList } from 'react-window'

const FileList = ({ files }) => (
  <FixedSizeList
    height={600}
    itemCount={files.length}
    itemSize={80}
  >
    {({ index, style }) => (
      <div style={style}>
        <FileItem file={files[index]} />
      </div>
    )}
  </FixedSizeList>
)

// 懒加载图片
const LazyImage = ({ src }) => {
  const [isVisible, setIsVisible] = useState(false)
  const ref = useRef()
  
  useEffect(() => {
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setIsVisible(true)
        observer.disconnect()
      }
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [])
  
  return <img ref={ref} src={isVisible ? src : ''} />
}
```

### 2. 数据库优化
```rust
// 批量操作
pub fn batch_save_colors(
    conn: &mut SqliteConnection,
    colors: &[(&str, &[ColorResult])]
) -> Result<()> {
    // 使用事务
    let tx = conn.begin()?;
    
    for (path, color_list) in colors {
        let json = serde_json::to_string(color_list)?;
        sqlx::query(
            "INSERT OR REPLACE INTO file_colors (file_path, colors, status, updated_at) 
             VALUES (?, ?, 'completed', CURRENT_TIMESTAMP)"
        )
        .bind(path)
        .bind(&json)
        .execute(&mut *tx)
        .await?;
    }
    
    tx.commit().await?;
    Ok(())
}

// WAL 优化
pub fn force_wal_checkpoint(&self) -> Result<()> {
    // 执行 WAL CHECKPOINT
    sqlx::query("PRAGMA wal_checkpoint(TRUNCATE)")
        .execute(&self.pool)
        .await?;
    Ok(())
}
```

### 3. 网络优化
```typescript
// 并发控制
const asyncPool = async <T>(
  limit: number,
  items: T[],
  fn: (item: T) => Promise<void>
) => {
  const executing: Promise<void>[] = []
  
  for (const item of items) {
    const p = fn(item).then(() => {
      executing.splice(executing.indexOf(p), 1)
    })
    executing.push(p)
    
    if (executing.length >= limit) {
      await Promise.race(executing)
    }
  }
  
  await Promise.all(executing)
}

// 请求重试
const withRetry = async <T>(
  fn: () => Promise<T>,
  maxRetries: number = 3,
  delay: number = 1000
): Promise<T> => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn()
    } catch (error) {
      if (i === maxRetries - 1) throw error
      await new Promise(resolve => setTimeout(resolve, delay * (i + 1)))
    }
  }
  throw new Error('Unreachable')
}
```

## 错误处理和容错

### 1. 前端错误处理
```typescript
// 全局错误边界
class ErrorBoundary extends React.Component {
  state = { hasError: false, error: null }
  
  static getDerivedStateFromError(error: any) {
    return { hasError: true, error }
  }
  
  render() {
    if (this.state.hasError) {
      return <ErrorFallback error={this.state.error} />
    }
    return this.props.children
  }
}

// 异步错误包装
const safeAsync = async <T>(promise: Promise<T>): Promise<[T | null, any]> => {
  try {
    const result = await promise
    return [result, null]
  } catch (error) {
    return [null, error]
  }
}

// 使用示例
const [data, error] = await safeAsync(fetchData())
if (error) {
  logger.error('操作失败', error)
  showNotification('操作失败，请重试')
}
```

### 2. 后端错误处理
```rust
// 自定义错误类型
#[derive(Debug)]
pub enum AppError {
    DatabaseError(sqlx::Error),
    IoError(std::io::Error),
    ImageError(image::ImageError),
    SerializeError(serde_json::Error),
    NotFound(String),
    InvalidInput(String),
}

impl From<sqlx::Error> for AppError {
    fn from(err: sqlx::Error) -> Self {
        AppError::DatabaseError(err)
    }
}

// 错误处理模式
pub async fn process_file(path: &str) -> Result<ColorResult, AppError> {
    // 验证输入
    if !std::path::Path::new(path).exists() {
        return Err(AppError::NotFound(path.to_string()));
    }
    
    // 处理文件
    let colors = extract_colors(path)
        .map_err(|e| AppError::ImageError(e))?;
    
    // 保存结果
    save_to_db(path, &colors)
        .map_err(|e| AppError::DatabaseError(e))?;
    
    Ok(colors)
}

// 错误传播和日志
match process_file(file_path).await {
    Ok(colors) => {
        info!("成功处理文件: {}", file_path);
        result_sender.send(Ok((batch_id, file_path, colors))).unwrap();
    }
    Err(e) => {
        error!("处理文件失败 {}: {}", file_path, e);
        result_sender.send(Err((batch_id, format!("{}", e)))).unwrap();
    }
}
```

## 安全架构

### 1. 输入验证
```typescript
// 路径验证
const isValidPath = (path: string): boolean => {
  // 防止路径遍历攻击
  const normalized = path.replace(/\\/g, '/')
  return !normalized.includes('..') && 
         normalized.startsWith('/') &&
         !normalized.includes('//')
}

// 文件类型验证
const ALLOWED_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp']
const isValidFileType = (filename: string): boolean => {
  const ext = filename.toLowerCase().split('.').pop()
  return ALLOWED_EXTENSIONS.includes(`.${ext}`)
}
```

### 2. 权限控制
```rust
// Tauri 权限配置
// tauri.conf.json
{
  "tauri": {
    "allowlist": {
      "fs": {
        "scope": ["$RESOURCE/**", "$APPDATA/**"],
        "all": false
      },
      "dialog": {
        "open": true,
        "save": true
      },
      "window": {
        "close": true,
        "hide": true,
        "show": true
      }
    }
  }
}
```

### 3. 数据安全
```typescript
// 敏感数据处理
const sanitizePath = (path: string): string => {
  return path.replace(/[<>:"|?*]/g, '')
}

// API 密钥管理
const secureStorage = {
  async set(key: string, value: string): Promise<void> {
    // 使用 Tauri 的安全存储
    await invoke('secure_store', { key, value })
  },
  
  async get(key: string): Promise<string | null> {
    return await invoke('secure_retrieve', { key })
  }
}
```

## 监控和调试

### 1. 性能监控
```typescript
// 前端性能监控
const performanceMonitor = {
  metrics: new Map<string, number[]>(),
  
  start(label: string): string {
    const id = Math.random().toString(36)
    this.metrics.set(id, [performance.now()])
    return id
  },
  
  end(id: string, label: string): void {
    const start = this.metrics.get(id)?.[0]
    if (start) {
      const duration = performance.now() - start
      console.log(`[PERF] ${label}: ${duration.toFixed(2)}ms`)
      this.metrics.delete(id)
    }
  }
}

// 使用示例
const timerId = performanceMonitor.start('file_scan')
await scanDirectory(path)
performanceMonitor.end(timerId, 'file_scan')
```

### 2. 日志系统
```rust
// Rust 日志配置
use tracing::{info, warn, error, debug};
use tracing_subscriber::{layer::SubscriberExt, Registry, fmt, EnvFilter};

fn init_logging() {
    let fmt_layer = fmt::layer().with_thread_ids(true).with_target(true);
    let filter_layer = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("info"));
    
    let subscriber = Registry::default()
        .with(filter_layer)
        .with(fmt_layer);
    
    tracing::subscriber::set_global_default(subscriber)
        .expect("Failed to set subscriber");
}

// 使用日志
info!("Processing batch {}", batch_id);
debug!("File: {}, Colors: {:?}", file_path, colors);
warn!("Failed to process {}: {}", file_path, error);
error!("Database error: {}", e);
```

### 3. 错误报告
```typescript
// 错误上报
const reportError = (error: Error, context: any = {}) => {
  const errorReport = {
    timestamp: new Date().toISOString(),
    message: error.message,
    stack: error.stack,
    context: {
      ...context,
      userAgent: navigator.userAgent,
      platform: getPlatform(),
      version: APP_VERSION
    }
  }
  
  // 发送到日志服务（可选）
  if (isProduction) {
    fetch('/api/errors', {
      method: 'POST',
      body: JSON.stringify(errorReport)
    })
  }
  
  console.error('Error Report:', errorReport)
}
```

## 扩展性设计

### 1. 插件系统
```typescript
// 插件接口
interface Plugin {
  name: string
  version: string
  initialize(app: App): void
  onFileAdded?(file: FileNode): void
  onFileAnalyzed?(file: FileNode, aiData: AiData): void
  onColorExtracted?(file: FileNode, colors: string[]): void
}

// 插件注册
class PluginManager {
  private plugins: Plugin[] = []
  
  register(plugin: Plugin): void {
    plugin.initialize(this.app)
    this.plugins.push(plugin)
  }
  
  async onFileAdded(file: FileNode): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onFileAdded) {
        await plugin.onFileAdded(file)
      }
    }
  }
}
```

### 2. 服务提供者模式
```typescript
// 可扩展的服务提供者
class ServiceProvider {
  private services: Map<string, any> = new Map()
  
  register<T>(name: string, service: T): void {
    this.services.set(name, service)
  }
  
  get<T>(name: string): T {
    const service = this.services.get(name)
    if (!service) {
      throw new Error(`Service ${name} not found`)
    }
    return service as T
  }
}

// 使用
const provider = new ServiceProvider()
provider.register('ai', new AIService())
provider.register('face', new FaceRecognitionService())

const aiService = provider.get<AIService>('ai')
```

---

**架构版本**: 1.0  
**设计模式**: 分层架构 + 事件驱动 + 生产者-消费者  
**并发模型**: 异步 + 多线程  
**性能目标**: 10,000+ 文件管理，秒级响应