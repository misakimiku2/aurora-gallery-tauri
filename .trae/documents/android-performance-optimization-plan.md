# Android 性能优化计划：Web Worker 图片解码 + 内存压力感知 + 批量缩略图预取

## 概述

基于 `FoldersOverview-Implementation.md` 文档和当前代码库分析，本计划涵盖三个核心优化方向，旨在解决 Android WebView 上的缩略图解码掉帧、内存溢出风险和 JNI 通信开销问题。

---

## 优化一：Web Worker 离屏图片解码 (ImageBitmap)

### 1.1 现状分析

- 当前 `getThumbnail()` 返回的缩略图 URL（`convertFileSrc()` 转换后的 Tauri 协议 URL）直接赋值给 `<img>` 标签
- `<img>` 标签在 Android WebView 主线程进行图片解码，在 120Hz 屏幕下会造成微小掉帧
- 项目已有 2 个 Web Worker（`layout.worker.ts` 和 `search.worker.ts`），具备 Worker 基础设施
- 代码库中**不存在任何** `ImageBitmap` / `createImageBitmap` 使用

### 1.2 实现方案

#### 步骤 1：创建图片解码 Worker

**新建文件**：`src/workers/image-decode.worker.ts`

```typescript
// Worker 接收缩略图 URL，使用 createImageBitmap 预解码
// 通过 Transferable Object 将 ImageBitmap 传回主线程
self.onmessage = async (e: MessageEvent) => {
  const { id, url } = e.data;
  try {
    const response = await fetch(url);
    const blob = await response.blob();
    const imageBitmap = await createImageBitmap(blob, {
      premultiplyAlpha: 'premultiply',
      colorSpaceConversion: 'default',
      resizeQuality: 'medium',
    });
    self.postMessage({ id, imageBitmap }, [imageBitmap]);
  } catch (error) {
    self.postMessage({ id, error: String(error) });
  }
};
```

**关键设计**：
- `createImageBitmap` 在 Worker 线程中执行，完全不占用主线程
- 使用 `Transferable Object`（`[imageBitmap]`）零拷贝传回主线程
- 每个请求带唯一 `id`，支持并发请求的响应匹配

#### 步骤 2：创建 Worker 管理器

**新建文件**：`src/utils/imageDecodeWorker.ts`

```typescript
// Worker 池管理器（复用 Worker，避免频繁创建/销毁）
class ImageDecodeWorkerPool {
  private workers: Worker[] = [];
  private taskQueue: Map<string, { resolve, reject }>;
  private workerIndex: number = 0;

  constructor(poolSize: number = 2) { /* 创建 Worker 池 */ }

  async decode(url: string): Promise<ImageBitmap> {
    // 轮询分配 Worker
    // 返回 Promise<ImageBitmap>
  }

  terminate() { /* 清理所有 Worker */ }
}
```

**设计要点**：
- Worker 池大小 2（Android WebView 通常 2-4 核，留余量给布局/搜索 Worker）
- 轮询（round-robin）分配任务
- Android 专用，桌面端不走此路径（桌面端 `<img>` 解码无性能问题）

#### 步骤 3：修改 `ImageThumbnail.tsx`

**文件**：`src/components/ImageThumbnail.tsx`

- 新增 `imageBitmap` state：`const [imageBitmap, setImageBitmap] = useState<ImageBitmap | null>(null);`
- Android 平台：当 `thumbnailSrc` 获取到 URL 后，不直接赋给 `<img>`，而是发送到 Worker 解码
- 渲染时使用 `<canvas>` + `drawImage(imageBitmap)` 代替 `<img src={url}>`
- 组件卸载时调用 `imageBitmap.close()` 释放 GPU 资源
- 桌面端保持原有 `<img>` 逻辑不变

```tsx
// Android 渲染路径
{isAndroid && imageBitmap ? (
  <canvas ref={canvasRef} width={imageBitmap.width} height={imageBitmap.height}
          className="absolute inset-0 w-full h-full object-cover" />
) : !isAndroid && finalSrc ? (
  <img src={finalSrc} ... />
) : (
  <ImageIcon ... />
)}
```

- Canvas 渲染需要 `useEffect` 中调用 `ctx.drawImage(imageBitmap, 0, 0)`
- `imageBitmap` 变化时重新绘制

#### 步骤 4：修改 `FoldersOverview.tsx` FolderCard

**文件**：`src/components/FoldersOverview.tsx`

