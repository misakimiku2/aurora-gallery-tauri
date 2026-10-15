//! 视频 P2 · 播放格式兜底（桌面端 remux，2026-10-15）
//!
//! **要解决的问题**：`mkv / avi / flv / ts / 3gp` 等容器在 WebView2 里点开是黑屏 ——
//! 不是因为里面的编码不能解，而是因为**容器**不被认（设计方案 §12.1「A 类」：
//! H.264+AAC 换个包装就能播，比特级无损）。
//!
//! **本期的做法（已拍板，见 `docs/视频P2-播放格式兜底-实施计划-2026-10-15.md` §2）**：
//! 1. **D1** 用 `ffmpeg -c copy` 把源 remux 成 MP4 落在 appdata，再由**既有的 asset 协议**
//!    （`tauri.conf.json` 的 scope = `**`，且自带 Range）喂给 `<video>` —— 零新协议、seek 正常；
//! 2. **D2** 等转封装完成再播（实测 118MB ≈ 1.2s，2.5GB ≈ 15–25s），期间前端显示进度浮层；
//! 3. **D3** 产物持久化 + LRU（默认 4GB 上限），第二次点开秒开；
//! 4. **D4** 音轨三级降级（copy → aac → `-an`），**视频轨全程无损**；
//! 5. **D5** B 类 / 失败 → 错误卡 +「用系统播放器打开」（前端 `open_path`）。
//!
//! **不变量**：
//! - 产物是**真 MP4**，绝不是把源视频路径伪装成可播的来源（记忆 §2.1）；
//! - 原生可解容器（mp4/m4v/mov/webm）**完全不经过本模块** —— 行为零变化；
//! - ffmpeg 缺失时不劣化：返回 Failed + message，回落上一轮已有的降级文案。
//! - spawn 一律走 `ffmpeg_cover` 的既有范式（`stdin(null)` + `as_inner_mut().spawn()`），
//!   避免 P1.5-B v4 踩过的 os error 231。
//!
//! 桌面专属（安卓原生解码通吃，不需要本套 —— 设计方案 §12.5）。

use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use ffmpeg_sidecar::command::FfmpegCommand;
use once_cell::sync::Lazy;
use serde::Serialize;
use tauri::Emitter;

use crate::ffmpeg_cover::locate;

/// 产物封装规则版本 —— **改 `movflags` / 映射规则 / 降级链时必须 +1**，
/// 否则旧产物会被当成有效命中（缓存名只含「源路径+大小+mtime」，不含参数信息）。
pub const REMUX_CACHE_VERSION: u32 = 1;

/// 前端事件名（ImageViewer 订阅，拿 `{path, state}`）。
pub const PROGRESS_EVENT: &str = "video-remux-progress";

/// 缓存占用上限（D3）：超限按 mtime 淘汰最旧产物。
pub const MAX_CACHE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// Chromium / WebView2 原生可解的容器 —— **必须与前端
/// `src/utils/mediaExtensions.ts::WEB_DECODABLE_VIDEO_EXTENSIONS` 保持一致**；
/// 改任一侧都要同步另一侧，否则会出现「前端没走 remux、但容器其实播不了」。
///
/// **依据（2026-10-16 更正）**：chromium.org/audio-video 的官方容器清单 =
/// MP4 / Ogg / WebM / WAV / **Matroska** / HLS；**AVI 不在其中**。
/// 即 **mkv 本来就是原生可播的**（指挥官实机：上一会话 mkv 点开直接播、avi 播不了），
/// 设计方案 §3.3 旧表「mkv Chromium 不支持该容器」是误判（已就地更正）。
/// ⇒ mkv 默认走直播（不再白做一次 1:1 转封装），只有在「直播失败」时才 `force` 转封装。
const DIRECT_PLAYABLE_EXTENSIONS: [&str; 5] = ["mp4", "m4v", "mov", "webm", "mkv"];

