# 安卓端颜色搜索功能恢复与移动端颜色选择器实现计划

## 一、目标

1. 在 Android 端 TopBar 恢复"按颜色搜索"按钮，但用一个全新的、触摸友好的 BottomSheet 颜色选择器替代 PC 端的 `ColorPickerPopover`。
2. 在 `NativeGalleryView` 抽屉的调色板色块上添加点击搜索能力（复刻 PC 端 `MetadataPanel` 色块点击搜索行为），作为"从图片取色"的最直接入口。
3. 两个入口职责互补、互不重复：
   - **TopBar BottomSheet**：手动调色搜索（SV/Hue/Hex/预设），用户没在看图时使用。
   - **NativeGalleryView 抽屉色块**：从当前查看图片的调色板直接搜索，用户在看图时使用。
4. 后端无需任何改动：现有 `search_by_color` / `search_by_palette` 命令和 `color:xxx` 查询语法已完全可用。

## 二、当前状态分析（Phase 1 探索结论）

### 2.1 屏蔽位置

- **PC 端按钮渲染**：[`src/components/TopBar.tsx#L923`](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx#L923) 用 `{!isAndroid && (...)}` 完全跳过颜色搜索按钮。
- **搜索逻辑已存在**：`debouncedColorSearch` (L716-727) → `onPerformSearch('color:${color}')` (300ms 防抖)。
- **后端命令已存在**：[`src-tauri/src/color_search.rs`](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/src/color_search.rs) `search_by_color` 单色走 `is_single_color` 分支，按位置权重 + CIEDE2000 距离评分，阈值 75.0。

### 2.2 PC 端 ColorPickerPopover 的移动端痛点

- 拖拽用 `window.addEventListener('mousemove'/'mouseup')`：触屏拖出元素外时 touch 无法被 window 捕获。
- `window.EyeDropper` API 在 Android WebView 不可用，按钮变死按钮。
- RGB 数字 input 触屏体验差（弹数字键盘），预设色块 20px、Hue 滑块 12px 都低于 44px 触摸目标。
- `w-64` (256px) 顶部下拉在竖屏会被 TopBar 挤压、遮挡搜索结果。

### 2.3 Android NativeGalleryView 抽屉现状

- **色块仅展示，无点击事件**：[`NativeGalleryView.kt#L741-753`](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L741-753) 只 `addView` 一个带 `GradientDrawable` 的 View，无 `OnClickListener`。
- **PC 端 MetadataPanel 色块已有点击搜索**：[`MetadataPanel.tsx#L1992`](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/MetadataPanel.tsx#L1992) `onClick={() => onSearch(`color:${color.replace('#', '')}`)}`。

### 2.4 通信桥接模式

- `NativeGalleryView.Listener` 接口（[`NativeGalleryView.kt#L60`](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L60)）已有 `onClose`/`onNavigate`/`onUpdateFile` 等回调。
- `MainActivity` 实现这些回调，通过 `webView.evaluateJavascript("if(window.__androidViewerBridge&&window.__androidViewerBridge.onXxx)window.__androidViewerBridge.onXxx(...);")` 通知前端。
- `App.tsx` 在 [`src/App.tsx#L2458`](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/App.tsx#L2458) 附近设置 `window.__androidViewerBridge = { onClose, onNavigate, onMore, onUpdateFile, onLongPress, ... }`。

### 2.5 现有移动端菜单模式

- Android TopBar 已使用 `isAndroid ? ... : ...` 双端分流（搜索按钮 L779、排序菜单 L794）。
- 下拉菜单模式：`absolute top-full left-0 mt-2 w-48` + `fixed inset-0 z-40` 背景层 + `animate-zoom-in`。
- 项目中**尚无 BottomSheet 组件**，本计划将新建。
- 触摸目标规范：Android TopBar 按钮已统一 `w-10 h-10` (40px)。

## 三、方案设计

### 3.1 总体架构

```
┌─────────────────────────────────────────────────────────────┐
│  入口 1: TopBar 颜色按钮 (手动调色)                          │
│  ─ Android: 点击 → MobileColorPickerSheet (BottomSheet)     │
│  ─ PC:     保持现有 ColorPickerPopover                       │
└─────────────────────────────────────────────────────────────┘
┌─────────────────────────────────────────────────────────────┐
│  入口 2: NativeGalleryView 抽屉色块 (从图片取色)             │
│  ─ 色块点击 → Listener.onColorSearch(hex)                    │
│  ─ MainActivity → evaluateJavascript → __androidViewerBridge │
│  ─ App.tsx 关闭查看器 + 发起 color:xxx 搜索                  │
└─────────────────────────────────────────────────────────────┘
                          │
                          ▼
        共用现有搜索流程：debouncedColorSearch
                          │
                          ▼
        onPerformSearch('color:#xxxxxx')
                          │
                          ▼
        Rust: search_by_color → search_by_palette
                          │
                          ▼
        网格视图显示结果（已有逻辑）
```

### 3.2 共享 utils 提取

将 HSV/RGB/Hex 转换函数从 `ColorPickerPopover.tsx` 提取到 `src/utils/colorUtils.ts`，PC 和 Android 两端复用，避免逻辑重复。

包含函数：`hexToRgb` / `rgbToHex` / `rgbToHsv` / `hsvToRgb`，以及类型 `RGB` / `HSV`。

### 3.3 MobileColorPickerSheet 设计

**布局**（BottomSheet，从底部弹出，`position: fixed inset-0 z-50`，背景半透明遮罩 + 底部圆角面板）：

```
┌─────────────────────────────────┐
│  (半透明遮罩，点击关闭)          │
│                                 │
│                                 │
└─────────────────────────────────┘
┌─────────────────────────────────┐
│  ─── 手柄 ───                   │
│                                 │
│  ┌─────────────────────────┐    │
│  │                         │    │
│  │   SV 选择区 (h-56)      │    │  touch-action: none
│  │                         │    │  pointer events 统一
│  │       ● 指示器          │    │
│  └─────────────────────────┘    │
│                                 │
│  ┌─────────────────────────┐    │
│  │ Hue 滑块 (h-10) ─────●  │    │  高度 40px 触摸友好
│  └─────────────────────────┘    │
│                                 │
│  ┌─────┐  ┌────────────────┐   │
│  │ 色  │  │ #FF5733        │   │  当前色预览 + Hex 输入
│  │ 块  │  │                │   │
│  └─────┘  └────────────────┘   │
│                                 │
│  预设颜色                       │
│  ⬛⬛⬛⬛⬛⬛⬛⬛              │   │  8 列网格，色块 36x36
│  ⬛⬛⬛⬛⬛⬛⬛⬛              │
│                                 │
│  [取消]              [搜索]     │  底部操作按钮
└─────────────────────────────────┘
```

**交互细节**：
- 使用 Pointer Events (`onPointerDown`/`onPointerMove`/`onPointerUp`) 统一 mouse/touch，并在 `onPointerDown` 时调用 `e.currentTarget.setPointerCapture(e.pointerId)` 确保拖出元素外仍能接收事件。
- SV 区和 Hue 滑块容器加 `style={{ touchAction: 'none' }}` 防止触屏滚动/缩放干扰。
- 实时更新当前色预览，但**搜索动作延迟到用户点击"搜索"按钮**才触发（与 PC 端实时 debounce 搜索不同）——理由：移动端网络/搜索结果渲染较慢，实时搜索会造成卡顿和体验混乱；显式确认按钮更符合移动习惯。
- 预设色板：经典色（红橙黄绿青蓝紫 + 黑白灰）+ 最近使用（localStorage 持久化最近 8 个）。
- 不含 EyeDropper（Android WebView 不支持）。
- 不含 RGB 数字 input（移动端用滑块更直观）。

**动画**：BottomSheet 上滑入场（`transform: translateY(100%) → 0`，250ms ease-out），背景遮罩淡入。沿用项目现有 `animate-fade-in` 模式或新增 `animate-slide-up`。

### 3.4 NativeGalleryView 抽屉色块点击搜索

**改动点**（[`NativeGalleryView.kt#L741-753`](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt#L741-753)）：
- 给每个色块 View 添加 `OnClickListener` → `listener?.onColorSearch(hex)`。
- 视觉反馈：按下时 `scaleX/scaleY = 1.15` + alpha = 0.8（短暂动画），参考现有 tag chip 的 `hover:scale-110` 风格。
- 长按可选：弹出"复制颜色值"Toast（不在本计划范围内，留作后续）。

**Listener 接口新增**：
```kotlin
interface Listener {
    // ... 现有方法 ...
    /** 用户点击了抽屉里的调色板色块，请求按该颜色搜索。 */
    fun onColorSearch(colorHex: String)
}
```

**MainActivity 实现**：
```kotlin
override fun onColorSearch(colorHex: String) {
    // 先关闭原生查看器，再让前端发起搜索
    closeNativeViewer()
    evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onColorSearch)window.__androidViewerBridge.onColorSearch('${colorHex}');")
}
```

注意：`closeNativeViewer()` 会触发 `onClose` 回调清理前端状态，之后再发 `onColorSearch` 事件，前端就在干净的网格视图状态下发起搜索。

### 3.5 App.tsx 前端桥接

在 `__androidViewerBridge` 对象中新增 `onColorSearch`：

```typescript
onColorSearch: (colorHex: string) => {
    // viewer 已被 MainActivity.closeNativeViewer() 关闭
    // 直接发起颜色搜索
    performSearch(`color:${colorHex.replace('#', '')}`);
},
```

需要确认 `performSearch` 在 App.tsx 中的可用引用名（可能是 `handlePerformSearch` 或通过 ref）。从探索看，TopBar 的 `onPerformSearch` 来自 App.tsx 传入，需找到 App.tsx 内对应的函数引用并复用。

### 3.6 TopBar Android 端按钮恢复

修改 [`TopBar.tsx#L922-949`](file:///c:/Users/Misaki/Desktop/git/aurora-gallery-tauri/src/components/TopBar.tsx#L922)：

- 移除外层 `{!isAndroid && (...)}`。
- Android 分支：点击 Palette 按钮 → `setIsColorPickerOpen(true)` → 渲染 `<MobileColorPickerSheet>` 而非 `<ColorPickerPopover>`。
- PC 分支：保持现有 `<ColorPickerPopover>` 行为不变。
- Android 端点击外部关闭逻辑（L631-642 useEffect）可移除——BottomSheet 自带遮罩点击关闭。

## 四、文件改动清单

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `src/utils/colorUtils.ts` | 新建 | 提取 HSV/RGB/Hex 转换函数和类型，两端共享 |
| `src/components/ColorPickerPopover.tsx` | 修改 | 从 `colorUtils.ts` import，删除内联 utils（纯重构，行为不变） |
| `src/components/MobileColorPickerSheet.tsx` | 新建 | Android 端 BottomSheet 颜色选择器组件 |
| `src/components/TopBar.tsx` | 修改 | 移除 Android 屏蔽，Android 端用 MobileColorPickerSheet，PC 端保持不变 |
| `src/App.tsx` | 修改 | `__androidViewerBridge` 新增 `onColorSearch` 回调 |
| `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/NativeGalleryView.kt` | 修改 | Listener 接口加 `onColorSearch`；抽屉色块加 `OnClickListener` |
| `src-tauri/gen/android/app/src/main/java/com/aurora/gallery/MainActivity.kt` | 修改 | 实现 `onColorSearch`：关闭查看器 + evaluateJavascript 通知前端 |
| `src/utils/translations.ts` | 修改 | 补充移动端颜色选择器所需翻译键（见 3.7） |
| `index.css` | 修改 | 新增 `animate-slide-up` 关键帧（如果项目尚无 BottomSheet 滑入动画） |

无需改动后端 Rust 代码。

### 3.7 翻译键

需要新增的翻译键（中文 / 英文）：

| 键 | 中文 | 英文 |
|----|------|------|
| `color.search` | 搜索 | Search |
| `color.cancel` | 取消 | Cancel |
| `color.presets` | 预设颜色 | Presets |
| `color.recent` | 最近使用 | Recent |
| `color.hue` | 色相 | Hue |
| `color.title` | 按颜色搜索 | Search by Color |

已有键可复用：`search.byColor`、`color.pickColor`。

## 五、假设与决策

1. **假设**：`MainActivity.closeNativeViewer()` 同步清理 NativeGalleryView 后，前端 `__androidViewerBridge.onClose` 会被触发；之后再 fire `onColorSearch` 事件，此时前端已处于网格视图状态，可以安全发起搜索。若时序有问题，可在 `onColorSearch` 前端回调中加 `setTimeout(0)` 延迟一帧。
2. **决策**：移动端 BottomSheet 采用"显式搜索按钮"而非 PC 端的"实时防抖搜索"——移动端搜索结果渲染慢，实时搜索会卡顿。
3. **决策**：BottomSheet 不含 RGB 数字输入和 EyeDropper——移动端不适用。
4. **决策**：不新建全局 BottomSheet 通用组件——目前只有颜色选择器需要，避免过度抽象；如果未来有更多 BottomSheet 需求再抽。
5. **决策**：共享 `colorUtils.ts` 而非共享整个颜色选择器组件——两端 UI 差异大，共享 utils 足够。
6. **假设**：App.tsx 中 `performSearch` 函数（或等价名）可在 `__androidViewerBridge` 闭包内调用，与 TopBar 的 `onPerformSearch` 同源。实施时需确认确切函数名和闭包依赖。

## 六、验证步骤

### 6.1 PC 端回归验证（确保无破坏）

1. PC 端打开应用，TopBar 颜色搜索按钮仍存在且可点击。
2. 点击按钮弹出 `ColorPickerPopover`，SV 拖拽、Hue 滑块、Hex 输入、RGB 输入、预设色块、EyeDropper 均正常工作。
3. 选择颜色后搜索结果正确显示。
4. MetadataPanel 色块点击搜索不受影响。

### 6.2 Android 端 TopBar BottomSheet 验证

1. Android 端打开应用，TopBar 出现颜色搜索按钮（Palette 图标）。
2. 点击按钮，BottomSheet 从底部滑入，背景遮罩出现。
3. SV 区域拖拽：手指拖动时颜色实时变化，指示器跟随，拖出元素外仍能继续（pointer capture 验证）。
4. Hue 滑块拖拽：色相变化，SV 区背景色同步变化。
5. Hex 输入：点击输入框唤起软键盘，输入合法 hex 后当前色预览更新。
6. 预设色块：点击设置当前色。
7. 点击"搜索"按钮：BottomSheet 关闭，搜索结果在网格视图显示，搜索框显示 `color:#xxxxxx`。
8. 点击"取消"或背景遮罩：BottomSheet 关闭，不发起搜索。
9. 横竖屏切换：BottomSheet 布局正常适应。

### 6.3 NativeGalleryView 抽屉色块点击验证

1. 在网格视图点击任意已提取主色调的图片进入 NativeGalleryView。
2. 打开抽屉（上滑或点击信息按钮）。
3. 抽屉"主色调"区域显示 8 个色块。
4. 点击某个色块：查看器关闭，回到网格视图，搜索结果为该颜色的图片。
5. 验证日志：MainActivity 输出 `onColorSearch: #xxxxxx`，App.tsx 输出 `performSearch: color:xxxxxx`。
6. 搜索框显示对应 `color:` 查询，可清除回到正常浏览。

### 6.4 边界场景

1. **未提取主色调的图片**：抽屉色块区域显示"—"（现有行为），无点击事件，无崩溃。
2. **BottomSheet 打开时旋转屏幕**：布局自适应，不卡死。
3. **快速连续点击不同色块**：最后一次点击的颜色生效（防抖或取消前一次搜索）。
4. **从抽屉色块搜索后再次进入查看器**：状态干净，无残留查询。
5. **深色模式**：BottomSheet 配色正确（参考现有 `dark:bg-gray-800` 模式）。

## 七、实施顺序建议

1. 提取 `colorUtils.ts`，重构 `ColorPickerPopover.tsx` import（低风险，先做）。
2. 新建 `MobileColorPickerSheet.tsx`（独立组件，可单独测试）。
3. 修改 `TopBar.tsx`，Android 端接入新组件。
4. 修改 `translations.ts` 和 `index.css`（动画）。
5. PC 端回归验证（步骤 6.1）。
6. 修改 `NativeGalleryView.kt` 和 `MainActivity.kt`，加 `onColorSearch` 链路。
7. 修改 `App.tsx`，加 `__androidViewerBridge.onColorSearch`。
8. Android 端全流程验证（步骤 6.2、6.3、6.4）。
