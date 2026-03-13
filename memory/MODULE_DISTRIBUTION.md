# Aurora Gallery Tauri 模块分布详解

## 前端模块分布 (src/)

### 1. API 桥接层 (`src/api/`)

#### `tauri-bridge.ts` - 核心桥接模块
**位置**: `src/api/tauri-bridge.ts`  
**行数**: 2151 行  
**功能分类**:

**文件系统操作**:
```typescript
// 目录扫描
export async function scanDirectory(path: string, forceRefresh?: boolean): Promise<Record<string, FileNode>>
export async function forceRescan(path: string): Promise<Record<string, FileNode>>
export async function scanFile(filePath: string, parentId?: string | null): Promise<FileNode>

// 文件操作
export async function renameFile(oldPath: string, newPath: string): Promise<void>
export async function deleteFile(path: string): Promise<void>
export async function copyFile(srcPath: string, destPath: string): Promise<string>
export async function copyImageColors(srcPath: string, destPath: string): Promise<boolean>
export async function moveFile(srcPath: string, destPath: string): Promise<void>
export async function writeFileFromBytes(filePath: string, bytes: Uint8Array): Promise<void>

// 目录管理
export async function openDirectory(): Promise<string | null>
export async function ensureDirectory(path: string): Promise<void>
export async function createFolder(path: string): Promise<void>
export async function openPath(path: string, isFile?: boolean): Promise<void>

// 缩略图与图像相关
export async function getThumbnail(
  filePath: string, 
  modified?: string, 
  rootPath?: string, 
  signal?: AbortSignal, 
  onColors?: (colors: DominantColor[] | null) => void
): Promise<string | null>
export function getAssetUrl(filePath: string): string
export async function readFileAsBase64(path: string): Promise<string | null>
export async function getDominantColors(filePath: string, count?: number, thumbnailPath?: string): Promise<DominantColor[]>
export async function searchByColor(targetHex: string): Promise<string[]>
export async function searchByPalette(palette: string[]): Promise<string[]>
export async function generateDragPreview(thumbnailPaths: string[], totalCount: number, cacheRoot: string): Promise<string | null>
export async function startDragToExternal(filePaths: string[], thumbnailPaths?: string[], cacheRoot?: string, onDragEnd?: () => void): Promise<void>

// 颜色提取控制
export async function pauseColorExtraction(): Promise<boolean>
export async function resumeColorExtraction(): Promise<boolean>
export async function addPendingFilesToDb(filePaths: string[]): Promise<number>
```

**用户数据管理**:
```typescript
export async function saveUserData(data: any): Promise<boolean>
export async function loadUserData(): Promise<any>
export async function getDefaultPaths(): Promise<Record<string, string>>
```

**数据库操作**:
```typescript
export async function dbGetAllPeople(): Promise<Person[]>
export async function dbUpsertPerson(person: Person): Promise<void>
export async function dbDeletePerson(id: string): Promise<void>
export async function dbUpdatePersonAvatar(personId: string, coverFileId: string, faceBox: any): Promise<void>
export async function dbUpsertFileMetadata(metadata: FileMetadata): Promise<void>
export async function dbGetAllFileMetadata(): Promise<FileMetadata[]>
export async function dbCopyFileMetadata(srcPath: string, destPath: string): Promise<void>
export async function switchRootDatabase(newRootPath: string): Promise<void>
export async function getColorDbStats(): Promise<ColorDbStats>
export async function getColorDbErrorFiles(): Promise<ColorDbErrorFile[]>
export async function retryColorExtraction(filePaths?: string[]): Promise<number>
export async function deleteColorDbErrorFiles(filePaths: string[]): Promise<number>
```

**CLIP 向量搜索**:
```typescript
export async function clipSearchByText(text: string, options?: ClipSearchOptions, modelName?: string): Promise<ClipSearchResult[]>
export async function clipSearchByImage(imagePath: string, options?: ClipSearchOptions, modelName?: string): Promise<ClipSearchResult[]>
export async function clipGenerateEmbedding(filePath: string, fileId?: string, autoAddTags?: boolean, tagThreshold?: number, language?: string): Promise<number[]>
export async function clipLoadModel(modelName: string): Promise<void>
export async function clipUnloadModel(): Promise<void>
export async function clipIsModelLoaded(): Promise<boolean>
export async function clipGetEmbeddingCount(): Promise<number>
export async function clipGenerateEmbeddingsBatch(files: [string, string][], useGpu: boolean, modelName?: string, autoAddTags?: boolean, tagThreshold?: number, language?: string): Promise<ClipBatchEmbeddingResult>
export async function clipGetCharacterTags(language?: string): Promise<CharacterTag[]>
export async function clipGetDetectedCharacters(minScore: number, minCount?: number, language?: string): Promise<DetectedCharacter[]>
export async function clipGetModelStatus(modelName: string): Promise<ClipModelStatus>
export async function clipDeleteModel(modelName: string): Promise<void>
```

**更新检查**:
```typescript
export async function checkForUpdates(): Promise<UpdateCheckResult>
export async function startUpdateDownload(installerUrl: string, version: string): Promise<void>
export async function pauseUpdateDownload(): Promise<void>
export async function resumeUpdateDownload(): Promise<void>
export async function cancelUpdateDownload(): Promise<void>
export async function getUpdateDownloadProgress(): Promise<DownloadProgressResult>
export async function installUpdate(): Promise<void>
```

**其他**:
```typescript
export async function openExternalLink(url: string): Promise<void>
export async function proxyHttpRequest(url: string, method?: string, headers?: Record<string, string>, body?: string): Promise<string>
```

**窗口管理**:
```typescript
export async function hideWindow(): Promise<void>
export async function showWindow(): Promise<void>
export async function exitApp(): Promise<void>
```

---

### 2. 组件库 (`src/components/`)

#### `App.tsx` - 主应用组件
**位置**: `src/App.tsx`  
**行数**: 4362 行  

**概览**:
- `App.tsx` 仍为大型单体组件，负责绝大多数 UI 状态、视图路由与操作协调。近期改动强调可维护性与性能：把任务管理抽出到 `src/hooks/useTasks.ts`，并精细化拖拽、选择与 AI/色彩搜索逻辑。

**状态与配置（关键字段）**:
- 完整 `AppState` 初始化包含：root 列表、`files`、`people`、`topics`、多个 `tabs`、视图排序和分组、`thumbnailSize`、`clipboard`、`customTags`、`folderSettings`、`layout`（侧边栏与元数据面板可见性）、幻灯片配置、`settings.ai`（OpenAI/Ollama/LM Studio 配置与开关）、以及拖拽/选择相关状态（`dragState` / `isExternalDragging` / `isDraggingInternal` / `draggedFilePaths`）。

