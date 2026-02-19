use crate::db::{self, generate_id, normalize_path, AppDbPool};
use crate::file_types::{FileType, FileNode, ImageMeta, ScanProgress, is_supported_image};
use crate::image_utils::get_image_dimensions;
use rayon::prelude::*;
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::Arc;
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};

static HDD_CACHE: Mutex<Option<HashMap<String, (bool, Instant)>>> = Mutex::new(None);
const CACHE_TTL: Duration = Duration::from_secs(300);

fn is_likely_hdd(path: &str) -> bool {
    let cache_key = normalize_path(path);
    
    {
        let mut cache_guard = HDD_CACHE.lock().unwrap();
        if cache_guard.is_none() {
            *cache_guard = Some(HashMap::new());
        }
        
        if let Some(cache) = cache_guard.as_ref() {
            if let Some((result, timestamp)) = cache.get(&cache_key) {
                if timestamp.elapsed() < CACHE_TTL {
                    return *result;
                }
            }
        }
    }
    
    let result = detect_hdd_internal(path);
    
    {
        let mut cache_guard = HDD_CACHE.lock().unwrap();
        if let Some(ref mut cache) = cache_guard.as_mut() {
            cache.insert(cache_key, (result, Instant::now()));
        }
    }
    
    result
}

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
pub async fn scan_directory(path: String, force_rescan: Option<bool>, app: tauri::AppHandle) -> Result<HashMap<String, FileNode>, String> {
    let force = force_rescan.unwrap_or(false);
    let root_path_os = Path::new(&path);
    
    if !root_path_os.exists() {
        return Err(format!("路径不存在: {}", path));
    }
    if !root_path_os.is_dir() {
        return Err(format!("路径不是目录: {}", path));
    }

    let normalized_root_path = normalize_path(&path);

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
    
    if !force && !cached_index_map.is_empty() {
        let root_match_path = normalized_root_path.trim_end_matches('/').to_string();

        let fs_root_count = if let Ok(rd) = root_path_os.read_dir() {
            rd.filter_map(|e| e.ok()).filter(|e| {
                let name = e.file_name().to_string_lossy().to_string();
                if name == ".Aurora_Cache" || (name.starts_with('.') && name != ".pixcall") {
                    return false;
                }
                
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

        if fs_root_count <= db_root_children_count {
            if std::env::var("AURORA_DEBUG").ok() == Some("1".to_string()) {
                println!("Fast startup: Root consistency check passed (FS: {}, DB: {})", fs_root_count, db_root_children_count);
            }
            let mut all_files = HashMap::new();
            let mut path_to_id = HashMap::new();
            
            for (f_path, entry) in cached_index_map.iter() {
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

                if let Some(meta) = metadata_map.get(&entry.file_id) {
                    if let Some(tags_val) = &meta.tags {
                        if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) { node.tags = tags_vec; }
                    }
                    node.description = meta.description.clone();
                    node.source_url = meta.source_url.clone();
                    node.category = meta.category.clone();
                    node.ai_data = meta.ai_data.clone();
                }

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

            let mut assignments = Vec::new();
            for (id, node) in all_files.iter() {
                if id == &root_id { continue; }
                
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

            let _ = app.emit("scan-progress", ScanProgress { processed: all_files.len(), total: all_files.len() });
            
            return Ok(all_files);
        } else {
             println!("Detected new files in root directory (DB: {}, FS: {}). Creating incremental update...", db_root_children_count, fs_root_count);
        }
    }

    let root_metadata = fs::metadata(root_path_os).map_err(|e| format!("无法读取根目录: {}", e))?;
    let mut root_node = FileNode {
        id: root_id.clone(), parent_id: None, name: root_path_os.file_name().and_then(|n| n.to_str()).unwrap_or("Root").to_string(),
        r#type: FileType::Folder, path: normalized_root_path.clone(), size: None, children: Some(Vec::new()), tags: Vec::new(),
        url: None, meta: None, description: None, source_url: None, category: None, ai_data: None,
        created_at: root_metadata.created().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
        updated_at: root_metadata.modified().ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).and_then(|d| chrono::DateTime::from_timestamp(d.as_secs() as i64, 0)).map(|dt| dt.to_rfc3339()),
    };

    if let Some(meta) = metadata_map.get(&root_id) {
        if let Some(tags_val) = &meta.tags {
            if let Ok(tags_vec) = serde_json::from_value::<Vec<String>>(tags_val.clone()) { root_node.tags = tags_vec; }
        }
        root_node.description = meta.description.clone();
        root_node.source_url = meta.source_url.clone();
        root_node.category = meta.category.clone();
        root_node.ai_data = meta.ai_data.clone();
    }

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
        root_path_os.read_dir().map(|d| d.count()).unwrap_or(0)
    };

    let (tx, rx) = crossbeam_channel::unbounded::<(String, FileNode, String)>();
    let _ = app.emit("scan-progress", ScanProgress { processed: 0, total: total_images });

    let producer_path = path.clone();
    let cached_index_arc = Arc::new(cached_index_map);

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

    let mut all_files: HashMap<String, FileNode> = HashMap::new();
    let mut path_to_id: HashMap<String, String> = HashMap::new();
    path_to_id.insert(normalized_root_path.clone(), root_id.clone());
    all_files.insert(root_id.clone(), root_node);

    let mut scanned_paths = Vec::new();
    let mut processed_count = 0;
    let mut current_total = total_images;
    let mut p_path_map: HashMap<String, String> = HashMap::new(); 
    
    let mut entries_to_save = Vec::with_capacity(total_images + 1);

    let mut received_count = 0;
    while let Ok((id, mut node, p_path)) = rx.recv() {
        received_count += 1;
        scanned_paths.push(node.path.clone());
        if node.name.contains("棕色") || node.name.contains("素材") {
             println!("[DEBUG] Scanning node check: Name={}, GeneratedID={}, FoundMeta={}", node.name, id, metadata_map.contains_key(&id));
        }

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

        let (w, h, fmt) = node.meta.as_ref().map_or((None, None, None), |m| (Some(m.width), Some(m.height), Some(m.format.clone())));
        let c_at = node.created_at.as_ref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|dt| dt.timestamp()).unwrap_or(0);
        let m_at = node.updated_at.as_ref().and_then(|t| chrono::DateTime::parse_from_rfc3339(t).ok()).map(|dt| dt.timestamp()).unwrap_or(0);

        entries_to_save.push(db::file_index::FileIndexEntry {
            file_id: id.clone(),
            parent_id: None,
            path: node.path.clone(),
            name: node.name.clone(),
            file_type: match node.r#type { FileType::Image => "Image".to_string(), FileType::Folder => "Folder".to_string(), _ => "Unknown".to_string() },
            size: node.size.unwrap_or(0), width: w, height: h, format: fmt,
            created_at: c_at, modified_at: m_at, 
        });

        all_files.insert(id, node);
    }
    

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

    let _ = app.emit("scan-progress", ScanProgress {
        processed: processed_count,
        total: current_total,
    });

    eprintln!("[Scan Complete] Total received: {}, Total files in map: {}, Expected: {}",
             received_count, all_files.len(), total_images);

    if received_count < total_images.saturating_sub(10) {
        eprintln!("[Scan Warning] Received fewer files than expected! This may indicate a HDD I/O issue.");
        eprintln!("[Scan Warning] Consider checking disk health or using SSD for better performance.");
    }

    let mut to_process: Vec<String> = Vec::new();
    if std::env::var("AURORA_DISABLE_BACKGROUND_INDEX").as_deref().ok() != Some("1") {
        for node in all_files.values() {
            if matches!(node.r#type, FileType::Image) {
                let need = node.meta.as_ref().map(|m| m.width == 0 || m.height == 0).unwrap_or(true);
                if need { to_process.push(node.path.clone()); }
            }
        }
    }

    let root_to_clean = normalized_root_path.clone();
    let app_db_inner = app.state::<AppDbPool>().inner().clone();
    
    tokio::task::spawn_blocking(move || {
        let mut conn = app_db_inner.get_connection();
        let _ = db::file_index::batch_upsert(&mut conn, &entries_to_save);
        let _ = db::file_index::delete_orphaned_entries(&mut conn, &root_to_clean, &scanned_paths);
    });

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
                        let _ = app_handle_clone.emit("metadata-updated", &entries);
                    }
                }).await.ok();
                tokio::time::sleep(std::time::Duration::from_millis(batch_delay_ms)).await;
            }
        });
    }

    Ok(all_files)
}

#[tauri::command]
pub async fn force_rescan(path: String, app: tauri::AppHandle) -> Result<HashMap<String, FileNode>, String> {
    scan_directory(path, Some(true), app).await
}
