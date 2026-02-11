# Aurora Gallery Tauri API 参考文档

## UI 组件参考

### `ColorPickerPopover` (src/components/ColorPickerPopover.tsx)
- **功能**: 弹出式颜色选择器，支持 HSV 面板、色相滑块、十六进制与 RGB 输入、预设颜色与 Eyedropper（若浏览器支持）。
- **Props 简要**:
  - `initialColor?: string` - 初始颜色，默认 `#ffffff`。
  - `onChange: (color: string) => void` - 颜色变更回调，返回 `#RRGGBB` 格式。
  - `onClose: () => void` - 关闭回调。
  - `className?: string` - 用于定位/样式的自定义类名。
  - `t?: (key: string) => string` - 可选国际化函数，用于本地化按钮/提示文本。

### `PersonGrid` (src/components/PersonGrid.tsx)
- **功能**: 专门的人物网格视图组件，提供人物头像显示、选择、管理功能。从 FileGrid 中分离出来以提高代码组织性。
- **主要 Props**:
  - `people: Record<string, Person>` - 人物数据映射
  - `files: Record<string, FileNode>` - 文件数据映射（用于获取头像）
  - `selectedPersonIds: string[]` - 选中的人物 ID 列表
  - `onPersonClick: (id: string, e: React.MouseEvent) => void` - 人物点击回调
  - `onPersonDoubleClick: (id: string) => void` - 人物双击回调
  - `onPersonContextMenu: (e: React.MouseEvent, id: string) => void` - 右键菜单回调
  - `t: (key: string) => string` - 国际化函数

**使用场景**:
- 在人物标签页显示人物集合
- 支持人物头像的裁剪显示和人脸定位
- 提供流式布局和响应式设计

### `ContextMenu` (src/components/ContextMenu.tsx)
- **功能**: 通用的右键上下文菜单组件，基于上下文类型（文件/文件夹/人物/专题）渲染不同菜单项，支持键盘操作与可配置的快捷项。
- **Props 简要**:
  - `items: MenuItem[]` - 菜单项数组
  - `position: { x: number; y: number }` - 菜单显示位置
  - `onSelect: (id: string) => void` - 菜单项选择回调
  - `onClose: () => void` - 关闭回调

### `ToastItem` (src/components/ToastItem.tsx)
- **功能**: 单个通知项组件，用于在屏幕角落显示短消息、操作按钮和进度指示（与 `TaskProgressModal` 配合）。
- **Props 简要**:
  - `id: string` - 通知 ID
  - `type?: 'info' | 'success' | 'error'` - 通知类型
  - `message: string` - 显示文本
  - `onDismiss?: (id: string) => void` - 关闭回调

### `useAIAnalysis` Hook (src/hooks/useAIAnalysis.ts)
- **功能**: 封装对单个文件或文件夹的 AI 分析流程（描述、标签、场景、对象识别、OCR、翻译），调用 `aiService` 并将分析任务注册到 `useTasks`，返回分析状态与结果缓存接口。
- **主要接口**:
  - `handleAIAnalysis(fileIds: string | string[], folderId?: string): Promise<void>` - 分析文件或文件夹
  - `handleFolderAIAnalysis(folderId: string): Promise<void>` - 分析整个文件夹

### TopicModule (src/components/TopicModule.tsx)
- **功能**: 专题（Topic）画廊与专题详情视图，支持专题的创建/编辑/删除、专题与人物（Person）的关联、封面设置与裁剪、以及主题内文件的浏览与选择。
- **主要 Props**:
  - `topics: Record<string, Topic>`
  - `files: Record<string, FileNode>`
  - `people: Record<string, Person>`
  - `currentTopicId: string | null`
  - `selectedTopicIds: string[]`
  - `onNavigateTopic: (topicId: string | null) => void`
  - `onCreateTopic: (parentId: string | null, name?: string) => void`
  - `onUpdateTopic: (topicId: string, updates: Partial<Topic>) => void`
  - `onDeleteTopic: (topicId: string) => void`
  - `onSelectTopics: (ids: string[]) => void`
  - `onSelectFiles: (fileIds: string[]) => void`

**使用场景**:
- 在侧栏或概览页显示专题集合（专题画廊）
- 双击专题或在专题中打开专题详情页以查看该专题下的图片和关联的人物
- 右键菜单支持批量操作、重命名与删除

---

## 前端 API (TypeScript)

### 1. 文件系统 API (`src/api/tauri-bridge.ts`)

#### `scanDirectory`
```typescript
async function scanDirectory(
  path: string,
  forceRefresh?: boolean
): Promise<{ roots: string[]; files: Record<string, FileNode> }>
```

**描述**: 扫描指定目录并返回文件树结构。
- 调用后端的 `scan_directory` 命令
- 支持极速启动模式：优先从数据库缓存加载，减少启动时间

**参数**:
- `path`: string - 要扫描的目录路径
- `forceRefresh?`: boolean - 是否强制刷新（重新扫描磁盘）

**返回**: `Promise<{ roots: string[]; files: Record<string, FileNode> }>`
```typescript
// roots: 包含 parentId 为 null 且类型为文件夹的根目录 id
// files: id -> FileNode 映射
```

