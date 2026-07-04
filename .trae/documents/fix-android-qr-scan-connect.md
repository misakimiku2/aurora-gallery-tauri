# 修复安卓端扫码连接功能

## Context

当前安卓端"扫码连接"按钮点击后：
1. 只请求了摄像头权限，没有实际打开摄像头
2. 弹出一个手动输入 URL 的输入框，与上方的服务器地址输入框完全重复
3. 用户期望：点击扫码 → 打开摄像头扫描桌面端二维码 → 自动连接（无需输入访问码）→ 保存连接供下次自动重连

根本原因：QR 扫描功能是 TODO 占位符，桌面端 QR 码也未包含访问码。

## 实施步骤

### 1. 安装 html5-qrcode 依赖

```bash
npm install html5-qrcode
```

纯 JS 库，封装了 getUserMedia + 视频帧解码，在 Tauri Android WebView 中可用。

### 2. 修改 MainActivity.kt — 添加 WebView 层权限授予

**文件**: `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt`

在 `MainActivity` 类中添加 `onPermissionRequest` 重写。这是**关键修复**——Android WebView 默认会拒绝 getUserMedia 请求，即使已获得 Android 系统级摄像头权限也无效。必须在 WebView 层显式授予 `RESOURCE_VIDEO_CAPTURE` 权限。

```kotlin
override fun onPermissionRequest(request: android.webkit.PermissionRequest) {
  runOnUiThread {
    val resources = request.resources
    val granted = resources.filter { resource ->
      when (resource) {
        android.webkit.PermissionRequest.RESOURCE_VIDEO_CAPTURE -> {
          ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED
        }
        else -> true
      }
    }
    if (granted.size == resources.size) {
      request.grant(resources)
    } else {
      request.deny()
    }
  }
}
```

### 3. 修改桌面端 QR 码内容 — 包含访问码

**文件**: `src/components/settings/LanSharePanel.tsx`

将 QR 码内容从纯 URL `http://IP:PORT` 改为 JSON 格式：
```json
{"type":"aurora-lan","url":"http://192.168.1.100:8080","code":"1234"}
```

同时修改 `handleCopyUrl`，确保复制给用户的是纯 URL（不是 JSON）。
在 QR 码下方添加提示文字："手机扫码即可自动连接，无需手动输入访问码"。

### 4. 创建 QR 数据解析工具

**新文件**: `src/components/lan-client/qrParseUtils.ts`

- `parseQrData(rawText)` 函数，支持两种格式：
  - 新格式 JSON: `{"type":"aurora-lan","url":"http://...","code":"1234"}`
  - 旧格式纯 URL: `http://IP:PORT`（降级：填充地址但需手动输入访问码）
- 返回 `ParsedQrData { host, port, code? }`
- 复用 `LanClientPanel` 中已有的 `parseServerUrl` 逻辑

### 5. 创建 QR 扫描器组件

**新文件**: `src/components/lan-client/QrScannerModal.tsx`

全屏深色遮罩扫描器 UI：
- 使用 `Html5Qrcode` 库，`facingMode: "environment"` 后置摄像头
- 顶部关闭按钮 + 标题"扫描二维码"
- 中央扫描区域
- 底部提示"将桌面端二维码放入框内"
- 扫描成功后立即 `stop()` 并回调 `onScanResult`
- 错误状态处理（相机不可用等）
- z-index 400，高于 AppModals 的 300

### 6. 重构 LanClientPanel.tsx

**文件**: `src/components/lan-client/LanClientPanel.tsx`

- **删除** `showScanInput`、`scanUrl` 状态和 `handleScanSubmit` 函数
- **删除** JSX 中的手动 URL 输入区域（第 366-401 行）
- **新增** `scanning` 状态控制扫描器开关
- **重写** `handleScan`：获取权限后 `setScanning(true)`
- **新增** `handleScanResult`：
  1. 调用 `parseQrData` 解析扫描结果
  2. 填充 host/port/code
  3. 如果有 code（新格式），自动调用 `lanClientApi.authenticate(code)` 认证
  4. 认证成功：保存连接（token、host、port 持久化到 settings），标记已连接
  5. 如果无 code（旧格式）：提示用户输入访问码
- **添加** `QrScannerModal` 组件

### 7. 更新翻译文件

**文件**: `src/utils/translations.ts`

新增翻译 key：
- `settings.lanShare.client.invalidQr` — 无法识别二维码内容
- `settings.lanShare.client.scanTip` — 将桌面端二维码放入框内
- `settings.lanShare.qrContainsCode` — 二维码已包含访问码，扫码即可自动连接
- `settings.lanShare.qrTip` — 手机扫码即可自动连接，无需手动输入访问码
- `settings.lanShare.client.cameraNotAvailable` — 相机不可用

## 验证方式

1. 桌面端开启 LAN 共享 → QR 码内容确认为 JSON 格式且包含访问码
2. 安卓端点击"扫码连接" → 摄像头权限请求 → 全屏扫描器打开
3. 扫描桌面 QR 码 → 自动填充地址和访问码 → 自动认证 → 连接成功
4. 杀掉 App 重启 → 自动重连（利用已保存的 token）
5. 扫描旧格式纯 URL QR 码 → 填充地址但提示输入访问码
6. 拒绝摄像头权限 → 显示错误提示，仍可手动输入连接
