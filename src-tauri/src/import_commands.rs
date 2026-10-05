//! PixCall 标注迁移的 Tauri 命令层（设计方案 §6.1 第 1/2 条 + §6.4 的多来源抽象）。
//!
//! 这一层只做三件事：把 core 的 `import` 模块接到前端、发进度事件、管快照的生命周期。
//! **规则都不在这里**（解码、分类、断言、并集都在 `aurora_core::import`），第二期加
//! Eagle 时这里只换适配器。
//!
//! ⑥：PixCall 的 64 位 id 一律不过 JSON——返回给前端的只有计数与字符串，
//! `MigrationReport` 里本来就不含源库 id。

use aurora_core::db::import_records::{self, ImportRecord};
use aurora_core::db::AppDbPool;
use aurora_core::import::OurIndex;
use aurora_core::import::eagle;
use aurora_core::import::pixcall;
use aurora_core::import::{apply_plan, has_anything_to_migrate, MigrationReport};
use serde::Serialize;
use std::collections::HashMap;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, State};

/// probe 与 import **必须共用同一份快照**（§6.2 末）：源库是活的（⑤ 记过十几分钟内
/// thumbnails 1171→5402），两次各读一份会让预览条数与实际导入条数对不上，用户会以为
/// 导入出错。所以 probe 把快照存在这里，import 取同一条。
#[derive(Default)]
pub struct PixcallSnapshots(pub Mutex<HashMap<String, pixcall::Snapshot>>);

