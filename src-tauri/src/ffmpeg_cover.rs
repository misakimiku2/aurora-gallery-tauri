//! 视频封面 ffmpeg 管线（P1.5-B，桌面专属）。
//!
//! 决策依据：`docs/视频P1.5-B-实施计划-2026-10-14.md` §2（D0–D4 已拍板）。
//! - **D0=B**：ffmpeg 可用时**所有视频**（含 mp4/m4v/mov/webm）都走本模块抽帧；
//!   前端 canvas 抓帧（`videoCover.ts`）降级为「无 ffmpeg 时的兜底」。
//! - **D2**：逐候选 `-ss`（输入侧 seek）+ Rust 择优 + 早退——与前端是**同一份文字规格**
//!   的两端实现（常量、公式、抽样口径全部一致；跨语言对照用例见本模块 tests 与
//!   `src/utils/__tests__/videoCover.spec.ts`）。
//! - **D1/D1b**：ffmpeg 缺失时的下载器单独实现（BtbN **LGPL** 构建，S4），
//!   本模块只负责「找到 ffmpeg → 用它」，绝不触碰 `ffmpeg_sidecar::auto_download()`
//!   （其默认源是 gyan.dev 的 **GPLv3** 构建）。
//!
//! ⚠️ 选帧算法变更必须两端同步（本文件 ↔ `src/utils/videoCover.ts`），
//! 并 +1 `thumbnail.rs` 的 `VIDEO_COVER_CACHE_VERSION`（缓存名不含算法信息，
//! 不升版本则老封面永不重抽）。

use std::io::{Read, BufRead};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use ffmpeg_sidecar::command::FfmpegCommand;
use serde::Serialize;

// ── 选帧算法常量（与前端 videoCover.ts 逐一同名同值，两端同步改动）──────────

/// 候选抽帧时间点（占时长的比例）。首帧常为片头/黑场，从 10% 起步。
pub(crate) const SEEK_FRACTIONS: [f64; 6] = [0.1, 0.25, 0.4, 0.55, 0.7, 0.85];
/// 平均亮度达到此值即认为「够亮」，停止继续采样（省 seek / 省 spawn）。
pub(crate) const GOOD_LUMA: f64 = 85.0;
/// 打分时亮度封顶：避免「纯白闪过帧」压过有内容的亮帧。
pub(crate) const SCORE_LUMA_CAP: f64 = 160.0;
/// 鲜艳度加权系数。
pub(crate) const SCORE_SAT_WEIGHT: f64 = 0.5;
/// 封面目标尺寸（短边缩到此值，与前端 TARGET_SIZE / 图片缩略图同口径）。
const TARGET_SIZE: u32 = 256;
/// 体积感知超时（与前端 timeoutFor 同款）：基础 20s + 每 100MB +1s，封顶 120s。
const DEFAULT_TIMEOUT_MS: u64 = 20_000;
const MAX_TIMEOUT_MS: u64 = 120_000;

// ── 定位 ──────────────────────────────────────────────────────────────────

/// ffmpeg 来源。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FfmpegSource {
    /// 系统 PATH 上的 ffmpeg（指挥官约定：系统有就直接用系统的）。
    System,
    /// 本应用下载的副本（S4 下载器落盘到 `%LOCALAPPDATA%\com.aurora.gallery\ffmpeg`）。
    Downloaded,
}

impl FfmpegSource {
    pub fn as_str(self) -> &'static str {
        match self {
            FfmpegSource::System => "system",
            FfmpegSource::Downloaded => "downloaded",
        }
    }
}

/// 本应用下载副本的预期落点（与 S4 下载器共用，**绝不能**指向 Program Files——UAC 拦截）。
pub fn downloaded_ffmpeg_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        Some(
            Path::new(&local)
                .join("com.aurora.gallery")
                .join("ffmpeg")
                .join("ffmpeg.exe"),
        )
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").ok()?;
        Some(
            Path::new(&home)
                .join(".local/share/com.aurora.gallery/ffmpeg/ffmpeg"),
        )
    }
}

/// 系统 PATH 上的 ffmpeg 路径。Windows 用 `where.exe`（只认 .exe；.bat shim 由
/// CreateProcess 语义问题跳过），其余平台用 `which`。
/// 子进程一律 CREATE_NO_WINDOW——GUI 应用里启动控制台程序会闪黑窗。
fn system_ffmpeg_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let output = std::process::Command::new("where.exe")
            .arg("ffmpeg")
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let p = PathBuf::from(line);
            if p.extension().and_then(|e| e.to_str()).map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false)
                && p.is_file()
            {
                return Some(p);
            }
        }
        None
    }
    #[cfg(not(target_os = "windows"))]
    {
        let output = std::process::Command::new("which")
            .arg("ffmpeg")
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let text = String::from_utf8_lossy(&output.stdout);
        let line = text.lines().next()?.trim();
        if line.is_empty() {
            return None;
        }
        let p = PathBuf::from(line);
        if p.is_file() {
            Some(p)
        } else {
            None
        }
    }
}

