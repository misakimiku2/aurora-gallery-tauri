use color_thief::{get_palette, ColorFormat};
use image::{DynamicImage, GenericImageView};

/// 颜色提取结果结构体
#[derive(Debug, serde::Serialize, serde::Deserialize, Clone)]
pub struct ColorResult {
    pub hex: String,      // 网页常用的 #RRGGBB
    pub rgb: [u8; 3],     // 原始 RGB 数值
    pub is_dark: bool,    // 是否为深色
}

/// 从 DynamicImage 中提取主色调 (完全对齐 JS 版过滤逻辑)
pub fn get_dominant_color(img: &DynamicImage) -> Option<ColorResult> {
    // 1. 将图片转为 RGBA8 以获取透明度信息
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
        return None;
    }

    // 3. 调用 ColorThief 算法 (采样步长 10, 提取颜色数 5)
    let palette = get_palette(&filtered_pixels, ColorFormat::Rgb, 10, 5).ok()?;

    // 4. 获取最主导的颜色
    let color = palette.first()?;
    
    // 5. 格式化输出与深浅色判断
    let hex = format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b);
    let luminance = 0.299 * color.r as f32 + 0.587 * color.g as f32 + 0.114 * color.b as f32;
    let is_dark = luminance < 128.0;

    Some(ColorResult {
        hex,
        rgb: [color.r, color.g, color.b],
        is_dark,
    })
}

/// 从 DynamicImage 中提取8个主色调
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
    // 提取稍多一些颜色(12个)以确保有足够的候选，然后取前count个
    let request_count = (count + 4).min(16).max(count);
    let count_u8 = request_count.min(255) as u8;
    let palette = match get_palette(&filtered_pixels, ColorFormat::Rgb, 1, count_u8) {
        Ok(p) => p,
        Err(_) => return Vec::new(),
    };

    // 4. 格式化所有颜色并返回前count个
    palette
        .iter()
        .take(count)  // 确保只返回请求的数量
        .map(|color| {
            let hex = format!("#{:02x}{:02x}{:02x}", color.r, color.g, color.b);
            let luminance = 0.299 * color.r as f32 + 0.587 * color.g as f32 + 0.114 * color.b as f32;
            let is_dark = luminance < 128.0;

            ColorResult {
                hex,
                rgb: [color.r, color.g, color.b],
                is_dark,
            }
        })
        .collect()
}