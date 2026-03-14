use axum::{
    extract::{
        ConnectInfo, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::fs;
use tower_http::cors::{Any, CorsLayer};

use super::device_manager::DeviceManager;
use super::session::SessionManager;
use super::types::*;
use crate::db::AppDbPool;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<tokio::sync::RwLock<LanShareConfig>>,
    pub sessions: Arc<SessionManager>,
    pub devices: Arc<DeviceManager>,
    pub root_path: Arc<std::path::PathBuf>,
    pub db_pool: Option<Arc<AppDbPool>>,
}

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ThumbnailQuery {
    pub path: String,
    #[serde(default = "default_thumbnail_size")]
    pub size: u32,
    #[serde(default)]
    pub token: Option<String>,
}

fn default_thumbnail_size() -> u32 {
    256
}

#[derive(Debug, Deserialize)]
pub struct ImageQuery {
    pub path: String,
    #[serde(default)]
    pub token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct SearchQuery {
    pub q: String,
    pub scope: Option<String>,
}

pub async fn handle_root() -> impl IntoResponse {
    Json(serde_json::json!({
        "name": "Aurora Gallery LAN Share",
        "version": "1.0",
        "endpoints": {
            "auth": "POST /api/auth/verify",
            "browse": "GET /api/browse",
            "search": "GET /api/search",
            "thumbnail": "GET /api/thumbnail",
            "image": "GET /api/image",
            "delete": "DELETE /api/file",
            "rename": "POST /api/rename",
            "devices": "GET /api/devices"
        }
    }))
}

pub async fn handle_root_html() -> impl IntoResponse {
    let html = super::server::get_index_html();
    log::info!("[LAN Share] 返回 index.html, 长度: {} bytes, 前100字符: {}", html.len(), &html.chars().take(100).collect::<String>());
    (
        [(header::CONTENT_TYPE, "text/html; charset=utf-8")],
        html
    )
}

pub async fn handle_style_css() -> impl IntoResponse {
    let css = super::server::get_style_css();
    log::info!("[LAN Share] 返回 style.css, 长度: {} bytes", css.len());
    (
        [(header::CONTENT_TYPE, "text/css; charset=utf-8")],
        css
    )
}

pub async fn handle_app_js() -> impl IntoResponse {
    let js = super::server::get_app_js();
    log::info!("[LAN Share] 返回 app.js, 长度: {} bytes, 包含 'React': {}", js.len(), js.contains("react") || js.contains("React"));
    (
        [(header::CONTENT_TYPE, "application/javascript; charset=utf-8")],
        js
    )
}

pub async fn handle_auth(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<AuthRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    log::info!("[LAN Share] 认证请求来自 IP: {}, 验证码: {}", addr.ip(), payload.code);
    
    let config = state.config.read().await;
    
    if payload.code != config.access_code {
        log::warn!("[LAN Share] 认证失败 - 验证码错误: {} (期望: {})", payload.code, config.access_code);
        return Ok(Json(AuthResponse {
            success: false,
            token: None,
            expires_in: None,
            error: Some("Invalid access code".to_string()),
        }));
    }

    let device_id = uuid::Uuid::new_v4().to_string();
    let device_name = payload.device_name.unwrap_or_else(|| {
        format!("Device-{}", &device_id[..8])
    });
    let ip = addr.ip().to_string();
    
    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    log::info!("[LAN Share] User-Agent: {}", user_agent);
    let device_type = parse_device_type(user_agent);

    let session = state.sessions.create_session(device_id.clone(), device_name.clone(), ip.clone()).await;
    state.devices.register_device(&session, &device_type).await;

    log::info!("[LAN Share] 认证成功 - 设备: {} ({}), IP: {}, 设备类型: {}, Token: {}...", 
        device_name, device_id, ip, device_type, &session.token[..8]);

    Ok(Json(AuthResponse {
        success: true,
        token: Some(session.token),
        expires_in: Some(SESSION_TIMEOUT_SECS),
        error: None,
    }))
}

fn parse_device_type(user_agent: &str) -> String {
    let ua_lower = user_agent.to_lowercase();
    
    // iPad 检测
    if ua_lower.contains("ipad") {
        return "tablet".to_string();
    }
    // iPhone 检测
    if ua_lower.contains("iphone") {
        return "phone".to_string();
    }
    // Android 检测 - 必须在 Linux 检测之前
    if ua_lower.contains("android") {
        // 平板特征检测
        let tablet_keywords = ["tablet", "sm-", "sc-", "nexus", "pixel", "kindle", "pad"];
        for keyword in &tablet_keywords {
            if ua_lower.contains(keyword) {
                return "tablet".to_string();
            }
        }
        // Android 手机通常包含 "Mobile" 关键词
        if ua_lower.contains("mobile") {
            return "phone".to_string();
        }
        // 其他 Android 设备默认为平板
        return "tablet".to_string();
    }
    // Windows 桌面检测
    if ua_lower.contains("windows nt") || ua_lower.contains("windows phone") {
        if ua_lower.contains("windows phone") {
            return "phone".to_string();
        }
        return "desktop".to_string();
    }
    // Mac 桌面检测
    if ua_lower.contains("macintosh") || ua_lower.contains("mac os x") {
        return "desktop".to_string();
    }
    // Linux 桌面检测（排除已处理的 Android）
    if ua_lower.contains("linux") {
        return "desktop".to_string();
    }
    
    // 默认返回手机
    "phone".to_string()
}

pub async fn handle_browse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] 浏览请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    
    state.devices.update_activity(&session.device_id).await;

    let raw_path = query.path.unwrap_or_default();
    let relative_path = if raw_path == "/" || raw_path.is_empty() {
        "".to_string()
    } else {
        raw_path.trim_start_matches('/').to_string()
    };
    let full_path = state.root_path.join(&relative_path);
    let root_path = state.root_path.clone();

    log::info!("[LAN Share] 浏览请求 - 设备: {}, 路径: {} (原始: {})", session.device_name, relative_path, raw_path);

    if !full_path.exists() || !full_path.starts_with(state.root_path.as_path()) {
        log::warn!("[LAN Share] 浏览失败 - 路径不存在或越权访问: {}", full_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "Path not found"));
    }

    let normalized_parent_path = crate::db::normalize_path(&full_path.to_string_lossy());
    
    if let Some(pool) = state.db_pool.clone() {
        let pool_clone = pool.clone();
        let normalized_parent_path_clone = normalized_parent_path.clone();
        let root_path_clone = root_path.clone();
        
        let result = tokio::task::spawn_blocking(move || {
            let conn = pool_clone.get_connection();
            
            match crate::db::file_index::get_children_by_parent_path(&conn, &normalized_parent_path_clone) {
                Ok(children) => {
                    if !children.is_empty() {
                        let folder_ids: Vec<String> = children.iter()
                            .filter(|e| e.file_type == "Folder")
                            .map(|e| e.file_id.clone())
                            .collect();
                        
                        let folder_info = crate::db::file_index::get_folder_info_batch(&conn, &folder_ids)
                            .unwrap_or_default();
                        
                        let root_path_str = root_path_clone.to_string_lossy().to_string();
                        
                        let mut folders: Vec<BrowseItem> = Vec::new();
                        let mut images: Vec<BrowseItem> = Vec::new();
                        
                        for entry in children {
                            let relative_item_path = entry.path.strip_prefix(&root_path_str)
                                .unwrap_or(&entry.path)
                                .to_string();
                            
                            if entry.file_type == "Folder" {
                                let (preview_paths, count) = folder_info.get(&entry.file_id)
                                    .map(|(paths, c)| {
                                        let rel_paths: Vec<String> = paths.iter()
                                            .map(|p| p.strip_prefix(&root_path_str).unwrap_or(p).to_string())
                                            .collect();
                                        (if rel_paths.is_empty() { None } else { Some(rel_paths) }, if *c > 0 { Some(*c) } else { None })
                                    })
                                    .unwrap_or((None, None));
                                
                                folders.push(BrowseItem {
                                    name: entry.name,
                                    path: relative_item_path,
                                    item_type: "folder".to_string(),
                                    size: count,
                                    thumbnail: None,
                                    preview_images: preview_paths,
                                    width: None,
                                    height: None,
                                });
                            } else if entry.file_type == "Image" {
                                let thumbnail_url = format!("/api/thumbnail?path={}", urlencoding::encode(&relative_item_path));
                                images.push(BrowseItem {
                                    name: entry.name,
                                    path: relative_item_path,
                                    item_type: "image".to_string(),
                                    size: Some(entry.size),
                                    thumbnail: Some(thumbnail_url),
                                    preview_images: None,
                                    width: entry.width,
                                    height: entry.height,
                                });
                            }
                        }
                        
                        folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                        images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                        
                        return Some((folders, images));
                    }
                }
                Err(e) => {
                    log::warn!("[LAN Share] 数据库查询失败，回退到文件系统: {}", e);
                }
            }
            None
        }).await.unwrap_or(None);
        
        if let Some((folders, images)) = result {
            log::info!("[LAN Share] 浏览成功 (数据库) - 返回 {} 个文件夹, {} 张图片", folders.len(), images.len());
            return Ok(Json(BrowseResponse {
                current_path: relative_path,
                folders,
                images,
            }));
        }
    }

    let full_path_clone = full_path.clone();
    let root_path_clone = root_path.clone();
    
    let (folder_paths, image_entries): (Vec<(std::path::PathBuf, String, String)>, Vec<(std::path::PathBuf, String, String, Option<u64>)>) = 
        tokio::task::spawn_blocking(move || {
            let mut folder_paths = Vec::new();
            let mut image_entries = Vec::new();
            
            if let Ok(entries) = std::fs::read_dir(&full_path_clone) {
                for entry in entries.flatten() {
                    let path = entry.path();
                    let name = path.file_name()
                        .and_then(|n| n.to_str())
                        .unwrap_or("unknown")
                        .to_string();

                    if name.starts_with('.') {
                        continue;
                    }

                    let relative_item_path = path.strip_prefix(root_path_clone.as_path())
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/");

                    if path.is_dir() {
                        folder_paths.push((path, name, relative_item_path));
                    } else if is_image_file(&name) {
                        let size = entry.metadata().ok().map(|m| m.len());
                        image_entries.push((path, name, relative_item_path, size));
                    }
                }
            }
            
            (folder_paths, image_entries)
        }).await.unwrap_or((Vec::new(), Vec::new()));

    let root_path_clone = root_path.clone();
    let folders: Vec<BrowseItem> = if !folder_paths.is_empty() {
        tokio::task::spawn_blocking(move || {
            use rayon::prelude::*;
            folder_paths.into_par_iter()
                .map(|(path, name, relative_item_path)| {
                    let (preview_images, file_count) = get_folder_info_fast(&path, root_path_clone.as_path());
                    
                    BrowseItem {
                        name,
                        path: relative_item_path,
                        item_type: "folder".to_string(),
                        size: file_count,
                        thumbnail: None,
                        preview_images,
                        width: None,
                        height: None,
                    }
                })
                .collect()
        }).await.unwrap_or_default()
    } else {
        Vec::new()
    };

    let mut images: Vec<BrowseItem> = if !image_entries.is_empty() {
        let db_pool = state.db_pool.clone();
        let root_path_clone = root_path.clone();
        let image_entries_clone = image_entries.clone();
        
        let dimensions: Vec<(Option<u32>, Option<u32>)> = if let Some(pool) = db_pool {
            tokio::task::spawn_blocking(move || {
                let paths: Vec<String> = image_entries_clone.iter()
                    .map(|(_, _, relative_item_path, _)| {
                        let normalized = crate::db::normalize_path(&root_path_clone.join(relative_item_path).to_string_lossy());
                        normalized
                    })
                    .collect();
                
                let conn = pool.get_connection();
                match crate::db::file_index::get_image_dimensions_batch(&conn, &paths) {
                    Ok(dim_map) => {
                        image_entries_clone.iter()
                            .map(|(_, _, relative_item_path, _)| {
                                let normalized = crate::db::normalize_path(&root_path_clone.join(relative_item_path).to_string_lossy());
                                dim_map.get(&normalized)
                                    .map(|(w, h)| (*w, *h))
                                    .unwrap_or((None, None))
                            })
                            .collect()
                    }
                    Err(_) => {
                        use rayon::prelude::*;
                        image_entries_clone.par_iter()
                            .map(|(path, _, _, _)| {
                                let (w, h) = crate::image_utils::get_image_dimensions(&path.to_string_lossy());
                                (if w > 0 { Some(w) } else { None }, if h > 0 { Some(h) } else { None })
                            })
                            .collect()
                    }
                }
            }).await.unwrap_or_default()
        } else {
            tokio::task::spawn_blocking(move || {
                use rayon::prelude::*;
                image_entries_clone.par_iter()
                    .map(|(path, _, _, _)| {
                        let (w, h) = crate::image_utils::get_image_dimensions(&path.to_string_lossy());
                        (if w > 0 { Some(w) } else { None }, if h > 0 { Some(h) } else { None })
                    })
                    .collect()
            }).await.unwrap_or_default()
        };
        
        image_entries.into_iter().zip(dimensions.iter())
            .map(|((_, name, relative_item_path, size), &(width, height))| {
                let thumbnail_url = format!("/api/thumbnail?path={}", urlencoding::encode(&relative_item_path));
                BrowseItem {
                    name,
                    path: relative_item_path,
                    item_type: "image".to_string(),
                    size,
                    thumbnail: Some(thumbnail_url),
                    preview_images: None,
                    width,
                    height,
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut folders = folders;
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    log::info!("[LAN Share] 浏览成功 (文件系统) - 返回 {} 个文件夹, {} 张图片", folders.len(), images.len());

    Ok(Json(BrowseResponse {
        current_path: relative_path,
        folders,
        images,
    }))
}

fn get_folder_info_fast(
    folder_path: &std::path::Path,
    root_path: &std::path::Path,
) -> (Option<Vec<String>>, Option<u64>) {
    let mut preview_images = Vec::new();
    let mut file_count: u64 = 0;
    
    if let Ok(entries) = std::fs::read_dir(folder_path) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            
            if name_str.starts_with('.') {
                continue;
            }
            
            let path = entry.path();
            
            if path.is_dir() {
                file_count += 1;
                
                if preview_images.len() < 3 {
                    if let Ok(sub_entries) = std::fs::read_dir(&path) {
                        for sub_entry in sub_entries.flatten() {
                            let sub_name = sub_entry.file_name();
                            let sub_name_str = sub_name.to_string_lossy();
                            
                            if sub_name_str.starts_with('.') {
                                continue;
                            }
                            
                            let sub_path = sub_entry.path();
                            if sub_path.is_file() && is_image_file(&sub_name_str) {
                                if let Ok(relative) = sub_path.strip_prefix(root_path) {
                                    let relative_str = relative.to_string_lossy().replace('\\', "/");
                                    preview_images.push(relative_str);
                                    if preview_images.len() >= 3 {
                                        break;
                                    }
                                }
                            }
                        }
                    }
                }
            } else if is_image_file(&name_str) {
                file_count += 1;
                
                if preview_images.len() < 3 {
                    if let Ok(relative) = path.strip_prefix(root_path) {
                        let relative_str = relative.to_string_lossy().replace('\\', "/");
                        preview_images.push(relative_str);
                    }
                }
            }
        }
    }
    
    let preview_images = if preview_images.is_empty() {
        None
    } else {
        Some(preview_images)
    };
    
    let file_count = if file_count > 0 { Some(file_count) } else { None };
    
    (preview_images, file_count)
}

pub async fn handle_thumbnail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ThumbnailQuery>,
) -> Result<Response, Response> {
    let token = extract_token_with_fallback(&headers, query.token.as_ref())?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] 缩略图请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    
    state.devices.update_activity(&session.device_id).await;

    let full_path = state.root_path.join(&query.path);
    
    log::debug!("[LAN Share] 缩略图请求 - 设备: {}, 路径: {}", session.device_name, query.path);

    if !full_path.exists() || !full_path.starts_with(state.root_path.as_path()) {
        log::warn!("[LAN Share] 缩略图失败 - 图片不存在: {}", full_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "Image not found"));
    }

    let cache_root = state.root_path.join(".Aurora_Cache");
    let path_str = full_path.to_string_lossy().to_string();
    let cache_root_str = cache_root.to_string_lossy().to_string();

    match crate::thumbnail::get_thumbnail(path_str, cache_root_str).await {
        Ok(Some(thumb_path)) => {
            let thumb_data = fs::read(&thumb_path).await
                .map_err(|e| {
                    log::error!("[LAN Share] 缩略图读取失败: {}", e);
                    error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
                })?;
            
            log::debug!("[LAN Share] 缩略图返回成功 - 大小: {} bytes", thumb_data.len());
            Ok((
                [(header::CONTENT_TYPE, "image/jpeg")],
                thumb_data
            ).into_response())
        }
        _ => {
            log::warn!("[LAN Share] 缩略图生成失败: {}", query.path);
            Err(error_response(StatusCode::NOT_FOUND, "Thumbnail not available"))
        }
    }
}

