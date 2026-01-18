# Aurora Gallery Tauri 模块分布详解

## 前端模块分布 (src/)

### 1. API 桥接层 (`src/api/`)

#### `tauri-bridge.ts` - 核心桥接模块
**位置**: `src/api/tauri-bridge.ts`  
**行数**: 933 行  
**功能分类**:

**文件系统操作**:
```typescript
// 目录扫描
export async function scanDirectory(path: string, forceRefresh?: boolean): Promise<{ roots: string[]; files: Record<string, FileNode> }>
export async function scanFile(filePath: string, parentId?: string): Promise<FileNode>

// 文件操作
export async function renameFile(oldPath: string, newPath: string): Promise<void>
export async function deleteFile(path: string): Promise<void>
export async function copyFile(srcPath: string, destPath: string): Promise<void>
export async function moveFile(srcPath: string, destPath: string): Promise<void>
export async function writeFileFromBytes(filePath: string, bytes: Uint8Array): Promise<void>

// 目录管理
export async function openDirectory(): Promise<string | null>
export async function ensureDirectory(path: string): Promise<void>
// Deprecated: ensureCacheDirectory(rootPath: string) exists as a compatibility adapter but is deprecated
export async function createFolder(path: string): Promise<void>
export async function openPath(path: string, isFile?: boolean): Promise<void>

// 缩略图与图像相关
export async function getThumbnail(filePath: string, modified?: string, rootPath?: string, signal?: AbortSignal, onColors?: (colors: DominantColor[] | null) => void): Promise<string | null>
export function getAssetUrl(filePath: string): string
export async function readFileAsBase64(path: string): Promise<string | null>
export async function getDominantColors(filePath: string, count?: number, thumbnailPath?: string): Promise<DominantColor[]>
export async function searchByColor(targetHex: string): Promise<string[]>
export async function searchByPalette(palette: string[]): Promise<string[]>
export async function generateDragPreview(thumbnailPaths: string[], totalCount: number, cacheRoot: string): Promise<string | null>
export async function startDragToExternal(filePaths: string[], thumbnailPaths?: string[], cacheRoot?: string, onDragEnd?: () => void): Promise<void>
```

**用户数据管理**:
```typescript
export async function saveUserData(data: any): Promise<boolean>
export async function loadUserData(): Promise<any>
export async function getDefaultPaths(): Promise<Record<string, string>>
```

**数据库操作**:
```typescript
export async function dbGetAllPeople(): Promise<any[]>
export async function dbUpsertPerson(person: any): Promise<void>
export async function dbDeletePerson(id: string): Promise<void>
export async function dbUpdatePersonAvatar(personId: string, coverFileId: string, faceBox: any): Promise<void>
```

**窗口管理**:
```typescript
export async function hideWindow(): Promise<void>
export async function showWindow(): Promise<void>
export async function exitApp(): Promise<void>
```

**色彩提取控制**:
```typescript
export async function pauseColorExtraction(): Promise<boolean>
export async function resumeColorExtraction(): Promise<boolean>
```

### 2. 组件库 (`src/components/`)

#### `App.tsx` - 主应用组件 ✅
**位置**: `src/App.tsx`  
**行数**: 3336 行  

**概览**:
- `App.tsx` 仍为大型单体组件，负责绝大多数 UI 状态、视图路由与操作协调。近期改动强调可维护性与性能：把任务管理抽出到 `src/hooks/useTasks.ts`，并精细化拖拽、选择与 AI/色彩搜索逻辑。

**状态与配置（关键字段）**:
- 完整 `AppState` 初始化包含：root 列表、`files`、`people`、`topics`、多个 `tabs`、视图排序和分组、`thumbnailSize`、`clipboard`、`customTags`、`folderSettings`、`layout`（侧边栏与元数据面板可见性）、幻灯片配置、`settings.ai`（OpenAI/Ollama/LM Studio 配置与开关）、以及拖拽/选择相关状态（`dragState` / `isExternalDragging` / `isDraggingInternal` / `draggedFilePaths`）。