**派生状态与性能优化**:
- 使用大量 `useMemo`/`useCallback` 计算派生数据：`activeTab`、`displayFileIds`（含 AI 过滤、颜色/色板搜索与日期过滤）、`groupedTags`、`personCounts`（带性能计时）、`peopleWithDisplayCounts` 等。
- 引入 `performanceMonitor` 记录关键函数的耗时（如 `personCounts`、复制/移动任务等）。
- 布局计算使用 Web Worker (`src/workers/layout.worker.ts`) 进行异步计算，避免阻塞主线程。

**核心 Hook 与初始化**:
- 初始化流程负责：检测 Tauri 环境、加载用户数据、扫描目录、注册事件（包括自定义 `color-update` 事件以即时更新文件主色调）以及挂载窗口关闭/最小化回调。
- 色彩提取进度监听已迁移并集中在 `useTasks` 中。

**任务管理（迁移到 `useTasks`）**:
- `useTasks` 提供 `startTask`、`updateTask`、任务状态列表等，统一处理：复制/移动/AI/颜色/缩略图等任务，并对 `color-extraction-progress` 事件进行监听与更新。

**交互与输入处理**:
- 复杂的鼠标选择框实现（按下/移动/释放），优化为直接 DOM 操作 + 节流（`throttle` 函数）以减少抖动并提升性能。
- 右键菜单、键盘快捷键以及范围选择（Ctrl/Shift）均实现并支持基于显示顺序的范围选择（文件/人物/标签）。

**拖拽与外部文件处理**:
- 完整的内部与外部拖拽处理：区分内部拖拽（application/json）与外部（Files），实现 `handleExternalDragEnter` / `handleExternalDragLeave` / `handleExternalDrop` 等。
- 支持 `handleExternalCopyFiles` 与 `handleExternalMoveFiles`（将浏览器 `File` 对象导入到目标文件夹），并以后台任务形式显示进度。
- 支持生成外部拖拽预览（委托给后端/`tauri-bridge` 的接口）与跨应用拖拽（`startDragToExternal`）。

**文件操作（复制/移动/重命名/删除）**:
- `handleCopyFiles`、`handleMoveFiles` 使用并发控制（`asyncPool`）与详尽的冲突/重复名处理策略，任务以 `useTasks` 展示并记录性能日志。
- 批量重命名（`handleBatchRename`）以任务形式运行并保证顺序。
- 删除支持撤销（`deletionTasks` 列表、`undoDelete` / `dismissDelete`）。

**持久化与设置**:
- `saveUserData` 包含对 Tauri 环境的异步检测（`detectTauriEnvironmentAsync`），并以防抖策略保存：根路径、标签、人物、专题、文件元数据与设置。
- `folderSettings` 支持记忆与自动应用，使用 `folderSettingsRef` 避免副作用循环。
- 退出/最小化逻辑使用 `exitActionRef` 以避免闭包过时问题，并支持"记住我的选择"。

**搜索与 AI 功能**:
- 增强的搜索：支持 `color:` 与 `palette:` 前缀的颜色/色板搜索（直接调用色彩数据库或后端），并在 `onPerformSearch` 中优先处理这些特殊查询。
- `performAiSearch` / `handleAIAnalysis` / `handleFolderAIAnalysis` 支持对单文件/文件夹进行 AI 分析（描述、标签、场景、对象识别、OCR、翻译），AI 任务也通过 `useTasks` 管理。

**人物与专题管理**:
- 人物管理（新增/重命名/设置头像/清除信息）与数据库同步（`dbUpsertPerson` / `dbDeletePerson`）。
- `personCounts` 通过扫描 `state.files` 计算并缓存，UI 使用 `peopleWithDisplayCounts` 提供显示相关计数和排序。

**Viewer 与导航**:
- 支持进入/退出查看器、前进/后退历史（`pushHistory` 使用全局时间戳 `__AURORA_NAV_TIMESTAMP__` 防止滚动冲突）、幻灯片播放配置与查看器内跳转（next/prev/random）。

**工具/辅助函数**:
- 常见内部工具：`throttle`、`asyncPool`、`showToast`、`async` 文件 I/O 协助与直接 DOM refs（`selectionRef`、`selectionBoxRef` 等）。

**小结/维护建议**:
- `App.tsx` 仍然很大（职责范围广），但最近按功能进行了模块化：把任务管理抽出到 `useTasks`，并持续将展示组件（`PersonGrid`、`FileGrid`）与逻辑（复制/移动、AI 分析）解耦。建议继续拆分导航/持久化/大文件操作逻辑到独立模块以便单元测试与可维护性提升。

---

#### `src/components/modals/` - 模态框组件集合
**位置**: `src/components/modals/`  
**功能**: 包含所有独立的业务逻辑模态框

| 文件 | 行数 | 功能 |
|------|------|------|
| `AddToPersonModal.tsx` | 180 行 | 添加文件到人物 |
| `AddToTopicModal.tsx` | 74 行 | 添加文件到专题 |
| `AIBatchRenameModal.tsx` | 376 行 | AI 批量重命名模态框 |
| `AlertModal.tsx` | 21 行 | 警告提示模态框 |
| `AutoGenerateTagsModal.tsx` | 410 行 | 自动生成标签模态框（基于 CLIP 嵌入） |
| `BatchRenameModal.tsx` | 57 行 | 批量重命名（带任务进度） |
| `ClearPersonModal.tsx` | 158 行 | 清除人物信息确认 |
| `ConfirmModal.tsx` | 26 行 | 通用确认对话框 |
| `CreateTopicModal.tsx` | 66 行 | 创建专题模态框 |
| `CropAvatarModal.tsx` | 356 行 | 头像裁剪模态框 |
| `ExitConfirmModal.tsx` | 37 行 | 退出确认对话框 |
| `FolderPickerModal.tsx` | 141 行 | 文件夹选择器 |
| `RenamePersonModal.tsx` | 29 行 | 重命名人物 |
| `RenameTagModal.tsx` | 27 行 | 重命名标签 |
| `RenameTopicModal.tsx` | 68 行 | 重命名专题 |
| `SmartAddToPersonModal.tsx` | 505 行 | 智能添加到人物（基于 WD14 角色标签） |
| `SmartCreatePersonModal.tsx` | 921 行 | 智能创建人物（基于 WD14 角色检测） |
| `SmartCreateTopicModal.tsx` | 691 行 | 智能创建专题（基于作品/角色关联） |
| `TagEditor.tsx` | 54 行 | 标签编辑器 |
| `UpdateModal.tsx` | 360 行 | 更新下载模态框 |
| `WelcomeModal.tsx` | 187 行 | 首次使用欢迎向导 |
| `AddImageModal.tsx` | 1163 行 | 添加图片到画布（图片对比功能） |

