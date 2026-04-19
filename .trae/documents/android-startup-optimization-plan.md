# Android 启动速度优化方案

## 问题分析

当前在 Samsung Galaxy Tab S8+（约 20,000 张图片）上，启动需要数秒才能看到主界面。经过完整的代码审查，识别出以下延迟瓶颈：

### 延迟来源分解

| 环节 | 预估耗时 | 说明 |
|------|---------|------|
| `detectTauriEnvironmentAsync()` | ~100ms | 环境检测 |
| `tauriGetDefaultPaths()` | ~100ms | 获取默认路径 |
| `tauriLoadUserData()` | ~200ms | 加载已保存数据 |
| `isAndroidPlatform()` | ~100ms | 平台检测（首次） |
| `ensureAndroidPermission()` | 0~15s | 权限检查（已授权时快，未授权时可能很慢） |
| `scanAndroidFolders()` | **2~5s** | JNI 全表扫描 20k 行 × 5 次 JNI 调用 = 10 万次 JNI |
| 人为 `setTimeout` 延迟 | **300~500ms** | 关闭闪屏前的硬编码延迟 |
| `scanAndroidImages()` | 5~30s | 后台异步（不阻塞闪屏，但阻塞完整数据加载） |

**关键发现**：

1. **`scanAndroidImages()` 内部冗余调用 `android_scan_folders`**：[androidPlatform.ts:177-184](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/utils/androidPlatform.ts#L177-L184) 中，`scanAndroidImages()` 重新调用了 `android_scan_folders`，但 `useAppInit` 中已经调用过 `scanAndroidFolders()` 并获得了文件夹数据。这导致 **20k 行的全表扫描执行了 3 次**（1 次文件夹扫描 + 1 次图片扫描中的文件夹扫描 + 1 次图片扫描）。

2. **两次全表扫描可合并**：`scan_device_folders` 和 `scan_device_images` 各做一次 ContentProvider 全表扫描，但查询的列有大量重叠，完全可以合并为一次查询。

3. **人为延迟**：多处使用 `setTimeout(300~500ms)` 来关闭闪屏，这是不必要的等待。

4. **无缓存机制**：每次启动都重新扫描，即使数据没有变化。

---

## 优化方案

### 阶段一：低风险快速优化（预计减少 2~4 秒）

#### 1.1 消除 `scanAndroidImages()` 中的冗余文件夹扫描

**文件**: `src/utils/androidPlatform.ts`

**问题**: `scanAndroidImages()` 内部重新调用了 `invoke('android_scan_folders')`，但调用方已经通过 `scanAndroidFolders()` 获取了文件夹数据。

**方案**: 修改 `scanAndroidImages()` 接受已有的文件夹数据作为参数，避免重复 JNI 调用。

```typescript
// 改前
export async function scanAndroidImages(): Promise<...> {
  const folders = await invoke('android_scan_folders');  // 冗余！
  const images = await invoke('android_scan_images');
  // ...
}

// 改后
export async function scanAndroidImages(
  existingFolders?: Array<...>
): Promise<...> {
  const folders = existingFolders ?? await invoke('android_scan_folders');
  const images = await invoke('android_scan_images');
  // ...
}
```

在 `useAppInit.ts` 中传入已有的文件夹数据：
```typescript
const imageResult = await scanAndroidImages(folderRawData);
```

**收益**: 消除一次 20k 行的全表扫描，节省约 2~3 秒。

---

#### 1.2 移除人为闪屏关闭延迟

**文件**: `src/hooks/useAppInit.ts`, `src/App.tsx`

**问题**: 多处使用 `setTimeout(() => setShowSplash(false), 300~500ms)` 人为延迟关闭闪屏。

**方案**: 
- 将 `setTimeout` 延迟从 300~500ms 减少到 0~50ms
- 在 `App.tsx` 的 `useEffect` 中，将 500ms 延迟也减少到 50ms
- 使用 CSS `opacity` 过渡实现平滑消失，而非人为延迟

```typescript
// 改前
setIsLoading(false);
setTimeout(() => setShowSplash(false), 300);

// 改后
setIsLoading(false);
setShowSplash(false);  // 或 setTimeout(() => setShowSplash(false), 50);
```

同时给 SplashScreen 添加 CSS 退出过渡：
```tsx
// SplashScreen.tsx
<div className={`... transition-opacity duration-200 ${isVisible ? 'opacity-100' : 'opacity-0 pointer-events-none'}`}
     style={!isVisible ? { display: 'none' } : undefined}>
```

**收益**: 节省 300~500ms。

---

#### 1.3 添加性能计时日志

**文件**: `src-tauri/src/lib.rs`, `src/utils/androidPlatform.ts`

**问题**: 当前没有任何计时数据，无法量化优化效果。

**方案**: 在 Rust 端和前端都添加计时：

```rust
// lib.rs
use std::time::Instant;
let start = Instant::now();
let result = scan_device_folders(&mut env, &activity_obj);
log::info!("android_scan_folders: found {} folders in {:.2}s", 
    folders.len(), start.elapsed().as_secs_f64());
```

```typescript
// androidPlatform.ts
const t0 = performance.now();
const folders = await invoke('android_scan_folders');
console.log(`[Perf] scanAndroidFolders: ${folders.length} folders in ${(performance.now() - t0).toFixed(0)}ms`);
```

**收益**: 为后续优化提供量化依据。

---

### 阶段二：合并查询 + 缓存机制（预计再减少 2~4 秒）

#### 2.1 合并两次 Rust 全表扫描为一次

**文件**: `src-tauri/src/android/media_store.rs`, `src-tauri/src/lib.rs`

**问题**: `scan_device_folders` 和 `scan_device_images` 各做一次 ContentProvider 全表扫描，但查询的列有大量重叠。

**方案**: 新增 `scan_device_all` 函数，一次查询同时获取图片信息和文件夹聚合信息：

```rust
pub struct AndroidScanAllResult {
    pub images: Vec<AndroidImageInfo>,
    pub folders: Vec<AndroidFolderInfo>,
}

pub fn scan_device_all<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) 
    -> Result<AndroidScanAllResult, String> 
{
    let projection = [
        "_id", "_data", "_display_name", "_size", 
        "width", "height", "date_modified", "mime_type",
        "bucket_id", "bucket_display_name",
    ];
    // 一次 cursor 遍历，同时填充 images vec 和 folders hashmap
}
```

新增 Tauri 命令 `android_scan_all`，前端一次调用获取全部数据。

**收益**: JNI 调用次数减半，ContentProvider 查询从 2 次降为 1 次。

---

#### 2.2 本地缓存扫描结果

**文件**: 新增 `src/utils/scanCache.ts`，修改 `src/utils/androidPlatform.ts` 和 `src/hooks/useAppInit.ts`

**问题**: 每次启动都重新扫描，即使数据没有变化。

**方案**: 将扫描结果缓存到本地文件（Tauri appDataDir），启动时优先加载缓存：

```
启动流程（优化后）：
1. 从本地缓存加载文件夹数据 (< 100ms)
2. 立即显示主界面（文件夹总览）
3. 后台异步执行全量扫描
4. 扫描完成后对比差异，有变化则更新 UI 和缓存
```

缓存结构：
```typescript
interface ScanCache {
    version: number;           // 缓存格式版本
    timestamp: number;         // 缓存时间
    folders: AndroidFolderInfo[];
    images: AndroidImageInfo[];
    folderFileNodes: Record<string, any>;  // 预计算的 FileNode
    roots: string[];
}
```

缓存存储位置：`{appDataDir}/scan_cache.json`

**收益**: 启动时从数秒降到 < 200ms（首次启动除外）。

---

#### 2.3 优化 `ensureAndroidPermission()` 流程

**文件**: `src/utils/androidPlatform.ts`

**问题**: 权限检查流程过于保守，包含 10 秒超时 + 5 次轮询（5 秒）。

**方案**: 
- 缩短 `waitForAndroidPermission()` 超时从 10s 到 3s
- 减少轮询次数从 5 次到 2 次，间隔从 1s 到 500ms
- 如果权限已授予（最常见情况），直接返回，不进入等待/轮询逻辑

```typescript
// 改前
setTimeout(() => resolve('timeout'), 10000);  // 10s 超时
for (let i = 0; i < 5; i++) { await sleep(1000); ... }  // 5s 轮询

// 改后
setTimeout(() => resolve('timeout'), 3000);  // 3s 超时
for (let i = 0; i < 2; i++) { await sleep(500); ... }   // 1s 轮询
```

**收益**: 权限异常情况下减少最多 11 秒等待。

---

### 阶段三：深度优化（追求"秒开"体验）

#### 3.1 Java/Kotlin 端聚合辅助方法

**文件**: 新增 Kotlin 代码，修改 `src-tauri/src/android/media_store.rs`

**问题**: Rust 通过 JNI 逐行读取 cursor，每行 5~12 次 JNI 调用，20k 行 = 10~24 万次 JNI 调用。

**方案**: 在 Java/Kotlin 端写一个辅助方法，直接在 Java 层完成 cursor 遍历和聚合，返回 JSON 字符串给 Rust：

```kotlin
// MainActivity.kt
fun scanAllImages(): String {
    val cursor = contentResolver.query(...)
    val jsonArray = JSONArray()
    while (cursor.moveToNext()) {
        val obj = JSONObject().apply {
            put("id", cursor.getLong(0))
            put("path", cursor.getString(1))
            // ...
        }
        jsonArray.put(obj)
    }
    cursor.close()
    return jsonArray.toString()
}
```

Rust 端只需一次 JNI 调用获取完整 JSON，然后解析：
```rust
let json_str = env.call_method(&activity, "scanAllImages", "()Ljava/lang/String;", &[])?;
let result: Vec<AndroidImageInfo> = serde_json::from_str(&json_str)?;
```

**收益**: JNI 调用从 10~24 万次降到约 2~3 次，大幅减少 JNI 开销。

---

#### 3.2 增量/差异扫描

**文件**: `src-tauri/src/android/media_store.rs`, `src/utils/androidPlatform.ts`

**问题**: 每次启动都是全量扫描。

**方案**: 记录上次扫描的时间戳，只查询新增/修改的图片：

```rust
// 增量查询
let selection = "date_modified > ?";
let selection_args = [last_scan_timestamp.to_string()];
```

配合缓存机制，启动时：
1. 加载缓存（即时显示）
2. 增量扫描（只查新增图片，速度快）
3. 合并增量数据到缓存

**收益**: 非首次启动时，后台扫描从数秒降到 < 1 秒。

---

#### 3.3 Android 原生闪屏

**文件**: Android manifest / Kotlin Activity

**问题**: 当前使用 React 渲染的 SplashScreen，需要等 WebView 加载完成后才能显示。

**方案**: 使用 Android 12+ 的 Splash Screen API 或自定义原生闪屏：
- 原生闪屏在 Activity 启动时立即显示（0 延迟）
- WebView 加载完成后无缝过渡到 React 渲染的界面
- 消除 WebView 初始化的空白时间

**收益**: 消除 WebView 初始化到 React 渲染之间的空白时间（约 500ms~1s）。

---

## 实施优先级

| 优先级 | 优化项 | 预计收益 | 实施难度 |
|--------|--------|---------|---------|
| P0 | 1.1 消除冗余文件夹扫描 | 减少 2~3s | 低 |
| P0 | 1.2 移除人为闪屏延迟 | 减少 0.3~0.5s | 低 |
| P0 | 1.3 添加性能计时 | 度量基础 | 低 |
| P1 | 2.2 本地缓存扫描结果 | 首次后启动 < 200ms | 中 |
| P1 | 2.1 合并两次全表扫描 | 减少 1~2s | 中 |
| P1 | 2.3 优化权限检查流程 | 异常时减少 11s | 低 |
| P2 | 3.1 Java 端聚合辅助 | 大幅减少 JNI 开销 | 高 |
| P2 | 3.2 增量差异扫描 | 后台扫描 < 1s | 中 |
| P2 | 3.3 Android 原生闪屏 | 消除 WebView 空白 | 高 |

## 预期效果

| 场景 | 当前耗时 | 阶段一后 | 阶段二后 | 阶段三后 |
|------|---------|---------|---------|---------|
| 首次启动（需授权） | 5~10s | 3~6s | 3~5s | 1~2s |
| 非首次启动（已授权） | 3~6s | 1~3s | **< 0.5s** | **< 0.3s** |
| 权限被拒后重试 | 最多 15s | 最多 5s | 最多 4s | 最多 2s |

**核心目标**：实施阶段二后，非首次启动应在 500ms 内显示主界面（文件夹总览），实现"点开即用"的体验。
