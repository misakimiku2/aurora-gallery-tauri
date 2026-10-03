use serde::{Deserialize, Serialize};
use std::time::Instant;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanShareConfig {
    pub enabled: bool,
    pub port: u16,
    pub access_code: String,
    pub allow_edit: bool,
    pub allow_upload: bool,
    #[serde(default)]
    pub server_name: String,
}

impl Default for LanShareConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            port: 8080,
            access_code: String::new(),
            // D32「互联即授权」：默认全权，403 仅在用户手动收紧后出现。
            allow_edit: true,
            allow_upload: true,
            server_name: String::new(),
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
    #[serde(default = "default_device_type", rename = "deviceType")]
    pub device_type: String,
}

fn default_device_type() -> String {
    "phone".to_string()
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
    /// 客户端持久化的设备标识。若提供则服务端按此 ID 覆盖旧会话，
    /// 避免同一设备重连时在线计数累加；否则回退到随机 UUID。
    #[serde(default)]
    pub device_id: Option<String>,
    /// 对端服务端信息（双向连接融合）：
    /// 客户端在认证时若携带此字段，服务端会通过
    /// `lan-share-peer-pairing` 事件通知本机前端自动反向连接对端，
    /// 使一次扫码/一次连接即可建立双向互联。
    #[serde(default)]
    pub peer_server: Option<PeerServerInfo>,
}

/// 对端局域网共享服务端信息（用于自动反向配对）。
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PeerServerInfo {
    pub port: u16,
    pub access_code: String,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server_name: Option<String>,
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
    pub preview_images: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified_at: Option<i64>,
    /// image 项：图片创建时间（秒级，file_index.created_at；0/缺省 = 无日期）。
    /// FS 补扫描的视频项不带此字段（无索引日期）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_at: Option<i64>,
    /// folder 项：**直接子图** MAX(created_at)（不递归嵌套；无直接子图缺省 = 无日期）。
    /// 语义 = 「内容最新创建时间」，供客户端「按时间排序 = 内容最新」使用；
    /// 与既有 `modified_at`（文件夹自身 fs mtime / 子图最新修改时间）口径不同，两字段并存。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latest_created_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub palette: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrowseResponse {
    pub current_path: String,
    pub folders: Vec<BrowseItem>,
    pub images: Vec<BrowseItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_edit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_upload: Option<bool>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AllImageFoldersResponse {
    pub folders: Vec<BrowseItem>,
    pub root_images: Vec<BrowseItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_edit: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_upload: Option<bool>,
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

/// move/copy 批量请求（M6a 1.4）：paths 为共享根相对 path 列表，
/// target_dir 与 upload 的 target_dir 同义（共享根相对目录）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileBatchRequest {
    pub paths: Vec<String>,
    pub target_dir: String,
}

/// move/copy 逐项结果：与入参 paths 同序一一对应，单个失败不整批报错。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileOperationItem {
    pub path: String,
    pub success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub new_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileBatchResponse {
    pub items: Vec<FileOperationItem>,
}

pub const SESSION_TIMEOUT_SECS: u64 = 3600;
// 心跳间隔缩短到 5s，配合 Tauri 事件推送让设备列表近乎实时更新。
pub const HEARTBEAT_INTERVAL_SECS: u64 = 5;
// 设备"在线"判定阈值：last_active_at 在此时间内才算在线。
// = 心跳间隔 × 3，容忍 2 次心跳丢失。客户端异常关闭后 ~15 秒从设备列表消失。
pub const ONLINE_TIMEOUT_SECS: u64 = 15;
