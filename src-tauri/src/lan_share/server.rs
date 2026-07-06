use axum::{
    extract::DefaultBodyLimit,
    routing::{delete, get, post},
    Router,
};
use tower_http::compression::CompressionLayer;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::device_manager::DeviceManager;
use super::handlers::*;
use super::session::SessionManager;
use super::types::*;
use crate::db::AppDbPool;

// Build timestamp: 2026-03-12-force-rebuild-v2
// This comment forces Rust to recompile this file when static files change
static INDEX_HTML: &str = include_str!("../../static/lan-share/index.html");
static STYLE_CSS: &str = include_str!("../../static/lan-share/style.css");
static APP_JS: &str = include_str!("../../static/lan-share/app.js");

pub fn get_index_html() -> &'static str {
    log::info!("[LAN Share] get_index_html() 被调用, 长度: {} bytes", INDEX_HTML.len());
    INDEX_HTML
}

pub fn get_style_css() -> &'static str {
    log::info!("[LAN Share] get_style_css() 被调用, 长度: {} bytes", STYLE_CSS.len());
    STYLE_CSS
}

pub fn get_app_js() -> &'static str {
    log::info!("[LAN Share] get_app_js() 被调用, 长度: {} bytes, 包含 'React': {}", APP_JS.len(), APP_JS.contains("react") || APP_JS.contains("React"));
    APP_JS
}

pub struct LanShareServer {
    config: Arc<tokio::sync::RwLock<LanShareConfig>>,
    sessions: Arc<SessionManager>,
    devices: Arc<DeviceManager>,
    root_path: Arc<PathBuf>,
    db_pool: Option<Arc<AppDbPool>>,
    color_db_pool: Option<Arc<crate::color_db::ColorDbPool>>,
    app_handle: Option<AppHandle>,
    shutdown_tx: Option<oneshot::Sender<()>>,
    server_handle: Option<JoinHandle<()>>,
    cleanup_handle: Option<JoinHandle<()>>,
    local_ip: Option<String>,
    port: u16,
}

impl LanShareServer {
    pub fn new(root_path: PathBuf) -> Self {
        log::info!("[LAN Share] 创建服务器实例 - 根目录: {}", root_path.display());
        Self {
            config: Arc::new(tokio::sync::RwLock::new(LanShareConfig::default())),
            sessions: Arc::new(SessionManager::new()),
            devices: Arc::new(DeviceManager::new()),
            root_path: Arc::new(root_path),
            db_pool: None,
            color_db_pool: None,
            app_handle: None,
            shutdown_tx: None,
            server_handle: None,
            cleanup_handle: None,
            local_ip: None,
            port: 8080,
        }
    }

    pub fn with_db_pool(mut self, pool: Arc<AppDbPool>) -> Self {
        self.db_pool = Some(pool);
        self
    }

    pub fn with_color_db_pool(mut self, pool: Arc<crate::color_db::ColorDbPool>) -> Self {
        self.color_db_pool = Some(pool);
        self
    }

    pub async fn start(&mut self, config: LanShareConfig, app_handle: AppHandle) -> Result<LanShareInfo, String> {
        if self.server_handle.is_some() {
            log::warn!("[LAN Share] 启动失败 - 服务器已在运行中");
            return Err("Server is already running".to_string());
        }

        log::info!("[LAN Share] 正在启动服务器...");
        log::info!("[LAN Share] 配置 - 端口: {}, 允许编辑: {}, 允许上传: {}", 
            config.port, config.allow_edit, config.allow_upload);

        let port = config.port;
        let local_ip = get_local_lan_ip().ok_or_else(|| {
            log::error!("[LAN Share] 启动失败 - 无法获取本机局域网 IP 地址");
            "Failed to get local IP address".to_string()
        })?;
        
        log::info!("[LAN Share] 本机局域网 IP 地址: {}", local_ip);
        
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
            root_path: self.root_path.clone(),
            db_pool: self.db_pool.clone(),
            color_db_pool: self.color_db_pool.clone(),
            app_handle: app_handle.clone(),
        };

