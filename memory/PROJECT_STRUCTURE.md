# Aurora Gallery Tauri 项目结构文档

## 项目概述
这是一个基于 Tauri + React + TypeScript 构建的跨平台图片管理应用，支持图片浏览、AI分析、人脸识别、色彩提取、局域网共享等功能。

## 完整目录树

```
aurora-gallery-tauri/
├── 📁 src/                          # 前端 React 代码 (TypeScript)
│   ├── 📁 api/                      # API 桥接层
│   │   └── tauri-bridge.ts          # Tauri 原生功能桥接 (2151 行)
│   ├── 📁 components/               # React 组件库
│   │   ├── 📁 modals/               # 模态框组件集合
│   │   │   ├── AddToPersonModal.tsx     # 添加到人物 (180 行)
│   │   │   ├── AddToTopicModal.tsx      # 添加到专题 (74 行)
│   │   │   ├── AlertModal.tsx           # 警告提示 (21 行)
│   │   │   ├── AIBatchRenameModal.tsx   # AI 批量重命名 (376 行)
│   │   │   ├── AddImageModal.tsx        # 添加图片到对比 (1163 行)
│   │   │   ├── AutoGenerateTagsModal.tsx # 自动生成标签 (410 行) [新增]
│   │   │   ├── BatchRenameModal.tsx     # 批量重命名 (57 行)
│   │   │   ├── ClearPersonModal.tsx     # 清除人物信息 (158 行)
│   │   │   ├── ConfirmModal.tsx         # 通用确认 (26 行)
│   │   │   ├── CreateTopicModal.tsx     # 创建专题 (66 行)
│   │   │   ├── CropAvatarModal.tsx      # 头像裁剪 (356 行)
│   │   │   ├── ExitConfirmModal.tsx     # 退出确认 (37 行)
│   │   │   ├── FolderPickerModal.tsx    # 文件夹选择 (141 行)
│   │   │   ├── RenamePersonModal.tsx    # 人物重命名 (29 行)
│   │   │   ├── RenameTagModal.tsx       # 标签重命名 (27 行)
│   │   │   ├── RenameTopicModal.tsx     # 重命名专题 (68 行)
│   │   │   ├── SmartAddToPersonModal.tsx # 智能添加到人物 (505 行) [新增]
│   │   │   ├── SmartCreatePersonModal.tsx # 智能创建人物 (921 行) [新增]
│   │   │   ├── SmartCreateTopicModal.tsx # 智能创建专题 (691 行) [新增]
│   │   │   ├── TagEditor.tsx            # 标签编辑器 (54 行)
│   │   │   ├── UpdateModal.tsx          # 更新模态框 (360 行)
│   │   │   └── WelcomeModal.tsx         # 欢迎向导 (187 行)
│   │   ├── 📁 comparer/             # 图片对比组件
│   │   │   ├── AnnotationLayer.tsx      # 标注图层 (272 行)
│   │   │   ├── ComparerContextMenu.tsx  # 对比视图右键菜单 (134 行)
│   │   │   ├── EditOverlay.tsx          # 编辑覆盖层 (474 行)
│   │   │   └── types.ts                 # 对比组件类型定义 (60 行)
│   │   ├── 📁 __tests__/            # 测试文件
│   │   │   └── EmptyFolderPlaceholder.spec.tsx  # 空文件夹占位符测试
│   │   ├── 📁 settings/             # 设置面板组件 [新增]
│   │   │   └── LanSharePanel.tsx        # 局域网共享设置面板 (346 行)
│   │   ├── App.tsx                  # 主应用组件 (4362 行)
│   │   ├── AppModals.tsx            # 应用模态框集中渲染入口 (575 行)
│   │   ├── PersonGrid.tsx           # 人物网格组件 (440 行)
│   │   ├── PeopleCanvas.tsx         # 人物画布组件 (342 行) [新增]
│   │   ├── MetadataPanel.tsx        # 元数据面板组件 (2409 行)
│   │   ├── ImageViewer.tsx          # 图片查看器组件 (1482 行)
│   │   ├── ImageComparer.tsx        # 图片对比组件 (2039 行)
│   │   ├── FileGrid.tsx             # 文件网格视图组件 (1414 行)
│   │   ├── FileListItem.tsx         # 文件列表项组件 (405 行)
│   │   ├── TreeSidebar.tsx          # 树形侧边栏组件 (1518 行)
│   │   ├── TopBar.tsx               # 顶部工具栏组件 (1141 行)
│   │   ├── TabBar.tsx               # 标签页管理组件 (456 行)
│   │   ├── TaskProgressModal.tsx    # 任务进度模态框 (78 行)
│   │   ├── SettingsModal.tsx        # 设置模态框组件 (3774 行)
│   │   ├── TopicModule.tsx          # 专题模块组件 (2485 行)
│   │   ├── TagsList.tsx             # 标签列表组件 (312 行)
│   │   ├── DragDropOverlay.tsx      # 拖拽覆盖层组件 (126 行)
│   │   ├── CloseConfirmationModal.tsx # 关闭确认模态框 (64 行)
│   │   ├── SplashScreen.tsx         # 启动画面组件 (165 行)
│   │   ├── Logo.tsx                 # Logo 组件 (61 行)
│   │   ├── FolderIcon.tsx           # 文件夹图标组件 (356 行)
│   │   ├── Folder3DIcon.tsx         # 3D 文件夹图标组件 (81 行)
│   │   ├── FolderThumbnail.tsx      # 文件夹缩略图组件 (123 行)
│   │   ├── ImageThumbnail.tsx       # 图片缩略图组件 (138 行)
│   │   ├── ColorPickerPopover.tsx   # 颜色选择弹出组件 (316 行)
│   │   ├── ContextMenu.tsx          # 右键上下文菜单组件 (496 行)
│   │   ├── ToastItem.tsx            # 通知/吐司项组件 (33 行)
│   │   ├── GlobalToasts.tsx         # 全局 Toast 容器 (31 行)
│   │   ├── EmptyFolderPlaceholder.tsx # 空文件夹占位符 (29 行)
│   │   ├── InlineRenameInput.tsx    # 内联重命名输入框 (39 行)
│   │   ├── AIRenameButton.tsx       # AI 重命名按钮 (36 行)
│   │   ├── AIRenamePreview.tsx      # AI 重命名预览 (38 行)
│   │   └── useLayoutHook.ts         # 布局管理 Hook (80 行)
│   ├── 📁 hooks/                    # 自定义 Hooks
│   │   ├── useAIAnalysis.ts         # AI 分析相关 Hook (552 行)
│   │   ├── useAIRename.ts           # AI 重命名 Hook (87 行)
│   │   ├── useContextMenu.ts        # 右键/上下文菜单交互 Hook (80 行)
│   │   ├── useFileOperations.ts     # 文件复制/移动/删除等操作封装 (1053 行)
│   │   ├── useFileSearch.ts         # 搜索逻辑 Hook (172 行)
│   │   ├── useMarqueeSelection.ts   # 框选逻辑 Hook (162 行)
│   │   ├── useTasks.ts              # 任务管理 Hook (267 行)
│   │   ├── useNavigation.ts         # 导航管理 Hook (235 行)
│   │   ├── useInView.ts             # 视口检测 Hook (30 行)
│   │   ├── useKeyboardShortcuts.ts  # 键盘快捷键管理 Hook (69 行)
│   │   ├── useToasts.ts             # Toast 通知管理 Hook (37 行)
│   │   └── useUpdateCheck.ts        # 更新检查 Hook (272 行)
│   ├── 📁 services/                 # 业务服务层
│   │   ├── aiService.ts             # AI 服务 (624 行)
│   │   └── faceRecognitionService.ts # 人脸识别服务 (63 行)
│   ├── 📁 utils/                    # 工具函数库
│   │   ├── async.ts                 # 异步工具与文件 I/O 包装 (19 行)
│   │   ├── debounce.ts              # 防抖函数 (63 行)
│   │   ├── environment.ts           # 环境检测工具 (57 行)
│   │   ├── logger.ts                # 日志记录工具 (208 行)
│   │   ├── mockFileSystem.ts        # 模拟文件系统 (300 行)
│   │   ├── modelDownloadState.ts    # 模型下载状态管理 (312 行)
│   │   ├── performanceMonitor.ts    # 性能监控工具 (445 行)
│   │   ├── textUtils.ts             # 文本处理工具 (42 行)
│   │   ├── translations.ts          # 多语言支持 (1701 行)
│   │   └── thumbnailCache.ts        # 缩略图缓存管理 (65 行)
│   ├── 📁 workers/                  # Web Workers
│   │   ├── layout.worker.ts         # 布局计算工作器 (286 行)
│   │   └── search.worker.ts         # 搜索计算工作器 (108 行)
│   ├── 📁 lan-share/                # 局域网共享客户端 [新增]
│   │   ├── LanShareApp.tsx          # 局域网共享主应用 (299 行)
│   │   ├── api.ts                   # 局域网共享 API (149 行)
│   │   ├── main.tsx                 # 应用入口 (9 行)
│   │   ├── lan-share.css            # 样式文件
│   │   ├── index.html               # HTML 入口
│   │   └── 📁 components/           # 子组件
│   │       ├── AuthScreen.tsx       # 认证登录界面 (127 行)
│   │       ├── BrowseScreen.tsx     # 文件浏览界面 (243 行)
│   │       └── ImageViewer.tsx      # 图片查看器 (70 行)
│   ├── 📁 shared/                   # 共享模块 [新增]
│   │   ├── index.ts                 # 导出入口
│   │   ├── 📁 api/                  # API 适配器层
│   │   │   ├── index.ts             # 导出入口
│   │   │   ├── types.ts             # API 类型定义 (64 行)
│   │   │   └── 📁 adapters/         # 适配器实现
│   │   │       ├── index.ts         # 导出入口
│   │   │       ├── HttpAdapter.ts   # HTTP 适配器 (67 行)
│   │   │       └── TauriAdapter.ts  # Tauri 适配器 (67 行)
│   │   ├── 📁 components/           # 共享组件
│   │   │   ├── index.ts             # 导出入口
│   │   │   ├── 📁 Grid/             # 网格组件
│   │   │   │   ├── FileCard.tsx     # 文件卡片 (91 行)
│   │   │   │   ├── FileGrid.tsx     # 文件网格 (155 行)
│   │   │   │   └── LayoutSwitcher.tsx # 布局切换 (73 行)
│   │   │   ├── 📁 ImageViewer/      # 图片查看器
│   │   │   │   ├── ImageViewerCore.tsx # 核心组件 (430 行)
│   │   │   │   ├── ImageViewerControls.tsx # 控制栏 (279 行)
│   │   │   │   └── SlideshowManager.tsx # 幻灯片管理 (104 行)
│   │   │   ├── 📁 Thumbnails/       # 缩略图组件
│   │   │   │   ├── Folder3DIcon.tsx # 3D 文件夹图标 (103 行)
│   │   │   │   ├── FolderThumbnail.tsx # 文件夹缩略图 (62 行)
│   │   │   │   └── ImageThumbnail.tsx # 图片缩略图 (83 行)
│   │   │   ├── 📁 TopBar/           # 顶部栏组件
│   │   │   │   ├── TopBar.tsx       # 顶部栏 (92 行)
│   │   │   │   ├── SearchInput.tsx  # 搜索输入框 (128 行)
│   │   │   │   ├── SortControls.tsx # 排序控制 (83 行)
│   │   │   │   └── NavigationButtons.tsx # 导航按钮 (61 行)
│   │   │   └── 📁 UI/               # UI 组件
│   │   │       ├── BreadcrumbNav.tsx # 面包屑导航 (52 行)
│   │   │       ├── EmptyPlaceholder.tsx # 空占位符 (28 行)
│   │   │       └── LoadingSpinner.tsx # 加载动画 (28 行)
│   │   ├── 📁 hooks/                # 共享 Hooks
│   │   │   ├── index.ts             # 导出入口
│   │   │   ├── useImageTransform.ts # 图片变换 (384 行)
│   │   │   ├── useLayout.ts         # 布局计算 (161 行)
│   │   │   ├── useSlideshow.ts      # 幻灯片播放 (161 行)
│   │   │   ├── useVirtualScroll.ts  # 虚拟滚动 (42 行)
│   │   │   └── useInView.ts         # 视口检测 (30 行)
│   │   ├── 📁 utils/                # 共享工具
│   │   │   ├── index.ts             # 导出入口
│   │   │   ├── cache.ts             # 缓存工具 (44 行)
│   │   │   └── debounce.ts          # 防抖函数 (47 行)
│   │   └── 📁 types/                # 共享类型
│   │       ├── index.ts             # 导出入口
│   │       ├── file.ts              # 文件类型 (30 行)
│   │       └── image.ts             # 图片类型 (22 行)
│   ├── constants.ts                 # 全局常量定义 (29 行)
│   ├── types.ts                     # TypeScript 类型定义 (699 行)
│   └── main.tsx                     # 应用入口文件 (34 行)
├── 📁 src-tauri/                    # Rust 后端代码
│   ├── 📁 src/
│   │   ├── main.rs                  # Tauri 主程序入口 (359 行)
│   │   │  # ── 核心模块 ──
│   │   ├── file_types.rs            # 核心类型定义 (62 行)
│   │   ├── image_utils.rs           # 图像工具模块 (137 行)
│   │   ├── scanner.rs               # 目录扫描模块 (547 行)
│   │   │  # ── 命令模块 ──
│   │   ├── file_operations.rs       # 文件操作命令 (763 行)
│   │   ├── clip_commands.rs         # CLIP AI 搜索命令 (2155 行)
│   │   ├── db_commands.rs           # 数据库命令 (221 行)
│   │   ├── system_commands.rs       # 系统工具命令 (226 行)
│   │   ├── window_commands.rs       # 窗口控制命令 (87 行)
│   │   ├── color_commands.rs        # 颜色相关命令 (93 行)
│   │   ├── update_commands.rs       # 更新相关命令 (51 行)
│   │   ├── lan_share_commands.rs    # 局域网共享命令 (164 行) [新增]
│   │   │  # ── 功能模块 ──
│   │   ├── thumbnail.rs             # 缩略图生成模块 (479 行)
│   │   ├── color_db.rs              # 色彩数据库操作 (1124 行)
│   │   ├── color_extractor.rs       # 色彩提取算法 (239 行)
│   │   ├── color_search.rs          # 色彩搜索算法 (422 行)
│   │   ├── color_worker.rs          # 后台色彩处理工作器 (797 行)
│   │   ├── updater.rs               # 应用更新检查 (749 行)
│   │   ├── update_downloader.rs     # 更新下载器 (499 行)
│   │   ├── work_extractor.rs        # 作品提取器 (199 行) [新增]
│   │   │  # ── 子目录模块 ──
│   │   ├── 📁 db/                   # 数据库模块
│   │   │   ├── mod.rs               # 数据库模块入口 (132 行)
│   │   │   ├── persons.rs           # 人物数据库操作 (118 行)
│   │   │   ├── topics.rs            # 专题数据库操作 (233 行)
│   │   │   ├── file_metadata.rs     # 文件元数据存储 (214 行)
│   │   │   └── file_index.rs        # 文件索引数据库 (526 行)
│   │   ├── 📁 clip/                 # CLIP AI 模块
│   │   │   ├── mod.rs               # CLIP 模块入口 (206 行)
│   │   │   ├── model.rs             # CLIP 模型封装 (1099 行)
│   │   │   ├── embedding.rs         # 嵌入向量存储 (397 行)
│   │   │   ├── preprocessor.rs      # 图像预处理 (272 行)
│   │   │   ├── search.rs            # 相似度搜索 (451 行)
│   │   │   └── 📁 models/           # 模型实现
│   │   │       ├── mod.rs           # 模型规范定义 (197 行)
│   │   │       ├── siglip2_base.rs  # SigLIP2-Base 模型 (140 行)
│   │   │       ├── siglip2.rs       # SigLIP2-So400M 模型 (164 行)
│   │   │       └── wd14.rs          # WD-EVA02-Large-Tagger-V3 模型 (68 行)
│   │   ├── 📁 lan_share/            # 局域网共享模块 [新增]
│   │   │   ├── mod.rs               # 模块入口 (9 行)
│   │   │   ├── server.rs            # HTTP 服务器 (293 行)
│   │   │   ├── handlers.rs          # 请求处理器 (903 行)
│   │   │   ├── session.rs           # 会话管理 (105 行)
│   │   │   ├── device_manager.rs    # 设备管理 (74 行)
│   │   │   └── types.rs             # 类型定义 (129 行)
│   │   └── 📁 bin/                  # 工具二进制文件
│   │       └── dump_persons.rs      # 人物数据导出工具 (35 行)
│   ├── 📁 icons/                    # 应用图标 (多尺寸)
│   │   └── ...                      # 各种尺寸的图标文件
│   ├── 📁 capabilities/             # Tauri 权限配置
│   │   └── default.json             # 默认权限配置
│   ├── Cargo.toml                   # Rust 依赖配置
│   ├── tauri.conf.json              # Tauri 配置
│   └── build.rs                     # Rust 构建脚本
├── 📁 docs/                         # 开发文档
│   ├── main-rs-module-refactoring.md # main.rs 模块拆分重构记录 [新增]
│   ├── AI服务商集成与优化-实现记录.md
│   ├── AI自动命名功能实现记录.md
│   ├── CLIP模型集成实现记录.md
│   ├── HDD扫描问题修复总结.md
│   ├── IN_APP_UPDATE_DOWNLOAD_IMPLEMENTATION.md
│   ├── TabBar参考模式修改记录.md
│   ├── UPDATE_CHECKER_IMPLEMENTATION.md
│   ├── person-sort-group-feature.md
│   ├── 主色调数据库管理功能实现记录.md
│   ├── 参考模式实现总结.md
│   ├── 右键菜单图片对比功能增强-实现记录.md
│   └── 图片对比信息存储方案改进.md
├── 📁 public/                       # 静态资源
│   ├── 📁 models/                   # AI 模型文件 (人脸识别)
│   │   ├── age_gender_model-weights_manifest.json
│   │   ├── face_expression_model-weights_manifest.json
│   │   ├── face_landmark_68_model-weights_manifest.json
│   │   ├── face_landmark_68_tiny_model-weights_manifest.json
│   │   ├── face_recognition_model-weights_manifest.json
│   │   ├── ssd_mobilenetv1_model-weights_manifest.json
│   │   └── tiny_face_detector_model-weights_manifest.json
│   ├── react.svg                    # React Logo
│   └── tauri.svg                    # Tauri Logo
├── 📁 memory/                       # 项目文档
│   ├── API_REFERENCE.md             # API 参考文档
│   ├── MODULE_DISTRIBUTION.md       # 模块分布说明
│   ├── PROJECT_STRUCTURE.md         # 项目结构文档（本文件）
│   ├── QUICK_REFERENCE.md           # 快速参考指南
│   ├── TECHNICAL_ARCHITECTURE.md    # 技术架构文档
│   └── CHANGELOG_from_code.md       # 代码变更日志
├── 📁 .vscode/                      # VSCode 配置
│   ├── settings.json
│   └── extensions.json
├── 📁 test/                         # 测试配置
│   └── setupTests.ts                # 测试设置
├── package.json                      # Node.js 依赖配置
├── package-lock.json                 # Node.js 依赖锁定
├── tsconfig.json                     # TypeScript 配置
├── tsconfig.node.json                # TypeScript Node 配置
├── vite.config.ts                    # Vite 构建配置
├── vitest.config.ts                  # Vitest 测试配置
├── tailwind.config.js                # Tailwind CSS 配置
├── postcss.config.js                 # PostCSS 配置
├── index.html                        # HTML 入口
├── index.css                         # 全局样式
├── clean-cache.bat                   # Windows 缓存清理脚本
├── clean-cache.ps1                   # PowerShell 缓存清理脚本
├── query_colors_db.py                # 颜色数据库查询脚本
└── .gitignore                        # Git 忽略配置
```