pub async fn handle_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ImageQuery>,
) -> Result<Response, Response> {
    let token = extract_token_with_fallback(&headers, query.token.as_ref())?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] 图片请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    
    state.devices.update_activity(&session.device_id).await;

    let full_path = state.root_path.join(&query.path);
    
    log::info!("[LAN Share] 图片请求 - 设备: {}, 路径: {}", session.device_name, query.path);

    if !full_path.exists() || !full_path.starts_with(state.root_path.as_path()) {
        log::warn!("[LAN Share] 图片失败 - 文件不存在: {}", full_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "Image not found"));
    }

    let data = fs::read(&full_path).await
        .map_err(|e| {
            log::error!("[LAN Share] 图片读取失败: {}", e);
            error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string())
        })?;

    let content_type = get_content_type(&full_path);

    log::info!("[LAN Share] 图片返回成功 - 大小: {} bytes, 类型: {}", data.len(), content_type);

    Ok((
        [(header::CONTENT_TYPE, content_type.as_str())],
        data
    ).into_response())
}

pub async fn handle_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ImageQuery>,
) -> Result<Json<OperationResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] 删除请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    
    let config = state.config.read().await;
    if !config.allow_edit {
        log::warn!("[LAN Share] 删除被拒绝 - 权限不足, 设备: {}", session.device_name);
        return Err(error_response(StatusCode::FORBIDDEN, "Edit not allowed"));
    }

    state.devices.update_activity(&session.device_id).await;

    let full_path = state.root_path.join(&query.path);
    
    log::info!("[LAN Share] 删除请求 - 设备: {}, 路径: {}", session.device_name, query.path);

    if !full_path.exists() || !full_path.starts_with(state.root_path.as_path()) {
        log::warn!("[LAN Share] 删除失败 - 文件不存在: {}", full_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "File not found"));
    }

    match fs::remove_file(&full_path).await {
        Ok(_) => {
            log::info!("[LAN Share] 删除成功 - 路径: {}", query.path);
            Ok(Json(OperationResponse {
                success: true,
                path: None,
                error: None,
            }))
        }
        Err(e) => {
            log::error!("[LAN Share] 删除失败 - 错误: {}", e);
            Ok(Json(OperationResponse {
                success: false,
                path: None,
                error: Some(e.to_string()),
            }))
        }
    }
}

