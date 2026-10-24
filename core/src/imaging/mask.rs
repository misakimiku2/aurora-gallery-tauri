//! 图层蒙版：把蒙版图的「亮度 × alpha」乘进图层 alpha（白 = 显示 / 黑 = 隐藏）。
//!
//! ## 两端同构（这是本文件的立身之本）
//!
//! 预览端是 CSS `mask-image` + `mask-mode: luminance` + `mask-size: 100% 100%`
//! （`EditorCanvasLayers`），导出端是这里。"看到的 = 导出的"靠三处口径对齐：
//!
//! 1. **蒙版值 = 亮度 × 蒙版自身 alpha**（CSS luminance 模式的定义）：带透明度的
//!    蒙版图，透明处等价于黑。常见灰度 PNG 全不透明，退化为"灰度值即蒙版值"。
//! 2. **亮度系数取 CSS 的 sRGB 系数**（0.2126 / 0.7152 / 0.0722），不是 SDTV 601
//!    的 0.299/0.587/0.114——纯灰蒙版两套系数等价，但没人拦着用户拿彩色图当蒙版，
//!    系数不同时两端会显出不同的灰度。系数直接作用在 gamma 编码的通道值上
//!    （CSS 同款），不做线性化：蒙版是 alpha 图，不是色度计。
//! 3. **拉伸对齐**：蒙版铺满整层内容，尺寸不一致时重采样到图层尺寸——CSS 侧由
//!    `mask-size: 100% 100%` 做，这里用 Triangle（双线性）。两边的重采样核不完全
//!    相同，非同尺寸蒙版在预览/导出间可能有 ±1 级的边缘差；换核请两边一起换。
//!
//! ## 顺序
//!
//! 与不透明度同一个思路（见 `opacity.rs`）：蒙版是**合成前**的 alpha 预处理，
//! 不给 `CompositeLayer` 加字段。链路定死为「调色 → 不透明度 → 蒙版 → 重采样」——
//! 三者都是 alpha/RGB 的逐像素乘法，数学上可交换，定死顺序只是防"顺手优化"。
//!
//! ## 不处理 EXIF 方向
//!
//! CSS 会自动转正带 EXIF 方向的 JPEG 蒙版而这里不转，两端会差一个旋转。
//! 蒙版的预期形态是灰度 PNG（无方向）；真拿带方向的 JPEG 当蒙版属于已知边界，
//! 记在进度文档里，不为此在导出路径上加预处理。

use image::RgbaImage;

use super::decode_file;
use super::ImageError;

/// 蒙版值 = 亮度 × alpha，定点在 0..=65025（255×255）。
///
/// 用整数算（u32 中间量）：两端比对靠的就是"同一个整数"，浮点系数在两处实现里
/// 各自取整一次，误差就再也对不齐了。
fn mask_value(px: &image::Rgba<u8>) -> u32 {
    let luma = (2126 * px[0] as u32 + 7152 * px[1] as u32 + 722 * px[2] as u32 + 5000) / 10000;
    luma * px[3] as u32
}

/// 把 `mask_path` 指到的图片作为蒙版乘进 `image` 的 alpha。
pub fn apply_mask(image: &mut RgbaImage, mask_path: &str) -> Result<(), ImageError> {
    let mask = decode_file(mask_path)?;
    apply_mask_image(image, &mask);
    Ok(())
}

/// 蒙版乘 alpha 的纯内存版（`apply_mask` 解码后走这里，单测也直接喂像素）。
pub fn apply_mask_image(image: &mut RgbaImage, mask: &RgbaImage) {
    let (w, h) = image.dimensions();
    let aligned = if mask.dimensions() == (w, h) {
        mask.clone()
    } else {
        image::imageops::resize(mask, w, h, image::imageops::FilterType::Triangle)
    };
    for (px, m) in image.pixels_mut().zip(aligned.pixels()) {
        let value = mask_value(m);
        if value >= 65025 {
            continue; // 白且不透明 = 不遮：连取整误差都不引入
        }
        if value == 0 {
            px[3] = 0; // 完全遮住：直接清 alpha（RGB 保留，直通 alpha 语义）
            continue;
        }
        // 四舍五入（与 apply_opacity 同口径）：截断会让整层系统性偏暗一档
        px[3] = ((u32::from(px[3]) * value + 65025 / 2) / 65025).min(255) as u8;
    }
}

