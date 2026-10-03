use axum::{
    extract::{
        ConnectInfo, Multipart, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use std::net::SocketAddr;
use std::sync::Arc;
use tauri::{AppHandle, Emitter, Manager};
use tokio::fs;
use tower_http::cors::{Any, CorsLayer};

use super::device_manager::DeviceManager;
use super::metadata::{
    MetadataBatchRequest, MetadataBatchResponse, MetadataItem, MetadataPatchRequest,
    PersonPatchRequest, TopicCreateRequest, TopicIdQuery, TopicMemberRemoveQuery,
    TopicMembersRequest, TopicMembersResponse,
};
use super::session::SessionManager;
use super::types::*;
use crate::db::AppDbPool;

/// 可热更新的共享根路径。桌面端切根（switch_root_database）后原地更新，运行中的
/// LAN 服务器无需重启、已配对会话保持。必须与 AppDbPool 的共享切换同步进行，
/// 否则"索引已指向新库、root 仍指旧根"会让手机端浏览只见文件夹不见图片。
#[derive(Clone)]
pub struct SharedRootPath(Arc<std::sync::RwLock<std::path::PathBuf>>);

impl SharedRootPath {
    pub fn new(path: std::path::PathBuf) -> Self {
        Self(Arc::new(std::sync::RwLock::new(path)))
    }

    /// 当前根路径快照：请求期取一次，处理中途切根不影响本请求。
    pub fn get(&self) -> std::path::PathBuf {
        self.0.read().expect("SharedRootPath 读锁已中毒").clone()
    }

    pub fn set(&self, path: std::path::PathBuf) {
        *self.0.write().expect("SharedRootPath 写锁已中毒") = path;
    }
}

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<tokio::sync::RwLock<LanShareConfig>>,
    pub sessions: Arc<SessionManager>,
    pub devices: Arc<DeviceManager>,
    pub root_path: SharedRootPath,
    pub db_pool: Option<Arc<AppDbPool>>,
    pub color_db_pool: Option<Arc<crate::color_db::ColorDbPool>>,
    pub app_handle: AppHandle,
}

impl AppState {
    /// 本请求使用的共享根路径快照。
    pub fn root(&self) -> std::path::PathBuf {
        self.root_path.get()
    }
}

/// 设备列表发生变化时通知前端刷新。事件本身不携带数据，前端收到后
/// 主动调用 lan_share_get_devices 拉取最新列表（避免事件负载与命令
/// 返回不一致）。
fn emit_devices_changed(app_handle: &AppHandle) {
    if let Err(e) = app_handle.emit("lan-share-devices-changed", ()) {
        log::warn!("[LAN Share] 发送 lan-share-devices-changed 事件失败: {}", e);
    }
}

/// M6a 1.5：互联写操作后通知桌面前端刷新对应数据（照抄 emit_devices_changed
/// 范式：事件不带数据负载，前端收到后按 kind 回拉）。kind ∈ metadata|files|people|topics。
fn emit_data_changed(app_handle: &AppHandle, kind: &str) {
    if let Err(e) = app_handle.emit("lan-share-data-changed", serde_json::json!({ "kind": kind })) {
        log::warn!("[LAN Share] 发送 lan-share-data-changed 事件失败: {}", e);
    }
}

/// 写端点公共前置：Bearer token 校验 + allow_edit 门禁（D32 默认全开，手动收紧后 403）。
async fn require_edit_permission(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<Session, Response> {
    let token = extract_token(headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token"))?;

    {
        let config = state.config.read().await;
        if !config.allow_edit {
            log::warn!("[LAN Share] 写操作被拒绝 - 权限不足, 设备: {}", session.device_name);
            return Err(error_response(StatusCode::FORBIDDEN, "Edit not allowed"));
        }
    }

    state.devices.update_activity(&session.device_id).await;
    Ok(session)
}

/// 元数据/people/topics 端点的 db 池（桌面端 lan_share_start 必注入，缺失属异常配置）。
fn require_db_pool(state: &AppState) -> Result<Arc<AppDbPool>, Response> {
    state.db_pool.clone()
        .ok_or_else(|| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Database not available"))
}

/// 文件操作端点需要的双池（file_operations 原语同时联动 metadata.db 与 colors.db）。
fn require_db_pools(
    state: &AppState,
) -> Result<(Arc<AppDbPool>, Arc<crate::color_db::ColorDbPool>), Response> {
    let app_db = require_db_pool(state)?;
    let color_db = state.color_db_pool.clone()
        .ok_or_else(|| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Color database not available"))?;
    Ok((app_db, color_db))
}

/// 把 LAN 传入的不透明 path 解析到共享根下的绝对路径（与 browse/thumbnail 的
/// root_path.join 语义一致，不解析不规范化客户端串本身）。越出共享根 → 400。
fn resolve_under_root(state: &AppState, path: &str) -> Result<std::path::PathBuf, Response> {
    let root = state.root();
    let full = root.join(path);
    if !full.starts_with(&root) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid path"));
    }
    Ok(full)
}

/// 把新词并入桌面词表（user_data.json 的 customTags 并集后写回）。
/// 与前端 debounce 全量保存存在 last-writer-wins 窗口，M6a 接受该竞态
/// （前端收到 data-changed 后会重读词表）。
async fn merge_tags_into_desktop_vocabulary(
    app_handle: &AppHandle,
    tags: &[String],
) -> Result<(), String> {
    if tags.is_empty() {
        return Ok(());
    }
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        std::fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    let config_path = app_data_dir.join("user_data.json");
    let mut user_data = if config_path.exists() {
        let json_str = tokio::fs::read_to_string(&config_path).await.map_err(|e| e.to_string())?;
        serde_json::from_str::<serde_json::Value>(&json_str).unwrap_or(serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if super::metadata::merge_tags_into_user_data(&mut user_data, tags) {
        let json = serde_json::to_string_pretty(&user_data).map_err(|e| e.to_string())?;
        tokio::fs::write(&config_path, json).await.map_err(|e| e.to_string())?;
        log::info!("[LAN Share] 新标签已并入桌面词表（候选 {} 个）", tags.len());
    }
    Ok(())
}

// ============ M6a 新端点：元数据 ============

/// POST /api/metadata/batch：path → file_id → file_metadata 批量读（单条 IN 查询）。
/// 每个入参 path 恰好一项，查不到给空默认，绝不因个别 path 失败整批报错。
pub async fn handle_metadata_batch(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MetadataBatchRequest>,
) -> Result<Json<MetadataBatchResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token"))?;
    state.devices.update_activity(&session.device_id).await;

    let root = state.root();
    // (客户端不透明 path, Option<file_id>)；越出共享根的 path 按 None 处理（空默认，不泄漏根外元数据）
    let entries: Vec<(String, Option<String>)> = payload.paths.iter().map(|p| {
        let full = root.join(p);
        if full.starts_with(root.as_path()) {
            (p.clone(), Some(crate::db::generate_id(&full.to_string_lossy())))
        } else {
            (p.clone(), None)
        }
    }).collect();

    let empty_item = |p: &str| MetadataItem {
        path: p.to_string(),
        tags: Vec::new(),
        description: String::new(),
        source_url: String::new(),
    };

    let items = if let Some(pool) = state.db_pool.clone() {
        tokio::task::spawn_blocking(move || {
            let conn = pool.get_connection();
            let ids: Vec<String> = entries.iter().filter_map(|(_, id)| id.clone()).collect();
            let map = crate::db::file_metadata::get_metadata_by_ids(&conn, &ids)
                .unwrap_or_default();
            entries.iter()
                .map(|(p, id)| {
                    match id.as_ref().and_then(|fid| map.get(fid)) {
                        Some(m) => super::metadata::metadata_to_item(p, m),
                        None => empty_item(p),
                    }
                })
                .collect::<Vec<_>>()
        }).await.map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
    } else {
        entries.iter().map(|(p, _)| empty_item(p)).collect()
    };

    Ok(Json(MetadataBatchResponse { items }))
}

/// PUT /api/metadata：整行读改写（读旧行 → 只覆盖 patch 字段 → 整行写回），
/// 新词并入桌面词表，发 data-changed{kind:"metadata"}。
pub async fn handle_metadata_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<MetadataPatchRequest>,
) -> Result<Json<MetadataItem>, Response> {
    let session = require_edit_permission(&state, &headers).await?;

    let full = resolve_under_root(&state, &payload.path)?;
    let db_path = crate::db::normalize_path(&full.to_string_lossy());
    let file_id = crate::db::generate_id(&db_path);
    let pool = require_db_pool(&state)?;

    let client_path = payload.path.clone();
    let new_tags = payload.patch.tags.clone();
    let patch = payload.patch;

    let merged = tokio::task::spawn_blocking(move || -> Result<crate::db::file_metadata::FileMetadata, String> {
        let conn = pool.get_connection();
        let existing = crate::db::file_metadata::get_metadata_by_id(&conn, &file_id)
            .map_err(|e| e.to_string())?;
        let row = super::metadata::merge_metadata_patch(existing, &file_id, &db_path, &patch);
        crate::db::file_metadata::upsert_file_metadata(&conn, &row).map_err(|e| e.to_string())?;
        Ok(row)
    }).await
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    if let Some(ref tags) = new_tags {
        if let Err(e) = merge_tags_into_desktop_vocabulary(&state.app_handle, tags).await {
            log::warn!("[LAN Share] 词表并入失败（元数据已写入）: {}", e);
        }
    }

    log::info!("[LAN Share] 元数据更新 - 设备: {}, path: {}", session.device_name, client_path);
    emit_data_changed(&state.app_handle, "metadata");

    Ok(Json(super::metadata::metadata_to_item(&client_path, &merged)))
}

// ============ M6a 新端点：people ============

#[derive(Debug, Serialize)]
pub struct PeopleResponse {
    pub people: Vec<crate::db::persons::Person>,
}

/// GET /api/people：core Person 模型 camelCase 原样序列化。
pub async fn handle_people(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<PeopleResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token"))?;
    state.devices.update_activity(&session.device_id).await;

    let pool = require_db_pool(&state)?;
    let people = tokio::task::spawn_blocking(move || {
        let conn = pool.get_connection();
        crate::db::persons::get_all_people(&conn).unwrap_or_default()
    }).await.unwrap_or_default();

    Ok(Json(PeopleResponse { people }))
}

/// PUT /api/person：重命名/换头像/改描述（整行读改写）。
/// avatar_path 是共享根相对 path，服务端换算 cover_file_id；换头像清空 faceBox。
pub async fn handle_person_put(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<PersonPatchRequest>,
) -> Result<Json<crate::db::persons::Person>, Response> {
    let session = require_edit_permission(&state, &headers).await?;

    let cover_file_id = match &payload.avatar_path {
        Some(p) => {
            let full = resolve_under_root(&state, p)?;
            Some(crate::db::generate_id(&full.to_string_lossy()))
        }
        None => None,
    };

    let pool = require_db_pool(&state)?;
    let person_id = payload.id.clone();
    let name = payload.name.clone();
    let description = payload.description.clone();

    let updated = tokio::task::spawn_blocking(move || -> Result<Option<crate::db::persons::Person>, String> {
        let conn = pool.get_connection();
        let mut person = match crate::db::persons::get_person_by_id(&conn, &person_id)
            .map_err(|e| e.to_string())?
        {
            Some(p) => p,
            None => return Ok(None),
        };
        if let Some(n) = name {
            person.name = n;
        }
        if let Some(d) = description {
            person.description = Some(d);
        }
        if let Some(c) = cover_file_id {
            person.cover_file_id = c;
            // faceBox 坐标属于旧头像，换头像即失效
            person.face_box = None;
        }
        person.updated_at = Some(chrono::Utc::now().timestamp_millis());
        crate::db::persons::upsert_person(&conn, &person).map_err(|e| e.to_string())?;
        Ok(Some(person))
    }).await
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    let person = match updated {
        Some(p) => p,
        None => return Err(error_response(StatusCode::NOT_FOUND, "Person not found")),
    };

    log::info!("[LAN Share] 人物更新 - 设备: {}, id: {}", session.device_name, person.id);
    emit_data_changed(&state.app_handle, "people");

    Ok(Json(person))
}

// ============ M6a 新端点：topics ============

#[derive(Debug, Serialize)]
pub struct TopicsResponse {
    pub topics: Vec<crate::db::topics::Topic>,
}

/// GET /api/topics：core Topic 模型 camelCase 原样序列化（列表 fileIds 恒空，成员懒加载）。
pub async fn handle_topics(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<TopicsResponse>, Response> {
    let token = extract_token(&headers)?;
    let session = state.sessions.validate_token(&token).await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token"))?;
    state.devices.update_activity(&session.device_id).await;

    let pool = require_db_pool(&state)?;
    let topics = tokio::task::spawn_blocking(move || {
        let conn = pool.get_connection();
        crate::db::topics::get_all_topics(&conn).unwrap_or_default()
    }).await.unwrap_or_default();

    Ok(Json(TopicsResponse { topics }))
}

/// 专题 id 形制对齐桌面端：9 位随机串（useTopics.handleCreateTopic 的 id 约定）。
fn generate_topic_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()[..9].to_string()
}

/// POST /api/topic：建专题（id/时间戳由服务端生成）。
pub async fn handle_topic_create(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TopicCreateRequest>,
) -> Result<Json<crate::db::topics::Topic>, Response> {
    let session = require_edit_permission(&state, &headers).await?;

    let pool = require_db_pool(&state)?;
    let now = chrono::Utc::now().timestamp_millis();
    let topic = crate::db::topics::Topic {
        id: generate_topic_id(),
        parent_id: payload.parent_id,
        name: payload.name,
        description: payload.description,
        topic_type: Some("TOPIC".to_string()),
        cover_file_id: None,
        background_file_id: None,
        cover_crop: None,
        people_ids: Vec::new(),
        file_ids: Vec::new(),
        source_url: None,
        created_at: Some(now),
        updated_at: Some(now),
        source_type: None,
        work_name: None,
        work_name_cn: None,
        file_count: 0,
    };

    let topic_clone = topic.clone();
    tokio::task::spawn_blocking(move || {
        let conn = pool.get_connection();
        crate::db::topics::upsert_topic(&conn, &topic_clone)
    }).await
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;

    log::info!("[LAN Share] 专题创建 - 设备: {}, id: {}, name: {}", session.device_name, topic.id, topic.name);
    emit_data_changed(&state.app_handle, "topics");

    Ok(Json(topic))
}

/// DELETE /api/topic?id=：删专题（级联清 topic_files / topic_people）。
pub async fn handle_topic_delete(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TopicIdQuery>,
) -> Result<Json<OperationResponse>, Response> {
    let session = require_edit_permission(&state, &headers).await?;

    let pool = require_db_pool(&state)?;
    let topic_id = query.id.clone();
    let deleted = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let conn = pool.get_connection();
        let exists = crate::db::topics::get_all_topics(&conn)
            .map_err(|e| e.to_string())?
            .iter()
            .any(|t| t.id == topic_id);
        if !exists {
            return Ok(false);
        }
        crate::db::topics::delete_topic(&conn, &topic_id).map_err(|e| e.to_string())?;
        Ok(true)
    }).await
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    if !deleted {
        return Err(error_response(StatusCode::NOT_FOUND, "Topic not found"));
    }

    log::info!("[LAN Share] 专题删除 - 设备: {}, id: {}", session.device_name, query.id);
    emit_data_changed(&state.app_handle, "topics");

    Ok(Json(OperationResponse { success: true, path: None, error: None }))
}

/// POST /api/topic/members：加成员（paths 换算 file_id + people_ids 直传）。
pub async fn handle_topic_members_add(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<TopicMembersRequest>,
) -> Result<Json<TopicMembersResponse>, Response> {
    let session = require_edit_permission(&state, &headers).await?;

    if payload.paths.is_none() && payload.people_ids.is_none() {
        return Err(error_response(StatusCode::BAD_REQUEST, "paths or people_ids required"));
    }

    let root = state.root();
    let file_ids: Vec<String> = payload.paths.unwrap_or_default().iter().filter_map(|p| {
        let full = root.join(p);
        if full.starts_with(root.as_path()) {
            Some(crate::db::generate_id(&full.to_string_lossy()))
        } else {
            None
        }
    }).collect();
    let people_ids = payload.people_ids.unwrap_or_default();

    let pool = require_db_pool(&state)?;
    let topic_id = payload.topic_id.clone();
    let file_count = tokio::task::spawn_blocking(move || -> Result<Option<i32>, String> {
        let conn = pool.get_connection();
        let exists = crate::db::topics::get_all_topics(&conn)
            .map_err(|e| e.to_string())?
            .iter()
            .any(|t| t.id == topic_id);
        if !exists {
            return Ok(None);
        }
        if !file_ids.is_empty() {
            crate::db::topics::add_files_to_topic(&conn, &topic_id, &file_ids).map_err(|e| e.to_string())?;
        }
        if !people_ids.is_empty() {
            crate::db::topics::add_people_to_topic(&conn, &topic_id, &people_ids).map_err(|e| e.to_string())?;
        }
        let count = crate::db::topics::get_all_topics(&conn)
            .map_err(|e| e.to_string())?
            .iter()
            .find(|t| t.id == topic_id)
            .map(|t| t.file_count);
        Ok(count)
    }).await
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    let file_count = match file_count {
        Some(c) => c,
        None => return Err(error_response(StatusCode::NOT_FOUND, "Topic not found")),
    };

    log::info!("[LAN Share] 专题加成员 - 设备: {}, id: {}", session.device_name, payload.topic_id);
    emit_data_changed(&state.app_handle, "topics");

    Ok(Json(TopicMembersResponse { success: true, file_count }))
}

/// DELETE /api/topic/members?topic_id=&path= / ?topic_id=&people_id=：删单成员。
pub async fn handle_topic_members_remove(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(query): Query<TopicMemberRemoveQuery>,
) -> Result<Json<TopicMembersResponse>, Response> {
    let session = require_edit_permission(&state, &headers).await?;

    let file_id = match &query.path {
        Some(p) => {
            let full = resolve_under_root(&state, p)?;
            Some(crate::db::generate_id(&full.to_string_lossy()))
        }
        None => None,
    };
    if file_id.is_none() && query.people_id.is_none() {
        return Err(error_response(StatusCode::BAD_REQUEST, "path or people_id required"));
    }

    let pool = require_db_pool(&state)?;
    let topic_id = query.topic_id.clone();
    let people_id = query.people_id;
    let file_count = tokio::task::spawn_blocking(move || -> Result<Option<i32>, String> {
        let conn = pool.get_connection();
        let exists = crate::db::topics::get_all_topics(&conn)
            .map_err(|e| e.to_string())?
            .iter()
            .any(|t| t.id == topic_id);
        if !exists {
            return Ok(None);
        }
        if let Some(fid) = &file_id {
            crate::db::topics::remove_file_from_topic(&conn, &topic_id, fid).map_err(|e| e.to_string())?;
        }
        if let Some(pid) = &people_id {
            crate::db::topics::remove_person_from_topic(&conn, &topic_id, pid).map_err(|e| e.to_string())?;
        }
        let count = crate::db::topics::get_all_topics(&conn)
            .map_err(|e| e.to_string())?
            .iter()
            .find(|t| t.id == topic_id)
            .map(|t| t.file_count);
        Ok(count)
    }).await
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?;

    let file_count = match file_count {
        Some(c) => c,
        None => return Err(error_response(StatusCode::NOT_FOUND, "Topic not found")),
    };

    log::info!("[LAN Share] 专题删成员 - 设备: {}, id: {}", session.device_name, query.topic_id);
    emit_data_changed(&state.app_handle, "topics");

    Ok(Json(TopicMembersResponse { success: true, file_count }))
}

// ============ M6a 新端点：文件 move / copy ============

/// POST /api/file/move：批量移入 target_dir（新 path = target_dir/原文件名，
/// 目标已存在该项失败，不覆盖不自动改名）。走 file_operations::move_file
/// 原语（file_id / file_metadata / colors 联动迁移）。
pub async fn handle_file_move(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<FileBatchRequest>,
) -> Result<Json<FileBatchResponse>, Response> {
    let session = require_edit_permission(&state, &headers).await?;
    let (app_db, color_db) = require_db_pools(&state)?;

    if has_traversal(&payload.target_dir) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid path"));
    }
    let target_dir = payload.target_dir.trim().trim_start_matches('/').to_string();
    let root = state.root();
    let dest_dir = root.join(&target_dir);
    if !dest_dir.starts_with(root.as_path()) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid target directory"));
    }
    if !dest_dir.is_dir() {
        return Err(error_response(StatusCode::NOT_FOUND, "Target directory not found"));
    }

    let root_str = root.to_string_lossy().to_string();
    let mut items = Vec::new();
    let mut any_success = false;

    for p in &payload.paths {
        let full = root.join(p);
        if !full.exists() || !full.starts_with(root.as_path()) {
            items.push(FileOperationItem {
                path: p.clone(), success: false, new_path: None,
                error: Some("File not found".to_string()),
            });
            continue;
        }
        let name = full.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let dest_full = dest_dir.join(&name);
        if dest_full.exists() {
            items.push(FileOperationItem {
                path: p.clone(), success: false, new_path: None,
                error: Some("Target already exists".to_string()),
            });
            continue;
        }

        match crate::file_operations::move_file_with_pools(
            &full.to_string_lossy(),
            &dest_full.to_string_lossy(),
            &app_db,
            &color_db,
        ).await {
            Ok(_) => {
                any_success = true;
                items.push(FileOperationItem {
                    path: p.clone(),
                    success: true,
                    new_path: Some(to_relative_path(&dest_full.to_string_lossy(), &root_str)),
                    error: None,
                });
            }
            Err(e) => {
                items.push(FileOperationItem {
                    path: p.clone(), success: false, new_path: None, error: Some(e),
                });
            }
        }
    }

    if any_success {
        emit_data_changed(&state.app_handle, "files");
    }
    log::info!("[LAN Share] 批量移动 - 设备: {}, {} 项 -> {}", session.device_name, items.len(), target_dir);
    Ok(Json(FileBatchResponse { items }))
}

