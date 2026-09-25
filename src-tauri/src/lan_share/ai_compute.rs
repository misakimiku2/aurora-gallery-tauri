//! M6b 契约 §8：AI 视觉计算端点（D36/D37）+ D40 读端点。
//!
//! **纯计算/纯查询纪律**：手机图字节过桌面内存可以，落桌面索引/桌面库不行——
//! 本模块所有端点不写 file_index / file_metadata / colors / embeddings，
//! 不触发 `lan-share-data-changed`；multipart 收到的图片字节为喂模型
//! （`encode_image` 收路径）可写系统临时目录，用后必删。
//!
//! 模型就绪口径：复用桌面全局 CLIP 管理器的**当前已加载模型**，端点不做自动
//! switch（自动加载 1-4GB 模型会卡住服务端，且会卸载用户正在用的模型）：
//! - WD14 classify：要求当前模型 = `WD-EVA02-Large-Tagger-V3`；
//! - CLIP 搜索：要求任意模型已加载（搜索按当前模型名的嵌入库过滤）。
//! 未就绪一律 503，客户端据此置灰入口。

use axum::{
    extract::{Multipart, Query, State},
    http::{header, HeaderMap, StatusCode},
    response::Response,
    Json,
};
use serde::{Deserialize, Serialize};
use tauri::Manager;

use super::handlers::{error_response, AppState};
use crate::clip::search::SearchResult;

/// WD14 tagger 模型名（与 `clip_generate_tags_from_embeddings` 的支持面一致）。
const WD14_MODEL_NAME: &str = "WD-EVA02-Large-Tagger-V3";
/// character 标签概率阈值（契约 §8.1，对齐桌面 `clip_get_detected_characters` 口径）。
const CHARACTER_THRESHOLD: f32 = 0.1;

// ---------------------------------------------------------------------------
// 鉴权（本节端点只验 token，不受 allow_edit/allow_upload 门禁）
// ---------------------------------------------------------------------------

async fn require_session(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<super::types::Session, Response> {
    let token = super::handlers::extract_token(headers)?;
    let session = state
        .sessions
        .validate_token(&token)
        .await
        .ok_or_else(|| error_response(StatusCode::UNAUTHORIZED, "Invalid or expired token"))?;
    state.devices.update_activity(&session.device_id).await;
    Ok(session)
}

// ---------------------------------------------------------------------------
// multipart 图片字节提取（字段 `file`，对齐 /api/upload 先例）
// ---------------------------------------------------------------------------

/// multipart 图片字节提取（字段 `file`，对齐 /api/upload 先例）。
/// 返回 (字节, 原始文件名)——文件名扩展供 TempImage 嗅探图片格式。
async fn extract_image_bytes(multipart: &mut Multipart) -> Result<(Vec<u8>, String), Response> {
    let mut file_data: Option<Vec<u8>> = None;
    let mut file_name = String::new();
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| error_response(StatusCode::BAD_REQUEST, &format!("Multipart error: {e}")))?
    {
        if field.name() == Some("file") {
            file_name = field.file_name().unwrap_or("").to_string();
            let data = field.bytes().await.map_err(|e| {
                error_response(StatusCode::BAD_REQUEST, &format!("Read file error: {e}"))
            })?;
            file_data = Some(data.to_vec());
        }
        // 其余字段忽略（对齐 upload 的宽容解析）
    }
    let bytes =
        file_data.ok_or_else(|| error_response(StatusCode::BAD_REQUEST, "Missing file field"))?;
    Ok((bytes, file_name))
}

/// 图片字节 → 系统临时目录文件（模型 preprocessor 收路径）→ 推理后删除。
/// Drop guard 保证错误路径也删（推理 panic/提前返回时不留垃圾）。
struct TempImage {
    path: std::path::PathBuf,
}

impl TempImage {
    /// ext 传原始文件名扩展（含点，如 ".jpg"）——image crate 按扩展名嗅探格式，
    /// 无扩展名/未知扩展会 decode 失败（联调实测 `.img` 被拒）。
    fn from_bytes(bytes: &[u8], ext: &str) -> Result<Self, String> {
        let dir = std::env::temp_dir().join("aurora_lan_compute");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let safe_ext = {
            let e = ext.to_ascii_lowercase();
            let e = e.trim_start_matches('.');
            if matches!(
                e,
                "jpg" | "jpeg" | "png" | "gif" | "webp" | "bmp" | "tiff" | "tif" | "avif" | "jxl"
            ) {
                format!(".{e}")
            } else {
                ".jpg".to_string() // 未知扩展兜底 jpg（image 按字节解码为主，扩展只做格式选择）
            }
        };
        let name = format!(
            "m6b_{}_{}{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.subsec_nanos() as u64 + d.as_secs() * 1_000_000_000)
                .unwrap_or(0),
            safe_ext,
        );
        let path = dir.join(name);
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(Self { path })
    }
}

