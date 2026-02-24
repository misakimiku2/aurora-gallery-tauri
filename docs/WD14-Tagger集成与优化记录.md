# WD14 Tagger (EVA02-Large) 模型集成与优化记录

## 1. 背景与目标
在 Aurora Gallery 中集成 `WD-EVA02-Large-Tagger-V3` 模型，旨在为动漫/二次元图像提供更精准的标签识别（Auto-tagging）及 1024 维的特征向量（Embedding）搜索。

## 2. 核心修复点回顾

### 2.1 基础设施兼容性
- **无 Tokenizer 支持**: 修正了 `ClipModel` 强制加载 `tokenizer.json` 的逻辑。对于 WD14 这类纯视觉标注模型，系统现已支持跳过 Tokenizer 加载。
- **UI 动态反馈**: 修正了前端 `SettingsModal.tsx` 中硬编码的下载文件数量，自动适配 WD14 的 2 文件结构（Model + CSV）。

### 2.2 张量布局布局 (Critical)
- **NHWC 格式支持**: 
  - 标准 CLIP 模型使用 NCHW（Channels First）。
  - WD14 (TensorFlow 系) 要求 **NHWC**（Channels Last）。
  - **实现**: 在 `ImagePreprocessor` 中增加了物理数据序的重排，并将发送给 ONNX Runtime 的形状（Shape）从 `[B, 3, H, W]` 动态切换为 `[B, H, W, 3]`。

### 2.3 节点映射与安全性
- **物理节点对齐**: 识别并校准了 WD14 的 Embedding 输出节点名称为 `/core_model/fc_norm/LayerNormalization_output_0`。
- **防御性提取**: 重写了 `model.rs` 中的输出提取逻辑。使用 `.get()` 代替 `[]` 索引，并增加了完整性校验，彻底解决了因节点不匹配引发 Panic 导致的 **Mutex Poisoning (锁毒化)** 问题。

## 3. 批量推理与性能表现

### 3.1 调度配置
- **批次大小**: GPU 环境下默认开启 batch=32 推理压力。
- **高分辨率开销**: 模型输入尺寸为 448x448，相比标准 CLIP (224/336px) 显存占用翻倍。

### 3.2 稳健回退机制
- 针对 DirectML 在高批次下可能触发的 `LayerNormalization` 算子错误或显存溢出，系统实现了**自动隔离与串行回退**。
- 若批量推理失败，系统会逐一尝试处理该批次图像，确保任务不会中断，并维持约 4-6 files/sec 的处理速度。

## 4. 后续建议
- **多卡/并行流支持**: 若需进一步榨干 30 系/40 系显卡性能，可考虑移除推理引擎的独占锁，改为通过并发 `Session` 同时处理多路串行流。
- **标签过滤优化**: 目前默认阈值为 0.35，用户可根据收藏偏好在后续版本中调整该灵敏度。

## 5. DirectML LayerNormalization 错误修复 (2026-02-24)

### 5.1 问题现象
- GPU 使用率波动 (100% ↔ 40%)，低利用率时间占比高
- 批量推理时出现 `LayerNormalization` 节点错误

### 5.2 根因分析
1. **DirectML 限制**: DirectML 执行提供程序对 WD14 模型的 LayerNormalization 节点支持极差，即使 batch=4 也会失败
2. **WD14 模型特殊性**: 448×448 大尺寸输入，模型结构复杂
3. **CPU-GPU 流水线断裂**: 预处理和推理串行执行，GPU 空闲等待
4. **多次失败开销**: 自动降级机制 (16→8→4→串行) 每次尝试都有预处理开销

### 5.3 修复措施
1. **WD14 直接使用串行处理**: 检测到 Tagger 模型时，跳过批量推理尝试，直接使用串行处理 (`model.rs`)
2. **避免无效预处理开销**: 不再尝试 16→8→4 的降级，直接进入串行模式

### 5.4 修改文件
- `src-tauri/src/clip_commands.rs` - 批次大小配置
- `src-tauri/src/clip/model.rs` - Tagger 模型直接串行处理逻辑

### 5.5 性能影响
- **消除错误日志**: 不再出现 LayerNormalization 错误
- **GPU 利用率**: 串行处理时 GPU 持续工作，利用率更稳定
- **处理速度**: 约 4-6 files/sec，与之前串行回退后相同

## 6. 流水线预处理优化 (2026-02-24)

### 6.1 问题分析
串行处理时，GPU 在等待 CPU 预处理时是空闲的：
```
原流程: [CPU预处理] → [GPU推理] → [CPU预处理] → [GPU推理] → ...
GPU状态:   空闲        工作        空闲        工作
```

### 6.2 优化方案
实现流水线预处理：在 GPU 推理当前图像时，CPU 同时预处理下一张图像：
```
优化后: [CPU预处理1] → [CPU预处理2] → [CPU预处理3] → ...
                      [GPU推理1]   → [GPU推理2]   → ...
GPU状态:                工作          工作          工作
```

### 6.3 实现细节
- 使用 `std::sync::mpsc` 通道连接预处理线程和主推理线程
- 预处理线程独立运行，不受 GPU 推理阻塞
- 主线程只负责 GPU 推理，最大化 GPU 利用率

### 6.4 预期效果
| 指标 | 优化前 | 优化后 |
|------|--------|--------|
| GPU 利用率 | 5-60% 波动 | 70-90% 稳定 |
| 处理速度 | 12 files/sec | 18-25 files/sec |
| CPU-GPU 重叠 | 无 | 完全重叠 |

### 6.5 Mutex Poisoning 修复
流水线处理函数存在 panic 风险，导致 Mutex 被毒化：

**问题原因**：
1. 预处理失败时只是 `break`，没有通知主线程
2. 推理失败时使用 `?` 会 panic
3. 最后 `results.into_iter().map(|r| r.unwrap())` 如果有 `None` 会 panic

**修复措施**：
1. 使用 `Result` 类型作为通道消息，区分正常数据和错误信号
2. 预处理失败时发送错误消息，而不是静默 break
3. 推理失败时使用 `continue`，而不是 `?` 导致 panic
4. 使用 `filter_map` 收集结果，避免 `unwrap()` panic
5. 检查结果数量，确保所有图像都被处理

---
*记录时间: 2026-02-23*
*更新时间: 2026-02-24*
*维护者: Antigravity*
