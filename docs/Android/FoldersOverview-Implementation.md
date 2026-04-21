# Android 文件夹总览视图 (Folders Overview) — 实现文档

## 概述

**功能名称**：Android 文件夹总览视图  
**实现日期**：2026-04-19  
**优化日期**：2026-04-20  
**目标**：让 Android 版启动时展示类似系统相册的文件夹网格界面，而非直接进入单一文件夹

---

## 一、问题背景

### 1.1 原有问题

| 问题 | 描述 |
|------|------|
| 启动进入单一文件夹 | Android 初始化后直接进入第一个根文件夹的 `browser` 视图，而非文件夹列表 |
| 启动时白屏 | `setIsLoading(false)` 在扫描完成前就执行，splash 提前消失 |
| 3D 文件夹图标 | `Folder3DIcon`（SVG + 3D 变换）在 Android 上渲染导致严重性能问题 |
| 无换行动画 | FoldersOverview 使用 CSS Grid，宽度变化时图标瞬间跳转 |
| 启动速度慢 | 每次启动全量扫描 20k+ 图片，耗时 3~6 秒才能看到主界面 |

### 1.2 性能数据

- 测试设备：Samsung Galaxy Tab S8+ (SM-X808U)
- 设备图片总数：**21,744 张**
- MediaStore JNI 调用次数：约 **15-20 万次**（每行 6-8 次）
- 优化前扫描耗时：3~6 秒（全量 JNI cursor 逐行读取）
- 优化后启动耗时：**< 100ms**（缓存加载）+ **~1.4s**（完整缓存加载）

---

## 二、架构变更

### 2.1 新增 viewMode 类型

```typescript
// types.ts
viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview' | 'folders-overview';
```

### 2.2 新增 FileNode 字段

```typescript
// types.ts - FileNode 接口
imageCount?: number;           // 文件夹内图片数量
coverImagePath?: string;       // 封面图片路径
coverImageMediaStoreId?: number; // 封面图片 MediaStore ID
```

### 2.3 虚拟根目录

Android 使用虚拟根目录 `__android_folders_root__` 作为 folders-overview 的 folderId：

```
folders-overview (folderId: __android_folders_root__)
    ├── 点击某文件夹 → browser (folderId: 实际文件夹ID)
    ├── 按 ↑ 返回 → folders-overview (folderId: __android_folders_root__)
    └── 按 ← 返回 → 不操作（已是最顶层）
```

---

## 三、修改文件清单

| 文件 | 修改类型 | 说明 |
|------|---------|------|
| `src/types.ts` | 修改 | 添加 `folders-overview` viewMode，扩展 FileNode |
| `src-tauri/src/android/media_store.rs` | 修改 | 文件夹扫描返回封面图片信息；新增 `scan_device_all` 合并扫描；新增 `scan_device_all_via_kotlin` Kotlin 聚合扫描 |
| `src/utils/androidPlatform.ts` | 修改 | 拆分扫描为文件夹优先 + 图片后台加载；分层缓存（文件夹缓存 + 完整缓存）；增量扫描支持 |
| `src/components/FoldersOverview.tsx` | **新增** | 文件夹总览组件（圆角矩形+渐变叠加文字） |
| `src/hooks/useAppInit.ts` | 修改 | Android 启动流程：缓存优先 → 文件夹即时显示 → 后台加载完整数据 → 增量扫描 |
| `src/hooks/useNavigation.ts` | 修改 | 支持 folders-overview 的导航/历史/新标签页 |
| `src/App.tsx` | 修改 | 渲染分支 + 返回导航逻辑；闪屏延迟从 500ms 减至 100ms |
| `src/components/TopBar.tsx` | 修改 | folders-overview 工具栏适配 |
| `src/components/FolderThumbnail.tsx` | 修改 | Android 上跳过 Folder3DIcon |
| `src/components/Folder3DIcon.tsx` | 修改 | Android 上降级为轻量占位符 |
| `src/shared/components/Thumbnails/Folder3DIcon.tsx` | 修改 | 同上（MetadataPanel 使用） |
| `src/components/FolderIcon.tsx` | 修改 | 同上（自带副本） |
| `src-tauri/src/lib.rs` | 修改 | 新增 `android_scan_all`、`android_save_scan_cache`、`android_load_scan_cache` 命令；添加性能计时 |
| `src-tauri/Cargo.toml` | 修改 | Android 依赖新增 `flate2`（gzip 压缩缓存） |
| `src-tauri/gen/android/.../MainActivity.kt` | 修改 | 新增 `scanAllAsJson()` Kotlin 聚合扫描方法；Android 原生闪屏 |
| `src-tauri/gen/android/.../build.gradle.kts` | 修改 | 新增 `core-splashscreen:1.0.1` 依赖 |
| `src-tauri/gen/android/.../AndroidManifest.xml` | 修改 | Activity 使用闪屏主题 |
| `src-tauri/gen/android/.../themes.xml` | 修改 | 新增 `Theme.aurora_gallery.Splash` 闪屏主题 |
| `src-tauri/gen/android/.../colors.xml` | 修改 | 新增 `splash_background` 颜色 |