- FolderCard 的封面图同样走 Worker 解码 + Canvas 渲染路径
- 复用 `imageDecodeWorker.ts` 的 Worker 池

#### 步骤 5：修改 `FolderThumbnail.tsx`

**文件**：`src/components/FolderThumbnail.tsx`

- Android 端的文件夹封面缩略图同样走 Worker 解码路径

#### 步骤 6：升级事件处理

- `aurora:thumbnail-upgraded` 事件触发时，需要重新通过 Worker 解码新的高质量缩略图 URL
- 旧的 ImageBitmap 需要调用 `.close()` 释放

### 1.3 兼容性考虑

- `createImageBitmap` 在 Android WebView 71+ 支持（当前 Chrome 120+ 完全兼容）
- 如果 `createImageBitmap` 不可用，自动回退到原有 `<img>` 方式
- `ImageBitmap` 是 `Transferable`，但 `close()` 后不可再使用，需注意生命周期管理

### 1.4 修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/workers/image-decode.worker.ts` | **新建** | 图片解码 Worker |
| `src/utils/imageDecodeWorker.ts` | **新建** | Worker 池管理器 |
| `src/components/ImageThumbnail.tsx` | 修改 | Android 走 Worker 解码 + Canvas 渲染 |
| `src/components/FoldersOverview.tsx` | 修改 | FolderCard 封面走 Worker 解码 |
| `src/components/FolderThumbnail.tsx` | 修改 | Android 端封面走 Worker 解码 |

---

## 优化二：内存压力感知与 LRU 动态缩放

### 2.1 现状分析

- `LRUCache` 最大容量固定 1000 条，不感知实际内存占用
- `performance.memory` API 已在 `performanceMonitor.ts` 中使用，但仅用于监控/展示，未用于自动清理
- 21,000+ 图片设备上，1000 条 LRU 缓存在高分辨率设备有 OOM 风险
- 缩略图缓存存储的是 URL 字符串（`convertFileSrc` 转换后的），本身内存占用不大
- 但 ImageBitmap（优化一引入后）会占用 GPU/堆内存，需要主动释放
- `shared/` 下的 `thumbnailCache` 是普通 `Map`，无大小限制，存在内存泄漏风险

### 2.2 实现方案

#### 步骤 1：创建内存压力监控器

**新建文件**：`src/utils/memoryPressureMonitor.ts`

```typescript
type MemoryPressureLevel = 'normal' | 'warning' | 'critical';

class MemoryPressureMonitor {
  private listeners = new Set<(level: MemoryPressureLevel) => void>();
  private currentLevel: MemoryPressureLevel = 'normal';
  private checkInterval: number | null = null;

  // 阈值配置（占 jsHeapSizeLimit 的百分比）
  private WARNING_THRESHOLD = 0.7;   // 70%
  private CRITICAL_THRESHOLD = 0.85; // 85%

  start(intervalMs: number = 2000) {
    // 定时检查 performance.memory
    // 计算使用率 = usedJSHeapSize / jsHeapSizeLimit
    // 超过阈值时通知监听器
  }

  getLevel(): MemoryPressureLevel { return this.currentLevel; }
  subscribe(listener): () => void { /* ... */ }

  // 强制 GC 建议（Android WebView 不支持，但可做标记）
  forceCleanup() { /* 通知所有监听器执行清理 */ }
}

export const memoryPressureMonitor = new MemoryPressureMonitor();
```

**设计要点**：
- 检测间隔 2 秒（比 performanceMonitor 的 5 秒更频繁，因为需要及时响应）
- 三级压力：`normal`（<70%）、`warning`（70-85%）、`critical`（>85%）
- 仅 Android 平台启用（`performance.memory` 是 Chrome 非标准 API，Android WebView 支持）

#### 步骤 2：升级 LRUCache 为内存感知版本

**修改文件**：`src/utils/thumbnailCache.ts`

