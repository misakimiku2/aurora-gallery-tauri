# Aurora Gallery Tauri 模块分布详解

## 前端模块分布 (src/)

### 1. API 桥接层 (`src/api/`)

#### `tauri-bridge.ts` - 核心桥接模块
**位置**: `src/api/tauri-bridge.ts`  
**行数**: ~890 行  
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

#### `App.tsx` - 主应用组件
**位置**: `src/App.tsx`  
**行数**: 6970+ 行  
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
}, [])
```

#### `PersonGrid.tsx` - 人物网格组件 (新增)
**位置**: `src/components/PersonGrid.tsx`  
**行数**: ~219 行  
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
**行数**: ~1200 行  
**功能**: 文件和文件夹的网格显示组件

**主要更新**:
- 移除了人物相关的显示逻辑（已分离到 PersonGrid）
- 专注于文件/文件夹的展示和管理

#### `SettingsModal.tsx` - 设置模态框组件
**位置**: `src/components/SettingsModal.tsx`  
**行数**: ~1208 行  
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
**行数**: ~300 行  
**功能**: HSV 颜色选择器，支持预设和吸管工具

##### `ImageViewer.tsx` - 图片查看器
**位置**: `src/components/ImageViewer.tsx`  
**行数**: ~800 行  
**功能**: 全屏图片查看，支持缩放、旋转、元数据显示

##### `MetadataPanel.tsx` - 元数据面板
**位置**: `src/components/MetadataPanel.tsx`  
**行数**: ~400 行  
**功能**: 显示文件元数据、AI 分析结果、标签管理

##### `TreeSidebar.tsx` - 树形侧边栏
**位置**: `src/components/TreeSidebar.tsx`  
**行数**: ~600 行  
**功能**: 文件夹树导航，支持展开/折叠

##### `TopBar.tsx` - 顶部工具栏
**位置**: `src/components/TopBar.tsx`  
**行数**: ~300 行  
**功能**: 搜索栏、视图切换、操作按钮

##### `TabBar.tsx` - 标签页管理
**位置**: `src/components/TabBar.tsx`  
**行数**: ~250 行  
**功能**: 多标签页管理，支持关闭、拖拽排序

##### `TopicModule.tsx` - 专题模块
**位置**: `src/components/TopicModule.tsx`  
**行数**: ~800 行  
**功能**: 专题画廊和详情视图

##### 其他 UI 组件
- `CloseConfirmationModal.tsx` - 关闭确认对话框
- `DragDropOverlay.tsx` - 拖拽覆盖层
- `SequenceViewer.tsx` - 序列查看器
- `SplashScreen.tsx` - 启动画面
- `Logo.tsx` - Logo 组件
- `FolderIcon.tsx` - 文件夹图标

### 3. 服务层 (`src/services/`)

#### `aiService.ts` - AI 服务
**位置**: `src/services/aiService.ts`  
**行数**: ~200 行  
**功能**: OpenAI/Ollama/LM Studio 集成

**更新**: AI 分析优化
- dominantColors 不再通过 AI 分析（性能优化）
- 专注于描述、标签、场景分类、对象识别

#### `faceRecognitionService.ts` - 人脸识别服务
**位置**: `src/services/faceRecognitionService.ts`  
**行数**: ~150 行  
**功能**: 基于 face-api.js 的人脸识别

### 4. 工具函数库 (`src/utils/`)

#### `debounce.ts` - 防抖函数
**位置**: `src/utils/debounce.ts`  
**行数**: ~20 行  

#### `environment.ts` - 环境检测
**位置**: `src/utils/environment.ts`  
**行数**: ~30 行  

#### `logger.ts` - 日志记录
**位置**: `src/utils/logger.ts`  
**行数**: ~100 行  

#### `mockFileSystem.ts` - 模拟文件系统
**位置**: `src/utils/mockFileSystem.ts`  
**行数**: ~200 行  

#### `performanceMonitor.ts` - 性能监控
**位置**: `src/utils/performanceMonitor.ts`  
**行数**: ~80 行  

#### `translations.ts` - 多语言支持
**位置**: `src/utils/translations.ts`  
**行数**: ~500 行  

### 5. 类型定义 (`src/types.ts`)
**位置**: `src/types.ts`  
**行数**: ~332 行  

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
**行数**: ~50 行  
**功能**: React 应用挂载点

---

## 后端模块分布 (src-tauri/)

### 1. 主程序 (`src-tauri/src/main.rs`)
**位置**: `src-tauri/src/main.rs`  
**行数**: ~2529 行  
**功能**: Tauri 应用入口，命令处理器

### 2. 颜色相关模块

#### `color_db.rs` - 颜色数据库
**位置**: `src-tauri/src/color_db.rs`  
**行数**: ~300 行  
**功能**: 颜色数据存储和管理

#### `color_extractor.rs` - 颜色提取算法
**位置**: `src-tauri/src/color_extractor.rs`  
**行数**: ~200 行  
**功能**: 图像颜色分析算法

#### `color_worker.rs` - 颜色处理工作器
**位置**: `src-tauri/src/color_worker.rs`  
**行数**: ~760 行  
**功能**: 后台颜色提取任务处理

### 3. 数据库模块 (`src-tauri/src/db/`)
#### `mod.rs` - 数据库模块入口
- 管理数据库连接池 (`AppDbPool`)。
- 执行数据库初始化，创建 `persons` 和 `file_metadata` 表。

#### `persons.rs` - 人物数据库操作
- 人物数据的 CRUD 操作。

#### `file_metadata.rs` - 文件元数据存储 (新增)
- 负责图片标签、描述、来源 URL 和 AI 数据（JSON）的持久化。
- 实现 `upsert_file_metadata`、`get_metadata_by_id` 等核心 Rust 函数。

---

## 依赖关系图

```
 (6970+ 行)
