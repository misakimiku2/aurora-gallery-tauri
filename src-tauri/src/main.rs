// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use std::fs;
use std::io::Cursor;
use std::sync::Mutex;
use walkdir::WalkDir;
use tauri::Manager;
use image::{ImageOutputFormat, GenericImageView, RgbaImage};
use fast_image_resize::{Resizer, ResizeAlg, FilterType, PixelType};
use std::num::NonZeroU32;
use base64::{Engine as _, engine::general_purpose};

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

// Check if file extension is supported
fn is_supported_image(extension: &str) -> bool {
    SUPPORTED_EXTENSIONS.contains(&extension.to_lowercase().as_str())
}

// Global state to store thumbnail hash -> file path mapping
type ThumbnailMap = Mutex<HashMap<String, String>>;

// Helper function to generate thumbnail data
fn generate_thumbnail_data(file_path: &str) -> Option<Vec<u8>> {
    // Load image
    let img = image::open(file_path).ok()?;
    
    let (width, height) = img.dimensions();
    let target_size = 256u32;
    
    // Don't upscale if image is already smaller
    if width <= target_size && height <= target_size {
        let mut buffer = Vec::new();
        let mut cursor = Cursor::new(&mut buffer);
        if img.write_to(&mut cursor, ImageOutputFormat::Jpeg(85)).is_ok() {
            return Some(buffer);
        }
        return None;
    }
    
    // Calculate new dimensions
    let (new_width, new_height) = if width <= height {
        let ratio = height as f32 / width as f32;
        (target_size, (target_size as f32 * ratio) as u32)
    } else {
        let ratio = width as f32 / height as f32;
        ((target_size as f32 * ratio) as u32, target_size)
    };
    
    // Convert to RGBA
    let rgba_img = img.to_rgba8();
    
    // Convert dimensions to NonZeroU32
    let src_width = NonZeroU32::new(width)?;
    let src_height = NonZeroU32::new(height)?;
    let dst_width = NonZeroU32::new(new_width)?;
    let dst_height = NonZeroU32::new(new_height)?;
    
    // Create source image
    let src_image = fast_image_resize::Image::from_vec_u8(
        src_width,
        src_height,
        rgba_img.into_raw(),
        PixelType::U8x4,
    ).ok()?;
    
    // Create destination image
    let mut dst_image = fast_image_resize::Image::new(
        dst_width,
        dst_height,
        PixelType::U8x4,
    );
    
    // Resize
    let mut resizer = Resizer::new(ResizeAlg::Convolution(FilterType::Lanczos3));
    if resizer.resize(&src_image.view(), &mut dst_image.view_mut()).is_err() {
        return None;
    }
    
    // Convert back to image format
    let resized_rgba = RgbaImage::from_raw(
        new_width,
        new_height,
        dst_image.buffer().to_vec(),
    )?;
    
    // Encode as JPEG
    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);
    if image::DynamicImage::ImageRgba8(resized_rgba)
        .write_to(&mut cursor, ImageOutputFormat::Jpeg(85))
        .is_ok()
    {
        Some(buffer)
    } else {
        None
    }
}

// Register thumbnail hash mapping
#[tauri::command]
async fn register_thumbnail_hash(app: tauri::AppHandle, hash: String, file_path: String) -> Result<(), String> {
    let state: tauri::State<'_, ThumbnailMap> = app.state();
    let mut map = state.lock().map_err(|e| format!("Failed to lock state: {}", e))?;
    map.insert(hash, file_path);
    Ok(())
}

