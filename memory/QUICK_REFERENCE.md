# Aurora Gallery Tauri 快速参考指南

## 快速开始

### 环境要求
node --version
# Rust 1.70+
rustc --version

# Tauri CLI
cargo install tauri-cli
```
```bash
# 1. 安装依赖

# 2. 开发模式运行
npm run dev

npm run build

# 4. 清理缓存
npm run clean
```

## 核心概念

### 1. 文件状态流转
```
pending → processing → completed
     ↓         ↓           ↓
   error ← processing ← error
```

### 2. 数据流
```
用户操作 → React组件 → Tauri Bridge → Rust后端 → SQLite
     ↑           ↓            ↓            ↓         ↓
   UI更新 ←  状态更新 ←   进度事件 ←   处理结果 ←  查询/更新
```

### 3. 并发模型
```
单个生产者 → 任务队列 → 多个消费者 → 结果队列 → 单个结果处理器
   (1个)       (无界)      (4-8个)      (无界)        (1个)
```

## 常用命令速查

### 前端开发
```bash
# 开发服务器
npm run dev

# 类型检查
npm run type-check

# 代码格式化
npm run format

# 构建
npm run build
```

### 后端开发
```bash
# Rust 开发
cargo build
cargo run

# 检查 Rust 代码
cargo check

# 格式化 Rust 代码
cargo fmt

# 运行测试
cargo test
```

### Tauri 相关
```bash
# 开发模式
cargo tauri dev

# 构建
cargo tauri build

# 信息
cargo tauri info
```

## 核心 API 参考

### 前端 API (src/api/tauri-bridge.ts)

#### 文件系统
```typescript
// 扫描目录
await scanDirectory(path: string, recursive?: boolean): Promise<ScanResult>

// 扫描单个文件
await scanFile(filePath: string, parentId?: string): Promise<FileNode>

// 文件操作
await renameFile(oldPath: string, newPath: string): Promise<void>
await deleteFile(path: string): Promise<void>
await copyFile(source: string, destination: string): Promise<void>
await moveFile(source: string, destination: string): Promise<void>

// 目录管理
await openDirectory(): Promise<string | null>
await createFolder(path: string): Promise<void>
await ensureDirectory(path: string): Promise<void>
```

#### 用户数据
```typescript
// 数据持久化
await saveUserData(data: any): Promise<boolean>
await loadUserData(): Promise<any>
await getDefaultPaths(): Promise<{ resourceRoot: string, cacheRoot: string }>
```

#### 窗口管理
```typescript
await hideWindow(): Promise<void>
await showWindow(): Promise<void>
await exitApp(): Promise<void>
```

#### 色彩提取控制
```typescript
await pauseColorExtraction(): Promise<void>
await resumeColorExtraction(): Promise<void>
```

### 后端 API (Rust Commands)

#### 文件操作
```rust
#[tauri::command]
async fn scan_directory(path: String, recursive: bool) -> Result<ScanResult, String>

#[tauri::command]
async fn scan_file(file_path: String, parent_id: Option<String>) -> Result<FileNode, String>

#[tauri::command]
async fn rename_file(old_path: String, new_path: String) -> Result<(), String>

#[tauri::command]
async fn delete_file(path: String) -> Result<(), String>
```

#### 数据库操作
```rust
#[tauri::command]
async fn get_pending_files(limit: usize) -> Result<Vec<String>, String>

#[tauri::command]
async fn update_status(file_path: String, status: String) -> Result<(), String>

#[tauri::command]
async fn batch_save_colors(colors: Vec<(String, Vec<ColorResult>)>) -> Result<(), String>
```

#### 色彩提取控制
```rust
#[tauri::command]
fn pause_color_extraction() -> bool

#[tauri::command]
fn resume_color_extraction() -> bool

