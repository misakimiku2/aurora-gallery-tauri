# Aurora Gallery Tauri 模块分布详解

## 前端模块分布 (src/)

### 1. API 桥接层 (`src/api/`)

#### `tauri-bridge.ts` - 核心桥接模块
**位置**: `src/api/tauri-bridge.ts`  
**行数**: 1283 行  
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
export async function dbCopyFileMetadata(srcPath: string, destPath: string): Promise<void>
export async function switchRootDatabase(newRootPath: string): Promise<void>
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
**行数**: 4248 行  

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
| `AddToPersonModal.tsx` | 74 行 | 添加文件到人物 |
| `AddToTopicModal.tsx` | 81 行 | 添加文件到专题 |
| `AIBatchRenameModal.tsx` | 381 行 | AI 批量重命名模态框 |
| `AlertModal.tsx` | 23 行 | 警告提示模态框 |
| `BatchRenameModal.tsx` | 56 行 | 批量重命名（带任务进度） |
| `ClearPersonModal.tsx` | 101 行 | 清除人物信息确认 |
| `ConfirmModal.tsx` | 28 行 | 通用确认对话框 |
| `CreateTopicModal.tsx` | 72 行 | 创建专题模态框 |
| `CropAvatarModal.tsx` | 401 行 | 头像裁剪模态框 |
| `ExitConfirmModal.tsx` | 41 行 | 退出确认对话框 |
| `FolderPickerModal.tsx` | 161 行 | 文件夹选择器 |
| `RenamePersonModal.tsx` | 30 行 | 重命名人物 |
| `RenameTagModal.tsx` | 29 行 | 重命名标签 |
| `RenameTopicModal.tsx` | 74 行 | 重命名专题 |
| `TagEditor.tsx` | 56 行 | 标签编辑器 |
| `WelcomeModal.tsx` | 200 行 | 首次使用欢迎向导 |
| `AddImageModal.tsx` | 1238 行 | 添加图片到画布（图片对比功能） |

---

#### `src/components/AppModals.tsx` - 模态框集中渲染组件
**位置**: `src/components/AppModals.tsx`  
**行数**: 424 行  
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
**行数**: 317 行  
**功能**: 集中管理后台任务状态
- `startTask`: 启动新任务 (copy/move/ai/color/thumbnail)
- `updateTask`: 更新任务进度 (带防抖)
- `useTasks`: 为组件提供任务状态和操作方法
- 监听 `color-extraction-progress` 事件并自动更新状态
- 支持任务暂停/恢复功能

---

#### `src/hooks/useNavigation.ts` - 导航管理 Hook
**位置**: `src/hooks/useNavigation.ts`  
**行数**: 260 行  
**功能**: 管理应用导航历史
- `navigateTo`: 导航到指定文件夹或视图
- `goBack`: 返回上一页
- `goForward`: 前进到下一页
- `pushHistory`: 添加历史记录
- 支持历史状态恢复（滚动位置、选中项等）

---

#### `src/components/useLayoutHook.ts` - 布局计算 Hook
**位置**: `src/components/useLayoutHook.ts`  
**行数**: 79 行  
**功能**: 使用 Web Worker 进行异步布局计算
- 支持 Grid、Masonry、Adaptive、List 四种布局模式
- 将布局计算卸载到 Worker 线程，避免阻塞主线程
- 自动响应容器大小变化和缩略图尺寸变化

---

#### `src/workers/layout.worker.ts` - 布局计算 Worker
**位置**: `src/workers/layout.worker.ts`  
**行数**: 252 行  
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
| `useAIAnalysis.ts` | `src/hooks/useAIAnalysis.ts` | 609 行 | AI 分析封装（描述、标签、场景识别、OCR、翻译） |
| `useAIRename.ts` | `src/hooks/useAIRename.ts` | 103 行 | AI 智能重命名 Hook |
| `useContextMenu.ts` | `src/hooks/useContextMenu.ts` | 91 行 | 右键菜单管理 |
| `useFileOperations.ts` | `src/hooks/useFileOperations.ts` | 1049 行 | 文件操作封装 |
| `useFileSearch.ts` | `src/hooks/useFileSearch.ts` | 184 行 | 搜索逻辑处理 |
| `useInView.ts` | `src/hooks/useInView.ts` | 37 行 | 视口检测 Hook |
| `useKeyboardShortcuts.ts` | `src/hooks/useKeyboardShortcuts.ts` | 78 行 | 键盘快捷键管理 |
| `useMarqueeSelection.ts` | `src/hooks/useMarqueeSelection.ts` | 186 行 | 框选状态管理 |
| `useToasts.ts` | `src/hooks/useToasts.ts` | 42 行 | Toast 通知管理 |

