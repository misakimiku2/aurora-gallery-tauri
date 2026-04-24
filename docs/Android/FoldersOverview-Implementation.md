# Android 文件夹总览视图 (Folders Overview) — 实现文档

## 概述

**功能名称**：Android 文件夹总览视图  
**实现日期**：2026-04-19  
**优化日期**：2026-04-23  
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
| `src/api/tauri-bridge.ts` | 修改 | 新增全局滚动状态管理 API（setGlobalScrollState / subscribeScrollState） |
| `src/hooks/useFileSearch.ts` | 修改 | Android 端移除 1000 张分页限制 |
| `src/hooks/useAppInit.ts` | 修改 | Android 启动流程：缓存优先 → 文件夹即时显示 → 后台加载完整数据 → 增量扫描 |
| `src/hooks/useNavigation.ts` | 修改 | 支持 folders-overview 的导航/历史/新标签页 |
| `src/App.tsx` | 修改 | 渲染分支 + 返回导航逻辑；闪屏延迟从 500ms 减至 100ms |
| `src/components/TopBar.tsx` | 修改 | folders-overview 工具栏适配 |
| `src/components/FolderThumbnail.tsx` | 修改 | Android 上跳过 Folder3DIcon；新增滚动状态感知，滚动时隐藏升级 Spinner |
| `src/components/Folder3DIcon.tsx` | 修改 | Android 上降级为轻量占位符 |
| `src/shared/components/Thumbnails/Folder3DIcon.tsx` | 修改 | 同上（MetadataPanel 使用） |
| `src/components/FolderIcon.tsx` | 修改 | 同上（自带副本） |
| `src-tauri/src/lib.rs` | 修改 | 新增 `android_scan_all`、`android_save_scan_cache`、`android_load_scan_cache` 命令；缩略图升级队列从 FIFO 改为 LIFO；添加性能计时 |
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

Spinner 仅在滚动完全停止（`idle`）时显示，滚动中隐藏以避免 DOM 重绘掉帧：

```tsx
{upgrading && (scrollState === 'idle' || !isAndroid) && (
  <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-10 rounded-lg">
    <svg className="animate-spin h-5 w-5 text-white/70" ...>...</svg>
  </div>
)}
```

> **注意**：此条件在 2026-04-23 更新中从 `!isFastScrolling` 改为 `scrollState === 'idle' || !isAndroid`。
> 原因：在 `scrolling`（慢速滚动）状态下 `animate-spin` 仍会触发 DOM 重绘导致掉帧，
> 且 MINI_KIND → 深色遮罩 → 高质量缩略图的视觉切换会导致闪烁。

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

### 7.5 文件夹卡片样式调整（2026-04-22）

#### 7.5.1 样式变更

**之前**：文件夹名在圆角矩形内部底部，图标在左下角（描边样式）

```
┌──────────────────────┐
│                      │
│     [cover image]    │
│                      │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │  ← 渐变遮罩
│  📁 文件夹名  42 项  │  ← 文字在内部
└──────────────────────┘
```

**之后**：文件夹名移到圆角矩形下方，图标移到右下角（填充样式）

```
┌──────────────────────┐
│                      │
│     [cover image]    │
│                      │
│  ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓ │  ← 渐变遮罩（纯装饰）
│                  📁  │  ← 填充图标，右下角
│                 [42] │  ← 胶囊数量
└──────────────────────┘
  文件夹名              ← 移到外部下方
```

#### 7.5.2 关键代码变更

**FolderCard 外层容器**：

```tsx
// 添加 items-center 居中 + px-1 左右内边距
<div className="file-item group cursor-pointer select-none flex flex-col items-center px-1">
```

**文件夹图标（填充 SVG）**：

```tsx
// 右下角定位，填充样式
<div className="absolute bottom-2 right-2 z-20 flex flex-col items-end gap-1">
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" className="text-blue-400 drop-shadow-sm">
    <path d="M2 6a2 2 0 012-2h5l2 2h9a2 2 0 012 2v10a2 2 0 01-2 2H4a2 2 0 01-2-2V6z"/>
  </svg>
  {imageCount > 0 && (
    <span className="bg-black/30 text-white text-[9px] font-bold px-1.5 py-0.5 rounded-full backdrop-blur-sm shadow-sm leading-none">
      {imageCount}
    </span>
  )}
</div>
```

**文件夹名（移到外部）**：

```tsx
<div className="mt-1 w-full text-center px-1">
  <div className="text-xs font-semibold text-gray-700 dark:text-gray-300 truncate leading-tight" title={folder.name}>
    {folder.name}
  </div>
</div>
```

### 7.6 布局间距优化（2026-04-22）

#### 7.6.1 Worker 间距参数

`folders-overview` 使用独立的间距参数，比 `browser` 模式更紧凑：

| 参数 | browser 模式 | folders-overview | 说明 |
|------|-------------|------------------|------|
| `GAP` | 16px | **10px** (`FOLDER_GAP`) | 项目间距 |
| `TEXT_HEIGHT` | 40px | **28px** (`FOLDER_TEXT_HEIGHT`) | 底部文字区域高度 |

```typescript
// layout.worker.ts
} else if (viewMode === 'folders-overview') {
    const FOLDER_GAP = 10;
    const FOLDER_TEXT_HEIGHT = 28;
    // ...
}
```

