# Aurora Gallery Tauri 快速参考指南

## 快速开始

### 环境要求
- Node.js 18+
- Rust 1.70+
- Tauri CLI

```bash
# 检查版本
node --version
rustc --version
cargo --version
```

### 安装依赖
```bash
npm install
```

### 开发模式运行
```bash
# 前后端并行开发模式（推荐）
npm run tauri:dev

# 或分别运行
npm run dev              # 前端开发服务器 (http://localhost:14422)
npm run tauri:dev        # Tauri 开发模式
```

### 生产构建
```bash
npm run build
cargo tauri build
```

### 测试
```bash
npm run test             # 运行单元测试 (Vitest)
```

### 清理缓存
```bash
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

### 4. AI 分析优化 (2026-01-14 更新)
- dominantColors 不再通过 AI 分析（性能优化）
- 仅通过专用图像处理算法提取颜色
- 减少 AI tokens 消耗，提高分析速度
- 新增 OCR 和翻译功能支持

### 5. 导航历史管理 (2026-02-07 更新)
- 使用 `useNavigation` Hook 管理导航历史
- 支持前进/后退导航
- 自动保存和恢复滚动位置

### 6. AI 智能重命名 (2026-02-11 更新)
- 使用 `useAIRename` Hook 实现 AI 智能重命名
- 支持根据图片内容生成语义化文件名
- 支持批量重命名和预览确认

### 7. 专题管理 (2026-02-11 更新)
- 新增专题数据库支持
- 支持创建、编辑、删除专题
- 支持将图片添加到专题

## 常用命令速查

### 前端开发
```bash
# 开发服务器
npm run dev

# 类型检查
npx tsc --noEmit

# 代码格式化 (如果配置了 Prettier)
npx prettier --write .

# 构建
npm run build

# 测试
npm run test
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

### 缓存管理
```bash
# 清理所有缓存
npm run clean

# 仅清理 Rust 缓存
rm -rf src-tauri/target
cargo clean

# 仅清理 Node.js 缓存
rm -rf node_modules
npm install
```

## 核心 API 参考

### 前端 API (src/api/tauri-bridge.ts)

#### 文件系统
```typescript
// 扫描目录 - 返回包含 roots 和 files 的对象
await scanDirectory(path: string, forceRefresh?: boolean): Promise<{ roots: string[]; files: Record<string, FileNode> }>

// 强制完整扫描目录
await forceRescan(path: string): Promise<{ roots: string[]; files: Record<string, FileNode> }>

// 扫描单个文件
await scanFile(filePath: string, parentId?: string | null): Promise<FileNode>

// 文件操作
await renameFile(oldPath: string, newPath: string): Promise<void>
await deleteFile(path: string): Promise<void>
await copyFile(srcPath: string, destPath: string): Promise<string>  // 返回实际路径
await copyImageColors(srcPath: string, destPath: string): Promise<boolean>  // 复制颜色信息
await copyImageToClipboard(filePath: string): Promise<void>  // 复制图片到剪贴板
await moveFile(srcPath: string, destPath: string): Promise<void>
await writeFileFromBytes(filePath: string, bytes: Uint8Array): Promise<void>

// 缩略图
await getThumbnail(filePath: string, modified?: string, rootPath?: string, signal?: AbortSignal, onColors?: (colors: DominantColor[] | null) => void): Promise<string | null>
getAssetUrl(filePath: string): string

// 颜色相关
await getDominantColors(filePath: string, count?: number, thumbnailPath?: string): Promise<DominantColor[]>
await searchByColor(targetHex: string): Promise<string[]>
await searchByPalette(palette: string[]): Promise<string[]>

// 拖拽
await generateDragPreview(thumbnailPaths: string[], totalCount: number, cacheRoot: string): Promise<string | null>
await startDragToExternal(filePaths: string[], thumbnailPaths?: string[], cacheRoot?: string, onDragEnd?: () => void): Promise<void>
```