---

## 四、Rust 后端：MediaStore 扫描优化

### 4.1 AndroidFolderInfo 结构体扩展

```rust
// src-tauri/src/android/media_store.rs
#[derive(Clone, Serialize, Deserialize)]
pub struct AndroidFolderInfo {
    pub id: i64,
    pub name: String,
    pub path: String,
    pub image_count: i32,
    pub cover_image_path: Option<String>,
    pub cover_image_id: Option<i64>,
}

#[derive(Clone, Serialize, Deserialize)]
pub struct AndroidScanAllResult {
    pub images: Vec<AndroidImageInfo>,
    pub folders: Vec<AndroidFolderInfo>,
}
```

### 4.2 scan_device_folders 改进

**之前**：
- 查询列：`bucket_id`, `bucket_display_name`, `_data`
- 排序：无
- 结果：仅聚合图片数量

**现在**：
- 查询列：`bucket_id`, `bucket_display_name`, `_data`, `_id`, `date_modified`
- 排序：`date_modified DESC`（最新图片优先）
- 结果：聚合数量 + 追踪每个 bucket 中最新图片作为封面

### 4.3 scan_device_all 合并扫描

将 `scan_device_folders` 和 `scan_device_images` 合并为一次 ContentProvider 查询：

```rust
pub fn scan_device_all<'a>(env: &mut JNIEnv<'a>, activity: &JObject<'a>) 
    -> Result<AndroidScanAllResult, String> 
{
    // 一次查询，projection 取两个的并集
    let projection = [
        "_id", "_data", "_display_name", "_size", 
        "width", "height", "date_modified", "mime_type",
        "bucket_id", "bucket_display_name",
    ];
    // 一次 cursor 遍历，同时填充 images vec 和 folders hashmap
}
```

### 4.4 scan_device_all_via_kotlin Kotlin 聚合扫描

通过 JNI 调用 Kotlin 端的 `scanAllAsJson()` 方法，将 26~32 万次 JNI 调用降为 2~3 次：

```rust
pub fn scan_device_all_via_kotlin<'a>(
    env: &mut JNIEnv<'a>, 
    activity: &JObject<'a>, 
    since_timestamp: i64
) -> Result<AndroidScanAllResult, String> {
    // 1 次 JNI 调用获取完整 JSON
    let json_str = env.call_method(
        activity, "scanAllAsJson", "(J)Ljava/lang/String;",
        &[JValue::Long(since_timestamp)],
    )?;
    // serde_json 解析 JSON 为 Rust 结构体
    let raw: serde_json::Value = serde_json::from_str(&json)?;
    // ...
}
```

`android_scan_all` 命令优先使用 Kotlin 方法，失败时自动回退到 JNI cursor 方式：

```rust
let result = match scan_device_all_via_kotlin(&mut env, &activity_obj, since) {
    Ok(r) => Ok(r),
    Err(e) => {
        log::warn!("Kotlin method failed ({}), falling back to JNI cursor", e);
        scan_device_all(&mut env, &activity_obj)
    }
};
```

### 4.5 parse_folder_cursor 封面追踪逻辑

```rust
struct FolderData {
    name: String,
    path: String,
    count: i32,
    cover_image_path: Option<String>,
    cover_image_id: Option<i64>,
    max_date_modified: i64,
}

// 遍历每一行时：
if date_modified > entry.max_date_modified {
    entry.max_date_modified = date_modified;
    entry.cover_image_path = Some(data_path.clone());
    entry.cover_image_id = image_id;
}
entry.count += 1;
```

---

## 五、前端：缓存优先 + 分层加载策略

### 5.1 androidPlatform.ts 导出函数

