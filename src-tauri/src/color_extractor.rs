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
    // 1. 限制图片最大尺寸为512x512，减少像素数量
    let max_dimension = 512;
    let resized_img = if img.width() > max_dimension || img.height() > max_dimension {
        img.resize(max_dimension, max_dimension, image::imageops::FilterType::Triangle)
    } else {
        img.clone()
    };
    
    // 2. 将图片转为 RGBA8 以获取透明度信息
    let rgba_img = resized_img.to_rgba8();
    
    // 3. 执行像素预过滤，优化版本：减少中间数据结构
    let mut filtered_pixels = Vec::with_capacity(rgba_img.width() as usize * rgba_img.height() as usize * 3);
    for p in rgba_img.pixels() {
        let [r, g, b, a] = p.0;

        // 条件 A: 过滤透明像素 (Alpha < 125)
        if a < 125 {
            continue;
        }

        // 条件 B: 过滤接近白色的像素 (R,G,B 均 > 250)
        if r > 250 && g > 250 && b > 250 {
            continue;
        }

        // 直接添加到结果向量，避免中间vec和flatten操作
        filtered_pixels.push(r);
        filtered_pixels.push(g);
        filtered_pixels.push(b);
    }

    if filtered_pixels.is_empty() {
        return Vec::new();
    }

    // 4. 动态调整采样步长，根据图片尺寸优化性能
    let image_area = (rgba_img.width() * rgba_img.height()) as usize;
    let quality = match image_area {
        0..=65536 => 1,       // 小图片 (<=256x256): 步长1
        65537..=262144 => 2,   // 中图片 (257x257-512x512): 步长2
        _ => 4,                // 大图片 (>512x512): 步长4
    };

    // 5. 调用 ColorThief 算法提取颜色
    // 提取稍多一些颜色(16个)以确保有足够的候选，包括鲜艳的小面积颜色
    let request_count = (count + 8).min(20).max(count);
    let count_u8 = request_count.min(255) as u8;
    let palette = match get_palette(&filtered_pixels, ColorFormat::Rgb, quality, count_u8) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    // 6. 改进的颜色选择逻辑：考虑颜色的频率为主，饱和度为辅
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
            let score = (frequency_weight * 0.7) + (saturation * 0.3);
            
            (color, saturation, luminance, score)
        })
        .collect();
    
    // 7. 按综合评分排序，确保占比高的颜色有最高排名，同时兼顾鲜艳度
    colored_palette.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
    
    // 8. 格式化所有颜色并返回前count个，同时确保颜色多样性
    // 优化去重：使用哈希表存储已添加颜色的RGB值，减少比较次数
    let mut result = Vec::with_capacity(count);
    let mut added_colors: std::collections::HashSet<[u8; 3]> = std::collections::HashSet::with_capacity(count);
    
    for (color, _, _, _) in &colored_palette {
        if result.len() >= count {
            break;
        }
        
        // 检查与已添加颜色的差异
        let new_rgb = [color.r, color.g, color.b];
        let mut is_unique = true;
        
        // 快速检查是否完全相同
        if added_colors.contains(&new_rgb) {
            continue;
        }
        
        // 检查与已添加颜色的差异是否足够大
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
                rgb: new_rgb,
                is_dark,
            });
            
            added_colors.insert(new_rgb);
        }
    }
    
    // 如果去重后颜色数量不足，补充一些原始颜色
    if result.len() < count {
        for (color, _, _, _) in &colored_palette {
            if result.len() >= count {
                break;
            }
            
            let new_rgb = [color.r, color.g, color.b];
            let hex = format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b);
            
            // 检查是否已经添加
            if !added_colors.contains(&new_rgb) {
                let luminance = 0.299 * color.r as f32 + 0.587 * color.g as f32 + 0.114 * color.b as f32;
                let is_dark = luminance < 128.0;
                
                result.push(ColorResult {
                    hex,
                    rgb: new_rgb,
                    is_dark,
                });
                
                added_colors.insert(new_rgb);
            }
        }
    }
    
    result
}