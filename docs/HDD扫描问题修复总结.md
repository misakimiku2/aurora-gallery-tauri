# HDD 扫描问题修复总结

## 问题描述

在首次使用软件时，选择目录后有 3121 个文件，但进度只到 1000 就显示扫描完成，并且实际显示的文件也少了很多。重启软件后文件正常出现，但点击刷新后又变成少文件的状态。

**问题环境**：另一台电脑使用 HDD（机械硬盘）

---

## 根本原因分析

### 1. imageinfo crate panic（主要原因）

错误日志显示：
```
thread '<unnamed>' panicked at ...\imageinfo-0.7.27\src\raw_buffer.rs:17:20:
range end index 9 out of range for slice of length 4
```

`imageinfo` crate 在处理某些图像文件时会发生 panic，导致扫描线程崩溃，这是文件丢失的主要原因。

### 2. HDD 并行扫描性能问题

- **并行度过高**：代码使用了 16 线程并行扫描（`RayonNewPool(16)`）
- **HDD 的机械特性**：机械硬盘的磁头在并行读取时会产生严重的寻道竞争
- **par_bridge 强制并行**：即使设置了 `Parallelism::Serial`，`par_bridge()` 仍会强制使用 Rayon 线程池

### 3. 潜在的切片越界风险

多处代码使用 `[..9]` 和 `[..24]` 切片操作，在极端情况下可能导致越界。

---

## 修复内容

### 修复 1：捕获 imageinfo panic

**文件**：`src-tauri/src/main.rs`

**位置**：`get_image_dimensions()` 函数

```rust
// Try imageinfo for everything else
// 使用 catch_unwind 捕获可能的 panic，防止扫描线程崩溃
let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
    imageinfo::ImageInfo::from_file(&mut file)
}));

match result {
    Ok(Ok(info)) => (info.size.width as u32, info.size.height as u32),
    Ok(Err(_)) => (0, 0),
    Err(_) => {
        eprintln!("[Warning] imageinfo panicked while processing: {}", path);
        (0, 0)
    }
}
```

**作用**：防止第三方库的 panic 崩溃扫描线程，有问题的图像文件只会被跳过（返回 0,0 尺寸），不会影响其他文件的扫描。

---

### 修复 2：添加 HDD 自动检测和动态调整并行度

**文件**：`src-tauri/src/main.rs`

#### 2.1 HDD 检测函数

```rust
/// 检测路径是否可能位于HDD（机械硬盘）上
/// 通过测量小文件的随机读取延迟来判断
fn is_likely_hdd(path: &str) -> bool {
    use std::time::Instant;

    let test_path = Path::new(path);
    let mut read_times = Vec::new();

    if let Ok(entries) = fs::read_dir(test_path) {
        let test_files: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                if let Ok(meta) = e.metadata() {
                    meta.is_file() && meta.len() < 1024 * 1024
                } else {
                    false
                }
            })
            .take(5)
            .collect();

        for entry in test_files {
            let path = entry.path();
            let start = Instant::now();
            let _ = fs::metadata(&path);
            let elapsed = start.elapsed();
            read_times.push(elapsed.as_millis() as f64);
        }
    }

    if read_times.len() >= 3 {
        let avg_time: f64 = read_times.iter().sum::<f64>() / read_times.len() as f64;
        eprintln!("[HDD Detection] Average read time: {:.2}ms (threshold: 10ms)", avg_time);
        avg_time > 10.0
    } else {
        false
    }
}
```

#### 2.2 文件计数策略使用动态并行度

```rust
let count_parallelism = if is_likely_hdd(&path) {
    eprintln!("[Scan] Detected HDD for counting, using sequential scanning");
    jwalk::Parallelism::Serial
} else {
    jwalk::Parallelism::RayonNewPool(16)
};

let total_images = if force {
    jwalk::WalkDir::new(&path)
        .parallelism(count_parallelism)
        // ...
}
```

#### 2.3 文件扫描使用动态并行度

```rust
let scan_parallelism = if is_likely_hdd(&producer_path) {
    eprintln!("[Scan] Detected HDD for scanning, using sequential scanning");
    jwalk::Parallelism::Serial
} else {
    jwalk::Parallelism::RayonNewPool(16)
};
```

**检测阈值**：
- SSD：通常在 0.1-1ms
- HDD：通常在 5-15ms
- 阈值：10ms（超过判定为 HDD）

---

### 修复 3：移除 par_bridge 强制并行

**文件**：`src-tauri/src/main.rs`

**修改前**：
```rust
jwalk::WalkDir::new(&producer_path)
    .parallelism(scan_parallelism)
    .into_iter()
    .par_bridge()  // 强制使用 Rayon 线程池
    .filter_map(|entry_result| { ... })
```

