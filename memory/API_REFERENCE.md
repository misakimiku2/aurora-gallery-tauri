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

### 1. 文件系统 API (`src/api/tauri-bridge/files.ts`)

> 注：`src/api/tauri-bridge.ts` 已拆分为 `src/api/tauri-bridge/` 目录（按领域分模块，`index.ts` 统一 re-export）。下方所有 API 的 import 路径 `'./api/tauri-bridge'` 均不变。

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

## 局域网共享 API (LAN Share)

局域网共享功能允许用户在局域网内通过浏览器访问和管理图片库，支持多设备同时连接。

### 前端 API (TypeScript)

#### `lanShareStart`
```typescript
async function lanShareStart(
  config: LanShareSettings,
  rootPath: string
): Promise<LanShareInfo>
```

**描述**: 启动局域网共享服务

**参数**:
- `config`: LanShareSettings - 共享配置
  - `enabled`: boolean - 是否启用
  - `port`: number - 服务端口（默认 8080）
  - `accessCode`: string - 访问验证码
  - `allowEdit`: boolean - 是否允许编辑和删除
  - `allowUpload`: boolean - 是否允许上传
- `rootPath`: string - 根目录路径

**返回**: `Promise<LanShareInfo>`
```typescript
interface LanShareInfo {
  url: string        // 访问地址，如 "http://192.168.1.100:8080"
  port: number       // 实际使用的端口
  local_ip: string   // 本机局域网 IP 地址
}
```

**示例**:
```typescript
const info = await lanShareStart({
  enabled: true,
  port: 8080,
  accessCode: '123456',
  allowEdit: false,
  allowUpload: false
}, '/home/user/Pictures')
console.log(`服务已启动: ${info.url}`)
```

---

#### `lanShareStop`
```typescript
async function lanShareStop(): Promise<void>
```

**描述**: 停止局域网共享服务

**示例**:
```typescript
await lanShareStop()
```

---

#### `lanShareGetStatus`
```typescript
async function lanShareGetStatus(): Promise<LanShareStatus>
```

**描述**: 获取局域网共享服务状态

**返回**: `Promise<LanShareStatus>`
```typescript
interface LanShareStatus {
  is_running: boolean      // 服务是否运行中
  port: number             // 服务端口
  local_ip: string | null  // 本机局域网 IP
  device_count: number     // 当前连接设备数
}
```

**示例**:
```typescript
const status = await lanShareGetStatus()
if (status.is_running) {
  console.log(`服务运行中，端口: ${status.port}，设备数: ${status.device_count}`)
}
```

---

#### `lanShareGetDevices`
```typescript
async function lanShareGetDevices(): Promise<ConnectedDevice[]>
```

**描述**: 获取已连接设备列表

**返回**: `Promise<ConnectedDevice[]>` - 已连接设备数组

**示例**:
```typescript
const devices = await lanShareGetDevices()
devices.forEach(device => {
  console.log(`${device.name} (${device.ip}) - 最后活跃: ${new Date(device.lastActiveAt * 1000)}`)
})
```

---

#### `lanShareGetLocalIp`
```typescript
async function lanShareGetLocalIp(): Promise<string>
```

**描述**: 获取本机局域网 IP 地址

**返回**: `Promise<string>` - IP 地址

**示例**:
```typescript
const ip = await lanShareGetLocalIp()
console.log(`本机 IP: ${ip}`)
```

---

#### `lanShareCheckPort`
```typescript
async function lanShareCheckPort(port: number): Promise<boolean>
```

**描述**: 检查端口是否可用

**参数**:
- `port`: number - 端口号

**返回**: `Promise<boolean>` - 端口是否可用

**示例**:
```typescript
const available = await lanShareCheckPort(8080)
if (!available) {
  console.log('端口 8080 已被占用')
}
```

---

#### `lanShareUpdateConfig`
```typescript
async function lanShareUpdateConfig(config: LanShareSettings): Promise<void>
```