/// ffmpeg 定位（纯路径检查，不 spawn）：① 系统 PATH → ② 已下载副本 → None。
pub fn locate() -> Option<(PathBuf, FfmpegSource)> {
    if let Some(p) = system_ffmpeg_path() {
        return Some((p, FfmpegSource::System));
    }
    if let Some(p) = downloaded_ffmpeg_path() {
        if p.is_file() {
            return Some((p, FfmpegSource::Downloaded));
        }
    }
    None
}

/// 跑 `ffmpeg -version`，返回 stdout 首行（如 `ffmpeg version n7.1-latest_lgpl...`）。
/// FfmpegCommand 构造时已自动 `create_no_window()`，GUI 下不闪黑窗。
pub fn probe_version(ffmpeg: &Path) -> Option<String> {
    let mut cmd = FfmpegCommand::new_with_path(ffmpeg);
    cmd.arg("-version");
    // ⚠️ spawn 细节（2026-10-14 沙箱实测踩坑）：
    // FfmpegCommand 构造强制 stdin/stdout/stderr 三管道，且 `spawn()` 返回的
    // FfmpegChild::from_inner 会 assert 三通道全 piped；而「子进程 stdin 匿名管道」
    // 在受限环境（WorkBuddy 沙箱）创建即报 os error 231（`所有管道范例都在使用中`）。
    // 处理：stdin 置 null + 用 `as_inner_mut().spawn()` 走原生 std::process::Child
    //（no_window 的 creation_flags 在构造时已打上，不受影响）。
    cmd.as_inner_mut().stdin(std::process::Stdio::null());
    let mut child = cmd.as_inner_mut().spawn().ok()?;
    let stdout = child.stdout.take()?;
    let mut first_line = String::new();
    let read_ok = std::io::BufReader::new(stdout)
        .read_line(&mut first_line)
        .map(|n| n > 0)
        .unwrap_or(false);
    let _ = child.wait();
    if read_ok {
        let trimmed = first_line.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    } else {
        None
    }
}

/// 设置面板用的三态状态（S1）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegStatus {
    pub available: bool,
    /// "system" | "downloaded"；不可用时为 null。
    pub source: Option<&'static str>,
    pub path: Option<String>,
    /// `ffmpeg -version` 的首行；不可用时为 null。
    pub version: Option<String>,
}

pub fn detect_status() -> FfmpegStatus {
    match locate() {
        Some((path, source)) => {
            let version = probe_version(&path);
            FfmpegStatus {
                available: version.is_some(),
                source: Some(source.as_str()),
                path: Some(path.to_string_lossy().into_owned()),
                version,
            }
        }
        None => FfmpegStatus {
            available: false,
            source: None,
            path: None,
            version: None,
        },
    }
}

// ── 选帧算法（与前端 videoCover.ts 同规格；改这里必须同步改前端）────────────

/// 生成候选抽帧时间点（秒）：按 `SEEK_FRACTIONS` 铺开，接近片尾时收敛到 safe end，
/// 并按毫秒去重（极短视频的多个比例可能落到同一毫秒）。
pub(crate) fn seek_candidates(duration: f64) -> Vec<f64> {
    let safe_end = (duration - 0.05).max(0.0);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for &f in SEEK_FRACTIONS.iter() {
        let t = (duration * f).min(safe_end);
        let key = (t * 1000.0).round() as i64;
        if seen.insert(key) {
            out.push(t);
        }
    }
    out
}

/// 候选帧打分：越亮越好，其次越鲜艳越好。与前端 `frameScore` 同公式。
pub(crate) fn frame_score(luma: f64, colorfulness: f64) -> f64 {
    luma.min(SCORE_LUMA_CAP) + colorfulness * SCORE_SAT_WEIGHT
}

/// 平均亮度（0~255）：`0.299R + 0.587G + 0.114B`，**每 4 像素抽 1 样**。
///
/// 与前端 `dominantColors.averageLuma` 同一口径：TS 输入是 RGBA（步长 16 字节），
/// 这里输入是 RGB8（步长 12 字节）——被抽样的像素序号同为 0,4,8,…，数学等价。
pub(crate) fn rgb_luma(rgb: &[u8]) -> f64 {
    let mut sum = 0.0f64;
    let mut n = 0usize;
    let mut i = 0usize;
    while i + 2 < rgb.len() {
        sum += rgb[i] as f64 * 0.299 + rgb[i + 1] as f64 * 0.587 + rgb[i + 2] as f64 * 0.114;
        n += 1;
        i += 4 * 3;
    }
    if n == 0 {
        0.0
    } else {
        sum / n as f64
    }
}

