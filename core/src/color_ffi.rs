//! 主色调批提取 + 颜色搜索的 UniFFI 导出面（M6b 阶段 3）。
//!
//! ## 键语义决定（重要，Kotlin 接线必读）
//! Android 本地库的稳定身份是 **file_id**（content URI 哈希）。本模块所有以
//! "file_id" 命名的参数，落库时一律写入 `dominant_colors.file_path` /
//! `image_color_indices.file_path` 列——**列名沿用 file_path 不动**（schema 兼容
//! 桌面），但键的语义是 file_id。MediaStore 改名/移动不改变 `_id` → 哈希不变 →
//! 颜色行无需随重命名迁移；因此桌面专用的 `move_colors` / `copy_colors` /
//! `cleanup_stale_color_records` 等路径语义方法**不进** Android FFI 面。
//!
//! ## 线程/通道形状
//! 批量任务照抄 `ai_task` 的锁步双通道泵模式：uniffi 0.32 回调代理非 Send 不能
//! move 进 worker 线程——worker 经 mpsc 发事件回调用线程，调用线程的泵驱动
//! Kotlin 回调；像素经第二条通道回执 worker（永不同时互等）。与 ai_task 的差异：
//! 取消注册表升级为 **paused + cancelled 双原子标志**（对齐桌面 StoragePanel 的
//! 暂停/恢复/取消三态），cancel 语义 = 迭代首查（在途一张跑完），暂停同样在
//! 迭代边界生效（取消可打断暂停自旋）。

use std::collections::HashMap;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;

use image::DynamicImage;

use crate::color_db::{self, ColorDbPool};
use crate::color_extractor;
use crate::color_search;
use crate::ffi::AuroraError;

/// 单张提取的主色调数量（对齐桌面 color_worker 的 8）。
const EXTRACT_COUNT: usize = 8;
/// 暂停自旋的轮询间隔。
const PAUSE_POLL: Duration = Duration::from_millis(50);

// ---------------------------------------------------------------------------
// 全局状态：颜色库单槽 + 批量任务注册表
// ---------------------------------------------------------------------------

/// 颜色库单槽：首次 init 建库，二次 init 即 switch（幂等换库）。
static COLOR_DB: OnceLock<Mutex<Option<ColorDbPool>>> = OnceLock::new();

fn color_db_slot() -> &'static Mutex<Option<ColorDbPool>> {
    COLOR_DB.get_or_init(Default::default)
}

/// 错误映射：color_db 系函数的 String 错误 → AuroraError::Database。
fn db_err(e: String) -> AuroraError {
    AuroraError::Database(e)
}

/// 取已初始化的颜色库引用（未 init → 中文说明的 Database 错误）。
fn with_color_db<T>(f: impl FnOnce(&ColorDbPool) -> Result<T, AuroraError>) -> Result<T, AuroraError> {
    let guard = color_db_slot().lock().unwrap();
    let pool = guard
        .as_ref()
        .ok_or_else(|| AuroraError::Database("颜色库未初始化，请先调用 initColorDb 传入 colors.db 路径".to_string()))?;
    f(pool)
}

/// 批量任务三态注册表：cancelled + paused 双标志。
struct ColorTaskFlags {
    cancelled: AtomicBool,
    paused: AtomicBool,
}

impl ColorTaskFlags {
    fn new() -> Self {
        Self {
            cancelled: AtomicBool::new(false),
            paused: AtomicBool::new(false),
        }
    }
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }
    fn paused(&self) -> bool {
        self.paused.load(Ordering::SeqCst)
    }
}

static COLOR_TASKS: OnceLock<Mutex<HashMap<String, std::sync::Arc<ColorTaskFlags>>>> = OnceLock::new();

fn color_tasks() -> &'static Mutex<HashMap<String, std::sync::Arc<ColorTaskFlags>>> {
    COLOR_TASKS.get_or_init(Default::default)
}

fn task_flags(task_id: &str) -> Option<std::sync::Arc<ColorTaskFlags>> {
    color_tasks().lock().unwrap().get(task_id).cloned()
}

// ---------------------------------------------------------------------------
// FFI 数据类型
// ---------------------------------------------------------------------------

/// 一次像素供给（Kotlin 下采样位图的 RGBA 字节，行优先、每像素 4 字节）。
#[derive(uniffi::Record)]
pub struct ColorPixels {
    pub width: u32,
    pub height: u32,
    pub rgba: Vec<u8>,
}

