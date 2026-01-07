# Aurora Gallery Tauri API 参考文档

## 前端 API (TypeScript)

### 1. 文件系统 API (`src/api/tauri-bridge.ts`)

#### `scanDirectory`
```typescript
async function scanDirectory(
  path: string, 
  recursive: boolean = false
): Promise<ScanResult>
```

**描述**: 扫描指定目录，返回文件树结构

**参数**:
- `path`: string - 要扫描的目录路径
- `recursive`: boolean - 是否递归扫描子目录 (默认: false)

**返回**: `Promise<ScanResult>`
```typescript
interface ScanResult {
  roots: string[]        // 根目录 ID 数组
  files: Record<string, FileNode>  // 文件节点映射
}
```

**示例**:
```typescript
const result = await scanDirectory('/home/user/Pictures', true)
console.log(result.roots)  // ['root1', 'root2']
console.log(result.files) // { root1: {...}, root2: {...} }
```

**错误处理**:
```typescript
try {
  const result = await scanDirectory('/invalid/path')
} catch (error) {
  console.error('扫描失败:', error)
}
```

---

#### `scanFile`
```typescript
async function scanFile(
  filePath: string, 
  parentId?: string
): Promise<FileNode>
```

**描述**: 扫描单个文件，返回文件节点

**参数**:
- `filePath`: string - 文件完整路径
- `parentId`: string - 父目录 ID (可选)

**返回**: `Promise<FileNode>`

**示例**:
```typescript
const file = await scanFile('/home/user/Pictures/photo.jpg', 'folder1')
console.log(file.name) // 'photo.jpg'
console.log(file.type) // 'image'
```

---

#### `renameFile`
```typescript
async function renameFile(
  oldPath: string, 
  newPath: string
): Promise<void>
```

**描述**: 重命名或移动文件

**参数**:
- `oldPath`: string - 旧路径
- `newPath`: string - 新路径

**示例**:
```typescript
await renameFile(
  '/home/user/Pictures/old.jpg',
  '/home/user/Pictures/new.jpg'
)
```

---

#### `deleteFile`
```typescript
async function deleteFile(path: string): Promise<void>
```

**描述**: 删除文件或目录

**参数**:
- `path`: string - 要删除的路径

**示例**:
```typescript
await deleteFile('/home/user/Pictures/unwanted.jpg')
```

---

#### `copyFile`
```typescript
async function copyFile(
  source: string, 
  destination: string
): Promise<void>
```

**描述**: 复制文件

**参数**:
- `source`: string - 源文件路径
- `destination`: string - 目标文件路径

**示例**:
```typescript
await copyFile(
  '/home/user/Pictures/photo.jpg',
  '/home/user/Backup/photo.jpg'
)
```

---

#### `moveFile`
```typescript
async function moveFile(
  source: string, 
  destination: string
): Promise<void>
```

**描述**: 移动文件

**参数**:
- `source`: string - 源文件路径
- `destination`: string - 目标文件路径

**示例**:
```typescript
await moveFile(
  '/home/user/Downloads/photo.jpg',
  '/home/user/Pictures/photo.jpg'
)
```

---

#### `openDirectory`
```typescript
async function openDirectory(): Promise<string | null>
```

**描述**: 打开目录选择对话框

**返回**: `Promise<string | null>` - 选中的目录路径，或 null

**示例**:
```typescript
const path = await openDirectory()
if (path) {
  console.log('选中的目录:', path)
}
```

---

#### `createFolder`
```typescript
async function createFolder(path: string): Promise<void>
```

**描述**: 创建新目录

**参数**:
- `path`: string - 要创建的目录路径

**示例**:
```typescript
await createFolder('/home/user/Pictures/2024')
```

---

#### `ensureDirectory`
```typescript
async function ensureDirectory(path: string): Promise<void>
```

**描述**: 确保目录存在（不存在则创建）

**参数**:
- `path`: string - 目录路径

**示例**:
```typescript
await ensureDirectory('/home/user/.aurora/cache')
```

---

#### `openPath`
```typescript
async function openPath(
  path: string, 
  isFile: boolean = false
): Promise<void>
```

**描述**: 在系统文件管理器中打开路径

**参数**:
- `path`: string - 要打开的路径
- `isFile`: boolean - 是否为文件 (默认: false)

**示例**:
```typescript
// 打开目录
await openPath('/home/user/Pictures')

// 打开文件并选中
await openPath('/home/user/Pictures/photo.jpg', true)
```

