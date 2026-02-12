// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::fs;

use std::sync::Arc;
use tauri::Manager;
use tauri::Emitter;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use serde_json;
use rusqlite::params; // params! macro required for some ad-hoc SQL in this file


use base64::{Engine as _, engine::general_purpose};
// use fast_image_resize as fr;

// use palette::{FromColor, Srgb, Lab};
// use palette::color_difference::Ciede2000;

// 导入颜色相关模块
mod color_extractor;
mod color_db;
mod color_worker;
mod db;
mod color_search;
mod thumbnail;

use crate::thumbnail::{get_thumbnail, get_thumbnails_batch, save_remote_thumbnail, generate_drag_preview};
use crate::color_search::{search_by_palette, search_by_color};

use image;
use jxl_oxide;
use std::sync::atomic::{AtomicUsize, Ordering};

// 全局共享的重载格式（JXL/AVIF）解码任务计数，限制并发以保护 CPU
pub static ACTIVE_HEAVY_DECODES: AtomicUsize = AtomicUsize::new(0);
pub const MAX_CONCURRENT_HEAVY_DECODES: usize = 3; // 稍微放宽到 3，给 UI 响应一点空间

// Helper for JXL and AVIF magic byte detection
pub fn is_jxl(buffer: &[u8]) -> bool {
    // Codestream: FF 0A
    if buffer.starts_with(&[0xFF, 0x0A]) {
        return true;
    }
    // Container: 00 00 00 0C 4A 58 4C 20 0D 0A 87 0A
    if buffer.len() >= 12 && (&buffer[0..12] == &[0, 0, 0, 0x0C, 0x4A, 0x58, 0x4C, 0x20, 0x0D, 0x0A, 0x87, 0x0A] || &buffer[0..12] == b"\x00\x00\x00\x0cJXL \x0d\x0a\x87\x0a") {
        return true;
    }
    false
}

pub fn is_avif(buffer: &[u8]) -> bool {
    // Look for ftypavif or ftypavis usually at offset 4
    if buffer.len() >= 12 {
        let ftyp = &buffer[4..12];
        if ftyp == b"ftypavif" || ftyp == b"ftypavis" {
            return true;
        }
    }
    false
}

pub fn get_image_dimensions(path: &str) -> (u32, u32) {
    let mut file = match std::fs::File::open(path) {
        Ok(f) => f,
        Err(_) => return (0, 0),
    };

    use std::io::{Read, Seek, SeekFrom};
    let mut buffer = [0u8; 16];
    let n = file.read(&mut buffer).unwrap_or(0);
    let buf = &buffer[..n];
    let _ = file.seek(SeekFrom::Start(0));

    // Special priority for JXL and AVIF to avoid imageinfo issues
    if is_jxl(buf) || path.to_lowercase().ends_with(".jxl") {
        if let Ok(jxl) = jxl_oxide::JxlImage::builder().open(path) {
            return (jxl.width(), jxl.height());
        }
    }

    if is_avif(buf) || path.to_lowercase().ends_with(".avif") {
        if let Ok(dim) = image::image_dimensions(path) {
            return dim;
        }
    }

    // Try imageinfo for everything else
    // 使用 catch_unwind 捕获可能的 panic，防止扫描线程崩溃
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        imageinfo::ImageInfo::from_file(&mut file)
    }));
    
    match result {
        Ok(Ok(info)) => (info.size.width as u32, info.size.height as u32),
        Ok(Err(_)) => (0, 0),
        Err(_) => {
            eprintln!("[Warning] imageinfo panicked while processing: {}", path);
            (0, 0)
        }
    }
}

use std::sync::Mutex;
use std::time::{Instant, Duration};

// 全局 HDD 检测结果缓存
static HDD_CACHE: Mutex<Option<HashMap<String, (bool, Instant)>>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(300); // 缓存有效期 5 分钟

/// 检测路径是否可能位于HDD（机械硬盘）上
/// 通过测量小文件的随机读取延迟来判断
/// 结果会被缓存，避免重复检测
fn is_likely_hdd(path: &str) -> bool {
    // 规范化路径作为缓存键
    let cache_key = normalize_path(path);
    
    // 首先检查缓存
    {
        let mut cache_guard = HDD_CACHE.lock().unwrap();
        if cache_guard.is_none() {
            *cache_guard = Some(HashMap::new());
        }
        
        if let Some(cache) = cache_guard.as_ref() {
            if let Some((result, timestamp)) = cache.get(&cache_key) {
                if timestamp.elapsed() < CACHE_TTL {
                    // 缓存命中且未过期
                    return *result;
                }
            }
        }
    }
    
    // 缓存未命中，执行检测
    let result = detect_hdd_internal(path);
    
    // 更新缓存
    {
        let mut cache_guard = HDD_CACHE.lock().unwrap();
        if let Some(ref mut cache) = cache_guard.as_mut() {
            cache.insert(cache_key, (result, Instant::now()));
        }
    }
    
    result
}

/// 内部 HDD 检测逻辑
fn detect_hdd_internal(path: &str) -> bool {
    let test_path = Path::new(path);
    let mut read_times = Vec::new();

    if let Ok(entries) = fs::read_dir(test_path) {
        let test_files: Vec<_> = entries
            .filter_map(|e| e.ok())
            .filter(|e| {
                if let Ok(meta) = e.metadata() {
                    meta.is_file() && meta.len() < 1024 * 1024
                } else {
                    false
                }
            })
            .take(5)
            .collect();

        for entry in test_files {
            let path = entry.path();
            let start = Instant::now();
            let _ = fs::metadata(&path);
            let elapsed = start.elapsed();
            read_times.push(elapsed.as_millis() as f64);
        }
    }

    if read_times.len() >= 3 {
        let avg_time: f64 = read_times.iter().sum::<f64>() / read_times.len() as f64;
        log::info!("[HDD Detection] Average read time: {:.2}ms (threshold: 10ms)", avg_time);
        avg_time > 10.0
    } else {
        false
    }
}

// --- Window State Management ---

#[derive(Serialize, Deserialize, Debug)]
struct SavedWindowState {
    width: f64,
    height: f64,
    x: f64,
    y: f64,
    maximized: bool,
}

impl Default for SavedWindowState {
    fn default() -> Self {
        Self { width: 1280.0, height: 800.0, x: 100.0, y: 100.0, maximized: false }
    }
}

fn get_window_state_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    app_handle.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).join("window_state.json")
}

fn get_initial_db_paths(app_handle: &tauri::AppHandle) -> (std::path::PathBuf, std::path::PathBuf) {
    let app_data_dir = app_handle.path().app_data_dir()
        .expect("Failed to get app data directory");
    
    let config_path = app_data_dir.join("user_data.json");
    
    if config_path.exists() {
        if let Ok(json_str) = fs::read_to_string(config_path) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if let Some(root_paths) = data.get("rootPaths").and_then(|v| v.as_array()) {
                    if let Some(first_root) = root_paths.get(0).and_then(|v| v.as_str()) {
                        let root = Path::new(first_root);
                        let aurora_dir = root.join(".aurora");
                        return (aurora_dir.join("colors.db"), aurora_dir.join("metadata.db"));
                    }
                }
            }
        }
    }
    
    // Default fallback
    (app_data_dir.join("colors.db"), app_data_dir.join("metadata.db"))
}

fn save_window_state(app_handle: &tauri::AppHandle) {
    let window = match app_handle.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let path = get_window_state_path(app_handle);
    let mut state = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<SavedWindowState>(&s).ok())
            .unwrap_or(SavedWindowState::default())
    } else {
        SavedWindowState::default()
    };

    if window.is_maximized().unwrap_or(false) {
        state.maximized = true;
    } else {
        state.maximized = false;
        // Don't save if minimized
        if !window.is_minimized().unwrap_or(false) {
            if let (Ok(pos), Ok(size), Ok(factor)) = (window.outer_position(), window.inner_size(), window.scale_factor()) {
                let l_pos = pos.to_logical::<f64>(factor);
                let l_size = size.to_logical::<f64>(factor);
                state.x = l_pos.x;
                state.y = l_pos.y;
                state.width = l_size.width;
                state.height = l_size.height;
            }
        }
    }
    
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = fs::write(path, json);
    }
}

// --- Color Search Implementation ---
// (moved to `color_search.rs`)

use db::AppDbPool;

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

// Supported image extensions
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "ico", "svg", "avif", "jxl",
];

// Use shared generate_id and normalize_path
use db::{generate_id, normalize_path};

// Generate a unique file path by adding _copy suffix if file exists
fn generate_unique_file_path(dest_path: &str) -> String {
    let path = Path::new(dest_path);
    if !path.exists() {
        return dest_path.to_string();
    }
    
    // Get parent directory and file stem/extension
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let file_stem = path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let extension = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    
    // Try _copy, _copy2, _copy3, etc.
    for counter in 1.. {
        let new_name = if counter == 1 {
            format!("{}_copy{}", file_stem, extension)
        } else {
            format!("{}_copy{}{}", file_stem, counter, extension)
        };
        let new_path = parent.join(&new_name);
        if !new_path.exists() {
            return new_path.to_str().unwrap_or(dest_path).to_string();
        }
    }
    
    // Fallback (should never reach here)
    dest_path.to_string()
}

// Check if file extension is supported
fn is_supported_image(extension: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}

#[tauri::command]
async fn get_avif_preview(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose};
    use std::fs;

    // Direct read and base64 encode to leverage WebView2 native AVIF support.
    // This avoids backend decoding dependencies entirely.
    let result = tokio::task::spawn_blocking(move || {
        let content = fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
        Ok(format!("data:image/avif;base64,{}", general_purpose::STANDARD.encode(content)))
    }).await.map_err(|e| e.to_string())?;
    
    result
}