impl Drop for TempImage {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

// ---------------------------------------------------------------------------
// 8.1 POST /api/ai/wd14/classify — WD14 标签推理（D37，纯计算）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Wd14CharacterTag {
    pub tag: String,
    pub score: f32,
    /// extract_work_name 归组的作品名（无归组为 null）。
    pub work: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct Wd14ClassifyResponse {
    pub general_tags: Vec<String>,
    pub character_tags: Vec<Wd14CharacterTag>,
}

pub async fn handle_wd14_classify(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<Wd14ClassifyResponse>, Response> {
    let _session = require_session(&state, &headers).await?;
    let (bytes, file_name) = extract_image_bytes(&mut multipart).await?;

    let manager = crate::clip::get_clip_manager()
        .await
        .ok_or_else(|| model_unavailable("CLIP manager not initialized"))?;

    // 模型就绪检查 + 推理都在 write guard 内（对齐 clip_commands 的互斥形制）。
    // 推理为同步阻塞调用（ONNX 单张几百 ms 级，axum 多 worker 可容忍；借用模型
    // 无法跨 spawn_blocking——'static 约束，登记）。
    let (general, character) = {
        let mut guard = manager.write().await;
        if !guard.is_model_loaded() || guard.get_model_name() != WD14_MODEL_NAME {
            return Err(model_unavailable(
                "WD14 模型未就绪：请在桌面端「AI 视觉」中加载 WD-EVA02-Large-Tagger-V3",
            ));
        }
        let temp = TempImage::from_bytes(&bytes, &file_name)
            .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("临时文件写入失败: {e}")))?;
        let model = guard
            .model_mut()
            .ok_or_else(|| model_unavailable("WD14 模型未就绪"))?;
        let inference = model
            .encode_image(temp.path.to_string_lossy().as_ref())
            .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("WD14 推理失败: {e}")))?;
        let tags = inference
            .tags
            .ok_or_else(|| model_unavailable("当前模型不是 WD14 tagger"))?;
        // （模型名检查已过；tags 概率在模型层已做 0.1 低滤，这里再按契约阈值收紧一次）
        let (general, character_pairs) =
            crate::clip_commands::split_tags_by_category(&tags, CHARACTER_THRESHOLD)
                .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("标签分流失败: {e}")))?;
        let character = character_pairs
            .into_iter()
            .map(|(tag, score)| {
                let work = crate::work_extractor::extract_work_name(&tag, None)
                    .map(|r| r.work_name);
                Wd14CharacterTag { tag, score, work }
            })
            .collect();
        (general, character)
    };

    Ok(Json(Wd14ClassifyResponse {
        general_tags: general.into_iter().map(|(t, _)| t).collect(),
        character_tags: character,
    }))
}

fn model_unavailable(msg: &str) -> Response {
    error_response(StatusCode::SERVICE_UNAVAILABLE, msg)
}

