//! 开发期入口（设计方案 §6.6 迁移切片 1）。
//!
//! 解码与断言的全部风险都在 Rust 这一层，先用这条命令把 §4.7 的报告打出来、
//! 逐栏对 §9 的表，证明它之后再碰 UI。
//!
//! ```text
//! # 只读探测（不写我们的库）
//! cargo run --manifest-path core/Cargo.toml --example pixcall_report -- probe "<pixcall_root>" "<our_metadata.db>"
//! # 探测 + 落库（务必先复制一份 metadata.db 再指过来）
//! cargo run --manifest-path core/Cargo.toml --example pixcall_report -- apply "<pixcall_root>" "<our_metadata.db>"
//! # 看发现逻辑的结果（our_root 传当前库根，pixcall_root 传 "-" 表示自动发现）
//! cargo run --manifest-path core/Cargo.toml --example pixcall_report -- discover "<our_root>"
//! ```

use aurora_core::db::normalize_path;
use aurora_core::import::pixcall::{self, Snapshot};
use aurora_core::import::{apply_plan, OurIndex};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

fn main() {
    let argv: Vec<String> = std::env::args().collect();
    let mode = argv.get(1).map(String::as_str).unwrap_or("probe");
    let source_arg = argv.get(2).map(String::as_str).unwrap_or("-");
    let our_db = match argv.get(3) {
        Some(path) => path.clone(),
        None => {
            eprintln!("用法: pixcall_report <probe|apply|discover> <pixcall_root|-> <metadata.db>");
            std::process::exit(2);
        }
    };

    if let Err(e) = run(mode, source_arg, &our_db) {
        eprintln!("\n[失败] {}", e);
        std::process::exit(1);
    }
}

fn run(mode: &str, source_arg: &str, our_db: &str) -> Result<(), String> {
    // ---- 库发现（§6.3）----
    let our_root = if source_arg == "-" {
        std::fs::metadata(our_db)
            .ok()
            .and_then(|_| Path::new(our_db).parent().and_then(|p| p.parent()).map(|p| p.to_string_lossy().to_string()))
    } else {
        None
    };
    let found = pixcall::discover(our_root.as_deref());
    println!("发现 PixCall 库 {} 个（已过滤注册了但没建库的条目）：", found.len());
    for lib in &found {
        println!(
            "  {} {}{}",
            lib.root,
            if lib.is_current { "← 当前库" } else { "" },
            if Path::new(&lib.pixcall_dir).is_dir() { "" } else { "（无 .pixcall）" }
        );
    }
    if mode == "discover" {
        return Ok(());
    }

    let library = if source_arg == "-" {
        found
            .iter()
            .find(|l| l.is_current)
            .or_else(|| found.first())
            .ok_or("没有可用的 PixCall 库，请显式传库根路径")?
            .clone()
    } else {
        let normalized = normalize_path(source_arg);
        let dir = format!("{}/.pixcall", normalized);
        if !Path::new(&dir).is_dir() {
            return Err(format!("{} 下没有 .pixcall", normalized));
        }
        pixcall::DiscoveredLibrary {
            root: normalized.clone(),
            pixcall_dir: dir,
            is_current: true,
        }
    };

    // ---- 只读快照（§6.2）：复制 db + wal，不带 -shm；probe 与 apply 共用这一份 ----
    println!("\n快照：{} → 临时目录副本（只读 + query_only）", library.root);
    let snapshot = Snapshot::open(&library)?;
    println!("  schema_version = {}", snapshot.schema_version());

    let source = pixcall::read_source(&snapshot, Some(&|done, total| {
        if done == total || done % 2048 == 0 {
            println!("  解码 {}/{}", done, total);
        }
    }))?;

    // ---- 我们这一侧 ----
    let read_only = mode != "apply";
    let flags = if read_only {
        OpenFlags::SQLITE_OPEN_READ_ONLY
    } else {
        OpenFlags::SQLITE_OPEN_READ_WRITE
    };
    let our_conn = Connection::open_with_flags(our_db, flags | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE)
        .map_err(|e| format!("打开 {} 失败：{}", our_db, e))?;
    let our = OurIndex::load(&our_conn).map_err(|e| e.to_string())?;
    println!(
        "  我们的 file_index：{} 行（{} 张图 + {} 个文件夹）",
        our.len(),
        count_type(&our_conn, "Image"),
        count_type(&our_conn, "Folder")
    );
    if our.is_empty() {
        return Err("file_index 为空：先在我们这边扫过一次再导（§6.3 前置条件）".to_string());
    }

    let schema_version = snapshot.schema_version();
    let plan = pixcall::build_plan(&source, &snapshot.root, &our, &our_conn, &schema_version)
        .map_err(|e| e.to_string())?;

    print_report(&plan.report);

    if read_only {
        println!("\n（probe 模式：未写入任何东西。要落库请复制一份 metadata.db 后用 apply 模式）");
        return Ok(());
    }

    println!("\n开始落库……");
    // 新表 import_records 靠 init_db 建（桌面开库走的是同一条路径，这里对齐）
    aurora_core::db::init_db(&our_conn).map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let report = apply_plan(&our_conn, &plan, now, Some(&|done, total| {
        if done == total || done % 100 == 0 {
            println!("  写入 {}/{}", done, total);
        }
    }))
    .map_err(|e| e.to_string())?;
    println!("\n落库后的报告（应与探测值一致）：");
    print_report(&report);

    // §6.1 第 3 条末：probe 发现 0 条可迁标注时不写迁移记录
    if aurora_core::import::has_anything_to_migrate(&report) {
        let id = aurora_core::import::record_import(
            &our_conn,
            pixcall::SOURCE_NAME,
            &snapshot.root,
            &schema_version,
            &report,
            now,
        )
        .map_err(|e| e.to_string())?;
        println!("已写迁移记录 import_records id={}", id);
        let back = aurora_core::db::import_records::latest_for(&our_conn, pixcall::SOURCE_NAME, &snapshot.root)
            .map_err(|e| e.to_string())?;
        println!("  回读：{:?}", back.map(|r| (r.source_root, r.matched, r.skipped_existing)));
    } else {
        println!("未发现可迁移的标注，不写迁移记录。");
    }
    Ok(())
}

