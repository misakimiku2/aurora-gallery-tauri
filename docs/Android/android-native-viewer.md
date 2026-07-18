# Android 原生图片查看器（NativeGalleryView）完整实现记录

## 日期
2026-07-07 ~ 2026-07-19

## 概述

Android 端为绕开 WebView 渲染管线、达到接近系统相册的原生性能，单独实现了全屏原生图片查看器 `NativeGalleryView`。本文档整合了从 z-order 可见性修复、抽屉式元数据面板、手势跟手滑动、到帧率优化与滑动间隔的全部演进过程，反映当前最新代码状态。

涉及八个阶段：
1. **z-order 修复**（2026-07-07）：解决原生查看器被 WebView 遮挡不可见的问题
2. **抽屉面板与手势修复**（2026-07-08）：新增元数据抽屉、标签/描述编辑、双向同步，修复 e1 recycle 等手势抖动
3. **滑动体验优化**（2026-07-09）：跟手联动滑动、贝塞尔曲线、帧率优化、图片间隔
4. **抽屉全屏模式与垂直手势**（2026-07-10）：抽屉展开时 topBar/系统状态栏同步隐藏形成全屏样式；垂直跟手手势上滑呼出/下滑收起抽屉；修复缩放插值导致图片"缩小再还原"现象
5. **缩放修复与沉浸背景色**（2026-07-12）：修复双击缩放定位/留白/拖动漂移/边缘消失/连续缩放漂移/缩放误触翻页等一系列 ZoomableImageView 缩放手势 bug；单击进入沉浸时背景色改为黑色，退出还原主题色；沉浸状态与抽屉状态解耦（开关抽屉后正确回到沉浸）
6. **抽屉 UI 对齐与弹窗重构**（2026-07-15）：抽屉 UI 全面对齐 MetadataPanel；自定义弹窗替代 AlertDialog 实现动态高度；标签/描述/来源网址弹窗改为动态自适应高度；hint 文本统一斜体+淡色；修复深色模式颜色未对齐 neutral 色板的问题
7. **幻灯片拆分与全屏覆盖层**（2026-07-19）：幻灯片功能从 NativeGalleryView 拆分为独立的 `SlideshowView`（全屏覆盖层，覆盖查看器所有 chrome）；修复循环推进异常导致"停在第二张"的静默死亡 bug（try/catch + 始终重新调度）；新增 transitionGen 代际计数器防止过期图片加载回调竞态；保留 fade/slide/none 三种过渡效果 + Ken Burns 逐渐放大；修复 RadioGroup 视觉残留（View.generateViewId + radioGroup.check）；修复 Ken Burns 首张从左上角放大（视图未布局时延迟启动）和切换图片时缩放回弹（cancelKenBurns 不重置 scale，outgoing 隐藏后再回收）
8. **顶栏布局调整、原生文件夹选择弹窗与弹窗组件独立化**（2026-07-19）：顶栏按钮顺序改为「关闭→文件名→幻灯片→旋转→元数据→删除→分享→更多」，关闭按钮由 X 图标改为返回箭头样式；新增原生「复制到文件夹」「移动到文件夹」弹窗（WebView 弹窗无法覆盖原生查看器，UI 与 FolderPickerModal 一致）；将所有 8 个弹窗（删除确认/文件夹选择/重命名/标签/描述/来源网址/幻灯片设置/更多菜单）抽取为 `dialogs/` 子包下的独立文件，通过 `DialogTheme` 接口注入主题色实现解耦

---

## 一、架构设计

### 1.1 双缓冲视图架构

`NativeGalleryView` 内部维护两个 `ZoomableImageView` 实例作为双 buffer：

```
primaryView   (tag="active"/"idle")
secondaryView (tag="active"/"idle")
```

- `activeView` 属性通过 `tag` 判断当前哪个视图处于活跃状态（显示当前图片）
- `adjacentView()` 返回非活跃视图，用于翻页时预加载上一张/下一张
- 切换图片时交换 `activeView` 指向，旧图滑出 + 新图滑入同时进行

两个视图均为 `MATCH_PARENT`，通过 `translationX` 控制位移实现滑动切换动画。

### 1.2 WindowManager z-order 修复

**问题**：最初使用 `addContentView()` 将 NativeGalleryView 添加到 Activity 的 content frame，但 Tauri 的 WebView 由独立窗口机制管理，z-order 高于 content frame，导致原生查看器被完全遮挡。前端通过 `nativeViewerActive=true` 隐藏了 WebView 内的 `<img>`，但原生层在 WebView 之下，用户只看到 WebView 的半透明 UI 控件叠加在空白图片区域。

**修复**：将 NativeGalleryView 从 content frame 转为独立的 WindowManager 窗口。

**`MainActivity.setupNativeGalleryView()`**：
- 移除 `addContentView(view, ...)` 调用
- View 创建后只存储到 `nativeGalleryView`，不立即添加到任何父容器
- 设置 Listener 回调

**`MainActivity.openNativeViewer()`**：
- 在 `view.open()` 之前检查 `view.isAttachedToWindow`
- 若未附加，创建 `WindowManager.LayoutParams`：
  - `TYPE_APPLICATION_PANEL` — 位于主窗口之上
  - `FLAG_LAYOUT_IN_SCREEN` — 铺满整个屏幕（含状态栏区域）
  - `PixelFormat.TRANSLUCENT` — 支持透明
  - `params.token = window.decorView.windowToken` — 关联到 Activity 主窗口
- 调用 `windowManager.addView(view, params)` 添加窗口
- 检查 `isAttachedToWindow` 确认附加成功

**`MainActivity.onClose` 回调**：
- 使用 `windowManager.removeView(view)` 从 WindowManager 移除（而非仅设 `visibility = GONE`）

**`MainActivity.closeNativeViewer()`**：
- 增加从 WindowManager 移除 View 的逻辑

**`MainActivity.onDestroy()`**：
- Activity 销毁时 `windowManager.removeView(view)` + `view.destroy()` 释放 Coil ImageLoader 资源，防止窗口泄漏

### 1.3 生命周期

```
Activity.onCreate()
  └─ setupNativeGalleryView()
       └─ 创建 NativeGalleryView（未附加到任何窗口）
       └─ 设置 Listener 回调

用户点击图片
  └─ JS: invoke('android_open_native_viewer')
       └─ Rust: JNI call_method openNativeViewer
            └─ Kotlin: openNativeViewer()
                 ├─ windowManager.addView(view, params)  ← 首次附加
                 └─ view.open(items, startIndex, options)
                      ├─ visibility = VISIBLE
                      └─ loadCurrent() → Coil 异步加载

用户点击关闭
  └─ NativeGalleryView.onClose 回调
       ├─ windowManager.removeView(view)  ← 从窗口移除
       └─ evaluateJs("onClose()")
            └─ JS: invoke('android_close_native_viewer')
                 └─ Kotlin: closeNativeViewer()
                      └─ view.close()  ← cleanupSlideshow() 移除幻灯片覆盖层 + visibility = GONE

Activity.onDestroy()
  └─ windowManager.removeView(view)  ← 防止泄漏
  └─ view.destroy()  ← 释放 ImageLoader
```

**关键约束**：
- `NativeGalleryView.close()` 不调用 `imageLoader.shutdown()`，因为 `imageLoader` 是 `lazy` 属性，shutdown 后无法重建，会导致查看器关闭后无法再次打开
- `destroy()` 方法专用于 Activity 销毁时的最终资源释放，包含 `imageLoader.shutdown()`
- `imageLoader` 不在 close 时 shutdown，允许重新打开查看器时复用

---

## 二、功能特性

### 2.1 ImageItem 数据模型

`NativeGalleryView.ImageItem` 包含以下字段，覆盖 MetadataPanel 主要信息：

| 字段 | 类型 | 说明 |
|------|------|------|
| `path` | String | 本地文件路径；LAN 为完整 HTTP URL |
| `fileId` | String | 文件唯一标识 |
| `name` | String | 文件名 |
| `width` / `height` | Int | 原图尺寸 |
| `isLan` | Boolean | 是否局域网图片 |
| `thumbnailUrl` | String? | LAN 缩略图 URL 或本地缩略图路径 |
| `size` | Long | 文件大小 |
| `format` | String | 格式 |
| `createdAt` / `updatedAt` | String | 创建/修改时间 |
| `tags` | List<String> | 标签 |
| `description` | String | 描述 |
| `sourceUrl` | String | 来源网址 |
| `palette` | List<String> | 主色调 |
| `aiTags` | List<String> | AI 标签 |
| `aiDescription` | String | AI 描述 |
| `aiSceneCategory` | String | AI 场景类别 |
| `aiObjects` | List<String> | AI 物体 |
| `parentName` | String | 所在文件夹名 |

前端 `serializeImagesForNativeViewer` 从 FileNode 附加全部字段；MainActivity JSON 解析同步扩展。

### 2.2 抽屉式元数据面板

右侧抽屉式面板，对齐 PC 端 MetadataPanel 体验。

**布局**（从上到下）：
1. 文件名（18sp 加粗）
2. 文件夹名（12sp 次要色）
3. 全览图（Coil 异步加载，180dp 高，圆角 12dp，背景 `#262626`/`#F3F4F6`）
4. 主色调识别区域（标题 + 圆形色块单行排列，24dp 色块 + 8dp 间距）
5. 文件信息（GridLayout 2 列：格式/大小/尺寸/创建/修改，每项带 lucide 图标）
6. 标签（胶囊形状 chip + "+ 编辑标签"按钮，按钮使用次要按钮样式与标签区分）
7. 描述文本框（点击可编辑，空时显示斜体 hint "添加描述..."）
8. 来源网址（点击可编辑，空时显示斜体 hint "https://..."）

> **滚动条**：抽屉 ScrollView 已禁用滚动条（`isVerticalScrollBarEnabled = false`），上下滚动时不显示滚动条。

> **关闭方式**：抽屉可通过以下方式关闭（见 4.8、4.11）：
> - 系统返回键/返回手势
> - 垂直下滑手势（任意位置下滑收起，见 4.11）
>
> 不再使用抽屉头部关闭按钮，避免图片位置突跳。

**规格**：
- 宽度 320dp（20rem，与 App.tsx MetadataPanel 一致）
- 280ms 滑动动画
- 切换图片时 `updateDrawer` 同步刷新
- 进入沉浸模式自动收起
- **抽屉展开时进入全屏样式**：topBar/缩略图条/底部信息同步滑出隐藏，系统状态栏同步隐藏（见 4.7）
- `close()` 始终重置抽屉视觉状态（translationX、view 宽度、immersive、系统状态栏），防止再次打开时残留
- `isClickable = true` / `isFocusable = true` 消费触摸事件，防止穿透到下层 ZoomableImageView
- **抽屉打开时仍可左右滑动切换图片**（见 4.10）

**图片宽度同步动画**：`applyDrawerProgress(progress)` 统一驱动所有抽屉视觉状态（progress 0=关闭, 1=打开）：
- 抽屉位移：`metadataDrawer.translationX = (1 - progress) * drawerWidthPx`
- 图片宽度：`primaryView`/`secondaryView` 的 `layoutParams.width` 从 `MATCH_PARENT` 平滑过渡到 `totalWidth - 320dp`
- 填充缩放：`drawerFillProgress = progress`，`resetToCenter` 据此在 fit/fill 间插值（见 4.7）
- 全屏隐藏：topBar 上滑、缩略图条/底部信息下滑，translationY 由 progress 驱动
- 起始宽度读 `layoutParams.width`（非 `View.width`，后者在时序异常时返回过期值导致关闭动画 no-op，详见 4.7）
- 动画期间 `ZoomableImageView.onSizeChanged()` 每帧自动调用 `resetToCenter()`
- ZoomableImageView 自动重新 layout 并按新宽度居中缩放

### 2.3 标签和描述编辑

> **2026-07-19 重构**：本节描述的弹窗 UI 已抽取为独立文件 [TagEditDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/TagEditDialog.kt)、[DescriptionEditDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/DescriptionEditDialog.kt)、[SourceUrlEditDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/SourceUrlEditDialog.kt)，详见 2.9。下文描述的样式与行为保持不变。

使用自定义 Dialog（圆角矩形 + 主题背景），替代原生 AlertDialog：

**通用弹窗样式**：
- 透明窗口背景 + `GradientDrawable` 圆角 16dp 背景
- 弹窗背景色：`#1E1E1E`（深色）/ `#FFFFFF`（浅色），比文本框背景 `#262626` 更深，形成层次
- 文本框背景色：`#262626`（深色）/ `#F9FAFB`（浅色）
- "取消"/"保存"按钮：`createDialogButton()` 生成，主按钮蓝色背景、次按钮次要色背景
- **动态高度**：弹窗 `show()` 后通过 `dialogView.measure(widthPx, AT_MOST maxHeightPx)` 测量实际高度，`window.setLayout(width, measuredHeight)` 自适应内容

**`showTagEditDialog`**：
- 380dp 宽，最大 450dp 高（动态自适应，标签增删后重新测量）
- 标签列表 `chipsBox`（垂直 LinearLayout）+ 输入行（EditText + "+" 按钮）
- 标签胶囊：`WRAP_CONTENT` 宽度（只占内容宽度），14sp 文字，padding (14,10)，圆角 16dp，蓝色标签配色
- 删除按钮：32dp 最小触控区，居中
- 标签文字 `maxEms=14` + `ellipsize=END` 防止过长溢出
- 标签增删后调用 `relayoutTagDialog()` 重新测量弹窗高度

**`showDescriptionEditDialog`**：
- 380dp 宽，最大 520dp 高（动态自适应）
- 多行 EditText，`gravity = TOP | START`（文字从左上角开始，不居中）
- `minLines=4`, `maxLines=8`, `TYPE_TEXT_FLAG_MULTI_LINE | TYPE_TEXT_FLAG_CAP_SENTENCES`
- hint "添加描述..." 斜体 + 淡色