**派生状态与性能优化**:
- 使用大量 `useMemo`/`useCallback` 计算派生数据：`activeTab`、`displayFileIds`（含 AI 过滤、颜色/色板搜索与日期过滤）、`groupedTags`、`personCounts`（带性能计时）、`peopleWithDisplayCounts` 等。
- 引入 `performanceMonitor` 记录关键函数的耗时（如 `personCounts`、复制/移动任务等）。

**核心 Hook 与初始化**:
- 初始化流程负责：检测 Tauri 环境、加载用户数据、扫描目录、注册事件（包括自定义 `color-update` 事件以即时更新文件主色调）以及挂载窗口关闭/最小化回调。
- 色彩提取进度监听已迁移并集中在 `useTasks` 中。

**任务管理（迁移到 `useTasks`）**:
- `useTasks` 提供 `startTask`、`updateTask`、任务状态列表等，统一处理：复制/移动/AI/颜色/缩略图等任务，并对 `color-extraction-progress` 事件进行监听与更新。

**交互与输入处理**:
- 复杂的鼠标选择框实现（按下/移动/释放），优化为直接 DOM 操作 + 节流（`throttle` 函数）以减少抖动并提升性能。
- 右键菜单、键盘快捷键以及范围选择（Ctrl/Shift）均实现并支持基于显示顺序的范围选择（文件/人物/标签）。

**拖拽与外部文件处理**:
- 完整的内部与外部拖拽处理：区分内部拖拽（application/json）与外部（Files），实现 `handleExternalDragEnter` / `handleExternalDrop` / `handleExternalDragLeave` 等。
- 支持 `handleExternalCopyFiles` 与 `handleExternalMoveFiles`（将浏览器 `File` 对象导入到目标文件夹），并以后台任务形式显示进度。
- 支持生成外部拖拽预览（委托给后端/`tauri-bridge` 的接口）与跨应用拖拽（`startDragToExternal`）。

**文件操作（复制/移动/重命名/删除）**:
- `handleCopyFiles`、`handleMoveFiles` 使用并发控制（`asyncPool`）与详尽的冲突/重复名处理策略，任务以 `useTasks` 展示并记录性能日志。
- 批量重命名（`handleBatchRename`）以任务形式运行并保证顺序。
- 删除支持撤销（`deletionTasks` 列表、`undoDelete` / `dismissDelete`）。

**持久化与设置**:
- `saveUserData` 包含对 Tauri 环境的异步检测（`detectTauriEnvironmentAsync`），并以防抖策略保存：根路径、标签、人物、专题、文件元数据与设置。
- `folderSettings` 支持记忆与自动应用，使用 `folderSettingsRef` 避免副作用循环。
- 退出/最小化逻辑使用 `exitActionRef` 以避免闭包过时问题，并支持“记住我的选择”。

**搜索与 AI 功能**:
- 增强的搜索：支持 `color:` 与 `palette:` 前缀的颜色/色板搜索（直接调用色彩数据库或后端），并在 `onPerformSearch` 中优先处理这些特殊查询。
- `performAiSearch` / `handleAIAnalysis` / `handleFolderAIAnalysis` 支持对单文件/文件夹进行 AI 分析（描述、标签、场景、对象识别），AI 任务也通过 `useTasks` 管理。

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

#### `src/components/modals/` - 模态框组件集合 (新增)
**位置**: `src/components/modals/`
**功能**: 包含所有独立的业务逻辑模态框
- `FolderPickerModal.tsx`: 文件夹选择器
- `BatchRenameModal.tsx`: 批量重命名 (带任务进度)
- `AddToTopicModal.tsx`: 添加到专题
- `RenameTagModal.tsx`: 标签重命名
- `WelcomeModal.tsx`: 首次使用欢迎向导
- ... 其他 8 个模态框

#### `src/components/AppModals.tsx` - 模态框集中渲染组件
**位置**: `src/components/AppModals.tsx`
**行数**: 368 行
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

