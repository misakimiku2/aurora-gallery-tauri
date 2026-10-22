//! 图片编辑器（C11）的 Rust 侧命令。
//!
//! 设计依据：`docs/图片编辑与封面合成-设计方案.md` §3.1（全分辨率像素不进 WebView）、
//! §6.2（Phase 1 单图文档闭环）。这里只做「源文件 → 代理图」这一段：解码与缩放全部
//! 走 `aurora_core::imaging`，前端拿到的是已经降采样的 JPEG，**永远看不到源图全分辨率
//! 像素**。Phase 2 的图层合成会在这条链路上继续往 core 里加，而不是把像素搬进前端。

use aurora_core::imaging::{self, CropRect, EncodeFormat};
use base64::{engine::general_purpose, Engine as _};
use image::RgbaImage;
use serde::{Deserialize, Serialize};

/// 代理图最长边上限（设计方案 §3.1：代理图长边 ≤ 2048px）。
///
/// 2048 不是随手取的：状态栏要显示「当前看到的是代理还是全分辨率」，而 2048 在
/// 1440p 窗口下按 100% 显示时已接近 1:1，用户不会误判锐度；同时一张 6000×4000 的
/// 原图降到这个尺寸后内存占用从 ~96MB 掉到 ~12MB。
const PREVIEW_MAX_EDGE: u32 = 2048;

/// 代理图 JPEG 质量。
///
/// 90 是「看不出压缩痕迹」与「体积可接受」的平衡点：2048px 的复杂照片约 400–800KB，
/// base64 之后 0.5–1MB，单文档加载感知不到延迟。代理图本身**不是持久产物**（每次打开
/// 重新生成），所以不必为体积做更激进的压缩。
const PREVIEW_JPEG_QUALITY: u8 = 90;

/// 编辑器打开图片时拿到的代理图。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorPreview {
    /// 当前文档尺寸（裁剪之后）
    pub width: u32,
    pub height: u32,
    /// **裁剪之前**的坐标系尺寸（旋转/翻转已应用）。
    ///
    /// 前端旋转/翻转时要把 `crop` 换算到新坐标系，而那一步需要知道「crop 所在的
    /// 完整画框有多大」——`width/height` 是裁过的，推不出未裁的，所以单独给。
    pub frame_width: u32,
    pub frame_height: u32,
    /// 代理图尺寸。源图本就小于上限时与 `width`/`height` 相同。
    pub preview_width: u32,
    pub preview_height: u32,
    /// `data:image/jpeg;base64,...`，可直接喂 `<img src>`。
    ///
    /// 用 data URL 而不是写缓存文件再用 `convertFileSrc`：代理图是一次性的、不落盘，
    /// 走文件就得管生命周期（谁删、何时删、缓存命中率），而 1MB 量级的 base64 在
    /// invoke 返回里没有实际开销。与 `image_utils::get_avif_preview` 同一模式。
    pub data_url: String,
}