/// 超时模型：30s 基础 + 每 10MB 加 1s（remux 是纯拷贝，实测 ~150MB/s；
/// 机械盘 / 冷 IO 场景放宽到 ~10MB/s 的量级），封顶 15 分钟。
const BASE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TIMEOUT: Duration = Duration::from_secs(900);

fn timeout_for(size_bytes: u64) -> Duration {
    let extra = Duration::from_millis((size_bytes / (10 * 1024 * 1024)) * 1000);
    std::cmp::min(BASE_TIMEOUT + extra, MAX_TIMEOUT)
}

// ── 状态与任务表 ─────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum RemuxStatus {
    /// 直接用源文件播（原生可解容器）。
    Direct,
    /// 转封装进行中（前端订阅 `PROGRESS_EVENT` 等结果）。
    Pending,
    /// 就绪：`output_path` 为产物路径（`Direct` 时为 `None`）。
    Ready,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemuxStateDto {
    pub path: String,
    pub status: RemuxStatus,
    /// 0.0–1.0；`Direct` / `Ready` 时为 1.0。
    pub progress: f32,
    /// 产物绝对路径（`Direct` 时 None —— 调用方播源路径）。
    pub output_path: Option<String>,
    /// 失败原因（`Failed` 时有值），前端据此选文案。
    pub message: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RemuxStats {
    pub files: usize,
    pub bytes: u64,
    pub limit_bytes: u64,
}

/// 任务共享态（后台线程更新，命令/事件读取）。
#[derive(Debug)]
struct Shared {
    status: RemuxStatus,
    progress: f32,
    output: Option<PathBuf>,
    message: Option<String>,
}

impl Shared {
    fn dto(&self, path: &str) -> RemuxStateDto {
        RemuxStateDto {
            path: path.to_string(),
            status: self.status,
            progress: self.progress,
            output_path: self.output.as_ref().map(|p| p.to_string_lossy().into_owned()),
            message: self.message.clone(),
        }
    }
}

/// 在途 / 已完成任务表：`源路径 -> 共享态`。
/// 作用是**同路径去并发**（连点/快速 prev-next 不会起多个 ffmpeg 进程），
/// 以及完成后短期内的零成本命中。
static TASKS: Lazy<Mutex<HashMap<String, Arc<Mutex<Shared>>>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

// ── 缓存路径 ─────────────────────────────────────────────────────────────

/// 产物目录（与 ffmpeg 下载副本同级：`%LOCALAPPDATA%\com.aurora.gallery\video-remux`）。
pub fn cache_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        Some(Path::new(&local).join("com.aurora.gallery").join("video-remux"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").ok()?;
        Some(Path::new(&home).join(".local/share/com.aurora.gallery/video-remux"))
    }
}

/// 源身份指纹：`大小 + mtime`（同路径被替换 / 被重新导出时自动失效）。
fn source_fingerprint(path: &str) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(path).ok()?;
    let size = meta.len();
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    Some((size, mtime))
}

/// 产物文件名：`md5(路径|大小|mtime)-v{REMUX_CACHE_VERSION}.mp4`。
pub fn cache_file_name(path: &str) -> Option<String> {
    let (size, mtime) = source_fingerprint(path)?;
    let digest = md5::compute(format!("{}|{}|{}", path, size, mtime));
    Some(format!("{:x}-v{}.mp4", digest, REMUX_CACHE_VERSION))
}

/// 产物绝对路径。
pub fn cache_path_for(path: &str) -> Option<PathBuf> {
    Some(cache_dir()?.join(cache_file_name(path)?))
}

/// **只查缓存、不触发任何转换**（D6① 悬停预览用：没有产物就维持现状，绝不因滚动发起转换）。
pub fn probe_cached(path: &str) -> Option<PathBuf> {
    let out = cache_path_for(path)?;
    if out.is_file() && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        Some(out)
    } else {
        None
    }
}

