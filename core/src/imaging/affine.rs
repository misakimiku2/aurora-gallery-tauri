//! 仿射变换与图层合成（图片编辑 Phase 1 收尾 · S3）。
//!
//! 自由变形落地后，图层不再"铺满画布"：它可以缩小、转任意角度、倾斜、超出画布边界。
//! 这意味着裁剪/旋转那种"整块搬像素"的操作不够用了，需要一条**任意仿射**的重采样通道。
//!
//! ## 六参从哪来
//!
//! 本模块**不接受** rotation / flip / scale 这类语义参数，只接受一组六参
//! `[a, b, c, d, e, f]`，顺序与 CSS `matrix(a,b,c,d,e,f)` 完全一致：
//!
//! ```text
//! x' = a·x + c·y + e
//! y' = b·x + d·y + f
//! ```
//!
//! 六参由前端 `layerTransform.ts` 的 `composeMatrix` 算出，**前端与 Rust 用同一组数**。
//! 谁都不再从 rotation/flip 自行推导，于是"两端顺序不一致"这整类 bug 从根上消失
//! （架构事实第 1、3 条：调色被迫把公式写两份再靠单测锁死；变换干脆不写两份）。
//!
//! ## 采样
//!
//! 逆映射 + 双线性。**整数落点直接取最近邻**——90° 旋转、整数平移这类无损操作不该被
//! 插值糊掉（否则"连做十次也不掉画质"这条就不成立了）。这个判断同时让
//! `warp_affine` 的 90° 结果与既有 `rotate_image` **逐像素相等**，旧实现因此成为新实现
//! 的黄金标准。
//!
//! 颜色在**预乘 alpha** 空间插值，避免透明像素周围出现暗边。

use image::RgbaImage;

use super::ImageError;

/// 采样落点判定为"整数"的容差。
///
/// 坐标最大几千，f64 的累积误差在 1e-12 量级，1e-6 足够宽又不会把 0.5 误判成整数。
const INTEGER_EPS: f64 = 1e-6;

/// 采样方式。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sampling {
    /// 最近邻：只取落点最近的那个像素。
    Nearest,
    /// 双线性：周围四点加权。**默认**——自由变形的任意角度靠它才不锯齿。
    #[default]
    Bilinear,
}

/// 二维仿射矩阵，六参顺序与 CSS `matrix(a,b,c,d,e,f)` 一致。
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct AffineMatrix {
    pub a: f64,
    pub b: f64,
    pub c: f64,
    pub d: f64,
    pub e: f64,
    pub f: f64,
}

impl AffineMatrix {
    pub const IDENTITY: AffineMatrix = AffineMatrix { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: 0.0, f: 0.0 };

    /// 从 CSS 顺序的六参构造。
    pub fn from_array(m: [f64; 6]) -> Self {
        AffineMatrix { a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }
    }

    pub fn to_array(self) -> [f64; 6] {
        [self.a, self.b, self.c, self.d, self.e, self.f]
    }

    pub fn translation(x: f64, y: f64) -> Self {
        AffineMatrix { a: 1.0, b: 0.0, c: 0.0, d: 1.0, e: x, f: y }
    }

    /// 线性部分的行列式 a·d − c·b。为 0 时矩阵不可逆（退化成一条线或一个点）。
    pub fn determinant(self) -> f64 {
        self.a * self.d - self.c * self.b
    }

    /// 求逆。行列式绝对值过小时返回 `Err`，而不是产出 NaN 坐标污染整张图。
    pub fn invert(self) -> Result<AffineMatrix, ImageError> {
        let det = self.determinant();
        if det.abs() < 1e-12 {
            return Err(ImageError::DegenerateAffine);
        }
        let inv = 1.0 / det;
        Ok(AffineMatrix {
            a: self.d * inv,
            b: -self.b * inv,
            c: -self.c * inv,
            d: self.a * inv,
            // 平移部分 = −M⁻¹ · t
            e: -(self.d * inv * self.e - self.c * inv * self.f),
            f: -(-self.b * inv * self.e + self.a * inv * self.f),
        })
    }

    /// 正映射一个点（用于算目标区域包围盒）。
    pub fn map_point(self, x: f64, y: f64) -> (f64, f64) {
        (self.a * x + self.c * y + self.e, self.b * x + self.d * y + self.f)
    }
}