/// POST /api/file/copy：批量复制到 target_dir（重名自动 name_copy.ext，
/// new_path 回传实际落盘路径）。文件走 copy_file_fs，库侧数据（元数据/索引/
/// colors）走 copy_file_metadata_with_pools，副本对桌面 browse 立即可见。
pub async fn handle_file_copy(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<FileBatchRequest>,
) -> Result<Json<FileBatchResponse>, Response> {
    let session = require_edit_permission(&state, &headers).await?;
    let (app_db, color_db) = require_db_pools(&state)?;

    if has_traversal(&payload.target_dir) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid path"));
    }
    let target_dir = payload.target_dir.trim().trim_start_matches('/').to_string();
    let root = state.root();
    let dest_dir = root.join(&target_dir);
    if !dest_dir.starts_with(root.as_path()) {
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid target directory"));
    }

    let root_str = root.to_string_lossy().to_string();
    let mut items = Vec::new();
    let mut any_success = false;

    for p in &payload.paths {
        let full = root.join(p);
        if !full.exists() || !full.starts_with(root.as_path()) {
            items.push(FileOperationItem {
                path: p.clone(), success: false, new_path: None,
                error: Some("File not found".to_string()),
            });
            continue;
        }
        let name = full.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        let dest_full = dest_dir.join(&name);

        let src_str = full.to_string_lossy().to_string();
        // copy_file_fs 返回实际落盘的规范化绝对路径（含重名自动改名）
        let final_dest = match crate::file_operations::copy_file_fs(&src_str, &dest_full.to_string_lossy()).await {
            Ok(p) => p,
            Err(e) => {
                items.push(FileOperationItem {
                    path: p.clone(), success: false, new_path: None, error: Some(e),
                });
                continue;
            }
        };

        match crate::file_operations::copy_file_metadata_with_pools(&src_str, &final_dest, &app_db, &color_db).await {
            Ok(_) => {
                any_success = true;
                items.push(FileOperationItem {
                    path: p.clone(),
                    success: true,
                    new_path: Some(to_relative_path(&final_dest, &root_str)),
                    error: None,
                });
            }
            Err(e) => {
                items.push(FileOperationItem {
                    path: p.clone(), success: false, new_path: None, error: Some(e),
                });
            }
        }
    }

    if any_success {
        emit_data_changed(&state.app_handle, "files");
    }
    log::info!("[LAN Share] 批量复制 - 设备: {}, {} 项 -> {}", session.device_name, items.len(), target_dir);
    Ok(Json(FileBatchResponse { items }))
}

