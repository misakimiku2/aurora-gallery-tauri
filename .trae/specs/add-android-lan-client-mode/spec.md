# 安卓端局域网客户端模式 Spec

## Why
当前局域网共享功能仅支持桌面端作为 HTTP 服务器，安卓端设置中虽保留该选项但无法开启（移动设备不具备稳定开服务器的属性）。需要将安卓端的局域网功能从"服务器模式"改为"客户端模式"，使安卓版能够连接到桌面端服务器，实现更深层次的数据互联（浏览桌面图库、将桌面图片添加到安卓画布、查看桌面图片、上传安卓图片到桌面）。

## What Changes
- **BREAKING**: 安卓端局域网设置面板由"服务器模式"切换为"客户端模式"，不再显示 QR 码、服务器 URL、已连接设备列表等服务端 UI
- 安卓端新增"连接到桌面"客户端面板：手动输入（IP+端口+访问码）或扫描桌面端 QR 码建立连接
- 安卓端新增 LAN 客户端 API 模块，封装对桌面端 REST API 的调用（复用现有 `/api/auth/verify`、`/api/browse`、`/api/thumbnail`、`/api/image`、`/api/search`、`/api/devices` 端点）
- 安卓端左侧面板（TreeSidebar.tsx）"本地相册"下方新增"网络"选项栏：已连接时切换到桌面服务端的文件界面，直接复用现有文件操作（导航、缩略图、查看、添加到画布）等逻辑
- 安卓端"添加图片到画布"流程中新增"从桌面"来源，可将桌面图片下载并添加到安卓画布
- 安卓端支持查看桌面图片（全屏查看器）
- 安卓端支持上传图片到桌面（当桌面端 `allow_upload` 开启时）
- 桌面端局域网面板保持不变（仍为服务器模式），但补充说明文案区分两端角色
- 扩展 `LanShareSettings` 类型以支持客户端配置（服务器地址、已保存服务器列表、连接状态）
- 扩展 `FileNode` 类型以支持网络来源标记（`source` 字段），使现有文件操作逻辑可透明复用于网络文件
- 安卓端系统权限：补充摄像头权限（QR 扫码用）并完善运行时权限请求流程；确认网络访问权限已就绪（INTERNET 权限已存在，需确保本地网络明文 HTTP 可用）

## Impact
- Affected specs: 局域网共享设置界面、添加图片到画布流程
- Affected code:
  - `src/components/settings/LanSharePanel.tsx`（安卓端分支为客户端面板）
  - `src/types.ts`（扩展 `LanShareSettings`）
  - `src/api/tauri-bridge.ts`（可能新增客户端持久化命令）
  - `src/lan-share/api.ts`（复用为客户端 API 基础）
  - 新增 `src/components/lan-client/` 目录（客户端面板、浏览器、查看器）
  - `src/components/modals/AddImageModal.tsx`（安卓端新增"从桌面"来源入口）
  - `src/locales/`（新增客户端相关翻译键）
  - `src-tauri/src/lan_share_commands.rs`（可能新增客户端配置持久化命令，复用现有 settings 持久化即可）

## ADDED Requirements

### Requirement: 安卓端局域网客户端模式
系统 SHALL 在安卓端将局域网共享设置面板切换为客户端模式，提供连接到桌面端服务器的功能。

#### Scenario: 安卓用户手动连接桌面服务器
- **WHEN** 安卓用户在设置中打开局域网共享面板
- **THEN** 显示客户端模式 UI（连接表单：服务器地址、端口、访问码）
- **WHEN** 用户填写完整信息并点击"连接"
- **THEN** 系统调用桌面端 `/api/auth/verify` 验证访问码
- **AND** 验证成功后显示已连接状态（服务器名称、IP、在线设备数）
- **AND** 验证失败时显示错误提示

#### Scenario: 安卓用户扫描 QR 码连接
- **WHEN** 安卓用户点击"扫码连接"按钮
- **THEN** 调用设备摄像头扫描桌面端显示的 QR 码
- **WHEN** 扫码成功解析出服务器 URL
- **THEN** 自动填充服务器地址和端口，跳转到访问码输入
- **WHEN** 用户输入访问码并确认
- **THEN** 完成连接

#### Scenario: 已保存服务器快速重连
- **WHEN** 安卓用户此前已成功连接过某服务器
- **THEN** 在连接面板显示"最近服务器"列表
- **WHEN** 用户点击列表中的服务器条目
- **THEN** 自动填充地址、端口，仅需输入访问码即可重连

### Requirement: 局域网图片浏览
系统 SHALL 在安卓端提供应用内局域网图片浏览器，浏览桌面端图库数据。

