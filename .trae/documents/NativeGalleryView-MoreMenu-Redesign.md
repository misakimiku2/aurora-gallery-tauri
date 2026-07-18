# NativeGalleryView "更多"菜单样式重构与内容精简

## Summary

将 Android 原生图片查看器 `NativeGalleryView` 的"更多"菜单从默认居中 `AlertDialog` 改为锚定在按钮下方的圆角矩形弹出面板，背景色对齐软件主题（参考 `FoldersOverview` 长按文件夹时顶部工具栏"更多"菜单的 `ContextMenu` 样式）。同时移除移动端不适用的 4 个菜单项：文件名显示（AlertDialog 标题）、在文件夹中显示、旋转保存、AI 分析，并清理这些功能对应的 Listener 接口方法与前后端实现。

---

## Current State Analysis

### 当前 `showMoreMenu()` 实现

[NativeGalleryView.kt#L1832-L1852](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L1832-L1852) 使用 `AlertDialog.Builder` 实现：

- `setTitle(item.name)` —— 将文件名作为对话框标题（居中显示）
- 7 个选项：删除 / 在文件夹中显示 / 重命名 / 旋转保存 / AI 分析 / 复制到文件夹 / 移动到文件夹
- "旋转保存"实际未实现，只弹 Toast"旋转保存功能开发中"
- 使用系统默认 AlertDialog 样式（居中、系统背景色），与软件主题不匹配

### 调用点

[NativeGalleryView.kt#L506](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L506)：
```kotlin
val moreBtn = makeImageButton("⋮") { showMoreMenu() }
```
`moreBtn` 是 `buildTopBar()` 内的局部变量，当前未存为类字段。

### 参考样式（ContextMenu / AndroidSelectionBar）

[AndroidSelectionBar.tsx#L37-L47](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/AndroidSelectionBar.tsx#L37-L47)：点击"更多"按钮时，取按钮 `getBoundingClientRect()`，将 `rect.right, rect.bottom + 4` 作为菜单定位坐标传入 `onShowContextMenu`。

[ContextMenu.tsx#L188-L233](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/ContextMenu.tsx#L188-L233) 渲染菜单容器：
- 容器样式：`bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 min-w-[180px]`
- 即：背景 `#FFFFFF` / `#262626`（neutral-800）、边框 `#E5E7EB` / `#404040`（neutral-700）、圆角 6px、阴影、垂直内边距 4px、最小宽度 180px
- Android 菜单项样式：`height: 50px, fontSize: 15px, px-4`（高 50px、字号 15px、水平内边距 16px）
- 删除项：红色文字 `text-red-500 dark:text-red-400`，hover 时白字红底
- 边界约束：菜单超出屏幕时自动调整 x/y

### 颜色辅助函数（已存在）

[NativeGalleryView.kt#L159-L173](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L159-L173)：
- `colorBorder()` = `#262626`（dark）/ `#E5E7EB`（light）
- `colorTextPrimary()` = `#F3F4F6`（dark）/ `#262626`（light）
- `colorAccent()` = `#3B82F6`
- `createRoundedBg(bgColor, cornerRadiusDp, borderColor, strokeWidthDp)` —— 已有辅助方法，创建圆角矩形 Drawable

### 现有自定义 Dialog 模式

`showTagEditDialog` / `showDescriptionEditDialog` / `showSourceUrlEditDialog` 均使用 `Dialog(context)` + 透明窗口背景 + `createRoundedBg(colorDialogBg(), 16f)` 自定义视图，在 NativeGalleryView 的 WindowManager 窗口上下文中正常工作。

### 待移除功能的引用链

| 功能 | Listener 接口声明 | MainActivity 实现 | App.tsx bridge | 菜单中使用 |
|------|-------------------|-------------------|----------------|-----------|
| 在文件夹中显示 | `onShowInFolder` (L70) | L183-184 | L2492-2499 | L1840 |
| AI 分析 | `onAIAnalyze` (L76) | L192-193 | L2506-2508 | L1846 |
| 旋转保存 | 无（菜单内 Toast） | — | — | L1842-1845 |
| 文件名显示 | 无（`setTitle`） | — | — | L1836 |

`onShowInFolder` 和 `onAIAnalyze` 仅在 `showMoreMenu()` 中使用，移除菜单项后成为死代码。

---

## Proposed Changes

### 1. 重写 `showMoreMenu()` —— 自定义下拉弹出面板

**文件**：[NativeGalleryView.kt](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt)

**替换** L1832-L1852 的 `showMoreMenu()` 方法。

新方法签名：`private fun showMoreMenu(anchor: View)`

**实现要点**：

- 使用 `Dialog(context)` + 透明窗口背景 + 自定义 `LinearLayout` 视图（与现有 `showTagEditDialog` 等同一模式，确保在 WindowManager 窗口上下文中正常显示）
- **菜单容器**：
  - 方向 `VERTICAL`
  - 背景 `createRoundedBg(menuBgColor, 8f, colorBorder(), 1f)`，其中 `menuBgColor = if (isDarkTheme) Color.parseColor("#262626") else Color.parseColor("#FFFFFF")`（匹配 ContextMenu 的 `bg-white dark:bg-gray-800`）
  - 垂直内边距 `(density * 4).toInt()`（匹配 `py-1`）
  - `elevation = (density * 8).toInt().toFloat()`（阴影，匹配 `shadow-xl`）
- **菜单项**（4 项，按顺序）：
  1. "删除" —— `listener?.onDelete(item.fileId)`，文字红色 `if (isDarkTheme) #F87171 else #EF4444`
  2. "重命名" —— `showRenameDialog()`，文字 `colorTextPrimary()`
  3. "复制到文件夹" —— `listener?.onCopyToFolder(item.fileId)`，文字 `colorTextPrimary()`
  4. "移动到文件夹" —— `listener?.onMoveToFolder(item.fileId)`，文字 `colorTextPrimary()`
- **菜单项样式**（匹配 ContextMenu Android 规格）：
  - `textSize = 15f`
  - 水平内边距 `(density * 16).toInt()`
  - 垂直内边距 `(density * 14).toInt()`（约 48dp 触控高度）
  - `minWidth = (200 * density).toInt()`（匹配 `min-w-[180px]`，略加宽以适配中文）
  - `layoutParams = LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT)`
  - 按压背景：`StateListDrawable`（pressed → `colorAccent()` 半透明，default → transparent）
- **定位逻辑**（参考 AndroidSelectionBar + ContextMenu 边界约束）：
  - 测量菜单视图：`menuView.measure(widthSpec, heightSpec)` 获取 `measuredWidth` / `measuredHeight`
  - 取锚点屏幕坐标：`anchor.getLocationOnScreen(loc)`
  - 菜单 x = `loc[0] + anchor.width - measuredWidth`（右对齐到按钮右边缘）
  - 菜单 y = `loc[1] + anchor.height + (density * 4).toInt()`（按钮下方 4dp 间距）
  - 边界约束：x 限制在 `[0, screenWidth - measuredWidth]`，y 限制在 `[0, screenHeight - measuredHeight]`
  - 通过 `window.setGravity(Gravity.TOP or Gravity.START)` + `window.attributes.x/y` 定位
- **关闭**：点击菜单项后 `dialog.dismiss()` 再执行对应动作；`setCanceledOnTouchOutside(true)` 点击外部关闭

### 2. 更新调用点 —— 传递锚点 View

**文件**：[NativeGalleryView.kt#L506](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L506)

```kotlin
// 旧
val moreBtn = makeImageButton("⋮") { showMoreMenu() }
// 新
val moreBtn = makeImageButton("⋮") { showMoreMenu(moreBtn) }
```

Kotlin 中 lambda 捕获 `moreBtn` 引用，点击时 `moreBtn` 已赋值，此模式合法。

### 3. 移除 Listener 接口中未使用的方法

**文件**：[NativeGalleryView.kt#L60-L89](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L60-L89)

从 `Listener` 接口移除：
- `fun onShowInFolder(fileId: String)`（L70）
- `fun onAIAnalyze(fileId: String)`（L76）

保留 `onDelete`、`onCopyToFolder`、`onMoveToFolder`、`onEditTags` 等仍在使用的方法。

### 4. 清理 MainActivity.kt 实现

**文件**：[MainActivity.kt#L183-L184, L192-L193](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt#L183-L193)

移除 `onShowInFolder` 和 `onAIAnalyze` 的 override 实现（两段 `evaluateJs(...)` 调用）。

### 5. 清理 App.tsx bridge 方法

**文件**：[App.tsx#L2492-L2499, L2506-L2508](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2492-L2508)

从 `__androidViewerBridge` 对象移除：
- `onShowInFolder` 方法（L2492-2499）
- `onAIAnalyze` 方法（L2506-2508）

---

## Assumptions & Decisions

1. **使用 Dialog 而非 PopupWindow**：现有自定义 Dialog（showTagEditDialog 等）在 NativeGalleryView 的 WindowManager 窗口上下文中已验证可正常工作。PopupWindow 虽然内置锚点定位，但在 TYPE_APPLICATION_PANEL 窗口上的 z-order 行为未经验证。选择 Dialog + 手动定位确保稳定性。

2. **菜单项不添加图标**：现有 NativeGalleryView 所有按钮均使用 Unicode 字符（✕⟳ⓘ⋮），不使用 drawable 资源。为保持一致性且避免引入图标资源管理的复杂性，菜单项仅使用文字。删除项通过红色文字区分。

3. **背景色选择 `#262626`（dark）**：用户要求"与软件主题一样的颜色"并参考 ContextMenu 样式。ContextMenu dark 模式使用 `bg-gray-800` = neutral-800 = `#262626`。此值与 `colorTextBoxBg()` dark 一致，但 light 模式 `colorTextBoxBg()` 返回 `#F9FAFB`，而 ContextMenu light 为 `#FFFFFF`，因此直接使用 `#262626` / `#FFFFFF` 内联值而非复用现有函数。

4. **保留 `showRenameDialog()` 现有 AlertDialog 实现**：用户仅要求修改"更多菜单"样式，未提及重命名弹窗。重命名弹窗仍使用 AlertDialog，样式不一致但不在本次修改范围内。

5. **移除 `onShowInFolder` / `onAIAnalyze` 全链路**：用户明确要求"移除掉...这些功能以及选项"。这两个方法仅在 `showMoreMenu` 中使用，移除后为死代码，因此一并清理 Listener 接口、MainActivity 实现、App.tsx bridge。

6. **"旋转保存"无需清理 Listener**：旋转保存从未实现为 Listener 方法，仅是菜单内的 Toast，移除菜单项即可。

---

## Verification Steps

1. **编译验证**：`cd src-tauri/gen/android && ./gradlew :app:compileUniversalDebugKotlin` 编译通过
2. **TypeScript 检查**：前端无类型错误（移除 bridge 方法后）
3. **设备验证**：
   - 点击顶部工具栏"⋮"按钮，菜单出现在按钮下方（非屏幕中央），右对齐到按钮右边缘
   - 菜单为圆角矩形，深色模式背景 `#262626`，浅色模式背景 `#FFFFFF`，与主题一致
   - 菜单仅含 4 项：删除（红色文字）/ 重命名 / 复制到文件夹 / 移动到文件夹
   - 无文件名标题显示
   - 点击菜单项执行对应功能后菜单关闭
   - 点击菜单外部区域菜单关闭
   - 旋转屏幕后菜单位置仍正确（若菜单已打开旋转会重建，属正常行为）
   - "删除"功能正常触发删除流程
   - "重命名"打开重命名弹窗
   - "复制到文件夹"/"移动到文件夹"打开对应模态框
