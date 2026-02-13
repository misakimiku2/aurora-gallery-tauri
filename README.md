# Aurora Gallery

<p align="center">
  <img src="src-tauri/icons/icon.png" width="128" height="128" alt="Aurora Gallery Logo">
</p>

<p align="center">
  <b>一款现代化的跨平台图片管理与浏览应用</b>
</p>

<p align="center">
  <a href="#功能特性">功能特性</a> •
  <a href="#安装说明">安装说明</a> •
  <a href="#使用指南">使用指南</a> •
  <a href="#技术栈">技术栈</a> •
  <a href="#开发指南">开发指南</a>
</p>

---

## 简介

**Aurora Gallery** 是一款基于 Tauri + React + TypeScript 构建的高性能图片管理应用，专为摄影师、设计师和图片收藏爱好者打造。支持 Windows、macOS 和 Linux 平台，提供流畅的图片浏览、智能分类、AI 分析和色彩管理功能。

## 功能特性

### 核心功能

- **📁 多库管理** - 支持多个图片库，轻松切换不同项目
- **🔍 快速搜索** - 支持文件名、标签、描述等多维度搜索
- **🎨 色彩搜索** - 基于 CIEDE2000 算法的精准颜色搜索
- **👤 人物识别** - AI 人脸识别，自动归类人物照片
- **📂 专题管理** - 创建专题专辑，灵活组织图片
- **🏷️ 标签系统** - 自定义标签，高效分类管理

### AI 智能功能

- **🤖 智能分析** - AI 自动生成图片描述和标签
- **📝 OCR 识别** - 提取图片中的文字内容
- **🌐 智能翻译** - 自动翻译图片中的外文文字
- **✨ AI 重命名** - 根据图片内容智能生成文件名
- **🎯 批量处理** - 支持批量 AI 分析和重命名

### 浏览与对比

- **🖼️ 多种视图** - 网格、瀑布流、列表多种布局
- **🔎 图片对比** - 并排对比多张图片
- **📊 元数据面板** - 查看详细的图片 EXIF 信息
- **🖱️ 拖拽操作** - 支持文件拖拽导入和整理
- **⌨️ 快捷键支持** - 丰富的键盘快捷键提升效率

### 高级特性

- **⚡ 高性能** - Rust 后端 + 虚拟滚动，流畅处理大量图片
- **💾 缩略图缓存** - 智能缓存机制，快速加载预览
- **🌙 深色主题** - 支持深色模式，保护眼睛
- **🌍 多语言** - 支持中文和英文界面
- **🔒 本地存储** - 数据本地保存，保护隐私

## 安装说明

### 系统要求

- **Windows**: Windows 10 或更高版本
- **macOS**: macOS 10.15 或更高版本
- **Linux**: Ubuntu 20.04 或兼容发行版

### 下载安装

1. 前往 [Releases](https://github.com/misakimiku2/aurora-gallery-tauri/releases) 页面
2. 下载对应平台的安装包：
   - Windows: `.msi` 安装程序
   - macOS: `.dmg` 磁盘镜像
   - Linux: `.AppImage` 可执行文件
3. 运行安装程序并按提示完成安装

### 从源码构建

```bash
# 克隆仓库
git clone https://github.com/misakimiku2/aurora-gallery-tauri.git
cd aurora-gallery-tauri

# 安装依赖
npm install

# 构建发布版本
npm run tauri:build
```

构建完成后，安装包将位于 `src-tauri/target/release/bundle/` 目录。

## 使用指南

### 首次使用

1. 启动 Aurora Gallery
2. 在欢迎界面选择或创建图片库文件夹
3. 等待初始扫描完成
4. 开始浏览和管理您的图片

### 基本操作

| 操作 | 说明 |
|------|------|
| `Ctrl + O` | 打开文件夹 |
| `Ctrl + F` | 搜索图片 |
| `Ctrl + C` | 复制选中文件 |
| `Ctrl + V` | 粘贴文件 |
| `Delete` | 删除选中文件 |
| `Space` | 预览图片 |
| `Esc` | 关闭当前窗口/取消选择 |

### 视图切换

- **文件视图** - 浏览文件夹中的图片
- **人物视图** - 按人物归类查看照片
- **专题视图** - 查看和管理专题专辑
- **标签视图** - 按标签筛选图片

### AI 功能使用

1. **图片分析** - 右键图片选择 "AI 分析"
2. **智能重命名** - 选中文件后点击 AI 重命名按钮
3. **批量处理** - 选中多个文件进行批量 AI 分析

## 技术栈

### 前端
- **框架**: React 18 + TypeScript 5
- **构建工具**: Vite 5
- **样式**: Tailwind CSS 3
- **图标**: Lucide React
- **AI 识别**: face-api.js

### 后端
- **框架**: Tauri 2.0
- **语言**: Rust 2021
- **图像处理**: image, fast_image_resize, jxl-oxide
- **数据库**: SQLite (Rusqlite)
- **并发**: Tokio + Rayon

## 开发指南

### 环境要求

- Node.js 18+
- Rust 1.70+
- Tauri CLI

### 开发模式

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run tauri:dev
```

### 常用命令

```bash
# 运行测试
npm run test

# 构建前端
npm run build

# 清理缓存
npm run clean

# 生产构建
npm run tauri:build
```

### 项目结构

```
├── src/                    # 前端 React 代码
│   ├── components/         # React 组件
│   ├── hooks/             # 自定义 Hooks
│   ├── services/          # 业务服务
│   ├── utils/             # 工具函数
│   └── workers/           # Web Workers
├── src-tauri/             # Rust 后端代码
│   ├── src/               # Rust 源码
│   └── icons/             # 应用图标
├── public/                # 静态资源
└── memory/                # 项目文档
```

## 文档

详细的技术文档位于 `memory/` 目录：

- [API 参考](memory/API_REFERENCE.md)
- [技术架构](memory/TECHNICAL_ARCHITECTURE.md)
- [项目结构](memory/PROJECT_STRUCTURE.md)
- [快速参考](memory/QUICK_REFERENCE.md)
- [变更日志](memory/CHANGELOG_from_code.md)

## 贡献

欢迎提交 Issue 和 Pull Request！

1. Fork 本仓库
2. 创建您的特性分支 (`git checkout -b feature/AmazingFeature`)
3. 提交您的更改 (`git commit -m 'Add some AmazingFeature'`)
4. 推送到分支 (`git push origin feature/AmazingFeature`)
5. 打开一个 Pull Request

## 许可证

本项目采用 [MIT](LICENSE) 许可证开源。

## 致谢

- [Tauri](https://tauri.app/) - 跨平台应用框架
- [React](https://react.dev/) - 用户界面库
- [face-api.js](https://github.com/vladmandic/face-api) - 人脸识别库
- [Tailwind CSS](https://tailwindcss.com/) - CSS 框架

---

<p align="center">
  Made with ❤️ by <a href="https://github.com/misakimiku2">MISAKIMIKU</a>
</p>
