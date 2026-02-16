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

    pub fn preprocess(&self, image_path: &str) -> Result<Vec<f32>, String> {
        // 使用 image 库加载图像
        let load_start = std::time::Instant::now();
        let img = image::open(image_path)
            .map_err(|e| format!("Failed to open image {}: {}", image_path, e))?;
        let load_elapsed = load_start.elapsed().as_millis();
        
        // 直接转换为 RGB8
        let rgb_img = img.to_rgb8();
        let (width, height) = rgb_img.dimensions();
        
        let target_size_u32 = self.target_size as u32;
        let resize_start = std::time::Instant::now();
        let resized = if width == target_size_u32 && height == target_size_u32 {
            rgb_img
        } else {
            // 使用 fast_image_resize 进行高性能缩放
            // Box 滤波器是最快的算法，适合大幅缩小
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
            
            // 使用 Box 滤波器进行快速缩放（最适合大幅缩小）
            let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Box));
            resizer.resize(&src_image.view(), &mut dst_image.view_mut())
                .map_err(|e| format!("Failed to resize image: {}", e))?;
            
            image::RgbImage::from_raw(target_size_u32, target_size_u32, dst_image.buffer().to_vec())
                .ok_or("Failed to create resized RGB image")?
        };
        let resize_elapsed = resize_start.elapsed().as_millis();
        
        if load_elapsed > 50 || resize_elapsed > 10 {
            log::debug!("[Preprocess] {}x{} -> 224x224: load={}ms, resize={}ms", 
                width, height, load_elapsed, resize_elapsed);
        }
        
        // 提取像素并归一化
        let mean = [0.48145466f32, 0.4578275f32, 0.40821073f32];
        let std = [0.26862954f32, 0.26130258f32, 0.27577711f32];
        
        let size = self.target_size;
        let mut tensor = vec![0.0f32; 3 * size * size];
        
        let raw_pixels = resized.as_raw();
        let pixel_count = size * size;
        
        for i in 0..pixel_count {
            let base_idx = i * 3;
            if base_idx + 2 < raw_pixels.len() {
                tensor[0 * pixel_count + i] = (raw_pixels[base_idx] as f32 / 255.0 - mean[0]) / std[0];
                tensor[1 * pixel_count + i] = (raw_pixels[base_idx + 1] as f32 / 255.0 - mean[1]) / std[1];
                tensor[2 * pixel_count + i] = (raw_pixels[base_idx + 2] as f32 / 255.0 - mean[2]) / std[2];
            }
        }
        
        Ok(tensor)
    }
    
    /// 批量预处理图像 - 使用多线程并行处理，并支持限制线程数以降低 CPU 占用
    pub fn preprocess_batch(&self, image_paths: &[String], num_threads: usize) -> Result<Vec<Vec<f32>>, String> {
        use rayon::prelude::*;
        
        // 创建一个限制线程数的专门线程池，避免抢占主线程池导致 UI 卡顿
        let pool = rayon::ThreadPoolBuilder::new()
            .num_threads(num_threads)
            .build()
            .map_err(|e| format!("Failed to create thread pool: {}", e))?;
        
        pool.install(|| {
            image_paths
                .par_iter()
                .map(|path| self.preprocess(path))
                .collect::<Result<Vec<_>, _>>()
        })
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
