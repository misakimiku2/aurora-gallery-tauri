# Aurora Gallery Android 版本开发记录

## 概述

本文档记录了 Aurora Gallery Android 版本的核心开发工作，包括环境配置、项目结构调整、核心代码实现、编译问题修复、权限管理等内容。

---

## 第一阶段：基础架构搭建

**开发日期**：2026年3月15日

## 一、配置文件修改

### 1.1 tauri.conf.json

**文件路径**: `src-tauri/tauri.conf.json`

添加了 Android 平台配置：

```json
{
  "bundle": {
    "android": {
      "minSdkVersion": 24,
      "versionCode": 1
    }
  }
}
```

同时修改了 `beforeDevCommand` 以支持自动启动 Vite 开发服务器：

```json
{
  "build": {
    "beforeDevCommand": "npm run dev",
    "devUrl": "http://localhost:14422",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  }
}
```

### 1.2 Cargo.toml

**文件路径**: `src-tauri/Cargo.toml`

添加了库目标配置和 Android 特定依赖：

```toml
[lib]
name = "aurora_gallery_lib"
crate-type = ["staticlib", "cdylib", "rlib"]
path = "src/lib.rs"

[[bin]]
name = "aurora-gallery"
path = "src/main.rs"

# Android 特定依赖
[target.'cfg(target_os = "android")'.dependencies]
jni = "0.21"
ndk = "0.8"
ndk-sys = "0.5"

# Android 编译配置
[profile.release]
lto = true
codegen-units = 1
panic = "abort"
strip = true
```

### 1.3 vite.config.ts

**文件路径**: `vite.config.ts`

修改了服务器配置以支持 Android 设备访问：

```typescript
server: {
  port: 14422,
  strictPort: true,
  host: '0.0.0.0',  // 监听所有网络接口（允许 Android 设备连接）
  hmr: {
    protocol: 'ws',
    host: '0.0.0.0',  // HMR 也使用 0.0.0.0（Android 设备无法连接 localhost）
    port: 14422,
  },
  watch: {
    ignored: ['**/src-tauri/**'],
  },
  headers: {
    'Cache-Control': 'no-store',  // 防止 Android WebView 缓存旧代码
  },
},
```

## 二、项目结构调整

### 2.1 实际目录结构

> **重要**：Android 代码直接集成在现有项目结构中，未使用独立的 `mobile/` 目录。Android 专属代码通过 `#[cfg(target_os = "android")]` 条件编译区分。

```
aurora-gallery-tauri/
├── src/                          # 前端代码（桌面端 + Android 共用）
│   ├── api/
│   │   └── tauri-bridge.ts       # Tauri API 桥接（含 Android 缩略图逻辑）
│   ├── utils/
│   │   └── androidPlatform.ts    # Android 平台适配（权限、扫描、回调）
│   ├── hooks/
│   │   └── useAppInit.ts         # 应用初始化（含 Android 分支）
│   ├── components/
│   │   ├── ImageThumbnail.tsx    # 缩略图组件（含 mediaStoreId）
│   │   ├── FileGrid.tsx          # 文件网格（传递 mediaStoreId）
│   │   ├── FileListItem.tsx      # 文件列表项（传递 mediaStoreId）
│   │   └── SettingsModal.tsx     # 设置面板（Android 特殊处理）
│   ├── types.ts                  # 类型定义（含 contentUri, mediaStoreId）
│   └── App.tsx                   # 应用入口
│
└── src-tauri/                    # Rust 后端（桌面端 + Android 共用）
    └── src/
        ├── android/              # Android 专属 Rust 模块
        │   ├── mod.rs            # 模块导出
        │   ├── media_store.rs    # MediaStore JNI 扫描
        │   ├── thumbnail.rs      # 缩略图生成（系统缩略图 + 文件解码）
        │   └── memory_pool.rs    # 内存池
        ├── system_commands.rs    # 系统命令（含 Android JNI 路径获取）
        ├── window_commands.rs    # 窗口命令（Android DB 路径修复）
        └── lib.rs                # 主入口（含 Android 条件编译命令）
```

## 三、核心代码实现

### 3.1 Rust 后端

#### 3.1.1 lib.rs (新增)

创建了库入口文件，包含：
- 所有模块的公共导出
- Android 专属命令实现
- Android 运行时初始化函数

主要 Android 命令：
- `android_scan_images` - 扫描设备图片
- `android_scan_folders` - 扫描相册文件夹
- `android_get_thumbnail` - 获取缩略图

#### 3.1.2 android/media_store.rs

实现了与 Android MediaStore 的 JNI 交互：
- `scan_device_images()` - 通过 ContentProvider 查询图片
- `scan_device_folders()` - 获取相册文件夹列表
- 数据结构：`AndroidImageInfo`, `AndroidFolderInfo`

#### 3.1.3 android/thumbnail.rs

实现了缩略图生成功能：
- 支持多种图片格式
- 使用 LRU 缓存策略
- 可配置的质量和尺寸

#### 3.1.4 android/memory_pool.rs

实现了内存池管理：
- 根据设备内存自动调整池大小
- LRU 淘汰策略
- 内存压力监控

### 3.2 前端代码

#### 3.2.1 androidPlatform.ts（Android 平台适配）

实现了 Android 平台的核心适配逻辑：
- `isAndroidPlatform()` — 异步平台检测（带缓存）
- `initAndroidPermissionListener()` — 注册权限回调监听
- `waitForAndroidPermission()` — 等待权限结果（含时序修复）
- `ensureAndroidPermissionAndScan()` — 完整的权限获取+扫描流程
- `scanAndroidMedia()` / `scanAndroidImages()` — 调用 Rust 端扫描并转换为 FileNode

#### 3.2.2 tauri-bridge.ts（API 桥接）

实现了 Android 缩略图加载逻辑：
- `_isAndroid` 标记 + `setAndroidPlatform()` 设置
- `_globalCacheRoot` + `setGlobalCacheRoot()` 缓存路径管理
- Android 分支直接调用 `android_get_thumbnail`（替代桌面端的 `ThumbnailBatcher`）
- `getAssetUrl` 支持 `contentUri` 参数

#### 3.2.3 组件适配

**ImageThumbnail.tsx**:
- 新增 `mediaStoreId` 属性，传递给 `getThumbnail()`

**FileGrid.tsx / FileListItem.tsx**:
- 传递 `file.mediaStoreId` 到 `ImageThumbnail`

**SettingsModal.tsx**:
- Android 上隐藏 `resourceRoot` 设置
- 显示 `cacheRoot`（来自应用私有目录）

#### 3.2.4 初始化逻辑

**useAppInit.ts**:
- Android 强制使用 `defaults` 中的路径（`resourceRoot`, `cacheRoot`, `appDataDir`）
- `!savedData` 分支创建完整导航状态（tabs, currentFolderId, expandedFolderIds）
- 过滤 `android_media_store` 虚拟根目录

## 四、条件编译

### 4.1 main.rs 重构

将原有的 `main.rs` 拆分为：
- `lib.rs` - 共享代码库
- `main.rs` - 桌面端入口

桌面端保留：
- 系统托盘
- 单实例检测
- 拖拽支持
- 完整的命令集

