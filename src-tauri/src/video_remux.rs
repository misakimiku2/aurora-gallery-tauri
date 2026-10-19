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
///
/// v1→v2（2026-10-19）：`+faststart` 换成**分片 MP4**（`frag_keyframe+empty_moov`）。
/// 起因是实测：faststart 要把 moov 搬到文件头，那是一次**整文件重写**，
/// 一只 1.57GB 的 avi 冷盘上因此多花 ~33 秒（拷贝 12 秒就完，ready 要 45 秒），
/// 而这段时间 `out_time` 已经到头 → 进度死死停在 99%，手机上看着就是卡死。
/// 分片一趟写完、开头即有索引，不需要重写。⚠️ **两端 seek 与时长显示待实测**。
pub const REMUX_CACHE_VERSION: u32 = 2;

/// 前端事件名（ImageViewer 订阅，拿 `{path, state}`）。
pub const PROGRESS_EVENT: &str = "video-remux-progress";

/// remux 档上限：产物与原视频等大、几秒钟就能重生成，当易耗缓存说得过去。
pub const MAX_CACHE_BYTES: u64 = 4 * 1024 * 1024 * 1024;

/// 转码档上限：几十只 WMV 就是几十 GB，放宽到 64GB 够把整个 B 类库转完。
pub const TRANSCODE_MAX_BYTES: u64 = 64 * 1024 * 1024 * 1024;

/// 按档取上限。**两只档共用一个目录，但各算各的预算** —— 混在一条上限里，
/// 批量转完的东西会被后续 remux 一点点挤掉，等于白烧几十分钟 CPU。
pub fn cache_limit_for(profile: VideoProfile) -> u64 {
    match profile {
        VideoProfile::Remux => MAX_CACHE_BYTES,
        VideoProfile::Transcode => TRANSCODE_MAX_BYTES,
    }
}

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

/// **安卓端**可播容器 —— 与桌面那张不是一张表，改一张不等于改另一张。
///
/// 依据（2026-10-19 真机取证，Mate 40 Pro / NOH-AL00 / EMUI 14.2）：
/// `dumpsys media.extractor` 实际装载的提取器 = aac / amr / flac / midi / mp3 /
/// mp4(3g2 3ga 3gp 3gpp 3gpp2 m4a m4r m4v mov mp4 qt) / mpeg2-ps-ts(m2p m2ts mts ts) /
/// matroska(mka mkv webm) / ogg / wav，外加华为自带 `libhwextendedwrapextractor.so`
/// (ts mts m2ts trp)。**没有 AVI、没有 ASF/WMV** —— 这两类连解封装都进不去，
/// 与里面装的是什么编码无关。
///
/// 交叉核对：媒体扫描器（走的就是平台 MediaExtractor）对真实 AVI 回填的
/// `width/height/duration` 全为 NULL，而换包装后的产物全部正常回填。
const ANDROID_PLAYABLE_EXTENSIONS: [&str; 9] = [
    "mp4", "m4v", "mov", "3gp", "3g2", "webm", "mkv", "ts", "m2ts",
];

/// 手机**实测解得动**的视频编码白名单。表外的一律走转码档。
///
/// 为什么用白名单而不是黑名单：未知编码赌 remux，赌输的产物手机照样解不开，
/// 客户端只会拿到一个「换了壳还是播不了」的文件；赌转码最多慢几分钟，一定能播。
/// 宁可慢，不可错。
///
/// ⚠️ 表内字符串是 **revelo / MediaInfo 口径**，不是 ffmpeg 口径（2026-10-19 实测打印：
/// Xvid AVI 报 `MPEG-4 Visual`、MJPEG AVI 报 `JPEG`、H.264 AVI 报 `AVC`）。
/// 改这张表前先拿真样本打印一遍，别照 ffmpeg 的写法猜。
///
/// 实测依据（同一只 NOH-AL00）：
/// - `MPEG-4 Visual` / `AVC`：真实 Xvid AVI 换进 MP4（`-c:v copy` + 音轨转 AAC）后，
///   平台真拉起了 `OMX.hisi.video.decoder.mpeg4` + `c2.android.aac.decoder`；
///   H.264 那条另经 `OMX.hisi.video.decoder.avc` 解出过帧。
/// - `HEVC` / `VP8` / `VP9` / `AV1` / `MPEG-2 Video`：`/vendor/etc/media_codecs.xml`
///   与 APEX 软解清单都在列（`c2.android.mpeg2.decoder`、`OMX.hisi.video.decoder.*`）；
///   注意这几类所在的容器本来就属上面那张可播清单，实际走不到这条判据，列上是求全。
///
/// 明确解不动的两位（自动落进转码档）：**VC-1/WMV3** —— 海思声明了
/// `OMX.hisi.video.decoder.vc1`，真去解时平台报 `Failed to instantiate decoder`
/// → `all codecs failed to extract frame`，声明了却拉不起来；**JPEG**(MJPEG) 无解码器。
/// 另外 `None` 也算解不动：revelo **整只 ASF 读不出**（实测 WMV 样本 `codec=None`），
/// 正好被白名单接住。
const ANDROID_DECODABLE_CODECS: [&str; 7] = [
    "avc",
    "hevc",
    "mpeg-4 visual",
    "mpeg-2 video",
    "vp8",
    "vp9",
    "av1",
];

/// 该编码手机能不能直接解（`None` = 扫描器没拿到，按解不动处理）。
pub fn android_can_decode_codec(codec: Option<&str>) -> bool {
    let raw = match codec {
        Some(c) => c,
        None => return false,
    };
    let key = raw.trim().to_lowercase();
    ANDROID_DECODABLE_CODECS.contains(&key.as_str())
}

/// 按编码定产物档位。
pub fn pick_profile(codec: Option<&str>) -> VideoProfile {
    if android_can_decode_codec(codec) {
        VideoProfile::Remux
    } else {
        VideoProfile::Transcode
    }
}

/// 产物口径：**Remux** = 视频轨比特级拷贝（秒级、无损）；
/// **Transcode** = 视频轨重编成 H.264（B 类唯一出路，实测 ~39x 实时）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VideoProfile {
    Remux,
    Transcode,
}

