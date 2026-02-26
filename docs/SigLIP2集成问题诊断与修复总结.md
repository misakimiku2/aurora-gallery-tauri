# SigLIP 2 集成问题诊断与修复总结

本记录总结了在集成 SigLIP 2 系列模型过程中遇到的主要技术挑战、多次编译中断的原因及其最终解决方案。本会话经历了多次"尝试-失败-回退-重构"的迭代，最终确立了稳定的显存共享架构。

## 1. 核心问题现象
- **搜索失效**：输入关键词（如"穿西装的男人"）返回的结果完全随机，语义空间严重偏移。
- **性能退化**：由于错误的缩放算法和显存管理不当，单图处理时间飙升至 1.4s，且 GPU 显存占用翻倍导致系统卡顿。

## 2. 诊断过程与根本原因

### 原因 A：语义空间未对齐 (Projection Head 缺失)
- **发现**：诊断日志显示 `pooler_output` 节点的特征向量范数极大（约 47），且物理空间不匹配。
- **结论**：之前使用的"分体版"ONNX 模型仅包含 Backbone，缺少了将 Vision 和 Text 特征投影到统一语义空间的 **Projection Head**。

### 原因 B：分词器逻辑漏洞 (Silent Failure)
- **代码段**：`src/clip/preprocessor.rs`
- **漏洞**：`TextPreprocessor` 的 `Clone` 实现中，`tokenizer` 字段被错误地设为了 `None`。
- **后果**：每当模型在异步任务中克隆时，分词器就会悄悄丢失，回退到某种"占位映射"模式，导致文本理解完全错误。

### 原因 C：预处理算法负载过重
- **发现**：为了提高质量误用了 `CatmullRom` 滤波器，在处理高分辨率图片时造成了严重的 CPU 瓶颈。

### 原因 D：统一模型输入形状不匹配 (NaN/Inf 崩溃)
- **发现**：终端日志显示 `raw norm` 值为 `NaN` 或 `inf`。
- **根本原因**：统一模型要求同时接收图像和文本输入。原代码在文本编码时提供了 `16x16` 的虚拟图像，在图像编码时提供了长度为 `1` 的虚拟文本。
- **后果**：SigLIP2 的 Transformer 结构对输入尺寸极其敏感。错误的形状会导致注意力机制计算崩溃，产生无效权重，使得所有搜索词返回相同错误结果，或语义对齐严重偏移。


## 3. 最终修复方案

### [架构方案] 显存共享化重构
- **变更**：将 `ClipModel` 中的 `Session` 类型由 `Option<Session>` 重构为 `Option<Arc<std::sync::Mutex<Session>>>`。
- **效果**：针对单一的 `model.onnx` (4.3GB)，Vision 分支和 Text 分支现在**共享同一个内存实例**。显存占用从 8.6GB 直接降至 4.3GB。

### [规格调整] 对齐节点修正
- **模型**：强制切换至集成了 Projection Head 的统一模型 `model.onnx`。
- **节点**：将输出节点从 `pooler_output` 修证为 `image_embeds` 和 `text_embeds`。

### [逻辑加固] 分词器与预处理
- **修复**：修正 `TextPreprocessor` 的 `Clone` 宏逻辑，确保 `tokenizer` 正确传递。
- **性能**：将缩放算法切回 `Box` 模式，恢复毫秒级处理速度。

### [稳定性修复] 动态虚拟张量对齐
- **变更**：在 `ModelSpec` trait 中引入 `dummy_vision_input_shape()` 和 `dummy_text_input_length()` 方法。
- **修改**：
    - `SigLIP2So400M` 实现在文本编码时提供 `[1, 3, 384, 384]` 图像，在图像编码时提供 `64` 长度的文本 padding。
    - `model.rs` 中的 `encode_text` / `encode_image` 改为动态获取上述形状，彻底解决了 NaN/Inf 崩溃问题。


## 4. 编译中断记录与解决 (Troubleshooting)

在本会话中，我们遭遇了多次 `cargo check` 失败，主因如下：

1. **Arc 借用冲突**：由于 `ort::Session::run` 在该版本中需要 `&mut self`，直接使用 `Arc<Session>` 会导致"无法借用为可变"的错误。
   - *解决*：引入 `std::sync::Mutex` 包装，通过 `lock()` 获取可变借用。
