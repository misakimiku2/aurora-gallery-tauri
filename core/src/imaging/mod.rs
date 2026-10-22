//! 编辑器像素通道（图片编辑 Phase 0）。
//!
//! 依据 `docs/图片编辑与封面合成-设计方案.md` §6.1「统一 decode → RGBA → transform →
//! encode 通道」建立。在此之前，解码与编码散在 `src-tauri` 侧十余处（桌面缩略图、安卓
//! 缩略图、安卓预览、取色、抽帧各写各的 `image::load_from_memory` + `write_to`），
//! 编辑器若照这套写法，每加一个功能都要再抄一遍格式判定与质量常量。本模块把这条流水线
//! 收成三个入口，编辑器只认这三个。
//!
//! ## 只服务编辑器，不接管既有链路
//!
//! `src-tauri` 那十几处调用**继续原地不动**：它们各自绑定自己的缓存目录、质量常量与
//! 错误语义（安卓缩略图的 WebP/JPEG 分流、取色的降采样、抽帧的失败回退），整体迁移的
//! 收益抵不上回归风险。Phase 0 的唯一消费者是 `ffi::generate_thumbnail`——用它证明通道
//! 真的跑通，其余等各自模块该动的时候再迁。
//!
//! ## 为什么不叫 `image`
//!
//! 设计方案写的是 `core/image/`，落地改名 `imaging`：`image` 是 core 已依赖的 crate 名，
//! crate 根再挂一个同名模块会让全 crate 的 `use image::...` 变成 E0659 歧义，要么每个
//! 文件改写成 `::image::`，要么改掉既有调用点——代价大于「跟文档同名」这点好处。
//!
//! ## 像素不进 WebView
//!
//! 设计方案 §3.1：全分辨率像素只在 Rust 侧存在。这里的 `image::RgbaImage` 是进程内
//! 中间态，不跨 FFI 边界；进出 WebView 的只能是代理图或最终产物字节。
//!
//! ## 格式口径（Phase 0 拍板：avif / svg / jxl 排除）
//!
//! `image` 0.24 的默认 feature 覆盖 jpeg/png/gif/webp/bmp/tiff/ico（另有 tga/pnm/hdr/
//! dds/qoi，但库里不会有），avif/svg/jxl 三者都要额外依赖才能解：avif 要 AV1 解码器，
//! jxl 要 JPEG XL 绑定，svg 是矢量图——栅格化先得定 DPI 语义，与「内部统一 8-bit
//! RGBA」直接冲突。共同代价是往 core 塞一份 C/复杂依赖，换来的只是「少数几张图能拖进
//! 编辑器」。故 Phase 0 明确排除，见 `decode::EDITOR_EXCLUDED_EXTENSIONS`。
//!
//! 注意排除只针对**编辑器入口**：入库扫描的 `file_types::SUPPORTED_IMAGE_EXTENSIONS`
//! 仍然识别 avif/svg/jxl（它们在画廊里照常显示，只是不能进编辑器）。

mod adjust;
mod crop;
mod decode;
mod encode;
mod resize;
mod transform;

pub use adjust::{
    apply_color_matrix, is_identity_adjustment, ColorMatrix,
};
pub use crop::{crop_image, CropRect};
pub use decode::{
    decode_bytes, decode_file, is_excluded_extension, EDITOR_DECODABLE_EXTENSIONS,
    EDITOR_EXCLUDED_EXTENSIONS,
};
pub use encode::{encode, EncodeFormat};
pub use resize::resize_to_max_edge;
pub use transform::{flip_image, rotate_image, Rotation};

use thiserror::Error;