/// 是否原生可播容器（不过 ffmpeg 这条链路）。
pub fn is_direct_playable(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    let ext = match lower.rsplit('.').next() {
        Some(e) => e,
        None => return false,
    };
    DIRECT_PLAYABLE_EXTENSIONS.contains(&ext)
}

// ── 转封装执行 ───────────────────────────────────────────────────────────

/// 音轨降级链（D4）：视频轨全程 `-c copy`（无损），只有音轨逐级退让。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AudioTier {
    /// 原样拷贝（aac/mp3 等 MP4 装得下的编码 → 零开销）。
    Copy,
    /// 用 ffmpeg 内建 AAC 编码器重编码（LGPL 变体内建，不碰 GPL 编码器）。
    Aac,
    /// 丢音轨（最后兜底：宁可无声也要能播）。
    None,
}

impl AudioTier {
    fn args(self) -> Vec<&'static str> {
        match self {
            AudioTier::Copy => vec!["-c:a", "copy"],
            AudioTier::Aac => vec!["-c:a", "aac", "-b:a", "192k"],
            AudioTier::None => vec!["-an"],
        }
    }
    fn next(self) -> Option<AudioTier> {
        match self {
            AudioTier::Copy => Some(AudioTier::Aac),
            AudioTier::Aac => Some(AudioTier::None),
            AudioTier::None => None,
        }
    }
}

/// 单次 remux 调用：`-c:v copy` + 当前音轨档 → 产物写**临时路径**（成功再 rename）。
///
/// * `on_progress`：以 0.0–1.0 回调当前进度（由 `-progress pipe:1` 的 `out_time_us` 换算）。
/// * `-map 0:v:0 -map 0:a:0?`：只取第一条视频轨与第一条音轨 —— **字幕/附件一律丢弃**
///   （mkv 常内嵌 mjpeg 封面附件，带进 MP4 会因容器装不下而直接报错）。
fn remux_once(
    ffmpeg: &Path,
    input: &str,
    tmp_output: &Path,
    audio_args: &[&'static str],
    timeout: Duration,
    on_progress: &mut dyn FnMut(f32),
) -> Result<(), String>
{
    let mut cmd = FfmpegCommand::new_with_path(ffmpeg);
    cmd.args(["-y", "-loglevel", "error", "-nostats"])
        .args(["-progress", "pipe:1"])
        .arg("-i")
        .arg(input)
        .args(["-map", "0:v:0"])
        .args(["-map", "0:a:0?"])
        .args(["-c:v", "copy"])
        .args(audio_args)
        .args(["-map_metadata", "0"])
        // faststart：moov 索引移到文件头 —— 产物总是完整后才交给播放器，
        // head 里有索引意味着 seek 立即生效，不必等播放器把整个文件读到最后。
        .args(["-movflags", "+faststart"])
        // ⚠️ 必须显式 `-f mp4`：产物先写成 `.mp4.tmp`（半成品后缀），ffmpeg 只认扩展名
        // 时会对 `.tmp` 报 "Unable to choose an output format ... Invalid argument"
        // ——本次集成测试实锤（2026-10-15）。显式声明格式后任意后缀都可用。
        .args(["-f", "mp4"])
        .arg(tmp_output);

    // spawn 范式复用 ffmpeg_cover：stdin 置 null + 原生 Child（os error 231 规避）。
    cmd.as_inner_mut().stdin(std::process::Stdio::null());
    let mut child: std::process::Child = cmd
        .as_inner_mut()
        .spawn()
        .map_err(|e| format!("ffmpeg 启动失败: {}", e))?;

    // stdout 承载 `-progress pipe:1` 输出，必须排干（管道写满会与 ffmpeg 互锁）。
    let stdout = child.stdout.take();
    let started = Instant::now();
    let reader = stdout.map(|out| {
        std::thread::spawn(move || {
            let mut last = String::new();
            let mut reader = BufReader::new(out);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if let Some(v) = line.trim().strip_prefix("out_time_us=") {
                            last = v.to_string();
                        }
                    }
                }
            }
            last
        })
    });
    // stderr 承载 `-loglevel error`，同样要排干（虽然量很小）。
    let stderr = child.stderr.take();
    let stderr_reader = stderr.map(|mut err| {
        std::thread::spawn(move || {
            let mut s = String::new();
            let _ = std::io::Read::read_to_string(&mut err, &mut s);
            s
        })
    });

    // 等进程结束：轮询 + 超时 kill。进度靠**产物文件大小 / 源大小**估算（remux 前后体积
    // 同量级），比解析 stdout 更稳 —— stdout 线程的作用只是把管道排干防互锁。
    let poll_source_size = std::fs::metadata(input).map(|m| m.len()).ok();
    let mut last_progress = 0.0f32;
    let status = loop {
        match child.try_wait() {
            Ok(Some(st)) => break Some(st),
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err("转封装超时".to_string());
                }
                // 进度：产物大小 / 源大小（remux 前后体积基本同量级），夹在 [0, 0.99]。
                if let Some(src) = poll_source_size {
                    if src > 0 {
                        let cur = std::fs::metadata(tmp_output).map(|m| m.len()).unwrap_or(0);
                        let p = (cur as f64 / src as f64).clamp(0.0, 0.99) as f32;
                        if p > last_progress {
                            last_progress = p;
                            on_progress(p);
                        }
                    }
                }
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(e) => return Err(format!("等待 ffmpeg 失败: {}", e)),
        }
    };

    // 收尾：先收 stdout/stderr，再判退出码（避免管道未读完导致误判）。
    let _ = reader.and_then(|h| h.join().ok());
    let err_text = stderr_reader
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    match status {
        Some(st) if st.success() => {
            // 空产物 = 静默失败（ffmpeg 有时 0 退出但没写东西）。
            let size = std::fs::metadata(tmp_output).map(|m| m.len()).unwrap_or(0);
            if size == 0 {
                Err(format!("ffmpeg 未写出产物: {}", truncate_err(&err_text)))
            } else {
                Ok(())
            }
        }
        Some(_) => Err(truncate_err(&err_text)),
        None => Err("ffmpeg 进程状态未知".to_string()),
    }
}

