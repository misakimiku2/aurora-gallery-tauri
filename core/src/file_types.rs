use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub struct SavedWindowState {
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
    pub maximized: bool,
}

impl Default for SavedWindowState {
    fn default() -> Self {
        Self { width: 1280.0, height: 800.0, x: 100.0, y: 100.0, maximized: false }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum FileType {
    Image,
    // 视频 P1（设计方案 §2.7 口径 E）：视频与图片同权进库，serde camelCase → JSON "video"。
    Video,
    Folder,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageMeta {
    pub width: u32,
    pub height: u32,
    pub size_kb: u32,
    pub created: String,
    pub modified: String,
    pub format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<Vec<String>>,
    // 视频 P1（设计方案 §6）：视频元数据五项，图片一律 None。
    /// 时长（毫秒，统一整数避免浮点误差）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<i64>,
    /// 帧率（逐帧功能依赖；拿不到时保持 None，前端据此置灰逐帧按钮，不按 1/30 兜底）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub frame_rate: Option<f64>,
    /// 旋转标记（0 / 90 / 180 / 270）。`width/height` 存编码尺寸不交换，显示尺寸由 rotation 派生。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rotation: Option<i64>,
    // 视频信息块补列（2026-10-16，设计方案 §6「码率/编码」）。图片一律 None。
    /// 视频编码（如 `AVC` / `HEVC`；Video 流 Format，非容器）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub video_codec: Option<String>,
    /// 总码率（bps）。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub bit_rate: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub r#type: FileType,
    pub path: String,
    pub size: Option<u64>,
    pub children: Option<Vec<String>>,
    pub tags: Vec<String>,
    pub created_at: Option<String>,
    pub updated_at: Option<String>,
    pub url: Option<String>,
    pub meta: Option<ImageMeta>,
    pub description: Option<String>,
    /// 第一条来源网址（给老读者用，= `source_urls[0]`）。
    pub source_url: Option<String>,
    /// 全部来源网址（P1(b)：一张图可以有多个）。与 `source_url` 同源，后者是它的首项。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source_urls: Option<Vec<String>>,
    pub category: Option<String>,
    pub ai_data: Option<serde_json::Value>,
}

#[derive(Serialize, Clone)]
pub struct ScanProgress {
    pub processed: usize,
    pub total: usize,
}

// 视频 P1（设计方案 §2.7 口径 E）：扩展名白名单拆成图片 / 视频两份，并作为全仓唯一真源
// （原 `SUPPORTED_EXTENSIONS` 只含图片，视频在扫描阶段就被丢弃——这是根因一）。
// 视频 12 种与 LAN `is_video_file` 的列表对齐。
pub const SUPPORTED_IMAGE_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "tiff", "tif", "ico", "svg", "avif", "jxl",
];

pub const SUPPORTED_VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mov", "avi", "mkv", "webm", "flv", "wmv", "m4v", "mpg", "mpeg", "3gp", "ts",
];

pub fn is_supported_image(extension: &str) -> bool {
    SUPPORTED_IMAGE_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}

/// 视频 P1（设计方案 §2.7 口径 E）：视频扩展名判定，语义与 LAN `is_video_file` 一致。
pub fn is_supported_video(extension: &str) -> bool {
    SUPPORTED_VIDEO_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}

/// 扩展名 → MIME（Eagle 导入期新增；`ai.rs` 的 `guess_mime` 是给 AI 接口兜底的——
/// 未知扩展名回 `image/jpeg`，拿来做支持判定会把一切放行，两套语义不能混）。
///
/// Eagle 侧只有扩展名，要先映射成 content_type 才能过 `import::is_indexable` 这道
/// 全仓唯一的支持门禁（调研 §7 明令不许在适配器里散落扩展名黑名单）。支持列表与
/// `SUPPORTED_IMAGE_EXTENSIONS` / `SUPPORTED_VIDEO_EXTENSIONS` 保持同一份口径：
/// 不在表里的扩展名返回 None → 不支持。
///
/// 视频 P1（设计方案 §11.1）：补 `video/*` 映射，否则 Eagle 走 ext→mime 拿不到
/// `video/*`，`is_indexable` 照样把视频标注拦下。
pub fn mime_for_extension(extension: &str) -> Option<&'static str> {
    match extension.to_lowercase().as_str() {
        "jpg" | "jpeg" | "jfif" => Some("image/jpeg"),
        "png" => Some("image/png"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "bmp" => Some("image/bmp"),
        "tiff" | "tif" => Some("image/tiff"),
        "ico" => Some("image/x-icon"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "jxl" => Some("image/jxl"),
        // 视频 P1（设计方案 §6 / §11.1）：视频容器 → MIME。
        "mp4" => Some("video/mp4"),
        "mov" => Some("video/quicktime"),
        "m4v" => Some("video/x-m4v"),
        "avi" => Some("video/x-msvideo"),
        "mkv" => Some("video/x-matroska"),
        "webm" => Some("video/webm"),
        "wmv" => Some("video/x-ms-wmv"),
        "flv" => Some("video/x-flv"),
        "mpg" | "mpeg" => Some("video/mpeg"),
        "3gp" => Some("video/3gpp"),
        "ts" => Some("video/mp2t"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 双门一致性：白名单认的每个图片扩展名都必须能映射出 MIME。
    ///
    /// Phase 0 清理的旧账：`SUPPORTED_IMAGE_EXTENSIONS` 只写 `tiff`、`mime_for_extension`
    /// 却认 `tif`，同一个格式两道门两种答案——扫描认、Eagle 导入不认（导入要过
    /// `is_indexable`，它拿 ext → mime，拿不到就判不支持）。这条把两扇门焊死。
    #[test]
    fn image_extension_and_mime_tables_stay_in_sync() {
        for ext in SUPPORTED_IMAGE_EXTENSIONS {
            assert!(
                mime_for_extension(ext).is_some(),
                "白名单里的 `{ext}` 没有 MIME 映射"
            );
        }
    }

    /// `tif` / `tiff` 两种拼写必须同权——相机与手机导出的 tif 极常见，
    /// 少认一个就是「扫得到但用不了」。
    #[test]
    fn both_tiff_spellings_are_recognised() {
        for ext in ["tif", "tiff", "TIF", "TIFF"] {
            assert!(is_supported_image(ext), "`{ext}` 应被识别为图片");
        }
        assert_eq!(mime_for_extension("tif"), Some("image/tiff"));
        assert_eq!(mime_for_extension("tiff"), Some("image/tiff"));
    }
}
