// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::fs;
use std::num::NonZeroU32;
use std::sync::Arc;
use tauri::Manager;
use tauri::Emitter;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};
use serde_json;
use rusqlite::params; // Import params macro


use base64::{Engine as _, engine::general_purpose};
use fast_image_resize as fr;
use rayon::prelude::*;
use palette::{FromColor, Srgb, Lab};
use palette::color_difference::Ciede2000;

// 导入颜色相关模块
mod color_extractor;
mod color_db;
mod color_worker;
mod db;
mod color_search;
mod thumbnail;

use crate::thumbnail::{process_single_thumbnail, get_thumbnail, get_thumbnails_batch, generate_drag_preview, BatchResult, ThumbnailBatchResult};
use crate::color_search::{hex_to_lab, search_by_palette, search_by_color};

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

#[derive(Debug, Clone, Serialize, Deserialize)]
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
    pub ai_data: Option<serde_json::Value>,
}

// Supported image extensions
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "ico", "svg",
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
async fn scan_directory(path: String, force_rescan: Option<bool>, app: tauri::AppHandle) -> Result<HashMap<String, FileNode>, String> {
    use std::fs;
    use std::io::{Read, BufReader};
    use rayon::prelude::*;
    
    let force = force_rescan.unwrap_or(false);
    let root_path = Path::new(&path);
    
    // Check if path exists and is a directory
    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    if !root_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
    }

    // Load metadata from database
    let metadatas = {
        let pool = app.state::<AppDbPool>();
        let conn = pool.get_connection();
        db::file_metadata::get_all_metadata(&conn).map_err(|e| e.to_string())?
    };
    let metadata_map: HashMap<String, db::file_metadata::FileMetadata> = metadatas
        .into_iter()
        .map(|m| (m.file_id.clone(), m))
        .collect();

    // Normalized path for DB queries
    let normalized_root_path = normalize_path(&path);

    // Check file_index cache
    {
        let pool = app.state::<AppDbPool>();
        let conn = pool.get_connection();
        let index_entries = db::file_index::get_entries_under_path(&conn, &normalized_root_path).map_err(|e| e.to_string())?;

        if !force && !index_entries.is_empty() {
            // Inform frontend we are returning cached result
            #[derive(Clone, Serialize)]
            struct ScanMode {
                mode: String,
                count: usize,
            }
            let _ = app.emit("scan-mode", ScanMode { mode: "cache".to_string(), count: index_entries.len() });

            // Build FileNode map from index entries and merge metadata
            let mut all_files: HashMap<String, FileNode> = HashMap::new();

            for entry in index_entries.iter() {
                let file_type = match entry.file_type.as_str() {
                    "Image" => FileType::Image,
                    "Folder" => FileType::Folder,
                    _ => FileType::Unknown,
                };

                let meta = if matches!(file_type, FileType::Image) {
                    entry.width.map(|w| ImageMeta {
                        width: w,
                        height: entry.height.unwrap_or(0),
                        size_kb: (entry.size / 1024) as u32,
                        created: chrono::DateTime::from_timestamp(entry.created_at, 0).map(|dt| dt.to_rfc3339()).unwrap_or_default(),
                        modified: chrono::DateTime::from_timestamp(entry.modified_at, 0).map(|dt| dt.to_rfc3339()).unwrap_or_default(),
                        format: entry.format.clone().unwrap_or_default(),
                    })
                } else {
                    None
                };

                let node = FileNode {
                    id: entry.file_id.clone(),
                    parent_id: entry.parent_id.clone(),
                    name: entry.name.clone(),
                    r#type: file_type.clone(),
                    path: entry.path.clone(),
                    size: Some(entry.size),
                    children: if matches!(file_type, FileType::Folder) { Some(Vec::new()) } else { None },
                    tags: Vec::new(),
                    created_at: chrono::DateTime::from_timestamp(entry.created_at, 0).map(|dt| dt.to_rfc3339()),
                    updated_at: chrono::DateTime::from_timestamp(entry.modified_at, 0).map(|dt| dt.to_rfc3339()),
                    url: None,
                    meta,
                    description: None,
                    source_url: None,
                    ai_data: None,
                };

                all_files.insert(node.id.clone(), node);
            }

            // Build parent-child relationships
            let mut children_to_add: Vec<(String, String)> = Vec::new();
            for (id, node) in all_files.iter() {
                if let Some(parent_id) = &node.parent_id {
                    children_to_add.push((parent_id.clone(), id.clone()));
                }
            }
            for (parent_id, child_id) in children_to_add {
                if let Some(parent_node) = all_files.get_mut(&parent_id) {
                    if let Some(children) = &mut parent_node.children {
                        children.push(child_id);
                    }
                }
            }

            // Merge file metadata table (tags, description, etc.)
            for (file_id, meta) in metadata_map.iter() {
                if let Some(node) = all_files.get_mut(file_id) {
                    if let Some(tags_val) = &meta.tags {
                        if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) {
                            node.tags = tags_vec;
                        }
                    }
                    node.description = meta.description.clone();
                    node.source_url = meta.source_url.clone();
                    node.ai_data = meta.ai_data.clone();
                }
            }

            // Ensure root node exists
            let root_id = generate_id(&path);
            if !all_files.contains_key(&root_id) {
                let root_metadata = fs::metadata(root_path).map_err(|e| format!("Failed to read root directory: {}", e))?;
                let root_name = root_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("Root")
                    .to_string();
                let root_node = FileNode {
                    id: root_id.clone(),
                    parent_id: None,
                    name: root_name,
                    r#type: FileType::Folder,
                    path: normalize_path(&path),
                    size: None,
                    children: Some(Vec::new()),
                    tags: Vec::new(),
                    created_at: root_metadata
                        .created()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
                        .map(|dt| dt.to_rfc3339()),
                    updated_at: root_metadata
                        .modified()
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
                        .map(|dt| dt.to_rfc3339()),
                    url: None,
                    meta: None,
                    description: None,
                    source_url: None,
                    ai_data: None,
                };

                all_files.insert(root_id.clone(), root_node);
            }

            return Ok(all_files);
        } else {
            // Emit full scan mode
            #[derive(Clone, Serialize)]
            struct ScanModeSimple { mode: String }
            let _ = app.emit("scan-mode", ScanModeSimple { mode: "full".to_string() });
        }
    }
    
    let mut all_files: HashMap<String, FileNode> = HashMap::new();
    
    // Get root directory metadata
    let root_metadata = match fs::metadata(root_path) {
        Ok(m) => m,
        Err(e) => return Err(format!("Failed to read root directory: {}", e)),
    };
    
    let root_id = generate_id(&path);
    let root_name = root_path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("Root")
        .to_string();
    
    // Create root directory node
    let root_node = FileNode {
        id: root_id.clone(),
        parent_id: None,
        name: root_name,
        r#type: FileType::Folder,
        path: normalize_path(&path),
        size: None,
        children: Some(Vec::new()),
        tags: Vec::new(),
        created_at: root_metadata
            .created()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
            .map(|dt| dt.to_rfc3339()),
        updated_at: root_metadata
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0))
            .map(|dt| dt.to_rfc3339()),
        url: None,
        meta: None,
        description: None,
        source_url: None,
        ai_data: None,
    };
    
    all_files.insert(root_id.clone(), root_node.clone());
    
    // Use jwalk for parallel directory traversal
    let normalized_root_path = normalize_path(&path);
    
    // Build path -> id mapping (will be populated as we process entries)
    // Stable ID: Pre-load existing IDs from database for this directory and subdirectories
    let mut path_to_id: HashMap<String, String> = HashMap::new();
    path_to_id.insert(normalized_root_path.clone(), root_id.clone());

    {
        let app_db = app.state::<AppDbPool>();
        let conn = app_db.get_connection();
        let root_prefix = if normalized_root_path.ends_with('/') { normalized_root_path.clone() } else { format!("{}/", normalized_root_path) };
        let pattern = format!("{}%", root_prefix);
        
        if let Ok(mut stmt) = conn.prepare("SELECT path, file_id FROM file_index WHERE path LIKE ?") {
            if let Ok(rows) = stmt.query_map(params![pattern], |row| {
                Ok((row.get::<usize, String>(0)?, row.get::<usize, String>(1)?))
            }) {
                for row in rows {
                    if let Ok((p, id)) = row {
                        path_to_id.insert(p, id);
                    }
                }
            }
        };
    }
    
    // Process entries in parallel using jwalk (streaming)
    // First run a fast counting pass (parallel but synchronous) to compute an accurate total before streaming detailed nodes.
    let (tx, rx) = crossbeam_channel::unbounded::<(String, FileNode, String)>();
    let producer_path = path.clone();
    
    // Clone path_to_id for the producer thread (read-only access)
    let existing_ids = Arc::new(path_to_id.clone());

    // Fast synchronous counting pass (parallel iterator) to get accurate total quickly
    let root_path_local = Path::new(&path);
    let fast_total: usize = jwalk::WalkDir::new(&path)
        .into_iter()
        .par_bridge()
        .filter_map(|entry_result| {
            let entry = match entry_result {
                Ok(e) => e,
                Err(_) => return None,
            };

            let entry_path = entry.path();
            if entry_path == root_path_local {
                return None;
            }

            // Skip hidden and cache files
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("");

            if entry_path.components().any(|c| c.as_os_str() == ".Aurora_Cache") {
                return None;
            }

            if file_name.starts_with('.') && file_name != ".pixcall" {
                return None;
            }

            let extension = entry_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();

            if is_supported_image(&extension) {
                Some(1usize)
            } else {
                None
            }
        })
        .count();

    // Emit initial total immediately so the UI can show determinate progress
    let mut total_images = fast_total;
    let processed_images = 0usize;
    #[derive(Serialize, Clone)]
    struct ScanProgress {
        processed: usize,
        total: usize,
    }
    let _ = app.emit("scan-progress", ScanProgress { processed: processed_images, total: total_images });

    // Producer: full node producer (heavy work: read image dimensions, metadata)
    std::thread::spawn(move || {
        let normalized_root = normalize_path(&producer_path);
        let root_path_local = Path::new(&producer_path);

        jwalk::WalkDir::new(&producer_path)
            .into_iter()
            .par_bridge()
            .filter_map(|entry_result| {
                let entry = match entry_result {
                    Ok(e) => e,
                    Err(_) => return None,
                };

                let entry_path = entry.path();

                // Skip root directory itself
                if entry_path == root_path_local {
                    return None;
                }

                // Skip hidden files (except .pixcall)
                let file_name = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("");

                // Skip .Aurora_Cache folder and its contents
                if entry_path.components().any(|c| c.as_os_str() == ".Aurora_Cache") {
                    return None;
                }

                if file_name.starts_with('.') && file_name != ".pixcall" {
                    return None;
                }

                let full_path = normalize_path(entry_path.to_str().unwrap_or(""));

                // Get metadata
                let metadata = match entry.metadata() {
                    Ok(m) => m,
                    Err(_) => return None,
                };

                // Get parent path directly from entry_path (thread-safe)
                let parent_path = if let Some(parent) = entry_path.parent() {
                    normalize_path(parent.to_str().unwrap_or(""))
                } else {
                    normalized_root.clone()
                };

                // Stable ID: Reuse existing ID if available, otherwise generate new one
                let file_id = if let Some(id) = existing_ids.get(&full_path) {
                    id.clone()
                } else {
                    generate_id(&full_path)
                };
                let file_name = entry_path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("")
                    .to_string();

                // Check if it's a directory
                let is_directory = metadata.is_dir();

                if is_directory {
                    // Create folder node (parent_id will be set later)
                    let folder_node = FileNode {
                        id: file_id.clone(),
                        parent_id: None, // Will be set later
                        name: file_name,
                        r#type: FileType::Folder,
                        path: full_path.clone(),
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
                        ai_data: None,
                    };

                    Some((file_id, folder_node, parent_path))
                } else {
                    // Check if it's a supported image
                    let extension = entry_path
                        .extension()
                        .and_then(|e| e.to_str())
                        .map(|e| e.to_lowercase())
                        .unwrap_or_default();

                    if is_supported_image(&extension) {
                        // Create image file node (parent_id will be set later)
                        let file_size = metadata.len();

                        // Use imageinfo to quickly get image dimensions
                        let (width, height) = match image::image_dimensions(&entry_path) {
                            Ok((w, h)) => (w as u32, h as u32),
                            Err(_) => {
                                const MAX_HEADER_BYTES: usize = 256 * 1024; // 256KB
                                const CHUNK: usize = 16 * 1024; // read in 16KB chunks

                                if let Ok(mut file) = fs::File::open(&entry_path) {
                                    let mut buffer: Vec<u8> = Vec::new();
                                    let mut found: Option<(u32, u32)> = None;

                                    loop {
                                        let mut tmp = vec![0u8; CHUNK];
                                        match file.read(&mut tmp) {
                                            Ok(0) => break, // EOF
                                            Ok(n) => buffer.extend_from_slice(&tmp[..n]),
                                            Err(_) => break,
                                        }

                                        if let Ok(info) = imageinfo::ImageInfo::from_raw_data(&buffer) {
                                            found = Some((info.size.width as u32, info.size.height as u32));
                                            break;
                                        }

                                        if buffer.len() >= MAX_HEADER_BYTES {
                                            break;
                                        }
                                    }

                                    if let Some(v) = found {
                                        v
                                    } else {
                                        if let Ok(f2) = fs::File::open(&entry_path) {
                                            let reader = BufReader::new(f2);
                                            let mut dec = jpeg_decoder::Decoder::new(reader);
                                            let _ = dec.read_info();
                                            if let Some(info) = dec.info() {
                                                (info.width as u32, info.height as u32)
                                            } else {
                                                (0, 0)
                                            }
                                        } else {
                                            (0, 0)
                                        }
                                    }
                                } else {
                                    (0, 0)
                                }
                            }
                        };

                        let image_node = FileNode {
                            id: file_id.clone(),
                            parent_id: None, // Will be set later
                            name: file_name,
                            r#type: FileType::Image,
                            path: full_path.clone(),
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
                            url: None, // Don't use file path as URL - frontend will use getThumbnail() instead
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
                            ai_data: None,
                        };

                        Some((file_id, image_node, parent_path))
                    } else {
                        None
                    }
                }
            })
            .for_each(|item| {
                let _ = tx.send(item);
            });
    });

    // Receive nodes from producer and update processed counts
    let mut current_processed_images = processed_images;
    
    // 预填充逻辑：由于生产者是并行的，为了防止子节点的 parent_id 映射失败，
    // 我们在这里接收所有文件夹节点并先填充 path_to_id，然后再处理层级关系。
    // 注意：rx 现在接收的是初步节点。
    
    let mut pending_nodes = Vec::new();
    while let Ok(item) = rx.recv() {
        let (ref id, ref node, _) = item;
        if matches!(node.r#type, FileType::Folder) {
            path_to_id.insert(node.path.clone(), id.clone());
        }
        pending_nodes.push(item);
    }

    for (id, mut node, parent_path) in pending_nodes {
        // Resolve parent_id from parent_path if possible
        if !parent_path.is_empty() {
            if let Some(parent_id) = path_to_id.get(&parent_path).cloned() {
                node.parent_id = Some(parent_id);
            } else if parent_path == normalize_path(&path) {
                node.parent_id = Some(root_id.clone());
            }
        }

        // If folder, add to path map immediately
        if matches!(node.r#type, FileType::Folder) {
            path_to_id.insert(node.path.clone(), id.clone());
        }

        // Merge metadata if available
        if let Some(meta) = metadata_map.get(&id) {
            if let Some(tags_val) = &meta.tags {
                if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) {
                    node.tags = tags_vec;
                }
            }
            node.description = meta.description.clone();
            node.source_url = meta.source_url.clone();
            node.ai_data = meta.ai_data.clone();
        }

        // For images, increment processed count and emit progress
        if matches!(node.r#type, FileType::Image) {
            current_processed_images += 1;
            let _ = app.emit("scan-progress", ScanProgress { processed: current_processed_images, total: total_images });
        }

        all_files.insert(id.clone(), node);
    }

    // After both channels closed, ensure final progress reflects actual scanned images.
    // Because the lightweight counter may undercount in some edge cases, reconcile with the actual map.
    let actual_total: usize = all_files.iter().filter(|(_, n)| matches!(n.r#type, FileType::Image)).count();
    if actual_total > total_images {
        total_images = actual_total;
    }

    // Emit final progress event (use reconciled total)
    let _ = app.emit("scan-progress", ScanProgress { processed: current_processed_images, total: total_images });

    // Build parent-child relationships
    let mut children_to_add: Vec<(String, String)> = Vec::new(); // (parent_id, child_id)
    for (id, node) in all_files.iter() {
        if let Some(parent_id) = &node.parent_id {
            children_to_add.push((parent_id.clone(), id.clone()));
        } else if node.id != root_id {
            // Root-level item (parent resolution failed earlier) - attach to root and set parent_id
            children_to_add.push((root_id.clone(), id.clone()));
        }
    }
    
    // Add children to their parents and ensure child's parent_id is set
    for (parent_id, child_id) in children_to_add {
        // Attach child id to parent's children list if possible
        if let Some(parent_node) = all_files.get_mut(&parent_id) {
            if let Some(children) = &mut parent_node.children {
                children.push(child_id.clone());
            }
        }

        // If child's parent_id was missing (was None), update it to reflect attachment
        if let Some(child_node) = all_files.get_mut(&child_id) {
            if child_node.parent_id.is_none() && child_node.id != root_id {
                child_node.parent_id = Some(parent_id.clone());
            }
        }
    }
    
    // Sort children for all folders
    let folder_ids: Vec<String> = all_files.keys().cloned().collect();
    for folder_id in folder_ids {
        // Get children list first (immutable borrow)
        let children_opt = all_files.get(&folder_id)
            .and_then(|n| n.children.as_ref())
            .map(|c| c.clone());
        
        if let Some(mut children_sorted) = children_opt {
            // Sort using immutable borrow of all_files
            children_sorted.sort_by(|a, b| {
                let a_node = all_files.get(a);
                let b_node = all_files.get(b);
                
                match (a_node, b_node) {
                    (Some(a_n), Some(b_n)) => {
                        // Folders first
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
            
            // Now update with mutable borrow
            if let Some(node) = all_files.get_mut(&folder_id) {
                if let Some(children) = &mut node.children {
                    *children = children_sorted;
                }
            }
        }
    }
    
    // Collect all image paths from the scan results (for later use)
    let _image_paths: Vec<String> = all_files
        .iter()
        .filter(|(_, node)| matches!(node.r#type, FileType::Image))
        .map(|(_, node)| node.path.clone())
        .collect();
    
    // DO NOT update root node in map - it's already there with children!
    // all_files.insert(root_id, root_node); // This line was overwriting the root node!

    // Persist file index to database (best-effort, non-blocking from UI perspective)
    {
        let files_clone = all_files.clone();
        // Spawn blocking DB upsert so we don't block async runtime for long disk IO
        let pool_clone = app.state::<AppDbPool>().inner().clone();
        let upsert_result = tokio::task::spawn_blocking(move || {
            let mut conn = pool_clone.get_connection();
            let mut entries_vec: Vec<db::file_index::FileIndexEntry> = Vec::new();
            for (_, node) in files_clone.iter() {
                // Read timestamps from FS when possible
                let (created_ts, modified_ts) = match std::fs::metadata(&node.path) {
                    Ok(m) => {
                        let created = m.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
                        let modified = m.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_secs() as i64).unwrap_or(0);
                        (created, modified)
                    }
                    Err(_) => (0, 0),
                };

                let (w, h, fmt) = if let Some(meta) = &node.meta {
                    (Some(meta.width as u32), Some(meta.height as u32), Some(meta.format.clone()))
                } else {
                    (None, None, None)
                };

                let entry = db::file_index::FileIndexEntry {
                    file_id: node.id.clone(),
                    parent_id: node.parent_id.clone(),
                    path: node.path.clone(),
                    name: node.name.clone(),
                    file_type: match node.r#type {
                        FileType::Image => "Image".to_string(),
                        FileType::Folder => "Folder".to_string(),
                        _ => "Unknown".to_string(),
                    },
                    size: node.size.unwrap_or(0),
                    created_at: created_ts,
                    modified_at: modified_ts,
                    width: w,
                    height: h,
                    format: fmt,
                };

                entries_vec.push(entry);
            }
            db::file_index::batch_upsert(&mut conn, &entries_vec)
        }).await;

        match upsert_result {
            Err(e) => eprintln!("Failed to persist file index (task join error): {}", e),
            Ok(Err(e)) => eprintln!("Failed to persist file index (db error): {}", e),
            Ok(Ok(_)) => { /* persisted successfully */ }
        }
    }

    Ok(all_files)
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
    
    if is_directory {
        // Create folder node
        Ok(FileNode {
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
            ai_data: None,
        })
    } else if is_image {
        // Create image file node
        let file_size = metadata.len();
        let (width, height) = image::image_dimensions(path).unwrap_or((0, 0));
        
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
        
        let mut final_node = image_node;
        
        // Merge metadata if available
        {
            let pool = app.state::<AppDbPool>();
            let conn = pool.get_connection();
            if let Ok(Some(meta)) = db::file_metadata::get_metadata_by_id(&conn, &final_node.id) {
                if let Some(tags_val) = &meta.tags {
                    if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) {
                        final_node.tags = tags_vec;
                    }
                }
                final_node.description = meta.description.clone();
                final_node.source_url = meta.source_url.clone();
                final_node.ai_data = meta.ai_data.clone();
            }
        }

        Ok(final_node)
    } else {
        // Create unknown file node
        let file_size = metadata.len();
        
        Ok(FileNode {
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
            ai_data: None,
        })
    }
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
async fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir(&path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;
    Ok(())
}

// Command to rename a file or folder
#[tauri::command]
async fn rename_file(old_path: String, new_path: String, app: tauri::AppHandle) -> Result<(), String> {
    // 1. 先进行物理重命名
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("物理重命名失败 (可能文件被占用): {}", e))?;
    
    let is_dir = Path::new(&new_path).is_dir();
    
    // 2. 同步执行数据库迁移 (避免竞态条件)
    // 之前使用 spawn_blocking 会导致前端在数据库更新完成前就扫描到新文件，
    // 从而触发重复提取。由于我们已经优化了 SQL 性能，这里同步执行也不会卡顿。
    let app_db = app.state::<AppDbPool>();
    
    if is_dir {
        // 目录重命名
        let mut conn = app_db.get_connection();
        let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;
        
        db::file_index::migrate_index_dir(&tx, &old_path, &new_path)
            .map_err(|e| format!("索引迁移失败: {}", e))?;
        db::file_metadata::migrate_metadata_dir(&tx, &old_path, &new_path)
            .map_err(|e| format!("元数据迁移失败: {}", e))?;
            
        tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    } else {
        // 单文件重命名
        let old_id = generate_id(&old_path);
        let new_id = generate_id(&new_path);
        let mut conn = app_db.get_connection();
        let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;

        db::file_index::migrate_index_dir(&tx, &old_path, &new_path)
            .map_err(|e| format!("索引迁移失败: {}", e))?;
        db::file_metadata::migrate_metadata(&tx, &old_id, &new_id, &new_path)
            .map_err(|e| format!("元数据迁移失败: {}", e))?;

        tx.commit().map_err(|e| format!("提交事务失败: {}", e))?;
    }
    
    let color_db = app.state::<Arc<color_db::ColorDbPool>>().inner();
    // Log timing for DB move — useful to detect whether DB work is blocking the rename command
    let db_move_start = std::time::Instant::now();
    let res = color_db.move_colors(&old_path, &new_path);
    eprintln!("[rename_file] color_db.move_colors elapsed={:?} result={:?}", db_move_start.elapsed(), res.as_ref().err());

    // Return quickly; non-critical cache updates inside `move_colors` are performed asynchronously.
    Ok(())
}

#[tauri::command]
async fn db_copy_file_metadata(src_path: String, dest_path: String, app: tauri::AppHandle) -> Result<(), String> {
    let is_dir = Path::new(&dest_path).is_dir();
    let app_db = app.state::<AppDbPool>();
    let conn = app_db.get_connection();

    if is_dir {
        let _ = db::file_metadata::copy_metadata_dir(&conn, &src_path, &dest_path);
    } else {
        let old_id = generate_id(&src_path);
        let new_id = generate_id(&dest_path);
        let _ = db::file_metadata::copy_metadata(&conn, &old_id, &new_id, &dest_path);
    }

    let color_db = app.state::<Arc<color_db::ColorDbPool>>().inner();
    let _ = color_db.copy_colors(&src_path, &dest_path);

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
async fn write_file_from_bytes(file_path: String, bytes: Vec<u8>) -> Result<(), String> {
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
                    Ok(_) => return Ok(()),
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
    
    let is_file_path = is_file.unwrap_or_else(|| abs_path_obj.is_file());
    
    // 计算目标路径
    let target_path = if is_file_path {
        // 情况1：文件 - 打开父目录
        match abs_path_obj.parent() {
            Some(parent) => {
                let parent_str = parent.to_str().unwrap_or(&absolute_path);
                println!("File parent path: {}", parent_str);
                parent_str.to_string()
            },
            None => {
                println!("File has no parent, using absolute path: {}", absolute_path);
                absolute_path.clone()
            },
        }
    } else {
        // 情况2：文件夹
        match is_file {
            Some(false) => {
                // 右键菜单打开文件夹：打开父目录
                match abs_path_obj.parent() {
                    Some(parent) => {
                        let parent_str = parent.to_str().unwrap_or(&absolute_path);
                        println!("Folder parent path (from context menu): {}", parent_str);
                        parent_str.to_string()
                    },
                    None => {
                        println!("Folder has no parent, using absolute path: {}", absolute_path);
                        absolute_path.clone()
                    },
                }
            },
            _ => {
                // 设置面板打开文件夹：直接打开该文件夹
                println!("Opening folder directly: {}", absolute_path);
                absolute_path.clone()
            }
        }
    };
    
    println!("open_path: path={}, target_path={}, is_file={:?}, is_file_path={}", 
             path, target_path, is_file, is_file_path);
    
    println!("Final target_path: {}", target_path);
    
    // 直接使用系统命令打开文件管理器，但不等待命令完成，避免阻塞和闪退问题
    let result = if cfg!(windows) {
        // Windows: 使用explorer命令，确保路径使用正确的反斜杠格式
        // 将正斜杠转换为反斜杠，确保Windows能够正确识别路径
        let win_target_path = target_path.replace("/", "\\");
        println!("Windows command: explorer.exe \"{}\"", win_target_path);
        
        // 使用spawn()而不是status()或output()，这样命令会在后台运行，不会阻塞主线程
        // 同时，使用Command::new("explorer.exe")直接调用，避免使用cmd.exe包装
        Command::new("explorer.exe")
            .arg(win_target_path)
            .spawn()
            .map(|_| ())
    } else if cfg!(target_os = "macos") {
        // macOS: 使用open命令
        println!("macOS command: open \"{}\"", target_path);
        Command::new("open")
            .arg(target_path.clone())
            .spawn()
            .map(|_| ())
    } else {
        // Linux: 使用xdg-open命令
        println!("Linux command: xdg-open \"{}\"", target_path);
        Command::new("xdg-open")
            .arg(target_path.clone())
            .spawn()
            .map(|_| ())
    };
    
    match result {
        Ok(_) => {
            println!("Successfully started file manager for: {}", target_path);
            Ok(())
        },
        Err(e) => {
            let error_msg = format!("Failed to open path '{}': {}", target_path, e);
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
async fn db_upsert_file_metadata(
    pool: tauri::State<'_, AppDbPool>, 
    metadata: db::file_metadata::FileMetadata
) -> Result<(), String> {
    let conn = pool.get_connection();
    db::file_metadata::upsert_file_metadata(&conn, &metadata).map_err(|e| e.to_string())
}


fn main() {
    
    tauri::Builder::default()
        // 清理调试阶段的 setup 注入，恢复默认构建
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_log::Builder::default().build())
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
            db_upsert_file_metadata,
            db_copy_file_metadata
        ])
        .setup(|app| {
            // 创建托盘菜单
            let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            
            // 获取应用句柄用于事件处理
            let app_handle = app.handle().clone();
            
            // 创建托盘图标
            let tray = TrayIconBuilder::new()
                .tooltip("Aurora Gallery")
                .icon(app.default_window_icon().expect("No default window icon").clone())
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
            
            // 初始化颜色数据库
            let app_data_dir = app.path().app_data_dir()
                .expect("Failed to get app data directory");
            let db_path = app_data_dir.join("colors.db");
            
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
            } else {
                eprintln!("[ColorDB] Background cache preheat initiated");
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
            let app_db_path = app_data_dir.join("metadata.db");
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
                if path.exists() {
                    if let Ok(json) = fs::read_to_string(&path) {
                        if let Ok(state) = serde_json::from_str::<SavedWindowState>(&json) {
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: state.width, height: state.height }));
                            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: state.x, y: state.y }));
                            if state.maximized {
                                let _ = window.maximize();
                            }
                        }
                    }
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