```typescript
export class LRUCache<T> {
  private cache: Map<string, { value: T; timestamp: number }>;
  private maxSize: number;
  private minSize: number;  // 新增：最小容量（不低于此值）
  private imageBitmaps: Map<string, ImageBitmap>; // 新增：跟踪 ImageBitmap 资源

  // 新增：根据内存压力动态调整 maxSize
  adjustSize(memoryLevel: MemoryPressureLevel) {
    switch (memoryLevel) {
      case 'critical':
        this.maxSize = this.minSize;  // 降至最小（如 200）
        this.evictToSize(this.maxSize);
        this.releaseNonVisibleBitmaps(); // 释放非可见 ImageBitmap
        break;
      case 'warning':
        this.maxSize = Math.floor(this.defaultMaxSize * 0.5); // 降至 500
        this.evictToSize(this.maxSize);
        break;
      case 'normal':
        this.maxSize = this.defaultMaxSize; // 恢复 1000
        break;
    }
  }

  // 新增：注册 ImageBitmap 资源，用于内存压力时主动释放
  registerBitmap(key: string, bitmap: ImageBitmap) { /* ... */ }
  unregisterBitmap(key: string) { /* ... */ }

  // 新增：释放非可见区域的 ImageBitmap
  releaseNonVisibleBitmaps() {
    for (const [key, bitmap] of this.imageBitmaps) {
      if (!this.isKeyVisible(key)) {
        bitmap.close();
        this.imageBitmaps.delete(key);
      }
    }
  }

  // 新增：淘汰到指定大小
  private evictToSize(targetSize: number) {
    while (this.cache.size > targetSize) {
      // 淘汰最旧项，同时释放关联的 ImageBitmap
      const oldestKey = this.findOldestKey();
      if (oldestKey) {
        this.releaseBitmapForKey(oldestKey);
        this.cache.delete(oldestKey);
      } else break;
    }
  }
}
```

**关键变更**：
- `maxSize` 从 `const` 变为动态可调
- 新增 `minSize`（建议 200）防止过度淘汰
- 新增 `imageBitmaps` Map 跟踪所有注册的 ImageBitmap 资源
- 淘汰缓存条目时，同时释放关联的 ImageBitmap（调用 `.close()`）
- `releaseNonVisibleBitmaps()` 保留可见区域的位图，释放不可见的

#### 步骤 3：在应用启动时初始化内存监控

**修改文件**：`src/App.tsx` 或 `src/hooks/useAppInit.ts`

- Android 平台启动时调用 `memoryPressureMonitor.start()`
- 订阅内存压力变化，调用 `getGlobalCache().adjustSize(level)`

#### 步骤 4：修复 shared/ 下的缓存问题

**修改文件**：`src/shared/components/Thumbnails/ImageThumbnail.tsx` 和 `FolderThumbnail.tsx`

- 将普通 `Map` 替换为 `LRUCache`（从 `shared/utils/cache.ts` 导入）
- 设置合理的 maxSize（如 200）

#### 步骤 5：ImageBitmap 生命周期管理

- `ImageThumbnail` 组件卸载时，调用 `imageBitmap.close()` 并从 LRU 的 `imageBitmaps` Map 中移除
- 内存压力 `critical` 时，遍历 `imageBitmaps`，关闭不在视口内的位图
- 组件重新进入视口时，重新通过 Worker 解码

### 2.3 修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/utils/memoryPressureMonitor.ts` | **新建** | 内存压力监控器 |
| `src/utils/thumbnailCache.ts` | 修改 | 升级为内存感知 LRU，支持动态缩放和 ImageBitmap 跟踪 |
| `src/shared/utils/cache.ts` | 修改 | 同步升级 LRUCache |
| `src/App.tsx` 或 `src/hooks/useAppInit.ts` | 修改 | Android 启动时初始化内存监控 |
| `src/shared/components/Thumbnails/ImageThumbnail.tsx` | 修改 | 替换 Map 为 LRUCache |
| `src/shared/components/Thumbnails/FolderThumbnail.tsx` | 修改 | 替换 Map 为 LRUCache |

---

## 优化三：批量缩略图路径预取（压缩 JNI 边界）

### 3.1 现状分析

- 当前 `android_get_thumbnail` 每次只获取一张缩略图
- 快速滑动时，每张图都需要一次 Rust → JNI → Android 系统调用
- 已有 `ThumbnailBatcher`（桌面端 50ms 窗口聚合），但 Android 端未使用批量机制
- `get_android_system_thumbnail` 每次调用需要：获取 ContentResolver → 调用 `getThumbnail()` → compress → 写文件，约 6-8 次 JNI 调用
- Kotlin 端已有 `scanAllAsJson` 聚合扫描的成功经验

### 3.2 实现方案

#### 步骤 1：Kotlin 端新增批量缩略图路径查询

