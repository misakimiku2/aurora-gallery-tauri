# CLIP ViT-L/14 模型性能优化计划

## 问题分析

### 当前状态
- **ViT-B/32**: 4999 张图片处理约 5-10 秒 (约 500-1000 张/秒)
- **ViT-L/14**: 4994 张图片预计 25 分钟 (约 3.3 张/秒)
- **性能差距**: 约 150-300 倍（正常应该只有 3-5 倍）

### 根本原因

#### 1. 模型复杂度差异（正常因素）
| 特性 | ViT-B/32 | ViT-L/14 | 差距 |
|------|----------|----------|------|
| 参数量 | ~1.5亿 | ~4.28亿 | **2.8x** |
| Transformer 层数 | 12层 | 24层 | **2x** |
| ONNX 模型大小 | ~350MB | ~1.7GB | **4.9x** |

#### 2. 批处理大小问题（关键瓶颈）
```rust
// main.rs:2992 - 当前代码
let batch_size = if using_gpu { 32 } else { 8 };  // 对所有模型使用相同值！
```

ViT-L/14 的显存占用是 ViT-B/32 的 **4-5 倍**，batch_size=32 可能导致：
- 显存不足，ONNX Runtime 静默回退到 CPU
- 频繁的 GPU 内存交换

#### 3. CUDA 配置不完善
当前配置过于简单，缺少内存优化和算法搜索。

#### 4. 可能的 GPU 回退
没有足够的日志确认 GPU 是否真正工作。

---

## 优化方案

### 第一步：添加日志文件输出（诊断用）

**目的**: 在 release 模式下收集日志信息，确认 GPU 是否真正工作

**修改文件**: `src-tauri/src/main.rs`

当前配置：
```rust
.plugin(
    tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build()
)
```

修改为：
```rust
.plugin(
    tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .targets([
            tauri_plugin_log::LogTarget::LogDir,  // 写入日志文件
            tauri_plugin_log::LogTarget::Stdout,  // 同时输出到终端
        ])
        .build()
)
```

**日志文件位置**: `{应用数据目录}/logs/`
- Windows: `C:\Users\{用户名}\AppData\Roaming\com.aurora-gallery.app\logs\`

### 第二步：添加关键诊断日志

**修改文件**: `src-tauri/src/clip/model.rs`

在批处理推理时添加：
```rust
log::info!("[CLIP Batch] Processing {} images, GPU active: {}, model: {}", 
    images.len(), self.is_using_gpu, self.config.name);
```

### 第三步：动态批处理大小

**修改文件**: `src-tauri/src/main.rs`

```rust
// 修改 main.rs:2992 附近
let batch_size = match model_name.as_str() {
    "ViT-L-14" => if using_gpu { 8 } else { 4 },   // 大模型用小批次
    "ViT-B-32" => if using_gpu { 32 } else { 8 },
    _ => if using_gpu { 16 } else { 8 },
};
```

### 第四步：优化 CUDA 配置

**修改文件**: `src-tauri/src/clip/model.rs`

```rust
let cuda_provider = ort::execution_providers::CUDAExecutionProvider::default()
    .with_device_id(0)
    .with_arena_extend_strategy(ort::execution_providers::ArenaExtendStrategy::kSameAsRequested)
    .with_cudnn_conv_algo_search(ort::execution_providers::CudnnConvAlgoSearch::Exhaustive);
```

---

## 实施步骤

### 阶段 1：诊断（先执行）
1. **添加日志文件输出** - 让 release 版本也能保存日志到文件
2. **添加关键诊断日志** - 确认 GPU 是否真正工作
3. **重新编译 release 版本**: `cargo build --release`
4. **运行嵌入生成，收集日志文件**
5. **分析日志，确认问题根源**

### 阶段 2：优化（根据诊断结果）
1. 如果日志显示 GPU 未工作 → 修复 CUDA 配置
2. 如果日志显示 GPU 正常工作 → 调整批处理大小
3. 优化 CUDA 配置参数
4. 测试验证性能提升

---

## 日志文件位置

编译后运行程序，日志文件将保存在：
- **Windows**: `C:\Users\{用户名}\AppData\Roaming\com.aurora-gallery.app\logs\`

或者可以通过命令行快速打开：
```powershell
explorer %APPDATA%\com.aurora-gallery.app\logs
```

---

## 预期结果

| 优化后 | ViT-B/32 | ViT-L/14 |
|--------|----------|----------|
| 批处理大小 | 32 | 8 |
| 预期速度 | 500-1000 张/秒 | 100-300 张/秒 |
| 4994 张预计时间 | 5-10 秒 | 15-50 秒 |

ViT-L/14 应该比 ViT-B/32 慢 **3-5 倍**，而不是 **150-300 倍**。
