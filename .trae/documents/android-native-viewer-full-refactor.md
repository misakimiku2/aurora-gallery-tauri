# Android 原生图片查看器扩展为全功能查看组件

## 日期
2026-07-07

## Summary

将 Android 端 `NativeGalleryView` 从"纯图片浏览覆盖层"扩展为"全功能原生图片查看组件"：新增右侧抽屉式元数据面板（展示文件信息/调色板/标签/描述/AI 信息）、原生标签和描述编辑、实时双向同步机制。Android 端 WebView ImageViewer 不再渲染（仅在用户关闭"使用原生查看器"开关时回退）。本方案作为 Android 端独有的图片查看体验，PC 端继续使用 WebView ImageViewer。

## Current State Analysis

### 现有架构

**调用链**（已工作）：
- 前端 [App.tsx:2409-2413](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2409-L2413) `invoke('android_open_native_viewer', {images, startIndex, options})`
- Rust [lib.rs:1330-1366](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/src/lib.rs#L1330-L1366) JNI 调 `MainActivity.openNativeViewer(String, int, String)`
- Kotlin [MainActivity.kt:1153-1207](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt#L1153-L1207) 解析 JSON → `NativeGalleryView.open(items, startIndex, options)`

**当前 ImageItem 字段**（[NativeGalleryView.kt:73-81](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L73-L81)）：
仅 `path, fileId, name, width, height, isLan, thumbnailUrl` — 没有元数据。

**前端序列化**（[App.tsx:2354-2382](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2354-L2382)）：只传上述 7 个字段。

**前端 bridge**（[App.tsx:2436-2491](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2436-L2491)）：`window.__androidViewerBridge` 提供 `onClose/onNavigate/onMore/onDelete/onShowInFolder/onCopyToFolder/onMoveToFolder/onAIAnalyze/onEditTags/onLongPress/onImmersiveToggle`。

**FileNode 完整字段**（[types.ts:47-81](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/types.ts#L47-L81)）：
`id, parentId, name, type, path, size, tags[], description?, sourceUrl?, meta?(ImageMeta: width/height/sizeKb/created/modified/format/palette[]/dominantColors[]), aiData?(AiData: analyzed/description/tags[]/faces/sceneCategory/confidence/dominantColors[]/objects[]/extractedText?/translatedText?), createdAt?, updatedAt?, source: 'local'|'lan'`。

**MetadataPanel 展示区块**（参考 [MetadataPanel.tsx:2370-2545](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/MetadataPanel.tsx#L2370-L2545)）：
1. Details（format/size/dimensions/created/updated）
2. Tags（tags[] + 增删 UI）
3. Description（textarea 编辑）
4. Source URL（sourceUrl）

**标签编辑 API**（[MetadataPanel.tsx:1121-1148](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/MetadataPanel.tsx#L1121-L1148)）：
`onUpdate(fileId, { tags: [...file.tags, newTag] })` / `onUpdate(fileId, { tags: file.tags.filter(t => t !== tag) })`。

**Settings 开关**（[types.ts:351-353](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/types.ts#L351-L353), [App.tsx:157](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L157), [SettingsModal.tsx:2564-2570](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/SettingsModal.tsx#L2564-L2570)）：
`AppSettings.android.useNativeViewer: boolean`，默认 `true`，SettingsModal 已有切换 UI。

### 用户决策（Phase 2 答复）

1. **抽屉触发**：顶栏 ⓘ 按钮切换右侧抽屉；图片单击仍切沉浸模式。
2. **WebView 回退**：仅在用户关闭"使用原生查看器"开关时回退到 WebView ImageViewer。
3. **标签/描述编辑**：原生 `AlertDialog` + `ChipGroup`，不回退 WebView。

## Proposed Changes

### 改动 1：扩展 ImageItem 数据结构

**文件**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt`

**修改 `ImageItem` data class**（L73-81）：
```kotlin
data class ImageItem(
    val path: String,
    val fileId: String,
    val name: String,
    val width: Int,
    val height: Int,
    val isLan: Boolean,
    val thumbnailUrl: String?,
    // 新增元数据字段
    val size: Long = 0,
    val format: String = "",
    val createdAt: String = "",
    val updatedAt: String = "",
    val tags: List<String> = emptyList(),
    val description: String = "",
    val sourceUrl: String = "",
    val palette: List<String> = emptyList(),
    val aiTags: List<String> = emptyList(),
    val aiDescription: String = "",
    val aiSceneCategory: String = "",
    val aiObjects: List<String> = emptyList(),
)
```

**Why**：让原生层切换图片时能直接展示所有元数据，避免切换时再 JNI 拉取。

**文件**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt`

**修改 `openNativeViewer` JSON 解析**（L1160-1180）：
扩展 JSON 字段读取，把新字段填入 `ImageItem`。

**文件**：`src/App.tsx`

**修改 `serializeImagesForNativeViewer`**（L2354-2382）：
为每个图片附加 `size, format, createdAt, updatedAt, tags, description, sourceUrl, palette, aiTags, aiDescription, aiSceneCategory, aiObjects` 字段（从 `FileNode` 和 `FileNode.meta` / `FileNode.aiData` 取）。

**Why**：前端是数据源，必须把完整数据序列化传给原生层。

### 改动 2：右侧抽屉式元数据面板

**文件**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt`

**新增 `MetadataDrawer` view**（在 `init` 块中）：
- `LinearLayout`（垂直），宽度 = 屏幕宽度 * 0.72（约 320-400dp）
- 高度 `MATCH_PARENT`，初始 `translationX = width`（屏幕外右侧）
- 内部结构：
  ```
  ScrollView
    └─ LinearLayout(vertical)
       ├─ Header（"元信息" 标题 + 关闭按钮）
       ├─ Section 1: Details（format/size/dimensions/created/updated）
       │   └─ GridLayout 2 列
       ├─ Section 2: Palette（色块横排）
       │   └─ LinearLayout horizontal，每个色块 32x32
       ├─ Section 3: Tags（ChipGroup + "编辑"按钮）
       │   └─ 每个 tag 一个 Chip，点击触发 onNavigateToTag
       ├─ Section 4: Description（TextView + "编辑"按钮）
       ├─ Section 5: AI Info（aiSceneCategory/aiObjects/aiTags/aiDescription）
       └─ Section 6: Source URL（可点击打开）
  ```
- 半透明背景 `#F2000000`，圆角左侧

**抽屉动画**：使用 `animate().translationX()`，时长 250ms。

**抽屉打开时图片处理**：图片保持不动，抽屉覆盖右侧 72% 区域（不挤压图片，避免重新布局开销）。如果用户需要看右侧被遮挡的图片部分，可先关闭抽屉。

**`toggleDrawer()` 方法**：
```kotlin
private fun toggleDrawer() {
    val isOpen = metadataDrawer.translationX == 0f
    val targetX = if (isOpen) metadataDrawer.width.toFloat() else 0f
    metadataDrawer.animate().translationX(targetX).setDuration(250).start()
}
```

**修改 `buildTopBar()`**（L206-239）：
将 ⓘ 按钮的 `onClick` 从 `toggleBottomInfo()` 改为 `toggleDrawer()`。

**`updateDrawer(item: ImageItem)` 方法**：切换图片时调用，更新所有 TextView/ChipGroup/色块内容。

**Why**：抽屉式 UI 符合用户决策，原生 View 直接构建避免 WebView 依赖。

### 改动 3：标签和描述的原生编辑 UI

**文件**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt`

**新增 `showTagEditDialog()`**：
```kotlin
private fun showTagEditDialog() {
    val item = images.getOrNull(currentIndex) ?: return
    val chipsContainer = LinearLayout(context).apply { /* vertical */ }
    // 现有 tags 渲染为带 X 的 chip
    val input = EditText(context)
    val addButton = Button(context).apply { text = "+"; setOnClickListener {
        val tag = input.text.toString().trim()
        if (tag.isNotEmpty() && tag !in item.tags) {
            item.tags = item.tags + tag
            // 重新渲染 chips
        }
    } }
    AlertDialog.Builder(context)
        .setTitle("编辑标签")
        .setView(containerLayout)
        .setPositiveButton("保存") { _, _ ->
            listener?.onUpdateFile(item.fileId, JSONObject().apply { put("tags", JSONArray(item.tags)) })
        }
        .setNegativeButton("取消", null)
        .show()
}
```

**新增 `showDescriptionEditDialog()`**：类似，用 multiline `EditText`。

**Listener 接口新增**（L48-71）：
```kotlin
fun onUpdateFile(fileId: String, updatesJson: String)
```

**Why**：原生 AlertDialog + ChipGroup 体验最流畅，无 IME 弹层问题。

### 改动 4：实时同步机制（双向）

**数据流**：
- **原生 → React**：用户在原生层编辑 → `listener?.onUpdateFile(fileId, updatesJson)` → MainActivity `evaluateJavascript("window.__androidViewerBridge.onUpdateFile('${fileId}', ${updatesJson})")` → 前端 bridge 调 `onUpdate(fileId, updates)` → React state 更新
- **React → 原生**：React state 变化触发 useEffect → `invoke('android_update_native_item', { fileId, updatesJson })` → Rust JNI → Kotlin `NativeGalleryView.updateItem(fileId, updates)` → 刷新抽屉显示

**文件**：`src-tauri/src/lib.rs`

**新增 Rust 命令** `android_update_native_item`（参考现有 `android_open_native_viewer` L1328-1366）：
```rust
#[cfg(target_os = "android")]
#[tauri::command]
async fn android_update_native_item(file_id: String, updates: String) -> Result<(), String> {
    // JNI 调用 MainActivity.updateNativeItem(fileId, updates)
}
```

**注册命令**（[lib.rs:2064](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/src/lib.rs#L2064) `invoke_handler`）：
将 `android_update_native_item` 添加到 handler 列表。

**文件**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt`

**新增 `updateNativeItem(fileId: String, updatesJson: String)`**：
```kotlin
fun updateNativeItem(fileId: String, updatesJson: String) {
    runOnUiThread {
        nativeGalleryView?.updateItem(fileId, JSONObject(updatesJson))
    }
}
```

**文件**：`src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt`

**新增 `updateItem(fileId: String, updates: JSONObject)`**：
- 找到 `images` 中对应 `fileId` 的 `ImageItem`
- 根据 updates 更新字段（tags/description/aiTags 等可能变化的字段）
- 若 `fileId == currentIndex`，刷新抽屉显示

**文件**：`src/App.tsx`

**前端 bridge 新增 `onUpdateFile`**（在 [L2436-2491](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2436-L2491) bridge 对象）：
```typescript
onUpdateFile: (fileId: string, updatesJson: string) => {
    const updates = JSON.parse(updatesJson);
    onUpdate(fileId, updates);  // 复用现有 onUpdate
},
```

**新增 useEffect 监听当前 viewingFile 的 FileNode 变化**：
```typescript
useEffect(() => {
    if (!useNativeViewer || !nativeViewerActive) return;
    const viewingId = activeTab.viewingFileId;
    if (!viewingId) return;
    const file = state.files[viewingId];
    if (!file) return;
    // 增量序列化当前文件的更新
    const updates = {
        tags: file.tags,
        description: file.description || '',
        // ...其他字段
    };
    invoke('android_update_native_item', {
        fileId: viewingId,
        updates: JSON.stringify(updates),
    }).catch(() => {});
}, [useNativeViewer, nativeViewerActive, activeTab.viewingFileId, state.files[activeTab.viewingFileId]]);
```

**Why**：React state 是单一数据源；增量更新避免重新 `open()` 整个查看器。原生 → React 走 evaluateJs，React → 原生走 invoke。两者都是幂等的（数据相同不会循环）。

### 改动 5：Android 端 WebView ImageViewer 不渲染

**文件**：`src/App.tsx`

需要先定位 ImageViewer 在哪里 mount（Phase 1 未查到，实施时第一步要 Grep `<ImageViewer` 或 `import ImageViewer`）。

**修改方案**：
- 找到 ImageViewer 的渲染条件（推测在 App.tsx 的 JSX 中，由 `activeTab.viewingFileId` 控制）
- 添加条件：`const showWebViewViewer = !useNativeViewer && activeTab.viewingFileId`
- ImageViewer 组件外层包 `{!useNativeViewer && <ImageViewer ... />}` 或在 ImageViewer 内部检测 `useNativeViewer` 直接 return null

**Why**：用户决策"WebView 只作为 PC 端功能"。Android 端 ImageViewer 不 mount 节省内存和渲染开销。

### 改动 6：高级功能处理

**Android 端原生层"更多 ⋮"菜单简化**：

保留可在原生层完成的操作：
- 删除当前图片（已有 `onDelete` 回调）
- 在文件夹中显示（已有 `onShowInFolder`）
- 旋转保存（需新增 Rust 命令 `save_image_rotation`）
- 重命名（新增原生 `AlertDialog` + `EditText`，调 `onUpdate(fileId, {name})`）

**回退 WebView 的功能**（通过现有 `onMore` 关闭原生查看器后由前端处理）：
- AI 分析：`evaluateJs("onAIAnalyze(fileId)")` → 前端 `handleAIAnalysis` → 关闭原生查看器显示 AI 面板
- 复制/移动到文件夹：`evaluateJs("onCopyToFolder(fileId)")` → 前端 `setState({activeModal: 'copy-to-folder'})`

**修改 `showMoreMenu()`**（[NativeGalleryView.kt:458-461](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L458-L461)）：
```kotlin
private fun showMoreMenu() {
    val item = images.getOrNull(currentIndex) ?: return
    val options = arrayOf("删除", "在文件夹中显示", "重命名", "旋转保存", "AI 分析", "复制到文件夹", "移动到文件夹")
    AlertDialog.Builder(context)
        .setTitle(item.name)
        .setItems(options) { _, which ->
            when (which) {
                0 -> listener?.onDelete(item.fileId)
                1 -> listener?.onShowInFolder(item.fileId)
                2 -> showRenameDialog()
                3 -> saveRotation()
                4 -> listener?.onAIAnalyze(item.fileId)
                5 -> listener?.onCopyToFolder(item.fileId)
                6 -> listener?.onMoveToFolder(item.fileId)
            }
        }.show()
}
```

**Why**：原生层只做轻量操作；AI 分析等复杂 UI 仍由 WebView Modal 承载。onMore 不再需要单独触发"切回完整 WebView ImageViewer"。

### 改动 7：i18n 文案

**文件**：`src/utils/translations.ts`

无需新增 — 原生层 UI 是 Kotlin 硬编码文案，不经过前端 i18n。这是 Android 独有组件，文案暂用中文，未来若需多语言再在 Kotlin 层实现 locale 切换。

## Assumptions & Decisions

1. **数据源**：React state 是单一数据源，原生层不直接连 SQLite。
2. **图片占满屏幕**：抽屉打开时图片不被挤压，抽屉覆盖右侧（用户决策"图片单击切沉浸"暗示图片始终占满）。
3. **标签编辑入口**：抽屉内 Tags section 的"编辑"按钮 + 顶栏「更多」菜单都可触发。
4. **AI 信息展示**：只读展示 `aiData` 中的 sceneCategory/objects/tags/description；不提供编辑入口（AI 数据由 WebView 端 AI 分析流程生成）。
5. **LAN 图片**：标签/描述编辑同样通过 `onUpdate` 回写，与本地图片一致。
6. **WebView 完全不渲染 ImageViewer**：Android + `useNativeViewer=true` 时，ImageViewer 组件根本不 mount（不仅是 display:none），节省 WebView 内存和 DOM 节点。
7. **高级功能回退**：AI 分析、复制/移动到文件夹通过 `evaluateJs` 触发前端 Modal，但需要先 `android_close_native_viewer` 让 WebView 可见（保留现有 `onMore` 的关闭逻辑）。

## Verification Steps

### 编译验证
1. `cd src-tauri && cargo build --target aarch64-linux-android` — Rust 编译通过
2. `cd src-tauri/gen/android && ./gradlew :app:compileUniversalDebugKotlin` — Kotlin 编译通过
3. `cd src-tauri/gen/android && ./gradlew :app:compileUniversalDebugJavaWithJavac` — Java 编译通过
4. 前端 `npm run build` — TypeScript 类型检查通过

### 功能验证（设备）
1. **元数据展示**：点击图片打开原生查看器 → 点顶栏 ⓘ → 抽屉滑出，显示文件信息/调色板/标签/描述
2. **图片切换同步**：左右翻页 → 抽屉内所有 section 同步更新到当前图片
3. **标签编辑**：点 Tags "编辑" → AlertDialog 弹出 → 添加/删除标签 → 保存 → 抽屉立即刷新 + 主界面 grid 同步显示新标签
4. **描述编辑**：点 Description "编辑" → AlertDialog → 修改 → 保存 → 抽屉刷新 + 主界面同步
5. **WebView 同步**：在主界面 grid 改某图标签 → 打开该图查看器 → 抽屉显示新标签（验证 React → 原生同步）
6. **WebView 不渲染**：Android 端打开图片时 WebView DOM 中没有 ImageViewer 节点（Chrome inspect 验证）
7. **更多菜单**：点 ⋮ → 弹出 7 项菜单 → "AI 分析"关闭原生查看器后显示 AI 面板；"删除"直接删除并关闭
8. **设置开关**：关闭"使用原生查看器"后点击图片 → 走 WebView ImageViewer（PC 端体验）
9. **沉浸模式**：点图片 → 顶栏和抽屉都隐藏；再点 → 恢复
10. **Activity 销毁**：旋转屏幕或退出应用后无 WindowManager 泄漏（logcat 验证）

### 性能验证
- 切换图片时间 ≤ 200ms（Coil 缓存命中时）
- 抽屉打开/关闭动画流畅（60fps）
- 标签编辑 AlertDialog 弹出无延迟

## 实施顺序

1. **第一步**：扩展 ImageItem + 前端序列化 + MainActivity 解析（改动 1）— 数据通路打通
2. **第二步**：实现 MetadataDrawer view + toggleDrawer + updateDrawer（改动 2）— 纯展示，先看到效果
3. **第三步**：标签和描述编辑 Dialog（改动 3）+ Listener onUpdateFile + MainActivity evaluateJs bridge
4. **第四步**：实时同步机制 — Rust 新命令 + Kotlin updateItem + 前端 useEffect 监听（改动 4）
5. **第五步**：Android 端 ImageViewer 不渲染（改动 5）— 最后做，避免前面步骤无法测试
6. **第六步**：更多菜单完善（改动 6）