#[tauri::command]
async fn shutdown_color_extraction() -> bool
```

## 数据结构速查

### 核心类型

#### FileNode
```typescript
interface FileNode {
  id: string
  parentId: string | null
  name: string
  type: FileType  // 'file' | 'folder' | 'image' | 'video' | 'audio'
  children?: string[]

## 颜色选择器（Color Picker）

- **功能简介**: 应用中新增 `ColorPickerPopover` 组件，用于在 UI 内快速选择颜色、输入十六进制或 RGB 值，并支持系统拾色器（Eyedropper API，若浏览器支持）。

- **使用示例**:
  - 打开颜色选择器（通常位于工具栏或筛选面板），选择或输入颜色。
  - 点击确认后将得到 `#RRGGBB` 格式的颜色字符串；可将其传递给搜索接口 `searchByColor('#RRGGBB')` 来执行颜色相似度搜索。

- **快捷与 UX**:
  - 支持预设颜色快速选择。
  - 当浏览器支持时可使用 Eyedropper 直接从屏幕取色。
  - 输入框自动校验十六进制格式，RGB 数值可精确调整。
  tags: string[]
  description?: string
  sourceUrl?: string
  author?: string
  category?: string
  meta?: FileMeta
  aiData?: AiData
  createdAt: string
  updatedAt: string
}
```

#### AiData
```typescript
interface AiData {
  analyzed: boolean
  analyzedAt: string
  description?: string
  tags?: string[]
  faces?: AiFace[]
  sceneCategory?: string
  confidence?: number
  dominantColors?: string[]
  objects?: string[]
  extractedText?: string
  translatedText?: string
}
```

#### Person
```typescript
interface Person {
  id: string
  name: string
  coverFileId: string
  count: number
  description?: string
  descriptor?: any  // 人脸特征向量（序列化）
  faceBox?: { x: number, y: number, w: number, h: number }
  updatedAt?: string
}
```

### 后端 API（新增：人物数据库）
```rust
#[tauri::command]
fn db_get_all_people() -> Result<Vec<db::persons::Person>, String>

#[tauri::command]
fn db_upsert_person(person: db::persons::Person) -> Result<(), String>

#[tauri::command]
fn db_delete_person(id: String) -> Result<(), String>

#[tauri::command]
fn db_update_person_avatar(person_id: String, cover_file_id: String, face_box: Option<db::persons::FaceBox>) -> Result<(), String>
```
  faceBox?: { x: number; y: number; w: number; h: number }
}
```

#### AppSettings
```typescript
interface AppSettings {
  theme: 'light' | 'dark' | 'system'
  language: 'zh' | 'en'
  autoStart: boolean
  exitAction: 'ask' | 'minimize' | 'exit'
  paths: {
    resourceRoot: string
    cacheRoot: string
  }
  search: {
    isAISearchEnabled: boolean
  }
  ai: {
    provider: 'openai' | 'ollama' | 'lmstudio'
    openai: { apiKey: string; endpoint: string; model: string }
    ollama: { endpoint: string; model: string }
    lmstudio: { endpoint: string; model: string }
    autoTag: boolean
    autoDescription: boolean
    enhancePersonDescription: boolean
    enableFaceRecognition: boolean
    autoAddPeople: boolean
    enableOCR: boolean
    enableTranslation: boolean
    targetLanguage: string
    confidenceThreshold: number
  }
}
```

## React Hooks 参考

### 状态管理
```typescript
// 基础状态
const [state, setState] = useState<AppState>(initialState)

// 派生状态
const activeTab = useMemo(() => {
  return state.tabs.find(t => t.id === state.activeTabId)
}, [state.tabs, state.activeTabId])

// 异步操作
const [loading, setLoading] = useState(false)
const [error, setError] = useState(null)

const handleAsync = async () => {
  setLoading(true)
  try {
    const result = await someAsyncOperation()
    setState(result)
  } catch (err) {
    setError(err)
  } finally {
    setLoading(false)
  }
}
```

### 副作用
```typescript
// 初始化
useEffect(() => {
  initializeApp()
}, [])

// 事件监听
useEffect(() => {
  const unlisten = listen('event-name', (event) => {
    handleEvent(event.payload)
  })
  return () => unlisten()
}, [])

// 性能优化
const debouncedSearch = useCallback(
  debounce((query: string) => {
    performSearch(query)
  }, 300),
  []
)
```

## 常见场景代码示例

### 1. 文件扫描和显示
```typescript
const loadFolder = async (folderId: string) => {
  const folder = state.files[folderId]
  if (!folder?.path) return
  
  const result = await scanDirectory(folder.path, false)
  
  setState(prev => ({
    ...prev,
    files: { ...prev.files, ...result.files },
    expandedFolderIds: [...new Set([...prev.expandedFolderIds, folderId])]
  }))
}
```