---

### 2. 用户数据 API

#### `saveUserData`
```typescript
async function saveUserData(data: any): Promise<boolean>
```

**描述**: 保存用户数据到持久化存储

**参数**:
- `data`: any - 要保存的数据

**返回**: `Promise<boolean>` - 是否成功

**示例**:
```typescript
const success = await saveUserData({
  rootPaths: ['/home/user/Pictures'],
  customTags: ['vacation', 'family'],
  people: { ... },
  settings: { ... }
})
```

---

#### `loadUserData`
```typescript
async function loadUserData(): Promise<any>
```

**描述**: 从持久化存储加载用户数据

**返回**: `Promise<any>` - 保存的数据

**示例**:
```typescript
const data = await loadUserData()
if (data) {
  console.log('根目录:', data.rootPaths)
  console.log('设置:', data.settings)
}
```

---

#### `getDefaultPaths`
```typescript
async function getDefaultPaths(): Promise<{ 
  resourceRoot: string, 
  cacheRoot: string 
}>
```

**描述**: 获取默认路径配置

**返回**: `Promise<{ resourceRoot: string, cacheRoot: string }>`

**示例**:
```typescript
const paths = await getDefaultPaths()
console.log('资源根目录:', paths.resourceRoot)
console.log('缓存根目录:', paths.cacheRoot)
```

---

### 3. 图像处理 API

#### `getThumbnail`
```typescript
async function getThumbnail(
  filePath: string, 
  updatedAt: string, 
  resourceRoot: string
): Promise<string>
```

**描述**: 获取或生成缩略图

**参数**:
- `filePath`: string - 原图路径
- `updatedAt`: string - 文件更新时间（用于缓存失效）
- `resourceRoot`: string - 资源根目录

**返回**: `Promise<string>` - 缩略图 Data URL 或缓存路径

**示例**:
```typescript
const thumbnail = await getThumbnail(
  '/home/user/Pictures/photo.jpg',
  '2024-01-01T12:00:00Z',
  '/home/user/Pictures'
)
// 返回: "data:image/jpeg;base64,..." 或 "/cache/thumbnails/xxx.jpg"
```

---

#### `readFileAsBase64`
```typescript
async function readFileAsBase64(path: string): Promise<string>
```

**描述**: 读取文件为 Base64 编码

**参数**:
- `path`: string - 文件路径

**返回**: `Promise<string>` - Base64 编码的文件内容

**示例**:
```typescript
const base64 = await readFileAsBase64('/home/user/Pictures/photo.jpg')
// 返回: "data:image/jpeg;base64,/9j/4AAQSkZJRg..."
```

---

### 4. 窗口管理 API

#### `hideWindow`
```typescript
async function hideWindow(): Promise<void>
```

**描述**: 隐藏应用窗口（最小化到托盘）

**示例**:
```typescript
await hideWindow()
```

---

#### `showWindow`
```typescript
async function showWindow(): Promise<void>
```

**描述**: 显示应用窗口

**示例**:
```typescript
await showWindow()
```

---

#### `exitApp`
```typescript
async function exitApp(): Promise<void>
```

**描述**: 退出应用

**示例**:
```typescript
await exitApp()
```

---

### 5. 色彩提取控制 API

#### `pauseColorExtraction`
```typescript
async function pauseColorExtraction(): Promise<void>
```

**描述**: 暂停色彩提取任务

**示例**:
```typescript
await pauseColorExtraction()
```

---

#### `resumeColorExtraction`
```typescript
async function resumeColorExtraction(): Promise<void>
```

**描述**: 恢复色彩提取任务

**示例**:
```typescript
await resumeColorExtraction()
```

---

## 后端 API (Rust)

### 1. 文件系统命令

#### `scan_directory`
```rust
#[tauri::command]
async fn scan_directory(
    path: String, 
    recursive: bool
) -> Result<ScanResult, String>
```

**描述**: 扫描目录

**参数**:
- `path`: String - 目录路径
- `recursive`: bool - 是否递归

**返回**: `Result<ScanResult, String>`

**ScanResult 结构**:
```rust
struct ScanResult {
    roots: Vec<String>,
    files: HashMap<String, FileNode>,
}

struct FileNode {
    id: String,
    parent_id: Option<String>,
    name: String,
    path: String,
    file_type: FileType,  // File, Folder, Image, Video, Audio
    children: Option<Vec<String>>,
    tags: Vec<String>,
    description: Option<String>,
    meta: Option<FileMeta>,
    ai_data: Option<AiData>,
    created_at: String,
    updated_at: String,
}
```