**示例**:
```typescript
const result = await scanDirectory('/home/user/Pictures')
console.log(result.roots)
console.log(result.files)
```

---

#### `forceRescan`
```typescript
async function forceRescan(
  path: string
): Promise<{ roots: string[]; files: Record<string, FileNode> }>
```

**描述**: 强制完整扫描目录，忽略数据库缓存。

**参数**:
- `path`: string - 要扫描的目录路径

**返回**: 与 `scanDirectory` 相同

---

#### `scanFile`
```typescript
async function scanFile(
  filePath: string, 
  parentId?: string | null
): Promise<FileNode>
```

**描述**: 扫描单个文件，返回文件节点

**参数**:
- `filePath`: string - 文件完整路径
- `parentId`: string | null - 父目录 ID (可选)

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

**描述**: 重命名或移动文件/文件夹，同时同步更新数据库索引

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

**描述**: 删除文件或目录，同时清理数据库记录

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
  srcPath: string, 
  destPath: string
): Promise<string>
```

**描述**: 复制文件，返回实际写入的目标路径（同目录自复制时会生成唯一文件名）

**参数**:
- `srcPath`: string - 源文件路径
- `destPath`: string - 目标文件路径

**返回**: `Promise<string>` - 实际写入的目标路径

**示例**:
```typescript
const finalPath = await copyFile(
  '/home/user/Pictures/source.jpg',
  '/home/user/Pictures/destination.jpg'
)
```

---

#### `copyImageColors`
```typescript
async function copyImageColors(
  srcPath: string, 
  destPath: string
): Promise<boolean>
```

**描述**: 复制图片的颜色信息到另一个图片

**参数**:
- `srcPath`: string - 源文件路径
- `destPath`: string - 目标文件路径

**返回**: `Promise<boolean>` - 是否成功复制

---

#### `copyImageToClipboard`
```typescript
async function copyImageToClipboard(filePath: string): Promise<void>
```

**描述**: 复制图片到系统剪贴板

**参数**:
- `filePath`: string - 图片文件路径

**示例**:
```typescript
await copyImageToClipboard('/home/user/Pictures/photo.jpg')
```

---

#### `moveFile`
```typescript
async function moveFile(
  srcPath: string, 
  destPath: string
): Promise<void>
```

**描述**: 移动文件，同时同步迁移数据库元数据

**参数**:
- `srcPath`: string - 源文件路径
- `destPath`: string - 目标文件路径

**示例**:
```typescript
await moveFile(
  '/home/user/Downloads/photo.jpg',
  '/home/user/Pictures/photo.jpg'
)
```

---

#### `writeFileFromBytes`
```typescript
async function writeFileFromBytes(
  filePath: string, 
  bytes: Uint8Array
): Promise<void>
```

**描述**: 从字节数组写入文件

**参数**:
- `filePath`: string - 文件路径
- `bytes`: Uint8Array - 文件内容字节数组

**示例**:
```typescript
const bytes = new Uint8Array([72, 101, 108, 108, 111]); // "Hello"
await writeFileFromBytes('/home/user/test.txt', bytes)
```

---

#### `getThumbnail`
```typescript
async function getThumbnail(
  filePath: string, 
  modified?: string, 
  rootPath?: string, 
  signal?: AbortSignal, 
  onColors?: (colors: DominantColor[] | null) => void
): Promise<string | null>
```

**描述**: 获取文件缩略图，支持颜色提取回调。前端使用批量请求聚合（~50ms 窗口）减少后端调用。

**参数**:
- `filePath`: string - 文件路径
- `modified?`: string - 文件修改时间（用于缓存）
- `rootPath?`: string - 资源根目录（必需，用于计算缓存路径）
- `signal?`: AbortSignal - 取消信号
- `onColors?`: (colors: DominantColor[] | null) => void - 颜色提取回调

**返回**: `Promise<string | null>` - 缩略图 Asset URL 或 null

**示例**:
```typescript
const thumbnailUrl = await getThumbnail(
  '/home/user/Pictures/photo.jpg',
  '2024-01-01T00:00:00Z',
  '/home/user/Pictures',
  abortController.signal,
  (colors) => console.log('Dominant colors:', colors)
)
```

---

#### `getAssetUrl`
```typescript
function getAssetUrl(filePath: string): string
```

**描述**: 获取文件的资源 URL（用于在 img 标签中直接显示本地文件）

**参数**:
- `filePath`: string - 文件路径

**返回**: string - 资源 URL

**示例**:
```typescript
const url = getAssetUrl('/home/user/Pictures/photo.jpg')
// 返回: "asset://localhost/home/user/Pictures/photo.jpg"
```

---

#### `readFileAsBase64`
```typescript
async function readFileAsBase64(filePath: string): Promise<string | null>
```

**描述**: 以 Base64 格式读取文件内容，自动检测 MIME 类型

**参数**:
- `filePath`: string - 文件路径

**返回**: `Promise<string | null>` - Base64 编码的数据 URL

**示例**:
```typescript
const base64 = await readFileAsBase64('/home/user/Pictures/photo.jpg')
console.log(base64) // "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQ..."
```

---

#### `getDominantColors`
```typescript
async function getDominantColors(
  filePath: string, 
  count?: number, 
  thumbnailPath?: string
): Promise<DominantColor[]>
```

**描述**: 从图片文件中提取主色调。优先从数据库获取，如无则实时提取并保存。

**参数**:
- `filePath`: string - 图片文件路径
- `count?`: number - 要提取的颜色数量（默认 8）
- `thumbnailPath?`: string - 可选的缩略图路径（用于 AVIF 等格式的降级处理）

**返回**: `Promise<DominantColor[]>` - 主色调数组

**示例**:
```typescript
const colors = await getDominantColors('/home/user/Pictures/photo.jpg', 5)
console.log(colors)
// [{ hex: '#FF0000', rgb: [255, 0, 0], isDark: false, labL: 53.2, labA: 80.1, labB: 67.2, percentage: 0.25 }, ...]
```

---

#### `searchByColor`
```typescript
async function searchByColor(color: string): Promise<string[]>
```

**描述**: 按颜色搜索图片

**参数**:
- `color`: string - 目标颜色（十六进制格式，如 `#ff0000`）