        log::info!("[LAN Share] 注册 API 路由...");
        let app = Router::new()
            .route("/", get(handle_root_html))
            .route("/style.css", get(handle_style_css))
            .route("/app.js", get(handle_app_js))
            .route("/api/auth/verify", post(handle_auth))
            .route("/api/auth/logout", post(handle_logout))
            .route("/api/browse", get(handle_browse))
            .route("/api/palette", get(handle_palette))
            .route("/api/all_image_folders", get(handle_all_image_folders))
            .route("/api/search", get(handle_search))
            .route("/api/thumbnail", get(handle_thumbnail))
            .route("/api/image", get(handle_image))
            .route("/api/file", delete(handle_delete))
            .route("/api/rename", post(handle_rename))
            .route("/api/upload", post(handle_upload).layer(DefaultBodyLimit::max(200 * 1024 * 1024)))
            .route("/api/devices", get(handle_devices))
            .route("/api/heartbeat", get(handle_heartbeat))
            .layer(create_cors_layer())
            .layer(CompressionLayer::new())
            .with_state(app_state);

        let addr: SocketAddr = format!("0.0.0.0:{}", port)
            .parse()
            .map_err(|e| {
                log::error!("[LAN Share] 地址解析失败: {}", e);
                format!("Invalid address: {}", e)
            })?;

        log::info!("[LAN Share] 正在绑定端口 {}...", port);
        let listener = TcpListener::bind(addr)
            .await
            .map_err(|e| {
                log::error!("[LAN Share] 端口绑定失败: {} - {}", port, e);
                format!("Failed to bind to port {}: {}", port, e)
            })?;

        log::info!("[LAN Share] 端口 {} 绑定成功", port);

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
                log::error!("[LAN Share] 服务器运行错误: {}", e);
            }
        });

        self.server_handle = Some(handle);

        let sessions = self.sessions.clone();
        let devices = self.devices.clone();
        let cleanup_app_handle = app_handle.clone();
        let cleanup_handle = tokio::spawn(async move {
            loop {
                tokio::time::sleep(Duration::from_secs(10)).await;
                log::debug!("[LAN Share] 执行定期清理 - 检查过期会话和设备");
                sessions.cleanup_expired().await;
                let removed = devices.cleanup_inactive(SESSION_TIMEOUT_SECS).await;
                if removed > 0 {
                    if let Err(e) = cleanup_app_handle.emit("lan-share-devices-changed", ()) {
                        log::warn!("[LAN Share] 清理后发送 lan-share-devices-changed 事件失败: {}", e);
                    }
                }
            }
        });
        self.cleanup_handle = Some(cleanup_handle);

        log::info!("========================================");
        log::info!("[LAN Share] 服务器启动成功!");
        log::info!("[LAN Share] 访问地址: http://{}:{}", local_ip, port);
        log::info!("[LAN Share] 根目录: {}", self.root_path.display());
        log::info!("========================================");

        Ok(LanShareInfo {
            url: format!("http://{}:{}", local_ip, port),
            port,
            local_ip: local_ip.clone(),
        })
    }

    pub async fn stop(&mut self) {
        log::info!("[LAN Share] 正在停止服务器...");
        
        if let Some(tx) = self.shutdown_tx.take() {
            let _ = tx.send(());
            log::info!("[LAN Share] 已发送关闭信号");
        }

        if let Some(handle) = self.server_handle.take() {
            handle.abort();
            log::info!("[LAN Share] 服务器任务已终止");
        }

        if let Some(handle) = self.cleanup_handle.take() {
            handle.abort();
            log::info!("[LAN Share] 清理任务已终止");
        }

        self.local_ip = None;
        log::info!("[LAN Share] 服务器已完全停止");
    }

    pub async fn update_config(&self, config: LanShareConfig) {
        log::info!("[LAN Share] 更新配置 - 端口: {}, 允许编辑: {}, 允许上传: {}", 
            config.port, config.allow_edit, config.allow_upload);
        let mut cfg = self.config.write().await;
        *cfg = config;
    }

    pub async fn get_config(&self) -> LanShareConfig {
        self.config.read().await.clone()
    }

    pub async fn get_connected_devices(&self) -> Vec<ConnectedDevice> {
        self.devices.get_devices().await
    }

    pub async fn get_device_count(&self) -> usize {
        self.devices.get_device_count().await
    }

    pub async fn rename_device(&self, device_id: &str, new_name: &str) -> bool {
        let s = self.sessions.rename_device(device_id, new_name).await;
        let d = self.devices.rename_device(device_id, new_name).await;
        if s || d {
            log::info!("[LAN Share] 设备重命名 - {} -> {}", device_id, new_name);
        }
        s || d
    }

    pub fn is_running(&self) -> bool {
        self.server_handle.is_some()
    }

    pub fn get_status(&self) -> LanShareStatus {
        LanShareStatus {
            is_running: self.server_handle.is_some(),
            port: self.port,
            local_ip: self.local_ip.clone(),
            device_count: 0,
        }
    }

    pub async fn get_status_with_device_count(&self) -> LanShareStatus {
        LanShareStatus {
            is_running: self.server_handle.is_some(),
            port: self.port,
            local_ip: self.local_ip.clone(),
            device_count: self.devices.get_device_count().await,
        }
    }
}

