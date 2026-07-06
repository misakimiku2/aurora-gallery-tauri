use axum::{
    extract::{
        ConnectInfo, Multipart, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter};
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
    pub color_db_pool: Option<Arc<crate::color_db::ColorDbPool>>,
    pub app_handle: AppHandle,
}

/// 设备列表发生变化时通知前端刷新。事件本身不携带数据，前端收到后
/// 主动调用 lan_share_get_devices 拉取最新列表（避免事件负载与命令
/// 返回不一致）。
fn emit_devices_changed(app_handle: &AppHandle) {
    if let Err(e) = app_handle.emit("lan-share-devices-changed", ()) {
        log::warn!("[LAN Share] 发送 lan-share-devices-changed 事件失败: {}", e);
    }
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

pub async fn handle_root() -> impl IntoResponse {
    Json(serde_json::json!({
        "name": "Aurora Gallery LAN Share",
        "version": "1.0",
        "endpoints": {
            "auth": "POST /api/auth/verify",
            "browse": "GET /api/browse",
            "all_image_folders": "GET /api/all_image_folders",
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
            server_name: None,
        }));
    }

    let device_id = payload
        .device_id
        .filter(|id| !id.trim().is_empty())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
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
    emit_devices_changed(&state.app_handle);

    log::info!("[LAN Share] 认证成功 - 设备: {} ({}), IP: {}, 设备类型: {}, Token: {}...",
        device_name, device_id, ip, device_type, &session.token[..8]);

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
        log::info!("[LAN Share] 设备登出 - {} ({})", s.device_name, s.device_id);
    }

    Ok(Json(OperationResponse {
        success: true,
        path: None,
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

/// 批量查询颜色库，为 image 类型的 BrowseItem 填充 palette 字段。
/// 路径需用 root_path 拼成绝对路径后再查 colors.db。
async fn fill_image_palette(
    images: &mut [BrowseItem],
    root_path: &std::path::Path,
    color_db_pool: &Option<Arc<crate::color_db::ColorDbPool>>,
) {
    let Some(pool) = color_db_pool else { return };
    let abs_paths: Vec<String> = images.iter()
        .filter(|i| i.item_type == "image")
        .map(|i| root_path.join(&i.path).to_string_lossy().replace('\\', "/"))
        .collect();
    if abs_paths.is_empty() { return; }

    let pool_clone = pool.clone();
    let palette_map = tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone.get_connection();
        crate::color_db::get_colors_by_file_paths(&mut conn, &abs_paths).unwrap_or_default()
    }).await.unwrap_or_default();

    for item in images.iter_mut() {
        if item.item_type == "image" {
            let normalized = root_path.join(&item.path).to_string_lossy().replace('\\', "/");
            if let Some(palette) = palette_map.get(&normalized) {
                item.palette = Some(palette.clone());
            }
        }
    }
}

pub async fn handle_palette(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<PaletteQuery>,
) -> Result<Json<serde_json::Value>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token"))?;
    state.devices.update_activity(&session.device_id).await;

    let pool = match &state.color_db_pool {
        Some(p) => p.clone(),
        None => return Ok(Json(serde_json::json!({ "palette": [] }))),
    };

    let abs_path = state.root_path.join(&query.path).to_string_lossy().replace('\\', "/");
    let palette = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        crate::color_db::get_colors_by_file_paths(&mut conn, &[abs_path])
            .map(|m| m.into_values().next().unwrap_or_default())
            .unwrap_or_default()
    }).await.unwrap_or_default();

    Ok(Json(serde_json::json!({ "palette": palette })))
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

    let (allow_edit, allow_upload) = {
        let config = state.config.read().await;
        (config.allow_edit, config.allow_upload)
    };

    let raw_path = query.path.unwrap_or_default();
    let relative_path = if raw_path == "/" || raw_path.is_empty() {
        "".to_string()
    } else {
        raw_path.trim_start_matches('/').to_string()
    };
    let full_path = state.root_path.join(&relative_path);
    let root_path = state.root_path.clone();

    let __t_start = std::time::Instant::now();
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
        let __t_sb_start = std::time::Instant::now();

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
                        let mut known_file_names: std::collections::HashSet<String> = std::collections::HashSet::new();

                        for entry in children {
                            let relative_item_path = entry.path.strip_prefix(&root_path_str)
                                .unwrap_or(&entry.path)
                                .to_string();

                            if entry.file_type == "Folder" {
                                let (db_preview_paths, db_count) = folder_info.get(&entry.file_id)
                                    .map(|(paths, c)| {
                                        let rel_paths: Vec<String> = paths.iter()
                                            .map(|p| p.strip_prefix(&root_path_str).unwrap_or(p).to_string())
                                            .collect();
                                        (if rel_paths.is_empty() { None } else { Some(rel_paths) }, if *c > 0 { Some(*c) } else { None })
                                    })
                                    .unwrap_or((None, None));

                                // 数据库无直接图片子项时，回退到文件系统递归查找子文件夹内的图片
                                let (preview_paths, count) = if db_preview_paths.is_some() {
                                    (db_preview_paths, db_count)
                                } else {
                                    let folder_full_path = root_path_clone.join(&relative_item_path);
                                    let (fs_preview, fs_count) = get_folder_info_fast(&folder_full_path, root_path_clone.as_path());
                                    let fs_preview_rel: Option<Vec<String>> = fs_preview.map(|paths| {
                                        paths.iter()
                                            .map(|p| p.strip_prefix(&root_path_str).unwrap_or(p).to_string())
                                            .collect()
                                    });
                                    (fs_preview_rel, fs_count.or(db_count))
                                };

                                folders.push(BrowseItem {
                                    name: entry.name,
                                    path: relative_item_path,
                                    item_type: "folder".to_string(),
                                    size: count,
                                    thumbnail: None,
                                    preview_images: preview_paths,
                                    width: None,
                                    height: None,
                                    modified_at: if entry.modified_at > 0 { Some(entry.modified_at) } else { None },
                                    palette: None,
                                });
                            } else if entry.file_type == "Image" {
                                known_file_names.insert(entry.name.clone());
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
                                    modified_at: if entry.modified_at > 0 { Some(entry.modified_at) } else { None },
                                    palette: None,
                                });
                            }
                        }

                        // 视频不在数据库索引中，需要从文件系统补充扫描
                        if let Ok(fs_entries) = std::fs::read_dir(&root_path_clone.join(&normalized_parent_path_clone)) {
                            for fs_entry in fs_entries.flatten() {
                                let fs_name = fs_entry.file_name();
                                let fs_name_str = fs_name.to_string_lossy().to_string();
                                if fs_name_str.starts_with('.') { continue; }
                                let fs_path = fs_entry.path();
                                if fs_path.is_file() && is_video_file(&fs_name_str) && !known_file_names.contains(&fs_name_str) {
                                    let relative_item_path = fs_path.strip_prefix(root_path_clone.as_path())
                                        .unwrap_or(&fs_path)
                                        .to_string_lossy()
                                        .replace('\\', "/");
                                    let size = fs_entry.metadata().ok().map(|m| m.len());
                                    let vid_modified = fs_entry.metadata().ok()
                                        .and_then(|m| m.modified().ok())
                                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                                        .map(|d| d.as_secs() as i64);
                                    images.push(BrowseItem {
                                        name: fs_name_str,
                                        path: relative_item_path,
                                        item_type: "video".to_string(),
                                        size,
                                        thumbnail: None,
                                        preview_images: None,
                                        width: None,
                                    height: None,
                                    modified_at: vid_modified,
                                    palette: None,
                                });
                                }
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
        
        if let Some((folders, mut images)) = result {
            let __t_sb_elapsed = __t_sb_start.elapsed();
            // 跳过 fill_image_palette：palette 仅在元数据面板/图片查看器中使用，
            // 文件夹浏览不需要。跳过可节省 ~38ms 服务端时间 + 减小 JSON payload。
            let __t_elapsed = __t_start.elapsed();
            log::info!("[LAN Share] 浏览成功 (数据库) - 返回 {} 个文件夹, {} 张图片 | 耗时: {}ms (db+fs: {}ms)",
                folders.len(), images.len(), __t_elapsed.as_millis(), __t_sb_elapsed.as_millis());
            return Ok(Json(BrowseResponse {
                current_path: relative_path,
                folders,
                images,
                allow_edit: Some(allow_edit),
                allow_upload: Some(allow_upload),
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
                    } else if is_video_file(&name) {
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

                    let folder_modified = std::fs::metadata(&path).ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64);

                    BrowseItem {
                        name,
                        path: relative_item_path,
                        item_type: "folder".to_string(),
                        size: file_count,
                        thumbnail: None,
                        preview_images,
                        width: None,
                        height: None,
                        modified_at: folder_modified,
                        palette: None,
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
                let is_video = is_video_file(&name);
                let item_type = if is_video { "video" } else { "image" }.to_string();
                // 视频没有缩略图端点，只返回图片的缩略图 URL
                let thumbnail_url = if is_video {
                    None
                } else {
                    Some(format!("/api/thumbnail?path={}", urlencoding::encode(&relative_item_path)))
                };
                BrowseItem {
                    name,
                    path: relative_item_path,
                    item_type,
                    size,
                    thumbnail: thumbnail_url,
                    preview_images: None,
                    width: if is_video { None } else { width },
                    height: if is_video { None } else { height },
                    modified_at: None,
                    palette: None,
                }
            })
            .collect()
    } else {
        Vec::new()
    };

    let mut folders = folders;
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    // 跳过 fill_image_palette（同数据库路径，文件夹浏览不需要颜色数据）

    log::info!("[LAN Share] 浏览成功 (文件系统) - 返回 {} 个文件夹, {} 张图片 | 耗时: {}ms",
        folders.len(), images.len(), __t_start.elapsed().as_millis());

    Ok(Json(BrowseResponse {
        current_path: relative_path,
        folders,
        images,
        allow_edit: Some(allow_edit),
        allow_upload: Some(allow_upload),
    }))
}

fn get_folder_info_fast(
    folder_path: &std::path::Path,
    root_path: &std::path::Path,
) -> (Option<Vec<String>>, Option<u64>) {
    let mut file_count: u64 = 0;

    // 统计直接子项数量（文件夹 + 图片 + 视频）
    if let Ok(entries) = std::fs::read_dir(folder_path) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();

            if name_str.starts_with('.') {
                continue;
            }

            let path = entry.path();
            if path.is_dir() || is_image_file(&name_str) || is_video_file(&name_str) {
                file_count += 1;
            }
        }
    }

    // 使用 find_preview_images 递归到 2 层深度查找封面图片
    let preview_images = find_preview_images(folder_path, root_path, 3);

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
                [
                    (header::CONTENT_TYPE, "image/jpeg"),
                    (header::CACHE_CONTROL, "private, max-age=600"),
                ],
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
        [
            (header::CONTENT_TYPE, content_type.as_str()),
            (header::CACHE_CONTROL, "private, max-age=300"),
        ],
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

pub async fn handle_upload(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<OperationResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] 上传请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;

    {
        let config = state.config.read().await;
        if !config.allow_upload {
            log::warn!("[LAN Share] 上传被拒绝 - 未允许上传, 设备: {}", session.device_name);
            return Err((StatusCode::FORBIDDEN, Json(OperationResponse {
                success: false,
                path: None,
                error: Some("Upload not allowed".to_string()),
            })).into_response());
        }
    }

    state.devices.update_activity(&session.device_id).await;

    let mut file_data: Option<Vec<u8>> = None;
    let mut file_name: Option<String> = None;
    let mut target_dir: String = String::new();

    while let Some(field) = multipart.next_field().await
        .map_err(|e| {
            log::error!("[LAN Share] 解析 multipart 失败: {}", e);
            error_response(StatusCode::BAD_REQUEST, &format!("Multipart error: {}", e))
        })?
    {
        let name = field.name().unwrap_or("").to_string();
        match name.as_str() {
            "file" => {
                let fname = field.file_name().map(|s| s.to_string());
                let data = field.bytes().await.map_err(|e| {
                    log::error!("[LAN Share] 读取上传文件内容失败: {}", e);
                    error_response(StatusCode::BAD_REQUEST, &format!("Read file error: {}", e))
                })?;
                file_data = Some(data.to_vec());
                file_name = fname;
            }
            "target_dir" => {
                let data = field.bytes().await.map_err(|e| {
                    error_response(StatusCode::BAD_REQUEST, &format!("Read target_dir error: {}", e))
                })?;
                target_dir = String::from_utf8_lossy(&data).to_string();
            }
            _ => {}
        }
    }

    let file_data = file_data.ok_or_else(|| {
        log::warn!("[LAN Share] 上传失败 - 未提供文件");
        error_response(StatusCode::BAD_REQUEST, "No file provided")
    })?;

    let file_name = file_name.filter(|n| !n.is_empty()).ok_or_else(|| {
        log::warn!("[LAN Share] 上传失败 - 未提供文件名");
        error_response(StatusCode::BAD_REQUEST, "No file name provided")
    })?;

    if has_traversal(&target_dir) || has_traversal(&file_name) {
        log::warn!("[LAN Share] 上传被拒绝 - 路径越权: target_dir={}, file={}", target_dir, file_name);
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid path"));
    }

    let target_dir = target_dir.trim().trim_start_matches('/').to_string();
    let dest_dir = state.root_path.join(&target_dir);

    if !dest_dir.starts_with(state.root_path.as_path()) {
        log::warn!("[LAN Share] 上传被拒绝 - 目标目录越权: {}", dest_dir.display());
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid target directory"));
    }

    if let Err(e) = fs::create_dir_all(&dest_dir).await {
        log::error!("[LAN Share] 创建目录失败: {}", e);
        return Ok(Json(OperationResponse {
            success: false,
            path: None,
            error: Some(e.to_string()),
        }));
    }

    let dest_file = dest_dir.join(&file_name);
    if !dest_file.starts_with(state.root_path.as_path()) {
        log::warn!("[LAN Share] 上传被拒绝 - 目标文件越权: {}", dest_file.display());
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid file name"));
    }

    match fs::write(&dest_file, &file_data).await {
        Ok(_) => {
            let relative = dest_file.strip_prefix(state.root_path.as_path())
                .unwrap_or(&dest_file)
                .to_string_lossy()
                .replace('\\', "/");
            log::info!("[LAN Share] 上传成功 - 设备: {}, 路径: {}, 大小: {} bytes", session.device_name, relative, file_data.len());
            Ok(Json(OperationResponse {
                success: true,
                path: Some(relative),
                error: None,
            }))
        }
        Err(e) => {
            log::error!("[LAN Share] 写入文件失败: {}", e);
            Ok(Json(OperationResponse {
                success: false,
                path: None,
                error: Some(e.to_string()),
            }))
        }
    }
}