```typescript
// scanAndroidFolders() - 仅扫描文件夹（快速，~1-2秒）
// 返回：{ files, roots, rawFolders? }
// 每个 FileNode 包含：id, name, path, type:'folder', imageCount, coverImagePath, coverImageMediaStoreId

// scanAndroidImages(existingFolders?, sinceTimestamp?) - 完整扫描（慢速）
// 支持增量扫描：传入 sinceTimestamp 只查询新增图片
// 支持合并扫描：不传 existingFolders 时使用 android_scan_all 一次查询
// 返回：{ files, roots, rawFolders?, rawImages? }

// scanAndroidMedia() - 兼容性包装，内部调用 scanAndroidImages()

// loadFolderCache(appDataDir) - 加载文件夹快速缓存（~7-68ms）
// 返回：{ files, roots, cacheTimestamp? }

// loadScanCache(appDataDir) - 加载完整缓存（含图片，~980-1384ms）
// 返回：{ files, roots }

// saveScanCache(appDataDir, folders, images) - 保存分层缓存
// 同时保存 scan_cache_folders.json（仅文件夹）和 scan_cache.json（完整数据）
```

### 5.2 useAppInit.ts Android 启动流程（优化后）

```
应用启动
  │
  ├─ 检测 isAndroidPlatform()
  ├─ setState(settings)
  ├─ ensureAndroidPermission()     // 等待权限
  │
  ├─ loadFolderCache()              // 从本地缓存加载文件夹 (~45ms)
  │   └─ scan_cache_folders.json (gzip)
  │
  ├─ setState({ files, roots })     // 更新文件树（仅文件夹）
  ├─ setIsLoading(false)            // 关闭 splash
  ├─ setShowSplash(false)           // 显示主界面（文件夹已可见！）
  │
  └─ [异步] 后台加载
      ├─ loadScanCache()            // 加载完整缓存（含图片，~1.4s）
      │   └─ scan_cache.json (gzip)
      ├─ setState({ files, roots }) // 更新文件树（含图片子节点）
      │
      ├─ scanAndroidImages(incremental)  // 增量扫描（~43-69ms）
      │   └─ android_scan_all(sinceTimestamp=缓存时间戳)
      │       └─ Kotlin: WHERE date_modified > ?
      │
      ├─ if (有新图片):
      │   ├─ scanAndroidImages()         // 全量扫描（~1.9s，Kotlin 聚合）
      │   ├─ setState({ files, roots })  // 更新为最新数据
      │   └─ saveScanCache()             // 保存缓存（文件夹 + 完整）
      │
      └─ if (无新图片):
          └─ setState({ isScanning: false })  // 完成，无需更新
```

**关键点**：
1. `setShowSplash(false)` 在 `loadFolderCache()` 之后立即调用，用户 < 100ms 看到文件夹
2. `loadScanCache()` 在后台异步加载，让用户约 1.4 秒后可浏览图片
3. 增量扫描确认是否有新图片，无新图片时跳过全量扫描

### 5.3 默认 Tab 配置

```typescript
const defaultTab: TabState = {
  ...DUMMY_TAB,
  id: 'tab-default',
  folderId: '__android_folders_root__',
  viewMode: 'folders-overview',
};
defaultTab.history = {
  stack: [{
    folderId: '__android_folders_root__',
    viewingId: null,
    viewMode: 'folders-overview',
    searchQuery: '',
    searchScope: 'all',
    activeTags: [],
    activePersonId: null
  }],
  currentIndex: 0
};
```

### 5.4 分层缓存机制

```
缓存文件结构：
  {appDataDir}/
    ├── scan_cache_folders.json.gz   ← 文件夹快速缓存（~7-68ms 加载）
    │   └── FolderScanCache { version: 1, timestamp, folders[] }
    │
    └── scan_cache.json.gz           ← 完整数据缓存（~1.4s 加载）
        └── ScanCache { version: 2, timestamp, folders[], images[] }
```

- 文件夹缓存：仅包含 109 个文件夹对象，极小，启动时即时加载
- 完整缓存：包含 21,749 个图片对象，后台加载
- 两者均使用 gzip 快速压缩，减少磁盘占用
- 缓存版本号：`FOLDER_CACHE_VERSION = 1`，`SCAN_CACHE_VERSION = 2`
- 版本不匹配时自动忽略旧缓存，触发全量扫描重建

---

## 六、导航逻辑

### 6.1 handleNavigateUp（返回按钮）

