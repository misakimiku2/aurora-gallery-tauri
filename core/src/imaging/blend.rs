//! 图层混合模式（W3C Compositing and Blending 规范的**可分离**模式）。
//!
//! ## 为什么只做可分离这一类
//!
//! PS 那 27 档里，色相 / 饱和度 / 颜色 / 明度四档是**非可分离**的：要先把像素转到
//! HSL，再做 SetSat / SetLum / ClipColor，公式是另外一整套。第一轮只上可分离的那 12 档
//! （含 Normal），非可分离的四档留第二轮——它们的 UI 也一样，只是后端多一层转换。
//!
//! ## 量纲（这是最容易写错的地方）
//!
//! 合成一律在**预乘空间**做，和 `affine::warp_into` 的采样口径一致：
//!
//! - 进来的是 `src_premul`：前三个通道是**预乘后的 0..255**，alpha 是 **0..1**；
//! - 画布上的像素是**直通**的 u8，读进来先转预乘；
//! - 混合函数 `B(Cb, Cs)` 要的是**直通、0..1** 的颜色，所以算之前先除回直通并归一化；
//! - 结果按 W3C 的：
//!   `Co = αs·(1-αb)·Cs + αs·αb·B(Cb, Cs) + (1-αs)·αb·Cb`（预乘、0..1），
//!   `αo = αs + αb·(1-αs)`。
//!
//! 在直通空间里直接混会在半透明边缘发暗——这也是 `blend_over` 一直在预乘空间算的原因。
//! 取 Normal 时上面那组公式正好退化成普通的 src-over（`Co = αs·Cs + (1-αs)·αb·Cb`），
//! 所以这个实现是旧行为的**严格超集**，不会改坏既有导出。

use image::RgbaImage;
use serde::{Deserialize, Serialize};

/// 混合模式。**序列化用 kebab-case 字符串**（`"multiply"`、`"color-dodge"`），
/// 与 CSS 的 `mix-blend-mode` 同名——前端预览直接把它交给 CSS，两端不用再翻译一次。
///
/// serde 的 kebab-case 正好把 `ColorDodge` 映成 `color-dodge`，所以这份枚举可以同时
/// 用在「IPC 载荷」和「`.aurora` 工程文件」上，不用再写一层字符串映射。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlendMode {
    #[default]
    Normal,
    Multiply,
    Screen,
    Overlay,
    Darken,
    Lighten,
    ColorDodge,
    ColorBurn,
    HardLight,
    SoftLight,
    Difference,
    Exclusion,
}

impl BlendMode {
    /// 从字符串解析（认 `color-dodge` 也认 `color_dodge`，大小写不限）。
    ///
    /// **认不出来一律退回 Normal**：工程文件里出现旧版本/拼错的模式名，不该让整份
    /// 文档打不开。要严格报错的话得改存盘版本，代价不划算。
    pub fn parse(raw: &str) -> Self {
        match raw.trim().to_ascii_lowercase().replace('_', "-").as_str() {
            "multiply" => Self::Multiply,
            "screen" => Self::Screen,
            "overlay" => Self::Overlay,
            "darken" => Self::Darken,
            "lighten" => Self::Lighten,
            "color-dodge" => Self::ColorDodge,
            "color-burn" => Self::ColorBurn,
            "hard-light" => Self::HardLight,
            "soft-light" => Self::SoftLight,
            "difference" => Self::Difference,
            "exclusion" => Self::Exclusion,
            _ => Self::Normal,
        }
    }

    /// 写回工程文件时用的名字；与 [`Self::parse`] 是同一套字符串，往返不会漂。
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Normal => "normal",
            Self::Multiply => "multiply",
            Self::Screen => "screen",
            Self::Overlay => "overlay",
            Self::Darken => "darken",
            Self::Lighten => "lighten",
            Self::ColorDodge => "color-dodge",
            Self::ColorBurn => "color-burn",
            Self::HardLight => "hard-light",
            Self::SoftLight => "soft-light",
            Self::Difference => "difference",
            Self::Exclusion => "exclusion",
        }
    }
}

