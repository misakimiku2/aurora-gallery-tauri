use crate::color_db;
use crate::db::{self, generate_id, normalize_path, AppDbPool};
use crate::file_types::{FileType, FileNode, ImageMeta, is_supported_image};
use crate::image_utils::get_image_dimensions;
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;

fn generate_unique_file_path(dest_path: &str) -> String {
    let path = Path::new(dest_path);
    if !path.exists() {
        return dest_path.to_string();
    }
    
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let file_stem = path.file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("");
    let extension = path.extension()
        .and_then(|e| e.to_str())
        .map(|e| format!(".{}", e))
        .unwrap_or_default();
    
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
    
    dest_path.to_string()
}

#[tauri::command]
pub async fn scan_file(file_path: String, parent_id: Option<String>, app: tauri::AppHandle) -> Result<FileNode, String> {
    let path = Path::new(&file_path);
    
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
        let file_size = metadata.len();
        let (width, height) = get_image_dimensions(&path.to_string_lossy());
        
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
        
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let image_path = image_node.path.clone();
        
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
pub async fn ensure_directory(path: String) -> Result<(), String> {
    let cache_path = Path::new(&path);
    if !cache_path.exists() {
        fs::create_dir_all(cache_path)
            .map_err(|e| format!("Failed to create directory: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub async fn file_exists(file_path: String) -> Result<bool, String> {
    let path = Path::new(&file_path);
    Ok(path.exists())
}

#[tauri::command]
pub async fn create_folder(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let folder_path = Path::new(&path);
    fs::create_dir(folder_path)
        .map_err(|e| format!("Failed to create folder: {}", e))?;
    
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

#[tauri::command]
pub async fn rename_file(old_path: String, new_path: String, app: tauri::AppHandle) -> Result<(), String> {
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("物理重命名失败 (可能文件被占用): {}", e))?;

    let is_dir = Path::new(&new_path).is_dir();
    let app_db = app.state::<AppDbPool>();

    {
        let mut conn = app_db.get_connection();
        let tx = conn.transaction().map_err(|e| format!("开启事务失败: {}", e))?;

        if is_dir {
            let new_normalized = normalize_path(&new_path);
            let new_dir_prefix_clean = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
            let new_dir_pattern = format!("{}%", new_dir_prefix_clean);
            tx.execute(
                "DELETE FROM file_index WHERE lower(path) = lower(?1) OR lower(path) LIKE lower(?2)",
                rusqlite::params![new_normalized, new_dir_pattern],
            ).ok();

            tx.execute(
                "UPDATE file_index SET path = ?1, name = ?2 WHERE path = ?3",
                rusqlite::params![normalize_path(&new_path), Path::new(&new_path).file_name().and_then(|n| n.to_str()).unwrap_or(""), normalize_path(&old_path)],
            ).ok();
        } else {
            tx.execute(
                "UPDATE file_index SET path = ?1, name = ?2 WHERE file_id = ?3",
                rusqlite::params![normalize_path(&new_path), Path::new(&new_path).file_name().and_then(|n| n.to_str()).unwrap_or(""), generate_id(&old_path)],
            ).ok();

            let old_id = generate_id(&old_path);
            let new_id = generate_id(&new_path);
            let _ = db::file_metadata::migrate_metadata(&tx, &old_id, &new_id, &new_path);
        }

        tx.commit().map_err(|e| format!("提交快速事务失败: {}", e))?;
    }

    let old_clone = old_path.clone();
    let new_clone = new_path.clone();
    let pool_clone = app_db.inner().clone();
    let color_db = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();

    tokio::spawn(async move {
        let bg_start = std::time::Instant::now();
        let res = tokio::task::spawn_blocking(move || {
            let conn = pool_clone.get_connection();
            let _ = db::file_index::migrate_index_dir(&conn, &old_clone, &new_clone);
            let _ = db::file_metadata::migrate_metadata_dir(&conn, &old_clone, &new_clone);
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
pub async fn db_copy_file_metadata(src_path: String, dest_path: String, app: tauri::AppHandle) -> Result<(), String> {
    let dest_p = Path::new(&dest_path);
    let is_dir = dest_p.is_dir();
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

    let src_normalized = normalize_path(&src_path);
    let dest_normalized = normalize_path(&dest_path);
    
    let mut conn_mut = app_db.get_connection();
    
    if is_dir {
        let _ = db::file_index::delete_entries_by_path(&conn_mut, &dest_normalized);
    } else {
        if let Ok(md) = fs::metadata(dest_p) {
            let new_id = generate_id(&dest_normalized);
            let file_name = dest_p.file_name().and_then(|n| n.to_str()).unwrap_or("").to_string();
            let ext = dest_p.extension().and_then(|e| e.to_str()).map(|e| e.to_lowercase()).unwrap_or_default();
            
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

#[tauri::command]
pub async fn delete_file(path: String, app: tauri::AppHandle) -> Result<(), String> {
    let file_path = Path::new(&path);
    if file_path.is_dir() {
        fs::remove_dir_all(file_path)
            .map_err(|e| format!("Failed to delete directory: {}", e))?;
    } else {
        fs::remove_file(file_path)
            .map_err(|e| format!("Failed to delete file: {}", e))?;
    }

    let app_db = app.state::<AppDbPool>();
    let conn = app_db.get_connection();
    let _ = db::file_index::delete_entries_by_path(&conn, &path);
    let _ = db::file_metadata::delete_metadata_by_path(&conn, &path);
    
    let color_db = app.state::<Arc<color_db::ColorDbPool>>().inner();
    let _ = color_db.delete_colors_by_path(&path);

    Ok(())
}

#[tauri::command]
pub async fn copy_image_colors(
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
pub async fn copy_image_to_clipboard(file_path: String) -> Result<(), String> {
    use arboard::Clipboard;
    
    let path = Path::new(&file_path);
    if !path.exists() {
        return Err(format!("File does not exist: {}", file_path));
    }
    
    let image_bytes = fs::read(&file_path)
        .map_err(|e| format!("Failed to read image file: {}", e))?;
    
    let img = image::load_from_memory(&image_bytes)
        .map_err(|e| format!("Failed to load image: {}", e))?;
    
    let rgba_img = img.to_rgba8();
    let (width, height) = rgba_img.dimensions();
    let rgba_bytes = rgba_img.into_raw();
    
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
pub async fn copy_file(src_path: String, dest_path: String) -> Result<String, String> {
    let src = Path::new(&src_path);
    let mut dest = Path::new(&dest_path);
    
    if !src.exists() {
        return Err(format!("Source does not exist: {}", src_path));
    }
    
    let is_dir = src.is_dir();
    
    let src_normalized = normalize_path(&src_path);
    let dest_normalized = normalize_path(&dest_path);
    
    if src_normalized == dest_normalized {
        if is_dir {
            return Err(format!("Cannot copy directory to itself: {}", src_path));
        }
    }
    
    let final_dest_path = if !is_dir && dest.exists() {
        let unique_path = generate_unique_file_path(&dest_path);
        println!("Destination file exists, using unique path: {}", unique_path);
        unique_path
    } else {
        dest_path.clone()
    };
    
    dest = Path::new(&final_dest_path);
    
    if let Some(dest_parent) = dest.parent() {
        if !dest_parent.exists() {
            fs::create_dir_all(dest_parent)
                .map_err(|e| format!("Failed to create destination directory: {}", e))?;
        }
    }
    
    println!("Copying {}: {} to {}", if is_dir { "directory" } else { "file" }, src_path, final_dest_path);
    
    #[cfg(windows)]
    {
        use std::process::Command;
        
        let max_retries = 3;
        let mut last_error: Option<std::io::Error> = None;
        
        for attempt in 0..max_retries {
            if is_dir {
                let src_win = src_path.replace("/", "\\");
                let dest_win = final_dest_path.replace("/", "\\");
                
                println!("Attempt {}: Using robocopy: {} -> {}", attempt + 1, src_win, dest_win);
                
                let output = Command::new("robocopy")
                    .arg(&src_win)
                    .arg(&dest_win)
                    .arg("*")
                    .arg("/E")
                    .arg("/NFL")
                    .arg("/NDL")
                    .arg("/NJH")
                    .arg("/NJS")
                    .arg("/R:3")
                    .arg("/W:1")
                    .output()
                    .map_err(|e| format!("Failed to execute robocopy command: {}", e))?;
                
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
            
            if attempt < max_retries - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
        
        if let Some(e) = last_error {
            return Err(format!("Failed to copy after {} attempts: {}", max_retries, e));
        }
    }
    
    #[cfg(not(windows))]
    {
        let max_retries = 3;
        let mut last_error: Option<std::io::Error> = None;
        
        for attempt in 0..max_retries {
            if is_dir {
                match fs_extra::dir::copy(src, dest, &fs_extra::dir::CopyOptions::new()) {
                    Ok(_) => {
                        let norm = normalize_path(&final_dest_path);
                        println!("Returning normalized path: {}", norm);
                        return Ok(norm);
                    },
                    Err(e) => {
                        println!("copy_dir_all attempt {} failed: {:?}", attempt + 1, e);
                        last_error = Some(std::io::Error::new(std::io::ErrorKind::Other, e.to_string()));
                    }
                }
            } else {
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
            
            if attempt < max_retries - 1 {
                tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
            }
        }
        
        if let Some(e) = last_error {
            return Err(format!("Failed to copy after {} attempts: {}", max_retries, e));
        }
    }
    
    Err("Unknown error occurred while copying".to_string())
}

#[tauri::command]
pub async fn move_file(src_path: String, dest_path: String, app: tauri::AppHandle) -> Result<(), String> {
    let src = Path::new(&src_path);
    let dest = Path::new(&dest_path);
    
    if !src.exists() {
        return Err(format!("源文件不存在: {}", src_path));
    }
    
    let is_dir = src.is_dir();

    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("创建目标目录失败: {}", e))?;
        }
    }
    
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
    
    if !success && !is_dir {
        if let Ok(_) = fs::copy(src, dest) {
            if let Ok(_) = fs::remove_file(src) {
                success = true;
            } else {
                let _ = fs::remove_file(dest);
            }
        }
    }
    
    if !success {
        return Err(format!("无法移动文件/文件夹 (可能被锁定或跨卷): {:?}", last_error));
    }

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
pub async fn write_file_from_bytes(file_path: String, bytes: Vec<u8>, app: tauri::AppHandle) -> Result<(), String> {
    use std::io::Write;
    
    let path = Path::new(&file_path);
    
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }
    }
    
    let max_retries = 3;
    let mut attempt = 0;
    let mut last_error: Option<std::io::Error> = None;
    
    while attempt < max_retries {
        match fs::File::create(path) {
            Ok(mut file) => {
                match file.write_all(&bytes) {
                    Ok(_) => {
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