```typescript
const handleNavigateUp = () => {
  if (activeTab.viewMode === 'folders-overview') {
    return;  // 已是最顶层，不操作
  }
  
  if (activeTab.viewMode === 'people-overview' || 
      activeTab.viewMode === 'tags-overview' || 
      activeTab.viewMode === 'topics-overview') {
    const isAndroid = resourceRoot === 'android_media_store';
    if (isAndroid) {
      pushHistory('__android_folders_root__', null, 'folders-overview');
    } else {
      enterFolder(activeTab.folderId);
    }
    return;
  }
  
  // browser 视图
  const current = state.files[activeTab.folderId];
  if (current && current.parentId) {
    enterFolder(current.parentId);
  } else {
    const isAndroid = resourceRoot === 'android_media_store';
    if (isAndroid) {
      pushHistory('__android_folders_root__', null, 'folders-overview');
    }
  }
};
```

### 6.2 goBack（浏览器后退）

使用历史堆栈机制。从 folders-overview 进入文件夹后按返回键，goBack 会恢复之前的 history 条目（folders-overview）。

### 6.3 handleNewTab（新标签页）

```typescript
const isAndroid = resourceRoot === 'android_media_store';
const folderId = isAndroid ? '__android_folders_root__' : roots[0];
const viewMode = isAndroid ? 'folders-overview' : 'browser';
```

---

## 七、FoldersOverview 组件

### 7.1 布局引擎

复用与 FileGrid 相同的 `useLayout` hook + Web Worker 绝对定位布局：

```tsx
// ResizeObserver 监听容器宽度变化
<ResizeObserver onResize={setContainerWidth} />

// useLayout Web Worker 计算每个项目的绝对位置
const { layout, totalHeight } = useLayout(
  sortedFolderIds, files, 'grid', containerWidth, thumbnailSize, 'browser'
);

// 渲染：position: absolute + CSS transition 实现平滑换行
<div style={{ position: relative, height: totalHeight }}>
  {sortedFolderIds.map(id => (
    <div className="absolute transition-all duration-300 ease-out"
         style={{ left: pos.x, top: pos.y, width: pos.width, height: pos.height }}>
      <FolderCard />
    </div>
  ))}
</div>
```

### 7.2 FolderCard 样式

采用**圆角矩形 + 底部渐变叠加文字**样式：

```
┌─────────────────────┐
│                     │
│   [封面图 / 占位符]  │  rounded-lg, overflow-hidden
│                     │
│ ░░░░░░░░░░░░░░░░░░░│  bg-gradient-to-t from-black/70 via-black/30 to-transparent
│ ▎ 文件夹名称        │  text-white text-xs font-medium
│ ▎ 1234 项            │  text-white/70 text-[10px]
└─────────────────────┘
```

### 7.3 封面图片加载策略

- 使用 `useInView`（rootMargin: 200px）仅在可见区域附近加载
- 优先检查内存缓存 (`getGlobalCache`)
- 缓存未命中则调用 `getThumbnail(resourceRoot, mediaStoreId)`
- 无封面时显示轻量占位符（CSS 渐变 + lucide-react Folder 图标）

### 7.4 缩略图升级事件监听

当低质量缩略图（MINI_KIND < 200px）在后台升级为高质量缩略图后，`FolderCard` 需要自动更新显示：

#### 7.4.1 upgrading 状态追踪

```tsx
const [upgrading, setUpgrading] = useState(false);
const coverImagePathRef = useRef(folder.coverImagePath);
coverImagePathRef.current = folder.coverImagePath;
```

加载缩略图时，通过 `isThumbnailUpgrading()` 检测是否正在升级：

```tsx
const url = await getThumbnail(...);
if (url) {
  setCoverSrc(url);
  if (isThumbnailUpgrading(folder.coverImagePath)) {
    setUpgrading(true);  // 标记为升级中
  }
}
```

#### 7.4.2 监听 DOM 事件

```tsx
useEffect(() => {
  const handler = (e: Event) => {
    const { filePath, thumbnailSrc } = (e as CustomEvent).detail;
    if (filePath === coverImagePathRef.current) {
      setCoverSrc(thumbnailSrc);  // 更新为高质量缩略图
      setUpgrading(false);
    }
  };
  const failHandler = (e: Event) => {
    const { filePath } = (e as CustomEvent).detail;
    if (filePath === coverImagePathRef.current) {
      setUpgrading(false);
    }
  };
  window.addEventListener('aurora:thumbnail-upgraded', handler);
  window.addEventListener('aurora:thumbnail-upgrade-failed', failHandler);
  return () => {
    window.removeEventListener('aurora:thumbnail-upgraded', handler);
    window.removeEventListener('aurora:thumbnail-upgrade-failed', failHandler);
  };
}, []);
```