#### 数据库操作
```typescript
// 人物管理
await dbGetAllPeople(): Promise<Person[]>
await dbUpsertPerson(person: Person): Promise<void>
await dbDeletePerson(id: string): Promise<void>
await dbUpdatePersonAvatar(personId: string, coverFileId: string, faceBox: any): Promise<void>

// 专题管理
await dbGetAllTopics(): Promise<Topic[]>
await dbUpsertTopic(topic: Topic): Promise<void>
await dbDeleteTopic(id: string): Promise<void>

// 文件元数据
await dbUpsertFileMetadata(metadata: FileMetadata): Promise<void>
await dbCopyFileMetadata(srcPath: string, destPath: string): Promise<void>

// 数据库切换
await switchRootDatabase(newRootPath: string): Promise<void>

// 批量添加文件到 pending 表
await addPendingFilesToDb(filePaths: string[]): Promise<number>
```

#### 窗口管理
```typescript
await hideWindow(): Promise<void>
await showWindow(): Promise<void>
await setWindowMinSize(width: number, height: number): Promise<void>
await isWindowMaximized(): Promise<boolean>
await exitApp(): Promise<void>
```

#### 色彩提取控制
```typescript
await pauseColorExtraction(): Promise<boolean>
await resumeColorExtraction(): Promise<boolean>
```

## Hooks 使用示例

### useNavigation
```tsx
import { useNavigation } from './hooks/useNavigation'

function MyComponent() {
  const { navigateTo, goBack, goForward, canGoBack, canGoForward } = useNavigation()
  
  // 导航到文件夹
  const handleNavigate = () => {
    navigateTo('/path/to/folder', { 
      selectedIds: ['file1', 'file2'],
      scrollPosition: 100 
    })
  }
  
  return (
    <div>
      <button onClick={goBack} disabled={!canGoBack}>后退</button>
      <button onClick={goForward} disabled={!canGoForward}>前进</button>
    </div>
  )
}
```

### useTasks
```tsx
import { useTasks } from './hooks/useTasks'

function MyComponent() {
  const { tasks, startTask, updateTask, pauseTask, resumeTask } = useTasks()
  
  // 启动新任务
  const handleStartTask = () => {
    startTask({
      id: 'task-1',
      type: 'copy',
      title: '复制文件',
      totalItems: 100
    })
  }
  
  return <TaskProgressModal tasks={tasks} />
}
```

### useAIAnalysis
```tsx
import { useAIAnalysis } from './hooks/useAIAnalysis'

function MyComponent() {
  const { analyzeFile, analyzeFolder, isAnalyzing } = useAIAnalysis()
  
  // 分析单个文件
  const handleAnalyze = async (filePath: string) => {
    const result = await analyzeFile(filePath, {
      generateDescription: true,
      generateTags: true,
      performOCR: true,        // OCR 识别
      translateText: true      // 翻译
    })
  }
  
  return <button onClick={() => handleAnalyze('/path/to/image.jpg')}>分析</button>
}
```

### useAIRename (新增)
```tsx
import { useAIRename } from './hooks/useAIRename'

function MyComponent() {
  const { isGenerating, previewName, generateName, applyRename, cancelRename } = useAIRename({
    settings,
    people,
    onUpdate: (id, updates) => updateFile(id, updates),
    showToast: (msg) => toast(msg),
    t: (key) => translate(key)
  })
  
  // 生成 AI 文件名
  const handleGenerate = async (file: FileNode) => {
    await generateName(file)
  }
  
  // 应用重命名
  const handleApply = async (file: FileNode) => {
    await applyRename(file)
  }
  
  return (
    <div>
      {isGenerating && <span>生成中...</span>}
      {previewName && (
        <div>
          <span>预览: {previewName}</span>
          <button onClick={() => handleApply(file)}>确认</button>
          <button onClick={cancelRename}>取消</button>
        </div>
      )}
    </div>
  )
}
```