impl VideoProfile {
    /// 缓存名后缀：Remux 沿用历史形状（`-v{N}.mp4`），避免把已有产物全判成失效重转一遍。
    fn tag(self) -> &'static str {
        match self {
            VideoProfile::Remux => "",
            VideoProfile::Transcode => "-t",
        }
    }

    /// 视频轨参数。`retry` = 第二试（带帧率钳位与像素格式归一）。
    ///
    /// Transcode 走 `-c:v h264_mf`（系统 Media Foundation）。另两条更省事的路**都堵着**：
    /// 这份 pin 住的 LGPL 构建里没有 libx264；NVENC 要 API 13.1 而本机驱动 576.80 只给 13.0。
    /// 码率按分辨率封顶，见 [`EncodeHints::target_bps`]。
    fn video_args(self, hints: EncodeHints, retry: bool) -> Vec<String> {
        match self {
            VideoProfile::Remux => vec!["-c:v".to_string(), "copy".to_string()],
            VideoProfile::Transcode => {
                let mut a: Vec<String> = vec!["-c:v".into(), "h264_mf".into()];
                if retry {
                    a.push("-vf".into());
                    a.push("fps=60,format=yuv420p".into());
                }
                a.push("-scenario".into());
                a.push("archive".into());
                match hints.target_bps() {
                    Some(bps) => {
                        a.push("-b:v".into());
                        a.push(bps.to_string());
                    }
                    None => {
                        a.push("-rate_control".into());
                        a.push("quality".into());
                        a.push("-quality".into());
                        a.push("60".into());
                    }
                }
                a
            }
        }
    }

    /// 有没有第二试可退（remux 档一路到底，不靠猜升档）。
    ///
    /// 实测坑（第二试的由来）：`h264_mf` 在 `log/SVID_*.avi` 上直接报
    /// `Could not open encoder before EOF` → 产物 0 字节。根因是这批 AVI 的头部
    /// **谎报 600fps**（真实约 60，与 v2.29 那条「AVI 头 600fps/600tbr」同源），
    /// 而 Media Foundation 按帧率×像素算 level，超了就拒开编码器。
    /// 只给第二试加钳位，不给首选就加：对所有正常 25/30fps 源强上 `fps=60` 会白白多编
    /// 2~2.4 倍的帧（fps 滤镜只重采样时间轴、不改播放速度，所以是纯浪费）。
    fn has_retry(self) -> bool {
        matches!(self, VideoProfile::Transcode)
    }
}

/// 转码定档要用的分辨率线索（全 0 = 不知道 → 退回质量档）。
#[derive(Debug, Clone, Copy, Default)]
pub struct EncodeHints {
    pub width: u32,
    pub height: u32,
    pub fps: f64,
}

/// 每像素每帧给多少比特，把转码目标码率**按分辨率封顶**。
///
/// 标定（2026-10-19 实测）：704x396@29.97 走 `-rate_control quality -quality 60` 出
/// 603 kb/s（源 1920 kb/s）看着够用，反推 ≈ 0.072 bit/px/帧；**同一档搬到 1280x720
/// 却跑到 ~4.2 Mb/s，产物比源（4 Mb/s）还大** —— MF 的 quality 模式按 QP 给，
/// 像素一多就失控。改成显式 `-b:v` 后：720p29.97 → 2.5 Mb/s、1080p → 5.6 Mb/s。
/// 取 0.09 而不是 0.072 是给运动画面留余量。
const BITS_PER_PIXEL_FRAME: f64 = 0.09;
const MIN_TARGET_BPS: u64 = 1_000_000;
const MAX_TARGET_BPS: u64 = 8_000_000;

impl EncodeHints {
    /// 目标码率（bps）；拿不到分辨率时 None → 调用方退回 `-quality 60` 老档。
    fn target_bps(&self) -> Option<u64> {
        if self.width == 0 || self.height == 0 {
            return None;
        }
        // 600fps 这类谎报别让它把码率顶上天：超出合理区间就当没说
        let fps = if self.fps.is_finite() && self.fps > 0.0 && self.fps <= 120.0 {
            self.fps
        } else {
            30.0
        };
        let bps = (self.width as f64 * self.height as f64 * fps * BITS_PER_PIXEL_FRAME) as u64;
        Some(bps.clamp(MIN_TARGET_BPS, MAX_TARGET_BPS))
    }
}

/// 安卓端能不能直接解这个容器。
pub fn is_android_playable(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    match lower.rsplit('.').next() {
        Some(e) => ANDROID_PLAYABLE_EXTENSIONS.contains(&e),
        None => false,
    }
}

/// 手机来要这份文件时，**产物已就绪**的话返回产物路径（否则 None = 发源文件）。
///
/// 三条边界写死在这里：
/// 1. 非视频一律 None —— 图片也走 `/api/image`，按扩展名表挡掉，别拿 remux 去碰 JPG；
/// 2. 手机能直接解的容器 None —— 有历史产物也不换，省一次无谓的字节改道；
/// 3. **只查缓存、绝不启动转换**：这是播放器正在读的数据源请求，阻塞它等于踩
///    ExoPlayer 的读超时并触发重试风暴。启动转换是备播端点（`ensure_async_for_client`）
///    的职责，客户端「先问后备好再开」。
pub fn android_product_for(path: &Path) -> Option<PathBuf> {
    // ⚠️ `is_supported_video` 收的是**扩展名**（core 那张表的口径），不是文件名 ——
    // 直接把 file_name 喂进去会永远返回 false，改道静默失效（本条被单测抓过）。
    let ext = path.extension().and_then(|e| e.to_str())?;
    if !aurora_core::file_types::is_supported_video(ext) {
        return None;
    }
    let abs = path.to_string_lossy().to_string();
    if is_android_playable(&abs) {
        return None;
    }
    let codec = crate::video_metadata::read_video_metadata(path).and_then(|m| m.video_codec);
    probe_cached(&abs, pick_profile(codec.as_deref()))
}


