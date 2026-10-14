//! ffmpeg 下载器（P1.5-B S4，桌面专属）—— BtbN **LGPL** 静态构建 + SHA256 pin。
//!
//! 合规（计划 §8）：只取 lgpl 变体（绝不含 gyan/GPL）；URL 与 SHA256 写成常量 pin，
//! **pin 需定期检查有效性**（BtbN 每日构建只留 14 天 → 钉月末构建 tag，保留 2 年）。
//! 404 / 网络失败自动回退 `latest`（URL 恒定但内容每日变、无官方 checksum）：
//! 回退源**跳过 SHA256**，只做 zip 结构校验，并在进度事件里带 warning 由 UI 明示「来源未校验」。
//!
//! 形状对齐 CLIP 模型下载（`clip/model.rs`）：进度事件 200ms 节流、暂停/继续/取消
//! AtomicBool 标志、断点续传（HTTP Range）。事件名 `ffmpeg-download-progress`。

use serde::Serialize;
use std::io::Read;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tauri::Emitter;

// ── 下载源 pin（2026-10-14 现场取证 BtbN/FFmpeg-Builds releases）─────────────

/// 月末构建（保留 2 年）：n9.0 稳定分支，win64 **lgpl 静态** zip。
const PIN_URL: &str = "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n9.0.2-17-g2a571b6068-win64-lgpl-9.0.zip";
/// zip 全文件的 SHA256（指挥官环境实测 171,535,354 字节）。
const PIN_SHA256: &str = "6b264b9e6019103f601d98c292bd332fd87acf1c5e941ddff4fb71760fe63432";
const PIN_SIZE_BYTES: u64 = 171_535_354;
/// 兜底源：latest（内容每日变，仅按 zip 结构校验；UI 必须明示「来源未校验」）。
const FALLBACK_URL: &str =
    "https://github.com/BtbN/FFmpeg-Builds/releases/latest/download/ffmpeg-n9.0-latest-win64-lgpl-9.0.zip";

/// 下载进度事件名（形状对齐 `clip-model-download-progress`）。
const PROGRESS_EVENT: &str = "ffmpeg-download-progress";

static DOWNLOAD_CANCEL: AtomicBool = AtomicBool::new(false);
static DOWNLOAD_PAUSE: AtomicBool = AtomicBool::new(false);
/// 防重入：同一时刻只允许一个下载任务。
static DOWNLOAD_RUNNING: AtomicBool = AtomicBool::new(false);

/// 下载/解压的工作目录（与 `ffmpeg_cover::downloaded_ffmpeg_path` 同根）。
fn work_dir() -> Option<PathBuf> {
    crate::ffmpeg_cover::downloaded_ffmpeg_path()?.parent().map(|p| p.to_path_buf())
}

/// 下载进度载荷。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FfmpegDownloadProgress {
    pub downloaded: u64,
    pub total: u64,
    /// 0-100
    pub progress: u32,
    /// bytes/sec
    pub speed: u64,
    /// downloading | paused | verifying | extracting | completed | failed
    pub status: String,
    /// 回退 latest 时的告警（来源未校验）
    pub warning: Option<String>,
    pub error: Option<String>,
}

fn emit_progress(app: &tauri::AppHandle, p: FfmpegDownloadProgress) {
    let _ = app.emit(PROGRESS_EVENT, p);
}

fn progress(downloaded: u64, total: u64, status: &str) -> FfmpegDownloadProgress {
    FfmpegDownloadProgress {
        downloaded,
        total,
        progress: if total > 0 { (downloaded * 100 / total) as u32 } else { 0 },
        speed: 0,
        status: status.to_string(),
        warning: None,
        error: None,
    }
}