/// §6.1 第 3 条的阶段：`switch`（设根目录，瞬时）→ `scan`（复用现有 scanProgress）
/// → `probe`（读快照解码）→ `import`（迁移进度）→ `done`（结果行）。
/// 前两个阶段由前端现有的扫描链路驱动，这里只发后两个。
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PixcallProgress {
    stage: String,
    source_root: String,
    processed: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PixcallLibrary {
    /// PixCall 库根（`.pixcall` 所在目录），**不是**我们当前打开的库根（§6.3 要求分开建模）
    pub root: String,
    pub is_current: bool,
    /// 与我们的资源根的位置关系：`same` / `inside` / `outside` / `unknown`
    /// （§6 末那处「点之前就知道」的提示）。`outside` 时这个库的图不在 `file_index`
    /// 里，导入必然全部 unmatched，前端要说清而不是等用户点完才发现什么都没进来。
    pub root_relation: String,
}

fn emit_progress(app: &AppHandle, stage: &str, source_root: &str, processed: usize, total: usize) {
    let _ = app.emit(
        "pixcall-progress",
        PixcallProgress {
            stage: stage.to_string(),
            source_root: source_root.to_string(),
            processed,
            total,
        },
    );
}

fn to_library(source_root: &str) -> Result<pixcall::DiscoveredLibrary, String> {
    let normalized = aurora_core::db::normalize_path(source_root);
    let candidate = pixcall::DiscoveredLibrary {
        root: normalized.clone(),
        pixcall_dir: format!("{}/.pixcall", normalized),
        is_current: true,
    };
    if !std::path::Path::new(&candidate.pixcall_dir).is_dir() {
        return Err(format!("{} 下没有 .pixcall 库", normalized));
    }
    Ok(candidate)
}

/// 发现本机可用的 PixCall 库（§6.3 发现顺序：我们根下的 `.pixcall` 优先，其次
/// `%APPDATA%\Pixcall\config.json` 的 `libraries[]`，并**过滤掉注册了没建库的**）。
/// 多于一个时前端给选择列表（§6.1 第 3 条）。
#[tauri::command]
pub async fn pixcall_discover(
    our_root: Option<String>,
) -> Result<Vec<PixcallLibrary>, String> {
    let our = our_root.as_deref();
    Ok(pixcall::discover(our)
        .into_iter()
        .map(|lib| PixcallLibrary {
            root_relation: pixcall::root_relation(our, &lib.root).as_str().to_string(),
            root: lib.root,
            is_current: lib.is_current,
        })
        .collect())
}

/// 只读探测（§6.1 第 1 条）：零写入，返回 §4.7 全栏报告供 UI 展示。
/// 快照留给 `pixcall_import` 复用。
#[tauri::command]
pub async fn pixcall_probe(
    source_root: String,
    app: AppHandle,
    pool: State<'_, AppDbPool>,
    snapshots: State<'_, PixcallSnapshots>,
) -> Result<MigrationReport, String> {
    let library = to_library(&source_root)?;
    let snapshot = pixcall::Snapshot::open(&library)?;
    let schema_version = snapshot.schema_version();
    let root = snapshot.root.clone();

    let source = pixcall::read_source(&snapshot, Some(&|done, total| {
        emit_progress(&app, "probe", &root, done, total);
    }))?;

    let conn = pool.get_connection();
    let our = OurIndex::load(&*conn).map_err(|e| e.to_string())?;
    if our.is_empty() {
        return Err("这个库里还没有索引到任何文件，请先扫描一次再导入（§6.3 前置条件）".to_string());
    }
    let plan = pixcall::build_plan(&source, &root, &our, &*conn, &schema_version)
        .map_err(|e| e.to_string())?;
    drop(conn);

    // 探测阶段零写入，但计划与快照一起留下：import 用同一条（§6.2 末）
    snapshots
        .0
        .lock()
        .map_err(|_| "快照状态锁不可用".to_string())?
        .insert(root.clone(), snapshot);

    emit_progress(&app, "done", &root, 0, 0);
    Ok(plan.report)
}

/// 执行导入（§6.1 第 2 条）：按 §4 落库，返回完整报告。
///
/// 合并是纯增量的（并集 / 仅为空时填 / 同名不新建 / position 续排），**重跑安全**；
/// 所以不设独立的事前确认弹窗，报告作为结果展示。probe 发现 0 条可迁标注时
/// 不写迁移记录（§6.1 第 3 条末）。
#[tauri::command]
pub async fn pixcall_import(
    source_root: String,
    app: AppHandle,
    pool: State<'_, AppDbPool>,
    snapshots: State<'_, PixcallSnapshots>,
) -> Result<MigrationReport, String> {
    let library = to_library(&source_root)?;
    // 优先复用 probe 留下的快照；没有（比如直接调 import）就现开一份
    let snapshot = {
        let mut guard = snapshots.0.lock().map_err(|_| "快照状态锁不可用".to_string())?;
        match guard.remove(&library.root) {
            Some(snapshot) => snapshot,
            None => pixcall::Snapshot::open(&library)?,
        }
    };
    let schema_version = snapshot.schema_version();
    let root = snapshot.root.clone();

    let source = pixcall::read_source(&snapshot, Some(&|done, total| {
        emit_progress(&app, "probe", &root, done, total);
    }))?;

    let report = {
        let conn = pool.get_connection();
        let our = OurIndex::load(&*conn).map_err(|e| e.to_string())?;
        if our.is_empty() {
            return Err("这个库里还没有索引到任何文件，请先扫描一次再导入（§6.3 前置条件）".to_string());
        }
        let plan = pixcall::build_plan(&source, &root, &our, &*conn, &schema_version)
            .map_err(|e| e.to_string())?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let report = apply_plan(
            &*conn,
            &plan,
            now,
            Some(&|done, total| emit_progress(&app, "import", &root, done, total)),
        )
        .map_err(|e| e.to_string())?;

        // §6.5：记录跟着库走；无可迁内容时不写
        if has_anything_to_migrate(&report) {
            aurora_core::import::record_import(
                &*conn,
                pixcall::SOURCE_NAME,
                &root,
                &schema_version,
                &report,
                now,
            )
            .map_err(|e| e.to_string())?;
        }
        report
    };

    drop(snapshot);
    // 导入改的是 file_metadata 与 topics，前端内存里存的是旧行。复用 LAN 写入那条
    // 现成的失效通道（`lan-share-data-changed`，App.tsx 按 kind 回拉：metadata 走
    // handleRefreshTags 重建词表、topics 走 reloadTopics），不另起一套刷新逻辑。
    if has_anything_to_migrate(&report) {
        let _ = app.emit(
            "lan-share-data-changed",
            serde_json::json!({ "kind": "metadata" }),
        );
        if report.topics_created > 0 {
            let _ = app.emit(
                "lan-share-data-changed",
                serde_json::json!({ "kind": "topics" }),
            );
        }
    }
    emit_progress(&app, "done", &root, 0, 0);
    Ok(report)
}

/// 设置面板「上次导入报告」的数据源（§6.1 第 4 条）：同 `source + source_root` 最近一条。
/// `report_json` 里是 §4.7 全栏，含 `excludedTrashNames` 的名字明细——welcome 卡片只给计数，
/// 明细在这一层给（v4.5 拍板 A）。
#[tauri::command]
pub async fn pixcall_last_import_report(
    source_root: String,
    pool: State<'_, AppDbPool>,
) -> Result<Option<ImportRecord>, String> {
    let conn = pool.get_connection();
    let normalized = aurora_core::db::normalize_path(&source_root);
    import_records::latest_for(&*conn, pixcall::SOURCE_NAME, &normalized)
        .map_err(|e| e.to_string())
}

/// 本库的全部导入记录（换过源库根目录时 UI 要能都列出来）。
#[tauri::command]
pub async fn pixcall_import_records(pool: State<'_, AppDbPool>) -> Result<Vec<ImportRecord>, String> {
    let conn = pool.get_connection();
    import_records::list_all(&*conn).map_err(|e| e.to_string())
}

// ================================================================= Eagle（第二期，调研 §13）
//
// 命令名与参数/返回形状与 pixcall 系一一对应（前端桥接层照抄 pixcall 的 TS 签名改名）。
// 差别只有两处，都来自 mod.rs 头两条 per-source 禁令：
// * Eagle 的库不是 SQLite，「快照」= `read_source` 一次性解码出的内存 `SourceData`，
//   probe 存这里、import 取同一条（§6.2 末条约束的 Eagle 等价物）；
// * Eagle 不记原始路径，匹配只按 `name+ext` 对全索引做——没有 rootRelation 的语义。

/// Eagle 的 probe 与 import 共用同一份解码结果（Eagle 的「快照」）。
#[derive(Default)]
pub struct EagleSnapshots(pub Mutex<HashMap<String, eagle::SourceData>>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct EagleProgress {
    stage: String,
    source_root: String,
    processed: usize,
    total: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EagleLibrary {
    /// Eagle 库根（`<Name>.library` 目录本身，不是它的父目录）
    pub root: String,
    pub is_current: bool,
    /// 形状与 pixcall 系对齐；但 Eagle 匹配与路径无关，恒 `"unknown"`（前端不据此提示，
    /// pixcall 的 `outside` = 「必然全部未命中」警告对 Eagle 不成立）
    pub root_relation: String,
}

fn emit_eagle_progress(
    app: &AppHandle,
    stage: &str,
    source_root: &str,
    processed: usize,
    total: usize,
) {
    let _ = app.emit(
        "eagle-progress",
        EagleProgress {
            stage: stage.to_string(),
            source_root: source_root.to_string(),
            processed,
            total,
        },
    );
}

fn to_eagle_library(source_root: &str) -> Result<eagle::DiscoveredLibrary, String> {
    let normalized = aurora_core::db::normalize_path(source_root);
    // 有效性判据（调研 §1）：metadata.json 是文件 且 images/ 是目录
    if !eagle::is_valid_library(&normalized) {
        return Err(format!(
            "{} 不是有效的 Eagle 库（缺 metadata.json 或 images/）",
            normalized
        ));
    }
    Ok(eagle::DiscoveredLibrary {
        root: normalized,
        is_current: true,
    })
}

/// 发现本机可用的 Eagle 库：给定根自身/一级子目录/父目录里的 `*.library`，
/// 加 `%APPDATA%\Eagle\Settings` 的 `libraryHistory` + `rootDir`（过滤已不存在的项）。
#[tauri::command]
pub async fn eagle_discover(our_root: Option<String>) -> Result<Vec<EagleLibrary>, String> {
    let our = our_root.as_deref();
    Ok(eagle::discover(our)
        .into_iter()
        .map(|lib| EagleLibrary {
            root_relation: "unknown".to_string(),
            root: lib.root,
            is_current: lib.is_current,
        })
        .collect())
}

/// 只读探测：零写入，返回全栏报告供 UI 展示。解码结果留给 `eagle_import` 复用。
#[tauri::command]
pub async fn eagle_probe(
    source_root: String,
    app: AppHandle,
    pool: State<'_, AppDbPool>,
    snapshots: State<'_, EagleSnapshots>,
) -> Result<MigrationReport, String> {
    let library = to_eagle_library(&source_root)?;
    let root = aurora_core::db::normalize_path(&library.root);
    let source = eagle::read_source(&library, Some(&|done, total| {
        emit_eagle_progress(&app, "probe", &root, done, total);
    }))?;

    let report = {
        let conn = pool.get_connection();
        let our = OurIndex::load(&*conn).map_err(|e| e.to_string())?;
        if our.is_empty() {
            return Err(
                "这个库里还没有索引到任何文件，请先扫描一次再导入（§6.3 前置条件）".to_string(),
            );
        }
        eagle::build_plan(&source, &our, &*conn)?.report
    };

    snapshots
        .0
        .lock()
        .map_err(|_| "快照状态锁不可用".to_string())?
        .insert(root.clone(), source);

    emit_eagle_progress(&app, "done", &root, 0, 0);
    Ok(report)
}

/// 执行导入：合并是纯增量的（并集 / 仅为空时填 / 同名不新建 / position 续排），重跑安全。
/// probe 发现 0 条可迁标注时不写迁移记录。
#[tauri::command]
pub async fn eagle_import(
    source_root: String,
    app: AppHandle,
    pool: State<'_, AppDbPool>,
    snapshots: State<'_, EagleSnapshots>,
) -> Result<MigrationReport, String> {
    let library = to_eagle_library(&source_root)?;
    // 优先复用 probe 留下的解码结果；没有（比如直接调 import）就现读一份
    let source = {
        let mut guard = snapshots.0.lock().map_err(|_| "快照状态锁不可用".to_string())?;
        match guard.remove(&library.root) {
            Some(source) => source,
            None => eagle::read_source(&library, Some(&|done, total| {
                emit_eagle_progress(&app, "probe", &library.root, done, total);
            }))?,
        }
    };
    let root = source.root.clone();

    let report = {
        let conn = pool.get_connection();
        let our = OurIndex::load(&*conn).map_err(|e| e.to_string())?;
        if our.is_empty() {
            return Err(
                "这个库里还没有索引到任何文件，请先扫描一次再导入（§6.3 前置条件）".to_string(),
            );
        }
        let plan = eagle::build_plan(&source, &our, &*conn)?;

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        let report = apply_plan(
            &*conn,
            &plan,
            now,
            Some(&|done, total| emit_eagle_progress(&app, "import", &root, done, total)),
        )
        .map_err(|e| e.to_string())?;

        // §6.5：记录跟着库走；无可迁内容时不写
        if has_anything_to_migrate(&report) {
            aurora_core::import::record_import(
                &*conn,
                eagle::SOURCE_NAME,
                &root,
                &plan.source_schema_version,
                &report,
                now,
            )
            .map_err(|e| e.to_string())?;
        }
        report
    };

    // 导入改的是 file_metadata 与 topics，前端内存里存的是旧行。与 pixcall_import 同一条
    // 现成的失效通道（`lan-share-data-changed`），不另起一套刷新逻辑。
    if has_anything_to_migrate(&report) {
        let _ = app.emit(
            "lan-share-data-changed",
            serde_json::json!({ "kind": "metadata" }),
        );
        if report.topics_created > 0 {
            let _ = app.emit(
                "lan-share-data-changed",
                serde_json::json!({ "kind": "topics" }),
            );
        }
    }
    emit_eagle_progress(&app, "done", &root, 0, 0);
    Ok(report)
}

/// 设置面板「上次导入报告」的数据源：同 `source + source_root` 最近一条。
#[tauri::command]
pub async fn eagle_last_import_report(
    source_root: String,
    pool: State<'_, AppDbPool>,
) -> Result<Option<ImportRecord>, String> {
    let conn = pool.get_connection();
    let normalized = aurora_core::db::normalize_path(&source_root);
    import_records::latest_for(&*conn, eagle::SOURCE_NAME, &normalized)
        .map_err(|e| e.to_string())
}

/// 本库的全部导入记录。
#[tauri::command]
pub async fn eagle_import_records(pool: State<'_, AppDbPool>) -> Result<Vec<ImportRecord>, String> {
    let conn = pool.get_connection();
    import_records::list_all(&*conn).map_err(|e| e.to_string())
}