/// 平均鲜艳度（0~255）：每像素 `max(R,G,B) − min(R,G,B)` 的均值，每 4 像素抽 1 样。
/// 与前端 `dominantColors.averageColorfulness` 同口径（抽样等价性同上）。
pub(crate) fn rgb_colorfulness(rgb: &[u8]) -> f64 {
    let mut sum = 0.0f64;
    let mut n = 0usize;
    let mut i = 0usize;
    while i + 2 < rgb.len() {
        let (r, g, b) = (rgb[i], rgb[i + 1], rgb[i + 2]);
        let mx = r.max(g).max(b);
        let mn = r.min(g).min(b);
        sum += (mx - mn) as f64;
        n += 1;
        i += 4 * 3;
    }
    if n == 0 {
        0.0
    } else {
        sum / n as f64
    }
}

/// 目标尺寸：短边缩到 256，另一边按比例四舍五入（与前端 drawImage 前的尺寸计算一致）。
fn target_size_256(src_w: u32, src_h: u32) -> (u32, u32) {
    if src_w < src_h {
        (
            TARGET_SIZE,
            ((src_h as f64 * TARGET_SIZE as f64) / src_w as f64).round() as u32,
        )
    } else {
        (
            ((src_w as f64 * TARGET_SIZE as f64) / src_h as f64).round() as u32,
            TARGET_SIZE,
        )
    }
}

// ── 时长健全性（S6 实测发现：revelo 对 AVI+AVC 的 duration 误报）─────────────

/// revelo 时长可疑阈值：时长 <1s 但文件 >1MB（正常 <1s 视频极少有 >1MB）。
const SUSPICIOUS_DURATION_SECS: f64 = 1.0;
const SUSPICIOUS_SIZE_BYTES: u64 = 1_000_000;

/// 解析 `ffmpeg -i` stderr 里的 `Duration: 00:00:09.30` 行（秒）。
/// ⚠️ 行首可能带 `[info]` 前缀（FfmpegCommand 构造自动 `-loglevel level+info`），
/// 所以用「包含 Duration:」匹配、取其后文本；行尾还带其它字段（`, start: ...`），
/// 逐段截取到非数字为止。
fn parse_ffmpeg_duration_line(stderr: &str) -> Option<f64> {
    let line = stderr.lines().find(|l| l.contains("Duration:"))?;
    let t = line
        .split("Duration:")
        .nth(1)?
        .trim();
    let mut parts = t.split(':');
    let h: f64 = parts.next()?.trim().parse().ok()?;
    let m: f64 = parts.next()?.trim().parse().ok()?;
    // 秒字段形如 "09.30, start: 0.000000"——只取第一个 token 再剥掉非数字尾巴
    let sec_token = parts.next()?.trim();
    let sec_str: String = sec_token
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let sec: f64 = sec_str.parse().ok()?;
    let d = h * 3600.0 + m * 60.0 + sec;
    if d > 0.0 {
        Some(d)
    } else {
        None
    }
}

/// 用 `ffmpeg -i <input>`（无输出任务，读到元数据即退出）复核时长。
/// 只对「revelo 时长可疑」的文件调用——正常容器零额外开销。
fn probe_duration_via_ffmpeg(ffmpeg: &Path, input: &str) -> Option<f64> {
    let mut cmd = FfmpegCommand::new_with_path(ffmpeg);
    cmd.arg("-i").arg(input);
    // stdin 置 null + 原生 spawn：同 run_single_frame 的 os error 231 规避注释
    cmd.as_inner_mut().stdin(std::process::Stdio::null());
    let mut child = cmd.as_inner_mut().spawn().ok()?;
    let stderr = child.stderr.take()?;
    let mut text = String::new();
    let _ = std::io::BufReader::new(stderr).read_to_string(&mut text);
    // ffmpeg 打印完元数据后因无输出目标会以错误码退出——正常路径，不算失败
    let _ = child.wait();
    parse_ffmpeg_duration_line(&text)
}

/// 体积感知超时（与前端 `timeoutFor` 同款）：基础 20s + 每 100MB +1s，封顶 120s。
fn timeout_for(size_bytes: u64) -> Duration {
    Duration::from_millis(
        DEFAULT_TIMEOUT_MS
            .saturating_add(size_bytes / 100_000)
            .min(MAX_TIMEOUT_MS),
    )
}

// ── 抽帧 ──────────────────────────────────────────────────────────────────

/// 单次抽帧的获胜帧（select 模式与逐 seek 模式共用）。
struct FramePick {
    jpeg: Vec<u8>,
    score: f64,
    luma: f64,
    /// 获胜帧序号：select 模式 = 收帧计数（窗口内近似对应候选点）；
    /// 逐 seek 模式 = 候选序号。换算秒由调用方查 candidates 表。
    frame_no: usize,
}