## 技术栈

### 前端技术栈
- **框架**: React 18.2.0 + TypeScript 5.2.2
- **构建工具**: Vite 5.1.4
- **样式**: Tailwind CSS 3.4.1 + PostCSS 8.4.35
- **状态管理**: React Hooks (useState, useReducer)
- **UI 组件**: Lucide React 0.344.0 (图标库)
- AI 集成: @vladmandic/face-api 1.7.12 (人脸识别)
- **AI 搜索**: CLIP 模型 (ONNX Runtime)
  - SigLIP2-Base (ViT-B-16)
  - SigLIP2-So400M (ViT-So400M)
  - WD-EVA02-Large-Tagger-V3 (WD14 标签器)
- **测试**: Vitest (单元测试框架)

### 后端技术栈
- **框架**: Tauri 2.0
- **语言**: Rust 2021 Edition
- **图像处理**: image 0.24, fast_image_resize 3.0, jxl-oxide (JXL 支持)
- **并发**: Tokio 1, Rayon 1.8
- **数据库**: Rusqlite 0.30 (SQLite)
- **色彩科学**: palette 0.7 (CIEDE2000 颜色差异)
- **AI 搜索**: CLIP 模型 (ONNX Runtime)

### 开发工具
- **包管理**: npm
- **代码质量**: ESLint, Prettier
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
npm run dev          # 前端开发服务器
npm run tauri:dev    # Tauri 开发模式
```

### 生产构建
```bash
npm run build
cargo tauri build
```

### 测试
```bash
npm run test         # 运行单元测试
```

### 缓存清理
```bash
npm run clean        # 清理缓存
# 或使用脚本
./clean-cache.ps1    # PowerShell
./clean-cache.bat    # Windows CMD
```

## 架构特点

### 前端架构
- **组件化**: 基于 React 的组件化架构
- **类型安全**: 完整的 TypeScript 类型定义
- **响应式设计**: 支持多种屏幕尺寸
- **国际化**: 多语言支持 (translations.ts)
- **性能优化**: 
  - 虚拟滚动
  - 懒加载
  - Web Worker 布局计算
  - 防抖/节流
  - 缩略图缓存

### 后端架构
- **跨平台**: 基于 Tauri 的原生桌面应用
- **高性能**: Rust 保证的性能和内存安全
- **模块化**: 清晰的模块划分，便于维护
- **并发处理**: 多线程颜色提取和 AI 分析
- **数据库**: SQLite 嵌入式数据库
- **插件化**: Tauri 插件系统

### 后端模块结构 (2026-02-19 重构)

后端代码采用模块化设计，从原来的单文件拆分为多个独立模块：

```
src-tauri/src/
├── main.rs              # 入口文件 (359 行)
├── 📁 核心模块
│   ├── file_types.rs    # 类型定义 (FileType, FileNode, ImageMeta)
│   ├── image_utils.rs   # 图像工具 (JXL/AVIF 支持)
│   └── scanner.rs       # 目录扫描 (HDD 检测优化)
├── 📁 命令模块
│   ├── file_operations.rs  # 文件操作命令 (763 行)
│   ├── clip_commands.rs    # CLIP AI 搜索 (2155 行)
│   ├── db_commands.rs      # 数据库命令 (221 行)
│   ├── system_commands.rs  # 系统工具 (226 行)
│   ├── window_commands.rs  # 窗口控制 (87 行)
│   ├── color_commands.rs   # 颜色提取 (93 行)
│   ├── update_commands.rs  # 应用更新 (51 行)
│   └── lan_share_commands.rs # 局域网共享 (164 行) [新增]
├── 📁 功能模块
│   ├── thumbnail.rs        # 缩略图生成 (479 行)
│   ├── color_db.rs         # 颜色数据库 (1124 行)
│   ├── color_extractor.rs  # 颜色提取 (239 行)
│   ├── color_search.rs     # 颜色搜索 (422 行)
│   ├── color_worker.rs     # 后台处理 (797 行)
│   ├── updater.rs          # 更新检查 (749 行)
│   ├── update_downloader.rs # 更新下载 (499 行)
│   └── work_extractor.rs   # 作品提取器 (199 行) [新增]
├── 📁 db/                  # 数据库模块
│   ├── mod.rs              # 入口 (132 行)
│   ├── persons.rs          # 人物 (118 行)
│   ├── topics.rs           # 专题 (233 行)
│   ├── file_metadata.rs    # 元数据 (214 行)
│   └── file_index.rs       # 索引 (526 行)
├── 📁 clip/                # CLIP AI 模块
│   ├── mod.rs              # 模块入口 (206 行)
│   ├── model.rs            # 模型封装 (1099 行)
│   ├── embedding.rs        # 嵌入向量 (397 行)
│   ├── preprocessor.rs     # 图像预处理 (272 行)
│   ├── search.rs           # 相似度搜索 (451 行)
│   └── 📁 models/          # 模型实现
│       ├── mod.rs          # 模型规范 (197 行)
│       ├── siglip2_base.rs # SigLIP2-Base (140 行)
│       ├── siglip2.rs      # SigLIP2-So400M (164 行)
│       └── wd14.rs         # WD-EVA02-Large-Tagger-V3 (68 行)
└── 📁 lan_share/           # 局域网共享模块 [新增]
    ├── mod.rs              # 模块入口 (9 行)
    ├── server.rs           # HTTP 服务器 (293 行)
    ├── handlers.rs         # 请求处理器 (903 行)
    ├── session.rs          # 会话管理 (105 行)
    ├── device_manager.rs   # 设备管理 (74 行)
    └── types.rs            # 类型定义 (129 行)