---

#### `src/components/AppModals.tsx` - 模态框集中渲染组件
**位置**: `src/components/AppModals.tsx`  
**行数**: 575 行  
**功能**: `AppModals.tsx` 作为应用内所有模态框的集中渲染入口，负责：
- 根据 `state.activeModal.type` 切换渲染不同的业务模态框（alert、add-to-person、add-to-topic、rename-tag、batch-rename、crop-avatar、exit-confirm、clear-person、copy/move 到文件夹的 FolderPicker 等）。
- 从 `src/components/modals/*` 和顶级 `SettingsModal` / `CloseConfirmationModal` / `WelcomeModal` 等导入具体模态组件并注入回调与数据。
- 提供统一的遮罩层和居中布局（overlay），并在关闭时通过 `setState` 清理 `activeModal`。

**关键 Props 概览**:
- `state: AppState`, `setState: Dispatch` - 访问与控制全局 modal 状态
- `t: (key: string) => string` - 国际化函数
- 各类处理函数（`handleCopyFiles`、`handleMoveFiles`、`handleRenamePerson`、`handleDeletePerson`、`handleSaveAvatarCrop` 等）用于将业务逻辑与模态交互连接
- `showWelcome`, `showCloseConfirmation`, `rememberExitChoice` 等 UI 控制参数

**实现要点**:
- 通过集中渲染减少 `App.tsx` 内部条件分支，使模态逻辑可独立维护与测试；
- 将确认/提示类模态（`ConfirmModal` / `AlertModal`）与功能性模态（`FolderPicker` / `CropAvatar`）统一在同一入口管理，便于统一样式与行为约束。

---

#### `src/hooks/useTasks.ts` - 任务管理 Hook
**位置**: `src/hooks/useTasks.ts`  
**行数**: 267 行  
**功能**: 集中管理后台任务状态
- `startTask`: 启动新任务 (copy/move/ai/color/thumbnail)
- `updateTask`: 更新任务进度 (带防抖)
- `useTasks`: 为组件提供任务状态和操作方法
- 监听 `color-extraction-progress` 事件并自动更新状态
- 支持任务暂停/恢复功能

---

#### `src/hooks/useNavigation.ts` - 导航管理 Hook
**位置**: `src/hooks/useNavigation.ts`  
**行数**: 235 行  
**功能**: 管理应用导航历史
- `navigateTo`: 导航到指定文件夹或视图
- `goBack`: 返回上一页
- `goForward`: 前进到下一页
- `pushHistory`: 添加历史记录
- 支持历史状态恢复（滚动位置、选中项等）

---

#### `src/components/useLayoutHook.ts` - 布局计算 Hook
**位置**: `src/components/useLayoutHook.ts`  
**行数**: 80 行  
**功能**: 使用 Web Worker 进行异步布局计算
- 支持 Grid、Masonry、Adaptive、List 四种布局模式
- 将布局计算卸载到 Worker 线程，避免阻塞主线程
- 自动响应容器大小变化和缩略图尺寸变化

---

#### `src/workers/layout.worker.ts` - 布局计算 Worker
**位置**: `src/workers/layout.worker.ts`  
**行数**: 286 行  
**功能**: 在 Worker 线程中执行布局计算
- Grid 布局：等宽等高的网格排列
- Masonry 布局：瀑布流布局，按最短列放置
- Adaptive 布局：自适应行高，保持图片比例
- List 布局：列表视图
- Tags Overview 布局：标签分组布局

---

#### 其他自定义 Hooks

| Hook | 位置 | 行数 | 功能 |
|------|------|------|------|
| `useAIAnalysis.ts` | `src/hooks/useAIAnalysis.ts` | 552 行 | AI 分析封装（描述、标签、场景识别、OCR、翻译） |
| `useAIRename.ts` | `src/hooks/useAIRename.ts` | 87 行 | AI 智能重命名 Hook |
| `useContextMenu.ts` | `src/hooks/useContextMenu.ts` | 80 行 | 右键菜单管理 |
| `useFileOperations.ts` | `src/hooks/useFileOperations.ts` | 1053 行 | 文件操作封装 |
| `useFileSearch.ts` | `src/hooks/useFileSearch.ts` | 172 行 | 搜索逻辑处理 |
| `useInView.ts` | `src/hooks/useInView.ts` | 30 行 | 视口检测 Hook |
| `useKeyboardShortcuts.ts` | `src/hooks/useKeyboardShortcuts.ts` | 69 行 | 键盘快捷键管理 |
| `useMarqueeSelection.ts` | `src/hooks/useMarqueeSelection.ts` | 162 行 | 框选状态管理 |
| `useToasts.ts` | `src/hooks/useToasts.ts` | 37 行 | Toast 通知管理 |
| `useUpdateCheck.ts` | `src/hooks/useUpdateCheck.ts` | 272 行 | 更新检查 Hook |

---

#### `PersonGrid.tsx` - 人物网格组件
**位置**: `src/components/PersonGrid.tsx`  
**行数**: 440 行  
**功能**: 专门的人物展示和管理组件，从 FileGrid 中分离出来

**主要功能**:
- 人物头像显示（支持人脸裁剪定位）
- 人物选择和交互
- 响应式网格布局
- 右键菜单支持

**Props 接口**:
```typescript
interface PersonGridProps {
  people: Record<string, Person>;
  files: Record<string, FileNode>;
  selectedPersonIds: string[];
  onPersonClick: (id: string, e: React.MouseEvent) => void;
  onPersonDoubleClick: (id: string) => void;
  onStartRenamePerson?: (id: string) => void;
  onPersonContextMenu: (e: React.MouseEvent, id: string) => void;
  t: (key: string) => string;
}
```

---

#### `FileGrid.tsx` - 文件网格组件
**位置**: `src/components/FileGrid.tsx`  
**行数**: 1414 行  
**功能**: 文件和文件夹的网格显示组件

**主要更新**:
- 移除了人物相关的显示逻辑（已分离到 PersonGrid）
- 专注于文件/文件夹的展示和管理
- 支持虚拟滚动优化性能
- 集成布局计算 Hook

---

#### `SettingsModal.tsx` - 设置模态框组件
**位置**: `src/components/SettingsModal.tsx`  
**行数**: 3774 行  
**功能**: 系统设置界面

**AI 设置增强**:
```typescript
// 系统提示预设功能
interface PromptPreset {
  id: string;
  name: string;
  content: string;
}

// 支持创建、编辑、删除和管理预设
- 预设选择下拉框
- 保存当前提示为预设
- 另存为新预设
- 删除预设
```