#[tauri::command]
async fn get_jxl_preview(path: String) -> Result<String, String> {
    use jxl_oxide::JxlImage;
    use image::DynamicImage;
    use std::io::Cursor;
    use base64::{Engine as _, engine::general_purpose};
    use fast_image_resize as fr;
    use std::num::NonZeroU32;

    // Concurrency limit for heavy decodes
    while ACTIVE_HEAVY_DECODES.load(Ordering::Relaxed) >= MAX_CONCURRENT_HEAVY_DECODES {
        tokio::time::sleep(tokio::time::Duration::from_millis(50)).await;
    }
    ACTIVE_HEAVY_DECODES.fetch_add(1, Ordering::SeqCst);

    let result = (async {
        let jxl_image = JxlImage::builder().open(&path).map_err(|e| format!("JXL error: {:?}", e))?;
        
        let render = jxl_image.render_frame(0).map_err(|e| format!("Render error: {:?}", e))?;
        let framebuffer = render.image_all_channels();
        
        let width = framebuffer.width() as u32;
        let height = framebuffer.height() as u32;
        let channels = framebuffer.channels();
        let buf = framebuffer.buf();
        
        let mut img = if channels == 3 {
            use rayon::prelude::*;
            let pixels: Vec<u8> = buf.par_iter().map(|&val| (val * 255.0).clamp(0.0, 255.0) as u8).collect();
            DynamicImage::ImageRgb8(image::RgbImage::from_raw(width, height, pixels).ok_or("Failed to create RgbImage")?)
        } else {
            use rayon::prelude::*;
            let pixels: Vec<u8> = buf.par_iter().map(|&val| (val * 255.0).clamp(0.0, 255.0) as u8).collect();
            DynamicImage::ImageRgba8(image::RgbaImage::from_raw(width, height, pixels).ok_or("Failed to create RgbaImage")?)
        };

        // Resize if too large to reduce CPU/memory during WebP encoding and transfer
        let max_dimension = 2560;
        if width > max_dimension || height > max_dimension {
            let (new_width, new_height) = if width > height {
                (max_dimension, (max_dimension as f32 * (height as f32 / width as f32)) as u32)
            } else {
                ((max_dimension as f32 * (width as f32 / height as f32)) as u32, max_dimension)
            };

            if let (Some(w_nz), Some(h_nz), Some(nw_nz), Some(nh_nz)) = (
                NonZeroU32::new(width), NonZeroU32::new(height),
                NonZeroU32::new(new_width), NonZeroU32::new(new_height)
            ) {
                let pixel_type = if channels == 3 { fr::PixelType::U8x3 } else { fr::PixelType::U8x4 };
                let src_pixels = if channels == 3 { img.to_rgb8().into_raw() } else { img.to_rgba8().into_raw() };
                let src_image = fr::Image::from_vec_u8(w_nz, h_nz, src_pixels, pixel_type).map_err(|e| e.to_string())?;
                let mut dst_image = fr::Image::new(nw_nz, nh_nz, pixel_type);
                let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
                resizer.resize(&src_image.view(), &mut dst_image.view_mut()).map_err(|e| e.to_string())?;
                
                let buffer = dst_image.buffer().to_vec();
                img = if channels == 3 {
                    match image::RgbImage::from_raw(new_width, new_height, buffer) {
                        Some(rgb_img) => DynamicImage::ImageRgb8(rgb_img),
                        None => return Err("Failed to create RGB image from resized buffer".to_string()),
                    }
                } else {
                    match image::RgbaImage::from_raw(new_width, new_height, buffer) {
                        Some(rgba_img) => DynamicImage::ImageRgba8(rgba_img),
                        None => return Err("Failed to create RGBA image from resized buffer".to_string()),
                    }
                };
            }
        }

        let mut buffer = Vec::new();
        img.write_to(&mut Cursor::new(&mut buffer), image::ImageFormat::WebP).map_err(|e| e.to_string())?;
        
        Ok(format!("data:image/webp;base64,{}", general_purpose::STANDARD.encode(buffer)))
    }).await;

    ACTIVE_HEAVY_DECODES.fetch_sub(1, Ordering::SeqCst);
    result
}


#[derive(Serialize, Clone)]
struct ScanProgress {
    processed: usize,
    total: usize,
}