---

#### `scan_file`
```rust
#[tauri::command]
async fn scan_file(
    file_path: String, 
    parent_id: Option<String>
) -> Result<FileNode, String>
```

**描述**: 扫描单个文件

**参数**:
- `file_path`: String - 文件路径
- `parent_id`: Option<String> - 父目录 ID

**返回**: `Result<FileNode, String>`

---

#### `rename_file`
```rust
#[tauri::command]
async fn rename_file(
    old_path: String, 
    new_path: String
) -> Result<(), String>
```

**描述**: 重命名文件

**参数**:
- `old_path`: String - 旧路径
- `new_path`: String - 新路径

**返回**: `Result<(), String>`

---

#### `delete_file`
```rust
#[tauri::command]
async fn delete_file(path: String) -> Result<(), String>
```

**描述**: 删除文件

**参数**:
- `path`: String - 文件路径

**返回**: `Result<(), String>`

---

#### `create_folder`
```rust
#[tauri::command]
async fn create_folder(path: String) -> Result<(), String>
```

**描述**: 创建目录

**参数**:
- `path`: String - 目录路径

**返回**: `Result<(), String>`

---

#### `ensure_directory`
```rust
#[tauri::command]
async fn ensure_directory(path: String) -> Result<(), String>
```

**描述**: 确保目录存在

**参数**:
- `path`: String - 目录路径

**返回**: `Result<(), String>`

---

#### `copy_file`
```rust
#[tauri::command]
async fn copy_file(
    source: String, 
    destination: String
) -> Result<(), String>
```

**描述**: 复制文件

**参数**:
- `source`: String - 源路径
- `destination`: String - 目标路径

**返回**: `Result<(), String>`

---

#### `move_file`
```rust
#[tauri::command]
async fn move_file(
    source: String, 
    destination: String
) -> Result<(), String>
```

**描述**: 移动文件

**参数**:
- `source`: String - 源路径
- `destination`: String - 目标路径

**返回**: `Result<(), String>`

---

#### `write_file_from_bytes`
```rust
#[tauri::command]
async fn write_file_from_bytes(
    path: String, 
    bytes: Vec<u8>
) -> Result<(), String>
```

**描述**: 写入二进制数据到文件

**参数**:
- `path`: String - 文件路径
- `bytes`: Vec<u8> - 二进制数据

**返回**: `Result<(), String>`

---

#### `open_path`
```rust
#[tauri::command]
async fn open_path(
    path: String, 
    is_file: Option<bool>
) -> Result<(), String>
```

**描述**: 在系统文件管理器中打开路径

**参数**:
- `path`: String - 路径
- `is_file`: Option<bool> - 是否为文件

**返回**: `Result<(), String>`

---

#### `file_exists`
```rust
#[tauri::command]
async fn file_exists(file_path: String) -> Result<bool, String>
```

**描述**: 检查文件是否存在

**参数**:
- `file_path`: String - 文件路径

**返回**: `Result<bool, String>`

---

### 2. 数据库命令

#### `get_pending_files`
```rust
#[tauri::command]
async fn get_pending_files(limit: usize) -> Result<Vec<String>, String>
```

**描述**: 获取待处理文件列表

**参数**:
- `limit`: usize - 最大数量

**返回**: `Result<Vec<String>, String>` - 文件路径数组

---

#### `update_status`
```rust
#[tauri::command]
async fn update_status(
    file_path: String, 
    status: String
) -> Result<(), String>
```

**描述**: 更新文件处理状态

**参数**:
- `file_path`: String - 文件路径
- `status`: String - 状态 (pending/processing/completed/error)

**返回**: `Result<(), String>`

---

#### `batch_save_colors`
```rust
#[tauri::command]
async fn batch_save_colors(
    colors: Vec<(String, Vec<ColorResult>)>
) -> Result<(), String>
```

**描述**: 批量保存色彩结果

**参数**:
- `colors`: Vec<(String, Vec<ColorResult>)> - (文件路径, 色彩数组) 数组

**ColorResult 结构**:
```rust
struct ColorResult {
    hex: String,
    rgb: (u8, u8, u8),
    count: usize,
    percentage: f32,
}
```

**返回**: `Result<(), String>`

---

### 3. 色彩提取控制命令

#### `pause_color_extraction`
```rust
#[tauri::command]
fn pause_color_extraction() -> bool
```