#### `src/hooks/useTasks.ts` - 任务管理 Hook (新增)
**位置**: `src/hooks/useTasks.ts`
**行数**: 317 行
**功能**: 集中管理后台任务状态
- `startTask`: 启动新任务 (copy/move/ai/color)
- `updateTask`: 更新任务进度 (带防抖)
- `useTasks`: 为了组件提供任务状态和操作方法
- 监听 `color-extraction-progress` 事件并自动更新状态

#### 其他自定义 Hooks

`src/hooks/useAIAnalysis.ts` - AI 分析 Hook
**位置**: `src/hooks/useAIAnalysis.ts`
**功能**: 提供文件或文件夹级别的 AI 分析封装（描述、标签、场景识别），与 `aiService` 协作并将任务注册到 `useTasks`。

`src/hooks/useContextMenu.ts` - 上下文菜单 Hook
**位置**: `src/hooks/useContextMenu.ts`
**功能**: 管理右键菜单显示位置、菜单项与交互回调，支持文件/人物/专题等不同上下文类型。

`src/hooks/useFileOperations.ts` - 文件操作 Hook
**位置**: `src/hooks/useFileOperations.ts`
**功能**: 封装复制/移动/重命名/删除等文件系统操作，并将这些操作以任务形式注册到 `useTasks`。

`src/hooks/useFileSearch.ts` - 搜索 Hook
**位置**: `src/hooks/useFileSearch.ts`
**功能**: 实现搜索逻辑，处理 color:/palette: 前缀并与色彩数据库或后端搜索接口协作。

`src/hooks/useMarqueeSelection.ts` - 框选 Hook
**位置**: `src/hooks/useMarqueeSelection.ts`
**功能**: 管理框选状态、碰撞检测与多选逻辑。

#### `PersonGrid.tsx` - 人物网格组件 (新增)
**位置**: `src/components/PersonGrid.tsx`  
**行数**: 224 行（以源码为准 · 已同步）  
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

#### `FileGrid.tsx` - 文件网格组件
**位置**: `src/components/FileGrid.tsx`  
**行数**: 2562 行  
**功能**: 文件和文件夹的网格显示组件

**主要更新**:
- 移除了人物相关的显示逻辑（已分离到 PersonGrid）
- 专注于文件/文件夹的展示和管理

#### `SettingsModal.tsx` - 设置模态框组件
**位置**: `src/components/SettingsModal.tsx`  
**行数**: 1207 行  
**新增功能**: 系统提示预设管理

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

#### 其他组件

##### `ColorPickerPopover.tsx` - 颜色选择器
**位置**: `src/components/ColorPickerPopover.tsx`  
**行数**: 321 行  
**功能**: HSV 颜色选择器，支持预设和吸管工具

##### `ImageViewer.tsx` - 图片查看器
**位置**: `src/components/ImageViewer.tsx`  
**行数**: 1067 行  
**功能**: 全屏图片查看，支持缩放、旋转、元数据显示

##### `MetadataPanel.tsx` - 元数据面板
**位置**: `src/components/MetadataPanel.tsx`  
**行数**: 2449 行  
**功能**: 显示文件元数据、AI 分析结果、标签管理

##### `TreeSidebar.tsx` - 树形侧边栏
**位置**: `src/components/TreeSidebar.tsx`  
**行数**: 654 行  
**功能**: 文件夹树导航，支持展开/折叠

##### `TopBar.tsx` - 顶部工具栏
**位置**: `src/components/TopBar.tsx`  
**行数**: 921 行  
**功能**: 搜索栏、视图切换、操作按钮

##### `TabBar.tsx` - 标签页管理
**位置**: `src/components/TabBar.tsx`  
**行数**: 249 行  
**功能**: 多标签页管理，支持关闭、拖拽排序

##### `TopicModule.tsx` - 专题模块
**位置**: `src/components/TopicModule.tsx`  
**行数**: 2608 行  
**功能**: 专题画廊和详情视图