---

#### `PersonGrid.tsx` - 人物网格组件
**位置**: `src/components/PersonGrid.tsx`  
**行数**: 232 行  
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
**行数**: 1457 行  
**功能**: 文件和文件夹的网格显示组件

**主要更新**:
- 移除了人物相关的显示逻辑（已分离到 PersonGrid）
- 专注于文件/文件夹的展示和管理
- 支持虚拟滚动优化性能
- 集成布局计算 Hook

---

#### `SettingsModal.tsx` - 设置模态框组件
**位置**: `src/components/SettingsModal.tsx`  
**行数**: 1347 行  
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
| `ColorPickerPopover.tsx` | `src/components/ColorPickerPopover.tsx` | 356 行 | HSV 颜色选择器，支持预设和吸管工具 |
| `ImageViewer.tsx` | `src/components/ImageViewer.tsx` | 1542 行 | 全屏图片查看，支持缩放、旋转、元数据显示 |
| `MetadataPanel.tsx` | `src/components/MetadataPanel.tsx` | 2646 行 | 显示文件元数据、AI 分析结果、标签管理 |
| `TreeSidebar.tsx` | `src/components/TreeSidebar.tsx` | 1511 行 | 文件夹树导航，支持展开/折叠 |
| `TopBar.tsx` | `src/components/TopBar.tsx` | 1025 行 | 搜索栏、视图切换、操作按钮 |
| `TabBar.tsx` | `src/components/TabBar.tsx` | 495 行 | 多标签页管理，支持关闭、拖拽排序 |
| `TopicModule.tsx` | `src/components/TopicModule.tsx` | 2690 行 | 专题画廊和详情视图 |
| `TaskProgressModal.tsx` | `src/components/TaskProgressModal.tsx` | 87 行 | 任务进度显示模态框 |
| `CloseConfirmationModal.tsx` | `src/components/CloseConfirmationModal.tsx` | 68 行 | 关闭确认对话框 |
| `DragDropOverlay.tsx` | `src/components/DragDropOverlay.tsx` | 141 行 | 拖拽覆盖层 |
| `SplashScreen.tsx` | `src/components/SplashScreen.tsx` | 177 行 | 启动画面 |
| `Logo.tsx` | `src/components/Logo.tsx` | 59 行 | Logo 组件 |
| `FolderIcon.tsx` | `src/components/FolderIcon.tsx` | 397 行 | 文件夹图标 |
| `ContextMenu.tsx` | `src/components/ContextMenu.tsx` | 485 行 | 右键上下文菜单组件 |
| `ToastItem.tsx` | `src/components/ToastItem.tsx` | 35 行 | 通知/吐司项组件 |
| `ImageComparer.tsx` | `src/components/ImageComparer.tsx` | 2346 行 | 图片对比组件 |
| `ImageThumbnail.tsx` | `src/components/ImageThumbnail.tsx` | 155 行 | 图片缩略图组件 |
| `FileListItem.tsx` | `src/components/FileListItem.tsx` | 407 行 | 文件列表项组件 |
| `TagsList.tsx` | `src/components/TagsList.tsx` | 376 行 | 标签列表组件 |
| `GlobalToasts.tsx` | `src/components/GlobalToasts.tsx` | 35 行 | 全局 Toast 容器 |
| `EmptyFolderPlaceholder.tsx` | `src/components/EmptyFolderPlaceholder.tsx` | 31 行 | 空文件夹占位符 |
| `InlineRenameInput.tsx` | `src/components/InlineRenameInput.tsx` | 44 行 | 内联重命名输入框 |
| `Folder3DIcon.tsx` | `src/components/Folder3DIcon.tsx` | 86 行 | 3D 文件夹图标 |
| `FolderThumbnail.tsx` | `src/components/FolderThumbnail.tsx` | 138 行 | 文件夹缩略图 |
| `AIRenameButton.tsx` | `src/components/AIRenameButton.tsx` | 38 行 | AI 重命名按钮组件 |
| `AIRenamePreview.tsx` | `src/components/AIRenamePreview.tsx` | 40 行 | AI 重命名预览组件 |