/// 对单帧解码打分（select / 逐 seek 两模式共用）。
fn score_jpeg(jpeg: &[u8]) -> Option<(f64, f64)> {
    let img = image::load_from_memory(jpeg).ok()?;
    let rgb = img.to_rgb8();
    let luma = rgb_luma(rgb.as_raw());
    let colorfulness = rgb_colorfulness(rgb.as_raw());
    Some((luma, frame_score(luma, colorfulness)))
}

/// 单文件抽帧结果。
pub struct CoverExtractResult {
    /// 缓存里的封面 JPEG 路径（**绝不**是源视频路径）。
    pub cover_path: String,
    /// 实际选中的时间点（秒），便于排查「抽了个黑帧」类反馈。
    pub seek_time: f64,
    /// 主色（与图片主色同源：core color_extractor）。
    pub colors: Vec<crate::color_extractor::ColorResult>,
}

/// 抽帧入口：自动定位 ffmpeg 后调用 [`extract_with_ffmpeg`]。
/// ffmpeg 缺失返回 None（调用方降级：S3 起前端走 canvas 兜底）。
pub fn extract(file_path: &str, cache_root: &Path) -> Option<CoverExtractResult> {
    let (ffmpeg, _) = locate()?;
    extract_with_ffmpeg(&ffmpeg, file_path, cache_root)
}

/// 用指定 ffmpeg 抽帧：候选点逐个 `-ss` seek 抽单帧 → 打分择优（亮度达标早退）→
/// 最优帧写缓存（`cache_filename_for`，带 `-vc{N}` 版本位）→ 主色提取。
pub fn extract_with_ffmpeg(
    ffmpeg: &Path,
    file_path: &str,
    cache_root: &Path,
) -> Option<CoverExtractResult> {
    // 1) 容器元数据：revelo（与 scanner 同源，零额外进程；ffprobe 不在此引入）。
    let file_size = std::fs::metadata(file_path).map(|m| m.len()).unwrap_or(0);
    let meta = crate::video_metadata::read_video_metadata(Path::new(file_path))?;
    let mut duration = meta.duration_ms? as f64 / 1000.0;
    // 时长健全性：revelo 对部分容器（实测 AVI+AVC：General.Duration=61ms、fps=600，
    // 真实 9.3s）会误报——候选点全被压到开头。可疑时用 `ffmpeg -i` stderr 复核。
    if duration < SUSPICIOUS_DURATION_SECS && file_size > SUSPICIOUS_SIZE_BYTES {
        if let Some(d) = probe_duration_via_ffmpeg(ffmpeg, file_path) {
            log::info!(
                "[ffmpeg_cover] revelo duration 可疑（{:.3}s），ffmpeg 复核: {:.3}s - {}",
                duration,
                d,
                file_path
            );
            duration = d;
        }
    }
    if !(duration > 0.0) || meta.width == 0 || meta.height == 0 {
        return None;
    }

    // 2) 目标尺寸（与前端短边 256 同口径）。
    let (w, h) = target_size_256(meta.width, meta.height);

    // 3) 缓存名：与读路径/前端共用同一函数（视频带 -vc{N} 版本位）。
    let file_meta = std::fs::metadata(file_path).ok()?;
    let cache_filename = crate::thumbnail::cache_filename_for(file_path, &file_meta);
    let jpg_path = cache_root.join(format!("{}.jpg", cache_filename));

    // 4) 所有候选共享同一体积感知超时预算（与前端一致）。
    let timeout = timeout_for(file_meta.len());

    // 5) 抽帧打分：优先 **select 模式**（一次 spawn 输出全部候选，流式亮度早退）——
    //    逐候选模式在 Windows 上每次 spawn 冷启动 ~100-200ms，暗片 6 候选放大成 1s+
    //    （2026-10-15 指挥官实机反馈「明显变慢」）；select 整体失败才回退逐 seek。
    //    两端 duration 来源不同（前端=解码器、这里=容器元数据），候选点可能有毫秒级
    //    差异——打分对照用例保证的是「同一像素输入 → 同一分值」。
    let candidates = seek_candidates(duration);
    let pick = match run_multi_frame_pick(ffmpeg, file_path, &candidates, w, h, timeout) {
        Some(p) => Some(p),
        None => pick_by_sequential_seek(ffmpeg, file_path, &candidates, w, h, timeout),
    };
    let pick = pick?;
    let seek = candidates
        .get(pick.frame_no)
        .copied()
        .unwrap_or(candidates[candidates.len() - 1]);
    let best_jpeg = pick.jpeg;
    let _ = pick.score;
    let _ = pick.luma;

    // 6) 写缓存（只写封面 JPEG）+ 主色（与图片主色同源）。
    if !cache_root.exists() {
        let _ = crate::file_operations::ensure_aurora_cache_dir(cache_root.to_str().unwrap_or(""));
    }
    std::fs::write(&jpg_path, &best_jpeg).ok()?;
    let img = image::load_from_memory(&best_jpeg).ok()?;
    let colors = crate::color_extractor::get_dominant_colors(&img, 8);

    Some(CoverExtractResult {
        cover_path: jpg_path.to_str()?.to_string(),
        seek_time: seek,
        colors,
    })
}