**描述**: 更新局域网共享配置（运行时更新）

**参数**:
- `config`: LanShareSettings - 新配置

**示例**:
```typescript
await lanShareUpdateConfig({
  ...currentConfig,
  allowEdit: true
})
```

---

### 后端命令 (Rust / Tauri)

#### `lan_share_start`
```rust
#[tauri::command]
pub async fn lan_share_start(
    config: LanShareConfig,
    root_path: String,
    state: State<'_, LanShareState>,
    app: AppHandle
) -> Result<LanShareInfo, String>
```

**描述**: 启动局域网共享服务器

**参数**:
- `config`: LanShareConfig - 服务配置
- `root_path`: String - 资源根目录路径

**返回**: `Result<LanShareInfo, String>` - 服务信息

---

#### `lan_share_stop`
```rust
#[tauri::command]
pub async fn lan_share_stop(
    state: State<'_, LanShareState>
) -> Result<(), String>
```

**描述**: 停止局域网共享服务器

---

#### `lan_share_get_status`
```rust
#[tauri::command]
pub async fn lan_share_get_status(
    state: State<'_, LanShareState>
) -> Result<LanShareStatus, String>
```

**描述**: 获取服务器运行状态

---

#### `lan_share_get_devices`
```rust
#[tauri::command]
pub async fn lan_share_get_devices(
    state: State<'_, LanShareState>
) -> Result<Vec<ConnectedDevice>, String>
```

**描述**: 获取已连接设备列表

---

#### `lan_share_get_local_ip`
```rust
#[tauri::command]
pub async fn lan_share_get_local_ip() -> Result<String, String>
```

**描述**: 获取本机局域网 IP 地址

---

#### `lan_share_check_port`
```rust
#[tauri::command]
pub async fn lan_share_check_port(port: u16) -> Result<bool, String>
```

**描述**: 检查端口是否可用

---

#### `lan_share_update_config`
```rust
#[tauri::command]
pub async fn lan_share_update_config(
    config: LanShareConfig,
    state: State<'_, LanShareState>
) -> Result<(), String>
```

**描述**: 更新服务配置

---

### HTTP API (局域网客户端)

局域网共享服务启动后，客户端可通过 HTTP API 访问资源。所有 API（除认证外）需要携带 Bearer Token。

#### `POST /api/auth/verify`
认证接口，获取访问令牌。

**请求体**:
```json
{
  "code": "123456",
  "device_name": "My Phone"  // 可选
}
```

**响应**:
```json
{
  "success": true,
  "token": "uuid-token-string",
  "expires_in": 3600
}
```

---

#### `GET /api/browse`
浏览目录内容。

**查询参数**:
- `path`: string - 目录路径（可选，默认为根目录）

**响应**:
```json
{
  "current_path": "folder/subfolder",
  "folders": [
    {
      "name": "Vacation",
      "path": "folder/subfolder/Vacation",
      "type": "folder",
      "size": 150,
      "preview_images": ["img1.jpg", "img2.jpg"]
    }
  ],
  "images": [
    {
      "name": "photo.jpg",
      "path": "folder/subfolder/photo.jpg",
      "type": "image",
      "size": 2048576,
      "thumbnail": "/api/thumbnail?path=folder/subfolder/photo.jpg",
      "width": 1920,
      "height": 1080
    }
  ]
}
```

---

#### `GET /api/search`
搜索文件和文件夹。

**查询参数**:
- `q`: string - 搜索关键词
- `scope`: string - 搜索范围（"all" | "file" | "folder"，可选）

**响应**: 与 `/api/browse` 相同格式

---

#### `GET /api/thumbnail`
获取图片缩略图。

**查询参数**:
- `path`: string - 图片路径
- `size`: number - 缩略图尺寸（可选，默认 256）
- `token`: string - 访问令牌（可选，可作为查询参数传递）

**响应**: JPEG 图片数据

---

#### `GET /api/image`
获取原始图片。