fn truncate_err(text: &str) -> String {
    let t = text.trim();
    if t.is_empty() {
        return "未知错误".to_string();
    }
    // 只保留最后一行（ffmpeg 的错误结论通常在末尾），并限长避免污染 UI。
    let last = t.lines().last().unwrap_or(t);
    let mut s: String = last.chars().take(200).collect();
    if last.chars().count() > 200 {
        s.push('…');
    }
    s
}

/// 清理半成品：`.tmp` 超过 6 小时视为残留（进程被打断的产物）。
fn sweep_tmp_files(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if !name.ends_with(".tmp") {
            continue;
        }
        let stale = e
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| now.saturating_sub(d.as_secs()) > 6 * 3600)
            .unwrap_or(false);
        if stale {
            let _ = std::fs::remove_file(e.path());
            log::info!("[video_remux] 清理残留半成品 - {}", name);
        }
    }
}

/// LRU 淘汰：总占用超上限时按 mtime 从旧到新删。
fn trim_cache(dir: &Path, limit: u64) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut items: Vec<(u64, u64, PathBuf)> = Vec::new();
    let mut total = 0u64;
    for e in entries.flatten() {
        let Ok(meta) = e.metadata() else { continue };
        if !meta.is_file() {
            continue;
        }
        let mtime = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
            .map(|d| d.as_secs())
            .unwrap_or(0);
        total += meta.len();
        items.push((mtime, meta.len(), e.path()));
    }
    if total <= limit {
        return;
    }
    items.sort_by_key(|(mtime, _, _)| *mtime);
    let mut freed = 0u64;
    for (_, size, path) in items {
        if total.saturating_sub(freed) <= limit {
            break;
        }
        if std::fs::remove_file(&path).is_ok() {
            freed += size;
            log::info!(
                "[video_remux] LRU 淘汰 {}KB - {}",
                size / 1024,
                path.file_name().unwrap_or_default().to_string_lossy()
            );
        }
    }
}

