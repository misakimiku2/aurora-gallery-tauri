# Aurora Gallery Android - 第一阶段详细开发文档

## 概述

**阶段名称**：基础架构搭建  
**核心目标**：搭建可运行的 Android 应用骨架，实现本地图片列表显示和缩略图功能  
**当前状态**：✅ 已完成

### 实际目录结构

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
│   └── App.tsx                   # 应用入口（Android 代码在 androidPlatform.ts）
│
├── src-tauri/                    # Rust 后端（桌面端 + Android 共用）
│   └── src/
│       ├── android/              # Android 专属 Rust 模块
│       │   ├── mod.rs            # 模块导出
│       │   ├── media_store.rs    # MediaStore JNI 扫描
│       │   ├── thumbnail.rs      # 缩略图生成（系统缩略图 + 文件解码）
│       │   └── memory_pool.rs    # 内存池（已有）
│       ├── system_commands.rs    # 系统命令（含 Android JNI 路径获取）
│       ├── window_commands.rs    # 窗口命令（Android DB 路径修复）
│       └── lib.rs                # 主入口（含 Android 条件编译命令）
│
├── vite.config.ts                # Vite 配置（HMR host: 0.0.0.0, Cache-Control）
└── dist/                         # 前端构建产物（Android APK 嵌入）
```

---

## 一、已实现功能清单

### 1.1 后端（Rust）

| 功能 | 文件 | 状态 | 说明 |
|-----|------|:----:|------|
| Android 路径获取 | `system_commands.rs` | ✅ | JNI 调用 `getCacheDir()`/`getFilesDir()` |
| MediaStore 文件夹扫描 | `android/media_store.rs` | ✅ | JNI 查询 `MediaStore.Images.Media` |
| MediaStore 图片扫描 | `android/media_store.rs` | ✅ | 含 contentUri 和 mediaStoreId |
| 系统缩略图获取 | `android/thumbnail.rs` | ✅ | `ContentResolver.loadThumbnail()` via JNI |
| 文件解码缩略图 | `android/thumbnail.rs` | ✅ | 回退方案：image crate 解码 |
| 缩略图缓存 | `android/thumbnail.rs` | ✅ | 系统缩略图 `sys_{id}.jpg`，文件解码 MD5 缓存 |
| Android 权限检查 | `lib.rs` | ✅ | `check_android_permissions` 命令 |
| Android 权限请求 | `lib.rs` | ✅ | `request_android_permission` 命令 |
| DB 路径修复 | `window_commands.rs` | ✅ | Android 强制使用 app 私有目录 |

### 1.2 前端（TypeScript/React）

| 功能 | 文件 | 状态 | 说明 |
|-----|------|:----:|------|
| Android 平台检测 | `androidPlatform.ts` | ✅ | `isAndroidPlatform()` |
| 权限回调时序修复 | `androidPlatform.ts` | ✅ | `_lastPermissionResult` 缓存 |
| MediaStore 扫描 | `androidPlatform.ts` | ✅ | `scanAndroidMedia()` 含图片-文件夹匹配 |
| Android 缩略图加载 | `tauri-bridge.ts` | ✅ | 直接调用 `android_get_thumbnail` |
| 缓存路径管理 | `tauri-bridge.ts` | ✅ | `_globalCacheRoot` + `setGlobalCacheRoot()` |
| Android 平台标记 | `tauri-bridge.ts` | ✅ | `_isAndroid` + `setAndroidPlatform()` |
| 缩略图组件适配 | `ImageThumbnail.tsx` | ✅ | `mediaStoreId` 属性传递 |
| 文件网格适配 | `FileGrid.tsx` | ✅ | 传递 `mediaStoreId` |
| 文件列表适配 | `FileListItem.tsx` | ✅ | 传递 `mediaStoreId` |
| 设置面板适配 | `SettingsModal.tsx` | ✅ | Android 隐藏 resourceRoot，显示 cacheRoot |
| 初始化逻辑 | `useAppInit.ts` | ✅ | Android 强制使用默认路径，完整导航状态 |
| Vite HMR 配置 | `vite.config.ts` | ✅ | `host: '0.0.0.0'`，`Cache-Control: no-store` |

---

## 二、关键技术实现

### 2.1 Android 路径管理

**问题**：Android Scoped Storage 不允许应用写入公共目录（如 `/storage/emulated/0/Pictures/`）

**解决方案**：通过 JNI 获取应用私有目录

```rust
// system_commands.rs - Android 分支
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

### 2.2 系统缩略图获取

**问题**：Android Scoped Storage 下无法直接读取图片文件进行解码

**解决方案**：使用 Android 10+ 的 `ContentResolver.loadThumbnail()` API

```rust
// thumbnail.rs - get_android_system_thumbnail()
// 1. 获取 ContentResolver
// 2. 构建 content URI: content://media/external/images/media/{id}
// 3. 创建 Size(256, 256)
// 4. 调用 loadThumbnail(uri, size, null) 获取 Bitmap
// 5. 使用 Bitmap.compress(JPEG, 80, ByteArrayOutputStream) 获取字节数据
// 6. 通过 get_byte_array_region 提取字节
// 7. 写入缓存文件: {cacheDir}/sys_{imageId}.jpg
```

**关键注意事项**：
- `jni` crate 0.21 不支持 `get_int_array_elements`，需使用 `Bitmap.compress()` + `ByteArrayOutputStream` 方案
- `jbyte` 是 `i8` 不是 `u8`，需要转换
- `JObject` 需要转换为 `JByteArray` 才能调用 `get_array_length`

### 2.3 缩略图序列化修复

**问题**：Rust `ThumbnailResult` 的 `thumbnail_path` 字段序列化为 snake_case，但前端期望 camelCase

