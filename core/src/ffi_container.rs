//! MP4 容器修复的 UniFFI 出口（安卓侧唯一的调用面）。
//!
//! 安卓没有 ffmpeg，也拿不到 core 的 SQLite 连接，所以这一层只负责三件事：
//! 把 Kotlin 传来的**真实文件路径**转给 [`crate::container_repair`]、把 core 的
//! 连接借给它、把 Rust enum 摊平成 Kotlin 好分支的字符串。
//!
//! 判定与写入逻辑**一律不在这里重复**——桌面走 `src-tauri` 自己的连接调同一份
//! `container_repair`，两端共用一套实现，不许各写一遍解析。

use std::path::Path;

use crate::container_repair::{self, RepairOutcome};
use crate::db::container_repairs;
use crate::ffi::{pool, AuroraError};

/// 一次检测/修复的结果。`status` 的字面量含义见
/// [`crate::container_repair::RepairOutcome::status`]。
#[derive(uniffi::Record, Clone, Debug)]
pub struct FfiContainerRepair {
    pub path: String,
    /// `repaired` / `needsRepair` / `alreadyRepaired` / `maskedNoLedger` / `healthy` /
    /// `notApplicable` / `failed`
    pub status: String,
    /// 被藏起来的毫秒数。
    pub hidden_ms: i64,
    /// 采样表口径时长（毫秒）——修完之后播放器就该认到这个值。
    pub table_ms: i64,
    /// `elst` 口径时长（毫秒）——修复前播放器实际认到的值。
    pub elst_ms: i64,
    /// 被改动的字节偏移（还原时按台账取，不取这里的返回值）。
    pub offsets: Vec<i64>,
    pub error: Option<String>,
}

impl From<RepairOutcome> for FfiContainerRepair {
    fn from(o: RepairOutcome) -> Self {
        Self {
            path: o.path,
            status: o.status,
            hidden_ms: o.hidden_ms,
            table_ms: o.table_ms,
            elst_ms: o.elst_ms,
            offsets: o.offsets.into_iter().map(|x| x as i64).collect(),
            error: o.error,
        }
    }
}

/// 台账里的一条记录（设置面板/还原入口用）。
#[derive(uniffi::Record, Clone, Debug)]
pub struct FfiContainerRepairEntry {
    pub path: String,
    pub offsets: Vec<i64>,
    pub hidden_ms: i64,
    pub table_ms: i64,
    pub elst_ms: i64,
    pub repaired_at: i64,
    /// `desktop` / `android`
    pub origin: String,
}

/// 只检测、不写盘。给「先让用户看看有多少要修」这类场景用。
#[uniffi::export]
pub fn inspect_video_container(path: String) -> FfiContainerRepair {
    let conn = pool().get_connection();
    container_repair::preview_file(&conn, Path::new(&path)).into()
}

/// 检测并在必要时原位修复单个文件；成功会写台账（可还原）。
///
/// `origin` 由调用方声明是谁修的（安卓传 `"android"`），只进台账做排查用。
#[uniffi::export]
pub fn repair_video_container(path: String, origin: String) -> FfiContainerRepair {
    let mut conn = pool().get_connection();
    container_repair::repair_file(&mut conn, Path::new(&path), &origin).into()
}

/// 批量修复（扫描用）。返回与入参**等长且同序**，调用方按 `status` 过滤。
///
/// 单文件写失败不会中断整批 —— `repair_file` 内部把错误收进 `status`/`error`，
/// 不会因为一个只读盘/被占用的文件就让整轮扫描报错。
#[uniffi::export]
pub fn repair_video_containers(paths: Vec<String>, origin: String) -> Vec<FfiContainerRepair> {
    let mut conn = pool().get_connection();
    paths
        .iter()
        .map(|p| container_repair::repair_file(&mut conn, Path::new(p), &origin).into())
        .collect()
}

/// 按台账把某文件逐字节还原。**没有台账的文件一律拒绝**（不猜偏移写用户文件）。
#[uniffi::export]
pub fn revert_video_container(path: String) -> FfiContainerRepair {
    let mut conn = pool().get_connection();
    container_repair::revert_file(&mut conn, Path::new(&path)).into()
}

/// 列出本机所有被修过的文件（还原入口的数据源）。
#[uniffi::export]
pub fn list_container_repairs() -> Result<Vec<FfiContainerRepairEntry>, AuroraError> {
    let conn = pool().get_connection();
    let rows = container_repairs::list(&conn)
        .map_err(|e| AuroraError::Database(e.to_string()))?;
    Ok(rows
        .into_iter()
        .map(|r| FfiContainerRepairEntry {
            path: r.path,
            offsets: r.offsets.into_iter().map(|x| x as i64).collect(),
            hidden_ms: r.hidden_ms,
            table_ms: r.table_ms,
            elst_ms: r.elst_ms,
            repaired_at: r.repaired_at,
            origin: r.origin,
        })
        .collect())
}
