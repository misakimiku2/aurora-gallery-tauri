# Aurora Gallery Android - 第一阶段详细开发文档

## 概述

**阶段名称**：基础架构搭建  
**预计工期**：2-3 周  
**核心目标**：搭建可运行的 Android 应用骨架，实现本地图片列表显示和基础图片查看功能

### 目录结构约定

> **重要**：所有 Android/移动端相关的代码统一存放在项目根目录的 `mobile/` 文件夹中，与桌面端代码分离，便于维护和管理。

```
aurora-gallery-tauri/
├── src/                    # 桌面端前端代码
├── src-tauri/              # 桌面端 Rust 后端
├── mobile/                 # 移动端代码（Android/iOS）[本阶段重点]
│   ├── src/                # 移动端前端代码
│   │   ├── api/            # API 适配器
│   │   ├── components/     # 移动端组件
│   │   ├── hooks/          # 移动端 Hooks
│   │   ├── utils/          # 工具函数
│   │   ├── styles/         # 样式文件
│   │   └── types.ts        # 类型定义
│   └── src-tauri/          # 移动端 Rust 后端（Android 模块）
│       └── src/
│           └── android/    # Android 专属 Rust 模块
└── ...
```

---

## 一、环境准备

### 1.1 开发环境要求

| 工具 | 版本要求 | 说明 |
|-----|---------|------|
| Android Studio | Hedgehog (2023.1.1) 或更高 | Android 开发 IDE |
| Android SDK | API 34 (Android 14) | 目标 SDK |
| Android NDK | r25c 或更高 | Rust 编译所需 |
| JDK | 17 或更高 | Java 开发环境 |
| Rust | 1.70 或更高 | 后端开发语言 |
| Node.js | 18 或更高 | 前端构建 |

### 1.2 环境配置步骤

#### 1.2.1 安装 Rust Android 目标

```bash
# 添加 Android 编译目标
rustup target add aarch64-linux-android
rustup target add armv7-linux-androideabi
rustup target add i686-linux-android
rustup target add x86_64-linux-android

# 安装 cargo-ndk（简化 NDK 编译）
cargo install cargo-ndk
```

#### 1.2.2 配置环境变量

```bash
# Windows PowerShell
$env:ANDROID_HOME = "C:\Users\{用户名}\AppData\Local\Android\Sdk"
$env:NDK_HOME = "$env:ANDROID_HOME\ndk\25.2.9519653"

# 添加到系统环境变量
[Environment]::SetEnvironmentVariable("ANDROID_HOME", $env:ANDROID_HOME, "User")
[Environment]::SetEnvironmentVariable("NDK_HOME", $env:NDK_HOME, "User")
```

#### 1.2.3 验证环境

```bash
# 验证 Rust 目标
rustup target list --installed | findstr android

# 验证 NDK
cargo ndk --version
```

---

## 二、项目初始化

### 2.1 Tauri Android 配置

#### 2.1.1 修改 `src-tauri/tauri.conf.json`

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Aurora Gallery",
  "version": "1.1.3",
  "identifier": "com.aurora.gallery",
  "build": {
    "beforeDevCommand": "",
    "devUrl": "http://localhost:14422",
    "beforeBuildCommand": "npm run build",
    "frontendDist": "../dist"
  },
  "app": {
    "windows": [
      {
        "title": "Aurora Gallery",
        "url": "index.html",
        "width": 1280,
        "height": 800,
        "minWidth": 1280,
        "minHeight": 800,
        "center": true,
        "resizable": true,
        "fullscreen": false,
        "label": "main",
        "decorations": false,
        "dragDropEnabled": false,
        "visible": false
      }
    ],
    "security": {
      "csp": "default-src 'self' 'unsafe-inline' 'unsafe-eval' data: blob: https: http://localhost:* http://127.0.0.1:* http://ipc.localhost:* http://asset.localhost:* ws://localhost:* wss://localhost:* thumbnail:; connect-src 'self' http://localhost:* http://127.0.0.1:* http://ipc.localhost:* http://asset.localhost:* ws://localhost:* wss://localhost:* https://open.bigmodel.cn https://generativelanguage.googleapis.com; img-src 'self' data: blob: https: local-resource: thumbnail: http://asset.localhost:*; media-src 'self' data: blob: https: local-resource: http://asset.localhost:*;",
      "dangerousDisableAssetCspModification": false,
      "assetProtocol": {
        "enable": true,
        "scope": ["**"]
      }
    }
  },
  "bundle": {
    "active": true,
    "targets": "all",
    "icon": [
      "icons/32x32.png",
      "icons/128x128.png",
      "icons/128x128@2x.png",
      "icons/icon.icns",
      "icons/icon.ico"
    ],
    "windows": {
      "nsis": {
        "installMode": "currentUser",
        "installerIcon": "icons/icon.ico",
        "languages": ["SimpChinese", "English"],
        "displayLanguageSelector": true
      }
    },
    "android": {
      "minSdkVersion": 24,
      "targetSdkVersion": 34,
      "buildNumber": 1
    }
  },
  "plugins": {
    "android": {
      "features": ["storage", "network"]
    }
  }
}
```

#### 2.1.2 修改 `src-tauri/Cargo.toml`

```toml
[package]
name = "aurora-gallery"
version = "1.1.3"
description = "A modern image gallery and management application"
authors = ["MISAKIMIKU"]
license = "MIT"
repository = "https://github.com/misakimiku2/aurora-gallery-tauri"
edition = "2021"
default-run = "aurora-gallery"

[build-dependencies]
tauri-build = { version = "2.0", features = [] }

[dependencies]
tauri = { version = "2.0", features = ["protocol-asset", "custom-protocol", "tray-icon"] }
tauri-plugin-single-instance = "2"
tauri-plugin-dialog = "2"
tauri-plugin-fs = "2"
tauri-plugin-shell = "2"
tauri-plugin-log = "2"
log = "0.4"
tauri-plugin-drag = "2"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
jwalk = "0.8"
imageinfo = "0.7"
image = { version = "0.24", features = ["jpeg", "png", "gif", "webp"] }
jxl-oxide = { version = "0.9.0", features = ["rayon"] }
webp = "0.2"
fast_image_resize = "3.0"
ab_glyph = "0.2"
ab_glyph_rasterizer = "0.1"
rayon = "1.8"
base64 = "0.21"
md5 = "0.7"
chrono = { version = "0.4", features = ["serde"] }
palette = { version = "0.7", features = ["std"] }
tokio = { version = "1", features = ["full"] }
urlencoding = "2.1"
color-thief = "0.2.2"
rusqlite = { version = "0.30", features = ["bundled", "serde_json"] }
futures = "0.3"
arboard = "3"
num_cpus = "1.16"
crossbeam-channel = "0.5"
jpeg-decoder = "0.2"
reqwest = { version = "0.12", features = ["json", "stream"] }
once_cell = "1.19"
futures-util = "0.3"
bytes = "1"
sha2 = "0.10"

# CLIP Model Support
ort = { version = "2.0.0-rc.9", features = ["directml", "ndarray"] }
ndarray = { version = "0.15", features = ["rayon"] }
tokenizers = { version = "0.21", default-features = false, features = ["onig"] }
csv = "1.4.0"

# LAN Share Support
axum = { version = "0.7", features = ["multipart", "ws"] }
tower = "0.4"
tower-http = { version = "0.5", features = ["cors", "fs"] }
local-ip-address = "0.6"
uuid = { version = "1.0", features = ["v4"] }

# Android 特定依赖
[target.'cfg(target_os = "android")'.dependencies]
jni = "0.21"
ndk = "0.8"
ndk-sys = "0.5"

[features]
custom-protocol = ["tauri/custom-protocol"]

# Android 编译配置
[profile.release]
lto = true
codegen-units = 1
panic = "abort"
strip = true

[target.aarch64-linux-android]
linker = "aarch64-linux-android30-clang"

[target.armv7-linux-androideabi]
linker = "armv7a-linux-androideabi30-clang"

[target.i686-linux-android]
linker = "i686-linux-android30-clang"

[target.x86_64-linux-android]
linker = "x86_64-linux-android30-clang"
```

### 2.2 初始化 Android 项目

```bash
# 在项目根目录执行
cd c:\Users\Misaki\Desktop\git\aurora-gallery-tauri

# 初始化 Android 项目
npx tauri android init