##### 其他 UI 组件
- `CloseConfirmationModal.tsx` - 关闭确认对话框
- `DragDropOverlay.tsx` - 拖拽覆盖层
- `SequenceViewer.tsx` - 序列查看器
- `SplashScreen.tsx` - 启动画面
- `Logo.tsx` - Logo 组件
- `FolderIcon.tsx` - 文件夹图标
 - `ContextMenu.tsx` - 右键上下文菜单组件
 - `ToastItem.tsx` - 通知/吐司项组件

### 3. 服务层 (`src/services/`)

#### `aiService.ts` - AI 服务
**位置**: `src/services/aiService.ts`  
**行数**: 99 行  
**功能**: OpenAI/Ollama/LM Studio 集成

**更新**: AI 分析优化
- dominantColors 不再通过 AI 分析（性能优化）
- 专注于描述、标签、场景分类、对象识别

#### `faceRecognitionService.ts` - 人脸识别服务
**位置**: `src/services/faceRecognitionService.ts`  
**行数**: 86 行  
**功能**: 基于 face-api.js 的人脸识别

### 4. 工具函数库 (`src/utils/`)

#### `debounce.ts` - 防抖函数
**位置**: `src/utils/debounce.ts`  
**行数**: 72 行（以源码为准 · 已同步）  

#### `environment.ts` - 环境检测
**位置**: `src/utils/environment.ts`  
**行数**: 62 行  

#### `logger.ts` - 日志记录
**位置**: `src/utils/logger.ts`  
**行数**: 228 行  

#### `mockFileSystem.ts` - 模拟文件系统
**位置**: `src/utils/mockFileSystem.ts`  
**行数**: 341 行  

#### `performanceMonitor.ts` - 性能监控
**位置**: `src/utils/performanceMonitor.ts`  
**行数**: 452 行（以源码为准 · 已同步）  

#### `translations.ts` - 多语言支持
**位置**: `src/utils/translations.ts`  
**行数**: 1114 行  

### 5. 类型定义 (`src/types.ts`)
**位置**: `src/types.ts`  
**行数**: 331 行  

**主要类型**:
```typescript
export interface FileNode { ... }
export interface Person { ... }
export interface AiData { ... }
export interface AppState { ... }
export interface DominantColor { ... }
// ... 更多类型定义
```

### 6. 应用入口 (`src/main.tsx`)
**位置**: `src/main.tsx`  
**行数**: 39 行（以源码为准 · 已同步）  
**功能**: React 应用挂载点

---

## 后端模块分布 (src-tauri/)

### 1. 主程序 (`src-tauri/src/main.rs`)
**位置**: `src-tauri/src/main.rs`  
**行数**: 2614 行  
**功能**: Tauri 应用入口，命令处理器

### 2. 颜色相关模块

#### `color_db.rs` - 颜色数据库
**位置**: `src-tauri/src/color_db.rs`  
**行数**: 871 行  
**功能**: 颜色数据存储和管理

#### `color_extractor.rs` - 颜色提取算法
**位置**: `src-tauri/src/color_extractor.rs`  
**行数**: 258 行  
**功能**: 图像颜色分析算法

#### `color_worker.rs` - 颜色处理工作器
**位置**: `src-tauri/src/color_worker.rs`  
**行数**: 796 行  
**功能**: 后台颜色提取任务处理

### 3. 数据库模块 (`src-tauri/src/db/`)
#### `mod.rs` - 数据库模块入口
- 管理数据库连接池 (`AppDbPool`)。
- 执行数据库初始化，创建 `persons` 和 `file_metadata` 表。

#### `persons.rs` - 人物数据库操作
**位置**: `src-tauri/src/db/persons.rs`
**行数**: 118 行
- 人物数据的 CRUD 操作。

#### `file_metadata.rs` - 文件元数据存储 (新增)
**位置**: `src-tauri/src/db/file_metadata.rs`
**行数**: 87 行
- 负责图片标签、描述、来源 URL 和 AI 数据（JSON）的持久化。
- 实现 `upsert_file_metadata`、`get_metadata_by_id` 等核心 Rust 函数。

---

## 依赖关系图

