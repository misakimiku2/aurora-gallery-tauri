//! CLIP 模型规格定义和注册表
//! 提供模块化的模型架构，支持多种视觉语言模型

use std::sync::Arc;

mod clip_vit;
pub use clip_vit::{ClipVitB32, ClipVitL14};

// 模型模块
pub mod siglip2;

// 重新导出模型规格
pub use siglip2::SigLIP2So400M;

/// 模型文件信息
#[derive(Debug, Clone)]
pub struct ModelFile {
    /// 文件名
    pub name: String,
    /// 下载 URL
    pub url: String,
    /// 文件大小提示（字节）
    pub size_hint: Option<u64>,
    /// 预期文件大小（字节），用于完整性校验
    pub expected_size: Option<u64>,
    /// 预期文件 SHA256 哈希值，用于完整性校验
    pub expected_hash: Option<String>,
}

impl ModelFile {
    /// 创建新的模型文件信息
    pub fn new(name: impl Into<String>, url: impl Into<String>) -> Self {
        Self {
            name: name.into(),
            url: url.into(),
            size_hint: None,
            expected_size: None,
            expected_hash: None,
        }
    }

    /// 设置文件大小提示
    pub fn with_size_hint(mut self, size: u64) -> Self {
        self.size_hint = Some(size);
        self
    }

    /// 设置预期文件大小（用于完整性校验）
    pub fn with_expected_size(mut self, size: u64) -> Self {
        self.expected_size = Some(size);
        self
    }

    /// 设置预期文件 SHA256 哈希值（用于完整性校验）
    pub fn with_expected_hash(mut self, hash: impl Into<String>) -> Self {
        self.expected_hash = Some(hash.into());
        self
    }
}

/// 模型规格 trait - 所有视觉语言模型必须实现
pub trait ModelSpec: Send + Sync {
    /// 模型内部标识符（如 "ViT-B-32", "ViT-L-14"）
    fn name(&self) -> &str;

    /// 模型显示名称（如 "CLIP ViT-B/32"）
    fn display_name(&self) -> &str;

    /// 模型描述
    fn description(&self) -> &str;

    /// 嵌入向量维度
    fn embedding_dim(&self) -> usize;

    /// 输入图像尺寸（正方形边长）
    fn image_size(&self) -> usize;

    /// 图像归一化均值 (RGB)
    fn image_mean(&self) -> [f32; 3];

    /// 图像归一化标准差 (RGB)
    fn image_std(&self) -> [f32; 3];

    /// 最大文本长度（token 数量）
    fn max_text_length(&self) -> usize;

    /// 模型文件列表
    fn model_files(&self) -> Vec<ModelFile>;

    /// 视觉编码器输入节点名称
    fn vision_input_name(&self) -> &str;

    /// 视觉编码器输出节点名称
    fn vision_output_name(&self) -> &str;

    /// 文本编码器输入节点名称
    fn text_input_name(&self) -> &str;

    /// 文本编码器输出节点名称
    fn text_output_name(&self) -> &str;
}

/// 模型注册表类型别名
type ModelRegistry = Vec<Arc<dyn ModelSpec>>;

/// 获取模型注册表
/// 返回所有已注册的模型规格
fn get_registry() -> ModelRegistry {
    let mut registry = ModelRegistry::new();

    // CLIP ViT 系列模型
    registry.push(Arc::new(ClipVitB32));
    registry.push(Arc::new(ClipVitL14));

    // SigLIP 2 模型
    registry.push(Arc::new(SigLIP2So400M));

    registry
}

/// 根据名称获取模型规格
///
/// # 参数
/// * `name` - 模型内部标识符
///
/// # 返回
/// 如果找到匹配的模型，返回 `Some(Box<dyn ModelSpec>)`，否则返回 `None`
pub fn get_model_spec(name: &str) -> Option<Arc<dyn ModelSpec>> {
    get_registry()
        .into_iter()
        .find(|spec| spec.name() == name)
}

/// 获取所有已注册的模型规格
///
/// # 返回
/// 返回所有已注册模型的列表
pub fn get_all_models() -> Vec<Arc<dyn ModelSpec>> {
    get_registry()
}

/// 检查模型是否已注册
///
/// # 参数
/// * `name` - 模型内部标识符
///
/// # 返回
/// 如果模型已注册返回 `true`，否则返回 `false`
pub fn is_model_registered(name: &str) -> bool {
    get_registry().iter().any(|spec| spec.name() == name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_model_spec_returns_none_for_unknown_model() {
        let result = get_model_spec("unknown-model");
        assert!(result.is_none());
    }

    #[test]
    fn test_get_all_models_returns_registered_models() {
        let models = get_all_models();
        // 注册表应包含 CLIP ViT 系列模型
        assert!(!models.is_empty());
        assert!(models.iter().any(|m| m.name() == "ViT-B-32"));
        assert!(models.iter().any(|m| m.name() == "ViT-L-14"));
    }

    #[test]
    fn test_is_model_registered_returns_false_for_unknown_model() {
        assert!(!is_model_registered("unknown-model"));
    }

    #[test]
    fn test_is_model_registered_returns_true_for_known_models() {
        assert!(is_model_registered("ViT-B-32"));
        assert!(is_model_registered("ViT-L-14"));
    }

    #[test]
    fn test_get_model_spec_returns_correct_spec() {
        let spec = get_model_spec("ViT-B-32");
        assert!(spec.is_some());
        let spec = spec.unwrap();
        assert_eq!(spec.name(), "ViT-B-32");
        assert_eq!(spec.embedding_dim(), 512);
    }

    #[test]
    fn test_model_file_creation() {
        let file = ModelFile::new("model.onnx", "https://example.com/model.onnx")
            .with_size_hint(1024);

        assert_eq!(file.name, "model.onnx");
        assert_eq!(file.url, "https://example.com/model.onnx");
        assert_eq!(file.size_hint, Some(1024));
    }
}