Android 端使用：
- 精简的命令集
- 无系统托盘
- 无拖拽支持

### 4.2 条件编译示例

```rust
#[cfg(target_os = "android")]
mod android;

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_scan_images(app: tauri::AppHandle) -> Result<Vec<android::AndroidImageInfo>, String> {
    // Android 专属实现
}
```

## 五、开发环境配置

### 5.1 必需工具

```powershell
# 安装 Android 编译目标
rustup target add aarch64-linux-android

# 安装 cargo-ndk
cargo install cargo-ndk
```

### 5.2 环境变量

```powershell
$env:ANDROID_HOME = "$env:LOCALAPPDATA\Android\Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\29.0.13846066"
```

### 5.3 开发命令

```powershell
# 初始化 Android 项目
npx tauri android init

# 开发调试
npx tauri android dev

# 构建 APK
npx tauri android build
```

## 六、设备调试

### 6.1 无线 ADB 连接

```powershell
# 配对设备
adb pair 192.168.31.202:45049

# 连接设备
adb connect 192.168.31.202:41721

# 查看已连接设备
adb devices
```

### 6.2 日志查看

```powershell
adb logcat -s AuroraGallery
```

## 七、注意事项

1. **首次编译时间较长** - Rust 代码需要为 Android 编译，可能需要 10-20 分钟

2. **网络配置** - 确保 PC 和 Android 设备在同一网络，且防火墙允许 14422 端口

3. **权限管理** - Android 需要存储权限才能访问图片

4. **内存管理** - 使用内存池和虚拟滚动优化大图库性能

## 八、后续工作

- [ ] 完善手势操作（缩放、滑动切换）
- [ ] 缩略图批量请求（并发控制）
- [ ] 虚拟滚动优化（大量图片性能）
- [ ] 图片查看器触摸适配
- [ ] 移除调试日志（`console.error('[Thumbnail]...')`）
- [ ] 设置界面隐藏桌面端特有选项
- [ ] 实现局域网连接功能
- [ ] 实现上传下载功能

## 九、相关文件清单

### 新增文件

| 文件路径 | 说明 |
|---------|------|
| `src/utils/androidPlatform.ts` | Android 平台适配（权限、扫描、回调） |
| `src-tauri/src/android/mod.rs` | Android 模块入口 |
| `src-tauri/src/android/media_store.rs` | MediaStore JNI 扫描 |
| `src-tauri/src/android/thumbnail.rs` | 缩略图生成（系统缩略图 + 文件解码） |
| `src-tauri/src/android/memory_pool.rs` | 内存池 |
| `src-tauri/capabilities/default-android.json` | Android 专用能力配置 |
| `src-tauri/.cargo/config.toml` | Android NDK linker 配置 |

### 修改文件

| 文件路径 | 修改内容 |
|---------|---------|
| `src-tauri/tauri.conf.json` | 添加 Android 配置 |
| `src-tauri/Cargo.toml` | 添加库目标和 Android 依赖；reqwest 切换为 rustls-tls；桌面端依赖条件编译 |
| `vite.config.ts` | HMR host 改为 `0.0.0.0`；添加 `Cache-Control: no-store` |
| `src-tauri/src/lib.rs` | 从 main.rs 迁移应用逻辑；添加 `mobile_entry_point`；Android 条件编译命令 |
| `src-tauri/src/main.rs` | 简化为仅调用 `aurora_gallery_lib::run()` |
| `src-tauri/src/system_commands.rs` | 新增 `get_platform` 命令；Android JNI 路径获取 |
| `src-tauri/src/window_commands.rs` | Android DB 路径修复；条件编译 |
| `src-tauri/src/android/media_store.rs` | JNI 调用修复；添加 contentUri 和 mediaStoreId |
| `src-tauri/src/android/thumbnail.rs` | 完全重写：系统缩略图 + 文件解码；`#[serde(rename_all = "camelCase")]` |
| `src/api/tauri-bridge.ts` | Android 缩略图逻辑；`_isAndroid`；`_globalCacheRoot` |
| `src/utils/androidPlatform.ts` | 权限回调时序修复；`_lastPermissionResult` 缓存 |
| `src/hooks/useAppInit.ts` | Android 初始化分支；强制默认路径；完整导航状态 |
| `src/components/ImageThumbnail.tsx` | 新增 `mediaStoreId` 属性 |
| `src/components/FileGrid.tsx` | 传递 `mediaStoreId` |
| `src/components/FileListItem.tsx` | 传递 `mediaStoreId` |
| `src/components/SettingsModal.tsx` | Android 特殊处理 |
| `src/types.ts` | 新增 `contentUri`, `mediaStoreId` 字段 |
| `src/App.tsx` | 移除重复 Android 代码（统一到 androidPlatform.ts） |

---

## 第二阶段：编译问题修复与首次运行

**开发日期**：2026年4月15日

### 一、编译问题修复历程

从 `npx tauri android dev` 开始，依次遇到并修复了以下编译问题：

#### 1.1 OpenSSL 交叉编译错误

**问题**：`openssl-sys` 无法为 Android 目标找到 OpenSSL 库

**修复**：将 `reqwest` 的 TLS 后端从 `native-tls` 切换为 `rustls-tls`，避免对 OpenSSL 的依赖

```toml
# Cargo.toml
reqwest = { version = "0.12", features = ["json", "stream", "rustls-tls"], default-features = false }
```

#### 1.2 drag 插件编译错误

**问题**：`tauri-plugin-drag` 在 Android 上使用了平台特定代码，无法编译

**修复**：将桌面端专用依赖移至条件编译

```toml
[target.'cfg(not(target_os = "android"))'.dependencies]
tauri-plugin-drag = "2"
```

#### 1.3 clang 未找到（ring crate）

**问题**：`ring` crate（rustls 依赖）需要 C 编译器为 Android 编译

**修复**：创建 `.cargo/config.toml` 配置 Android NDK linker 和 ar 路径

```toml
# .cargo/config.toml
[target.aarch64-linux-android]
linker = "C:\\Users\\Misaki\\AppData\\Local\\Android\\Sdk\\ndk\\29.0.13846066\\toolchains\\llvm\\prebuilt\\windows-x86_64\\bin\\aarch64-linux-android24-clang.cmd"
ar = "C:\\Users\\Misaki\\AppData\\Local\\Android\\Sdk\\ndk\\29.0.13846066\\toolchains\\llvm\\prebuilt\\windows-x86_64\\bin\\llvm-ar.exe"
```

#### 1.4 多个桌面端专用依赖在 Android 上不可用

**问题**：`arboard`（剪贴板）、`ort`/`ndarray`/`tokenizers`（CLIP 模型）、`axum`/`tower`（局域网共享）等在 Android 上无法编译

**修复**：对所有桌面端专用模块添加条件编译 `#[cfg(not(target_os = "android"))]`

受影响的模块：
- `clip` / `clip_commands` - CLIP 语义搜索
- `lan_share` / `lan_share_commands` - 局域网共享
- `updater` / `update_downloader` / `update_commands` - 自动更新
- `work_extractor` - 作品提取
- `file_operations::copy_image_to_clipboard` - 剪贴板操作

