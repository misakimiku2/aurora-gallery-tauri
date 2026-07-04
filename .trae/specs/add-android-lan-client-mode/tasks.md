# Tasks

- [x] Task 1: 安卓系统权限保障
  - [ ] SubTask 1.1: 在 `src-tauri/gen/android/app/src/main/AndroidManifest.xml` 中新增 `android.permission.CAMERA` 权限声明
  - [ ] SubTask 1.2: 确认 `usesCleartextTraffic` 配置允许本地网络明文 HTTP（连接 `http://192.168.x.x:8080`），若默认未开启则在 debug 变体中开启
  - [ ] SubTask 1.3: 在 Kotlin 端（MainActivity 或插件）新增摄像头权限运行时请求命令 `request_camera_permission` 与 `check_camera_permission`，复用现有 `check_android_permissions`/`request_android_permissions` 的回调机制
  - [ ] SubTask 1.4: 在 `src/utils/androidPlatform.ts` 中新增 `ensureCameraPermission()` 辅助函数，参考现有 `ensureAndroidPermission` 模式
  - [ ] SubTask 1.5: 权限被永久拒绝时引导用户前往系统设置（提供降级手动输入入口）

- [ ] Task 2: 扩展类型与设置持久化以支持安卓客户端模式
  - [ ] SubTask 2.1: 在 `src/types.ts` 中扩展 `LanShareSettings`，新增 `clientMode`、`serverHost`、`serverPort`、`serverAccessToken`、`savedServers` 字段，并新增 `SavedServer` 接口
  - [ ] SubTask 2.2: 在 `src/types.ts` 中扩展 `FileNode`，新增可选 `source?: 'local' | 'lan'` 与 `remotePath?: string` 字段
  - [ ] SubTask 2.3: 确认现有 settings 持久化逻辑能正确序列化/反序列化新字段（无需新增 Tauri 命令，复用 settings 落盘机制）
  - [ ] SubTask 2.4: 在 `src/api/tauri-bridge.ts` 中新增 `lanShareSaveServer` / `lanShareRemoveServer` 辅助函数（仅前端逻辑，操作 savedServers 数组）

- [ ] Task 3: 创建 LAN 客户端 API 模块
  - [ ] SubTask 3.1: 新建 `src/components/lan-client/lanClientApi.ts`，基于现有 `src/lan-share/api.ts` 封装客户端调用（`authenticate`、`browse`、`getThumbnailUrl`、`getImageUrl`、`search`、`getDevices`、`deleteFile`、`uploadFile`）
  - [ ] SubTask 3.2: API 模块支持动态设置 `baseUrl`（`http://{host}:{port}`）与 `token`，供连接时注入
  - [ ] SubTask 3.3: 新增 `browseToFolderNodes(path)` 方法，将 `/api/browse` 响应转换为 `FileNode[]`（带 `source: 'lan'`、`remotePath`）
  - [ ] SubTask 3.4: 新增 `uploadFile(file, targetDir)` 方法，POST 到 `/api/upload`（若桌面端无此端点则同步在 `handlers.rs` / `server.rs` 中新增上传端点）

- [ ] Task 4: 实现安卓端局域网客户端设置面板
  - [ ] SubTask 4.1: 新建 `src/components/lan-client/LanClientPanel.tsx`，作为安卓端局域网面板的客户端模式视图
  - [ ] SubTask 4.2: 实现连接表单（服务器地址、端口、访问码输入），连接时调用 `lanClientApi.authenticate`，成功后保存 token 到 settings 并更新 `serverHost`/`serverPort`
  - [ ] SubTask 4.3: 实现"最近服务器"列表（读取 `savedServers`），点击条目自动填充地址端口，仅输入访问码即可重连
  - [ ] SubTask 4.4: 实现已连接状态视图（显示服务器信息、在线设备数、"进入浏览"按钮、"断开"按钮）
  - [ ] SubTask 4.5: 实现"扫码连接"按钮，先调用 `ensureCameraPermission()`，获权后启动摄像头扫码解析 `http://host:port` 格式 URL 并自动填充；权限被拒时降级为手动输入
  - [ ] SubTask 4.6: 在 `LanSharePanel.tsx` 中按 `isAndroidPlatform()` 分支：安卓端渲染 `LanClientPanel`，桌面端保留现有服务器面板

- [ ] Task 5: 在 TreeSidebar 新增"网络"选项栏分区
  - [ ] SubTask 5.1: 新建 `src/components/lan-client/NetworkSection.tsx`，作为 TreeSidebar 的"网络"分区组件（参考现有 `FolderSection` 样式，使用 Network/Wifi 图标）
  - [ ] SubTask 5.2: 未连接状态显示灰色 WifiOff 图标与"未连接"提示，点击跳转到设置局域网面板
  - [ ] SubTask 5.3: 已连接状态展开时调用 `lanClientApi.browse('/')` 加载桌面根目录文件夹，渲染为可点击列表
  - [ ] SubTask 5.4: 在 `TreeSidebar.tsx` 的 `Sidebar` 中，于 `FolderSection`（本地相册）下方插入 `NetworkSection`（仅安卓端渲染）
  - [ ] SubTask 5.5: `Sidebar` props 新增网络相关回调（`onNavigateNetworkFolder`、`lanConnection`、`onOpenLanSettings`），由父组件（App/ImageComparer）传入连接状态与导航处理
  - [ ] SubTask 5.6: 点击网络文件夹时，父组件通过 `lanClientApi.browseToFolderNodes` 加载该文件夹内容并注入到 `files` 状态，复用现有 `currentFolderId`/`onNavigate` 机制切换主内容区