/// 批量提取任务回调（uniffi callback interface；实现对象留在调用线程，
/// `read_pixels` 由泵代调——见模块注释的锁步双通道）。
#[uniffi::export(callback_interface)]
pub trait ColorBatchCallback {
    /// 泵在调用线程代读像素；None = 该图当前不可读（记为单文件失败，不炸任务）。
    fn read_pixels(&self, file_id: String) -> Option<ColorPixels>;
    fn on_progress(&self, current: u32, total: u32);
    /// note：成功为空串，失败为中文原因。
    fn on_file_done(&self, file_id: String, ok: bool, note: String);
    /// state ∈ running|paused|completed|cancelled|error（running/paused 由
    /// Kotlin 侧本地状态机表达，Rust 只会发 completed|cancelled|error）。
    fn on_finished(&self, state: String, message: String);
}

/// 颜色库行数统计（StoragePanel 主色调节用）。
#[derive(uniffi::Record)]
pub struct ColorDbStats {
    /// 全部行数（含 processing）。
    pub total: u32,
    pub pending: u32,
    pub extracted: u32,
    pub error: u32,
}

/// 错误文件条目。对应 color_db::get_error_files 的返回形状
/// （file 键 + updated_at 秒级时间戳；status 恒为 error 故不重复携带）。
#[derive(uniffi::Record)]
pub struct ColorErrorFile {
    pub file_id: String,
    pub updated_at: i64,
}

// ---------------------------------------------------------------------------
// 颜色库初始化 / 批读 / 单张提取
// ---------------------------------------------------------------------------

/// 颜色库初始化（colors.db 落 Kotlin 传的 app 数据目录路径）。
///
/// 幂等：首次调用建库（建表 + 把遗留 processing 行重置为 pending），再次调用
/// 即 `ColorDbPool::switch` 换库（同样建表 + 重置 processing）。每次成功后
/// 触发后台缓存预热（搜索暖路径依赖它，冷路径不受影响）。
#[uniffi::export]
pub fn init_color_db(path: String) -> Result<(), AuroraError> {
    let mut guard = color_db_slot().lock().unwrap();
    match guard.as_ref() {
        None => {
            let pool = ColorDbPool::new(Path::new(&path))
                .map_err(|e| AuroraError::Database(format!("打开颜色库失败: {e}")))?;
            {
                let mut conn = pool.get_connection();
                color_db::init_db(&mut conn).map_err(db_err)?;
                color_db::reset_processing_to_pending(&mut conn).map_err(db_err)?;
            }
            let _ = pool.ensure_cache_initialized_async();
            *guard = Some(pool);
            Ok(())
        }
        Some(pool) => {
            pool.switch(&path).map_err(db_err)?;
            let _ = pool.ensure_cache_initialized_async();
            Ok(())
        }
    }
}

/// 批读主色调 hex 列表（网格/查看器缓存用）。
///
/// 返回与 `file_ids` 等长且按入参对齐：库里无记录 / 未提取完成（status != extracted）
/// / colors JSON 解析失败 → 对应位为 `None`。键语义为 file_id（见模块注释）。
#[uniffi::export]
pub fn get_colors_by_file_paths(file_ids: Vec<String>) -> Result<Vec<Option<Vec<String>>>, AuroraError> {
    with_color_db(|pool| {
        let mut conn = pool.get_connection();
        let map: HashMap<String, Vec<String>> =
            color_db::get_colors_by_file_paths(&mut conn, &file_ids).map_err(db_err)?;
        Ok(file_ids.iter().map(|id| map.get(id).cloned()).collect())
    })
}

