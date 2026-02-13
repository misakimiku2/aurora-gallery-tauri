use serde::{Deserialize, Serialize};
use std::fs::OpenOptions;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::Emitter;
use futures_util::StreamExt;

/// 下载状态
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DownloadState {
    Idle,
    Downloading,
    Paused,
    Completed,
    Error,
}

impl std::fmt::Display for DownloadState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            DownloadState::Idle => write!(f, "idle"),
            DownloadState::Downloading => write!(f, "downloading"),
            DownloadState::Paused => write!(f, "paused"),
            DownloadState::Completed => write!(f, "completed"),
            DownloadState::Error => write!(f, "error"),
        }
    }
}

/// 下载进度信息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DownloadProgress {
    pub state: String,
    pub progress: f64,        // 0.0 - 100.0
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
    pub speed_bytes_per_sec: u64,
    pub file_path: String,
    pub error_message: Option<String>,
}

impl DownloadProgress {
    fn new(state: DownloadState, file_path: String) -> Self {
        Self {
            state: state.to_string(),
            progress: 0.0,
            downloaded_bytes: 0,
            total_bytes: 0,
            speed_bytes_per_sec: 0,
            file_path,
            error_message: None,
        }
    }
}

/// 更新下载器
pub struct UpdateDownloader {
    state: Arc<Mutex<DownloadState>>,
    downloaded_bytes: Arc<AtomicU64>,
    total_bytes: Arc<AtomicU64>,
    speed_bytes_per_sec: Arc<AtomicU64>,
    file_path: Arc<Mutex<PathBuf>>,
    installer_url: Arc<Mutex<Option<String>>>,
    is_cancelled: Arc<AtomicBool>,
    is_paused: Arc<AtomicBool>,
    download_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    last_emit_time: Arc<Mutex<Instant>>,
}

impl UpdateDownloader {
    /// 创建新的下载器实例
    pub fn new() -> Self {
        Self {
            state: Arc::new(Mutex::new(DownloadState::Idle)),
            downloaded_bytes: Arc::new(AtomicU64::new(0)),
            total_bytes: Arc::new(AtomicU64::new(0)),
            speed_bytes_per_sec: Arc::new(AtomicU64::new(0)),
            file_path: Arc::new(Mutex::new(PathBuf::new())),
            installer_url: Arc::new(Mutex::new(None)),
            is_cancelled: Arc::new(AtomicBool::new(false)),
            is_paused: Arc::new(AtomicBool::new(false)),
            download_handle: Arc::new(Mutex::new(None)),
            last_emit_time: Arc::new(Mutex::new(Instant::now())),
        }
    }