**查询参数**:
- `path`: string - 图片路径
- `token`: string - 访问令牌（可选）

**响应**: 原始图片数据（Content-Type 根据格式自动设置）

---

#### `DELETE /api/file`
删除文件（需要 `allow_edit` 权限）。

**查询参数**:
- `path`: string - 文件路径

**响应**:
```json
{
  "success": true
}
```

---

#### `POST /api/rename`
重命名文件（需要 `allow_edit` 权限）。

**请求体**:
```json
{
  "old_path": "folder/old_name.jpg",
  "new_name": "new_name.jpg"
}
```

**响应**:
```json
{
  "success": true,
  "path": "folder/new_name.jpg"
}
```

---

#### `GET /api/devices`
获取当前连接的设备列表。

**响应**:
```json
{
  "devices": [
    {
      "id": "device-uuid",
      "name": "My Phone",
      "ip": "192.168.1.101",
      "connected_at": 1700000000,
      "last_active_at": 1700001000
    }
  ]
}
```

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
}
```

**注意**: 在 AVIF 降级处理的前端颜色提取中，会额外计算 `labL`、`labA`、`labB` 和 `percentage` 字段，但核心类型定义仅包含上述三个必需字段。

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
  characterTagName?: string  // 关联的角色标签名称（WD14）
  characterTagIndex?: number // 关联的角色标签索引
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
  sourceType?: 'manual' | 'auto_work'  // 来源类型：手动创建或自动生成
  workName?: string          // 作品名称（自动生成时）
  workNameCn?: string        // 作品中文名
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
  clip: ClipSettings    // CLIP 模型设置
  performance: {
    refreshInterval: number  // 毫秒
  }
  lanShare: LanShareSettings  // 局域网共享设置
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
type SettingsCategory = 'general' | 'appearance' | 'network' | 'storage' | 'ai' | 'aiVision' | 'performance' | 'lanShare' | 'about'
type PersonSortOption = 'name' | 'count' | 'created'
type PersonGroupByOption = 'none' | 'name' | 'topic'
```

---

### LanShareSettings
```typescript
interface LanShareSettings {
  enabled: boolean           // 是否启用局域网共享
  port: number               // 服务端口（默认 8080）
  accessCode: string         // 访问验证码
  allowEdit: boolean         // 允许编辑和删除
  allowUpload: boolean       // 允许上传
}
```

---

### LanShareInfo
```typescript
interface LanShareInfo {
  url: string                // 访问地址，如 "http://192.168.1.100:8080"
  port: number               // 实际使用的端口
  local_ip: string           // 本机局域网 IP 地址
}
```

---

### LanShareStatus
```typescript
interface LanShareStatus {
  is_running: boolean        // 服务是否运行中
  port: number               // 服务端口
  local_ip: string | null    // 本机局域网 IP
  device_count: number       // 当前连接设备数
}
```

---

### ConnectedDevice
```typescript
interface ConnectedDevice {
  id: string                 // 设备唯一标识
  name: string               // 设备名称
  ip: string                 // IP 地址
  connectedAt: number        // 连接时间戳（Unix 时间戳，秒）
  lastActiveAt: number       // 最后活跃时间戳（Unix 时间戳，秒）
}
```

---

### BrowseItem
```typescript
interface BrowseItem {
  name: string               // 文件/文件夹名称
  path: string               // 相对路径
  type: string               // 类型："folder" 或 "image"
  size?: number              // 文件大小（字节）或文件夹内文件数
  thumbnail?: string         // 缩略图 URL（仅图片）
  preview_images?: string[]  // 预览图片路径数组（仅文件夹）
  width?: number             // 图片宽度
  height?: number            // 图片高度
}
```

---

### BrowseResponse
```typescript
interface BrowseResponse {
  current_path: string       // 当前路径
  folders: BrowseItem[]      // 文件夹列表
  images: BrowseItem[]       // 图片列表
}
```

---

