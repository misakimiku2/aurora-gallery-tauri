# Android 原生查看器新增"复制/移动到文件夹"弹窗

## 摘要

在 Android 原生图片查看器（NativeGalleryView）的"更多"菜单中，"复制到文件夹"和"移动到文件夹"目前通过 `listener.onCopyToFolder/onMoveToFolder` 回调到 JS 端，弹出 WebView 的 `FolderPickerModal`。但 WebView 无法显示在原生查看器之上，导致用户看不到弹窗。

参照已实现的删除确认弹窗模式（`showDeleteConfirmDialog`），在原生层新增一个文件夹选择弹窗 `showFolderPickerDialog`，UI 与 WebView 的 `FolderPickerModal` 一致（标题、搜索框、文件夹树、取消/确认按钮）。复制/移动文件的实际操作仍由 JS 端执行（复用现有 `handleCopyFiles/handleMoveFiles`）。

## 现状分析

### WebView 端（参考实现）
- [src/components/modals/FolderPickerModal.tsx](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src\components\modals\FolderPickerModal.tsx) (161 行)
  - 移动版宽度 90vw max-w-lg，高度 `calc(100vh-200px)` min-h-[400px]
  - 标题：`type === 'copy-to-folder' ? '复制到文件夹...' : '移动到文件夹...'`（18px font-bold）
  - 搜索框：左侧 Search 图标 14px，右侧清除 X 按钮，placeholder `搜索...`
  - 文件夹树容器：`flex-1 overflow-y-auto`，灰底 `bg-gray-50 dark:bg-gray-900/50`，圆角边框
  - 树节点：ChevronDown/ChevronRight（折叠图标）+ Folder 图标（蓝色）+ 文件名（truncate）
  - 移动版 padding py-3，图标 18px，字号 text-base (16sp)
  - 选中项：`bg-blue-600 text-white font-semibold`
  - 搜索时只显示匹配项及其祖先链
  - 排除 `selectedFileIds`（被复制的源文件夹本身不可选）
  - 底部按钮：取消（次按钮）、确认（蓝色主按钮，`disabled:opacity-50`）

