//! 安卓端局域网共享服务端模块：MediaStore 驱动的 Axum HTTP 服务。
//! 与桌面端 lan_share 模块对称，供"桌面端连接安卓端"功能使用。

pub mod handlers;
pub mod media_store;
pub mod server;
pub mod types;

pub use server::{get_android_local_ip, LanShareServer};
pub use types::*;