#[tauri::command]
async fn scan_directory(path: String, force_rescan: Option<bool>, app: tauri::AppHandle) -> Result<HashMap<String, FileNode>, String> {
    use std::fs;
    use rayon::prelude::*;
    
    let force = force_rescan.unwrap_or(false);
    let root_path_os = Path::new(&path);
    
    if !root_path_os.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    if !root_path_os.is_dir() {
        return Err(format!("路径不是目录: {}", path));
    }

    let normalized_root_path = normalize_path(&path);

    // 1. & 2. 并行加载元数据和索引条目
    let pool = app.state::<AppDbPool>();
    let pool_inner = pool.inner().clone();
    let path_for_metadata = normalized_root_path.clone();
    let path_for_index = normalized_root_path.clone();

    let pool_for_metadata = pool_inner.clone();
    let pool_for_index = pool_inner.clone();

    let (metadata_map, cached_index_map) = tokio::join!(
        tokio::task::spawn_blocking(move || {
            let conn = pool_for_metadata.get_connection();
            let res = db::file_metadata::get_metadata_under_path(&conn, &path_for_metadata);
            res.unwrap_or_default()
                .into_iter()
                .map(|m| (m.file_id.clone(), m))
                .collect::<HashMap<String, db::file_metadata::FileMetadata>>()
        }),
        tokio::task::spawn_blocking(move || {
            let conn = pool_for_index.get_connection();
            db::file_index::get_entries_under_path(&conn, &path_for_index)
                .unwrap_or_default()
                .into_iter()
                .map(|e| (e.path.clone(), e))
                .collect::<HashMap<String, db::file_index::FileIndexEntry>>()
        })
    );

    let metadata_map = metadata_map.unwrap_or_default();
    let cached_index_map = cached_index_map.unwrap_or_default();
    
    let root_id = generate_id(&path);
    
    // --- 极速启动模式 (Database First) ---
    // 如果是非强制扫描，且数据库里有数据，直接使用数据库数据返回，跳过磁盘扫描
    // 这可以将启动时间从 7s+ 降低到 1-2s (仅受限于数据库读取速度)
    if !force && !cached_index_map.is_empty() {
        // [Hotfix] 简单的一致性检查：
        // 读取此目录下的第一层物理文件/文件夹，看数量是否大致匹配。
        // 只有当物理文件没有显著增加时，才信任数据库缓存。

        // 规范化路径对比基准 (对齐末尾斜杠处理)
        let root_match_path = normalized_root_path.trim_end_matches('/').to_string();

        let fs_root_count = if let Ok(rd) = root_path_os.read_dir() {
            rd.filter_map(|e| e.ok()).filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                // 排除缓存和隐藏文件
                if name == ".Aurora_Cache" || (name.starts_with('.') && name != ".pixcall") {
                    return false;
                }
                
                // 只统计文件夹和支持的图片类型，与数据库存储策略保持一致
                // 否则如果根目录下有 txt/exe 等文件，会因为数据库不索引它们而导致 fs_count 永远 > db_count，
                // 导致每次启动都触发降级全量扫描。
                if let Ok(md) = e.metadata() {
                    if md.is_dir() { return true; }
                    let ext = e.path().extension().and_then(|s| s.to_str()).map(|s| s.to_lowercase()).unwrap_or_default();
                    return is_supported_image(&ext);
                }
                false
            }).count()
        } else {
            0
        };

        // 计算数据库中作为直接子项的数量
        let db_root_children_count = cached_index_map.values()
            .filter(|entry| {
                let p = std::path::Path::new(&entry.path);
                if let Some(parent) = p.parent() {
                    let parent_normalized = normalize_path(parent.to_str().unwrap_or(""));
                    let p_match = parent_normalized.trim_end_matches('/');
                    
                    #[cfg(windows)]
                    {
                        p_match.eq_ignore_ascii_case(&root_match_path)
                    }
                    #[cfg(not(windows))]
                    {
                        p_match == root_match_path
                    }
                } else {
                    false
                }
            })
            .count();

        // 只有当物理文件没有显著增加时，才信任数据库缓存
        if fs_root_count <= db_root_children_count {
            if std::env::var("AURORA_DEBUG").ok() == Some("1".to_string()) {
                println!("Fast startup: Root consistency check passed (FS: {}, DB: {})", fs_root_count, db_root_children_count);
            }
            let mut all_files = HashMap::new();
            let mut path_to_id = HashMap::new();
            
            // 1. 转换条目
            for (f_path, entry) in cached_index_map.iter() {
                // 可选：在这里检查文件是否存在。为了极致速度，暂时信任数据库。
                // 如果文件被删除了，用户点开大图会发现失效，此时手动刷新即可。
                
                let mut node = FileNode {
                    id: entry.file_id.clone(),
                    parent_id: entry.parent_id.clone(),
                    name: entry.name.clone(),
                    r#type: if entry.file_type == "Image" { FileType::Image } else { FileType::Folder },
                    path: f_path.clone(),
                    size: Some(entry.size),
                    children: if entry.file_type == "Folder" { Some(Vec::new()) } else { None },
                    tags: Vec::new(),
                    url: None, meta: None, description: None, source_url: None, category: None, ai_data: None,
                    created_at: chrono::DateTime::from_timestamp(entry.created_at, 0).map(|dt| dt.to_rfc3339()),
                    updated_at: chrono::DateTime::from_timestamp(entry.modified_at, 0).map(|dt| dt.to_rfc3339()),
                };

                // 恢复元数据
                if let Some(meta) = metadata_map.get(&entry.file_id) {
                    if let Some(tags_val) = &meta.tags {
                        if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) { node.tags = tags_vec; }
                    }
                    node.description = meta.description.clone();
                    node.source_url = meta.source_url.clone();
                    node.category = meta.category.clone();
                    node.ai_data = meta.ai_data.clone();
                }

                // 恢复图片尺寸信息
                if let (Some(w), Some(h)) = (entry.width, entry.height) {
                    node.meta = Some(ImageMeta {
                        width: w,
                        height: h,
                        size_kb: (entry.size / 1024) as u32,
                        created: chrono::DateTime::from_timestamp(entry.created_at, 0).map(|dt| dt.to_rfc3339()).unwrap_or_default(),
                        modified: chrono::DateTime::from_timestamp(entry.modified_at, 0).map(|dt| dt.to_rfc3339()).unwrap_or_default(),
                        format: entry.format.clone().unwrap_or_else(|| "unknown".to_string()),
                    });
                }

                path_to_id.insert(f_path.clone(), entry.file_id.clone());
                all_files.insert(entry.file_id.clone(), node);
            }

            // 确保根节点存在 (如果数据库里没有根节点记录，手动补一个)
            if !all_files.contains_key(&root_id) {
                 let root_metadata = std::fs::metadata(root_path_os).ok();
                 let mut root_node = FileNode {
                    id: root_id.clone(), parent_id: None, name: root_path_os.file_name().and_then(|n| n.to_str()).unwrap_or("Root").to_string(),
                    r#type: FileType::Folder, path: normalized_root_path.clone(), size: None, children: Some(Vec::new()), tags: Vec::new(),
                    url: None, meta: None, description: None, source_url: None, category: None, ai_data: None,
                    created_at: root_metadata.as_ref().and_then(|m| m.created().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
                    updated_at: root_metadata.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
                };
                path_to_id.insert(normalized_root_path.clone(), root_id.clone());
                
                // 恢复根节点元数据
                if let Some(meta) = metadata_map.get(&root_id) {
                    if let Some(tags_val) = &meta.tags {
                        if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) { root_node.tags = tags_vec; }
                    }
                    root_node.description = meta.description.clone();
                    root_node.source_url = meta.source_url.clone();
                    root_node.category = meta.category.clone();
                    root_node.ai_data = meta.ai_data.clone();
                }
                
                all_files.insert(root_id.clone(), root_node);
            }

            // 2. 重建父子关系
            // 数据库里可能存了 parent_id，但为了保险，或者应对移动文件夹的情况，
            // 我们可以信任数据库的 parent_id，也可以重新计算。
            // 这里为了速度，直接使用数据库里的 parent_id。如果不一致，下次 force scan 会修正。
            // 但是，数据库里的 parent_id 可能是旧的。比较稳妥的是重新通过 path 映射一次。
            
            let mut assignments = Vec::new();
            for (id, node) in all_files.iter() {
                if id == &root_id { continue; }
                
                // 尝试通过路径找 parent
                let parent_path_str = std::path::Path::new(&node.path).parent()
                    .map(|p| normalize_path(p.to_str().unwrap_or("")))
                    .unwrap_or_default();
                
                let computed_parent_id = if parent_path_str == normalized_root_path || parent_path_str.is_empty() {
                    Some(root_id.clone())
                } else {
                    path_to_id.get(&parent_path_str).cloned()
                };

                if let Some(pid) = computed_parent_id {
                    assignments.push((pid, id.clone()));
                }
            }

            for (pid, cid) in assignments {
                 if let Some(pnode) = all_files.get_mut(&pid) {
                    if let Some(children) = &mut pnode.children {
                        children.push(cid.clone());
                    }
                }
                if let Some(cnode) = all_files.get_mut(&cid) {
                    cnode.parent_id = Some(pid);
                }
            }

            sort_children(&mut all_files);

            // 发送 100% 进度
            let _ = app.emit("scan-progress", ScanProgress { processed: all_files.len(), total: all_files.len() });
            
            return Ok(all_files);
        } else {
             println!("Detected new files in root directory (DB: {}, FS: {}). Creating incremental update...", db_root_children_count, fs_root_count);
             // 如果数量不一致，不需要 return，直接 fall through 继续执行下面的物理扫描
        }
    }
    // --- 结束极速启动模式 ---

    let root_metadata = fs::metadata(root_path_os).map_err(|e| format!("无法读取根目录: {}", e))?;
    let mut root_node = FileNode {
        id: root_id.clone(), parent_id: None, name: root_path_os.file_name().and_then(|n| n.to_str()).unwrap_or("Root").to_string(),
        r#type: FileType::Folder, path: normalized_root_path.clone(), size: None, children: Some(Vec::new()), tags: Vec::new(),
        url: None, meta: None, description: None, source_url: None, category: None, ai_data: None,
        created_at: root_metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
        updated_at: root_metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
    };

    // 恢复根节点元数据
    if let Some(meta) = metadata_map.get(&root_id) {
        if let Some(tags_val) = &meta.tags {
            if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) { root_node.tags = tags_vec; }
        }
        root_node.description = meta.description.clone();
        root_node.source_url = meta.source_url.clone();
        root_node.category = meta.category.clone();
        root_node.ai_data = meta.ai_data.clone();
    }

    // 3. 决定计数策略
    // 如果是强制扫描（首次或手动刷新），提前数准总量以获得平滑进度条
    // HDD优化：检测是否为HDD并调整并行度
    let count_parallelism = if is_likely_hdd(&path) {
        eprintln!("[Scan] Detected HDD for counting, using sequential scanning for better performance");
        jwalk::Parallelism::Serial
    } else {
        jwalk::Parallelism::RayonNewPool(16)
    };

    let total_images = if force {
        jwalk::WalkDir::new(&path)
            .parallelism(count_parallelism)
            .process_read_dir(|_, _, _, dir_entry_results| {
                dir_entry_results.retain(|result| {
                    result.as_ref().map(|entry| {
                        let name = entry.file_name().to_str().unwrap_or("");
                        name != ".Aurora_Cache" && !(name.starts_with('.') && name != ".pixcall")
                    }).unwrap_or(true)
                });
            })
            .into_iter()
            .par_bridge()
            .filter_map(|e| {
                let entry = e.ok()?;
                if entry.file_type().is_file() {
                    let ext = entry.path().extension()?.to_str()?.to_lowercase();
                    if is_supported_image(&ext) { return Some(1); }
                }
                None
            })
            .count()
    } else {
        // 平时启动：直接用根目录子项做初步预估，节约时间
        root_path_os.read_dir().map(|d| d.count()).unwrap_or(0)
    };

    let (tx, rx) = crossbeam_channel::unbounded::<(String, FileNode, String)>();
    let _ = app.emit("scan-progress", ScanProgress { processed: 0, total: total_images });

    let producer_path = path.clone();
    let cached_index_arc = Arc::new(cached_index_map);

    // HDD优化：检测是否为HDD并调整并行度
    // 在HDD上，高并行度会导致磁头竞争，降低性能
    let scan_parallelism = if is_likely_hdd(&producer_path) {
        eprintln!("[Scan] Detected HDD for scanning, using sequential scanning for better performance");
        jwalk::Parallelism::Serial
    } else {
        jwalk::Parallelism::RayonNewPool(16)
    };

    std::thread::spawn(move || {
        let normalized_root = normalize_path(&producer_path);
        let root_p_local = Path::new(&producer_path);

        jwalk::WalkDir::new(&producer_path)
            .parallelism(scan_parallelism) 
            .process_read_dir(|_, _, _, dir_entry_results| {
                dir_entry_results.retain(|result| {
                    result.as_ref().map(|entry| {
                        let name = entry.file_name().to_str().unwrap_or("");
                        // 彻底不进入 .Aurora_Cache 和其他隐藏文件夹的子目录
                        name != ".Aurora_Cache" && !(name.starts_with('.') && name != ".pixcall")
                    }).unwrap_or(true)
                });
            })
            .into_iter()
            .filter_map(|entry_result| {
                let entry = entry_result.ok()?;
                let entry_path = entry.path();
                if entry_path == root_p_local { return None; }

                let full_path = normalize_path(entry_path.to_str()?);
                let metadata = entry.metadata().ok()?;
                let p_path = entry_path.parent().map(|p| normalize_path(p.to_str().unwrap_or(""))).unwrap_or(normalized_root.clone());
                
                let is_directory = metadata.is_dir();
                let file_name = entry_path.file_name()?.to_str()?.to_string();
                let extension = entry_path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
                
                let cached = cached_index_arc.get(&full_path);
                let mtime = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
                
                // 即使是强制刷新，如果文件没变且有缓存，我们也优先使用缓存中的维度。
                // 这样可以避免“强制刷新”把已经加载好的维度又重置成 0。
                let mut width = 0;
                let mut height = 0;
                let mut has_cached_dims = false;

                if let Some(c) = cached {
                    if c.modified_at == mtime && c.size == metadata.len() {
                        if let (Some(w), Some(h)) = (c.width, c.height) {
                            if w > 0 && h > 0 {
                                width = w;
                                height = h;
                                has_cached_dims = true;
                            }
                        }
                    }
                }

                let file_id = if let Some(c) = cached { c.file_id.clone() } else { generate_id(&full_path) };

                if is_directory {
                    let folder_node = FileNode {
                        id: file_id.clone(), parent_id: None, name: file_name, r#type: FileType::Folder, path: full_path.clone(),
                        size: None, children: Some(Vec::new()), tags: Vec::new(), url: None, meta: None, description: None, source_url: None, category: None, ai_data: None,
                        created_at: metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
                        updated_at: chrono::DateTime::from_timestamp(mtime, 0).map(|dt| dt.to_rfc3339()),
                    };
                    Some((file_id, folder_node, p_path))
                } else if is_supported_image(&extension) {
                    // 如果没有缓存可复用维度，且处于强制扫描模式（通常是欢迎界面或手动刷新），
                    // 我们直接在这里同步读取维度，这样最终写入数据库的就是完整信息。
                    if !has_cached_dims && force {
                         let dims = get_image_dimensions(&entry_path.to_string_lossy());
                         width = dims.0;
                         height = dims.1;
                    }

                    let image_node = FileNode {
                        id: file_id.clone(), parent_id: None, name: file_name.to_string(), r#type: FileType::Image, path: full_path.clone(),
                        size: Some(metadata.len()), children: None, tags: Vec::new(), url: None, description: None, source_url: None, category: None, ai_data: None,
                        created_at: metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
                        updated_at: chrono::DateTime::from_timestamp(mtime, 0).map(|dt| dt.to_rfc3339()),
                        meta: Some(ImageMeta {
                            width, height, size_kb: (metadata.len() / 1024) as u32, format: extension,
                            created: metadata.created().ok()
                                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                .map(|d| d.as_secs() as i64)
                                .and_then(|s| chrono::DateTime::from_timestamp(s, 0))
                                .map(|dt| dt.to_rfc3339())
                                .unwrap_or_default(),
                            modified: chrono::DateTime::from_timestamp(mtime, 0).map(|dt| dt.to_rfc3339()).unwrap_or_default(),
                        }),
                    };
                    Some((file_id, image_node, p_path))
                } else { None }
            })
            .for_each(|item| {
                let _ = tx.send(item);
            });
    });

    // 4. 聚合结果
    let mut all_files: HashMap<String, FileNode> = HashMap::new();
    let mut path_to_id: HashMap<String, String> = HashMap::new();
    path_to_id.insert(normalized_root_path.clone(), root_id.clone());
    all_files.insert(root_id.clone(), root_node);

    let mut scanned_paths = Vec::new();
    let mut processed_count = 0;
    let mut current_total = total_images;
    let mut p_path_map: HashMap<String, String> = HashMap::new(); 
    
    // 准备数据库持久化数据，在接收时直接构建，避免二次遍历
    let mut entries_to_save = Vec::with_capacity(total_images + 1);

    let mut received_count = 0;
    while let Ok((id, mut node, p_path)) = rx.recv() {
        received_count += 1;
        scanned_paths.push(node.path.clone());
        if node.name.contains("棕色") || node.name.contains("素材") {
             println!("[DEBUG] Scanning node check: Name={}, GeneratedID={}, FoundMeta={}", node.name, id, metadata_map.contains_key(&id));
        }

        // 每500个文件输出一次进度日志
        if received_count % 500 == 0 {
            eprintln!("[Scan Progress] Received {} files so far, processed: {}, total expected: {}",
                     received_count, processed_count, total_images);
        }

        if matches!(node.r#type, FileType::Folder) { 
            path_to_id.insert(node.path.clone(), id.clone()); 
        }
        p_path_map.insert(id.clone(), p_path.clone());

        if let Some(meta) = metadata_map.get(&id) {
            if let Some(tags_val) = &meta.tags {
                if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) { node.tags = tags_vec; }
            }
            node.description = meta.description.clone();
            node.source_url = meta.source_url.clone();
            node.category = meta.category.clone();
            node.ai_data = meta.ai_data.clone();
        }

        if matches!(node.r#type, FileType::Image) {
            processed_count += 1;
            if !force && processed_count > current_total { current_total = processed_count; }
            if force && processed_count % 500 == 0 {
                let _ = app.emit("scan-progress", ScanProgress { processed: processed_count, total: current_total });
            }
        }

        // 同步构建索引条目
        let (w, h, fmt) = node.meta.as_ref().map_or((None, None, None), |m| (Some(m.width), Some(m.height), Some(m.format.clone())));
        let c_at = node.created_at.as_ref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|dt| dt.timestamp()).unwrap_or(0);
        let m_at = node.updated_at.as_ref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|dt| dt.timestamp()).unwrap_or(0);

        entries_to_save.push(db::file_index::FileIndexEntry {
            file_id: id.clone(),
            parent_id: None, // 稍后修正
            path: node.path.clone(),
            name: node.name.clone(),
            file_type: match node.r#type { FileType::Image => "Image".to_string(), FileType::Folder => "Folder".to_string(), _ => "Unknown".to_string() },
            size: node.size.unwrap_or(0), width: w, height: h, format: fmt,
            created_at: c_at, modified_at: m_at, 
        });

        all_files.insert(id, node);
    }
    

    // 5. 修正 Parent ID 引用
    for entry in entries_to_save.iter_mut() {
        if entry.file_id == root_id { continue; }

        let parent_id = if let Some(pp) = p_path_map.get(&entry.file_id) {
             if pp == &normalized_root_path || pp.is_empty() {
                 Some(root_id.clone())
             } else {
                 path_to_id.get(pp).cloned()
             }
        } else { None };

        if let Some(pid) = parent_id {
            entry.parent_id = Some(pid.clone());
            if let Some(pnode) = all_files.get_mut(&pid) {
                if let Some(children) = &mut pnode.children {
                    children.push(entry.file_id.clone());
                }
            }
            if let Some(cnode) = all_files.get_mut(&entry.file_id) {
                cnode.parent_id = Some(pid);
            }
        }
    }

    sort_children(&mut all_files);

    // 扫描完成后，发送最终进度（确保显示实际数量）
    let _ = app.emit("scan-progress", ScanProgress {
        processed: processed_count,
        total: current_total,
    });

    // 扫描完成后的日志
    eprintln!("[Scan Complete] Total received: {}, Total files in map: {}, Expected: {}",
             received_count, all_files.len(), total_images);

    // 如果接收的文件数量与预期相差较大，输出警告
    if received_count < total_images.saturating_sub(10) {
        eprintln!("[Scan Warning] Received fewer files than expected! This may indicate a HDD I/O issue.");
        eprintln!("[Scan Warning] Consider checking disk health or using SSD for better performance.");
    }

    // 6. 后台增量补全逻辑
    let mut to_process: Vec<String> = Vec::new();
    if std::env::var("AURORA_DISABLE_BACKGROUND_INDEX").as_deref().ok() != Some("1") {
        for node in all_files.values() {
            if matches!(node.r#type, FileType::Image) {
                let need = node.meta.as_ref().map(|m| m.width == 0 || m.height == 0).unwrap_or(true);
                if need { to_process.push(node.path.clone()); }
            }
        }
    }

    // 7. 持久化到索引数据库（异步执行，不阻塞 Ok 返回）
    let root_to_clean = normalized_root_path.clone();
    let app_db_inner = app.state::<AppDbPool>().inner().clone();
    
    tokio::task::spawn_blocking(move || {
        let mut conn = app_db_inner.get_connection();
        let _ = db::file_index::batch_upsert(&mut conn, &entries_to_save);
        let _ = db::file_index::delete_orphaned_entries(&mut conn, &root_to_clean, &scanned_paths);
    });

    // 8. 处理后台补充逻辑
    if !to_process.is_empty() {
        let pool = app.state::<AppDbPool>().inner().clone();
        let app_handle = app.clone();
        tokio::spawn(async move {
            let batch_size: usize = std::env::var("AURORA_INDEX_BATCH_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(200);
            let batch_delay_ms: u64 = std::env::var("AURORA_INDEX_BATCH_DELAY_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(50);

            for chunk in to_process.chunks(batch_size) {
                let chunk_vec: Vec<String> = chunk.to_vec();
                let pool_clone = pool.clone();
                let app_handle_clone = app_handle.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let mut conn = pool_clone.get_connection();
                    let mut entries = Vec::new();
                    for path in chunk_vec.iter() {
                        if let Ok(md) = std::fs::metadata(path) {
                            if md.is_file() {
                                let (w, h) = get_image_dimensions(path);
                                if w > 0 && h > 0 {
                                    let id = generate_id(path);
                                    let name = std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                                    let fmt = std::path::Path::new(path).extension().and_then(|e| e.to_str()).map(|s| s.to_string());
                                    
                                    let c_at = md.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
                                    let m_at = md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);

                                    entries.push(db::file_index::FileIndexEntry {
                                        file_id: id, parent_id: None, path: path.clone(), name, file_type: "Image".to_string(),
                                        size: md.len(), width: Some(w), height: Some(h), format: fmt, created_at: c_at, modified_at: m_at,
                                    });
                                }
                            }
                        }
                    }
                    if !entries.is_empty() {
                        let _ = db::file_index::batch_upsert(&mut conn, &entries);
                        // 通知前端这些文件的元数据已更新
                        let _ = app_handle_clone.emit("metadata-updated", &entries);
                    }
                }).await.ok();
                tokio::time::sleep(std::time::Duration::from_millis(batch_delay_ms)).await;
            }
        });
    }

    Ok(all_files)
}

