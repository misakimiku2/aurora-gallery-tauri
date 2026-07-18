# Android 原生查看器 — UI 调整 + 原生删除确认弹窗

## 概述

针对 `NativeGalleryView.kt` 顶部工具栏的若干 UI 问题进行修复，并新增一个与 WebView `ConfirmModal` 视觉一致的原生"删除确认弹窗"，替代"先关闭查看器再弹窗"的现有流程，提升删除体验。

## 当前状态分析

### 顶部工具栏（`NativeGalleryView.kt#L488-L529`）
- 背景：`#CC171717`（暗）/`#CCE5E5E5`（亮）— alpha=0xCC=80% 不透明（用户反馈过重）
- 按钮混合两种实现：
  - `makeImageButton(text)`：TextView，textSize=24f，pad=14dp（用于 ✕ ⟳ ⓘ ⋮）
  - `makeIconButton(drawable)`：ImageView，24dp 图标，pad=14dp（用于 trash/share/play）
- 文本字符 ⌀/ⓘ/⋮ 在不同字体下渲染尺寸不一致，导致：
  - 旋转按钮 ⟳ 视觉偏小
  - 元数据按钮 ⓘ 被裁剪
  - 4 个文本按钮与 3 个 drawable 按钮不在同一水平线
- toolbar 共 7 个按钮 + titleView（weight=1，左右 24dp padding）= 7×52 + 48 = 412dp，在 411dp 屏上溢出 → 元数据按钮被裁剪
- 分享图标 `ic_lucide_share.xml` 当前 path 是"上传/导出"样式（盒子+向上箭头），与分享语义不符
- 删除按钮使用 `colorTextPrimary()` 着色，与其它按钮同色，不够醒目

### 删除流程（现状）
- `NativeGalleryView.kt#L516`：toolbar delete 按钮 → `listener?.onDelete(it.fileId)`
- `NativeGalleryView.kt#L2025`：更多菜单"删除"项 → `listener?.onDelete(item.fileId)`
- `MainActivity.kt#L180-L182`：`onDelete` 回调 → `evaluateJs("...onDelete('${fileId}')...")`
- `App.tsx#L2490-L2495`：`onDelete` handler → `invoke('android_close_native_viewer')` + `setNativeViewerActive(false)` + `handleAndroidDelete([fileId])`
- `App.tsx#L1123-L1135`：`handleAndroidDelete` → setState `confirm-delete-file` modal
- `AppModals.tsx#L325-L345`：渲染 `ConfirmModal`，标题"确认删除"，message `确认删除 "name" ?`，subMessage 文件名列表，确认按钮蓝色 + "删除" 文本 + Trash2 图标

**问题**：删除需先关闭原生查看器，体验割裂；用户希望原生层直接弹窗，确认后保留查看器并切换到下一张。

## 提议变更

### 1. 新增 drawable 资源（4 个文件）

**新增** `src-tauri/gen/android/app/src/main/res/drawable/ic_lucide_x.xml` — Lucide "X" 关闭图标
```xml
< vector ... viewportWidth=24 viewportHeight=24 strokeWidth=2 >
  <path d="M18 6 6 18"/>
  <path d="M6 6 18 18"/>
</vector>
```

**新增** `src-tauri/gen/android/app/src/main/res/drawable/ic_lucide_rotate_cw.xml` — Lucide "rotate-cw" 旋转图标
```xml
<path d="M21 4v6h-6"/>
<path d="M20.49 15a9 9 0 1 1-2.12-9.36L21 10"/>
```

**新增** `src-tauri/gen/android/app/src/main/res/drawable/ic_lucide_more_vertical.xml` — Lucide "more-vertical" 三个垂直点
```xml
<circle cx=12 cy=5 r=1/>
<circle cx=12 cy=12 r=1/>
<circle cx=12 cy=19 r=1/>
```
（用 fillColor 填充圆点，不是 stroke）

