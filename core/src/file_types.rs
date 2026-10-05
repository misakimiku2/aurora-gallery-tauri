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

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "jfif", "png", "gif", "webp", "bmp", "tiff", "ico", "svg", "avif", "jxl",
];

pub fn is_supported_image(extension: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}

/// 扩展名 → MIME（Eagle 导入期新增；`ai.rs` 的 `guess_mime` 是给 AI 接口兜底的——
/// 未知扩展名回 `image/jpeg`，拿来做支持判定会把一切放行，两套语义不能混）。
///
/// Eagle 侧只有扩展名，要先映射成 content_type 才能过 `import::is_indexable` 这道
/// 全仓唯一的支持门禁（调研 §7 明令不许在适配器里散落扩展名黑名单）。支持列表与
/// `SUPPORTED_EXTENSIONS` 保持同一份口径：不在表里的扩展名返回 None → 不支持。
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
        _ => None,
    }
}