**返回**: `Promise<string[]>` - 匹配的图片文件路径列表（按相似度排序）

**示例**:
```typescript
const results = await searchByColor('#FF0000')
console.log(results) // ['/path/to/red1.jpg', '/path/to/red2.jpg', ...]
```

---

#### `searchByPalette`
```typescript
async function searchByPalette(palette: string[]): Promise<string[]>
```

**描述**: 按颜色调色板搜索图片

**参数**:
- `palette`: string[] - 颜色十六进制字符串数组

**返回**: `Promise<string[]>` - 匹配的图片文件路径列表

**示例**:
```typescript
const results = await searchByPalette(['#FF0000', '#00FF00', '#0000FF'])
console.log(results) // ['/path/to/image.jpg', ...]
```

---

#### `generateDragPreview`
```typescript
async function generateDragPreview(
  thumbnailPaths: string[], 
  totalCount: number, 
  cacheRoot: string
): Promise<string | null>
```

**描述**: 生成拖拽预览图（最多使用前 3 个缩略图合成）

**参数**:
- `thumbnailPaths`: string[] - 缩略图路径数组
- `totalCount`: number - 总文件数
- `cacheRoot`: string - 缓存目录

**返回**: `Promise<string | null>` - 预览图路径

---

#### `startDragToExternal`
```typescript
async function startDragToExternal(
  filePaths: string[], 
  thumbnailPaths?: string[], 
  cacheRoot?: string, 
  onDragEnd?: () => void
): Promise<void>
```

**描述**: 启动文件拖拽到外部应用的操作（使用 `tauri-plugin-drag`）

**参数**:
- `filePaths`: string[] - 要拖拽的文件路径数组
- `thumbnailPaths?`: string[] - 缩略图路径数组
- `cacheRoot?`: string - 缓存目录
- `onDragEnd?`: () => void - 拖拽结束回调

**示例**:
```typescript
await startDragToExternal(
  ['/path/to/file1.jpg', '/path/to/file2.jpg'],
  ['/cache/thumb1.jpg', '/cache/thumb2.jpg'],
  '/cache',
  () => console.log('Drag completed')
)
```

---

#### `pauseColorExtraction`
```typescript
async function pauseColorExtraction(): Promise<boolean>
```

**描述**: 暂停颜色提取后台任务

**返回**: `Promise<boolean>` - 是否成功暂停

---

#### `resumeColorExtraction`
```typescript
async function resumeColorExtraction(): Promise<boolean>
```

**描述**: 恢复颜色提取后台任务

**返回**: `Promise<boolean>` - 是否成功恢复

---

#### `addPendingFilesToDb`
```typescript
async function addPendingFilesToDb(filePaths: string[]): Promise<number>
```

**描述**: 批量添加文件到颜色数据库的 pending 表（用于首次扫描）

**参数**:
- `filePaths`: string[] - 文件路径列表

**返回**: `Promise<number>` - 实际添加的文件数量

---

### 2. 用户数据 API

#### `saveUserData`
```typescript
async function saveUserData(data: any): Promise<boolean>
```

**描述**: 保存用户数据到持久化存储。会自动过滤掉大型文件元数据（应使用元数据数据库存储）。

**参数**:
- `data`: any - 要保存的数据

**返回**: `Promise<boolean>` - 是否成功

**示例**:
```typescript
const success = await saveUserData({
  rootPaths: ['/home/user/Pictures'],
  customTags: ['vacation', 'family'],
  settings: { ... }
})
```

---

#### `loadUserData`
```typescript
async function loadUserData(): Promise<any | null>
```

**描述**: 从持久化存储加载用户数据

**返回**: `Promise<any | null>` - 保存的数据

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
async function getDefaultPaths(): Promise<Record<string, string>>
```

**描述**: 获取默认路径配置

**返回**: `Promise<Record<string, string>>` - 包含 `resourceRoot` 和 `cacheRoot`

**示例**:
```typescript
const paths = await getDefaultPaths()
console.log('资源根目录:', paths.resourceRoot)
console.log('缓存根目录:', paths.cacheRoot)
```

---

### 3. 目录和文件操作 API

#### `openDirectory`
```typescript
async function openDirectory(): Promise<string | null>
```

**描述**: 打开目录选择对话框

**返回**: `Promise<string | null>` - 选择的目录路径，或 null

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

**描述**: 创建新目录，同时同步更新索引数据库

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
async function openPath(path: string, isFile?: boolean): Promise<void>
```