/// 裁剪请求（原图像素坐标，左上原点）。
#[derive(Debug, Clone, Copy, Deserialize)]
pub struct CropRequest {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

impl From<CropRequest> for CropRect {
    fn from(v: CropRequest) -> Self {
        CropRect::new(v.x, v.y, v.w, v.h)
    }
}

/// RGBA → 代理图的统一出口。
///
/// `width`/`height` 报的是**当前文档尺寸**（裁剪之后），`frame` 是裁剪之前的
/// 画框尺寸（旋转/翻转已应用）——前端换算 `crop` 时需要后者。
fn build_preview(rgba: &RgbaImage, frame: (u32, u32)) -> Result<EditorPreview, String> {
    let (width, height) = (rgba.width(), rgba.height());

    let proxy = imaging::resize_to_max_edge(rgba, PREVIEW_MAX_EDGE).map_err(|e| e.to_string())?;
    let (preview_width, preview_height) = (proxy.width(), proxy.height());

    let jpeg =
        imaging::encode(&proxy, EncodeFormat::Jpeg, PREVIEW_JPEG_QUALITY).map_err(|e| e.to_string())?;

    Ok(EditorPreview {
        width,
        height,
        frame_width: frame.0,
        frame_height: frame.1,
        preview_width,
        preview_height,
        data_url: format!(
            "data:image/jpeg;base64,{}",
            general_purpose::STANDARD.encode(&jpeg)
        ),
    })
}

/// 解码源图并生成代理图。
///
/// 编辑器只接受 `core::imaging` 认的格式（avif / svg / jxl 在 Phase 0 就被排除了），
/// 拒绝时的错误文案是「编辑器不支持该格式: xxx」，可以直接显示给用户。
#[tauri::command]
pub async fn editor_load_preview(path: String) -> Result<EditorPreview, String> {
    tokio::task::spawn_blocking(move || {
        let rgba = imaging::decode_file(&path).map_err(|e| e.to_string())?;
        build_preview(&rgba, (rgba.width(), rgba.height()))
    })
    .await
    .map_err(|e| format!("代理图任务失败: {e}"))?
}

/// 导出成品的 JPEG 质量。
///
/// 比代理图的 90 高一档：代理图是"看"的，导出是"留"的，多花几十 KB 换画质值得。
const EXPORT_JPEG_QUALITY: u8 = 92;

/// 导出结果（前端用来提示"导出到哪儿了、多大"）。
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorExportResult {
    pub path: String,
    pub width: u32,
    pub height: u32,
    pub bytes: u64,
}

/// 按扩展名决定编码格式。**不支持就报错，不猜**——`foo.avif` 静默写成 PNG
/// 会让用户拿到一个扩展名与内容不符的文件。
fn encode_format_from_path(target: &str) -> Result<EncodeFormat, String> {
    let ext = std::path::Path::new(target)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match ext.as_str() {
        "png" => Ok(EncodeFormat::Png),
        "jpg" | "jpeg" => Ok(EncodeFormat::Jpeg),
        // 导出用无损 WebP：有损 WebP 需要 libwebp，而本项目刻意不引那份 C 依赖
        "webp" => Ok(EncodeFormat::WebpLossless),
        _ => Err(format!(
            "不支持的导出格式: .{ext}（支持 png / jpg / webp）"
        )),
    }
}

/// 把当前文档导出成一张图片。
///
/// 全流程在 Rust：**从源文件重新解码**（不是拿代理图放大），套上裁剪，
/// 编码，写盘。所以导出的是全分辨率成品，不受 2048px 代理上限影响。
///
/// `crop` 与 `editor_crop_preview` 用同一套坐标（相对源文件的绝对像素），
/// 两处口径必须一致，否则"看到的是裁过的、导出的是原图"。
#[tauri::command]
pub async fn editor_export_image(
    path: String,
    crop: Option<CropRequest>,
    target_path: String,
    quality: Option<u8>,
    rotation: Option<u16>,
    flip_h: Option<bool>,
    flip_v: Option<bool>,
) -> Result<EditorExportResult, String> {
    tokio::task::spawn_blocking(move || {
        let rgba = imaging::decode_file(&path).map_err(|e| e.to_string())?;
        let rot = imaging::Rotation::from_degrees(rotation.unwrap_or(0)).map_err(|e| e.to_string())?;

        // 与预览严格同一顺序，否则会出现「看到的是转过的、导出的是没转的」
        let mut image = imaging::rotate_image(&rgba, rot);
        image = imaging::flip_image(&image, flip_h.unwrap_or(false), flip_v.unwrap_or(false));
        if let Some(c) = crop {
            image = imaging::crop_image(&image, c.into()).map_err(|e| e.to_string())?;
        }

        let format = encode_format_from_path(&target_path)?;
        let bytes = imaging::encode(&image, format, quality.unwrap_or(EXPORT_JPEG_QUALITY))
            .map_err(|e| e.to_string())?;

        std::fs::write(&target_path, &bytes)
            .map_err(|e| format!("写入失败({target_path}): {e}"))?;

        Ok(EditorExportResult {
            path: target_path,
            width: image.width(),
            height: image.height(),
            bytes: bytes.len() as u64,
        })
    })
    .await
    .map_err(|e| format!("导出任务失败: {e}"))?
}

/// 按当前文档状态（旋转 / 翻转 / 裁剪）重新生成代理图。
///
/// 处理顺序固定为 **rotate → flip → crop → resize → encode**，与 `core::imaging`
/// 模块文档里写的口径一致。`crop` 是**当前可见坐标系**下的矩形（旋转/翻转之后），
/// 所以旋转那一刻由前端把已有 crop 换算到新坐标系，后端不做坐标反算。
///
/// 三个参数都可缺省：全缺省时等价于「原图直出」，所以这个命令同时承担了
/// `editor_load_preview` 的职责（后者保留为无参便捷入口）。
#[tauri::command]
pub async fn editor_render_preview(
    path: String,
    crop: Option<CropRequest>,
    rotation: Option<u16>,
    flip_h: Option<bool>,
    flip_v: Option<bool>,
) -> Result<EditorPreview, String> {
    tokio::task::spawn_blocking(move || {
        let rgba = imaging::decode_file(&path).map_err(|e| e.to_string())?;
        let rot = imaging::Rotation::from_degrees(rotation.unwrap_or(0)).map_err(|e| e.to_string())?;

        let mut image = imaging::rotate_image(&rgba, rot);
        image = imaging::flip_image(&image, flip_h.unwrap_or(false), flip_v.unwrap_or(false));
        // crop 之前的画框尺寸：前端旋转/翻转时靠它把 crop 换算到新坐标系
        let frame = (image.width(), image.height());
        if let Some(c) = crop {
            image = imaging::crop_image(&image, c.into()).map_err(|e| e.to_string())?;
        }

        build_preview(&image, frame)
    })
    .await
    .map_err(|e| format!("渲染任务失败: {e}"))?
}
