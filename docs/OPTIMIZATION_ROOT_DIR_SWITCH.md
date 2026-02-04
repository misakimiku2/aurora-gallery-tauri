# 根目录切换体验优化 (Root Directory Switching Optimization)

**日期**: 2026年2月4日
**状态**: 已完成

## 背景与问题

此前，在设置中切换软件根目录（Resource Root）时，存在以下体验问题：
1.  **界面冻结**：切换过程是同步等待后端扫描完成的，导致界面长时间无响应。
2.  **状态滞后**：在扫描新目录期间，界面仍然显示旧目录的文件内容，给用户造成困惑。
3.  **进度反馈缺失**：虽然会弹出一个后台任务弹窗，但一直卡在 0%，直到扫描瞬间完成。这是因为前端任务没有监听后端的扫描进度事件。
4.  **翻译缺失**：部分任务状态提示语显示为代码键值（如 `tasks.scanning`）。

## 优化方案

本次优化重构了 `src/App.tsx` 中的 `handleChangePath` 逻辑，实现了即时反馈和事件驱动的进度展示，并引入了数据库物理隔离机制。

### 1. 交互流程重构

*   **即时响应**：用户选定新文件夹后，前端立即清空当前的 `files`、`roots` 和 `tabs` 状态，并强制关闭设置弹窗。让界面进入“准备中”的空状态，明确告知用户操作已生效。
*   **任务管理**：
    *   创建一个新的后台任务 "扫描文件中..." (Scanning files...)。
    *   禁用任务的 `autoProgress`（自动模拟进度），改为完全由后端事件驱动。
    *   预设一个初始状态 "准备中..." (Preparing...)，防止进度条在扫描初始化阶段显得卡死。

### 2. 进度监听机制

*   **事件驱动**：在调用同步的 `scanDirectory` 命令前，临时建立对 `scan-progress` 事件的监听。
*   **实时更新**：
    *   后端每扫描一定数量文件（如500个）发送一次事件。
    *   前端接收 `{ processed, total }` 数据，实时调用 `updateTask` 更新进度条百分比和文本提示（如 "扫描中... 1500"）。

### 3. 数据隔离与私有数据库

*   **物理隔离**：数据库文件（`metadata.db` 和 `colors.db`）不再存储在全局的 `AppData` 目录中，而是存储在每个根目录下的 `.aurora/` 隐藏文件夹内。
*   **动态切换**：
    *   在切换资源目录时，前端会先调用 `switch_root_database` 指令。
    *   后端会关闭当前的连接池，开启对新路径下数据库的连接，并重置颜色提取缓存。
*   **任务安全**：切换期间会自动暂停 (Pause) 和恢复 (Resume) 后台颜色扫描任务，防止数据跨库写入。

### 4. 完成与清理

*   **平滑过渡**：`scanDirectory` 返回后，手动将任务进度设为 100%，稍作延迟后移除任务，给用户完成的视觉反馈。
*   **状态更新**：使用扫描返回的完整文件树更新 `App` 状态，并自动创建一个新标签页打开根目录。

### 6. 任务激活与界面同步 (新增)

*   **自动触发颜色提取**：在切换目录、应用启动和手动刷新时，显式调用 `addPendingFilesToDb`。确保新数据库中的 `pending_files` 队列被填充，解决切换根目录后颜色提取不开始的问题。
*   **侧边栏实时刷新**：改进 `TreeSidebar.tsx` 的渲染策略。在根目录（`roots`）变化时，强行解除侧边栏的“渲染冻结”状态并同步 `scrollTop`，使用户无需移动鼠标即可看到新目录的文件夹树。

## 修改文件列表

| 文件路径 | 修改内容 |
| :--- | :--- |
| `src/App.tsx` | 重构 `handleChangePath` 方法，添加进度监听、状态重置、数据库切换及颜色提取任务补全逻辑；优化启动初始化流程。 |
| `src/components/TreeSidebar.tsx` | 修复根目录切换后界面冻结不刷新的问题。 |
| `src-tauri/src/db/mod.rs` | 重构 `AppDbPool` 以支持在运行时动态切换数据库物理路径。 |
| `src-tauri/src/color_db.rs` | 重构 `ColorDbPool` 以支持动态切换并自动清空内存颜色缓存。 |
| `src-tauri/src/main.rs` | 暴露 `switch_root_database` 指令，并优化启动时的数据库加载逻辑。 |
| `src/utils/translations.ts` | 添加 `tasks.scanning` 和 `tasks.preparing` 翻译键值。 |

## 代码片段 (App.tsx)

```typescript
// 暂停后台扫描并切换数据库
if (isTauriEnvironment()) {
  await pauseColorExtraction();
  await switchRootDatabase(selectedPath);
}

// 立即更新 UI 状态，清空当前文件列表
setState(prev => ({
  ...prev,
  files: {},
  roots: [],
  tabs: [],
  settings: newSettings,
  isSettingsOpen: false
}));
```