```

详见: [main.rs 模块拆分重构记录](../docs/main-rs-module-refactoring.md)

### 数据流
```
用户操作 → React 组件 → Tauri Bridge → Rust 后端 → SQLite 数据库
     ↑           ↓            ↓            ↓         ↓
   UI 更新 ← 状态更新 ← 进度事件 ← 处理结果 ← 查询/更新
```

## 关键文件说明

### 核心文件
- `src/App.tsx`: 主应用组件，包含所有业务逻辑 (4362 行)
- `src-tauri/src/main.rs`: Rust 主程序入口 (359 行)
- `src-tauri/src/file_types.rs`: 核心类型定义 (62 行)
- `src-tauri/src/scanner.rs`: 目录扫描核心逻辑 (547 行)
- `src-tauri/src/clip_commands.rs`: CLIP AI 搜索命令 (2155 行)
- `src-tauri/src/lan_share_commands.rs`: 局域网共享命令 (164 行) [新增]
- `src-tauri/src/work_extractor.rs`: 作品提取器 (199 行) [新增]
- `src/api/tauri-bridge.ts`: 前后端通信桥接 (2151 行)
- `src/types.ts`: TypeScript 类型定义 (699 行)
- `src/constants.ts`: 全局常量定义 (29 行)
- `src/shared/`: 共享模块（主应用与 LAN Share 客户端共用） [新增]
- `src/lan-share/`: 局域网共享独立客户端应用 [新增]

### 配置文件
- `package.json`: Node.js 项目配置和脚本
- `src-tauri/Cargo.toml`: Rust 项目配置
- `src-tauri/tauri.conf.json`: Tauri 应用配置
- `vite.config.ts`: 前端构建配置
- `vitest.config.ts`: 测试配置

### 文档文件
- `docs/`: 开发文档目录
  - `main-rs-module-refactoring.md`: main.rs 模块拆分重构记录
  - 其他实现记录文档...
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
3. **后端实现**: 在 `src-tauri/src/` 对应模块实现 Rust 命令
4. **类型定义**: 在 `types.ts` 更新类型定义
5. **文档更新**: 在 `docs/` 或 `memory/` 更新相关文档
6. **测试构建**: 运行 `npm run tauri:dev` 测试功能

## 注意事项

- 前端使用 React 18 的新特性 (Concurrent Features)
- 后端使用 Rust 2021 Edition
- 支持 Windows、macOS、Linux 平台
- AI 功能需要外部 API (OpenAI/Ollama/LM Studio)
- 颜色提取使用 CIEDE2000 算法保证准确性
- 缩略图支持 JPEG、WebP、PNG 格式，以及 JXL、AVIF 格式
- CLIP AI 搜索支持三种模型：
  - SigLIP2-Base: 轻量级多语言模型
  - SigLIP2-So400M: 高性能多语言模型
  - WD-EVA02-Large-Tagger-V3: WD14 标签器，支持自动标签生成和角色识别

---

**文档版本**: 1.5  
**更新日期**: 2026-03-14  
**维护者**: Aurora Gallery Team
