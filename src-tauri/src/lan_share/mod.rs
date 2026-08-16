pub mod device_manager;
pub mod session;
pub mod types;

// handlers 与 server 依赖桌面文件系统/静态页面，仅桌面端编译。
// types/session/device_manager 为平台无关代码，安卓端 HTTP 服务端复用。
#[cfg(not(target_os = "android"))]
mod handlers;
#[cfg(not(target_os = "android"))]
mod server;

pub use device_manager::DeviceManager;
pub use session::SessionManager;
pub use types::*;

#[cfg(not(target_os = "android"))]
pub use server::{check_port_available, get_local_ip, LanShareServer};