**`showSourceUrlEditDialog`**：
- 380dp 宽，最大 300dp 高（动态自适应，仅包裹标题+输入框+按钮）
- 单行 EditText，`TYPE_TEXT_VARIATION_URI`
- hint "https://..." 斜体 + 淡色

**hint 文本样式**：
- 使用 `setItalicHint(editText, hintText)` 辅助方法
- 通过 `SpannableString` + `StyleSpan(ITALIC)` 设置斜体 hint
- hint 颜色 `colorHint()`：`#6B7280`（深色）/ `#9CA3AF`（浅色），比次文字更淡
- 正文（用户输入的文字）不斜体，与 hint 区分

**"+ 编辑标签"按钮**（抽屉中）：
- 排列在标签后面（同一 tagFlow 水平布局）
- 使用次要按钮样式（`colorButtonSecondaryBg`/`colorButtonSecondaryText`/`colorBorder`）与标签胶囊（蓝色）区分
- 圆角 10dp（比标签 16dp 更方正），文字 "+ 编辑标签"

保存时通过 `listener.onUpdateFile(fileId, json)` 回调。

### 2.4 双向实时同步

**原生 → 前端**：
- Kotlin `onUpdateFile` → `evaluateJavascript("window.__androidViewerBridge.onUpdateFile(...)")`
- 前端 bridge 调 `handleUpdateFile` 更新 state

**前端 → 原生**：
- Rust 命令 `android_update_native_item`（[lib.rs](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/src/lib.rs)）
- MainActivity.`updateNativeItem` + NativeGalleryView.`updateItem`（支持 tags/description/name/aiData 字段更新，幂等）
- 前端 useEffect 监听当前 viewingFile 的 FileNode 变化主动推送

### 2.5 Android 端 WebView ImageViewer 不渲染

App.tsx 渲染条件改为 `activeTab.viewingFileId && !useNativeViewer`。Android + 原生查看器开启时，ImageViewer 完全不 mount，避免双重渲染。

### 2.6 更多菜单

`showMoreMenu` 改为 5 项菜单（通过独立 [MoreMenuPopup.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/MoreMenuPopup.kt) 实现）：删除 / 重命名 / 复制到文件夹 / 移动到文件夹 / 幻灯片设置。

- 删除项使用 `colorDanger()`（红色）文字
- 其余项使用 `colorTextPrimary()`
- 锚点定位到「更多」按钮右下角，并做屏幕边界约束
- 点击菜单项后先 dismiss 弹窗，再触发对应动作

> 复制到文件夹 / 移动到文件夹两项会调用 `listener?.onCopyToFolder/onMoveToFolder` 通知 JS 端调用 Rust 命令 `android_show_folder_picker`，由 MainActivity 调起原生 `showFolderPickerDialog`（见 2.8）。

### 2.7 顶部工具栏

- 工具栏下移状态栏高度（`status_bar_height` 系统资源），`setPadding(24, statusBarHeight, 24, 0)` 避免与状态栏重叠
- 移除左右翻页按钮（‹ ›）
- **关闭按钮**由 X 图标改为返回箭头样式（`ic_lucide_arrow_left`），更符合系统返回语义
- **按钮顺序**（2026-07-19 调整）：← 返回 → [文件名] → ▶ 幻灯片 → ⟳ 旋转 → ⓘ 元数据 → 🗑 删除 → ↗ 分享 → ⋮ 更多
- 文件名移至关闭按钮右侧，字体放大至 18sp，仅显示文件名（不显示图片数量）

### 2.8 文件夹选择弹窗（复制/移动到文件夹）

WebView 端的 FolderPickerModal 弹窗无法覆盖原生查看器（WindowManager 窗口位于 WebView 之上），因此在原生层实现了等价的 [FolderPickerDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/FolderPickerDialog.kt)。

**触发流程**：
1. 用户在「更多」菜单点击「复制到文件夹」/「移动到文件夹」
2. NativeGalleryView 调 `listener?.onCopyToFolder/onMoveToFolder(fileId)` → JS 端收到回调
3. JS 端构造 folderTree JSON（包含 roots 和 folders 节点列表），调用 `invoke('android_show_folder_picker', { type, fileId, folderTreeJson })`
4. Rust 命令 `android_show_folder_picker` 通过 JNI 调 MainActivity.`showFolderPicker(type, fileId, folderTreeJson)`
5. MainActivity 转发给 `nativeGalleryView?.showFolderPickerDialog(...)`
6. 用户选择文件夹后调 `listener?.onFolderPickerConfirm(fileId, targetFolderId, type)` → JS 执行实际复制/移动
7. 移动操作确认后会调 `confirmMoveOut(fileId)` 从查看器 images 列表中移除该图片（避免显示已移走的图片）

**UI 与 WebView FolderPickerModal 一致**：
- 标题：「复制到文件夹...」/「移动到文件夹...」
- 搜索框（带放大镜图标 + X 清除按钮）
- 文件夹树（ListView，支持展开/折叠，按层级缩进）
- 取消 / 确认按钮（确认按钮默认禁用，选中文件夹后启用）

**文件夹树数据结构**：`FolderNode(id, name, parentId, children)` + `FolderTreeData(roots, folders)`，由 `parseFolderTree(json)` 解析。

**搜索/展开逻辑**：
- `flattenVisibleNodes`：DFS 扁平化可见节点（仅展开 `expandedIds` 中的节点）
- `computeMatchingSet`：计算匹配节点 + 祖先链（搜索时让匹配项可见）
- `computeExpandedForSearch`：搜索时自动展开所有匹配项的祖先链
- 清空搜索时恢复到只展开 roots

**选中高亮**：
- 选中行背景色变为 `colorAccent()`（蓝色）
- 文件名/文件夹图标变为白色
- Adapter 的 `selectedId` 必须通过 `updateData(...)` 同步更新，不能只调 `notifyDataSetChanged()`（详见 9.13）

### 2.9 弹窗组件独立化（2026-07-19 重构）

将原本内嵌在 `NativeGalleryView.kt` 中的 8 个弹窗抽取为 `com/aurora/gallery/dialogs/` 子包下的独立文件，便于维护。

**核心抽象**：[DialogTheme.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/DialogTheme.kt)
- `interface DialogTheme`：提供主题色方法（`isDarkTheme`、`colorDialogBg`、`colorTextBoxBg`、`colorTextPrimary`、`colorTextSecondary`、`colorBorder`、`colorAccent`、`colorHint`、`colorButtonSecondaryBg`、`colorButtonSecondaryText`、`colorTagBg`、`colorTagText`、`colorTagBorder`、`colorDanger` 默认实现）
- `object DialogUtils`：通用工具方法（`density`、`createRoundedBg`、`createDialogButton`、`setItalicHint`）
- `NativeGalleryView` 实现该接口，注入到各弹窗构造函数

**8 个独立弹窗**：

| 文件 | 类 | 用途 |
|------|----|------|
| `DeleteConfirmDialog.kt` | `DeleteConfirmDialog` | 删除确认（标题+消息+文件名+取消/删除） |
| `FolderPickerDialog.kt` | `FolderPickerDialog`（含 `FolderNode`、`FolderTreeData`、`FolderTreeAdapter`） | 文件夹选择（搜索+树+取消/确认） |
| `RenameDialog.kt` | `RenameDialog` | 重命名（系统 AlertDialog + EditText） |
| `TagEditDialog.kt` | `TagEditDialog` | 标签编辑（chips + 输入框） |
| `DescriptionEditDialog.kt` | `DescriptionEditDialog` | 描述编辑（多行 EditText） |
| `SourceUrlEditDialog.kt` | `SourceUrlEditDialog` | 来源网址编辑（单行 EditText） |
| `SlideshowSettingsDialog.kt` | `SlideshowSettingsDialog`（含 `SlideshowConfig`） | 幻灯片设置（SeekBar+RadioGroup+Switch） |
| `MoreMenuPopup.kt` | `MoreMenuPopup`（含 `MoreMenuItem`） | 更多菜单（PopupWindow 风格） |

**重构后 NativeGalleryView 中的 `showXxxDialog()` 方法**全部变为薄包装，仅负责传入业务回调。例如：

```kotlin
private fun showDeleteConfirmDialog() {
    val item = images.getOrNull(currentIndex) ?: return
    DeleteConfirmDialog(
        context = context,
        theme = this,
        fileName = item.name,
        onConfirm = { confirmDelete(item.fileId) }
    ).show()
}
```

**保留在 NativeGalleryView 中的业务逻辑**：
- `confirmDelete(fileId)`：从 images 列表移除 → 通知 JS 删除文件 → 切换下一张（或关闭查看器）
- `confirmMoveOut(fileId)`：从 images 列表移除（移动后从查看器消失，但不调 onDelete）
- `showFolderPickerDialog(type, fileId, folderTreeJson)`：检查 fileId 是否在 images 中，调用 FolderPickerDialog，移动时确认后调 `confirmMoveOut`

**清理**：重构后从 NativeGalleryView.kt 删除约 500 行内联弹窗 UI 代码（FolderNode/FolderTreeData/FolderTreeAdapter/parseFolderTree/flattenVisibleNodes/computeMatchingSet/computeExpandedForSearch/setItalicHint 等），并清理 11 个未使用的 import。

---

## 三、主题色对齐

### 3.1 颜色规范

> **重要**：`tailwind.config.js` 中 `gray` 色板已被 `...colors.neutral` 覆盖。网页端 `dark:bg-gray-800` 实际渲染为 `neutral-800` = `#262626`（纯中性灰），而非 Tailwind 默认的 `#1F2937`（带蓝色饱和度）。Android 代码中所有颜色必须使用 neutral 色板值，不可用 Tailwind 默认 gray 值。
>
> neutral 色板映射：50=`#FAFAFA` 100=`#F5F5F5` 200=`#E5E5E5` 400=`#A3A3A3` 500=`#737373` 700=`#404040` 800=`#262626` 900=`#171717`
> 自定义扩展：750=`#333333` 850=`#1E1E1E` 950=`#0A0A0A`

| 元素 | 深色 | 浅色 | 色板对应 |
|------|------|------|------|
| 图片查看背景 | `#171717` | `#E5E5E5` | neutral-900 / neutral-200 |
| 顶部菜单栏/底栏/缩略图条 | `#171717`（半透明 `#CC` 前缀） | `#E5E5E5`（半透明 `#E6` 前缀） | — |
| 抽屉面板背景 | `#171717` | `#FFFFFF` | neutral-900 |
| 弹窗背景 | `#1E1E1E` | `#FFFFFF` | gray-850 |
| 文本框背景（描述/来源网址/输入框） | `#262626` | `#F9FAFB` | neutral-800 / neutral-50 |
| 全览图背景 | `#262626` | `#F3F4F6` | neutral-800 |
| 边框 | `#262626` | `#E5E7EB` | neutral-800 |
| 次要按钮背景 | `#404040` | `#E5E7EB` | neutral-700 |
| 次要按钮文字 | `#A3A3A3` | `#404040` | neutral-400 / neutral-700 |
| hint 提示文字 | `#6B7280` | `#9CA3AF` | 比 colorTextSecondary 更淡 |
| 主文字 | `#F3F4F6` | `#262626` | — / neutral-800 |
| 次文字 | `#9CA3AF` | `#6B7280` | — |
| 强调色 | `#3B82F6` | `#3B82F6` | — |

### 3.2 主题应用

- `isDarkTheme` 字段通过 `open()` 的 `options.isDark` 从前端传入（根据 `state.settings.theme` 计算）
- `applyTheme()` 方法在 open 时应用主题到所有 UI（背景、顶栏、底栏、缩略图条、抽屉所有 TextView）
- 顶栏/底栏/缩略图条背景从 `#CC000000`（纯黑半透明）改为 `#CC171717`/`#E6E5E5E5`（主题色半透明）
- 浅色模式下顶栏标题文字为 `#262626`（neutral-800，深色），确保可见
- **沉浸模式背景色**：`applyTheme()` 中背景色 `setBackgroundColor(if (isImmersive) Color.BLACK else colorBg())`
  - 进入沉浸模式时背景色改为 `Color.BLACK`，退出还原主题色
  - 切换图片时 `open()` 会重入调用 `applyTheme()`，若处于沉浸模式则保持黑色，避免被重置为主题色导致闪烁

### 3.3 沉浸模式背景色动画

进入/退出沉浸模式时，背景色与 topBar/缩略图条/底部信息的位移动画同步过渡（200ms）：

```kotlin
private fun toggleImmersive() {
    if (drawerOpen) return  // 抽屉打开时不响应单击沉浸
    isImmersive = !isImmersive
    // topBar/缩略图条/底部信息 translationY 动画（200ms）
    // ...
    // 背景色与 UI 元素动画同步过渡：进入沉浸→黑色，退出沉浸→主题色
    val fromColor = if (isImmersive) colorBg() else Color.BLACK
    val toColor = if (isImmersive) Color.BLACK else colorBg()
    val colorAnim = ValueAnimator.ofObject(ArgbEvaluator(), fromColor, toColor)
    colorAnim.duration = 200
    colorAnim.addUpdateListener { anim -> setBackgroundColor(anim.animatedValue as Int) }
    colorAnim.start()
    listener?.onImmersiveToggle(isImmersive)
}
```

- 使用 `ValueAnimator` + `ArgbEvaluator` 实现颜色平滑过渡，避免瞬间切换的视觉跳变
- `close()` 中显式还原背景色：`setBackgroundColor(colorBg())`，防止下次打开残留黑色

### 3.4 Neutral 色板对齐修复（2026-07-15）

**问题**：深色模式下，新增组件（文本框、弹窗、按钮等）颜色偏蓝，与网页端 MetadataPanel 不一致。

**根因**：`tailwind.config.js` 中 `gray` 色板被 `...colors.neutral` 覆盖，网页端 `dark:bg-gray-800` 实际渲染为 `neutral-800` = `#262626`（纯中性灰）。但 Android 代码中错误引用了 Tailwind **默认** gray 值（`#1F2937` 等，带蓝色饱和度），未意识到项目已覆盖为 neutral 色板。