├── components/
│   ├──  (219 行) [新增]
│   ├── FileGrid.tsx (1200 行) [更新]
│   ├──  (1208 行) [增强]
│   ├── ImageViewer.tsx (800 行)
│   ├── MetadataPanel.tsx (400 行)
│   ├── TreeSidebar.tsx (600 行)
│   ├── TopBar.tsx (300 行)
│   ├── TabBar.tsx (250 行)
│   ├── TopicModule.tsx (800 行)
│   └── [其他组件...]
├── services/
│   ├── aiService.ts (200 行) [优化]
│   └── faceRecognitionService.ts (150 行)
├── api/
│   └──  (890 行) [稳定]
├── utils/ (多个工具模块)
└──  (332 行)


├── Tauri Core API
├── File System APIs
├── Database APIs
└── Window Management APIs

Rust Backend
├──  (2529 行)
├── color_db.rs (300 行)
├── color_extractor.rs (200 行)
├── color_worker.rs (760 行)
└── db/
    ├── persons.rs
    └── file_metadata.rs [新增]
```

---

## 模块复杂度分析

### 高复杂度模块 (需要关注)
1. **App.tsx** (6970+ 行) - 主应用组件，状态管理复杂
2. **main.rs** (2529 行) - Rust 主程序，命令处理集中
3. **color_worker.rs** (760 行) - 后台处理逻辑复杂

### 中等复杂度模块
1. **SettingsModal.tsx** (1208 行) - 设置界面功能丰富
2. **FileGrid.tsx** (1200 行) - 文件显示逻辑复杂
3. **tauri-bridge.ts** (890 行) - API 桥接层

### 低复杂度模块
1. **PersonGrid.tsx** (219 行) - 新增专用组件，职责单一
2. **工具函数** - 各司其职，逻辑简单

---

## 架构改进建议

1. **组件拆分**: App.tsx 过大，建议进一步拆分为更小的功能组件
2. **状态管理**: 考虑引入 Zustand 或 Redux 进行更精细的状态管理
3. **API 分层**: tauri-bridge.ts 可以按功能进一步拆分
4. **测试覆盖**: 为关键模块添加单元测试和集成测试
5. **类型安全**: 完善 TypeScript 类型定义，提高代码可维护性