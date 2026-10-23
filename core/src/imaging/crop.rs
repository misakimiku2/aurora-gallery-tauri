//! 裁剪：从 RGBA 里切一块出来。
//!
//! 裁剪是**纯几何操作，不改分辨率、不重采样**——切出来的像素与原图逐点相同。
//! v2 编辑器的裁剪已改为非破坏性（只改画布尺寸），本函数不再参与导出/预览，
//! 只作为「真裁像素」的独立工具保留。

use image::RgbaImage;

use super::ImageError;

/// 裁剪矩形（图片像素坐标，左上原点）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl CropRect {
    pub fn new(x: u32, y: u32, w: u32, h: u32) -> Self {
        Self { x, y, w, h }
    }

    /// 整图（无裁剪）。
    pub fn full(width: u32, height: u32) -> Self {
        Self { x: 0, y: 0, w: width, h: height }
    }

    /// 是否恰好等于整图（等于没裁）。
    pub fn is_full(&self, width: u32, height: u32) -> bool {
        self.x == 0 && self.y == 0 && self.w == width && self.h == height
    }
}

/// 按矩形裁剪。
///
/// 边界一律**严格拒绝而非静默截断**：越界说明调用方算错了坐标（前端把 CSS px 当
/// 图片 px、或忘了除掉缩放倍数），静默截断会让"裁出来少一块"这种 bug 极难定位。
pub fn crop_image(src: &RgbaImage, rect: CropRect) -> Result<RgbaImage, ImageError> {
    let (sw, sh) = (src.width(), src.height());
    if rect.w == 0 || rect.h == 0 {
        return Err(ImageError::InvalidDimensions(rect.w, rect.h));
    }
    // 用 u64 相加防止 u32 溢出绕过校验
    let right = rect.x as u64 + rect.w as u64;
    let bottom = rect.y as u64 + rect.h as u64;
    if right > sw as u64 || bottom > sh as u64 {
        return Err(ImageError::CropOutOfBounds {
            x: rect.x,
            y: rect.y,
            w: rect.w,
            h: rect.h,
            src_w: sw,
            src_h: sh,
        });
    }
    Ok(image::imageops::crop_imm(src, rect.x, rect.y, rect.w, rect.h).to_image())
}