#### 1.5 Windows 符号链接权限

**问题**：构建时需要创建符号链接但权限不足

**修复**：在 Windows 设置中启用开发者模式

#### 1.6 JAVA_HOME 指向错误版本

**问题**：JAVA_HOME 指向 JDK 25，而 Gradle 需要 JDK 17

**修复**：安装 Eclipse Adoptium JDK 17（jdk-17.0.18.8-hotspot），更新 JAVA_HOME 环境变量

#### 1.7 Gradle 下载超时

**问题**：Gradle 分发包下载超时

**修复**：修改 `gradle-wrapper.properties` 使用腾讯云镜像

```properties
distributionUrl=https\://mirrors.cloud.tencent.com/gradle/gradle-8.13-bin.zip
```

#### 1.8 Gradle 版本不匹配

**问题**：Android Gradle Plugin 要求 Gradle 8.13，但之前降级到了 8.5

**修复**：将 `gradle-wrapper.properties` 中的版本恢复为 8.13

#### 1.9 SDK 路径未找到

**问题**：Gradle 找不到 Android SDK

**修复**：创建 `local.properties` 文件

```properties
sdk.dir=C:\\Users\\Misaki\\AppData\\Local\\Android\\Sdk
```

#### 1.10 根本原因：缺少 mobile_entry_point

**问题**：`Library does not include required runtime symbols. This means you are likely missing the tauri::mobile_entry_point macro usage.`

这是最关键的问题。所有应用逻辑原本在 `main.rs` 中，但 Android 需要在 `lib.rs` 中使用 `#[cfg_attr(mobile, tauri::mobile_entry_point)]` 宏。

**修复**：将所有应用逻辑从 `main.rs` 移至 `lib.rs::run()` 函数，并添加 mobile 入口点属性

```rust
// lib.rs
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // ... 所有应用初始化逻辑
}

// main.rs
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    aurora_gallery_lib::run()
}
```

### 二、应用成功在平板上运行

修复上述所有问题后，应用成功在 Samsung Tab S8+ 上运行。

### 三、欢迎界面在 Android 上的处理

**问题**：Android 上仍然显示桌面版的欢迎界面（选择文件目录），但移动端没有目录选择的概念

**修复**：

1. 在 `system_commands.rs` 中添加 `get_platform` 命令，通过 Rust `cfg!` 宏可靠检测平台：

```rust
#[tauri::command]
pub fn get_platform() -> String {
    if cfg!(target_os = "android") { "android".to_string() }
    else if cfg!(target_os = "ios") { "ios".to_string() }
    else if cfg!(target_os = "macos") { "macos".to_string() }
    else if cfg!(target_os = "windows") { "windows".to_string() }
    else if cfg!(target_os = "linux") { "linux".to_string() }
    else { "unknown".to_string() }
}
```

2. 在 `App.tsx` 中添加异步平台检测函数：

```typescript
let _isAndroidCached: boolean | null = null;
async function isAndroidPlatform(): Promise<boolean> {
  if (_isAndroidCached !== null) return _isAndroidCached;
  try {
    const platform = await invoke<string>('get_platform');
    _isAndroidCached = platform === 'android';
  } catch {
    _isAndroidCached = typeof navigator !== 'undefined' && /android/i.test(navigator.userAgent || '');
  }
  return _isAndroidCached;
}
```

3. 在两处欢迎界面判断逻辑中使用该函数，Android 上跳过欢迎界面并自动标记 `aurora_onboarded`

### 四、Android 媒体访问权限

**问题**：应用在 Android 上没有任何文件/媒体访问权限，无法扫描设备图片

**修复涉及多个层面**：

#### 4.1 AndroidManifest.xml 声明权限

**文件路径**: `src-tauri/gen/android/app/src/main/AndroidManifest.xml`

```xml
<uses-permission android:name="android.permission.INTERNET" />
<uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
<uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
<uses-permission android:name="android.permission.READ_MEDIA_VISUAL_USER_SELECTED" />
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" android:maxSdkVersion="32" />
```

权限说明：
- `READ_MEDIA_IMAGES` / `READ_MEDIA_VIDEO` — Android 13+ (API 33) 细粒度媒体权限
- `READ_MEDIA_VISUAL_USER_SELECTED` — Android 14+ (API 34) 用户选择的照片和视频
- `READ_EXTERNAL_STORAGE` (maxSdkVersion=32) — Android 12 及以下的存储权限

#### 4.2 MainActivity.kt 运行时权限请求

**文件路径**: `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt`

- 使用 `ActivityResultContracts.RequestMultiplePermissions()` 在应用启动时自动请求媒体权限
- 根据 Android 版本自动选择需要的权限集合
- 提供 `checkMediaPermissions()` 方法供 Rust 端调用检查权限状态
- 通过 WebView JavaScript 回调 `window.__onAndroidPermissionResult()` 通知前端权限结果
- 使用栈结构遍历 View 树查找 WebView（避免 Kotlin inline 递归函数限制）

```kotlin
class MainActivity : TauriActivity() {
  private val permissionLauncher = registerForActivityResult(
    ActivityResultContracts.RequestMultiplePermissions()
  ) { permissions ->
    val allGranted = permissions.all { it.value }
    if (allGranted) {
      notifyPermissionResult("granted")
    } else {
      // 区分永久拒绝和临时拒绝
      val permanentlyDenied = permissions.any { (perm, granted) ->
        !granted && !shouldShowRequestPermissionRationale(perm)
      }
      if (permanentlyDenied) {
        notifyPermissionResult("denied_permanently")
      } else {
        notifyPermissionResult("denied")
      }
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    requestMediaPermissions()
  }

  fun checkMediaPermissions(): String {
    val perms = getRequiredPermissions()
    val allGranted = perms.all {
      ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
    }
    return if (allGranted) "granted" else "denied"
  }
}
```

#### 4.3 Rust 端权限检查命令

**文件路径**: `src-tauri/src/lib.rs`

新增两个 Tauri 命令：

```rust
#[cfg(target_os = "android")]
#[tauri::command]
async fn check_android_permissions() -> Result<String, String> {
    // 通过 JNI 调用 MainActivity.checkMediaPermissions()
    // 返回 "granted" 或 "denied"
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn request_android_permissions() -> Result<String, String> {
    // 通过 JNI 调用 MainActivity.requestMediaPermissions()
    // 返回 "requested"
}
```

#### 4.4 media_store.rs JNI 调用修复

**文件路径**: `src-tauri/src/android/media_store.rs`

修复了关键 Bug：原代码使用不存在的 `Activity.getCurrentActivity()` 静态方法获取 Activity，改为接收 Activity 参数直接使用：

```rust
// 修复前（错误）
pub fn scan_device_images(env: &mut JNIEnv) -> Result<Vec<AndroidImageInfo>, String> {
    let content_resolver = get_content_resolver(env)?; // 内部调用不存在的静态方法
}

// 修复后（正确）
pub fn scan_device_images<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) -> Result<Vec<AndroidImageInfo>, String> {
    let content_resolver = get_content_resolver(env, activity)?; // 直接使用 Activity 对象
}
```

