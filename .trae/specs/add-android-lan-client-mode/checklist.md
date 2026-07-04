# Checklist

## 安卓系统权限
- [x] `AndroidManifest.xml` 新增 `android.permission.CAMERA` 权限声明
- [x] `usesCleartextTraffic` 配置允许本地网络明文 HTTP（可连接 `http://192.168.x.x:8080`）
- [x] Kotlin 端提供 `check_camera_permission` 与 `request_camera_permission` 命令
- [x] 首次点击"扫码连接"时弹出摄像头权限请求
- [x] 用户授予摄像头权限后能正常启动扫码
- [x] 用户拒绝摄像头权限时显示提示并提供降级手动输入入口
- [x] 权限被永久拒绝时引导用户前往系统设置（ensureCameraPermission 返回 false，LanClientPanel 始终可见的手动 host/port 输入框作为降级入口）
- [x] 安卓端可正常发起 HTTP 请求到桌面端服务器（INTERNET 权限已存在）

## 类型与设置
- [x] `LanShareSettings` 接口新增 `clientMode`、`serverHost`、`serverPort`、`serverAccessToken`、`savedServers` 字段
- [x] 新增 `SavedServer` 接口并导出
- [x] `FileNode` 接口新增可选 `source?: 'local' | 'lan'` 与 `remotePath?: string` 字段
- [x] 新字段能正确序列化到 settings 文件并反序列化恢复
- [x] 桌面端现有服务器配置字段不受新字段影响（向后兼容）
- [x] 未设置 `source` 的 FileNode 视为 `source: 'local'`（向后兼容）

## 客户端 API 模块
- [x] `lanClientApi.ts` 提供 `authenticate`、`browse`、`browseToFolderNodes`、`getThumbnailUrl`、`getImageUrl`、`search`、`getDevices`、`deleteFile`、`uploadFile` 方法
- [x] API 模块支持运行时注入 `baseUrl`（`http://{host}:{port}`）与 `token`
- [x] `browseToFolderNodes` 正确将 `/api/browse` 响应转换为带 `source: 'lan'` 的 `FileNode[]`
- [x] 鉴权失败（401）时清除 token 并提示重新连接
- [x] 网络错误有明确错误提示（连接超时、服务器无响应等）

## 安卓端客户端面板
- [x] 安卓端打开局域网设置显示客户端模式面板（无 QR 码生成、无服务器 URL 显示、无已连接设备列表）
- [x] 手动输入 IP+端口+访问码可成功连接桌面端服务器
- [x] 连接失败时显示错误提示（访问码错误、服务器无响应等）
- [x] 已连接状态显示服务器信息与"进入浏览"按钮
- [x] "最近服务器"列表展示已保存服务器，点击可快速填充
- [x] 断开连接后状态正确回到未连接
- [x] 桌面端局域网面板保持原有服务器模式不变

## TreeSidebar "网络"选项栏
- [x] TreeSidebar"本地相册"下方显示"网络"分区（仅安卓端）
- [x] 未连接状态显示灰色 WifiOff 图标与"未连接"提示
- [x] 点击未连接提示可跳转到设置局域网面板
- [x] 已连接状态展开时显示桌面根目录文件夹列表
- [x] 点击网络文件夹主内容区切换到该文件夹，复用现有网格/排序/导航逻辑
- [x] 网络文件夹子节点通过 `/api/browse` 按需加载
- [x] 网络分区样式与现有分区（本地相册/专题/人物/标签）视觉一致

## 网络文件缩略图与原图加载
- [x] `source: 'lan'` 的文件缩略图通过 `/api/thumbnail` URL 加载
- [x] `source: 'lan'` 的文件原图通过 `/api/image` URL 加载
- [x] 本地文件（`source: 'local'` 或未设置）缩略图/原图加载行为不变（无回归）

## 从桌面添加到画布
- [x] 主内容区选中网络图片后"添加到画布"按钮触发下载流程
- [x] 单张网络图片可下载并添加到安卓画布
- [x] 批量下载遵循 4 张/批、200ms 间隔约束
- [x] 下载过程显示 loading overlay 与进度
- [x] `AddImageModal` 安卓端左侧分类新增"桌面图库"入口
- [x] 未连接时"桌面图库"入口显示未连接提示或引导去设置连接

## 图片查看器
- [x] 单击网络图片可全屏查看原图
- [x] 支持左右滑动切换网络图片
- [x] 支持双指缩放

## 上传功能
- [x] 桌面端 `allow_upload` 开启时安卓端显示"上传"按钮
- [x] 桌面端 `allow_upload` 关闭时安卓端隐藏"上传"按钮
- [x] 上传成功后当前目录列表自动刷新
- [x] 上传过程有进度提示
- [x] 桌面端 `POST /api/upload` 端点正确保存文件到 root_path

## 国际化
- [x] 所有新增文案有中文与英文翻译
- [x] 权限相关提示文案有翻译
- [x] 无硬编码中文字符串（除调试日志外）

## 编译与运行
- [x] TypeScript 编译无错误
- [x] Rust 编译无错误（若新增上传端点）
- [x] 桌面端局域网共享功能未受影响（无回归）
- [x] 桌面端本地文件浏览功能未受影响（无回归）
- [x] 安卓端本地文件浏览功能未受影响（无回归）
- [x] 安卓端无运行时崩溃