**修改文件**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt`

```kotlin
fun batchGetThumbnailPaths(imageIds: String): String {
    // imageIds: 逗号分隔的 MediaStore _ID 列表
    // 返回 JSON: [{ id: Long, thumbnailPath: String?, width: Int, height: Int }]
    // 使用 MediaStore.Images.Thumbnails.queryMiniThumbnails 批量查询
    // 或逐个调用 getThumbnail 但在 Kotlin 层完成，避免多次 JNI
    val ids = imageIds.split(",").map { it.trim().toLong() }
    val result = JSONArray()

    for (id in ids) {
        try {
            val thumbnail = MediaStore.Images.Thumbnails.getThumbnail(
                contentResolver, id, MediaStore.Images.Thumbnails.MINI_KIND, null
            )
            if (thumbnail != null) {
                // 保存到缓存目录，返回路径
                val cacheFilename = "sys_${id}_q80.jpg"
                val cacheFile = File(cacheDir, cacheFilename)
                if (!cacheFile.exists()) {
                    val fos = FileOutputStream(cacheFile)
                    thumbnail.compress(Bitmap.CompressFormat.JPEG, 80, fos)
                    fos.close()
                }
                thumbnail.recycle()

                result.put(JSONObject().apply {
                    put("id", id)
                    put("thumbnailPath", cacheFile.absolutePath)
                    put("width", thumbnail.width)  // 注意：需要在 recycle 前获取
                    put("height", thumbnail.height)
                })
            } else {
                result.put(JSONObject().apply {
                    put("id", id)
                    put("thumbnailPath", JSONObject.NULL)
                })
            }
        } catch (e: Exception) {
            result.put(JSONObject().apply {
                put("id", id)
                put("thumbnailPath", JSONObject.NULL)
                put("error", e.message)
            })
        }
    }

    return result.toString()
}
```

**关键设计**：
- 一次 JNI 调用获取 50 张缩略图路径，替代 50 次独立调用
- 在 Kotlin 层完成 `getThumbnail` → `compress` → `write` 的完整流程
- 缓存文件路径格式与 Rust 端 `get_android_system_thumbnail` 一致（`sys_{id}_q80.jpg`），确保缓存复用
- 返回 JSON 字符串，Rust 端解析

#### 步骤 2：Rust 端新增批量缩略图命令

**修改文件**：`src-tauri/src/lib.rs`

```rust
#[cfg(target_os = "android")]
#[tauri::command]
async fn android_batch_get_thumbnails(
    app: tauri::AppHandle,
    image_ids: Vec<i64>,
    cache_root: String,
) -> Result<Vec<ThumbnailResult>, String> {
    // 1. 先检查磁盘缓存，过滤出未缓存的 ID
    let cache_path = Path::new(&cache_root);
    let mut results: Vec<ThumbnailResult> = Vec::new();
    let mut uncached_ids: Vec<i64> = Vec::new();

    for id in &image_ids {
        let cache_filename = format!("sys_{}_q80.jpg", id);
        let cache_file = cache_path.join(&cache_filename);
        if cache_file.exists() {
            results.push(ThumbnailResult {
                path: String::new(),
                thumbnail_path: Some(cache_file.to_string_lossy().to_string()),
                width: 0,
                height: 0,
                upgrading: false,
            });
        } else {
            uncached_ids.push(*id);
        }
    }

    // 2. 未缓存的 ID 通过 Kotlin 批量获取
    if !uncached_ids.is_empty() {
        let ids_str = uncached_ids.iter()
            .map(|id| id.to_string())
            .collect::<Vec<_>>()
            .join(",");

        // JNI 调用 Kotlin 的 batchGetThumbnailPaths
        let json_str = /* JNI call */ ;
        let batch_results: Vec<BatchThumbnailItem> = serde_json::from_str(&json_str)?;

        // 3. 合并结果，对 MINI_KIND < 200 的入升级队列
        for item in batch_results {
            // ...
        }
    }

    Ok(results)
}
```

#### 步骤 3：Rust 端 JNI 调用封装

**修改文件**：`src-tauri/src/android/media_store.rs`

```rust
pub fn batch_get_system_thumbnails<'a>(
    env: &mut JNIEnv<'a>,
    activity: &JObject<'a>,
    image_ids: &[i64],
    cache_dir: &Path,
) -> Result<Vec<BatchThumbnailResult>, String> {
    let ids_str = image_ids.iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(",");

    let java_string = env.new_string(&ids_str)?;
    let json_result = env.call_method(
        activity,
        "batchGetThumbnailPaths",
        "(Ljava/lang/String;)Ljava/lang/String;",
        &[JValue::Object(&java_string)],
    )?;

    // 解析 JSON 返回
    let json_str: String = json_result.l()?.into();
    let items: Vec<BatchThumbnailResult> = serde_json::from_str(&json_str)?;
    Ok(items)
}
```

#### 步骤 4：前端批量预取调度器

**新建文件**：`src/utils/thumbnailPrefetch.ts`

```typescript
class ThumbnailPrefetcher {
  private prefetchQueue: number[] = [];  // mediaStoreId 列表
  private isPrefetching: boolean = false;
  private batchSize: number = 50;