---

#### 其他 UI 组件

| 组件 | 位置 | 行数 | 功能 |
|------|------|------|------|
| `ColorPickerPopover.tsx` | `src/components/ColorPickerPopover.tsx` | 316 行 | HSV 颜色选择器，支持预设和吸管工具 |
| `ImageViewer.tsx` | `src/components/ImageViewer.tsx` | 1482 行 | 全屏图片查看，支持缩放、旋转、元数据显示 |
| `MetadataPanel.tsx` | `src/components/MetadataPanel.tsx` | 2409 行 | 显示文件元数据、AI 分析结果、标签管理 |
| `TreeSidebar.tsx` | `src/components/TreeSidebar.tsx` | 1518 行 | 文件夹树导航，支持展开/折叠 |
| `TopBar.tsx` | `src/components/TopBar.tsx` | 1141 行 | 搜索栏、视图切换、操作按钮 |
| `TabBar.tsx` | `src/components/TabBar.tsx` | 456 行 | 多标签页管理，支持关闭、拖拽排序 |
| `TopicModule.tsx` | `src/components/TopicModule.tsx` | 2485 行 | 专题画廊和详情视图 |
| `TaskProgressModal.tsx` | `src/components/TaskProgressModal.tsx` | 78 行 | 任务进度显示模态框 |
| `CloseConfirmationModal.tsx` | `src/components/CloseConfirmationModal.tsx` | 64 行 | 关闭确认对话框 |
| `DragDropOverlay.tsx` | `src/components/DragDropOverlay.tsx` | 126 行 | 拖拽覆盖层 |
| `SplashScreen.tsx` | `src/components/SplashScreen.tsx` | 165 行 | 启动画面 |
| `Logo.tsx` | `src/components/Logo.tsx` | 61 行 | Logo 组件 |
| `FolderIcon.tsx` | `src/components/FolderIcon.tsx` | 356 行 | 文件夹图标 |
| `ContextMenu.tsx` | `src/components/ContextMenu.tsx` | 496 行 | 右键上下文菜单组件 |
| `ToastItem.tsx` | `src/components/ToastItem.tsx` | 33 行 | 通知/吐司项组件 |
| `ImageComparer.tsx` | `src/components/ImageComparer.tsx` | 2039 行 | 图片对比组件 |
| `ImageThumbnail.tsx` | `src/components/ImageThumbnail.tsx` | 138 行 | 图片缩略图组件 |
| `FileListItem.tsx` | `src/components/FileListItem.tsx` | 405 行 | 文件列表项组件 |
| `TagsList.tsx` | `src/components/TagsList.tsx` | 312 行 | 标签列表组件 |
| `GlobalToasts.tsx` | `src/components/GlobalToasts.tsx` | 31 行 | 全局 Toast 容器 |
| `EmptyFolderPlaceholder.tsx` | `src/components/EmptyFolderPlaceholder.tsx` | 29 行 | 空文件夹占位符 |
| `InlineRenameInput.tsx` | `src/components/InlineRenameInput.tsx` | 39 行 | 内联重命名输入框 |
| `Folder3DIcon.tsx` | `src/components/Folder3DIcon.tsx` | 81 行 | 3D 文件夹图标 |
| `FolderThumbnail.tsx` | `src/components/FolderThumbnail.tsx` | 123 行 | 文件夹缩略图 |
| `AIRenameButton.tsx` | `src/components/AIRenameButton.tsx` | 36 行 | AI 重命名按钮组件 |
| `AIRenamePreview.tsx` | `src/components/AIRenamePreview.tsx` | 38 行 | AI 重命名预览组件 |
| `PeopleCanvas.tsx` | `src/components/PeopleCanvas.tsx` | 342 行 | 人物画布组件 |
| `LanSharePanel.tsx` | `src/components/settings/LanSharePanel.tsx` | 346 行 | 局域网共享设置面板 |

#### 图片对比组件 (`src/components/comparer/`)

| 组件 | 行数 | 功能 |
|------|------|------|
| `AnnotationLayer.tsx` | 272 行 | 标注图层组件 |
| `ComparerContextMenu.tsx` | 134 行 | 对比视图右键菜单 |
| `EditOverlay.tsx` | 474 行 | 编辑覆盖层 |
| `types.ts` | 60 行 | 对比组件类型定义 |

---

### 3. 服务层 (`src/services/`)

#### `aiService.ts` - AI 服务
**位置**: `src/services/aiService.ts`  
**行数**: 624 行  
**功能**: OpenAI/Ollama/LM Studio 集成

**更新**: AI 分析优化
- dominantColors 不再通过 AI 分析（性能优化）
- 专注于描述、标签、场景分类、对象识别、OCR、翻译
- 支持自定义系统提示词和预设

#### `faceRecognitionService.ts` - 人脸识别服务
**位置**: `src/services/faceRecognitionService.ts`  
**行数**: 63 行  
**功能**: 基于 face-api.js 的人脸识别

---

### 4. 工具函数库 (`src/utils/`)

| 文件 | 行数 | 功能 |
|------|------|------|
| `async.ts` | 19 行 | 异步工具与文件 I/O 包装 |
| `debounce.ts` | 63 行 | 防抖函数（搜索/输入节流） |
| `environment.ts` | 57 行 | 环境检测与 Feature flags |
| `logger.ts` | 208 行 | 结构化前端日志封装 |
| `mockFileSystem.ts` | 300 行 | 开发/测试用模拟 FS |
| `performanceMonitor.ts` | 445 行 | 性能计时与采样工具 |
| `textUtils.ts` | 42 行 | 文本处理与规范化函数 |
| `translations.ts` | 1701 行 | 国际化文案（多语言） |
| `thumbnailCache.ts` | 65 行 | 缩略图缓存管理 |
| `modelDownloadState.ts` | 312 行 | 模型下载状态管理 |

---

### 5. 类型定义 (`src/types.ts`)
**位置**: `src/types.ts`  
**行数**: 699 行  