    /// 开始下载
    pub async fn start_download(
        &self,
        installer_url: &str,
        version: &str,
        app_handle: tauri::AppHandle,
    ) -> Result<(), String> {
        // 检查是否已经在下载中
        {
            let state = self.state.lock().map_err(|e| e.to_string())?;
            if *state == DownloadState::Downloading {
                return Err("Download already in progress".to_string());
            }
        }

        // 获取下载目录
        let download_dir = self.get_download_dir()?;
        let file_name = format!("Aurora_Gallery_{}_x64-setup.exe", version);
        let file_path = download_dir.join(&file_name);

        // 如果文件已存在且已完成，直接返回完成状态
        if file_path.exists() {
            let metadata = std::fs::metadata(&file_path)
                .map_err(|e| format!("Failed to read file metadata: {}", e))?;
            if metadata.len() > 0 {
                self.set_state(DownloadState::Completed);
                self.file_path.lock().map_err(|e| e.to_string())?.clone_from(&file_path);
                self.downloaded_bytes.store(metadata.len(), Ordering::SeqCst);
                self.emit_progress(&app_handle);
                return Ok(());
            }
        }

        // 确保下载目录存在
        std::fs::create_dir_all(&download_dir)
            .map_err(|e| format!("Failed to create download directory: {}", e))?;

        // 存储文件路径和URL
        *self.file_path.lock().map_err(|e| e.to_string())? = file_path.clone();
        *self.installer_url.lock().map_err(|e| e.to_string())? = Some(installer_url.to_string());

        // 重置状态
        self.set_state(DownloadState::Downloading);
        self.is_cancelled.store(false, Ordering::SeqCst);
        self.is_paused.store(false, Ordering::SeqCst);
        self.downloaded_bytes.store(0, Ordering::SeqCst);
        self.total_bytes.store(0, Ordering::SeqCst);
        self.speed_bytes_per_sec.store(0, Ordering::SeqCst);

        // 获取已下载的字节数（断点续传）
        let resume_from = if file_path.exists() {
            std::fs::metadata(&file_path)
                .map(|m| m.len())
                .unwrap_or(0)
        } else {
            0
        };
        self.downloaded_bytes.store(resume_from, Ordering::SeqCst);

        // 克隆 Arc 用于异步任务
        let state = Arc::clone(&self.state);
        let downloaded_bytes = Arc::clone(&self.downloaded_bytes);
        let total_bytes = Arc::clone(&self.total_bytes);
        let speed_bytes_per_sec = Arc::clone(&self.speed_bytes_per_sec);
        let file_path_arc = Arc::clone(&self.file_path);
        let is_cancelled = Arc::clone(&self.is_cancelled);
        let is_paused = Arc::clone(&self.is_paused);
        let last_emit_time = Arc::clone(&self.last_emit_time);
        let url = installer_url.to_string();

        // 启动下载任务
        let handle = tokio::spawn(async move {
            let file_path_clone = file_path_arc.lock().unwrap().clone();
            let result = Self::download_task(
                &url,
                &file_path_clone,
                resume_from,
                Arc::clone(&state),
                downloaded_bytes,
                total_bytes,
                speed_bytes_per_sec,
                is_cancelled,
                is_paused,
                &app_handle,
                last_emit_time,
            ).await;

            if let Err(e) = result {
                log::error!("Download failed: {}", e);
                let mut state_guard = state.lock().unwrap();
                *state_guard = DownloadState::Error;
                drop(state_guard);
                
                // 发送错误状态
                let progress = DownloadProgress {
                    state: DownloadState::Error.to_string(),
                    progress: 0.0,
                    downloaded_bytes: 0,
                    total_bytes: 0,
                    speed_bytes_per_sec: 0,
                    file_path: file_path_clone.to_string_lossy().to_string(),
                    error_message: Some(e),
                };
                let _ = app_handle.emit("update-download-progress", progress);
            }
        });

        *self.download_handle.lock().map_err(|e| e.to_string())? = Some(handle);

        Ok(())
    }

    /// 暂停下载
    pub fn pause_download(&self) -> Result<(), String> {
        let state = self.state.lock().map_err(|e| e.to_string())?;
        if *state != DownloadState::Downloading {
            return Err("Download is not in progress".to_string());
        }
        drop(state);

        self.is_paused.store(true, Ordering::SeqCst);
        self.set_state(DownloadState::Paused);
        Ok(())
    }

    /// 继续下载
    pub async fn resume_download(&self, app_handle: tauri::AppHandle) -> Result<(), String> {
        {
            let state = self.state.lock().map_err(|e| e.to_string())?;
            if *state != DownloadState::Paused {
                return Err("Download is not paused".to_string());
            }
        }

        // 获取保存的URL
        let url = self.installer_url.lock()
            .map_err(|e| e.to_string())?
            .clone()
            .ok_or("No download URL found")?;

        // 获取版本号（从文件名中提取）
        let version = {
            let file_path = self.file_path.lock().map_err(|e| e.to_string())?;
            file_path.file_stem()
                .and_then(|s| s.to_str())
                .and_then(|s| s.strip_prefix("Aurora_Gallery_"))
                .and_then(|s| s.strip_suffix("_x64-setup"))
                .unwrap_or("unknown")
                .to_string()
        };

        // 重新开始下载（会自动断点续传）
        self.start_download(&url, &version, app_handle).await
    }

    /// 取消下载
    pub fn cancel_download(&self) -> Result<(), String> {
        self.is_cancelled.store(true, Ordering::SeqCst);
        self.set_state(DownloadState::Idle);
        
        // 取消下载任务
        if let Some(handle) = self.download_handle.lock().map_err(|e| e.to_string())?.take() {
            handle.abort();
        }

        Ok(())
    }

