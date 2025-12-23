# 系统架构文档

## 整体架构设计

### 架构模式
```
┌─────────────────────────────────────────────────────────────┐
│                    Aurora Gallery Tauri                     │
├─────────────────────────────────────────────────────────────┤
│  前端层 (React + TypeScript)  │  后端层 (Rust + Tauri)      │
├───────────────────────────────┼─────────────────────────────┤
│  UI 组件                      │  文件系统操作               │
│  状态管理                     │  图片处理引擎               │
│  事件处理                     │  AI 集成接口                │
│  API 调用                     │  数据持久化                 │
└───────────────────────────────┴─────────────────────────────┘
```

## 前端架构

### React 组件层次结构
```
App (主容器)
├── SplashScreen (启动画面)
├── TabBar (标签页栏)
├── TopBar (顶部工具栏)
│   ├── SearchBar (搜索)
│   ├── ViewControls (视图控制)
│   ├── SortControls (排序)
│   └── SettingsButton (设置)
├── MainContainer (主内容区)
│   ├── Sidebar (侧边栏)
│   │   ├── FolderTree (文件夹树)
│   │   ├── TagList (标签列表)
│   │   ├── PeopleList (人物列表)
│   │   └── TaskProgress (任务进度)
│   ├── ContentArea (内容区)
│   │   ├── FileGrid (文件网格)
│   │   ├── ImageViewer (图片查看器)
│   │   └── SequenceViewer (序列查看器)
│   └── MetadataPanel (元数据面板)
├── Modals (模态框系统)
│   ├── SettingsModal (设置)
│   ├── TagEditor (标签编辑)
│   ├── PersonManager (人物管理)
│   ├── FolderPicker (文件夹选择)
│   └── ConfirmDialog (确认对话框)
└── ContextMenu (右键菜单)
```

### 状态管理架构
```typescript
interface AppState {
  // 文件系统
  roots: string[]                    // 根目录 ID 列表
  files: Record<string, FileNode>    // 文件节点映射
  expandedFolderIds: string[]        // 展开的文件夹
  
  // 用户数据
  people: Record<string, Person>     // 人物管理
  customTags: string[]               // 自定义标签
  folderSettings: Record<string, FolderSetting> // 文件夹设置
  
  // 标签页管理
  tabs: TabState[]                   // 多标签页
  activeTabId: string                // 当前激活标签页
  
  // 视图状态
  sortBy: SortOption                 // 排序字段
  sortDirection: 'asc' | 'desc'      // 排序方向
  thumbnailSize: number              // 缩略图大小
  layout: LayoutState                // 布局状态
  
  // 用户设置
  settings: AppSettings              // 应用设置
  isSettingsOpen: boolean            // 设置面板状态
  
  // 模态框
  activeModal: ModalState            // 当前模态框
  
  // 任务系统
  tasks: TaskProgress[]              // 任务队列
  
  // AI 状态
  aiConnectionStatus: string         // AI 连接状态
}
```

### 数据流设计
```
用户交互 → 事件处理器 → 状态更新 → UI 重渲染 → API 调用 → 数据持久化
     ↑            ↓           ↓           ↓           ↓           ↓
   React      setState    Component   Tauri      Rust       JSON
   Hooks      (Async)     Render     Command    Handler    File
```

## 后端架构

### Rust 模块结构
```
main.rs (主程序)
├── 数据结构定义
│   ├── FileType (枚举)
│   ├── ImageMeta (结构体)
│   └── FileNode (结构体)
├── 核心功能模块
│   ├── scan_directory()          // 目录扫描
│   ├── 文件操作命令
│   │   ├── copy_file()           // 复制
│   │   ├── move_file()           // 移动
│   │   ├── rename_file()         // 重命名
│   │   └── delete_file()         // 删除
│   ├── 缩略图生成
│   │   ├── process_single_thumbnail()
│   │   ├── get_thumbnail()
│   │   └── get_thumbnails_batch()
│   └── 数据持久化
│       ├── save_user_data()
│       └── load_user_data()
├── AI 集成接口
│   ├── OpenAI 客户端
│   ├── Ollama 客户端
│   └── LM Studio 客户端
└── 系统集成
    ├── 窗口控制
    ├── 文件管理器集成
    └── 托盘图标管理
```

### 并发处理模型
```rust
// 使用 Rayon 实现数据并行处理
file_nodes.par_iter()  // 并行迭代
    .filter_map(|entry| {
        // 并行处理每个文件
        process_file(entry)
    })
    .collect()

// 使用 Tokio 实现异步 I/O
async fn scan_directory(path: String) -> Result<...> {
    // 异步文件操作
    let entries = tokio::fs::read_dir(path).await?;
    // 并行处理
    tauri::async_runtime::spawn_blocking(|| {
        // CPU 密集型任务
        process_files_parallel(entries)
    }).await
}
```

### 缩略图生成流水线
```
输入图片 → 格式检测 → 内存映射 → 并行解码 → 
尺寸计算 → 快速缩放 → 质量压缩 → 缓存存储 → 输出路径
```

## AI 集成架构