/// 把 `raster` 的 **alpha** 乘进 `image` 的 alpha（画布空间逐像素，剪贴蒙版用）。
///
/// 与 `apply_mask_image` 的差别：这里吃的是光栅自身的 alpha 通道（剪贴蒙版
/// "上层只显示在基础层有像素处"），不是亮度——PS 两种蒙版的语义分界就在这。
/// 调用方保证两图同尺寸（都是同尺寸画布的 warp 光栅）；`zip` 天然按短边截断，
/// 尺寸不一致时多出的部分不乘（防御，不 panic）。
pub fn apply_alpha_raster(image: &mut RgbaImage, raster: &RgbaImage) {
    for (px, m) in image.pixels_mut().zip(raster.pixels()) {
        let factor = u32::from(m.0[3]);
        if factor >= 255 {
            continue;
        }
        if factor == 0 {
            px[3] = 0;
            continue;
        }
        px[3] = ((u32::from(px[3]) * factor + 127) / 255).min(255) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn filled(w: u32, h: u32, px: [u8; 4]) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for p in img.pixels_mut() {
            *p = Rgba(px);
        }
        img
    }

    #[test]
    fn white_opaque_mask_is_noop() {
        let mut img = filled(2, 2, [10, 200, 30, 77]);
        let mask = filled(2, 2, [255, 255, 255, 255]);
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0, [10, 200, 30, 77], "白蒙版一个像素都不该动");
    }

    #[test]
    fn black_mask_clears_alpha_but_keeps_rgb() {
        // RGB 必须保留：直通 alpha 语义（见 opacity.rs 同名测试），提前清色会让
        // "删掉蒙版"前后的暂存色不一致
        let mut img = filled(2, 2, [10, 200, 30, 200]);
        let mask = filled(2, 2, [0, 0, 0, 255]);
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0, [10, 200, 30, 0]);
    }

    #[test]
    fn half_gray_mask_halves_alpha_with_rounding() {
        // 蒙版 128：255 × (128×255/65025) = 255 × 0.50196… = 128
        let mut img = filled(1, 1, [9, 9, 9, 255]);
        let mask = filled(1, 1, [128, 128, 128, 255]);
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0[3], 128);

        // 200 × 0.50196… = 100.39 → 100（四舍五入；截断也是 100，这条主要防算式改坏）
        let mut img = filled(1, 1, [9, 9, 9, 200]);
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0[3], 100);
    }

    #[test]
    fn luma_uses_css_srgb_coefficients() {
        // 纯红 (255,0,0)：亮度 = 0.2126×255 = 54.2 → 54；蒙版值 = 54×255
        // 图层 alpha 255 → 255 × 54/255 = 54。601 系数（0.299）会得到 76——
        // 这条就是把系数钉在 CSS 那套上的锁。
        let mut img = filled(1, 1, [1, 2, 3, 255]);
        let mask = filled(1, 1, [255, 0, 0, 255]);
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0[3], 54);

        let mut img = filled(1, 1, [1, 2, 3, 255]);
        let mask = filled(1, 1, [0, 255, 0, 255]);
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0[3], 182); // 0.7152×255 = 182.4

        let mut img = filled(1, 1, [1, 2, 3, 255]);
        let mask = filled(1, 1, [0, 0, 255, 255]);
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0[3], 18); // 0.0722×255 = 18.4
    }

    #[test]
    fn mask_alpha_multiplies_like_css_luminance_mode() {
        // 白色但半透明（alpha 128）的蒙版：蒙版值 = 255×128 → 图层 200 × 128/255 ≈ 100.4 → 100
        let mut img = filled(1, 1, [9, 9, 9, 200]);
        let mask = filled(1, 1, [255, 255, 255, 128]);
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0[3], 100);
    }

    #[test]
    fn size_mismatch_stretches_to_layer() {
        // 2×1 蒙版（左白右黑）盖 2×2 图层：竖向拉伸后每列保持一致
        let mut img = filled(2, 2, [9, 9, 9, 255]);
        let mut mask = RgbaImage::new(2, 1);
        mask.put_pixel(0, 0, Rgba([255, 255, 255, 255]));
        mask.put_pixel(1, 0, Rgba([0, 0, 0, 255]));
        apply_mask_image(&mut img, &mask);
        for y in 0..2 {
            assert_eq!(img.get_pixel(0, y).0[3], 255);
            assert_eq!(img.get_pixel(1, y).0[3], 0);
        }
    }

    #[test]
    fn mask_applies_per_pixel_not_uniformly() {
        let mut img = filled(2, 1, [9, 9, 9, 255]);
        let mut mask = RgbaImage::new(2, 1);
        mask.put_pixel(0, 0, Rgba([255, 255, 255, 255]));
        mask.put_pixel(1, 0, Rgba([0, 0, 0, 255]));
        apply_mask_image(&mut img, &mask);
        assert_eq!(img.get_pixel(0, 0).0[3], 255);
        assert_eq!(img.get_pixel(1, 0).0[3], 0);
    }
}