#### 7.6.2 容器 padding 统一

**问题**：容器 CSS padding 与 Worker PADDING 不匹配导致布局不对称

| 层级 | 之前 | 之后 |
|------|------|------|
| 容器 CSS | `p-6` (24px) | **无 padding** |
| Worker PADDING | 24px | 24px（不变） |

移除容器 padding，让 Worker 的 `PADDING=24` 成为唯一的边距来源，确保左右对称。

#### 7.6.3 滚动条隐藏

Android WebView 中 `overflow-y-auto` 即使隐藏滚动条视觉，仍会保留滚动条空间（~18px）。需要强制隐藏：

```tsx
<div
  id="folders-scroll"
  className="w-full h-full overflow-y-auto overflow-x-hidden relative"
  style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}
>
  <style dangerouslySetInnerHTML={{ __html: '#folders-scroll::-webkit-scrollbar{display:none;width:0!important;height:0!important}' }} />
  {/* ... */}
</div>
```

#### 7.6.4 thumbnailSize 计算修正

**问题**：`thumbnailSize = pos.width - 8` 导致圆角矩形比容器窄 8px，间隙全堆在右侧

**修复**：

```tsx
// 之前
thumbnailSize={Math.min(pos.width - 8, pos.height - 40)}

// 之后：减少差值，配合外层 px-1 居中
thumbnailSize={Math.min(pos.width - 2, pos.height - 28)}
```

配合 `items-center px-1`，圆角矩形居中显示，左右间距对称。

### 7.7 移除 Loading 指示器（2026-04-22）

移除了主界面顶部的 "loading images..." 指示器，因为文件夹缓存加载极快（~45ms），用户无需等待提示。

```tsx
// 已移除
{isLoadingImages && (
  <div className="flex items-center gap-2 px-2 mb-3 text-xs text-gray-500">
    <Loader2 size={14} className="animate-spin" />
    <span>{t('loading.images')}</span>
  </div>
)}
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

## 十、Android 虚拟滚动优化（2026-04-23）

### 10.1 问题背景

| 问题 | 描述 |
|------|------|
| 快速滚动空白 | 滚动时底部内容出现完全空白区域，之后才出现占位符和缩略图 |
| 占位符闪烁 | 停止滚动后，纯色占位符闪烁多次才出现缩略图 |
| 升级遮罩闪烁 | MINI_KIND → 深色遮罩+Spinner → 高质量缩略图，视觉上频繁切换 |
| 滚动掉帧 | `animate-spin` SVG 动画在滚动中触发频繁 DOM 重绘 |
| 分页限制 | 桌面端 1000 张分页限制不合理，移动端相册无此限制 |
| FIFO 队列 | 缩略图升级按滚动顺序排队，用户停留页的图片不是最先升级 |

### 10.2 全局滚动状态管理

#### 10.2.1 API 设计（tauri-bridge.ts）

```typescript
type ScrollState = 'idle' | 'scrolling' | 'fast';

let _globalScrollState: ScrollState = 'idle';
const _scrollStateListeners = new Set<(state: ScrollState) => void>();

export function setGlobalScrollState(state: ScrollState) {
  if (_globalScrollState === state) return;
  _globalScrollState = state;
  for (const listener of _scrollStateListeners) {
    try { listener(state); } catch {}
  }
}

export function getGlobalScrollState(): ScrollState {
  return _globalScrollState;
}

export function subscribeScrollState(listener: (state: ScrollState) => void): () => void {
  _scrollStateListeners.add(listener);
  return () => { _scrollStateListeners.delete(listener); };
}
```

**设计要点**：
- 全局单例，避免 prop drilling
- 发布/订阅模式，组件自行订阅，无需父组件传递
- `setGlobalScrollState` 内部去重（state 未变化时不通知）

#### 10.2.2 滚动速度检测（FileGrid.tsx / FoldersOverview.tsx）

在容器的 `scroll` 事件处理器中，通过 `dy/dt` 计算滚动速度：

```typescript
const handleScroll = () => {
  const now = Date.now();
  const dt = now - lastScrollTimeRef.current;
  const dy = Math.abs(currentScroll - lastScrollTopRef.current);
  lastScrollTimeRef.current = now;
  lastScrollTopRef.current = currentScroll;

  if (isAndroid && dt > 0) {
    const velocity = dy / dt;
    if (velocity > 3 || dt < 32) {
      setGlobalScrollState('fast');
    } else if (velocity > 0.5 || dt < 150) {
      setGlobalScrollState('scrolling');
    } else {
      setGlobalScrollState('idle');
    }

    // 300ms 无滚动事件后自动归位为 idle
    if (scrollStateTimerRef.current) clearTimeout(scrollStateTimerRef.current);
    scrollStateTimerRef.current = setTimeout(() => {
      setGlobalScrollState('idle');
    }, 300);
  }
};
```

**速度阈值说明**：

| 状态 | 条件 | 含义 |
|------|------|------|
| `fast` | `velocity > 3` 或 `dt < 32ms` | 快速滚动（每帧滚动距离大，或事件间隔极短） |
| `scrolling` | `velocity > 0.5` 或 `dt < 150ms` | 慢速滚动（仍在移动但速度不快） |
| `idle` | 其余情况 + 300ms 超时 | 滚动停止 |

### 10.3 滚动状态感知的缩略图加载

#### 10.3.1 ImageThumbnail 加载策略

```typescript
// 订阅全局滚动状态
const [scrollState, setScrollState] = useState(getGlobalScrollState());
useEffect(() => {
  if (!isAndroid) return;
  return subscribeScrollState(setScrollState);
}, [isAndroid]);

