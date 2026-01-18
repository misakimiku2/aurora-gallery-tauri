# Aurora Gallery Tauri 项目结构文档

## 项目概述
这是一个基于 Tauri + React + TypeScript 构建的跨平台图片管理应用，支持图片浏览、AI分析、人脸识别、色彩提取等功能。

## 完整目录树

```
aurora-gallery-tauri/
├── 📁 src/                          # 前端 React 代码 (TypeScript)
│   ├── 📁 api/                      # API 桥接层
│   │   └── tauri-bridge.ts          # Tauri 原生功能桥接 (933 行) （以源码为准 · 已同步）
│   ├── 📁 components/               # React 组件库
│   │   ├── 📁 modals/                 # 模态框组件集合 [新增]
│   │   │   ├── AddToPersonModal.tsx     # 添加到人物
│   │   │   ├── AddToTopicModal.tsx      # 添加到专题
│   │   │   ├── AlertModal.tsx           # 警告提示
│   │   │   ├── BatchRenameModal.tsx     # 批量重命名
│   │   │   ├── ClearPersonModal.tsx     # 清除人物信息
│   │   │   ├── ConfirmModal.tsx         # 通用确认
│   │   │   ├── CropAvatarModal.tsx      # 头像裁剪
│   │   │   ├── ExitConfirmModal.tsx     # 退出确认
│   │   │   ├── FolderPickerModal.tsx    # 文件夹选择
│   │   │   ├── RenamePersonModal.tsx    # 人物重命名
│   │   │   ├── RenameTagModal.tsx       # 标签重命名
│   │   │   ├── TagEditor.tsx            # 标签编辑器
│   │   │   └── WelcomeModal.tsx         # 欢迎向导
│   │   ├── App.tsx                  # 主应用组件 (瘦身重构)
│   │   ├── AppModals.tsx           # 应用模态框集中渲染入口（汇总所有业务模态框）
│   │   ├── PersonGrid.tsx           # 人物网格组件 (224 行) （以源码为准 · 已同步）
│   │   ├── MetadataPanel.tsx        # 元数据面板组件
│   │   ├── ImageViewer.tsx          # 图片查看器组件
│   │   ├── FileGrid.tsx             # 文件网格视图组件
│   │   ├── TreeSidebar.tsx          # 树形侧边栏组件
│   │   ├── TopBar.tsx               # 顶部工具栏组件
│   │   ├── TabBar.tsx               # 标签页管理组件
│   │   ├── TaskProgressModal.tsx    # 任务进度模态框
│   │   ├── SettingsModal.tsx        # 设置模态框组件
│   │   ├── TopicModule.tsx          # 专题模块组件
│   │   ├── SequenceViewer.tsx       # 序列查看器组件
│   │   ├── DragDropOverlay.tsx      # 拖拽覆盖层组件
│   │   ├── CloseConfirmationModal.tsx # 关闭确认模态框
│   │   ├── SplashScreen.tsx         # 启动画面组件
│   │   ├── Logo.tsx                 # Logo 组件
│   │   ├── FolderIcon.tsx           # 文件夹图标组件
│   │   ├── ColorPickerPopover.tsx   # 颜色选择弹出组件
│   │   ├── ContextMenu.tsx          # 右键上下文菜单组件
│   │   ├── ToastItem.tsx            # 通知/吐司项组件
│   │   └── useLayoutHook.ts         # 布局管理 Hook
│   ├── 📁 hooks/                    # 自定义 Hooks [新增]
│   │   ├── useAIAnalysis.ts         # AI 分析相关 Hook（文件/文件夹级别分析）
│   │   ├── useContextMenu.ts        # 右键/上下文菜单交互 Hook
│   │   ├── useFileOperations.ts     # 文件复制/移动/删除等操作封装
│   │   ├── useFileSearch.ts         # 搜索逻辑 Hook（包含 color/palette 处理）
│   │   ├── useMarqueeSelection.ts   # 框选逻辑 Hook
│   │   └── useTasks.ts              # 任务管理 Hook
│   ├── 📁 services/                 # 业务服务层
│   │   ├── aiService.ts             # AI 服务
│   │   └── faceRecognitionService.ts # 人脸识别服务
│   ├── 📁 utils/                    # 工具函数库
│   │   ├── async.ts                 # 异步工具与文件 I/O 包装 (19 行)
│   │   ├── debounce.ts              # 防抖函数 (72 行)（以源码为准 · 已同步）
│   │   ├── environment.ts           # 环境检测工具 (62 行)
│   │   ├── logger.ts                # 日志记录工具 (228 行)
│   │   ├── mockFileSystem.ts        # 模拟文件系统 (341 行)
│   │   ├── performanceMonitor.ts    # 性能监控工具 (452 行)（以源码为准 · 已同步）
│   │   ├── textUtils.ts             # 文本处理工具 (42 行)
│   │   └── translations.ts          # 多语言支持 (1114 行)
│   ├── 📁 workers/                  # Web Workers
│   │   └── layout.worker.ts         # 布局计算工作器
│   ├── constants.ts                 # 全局常量定义 [新增]
│   ├── types.ts                     # TypeScript 类型定义
│   └── main.tsx                     # 应用入口文件
├── 📁 src-tauri/                    # Rust 后端代码
│   ├── 📁 src/
│   │   ├── main.rs                  # Tauri 主程序入口 (2614 行) （以源码为准 · 已同步）
│   │   ├── color_db.rs              # 色彩数据库操作 (871 行) （以源码为准 · 已同步）
│   │   ├── color_extractor.rs       # 色彩提取算法 (258 行)
│   │   ├── color_worker.rs          # 后台色彩处理工作器 (796 行) （以源码为准 · 已同步）
│   │   └── 📁 db/
│   │       ├── mod.rs               # 数据库模块
│   │       ├── persons.rs           # 人物数据库操作
│   │       └── file_metadata.rs     # 文件元数据存储 [新增]
│   ├── 📁 icons/                    # 应用图标 (多尺寸)
│   │   ├── android/
│   │   │   ├── mipmap-anydpi-v26/
│   │   │   ├── mipmap-hdpi/
│   │   │   ├── mipmap-mdpi/
│   │   │   ├── mipmap-xhdpi/
│   │   │   ├── mipmap-xxhdpi/
│   │   │   └── mipmap-xxxhdpi/
│   │   └── ios/
│   ├── 📁 capabilities/             # Tauri 权限配置
│   │   └── default.json             # 默认权限配置
│   ├── 📁 gen/                      # 生成的文件
│   │   └── 📁 schemas/              # Tauri 模式文件
│   │       ├── acl-manifests.json
│   │       ├── capabilities.json
│   │       ├── desktop-schema.json
│   │       └── windows-schema.json
│   ├──                    # Rust 依赖配置
│   ├── tauri.conf.json              # Tauri 配置
│   ├── build.rs                     # Rust 构建脚本
│   └── Cargo.lock                   # Rust 依赖锁定
├── 📁 public/                       # 静态资源
│   ├── 📁 models/                   # AI 模型文件 (二进制)
│   │   ├── age_gender_model-weights_manifest.json
│   │   ├── face_expression_model-weights_manifest.json
│   │   ├── face_landmark_68_model-weights_manifest.json
│   │   ├── face_landmark_68_tiny_model-weights_manifest.json
│   │   ├── face_recognition_model-weights_manifest.json
│   │   └── ssd_mobilenetv1_model-weights_manifest.json
│   ├── react.svg                    # React Logo
│   └── tauri.svg                    # Tauri Logo
├── 📁 memory/                       # 项目文档
│   ├──              # API 参考文档（与代码实现对应）
│   ├──        # 模块分布说明（组件与服务映射）
│   ├──          # 项目结构文档（本文件）
│   ├──            # 快速参考指南（常用命令与 API 速查）
│   ├──     # 技术架构文档（系统/并发/数据库等）
│   └──        # 代码变更日志 [更新]
├── 📁 .vscode/                      # VSCode 配置
│   ├── settings.json
│   └── extensions.json
├── 📁 .specstory/                   # 规格说明
├── package.json                      # Node.js 依赖配置 [更新]
├── package-lock.json                 # Node.js 依赖锁定
├── tsconfig.json                     # TypeScript 配置
├── tsconfig.node.json                # TypeScript Node 配置
├── vite.config.ts                    # Vite 构建配置 [更新]
├── tailwind.config.js                # Tailwind CSS 配置
├── postcss.config.js                 # PostCSS 配置
├── index.html                        # HTML 入口
├── index.css                         # 全局样式
├── clean-cache.bat                   # Windows 缓存清理脚本
├── clean-cache.ps1                   # PowerShell 缓存清理脚本
├── temp_api.ts                       # 临时 API 文件
└── query_colors_db.py                # 颜色数据库查询脚本
```