**修复**：将所有 Android 颜色辅助函数从 Tailwind 默认 gray 改为 neutral 色板：

| 颜色函数 | 旧值（Tailwind 默认 gray） | 新值（neutral 色板） |
|---|---|---|
| `colorBorder()` dark | `#1F2937` | `#262626` (neutral-800) |
| `colorTextPrimary()` light | `#1F2937` | `#262626` (neutral-800) |
| `colorTextBoxBg()` dark | `#1F2937` | `#262626` (neutral-800) |
| `colorDialogBg()` dark | `#1E1E1E` | `#1E1E1E` (gray-850，保持) |
| `colorButtonSecondaryBg()` dark | `#374151` | `#404040` (neutral-700) |
| `colorButtonSecondaryText()` dark | `#D1D5DB` | `#A3A3A3` (neutral-400) |
| `colorButtonSecondaryText()` light | `#374151` | `#404040` (neutral-700) |
| 全览图背景 dark (2处) | `#1F2937` | `#262626` (neutral-800) |

**预防措施**：在颜色函数区添加 neutral 色板映射注释，后续新增组件对照使用，避免再次引用 Tailwind 默认 gray 值。

---

## 四、手势与动画

本章是查看器体验的核心，涵盖跟手滑动、贝塞尔曲线、抖动修复、帧率优化和图片间隔。

### 4.1 跟手联动滑动

**目标**：滑动切换图片时，当前图片跟随手指移动，同时邻接图片（上一张/下一张）从屏幕外滑入，实现"跟手联动"——类似系统相册的体验，而非松手后才出现下一张。

**实现**（`ZoomableImageView` + `NativeGalleryView` 协作）：

`ZoomableImageView` 在 fit 状态（`currentScale <= 1.01f`）下检测水平主导滑动，进入 `swipeDragging` 模式：
- `ACTION_DOWN` 时记录 `swipeStartX = event.rawX`
- `onScroll` 中计算 `totalDx = e2.rawX - swipeStartX`，超过 `touchSlop` 且水平为主时触发
- 触发后重置 `swipeStartX = currentRawX`，使拖动偏移从 0 开始，避免 touchSlop 范围内的瞬间跳变
- 拖动中通过 `onSwipeDrag(dx)` 实时通知父级偏移量
- 松手时通过 `onSwipeEnd(dx, velocityX)` 通知最终位移和速度

`NativeGalleryView.onSwipeDrag(dx)`：
```kotlin
override fun onSwipeDrag(dx: Float) {
    if (isAnimating.get()) return
    if (dx == 0f) return
    val actView = activeView
    actView.translationX = dx
    val dir = if (dx > 0) -1 else 1
    val adjacentIndex = currentIndex + dir
    if (adjacentIndex < 0 || adjacentIndex >= images.size) return
    if (!swipeAdjacentPrepared || swipeAdjacentDirection != dir) {
        prepareSwipeAdjacent(dir)
    }
    val adj = swipeCachedAdjacentView
    if (adj != null && swipeAdjacentPrepared && swipeAdjacentDirection == dir) {
        adj.translationX = dx + dir * swipeCachedWidth
    }
}
```

- 当前图片 `translationX = dx` 跟随手指
- 邻接图片从 `dir * swipeCachedWidth`（屏幕外）同步滑入：`translationX = dx + dir * swipeCachedWidth`
- `prepareSwipeAdjacent` 首次调用时预加载邻接图到非活跃视图，缓存视图引用和宽度避免每帧重复计算
- **抽屉打开时不阻断滑动**：仅检查 `isAnimating`，不检查 `drawerOpen`，用户可在抽屉展开状态下正常左右滑动切换图片（见 4.9）

**滑动期间状态缓存**（避免每帧开销）：
```kotlin
private var swipeAdjacentPrepared = false
private var swipeAdjacentDirection = 0
private var swipeCachedWidth = 0f          // 屏幕宽度 + 间隔，避免每帧调用 width.toFloat()
private var swipeCachedAdjacentView: ZoomableImageView? = null  // 避免每帧调用 adjacentView()
```

### 4.2 翻页触发阈值

`onSwipeEnd` 判断翻页条件：
```kotlin
val threshold = resources.displayMetrics.density * SWIPE_THRESHOLD_DP  // 32dp
val shouldNavigate = abs(dx) > threshold || (abs(velocityX) > SWIPE_VELOCITY_THRESHOLD && abs(dx) > touchSlopForSwipe)
```

- **固定 32dp 阈值**：不使用屏幕宽度百分比，因为横竖屏宽度差异大（竖屏 1752px vs 横屏 2800px），百分比会导致竖屏难以触发、横屏过于敏感
- **速度 fallback**：速度超过 200 且位移超过 touchSlop 也可触发，支持轻快滑动

翻页时调 `navigateFromSwipe(dir, dx)`，未达阈值调 `bounceBackSwipe(dx, dir)` 回弹。

### 4.3 贝塞尔曲线插值器

```kotlin
private val SWIPE_INTERPOLATOR = PathInterpolator(0f, 0f, 0.2f, 1f)
```

`PathInterpolator(0f, 0f, 0.2f, 1f)` 是强 ease-out 曲线：进场初期快速移动，接近中心时平滑减速。应用于所有翻页动画（滑出、滑入、回弹），时长 280ms。

### 4.4 抖动修复（关键）

经历多轮调试，抖动有三个独立根因，均需修复：

#### 根因 1：GestureDetector e1 被 recycle

**现象**：手指滑动时图片疯狂左右移动，形成两张图重叠的视觉效果。`e2.x` 在两个值之间交替跳动（约 18px 差值）。

**根因**：`GestureDetector.onScroll` 的 `e1` 参数会被 Android 内部 recycle，导致 `swipeStartX = e1?.x` 在不同 `onScroll` 调用中返回不同值。

**修复**：
- 在 `onTouchEvent` 的 `ACTION_DOWN` 中记录 `swipeStartX = event.rawX`（使用 `getRawX()` 而非 `getX()`，rawX 不受 View 变换影响且更稳定）
- 在 `onScroll` 中使用 `e2.rawX - swipeStartX` 计算偏移，不再依赖 `e1.x`
- `swipeStartX` 只在 `ACTION_DOWN` 时设置一次，后续 `onScroll` 调用中保持不变

#### 根因 2：setImageDrawable 的 post { resetToCenter() } 延迟执行

**现象**：跟手滑动过程中图片位置突然跳动。

**根因**：`ZoomableImageView.setImageDrawable` 中使用 `post { resetToCenter() }`。当邻接视图在滑动开始时通过 Coil 加载图片，`setImageDrawable` 被调用，`post` 将 `resetToCenter` 延迟到下一个 UI 帧执行。此时用户正在拖动，`resetToCenter` 会重置 matrix 导致图片位置跳变。

**修复**：改为条件性立即调用：
```kotlin
override fun setImageDrawable(drawable: android.graphics.drawable.Drawable?) {
    super.setImageDrawable(drawable)
    if (drawable != null) {
        if (width > 0 && height > 0) {
            resetToCenter()  // 已 layout，立即调用
        } else {
            post { resetToCenter() }  // 未 layout，延迟到布局完成
        }
    }
}
```

#### 根因 3：onNavigate 回调导致 WebView 重新调用 open()

**现象**：翻页动画进行中图片突然闪烁/重载。

**根因**：翻页完成后 `listener?.onNavigate(currentIndex)` 回调 MainActivity，MainActivity 通过 `evaluateJavascript` 通知 WebView。WebView 的 `onNavigate` 处理逻辑会重新调用 `open(images, currentIndex, options)`，导致 `loadCurrent()` 被再次触发，在动画进行中重新加载图片。

**修复**：在 `open()` 中添加 `skipReload` 逻辑：
```kotlin
val skipReload = isOpen && startIndex == currentIndex && this.images.size == images.size
// ...
if (skipReload) {
    Log.i("NativeViewer", "open: skipping reload, already at index $currentIndex (onNavigate re-entry)")
} else {
    loadCurrent(animateIn = false)
}
```

当 `onNavigate` 回调导致重新进入 `open()` 且索引和图片列表未变时，跳过重新加载。

#### 根因 4：onNavigate 期间 JSON 序列化往返

**现象**：翻页动画期间帧率下降。

**根因**：`onNavigate` 在动画进行中同步触发，MainActivity 将当前图片列表 JSON 序列化（约 49KB）再通过 `evaluateJavascript` 传给 WebView 解析，阻塞主线程。

**修复**：将 `onNavigate` 回调延迟到动画结束的 `withEndAction` 中执行：
```kotlin
incoming.animate()
    .translationX(0f)
    .setDuration(duration)
    .setInterpolator(SWIPE_INTERPOLATOR)
    .withEndAction {
        isAnimating.set(false)
        // ... 清理状态 ...
        listener?.onNavigate(currentIndex)  // 延迟到动画结束后
        preloadNeighbors()
        thumbnailAdapter.highlight(currentIndex)
    }
    .start()
```

`navigateFromSwipe` 和 `navigateTo` 均做了此调整。

#### 根因 5：ViewPropertyAnimator 与拖动冲突

**现象**：手指按下开始新拖动时图片抖动。

**根因**：上一次回弹动画（`ViewPropertyAnimator`）仍在运行，与新拖动的 `translationX` 赋值冲突。

**修复**：`ZoomableImageView.onTouchEvent` 的 `ACTION_DOWN` 中通过 `onTouchDown()` 回调通知父级，父级取消残留动画：
```kotlin
// NativeGalleryView
override fun onTouchDown() {
    activeView.animate().cancel()
}
```

### 4.5 帧率优化

**目标**：在三星 Tab S8+（120Hz 屏幕）上达到接近系统相册的流畅度。

**诊断**：通过 `touch2.log` 分析帧间隔，发现帧率在 60-80fps 之间波动（8ms 和 16-17ms 交替），未达到 120fps 目标。

**优化措施**：

#### 1. 移除每帧日志

每帧 2 次 `Log.i` 调用（ZIV_Swipe + NativeGalleryView）涉及字符串格式化 + Binder IPC + 日志写入，约 0.5-1ms/次，2 次 = 1-2ms，足以将帧时间推过 8.33ms（120Hz 阈值）。

移除 `onSwipeDrag` 热路径中的所有 `Log.i`，仅保留 `ACTION_DOWN`/`ACTION_UP`/`TRIGGER` 等事件级日志。

#### 2. 硬件层加速

滑动期间启用 `LAYER_TYPE_HARDWARE`，将视图渲染缓存为 GPU 纹理，`translationX` 变为纯纹理位移，无需重新绘制：

```kotlin
private fun setSwipeHardwareLayers(enabled: Boolean) {
    val layerType = if (enabled) View.LAYER_TYPE_HARDWARE else View.LAYER_TYPE_NONE
    primaryView.setLayerType(layerType, null)
    secondaryView.setLayerType(layerType, null)
}
```

- `prepareSwipeAdjacent` 中启用
- `navigateFromSwipe` / `bounceBackSwipe` 的 `withEndAction` 中关闭
- `cleanupSwipeAdjacentImmediate` 中关闭

#### 3. 热路径值缓存

`onSwipeDrag` 每帧调用，避免：
- `width.toFloat()`（视图属性访问）
- `adjacentView()`（tag 判断）

改为在 `prepareSwipeAdjacent` 时一次性缓存到 `swipeCachedWidth` 和 `swipeCachedAdjacentView`。

#### 4. 延迟 onNavigate 回调

如 4.4 根因 4 所述，将 JSON 序列化往返延迟到动画结束后。

**结果**：用户确认"效果非常流畅"，帧率达到 120fps。

### 4.6 滑动图片间隔

**问题**：竖屏下左右滑动切换图片时，两张图片紧贴在一起无间隔。横屏正常（图片有左右黑边留白，自然有间隔）。

**根因**：两个视图均为 `MATCH_PARENT`（全屏宽度），邻接视图定位 `dir * cw`（cw = 屏幕宽度）使其边缘正好与当前视图边缘相接。竖屏下图片填满全宽，图片内容也紧贴；横屏下图片有 letterboxing，内容有自然间隔。

**修复**：引入固定间隔常量，所有滑动定位计算使用 `cw + gapPx`：

```kotlin
companion object {
    /** 翻页时两张图片之间的视觉间隔（dp），避免竖屏下图片紧贴 */
    private const val SWIPE_GAP_DP = 16f
}

/** 翻页间隔的像素值 */
private val swipeGapPx: Float get() = resources.displayMetrics.density * SWIPE_GAP_DP
```

**影响的位置**：

| 函数 | 修改 | 说明 |
|------|------|------|
| `prepareSwipeAdjacent` | `adj.translationX = dir * (cw + gapPx)`；`swipeCachedWidth = cw + gapPx` | 邻接视图初始定位含间隔，缓存宽度含间隔 |
| `onSwipeDrag` | 无需修改（使用 `swipeCachedWidth`） | 自动包含间隔 |
| `navigateFromSwipe` | `cw = width.toFloat() + swipeGapPx`；outgoing 滑出到 `-direction * cw` | 滑出动画目标含间隔 |
| `bounceBackSwipe` | 无需修改（使用 `swipeCachedWidth`） | 自动包含间隔 |
| `navigateTo` | `cw = width.toFloat() + swipeGapPx`；incoming 定位和 outgoing 滑出均含间隔 | 缩略图点击触发的翻页也有一致间隔 |

**视觉效果**：滑动时两张图片之间保持 16dp 间隔，横竖屏统一适用。调整 `SWIPE_GAP_DP` 常量即可改变间隔大小。

### 4.7 抽屉展开/收起动画

抽屉动画采用 **progress 驱动**架构：单一浮点值 `progress`（0=关闭, 1=打开）统一驱动所有视觉状态，动画和跟手使用同一套渲染逻辑，确保一致性。

#### 4.7.1 `applyDrawerProgress(progress)` — 统一视觉驱动

所有抽屉视觉状态由这一个方法驱动，动画的 `addUpdateListener` 和跟手的 `onVerticalSwipeDrag` 都调用它：

