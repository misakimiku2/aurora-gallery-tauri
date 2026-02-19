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
    pub source_url: Option<String>,
    pub category: Option<String>,
    pub ai_data: Option<serde_json::Value>,
}

#[derive(Serialize, Clone)]
pub struct ScanProgress {
    pub processed: usize,
    pub total: usize,
}

pub const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "ico", "svg", "avif", "jxl",
];

pub fn is_supported_image(extension: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}