// ── 对外：确保产物就绪 ───────────────────────────────────────────────────

/// 同步版本（无进度回调）：供单测与「不需要进度」的场景使用。
pub fn ensure_sync(path: &str) -> RemuxStateDto {
    ensure_sync_inner(path, false, None::<&mut dyn FnMut(f32)>)
}

/// 同步版本 + **强制转封装**（跳过「原生可解 → 直播」分支）。
/// 用途：mkv 等原生容器**直播失败**（里面的编码/音轨不被支持）时的兜底一次尝试。
pub fn ensure_sync_force(path: &str) -> RemuxStateDto {
    ensure_sync_inner(path, true, None::<&mut dyn FnMut(f32)>)
}

/// 同步版本（带进度回调）：确保产物存在，返回最终状态。
/// - `force = true`：连原生可解容器也重新封装（直播失败后的兜底）；
/// - `on_progress`：收到 0.0–1.0 的实时进度（节流由调用方负责）。
pub fn ensure_sync_inner<'a>(
    path: &str,
    force: bool,
    mut on_progress: Option<&'a mut dyn FnMut(f32)>,
) -> RemuxStateDto {
    if !force && is_direct_playable(path) {
        return RemuxStateDto {
            path: path.to_string(),
            status: RemuxStatus::Direct,
            progress: 1.0,
            output_path: None,
            message: None,
        };
    }
    if let Some(cached) = probe_cached(path) {
        return RemuxStateDto {
            path: path.to_string(),
            status: RemuxStatus::Ready,
            progress: 1.0,
            output_path: Some(cached.to_string_lossy().into_owned()),
            message: None,
        };
    }

    let Some((ffmpeg, _source)) = locate() else {
        return RemuxStateDto {
            path: path.to_string(),
            status: RemuxStatus::Failed,
            progress: 0.0,
            output_path: None,
            message: Some("no_ffmpeg".to_string()),
        };
    };
    let Some(dir) = cache_dir() else {
        return failed(path, "cache_dir_unavailable");
    };
    if !dir.exists() && crate::file_operations::ensure_aurora_cache_dir(dir.to_str().unwrap_or("")).is_err()
    {
        return failed(path, "cache_dir_unavailable");
    }
    sweep_tmp_files(&dir);

    let Some(out) = cache_path_for(path) else {
        return failed(path, "stat_failed");
    };
    let tmp = out.with_extension("mp4.tmp");
    let _ = std::fs::remove_file(&tmp);

    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let timeout = timeout_for(size);

    let mut tier = AudioTier::Copy;
    loop {
        // 每档重来都会重新写 tmp，进度从 0 起算（若调用方没传回调就走 no-op）。
        let mut no_op = |_p: f32| {};
        let progress_cb: &mut dyn FnMut(f32) = match on_progress.as_mut() {
            Some(f) => &mut **f,
            None => &mut no_op,
        };
        let audio_args = tier.args();
        match remux_once(&ffmpeg, path, &tmp, &audio_args, timeout, progress_cb) {
            Ok(()) => {
                // 原子可见：只有完整产物才会出现在最终文件名上（避免中途被读到半截 MP4）。
                if std::fs::rename(&tmp, &out).is_err() {
                    // rename 失败常见于目标已存在（并发写同一 file），此时以已存在的为准。
                    if !out.is_file() {
                        let _ = std::fs::remove_file(&tmp);
                        return failed(path, "rename_failed");
                    }
                }
                // 更新 mtime 供 LRU 排序。
                let _ = std::fs::File::open(&out);
                trim_cache(&dir, MAX_CACHE_BYTES);
                log::info!(
                    "[video_remux] 完成 {:?} 档 {:?} -> {}",
                    tier,
                    timeout,
                    out.display()
                );
                return RemuxStateDto {
                    path: path.to_string(),
                    status: RemuxStatus::Ready,
                    progress: 1.0,
                    output_path: Some(out.to_string_lossy().into_owned()),
                    message: None,
                };
            }
            Err(e) => match tier.next() {
                Some(next) => {
                    log::warn!(
                        "[video_remux] {:?} 档失败（{}），降级到 {:?} - {}",
                        tier,
                        e,
                        next,
                        path
                    );
                    tier = next;
                    let _ = std::fs::remove_file(&tmp);
                }
                None => {
                    let _ = std::fs::remove_file(&tmp);
                    log::warn!("[video_remux] 三级降级全部失败（{}） - {}", e, path);
                    return RemuxStateDto {
                        path: path.to_string(),
                        status: RemuxStatus::Failed,
                        progress: 0.0,
                        output_path: None,
                        message: Some(e),
                    };
                }
            },
        }
    }
}