pub async fn handle_rename(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<RenameRequest>,
) -> Result<Json<OperationResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] 重命名请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    
    let config = state.config.read().await;
    if !config.allow_edit {
        log::warn!("[LAN Share] 重命名被拒绝 - 权限不足, 设备: {}", session.device_name);
        return Err(error_response(StatusCode::FORBIDDEN, "Edit not allowed"));
    }

    state.devices.update_activity(&session.device_id).await;

    let old_path = state.root_path.join(&payload.old_path);
    let parent = old_path.parent().ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Invalid path"))?;
    let new_path = parent.join(&payload.new_name);
    
    log::info!("[LAN Share] 重命名请求 - 设备: {}, {} -> {}", 
        session.device_name, payload.old_path, payload.new_name);
    
    if !old_path.exists() || !old_path.starts_with(state.root_path.as_path()) {
        log::warn!("[LAN Share] 重命名失败 - 源文件不存在: {}", old_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "File not found"));
    }

    if new_path.exists() {
        log::warn!("[LAN Share] 重命名失败 - 目标文件已存在: {}", new_path.display());
        return Err(error_response(StatusCode::CONFLICT, "File already exists"));
    }

    match fs::rename(&old_path, &new_path).await {
        Ok(_) => {
            let new_relative = new_path.strip_prefix(state.root_path.as_path())
                .unwrap_or(&new_path)
                .to_string_lossy()
                .replace('\\', "/");
            log::info!("[LAN Share] 重命名成功 - 新路径: {}", new_relative);
            Ok(Json(OperationResponse {
                success: true,
                path: Some(new_relative),
                error: None,
            }))
        }
        Err(e) => {
            log::error!("[LAN Share] 重命名失败 - 错误: {}", e);
            Ok(Json(OperationResponse {
                success: false,
                path: None,
                error: Some(e.to_string()),
            }))
        }
    }
}