### 2. AI 分析流程
```typescript
const analyzeFile = async (fileId: string) => {
  const file = state.files[fileId]
  if (!file || file.type !== FileType.IMAGE) return
  
  // 1. 读取图片
  const base64 = await readFileAsBase64(file.path)
  
  // 2. 调用 AI 服务
  const aiService = new AIService()
  const aiData = await aiService.analyzeImage(file.path, state.settings)
  
  // 3. 更新文件
  handleUpdateFile(fileId, { aiData })
}
```

### 3. 色彩提取监控
```typescript
useEffect(() => {
  let unlisten: (() => void) | undefined
  
  const setupListener = async () => {
    unlisten = await listen('color-extraction-progress', (event: any) => {
      const progress = event.payload as ColorExtractionProgress
      
      // 更新任务进度
      updateTask(progress.batch_id, {
        current: progress.current,
        total: progress.total,
        currentFile: progress.current_file,
        status: progress.batch_completed ? 'completed' : 'running'
      })
      
      // 批次完成处理
      if (progress.batch_completed) {
        setTimeout(() => {
          setState(prev => ({
            ...prev,
            tasks: prev.tasks.filter(t => t.id !== `color-${progress.batch_id}`)
          }))
        }, 1000)
      }
    })
  }
  
  setupListener()
  
  return () => {
    if (unlisten) unlisten()
  }
}, [])
```

### 4. 拖拽上传
```typescript
const handleDrop = async (e: React.DragEvent) => {
  e.preventDefault()
  
  const files = Array.from(e.dataTransfer.files)
  const targetFolder = state.files[activeTab.folderId]
  
  if (!targetFolder?.path) return
  
  for (const file of files) {
    // 1. 读取文件
    const arrayBuffer = await file.arrayBuffer()
    const bytes = new Uint8Array(arrayBuffer)
    
    // 2. 写入目标目录
    const destPath = `${targetFolder.path}/${file.name}`
    await writeFileFromBytes(destPath, bytes)
    
    // 3. 扫描新文件
    const scannedFile = await scanFile(destPath, activeTab.folderId)
    
    // 4. 更新状态
    setState(prev => ({
      ...prev,
      files: { ...prev.files, [scannedFile.id]: scannedFile }
    }))
  }
}
```

### 5. 多选操作
```typescript
const handleFileClick = (e: React.MouseEvent, id: string) => {
  const isCtrl = e.ctrlKey || e.metaKey
  const isShift = e.shiftKey
  
  if (isCtrl) {
    // Ctrl+Click: 切换选择
    setState(prev => ({
      ...prev,
      selectedFileIds: prev.selectedFileIds.includes(id)
        ? prev.selectedFileIds.filter(fid => fid !== id)
        : [...prev.selectedFileIds, id]
    }))
  } else if (isShift) {
    // Shift+Click: 范围选择
    const allIds = displayFileIds
    const lastIndex = allIds.indexOf(state.lastSelectedId || id)
    const currentIndex = allIds.indexOf(id)
    const start = Math.min(lastIndex, currentIndex)
    const end = Math.max(lastIndex, currentIndex)
    const rangeIds = allIds.slice(start, end + 1)
    
    setState(prev => ({
      ...prev,
      selectedFileIds: rangeIds,
      lastSelectedId: id
    }))
  } else {
    // 普通点击: 单选
    setState(prev => ({
      ...prev,
      selectedFileIds: [id],
      lastSelectedId: id
    }))
  }
}
```

## 调试技巧

### 1. 前端调试
```typescript
// 在浏览器控制台查看状态
console.log('Current state:', state)

// 监听状态变化
useEffect(() => {
  console.log('State changed:', state)
}, [state])

// 性能分析
const start = performance.now()
// ... 执行操作
const end = performance.now()
console.log(`Operation took ${end - start}ms`)
```

### 2. 后端调试
```rust
// 打印调试信息
println!("Debug: file_path = {}", file_path);
eprintln!("Error: {}", error);  // 输出到 stderr

// 使用 tracing
tracing::debug!("Processing file: {}", file_path);
tracing::info!("Batch {} completed", batch_id);
tracing::warn!("Failed to process: {}", error);
tracing::error!("Database error: {}", e);
```