#### 图片对比组件 (`src/components/comparer/`)

| 组件 | 行数 | 功能 |
|------|------|------|
| `AnnotationLayer.tsx` | 294 行 | 标注图层组件 |
| `ComparerContextMenu.tsx` | 149 行 | 对比视图右键菜单 |
| `EditOverlay.tsx` | 554 行 | 编辑覆盖层 |
| `types.ts` | 67 行 | 对比组件类型定义 |

---

### 3. 服务层 (`src/services/`)

#### `aiService.ts` - AI 服务
**位置**: `src/services/aiService.ts`  
**行数**: 411 行  
**功能**: OpenAI/Ollama/LM Studio 集成

**更新**: AI 分析优化
- dominantColors 不再通过 AI 分析（性能优化）
- 专注于描述、标签、场景分类、对象识别、OCR、翻译
- 支持自定义系统提示词和预设

#### `faceRecognitionService.ts` - 人脸识别服务
**位置**: `src/services/faceRecognitionService.ts`  
**行数**: 86 行  
**功能**: 基于 face-api.js 的人脸识别

---

### 4. 工具函数库 (`src/utils/`)

| 文件 | 行数 | 功能 |
|------|------|------|
| `async.ts` | 19 行 | 异步工具与文件 I/O 包装 |
| `debounce.ts` | 72 行 | 防抖函数（搜索/输入节流） |
| `environment.ts` | 62 行 | 环境检测与 Feature flags |
| `logger.ts` | 228 行 | 结构化前端日志封装 |
| `mockFileSystem.ts` | 342 行 | 开发/测试用模拟 FS |
| `performanceMonitor.ts` | 501 行 | 性能计时与采样工具 |
| `textUtils.ts` | 42 行 | 文本处理与规范化函数 |
| `translations.ts` | 1247 行 | 国际化文案（多语言） |
| `thumbnailCache.ts` | 78 行 | 缩略图缓存管理 |

---

### 5. 类型定义 (`src/types.ts`)
**位置**: `src/types.ts`  
**行数**: 331 行  

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
  // 注意：代码中当前没有 updatedAt 字段，但数据库表中有 updated_at 字段
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
  // 注意：代码中当前只有 hex, rgb, isDark 三个字段
  // LAB 颜色空间字段在数据库中存在，但未在 TypeScript 类型中定义
}

export interface AppState { 
  // ... 完整状态定义
}

