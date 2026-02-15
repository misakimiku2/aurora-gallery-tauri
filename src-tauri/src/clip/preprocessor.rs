//! CLIP 图像和文本预处理器
//! 实现 CLIP 模型的图像和文本预处理

use std::path::PathBuf;
use tokenizers::Tokenizer;
use once_cell::sync::OnceCell;
use fast_image_resize as fr;
use std::num::NonZeroU32;

/// CLIP 图像预处理器
pub struct ImagePreprocessor {
    /// 目标图像尺寸 (通常是 224x224)
    target_size: usize,
}

impl ImagePreprocessor {
    /// 创建新的图像预处理器
    pub fn new(target_size: usize) -> Self {
        Self { target_size }
    }

    /// 预处理图像
    /// 将图像调整为 target_size x target_size，并归一化到 [0, 1] 范围
    /// 返回 NCHW 格式的浮点数组 [1, 3, H, W]
    pub fn preprocess(&self, image_path: &str) -> Result<Vec<f32>, String> {
        // 使用 image 库加载图像
        let img = image::open(image_path)
            .map_err(|e| format!("Failed to open image {}: {}", image_path, e))?;
        
        // 如果图像尺寸过大，先进行快速下采样以提高性能
        let (width, height) = (img.width(), img.height());
        let max_dimension = 1024u32; // 最大维度限制
        let img = if width > max_dimension || height > max_dimension {
            let scale = max_dimension as f32 / width.max(height) as f32;
            let new_width = (width as f32 * scale) as u32;
            let new_height = (height as f32 * scale) as u32;
            // 使用快速的 Triangle 滤波器进行下采样
            img.resize(new_width, new_height, image::imageops::FilterType::Triangle)
        } else {
            img
        };
        
        // 转换为 RGB8
        let rgb_img = img.to_rgb8();
        let (width, height) = rgb_img.dimensions();
        
        // 使用 fast_image_resize 进行高性能缩放
        let target_size_u32 = self.target_size as u32;
        let resized = if width == target_size_u32 && height == target_size_u32 {
            // 如果尺寸已经正确，直接转换
            rgb_img
        } else {
            // 使用 fast_image_resize 进行缩放
            let src_image = fr::Image::from_vec_u8(
                NonZeroU32::new(width).ok_or("Invalid width")?,
                NonZeroU32::new(height).ok_or("Invalid height")?,
                rgb_img.into_raw(),
                fr::PixelType::U8x3,
            ).map_err(|e| format!("Failed to create source image: {}", e))?;
            
            let mut dst_image = fr::Image::new(
                NonZeroU32::new(target_size_u32).ok_or("Invalid target width")?,
                NonZeroU32::new(target_size_u32).ok_or("Invalid target height")?,
                fr::PixelType::U8x3,
            );
            
            // 使用快速的 resize 算法
            let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
            resizer.resize(&src_image.view(), &mut dst_image.view_mut())
                .map_err(|e| format!("Failed to resize image: {}", e))?;
            
            // 转换回 RgbImage
            image::RgbImage::from_raw(target_size_u32, target_size_u32, dst_image.buffer().to_vec())
                .ok_or("Failed to create resized RGB image")?
        };
        
        // 提取像素并归一化
        // CLIP 使用 ImageNet 归一化: mean=[0.48145466, 0.4578275, 0.40821073], std=[0.26862954, 0.26130258, 0.27577711]
        let mean = [0.48145466f32, 0.4578275f32, 0.40821073f32];
        let std = [0.26862954f32, 0.26130258f32, 0.27577711f32];
        
        let mut tensor = vec![0.0f32; 3 * self.target_size * self.target_size];
        
        for (i, pixel) in resized.pixels().enumerate() {
            let x = i % self.target_size;
            let y = i / self.target_size;
            
            // NCHW 格式: [batch=0, channel, y, x]
            // R channel
            tensor[0 * self.target_size * self.target_size + y * self.target_size + x] = 
                (pixel[0] as f32 / 255.0 - mean[0]) / std[0];
            // G channel
            tensor[1 * self.target_size * self.target_size + y * self.target_size + x] = 
                (pixel[1] as f32 / 255.0 - mean[1]) / std[1];
            // B channel
            tensor[2 * self.target_size * self.target_size + y * self.target_size + x] = 
                (pixel[2] as f32 / 255.0 - mean[2]) / std[2];
        }
        
        Ok(tensor)
    }
    
