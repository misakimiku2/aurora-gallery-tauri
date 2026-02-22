//! SigLIP 2 So400M 模型规格定义
//!
//! SigLIP 2 是一种改进的视觉语言模型，使用 Sigmoid loss 进行训练，
//! 相比原始 CLIP 模型在零样本分类和图像-文本检索任务上有更好的性能。

use super::{ModelFile, ModelSpec};

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
            // 主模型文件（包含视觉和文本编码器）
            ModelFile::new(
                "model.onnx",
                "https://hf-mirror.com/onnx-community/siglip2-so400m-patch14-384-ONNX/resolve/main/onnx/model.onnx",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
            // 模型权重数据文件（大型模型的分片权重）
            ModelFile::new(
                "model.onnx_data",
                "https://hf-mirror.com/onnx-community/siglip2-so400m-patch14-384-ONNX/resolve/main/onnx/model.onnx_data",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
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
        assert!(files[0].url.contains("hf-mirror.com"));
        assert!(files[1].url.contains("hf-mirror.com"));
        assert!(files[2].url.contains("hf-mirror.com"));
        assert!(files[3].url.contains("hf-mirror.com"));
        assert!(files[4].url.contains("hf-mirror.com"));
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