fn sort_children(all_files: &mut HashMap<String, FileNode>) {
    let folder_ids: Vec<String> = all_files.keys().cloned().collect();
    for folder_id in folder_ids {
        let children_opt = all_files.get(&folder_id).and_then(|n| n.children.as_ref()).cloned();
        if let Some(mut children_sorted) = children_opt {
            children_sorted.sort_by(|a, b| {
                let a_node = all_files.get(a);
                let b_node = all_files.get(b);
                match (a_node, b_node) {
                    (Some(a_n), Some(b_n)) => {
                        match (&a_n.r#type, &b_n.r#type) {
                            (FileType::Folder, FileType::Folder) => a_n.name.cmp(&b_n.name),
                            (FileType::Folder, _) => std::cmp::Ordering::Less,
                            (_, FileType::Folder) => std::cmp::Ordering::Greater,
                            _ => a_n.name.cmp(&b_n.name),
                        }
                    }
                    _ => std::cmp::Ordering::Equal,
                }
            });
            if let Some(node) = all_files.get_mut(&folder_id) { if let Some(children) = &mut node.children { *children = children_sorted; } }
        }
    }
}

#[tauri::command]
async fn force_rescan(path: String, app: tauri::AppHandle) -> Result<HashMap<String, FileNode>, String> {
    // Wrapper that forces a full rescan by forwarding to scan_directory with force_rescan = true
    scan_directory(path, Some(true), app).await
}

#[tauri::command]
async fn scan_file(file_path: String, parent_id: Option<String>, app: tauri::AppHandle) -> Result<FileNode, String> {
    use std::fs;
    
    let path = Path::new(&file_path);
    
    // Check if path exists
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    
    let metadata = fs::metadata(path)
        .map_err(|e| format!("Failed to read file metadata: {}", e))?;
    
    let file_id = generate_id(&normalize_path(&file_path));
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Unknown")
        .to_string();
    
    let extension = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    
    let is_directory = path.is_dir();
    let is_image = is_supported_image(&extension);
    
    let mut result_node = if is_directory {
        // Create folder node
        FileNode {
            id: file_id,
            parent_id,
            name: file_name,
            r#type: FileType::Folder,
            path: normalize_path(&file_path),
            size: None,
            children: Some(Vec::new()),
            tags: Vec::new(),
            created_at: metadata
                .created()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            updated_at: metadata
                .modified()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            url: None,
            meta: None,
            description: None,
            source_url: None,
            category: None,
            ai_data: None,
        }
    } else if is_image {
        // Create image file node
        let file_size = metadata.len();
        let (width, height) = get_image_dimensions(&path.to_string_lossy());
        
        // Create image file node
        let image_node = FileNode {
            id: file_id,
            parent_id,
            name: file_name,
            r#type: FileType::Image,
            path: normalize_path(&file_path),
            size: Some(file_size),
            children: None,
            tags: Vec::new(),
            created_at: metadata
                .created()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            updated_at: metadata
                .modified()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            url: None,
            meta: Some(ImageMeta {
                width,
                height,
                size_kb: (file_size / 1024) as u32,
                created: metadata
                    .created()
                    .ok()
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                    .and_then(|secs| {
                        chrono::DateTime::from_timestamp(secs as i64, 0)
                            .map(|dt| dt.to_rfc3339())
                    })
                    .unwrap_or_default(),
                modified: metadata
                    .modified()
                    .ok()
                    .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                    .and_then(|secs| {
                        chrono::DateTime::from_timestamp(secs as i64, 0)
                            .map(|dt| dt.to_rfc3339())
                    })
                    .unwrap_or_default(),
                format: extension,
            }),
            description: None,
            source_url: None,
            category: None,
            ai_data: None,
        };
        
        // Add image to color database
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let image_path = image_node.path.clone();
        
        // Add to database in a blocking thread
        let result = tokio::task::spawn_blocking(move || {
            let mut conn = pool.get_connection();
            color_db::add_pending_files(&mut conn, &[image_path])
        }).await;
        
        if let Err(e) = result {
            eprintln!("Failed to add file to color database: {}", e);
        } else if let Err(e) = result.unwrap() {
            eprintln!("Database error when adding file: {}", e);
        }
        
        image_node
    } else {
        // Create unknown file node
        let file_size = metadata.len();
        
        FileNode {
            id: file_id,
            parent_id,
            name: file_name,
            r#type: FileType::Unknown,
            path: normalize_path(&file_path),
            size: Some(file_size),
            children: None,
            tags: Vec::new(),
            created_at: metadata
                .created()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            updated_at: metadata
                .modified()
                .ok()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
                .and_then(|secs| {
                    chrono::DateTime::from_timestamp(secs as i64, 0)
                        .map(|dt| dt.to_rfc3339())
                }),
            url: None,
            meta: None,
            description: None,
            source_url: None,
            category: None,
            ai_data: None,
        }
    };

    // --- Merge metadata from database if available ---
    {
        let pool = app.state::<AppDbPool>();
        let conn = pool.get_connection();
        if let Ok(Some(meta)) = db::file_metadata::get_metadata_by_id(&conn, &result_node.id) {
            if let Some(tags_val) = &meta.tags {
                if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) {
                    result_node.tags = tags_vec;
                }
            }
            result_node.description = meta.description.clone();
            result_node.source_url = meta.source_url.clone();
            result_node.category = meta.category.clone();
            result_node.ai_data = meta.ai_data.clone();
        }
    }

    // --- 持久化到 file_index 以确保下次极速启动时能看见新文件 ---
    if result_node.r#type != FileType::Unknown {
        let node_clone = result_node.clone();
        let app_db_inner = app.state::<AppDbPool>().inner().clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = app_db_inner.get_connection();
            let (w, h, fmt) = node_clone.meta.as_ref().map_or((None, None, None), |m| (Some(m.width), Some(m.height), Some(m.format.clone())));
            
            let c_at = node_clone.created_at.as_ref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|dt| dt.timestamp()).unwrap_or(0);
            let m_at = node_clone.updated_at.as_ref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|dt| dt.timestamp()).unwrap_or(0);
            
            let entry = db::file_index::FileIndexEntry {
                file_id: node_clone.id,
                parent_id: node_clone.parent_id,
                path: node_clone.path,
                name: node_clone.name,
                file_type: match node_clone.r#type { FileType::Image => "Image".to_string(), FileType::Folder => "Folder".to_string(), _ => "Unknown".to_string() },
                size: node_clone.size.unwrap_or(0),
                width: w, height: h, format: fmt,
                created_at: c_at, modified_at: m_at, 
            };
            let _ = db::file_index::batch_upsert(&mut conn, &[entry]);
        });
    }

    Ok(result_node)
}