fn failed(path: &str, reason: &str) -> RemuxStateDto {
    RemuxStateDto {
        path: path.to_string(),
        status: RemuxStatus::Failed,
        progress: 0.0,
        output_path: None,
        message: Some(reason.to_string()),
    }
}

/// 命令版本：命中缓存直接返回，否则**后台转封装**并立刻返回 `Pending`；
/// 进度与完成通过 `PROGRESS_EVENT` 推送（前端据此换 src）。
/// `force`：见 [`ensure_sync_force`]——原生容器直播失败后的兜底。
pub fn ensure_async(app: tauri::AppHandle, path: String, force: bool) -> RemuxStateDto {
    // 原生可解 / 缓存命中 / 失败：三条都不需要后台任务。
    if !force && is_direct_playable(&path) {
        return RemuxStateDto {
            path: path.clone(),
            status: RemuxStatus::Direct,
            progress: 1.0,
            output_path: None,
            message: None,
        };
    }
    if let Some(cached) = probe_cached(&path) {
        return RemuxStateDto {
            path: path.clone(),
            status: RemuxStatus::Ready,
            progress: 1.0,
            output_path: Some(cached.to_string_lossy().into_owned()),
            message: None,
        };
    }

    // 同路径去并发：已在转换的任务直接返回当前快照。
    {
        let tasks = TASKS.lock().unwrap();
        if let Some(shared) = tasks.get(&path) {
            let s = shared.lock().unwrap();
            return s.dto(&path);
        }
    }

    let Some((_ffmpeg, _)) = locate() else {
        return failed(&path, "no_ffmpeg");
    };

    let shared = Arc::new(Mutex::new(Shared {
        status: RemuxStatus::Pending,
        progress: 0.0,
        output: None,
        message: None,
    }));
    {
        let mut tasks = TASKS.lock().unwrap();
        tasks.insert(path.clone(), Arc::clone(&shared));
    }

    let shared_bg = Arc::clone(&shared);
    let path_bg = path.clone();
    std::thread::spawn(move || {
        // 中间进度：200ms 节流（ffmpeg 每几十毫秒就有一次 size 变化，原样透传会刷屏）。
        let mut last_emit = Instant::now();
        let mut emit_cb = |p: f32| {
            let now = Instant::now();
            if now.duration_since(last_emit) < Duration::from_millis(200) {
                return;
            }
            last_emit = now;
            let snap = RemuxStateDto {
                path: path_bg.clone(),
                status: RemuxStatus::Pending,
                progress: p,
                output_path: None,
                message: None,
            };
            let _ = app.emit(PROGRESS_EVENT, &snap);
        };
        let result = ensure_sync_inner(&path_bg, force, Some(&mut emit_cb));
        {
            let mut s = shared_bg.lock().unwrap();
            s.status = result.status;
            s.progress = result.progress;
            s.output = result.output_path.as_ref().map(PathBuf::from);
            s.message = result.message.clone();
        }
        let _ = app.emit(PROGRESS_EVENT, &result);
    });

    RemuxStateDto {
        path,
        status: RemuxStatus::Pending,
        progress: 0.0,
        output_path: None,
        message: None,
    }
}

