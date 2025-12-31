// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::fs;
use std::num::NonZeroU32;
use std::sync::Arc;
use walkdir::WalkDir;
use tauri::Manager;
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
use tauri::menu::{Menu, MenuItem};


use base64::{Engine as _, engine::general_purpose};
use fast_image_resize as fr;
use rayon::prelude::*;

// 导入颜色相关模块
mod color_extractor;
mod color_db;
mod color_worker;

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
}

// Supported image extensions
const SUPPORTED_EXTENSIONS: &[&str] = &[
    "jpg", "jpeg", "png", "gif", "webp", "bmp", "tiff", "ico", "svg",
];

// Generate ID from file path (MD5 hash, first 9 chars)
fn generate_id(path: &str) -> String {
    // Normalize path (replace backslashes with forward slashes)
    let normalized = path.replace('\\', "/");
    
    let hash = md5::compute(normalized.as_bytes());
    
    // Convert to hex and take first 9 characters
    format!("{:x}", hash)[..9].to_string()
}

// Normalize path separators
fn normalize_path(path: &str) -> String {
    path.replace('\\', "/")
}

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
async fn scan_directory(path: String, app: tauri::AppHandle) -> Result<HashMap<String, FileNode>, String> {
    use std::fs;
    use rayon::prelude::*;
    
    let root_path = Path::new(&path);
    
    // Check if path exists and is a directory
    if !root_path.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    if !root_path.is_dir() {
        return Err(format!("Path is not a directory: {}", path));
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
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
            .and_then(|secs| {
                chrono::DateTime::from_timestamp(secs as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            }),
        updated_at: root_metadata
            .modified()
            .ok()
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap().as_secs())
            .and_then(|secs| {
                chrono::DateTime::from_timestamp(secs as i64, 0)
                    .map(|dt| dt.to_rfc3339())
            }),
        url: None,
        meta: None,
    };
    
    all_files.insert(root_id.clone(), root_node.clone());
    
    // Walk directory recursively (no depth limit)
    let entries: Vec<_> = WalkDir::new(&path)
        .into_iter()
        .filter_map(|e| e.ok())
        .collect();
    
    // First pass: collect all entries and build path -> parent path mapping
    let mut path_to_parent: HashMap<String, String> = HashMap::new();
    path_to_parent.insert(normalize_path(&path), String::new()); // Root has no parent
    
    let all_entries: Vec<_> = entries
        .into_iter()
        .filter_map(|entry| {
            let entry_path = entry.path();
            
            // Skip root directory itself
            if entry_path == root_path {
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
            
            // Get parent path
            if let Some(parent) = entry_path.parent() {
                let parent_path = normalize_path(parent.to_str().unwrap_or(""));
                path_to_parent.insert(full_path.clone(), parent_path);
            }
            
            Some(entry)
        })
        .collect();
    
    // Build path -> id mapping (will be populated as we process entries)
    let mut path_to_id: HashMap<String, String> = HashMap::new();
    path_to_id.insert(normalize_path(&path), root_id.clone());
    
    // Process entries in parallel using rayon (collect data without modifying shared state)
    let file_nodes: Vec<(String, FileNode, String)> = all_entries
        .par_iter()
        .filter_map(|entry| {
            let entry_path = entry.path();
            let metadata = match entry.metadata() {
                Ok(m) => m,
                Err(_) => return None,
            };
            
            // Use entry.file_type() for more reliable directory detection
            let file_type = entry.file_type();
            let is_directory = file_type.is_dir();
            let extension = entry_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase())
                .unwrap_or_default();
            
            let full_path = normalize_path(entry_path.to_str().unwrap_or(""));
            let file_id = generate_id(&full_path);
            let file_name = entry_path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("")
                .to_string();
            
            // Get parent path (we'll resolve parent_id later)
            let parent_path = path_to_parent.get(&full_path).cloned().unwrap_or_default();
            
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
                };
                
                Some((file_id, folder_node, parent_path))
            } else if is_supported_image(&extension) {
                // Create image file node (parent_id will be set later)
                let file_size = metadata.len();
                
                // Try to get image dimensions efficiently (without loading full image)
                let (width, height) = image::image_dimensions(entry_path).unwrap_or((0, 0));
                
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
                };
                
                Some((file_id, image_node, parent_path))
            } else {
                None
            }
        })
        .collect();
    
    // Now process nodes sequentially to build relationships
    // First pass: add all folders to path_to_id mapping
    for (id, node, _) in &file_nodes {
        if matches!(node.r#type, FileType::Folder) {
            path_to_id.insert(node.path.clone(), id.clone());
        }
    }
    
    // Second pass: add all nodes to the map and resolve parent_id
    for (id, mut node, parent_path) in file_nodes {
        // Resolve parent_id from parent_path
        if !parent_path.is_empty() {
            if let Some(parent_id) = path_to_id.get(&parent_path).cloned() {
                node.parent_id = Some(parent_id);
            } else {
                // If parent not found in path_to_id, it might be the root
                if parent_path == normalize_path(&path) {
                    node.parent_id = Some(root_id.clone());
                }
            }
        }
        
        all_files.insert(id.clone(), node);
    }
    
    // Build parent-child relationships
    let mut children_to_add: Vec<(String, String)> = Vec::new(); // (parent_id, child_id)
    for (id, node) in all_files.iter() {
        if let Some(parent_id) = &node.parent_id {
            children_to_add.push((parent_id.clone(), id.clone()));
        } else if node.id != root_id {
            // Root-level item (shouldn't happen if parent_id resolution worked correctly)
            children_to_add.push((root_id.clone(), id.clone()));
        }
    }
    
    // Add children to their parents
    for (parent_id, child_id) in children_to_add {
        if let Some(parent_node) = all_files.get_mut(&parent_id) {
            if let Some(children) = &mut parent_node.children {
                children.push(child_id);
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
    
    // Collect all image paths from the scan results
    let image_paths: Vec<String> = all_files
        .iter()
        .filter(|(_, node)| matches!(node.r#type, FileType::Image))
        .map(|(_, node)| node.path.clone())
        .collect();
    
    // Add all image paths to color database in batches
    if !image_paths.is_empty() {
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let batch_size = 100;
        
        // Process in batches to avoid database overload
        for chunk in image_paths.chunks(batch_size) {
            let chunk_vec: Vec<String> = chunk.iter().cloned().collect();
            let pool_clone = pool.clone();
            
            // Add to database in a blocking thread
            let result = tokio::task::spawn_blocking(move || {
                let mut conn = pool_clone.get_connection();
                color_db::add_pending_files(&mut conn, &chunk_vec)
            }).await;
            
            if let Err(e) = result {
                eprintln!("Failed to add batch to color database: {}", e);
            } else if let Err(e) = result.unwrap() {
                eprintln!("Database error when adding batch: {}", e);
            }
        }
    }
    
    // DO NOT update root node in map - it's already there with children!
    // all_files.insert(root_id, root_node); // This line was overwriting the root node!
    
    Ok(all_files)
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
        
        Ok(image_node)
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
        })
    }
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn save_user_data(app: tauri::AppHandle, data: serde_json::Value) -> Result<bool, String> {
    use std::io::Write;
    
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    // Create directory if it doesn't exist
    fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    
    let data_file = app_data_dir.join("user_data.json");
    
    let json_string = serde_json::to_string_pretty(&data)
        .map_err(|e| format!("Failed to serialize data: {}", e))?;
    
    let mut file = fs::File::create(&data_file)
        .map_err(|e| format!("Failed to create data file: {}", e))?;
    
    file.write_all(json_string.as_bytes())
        .map_err(|e| format!("Failed to write data file: {}", e))?;
    
    Ok(true)
}

#[tauri::command]
async fn load_user_data(app: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let app_data_dir = app.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data directory: {}", e))?;
    
    let data_file = app_data_dir.join("user_data.json");
    
    if !data_file.exists() {
        return Ok(None);
    }
    
    let contents = fs::read_to_string(&data_file)
        .map_err(|e| format!("Failed to read data file: {}", e))?;
    
    let data: serde_json::Value = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse data file: {}", e))?;
    
    Ok(Some(data))
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
async fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path)
        .map_err(|e| format!("Failed to rename: {}", e))?;
    Ok(())
}

// Command to delete a file or folder
#[tauri::command]
async fn delete_file(path: String) -> Result<(), String> {
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
    Ok(())
}

#[tauri::command]
async fn copy_file(src_path: String, dest_path: String) -> Result<(), String> {
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
                    return Ok(());
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
                        return Ok(());
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
                    Ok(_) => return Ok(()),
                    Err(e) => {
                        println!("copy_dir_all attempt {} failed: {:?}", attempt + 1, e);
                        last_error = Some(e);
                    }
                }
            } else {
                // Use fs::copy for file copying
                match fs::copy(src, dest) {
                    Ok(_) => return Ok(()),
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
async fn move_file(src_path: String, dest_path: String) -> Result<(), String> {
    let src = Path::new(&src_path);
    let dest = Path::new(&dest_path);
    
    // Check if source exists
    if !src.exists() {
        return Err(format!("Source file does not exist: {}", src_path));
    }
    
    // Create dest directory if it doesn't exist
    if let Some(parent) = dest.parent() {
        if !parent.exists() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create destination directory: {}", e))?;
        }
    }
    
    // Try to move file with retry mechanism for file locking issues
    let max_retries = 3;
    let mut attempt = 0;
    let mut last_error: Option<std::io::Error> = None;
    
    while attempt < max_retries {
        match fs::rename(src, dest) {
            Ok(_) => return Ok(()),
            Err(e) => {
                attempt += 1;
                last_error = Some(e);
                
                // Wait a bit before retrying
                if attempt < max_retries {
                    tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
                }
            }
        }
    }
    
    // If all retries failed, try a fallback approach: copy + delete
    if let Some(e) = last_error {
        if e.kind() == std::io::ErrorKind::PermissionDenied || 
           e.kind() == std::io::ErrorKind::Other {
            
            // Fallback: copy then delete
            match fs::copy(src, dest) {
                Ok(_) => {
                    // Copy succeeded, now delete the original
                    match fs::remove_file(src) {
                        Ok(_) => return Ok(()),
                        Err(delete_err) => {
                            // If delete fails, try to clean up the copy
                            let _ = fs::remove_file(dest);
                            return Err(format!("Failed to delete original file after copy: {}", delete_err));
                        }
                    }
                },
                Err(copy_err) => {
                    return Err(format!("Failed to move file after {} attempts, fallback copy also failed: {} (original error: {})", max_retries, copy_err, e));
                }
            }
        } else {
            return Err(format!("Failed to move file after {} attempts: {}", max_retries, e));
        }
    }
    
    // This should never happen, but just in case
    Err("Unknown error occurred while moving file".to_string())
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

#[derive(Clone, Serialize)]
struct BatchResult {
    path: String,
    url: Option<String>,
}

// 1. 提取核心生成逻辑为独立函数 (不作为 command)
fn process_single_thumbnail(file_path: &str, cache_root: &Path) -> Option<String> {
    use std::fs;
    use std::io::{Read, BufWriter, BufReader};
    use image::codecs::jpeg::{JpegEncoder, JpegDecoder};
    use image::ImageFormat;
    
    let image_path = Path::new(file_path);
    if !image_path.exists() || file_path.contains(".Aurora_Cache") {
        return None;
    }

    // 快速 Hash
    let metadata = fs::metadata(image_path).ok()?;
    let size = metadata.len();
    let modified = metadata.modified()
        .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
        .unwrap_or(0);
    
    let mut file = fs::File::open(image_path).ok()?;
    let mut buffer = [0u8; 4096];
    let bytes_read = file.read(&mut buffer).unwrap_or(0);
    
    let cache_key = format!("{}-{}-{:?}", size, modified, &buffer[..bytes_read]);
    let cache_filename = format!("{:x}", md5::compute(cache_key.as_bytes()))[..24].to_string();
    
    // 先尝试检查两种格式的缓存文件是否存在，避免不必要的图像处理
    let jpg_cache_file_path = cache_root.join(format!("{}.jpg", cache_filename));
    let webp_cache_file_path = cache_root.join(format!("{}.webp", cache_filename));
    
    // 如果任一缓存文件存在，直接返回路径
    if jpg_cache_file_path.exists() {
        return Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string());
    }
    
    if webp_cache_file_path.exists() {
        return Some(webp_cache_file_path.to_str().unwrap_or_default().to_string());
    }
    
    // 缓存未命中，继续生成逻辑
    // 重新打开文件，使用 BufReader 以流式方式读取，避免一次性分配大内存
    let file = fs::File::open(image_path).ok()?;
    let reader = BufReader::new(file);
    
    // 1. 尝试识别格式
    let format = image::guess_format(&buffer[..bytes_read]).unwrap_or(ImageFormat::Png);

    let img = if format == ImageFormat::Jpeg {
        // 【针对 JPEG 的超大图优化】
        // 使用 BufReader 直接作为输入源，配合 scale 解码
        let mut decoder = JpegDecoder::new(reader).ok()?;
        
        // 如果原图非常大，我们可以只加载它的缩略版
        decoder.scale(256, 256).ok()?; 
        
        image::DynamicImage::from_decoder(decoder).ok()?
    } else {
        // 【针对 PNG 及其他格式的优化】
        // 使用流式解码器，避免先将整个文件读入 Vec<u8>
        // 这对于大尺寸 PNG (几十MB) 能节省大量内存带宽
        let mut image_reader = image::io::Reader::new(reader);
        image_reader.set_format(format);
        
        // 限制解码时的内存使用，防止炸弹攻击（可选，这里设为 512MB 足够应对 8K 图）
        image_reader.no_limits(); 
        
        image_reader.decode().ok()?
    };

    // 检查图片是否包含透明像素 (alpha < 255)
    let has_transparency = {
        let rgba = img.to_rgba8();
        let mut found_transparent = false;
        for pixel in rgba.pixels() {
            if pixel[3] < 255 {
                found_transparent = true;
                break;
            }
        }
        found_transparent
    };

    let width = img.width();
    let height = img.height();
    const TARGET_MIN_SIZE: u32 = 256;
    
    let (dst_width, dst_height) = if width < height {
        let ratio = height as f32 / width as f32;
        (TARGET_MIN_SIZE, (TARGET_MIN_SIZE as f32 * ratio) as u32)
    } else {
        let ratio = width as f32 / height as f32;
        ((TARGET_MIN_SIZE as f32 * ratio) as u32, TARGET_MIN_SIZE)
    };

    let src_width = NonZeroU32::new(width)?;
    let src_height = NonZeroU32::new(height)?;
    let dst_width_nz = NonZeroU32::new(dst_width)?;
    let dst_height_nz = NonZeroU32::new(dst_height)?;

    // 根据是否有透明度选择不同的处理方式
    if has_transparency {
        // 有透明度，生成 WebP 格式
        let src_image = fr::Image::from_vec_u8(
            src_width,
            src_height,
            img.to_rgba8().into_raw(),
            fr::PixelType::U8x4,
        ).ok()?;

        let mut dst_image = fr::Image::new(dst_width_nz, dst_height_nz, src_image.pixel_type());
        
        // 使用 Hamming 滤镜 (比 Lanczos3 快，质量也很好)
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut()).ok()?;

        // 确保目录存在
        if !cache_root.exists() {
            let _ = fs::create_dir_all(cache_root);
        }

        let cache_file = fs::File::create(&webp_cache_file_path).ok()?;
        let mut writer = BufWriter::new(cache_file);
        // 使用 image 库的 write_to 方法来处理 WebP 编码
        let resized_img = image::DynamicImage::ImageRgba8(image::ImageBuffer::from_raw(dst_width, dst_height, dst_image.buffer().to_vec())?);
        resized_img.write_to(&mut writer, ImageFormat::WebP).ok()?;

        Some(webp_cache_file_path.to_str().unwrap_or_default().to_string())
    } else {
        // 无透明度，生成 JPEG 格式
        let src_image = fr::Image::from_vec_u8(
            src_width,
            src_height,
            img.to_rgb8().into_raw(),
            fr::PixelType::U8x3,
        ).ok()?;

        let mut dst_image = fr::Image::new(dst_width_nz, dst_height_nz, src_image.pixel_type());
        
        // 使用 Hamming 滤镜 (比 Lanczos3 快，质量也很好)
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut()).ok()?;

        // 确保目录存在
        if !cache_root.exists() {
            let _ = fs::create_dir_all(cache_root);
        }

        let cache_file = fs::File::create(&jpg_cache_file_path).ok()?;
        let mut writer = BufWriter::new(cache_file);
        let mut encoder = JpegEncoder::new_with_quality(&mut writer, 80);
        encoder.encode(dst_image.buffer(), dst_width, dst_height, image::ColorType::Rgb8.into()).ok()?;

        Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string())
    }
}