#[tauri::command]
async fn get_dominant_colors(
    file_path: String, 
    count: usize, 
    thumbnail_path: Option<String>,
    app: tauri::AppHandle
) -> Result<Vec<color_extractor::ColorResult>, String> {
    use std::sync::Arc;
    
    // 1. 尝试从数据库获取颜色数据
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    let file_path_for_db = file_path.clone();
    
    // 在单独线程中执行数据库操作
    let db_result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        color_db::get_colors_by_file_path(&mut conn, &file_path_for_db)
    }).await.map_err(|e| format!("Failed to execute database query: {}", e))?;
    
    if let Ok(Some(colors)) = db_result {
        if !colors.is_empty() {
            return Ok(colors);
        }
    }
    
    // 2. 数据库中没有数据，提取颜色
    let file_path_for_load = file_path.clone();
    let thumbnail_path_for_load = thumbnail_path.clone();

    // 异步执行优化后的加载和提取
    let results = tokio::task::spawn_blocking(move || {
        // 使用 color_worker 中优化后的加载逻辑
        // 如果 thumbnail_path 有效，优先尝试直接打开缩略图
        let img = if let Some(tp) = thumbnail_path_for_load {
             image::open(tp).map_err(|e| e.to_string()).or_else(|_| color_worker::load_and_resize_image_optimized(&file_path_for_load, None))
        } else {
             color_worker::load_and_resize_image_optimized(&file_path_for_load, None)
        }.map_err(|e| format!("Failed to load image: {}", e))?;
        
        let colors = color_extractor::get_dominant_colors(&img, count);
        Ok::<Vec<color_extractor::ColorResult>, String>(colors)
    }).await.map_err(|e| e.to_string())??;

    let colors = results;
    
    // 3. 将提取的颜色保存到数据库
    if !colors.is_empty() {
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let file_path_for_save = file_path.clone();
        let colors_clone = colors.clone();
        
        // 在单独线程中执行数据库操作
        let _ = tokio::task::spawn_blocking(move || {
            {
                let mut conn = pool.get_connection();
                // 先检查是否存在记录
                match color_db::get_colors_by_file_path(&mut conn, &file_path_for_save) {
                    Ok(None) => {
                        // 不存在记录，插入待处理状态
                        let _ = color_db::add_pending_files(&mut conn, &[file_path_for_save.clone()]);
                    },
                    _ => {}
                }
            } // Drop lock
            
            // 保存颜色数据
            pool.save_colors(&file_path_for_save, &colors_clone)
        }).await;
    }
    
    Ok(colors)
}

#[tauri::command]
async fn add_pending_files_to_db(
    app: tauri::AppHandle,
    file_paths: Vec<String>
) -> Result<usize, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    let batch_size = 500;
    
    let task_result = tokio::task::spawn_blocking(move || {
        let mut total = 0usize;
        let mut conn = pool.get_connection();
        
        for chunk in file_paths.chunks(batch_size) {
            let chunk_vec: Vec<String> = chunk.iter().cloned().collect();
            
            match color_db::add_pending_files(&mut conn, &chunk_vec) {
                Ok(count) => total += count,
                Err(e) => eprintln!("Database error when adding batch: {}", e),
            }
        }
        
        Ok::<usize, String>(total)
    }).await;
    
    match task_result {
        Ok(inner_result) => inner_result,
        Err(e) => Err(format!("Task join error: {}", e)),
    }
}

// Command to ensure a directory exists
#[tauri::command]
async fn ensure_directory(path: String) -> Result<(), String> {
    let cache_path = Path::new(&path);
    if !cache_path.exists() {
        fs::create_dir_all(cache_path)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    Ok(())
}

// Command to check if file exists
#[tauri::command]
async fn file_exists(file_path: String) -> Result<bool, String> {
    let path = Path::new(&file_path);
    Ok(path.exists())
}

// Command to create a folder
#[tauri::command]
async fn create_folder(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let folder_path = Path::new(&path);
    fs::create_dir(folder_path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;
    
    // 同步更新索引数据库
    let app_db = app.state::<AppDbPool>();
    let mut conn = app_db.get_connection();
    let normalized_path = normalize_path(&path);
    let id = generate_id(&normalized_path);
    let name = folder_path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
    let md = fs::metadata(folder_path).ok();
    
    let entry = db::file_index::FileIndexEntry {
        file_id: id,
        parent_id: folder_path.parent().map(|p| generate_id(&normalize_path(p.to_str().unwrap_or("")))),
        path: normalized_path,
        name,
        file_type: "Folder".to_string(),
        size: 0,
        width: None, height: None, format: None,
        created_at: md.as_ref().and_then(|m| m.created().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0),
        modified_at: md.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0),
    };
    
    let _ = db::file_index::batch_upsert(&mut conn, &[entry]);
    
    Ok(())
}

// Command to rename a file or folder
#[tauri::command]
async fn rename_file(old_path: String, new_path: String, app: tauri::AppHandle) -> Result<(), String> {
    // 1. 先进行物理重命名（必须同步完成以保证用户可见性）
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("物理重命名失败 (可能文件被占用): {}", e))?;

    let is_dir = Path::new(&new_path).is_dir();
    let app_db = app.state::<AppDbPool>();

    // 2. 快速事务：只做顶层路径的原子更新与目的路径冲突清理，确保不会触发 UNIQUE 约束
    //    这样可以立即让 UI 可见新路径；子路径的批量更新将异步执行以避免 CPU 峰值。
    {
        let mut conn = app_db.get_connection();
        let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;

        if is_dir {
            // 清理目标路径的顶层残留，防止 UNIQUE 冲突
            let new_normalized = normalize_path(&new_path);
            let new_dir_prefix_clean = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
            let new_dir_pattern = format!("{}%", new_dir_prefix_clean);
            tx.execute(
                "DELETE FROM file_index WHERE lower(path) = lower(?1) OR lower(path) LIKE lower(?2)",
                params![new_normalized, new_dir_pattern],
            ).ok();

            // 只更新顶层目录的路径与名称（快速）
            tx.execute(
                "UPDATE file_index SET path = ?1, name = ?2 WHERE path = ?3",
                params![normalize_path(&new_path), Path::new(&new_path).file_name().and_then(|n| n.to_str()).unwrap_or(""), normalize_path(&old_path)],
            ).ok();
        } else {
            // 单文件：只更新该文件的路径（快速）
            tx.execute(
                "UPDATE file_index SET path = ?1, name = ?2 WHERE file_id = ?3",
                params![normalize_path(&new_path), Path::new(&new_path).file_name().and_then(|n| n.to_str()).unwrap_or(""), generate_id(&old_path)],
            ).ok();

            // 尝试快速迁移元数据条目（单文件）
            let old_id = generate_id(&old_path);
            let new_id = generate_id(&new_path);
            let _ = db::file_metadata::migrate_metadata(&tx, &old_id, &new_id, &new_path);
        }

        tx.commit().map_err(|e| format!("提交快速事务失败: {}", e))?;
    }

    // 3. 后台异步完成子路径与 heavy-metadata 的完整迁移（限速并记录耗时）
    let old_clone = old_path.clone();
    let new_clone = new_path.clone();
    let pool_clone = app_db.inner().clone();
    let color_db = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();

    tokio::spawn(async move {
        let bg_start = std::time::Instant::now();
        let res = tokio::task::spawn_blocking(move || {
            let conn = pool_clone.get_connection();
            // 完整迁移（包括子路径）——重用已有的迁移函数以保证一致性
            let _ = db::file_index::migrate_index_dir(&conn, &old_clone, &new_clone);
            let _ = db::file_metadata::migrate_metadata_dir(&conn, &old_clone, &new_clone);
            // move_colors 可能内部也是异步/批量化的，但调用它以确保 color DB 一致性
            let _ = color_db.move_colors(&old_clone, &new_clone);
        }).await;

        if std::env::var("AURORA_BENCH").as_deref().ok() == Some("1") {
            eprintln!("AURORA_BENCH: rename_file background migration elapsed={:?}", bg_start.elapsed());
        }

        if let Err(e) = res {
            eprintln!("[rename_file][bg] migration failed: {:?}", e);
        }
    });

    Ok(())
}

#[tauri::command]
async fn db_copy_file_metadata(src_path: String, dest_path: String, app: tauri::AppHandle) -> Result<(), String> {
    let dest_p = Path::new(&dest_path);
    let is_dir = dest_p.is_dir();
    let app_db = app.state::<AppDbPool>();
    let conn = app_db.get_connection();

    // 1. 同步元数据 (Tags, AI Data 等)
    if is_dir {
        let _ = db::file_metadata::copy_metadata_dir(&conn, &src_path, &dest_path);
    } else {
        let old_id = generate_id(&src_path);
        let new_id = generate_id(&dest_path);
        let _ = db::file_metadata::copy_metadata(&conn, &old_id, &new_id, &dest_path);
    }

    // 2. 同步颜色数据库
    let color_db = app.state::<Arc<color_db::ColorDbPool>>().inner();
    let _ = color_db.copy_colors(&src_path, &dest_path);

    // [New] 3. 同步索引数据库 (file_index) - 这是解决启动降级的关键
    // 获取源文件的索引信息作为模板
    let src_normalized = normalize_path(&src_path);
    let dest_normalized = normalize_path(&dest_path);
    
    let mut conn_mut = app_db.get_connection(); // 需要可变连接用于 upsert
    
    if is_dir {
        // 如果是文件夹复制，逻辑较复杂，建议直接让下一次扫描处理，或者递归更新索引
        // 这里简单处理：清理掉目标路径的旧索引，迫使下次扫描该路径
        let _ = db::file_index::delete_entries_by_path(&conn_mut, &dest_normalized);
    } else {
        // 如果是单文件复制，我们直接插入一条新索引
        if let Ok(md) = fs::metadata(dest_p) {
            let new_id = generate_id(&dest_normalized);
            let file_name = dest_p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let ext = dest_p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
            
            // 尝试获取尺寸（如果之前有的话）
            let mut width = None;
            let mut height = None;
            let mut format = None;

            let all_entries = db::file_index::get_entries_under_path(&conn_mut, &src_normalized).unwrap_or_default();
            if let Some(src_entry) = all_entries.iter().find(|e| e.path == src_normalized) {
                width = src_entry.width;
                height = src_entry.height;
                format = src_entry.format.clone();
            }

            let new_entry = db::file_index::FileIndexEntry {
                file_id: new_id,
                parent_id: dest_p.parent().map(|p| generate_id(&normalize_path(p.to_str().unwrap_or("")))),
                path: dest_normalized,
                name: file_name,
                file_type: "Image".to_string(),
                size: md.len(),
                width, height, format: format.or(Some(ext)),
                created_at: md.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0),
                modified_at: md.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0),
            };
            
            let _ = db::file_index::batch_upsert(&mut conn_mut, &[new_entry]);
        }
    }

    Ok(())
}