/// 启动下载（重入安全：已在跑时返回 Err）。完成后 `ffmpeg_status` 即可探测到新副本。
#[tauri::command]
pub async fn ffmpeg_download_start(app: tauri::AppHandle) -> Result<(), String> {
    if crate::ffmpeg_cover::locate().is_some() {
        return Err("ffmpeg 已可用，无需下载".to_string());
    }
    if DOWNLOAD_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("下载已在进行中".to_string());
    }
    // 重置取消/暂停标志（新任务从干净状态开始，照搬 CLIP 模式）
    DOWNLOAD_CANCEL.store(false, Ordering::SeqCst);
    DOWNLOAD_PAUSE.store(false, Ordering::SeqCst);

    let handle = app.clone();
    let result = tauri::async_runtime::spawn_blocking(move || run_download(&handle.clone()))
        .await
        .map_err(|e| format!("download task join failed: {}", e))
        .and_then(|r| r);
    DOWNLOAD_RUNNING.store(false, Ordering::SeqCst);
    // 失败也要推事件（UI 停在下载中态会永远转圈）；错误同时经 invoke reject 返回
    if let Err(e) = &result {
        emit_progress(
            &app,
            FfmpegDownloadProgress {
                status: "failed".to_string(),
                error: Some(e.clone()),
                ..progress(0, 0, "failed")
            },
        );
    }
    result
}

/// 暂停（断点续传挂起点）。
#[tauri::command]
pub fn ffmpeg_download_pause() -> Result<(), String> {
    if !DOWNLOAD_RUNNING.load(Ordering::SeqCst) {
        return Err("没有进行中的下载".to_string());
    }
    DOWNLOAD_PAUSE.store(true, Ordering::SeqCst);
    log::info!("[ffmpeg_download] pause requested");
    Ok(())
}

/// 继续（基于已下载字节数的 HTTP Range 续传）。
#[tauri::command]
pub fn ffmpeg_download_resume() -> Result<(), String> {
    DOWNLOAD_PAUSE.store(false, Ordering::SeqCst);
    log::info!("[ffmpeg_download] resume requested");
    Ok(())
}

/// 取消：中断下载并删除未完成的 part 文件（已解压安装的 exe 不受影响）。
#[tauri::command]
pub fn ffmpeg_download_cancel() -> Result<(), String> {
    DOWNLOAD_CANCEL.store(true, Ordering::SeqCst);
    // 取消时同时清除暂停标志，避免卡死在暂停等待中（照搬 CLIP）
    DOWNLOAD_PAUSE.store(false, Ordering::SeqCst);
    log::info!("[ffmpeg_download] cancel requested");
    Ok(())
}

/// 清理：删除整个 ffmpeg 下载目录（zip 残留 + 已装 exe）。用于「重新下载」。
#[tauri::command]
pub fn ffmpeg_download_cleanup() -> Result<(), String> {
    let Some(dir) = work_dir() else {
        return Err("无法解析 ffmpeg 下载目录".to_string());
    };
    if dir.exists() {
        std::fs::remove_dir_all(&dir).map_err(|e| format!("清理失败: {}", e))?;
    }
    log::info!("[ffmpeg_download] cleaned {:?}", dir);
    Ok(())
}

// ── 下载主流程 ────────────────────────────────────────────────────────────

