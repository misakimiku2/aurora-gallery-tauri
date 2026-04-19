# Android 文件夹总览视图 (Folders Overview) — 实现文档

## 概述

**功能名称**：Android 文件夹总览视图  
**实现日期**：2026-04-19  
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

### 1.2 性能数据

- 测试设备：Samsung Galaxy Tab S8+ (SM-X808U)
- 设备图片总数：**21,744 张**
- MediaStore JNI 调用次数：约 **15-20 万次**（每行 6-8 次）
- 扫描耗时：数秒到十几秒（取决于设备）

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
| `src-tauri/src/android/media_store.rs` | 修改 | 文件夹扫描返回封面图片信息 |
| `src/utils/androidPlatform.ts` | 修改 | 拆分扫描为文件夹优先 + 图片后台加载 |
| `src/components/FoldersOverview.tsx` | **新增** | 文件夹总览组件（圆角矩形+渐变叠加文字） |
| `src/hooks/useAppInit.ts` | 修改 | Android 启动流程：先显示文件夹 → 后台加载图片 |
| `src/hooks/useNavigation.ts` | 修改 | 支持 folders-overview 的导航/历史/新标签页 |
| `src/App.tsx` | 修改 | 渲染分支 + 返回导航逻辑 |
| `src/components/TopBar.tsx` | 修改 | folders-overview 工具栏适配 |
| `src/components/FolderThumbnail.tsx` | 修改 | Android 上跳过 Folder3DIcon |
| `src/components/Folder3DIcon.tsx` | 修改 | Android 上降级为轻量占位符 |
| `src/shared/components/Thumbnails/Folder3DIcon.tsx` | 修改 | 同上（MetadataPanel 使用） |
| `src/components/FolderIcon.tsx` | 修改 | 同上（自带副本） |

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
    pub cover_image_path: Option<String>,   // 新增：封面图片路径
    pub cover_image_id: Option<i64>,        // 新增：封面图片 MediaStore ID
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

### 4.3 parse_folder_cursor 封面追踪逻辑

```rust
struct FolderData {
    name: String,
    path: String,
    count: i32,
    cover_image_path: Option<String>,
    cover_image_id: Option<i64>,
    max_date_modified: i64,  // 用于比较哪个是最新的
}

// 遍历每一行时：
if date_modified > entry.max_date_modified {
    entry.max_date_modified = date_modified;
    entry.cover_image_path = Some(data_path.clone()); // 先 clone 防止 move 冲突
    entry.cover_image_id = image_id;
}
entry.count += 1;
```

---

## 五、前端：两阶段加载策略

### 5.1 androidPlatform.ts 导出函数

```typescript
// scanAndroidFolders() - 仅扫描文件夹（快速）
// 返回：{ files: Record<string, FileNode>, roots: string[] }
// 每个 FileNode 包含：id, name, path, type:'folder', imageCount, coverImagePath, coverImageMediaStoreId

// scanAndroidImages() - 完整扫描（慢速）
// 返回：与上面相同结构，但包含所有图片子节点

// scanAndroidMedia() - 兼容性包装
// 内部调用 scanAndroidImages()
```

### 5.2 useAppInit.ts Android 启动流程

```
应用启动
  │
  ├─ 检测 isAndroidPlatform()
  ├─ setState(settings)           // 先设置设置
  │
  ├─ ensureAndroidPermission()     // 等待权限（splash 仍显示）
  │
  ├─ scanAndroidFolders()          // 快速扫描文件夹 (~1-2秒)
  │   └─ invoke("android_scan_folders")
  │       └─ MediaStore GROUP BY bucket_id
  │
  ├─ setState({ files, roots })   // 更新文件树
  ├─ setIsLoading(false)            // 关闭 splash
  ├─ setShowSplash(false)           // 显示主界面（文件夹已可见！）
  │
  └─ [异步] scanAndroidImages()     // 后台加载图片
      ├─ setState({ isScanning: true })  // 显示"正在加载..."
      ├─ invoke("android_scan_images")    // 全量扫描
      └─ setState({ isScanning: false }) // 加载完成
          └─ files/roots 更新为完整数据（含图片子节点）
```

