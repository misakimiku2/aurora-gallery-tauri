# Changelog

All notable changes to this project will be documented in this file.

## [1.3.0] - 2026-08-13

### 🔧 Refactor

#### App.tsx 二轮拆分（阶段 1-3）
- App.tsx 从 **3860 行** 降至 **2670 行**（累计较最初 5211 行减少 **48.8%**）
- 阶段 1：import 上移整理、`LAN_ROOT_IMAGES_ID` → constants.ts、`getInitialLayout` → utils/layoutSettings.ts、SVG filters → `SvgColorFilters.tsx`、LAN 下载遮罩 → `LanDownloadOverlay.tsx`
- 阶段 2：JSX 组装层拆为 `src/components/app/` **8 个子组件**（TabBarWrapper / SidebarPane / ViewerPane / ToolbarPane / FilterChipsBar / OverviewBar / MainContentArea / RightPanel）
- 阶段 3：提取 **4 个领域 Hook**（useLanClientSync / useTabHandlers / useViewerHandlers / usePersonTopicHandlers），自定义 Hooks 总计 **27 个**
- 清理 App.tsx（36 处）与 FileGrid.tsx（68 处）乱码注释为可读中文注释

### 🧹 Cleanup
- 清理 App.tsx **107 个**历史遗留未使用 import（11 行），tsc/build/vitest 全绿（39 passed / 7 files）

---

## [1.2.0] - 2026-04-18

### ✨ New Features

#### App.tsx Hook 模块化重构
- 将 App.tsx 从 **5211 行** 大型单体组件重构为 **2557 行** Hook 编排层（减少 **51%**）
- 新增 **11 个自定义 Hooks**（P1: 7个 + P2: 4个），加上原有 12 个，总计 **23 个** 自定义 Hooks
- **P1 提取 Hook（核心业务逻辑）**:
  - `useAppInit` (378 行) — 应用初始化：Tauri 环境检测、用户数据加载、目录扫描、事件注册、语言/分组设置
  - `useDirectoryScan` (501 行) — 目录扫描：handleOpenFolder、scanAndMerge、handleRefresh、handleRefreshTags、handleChangePath
  - `useWindowLifecycle` (157 行) — 窗口生命周期：退出确认、关闭监听、颜色/色板搜索 useEffect、标题更新
  - `useSearch` (640 行) — 搜索功能：AI 搜索、CLIP 向量搜索、相似图片搜索、clip 设置状态管理
  - `usePeople` (575 行) — 人物管理：CRUD 操作、头像裁剪、智能创建（16 个函数）
  - `useTopics` (217 行) — 专题管理：CRUD 操作（6 个函数）
  - `useTags` (223 行) — 标签管理：CRUD、复制/粘贴标签、清除过滤（13 项返回值）
- **P2 提取 Hook（辅助逻辑）**:
  - `useExternalDragDrop` (110 行) — 外部拖拽处理：dragEnter/Over/Leave/Drop + isExternalDragging 状态
  - `usePersistence` (53 行) — 持久化与自动保存 useEffect
  - `useFileSelection` (69 行) — 文件选择交互：handleFileClick（Ctrl/Shift/点击选择逻辑）
  - `useFolderSettings` (120 行) — 文件夹设置记忆：handleRememberFolderSettings + useEffects

### 🔧 Technical

- **Hook 依赖链设计**: 所有 23 个 Hook 按严格依赖顺序调用，确保变量声明在使用之前
  - 关键依赖：useDirectoryScan → useFileOperations（handleRefresh 前置依赖）
  - 前向声明模式：enterPeopleOverview 使用 `let` 前向声明，解决 usePeople 的引用依赖
- **代码提取策略**: 采用预定义行范围 + 底向上删除策略，避免行号偏移问题
- **原有 Hook 行数更新**: 同步修正了 12 个原有 Hook 的实际行数统计
- TypeScript 编译 **0 错误**，Vite 构建成功
- 文档全面更新：PROJECT_STRUCTURE.md / MODULE_DISTRIBUTION.md / CHANGELOG.md

---

## [1.1.3] - 2026-03-14