/// 统计产物占用（设置面板显示 + 清理入口）。
pub fn stats() -> RemuxStats {
    let mut files = 0usize;
    let mut bytes = 0u64;
    if let Some(dir) = cache_dir() {
        if let Ok(entries) = std::fs::read_dir(&dir) {
            for e in entries.flatten() {
                if let Ok(meta) = e.metadata() {
                    if meta.is_file() {
                        files += 1;
                        bytes += meta.len();
                    }
                }
            }
        }
    }
    RemuxStats {
        files,
        bytes,
        limit_bytes: MAX_CACHE_BYTES,
    }
}

/// 清空产物（并重置任务表 —— 清理后需要能重新生成）。
pub fn clear_cache() -> RemuxStats {
    if let Some(dir) = cache_dir() {
        let _ = std::fs::remove_dir_all(&dir);
        let _ = std::fs::create_dir_all(&dir);
    }
    let mut tasks = TASKS.lock().unwrap();
    tasks.clear();
    stats()
}

// ── Tauri 命令 ───────────────────────────────────────────────────────────

/// 确保可播：`Direct` → 播源；`Pending` → 等事件；`Ready` → 播产物；`Failed` → 降级 UI。
///
/// `force`：原生容器（如 mkv）**直播失败**后由前端带上，强制走转封装兜底一次。
#[tauri::command]
pub async fn video_remux_ensure(
    app: tauri::AppHandle,
    path: String,
    force: Option<bool>,
) -> Result<RemuxStateDto, String> {
    let force = force.unwrap_or(false);
    // 整个判定流程是同步阻塞的（只有 ensure_sync 内部 spawn 除外），
    // 放到阻塞线程池执行，避免压住异步运行时。
    tauri::async_runtime::spawn_blocking(move || ensure_async(app, path, force))
        .await
        .map_err(|e| e.to_string())
}