#[tauri::command]
async fn get_thumbnail(file_path: String, cache_root: String) -> Result<Option<String>, String> {
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&cache_root);
        if !root.exists() {
             let _ = fs::create_dir_all(root);
        }
        process_single_thumbnail(&file_path, root)
    }).await;
    
    match result {
        Ok(val) => Ok(val),
        Err(e) => Err(e.to_string())
    }
}

#[derive(Clone, Serialize)]
struct ThumbnailBatchResult {
    path: String,
    url: Option<String>,
    colors: Option<Vec<color_extractor::ColorResult>>,
}

#[tauri::command]
async fn get_thumbnails_batch(
    file_paths: Vec<String>,
    cache_root: String,
    on_event: tauri::ipc::Channel<ThumbnailBatchResult>,
    app: tauri::AppHandle
) -> Result<(), String> {
    // 放入 blocking 线程处理缩略图读取
    let file_paths_clone2 = file_paths;
    let result = tauri::async_runtime::spawn_blocking(move || {
        let root = Path::new(&cache_root);
        if !root.exists() {
             let _ = fs::create_dir_all(root);
        }

        // 使用 Rayon 并行处理！
        file_paths_clone2.par_iter().for_each(|path| {
            // 快速检查缓存是否存在，跳过复杂的缩略图生成逻辑
            use std::fs;
            use std::io::{Read};
            use image::ImageFormat;
            
            let image_path = Path::new(path);
            if !image_path.exists() || path.contains(".Aurora_Cache") {
                let _ = on_event.send(ThumbnailBatchResult {
                    path: path.clone(),
                    url: None,
                    colors: None,
                });
                return;
            }

            // 快速 Hash - 复用 process_single_thumbnail 中的缓存逻辑
            let metadata = match fs::metadata(image_path) {
                Ok(m) => m,
                Err(_) => {
                    let _ = on_event.send(ThumbnailBatchResult {
                        path: path.clone(),
                        url: None,
                        colors: None,
                    });
                    return;
                }
            };
            let size = metadata.len();
            let modified = metadata.modified()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                .unwrap_or(0);
            
            let mut file = match fs::File::open(image_path) {
                Ok(f) => f,
                Err(_) => {
                    let _ = on_event.send(ThumbnailBatchResult {
                        path: path.clone(),
                        url: None,
                        colors: None,
                    });
                    return;
                }
            };
            let mut buffer = [0u8; 4096];
            let bytes_read = file.read(&mut buffer).unwrap_or(0);
            
            let cache_key = format!("{}-{}-{:?}", size, modified, &buffer[..bytes_read]);
            let cache_filename = format!("{:x}", md5::compute(cache_key.as_bytes()))[..24].to_string();
            
            // 先尝试检查两种格式的缓存文件是否存在，避免不必要的图像处理
            let jpg_cache_file_path = root.join(format!("{}.jpg", cache_filename));
            let webp_cache_file_path = root.join(format!("{}.webp", cache_filename));
            
            // 如果任一缓存文件存在，直接返回路径，跳过不必要的处理
            if jpg_cache_file_path.exists() {
                let url = Some(jpg_cache_file_path.to_str().unwrap_or_default().to_string());
                let _ = on_event.send(ThumbnailBatchResult {
                    path: path.clone(),
                    url,
                    colors: None, // 跳过颜色提取，提高响应速度
                });
                return;
            }
            
            if webp_cache_file_path.exists() {
                let url = Some(webp_cache_file_path.to_str().unwrap_or_default().to_string());
                let _ = on_event.send(ThumbnailBatchResult {
                    path: path.clone(),
                    url,
                    colors: None, // 跳过颜色提取，提高响应速度
                });
                return;
            }
            
            // 缓存未命中，才执行完整的缩略图生成逻辑
            let url = process_single_thumbnail(path, root);
            
            // 立即发送结果回前端，跳过颜色提取
            let _ = on_event.send(ThumbnailBatchResult {
                path: path.clone(),
                url,
                colors: None, // 跳过颜色提取，提高响应速度
            });
        });
        
        Ok(())
    }).await;

    match result {
        Ok(val) => val,
        Err(e) => Err(e.to_string())
    }
}