### AuthRequest
```typescript
interface AuthRequest {
  code: string               // 访问验证码
  device_name?: string       // 设备名称（可选）
}
```

---

### AuthResponse
```typescript
interface AuthResponse {
  success: boolean           // 认证是否成功
  token?: string             // 访问令牌（成功时返回）
  expires_in?: number        // 令牌有效期（秒）
  error?: string             // 错误信息（失败时返回）
}
```

---

### OperationResponse
```typescript
interface OperationResponse {
  success: boolean           // 操作是否成功
  path?: string              // 新路径（重命名成功时返回）
  error?: string             // 错误信息（失败时返回）
}
```

---

### LanShareConfig (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanShareConfig {
    pub enabled: bool,
    pub port: u16,
    pub access_code: String,
    pub allow_edit: bool,
    pub allow_upload: bool,
}
```

---

### ConnectedDevice (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedDevice {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub connected_at: u64,
    pub last_active_at: u64,
}
```

---

### LanShareStatus (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanShareStatus {
    pub is_running: bool,
    pub port: u16,
    pub local_ip: Option<String>,
    pub device_count: usize,
}
```

---

### LanShareInfo (Rust)
```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanShareInfo {
    pub url: String,
    pub port: u16,
    pub local_ip: String,
}
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
    pub character_tag_name: Option<String>,
    pub character_tag_index: Option<i32>,
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

## CLIP 向量搜索 API

### `clipSearchByText`
```typescript
async function clipSearchByText(
  text: string,
  options?: ClipSearchOptions,
  modelName?: string
): Promise<ClipSearchResult[]>
```

**描述**: 使用自然语言文本搜索图片

**参数**:
- `text`: string - 搜索文本
- `options?`: ClipSearchOptions - 搜索选项
- `modelName?`: string - 模型名称

**返回**: `Promise<ClipSearchResult[]>` - 搜索结果列表

---

### `clipSearchByImage`
```typescript
async function clipSearchByImage(
  imagePath: string,
  options?: ClipSearchOptions,
  modelName?: string
): Promise<ClipSearchResult[]>
```

**描述**: 使用图片搜索相似图片（以图搜图）

**参数**:
- `imagePath`: string - 图片路径
- `options?`: ClipSearchOptions - 搜索选项
- `modelName?`: string - 模型名称

**返回**: `Promise<ClipSearchResult[]>` - 搜索结果列表

---

### `clipGenerateEmbedding`
```typescript
async function clipGenerateEmbedding(
  filePath: string,
  fileId?: string,
  autoAddTags?: boolean,
  tagThreshold?: number,
  language?: string
): Promise<number[]>
```

**描述**: 为指定图片生成 CLIP 嵌入向量

**参数**:
- `filePath`: string - 图片路径
- `fileId?`: string - 文件 ID
- `autoAddTags?`: boolean - 是否自动添加标签（WD14 模型）
- `tagThreshold?`: number - 标签置信度阈值
- `language?`: string - 标签语言（'zh' 或 'en'）

**返回**: `Promise<number[]>` - 嵌入向量

---

### `clipLoadModel`
```typescript
async function clipLoadModel(modelName: string): Promise<void>
```

**描述**: 加载 CLIP 模型

**参数**:
- `modelName`: string - 模型名称 (SigLIP2-Base, SigLIP2-So400M, WD-EVA02-Large-Tagger-V3)

---

### `clipUnloadModel`
```typescript
async function clipUnloadModel(): Promise<void>
```

**描述**: 卸载 CLIP 模型（释放内存）

---

### `clipIsModelLoaded`
```typescript
async function clipIsModelLoaded(): Promise<boolean>
```

**描述**: 检查 CLIP 模型是否已加载

**返回**: `Promise<boolean>` - 是否已加载

---

### `clipGetEmbeddingCount`
```typescript
async function clipGetEmbeddingCount(): Promise<number>
```

**描述**: 获取 CLIP 嵌入向量数量

