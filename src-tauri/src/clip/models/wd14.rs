//! WD14 EVA02 Large Tagger V3 模型规格定义
//!
//! 该模型专门用于二次元图像标签识别，并输出 10861 维的标签概率向量作为特征。

use super::{ModelFile, ModelSpec, SimilarityType};

/// WD-EVA02-Large-tagger-v3 模型规格
pub struct WdEva02LargeV3;

impl ModelSpec for WdEva02LargeV3 {
    fn name(&self) -> &str {
        "WD-EVA02-Large-Tagger-V3"
    }

    fn display_name(&self) -> &str {
        "WD-EVA02-Large Tagger V3"
    }

    fn description(&self) -> &str {
        "EVA02 Large 架构的标注模型，专为二次元优化。支持超过 1 万个标签识别，并提供 10861 维标签概率向量用于搜索。"
    }

    fn embedding_dim(&self) -> usize {
        10861 // 使用标签概率向量作为特征
    }

    fn image_size(&self) -> usize {
        448 // EVA02-Large 通常使用 448x448
    }

    fn image_mean(&self) -> [f32; 3] {
        // WD14 Tagger 系列通常使用 [0, 0, 0] 均值，在预处理中处理
        [0.0, 0.0, 0.0]
    }

    fn image_std(&self) -> [f32; 3] {
        [1.0, 1.0, 1.0]
    }

    fn max_text_length(&self) -> usize {
        0 // 不支持文本输入
    }

    fn model_files(&self) -> Vec<ModelFile> {
        vec![
            ModelFile::new(
                "model.onnx",
                "https://hf-mirror.com/deepghs/wd14_tagger_with_embeddings/resolve/main/SmilingWolf/wd-eva02-large-tagger-v3/model.onnx",
            ),
        ]
    }

    fn vision_input_name(&self) -> &str {
        "input"
    }

    fn vision_output_name(&self) -> &str {
        "output" // 使用标签概率输出作为特征向量（更有区分度）
    }

    fn text_input_name(&self) -> &str {
        ""
    }

    fn text_output_name(&self) -> &str {
        ""
    }

    fn is_tagger(&self) -> bool {
        true
    }

    fn tagger_output_name(&self) -> &str {
        "output" // 标签概率输出（与 vision_output_name 相同）
    }

    fn tags_file(&self) -> Option<&str> {
        None
    }

    fn similarity_type(&self) -> SimilarityType {
        SimilarityType::Cosine
    }

    fn image_tensor_format(&self) -> super::ImageTensorFormat {
        super::ImageTensorFormat::Nhwc
    }
}