同时修复了 `scan_device_folders` 中文件夹路径为空的问题，新增 `_data` 列查询并提取文件夹路径：

```rust
// 从 _data 字段提取文件夹路径
let folder_path = if !data_path.is_empty() {
    if let Some(last_slash) = data_path.rfind('/') {
        data_path[..last_slash].to_string()
    } else {
        data_path
    }
} else {
    String::new()
};
```

#### 4.5 前端 Android 媒体扫描逻辑

**文件路径**: `src/App.tsx`

新增 `scanAndroidMedia()` 函数，在 Android 首次运行且权限已授予时调用：

```typescript
async function scanAndroidMedia(): Promise<{ files: Record<string, any>; roots: string[] } | null> {
  // 1. 调用 android_scan_folders 获取文件夹列表
  // 2. 调用 android_scan_images 获取图片列表
  // 3. 将结果转换为应用的 FileNode 格式
  // 4. 使用文件夹 path 字段与图片父目录路径精确匹配
  // 5. 返回 { files, roots } 数据
}
```

Android 首次运行时的初始化流程：
1. 检测到 Android 平台
2. 设置 `aurora_onboarded` 跳过欢迎界面
3. 调用 `check_android_permissions` 检查权限状态
4. 如果权限已授予，调用 `scanAndroidMedia()` 扫描设备媒体
5. 将扫描结果设置到应用状态中

### 五、Kotlin 编译问题修复

#### 5.1 inline 递归函数错误

**问题**：`Inline function cannot be recursive` — Kotlin 不允许递归的 inline reified 泛型函数

**修复**：将递归的 `findViewTraversal` 改为使用栈结构的非递归 `findWebView` 函数

#### 5.2 类型不匹配

**问题**：`Type mismatch: inferred type is View! but ViewGroup was expected` — `getChildAt()` 返回 `View!`（平台类型）

**修复**：给 `mutableListOf` 显式指定泛型类型为 `<View>`

### 六、Rust 生命周期问题修复

**问题**：`lifetime may not live long enough` — `JNIEnv<'2>` 和 `JObject<'1>` 生命周期不一致

**修复**：给 `scan_device_images` 和 `scan_device_folders` 添加显式生命周期参数 `<'a>`，确保 `JNIEnv` 和 `JObject` 共享同一生命周期

```rust
pub fn scan_device_images<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) -> Result<Vec<AndroidImageInfo>, String>
pub fn scan_device_folders<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) -> Result<Vec<AndroidFolderInfo>, String>
```

### 七、当前状态与已知问题

**已实现**：
- [x] 应用可在 Samsung Tab S8+ 上成功运行
- [x] Android 平台检测（通过 Rust `get_platform` 命令）
- [x] 欢迎界面在 Android 上自动跳过
- [x] Android 媒体权限声明（AndroidManifest.xml）
- [x] 运行时权限请求（MainActivity.kt）
- [x] 权限弹窗正常显示并可授权
- [x] Rust 端权限检查命令
- [x] JNI 调用修复（Activity 对象传递）

**已知问题**：
- [x] ~~**权限授权后无图片扫描**：用户授权后，主界面为空，未显示任何图片或文件夹。~~ 已修复（见第三阶段）

### 八、本次修改文件清单

| 文件路径 | 修改内容 |
|---------|---------|
| `src-tauri/Cargo.toml` | reqwest 切换为 rustls-tls；桌面端依赖移至条件编译；添加 Android 依赖（jni, ndk, ndk-sys, ndk-context） |
| `src-tauri/.cargo/config.toml` | 新建：Android NDK linker 和 ar 路径配置 |
| `src-tauri/src/lib.rs` | 从 main.rs 迁移所有应用逻辑；添加 `mobile_entry_point`；Android 条件编译；新增 `check_android_permissions`、`request_android_permissions` 命令；修复 `android_scan_images`/`android_scan_folders` 传入 Activity 对象 |
| `src-tauri/src/main.rs` | 简化为仅调用 `aurora_gallery_lib::run()` |
| `src-tauri/src/system_commands.rs` | 新增 `get_platform` 命令 |
| `src-tauri/src/window_commands.rs` | 添加 `#[cfg(not(target_os = "android"))]` 条件编译 |
| `src-tauri/src/db_commands.rs` | CLIP 管理器代码添加条件编译 |
| `src-tauri/src/file_operations.rs` | `copy_image_to_clipboard` 添加条件编译 |
| `src-tauri/src/android/media_store.rs` | 修复 JNI 调用（移除不存在的 `getCurrentActivity`）；函数签名添加 Activity 参数和生命周期 `<'a>`；`scan_device_folders` 新增 `_data` 列查询提取文件夹路径 |
| `src-tauri/capabilities/default.json` | 添加 `"platforms": ["macOS", "windows", "linux"]` 限制桌面端能力 |
| `src-tauri/capabilities/default-android.json` | 新建：Android 专用能力配置（无拖拽权限） |
| `src-tauri/gen/android/app/src/main/AndroidManifest.xml` | 添加媒体访问权限声明 |
| `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt` | 实现运行时权限请求、权限检查、WebView 回调通知 |
| `src-tauri/gen/android/gradle/wrapper/gradle-wrapper.properties` | 使用腾讯云镜像；版本设为 8.13 |
| `src-tauri/gen/android/local.properties` | 新建：SDK 路径配置 |
| `src/App.tsx` | 新增 `isAndroidPlatform()` 异步平台检测；新增 `scanAndroidMedia()` 媒体扫描函数；两处欢迎界面判断改用异步检测；Android 首次运行时检查权限并扫描媒体 |

---

## 第三阶段：权限授权后无图片扫描问题修复

**开发日期**：2026年4月16日

### 一、问题分析

用户授权媒体权限后，主界面为空，未显示任何图片或文件夹。经过深入分析，发现以下多个根因：

#### 1.1 前端未注册 `__onAndroidPermissionResult` 回调

Kotlin 端在权限结果出来后通过 `evaluateJavascript` 调用 `window.__onAndroidPermissionResult(result)`，但前端从未定义此函数，导致权限授权事件丢失。

#### 1.2 时序竞争

`MainActivity.onCreate()` 在应用启动时立即调用 `requestMediaPermissions()`，但此时 WebView 可能还没加载完成。`notifyPermissionResult()` 通过 `evaluateJavascript` 发送回调时，前端代码可能还没注册接收者。

#### 1.3 首次运行时权限可能尚未授予

`check_android_permissions` 检查时，权限弹窗可能还在显示中。如果权限尚未授予，代码直接跳过扫描，没有等待机制。

#### 1.4 非首次运行没有 Android 扫描路径

只有 `!savedData`（首次运行）分支有 Android 扫描逻辑。如果首次运行时权限未授予导致扫描失败，后续启动时 `savedData` 已存在，会走桌面端的 `scanDirectory` 路径，在 Android 上无法工作。

#### 1.5 Android 14+ 部分权限问题

Android 14 (API 34) 引入了 `READ_MEDIA_VISUAL_USER_SELECTED` 权限。用户可能只授予"选择照片和视频"权限而非完整的 `READ_MEDIA_IMAGES`，但 `getRequiredPermissions()` 和 `checkMediaPermissions()` 没有处理这种情况。