**返回**: `Promise<number>` - 嵌入向量总数

---

### `clipGetEmbeddingCountByModel`
```typescript
async function clipGetEmbeddingCountByModel(modelName: string): Promise<number>
```

**描述**: 获取指定模型的嵌入向量数量

**参数**:
- `modelName`: string - 模型名称

**返回**: `Promise<number>` - 该模型的嵌入向量数量

---

### `clipGetModelVersions`
```typescript
async function clipGetModelVersions(): Promise<Array<[string, number]>>
```

**描述**: 获取所有模型版本及其嵌入数量

**返回**: `Promise<Array<[string, number]>>` - 模型版本和嵌入数量的列表

---

### `clipGetEmbeddingStats`
```typescript
async function clipGetEmbeddingStats(): Promise<ClipEmbeddingStats>
```

**描述**: 获取嵌入向量统计信息（包括根目录路径）

**返回**: `Promise<ClipEmbeddingStats>` - 嵌入向量统计信息

---

### `clipGetModelStatus`
```typescript
async function clipGetModelStatus(modelName: string): Promise<ClipModelStatus>
```

**描述**: 获取 CLIP 模型下载状态

**参数**:
- `modelName`: string - 模型名称

**返回**: `Promise<ClipModelStatus>` - 模型状态

---

### `clipDeleteModel`
```typescript
async function clipDeleteModel(modelName: string): Promise<void>
```

**描述**: 删除 CLIP 模型文件

**参数**:
- `modelName`: string - 模型名称

---

### `clipUpdateConfig`
```typescript
async function clipUpdateConfig(useGpu: boolean): Promise<void>
```

**描述**: 更新 CLIP 配置（如 GPU 加速）

**参数**:
- `useGpu`: boolean - 是否启用 GPU 加速

---

### `clipCancelEmbeddingGeneration`
```typescript
async function clipCancelEmbeddingGeneration(): Promise<void>
```

**描述**: 取消 CLIP 嵌入向量生成

---

### `clipPauseEmbeddingGeneration`
```typescript
async function clipPauseEmbeddingGeneration(): Promise<void>
```

**描述**: 暂停 CLIP 嵌入向量生成

---

### `clipResumeEmbeddingGeneration`
```typescript
async function clipResumeEmbeddingGeneration(): Promise<void>
```

**描述**: 继续 CLIP 嵌入向量生成

---

### `clipGenerateTagsFromEmbeddings`
```typescript
async function clipGenerateTagsFromEmbeddings(
  modelName?: string,
  threshold?: number,
  language?: string
): Promise<{ total: number; success: number; skipped: number }>
```

**描述**: 从已有的嵌入向量生成标签（仅 WD14 模型）

**参数**:
- `modelName?`: string - 模型名称
- `threshold?`: number - 标签置信度阈值
- `language?`: string - 标签语言（'zh' 或 'en'）

**返回**: `Promise<{ total: number; success: number; skipped: number }>` - 处理结果

---

### `clipPreviewTagsFromEmbeddings`
```typescript
async function clipPreviewTagsFromEmbeddings(
  modelName?: string,
  threshold?: number,
  language?: string
): Promise<{ tags: PreviewTag[]; total_files: number; files_with_tags: number }>
```

**描述**: 预览从嵌入向量生成的标签（不保存）

**参数**:
- `modelName?`: string - 模型名称
- `threshold?`: number - 标签置信度阈值
- `language?`: string - 标签语言

**返回**: 预览结果

---

### `clipSearchByCharacterTag`
```typescript
async function clipSearchByCharacterTag(
  tagIndex: number,
  minScore: number,
  maxResults?: number
): Promise<ClipSearchResult[]>
```

**描述**: 按角色标签搜索图片

**参数**:
- `tagIndex`: number - 标签索引
- `minScore`: number - 最小相似度阈值
- `maxResults?`: number - 最大返回结果数