// 加载逻辑：根据滚动状态决定是否加载
useEffect(() => {
  // 快速滚动时完全跳过加载
  if (isAndroid && scrollState === 'fast') return;

  const loadThumbnail = async () => { /* ... */ };

  // 慢速滚动时延迟 200ms（冷却期）
  if (isAndroid && scrollState === 'scrolling') {
    const timer = setTimeout(loadThumbnail, 200);
    return () => { clearTimeout(timer); controller.abort(); };
  }

  // 空闲时立即加载
  loadThumbnail();
}, [filePath, isInView, wasInView, isAndroid, scrollState, ...]);
```

**策略矩阵**：

| 滚动状态 | 加载行为 | 升级 Spinner | 说明 |
|----------|---------|-------------|------|
| `fast` | 跳过 | 隐藏 | 避免瞬间堆积大量加载任务 |
| `scrolling` | 延迟 200ms | 隐藏 | 冷却期：图片在视口停留 200ms+ 才加载 |
| `idle` | 立即 | 显示 | 滚动停止后正常加载和显示升级进度 |

#### 10.3.2 占位符策略

**之前**：纯色方块占位符，停止滚动后闪烁多次才出现缩略图

**之后**：使用 lucide-react `ImageIcon` 作为占位符，无 `loading` 状态过渡

```tsx
// 渲染逻辑：scrollState 只影响加载行为，不影响显示内容
const finalSrc = animSrc || thumbnailSrc;

return (
  <div ref={ref} className="w-full h-full relative overflow-hidden">
    <div className="absolute inset-0 bg-gray-100 dark:bg-gray-800 pointer-events-none">
      {finalSrc ? (
        <img src={finalSrc} alt={alt} className="absolute inset-0 w-full h-full object-cover"
             loading="eager" draggable="false" />
      ) : (
        <div className="w-full h-full flex items-center justify-center">
          <ImageIcon className="w-6 h-6 text-gray-400 dark:text-gray-600" />
        </div>
      )}
    </div>
    {upgrading && finalSrc && (scrollState === 'idle' || !isAndroid) && (
      <div className="absolute inset-0 bg-black/40 flex items-center justify-center z-10">
        <svg className="animate-spin h-6 w-6 text-white/80" .../>
      </div>
    )}
  </div>
);
```

**关键设计**：
- 移除了 `loading` 状态，避免 纯色 → loading占位符 → 缩略图 的多次视觉切换
- `scrollState` 只控制**是否发起加载**和**是否显示 Spinner**，不控制**显示什么内容**
- 始终只显示两种状态：有缩略图 → 显示图片，无缩略图 → 显示 ImageIcon

#### 10.3.3 FolderThumbnail 滚动状态感知

FolderThumbnail（3D 文件夹封面）同样订阅全局滚动状态：

```typescript
const [scrollState, setScrollState] = useState(getGlobalScrollState());
useEffect(() => {
  if (!isAndroid) return;
  return subscribeScrollState(setScrollState);
}, [isAndroid]);
```

升级 Spinner 同样仅在 `idle` 时显示：

```tsx
{hasUpgrading && (scrollState === 'idle' || !isAndroid) && (
  <div className="absolute inset-0 bg-black/30 ...">
    <svg className="animate-spin ..." />
  </div>
)}
```

#### 10.3.4 FoldersOverview FolderCard 滚动状态感知

主界面的 FolderCard 使用相同的模式：

```tsx
{upgrading && (scrollState === 'idle' || !isAndroid) && (
  <div className="absolute inset-0 bg-black/30 ...">
    <svg className="animate-spin ..." />
  </div>
)}
```

### 10.4 虚拟滚动缓冲区优化

#### 10.4.1 可见区域缓冲区

从固定 400px 改为动态计算，确保快速滚动时有足够的预渲染区域：

```typescript
// FileGrid.tsx / FoldersOverview.tsx / GroupContent
const buffer = Math.max(1200, containerHeight * 2);
const minY = scrollTop - buffer;
const maxY = scrollTop + containerHeight + buffer;
return layout.filter(item => item.y < maxY && item.y + item.height > minY);
```

#### 10.4.2 useInView rootMargin

所有缩略图组件的 `useInView` rootMargin 从 400px 增加到 1200px：

```typescript
// ImageThumbnail, FolderThumbnail, FolderIcon, shared/ImageThumbnail, shared/FolderThumbnail
const [ref, isInView, wasInView] = useInView({ rootMargin: '1200px' });
```

### 10.5 content-visibility 策略变更

#### 10.5.1 初始引入

最初为 FileGrid 和 FoldersOverview 的卡片容器添加了 `content-visibility: auto` + `contain-intrinsic-size`，让浏览器跳过视口外节点的布局计算。

#### 10.5.2 Android 端移除

**问题**：`content-visibility: auto` 在 Android WebView 上导致快速滚动时出现空白区域。原因是浏览器将视口外节点的渲染完全跳过，当节点快速进入视口时需要先"激活"才能渲染，造成短暂空白。而虚拟滚动已经通过 `visibleItems` 过滤限制了渲染数量，`content-visibility` 变得多余且有害。

**当前策略**：仅桌面端保留 `content-visibility: auto`，Android 端移除：

```tsx
// FileGrid.tsx - FileCard
style={{
  position: 'absolute',
  left: `${x}px`, top: `${y}px`,
  width: `${width}px`, height: `${height}px`,
  willChange: 'transform',
  ...(!isAndroid && {
    contentVisibility: 'auto' as const,
    containIntrinsicSize: `${width}px ${height}px`
  })
}}