pub async fn handle_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DevicesResponse>, Response> {
    let token = extract_token(&headers)?;
    let _session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] 设备列表请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;

    let devices = state.devices.get_devices().await;
    log::debug!("[LAN Share] 设备列表请求 - 当前 {} 个设备在线", devices.len());
    Ok(Json(DevicesResponse { devices }))
}

pub async fn handle_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<BrowseResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] 搜索请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    
    state.devices.update_activity(&session.device_id).await;

    let search_term = query.q.to_lowercase();
    let scope = query.scope.as_deref().unwrap_or("all");
    
    log::info!("[LAN Share] 搜索请求 - 设备: {}, 关键词: {}, 范围: {}", session.device_name, search_term, scope);

    let (folders, images) = if let Some(pool) = state.db_pool.clone() {
        let scope_clone = scope.to_string();
        let search_term_clone = search_term.clone();
        let root_path = state.root_path.clone();
        
        tokio::task::spawn_blocking(move || {
            let conn = pool.get_connection();
            match crate::db::file_index::search_by_name(&conn, &search_term_clone, &scope_clone) {
                Ok(entries) => {
                    let mut found_folders: Vec<BrowseItem> = Vec::new();
                    let mut found_images: Vec<BrowseItem> = Vec::new();
                    
                    for entry in entries {
                        let relative_item_path = entry.path.clone();
                        
                        if entry.file_type == "Folder" {
                            let full_path = root_path.join(&relative_item_path);
                            let (preview_images, file_count) = get_folder_info_fast(&full_path, &root_path);
                            found_folders.push(BrowseItem {
                                name: entry.name,
                                path: relative_item_path,
                                item_type: "folder".to_string(),
                                size: file_count,
                                thumbnail: None,
                                preview_images,
                                width: None,
                                height: None,
                            });
                        } else if entry.file_type == "Image" {
                            let thumbnail_url = format!("/api/thumbnail?path={}", urlencoding::encode(&relative_item_path));
                            found_images.push(BrowseItem {
                                name: entry.name,
                                path: relative_item_path,
                                item_type: "image".to_string(),
                                size: Some(entry.size),
                                thumbnail: Some(thumbnail_url),
                                preview_images: None,
                                width: entry.width,
                                height: entry.height,
                            });
                        }
                    }
                    
                    found_folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                    found_images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                    
                    (found_folders, found_images)
                }
                Err(e) => {
                    log::error!("[LAN Share] 数据库搜索失败: {}", e);
                    (Vec::new(), Vec::new())
                }
            }
        }).await.unwrap_or((Vec::new(), Vec::new()))
    } else {
        let root_path = state.root_path.clone();
        let search_term_clone = search_term.clone();
        let scope_clone = scope.to_string();
        
        tokio::task::spawn_blocking(move || {
            let mut found_folders: Vec<BrowseItem> = Vec::new();
            let mut found_images: Vec<BrowseItem> = Vec::new();
            
            fn search_recursive(
                current_path: &std::path::Path,
                root_path: &std::path::Path,
                search_term: &str,
                scope: &str,
                folders: &mut Vec<BrowseItem>,
                images: &mut Vec<BrowseItem>,
            ) {
                if let Ok(entries) = std::fs::read_dir(current_path) {
                    for entry in entries.flatten() {
                        let path = entry.path();
                        let name = path.file_name()
                            .and_then(|n| n.to_str())
                            .unwrap_or("unknown")
                            .to_string();

                        if name.starts_with('.') {
                            continue;
                        }

                        let name_lower = name.to_lowercase();
                        let relative_item_path = path.strip_prefix(root_path)
                            .unwrap_or(&path)
                            .to_string_lossy()
                            .replace('\\', "/");

                        if path.is_dir() {
                            if (scope == "all" || scope == "folder") && name_lower.contains(search_term) {
                                let (preview_images, file_count) = get_folder_info_fast(&path, root_path);
                                folders.push(BrowseItem {
                                    name,
                                    path: relative_item_path,
                                    item_type: "folder".to_string(),
                                    size: file_count,
                                    thumbnail: None,
                                    preview_images,
                                    width: None,
                                    height: None,
                                });
                            }
                            search_recursive(&path, root_path, search_term, scope, folders, images);
                        } else if is_image_file(&name) {
                            if (scope == "all" || scope == "file") && name_lower.contains(search_term) {
                                let size = entry.metadata().ok().map(|m| m.len());
                                let (width, height) = {
                                    let (w, h) = crate::image_utils::get_image_dimensions(&path.to_string_lossy());
                                    (if w > 0 { Some(w) } else { None }, if h > 0 { Some(h) } else { None })
                                };
                                let thumbnail_url = format!("/api/thumbnail?path={}", urlencoding::encode(&relative_item_path));
                                images.push(BrowseItem {
                                    name,
                                    path: relative_item_path,
                                    item_type: "image".to_string(),
                                    size,
                                    thumbnail: Some(thumbnail_url),
                                    preview_images: None,
                                    width,
                                    height,
                                });
                            }
                        }
                    }
                }
            }

            search_recursive(&root_path, &root_path, &search_term_clone, &scope_clone, &mut found_folders, &mut found_images);
            
            found_folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            found_images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
            
            (found_folders, found_images)
        }).await.unwrap_or((Vec::new(), Vec::new()))
    };

    log::info!("[LAN Share] 搜索完成 - 找到 {} 个文件夹, {} 张图片", folders.len(), images.len());

    Ok(Json(BrowseResponse {
        current_path: format!("search:{}", search_term),
        folders,
        images,
    }))
}