**主要类型**:
```typescript
export interface FileNode { 
  id: string
  parentId: string | null
  name: string
  type: FileType
  path: string
  size?: number
  children?: string[]
  category?: 'general' | 'book' | 'sequence'
  author?: string
  url?: string
  previewUrl?: string
  tags: string[]
  description?: string
  sourceUrl?: string
  meta?: ImageMeta
  aiData?: AiData
  createdAt?: string
  updatedAt?: string
  lastRefresh?: number
  isRefreshing?: boolean
}

export interface Person {
  id: string
  name: string
  coverFileId: string
  count: number
  description?: string
  descriptor?: number[]  // 人脸特征向量
  faceBox?: { x: number; y: number; w: number; h: number }
  characterTagName?: string   // 关联的角色标签名称（WD14）
  characterTagIndex?: number  // 关联的角色标签索引
}

export interface AiData {
  analyzed: boolean
  analyzedAt: string
  description: string
  tags: string[]
  faces: AiFace[]
  sceneCategory: string
  confidence: number
  dominantColors: string[]
  objects: string[]
  extractedText?: string
  translatedText?: string
}

export interface DominantColor {
  hex: string
  rgb: [number, number, number]
  isDark: boolean
}

export interface ClipSettings {
  enabled: boolean
  modelName: ClipModelName
  useGpu: boolean
  downloadStatus: ClipDownloadStatus
  downloadProgress: number
  downloadError?: string
  modelVersion: string
  downloadedAt?: number
  minScore: number
  maxResults: number
  unlimitedResults: boolean
  autoAddTags: boolean
  tagThreshold: number
}

export interface AppState { 
  // ... 完整状态定义
}

// ... 更多类型定义
```

---

### 6. 常量定义 (`src/constants.ts`)
**位置**: `src/constants.ts`  
**行数**: 29 行  
**功能**: 应用常量定义

```typescript
export const DUMMY_TAB: TabState = { ... }
export const DEFAULT_LAYOUT_SETTINGS = { ... }
```

---

### 7. 应用入口 (`src/main.tsx`)
**位置**: `src/main.tsx`  
**行数**: 34 行  
**功能**: React 应用挂载点

---

### 8. 其他 Workers

| Worker | 位置 | 行数 | 功能 |
|--------|------|------|------|
| `search.worker.ts` | `src/workers/search.worker.ts` | 108 行 | 搜索计算 Worker |

---

### 9. 局域网共享模块 (`src/lan-share/`)

**位置**: `src/lan-share/`  
**功能**: 独立的局域网共享客户端应用

| 文件 | 行数 | 功能 |
|------|------|------|
| `LanShareApp.tsx` | 299 行 | 局域网共享主应用组件 |
| `api.ts` | 149 行 | 局域网共享 API 封装 |
| `main.tsx` | 9 行 | 应用入口 |
| `lan-share.css` | - | 样式文件 |
| `index.html` | - | HTML 入口 |

**子组件** (`src/lan-share/components/`):

| 组件 | 行数 | 功能 |
|------|------|------|
| `AuthScreen.tsx` | 127 行 | 认证登录界面 |
| `BrowseScreen.tsx` | 243 行 | 文件浏览界面 |
| `ImageViewer.tsx` | 70 行 | 图片查看器 |

---

### 10. 共享模块 (`src/shared/`)

**位置**: `src/shared/`  
**功能**: 在主应用和局域网共享客户端之间共享的组件、Hooks 和工具

**API 层** (`src/shared/api/`):

| 文件 | 行数 | 功能 |
|------|------|------|
| `types.ts` | 64 行 | 共享 API 类型定义 |
| `index.ts` | 2 行 | 导出入口 |
| `adapters/HttpAdapter.ts` | 67 行 | HTTP 适配器（用于 LAN Share） |
| `adapters/TauriAdapter.ts` | 67 行 | Tauri 适配器（用于主应用） |

**共享组件** (`src/shared/components/`):

| 组件 | 行数 | 功能 |
|------|------|------|
| `Grid/FileCard.tsx` | 91 行 | 文件卡片组件 |
| `Grid/FileGrid.tsx` | 155 行 | 文件网格组件 |
| `Grid/LayoutSwitcher.tsx` | 73 行 | 布局切换器 |
| `ImageViewer/ImageViewerCore.tsx` | 430 行 | 图片查看器核心 |
| `ImageViewer/ImageViewerControls.tsx` | 279 行 | 图片查看器控制栏 |
| `ImageViewer/SlideshowManager.tsx` | 104 行 | 幻灯片管理 |
| `Thumbnails/Folder3DIcon.tsx` | 103 行 | 3D 文件夹图标 |
| `Thumbnails/FolderThumbnail.tsx` | 62 行 | 文件夹缩略图 |
| `Thumbnails/ImageThumbnail.tsx` | 83 行 | 图片缩略图 |
| `TopBar/TopBar.tsx` | 92 行 | 顶部栏 |
| `TopBar/SearchInput.tsx` | 128 行 | 搜索输入框 |
| `TopBar/SortControls.tsx` | 83 行 | 排序控制 |
| `TopBar/NavigationButtons.tsx` | 61 行 | 导航按钮 |
| `UI/BreadcrumbNav.tsx` | 52 行 | 面包屑导航 |
| `UI/EmptyPlaceholder.tsx` | 28 行 | 空占位符 |
| `UI/LoadingSpinner.tsx` | 28 行 | 加载动画 |

**共享 Hooks** (`src/shared/hooks/`):

| Hook | 行数 | 功能 |
|------|------|------|
| `useImageTransform.ts` | 384 行 | 图片变换（缩放、旋转、拖拽） |
| `useLayout.ts` | 161 行 | 布局计算 |
| `useSlideshow.ts` | 161 行 | 幻灯片播放 |
| `useVirtualScroll.ts` | 42 行 | 虚拟滚动 |
| `useInView.ts` | 30 行 | 视口检测 |

**共享工具** (`src/shared/utils/`):

| 文件 | 行数 | 功能 |
|------|------|------|
| `cache.ts` | 44 行 | 缓存工具 |
| `debounce.ts` | 47 行 | 防抖函数 |

**共享类型** (`src/shared/types/`):

| 文件 | 行数 | 功能 |
|------|------|------|
| `file.ts` | 30 行 | 文件类型定义 |
| `image.ts` | 22 行 | 图片类型定义 |

---

## 后端模块分布 (src-tauri/)

### 1. 主程序 (`src-tauri/src/main.rs`)
**位置**: `src-tauri/src/main.rs`  
**行数**: 359 行  
**功能**: Tauri 应用入口，命令处理器

**主要功能**:
- 应用程序初始化
- 命令注册（文件系统、数据库、窗口管理、局域网共享等）
- 系统托盘集成
- 全局快捷键
- 后台任务管理（颜色提取 Worker）

---

### 2. 颜色相关模块

#### `color_db.rs` - 颜色数据库
**位置**: `src-tauri/src/color_db.rs`  
**行数**: 1124 行  
**功能**: 颜色数据存储和管理
- 颜色索引表管理
- 颜色搜索功能
- 批量颜色保存
- WAL 检查点管理

#### `color_extractor.rs` - 颜色提取算法
**位置**: `src-tauri/src/color_extractor.rs`  
**行数**: 239 行  
**功能**: 图像颜色分析算法
- 主色调提取
- LAB 颜色空间转换
- 颜色相似度计算