#### 1.6 文件夹为空时图片数据被丢弃

`scanAndroidMedia()` 中 `return roots.length > 0 ? { files, roots } : null;` — 如果 `android_scan_folders` 返回空数组，即使 `android_scan_images` 有数据，也会返回 `null`。

### 二、修复方案

#### 2.1 前端注册权限回调 + 等待机制

**文件路径**: `src/App.tsx`

新增以下机制：

1. **`initAndroidPermissionListener()`**：在模块加载时立即注册 `window.__onAndroidPermissionResult` 回调
2. **`waitForAndroidPermission()`**：返回一个 Promise，等待 Kotlin 端发送权限结果（30秒超时）
3. **`ensureAndroidPermissionAndScan()`**：综合权限检查、等待回调、重试请求、轮询兜底的完整流程

```typescript
// 权限回调注册
function initAndroidPermissionListener() {
  (window as any).__onAndroidPermissionResult = (result: string) => {
    if (_androidPermissionResolve) {
      _androidPermissionResolve(result);
      _androidPermissionResolve = null;
    }
  };
}

// 完整的权限获取+扫描流程
async function ensureAndroidPermissionAndScan() {
  // 1. 先检查权限是否已授予
  let permStatus = await invoke<string>('check_android_permissions');
  if (permStatus === 'granted' || permStatus === 'granted_partial') {
    return await scanAndroidMedia();
  }

  // 2. 等待 Kotlin 端的权限回调（onCreate 中已请求权限）
  const permissionResult = await waitForAndroidPermission();
  if (permissionResult === 'granted' || permissionResult === 'granted_partial') {
    return await scanAndroidMedia();
  }

  // 3. 如果权限被拒绝或超时，尝试重新请求
  if (permissionResult === 'denied' || permissionResult === 'timeout') {
    await invoke<string>('request_android_permissions');
    const retryResult = await waitForAndroidPermission();
    if (retryResult === 'granted' || retryResult === 'granted_partial') {
      return await scanAndroidMedia();
    }
  }

  // 4. 兜底：轮询权限状态（最多10秒）
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 1000));
    permStatus = await invoke<string>('check_android_permissions');
    if (permStatus === 'granted' || permStatus === 'granted_partial') {
      return await scanAndroidMedia();
    }
  }

  return null;
}
```

#### 2.2 非首次运行也走 Android 扫描路径

**文件路径**: `src/App.tsx`

在 `savedData` 存在的分支中，添加 Android 平台检测。如果是 Android，使用 `ensureAndroidPermissionAndScan()` 而非桌面端的 `scanDirectory`：

```typescript
const isAndroid = await isAndroidPlatform();

if (isAndroid) {
  const result = await ensureAndroidPermissionAndScan();
  if (result) {
    // 使用 Android 扫描结果初始化应用状态
    setState(prev => ({
      ...prev,
      settings: finalSettings,
      files: result.files,
      roots: result.roots,
      // ... 其他初始化
    }));
    return;
  }
}
```

#### 2.3 Kotlin 端 WebView 回调重试机制

**文件路径**: `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt`

将 `notifyPermissionResult` 改为 `notifyPermissionResultWithRetry`，当 WebView 未找到时自动重试（最多20次，每次间隔500ms，总计最多10秒）：

```kotlin
private fun notifyPermissionResultWithRetry(result: String, retryCount: Int = 0) {
    try {
        val webView = findWebView(window.decorView)
        if (webView != null) {
            webView.post {
                webView.evaluateJavascript(
                    "if(window.__onAndroidPermissionResult) window.__onAndroidPermissionResult('$result')",
                    null
                )
            }
        } else if (retryCount < 20) {
            Handler(Looper.getMainLooper()).postDelayed({
                notifyPermissionResultWithRetry(result, retryCount + 1)
            }, 500)
        }
    } catch (_: Exception) {
        if (retryCount < 20) {
            Handler(Looper.getMainLooper()).postDelayed({
                notifyPermissionResultWithRetry(result, retryCount + 1)
            }, 500)
        }
    }
}
```

#### 2.4 Android 14+ 部分权限支持

**文件路径**: `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt`

1. `getRequiredPermissions()` 在 Android 14+ (UPSIDE_DOWN_CAKE) 上额外请求 `READ_MEDIA_VISUAL_USER_SELECTED`
2. `checkMediaPermissions()` 区分完整授权 (`granted`) 和部分授权 (`granted_partial`)，部分授权时仍可访问用户选择的照片

#### 2.5 无文件夹时的兜底处理

**文件路径**: `src/App.tsx`

当 `android_scan_folders` 返回空但 `android_scan_images` 有数据时，创建一个"所有图片"虚拟文件夹作为根节点：

```typescript
if (images.length > 0 && roots.length === 0) {
  const defaultFolderId = generateId('android_all_images');
  files[defaultFolderId] = {
    id: defaultFolderId,
    parentId: null,
    name: '所有图片',
    type: 'folder',
    path: '',
    children: [],
  };
  roots.push(defaultFolderId);
  // 将所有图片归入此文件夹
}
```

#### 2.6 Rust 端扫描日志

**文件路径**: `src-tauri/src/lib.rs`

为 `android_scan_images` 和 `android_scan_folders` 添加日志输出，便于调试：

```rust
log::info!("android_scan_images: starting JNI scan");
let result = scan_device_images(&mut env, &activity_obj);
match &result {
    Ok(images) => log::info!("android_scan_images: found {} images", images.len()),
    Err(e) => log::error!("android_scan_images: failed: {}", e),
}
```

### 三、本次修改文件清单

| 文件路径 | 修改内容 |
|---------|---------|
| `src/App.tsx` | 新增 `initAndroidPermissionListener`、`waitForAndroidPermission`、`ensureAndroidPermissionAndScan`；首次运行改用 `ensureAndroidPermissionAndScan`；非首次运行添加 Android 扫描路径；处理 `granted_partial` 权限状态；无文件夹时创建虚拟根文件夹 |
| `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt` | `notifyPermissionResult` 改为带重试的 `notifyPermissionResultWithRetry`；`getRequiredPermissions` 在 Android 14+ 请求 `READ_MEDIA_VISUAL_USER_SELECTED`；`checkMediaPermissions` 区分完整/部分授权 |
| `src-tauri/src/lib.rs` | `android_scan_images`/`android_scan_folders` 添加日志输出 |
| `src-tauri/src/system_commands.rs` | `get_default_paths()` 添加 Android 条件编译分支，返回正确的 Android 路径 |
| `src-tauri/src/android/media_store.rs` | `scan_device_images`/`scan_device_folders` 添加 `ensure_local_capacity(256)` 防止 JNI 局部引用溢出 |

---

## 第四阶段：Android 图片扫描功能调通

**开发日期**：2026年4月16日

### 一、问题分析

第三阶段的修复部署后，应用仍然无法显示图片。经过多轮调试，发现以下问题：

#### 1.1 前端构建产物未更新

`npx tauri android dev` 在 Android 上 fallback 到了 `dist` 目录中的旧构建产物（`index-B1QfQ5vS.js`），该产物不包含任何 Android 代码。日志中完全没有 `[Android]` 前缀的消息，且 Rust 端日志显示走的是桌面端的 `scanDirectory` 逻辑。

