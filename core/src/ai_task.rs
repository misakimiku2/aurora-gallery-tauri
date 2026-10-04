//! M6b 阶段 1（1.1/1.3）：AI 编排任务层——取消注册表 + 逐张循环 + 写库。
//!
//! 通道形状沿用 0.6 spike 定型：uniffi 0.32 回调代理非 Send，不能 move 进 worker
//! 线程——worker 经 mpsc 把事件（含「要字节」请求）发回调用线程，调用线程的泵循环
//! 驱动 Kotlin 回调；字节经第二条通道回传 worker（锁步，永不同时互等）。
//!
//! 写库铁律（清单 §1）：metadata 走整行读改写（不复制 TS「不传也覆盖」缺陷），
//! tags 只走 add_tags_to_files 词表管线（FfiFileMetadata 无 tags 字段是架构事实）。

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::Duration;

use base64::Engine;

use crate::ai::{self, AiChatKind, AiConfig, AiSearchFilter, SearchItem};
use crate::ffi::FfiFileMetadata;
use crate::ffi::AuroraError;

/// 分析单图 max_tokens，对齐 TS useAIAnalysis 的 openai 分支。
const ANALYSIS_MAX_TOKENS: u32 = 1000;
/// 改名单图 max_tokens，对齐 TS aiService call* 的 100。
const RENAME_MAX_TOKENS: u32 = 100;
/// 改名逐张间隔，对齐 TS generateFileNames 的 100ms 礼貌限速。
const RENAME_GAP: Duration = Duration::from_millis(100);

static CANCELS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

fn cancels() -> &'static Mutex<HashMap<String, Arc<AtomicBool>>> {
    CANCELS.get_or_init(Default::default)
}

/// 取消在册任务：下一张迭代首查生效（在途 HTTP 请求本身不打断——与桌面
/// 「严格顺序无取消」相比已是增强；请求级超时见 ai.rs）。任务不在册返回 false。
#[uniffi::export]
pub fn ai_cancel_task(task_id: String) -> bool {
    if let Some(flag) = cancels().lock().unwrap().get(&task_id) {
        flag.store(true, Ordering::SeqCst);
        true
    } else {
        false
    }
}

/// 一张待分析图（path 供无旧行时落元数据用；字节由 Kotlin 经回调供给）。
#[derive(uniffi::Record)]
pub struct AiInputItem {
    pub file_id: String,
    pub path: String,
    pub name: String,
}

/// 分析任务回调：read_bytes 在调用线程（泵）被调，其余为 worker 事件转发。
#[uniffi::export(callback_interface)]
pub trait AiTaskCallback {
    fn read_bytes(&self, file_id: String) -> Option<Vec<u8>>;
    fn on_progress(&self, current: u32, total: u32);
    fn on_file_done(&self, file_id: String, ok: bool, note: String);
    fn on_finished(&self, state: String, message: String);
}

/// 改名条目（AI 只产名字；真正改名由 Kotlin 走 M4b 重命名管线+系统授权）。
#[derive(uniffi::Record)]
pub struct AiRenameItem {
    pub file_id: String,
    pub name: String,
}

#[uniffi::export(callback_interface)]
pub trait AiRenameCallback {
    fn read_bytes(&self, file_id: String) -> Option<Vec<u8>>;
    fn on_progress(&self, current: u32, total: u32);
    fn on_file_done(&self, file_id: String, ok: bool, note: String);
    fn on_name(&self, file_id: String, new_name: String);
    fn on_finished(&self, state: String, message: String);
}

/// worker → pump 事件。NeedBytes 让泵代读字节（回调对象不跨线程）。
enum Ev {
    NeedBytes(String),
    Progress(u32, u32),
    FileDone(String, bool, String),
    Name(String, String),
    Finished(String, String),
}