// Command to delete a file or folder
#[tauri::command]
async fn delete_file(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let file_path = Path::new(&path);
    if file_path.is_dir() {
        // Delete directory recursively
        fs::remove_dir_all(file_path)
            .map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        // Delete file
        fs::remove_file(file_path)
            .map_err(|e| format!("Failed to delete file: {}", e))?;
    }

    // 同步清理数据库记录
    let app_db = app.state::<AppDbPool>();
    let conn = app_db.get_connection();
    let _ = db::file_index::delete_entries_by_path(&conn, &path);
    let _ = db::file_metadata::delete_metadata_by_path(&conn, &path);
    
    let color_db = app.state::<Arc<color_db::ColorDbPool>>().inner();
    let _ = color_db.delete_colors_by_path(&path);

    Ok(())
}


#[tauri::command]
async fn copy_image_colors(
    app: tauri::AppHandle,
    src_path: String,
    dest_path: String
) -> Result<bool, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner();
    eprintln!("[Cmd] copy_image_colors invoked: src='{}' dest='{}'", src_path, dest_path);
    match pool.copy_colors(&src_path, &dest_path) {
        Ok(b) => {
            eprintln!("[Cmd] copy_image_colors succeeded: src='{}' dest='{}' copied={}", src_path, dest_path, b);
            Ok(b)
        }
        Err(e) => {
            eprintln!("[Cmd] copy_image_colors failed: src='{}' dest='{}' error={}", src_path, dest_path, e);
            Err(e)
        }
    }
}

#[tauri::command]
async fn copy_image_to_clipboard(file_path: String) -> Result<(), String> {
    use arboard::Clipboard;
    use std::fs;
    
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    
    // Read image file bytes
    let image_bytes = fs::read(&file_path)
        .map_err(|e| format!("Failed to read image file: {}", e))?;
    
    // Try to load image and convert to RGBA
    let img = image::load_from_memory(&image_bytes)
        .map_err(|e| format!("Failed to load image: {}", e))?;
    
    let rgba_img = img.to_rgba8();
    let (width, height) = rgba_img.dimensions();
    let rgba_bytes = rgba_img.into_raw();
    
    // Create clipboard and set image
    // arboard expects RGBA format on all platforms
    let mut clipboard = Clipboard::new()
        .map_err(|e| format!("Failed to access clipboard: {}", e))?;
    
    let image_data = arboard::ImageData {
        width: width as usize,
        height: height as usize,
        bytes: rgba_bytes.into(),
    };
    
    clipboard.set_image(image_data)
        .map_err(|e| format!("Failed to copy image to clipboard: {}", e))?;
    
    Ok(())
}

#[tauri::command]
async fn copy_file(src_path: String, dest_path: String) -> Result<String, String> {
    let src = Path::new(&src_path);
    let mut dest = Path::new(&dest_path);
    
    // Check if source exists
    if !src.exists() {
        return Err(format!("Source does not exist: {}", src_path));
    }
    
    // Check if source is a file or directory
    let is_dir = src.is_dir();
    
    // Normalize paths for comparison
    let src_normalized = normalize_path(&src_path);
    let dest_normalized = normalize_path(&dest_path);
    
    // Check if source and destination are exactly the same path
    // For files: allow self-copy (will generate unique filename)
    // For directories: don't allow exact same path copy
    if src_normalized == dest_normalized {
        if is_dir {
            return Err(format!("Cannot copy directory to itself: {}", src_path));
        } else {
            // This is a file self-copy - generate a unique filename in the same directory
            println!("Copying file to the same directory, will generate unique filename");
        }
    }
    
    // For files, generate unique path if destination exists
    let final_dest_path = if !is_dir && dest.exists() {
        let unique_path = generate_unique_file_path(&dest_path);
        println!("Destination file exists, using unique path: {}", unique_path);
        unique_path
    } else {
        dest_path.clone()
    };
    
    dest = Path::new(&final_dest_path);
    
    // Create parent directory if it doesn't exist
    if let Some(dest_parent) = dest.parent() {
        if !dest_parent.exists() {
            fs::create_dir_all(dest_parent)
                .map_err(|e| format!("Failed to create destination directory: {}", e))?;
        }
    }
    
    println!("Copying {}: {} to {}", if is_dir { "directory" } else { "file" }, src_path, final_dest_path);
    
    // On Windows, use appropriate command based on source type
    // On other platforms, use standard fs operations
    #[cfg(windows)]
    {
        use std::process::Command;
        
        let max_retries = 3;
        let mut last_error: Option<std::io::Error> = None;
        
        for attempt in 0..max_retries {
            if is_dir {
                // Use robocopy for directory copying - call robocopy.exe directly
                let src_win = src_path.replace("/", "\\");
                let dest_win = final_dest_path.replace("/", "\\");
                
                // Call robocopy.exe directly with separate arguments to avoid quote escaping issues
                // /E: copy subdirectories, including empty ones
                // /NFL: no file list
                // /NDL: no directory list  
                // /NJH: no job header
                // /NJS: no job summary
                // /R:3: retry 3 times
                // /W:1: wait 1 second between retries
                println!("Attempt {}: Using robocopy: {} -> {}", attempt + 1, src_win, dest_win);
                
                let output = Command::new("robocopy")
                    .arg(&src_win)
                    .arg(&dest_win)
                    .arg("*")  // Copy all files
                    .arg("/E")
                    .arg("/NFL")
                    .arg("/NDL")
                    .arg("/NJH")
                    .arg("/NJS")
                    .arg("/R:3")
                    .arg("/W:1")
                    .output()
                    .map_err(|e| format!("Failed to execute robocopy command: {}", e))?;
                
                // robocopy returns 0-7, where 0-1 are success
                let exit_code = output.status.code().unwrap_or(0);
                if exit_code <= 1 {
                    println!("Directory copy succeeded");
                    let norm = normalize_path(&final_dest_path);
                    println!("Returning normalized path: {}", norm);
                    return Ok(norm);
                } else {
                    let stderr = String::from_utf8_lossy(&output.stderr);
                    let stdout = String::from_utf8_lossy(&output.stdout);
                    let error_msg = if !stderr.is_empty() { stderr } else { stdout };
                    println!("Robocopy attempt {} failed with code {}: {}", attempt + 1, exit_code, error_msg.trim());
                    last_error = Some(std::io::Error::new(std::io::ErrorKind::Other, error_msg.trim().to_string()));
                }
            } else {
                // Use Rust fs::copy for file copying - more reliable than Windows copy command
                println!("Attempt {}: Using fs::copy: {} -> {}", attempt + 1, src_path, final_dest_path);
                    match fs::copy(src, dest) {
                    Ok(_) => {
                        println!("File copy succeeded");
                        let norm = normalize_path(&final_dest_path);
                        println!("Returning normalized path: {}", norm);
                        return Ok(norm);
                    }
                    Err(e) => {
                        println!("fs::copy attempt {} failed: {:?}", attempt + 1, e);
                        last_error = Some(e);
                    }
                }
            }
            
            // Wait before retrying
            if attempt < max_retries - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
        
        // If all retries failed, return the last error
        if let Some(e) = last_error {
            return Err(format!("Failed to copy after {} attempts: {}", max_retries, e));
        }
    }
    
    // For non-Windows platforms
    #[cfg(not(windows))]
    {
        let max_retries = 3;
        let mut last_error: Option<std::io::Error> = None;
        
        for attempt in 0..max_retries {
            if is_dir {
                // Use fs::copy_dir_all for directory copying
                match fs::copy_dir_all(src, dest) {
                    Ok(_) => {
                        let norm = normalize_path(&final_dest_path);
                        println!("Returning normalized path: {}", norm);
                        return Ok(norm);
                    },
                    Err(e) => {
                        println!("copy_dir_all attempt {} failed: {:?}", attempt + 1, e);
                        last_error = Some(e);
                    }
                }
            } else {
                // Use fs::copy for file copying
                match fs::copy(src, dest) {
                    Ok(_) => {
                        let norm = normalize_path(&final_dest_path);
                        println!("Returning normalized path: {}", norm);
                        return Ok(norm);
                    },
                    Err(e) => {
                        last_error = Some(e);
                        println!("fs::copy attempt {} failed: {:?}", attempt + 1, e);
                    }
                }
            }
            
            // Wait before retrying
            if attempt < max_retries - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
        
        // If all retries failed, return the last error
        if let Some(e) = last_error {
            return Err(format!("Failed to copy after {} attempts: {}", max_retries, e));
        }
    }
    
    // This should never be reached
    Err("Unknown error occurred while copying".to_string())
}

#[tauri::command]
async fn move_file(src_path: String, dest_path: String, app: tauri::AppHandle) -> Result<(), String> {
    let src = Path::new(&src_path);
    let dest = Path::new(&dest_path);
    
    // Check if source exists
    if !src.exists() {
        return Err(format!("源文件不存在: {}", src_path));
    }
    
    let is_dir = src.is_dir();

    // Create dest directory if it doesn't exist
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目标目录失败: {}", e))?;
        }
    }
    
    // Try to move file with retry mechanism
    let max_retries = 3;
    let mut success = false;
    let mut last_error: Option<std::io::Error> = None;

    for _attempt in 0..max_retries {
        match fs::rename(src, dest) {
            Ok(_) => {
                success = true;
                break;
            },
            Err(e) => {
                last_error = Some(e);
                tokio::time::sleep(tokio::time::Duration::from_millis(200)).await;
            }
        }
    }
    
    // 如果 rename 失败且不是目录，尝试 copy + delete 兜底
    if !success && !is_dir {
        if let Ok(_) = fs::copy(src, dest) {
            if let Ok(_) = fs::remove_file(src) {
                success = true;
            } else {
                let _ = fs::remove_file(dest); // 清理副本
            }
        }
    }
    
    if !success {
        return Err(format!("无法移动文件/文件夹 (可能被锁定或跨卷): {:?}", last_error));
    }

    // 物理移动成功后，同步迁移元数据 (避免竞态条件)
    // 之前使用 spawn_blocking，导致前端可能在数据库更新前就扫描到新位置的文件
    // 从而触发重复提取。现在改为同步执行。
    let app_db = app.state::<AppDbPool>();
    if is_dir {
        let mut conn = app_db.get_connection();
        let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;
        
        let _ = db::file_index::migrate_index_dir(&tx, &src_path, &dest_path);
        let _ = db::file_metadata::migrate_metadata_dir(&tx, &src_path, &dest_path);
        
        tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    } else {
        let old_id = generate_id(&src_path);
        let new_id = generate_id(&dest_path);
        let mut conn = app_db.get_connection();
        let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;

        let _ = db::file_index::migrate_index_dir(&tx, &src_path, &dest_path);
        let _ = db::file_metadata::migrate_metadata(&tx, &old_id, &new_id, &dest_path);
        
        tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    }
    
    let color_db = app.state::<Arc<color_db::ColorDbPool>>().inner();
    let _ = color_db.move_colors(&src_path, &dest_path);
    
    Ok(())
}