// ... 更多类型定义
```

---

### 6. 常量定义 (`src/constants.ts`)
**位置**: `src/constants.ts`  
**行数**: 24 行  
**功能**: 应用常量定义

```typescript
export const DUMMY_TAB: TabState = { ... }
export const DEFAULT_LAYOUT_SETTINGS = { ... }
```

---

### 7. 应用入口 (`src/main.tsx`)
**位置**: `src/main.tsx`  
**行数**: 39 行  
**功能**: React 应用挂载点

---

### 8. 其他 Workers

| Worker | 位置 | 行数 | 功能 |
|--------|------|------|------|
| `search.worker.ts` | `src/workers/search.worker.ts` | 125 行 | 搜索计算 Worker |

---

## 后端模块分布 (src-tauri/)

### 1. 主程序 (`src-tauri/src/main.rs`)
**位置**: `src-tauri/src/main.rs`  
**行数**: 2509 行  
**功能**: Tauri 应用入口，命令处理器

**主要功能**:
- 应用程序初始化
- 命令注册（文件系统、数据库、窗口管理等）
- 系统托盘集成
- 全局快捷键
- 后台任务管理（颜色提取 Worker）

---

### 2. 颜色相关模块

#### `color_db.rs` - 颜色数据库
**位置**: `src-tauri/src/color_db.rs`  
**行数**: 1120 行  
**功能**: 颜色数据存储和管理
- 颜色索引表管理
- 颜色搜索功能
- 批量颜色保存
- WAL 检查点管理

#### `color_extractor.rs` - 颜色提取算法
**位置**: `src-tauri/src/color_extractor.rs`  
**行数**: 253 行  
**功能**: 图像颜色分析算法
- 主色调提取
- LAB 颜色空间转换
- 颜色相似度计算

#### `color_search.rs` - 颜色搜索
**位置**: `src-tauri/src/color_search.rs`  
**行数**: 441 行  
**功能**: 颜色搜索算法
- 按颜色搜索图片
- 按调色板搜索图片
- 颜色相似度匹配

#### `color_worker.rs` - 颜色处理工作器
**位置**: `src-tauri/src/color_worker.rs`  
**行数**: 949 行  
**功能**: 后台颜色提取任务处理
- 批量颜色提取
- 进度事件发送
- 暂停/恢复控制

---

### 3. 缩略图模块 (`src-tauri/src/thumbnail.rs`)
**位置**: `src-tauri/src/thumbnail.rs`  
**行数**: 529 行  
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

### 4. 数据库模块 (`src-tauri/src/db/`)

#### `mod.rs` - 数据库模块入口
**位置**: `src-tauri/src/db/mod.rs`  
**行数**: 142 行  
**功能**:
- 管理数据库连接池 (`AppDbPool`)
- 执行数据库初始化
- 创建 `persons`、`file_metadata`、`file_index` 表

#### `persons.rs` - 人物数据库操作
**位置**: `src-tauri/src/db/persons.rs`  
**行数**: 118 行  
**功能**: 人物数据的 CRUD 操作

#### `file_metadata.rs` - 文件元数据存储
**位置**: `src-tauri/src/db/file_metadata.rs`  
**行数**: 230 行  
**功能**:
- 图片标签、描述、来源 URL 持久化
- AI 数据（JSON）存储
- `upsert_file_metadata`、`get_metadata_by_id` 等

#### `file_index.rs` - 文件索引数据库
**位置**: `src-tauri/src/db/file_index.rs`  
**行数**: 348 行  
**功能**:
- 文件索引表管理
- 文件路径到 ID 的映射
- 支持数据库切换
- 批量索引操作

#### `topics.rs` - 专题数据库操作
**位置**: `src-tauri/src/db/topics.rs`  
**行数**: 175 行  
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

### 5. 工具模块

#### `dump_persons.rs` - 人物数据导出工具
**位置**: `src-tauri/src/bin/dump_persons.rs`  
**行数**: 40 行  
**功能**: 导出人物数据到文件

---

## 依赖关系图

```
App.tsx (4248 行)
├── components/
│   ├── modals/ (17 个模态框)
│   │   ├── AddImageModal.tsx (1238 行)
│   │   ├── AddToPersonModal.tsx (74 行)
│   │   ├── AddToTopicModal.tsx (81 行)
│   │   ├── AIBatchRenameModal.tsx (381 行)
│   │   ├── AlertModal.tsx (23 行)
│   │   ├── BatchRenameModal.tsx (56 行)
│   │   ├── ClearPersonModal.tsx (101 行)
│   │   ├── ConfirmModal.tsx (28 行)
│   │   ├── CreateTopicModal.tsx (72 行)
│   │   ├── CropAvatarModal.tsx (401 行)
│   │   ├── ExitConfirmModal.tsx (41 行)
│   │   ├── FolderPickerModal.tsx (161 行)
│   │   ├── RenamePersonModal.tsx (30 行)
│   │   ├── RenameTagModal.tsx (29 行)
│   │   ├── RenameTopicModal.tsx (74 行)
│   │   ├── TagEditor.tsx (56 行)
│   │   └── WelcomeModal.tsx (200 行)
│   ├── comparer/ (3 个组件)
│   │   ├── AnnotationLayer.tsx (294 行)
│   │   ├── ComparerContextMenu.tsx (149 行)
│   │   ├── EditOverlay.tsx (554 行)
│   │   └── types.ts (67 行)
│   ├── AppModals.tsx (424 行)
│   ├── PersonGrid.tsx (232 行)
│   ├── FileGrid.tsx (1457 行)
│   ├── SettingsModal.tsx (1347 行)
│   ├── ImageViewer.tsx (1542 行)
│   ├── MetadataPanel.tsx (2646 行)
│   ├── TreeSidebar.tsx (1511 行)
│   ├── TopBar.tsx (1025 行)
│   ├── TabBar.tsx (495 行)
│   ├── TopicModule.tsx (2690 行)
│   ├── TaskProgressModal.tsx (87 行)
│   ├── ImageComparer.tsx (2346 行)
│   └── useLayoutHook.ts (79 行)
├── hooks/
│   ├── useTasks.ts (317 行)
│   ├── useNavigation.ts (260 行)
│   ├── useAIAnalysis.ts (609 行)
│   ├── useAIRename.ts (103 行)
│   ├── useContextMenu.ts (91 行)
│   ├── useFileOperations.ts (1049 行)
│   ├── useFileSearch.ts (184 行)
│   ├── useInView.ts (37 行)
│   ├── useKeyboardShortcuts.ts (78 行)
│   ├── useMarqueeSelection.ts (186 行)
│   └── useToasts.ts (42 行)
├── services/
│   ├── aiService.ts (411 行)
│   └── faceRecognitionService.ts (86 行)
├── api/
│   └── tauri-bridge.ts (1283 行)
├── workers/
│   ├── layout.worker.ts (252 行)
│   └── search.worker.ts (123 行)
├── utils/ (多个工具模块)
│   ├── async.ts (19 行)
│   ├── debounce.ts (72 行)
│   ├── environment.ts (62 行)
│   ├── logger.ts (228 行)
│   ├── mockFileSystem.ts (342 行)
│   ├── performanceMonitor.ts (501 行)
│   ├── textUtils.ts (42 行)
│   ├── translations.ts (1247 行)
│   └── thumbnailCache.ts (78 行)
├── types.ts (345 行)
└── constants.ts (31 行)

