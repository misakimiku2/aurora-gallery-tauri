# Changelog: Updates from Code (generated from current code)

**生成时间**: 2026-01-14

## 概要
对 `memory/` 中文档做了一次代码驱动的同步更新，以保证文档以当前代码为准。

**修改文件**:
- `API_REFERENCE.md` ✅ (minor updates)
- `MODULE_DISTRIBUTION.md` ✅ (added PersonGrid component)
- `PROJECT_STRUCTURE.md` ✅ (updated component list)
- `QUICK_REFERENCE.md` ✅ (updated dependencies)
- `TECHNICAL_ARCHITECTURE.md` ✅ (AI analysis changes)

## 主要变更点（按代码引用）

### 1. 前端组件重构 (src/components/)
- **新增 PersonGrid 组件**: 将人物界面从 FileGrid 中分离出来形成独立的 `PersonGrid.tsx` 组件 (~219 行)，提供专门的人物网格视图和管理功能。
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