#### `color_search.rs` - 颜色搜索
**位置**: `src-tauri/src/color_search.rs`  
**行数**: 422 行  
**功能**: 颜色搜索算法
- 按颜色搜索图片
- 按调色板搜索图片
- 颜色相似度匹配

#### `color_worker.rs` - 颜色处理工作器
**位置**: `src-tauri/src/color_worker.rs`  
**行数**: 797 行  
**功能**: 后台颜色提取任务处理
- 批量颜色提取
- 进度事件发送
- 暂停/恢复控制

#### `color_commands.rs` - 颜色命令
**位置**: `src-tauri/src/color_commands.rs`  
**行数**: 93 行  
**功能**: 颜色相关的 Tauri 命令
- 暂停/恢复颜色提取
- 重试失败的颜色提取

---

### 3. CLIP 向量搜索模块 (`src-tauri/src/clip/`)

#### `clip_commands.rs` - CLIP 命令处理
**位置**: `src-tauri/src/clip_commands.rs`  
**行数**: 2155 行  
**功能**: CLIP 相关的 Tauri 命令
- `clip_search_by_text` - 文本搜索图片
- `clip_search_by_image` - 以图搜图
- `clip_generate_embedding` - 生成嵌入向量
- `clip_generate_embeddings_batch` - 批量生成嵌入
- `clip_load_model` / `clip_unload_model` - 模型加载/卸载
- `clip_get_character_tags` - 获取角色标签
- `clip_get_detected_characters` - 获取检测到的角色
- `clip_get_work_topics` - 获取作品专题信息
- `clip_create_work_topics` - 创建作品专题
- `clip_preview_tags_from_embeddings` - 预览标签生成
- `clip_generate_tags_from_embeddings` - 从嵌入生成标签

#### `mod.rs` - CLIP 模块入口
**位置**: `src-tauri/src/clip/mod.rs`  
**行数**: 206 行  
**功能**: CLIP 模块初始化和管理
- CLIP Manager 全局状态
- 模型切换和根目录切换

#### `model.rs` - CLIP 模型接口
**位置**: `src-tauri/src/clip/model.rs`  
**行数**: 1099 行  
**功能**: CLIP 模型抽象接口
- 模型加载和推理
- GPU 加速支持
- 标签翻译器

#### `embedding.rs` - 嵌入向量存储
**位置**: `src-tauri/src/clip/embedding.rs`  
**行数**: 397 行  
**功能**: 嵌入向量数据库操作
- 嵌入向量存储和检索
- 相似度搜索
- 模型版本管理

#### `search.rs` - 向量搜索
**位置**: `src-tauri/src/clip/search.rs`  
**行数**: 451 行  
**功能**: 向量相似度搜索
- 余弦相似度计算
- Top-K 搜索

#### `preprocessor.rs` - 图像预处理
**位置**: `src-tauri/src/clip/preprocessor.rs`  
**行数**: 272 行  
**功能**: 图像预处理
- 图像缩放和归一化
- 张量转换

#### `models/` - 模型实现
| 文件 | 行数 | 功能 |
|------|------|------|
| `mod.rs` | 197 行 | 模型规范定义 |
| `siglip2_base.rs` | 140 行 | SigLIP2-Base 模型 |
| `siglip2.rs` | 164 行 | SigLIP2-So400M 模型 |
| `wd14.rs` | 68 行 | WD-EVA02-Large-Tagger-V3 模型 |

---

### 4. 缩略图模块 (`src-tauri/src/thumbnail.rs`)
**位置**: `src-tauri/src/thumbnail.rs`  
**行数**: 479 行  
**功能**: 缩略图生成和管理

**主要功能**:
- 单文件缩略图生成 (`get_thumbnail`)
- 批量缩略图生成 (`get_thumbnails_batch`)
- JXL 格式支持（使用 jxl-oxide）
- AVIF 格式降级处理
- 远程缩略图保存 (`save_remote_thumbnail`)
- 拖拽预览生成 (`generate_drag_preview`)
- 智能格式选择（JPEG/WebP）

---

### 5. 数据库模块 (`src-tauri/src/db/`)

#### `mod.rs` - 数据库模块入口
**位置**: `src-tauri/src/db/mod.rs`  
**行数**: 132 行  
**功能**:
- 管理数据库连接池 (`AppDbPool`)
- 执行数据库初始化
- 创建 `persons`、`file_metadata`、`file_index` 表

#### `persons.rs` - 人物数据库操作
**位置**: `src-tauri/src/db/persons.rs`  
**行数**: 118 行  
**功能**: 人物数据的 CRUD 操作
- 支持角色标签关联 (`character_tag_name`, `character_tag_index`)

#### `file_metadata.rs` - 文件元数据存储
**位置**: `src-tauri/src/db/file_metadata.rs`  
**行数**: 214 行  
**功能**:
- 图片标签、描述、来源 URL 持久化
- AI 数据（JSON）存储
- `upsert_file_metadata`、`get_metadata_by_id` 等

#### `file_index.rs` - 文件索引数据库
**位置**: `src-tauri/src/db/file_index.rs`  
**行数**: 526 行  
**功能**:
- 文件索引表管理
- 文件路径到 ID 的映射
- 支持数据库切换
- 批量索引操作

#### `topics.rs` - 专题数据库操作
**位置**: `src-tauri/src/db/topics.rs`  
**行数**: 233 行  
**功能**:
- 专题数据的 CRUD 操作
- 专题层级结构管理（parent_id 支持嵌套）
- 封面裁剪数据存储（cover_crop）
- 人物关联（people_ids）和文件关联（file_ids）
- 专题类型字段（topic_type）