```kotlin
private fun applyDrawerProgress(progress: Float) {
    val drawerWidthPx = (resources.displayMetrics.density * 320)
    val totalWidth = width.toFloat()
    val imageW = (totalWidth - progress * drawerWidthPx).toInt().coerceAtLeast(0)
    // 抽屉位移
    metadataDrawer.translationX = (1f - progress) * drawerWidthPx
    // 图片宽度 + 填充进度（在 layoutParams 之前设置，确保 onSizeChanged→resetToCenter 读到最新值）
    primaryView.drawerFillProgress = progress
    secondaryView.drawerFillProgress = progress
    // 全屏宽度基准（见 4.7.4）
    primaryView.drawerFullWidth = totalWidth
    secondaryView.drawerFullWidth = totalWidth
    primaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
    secondaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
    // topBar 向上滑出（沉浸模式下始终保持隐藏，不受抽屉进度影响）
    if (topBar.height > 0) {
        topBar.translationY = if (isImmersive) -topBar.height.toFloat() else -topBar.height * progress
    }
    // 缩略图条向下滑出（沉浸模式下始终保持隐藏）
    if (thumbnailStrip.height > 0) {
        thumbnailStrip.translationY = if (isImmersive) height.toFloat() else thumbnailStrip.height * progress
    }
    // 底部信息向下滑出（沉浸模式下始终保持隐藏）
    if (bottomInfo.visibility == VISIBLE && bottomInfo.height > 0) {
        bottomInfo.translationY = if (isImmersive) height.toFloat() else bottomInfo.height * progress
    }
}
```

- 在 `layoutParams` 之前设置 `drawerFillProgress` 和 `drawerFullWidth`，确保 `onSizeChanged` → `resetToCenter()` 能读到最新值
- **沉浸模式兼容**（2026-07-12 修复）：抽屉打开/关闭过程中若处于沉浸模式，topBar/缩略图条/底部信息始终保持隐藏状态（`if (isImmersive)` 分支），避免抽屉关闭动画过程中这些 UI 元素重新出现再被隐藏造成的闪烁

#### 4.7.2 `animateDrawerTo(open, fromProgress)` — 动画收尾

`toggleDrawer()` 在打开抽屉前保存当前沉浸状态（`immersiveBeforeDrawer`），翻转 `drawerOpen` 后调用 `animateDrawerTo`；跟手松手后也调用此方法从当前位置动画到目标状态：

```kotlin
private fun toggleDrawer() {
    if (!drawerOpen) {
        // 即将打开抽屉——保存当前沉浸状态，关闭时恢复
        immersiveBeforeDrawer = isImmersive
    }
    drawerOpen = !drawerOpen
    val currentProgress = primaryView.drawerFillProgress
    animateDrawerTo(drawerOpen, fromProgress = currentProgress)
}
```

`animateDrawerTo` 使用 `ValueAnimator` 从 `fromProgress` 动画到目标（0 或 1），280ms，`AccelerateDecelerateInterpolator`：
- `addUpdateListener` 每帧调 `applyDrawerProgress(anim.animatedValue)`
- `onAnimationEnd`（非 cancelled 时）：精确设置最终状态 + 调 `listener?.onImmersiveToggle(...)` 同步系统状态栏
- `cancelled` 标志检测快速连点取消，取消时跳过最终状态设置由新动画接管
- 显式设置最终 `layoutParams` 宽度（打开=精确像素，关闭=MATCH_PARENT）防止浮点漂移
- `drawerWidthAnimator` 字段跟踪当前动画，`close()` 时 cancel 防止残留更新

**沉浸状态与抽屉状态解耦**（2026-07-12 修复）：

`onAnimationEnd` 不再直接设 `isImmersive = open`，而是根据 open/close 分支处理：

```kotlin
override fun onAnimationEnd(animation: Animator) {
    drawerWidthAnimator = null
    if (cancelled) return
    applyDrawerProgress(targetProgress)
    // 显式设置最终 layoutParams 宽度
    val finalW = if (open) (totalWidth - drawerWidthPx).toInt().coerceAtLeast(0) else LayoutParams.MATCH_PARENT
    primaryView.layoutParams = LayoutParams(finalW, LayoutParams.MATCH_PARENT)
    secondaryView.layoutParams = LayoutParams(finalW, LayoutParams.MATCH_PARENT)
    if (open) {
        // 抽屉打开：隐藏系统状态栏，但不改变 isImmersive（保留单击沉浸状态）
        listener?.onImmersiveToggle(true)
    } else {
        // 抽屉关闭：恢复抽屉打开前的沉浸状态
        isImmersive = immersiveBeforeDrawer
        listener?.onImmersiveToggle(immersiveBeforeDrawer)
        // 还原背景色：若之前在沉浸模式则保持黑色，否则还原主题色
        setBackgroundColor(if (immersiveBeforeDrawer) Color.BLACK else colorBg())
    }
}
```

- **抽屉打开**：仅调 `onImmersiveToggle(true)` 隐藏系统状态栏（视觉上等同沉浸），但不修改 `isImmersive` 字段，保留单击触发的沉浸状态
- **抽屉关闭**：恢复 `immersiveBeforeDrawer` 保存的沉浸状态，并据此设置背景色
- 这样沉浸模式下开关抽屉后能正确回到沉浸状态（topBar 隐藏、背景黑色），而非恢复 topBar 显示

`onTouchDown` 中也保存 `immersiveBeforeDrawer`（垂直跟手可能打开抽屉）：

```kotlin
override fun onTouchDown() {
    if (isAnimating.get()) return
    // ... 清理动画 ...
    drawerDragStartOpen = drawerOpen
    drawerDragStartProgress = primaryView.drawerFillProgress
    if (!drawerOpen) {
        // 可能即将通过垂直手势打开抽屉——保存沉浸状态
        immersiveBeforeDrawer = isImmersive
    }
    drawerWidthAnimator?.cancel()
    drawerWidthAnimator = null
}
```

#### 4.7.3 全屏样式（topBar + 系统状态栏同步隐藏）

抽屉展开时形成全屏显示样式：
- **topBar**：`translationY = -topBar.height * progress`（非沉浸）或 `-topBar.height`（沉浸，始终保持隐藏），向上滑出隐藏
- **缩略图条 / 底部信息**：`translationY = height * progress`（非沉浸）或 `height`（沉浸），向下滑出隐藏
- **系统状态栏**：`animateDrawerTo` 的 `onAnimationEnd` 调 `listener?.onImmersiveToggle(...)`，MainActivity 据此显示/隐藏系统 UI
- **沉浸模式兼容**（2026-07-12 修复）：`applyDrawerProgress` 中所有 UI 元素的 translationY 均检查 `isImmersive`，沉浸模式下无论抽屉 progress 为何都保持隐藏。避免抽屉关闭动画过程中（progress 从 1 → 0），topBar 等元素因 progress 减小而短暂重新出现，造成闪烁
- `close()` 中检查 `isImmersive || drawerOpen`，若其中任一为 true 则调 `listener?.onImmersiveToggle(false)` 恢复系统状态栏（因为抽屉打开时虽未设 `isImmersive=true`，但状态栏已被隐藏，需要恢复）

```kotlin
// close() 中的状态栏恢复
if (isImmersive || drawerOpen) {
    listener?.onImmersiveToggle(false)
}
isImmersive = false
setBackgroundColor(colorBg())  // 还原主题色，避免下次打开残留黑色
```

#### 4.7.4 填充模式（fill）与 `drawerFullWidth` 修复

抽屉打开时图片从"适应"（fit，整图可见留白）平滑过渡到"填充"（fill，裁剪填满视图），关闭时反向。

`ZoomableImageView` 的 `drawerFillProgress` 字段（0=fit, 1=fill）驱动 `resetToCenter()` 在 fit/fill scale 之间插值。

**"缩小再还原"问题修复**：最初 `fitS` 和 `fillS` 都基于当前视图宽度 `vw` 计算，而 `vw` 随抽屉展开减小。对于横屏图片（宽 > 高），`fitS = min(vw/logicW, vh/logicH)` 在中间过程因 `vw` 减小而变为宽度受限导致下降，而 `fillS` 同时变化，造成 fitScale 先降后升——视觉上图片缩小再还原。

修复：新增 `drawerFullWidth` 字段（全屏宽度基准，由 `applyDrawerProgress` 设置为 `NativeGalleryView.width`）。`resetToCenter()` 中：
- `fitS` 基于 `drawerFullWidth`（**固定**全屏宽度），不随 vw 变化
- `fillS` 基于当前 `vw`（随抽屉宽度变化），实现"填充剩余区域"

```kotlin
val fitVw = if (drawerFullWidth > 0f) drawerFullWidth else vw
val fitS = min(fitVw / logicW, vh / logicH)   // 适应：基于全屏宽度（固定）
val fillS = max(vw / logicW, vh / logicH)     // 填充：基于当前视图宽度
fitScale = fitS + (fillS - fitS) * drawerFillProgress
```

效果：
- **横屏图片**（fitS ≈ fillS）：fitScale 全程恒定，图片不缩放，只是视图变窄裁剪
- **竖屏图片**：fitS 固定（小），fillS 随 vw 变化，fitScale 平滑放大填满剩余区域

`close()` 重置 `drawerFillProgress = 0f`。

#### 4.7.5 起始宽度读 `layoutParams.width`（非 `View.width`）

`View.width` 返回上次 layout pass 的实际宽度，在某些布局时序下返回过期值。实测抽屉打开动画结束后 `primaryView.width` 报告 2800（全屏宽度），而最后一次 `onSizeChanged` 显示为 2120（压缩后宽度），导致关闭动画 `startWidth=2800=targetWidth` 变成 no-op。

`animateDrawerTo` 通过 `fromProgress` 参数（调用方传 `primaryView.drawerFillProgress`）避免直接读宽度，`drawerFillProgress` 可靠反映当前状态。

#### 4.7.6 旋转屏幕处理（onMeasure）

抽屉打开时 `primaryView`/`secondaryView` 的 `layoutParams.width` 是固定像素值，旋转后不会自动适配新屏幕宽度，导致图片偏左、中间留白。

关键时序问题：`onSizeChanged` 在 layout 遍历**期间**被调用，此时子 View 已用旧 `layoutParams` 完成测量。即使同步设置新 `layoutParams`，也不会在当前 layout pass 生效，会被推迟到下一次 layout——导致连续旋转时 `layoutParams` 永远落后一帧。

修复：覆盖 `onMeasure`（而非 `onSizeChanged`），在 `super.onMeasure()` **之前**设置子 View 的 `layoutParams`，同一 pass 即生效：
```kotlin
override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
    val w = MeasureSpec.getSize(widthMeasureSpec)
    val h = MeasureSpec.getSize(heightMeasureSpec)
    if (w > 0 && h > 0 && drawerOpen && width > 0 && w != width) {
        drawerWidthAnimator?.cancel()
        val drawerWidthPx = (resources.displayMetrics.density * 320).toInt()
        val imageW = (w - drawerWidthPx).coerceAtLeast(0)
        primaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
        secondaryView.layoutParams = LayoutParams(imageW, LayoutParams.MATCH_PARENT)
    }
    super.onMeasure(widthMeasureSpec, heightMeasureSpec)
}
```
`onSizeChanged` 仅保留 `drawerWidthAnimator?.cancel()` + 重新应用 `topBar.translationY`（旋转后 topBar.height 可能变化）。

**调试日志**：
- `ZIV_Size`：`onSizeChanged` 每次 fire 时记录 w/h/oldw/oldh/fillProg + 计数器
- `ZIV_Reset`：`resetToCenter` 计算结果（fitVw/fitS/fillS/fillProg/fitScale 新旧值对比），可发现不连续跳变
- `ZIV_Img`：`setImageDrawable` 调用时机
- `NativeGalleryView` `animateDrawerTo` 日志记录 `fromProgress`/`targetProgress`/`primaryW`/`lpW`/`fillProg`

### 4.8 返回键交互

返回键采用三层防御机制，确保抽屉和查看器均可通过返回键关闭：

**第一层：`dispatchKeyEvent`（NativeGalleryView 直接处理）**

NativeGalleryView 通过 `WindowManager.addView()` 以 `TYPE_APPLICATION_PANEL` 窗口添加。`open()` 时调用 `requestFocus()` 使窗口获取焦点，从而直接在 `dispatchKeyEvent` 中接收 `KEYCODE_BACK`：

```kotlin
override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
        if (event.action == KeyEvent.ACTION_UP) {
            if (drawerOpen) closeDrawer()
            else if (isOpen) listener?.onClose()
        }
        return true  // 消费事件，阻止传播到 OnBackPressedDispatcher
    }
    return super.dispatchKeyEvent(event)
}
```

- 抽屉打开 → `closeDrawer()` → `toggleDrawer()` 收起抽屉
- 抽屉未打开但查看器打开 → `listener?.onClose()` 关闭查看器
- `init` 中设置 `isFocusable = true` + `isFocusableInTouchMode = true` 确保可获取焦点

**第二层：`OnBackPressedDispatcher`（Activity 级回调）**

`MainActivity.setupBackPressedHandler()` 注册 `OnBackPressedCallback`，当 NativeGalleryView 窗口未获取焦点时作为后备：
- `ngv.isDrawerOpen()` → `ngv.closeDrawer()`
- 否则 → `closeNativeViewer()` + `onClose()` 回调
- 均不打开时 → 向 WebView 派发 `android-back-press` 事件

**第三层：前端 `handleAndroidBackPress`（WebView 事件处理）**

前端监听 `android-back-press` 事件，通过 ref 访问最新状态（避免闭包过期）：
- `useNativeViewerRef.current && nativeViewerActiveRef.current` → `invoke('android_close_drawer')`
- Rust 命令 `android_close_drawer` → JNI 调 `MainActivity.closeNativeDrawer()`

> **闭包过期修复**：`nativeViewerActive` 和 `useNativeViewer` 是 React state/derived value，但 useEffect 依赖数组不包含它们。使用 `useRef` 镜像最新值，事件处理器通过 `.current` 访问，避免 stale closure 导致条件判断始终为 false。