/// 双向连接融合：客户端认证时携带了 peer_server 信息，通知前端自动
/// 反向连接对端服务端（前端收到事件后用对应客户端 API 完成配对）。
/// device_name 为对端客户端自报的设备名（如"三星Tab S8+"），
/// 供前端在对端 server_name 为空时作为设备显示名回退。
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
        log::warn!("[LAN Share] 发送 lan-share-peer-pairing 事件失败: {}", e);
    } else {
        // 成功路径也要留痕：前端反向连不上（如 webview CSP 拦 fetch）时 Rust 侧无感知，
        // 只有这条日志能证明事件已发出、断点在前端。
        log::info!(
            "[LAN Share] 双向配对事件已发送：对端 {}:{} 设备 {}（访问码不入日志）",
            host,
            peer.port,
            peer_device_name
        );
    }
}

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    pub path: Option<String>,
    /// 可选排序口径（协议 2026-10 新增）：`name` | `date` | `size`。
    /// 带上时，folder 项的 `preview_images[0]` = 直接子图按该口径排序后的第一张；
    /// 缺省（旧客户端）= 服务端行为与历史版本完全一致。
    pub sort_by: Option<String>,
    /// 可选排序方向：`asc` | `desc`，缺省 `desc`（仅与 sort_by 同时生效）。
    pub sort_dir: Option<String>,
}