### ✨ New Features

#### 局域网共享功能
- 内置 HTTP 服务器，支持局域网图片共享
- Token 认证机制，支持密码保护
- 支持多设备同时连接浏览
- 远程缩略图预览和图片查看
- 可选的远程编辑权限控制
- 可选的远程上传权限控制
- 连接设备管理和状态监控
- 自动获取本机局域网 IP 地址
- 端口可用性检查
- 设置界面支持服务开关和参数配置
- 独立的 LAN Share 客户端应用（基于 Vite 单独构建）
- 共享模块设计（主应用与 LAN Share 客户端共用组件）

### 🔧 Technical

- 新增 `src-tauri/src/lan_share/` 模块
  - `server.rs` - HTTP 服务器实现
  - `handlers.rs` - 请求处理器（认证、浏览、缩略图等）
  - `session.rs` - 会话管理（Token、过期时间）
  - `device_manager.rs` - 连接设备管理
  - `types.rs` - 类型定义
- 新增 `src-tauri/src/lan_share_commands.rs` 命令模块
- 新增 `src/lan-share/` 独立客户端应用
- 新增 `src/shared/` 共享模块（组件、Hooks、工具）
- 新增 `src/components/settings/LanSharePanel.tsx` 设置面板
- 新增依赖：axum, tower, tower-http, local-ip-address, uuid
- 新增构建脚本 `vite.config.lan-share.ts`

---

## [1.1.2] - 2026-03-11

### ✨ New Features

#### 智能创建专题功能
- 根据 WD14 V3 模型的角色标签格式，自动从角色名中提取作品名
- 创建专题并关联相关人物和图片
- 支持中英文双语作品名提取
- 内置 450+ 作品名中英文映射表（series_names.json）
- 作品列表支持虚拟滚动和多选
- 显示每个作品的角色数量和图片数量
- 预览选中作品的角色和图片
- 全选/取消全选按钮
- 自动过滤已创建的同名专题
- 检测阈值滑块（0.01 - 0.5）
- 作品搜索功能
- 自定义专题分类支持

### 🐛 Bug Fixes

- 修复图片添加到人物时，人物列表超出窗口范围的问题
- 修复智能创建专题后专题为空的问题
- 修复数据库死锁问题
- 修复已存在人物无法关联文件的问题
- 修复排序错误 `localeCompare is not a function`
- 修复图片数量显示为 0 的问题

### 💄 UI/UX Improvements

- 优化自动设置的人物头像、专题封面的锯齿问题
- 优化颜色搜索显示，不再直接在搜索框输出颜色值
- 重新设计标签界面的索引，从竖向改为居中横向布局
- 智能创建专题模态框 UI 优化：
  - 列表行高调整为 104px
  - 侧边栏宽度设置为 360px
  - 预览封面尺寸调整为 3:4 比例
  - "已创建"标签样式更新（绿色背景白色文字）
  - 预览区域使用缩略图替代原图，降低显存压力

### 🔧 Technical

- 新增 `src-tauri/src/work_extractor.rs` 作品名提取模块
- 新增命令 `clip_get_work_topics` 和 `clip_create_work_topics`
- 扩展 Topic 数据结构（source_type, work_name, work_name_cn）
- 扩展 Person 数据结构（character_tag_name, character_tag_index）
- 修复 react-window 兼容性问题

---

## [1.1.1] - 2026-03-05

### Bug Fixes
- Minor bug fixes and stability improvements

---

## [1.1.0] - 2026-02-28

### New Features
- WD14 Tagger integration for automatic tag generation
- CLIP model integration for semantic image search
- AI-powered image analysis and description generation

### Improvements
- Performance optimizations for large image libraries
- Enhanced thumbnail caching system

---

## [1.0.0] - 2026-01-15

### Initial Release
- Multi-library management
- Fast search with multiple dimensions
- Color search based on CIEDE2000 algorithm
- Face recognition and person grouping
- Topic management
- Custom tag system
- AI intelligent features
- Multiple view modes
- Image comparison
- Dark theme support
- Multi-language support (Chinese/English)
- Auto-update functionality