### 3. 数据库检查
```bash
# 使用 SQLite CLI 检查数据库
sqlite3 ~/.local/share/aurora-gallery/colors.db

# 查看表结构
.schema file_colors

# 查看数据
SELECT * FROM file_colors LIMIT 10;

# 查看状态统计
SELECT status, COUNT(*) FROM file_colors GROUP BY status;

# 查看 WAL 状态
PRAGMA journal_mode;
PRAGMA wal_checkpoint;
```

## 性能优化清单

### 前端优化
- [ ] 使用 `useMemo` 缓存派生状态
- [ ] 使用 `useCallback` 缓存回调函数
- [ ] 实现虚拟滚动（大列表）
- [ ] 图片懒加载
- [ ] 防抖和节流用户输入
- [ ] 代码分割和懒加载组件

### 后端优化
- [ ] 使用批量数据库操作
- [ ] 启用 WAL 模式
- [ ] 合理设置并发数（4-8）
- [ ] 定期 WAL 检查点
- [ ] 图像预处理（缩放）

### 网络优化
- [ ] 并发控制（async pool）
- [ ] 请求重试机制
- [ ] 缓存 AI 响应
- [ ] 批量 API 调用

## 故障排除

### 常见问题

#### 1. Tauri 应用无法启动
```bash
# 检查 Rust 安装
rustc --version

# 清理并重建
cargo clean
npm run build

# 检查系统依赖
# Windows: 安装 Visual Studio Build Tools
# macOS: 安装 Xcode Command Line Tools
# Linux: 安装 libgtk-3-dev 等
```

#### 2. 数据库连接失败
```bash
# 检查数据库文件权限
ls -la ~/.local/share/aurora-gallery/

# 删除损坏的数据库（会丢失数据）
rm ~/.local/share/aurora-gallery/colors.db

# 重启应用，自动创建新数据库
```

#### 3. 色彩提取卡住
```typescript
// 在控制台执行
await pauseColorExtraction()
await resumeColorExtraction()

// 或者重启应用
```

#### 4. AI 分析失败
```typescript
// 检查 API 配置
console.log('AI Settings:', state.settings.ai)

// 测试 API 连接
const testAI = async () => {
  try {
    const result = await aiService.analyzeImage(testImagePath, state.settings)
    console.log('AI Test Success:', result)
  } catch (error) {
    console.error('AI Test Failed:', error)
  }
}
```

## 开发工作流

### 1. 添加新功能
```bash
# 1. 定义类型 (types.ts)
interface NewFeature {
  id: string
  name: string
}

# 2. 创建组件 (components/)
# 3. 实现业务逻辑 (services/)
# 4. 添加 API 桥接 (api/tauri-bridge.ts)
# 5. 添加 Rust 命令 (main.rs)
# 6. 测试
```

### 2. 调试流程
```typescript
// 1. 在浏览器控制台查看日志
// 2. 在 Rust 代码中添加 println!
// 3. 使用 Tauri 开发工具
// 4. 检查数据库状态
// 5. 监控性能指标
```

### 3. 测试流程
```typescript
// 单元测试
test('scanDirectory returns correct structure', async () => {
  const result = await scanDirectory('/test/path')
  expect(result.roots.length).toBeGreaterThan(0)
})

// 集成测试
test('full workflow: scan -> analyze -> extract colors', async () => {
  // 1. 扫描
  // 2. AI 分析
  // 3. 色彩提取
  // 4. 验证结果
})
```

## 版本兼容性

### Node.js
- **要求**: >= 18.0.0
- **推荐**: 20.x LTS

### Rust
- **要求**: >= 1.70.0
- **推荐**: 1.75+

### Tauri
- **版本**: 2.0.0+
- **兼容**: Windows 10+, macOS 11+, Linux (GTK3+)

### 浏览器
- **支持**: Chrome 90+, Firefox 90+, Safari 14+
- **特性**: ES2020, Async/Await, Fetch API

---

**文档版本**: 1.0  
**最后更新**: 2026-01-07  
**维护状态**: 活跃