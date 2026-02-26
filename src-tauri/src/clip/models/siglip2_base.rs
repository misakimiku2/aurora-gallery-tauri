//! SigLIP 2 Base (ViT-B) 模型规格定义
//!
//! SigLIP 2 Base 是 SigLIP 2 系列中最小的模型（86M 参数），
//! 使用 224x224 的图像分辨率，适合低配置设备使用。

use super::{ModelFile, ModelSpec, SimilarityType};

/// SigLIP 2 Base 模型规格
///
/// 这是一个 86M 参数的 SigLIP 2 模型，使用 224x224 的图像分辨率。
/// 相比 So400M 模型，显存占用降低约 75%，适合低配置设备。
pub struct SigLIP2Base;

impl ModelSpec for SigLIP2Base {
    fn name(&self) -> &str {
        "SigLIP2-Base"
    }

    fn display_name(&self) -> &str {
        "SigLIP 2 Base (轻量版)"
    }

    fn description(&self) -> &str {
        "SigLIP 2 Base 模型，86M 参数，224x224 图像分辨率，\
         显存占用约 1GB，适合低配置设备使用"
    }

    fn embedding_dim(&self) -> usize {
        768
    }

    fn image_size(&self) -> usize {
        224
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
            ModelFile::new(
                "model.onnx",
                "https://hf-mirror.com/onnx-community/siglip2-base-patch16-224-ONNX/resolve/main/onnx/model.onnx",
            ),
            ModelFile::new(
                "tokenizer.json",
                "https://hf-mirror.com/google/siglip2-base-patch16-224/resolve/main/tokenizer.json",
            ),
            ModelFile::new(
                "tokenizer_config.json",
                "https://hf-mirror.com/google/siglip2-base-patch16-224/resolve/main/tokenizer_config.json",
            ),
            ModelFile::new(
                "special_tokens_map.json",
                "https://hf-mirror.com/google/siglip2-base-patch16-224/resolve/main/special_tokens_map.json",
            ),
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

    fn dummy_vision_input_shape(&self) -> Option<(usize, usize, usize, usize)> {
        Some((1, 3, self.image_size(), self.image_size()))
    }

    fn dummy_text_input_length(&self) -> usize {
        self.max_text_length()
    }

    fn similarity_type(&self) -> SimilarityType {
        SimilarityType::Sigmoid
    }

    fn sigmoid_logit_scale(&self) -> f32 {
        14.285714
    }

    fn sigmoid_logit_bias(&self) -> f32 {
        -10.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_siglip2_base_name() {
        let model = SigLIP2Base;
        assert_eq!(model.name(), "SigLIP2-Base");
    }

    #[test]
    fn test_siglip2_base_display_name() {
        let model = SigLIP2Base;
        assert_eq!(model.display_name(), "SigLIP 2 Base (轻量版)");
    }

    #[test]
    fn test_siglip2_base_embedding_dim() {
        let model = SigLIP2Base;
        assert_eq!(model.embedding_dim(), 768);
    }

    #[test]
    fn test_siglip2_base_image_size() {
        let model = SigLIP2Base;
        assert_eq!(model.image_size(), 224);
    }

    #[test]
    fn test_siglip2_base_image_normalization() {
        let model = SigLIP2Base;
        assert_eq!(model.image_mean(), [0.5, 0.5, 0.5]);
        assert_eq!(model.image_std(), [0.5, 0.5, 0.5]);
    }

    #[test]
    fn test_siglip2_base_max_text_length() {
        let model = SigLIP2Base;
        assert_eq!(model.max_text_length(), 64);
    }

    #[test]
    fn test_siglip2_base_model_files() {
        let model = SigLIP2Base;
        let files = model.model_files();
        assert_eq!(files.len(), 4);

        assert_eq!(files[0].name, "model.onnx");
        assert_eq!(files[1].name, "tokenizer.json");
        assert_eq!(files[2].name, "tokenizer_config.json");
        assert_eq!(files[3].name, "special_tokens_map.json");
    }

    #[test]
    fn test_siglip2_base_onnx_io_names() {
        let model = SigLIP2Base;
        assert_eq!(model.vision_input_name(), "pixel_values");
        assert_eq!(model.vision_output_name(), "image_embeds");
        assert_eq!(model.text_input_name(), "input_ids");
        assert_eq!(model.text_output_name(), "text_embeds");
    }

    #[test]
    fn test_siglip2_base_similarity_type() {
        let model = SigLIP2Base;
        assert_eq!(model.similarity_type(), SimilarityType::Sigmoid);
    }
}
