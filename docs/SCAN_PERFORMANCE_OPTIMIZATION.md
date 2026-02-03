# 文件扫描性能优化技术文档 (Performance Optimization Log)

## 背景
针对用户拥有 **68,000+ 文件**及深层嵌套目录（350+ 文件夹）的超大规模库，原生扫描逻辑导致启动耗时高达 **26秒** 以上，且 CPU 占用率极高。

## 优化目标
- 将 68k 规模文件的启动扫描时间降低至 **6秒以内**。
- 显著降低扫描期间的 CPU 占用，消除界面卡顿。
- 在“首次使用（仪式感/准确性）”与“日常启动（极速）”之间取得平衡。

---

## 技术变更详情 (Technical Implementation Details)

### 1. 跨进程通信 (IPC) 频率限制 (Throttling)
- **旧逻辑**：后端 Rust 每处理一个文件就发送一次 `scan-progress` 事件。对于 68k 文件，产生 6.8 万次 IPC 调用。
- **优化**：在 `scan_directory` 函数中引入节流。仅在 `processed_count % 500 == 0` 或扫描完成时发送通知。
- **收益**：大幅减轻了消息总线压力和前端主线程的事件响应负担。

### 2. 引擎级目录过滤 (Strict Engine Filtering)
- **旧逻辑**：在扫描结果汇总阶段过滤隐藏文件和缓存目录（`.Aurora_Cache`）。
- **优化**：利用 `jwalk` 的 `process_read_dir` 闭包，在扫描的最底层直接阻断对 `.Aurora_Cache` 和隐藏目录（如 `.git` 等）的进入。
- **收益**：避免了对上万个缩略图文件的无效属性读取（Stat 调用）。

### 3. “双模”计数策略 (Dual-Mode Counting)
- **逻辑分支**：
    - **强制模式 (force=true)**：用于首次选择文件夹。执行一次完整的并行 `WalkDir` 进行精确计数。满足用户对“进度条准确性”的需求。
    - **极速模式 (force=false)**：用于日常启动。仅对根目录进行浅层 `read_dir` 计数作为初次预估。
- **收益**：日常启动省去了数万次文件的预遍历时间。

### 4. 智能元数据持久化与缓存 (Smart Metadata Persistence)
- **优化点**：文件尺寸（Width/Height）的提取与复用。
- **策略变更**：
    - **首次/强制扫描 (force=true)**：利用多线程同步调用 `image::image_dimensions`。确保在欢迎流程结束时，数据库已拥有完整的尺寸索引。
    - **日常启动 (force=false)**：对比磁盘文件的 `mtime` 和 `size`。若与数据库索引一致，则直接从数据库读取尺寸，实现“秒开”即有尺寸。
    - **后台补全**：若检测到新文件或索引缺失，启动后台任务异步补全，并通过 `metadata-updated` 事件实时推送至前端，无需刷新界面即可看到尺寸更新。
- **收益**：彻底解决了“尺寸显示 ---”的问题，同时通过索引复用将 68k 文件的读取开销降至极低。

### 5. IPC 实时同步机制
- **新增**：引入 `metadata-updated` 全局事件。
- **逻辑**：后端在后台任务完成一批（默认 200 个）尺寸提取后，主动触发 IPC 通知。前端 App 监听该事件并局部更新 `files` 状态。
- **UI 联动**：详情面板（MetadataPanel）在文件选中时，若发现本地数据仍缺失，会主动触发针对单文件的 `scan_file` 扫描，双重保障数据的准确性。

### 6. 数据库查询增量化
- **优化点**：`all_metadata` 加载。
- **优化**：通过 SQL `path LIKE 'root_path%'` 仅加载当前库相关的元数据，而非全表加载（防止跨库数据过大）。

### 7. 极速启动一致性检查 (Fast Startup Consistency Check)
- **问题**：在极速模式下，如果在应用关闭期间通过文件资源管理器添加了新文件，或在软件运行时通过“拖拽”添加了文件，由于统计逻辑口径不一或索引同步延迟，应用重启后可能误认为文件系统差异过大，从而降级为耗时的全量磁盘扫描（约 7200ms+）。
- **优化**：
    - **对齐统计口径**：根目录物理计数逻辑现在会过滤掉所有非业务相关的杂质文件（如 `.txt`, `.exe` 等），仅统计“文件夹”和“受支持的图片格式”，确保与数据库索引的计数逻辑完全闭合。
    - **路径不敏感对比**：在 Windows 环境下对比路径时采用忽略大小写的匹配，并统一处理末尾斜杠，防止由于 `C:/` 与 `c:/` 的微小差异触发重扫。
    - **写时索引同步 (Write-Through Indexing)**：
        - `create_folder`：创建文件夹时同步写入索引表。
        - `copy_file` / `db_copy_file_metadata`：文件复制操作后立即将新位置信息写入 `file_index`。
        - `write_file_from_bytes` (Drop 处理)：外部文件拖入并保存后，立即同步更新索引。
- **逻辑**：
    - 若 `物理业务文件数量 > 数据库索引数量`：判定为文件系统发生了变更，自动降级为全量/增量磁盘扫描。
    - 若 `物理业务文件数量 <= 数据库索引数量`：继续保持极速模式，直接返回数据库结果。
- **收益**：解决了大量文件背景下，仅因拖入一个普通文件就导致下次启动变慢的问题，确保 68k 级别库的启动能在 1-2秒 内稳定完成。

---

## 核心代码参考 (For AI Assistant Reference)

### Rust (src-tauri/src/main.rs):
```rust
// 1. 缓存优先的尺寸获取逻辑
// ... (omitted)

// 2. 节流通知
// ... (omitted)

// 3. 极速启动一致性检查：严格对齐过滤规则
let fs_root_count = rd.filter_map(|e| e.ok()).filter(|e| {
    let name = e.file_name().to_string_lossy().to_string();
    if name == ".Aurora_Cache" || (name.starts_with('.') && name != ".pixcall") { return false; }
    if let Ok(md) = e.metadata() {
        if md.is_dir() { return true; }
        let ext = e.path().extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()).unwrap_or_default();
        return is_supported_image(&ext);
    }
    false
}).count();

// 4. 写时同步 (以复制为例)
let new_entry = db::file_index::FileIndexEntry {
    file_id: generate_id(&dest_normalized),
    path: dest_normalized,
    file_type: "Image".to_string(),
    // ...
};
let _ = db::file_index::batch_upsert(&mut conn_mut, &[new_entry]);
```

### TypeScript (src/App.tsx & MetadataPanel.tsx):
```typescript
// App.tsx: 监听后台补全事件
useEffect(() => {
  const unlisten = listen('metadata-updated', (event: any) => {
    const { path, metadata } = event.payload;
    setFiles(prev => ({
      ...prev,
      [path]: { ...prev[path], meta: metadata }
    }));
  });
  return () => { unlisten.then(f => f()); };
}, []);

// MetadataPanel.tsx: 选中文件时若无尺寸，主动触发静默扫描
useEffect(() => {
  if (selectedFile && (!selectedFile.meta || selectedFile.meta.width === 0)) {
    scanFile(selectedFile.path).then(updatedFile => {
      // 通过全局状态更新 UI
    });
  }
}, [selectedFile?.path]);
```

---

## 结论
通过将**同步密集型扫描**转变为**异步、分档、带节流的混合扫描模式**，系统在面对 68,000 个文件时仍能保持流畅的交互体验，且不影响既有的颜色提取、标签管理等持久化数据。