/// 把请求参数解析为 file_index 层的排序口径（None = 缺省/非法，维持既有行为）。
fn resolve_preview_sort(sort_by: Option<&str>, sort_dir: Option<&str>) -> Option<crate::db::file_index::FolderPreviewSort> {
    crate::db::file_index::parse_folder_preview_sort(sort_by, sort_dir)
}

/// `GET /api/all_image_folders` 的可选排序参数（与 BrowseQuery 同口径）。
#[derive(Debug, Deserialize)]
pub struct AllImageFoldersQuery {
    /// 可选排序口径：`name` | `date` | `size`。缺省 = 既有行为（DB 路径 preview 按名称升序）。
    pub sort_by: Option<String>,
    /// 可选排序方向：`asc` | `desc`，缺省 `desc`（仅与 sort_by 同时生效）。
    pub sort_dir: Option<String>,
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

    // 双向连接融合：客户端携带了对端服务端信息，通知前端自动反向连接
    if let Some(ref peer) = payload.peer_server {
        let peer_host = addr.ip().to_string();
        emit_peer_pairing(&state.app_handle, &peer_host, peer, &device_name);
        log::info!(
            "[LAN Share] 收到对端服务端信息，请求双向配对 - 对端: {}:{}, 来自: {}",
            peer_host,
            peer.port,
            device_name
        );
    }

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