#[tauri::command]
async fn scan_directory(path: String) -> Result<HashMap<String, FileNode>, String> {
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
                        width: 0,
                        height: 0,
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
    
    // DO NOT update root node in map - it's already there with children!
    // all_files.insert(root_id, root_node); // This line was overwriting the root node!
    
    Ok(all_files)
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
async fn get_thumbnail(file_path: String) -> Result<Option<String>, String> {
    
    // Check if file exists
    if !Path::new(&file_path).exists() {
        return Ok(None);
    }
    
    // Try to load image using image crate
    match image::open(&file_path) {
        Ok(img) => {
            // Get original dimensions
            let (width, height) = img.dimensions();
            
            // Calculate target dimensions: smallest dimension should be 256px
            let target_size = 256u32;
            
            // Don't upscale if image is already smaller
            if width <= target_size && height <= target_size {
                // Image is already small enough, use original
                let mut buffer = Vec::new();
                let mut cursor = Cursor::new(&mut buffer);
                img.write_to(&mut cursor, ImageOutputFormat::Jpeg(85))
                    .map_err(|e| format!("Failed to encode image: {}", e))?;
                
                let base64_str = general_purpose::STANDARD.encode(&buffer);
                return Ok(Some(format!("data:image/jpeg;base64,{}", base64_str)));
            }
            
            // Calculate new dimensions maintaining aspect ratio
            let (new_width, new_height) = if width <= height {
                // Width is smaller, scale based on width
                let ratio = height as f32 / width as f32;
                (target_size, (target_size as f32 * ratio) as u32)
            } else {
                // Height is smaller, scale based on height
                let ratio = width as f32 / height as f32;
                ((target_size as f32 * ratio) as u32, target_size)
            };
            
            // Convert image to RGBA format for fast_image_resize
            let rgba_img = img.to_rgba8();
            
            // Convert dimensions to NonZeroU32
            let src_width = NonZeroU32::new(width)
                .ok_or_else(|| "Image width is zero".to_string())?;
            let src_height = NonZeroU32::new(height)
                .ok_or_else(|| "Image height is zero".to_string())?;
            let dst_width = NonZeroU32::new(new_width)
                .ok_or_else(|| "Target width is zero".to_string())?;
            let dst_height = NonZeroU32::new(new_height)
                .ok_or_else(|| "Target height is zero".to_string())?;
            
            let src_image = fast_image_resize::Image::from_vec_u8(
                src_width,
                src_height,
                rgba_img.into_raw(),
                PixelType::U8x4,
            ).map_err(|e| format!("Failed to create source image: {}", e))?;
            
            // Create destination image
            let mut dst_image = fast_image_resize::Image::new(
                dst_width,
                dst_height,
                PixelType::U8x4,
            );
            
            // Create resizer and resize
            let mut resizer = Resizer::new(ResizeAlg::Convolution(FilterType::Lanczos3));
            
            resizer.resize(&src_image.view(), &mut dst_image.view_mut())
                .map_err(|e| format!("Failed to resize image: {}", e))?;
            
            // Convert back to image crate format
            let resized_rgba = RgbaImage::from_raw(
                new_width,
                new_height,
                dst_image.buffer().to_vec(),
            ).ok_or_else(|| "Failed to create resized image".to_string())?;
            
            // Encode as JPEG
            let mut buffer = Vec::new();
            let mut cursor = Cursor::new(&mut buffer);
            image::DynamicImage::ImageRgba8(resized_rgba)
                .write_to(&mut cursor, ImageOutputFormat::Jpeg(85))
                .map_err(|e| format!("Failed to encode image: {}", e))?;
            
            // Convert to base64
            let base64_str = general_purpose::STANDARD.encode(&buffer);
            Ok(Some(format!("data:image/jpeg;base64,{}", base64_str)))
        },
        Err(_e) => {
            // If image::open fails (e.g., for some PNG files), try to read file directly as base64
            use std::fs;
            
            // Read file as bytes
            let file_bytes = fs::read(&file_path)
                .map_err(|read_err| format!("Failed to read file: {}", read_err))?;
            
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
            
            // Convert to base64
            let base64_str = general_purpose::STANDARD.encode(&file_bytes);
            Ok(Some(format!("data:{};base64,{}", mime_type, base64_str)))
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

fn main() {
    
    let thumbnail_map: ThumbnailMap = Mutex::new(HashMap::new());
    
    tauri::Builder::default()
        // 清理调试阶段的 setup 注入，恢复默认构建
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_log::Builder::default().build())
        .manage(thumbnail_map)
        .invoke_handler(tauri::generate_handler![
            greet, 
            scan_directory, 
            save_user_data,
            load_user_data,
            get_default_paths,
            get_thumbnail,
            register_thumbnail_hash,
            read_file_as_base64
        ])
        .register_uri_scheme_protocol("thumbnail", move |_app_handle, request| {
            use tauri::http::{Response, StatusCode};
            
            let uri = request.uri();
            
            // Get file path from query parameter (e.g., thumbnail://hash.jpg?path=...)
            let file_path = if let Some(query) = uri.query() {
                // Parse query parameters
                let params: std::collections::HashMap<String, String> = query
                    .split('&')
                    .filter_map(|p| {
                        let mut parts = p.splitn(2, '=');
                        Some((parts.next()?.to_string(), parts.next()?.to_string()))
                    })
                    .collect();
                
                if let Some(path) = params.get("path") {
                    // URL decode the path
                    let decoded = urlencoding::decode(path).unwrap_or(std::borrow::Cow::Borrowed(path));
                    Some(decoded.to_string())
                } else {
                    None
                }
            } else {
                None
            };
            
            let file_path = match file_path {
                Some(path) => path,
                None => {
                    return Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(vec![])
                        .unwrap();
                }
            };
            
            // Generate thumbnail synchronously
            let thumbnail_data = match generate_thumbnail_data(&file_path) {
                Some(data) => data,
                None => {
                    return Response::builder()
                        .status(StatusCode::INTERNAL_SERVER_ERROR)
                        .body(vec![])
                        .unwrap();
                }
            };
            
            Response::builder()
                .header("Content-Type", "image/jpeg")
                .status(StatusCode::OK)
                .body(thumbnail_data)
                .unwrap()
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