**关键点**：`setIsLoading(false)` 和 `setShowSplash(false)` **必须**在 `scanAndroidFolders()` **之后**才调用。

### 5.3 默认 Tab 配置

```typescript
const defaultTab: TabState = {
  ...DUMMY_TAB,
  id: 'tab-default',
  folderId: '__android_folders_root__',  // 虚拟根目录
  viewMode: 'folders-overview',         // 文件夹总览模式
};
defaultTab.history = {
  stack: [{
    folderId: '__android_folders_root__',
    viewingId: null,
    viewMode: 'folders-overview',       // 历史条目也是 folders-overview
    searchQuery: '',
    searchScope: 'all',
    activeTags: [],
    activePersonId: null
  }],
  currentIndex: 0
};
```

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
      enterFolder(activeTab.folderId);  // 桌面端正常行为
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
// 模块加载时检测（同步，结果缓存到常量）
function isAndroid(): boolean {
  try {
    if ((window as any).__TAURI_INTERNALS?.platform === 'android') return true;
    return /android/i.test(navigator.userAgent);
  } catch { return false; }
}
const _isAndroid = isAndroid();

export const Folder3DIcon = memo(({ ... }) => {
  if (_isAndroid) {
    return <AndroidLightweightIcon />;  // 即刻 return，不执行任何桌面端逻辑
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
    return <AndroidFolderPlaceholder />;  // 完全跳过 findImagesDeeply 和 getThumbnail
  }
  // ... 桌面端完整逻辑 ...
});
```

---

## 九、Tauri 命令列表

| 命令 | 参数 | 返回值 | 说明 |
|------|------|-------|------|
| `android_scan_images` | 无 | `Vec<AndroidImageInfo>` | 扫描全部图片（含 id, path, content_uri, name, size, width, height, date_modified, mime_type） |
| `android_scan_folders` | 无 | `Vec<AndroidFolderInfo>` | 扫描全部文件夹（含 id, name, path, image_count, cover_image_path, cover_image_id） |
| `android_get_thumbnail` | filePath, cacheRoot, imageId? | `ThumbnailResult` | 获取缩略图（优先系统 loadThumbnail，回退文件解码） |
| `check_android_permissions` | 无 | `String` | 检查权限状态 |
| `request_android_permissions` | 无 | `String` | 请求权限 |
| `get_default_paths` | 无 | `HashMap<String, String>` | 获取默认路径 |

---

## 十、开发调试指南

### 10.1 构建命令

```bash
# 开发模式
npm run build          # 确保 dist 存在
npx tauri android dev   # 连接设备调试

# 构建 APK
npx tauri android build
```

### 10.2 Chrome DevTools 远程调试

```bash
# 电脑 Chrome 打开
chrome://inspect
# 找到设备的 WebView → inspect
```

### 10.3 关键日志标记

| 日志前缀 | 含义 |
|----------|------|
| `[Thumbnail] Android invoke` | 缩略图请求发出 |
| `[Thumbnail] Android result` | 缩略图结果返回 |
| `[Android] Image-folder matching` | 图片-文件夹匹配 |
| `[AppInit] Android branch` | Android 初始化分支 |
| `android_scan_images: found N images` | 图片扫描完成 |
| `android_scan_folders: found N folders` | 文件夹扫描完成 |

### 10.4 常见问题排查

| 现象 | 可能原因 | 排查方法 |
|------|---------|---------|
| 白屏/splash 不消失 | dist 为空或编译错误 | `npm run build` |
| 蓝色 3D 文件夹仍出现 | Folder3DIcon 未修改 | 检查 3 个副本是否都已修改 |
| 进入文件夹后返回空白 | history stack 异常 | Chrome DevTools Console |
| 换行无动画 | containerWidth 未更新 | 检查 ResizeObserver 是否触发 |
| 编译错误 dist 缺失 | `tauri::generate_context!()` 需要 dist | `npm run build` |

---

**文档版本**: 1.0  
**创建日期**: 2026-04-19  
**维护者**: Aurora Gallery Team