/// 超时模型：30s 基础 + 每 10MB 加 1s（remux 是纯拷贝，实测 ~150MB/s；
/// 机械盘 / 冷 IO 场景放宽到 ~10MB/s 的量级），封顶 15 分钟。
const BASE_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_TIMEOUT: Duration = Duration::from_secs(900);

fn timeout_for(size_bytes: u64) -> Duration {
    let extra = Duration::from_millis((size_bytes / (10 * 1024 * 1024)) * 1000);
    std::cmp::min(BASE_TIMEOUT + extra, MAX_TIMEOUT)
}

/// 转码档的超时：实测 ~39x 实时（704x396 VC-1，h264_mf 质量档），
/// 但高分辨率/高码率源会掉到个位数倍速，所以每 10MB 给 4 秒、封顶 30 分钟，
/// 比 remux 那条松一个量级 —— 宁可慢判也别半途 kill 掉一个已经跑了三分钟的编码。
fn timeout_for_profile(size_bytes: u64, profile: VideoProfile) -> Duration {
    match profile {
        VideoProfile::Remux => timeout_for(size_bytes),
        VideoProfile::Transcode => {
            const BASE: Duration = Duration::from_secs(60);
            const MAX: Duration = Duration::from_secs(1800);
            let extra = Duration::from_millis((size_bytes / (10 * 1024 * 1024)) * 4000);
            std::cmp::min(BASE + extra, MAX)
        }
    }
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

// ── 产物目录 ─────────────────────────────────────────────────────────────
//
// **两只档共用一个目录，放在媒体盘上**（2026-10-19 从 `%LOCALAPPDATA%` 搬出来）。
// 理由是量出来的：本机 C: 只剩 20GB（92% 已用），而一只 1.57GB 的 avi remux 出来就是
// 1.57GB、一只 95 分钟 720p 的 wmv 转码产物按失控前的档位能长到 4GB —— 现在库里 1~2GB
// 的 avi 一抓一把，两三支就把系统盘推到底了。缩略图、WebView 缓存也都在这块盘上。
//
// 落点 = `<资源根>/.Aurora_Cache/video-products`，跟着媒体在哪个盘就在哪个盘。
// 能这么放的前提：扫描器整体跳过以 `.` 开头的条目（`scanner.rs::is_ignored_entry_name`），
// 所以产物**不会**被当成图库内容重复索引 —— 别把目录名改成不带点的。
// 没设过资源根时回落到 `%LOCALAPPDATA%\com.aurora.gallery\video-products`
// （老行为，保证任何启动顺序下都算得出一个能用的名字，不会 panic）。

static PRODUCTS_DIR: Lazy<Mutex<Option<PathBuf>>> = Lazy::new(|| Mutex::new(None));

fn default_products_dir() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        let local = std::env::var("LOCALAPPDATA").ok()?;
        Some(Path::new(&local).join("com.aurora.gallery").join("video-products"))
    }
    #[cfg(not(target_os = "windows"))]
    {
        let home = std::env::var("HOME").ok()?;
        Some(Path::new(&home).join(".local/share/com.aurora.gallery/video-products"))
    }
}

/// 由资源根算产物目录 —— **唯一公式**，LAN 侧、桌面侧、批量队列都走它。
/// 两边算出不同目录就会出现「手机上报已备好、`/api/image` 却找不到」。
pub fn products_dir_for_root(resource_root: &str) -> PathBuf {
    Path::new(resource_root)
        .join(".Aurora_Cache")
        .join("video-products")
}

/// 设置产物目录（幂等；切根后自动跟）。
/// 目录本身由起任务那边 `ensure_aurora_cache_dir` 建，这里只记路径。
pub fn set_products_dir(dir: &Path) {
    let mut g = PRODUCTS_DIR.lock().unwrap();
    if g.as_deref() != Some(dir) {
        *g = Some(dir.to_path_buf());
        log::info!("[video_remux] 产物目录 -> {}", dir.display());
    }
}

/// 当前产物目录。
pub fn products_dir() -> Option<PathBuf> {
    if let Some(d) = PRODUCTS_DIR.lock().unwrap().as_ref() {
        return Some(d.clone());
    }
    default_products_dir()
}

