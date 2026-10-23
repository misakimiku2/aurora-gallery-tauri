//! 图层不透明度：合成前把 alpha 按百分比缩一遍。
//!
//! ## 为什么在合成前改 alpha，而不是让 `composite` 认识不透明度
//!
//! `composite` 的混合是**直通 alpha 的 src-over**（`blend_over` 先 `to_premultiplied`
//! 再算，最后除回直通）。在直通语义下"整层半透明"等价于"每个像素的 alpha 乘同一个系数"，
//! 所以预处理一遍就够了，不必给 `CompositeLayer` 加字段——那个结构还有别的调用方
//! （封面合成），加一个"只有编辑器会传"的字段只会让它变复杂。
//!
//! 反过来做（在混合里乘）还要考虑重采样插值出来的 alpha，容易把系数乘两遍。
//!
//! ## 顺序
//!
//! **调色之后、重采样之前**。调色只动 RGB 与 alpha 无关（`apply_color_matrix` 保留 alpha），
//! 两者谁先谁后结果一致；定在调色后面是为了让"颜色 → 覆盖度"这条链读起来顺。
//!
//! 代价是每个像素一次 `pixels_mut()` 遍历——这层图本来就要被 `warp_affine` 全量扫一遍，
//! 多一遍可接受。

use image::RgbaImage;

/// 按百分比缩放 alpha。100 = 原样（直接返回，不做任何遍历）。
///
/// 百分比超过 100 按 100 处理：**不做"加深"**，那是混合模式的事。
pub fn apply_opacity(image: &mut RgbaImage, percent: u8) {
    if percent >= 100 {
        return;
    }
    let factor = f32::from(percent) / 100.0;
    for px in image.pixels_mut() {
        // 四舍五入而不是截断：50% 的 255 应该落在 128（127.5 取整），截断会偏暗
        px[3] = (f32::from(px[3]) * factor).round().clamp(0.0, 255.0) as u8;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn image_with(alpha: u8) -> RgbaImage {
        let mut img = RgbaImage::new(2, 2);
        for p in img.pixels_mut() {
            *p = Rgba([200, 100, 50, alpha]);
        }
        img
    }

    #[test]
    fn full_opacity_is_noop() {
        let mut img = image_with(123);
        apply_opacity(&mut img, 100);
        assert_eq!(img.get_pixel(0, 0).0, [200, 100, 50, 123]);
    }

    #[test]
    fn zero_opacity_clears_alpha_but_keeps_rgb() {
        // RGB 必须原样保留：直通 alpha 语义下颜色与覆盖度是两件事，
        // 提前把颜色清零会让"先调到 0 再调回来"产生色差（且不可逆）
        let mut img = image_with(200);
        apply_opacity(&mut img, 0);
        assert_eq!(img.get_pixel(0, 0).0, [200, 100, 50, 0]);
    }

    #[test]
    fn half_opacity_rounds() {
        // 255 × 0.5 = 127.5 → 128（四舍五入）；截断会得到 127，整体偏暗一档
        let mut img = image_with(255);
        apply_opacity(&mut img, 50);
        assert_eq!(img.get_pixel(0, 0).0[3], 128);
    }

    #[test]
    fn over_hundred_is_clamped_to_noop() {
        let mut img = image_with(255);
        apply_opacity(&mut img, 200);
        assert_eq!(img.get_pixel(0, 0).0[3], 255);
    }
}