**描述**: 在系统文件管理器中打开路径

**参数**:
- `path`: string - 要打开的路径
- `isFile?`: boolean - 是否为文件。如果提供，将在文件管理器中选中该项

**示例**:
```typescript
// 打开目录
await openPath('/home/user/Pictures')

// 打开文件并选中
await openPath('/home/user/Pictures/photo.jpg', true)
```

---

### 4. 数据库 / 元数据 API

#### `dbUpsertFileMetadata`
```typescript
async function dbUpsertFileMetadata(metadata: {
  fileId: string;
  path: string;
  tags?: string[];
  description?: string;
  sourceUrl?: string;
  category?: string;
  aiData?: any;
  updatedAt?: number;
}): Promise<void>
```

**描述**: 插入或更新文件的元数据到数据库

**参数**:
- `metadata`: Object - 元数据对象

---

#### `dbCopyFileMetadata`
```typescript
async function dbCopyFileMetadata(srcPath: string, destPath: string): Promise<void>
```

**描述**: 复制文件元数据（包括索引、颜色、元数据）

**参数**:
- `srcPath`: string - 源文件路径
- `destPath`: string - 目标文件路径

---

### 5. 人物数据库 API

#### `dbGetAllPeople`
```typescript
async function dbGetAllPeople(): Promise<Person[]>
```

**描述**: 从数据库读取所有人物

**返回**: `Promise<Person[]>` - 人物数组

---

#### `dbUpsertPerson`
```typescript
async function dbUpsertPerson(person: Person): Promise<void>
```

**描述**: 插入或更新人物信息

**参数**:
- `person`: Person - 人物数据

---

#### `dbDeletePerson`
```typescript
async function dbDeletePerson(id: string): Promise<void>
```

**描述**: 删除人物记录

**参数**:
- `id`: string - 人物 ID

---

#### `dbUpdatePersonAvatar`
```typescript
async function dbUpdatePersonAvatar(
  personId: string, 
  coverFileId: string, 
  faceBox: FaceBox | null
): Promise<void>
```

**描述**: 更新人物头像信息（包括脸部框）

**参数**:
- `personId`: string - 人物 ID
- `coverFileId`: string - 封面文件 ID
- `faceBox`: FaceBox | null - 人脸位置信息

---

### 6. 专题数据库 API

#### `dbGetAllTopics`
```typescript
async function dbGetAllTopics(): Promise<Topic[]>
```

**描述**: 从数据库读取所有专题

**返回**: `Promise<Topic[]>` - 专题数组

---

#### `dbUpsertTopic`
```typescript
async function dbUpsertTopic(topic: Topic): Promise<void>
```

**描述**: 插入或更新专题信息

**参数**:
- `topic`: Topic - 专题数据

---

#### `dbDeleteTopic`
```typescript
async function dbDeleteTopic(id: string): Promise<void>
```

**描述**: 删除专题记录

**参数**:
- `id`: string - 专题 ID

---

### 7. 窗口管理 API

#### `hideWindow`
```typescript
async function hideWindow(): Promise<void>
```

**描述**: 隐藏主窗口（最小化到托盘）

---

#### `showWindow`
```typescript
async function showWindow(): Promise<void>
```

**描述**: 显示主窗口

---

#### `setWindowMinSize`
```typescript
async function setWindowMinSize(width: number, height: number): Promise<void>
```

**描述**: 设置窗口最小尺寸

**参数**:
- `width`: number - 最小宽度
- `height`: number - 最小高度

---

#### `exitApp`
```typescript
async function exitApp(): Promise<void>
```

**描述**: 退出应用程序

---

### 8. 数据库切换 API

#### `switchRootDatabase`
```typescript
async function switchRootDatabase(newRootPath: string): Promise<void>
```

**描述**: 切换根目录数据库（当用户更改资源根目录时使用）

**参数**:
- `newRootPath`: string - 新的根目录路径

---

## 后端命令 (Rust / Tauri)

### 1. 文件系统命令

#### `scan_directory`
```rust
#[tauri::command]
async fn scan_directory(
    path: String, 
    force_rescan: Option<bool>,
    app: tauri::AppHandle
) -> Result<HashMap<String, FileNode>, String>
```

**描述**: 扫描目录，支持极速启动模式（从数据库缓存加载）

**参数**:
- `path`: String - 目录路径
- `force_rescan`: Option<bool> - 是否强制重新扫描

**返回**: `Result<HashMap<String, FileNode>, String>` - 文件节点映射

**事件**:
- `scan-progress`: 扫描进度更新

---

#### `force_rescan`
```rust
#[tauri::command]
async fn force_rescan(
    path: String, 
    app: tauri::AppHandle
) -> Result<HashMap<String, FileNode>, String>
```

**描述**: 强制完整扫描目录

---

#### `scan_file`
```rust
#[tauri::command]
async fn scan_file(
    file_path: String, 
    parent_id: Option<String>,
    app: tauri::AppHandle
) -> Result<FileNode, String>
```

**描述**: 扫描单个文件

---