**返回**: `Promise<ClipSearchResult[]>` - 搜索结果列表

---

### `clipGetWorkTopics`
```typescript
async function clipGetWorkTopics(
  minScore: number,
  minCount?: number,
  language?: string
): Promise<WorkTopicInfo[]>
```

**描述**: 获取作品专题信息（从 WD14 角色标签提取）

**参数**:
- `minScore`: number - 最小相似度阈值
- `minCount?`: number - 最小匹配文件数
- `language?`: string - 语言

**返回**: `Promise<WorkTopicInfo[]>` - 作品专题列表

---

### `clipCreateWorkTopics`
```typescript
async function clipCreateWorkTopics(
  worksToCreate: WorkToCreate[]
): Promise<CreateWorkTopicsResult>
```

**描述**: 创建作品专题（自动创建关联人物）

**参数**:
- `worksToCreate`: WorkToCreate[] - 要创建的作品列表

**返回**: `Promise<CreateWorkTopicsResult>` - 创建结果

---

### `getAllImageFiles`
```typescript
async function getAllImageFiles(): Promise<{ id: string; path: string; name: string; format?: string }[]>
```

**描述**: 获取所有图片文件（从数据库查询），用于 CLIP 嵌入向量生成

**返回**: 图片文件列表

---

### `clipOpenModelFolder`
```typescript
async function clipOpenModelFolder(): Promise<void>
```

**描述**: 打开 CLIP 模型缓存文件夹

---

### `listenClipEmbeddingProgress`
```typescript
function listenClipEmbeddingProgress(
  callback: (data: {
    current: number;
    total: number;
    progress: number;
    success: number;
    failed: number;
    skipped?: number;
    processed?: number;
    timestamp?: number;
  }) => void
): Promise<() => void>
```

**描述**: 监听 CLIP 嵌入向量生成进度事件

**返回**: 取消监听的函数

---

### `listenClipEmbeddingCompleted`
```typescript
function listenClipEmbeddingCompleted(
  callback: (data: {
    total: number;
    success: number;
    failed: number;
    cancelled: boolean;
  }) => void
): Promise<() => void>
```

**描述**: 监听 CLIP 嵌入向量生成完成事件

---

### `listenClipEmbeddingCancelled`
```typescript
function listenClipEmbeddingCancelled(
  callback: (data: {
    processed: number;
    total: number;
  }) => void
): Promise<() => void>
```

**描述**: 监听 CLIP 嵌入向量生成取消事件

---

### `listenClipModelDownloadProgress`
```typescript
function listenClipModelDownloadProgress(
  callback: (data: ClipModelDownloadProgress) => void
): Promise<() => void>
```

**描述**: 监听 CLIP 模型下载进度事件

---

### `clipGenerateEmbeddingsBatch`
```typescript
async function clipGenerateEmbeddingsBatch(
  files: [string, string][],
  useGpu: boolean,
  modelName?: string,
  autoAddTags?: boolean,
  tagThreshold?: number,
  language?: string
): Promise<ClipBatchEmbeddingResult>
```

**描述**: 批量生成图片的 CLIP 嵌入向量

**参数**:
- `files`: [string, string][] - 文件列表，每个元素为 [file_path, file_id] 元组
- `useGpu`: boolean - 是否启用 GPU 加速
- `modelName?`: string - 模型名称
- `autoAddTags?`: boolean - 是否自动添加标签（WD14 模型）
- `tagThreshold?`: number - 标签置信度阈值
- `language?`: string - 标签语言

---

### `clipGetCharacterTags`
```typescript
async function clipGetCharacterTags(language?: string): Promise<CharacterTag[]>
```

**描述**: 获取所有角色标签（WD14 category=4）

**参数**:
- `language?`: string - 语言（'zh' 或 'en'）

**返回**: `Promise<CharacterTag[]>` - 角色标签列表

---

### `clipGetDetectedCharacters`
```typescript
async function clipGetDetectedCharacters(
  minScore: number,
  minCount?: number,
  language?: string
): Promise<DetectedCharacter[]>
```

