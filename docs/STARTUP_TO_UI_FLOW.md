# 启动到主界面可见 — 详细时序（Startup → UI ready）

目标：描述从用户启动应用（或运行 dev 命令）到主界面成为可交互状态的**逐步执行流程**、涉及的前后端调用、可阻塞点、常见故障排查方法与开发者检查清单。供开发者、QA 与运维参考。

---

## 概览（TL;DR） ✅
- OS / 命令 → 启动 Tauri/Rust 进程（或 Vite + Tauri dev）
- WebView 加载前端 → `src/main.tsx` 启动日志与 React
- React 挂载 `App` → 显示 `SplashScreen`
- `App` 的初始化 effect 异步加载用户数据、配置与 DB（并注册事件监听）
- 根据是否为首次运行走不同分支（Welcome 或 恢复上次状态）
- 关键资源就绪后调用 `setShowSplash(false)` → 主界面可交互

平均到达 UI-ready 的时间范围（估计）：
- 无 I/O 且已缓存配置：< 200 ms
- 读取小型 user_data + DB 打开：50–400 ms
- 首次扫描（手动触发）：多秒到若干分钟（取决于文件数与磁盘）

---

## 受众
- 开发者、维护者、QA、性能排查人员

---

## 逐步时序（非常详细） 🔁
每一步后面都列出：实现文件、关键函数/事件、可能的阻塞点与建议的诊断命令。

1) 启动命令 / OS 层
- 触发点：用户双击可执行文件或运行 `npm run tauri:dev`（dev：Vite + Tauri）。
- 参考：`package.json` (`tauri:dev`)。
- 常见问题：dev 模式需要先让 Vite 成功监听端口，否则 Tauri 会等待并超时。
- 排查：查看两个终端（Vite 与 Tauri）。

2) 后端（Rust）初始化
- 做什么：创建主窗口、初始化 DB 池、启动 color worker、注册 `#[tauri::command]`。
- 代码位置：`src-tauri/src/main.rs`（窗口创建、命令注册、worker 启动）。
- 阻塞点：Rust 在启动时做大量 I/O（打开/迁移 SQLite、建立线程池）。
- 排查命令：观察 Tauri 控制台输出（在 dev 模式下会显示在 tauri 终端）。

3) WebView 加载前端资源
- 做什么：加载静态 HTML/JS（或 dev server）；浏览器环境脚本开始执行。
- 代码位置：前端入口 `src/main.tsx`。
- 阻塞点：dev server 未就绪、静态文件缺失或 CSP/加载错误。
- 排查：打开 DevTools 控制台与 Network 面板。

4) 前端启动：日志 & React 挂载（短）
- 做什么：`configureTauriLogs()`（attach Rust 日志 到前端控制台）；React render `<App />`。
- 代码位置：`src/main.tsx`（日志）、`src/components/SplashScreen.tsx`（UI）。
- 可验证：在控制台能看到来自 Rust 的日志（若是 Tauri 环境）。

5) App 初始化 effect（关键 ■）
- 做什么（并发/顺序混合）：
  - 检测环境：`detectTauriEnvironmentAsync()` / `isTauriEnvironment()`（`src/utils/environment.ts`）
  - 读取默认路径与用户数据：`tauriGetDefaultPaths()`、`tauriLoadUserData()`（`src/api/tauri-bridge.ts` → Rust）
  - 从本地 DB 读取实体：`dbGetAllPeople()`
  - 注册事件监听：`listen('scan-progress', ...)`, `listen('color-extraction-progress', ...)`
  - 启动并行检查：AI 连通性检查（`aiService.checkConnection`）等
- 代码位置：`src/App.tsx`（init effect，多个分支）
- 典型阻塞点：磁盘 I/O（读 user_data、打开 SQLite）、慢网络（AI 检查）、首次 DB 初始化
- 调试提示：在 `src/App.tsx` init effect 放置 `console.debug` 或在 devtools 中断点，检查 `tauriLoadUserData()` 的返回值

6) 首次运行 vs 常规启动 决策
- 条件：`tauriLoadUserData()` 返回是否有已保存数据
- 首次运行：
  - 操作：`setShowWelcome(true)` → 显示 Welcome
  - 行为：短延迟隐藏 Splash（`setTimeout(() => setShowSplash(false), 200)`）以快速显示欢迎 UI
  - 代码位置：`src/App.tsx`
- 常规启动：
  - 操作：合并 saved settings、恢复 tabs/roots、可能触发自动扫描或缩略图预热，然后隐藏 Splash

7) Splash 隐藏（何时可见→不可见）
- 触发点：当“关键初始化”完成（已加载配置并设置初始 UI 状态），或首次运行的快速路径触发短延迟
- 关键调用：`setShowSplash(false)`（在 `src/App.tsx` 的若干分支）
- 代码位置：`src/components/SplashScreen.tsx`（视图） + `src/App.tsx`（控制）

8) 主界面可交互（UI-ready）
- 界面元素：Sidebar、FileGrid、TopBar 等渲染并响应用户输入
- 后台继续：缩略图流（`get_thumbnails_batch`）、色彩提取 worker（如已 resume）、AI 检测、文件系统监听
- 验证：UI 能接收点击、能够打开目录、缩略图流开始加载

---

## 关键事件 / 命令 与 载荷（可用于集成测试）
- 前端 invoke → 后端 command
  - `tauriLoadUserData()` → 读取 `user_data.json`
  - `tauriGetDefaultPaths()` → 返回平台默认路径
  - `scan_directory(path)` → 开始扫描并在后端 emit `scan-progress`
  - `add_pending_files_to_db([...])` → 批量写入 pending（默认 batch_size = 500）
  - `pause_color_extraction()` / `resume_color_extraction()`

- 后端 emit → 前端 listen
  - `scan-progress` — payload: { processed: number, total: number }
  - `color-extraction-progress` — 进度/速率信息

---