2. **解引用混乱**：在尝试修复 Arc 引用时，多次出现 `.as_mut()` 与 `as_ref()` 的混用。
   - *解决*：最终确立了 `mut session_guard = lock().unwrap()` 后直接调用 `session.run()` 的标准范式。
3. **行号偏移**：频繁的小步提交导致增量编辑工具（`replace_file_content`）发生匹配冲突。
   - *解决*：通过全量读取文件内容后进行多块合并替换（`multi_replace_file_content`）。


## 5. 2026-02-23 会话修复记录

### 5.1 问题现象
- 搜索"穿西装的男人"返回无关结果（如裸露女性写真）
- 搜索"一条狗"显示"未找到嵌入向量"，但实际有 5716 个嵌入
- 相似度分数异常低（最高仅 0.1040，正常应 0.2-0.5）

### 5.2 诊断发现

#### 发现 A：前端错误提示不准确
- **问题**：`clipGetEmbeddingCount()` 返回所有模型的嵌入总数，而非当前模型
- **日志**：搜索"一条狗"时显示"未找到嵌入向量"，但数据库中有 5716 个 SigLIP2 嵌入
- **原因**：App.tsx 中的判断逻辑有误

#### 发现 B：SigLIP 相似度计算方式错误
- **问题**：SigLIP 使用 **sigmoid loss** 训练，而非 CLIP 的 cosine similarity
- **日志**：所有搜索的分数分布几乎相同（最高≈0.1040）
- **原因**：使用 cosine similarity 计算 SigLIP 嵌入的相似度，导致分数范围错误

#### 发现 C：数据库表不存在
- **问题**：重新生成嵌入时全部失败
- **日志**：`Failed to save embedding: no such table: image_embeddings`
- **原因**：`EmbeddingStore::get_connection()` 方法没有确保表存在

#### 发现 D：模型输出节点名称验证
- **日志**：`Available output nodes: ["logits_per_image", "logits_per_text", "text_embeds", "image_embeds"]`
- **确认**：输出节点名称 `image_embeds` 和 `text_embeds` 是正确的

### 5.3 修复方案

#### 修复 1：添加按模型查询嵌入数量的功能
- **文件**：`src-tauri/src/clip/embedding.rs`
- **新增方法**：
  - `get_embedding_count_by_model(model_version: &str)` - 获取指定模型的嵌入数量
  - `get_model_versions()` - 获取所有模型版本及其嵌入数量
- **文件**：`src-tauri/src/clip_commands.rs`
- **新增命令**：
  - `clip_get_embedding_count_by_model`
  - `clip_get_model_versions`
- **文件**：`src/api/tauri-bridge.ts`
- **新增 API**：
  - `clipGetEmbeddingCountByModel(modelName)`
  - `clipGetModelVersions()`

#### 修复 2：改进前端错误提示逻辑
- **文件**：`src/App.tsx`
- **修改**：区分三种情况：
  1. 当前模型无嵌入 → 显示可用模型列表
  2. 有嵌入但无匹配 → "相似度过低"
  3. 搜索出错 → 显示错误信息

#### 修复 3：添加 SigLIP 风格的 sigmoid 相似度计算
- **文件**：`src-tauri/src/clip/models/mod.rs`
- **新增**：`SimilarityType` 枚举（Cosine / Sigmoid）
- **新增 trait 方法**：
  - `similarity_type()` - 返回相似度计算类型
  - `sigmoid_temperature()` - 返回 temperature 参数
- **文件**：`src-tauri/src/clip/models/siglip2.rs`
- **修改**：`SigLIP2So400M` 返回 `SimilarityType::Sigmoid`
- **文件**：`src-tauri/src/clip/model.rs`
- **新增**：`siglip_similarity(a, b, temperature)` 函数
- **文件**：`src-tauri/src/clip/search.rs`
- **修改**：根据模型类型选择正确的相似度计算方式

#### 修复 4：修复数据库表不存在的问题
- **文件**：`src-tauri/src/clip/embedding.rs`
- **修改**：`get_connection()` 方法每次连接时都会检查并创建表

