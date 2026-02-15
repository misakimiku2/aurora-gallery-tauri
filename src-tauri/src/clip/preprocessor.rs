//! CLIP 图像和文本预处理器
//! 实现 CLIP 模型的图像和文本预处理

use image::imageops::FilterType;

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
        // 加载图像
        let img = image::open(image_path)
            .map_err(|e| format!("Failed to open image {}: {}", image_path, e))?;
        
        // 调整图像大小
        let resized = img.resize_exact(
            self.target_size as u32,
            self.target_size as u32,
            FilterType::Lanczos3
        );
        
        // 转换为 RGB
        let rgb_img = resized.to_rgb8();
        
        // 提取像素并归一化
        // CLIP 使用 ImageNet 归一化: mean=[0.48145466, 0.4578275, 0.40821073], std=[0.26862954, 0.26130258, 0.27577711]
        let mean = [0.48145466f32, 0.4578275f32, 0.40821073f32];
        let std = [0.26862954f32, 0.26130258f32, 0.27577711f32];
        
        let mut tensor = vec![0.0f32; 3 * self.target_size * self.target_size];
        
        for (i, pixel) in rgb_img.pixels().enumerate() {
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

    /// 获取目标尺寸
    pub fn target_size(&self) -> usize {
        self.target_size
    }
}

/// CLIP 文本预处理器
/// 注意：实际的文本编码使用 tokenizer，在 model.rs 中处理
pub struct TextPreprocessor {
    max_length: usize,
}

impl TextPreprocessor {
    /// 创建新的文本预处理器
    pub fn new() -> Self {
        Self { max_length: 77 }
    }

    /// 预处理文本
    /// 返回 (input_ids, attention_mask)
    /// 注意：这是简化版本，实际处理在 model.rs 中使用 tokenizer 完成
    pub fn preprocess(&self, _text: &str) -> Result<(Vec<i64>, Vec<i64>), String> {
        // 简化版本：返回占位符
        // 实际处理在 model.rs 中使用 tokenizer 完成
        let input_ids = vec![0i64; self.max_length];
        let attention_mask = vec![0i64; self.max_length];
        Ok((input_ids, attention_mask))
    }
}