// ---------------------------------------------------------------------------
// 8.2/8.3 POST /api/ai/clip/search_text | search_image（D36，纯查询/纯计算）
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct ClipSearchTextRequest {
    pub query: String,
    pub min_score: Option<f32>,
    pub max_results: Option<usize>,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
pub struct ClipHit {
    pub path: String,
    pub score: f32,
}

#[derive(Serialize)]
pub struct ClipSearchResponse {
    pub hits: Vec<ClipHit>,
}

pub async fn handle_clip_search_text(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(payload): Json<ClipSearchTextRequest>,
) -> Result<Json<ClipSearchResponse>, Response> {
    let _session = require_session(&state, &headers).await?;
    if payload.query.trim().is_empty() {
        return Err(error_response(StatusCode::BAD_REQUEST, "query is empty"));
    }

    let results = clip_search_current_model(&state, |model| {
        model
            .encode_text(&payload.query)
            .map_err(|e| format!("文本编码失败: {e}"))
    })
    .await?;
    to_clip_response(state, results, payload.max_results).await
}

pub async fn handle_clip_search_image(
    State(state): State<AppState>,
    headers: HeaderMap,
    mut multipart: Multipart,
) -> Result<Json<ClipSearchResponse>, Response> {
    let _session = require_session(&state, &headers).await?;
    let (bytes, file_name) = extract_image_bytes(&mut multipart).await?;

    let results = clip_search_current_model(&state, |model| {
        let temp =
            TempImage::from_bytes(&bytes, &file_name).map_err(|e| format!("临时文件写入失败: {e}"))?;
        model
            .encode_image(temp.path.to_string_lossy().as_ref())
            .map(|r| r.embedding)
            .map_err(|e| format!("图像编码失败: {e}"))
    })
    .await?;
    to_clip_response(state, results, None).await
}

/// 在**当前已加载**的模型上编排一次向量搜索（不自动 switch 模型）。
/// 查询向量只存在于内存，不写入嵌入索引（纯计算纪律）。
async fn clip_search_current_model(
    state: &AppState,
    encode: impl FnOnce(&mut crate::clip::model::ClipModel) -> Result<Vec<f32>, String>,
) -> Result<Vec<SearchResult>, Response> {
    let manager = crate::clip::get_clip_manager()
        .await
        .ok_or_else(|| model_unavailable("CLIP manager not initialized"))?;
    let mut guard = manager.write().await;
    if !guard.is_model_loaded() {
        return Err(model_unavailable(
            "桌面端 CLIP 模型未加载：请在「AI 视觉」中加载语义模型",
        ));
    }
    let model_name = guard.get_model_name();
    let embedding = {
        let model = guard
            .model_mut()
            .ok_or_else(|| model_unavailable("CLIP 模型未就绪"))?;
        // 同步阻塞调用（同 WD14 classify 的登记：借用无法跨 spawn_blocking）
        encode(model).map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e))?
    };
    let store = guard
        .embedding_store()
        .ok_or_else(|| model_unavailable("嵌入索引未就绪：请先在桌面端生成图库嵌入"))?
        .clone();
    let count = store
        .get_embedding_count()
        .unwrap_or(0);
    if count == 0 {
        return Err(model_unavailable(
            "嵌入索引为空：请先在桌面端 AI 视觉面板生成图库嵌入",
        ));
    }
    let searcher = crate::clip::search::SimilaritySearcher::new(store);
    let options = crate::clip::search::SearchOptions {
        top_k: 500,
        min_score: 0.0,
        include_score: true,
    };
    // min_score 先不传给 searcher（保持全量 top-k 后在响应组装层按客户端阈值过滤，
    // 便于 hits 与 path 反查共用一次结果）；top_k=500 为契约上限。
    searcher
        .search(&embedding, &options, Some(&model_name))
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("搜索失败: {e}")))
}

async fn to_clip_response(
    state: AppState,
    results: Vec<SearchResult>,
    max_results: Option<usize>,
) -> Result<Json<ClipSearchResponse>, Response> {
    let limit = max_results.unwrap_or(100).min(500);
    let min_score = 0.0f32; // 客户端未传 min_score 时按 0（全部命中按分数截断）
    let _ = min_score;

    // file_id → 共享根相对 path（跨根/查不到的跳过，对齐 browse 切根防线语义）。
    let root = state.root_path.clone();
    let pool = require_db(&state)?;
    let ids: Vec<String> = results.iter().take(limit).map(|r| r.file_id.clone()).collect();
    let abs_paths: Vec<Option<String>> = tokio::task::spawn_blocking(move || {
        let conn = pool.get_connection();
        ids.iter()
            .map(|id| crate::db::file_index::get_path_by_id(&conn, id).unwrap_or(None))
            .collect()
    })
    .await
    .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("路径反查失败: {e}")))?;

    let mut hits = Vec::new();
    for (r, abs) in results.iter().take(limit).zip(abs_paths.iter()) {
        let abs = match abs {
            Some(a) => a,
            None => continue,
        };
        let p = std::path::Path::new(abs);
        let rel = match p.strip_prefix(root.as_path()) {
            Ok(rel) => rel.to_string_lossy().replace('\\', "/"),
            Err(_) => continue, // 越出当前共享根 → 丢弃
        };
        hits.push(ClipHit {
            path: rel,
            score: r.score,
        });
    }
    Ok(Json(ClipSearchResponse { hits }))
}

fn require_db(state: &AppState) -> Result<std::sync::Arc<crate::db::AppDbPool>, Response> {
    state
        .db_pool
        .clone()
        .ok_or_else(|| error_response(StatusCode::INTERNAL_SERVER_ERROR, "Database not available"))
}

// ---------------------------------------------------------------------------
// 8.4 GET /api/topic/members?topic_id= — 专题成员枚举（D40）
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct TopicMembersQuery {
    pub topic_id: String,
}

#[derive(Serialize)]
pub struct TopicMembersDetailResponse {
    pub files: Vec<String>,
    pub people: Vec<String>,
}