// FoldersOverview.tsx - 同理
style={{
  left: pos.x, top: pos.y,
  width: pos.width, height: pos.height,
  ...(!isAndroid && {
    contentVisibility: 'auto' as const,
    containIntrinsicSize: `${pos.width}px ${pos.height}px`
  })
}}
```

### 10.6 Rust 缩略图升级队列：FIFO → LIFO

#### 10.6.1 问题

缩略图升级任务按 FIFO（先进先出）顺序处理。用户快速滚动过 100 张图后停留在某页，该页的图片排在队列末尾，需要等待前面所有任务完成才能升级。

#### 10.6.2 修复

将 `VecDeque::pop_front()` 改为 `VecDeque::pop_back()`：

```rust
// src-tauri/src/lib.rs - thumbnail_worker
let job = {
    let mut queue = THUMBNAIL_QUEUE.lock().unwrap();
    queue.pop_back()  // LIFO：最后入队的任务最先处理
};
```

**效果**：用户最后滚动到的页面的缩略图升级任务最后入队，但最先被处理。

### 10.7 Android 端移除分页限制

#### 10.7.1 问题

桌面端限制单页显示 1000 张图片，超出后分页。移动端相册应用无此限制，8000+ 图片也能流畅滚动。

#### 10.7.2 修复

```typescript
// useFileSearch.ts
const isAndroid = state.settings.paths.resourceRoot === 'android_media_store';
const pageSize = isAndroid ? allMatchingFileIds.length : 1000;

const displayFileIds = useMemo(() => {
  if (isAndroid) return allMatchingFileIds;  // Android：显示全部
  const start = (currentPage - 1) * pageSize;
  return allMatchingFileIds.slice(start, start + pageSize);  // 桌面：分页
}, [allMatchingFileIds, currentPage, isAndroid, pageSize]);
```

### 10.8 Android UI 调整

#### 10.8.1 移除面包屑导航

进入文件夹后，顶部工具栏下方的信息栏（显示文件夹路径）在 Android 端隐藏：

```tsx
// App.tsx
{activeTab.viewMode !== 'topics-overview' && 
 activeTab.viewMode !== 'folders-overview' && 
 state.settings.paths.resourceRoot !== 'android_media_store' && (
  // 顶部信息栏
)}
```

#### 10.8.2 隐藏滚动条

Android WebView 中 `overflow-y-auto` 即使隐藏滚动条视觉仍保留空间，需强制隐藏：

```tsx
// FileGrid.tsx
<div
  id={isAndroid ? 'file-grid-scroll' : 'file-grid-container'}
  style={isAndroid ? { scrollbarWidth: 'none', msOverflowStyle: 'none' } : undefined}
>
  {isAndroid && (
    <style dangerouslySetInnerHTML={{ __html: 
      '#file-grid-scroll::-webkit-scrollbar{display:none;width:0!important;height:0!important}' 
    }} />
  )}
</div>
```

### 10.9 优化效果总结

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 快速滚动空白区域 | 大面积空白，等待占位符出现 | 无空白，ImageIcon 占位符即时显示 |
| 停止滚动后占位符闪烁 | 纯色方块闪烁 2~3 次 | 无闪烁，ImageIcon → 缩略图直接切换 |
| 升级中 Spinner 导致掉帧 | 滚动中持续显示，DOM 重绘频繁 | 滚动中完全隐藏，仅 idle 时显示 |
| 8000+ 图片文件夹 | 分页限制，无法一次浏览 | 无分页，全部显示 |
| 缩略图升级优先级 | FIFO，用户停留页最后升级 | LIFO，用户停留页最先升级 |
| content-visibility | Android 上导致空白 | 仅桌面端启用，Android 移除 |

---

## 十一、Tauri 命令列表

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

## 十二、开发调试指南

### 12.1 构建命令

```bash
# 开发模式
npm run build          # 确保 dist 存在
npx tauri android dev   # 连接设备调试