**修复**：手动执行 `npm run build` 重新构建前端，确保 `dist` 目录包含最新代码。

#### 1.2 `get_default_paths` 在 Android 上返回 Windows 路径

设置界面显示 `C:\Users\User/Pictures/AuroraGallery`，这是因为 `get_default_paths()` 没有处理 Android 平台，fallback 到了 Windows 默认路径。

**修复**：在 `system_commands.rs` 中添加 `#[cfg(target_os = "android")]` 条件编译分支，Android 上 `resourceRoot` 返回 `/storage/emulated/0/Pictures/AuroraGallery`，`cacheRoot` 返回应用数据目录下的 `.Aurora_Cache`。

#### 1.3 Android 上 fallback 到桌面端 `scanDirectory`

非首次运行时，即使 `ensureAndroidPermissionAndScan` 失败，代码仍尝试用 Windows 路径调用 `scanDirectory`，在 Android 上无法工作。

**修复**：在 Android 上完全跳过桌面端路径扫描逻辑（`pathsToScan = []`）。

#### 1.4 `ensureAndroidPermissionAndScan` 失败时应用卡在加载画面

当 `ensureAndroidPermissionAndScan()` 返回 `null` 时，`setIsLoading(false)` 和 `setShowSplash(false)` 不会被调用，应用一直卡在加载画面。

**修复**：在 Android 上先调用 `setIsLoading(false)` 和 `setShowSplash(false)` 显示 UI，然后再异步执行 `ensureAndroidPermissionAndScan()`。缩短超时时间（权限回调等待从 30 秒缩短到 10 秒，轮询从 10 次缩短到 5 次）。

#### 1.5 `FileNode` 缺少必需的 `tags` 属性导致崩溃

`scanAndroidMedia()` 创建的文件条目没有 `tags` 属性，但 `FileNode` 类型中 `tags: string[]` 是必需属性。当 React 组件尝试调用 `file.tags.forEach(...)` 时，`tags` 是 `undefined`，导致 `TypeError: Cannot read properties of undefined (reading 'forEach')` 崩溃。

**修复**：为所有文件条目（文件夹和图片）添加 `tags: []`。

#### 1.6 JNI 局部引用溢出风险

`scan_device_images` 和 `scan_device_folders` 在遍历大量行时可能超出 JNI 局部引用限制（默认 512 个）。

**修复**：在函数开头添加 `env.ensure_local_capacity(256)` 预分配局部引用容量。

### 二、调试过程

#### 2.1 日志捕获方法

Android 上 Tauri 应用的日志需要通过特定方式捕获：

```powershell
# 获取应用 PID
adb -s <device_id> shell pidof com.aurora.gallery

# 查看 Rust 端日志（通过 RustStdoutStderr 标签）
adb -s <device_id> logcat -d --pid=<PID> -s "RustStdoutStderr:*"

# 查看前端 console 日志（通过 Tauri/Console 标签，只记录 console.error）
adb -s <device_id> logcat -d --pid=<PID> -s "Tauri/Console:*"

# 同时查看两者
adb -s <device_id> logcat -d --pid=$(adb -s <device_id> shell pidof com.aurora.gallery) -s "Tauri/Console:*" "RustStdoutStderr:*"
```

**重要提示**：
- `Tauri/Console` 只记录 `console.error`，不记录 `console.log`
- `adb logcat -s AuroraGallery` 无法捕获 Rust 的 `log::info!` 输出（Rust 日志使用模块路径作为标签）
- 多设备连接时需要 `-s <device_id>` 指定设备

#### 2.2 关键日志输出

修复后成功扫描的日志：

```
[Android] get_platform returned: android
[Android] ensureAndroidPermissionAndScan: checking permissions...
[Android] check_android_permissions result: granted
[Android] scanAndroidMedia: invoking android_scan_folders...
[Android] scanAndroidMedia: got 109 folders
[Android] scanAndroidMedia: invoking android_scan_images...
[Android] scanAndroidMedia: got 21744 images
[Android] scanAndroidMedia: returning 21853 files, 109 roots
```

### 三、当前状态

**已实现**：
- [x] Android 平台检测（`get_platform` 命令）
- [x] Android 媒体权限声明和运行时请求
- [x] JNI 调用扫描设备图片和文件夹（109 文件夹，21744 图片）
- [x] 前端显示扫描结果（文件夹和图片列表）
- [x] 点击图片可查看
- [x] Android 上跳过桌面端欢迎界面
- [x] Android 上使用正确的默认路径
- [x] Android 14+ 部分权限支持

**已知问题**：
- [x] ~~缩略图未显示（图片列表中无缩略图预览）~~ 已修复（见第五阶段）
- [ ] 图片查看器需要适配触摸手势
- [ ] 设置界面仍显示桌面端特有选项（如 CLIP、LAN 共享等）
- [ ] 大量图片（2万+）时的性能和内存优化
- [ ] 外置 SD 卡图片的完整访问（取决于 Android 版本和权限）

### 四、本次修改文件清单

| 文件路径 | 修改内容 |
|---------|---------|
| `src/App.tsx` | 新增 `isAndroidPlatform`、`initAndroidPermissionListener`、`waitForAndroidPermission`、`ensureAndroidPermissionAndScan`、`scanAndroidMedia`；首次运行和非首次运行均添加 Android 扫描路径；所有文件条目添加 `tags: []`；Android 上先显示 UI 再异步扫描；所有关键日志使用 `console.error` 确保在 `Tauri/Console` 中可见 |
| `src-tauri/src/system_commands.rs` | `get_default_paths()` 添加 Android 条件编译分支 |
| `src-tauri/src/android/media_store.rs` | `scan_device_images`/`scan_device_folders` 添加 `ensure_local_capacity(256)` |
| `src-tauri/src/lib.rs` | `android_scan_images`/`android_scan_folders` 添加日志输出 |
| `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt` | `notifyPermissionResultWithRetry` WebView 回调重试；Android 14+ 部分权限支持；`checkMediaPermissions` 区分完整/部分授权 |

---

## 第五阶段：缩略图系统重构与修复

**开发日期**：2026年4月19日

### 一、问题分析

第四阶段完成后，图片列表可以正常显示，但缩略图位置显示的是开裂的占位符图标。经过深入分析，发现根本原因是 Android Scoped Storage 下的文件访问机制与桌面端完全不同：

#### 1.1 资源根目录配置错误

设置界面显示：
- 资源根目录：`/storage/emulated/0/Pictures/AuroraGallery`
- 缓存目录：`/storage/emulated/o/Pictures/AuroraGallery/.Aurora_Cache`

这些路径在 Android 10+ 的 Scoped Storage 下不可写，应用无法在这些位置创建缩略图缓存。

#### 1.2 桌面端缩略图逻辑不适用

桌面端使用 `ThumbnailBatcher` 批量生成缩略图，通过文件系统直接读取图片文件。但在 Android 上：
- 应用无法直接读取 `/storage/emulated/0/` 下的文件（Scoped Storage 限制）
- 需要使用 `ContentResolver.loadThumbnail()` API 获取系统缩略图
- 缩略图缓存必须存放在应用私有目录