/// 单张提取主色调并落库（查看器手动/自动提取用）。
///
/// `pixels` 为下采样位图的 RGBA 字节（建议最长边 ~256px，提取算法不再缩放）。
/// 成功返回 hex 列表（≤8 个，`#rrggbb` 小写）；失败（宽高与字节数不符 / 提取为空 /
/// 写库失败）返回 Err 并把该 file_id 的行状态标记为 error（对齐桌面 process_single_file）。
#[uniffi::export]
pub fn extract_and_save_colors(file_id: String, width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<String>, AuroraError> {
    with_color_db(|pool| {
        let outcome = extract_and_store(pool, &file_id, width, height, rgba);
        if let Err(note) = &outcome {
            let mut conn = pool.get_connection();
            // 行可能不存在（如宽高不符在落库前就失败）——先补 pending 行再标 error，
            // 让错误文件管理节可见（对齐桌面 process_single_file 的状态机语义）
            let _ = color_db::add_pending_files(&mut conn, std::slice::from_ref(&file_id));
            let _ = color_db::update_status(&mut conn, &file_id, "error");
            return Err(AuroraError::Database(note.clone()));
        }
        outcome.map_err(db_err)
    })
}

/// 纯提取 + 落库（不负责错误状态标记，由调用方统一处理）。
fn extract_and_store(pool: &ColorDbPool, file_id: &str, width: u32, height: u32, rgba: Vec<u8>) -> Result<Vec<String>, String> {
    let expected = width as usize * height as usize * 4;
    let actual = rgba.len();
    let img = image::RgbaImage::from_raw(width, height, rgba).ok_or_else(|| {
        format!("RGBA 字节数与宽高不符（{width}x{height} 期望 {expected} 字节，实得 {actual} 字节）")
    })?;
    let colors = color_extractor::get_dominant_colors(&DynamicImage::ImageRgba8(img), EXTRACT_COUNT);
    if colors.is_empty() {
        return Err("未提取到主色调（图像可能全透明或近白）".to_string());
    }
    pool.save_colors(file_id, &colors)
        .map_err(|e| format!("保存主色调失败: {e}"))?;
    Ok(colors.iter().map(|c| c.hex.clone()).collect())
}

// ---------------------------------------------------------------------------
// 批量提取任务（worker + 泵，形状照抄 ai_task）
// ---------------------------------------------------------------------------

/// worker → pump 事件。NeedPixels 让泵代读像素（回调对象不跨线程）。
enum Ev {
    NeedPixels(String),
    Progress(u32, u32),
    FileDone(String, bool, String),
    Finished(String, String),
}

/// 批量主色调提取：逐张 请求像素→提取 8 色→落库，事件实时回调。
/// **阻塞至任务结束**（Kotlin 从 IO 协程调用）；state ∈ completed|cancelled|error。
/// 单文件失败只经 `on_file_done(ok=false)` 上报并把行标为 error，不炸任务。
#[uniffi::export]
pub fn batch_extract_colors(file_ids: Vec<String>, task_id: String, callback: Box<dyn ColorBatchCallback>) {
    let (tx, rx) = mpsc::channel::<Ev>();
    let (pixels_tx, pixels_rx) = mpsc::channel::<Option<ColorPixels>>();
    let flags = {
        let f = std::sync::Arc::new(ColorTaskFlags::new());
        color_tasks().lock().unwrap().insert(task_id.clone(), f.clone());
        f
    };
    let total = file_ids.len() as u32;

    // 颜色库未初始化 → 经 on_finished 报 error（不 panic、不返回 Err：签名与
    // ai_analyze_files 对齐，终态一律走回调）。
    let pool = color_db_slot().lock().unwrap().as_ref().cloned();

    let worker = std::thread::spawn(move || {
        let pool = match pool {
            Some(p) => p,
            None => {
                tx.send(Ev::Finished("error".into(), "颜色库未初始化，请先调用 initColorDb".into())).ok();
                return;
            }
        };
        let mut done = 0u32;
        for file_id in &file_ids {
            // 取消/暂停均为迭代首查：在途一张跑完（cancel 语义，模块注释）
            if flags.cancelled() {
                finish_cancelled(&tx, done, total);
                return;
            }
            // 暂停自旋：取消可打断暂停（cancel 优先于 pause）
            while flags.paused() && !flags.cancelled() {
                std::thread::sleep(PAUSE_POLL);
            }
            if flags.cancelled() {
                finish_cancelled(&tx, done, total);
                return;
            }

            // 登记行（无则建 pending）并进入 processing
            {
                let mut conn = pool.get_connection();
                let _ = color_db::add_pending_files(&mut conn, std::slice::from_ref(file_id));
                let _ = color_db::update_status(&mut conn, file_id, "processing");
            }

            tx.send(Ev::NeedPixels(file_id.clone())).ok();
            let pixels = match pixels_rx.recv() {
                Ok(p) => p,
                Err(_) => return, // 泵已退出（仅在 Finished 后发生）
            };
            let outcome = match pixels {
                Some(p) if p.rgba.len() == p.width as usize * p.height as usize * 4 => {
                    extract_and_store(&pool, file_id, p.width, p.height, p.rgba)
                }
                Some(p) => Err(format!(
                    "RGBA 字节数与宽高不符（{}x{} 期望 {} 字节，实得 {} 字节）",
                    p.width, p.height, p.width as usize * p.height as usize * 4, p.rgba.len()
                )),
                None => Err("读取图像像素失败".into()),
            };
            match outcome {
                Ok(_) => tx.send(Ev::FileDone(file_id.clone(), true, String::new())).ok(),
                Err(e) => {
                    // 对齐桌面 color_worker：处理失败 → 行状态 error
                    let mut conn = pool.get_connection();
                    let _ = color_db::update_status(&mut conn, file_id, "error");
                    drop(conn);
                    tx.send(Ev::FileDone(file_id.clone(), false, e)).ok()
                }
            };
            done += 1;
            tx.send(Ev::Progress(done, total)).ok();
        }
        tx.send(Ev::Finished("completed".into(), format!("{done}/{total}"))).ok();
    });

    pump(rx, pixels_tx, &task_id, |ev| match ev {
        Ev::NeedPixels(id) => Some(callback.read_pixels(id)),
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

/// 泵循环（形状同 ai_task::pump）：worker 事件 → 闭包分发。闭包对 NeedPixels
/// 返回 `Some(像素结果)`（外层 Some=需要回执），其余事件返回 None；Finished
/// 必是 worker 最后一条消息，收到后收尾并把任务移出注册表。
fn pump(
    rx: mpsc::Receiver<Ev>,
    pixels_tx: mpsc::Sender<Option<ColorPixels>>,
    task_id: &str,
    mut handle: impl FnMut(Ev) -> Option<Option<ColorPixels>>,
) {
    let mut finished = false;
    while !finished {
        match rx.recv() {
            Ok(ev) => {
                if matches!(ev, Ev::Finished(..)) {
                    finished = true;
                }
                if let Some(reply) = handle(ev) {
                    pixels_tx.send(reply).ok();
                }
            }
            Err(_) => break,
        }
    }
    color_tasks().lock().unwrap().remove(task_id);
}

fn finish_cancelled(tx: &mpsc::Sender<Ev>, done: u32, total: u32) {
    tx.send(Ev::Finished("cancelled".into(), format!("在 {done}/{total} 后取消"))).ok();
}

/// 暂停在册任务（下一张迭代边界生效）。任务不在册（已结束/不存在）返回 false。
#[uniffi::export]
pub fn pause_color_task(task_id: String) -> bool {
    match task_flags(&task_id) {
        Some(f) => {
            f.paused.store(true, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// 恢复暂停的任务。任务不在册返回 false。
#[uniffi::export]
pub fn resume_color_task(task_id: String) -> bool {
    match task_flags(&task_id) {
        Some(f) => {
            f.paused.store(false, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

/// 取消在册任务：下一张迭代首查生效（在途一张跑完）；若任务正处于暂停自旋，
/// 会同时清除暂停标志让 worker 立即退出。任务不在册返回 false。
#[uniffi::export]
pub fn cancel_color_task(task_id: String) -> bool {
    match task_flags(&task_id) {
        Some(f) => {
            f.cancelled.store(true, Ordering::SeqCst);
            f.paused.store(false, Ordering::SeqCst);
            true
        }
        None => false,
    }
}

// ---------------------------------------------------------------------------
// 统计与错误文件管理（StoragePanel 主色调节）
// ---------------------------------------------------------------------------

/// 颜色库行数统计。未 init → Err。
#[uniffi::export]
pub fn color_db_stats() -> Result<ColorDbStats, AuroraError> {
    with_color_db(|pool| {
        let conn = pool.get_connection();
        fn count(conn: &rusqlite::Connection, status: Option<&str>) -> Result<u32, AuroraError> {
            let n: i64 = match status {
                Some(s) => conn.query_row(
                    "SELECT COUNT(*) FROM dominant_colors WHERE status = ?",
                    [s],
                    |row| row.get(0),
                ),
                None => conn.query_row("SELECT COUNT(*) FROM dominant_colors", [], |row| row.get(0)),
            }
            .map_err(|e| AuroraError::Database(e.to_string()))?;
            Ok(n as u32)
        }
        Ok(ColorDbStats {
            total: count(&conn, None)?,
            pending: count(&conn, Some("pending"))?,
            extracted: count(&conn, Some("extracted"))?,
            error: count(&conn, Some("error"))?,
        })
    })
}

/// 错误文件列表（file_id + updated_at，按 updated_at 降序）。
#[uniffi::export]
pub fn get_color_error_files() -> Result<Vec<ColorErrorFile>, AuroraError> {
    with_color_db(|pool| {
        let mut conn = pool.get_connection();
        Ok(color_db::get_error_files(&mut conn)
            .map_err(db_err)?
            .into_iter()
            .map(|(file_id, updated_at)| ColorErrorFile { file_id, updated_at })
            .collect())
    })
}

/// 全部错误文件重置为 pending（重新入队），返回重置条数。
#[uniffi::export]
pub fn retry_color_error_files() -> Result<u32, AuroraError> {
    with_color_db(|pool| {
        let mut conn = pool.get_connection();
        color_db::reset_error_files_to_pending(&mut conn, None).map(|n| n as u32).map_err(db_err)
    })
}

/// 删除全部错误文件记录（含颜色索引行），返回删除条数。
#[uniffi::export]
pub fn delete_color_error_files() -> Result<u32, AuroraError> {
    with_color_db(|pool| {
        let mut conn = pool.get_connection();
        let ids: Vec<String> = color_db::get_error_files(&mut conn).map_err(db_err)?.into_iter().map(|(id, _)| id).collect();
        color_db::delete_error_files(&mut conn, &ids).map(|n| n as u32).map_err(db_err)
    })
}

/// 清理「不存在」的错误记录，返回清理条数。
///
/// **Android 语义决定**：键是 file_id 哈希而非文件系统路径，Rust 侧无法验证
/// MediaStore 存在性——若照搬桌面的 `Path::exists()` 判定，哈希键必然判假、
/// 会把全部 error 记录误删。因此本函数只清理「形似路径（含 / 或 \\）且磁盘上
/// 不存在」的记录；纯 file_id 哈希键一律保留，其存活性校验（MediaStore 查询）
/// 由 Kotlin 侧完成，确认不存在后走 delete_color_error_files 精确删除。
#[uniffi::export]
pub fn cleanup_color_nonexistent() -> Result<u32, AuroraError> {
    with_color_db(|pool| {
        let mut conn = pool.get_connection();
        let stale: Vec<String> = color_db::get_error_files(&mut conn)
            .map_err(db_err)?
            .into_iter()
            .filter(|(k, _)| (k.contains('/') || k.contains('\\')) && !Path::new(k).exists())
            .map(|(k, _)| k)
            .collect();
        color_db::delete_error_files(&mut conn, &stale).map(|n| n as u32).map_err(db_err)
    })
}

// ---------------------------------------------------------------------------
// 颜色搜索（下沉自 src-tauri 的 CIEDE2000 实现）
// ---------------------------------------------------------------------------

/// 单色搜索（模式=Single：阈值 75、位置权重、灰度排除）。
/// 依赖颜色库已 init 且有数据；「先查 stats 判数据量」的 UI 逻辑留给 Kotlin。
#[uniffi::export]
pub fn search_by_color(hex: String) -> Result<Vec<String>, AuroraError> {
    search_by_palette_ffi(vec![hex])
}

/// 多色搜索（内部按数量分模式：1 色 Single / 2-4 色 Mid / ≥5 色 Atmosphere）。
/// 无有效 hex 入参 → Ok(空)；未 init → Err(Database)。
#[uniffi::export]
pub fn search_by_palette(palettes: Vec<String>) -> Result<Vec<String>, AuroraError> {
    search_by_palette_ffi(palettes)
}

fn search_by_palette_ffi(palettes: Vec<String>) -> Result<Vec<String>, AuroraError> {
    with_color_db(|pool| color_search::search_palette(pool, &palettes).map_err(db_err))
}

// ---------------------------------------------------------------------------
// 单测
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::color_db::{add_pending_files, get_pending_files_count};
    use std::sync::atomic::AtomicUsize;

    /// 颜色库是进程级单槽：所有触库测试串行执行，且各用独立临时库路径。
    static TEST_LOCK: Mutex<()> = Mutex::new(());
    static TEMP_SEQ: AtomicUsize = AtomicUsize::new(0);

    /// 重置单槽并初始化一个独立临时库，返回库路径。
    fn init_temp_db(tag: &str) -> String {
        let dir = std::env::temp_dir();
        let n = TEMP_SEQ.fetch_add(1, Ordering::SeqCst);
        let path = dir.join(format!("m6b_color_{}_{}_{}.db", tag, std::process::id(), n));
        let _ = std::fs::remove_file(&path);
        *color_db_slot().lock().unwrap() = None;
        init_color_db(path.to_string_lossy().to_string()).expect("init temp color db");
        path.to_string_lossy().to_string()
    }

    /// 纯色 RGBA 位图。
    fn solid_rgba(size: u32, rgb: [u8; 3]) -> Vec<u8> {
        let mut rgba = Vec::with_capacity((size * size * 4) as usize);
        for _ in 0..size * size {
            rgba.extend_from_slice(&[rgb[0], rgb[1], rgb[2], 255]);
        }
        rgba
    }

    /// 测试回调：按序供给纯色像素；支持首次/第 N 次调用前阻塞（gate）与
    /// 每次调用的副作用钩子（hook，如触发 cancel）。
    struct MockBatch {
        task_id: String,
        pixels: HashMap<String, [u8; 3]>,
        size: u32,
        seq: Mutex<Vec<String>>,
        events: Mutex<Vec<String>>,
        /// Some((在第 n 次 read_pixels 阻塞, rx))：等待测试线程放行。
        gate: Mutex<Option<(usize, mpsc::Receiver<()>)>>,
        hook: Mutex<Option<std::sync::Arc<dyn Fn() + Send + Sync>>>,
    }

    impl MockBatch {
        fn new(task_id: &str, pixels: HashMap<String, [u8; 3]>) -> Self {
            Self {
                task_id: task_id.to_string(),
                pixels,
                size: 32,
                seq: Mutex::new(Vec::new()),
                events: Mutex::new(Vec::new()),
                gate: Mutex::new(None),
                hook: Mutex::new(None),
            }
        }
        fn events(&self) -> Vec<String> {
            self.events.lock().unwrap().clone()
        }
        fn seq_len(&self) -> usize {
            self.seq.lock().unwrap().len()
        }
    }

    impl ColorBatchCallback for MockBatch {
        fn read_pixels(&self, file_id: String) -> Option<ColorPixels> {
            self.seq.lock().unwrap().push(file_id.clone());
            if let Some(hook) = self.hook.lock().unwrap().as_ref() {
                hook();
            }
            // 门闸：第 n 次调用前阻塞，等待测试线程放行（带超时防测试挂死）
            if let Some((at, rx)) = self.gate.lock().unwrap().as_ref() {
                if self.seq_len() == *at {
                    let _ = rx.recv_timeout(std::time::Duration::from_secs(10));
                }
            }
            self.pixels.get(&file_id).map(|rgb| ColorPixels {
                width: self.size,
                height: self.size,
                rgba: solid_rgba(self.size, *rgb),
            })
        }
        fn on_progress(&self, current: u32, total: u32) {
            self.events.lock().unwrap().push(format!("progress:{current}/{total}"));
        }
        fn on_file_done(&self, file_id: String, ok: bool, note: String) {
            self.events.lock().unwrap().push(format!("done:{file_id}:{ok}:{note}"));
        }
        fn on_finished(&self, state: String, message: String) {
            self.events.lock().unwrap().push(format!("finished:{state}:{message}"));
        }
    }

    #[test]
    fn search_requires_init() {
        let _g = TEST_LOCK.lock().unwrap();
        // 未初始化 → Err(Database)，中文说明（前序测试可能留了全局槽，先清回 None）
        *color_db_slot().lock().unwrap() = None;
        let err = search_by_color("#ff0000".to_string()).unwrap_err();
        let msg = format!("{err}");
        assert!(msg.contains("未初始化"), "错误信息应含「未初始化」: {msg}");
    }

    #[test]
    fn extract_and_save_roundtrip() {
        let _g = TEST_LOCK.lock().unwrap();
        init_temp_db("extract");

        let hexes = extract_and_save_colors("file-1".into(), 32, 32, solid_rgba(32, [255, 0, 0])).expect("提取应成功");
        assert!(!hexes.is_empty() && hexes.len() <= 8);
        for h in &hexes {
            assert_eq!(h.len(), 7, "hex 应为 #rrggbb 形状: {h}");
            assert!(h.starts_with('#'));
            assert!(color_search::hex_to_lab(h).is_some(), "hex 应可解析: {h}");
        }

        // 批读：有记录 → Some；无记录 → None，且按入参对齐
        let read = get_colors_by_file_paths(vec!["file-1".into(), "missing".into()]).unwrap();
        assert_eq!(read[0].as_ref().map(|v| v.len()), Some(hexes.len()));
        assert_eq!(read[1], None);

        // 宽高与字节数不符 → Err，且行状态标记 error
        assert!(extract_and_save_colors("file-bad".into(), 4, 4, vec![0u8; 10]).is_err());
        let errs = get_color_error_files().unwrap();
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].file_id, "file-bad");
    }

    #[test]
    fn batch_extract_three_images_completes() {
        let _g = TEST_LOCK.lock().unwrap();
        let ids: Vec<String> = ["b-1", "b-2", "b-3"].iter().map(|s| s.to_string()).collect();
        let mut pixels = HashMap::new();
        pixels.insert("b-1".to_string(), [255, 0, 0]);
        pixels.insert("b-2".to_string(), [0, 0, 255]);
        pixels.insert("b-3".to_string(), [0, 200, 0]);
        init_temp_db("batch-ok");

        let mock = std::sync::Arc::new(MockBatch::new("task-ok", pixels));
        batch_extract_colors(ids, "task-ok".into(), Box::new(MockShared(mock.clone())));

        let events = mock.events();
        let finished: Vec<&String> = events.iter().filter(|e| e.starts_with("finished:")).collect();
        assert_eq!(finished, vec!["finished:completed:3/3"], "终态应 completed 3/3: {events:?}");
        assert_eq!(
            events.iter().filter(|e| e.starts_with("progress:")).count(),
            3,
            "进度回调应恰好 3 次"
        );
        assert!(events.iter().all(|e| !e.contains(":false:")), "不应有单文件失败: {events:?}");

        // 库里 3 行 extracted
        let stats = color_db_stats().unwrap();
        assert_eq!(stats.total, 3);
        assert_eq!(stats.extracted, 3);
        assert_eq!(stats.pending, 0);
        assert_eq!(stats.error, 0);
        let read = get_colors_by_file_paths(vec!["b-1".into(), "b-2".into(), "b-3".into()]).unwrap();
        assert!(read.iter().all(|r| r.as_ref().map(|v| !v.is_empty()).unwrap_or(false)));
    }

    #[test]
    fn batch_cancel_lets_inflight_item_finish() {
        let _g = TEST_LOCK.lock().unwrap();
        let ids: Vec<String> = ["c-1", "c-2", "c-3"].iter().map(|s| s.to_string()).collect();
        let mut pixels = HashMap::new();
        pixels.insert("c-1".to_string(), [255, 0, 0]);
        pixels.insert("c-2".to_string(), [0, 0, 255]);
        pixels.insert("c-3".to_string(), [0, 200, 0]);
        init_temp_db("batch-cancel");

        let mock = std::sync::Arc::new(MockBatch::new("task-cancel", pixels));
        // 第 2 次 read_pixels（c-2 在途）前阻塞（tx 必须持活，否则 rx 立刻 Disconnected
        // 门闸失效——recv_timeout 只在收/断开两种情形返回）
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        *mock.gate.lock().unwrap() = Some((2, gate_rx));

        let handle = std::thread::spawn({
            let shared = MockShared(mock.clone());
            let ids = ids.clone();
            move || {
                batch_extract_colors(ids, "task-cancel".into(), Box::new(shared));
            }
        });

        // 等 worker 请求到第 2 张（在途）再取消
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while mock.seq_len() < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert!(cancel_color_task("task-cancel".into()), "取消在册任务应返回 true");
        drop(mock.gate.lock().unwrap().take()); // 放行在途 read_pixels（rx 随 take 丢弃→recv 断开返回）
        drop(gate_tx);
        handle.join().unwrap();

        let events = mock.events();
        let finished: Vec<&String> = events.iter().filter(|e| e.starts_with("finished:")).collect();
        assert_eq!(finished.len(), 1);
        assert!(finished[0].starts_with("finished:cancelled:"), "终态应 cancelled: {events:?}");
        // 在途 c-2 跑完：done=2、进度两次
        assert!(events.contains(&"progress:2/3".to_string()), "在途一张应完成: {events:?}");
        assert_eq!(events.iter().filter(|e| e.starts_with("progress:")).count(), 2);
        let stats = color_db_stats().unwrap();
        assert_eq!(stats.extracted, 2);
        // 任务结束后注册表已清空 → 控制函数返回 false
        assert!(!cancel_color_task("task-cancel".into()));
        assert!(!pause_color_task("task-cancel".into()));
    }

    /// Arc 共享包装：同一份 MockBatch 既供给 worker（`thread::spawn` 要求 'static 的
    /// Box 回调），又留在测试线程做断言。内部状态全是 Mutex，共享无碍。
    #[derive(Clone)]
    struct MockShared(std::sync::Arc<MockBatch>);
    impl ColorBatchCallback for MockShared {
        fn read_pixels(&self, file_id: String) -> Option<ColorPixels> {
            self.0.read_pixels(file_id)
        }
        fn on_progress(&self, current: u32, total: u32) {
            self.0.on_progress(current, total)
        }
        fn on_file_done(&self, file_id: String, ok: bool, note: String) {
            self.0.on_file_done(file_id, ok, note)
        }
        fn on_finished(&self, state: String, message: String) {
            self.0.on_finished(state, message)
        }
    }

    #[test]
    fn pause_resume_cancel_registry_semantics() {
        let _g = TEST_LOCK.lock().unwrap();
        let ids: Vec<String> = ["p-1", "p-2"].iter().map(|s| s.to_string()).collect();
        let mut pixels = HashMap::new();
        pixels.insert("p-1".to_string(), [255, 0, 0]);
        pixels.insert("p-2".to_string(), [0, 0, 255]);
        init_temp_db("batch-pause");

        let mock = std::sync::Arc::new(MockBatch::new("task-pr", pixels));
        let (gate_tx, gate_rx) = mpsc::channel::<()>();
        *mock.gate.lock().unwrap() = Some((1, gate_rx));

        let handle = std::thread::spawn({
            let shared = MockShared(mock.clone());
            let ids = ids.clone();
            move || {
                batch_extract_colors(ids, "task-pr".into(), Box::new(shared));
            }
        });
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while mock.seq_len() < 1 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }

        // 注册表标志位语义：在册 → true；未知任务 → false
        assert!(!pause_color_task("no-such-task".into()));
        assert!(!resume_color_task("no-such-task".into()));
        assert!(!cancel_color_task("no-such-task".into()));
        assert!(pause_color_task("task-pr".into()), "在册任务可暂停");
        assert!(resume_color_task("task-pr".into()), "在册任务可恢复");
        assert!(cancel_color_task("task-pr".into()), "在册任务可取消（同时清暂停标志）");

        drop(mock.gate.lock().unwrap().take());
        drop(gate_tx);
        handle.join().unwrap();

        let events = mock.events();
        assert!(
            events.iter().any(|e| e.starts_with("finished:cancelled:") && e.contains("1/2")),
            "第 1 张跑完后应 cancelled（1/2）: {events:?}"
        );
        // 结束后任务移出注册表
        assert!(!pause_color_task("task-pr".into()));
        assert!(!resume_color_task("task-pr".into()));
        assert!(!cancel_color_task("task-pr".into()));
    }

    #[test]
    fn retry_delete_and_cleanup_error_files() {
        let _g = TEST_LOCK.lock().unwrap();
        init_temp_db("errors");

        // 造 2 个 error 行 + 1 个不存在的「路径形」error 行（update_status 对不存在行
        // 是 no-op——ghost 必须先经 add_pending_files 建行）
        {
            let pool = color_db_slot().lock().unwrap();
            let pool = pool.as_ref().unwrap();
            let mut conn = pool.get_connection();
            // ghost 用正斜杠构造：add_pending_files 入库会把 \ 归一为 /，而
            // update_status 查询不归一——反斜杠形态永远匹配不上（键语义=file_id，
            // 不含分隔符，此坑只影响测试构造的「路径形」行）
            let ghost = format!(
                "{}/m6b_no_such_dir/ghost.png",
                std::env::temp_dir().to_string_lossy().replace('\\', "/")
            );
            add_pending_files(&mut conn, &["e-1".into(), "e-2".into(), "e-3".into(), ghost.clone()]).unwrap();
            color_db::update_status(&mut conn, "e-1", "error").unwrap();
            color_db::update_status(&mut conn, "e-2", "error").unwrap();
            color_db::update_status(&mut conn, &ghost, "error").unwrap();
        }

        let errs = get_color_error_files().unwrap();
        assert_eq!(errs.len(), 3);
        assert!(errs.iter().all(|e| e.updated_at > 0), "应带 updated_at 时间戳");

        // retry：error → pending（3 条翻回；库内 pending 共 4 行——e-3 本就 pending）
        assert_eq!(retry_color_error_files().unwrap(), 3);
        {
            let pool = color_db_slot().lock().unwrap();
            let pool = pool.as_ref().unwrap();
            let mut conn = pool.get_connection();
            assert_eq!(get_pending_files_count(&mut conn).unwrap(), 4);
        }

        // 再标错后删除：全部清空（ghost 经 retry 已翻回 pending，也要重新标错才进删除集）
        {
            let pool = color_db_slot().lock().unwrap();
            let pool = pool.as_ref().unwrap();
            let mut conn = pool.get_connection();
            for id in ["e-1", "e-2", "e-3"] {
                color_db::update_status(&mut conn, id, "error").unwrap();
            }
            let ghost = format!(
                "{}/m6b_no_such_dir/ghost.png",
                std::env::temp_dir().to_string_lossy().replace('\\', "/")
            );
            color_db::update_status(&mut conn, &ghost, "error").unwrap();
        }
        assert_eq!(delete_color_error_files().unwrap(), 4);
        assert!(get_color_error_files().unwrap().is_empty());
        let stats = color_db_stats().unwrap();
        assert_eq!(stats.total, 0);
        assert_eq!(stats.error, 0);

        // cleanup：只清「路径形且不存在」，保留 file_id 哈希键（Android 语义决定）
        {
            let pool = color_db_slot().lock().unwrap();
            let pool = pool.as_ref().unwrap();
            let mut conn = pool.get_connection();
            add_pending_files(&mut conn, &["hash-like-file-id".into(), "C:/definitely/missing.png".into()]).unwrap();
            color_db::update_status(&mut conn, "hash-like-file-id", "error").unwrap();
            color_db::update_status(&mut conn, "C:/definitely/missing.png", "error").unwrap();
        }
        assert_eq!(cleanup_color_nonexistent().unwrap(), 1, "只应清理路径形且不存在的记录");
        let errs = get_color_error_files().unwrap();
        assert_eq!(errs.len(), 1);
        assert_eq!(errs[0].file_id, "hash-like-file-id");
    }

    #[test]
    fn search_by_color_hits_extracted_file() {
        let _g = TEST_LOCK.lock().unwrap();
        init_temp_db("search");
        extract_and_save_colors("search-red".into(), 32, 32, solid_rgba(32, [255, 0, 0])).expect("提取红色图");

        // 缓存冷 → 索引快路径也应命中刚提取的纯红图
        let hits = search_by_color("#ff0000".to_string()).unwrap();
        assert!(
            hits.iter().any(|h| h == "search-red"),
            "纯红图应命中 #ff0000 搜索: {hits:?}"
        );

        // 无关颜色：不命中（纯红图只有红主色）
        let miss = search_by_color("#0000ff".to_string()).unwrap();
        assert!(!miss.iter().any(|h| h == "search-red"), "纯红图不应命中 #0000ff: {miss:?}");

        // 无有效 hex 入参 → 空结果
        assert!(search_by_palette(vec!["not-a-color".into()]).unwrap().is_empty());
    }
}