/// 画布背景。最小模型只给三档——对应"新建空白文档"对话框里的选项（设计稿 §2）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum CanvasBackground {
    /// 全透明。导出 PNG 时保留 alpha；导出 JPEG 时按黑处理（JPEG 无 alpha）。
    #[default]
    Transparent,
    White,
    Black,
}

/// 待合成的一层。
pub struct CompositeLayer<'a> {
    pub src: &'a RgbaImage,
    pub matrix: AffineMatrix,
}

/// 仿射重采样成一张新图（尺寸由调用方给定，落在外面的部分丢弃）。
pub fn warp_affine(
    src: &RgbaImage,
    dst_w: u32,
    dst_h: u32,
    matrix: AffineMatrix,
    sampling: Sampling,
) -> Result<RgbaImage, ImageError> {
    if dst_w == 0 || dst_h == 0 {
        return Err(ImageError::InvalidDimensions(dst_w, dst_h));
    }
    let mut dst = RgbaImage::new(dst_w, dst_h);
    warp_into(&mut dst, src, matrix, sampling)?;
    Ok(dst)
}

/// 把一层**直接合成到** `dst` 上（src-over）。
///
/// 不做"先重采样成整张画布大的中间图再叠加"：那会为每一层多分配一次全画布缓冲。
/// 这里只遍历该层变换后的包围盒（并与画布求交），越界的部分一个像素都不碰。
pub fn warp_into(
    dst: &mut RgbaImage,
    src: &RgbaImage,
    matrix: AffineMatrix,
    sampling: Sampling,
) -> Result<(), ImageError> {
    if src.width() == 0 || src.height() == 0 {
        return Err(ImageError::InvalidDimensions(src.width(), src.height()));
    }
    let inv = matrix.invert()?;

    let (dst_w, dst_h) = (dst.width() as i64, dst.height() as i64);
    let (sw, sh) = (src.width() as f64, src.height() as f64);

    // 目标区域 = 变换后四角的包围盒 ∩ 画布
    let corners = [
        matrix.map_point(0.0, 0.0),
        matrix.map_point(sw, 0.0),
        matrix.map_point(sw, sh),
        matrix.map_point(0.0, sh),
    ];
    let min_x = corners.iter().map(|p| p.0).fold(f64::INFINITY, f64::min);
    let max_x = corners.iter().map(|p| p.0).fold(f64::NEG_INFINITY, f64::max);
    let min_y = corners.iter().map(|p| p.1).fold(f64::INFINITY, f64::min);
    let max_y = corners.iter().map(|p| p.1).fold(f64::NEG_INFINITY, f64::max);

    let x0 = (min_x.floor() as i64).max(0).min(dst_w);
    let x1 = (max_x.ceil() as i64).max(0).min(dst_w);
    let y0 = (min_y.floor() as i64).max(0).min(dst_h);
    let y1 = (max_y.ceil() as i64).max(0).min(dst_h);

    for dy in y0..y1 {
        for dx in x0..x1 {
            // 目标像素中心 → 源连续坐标 → 源索引空间
            let (px, py) = inv.map_point(dx as f64 + 0.5, dy as f64 + 0.5);
            let u = px - 0.5;
            let v = py - 0.5;

            let sample = match sampling {
                Sampling::Nearest => sample_nearest(src, u.round(), v.round()),
                Sampling::Bilinear => sample_bilinear(src, u, v),
            };
            let Some(sample) = sample else { continue };

            blend_over(dst, dx as u32, dy as u32, sample);
        }
    }
    Ok(())
}

/// 最近邻采样。整数落点用这条，保证无损操作不被插值糊掉。
fn sample_nearest(src: &RgbaImage, ix: f64, iy: f64) -> Option<[f32; 4]> {
    let x = ix as i64;
    let y = iy as i64;
    if x < 0 || y < 0 || x >= src.width() as i64 || y >= src.height() as i64 {
        return None;
    }
    let p = src.get_pixel(x as u32, y as u32).0;
    Some(to_premultiplied([p[0], p[1], p[2], p[3]]))
}