**数据结构**:
```rust
pub struct Topic {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub topic_type: Option<String>,  // 在 TypeScript 中映射为 type
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

### 6. 其他后端模块

#### `db_commands.rs` - 数据库命令
**位置**: `src-tauri/src/db_commands.rs`  
**行数**: 221 行  
**功能**: 数据库相关的 Tauri 命令
- 用户数据保存/加载
- 人物/专题 CRUD
- 颜色数据库统计

#### `system_commands.rs` - 系统命令
**位置**: `src-tauri/src/system_commands.rs`  
**行数**: 226 行  
**功能**: 系统相关命令
- 默认路径获取
- 外部链接打开
- HTTP 代理请求

#### `window_commands.rs` - 窗口命令
**位置**: `src-tauri/src/window_commands.rs`  
**行数**: 87 行  
**功能**: 窗口管理命令
- 窗口显示/隐藏
- 窗口状态保存

#### `update_commands.rs` - 更新命令
**位置**: `src-tauri/src/update_commands.rs`  
**行数**: 51 行  
**功能**: 应用更新相关命令
- 检查更新
- 下载更新
- 安装更新

#### `updater.rs` - 更新器
**位置**: `src-tauri/src/updater.rs`  
**行数**: 749 行  
**功能**: 更新逻辑实现

#### `update_downloader.rs` - 更新下载器
**位置**: `src-tauri/src/update_downloader.rs`  
**行数**: 499 行  
**功能**: 更新下载实现

#### `scanner.rs` - 文件扫描器
**位置**: `src-tauri/src/scanner.rs`  
**行数**: 547 行  
**功能**: 文件系统扫描

#### `file_operations.rs` - 文件操作
**位置**: `src-tauri/src/file_operations.rs`  
**行数**: 763 行  
**功能**: 文件操作命令

#### `image_utils.rs` - 图像工具
**位置**: `src-tauri/src/image_utils.rs`  
**行数**: 137 行  
**功能**: 图像处理工具

#### `file_types.rs` - 文件类型
**位置**: `src-tauri/src/file_types.rs`  
**行数**: 62 行  
**功能**: 文件类型定义

---

### 7. 局域网共享模块 (`src-tauri/src/lan_share/`)

**位置**: `src-tauri/src/lan_share/`  
**功能**: 局域网图片共享服务器

| 文件 | 行数 | 功能 |
|------|------|------|
| `mod.rs` | 9 行 | 模块入口 |
| `server.rs` | 293 行 | HTTP 服务器实现 |
| `handlers.rs` | 903 行 | 请求处理器（认证、浏览、缩略图等） |
| `session.rs` | 105 行 | 会话管理（Token、过期时间） |
| `device_manager.rs` | 74 行 | 连接设备管理 |
| `types.rs` | 129 行 | 类型定义 |

**主要功能**:
- HTTP 服务器（端口可配置）
- Token 认证机制
- 文件浏览和缩略图服务
- 设备连接状态管理

#### `lan_share_commands.rs` - 局域网共享命令
**位置**: `src-tauri/src/lan_share_commands.rs`  
**行数**: 164 行  
**功能**: 局域网共享相关的 Tauri 命令
- `lan_share_start` - 启动共享服务
- `lan_share_stop` - 停止共享服务
- `lan_share_get_status` - 获取服务状态
- `lan_share_get_devices` - 获取连接设备
- `lan_share_get_local_ip` - 获取本地 IP
- `lan_share_check_port` - 检查端口可用性
- `lan_share_update_config` - 更新配置

---

### 8. 作品提取器 (`src-tauri/src/work_extractor.rs`)

**位置**: `src-tauri/src/work_extractor.rs`  
**行数**: 199 行  
**功能**: 从 WD14 标签中提取作品/角色信息

**主要功能**:
- 从角色标签中提取作品名称和角色名称
- 支持中文名称映射（series_names.json）
- 生成作品专题信息
- 自动创建作品相关的人物和专题

---

### 9. 工具模块

#### `dump_persons.rs` - 人物数据导出工具
**位置**: `src-tauri/src/bin/dump_persons.rs`  
**行数**: 35 行  
**功能**: 导出人物数据到文件

---

## 依赖关系图

```
App.tsx (4362 行)
├── components/
│   ├── modals/ (22 个模态框)
│   │   ├── AddImageModal.tsx (1163 行)
│   │   ├── AddToPersonModal.tsx (180 行)
│   │   ├── AddToTopicModal.tsx (74 行)
│   │   ├── AIBatchRenameModal.tsx (376 行)
│   │   ├── AlertModal.tsx (21 行)
│   │   ├── AutoGenerateTagsModal.tsx (410 行)
│   │   ├── BatchRenameModal.tsx (57 行)
│   │   ├── ClearPersonModal.tsx (158 行)
│   │   ├── ConfirmModal.tsx (26 行)
│   │   ├── CreateTopicModal.tsx (66 行)
│   │   ├── CropAvatarModal.tsx (356 行)
│   │   ├── ExitConfirmModal.tsx (37 行)
│   │   ├── FolderPickerModal.tsx (141 行)
│   │   ├── RenamePersonModal.tsx (29 行)
│   │   ├── RenameTagModal.tsx (27 行)
│   │   ├── RenameTopicModal.tsx (68 行)
│   │   ├── SmartAddToPersonModal.tsx (505 行)
│   │   ├── SmartCreatePersonModal.tsx (921 行)
│   │   ├── SmartCreateTopicModal.tsx (691 行)
│   │   ├── TagEditor.tsx (54 行)
│   │   ├── UpdateModal.tsx (360 行)
│   │   └── WelcomeModal.tsx (187 行)
│   ├── comparer/ (3 个组件)
│   │   ├── AnnotationLayer.tsx (272 行)
│   │   ├── ComparerContextMenu.tsx (134 行)
│   │   ├── EditOverlay.tsx (474 行)
│   │   └── types.ts (60 行)
│   ├── settings/
│   │   └── LanSharePanel.tsx (346 行)
│   ├── AppModals.tsx (575 行)
│   ├── PersonGrid.tsx (440 行)
│   ├── PeopleCanvas.tsx (342 行)
│   ├── FileGrid.tsx (1414 行)
│   ├── SettingsModal.tsx (3774 行)
│   ├── ImageViewer.tsx (1482 行)
│   ├── MetadataPanel.tsx (2409 行)
│   ├── TreeSidebar.tsx (1518 行)
│   ├── TopBar.tsx (1141 行)
│   ├── TabBar.tsx (456 行)
│   ├── TopicModule.tsx (2485 行)
│   ├── TaskProgressModal.tsx (78 行)
│   ├── ImageComparer.tsx (2039 行)
│   └── useLayoutHook.ts (80 行)
├── hooks/
│   ├── useTasks.ts (267 行)
│   ├── useNavigation.ts (235 行)
│   ├── useAIAnalysis.ts (552 行)
│   ├── useAIRename.ts (87 行)
│   ├── useContextMenu.ts (80 行)
│   ├── useFileOperations.ts (1053 行)
│   ├── useFileSearch.ts (172 行)
│   ├── useInView.ts (30 行)
│   ├── useKeyboardShortcuts.ts (69 行)
│   ├── useMarqueeSelection.ts (162 行)
│   ├── useToasts.ts (37 行)
│   └── useUpdateCheck.ts (272 行)
├── services/
│   ├── aiService.ts (624 行)
│   └── faceRecognitionService.ts (63 行)
├── api/
│   └── tauri-bridge.ts (2151 行)
├── lan-share/ (局域网共享客户端)
│   ├── LanShareApp.tsx (299 行)
│   ├── api.ts (149 行)
│   └── components/
│       ├── AuthScreen.tsx (127 行)
│       ├── BrowseScreen.tsx (243 行)
│       └── ImageViewer.tsx (70 行)
├── shared/ (共享模块)
│   ├── api/
│   │   ├── types.ts (64 行)
│   │   └── adapters/
│   │       ├── HttpAdapter.ts (67 行)
│   │       └── TauriAdapter.ts (67 行)
│   ├── components/
│   │   ├── Grid/ (FileCard, FileGrid, LayoutSwitcher)
│   │   ├── ImageViewer/ (ImageViewerCore, ImageViewerControls, SlideshowManager)
│   │   ├── Thumbnails/ (Folder3DIcon, FolderThumbnail, ImageThumbnail)
│   │   ├── TopBar/ (TopBar, SearchInput, SortControls, NavigationButtons)
│   │   └── UI/ (BreadcrumbNav, EmptyPlaceholder, LoadingSpinner)
│   ├── hooks/
│   │   ├── useImageTransform.ts (384 行)
│   │   ├── useLayout.ts (161 行)
│   │   ├── useSlideshow.ts (161 行)
│   │   ├── useVirtualScroll.ts (42 行)
│   │   └── useInView.ts (30 行)
│   ├── utils/ (cache, debounce)
│   └── types/ (file, image)
├── workers/
│   ├── layout.worker.ts (286 行)
│   └── search.worker.ts (108 行)
├── utils/
│   ├── async.ts (19 行)
│   ├── debounce.ts (63 行)
│   ├── environment.ts (57 行)
│   ├── logger.ts (208 行)
│   ├── mockFileSystem.ts (300 行)
│   ├── performanceMonitor.ts (445 行)
│   ├── textUtils.ts (42 行)
│   ├── translations.ts (1701 行)
│   ├── thumbnailCache.ts (65 行)
│   └── modelDownloadState.ts (312 行)
├── types.ts (699 行)
└── constants.ts (29 行)