Rust Backend
├── main.rs (2509 行)
├── thumbnail.rs (529 行)
├── color_db.rs (1120 行)
├── color_extractor.rs (253 行)
├── color_search.rs (441 行)
├── color_worker.rs (949 行)
└── db/
    ├── mod.rs (142 行)
    ├── persons.rs (118 行)
    ├── file_metadata.rs (230 行)
    ├── file_index.rs (348 行)
    └── topics.rs (175 行)

Tools
└── bin/
    └── dump_persons.rs (40 行)
```

---

## 模块复杂度分析

### 高复杂度模块 (需要关注)
1. **App.tsx** (4248 行) - 主应用组件，状态管理复杂
2. **main.rs** (2509 行) - Rust 主程序，命令处理集中
3. **ImageComparer.tsx** (2346 行) - 图片对比组件功能复杂
4. **AddImageModal.tsx** (1238 行) - 添加图片模态框，支持多分类浏览和虚拟滚动
5. **TopicModule.tsx** (2690 行) - 专题管理功能丰富
6. **MetadataPanel.tsx** (2646 行) - 元数据面板功能丰富
7. **color_db.rs** (1120 行) - 颜色数据库操作复杂
8. **color_worker.rs** (949 行) - 后台处理逻辑复杂
9. **color_search.rs** (441 行) - 颜色搜索算法复杂

### 中等复杂度模块
1. **SettingsModal.tsx** (1347 行) - 设置界面功能丰富
2. **ImageViewer.tsx** (1542 行) - 图片查看器功能完整
3. **FileGrid.tsx** (1457 行) - 文件显示逻辑复杂
4. **tauri-bridge.ts** (1283 行) - API 桥接层
5. **useFileOperations.ts** (1049 行) - 文件操作逻辑复杂
6. **useAIAnalysis.ts** (609 行) - AI 分析逻辑复杂
7. **AIBatchRenameModal.tsx** (381 行) - AI 批量重命名模态框
8. **EditOverlay.tsx** (554 行) - 编辑覆盖层功能丰富
9. **thumbnail.rs** (529 行) - 缩略图生成逻辑
10. **topics.rs** (175 行) - 专题数据库操作

### 低复杂度模块
1. **PersonGrid.tsx** (232 行) - 专用组件，职责单一
2. **useLayoutHook.ts** (79 行) - 布局计算 Hook
3. **constants.ts** (31 行) - 常量定义
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

**文档版本**: 1.4  
**更新日期**: 2026-02-11  
**覆盖范围**: 所有前端和后端模块  
**详细程度**: 高