**`onClose` 回调立即重置状态**：

`MainActivity.onClose` 回调中增加 `view.close()` 调用，确保查看器状态（`isOpen`、`drawerOpen`、抽屉 translation、view 宽度、immersive）在窗口移除时立即重置，而非等待异步的 `closeNativeViewer()` 路径。

**Android 返回手势优先级**：
1. 收起元数据抽屉
2. 关闭原生查看器
3. 关闭右键菜单
4. 退出全屏
5. 退出编辑模式
6. 取消选择
7. 关闭标签页

### 4.9 残留邻接视图清理

`cleanupSwipeAdjacentImmediate()` 用于在非滑动路径（如缩略图点击）切换图片时，清理可能残留的邻接视图：

```kotlin
private fun cleanupSwipeAdjacentImmediate() {
    if (swipeAdjacentPrepared) {
        val adj = swipeCachedAdjacentView ?: adjacentView()
        adj.animate().cancel()
        adj.translationX = 0f
        adj.visibility = GONE
        adj.setImageDrawable(null)
        swipeAdjacentPrepared = false
        swipeAdjacentDirection = 0
    }
    swipeCachedAdjacentView = null
    swipeCachedWidth = 0f
    setSwipeHardwareLayers(false)
}
```

`navigateTo` 开头调用此方法，防止跟手滑动残留的邻接视图影响后续动画。

### 4.10 抽屉打开时滑动切换图片

抽屉展开后，用户仍可左右滑动切换图片，无需先关闭抽屉。

**手势处理器调整**：`onSwipeDrag`、`onSwipeEnd`、`onTouchDown` 仅检查 `isAnimating`，不再检查 `drawerOpen`：
- `onSingleTapConfirmed` 仍保留 `if (drawerOpen) return`，抽屉打开时单击不触发沉浸模式切换

**宽度计算调整**：抽屉打开时 `primaryView`/`secondaryView` 宽度被压缩为 `totalWidth - 320dp`，翻页滑动需基于压缩后的宽度计算邻接图位置。新增 `effectiveViewWidth()` 辅助方法：

```kotlin
private fun effectiveViewWidth(): Float {
    val pw = primaryView.width
    return if (pw > 0) pw.toFloat() else width.toFloat()
}
```

`prepareSwipeAdjacent`、`navigateFromSwipe`、`navigateTo` 中的 `width.toFloat()` 均替换为 `effectiveViewWidth()`，确保：
- 邻接图定位在压缩后视图的屏幕外（`dir * (effectiveViewWidth + swipeGapPx)`）
- 翻页动画滑出距离与压缩后视图宽度一致
- 回弹动画通过 `swipeCachedWidth`（已使用 `effectiveViewWidth()` 计算）保持一致

### 4.11 垂直手势控制抽屉（跟手呼出/收起）

查看图片时，任意位置（边缘区域除外）垂直滑动可呼出/收起抽屉，过程跟手。

**手势检测**（`ZoomableImageView.onScroll`）：在 fit 状态下，与水平翻页手势互斥地检测垂直主导滑动：
- `ACTION_DOWN` 记录 `swipeStartY = event.rawY`（rawY 避免 e1 recycle）
- `onScroll` 中计算 `totalDy = e2.rawY - swipeStartY`，超过 `touchSlop` 且垂直为主（`|totalDy| > |totalDx| * 1.5f`）时触发 `verticalSwipeDragging` 模式
- 触发后通过 `onVerticalSwipeDrag(dy)` 实时通知父级偏移量
- 松手时 `onVerticalSwipeEnd(dy, velocityY)` 通知最终位移和速度（`VelocityTracker` 计算）

**边缘区域屏蔽**：屏幕顶部/底部 24dp 内缘不触发垂直手势，避免与系统状态栏下拉、返回主界面手势冲突：
```kotlin
val screenHeight = resources.displayMetrics.heightPixels
val edgeZone = resources.displayMetrics.density * 24
val startInVerticalEdge = swipeStartY < edgeZone || swipeStartY > screenHeight - edgeZone
if (!swipeTriggered && !verticalSwipeTriggered && !startInVerticalEdge && ...) { /* 触发 */ }
```
水平翻页手势不受边缘屏蔽影响。

**方向限制**：抽屉只响应"打开方向"的滑动，反向滑动无效果（避免抽屉已展开时上滑仍触发关闭）：
- 抽屉打开（`startProgress=1`）：只允许 progress 减小（向下滑收起），上滑无效果 → `progress.coerceAtMost(startProgress)`
- 抽屉关闭（`startProgress=0`）：只允许 progress 增大（向上滑呼出），下滑无效果 → `progress.coerceAtLeast(startProgress)`

```kotlin
override fun onVerticalSwipeDrag(dy: Float) {
    if (isAnimating.get()) return
    val drawerWidthPx = (resources.displayMetrics.density * 320)
    var progress = (drawerDragStartProgress - dy / drawerWidthPx).coerceIn(0f, 1f)
    if (drawerDragStartOpen) progress = progress.coerceAtMost(drawerDragStartProgress)
    else progress = progress.coerceAtLeast(drawerDragStartProgress)
    applyDrawerProgress(progress)
}
```

**跟手状态记录**：`onTouchDown` 中记录 `drawerDragStartOpen = drawerOpen` 和 `drawerDragStartProgress = primaryView.drawerFillProgress`，并取消正在进行的抽屉动画让跟手接管。

**松手判定**（`onVerticalSwipeEnd`）：根据当前进度和速度决定打开/关闭或回弹：
- 抽屉打开时：`progress < 0.5` 或 `velocityY > 500`（快速下滑）→ 关闭，否则保持打开
- 抽屉关闭时：`progress > 0.5` 或 `velocityY < -500`（快速上滑）→ 打开，否则保持关闭
- 判定后调 `animateDrawerTo(targetOpen, fromProgress = currentProgress)` 平滑收尾

**与水平翻页的关系**：垂直和水平手势在 `onScroll` 中互斥判定（先触发者独占），`swipeTriggered` 和 `verticalSwipeTriggered` 互斥。抽屉打开时仍可水平滑动切换图片（见 4.10），此时垂直手势方向限制为只允许收起。

---

## 五、ZoomableImageView 手势处理

`ZoomableImageView` 是支持双击缩放、pinch-zoom、pan、fling 的 ImageView，矩阵变换通过 `Matrix` 实现，避免创建中间 Bitmap。

### 5.1 缩放

- `ScaleGestureDetector` 处理 pinch-zoom，缩放范围 `[0.85, MAX_SCALE]`（`MAX_SCALE = 8f`）
- 中心点缩放：基于手指中点，公式 `translateX = focusX - (focusX - translateX) * scaleDelta`
- 缩放小于 1 时回弹到 1.0
- 双击缩放：基于双击点，1x → 2x → MAX_SCALE
- **缩放后边界 clamp**（2026-07-12 修复）：`onScale` 末尾调用 `clampTranslateToBounds()`，避免快速收拢双指时 focus 在屏幕边缘导致图片缩小后完全脱离屏幕

### 5.2 平移

- 已放大状态（`currentScale > 1.01f`）下跟随手指平移
- 平移期间实时调用 `clampTranslateToBounds()`，确保图片不飞出屏幕边缘（2026-07-12 修复）
- `onFling` 使用 `OverScroller` 实现惯性滑动，fling 边界与 clamp 边界一致

### 5.3 翻页手势

仅在 fit 状态（`currentScale <= 1.01f`）下允许翻页手势：
- `ACTION_DOWN` 记录 `swipeStartX = event.rawX`、`swipeStartY = event.rawY`
- `onScroll` 检测水平主导（`|totalDx| > touchSlop` 且 `|totalDx| > |totalDy| * 1.5f`）
- 触发后进入 `swipeDragging` 模式，通过 `onSwipeDrag(dx)` 实时通知父级
- 松手时 `onSwipeEnd(dx, velocityX)` 通知父级决定翻页/回弹
- `ACTION_DOWN` 时通过 `onTouchDown()` 通知父级取消残留动画

### 5.4 垂直抽屉手势

与翻页手势互斥，仅在 fit 状态下检测垂直主导滑动（详见 4.11）：
- `onScroll` 检测垂直主导（`|totalDy| > touchSlop` 且 `|totalDy| > |totalDx| * 1.5f`），排除顶部/底部 24dp 边缘区域
- 触发后进入 `verticalSwipeDragging` 模式，通过 `onVerticalSwipeDrag(dy)` 实时通知父级
- 松手时 `onVerticalSwipeEnd(dy, velocityY)` 通知父级决定打开/关闭或回弹
- `swipeTriggered` 与 `verticalSwipeTriggered` 互斥，先触发者独占本次手势

### 5.5 旋转

通过 `rotationDegrees` 字段管理（90 度递增），`setRotationDegrees` 设置后重新计算 fit scale 和居中位置。旋转后逻辑宽高互换。

### 5.6 边界回弹

缩放超过 1 时，平移到边界外则回弹到边界（`bounceBackToBounds`）。

### 5.7 `clampTranslateToBounds()` — 实时边界约束（2026-07-12 新增）

**问题**：拖动放大后的图片时，图片会漂移到屏幕外，松手后才回弹，体验不佳。

**修复**：新增 `clampTranslateToBounds()` 方法，在拖动（`onScroll`）、fling、缩放（`onScale`）期间实时约束 translate 值，确保图片至少贴住屏幕一条边：

```kotlin
private fun clampTranslateToBounds() {
    val d = drawable ?: return
    val vw = width.toFloat()
    val vh = height.toFloat()
    if (vw <= 0f || vh <= 0f) return
    val isRotated = rotationDegrees == 90 || rotationDegrees == 270
    val logicW = (if (isRotated) d.intrinsicHeight else d.intrinsicWidth).toFloat() * fitScale * currentScale
    val logicH = (if (isRotated) d.intrinsicWidth else d.intrinsicHeight).toFloat() * fitScale * currentScale
    if (logicW <= vw) {
        translateX = (vw - logicW) / 2f  // 图片比视图窄：居中
    } else {
        translateX = translateX.coerceIn(vw - logicW, 0f)  // 图片比视图宽：限制在 [v-logic, 0]
    }
    // Y 方向同理
}
```

- 图片某边长 ≤ 视图：该方向居中（`translate = (v - logic) / 2f`）
- 图片某边长 > 视图：translate 限制在 `[v - logic, 0]`（图片至少贴住一条边，不会完全脱离屏幕）
- 调用点：`onScroll` 平移后、`onScale` 缩放后、`onSizeChanged` 尺寸变化后

### 5.8 `allowZoom` — 抽屉打开时禁用缩放（2026-07-12 新增）

**问题**：抽屉打开时缩放会与 `drawerFillProgress` 填充逻辑冲突，导致图片异常缩放。

**修复**：新增 `allowZoom` 字段（默认 true），在 `onDoubleTap` 和 `onScaleBegin` 开头检查：

```kotlin
override fun onDoubleTap(e: MotionEvent): Boolean {
    if (!allowZoom) return false
    // ...
}
override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
    if (!allowZoom) return false
    // ...
}
```

`NativeGalleryView.applyDrawerProgress` 中根据进度设置：
```kotlin
primaryView.allowZoom = progress <= 0.01f  // 抽屉打开（progress>0）时禁用缩放
secondaryView.allowZoom = progress <= 0.01f
```

### 5.9 `onScaleBegin` 清理手势状态（2026-07-12 修复）

**问题**：pinch-zoom 开始时，之前的 `onScroll` 可能已设置 `swipeTriggered`/`verticalSwipeTriggered` 标志，导致缩放过程中误触发翻页或抽屉控制。

**修复**：`onScaleBegin` 开头清理所有 swipe 相关状态：

```kotlin
override fun onScaleBegin(detector: ScaleGestureDetector): Boolean {
    if (!allowZoom) return false
    isAnimating = false
    scroller.abortAnimation()       // 取消 fling
    removeCallbacks(flingRunnable)
    swipeTriggered = false          // 清理 swipe 状态
    swipeDragging = false
    verticalSwipeTriggered = false
    verticalSwipeDragging = false
    return true
}
```

同时 `onScroll` 开头新增 `if (scaleDetector.isInProgress) return false`，双指缩放进行中时不处理 scroll 事件，避免误触发翻页/抽屉手势。

### 5.10 `onDoubleTap` / `animateScaleTo` fling 取消（2026-07-12 修复）

**问题**：双击缩放或动画缩放期间，`flingRunnable` 可能仍在运行，覆盖缩放动画设置的 translate 值，导致图片位置漂移。

**修复**：在 `onDoubleTap`、`animateScaleTo` 开头取消 fling：

```kotlin
override fun onDoubleTap(e: MotionEvent): Boolean {
    if (!allowZoom) return false
    scroller.abortAnimation()
    removeCallbacks(flingRunnable)
    // ... 缩放逻辑 ...
}

private fun animateScaleTo(targetScale: Float, focusX: Float, focusY: Float) {
    scroller.abortAnimation()
    removeCallbacks(flingRunnable)
    // ... 动画逻辑 ...
}
```

### 5.11 `animateScaleTo` fit-center 公式（2026-07-12 修复）

**问题**：双击缩小到 1x 时，使用 focus 公式计算 target translate 会导致图片未居中（下方留白）。

**修复**：`targetScale <= 1.001f` 时改用 fit 居中公式，而非 focus 公式：

```kotlin
val useFitCenter = targetScale <= 1.001f
if (useFitCenter) {
    // fit 居中：translate = (v - logic * fitScale) / 2f
    targetTx = (vw - logicW * fitScale) / 2f
    targetTy = (vh - logicH * fitScale) / 2f
} else {
    // focus 公式：保持点击点不动
    targetTx = focusX - (focusX - startTx) * scaleDelta
    targetTy = focusY - (focusY - startTy) * scaleDelta
}
```

动画结束后若 `currentScale > 1.01f`，调用 `bounceBackToBounds()` 确保 focus 缩放后图片在边界内（focus 缩放只保证点击点不动，不保证整体在边界内）。

