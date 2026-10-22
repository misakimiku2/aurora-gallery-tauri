//! 调色：亮度 / 对比度 / 饱和度 / 色温。
//!
//! ## 为什么是一套颜色矩阵
//!
//! 这四种调整都是**线性操作**（逐通道乘加），所以可以合成成"一个 3×3 矩阵 + 一个偏移"。
//! 这么做不是为了炫技，是为了**所见即所得**：
//!
//! - 前端预览走 SVG `feColorMatrix`（GPU 加速，拖动时跟手）
//! - 导出走这里的逐像素乘加
//!
//! 两端**必须算出同一个矩阵**，否则用户会看到"预览是暖的、导出是冷的"。所以：
//! 公式只写一份（本文件），前端 TS 侧照着移植，两边用同一组采样值做单测锁死。
//!
//! ## 参数口径
//!
//! 四个参数都是 `-100 ..= 100`，0 = 不变。内部归一到 `-1 ..= 1` 再构造函数。
//! 处理顺序固定：**亮度 → 对比度 → 饱和度 → 色温**，换顺序会得到不同的结果
//! （矩阵不满足交换律），所以写进文档也写进测试。
//!
//! ## 各参数的数学
//!
//! - 亮度：增益 `1 + p`（p=1 时通道翻倍，p=-1 时全黑）。**乘法不是加法** —— CSS
//!   `brightness()` 也是乘法，用加法会让预览和导出的暗部走向完全相反。
//! - 对比度：绕中灰 `0.5` 缩放，`v' = (v - 0.5) * c + 0.5`，`c = 1 + p`
//! - 饱和度：以亮度为轴的线性插值（标准 W3C saturate 矩阵），`s = 1 + p`
//! - 色温：暖 `+` 抬红压蓝、冷 `-` 相反，绿通道不动。这是一种**近似**的色温，
//!   不做黑体轨迹换算 —— 修截图要的是"偏暖/偏冷"的方向感，不是色度学精度。

use image::RgbaImage;

/// 3×3 颜色矩阵 + 偏移（偏移量以 0–255 为单位，与 SVG feColorMatrix 的行向量对齐）。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ColorMatrix {
    pub m: [[f32; 3]; 3],
    pub offset: [f32; 3],
}

impl ColorMatrix {
    pub const fn identity() -> Self {
        Self {
            m: [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]],
            offset: [0.0, 0.0, 0.0],
        }
    }

    /// 先应用 `self`，再应用 `next`（等价于矩阵左乘）。
    pub fn then(&self, next: &Self) -> Self {
        let mut m = [[0.0f32; 3]; 3];
        for (r, row) in m.iter_mut().enumerate() {
            for (c, cell) in row.iter_mut().enumerate() {
                *cell = (0..3).map(|k| next.m[r][k] * self.m[k][c]).sum();
            }
        }
        let offset = [
            (0..3).map(|k| next.m[0][k] * self.offset[k]).sum::<f32>() + next.offset[0],
            (0..3).map(|k| next.m[1][k] * self.offset[k]).sum::<f32>() + next.offset[1],
            (0..3).map(|k| next.m[2][k] * self.offset[k]).sum::<f32>() + next.offset[2],
        ];
        Self { m, offset }
    }

    /// 亮度：增益（乘法）
    pub fn brightness(p: f32) -> Self {
        let g = 1.0 + p;
        Self {
            m: [[g, 0.0, 0.0], [0.0, g, 0.0], [0.0, 0.0, g]],
            offset: [0.0, 0.0, 0.0],
        }
    }

    /// 对比度：绕中灰缩放
    pub fn contrast(p: f32) -> Self {
        let c = 1.0 + p;
        let off = 127.5 * (1.0 - c); // = 0.5*(1-c)*255
        Self {
            m: [[c, 0.0, 0.0], [0.0, c, 0.0], [0.0, 0.0, c]],
            offset: [off, off, off],
        }
    }

    /// 饱和度：以亮度为轴插值（W3C filter 规范里的 saturate 矩阵）
    pub fn saturation(p: f32) -> Self {
        let s = 1.0 + p;
        const LR: f32 = 0.213;
        const LG: f32 = 0.715;
        const LB: f32 = 0.072;
        Self {
            m: [
                [LR + (1.0 - LR) * s, LG - LG * s, LB - LB * s],
                [LR - LR * s, LG + (1.0 - LG) * s, LB - LB * s],
                [LR - LR * s, LG - LG * s, LB + (1.0 - LB) * s],
            ],
            offset: [0.0, 0.0, 0.0],
        }
    }

    /// 色温：暖调抬红压蓝，冷调相反（绿通道保持，避免整体偏色到洋红/绿）
    pub fn temperature(p: f32) -> Self {
        // ±0.3 是手感上限：再大就开始像加了色片而不是"色温"
        let t = p * 0.3;
        Self {
            m: [[1.0 + t, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0 - t]],
            offset: [0.0, 0.0, 0.0],
        }
    }

    /// 按固定顺序合成：亮度 → 对比度 → 饱和度 → 色温
    pub fn from_adjustments(brightness: f32, contrast: f32, saturation: f32, temperature: f32) -> Self {
        Self::brightness(brightness)
            .then(&Self::contrast(contrast))
            .then(&Self::saturation(saturation))
            .then(&Self::temperature(temperature))
    }
}

/// 参数是否全为 0（全 0 时应当**原样返回**，一个像素都不碰）。
pub fn is_identity_adjustment(b: f32, c: f32, s: f32, t: f32) -> bool {
    b == 0.0 && c == 0.0 && s == 0.0 && t == 0.0
}

/// 对整幅图应用颜色矩阵。alpha 通道保持不变。
pub fn apply_color_matrix(src: &RgbaImage, matrix: &ColorMatrix) -> RgbaImage {
    let mut out = src.clone();
    let m = &matrix.m;
    let off = &matrix.offset;
    for px in out.pixels_mut() {
        let [r, g, b, a] = px.0;
        let (rf, gf, bf) = (r as f32, g as f32, b as f32);
        let nr = m[0][0] * rf + m[0][1] * gf + m[0][2] * bf + off[0];
        let ng = m[1][0] * rf + m[1][1] * gf + m[1][2] * bf + off[1];
        let nb = m[2][0] * rf + m[2][1] * gf + m[2][2] * bf + off[2];
        px.0 = [clamp_u8(nr), clamp_u8(ng), clamp_u8(nb), a];
    }
    out
}

#[inline]
fn clamp_u8(v: f32) -> u8 {
    if v <= 0.0 {
        0
    } else if v >= 255.0 {
        255
    } else {
        v.round() as u8
    }
}
