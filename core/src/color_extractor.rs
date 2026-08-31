use color_thief::{get_palette, ColorFormat};
use image::DynamicImage;
use palette::{Srgb, FromColor, Lab};

/// 颜色提取结果结构体
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ColorResult {
    pub hex: String,      // 网页常用的 #RRGGBB
    pub rgb: [u8; 3],     // 原始 RGB 数值
    pub lab_l: f32,       // LAB L
    pub lab_a: f32,       // LAB a
    pub lab_b: f32,       // LAB b
    pub is_dark: bool,    // 是否为深色
}



/// 从 DynamicImage 中提取多个主色调
pub fn get_dominant_colors(img: &DynamicImage, count: usize) -> Vec<ColorResult> {
    // 1. 假定输入图片已经被缩放到了合理的尺寸 (如 256px)，不再进行冗余缩放
    
    // 2. 将图片转为 RGBA8 以获取透明度信息
    let rgba_img = img.to_rgba8();
    
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

    // 4. 动态调整采样步长，优化性能
    // 对于主色调提取，quality=10 (即每10个像素采样一个) 已经足够准确，且速度提升极大
    let quality = 10;

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
            
            (color, saturation, luminance, score, index)
        })
        .collect();
    
    // 7. 按综合评分排序，确保占比高的颜色有最高排名，同时兼顾鲜艳度
    colored_palette.sort_by(|a, b| b.3.partial_cmp(&a.3).unwrap_or(std::cmp::Ordering::Equal));
    
    // 8. 格式化所有颜色并返回前count个，同时确保颜色多样性
    // 优化去重：使用哈希表存储已添加颜色的RGB值，减少比较次数
    // 使用临时向量存储(ColorResult, original_index)以便最后按比重排序
    let mut temp_result = Vec::with_capacity(count);
    let mut added_rgb_set: std::collections::HashSet<[u8; 3]> = std::collections::HashSet::with_capacity(count);
    let mut added_labs: Vec<Lab> = Vec::with_capacity(count);
    
    for (color, _, _, _, original_index) in &colored_palette {
        if temp_result.len() >= count {
            break;
        }
        
        // 检查与已添加颜色的差异
        let new_rgb = [color.r, color.g, color.b];
        
        // 快速检查是否完全相同
        if added_rgb_set.contains(&new_rgb) {
            continue;
        }

        // Convert to Lab
        let srgb = Srgb::new(color.r as f32 / 255.0, color.g as f32 / 255.0, color.b as f32 / 255.0);
        let lab: Lab = Lab::from_color(srgb);
        
        let mut is_unique = true;
        
        // 检查与已添加颜色的差异是否足够大 (基于 CIE76 Lab 距离)
        // CIE76 距离阈值，10.0 大约为视觉上明显的差异
        // JND (Just Noticeable Difference) 约为 2.3
        const LAB_DISTANCE_THRESHOLD: f32 = 10.0;
        
        for existing_lab in &added_labs {
            // 计算 CIE76 距离 (欧几里得距离)
            // delta_E = sqrt((L1-L2)^2 + (a1-a2)^2 + (b1-b2)^2)
            let dist_sq = (lab.l - existing_lab.l).powi(2) + 
                          (lab.a - existing_lab.a).powi(2) + 
                          (lab.b - existing_lab.b).powi(2);
            
            if dist_sq < LAB_DISTANCE_THRESHOLD.powi(2) {
                is_unique = false;
                break;
            }
        }
        
        if is_unique {
            let hex = format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b);
            let luminance = 0.299 * color.r as f32 + 0.587 * color.g as f32 + 0.114 * color.b as f32;
            let is_dark = luminance < 128.0;
            
            temp_result.push((ColorResult {
                hex,
                rgb: new_rgb,
                lab_l: lab.l,
                lab_a: lab.a,
                lab_b: lab.b,
                is_dark,
            }, *original_index));
            
            added_rgb_set.insert(new_rgb);
            added_labs.push(lab);
        }
    }
    
    // 如果去重后颜色数量不足，补充一些原始颜色
    if temp_result.len() < count {
        for (color, _, _, _, original_index) in &colored_palette {
            if temp_result.len() >= count {
                break;
            }
            
            let new_rgb = [color.r, color.g, color.b];
            
            // 检查是否已经添加
            if !added_rgb_set.contains(&new_rgb) {
                let hex = format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b);
                let luminance = 0.299 * color.r as f32 + 0.587 * color.g as f32 + 0.114 * color.b as f32;
                let is_dark = luminance < 128.0;

                // Re-calculate Lab
                let srgb = Srgb::new(color.r as f32 / 255.0, color.g as f32 / 255.0, color.b as f32 / 255.0);
                let lab: Lab = Lab::from_color(srgb);
                
                temp_result.push((ColorResult {
                    hex,
                    rgb: new_rgb,
                    lab_l: lab.l,
                    lab_a: lab.a,
                    lab_b: lab.b,
                    is_dark,
                }, *original_index));
                
                added_rgb_set.insert(new_rgb);
            }
        }
    }
    
    // 9. 最后按像素数量统计排序，确保最真实的占比
    // 通过重新扫描缩放后的图片像素，统计每种颜色的像素数量
    let mut pixel_counts: Vec<usize> = vec![0; temp_result.len()];
    
    // 采样步长增大，进一步提升速度
    let step = 10;
    
    // 使用Lab空间距离来计算归属
    // 预计算Srgb->Lab的转换
    let palette_labs: Vec<Lab> = temp_result.iter().map(|(c, _)| {
        let srgb = Srgb::new(c.rgb[0] as f32 / 255.0, c.rgb[1] as f32 / 255.0, c.rgb[2] as f32 / 255.0);
        Lab::from_color(srgb)
    }).collect();
    
    // 遍历像素并归类
    for i in (0..filtered_pixels.len()).step_by(3 * step) {
        if i + 2 >= filtered_pixels.len() { break; }
        
        let r = filtered_pixels[i];
        let g = filtered_pixels[i+1];
        let b = filtered_pixels[i+2];
        
        // 快速过滤：如果三个分量非常接近，通常是中性色
        
        let srgb = Srgb::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
        let pixel_lab: Lab = Lab::from_color(srgb);
        
        let mut min_dist_sq = f32::MAX;
        let mut best_idx = 0;
        
        for (pl_idx, pl) in palette_labs.iter().enumerate() {
            // CIE76 距离平方
            let dl = pl.l - pixel_lab.l;
            let da = pl.a - pixel_lab.a;
            let db = pl.b - pixel_lab.b;
            let dist_sq = dl * dl + da * da + db * db;
            
            if dist_sq < min_dist_sq {
                min_dist_sq = dist_sq;
                best_idx = pl_idx;
            }
        }
        
        pixel_counts[best_idx] += 1;
    }
    
    // 将计数附加到结果上
    let mut final_result: Vec<_> = temp_result.into_iter().enumerate().map(|(i, (c, _))| {
        (c, pixel_counts[i])
    }).collect();
    
    // 按计数降序排序
    final_result.sort_by(|a, b| b.1.cmp(&a.1));
    
    final_result.into_iter().map(|(c, _)| c).collect()
}
