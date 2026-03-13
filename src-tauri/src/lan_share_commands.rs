use std::path::PathBuf;
use std::sync::Arc;
use tauri::{AppHandle, Manager, State};
use tokio::sync::RwLock;

use crate::db::AppDbPool;
use crate::lan_share::{
    check_port_available, get_local_ip, LanShareConfig, LanShareInfo, LanShareServer,
    LanShareStatus, ConnectedDevice,
};

pub struct LanShareState {
    pub server: Arc<RwLock<Option<LanShareServer>>>,
    pub root_path: Arc<RwLock<Option<PathBuf>>>,
}

impl LanShareState {
    pub fn new() -> Self {
        log::info!("[LAN Share] 初始化状态管理器");
        Self {
            server: Arc::new(RwLock::new(None)),
            root_path: Arc::new(RwLock::new(None)),
        }
    }
}

impl Default for LanShareState {
    fn default() -> Self {
        Self::new()
    }
}

#[tauri::command]
pub async fn lan_share_start(
    config: LanShareConfig,
    root_path: String,
    state: State<'_, LanShareState>,
    app: AppHandle,
) -> Result<LanShareInfo, String> {
    log::info!("[LAN Share] 收到启动命令 - 根目录: {}, 端口: {}", root_path, config.port);
    
    let root = PathBuf::from(&root_path);
    if !root.exists() {
        log::error!("[LAN Share] 启动失败 - 根目录不存在: {}", root_path);
        return Err("Root path does not exist".to_string());
    }

    {
        let mut root_path_guard = state.root_path.write().await;
        *root_path_guard = Some(root.clone());
        log::debug!("[LAN Share] 根目录已设置: {}", root.display());
    }

    let mut server_guard = state.server.write().await;
    
    if server_guard.is_some() {
        let server = server_guard.as_mut().unwrap();
        if server.is_running() {
            log::warn!("[LAN Share] 启动失败 - 服务器已在运行中");
            return Err("Server is already running".to_string());
        }
    }

    let db_pool = Arc::new(app.state::<AppDbPool>().inner().clone());
    let mut server = LanShareServer::new(root).with_db_pool(db_pool);
    let info = server.start(config).await?;
    *server_guard = Some(server);

    log::info!("[LAN Share] 启动成功 - URL: {}", info.url);
    Ok(info)
}

#[tauri::command]
pub async fn lan_share_stop(
    state: State<'_, LanShareState>,
) -> Result<(), String> {
    log::info!("[LAN Share] 收到停止命令");
    
    let mut server_guard = state.server.write().await;
    
    if let Some(server) = server_guard.as_mut() {
        server.stop().await;
        log::info!("[LAN Share] 服务器已停止");
    } else {
        log::warn!("[LAN Share] 停止命令忽略 - 服务器未运行");
    }
    
    *server_guard = None;
    Ok(())
}

#[tauri::command]
pub async fn lan_share_get_status(
    state: State<'_, LanShareState>,
) -> Result<LanShareStatus, String> {
    log::debug!("[LAN Share] 获取服务器状态");
    
    let server_guard = state.server.read().await;
    
    if let Some(server) = server_guard.as_ref() {
        let status = server.get_status_with_device_count().await;
        log::debug!("[LAN Share] 状态 - 运行中: {}, 端口: {}, 设备数: {}", 
            status.is_running, status.port, status.device_count);
        Ok(status)
    } else {
        log::debug!("[LAN Share] 状态 - 未运行");
        Ok(LanShareStatus {
            is_running: false,
            port: 8080,
            local_ip: get_local_ip(),
            device_count: 0,
        })
    }
}

#[tauri::command]
pub async fn lan_share_get_devices(
    state: State<'_, LanShareState>,
) -> Result<Vec<ConnectedDevice>, String> {
    log::debug!("[LAN Share] 获取已连接设备列表");
    
    let server_guard = state.server.read().await;
    
    if let Some(server) = server_guard.as_ref() {
        let devices = server.get_connected_devices().await;
        log::debug!("[LAN Share] 当前 {} 个设备在线", devices.len());
        Ok(devices)
    } else {
        log::debug!("[LAN Share] 服务器未运行，返回空设备列表");
        Ok(Vec::new())
    }
}

#[tauri::command]
pub async fn lan_share_get_local_ip() -> Result<String, String> {
    log::debug!("[LAN Share] 获取本机 IP");
    
    match get_local_ip() {
        Some(ip) => {
            log::debug!("[LAN Share] 本机 IP: {}", ip);
            Ok(ip)
        }
        None => {
            log::error!("[LAN Share] 获取本机 IP 失败");
            Err("Failed to get local IP address".to_string())
        }
    }
}

#[tauri::command]
pub async fn lan_share_check_port(
    port: u16,
) -> Result<bool, String> {
    log::debug!("[LAN Share] 检查端口 {} 可用性", port);
    
    let available = check_port_available(port).await;
    log::debug!("[LAN Share] 端口 {} {}", port, if available { "可用" } else { "已被占用" });
    Ok(available)
}

#[tauri::command]
pub async fn lan_share_update_config(
    config: LanShareConfig,
    state: State<'_, LanShareState>,
) -> Result<(), String> {
    log::info!("[LAN Share] 更新配置 - 端口: {}, 允许编辑: {}, 允许上传: {}", 
        config.port, config.allow_edit, config.allow_upload);
    
    let server_guard = state.server.read().await;
    
    if let Some(server) = server_guard.as_ref() {
        server.update_config(config).await;
        log::info!("[LAN Share] 配置更新成功");
    } else {
        log::warn!("[LAN Share] 配置更新忽略 - 服务器未运行");
    }
    
    Ok(())
}
