# 项目上下文文档

## 项目基本信息

**项目名称**: Aurora Gallery Tauri  
**项目类型**: 桌面图片管理应用  
**技术栈**: Tauri v2 + React + TypeScript + Rust  
**当前版本**: 0.1.0  
**开发状态**: 活跃开发中  

## 代码库结构

### 核心文件结构
```
aurora-gallery-tauri/
├── src/                          # 前端源代码
│   ├── App.tsx                   # 主应用组件 (4761行)
│   ├── main.tsx                  # 应用入口
│   ├── types.ts                  # TypeScript 类型定义
│   ├── api/
│   │   └── tauri-bridge.ts       # Tauri API 桥接
│   ├── components/               # React 组件
│   │   ├── ImageViewer.tsx       # 图片查看器
│   │   ├── FileGrid.tsx          # 文件网格
│   │   ├── TreeSidebar.tsx       # 侧边栏
│   │   ├── MetadataPanel.tsx     # 元数据面板
│   │   ├── SettingsModal.tsx     # 设置模态框
│   │   └── ... (其他组件)
│   └── utils/
│       ├── mockFileSystem.ts     # 模拟文件系统
│       ├── translations.ts       # 多语言支持
│       ├── environment.ts        # 环境检测
│       └── logger.ts             # 日志工具
├── src-tauri/                    # Rust 后端源代码
│   ├── src/
│   │   └── main.rs              # 主程序 (1292行)
│   ├── Cargo.toml               # Rust 依赖配置
│   ├── tauri.conf.json          # Tauri 配置
│   └── capabilities/            # Tauri 权限配置
├── public/                       # 静态资源
├── 配置文件:
│   ├── package.json             # Node.js 依赖
│   ├── tsconfig.json            # TypeScript 配置
│   ├── vite.config.ts           # Vite 构建配置
│   ├── tailwind.config.js       # Tailwind 配置
│   └── postcss.config.js        # PostCSS 配置
└── 其他:
    ├── clean-cache.bat          # Windows 缓存清理脚本
    └── clean-cache.ps1          # PowerShell 缓存清理脚本
```

## 核心功能模块

### 1. 文件系统管理 (Rust 后端)
- **scan_directory**: 递归扫描目录，构建文件树
- **文件操作**: 复制、移动、重命名、删除
- **缩略图生成**: 高性能图片处理 (fast_image_resize + rayon)
- **数据持久化**: 用户数据保存/加载

### 2. 前端状态管理 (React)
- **AppState**: 全局状态管理
  - 文件树结构 (roots, files)
  - 人物管理 (people)
  - 标签系统 (customTags)
  - 标签页管理 (tabs)
  - 任务队列 (tasks)
  - 用户设置 (settings)

### 3. AI 集成系统
- **多提供商支持**: OpenAI, Ollama, LM Studio
- **图片分析**: 物体识别、场景分类、颜色提取
- **OCR**: 文字识别和翻译
- **人物识别**: 人脸检测和分组
- **智能搜索**: 自然语言搜索解析

### 4. UI 组件系统
- **主界面**: 三栏布局 (侧边栏 + 主内容 + 元数据)
- **视图模式**: 网格、列表、时间线
- **图片浏览器**: 缩放、旋转、幻灯片
- **模态框系统**: 设置、编辑、确认对话框
- **上下文菜单**: 右键操作菜单

## 关键技术实现

### 性能优化
1. **并行处理**: 使用 Rayon 实现多线程并行处理
2. **懒加载**: 图片和缩略图按需加载
3. **缓存系统**: 缩略图缓存和 AI 分析结果缓存
4. **内存管理**: 高效的内存使用和垃圾回收

### 数据流
```
用户操作 → 前端状态更新 → Tauri 命令调用 → Rust 后端处理 → 数据持久化 → UI 更新
```

### 通信机制
- **命令调用**: 前端调用 Rust 命令 (async/await)
- **事件系统**: 后端事件推送到前端
- **数据同步**: 状态变更自动保存

## 当前开发状态

### 已完成功能
- ✅ 基础文件系统扫描和管理
- ✅ 多格式图片支持
- ✅ 高性能缩略图生成
- ✅ AI 图片分析 (OpenAI, Ollama, LM Studio)
- ✅ OCR 和翻译功能
- ✅ 人物识别和管理
- ✅ 标签系统
- ✅ 多视图模式
- ✅ 图片浏览器
- ✅ 设置系统
- ✅ 多语言支持
- ✅ 任务进度显示
- ✅ 上下文菜单
- ✅ 键盘快捷键
- ✅ 窗口控制 (最小化到托盘)

### 待开发功能
- [ ] 云同步功能
- [ ] 高级图片编辑
- [ ] 分享和协作
- [ ] 插件系统
- [ ] 自动更新
- [ ] 更多 AI 提供商支持

## 代码质量

### 代码规范
- **TypeScript**: 严格类型检查
- **React**: 函数组件 + Hooks
- **Rust**: 安全的内存管理
- **命名规范**: 清晰的变量和函数命名

### 错误处理
- **前端**: Try-catch + 用户友好的错误提示
- **后端**: Result 类型 + 详细的错误信息
- **日志系统**: 完整的日志记录

### 安全性
- **文件权限**: 最小权限原则
- **API 密钥**: 安全存储
- **数据隔离**: 本地存储，不上传云端

## 开发环境

### 依赖管理
- **Node.js**: v18+ (推荐 v20)
- **Rust**: 最新稳定版
- **包管理器**: npm 或 pnpm

### 构建命令
```bash
# 开发模式
npm run dev

# 构建应用
npm run build

# 清理缓存
npm run clean
```

### 调试工具
- **前端**: React DevTools, Vite Dev Server
- **后端**: Tauri Dev Tools, Rust 调试器
- **日志**: 浏览器控制台 + 应用日志文件

## 项目约束和限制

### 平台支持
- **主要目标**: Windows 10/11
- **次要支持**: macOS, Linux
- **不支持**: 移动端, Web 版本

### 性能要求
- **内存**: 推荐 8GB+ RAM
- **存储**: 至少 500MB 可用空间
- **CPU**: 多核处理器推荐

### 网络要求
- **AI 功能**: 需要网络连接 (除非使用本地模型)
- **离线模式**: 基础功能可离线使用

## 维护和扩展

### 代码组织
- **组件化**: 高内聚低耦合
- **模块化**: 功能模块清晰分离
- **配置化**: 硬编码最小化

### 扩展指南
1. **添加新 AI 提供商**: 修改 `src/api/tauri-bridge.ts` 和 `src-tauri/src/main.rs`
2. **添加新文件格式**: 更新 `SUPPORTED_EXTENSIONS` 常量
3. **添加新视图**: 创建新组件并在 `App.tsx` 中集成
4. **添加新语言**: 更新 `src/utils/translations.ts`

### 测试策略
- **单元测试**: 核心工具函数
- **集成测试**: 关键业务流程
- **手动测试**: UI 交互和用户体验

---

*本文档作为项目的上下文参考，帮助理解代码结构、功能模块和开发状态。*