## 技术栈

### 前端技术栈
- **框架**: React 18.2.0 + TypeScript 5.2.2
- **构建工具**: Vite 5.1.4
- **样式**: Tailwind CSS 3.4.1 + PostCSS 8.4.35
- **状态管理**: React Hooks (useState, useReducer)
- **UI 组件**: Lucide React 0.344.0 (图标库)
- **AI 集成**: @vladmandic/face-api 1.7.12 (人脸识别)

### 后端技术栈
- **框架**: Tauri 2.0
- **语言**: Rust 2021 Edition
- **图像处理**: image 0.24, fast_image_resize 3.0
- **并发**: Tokio 1, Rayon 1.8
- **数据库**: Rusqlite 0.30 (SQLite)
- **色彩科学**: palette 0.7 (CIEDE2000 颜色差异)

### 开发工具
- **包管理**: npm
- **代码质量**: ESLint (隐含), Prettier (隐含)
- **类型检查**: TypeScript
- **并发运行**: concurrently 9.2.1, wait-on 9.0.3

## 构建和运行

### 开发环境
```bash
# 安装依赖
npm install

# 开发模式运行（前后端并行）
npm run tauri:dev

# 或分别运行
npm run dev          # 前端开发服务器 (http://localhost:14422)
wait-on http://localhost:14422 && cargo tauri dev  # 等待前端启动后运行 Tauri
```

