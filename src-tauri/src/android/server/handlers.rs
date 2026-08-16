use axum::{
    extract::{ConnectInfo, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
use tower_http::cors::{Any, CorsLayer};

use super::types::AndroidLanServerConfig;
use crate::lan_share::device_manager::DeviceManager;
use crate::lan_share::session::SessionManager;
use crate::lan_share::types::*;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<tokio::sync::RwLock<AndroidLanServerConfig>>,
    pub sessions: Arc<SessionManager>,
    pub devices: Arc<DeviceManager>,
    pub cache_dir: Arc<std::path::PathBuf>,
    pub app_handle: AppHandle,
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

#[derive(Debug, Deserialize)]
pub struct PaletteQuery {
    pub path: String,
}

/// 设备列表变化时通知前端刷新（安卓端服务端同时给本机 UI 使用）。
fn emit_devices_changed(app_handle: &AppHandle) {
    if let Err(e) = app_handle.emit("lan-share-devices-changed", ()) {
        log::warn!("[LAN Share Android] 发送 lan-share-devices-changed 事件失败: {}", e);
    }
}

/// 双向连接融合：对端客户端认证时携带了 peer_server 信息，
/// 通知本机前端自动反向连接对端服务端。device_name 为对端自报的设备名。
fn emit_peer_pairing(
    app_handle: &AppHandle,
    host: &str,
    peer: &PeerServerInfo,
    peer_device_name: &str,
) {
    if host.is_empty() || peer.access_code.is_empty() {
        return;
    }
    if let Err(e) = app_handle.emit(
        "lan-share-peer-pairing",
        serde_json::json!({
            "host": host,
            "port": peer.port,
            "accessCode": peer.access_code,
            "deviceName": peer_device_name,
        }),
    ) {
        log::warn!("[LAN Share Android] 发送 lan-share-peer-pairing 事件失败: {}", e);
    }
}

fn parse_device_type(user_agent: &str) -> String {
    let ua_lower = user_agent.to_lowercase();
    if ua_lower.contains("ipad") {
        return "tablet".to_string();
    }
    if ua_lower.contains("iphone") {
        return "phone".to_string();
    }
    if ua_lower.contains("android") {
        let tablet_keywords = ["tablet", "sm-", "sc-", "nexus", "pixel", "kindle", "pad"];
        for keyword in &tablet_keywords {
            if ua_lower.contains(keyword) {
                return "tablet".to_string();
            }
        }
        if ua_lower.contains("mobile") {
            return "phone".to_string();
        }
        return "tablet".to_string();
    }
    if ua_lower.contains("windows nt") || ua_lower.contains("windows phone") {
        return "desktop".to_string();
    }
    if ua_lower.contains("macintosh") || ua_lower.contains("mac os x") {
        return "desktop".to_string();
    }
    if ua_lower.contains("linux") {
        return "desktop".to_string();
    }
    "phone".to_string()
}

pub async fn handle_root() -> impl IntoResponse {
    Json(serde_json::json!({
        "name": "Aurora Gallery Android LAN Server",
        "version": "1.0",
        "endpoints": {
            "auth": "POST /api/auth/verify",
            "browse": "GET /api/browse",
            "all_image_folders": "GET /api/all_image_folders",
            "search": "GET /api/search",
            "thumbnail": "GET /api/thumbnail",
            "image": "GET /api/image",
            "devices": "GET /api/devices"
        }
    }))
}

pub async fn handle_auth(
    State(state): State<AppState>,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(payload): Json<AuthRequest>,
) -> Result<Json<AuthResponse>, StatusCode> {
    log::info!(
        "[LAN Share Android] 认证请求来自 IP: {}, 验证码: {}",
        addr.ip(),
        payload.code
    );

    let config = state.config.read().await;

    if payload.code != config.access_code {
        log::warn!(
            "[LAN Share Android] 认证失败 - 验证码错误: {} (期望: {})",
            payload.code,
            config.access_code
        );
        return Ok(Json(AuthResponse {
            success: false,
            token: None,
            expires_in: None,
            error: Some("Invalid access code".to_string()),
            server_name: None,
        }));
    }

    let device_id = payload
        .device_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let device_name = payload
        .device_name
        .unwrap_or_else(|| format!("Device-{}", &device_id[..8]));
    let ip = addr.ip().to_string();

    let user_agent = headers
        .get(header::USER_AGENT)
        .and_then(|h| h.to_str().ok())
        .unwrap_or("");
    let device_type = parse_device_type(user_agent);

    let session = state
        .sessions
        .create_session(device_id.clone(), device_name.clone(), ip.clone())
        .await;
    state.devices.register_device(&session, &device_type).await;
    emit_devices_changed(&state.app_handle);

    // 双向连接融合：对端携带了服务端信息，通知本机前端自动反向连接
    if let Some(ref peer) = payload.peer_server {
        let peer_host = addr.ip().to_string();
        emit_peer_pairing(&state.app_handle, &peer_host, peer, &device_name);
        log::info!(
            "[LAN Share Android] 收到对端服务端信息，请求双向配对 - 对端: {}:{}, 来自: {}",
            peer_host,
            peer.port,
            device_name
        );
    }

    log::info!(
        "[LAN Share Android] 认证成功 - 设备: {} ({}), IP: {}, 类型: {}",
        device_name,
        device_id,
        ip,
        device_type
    );

    Ok(Json(AuthResponse {
        success: true,
        token: Some(session.token),
        expires_in: Some(SESSION_TIMEOUT_SECS),
        error: None,
        server_name: if config.server_name.is_empty() {
            None
        } else {
            Some(config.server_name.clone())
        },
    }))
}

pub async fn handle_logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<OperationResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.get_session_by_token(&token).await;

    state.sessions.remove_session(&token).await;
    if let Some(s) = session {
        state.devices.remove_device(&s.device_id).await;
        emit_devices_changed(&state.app_handle);
        log::info!("[LAN Share Android] 设备登出 - {} ({})", s.device_name, s.device_id);
    }

    Ok(Json(OperationResponse {
        success: true,
        path: None,
        error: None,
    }))
}

/// 所有含图文件夹（MediaStore BUCKET_ID 分组）+ 根目录散落图片。
pub async fn handle_all_image_folders(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AllImageFoldersResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state
        .sessions
        .validate_token(&token)
        .await
        .ok_or_else(|| {
            log::warn!("[LAN Share Android] all_image_folders 请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    state.devices.update_activity(&session.device_id).await;

    let result = tokio::task::spawn_blocking(super::media_store::scan_all)
        .await
        .map_err(|e| {
            log::error!("[LAN Share Android] scan_all join error: {:?}", e);
            error_response(StatusCode::INTERNAL_SERVER_ERROR, "MediaStore scan failed")
        })?;

    let (folders, root_images) = result.map_err(|e| {
        log::error!("[LAN Share Android] MediaStore 扫描失败: {}", e);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, &e)
    })?;

    log::info!(
        "[LAN Share Android] all_image_folders 成功 - {} 个文件夹, {} 张根目录图片",
        folders.len(),
        root_images.len()
    );

    Ok(Json(AllImageFoldersResponse {
        folders,
        root_images,
        allow_edit: Some(false),
        allow_upload: Some(false),
    }))
}

/// 浏览文件夹：path 参数为 BUCKET_ID。
pub async fn handle_browse(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<BrowseQuery>,
) -> Result<Json<BrowseResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state
        .sessions
        .validate_token(&token)
        .await
        .ok_or_else(|| {
            log::warn!("[LAN Share Android] 浏览请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    state.devices.update_activity(&session.device_id).await;

    let bucket_id = query.path.unwrap_or_default();
    log::info!(
        "[LAN Share Android] 浏览请求 - 设备: {}, BUCKET_ID: {}",
        session.device_name,
        bucket_id
    );

    if bucket_id.is_empty() {
        // 空路径：返回文件夹列表（与 browse 根目录语义一致）
        let result = tokio::task::spawn_blocking(super::media_store::scan_all)
            .await
            .map_err(|e| {
                log::error!("[LAN Share Android] scan_all join error: {:?}", e);
                error_response(StatusCode::INTERNAL_SERVER_ERROR, "MediaStore scan failed")
            })?;
        let (folders, root_images) = result.map_err(|e| {
            log::error!("[LAN Share Android] MediaStore 扫描失败: {}", e);
            error_response(StatusCode::INTERNAL_SERVER_ERROR, &e)
        })?;
        return Ok(Json(BrowseResponse {
            current_path: String::new(),
            folders,
            images: root_images,
            allow_edit: Some(false),
            allow_upload: Some(false),
        }));
    }

    let bucket_id_clone = bucket_id.clone();
    let result = tokio::task::spawn_blocking(move || {
        super::media_store::browse_bucket(&bucket_id_clone)
    })
    .await
    .map_err(|e| {
        log::error!("[LAN Share Android] browse_bucket join error: {:?}", e);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, "MediaStore browse failed")
    })?;

    let images = result.map_err(|e| {
        log::error!("[LAN Share Android] 文件夹浏览失败: {}", e);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, &e)
    })?;

    log::info!(
        "[LAN Share Android] 浏览成功 - 返回 {} 张图片",
        images.len()
    );

    Ok(Json(BrowseResponse {
        current_path: bucket_id,
        folders: Vec::new(),
        images,
        allow_edit: Some(false),
        allow_upload: Some(false),
    }))
}

/// 缩略图：path 参数为 MediaStore 图片 ID。
pub async fn handle_thumbnail(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ThumbnailQuery>,
) -> Result<Response, Response> {
    let token = extract_token_with_fallback(&headers, query.token.as_ref())?;
    let session = state
        .sessions
        .validate_token(&token)
        .await
        .ok_or_else(|| {
            log::warn!("[LAN Share Android] 缩略图请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    state.devices.update_activity(&session.device_id).await;

    let image_id: i64 = query.path.parse().map_err(|_| {
        log::warn!("[LAN Share Android] 缩略图失败 - 无效的图片 ID: {}", query.path);
        error_response(StatusCode::BAD_REQUEST, "Invalid image id")
    })?;

    let cache_dir = state.cache_dir.clone();
    let result = tokio::task::spawn_blocking(move || {
        super::media_store::get_thumbnail_bytes(image_id, &cache_dir)
    })
    .await
    .map_err(|e| {
        log::error!("[LAN Share Android] get_thumbnail join error: {:?}", e);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, "Thumbnail failed")
    })?;

    let bytes = result.map_err(|e| {
        log::warn!("[LAN Share Android] 缩略图生成失败 (id={}): {}", image_id, e);
        error_response(StatusCode::NOT_FOUND, "Thumbnail not available")
    })?;

    Ok((
        [
            (header::CONTENT_TYPE, "image/jpeg"),
            (header::CACHE_CONTROL, "private, max-age=600"),
        ],
        bytes,
    )
        .into_response())
}

/// 原图：path 参数为 MediaStore 图片 ID。
pub async fn handle_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<ImageQuery>,
) -> Result<Response, Response> {
    let token = extract_token_with_fallback(&headers, query.token.as_ref())?;
    let session = state
        .sessions
        .validate_token(&token)
        .await
        .ok_or_else(|| {
            log::warn!("[LAN Share Android] 图片请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    state.devices.update_activity(&session.device_id).await;

    let image_id: i64 = query.path.parse().map_err(|_| {
        log::warn!("[LAN Share Android] 图片失败 - 无效的图片 ID: {}", query.path);
        error_response(StatusCode::BAD_REQUEST, "Invalid image id")
    })?;

    let result = tokio::task::spawn_blocking(move || {
        super::media_store::get_image_bytes(image_id)
    })
    .await
    .map_err(|e| {
        log::error!("[LAN Share Android] get_image join error: {:?}", e);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, "Image read failed")
    })?;

    let (bytes, content_type) = result.map_err(|e| {
        log::warn!("[LAN Share Android] 图片读取失败 (id={}): {}", image_id, e);
        error_response(StatusCode::NOT_FOUND, "Image not found")
    })?;

    log::info!(
        "[LAN Share Android] 图片返回成功 - id: {}, 大小: {} bytes",
        image_id,
        bytes.len()
    );

    Ok((
        [
            (header::CONTENT_TYPE, content_type.as_str()),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
        bytes,
    )
        .into_response())
}

/// 搜索：按文件名 LIKE 匹配。安卓端无调色板数据，palette 接口固定返回空。
pub async fn handle_search(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<SearchQuery>,
) -> Result<Json<BrowseResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state
        .sessions
        .validate_token(&token)
        .await
        .ok_or_else(|| {
            log::warn!("[LAN Share Android] 搜索请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    state.devices.update_activity(&session.device_id).await;

    let search_term = query.q.clone();
    let result = tokio::task::spawn_blocking(move || {
        super::media_store::search_images(&search_term)
    })
    .await
    .map_err(|e| {
        log::error!("[LAN Share Android] search join error: {:?}", e);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, "Search failed")
    })?;

    let images = result.map_err(|e| {
        log::error!("[LAN Share Android] 搜索失败: {}", e);
        error_response(StatusCode::INTERNAL_SERVER_ERROR, &e)
    })?;

    log::info!(
        "[LAN Share Android] 搜索完成 - 关键词: {}, 找到 {} 张图片",
        query.q,
        images.len()
    );

    Ok(Json(BrowseResponse {
        current_path: format!("search:{}", query.q),
        folders: Vec::new(),
        images,
        allow_edit: None,
        allow_upload: None,
    }))
}

/// 安卓端无调色板数据，固定返回空列表（保持与桌面端 API 兼容）。
pub async fn handle_palette(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(_query): Query<PaletteQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let token = extract_token(&headers)?;
    let _session = state
        .sessions
        .validate_token(&token)
        .await
        .ok_or_else(|| {
            log::warn!("[LAN Share Android] palette 请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;
    Ok(Json(serde_json::json!({ "palette": [] })))
}

pub async fn handle_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<DevicesResponse>, Response> {
    let token = extract_token(&headers)?;
    let _session = state
        .sessions
        .validate_token(&token)
        .await
        .ok_or_else(|| {
            log::warn!("[LAN Share Android] 设备列表请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;

    let devices = state.devices.get_devices().await;
    log::debug!(
        "[LAN Share Android] 设备列表请求 - 当前 {} 个设备在线",
        devices.len()
    );
    Ok(Json(DevicesResponse { devices }))
}

pub async fn handle_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await.ok_or_else(|| {
        log::warn!("[LAN Share Android] 心跳请求失败 - 无效或过期的 Token");
        error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
    })?;
    state.devices.update_activity(&session.device_id).await;
    Ok(Json(serde_json::json!({ "success": true })))
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

fn extract_token_with_fallback(
    headers: &HeaderMap,
    query_token: Option<&String>,
) -> Result<String, Response> {
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

pub fn create_cors_layer() -> CorsLayer {
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any)
}