# 或使用 cargo
cargo tauri android init
```

### 2.3 Android Manifest 配置

创建/修改 `android/app/src/main/AndroidManifest.xml`：

```xml
<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.aurora.gallery">

    <!-- 存储权限 -->
    <uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" />
    <uses-permission android:name="android.permission.READ_MEDIA_IMAGES" />
    <uses-permission android:name="android.permission.READ_MEDIA_VIDEO" />
    
    <!-- 网络权限 -->
    <uses-permission android:name="android.permission.INTERNET" />
    <uses-permission android:name="android.permission.ACCESS_NETWORK_STATE" />
    <uses-permission android:name="android.permission.ACCESS_WIFI_STATE" />
    
    <!-- 媒体扫描权限 -->
    <uses-permission android:name="android.permission.MANAGE_MEDIA" />

    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="@string/app_name"
        android:roundIcon="@mipmap/ic_launcher_round"
        android:supportsRtl="true"
        android:theme="@style/AppTheme"
        android:requestLegacyExternalStorage="true"
        android:usesCleartextTraffic="true">
        
        <activity
            android:name=".MainActivity"
            android:exported="true"
            android:configChanges="orientation|keyboardHidden|screenSize|screenLayout"
            android:windowSoftInputMode="adjustResize">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
        
        <!-- 文件提供者（用于文件共享） -->
        <provider
            android:name="androidx.core.content.FileProvider"
            android:authorities="${applicationId}.fileprovider"
            android:exported="false"
            android:grantUriPermissions="true">
            <meta-data
                android:name="android.support.FILE_PROVIDER_PATHS"
                android:resource="@xml/file_paths" />
        </provider>
    </application>

</manifest>
```

创建 `android/app/src/main/res/xml/file_paths.xml`：

```xml
<?xml version="1.0" encoding="utf-8"?>
<paths>
    <external-path name="external" path="." />
    <external-files-path name="external_files" path="." />
    <cache-path name="cache" path="." />
    <files-path name="files" path="." />
</paths>
```

---

## 三、核心适配实现

### 3.1 Android 平台适配器

创建 `mobile/src/api/adapters/AndroidAdapter.ts`：

```typescript
import { SharedApi, BrowseResponse, DominantColor, ConnectedDevice } from '../../../src/shared/api/types';

interface AndroidBridge {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  convertFileSrc: (path: string) => string;
}

export class AndroidAdapter implements SharedApi {
  private bridge: AndroidBridge;

  constructor(bridge: AndroidBridge) {
    this.bridge = bridge;
  }

  getImageUrl(path: string): string {
    return this.bridge.convertFileSrc(path);
  }

  getThumbnailUrl(path: string): string {
    return this.bridge.convertFileSrc(path);
  }

  async browse(path: string): Promise<BrowseResponse> {
    const result = await this.bridge.invoke('android_browse_directory', { path });
    return result as BrowseResponse;
  }

  async deleteFile(path: string): Promise<void> {
    await this.bridge.invoke('android_delete_file', { path });
  }

  async renameFile(oldPath: string, newPath: string): Promise<void> {
    await this.bridge.invoke('android_rename_file', { oldPath, newPath });
  }

  async moveFile(src: string, dest: string): Promise<void> {
    await this.bridge.invoke('android_move_file', { src, dest });
  }

  async copyFile(src: string, dest: string): Promise<string> {
    const result = await this.bridge.invoke('android_copy_file', { src, dest });
    return result as string;
  }

  async getAnimationData(path: string): Promise<string | null> {
    try {
      const result = await this.bridge.invoke('android_get_animation_data', { path });
      return result as string;
    } catch {
      return null;
    }
  }

  async getSpecialFormatPreview(path: string, format: 'jxl' | 'avif'): Promise<string> {
    const cmd = format === 'jxl' ? 'android_get_jxl_preview' : 'android_get_avif_preview';
    const result = await this.bridge.invoke(cmd, { path });
    return result as string;
  }

  async moveFileToFolder(src: string, dest: string): Promise<void> {
    await this.bridge.invoke('android_move_file_to_folder', { src, dest });
  }

  async copyFileToFolder(src: string, dest: string): Promise<string> {
    const result = await this.bridge.invoke('android_copy_file_to_folder', { src, dest });
    return result as string;
  }

  async getDominantColors(path: string, count: number): Promise<DominantColor[]> {
    const result = await this.bridge.invoke('android_get_dominant_colors', { path, count });
    return result as DominantColor[];
  }

  async copyToClipboard(path: string): Promise<void> {
    await this.bridge.invoke('android_copy_to_clipboard', { path });
  }

  async getDevices(): Promise<ConnectedDevice[]> {
    const result = await this.bridge.invoke('android_get_devices');
    return result as ConnectedDevice[];
  }
}

export default AndroidAdapter;
```

### 3.2 Rust Android 模块

创建 `mobile/src-tauri/src/android/mod.rs`：

```rust
pub mod media_store;
pub mod thumbnail;