/// 这只产物文件名属不属于该档（共用目录后，LRU 与清理都要按档分，
/// 否则 remux 写满 4GB 预算会把批量转好的 64GB 产物一点点挤掉）。
fn file_belongs_to_profile(name: &str, profile: VideoProfile) -> bool {
    let suffix = format!("-v{}{}.mp4", REMUX_CACHE_VERSION, profile.tag());
    // remux 档的后缀是空串，会把转码档的 `-v2-t.mp4` 也吃进来 → 单独挡掉
    if profile == VideoProfile::Remux {
        return name.ends_with(&suffix) && !name.contains("-t.mp4");
    }
    name.ends_with(&suffix)
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

/// 产物文件名：`md5(路径|大小|mtime)-v{REMUX_CACHE_VERSION}{档后缀}.mp4`。
/// 档后缀见 [`VideoProfile::tag`] —— 两只档共用同一个源时必须各留一份产物，
/// 否则「先 remux 再转码」会互相覆盖。
pub fn cache_file_name(path: &str, profile: VideoProfile) -> Option<String> {
    let (size, mtime) = source_fingerprint(path)?;
    let digest = md5::compute(format!("{}|{}|{}", path, size, mtime));
    Some(format!(
        "{:x}-v{}{}.mp4",
        digest,
        REMUX_CACHE_VERSION,
        profile.tag()
    ))
}

/// 产物绝对路径（两只档共用目录，靠 [`VideoProfile::tag`] 区分文件名）。
pub fn cache_path_for(path: &str, profile: VideoProfile) -> Option<PathBuf> {
    Some(products_dir()?.join(cache_file_name(path, profile)?))
}

/// **只查缓存、不触发任何转换**（D6① 悬停预览用：没有产物就维持现状，绝不因滚动发起转换）。
pub fn probe_cached(path: &str, profile: VideoProfile) -> Option<PathBuf> {
    let out = cache_path_for(path, profile)?;
    if out.is_file() && std::fs::metadata(&out).map(|m| m.len() > 0).unwrap_or(false) {
        Some(out)
    } else {
        None
    }
}

/// **桌面端（WebView）**该播哪份现成产物：先转码档、再 remux 档。
///
/// 为什么转码档优先：产物要喂的是 Chromium，而 remux 是**比特级拷贝**——
/// Xvid（MPEG-4 Visual）换进 MP4 手机能解（2026-10-19 实测），Chromium 却解不了，
/// 桌面会照样黑屏；而转码产物是 H.264+AAC，两端通吃。所以哪只存在就选哪只时，
/// 要选**桌面一定播得了**的那只。
///
/// 这条也修掉一个真实缺口：批量预转跑完之后，桌面对同一只 wmv 仍会去试 remux、
/// 必然失败、然后弹「用系统播放器打开」——明明旁边就躺着一份 H.264 产物。
/// （安卓侧不受这里影响：它按 [`pick_profile`] 由编码定档，见 [`android_product_for`]。）
pub fn desktop_product_for(path: &str) -> Option<PathBuf> {
    probe_cached(path, VideoProfile::Transcode).or_else(|| probe_cached(path, VideoProfile::Remux))
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

/// 单次产物化调用：视频轨参数由 `video_args` 给（remux 档是 `-c:v copy`，转码档是
/// `h264_mf` 那一串）+ 当前音轨档 → 产物写**临时路径**（成功再 rename）。
///
/// * `on_progress`：以 0.0–1.0 回调当前进度（由 `-progress pipe:1` 的 `out_time_us` 换算）。
/// * `-map 0:v:0 -map 0:a:0?`：只取第一条视频轨与第一条音轨 —— **字幕/附件一律丢弃**
///   （mkv 常内嵌 mjpeg 封面附件，带进 MP4 会因容器装不下而直接报错）。
fn remux_once(
    ffmpeg: &Path,
    input: &str,
    tmp_output: &Path,
    video_args: &[String],
    audio_args: &[&'static str],
    timeout: Duration,
    total_us: Option<u64>,
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
        .args(video_args)
        .args(audio_args)
        .args(["-map_metadata", "0"])
        // **分片 MP4**（2026-10-19 换掉 `+faststart`）：`empty_moov` 让索引头在文件最前面
        // 就写好、之后每个关键帧起一片，**一趟写完、不需要回头搬 moov**。
        // 换掉的理由是实测：faststart 那次整文件重写让一只 1.57GB 的 avi 从「拷完 12 秒」
        // 拖到「ready 45 秒」，而这段时间 out_time 已经到头 → 进度死停在 99%。
        // ⚠️ 分片产物的**时长显示与 seek** 两端都还没实测过（Chromium 与 ExoPlayer 都得
        // 从 moof 链算总时长），验收要看：进度条总长对不对、拖到中段能不能落准。
        .args(["-movflags", "+frag_keyframe+empty_moov+default_base_moof"])
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
    // 顺手把 `out_time_us` 存进共享量：重编码档的产物体积与源差两个量级，
    // 进度只能按「已编到第几微秒 / 总时长」算，按体积算会一路卡在三分之一。
    let stdout = child.stdout.take();
    let started = Instant::now();
    let out_us: Arc<std::sync::atomic::AtomicU64> =
        Arc::new(std::sync::atomic::AtomicU64::new(0));
    let out_us_for_reader = Arc::clone(&out_us);
    let reader = stdout.map(|out| {
        std::thread::spawn(move || {
            let mut reader = BufReader::new(out);
            let mut line = String::new();
            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {
                        if let Some(v) = line.trim().strip_prefix("out_time_us=") {
                            if let Ok(n) = v.trim().parse::<u64>() {
                                out_us_for_reader
                                    .store(n, std::sync::atomic::Ordering::Relaxed);
                            }
                        }
                    }
                }
            }
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
                // 进度：知道总时长就按已编时长算（两档通用，且重编码档只有这一种准）；
                // 不知道就退回「产物大小 / 源大小」（remux 档前后体积同量级，够用）。
                //
                // 上限压到 0.97 而不是 0.99：数据写完到进程真正退出之间还有收尾
                // （刷盘 / rename / 校验），那一段任何口径都看不见。顶到 99% 干等
                // 就是刚才手机上「卡住了」的观感来源 —— 留 3% 给看不见的尾巴。
                let p = match total_us {
                    Some(t) if t > 0 => Some(
                        (out_us.load(std::sync::atomic::Ordering::Relaxed) as f64 / t as f64)
                            .clamp(0.0, 0.97) as f32,
                    ),
                    _ => poll_source_size.filter(|src| *src > 0).map(|src| {
                        let cur = std::fs::metadata(tmp_output).map(|m| m.len()).unwrap_or(0);
                        (cur as f64 / src as f64).clamp(0.0, 0.97) as f32
                    }),
                };
                if let Some(p) = p {
                    if p > last_progress {
                        last_progress = p;
                        on_progress(p);
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

/// LRU 淘汰：**只在该档自己的预算内**按 mtime 从旧到新删。
///
/// 两只档现在共用一个目录，所以必须按档过滤 —— 不然 remux 写满 4GB 就会把
/// 批量转好的转码产物（预算 64GB）一点点挤掉，等于白烧几十分钟 CPU。
fn trim_cache(dir: &Path, limit: u64, profile: VideoProfile) {
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
        let name = e.file_name().to_string_lossy().to_string();
        if !file_belongs_to_profile(&name, profile) {
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
                "[video_remux] LRU 淘汰 {:?} 档 {}KB - {}",
                profile,
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

/// **桌面端**口径：Chromium 原生可解的容器直接直播，其余走 Remux 档。
/// - `force = true`：连原生可解容器也重新封装（直播失败后的兜底）；
/// - `on_progress`：收到 0.0–1.0 的实时进度（节流由调用方负责）。
pub fn ensure_sync_inner<'a>(
    path: &str,
    force: bool,
    on_progress: Option<&'a mut dyn FnMut(f32)>,
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
    ensure_with_profile(
        path,
        VideoProfile::Remux,
        None,
        EncodeHints::default(),
        on_progress,
    )
}

/// 同步执行**指定档**：批量队列自己起线程、自己排队，用它绕过 `TASKS` 那套在途去重
/// （队列一次只跑一只，没有并发要合并）。`on_progress` 同 [`ensure_with_profile`]。
pub fn ensure_sync_profile<'a>(
    path: &str,
    profile: VideoProfile,
    total_us: Option<u64>,
    hints: EncodeHints,
    on_progress: Option<&'a mut dyn FnMut(f32)>,
) -> RemuxStateDto {
    ensure_with_profile(path, profile, total_us, hints, on_progress)
}

/// **安卓端**口径：容器已由 [`is_android_playable`] 判过，到这里就是要产物。
/// 档位一次定死，见 [`pick_profile`] —— 不做「先赌 remux、失败再升档」，
/// 赌输的产物手机照样播不了，客户端只会拿到一个换了壳的坏文件。
pub fn ensure_for_client<'a>(
    path: &str,
    codec: Option<&str>,
    total_us: Option<u64>,
    hints: EncodeHints,
    on_progress: Option<&'a mut dyn FnMut(f32)>,
) -> RemuxStateDto {
    ensure_with_profile(path, pick_profile(codec), total_us, hints, on_progress)
}

/// 按指定档确保产物存在。
///
/// `hints` 只在转码档起作用（按分辨率封顶定码率）；remux 档不编视频轨，给默认值即可。
fn ensure_with_profile<'a>(
    path: &str,
    profile: VideoProfile,
    total_us: Option<u64>,
    hints: EncodeHints,
    mut on_progress: Option<&'a mut dyn FnMut(f32)>,
) -> RemuxStateDto {
    if let Some(cached) = probe_cached(path, profile) {
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
    let Some(dir) = products_dir() else {
        return failed(path, "cache_dir_unavailable");
    };
    if !dir.exists() && crate::file_operations::ensure_aurora_cache_dir(dir.to_str().unwrap_or("")).is_err()
    {
        return failed(path, "cache_dir_unavailable");
    }
    sweep_tmp_files(&dir);

    let Some(out) = cache_path_for(path, profile) else {
        return failed(path, "stat_failed");
    };
    let tmp = out.with_extension("mp4.tmp");
    let _ = std::fs::remove_file(&tmp);

    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let timeout = timeout_for_profile(size, profile);

    // 视频参数阶梯：转码档首选失败后，带帧率钳位再试一次
    // （坑见 [`VideoProfile::video_args_retry`]；remux 档没有第二试）。
    let has_retry = profile.has_retry();
    let mut attempt = 0usize;
    let mut last_error: Option<String> = None;
    loop {
        let video_args = if attempt == 0 {
            profile.video_args(hints, false)
        } else if has_retry {
            log::warn!(
                "[video_remux] {:?} 档第一试失败，带帧率钳位重试一次 - {}",
                profile,
                path
            );
            profile.video_args(hints, true)
        } else {
            // remux 档一路到底失败
            return RemuxStateDto {
                path: path.to_string(),
                status: RemuxStatus::Failed,
                progress: 0.0,
                output_path: None,
                message: Some(last_error.clone().unwrap_or_else(|| "remux_failed".to_string())),
            };
        };

        // 调用方没传回调就走 no-op（每试都从 0 起算，因为 tmp 会重写）。
        let mut no_op = |_p: f32| {};
        let progress_cb: &mut dyn FnMut(f32) = match on_progress.as_mut() {
            Some(f) => &mut **f,
            None => &mut no_op,
        };

        match run_audio_tiers(
            &ffmpeg,
            path,
            &tmp,
            &video_args,
            timeout,
            total_us,
            attempt,
            progress_cb,
        ) {
            Ok(tier) => {
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
                // 两只档各自一条预算（共用目录，靠文件名分）：remux 是 4GB 的易耗缓存，
                // 转码产物是「为手机转好的片子」，混在一起会让批量转完的被后续 remux 挤掉。
                trim_cache(&dir, cache_limit_for(profile), profile);
                log::info!(
                    "[video_remux] 完成 {:?} 档（第 {} 试，音轨 {:?}，超时上限 {:?}）-> {}",
                    profile,
                    attempt + 1,
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
            Err(e) => {
                let _ = std::fs::remove_file(&tmp);
                last_error = Some(e);
                attempt += 1;
            }
        }
    }
}

/// 音轨三级降级链（D4）：`copy → aac → 去音轨`，视频轨参数由调用方给（全程 `-c copy`
/// 或全程重编，**不在这里变**）。返回成功那一跑的音轨档，全失败则回最后一条错误。
fn run_audio_tiers(
    ffmpeg: &Path,
    path: &str,
    tmp: &Path,
    video_args: &[String],
    timeout: Duration,
    total_us: Option<u64>,
    attempt: usize,
    on_progress: &mut dyn FnMut(f32),
) -> Result<AudioTier, String> {
    let mut tier = AudioTier::Copy;
    loop {
        let audio_args = tier.args();
        match remux_once(
            ffmpeg,
            path,
            tmp,
            &video_args,
            &audio_args,
            timeout,
            total_us,
            on_progress,
        ) {
            Ok(()) => return Ok(tier),
            Err(e) => {
                log::warn!(
                    "[video_remux] 第 {} 试 + 音轨 {:?} 失败（{}）- {}",
                    attempt + 1,
                    tier,
                    e,
                    path
                );
                match tier.next() {
                    Some(next) => tier = next,
                    None => return Err(e),
                }
            }
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

/// 后台任务走哪条口径。
enum JobKind {
    /// 桌面前端：remux 档，`force` 决定是否连原生容器也重封装。
    Desktop { force: bool },
    /// 安卓客户端：按编码挑档，必要时自动升转码档。
    Client {
        codec: Option<String>,
        total_us: Option<u64>,
        hints: EncodeHints,
    },
}

/// 起后台产物任务（**同路径去并发**）：连点/快速翻页只起一个 ffmpeg 进程。
/// `app = Some` 时进度走 `PROGRESS_EVENT` 推给桌面前端；`None` 时（LAN 侧）只更新任务表，
/// 由客户端轮询 [`job_snapshot`] —— LAN 客户端收不到 Tauri 事件，只能自己问。
fn start_job(path: String, kind: JobKind, app: Option<tauri::AppHandle>) -> RemuxStateDto {
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
        // 中间进度：200ms 节流（ffmpeg 每几十毫秒就有一次变化，原样透传会刷屏）。
        let mut last_emit = Instant::now();
        let mut emit_cb = |p: f32| {
            let now = Instant::now();
            if now.duration_since(last_emit) < Duration::from_millis(200) {
                return;
            }
            last_emit = now;
            {
                let mut s = shared_bg.lock().unwrap();
                s.progress = p;
            }
            if let Some(app) = app.as_ref() {
                let snap = RemuxStateDto {
                    path: path_bg.clone(),
                    status: RemuxStatus::Pending,
                    progress: p,
                    output_path: None,
                    message: None,
                };
                let _ = app.emit(PROGRESS_EVENT, &snap);
            }
        };
        let result = match &kind {
            JobKind::Desktop { force } => ensure_sync_inner(&path_bg, *force, Some(&mut emit_cb)),
            JobKind::Client { codec, total_us, hints } => {
                ensure_for_client(&path_bg, codec.as_deref(), *total_us, *hints, Some(&mut emit_cb))
            }
        };
        {
            let mut s = shared_bg.lock().unwrap();
            s.status = result.status;
            s.progress = result.progress;
            s.output = result.output_path.as_ref().map(PathBuf::from);
            s.message = result.message.clone();
        }
        if let Some(app) = app.as_ref() {
            let _ = app.emit(PROGRESS_EVENT, &result);
        }
    });

    RemuxStateDto {
        path,
        status: RemuxStatus::Pending,
        progress: 0.0,
        output_path: None,
        message: None,
    }
}

/// 查在途/已完成任务的当前快照（LAN 轮询用）。
pub fn job_snapshot(path: &str) -> Option<RemuxStateDto> {
    let tasks = TASKS.lock().unwrap();
    tasks.get(path).map(|shared| {
        let s = shared.lock().unwrap();
        s.dto(path)
    })
}

/// 命令版本：命中缓存直接返回，否则**后台转封装**并立刻返回 `Pending`；
/// 进度与完成通过 `PROGRESS_EVENT` 推送（前端据此换 src）。
/// `force`：见 [`ensure_sync_force`]——原生容器直播失败后的兜底。
pub fn ensure_async(app: tauri::AppHandle, path: String, force: bool) -> RemuxStateDto {
    // 原生可解 / 缓存命中：两条都不需要后台任务。
    if !force && is_direct_playable(&path) {
        return RemuxStateDto {
            path: path.clone(),
            status: RemuxStatus::Direct,
            progress: 1.0,
            output_path: None,
            message: None,
        };
    }
    if let Some(cached) = desktop_product_for(&path) {
        return RemuxStateDto {
            path: path.clone(),
            status: RemuxStatus::Ready,
            progress: 1.0,
            output_path: Some(cached.to_string_lossy().into_owned()),
            message: None,
        };
    }
    start_job(path, JobKind::Desktop { force }, Some(app))
}

/// **LAN 侧入口**：为安卓客户端确保一份可播产物，语义与 [`ensure_async`] 一致
/// （命中缓存即刻 `Ready`，否则起后台任务并立刻返回 `Pending`）。
///
/// 档位交给 [`pick_profile`] 判：**只有实测解得动的编码才走 remux**，
/// 未知编码（含 revelo 整只读不出的 ASF）一律走转码档 —— 赌 remux 赌输的产物
/// 手机照样播不了，客户端只会拿到一个换了壳的坏文件。
/// `hints`（宽高/帧率）只影响转码档的目标码率。
pub fn ensure_async_for_client(
    path: String,
    codec: Option<String>,
    total_us: Option<u64>,
    hints: EncodeHints,
) -> RemuxStateDto {
    let profile = pick_profile(codec.as_deref());
    if let Some(cached) = probe_cached(&path, profile) {
        return RemuxStateDto {
            path: path.clone(),
            status: RemuxStatus::Ready,
            progress: 1.0,
            output_path: Some(cached.to_string_lossy().into_owned()),
            message: None,
        };
    }
    start_job(path, JobKind::Client { codec, total_us, hints }, None)
}

/// 统计产物占用（设置面板显示 + 清理入口）。**remux 档**。
pub fn stats() -> RemuxStats {
    profile_stats(VideoProfile::Remux)
}

/// 统计**转码档**产物占用。与 [`stats`] 同目录，只数自己那批文件名。
pub fn transcode_stats() -> RemuxStats {
    profile_stats(VideoProfile::Transcode)
}

fn profile_stats(profile: VideoProfile) -> RemuxStats {
    let limit = cache_limit_for(profile);
    let mut out = RemuxStats { files: 0, bytes: 0, limit_bytes: limit };
    let Some(dir) = products_dir() else { return out };
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for e in entries.flatten() {
            let name = e.file_name().to_string_lossy().to_string();
            if !file_belongs_to_profile(&name, profile) {
                continue;
            }
            if let Ok(meta) = e.metadata() {
                if meta.is_file() {
                    out.files += 1;
                    out.bytes += meta.len();
                }
            }
        }
    }
    out
}

/// 清空 **remux 档**产物（并重置任务表 —— 清理后需要能重新生成）。
/// 转码产物不在这里的射程内：那是「为手机转好的片子」，删了就得重编几十分钟，
/// 单独走 [`clear_transcode_cache`]，设置面板上也是两个不同的按钮。
/// 所以**不能**整目录删 —— 两只档现在同住一处。
pub fn clear_cache() -> RemuxStats {
    clear_profile(VideoProfile::Remux);
    let mut tasks = TASKS.lock().unwrap();
    tasks.clear();
    stats()
}

/// 清空**转码档**产物。
pub fn clear_transcode_cache() -> RemuxStats {
    clear_profile(VideoProfile::Transcode);
    transcode_stats()
}

fn clear_profile(profile: VideoProfile) {
    let Some(dir) = products_dir() else { return };
    let Ok(entries) = std::fs::read_dir(&dir) else { return };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if file_belongs_to_profile(&name, profile) {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

// ── Tauri 命令 ───────────────────────────────────────────────────────────

/// 告诉后端「当前资源根是哪个」，据此算产物目录（媒体盘上的
/// `<根>/.Aurora_Cache/video-products`）。
///
/// 为什么需要这条：产物是 GB 级的，而本机 C: 只剩 20GB —— 默认回落目录在
/// `%LOCALAPPDATA%`，两三支 1~2GB 的 avi 就能把系统盘推到底。LAN 侧自己按会话根算，
/// 桌面侧只能由前端在**启动时**与**切根后**各报一次（切根必须重报，否则产物会
/// 继续往老库的目录里写）。
#[tauri::command]
pub fn video_products_configure(resource_root: String) -> Result<Option<String>, String> {
    let root = resource_root.trim().to_string();
    if root.is_empty() {
        return Err("resource_root 为空".to_string());
    }
    let dir = products_dir_for_root(&root);
    set_products_dir(&dir);
    Ok(Some(dir.to_string_lossy().into_owned()))
}

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

/// 只查缓存（悬停预览用，绝不触发转换）。选法与 [`desktop_product_for`] 一致：
/// 转码产物优先（Chromium 一定解得了），再退回 remux 产物。
#[tauri::command]
pub async fn video_remux_probe(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        desktop_product_for(&path).map(|p| p.to_string_lossy().into_owned())
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
        let a = cache_file_name(p, VideoProfile::Remux).unwrap();
        let b = cache_file_name(p, VideoProfile::Remux).unwrap();
        assert_eq!(a, b);
        assert!(a.ends_with(&format!("-v{}.mp4", REMUX_CACHE_VERSION)), "{}", a);
        assert!(a.len() > REMUX_CACHE_VERSION.to_string().len() + 8);
        // 转码档必须另起一只名，否则「先 remux 后转码」会互相覆盖
        let t = cache_file_name(p, VideoProfile::Transcode).unwrap();
        assert_ne!(t, a);
        assert!(t.ends_with(&format!("-v{}-t.mp4", REMUX_CACHE_VERSION)), "{}", t);
    }

    /// 安卓的容器清单**不等于**桌面的：AVI/WMV 在桌面属「remux 后可播」，
    /// 在安卓属「连解封装都进不去，必须先产物化」。两条表各自独立，改一条不必动另一条。
    #[test]
    fn android_container_list_follows_the_real_device_extractor_inventory() {
        // 实测来源：2026-10-19 NOH-AL00 `dumpsys media.extractor`
        for ext in ["mp4", "m4v", "mov", "3gp", "webm", "mkv", "ts", "m2ts"] {
            assert!(is_android_playable(&format!("/x/v.{}", ext)), "{}", ext);
        }
        for ext in ["avi", "wmv", "asf", "flv", "mpg", "mpeg", "vob"] {
            assert!(!is_android_playable(&format!("/x/v.{}", ext)), "{}", ext);
        }
        assert!(!is_android_playable("/x/video"));
        // 大小写不敏感
        assert!(!is_android_playable("/x/V.AVI"));
    }

    /// 编码门：白名单外的（含未知）一律转码档。字符串口径取自 2026-10-19 真样本打印。
    #[test]
    fn codec_gate_is_a_whitelist_not_a_blacklist() {
        // 实测「换包装就能播」的两类
        assert_eq!(pick_profile(Some("AVC")), VideoProfile::Remux);
        assert_eq!(pick_profile(Some("MPEG-4 Visual")), VideoProfile::Remux);
        assert_eq!(pick_profile(Some(" avc ")), VideoProfile::Remux);
        // 实测解不动的：VC-1/WMV3（解码器声明了拉不起来）、JPEG(=MJPEG，无解码器)
        assert_eq!(pick_profile(Some("WMV3")), VideoProfile::Transcode);
        assert_eq!(pick_profile(Some("VC-1")), VideoProfile::Transcode);
        assert_eq!(pick_profile(Some("JPEG")), VideoProfile::Transcode);
        // 未知 / 读不出（revelo 对 ASF 整只失败）→ 按解不动处理，走一定成的那条
        assert_eq!(pick_profile(None), VideoProfile::Transcode);
        assert_eq!(pick_profile(Some("")), VideoProfile::Transcode);
    }

    /// `android_product_for` 的三条边界（2026-10-19）：图片不改道、手机能解的容器不改道、
    /// 没备过产物不改道；而 remux 备好之后必须改到产物上。
    #[test]
    fn product_swap_boundaries_and_hit_after_remux() {
        // ① 图片：连文件系统都不该碰
        assert_eq!(android_product_for(Path::new("/x/pic.jpg")), None);
        assert_eq!(android_product_for(Path::new("/x/pic.PNG")), None);
        // ② 手机可直接解的容器：有历史产物也不换
        assert_eq!(android_product_for(Path::new("/x/v.mp4")), None);
        assert_eq!(android_product_for(Path::new("/x/v.mkv")), None);
        // ③ 不可播容器但还没备过 → 发源文件
        assert_eq!(android_product_for(Path::new("Q:/definitely/not/here.wmv")), None);

        // ④ 备过就有产物
        let s = "../log/SVID_20261006_213438_1.avi";
        if !Path::new(s).exists() || locate().is_none() {
            eprintln!("[skip] 样本或 ffmpeg 缺失，跳过产物改道实测");
            return;
        }
        let dto = ensure_sync_force(s);
        assert_eq!(dto.status, RemuxStatus::Ready, "{:?}", dto.message);
        let got = android_product_for(Path::new(s));
        assert_eq!(
            got.as_deref(),
            Some(std::path::Path::new(dto.output_path.as_deref().unwrap())),
            "AVI 备完产物后，手机请求应改发到产物"
        );
    }

    /// 手机驱动的那条状态机（2026-10-19 备播端点的核心约定）：
    /// 首问立刻回 `Pending`（**绝不把 HTTP 请求挂在转换上**），之后靠轮询拿快照，
    /// 最终必须落到 `Ready` + 产物路径。
    #[test]
    fn client_async_flow_goes_pending_then_ready_by_polling() {
        // 用合成探针片，别和上面几只样本的产物测试抢同一个键
        let s = "../log/FormatProbeMpeg4.avi";
        if !Path::new(s).exists() || locate().is_none() {
            eprintln!("[skip] 样本或 ffmpeg 缺失");
            return;
        }
        let profile = pick_profile(Some("MPEG-4 Visual"));
        assert_eq!(profile, VideoProfile::Remux);
        if let Some(old) = cache_path_for(s, profile) {
            let _ = std::fs::remove_file(&old);
        }

        let first = ensure_async_for_client(
            s.to_string(),
            Some("MPEG-4 Visual".to_string()),
            None,
            EncodeHints::default(),
        );
        assert_eq!(first.status, RemuxStatus::Pending, "{:?}", first.message);
        assert!(first.output_path.is_none(), "Pending 不该给产物路径");

        let started = Instant::now();
        loop {
            let snap = job_snapshot(s).expect("任务表里应有这一条");
            match snap.status {
                RemuxStatus::Ready => {
                    assert!(snap.output_path.is_some());
                    assert!(snap.progress >= 1.0);
                    break;
                }
                RemuxStatus::Pending | RemuxStatus::Direct => {
                    assert!(
                        started.elapsed() < Duration::from_secs(60),
                        "轮询超时（{}）",
                        started.elapsed().as_secs()
                    );
                    std::thread::sleep(Duration::from_millis(50));
                }
                RemuxStatus::Failed => panic!("不该失败: {:?}", snap.message),
            }
        }
        // 落定后再问一次：必须直接命中缓存，不再起第二个进程
        let again = ensure_async_for_client(
            s.to_string(),
            Some("MPEG-4 Visual".to_string()),
            None,
            EncodeHints::default(),
        );
        assert_eq!(again.status, RemuxStatus::Ready, "{:?}", again.message);
    }

    /// 两只产物同时存在时，**桌面与手机各挑各的**（2026-10-19 补）：
    /// 桌面挑转码档（Chromium 解不了 remux 出来的 MPEG-4 Visual，只能解 H.264），
    /// 手机挑 remux 档（实测它的 mpeg4 硬解拉得起来，无损那份更该先给）。
    #[test]
    fn desktop_prefers_transcode_while_android_prefers_lossless_remux() {
        // 独占样本：`client_async_flow_*` 那条会先删掉自己的产物再跑，共用一只会互相踩
        let s = "../log/FormatProbeMpeg4b.avi";
        if !Path::new(s).exists() || locate().is_none() {
            eprintln!("[skip] 样本或 ffmpeg 缺失");
            return;
        }
        let remux = ensure_sync_force(s);
        assert_eq!(remux.status, RemuxStatus::Ready, "{:?}", remux.message);
        let trans = ensure_for_client(
            s,
            Some("JPEG"),
            None,
            EncodeHints::default(),
            None::<&mut dyn FnMut(f32)>,
        );
        assert_eq!(trans.status, RemuxStatus::Ready, "{:?}", trans.message);
        let remux_out = remux.output_path.expect("remux 产物");
        let trans_out = trans.output_path.expect("转码产物");
        assert_ne!(remux_out, trans_out, "两只档必须各留一份产物");

        // 桌面：转码产物优先
        assert_eq!(
            desktop_product_for(s).map(|p| p.to_string_lossy().into_owned()),
            Some(trans_out.clone()),
            "桌面要挑 Chromium 一定解得了的那只"
        );
        // 手机：编码已知可解（MPEG-4 Visual）→ 挑无损那只
        assert_eq!(
            android_product_for(Path::new(s)).map(|p| p.to_string_lossy().into_owned()),
            Some(remux_out),
            "手机该拿无损的 remux 产物"
        );
    }

    /// 转码档集成测试：真 ffmpeg + `log/` 样本，产物必须存在且**明显小于源**
    /// （重编码不是拷贝，不能用 remux 那条 ±10% 体积判据）。
    #[test]
    fn transcode_profile_produces_a_playable_mp4_when_ffmpeg_present() {
        let Some((_ffmpeg, _)) = locate() else {
            eprintln!("[skip] 本机无 ffmpeg，跳过转码集成测试");
            return;
        };
        let s = "../log/SVID_20261006_213438_1.avi";
        if !Path::new(s).exists() {
            eprintln!("[skip] 样本缺失: {}", s);
            return;
        }
        let src_size = std::fs::metadata(s).map(|m| m.len()).unwrap_or(0);
        let started = Instant::now();
        // 编码未知 → 走 ensure_for_client 的默认（先 remux）。这里直接点转码档，
        // 测的就是「B 类那条路能不能出产物」本身。
        let dto = ensure_for_client(
            s,
            Some("WMV3"),
            None,
            EncodeHints { width: 704, height: 396, fps: 29.97 },
            None::<&mut dyn FnMut(f32)>,
        );
        println!(
            "[transcode] {:?} 用时 {:?} msg={:?}",
            dto.status,
            started.elapsed(),
            dto.message
        );
        assert_eq!(dto.status, RemuxStatus::Ready, "转码应成功: {:?}", dto.message);
        let out = dto.output_path.clone().expect("应返回产物路径");
        let out_size = std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        assert!(out_size > 0);
        assert!(
            out_size < src_size,
            "重编码产物不该比源大：{} vs {}",
            out_size,
            src_size
        );
        // 二次调用必须命中转码档缓存（不重编）
        let again = ensure_for_client(
            s,
            Some("WMV3"),
            None,
            EncodeHints { width: 704, height: 396, fps: 29.97 },
            None::<&mut dyn FnMut(f32)>,
        );
        assert_eq!(again.output_path.as_deref(), Some(out.as_str()));
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