### 5.12 `onSizeChanged` 保留缩放状态（2026-07-12 修复）

**问题**：进入/退出沉浸模式时窗口尺寸变化（status bar 显示/隐藏），`onSizeChanged` 调用 `resetToCenter()` 会重置用户的缩放状态。

**修复**：根据 `currentScale` 分支处理：

```kotlin
override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
    super.onSizeChanged(w, h, oldw, oldh)
    if (w > 0 && h > 0) {
        if (currentScale > 1.01f) {
            // 放大状态：保留缩放，只重新计算 fitScale 并 clamp translate
            val fitS = min(fitVw / logicW, vh / logicH)
            val fillS = max(vw / logicW, vh / logicH)
            fitScale = fitS + (fillS - fitS) * drawerFillProgress
            clampTranslateToBounds()
            applyMatrix()
        } else {
            // fit 状态：重新居中
            resetToCenter()
        }
    }
}
```

### 5.13 `ACTION_UP` bounceBack 触发条件（2026-07-12 修复）

`ACTION_UP` 时检查 `isAnimating` 和 `currentScale`，避免在双击缩放动画运行期间触发 `bounceBackToBounds`：

```kotlin
if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
    // ... 翻页/垂直拖动结束处理 ...
    // 注意：isAnimating 期间（双击缩放动画正在跑）不要触发 bounceBackToBounds，
    // 否则 bounce 会基于中间帧 scale 算出错误的 target，覆盖双击缩放的 target。
    // 双击缩放动画结束后会自行调用 bounceBackToBounds（见 animateScaleTo）。
    if (!isAnimating && currentScale > 1.01f) {
        bounceBackToBounds()
    }
}
```

---

## 六、Coil 图片加载

```kotlin
private val imageLoader: ImageLoader by lazy {
    ImageLoader.Builder(context)
        .memoryCache {
            MemoryCache.Builder(context).maxSizePercent(0.30).build()
        }
        .diskCache {
            DiskCache.Builder()
                .directory(File(context.cacheDir, "coil_viewer_cache"))
                .maxSizeBytes(200L * 1024 * 1024)
                .build()
        }
        .crossfade(false)
        .precision(Precision.INEXACT)
        .components {
            // API 28+: ImageDecoderDecoder 支持 animated WebP + animated GIF（硬件解码）
            // API < 28: GifDecoder 仅支持 animated GIF（软件解码，无 animated WebP 支持）
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                add(ImageDecoderDecoder.Factory())
            } else {
                add(GifDecoder.Factory())
            }
        }
        .build()
}
```

- 内存缓存 30%，磁盘缓存 200MB
- `crossfade(false)`：关闭渐变，避免与翻页动画叠加
- `Precision.INEXACT`：允许非精确尺寸解码，提升性能
- `onSuccess` 回调可能同步触发（缓存命中时），`setImageDrawable` 的立即 `resetToCenter` 处理此情况

### 6.1 Animated WebP / GIF 动画播放

**问题**：默认 Coil 把 animated WebP 解码为静帧（首帧），不播放动画。

**依赖**：`io.coil-kt:coil-gif:2.7.0`（提供 `ImageDecoderDecoder` 和 `GifDecoder`）

**解码器注册**：
- API 28+（Android P）：`ImageDecoderDecoder.Factory()` — 基于 Android `ImageDecoder` API，支持 animated WebP + animated GIF，硬件加速
- API < 28：`GifDecoder.Factory()` — 基于 `Movie` 的软件解码，仅支持 animated GIF（无 animated WebP 支持，平台限制）

> **注意**：Coil 2.x 中类名为 `ImageDecoderDecoder`（非 `AnimatedImageDecoder`，后者是 Coil 3.x 命名）。

**动画启停**（`ZoomableImageView.setImageDrawable`）：
```kotlin
override fun setImageDrawable(drawable: Drawable?) {
    // 停止旧 drawable 的帧动画
    (getDrawable() as? Animatable)?.stop()
    super.setImageDrawable(drawable)
    if (drawable != null) {
        // 启动新 drawable 的帧动画（AnimatedImageDrawable 不自动播放，需显式 start）
        (drawable as? Animatable)?.start()
        // ... resetToCenter ...
    }
}
```

- `AnimatedImageDrawable`（API 28+）实现 `Animatable2`（继承 `Animatable`），需显式 `start()` 才会播放
- `MovieDrawable`（coil-gif）也实现 `Animatable`，同样需 `start()`
- 通过 `Animatable` 接口统一处理两种动画 drawable
- 替换图片时先 `stop()` 旧动画，避免后台帧动画浪费 CPU
- `close()` 中清除两个 View 的 drawable（`setImageDrawable(null)`），确保查看器关闭后动画停止

**矩阵兼容性**：`ScaleType.MATRIX` + `imageMatrix` 与 `AnimatedImageDrawable` 完全兼容 — drawable 内部处理帧切换，ImageView 的矩阵变换逐帧应用，缩放/平移/旋转不影响动画播放。

**缩略图条/抽屉预览**：使用普通 `ImageView`（非 `ZoomableImageView`），不调用 `start()`，故缩略图和预览图只显示首帧（符合预期，避免性能浪费）。

---

## 七、幻灯片播放（SlideshowView）

幻灯片功能已拆分为独立的 [SlideshowView.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/SlideshowView.kt)，作为 NativeGalleryView 的全屏覆盖层实现。拆分动机：
1. 早期实现把幻灯片逻辑塞在 NativeGalleryView 内（~2100 行），文件过大
2. 旧实现通过 `toggleImmersive()` 在查看器内播放，并非真正的全屏（顶栏/缩略图条/底部信息仍可见）
3. 循环推进逻辑缺乏鲁棒性，单次异常会让循环"静默死亡"——按钮显示暂停但停在第二张

### 7.1 独立全屏覆盖层架构

`SlideshowView` 继承 `FrameLayout`，通过 `addView(sv, MATCH_PARENT)` 作为子视图叠加到 NativeGalleryView 顶层，覆盖查看器的所有 chrome（顶栏/缩略图条/底部信息/抽屉），提供纯净的全屏播放体验。退出时通过 `removeView(sv)` 移除。

```kotlin
class SlideshowView(
    context: Context,
    private val imageLoader: ImageLoader,
    private val images: List<NativeGalleryView.ImageItem>,
    startIndex: Int,
    private var config: SlideshowConfig,
    private val listener: Listener
) : FrameLayout(context)

interface Listener {
    /** 幻灯片退出，把幻灯片停止时的当前索引同步给查看器。 */
    fun onSlideshowExit(currentIndex: Int)
}

data class SlideshowConfig(
    val intervalMs: Long,
    val transition: String, // "none" | "fade" | "slide"
    val isRandom: Boolean,
    val enableZoom: Boolean
)
```

- **ImageLoader 共享**：构造时由 NativeGalleryView 传入自身 `imageLoader` 实例，共享内存缓存，避免重复加载已查看过的图片
- **NativeGalleryView 委托**：自身保留所有配置字段（`slideshowIntervalMs`/`slideshowTransition`/`slideshowRandom`/`slideshowZoom`）、`showSlideshowSettingsDialog`、顶栏播放按钮；`toggleSlideshow()`/`setSlideshow()`/`startSlideshow()`/`cleanupSlideshow()`/`onSlideshowExited()` 控制覆盖层生命周期

### 7.2 鲁棒的循环推进（修复"停在第二张"bug）

**问题**：旧实现中 `slideshowRunnable` 的 `run()` 直接调 `advance()` 后 `postDelayed` 再调度。若 `advance()` 抛异常（例如切换图片时某个 view 状态异常），`postDelayed` 永不执行，循环"静默死亡"——但 `isSlideshowActive` 仍为 true，按钮保持暂停图标，用户以为在播放但停在第二张。

**修复**：`slideshowRunnable` 把 `advance()` 包进 try/catch，无论是否异常都调用 `scheduleNext()` 重新调度：

```kotlin
private val slideshowRunnable = object : Runnable {
    override fun run() {
        if (!isPlaying) return
        try {
            advance()
        } catch (t: Throwable) {
            Log.e(TAG, "slideshow advance failed", t)
        }
        // 始终重新调度，避免异常导致循环静默死亡
        scheduleNext()
    }
}
```

- 单次异常仅丢失一帧，下一周期自动恢复
- 日志记录异常便于后续诊断

### 7.3 transitionGen 代际计数器（防止过期回调竞态）

每次开始新过渡时 `++transitionGen`，异步图片加载回调通过闭包捕获当时的 `gen`，回调触发时检查 `gen != transitionGen` 则丢弃，避免快速切换时旧回调覆盖新图。

```kotlin
private fun fadeTransition(nextIndex: Int) {
    val gen = ++transitionGen
    // ...
    loadImage(incoming, nextIndex) {
        if (gen != transitionGen) return@loadImage  // 过期，丢弃
        // ... 启动淡入动画 ...
    }
}
```

`exit()` 时通过 `isExiting = true` 和 `isPlaying = false` 让后续调度失效；任何在途加载回调都会被 `gen` 检查作废。

### 7.4 三种过渡效果（双 ImageView 缓冲）

`viewA`/`viewB` 两个 `ImageView`（FIT_CENTER）作为双缓冲，`activeView` 指向当前可见的视图。每次切换时交换 activeView，旧图淡出/滑出，新图淡入/滑入。

| 过渡 | 时长 | 实现 |
|------|------|------|
| `fade`（淡入淡出） | 400ms | incoming alpha 0→1，outgoing alpha 1→0 同步进行 |
| `slide`（平滑移动） | 280ms | incoming 从右侧滑入，outgoing 向左滑出同步进行 |
| `none`（无） | 0ms | 立即切换，无动画 |

**outgoing 视图回收**：每种过渡的 `withEndAction` 在视图隐藏（`visibility = GONE`）后才重置 `outgoing.scaleX = 1f; outgoing.scaleY = 1f`，确保淡出期间保持 Ken Burns 缩放步调，回收后再供下次作为 incoming 使用。

### 7.5 Ken Burns 逐渐放大

**目标**：每张图片在 `intervalMs` 时间内从原始大小（scale=1）逐渐放大到 1.15 倍，使用 `AccelerateDecelerateInterpolator` 平滑过渡。

#### 7.5.1 首张图片锚点修复

**问题**：`startKenBurns` 使用 `view.width / 2f` 作为 `pivotX`，但首张图片在 `loadInitial` 时视图尚未完成布局（`width = 0`），导致 `pivotX = 0`（左边缘），首张图片从左上角放大，后续图片则从中心放大。

**修复**：视图未布局时延迟到 `view.post { ... }` 后再启动，并通过守卫条件避免在退出/暂停/视图非活跃时误启动：

```kotlin
private fun startKenBurns(view: View) {
    // 视图尚未布局（width=0）时 pivot 会落到左上角，导致首张从左上角放大。
    // 延迟到布局完成后再启动。
    if (view.width == 0 || view.height == 0) {
        view.post {
            if (isPlaying && config.enableZoom && view === activeView && !isExiting) {
                startKenBurns(view)
            }
        }
        return
    }
    // ...
}
```

#### 7.5.2 切换图片时缩放不回弹

**问题**：早期 `cancelKenBurns()` 同时重置两个视图的 `scaleX/Y = 1f`，导致切换图片时旧图（已放大到 ~1.13）瞬间回弹到 1.0 再淡出，视觉跳变。

**修复**：
- `cancelKenBurns()` 仅取消 `kenBurnsAnimator`，**不重置 scale**——旧图保持当前缩放步调淡出
- 每种过渡的 `withEndAction` 在 outgoing 视图隐藏后才重置 `scaleX/Y = 1f`，供下次作为 incoming 使用
- `startKenBurns` 从当前 scale 继续放大到 1.15（首张为 1f；暂停恢复时为中间值，避免回弹）：

```kotlin
private fun startKenBurns(view: View) {
    // ...（延迟布局守卫）...
    cancelKenBurns()
    // 从当前缩放值继续放大到 1.15（首张为 1f；暂停恢复时为中间值，避免回弹）
    val startScale = view.scaleX.coerceIn(1f, 1.15f)
    if (startScale >= 1.149f) return  // 已接近最大，无需再放
    view.scaleX = startScale
    view.scaleY = startScale
    view.pivotX = view.width / 2f
    view.pivotY = view.height / 2f
    kenBurnsAnimator = view.animate()
        .scaleX(1.15f).scaleY(1.15f)
        .setDuration(config.intervalMs)
        .setInterpolator(AccelerateDecelerateInterpolator())
    kenBurnsAnimator?.start()
}

private fun cancelKenBurns() {
    // 仅取消动画器，不重置 scale——切换图片时旧图应保持当前缩放步调淡出，
    // 而不是瞬间还原为 1。回收视图（隐藏）时由调用方重置 scale。
    kenBurnsAnimator?.cancel()
    kenBurnsAnimator = null
}
```

### 7.6 退出索引同步

退出幻灯片时通过 `Listener.onSlideshowExit(currentIndex)` 把当前索引同步回 NativeGalleryView：

```kotlin
// SlideshowView.exit()
fun exit() {
    if (isExiting) return
    isExiting = true
    isPlaying = false
    mainHandler.removeCallbacks(slideshowRunnable)
    cancelKenBurns()
    (activeView.drawable as? Animatable)?.stop()
    listener.onSlideshowExit(currentIndex)
}

// NativeGalleryView.onSlideshowExited(exitIndex)
private fun onSlideshowExited(exitIndex: Int) {
    val synced = if (images.isEmpty()) 0 else exitIndex.coerceIn(0, images.size - 1)
    val changed = synced != currentIndex
    currentIndex = synced
    rotationDegrees = 0
    loadingPaletteFileId = null
    cleanupSlideshow()  // 移除覆盖层并恢复系统状态栏
    loadCurrent(animateIn = false)  // 加载幻灯片停止时的图片到查看器
    updateTitle()
    thumbnailAdapter.highlight(currentIndex)
    if (changed) listener?.onNavigate(currentIndex)
}
```