/// 批量 AI 分析：逐张 读字节→base64→HTTP→解析→写库，事件实时回调。
/// 阻塞至任务结束（Kotlin 从 IO 协程调用）；state ∈ completed|cancelled|error。
#[uniffi::export]
pub fn ai_analyze_files(cfg: AiConfig, items: Vec<AiInputItem>, task_id: String, callback: Box<dyn AiTaskCallback>) {
    let (tx, rx) = mpsc::channel::<Ev>();
    let (bytes_tx, bytes_rx) = mpsc::channel::<Option<Vec<u8>>>();
    let cancel = register(task_id.clone());
    let total = items.len() as u32;
    let cfg = Arc::new(cfg);

    let worker = std::thread::spawn(move || {
        let client = match ai::AiClient::new() {
            Ok(c) => c,
            Err(e) => {
                tx.send(Ev::Finished("error".into(), format!("HTTP 客户端初始化失败: {e}"))).ok();
                return;
            }
        };
        let prompt = ai::build_analysis_prompt(&cfg);
        let mut done = 0u32;
        for item in &items {
            if cancel_flag(&cancel) {
                finish_cancelled(&tx, done, items.len() as u32);
                return;
            }
            tx.send(Ev::NeedBytes(item.file_id.clone())).ok();
            let bytes = match bytes_rx.recv() {
                Ok(b) => b,
                Err(_) => return, // 泵已退出（仅在 Finished 后发生）
            };
            let outcome = (|| -> Result<(), String> {
                let raw = match bytes {
                    Some(b) if !b.is_empty() => b,
                    _ => return Err("读取图片字节失败".into()),
                };
                let b64 = base64::engine::general_purpose::STANDARD.encode(&raw);
                let mime = ai::guess_mime(&item.name);
                let text = client.chat(&cfg, AiChatKind::Analysis, &prompt, Some(&b64), &mime, ANALYSIS_MAX_TOKENS, true)?;
                let parsed = ai::parse_ai_json(&text).ok_or_else(|| format!("解析失败: {}", clip(&text)))?;
                write_analysis_result(&item.file_id, &item.path, &parsed, &cfg).map_err(|e| e.to_string())?;
                Ok(())
            })();
            match outcome {
                Ok(()) => tx.send(Ev::FileDone(item.file_id.clone(), true, String::new())).ok(),
                Err(e) => tx.send(Ev::FileDone(item.file_id.clone(), false, e)).ok(),
            };
            done += 1;
            tx.send(Ev::Progress(done, total)).ok();
        }
        tx.send(Ev::Finished("completed".into(), format!("{done}/{total}"))).ok();
    });

    pump(rx, bytes_tx, &task_id, |ev| match ev {
        Ev::NeedBytes(id) => Some(callback.read_bytes(id)),
        Ev::Progress(c, t) => {
            callback.on_progress(c, t);
            None
        }
        Ev::FileDone(id, ok, note) => {
            callback.on_file_done(id, ok, note);
            None
        }
        Ev::Finished(s, m) => {
            callback.on_finished(s, m);
            None
        }
        Ev::Name(..) => None, // 分析任务不产生
    });

    let _ = worker.join();
}