fn count_type(conn: &Connection, file_type: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM file_index WHERE file_type = ?1",
        rusqlite::params![file_type],
        |row| row.get(0),
    )
    .unwrap_or(0)
}

/// §9 的验收表就按这个格式对。
fn print_report(report: &aurora_core::import::MigrationReport) {
    let rows: Vec<(&str, String, &str)> = vec![
        ("excluded_trash", report.excluded_trash.to_string(), "回收站子树（⑫：判据 parent_id=2，不是 is_deleted）"),
        ("excluded_trash_names", report.excluded_trash_names.len().to_string(), "列名字，不复制实文件（v4.5 拍板 A）"),
        ("skipped_unsupported_type", report.skipped_unsupported_type.to_string(), "is_indexable=false，今天即视频（§4.9 埋点）"),
        ("  其中 annotated_unsupported", report.annotated_unsupported.to_string(), "搁置的代价，视频支持后重导入自动补齐"),
        ("topic_members_skipped_type", report.topic_members_skipped_type.to_string(), "合集成员里因类型被搁置的"),
        ("topics_materialized", report.topics_materialized.to_string(), "智能看板复算过计数断言、固化为快照专题"),
        ("topics_skipped_unverifiable", report.topics_skipped_unverifiable.to_string(), "断言不过或含未标定筛选键"),
        ("topics_reparented", report.topics_reparented.to_string(), "手动子节点降级挂最近的已迁祖先"),
        ("topics_merged_name", report.topics_merged_name.to_string(), "同父级同名已有专题，成员已并入它（v4.9：不再是「让位不并」）"),
        ("topics_covered", report.topics_covered.to_string(), "其中原本没封面、这次补了首张成员的个数"),
        ("topics_created", report.topics_created.to_string(), "新建专题数"),
        ("topic_files_added", report.topic_files_added.to_string(), "成员落表数"),
        ("matched", report.matched.to_string(), "带标注且路径命中的条目数"),
        ("tags_unioned", report.tags_unioned.to_string(), "并集写入 file_metadata.tags 的行数"),
        ("tags_words_added", report.tags_words_added.to_string(), "词表净增词数"),
        ("descriptions_written", report.descriptions_written.to_string(), "仅为空时填"),
        ("descriptions_skipped_existing", report.descriptions_skipped_existing.to_string(), "我们侧已非空而让位（本机 NTE 夹）"),
        ("source_urls_written", report.source_urls_written.to_string(), "entries.link → file_metadata.source_url"),
        ("source_urls_skipped_existing", report.source_urls_skipped_existing.to_string(), "同上让位"),
        ("unmatched", report.unmatched.to_string(), "路径不命中，如实上报不模糊猜"),
    ];
    println!("\n==== §4.7 报告 ====");
    for (name, value, note) in rows {
        println!("{:<34}{:>6}   {}", name, value, note);
    }
    if !report.unmatched_paths.is_empty() {
        println!("\n未命中明细（最多 50 条）：");
        for path in &report.unmatched_paths {
            println!("  {}", path);
        }
    }
    if !report.excluded_trash_names.is_empty() {
        println!("回收站项：");
        for item in &report.excluded_trash_names {
            match &item.origin_folder {
                Some(folder) => println!("  {}（原 {}）", item.name, folder),
                None => println!("  {}", item.name),
            }
        }
    }
    if !report.warnings.is_empty() {
        println!("\n上报：");
        for warning in &report.warnings {
            println!("  · {}", warning);
        }
    }
}