**描述**: 暂停色彩提取

**返回**: `bool` - 是否成功

---

#### `resume_color_extraction`
```rust
#[tauri::command]
fn resume_color_extraction() -> bool
```

**描述**: 恢复色彩提取

**返回**: `bool` - 是否成功

---

#### `shutdown_color_extraction`
```rust
#[tauri::command]
async fn shutdown_color_extraction() -> bool
```

**描述**: 关闭色彩提取任务

**返回**: `bool` - 是否成功

---

### 4. 用户数据命令

#### `save_user_data`
```rust
#[tauri::command]
async fn save_user_data(data: serde_json::Value) -> Result<bool, String>
```

**描述**: 保存用户数据

**参数**:
- `data`: serde_json::Value - 要保存的数据

**返回**: `Result<bool, String>` - 是否成功

---

#### `load_user_data`
```rust
#[tauri::command]
async fn load_user_data() -> Result<Option<serde_json::Value>, String>
```

**描述**: 加载用户数据

**返回**: `Result<Option<serde_json::Value>, String>` - 保存的数据

---

#### `get_default_paths`
```rust
#[tauri::command]
async fn get_default_paths() -> Result<(String, String), String>
```

**描述**: 获取默认路径

**返回**: `Result<(String, String), String>` - (资源根目录, 缓存根目录)

---

### 5. 工具命令

#### `get_thumbnail`
```rust
#[tauri::command]
async fn get_thumbnail(
    file_path: String, 
    updated_at: String, 
    resource_root: String
) -> Result<String, String>
```

**描述**: 获取缩略图

**参数**:
- `file_path`: String - 原图路径
- `updated_at`: String - 更新时间
- `resource_root`: String - 资源根目录

**返回**: `Result<String, String>` - Data URL 或路径

---

#### `get_wal_info`
```rust
#[tauri::command]
async fn get_wal_info() -> Result<(u64, u64), String>
```

**描述**: 获取 WAL 信息

**返回**: `Result<(u64, u64), String>` - (WAL 大小, 检查点数)

---

#### `force_wal_checkpoint`
```rust
#[tauri::command]
async fn force_wal_checkpoint() -> Result<(), String>
```

**描述**: 强制 WAL 检查点

**返回**: `Result<(), String>`

---

#### `force_full_checkpoint`
```rust
#[tauri::command]
async fn force_full_checkpoint() -> Result<(), String>
```

**描述**: 强制完整检查点

**返回**: `Result<(), String>`

---

#### `get_db_file_sizes`
```rust
#[tauri::command]
async fn get_db_file_sizes() -> Result<(u64, u64), String>
```

**描述**: 获取数据库文件大小

**返回**: `Result<(u64, u64), String>` - (主库大小, WAL 大小)

---

## 事件监听

### 前端事件

#### `color-extraction-progress`
```typescript
import { listen } from '@tauri-apps/api/event'

const unlisten = await listen('color-extraction-progress', (event) => {
  const progress = event.payload as ColorExtractionProgress
  console.log(`批次 ${progress.batch_id}: ${progress.current}/${progress.total}`)
})
```

**事件负载**:
```typescript
interface ColorExtractionProgress {
  batch_id: number
  current: number
  total: number
  pending: number
  current_file: string
  batch_completed: boolean
}
```

---

## 数据类型参考

### FileNode
```typescript
interface FileNode {
  id: string                    // 唯一标识
  parentId: string | null       // 父目录 ID
  name: string                  // 文件名
  path: string                  // 完整路径
  type: FileType                // 文件类型
  children?: string[]           // 子节点 ID 数组
  tags: string[]                // 用户标签
  description?: string          // 用户描述
  sourceUrl?: string            // 来源 URL
  author?: string               // 作者
  category?: string             // 分类
  meta?: FileMeta              // 元数据
  aiData?: AiData              // AI 数据
  createdAt: string            // 创建时间
  updatedAt: string            // 更新时间
}

enum FileType {
  FILE = 'file',
  FOLDER = 'folder',
  IMAGE = 'image',
  VIDEO = 'video',
  AUDIO = 'audio'
}

interface FileMeta {
  width?: number
  height?: number
  sizeKb?: number
  format?: string
  palette?: string[]
  created?: string
  modified?: string
}
```

### AiData
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

