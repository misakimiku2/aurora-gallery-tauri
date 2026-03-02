# Aurora Gallery Tauri 项目结构文档

## 项目概述
这是一个基于 Tauri + React + TypeScript 构建的跨平台图片管理应用，支持图片浏览、AI分析、人脸识别、色彩提取等功能。

## 完整目录树

```
aurora-gallery-tauri/
├── 📁 src/                          # 前端 React 代码 (TypeScript)
│   ├── 📁 api/                      # API 桥接层
│   │   └── tauri-bridge.ts          # Tauri 原生功能桥接 (2273 行)
│   ├── 📁 components/               # React 组件库
│   │   ├── 📁 modals/               # 模态框组件集合
│   │   │   ├── AddToPersonModal.tsx     # 添加到人物 (130 行)
│   │   │   ├── AddToTopicModal.tsx      # 添加到专题 (140 行)
│   │   │   ├── AlertModal.tsx           # 警告提示 (27 行)
│   │   │   ├── AIBatchRenameModal.tsx   # AI 批量重命名 (387 行)
│   │   │   ├── AddImageModal.tsx        # 添加图片到对比 (1262 行)
│   │   │   ├── BatchRenameModal.tsx     # 批量重命名 (75 行)
│   │   │   ├── ClearPersonModal.tsx     # 清除人物信息 (182 行)
│   │   │   ├── ConfirmModal.tsx         # 通用确认 (43 行)
│   │   │   ├── CreateTopicModal.tsx     # 创建专题 (105 行)
│   │   │   ├── CropAvatarModal.tsx      # 头像裁剪 (548 行)
│   │   │   ├── ExitConfirmModal.tsx     # 退出确认 (60 行)
│   │   │   ├── FolderPickerModal.tsx    # 文件夹选择 (205 行)
│   │   │   ├── RenamePersonModal.tsx    # 人物重命名 (45 行)
│   │   │   ├── RenameTagModal.tsx       # 标签重命名 (42 行)
│   │   │   ├── RenameTopicModal.tsx     # 重命名专题 (117 行)
│   │   │   ├── TagEditor.tsx            # 标签编辑器 (95 行)
│   │   │   ├── UpdateModal.tsx          # 更新模态框
│   │   │   └── WelcomeModal.tsx         # 欢迎向导 (368 行)
│   │   ├── 📁 comparer/             # 图片对比组件
│   │   │   ├── AnnotationLayer.tsx      # 标注图层 (390 行)
│   │   │   ├── ComparerContextMenu.tsx  # 对比视图右键菜单 (84 行)
│   │   │   ├── EditOverlay.tsx          # 编辑覆盖层 (750 行)
│   │   │   └── types.ts                 # 对比组件类型定义 (22 行)
│   │   ├── 📁 __tests__/            # 测试文件
│   │   │   └── EmptyFolderPlaceholder.spec.tsx  # 空文件夹占位符测试
│   │   ├── App.tsx                  # 主应用组件 (4248 行)
│   │   ├── AppModals.tsx            # 应用模态框集中渲染入口 (422 行)
│   │   ├── PersonGrid.tsx           # 人物网格组件 (224 行)
│   │   ├── MetadataPanel.tsx        # 元数据面板组件 (2607 行)
│   │   ├── ImageViewer.tsx          # 图片查看器组件 (1542 行)
│   │   ├── ImageComparer.tsx        # 图片对比组件 (2600+ 行)
│   │   ├── FileGrid.tsx             # 文件网格视图组件 (1457 行)
│   │   ├── FileListItem.tsx         # 文件列表项组件 (520 行)
│   │   ├── TreeSidebar.tsx          # 树形侧边栏组件 (654 行)
│   │   ├── TopBar.tsx               # 顶部工具栏组件 (921 行)
│   │   ├── TabBar.tsx               # 标签页管理组件 (249 行)
│   │   ├── TaskProgressModal.tsx    # 任务进度模态框 (200 行)
│   │   ├── SettingsModal.tsx        # 设置模态框组件 (1347 行)
│   │   ├── TopicModule.tsx          # 专题模块组件 (2618 行)
│   │   ├── TagsList.tsx             # 标签列表组件 (470 行)
│   │   ├── DragDropOverlay.tsx      # 拖拽覆盖层组件
│   │   ├── CloseConfirmationModal.tsx # 关闭确认模态框
│   │   ├── SplashScreen.tsx         # 启动画面组件
│   │   ├── Logo.tsx                 # Logo 组件
│   │   ├── FolderIcon.tsx           # 文件夹图标组件
│   │   ├── Folder3DIcon.tsx         # 3D 文件夹图标组件 (168 行)
│   │   ├── FolderThumbnail.tsx      # 文件夹缩略图组件 (163 行)
│   │   ├── ImageThumbnail.tsx       # 图片缩略图组件 (150 行)
│   │   ├── ColorPickerPopover.tsx   # 颜色选择弹出组件 (321 行)
│   │   ├── ContextMenu.tsx          # 右键上下文菜单组件
│   │   ├── ToastItem.tsx            # 通知/吐司项组件
│   │   ├── GlobalToasts.tsx         # 全局 Toast 容器 (40 行)
│   │   ├── EmptyFolderPlaceholder.tsx # 空文件夹占位符 (33 行)
│   │   ├── InlineRenameInput.tsx    # 内联重命名输入框 (47 行)
│   │   ├── AIRenameButton.tsx       # AI 重命名按钮 (38 行)
│   │   ├── AIRenamePreview.tsx      # AI 重命名预览 (40 行)
│   │   └── useLayoutHook.ts         # 布局管理 Hook (79 行)
│   ├── 📁 hooks/                    # 自定义 Hooks
│   │   ├── useAIAnalysis.ts         # AI 分析相关 Hook (609 行)
│   │   ├── useAIRename.ts           # AI 重命名 Hook (107 行)
│   │   ├── useContextMenu.ts        # 右键/上下文菜单交互 Hook (82 行)
│   │   ├── useFileOperations.ts     # 文件复制/移动/删除等操作封装 (1015 行)
│   │   ├── useFileSearch.ts         # 搜索逻辑 Hook (182 行)
│   │   ├── useMarqueeSelection.ts   # 框选逻辑 Hook (147 行)
│   │   ├── useTasks.ts              # 任务管理 Hook (317 行)
│   │   ├── useNavigation.ts         # 导航管理 Hook (240 行)
│   │   ├── useInView.ts             # 视口检测 Hook (23 行)
│   │   ├── useKeyboardShortcuts.ts  # 键盘快捷键管理 Hook (49 行)
│   │   ├── useToasts.ts             # Toast 通知管理 Hook (20 行)
│   │   └── useUpdateCheck.ts        # 更新检查 Hook
│   ├── 📁 services/                 # 业务服务层
│   │   ├── aiService.ts             # AI 服务 (99 行)
│   │   └── faceRecognitionService.ts # 人脸识别服务 (86 行)
│   ├── 📁 utils/                    # 工具函数库
│   │   ├── async.ts                 # 异步工具与文件 I/O 包装 (19 行)
│   │   ├── debounce.ts              # 防抖函数 (72 行)
│   │   ├── environment.ts           # 环境检测工具 (62 行)
│   │   ├── logger.ts                # 日志记录工具 (228 行)
│   │   ├── mockFileSystem.ts        # 模拟文件系统 (341 行)
│   │   ├── modelDownloadState.ts    # 模型下载状态管理
│   │   ├── performanceMonitor.ts    # 性能监控工具 (452 行)
│   │   ├── textUtils.ts             # 文本处理工具 (42 行)
│   │   ├── translations.ts          # 多语言支持 (1114 行)
│   │   └── thumbnailCache.ts        # 缩略图缓存管理 (56 行)
│   ├── 📁 workers/                  # Web Workers
│   │   ├── layout.worker.ts         # 布局计算工作器 (252 行)
│   │   └── search.worker.ts         # 搜索计算工作器 (125 行)
│   ├── constants.ts                 # 全局常量定义 (24 行)
│   ├── types.ts                     # TypeScript 类型定义 (742 行)
│   └── main.tsx                     # 应用入口文件 (39 行)
├── 📁 src-tauri/                    # Rust 后端代码
│   ├── 📁 src/
│   │   ├── main.rs                  # Tauri 主程序入口 (349 行)
│   │   │  # ── 核心模块 ──
│   │   ├── file_types.rs            # 核心类型定义 (~60 行)
│   │   ├── image_utils.rs           # 图像工具模块 (~150 行)
│   │   ├── scanner.rs               # 目录扫描模块 (~600 行)
│   │   │  # ── 命令模块 ──
│   │   ├── file_operations.rs       # 文件操作命令 (~750 行)
│   │   ├── clip_commands.rs         # CLIP AI 搜索命令 (1566 行)
│   │   ├── db_commands.rs           # 数据库命令 (243 行)
│   │   ├── system_commands.rs       # 系统工具命令 (~200 行)
│   │   ├── window_commands.rs       # 窗口控制命令 (~90 行)
│   │   ├── color_commands.rs        # 颜色相关命令 (~100 行)
│   │   ├── update_commands.rs       # 更新相关命令 (~70 行)
│   │   │  # ── 功能模块 ──
│   │   ├── thumbnail.rs             # 缩略图生成模块 (529 行)
│   │   ├── color_db.rs              # 色彩数据库操作 (1120 行)
│   │   ├── color_extractor.rs       # 色彩提取算法 (253 行)
│   │   ├── color_search.rs          # 色彩搜索算法 (441 行)
│   │   ├── color_worker.rs          # 后台色彩处理工作器 (949 行)
│   │   ├── updater.rs               # 应用更新检查
│   │   ├── update_downloader.rs     # 更新下载器
│   │   │  # ── 子目录模块 ──
│   │   ├── 📁 db/                   # 数据库模块
│   │   │   ├── mod.rs               # 数据库模块入口 (142 行)
│   │   │   ├── persons.rs           # 人物数据库操作 (128 行)
│   │   │   ├── topics.rs            # 专题数据库操作 (175 行)
│   │   │   ├── file_metadata.rs     # 文件元数据存储 (230 行)
│   │   │   └── file_index.rs        # 文件索引数据库 (348 行)
│   │   ├── 📁 clip/                 # CLIP AI 模块
│   │   │   ├── mod.rs               # CLIP 模块入口
│   │   │   ├── model.rs             # CLIP 模型封装
│   │   │   ├── embedding.rs         # 嵌入向量存储
│   │   │   ├── preprocessor.rs      # 图像预处理
│   │   │   ├── search.rs            # 相似度搜索
│   │   │   └── 📁 models/           # 模型实现
│   │   │       ├── mod.rs           # 模型规范定义
│   │   │       ├── siglip2_base.rs  # SigLIP2-Base 模型
│   │   │       ├── siglip2.rs       # SigLIP2-So400M 模型
│   │   │       └── wd14.rs          # WD-EVA02-Large-Tagger-V3 模型
│   │   └── 📁 bin/                  # 工具二进制文件
│   │       └── dump_persons.rs      # 人物数据导出工具 (45 行)
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
├── main.rs              # 入口文件 (349 行)
├── 📁 核心模块
│   ├── file_types.rs    # 类型定义 (FileType, FileNode, ImageMeta)
│   ├── image_utils.rs   # 图像工具 (JXL/AVIF 支持)
│   └── scanner.rs       # 目录扫描 (HDD 检测优化)
├── 📁 命令模块
│   ├── file_operations.rs  # 文件操作命令
│   ├── clip_commands.rs    # CLIP AI 搜索 (1566 行)
│   ├── db_commands.rs      # 数据库命令 (243 行)
│   ├── system_commands.rs  # 系统工具
│   ├── window_commands.rs  # 窗口控制
│   ├── color_commands.rs   # 颜色提取
│   └── update_commands.rs  # 应用更新
├── 📁 功能模块
│   ├── thumbnail.rs        # 缩略图生成 (529 行)
│   ├── color_db.rs         # 颜色数据库 (1120 行)
│   ├── color_extractor.rs  # 颜色提取 (253 行)
│   ├── color_search.rs     # 颜色搜索 (441 行)
│   ├── color_worker.rs     # 后台处理 (949 行)
│   └── update*.rs          # 更新相关
├── 📁 db/                  # 数据库模块
│   ├── mod.rs              # 入口 (142 行)
│   ├── persons.rs          # 人物 (128 行)
│   ├── topics.rs           # 专题 (175 行)
│   ├── file_metadata.rs    # 元数据 (230 行)
│   └── file_index.rs       # 索引 (348 行)
└── 📁 clip/                # CLIP AI 模块
    ├── mod.rs              # 模块入口
    ├── model.rs            # 模型封装
    ├── embedding.rs        # 嵌入向量
    ├── preprocessor.rs     # 图像预处理
    ├── search.rs           # 相似度搜索
    └── 📁 models/          # 模型实现
        ├── siglip2_base.rs # SigLIP2-Base
        ├── siglip2.rs      # SigLIP2-So400M
        └── wd14.rs         # WD-EVA02-Large-Tagger-V3
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
- `src/App.tsx`: 主应用组件，包含所有业务逻辑 (4248 行)
- `src-tauri/src/main.rs`: Rust 主程序入口 (349 行)
- `src-tauri/src/file_types.rs`: 核心类型定义
- `src-tauri/src/scanner.rs`: 目录扫描核心逻辑
- `src-tauri/src/clip_commands.rs`: CLIP AI 搜索命令 (1566 行)
- `src/api/tauri-bridge.ts`: 前后端通信桥接 (2273 行)
- `src/types.ts`: TypeScript 类型定义 (742 行)
- `src/constants.ts`: 全局常量定义 (24 行)

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

**文档版本**: 1.4  
**更新日期**: 2026-03-01  
**维护者**: Aurora Gallery Team
