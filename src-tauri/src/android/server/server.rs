use axum::{
    routing::{get, post},
    Router,
};
use std::net::SocketAddr;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;
use tower_http::compression::CompressionLayer;

use super::handlers::*;
use super::types::*;
use crate::lan_share::device_manager::DeviceManager;
use crate::lan_share::session::SessionManager;
use crate::lan_share::types::SESSION_TIMEOUT_SECS;

/// 安卓端局域网共享 HTTP 服务端（与桌面端 LanShareServer 对称，
/// 数据来源为 MediaStore 而非文件系统）。
pub struct LanShareServer {
    config: Arc<tokio::sync::RwLock<AndroidLanServerConfig>>,
    sessions: Arc<SessionManager>,
    devices: Arc<DeviceManager>,
    cache_dir: Arc<PathBuf>,
    app_handle: Option<AppHandle>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_handle: Option<JoinHandle<()>>,
    cleanup_handle: Option<JoinHandle<()>>,
    local_ip: Option<String>,
    port: u16,
}

impl LanShareServer {
    pub fn new(cache_dir: PathBuf) -> Self {
        log::info!(
            "[LAN Share Android] 创建服务器实例 - 缓存目录: {}",
            cache_dir.display()
        );
        Self {
            config: Arc::new(tokio::sync::RwLock::new(
                AndroidLanServerConfig::default(),
            )),
            sessions: Arc::new(SessionManager::new()),
            devices: Arc::new(DeviceManager::new()),
            cache_dir: Arc::new(cache_dir),
            app_handle: None,
            shutdown_tx: None,
            server_handle: None,
            cleanup_handle: None,
            local_ip: None,
            port: 8080,
        }
    }

    pub async fn start(
        &mut self,
        config: AndroidLanServerConfig,
        app_handle: AppHandle,
    ) -> Result<AndroidLanServerInfo, String> {
        if self.server_handle.is_some() {
            log::warn!("[LAN Share Android] 启动失败 - 服务器已在运行中");
            return Err("Server is already running".to_string());
        }

        log::info!(
            "[LAN Share Android] 正在启动服务器... 端口: {}",
            config.port
        );

        let port = config.port;
        let local_ip = get_android_local_ip().unwrap_or_else(|| "127.0.0.1".to_string());
        log::info!("[LAN Share Android] 本机 IP: {}", local_ip);

        {
            let mut cfg = self.config.write().await;
            *cfg = config;
        }

        self.port = port;
        self.local_ip = Some(local_ip.clone());
        self.app_handle = Some(app_handle.clone());

        let app_state = AppState {
            config: self.config.clone(),
            sessions: self.sessions.clone(),
            devices: self.devices.clone(),
            cache_dir: self.cache_dir.clone(),
            app_handle: app_handle.clone(),
        };

        log::info!("[LAN Share Android] 注册 API 路由...");
        let app = Router::new()
            .route("/", get(handle_root))
            .route("/api/auth/verify", post(handle_auth))
            .route("/api/auth/logout", post(handle_logout))
            .route("/api/browse", get(handle_browse))
            .route("/api/palette", get(handle_palette))
            .route("/api/all_image_folders", get(handle_all_image_folders))
            .route("/api/search", get(handle_search))
            .route("/api/thumbnail", get(handle_thumbnail))
            .route("/api/image", get(handle_image))
            .route("/api/devices", get(handle_devices))
            .route("/api/heartbeat", get(handle_heartbeat))
            .layer(create_cors_layer())
            .layer(CompressionLayer::new())
            .with_state(app_state);

        let addr: SocketAddr = format!("0.0.0.0:{}", port)
            .parse()
            .map_err(|e| {
                log::error!("[LAN Share Android] 地址解析失败: {}", e);
                format!("Invalid address: {}", e)
            })?;

        log::info!("[LAN Share Android] 正在绑定端口 {}...", port);
        let listener = TcpListener::bind(addr).await.map_err(|e| {
            log::error!("[LAN Share Android] 端口绑定失败: {} - {}", port, e);
            format!("Failed to bind to port {}: {}", port, e)
        })?;
        log::info!("[LAN Share Android] 端口 {} 绑定成功", port);

        let (shutdown_tx, shutdown_rx) = oneshot::channel();
        self.shutdown_tx = Some(shutdown_tx);

        let server = axum::serve(
            listener,
            app.into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });

        let handle = tokio::spawn(async move {
            if let Err(e) = server.await {
                log::error!("[LAN Share Android] 服务器运行错误: {}", e);
            }
        });
        self.server_handle = Some(handle);