pub use media_store::*;
pub use thumbnail::*;
```

创建 `mobile/src-tauri/src/android/media_store.rs`：

```rust
use jni::objects::{JObject, JString, JValue};
use jni::JNIEnv;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Clone, Serialize, Deserialize)]
pub struct AndroidImageInfo {
    pub id: i64,
    pub path: String,
    pub name: String,
    pub size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub date_modified: i64,
    pub mime_type: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AndroidFolderInfo {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub image_count: i32,
}

pub fn scan_device_images(env: &mut JNIEnv) -> Result<Vec<AndroidImageInfo>, String> {
    let content_resolver = get_content_resolver(env)?;
    
    let projection = [
        "_id",
        "_data",
        "_display_name",
        "_size",
        "width",
        "height",
        "date_modified",
        "mime_type",
    ];
    
    let sort_order = "date_modified DESC";
    
    let cursor = env.call_method(
        content_resolver,
        "query",
        "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
        &[
            JValue::Object(&get_images_uri(env)?),
            JValue::Object(&create_string_array(env, &projection)?),
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
            JValue::Object(&env.new_string(sort_order)?.into()),
        ],
    ).map_err(|e| format!("Failed to query: {:?}", e))?;
    
    let cursor = cursor.l().map_err(|e| format!("Failed to get cursor: {:?}", e))?;
    
    parse_cursor(env, cursor)
}

pub fn scan_device_folders(env: &mut JNIEnv) -> Result<Vec<AndroidFolderInfo>, String> {
    let content_resolver = get_content_resolver(env)?;
    
    let projection = [
        "bucket_id",
        "bucket_display_name",
    ];
    
    let cursor = env.call_method(
        content_resolver,
        "query",
        "(Landroid/net/Uri;[Ljava/lang/String;Ljava/lang/String;[Ljava/lang/String;Ljava/lang/String;)Landroid/database/Cursor;",
        &[
            JValue::Object(&get_images_uri(env)?),
            JValue::Object(&create_string_array(env, &projection)?),
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
            JValue::Object(&JObject::null()),
        ],
    ).map_err(|e| format!("Failed to query: {:?}", e))?;
    
    let cursor = cursor.l().map_err(|e| format!("Failed to get cursor: {:?}", e))?;
    
    parse_folder_cursor(env, cursor)
}

fn get_content_resolver(env: &mut JNIEnv) -> Result<JObject, String> {
    let activity = get_current_activity(env)?;
    
    env.call_method(activity, "getContentResolver", "()Landroid/content/ContentResolver;", &[])
        .map_err(|e| format!("Failed to get content resolver: {:?}", e))?
        .l()
        .map_err(|e| format!("Failed to convert: {:?}", e))
}

fn get_current_activity(env: &mut JNIEnv) -> Result<JObject, String> {
    let app = env.get_java_vm()
        .map_err(|e| format!("Failed to get VM: {:?}", e))?
        .get_env(jni::AttachGuard::new)
        .map_err(|e| format!("Failed to attach: {:?}", e))?;
    
    Ok(app)
}

fn get_images_uri(env: &mut JNIEnv) -> Result<JObject, String> {
    let media_class = env.find_class("android/provider/MediaStore$Images$Media")
        .map_err(|e| format!("Failed to find class: {:?}", e))?;
    
    let field = env.get_static_field(media_class, "EXTERNAL_CONTENT_URI", "Landroid/net/Uri;")
        .map_err(|e| format!("Failed to get field: {:?}", e))?;
    
    field.l().map_err(|e| format!("Failed to convert: {:?}", e))
}

fn create_string_array(env: &mut JNIEnv, strings: &[&str]) -> Result<JObject, String> {
    let array = env.new_object_array(strings.len() as i32, "java/lang/String", JObject::null())
        .map_err(|e| format!("Failed to create array: {:?}", e))?;
    
    for (i, s) in strings.iter().enumerate() {
        let jstr = env.new_string(s).map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.set_object_array_element(array, i as i32, jstr)
            .map_err(|e| format!("Failed to set element: {:?}", e))?;
    }
    
    Ok(array)
}

fn parse_cursor(env: &mut JNIEnv, cursor: JObject) -> Result<Vec<AndroidImageInfo>, String> {
    let mut results = Vec::new();
    
    let has_next = env.call_method(&cursor, "moveToFirst", "()Z", &[])
        .map_err(|e| format!("Failed to move to first: {:?}", e))?
        .z()
        .map_err(|e| format!("Failed to get boolean: {:?}", e))?;
    
    if !has_next {
        return Ok(results);
    }
    
    let column_indices = get_column_indices(env, &cursor)?;
    
    loop {
        let id = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(column_indices.id)])
            .map_err(|e| format!("Failed to get id: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        
        let path = get_cursor_string(env, &cursor, column_indices.path)?;
        let name = get_cursor_string(env, &cursor, column_indices.name)?;
        
        let size = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(column_indices.size)])
            .map_err(|e| format!("Failed to get size: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        
        let width = get_cursor_int_optional(env, &cursor, column_indices.width)?;
        let height = get_cursor_int_optional(env, &cursor, column_indices.height)?;
        
        let date_modified = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(column_indices.date_modified)])
            .map_err(|e| format!("Failed to get date: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        
        let mime_type = get_cursor_string(env, &cursor, column_indices.mime_type)?;
        
        results.push(AndroidImageInfo {
            id,
            path,
            name,
            size,
            width,
            height,
            date_modified,
            mime_type,
        });
        
        let has_next = env.call_method(&cursor, "moveToNext", "()Z", &[])
            .map_err(|e| format!("Failed to move to next: {:?}", e))?
            .z()
            .map_err(|e| format!("Failed to get boolean: {:?}", e))?;
        
        if !has_next {
            break;
        }
    }
    
    env.call_method(&cursor, "close", "()V", &[])
        .map_err(|e| format!("Failed to close cursor: {:?}", e))?;
    
    Ok(results)
}

struct ColumnIndices {
    id: i32,
    path: i32,
    name: i32,
    size: i32,
    width: i32,
    height: i32,
    date_modified: i32,
    mime_type: i32,
}

fn get_column_indices(env: &mut JNIEnv, cursor: &JObject) -> Result<ColumnIndices, String> {
    let get_index = |column: &str| -> Result<i32, String> {
        let col_str = env.new_string(column).map_err(|e| format!("Failed to create string: {:?}", e))?;
        let index = env.call_method(cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?;
        Ok(index)
    };
    
    Ok(ColumnIndices {
        id: get_index("_id")?,
        path: get_index("_data")?,
        name: get_index("_display_name")?,
        size: get_index("_size")?,
        width: get_index("width")?,
        height: get_index("height")?,
        date_modified: get_index("date_modified")?,
        mime_type: get_index("mime_type")?,
    })
}

fn get_cursor_string(env: &mut JNIEnv, cursor: &JObject, index: i32) -> Result<String, String> {
    let jstr = env.call_method(cursor, "getString", "(I)Ljava/lang/String;", &[JValue::Int(index)])
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .l()
        .map_err(|e| format!("Failed to convert: {:?}", e))?;
    
    let s: JString = jstr.into();
    let result = env.get_string(&s)
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .into();
    
    Ok(result)
}

fn get_cursor_int_optional(env: &mut JNIEnv, cursor: &JObject, index: i32) -> Result<Option<i32>, String> {
    if index < 0 {
        return Ok(None);
    }
    
    let value = env.call_method(cursor, "getInt", "(I)I", &[JValue::Int(index)])
        .map_err(|e| format!("Failed to get int: {:?}", e))?
        .i()
        .map_err(|e| format!("Failed to get int: {:?}", e))?;
    
    if value == 0 {
        Ok(None)
    } else {
        Ok(Some(value))
    }
}

fn parse_folder_cursor(env: &mut JNIEnv, cursor: JObject) -> Result<Vec<AndroidFolderInfo>, String> {
    let mut results = Vec::new();
    let mut folder_map: std::collections::HashMap<i64, (String, String, i32)> = std::collections::HashMap::new();
    
    let has_next = env.call_method(&cursor, "moveToFirst", "()Z", &[])
        .map_err(|e| format!("Failed to move to first: {:?}", e))?
        .z()
        .map_err(|e| format!("Failed to get boolean: {:?}", e))?;
    
    if !has_next {
        return Ok(results);
    }
    
    let bucket_id_index = {
        let col_str = env.new_string("bucket_id").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };
    
    let bucket_name_index = {
        let col_str = env.new_string("bucket_display_name").map_err(|e| format!("Failed to create string: {:?}", e))?;
        env.call_method(&cursor, "getColumnIndex", "(Ljava/lang/String;)I", &[JValue::Object(&col_str)])
            .map_err(|e| format!("Failed to get column index: {:?}", e))?
            .i()
            .map_err(|e| format!("Failed to get int: {:?}", e))?
    };
    
    loop {
        let bucket_id = env.call_method(&cursor, "getLong", "(I)J", &[JValue::Int(bucket_id_index)])
            .map_err(|e| format!("Failed to get bucket_id: {:?}", e))?
            .j()
            .map_err(|e| format!("Failed to get long: {:?}", e))?;
        
        let bucket_name = get_cursor_string(env, &cursor, bucket_name_index)?;
        
        let entry = folder_map.entry(bucket_id).or_insert((bucket_name.clone(), String::new(), 0));
        entry.2 += 1;
        
        let has_next = env.call_method(&cursor, "moveToNext", "()Z", &[])
            .map_err(|e| format!("Failed to move to next: {:?}", e))?
            .z()
            .map_err(|e| format!("Failed to get boolean: {:?}", e))?;
        
        if !has_next {
            break;
        }
    }
    
    env.call_method(&cursor, "close", "()V", &[])
        .map_err(|e| format!("Failed to close cursor: {:?}", e))?;
    
    for (id, (name, path, count)) in folder_map {
        results.push(AndroidFolderInfo {
            id,
            name,
            path,
            image_count: count,
        });
    }
    
    Ok(results)
}
```

创建 `mobile/src-tauri/src/android/thumbnail.rs`：

```rust
use image::{DynamicImage, ImageFormat};
use std::fs::File;
use std::io::{BufReader, BufWriter};
use std::path::Path;
use serde::Serialize;

const THUMBNAIL_SIZE: u32 = 256;
const JPEG_QUALITY: u8 = 80;

#[derive(Clone, Serialize)]
pub struct ThumbnailResult {
    pub path: String,
    pub thumbnail_path: Option<String>,
    pub width: u32,
    pub height: u32,
}

pub fn generate_thumbnail(
    image_path: &str,
    cache_dir: &Path,
) -> Result<ThumbnailResult, String> {
    let path = Path::new(image_path);
    if !path.exists() {
        return Err(format!("Image not found: {}", image_path));
    }
    
    let metadata = std::fs::metadata(path)
        .map_err(|e| format!("Failed to get metadata: {}", e))?;
    let size = metadata.len();
    let modified = metadata.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);
    
    let cache_key = format!("{}-{}-{}", size, modified, image_path);
    let hash = format!("{:x}", md5::compute(cache_key.as_bytes()));
    let cache_filename = format!("{}.jpg", &hash[..24]);
    let cache_path = cache_dir.join(&cache_filename);
    
    if cache_path.exists() {
        return Ok(ThumbnailResult {
            path: image_path.to_string(),
            thumbnail_path: Some(cache_path.to_string_lossy().to_string()),
            width: 0,
            height: 0,
        });
    }
    
    let img = load_image(path)?;
    let (width, height) = (img.width(), img.height());
    
    let thumbnail = resize_image(&img, THUMBNAIL_SIZE);
    
    if !cache_dir.exists() {
        std::fs::create_dir_all(cache_dir)
            .map_err(|e| format!("Failed to create cache dir: {}", e))?;
    }
    
    let file = File::create(&cache_path)
        .map_err(|e| format!("Failed to create cache file: {}", e))?;
    let writer = BufWriter::new(file);
    
    let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(writer, JPEG_QUALITY);
    encoder.encode(
        thumbnail.as_bytes(),
        thumbnail.width(),
        thumbnail.height(),
        image::ColorType::Rgb8.into(),
    ).map_err(|e| format!("Failed to encode: {}", e))?;
    
    Ok(ThumbnailResult {
        path: image_path.to_string(),
        thumbnail_path: Some(cache_path.to_string_lossy().to_string()),
        width,
        height,
    })
}

fn load_image(path: &Path) -> Result<DynamicImage, String> {
    let file = File::open(path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    let reader = BufReader::new(file);
    
    let mut image_reader = image::io::Reader::new(reader);
    image_reader = image_reader.with_guessed_format()
        .map_err(|e| format!("Failed to guess format: {}", e))?;
    
    image_reader.decode()
        .map_err(|e| format!("Failed to decode: {}", e))
}

fn resize_image(img: &DynamicImage, target_size: u32) -> DynamicImage {
    let (width, height) = (img.width(), img.height());
    
    let (new_width, new_height) = if width < height {
        let ratio = height as f32 / width as f32;
        (target_size, (target_size as f32 * ratio) as u32)
    } else {
        let ratio = width as f32 / height as f32;
        ((target_size as f32 * ratio) as u32, target_size)
    };
    
    img.resize(new_width, new_height, image::imageops::FilterType::Lanczos3)
}

pub fn generate_thumbnails_batch(
    image_paths: Vec<String>,
    cache_dir: String,
    on_progress: impl Fn(usize, usize) + Send + Sync + 'static,
) -> Result<Vec<ThumbnailResult>, String> {
    let cache_path = Path::new(&cache_dir);
    let mut results = Vec::new();
    let total = image_paths.len();
    
    for (i, path) in image_paths.iter().enumerate() {
        match generate_thumbnail(path, cache_path) {
            Ok(result) => results.push(result),
            Err(e) => {
                log::warn!("Failed to generate thumbnail for {}: {}", path, e);
                results.push(ThumbnailResult {
                    path: path.clone(),
                    thumbnail_path: None,
                    width: 0,
                    height: 0,
                });
            }
        }
        
        on_progress(i + 1, total);
    }
    
    Ok(results)
}
```

### 3.3 Android Tauri 命令

修改 `src-tauri/src/main.rs`，添加 Android 条件编译：

```rust
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};

mod color_extractor;
mod color_db;
mod color_worker;
mod db;
mod color_search;
mod thumbnail;
mod updater;
mod update_downloader;
mod clip;
mod work_extractor;
mod lan_share;
mod lan_share_commands;

mod file_types;
mod image_utils;
mod scanner;
mod file_operations;
mod clip_commands;
mod db_commands;
mod system_commands;
mod window_commands;
mod color_commands;
mod update_commands;

#[cfg(target_os = "android")]
mod android;

use crate::thumbnail::{get_thumbnail, get_thumbnails_batch, save_remote_thumbnail, generate_drag_preview};
use crate::color_search::{search_by_palette, search_by_color};
use crate::file_types::SavedWindowState;
use crate::window_commands::{get_window_state_path, get_initial_db_paths, save_window_state};
use crate::lan_share_commands::LanShareState;
use db::AppDbPool;

#[cfg(target_os = "android")]
use android::{scan_device_images, scan_device_folders, generate_thumbnail as android_generate_thumbnail};

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_scan_images(app: tauri::AppHandle) -> Result<Vec<android::AndroidImageInfo>, String> {
    use tauri::Manager;
    
    let activity = app.android_activity()
        .ok_or("Failed to get Android activity")?;
    
    let mut env = activity.vm().get_env()
        .map_err(|e| format!("Failed to get JNIEnv: {:?}", e))?;
    
    scan_device_images(&mut env)
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_scan_folders(app: tauri::AppHandle) -> Result<Vec<android::AndroidFolderInfo>, String> {
    let activity = app.android_activity()
        .ok_or("Failed to get Android activity")?;
    
    let mut env = activity.vm().get_env()
        .map_err(|e| format!("Failed to get JNIEnv: {:?}", e))?;
    
    scan_device_folders(&mut env)
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_get_thumbnail(
    file_path: String,
    cache_root: String,
) -> Result<Option<String>, String> {
    let cache_path = Path::new(&cache_root);
    
    let result = tauri::async_runtime::spawn_blocking(move || {
        android_generate_thumbnail(&file_path, cache_path)
    }).await;
    
    match result {
        Ok(Ok(r)) => Ok(r.thumbnail_path),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(e.to_string()),
    }
}

fn main() {
    let builder = tauri::Builder::default();
    
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }));
    
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .targets([
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                    tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                ])
                .build()
        );
    
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_drag::init());
    
    let builder = builder.invoke_handler(tauri::generate_handler![
        db_commands::save_user_data,
        db_commands::load_user_data,
        search_by_palette,
        search_by_color,
        scanner::scan_directory,
        file_operations::db_copy_file_metadata,
        scanner::force_rescan,
        color_commands::add_pending_files_to_db,
        system_commands::get_default_paths,
        get_thumbnail,
        get_thumbnails_batch,
        save_remote_thumbnail,
        image_utils::get_avif_preview,
        image_utils::get_jxl_preview,
        generate_drag_preview,
        system_commands::read_file_as_base64,
        file_operations::ensure_directory,
        file_operations::file_exists,
        system_commands::open_path,
        file_operations::create_folder,
        file_operations::rename_file,
        file_operations::delete_file,
        file_operations::copy_file,
        file_operations::copy_image_colors,
        file_operations::move_file,
        file_operations::write_file_from_bytes,
        file_operations::scan_file,
        window_commands::hide_window,
        window_commands::show_window,
        window_commands::set_window_min_size,
        window_commands::exit_app,
        color_commands::get_dominant_colors,
        color_worker::pause_color_extraction,
        color_worker::resume_color_extraction,
        db_commands::force_wal_checkpoint,
        db_commands::get_wal_info,
        db_commands::db_get_all_people,
        db_commands::db_upsert_person,
        db_commands::db_delete_person,
        db_commands::db_update_person_avatar,
        db_commands::db_get_all_topics,
        db_commands::db_upsert_topic,
        db_commands::db_delete_topic,
        db_commands::db_upsert_file_metadata,
        db_commands::db_get_all_file_metadata,
        file_operations::db_copy_file_metadata,
        db_commands::switch_root_database,
        file_operations::copy_image_to_clipboard,
        db_commands::get_color_db_stats,
        db_commands::get_color_db_error_files,
        db_commands::retry_color_extraction,
        db_commands::delete_color_db_error_files,
        update_commands::check_for_updates_command,
        system_commands::open_external_link,
        update_commands::start_update_download,
        update_commands::pause_update_download,
        update_commands::resume_update_download,
        update_commands::cancel_update_download,
        update_commands::get_update_download_progress,
        update_commands::install_update,
        update_commands::open_update_download_folder,
        system_commands::proxy_http_request,
        clip_commands::clip_search_by_text,
        clip_commands::clip_search_by_image,
        clip_commands::clip_generate_embedding,
        clip_commands::clip_get_embedding_status,
        clip_commands::clip_load_model,
        clip_commands::clip_unload_model,
        clip_commands::clip_is_model_loaded,
        clip_commands::clip_get_embedding_count,
        clip_commands::clip_get_embedding_count_by_model,
        clip_commands::clip_get_model_versions,
        clip_commands::clip_get_model_status,
        clip_commands::clip_get_embedding_stats,
        clip_commands::clip_delete_model,
        clip_commands::clip_open_model_folder,
        clip_commands::clip_generate_embeddings_batch,
        clip_commands::clip_cancel_embedding_generation,
        clip_commands::clip_pause_embedding_generation,
        clip_commands::clip_resume_embedding_generation,
        clip_commands::clip_update_config,
        clip_commands::clip_generate_tags_from_embeddings,
        clip_commands::get_all_image_files,
        clip_commands::clip_get_character_tags,
        clip_commands::clip_search_by_character_tag,
        clip_commands::clip_get_detected_characters,
        clip_commands::clip_preview_tags_from_embeddings,
        clip_commands::clip_get_work_topics,
        clip_commands::clip_create_work_topics,
        lan_share_commands::lan_share_start,
        lan_share_commands::lan_share_stop,
        lan_share_commands::lan_share_get_status,
        lan_share_commands::lan_share_get_devices,
        lan_share_commands::lan_share_get_local_ip,
        lan_share_commands::lan_share_check_port,
        lan_share_commands::lan_share_update_config
    ]);
    
    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        android_scan_images,
        android_scan_folders,
        android_get_thumbnail,
        get_thumbnail,
        get_thumbnails_batch,
        color_commands::get_dominant_colors,
        file_operations::rename_file,
        file_operations::delete_file,
        file_operations::copy_file,
        file_operations::move_file,
        system_commands::read_file_as_base64,
        file_operations::file_exists,
    ]);
    
    builder
        .setup(|app| {
            #[cfg(not(target_os = "android"))]
            {
                let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
                
                let app_handle = app.handle().clone();
                
                let tray_icon = app.default_window_icon()
                    .cloned()
                    .ok_or_else(|| {
                        log::warn!("No default window icon found");
                        "No default window icon"
                    });
                
                let tray = TrayIconBuilder::new()
                    .tooltip("Aurora Gallery")
                    .icon(match tray_icon {
                        Ok(icon) => icon,
                        Err(_) => return Ok(()),
                    })
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| {
                        match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .build(app)?;
            }
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

---

## 四、前端适配

### 4.1 平台检测工具

创建 `mobile/src/utils/platform.ts`：

```typescript
export type Platform = 'desktop' | 'android-tablet' | 'android-phone';

export interface DeviceInfo {
  platform: Platform;
  isTablet: boolean;
  isPhone: boolean;
  isAndroid: boolean;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
}

export function detectPlatform(): DeviceInfo {
  const isAndroid = /android/i.test(navigator.userAgent);
  const screenWidth = window.innerWidth;
  const screenHeight = window.innerHeight;
  const pixelRatio = window.devicePixelRatio || 1;
  
  let platform: Platform = 'desktop';
  let isTablet = false;
  let isPhone = false;
  
  if (isAndroid) {
    const minDimension = Math.min(screenWidth, screenHeight);
    isTablet = minDimension >= 600;
    isPhone = !isTablet;
    platform = isTablet ? 'android-tablet' : 'android-phone';
  }
  
  return {
    platform,
    isTablet,
    isPhone,
    isAndroid,
    screenWidth,
    screenHeight,
    pixelRatio,
  };
}

export function getApiAdapter() {
  const deviceInfo = detectPlatform();
  
  if (deviceInfo.isAndroid) {
    const { AndroidAdapter } = require('./api/adapters/AndroidAdapter');
    const { invoke, convertFileSrc } = require('@tauri-apps/api/core');
    return new AndroidAdapter({ invoke, convertFileSrc });
  }
  
  const { TauriAdapter } = require('../../src/shared/api/adapters/TauriAdapter');
  const { invoke, convertFileSrc } = require('@tauri-apps/api/core');
  return new TauriAdapter(invoke, convertFileSrc);
}
```

### 4.2 Android 入口组件

创建 `mobile/src/App.mobile.tsx`：

```tsx
import React, { useEffect, useState, useCallback } from 'react';
import { detectPlatform, DeviceInfo } from './utils/platform';
import { TabletLayout } from './components/TabletLayout';
import { PhoneLayout } from './components/PhoneLayout';
import { SplashScreen } from '../../src/components/SplashScreen';
import { ToastProvider } from '../../src/hooks/useToasts';

interface AndroidAppState {
  deviceInfo: DeviceInfo | null;
  isLoading: boolean;
  hasPermissions: boolean;
}

export function AndroidApp() {
  const [state, setState] = useState<AndroidAppState>({
    deviceInfo: null,
    isLoading: true,
    hasPermissions: false,
  });

  useEffect(() => {
    const init = async () => {
      const deviceInfo = detectPlatform();
      
      if (deviceInfo.isAndroid) {
        const hasPermissions = await requestPermissions();
        setState({
          deviceInfo,
          isLoading: false,
          hasPermissions,
        });
      } else {
        setState({
          deviceInfo,
          isLoading: false,
          hasPermissions: true,
        });
      }
    };

    init();
  }, []);

  if (state.isLoading || !state.deviceInfo) {
    return <SplashScreen />;
  }

  if (!state.hasPermissions) {
    return <PermissionRequest onGrant={requestPermissions} />;
  }

  return (
    <ToastProvider>
      {state.deviceInfo.isTablet ? (
        <TabletLayout />
      ) : (
        <PhoneLayout />
      )}
    </ToastProvider>
  );
}

async function requestPermissions(): Promise<boolean> {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke('request_storage_permission');
    return result as boolean;
  } catch (error) {
    console.error('Failed to request permissions:', error);
    return false;
  }
}

function PermissionRequest({ onGrant }: { onGrant: () => Promise<boolean> }) {
  const handleRequest = async () => {
    const granted = await onGrant();
    if (!granted) {
      alert('需要存储权限才能浏览图片');
    }
  };

  return (
    <div className="permission-screen">
      <div className="permission-content">
        <h2>需要存储权限</h2>
        <p>Aurora Gallery 需要访问您的图片库来显示和管理照片</p>
        <button onClick={handleRequest}>授予权限</button>
      </div>
    </div>
  );
}

export default AndroidApp;
```

### 4.3 平板布局组件

创建 `mobile/src/components/TabletLayout.tsx`：

```tsx
import React, { useState, useEffect, useCallback } from 'react';
import { AndroidAdapter } from './api/adapters/AndroidAdapter';
import { FileGrid } from '../../src/shared/components/Grid';
import { ImageViewer } from '../../src/shared/components/ImageViewer';
import { TreeSidebar } from '../../src/components/TreeSidebar';
import { MetadataPanel } from '../../src/components/MetadataPanel';
import { TopBar } from '../../src/shared/components/TopBar';
import { AndroidImageInfo, AndroidFolderInfo } from './types';

interface TabletLayoutProps {}

export function TabletLayout({}: TabletLayoutProps) {
  const [folders, setFolders] = useState<AndroidFolderInfo[]>([]);
  const [images, setImages] = useState<AndroidImageInfo[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<AndroidFolderInfo | null>(null);
  const [selectedImage, setSelectedImage] = useState<AndroidImageInfo | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  
  const api = new AndroidAdapter({
    invoke: async (cmd: string, args?: Record<string, unknown>) => {
      const { invoke } = await import('@tauri-apps/api/core');
      return invoke(cmd, args);
    },
    convertFileSrc: async (path: string) => {
      const { convertFileSrc } = await import('@tauri-apps/api/core');
      return convertFileSrc(path);
    },
  });

  useEffect(() => {
    loadFolders();
  }, []);

  const loadFolders = async () => {
    setIsLoading(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const folderList = await invoke('android_scan_folders') as AndroidFolderInfo[];
      setFolders(folderList);
    } catch (error) {
      console.error('Failed to load folders:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadImages = async (folder: AndroidFolderInfo) => {
    setIsLoading(true);
    setSelectedFolder(folder);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const imageList = await invoke('android_scan_images') as AndroidImageInfo[];
      const filteredImages = imageList.filter(img => 
        img.path.startsWith(folder.path)
      );
      setImages(filteredImages);
    } catch (error) {
      console.error('Failed to load images:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleImageClick = (image: AndroidImageInfo) => {
    setSelectedImage(image);
  };

  const handleCloseViewer = () => {
    setSelectedImage(null);
  };

  return (
    <div className="tablet-layout">
      <aside className="sidebar">
        <TreeSidebar
          folders={folders.map(f => ({
            id: f.id.toString(),
            name: f.name,
            path: f.path,
            children: [],
          }))}
          selectedFolder={selectedFolder?.path}
          onFolderSelect={loadImages}
        />
      </aside>
      
      <main className="main-content">
        <TopBar
          title={selectedFolder?.name || '所有图片'}
          imageCount={images.length}
        />
        
        <div className="content-area">
          {isLoading ? (
            <div className="loading">加载中...</div>
          ) : (
            <FileGrid
              files={images.map(img => ({
                name: img.name,
                path: img.path,
                type: 'image',
                size: img.size,
                width: img.width,
                height: img.height,
              }))}
              onFileClick={handleImageClick}
              api={api}
            />
          )}
        </div>
      </main>
      
      <aside className="metadata-panel">
        {selectedImage && (
          <MetadataPanel
            image={{
              name: selectedImage.name,
              path: selectedImage.path,
              size: selectedImage.size,
              width: selectedImage.width,
              height: selectedImage.height,
            }}
          />
        )}
      </aside>
      
      {selectedImage && (
        <ImageViewer
          image={{
            name: selectedImage.name,
            path: selectedImage.path,
          }}
          api={api}
          onClose={handleCloseViewer}
        />
      )}
    </div>
  );
}

export default TabletLayout;
```

### 4.4 手机布局组件

创建 `mobile/src/components/PhoneLayout.tsx`：

```tsx
import React, { useState, useEffect } from 'react';
import { AndroidAdapter } from './api/adapters/AndroidAdapter';
import { FileGrid } from '../../src/shared/components/Grid';
import { ImageViewer } from '../../src/shared/components/ImageViewer';
import { AndroidImageInfo, AndroidFolderInfo } from './types';
import { Menu, X, ChevronLeft } from 'lucide-react';

export function PhoneLayout() {
  const [folders, setFolders] = useState<AndroidFolderInfo[]>([]);
  const [images, setImages] = useState<AndroidImageInfo[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<AndroidFolderInfo | null>(null);
  const [selectedImage, setSelectedImage] = useState<AndroidImageInfo | null>(null);
  const [isDrawerOpen, setIsDrawerOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadFolders();
  }, []);

  const loadFolders = async () => {
    setIsLoading(true);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const folderList = await invoke('android_scan_folders') as AndroidFolderInfo[];
      setFolders(folderList);
    } catch (error) {
      console.error('Failed to load folders:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadImages = async (folder: AndroidFolderInfo) => {
    setIsLoading(true);
    setSelectedFolder(folder);
    setIsDrawerOpen(false);
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const imageList = await invoke('android_scan_images') as AndroidImageInfo[];
      const filteredImages = imageList.filter(img => 
        img.path.startsWith(folder.path)
      );
      setImages(filteredImages);
    } catch (error) {
      console.error('Failed to load images:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleBack = () => {
    setSelectedFolder(null);
    setImages([]);
  };

  return (
    <div className="phone-layout">
      <header className="phone-header">
        {selectedFolder ? (
          <>
            <button className="back-btn" onClick={handleBack}>
              <ChevronLeft size={24} />
            </button>
            <h1>{selectedFolder.name}</h1>
            <span className="image-count">{images.length} 张</span>
          </>
        ) : (
          <>
            <button className="menu-btn" onClick={() => setIsDrawerOpen(true)}>
              <Menu size={24} />
            </button>
            <h1>Aurora Gallery</h1>
          </>
        )}
      </header>

      <main className="phone-content">
        {isLoading ? (
          <div className="loading">加载中...</div>
        ) : selectedFolder ? (
          <FileGrid
            files={images.map(img => ({
              name: img.name,
              path: img.path,
              type: 'image',
              size: img.size,
              width: img.width,
              height: img.height,
            }))}
            onFileClick={setSelectedImage}
            api={new AndroidAdapter({
              invoke: async (cmd: string, args?: Record<string, unknown>) => {
                const { invoke } = await import('@tauri-apps/api/core');
                return invoke(cmd, args);
              },
              convertFileSrc: async (path: string) => {
                const { convertFileSrc } = await import('@tauri-apps/api/core');
                return convertFileSrc(path);
              },
            })}
          />
        ) : (
          <div className="folder-list">
            {folders.map(folder => (
              <div
                key={folder.id}
                className="folder-item"
                onClick={() => loadImages(folder)}
              >
                <div className="folder-icon">📁</div>
                <div className="folder-info">
                  <div className="folder-name">{folder.name}</div>
                  <div className="folder-count">{folder.image_count} 张图片</div>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {isDrawerOpen && (
        <div className="drawer-overlay" onClick={() => setIsDrawerOpen(false)}>
          <div className="drawer" onClick={e => e.stopPropagation()}>
            <div className="drawer-header">
              <h2>相册</h2>
              <button onClick={() => setIsDrawerOpen(false)}>
                <X size={24} />
              </button>
            </div>
            <div className="drawer-content">
              {folders.map(folder => (
                <div
                  key={folder.id}
                  className="drawer-folder-item"
                  onClick={() => loadImages(folder)}
                >
                  <span className="folder-icon">📁</span>
                  <span className="folder-name">{folder.name}</span>
                  <span className="folder-count">{folder.image_count}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {selectedImage && (
        <ImageViewer
          image={{
            name: selectedImage.name,
            path: selectedImage.path,
          }}
          api={new AndroidAdapter({
            invoke: async (cmd: string, args?: Record<string, unknown>) => {
              const { invoke } = await import('@tauri-apps/api/core');
              return invoke(cmd, args);
            },
            convertFileSrc: async (path: string) => {
              const { convertFileSrc } = await import('@tauri-apps/api/core');
              return convertFileSrc(path);
            },
          })}
          onClose={() => setSelectedImage(null)}
        />
      )}
    </div>
  );
}

export default PhoneLayout;
```

### 4.5 类型定义

创建 `mobile/src/types.ts`：

```typescript
export interface AndroidImageInfo {
  id: number;
  path: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  date_modified: number;
  mime_type: string;
}

export interface AndroidFolderInfo {
  id: number;
  name: string;
  path: string;
  image_count: number;
}

export interface AndroidThumbnailResult {
  path: string;
  thumbnail_path?: string;
  width: number;
  height: number;
}

export interface AndroidPermissionResult {
  granted: boolean;
  shouldShowRationale: boolean;
}
```

---

## 五、样式适配

### 5.1 Android 专属样式

创建 `mobile/src/styles/mobile.css`：

```css
.tablet-layout {
  display: grid;
  grid-template-columns: 240px 1fr 280px;
  height: 100vh;
  background: #1a1a1a;
  color: #fff;
}

.tablet-layout .sidebar {
  border-right: 1px solid #333;
  overflow-y: auto;
}

.tablet-layout .main-content {
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.tablet-layout .content-area {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.tablet-layout .metadata-panel {
  border-left: 1px solid #333;
  overflow-y: auto;
}

.phone-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: #1a1a1a;
  color: #fff;
}

.phone-header {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: #252525;
  border-bottom: 1px solid #333;
  gap: 12px;
}

.phone-header h1 {
  flex: 1;
  font-size: 18px;
  font-weight: 600;
}

.phone-header .menu-btn,
.phone-header .back-btn {
  background: none;
  border: none;
  color: #fff;
  padding: 8px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
}

.phone-content {
  flex: 1;
  overflow-y: auto;
}

.folder-list {
  padding: 8px;
}

.folder-item {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}

.folder-item:hover {
  background: #333;
}

.folder-item .folder-icon {
  font-size: 32px;
  margin-right: 16px;
}

.folder-item .folder-info {
  flex: 1;
}

.folder-item .folder-name {
  font-size: 16px;
  font-weight: 500;
}

.folder-item .folder-count {
  font-size: 14px;
  color: #888;
  margin-top: 4px;
}

.drawer-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.5);
  z-index: 1000;
}

.drawer {
  position: absolute;
  top: 0;
  left: 0;
  width: 280px;
  height: 100%;
  background: #252525;
  transform: translateX(0);
  animation: slideIn 0.3s ease;
}

@keyframes slideIn {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(0);
  }
}

.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid #333;
}

.drawer-header h2 {
  font-size: 20px;
  font-weight: 600;
}

.drawer-header button {
  background: none;
  border: none;
  color: #fff;
  padding: 8px;
  cursor: pointer;
}

.drawer-content {
  padding: 8px;
}

.drawer-folder-item {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}

.drawer-folder-item:hover {
  background: #333;
}

.drawer-folder-item .folder-icon {
  margin-right: 12px;
}

.drawer-folder-item .folder-name {
  flex: 1;
  font-size: 15px;
}

.drawer-folder-item .folder-count {
  font-size: 13px;
  color: #888;
}

.permission-screen {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 100vh;
  background: #1a1a1a;
  color: #fff;
  padding: 24px;
}

.permission-content {
  text-align: center;
  max-width: 320px;
}

.permission-content h2 {
  font-size: 24px;
  margin-bottom: 16px;
}

.permission-content p {
  font-size: 16px;
  color: #888;
  margin-bottom: 24px;
}

.permission-content button {
  background: #3b82f6;
  color: #fff;
  border: none;
  padding: 12px 32px;
  border-radius: 8px;
  font-size: 16px;
  cursor: pointer;
  transition: background 0.2s;
}

.permission-content button:hover {
  background: #2563eb;
}

.loading {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 200px;
  color: #888;
}
```

---

## 六、流畅度优化（首要目标）

> **核心原则**：流畅度 > 功耗优化。无论任何情况，必须保证界面操作的流畅性，这是用户体验的基础。

### 6.1 流畅度目标

| 指标 | 目标值 | 说明 |
|-----|-------|------|
| 缩略图加载 | < 50ms | 滑动到即显示，无明显等待 |
| 滚动帧率 | 60 FPS | 始终保持 60 帧，不卡顿 |
| 页面切换 | < 100ms | 页面切换无感知延迟 |
| 图片打开 | < 200ms | 点击到显示原图的时间 |
| 手势响应 | < 16ms | 触摸到响应的单帧时间 |

### 6.2 缩略图极速加载

#### 6.2.1 多级缓存架构

```
┌─────────────────────────────────────────────────────────────┐
│                    缩略图加载流程                            │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  请求缩略图 ──► 内存缓存 ──► 磁盘缓存 ──► 原图生成          │
│                   │             │            │              │
│                   ▼             ▼            ▼              │
│              命中即返回     异步加载      后台预生成         │
│              (< 1ms)       (< 10ms)      (< 50ms)          │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

#### 6.2.2 缩略图预生成策略

创建 `mobile/src-tauri/src/android/thumbnail_preloader.rs`：

```rust
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use rayon::prelude::*;

pub struct ThumbnailPreGenerator {
    preload_queue: Mutex<VecDeque<PathBuf>>,
    preload_range: usize,
    cache_dir: PathBuf,
}

impl ThumbnailPreGenerator {
    pub fn new(cache_dir: PathBuf) -> Self {
        Self {
            preload_queue: Mutex::new(VecDeque::new()),
            preload_range: 10,
            cache_dir,
        }
    }
    
    pub fn on_scroll(&self, visible_range: std::ops::Range<usize>, all_images: &[PathBuf]) {
        let mut queue = self.preload_queue.lock().unwrap();
        queue.clear();
        
        let start = visible_range.start.saturating_sub(self.preload_range);
        let end = (visible_range.end + self.preload_range).min(all_images.len());
        
        for i in start..end {
            if !self.is_cached(&all_images[i]) {
                queue.push_back(all_images[i].clone());
            }
        }
        
        drop(queue);
        self.start_generation();
    }
    
    fn is_cached(&self, path: &PathBuf) -> bool {
        let cache_key = self.get_cache_key(path);
        let cache_path = self.cache_dir.join(format!("{}.jpg", cache_key));
        cache_path.exists()
    }
    
    fn get_cache_key(&self, path: &PathBuf) -> String {
        use std::fs;
        let metadata = fs::metadata(path).ok();
        let size = metadata.map(|m| m.len()).unwrap_or(0);
        let modified = metadata
            .and_then(|m| m.modified().ok())
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
            .unwrap_or(0);
        
        let cache_key = format!("{}-{}-{:?}", size, modified, path);
        format!("{:x}", md5::compute(cache_key.as_bytes()))[..24].to_string()
    }
    
    fn start_generation(&self) {
        let queue = self.preload_queue.lock().unwrap().clone();
        let cache_dir = self.cache_dir.clone();
        
        std::thread::spawn(move || {
            queue.into_par_iter().for_each(|path| {
                let _ = super::thumbnail::generate_thumbnail(
                    path.to_str().unwrap_or_default(),
                    &cache_dir,
                );
            });
        });
    }
}
```

#### 6.2.3 动态缩略图尺寸

| 场景 | 缩略图尺寸 | 质量 | 说明 |
|-----|----------|------|------|
| 快速滑动 | 128x128 | 70% | 最小尺寸，最快加载 |
| 正常浏览 | 256x256 | 85% | 平衡质量和速度 |
| 停止滑动 | 512x512 | 95% | 高清预览 |

### 6.3 虚拟滚动优化

创建 `mobile/src/hooks/useVirtualScroll.ts`：

```typescript
import { useState, useCallback, useRef, useEffect } from 'react';

interface VirtualScrollConfig {
  itemHeight: number;
  itemsPerRow: number;
  overscanRows: number;
  containerHeight: number;
}

interface VirtualScrollResult<T> {
  visibleItems: T[];
  startIndex: number;
  endIndex: number;
  onScroll: (scrollTop: number) => void;
  totalHeight: number;
  offsetY: number;
}

export function useVirtualScroll<T>(
  items: T[],
  config: VirtualScrollConfig
): VirtualScrollResult<T> {
  const { itemHeight, itemsPerRow, overscanRows, containerHeight } = config;
  
  const [scrollTop, setScrollTop] = useState(0);
  const scrollStateRef = useRef<'idle' | 'scrolling' | 'fast'>('idle');
  const lastScrollTimeRef = useRef(0);
  
  const totalRows = Math.ceil(items.length / itemsPerRow);
  const totalHeight = totalRows * itemHeight;
  
  const startRow = Math.floor(scrollTop / itemHeight);
  const endRow = Math.min(
    startRow + Math.ceil(containerHeight / itemHeight),
    totalRows
  );
  
  const visibleStartRow = Math.max(0, startRow - overscanRows);
  const visibleEndRow = Math.min(totalRows, endRow + overscanRows);
  
  const startIndex = visibleStartRow * itemsPerRow;
  const endIndex = Math.min(items.length, visibleEndRow * itemsPerRow);
  
  const visibleItems = items.slice(startIndex, endIndex);
  const offsetY = visibleStartRow * itemHeight;
  
  const onScroll = useCallback((newScrollTop: number) => {
    const now = Date.now();
    const timeSinceLastScroll = now - lastScrollTimeRef.current;
    
    if (timeSinceLastScroll < 50) {
      scrollStateRef.current = 'fast';
    } else if (timeSinceLastScroll < 200) {
      scrollStateRef.current = 'scrolling';
    } else {
      scrollStateRef.current = 'idle';
    }
    
    lastScrollTimeRef.current = now;
    setScrollTop(newScrollTop);
  }, []);
  
  return {
    visibleItems,
    startIndex,
    endIndex,
    onScroll,
    totalHeight,
    offsetY,
  };
}

export function getThumbnailQuality(scrollState: 'idle' | 'scrolling' | 'fast'): {
  size: number;
  quality: number;
} {
  switch (scrollState) {
    case 'fast':
      return { size: 128, quality: 70 };
    case 'scrolling':
      return { size: 256, quality: 85 };
    case 'idle':
      return { size: 512, quality: 95 };
  }
}
```

### 6.4 图片解码优化

#### 6.4.1 JPEG 快速解码

创建 `mobile/src-tauri/src/android/fast_decoder.rs`：

```rust
use image::{DynamicImage, ImageError};
use std::path::Path;
use std::fs::File;
use std::io::BufReader;

pub struct FastImageDecoder {
    max_concurrent: usize,
}

impl FastImageDecoder {
    pub fn new() -> Self {
        Self {
            max_concurrent: num_cpus::get().min(4),
        }
    }
    
    pub fn decode_jpeg_fast(&self, path: &Path) -> Result<DynamicImage, ImageError> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        
        let mut decoder = image::codecs::jpeg::JpegDecoder::new(reader)?;
        decoder.scale(256, 256).ok();
        
        DynamicImage::from_decoder(decoder)
    }
    
    pub fn decode_region(
        &self,
        path: &Path,
        region: (u32, u32, u32, u32),
    ) -> Result<DynamicImage, ImageError> {
        let file = File::open(path)?;
        let reader = BufReader::new(file);
        
        let decoder = image::io::Reader::new(reader)
            .with_guessed_format()?
            .decode()?;
        
        let (x, y, width, height) = region;
        Ok(decoder.crop(x, y, width, height))
    }
}

pub fn get_format_priority(format: &str) -> u8 {
    match format.to_lowercase().as_str() {
        "jpeg" | "jpg" => 100,
        "png" => 80,
        "webp" => 60,
        "heic" | "heif" => 40,
        _ => 20,
    }
}
```

#### 6.4.2 格式支持策略

| 格式 | 优先级 | 解码方式 | 说明 |
|-----|-------|---------|------|
| JPEG | 最高 | 快速 JPEG 解码 | 主流格式，极速解码 |
| PNG | 高 | image crate | 常见格式 |
| WebP | 中 | libwebp | 现代格式 |
| HEIC | 低 | 系统解码 | iOS 格式，依赖系统 |

### 6.5 内存优化

#### 6.5.1 缩略图内存池

创建 `mobile/src-tauri/src/android/memory_pool.rs`：

```rust
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicUsize, Ordering};

pub struct ThumbnailMemoryPool {
    pool_size: usize,
    cache: Mutex<HashMap<PathBuf, Arc<Vec<u8>>>>,
    current_usage: AtomicUsize,
}

impl ThumbnailMemoryPool {
    pub fn new() -> Self {
        let total_mem = get_total_memory();
        let pool_size = match total_mem {
            mem if mem >= 8 * 1024 => 256 * 1024 * 1024,
            mem if mem >= 4 * 1024 => 128 * 1024 * 1024,
            _ => 64 * 1024 * 1024,
        };
        
        Self {
            pool_size,
            cache: Mutex::new(HashMap::new()),
            current_usage: AtomicUsize::new(0),
        }
    }
    
    pub fn get(&self, path: &PathBuf) -> Option<Arc<Vec<u8>>> {
        let cache = self.cache.lock().unwrap();
        cache.get(path).cloned()
    }
    
    pub fn put(&self, path: PathBuf, data: Vec<u8>) {
        let data_size = data.len();
        
        while self.current_usage.load(Ordering::Relaxed) + data_size > self.pool_size {
            self.evict_oldest();
        }
        
        let mut cache = self.cache.lock().unwrap();
        cache.insert(path, Arc::new(data));
        self.current_usage.fetch_add(data_size, Ordering::SeqCst);
    }
    
    fn evict_oldest(&self) {
        let mut cache = self.cache.lock().unwrap();
        if let Some((path, data)) = cache.iter().next().map(|(k, v)| (k.clone(), v.clone())) {
            let size = data.len();
            cache.remove(&path);
            self.current_usage.fetch_sub(size, Ordering::SeqCst);
        }
    }
}

fn get_total_memory() -> usize {
    #[cfg(target_os = "android")]
    {
        use std::fs;
        let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
        for line in meminfo.lines() {
            if line.starts_with("MemTotal:") {
                let kb: String = line
                    .chars()
                    .filter(|c| c.is_ascii_digit())
                    .collect();
                return kb.parse::<usize>().unwrap_or(0) / 1024;
            }
        }
        0
    }
    
    #[cfg(not(target_os = "android"))]
    {
        num_cpus::get() * 1024
    }
}
```

#### 6.5.2 内存压力响应

```rust
pub enum MemoryPressure {
    Normal,
    Warning,
    Critical,
}

pub struct MemoryPressureMonitor;

impl MemoryPressureMonitor {
    pub fn check(&self) -> MemoryPressure {
        #[cfg(target_os = "android")]
        {
            use std::fs;
            let meminfo = fs::read_to_string("/proc/meminfo").unwrap_or_default();
            let mut available = 0u64;
            let mut total = 0u64;
            
            for line in meminfo.lines() {
                if line.starts_with("MemAvailable:") {
                    available = Self::parse_kb(line);
                } else if line.starts_with("MemTotal:") {
                    total = Self::parse_kb(line);
                }
            }
            
            let usage_ratio = 1.0 - (available as f64 / total as f64);
            
            if usage_ratio > 0.9 {
                MemoryPressure::Critical
            } else if usage_ratio > 0.75 {
                MemoryPressure::Warning
            } else {
                MemoryPressure::Normal
            }
        }
        
        #[cfg(not(target_os = "android"))]
        {
            MemoryPressure::Normal
        }
    }
    
    fn parse_kb(line: &str) -> u64 {
        line.chars()
            .filter(|c| c.is_ascii_digit())
            .collect::<String>()
            .parse()
            .unwrap_or(0)
    }
}
```

### 6.6 流畅度监控

创建 `mobile/src/utils/performanceMonitor.ts`：

```typescript
interface FrameTimeStats {
  average: number;
  p95: number;
  p99: number;
  droppedFrames: number;
}

export class PerformanceMonitor {
  private frameTimes: number[] = [];
  private lastFrameTime: number = 0;
  private isMonitoring: boolean = false;
  
  startMonitoring(): void {
    this.isMonitoring = true;
    this.lastFrameTime = performance.now();
    this.scheduleFrame();
  }
  
  stopMonitoring(): void {
    this.isMonitoring = false;
  }
  
  private scheduleFrame(): void {
    if (!this.isMonitoring) return;
    
    requestAnimationFrame(() => {
      const now = performance.now();
      const frameTime = now - this.lastFrameTime;
      this.lastFrameTime = now;
      
      this.frameTimes.push(frameTime);
      
      if (this.frameTimes.length > 100) {
        this.frameTimes.shift();
      }
      
      if (frameTime > 33.33) {
        console.warn(`Frame drop detected: ${frameTime.toFixed(2)}ms`);
      }
      
      this.scheduleFrame();
    });
  }
  
  getStats(): FrameTimeStats {
    if (this.frameTimes.length === 0) {
      return { average: 0, p95: 0, p99: 0, droppedFrames: 0 };
    }
    
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const sum = sorted.reduce((a, b) => a + b, 0);
    
    return {
      average: sum / sorted.length,
      p95: sorted[Math.floor(sorted.length * 0.95)],
      p99: sorted[Math.floor(sorted.length * 0.99)],
      droppedFrames: sorted.filter(t => t > 33.33).length,
    };
  }
  
  getCurrentFPS(): number {
    if (this.frameTimes.length === 0) return 60;
    const avgFrameTime = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    return Math.min(60, 1000 / avgFrameTime);
  }
}
```

### 6.7 第一阶段流畅度任务清单

| 任务 | 状态 | 说明 |
|-----|------|------|
| 实现多级缩略图缓存 | ⬜ | 内存缓存 + 磁盘缓存 |
| 实现虚拟滚动组件 | ⬜ | mobile/src/hooks/useVirtualScroll.ts |
| 实现 JPEG 快速解码 | ⬜ | mobile/src-tauri/src/android/fast_decoder.rs |
| 实现缩略图预生成器 | ⬜ | mobile/src-tauri/src/android/thumbnail_preloader.rs |
| 实现内存池管理 | ⬜ | mobile/src-tauri/src/android/memory_pool.rs |
| 实现流畅度监控 | ⬜ | mobile/src/utils/performanceMonitor.ts |
| 动态缩略图质量 | ⬜ | 根据滚动状态调整 |

---

## 七、构建与测试

### 7.1 构建命令

```bash
# 开发模式
npx tauri android dev

# 构建 APK
npx tauri android build

# 构建 AAB（用于上架 Play Store）
npx tauri android build --aab
```

### 7.2 调试

```bash
# 查看日志
adb logcat -s AuroraGallery

# 安装到设备
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk
```

---

## 八、任务清单

### 8.1 项目初始化任务

| 任务 | 状态 | 说明 |
|-----|------|------|
| 安装 Rust Android 目标 | ⬜ | rustup target add aarch64-linux-android |
| 配置环境变量 | ⬜ | ANDROID_HOME, NDK_HOME |
| 修改 tauri.conf.json | ⬜ | 添加 Android 配置 |
| 修改 Cargo.toml | ⬜ | 添加 Android 依赖 |
| 初始化 Android 项目 | ⬜ | npx tauri android init |
| 配置 AndroidManifest.xml | ⬜ | 权限和配置 |
| 创建 file_paths.xml | ⬜ | FileProvider 配置 |

### 8.2 核心适配任务

| 任务 | 状态 | 说明 |
|-----|------|------|
| 创建 AndroidAdapter.ts | ⬜ | mobile/src/api/adapters/AndroidAdapter.ts |
| 创建 android/mod.rs | ⬜ | mobile/src-tauri/src/android/mod.rs |
| 创建 media_store.rs | ⬜ | mobile/src-tauri/src/android/media_store.rs |
| 创建 thumbnail.rs | ⬜ | mobile/src-tauri/src/android/thumbnail.rs |
| 修改 main.rs | ⬜ | 添加 Android 条件编译 |
| 实现 JNI 调用 | ⬜ | Rust 调用 Android API |

### 8.3 前端 UI 任务

| 任务 | 状态 | 说明 |
|-----|------|------|
| 创建 platform.ts | ⬜ | mobile/src/utils/platform.ts |
| 创建 App.mobile.tsx | ⬜ | mobile/src/App.mobile.tsx |
| 创建 TabletLayout.tsx | ⬜ | mobile/src/components/TabletLayout.tsx |
| 创建 PhoneLayout.tsx | ⬜ | mobile/src/components/PhoneLayout.tsx |
| 创建 types.ts | ⬜ | mobile/src/types.ts |
| 创建 mobile.css | ⬜ | mobile/src/styles/mobile.css |
| 权限请求组件 | ⬜ | 存储权限请求 |

### 8.4 流畅度优化任务（首要目标）

| 任务 | 状态 | 说明 |
|-----|------|------|
| 实现多级缩略图缓存 | ⬜ | 内存缓存 + 磁盘缓存 |
| 实现虚拟滚动组件 | ⬜ | mobile/src/hooks/useVirtualScroll.ts |
| 实现 JPEG 快速解码 | ⬜ | mobile/src-tauri/src/android/fast_decoder.rs |
| 实现缩略图预生成器 | ⬜ | mobile/src-tauri/src/android/thumbnail_preloader.rs |
| 实现内存池管理 | ⬜ | mobile/src-tauri/src/android/memory_pool.rs |
| 实现流畅度监控 | ⬜ | mobile/src/utils/performanceMonitor.ts |
| 动态缩略图质量 | ⬜ | 根据滚动状态调整 |

### 8.5 测试任务

| 任务 | 状态 | 说明 |
|-----|------|------|
| 编译测试 | ⬜ | 确保 Rust 代码编译通过 |
| 平板 UI 测试 | ⬜ | 在平板设备上测试 |
| 手机 UI 测试 | ⬜ | 在手机设备上测试 |
| 权限测试 | ⬜ | 测试权限请求流程 |
| 图片加载测试 | ⬜ | 测试图片浏览功能 |

---

## 九、验收标准

### 9.1 功能验收

- [ ] 应用可以在 Android 设备上安装并启动
- [ ] 应用正确请求存储权限
- [ ] 可以扫描并显示设备上的图片文件夹
- [ ] 可以浏览文件夹内的图片
- [ ] 缩略图正确显示
- [ ] 可以点击图片进入全屏查看
- [ ] 平板和手机显示不同的布局

### 9.2 性能验收

- [ ] 应用启动时间 < 3 秒
- [ ] 文件夹列表加载时间 < 1 秒
- [ ] 缩略图显示流畅（60 FPS）
- [ ] 内存占用 < 200MB（空闲状态）

### 9.3 兼容性验收

- [ ] 支持 Android 7.0+（API 24+）
- [ ] 支持不同屏幕尺寸
- [ ] 支持横竖屏切换
- [ ] 支持深色模式

---

## 十、风险与注意事项

### 10.1 技术风险

| 风险 | 影响 | 缓解措施 |
|-----|------|---------|
| Tauri Android 不稳定 | 高 | 准备 React Native 备选方案 |
| JNI 调用复杂 | 中 | 封装良好的抽象层 |
| 性能问题 | 中 | 早期性能测试，优化关键路径 |
| 权限问题 | 低 | 遵循 Android 最佳实践 |

### 10.2 注意事项

1. **存储权限**：Android 11+ 需要使用 MediaStore API 或 Storage Access Framework
2. **内存管理**：移动端内存有限，需要及时释放资源
3. **电池优化**：避免后台任务消耗过多电量
4. **网络请求**：需要在主线程外执行网络操作
5. **文件路径**：Android 文件路径与桌面端不同，需要适配

---

**文档版本**: 1.1  
**创建日期**: 2026-03-15  
**更新日期**: 2026-03-15  
**维护者**: Aurora Gallery Team