**描述**: 获取已检测到的角色列表

**参数**:
- `minScore`: number - 最小相似度阈值
- `minCount?`: number - 最小匹配文件数
- `language?`: string - 语言

**返回**: `Promise<DetectedCharacter[]>` - 已检测到的角色列表

---

## 更新检查 API

### `checkForUpdates`
```typescript
async function checkForUpdates(): Promise<UpdateCheckResult | null>
```

**描述**: 检查应用更新

**返回**: `Promise<UpdateCheckResult | null>` - 更新检查结果

---

### `startUpdateDownload`
```typescript
async function startUpdateDownload(installerUrl: string, version: string): Promise<void>
```

**描述**: 开始下载更新

**参数**:
- `installerUrl`: string - 安装程序下载链接
- `version`: string - 版本号

---

### `getUpdateDownloadProgress`
```typescript
async function getUpdateDownloadProgress(): Promise<DownloadProgressResult | null>
```

**描述**: 获取下载进度

**返回**: `Promise<DownloadProgressResult | null>` - 下载进度信息

---

### `installUpdate`
```typescript
async function installUpdate(): Promise<void>
```

**描述**: 安装更新（运行安装程序）

---

## 颜色数据库管理 API

### `getColorDbStats`
```typescript
async function getColorDbStats(): Promise<ColorDbStats | null>
```

**描述**: 获取主色调数据库统计信息

**返回**: `Promise<ColorDbStats | null>` - 数据库统计信息

---

### `getColorDbErrorFiles`
```typescript
async function getColorDbErrorFiles(): Promise<ColorDbErrorFile[]>
```

**描述**: 获取错误文件列表

**返回**: `Promise<ColorDbErrorFile[]>` - 错误文件列表

---

### `retryColorExtraction`
```typescript
async function retryColorExtraction(filePaths?: string[]): Promise<number>
```

**描述**: 重新处理错误文件

**参数**:
- `filePaths?`: string[] - 要重新处理的文件路径列表，如果为 null 则处理所有错误文件

**返回**: `Promise<number>` - 成功重置的文件数量

---

### `deleteColorDbErrorFiles`
```typescript
async function deleteColorDbErrorFiles(filePaths: string[]): Promise<number>
```

**描述**: 从数据库中删除错误文件记录

**参数**:
- `filePaths`: string[] - 要删除的文件路径列表

**返回**: `Promise<number>` - 成功删除的记录数量

---

## 其他 API

### `openExternalLink`
```typescript
async function openExternalLink(url: string): Promise<void>
```

**描述**: 使用系统默认浏览器打开外部链接

**参数**:
- `url`: string - 要打开的链接

---

### `proxyHttpRequest`
```typescript
async function proxyHttpRequest(
  url: string,
  method?: string,
  headers?: Record<string, string>,
  body?: string
): Promise<string>
```

**描述**: 代理 HTTP 请求（用于绕过 CORS）

**参数**:
- `url`: string - 请求 URL
- `method?`: string - HTTP 方法（默认 'GET'）
- `headers?`: Record<string, string> - 请求头
- `body?`: string - 请求体

**返回**: `Promise<string>` - 响应文本

---

### `dbGetAllFileMetadata`
```typescript
async function dbGetAllFileMetadata(): Promise<FileMetadata[]>
```

**描述**: 获取所有文件元数据

**返回**: `Promise<FileMetadata[]>` - 所有文件元数据列表

---

## CLIP 相关类型

### ClipSearchResult
```typescript
interface ClipSearchResult {
  file_id: string    // 文件 ID
  score: number      // 相似度分数 (0.0 - 1.0)
  rank: number       // 排名
}
```

---

### ClipSearchOptions
```typescript
interface ClipSearchOptions {
  top_k?: number       // 返回结果数量
  min_score?: number   // 最小相似度阈值
}
```

---