**修改** `src-tauri/gen/android/app/src/main/res/drawable/ic_lucide_share.xml` — 替换为 Lucide "share-2" 三圆点+连线
```xml
<circle cx=18 cy=5 r=3/>  (用 fillColor 填充，strokeColor 描边)
<circle cx=6 cy=12 r=3/>
<circle cx=18 cy=19 r=3/>
<path d="M8.59 13.51 15.42 17.49"/>
<path d="M15.41 6.51 8.59 10.49"/>
```

### 2. 修改 `NativeGalleryView.kt`

#### 2.1 顶部工具栏背景透明度（L499）
```
#CC171717 → #4D171717   (暗主题，alpha 0x4D=30%)
#CCE5E5E5 → #4DE5E5E5   (亮主题，alpha 0x4D=30%)
```

#### 2.2 统一所有 toolbar 按钮为 drawable 图标 + 一致尺寸
- 修改 `makeIconButton(drawableRes, onClick)` → 增加可选参数 `tintColor: Int = colorTextPrimary()`，删除按钮传入红色
- 把 `makeImageButton` 调用全部改为 `makeIconButton`：
  - `closeBtn` → `R.drawable.ic_lucide_x`
  - `rotateBtn` → `R.drawable.ic_lucide_rotate_cw`
  - `infoBtn` → `R.drawable.ic_lucide_info`（已存在）
  - `moreBtn` → `R.drawable.ic_lucide_more_vertical`
- 删除按钮：`makeIconButton(R.drawable.ic_lucide_trash, tintColor = Color.parseColor("#EF4444")) { ... }` — 跳过新弹窗逻辑改为先弹窗
- `moreBtn` 类型从 `TextView` 改为 `ImageView`（L190 类型声明同步更新）
- 图标 padding 从 14dp 改为 10dp（让 7 个按钮在 360dp 屏上也能放下，titleView 有可见空间）
- `titleView` 左右 padding 从 24dp 改为 8dp

#### 2.3 删除按钮 + 更多菜单"删除"项改为弹窗确认

**新增** `private fun showDeleteConfirmDialog()` 方法（参考 `showSlideshowSettingsDialog` 模式 L1871-L1999）：
- 获取当前 `images[currentIndex]`，若为 null 直接 return
- `Dialog(context)` + `requestWindowFeature(FEATURE_NO_TITLE)` + 透明背景
- `container`：垂直 LinearLayout，`createRoundedBg(colorDialogBg(), 12f, colorBorder(), 1f)`，padding `(24dp, 20dp, 24dp, 16dp)`
- 标题 `TextView`："确认删除"，textSize=18f，colorTextPrimary()，paddingBottom=12dp
- 消息 `TextView`：`确认删除 "${item.name}" ?`，textSize=14f，colorTextPrimary()，paddingBottom=8dp
- 子消息 `TextView`：`item.name`，textSize=12f，colorTextSecondary()，背景 `colorTextBoxBg()`，padding=8dp，圆角 8dp，边框 1dp `colorBorder()`，marginBottom=24dp
- 按钮行 `LinearLayout`（horizontal，gravity=END）：
  - 取消按钮：`createDialogButton("取消", isPrimary=false) { dialog.dismiss() }`
  - 删除按钮：`createDialogButton("删除", isPrimary=true) { confirmDelete(item.fileId); dialog.dismiss() }`
- `dialog.setContentView(container)` → `dialog.show()` → `window.setLayout(320dp, WRAP_CONTENT)`

**新增** `private fun confirmDelete(fileId: String)` 方法：
1. 找到 `images` 中 `fileId` 对应的 index `idx`
2. 从 `images` 移除该 item
3. 调用 `listener?.onDelete(fileId)` 触发 JS 端真正删除文件（不再走 ConfirmModal）
4. 若 `images.isEmpty()` → `listener?.onClose()`（关闭查看器）
5. 否则：
   - 若 `currentIndex >= images.size` → `currentIndex = images.size - 1`
   - 调用 `loadCurrent()`（重新加载当前 index 对应的新图片）
   - 触发 `listener?.onNavigate(currentIndex)`（同步前端 viewingFileId）

**修改** toolbar 删除按钮点击（L516）：
```kotlin
val deleteBtn = makeIconButton(R.drawable.ic_lucide_trash, tintColor = Color.parseColor("#EF4444")) {
    showDeleteConfirmDialog()
}
```