#### `rename_file`
```rust
#[tauri::command]
async fn rename_file(
    old_path: String, 
    new_path: String,
    app: tauri::AppHandle
) -> Result<(), String>
```

**描述**: 重命名文件/文件夹，同步更新数据库索引

---

#### `delete_file`
```rust
#[tauri::command]
async fn delete_file(
    path: String,
    app: tauri::AppHandle
) -> Result<(), String>
```

**描述**: 删除文件/文件夹，同步清理数据库记录

---

#### `create_folder`
```rust
#[tauri::command]
async fn create_folder(
    path: String,
    app: tauri::AppHandle
) -> Result<(), String>
```

**描述**: 创建目录，同步更新索引数据库

---

#### `ensure_directory`
```rust
#[tauri::command]
async fn ensure_directory(path: String) -> Result<(), String>
```

**描述**: 确保目录存在

---

#### `copy_file`
```rust
#[tauri::command]
async fn copy_file(
    src_path: String, 
    dest_path: String
) -> Result<String, String>
```

**描述**: 复制文件，返回实际写入的路径

---

#### `copy_image_colors`
```rust
#[tauri::command]
async fn copy_image_colors(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: String
) -> Result<bool, String>
```

**描述**: 复制图片颜色信息

---

#### `copy_image_to_clipboard`
```rust
#[tauri::command]
async fn copy_image_to_clipboard(
    file_path: String
) -> Result<(), String>
```

**描述**: 复制图片到系统剪贴板

---

#### `move_file`
```rust
#[tauri::command]
async fn move_file(
    src_path: String, 
    dest_path: String,
    app: tauri::AppHandle
) -> Result<(), String>
```

**描述**: 移动文件，同步迁移数据库元数据

---

#### `write_file_from_bytes`
```rust
#[tauri::command]
async fn write_file_from_bytes(
    file_path: String, 
    bytes: Vec<u8>,
    app: tauri::AppHandle
) -> Result<(), String>
```

**描述**: 写入二进制数据到文件

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

---

#### `file_exists`
```rust
#[tauri::command]
async fn file_exists(file_path: String) -> Result<bool, String>
```

**描述**: 检查文件是否存在

---

#### `read_file_as_base64`
```rust
#[tauri::command]
async fn read_file_as_base64(file_path: String) -> Result<Option<String>, String>
```

**描述**: 读取文件为 Base64 编码

---

#### `get_avif_preview`
```rust
#[tauri::command]
async fn get_avif_preview(path: String) -> Result<String, String>
```

**描述**: 获取 AVIF 图片预览（利用 WebView2 原生支持）

---

#### `get_jxl_preview`
```rust
#[tauri::command]
async fn get_jxl_preview(path: String) -> Result<String, String>
```

**描述**: 获取 JXL 图片预览（解码为 WebP）

---

### 2. 缩略图命令

#### `get_thumbnail`
```rust
#[tauri::command]
pub async fn get_thumbnail(
    file_path: String, 
    cache_root: String
) -> Result<Option<String>, String>
```

**描述**: 获取单个缩略图

---

#### `get_thumbnails_batch`
```rust
#[tauri::command]
pub async fn get_thumbnails_batch(
    file_paths: Vec<String>,
    cache_root: String,
    on_event: Channel<ThumbnailBatchResult>
) -> Result<(), String>
```

**描述**: 批量获取缩略图（流式返回）

---

#### `save_remote_thumbnail`
```rust
#[tauri::command]
pub async fn save_remote_thumbnail(
    file_path: String,
    thumbnail_data: String,  // base64 data URL
    colors: Vec<ColorResult>,
    cache_root: String
) -> Result<String, String>
```

**描述**: 保存前端生成的缩略图（用于 AVIF 降级处理）

---

#### `generate_drag_preview`
```rust
#[tauri::command]
pub async fn generate_drag_preview(
    thumbnail_paths: Vec<String>, 
    total_count: usize, 
    cache_root: String
) -> Result<Option<String>, String>
```

**描述**: 生成拖拽预览图

---

### 3. 颜色相关命令

#### `get_dominant_colors`
```rust
#[tauri::command]
async fn get_dominant_colors(
    file_path: String, 
    count: usize, 
    thumbnail_path: Option<String>,
    app: tauri::AppHandle
) -> Result<Vec<ColorResult>, String>
```

**描述**: 获取图片主色调

---

#### `search_by_color`
```rust
#[tauri::command]
async fn search_by_color(color: String) -> Result<Vec<String>, String>
```

**描述**: 按颜色搜索图片

---

#### `search_by_palette`
```rust
#[tauri::command]
async fn search_by_palette(target_palette: Vec<String>) -> Result<Vec<String>, String>
```

**描述**: 按调色板搜索图片

---

#### `add_pending_files_to_db`
```rust
#[tauri::command]
async fn add_pending_files_to_db(
    app: tauri::AppHandle,
    file_paths: Vec<String>
) -> Result<usize, String>
```

**描述**: 批量添加文件到颜色数据库的 pending 表

---

#### `pause_color_extraction`
```rust
#[tauri::command]
fn pause_color_extraction() -> bool
```

**描述**: 暂停颜色提取

---

#### `resume_color_extraction`
```rust
#[tauri::command]
fn resume_color_extraction() -> bool
```

**描述**: 恢复颜色提取

---

### 4. 用户数据命令

