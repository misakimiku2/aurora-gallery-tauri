//! SigLIP 2 So400M 模型规格定义
//!
//! SigLIP 2 是一种改进的视觉语言模型，使用 Sigmoid loss 进行训练，
//! 相比原始 CLIP 模型在零样本分类和图像-文本检索任务上有更好的性能。

use super::{ModelFile, ModelSpec, SimilarityType};

/// SigLIP 2 So400M 模型规格
///
/// 这是一个 400M 参数的 SigLIP 2 模型，使用 384x384 的图像分辨率。
/// 该模型使用单一 ONNX 文件（model.onnx + model.onnx_data），
/// 同时包含视觉编码器和文本编码器。
pub struct SigLIP2So400M;

impl ModelSpec for SigLIP2So400M {
    fn name(&self) -> &str {
        "SigLIP2-So400M"
    }

    fn display_name(&self) -> &str {
        "SigLIP 2 So400M"
    }

    fn description(&self) -> &str {
        "SigLIP 2 So400M 模型，384x384 图像分辨率，使用 Sigmoid loss 训练，\
         相比原始 CLIP 在零样本分类和图像-文本检索任务上有更好的性能"
    }

    fn embedding_dim(&self) -> usize {
        1152
    }

    fn image_size(&self) -> usize {
        384
    }

    fn image_mean(&self) -> [f32; 3] {
        [0.5, 0.5, 0.5]
    }

    fn image_std(&self) -> [f32; 3] {
        [0.5, 0.5, 0.5]
    }

    fn max_text_length(&self) -> usize {
        64
    }

    fn model_files(&self) -> Vec<ModelFile> {
        vec![
            // 统一模型文件（包含完整 Projection Head 以对准语义空间）
            ModelFile::new(
                "model.onnx",
                "https://hf-mirror.com/onnx-community/siglip2-so400m-patch14-384-ONNX/resolve/main/onnx/model.onnx",
            ),
            // 模型权重数据文件
            ModelFile::new(
                "model.onnx_data",
                "https://hf-mirror.com/onnx-community/siglip2-so400m-patch14-384-ONNX/resolve/main/onnx/model.onnx_data",
            ),
            // tokenizer.json (HuggingFace tokenizers 格式)
            ModelFile::new(
                "tokenizer.json",
                "https://hf-mirror.com/google/siglip2-so400m-patch14-384/resolve/main/tokenizer.json",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
            // 分词器配置文件
            ModelFile::new(
                "tokenizer_config.json",
                "https://hf-mirror.com/google/siglip2-so400m-patch14-384/resolve/main/tokenizer_config.json",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
            // 特殊 token 映射
            ModelFile::new(
                "special_tokens_map.json",
                "https://hf-mirror.com/google/siglip2-so400m-patch14-384/resolve/main/special_tokens_map.json",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
        ]
    }

    fn vision_input_name(&self) -> &str {
        "pixel_values"
    }

    fn vision_output_name(&self) -> &str {
        "image_embeds"
    }

    fn text_input_name(&self) -> &str {
        "input_ids"
    }

    fn text_output_name(&self) -> &str {
        "text_embeds"
    }

    /// SigLIP2 使用统一模型，文本编码时必须提供正确尺寸的虚拟 pixel_values。
    /// 若提供错误的 16x16 形状，Vision Transformer 的 patch 数量会不匹配，
    /// 导致计算产生 NaN/inf，使所有搜索结果相同。
    fn dummy_vision_input_shape(&self) -> Option<(usize, usize, usize, usize)> {
        // SigLIP2 图像尺寸为 384x384，Patch Size 为 14
        Some((1, 3, self.image_size(), self.image_size())) // (1, 3, 384, 384)
    }

    /// SigLIP2 图像编码时，必须提供与 max_text_length 相同长度的虚拟 input_ids。
    /// 这确保图像嵌入在"标准长度文本上下文"中计算，与文本嵌入的语义空间对齐。
    /// 若只提供 1 个 token，图像语义空间会发生偏移，导致搜索精度下降。
    fn dummy_text_input_length(&self) -> usize {
        self.max_text_length() // 64
    }

    /// SigLIP2 使用 sigmoid loss 训练，相似度计算应使用 sigmoid 方式
    fn similarity_type(&self) -> SimilarityType {
        SimilarityType::Sigmoid
    }

    /// SigLIP2 的 temperature 参数
    /// 根据 SigLIP 论文和实验，temperature 通常在 0.01-0.1 之间
    /// 较小的 temperature 会使分数分布更宽，更容易区分相关和不相关的结果
    fn sigmoid_temperature(&self) -> f32 {
        0.01
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_siglip2_name() {
        let model = SigLIP2So400M;
        assert_eq!(model.name(), "SigLIP2-So400M");
    }

    #[test]
    fn test_siglip2_display_name() {
        let model = SigLIP2So400M;
        assert_eq!(model.display_name(), "SigLIP 2 So400M");
    }

    #[test]
    fn test_siglip2_embedding_dim() {
        let model = SigLIP2So400M;
        assert_eq!(model.embedding_dim(), 1152);
    }

    #[test]
    fn test_siglip2_image_size() {
        let model = SigLIP2So400M;
        assert_eq!(model.image_size(), 384);
    }

    #[test]
    fn test_siglip2_image_normalization() {
        let model = SigLIP2So400M;
        assert_eq!(model.image_mean(), [0.5, 0.5, 0.5]);
        assert_eq!(model.image_std(), [0.5, 0.5, 0.5]);
    }

    #[test]
    fn test_siglip2_max_text_length() {
        let model = SigLIP2So400M;
        assert_eq!(model.max_text_length(), 64);
    }

    #[test]
    fn test_siglip2_model_files() {
        let model = SigLIP2So400M;
        let files = model.model_files();
        assert_eq!(files.len(), 5);

        // 验证文件名
        assert_eq!(files[0].name, "model.onnx");
        assert_eq!(files[1].name, "model.onnx_data");
        assert_eq!(files[2].name, "tokenizer.json");
        assert_eq!(files[3].name, "tokenizer_config.json");
        assert_eq!(files[4].name, "special_tokens_map.json");

        // 验证 URL 包含正确的域名
        for file in files {
            assert!(file.url.contains("hf-mirror.com") || file.url.contains("google"));
        }
    }

    #[test]
    fn test_siglip2_onnx_io_names() {
        let model = SigLIP2So400M;
        assert_eq!(model.vision_input_name(), "pixel_values");
        assert_eq!(model.vision_output_name(), "image_embeds");
        assert_eq!(model.text_input_name(), "input_ids");
        assert_eq!(model.text_output_name(), "text_embeds");
    }
}