    let abs_path = state.root().join(&query.path).to_string_lossy().replace('\\', "/");
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
    let full_path = state.root().join(&relative_path);
    let root_path = state.root();

    let __t_start = std::time::Instant::now();
    log::info!("[LAN Share] 浏览请求 - 设备: {}, 路径: {} (原始: {})", session.device_name, relative_path, raw_path);

    if !full_path.exists() || !full_path.starts_with(state.root().as_path()) {
        log::warn!("[LAN Share] 浏览失败 - 路径不存在或越权访问: {}", full_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "Path not found"));
    }

    let normalized_parent_path = crate::db::normalize_path(&full_path.to_string_lossy());
    let preview_sort = resolve_preview_sort(query.sort_by.as_deref(), query.sort_dir.as_deref());

    if let Some(pool) = state.db_pool.clone() {
        let pool_clone = pool.clone();
        let normalized_parent_path_clone = normalized_parent_path.clone();
        let root_path_clone = root_path.clone();
        let __t_sb_start = std::time::Instant::now();

        let result = tokio::task::spawn_blocking(move || {
            let conn = pool_clone.get_connection();

            match crate::db::file_index::get_children_by_parent_path(&conn, &normalized_parent_path_clone) {
                Ok(children) => {
                    // 切根防线（0.1 失配修复）：DB 条目必须落在当前共享根下。
                    // 共享根切换后旧索引未失效时，查到的条目带旧根的绝对路径——
                    // 此时弃用 DB 结果、走 FS 回退（与 all_image_folders 的回退
                    // 行为对齐），不允许 browse 吐旧索引。
                    let root_norm = crate::db::normalize_path(&root_path_clone.to_string_lossy())
                        .replace('\\', "/")
                        .to_lowercase();
                    let root_prefix = format!("{}/", root_norm);
                    let stale_index = children.iter().any(|e| {
                        let p = e.path.replace('\\', "/").to_lowercase();
                        p != root_norm && !p.starts_with(&root_prefix)
                    });
                    if stale_index {
                        log::warn!(
                            "[LAN Share] 索引根目录与当前共享根不一致（共享根疑似已切换），弃用 DB 结果回退文件系统: {}",
                            root_path_clone.display()
                        );
                        return None;
                    }

                    if !children.is_empty() {
                        let folder_ids: Vec<String> = children.iter()
                            .filter(|e| e.file_type == "Folder")
                            .map(|e| e.file_id.clone())
                            .collect();

                        let folder_info = crate::db::file_index::get_folder_info_batch(&conn, &folder_ids, preview_sort)
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
                                let (db_preview_paths, db_count, db_latest_created) = folder_info.get(&entry.file_id)
                                    .map(|(paths, c, latest)| {
                                        let rel_paths: Vec<String> = paths.iter()
                                            .map(|p| p.strip_prefix(&root_path_str).unwrap_or(p).to_string())
                                            .collect();
                                        (if rel_paths.is_empty() { None } else { Some(rel_paths) }, if *c > 0 { Some(*c) } else { None }, *latest)
                                    })
                                    .unwrap_or((None, None, 0));

                                // 数据库无直接图片子项时，回退到文件系统递归查找子文件夹内的图片
                                let (preview_paths, count) = if db_preview_paths.is_some() {
                                    (db_preview_paths, db_count)
                                } else {
                                    let folder_full_path = root_path_clone.join(&relative_item_path);
                                    // DB 判定无直接子图 → latest_created_at 走无日期兜底（协议：无直接子图 = 0/缺省），
                                    // FS 回退的 created 元数据（_fs_latest）不采信，避免递归子图混入"直接子图"口径
                                    let (fs_preview, fs_count, _fs_latest) =
                                        get_folder_info_fast_sorted(&folder_full_path, root_path_clone.as_path(), preview_sort);
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
                                    // 直接子图最新创建时间（DB 无直接子图时无此数据，走无日期兜底）
                                    created_at: None,
                                    latest_created_at: if db_latest_created > 0 { Some(db_latest_created) } else { None },
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
                                    created_at: if entry.created_at > 0 { Some(entry.created_at) } else { None },
                                    latest_created_at: None,
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
                                    // 视频不在索引中，无创建时间口径
                                    created_at: None,
                                    latest_created_at: None,
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
        
        if let Some((folders, images)) = result {
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
                    let (preview_images, file_count, latest_created) =
                        get_folder_info_fast_sorted(&path, root_path_clone.as_path(), preview_sort);

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
                        // 纯 FS 回退：直接子图 created_at 从 fs 元数据尽力而为
                        // （平台不支持 created() 时为 None = 无日期兜底）
                        created_at: None,
                        latest_created_at: latest_created,
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
                    // 纯 FS 回退：无索引 created_at（协议：0/缺省 = 无日期）
                    created_at: None,
                    latest_created_at: None,
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

/// 带排序口径的 FS 回退版 [get_folder_info_fast]（LAN browse 的 sort_by/sort_dir）。
///
/// - `sort = None`：与既有行为完全一致（递归 find_preview_images，无显式排序），
///   latest_created_at 恒 None（无日期兜底，避免为旧客户端多付一轮元数据 IO）。
/// - `sort = Some`：读目录收集**直接子图**的 name/size/created 元数据，内存排序后
///   取前 3 张作 preview（preview_images[0] = 排序后的第一张，协议口径）；直接子图
///   不足 3 张时再用既有递归逻辑补齐（补位图不参与排序，仅作堆叠候选）。
///   latest_created_at = 直接子图 fs created() 的 MAX（平台不支持时缺省）。
fn get_folder_info_fast_sorted(
    folder_path: &std::path::Path,
    root_path: &std::path::Path,
    sort: Option<crate::db::file_index::FolderPreviewSort>,
) -> (Option<Vec<String>>, Option<u64>, Option<i64>) {
    let Some(sort) = sort else {
        let (preview, count) = get_folder_info_fast(folder_path, root_path);
        return (preview, count, None);
    };

    let mut file_count: u64 = 0;
    // (相对路径, 名称, 字节大小, created 秒)
    let mut direct_images: Vec<(String, String, u64, Option<i64>)> = Vec::new();

    if let Ok(entries) = std::fs::read_dir(folder_path) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy().to_string();
            if name_str.starts_with('.') {
                continue;
            }
            let path = entry.path();
            if path.is_dir() || is_video_file(&name_str) {
                file_count += 1;
            } else if is_image_file(&name_str) {
                let meta = entry.metadata().ok();
                let created = meta.as_ref()
                    .and_then(|m| m.created().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64);
                direct_images.push((
                    path.strip_prefix(root_path)
                        .unwrap_or(&path)
                        .to_string_lossy()
                        .replace('\\', "/"),
                    name_str,
                    meta.as_ref().map(|m| m.len()).unwrap_or(0),
                    created,
                ));
                file_count += 1;
            }
        }
    }

    // 内存排序（与 DB 路径同口径：name 不区分大小写、date=created、size=字节）
    match (sort.sort_by, sort.sort_dir) {
        ("name", "asc") => direct_images.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase())),
        ("name", "desc") => direct_images.sort_by(|a, b| b.1.to_lowercase().cmp(&a.1.to_lowercase())),
        ("date", "asc") => direct_images.sort_by_key(|i| i.3.unwrap_or(0)),
        ("date", "desc") => direct_images.sort_by_key(|i| std::cmp::Reverse(i.3.unwrap_or(0))),
        ("size", "asc") => direct_images.sort_by_key(|i| i.2),
        ("size", "desc") => direct_images.sort_by_key(|i| std::cmp::Reverse(i.2)),
        _ => {}
    }

    let mut preview_images: Vec<String> = direct_images.iter().take(3).map(|(p, _, _, _)| p.clone()).collect();
    if preview_images.len() < 3 {
        // 直接子图不足：既有递归逻辑补齐剩余候选（补位图追加在排序结果之后）
        for p in find_preview_images(folder_path, root_path, 3) {
            if preview_images.len() >= 3 { break; }
            if !preview_images.contains(&p) {
                preview_images.push(p);
            }
        }
    }

    let latest_created = direct_images.iter()
        .filter_map(|(_, _, _, c)| *c)
        .max();

    let preview_images = if preview_images.is_empty() { None } else { Some(preview_images) };
    let file_count = if file_count > 0 { Some(file_count) } else { None };

    (preview_images, file_count, latest_created)
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

    let full_path = state.root().join(&query.path);
    
    log::debug!("[LAN Share] 缩略图请求 - 设备: {}, 路径: {}", session.device_name, query.path);

    if !full_path.exists() || !full_path.starts_with(state.root().as_path()) {
        log::warn!("[LAN Share] 缩略图失败 - 图片不存在: {}", full_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "Image not found"));
    }

    let cache_root = state.root().join(".Aurora_Cache");
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

    let full_path = state.root().join(&query.path);
    
    log::info!("[LAN Share] 图片请求 - 设备: {}, 路径: {}", session.device_name, query.path);

    if !full_path.exists() || !full_path.starts_with(state.root().as_path()) {
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
    
    {
        let config = state.config.read().await;
        if !config.allow_edit {
            log::warn!("[LAN Share] 删除被拒绝 - 权限不足, 设备: {}", session.device_name);
            return Err(error_response(StatusCode::FORBIDDEN, "Edit not allowed"));
        }
    }

    state.devices.update_activity(&session.device_id).await;

    let full_path = state.root().join(&query.path);
    
    log::info!("[LAN Share] 删除请求 - 设备: {}, 路径: {}", session.device_name, query.path);

    if !full_path.exists() || !full_path.starts_with(state.root().as_path()) {
        log::warn!("[LAN Share] 删除失败 - 文件不存在: {}", full_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "File not found"));
    }

    // M6a 1.4：从裸 fs::remove_file 改道 file_operations（同步清理
    // file_index / file_metadata / colors，与桌面本地删除的库状态一致）
    let (app_db, color_db) = require_db_pools(&state)?;
    match crate::file_operations::delete_file_with_pools(&full_path.to_string_lossy(), &app_db, &color_db).await {
        Ok(_) => {
            log::info!("[LAN Share] 删除成功 - 路径: {}", query.path);
            emit_data_changed(&state.app_handle, "files");
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
                error: Some(e),
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
    
    {
        let config = state.config.read().await;
        if !config.allow_edit {
            log::warn!("[LAN Share] 重命名被拒绝 - 权限不足, 设备: {}", session.device_name);
            return Err(error_response(StatusCode::FORBIDDEN, "Edit not allowed"));
        }
    }

    state.devices.update_activity(&session.device_id).await;

    let old_path = state.root().join(&payload.old_path);
    let parent = old_path.parent().ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Invalid path"))?;
    let new_path = parent.join(&payload.new_name);
    
    log::info!("[LAN Share] 重命名请求 - 设备: {}, {} -> {}", 
        session.device_name, payload.old_path, payload.new_name);
    
    if !old_path.exists() || !old_path.starts_with(state.root().as_path()) {
        log::warn!("[LAN Share] 重命名失败 - 源文件不存在: {}", old_path.display());
        return Err(error_response(StatusCode::NOT_FOUND, "File not found"));
    }

    if new_path.exists() {
        log::warn!("[LAN Share] 重命名失败 - 目标文件已存在: {}", new_path.display());
        return Err(error_response(StatusCode::CONFLICT, "File already exists"));
    }

    // M6a 1.4：从裸 fs::rename 改道 file_operations（file_id 迁移 + 
    // file_index/file_metadata/colors 联动，元数据挂到新 id 上）
    let (app_db, color_db) = require_db_pools(&state)?;
    match crate::file_operations::rename_file_with_pools(
        &old_path.to_string_lossy(),
        &new_path.to_string_lossy(),
        &app_db,
        &color_db,
    ).await {
        Ok(_) => {
            let new_relative = new_path.strip_prefix(state.root().as_path())
                .unwrap_or(&new_path)
                .to_string_lossy()
                .replace('\\', "/");
            log::info!("[LAN Share] 重命名成功 - 新路径: {}", new_relative);
            emit_data_changed(&state.app_handle, "files");
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
                error: Some(e),
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
    let dest_dir = state.root().join(&target_dir);

    if !dest_dir.starts_with(state.root().as_path()) {
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
    if !dest_file.starts_with(state.root().as_path()) {
        log::warn!("[LAN Share] 上传被拒绝 - 目标文件越权: {}", dest_file.display());
        return Err(error_response(StatusCode::BAD_REQUEST, "Invalid file name"));
    }

    // M6a 1.4：写文件改走 write_file_bytes_indexed（file_operations 的单文件
    // 增量入索路径），上传的新图片立即进 file_index——桌面 browse（DB 路径
    // 优先）无需重扫即可见
    let app_db = require_db_pool(&state)?;
    match crate::file_operations::write_file_bytes_indexed(&dest_file.to_string_lossy(), &file_data, &app_db).await {
        Ok(_) => {
            let relative = dest_file.strip_prefix(state.root().as_path())
                .unwrap_or(&dest_file)
                .to_string_lossy()
                .replace('\\', "/");
            log::info!("[LAN Share] 上传成功 - 设备: {}, 路径: {}, 大小: {} bytes", session.device_name, relative, file_data.len());
            emit_data_changed(&state.app_handle, "files");
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
                error: Some(e),
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
        let root_path = state.root();
        
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
                                created_at: None,
                                latest_created_at: None,
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
                                created_at: if entry.created_at > 0 { Some(entry.created_at) } else { None },
                                latest_created_at: None,
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
        let root_path = state.root();
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
                                    created_at: None,
                                    latest_created_at: None,
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
                                    created_at: None,
                                    latest_created_at: None,
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
                                    created_at: None,
                                    latest_created_at: None,
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
    let palette_root = state.root();
    fill_image_palette(&mut images, &palette_root, &state.color_db_pool).await;

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
    Query(query): Query<AllImageFoldersQuery>,
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

    let root_path = state.root();
    let root_path_clone = root_path.clone();
    let db_pool = state.db_pool.clone();
    let preview_sort = resolve_preview_sort(query.sort_by.as_deref(), query.sort_dir.as_deref());

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
                            let relative_item_path = to_relative_path(&img.path, &root_path_str);
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
                                created_at: if img.created_at > 0 { Some(img.created_at) } else { None },
                                latest_created_at: None,
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

                        let relative_folder_path = to_relative_path(&folder_full_path, &root_path_str);

                        // 预览排序：缺省 = 既有行为（名称不区分大小写升序）；
                        // 带 sort_by/sort_dir 时 = 协议口径（preview_images[0] = 直接子图按该口径排序的第一张）
                        let mut sorted_imgs: Vec<&&crate::db::file_index::FileIndexEntry> = imgs.iter().collect();
                        match preview_sort {
                            Some(s) => match (s.sort_by, s.sort_dir) {
                                ("name", "asc") => sorted_imgs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
                                ("name", "desc") => sorted_imgs.sort_by(|a, b| b.name.to_lowercase().cmp(&a.name.to_lowercase())),
                                ("date", "asc") => sorted_imgs.sort_by_key(|e| e.created_at),
                                ("date", "desc") => sorted_imgs.sort_by_key(|e| std::cmp::Reverse(e.created_at)),
                                ("size", "asc") => sorted_imgs.sort_by_key(|e| e.size),
                                ("size", "desc") => sorted_imgs.sort_by_key(|e| std::cmp::Reverse(e.size)),
                                _ => sorted_imgs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
                            },
                            None => sorted_imgs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
                        }

                        let preview_paths: Vec<String> = sorted_imgs.iter().take(3)
                            .map(|e| to_relative_path(&e.path, &root_path_str))
                            .collect();

                        let cover = sorted_imgs.first();
                        let cover_width = cover.and_then(|e| e.width);
                        let cover_height = cover.and_then(|e| e.height);

                        // 取该文件夹下最新图片的修改时间作为排序依据
                        let latest_modified = imgs.iter()
                            .map(|e| e.modified_at)
                            .max()
                            .unwrap_or(0);

                        // 直接子图最新创建时间（协议 latest_created_at，folder_map 按直接子图分组）
                        let latest_created = imgs.iter()
                            .map(|e| e.created_at)
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
                            created_at: None,
                            latest_created_at: if latest_created > 0 { Some(latest_created) } else { None },
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
                                let relative_folder_path = to_relative_path(&entry.path, &root_path_str);
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
                                    created_at: None,
                                    latest_created_at: None,
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
            all_image_folders_filesystem(&root_path_clone2, preview_sort)
        }).await.unwrap_or((Vec::new(), Vec::new()));
        (folders, root_images)
    };

    let palette_root = state.root();
    fill_image_palette(&mut root_images, &palette_root, &state.color_db_pool).await;

    Ok(Json(AllImageFoldersResponse {
        folders,
        root_images,
        allow_edit: Some(allow_edit),
        allow_upload: Some(allow_upload),
    }))
}

/// 文件系统递归扫描：返回所有直接含图片/视频的文件夹（扁平列表）+ 根目录散落图片
/// 把绝对路径转为相对共享根目录的路径，分隔符统一为 '/'。
/// 数据库中存储的路径分隔符/大小写可能与 root_path 的原生格式不一致，
/// 直接 str::strip_prefix 会失败，导致带盘符的绝对路径泄漏给客户端
/// （表现为安卓端网络栏出现 "E:/..." 这类目录名）。
fn to_relative_path(path: &str, root_path_str: &str) -> String {
    let norm = path.replace('\\', "/");
    let root_trimmed = root_path_str.replace('\\', "/");
    let root_trimmed = root_trimmed.trim_end_matches('/');
    if root_trimmed.is_empty() {
        return norm;
    }
    let with_slash = format!("{}/", root_trimmed);
    if norm.starts_with(&with_slash) {
        norm[with_slash.len()..].to_string()
    } else if norm == root_trimmed {
        String::new()
    } else {
        norm
    }
}

fn all_image_folders_filesystem(
    root_path: &std::path::Path,
    sort: Option<crate::db::file_index::FolderPreviewSort>,
) -> (Vec<BrowseItem>, Vec<BrowseItem>) {
    let mut folders: Vec<BrowseItem> = Vec::new();
    let mut root_images: Vec<BrowseItem> = Vec::new();
    let root_path_str = root_path.to_string_lossy().to_string();

    /// scan_dir 的直接子图行（fs 元数据一次取齐：尺寸/修改/大小/创建）。
    struct FsImage {
        rel_path: String,
        name: String,
        width: Option<u32>,
        height: Option<u32>,
        modified: Option<i64>,
        size: Option<u64>,
        /// fs created() 尽力而为（平台不支持时 None = 无日期兜底）
        created: Option<i64>,
    }

    fn scan_dir(
        dir: &std::path::Path,
        root_path: &std::path::Path,
        root_path_str: &str,
        folders: &mut Vec<BrowseItem>,
        root_images: &mut Vec<BrowseItem>,
        is_root: bool,
        sort: Option<crate::db::file_index::FolderPreviewSort>,
    ) {
        let mut image_entries: Vec<FsImage> = Vec::new();
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
                    let meta = entry.metadata().ok();
                    let size = meta.as_ref().map(|m| m.len());
                    let img_modified = meta.as_ref()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64);
                    let img_created = meta.as_ref()
                        .and_then(|m| m.created().ok())
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs() as i64);
                    let (w, h) = crate::image_utils::get_image_dimensions(&path.to_string_lossy());
                    image_entries.push(FsImage {
                        rel_path: relative_item_path.clone(),
                        name: name_str.clone(),
                        width: if w > 0 { Some(w) } else { None },
                        height: if h > 0 { Some(h) } else { None },
                        modified: img_modified,
                        size,
                        created: img_created,
                    });

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
                            created_at: img_created,
                            latest_created_at: None,
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
            // 预览排序：缺省 = 既有行为（名称不区分大小写升序）；带 sort 参数 = 协议口径
            match sort {
                Some(s) => match (s.sort_by, s.sort_dir) {
                    ("name", "asc") => image_entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
                    ("name", "desc") => image_entries.sort_by(|a, b| b.name.to_lowercase().cmp(&a.name.to_lowercase())),
                    ("date", "asc") => image_entries.sort_by_key(|i| i.created.unwrap_or(0)),
                    ("date", "desc") => image_entries.sort_by_key(|i| std::cmp::Reverse(i.created.unwrap_or(0))),
                    ("size", "asc") => image_entries.sort_by_key(|i| i.size.unwrap_or(0)),
                    ("size", "desc") => image_entries.sort_by_key(|i| std::cmp::Reverse(i.size.unwrap_or(0))),
                    _ => image_entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
                },
                None => image_entries.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase())),
            }

            let preview_paths: Vec<String> = image_entries.iter().take(3).map(|i| i.rel_path.clone()).collect();
            let cover = image_entries.first();
            let cover_width = cover.and_then(|i| i.width);
            let cover_height = cover.and_then(|i| i.height);
            let latest_modified = image_entries.iter()
                .filter_map(|i| i.modified)
                .max();
            // 直接子图最新创建时间（fs created() 尽力而为）
            let latest_created = image_entries.iter()
                .filter_map(|i| i.created)
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
                    created_at: None,
                    latest_created_at: latest_created,
                    palette: None,
                });
            }
        }

        // 递归扫描子目录
        for subdir in subdirs {
            scan_dir(&subdir, root_path, root_path_str, folders, root_images, false, sort);
        }
    }

    scan_dir(root_path, root_path, &root_path_str, &mut folders, &mut root_images, true, sort);
    folders.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    root_images.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));

    log::info!("[LAN Share] all_image_folders (文件系统) - {} 个含图文件夹, {} 张根目录图片", folders.len(), root_images.len());
    (folders, root_images)
}

pub(crate) fn extract_token(headers: &HeaderMap) -> Result<String, Response> {
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

pub(crate) fn error_response(status: StatusCode, message: &str) -> Response {
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