### 原生层现状
- [NativeGalleryView.kt#L2101-L2190](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src-tauri\gen\android\app\src\main\java\com\aurora\gallery\NativeGalleryView.kt#L2101) `showMoreMenu` 中"复制到文件夹"和"移动到文件夹"直接调用 `listener?.onCopyToFolder/onMoveToFolder(fileId)`
- [MainActivity.kt#L183-L188](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src-tauri\gen\android\app\src\main\java\com\aurora\gallery\MainActivity.kt#L183) 通过 `evaluateJs` 调用 `window.__androidViewerBridge.onCopyToFolder/onMoveToFolder(fileId)`
- [App.tsx#L2519-L2522](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src\App.tsx#L2519) 接收后 `setState({ activeModal: { type: 'copy-to-folder'/'move-to-folder', data: { fileIds: [fileId] } } })` 弹出 WebView 弹窗（被原生查看器遮挡）
- 现有辅助方法可复用：`createRoundedBg`、`createDialogButton`、`colorDialogBg/colorTextBoxBg/colorAccent/colorBorder/colorTextPrimary/colorTextSecondary`

### 删除弹窗参考（已完成）
- [NativeGalleryView.kt#L2008-L2074](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src-tauri\gen\android\app\src\main\java\com\aurora\gallery\NativeGalleryView.kt#L2008) `showDeleteConfirmDialog` + `confirmDelete`
- 流程：原生弹窗 → 用户确认 → `listener?.onDelete(fileId)` → JS 端 `handleAndroidDeleteConfirmed` 直接执行删除
- 同步从 `images` 列表移除 + 切换下一张 + `onNavigate`

### Tauri 命令注册模式
- [src-tauri/src/lib.rs#L1330-L1372](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src-tauri\src\lib.rs#L1330) `android_open_native_viewer`、`android_close_native_viewer` 等
- 模式：`#[tauri::command] async fn android_xxx(...) -> Result<(), String>` → JNI 调用 MainActivity 方法
- MainActivity 暴露对应方法，调用 NativeGalleryView 的 public API

### 文件操作 hook
- [src/hooks/useFileOperations.ts#L64](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src\hooks\useFileOperations.ts#L64) `handleCopyFiles(fileIds: string[], targetFolderId: string)`
- [src/hooks/useFileOperations.ts#L254](file:///c:\Users\Misaki\Desktop\git\aurora-gallery-tauri\src\hooks\useFileOperations.ts#L254) `handleMoveFiles(fileIds: string[], targetFolderId: string)`

## 设计决策

### 数据流（保留现有 onCopyToFolder/onMoveToFolder 接口）

```
1. 用户点击更多菜单 → "复制/移动到文件夹"
2. NativeGalleryView.showMoreMenu 调用 listener?.onCopyToFolder/onMoveToFolder(fileId)（接口不变）
3. MainActivity 通过 evaluateJs 调用 window.__androidViewerBridge.onCopyToFolder/onMoveToFolder(fileId)（不变）
4. App.tsx 接收后：
   - 不再 setState activeModal（不弹 WebView 弹窗）
   - 收集 state.files 中所有文件夹节点 + state.roots，序列化为 JSON
   - 通过 invoke('android_show_folder_picker', { type: 'copy'/'move', fileId, folderTreeJson }) 调用 Tauri
5. Tauri 端 android_show_folder_picker 命令通过 JNI 调用 MainActivity.showFolderPicker(type, fileId, folderTreeJson)
6. MainActivity 调用 NativeGalleryView.showFolderPickerDialog(type, fileId, folderTreeJson)
7. NativeGalleryView 展示弹窗，用户选择目标文件夹后调用 listener?.onFolderPickerConfirm(fileId, targetId, type)
8. MainActivity 通过 evaluateJs 调用 window.__androidViewerBridge.onFolderPickerConfirm(fileId, targetId, type)
9. App.tsx 接收后根据 type 调用 handleCopyFiles([fileId], targetId) / handleMoveFiles([fileId], targetId)
```

### 文件夹树 JSON 格式
```json
{
  "roots": ["root_id_1", "root_id_2"],
  "folders": [
    { "id": "folder1", "name": "Folder 1", "parentId": null, "children": ["folder2"] },
    { "id": "folder2", "name": "Folder 2", "parentId": "folder1", "children": [] }
  ]
}
```
- 只包含 `type === FOLDER` 的节点
- `children` 数组只包含文件夹类型的子节点 ID
- 排除当前查看的图片的 fileId（图片本身不是文件夹，无需排除；但若用户在文件夹预览中复制文件夹本身，需要排除——本场景是图片查看器，只复制单张图片，所以无需排除）

### 移动文件后的处理
- 复制：图片仍在原文件夹，原生查看器 `images` 列表不变，仅 toast 提示成功
- 移动：图片已离开当前文件夹，原生查看器需要从 `images` 列表移除并切换下一张（类似删除流程，但不需要触发 `onDelete`，因为 JS 端 `handleMoveFiles` 会更新 state.files）

### 弹窗 UI 完整复刻 WebView
- 标题、搜索框（含清除按钮）、文件夹树（展开/折叠）、选中高亮、按钮（取消/确认）
- 移动版尺寸：宽度 `min(90vw, 360dp)`，高度 `screenHeight - 200dp`，最小 400dp
- 复用 `createRoundedBg`、`createDialogButton`、配色函数

## 实施步骤

### 步骤 1：NativeGalleryView.kt 新增文件夹选择弹窗

在 `showDeleteConfirmDialog` 下方新增 `showFolderPickerDialog` 方法：

```kotlin
/**
 * 显示文件夹选择弹窗（UI 与 WebView FolderPickerModal 一致）。
 * 用户选择目标文件夹后调用 listener?.onFolderPickerConfirm(fileId, targetId, type)。
 * type: "copy" 或 "move"
 */
fun showFolderPickerDialog(type: String, fileId: String, folderTreeJson: String) {
    // 解析 JSON
    // 构建 UI：标题 + 搜索框 + 文件夹树 RecyclerView/ListView + 取消/确认按钮
    // 搜索框：实时过滤树节点（保留匹配项及其祖先链）
    // 树节点点击：高亮选中（单选）
    // 确认按钮：未选中时禁用（50% 透明度）
    // 确认后：listener?.onFolderPickerConfirm(fileId, selectedId, type)，dismiss
}
```

UI 结构（垂直 LinearLayout 容器）：
1. **标题** TextView：18f, bold, `复制到文件夹...` / `移动到文件夹...`
2. **搜索框** LinearLayout（水平）：左侧 Search 图标 + EditText + 右侧 X 清除按钮（仅在有输入时显示）
3. **文件夹树** ListView 或自定义 RecyclerView：
   - 灰底 `colorTextBoxBg()`，圆角边框 `colorBorder()`
   - 树节点：缩进（depth × 16dp）+ ChevronDown/ChevronRight + Folder 图标（蓝色）+ 文件名
   - 选中项：蓝底 `colorAccent()` 白字
   - flex-1 占满剩余空间，可滚动
4. **按钮行** LinearLayout（水平，gravity=END）：
   - 取消（次按钮，`createDialogButton("取消", isPrimary=false)`）
   - 确认（主按钮，`createDialogButton("确认", isPrimary=true)`，未选中时 `alpha=0.5f` 且 `isEnabled=false`）

实现要点：
- 使用 `ListView` + 自定义 `BaseAdapter` 实现扁平化的可见节点列表（搜索后只显示匹配项+祖先链）
- 节点展开/折叠状态用 `expandedIds: MutableSet<String>` 维护
- 当前选中项用 `currentSelectedId: String?` 维护
- 树节点数据用 `data class FolderNode(id, name, parentId, children: List<String>)` 表示
- 搜索时 `filterVisibleNodes(roots, expandedIds, searchQuery)` 返回扁平化可见列表

需要的新 drawable：
- `ic_lucide_search.xml`（搜索放大镜，已存在？需检查）
- `ic_lucide_chevron_down.xml`（向下箭头）
- `ic_lucide_chevron_right.xml`（向右箭头）
- `ic_lucide_folder.xml`（文件夹图标）
- `ic_lucide_x_small.xml`（清除 X，14dp，复用 ic_lucide_x 缩放即可，或新建小尺寸）

### 步骤 2：NativeGalleryView 新增 Listener 回调

```kotlin
interface Listener {
    // ... 现有回调 ...
    /** 用户在文件夹选择弹窗中确认了目标文件夹。type: "copy" 或 "move" */
    fun onFolderPickerConfirm(fileId: String, targetFolderId: String, type: String)
}
```

### 步骤 3：MainActivity 实现 onFolderPickerConfirm + 新增 showFolderPicker 方法

```kotlin
// 在 listener 中新增
override fun onFolderPickerConfirm(fileId: String, targetFolderId: String, type: String) {
    evaluateJs("if(window.__androidViewerBridge&&window.__androidViewerBridge.onFolderPickerConfirm)window.__androidViewerBridge.onFolderPickerConfirm('${escapeJsString(fileId)}','${escapeJsString(targetFolderId)}','${type}');")
}

// 新增 public 方法供 Tauri 命令调用
fun showFolderPicker(type: String, fileId: String, folderTreeJson: String) {
    runOnUiThread {
        nativeGalleryView?.showFolderPickerDialog(type, fileId, folderTreeJson)
    }
}
```

### 步骤 4：src-tauri/src/lib.rs 新增 android_show_folder_picker 命令

```rust
#[cfg(target_os = "android")]
#[tauri::command]
async fn android_show_folder_picker(
    type_: String,
    file_id: String,
    folder_tree_json: String,
) -> Result<(), String> {
    // JNI 调用 MainActivity.showFolderPicker(type_, file_id, folder_tree_json)
    // 参考 android_close_native_viewer 的实现模式
    call_main_activity_void("showFolderPicker", "(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V", &[
        jni::objects::JValue::Object(...),  // type_
        jni::objects::JValue::Object(...),  // file_id
        jni::objects::JValue::Object(...),  // folder_tree_json
    ])
}
```

注意：`type` 是 Rust 关键字，参数名用 `type_`。

在 `tauri::generate_handler!` 列表中注册 `android_show_folder_picker`。

由于需要传 3 个 String 参数（而不是无参），不能复用 `call_main_activity_void`。需要在 android_open_native_viewer 模式基础上写一个新版本，或扩展 `call_main_activity_void` 支持 JValue 数组。

参考 `android_open_native_viewer` 的 JNI 调用模式（L1330-L1366）。

### 步骤 5：App.tsx 修改 onCopyToFolder / onMoveToFolder 处理

```typescript
onCopyToFolder: (fileId: string) => {
    // 不再弹 WebView FolderPickerModal
    // 收集文件夹树并调用原生层弹窗
    invokeAndroidFolderPicker('copy', fileId);
},
onMoveToFolder: (fileId: string) => {
    invokeAndroidFolderPicker('move', fileId);
},
```

新增 `invokeAndroidFolderPicker` 函数：
```typescript
const invokeAndroidFolderPicker = useCallback(async (type: 'copy' | 'move', fileId: string) => {
    // 收集 state.files 中所有文件夹节点
    const folders: Array<{id: string, name: string, parentId: string | null, children: string[]}> = [];
    Object.values(state.files).forEach(file => {
        if (file.type === FileType.FOLDER) {
            folders.push({
                id: file.id,
                name: file.name,
                parentId: file.parentId ?? null,
                children: (file.children ?? []).filter(cid => state.files[cid]?.type === FileType.FOLDER),
            });
        }
    });
    const folderTreeJson = JSON.stringify({ roots: state.roots, folders });
    await invoke('android_show_folder_picker', { type_: type, fileId, folderTreeJson });
}, [state.files, state.roots]);
```

### 步骤 6：App.tsx 新增 onFolderPickerConfirm 处理

在 `window.__androidViewerBridge` 注册 `onFolderPickerConfirm`：
```typescript
onFolderPickerConfirm: (fileId: string, targetFolderId: string, type: string) => {
    if (type === 'copy') {
        handleCopyFiles([fileId], targetFolderId);
    } else if (type === 'move') {
        handleMoveFiles([fileId], targetFolderId);
        // 移动后从原生查看器 images 列表移除并切换下一张
        // 通过 invoke('android_update_native_item', ...) 或新增命令通知原生层
    }
},
```

### 步骤 7：移动文件后从原生查看器移除图片

移动文件后，JS 端 `handleMoveFiles` 会更新 `state.files`，但原生查看器的 `images` 列表不会自动更新。需要通知原生层移除该图片：

**方案 A**（推荐）：新增 Listener 回调 `onRemoveImage(fileId)` 让 JS 通知原生层移除某图片
- MainActivity 通过 evaluateJs 调用 `window.__androidViewerBridge.onRemoveImage(fileId)`
- 但实际上应该反向：JS → 原生层

**方案 B**（更直接）：复用 `android_update_native_item` 命令或新增 `android_remove_native_image` 命令
- JS 端在 handleMoveFiles 成功后调用 `invoke('android_remove_native_image', { fileId })`
- Tauri 命令通过 JNI 调用 MainActivity.removeNativeImage(fileId)
- MainActivity 调用 NativeGalleryView.removeImage(fileId)

**方案 C**（最简）：原生层在 `onFolderPickerConfirm` 中直接调 `confirmMoveOut(fileId)`，类似 `confirmDelete` 但不触发 `onDelete`
- 复用 confirmDelete 的 images.removeAt + currentIndex 调整 + loadCurrent + onNavigate 逻辑
- 只是不调用 `listener?.onDelete`，因为 JS 端会处理实际的文件移动

**选择方案 C**：在 NativeGalleryView 中新增 `confirmMoveOut(fileId)` 方法，逻辑与 `confirmDelete` 相同但不调 `onDelete`。在 `onFolderPickerConfirm` 中，若 type === "move"，调用 `confirmMoveOut(fileId)`。

### 步骤 8：删除 App.tsx 中不再需要的 activeModal 设置

确认 `onCopyToFolder`/`onMoveToFolder` 处理函数不再设置 `activeModal`（避免弹出 WebView 弹窗）。

### 步骤 9：可能需要的 drawable 资源

检查现有 drawable 是否已含 `ic_lucide_search`、`ic_lucide_chevron_down`、`ic_lucide_chevron_right`、`ic_lucide_folder`，若缺失则新建（Lucide 风格，stroke=2，24dp viewport）。

## 文件修改清单

### 新建
- `src-tauri/gen/android/app/src/main/res/drawable/ic_lucide_search.xml`（若不存在）
- `src-tauri/gen/android/app/src/main/res/drawable/ic_lucide_chevron_down.xml`（若不存在）
- `src-tauri/gen/android/app/src/main/res/drawable/ic_lucide_chevron_right.xml`（若不存在）
- `src-tauri/gen/android/app/src/main/res/drawable/ic_lucide_folder.xml`（若不存在）

### 修改
1. **NativeGalleryView.kt**
   - Listener 接口新增 `onFolderPickerConfirm(fileId, targetFolderId, type)`
   - 新增 `data class FolderNode`
   - 新增 `fun showFolderPickerDialog(type, fileId, folderTreeJson)` 公共方法
   - 新增 `private fun confirmMoveOut(fileId)` 私有方法（类似 confirmDelete 但不调 onDelete）
   - 新增文件夹树 Adapter 类（内部）
   - `showMoreMenu` 中"复制到文件夹"和"移动到文件夹"不再调用 `listener?.onCopyToFolder/onMoveToFolder`，改为**仍然调用**这两个回调（让 JS 收集文件夹树数据），由 JS 决定后续行为
   - 注：`showMoreMenu` 中的两个菜单项调用方式不变，只是 JS 端的处理逻辑改变了

2. **MainActivity.kt**
   - listener 新增 `onFolderPickerConfirm` 实现（evaluateJs 通知 JS）
   - 新增 `fun showFolderPicker(type, fileId, folderTreeJson)` public 方法

3. **src-tauri/src/lib.rs**
   - 新增 `#[tauri::command] async fn android_show_folder_picker(type_, file_id, folder_tree_json)` 命令
   - 在 `tauri::generate_handler!` 列表中注册

4. **src/App.tsx**
   - 修改 `onCopyToFolder`/`onMoveToFolder` 处理：不再 `setState activeModal`，改为收集文件夹树 + `invoke('android_show_folder_picker', ...)`
   - 新增 `invokeAndroidFolderPicker(type, fileId)` 函数
   - 在 `window.__androidViewerBridge` 注册 `onFolderPickerConfirm(fileId, targetFolderId, type)` 处理函数
   - 注：`handleMoveFiles` 内部已包含 `performDeleteFiles` 类似的状态更新逻辑（从 state.files 移除），无需额外处理

## 假设与决策

1. **假设**：用户在原生查看器中只对单张图片执行复制/移动操作（图片查看器场景），不需要支持多选
2. **假设**：文件夹树数据量在合理范围内（<2000 个文件夹），JSON 序列化和原生解析性能可接受
3. **决策**：保留 `onCopyToFolder/onMoveToFolder` 现有接口不变，只改变 JS 端的处理逻辑——降低改动范围
4. **决策**：移动后从原生查看器 images 列表移除（复用 confirmDelete 逻辑）——用户体验与删除一致
5. **决策**：复制后原生查看器不变（图片仍在原文件夹）——仅 toast 提示
6. **决策**：不处理 LAN 文件夹的复制/移动（LAN 图片不显示这些菜单项，或在 JS 端回退到 WebView 弹窗）
7. **决策**：弹窗宽度使用固定值 `min(screenWidth * 0.9, 360 * density)px`，高度 `screenHeight - 200dp`（最小 400dp）——与 WebView 移动版一致

## 验证步骤

1. **编译验证**：`.\gradlew.bat :app:compileArm64DebugKotlin` 通过
2. **Rust 编译验证**：`cargo build --target aarch64-linux-android` 或 Tauri build 通过
3. **功能测试**：
   - 打开原生查看器 → 更多 → 复制到文件夹 → 弹窗显示 → 选择目标 → 确认 → toast 显示"已复制" → 原图仍在查看器
   - 打开原生查看器 → 更多 → 移动到文件夹 → 弹窗显示 → 选择目标 → 确认 → toast 显示"已移动" → 当前图片从查看器移除，切换到下一张
   - 搜索框输入关键词 → 树节点实时过滤 → 清除按钮清空搜索
   - 折叠/展开文件夹节点 → 子节点正确显示/隐藏
   - 未选择目标时确认按钮禁用（50% 透明度）
4. **UI 一致性验证**：与 WebView FolderPickerModal 对比，标题/搜索框/树/按钮样式基本一致
5. **主题验证**：深色/浅色主题切换，弹窗配色正确