/// select 模式（S6 性能优化）：**一次 spawn 输出全部候选帧**，替代逐候选 N 次 spawn。
///
/// 背景（2026-10-15 指挥官实机反馈「生成明显变慢」）：B 口径后所有视频走后端，
/// 逐候选模式每个候选点一次进程冷启动（Windows ~100-200ms）+ 解码器初始化，
/// 暗片 6 候选放大成 1s+。select 滤镜按时间窗口（±50ms）选帧、image2pipe 输出
/// 连续 JPEG 流——进程冷启动与文件打开只发生一次；流式解析**保留亮度早退**：
/// 达标帧出现即 kill 进程，后续候选不再解码。
///
/// 帧序：select 输出按时间递增，第 i 帧 ≈ 第 i 个候选点（±50ms 窗口内可能多帧，
/// 全部打分取最优）；`frame_no` 换算 seek 秒由调用方查 candidates 表（近似值）。
fn run_multi_frame_pick(
    ffmpeg: &Path,
    input: &str,
    candidates: &[f64],
    w: u32,
    h: u32,
    timeout: Duration,
) -> Option<FramePick> {
    use std::sync::mpsc::RecvTimeoutError;
    if candidates.is_empty() {
        return None;
    }
    // select 表达式：每个候选 ±50ms 窗口，窗口间 + 连接（命中任一窗口即输出该帧）
    let mut expr = String::new();
    for (i, &t) in candidates.iter().enumerate() {
        if i > 0 {
            expr.push('+');
        }
        expr.push_str(&format!("between(t,{:.3},{:.3})", (t - 0.05).max(0.0), t + 0.05));
    }
    let vf = format!("select='{}',scale={}:{}", expr, w, h);

    let mut cmd = FfmpegCommand::new_with_path(ffmpeg);
    cmd.args(["-y", "-loglevel", "error"])
        .arg("-i")
        .arg(input)
        .arg("-vf")
        .arg(vf)
        .args(["-fps_mode", "passthrough", "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-"]);
    // stdin 置 null + 原生 spawn：同 run_single_frame 的 os error 231 规避注释
    cmd.as_inner_mut().stdin(std::process::Stdio::null());
    let mut child: std::process::Child = cmd.as_inner_mut().spawn().ok()?;
    let stdout = child.stdout.take()?;

    // 读线程：按块读 stdout，增量切分连续 JPEG 流（FFD8..FFD9），经 channel 发主线程。
    // 不提前丢弃已收字节（流总量 ≈ 候选数 × ~40KB，内存无谓）——切分逻辑保持简单正确。
    let (tx, rx) = std::sync::mpsc::channel::<Vec<u8>>();
    let reader = std::thread::spawn(move || {
        let mut reader = std::io::BufReader::with_capacity(128 * 1024, stdout);
        let mut scan: Vec<u8> = Vec::with_capacity(512 * 1024);
        let mut scanned = 0usize; // 已扫描位置（跨块续扫）
        let mut frame_start: Option<usize> = None;
        let mut chunk = [0u8; 64 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(n) => {
                    scan.extend_from_slice(&chunk[..n]);
                    while scanned + 1 < scan.len() {
                        if frame_start.is_none() {
                            if scan[scanned] == 0xFF && scan[scanned + 1] == 0xD8 {
                                frame_start = Some(scanned);
                            }
                        } else if scan[scanned] == 0xFF && scan[scanned + 1] == 0xD9 {
                            let s = frame_start.take().unwrap();
                            // JPEG 熵编码数据中不会出现 FFD9（EOI 唯一）——按边界切分可靠
                            if tx.send(scan[s..scanned + 2].to_vec()).is_err() {
                                return; // 主线程已退出（早退 kill）
                            }
                        }
                        scanned += 1;
                    }
                }
                Err(_) => break,
            }
        }
        // EOF 后再扫一遍尾部（最后一块可能补齐了上一块的帧尾）
        while scanned + 1 < scan.len() {
            if frame_start.is_none() && scan[scanned] == 0xFF && scan[scanned + 1] == 0xD8 {
                frame_start = Some(scanned);
            } else if frame_start.is_some() && scan[scanned] == 0xFF && scan[scanned + 1] == 0xD9 {
                let s = frame_start.take().unwrap();
                if tx.send(scan[s..scanned + 2].to_vec()).is_err() {
                    return;
                }
            }
            scanned += 1;
        }
    });

    // 主线程：收帧打分，亮度达标即 kill（后续候选不再解码 = 早退语义）
    let deadline = Instant::now() + timeout;
    let mut best: Option<FramePick> = None;
    let mut frame_no = 0usize;
    let mut done = false;
    while !done {
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            break;
        }
        if let Ok(Some(_)) = child.try_wait() {
            // 进程已退出：排干 channel 剩余帧后收工
            while let Ok(jpeg) = rx.try_recv() {
                if let Some((luma, score)) = score_jpeg(&jpeg) {
                    if best.as_ref().map_or(true, |b| score > b.score) {
                        best = Some(FramePick { jpeg, score, luma, frame_no });
                    }
                }
                frame_no += 1;
            }
            break;
        }
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(jpeg) => {
                if let Some((luma, score)) = score_jpeg(&jpeg) {
                    if best.as_ref().map_or(true, |b| score > b.score) {
                        best = Some(FramePick { jpeg, score, luma, frame_no });
                    }
                    // 够亮直接收工（后续候选不再解码——机械盘/长视频上很关键）
                    if luma >= GOOD_LUMA {
                        let _ = child.kill();
                        let _ = child.wait();
                        done = true;
                    }
                }
                frame_no += 1;
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => {
                while let Ok(jpeg) = rx.try_recv() {
                    if let Some((luma, score)) = score_jpeg(&jpeg) {
                        if best.as_ref().map_or(true, |b| score > b.score) {
                            best = Some(FramePick { jpeg, score, luma, frame_no });
                        }
                    }
                    frame_no += 1;
                }
                break;
            }
        }
    }
    if !done {
        let _ = child.wait(); // 非 kill 路径收尸，防僵尸
    }
    best
}

