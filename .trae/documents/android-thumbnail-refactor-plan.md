# Android 文件扫描与缩略图机制重构计划

## 问题诊断

### 当前症状
Android 端缩略图显示为开裂占位符，无法正常加载图片缩略图。

### 根因分析

经过代码审查，发现以下核心问题：

#### 1. 缩略图缓存路径计算错误（最关键问题）

**前端 `tauri-bridge.ts:476`**：
```typescript
const cachePath = `${rootPath}${rootPath.includes('\\') ? '\\' : '/}.Aurora_Cache`;
```
前端使用 `resourceRoot` 来计算缓存路径，而非后端返回的 `cacheRoot`。

**Android 端的 `resourceRoot`** = `/storage/emulated/0/Pictures/AuroraGallery`
**实际计算出的缓存路径** = `/storage/emulated/0/Pictures/AuroraGallery/.Aurora_Cache`

这个路径位于公共存储区域，在 Android 10+ 的分区存储（Scoped Storage）机制下，应用**无法在此创建目录和写入文件**。

#### 2. 后端 `cacheRoot` 被前端忽略

**后端 `system_commands.rs:32-37`** 返回了：
```rust
let cache_root = {
    let app_data = env::var("HOME")
        .unwrap_or_else(|_| "/data/data/com.aurora.gallery".to_string());
    format!("{}/.Aurora_Cache", app_data)
};
```
后端正确地将 `cacheRoot` 指向了应用私有目录，但前端在缩略图加载时**完全没有使用这个值**。

#### 3. "资源根目录"概念在 Android 上不适用

桌面端的设计是：用户选择一个文件夹作为根目录，所有图片都在该目录下，缓存也放在该目录的 `.Aurora_Cache` 子目录中。

但 Android 端的图片来自 MediaStore，分布在设备的各个位置（DCIM、Pictures、Downloads 等），不存在单一的"资源根目录"。将 `resourceRoot` 设为 `/storage/emulated/0/Pictures/AuroraGallery` 是错误的——这个目录可能根本不存在，也不包含用户的图片。

#### 4. 后端 `cacheRoot` 路径也不够可靠

`env::var("HOME")` 在 Android 上不一定正确设置，回退到 `/data/data/com.aurora.gallery` 也不规范。应该通过 JNI 调用 Android 的 `context.getCacheDir()` 获取正确的应用缓存目录。

#### 5. Android 端注册了桌面端缩略图命令

`lib.rs:309-310` 中，Android 端注册了 `get_thumbnails_batch`（桌面端命令），但前端调用时传入的 `cacheRoot` 是基于 `resourceRoot` 计算的错误路径。虽然 `android_get_thumbnail` 命令也注册了，但前端从未调用它。

---

## 重构方案

### 核心原则
- **Android 端不再使用"资源根目录"概念**，图片来源完全依赖 MediaStore
- **缓存目录使用 Android 规范的应用私有目录**，通过 JNI 获取
- **前端缩略图加载使用后端返回的 `cacheRoot`**，而非自行计算
- **优先利用 Android 系统缩略图**，减少自行生成的开销

### 修改清单

---

### 第一步：修复后端 `get_default_paths`，使用 JNI 获取正确的 Android 路径

**文件**: `src-tauri/src/system_commands.rs`

**修改内容**:
- Android 端通过 JNI 调用 `context.getCacheDir()` 获取应用缓存目录
- Android 端通过 JNI 调用 `context.getFilesDir()` 获取应用文件目录
- `cacheRoot` 设为 `{cacheDir}/thumbnails`
- `resourceRoot` 在 Android 端改为表示"MediaStore 虚拟根"，不再指向具体物理路径

**具体实现**:
```rust
#[cfg(target_os = "android")]
{
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };

    // 调用 getCacheDir() 获取应用缓存目录
    let cache_dir = env.call_method(
        &activity_obj, "getCacheDir", "()Ljava/io/File;", &[]
    ).map_err(|e| format!("Failed to get cache dir: {:?}", e))?
    .l().map_err(|e| format!("Failed to convert: {:?}", e))?;

    let cache_path = env.call_method(
        &cache_dir, "getAbsolutePath", "()Ljava/lang/String;", &[]
    ).map_err(|e| format!("Failed to get path: {:?}", e))?
    .l().map_err(|e| format!("Failed to convert: {:?}", e))?;

    let cache_str: String = env.get_string(&JString::from_raw(cache_path.into_raw()))
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .into();

    let resource_root = "android_media_store".to_string(); // 虚拟根，表示来自 MediaStore
    let cache_root = format!("{}/thumbnails", cache_str);

    paths.insert("resourceRoot".to_string(), resource_root);
    paths.insert("cacheRoot".to_string(), cache_root);
    return Ok(paths);
}
```

---

### 第二步：重构前端缩略图缓存路径逻辑

**文件**: `src/api/tauri-bridge.ts`

**修改内容**:
- `getThumbnail` 函数在 Android 端使用 `settings.paths.cacheRoot`，而非基于 `resourceRoot` 计算
- 添加平台检测逻辑，区分 Android 和桌面端的缓存路径计算方式

**具体修改**:
```typescript
export const getThumbnail = async (
  filePath: string,
  modified?: string,
  rootPath?: string,
  signal?: AbortSignal,
  onColors?: (colors: DominantColor[] | null) => void
): Promise<string | null> => {
  if (!filePath || filePath.trim() === '') return null;

  // Android 端使用后端返回的 cacheRoot，桌面端基于 resourceRoot 计算
  let cachePath: string;
  if (isAndroidPlatformCached()) {
    // Android: 使用后端返回的 cacheRoot
    const appCacheRoot = getAppCacheRoot();
    if (!appCacheRoot) return null;
    cachePath = appCacheRoot;
  } else {
    // 桌面端: 基于 resourceRoot 计算
    if (!rootPath || rootPath.trim() === '') return null;
    cachePath = `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
  }

  // ... 后续逻辑不变
};
```

需要添加辅助函数：
- `isAndroidPlatformCached()`: 同步判断是否为 Android 平台（从 settings 中读取）
- `getAppCacheRoot()`: 获取后端返回的 `cacheRoot`

---

### 第三步：在应用状态中存储 `cacheRoot`

**文件**: `src/hooks/useAppInit.ts` 及相关类型定义

**修改内容**:
- 确保 `get_default_paths` 返回的 `cacheRoot` 被正确存储到应用状态 `settings.paths.cacheRoot` 中
- 在 Android 初始化流程中，确保 `cacheRoot` 在缩略图请求之前就已可用

---

### 第四步：增强 Android 端缩略图生成

**文件**: `src-tauri/src/android/thumbnail.rs`

**修改内容**:
- 添加使用 Android 系统 MediaStore 缩略图的 JNI 调用（优先使用系统缩略图）
- 系统缩略图不可用时，回退到自行生成
- 确保缓存目录存在后再写入

**新增 JNI 调用 - 获取系统缩略图**:
```rust
pub fn get_system_thumbnail<'a>(
    env: &mut JNIEnv<'a>,
    activity: &JObject<'a>,
    image_id: i64,
) -> Result<Option<String>, String> {
    // 调用 ContentResolver.loadThumbnail() (Android 10+)
    // 或 MediaStore.Images.Thumbnails.queryMiniThumbnail() (旧版本)
    // 返回缩略图文件路径
}
```

**更新 `generate_thumbnail`**:
- 先检查系统缩略图是否可用
- 可用则复制到缓存目录
- 不可用则自行解码生成

---

### 第五步：更新 `AndroidImageInfo` 结构，添加 content URI

**文件**: `src-tauri/src/android/media_store.rs`

**修改内容**:
- 在 `AndroidImageInfo` 中添加 `content_uri` 字段
- 扫描时通过 `ContentUris.withAppendedId()` 构建 content URI
- content URI 可用于通过 `convertFileSrc()` 在 WebView 中显示原图

```rust
#[derive(Clone, Serialize, Deserialize)]
pub struct AndroidImageInfo {
    pub id: i64,
    pub path: String,
    pub content_uri: String,  // 新增：content://media/external/images/media/{id}
    pub name: String,
    pub size: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub date_modified: i64,
    pub mime_type: String,
}
```

---

### 第六步：修复前端 Android 图片显示

**文件**: `src/utils/androidPlatform.ts` 及图片显示组件

**修改内容**:
- 在 `scanAndroidMedia()` 中，将 `content_uri` 传递到前端 FileNode
- 图片查看器在 Android 端优先使用 `content_uri` + `convertFileSrc()` 显示原图
- 缩略图使用缓存目录中的生成文件 + `convertFileSrc()` 显示

---

### 第七步：更新 `android_get_thumbnail` 命令，支持 image_id

**文件**: `src-tauri/src/lib.rs`

**修改内容**:
- 修改 `android_get_thumbnail` 命令，接受 `image_id` 参数
- 优先尝试通过 MediaStore 获取系统缩略图
- 回退到文件路径方式生成

---

### 第八步：清理 Android 端无用的 `resourceRoot` 设置

**文件**: 设置页面相关组件

**修改内容**:
- Android 端隐藏或禁用"资源根目录"设置项
- 显示"缓存目录"设置项（只读，展示当前缓存路径）
- 添加"缓存大小"和"清除缓存"功能

---

## 修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src-tauri/src/system_commands.rs` | 修改 | 使用 JNI 获取正确的 Android 路径 |
| `src-tauri/src/android/media_store.rs` | 修改 | 添加 content_uri 字段和系统缩略图获取 |
| `src-tauri/src/android/thumbnail.rs` | 修改 | 优先使用系统缩略图，修复缓存目录逻辑 |
| `src-tauri/src/android/mod.rs` | 修改 | 导出新增的公共函数 |
| `src-tauri/src/lib.rs` | 修改 | 更新 Android 命令注册 |
| `src/api/tauri-bridge.ts` | 修改 | Android 端使用 cacheRoot |
| `src/utils/androidPlatform.ts` | 修改 | 传递 content_uri |
| `src/hooks/useAppInit.ts` | 修改 | 确保 cacheRoot 正确初始化 |
| 设置页面组件 | 修改 | Android 端隐藏 resourceRoot 设置 |

---

## 优先级排序

1. **P0 - 修复缓存路径**（第一步 + 第二步 + 第三步）：解决缩略图无法生成的根本原因
2. **P1 - 使用系统缩略图**（第四步 + 第七步）：提升缩略图加载速度
3. **P2 - content URI 支持**（第五步 + 第六步）：确保原图显示正常
4. **P3 - 设置页面优化**（第八步）：用户体验改善

---

## 风险与注意事项

1. **JNI 调用稳定性**: `getCacheDir()` 是标准 Android API，风险低，但需要处理异常
2. **向后兼容**: 修改 `AndroidImageInfo` 结构会影响前端类型定义，需要同步更新
3. **系统缩略图可用性**: Android 10+ 的 `loadThumbnail()` API 可能在某些设备上不可用，需要回退机制
4. **缓存迁移**: 已有用户可能缓存了旧路径的缩略图，需要处理迁移或清理
5. **权限**: `getCacheDir()` 返回的是应用私有目录，无需额外权限
