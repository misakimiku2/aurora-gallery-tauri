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

mod decode;
mod encode;
mod resize;

pub use decode::{
    decode_bytes, decode_file, is_excluded_extension, EDITOR_DECODABLE_EXTENSIONS,
    EDITOR_EXCLUDED_EXTENSIONS,
};
pub use encode::{encode, EncodeFormat};
pub use resize::resize_to_max_edge;

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

    /// 代理图管线的分阶段耗时基准（手动跑，不进常规测试）。
    ///
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
