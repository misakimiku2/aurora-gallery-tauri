//! CLIP ViT 系列模型规格定义
//! 包含 ViT-B/32 和 ViT-L/14 两种模型变体

use super::{ModelSpec, ModelFile};

/// CLIP ViT-B/32 模型规格
///
/// 基于 Vision Transformer 的 CLIP 模型，使用 32x32 patch size
/// - 嵌入维度: 512
/// - 图像尺寸: 224x224
/// - 参数量: ~150M
#[derive(Debug, Clone)]
pub struct ClipVitB32;

impl ModelSpec for ClipVitB32 {
    fn name(&self) -> &str {
        "ViT-B-32"
    }

    fn display_name(&self) -> &str {
        "CLIP ViT-B/32"
    }

    fn description(&self) -> &str {
        "CLIP Vision Transformer Base with 32x32 patches. Fast and efficient for most use cases."
    }

    fn embedding_dim(&self) -> usize {
        512
    }

    fn image_size(&self) -> usize {
        224
    }

    fn image_mean(&self) -> [f32; 3] {
        [0.48145466, 0.4578275, 0.40821073]
    }

    fn image_std(&self) -> [f32; 3] {
        [0.26862954, 0.26130258, 0.27577711]
    }

    fn max_text_length(&self) -> usize {
        77
    }

    fn model_files(&self) -> Vec<ModelFile> {
        vec![
            ModelFile::new(
                "vision_model.onnx",
                "https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model.onnx",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
            ModelFile::new(
                "text_model.onnx",
                "https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model.onnx",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
            ModelFile::new(
                "tokenizer.json",
                "https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json",
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

/// CLIP ViT-L/14 模型规格
///
/// 基于 Vision Transformer 的 CLIP 模型，使用 14x14 patch size
/// - 嵌入维度: 768
/// - 图像尺寸: 224x224
/// - 参数量: ~400M
#[derive(Debug, Clone)]
pub struct ClipVitL14;

impl ModelSpec for ClipVitL14 {
    fn name(&self) -> &str {
        "ViT-L-14"
    }

    fn display_name(&self) -> &str {
        "CLIP ViT-L/14"
    }

    fn description(&self) -> &str {
        "CLIP Vision Transformer Large with 14x14 patches. Higher accuracy with larger embedding dimension."
    }

    fn embedding_dim(&self) -> usize {
        768
    }

    fn image_size(&self) -> usize {
        224
    }

    fn image_mean(&self) -> [f32; 3] {
        [0.48145466, 0.4578275, 0.40821073]
    }

    fn image_std(&self) -> [f32; 3] {
        [0.26862954, 0.26130258, 0.27577711]
    }

    fn max_text_length(&self) -> usize {
        77
    }

    fn model_files(&self) -> Vec<ModelFile> {
        vec![
            ModelFile::new(
                "vision_model.onnx",
                "https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/onnx/vision_model.onnx",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
            ModelFile::new(
                "text_model.onnx",
                "https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/onnx/text_model.onnx",
            )
            // TODO: 添加预期文件大小和哈希值
            // .with_expected_size(XXX)
            // .with_expected_hash("xxx"),
            ,
            ModelFile::new(
                "tokenizer.json",
                "https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/tokenizer.json",
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
    fn test_vit_b32_spec() {
        let spec = ClipVitB32;
        
        assert_eq!(spec.name(), "ViT-B-32");
        assert_eq!(spec.display_name(), "CLIP ViT-B/32");
        assert_eq!(spec.embedding_dim(), 512);
        assert_eq!(spec.image_size(), 224);
        assert_eq!(spec.max_text_length(), 77);
        assert_eq!(spec.vision_input_name(), "pixel_values");
        assert_eq!(spec.vision_output_name(), "image_embeds");
        assert_eq!(spec.text_input_name(), "input_ids");
        assert_eq!(spec.text_output_name(), "text_embeds");
        
        let files = spec.model_files();
        assert_eq!(files.len(), 3);
        assert_eq!(files[0].name, "vision_model.onnx");
        assert_eq!(files[1].name, "text_model.onnx");
        assert_eq!(files[2].name, "tokenizer.json");
    }

    #[test]
    fn test_vit_l14_spec() {
        let spec = ClipVitL14;
        
        assert_eq!(spec.name(), "ViT-L-14");
        assert_eq!(spec.display_name(), "CLIP ViT-L/14");
        assert_eq!(spec.embedding_dim(), 768);
        assert_eq!(spec.image_size(), 224);
        assert_eq!(spec.max_text_length(), 77);
        assert_eq!(spec.vision_input_name(), "pixel_values");
        assert_eq!(spec.vision_output_name(), "image_embeds");
        assert_eq!(spec.text_input_name(), "input_ids");
        assert_eq!(spec.text_output_name(), "text_embeds");
        
        let files = spec.model_files();
        assert_eq!(files.len(), 3);
        assert!(files[0].url.contains("clip-vit-large-patch14"));
    }

    #[test]
    fn test_image_normalization_params() {
        let spec_b32 = ClipVitB32;
        let spec_l14 = ClipVitL14;
        
        // 两个模型使用相同的归一化参数
        assert_eq!(spec_b32.image_mean(), spec_l14.image_mean());
        assert_eq!(spec_b32.image_std(), spec_l14.image_std());
        
        let mean = spec_b32.image_mean();
        assert!((mean[0] - 0.48145466).abs() < 1e-6);
        assert!((mean[1] - 0.4578275).abs() < 1e-6);
        assert!((mean[2] - 0.40821073).abs() < 1e-6);
    }
}