#### Scenario: 浏览桌面图库文件夹
- **WHEN** 安卓用户在已连接状态下打开"局域网浏览"
- **THEN** 显示桌面端根目录的文件夹和图片列表（网格布局）
- **WHEN** 用户点击文件夹
- **THEN** 进入该文件夹并显示其内容
- **AND** 支持返回上级目录和历史导航
- **AND** 缩略图通过桌面端 `/api/thumbnail` 加载

#### Scenario: 搜索桌面图库
- **WHEN** 安卓用户在局域网浏览器中输入搜索关键词
- **THEN** 调用桌面端 `/api/search` 进行搜索
- **AND** 显示匹配的文件夹和图片结果

### Requirement: 从桌面添加图片到安卓画布
系统 SHALL 支持从桌面端图库选择图片并添加到安卓端画布。

#### Scenario: 添加单张桌面图片到画布
- **WHEN** 安卓用户在局域网浏览器中选择一张图片并点击"添加到画布"
- **THEN** 系统通过 `/api/image` 下载该图片到安卓本地缓存
- **AND** 将下载的图片添加到当前画布
- **AND** 显示下载进度（loading overlay）

#### Scenario: 批量添加桌面图片到画布
- **WHEN** 安卓用户在局域网浏览器中多选图片并点击"添加到画布"
- **THEN** 系统按批次下载（遵循安卓批量加载约束：4 张/批，200ms 间隔）
- **AND** 显示加载 overlay 和进度指示
- **AND** 全部下载完成后添加到画布

### Requirement: 查看桌面图片
系统 SHALL 支持在安卓端全屏查看桌面端图片。

#### Scenario: 全屏查看桌面图片
- **WHEN** 安卓用户在局域网浏览器中点击图片缩略图
- **THEN** 打开全屏查看器，通过 `/api/image` 加载原图
- **AND** 支持左右滑动切换图片
- **AND** 支持缩放手势

### Requirement: 上传安卓图片到桌面
系统 SHALL 支持在桌面端允许上传时，将安卓端图片上传到桌面端图库。

#### Scenario: 上传图片到桌面
- **WHEN** 桌面端 `allow_upload` 开启
- **AND** 安卓用户在局域网浏览器中点击"上传图片"
- **THEN** 选择安卓本地图片
- **AND** 通过 HTTP POST 上传到桌面端
- **AND** 上传成功后刷新目录列表

#### Scenario: 桌面端禁止上传
- **WHEN** 桌面端 `allow_upload` 关闭
- **THEN** 安卓端不显示"上传图片"按钮或将其禁用

## MODIFIED Requirements

### Requirement: 局域网共享设置面板
原需求：统一的服务器模式面板，显示 QR 码、访问码、服务器 URL、已连接设备。

修改后：根据平台区分显示。
- **桌面端**：保持服务器模式面板不变（QR 码、访问码、URL、已连接设备、允许编辑/上传开关）
- **安卓端**：显示客户端模式面板（连接表单、最近服务器、连接状态、进入浏览按钮）
- **WHEN** 平台为 Android
- **THEN** 渲染客户端面板
- **WHEN** 平台为桌面
- **THEN** 渲染服务器面板（现有逻辑）

### Requirement: LanShareSettings 类型
原类型仅包含服务器配置字段。修改后新增客户端配置字段（仅在安卓端使用）：

```typescript
export interface LanShareSettings {
  // 服务器配置（桌面端使用，安卓端忽略）
  enabled: boolean;
  port: number;
  accessCode: string;
  allowEdit: boolean;
  allowUpload: boolean;
  // 客户端配置（安卓端使用，桌面端忽略）
  clientMode?: boolean;           // 是否为客户端模式（安卓端恒为 true）
  serverHost?: string;            // 当前连接的服务器 IP
  serverPort?: number;            // 当前连接的服务器端口
  serverAccessToken?: string;     // 当前会话 token
  savedServers?: SavedServer[];   // 已保存的服务器列表
}

export interface SavedServer {
  host: string;
  port: number;
  name?: string;        // 服务器名称（如 "我的电脑"）
  lastConnected: number; // 最后连接时间戳
}
```

### Requirement: FileNode 类型扩展（支持网络来源）
原 `FileNode` 仅描述本地文件。修改后新增可选 `source` 字段以支持网络来源文件，使现有文件操作逻辑可透明复用：

```typescript
export interface FileNode {
  // ... 现有字段保持不变
  source?: 'local' | 'lan';   // 文件来源，默认 'local'；'lan' 表示来自桌面端局域网服务器
  remotePath?: string;         // 网络文件在桌面端的路径（source='lan' 时使用）
}
```

- 缩略图加载、原图加载、文件导航等模块 SHALL 检测 `source` 字段，对 `source: 'lan'` 的节点使用 LAN 客户端 API URL 而非本地 `convertFileSrc`
- 所有未设置 `source` 的节点视为 `source: 'local'`（向后兼容）