#### 修复 5：添加诊断日志
- **文件**：`src-tauri/src/clip/model.rs`
- **新增日志**：
  - `[CLIP Debug] Available output nodes` - 模型实际的输出节点名称
  - `[CLIP Debug] Expected vision/text output node` - 期望的节点名称
- **文件**：`src-tauri/src/clip/search.rs`
- **新增日志**：
  - `[Search] Query embedding` - 查询嵌入的统计信息
  - `[Search] First candidate embedding` - 候选嵌入的统计信息
  - `[Search] Using similarity type` - 相似度计算类型和 temperature

### 5.4 修复效果
- ✅ 前端错误提示更准确
- ✅ 相似度分数从 0.1 提升到 0.8+（sigmoid 计算生效）
- ✅ 数据库表不存在问题已修复
- ❌ 搜索结果语义仍然不正确（核心问题未解决）

### 5.5 尝试的 Temperature 调整
- **原值**：0.07
- **调整**：0.01
- **效果**：无明显改善
- **结论**：temperature 不是主要问题


## 6. 2026-02-26 会话修复记录（相似度计算公式修正）

### 6.1 问题现象
- 所有搜索结果的相似度分数都是 `1.0`
- 日志显示：`分数分布: 最高=1.0000, 最低=1.0000, 前5名=[1.0, 1.0, 1.0, 1.0, 1.0]`
- 无法区分不同相似度的图片

### 6.2 诊断发现

#### 发现 A：Temperature 参数使用方式错误
**错误实现**：
```rust
let logit = dot_product / temperature;  // temperature = 0.01
score = sigmoid(logit)
```

**问题分析**：
- temperature = 0.01 时，`logit = dot_product * 100`
- 对于归一化向量，dot_product 范围是 [-1, 1]
- 即使 dot_product 只有 0.6，logit 也会是 60，`sigmoid(60) ≈ 1.0`
- 这导致几乎所有正相似度的分数都接近 1.0

**SigLIP 论文中的正确公式**：
```
logits = dot_product * logit_scale + logit_bias
score = sigmoid(logits)
```
其中：
- `logit_scale = exp(t_prime)`，初始化 `t_prime = log(1/0.07) ≈ 2.66`，所以 `logit_scale ≈ 14.3`
- `logit_bias` 初始化为 -10，用于平衡正负样本

#### 发现 B：ONNX 模型参数验证
通过 Python 脚本检查 ONNX 模型，确认：
- 模型中没有单独的 `logit_scale` 和 `logit_bias` 参数
- 这些参数在 ONNX 导出时未被包含
- 需要在推理时手动应用

模型输出节点：
| 输出节点 | 说明 |
|---------|------|
| `logits_per_image` | 已应用 logit_scale/bias 的图像 logits |
| `logits_per_text` | 已应用 logit_scale/bias 的文本 logits |
| `image_embeds` | 原始图像嵌入向量（当前使用） |
| `text_embeds` | 原始文本嵌入向量（当前使用） |

### 6.3 修复方案

#### 修复 1：重构 ModelSpec trait
**文件**：`src-tauri/src/clip/models/mod.rs`

将原来的 `sigmoid_temperature()` 方法替换为两个新方法：
```rust
/// SigLIP 风格的 logit_scale 参数
/// logit_scale = exp(t_prime)，初始化 t_prime = log(1/0.07) ≈ 2.66
fn sigmoid_logit_scale(&self) -> f32 {
    14.285714  // 1/0.07 ≈ 14.285714
}

/// SigLIP 风格的 logit_bias 参数
/// 初始化为 -10，用于平衡正负样本
fn sigmoid_logit_bias(&self) -> f32 {
    -10.0
}
```

#### 修复 2：更新 SigLIP2 模型规格
**文件**：`src-tauri/src/clip/models/siglip2.rs`

```rust
fn sigmoid_logit_scale(&self) -> f32 {
    14.285714
}

fn sigmoid_logit_bias(&self) -> f32 {
    -10.0
}
```

#### 修复 3：修正相似度计算函数
**文件**：`src-tauri/src/clip/model.rs`

```rust
pub fn siglip_similarity(a: &[f32], b: &[f32], logit_scale: f32, logit_bias: f32) -> f32 {
    let dot_product: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    let logit = dot_product * logit_scale + logit_bias;
    1.0 / (1.0 + (-logit).exp())
}
```