    /// 获取下载进度
    pub fn get_progress(&self) -> Result<DownloadProgress, String> {
        let state = self.state.lock().map_err(|e| e.to_string())?;
        let file_path = self.file_path.lock().map_err(|e| e.to_string())?;
        let downloaded = self.downloaded_bytes.load(Ordering::SeqCst);
        let total = self.total_bytes.load(Ordering::SeqCst);
        let speed = self.speed_bytes_per_sec.load(Ordering::SeqCst);

        let progress = if total > 0 {
            (downloaded as f64 / total as f64) * 100.0
        } else {
            0.0
        };

        Ok(DownloadProgress {
            state: state.to_string(),
            progress,
            downloaded_bytes: downloaded,
            total_bytes: total,
            speed_bytes_per_sec: speed,
            file_path: file_path.to_string_lossy().to_string(),
            error_message: None,
        })
    }

    /// 安装更新
    pub fn install_update(&self) -> Result<(), String> {
        let file_path = self.file_path.lock().map_err(|e| e.to_string())?;
        
        if !file_path.exists() {
            return Err("Installer file not found".to_string());
        }

        let path_str = file_path.to_string_lossy().to_string();

        // 启动安装程序
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            Command::new("cmd")
                .args(["/C", "start", "", &path_str])
                .spawn()
                .map_err(|e| format!("Failed to start installer: {}", e))?;
        }

        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            Command::new("open")
                .arg(&path_str)
                .spawn()
                .map_err(|e| format!("Failed to start installer: {}", e))?;
        }

        #[cfg(target_os = "linux")]
        {
            use std::process::Command;
            Command::new("xdg-open")
                .arg(&path_str)
                .spawn()
                .map_err(|e| format!("Failed to start installer: {}", e))?;
        }

        Ok(())
    }

    /// 打开下载文件夹
    pub fn open_download_folder(&self) -> Result<(), String> {
        let file_path = self.file_path.lock().map_err(|e| e.to_string())?;
        let folder_path = file_path.parent()
            .ok_or("Invalid file path")?;

        let path_str = folder_path.to_string_lossy().to_string();

        // 打开文件夹
        #[cfg(target_os = "windows")]
        {
            use std::process::Command;
            Command::new("explorer")
                .arg(&path_str)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {}", e))?;
        }

        #[cfg(target_os = "macos")]
        {
            use std::process::Command;
            Command::new("open")
                .arg(&path_str)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {}", e))?;
        }

        #[cfg(target_os = "linux")]
        {
            use std::process::Command;
            Command::new("xdg-open")
                .arg(&path_str)
                .spawn()
                .map_err(|e| format!("Failed to open folder: {}", e))?;
        }

        Ok(())
    }

    /// 获取下载目录
    fn get_download_dir(&self) -> Result<PathBuf, String> {
        let home = std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map_err(|_| "Could not find home directory".to_string())?;

        let download_dir = if cfg!(windows) {
            PathBuf::from(home).join("AppData").join("Local").join("Aurora").join("Downloads")
        } else if cfg!(target_os = "macos") {
            PathBuf::from(home).join("Library").join("Application Support").join("Aurora").join("Downloads")
        } else {
            PathBuf::from(home).join(".local").join("share").join("aurora").join("downloads")
        };

        Ok(download_dir)
    }

    /// 设置下载状态
    fn set_state(&self, new_state: DownloadState) {
        if let Ok(mut state) = self.state.lock() {
            *state = new_state;
        }
    }

    /// 发送进度事件
    fn emit_progress(&self, app_handle: &tauri::AppHandle) {
        let mut last_emit = self.last_emit_time.lock().unwrap();
        // 限制发送频率，每100ms最多一次
        if last_emit.elapsed() < Duration::from_millis(100) {
            return;
        }
        *last_emit = Instant::now();
        drop(last_emit);

        if let Ok(progress) = self.get_progress() {
            let _ = app_handle.emit("update-download-progress", progress);
        }
    }

    /// 下载任务
    async fn download_task(
        url: &str,
        file_path: &PathBuf,
        resume_from: u64,
        state: Arc<Mutex<DownloadState>>,
        downloaded_bytes: Arc<AtomicU64>,
        total_bytes: Arc<AtomicU64>,
        speed_bytes_per_sec: Arc<AtomicU64>,
        is_cancelled: Arc<AtomicBool>,
        is_paused: Arc<AtomicBool>,
        app_handle: &tauri::AppHandle,
        last_emit_time: Arc<Mutex<Instant>>,
    ) -> Result<(), String> {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        // 构建请求，支持断点续传
        let mut request = client.get(url);
        if resume_from > 0 {
            request = request.header("Range", format!("bytes={}-", resume_from));
        }

        let response = request
            .send()
            .await
            .map_err(|e| format!("Failed to start download: {}", e))?;

        let status = response.status();
        if !status.is_success() && status != reqwest::StatusCode::PARTIAL_CONTENT {
            return Err(format!("HTTP error: {}", status));
        }

        // 获取文件总大小
        let content_length = response
            .headers()
            .get("content-length")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(0);

        let total = if status == reqwest::StatusCode::PARTIAL_CONTENT {
            resume_from + content_length
        } else {
            content_length
        };
        total_bytes.store(total, Ordering::SeqCst);

        // 如果不是断点续传，先删除已存在的文件
        if resume_from == 0 && file_path.exists() {
            std::fs::remove_file(file_path)
                .map_err(|e| format!("Failed to remove existing file: {}", e))?;
        }

        // 打开文件（追加模式用于断点续传）
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(file_path)
            .map_err(|e| format!("Failed to open file: {}", e))?;

        // 读取响应流
        let mut stream = response.bytes_stream();
        let mut last_speed_check = Instant::now();
        let mut bytes_since_last_check: u64 = 0;

        while let Some(chunk_result) = stream.next().await {
            // 检查是否取消
            if is_cancelled.load(Ordering::SeqCst) {
                return Err("Download cancelled".to_string());
            }

            // 检查是否暂停
            while is_paused.load(Ordering::SeqCst) {
                tokio::time::sleep(Duration::from_millis(100)).await;
                
                // 检查取消
                if is_cancelled.load(Ordering::SeqCst) {
                    return Err("Download cancelled".to_string());
                }
            }

            let chunk: bytes::Bytes = chunk_result.map_err(|e| format!("Download error: {}", e))?;
            let chunk_len = chunk.len() as u64;

            // 写入文件
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write to file: {}", e))?;

            // 更新已下载字节数
            let new_downloaded = downloaded_bytes.fetch_add(chunk_len, Ordering::SeqCst) + chunk_len;
            bytes_since_last_check += chunk_len;

            // 计算下载速度（每秒更新一次）
            if last_speed_check.elapsed() >= Duration::from_secs(1) {
                let speed = bytes_since_last_check;
                speed_bytes_per_sec.store(speed, Ordering::SeqCst);
                bytes_since_last_check = 0;
                last_speed_check = Instant::now();
            }

            // 发送进度事件
            {
                let mut last_emit = last_emit_time.lock().unwrap();
                if last_emit.elapsed() >= Duration::from_millis(100) {
                    *last_emit = Instant::now();
                    drop(last_emit);
                    
                    let progress = DownloadProgress {
                        state: DownloadState::Downloading.to_string(),
                        progress: if total > 0 {
                            (new_downloaded as f64 / total as f64) * 100.0
                        } else {
                            0.0
                        },
                        downloaded_bytes: new_downloaded,
                        total_bytes: total,
                        speed_bytes_per_sec: speed_bytes_per_sec.load(Ordering::SeqCst),
                        file_path: file_path.to_string_lossy().to_string(),
                        error_message: None,
                    };
                    let _ = app_handle.emit("update-download-progress", progress);
                }
            }
        }

        // 下载完成
        file.flush().map_err(|e| format!("Failed to flush file: {}", e))?;
        
        let mut state_guard = state.lock().unwrap();
        *state_guard = DownloadState::Completed;
        drop(state_guard);

        // 发送完成事件
        let progress = DownloadProgress {
            state: DownloadState::Completed.to_string(),
            progress: 100.0,
            downloaded_bytes: total,
            total_bytes: total,
            speed_bytes_per_sec: 0,
            file_path: file_path.to_string_lossy().to_string(),
            error_message: None,
        };
        let _ = app_handle.emit("update-download-progress", progress);

        Ok(())
    }
}

impl Default for UpdateDownloader {
    fn default() -> Self {
        Self::new()
    }
}

/// 全局下载器实例
use once_cell::sync::Lazy;
static GLOBAL_DOWNLOADER: Lazy<Arc<UpdateDownloader>> = Lazy::new(|| {
    Arc::new(UpdateDownloader::new())
});

/// 获取全局下载器实例
pub fn get_downloader() -> Arc<UpdateDownloader> {
    Arc::clone(&GLOBAL_DOWNLOADER)
}
