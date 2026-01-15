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
wait-on http://localhost:14422 && cargo tauri dev  # 等待前端启动后运行 Tauri
```

### 生产构建
```bash
npm run build
cargo tauri build
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

# 仅清理 Node.js 缓存
rm -rf 
```

## 核心 API 参考

### 前端 API (src/api/tauri-bridge.ts)

#### 文件系统
```typescript
// 扫描目录
await scanDirectory(path: string, forceRefresh?: boolean): Promise<{ roots: string[]; files: Record<string, FileNode> }>

// 扫描单个文件
await scanFile(filePath: string, parentId?: string): Promise<FileNode>

// 文件操作
await renameFile(oldPath: string, newPath: string): Promise<void>
await deleteFile(path: string): Promise<void>
await copyFile(srcPath: string, destPath: string): Promise<void>
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
await startDragToExternal(filePaths: string[], thumbnailPaths?: string[], cacheRoot?: string, onDragEnd?: () => void): Promise<void>
```

#### 数据库操作
```typescript
// 人物管理
await dbGetAllPeople(): Promise<any[]>
await dbUpsertPerson(person: any): Promise<void>
await dbDeletePerson(id: string): Promise<void>
await dbUpdatePersonAvatar(personId: string, coverFileId: string, faceBox: any): Promise<void>
```

#### 窗口管理
```typescript
await hideWindow(): Promise<void>
await showWindow(): Promise<void>
await exitApp(): Promise<void>
```

#### 色彩提取控制
```typescript
await pauseColorExtraction(): Promise<boolean>
await resumeColorExtraction(): Promise<boolean>
```

## 组件使用示例

### ColorPickerPopover 使用
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

### PersonGrid 使用 (新增)
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

### 系统提示预设管理 (SettingsModal 新增功能)
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
npm run clean:dev
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
# 检查 SQLite 文件
ls -la ~/.config/aurora-gallery-tauri/
```

### 性能优化

#### 前端优化
- 使用 `React.memo` 避免不必要的重渲染
- 使用 `useMemo` 缓存 expensive 计算
- 使用 `useCallback` 稳定函数引用
- 实现虚拟滚动处理大数据集

#### 后端优化
- 使用 Rayon 进行并行处理
- 实现连接池管理数据库连接
- 使用缓存减少重复计算
- 实现渐进式加载

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

## 更新日志

### 2026-01-14 更新
- 新增 PersonGrid 组件
- 优化 AI 分析流程（移除 dominantColors AI 分析）
- 增强 SettingsModal 系统提示预设功能
- 更新构建脚本支持并行开发
- 改进上下文菜单样式