/// 逐 seek 模式（回退路径）：每个候选一次 spawn。仅在 select 模式整体失败时使用
///（如极老 ffmpeg 不支持 select/between——BtbN 9.0 与近十年系统版均支持）。
fn pick_by_sequential_seek(
    ffmpeg: &Path,
    input: &str,
    candidates: &[f64],
    w: u32,
    h: u32,
    timeout: Duration,
) -> Option<FramePick> {
    let started = Instant::now();
    let mut best: Option<FramePick> = None;
    for (idx, &target) in candidates.iter().enumerate() {
        if started.elapsed() > timeout {
            break;
        }
        let remaining = timeout.saturating_sub(started.elapsed());
        let jpeg = run_single_frame(ffmpeg, input, target, w, h, remaining)?;
        let (luma, score) = score_jpeg(&jpeg)?;
        if best.as_ref().map_or(true, |b| score > b.score) {
            best = Some(FramePick { jpeg, score, luma, frame_no: idx });
        }
        if luma >= GOOD_LUMA {
            break;
        }
    }
    best
}

/// 单次抽帧：`ffmpeg -y -ss {t} -i {input} -frames:v 1 -vf scale={w}:{h} -f image2pipe -c:v mjpeg -q:v 4 -`
///
/// - `-ss` 在 `-i` 前（输入侧 seek，计划 §4 口径）；
/// - 输出走 stdout 管道（image2pipe），不落临时文件；
/// - mjpeg 是 ffmpeg 内建编码器（BtbN LGPL 构建包含），解码+单帧 JPEG 不依赖 GPL 编码器；
/// - 超时 kill：坏文件 / 网络盘卡死不能拖住批量管线。
fn run_single_frame(
    ffmpeg: &Path,
    input: &str,
    seek: f64,
    w: u32,
    h: u32,
    timeout: Duration,
) -> Option<Vec<u8>> {
    let mut cmd = FfmpegCommand::new_with_path(ffmpeg);
    cmd.args(["-y", "-loglevel", "error"])
        .arg("-ss")
        .arg(format!("{:.3}", seek))
        .arg("-i")
        .arg(input)
        .args(["-frames:v", "1"])
        .arg("-vf")
        .arg(format!("scale={}:{}", w, h))
        .args(["-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "4", "-"]);
    // stdin 置 null + 原生 spawn：同 probe_version 的 os error 231 规避注释。
    cmd.as_inner_mut().stdin(std::process::Stdio::null());
    let mut child: std::process::Child = cmd.as_inner_mut().spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    // 读线程：主线程负责 wait + 超时检测，stdout 必须另开线程排干（否则管道写满会互相卡）。
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = stdout.read_to_end(&mut buf);
        buf
    });

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let _ = child.wait();
                    return None;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(_) => return None,
        }
    }

    let buf = reader.join().ok()?;
    // JPEG 魔数校验：空输出 / 错误文本直接弃。
    if buf.len() > 3 && buf[0] == 0xFF && buf[1] == 0xD8 && buf[2] == 0xFF {
        Some(buf)
    } else {
        None
    }
}

// ── Tauri 命令（S1：设置面板三态显示）──────────────────────────────────────

#[tauri::command]
pub async fn ffmpeg_status() -> Result<FfmpegStatus, String> {
    tauri::async_runtime::spawn_blocking(detect_status)
        .await
        .map_err(|e| e.to_string())
}

