//! 旋转与翻转：纯几何操作，不重采样。
//!
//! 90° 倍数旋转与镜像都是**像素搬移**，不会像插值那样损失锐度——这一点和裁剪一样，
//! 是"连做十次也不掉画质"的前提。
//!
//! ## 处理顺序（与前端、导出共用一套口径）
//!
//! `decode → rotate → flip → crop → resize → encode`
//!
//! 为什么 crop 放在变换**之后**：文档里保存的 `crop` 是**当前可见坐标系**下的矩形。
//! 用户转了一次 90°，他看到的图和新拉出来的裁剪框都在新坐标系里，crop 不必反算；
//! 代价转移到了"旋转那一刻要顺手把已有 crop 换算到新坐标系"（低频操作，一次算完）。
//! 反过来（crop 在前）则需要每次拉框都反算，容易出错且难测试。

use image::RgbaImage;

use super::ImageError;

/// 顺时针旋转角度。只允许 0 / 90 / 180 / 270。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rotation {
    None,
    Cw90,
    Cw180,
    Cw270,
}

impl Rotation {
    pub fn from_degrees(deg: u16) -> Result<Self, ImageError> {
        match deg % 360 {
            0 => Ok(Rotation::None),
            90 => Ok(Rotation::Cw90),
            180 => Ok(Rotation::Cw180),
            270 => Ok(Rotation::Cw270),
            other => Err(ImageError::InvalidRotation(other as u32)),
        }
    }

    /// 旋转后宽高是否互换
    pub fn swaps_axes(self) -> bool {
        matches!(self, Rotation::Cw90 | Rotation::Cw270)
    }
}

/// 顺时针旋转。90°/270° 时宽高互换。
pub fn rotate_image(src: &RgbaImage, rotation: Rotation) -> RgbaImage {
    match rotation {
        Rotation::None => src.clone(),
        Rotation::Cw90 => image::imageops::rotate90(src),
        Rotation::Cw180 => image::imageops::rotate180(src),
        Rotation::Cw270 => image::imageops::rotate270(src),
    }
}

/// 水平/垂直镜像（可同时）。
///
/// 顺序无关：先水平后垂直与先垂直后水平结果相同（两次独立翻转可交换）。
pub fn flip_image(src: &RgbaImage, horizontal: bool, vertical: bool) -> RgbaImage {
    let mut out = src.clone();
    if horizontal {
        out = image::imageops::flip_horizontal(&out);
    }
    if vertical {
        out = image::imageops::flip_vertical(&out);
    }
    out
}