### useFileOperations
```tsx
import { useFileOperations } from './hooks/useFileOperations'

function MyComponent() {
  const { copyFiles, moveFiles, deleteFiles } = useFileOperations()
  
  const handleCopy = async (files: string[], destPath: string) => {
    await copyFiles(files, destPath, {
      onProgress: (progress) => console.log(`${progress.percentage}%`),
      overwriteExisting: false
    })
  }
  
  return <button onClick={() => handleCopy(['file1.jpg'], '/dest')}>复制</button>
}
```

### useKeyboardShortcuts
```tsx
import { useKeyboardShortcuts } from './hooks/useKeyboardShortcuts'

function MyComponent() {
  useKeyboardShortcuts({
    'Ctrl+C': () => handleCopy(),
    'Ctrl+V': () => handlePaste(),
    'Delete': () => handleDelete(),
    'Escape': () => handleClose()
  })
  
  return <div>...</div>
}
```

### useInView (新增)
```tsx
import { useInView } from './hooks/useInView'

function MyComponent() {
  const [ref, isInView, wasInView] = useInView({ threshold: 0.1 })
  
  return (
    <div ref={ref}>
      {isInView ? '当前可见' : '不可见'}
      {wasInView && '曾经可见过'}
    </div>
  )
}
```

### useToasts (新增)
```tsx
import { useToasts } from './hooks/useToasts'

function MyComponent() {
  const { toast, showToast, hideToast } = useToasts()
  
  const handleShow = () => {
    showToast('操作成功！', 2000)  // 显示 2 秒
  }
  
  return (
    <div>
      <button onClick={handleShow}>显示 Toast</button>
      {toast.visible && <div className={toast.isLeaving ? 'leaving' : ''}>{toast.msg}</div>}
    </div>
  )
}
```

## 组件使用示例

### ColorPickerPopover
```tsx
import { ColorPickerPopover } from './components/ColorPickerPopover'

function ColorSearchComponent() {
  const [color, setColor] = useState('#ff0000')
  const [open, setOpen] = useState(false)

  return (
    <div>
      <button onClick={() => setOpen(true)}>选择颜色</button>
      {open && (
        <ColorPickerPopover
          initialColor={color}
          onChange={setColor}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  )
}
```

### PersonGrid
```tsx
import { PersonGrid } from './components/PersonGrid'

function PersonView({ people, files, selectedIds, onSelect, onDoubleClick, onContextMenu, t }) {
  return (
    <PersonGrid
      people={people}
      files={files}
      selectedPersonIds={selectedIds}
      onPersonClick={onSelect}
      onPersonDoubleClick={onDoubleClick}
      onPersonContextMenu={onContextMenu}
      t={t}
    />
  )
}
```

### ImageComparer
```tsx
import { ImageComparer } from './components/ImageComparer'

function CompareView() {
  return (
    <ImageComparer
      files={[
        { id: '1', path: '/path/to/image1.jpg' },
        { id: '2', path: '/path/to/image2.jpg' }
      ]}
      onClose={() => {}}
    />
  )
}
```

### FileListItem
```tsx
import { FileListItem } from './components/FileListItem'

function FileList() {
  return (
    <FileListItem
      file={file}
      isSelected={selected}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
    />
  )
}
```

### AIRenameButton & AIRenamePreview (新增)
```tsx
import { AIRenameButton } from './components/AIRenameButton'
import { AIRenamePreview } from './components/AIRenamePreview'

function RenameComponent() {
  return (
    <div>
      <AIRenameButton
        onClick={handleGenerate}
        isGenerating={isGenerating}
        t={t}
      />
      {previewName && (
        <AIRenamePreview
          previewName={previewName}
          onApply={handleApply}
          onCancel={handleCancel}
          t={t}
        />
      )}
    </div>
  )
}
```

### 系统提示预设管理 (SettingsModal)
```tsx
// 在 SettingsModal 中管理 AI 提示预设
interface PromptPreset {
  id: string;
  name: string;
  content: string;
}

// 使用预设
const preset = aiSettings.promptPresets?.find(p => p.id === currentPresetId);
if (preset) {
  setSystemPrompt(preset.content);
}
```