# 构建 APK
npx tauri android build
```

### 12.2 Chrome DevTools 远程调试

```bash
# 电脑 Chrome 打开
chrome://inspect
# 找到设备的 WebView → inspect
```

### 12.3 关键日志标记

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
| `[FolderThumbnail] aurora:thumbnail-upgraded` | FolderThumbnail 收到缩略图升级事件 |
| `[Android] Scan cache saved` | 缓存保存成功 |
| `android_scan_all: found N images` | 全量扫描完成（Rust 日志） |
| `android_scan_all (incremental)` | 增量扫描完成（Rust 日志） |

### 12.4 常见问题排查

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
| 快速滚动出现空白 | content-visibility 在 Android 上干扰虚拟滚动 | 确认 FileCard/FolderCard 的 content-visibility 仅在 `!isAndroid` 时启用 |
| 滚动中 Spinner 导致掉帧 | 升级遮罩在非 idle 状态下显示 | 检查 Spinner 条件是否为 `scrollState === 'idle' \|\| !isAndroid` |
| 缩略图升级顺序不对 | Rust 队列仍为 FIFO | 确认 lib.rs 中 `pop_back()` 替代了 `pop_front()` |

---

## 十三、2026-04-23 性能优化迭代记录

本节记录了 2026-04-23 当天进行的多轮性能优化尝试、结果分析和当前状态。

### 13.1 优化方向与实施内容

#### 13.1.1 优化一：Web Worker 离屏图片解码 (ImageBitmap) — 已回退

**目标**：在 Worker 中使用 `createImageBitmap` 预解码缩略图，通过 Transferable Object 传回主线程，用 Canvas 渲染替代 `<img>` 解码。

**实施内容**：
- 新建 `src/workers/image-decode.worker.ts`：Worker 线程中 fetch + createImageBitmap 解码
- 新建 `src/utils/imageDecodeWorker.ts`：Worker 池管理器（2 个 Worker，round-robin 分配）
- 修改 `ImageThumbnail.tsx`：Android 平台走 Worker 解码 + Canvas 渲染路径
- 修改 `FoldersOverview.tsx`：FolderCard 封面图同样走 Worker 解码 + Canvas 渲染

**回退原因**：Canvas/Worker 路径比原生 `<img>` 更慢，实测帧率从 60fps 降至 ~30fps。

| 对比项 | `<img>` 原生路径 | Canvas/Worker 路径 |
|--------|-----------------|-------------------|
| 解码线程 | 浏览器 GPU 合成器（`decoding="async"`） | Worker 线程 `createImageBitmap` |
| 渲染 | GPU 合成，零主线程开销 | 主线程 `canvas.drawImage` |
| React 渲染次数 | 1 次（设置 src） | 2-3 次（初始→Worker回调→Canvas绘制） |
| HTTP 缓存 | 浏览器自动复用 | 每次都需 fetch |
| DOM 复杂度 | `<img>` 一个元素 | `<canvas>` + `drawImage` + 状态管理 |

**结论**：WebView 中 `<img decoding="async">` 是最优解，Canvas/Worker 增加了不必要的开销。

**当前状态**：已回退。`image-decode.worker.ts` 和 `imageDecodeWorker.ts` 文件保留但不再被引用。

#### 13.1.2 优化二：内存压力感知与 LRU 动态缩放 — 已实施

**目标**：利用 `performance.memory` API 监控 Android WebView 堆内存，当内存接近临界值时自动调整 LRU 缓存大小并释放 ImageBitmap 资源。

**实施内容**：
- 新建 `src/utils/memoryPressureMonitor.ts`：三级压力监控（normal <70% / warning 70-85% / critical >85%），2 秒检测间隔
- 修改 `src/utils/thumbnailCache.ts`：LRUCache 升级为内存感知版本
  - `maxSize` 从常量变为动态可调（1000→500→200）
  - 新增 `imageBitmaps` Map 跟踪 ImageBitmap 资源（为后续优化预留）
  - 新增 `adjustSize(level)` 响应内存压力
  - 新增 `registerBitmap/unregisterBitmap` 位图生命周期管理
  - 新增 `releaseNonVisibleBitmaps()` 释放不可见位图
  - 淘汰缓存条目时同时释放关联的 ImageBitmap（`.close()`）
- 修改 `src/shared/utils/cache.ts`：同步升级，支持 `adjustSize()`
- 修改 `src/hooks/useAppInit.ts`：Android 启动时初始化内存监控，订阅压力变化自动调整 LRU
- 修改 `src/shared/components/Thumbnails/ImageThumbnail.tsx` 和 `FolderThumbnail.tsx`：替换无限制 `Map` 为 `LRUCache(200)`

**当前状态**：已实施，保留。

#### 13.1.3 优化三：批量缩略图路径预取（压缩 JNI 边界）— 已实施

**目标**：减少 Rust 与 Android 原生层的通信频次，一次性获取视口周边 50 张图的系统缩略图路径。

**实施内容**：
- 修改 `MainActivity.kt`：新增 `batchGetThumbnailPaths()` 方法，一次 JNI 调用获取多张缩略图
- 修改 `media_store.rs`：新增 `batch_get_system_thumbnails()` JNI 封装和 `BatchThumbnailItem` 结构体
- 修改 `lib.rs`：新增 `android_batch_get_thumbnails` Tauri 命令，先检查磁盘缓存，未命中的 ID 批量调用 Kotlin，失败时回退到逐个获取
- 新建 `src/utils/thumbnailPrefetch.ts`：批量预取调度器，视口变化时提取 `mediaStoreId` 列表，每次批量获取 50 张
- 修改 `tauri-bridge.ts`：`setGlobalCacheRoot` 时同步设置预取器的缓存根目录
- 修改 `FileGrid.tsx` 和 `FoldersOverview.tsx`：`visibleItems` 变化时触发批量预取

**当前状态**：已实施，保留。但实际效果有限，因为预取仍然需要 IPC 调用。

#### 13.1.4 优化四：scanAllAsJson 预查询缩略图路径 — 已实施

**目标**：模仿 Android 原生相册的策略，在扫描阶段就把所有缩略图路径准备好，渲染时直接从内存缓存读取。

**实施内容**：
- 修改 `MainActivity.kt` `scanAllAsJson()`：
  - 对每个文件夹封面调用 `getThumbnail()` + `compress` + `write`，将路径嵌入 `cover_thumbnail_path` 字段
  - 对每张图片，如果磁盘缓存已存在缩略图文件，将路径嵌入 `thumbnail_path` 字段
- 修改 `media_store.rs`：
  - `AndroidFolderInfo` 新增 `cover_thumbnail_path: Option<String>` 字段
  - `AndroidImageInfo` 新增 `thumbnail_path: Option<String>` 字段
  - JSON 解析新增对应字段提取
- 修改 `androidPlatform.ts`：
  - 接口定义新增 `cover_thumbnail_path` 和 `thumbnail_path` 字段
  - 新增 `prefillThumbnailCache()` 函数：扫描完成后将所有预查询的缩略图路径通过 `convertFileSrc()` 转换后批量写入 LRU 缓存
  - `buildFolderNodes` 新增 `coverThumbnailPath` 字段映射
- 修改 `FoldersOverview.tsx`：`FolderCard` 初始化时直接从 LRU 缓存读取缩略图 URL

**当前状态**：已实施。第二次启动时效果明显（缓存命中率高），首次启动时效果有限（需要等待扫描+预查询完成）。

#### 13.1.5 优化五：FoldersOverview 保持挂载 + 滚动位置恢复 — 已实施

**目标**：从文件夹返回主界面时不再重新加载。

**实施内容**：
- 修改 `App.tsx`：将 FoldersOverview 从条件渲染改为 CSS `display: none/contents` 隐藏
- 修改 `FoldersOverview.tsx`：
  - 新增 `isVisible`、`scrollTop`、`onScrollTopChange` props
  - 新增 `hasRestoredRef` 和 `isRestoringScrollRef` 实现滚动位置恢复
  - 滚动事件中调用 `onScrollTopChange` 保存位置到 Tab 状态
  - `isVisible` 变为 false 时重置 `hasRestoredRef`

**当前状态**：已实施，保留。解决了返回主界面时重新加载的问题。

#### 13.1.6 优化六：虚拟滚动缓冲区调整 — 已实施

**实施内容**：
- 缓冲区从 `Math.max(1200, containerHeight * 2)` 增至 `Math.max(3000, containerHeight * 3)`
- `useInView` rootMargin 从 1200px 增至 2000px
- 移除了 "200项以下全渲染" 优化（该优化导致 100 个 FolderCard 同时渲染，反而更慢）

**当前状态**：已实施，保留。

#### 13.1.7 优化七：`<img decoding="async">` — 已实施

**实施内容**：
- 所有缩略图 `<img>` 标签添加 `decoding="async"` 属性，让浏览器在独立线程解码图片
- 使用 `loading="eager"` 而非 `loading="lazy"`（因为 LRU 缓存已有 URL，应立即加载）

**当前状态**：已实施，保留。

### 13.2 已解决的关键问题

#### 13.2.1 主界面帧率低于文件夹内部 — 已解决（2026-04-24）

**现象**：
- 主界面（FoldersOverview，~100 个文件夹卡片）滚动时帧率明显低于文件夹内部（FileGrid，可能数千张图片）
- 120Hz 屏幕上主界面滚动感觉只有 ~60fps 或更低
- 文件夹内部滚动接近满帧

**根因分析**：
1. **FolderCard DOM 复杂度**：每个 FolderCard 包含 `backdrop-blur-sm`（极贵）、半透明渐变叠加层、阴影过渡动画、`animate-spin` SVG 旋转动画
2. **React 重渲染**：`FoldersOverview` 未用 `React.memo` 包裹，App.tsx 回调每次渲染创建新函数
3. **升级遮罩未感知滚动状态**：滚动中仍显示 `animate-spin`，持续触发 DOM 重绘
4. **缺少 GPU 合成层优化**：无 `will-change: transform` 或 `contain` 属性

**解决方案**（2026-04-24 实施）：

| 优化项 | 之前 | 之后 |
|--------|------|------|
| `backdrop-blur-sm` | 数量标签使用模糊背景 | 改为 `bg-black/50` 纯色半透明 |
| 渐变叠加层 | `bg-gradient-to-t from-black/70 via-black/30 to-transparent` | 移除 |
| 阴影过渡 | `shadow-sm hover:shadow-md transition-shadow duration-200` | 移除 |
| 升级遮罩 | 滚动中始终显示 `animate-spin` | 仅在 `scrollState === 'idle'` 时显示 |
| GPU 合成层 | 无 | `willChange: 'transform'` + `contain: 'paint'` |
| React.memo | FoldersOverview 未包裹 | `React.memo` 包裹 |
| 回调稳定化 | App.tsx 每次渲染创建新函数 | `useCallback` 稳定化 |
| `group` 类 | 保留（触摸屏无 hover 意义） | 移除 |
| scrollbar CSS | `dangerouslySetInnerHTML` 每次渲染注入 | `useEffect` + `document.head.appendChild` 一次性注入 |

**修改文件**：
- `src/components/FoldersOverview.tsx`：FolderCard 极简化 + React.memo + 滚动状态感知 + CSS 优化
- `src/App.tsx`：`useCallback` 稳定化 `onFolderClick` 和 `onScrollTopChange`

#### 13.2.2 快速滚动时仍能看到占位符

**现象**：快速向下滚动时，新进入视口的 FolderCard 先显示 ImageIcon 占位符，然后才加载缩略图。

**根因分析**：
- 即使 LRU 缓存已预填充（第二次启动），`convertFileSrc()` 返回的 URL 仍需 WebView 发起 HTTP 请求获取图片数据
- `<img decoding="async">` 虽然不阻塞主线程，但图片解码仍需时间
- 虚拟滚动在缓冲区外的项目不渲染，进入缓冲区后才创建 DOM

**Android 原生相册为什么没有这个问题**：
- 原生 `RecyclerView` 使用 `Glide` 库，内存中维护 Bitmap LRU 缓存
- Bitmap 已解码，渲染时直接 `drawBitmap`，无需再次解码
- `Glide` 的缓存策略：活跃资源 → LRU 内存 → 磁盘 → 网络
- 原生渲染无需 WebView 的 HTTP 请求 → 解码 → GPU 上传流程

**WebView 的根本限制**：
- `<img src>` 必须经过 HTTP 请求 → 下载 → 解码 → GPU 上传的完整流程
- 即使 Tauri 的 `convertFileSrc()` 走本地协议，WebView 仍需完整流程
- 没有类似 Glide 的"已解码 Bitmap 直接渲染"机制

#### 13.2.3 首次启动卡顿

**现象**：首次安装后打开应用，主界面操作帧率极低。

**根因**：
- `scanAllAsJson` 预查询缩略图增加了扫描时间
- 首次启动时没有任何磁盘缓存，所有缩略图都需要实时获取
- 100 个 FolderCard 同时请求缩略图，IPC 通道拥堵

### 13.3 修改文件完整清单（2026-04-23）

| 文件 | 操作 | 说明 |
|------|------|------|
| `src/workers/image-decode.worker.ts` | 新建 | Worker 离屏解码（已回退，文件保留） |
| `src/utils/imageDecodeWorker.ts` | 新建 | Worker 池管理器（已回退，文件保留） |
| `src/utils/memoryPressureMonitor.ts` | 新建 | 内存压力监控器 |
| `src/utils/thumbnailPrefetch.ts` | 新建 | 批量预取调度器 |
| `src/utils/thumbnailCache.ts` | 修改 | LRU 升级为内存感知版本 |
| `src/shared/utils/cache.ts` | 修改 | 同步升级 LRU |
| `src/hooks/useAppInit.ts` | 修改 | 初始化内存监控 |
| `src/shared/components/Thumbnails/ImageThumbnail.tsx` | 修改 | 替换 Map 为 LRU |
| `src/shared/components/Thumbnails/FolderThumbnail.tsx` | 修改 | 替换 Map 为 LRU |
| `src/components/ImageThumbnail.tsx` | 修改 | 回退 Canvas/Worker，使用 `<img decoding="async">` |
| `src/components/FoldersOverview.tsx` | 修改 | 回退 Canvas/Worker；CSS 隐藏保持挂载；滚动位置恢复；`<img decoding="async">` |
| `src/components/FileGrid.tsx` | 修改 | 虚拟滚动缓冲区调整；预取调度集成 |
| `src/api/tauri-bridge.ts` | 修改 | 预取器缓存根目录设置 |
| `src-tauri/gen/android/.../MainActivity.kt` | 修改 | `scanAllAsJson` 预查询缩略图路径；新增 `batchGetThumbnailPaths()` |
| `src-tauri/src/android/media_store.rs` | 修改 | 新增 `thumbnail_path`/`cover_thumbnail_path` 字段；新增 `batch_get_system_thumbnails()` |
| `src-tauri/src/lib.rs` | 修改 | 新增 `android_batch_get_thumbnails` 命令 |
| `src/App.tsx` | 修改 | FoldersOverview CSS 隐藏而非卸载 |

### 13.4 Tauri 命令更新

| 命令 | 参数 | 返回值 | 说明 |
|------|------|-------|------|
| `android_batch_get_thumbnails` | `imageIds: Vec<i64>`, `cacheRoot: String` | `Vec<ThumbnailResult>` | 批量获取缩略图路径，先检查磁盘缓存，未命中批量调用 Kotlin，失败回退逐个获取 |

### 13.5 数据结构更新

```rust
// media_store.rs - 新增字段
pub struct AndroidImageInfo {
    // ... 原有字段 ...
    #[serde(default)]
    pub thumbnail_path: Option<String>,  // 新增：预查询的缩略图磁盘路径
}

