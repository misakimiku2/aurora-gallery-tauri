//! 编码：RGBA8 → 字节。
//!
//! 一条铁律写在类型里：**文档存储只能用无损**，有损只用于导出。设计方案 §4.5 的
//! 不变式是「不得损失导出画质」——用户把图导出去，导出的那个文件可以有损；但 `.aurora`
//! 里的图层字节不能。两者共用一套文案与滑杆，是 UI 设计文档 §7.3 专门点出来要防的误解。

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::PngEncoder;
use image::codecs::webp::WebPEncoder;
use image::{ColorType, ImageEncoder, RgbaImage};

use super::ImageError;

/// 编码目标格式。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EncodeFormat {
    /// WebP 无损（VP8L）。**文档存储的唯一格式**。
    ///
    /// 走 `image` 自带的纯 Rust VP8L 编码器（`WebPEncoder::new_lossless`），不需要
    /// `webp` crate 或 libwebp——`write_to(ImageFormat::WebP)` 走的也是同一条路径。
    WebpLossless,
    /// PNG。无损但体积约为 WebP 无损的数倍，留给「必须 PNG」的导出场景。
    Png,
    /// JPEG。**有损，只能导出，不得用于文档存储**。
    Jpeg,
}

/// 编码为字节。`quality` 仅对 [`EncodeFormat::Jpeg`] 生效（钳到 1–100），其余忽略。
pub fn encode(rgba: &RgbaImage, format: EncodeFormat, quality: u8) -> Result<Vec<u8>, ImageError> {
    let (w, h) = (rgba.width(), rgba.height());
    if w == 0 || h == 0 {
        return Err(ImageError::InvalidDimensions(w, h));
    }

    let mut out = Cursor::new(Vec::new());
    match format {
        EncodeFormat::WebpLossless => {
            WebPEncoder::new_lossless(&mut out)
                .write_image(rgba.as_raw(), w, h, ColorType::Rgba8)
                .map_err(|e| ImageError::Encode(format!("WebP: {e}")))?;
        }
        EncodeFormat::Png => {
            PngEncoder::new(&mut out)
                .write_image(rgba.as_raw(), w, h, ColorType::Rgba8)
                .map_err(|e| ImageError::Encode(format!("PNG: {e}")))?;
        }
        EncodeFormat::Jpeg => {
            // JPEG 没有 alpha 通道，必须先摊成 RGB8。不用
            // `DynamicImage::ImageRgba8(rgba.clone()).to_rgb8()`——那会整图克隆一次
            // （RGBA 每像素 4 字节），编辑器的 8000×8000 图层上就是白多 256 MB。
            let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
            for px in rgba.pixels() {
                rgb.extend_from_slice(&px.0[..3]);
            }
            let q = quality.clamp(1, 100);
            JpegEncoder::new_with_quality(&mut out, q)
                .encode(&rgb, w, h, ColorType::Rgb8)
                .map_err(|e| ImageError::Encode(format!("JPEG: {e}")))?;
        }
    }

    Ok(out.into_inner())
}