  // 视口变化时调用：传入当前可见 + 缓冲区的 mediaStoreId 列表
  updateVisibleIds(visibleIds: number[], bufferIds: number[]) {
    // 将 bufferIds 加入预取队列（去重）
    // 触发批量预取
  }

  private async prefetchBatch() {
    // 取出最多 50 个 ID
    // 调用 android_batch_get_thumbnails
    // 结果写入 LRU 缓存
  }
}
```

#### 步骤 5：在 FileGrid 和 FoldersOverview 中集成预取

**修改文件**：`src/components/FileGrid.tsx`

- 在虚拟滚动计算 `visibleItems` 后，提取缓冲区内的 `mediaStoreId` 列表
- 调用 `thumbnailPrefetcher.updateVisibleIds()` 触发批量预取

**修改文件**：`src/components/FoldersOverview.tsx`

- 同理，提取 FolderCard 的 `coverImageMediaStoreId` 列表

#### 步骤 6：修改 `getThumbnail` 的 Android 路径

**修改文件**：`src/api/tauri-bridge.ts`

- `getThumbnail` 的 Android 分支：先检查 LRU 缓存（已有），缓存命中则直接返回
- 缓存未命中时，如果批量预取结果已到达（通过 `thumbnailPrefetcher` 的结果写入 LRU），则从 LRU 获取
- 如果 LRU 仍未命中，走原有的单次 `android_get_thumbnail` 调用（作为兜底）

### 3.3 性能预期

| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| JNI 调用次数（50 张图） | 50 × 6-8 = 300-400 次 | 1 次（Kotlin 批量） |
| 缩略图获取延迟 | 逐个串行获取 | 批量并行，预取到缓冲区 |
| 快速滑动时的卡顿 | 每帧都有 JNI 开销 | 预取命中时零 JNI 开销 |

### 3.4 修改文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/gen/android/.../MainActivity.kt` | 修改 | 新增 `batchGetThumbnailPaths()` 方法 |
| `src-tauri/src/android/media_store.rs` | 修改 | 新增 `batch_get_system_thumbnails()` JNI 封装 |
| `src-tauri/src/lib.rs` | 修改 | 新增 `android_batch_get_thumbnails` 命令 |
| `src/utils/thumbnailPrefetch.ts` | **新建** | 批量预取调度器 |
| `src/api/tauri-bridge.ts` | 修改 | `getThumbnail` Android 路径集成预取结果 |
| `src/components/FileGrid.tsx` | 修改 | 集成预取调度 |
| `src/components/FoldersOverview.tsx` | 修改 | 集成预取调度 |

---

## 实施顺序

三个优化存在依赖关系，建议按以下顺序实施：

1. **优化二（内存压力感知）** → 先建立内存监控基础设施，为后续 ImageBitmap 的生命周期管理提供支撑
2. **优化一（Web Worker 解码）** → 引入 ImageBitmap 后，需要依赖内存监控来管理位图资源
3. **优化三（批量预取）** → 独立性最强，可与优化一/二并行，但建议最后实施以避免同时引入过多变量

---

## 风险与缓解

| 风险 | 缓解措施 |
|------|---------|
| `createImageBitmap` 在某些 Android WebView 版本不支持 | 运行时检测，不支持时自动回退到 `<img>` |
| `performance.memory` 是非标准 API | 仅在 Android 平台使用，不可用时禁用动态缩放 |
| Canvas 渲染 ImageBitmap 的性能可能不如 `<img>` | 对比测试，如果 Canvas 更慢则改用 OffscreenCanvas 方案 |
| 批量预取可能获取用户不会看到的图片 | 仅预取视口缓冲区（1200px）内的图片，且预取结果写入 LRU 不影响渲染 |
| Kotlin 端批量获取缩略图可能阻塞主线程 | 在 Kotlin 端使用 `kotlinx.coroutines` 异步执行，或由 Rust 端 `spawn_blocking` 调用 |
| ImageBitmap 的 `close()` 时机难以精确控制 | 使用 `FinalizationRegistry` 作为兜底，同时组件卸载时主动 close |