**修改** 更多菜单"删除"项点击（L2025）：
```kotlin
Triple("删除", deleteTextColor) { showDeleteConfirmDialog() },
```

### 3. 修改 `App.tsx` — onDelete 不再关闭查看器、不再弹 ConfirmModal

**修改** `App.tsx#L2490-L2495` `onDelete` handler：
```typescript
onDelete: (fileId: string) => {
  // 原生层已弹窗确认；此处直接执行删除流程，不关闭查看器
  if (isAndroidDevice) handleAndroidDeleteConfirmed([fileId]);
  else requestDelete([fileId]);
},
```

**新增** `handleAndroidDeleteConfirmed` 函数（与 `handleAndroidDelete` 类似，但跳过 ConfirmModal，直接执行 `onConfirm` 内的逻辑）：
- 复制 `handleAndroidDelete` 中 `onConfirm: async () => {...}` 内的删除逻辑（L1135-L1175）
- 不再 setState `confirm-delete-file` modal
- 直接执行：从 `state.files` 移除 + 调用 `deleteFile(path)` + 更新 tabs

（实现策略：把 `handleAndroidDelete` 内 `onConfirm` 的逻辑抽成独立函数 `performDeleteFiles(ids, filesToDelete)`，由 `handleAndroidDelete`（弹窗路径）和 `handleAndroidDeleteConfirmed`（直接路径）共用。）

## 假设与决策

1. **背景透明度目标**：用户选择 30% (alpha=0x4D)
2. **分享图标样式**：用户选择 Lucide share-2（三圆点+连线）
3. **删除后查看器行为**：用户选择"保留查看器，切换到下一张"
4. **删除确认弹窗 UI**：完全匹配 WebView `ConfirmModal`（蓝色确认按钮 + "删除" 文本 + Trash2 风格），而非红色按钮（与 WebView 保持一致优先）
5. **toolbar 删除按钮颜色**：红色（#EF4444），与"删除"语义对应，醒目
6. **图标 padding**：从 14dp 改为 10dp，让 7 个按钮 + titleView 在 360dp 屏上能完整显示，不再裁剪元数据按钮
7. **titleView 水平 padding**：从 24dp 改为 8dp，留更多空间给按钮
8. **更多菜单"删除"项**：同样改为弹窗确认（保持入口一致性）
9. **空列表处理**：删除后无图则关闭查看器（`listener?.onClose()`）
10. **删除文件失败**：JS 端 `deleteFile` 失败时仍乐观从 state 移除（与现有 `handleAndroidDelete` 行为一致）

## 验证步骤

1. **编译**：`cd src-tauri && cargo build` 或在 Android Studio 中 Build → Make Project，确保无 Kotlin 编译错误
2. **顶部工具栏视觉**：
   - 工具栏背景明显更通透（30% 不透明），图片可透过工具栏可见
   - 7 个按钮（关闭、删除、分享、幻灯片、旋转、元数据、更多）大小一致，水平居中对齐
   - 元数据按钮不再被裁剪，所有按钮完整可见
   - 删除按钮图标为红色
   - 分享按钮图标为三圆点+连线（share-2 样式）
3. **删除流程**：
   - 点击 toolbar 红色删除按钮 → 弹出原生确认弹窗
   - 弹窗 UI 与 WebView 一致：标题"确认删除"、消息 `确认删除 "xxx.jpg" ?`、子消息显示文件名、蓝色"删除"+灰色"取消"按钮
   - 点击"取消" → 弹窗关闭，查看器保持当前图片
   - 点击"删除" → 弹窗关闭，当前图片从查看器消失，自动切换到下一张
   - 删除最后一张 → 查看器自动关闭，返回画廊
   - 后台文件实际被删除（验证 `state.files` 中不再包含该 fileId）
4. **更多菜单删除**：点击"更多" → "删除" → 同样弹窗确认，行为与 toolbar 删除按钮一致
5. **不影响其他功能**：旋转、元数据抽屉、幻灯片、重命名、复制/移动等功能正常