### 多提供商支持
```typescript
interface AIProvider {
  analyzeImage(image: string, prompt: string): Promise<AIResult>;
  extractText(image: string): Promise<string>;
  translateText(text: string, target: string): Promise<string>;
  detectFaces(image: string): Promise<FaceInfo[]>;
}

// 提供商实现
class OpenAIProvider implements AIProvider { /* ... */ }
class OllamaProvider implements AIProvider { /* ... */ }
class LMStudioProvider implements AIProvider { /* ... */ }
```

### AI 分析流程
```
图片数据 → Base64 编码 → AI 提示词构建 → API 调用 → 
JSON 解析 → 数据验证 → 状态更新 → UI 反馈
```

### 人物识别系统
```
图片 → 人脸检测 → 特征提取 → 人物匹配 → 
    → 新人物创建 → 关联更新 → 计数统计 → UI 更新
```

## 数据持久化架构

### 存储结构
```json
{
  "rootPaths": ["C:/Pictures/Gallery"],
  "customTags": ["风景", "人物", "事件"],
  "people": {
    "person_id": {
      "id": "person_id",
      "name": "张三",
      "coverFileId": "file_id",
      "count": 15,
      "description": "描述",
      "faceBox": {"x": 0, "y": 0, "w": 0, "h": 0}
    }
  },
  "folderSettings": {
    "folder_id": {
      "layoutMode": "grid",
      "sortBy": "date",
      "groupBy": "none"
    }
  },
  "settings": {
    "theme": "system",
    "language": "zh",
    "ai": { /* AI 配置 */ }
  },
  "fileMetadata": {
    "file_path": {
      "tags": ["tag1", "tag2"],
      "description": "描述",
      "aiData": { /* AI 分析结果 */ }
    }
  }
}
```

### 缓存系统
```
缩略图缓存: .Aurora_Cache/{hash}.jpg|webp
    ├── 快速哈希 (文件大小 + 修改时间 + 前4KB)
    ├── 自动清理 (LRU 策略)
    └── 格式优化 (JPEG/WebP 自动选择)

AI 结果缓存: 内存 + 可选持久化
    ├── 分析结果缓存
    ├── OCR 结果缓存
    └── 翻译结果缓存
```

## 通信机制

### 前后端通信
```typescript
// 前端调用后端
const result = await invoke<T>('command_name', { param1, param2 });

// 后端命令定义
#[tauri::command]
async fn command_name(param1: String) -> Result<T, String> {
    // 处理逻辑
    Ok(result)
}
```

### 事件系统
```rust
// 后端事件推送到前端
app.emit("progress-event", ProgressData {
    task_id: "123",
    current: 50,
    total: 100,
    message: "处理中..."
}).unwrap();
```

## 性能优化策略

### 1. 图片处理优化
- **流式处理**: 大文件不一次性加载到内存
- **硬件加速**: 使用 GPU 进行图片缩放
- **并行处理**: 多核 CPU 充分利用
- **智能缓存**: 多级缓存策略

### 2. 内存管理
- **对象池**: 复用对象减少 GC
- **懒加载**: 按需加载图片数据
- **虚拟滚动**: 大列表性能优化
- **内存限制**: 防止内存泄漏

### 3. I/O 优化
- **异步操作**: 不阻塞主线程
- **批量处理**: 减少系统调用次数
- **缓冲策略**: 优化磁盘读写
- **预取机制**: 提前加载可能需要的数据

### 4. UI 性能
- **React 优化**: useMemo, useCallback, memo
- **虚拟化**: 长列表虚拟滚动
- **防抖节流**: 搜索和滚动优化
- **Web Workers**: 复杂计算异步化

## 安全架构

### 权限控制
```
文件系统访问: 只读/读写 (用户选择的目录)
网络访问: 可选 (AI 功能需要)
系统资源: 最小化使用
```

### 数据安全
- **本地存储**: 所有数据不离开本地
- **API 密钥**: 安全存储在系统密钥环
- **输入验证**: 防止注入攻击
- **错误隔离**: 单个功能失败不影响整体

## 扩展性设计

### 插件系统 (未来)
```typescript
interface Plugin {
  name: string;
  version: string;
  init(context: AppContext): void;
  hooks: {
    onFileProcessed?: (file: FileNode) => void;
    onAIResult?: (result: AIResult) => void;
    // ...
  };
}
```

### 配置驱动
- **功能开关**: 通过配置启用/禁用功能
- **UI 定制**: 主题、布局可配置
- **AI 提供商**: 易于添加新的 AI 服务
- **文件格式**: 支持扩展新的图片格式

## 部署架构

### 构建流程
```
源代码 → 类型检查 → 代码优化 → 资源打包 → 
    → Rust 编译 → 二进制链接 → 签名 → 安装包生成
```

### 分发格式
- **Windows**: MSI 安装包 + 自动更新
- **macOS**: DMG 包 + 代码签名
- **Linux**: AppImage + DEB/RPM

## 监控和调试

### 日志系统
```
前端日志: 浏览器控制台 + 文件日志
后端日志: 系统日志 + 应用日志文件
性能监控: 内存使用、CPU 占用、响应时间
```

### 错误报告
- **自动收集**: 崩溃信息和堆栈跟踪
- **用户反馈**: 手动错误报告
- **性能指标**: 关键操作耗时统计

---

*本文档描述了 Aurora Gallery Tauri 的完整系统架构，作为技术设计和开发的参考。*