interface AiFace {
  id: string
  personId: string
  name: string
  confidence: number
  box: { x: number; y: number; w: number; h: number }
}
```

### Person
```typescript
interface Person {
  id: string
  name: string
  coverFileId: string
  count: number
  description?: string
  descriptor?: any
  faceBox?: { x: number; y: number; w: number; h: number }
}
```

### AppSettings
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
    openai: {
      apiKey: string
      endpoint: string
      model: string
    }
    ollama: {
      endpoint: string
      model: string
    }
    lmstudio: {
      endpoint: string
      model: string
    }
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

### TabState
```typescript
interface TabState {
  id: string
  folderId: string
  viewingFileId: string | null
  viewMode: 'browser' | 'tags-overview' | 'people-overview'
  layoutMode: 'grid' | 'list'
  searchQuery: string
  searchScope: 'all' | 'file' | 'folder' | 'tag'
  activeTags: string[]
  activePersonId: string | null
  selectedFileIds: string[]
  lastSelectedId: string | null
  selectedTagIds: string[]
  selectedPersonIds: string[]
  dateFilter: {
    start: string | null
    end: string | null
    mode: 'created' | 'modified'
  }
  history: {
    stack: Array<{
      folderId: string
      viewingId: string | null
      viewMode: string
      searchQuery: string
      searchScope: string
      activeTags: string[]
      activePersonId: string | null
      aiFilter?: AiSearchFilter | null
      scrollTop: number
    }>
    currentIndex: number
  }
  scrollTop: number
  aiFilter?: AiSearchFilter | null
}

interface AiSearchFilter {
  originalQuery: string
  keywords: string[]
  colors: string[]
  people: string[]
  description?: string
}
```

### TaskProgress
```typescript
interface TaskProgress {
  id: string
  type: 'copy' | 'move' | 'ai' | 'thumbnail' | 'color'
  title: string
  total: number
  current: number
  startTime: number
  status: 'running' | 'completed' | 'paused'
  minimized: boolean
  currentFile?: string
  currentStep?: string
  estimatedTime?: number
  lastProgressUpdate?: number
  lastProgress?: number
  totalProcessedTime?: number
  lastEstimatedTimeUpdate?: number
}
```

---

## 使用示例

### 完整工作流示例

```typescript
import { 
  scanDirectory, 
  readFileAsBase64, 
  pauseColorExtraction,
  listen 
} from './api/tauri-bridge'
import { AIService } from './services/aiService'

// 1. 扫描目录
async function loadPictures() {
  const result = await scanDirectory('/home/user/Pictures', true)
  return result
}

// 2. AI 分析图片
async function analyzeImage(filePath: string, settings: AppSettings) {
  const aiService = new AIService()
  const aiData = await aiService.analyzeImage(filePath, settings)
  return aiData
}

// 3. 监听色彩提取进度
async function monitorColorExtraction() {
  const unlisten = await listen('color-extraction-progress', (event) => {
    const progress = event.payload
    console.log(`进度: ${progress.current}/${progress.total}`)
    
    if (progress.batch_completed) {
      console.log('批次完成!')
    }
  })
  
  return unlisten
}

// 4. 控制色彩提取
async function controlExtraction() {
  // 暂停
  await pauseColorExtraction()
  
  // 等待一段时间
  await new Promise(resolve => setTimeout(resolve, 5000))
  
  // 恢复
  await resumeColorExtraction()
}
```

---

## 错误处理模式

### 前端错误处理
```typescript
async function safeOperation<T>(
  operation: () => Promise<T>,
  errorMessage: string
): Promise<[T | null, Error | null]> {
  try {
    const result = await operation()
    return [result, null]
  } catch (error) {
    console.error(`${errorMessage}:`, error)
    // 显示用户通知
    showNotification(errorMessage)
    return [null, error as Error]
  }
}

// 使用
const [result, error] = await safeOperation(
  () => scanDirectory('/path/to/dir'),
  '目录扫描失败'
)
```

### 后端错误处理
```rust
#[tauri::command]
async fn safe_operation(path: String) -> Result<(), String> {
    // 验证输入
    if path.is_empty() {
        return Err("路径不能为空".to_string());
    }
    
    // 执行操作
    match do_something(&path).await {
        Ok(_) => Ok(()),
        Err(e) => {
            // 记录日志
            error!("操作失败: {}", e);
            // 返回用户友好的错误信息
            Err(format!("操作失败: {}", e))
        }
    }
}
```

---

**文档版本**: 1.0  
**覆盖范围**: 所有公共 API  
**详细程度**: 高