Rust Backend
├── main.rs (359 行)
├── clip_commands.rs (2155 行)
├── lan_share_commands.rs (164 行)
├── color_commands.rs (93 行)
├── thumbnail.rs (479 行)
├── color_db.rs (1124 行)
├── color_extractor.rs (239 行)
├── color_search.rs (422 行)
├── color_worker.rs (797 行)
├── db_commands.rs (221 行)
├── system_commands.rs (226 行)
├── window_commands.rs (87 行)
├── update_commands.rs (51 行)
├── updater.rs (749 行)
├── update_downloader.rs (499 行)
├── scanner.rs (547 行)
├── file_operations.rs (763 行)
├── image_utils.rs (137 行)
├── file_types.rs (62 行)
├── work_extractor.rs (199 行)
├── clip/
│   ├── mod.rs (206 行)
│   ├── model.rs (1099 行)
│   ├── embedding.rs (397 行)
│   ├── search.rs (451 行)
│   ├── preprocessor.rs (272 行)
│   └── models/
│       ├── mod.rs (197 行)
│       ├── siglip2_base.rs (140 行)
│       ├── siglip2.rs (164 行)
│       └── wd14.rs (68 行)
├── lan_share/
│   ├── mod.rs (9 行)
│   ├── server.rs (293 行)
│   ├── handlers.rs (903 行)
│   ├── session.rs (105 行)
│   ├── device_manager.rs (74 行)
│   └── types.rs (129 行)
└── db/
    ├── mod.rs (132 行)
    ├── persons.rs (118 行)
    ├── file_metadata.rs (214 行)
    ├── file_index.rs (526 行)
    └── topics.rs (233 行)

Tools
└── bin/
    └── dump_persons.rs (35 行)
```

---

## 模块复杂度分析

### 高复杂度模块 (需要关注)
1. **SettingsModal.tsx** (3774 行) - 设置界面功能丰富，包含 CLIP、AI、局域网共享等配置
2. **clip_commands.rs** (2155 行) - CLIP 命令处理，嵌入向量生成、作品提取逻辑复杂
3. **App.tsx** (4362 行) - 主应用组件，状态管理复杂
4. **ImageComparer.tsx** (2039 行) - 图片对比组件功能复杂
5. **TopicModule.tsx** (2485 行) - 专题管理功能丰富
6. **MetadataPanel.tsx** (2409 行) - 元数据面板功能丰富
7. **handlers.rs** (903 行) - 局域网共享请求处理器
8. **tauri-bridge.ts** (2151 行) - API 桥接层，包含 CLIP、更新、颜色数据库等 API
9. **color_db.rs** (1124 行) - 颜色数据库操作复杂
10. **model.rs** (1099 行) - CLIP 模型接口复杂

### 中等复杂度模块
1. **ImageViewer.tsx** (1482 行) - 图片查看器功能完整
2. **FileGrid.tsx** (1414 行) - 文件显示逻辑复杂
3. **useFileOperations.ts** (1053 行) - 文件操作逻辑复杂
4. **SmartCreatePersonModal.tsx** (921 行) - 智能创建人物模态框
5. **color_worker.rs** (797 行) - 后台处理逻辑复杂
6. **file_operations.rs** (763 行) - 文件操作命令
7. **updater.rs** (749 行) - 更新逻辑
8. **aiService.ts** (624 行) - AI 分析逻辑复杂
9. **useAIAnalysis.ts** (552 行) - AI 分析 Hook
10. **SmartCreateTopicModal.tsx** (691 行) - 智能创建专题模态框
11. **translations.ts** (1701 行) - 国际化文案

### 低复杂度模块
1. **PersonGrid.tsx** (440 行) - 专用组件，职责单一
2. **useLayoutHook.ts** (80 行) - 布局计算 Hook
3. **constants.ts** (29 行) - 常量定义
4. **工具函数** - 各司其职，逻辑简单

---

## 架构改进建议

1. **组件拆分**: App.tsx 过大，建议进一步拆分为更小的功能组件（如导航逻辑、文件操作逻辑）
2. **状态管理**: 考虑引入 Zustand 或 Redux 进行更精细的状态管理
3. **API 分层**: tauri-bridge.ts 可以按功能进一步拆分（文件操作、数据库操作、窗口管理等）
4. **测试覆盖**: 为关键模块添加单元测试和集成测试
5. **类型安全**: 完善 TypeScript 类型定义，提高代码可维护性
6. **Worker 扩展**: 考虑将更多计算密集型任务（如 AI 分析预处理）移到 Worker

---

**文档版本**: 1.6  
**更新日期**: 2026-03-14  
**覆盖范围**: 所有前端和后端模块（含局域网共享模块）  
**详细程度**: 高