/// 像素通道错误。
///
/// 不复用 `ffi::AuroraError`：本模块被 `ffi` 使用（`generate_thumbnail` 走通道），反向
/// 依赖会成环；且 `AuroraError` 是 UniFFI 导出类型，把解码细节塞进去只会把它撑肿。
#[derive(Debug, Error)]
pub enum ImageError {
    #[error("解码失败: {0}")]
    Decode(String),
    #[error("缩放失败: {0}")]
    Resize(String),
    #[error("编码失败: {0}")]
    Encode(String),
    #[error("编辑器不支持该格式: {0}")]
    UnsupportedFormat(String),
    #[error("图像尺寸无效: {0}×{1}")]
    InvalidDimensions(u32, u32),
    #[error("裁剪区域超出图像范围: {x},{y} {w}×{h}（源图 {src_w}×{src_h}）")]
    CropOutOfBounds {
        x: u32,
        y: u32,
        w: u32,
        h: u32,
        src_w: u32,
        src_h: u32,
    },
    #[error("旋转角度无效: {0}°（只支持 0 / 90 / 180 / 270）")]
    InvalidRotation(u32),
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 造一张带渐变的 RGBA 测试图（纯内存，不依赖任何外部素材）。
    fn sample(w: u32, h: u32) -> image::RgbaImage {
        image::RgbaImage::from_fn(w, h, |x, y| {
            image::Rgba([(x % 256) as u8, (y % 256) as u8, 128, 255])
        })
    }

    #[test]
    fn decode_rejects_excluded_formats_by_extension() {
        for ext in ["avif", "svg", "jxl", "AVIF"] {
            let path = format!("C:/tmp/sample.{ext}");
            match decode_file(&path) {
                Err(ImageError::UnsupportedFormat(got)) => {
                    assert_eq!(got, ext.to_ascii_lowercase());
                }
                other => panic!("{ext} 应被拒收，实际: {other:?}"),
            }
        }
    }

    #[test]
    fn roundtrip_webp_lossless_preserves_pixels() {
        let src = sample(37, 23);
        let bytes = encode(&src, EncodeFormat::WebpLossless, 0).expect("编码 WebP 失败");
        let back = decode_bytes(&bytes).expect("回读 WebP 失败");
        assert_eq!((back.width(), back.height()), (37, 23));
        assert_eq!(back.into_raw(), src.into_raw(), "WebP 无损必须逐像素一致");
    }

    #[test]
    fn roundtrip_png_preserves_pixels() {
        let src = sample(19, 11);
        let bytes = encode(&src, EncodeFormat::Png, 0).expect("编码 PNG 失败");
        let back = decode_bytes(&bytes).expect("回读 PNG 失败");
        assert_eq!(back.into_raw(), src.into_raw());
    }

    #[test]
    fn jpeg_drops_alpha_but_decodes() {
        let src = sample(20, 12);
        let bytes = encode(&src, EncodeFormat::Jpeg, 90).expect("编码 JPEG 失败");
        let back = decode_bytes(&bytes).expect("回读 JPEG 失败");
        assert_eq!((back.width(), back.height()), (20, 12));
        assert!(back.pixels().all(|p| p.0[3] == 255), "JPEG 无 alpha，回读必须全不透明");
    }

    #[test]
    fn resize_keeps_aspect_and_never_upscales() {
        let src = sample(400, 200);
        let out = resize_to_max_edge(&src, 100).expect("缩放失败");
        assert_eq!((out.width(), out.height()), (100, 50));

        let small = sample(64, 32);
        let same = resize_to_max_edge(&small, 256).expect("缩放失败");
        assert_eq!((same.width(), same.height()), (64, 32), "小于上限时不得放大");
    }

    #[test]
    fn resize_rejects_zero_edge() {
        let src = sample(8, 8);
        assert!(matches!(
            resize_to_max_edge(&src, 0),
            Err(ImageError::InvalidDimensions(0, 0))
        ));
    }

    #[test]
    fn decode_bytes_rejects_empty() {
        assert!(matches!(decode_bytes(&[]), Err(ImageError::Decode(_))));
    }