fn extract_token(headers: &HeaderMap) -> Result<String, Response> {
    let auth_header = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Missing authorization header"))?;

    if !auth_header.starts_with("Bearer ") {
        return Err(error_response(StatusCode::UNAUTHORIZED, "Invalid authorization format"));
    }

    Ok(auth_header[7..].to_string())
}

fn extract_token_with_fallback(headers: &HeaderMap, query_token: Option<&String>) -> Result<String, Response> {
    if let Some(auth_header) = headers
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
    {
        if auth_header.starts_with("Bearer ") {
            return Ok(auth_header[7..].to_string());
        }
    }
    
    if let Some(token) = query_token {
        if !token.is_empty() {
            return Ok(token.clone());
        }
    }
    
    Err(error_response(StatusCode::UNAUTHORIZED, "Missing authorization"))
}

fn error_response(status: StatusCode, message: &str) -> Response {
    let body = serde_json::json!({
        "error": message
    });
    (status, Json(body)).into_response()
}

fn is_image_file(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    matches!(
        ext.as_str(),
        "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "tif" | "avif" | "jxl"
    )
}

fn find_preview_images(
    folder_path: &std::path::Path,
    root_path: &std::path::Path,
    limit: usize,
) -> Vec<String> {
    let mut images = Vec::new();
    const MAX_DEPTH: usize = 2;

    fn find_recursive(
        current_path: &std::path::Path,
        root_path: &std::path::Path,
        images: &mut Vec<String>,
        limit: usize,
        current_depth: usize,
        max_depth: usize,
    ) {
        if images.len() >= limit || current_depth > max_depth {
            return;
        }

        if let Ok(entries) = std::fs::read_dir(current_path) {
            let mut dirs_to_explore = Vec::new();
            
            for entry in entries.flatten() {
                if images.len() >= limit {
                    break;
                }

                let path = entry.path();
                
                if let Some(name) = path.file_name().and_then(|n| n.to_str()) {
                    if name.starts_with('.') {
                        continue;
                    }

                    if path.is_dir() {
                        if current_depth < max_depth {
                            dirs_to_explore.push(path);
                        }
                    } else if is_image_file(name) {
                        if let Ok(relative) = path.strip_prefix(root_path) {
                            let relative_str = relative.to_string_lossy().replace('\\', "/");
                            images.push(relative_str);
                        }
                    }
                }
            }

            for dir in dirs_to_explore {
                if images.len() >= limit {
                    break;
                }
                find_recursive(&dir, root_path, images, limit, current_depth + 1, max_depth);
            }
        }
    }

    find_recursive(folder_path, root_path, &mut images, limit, 0, MAX_DEPTH);
    images
}

fn get_content_type(path: &std::path::Path) -> String {
    let ext = path.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();

    match ext.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        "avif" => "image/avif",
        "jxl" => "image/jxl",
        _ => "application/octet-stream",
    }.to_string()
}

pub fn create_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
}