        let sessions = self.sessions.clone();
        let devices = self.devices.clone();
        let cleanup_app_handle = app_handle.clone();
        let cleanup_handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                sessions.cleanup_expired().await;
                let removed = devices.cleanup_inactive(SESSION_TIMEOUT_SECS).await;
                if removed > 0 {
                    if let Err(e) =
                        cleanup_app_handle.emit("lan-share-devices-changed", ())
                    {
                        log::warn!(
                            "[LAN Share Android] 清理后发送 lan-share-devices-changed 事件失败: {}",
                            e
                        );
                    }
                }
            }
        });
        self.cleanup_handle = Some(cleanup_handle);

        log::info!("========================================");
        log::info!("[LAN Share Android] 服务器启动成功!");
        log::info!("[LAN Share Android] 访问地址: http://{}:{}", local_ip, port);
        log::info!("========================================");

        Ok(AndroidLanServerInfo {
            url: format!("http://{}:{}", local_ip, port),
            port,
            local_ip,
        })
    }

    pub async fn stop(&mut self) {
        log::info!("[LAN Share Android] 正在停止服务器...");

        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            log::info!("[LAN Share Android] 已发送关闭信号");
        }

        if let Some(handle) = self.server_handle.take() {
            handle.abort();
            log::info!("[LAN Share Android] 服务器任务已终止");
        }

        if let Some(handle) = self.cleanup_handle.take() {
            handle.abort();
            log::info!("[LAN Share Android] 清理任务已终止");
        }

        self.local_ip = None;
        log::info!("[LAN Share Android] 服务器已完全停止");
    }

    pub async fn update_config(&self, config: AndroidLanServerConfig) {
        log::info!(
            "[LAN Share Android] 更新配置 - 端口: {}",
            config.port
        );
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    pub fn is_running(&self) -> bool {
        self.server_handle.is_some()
    }

    pub async fn get_status(&self) -> AndroidLanServerStatus {
        AndroidLanServerStatus {
            is_running: self.server_handle.is_some(),
            port: self.port,
            local_ip: self.local_ip.clone(),
            device_count: self.devices.get_device_count().await,
        }
    }

    pub async fn get_devices(&self) -> Vec<crate::lan_share::ConnectedDevice> {
        self.devices.get_devices().await
    }
}

/// 通过 JNI 调用 MainActivity.getLocalIpAddress() 获取本机局域网 IP。
fn get_android_local_ip_via_jni() -> Option<String> {
    let result: Result<String, String> = (|| {
        let activity = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
            .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
        let mut env = vm
            .attach_current_thread()
            .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
        let activity_obj = unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };

        let result = env
            .call_method(&activity_obj, "getLocalIpAddress", "()Ljava/lang/String;", &[])
            .map_err(|e| format!("Failed to call getLocalIpAddress: {:?}", e))?;
        let jstr = result
            .l()
            .map_err(|e| format!("Failed to get result: {:?}", e))?;
        if jstr.is_null() {
            return Ok(String::new());
        }
        let s: jni::objects::JString = jstr.into();
        let value: String = env
            .get_string(&s)
            .map_err(|e| format!("Failed to get string: {:?}", e))?
            .into();
        Ok(value)
    })();

    match result {
        Ok(ip) if !ip.is_empty() => Some(ip),
        _ => None,
    }
}

/// UDP 探测回退：绑定 0.0.0.0 后 connect 到公网地址（不发送任何数据包），
/// 由内核按默认路由选择出口网卡，从而得到本机局域网 IP。
/// 部分 ROM 上 WifiManager/ConnectivityManager 取不到 IP 时兜底。
fn get_android_local_ip_via_udp() -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    match socket.local_addr() {
        Ok(std::net::SocketAddr::V4(addr)) if !addr.ip().is_loopback() => {
            Some(addr.ip().to_string())
        }
        _ => None,
    }
}

/// 获取本机局域网 IP：JNI（WifiManager/ConnectivityManager）→ UDP 探测回退。
pub fn get_android_local_ip() -> Option<String> {
    if let Some(ip) = get_android_local_ip_via_jni() {
        log::info!("[LAN Share Android] 本机 IP (JNI): {}", ip);
        return Some(ip);
    }
    if let Some(ip) = get_android_local_ip_via_udp() {
        log::info!("[LAN Share Android] 本机 IP (UDP 探测): {}", ip);
        return Some(ip);
    }
    log::warn!("[LAN Share Android] 无法获取本机 IP");
    None
}