#[tauri::command]
async fn write_file_from_bytes(file_path: String, bytes: Vec<u8>, app: tauri::AppHandle) -> Result<(), String> {
    use std::io::Write;
    
    let path = Path::new(&file_path);
    
    // Create parent directory if it doesn't exist
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }
    
    // Write file with retry mechanism
    let max_retries = 3;
    let mut attempt = 0;
    let mut last_error: Option<std::io::Error> = None;
    
    while attempt < max_retries {
        match fs::File::create(path) {
            Ok(mut file) => {
                match file.write_all(&bytes) {
                    Ok(_) => {
                        // 同步更新索引数据库
                        let app_db = app.state::<AppDbPool>();
                        let mut conn = app_db.get_connection();
                        let normalized_path = normalize_path(&file_path);
                        let id = generate_id(&normalized_path);
                        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                        let ext = path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
                        let md = fs::metadata(path).ok();

                        if is_supported_image(&ext) {
                            let entry = db::file_index::FileIndexEntry {
                                file_id: id,
                                parent_id: path.parent().map(|p| generate_id(&normalize_path(p.to_str().unwrap_or("")))),
                                path: normalized_path,
                                name,
                                file_type: "Image".to_string(),
                                size: md.as_ref().map(|m| m.len()).unwrap_or(0),
                                width: None, height: None, format: Some(ext),
                                created_at: md.as_ref().and_then(|m| m.created().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0),
                                modified_at: md.as_ref().and_then(|m| m.modified().ok()).and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0),
                            };
                            let _ = db::file_index::batch_upsert(&mut conn, &[entry]);
                        }
                        return Ok(());
                    },
                    Err(e) => {
                        attempt += 1;
                        last_error = Some(e);
                        if attempt < max_retries {
                            tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                        }
                    }
                }
            },
            Err(e) => {
                attempt += 1;
                last_error = Some(e);
                if attempt < max_retries {
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }
        }
    }
    
    if let Some(e) = last_error {
        Err(format!("Failed to write file after {} attempts: {}", max_retries, e))
    } else {
        Err("Unknown error occurred while writing file".to_string())
    }
}

#[tauri::command]
async fn get_default_paths() -> Result<HashMap<String, String>, String> {
    use std::env;
    
    let mut paths = HashMap::new();
    
    // Get user's home directory
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| "C:\\Users\\User".to_string());
    
    // Default resource root (Pictures folder)
    let resource_root = if cfg!(windows) {
        format!("{}\\Pictures\\AuroraGallery", home)
    } else if cfg!(target_os = "macos") {
        format!("{}/Pictures/AuroraGallery", home)
    } else {
        format!("{}/Pictures/AuroraGallery", home)
    };
    
    // Default cache root
    let cache_root = if cfg!(windows) {
        format!("{}\\AppData\\Local\\Aurora\\Cache", home)
    } else if cfg!(target_os = "macos") {
        format!("{}/Library/Application Support/Aurora/Cache", home)
    } else {
        format!("{}/.local/share/aurora/cache", home)
    };
    
    paths.insert("resourceRoot".to_string(), resource_root);
    paths.insert("cacheRoot".to_string(), cache_root);
    
    Ok(paths)
}

#[tauri::command]
async fn open_path(path: String, is_file: Option<bool>) -> Result<(), String> {
    use std::process::Command;
    use std::path::Path;
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    
    // 规范化路径：确保使用正确的路径分隔符，并转换为绝对路径
    let path_obj = Path::new(&path);
    
    // 检查路径是否存在
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    // 如果路径是相对路径，尝试转换为绝对路径
    let absolute_path = if path_obj.is_absolute() {
        path.clone()
    } else {
        match std::env::current_dir() {
            Ok(current_dir) => {
                match path_obj.canonicalize() {
                    Ok(canonical) => canonical.to_string_lossy().to_string(),
                    Err(_) => {
                        // 如果无法规范化，尝试组合当前目录和路径
                        current_dir.join(path_obj).to_string_lossy().to_string()
                    }
                }
            }
            Err(_) => path.clone(),
        }
    };
    
    // 使用绝对路径创建Path对象，确保所有后续操作都基于绝对路径
    let abs_path_obj = Path::new(&absolute_path);
    
    // 是否是从右键菜单（上下文菜单）调用的
    // is_file 为 Some 时表示从文件列表/文件夹树的右键菜单调用
    // is_file 为 None 时表示从设置面板等地方直接打开文件夹
    let is_context_menu = is_file.is_some();
    
    println!("open_path: path={}, is_file={:?}, is_context_menu={}", 
             path, is_file, is_context_menu);
    
    // 直接使用系统命令打开文件管理器，但不等待命令完成，避免阻塞和闪退问题
    let result = if cfg!(windows) {
        #[cfg(target_os = "windows")]
        {
            // Windows: 使用 explorer.exe
            // 将正斜杠转换为反斜杠，确保 Windows 能够正确识别路径
            let win_path = absolute_path.replace("/", "\\");
            
            if is_context_menu {
                // 如果是右键菜单调用，使用 /select 选项在文件管理器中选中该文件/文件夹
                // 对路径进行安全处理：去除尾部的反斜杠（如果是文件夹）
                let clean_path = win_path.trim_end_matches('\\');
                
                // 使用 raw_arg 手动构建参数，确保 /select 格式正确
                // 我们在 /select, 后面加一个空格，并用引号包裹路径，这是最兼容的格式
                // 格式：/select, "C:\Path\To\File"
                let raw_arg = format!("/select, \"{}\"", clean_path);
                
                println!("Windows command: explorer.exe [raw_arg] {}", raw_arg);
                
                Command::new("explorer.exe")
                    .raw_arg(raw_arg)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .stdin(std::process::Stdio::null())
                    .spawn()
                    .map(|_| ())
            } else {
                // 否则直接打开该路径
                println!("Windows command: explorer.exe \"{}\"", win_path);
                Command::new("explorer.exe")
                    .arg(win_path)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .stdin(std::process::Stdio::null())
                    .spawn()
                    .map(|_| ())
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
             // Fallback for non-windows if cross-compiling (shouldn't happen here due to outer if)
             Ok(())
        }
    } else if cfg!(target_os = "macos") {
        // macOS: 使用 open 命令
        if is_context_menu {
            // 使用 -R 参数在 Finder 中显示并选中
            println!("macOS command: open -R \"{}\"", absolute_path);
            Command::new("open")
                .arg("-R")
                .arg(&absolute_path)
                .spawn()
                .map(|_| ())
        } else {
            println!("macOS command: open \"{}\"", absolute_path);
            Command::new("open")
                .arg(&absolute_path)
                .spawn()
                .map(|_| ())
        }
    } else {
        // Linux: 使用 xdg-open 命令
        // Linux 下 xdg-open 不支持选中文件，如果是文件则打开其父目录
        let target_path = if is_context_menu {
            match abs_path_obj.parent() {
                Some(parent) => parent.to_string_lossy().to_string(),
                None => absolute_path.clone(),
            }
        } else {
            absolute_path.clone()
        };
        
        println!("Linux command: xdg-open \"{}\"", target_path);
        Command::new("xdg-open")
            .arg(target_path)
            .spawn()
            .map(|_| ())
    };
    
    match result {
        Ok(_) => {
            println!("Successfully started file manager for path: {}", absolute_path);
            Ok(())
        },
        Err(e) => {
            let error_msg = format!("Failed to start file manager for '{}': {}", absolute_path, e);
            println!("{}", error_msg);
            Err(error_msg)
        }
    }
}



#[tauri::command]
async fn read_file_as_base64(file_path: String) -> Result<Option<String>, String> {
    use std::fs;
    
    // Check if file exists
    if !Path::new(&file_path).exists() {
        return Ok(None);
    }
    
    // Read file as bytes
    let file_bytes = fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    // Detect image format from file extension
    let extension = Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    
    // Determine MIME type based on extension
    let mime_type = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        _ => "image/jpeg", // Default to JPEG
    };
    
    // Encode to base64
    let base64_str = general_purpose::STANDARD.encode(&file_bytes);
    Ok(Some(format!("data:{};base64,{}", mime_type, base64_str)))
}

// 窗口控制命令
#[tauri::command]
async fn hide_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    save_window_state(&app_handle);
    let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
async fn show_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_window_min_size(app_handle: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
    window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize { width, height })))
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn exit_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    save_window_state(&app_handle);
    app_handle.exit(0);
    Ok(())
}

// 手动执行WAL检查点
#[tauri::command]
async fn force_wal_checkpoint(app: tauri::AppHandle) -> Result<bool, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    // 在单独线程中执行WAL检查点
    let result = tokio::task::spawn_blocking(move || {
        pool.force_wal_checkpoint()
    }).await.map_err(|e| format!("Failed to execute WAL checkpoint: {}", e))?;
    
    result.map_err(|e| format!("WAL checkpoint error: {}", e))?;
    Ok(true)
}

// 获取WAL文件信息
#[tauri::command]
async fn get_wal_info(app: tauri::AppHandle) -> Result<(i64, i64), String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    // 在单独线程中获取WAL信息
    let result = tokio::task::spawn_blocking(move || {
        pool.get_wal_info()
    }).await.map_err(|e| format!("Failed to get WAL info: {}", e))?;
    
    result
}

#[tauri::command]
async fn save_user_data(app_handle: tauri::AppHandle, data: serde_json::Value) -> Result<bool, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    
    let config_path = app_data_dir.join("user_data.json");
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())?;
    
    Ok(true)
}

#[tauri::command]
async fn load_user_data(app_handle: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_path = app_data_dir.join("user_data.json");
    
    if !config_path.exists() {
        return Ok(None);
    }
    
    let json_str = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let data = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    
    Ok(Some(data))
}