#### `save_user_data`
```rust
#[tauri::command]
async fn save_user_data(
    app_handle: tauri::AppHandle, 
    data: serde_json::Value
) -> Result<bool, String>
```

**描述**: 保存用户数据

---

#### `load_user_data`
```rust
#[tauri::command]
async fn load_user_data(
    app_handle: tauri::AppHandle
) -> Result<Option<serde_json::Value>, String>
```

**描述**: 加载用户数据

---

#### `get_default_paths`
```rust
#[tauri::command]
async fn get_default_paths() -> Result<HashMap<String, String>, String>
```

**描述**: 获取默认路径

---

### 5. 窗口控制命令

#### `hide_window`
```rust
#[tauri::command]
async fn hide_window(app_handle: tauri::AppHandle) -> Result<(), String>
```

**描述**: 隐藏窗口

---

#### `show_window`
```rust
#[tauri::command]
async fn show_window(app_handle: tauri::AppHandle) -> Result<(), String>
```

**描述**: 显示窗口

---

#### `set_window_min_size`
```rust
#[tauri::command]
async fn set_window_min_size(
    app_handle: tauri::AppHandle, 
    width: f64, 
    height: f64
) -> Result<(), String>
```

**描述**: 设置窗口最小尺寸

---

#### `exit_app`
```rust
#[tauri::command]
async fn exit_app(app_handle: tauri::AppHandle) -> Result<(), String>
```

**描述**: 退出应用

---

### 6. 数据库命令

#### `db_get_all_people`
```rust
#[tauri::command]
fn db_get_all_people(pool: tauri::State<AppDbPool>) -> Result<Vec<Person>, String>
```

**描述**: 获取所有人物

---

#### `db_upsert_person`
```rust
#[tauri::command]
fn db_upsert_person(
    pool: tauri::State<AppDbPool>, 
    person: Person
) -> Result<(), String>
```

**描述**: 插入或更新人物

---

#### `db_delete_person`
```rust
#[tauri::command]
fn db_delete_person(
    pool: tauri::State<AppDbPool>, 
    id: String
) -> Result<(), String>
```

**描述**: 删除人物

---

#### `db_update_person_avatar`
```rust
#[tauri::command]
fn db_update_person_avatar(
    pool: tauri::State<AppDbPool>, 
    person_id: String, 
    cover_file_id: String, 
    face_box: Option<FaceBox>
) -> Result<(), String>
```

**描述**: 更新人物头像

---

#### `db_get_all_topics`
```rust
#[tauri::command]
fn db_get_all_topics(pool: tauri::State<AppDbPool>) -> Result<Vec<Topic>, String>
```

**描述**: 获取所有专题

---

#### `db_upsert_topic`
```rust
#[tauri::command]
fn db_upsert_topic(
    pool: tauri::State<AppDbPool>, 
    topic: Topic
) -> Result<(), String>
```

**描述**: 插入或更新专题

---

#### `db_delete_topic`
```rust
#[tauri::command]
fn db_delete_topic(
    pool: tauri::State<AppDbPool>, 
    id: String
) -> Result<(), String>
```

**描述**: 删除专题

---

#### `db_upsert_file_metadata`
```rust
#[tauri::command]
async fn db_upsert_file_metadata(
    pool: tauri::State<'_, AppDbPool>, 
    metadata: FileMetadata
) -> Result<(), String>
```

**描述**: 插入或更新文件元数据

---

#### `db_copy_file_metadata`
```rust
#[tauri::command]
async fn db_copy_file_metadata(
    src_path: String, 
    dest_path: String, 
    app: tauri::AppHandle
) -> Result<(), String>
```

**描述**: 复制文件元数据

---

#### `switch_root_database`
```rust
#[tauri::command]
async fn switch_root_database(
    new_root_path: String,
    app_db_pool: tauri::State<'_, AppDbPool>,
    color_db_pool: tauri::State<'_, Arc<ColorDbPool>>,
) -> Result<(), String>
```

**描述**: 切换根目录数据库

---

### 7. WAL 检查点命令

#### `force_wal_checkpoint`
```rust
#[tauri::command]
async fn force_wal_checkpoint(app: tauri::AppHandle) -> Result<bool, String>
```

**描述**: 强制执行 WAL 检查点

---

#### `get_wal_info`
```rust
#[tauri::command]
async fn get_wal_info(app: tauri::AppHandle) -> Result<(i64, i64), String>
```

**描述**: 获取 WAL 文件信息（大小和检查点数）

---

## 事件监听

### 前端事件

#### `scan-progress`
```typescript
import { listen } from '@tauri-apps/api/event'

const unlisten = await listen('scan-progress', (event) => {
  const progress = event.payload as ScanProgress
  console.log(`进度: ${progress.processed}/${progress.total}`)
})
```

**事件负载**:
```typescript
interface ScanProgress {
  processed: number
  total: number
}
```

---

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

#### `metadata-updated`
```typescript
const unlisten = await listen('metadata-updated', (event) => {
  const entries = event.payload as FileIndexEntry[]
  console.log('元数据已更新:', entries)
})
```

**描述**: 后台索引完成时触发，通知前端更新文件元数据

---

## 数据类型参考

