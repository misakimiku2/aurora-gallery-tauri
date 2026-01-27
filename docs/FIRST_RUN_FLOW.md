# 首次使用（First-run）流程说明

本文档描述应用在“首次运行”时，从显示欢迎向导到进入主界面的完整时序、涉及的前后端交互、关键事件与注意事项。适用于开发者阅读和维护 onboarding 流程。

---

## 概要

- 目标：首次打开应用时展示欢迎向导，引导用户选择资源根目录并进行初始扫描；立即向用户提供界面反馈（占位骨架 & 进度），将耗时的主色提取延后到用户确认“开始使用”之后再启动。
- 好处：避免首次打开时界面空白或直接触发大量后台工作；给用户即时响应与可控体验。

## 主要参与组件 / 文件

- 前端
  - [src/App.tsx](src/App.tsx) — 应用初始化、欢迎向导控制、`handleOpenFolder`、`scanAndMerge` 等逻辑。
  - [src/components/modals/WelcomeModal.tsx](src/components/modals/WelcomeModal.tsx) — 欢迎向导 UI、进度显示与步骤切换。
  - `useTasks` / `useFileSearch` 钩子 — 接收并展示后台任务进度。

- 后端（Tauri / Rust）
  - [src-tauri/src/main.rs](src-tauri/src/main.rs) — `scan_directory` 实现、事件发射、批量写入 pending 队列。
  - [src-tauri/src/color_db.rs](src-tauri/src/color_db.rs) — 将扫描到的路径写入 pending 表的函数（批处理逻辑）。
  - [src-tauri/src/color_worker.rs](src-tauri/src/color_worker.rs) — color extraction worker，负责消费 pending 表并发出进度事件。

## 时序步骤（详细）

1. 启动与欢迎页决策
   - 前端启动时会调用后端命令 `load_user_data()`（在 `src/App.tsx`）。
   - 如果没有已保存的用户数据（首次运行），前端设置 `showWelcome = true` 并显示欢迎向导，否则直接加载上次配置的资源根目录。

2. 第1页：用户选择目录（即时反馈）
   - 用户在向导第一页选择目录后，前端立即：
     - 在 UI 中创建“骨架根”（占位 root node）并插入到 tabs/roots 状态，避免主界面空白。参见 `handleOpenFolder` 实现。
     - 调用后端命令 `pause_color_extraction()`，确保即便后端把任务写入 pending 表，也不会被 worker 立即消费。
     - 异步调用后端 `scan_directory(path)` 开始扫描。扫描在后台运行，不阻塞 UI。
   - 前端监听后端发射的 `scan-progress` 事件并在欢迎页显示进度条（格式例如：processed / total 文件）。

3. 后端扫描与入库（`scan_directory`）
   - 后端遍历文件系统，统计图片文件并构建 FileNode 列表。
   - 定期通过事件 `scan-progress` 向前端发射进度更新（例如每 N 个文件发一次）， payload 包含 `processed` 与 `total`。
   - 扫描完成后，前端/后端会按批（当前 chunk = 500）调用写入函数，把路径写入 colors pending 表；**chunk 大小在** `src-tauri/src/main.rs` 的 `add_pending_files_to_db` 中定义，实际写入操作由 `color_db::add_pending_files` 完成（使用 `INSERT OR IGNORE` 做幂等去重）。

4. 第2页与点击“开始使用”→ 进入主界面
   - 用户确认并点击“开始使用”时，前端会：
     - 把资源根写入前端 state（立即可见）。注意：用户配置的持久化并不依赖于 `handleWelcomeFinish` 中显式调用 `save_user_data()` —— 应用通过一个自动保存的 effect（state 变化触发）异步将数据写入后端。
     - 调用 `resume_color_extraction()`（`handleWelcomeFinish` 中调用），允许 color worker 从 pending 表开始消费并处理色提取任务。
     - 将后端扫描结果合并到前端 state（当前实现：`scanAndMerge` **一次性**合并完整结果以替换骨架根，从而立即显示真实内容）。如果需要更平滑的首次渲染，可改为“分片/流式合并”（见“可选优化建议”）。

5. 后台色提取与进度回传
   - color worker 消费 pending 表并处理图片主色提取任务。
   - worker 向前端发射进度事件（例如 `color-extraction-progress`），前端通过 `useTasks` 或任务面板展示处理速率、已完成数量等。
   - 提取结果写入 colors DB（SQLite），前端读取后在图片缩略或详情中展示色板信息。

6. 持久化与数据位置
   - 用户设置（resource root、偏好）由后端保存到应用数据目录（例如 Windows 下 `AppData\\Roaming\\com.aurora.gallery`）。
   - pending 任务和色彩数据保存在 SQLite 文件（`colors.db`）中，由后端管理。

## 后端事件 / 命令清单（示例）

- 前端调用（通过 Tauri invoke）
  - `load_user_data()` — 读取用户配置
  - `save_user_data(data)` — 保存用户配置
  - `scan_directory(path)` — 启动目录扫描并在后台发射 `scan-progress`
  - `pause_color_extraction()` — 暂停 color worker 消费 pending 队列
  - `resume_color_extraction()` — 恢复 color worker

- 后端发射事件（前端监听）
  - `scan-progress` — { processed: number, total: number }
  - `color-extraction-progress` — 进度/速率信息（由 color worker 发射）

## 注意事项与边界条件

- 如果用户在第1步选择目录后关闭向导但不点击“开始使用”，扫描可能依然在运行且 pending 表已写入，但色提取会保持暂停（直到显式调用 `resume_color_extraction`）。
- 批量写入大小（当前为 500）会影响 DB 事务开销与内存使用：更大批次减少事务次数但会占用更多内存。
- `scan-progress` 的更新频率影响 UI 流畅度，建议后端按固定间隔或固定数量发出事件（例如每 20–100 个文件）。

## 可选优化建议

- 在 `scan-progress` 中加入速率（files/sec）和 ETA 估算，提升用户对剩余时间的感知。
- 将批量写入的大小和 `scan-progress` 的频率暴露为可配置项，便于在低内存或慢磁盘上调整。
- 在前端把扫描结果分片合并（逐步插入节点而非一次性合并）以优化首次渲染性能。

## 开发者快速调试命令

在本地开发时，可能需要启动 Vite 与 Tauri：

```powershell
# 启动 vite 前端（如端口占用可换端口）
npm run dev -- --port 14423

# 启动 tauri 开发（并发启动前端）
npm run tauri:dev

# 若端口被占用，可列出并结束进程（Windows）
netstat -ano | findstr 14422
taskkill /PID <pid> /F
```

---

文档已包含关键文件引用与时序步骤；如需我生成序列图（PlantUML）或把流程加入 README，请告诉我你想要的格式。