    #[test]
    fn decodable_whitelist_covers_both_tif_spellings() {
        // 扩展名双写法是 Phase 0 清理的旧账（`file_types` 曾只认 tiff），
        // 编辑器这边一开始就两个都收，别再复现一次。
        assert!(EDITOR_DECODABLE_EXTENSIONS.contains(&"tif"));
        assert!(EDITOR_DECODABLE_EXTENSIONS.contains(&"tiff"));
        for ext in EDITOR_EXCLUDED_EXTENSIONS {
            assert!(!EDITOR_DECODABLE_EXTENSIONS.contains(ext));
        }
    }

    #[test]
    fn crop_takes_the_exact_sub_rect() {
        let src = sample(10, 8);
        let out = crop_image(&src, CropRect::new(2, 3, 4, 5)).expect("裁剪失败");
        assert_eq!((out.width(), out.height()), (4, 5));
        // 裁剪是纯几何操作：切出来的像素必须与原图逐点相同（连裁多次不累积损失的前提）
        for y in 0..5 {
            for x in 0..4 {
                assert_eq!(out.get_pixel(x, y), src.get_pixel(2 + x, 3 + y));
            }
        }
    }

    #[test]
    fn crop_rejects_out_of_bounds_instead_of_clamping() {
        let src = sample(10, 8);
        // 静默截断会掩盖坐标换算错误（把 CSS px 当图片 px、或忘了除缩放倍数），
        // 表现为「裁出来少一块」且极难定位，所以越界必须报错
        assert!(matches!(
            crop_image(&src, CropRect::new(8, 0, 5, 5)),
            Err(ImageError::CropOutOfBounds { .. })
        ));
        assert!(matches!(
            crop_image(&src, CropRect::new(0, 6, 5, 5)),
            Err(ImageError::CropOutOfBounds { .. })
        ));
    }

    #[test]
    fn crop_rejects_zero_size() {
        let src = sample(10, 8);
        assert!(matches!(
            crop_image(&src, CropRect::new(0, 0, 0, 5)),
            Err(ImageError::InvalidDimensions(0, 5))
        ));
    }

    #[test]
    fn crop_full_is_a_no_op() {
        let src = sample(9, 7);
        assert!(CropRect::full(9, 7).is_full(9, 7));
        let out = crop_image(&src, CropRect::full(9, 7)).expect("裁剪失败");
        assert_eq!(out.into_raw(), src.into_raw());
    }

    #[test]
    fn rotate90_swaps_axes_and_moves_pixels_clockwise() {
        let src = sample(4, 2);
        let out = rotate_image(&src, Rotation::Cw90);
        assert_eq!((out.width(), out.height()), (2, 4), "90° 旋转必须交换宽高");
        // 顺时针 90°：源 (x,y) → 目标 (h-1-y, x)
        for y in 0..2 {
            for x in 0..4 {
                assert_eq!(out.get_pixel(1 - y, x), src.get_pixel(x, y));
            }
        }
    }

    #[test]
    fn rotate180_and_270_are_consistent() {
        let src = sample(5, 3);
        let r180 = rotate_image(&src, Rotation::Cw180);
        assert_eq!((r180.width(), r180.height()), (5, 3), "180° 不交换宽高");
        assert_eq!(r180.get_pixel(0, 0), src.get_pixel(4, 2));

        // 270° = 逆时针 90°：源 (x,y) → 目标 (y, w-1-x)
        let r270 = rotate_image(&src, Rotation::Cw270);
        assert_eq!((r270.width(), r270.height()), (3, 5));
        for y in 0..3 {
            for x in 0..5 {
                assert_eq!(r270.get_pixel(y, 4 - x), src.get_pixel(x, y));
            }
        }
    }

    #[test]
    fn four_rotations_return_to_original() {
        let src = sample(7, 4);
        let mut cur = src.clone();
        for _ in 0..4 {
            cur = rotate_image(&cur, Rotation::Cw90);
        }
        assert_eq!(cur.into_raw(), src.into_raw(), "转四次必须回到原图");
    }