fn run_download(app: &tauri::AppHandle) -> Result<(), String> {
    let Some(dir) = work_dir() else {
        return Err("无法解析 ffmpeg 下载目录".to_string());
    };
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建下载目录失败: {}", e))?;
    let zip_path = dir.join("ffmpeg.zip");
    let part_path = dir.join("ffmpeg.zip.part");

    // 断点续传起点：已有 part 文件且未超预期大小 → Range 续传
    let mut resume_from = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
    if resume_from >= PIN_SIZE_BYTES {
        let _ = std::fs::remove_file(&part_path);
        resume_from = 0;
    }

    // 客户端（参照 clip/model.rs：连接超时 + 总超时 + 浏览器 UA 防风控）
    let client = reqwest::blocking::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(600))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .map_err(|e| format!("HTTP client 构建失败: {}", e))?;

    // 主源 → 兜底 latest
    let mut warning: Option<String> = None;
    let (url, pinned) = match fetch_with_resume(&client, PIN_URL, &part_path, resume_from, app) {
        Ok(()) => (PIN_URL, true),
        Err(pin_err) => {
            log::warn!("[ffmpeg_download] pin 源失败（{}），回退 latest", pin_err);
            warning = Some(format!(
                "首选源不可用（{}），已回退 latest——该构建内容每日变化且无官方校验和，来源未经验证",
                pin_err
            ));
            if DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
                let _ = std::fs::remove_file(&part_path);
                return Err("已取消".to_string());
            }
            // 回退源从零下载（不同资产内容，续传字节没有意义）
            let _ = std::fs::remove_file(&part_path);
            fetch_with_resume(&client, FALLBACK_URL, &part_path, 0, app)?;
            (FALLBACK_URL, false)
        }
    };
    let _ = url;

    emit_progress(
        app,
        FfmpegDownloadProgress {
            status: "verifying".to_string(),
            ..progress(PIN_SIZE_BYTES, PIN_SIZE_BYTES, "verifying")
        },
    );

    // 完整性：pin 源严格校验大小 + SHA256；latest 只校验 zip 结构（计划 §6：UI 明示来源未校验）
    if pinned {
        let size = std::fs::metadata(&part_path).map(|m| m.len()).unwrap_or(0);
        if size != PIN_SIZE_BYTES {
            let _ = std::fs::remove_file(&part_path);
            return Err(format!("大小校验失败: expected {} got {}", PIN_SIZE_BYTES, size));
        }
        let actual = sha256_file(&part_path)?;
        if !actual.eq_ignore_ascii_case(PIN_SHA256) {
            let _ = std::fs::remove_file(&part_path);
            return Err(format!("SHA256 校验失败: expected {} got {}", PIN_SHA256, actual));
        }
    }

    emit_progress(
        app,
        FfmpegDownloadProgress {
            status: "extracting".to_string(),
            ..progress(PIN_SIZE_BYTES, PIN_SIZE_BYTES, "extracting")
        },
    );

    // 解压 bin/ffmpeg.exe + bin/ffprobe.exe（zip 顶层目录名带版本号，按后缀匹配）
    std::fs::rename(&part_path, &zip_path).map_err(|e| format!("重命名 zip 失败: {}", e))?;
    if let Err(e) = extract_binaries(&zip_path, &dir) {
        let _ = std::fs::remove_file(&zip_path);
        return Err(format!("解压失败: {}", e));
    }
    let _ = std::fs::remove_file(&zip_path);

    // 终验：新副本必须能被 locate + probe
    match crate::ffmpeg_cover::locate() {
        Some((path, source)) => match crate::ffmpeg_cover::probe_version(&path) {
            Some(version) => log::info!("[ffmpeg_download] installed: {:?} ({:?}) {}", path, source, version),
            None => return Err("安装后 ffmpeg -version 验证失败".to_string()),
        },
        None => return Err("安装后 locate 失败".to_string()),
    }

    emit_progress(
        app,
        FfmpegDownloadProgress {
            status: "completed".to_string(),
            warning,
            ..progress(PIN_SIZE_BYTES, PIN_SIZE_BYTES, "completed")
        },
    );
    Ok(())
}