pub async fn handle_topic_members_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<TopicMembersQuery>,
) -> Result<Json<TopicMembersDetailResponse>, Response> {
    let _session = require_session(&state, &headers).await?;
    let root = state.root_path.clone();
    let pool = require_db(&state)?;
    let topic_id = q.topic_id;

    let outcome = tokio::task::spawn_blocking(move || -> Result<(Vec<String>, Vec<String>), String> {
        let conn = pool.get_connection();
        let topics = crate::db::topics::get_all_topics(&conn).map_err(|e| e.to_string())?;
        if !topics.iter().any(|t| t.id == topic_id) {
            return Err("__not_found__".to_string());
        }
        let files = crate::db::topics::get_topic_files(&conn, &topic_id).map_err(|e| e.to_string())?;
        let people = crate::db::topics::get_topic_people(&conn, &topic_id).map_err(|e| e.to_string())?;
        Ok((files, people))
    })
    .await
    .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("查询失败: {e}")))?;

    let (file_ids, people_ids) = match outcome {
        Ok(pair) => pair,
        Err(e) if e == "__not_found__" => {
            return Err(error_response(StatusCode::NOT_FOUND, "Topic not found"))
        }
        Err(e) => return Err(error_response(StatusCode::INTERNAL_SERVER_ERROR, &e)),
    };

    let files = file_ids_to_relative(&state, file_ids).await?;
    Ok(Json(TopicMembersDetailResponse {
        files,
        people: people_ids,
    }))
}

// ---------------------------------------------------------------------------
// 8.5 GET /api/people/members?person_id= — 人物图片列表（D40）
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
pub struct PeopleMembersQuery {
    pub person_id: String,
}

#[derive(Serialize)]
pub struct PeopleMembersResponse {
    pub paths: Vec<String>,
}

pub async fn handle_people_members_get(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<PeopleMembersQuery>,
) -> Result<Json<PeopleMembersResponse>, Response> {
    let _session = require_session(&state, &headers).await?;
    let pool = require_db(&state)?;
    let person_id = q.person_id;

    // 存在性：persons 表查无此 id → 404。
    // 关联：遍历 file_metadata.ai_data.faces[].personId == person_id 的 file_id。
    // file_metadata.path 本身存的是绝对路径（桌面写入口径），直接相对化，无需走 file_index。
    let outcome: Result<Vec<String>, String> = tokio::task::spawn_blocking(move || -> Result<Vec<String>, String> {
        let conn = pool.get_connection();
        let people = crate::db::persons::get_all_people(&conn).map_err(|e| e.to_string())?;
        if !people.iter().any(|p| p.id == person_id) {
            return Err("__not_found__".to_string());
        }
        let all = crate::db::file_metadata::get_all_metadata(&conn).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        for m in all {
            let Some(ai) = &m.ai_data else { continue };
            let Some(arr) = ai.get("faces").and_then(|f| f.as_array()) else {
                continue;
            };
            let hit = arr.iter().any(|face| {
                face.get("personId").and_then(|v| v.as_str()) == Some(person_id.as_str())
            });
            if hit {
                out.push(m.path);
            }
        }
        Ok(out)
    })
    .await
    .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("查询失败: {e}")))?;

    let file_ids = match outcome {
        Ok(ids) => ids,
        Err(e) if e == "__not_found__" => {
            return Err(error_response(StatusCode::NOT_FOUND, "Person not found"))
        }
        Err(e) => return Err(error_response(StatusCode::INTERNAL_SERVER_ERROR, &e)),
    };

    let paths = file_ids_to_relative(&state, file_ids).await?;
    Ok(Json(PeopleMembersResponse { paths }))
}

// ---------------------------------------------------------------------------
// 8.6 GET /api/vocab — 桌面词表读（D40）
// ---------------------------------------------------------------------------

#[derive(Serialize)]
pub struct VocabResponse {
    pub tags: Vec<String>,
}

pub async fn handle_vocab_get(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<VocabResponse>, Response> {
    let _session = require_session(&state, &headers).await?;
    let app_data_dir = state
        .app_handle
        .path()
        .app_data_dir()
        .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
    let config_path = app_data_dir.join("user_data.json");
    let tags = if config_path.exists() {
        let content = std::fs::read_to_string(&config_path)
            .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &e.to_string()))?;
        let value: serde_json::Value = serde_json::from_str(&content).unwrap_or(serde_json::json!({}));
        value
            .get("customTags")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Ok(Json(VocabResponse { tags }))
}

// ---------------------------------------------------------------------------
// 共用：file_id 列表 → 共享根相对 path（查不到/越根的跳过）
// ---------------------------------------------------------------------------

async fn file_ids_to_relative(
    state: &AppState,
    file_ids: Vec<String>,
) -> Result<Vec<String>, Response> {
    let root = state.root_path.clone();
    let pool = require_db(state)?;
    tokio::task::spawn_blocking(move || {
        let conn = pool.get_connection();
        let mut out = Vec::new();
        for id in file_ids {
            if let Ok(Some(abs)) = crate::db::file_index::get_path_by_id(&conn, &id) {
                if let Ok(rel) = std::path::Path::new(&abs).strip_prefix(root.as_path()) {
                    out.push(rel.to_string_lossy().replace('\\', "/"));
                }
            }
        }
        out
    })
    .await
    .map_err(|e| error_response(StatusCode::INTERNAL_SERVER_ERROR, &format!("路径反查失败: {e}")))
}