- 退出后查看器立即显示幻灯片停止的那张图片，无缝衔接
- `cleanupSlideshow()` 与 `onSlideshowExited()` 分离：前者仅做资源清理（供 `close()`/`destroy()` 调用），后者包含索引同步与图片加载（供正常退出调用）

### 7.7 系统状态栏同步

`slideshowHidSystemUi` 标记记录幻灯片启动时是否由本组件隐藏了系统状态栏：

- 启动时：`slideshowHidSystemUi = !isImmersive`（查看器已沉浸时状态栏本就隐藏，无需重复切换）
- 若 `slideshowHidSystemUi = true`：调 `listener?.onImmersiveToggle(true)` 隐藏状态栏
- 退出时：若 `slideshowHidSystemUi = true`：调 `listener?.onImmersiveToggle(false)` 恢复状态栏，并重置标记

### 7.8 交互

| 交互 | 行为 |
|------|------|
| 单击 | 切换播放/暂停。暂停时显示播放指示器（圆形半透明背景 + 白色播放图标），恢复时 150ms 淡出后 `visibility = GONE` |
| 返回键 | 退出幻灯片（通过 NativeGalleryView.dispatchKeyEvent 委托 `slideshowView?.exit()`） |

**播放指示器**：不消费触摸事件，单击穿透到容器触发 `togglePlay()`。

**NativeGalleryView.dispatchKeyEvent** 优先级（2026-07-19 更新）：

```kotlin
override fun dispatchKeyEvent(event: KeyEvent): Boolean {
    if (event.keyCode == KeyEvent.KEYCODE_BACK) {
        if (event.action == KeyEvent.ACTION_UP) {
            when {
                slideshowView != null -> slideshowView?.exit()  // 优先退出幻灯片
                drawerOpen -> closeDrawer()
                isOpen -> listener?.onClose()
            }
        }
        return true
    }
    return super.dispatchKeyEvent(event)
}
```

### 7.9 幻灯片设置对话框

> **2026-07-19 重构**：弹窗 UI 已抽取为独立文件 [SlideshowSettingsDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/SlideshowSettingsDialog.kt)（含 `SlideshowConfig` data class）。NativeGalleryView 中的 `showSlideshowSettingsDialog()` 仅保留业务回调（更新配置字段、应用 SlideshowView、通知前端）。

`showSlideshowSettingsDialog()` 提供四项配置：

| 配置 | 控件 | 范围/选项 |
|------|------|---------|
| 播放间隔 | SeekBar | 1-20 秒（默认 5 秒） |
| 过渡效果 | RadioGroup | 无 / 淡入淡出 / 平滑移动 |
| 图片逐渐放大 | Switch | 开启/关闭 Ken Burns |
| 随机播放 | Switch | 开启/关闭随机顺序 |

确定后：
- 配置写入 NativeGalleryView 字段
- 若幻灯片正在运行，调 `slideshowView?.updateConfig(slideshowConfig())` 实时应用（重置定时器/Ken Burns）
- 通过 `listener?.onUpdateSlideshowConfig(json)` 通知前端同步设置

#### 7.9.1 RadioGroup 视觉残留修复

**问题**：默认选项通过 `rb.isChecked = true` 设置，但这种方式不会更新 RadioGroup 内部的 `mCheckedId`。用户点击新选项时，RadioGroup 只取消它"认为"被选中的按钮（即 `mCheckedId` 对应的按钮，而非视觉上勾选的默认项），导致旧选项视觉残留，需关闭重开对话框才显示正确选择。

**修复**：用 `View.generateViewId()` 为每个 RadioButton 分配 ID，通过 `radioGroup.check(defaultCheckId)` 选中默认项（更新 `mCheckedId`），通过 RadioGroup 级别的 `setOnCheckedChangeListener` 捕获选择：

```kotlin
val transitionIds = HashMap<String, Int>()
var defaultCheckId = View.NO_ID
transitions.forEach { (value, label) ->
    val viewId = View.generateViewId()
    transitionIds[value] = viewId
    if (value == selectedTransition) defaultCheckId = viewId
    val rb = RadioButton(context).apply {
        id = viewId
        text = label
        setTextColor(colorTextPrimary())
    }
    radioGroup.addView(rb)
}
if (defaultCheckId != View.NO_ID) radioGroup.check(defaultCheckId)
radioGroup.setOnCheckedChangeListener { _, checkedId ->
    transitionIds.entries.firstOrNull { it.value == checkedId }?.let { (value, _) ->
        selectedTransition = value
    }
}
```

---

## 八、修改文件清单

### Kotlin

| 文件 | 修改内容 |
|------|---------|
| [NativeGalleryView.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt) | 双缓冲架构、WindowManager 可见性、抽屉面板、主题色、手势跟手滑动、贝塞尔曲线、帧率优化（硬件层/缓存/日志移除）、图片间隔、skipReload、延迟 onNavigate、编辑 Dialog、双向同步、applyDrawerProgress/animateDrawerTo progress 驱动动画、全屏样式（topBar/状态栏同步隐藏）、垂直跟手手势控制抽屉、drawerFullWidth 修复缩放、onMeasure 旋转修复、**沉浸模式背景色动画（ValueAnimator+ArgbEvaluator）、applyTheme 尊重 isImmersive、沉浸状态与抽屉状态解耦（immersiveBeforeDrawer）、applyDrawerProgress 尊重 isImmersive、close 检查 isImmersive||drawerOpen**、**幻灯片委托（SlideshowView 覆盖层生命周期：toggleSlideshow/startSlideshow/cleanupSlideshow/onSlideshowExited/setSlideshow）、保留配置字段与设置对话框（RadioGroup 视觉残留修复）、dispatchKeyEvent 优先退出幻灯片、slideshowHidSystemUi 状态栏同步**、**顶栏按钮顺序调整（关闭→文件名→幻灯片→旋转→元数据→删除→分享→更多）+ 关闭按钮改为返回箭头 + 文件名 18sp**、**实现 DialogTheme 接口（override 颜色函数）、showXxxDialog 全部改为薄包装调用独立 Dialog 类、保留 confirmDelete/confirmMoveOut 业务逻辑、showFolderPickerDialog 薄包装 + 移动时调 confirmMoveOut、createRoundedBg 委托 DialogUtils、清理 11 个未使用 import** |
| [SlideshowView.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/SlideshowView.kt) | **新增文件** — 独立全屏幻灯片播放覆盖层（FrameLayout）。鲁棒循环推进（try/catch + 始终重新调度）、transitionGen 代际计数器防过期回调竞态、fade/slide/none 三种过渡（双 ImageView 缓冲）、Ken Burns 逐渐放大（首张延迟布局后启动、cancelKenBurns 不重置 scale、outgoing 隐藏后回收）、Listener.onSlideshowExit 索引同步、单击切换播放/暂停、返回键退出、ImageLoader 共享 |
| [ZoomableImageView.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/ZoomableImageView.kt) | e1 recycle 修复（rawX）、swipeDragging 模式、跟手拖动回调、setImageDrawable 立即 resetToCenter、onTouchDown 回调、drawerFillProgress（fit/fill 插值）、drawerFullWidth（固定 fitS 基准）、垂直滑动检测（onVerticalSwipeDrag/End）、边缘区域屏蔽、**clampTranslateToBounds 实时边界约束、allowZoom 抽屉打开时禁用缩放、onScaleBegin 清理 swipe 状态 + 取消 fling、onScroll 检查 scaleDetector.isInProgress、onDoubleTap/animateScaleTo 取消 fling、animateScaleTo fit-center 公式、onSizeChanged 保留缩放状态、ACTION_UP bounceBack 触发条件、onScale 缩放后 clamp** |
| [MainActivity.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt) | WindowManager addView/removeView、JSON 解析扩展、closeNativeDrawer、onUpdateFile bridge、onDestroy 清理、INFO 级日志、onImmersiveToggle 系统状态栏控制、**onFolderPickerConfirm bridge（evaluateJs 通知 JS）、showFolderPicker(type, fileId, folderTreeJson) 公开方法供 JNI 调用** |
| [dialogs/DialogTheme.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/DialogTheme.kt) | **新增文件（2026-07-19）** — 弹窗主题接口 `DialogTheme` + 通用工具 `object DialogUtils`（density/createRoundedBg/createDialogButton/setItalicHint） |
| [dialogs/DeleteConfirmDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/DeleteConfirmDialog.kt) | **新增文件（2026-07-19）** — 删除确认弹窗（构造参数：context, theme, fileName, onConfirm, onCancel） |
| [dialogs/FolderPickerDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/FolderPickerDialog.kt) | **新增文件（2026-07-19）** — 文件夹选择弹窗，含 FolderNode/FolderTreeData/FolderTreeAdapter；构造参数：context, theme, type, fileId, folderTreeJson, onConfirm(fileId, targetFolderId, type)；**修复选中高亮不显示 bug（onNodeClick 改用 updateData 同步 Adapter 内部 selectedId）** |
| [dialogs/RenameDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/RenameDialog.kt) | **新增文件（2026-07-19）** — 重命名弹窗（系统 AlertDialog + EditText） |
| [dialogs/TagEditDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/TagEditDialog.kt) | **新增文件（2026-07-19）** — 标签编辑弹窗（chips + 输入框，动态高度） |
| [dialogs/DescriptionEditDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/DescriptionEditDialog.kt) | **新增文件（2026-07-19）** — 描述编辑弹窗（多行 EditText） |
| [dialogs/SourceUrlEditDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/SourceUrlEditDialog.kt) | **新增文件（2026-07-19）** — 来源网址编辑弹窗（单行 EditText） |
| [dialogs/SlideshowSettingsDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/SlideshowSettingsDialog.kt) | **新增文件（2026-07-19）** — 幻灯片设置弹窗，含 SlideshowConfig data class；构造参数：context, theme, initialConfig, onConfirm |
| [dialogs/MoreMenuPopup.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/MoreMenuPopup.kt) | **新增文件（2026-07-19）** — 更多菜单弹窗（PopupWindow 风格，锚点定位），含 MoreMenuItem data class |

### Rust

| 文件 | 修改内容 |
|------|---------|
| [lib.rs](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/src/lib.rs) | `android_open_native_viewer`、`android_close_native_viewer`、`android_close_drawer`、`android_update_native_item`、**`android_show_folder_picker`（通过 JNI 调 MainActivity.showFolderPicker，调起原生文件夹选择弹窗）** 命令 |

### TypeScript

| 文件 | 修改内容 |
|------|---------|
| [App.tsx](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx) | 序列化扩展（serializeImagesForNativeViewer）、ImageViewer 不渲染、handleAndroidBackPress async、bridge onUpdateFile、nativeViewerActive 状态、**onCopyToFolder/onMoveToFolder 改为调 invokeAndroidFolderPicker（收集 folderTree JSON → invoke android_show_folder_picker）、新增 invokeAndroidFolderPicker useCallback + Ref、注册 onFolderPickerConfirm bridge** |

---

## 九、尝试过但放弃的方案

### 9.1 addContentView 添加原生查看器（已放弃）

使用 `addContentView()` 将 NativeGalleryView 添加到 Activity content frame。但 Tauri WebView z-order 更高，原生查看器被完全遮挡。改用 WindowManager `TYPE_APPLICATION_PANEL` 独立窗口。

### 9.2 close 时 imageLoader.shutdown()（已放弃）

`imageLoader` 是 `lazy` 属性，shutdown 后无法重建，导致查看器关闭后无法再次打开。改为仅在 `destroy()`（Activity 销毁）时 shutdown，`close()` 只设 `visibility = GONE`。

### 9.3 翻页阈值使用屏幕宽度百分比（已放弃）

`widthPixels * 0.25f` 作为翻页阈值。横竖屏宽度差异大（竖屏 1752px vs 横屏 2800px），百分比导致竖屏难以触发（需 438px）、横屏过于敏感（需 700px）。改用固定 32dp，横竖屏一致。

### 9.4 onScroll 中 e1.x 计算偏移（已放弃）

`swipeStartX = e1?.x` 中 `e1` 会被 Android recycle，导致 `swipeStartX` 在不同 `onScroll` 调用中返回不同值，图片疯狂左右移动。改用 `ACTION_DOWN` 时记录 `event.rawX`，`onScroll` 中用 `e2.rawX - swipeStartX`。

### 9.5 翻页前 activeView.translationX = 0f 复位（已放弃）

翻页时先复位再开始滑出动画，导致图片从拖动位置瞬间跳回原位再滑出。移除复位，让滑出动画从当前 `dx` 位置继续沿同方向滑出，`animate().translationX(目标值)` 会从当前值平滑过渡。

### 9.6 RGB_565 位图格式（已放弃，见性能优化记录）

减少内存占用但只有 65536 色，导致色带和锯齿。改用 ARGB_8888。（此为 ImageViewer 预览生成相关，非 NativeGalleryView 本身，但涉及 MainActivity 共用方法。）

### 9.7 fitS/fillS 都基于当前 vw 计算（已放弃）

抽屉展开时 `resetToCenter` 中 `fitS` 和 `fillS` 都基于当前视图宽度 `vw` 计算，而 `vw` 随抽屉展开减小。横屏图片的 `fitS = min(vw/logicW, vh/logicH)` 在中间过程因 `vw` 减小变为宽度受限而下降，`fillS` 同时变化，造成 fitScale 先降后升——视觉上图片"缩小再还原"。

改为 `fitS` 基于固定全屏宽度（`drawerFullWidth`），`fillS` 基于当前 `vw`，fitScale 单调变化（见 4.7.4）。

### 9.8 垂直手势无方向限制（已放弃）

最初 `onVerticalSwipeDrag`/`onVerticalSwipeEnd` 不限制滑动方向，导致抽屉展开时向上滑仍能触发关闭、抽屉关闭时向下滑触发异常。且 `onVerticalSwipeEnd` 的 `targetOpen` 逻辑反转（关闭条件被当作"保持打开"），导致下滑松手后总是退回展开状态。