/// 批量 AI 改名：逐张产干净文件名，经 on_name 回调；不碰库、不改文件。
#[uniffi::export]
pub fn ai_generate_file_names(cfg: AiConfig, items: Vec<AiRenameItem>, task_id: String, callback: Box<dyn AiRenameCallback>) {
    let (tx, rx) = mpsc::channel::<Ev>();
    let (bytes_tx, bytes_rx) = mpsc::channel::<Option<Vec<u8>>>();
    let cancel = register(task_id.clone());
    let total = items.len() as u32;
    let cfg = Arc::new(cfg);

    let worker = std::thread::spawn(move || {
        let client = match ai::AiClient::new() {
            Ok(c) => c,
            Err(e) => {
                tx.send(Ev::Finished("error".into(), format!("HTTP 客户端初始化失败: {e}"))).ok();
                return;
            }
        };
        for (idx, item) in items.iter().enumerate() {
            if cancel_flag(&cancel) {
                finish_cancelled(&tx, idx as u32, total);
                return;
            }
            if idx > 0 {
                std::thread::sleep(RENAME_GAP);
            }
            tx.send(Ev::NeedBytes(item.file_id.clone())).ok();
            let bytes = match bytes_rx.recv() {
                Ok(b) => b,
                Err(_) => return,
            };
            let outcome = (|| -> Result<String, String> {
                let raw = match bytes {
                    Some(b) if !b.is_empty() => b,
                    _ => return Err("读取图片字节失败".into()),
                };
                let b64 = base64::engine::general_purpose::STANDARD.encode(&raw);
                let mime = ai::guess_mime(&item.name);
                let prompt = ai::build_rename_prompt(&item.name, &[]);
                let text = client.chat(&cfg, AiChatKind::Rename, &prompt, Some(&b64), &mime, RENAME_MAX_TOKENS, false)?;
                ai::clean_rename_response(&text).ok_or_else(|| format!("改名为空或不可用: {}", clip(&text)))
            })();
            match outcome {
                Ok(name) => {
                    tx.send(Ev::Name(item.file_id.clone(), name)).ok();
                    tx.send(Ev::FileDone(item.file_id.clone(), true, String::new())).ok();
                }
                Err(e) => {
                    tx.send(Ev::FileDone(item.file_id.clone(), false, e)).ok();
                }
            };
            tx.send(Ev::Progress((idx + 1) as u32, total)).ok();
        }
        tx.send(Ev::Finished("completed".into(), format!("{}/{}", items.len(), items.len()))).ok();
    });

    pump(rx, bytes_tx, &task_id, |ev| match ev {
        Ev::NeedBytes(id) => Some(callback.read_bytes(id)),
        Ev::Name(id, name) => {
            callback.on_name(id, name);
            None
        }
        Ev::Progress(c, t) => {
            callback.on_progress(c, t);
            None
        }
        Ev::FileDone(id, ok, note) => {
            callback.on_file_done(id, ok, note);
            None
        }
        Ev::Finished(s, m) => {
            callback.on_finished(s, m);
            None
        }
    });

    let _ = worker.join();
}

/// 泵循环：worker 事件 → 闭包分发。闭包对 NeedBytes 返回 `Some(读字节结果)`
/// （外层 Some=需要回执，内层 Option=读取成败），其余事件返回 None；
/// Finished 必是 worker 最后一条消息，收到后收尾并把任务移出取消注册表。
fn pump(
    rx: mpsc::Receiver<Ev>,
    bytes_tx: mpsc::Sender<Option<Vec<u8>>>,
    task_id: &str,
    mut handle: impl FnMut(Ev) -> Option<Option<Vec<u8>>>,
) {
    let mut finished = false;
    while !finished {
        match rx.recv() {
            Ok(ev) => {
                if matches!(ev, Ev::Finished(..)) {
                    finished = true;
                }
                if let Some(reply) = handle(ev) {
                    bytes_tx.send(reply).ok();
                }
            }
            Err(_) => break,
        }
    }
    cancels().lock().unwrap().remove(task_id);
}

fn register(task_id: String) -> Arc<AtomicBool> {
    let flag = Arc::new(AtomicBool::new(false));
    cancels().lock().unwrap().insert(task_id, flag.clone());
    flag
}

fn cancel_flag(flag: &AtomicBool) -> bool {
    flag.load(Ordering::SeqCst)
}

fn finish_cancelled(tx: &mpsc::Sender<Ev>, done: u32, total: u32) {
    tx.send(Ev::Finished("cancelled".into(), format!("在 {done}/{total} 后取消"))).ok();
}

fn clip(text: &str) -> String {
    text.chars().take(200).collect()
}

/// AI 搜索改写：query → 结构化过滤条件（同步一次 HTTP，Kotlin 在 IO 协程调用）。
/// originalQuery 由本层从入参回填（对齐 TS :196-202，模型响应不带它）。
#[uniffi::export]
pub fn ai_rewrite_search_query(cfg: AiConfig, query: String) -> Result<AiSearchFilter, AuroraError> {
    let client = ai::AiClient::new().map_err(AuroraError::Ai)?;
    let prompt = ai::build_search_rewrite_prompt(&query, &cfg.language);
    let text = client.chat(&cfg, AiChatKind::Search, &prompt, None, "", SEARCH_MAX_TOKENS, true).map_err(AuroraError::Ai)?;
    let mut filter = ai::parse_search_filter(&text)
        .ok_or_else(|| AuroraError::Ai(format!("搜索改写解析失败: {}", clip(&text))))?;
    filter.original_query = query;
    Ok(filter)
}