fn has_traversal(s: &str) -> bool {
    s.split(|c| c == '/' || c == '\\').any(|comp| comp == "..")
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

pub async fn handle_heartbeat(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await.ok_or_else(|| {
        log::warn!("[LAN Share] 心跳请求失败 - 无效或过期的 Token");
        error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
    })?;
    state.devices.update_activity(&session.device_id).await;
    Ok(Json(serde_json::json!({ "success": true })))
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

    let (folders, mut images) = if let Some(pool) = state.db_pool.clone() {
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
                                modified_at: if entry.modified_at > 0 { Some(entry.modified_at) } else { None },
                                palette: None,
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
                                modified_at: if entry.modified_at > 0 { Some(entry.modified_at) } else { None },
                                palette: None,
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
                                    modified_at: None,
                                    palette: None,
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
                                    modified_at: None,
                                    palette: None,
                                });
                            }
                        } else if is_video_file(&name) {
                            if (scope == "all" || scope == "file") && name_lower.contains(search_term) {
                                let size = entry.metadata().ok().map(|m| m.len());
                                images.push(BrowseItem {
                                    name,
                                    path: relative_item_path,
                                    item_type: "video".to_string(),
                                    size,
                                    thumbnail: None,
                                    preview_images: None,
                                    width: None,
                                    height: None,
                                    modified_at: None,
                                    palette: None,
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
    fill_image_palette(&mut images, &state.root_path, &state.color_db_pool).await;

    Ok(Json(BrowseResponse {
        current_path: format!("search:{}", search_term),
        folders,
        images,
        allow_edit: None,
        allow_upload: None,
    }))
}

/// 递归扫描根目录下所有直接包含图片或视频的文件夹（扁平列表）。
/// 不包含只有子文件夹的中间目录——与本地相册策略一致。
pub async fn handle_all_image_folders(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<AllImageFoldersResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| {
            log::warn!("[LAN Share] all_image_folders 请求失败 - 无效或过期的 Token");
            error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token")
        })?;

    state.devices.update_activity(&session.device_id).await;

    let (allow_edit, allow_upload) = {
        let config = state.config.read().await;
        (config.allow_edit, config.allow_upload)
    };

    let root_path = state.root_path.clone();
    let root_path_clone = root_path.clone();
    let db_pool = state.db_pool.clone();

    let result = tokio::task::spawn_blocking(move || {
        let root_path_str = root_path_clone.to_string_lossy().to_string();

        // 尝试使用数据库加速
        if let Some(pool) = db_pool {
            let conn = pool.get_connection();

            // 查询所有图片条目
            match crate::db::file_index::get_all_image_files(&conn) {
                Ok(all_images) => {
                    use std::collections::HashMap;
                    // 按 parent_id 分组（同一 parent_id = 同一文件夹的直接图片子项）
                    let mut folder_map: HashMap<String, Vec<&crate::db::file_index::FileIndexEntry>> = HashMap::new();

                    for img in &all_images {
                        if let Some(ref pid) = img.parent_id {
                            folder_map.entry(pid.clone()).or_default().push(img);
                        }
                    }

                    let mut folders: Vec<BrowseItem> = Vec::new();
                    let mut root_images: Vec<BrowseItem> = Vec::new();
                    let root_normalized = crate::db::normalize_path(&root_path_str);
                    let root_parent_id = crate::db::generate_id(&root_normalized);

                    // 收集根目录散落图片
                    for img in &all_images {
                        if img.parent_id.as_deref() == Some(&root_parent_id) {
                            let relative_item_path = img.path.strip_prefix(&root_path_str)
                                .unwrap_or(&img.path)
                                .to_string();
                            let thumbnail_url = format!("/api/thumbnail?path={}", urlencoding::encode(&relative_item_path));
                            root_images.push(BrowseItem {
                                name: img.name.clone(),
                                path: relative_item_path,
                                item_type: "image".to_string(),
                                size: Some(img.size),
                                thumbnail: Some(thumbnail_url),
                                preview_images: None,
                                width: img.width,
                                height: img.height,
                                modified_at: if img.modified_at > 0 { Some(img.modified_at) } else { None },
                                palette: None,
                            });
                        }
                    }
                    root_images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

                    // 为每个含图文件夹构建 BrowseItem
                    for (parent_id, imgs) in &folder_map {
                        if *parent_id == root_parent_id {
                            continue; // 根目录散落图片已单独处理
                        }

                        // 查询文件夹条目获取 path 和 name
                        let folder_entry = crate::db::file_index::get_path_by_id(&conn, parent_id).ok().flatten();
                        let (folder_full_path, folder_name) = if let Some(ref fpath) = folder_entry {
                            let name = std::path::Path::new(fpath)
                                .file_name()
                                .map(|n| n.to_string_lossy().to_string())
                                .unwrap_or_else(|| fpath.clone());
                            (fpath.clone(), name)
                        } else {
                            // 文件夹不在索引中，从第一张图片路径推导
                            if let Some(first_img) = imgs.first() {
                                let p = std::path::Path::new(&first_img.path);
                                let parent = p.parent().unwrap_or(p);
                                let name = parent.file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_else(|| parent.to_string_lossy().to_string());
                                (parent.to_string_lossy().to_string(), name)
                            } else {
                                continue;
                            }
                        };

                        let relative_folder_path = folder_full_path.strip_prefix(&root_path_str)
                            .unwrap_or(&folder_full_path)
                            .to_string();

                        // 按名称排序取前 3 张作为预览
                        let mut sorted_imgs: Vec<&&crate::db::file_index::FileIndexEntry> = imgs.iter().collect();
                        sorted_imgs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

                        let preview_paths: Vec<String> = sorted_imgs.iter().take(3)
                            .map(|e| e.path.strip_prefix(&root_path_str).unwrap_or(&e.path).to_string())
                            .collect();

                        let cover = sorted_imgs.first();
                        let cover_width = cover.and_then(|e| e.width);
                        let cover_height = cover.and_then(|e| e.height);

                        // 取该文件夹下最新图片的修改时间作为排序依据
                        let latest_modified = imgs.iter()
                            .map(|e| e.modified_at)
                            .max()
                            .unwrap_or(0);

                        // 统计视频文件（不在数据库中，需检查文件系统）
                        let mut total_count = imgs.len() as u64;
                        let folder_full_path_buf = std::path::PathBuf::from(&folder_full_path);
                        if let Ok(entries) = std::fs::read_dir(&folder_full_path_buf) {
                            for entry in entries.flatten() {
                                let fname = entry.file_name();
                                let fname_str = fname.to_string_lossy();
                                if is_video_file(&fname_str) {
                                    total_count += 1;
                                }
                            }
                        }

                        folders.push(BrowseItem {
                            name: folder_name,
                            path: relative_folder_path,
                            item_type: "folder".to_string(),
                            size: Some(total_count),
                            thumbnail: None,
                            preview_images: if preview_paths.is_empty() { None } else { Some(preview_paths) },
                            width: cover_width,
                            height: cover_height,
                            modified_at: if latest_modified > 0 { Some(latest_modified) } else { None },
                            palette: None,
                        });
                    }

                    // 补充扫描仅含视频的文件夹（数据库中无图片的 Folder 条目）
                    let image_folder_ids: std::collections::HashSet<&String> = folder_map.keys().collect();
                    if let Ok(all_entries) = crate::db::file_index::get_all_entries(&conn) {
                        for entry in &all_entries {
                            if entry.file_type != "Folder" { continue; }
                            if image_folder_ids.contains(&entry.file_id) { continue; }
                            if entry.file_id == root_parent_id { continue; }

                            // 检查该文件夹是否有直接视频子项
                            let folder_full_path = std::path::PathBuf::from(&entry.path);
                            let mut video_count = 0u64;
                            if let Ok(entries) = std::fs::read_dir(&folder_full_path) {
                                for fe in entries.flatten() {
                                    let fname = fe.file_name();
                                    let fname_str = fname.to_string_lossy();
                                    if is_video_file(&fname_str) {
                                        video_count += 1;
                                    }
                                }
                            }
                            if video_count > 0 {
                                let relative_folder_path = entry.path.strip_prefix(&root_path_str)
                                    .unwrap_or(&entry.path)
                                    .to_string();
                                let folder_name = std::path::Path::new(&entry.path)
                                    .file_name()
                                    .map(|n| n.to_string_lossy().to_string())
                                    .unwrap_or_else(|| entry.name.clone());
                                folders.push(BrowseItem {
                                    name: folder_name,
                                    path: relative_folder_path,
                                    item_type: "folder".to_string(),
                                    size: Some(video_count),
                                    thumbnail: None,
                                    preview_images: None,
                                    width: None,
                                    height: None,
                                    modified_at: if entry.modified_at > 0 { Some(entry.modified_at) } else { None },
                                    palette: None,
                                });
                            }
                        }
                    }

                    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

                    log::info!("[LAN Share] all_image_folders (数据库) - {} 个含图文件夹, {} 张根目录图片", folders.len(), root_images.len());
                    return Some((folders, root_images));
                }
                Err(e) => {
                    log::warn!("[LAN Share] all_image_folders 数据库查询失败，回退到文件系统: {}", e);
                }
            }
        }
        None
    }).await.unwrap_or(None);

    let (folders, mut root_images) = if let Some((f, r)) = result {
        (f, r)
    } else {
        // 文件系统递归扫描回退
        let root_path_clone2 = root_path.clone();
        let (folders, root_images) = tokio::task::spawn_blocking(move || {
            all_image_folders_filesystem(&root_path_clone2)
        }).await.unwrap_or((Vec::new(), Vec::new()));
        (folders, root_images)
    };

    fill_image_palette(&mut root_images, &state.root_path, &state.color_db_pool).await;

    Ok(Json(AllImageFoldersResponse {
        folders,
        root_images,
        allow_edit: Some(allow_edit),
        allow_upload: Some(allow_upload),
    }))
}

/// 文件系统递归扫描：返回所有直接含图片/视频的文件夹（扁平列表）+ 根目录散落图片
fn all_image_folders_filesystem(
    root_path: &std::path::Path,
) -> (Vec<BrowseItem>, Vec<BrowseItem>) {
    let mut folders: Vec<BrowseItem> = Vec::new();
    let mut root_images: Vec<BrowseItem> = Vec::new();
    let root_path_str = root_path.to_string_lossy().to_string();

    fn scan_dir(
        dir: &std::path::Path,
        root_path: &std::path::Path,
        root_path_str: &str,
        folders: &mut Vec<BrowseItem>,
        root_images: &mut Vec<BrowseItem>,
        is_root: bool,
    ) {
        let mut image_entries: Vec<(String, String, Option<u32>, Option<u32>, Option<i64>)> = Vec::new();
        let mut video_count = 0u64;
        let mut subdirs: Vec<std::path::PathBuf> = Vec::new();

        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy().to_string();
                if name_str.starts_with('.') { continue; }

                let path = entry.path();
                let relative_item_path = path.strip_prefix(root_path)
                    .unwrap_or(&path)
                    .to_string_lossy()
                    .replace('\\', "/");

                if path.is_dir() {
                    subdirs.push(path);
                } else if is_image_file(&name_str) {
                    let size = entry.metadata().ok().map(|m| m.len());
                    let img_modified = entry.metadata().ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64);
                    let (w, h) = crate::image_utils::get_image_dimensions(&path.to_string_lossy());
                    image_entries.push((relative_item_path.clone(), name_str.clone(), if w > 0 { Some(w) } else { None }, if h > 0 { Some(h) } else { None }, img_modified));

                    if is_root {
                        let thumbnail_url = format!("/api/thumbnail?path={}", urlencoding::encode(&relative_item_path));
                        root_images.push(BrowseItem {
                            name: name_str,
                            path: relative_item_path,
                            item_type: "image".to_string(),
                            size,
                            thumbnail: Some(thumbnail_url),
                            preview_images: None,
                            width: if w > 0 { Some(w) } else { None },
                            height: if h > 0 { Some(h) } else { None },
                            modified_at: img_modified,
                            palette: None,
                        });
                    }
                } else if is_video_file(&name_str) {
                    video_count += 1;
                }
            }
        }

        // 如果当前文件夹直接包含图片或视频，加入 folders
        if !image_entries.is_empty() || video_count > 0 {
            image_entries.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()));

            let preview_paths: Vec<String> = image_entries.iter().take(3).map(|(p, _, _, _, _)| p.clone()).collect();
            let cover = image_entries.first();
            let cover_width = cover.and_then(|(_, _, w, _, _)| *w);
            let cover_height = cover.and_then(|(_, _, _, h, _)| *h);
            let latest_modified = image_entries.iter()
                .filter_map(|(_, _, _, _, m)| *m)
                .max();

            let total_count = (image_entries.len() as u64) + video_count;

            let folder_name = dir.file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| dir.to_string_lossy().to_string());
            let relative_folder_path = dir.strip_prefix(root_path)
                .unwrap_or(dir)
                .to_string_lossy()
                .replace('\\', "/");

            if !is_root {
                folders.push(BrowseItem {
                    name: folder_name,
                    path: relative_folder_path,
                    item_type: "folder".to_string(),
                    size: Some(total_count),
                    thumbnail: None,
                    preview_images: if preview_paths.is_empty() { None } else { Some(preview_paths) },
                    width: cover_width,
                    height: cover_height,
                    modified_at: latest_modified,
                    palette: None,
                });
            }
        }

        // 递归扫描子目录
        for subdir in subdirs {
            scan_dir(&subdir, root_path, root_path_str, folders, root_images, false);
        }
    }

    scan_dir(root_path, root_path, &root_path_str, &mut folders, &mut root_images, true);
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    root_images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    log::info!("[LAN Share] all_image_folders (文件系统) - {} 个含图文件夹, {} 张根目录图片", folders.len(), root_images.len());
    (folders, root_images)
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

fn is_video_file(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
    matches!(
        ext.as_str(),
        "mp4" | "mov" | "avi" | "mkv" | "webm" | "flv" | "wmv" | "m4v" | "mpg" | "mpeg" | "3gp" | "ts"
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