fn is_private_lan_ip(ip: &Ipv4Addr) -> bool {
    let octets = ip.octets();
    match octets[0] {
        10 => true,
        172 => octets[1] >= 16 && octets[1] <= 31,
        192 => octets[1] == 168,
        _ => false,
    }
}

pub fn get_local_lan_ip() -> Option<String> {
    let all_ips = local_ip_address::list_afinet_netifas().ok()?;
    
    log::debug!("[LAN Share] 扫描所有网络接口...");
    
    let mut lan_ips: Vec<Ipv4Addr> = Vec::new();
    let mut other_ips: Vec<Ipv4Addr> = Vec::new();
    
    for (name, ip) in all_ips {
        if let IpAddr::V4(ipv4) = ip {
            if !ipv4.is_loopback() && !ipv4.is_link_local() {
                log::debug!("[LAN Share] 发现网络接口: {} -> {}", name, ipv4);
                if is_private_lan_ip(&ipv4) {
                    lan_ips.push(ipv4);
                } else {
                    other_ips.push(ipv4);
                }
            }
        }
    }
    
    if let Some(ip) = lan_ips.first() {
        log::info!("[LAN Share] 选择局域网 IP: {}", ip);
        return Some(ip.to_string());
    }
    
    if let Some(ip) = other_ips.first() {
        log::warn!("[LAN Share] 未找到局域网 IP，使用其他 IP: {}", ip);
        return Some(ip.to_string());
    }
    
    match local_ip_address::local_ip() {
        Ok(IpAddr::V4(ip)) => {
            log::warn!("[LAN Share] 使用默认 IP: {}", ip);
            Some(ip.to_string())
        }
        Ok(IpAddr::V6(ip)) => {
            log::warn!("[LAN Share] 使用 IPv6: {}", ip);
            Some(ip.to_string())
        }
        Err(e) => {
            log::error!("[LAN Share] 获取本机 IP 失败: {}", e);
            None
        }
    }
}

pub fn get_local_ip() -> Option<String> {
    get_local_lan_ip()
}

pub async fn check_port_available(port: u16) -> bool {
    let addr_result: Result<SocketAddr, _> = format!("0.0.0.0:{}", port).parse();
    match addr_result {
        Ok(addr) => {
            match TcpListener::bind(addr).await {
                Ok(_) => {
                    log::debug!("[LAN Share] 端口 {} 可用", port);
                    true
                }
                Err(e) => {
                    log::warn!("[LAN Share] 端口 {} 已被占用: {}", port, e);
                    false
                }
            }
        }
        Err(e) => {
            log::error!("[LAN Share] 端口检查失败: {}", e);
            false
        }
    }
}