#[tauri::command]
fn db_get_all_people(pool: tauri::State<AppDbPool>) -> Result<Vec<db::persons::Person>, String> {
    let conn = pool.get_connection();
    db::persons::get_all_people(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_upsert_person(pool: tauri::State<AppDbPool>, person: db::persons::Person) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::upsert_person(&conn, &person).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_delete_person(pool: tauri::State<AppDbPool>, id: String) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::delete_person(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_update_person_avatar(
    pool: tauri::State<AppDbPool>,
    person_id: String,
    cover_file_id: String,
    face_box: Option<db::persons::FaceBox>
) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::update_person_avatar(&conn, &person_id, &cover_file_id, face_box.as_ref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_get_all_topics(pool: tauri::State<AppDbPool>) -> Result<Vec<db::topics::Topic>, String> {
    let conn = pool.get_connection();
    db::topics::get_all_topics(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_upsert_topic(pool: tauri::State<AppDbPool>, topic: db::topics::Topic) -> Result<(), String> {
    let conn = pool.get_connection();
    db::topics::upsert_topic(&conn, &topic).map_err(|e| e.to_string())
}

#[tauri::command]
fn db_delete_topic(pool: tauri::State<AppDbPool>, id: String) -> Result<(), String> {
    let conn = pool.get_connection();
    db::topics::delete_topic(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn db_upsert_file_metadata(
    pool: tauri::State<'_, AppDbPool>, 
    mut metadata: db::file_metadata::FileMetadata
) -> Result<(), String> {
    // Ensure path is normalized before saving, so that get_metadata_under_path (which uses LIKE 'path/%') works correctly
    metadata.path = normalize_path(&metadata.path);
    
    let conn = pool.get_connection();
    db::file_metadata::upsert_file_metadata(&conn, &metadata).map_err(|e| e.to_string())
}

#[tauri::command]
async fn switch_root_database(
    new_root_path: String,
    app_db_pool: tauri::State<'_, AppDbPool>,
    color_db_pool: tauri::State<'_, Arc<color_db::ColorDbPool>>,
) -> Result<(), String> {
    let root = Path::new(&new_root_path);
    
    // 我们将数据库存储在根目录下的 .aurora 文件夹中
    let aurora_dir = root.join(".aurora");
    
    let metadata_db_path = aurora_dir.join("metadata.db");
    let colors_db_path = aurora_dir.join("colors.db");
    
    // 切换元数据数据库
    app_db_pool.switch(&metadata_db_path)?;
    
    // 切换颜色数据库
    color_db_pool.switch(&colors_db_path)?;
    
    // 重新启动缓存预热（可选，因为 switch 已经标记为未初始化）
    let _ = color_db_pool.ensure_cache_initialized_async();
    
    Ok(())
}

// 获取主色调数据库统计信息
#[tauri::command]
async fn get_color_db_stats(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        
        let total = color_db::get_pending_files_count(&mut conn).unwrap_or(0)
            + color_db::get_processing_files_count(&mut conn).unwrap_or(0)
            + color_db::get_extracted_files_count(&mut conn).unwrap_or(0)
            + color_db::get_error_files_count(&mut conn).unwrap_or(0);
        
        let extracted = color_db::get_extracted_files_count(&mut conn).unwrap_or(0);
        let error = color_db::get_error_files_count(&mut conn).unwrap_or(0);
        let pending = color_db::get_pending_files_count(&mut conn).unwrap_or(0);
        let processing = color_db::get_processing_files_count(&mut conn).unwrap_or(0);
        
        // 获取数据库文件大小
        let (db_size, wal_size) = pool.get_db_file_sizes().unwrap_or((0, 0));
        
        serde_json::json!({
            "total": total,
            "extracted": extracted,
            "error": error,
            "pending": pending,
            "processing": processing,
            "dbSize": db_size,
            "walSize": wal_size
        })
    }).await.map_err(|e| format!("Failed to get color db stats: {}", e))?;
    
    Ok(result)
}

// 获取错误文件列表
#[tauri::command]
async fn get_color_db_error_files(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        // 使用新的清理函数，自动删除不存在的文件记录
        let error_files = color_db::cleanup_nonexistent_error_files(&mut conn)
            .unwrap_or_default();

        error_files.into_iter().map(|(path, timestamp)| {
            serde_json::json!({
                "path": path,
                "timestamp": timestamp
            })
        }).collect::<Vec<_>>()
    }).await.map_err(|e| format!("Failed to get error files: {}", e))?;

    Ok(result)
}

// 重新处理错误文件
#[tauri::command]
async fn retry_color_extraction(
    app: tauri::AppHandle,
    file_paths: Option<Vec<String>>
) -> Result<usize, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        
        // 将错误文件重置为待处理状态
        let reset_count = if let Some(paths) = file_paths.as_ref() {
            color_db::reset_error_files_to_pending(&mut conn, Some(paths))
        } else {
            color_db::reset_error_files_to_pending(&mut conn, None)
        };
        
        reset_count
    }).await.map_err(|e| format!("Failed to retry color extraction: {}", e))?;
    
    result.map_err(|e| e)
}

// 从数据库中删除错误文件记录
#[tauri::command]
async fn delete_color_db_error_files(
    app: tauri::AppHandle,
    file_paths: Vec<String>
) -> Result<usize, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        
        // 删除错误文件记录
        color_db::delete_error_files(&mut conn, &file_paths)
    }).await.map_err(|e| format!("Failed to delete color db error files: {}", e))?;
    
    result.map_err(|e| e)
}


fn main() {
    
    tauri::Builder::default()
        // 清理调试阶段的 setup 注入，恢复默认构建
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(
            tauri_plugin_log::Builder::default()
                .level(log::LevelFilter::Info)
                .build()
        )
        .plugin(tauri_plugin_drag::init())
        .invoke_handler(tauri::generate_handler![
            save_user_data,
            load_user_data,
            search_by_palette,
            search_by_color,
            scan_directory,
            db_copy_file_metadata,
            force_rescan,
            add_pending_files_to_db,
            get_default_paths,
            get_thumbnail,
            get_thumbnails_batch,
            save_remote_thumbnail,
            get_avif_preview,
            get_jxl_preview,
            generate_drag_preview,
            read_file_as_base64,
            ensure_directory,
            file_exists,
            open_path,
            create_folder,
            rename_file,
            delete_file,
            copy_file,
            copy_image_colors,
            move_file,
            write_file_from_bytes,
            scan_file,
            hide_window,
            show_window,
            set_window_min_size,
            exit_app,
            get_dominant_colors,
            color_worker::pause_color_extraction,
            color_worker::resume_color_extraction,
            force_wal_checkpoint,
            get_wal_info,
            db_get_all_people,
            db_upsert_person,
            db_delete_person,
            db_update_person_avatar,
            db_get_all_topics,
            db_upsert_topic,
            db_delete_topic,
            db_upsert_file_metadata,
            db_copy_file_metadata,
            switch_root_database,
            copy_image_to_clipboard,
            get_color_db_stats,
            get_color_db_error_files,
            retry_color_extraction,
            delete_color_db_error_files
        ])
        .setup(|app| {
            // 创建托盘菜单
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            
            // 获取应用句柄用于事件处理
            let app_handle = app.handle().clone();
            
            // 创建托盘图标
            let tray_icon = app.default_window_icon()
                .cloned()
                .ok_or_else(|| {
                    eprintln!("Warning: No default window icon found, tray icon may not display correctly");
                    "No default window icon"
                });
            
            let tray = TrayIconBuilder::new()
                .tooltip("Aurora Gallery")
                .icon(match tray_icon {
                    Ok(icon) => icon,
                    Err(_) => {
                        // 如果获取失败，尝试继续创建托盘（可能没有图标）
                        return Ok(());
                    }
                })
                .menu(&menu)
                .show_menu_on_left_click(false) // 禁用左键点击显示菜单，只有右键才显示
                .on_menu_event(move |app, event| {
                    match event.id.as_ref() {
                        "show" => {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        "quit" => {
                            app.exit(0);
                        }
                        _ => {}
                    }
                })
                .on_tray_icon_event(move |_tray, event| {
                    // 处理托盘图标的鼠标事件
                    match event {
                        TrayIconEvent::DoubleClick { .. } => {
                            // 双击显示窗口
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                        _ => {
                            // 单击不触发任何操作
                        }
                    }
                })
                .build(app)?;
            
            // 保存托盘图标到应用状态
            app.manage(Some(tray));
            
            // 获取数据库路径（如果有保存的根目录，则使用其下的 .aurora 文件夹）
            let (db_path, app_db_path) = get_initial_db_paths(app.handle());
            
            // 初始化颜色数据库
            let pool = match color_db::ColorDbPool::new(&db_path) {
        Ok(pool_instance) => {
            // 初始化数据库表结构
            {
                let mut conn = pool_instance.get_connection();
                if let Err(e) = color_db::init_db(&mut conn) {
                    eprintln!("Failed to initialize color database: {}", e);
                }
                
                // 清理卡在"processing"状态的文件
                if let Err(e) = color_db::reset_processing_to_pending(&mut conn) {
                    eprintln!("Failed to reset processing files to pending: {}", e);
                }
            }
            // 异步分批预热（懒加载）：在后台逐步加载，避免启动阻塞/峰值 I/O
            if let Err(e) = pool_instance.ensure_cache_initialized_async() {
                eprintln!("Failed to start background color cache preheat: {}", e);
            }

            // 记录初始化后的数据库文件大小
            if let Err(e) = pool_instance.get_db_file_sizes() {
                eprintln!("Failed to get database file sizes: {}", e);
            }
            pool_instance
        },
        Err(e) => {
            eprintln!("Failed to create color database connection pool: {}", e);
            panic!("Failed to create color database connection pool: {}", e);
        }
    };
            
            // 将数据库连接池保存到应用状态
            let pool_arc = Arc::new(pool);
            app.manage(pool_arc.clone());

            // 初始化应用通用数据库 (Metadata/Persons)
            let app_db_pool = match AppDbPool::new(&app_db_path) {
                Ok(pool) => {
                    // Limit the scope of the connection guard so it is dropped
                    // before we move the pool out of this match arm.
                    {
                        let conn = pool.get_connection();
                        if let Err(e) = db::init_db(&conn) {
                             eprintln!("Failed to initialize app database: {}", e);
                        }
                    }
                    pool
                },
                Err(e) => {
                    panic!("Failed to create app database pool: {}", e);
                }
            };
            app.manage(app_db_pool);
            
            // 启动后台颜色提取任务
            // 持续处理待处理文件，每批最多处理50个文件
            let batch_size = 50;
            // 正确克隆AppHandle后再包装到Arc中
            let app_handle_new = app.handle().clone();
            let app_handle_arc = Arc::new(app_handle_new);

            // 获取缓存目录路径
            let cache_root = {
                let home = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .ok();
                
                home.map(|h| {
                    if cfg!(windows) {
                        Path::new(&h).join("AppData").join("Local").join("Aurora").join("Cache")
                    } else if cfg!(target_os = "macos") {
                        Path::new(&h).join("Library").join("Application Support").join("Aurora").join("Cache")
                    } else {
                        Path::new(&h).join(".local").join("share").join("aurora").join("cache")
                    }
                })
            };
            
            tauri::async_runtime::spawn(async move {
                color_worker::color_extraction_worker(
                    pool_arc,
                    batch_size,
                    Some(app_handle_arc),
                    cache_root
                ).await;
            });
            
            // 恢复窗口位置和大小
            if let Some(window) = app.get_webview_window("main") {
                let app_handle_for_state = app.handle();
                let path = get_window_state_path(app_handle_for_state);
                let mut state_restored = false;
                if path.exists() {
                    if let Ok(json) = fs::read_to_string(&path) {
                        if let Ok(state) = serde_json::from_str::<SavedWindowState>(&json) {
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: state.width, height: state.height }));
                            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: state.x, y: state.y }));
                            if state.maximized {
                                let _ = window.maximize();
                            }
                            state_restored = true;
                        }
                    }
                }

                if !state_restored {
                    let _ = window.center();
                }
                let _ = window.show();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                // 保存窗口状态
                save_window_state(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
