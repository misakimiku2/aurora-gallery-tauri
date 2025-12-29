use color_thief::{get_palette, ColorFormat};
use image::DynamicImage;

/// 颜色提取结果结构体
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ColorResult {
    pub hex: String,      // 网页常用的 #RRGGBB
    pub rgb: [u8; 3],     // 原始 RGB 数值
    pub is_dark: bool,    // 是否为深色
}



/// 从 DynamicImage 中提取多个主色调
pub fn get_dominant_colors(img: &DynamicImage, count: usize) -> Vec<ColorResult> {
    // 1. 将图片转为 RGBA8 以获取透明度信息
    // 注意：现在由调用者负责提供适当大小的图像（通常是缩略图）
    let rgba_img = img.to_rgba8();
    
    // 2. 执行像素预过滤
    let filtered_pixels: Vec<u8> = rgba_img
        .pixels()
        .filter_map(|p| {
            let [r, g, b, a] = p.0;

            // 条件 A: 过滤透明像素 (Alpha < 125)
            if a < 125 {
                return None;
            }

            // 条件 B: 过滤接近白色的像素 (R,G,B 均 > 250)
            if r > 250 && g > 250 && b > 250 {
                return None;
            }

            Some(vec![r, g, b])
        })
        .flatten()
        .collect();

    if filtered_pixels.is_empty() {
        return Vec::new();
    }

    // 3. 调用 ColorThief 算法提取颜色
    // 使用采样步长1（采样所有像素）以确保不会遗漏明显的颜色，特别是小区域的明显颜色如红色
    // 提取稍多一些颜色(16个)以确保有足够的候选，包括鲜艳的小面积颜色
    let request_count = (count + 8).min(20).max(count);
    let count_u8 = request_count.min(255) as u8;
    let palette = match get_palette(&filtered_pixels, ColorFormat::Rgb, 1, count_u8) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    // 4. 改进的颜色选择逻辑：考虑颜色的频率为主，饱和度为辅
    // 为每个颜色计算饱和度，并按频率和饱和度的综合评分排序
    let mut colored_palette: Vec<_> = palette
        .iter()
        .enumerate()
        .map(|(index, color)| {
            // 计算 RGB 值的浮点表示 (0.0-1.0)
            let r = color.r as f32 / 255.0;
            let g = color.g as f32 / 255.0;
            let b = color.b as f32 / 255.0;
            
            // 计算颜色的亮度
            let luminance = 0.299 * r + 0.587 * g + 0.114 * b;
            
            // 计算颜色的最大值和最小值
            let max = r.max(g).max(b);
            let min = r.min(g).min(b);
            
            // 计算饱和度
            let saturation = if max == min {
                0.0
            } else {
                (max - min) / (1.0 - (2.0 * luminance - 1.0).abs())
            };
            
            // 综合评分：频率权重(0.8) + 饱和度权重(0.2)
            // 降低指数衰减的频率权重，确保占比高的颜色（如深色头发）仍然有最高权重
            // 这样可以确保占比最多的#3D3634颜色不会被忽略
            let frequency_weight = 1.0 / ((index as f32 + 1.0).powf(0.25));
            let score = (frequency_weight * 0.8) + (saturation * 0.2);
            
            (color, saturation, luminance, score)
        })
        .collect();
    
    // 5. 按综合评分排序，确保占比高的颜色有最高排名，同时兼顾鲜艳度
    colored_palette.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
    
    // 6. 格式化所有颜色并返回前count个，同时确保颜色多样性
    // 简单去重：确保返回的颜色之间有足够的差异
    let mut result = Vec::new();
    let mut added_colors: Vec<[u8; 3]> = Vec::new();
    
    for (color, _, _, _) in &colored_palette {
        if result.len() >= count {
            break;
        }
        
        // 检查与已添加颜色的差异
        let new_rgb = [color.r, color.g, color.b];
        let mut is_unique = true;
        
        for existing in &added_colors {
            // 计算颜色差异
            let diff = (
                (new_rgb[0] as i32 - existing[0] as i32).abs() +
                (new_rgb[1] as i32 - existing[1] as i32).abs() +
                (new_rgb[2] as i32 - existing[2] as i32).abs()
            ) as u32;
            
            // 如果差异太小，跳过这个颜色
            if diff < 30 {
                is_unique = false;
                break;
            }
        }
        
        if is_unique {
            let hex = format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b);
            let luminance = 0.299 * color.r as f32 + 0.587 * color.g as f32 + 0.114 * color.b as f32;
            let is_dark = luminance < 128.0;
            
            result.push(ColorResult {
                hex,
                rgb: [color.r, color.g, color.b],
                is_dark,
            });
            
            added_colors.push(new_rgb);
        }
    }
    
    // 如果去重后颜色数量不足，补充一些原始颜色
    if result.len() < count {
        for (color, _, _, _) in &colored_palette {
            if result.len() >= count {
                break;
            }
            
            let hex = format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b);
            let luminance = 0.299 * color.r as f32 + 0.587 * color.g as f32 + 0.114 * color.b as f32;
            let is_dark = luminance < 128.0;
            
            // 检查是否已经添加
            if !result.iter().any(|c| c.hex == hex) {
                result.push(ColorResult {
                    hex,
                    rgb: [color.r, color.g, color.b],
                    is_dark,
                });
            }
        }
    }
    
    result
}