/// 双线性采样。落在源外的采样点不贡献权重，于是边缘天然得到部分覆盖（抗锯齿）。
fn sample_bilinear(src: &RgbaImage, u: f64, v: f64) -> Option<[f32; 4]> {
    // 整数落点直接走最近邻：90° 旋转 / 整数平移不该被插值
    if (u - u.round()).abs() < INTEGER_EPS && (v - v.round()).abs() < INTEGER_EPS {
        return sample_nearest(src, u.round(), v.round());
    }

    let x0 = u.floor();
    let y0 = v.floor();
    let fx = u - x0;
    let fy = v - y0;

    let mut acc = [0f32; 4];
    let mut wsum = 0f32;

    for (oy, wy) in [(0i64, 1.0 - fy), (1, fy)] {
        for (ox, wx) in [(0i64, 1.0 - fx), (1, fx)] {
            let sx = x0 as i64 + ox;
            let sy = y0 as i64 + oy;
            if sx < 0 || sy < 0 || sx >= src.width() as i64 || sy >= src.height() as i64 {
                continue;
            }
            let w = (wx * wy) as f32;
            let p = src.get_pixel(sx as u32, sy as u32).0;
            let c = to_premultiplied(p);
            for i in 0..4 {
                acc[i] += c[i] * w;
            }
            wsum += w;
        }
    }

    if wsum <= 0.0 {
        return None;
    }
    // 按实际权重归一 → 边缘像素的 alpha 变成"被覆盖的比例"
    Some([acc[0] / wsum, acc[1] / wsum, acc[2] / wsum, acc[3] / wsum])
}

/// 直通 alpha → 预乘 alpha（各通道 × alpha）。
fn to_premultiplied(p: [u8; 4]) -> [f32; 4] {
    let a = p[3] as f32 / 255.0;
    [p[0] as f32 * a, p[1] as f32 * a, p[2] as f32 * a, a]
}

/// src-over 合成：**在预乘空间做**，避免半透明边缘出现暗边。
fn blend_over(dst: &mut RgbaImage, x: u32, y: u32, src_premul: [f32; 4]) {
    let d = dst.get_pixel(x, y).0;
    let dst_premul = to_premultiplied(d);
    let a_s = src_premul[3];
    let inv = 1.0 - a_s;

    let out_a = a_s + dst_premul[3] * inv;
    let mut out = [0f32; 4];
    for i in 0..3 {
        out[i] = src_premul[i] + dst_premul[i] * inv;
    }
    out[3] = out_a;

    // 预乘 → 直通。
    //
    // ⚠️ 量纲别混：前三个通道是**预乘后的 0..255**，alpha 是 **0..1**（`to_premultiplied`
    // 的约定）。除回直通色之后，alpha 必须自己 ×255，否则写出去的 alpha 恒为 1。
    let px = if out_a > 1e-6 {
        [out[0] / out_a, out[1] / out_a, out[2] / out_a, out_a * 255.0]
    } else {
        [0.0, 0.0, 0.0, 0.0]
    };
    let to_u8 = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    dst.put_pixel(x, y, image::Rgba([to_u8(px[0]), to_u8(px[1]), to_u8(px[2]), to_u8(px[3])]));
}

/// 建画布并自底向上合成各层。
///
/// 多层已按数组支持（前端可导入多张），当前固定 `Normal` 混合、不透明度 1，循环体很薄；
/// Phase 2 加混合模式与不透明度时只改循环体，调用方不用动。
pub fn composite(
    width: u32,
    height: u32,
    background: CanvasBackground,
    layers: &[CompositeLayer<'_>],
) -> Result<RgbaImage, ImageError> {
    if width == 0 || height == 0 {
        return Err(ImageError::InvalidDimensions(width, height));
    }

    let mut canvas = RgbaImage::new(width, height);
    let fill: [u8; 4] = match background {
        CanvasBackground::Transparent => [0, 0, 0, 0],
        CanvasBackground::White => [255, 255, 255, 255],
        CanvasBackground::Black => [0, 0, 0, 255],
    };
    for p in canvas.pixels_mut() {
        *p = image::Rgba(fill);
    }

    for layer in layers {
        warp_into(&mut canvas, layer.src, layer.matrix, Sampling::Bilinear)?;
    }
    Ok(canvas)
}
