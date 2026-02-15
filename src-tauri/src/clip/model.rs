//! CLIP 模型加载和推理
//! 支持 ONNX 格式的 CLIP 模型

use std::path::PathBuf;
use once_cell::sync::OnceCell;

use super::ClipConfig;
use super::preprocessor::{ImagePreprocessor, TextPreprocessor};

/// 全局模型状态
static MODEL_STATE: OnceCell<std::sync::Mutex<ModelState>> = OnceCell::new();

struct ModelState {
    is_loaded: bool,
    model_name: String,
}

/// CLIP 模型结构
pub struct ClipModel {
    config: ClipConfig,
    image_preprocessor: ImagePreprocessor,
    text_preprocessor: TextPreprocessor,
}

/// 模型文件信息
#[derive(Debug, Clone)]
pub struct ModelInfo {
    pub name: String,
    pub image_model_url: String,
    pub text_model_url: String,
    pub tokenizer_url: String,
    pub embedding_dim: usize,
    pub image_size: usize,
}

impl ModelInfo {
    /// 获取 ViT-B/32 模型信息
    /// 使用 hf-mirror 国内镜像加速下载
    pub fn vit_b_32() -> Self {
        Self {
            name: "ViT-B-32".to_string(),
            // 使用 hf-mirror 国内镜像
            image_model_url: "https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/vision_model.onnx".to_string(),
            text_model_url: "https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/onnx/text_model.onnx".to_string(),
            // tokenizer 使用相同的镜像
            tokenizer_url: "https://hf-mirror.com/Xenova/clip-vit-base-patch32/resolve/main/tokenizer.json".to_string(),
            embedding_dim: 512,
            image_size: 224,
        }
    }

    /// 获取 ViT-L/14 模型信息
    /// 使用 hf-mirror 国内镜像加速下载
    pub fn vit_l_14() -> Self {
        Self {
            name: "ViT-L-14".to_string(),
            // 使用 hf-mirror 国内镜像
            image_model_url: "https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/onnx/vision_model.onnx".to_string(),
            text_model_url: "https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/onnx/text_model.onnx".to_string(),
            // tokenizer 使用相同的镜像
            tokenizer_url: "https://hf-mirror.com/Xenova/clip-vit-large-patch14/resolve/main/tokenizer.json".to_string(),
            embedding_dim: 768,
            image_size: 224,
        }
    }
}

impl ClipModel {
    /// 加载 CLIP 模型
    pub async fn load(config: &ClipConfig) -> Result<Self, String> {
        let model_info = match config.model_name.as_str() {
            "ViT-B-32" => ModelInfo::vit_b_32(),
            "ViT-L-14" => ModelInfo::vit_l_14(),
            _ => return Err(format!("Unsupported model: {}", config.model_name)),
        };

        // 确保模型文件存在
        let _image_model_path = Self::ensure_model_file(&model_info.image_model_url, &config.cache_dir).await?;
        let _text_model_path = Self::ensure_model_file(&model_info.text_model_url, &config.cache_dir).await?;
        let _tokenizer_path = Self::ensure_model_file(&model_info.tokenizer_url, &config.cache_dir).await?;

        let image_preprocessor = ImagePreprocessor::new(model_info.image_size);
        let text_preprocessor = TextPreprocessor::new();

        log::info!("CLIP model files ready: {}", config.model_name);
        
        // 标记模型为已加载
        let state = MODEL_STATE.get_or_init(|| {
            std::sync::Mutex::new(ModelState {
                is_loaded: false,
                model_name: config.model_name.clone(),
            })
        });
        
        if let Ok(mut s) = state.lock() {
            s.is_loaded = true;
            s.model_name = config.model_name.clone();
        }

        Ok(Self {
            config: config.clone(),
            image_preprocessor,
            text_preprocessor,
        })
    }

    /// 确保模型文件存在，如果不存在则下载
    async fn ensure_model_file(url: &str, cache_dir: &PathBuf) -> Result<PathBuf, String> {
        let file_name = url.split('/').last().ok_or("Invalid URL")?;
        let file_path = cache_dir.join(file_name);

        if file_path.exists() {
            log::debug!("Model file already exists: {:?}", file_path);
            return Ok(file_path);
        }

        log::info!("Downloading model file from {} to {:?}", url, file_path);
        
        // 下载文件
        let response = reqwest::get(url)
            .await
            .map_err(|e| format!("Failed to download {}: {}", url, e))?;

        if !response.status().is_success() {
            return Err(format!("Failed to download {}: HTTP {}. Please download the model manually and place it in {:?}", 
                url, response.status(), cache_dir));
        }

        let bytes = response.bytes()
            .await
            .map_err(|e| format!("Failed to read response bytes: {}", e))?;

        tokio::fs::write(&file_path, bytes)
            .await
            .map_err(|e| format!("Failed to write file: {}", e))?;

        log::info!("Downloaded model file: {:?}", file_path);
        Ok(file_path)
    }
    
