# SigLIP 2 集成问题诊断与修复总结

本记录总结了在集成 SigLIP 2 So400M 模型过程中遇到的主要技术挑战、多次编译中断的原因及其最终解决方案。本会话经历了多次"尝试-失败-回退-重构"的迭代，最终确立了稳定的显存共享架构。

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


## 6. 当前遗留问题与后续攻坚

### 核心问题：搜索结果语义不正确
**现象**：
- 搜索"穿西装的男人"返回无关结果（如裸露女性写真）
- 搜索"一只狗"返回黑白漫画（无狗）
- 分数分布太窄（0.74-0.82），差异只有 0.05-0.07

**可能原因**：
1. **图像嵌入向量本身有问题**：虚拟输入配置可能与训练时不一致
2. **模型权重问题**：ONNX 转换可能丢失了某些关键参数（如 logit_scale）
3. **语义空间对齐问题**：统一模型在推理时对虚拟占位符的依赖与训练时不完全一致

**后续方向**：
1. 检查 SigLIP 模型的 logit_scale 参数是否在 ONNX 转换时丢失
2. 尝试使用分离的 vision_model.onnx 和 text_model.onnx
3. 检查图像预处理是否与训练时一致
4. 考虑使用其他 CLIP 模型（如 CLIP-ViT-B-32）进行对比测试

### 其他遗留问题
- **性能调优**：DirectML 在统一模型上的首次推理由于尺寸较大（384x384），初始加载略显迟钝，可考虑预热 (Warmup)

---
*记录更新时间：2026-02-23*
*关联任务：SigLIP 2 搜索精准度修复项目*