#### 1.3 缩略图数据结构缺少关键字段

`AndroidImageInfo` 缺少 `content_uri` 和 `media_store_id`，导致前端无法传递必要的参数给缩略图生成命令。

### 二、修复方案

#### 2.1 后端路径管理重构

**文件路径**: `src-tauri/src/system_commands.rs`

通过 JNI 获取应用私有目录，替代硬编码的公共目录路径：

```rust
#[cfg(target_os = "android")]
fn get_android_path(method: &str) -> Result<String, String> {
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }?;
    let mut env = vm.attach_current_thread()?;
    let activity_obj = unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };
    // 调用 activity.getCacheDir() 或 getFilesDir()
    let dir_file = env.call_method(&activity_obj, method, "()Ljava/io/File;", &[])?.l()?;
    let path_str = env.call_method(&dir_file, "getAbsolutePath", "()Ljava/lang/String;", &[])?.l()?;
    let result: String = env.get_string(&path_str.into())?.into();
    Ok(result)
}
```

**路径映射**：
| 键 | 值 | 说明 |
|---|---|---|
| `resourceRoot` | `android_media_store` | 虚拟根目录，表示使用 MediaStore |
| `cacheRoot` | `{cacheDir}/thumbnails` | 如 `/data/user/0/com.aurora.gallery/cache/thumbnails` |
| `appDataDir` | `{filesDir}` | 如 `/data/user/0/com.aurora.gallery/files` |

#### 2.2 系统缩略图获取实现

**文件路径**: `src-tauri/src/android/thumbnail.rs`

完全重写缩略图生成逻辑，使用 Android 10+ 的 `ContentResolver.loadThumbnail()` API：

```rust
pub fn get_android_system_thumbnail<'a>(
    env: &mut jni::JNIEnv<'a>,
    activity: &jni::objects::JObject<'a>,
    image_id: i64,
    cache_dir: &Path,
) -> Result<Option<String>, String> {
    // 1. 检查缓存：{cacheDir}/sys_{imageId}.jpg
    // 2. 获取 ContentResolver
    // 3. 构建 content URI: content://media/external/images/media/{id}
    //    使用 ContentUris.withAppendedId()
    // 4. 创建 android.util.Size(256, 256)
    // 5. 调用 ContentResolver.loadThumbnail(uri, size, null) 获取 Bitmap
    // 6. 使用 Bitmap.compress(JPEG, 80, ByteArrayOutputStream) 获取字节数据
    // 7. 通过 get_byte_array_region 提取字节
    // 8. 写入缓存文件
}
```

**JNI 调用注意事项**（踩过的坑）：

1. **`get_int_array_elements` 不存在**：`jni` crate 0.21 不支持此方法，改用 `Bitmap.compress()` + `ByteArrayOutputStream` 方案提取 Bitmap 数据

2. **`jbyte` 是 `i8` 不是 `u8`**：
   ```rust
   let buf: Vec<i8> = vec![0i8; len];
   env.get_byte_array_region(&byte_array, 0, &mut buf)?;
   let jpeg_data: Vec<u8> = buf.iter().map(|&b| b as u8).collect();
   ```

3. **`JObject` 不实现 `AsJArrayRaw`**：需要将 `JObject` 转换为 `JByteArray`
   ```rust
   let byte_array: JByteArray = byte_array.into();
   let len = env.get_array_length(&byte_array)?;
   ```

4. **`JpegEncoder::new_with_quality` 需要 `&mut writer`**：注意传引用而非移动

#### 2.3 序列化字段名修复（关键 Bug）

**文件路径**: `src-tauri/src/android/thumbnail.rs`

**问题**：Rust 的 `ThumbnailResult` 结构体序列化时字段名为 `thumbnail_path`（snake_case），但前端检查的是 `thumbnailPath`（camelCase），导致 `result?.thumbnailPath` 永远为 `undefined`。

**修复**：添加 `#[serde(rename_all = "camelCase")]`

```rust
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]  // 关键！
pub struct ThumbnailResult {
    pub path: String,
    pub thumbnail_path: Option<String>,  // 序列化为 thumbnailPath
    pub width: u32,
    pub height: u32,
}
```

**这是缩略图不显示的直接原因**——后端成功生成了缩略图并返回了路径，但前端因为字段名不匹配而忽略了结果。

#### 2.4 前端缩略图加载路径

**文件路径**: `src/api/tauri-bridge.ts`

Android 上直接调用 `android_get_thumbnail`，替代桌面端的 `ThumbnailBatcher`：

```typescript
let _isAndroid: boolean = false;
let _globalCacheRoot: string | null = null;

export function setAndroidPlatform(isAndroid: boolean) { _isAndroid = isAndroid; }
export function setGlobalCacheRoot(cacheRoot: string) { _globalCacheRoot = cacheRoot; }

// getThumbnail 中的 Android 分支
if (_isAndroid) {
    const result = await invoke<{ path: string; thumbnailPath: string | null; width: number; height: number } | null>(
        'android_get_thumbnail',
        { filePath, cacheRoot: cachePath, imageId: mediaStoreId ?? null }
    );
    if (result?.thumbnailPath) {
        return convertFileSrc(result.thumbnailPath);
    }
    return null;
}
```

#### 2.5 MediaStore 数据结构增强

**文件路径**: `src-tauri/src/android/media_store.rs`

为 `AndroidImageInfo` 添加 `content_uri` 字段：

```rust
pub struct AndroidImageInfo {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub folder_id: i64,
    pub date_added: i64,
    pub size: i64,
    pub mime_type: String,
    pub width: i32,
    pub height: i32,
    pub content_uri: String,  // 新增：content://media/external/images/media/{id}
}
```

#### 2.6 前端组件适配

**文件路径**: `src/components/ImageThumbnail.tsx`, `FileGrid.tsx`, `FileListItem.tsx`

新增 `mediaStoreId` 属性传递链：

```typescript
// ImageThumbnail.tsx
interface ImageThumbnailProps {
    // ...
    mediaStoreId?: number;  // 新增
}

// FileGrid.tsx / FileListItem.tsx
<ImageThumbnail
    // ...
    mediaStoreId={file.mediaStoreId}
/>
```

#### 2.7 初始化逻辑修复

**文件路径**: `src/hooks/useAppInit.ts`

多个关键修复：

1. **Android 强制使用默认路径**：`savedData.settings.paths` 会覆盖新的 `cacheRoot`，Android 上强制使用 `defaults`
   ```typescript
   ...(isAndroidNow ? {
       resourceRoot: defaults.resourceRoot,
       cacheRoot: defaults.cacheRoot,
       appDataDir: defaults.appDataDir,
   } : {})
   ```

2. **新安装完整导航状态**：`!savedData` 分支补充了 `tabs`、`currentFolderId`、`expandedFolderIds`

3. **过滤虚拟根目录**：`pathsToScan` 中过滤掉 `"android_media_store"`

4. **提前设置平台标记**：在合并设置前调用 `setAndroidPlatform()` 和 `setGlobalCacheRoot()`

### 三、其他修复的 Bug