pub struct AndroidFolderInfo {
    // ... 原有字段 ...
    #[serde(default)]
    pub cover_thumbnail_path: Option<String>,  // 新增：预查询的封面缩略图磁盘路径
}
```

```typescript
// androidPlatform.ts - 新增字段
interface AndroidFolderRaw {
    // ... 原有字段 ...
    cover_thumbnail_path?: string | null;  // 新增
}

interface AndroidImageRaw {
    // ... 原有字段 ...
    thumbnail_path?: string | null;  // 新增
}

// FileNode 新增字段
coverThumbnailPath?: string;  // 新增：预查询的封面缩略图路径
```

### 13.6 经验教训

1. **Canvas/Worker 在 WebView 中不是性能优化**：`<img decoding="async">` + GPU 合成器是 WebView 中最优的图片渲染路径，Canvas/Worker 增加了不必要的开销
2. **"全渲染"优化适得其反**：100 个 FolderCard 同时渲染比虚拟滚动更慢，因为 DOM 节点数和 React 渲染开销远大于虚拟滚动的过滤计算
3. **预查询缩略图路径是正确方向**：但效果受限于 WebView 的 `<img>` 渲染流程（HTTP 请求 → 解码 → GPU 上传），无法像原生应用那样直接使用已解码的 Bitmap
4. **WebView 的根本性能瓶颈**：与原生应用相比，WebView 的图片渲染多了一个完整的 HTTP + 解码流程，这是架构层面的限制

---

## 十四、2026-04-24 换行动画 GPU 加速优化

本节记录了缩略图大小变化时换行动画的性能优化，将位置过渡从主线程 Layout 重排迁移到 GPU 合成器。

### 14.1 问题背景

缩略图大小变化时（如 Ctrl+滚轮缩放），所有可见卡片需要换行到新位置。之前的实现使用 `left`/`top` CSS 属性 + `transition-all` 实现过渡动画，在卡片数量较多时（图标缩小后一行可放 8-10 个）出现明显掉帧。

### 14.2 根因分析

| 属性 | 触发渲染管线 | 执行线程 | GPU 加速 |
|------|-------------|---------|---------|
| `left` / `top` | Layout → Paint → Composite | 主线程 | ❌ |
| `width` / `height` | Layout → Paint → Composite | 主线程 | ❌ |
| `transform` | Composite only | GPU 合成器线程 | ✅ |

- `left`/`top` 变化触发完整 Layout 重排，120Hz 下每帧仅 8.3ms，40+ 张卡片同时变化时主线程无法承受
- `width`/`height` 过渡同样触发 Layout，且尺寸过渡视觉感知弱（卡片就地缩放，无位移感）
- `transition-all` 对所有属性做过渡，增加不必要的计算

### 14.3 解决方案

将位置属性从 `left`/`top` 改为 `transform: translate()`，仅对 `transform` 做过渡：

```tsx
// 之前
<div
  className="absolute transition-all duration-300 ease-out"
  style={{
    left: pos.x,
    top: pos.y,
    width: pos.width,
    height: pos.height,
    willChange: 'transform',
  }}
