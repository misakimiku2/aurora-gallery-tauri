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


#[derive(Serialize, Clone)]
struct ScanProgress {
    processed: usize,
    total: usize,
}

#[tauri::command]
async fn scan_directory(path: String, force_rescan: Option<bool>, app: tauri::AppHandle) -> Result<HashMap<String, FileNode>, String> {
    use std::fs;
    use std::io::{Read, BufReader};
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

    // 1. 加载元数据以便合并
    let metadata_map: HashMap<String, db::file_metadata::FileMetadata> = {
        let pool = app.state::<AppDbPool>();
        let conn = pool.get_connection();
        // 当环境变量 AURORA_BENCH=1 时打印耗时（仅用于开发/benchmark）
        if std::env::var("AURORA_BENCH").as_deref().ok() == Some("1") {
            let t0 = std::time::Instant::now();
            let v = db::file_metadata::get_all_metadata(&conn).unwrap_or_default();
            eprintln!("AURORA_BENCH: get_all_metadata -> rows={} elapsed={:?}", v.len(), t0.elapsed());
            v.into_iter().map(|m| (m.file_id.clone(), m)).collect()
        } else {
            db::file_metadata::get_all_metadata(&conn)
                .unwrap_or_default()
                .into_iter()
                .map(|m| (m.file_id.clone(), m))
                .collect()
        }
    };

    // 2. 预加载现有的索引条目，用于元数据复用
    let cached_index_map: HashMap<String, db::file_index::FileIndexEntry> = {
        let pool = app.state::<AppDbPool>();
        let conn = pool.get_connection();
        if std::env::var("AURORA_BENCH").as_deref().ok() == Some("1") {
            let t0 = std::time::Instant::now();
            let entries = db::file_index::get_entries_under_path(&conn, &normalized_root_path).unwrap_or_default();
            eprintln!("AURORA_BENCH: get_entries_under_path -> rows={} elapsed={:?}", entries.len(), t0.elapsed());
            entries.into_iter().map(|e| (e.path.clone(), e)).collect()
        } else {
            db::file_index::get_entries_under_path(&conn, &normalized_root_path)
                .unwrap_or_default()
                .into_iter()
                .map(|e| (e.path.clone(), e))
                .collect()
        }
    };
    
    let root_id = generate_id(&path);
    let root_metadata = fs::metadata(root_path_os).map_err(|e| format!("无法读取根目录: {}", e))?;
    let root_node = FileNode {
        id: root_id.clone(), parent_id: None, name: root_path_os.file_name().and_then(|n| n.to_str()).unwrap_or("Root").to_string(),
        r#type: FileType::Folder, path: normalized_root_path.clone(), size: None, children: Some(Vec::new()), tags: Vec::new(),
        url: None, meta: None, description: None, source_url: None, ai_data: None,
        created_at: root_metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
        updated_at: root_metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
    };

    // 3. 快速计算总数 (限制线程以平衡性能与 CPU 占用)
    let fast_total: usize = jwalk::WalkDir::new(&path)
        .parallelism(jwalk::Parallelism::RayonNewPool(8))
        .into_iter()
        .par_bridge()
        .filter_map(|e| {
            let entry = e.ok()?;
            let p = entry.path();
            if p == root_path_os { return None; }
            let name = p.file_name()?.to_str()?;
            if p.components().any(|c| c.as_os_str() == ".Aurora_Cache") || (name.starts_with('.') && name != ".pixcall") { return None; }
            let ext = p.extension()?.to_str()?.to_lowercase();
            if is_supported_image(&ext) { Some(1) } else { None }
        })
        .count();

    let total_images = fast_total;
    let _ = app.emit("scan-progress", ScanProgress { processed: 0, total: total_images });

    // 4. 并行扫描逻辑
    let (tx, rx) = crossbeam_channel::unbounded::<(String, FileNode, String)>();
    let producer_path = path.clone();
    let cached_index_arc = Arc::new(cached_index_map);

    std::thread::spawn(move || {
        let normalized_root = normalize_path(&producer_path);
        let root_p_local = Path::new(&producer_path);

        jwalk::WalkDir::new(&producer_path)
            .parallelism(jwalk::Parallelism::RayonNewPool(8))
            .into_iter()
            .par_bridge()
            .filter_map(|entry_result| {
                let entry = entry_result.ok()?;
                let entry_path = entry.path();
                if entry_path == root_p_local { return None; }

                let file_name = entry_path.file_name()?.to_str()?;
                if entry_path.components().any(|c| c.as_os_str() == ".Aurora_Cache") || (file_name.starts_with('.') && file_name != ".pixcall") { return None; }

                let full_path = normalize_path(entry_path.to_str()?);
                let metadata = entry.metadata().ok()?;
                let p_path = entry_path.parent().map(|p| normalize_path(p.to_str().unwrap_or(""))).unwrap_or(normalized_root.clone());
                
                let is_directory = metadata.is_dir();
                let extension = entry_path.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
                
                let cached = cached_index_arc.get(&full_path);
                let mtime = metadata.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
                
                let reuse_metadata = !force && cached.map_or(false, |c| c.modified_at == mtime && c.size == metadata.len());
                let file_id = if let Some(c) = cached { c.file_id.clone() } else { generate_id(&full_path) };

                if is_directory {
                    let folder_node = FileNode {
                        id: file_id.clone(), parent_id: None, name: file_name.to_string(), r#type: FileType::Folder, path: full_path.clone(),
                        size: None, children: Some(Vec::new()), tags: Vec::new(), url: None, meta: None, description: None, source_url: None, ai_data: None,
                        created_at: metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
                        updated_at: chrono::DateTime::from_timestamp(mtime, 0).map(|dt| dt.to_rfc3339()),
                    };
                    Some((file_id, folder_node, p_path))
                } else if is_supported_image(&extension) {
                    let (width, height) = if reuse_metadata {
                        let c = cached.unwrap(); (c.width.unwrap_or(0), c.height.unwrap_or(0))
                    } else {
                        image::image_dimensions(&entry_path).unwrap_or((0, 0))
                    };

                    let image_node = FileNode {
                        id: file_id.clone(), parent_id: None, name: file_name.to_string(), r#type: FileType::Image, path: full_path.clone(),
                        size: Some(metadata.len()), children: None, tags: Vec::new(), url: None, description: None, source_url: None, ai_data: None,
                        created_at: metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
                        updated_at: chrono::DateTime::from_timestamp(mtime, 0).map(|dt| dt.to_rfc3339()),
                        meta: Some(ImageMeta {
                            width, height, size_kb: (metadata.len() / 1024) as u32, format: extension,
                            created: chrono::DateTime::from_timestamp(metadata.created().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64, 0).map(|dt| dt.to_rfc3339()).unwrap_or_default(),
                            modified: chrono::DateTime::from_timestamp(mtime, 0).map(|dt| dt.to_rfc3339()).unwrap_or_default(),
                        }),
                    };
                    Some((file_id, image_node, p_path))
                } else { None }
            })
            .collect::<Vec<_>>()
            .into_iter()
            .for_each(|item| {
                let _ = tx.send(item);
            });
    });

    // 5. 聚合结果
    let mut all_files: HashMap<String, FileNode> = HashMap::new();
    let mut path_to_id: HashMap<String, String> = HashMap::new();
    path_to_id.insert(normalized_root_path.clone(), root_id.clone());
    all_files.insert(root_id.clone(), root_node);

    let mut scanned_paths = Vec::new();
    let mut processed_count = 0;
    let mut p_path_map: HashMap<String, String> = HashMap::new(); // temp map to store parent path for nodes

    while let Ok((id, mut node, p_path)) = rx.recv() {
        scanned_paths.push(node.path.clone());
        if matches!(node.r#type, FileType::Folder) { 
            path_to_id.insert(node.path.clone(), id.clone()); 
        }
        p_path_map.insert(id.clone(), p_path);

        if let Some(meta) = metadata_map.get(&id) {
            if let Some(tags_val) = &meta.tags {
                if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) { node.tags = tags_vec; }
            }
            node.description = meta.description.clone();
            node.source_url = meta.source_url.clone();
            node.ai_data = meta.ai_data.clone();
        }

        if matches!(node.r#type, FileType::Image) {
            processed_count += 1;
            let _ = app.emit("scan-progress", ScanProgress { processed: processed_count, total: total_images });
        }
        all_files.insert(id, node);
    }

    // 建立父子关系 - 二次解析阶段以防并行导致的顺序问题
    let mut assignments = Vec::new();
    for (id, node) in all_files.iter() {
        if id == &root_id { continue; }
        
        let parent_id = if let Some(pid) = &node.parent_id {
            Some(pid.clone())
        } else if let Some(ppath) = p_path_map.get(id) {
            path_to_id.get(ppath).cloned().or_else(|| if ppath == &normalized_root_path { Some(root_id.clone()) } else { None })
        } else {
            Some(root_id.clone())
        };

        if let Some(pid) = parent_id {
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

    // 持久化（快速）并异步清理 + 后台补充 heavy metadata（受限速）
    let files_to_upsert = all_files.clone();
    let files_for_background = files_to_upsert.clone(); // 为后台索引保留一份副本
    let root_to_clean = normalized_root_path.clone();
    let app_db_inner = app.state::<AppDbPool>().inner().clone();

    // 快速写入当前主索引（不阻塞 UI）
    tokio::task::spawn_blocking(move || {
        let mut conn = app_db_inner.get_connection();
        let entries: Vec<db::file_index::FileIndexEntry> = files_to_upsert.values().map(|node| {
            let (w, h, fmt) = node.meta.as_ref().map_or((None, None, None), |m| (Some(m.width), Some(m.height), Some(m.format.clone())));
            db::file_index::FileIndexEntry {
                file_id: node.id.clone(), parent_id: node.parent_id.clone(), path: node.path.clone(), name: node.name.clone(),
                file_type: match node.r#type { FileType::Image => "Image".to_string(), FileType::Folder => "Folder".to_string(), _ => "Unknown".to_string() },
                size: node.size.unwrap_or(0), width: w, height: h, format: fmt,
                created_at: 0, modified_at: 0, 
            }
        }).collect();
        let _ = db::file_index::batch_upsert(&mut conn, &entries);
        let _ = db::file_index::delete_orphaned_entries(&mut conn, &root_to_clean, &scanned_paths);
    });

    // 后台增量补全 missing heavy metadata（dimensions 等）——有批次与延迟以避免瞬时 CPU/IO 峰值
    if std::env::var("AURORA_DISABLE_BACKGROUND_INDEX").as_deref().ok() != Some("1") {
        let pool = app.state::<AppDbPool>().inner().clone();
        tokio::spawn(async move {
            // 可调参数：默认批量大小 200，批次间隔 50ms
            let batch_size: usize = std::env::var("AURORA_INDEX_BATCH_SIZE").ok().and_then(|s| s.parse().ok()).unwrap_or(200);
            let batch_delay_ms: u64 = std::env::var("AURORA_INDEX_BATCH_DELAY_MS").ok().and_then(|s| s.parse().ok()).unwrap_or(50);

            // 收集需要补全尺寸的图片路径
            let mut to_process: Vec<String> = Vec::new();
            for (_id, node) in files_for_background.iter() {
                if matches!(node.r#type, FileType::Image) {
                    let need = node.meta.as_ref().map(|m| m.width == 0 || m.height == 0).unwrap_or(true);
                    if need { to_process.push(node.path.clone()); }
                }
            }

            if to_process.is_empty() { return; }

            // 分批顺序执行：每批在 blocking 线程中计算并写回 DB，以避免大量并发阻塞导致 CPU 飙升
            for chunk in to_process.chunks(batch_size) {
                let chunk_vec: Vec<String> = chunk.to_vec();
                let pool_clone = pool.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    let mut conn = pool_clone.get_connection();
                    let mut entries = Vec::new();
                    for path in chunk_vec.iter() {
                        if let Ok(md) = std::fs::metadata(path) {
                            if md.is_file() {
                                if let Ok((w, h)) = image::image_dimensions(path) {
                                    let id = generate_id(path);
                                    let name = std::path::Path::new(path).file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
                                    let fmt = std::path::Path::new(path).extension().and_then(|e| e.to_str()).map(|s| s.to_string());
                                    entries.push(db::file_index::FileIndexEntry {
                                        file_id: id,
                                        parent_id: None,
                                        path: path.clone(),
                                        name,
                                        file_type: "Image".to_string(),
                                        size: md.len(),
                                        width: Some(w),
                                        height: Some(h),
                                        format: fmt,
                                        created_at: 0,
                                        modified_at: 0,
                                    });
                                }
                            }
                        }
                    }
                    if !entries.is_empty() {
                        let _ = db::file_index::batch_upsert(&mut conn, &entries);
                    }
                }).await.ok();

                // 让出调度并限制下一批的突发性
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
            let mut conn = pool_clone.get_connection();
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