## 故障排除

### 常见问题

#### 开发模式白屏或 500 错误
```bash
# 核心解决：使用自愈清理脚本强制重置环境
npm run clean
```
- **原理**: 该命令会释放端口占用、清理错误缓存并注入跳转补丁。

#### Rust 编译错误
```bash
# 清理 Rust 缓存
rm -rf src-tauri/target
cargo clean
cargo build
```

#### 依赖冲突
```bash
# 重新安装依赖
rm -rf node_modules
npm install
```

#### 数据库问题
```bash
# 检查 SQLite 文件 (Windows)
dir "%APPDATA%\aurora-gallery-tauri"

# 检查 SQLite 文件 (macOS/Linux)
ls -la ~/.config/aurora-gallery-tauri/
```

### 性能优化

#### 前端优化
- 使用 `React.memo` 避免不必要的重渲染
- 使用 `useMemo` 缓存 expensive 计算
- 使用 `useCallback` 稳定函数引用
- 实现虚拟滚动处理大数据集
- 使用 Web Worker 进行布局计算

#### 后端优化
- 使用 Rayon 进行并行处理
- 实现连接池管理数据库连接
- 使用缓存减少重复计算
- 实现渐进式加载
- 使用 WAL 模式优化 SQLite 性能

## 开发提示

### 代码规范
- 使用 TypeScript 严格模式
- 遵循 React Hooks 规则
- 使用 ESLint 和 Prettier
- 编写有意义的提交信息

### 测试策略
- 单元测试关键工具函数
- 集成测试 API 桥接
- E2E 测试用户流程
- 性能测试大数据集处理

### 调试技巧
- 使用 React DevTools 检查组件树
- 使用 Tauri DevTools 调试原生功能
- 查看控制台日志和错误信息
- 使用性能监控工具识别瓶颈

## 版本信息

- **前端**: React 18.2.0, TypeScript 5.2.2, Vite 5.1.4
- **后端**: Tauri 2.0, Rust 2021
- **数据库**: SQLite 3.x (通过 Rusqlite)
- **AI**: face-api.js 1.7.12, OpenAI API
- **UI**: Tailwind CSS 3.4.1, Lucide Icons 0.344.0
- **测试**: Vitest (单元测试框架)

## 更新日志

### 2026-02-11 更新
- 新增 `useAIRename` Hook 用于 AI 智能重命名
- 新增 `useInView` Hook 用于视口检测
- 新增 `useToasts` Hook 用于 Toast 通知管理
- 新增 `AIRenameButton` 和 `AIRenamePreview` 组件
- 新增 `copyImageToClipboard` API 用于复制图片到剪贴板
- 新增 `setWindowMinSize` API 用于设置窗口最小尺寸
- 新增专题数据库 API (`dbGetAllTopics`, `dbUpsertTopic`, `dbDeleteTopic`)
- 更新 `scanDirectory` API 返回类型为 `{ roots: string[]; files: Record<string, FileNode> }`
- 新增 `AIBatchRenameModal` 和 `AddImageModal` 模态框

### 2026-02-07 更新
- 新增 `useNavigation` Hook 用于导航历史管理
- 新增 `useKeyboardShortcuts` Hook 用于键盘快捷键
- 新增 `ImageComparer` 组件用于图片对比
- 新增 `FileListItem` 组件用于文件列表显示
- 新增 `generateDragPreview` API 用于生成拖拽预览
- 新增 `copyImageColors` API 用于复制图片颜色信息
- 更新 `scanDirectory` API 返回类型
- 添加 Vitest 测试框架支持
- 新增 OCR 和翻译功能支持

### 2026-01-14 更新
- 新增 PersonGrid 组件
- 优化 AI 分析流程（移除 dominantColors AI 分析）
- 增强 SettingsModal 系统提示预设功能
- 更新构建脚本支持并行开发
- 改进上下文菜单样式

---

**文档版本**: 1.3  
**更新日期**: 2026-02-11  
**维护者**: Aurora Gallery Team
