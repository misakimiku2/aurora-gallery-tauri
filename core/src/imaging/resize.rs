//! 缩放：等比缩到指定最长边。
//!
//! 用途（v2 起）：
//! 1. **图层代理图**——给前端做缩略图（40px 的图层行从 3440px 直接缩是 64 倍降采样，
//!    浏览器会用低质近似，满屏锯齿）；超大图也用它打底。画布本身显示的是**原文件**，
//!    不走这里（设计稿 §4.4）。
//! 2. **文档合成预览**——`editor_render_document` 把合成结果压到 ≤2048 再回传。

use std::num::NonZeroU32;

use fast_image_resize::{FilterType, Image as FirImage, PixelType, ResizeAlg, Resizer};
use image::RgbaImage;

use super::ImageError;

/// 缩放算法取 Lanczos3。
///
/// `src-tauri` 的缩略图用 Hamming（快、略糊，256px 看不出差别）。编辑器不同：用户会
/// 放大到 100% 检查锐度，且缩放结果可能落进文档成为永久字节，质量优先。
const FILTER: FilterType = FilterType::Lanczos3;

/// 等比缩放到最长边 = `max_edge`，不放大。
///
/// 源图最长边已经不超过 `max_edge` 时返回克隆（原样尺寸），这是刻意的：编辑器把「适应
/// 窗口」误算成 300px 时不应该真的把一张 4000px 的图糊成 300px 再存回去。
pub fn resize_to_max_edge(src: &RgbaImage, max_edge: u32) -> Result<RgbaImage, ImageError> {
    let (w, h) = (src.width(), src.height());
    if w == 0 || h == 0 {
        return Err(ImageError::InvalidDimensions(w, h));
    }
    if max_edge == 0 {
        return Err(ImageError::InvalidDimensions(0, 0));
    }

    let longest = w.max(h);
    if longest <= max_edge {
        return Ok(src.clone());
    }

    // 先按长边缩放，再各自四舍五入，最后兜一个 `.max(1)`：极端长宽比（如 8000×3）
    // 缩到 256 时短边算出来是 0.096，四舍五入成 0，`ImageBuffer` 会直接拒绝。
    let scale = max_edge as f64 / longest as f64;
    let dst_w = ((w as f64 * scale).round() as u32).max(1);
    let dst_h = ((h as f64 * scale).round() as u32).max(1);

    resize_exact(src, dst_w, dst_h)
}

/// 缩放到精确尺寸（调用方自己保证宽高比，Phase 1 的自由变换会用）。
fn resize_exact(src: &RgbaImage, dst_w: u32, dst_h: u32) -> Result<RgbaImage, ImageError> {
    let fail = || ImageError::InvalidDimensions(dst_w, dst_h);

    let src_w = NonZeroU32::new(src.width()).ok_or_else(fail)?;
    let src_h = NonZeroU32::new(src.height()).ok_or_else(fail)?;
    let dst_w_nz = NonZeroU32::new(dst_w).ok_or_else(fail)?;
    let dst_h_nz = NonZeroU32::new(dst_h).ok_or_else(fail)?;

    let src_buf = FirImage::from_vec_u8(src_w, src_h, src.as_raw().clone(), PixelType::U8x4)
        .map_err(|e| ImageError::Resize(e.to_string()))?;
    let mut dst_buf = FirImage::new(dst_w_nz, dst_h_nz, PixelType::U8x4);

    Resizer::new(ResizeAlg::Convolution(FILTER))
        .resize(&src_buf.view(), &mut dst_buf.view_mut())
        .map_err(|e| ImageError::Resize(e.to_string()))?;

    RgbaImage::from_raw(dst_w, dst_h, dst_buf.into_vec()).ok_or_else(fail)
}