#### 7.4.3 升级中过渡效果

```tsx
{upgrading && (
  <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-10 rounded-lg">
    <svg className="animate-spin h-5 w-5 text-white/70" ...>...</svg>
  </div>
)}
```

#### 7.4.4 re-request 安全网

当事件丢失时，5 秒后自动重新请求缩略图（最多重试 3 次）：

```tsx
useEffect(() => {
  if (!upgrading || !folder.coverImagePath || !resourceRoot) return;
  let cancelled = false;
  let retryCount = 0;
  const maxRetries = 3;
  const retryDelay = 5000;
  const checkUpgrade = async () => {
    if (cancelled || retryCount >= maxRetries) return;
    retryCount++;
    await new Promise<void>(resolve => setTimeout(resolve, retryDelay));
    if (cancelled) return;
    const thumbnail = await getThumbnail(...);
    if (thumbnail && !isThumbnailUpgrading(...)) {
      setCoverSrc(thumbnail);
      setUpgrading(false);
    } else if (isThumbnailUpgrading(...)) {
      checkUpgrade();
    }
  };
  checkUpgrade();
  return () => { cancelled = true; };
}, [upgrading, folder.coverImagePath, ...]);
```

#### 7.4.5 完整升级流程

```
FolderCard 加载封面
  │
  ├─ getThumbnail() 返回 upgrading: true
  │   ├─ 显示模糊 MINI_KIND 缩略图
  │   ├─ 设置 upgrading=true → 显示 spinner 遮罩
  │   └─ 启动 re-request 安全网
  │
  ├─ [事件] aurora:thumbnail-upgraded
  │   ├─ 更新 coverSrc 为高质量缩略图
  │   └─ 设置 upgrading=false → 移除 spinner
  │
  └─ [事件] aurora:thumbnail-upgrade-failed
      └─ 设置 upgrading=false → 移除 spinner
```

---

## 八、Android 性能优化：Folder3DIcon 替代

### 8.1 问题根因

项目中有 **3 个独立的 Folder3DIcon 实现**：

| 文件 | 使用者 |
|------|--------|
| `src/components/Folder3DIcon.tsx` | FileGrid → FolderThumbnail |
| `src/shared/components/Thumbnails/Folder3DIcon.tsx` | MetadataPanel, shared/FolderThumbnail |
| `src/components/FolderIcon.tsx`（内嵌） | OptimizedFolderThumbnail |

每个都包含：
- SVG 3D 透视变换路径（~100 行 SVG）
- 最多 3 张预览图的绝对定位 + 旋转动画
- `findImagesDeeply()` DFS 遍历（最多 500 节点）

21,744 张图片的设备上快速滚动时，大量 Folder3DIcon 同时渲染导致帧率暴跌甚至卡死。

### 8.2 解决方案：三处同步添加 Android 检测

```typescript
function isAndroid(): boolean {
  try {
    if ((window as any).__TAURI_INTERNALS?.platform === 'android') return true;
    return /android/i.test(navigator.userAgent);
  } catch { return false; }
}
const _isAndroid = isAndroid();

export const Folder3DIcon = memo(({ ... }) => {
  if (_isAndroid) {
    return <AndroidLightweightIcon />;
  }
  // ... 完整的 3D SVG + 预览图逻辑 ...
});
```

**AndroidLightweightIcon**：
- 纯 CSS 渐变背景（`bg-gradient-to-br from-gray-50 to-gray-200`）
- lucide-react `<Folder>` SVG 图标（零计算开销）
- 可选显示图片数量标签

### 8.3 FolderThumbnail 双重保护

除了 Folder3DIcon 自身的检测外，`FolderThumbnail.tsx` 也添加了基于 `resourceRoot` 的前置拦截：

```typescript
export const FolderThumbnail = React.memo(({ resourceRoot, ... }) => {
  const isAndroid = resourceRoot === 'android_media_store';
  
  if (isAndroid) {
    return <AndroidFolderPlaceholder />;
  }
  // ... 桌面端完整逻辑 ...
});
```

---

## 九、Android 启动速度优化