改为根据 `drawerDragStartOpen` 用 `coerceAtMost`/`coerceAtLeast` 限制 progress 方向，并修正 `targetOpen` 取反逻辑（见 4.11）。

### 9.9 幻灯片逻辑内嵌 NativeGalleryView（已放弃）

旧实现把 `slideshowRunnable`、`startSlideshowLoop`、`stopSlideshowLoop`、`navigateToWithFade`、`startKenBurns`、`cancelKenBurns` 全部塞在 NativeGalleryView.kt（~2100 行）。文件过大且 `slideshowRunnable` 缺乏 try/catch 导致异常静默死亡。

改为拆分为独立的 `SlideshowView`（见第七章），NativeGalleryView 仅保留配置字段、设置对话框、顶栏按钮和委托方法（`toggleSlideshow`/`startSlideshow`/`cleanupSlideshow`/`onSlideshowExited`/`setSlideshow`）。

### 9.10 幻灯片在查看器内播放（已放弃）

旧实现通过 `toggleImmersive()` 进入沉浸模式播放幻灯片，但顶栏/缩略图条/底部信息仍可见（仅隐藏系统状态栏），并非真正的全屏体验。

改为 `SlideshowView` 作为独立全屏覆盖层叠加到 NativeGalleryView 顶层，覆盖所有 chrome（见 7.1）。

### 9.11 cancelKenBurns 重置 scale（已放弃）

`cancelKenBurns()` 同时重置 `scaleX/Y = 1f`，导致切换图片时旧图（已放大到 ~1.13）瞬间回弹到 1.0 再淡出，视觉跳变。

改为 `cancelKenBurns()` 仅取消 `kenBurnsAnimator`，outgoing 视图在 `withEndAction` 隐藏后才重置 scale（见 7.5.2）。

### 9.12 RadioGroup 通过 rb.isChecked = true 设置默认项（已放弃）

直接 `rb.isChecked = true` 不更新 RadioGroup 内部 `mCheckedId`，导致点击新选项时旧选项视觉残留。改为 `View.generateViewId()` + `radioGroup.check(defaultCheckId)`（见 7.9.1）。

### 9.13 FolderPickerDialog 仅调 notifyDataSetChanged 不更新选中高亮（已放弃）

`onNodeClick` 中只更新外部 `selectedId[0]` 数组，然后调 `adapter.notifyDataSetChanged()`。但 `notifyDataSetChanged()` 触发的 `getView()` 读取的是 Adapter **内部**的 `selectedId` 字段（仍为 `null`），所以 `isSelected = selectedId == node.id` 始终为 false，选中行无高亮显示。

改为调 `adapter.updateData(nodes, expandedIds, selectedId[0])` 显式同步 Adapter 内部的 `selectedId` 字段（与 `onToggleClick` 的写法一致），高亮立即显示。

> 这个 bug 仅存在于刚重构出的独立 [FolderPickerDialog.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/dialogs/FolderPickerDialog.kt) 中。原内嵌实现使用 `notifyDataSetChanged()` 没有此问题，因为 Adapter 是 `inner class`，直接读外部 `selectedId[0]` 数组；重构后 Adapter 改为独立类，`selectedId` 变为构造时传入的字段，必须显式更新。

---

## 十、关键常量与配置

```kotlin
companion object {
    private const val TAG = "NativeGalleryView"
    /** 翻页动画贝塞尔曲线插值器：快速进场 → 接近中心时平滑减速 */
    private val SWIPE_INTERPOLATOR = PathInterpolator(0f, 0f, 0.2f, 1f)
    /** 翻页触发距离阈值（dp），固定值不受横竖屏影响 */
    private const val SWIPE_THRESHOLD_DP = 32f
    /** 翻页触发速度阈值 */
    private const val SWIPE_VELOCITY_THRESHOLD = 200f
    /** 翻页时两张图片之间的视觉间隔（dp），避免竖屏下图片紧贴 */
    private const val SWIPE_GAP_DP = 16f
}
```

| 常量 | 值 | 说明 |
|------|-----|------|
| `SWIPE_INTERPOLATOR` | `PathInterpolator(0f, 0f, 0.2f, 1f)` | 强 ease-out 贝塞尔曲线 |
| `SWIPE_THRESHOLD_DP` | 32f | 翻页距离阈值，横竖屏统一 |
| `SWIPE_VELOCITY_THRESHOLD` | 200f | 翻页速度阈值 |
| `SWIPE_GAP_DP` | 16f | 滑动时图片间隔 |
| `MAX_SCALE` | 8f | ZoomableImageView 最大缩放倍数 |
| 动画时长 | 280ms | 翻页滑出/滑入/回弹 |
| 抽屉宽度 | 320dp | 对齐 MetadataPanel |
| 抽屉动画时长 | 280ms | 展开/收起（AccelerateDecelerateInterpolator） |
| 沉浸模式动画时长 | 200ms | topBar/缩略图条/底部信息 translationY + 背景色 ArgbEvaluator |
| 缩放动画时长 | 250ms | 双击缩放/`animateScaleTo`（ease-out） |
| 边界回弹时长 | 200ms | `bounceBackToBounds`（ease-out） |
| 垂直手势边缘屏蔽 | 24dp | 顶部/底部不触发垂直抽屉手势 |
| 垂直手势速度阈值 | 500px/s | 快速滑动直接打开/关闭抽屉 |
| 垂直手势进度阈值 | 0.5 | 松手时进度过半则提交打开/关闭 |
| `allowZoom` 禁用阈值 | 0.01f | 抽屉 progress > 0.01 时禁用缩放 |
| 内存缓存 | 30% | Coil MemoryCache |
| 磁盘缓存 | 200MB | Coil DiskCache |
| 幻灯片默认间隔 | 5000ms | `slideshowIntervalMs`，可在设置对话框调整为 1-20 秒 |
| 幻灯片默认过渡 | `fade` | `slideshowTransition`，可选 `none`/`fade`/`slide` |
| 幻灯片 fade 时长 | 400ms | 淡入淡出过渡时长 |
| 幻灯片 slide 时长 | 280ms | 平滑移动过渡时长 |
| 幻灯片 none 时长 | 0ms | 立即切换，无动画 |
| Ken Burns 目标缩放 | 1.15f | 每张图片从 1.0 逐渐放大到 1.15 |
| Ken Burns 插值器 | `AccelerateDecelerateInterpolator` | 开始/结束慢，中间快 |
| Ken Burns 动画时长 | `intervalMs` | 与播放间隔同步，整段持续放大 |
| 播放指示器淡入/淡出 | 150ms | 暂停时显示/恢复时隐藏的 alpha 动画 |

---

## 十一、验证

### 编译验证
- Kotlin Gradle `:app:compileUniversalDebugKotlin` BUILD SUCCESSFUL ✅
- TypeScript 类型检查 ✅
- Rust cargo check ✅

### 设备验证清单
1. 点击图片后原生查看器可见（WindowManager z-order）✅
2. 图片正确加载显示 ✅
3. 关闭后再次打开正常工作（imageLoader 不 shutdown）✅
4. Activity 销毁后无窗口泄漏（onDestroy removeView + destroy）✅
5. 元数据抽屉显示与切换同步 ✅
6. 标签/描述编辑后双向同步（原生编辑 → WebView grid；WebView 编辑 → 抽屉）✅
7. Android 端 WebView 不渲染 ImageViewer ✅
8. 更多菜单 7 项可用 ✅
9. 设置开关关闭后回退 WebView 路径 ✅
10. 颜色匹配（深色/浅色模式）✅
11. 主色调色块单行显示 ✅
12. 左右滑动跟手联动（当前图跟随手指，邻接图同步滑入）✅
13. 翻页触发阈值合理（32dp 横竖屏一致）✅
14. 贝塞尔曲线减速效果 ✅
15. 无抖动（e1 recycle / setImageDrawable / skipReload / onNavigate 延迟 全部修复）✅
16. 帧率达到 120fps（三星 Tab S8+）✅
17. 滑动时图片有间隔，不紧贴（16dp）✅
18. 抽屉动画流畅（展开/收起 + 图片宽度同步）✅
19. 浅色模式标题栏文字可见 ✅
20. 返回键收起抽屉 / 关闭查看器 ✅
21. 抽屉打开时滑动不穿透 ✅
22. 抽屉展开时全屏样式（topBar/缩略图条/底部信息/系统状态栏同步隐藏）✅
23. 垂直上滑呼出抽屉、下滑收起抽屉，过程跟手 ✅
24. 垂直手势方向限制（抽屉打开时上滑无效、关闭时下滑无效）✅
25. 边缘区域（顶部/底部 24dp）不误触发垂直抽屉手势 ✅
26. 横屏/竖屏图片呼出抽屉无"缩小再还原"现象（drawerFullWidth 修复）✅
27. 抽屉打开时旋转屏幕图片正确适配（onMeasure 同 pass 修复）✅
28. 单击进入沉浸模式背景色平滑过渡到黑色（200ms ArgbEvaluator 动画）✅
29. 退出沉浸模式背景色平滑过渡到主题色 ✅
30. 沉浸模式下切换图片背景色保持黑色（applyTheme 尊重 isImmersive）✅
31. 沉浸模式下打开抽屉再关闭，正确回到沉浸状态（immersiveBeforeDrawer 恢复）✅
32. 沉浸模式下开关抽屉过程中 topBar/缩略图条/底部信息始终保持隐藏（applyDrawerProgress 尊重 isImmersive）✅
33. 抽屉打开时不响应双击/pinch 缩放（allowZoom 禁用）✅
34. 拖动放大图片时图片不飞出屏幕边缘（clampTranslateToBounds 实时约束）✅
35. 双击缩小到 1x 后图片正确居中，无下方留白（fit-center 公式）✅
36. 双指缩放期间不误触发翻页/抽屉手势（onScaleBegin 清理 swipe 状态 + onScroll 检查 scaleDetector）✅
37. 双击缩放动画期间无位置漂移（onDoubleTap/animateScaleTo 取消 fling）✅
38. 进入/退出沉浸模式时保留用户的缩放状态（onSizeChanged 分支处理）✅
39. close() 后重新打开查看器无黑色背景残留 ✅
40. 标签编辑弹窗动态高度，标签增删后按钮不被挤出 ✅
41. 来源网址编辑弹窗动态高度，无多余下方空间 ✅
42. 标签胶囊缩短（WRAP_CONTENT）+ 放大（14sp + 大 padding）适合触控 ✅
43. "+ 编辑标签"按钮使用次要按钮样式与标签区分 ✅
44. 描述编辑弹窗文字从左上角开始（gravity TOP|START），不居中 ✅
45. hint 文本（新标签/添加描述/https://...）统一斜体 + 淡色，正文不斜体 ✅
46. 深色模式颜色对齐 neutral 色板（#262626），无蓝色饱和度偏差 ✅
47. 弹窗背景 #1E1E1E 与文本框 #262626 有层次区分，不融为一体 ✅
48. 抽屉滚动条已隐藏 ✅
49. 抽屉文件名 18sp 加粗，与文件夹名 12sp 区分明显 ✅
50. 幻灯片播放时全屏覆盖（顶栏/缩略图条/底部信息/抽屉全部被覆盖层遮挡）✅
51. 幻灯片持续播放超过第二张，不再"静默死亡"（try/catch + 始终重新调度）✅
52. 快速切换图片时无旧图覆盖新图（transitionGen 代际计数器作废过期回调）✅
53. 三种过渡效果正常工作（无 / 淡入淡出 / 平滑移动）✅
54. 幻灯片设置对话框 RadioGroup 切换选项时旧选项立即取消选中，无视觉残留 ✅
55. Ken Burns 首张图片从中心放大，不从左上角放大（视图未布局时延迟启动）✅
56. Ken Burns 切换图片时旧图保持缩放步调淡出，不瞬间回弹到 1.0（cancelKenBurns 不重置 scale）✅
57. Ken Burns 暂停后恢复从当前缩放继续放大，不回弹（startKenBurns 从当前 scale 继续）✅
58. 幻灯片退出后查看器立即显示幻灯片停止的那张图片（onSlideshowExit 索引同步 + loadCurrent）✅
59. 幻灯片播放时隐藏系统状态栏，退出后恢复（slideshowHidSystemUi 标记）✅
60. 幻灯片播放时单击切换播放/暂停，暂停时显示播放指示器 ✅
61. 幻灯片播放时返回键退出（dispatchKeyEvent 优先级：幻灯片 > 抽屉 > 查看器）✅
62. 幻灯片设置对话框确定后实时应用新配置（重置定时器/Ken Burns，无需退出重开）✅
63. 幻灯片设置对话框确定后通知前端同步设置（onUpdateSlideshowConfig）✅
64. 幻灯片设置（间隔/过渡/逐渐放大/随机播放）持久化到前端 state，再次打开查看器时按上次配置播放 ✅
65. 顶栏按钮顺序：返回 → 文件名 → 幻灯片 → 旋转 → 元数据 → 删除 → 分享 → 更多 ✅
66. 关闭按钮显示为返回箭头样式（非 X 图标） ✅
67. 文件名显示在返回按钮右侧，18sp 字体，仅显示文件名（无图片数量） ✅
68. 更多菜单点击后弹出 5 项菜单（删除/重命名/复制到文件夹/移动到文件夹/幻灯片设置），定位到「更多」按钮下方 ✅
69. 复制到文件夹：原生弹窗显示文件夹树，搜索/展开/折叠正常，选中文件夹高亮显示 ✅
70. 移动到文件夹：原生弹窗选择文件夹后从查看器移除该图片（confirmMoveOut） ✅
71. 文件夹选择弹窗选中行有蓝色高亮背景 + 白色文字（updateData 同步 selectedId） ✅
72. 8 个弹窗（删除确认/文件夹选择/重命名/标签/描述/来源网址/幻灯片设置/更多菜单）全部独立为 dialogs/ 包下文件 ✅
73. NativeGalleryView.kt 重构后编译通过（compileArm64DebugKotlin BUILD SUCCESSFUL） ✅
