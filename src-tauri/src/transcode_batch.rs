//! 视频 P3 · B 类批量转码队列（2026-10-19，配合 `video_remux` 的 Transcode 档）
//!
//! **为什么要预转而不只是点开现转**：实测 `h264_mf` ~39x 实时（704x396），但一只两小时的
//! 720p VC-1 片仍要十几分钟；remux 一只 1.57GB 的 avi 冷盘上要 45 秒（2026-10-19 真机实测，
//! 其中 33 秒是 faststart 的索引重写 —— 已换成分片 MP4）。真点开才转，手机那头就是
//! 「按下播放键然后等」，与验收人定的原则（下载视频、点开就能看，不许把内部数据问题
//! 变成用户的操作任务）冲突。所以给一条后台队列：一次把库里要命的先做好，之后点开秒开。
//!
//! **收哪些**（判据 [`needs_prescan`]，两条）：
//! - **B 类全收**：容器手机解不动 **且** 编码也解不动（WMV/VC-1、MJPEG）——只能重编；
//! - **A 类只收大的**：容器解不动但编码解得动（Xvid/H.264 装在 AVI 里），remux 秒级无损，
//!   点开时现转本来够用；**GB 级的现转要等几十秒**，所以超过
//!   [`REMUX_PRESCAN_MIN_BYTES`] 的也进队列。小只的不进，免得在盘上多压一份
//!   和原片等大的副本却省不下几秒。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::db::AppDbPool;
use crate::video_remux::{self, EncodeHints, VideoProfile};

/// 队列进度事件名（前端订阅）。
pub const BATCH_EVENT: &str = "video-transcode-batch-progress";

/// 速度估算用的保守倍速：实测 39x（704x396），但分辨率上去会掉，所以按**一半**估，
/// 宁可报久了真提前完成，也别报短了让用户干等。
const EST_REALTIME_FACTOR: f64 = 20.0;

/// A 类（remux）多大才值得预转。实测一只 1.57GB 的 avi 点开现转要 45 秒，
/// 这个等待长度已经不能算「秒开」；小只的 remux 一两秒就完，不值得为它在盘上
/// 常驻一份等大的副本。
const REMUX_PRESCAN_MIN_BYTES: u64 = 500 * 1024 * 1024;

/// 队列里的一只候选。
#[derive(Debug, Clone)]
pub struct Candidate {
    /// 源文件**绝对**路径（`file_index.path` 就是绝对路径，LAN 侧才 strip 成相对）
    pub path: String,
    pub duration_ms: i64,
    pub size: u64,
    /// 走哪只档（B 类 = Transcode，大只 A 类 = Remux）
    pub profile: VideoProfile,
    /// 转码定码率要用的分辨率线索
    pub hints: EncodeHints,
}

/// 该不该进批量队列。见模块头的两条判据。
pub fn needs_prescan(path: &str, codec: Option<&str>, size: u64) -> bool {
    if video_remux::is_android_playable(path) {
        return false;
    }
    match video_remux::pick_profile(codec) {
        // B 类：点开现转要十几分钟，必须预转
        VideoProfile::Transcode => true,
        // A 类：只有大到点开要等几十秒的才预转
        VideoProfile::Remux => size >= REMUX_PRESCAN_MIN_BYTES,
    }
}

/// 扫库拿候选。**必须在一次取锁内查完**：工作线程要是长时间持有 DB 连接，
/// 整个应用的索引读取都会被堵死（`AppDbPool` 内部是单条 `Mutex<Connection>`）。
pub fn scan(pool: &AppDbPool) -> Result<Vec<Candidate>, String> {
    let conn = pool.get_connection();
    let all = aurora_core::db::file_index::get_all_media_files(&conn).map_err(|e| e.to_string())?;
    let mut out: Vec<Candidate> = all
        .into_iter()
        .filter(|e| e.file_type == "Video")
        .filter(|e| needs_prescan(&e.path, e.video_codec.as_deref(), e.size))
        // 该档已有产物的不再排队（重启后重扫天然续跑）
        .filter(|e| {
            video_remux::probe_cached(&e.path, video_remux::pick_profile(e.video_codec.as_deref()))
                .is_none()
        })
        .map(|e| Candidate {
            hints: EncodeHints {
                width: e.width.unwrap_or(0),
                height: e.height.unwrap_or(0),
                fps: e.frame_rate.unwrap_or(0.0),
            },
            profile: video_remux::pick_profile(e.video_codec.as_deref()),
            path: e.path,
            duration_ms: e.duration_ms.unwrap_or(0).max(0),
            size: e.size,
        })
        .collect();
    // 短片排前面：先出一批能播的，进度条也动得快（长片反正都在同一台机器上排队）
    out.sort_by_key(|c| c.duration_ms);
    Ok(out)
}

