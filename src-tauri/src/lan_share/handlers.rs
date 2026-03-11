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

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<tokio::sync::RwLock<LanShareConfig>>,
    pub sessions: Arc<SessionManager>,
    pub devices: Arc<DeviceManager>,
    pub root_path: Arc<std::path::PathBuf>,
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

pub async fn handle_root() -> impl IntoResponse {
    Json(serde_json::json!({
        "name": "Aurora Gallery LAN Share",
        "version": "1.0",
        "endpoints": {
            "auth": "POST /api/auth/verify",
            "browse": "GET /api/browse",
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

    let session = state.sessions.create_session(device_id.clone(), device_name.clone(), ip.clone()).await;
    state.devices.register_device(&session).await;

    log::info!("[LAN Share] 认证成功 - 设备: {} ({}), IP: {}, Token: {}...", 
        device_name, device_id, ip, &session.token[..8]);

    Ok(Json(AuthResponse {
        success: true,
        token: Some(session.token),
        expires_in: Some(SESSION_TIMEOUT_SECS),
        error: None,
    }))
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

    log::info!("[LAN Share] 浏览请求 - 设备: {}, 路径: {} (原始: {})", session.device_name, relative_path, raw_path);

    if !full_path.exists() || !full_path.starts_with(state.root_path.as_path()) {
        log::warn!("[LAN Share] 浏览失败 - 路径不存在或越权访问: {}", full_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "Path not found"));
    }

    let mut folders = Vec::new();
    let mut images = Vec::new();

    if let Ok(mut entries) = fs::read_dir(&full_path).await {
        while let Ok(Some(entry)) = entries.next_entry().await {
            let path = entry.path();
            let name = path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();

            if name.starts_with('.') {
                continue;
            }

            let relative_item_path = path.strip_prefix(state.root_path.as_path())
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");

            if path.is_dir() {
                folders.push(BrowseItem {
                    name,
                    path: relative_item_path,
                    item_type: "folder".to_string(),
                    size: None,
                    thumbnail: None,
                    width: None,
                    height: None,
                });
            } else if is_image_file(&name) {
                let size = entry.metadata().await.ok().map(|m| m.len());
                let thumbnail_url = format!("/api/thumbnail?path={}", urlencoding::encode(&relative_item_path));
                
                images.push(BrowseItem {
                    name,
                    path: relative_item_path,
                    item_type: "image".to_string(),
                    size,
                    thumbnail: Some(thumbnail_url),
                    width: None,
                    height: None,
                });
            }
        }
    }

    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    log::info!("[LAN Share] 浏览成功 - 返回 {} 个文件夹, {} 张图片", folders.len(), images.len());

    Ok(Json(BrowseResponse {
        current_path: relative_path,
        folders,
        images,
    }))
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