/// 只查缓存（悬停预览用，绝不触发转换）。
#[tauri::command]
pub async fn video_remux_probe(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        probe_cached(&path).map(|p| p.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn video_remux_stats() -> Result<RemuxStats, String> {
    Ok(stats())
}

#[tauri::command]
pub async fn video_remux_clear() -> Result<RemuxStats, String> {
    Ok(clear_cache())
}

// ── 单测 ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn direct_playable_matches_frontend_list() {
        // 必须与 src/utils/mediaExtensions.ts::WEB_DECODABLE_VIDEO_EXTENSIONS 一致
        // （2026-10-16 更正：mkv = Matroska 属 Chromium 官方容器清单 → 原生可播）
        for ext in ["mp4", "m4v", "mov", "webm", "mkv"] {
            assert!(is_direct_playable(&format!("C:/x/video.{}", ext)), "{}", ext);
            assert!(is_direct_playable(&format!("C:/x/VIDEO.{}", ext.to_uppercase())));
        }
        for ext in ["avi", "flv", "wmv", "mpg", "mpeg", "3gp", "ts"] {
            assert!(!is_direct_playable(&format!("C:/x/video.{}", ext)), "{}", ext);
        }
        assert!(!is_direct_playable("C:/x/video"));
    }

    #[test]
    fn cache_name_is_stable_and_versioned() {
        // 同一身份（路径+大小+mtime）→ 同名；版本号进入文件名
        let p = "../log/SVID_20261006_213438_1.avi";
        if source_fingerprint(p).is_none() {
            eprintln!("[skip] 样本缺失");
            return;
        }
        let a = cache_file_name(p).unwrap();
        let b = cache_file_name(p).unwrap();
        assert_eq!(a, b);
        assert!(a.ends_with(&format!("-v{}.mp4", REMUX_CACHE_VERSION)), "{}", a);
        assert!(a.len() > REMUX_CACHE_VERSION.to_string().len() + 8);
    }

    #[test]
    fn timeout_model_grows_with_size() {
        assert_eq!(timeout_for(0), BASE_TIMEOUT);
        assert!(timeout_for(200 * 1024 * 1024) > timeout_for(10 * 1024 * 1024));
        assert!(timeout_for(1024 * 1024 * 1024 * 1024) <= MAX_TIMEOUT);
    }

    #[test]
    fn audio_tier_chain_is_copy_then_aac_then_none() {
        let mut t = AudioTier::Copy;
        assert_eq!(t, AudioTier::Copy);
        t = t.next().unwrap();
        assert_eq!(t, AudioTier::Aac);
        t = t.next().unwrap();
        assert_eq!(t, AudioTier::None);
        assert!(t.next().is_none());
        // 降级链不能出现非 `-c:v copy`（视频轨必须全程无损）
        assert!(AudioTier::Aac.args().contains(&"-c:a"));
        assert!(!AudioTier::Aac.args().contains(&"-c:v"));
    }

    /// 集成测试：真实 ffmpeg + `log/` 样本，验证 A 类容器 remux 成功且产物有效。
    /// 用 `ensure_sync_force`（强制转封装）—— mkv 自 2026-10-16 起默认走直播，
    /// 不 force 的话 mkv 样本根本不会进这条链路。
    #[test]
    fn remux_real_samples_when_ffmpeg_present() {
        let Some((_ffmpeg, _)) = locate() else {
            eprintln!("[skip] 本机无 ffmpeg，跳过 remux 集成测试");
            return;
        };
        let samples = [
            "../log/GameEX-A.avi",
            "../log/GameEX-B.mkv",
            "../log/SVID_20261006_213438_1.avi",
        ];
        for s in samples {
            if !Path::new(s).exists() {
                eprintln!("[skip] 样本缺失: {}", s);
                continue;
            }
            let started = Instant::now();
            let dto = ensure_sync_force(s);
            println!(
                "[remux] {} -> {:?} {:?} msg={:?}",
                s,
                dto.status,
                started.elapsed(),
                dto.message
            );
            assert_eq!(
                dto.status,
                RemuxStatus::Ready,
                "remux 应成功: {} msg={:?}",
                s,
                dto.message
            );
            let out = dto.output_path.expect("应返回产物路径");
            let out_size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
            let src_size = std::fs::metadata(s).map(|m| m.len()).unwrap_or(0);
            // remux 是纯拷贝：体积应与源同量级（±10%，差异来自容器头/索引）
            let ratio = out_size as f64 / src_size.max(1) as f64;
            assert!(
                (0.9..=1.1).contains(&ratio),
                "产物体积偏离源太多: {} ({} vs {})",
                s,
                out_size,
                src_size
            );
            // 二次调用必须命中缓存（不重转）
            let again = ensure_sync_force(s);
            assert_eq!(again.status, RemuxStatus::Ready);
            assert_eq!(again.output_path.as_deref(), Some(out.as_str()));
        }
    }

    /// 原生可解容器必须走 Direct（不得被 remux 污染）—— **含 mkv**（2026-10-16）。
    #[test]
    fn native_container_never_goes_through_remux() {
        for s in [
            "../log/SVID_20261007_002550_1.mp4",
            "../log/GameEX-B.mkv",
            "../log/SVID_20261006_212831_1.mkv",
        ] {
            if !Path::new(s).exists() {
                eprintln!("[skip] 样本缺失: {}", s);
                continue;
            }
            let dto = ensure_sync(s);
            assert_eq!(dto.status, RemuxStatus::Direct, "{} 应走直播", s);
            assert!(dto.output_path.is_none());
            // 但 force 时仍要能转封装（直播失败的兜底通道）
            let forced = ensure_sync_force(s);
            assert_eq!(forced.status, RemuxStatus::Ready, "{} force 应产出", s);
            assert!(forced.output_path.is_some());
        }
    }
}
