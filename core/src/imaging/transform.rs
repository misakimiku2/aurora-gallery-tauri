//! 旋转与翻转：纯几何操作，不重采样。
//!
//! 90° 倍数旋转与镜像都是**像素搬移**，不会像插值那样损失锐度——这一点和裁剪一样，
//! 是"连做十次也不掉画质"的前提。
//!
//! ## 现状（2026-10-23 起）
//!
//! v1 的处理顺序 `decode → rotate → flip → crop → resize → encode` **已不再是编辑器
//! 的导出路径**：v2 的自由变换走 `affine::warp_affine`（逆映射 + 双线性），合成走
//! `affine::composite`，顺序是 `解码 → 调色 → 仿射重采样 → 合成 → 编码`。
//!
//! 这三个函数（`rotate_image` / `flip_image`，以及 `crop::crop_image`）保留下来
//! 主要作为**参考实现与黄金标准**：`affine` 的单测断言"用 90° 矩阵重采样的结果必须
//! 与 `rotate_image` 逐像素相等"。既不要在编辑器里再调它们，也别删——那是这套等价
//! 关系的锚点。

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
    // 曾有一个 `swaps_axes()`（判断 90/270 是否交换宽高），全仓零调用连测试都不用它——
    // `rotate_image` 是 match 分支里直接给出宽高的，不需要这个判断。已于 2026-10-23 删除。
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
