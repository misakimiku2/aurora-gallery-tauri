//! Aurora Gallery 核心数据层（平台无关）。
//!
//! 本 crate 只含纯数据/算法逻辑，无任何 Tauri 依赖，供：
//! - 桌面/安卓 Tauri 壳（`src-tauri`）通过 path 依赖复用；
//! - Kotlin 端经 UniFFI 直调（M1 阶段 1 接入）。

pub mod color_extractor;
pub mod color_db;
pub mod db;
pub mod file_types;
pub mod ffi;

uniffi::setup_scaffolding!();
