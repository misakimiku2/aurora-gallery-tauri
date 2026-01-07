# Aurora Gallery Tauri 项目结构文档

## 项目概述
这是一个基于 Tauri + React + TypeScript 构建的跨平台图片管理应用，支持图片浏览、AI分析、人脸识别、色彩提取等功能。

## 完整目录树

```
aurora-gallery-tauri/
├── 📁 src/                          # 前端 React 代码 (TypeScript)
│   ├── 📁 api/                      # API 桥接层
│   │   └── tauri-bridge.ts          # Tauri 原生功能桥接 (200+ 行)
│   ├── 📁 components/               # React 组件库
│   │   ├── App.tsx                  # 主应用组件 (6000+ 行)
│   │   ├── MetadataPanel.tsx        # 元数据面板组件
│   │   ├── ImageViewer.tsx          # 图片查看器组件
│   │   ├── FileGrid.tsx             # 文件网格视图组件
│   │   ├── TreeSidebar.tsx          # 树形侧边栏组件
│   │   ├── TopBar.tsx               # 顶部工具栏组件
│   │   ├── TabBar.tsx               # 标签页管理组件
│   │   ├── SettingsModal.tsx        # 设置模态框组件
│   │   ├── SequenceViewer.tsx       # 序列查看器组件
│   │   ├── DragDropOverlay.tsx      # 拖拽覆盖层组件
│   │   ├── CloseConfirmationModal.tsx # 关闭确认模态框
│   │   ├── SplashScreen.tsx         # 启动画面组件
│   │   ├── Logo.tsx                 # Logo 组件
│   │   └── FolderIcon.tsx           # 文件夹图标组件
│   ├── 📁 services/                 # 业务服务层
│   │   ├── aiService.ts             # AI 服务 (OpenAI/Ollama/LM Studio)
│   │   └── faceRecognitionService.ts # 人脸识别服务
│   ├── 📁 utils/                    # 工具函数库
│   │   ├── debounce.ts              # 防抖函数
│   │   ├── environment.ts           # 环境检测工具
│   │   ├── logger.ts                # 日志记录工具
│   │   ├── mockFileSystem.ts        # 模拟文件系统
│   │   ├── performanceMonitor.ts    # 性能监控工具
│   │   └── translations.ts          # 多语言支持
│   ├── types.ts                     # TypeScript 类型定义 (500+ 行)
│   └── main.tsx                     # 应用入口文件
├── 📁 src-tauri/                    # Rust 后端代码
│   ├── 📁 src/
│   │   ├── main.rs                  # Tauri 主程序入口 (400+ 行)
│   │   ├── color_db.rs              # 色彩数据库操作 (300+ 行)
│   │   ├── color_extractor.rs       # 色彩提取算法 (200+ 行)
│   │   └── color_worker.rs          # 后台色彩处理工作器 (760+ 行)
│   ├── 📁 icons/                    # 应用图标 (多尺寸)
│   │   ├── icon.png
│   │   ├── 32x32.png
│   │   ├── 64x64.png
│   │   ├── 128x128.png
│   │   └── 128x128@2x.png
│   ├── 📁 capabilities/             # Tauri 权限配置
│   │   └── default.json             # 默认权限配置
│   ├── 📁 gen/                      # 生成的文件
│   │   └── schemas/                 # Tauri 模式文件
│   ├── Cargo.toml                   # Rust 依赖配置
│   ├── tauri.conf.json              # Tauri 配置
│   ├── build.rs                     # Rust 构建脚本
│   └── Cargo.lock                   # Rust 依赖锁定
├── 📁 public/                       # 静态资源
│   ├── 📁 models/                   # AI 模型文件 (二进制)
│   │   ├── age_gender_model.bin     # 年龄性别识别模型
│   │   ├── age_gender_model-weights_manifest.json
│   │   ├── face_expression_model.bin # 表情识别模型
│   │   ├── face_expression_model-weights_manifest.json
│   │   ├── face_landmark_68_model.bin # 68 点人脸关键点
│   │   ├── face_landmark_68_model-weights_manifest.json
│   │   ├── face_landmark_68_tiny_model.bin # 轻量级关键点
│   │   ├── face_landmark_68_tiny_model-weights_manifest.json
│   │   ├── face_recognition_model.bin # 人脸识别模型
│   │   ├── face_recognition_model-weights_manifest.json
│   │   ├── ssd_mobilenetv1_model.bin # SSD 物体检测
│   │   ├── ssd_mobilenetv1_model-weights_manifest.json
│   │   ├── tiny_face_detector_model.bin # 小脸检测
│   │   └── tiny_face_detector_model-weights_manifest.json
│   ├── react.svg                    # React Logo
│   └── tauri.svg                    # Tauri Logo
├── 📁 memory/                       # 项目文档
│   ├── architecture.md              # 架构设计文档
│   ├── context.md                   # 项目上下文文档
│   ├── drag-drop-complete-implementation.md # 拖拽实现文档
│   ├── product.md                   # 产品需求文档
│   ├── tasks.md                     # 任务列表文档
│   └── tech.md                      # 技术栈文档
├── 📁 .vscode/                      # VSCode 配置
│   ├── settings.json
│   └── extensions.json
├── 📁 .specstory/                   # 规格说明
├── package.json                     # Node.js 依赖配置
├── package-lock.json                # Node.js 依赖锁定
├── tsconfig.json                    # TypeScript 配置
├── tsconfig.node.json               # TypeScript Node 配置
├── vite.config.ts                   # Vite 构建配置
├── tailwind.config.js               # Tailwind CSS 配置
├── postcss.config.js                # PostCSS 配置
├── index.html                       # HTML 入口
├── index.css                        # 全局样式
├── clean-cache.bat                  # Windows 缓存清理脚本
├── clean-cache.ps1                  # PowerShell 缓存清理脚本
├── query_colors_db.py               # 数据库查询脚本 (Python)
└── .gitignore                       # Git 忽略文件
```