>

// 之后
<div
  className="absolute"
  style={{
    transform: `translate(${pos.x}px, ${pos.y}px)`,
    width: pos.width,
    height: pos.height,
    willChange: 'transform',
    transition: 'transform 300ms ease-out',
  }}
>
```

**关键设计决策**：
- **仅过渡 `transform`**：位置滑动是换行动画的视觉核心，由 GPU 合成器处理，不掉帧
- **`width`/`height` 瞬间切换**：尺寸变化即时完成，不触发 Layout 过渡动画，视觉上几乎无感知
- **跨平台生效**：桌面端 Chromium 的 GPU 合成器更强大，效果优于 Android WebView

### 14.4 修改文件清单

| 文件 | 修改位置 | 说明 |
|------|---------|------|
| `src/components/FoldersOverview.tsx` | FolderCard 绝对定位容器 | `left/top` → `transform: translate()` + `transition: transform 300ms` |
| `src/components/FileGrid.tsx` | FileCard 绝对定位容器 | `left/top` → `transform: translate()` + `transition: transform 300ms` |
| `src/components/FileGrid.tsx` | GroupContent 列表模式 | `left/top` → `transform: translate()` |
| `src/components/FileGrid.tsx` | 主列表模式 | `left/top` → `transform: translate()` |

### 14.5 性能对比

| 场景 | 优化前 | 优化后 |
|------|--------|--------|
| 40 张卡片同时换行（120Hz） | 明显掉帧，~40-60fps | 流畅，接近 120fps |
| 100 张卡片换行（桌面端） | 轻微卡顿 | 完全流畅 |
| 位置过渡动画 | 主线程 Layout 重排 | GPU 合成器 Composite |
| 尺寸变化 | 300ms 过渡（触发 Layout） | 瞬间切换（无过渡） |

### 14.6 经验教训

1. **`transform` 是唯一能走 GPU 的位置属性**：`left`/`top`/`right`/`bottom` 都会触发 Layout，只有 `transform` 可以绕过主线程
2. **不要过渡所有属性**：`transition-all` 是性能陷阱，应只过渡真正需要的属性
3. **`width`/`height` 过渡性价比极低**：尺寸变化在换行场景下视觉感知弱，但 Layout 开销巨大
4. **`will-change: transform` 必须配合 `transform` 使用**：如果定位仍用 `left`/`top`，`will-change: transform` 只提升合成层但不优化位置变化

---

**文档版本**: 5.0  
**创建日期**: 2026-04-19  
**更新日期**: 2026-04-24  
**维护者**: Aurora Gallery Team