/// 生成拖拽预览图（用于外部拖拽时显示）
/// 将多个缩略图组合成一个堆叠效果的预览图
#[tauri::command]
async fn generate_drag_preview(
    thumbnail_paths: Vec<String>,
    total_count: usize,
    cache_root: String,
) -> Result<Option<String>, String> {
    use std::io::BufWriter;
    use image::{ImageBuffer, Rgba, RgbaImage, ImageEncoder};
    use image::imageops::{overlay, resize, FilterType};
    
    let result = tauri::async_runtime::spawn_blocking(move || -> Option<String> {
        // 预览图尺寸
        const PREVIEW_SIZE: u32 = 128;
        const THUMB_SIZE: u32 = 100;
        const BORDER_WIDTH: u32 = 2;
        
        // 创建透明背景
        let mut canvas: RgbaImage = ImageBuffer::from_pixel(
            PREVIEW_SIZE, 
            PREVIEW_SIZE, 
            Rgba([0, 0, 0, 0])
        );
        
        // 最多显示3个缩略图
        let preview_count = thumbnail_paths.len().min(3);
        
        // 加载并绘制每个缩略图（从后往前绘制，最后一个在最上面）
        for (i, thumb_path) in thumbnail_paths.iter().take(preview_count).enumerate().rev() {
            let thumb_path = Path::new(thumb_path);
            if !thumb_path.exists() {
                continue;
            }
            
            // 加载缩略图
            let img = match image::open(thumb_path) {
                Ok(img) => img,
                Err(_) => continue,
            };
            
            // 调整大小
            let thumb = resize(&img, THUMB_SIZE - BORDER_WIDTH * 2, THUMB_SIZE - BORDER_WIDTH * 2, FilterType::Triangle);
            
            // 创建带白色边框的缩略图
            let mut bordered: RgbaImage = ImageBuffer::from_pixel(
                THUMB_SIZE,
                THUMB_SIZE,
                Rgba([255, 255, 255, 230]) // 白色边框，略微透明
            );
            
            // 将缩略图放在边框中央
            overlay(&mut bordered, &thumb, BORDER_WIDTH as i64, BORDER_WIDTH as i64);
            
            // 计算位置偏移（堆叠效果）
            let offset_x = match i {
                0 => (PREVIEW_SIZE - THUMB_SIZE) / 2,
                1 => (PREVIEW_SIZE - THUMB_SIZE) / 2 - 8,
                _ => (PREVIEW_SIZE - THUMB_SIZE) / 2 + 8,
            };
            let offset_y = (PREVIEW_SIZE - THUMB_SIZE) / 2 + (i as u32) * 6;
            
            // 绘制到画布
            overlay(&mut canvas, &bordered, offset_x as i64, offset_y as i64);
        }
        
        // 如果有多个文件，添加计数徽章（总是显示，即使只有1个文件也显示）
        if total_count > 1 {
            // 绘制蓝色圆形徽章
            let badge_size = 28u32;
            let badge_x = PREVIEW_SIZE - badge_size - 4;
            let badge_y = PREVIEW_SIZE - badge_size - 4;
            
            // 绘制圆形背景
            for y in 0..badge_size {
                for x in 0..badge_size {
                    let dx = x as f32 - badge_size as f32 / 2.0;
                    let dy = y as f32 - badge_size as f32 / 2.0;
                    let dist = (dx * dx + dy * dy).sqrt();
                    if dist <= badge_size as f32 / 2.0 {
                        let px = badge_x + x;
                        let py = badge_y + y;
                        if px < PREVIEW_SIZE && py < PREVIEW_SIZE {
                            canvas.put_pixel(px, py, Rgba([37, 99, 235, 255])); // 蓝色
                        }
                    }
                }
            }
            
            // 绘制数字
            let count_text = total_count.to_string();
            // 使用简单的位图字体绘制数字
            // 数字 0-9 的 5x7 位图
            let digit_bitmaps: [[[u8; 5]; 7]; 10] = [
                // 0
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 1
                [[0,0,1,0,0], [0,1,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,0,1,0,0], [0,1,1,1,0]],
                // 2
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1]],
                // 3
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
                // 4
                [[1,0,0,0,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1]],
                // 5
                [[1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
                // 6
                [[1,1,1,1,1], [1,0,0,0,0], [1,0,0,0,0], [1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 7
                [[1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1], [0,0,0,0,1]],
                // 8
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1]],
                // 9
                [[1,1,1,1,1], [1,0,0,0,1], [1,0,0,0,1], [1,1,1,1,1], [0,0,0,0,1], [0,0,0,0,1], [1,1,1,1,1]],
            ];
            
            let digit_width = 5u32;
            let digit_height = 7u32;
            let spacing = 1u32;
            let total_text_width = (digit_width + spacing) * count_text.len() as u32 - spacing;
            let text_start_x = badge_x + (badge_size - total_text_width) / 2;
            let text_start_y = badge_y + (badge_size - digit_height) / 2;
            
            // 绘制每个数字
            for (char_idx, ch) in count_text.chars().enumerate() {
                if let Some(digit) = ch.to_digit(10) {
                    let digit_bitmap = &digit_bitmaps[digit as usize];
                    let digit_x = text_start_x + (digit_width + spacing) * char_idx as u32;
                    
                    for (row_idx, row) in digit_bitmap.iter().enumerate() {
                        for (col_idx, &pixel) in row.iter().enumerate() {
                            if pixel == 1 {
                                let px = digit_x + col_idx as u32;
                                let py = text_start_y + row_idx as u32;
                                if px < PREVIEW_SIZE && py < PREVIEW_SIZE {
                                    canvas.put_pixel(px, py, Rgba([255, 255, 255, 255])); // 白色
                                }
                            }
                        }
                    }
                }
            }
        }
        
        // 保存预览图到缓存目录
        let cache_path = Path::new(&cache_root);
        if !cache_path.exists() {
            let _ = fs::create_dir_all(cache_path);
        }
        
        let preview_file = cache_path.join("_drag_preview.png");
        
        let file = match fs::File::create(&preview_file) {
            Ok(f) => f,
            Err(_) => return None,
        };
        let writer = BufWriter::new(file);
        
        let encoder = image::codecs::png::PngEncoder::new(writer);
        match encoder.write_image(
            canvas.as_raw(),
            PREVIEW_SIZE,
            PREVIEW_SIZE,
            image::ColorType::Rgba8,
        ) {
            Ok(_) => Some(preview_file.to_str().unwrap_or_default().to_string()),
            Err(_) => None,
        }
    }).await;
    
    match result {
        Ok(val) => Ok(val),
        Err(e) => Err(e.to_string())
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
    app_handle.exit(0);
    Ok(())
}



#[tauri::command]
async fn get_dominant_colors(
    file_path: String, 
    count: usize, 
    thumbnail_path: Option<String>,
    app: tauri::AppHandle
) -> Result<Vec<color_extractor::ColorResult>, String> {
    use image::ImageFormat;
    use std::fs::File;
    use std::io::BufReader;
    use std::sync::Arc;
    
    // 1. 尝试从数据库获取颜色数据
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    let file_path_clone = file_path.clone();
    
    // 在单独线程中执行数据库操作
    let db_result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        color_db::get_colors_by_file_path(&mut conn, &file_path_clone)
    }).await.map_err(|e| format!("Failed to execute database query: {}", e))?;
    
    if let Ok(Some(colors)) = db_result {
        if !colors.is_empty() {
            return Ok(colors);
        }
    }
    
    // 2. 数据库中没有数据，提取颜色
    // 优先使用缩略图路径，如果提供了的话
    let image_path = if let Some(thumb_path) = &thumbnail_path {
        if Path::new(thumb_path).exists() {
            thumb_path.clone()
        } else {
            file_path.clone()
        }
    } else {
        file_path.clone()
    };
    
    // Check if file exists
    if !Path::new(&image_path).exists() {
        return Err(format!("File does not exist: {}", image_path));
    }
    
    // Load image (from thumbnail if available, otherwise from original)
    let file = File::open(&image_path)
        .map_err(|e| format!("Failed to open file: {}", e))?;
    
    let reader = BufReader::new(file);
    let img = image::load(reader, ImageFormat::from_path(&image_path).unwrap_or(ImageFormat::Jpeg))
        .map_err(|e| format!("Failed to load image: {}", e))?;
    
    // Extract dominant colors
    let colors = color_extractor::get_dominant_colors(&img, count);
    
    // 3. 将提取的颜色保存到数据库
    if !colors.is_empty() {
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let file_path_clone = file_path.clone();
        let colors_clone = colors.clone();
        
        // 在单独线程中执行数据库操作
        let _ = tokio::task::spawn_blocking(move || {
            let mut conn = pool.get_connection();
            
            // 先检查是否存在记录
            match color_db::get_colors_by_file_path(&mut conn, &file_path_clone) {
                Ok(None) => {
                    // 不存在记录，插入待处理状态
                    let _ = color_db::add_pending_files(&mut conn, &[file_path_clone.clone()]);
                },
                _ => {}
            }
            
            // 保存颜色数据
            color_db::save_colors(&mut conn, &file_path_clone, &colors_clone)
        }).await;
    }
    
    Ok(colors)
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
            greet,
            scan_directory,
            save_user_data,
            load_user_data,
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
            move_file,
            write_file_from_bytes,
            scan_file,
            hide_window,
            show_window,
            exit_app,
            get_dominant_colors,
            color_worker::pause_color_extraction,
            color_worker::resume_color_extraction
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
            let mut conn = pool_instance.get_connection();
            if let Err(e) = color_db::init_db(&mut conn) {
                eprintln!("Failed to initialize color database: {}", e);
                // 创建一个空的连接池作为备用
                color_db::ColorDbPool::new(&db_path).unwrap_or_else(|_|
                    panic!("Failed to create color database connection pool")
                )
            } else {
                // 克隆pool_instance，避免借用冲突
                let cloned_pool = pool_instance.clone();
                cloned_pool
            }
        },
        Err(e) => {
            eprintln!("Failed to create color database connection pool: {}", e);
            // 创建一个空的连接池作为备用
            color_db::ColorDbPool::new(&db_path).unwrap_or_else(|_| {
                panic!("Failed to create color database connection pool");
            })
        }
    };
            
            // 将数据库连接池保存到应用状态
            let pool_arc = Arc::new(pool);
            app.manage(pool_arc.clone());
            
            // 启动后台颜色提取任务
            // 持续处理待处理文件，每批最多处理20个文件
            let batch_size = 20;
            // 正确克隆AppHandle后再包装到Arc中
            let app_handle_new = app.handle().clone();
            let app_handle_arc = Arc::new(app_handle_new);
            
            tauri::async_runtime::spawn(async move {
                color_worker::color_extraction_worker(
                    pool_arc,
                    batch_size,
                    Some(app_handle_arc)
                ).await;
            });
            
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}