/// 流式下载（支持 Range 断点续传 + 暂停挂起 + 取消删除），写 `<zip>.part`。
fn fetch_with_resume(
    client: &reqwest::blocking::Client,
    url: &str,
    part_path: &std::path::Path,
    resume_from: u64,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let mut request = client.get(url);
    if resume_from > 0 {
        request = request.header("Range", format!("bytes={}-", resume_from));
    }
    let response = request
        .send()
        .map_err(|e| format!("连接失败: {}", e))?;
    let status = response.status();
    if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
        return Err(format!("HTTP {} ({})", status, url));
    }

    let content_length = response.content_length().unwrap_or(0);
    let total = if status == reqwest::StatusCode::PARTIAL_CONTENT && resume_from > 0 {
        resume_from + content_length
    } else {
        content_length
    };

    let mut file = {
        use std::io::Write;
        if resume_from > 0 {
            std::fs::OpenOptions::new()
                .append(true)
                .open(part_path)
                .map_err(|e| format!("打开续传文件失败: {}", e))?
        } else {
            std::fs::File::create(part_path).map_err(|e| format!("创建下载文件失败: {}", e))?
        }
    };

    let mut reader = response;
    let mut downloaded = resume_from;
    let mut buf = [0u8; 64 * 1024];
    let mut last_emit = Instant::now();
    let mut last_speed_time = Instant::now() - Duration::from_secs(1);
    let mut last_speed_bytes = resume_from;
    let mut speed: u64 = 0;

    loop {
        if DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
            let _ = std::fs::remove_file(part_path);
            return Err("已取消".to_string());
        }
        if DOWNLOAD_PAUSE.load(Ordering::SeqCst) {
            {
                use std::io::Write;
                let _ = file.flush();
            }
            emit_progress(app, {
                let mut p = progress(downloaded, total, "paused");
                p.speed = speed;
                p
            });
            // 挂起等待恢复/取消（不占 CPU）
            while DOWNLOAD_PAUSE.load(Ordering::SeqCst) && !DOWNLOAD_CANCEL.load(Ordering::SeqCst) {
                std::thread::sleep(Duration::from_millis(100));
            }
            continue;
        }

        let n = reader
            .read(&mut buf)
            .map_err(|e| format!("读取数据失败: {}", e))?;
        if n == 0 {
            break;
        }
        {
            use std::io::Write;
            file.write_all(&buf[..n]).map_err(|e| format!("写入失败: {}", e))?;
        }
        downloaded += n as u64;

        let now = Instant::now();
        if now.duration_since(last_speed_time) >= Duration::from_millis(500) {
            let secs = now.duration_since(last_speed_time).as_secs_f64();
            if secs > 0.0 {
                speed = ((downloaded - last_speed_bytes) as f64 / secs) as u64;
            }
            last_speed_time = now;
            last_speed_bytes = downloaded;
        }
        if now.duration_since(last_emit) >= Duration::from_millis(200) {
            emit_progress(app, {
                let mut p = progress(downloaded, total, "downloading");
                p.speed = speed;
                p
            });
            last_emit = now;
        }
    }

    {
        use std::io::Write;
        file.flush().map_err(|e| format!("flush 失败: {}", e))?;
    }
    Ok(())
}

/// SHA256 校验（流式，163MB 内存占用恒定）。
fn sha256_file(path: &std::path::Path) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    let mut file = std::fs::File::open(path).map_err(|e| format!("打开文件失败: {}", e))?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 256 * 1024];
    loop {
        let n = file.read(&mut buf).map_err(|e| format!("读取失败: {}", e))?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}

/// 从 zip 里解出 `bin/ffmpeg.exe` 与 `bin/ffprobe.exe`（顶层目录名不写死，按后缀匹配）。
fn extract_binaries(zip_path: &std::path::Path, dest_dir: &std::path::Path) -> Result<(), String> {
    let file = std::fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败: {}", e))?;
    let mut archive =
        zip::ZipArchive::new(file).map_err(|e| format!("读取 zip 失败: {}", e))?;

    let mut extracted = 0usize;
    for i in 0..archive.len() {
        let mut entry = archive
            .by_index(i)
            .map_err(|e| format!("读取 zip 条目失败: {}", e))?;
        let name = entry.name().to_string();
        let Some(file_name) = name.rsplit('/').next() else { continue };
        if name.ends_with("/bin/ffmpeg.exe") {
            copy_entry(&mut entry, &dest_dir.join("ffmpeg.exe"))?;
            extracted += 1;
        } else if name.ends_with("/bin/ffprobe.exe") {
            copy_entry(&mut entry, &dest_dir.join("ffprobe.exe"))?;
            extracted += 1;
        }
        let _ = file_name;
    }
    if extracted < 1 {
        return Err("zip 内未找到 bin/ffmpeg.exe（资产结构可能已变更，需要更新 pin）".to_string());
    }
    Ok(())
}

fn copy_entry(
    entry: &mut zip::read::ZipFile<'_>,
    dest: &std::path::Path,
) -> Result<(), String> {
    let mut out = std::fs::File::create(dest).map_err(|e| format!("创建 {} 失败: {}", dest.display(), e))?;
    std::io::copy(entry, &mut out).map_err(|e| format!("解压 {} 失败: {}", dest.display(), e))?;
    log::info!("[ffmpeg_download] extracted {}", dest.display());
    Ok(())
}