### 9.1 优化前问题

| 问题 | 描述 |
|------|------|
| 全量扫描阻塞启动 | 每次启动都全量扫描 21,749 张图片，耗时 5~8 秒 |
| 冗余扫描 | `scanAndroidImages()` 内部重复调用 `android_scan_folders`，全表扫描执行 3 次 |
| 人为延迟 | 多处 `setTimeout(300~500ms)` 延迟关闭闪屏 |
| 无缓存 | 每次启动重新扫描，即使数据没有变化 |
| JNI 开销大 | Rust 通过 JNI 逐行读取 Cursor，20k 行 × 12~15 次/行 = 26~32 万次 JNI 调用 |
| 权限超时过长 | `waitForAndroidPermission()` 超时 10 秒 + 5 次轮询 × 1 秒 |

### 9.2 优化措施

#### 9.2.1 Kotlin 端聚合扫描（减少 JNI 调用）

在 `MainActivity.kt` 中新增 `scanAllAsJson(sinceTimestamp: Long)` 方法：

```kotlin
fun scanAllAsJson(sinceTimestamp: Long): String {
    val uri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
    val projection = arrayOf(
        MediaStore.Images.Media._ID,
        MediaStore.Images.Media.DATA,
        // ... 10 列
    )
    // 增量查询支持
    var selection: String? = null
    var selectionArgs: Array<String>? = null
    if (sinceTimestamp > 0) {
        selection = "${MediaStore.Images.Media.DATE_MODIFIED} > ?"
        selectionArgs = arrayOf(sinceTimestamp.toString())
    }
    // 在 Kotlin 层完成 Cursor 遍历 + 文件夹聚合
    // 返回 JSON 字符串给 Rust
}
```

Rust 端只需 1 次 JNI 调用获取完整 JSON，然后 `serde_json::parse`。

**收益**：JNI 调用从 26~32 万次降到 2~3 次，后台扫描从 5 秒降到 ~1.9 秒。

#### 9.2.2 增量/差异扫描

`android_scan_all` 命令支持 `since_timestamp` 参数：

```rust
#[tauri::command]
async fn android_scan_all(since_timestamp: Option<i64>) -> Result<AndroidScanAllResult, String>
```

Kotlin 端使用 `WHERE date_modified > ?` 过滤，只返回新增/修改的图片。

**收益**：日常启动时后台扫描从 5 秒降到 **< 100ms**（无新图片时）。

#### 9.2.3 分层缓存

| 缓存文件 | 内容 | 加载时间 | 用途 |
|----------|------|---------|------|
| `scan_cache_folders.json.gz` | 仅 109 个文件夹 | ~45ms | 启动时即时显示文件夹总览 |
| `scan_cache.json.gz` | 109 文件夹 + 21,749 图片 | ~1.4s | 后台加载，让用户可浏览图片 |

缓存使用 gzip 快速压缩，版本号控制（`FOLDER_CACHE_VERSION = 1`，`SCAN_CACHE_VERSION = 2`），版本不匹配时自动重建。

#### 9.2.4 消除冗余扫描

- `scanAndroidImages()` 不再内部重复调用 `android_scan_folders`
- 使用 `android_scan_all` 合并命令，一次查询同时获取文件夹和图片
- ContentProvider 查询从 2 次降为 1 次

#### 9.2.5 移除人为延迟

- Android 路径下 `setTimeout(300~500ms)` 全部改为直接调用
- `App.tsx` 兜底延迟从 500ms 减至 100ms

#### 9.2.6 优化权限检查流程

- `waitForAndroidPermission()` 超时从 10 秒缩短到 3 秒
- 轮询从 5 次 × 1 秒改为 2 次 × 0.5 秒

#### 9.2.7 Android 原生闪屏

使用 `androidx.core:core-splashscreen:1.0.1`：

```xml
<!-- themes.xml -->
<style name="Theme.aurora_gallery.Splash" parent="Theme.SplashScreen">
    <item name="windowSplashScreenBackground">@color/splash_background</item>
    <item name="windowSplashScreenAnimatedIcon">@mipmap/ic_launcher</item>
    <item name="postSplashScreenTheme">@style/Theme.aurora_gallery</item>
</style>
```

```kotlin
// MainActivity.kt
override fun onCreate(savedInstanceState: Bundle?) {
    val splashScreen = installSplashScreen()
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    splashScreen.setKeepOnScreenCondition { false }
    // ...
}
```

