# Changelog: Updates from Code (generated from current code)

**生成时间**: 2026-01-15
---
### 2026-01-15 更新 (本次系统性修复)
**修复与优化**:
- **Tauri 2.0 启动稳定性**: 解决了在 Windows 环境下由于 Vite 冷启动缓慢导致的 `AssetNotFound("index.html")` 和 `500` 错误。
- **端口迁移**: 将开发服务器端口从 `1422` 迁移至 `14422`，以避开常见的本地端口冲突。
- **智能重定向 (Failsafe Redirect)**: 在 `dist` 目录引入自动跳转机制，即使 Webview 错误加载本地文件也能自动恢复到 dev 服务器。
- **权限与能力补丁**: 同步更新 `src-tauri/capabilities/default.json`，解决了切换端口后出现的 `is_maximized` 和 `event.listen` 权限被拒问题。
- **自愈清理脚本**: 增强 `npm run clean`，使其能够自动释放被残留进程占用的网络端口。

### 2026-01-15 晚间更新 (重构与修复)
**代码重构**:
- **App.tsx 瘦身**: 将大量内联模态框组件提取到 `src/components/modals/` 目录中（包括 `RenameTagModal`, `AddToTopicModal`, `BatchRenameModal` 等 13 个组件）。
- **逻辑抽离**: 将任务管理逻辑（startTask, updateTask 等）提取到自定义 Hook `src/hooks/useTasks.ts` 中，减轻 App.tsx 负担。

**Bug 修复**:
- **任务管理修复**: 修复了最小化任务无法恢复、任务进度到达 100% 不自动关闭、侧边栏暂停/继续按钮失效的问题。
- **重命名功能修复**: 重新实现了 `handleBatchRename` 逻辑，修复了批量重命名无法确认和进度条残留的问题。
- **拖拽进度修复**: 修正了外部拖拽文件时进度条显示溢出（如 1200%）的问题。
- **UI 交互修复**: 修复了人物界面 Shift 范围多选时遗漏中间项的问题。
- **测试支持**: 为 `WelcomeModal` 添加了 `window.showWelcomeModal()` 测试接口。
---

## 概要
对 `memory/` 中文档做了一次代码驱动的同步更新，以保证文档以当前代码为准。

已补充若干在源码中新出现但未完整列出的项：包括自定义 Hooks（`useAIAnalysis`、`useFileOperations`、`useContextMenu` 等）以及组件 `ContextMenu.tsx`、`ToastItem.tsx` 等。文档已与当前 `src/` 目录对齐。

**修改文件**:
- `API_REFERENCE.md` ✅ (minor updates)
- `MODULE_DISTRIBUTION.md` ✅ (added PersonGrid component)
- `PROJECT_STRUCTURE.md` ✅ (updated component list)
- `QUICK_REFERENCE.md` ✅ (updated dependencies)
- `TECHNICAL_ARCHITECTURE.md` ✅ (AI analysis changes)

## 主要变更点（按代码引用）

### 1. 前端组件重构 (src/components/)
- **新增 PersonGrid 组件**: 将人物界面从 FileGrid 中分离出来形成独立的 `PersonGrid.tsx` 组件 (224 行)（以源码为准 · 已同步），提供专门的人物网格视图和管理功能。
- **SettingsModal 增强**: 新增系统提示预设功能，支持创建、编辑、删除和管理 AI 提示模板。
- **ContextMenu 样式优化**: 针对不同类型的上下文菜单（文件、文件夹）应用不同的深色主题样式。

### 2. AI 服务优化 (src/App.tsx)
- **AI 分析性能优化**: 移除了 AI 模型对 dominantColors 的分析，改为仅通过图像处理提取，减少 AI 计算开销。
- **兼容性保持**: dominantColors 字段保留为空数组以保持向后兼容性。

### 3. 构建配置更新 (package.json)
- **开发脚本优化**:
  - `clean:dev`: 简化脚本，移除 VITE_FORCE_DEV_LOGS 环境变量设置
  - `tauri:dev`: 改为使用 concurrently 并行运行前端开发服务器和 Tauri 开发模式
- **新增依赖**:
  - `concurrently@^9.2.1`: 支持并行运行多个命令
  - `wait-on@^9.0.3`: 等待服务启动后再运行依赖命令

### 4. 技术架构调整
- **AI 分析流程**: dominantColors 现在通过专用图像处理算法提取，不再消耗 AI tokens
- **并发开发**: 前后端开发模式现在并行运行，提高开发效率

## 下一步建议
- 考虑为 `file_metadata` 表添加全文搜索（FTS）支持，以进一步提升大规模描述信息的搜索速度。
- 建议为数据库添加定期自动备份机制。
- 继续优化 App.tsx，将其过于庞大的状态逻辑进一步组件化。

---

如果你希望我把这些更改直接提交到分支，请告诉我目标分支名（或我可以创建一个新的 doc-sync 分支）。