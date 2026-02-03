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

---

## 核心代码参考 (For AI Assistant Reference)

### Rust (src-tauri/src/main.rs):
```rust
// 1. 缓存优先的尺寸获取逻辑
let meta_entry = metadata_map.get(&relative_path);
let needs_refresh = match meta_entry {
    Some(m) => m.mtime != mtime || m.size != size || m.width == 0,
    None => true,
};

if force || needs_refresh {
    // 强制模式或缓存失效：执行重度 IO 获取尺寸
    if let Ok(dim) = image::image_dimensions(&path) {
        width = dim.0;
        height = dim.1;
    }
} else if let Some(m) = meta_entry {
    // 缓存命中：直接从数据库读取，无需磁盘 IO
    width = m.width;
    height = m.height;
}

// 2. 节流通知 (仅在强制扫描模式下显示进度，避免日常启动过度消耗)
if force && processed_count % 500 == 0 {
    let _ = app.emit("scan-progress", ScanProgress { processed: processed_count, total: current_total });
}
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
