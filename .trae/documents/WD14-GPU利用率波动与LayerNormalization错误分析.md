# WD14 GPU 利用率波动与 LayerNormalization 错误分析

## 问题现象

### 1. GPU 使用率波动 (100% ↔ 40%)
使用 WD-EVA02-Large-Tagger-V3 模型进行图片嵌入向量生成时，GPU 使用率呈现波浪形波动，且 40% 低使用率时间明显多于 100% 高使用率时间。

### 2. LayerNormalization 错误
批量推理时出现错误：
```
Failed to run batch inference: Non-zero status code returned while running LayerNormalization node. 
Name:'/core_model/fc_norm/LayerNormalization' Status Message:
```

---

## 根因分析

### 一、GPU 使用率波动的根本原因

从日志时间线分析：

```
[19:50:03] Preprocessing 32 images using rayon (8 threads)...
[19:50:03] Preprocessing completed in 118ms (avg 3.69ms per image)
[19:50:03] Creating input tensor with shape [32, 448, 448, 3]
[19:50:03] Running ONNX inference...
[19:50:03] Batch 13: encode_images_batch returned
[19:50:03] ERROR: Failed to encode batch 12: LayerNormalization error
[19:50:10] Processing batch 14... (7秒后)
```

**关键发现**：

| 阶段 | 耗时 | GPU 状态 | 说明 |
|------|------|----------|------|
| 图像预处理 (rayon) | ~120ms | **空闲 (40%)** | CPU 多线程处理，GPU 空闲等待 |
| Tensor 创建 | ~1ms | 空闲 | 内存操作 |
| ONNX 推理 | 不稳定 | **活跃 (100%)** | GPU 计算 |
| 批次间隔 | ~7秒 | 空闲 | 批次间存在明显延迟 |

**问题根源**：

1. **CPU-GPU 流水线断裂**：预处理（CPU）和推理（GPU）是串行执行的，没有流水线重叠
2. **批次间延迟过大**：从 Batch 13 完成（19:50:03）到 Batch 14 开始（19:50:10）有 7 秒间隔
3. **批量推理失败触发串行回退**：LayerNormalization 错误导致批量失败，系统回退到逐张处理

### 二、LayerNormalization 错误原因

这是 **DirectML 执行提供程序的已知限制**：

1. **WD14 模型特殊性**：
   - 输入尺寸 448×448（比标准 CLIP 224px 大 4 倍）
   - 批次大小 32 时，输入张量 `[32, 448, 448, 3]` 约 77MB
   - LayerNormalization 节点在 DirectML 上对大批次支持不稳定

2. **显存/计算资源竞争**：
   - DirectML 可能无法有效处理大批次的 LayerNormalization
   - 错误发生在 `/core_model/fc_norm/LayerNormalization` 节点

3. **批次大小问题**：
   - 当前配置：GPU 环境下 batch=32
   - 对于 WD14 模型，这个批次大小可能超出 DirectML 稳定工作范围

---

## 解决方案

### 方案一：降低 WD14 批次大小（推荐）

**修改文件**：`src-tauri/src/clip_commands.rs`

将 WD14 的 GPU 批次大小从 32 降低到 16 或 8：

```rust
"WD-EVA02-Large-Tagger-V3" => {
    // 降低批次大小以避免 DirectML LayerNormalization 错误
    // 448x448 输入尺寸较大，需要更保守的批次设置
    if using_gpu { 16 } else { 4 }  // 从 32 改为 16
},
```

**优点**：
- 实现简单，一行代码修改
- 直接解决 LayerNormalization 错误
- 减少 GPU 显存压力

**缺点**：
- 吞吐量可能略有下降（但避免了失败重试的开销）

### 方案二：实现流水线预处理（长期优化）

**修改文件**：`src-tauri/src/clip/model.rs`

实现双缓冲机制，在 GPU 推理当前批次时，CPU 同时预处理下一批次：

```rust
// 伪代码概念
struct BatchPipeline {
    current_batch: Option<PreprocessedBatch>,
    next_batch: Option<JoinHandle<PreprocessedBatch>>,
}

impl BatchPipeline {
    fn process(&mut self, paths: &[String]) {
        // 启动下一批次预处理（异步）
        self.next_batch = Some(spawn_preprocess(next_paths));
        
        // 执行当前批次 GPU 推理
        run_inference(self.current_batch.take());
        
        // 等待下一批次预处理完成
        self.current_batch = self.next_batch.take().and_then(|h| h.join().ok());
    }
}
```

**优点**：
- 显著提高 GPU 利用率
- CPU 和 GPU 并行工作

**缺点**：
- 实现复杂度较高
- 需要重构批处理逻辑

### 方案三：添加批次大小自动调整

**修改文件**：`src-tauri/src/clip/model.rs`

在检测到 LayerNormalization 错误时，自动降低批次大小重试：

```rust
fn encode_images_batch_with_fallback(&mut self, paths: &[String]) -> Result<Vec<InferenceResult>, String> {
    let mut batch_size = paths.len();
    loop {
        match self.encode_images_batch_gpu(&paths[..batch_size]) {
            Ok(results) => return Ok(results),
            Err(e) if e.contains("LayerNormalization") && batch_size > 4 => {
                log::warn!("LayerNormalization error, reducing batch from {} to {}", batch_size, batch_size / 2);
                batch_size /= 2;
            }
            Err(e) => return Err(e),
        }
    }
}
```

**优点**：
- 自动适应硬件能力
- 无需手动调整

**缺点**：
- 首次失败仍有开销

---

## 推荐实施步骤

### 第一阶段：快速修复（立即实施）

1. **降低 WD14 批次大小**：从 32 改为 16
2. **验证修复效果**：确认 LayerNormalization 错误消失

### 第二阶段：性能优化（后续迭代）

1. **实现流水线预处理**：CPU-GPU 并行
2. **添加批次自动调整**：智能降级机制

---

## 预期效果

| 指标 | 修复前 | 修复后（方案一） | 修复后（方案二） |
|------|--------|------------------|------------------|
| LayerNormalization 错误 | 频繁 | 无 | 无 |
| GPU 利用率 | 40% 为主 | 60-70% | 85%+ |
| 处理速度 | 不稳定 | 稳定 4-6 files/s | 8-10 files/s |

---

## 总结

**核心问题**：DirectML 对大批次 LayerNormalization 支持不稳定 + CPU/GPU 串行执行

**推荐方案**：先实施方案一（降低批次大小），后续考虑方案二（流水线优化）

**修改文件**：
- `src-tauri/src/clip_commands.rs` - 批次大小配置
- `src-tauri/src/clip/model.rs` - 批处理逻辑（可选优化）
