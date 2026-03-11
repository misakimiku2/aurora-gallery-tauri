use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanShareConfig {
    pub enabled: bool,
    pub port: u16,
    pub access_code: String,
    pub allow_edit: bool,
    pub allow_upload: bool,
}

impl Default for LanShareConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 8080,
            access_code: String::new(),
            allow_edit: false,
            allow_upload: false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct Session {
    pub token: String,
    pub device_id: String,
    pub device_name: String,
    pub ip: String,
    pub created_at: Instant,
    pub last_active: Instant,
}

impl Session {
    pub fn new(device_id: String, device_name: String, ip: String) -> Self {
        let token = uuid::Uuid::new_v4().to_string();
        let now = Instant::now();
        Self {
            token,
            device_id,
            device_name,
            ip,
            created_at: now,
            last_active: now,
        }
    }

    pub fn is_expired(&self, timeout_secs: u64) -> bool {
        self.last_active.elapsed().as_secs() > timeout_secs
    }

    pub fn touch(&mut self) {
        self.last_active = Instant::now();
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectedDevice {
    pub id: String,
    pub name: String,
    pub ip: String,
    pub connected_at: u64,
    pub last_active_at: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanShareStatus {
    pub is_running: bool,
    pub port: u16,
    pub local_ip: Option<String>,
    pub device_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanShareInfo {
    pub url: String,
    pub port: u16,
    pub local_ip: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthRequest {
    pub code: String,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_in: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowseItem {
    pub name: String,
    pub path: String,
    #[serde(rename = "type")]
    pub item_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowseResponse {
    pub current_path: String,
    pub folders: Vec<BrowseItem>,
    pub images: Vec<BrowseItem>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RenameRequest {
    pub old_path: String,
    pub new_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OperationResponse {
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DevicesResponse {
    pub devices: Vec<ConnectedDevice>,
}

pub const SESSION_TIMEOUT_SECS: u64 = 3600;
pub const HEARTBEAT_INTERVAL_SECS: u64 = 30;