    /// 检查模型文件是否存在于本地
    pub fn check_local_model_files(cache_dir: &PathBuf, model_name: &str) -> Result<bool, String> {
        let model_info = match model_name {
            "ViT-B-32" => ModelInfo::vit_b_32(),
            "ViT-L-14" => ModelInfo::vit_l_14(),
            _ => return Err(format!("Unknown model: {}", model_name)),
        };
        
        let image_file = model_info.image_model_url.split('/').last().unwrap_or("image_encoder.onnx");
        let text_file = model_info.text_model_url.split('/').last().unwrap_or("text_encoder.onnx");
        let tokenizer_file = model_info.tokenizer_url.split('/').last().unwrap_or("tokenizer.json");
        
        let image_path = cache_dir.join(image_file);
        let text_path = cache_dir.join(text_file);
        let tokenizer_path = cache_dir.join(tokenizer_file);
        
        Ok(image_path.exists() && text_path.exists() && tokenizer_path.exists())
    }

    /// 编码图像
    /// 注意：当前使用确定性伪随机向量作为占位符
    /// TODO: 实现完整的 ONNX 推理
    pub fn encode_image(&self, image_path: &str) -> Result<Vec<f32>, String> {
        // 检查文件是否存在
        if !std::path::Path::new(image_path).exists() {
            return Err(format!("Image file not found: {}", image_path));
        }
        
        // 预处理图像（验证图像可以正常加载）
        let _ = self.image_preprocessor.preprocess(image_path)?;
        
        // 生成伪随机但确定性的向量（基于文件路径）
        let dim = self.config.embedding_dim;
        let mut vec = vec![0.0f32; dim];
        
        let seed = image_path.bytes().fold(0u64, |acc, b| {
            acc.wrapping_mul(31).wrapping_add(b as u64)
        });
        
        for i in 0..dim {
            let val = ((seed.wrapping_add(i as u64) % 1000) as f32) / 1000.0;
            vec[i] = val;
        }
        
        normalize_vector(&mut vec);
        Ok(vec)
    }

    /// 编码文本
    /// 注意：当前使用确定性伪随机向量作为占位符
    /// TODO: 实现完整的 ONNX 推理
    pub fn encode_text(&self, text: &str) -> Result<Vec<f32>, String> {
        // 验证文本不为空
        if text.trim().is_empty() {
            return Err("Empty text provided".to_string());
        }
        
        // 生成伪随机但确定性的向量（基于文本内容）
        let dim = self.config.embedding_dim;
        let mut vec = vec![0.0f32; dim];
        
        let seed = text.bytes().fold(0u64, |acc, b| {
            acc.wrapping_mul(31).wrapping_add(b as u64)
        });
        
        for i in 0..dim {
            let val = ((seed.wrapping_add(i as u64) % 1000) as f32) / 1000.0;
            vec[i] = val;
        }
        
        normalize_vector(&mut vec);
        Ok(vec)
    }

    /// 批量编码图像
    pub fn encode_images_batch(&self, image_paths: &[String]) -> Result<Vec<Vec<f32>>, String> {
        image_paths.iter()
            .map(|path| self.encode_image(path))
            .collect()
    }

    /// 获取嵌入维度
    pub fn embedding_dim(&self) -> usize {
        self.config.embedding_dim
    }
}

/// 向量归一化 (L2 归一化)
fn normalize_vector(vec: &mut [f32]) {
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in vec.iter_mut() {
            *x /= norm;
        }
    }
}

/// 计算两个向量之间的余弦相似度
/// 注意：输入向量必须是归一化后的
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// 计算向量与查询向量的相似度并排序
pub fn rank_by_similarity(query: &[f32], candidates: &[(String, Vec<f32>)]) -> Vec<(String, f32)> {
    let mut results: Vec<(String, f32)> = candidates
        .iter()
        .map(|(id, embedding)| {
            let similarity = cosine_similarity(query, embedding);
            (id.clone(), similarity)
        })
        .collect();

    // 按相似度降序排序
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results
}