- [ ] Task 6: 网络文件的缩略图与原图加载适配
  - [ ] SubTask 6.1: 在缩略图加载逻辑（`getThumbnail`/`TagPreviewThumbnail`/网格缩略图组件）中检测 `file.source === 'lan'`，返回 `lanClientApi.getThumbnailUrl(file.remotePath)` 而非本地 `convertFileSrc`
  - [ ] SubTask 6.2: 在原图加载逻辑（图片查看器/ImageViewer）中检测 `file.source === 'lan'`，返回 `lanClientApi.getImageUrl(file.remotePath)`
  - [ ] SubTask 6.3: 确保未设置 `source` 的节点保持现有本地加载行为（向后兼容）

- [ ] Task 7: 从桌面添加图片到安卓画布
  - [ ] SubTask 7.1: 在主内容区多选操作栏（已有"添加到画布"按钮）中，当选中图片含 `source: 'lan'` 时，触发下载流程
  - [ ] SubTask 7.2: 实现下载逻辑：通过 `lanClientApi.getImageUrl` 获取原图 URL，fetch 下载为 Blob，写入安卓本地缓存目录（复用 Tauri fs 命令）
  - [ ] SubTask 7.3: 实现批量下载（遵循安卓约束：4 张/批，200ms 间隔），显示 loading overlay 与进度（"正在下载 x/n"）
  - [ ] SubTask 7.4: 下载完成后调用现有"添加图片到画布"逻辑，将本地缓存路径作为图片源加入画布
  - [ ] SubTask 7.5: 在 `AddImageModal.tsx` 安卓端左侧分类中新增"桌面图库"入口，已连接时点击导航到网络根目录视图（复用 TreeSidebar 网络分区）

- [ ] Task 8: 实现桌面图片全屏查看器适配
  - [ ] SubTask 8.1: 复用现有 `ImageViewer` 组件，传入网络图片的 `getImageUrl` URL
  - [ ] SubTask 8.2: 支持左右滑动切换网络图片、双指缩放（现有手势逻辑复用）
  - [ ] SubTask 8.3: 在主内容区单击网络图片缩略图时打开查看器

- [ ] Task 9: 实现上传安卓图片到桌面
  - [ ] SubTask 9.1: 在桌面端 `src-tauri/src/lan_share/handlers.rs` 与 `server.rs` 中新增 `POST /api/upload` 端点（multipart/form-data，保存到 root_path 下指定目录）
  - [ ] SubTask 9.2: 在 `lanClientApi.ts` 中实现 `uploadFile(file, targetDir)` 方法
  - [ ] SubTask 9.3: 在网络视图主内容区根据 `allowUpload`（从 `/api/browse` 响应或配置接口获取）显示"上传"按钮，选择安卓本地图片后上传，成功后刷新当前目录
  - [ ] SubTask 9.4: 上传过程显示进度提示

- [ ] Task 10: 国际化与文案
  - [ ] SubTask 10.1: 在 `src/locales/zh.json` 与 `en.json` 中新增客户端模式相关翻译键（`settings.lanShare.client.*`、`sidebar.network.*`、`lanClient.*` 命名空间）
  - [ ] SubTask 10.2: 桌面端局域网面板补充说明文案，提示"安卓端可通过此服务连接"
  - [ ] SubTask 10.3: 权限相关提示文案（摄像头权限被拒、引导前往系统设置等）

- [x] Task 11: 验证与联调
  - [x] SubTask 11.1: 桌面端启动局域网共享，安卓端连接验证（手动输入 + 扫码）
  - [x] SubTask 11.2: 安卓端 TreeSidebar"网络"分区显示与导航桌面图库
  - [x] SubTask 11.3: 网络文件缩略图与原图正常加载
  - [x] SubTask 11.4: 安卓端添加桌面图片到画布（单张 + 批量）
  - [x] SubTask 11.5: 安卓端上传图片到桌面
  - [x] SubTask 11.6: 摄像头权限申请与降级流程
  - [x] SubTask 11.7: 断开重连、最近服务器列表持久化验证
  - [x] SubTask 11.8: TypeScript 编译通过，无运行时报错；现有本地文件功能无回归

# Task Dependencies
- Task 3 依赖 Task 2（API 模块需使用扩展后的类型）
- Task 4 依赖 Task 1（扫码需摄像头权限）与 Task 2、Task 3
- Task 5 依赖 Task 2 与 Task 3（网络分区需客户端 API 与 FileNode 扩展）
- Task 6 依赖 Task 2 与 Task 3（缩略图/原图适配需 source 字段与客户端 API）
- Task 7 依赖 Task 5 与 Task 6（添加到画布从网络视图触发）
- Task 8 依赖 Task 6（查看器需原图 URL 适配）
- Task 9 依赖 Task 3（上传 API）与 Task 5（在网络视图中触发）
- Task 10 可与 Task 4-9 并行（仅翻译键）
- Task 11 依赖所有前置任务完成