**解决方案**：添加 `#[serde(rename_all = "camelCase")]`

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

### 2.4 权限回调时序修复

**问题**：Kotlin 在 JS Promise 创建之前就调用了 `__onAndroidPermissionResult`

**解决方案**：添加结果缓存

```typescript
let _lastPermissionResult: string | null = null;

// Kotlin 回调时先缓存
window.__onAndroidPermissionResult = (result: string) => {
    _lastPermissionResult = result;
    // ... 也尝试 resolve 现有的 Promise
};

// 等待时先检查缓存
export function waitForAndroidPermission(): Promise<string> {
    if (_lastPermissionResult) {
        const result = _lastPermissionResult;
        _lastPermissionResult = null;
        return Promise.resolve(result);
    }
    // ... 创建 Promise 等待
}
```

### 2.5 Vite 开发服务器配置

**问题**：Android 设备无法连接 `localhost` 的 Vite HMR

**解决方案**：

```typescript
// vite.config.ts
server: {
    host: '0.0.0.0',  // 允许外部设备连接
    hmr: {
        protocol: 'ws',
        host: '0.0.0.0',  // HMR 也使用 0.0.0.0
        port: 14422,
    },
    headers: {
        'Cache-Control': 'no-store',  // 防止 WebView 缓存旧代码
    },
}
```

---

## 三、已修复的关键 Bug

| Bug | 根因 | 修复方案 |
|-----|------|---------|
| 缩略图不显示（占位符） | `thumbnail_path` vs `thumbnailPath` 大小写不匹配 | `#[serde(rename_all = "camelCase")]` |
| 颜色数据库崩溃 | SD 卡路径不可写 | Android 强制使用 app 私有目录 |
| 权限回调超时 | Kotlin 回调早于 Promise 创建 | `_lastPermissionResult` 缓存 |
| App.tsx 重复 Android 代码 | 两个 `initAndroidPermissionListener` 冲突 | 删除 App.tsx 中的重复代码 |
| `android_media_store` 被当作文件路径 | `pathsToScan` 包含虚拟根目录 | 过滤掉 `android_media_store` |
| savedData 覆盖 Android 默认值 | 旧设置覆盖新的 cacheRoot | Android 强制使用 defaults |
| 新安装无导航状态 | `!savedData` 分支缺少 tabs/currentFolderId | 补全完整导航状态 |
| 代码更新不部署 | Vite HMR host 为 localhost | 改为 `0.0.0.0` |
| `dist` 目录缺失编译错误 | `tauri::generate_context!()` 需要 dist | 运行 `npm run build` |

---

## 四、Android Tauri 命令列表

| 命令 | 参数 | 返回值 | 说明 |
|-----|------|-------|------|
| `android_scan_folders` | 无 | `Vec<AndroidFolderInfo>` | 扫描设备文件夹 |
| `android_scan_images` | 无 | `Vec<AndroidImageInfo>` | 扫描设备图片 |
| `android_get_thumbnail` | `filePath, cacheRoot, imageId` | `ThumbnailResult` | 获取缩略图 |
| `check_android_permissions` | 无 | `String` | 检查权限状态 |
| `request_android_permission` | 无 | `String` | 请求权限 |
| `get_default_paths` | 无 | `HashMap<String, String>` | 获取默认路径（Android 分支） |

---

## 五、开发调试指南

### 5.1 构建与运行

```bash
# 开发模式（需要先 npm run build 确保 dist 存在）
npm run build
npx tauri android dev

# 构建 APK
npx tauri android build
```

### 5.2 调试方法

1. **Chrome DevTools 远程调试**：
   - 在电脑 Chrome 打开 `chrome://inspect`
   - 找到设备上的 WebView，点击 inspect
   - 可查看 Console 日志（含 `[Thumbnail]`、`[Android]`、`[AppInit]` 前缀）

2. **后端日志**：
   ```bash
   adb logcat -s AuroraGallery
   # 或查看 tauri-plugin-log 输出
   ```

3. **关键日志标记**：
   - `[Thumbnail] Android invoke` — 缩略图请求发出
   - `[Thumbnail] Android result` — 缩略图结果返回
   - `[Thumbnail] Android convertFileSrc` — 路径转换
   - `[Android] Image-folder matching` — 图片-文件夹匹配
   - `[AppInit] Android branch` — Android 初始化分支

### 5.3 常见问题排查

| 现象 | 可能原因 | 排查方法 |
|-----|---------|---------|
| 白屏 | dist 目录为空或旧代码 | 运行 `npm run build` |
| 缩略图占位符 | thumbnailPath 为 null | 检查 Chrome Console 的 `[Thumbnail]` 日志 |
| 文件夹为空 | MediaStore 扫描失败 | 检查权限是否已授予 |
| 代码更新不生效 | WebView 缓存 | 清除应用数据，检查 Vite HMR 连接 |
| 编译错误 dist 缺失 | `tauri::generate_context!()` 需要 dist | 运行 `npm run build` |

---

## 六、待优化项

| 项目 | 优先级 | 说明 |
|-----|:------:|------|
| 移除调试日志 | 中 | `console.error('[Thumbnail]...')` 改为 `console.log` 或移除 |
| 缩略图批量请求 | 高 | 当前逐个请求，应实现并发控制 |
| 虚拟滚动 | 高 | 大量图片时性能优化 |
| 手势支持 | 中 | 缩放、滑动、双击 |
| 图片查看器触摸适配 | 中 | 触摸手势替代鼠标操作 |
| 离线模式 | 低 | 无 Vite 服务器时使用嵌入的 dist |

---

**文档版本**: 2.0  
**创建日期**: 2026-03-15  
**更新日期**: 2026-04-19  
**维护者**: Aurora Gallery Team