#[derive(Debug, Default)]
struct Inner {
    total: usize,
    done: usize,
    succeeded: usize,
    failed: usize,
    current: Option<String>,
    current_progress: f32,
    last_error: Option<String>,
}

static STATE: OnceLock<Mutex<Inner>> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn state() -> &'static Mutex<Inner> {
    STATE.get_or_init(Mutex::default)
}

/// 只记一条错误。**取锁与算快照必须分两步**——`snapshot` 自己也锁这把，
/// 非重入 Mutex 持着锁去调它 = 当场死锁（本模块每一处早退都按这个写法）。
fn set_error(msg: &str) {
    state().lock().unwrap().last_error = Some(msg.to_string());
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchStatusDto {
    pub running: bool,
    pub total: usize,
    pub done: usize,
    pub succeeded: usize,
    pub failed: usize,
    /// 当前这一只（绝对路径）与它的 0..1 进度
    pub current: Option<String>,
    pub current_progress: f32,
    pub last_error: Option<String>,
    /// 本次快照的候选数与体积（`total` 在跑起来之后等于候选数）
    pub candidates: usize,
    pub bytes_planned: u64,
    /// 按 [`EST_REALTIME_FACTOR`] 估的分钟数
    pub est_minutes: u32,
    pub ffmpeg_present: bool,
    pub output_dir: Option<String>,
    pub output_bytes: u64,
    pub output_limit_bytes: u64,
}

fn est_minutes_of(items: &[Candidate]) -> u32 {
    let secs: f64 = items
        .iter()
        .map(|c| c.duration_ms.max(0) as f64 / 1000.0)
        .sum();
    (secs / EST_REALTIME_FACTOR / 60.0).ceil() as u32
}

/// 把「资源根」换算成产物目录并设为当前值（幂等）。
///
/// 每个入口都先走这一遍，否则 `snapshot` / `scan` / `probe_cached` 会各算各的目录：
/// 队列还没启动时资源根没被设过，产物目录会回落到 `%LOCALAPPDATA%`（C:，只剩 20GB），
/// 面板报的就是一个不会落盘的地方，而「已有产物没产物」也是按那个错目录判的。
fn apply_root_hint(resource_root: Option<&str>) {
    if let Some(r) = resource_root.filter(|s| !s.trim().is_empty()) {
        video_remux::set_products_dir(&video_remux::products_dir_for_root(r));
    }
}

/// 组装状态快照。
///
/// `scan_when_idle`：**只在空闲时**才现扫候选。工作线程每 400ms 发一次进度，
/// 跟着它去全量查一遍索引是把状态接口当成压力源。空闲时扫一次，面板才能不开队列
/// 就知道「库里还有几只没做」。
fn snapshot(
    pool: Option<&AppDbPool>,
    resource_root: Option<&str>,
    scan_when_idle: bool,
) -> BatchStatusDto {
    apply_root_hint(resource_root);
    let s = state().lock().unwrap();
    // 预算与产物都按档分；面板这一栏统计的是**转码档**（remux 档在「视频播放缓存」那栏）
    let st = video_remux::transcode_stats();
    let (candidates, bytes_planned, est) = if s.total == 0 && scan_when_idle {
        match pool {
            Some(p) => scan(p)
                .map(|v| {
                    (
                        v.len(),
                        v.iter().map(|c| c.size).sum::<u64>(),
                        est_minutes_of(&v),
                    )
                })
                .unwrap_or((0, 0, 0)),
            None => (0, 0, 0),
        }
    } else {
        (s.total, 0, 0)
    };
    BatchStatusDto {
        running: RUNNING.load(Ordering::SeqCst),
        total: s.total,
        done: s.done,
        succeeded: s.succeeded,
        failed: s.failed,
        current: s.current.clone(),
        current_progress: s.current_progress,
        last_error: s.last_error.clone(),
        candidates,
        bytes_planned,
        est_minutes: est,
        ffmpeg_present: crate::ffmpeg_cover::locate().is_some(),
        output_dir: video_remux::products_dir().map(|p| p.to_string_lossy().into_owned()),
        output_bytes: st.bytes,
        output_limit_bytes: st.limit_bytes,
    }
}

fn emit(app: &AppHandle, pool: Option<&AppDbPool>, resource_root: Option<&str>) {
    // 进度事件一律不现扫（见 snapshot 的 scan_when_idle）
    let dto = snapshot(pool, resource_root, false);
    let _ = app.emit(BATCH_EVENT, &dto);
}

/// 起队列。已在跑就原样返回当前快照（**不排第二个线程**——ffmpeg 串行是刻意的：
/// Media Foundation 编码器同机并发会互相抢，且两只一起转会同时吃掉两条预算）。
///
/// `resource_root` 由设置面板带来（前端 `settings.paths.resourceRoot`），
/// 用它算产物目录，与 LAN 侧同一个公式；没带就退回回落目录。
pub fn start(app: AppHandle, pool: AppDbPool, resource_root: Option<String>) -> BatchStatusDto {
    if RUNNING.load(Ordering::SeqCst) {
        return snapshot(Some(&pool), resource_root.as_deref(), true);
    }
    let Some(root) = resource_root.filter(|r| !r.trim().is_empty()) else {
        set_error("no_resource_root");
        return snapshot(Some(&pool), None, true);
    };
    let dir = video_remux::products_dir_for_root(&root);
    if std::fs::create_dir_all(&dir).is_err() {
        set_error(&format!("产物目录创建失败: {}", dir.display()));
        return snapshot(Some(&pool), Some(&root), true);
    }
    video_remux::set_products_dir(&dir);

    let items = match scan(&pool) {
        Ok(v) => v,
        Err(e) => {
            set_error(&e);
            return snapshot(Some(&pool), Some(&root), true);
        }
    };
    if items.is_empty() {
        *state().lock().unwrap() = Inner {
            current_progress: 1.0,
            ..Default::default()
        };
        return snapshot(Some(&pool), Some(&root), true);
    }

    let total = items.len();
    {
        let mut s = state().lock().unwrap();
        *s = Inner {
            total,
            ..Default::default()
        };
    }
    RUNNING.store(true, Ordering::SeqCst);
    CANCEL.store(false, Ordering::SeqCst);
    log::info!("[transcode_batch] 起队列：{} 只候选 -> {}", total, dir.display());
    // 快照在**移交线程之前**取：pool/root 都会被 move 进闭包，返回时点不动它们。
    let started = snapshot(Some(&pool), Some(&root), true);

    std::thread::spawn(move || {
        for c in items {
            if CANCEL.load(Ordering::SeqCst) {
                log::info!("[transcode_batch] 收到停止，剩余不再排");
                break;
            }
            {
                let mut s = state().lock().unwrap();
                s.current = Some(c.path.clone());
                s.current_progress = 0.0;
            }
            emit(&app, Some(&pool), Some(&root));

            let total_us = if c.duration_ms > 0 {
                Some(c.duration_ms as u64 * 1000)
            } else {
                // 库里没记时长（ASF 一类 revelo 整只读不出）：直接问 ffmpeg，进度才有分母
                crate::ffmpeg_cover::probe_duration_ms(&c.path).map(|ms| ms as u64 * 1000)
            };
            let mut last_emit = std::time::Instant::now();
            let app_cb = &app;
            let pool_cb = &pool;
            let root_cb = root.as_str();
            let mut cb = |p: f32| {
                if last_emit.elapsed() < std::time::Duration::from_millis(400) {
                    return;
                }
                last_emit = std::time::Instant::now();
                {
                    let mut s = state().lock().unwrap();
                    s.current_progress = p;
                }
                emit(app_cb, Some(pool_cb), Some(root_cb));
            };
            let dto =
                video_remux::ensure_sync_profile(&c.path, c.profile, total_us, c.hints, Some(&mut cb));
            {
                let mut s = state().lock().unwrap();
                s.done += 1;
                match dto.status {
                    video_remux::RemuxStatus::Ready => s.succeeded += 1,
                    other => {
                        s.failed += 1;
                        log::warn!(
                            "[transcode_batch] {:?} 档 {:?} 失败（{:?}）- {}",
                            c.profile,
                            other,
                            dto.message,
                            c.path
                        );
                        s.last_error = dto.message.clone();
                    }
                }
                s.current_progress = 1.0;
            }
            emit(&app, Some(&pool), Some(&root));
        }
        RUNNING.store(false, Ordering::SeqCst);
        {
            let mut s = state().lock().unwrap();
            s.current = None;
        }
        log::info!("[transcode_batch] 队列结束");
        emit(&app, Some(&pool), Some(&root));
    });

    started
}

/// 请求停止。**当前那只会跑完**（中途 kill ffmpeg 会留下半截 `.tmp`，
/// 虽然有清扫，但比起打断一只已经做了九成的片，这一刀的代价更小）。
pub fn request_stop() -> bool {
    if RUNNING.load(Ordering::SeqCst) {
        CANCEL.store(true, Ordering::SeqCst);
        log::info!("[transcode_batch] 请求停止（等当前这只收尾）");
        return true;
    }
    false
}

// ── Tauri 命令 ───────────────────────────────────────────────────────────

#[tauri::command]
pub fn transcode_batch_status(
    pool: State<AppDbPool>,
    resource_root: Option<String>,
) -> Result<BatchStatusDto, String> {
    Ok(snapshot(Some(pool.inner()), resource_root.as_deref(), true))
}

#[tauri::command]
pub fn transcode_batch_start(
    app: AppHandle,
    pool: State<AppDbPool>,
    resource_root: Option<String>,
) -> Result<BatchStatusDto, String> {
    let pool = pool.inner().clone();
    Ok(start(app, pool, resource_root))
}

#[tauri::command]
pub fn transcode_batch_stop() -> Result<BatchStatusDto, String> {
    request_stop();
    Ok(snapshot(None, None, true))
}

#[tauri::command]
pub async fn transcode_clear_outputs() -> Result<video_remux::RemuxStats, String> {
    Ok(tauri::async_runtime::spawn_blocking(video_remux::clear_transcode_cache)
        .await
        .map_err(|e| e.to_string())?)
}

// ── 单测 ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// 队列收哪些：B 类全收；A 类只收大的；手机本来能解的一律不收。
    #[test]
    fn queue_takes_class_b_and_only_big_class_a() {
        // B 类：ASF（revelo 读不出 = None）与已知解不动的编码，多大都收
        assert!(needs_prescan("F:/x/a.wmv", None, 1_000));
        assert!(needs_prescan("F:/x/a.wmv", Some("WMV3"), 1_000));
        assert!(needs_prescan("F:/x/a.avi", Some("JPEG"), 1_000));
        // A 类：小只不收（点开秒转就够），GB 级才收
        assert!(!needs_prescan("F:/x/a.avi", Some("AVC"), 10 * 1024 * 1024));
        assert!(!needs_prescan(
            "F:/x/a.avi",
            Some("MPEG-4 Visual"),
            REMUX_PRESCAN_MIN_BYTES - 1
        ));
        assert!(needs_prescan(
            "F:/x/a.avi",
            Some("MPEG-4 Visual"),
            REMUX_PRESCAN_MIN_BYTES
        ));
        // 手机本来就能解的容器：一律不进（哪怕里面是解不动的编码 —— 那是另一码事，
        // 走点开时的强制转封装兜底，不在这里预烧磁盘）
        assert!(!needs_prescan("F:/x/a.mkv", Some("WMV3"), 9_000_000_000));
        assert!(!needs_prescan("F:/x/a.mp4", None, 9_000_000_000));
    }

    /// 产物目录公式只有一处：LAN 与桌面算出来必须是同一个。
    #[test]
    fn products_dir_formula_is_the_one_shared_with_lan() {
        let d = video_remux::products_dir_for_root("E:/lib");
        let s = d.to_string_lossy().replace('\\', "/");
        assert!(s.ends_with("/.Aurora_Cache/video-products"), "{}", s);
    }

    /// 估算按一半倍速保守报，且短片排前面。
    #[test]
    fn estimate_is_conservative_and_shorts_first() {
        let mk = |ms: i64, size: u64| Candidate {
            path: "a".into(),
            duration_ms: ms,
            size,
            profile: VideoProfile::Transcode,
            hints: EncodeHints::default(),
        };
        let items = vec![mk(2 * 60 * 60 * 1000, 3_000_000_000), mk(60 * 1000, 100_000_000)];
        // 2 小时 + 1 分钟 ≈ 7260 秒 ÷ 20 ≈ 363 秒 ≈ 7 分钟
        assert_eq!(est_minutes_of(&items), 7);
    }
}