**修改后**：
```rust
jwalk::WalkDir::new(&producer_path)
    .parallelism(scan_parallelism)
    .into_iter()
    // 移除 par_bridge，让 jwalk 根据 parallelism 设置处理
    .filter_map(|entry_result| { ... })
```

**作用**：让 `jwalk` 根据 `parallelism` 设置正确处理串行/并行，HDD 模式下完全串行，避免磁头竞争。

---

### 修复 4：修复切片越界风险

#### 4.1 generate_id 函数

**文件**：`src-tauri/src/db/mod.rs`

```rust
pub fn generate_id(path: &str) -> String {
    let normalized = normalize_path(path);
    let hash = md5::compute(normalized.as_bytes());
    let hash_str = format!("{:x}", hash);
    if hash_str.len() >= 9 {
        hash_str[..9].to_string()
    } else {
        format!("{:0>9}", hash_str)
    }
}
```

#### 4.2 缩略图缓存文件名生成

**文件**：`src-tauri/src/thumbnail.rs`（3 处）

```rust
let hash_str = format!("{:x}", md5::compute(cache_key.as_bytes()));
let cache_filename = if hash_str.len() >= 24 {
    hash_str[..24].to_string()
} else {
    format!("{:0>24}", hash_str)
};
```

#### 4.3 颜色工作器缓存文件名生成

**文件**：`src-tauri/src/color_worker.rs`

```rust
let hash_str = format!("{:x}", md5::compute(cache_key.as_bytes()));
let cache_filename = if hash_str.len() >= 24 {
    hash_str[..24].to_string()
} else {
    format!("{:0>24}", hash_str)
};
```

---

### 修复 5：添加诊断日志

**文件**：`src-tauri/src/main.rs`

#### 5.1 扫描进度日志

```rust
let mut received_count = 0;
while let Ok((id, mut node, p_path)) = rx.recv() {
    received_count += 1;
    // ...
    
    if received_count % 500 == 0 {
        eprintln!("[Scan Progress] Received {} files so far, processed: {}, total expected: {}", 
                 received_count, processed_count, total_images);
    }
    // ...
}
```

#### 5.2 扫描完成日志

```rust
eprintln!("[Scan Complete] Total received: {}, Total files in map: {}, Expected: {}", 
         received_count, all_files.len(), total_images);

if received_count < total_images.saturating_sub(10) {
    eprintln!("[Scan Warning] Received fewer files than expected!");
    eprintln!("[Scan Warning] Consider checking disk health or using SSD.");
}
```

---

## 修改文件清单

| 文件 | 修改内容 |
|------|----------|
| `src-tauri/src/main.rs` | 添加 HDD 检测、动态并行度、panic 捕获、诊断日志 |
| `src-tauri/src/db/mod.rs` | 修复 `generate_id()` 切片越界 |
| `src-tauri/src/thumbnail.rs` | 修复 3 处缓存文件名切片越界 |
| `src-tauri/src/color_worker.rs` | 修复 1 处缓存文件名切片越界 |

---

## 测试验证

重新编译并测试时，观察控制台应该能看到：

1. `[HDD Detection] Average read time: XXms` - 检测延迟
2. `[Scan] Detected HDD for counting/scanning, using sequential scanning...` - HDD 检测成功
3. `[Scan Progress] Received X files so far...` - 进度日志（每 500 个文件）
4. 不再出现 `range end index 9 out of range` panic 错误
5. `[Scan Complete] Total received: 3121, Total files in map: 3121, Expected: 3121` - 完整扫描

---

## 技术细节

### HDD vs SSD 性能对比

| 因素 | SSD | HDD |
|------|-----|-----|
| 随机读取性能 | 高（~100K IOPS） | 低（~100 IOPS） |
| 并行读取效率 | 好 | 差（磁头寻道时间成为瓶颈） |
| 文件遍历速度 | 快 | 慢 |
| 推荐扫描模式 | 并行（16 线程） | 串行（单线程） |

### 为什么这些修复有效

1. **panic 捕获**：防止单个有问题的文件导致整个扫描失败
2. **HDD 检测**：自动识别机械硬盘，避免高并行度导致的磁头竞争
3. **移除 par_bridge**：让 jwalk 的并行度设置真正生效
4. **切片保护**：防止极端情况下的越界 panic
5. **诊断日志**：便于排查问题，快速定位故障点

---

## 后续优化建议

1. **添加用户设置**：允许用户手动选择扫描模式（自动/高速/兼容）
2. **更精确的检测**：使用系统 API 获取磁盘类型信息
3. **进度保存**：在扫描过程中定期保存进度，防止意外中断
4. **后台扫描**：对于大目录，可以考虑后台渐进式扫描
5. **替换 imageinfo**：考虑使用更稳定的图像信息库

---

## 修复日期

- **初始修复**：2026-02-12
- **panic 修复**：2026-02-13
- **文档整理**：2026-02-13

---

## 编译状态

✅ `cargo check` 通过