## 核心模块详细说明

### 1. 前端核心模块

#### **主应用组件** (`src/App.tsx`)
- **行数**: 6000+ 行
- **功能模块**:
  - 状态管理（useState + useReducer）
  - 文件系统扫描和管理
  - 拖拽上传处理（外部 + 内部）
  - AI 分析和人脸识别
  - 色彩提取进度跟踪
  - 多标签页管理
  - 上下文菜单处理
  - 模态框管理
  - 键盘快捷键
  - 窗口关闭处理
  - 性能监控集成

#### **API 桥接层** (`src/api/tauri-bridge.ts`)
- **行数**: 200+ 行
- **导出函数**:
  - `scanDirectory()`: 扫描目录
  - `scanFile()`: 扫描单个文件
  - `openDirectory()`: 打开目录选择对话框
  - `saveUserData()`: 保存用户数据
  - `loadUserData()`: 加载用户数据
  - `getDefaultPaths()`: 获取默认路径
  - `ensureDirectory()`: 确保目录存在
  - `createFolder()`: 创建文件夹
  - `renameFile()`: 重命名文件
  - `deleteFile()`: 删除文件
  - `getThumbnail()`: 获取缩略图
  - `hideWindow()`: 隐藏窗口
  - `showWindow()`: 显示窗口
  - `exitApp()`: 退出应用
  - `copyFile()`: 复制文件
  - `moveFile()`: 移动文件
  - `writeFileFromBytes()`: 写入二进制文件
  - `pauseColorExtraction()`: 暂停色彩提取
  - `resumeColorExtraction()`: 恢复色彩提取
  - `readFileAsBase64()`: 读取文件为 Base64
  - `openPath()`: 打开路径（文件管理器）

#### **类型定义** (`src/types.ts`)
- **行数**: 500+ 行
- **主要类型**:
  - `AppState`: 应用状态
  - `FileNode`: 文件节点
  - `FileType`: 文件类型枚举
  - `TabState`: 标签页状态
  - `AppSettings`: 应用设置
  - `AiData`: AI 数据
  - `Person`: 人物信息
  - `TaskProgress`: 任务进度
  - `ColorExtractionProgress`: 色彩提取进度
  - `AiSearchFilter`: AI 搜索过滤器
  - `DeletionTask`: 删除任务

### 2. 后端核心模块

#### **主程序入口** (`src-tauri/src/main.rs`)
- **行数**: 400+ 行
- **功能**:
  - Tauri 应用初始化
  - 命令注册（文件操作、数据库、色彩提取等）
  - 窗口事件处理
  - 插件初始化
  - 全局状态管理