// ── 单测 ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── TS↔Rust 对照用例（期望值与 src/utils/__tests__/videoCover.spec.ts 对齐）──

    #[test]
    fn seek_candidates_match_ts() {
        // TS: seekCandidates(13)[0] ≈ 1.3 且 > 0
        let c = seek_candidates(13.0);
        assert!((c[0] - 1.3).abs() < 1e-9);

        // TS: duration=20 → 严格递增且都落在 (0, duration) 内
        let c = seek_candidates(20.0);
        assert!(c.len() > 1);
        for &t in &c {
            assert!(t > 0.0 && t < 20.0);
        }
        for w in c.windows(2) {
            assert!(w[1] > w[0]);
        }

        // TS: duration=1 → 全部收敛到 safe end，绝不越界
        for t in seek_candidates(1.0) {
            assert!(t <= 1.0 - 0.05 + 1e-9);
        }

        // TS: duration=0.02 → 毫秒去重后仍非空
        let c = seek_candidates(0.02);
        assert!(!c.is_empty());
        let uniq: std::collections::HashSet<i64> =
            c.iter().map(|t| (t * 1000.0).round() as i64).collect();
        assert_eq!(uniq.len(), c.len());
    }

    #[test]
    fn frame_score_matches_ts() {
        // 绝对值：min(luma,160) + 0.5 × colorfulness
        assert!((frame_score(100.0, 20.0) - 110.0).abs() < 1e-9);
        assert!((frame_score(50.0, 20.0) - 60.0).abs() < 1e-9);
        assert!((frame_score(160.0, 50.0) - 185.0).abs() < 1e-9);
        assert!((frame_score(240.0, 0.0) - 160.0).abs() < 1e-9);
        assert!((frame_score(40.0, 20.0) - 50.0).abs() < 1e-9);
        assert!((frame_score(110.0, 40.0) - 130.0).abs() < 1e-9);

        // 相对关系（videoCover.spec.ts 的 4 个断言）
        assert!(frame_score(100.0, 20.0) > frame_score(50.0, 20.0));
        assert!(frame_score(80.0, 40.0) > frame_score(80.0, 10.0));
        assert!(frame_score(160.0, 50.0) > frame_score(240.0, 0.0));
        assert!(frame_score(40.0, 20.0) < frame_score(110.0, 40.0));
    }

    #[test]
    fn rgb_stats_match_ts() {
        // 灰色像素鲜艳度为 0（TS spec 同款像素值）
        let gray: Vec<u8> = vec![128, 128, 128, 100, 100, 100];
        assert!(rgb_colorfulness(&gray).abs() < 1e-9);
        // 纯红鲜艳度为 255
        assert!((rgb_colorfulness(&[255, 0, 0]) - 255.0).abs() < 1e-9);
        // 彩色高于灰色
        assert!(rgb_colorfulness(&[200, 50, 50]) > rgb_colorfulness(&[128, 128, 128]));

        // 亮度：纯白 255 / 纯黑 0
        assert!((rgb_luma(&[255, 255, 255]) - 255.0).abs() < 1e-9);
        assert!(rgb_luma(&[0, 0, 0]).abs() < 1e-9);

        // 每 4 像素抽 1 样：8 像素中只有 0、4 号参与（1/2/3/5/6/7 号是干扰值）
        // 0 号=白、4 号=黑：luma 均值 127.5；两者的 max-min 均为 0 → colorfulness = 0
        let mut px = vec![200u8; 8 * 3];
        px[0..3].copy_from_slice(&[255, 255, 255]);
        px[12..15].copy_from_slice(&[0, 0, 0]);
        assert!((rgb_luma(&px) - 127.5).abs() < 1e-9);
        assert!(rgb_colorfulness(&px).abs() < 1e-9);
    }

    #[test]
    fn target_size_matches_ts() {
        // 横片 1920×1080：h=256，w=round(1920×256/1080)=455（TS: Math.round 同值）
        assert_eq!(target_size_256(1920, 1080), (455, 256));
        // 竖片
        assert_eq!(target_size_256(1080, 1920), (256, 455));
        // 正方形
        assert_eq!(target_size_256(500, 500), (256, 256));
    }

    #[test]
    fn timeout_matches_ts() {
        assert_eq!(timeout_for(0), Duration::from_millis(20_000));
        // 500MB → +5s
        assert_eq!(timeout_for(500_000_000), Duration::from_millis(25_000));
        // 巨大体积封顶 120s（saturating，不得溢出 panic）
        assert_eq!(timeout_for(u64::MAX), Duration::from_millis(120_000));
    }

    #[test]
    fn parse_ffmpeg_duration_line_works() {
        // 真实 stderr 形态：level+info 使每行带 [info] 前缀（FfmpegCommand 自动加）
        let stderr = "[info] ffmpeg version n9.0.2\n[info] Input #0, avi, from 'x.avi':\n[info]   Duration: 00:00:09.30, start: 0.000000, bitrate: 295377 kb/s\n";
        let d = parse_ffmpeg_duration_line(stderr).unwrap();
        assert!((d - 9.30).abs() < 0.001);
        // 无前缀形态也兼容
        let plain = "Input #0, avi:\n  Duration: 00:00:09.30, start: 0.000000\n";
        assert!((parse_ffmpeg_duration_line(plain).unwrap() - 9.30).abs() < 0.001);
        // 带小时位
        assert!((parse_ffmpeg_duration_line("Duration: 01:02:03.50").unwrap() - 3723.5).abs() < 0.001);
        // 无 Duration 行 / 零时长 → None
        assert!(parse_ffmpeg_duration_line("nothing here").is_none());
        assert!(parse_ffmpeg_duration_line("Duration: 00:00:00.00").is_none());
    }

    // ── 集成测试（需要真实 ffmpeg；本机缺失时优雅跳过）────────────────────

    /// S6 性能基准：select 模式（一次 spawn 全候选）vs 逐 seek 模式（N 次 spawn）。
    /// 背景是指挥官实机反馈「逐候选 spawn 明显变慢」，本测试量化两种模式的差距。
    #[test]
    fn bench_extract_modes() {
        let Some((ffmpeg, _)) = locate() else {
            eprintln!("[skip] 本机无 ffmpeg，跳过基准");
            return;
        };
        let samples = [
            "../log/SVID_20261006_212831_1.mp4",
            "../log/SVID_20261006_212831_1.mkv",
            "../log/SVID_20261006_213438_1.avi",
        ];
        for s in samples {
            if !Path::new(s).exists() {
                continue;
            }
            let Some(meta) = crate::video_metadata::read_video_metadata(Path::new(s)) else {
                continue;
            };
            let Some(dur_ms) = meta.duration_ms else { continue };
            let mut duration = dur_ms as f64 / 1000.0;
            let size = std::fs::metadata(s).map(|m| m.len()).unwrap_or(0);
            if duration < SUSPICIOUS_DURATION_SECS && size > SUSPICIOUS_SIZE_BYTES {
                if let Some(d) = probe_duration_via_ffmpeg(&ffmpeg, s) {
                    duration = d;
                }
            }
            let (w, h) = target_size_256(meta.width, meta.height);
            let candidates = seek_candidates(duration);
            let timeout = timeout_for(size);

            let t0 = Instant::now();
            let sel = run_multi_frame_pick(&ffmpeg, s, &candidates, w, h, timeout);
            let t_sel = t0.elapsed();

            let t1 = Instant::now();
            let seq = pick_by_sequential_seek(&ffmpeg, s, &candidates, w, h, timeout);
            let t_seq = t1.elapsed();

            println!(
                "{} dur={:.2}s | select: {:?} frame_no={:?} | sequential: {:?} frame_no={:?}",
                s,
                duration,
                t_sel,
                sel.as_ref().map(|p| p.frame_no),
                t_seq,
                seq.as_ref().map(|p| p.frame_no)
            );
            assert!(sel.is_some(), "select 模式失败: {}", s);
            assert!(seq.is_some(), "sequential 模式失败: {}", s);
        }
    }

    #[test]
    fn extract_real_video_when_ffmpeg_present() {
        let Some((ffmpeg, source)) = locate() else {
            eprintln!("[skip] 本机无 ffmpeg，跳过抽帧集成测试");
            return;
        };
        // 样本覆盖两类容器：mp4（前端也能解，验同源）+ mkv/avi（P1.5-B 新增覆盖的
        // 「Web 解不了」容器代表，`-c copy` remux 自 mp4，S6 验收清单第 1 项）。
        let samples = [
            "../log/SVID_20261006_212831_1.mp4",
            "../log/SVID_20261006_213438_1.mp4",
            "../log/SVID_20261006_212831_1.mkv",
            "../log/SVID_20261006_213438_1.avi",
        ];
        let mut ran = false;
        for s in samples {
            if !Path::new(s).exists() {
                eprintln!("[skip] 样本不存在: {}", s);
                continue;
            }
            ran = true;
            let tmp = std::env::temp_dir().join("aurora_ffmpeg_cover_test");
            std::fs::create_dir_all(&tmp).unwrap();
            match extract_with_ffmpeg(&ffmpeg, s, &tmp) {
                Some(r) => {
                    assert!(Path::new(&r.cover_path).exists(), "封面文件应已写盘");
                    assert!(!r.colors.is_empty(), "主色不应为空");
                    println!(
                        "=> {} seek={:.3}s colors={} source={:?} cover={}",
                        s,
                        r.seek_time,
                        r.colors.len(),
                        source,
                        r.cover_path
                    );
                }
                None => panic!("extract 失败：{}", s),
            }
        }
        let _ = ran;
    }
}