### FileType
```typescript
enum FileType {
  IMAGE = 'image',
  FOLDER = 'folder',
  UNKNOWN = 'unknown'
}
```

---

### FileNode
```typescript
interface FileNode {
  id: string                    // 唯一标识
  parentId: string | null       // 父目录 ID
  name: string                  // 文件名
  type: FileType                // 文件类型
  path: string                  // 完整路径
  size?: number                 // 文件大小（字节）
  children?: string[]           // 子节点 ID 数组
  
  category?: 'general' | 'book' | 'sequence'  // 分类
  author?: string               // 作者
  
  url?: string                  // 资源 URL（内部使用）
  previewUrl?: string           // 预览 URL
  tags: string[]                // 用户标签
  description?: string          // 用户描述
  sourceUrl?: string            // 来源 URL
  meta?: ImageMeta              // 元数据
  aiData?: AiData              // AI 分析数据
  
  createdAt?: string           // 创建时间
  updatedAt?: string           // 更新时间
  lastRefresh?: number         // 上次刷新时间戳
  isRefreshing?: boolean       // 是否正在刷新（UI 状态）
}
```

---

### ImageMeta
```typescript
interface ImageMeta {
  width: number
  height: number
  sizeKb: number
  created: string
  modified: string
  format: string
  palette?: string[]
  dominantColors?: DominantColor[]
}
```

---

### DominantColor
```typescript
interface DominantColor {
  hex: string
  rgb: [number, number, number]
  isDark: boolean
  labL?: number      // LAB 颜色空间 L 值
  labA?: number      // LAB 颜色空间 A 值
  labB?: number      // LAB 颜色空间 B 值
  percentage?: number // 颜色占比
}
```

---

### AiData
```typescript
interface AiData {
  analyzed: boolean
  analyzedAt: string
  description: string
  tags: string[]
  faces: AiFace[]
  sceneCategory: string
  confidence: number
  dominantColors: string[]
  objects: string[]
  extractedText?: string    // OCR 提取的文本
  translatedText?: string   // 翻译后的文本
}
```

---

### AiFace
```typescript
interface AiFace {
  id: string
  personId: string
  name: string
  confidence: number
  box: { x: number; y: number; w: number; h: number }
}
```

---

### Person
```typescript
interface Person {
  id: string
  name: string
  coverFileId: string
  count: number
  description?: string
  descriptor?: number[]      // 人脸特征向量
  faceBox?: { x: number; y: number; w: number; h: number }  // 百分比 0-100
  updatedAt?: number         // 更新时间戳
}
```

---

### FaceBox (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FaceBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}
```

---

### Topic
```typescript
interface Topic {
  id: string
  parentId: string | null
  name: string
  description?: string
  type?: string              // 自定义显示类型/标签，最多 12 字
  coverFileId?: string
  backgroundFileId?: string
  coverCrop?: CoverCropData
  peopleIds: string[]
  fileIds?: string[]
  sourceUrl?: string
  createdAt?: string
  updatedAt?: string
}
```

**注意**: Rust 后端中 `type` 字段序列化为 `topicType` 以避免与 Rust 关键字冲突。

---

### CoverCropData
```typescript
interface CoverCropData {
  x: number        // 左上角相对于原图的百分比
  y: number
  width: number    // 裁剪区域宽度百分比
  height: number   // 裁剪区域高度百分比
}
```

---

### TaskProgress
```typescript
interface TaskProgress {
  id: string
  type: 'ai' | 'copy' | 'move' | 'thumbnail' | 'color'
  title: string
  total: number
  current: number
  startTime: number
  status: 'running' | 'completed' | 'paused'
  minimized: boolean
  currentStep?: string
  currentFile?: string
  estimatedTime?: number           // 预估剩余时间（毫秒）
  lastProgressUpdate?: number      // 上次进度更新时间
  lastProgress?: number            // 上次进度值
  initialTotal?: number            // 初始总数
  lastEstimatedTimeUpdate?: number // 上次更新预估时间的时间戳
  totalProcessedTime?: number      // 累计有效处理时间
}
```

---

### AIConfig
```typescript
interface AIConfig {
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
  targetLanguage: 'zh' | 'en' | 'ja' | 'ko'
  confidenceThreshold: number
  systemPrompt?: string           // 系统提示词
  promptPresets?: PromptPreset[]  // 提示词预设
  currentPresetId?: string        // 当前预设 ID
}
```

---

### PromptPreset
```typescript
interface PromptPreset {
  id: string
  name: string
  content: string
}
```

---

### AppSettings
```typescript
interface AppSettings {
  theme: 'light' | 'dark' | 'system'
  language: 'zh' | 'en'
  autoStart: boolean
  exitAction: 'ask' | 'minimize' | 'exit'
  animateOnHover: boolean
  paths: {
    resourceRoot: string
    cacheRoot: string
  }
  search: {
    isAISearchEnabled: boolean
  }
  ai: AIConfig
  performance: {
    refreshInterval: number  // 毫秒
  }
  defaultLayoutSettings: {
    layoutMode: LayoutMode
    sortBy: SortOption
    sortDirection: SortDirection
    groupBy: GroupByOption
  }
}
```

---

### TabState
```typescript
interface TabState {
  id: string
  folderId: string
  viewingFileId: string | null
  viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview'
  layoutMode: LayoutMode
  searchQuery: string
  searchScope: SearchScope
  aiFilter?: AiSearchFilter | null
  activeTags: string[]
  activePersonId: string | null
  activeTopicId: string | null
  selectedTopicIds: string[]
  dateFilter: DateFilter
  selectedFileIds: string[]
  lastSelectedId: string | null
  selectedTagIds: string[]
  selectedPersonIds: string[]
  currentPage: number
  isCompareMode: boolean
  sessionName?: string
  scrollToItemId?: string
  history: {
    stack: HistoryItem[]
    currentIndex: number
  }
  scrollTop: number
}
```

---

### HistoryItem
```typescript
interface HistoryItem {
  folderId: string
  viewingId: string | null
  viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview'
  searchQuery: string
  searchScope: SearchScope
  activeTags: string[]
  activePersonId: string | null
  activeTopicId?: string | null
  selectedTopicIds?: string[]
  selectedPersonIds?: string[]
  aiFilter?: AiSearchFilter | null
  scrollTop?: number
  currentPage?: number
}
```

---

### AiSearchFilter
```typescript
interface AiSearchFilter {
  keywords: string[]
  colors: string[]
  people: string[]
  originalQuery: string
  description?: string
  filePaths?: string[]
}
```

---

### DateFilter
```typescript
interface DateFilter {
  start: string | null
  end: string | null
  mode: 'created' | 'updated'
}
```

---

### FolderSettings
```typescript
interface FolderSettings {
  layoutMode: LayoutMode
  sortBy: SortOption
  sortDirection: SortDirection
  groupBy: GroupByOption
}
```

---

### DragState
```typescript
interface DragState {
  isDragging: boolean
  draggedFileIds: string[]
  sourceFolderId: string | null
  dragOverFolderId: string | null
  dragOverPosition: 'inside' | 'before' | 'after' | null
}
```

---

### 类型别名
```typescript
type SearchScope = 'all' | 'file' | 'tag' | 'folder'
type SortOption = 'name' | 'date' | 'size'
type SortDirection = 'asc' | 'desc'
type LayoutMode = 'grid' | 'adaptive' | 'list' | 'masonry'
type GroupByOption = 'none' | 'type' | 'date' | 'size'
type SettingsCategory = 'general' | 'appearance' | 'network' | 'storage' | 'ai' | 'performance'
```

---

## Rust 内部数据结构

### FileIndexEntry (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileIndexEntry {
    pub file_id: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub name: String,
    pub file_type: String, // "Image", "Folder", "Unknown"
    pub size: u64,
    pub created_at: i64,
    pub modified_at: i64,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
}
```