/// 过滤条件应用到候选集（纯函数；keywords/description 即期，colors/people 的
/// 数据源挂钩阶段 3/4——桌面语义见 ai.rs 内注释）。
#[uniffi::export]
pub fn ai_apply_search_filter(filter: AiSearchFilter, items: Vec<SearchItem>) -> Vec<String> {
    ai::apply_search_filter(&filter, items)
}

/// provider 连接测试（对齐 TS checkConnection 的三探测路径）。
#[uniffi::export]
pub fn ai_check_connection(cfg: AiConfig) -> Result<(), AuroraError> {
    let client = ai::AiClient::new().map_err(AuroraError::Ai)?;
    client.check_connection(&cfg).map_err(AuroraError::Ai)
}

/// 拉取模型列表（AI 面板「刷新模型」用）。
#[uniffi::export]
pub fn ai_fetch_models(cfg: AiConfig) -> Result<Vec<String>, AuroraError> {
    let client = ai::AiClient::new().map_err(AuroraError::Ai)?;
    client.fetch_models(&cfg).map_err(AuroraError::Ai)
}

/// 搜索改写 max_tokens（对齐 TS useSearch 的请求上限，源码事实由 ai.rs 注释背书）。
const SEARCH_MAX_TOKENS: u32 = 500;

/// 分析结果写库（铁律两件套）。字段语义（TS 源码事实，见 ai.rs 模块注释）：
/// - category = 旧值透传（AI 不产出 category；sceneCategory 只进 aiData）；
/// - description = 开关开→解析值（缺则保留旧值），关→保留旧值（TS 会把模型未回的
///   字段整行覆盖成 null——此处不复制该缺陷，登记为稳化偏差）；
/// - tags = 合并旧集去重走词表管线（与 TS 的 [...existing, ...new] 合并等价）；
/// - ai_data = 整体替换，开关清零后的 AiParsed 驱动形状（关的开关字段为空值/缺键）；
/// - source_url 恒保留旧值（TS 不传也覆盖的原始缺陷，铁律明示不复制）。
fn write_analysis_result(
    file_id: &str,
    path: &str,
    parsed: &ai::AiParsed,
    cfg: &AiConfig,
) -> Result<(), AuroraError> {
    let old = crate::ffi::get_file_metadata(file_id.to_string())?;
    let old = old.unwrap_or_else(|| FfiFileMetadata {
        file_id: file_id.to_string(),
        path: path.to_string(),
        description: None,
        source_url: None,
        source_urls: Vec::new(),
        ai_data: None,
        category: None,
        updated_at: None,
    });
    let effective = ai::AiParsed {
        description: if cfg.auto_description { parsed.description.clone() } else { None },
        extracted_text: if cfg.enable_ocr { parsed.extracted_text.clone() } else { None },
        translated_text: if cfg.enable_translation { parsed.translated_text.clone() } else { None },
        tags: if cfg.auto_tag { parsed.tags.clone() } else { Vec::new() },
        scene_category: parsed.scene_category.clone(),
        objects: parsed.objects.clone(),
    };
    let description = effective.description.clone().or_else(|| old.description.clone());
    crate::ffi::upsert_file_metadata(FfiFileMetadata {
        file_id: file_id.to_string(),
        path: old.path.clone(),
        description,
        source_url: old.source_url.clone(),
        // 整行写回，来源网址要带全量（只回填首条会把其余几条压没）
        source_urls: old.source_urls.clone(),
        ai_data: Some(ai::build_ai_data_json(&effective).to_string()),
        category: old.category.clone(),
        updated_at: Some(chrono::Utc::now().timestamp()),
    })?;
    let ai_tags = effective.tags;
    if !ai_tags.is_empty() {
        let current = crate::ffi::get_file_tags(file_id.to_string())?;
        let fresh: Vec<String> = ai_tags.iter().filter(|t| !current.contains(t)).cloned().collect();
        if !fresh.is_empty() {
            crate::ffi::add_tags_to_files(vec![file_id.to_string()], fresh)?;
        }
    }
    Ok(())
}
