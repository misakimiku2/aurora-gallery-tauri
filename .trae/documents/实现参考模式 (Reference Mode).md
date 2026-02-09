## 需求概述
在图片对比组件 `ImageComparer.tsx` 中新增"参考模式"，该模式具有以下特性：
1. 在顶部工具栏吸附功能按钮右边新增进入参考模式的按钮
2. 进入参考模式时：
   - 关闭左侧面板与右侧详情面板，并隐藏这两个切换按钮
   - 软件窗口始终在前（使用 TabBar.tsx 中已有的实现方式）
   - 解除软件窗口 1280*800 的限制，更改为最小缩放到 200*200

## 实现计划

### 1. 修改 `tauri.conf.json`
- 将 `minWidth` 和 `minHeight` 从 1280x800 改为 200x200
- 这是全局配置，允许窗口缩小到 200x200

### 2. 修改 `ImageComparer.tsx`
- 添加 `isReferenceMode` 状态
- 在顶部工具栏吸附按钮右侧添加"参考模式"切换按钮（使用 Eye 或 Focus 图标）
- 当进入参考模式时：
  - 调用 `onLayoutToggle` 关闭左侧面板和右侧面板（如果它们是打开的）
  - 隐藏侧边栏切换按钮和详情面板切换按钮
  - 通过调用 Tauri API 设置窗口始终在前
- 当退出参考模式时：
  - 恢复显示面板切换按钮
  - 取消窗口始终在前设置

### 3. 修改 `tauri-bridge.ts`
- 添加 `setWindowAlwaysOnTop` 函数，用于调用 Tauri 的 `set_always_on_top` 命令
- 添加 `setWindowMinSize` 函数，用于动态调整窗口最小尺寸（如果需要）

### 4. 修改 `main.rs` (如果需要)
- 添加新的命令处理函数来支持窗口最小尺寸的动态调整

## 文件修改详情

### `src-tauri/tauri.conf.json`
```json
"minWidth": 200,
"minHeight": 200,
```

### `src/components/ImageComparer.tsx`
- 导入 `getCurrentWindow` from `@tauri-apps/api/window`
- 添加 `isReferenceMode` state
- 在工具栏添加参考模式按钮（在 Magnet 按钮旁边）
- 实现 `toggleReferenceMode` 函数
- 根据 `isReferenceMode` 条件渲染侧边栏和详情面板切换按钮

### `src/api/tauri-bridge.ts`
- 添加 `setAlwaysOnTop` 函数封装

### `src-tauri/src/main.rs`
- 添加 `set_window_min_size` 命令（如果需要动态调整）

## 预期效果
- 用户点击"参考模式"按钮后，窗口进入特殊模式
- 左右面板自动关闭，切换按钮隐藏
- 窗口保持最前，可以缩小到 200x200 作为参考窗口使用