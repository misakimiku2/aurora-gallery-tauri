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

---
*记录时间: 2026-02-23*
*维护者: Antigravity*