### 生产构建
```bash
npm run build
cargo tauri build
```

### 缓存清理
```bash
npm run clean
```

## 架构特点

### 前端架构
- **组件化**: 基于 React 的组件化架构
- **类型安全**: 完整的 TypeScript 类型定义
- **响应式设计**: 支持多种屏幕尺寸
- **国际化**: 多语言支持
- **性能优化**: 虚拟滚动、懒加载、防抖等

### 后端架构
- **跨平台**: 基于 Tauri 的原生桌面应用
- **高性能**: Rust 保证的性能和内存安全
- **并发处理**: 多线程颜色提取和 AI 分析
- **数据库**: SQLite 嵌入式数据库
- **插件化**: Tauri 插件系统

### 数据流
```
用户操作 → React 组件 → Tauri Bridge → Rust 后端 → SQLite 数据库
     ↑           ↓            ↓            ↓         ↓
   UI 更新 ← 状态更新 ← 进度事件 ← 处理结果 ← 查询/更新
```

## 关键文件说明

### 核心文件
- `src/App.tsx`: 主应用组件，包含所有业务逻辑
- `src-tauri/src/main.rs`: Rust 主程序，Tauri 命令处理
- `src/api/tauri-bridge.ts`: 前后端通信桥接
- `src/types.ts`: TypeScript 类型定义

### 配置文件
- `package.json`: Node.js 项目配置和脚本
- `Cargo.toml`: Rust 项目配置
- `tauri.conf.json`: Tauri 应用配置
- `vite.config.ts`: 前端构建配置

### 文档文件
- `memory/`: 项目文档目录
  - `API_REFERENCE.md`: API 参考文档
  - `MODULE_DISTRIBUTION.md`: 模块分布详解
  - `PROJECT_STRUCTURE.md`: 项目结构说明
  - `QUICK_REFERENCE.md`: 快速参考指南
  - `TECHNICAL_ARCHITECTURE.md`: 技术架构文档
  - `CHANGELOG_from_code.md`: 代码变更日志

## 开发工作流

1. **功能开发**: 在 `src/` 目录下开发 React 组件
2. **API 扩展**: 在 `tauri-bridge.ts` 添加前端 API
3. **后端实现**: 在 `src-tauri/src/` 实现 Rust 命令
4. **类型定义**: 在 `types.ts` 更新类型定义
5. **文档更新**: 在 `memory/` 更新相关文档
6. **测试构建**: 运行 `npm run tauri:dev` 测试功能

## 注意事项

- 前端使用 React 18 的新特性 (Concurrent Features)
- 后端使用 Rust 2021 Edition
- 支持 Windows、macOS、Linux 平台
- AI 功能需要外部 API (OpenAI/Ollama/LM Studio)
- 颜色提取使用 CIEDE2000 算法保证准确性