#### 3.1 颜色数据库崩溃

**文件路径**: `src-tauri/src/window_commands.rs`

**问题**：`get_initial_db_paths` 尝试在 SD 卡路径（`/storage/4A21-0000/...`）上创建颜色数据库，导致 `unable to open database file` 崩溃。

**修复**：Android 上强制使用应用私有目录（`appDataDir`）存放数据库。

#### 3.2 权限回调时序修复

**文件路径**: `src/utils/androidPlatform.ts`

**问题**：Kotlin 在 JS Promise 创建之前就调用了 `window.__onAndroidPermissionResult`，导致 `waitForAndroidPermission` 永远超时。

**修复**：添加 `_lastPermissionResult` 缓存，`waitForAndroidPermission` 先检查缓存再创建 Promise。

```typescript
let _lastPermissionResult: string | null = null;

window.__onAndroidPermissionResult = (result: string) => {
    _lastPermissionResult = result;  // 先缓存
    if (_androidPermissionResolve) {
        _androidPermissionResolve(result);  // 也尝试 resolve 现有 Promise
        _androidPermissionResolve = null;
    }
};

export function waitForAndroidPermission(): Promise<string> {
    if (_lastPermissionResult) {
        const result = _lastPermissionResult;
        _lastPermissionResult = null;
        return Promise.resolve(result);  // 直接返回缓存结果
    }
    // ... 创建 Promise 等待
}
```

#### 3.3 App.tsx 重复 Android 代码

**问题**：`App.tsx` 中有约 180 行 Android 代码与 `androidPlatform.ts` 中的代码重复，两个 `initAndroidPermissionListener` 互相覆盖 `window.__onAndroidPermissionResult`。

**修复**：删除 `App.tsx` 中的重复代码，统一使用 `androidPlatform.ts` 的导出。

#### 3.4 Vite HMR 无法连接

**文件路径**: `vite.config.ts`

**问题**：`hmr.host` 为 `'localhost'`，Android 设备无法访问电脑的 localhost。

**修复**：改为 `'0.0.0.0'`，同时添加 `Cache-Control: no-store` 防止 WebView 缓存旧代码。

#### 3.5 `dist` 目录缺失导致编译错误

**问题**：清理缓存时误删 `dist` 目录，`tauri::generate_context!()` 宏需要 `frontendDist` 路径存在。

**修复**：运行 `npm run build` 重建 `dist` 目录。**开发流程中应始终先 build 再 `npx tauri android dev`**。

### 四、调试过程

#### 4.1 代码更新不部署问题

这是最耗时的调试过程。修改了前端代码后，设备上始终运行旧代码。根因是：

1. **Vite HMR host 为 localhost**：Android 设备无法连接
2. **WebView 缓存**：即使连接成功，也会缓存旧的 JS 文件
3. **dist 目录嵌入 APK**：HMR 失败时回退到 APK 中嵌入的旧 `dist` 内容

修复后，开发流程变为：
```bash
npm run build          # 确保 dist 最新
npx tauri android dev  # 启动开发模式
```

#### 4.2 Chrome DevTools 远程调试

通过 Chrome `chrome://inspect` 连接设备 WebView，可以查看：
- `[Thumbnail] Android invoke` — 缩略图请求发出
- `[Thumbnail] Android result` — 缩略图结果返回（含 `thumbnailPath` 值）
- `[Thumbnail] Android convertFileSrc` — 路径转换
- `[Android] Image-folder matching` — 图片-文件夹匹配统计

#### 4.3 关键日志发现

最终发现缩略图不显示的直接证据：
```
[Thumbnail] Android result: {path: '...', thumbnail_path: '/data/user/0/com.aurora.gallery/cache/thumbnails/sys_1000039178.jpg', width: 0, height: 0}
```

后端返回的是 `thumbnail_path`（snake_case），但前端检查的是 `thumbnailPath`（camelCase），导致 `result?.thumbnailPath` 为 `undefined`。

### 五、当前状态

**已实现**：
- [x] Android 缩略图正确显示
- [x] 系统缩略图获取（`ContentResolver.loadThumbnail()`）
- [x] 文件解码缩略图（回退方案）
- [x] 缩略图缓存（`sys_{id}.jpg` + MD5 缓存键）
- [x] Android 路径管理（JNI 获取应用私有目录）
- [x] 序列化字段名修复（`#[serde(rename_all = "camelCase")]`）
- [x] 权限回调时序修复
- [x] Vite HMR Android 设备连接
- [x] 颜色数据库路径修复

**已知问题**：
- [ ] 图片查看器需要适配触摸手势
- [ ] 设置界面仍显示桌面端特有选项
- [ ] 大量图片（2万+）时的性能和内存优化
- [ ] 缩略图逐个请求，需要并发控制
- [ ] 外置 SD 卡图片的完整访问

### 六、本次修改文件清单

| 文件路径 | 修改内容 |
|---------|---------|
| `src-tauri/src/system_commands.rs` | 新增 `get_android_path()` JNI 函数；Android 分支使用 `getCacheDir()`/`getFilesDir()`；`resourceRoot = "android_media_store"`；`cacheRoot = "{cacheDir}/thumbnails"` |
| `src-tauri/src/android/thumbnail.rs` | 完全重写：`get_android_system_thumbnail()` 使用 `ContentResolver.loadThumbnail()` + `Bitmap.compress()`；`ThumbnailResult` 添加 `#[serde(rename_all = "camelCase")]` |
| `src-tauri/src/android/media_store.rs` | `AndroidImageInfo` 新增 `content_uri` 字段 |
| `src-tauri/src/lib.rs` | `android_get_thumbnail` 命令新增 `image_id` 参数；添加调试日志 |
| `src-tauri/src/window_commands.rs` | `get_initial_db_paths` Android 强制使用 app 私有目录 |
| `src/api/tauri-bridge.ts` | 新增 `_isAndroid`、`_globalCacheRoot`、`setAndroidPlatform()`、`setGlobalCacheRoot()`；Android 分支直接调用 `android_get_thumbnail`；`getAssetUrl` 支持 `contentUri` |
| `src/utils/androidPlatform.ts` | 新增 `_lastPermissionResult` 缓存修复权限回调时序；`scanAndroidMedia` 含图片-文件夹匹配和 `mediaStoreId` |
| `src/hooks/useAppInit.ts` | Android 强制使用默认路径；新安装完整导航状态；过滤 `android_media_store`；提前设置平台标记 |
| `src/components/ImageThumbnail.tsx` | 新增 `mediaStoreId` 属性 |
| `src/components/FileGrid.tsx` | 传递 `mediaStoreId` |
| `src/components/FileListItem.tsx` | 传递 `mediaStoreId` |
| `src/components/SettingsModal.tsx` | Android 隐藏 `resourceRoot`，显示 `cacheRoot` |
| `src/types.ts` | `FileNode` 新增 `contentUri`、`mediaStoreId` 字段 |
| `src/App.tsx` | 移除约 180 行重复 Android 代码，统一使用 `androidPlatform.ts` |
| `vite.config.ts` | `hmr.host` 改为 `'0.0.0.0'`；添加 `Cache-Control: no-store` |