    #[test]
    fn flips_mirror_the_expected_axis() {
        let src = sample(6, 3);
        let h = flip_image(&src, true, false);
        for y in 0..3 {
            for x in 0..6 {
                assert_eq!(h.get_pixel(5 - x, y), src.get_pixel(x, y));
            }
        }
        let v = flip_image(&src, false, true);
        for y in 0..3 {
            for x in 0..6 {
                assert_eq!(v.get_pixel(x, 2 - y), src.get_pixel(x, y));
            }
        }
        // 水平 + 垂直 = 180° 旋转
        let both = flip_image(&src, true, true);
        assert_eq!(both.into_raw(), rotate_image(&src, Rotation::Cw180).into_raw());
    }

    #[test]
    fn rotation_rejects_non_right_angles() {
        for deg in [45u16, 30, 1, 359] {
            assert!(matches!(
                Rotation::from_degrees(deg),
                Err(ImageError::InvalidRotation(_))
            ));
        }
        // 360 等价于 0
        assert_eq!(Rotation::from_degrees(360).unwrap(), Rotation::None);
    }

    // ---- 调色 ----

    fn solid(r: u8, g: u8, b: u8, a: u8) -> image::RgbaImage {
        let mut img = image::RgbaImage::new(1, 1);
        img.put_pixel(0, 0, image::Rgba([r, g, b, a]));
        img
    }

    fn adjust(img: &image::RgbaImage, b: f32, c: f32, s: f32, t: f32) -> [u8; 4] {
        let m = ColorMatrix::from_adjustments(b, c, s, t);
        apply_color_matrix(img, &m).get_pixel(0, 0).0
    }

    #[test]
    fn zero_adjustments_are_identity() {
        let src = sample(8, 8);
        let m = ColorMatrix::from_adjustments(0.0, 0.0, 0.0, 0.0);
        assert_eq!(m, ColorMatrix::identity(), "全 0 必须退化成单位矩阵");
        assert!(is_identity_adjustment(0.0, 0.0, 0.0, 0.0));
        assert_eq!(apply_color_matrix(&src, &m).into_raw(), src.into_raw());
    }

    #[test]
    fn brightness_is_multiplicative_not_additive() {
        // CSS brightness() 是乘法，若实现成加法，预览与导出的暗部走向会相反
        let out = adjust(&solid(100, 100, 100, 255), 0.5, 0.0, 0.0, 0.0);
        assert_eq!(&out[..3], &[150, 150, 150]); // 100 * 1.5

        let black = adjust(&solid(100, 100, 100, 255), -1.0, 0.0, 0.0, 0.0);
        assert_eq!(&black[..3], &[0, 0, 0]); // 增益 0
    }

    #[test]
    fn contrast_pivots_around_mid_gray() {
        // 中灰 128 是轴心，不该被推动
        let mid = adjust(&solid(128, 128, 128, 255), 0.0, 0.5, 0.0, 0.0);
        assert!((mid[0] as i32 - 128).abs() <= 1, "中灰应基本不动，实际 {}", mid[0]);

        // 亮的更亮、暗的更暗
        let bright = adjust(&solid(200, 200, 200, 255), 0.0, 0.5, 0.0, 0.0);
        assert!(bright[0] > 200);
        let dark = adjust(&solid(60, 60, 60, 255), 0.0, 0.5, 0.0, 0.0);
        assert!(dark[0] < 60);
    }

    #[test]
    fn saturation_minus_one_turns_gray() {
        let out = adjust(&solid(255, 0, 0, 255), 0.0, 0.0, -1.0, 0.0);
        assert_eq!(out[0], out[1], "去饱和后三通道必须相等");
        assert_eq!(out[1], out[2]);
    }

    #[test]
    fn temperature_warms_by_raising_red_and_lowering_blue() {
        let warm = adjust(&solid(100, 100, 100, 255), 0.0, 0.0, 0.0, 1.0);
        assert!(warm[0] > 100, "暖调抬红");
        assert_eq!(warm[1], 100, "绿通道不动");
        assert!(warm[2] < 100, "暖调压蓝");

        let cool = adjust(&solid(100, 100, 100, 255), 0.0, 0.0, 0.0, -1.0);
        assert!(cool[0] < 100);
        assert!(cool[2] > 100);
    }

