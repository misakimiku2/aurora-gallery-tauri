//! 图片编辑器（C11）的 Rust 侧命令。
//!
//! 设计依据：`docs/图片编辑与封面合成-设计方案.md` §3.1（全分辨率像素不进 WebView）、
//! §6.2（Phase 1 单图文档闭环）。这里只做「源文件 → 代理图」这一段：解码与缩放全部
//! 走 `aurora_core::imaging`，前端拿到的是已经降采样的 JPEG，**永远看不到源图全分辨率
//! 像素**。Phase 2 的图层合成会在这条链路上继续往 core 里加，而不是把像素搬进前端。

use aurora_core::imaging::{self, EncodeFormat};
use base64::{engine::general_purpose, Engine as _};
use serde::Serialize;

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
    /// 源图原始尺寸（像素）。状态栏与「存储上限 = 画布 × 2」都按这个算。
    pub width: u32,
    pub height: u32,
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

/// 解码源图并生成代理图。
///
/// 编辑器只接受 `core::imaging` 认的格式（avif / svg / jxl 在 Phase 0 就被排除了），
/// 拒绝时的错误文案是「编辑器不支持该格式: xxx」，可以直接显示给用户。
#[tauri::command]
pub async fn editor_load_preview(path: String) -> Result<EditorPreview, String> {
    tokio::task::spawn_blocking(move || {
        let rgba = imaging::decode_file(&path).map_err(|e| e.to_string())?;
        let (width, height) = (rgba.width(), rgba.height());

        let proxy =
            imaging::resize_to_max_edge(&rgba, PREVIEW_MAX_EDGE).map_err(|e| e.to_string())?;
        let (preview_width, preview_height) = (proxy.width(), proxy.height());

        let jpeg = imaging::encode(&proxy, EncodeFormat::Jpeg, PREVIEW_JPEG_QUALITY)
            .map_err(|e| e.to_string())?;

        Ok(EditorPreview {
            width,
            height,
            preview_width,
            preview_height,
            data_url: format!(
                "data:image/jpeg;base64,{}",
                general_purpose::STANDARD.encode(&jpeg)
            ),
        })
    })
    .await
    .map_err(|e| format!("代理图任务失败: {e}"))?
}