/// 直通 RGBA → 预乘（前三个通道 × alpha，alpha 归到 0..1）。
pub(crate) fn to_premultiplied(p: [u8; 4]) -> [f32; 4] {
    let a = p[3] as f32 / 255.0;
    [p[0] as f32 * a, p[1] as f32 * a, p[2] as f32 * a, a]
}

/// 单通道混合。**输入输出都是直通的 0..1**（`cb` = 下方，`cs` = 上方）。
pub fn blend_channel(mode: BlendMode, cb: f32, cs: f32) -> f32 {
    match mode {
        BlendMode::Normal => cs,
        BlendMode::Multiply => cb * cs,
        BlendMode::Screen => cb + cs - cb * cs,
        // 叠加 = 强光把两个操作数换个位置（规范就是这么定义的）
        BlendMode::Overlay => hard_light(cs, cb),
        BlendMode::Darken => cb.min(cs),
        BlendMode::Lighten => cb.max(cs),
        BlendMode::ColorDodge => {
            if cb <= 0.0 {
                0.0
            } else if cs >= 1.0 {
                1.0
            } else {
                (cb / (1.0 - cs)).min(1.0)
            }
        }
        BlendMode::ColorBurn => {
            if cb >= 1.0 {
                1.0
            } else if cs <= 0.0 {
                0.0
            } else {
                1.0 - ((1.0 - cb) / cs).min(1.0)
            }
        }
        BlendMode::HardLight => hard_light(cb, cs),
        BlendMode::SoftLight => soft_light(cb, cs),
        BlendMode::Difference => (cb - cs).abs(),
        BlendMode::Exclusion => cb + cs - 2.0 * cb * cs,
    }
}

fn hard_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        cb * 2.0 * cs
    } else {
        let d = 2.0 * cs - 1.0;
        cb + d - cb * d
    }
}

fn soft_light(cb: f32, cs: f32) -> f32 {
    if cs <= 0.5 {
        cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb)
    } else {
        // D(Cb)：规范给的分段函数，Cb > 0.25 就是开方
        let d = if cb <= 0.25 {
            ((16.0 * cb - 12.0) * cb + 4.0) * cb
        } else {
            cb.sqrt()
        };
        cb + (2.0 * cs - 1.0) * (d - cb)
    }
}

/// 把一个已采样好的源像素按混合模式合成到画布上。
///
/// `src_premul` 口径同 `affine::sample_bilinear`：预乘的 0..255 + alpha 的 0..1。
pub(crate) fn blend_over(
    dst: &mut RgbaImage,
    x: u32,
    y: u32,
    src_premul: [f32; 4],
    mode: BlendMode,
) {
    let d = dst.get_pixel(x, y).0;
    let dst_premul = to_premultiplied(d);
    let a_s = src_premul[3];
    let a_b = dst_premul[3];
    let out_a = a_s + a_b * (1.0 - a_s);

    let mut out = [0f32; 4];
    if mode == BlendMode::Normal {
        // 退化成普通 src-over：这条捷径保证既有导出结果**逐字节不变**
        for i in 0..3 {
            out[i] = src_premul[i] + dst_premul[i] * (1.0 - a_s);
        }
    } else {
        // 预乘 → 直通 0..1，交给混合函数；结果再乘回预乘并按 alpha 加权
        let un = |v: f32, a: f32| if a > 1e-6 { (v / a) / 255.0 } else { 0.0 };
        let cb = [
            un(dst_premul[0], a_b),
            un(dst_premul[1], a_b),
            un(dst_premul[2], a_b),
        ];
        let cs = [
            un(src_premul[0], a_s),
            un(src_premul[1], a_s),
            un(src_premul[2], a_s),
        ];
        for i in 0..3 {
            let blended = blend_channel(mode, cb[i], cs[i]);
            // Co（预乘、0..1）→ 输出口径（预乘、0..255）
            let co = a_s * (1.0 - a_b) * cs[i] + a_s * a_b * blended + (1.0 - a_s) * a_b * cb[i];
            out[i] = co * 255.0;
        }
    }
    out[3] = out_a;

    // 预乘 → 直通。
    //
    // ⚠️ 量纲别混：前三个通道是**预乘后的 0..255**，alpha 是 **0..1**。
    // 除回直通色之后，alpha 必须自己 ×255，否则写出去的 alpha 恒为 1。
    let px = if out_a > 1e-6 {
        [out[0] / out_a, out[1] / out_a, out[2] / out_a, out_a * 255.0]
    } else {
        [0.0, 0.0, 0.0, 0.0]
    };
    let to_u8 = |v: f32| v.round().clamp(0.0, 255.0) as u8;
    dst.put_pixel(x, y, image::Rgba([to_u8(px[0]), to_u8(px[1]), to_u8(px[2]), to_u8(px[3])]));
}