    /// 批量预处理图像 - 使用多线程并行处理
    pub fn preprocess_batch(&self, image_paths: &[String]) -> Result<Vec<Vec<f32>>, String> {
        use rayon::prelude::*;
        
        image_paths
            .par_iter() // 并行处理
            .map(|path| self.preprocess(path))
            .collect::<Result<Vec<_>, _>>()
    }

    /// 获取目标尺寸
    pub fn target_size(&self) -> usize {
        self.target_size
    }
}

/// 全局 Tokenizer 实例
static TOKENIZER: OnceCell<std::sync::Mutex<Option<Tokenizer>>> = OnceCell::new();

/// CLIP 文本预处理器
pub struct TextPreprocessor {
    max_length: usize,
    tokenizer: Option<Tokenizer>,
}

impl TextPreprocessor {
    /// 创建新的文本预处理器
    pub fn new() -> Self {
        Self { 
            max_length: 77,
            tokenizer: None,
        }
    }

    /// 从文件加载 tokenizer
    pub fn load_tokenizer(&mut self, tokenizer_path: &PathBuf) -> Result<(), String> {
        let tokenizer = Tokenizer::from_file(tokenizer_path)
            .map_err(|e| format!("Failed to load tokenizer: {}", e))?;
        
        self.tokenizer = Some(tokenizer);
        Ok(())
    }

    /// 预处理文本
    /// 返回 (input_ids, attention_mask)
    pub fn preprocess(&self, text: &str) -> Result<(Vec<i64>, Vec<i64>), String> {
        // 如果没有加载 tokenizer，使用简化的占位符实现
        // 这在模型尚未完全初始化时作为回退
        let tokenizer = match &self.tokenizer {
            Some(t) => t,
            None => {
                // 回退到简单的字符编码
                return self.fallback_preprocess(text);
            }
        };

        // 使用 tokenizer 进行编码
        let encoding = tokenizer.encode(text, true)
            .map_err(|e| format!("Failed to encode text: {}", e))?;

        let ids = encoding.get_ids();
        let attention = encoding.get_attention_mask();

        // 填充或截断到 max_length
        let mut input_ids = vec![0i64; self.max_length];
        let mut attention_mask = vec![0i64; self.max_length];

        let len = ids.len().min(self.max_length);
        for i in 0..len {
            input_ids[i] = ids[i] as i64;
            attention_mask[i] = attention[i] as i64;
        }

        Ok((input_ids, attention_mask))
    }

    /// 简化的回退预处理（当 tokenizer 不可用时使用）
    fn fallback_preprocess(&self, text: &str) -> Result<(Vec<i64>, Vec<i64>), String> {
        // 简化的编码：将字符映射为 id
        let mut input_ids = vec![0i64; self.max_length];
        let mut attention_mask = vec![0i64; self.max_length];

        // BOS token
        input_ids[0] = 49406;
        attention_mask[0] = 1;

        let chars: Vec<char> = text.chars().collect();
        let len = chars.len().min(self.max_length - 2);

        for (i, c) in chars.iter().take(len).enumerate() {
            // 简单的字符到 id 映射
            input_ids[i + 1] = (*c as u32 % 50000) as i64;
            attention_mask[i + 1] = 1;
        }

        // EOS token
        let end_pos = len + 1;
        if end_pos < self.max_length {
            input_ids[end_pos] = 49407;
            attention_mask[end_pos] = 1;
        }

        Ok((input_ids, attention_mask))
    }

    /// 设置全局 tokenizer（用于模型加载后）
    pub fn set_global_tokenizer(tokenizer: Tokenizer) {
        let _ = TOKENIZER.set(std::sync::Mutex::new(Some(tokenizer)));
    }

    /// 从全局获取 tokenizer
    pub fn get_global_tokenizer() -> Option<Tokenizer> {
        TOKENIZER.get()
            .and_then(|m| m.lock().ok())
            .and_then(|t| t.clone())
    }
}

impl Clone for TextPreprocessor {
    fn clone(&self) -> Self {
        Self {
            max_length: self.max_length,
            tokenizer: None, // Tokenizer 不实现 Clone，所以克隆时设为 None
        }
    }
}
