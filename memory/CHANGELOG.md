# Changelog

All notable changes to this project will be documented in this file.

## [2.0.0] - 2026-09-29

> 2.0 是一次跨平台大版本升级：安卓端放弃 WebView（React）方案，以 Kotlin + Jetpack Compose 全新重建原生客户端并与桌面端共用 Rust 核心库；桌面端完成局域网互联大升级与一批长期缺陷修复。自 v1.1.3 起共 250+ 提交。

### ✨ New Features

#### 全新 Android 原生客户端（Kotlin + Jetpack Compose，React 版退役）
- 与桌面端共用同一 Rust 核心库（UniFFI 桥接）：标签分组、颜色算法、主色调提取、AI 编排等逻辑两端同源
- 本地图库：MediaStore 原生接入与热更新（ContentObserver 防抖对账），网格/瀑布流/列表三视图、捏合换列、进夹直出、返回总览零刷新、吸顶分组标题、根目录散图归组
- 原生查看器：手势缩放/翻页、GIF 与动画 WebP、大图字节流管线、幻灯片播放、图片信息编辑抽屉、分享、加入画布
- 平板形态还原桌面端（双栏侧栏、设置双栏对话框、悬浮卡片化主界面、画布与比较器）；手机形态（平移抽屉导航、精简顶栏、逐级返回链）
- 画布：装箱布局与 React 原算法 JVM 对拍、编辑手柄（等比缩放/自由旋转/边缘吸附）、沉浸全屏、点阵背景逐参数对齐
- 文件管理：重命名/移动/删除/复制「先改后授权」，开启「所有文件访问」后操作零弹窗；批量选择、图形化长按菜单、文件夹创建
- 全维搜索：文件名/标签/文件夹 scope 搜索、HSV 取色器（平板右侧推挤面板/手机底部弹层）、CIEDE2000 颜色搜索、AI 智能搜索
- 标签/人物/专题全量管理：词表分组与建议、专题杂志式界面与封面、人物卡/专题卡长按管理
- 局域网互联：扫码/手输配对桌面端、远程浏览与缩略图、上传与保存到设备、在线读写（重命名/移动/删除/复制/元数据/标签/人物/专题）、远端人物/专题筛选、双向配对
- AI 功能：批量分析、智能重命名、语义搜索、WD14 人物识别与作品归组、以图搜图、主色调批量提取与颜色搜索全链
- 应用内更新（GitHub→Gitee 双源自动降级、长任务不随旋屏中断）、扫描进度通知（可取消）、设置备份导出导入（SAF）

#### 桌面端
- 局域网共享大升级：与安卓端双向配对（侧栏「移动设备」直达手机相册）、元数据/人物/专题双端同步、手机端在线读写
- AI 算力卸载端点：手机端可调用桌面 WD14 / CLIP 模型（人物识别、语义搜索、以图搜图）
- 经典 3D 文件夹图标 Canvas 预合成与简洁图标档
- 更新检查器四级降级链（GitHub API → Releases 页 → Gitee 清单 → 网页抓取），国内网络可用性大幅提升
- 右键菜单与顶部工具栏 UI 迭代

### 🐛 Bug Fixes

#### 桌面端
- 标签「重命名标签」「粘贴标签」不落库——重启（或重扫目录）后改动消失、词表与文件标签分叉（D14 缺陷销账）
- 文件重命名后元数据/索引行被目录迁移逻辑整行异步删除（LAN rename 联调暴露，桌面 rename 同函数同病）
- 移动设备双向配对后桌面侧栏常显「未连接」——生产构建 CSP 拦截 webview 反向请求 + 恢复路径不重配对，两处同修
- 文件夹图标缩放叠加、悬停闪白、重启灰卡
- 拖拽文件夹闪烁；图像比较器滚动冻结时机
- 启动性能、颜色提取稳定性、缩略图解码并发问题
- Rust 后端健壮性治理（防闪退 + 日志轮转 + 打开日志文件夹入口）

#### Android（原生版）
- 60MP 扫描件等超大图文件夹卡死（缩略图自带降采样解码）
- 进文件夹缩略图全白只剩文件名（AndroidView 更新提前返回后永不重试）
- 进文件夹闪「文件夹为空」文案与空白帧（用户报障两轮：空态文案门闩 + 序列缓存同步首发 + 组合期提交三处同修）
- 从文件夹返回主界面整体刷新一下（RecyclerView/adapter 跨组合复用，滚动位置与已绑封面原样保留）
- 分组模式下网格/瀑布流布局错位；吸顶分组标题两处
- 查看器抽屉延迟显示、翻页后格子 0x0、竖屏面板把手消失、菜单定位坐标系双重计算
- 返回键无法关闭搜索框（IME 输入段吃掉返回，pre-IME 拦截壳）；翻页高频触觉反馈移除
- 多选后文件名消失、选中框缺下边、返回总览重排/位置漂移、下拉刷新指示器闪烁
- LAN 缩略图并发写交错产出损坏 JPEG 且落盘自永固；远端人物/专题筛选视图错误落回本地分支
- 文件操作对索引死行永远报「删除失败」（改幂等，并给死行清理机会）
- 专题详情页嵌套滚动自激振荡、侧栏开合卡片瞬变/跳档
- 画布浅色占位块不可见、编辑手柄图标斜线贯穿、点阵背景双重 alpha 折损致点阵不可见
- 状态栏 insets 遮挡顶栏致按钮不可点
- 专题 fileCount 双向漂移（upsert 覆盖缓存列 + 对账清理孤儿）

#### 互联（两端）
- 以图搜图临时文件扩展名被拒识
- 存量局域网配置 allow_upload=false 从未有过开关却被硬写（一次性迁移放开）

### 🛠 Performance
- 桌面：虚拟滚动与滚动期样式优化、文件夹图标 Canvas 合成 v4（Worker 化/队列治理/字节预算缓存）、主网格合并单合成层、设置弹窗低负载背景
- Android：RecyclerView 网格与三档捏合进度驱动 FLIP 重写、缩略图并发控制、树滚动帧率、下拉刷新帧率

### 🔧 Build / 工程
- @tauri-apps/api 与 plugin-log/plugin-fs/plugin-dialog npm 包与 Rust crate 小版本对齐，修复 tauri build 版本错配报错
- Android 接入正式签名链路（keystore.properties 注入，凭据文件不入库）
- App.tsx 拆分重构（5211→2670 行）与 tauri-bridge IPC 层领域模块化、CI 工作流、核心工具函数 37 个单测
- core crate 拆分（db/color/file_types），标签/颜色/AI 逻辑下沉 Rust 并配单测（对拍 React 原算法）

---

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