### ClipSettings
```typescript
interface ClipSettings {
  enabled: boolean
  modelName: ClipModelName
  useGpu: boolean
  downloadStatus: ClipDownloadStatus
  downloadProgress: number
  downloadError?: string
  modelVersion: string
  downloadedAt?: number
  minScore: number           // 相似度阈值 (0.0 - 1.0)
  maxResults: number         // 最大返回结果数
  unlimitedResults: boolean  // 是否无限制结果数
  autoAddTags: boolean       // WD14 模型是否自动添加标签
  tagThreshold: number       // WD14 标签置信度阈值
}
```

---

### ClipModelName
```typescript
type ClipModelName = 'SigLIP2-Base' | 'SigLIP2-So400M' | 'WD-EVA02-Large-Tagger-V3' | ''
```

---

### ClipDownloadStatus
```typescript
type ClipDownloadStatus = 'not_started' | 'downloading' | 'completed' | 'error'
```

---

### ClipEmbeddingStats
```typescript
interface ClipEmbeddingStats {
  total_count: number     // 嵌入向量总数
  model_name: string      // 当前模型名称
  root_path: string       // 根目录路径
}
```

---

### ClipModelStatus
```typescript
interface ClipModelStatus {
  model_name: string
  display_name: string
  description: string
  is_downloaded: boolean
  is_gpu_active: boolean
  embedding_dim: number
  image_size: number
  downloaded_size: number
  files: {
    [key: string]: boolean  // 模型文件名 -> 是否已下载
  }
}
```

---

### ClipModelDownloadProgress
```typescript
interface ClipModelDownloadProgress {
  file_name: string
  file_index: number
  total_files: number
  downloaded: number
  total: number
  progress: number
  overall_progress: number
  speed: number
}
```

---

### ClipBatchEmbeddingResult
```typescript
interface ClipBatchEmbeddingResult {
  total: number
  success: number
  failed: number
  failed_files: string[]
  cancelled?: boolean
  throughput?: number
  elapsed_secs?: number
}
```

---

### PreviewTag
```typescript
interface PreviewTag {
  name: string
  name_cn: string
  count: number
  sample_file_ids: string[]
}
```

---

### WorkTopicInfo
```typescript
interface WorkTopicInfo {
  workName: string
  workNameCn?: string
  characterCount: number
  imageCount: number
  characters: WorkCharacter[]
  existingTopicId?: string
  coverFileId?: string
  sampleFileIds?: string[]
  fileIds?: string[]
}
```

---

### WorkCharacter
```typescript
interface WorkCharacter {
  tagName: string
  tagNameCn?: string
  personId?: string
  imageCount: number
  coverFileId?: string
}
```

---

### WorkToCreate
```typescript
interface WorkToCreate {
  name: string
  topicType?: string
  coverFileId?: string
}
```

---

### CreateWorkTopicsResult
```typescript
interface CreateWorkTopicsResult {
  topics: Topic[]
  people: Person[]
}
```

---

### CharacterTag
```typescript
interface CharacterTag {
  tag_id: string
  name: string
  name_cn: string
  index: number
}
```

---

### DetectedCharacter
```typescript
interface DetectedCharacter {
  tag_name: string
  tag_name_cn: string
  tag_index: number
  file_count: number
  max_score: number
  sample_file_id: string
}
```

---

### ColorDbStats
```typescript
interface ColorDbStats {
  total: number
  extracted: number
  error: number
  pending: number
  processing: number
  dbSize: number
  walSize: number
}
```

---

### UpdateCheckResult
```typescript
interface UpdateCheckResult {
  has_update: boolean
  current_version: string
  latest_version: string
  download_url: string
  installer_url?: string
  installer_size?: number
  release_name: string
  release_notes: string
  published_at: string
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

**文档版本**: 1.4  
**更新日期**: 2026-03-14  
**覆盖范围**: 所有公共 API（包括局域网共享 API）  
**详细程度**: 高