#[cfg(test)]
mod tests {
    use super::*;

    const ALL: [BlendMode; 12] = [
        BlendMode::Normal,
        BlendMode::Multiply,
        BlendMode::Screen,
        BlendMode::Overlay,
        BlendMode::Darken,
        BlendMode::Lighten,
        BlendMode::ColorDodge,
        BlendMode::ColorBurn,
        BlendMode::HardLight,
        BlendMode::SoftLight,
        BlendMode::Difference,
        BlendMode::Exclusion,
    ];

    fn approx(a: f32, b: f32) -> bool {
        (a - b).abs() < 1e-5
    }

    #[test]
    fn parse_and_as_str_round_trip() {
        for mode in ALL {
            assert_eq!(BlendMode::parse(mode.as_str()), mode);
            // 大小写与下划线都认（工程文件里两种写法都可能出现）
            assert_eq!(BlendMode::parse(&mode.as_str().replace('-', "_")), mode);
            assert_eq!(BlendMode::parse(&mode.as_str().to_uppercase()), mode);
        }
    }

    #[test]
    fn unknown_name_falls_back_to_normal() {
        // 认不出来的模式不该让文档打不开
        assert_eq!(BlendMode::parse("溶解"), BlendMode::Normal);
        assert_eq!(BlendMode::parse("hue"), BlendMode::Normal);
        assert_eq!(BlendMode::parse(""), BlendMode::Normal);
    }

    /// 一组手算的采样值，锁死公式（改公式时这里必须跟着改，不能靠"看着对"）。
    #[test]
    fn channel_formulas_match_the_spec() {
        let (cb, cs) = (0.5f32, 0.25f32);
        let cases: [(BlendMode, f32); 12] = [
            (BlendMode::Normal, 0.25),
            (BlendMode::Multiply, 0.125),
            (BlendMode::Screen, 0.625),
            // 叠加 = hard_light(cs, cb) = hard_light(0.25, 0.5)：cs<=0.5 → cb*2*cs
            (BlendMode::Overlay, 0.25),
            (BlendMode::Darken, 0.25),
            (BlendMode::Lighten, 0.5),
            (BlendMode::ColorDodge, 0.5 / 0.75),
            // 颜色加深：1 - min(1, (1-Cb)/Cs) = 1 - min(1, 2.0) = 0
            (BlendMode::ColorBurn, 0.0),
            (BlendMode::HardLight, 0.25),
            (BlendMode::SoftLight, 0.375),
            (BlendMode::Difference, 0.25),
            (BlendMode::Exclusion, 0.5),
        ];
        for (mode, want) in cases {
            let got = blend_channel(mode, cb, cs);
            assert!(approx(got, want), "{mode:?}: {got} != {want}");
        }
    }

    #[test]
    fn hard_light_symmetric_with_overlay() {
        // overlay(cb, cs) == hard_light(cs, cb)，规范定义如此
        assert!(approx(
            blend_channel(BlendMode::Overlay, 0.5, 0.25),
            blend_channel(BlendMode::HardLight, 0.25, 0.5),
        ));
    }

    #[test]
    fn normal_is_the_identity_of_blending() {
        // 所有模式在"下方全透明"时都应退化成直接把源放上去：
        // 这条靠 composite 层测（见 mod.rs），这里只保证 Normal 就是源色
        assert!(approx(blend_channel(BlendMode::Normal, 0.9, 0.1), 0.1));
    }
}
