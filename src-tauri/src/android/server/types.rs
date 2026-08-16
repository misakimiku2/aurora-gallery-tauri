use serde::{Deserialize, Serialize};

/// 安卓端局域网共享服务端配置（与桌面端 LanShareConfig 对应，
/// 但由 Tauri 命令 + 前台服务管理，不涉及文件系统根目录）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidLanServerConfig {
    pub enabled: bool,
    pub port: u16,
    pub access_code: String,
    #[serde(default)]
    pub server_name: String,
}

impl Default for AndroidLanServerConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 8080,
            access_code: String::new(),
            server_name: String::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidLanServerInfo {
    pub url: String,
    pub port: u16,
    pub local_ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AndroidLanServerStatus {
    pub is_running: bool,
    pub port: u16,
    pub local_ip: Option<String>,
    pub device_count: usize,
}
