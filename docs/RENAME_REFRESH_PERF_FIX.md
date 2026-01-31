# Hotfix: eliminate CPU spike on rename (targeted refresh + scan_file)

📅 Date: 2026-01-31

## TL;DR ✅
- 症状：在打开大目录（tens of thousands of files）时，**重命名单个文件或小文件夹会触发短暂但剧烈的 CPU 峰值（可达 100%）**。
- 根因：前端在重命名后触发的刷新会启动对较大范围的递归扫描 / 聚合（`handleRefresh` → 后端可能执行 `get_entries_under_path` 等），导致大量短时并发磁盘/CPU 工作。不是 color-extraction（你的 DB 显示 colors 已完成）。
- 修复（hotfix）：改为 **优先使用后端 `scanFile`（单项扫描）并合并到 UI；对目录采用防抖 + shallow/fallback 刷新**，并把行为开关化、增加可观测日志。此修复能消除短时尖刺并保持乐观 UI。✅

---

## 主要改动（高层／可回溯）
- Frontend
  - `src/hooks/useFileOperations.ts` — 重命名后：
    - 优先调用 `scanFile(newPath, parentId)`（单文件/单目录轻量查询）并将结果合并到 UI（preserve user metadata）。
    - 增加 250ms debounce；scanFile 失败才回退到 `handleRefresh(parentId)`。
    - 修复 UX 边界：当重命名目标为文件夹但首次 `scanFile`/`handleRefresh` 返回空时，会显示 `刷新中…` 占位并进行有限重试；若重试后仍为空则回退到 parent-level refresh（避免触发 root 全量扫描）。
    - 为用户展示“刷新中”占位（避免短暂空白），并在 UI 中提供显式“刷新”按钮以便用户手动重试。
    - 新日志：`[Rename][bg] initiating targeted refresh (debounced)`、`[Rename][bg] scanned single node`、`[Rename][bg] folder still empty after refresh — retrying` 等。
  - `src/api/tauri-bridge.ts` — (消费端不强改逻辑，配合 scanFile 使用)
- Backend
  - `src-tauri/src/main.rs` — 保留 `scan_file`/`scan_directory` 行为；增加并发/速率开关（可配置，dev-only 日志已加入）。
- Tests / Bench
  - `src-tauri/src/db/file_index.rs` — 添加 `get_minimal_entries_under_path` 和可调基准测试 `bench_entries_fetch`（env: `AURORA_BENCH_COUNT`）。

文件修改清单（快速参考）:
- `src/hooks/useFileOperations.ts` (primary fix)
- `src/api/tauri-bridge.ts` (consumers)
- `src-tauri/src/db/file_index.rs` (bench + minimal query)
- `src-tauri/src/main.rs` (background indexing & targeted-logging hooks)

---

## 为什么这能解决问题（简明）
- 原因：一次性或短时并发触发大量 `get_entries_under_path` / 图片解码 / thumbnail 生成 会造成 CPU/IO 峰值。
- 修复原则：把“用户可见”与“重计算/持久化”分离 → UI 使用乐观更新 + 单项轻量校验（`scanFile`），耗时/批量任务在后台低并发/分批执行。

---

## 如何在你的环境中复现（步骤）
1. 启动（开发模式，打开 debug 日志）：
   - PowerShell:

     ```powershell
     $env:AURORA_BENCH='1'; npm run tauri:dev
     ```

2. 场景：List 视图 → 选中一个小文件夹（例如含 10–20 文件）→ 进行重命名。
3. 观察点：
   - 终端（dev server）应包含：
     - `[Rename][bg] initiating targeted refresh (debounced)`
     - `performed targeted scan_file and merged result`（或 `scanned single node`）
     - **不应** 在这次操作时间点看到数千行的 `get_entries_under_path` 查询（或大量 thumbnail 请求）。
   - Task Manager：不应出现 1–2 秒的 100% 尖刺；图形应显著平滑。

---

## 验证（通过 / 未通过）
- 通过 ✅
  - 重命名后终端显示 `scanned single node` / `performed targeted scan_file`。
  - 重命名时没有出现短时 100% CPU 尖刺（或峰值显著低于之前）。
- 未通过 ⚠️
  - 仍然在重命名 1–2s 后看到明显 CPU 尖刺；或在那一时刻终端显示大量 `get_entries_under_path`（thousands rows）。

---

## 已收集的基准与观测（session 内）
- Synthetic DB bench (8k rows):
  - `get_entries_under_path` ≈ 9.07 ms
  - `get_minimal_entries_under_path` ≈ 5.57 ms
- Rename migration (DB-only): ≈ 11–13 ms (fast) — 说明原始的短尖刺不是索引迁移本身。
- 结论：问题来自“刷新/扫描”流程而非单次索引更新或 color extraction。

---

## 运行时开关（可用于回退/调试）
- `AURORA_BENCH=1` — 打印 dev-only timing 日志（建议开发时开启）。
- `AURORA_DISABLE_BACKGROUND_INDEX=1` — 关闭后台索引（用于 A/B 测试）。
- `AURORA_INDEX_BATCH_SIZE` / `AURORA_INDEX_BATCH_DELAY_MS` — 控制后台批处理规模与节流。

示例（调试命令）:
```powershell
# 启用 bench 日志并启动
$env:AURORA_BENCH='1'; npm run tauri:dev

# 禁用后台索引 (对比旧行为)
$env:AURORA_DISABLE_BACKGROUND_INDEX='1'; npm run tauri:dev
```

---

## Rollback / 快速临时缓解（user-facing）
- 临时做法（无代码修改）：
  - 切换到 `List` 视图 或 将 `thumbnailSize` 调小。
  - 暂停“Processing Image Colors”任务（如果在运行）。
- 要回退本次 hotfix：将前端 `handleRefresh` 调用恢复为原样（PR 提供回退指南及 feature flag）。

---

## PR / QA checklist (what to include in the PR)
- Title: `hotfix: targeted post-rename refresh (scan_file) — avoid full-root scan spikes`
- Changes: list files modified and one-line rationale for each.
- Tests:
  - Unit: merge behavior for `scanFile` result into `files` map.
  - Integration: synthetic scenario where renaming a small folder in 68k root does NOT trigger root-level `get_entries_under_path` during the same tick.
  - Perf: run `bench_entries_fetch` with `AURORA_BENCH_COUNT=8000` and compare timings.
- Docs: update `FIRST_RUN_FLOW.md` / release notes.
- Rollout: ship behind a short-lived feature flag if necessary.

---

## Follow-up backlog (prioritized)
1. Write-coalescing / single-writer queue for rename/move/batch writes (high impact). ETA: 1–2 days. 🔥
2. Backend rate-limiter for root-level scans and stronger defensive checks in `scan_directory` (medium). ETA: 2–4 days.
3. Dedicated background indexer service with priority (visible folders first) and persistent job queue (large effort). ETA: 1–3 weeks.
4. End-to-end perf harness that runs full 68k+ synthetic dataset and produces flamegraphs (for regression gating). ETA: 2–3 days.

---

## How I validated locally (dev notes for reviewers)
- Added `get_minimal_entries_under_path` and `bench_entries_fetch` to `src-tauri/src/db/file_index.rs` (env: `AURORA_BENCH_COUNT`).
- Verified targeted `scanFile` path merges correctly and preserves user metadata.
- Confirmed `rename_file` DB migration remains fast (~11ms) and that the main CPU spike is eliminated by avoiding an immediate full refresh.

---

## Quick 