#### **色彩数据库** (`src-tauri/src/color_db.rs`)
- **行数**: 300+ 行
- **功能**:
  - SQLite 数据库管理
  - 色彩数据存储和查询
  - 文件状态管理（pending/processing/completed/error）
  - WAL 检查点管理
  - 批量操作优化
  - 数据库连接池

#### **色彩提取算法** (`src-tauri/src/color_extractor.rs`)
- **行数**: 200+ 行
- **功能**:
  - K-means 聚类算法
  - 主色调提取
  - 颜色量化和排序
  - 支持 8 种主色调提取
  - 图像预处理（缩放）

#### **后台色彩工作器** (`src-tauri/src/color_worker.rs`)
- **行数**: 760+ 行
- **功能**:
  - 生产者-消费者模式
  - 多线程并行处理（最多 8 个消费者）
  - 批量处理和进度报告
  - 暂停/恢复/关闭控制
  - WAL 检查点优化
  - 错误处理和重试
  - 防抖逻辑（文件聚合）

### 3. 业务服务层

#### **AI 服务** (`src/services/aiService.ts`)
- **支持提供商**:
  - OpenAI (GPT-4o)
  - Ollama (LLaVA)
  - LM Studio (本地模型)
- **功能**:
  - 图像分析
  - 文字提取 (OCR)
  - 翻译
  - 标签生成
  - 人物识别
  - 场景分类

#### **人脸识别服务** (`src/services/faceRecognitionService.ts`)
- **基于**: face-api.js
- **功能**:
  - 人脸检测
  - 人脸识别
  - 年龄/性别识别
  - 表情识别
  - 人脸关键点
  - 人脸匹配

### 4. 工具函数库

#### **环境检测** (`src/utils/environment.ts`)
- **功能**:
  - 检测 Tauri 环境
  - 异步环境检测
  - 平台检测

#### **性能监控** (`src/utils/performanceMonitor.ts`)
- **功能**:
  - 性能指标收集
  - 时间测量
  - 采样率控制
  - 指标记录

#### **多语言支持** (`src/utils/translations.ts`)
- **支持语言**: 中文 (zh)、英文 (en)
- **翻译内容**: UI 文本、提示信息、错误消息

## 数据库设计

### 色彩数据库表结构
```sql
-- 文件色彩表
CREATE TABLE IF NOT EXISTS file_colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    file_path TEXT UNIQUE NOT NULL,
    colors TEXT NOT NULL,  -- JSON 数组
    status TEXT DEFAULT 'pending',  -- pending/processing/completed/error
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 索引
CREATE INDEX IF NOT EXISTS idx_status ON file_colors(status);
CREATE INDEX IF NOT EXISTS idx_path ON file_colors(file_path);
```

## 构建和部署

### 开发环境
- **Node.js**: 18+
- **Rust**: 1.70+
- **Tauri**: 2.0+
- **Vite**: 5.0+

### 构建命令
```bash
# 开发模式
npm run dev

# 构建
npm run build

# 清理缓存
npm run clean
```

### 打包配置
- **平台**: Windows, macOS, Linux
- **安装器**: NSIS (Windows), DMG (macOS), AppImage (Linux)
- **签名**: 支持代码签名

## 性能优化策略

### 1. 前端优化
- React 组件懒加载
- 虚拟滚动（大文件列表）
- 图片懒加载
- 防抖和节流
- Web Worker（可选）

### 2. 后端优化
- 多线程并行处理
- 批量数据库操作
- WAL 模式优化
- 内存池管理
- 异步 I/O

### 3. 数据库优化
- 索引优化
- WAL 检查点
- 批量插入
- 连接池管理

## 安全特性

### 权限控制
- 文件系统访问权限
- 网络访问权限（AI 服务）
- 窗口管理权限

### 数据安全
- 用户数据加密存储
- 路径验证
- 输入验证
- 错误隔离

## 监控和日志

### 日志级别
- DEBUG: 详细调试信息
- INFO: 一般信息
- WARN: 警告信息
- ERROR: 错误信息

### 监控指标
- 文件扫描性能
- AI 分析耗时
- 色彩提取进度
- 内存使用
- 数据库性能

---

**文档版本**: 1.0  
**最后更新**: 2026-01-07  
**维护者**: Aurora Gallery Team