### FileMetadata (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub file_id: String,
    pub path: String,
    pub tags: Option<serde_json::Value>,
    pub description: Option<String>,
    pub source_url: Option<String>,
    pub ai_data: Option<serde_json::Value>,
    pub category: Option<String>,
    pub updated_at: Option<i64>,
}
```

### Person (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
    pub cover_file_id: String,
    pub count: i32,
    pub description: Option<String>,
    pub face_box: Option<FaceBox>,
    pub updated_at: Option<i64>,
}
```

### Topic (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Topic {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub topic_type: Option<String>,  // 序列化为 topicType
    pub cover_file_id: Option<String>,
    pub background_file_id: Option<String>,
    pub cover_crop: Option<CoverCropData>,
    pub people_ids: Vec<String>,
    pub file_ids: Vec<String>,
    pub source_url: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
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
  getThumbnail,
  dbUpsertFileMetadata,
  copyImageToClipboard,
  dbGetAllTopics,
  dbUpsertTopic
} from './api/tauri-bridge'

// 1. 扫描目录
async function loadPictures() {
  const result = await scanDirectory('/home/user/Pictures')
  return result
}

// 2. 获取缩略图
async function loadThumbnail(filePath: string, rootPath: string) {
  const thumbnailUrl = await getThumbnail(
    filePath,
    '2024-01-01T00:00:00Z',
    rootPath,
    undefined,
    (colors) => console.log('Dominant colors:', colors)
  )
  return thumbnailUrl
}

// 3. 监听扫描进度
async function monitorScanProgress() {
  const unlisten = await listen('scan-progress', (event) => {
    const progress = event.payload
    console.log(`扫描进度: ${progress.processed}/${progress.total}`)
  })
  return unlisten
}

// 4. 保存文件元数据
async function saveFileMetadata(fileId: string, path: string, tags: string[], description: string) {
  await dbUpsertFileMetadata({
    fileId,
    path,
    tags,
    description,
    updatedAt: Date.now()
  })
}

// 5. 复制图片到剪贴板
async function copyToClipboard(filePath: string) {
  await copyImageToClipboard(filePath)
}

// 6. 专题操作
async function manageTopics() {
  const topics = await dbGetAllTopics()
  console.log('所有专题:', topics)
  
  await dbUpsertTopic({
    id: 'topic-1',
    name: '旅行照片',
    description: '2024年旅行照片合集',
    peopleIds: [],
    fileIds: ['file-1', 'file-2']
  })
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

---

**文档版本**: 1.2  
**更新日期**: 2026-02-11  
**覆盖范围**: 所有公共 API  
**详细程度**: 高