**收益**：用户点击图标 → 立即看到深色背景 + Aurora 图标 → WebView 加载完成后无缝过渡到主界面。

### 9.3 优化效果

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 首次启动 | 5~10 秒 | **1~2 秒** |
| 非首次启动（有缓存） | 3~6 秒 | **< 0.1 秒**（文件夹可见）→ **~1.4 秒**（图片可浏览） |
| 后台扫描（无新图片） | 5~8 秒 | **< 0.1 秒**（增量扫描） |
| 后台扫描（有新图片） | 5~8 秒 | **~1.9 秒**（Kotlin 聚合） |

---

## 十、Tauri 命令列表

| 命令 | 参数 | 返回值 | 说明 |
|------|------|-------|------|
| `android_scan_images` | 无 | `Vec<AndroidImageInfo>` | 扫描全部图片（JNI cursor 方式，保留作 fallback） |
| `android_scan_folders` | 无 | `Vec<AndroidFolderInfo>` | 扫描全部文件夹 |
| `android_scan_all` | `since_timestamp?: i64` | `AndroidScanAllResult` | 合并扫描（优先 Kotlin 聚合，回退 JNI cursor）；支持增量扫描 |
| `android_save_scan_cache` | `appDataDir, data, cache_type?` | `()` | 保存缓存（`cache_type: "folders"` 或 `"full"`），gzip 压缩 |
| `android_load_scan_cache` | `appDataDir, cache_type?` | `String` | 加载缓存，gzip 解压 |
| `android_get_thumbnail` | filePath, cacheRoot, imageId? | `ThumbnailResult` | 获取缩略图 |
| `check_android_permissions` | 无 | `String` | 检查权限状态 |
| `request_android_permissions` | 无 | `String` | 请求权限 |
| `get_default_paths` | 无 | `HashMap<String, String>` | 获取默认路径 |

---

## 十一、开发调试指南

### 11.1 构建命令

```bash
# 开发模式
npm run build          # 确保 dist 存在
npx tauri android dev   # 连接设备调试

# 构建 APK
npx tauri android build
```

### 11.2 Chrome DevTools 远程调试

```bash
# 电脑 Chrome 打开
chrome://inspect
# 找到设备的 WebView → inspect
```

### 11.3 关键日志标记

| 日志前缀 | 含义 |
|----------|------|
| `[Perf] loadFolderCache` | 文件夹缓存加载耗时 |
| `[Perf] loadScanCache` | 完整缓存加载耗时 |
| `[Perf] scanAndroidImages` | 图片扫描耗时（含模式标识） |
| `[Perf] scanAndroidFolders` | 文件夹扫描耗时 |
| `[Thumbnail] Android invoke` | 缩略图请求发出 |
| `[Thumbnail] Android result` | 缩略图结果返回 |
| `[Thumbnail] Upgrade` | 缩略图升级缓存更新 |
| `[FolderCard] aurora:thumbnail-upgraded` | FolderCard 收到缩略图升级事件 |
| `[Android] Scan cache saved` | 缓存保存成功 |
| `android_scan_all: found N images` | 全量扫描完成（Rust 日志） |
| `android_scan_all (incremental)` | 增量扫描完成（Rust 日志） |

### 11.4 常见问题排查

| 现象 | 可能原因 | 排查方法 |
|------|---------|---------|
| 白屏/splash 不消失 | dist 为空或编译错误 | `npm run build` |
| 蓝色 3D 文件夹仍出现 | Folder3DIcon 未修改 | 检查 3 个副本是否都已修改 |
| 进入文件夹后显示"无文件" | 完整缓存未加载或增量扫描覆盖 | 检查 `loadScanCache` 是否在增量扫描前执行 |
| 进入文件夹后返回空白 | history stack 异常 | Chrome DevTools Console |
| 换行无动画 | containerWidth 未更新 | 检查 ResizeObserver 是否触发 |
| 编译错误 dist 缺失 | `tauri::generate_context!()` 需要 dist | `npm run build` |
| 增量扫描返回全量数据 | 时间戳转换错误 | 检查 `sinceTimestamp` 是否为秒级（非毫秒） |
| Kotlin 方法调用失败 | `scanAllAsJson` 未添加 | 检查 MainActivity.kt 是否包含新方法 |

---

**文档版本**: 2.1  
**创建日期**: 2026-04-19  
**更新日期**: 2026-04-22  
**维护者**: Aurora Gallery Team