```
App.tsx (3336 行)
├── components/
│   ├── modals/ (13 个模态框) [新增]
│   │   ├── AddToPersonModal.tsx (74 行)
│   │   ├── AddToTopicModal.tsx (81 行)
│   │   ├── AlertModal.tsx (23 行)
│   │   ├── BatchRenameModal.tsx (42 行)
│   │   ├── ClearPersonModal.tsx (101 行)
│   │   ├── ConfirmModal.tsx (28 行)
│   │   ├── CropAvatarModal.tsx (401 行)
│   │   ├── ExitConfirmModal.tsx (41 行)
│   │   ├── FolderPickerModal.tsx (161 行)
│   │   ├── RenamePersonModal.tsx (30 行)
│   │   ├── RenameTagModal.tsx (29 行)
│   │   ├── TagEditor.tsx (56 行)
│   │   └── WelcomeModal.tsx (140 行)
│   ├── PersonGrid.tsx (224 行) [新增] （以源码为准 · 已同步）
│   ├── FileGrid.tsx (2562 行) [更新]
│   ├── SettingsModal.tsx (1207 行) [增强]
│   ├── ImageViewer.tsx (1067 行)
│   ├── MetadataPanel.tsx (2449 行)
│   ├── TreeSidebar.tsx (654 行)
│   ├── TopBar.tsx (921 行)
│   ├── TabBar.tsx (249 行)
│   ├── TopicModule.tsx (2608 行)
│   └── TaskProgressModal.tsx
├── hooks/
│   └── useTasks.ts (317 行) [新增]
├── services/
│   ├── aiService.ts (99 行) [优化]
│   └── faceRecognitionService.ts (86 行)
├── api/
│   └── tauri-bridge.ts (933 行) [稳定]
├── utils/ (多个工具模块)
│   ├── async.ts (19 行) — 异步工具与文件 I/O 包装
│   ├── debounce.ts (72 行) — 防抖函数（搜索/输入节流）
│   ├── environment.ts (62 行) — 环境检测与 Feature flags
│   ├── logger.ts (228 行) — 结构化前端日志封装
│   ├── mockFileSystem.ts (341 行) — 开发/测试用模拟 FS
│   ├── performanceMonitor.ts (452 行) — 性能计时与采样工具
│   ├── textUtils.ts (42 行) — 文本处理与规范化函数
│   └── translations.ts (1114 行) — 国际化文案（多语言）
└── types.ts (331 行) （以源码为准 · 已同步）


├── Tauri Core API
├── File System APIs
├── Database APIs
└── Window Management APIs

Rust Backend
├── main.rs (2614 行)
├── color_db.rs (871 行)
├── color_extractor.rs (258 行)
├── color_worker.rs (796 行)
└── db/
    ├── persons.rs (118 行)
    └── file_metadata.rs (87 行)
```

---

## 模块复杂度分析

### 高复杂度模块 (需要关注)
1. **App.tsx** (3336 行) - 主应用组件，状态管理复杂
2. **main.rs** (2614 行) - Rust 主程序，命令处理集中
3. **color_worker.rs** (796 行) - 后台处理逻辑复杂

### 中等复杂度模块
1. **SettingsModal.tsx** (1207 行) - 设置界面功能丰富
2. **FileGrid.tsx** (2562 行) - 文件显示逻辑复杂
3. **tauri-bridge.ts** (933 行) - API 桥接层

### 低复杂度模块
1. **PersonGrid.tsx** (224 行) - 新增专用组件，职责单一（以源码为准 · 已同步）
2. **工具函数** - 各司其职，逻辑简单

---

## 架构改进建议

1. **组件拆分**: App.tsx 过大，建议进一步拆分为更小的功能组件
2. **状态管理**: 考虑引入 Zustand 或 Redux 进行更精细的状态管理
3. **API 分层**: tauri-bridge.ts 可以按功能进一步拆分
4. **测试覆盖**: 为关键模块添加单元测试和集成测试
5. **类型安全**: 完善 TypeScript 类型定义，提高代码可维护性