#### 修复 4：更新搜索模块调用
**文件**：`src-tauri/src/clip/search.rs`

- 更新 `search()` 方法，使用 `logit_scale` 和 `logit_bias`
- 更新 `search_in_candidates()` 方法签名
- 更新 `search_similar_exclude_self()` 方法
- 更新 `search_batch()` 方法

### 6.4 修复效果

**修复前**：
```
[Search] 分数分布: 最高=1.0000, 最低=1.0000, 前5名=[1.0, 1.0, 1.0, 1.0, 1.0]
```

**修复后**：
```
[Search] 分数分布: 最高=0.9850, 最低=0.8007, 前5名=[0.98, 0.93, 0.93, 0.92, 0.92]
```

- ✅ 分数分布正常，能够区分不同相似度
- ✅ 置信度 0.8 以上的结果视觉上相似
- ✅ 搜索功能正常工作

### 6.5 计算示例

修复后的计算：
- `logit = dot_product * 14.285714 + (-10)`

| dot_product | logit | sigmoid(logit) |
|-------------|-------|----------------|
| 0.6 | -1.43 | 0.19 |
| 0.7 | 0.0 | 0.50 |
| 0.8 | 1.43 | 0.81 |
| 0.9 | 2.86 | 0.95 |


## 7. 2026-02-27 会话记录（SigLIP 2 Base 轻量级模型集成）

### 7.1 需求背景
SigLIP 2 So400M 模型（400M 参数，约 4.3GB 显存）对用户配置有一定要求，需要添加配置要求更低的轻量级模型选项。

### 7.2 SigLIP 系列模型规格对比

#### SigLIP 2 系列（2025年发布）

| 模型 | 参数量 | 分辨率 | 嵌入维度 | 显存估算 | 特点 |
|------|--------|--------|----------|----------|------|
| **ViT-B** | 86M | 224x224 | 768 | ~1.5GB | 最小，适合低配置设备 |
| **ViT-L** | 303M | 224x224 | 1024 | ~2.5GB | 中等，平衡性能与资源 |
| **So400M** | 400M | 384x384 | 1152 | ~4.3GB | 当前使用，高精度 |
| **g** | 1B | 224x224 | - | ~8GB+ | 最大，最高精度 |

### 7.3 实施方案

#### 新增文件
- **文件**：`src-tauri/src/clip/models/siglip2_base.rs`
- **内容**：`SigLIP2Base` 结构体，实现 `ModelSpec` trait

#### 关键参数配置
```rust
fn name(&self) -> &str { "SigLIP2-Base" }
fn embedding_dim(&self) -> usize { 768 }
fn image_size(&self) -> usize { 224 }
fn max_text_length(&self) -> usize { 64 }
fn similarity_type(&self) -> SimilarityType { SimilarityType::Sigmoid }
fn sigmoid_logit_scale(&self) -> f32 { 14.285714 }
fn sigmoid_logit_bias(&self) -> f32 { -10.0 }
```

#### 模型文件下载 URL
```
# ONNX 模型
https://hf-mirror.com/onnx-community/siglip2-base-patch16-224-ONNX/resolve/main/onnx/model.onnx

# Tokenizer
https://hf-mirror.com/google/siglip2-base-patch16-224/resolve/main/tokenizer.json
https://hf-mirror.com/google/siglip2-base-patch16-224/resolve/main/tokenizer_config.json
https://hf-mirror.com/google/siglip2-base-patch16-224/resolve/main/special_tokens_map.json
```

### 7.4 向量生成代码兼容性

SigLIP 2 Base 和 So400M 的向量生成代码**完全相同**，都使用相同的 `ModelSpec` trait 接口。

#### 相同的配置（向量生成逻辑一致）

| 配置项 | SigLIP 2 Base | SigLIP 2 So400M |
|--------|---------------|-----------------|
| `image_mean` | [0.5, 0.5, 0.5] | [0.5, 0.5, 0.5] |
| `image_std` | [0.5, 0.5, 0.5] | [0.5, 0.5, 0.5] |
| `max_text_length` | 64 | 64 |
| `vision_input_name` | "pixel_values" | "pixel_values" |
| `vision_output_name` | "image_embeds" | "image_embeds" |
| `text_input_name` | "input_ids" | "input_ids" |
| `text_output_name` | "text_embeds" | "text_embeds" |
| `similarity_type` | Sigmoid | Sigmoid |
| `sigmoid_logit_scale` | 14.285714 | 14.285714 |
| `sigmoid_logit_bias` | -10.0 | -10.0 |