    #[test]
    fn alpha_is_never_touched() {
        let out = adjust(&solid(10, 20, 30, 77), 0.8, 0.5, -0.5, 0.6);
        assert_eq!(out[3], 77);
    }

    #[test]
    fn adjustment_order_is_pinned() {
        // 顺序换了结果就不同（矩阵不可交换），所以写死在这里防止有人"顺手优化"
        let actual = ColorMatrix::from_adjustments(0.2, 0.3, 0.4, 0.5);
        let expected = ColorMatrix::brightness(0.2)
            .then(&ColorMatrix::contrast(0.3))
            .then(&ColorMatrix::saturation(0.4))
            .then(&ColorMatrix::temperature(0.5));
        assert_eq!(actual, expected);
    }

    #[test]
    fn combined_adjustments_snapshot() {
        // 与前端 TS 实现共享的采样值：两边都必须算出同一组数字，
        // 否则会出现"预览偏暖、导出偏冷"这类所见非所得。
        // 手算复核：(120,90,60) → 亮度×1.2 → 对比 1.3 绕 127.5 → 饱和 1.4 → 色温 R×1.15/B×0.85
        let out = adjust(&solid(120, 90, 60, 255), 0.2, 0.3, 0.4, 0.5);
        assert_eq!(out, [190, 100, 29, 255]);
    }

    /// 代理图管线的分阶段耗时基准（手动跑，不进常规测试）。    ///
    /// 用法：
    /// ```text
    /// AURORA_IMAGING_BENCH="D:/big.png" \
    ///   CARGO_TARGET_DIR=C:/cargo-target-core cargo test --lib \
    ///   imaging::tests::bench_preview_pipeline -- --ignored --nocapture
    /// ```
    ///
    /// 存在意义：用户反馈「生成代理有点久」，而这条链路有四段（解码 / 缩放 / 编码 /
    /// base64），不分开计时就只能靠猜。改任何一段之前先跑一次，用数字决定优化哪段。
    #[test]
    #[ignore = "基准测试：需 AURORA_IMAGING_BENCH 指定一张真实大图"]
    fn bench_preview_pipeline() {
        let path = match std::env::var("AURORA_IMAGING_BENCH") {
            Ok(p) if !p.is_empty() => p,
            _ => {
                eprintln!("跳过：未设置 AURORA_IMAGING_BENCH");
                return;
            }
        };

        let t0 = std::time::Instant::now();
        let rgba = decode_file(&path).expect("解码失败");
        let decode = t0.elapsed();

        let t1 = std::time::Instant::now();
        let proxy = resize_to_max_edge(&rgba, 2048).expect("缩放失败");
        let resize = t1.elapsed();

        let t2 = std::time::Instant::now();
        let jpeg = encode(&proxy, EncodeFormat::Jpeg, 90).expect("编码失败");
        let encode = t2.elapsed();

        let t3 = std::time::Instant::now();
        use base64::{engine::general_purpose, Engine as _};
        let data_url = format!("data:image/jpeg;base64,{}", general_purpose::STANDARD.encode(&jpeg));
        let b64 = t3.elapsed();

        println!("---- 代理图管线 ----");
        println!("源图     {}×{}", rgba.width(), rgba.height());
        println!("代理     {}×{}", proxy.width(), proxy.height());
        println!("解码     {:?}", decode);
        println!("缩放     {:?}", resize);
        println!("编码     {:?}  ({} KB)", encode, jpeg.len() / 1024);
        println!("base64   {:?}  ({:.2} MB 字符串)", b64, data_url.len() as f64 / 1024.0 / 1024.0);
        println!("合计     {:?}", decode + resize + encode + b64);
    }
}