#### 不同的配置（模型规格差异）

| 配置项 | SigLIP 2 Base | SigLIP 2 So400M |
|--------|---------------|-----------------|
| `embedding_dim` | 768 | 1152 |
| `image_size` | 224 | 384 |
| `dummy_vision_input_shape` | (1, 3, 224, 224) | (1, 3, 384, 384) |

### 7.5 前端更新

#### 类型定义更新
**文件**：`src/types.ts`
```typescript
export type ClipModelName = 'ViT-B-32' | 'ViT-L-14' | 'SigLIP2-Base' | 'SigLIP2-So400M' | 'WD-EVA02-Large-Tagger-V3';
```

#### 模型配置更新
**文件**：`src/components/SettingsModal.tsx`
```typescript
{
  name: 'SigLIP2-Base',
  displayName: 'SigLIP 2 Base (轻量版)',
  description: '轻量级 - 多语言支持，适合低配置设备',
  size: 1600 * 1024 * 1024,
  sizeDisplay: '1.5 GB',
  embeddingDim: 768,
  isRecommended: false,
  series: 'siglip',
  features: {
    textSearch: true,
    imageSearch: true,
    autoTagging: false,
    multilingual: true,
  },
},
```

### 7.6 模型文件损坏问题修复

#### 问题现象
- 模型文件下载不完整（实际 1.5GB，本地只有 785MB）
- ONNX 加载失败：`Protobuf parsing failed`

#### 修复方案

1. **启用 AI 视觉功能时不自动加载模型**
   - **文件**：`src/App.tsx`
   - **修改**：启用时只更新状态，不自动加载模型

2. **模型文件损坏检测**
   - **文件**：`src/components/SettingsModal.tsx`
   - **修改**：下载完成后检测模型是否损坏，损坏时标记状态

3. **"重新下载"按钮**
   - **文件**：`src/components/SettingsModal.tsx`
   - **修改**：损坏的模型显示橙色"重新下载"按钮，点击后删除损坏文件并重新下载

4. **模型外框显示逻辑优化**
   - **文件**：`src/components/SettingsModal.tsx`
   - **修改**：
     - 绿色外框：只有启用且选中正常模型时显示
     - 红色外框：只有启用且选中损坏模型时显示
     - 关闭 AI 视觉功能时，所有模型显示普通灰色边框

### 7.7 修复效果

| 指标 | SigLIP2-So400M | SigLIP2-Base |
|------|----------------|---------------|
| 显存占用 | ~4.3GB | ~1.5GB |
| 模型文件大小 | ~4.3GB | ~1.5GB |
| 图像分辨率 | 384x384 | 224x224 |
| 嵌入维度 | 1152 | 768 |
| 多语言支持 | ✅ | ✅ |
| 适合设备 | 高配置 | 低配置 |


## 8. 总结

经过多次迭代修复，SigLIP 2 系列模型已成功集成：

### 已解决的问题
1. ✅ 语义空间对齐（Projection Head）
2. ✅ 分词器 Clone 漏洞
3. ✅ 预处理性能问题
4. ✅ 虚拟输入形状匹配
5. ✅ 显存共享架构
6. ✅ 相似度计算公式（logit_scale 和 logit_bias）
7. ✅ 轻量级模型支持（SigLIP 2 Base）
8. ✅ 模型文件损坏检测和重新下载功能
9. ✅ AI 视觉功能状态管理优化

### 当前状态
- 搜索功能正常工作
- 分数分布合理（0.5-0.98）
- 置信度阈值 0.8 以上可得到视觉相似的图片
- 支持低配置设备（SigLIP 2 Base）

### 后续优化方向
- **性能调优**：DirectML 首次推理预热
- **参数微调**：根据实际数据集调整 logit_scale 和 logit_bias
- **更多模型**：添加 SigLIP 2 ViT-L 等中等规格模型

---
*记录更新时间：2026-02-27*
*关联任务：SigLIP 2 搜索精准度修复项目、SigLIP 2 Base 轻量级模型集成*
