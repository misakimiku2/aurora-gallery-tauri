//! PixCall 解码与看板规则的单元测试。
//!
//! 夹具是**真库列的子集**（2026-09-29 从 `%APPDATA%` 那台机器上 `main.db` 的 DDL 抄下来
//! 精简的）：`entries` 的 `tags` 存竖线分隔的 tag id（⑦）、描述带尾换行（⑨）、回收站项
//! 挂在 `parent_id=2` 下且 `is_deleted` 仍为 0（⑫）、`boards.filters` 用
//! `'{}'` / `'{"size":[{"should":"extra_small"}]}'` 两个形态（⑪⑭）。
//! 端到端的真数验证在 `core/examples/pixcall_report.rs`（对 §9 的表）。

use super::*;
use crate::db::file_metadata::FileMetadata;
use crate::db::{init_db, topics};
use crate::import::{apply_plan, has_anything_to_migrate};
use rusqlite::{params, Connection};

const ROOT: &str = "C:/Pix";

/// 源库夹具。
fn source_conn() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    c.execute_batch(
        "CREATE TABLE entries (
            id BIGINT PRIMARY KEY, parent_id BIGINT NOT NULL, name TEXT NOT NULL,
            kind INT NOT NULL, description TEXT, link TEXT, tags TEXT, size BIGINT NOT NULL,
            content_type TEXT NOT NULL, source_path TEXT
         );
         CREATE TABLE tags (id BIGINT PRIMARY KEY, name TEXT NOT NULL);
         CREATE TABLE tag_groups (id BIGINT PRIMARY KEY, name TEXT NOT NULL);
         CREATE TABLE boards (
            id BIGINT PRIMARY KEY, parent_id BIGINT, name TEXT NOT NULL, description TEXT,
            filters TEXT NOT NULL, file_count INT NOT NULL DEFAULT 0
         );
         CREATE TABLE board_entries (board_id BIGINT, entry_id BIGINT, entry_kind INT NOT NULL);
         CREATE TABLE kvs (k TEXT PRIMARY KEY, v TEXT NOT NULL);",
    )
    .unwrap();
    c.execute("INSERT INTO kvs VALUES ('schema_version', '22')", []).unwrap();

    // 两个虚拟根（①）：id=1 Pixcall / id=2 Trash，parent_id 都是 -1
    ins_entry(&c, 1, -1, "Pixcall", 0, "application/folder", 0, None, None, None, None);
    ins_entry(&c, 2, -1, "Trash", 0, "unknown", 0, None, None, None, None);
    // 文件夹（⑩：描述也挂在文件夹上）
    ins_entry(&c, 10, 1, "Games", 0, "application/folder", 0, None, Some("游戏截图\n"), None, None);
    ins_entry(&c, 15, 10, "sub", 0, "application/folder", 0, None, Some("子夹备注"), None, None);
    // 图片：竖线分隔的 tag id + 尾换行描述 + 来源链接
    ins_entry(&c, 11, 10, "a.png", 1, "image/png", 2_000_000, Some("500|501"), Some("尾换行\n"), Some("https://x.com/a"), None);
    ins_entry(&c, 12, 1, "b.png", 1, "image/jpeg", 1000, Some("501"), None, None, None);
    // 视频（§4.9：已解码、暂不落地）
    ins_entry(&c, 13, 1, "c.mp4", 1, "video/mp4", 500, Some("500"), Some("视频备注\n"), None, None);
    // 回收站项（⑫）：parent_id=2，文件在 .pixcall/trash 里，source_path 记的是原所在夹
    ins_entry(&c, 14, 2, "z.mp4", 1, "video/mp4", 500, Some("500"), Some("回收站备注"), None, Some("Games"));
    // 我们侧没有的图（④ 要如实进 unmatched，不许模糊猜）。刻意取 >1MiB，
    // 免得它落进 extra_small 桶去干扰 601 的计数断言。
    ins_entry(&c, 16, 1, "gone.png", 1, "image/png", 3_000_000, Some("500"), None, None, None);

    c.execute("INSERT INTO tags VALUES (500, '极乐净土')", []).unwrap();
    c.execute("INSERT INTO tags VALUES (501, '里昂·S·肯尼迪')", []).unwrap();
    // ⑧：tag_groups 本机 0 行，遇到时按「丢弃 + 上报」——这里造一行验那条上报
    c.execute("INSERT INTO tag_groups VALUES (900, '分组A')", []).unwrap();

    board(&c, 600, 1, "阿松大", "{}", 2);
    members(&c, 600, &[(11, 1), (12, 1)]);
    board(&c, 601, 600, "test", r#"{"size":[{"should":"extra_small"}]}"#, 2);
    board(&c, 602, 1, "smart-tags", r#"{"tags":[{"should":"极乐净土"}]}"#, 5);
    // 手动子节点挂在一个被跳过的智能父下（§4.6 规则 2：不连坐，降级挂最近的已迁祖先）
    board(&c, 603, 602, "manual-under-skipped", "{}", 1);
    members(&c, 603, &[(11, 1)]);
    // 同父级同名已有专题（§4.6 规则 3/4）
    board(&c, 604, 1, "已有专题", "{}", 1);
    members(&c, 604, &[(12, 1)]);
    board(&c, 605, 604, "child-of-existing", "{}", 1);
    members(&c, 605, &[(11, 1)]);
    // entry_kind=0 的成员（§4 表：我们 topic_files 语义未定义 → 跳过该成员并上报）
    board(&c, 606, 1, "folder-only", "{}", 1);
    members(&c, 606, &[(10, 0)]);
    // ⑪ 两信号不符：filters 是 '{}' 但成员表为空
    board(&c, 607, 1, "empty-board", "{}", 0);
    // 计数断言不过（§4.6 规则 7）：复算 2 条 ≠ file_count 999
    board(&c, 608, 1, "bad-count", r#"{"size":[{"should":"extra_small"}]}"#, 999);
    c
}

fn ins_entry(
    c: &Connection,
    id: i64,
    parent: i64,
    name: &str,
    kind: i64,
    content_type: &str,
    size: i64,
    tags: Option<&str>,
    description: Option<&str>,
    link: Option<&str>,
    source_path: Option<&str>,
) {
    c.execute(
        "INSERT INTO entries (id, parent_id, name, kind, content_type, size, tags, description, link, source_path) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![id, parent, name, kind, content_type, size, tags, description, link, source_path],
    )
    .unwrap();
}

fn board(c: &Connection, id: i64, parent: i64, name: &str, filters: &str, file_count: i64) {
    c.execute(
        "INSERT INTO boards (id, parent_id, name, filters, file_count) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, parent, name, filters, file_count],
    )
    .unwrap();
}

fn members(c: &Connection, board_id: i64, rows: &[(i64, i64)]) {
    for (entry_id, kind) in rows {
        c.execute(
            "INSERT INTO board_entries VALUES (?1, ?2, ?3)",
            params![board_id, entry_id, kind],
        )
        .unwrap();
    }
}

/// 我们这一侧：只索引到 a.png / b.png 两张图 + Games / Games/sub 两个夹。
fn our_conn() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    init_db(&c).unwrap();
    for (id, path, file_type) in [
        ("fa", "C:/Pix/Games/a.png", "Image"),
        ("fb", "C:/Pix/b.png", "Image"),
        ("fg", "C:/Pix/Games", "Folder"),
        ("fsub", "C:/Pix/Games/sub", "Folder"),
    ] {
        c.execute(
            "INSERT INTO file_index (file_id, path, name, file_type) VALUES (?1, ?2, ?3, ?4)",
            params![id, path, path.rsplit('/').next().unwrap(), file_type],
        )
        .unwrap();
    }
    // a.png 已有标签与我们自己写过的描述 → 并集 + 让位两个用例都在这行上
    file_metadata::upsert_file_metadata(
        &c,
        &FileMetadata {
            file_id: "fa".into(),
            path: "C:/Pix/Games/a.png".into(),
            tags: Some(serde_json::json!(["test2"])),
            description: Some("我自己写的描述".into()),
            source_url: None,
            source_urls: None,
            ai_data: None,
            category: None,
            updated_at: Some(1),
        },
    )
    .unwrap();
    // 根级已有同名专题：导入时让位，但子看板仍要能挂进它（§4.6 规则 4）
    c.execute("INSERT INTO topics (id, name) VALUES ('exist1', '已有专题')", [])
        .unwrap();
    c
}

fn plan() -> MigrationPlan {
    let src = source_conn();
    let our = our_conn();
    let source = read_from(&src, None).unwrap();
    let index = OurIndex::load(&our).unwrap();
    build_plan(&source, ROOT, &index, &our, "22").unwrap()
}

fn topic_names(plan: &MigrationPlan) -> Vec<String> {
    plan.topics.iter().map(|t| t.name.clone()).collect()
}

// ---------------------------------------------------------------- ⑫ Trash 排除

/// §4.8 的分类顺序在真数据上的后果：回收站里那条 mp4 只能进 `excluded_trash`，
/// 既不能进 `skipped_unsupported_type`（那栏只数 1 条 = c.mp4），也不能进 `unmatched`。
/// 这正是设计文档自己警告的「顺序错了会把同一条目重复计入两栏」。
#[test]
fn trash_subtree_is_excluded_before_the_type_filter() {
    let p = plan();
    assert_eq!(p.report.excluded_trash, 1);
    assert_eq!(p.report.excluded_trash_names[0].name, "z.mp4");
    assert_eq!(
        p.report.excluded_trash_names[0].origin_folder.as_deref(),
        Some("Games"),
        "原所在夹取自 entries.source_path（⑫ 的唯一非空值就是它）"
    );
    assert_eq!(p.report.skipped_unsupported_type, 1, "只有 c.mp4，回收站那条不算支持性问题");
    assert_eq!(p.report.unmatched, 1, "只有 gone.png，回收站那条不算缺失");
    assert_eq!(p.report.unmatched_paths, vec!["C:/Pix/gone.png".to_string()]);
}

/// ①⑫ 的路径重建要求：Trash 条目会被拼成**根级**相对路径（光秃秃的文件名），
/// 与真实根目录下同名文件共用命名空间 —— 所以 CTE 的起点必须是 parent_id=1，
/// Trash 子树整个不进 `entries` 集合。
#[test]
fn trash_entries_never_enter_the_path_namespace() {
    let src = source_conn();
    let source = read_from(&src, None).unwrap();
    assert!(!source.entries.contains_key(&14), "z.mp4 不能出现在参与 join 的集合里");
    assert!(!source.entries.contains_key(&1) && !source.entries.contains_key(&2), "两个虚拟根也不参与");
    assert_eq!(source.entries.len(), 6, "10 11 12 13 15 16");
    assert_eq!(source.trash.len(), 1);
}

// ---------------------------------------------------------------- ⑦⑨ 解码

#[test]
fn tags_are_pipe_separated_ids_resolved_through_the_tags_table() {
    let p = plan();
    let edit = p.edits.iter().find(|e| e.file_id == "fa").unwrap();
    // 保留我们已有的顺序，新词追加在后面（§4 映射表第一行）
    assert_eq!(
        edit.tags.as_deref(),
        Some(&["test2".to_string(), "极乐净土".to_string(), "里昂·S·肯尼迪".to_string()][..])
    );
    assert_eq!(p.report.tags_unioned, 2, "a.png 与 b.png 各一行");
    assert_eq!(p.report.tags_words_added, 2, "净增只数词表里没有的两个词");
}

/// ⑨：不 trim 就会把空行带进我们的描述框。
#[test]
fn descriptions_are_trimmed_and_existing_content_wins() {
    let p = plan();
    // a.png 我们侧已非空 → 让位
    let a = p.edits.iter().find(|e| e.file_id == "fa").unwrap();
    assert_eq!(a.description, None);
    // 两个文件夹的备注照迁（⑩：展示位本来就有）
    assert_eq!(
        p.edits.iter().find(|e| e.file_id == "fg").unwrap().description.as_deref(),
        Some("游戏截图")
    );
    assert_eq!(
        p.edits.iter().find(|e| e.file_id == "fsub").unwrap().description.as_ref().unwrap(),
        "子夹备注"
    );
    assert_eq!(p.report.descriptions_written, 2);
    assert_eq!(p.report.descriptions_skipped_existing, 1);
    assert_eq!(p.report.matched, 4, "10 11 12 15 四条带标注且命中，视频与未命中都不算");
}

/// §4 表 `entries.link` 行：**不做 URL 合法性校验**，误存的 x.com/home 也原样搬。
#[test]
fn source_links_are_copied_verbatim() {
    let p = plan();
    let a = p.edits.iter().find(|e| e.file_id == "fa").unwrap();
    assert_eq!(a.source_urls.as_deref(), Some(["https://x.com/a".to_string()].as_slice()));
    assert_eq!(p.report.source_urls_written, 1);
    assert_eq!(p.report.source_urls_skipped_existing, 0);
}

/// 在 fa 上预置一条我们自己的来源网址，再对同一份源库夹具做计划。
fn plan_with_existing_source_urls(urls: Vec<String>) -> (Connection, MigrationPlan) {
    let our = our_conn();
    file_metadata::upsert_file_metadata(
        &our,
        &FileMetadata {
            file_id: "fa".into(),
            path: "C:/Pix/Games/a.png".into(),
            tags: None,
            description: None,
            source_url: None,
            source_urls: Some(urls),
            ai_data: None,
            category: None,
            updated_at: Some(1),
        },
    )
    .unwrap();
    let src = source_conn();
    let source = read_from(&src, None).unwrap();
    let index = OurIndex::load(&our).unwrap();
    let plan = build_plan(&source, ROOT, &index, &our, "22").unwrap();
    (our, plan)
}

/// P1(b)：我们已有来源网址时**不是让位**，而是把源侧那条追加到后面。
#[test]
fn source_links_append_to_what_we_already_have() {
    let (our, p) = plan_with_existing_source_urls(vec!["https://ours.example/1".into()]);
    let a = p.edits.iter().find(|e| e.file_id == "fa").unwrap();
    assert_eq!(
        a.source_urls.as_deref(),
        Some(["https://ours.example/1".to_string(), "https://x.com/a".to_string()].as_slice())
    );
    assert_eq!(p.report.source_urls_written, 1, "我们已有的不动，源侧那条算新增");
    assert_eq!(p.report.source_urls_skipped_existing, 0);

    // 落库后读回来是两条
    apply_plan(&our, &p, 100, None).unwrap();
    let after = file_metadata::get_metadata_by_id(&our, "fa").unwrap().unwrap();
    assert_eq!(after.source_urls(), vec!["https://ours.example/1", "https://x.com/a"]);
}

/// P1(b)：源侧那条我们已经有了 → 不重复添加，计 skipped。
#[test]
fn a_source_link_we_already_have_is_not_added_twice() {
    let (_our, p) = plan_with_existing_source_urls(vec!["https://x.com/a".into()]);
    assert_eq!(p.report.source_urls_written, 0);
    assert_eq!(p.report.source_urls_skipped_existing, 1);
    assert!(
        p.edits.iter().all(|e| e.file_id != "fa" || e.source_urls.is_none()),
        "源侧那条已存在，fa 上不该有来源网址的变更"
    );
}

/// 旧行是裸网址（改之前写的），读出来必须等价成「只有一个元素的数组」——零迁移的依据。
#[test]
fn a_legacy_plain_source_url_reads_as_a_one_element_list() {
    let c = our_conn();
    c.execute(
        "INSERT INTO file_metadata (file_id, path, source_url) VALUES ('f1', 'C:/a.png', 'https://legacy.example/x')",
        [],
    )
    .unwrap();
    let row = file_metadata::get_metadata_by_id(&c, "f1").unwrap().unwrap();
    assert_eq!(row.source_urls(), vec!["https://legacy.example/x"]);
    assert_eq!(row.source_url.as_deref(), Some("https://legacy.example/x"));
}

/// §4.9 第 2 条：视频标注今天「已解码、暂不落地」，代价要在报告里可见。
#[test]
fn annotated_videos_are_decoded_but_parked_with_a_count() {
    let p = plan();
    assert_eq!(p.report.skipped_unsupported_type, 1);
    assert_eq!(p.report.annotated_unsupported, 1);
    assert!(p.edits.iter().all(|e| e.file_id != "fc"), "视频不落 file_metadata");
}

// ---------------------------------------------------------------- §4.6 看板规则

/// ⑪ 手动判据 + 规则 1 层级照搬（`test` 挂在 `阿松大` 下）+ 规则 6 智能固化。
#[test]
fn manual_boards_migrate_with_hierarchy_and_smart_nodes_materialize() {
    let p = plan();
    let names = topic_names(&p);
    assert!(names.contains(&"阿松大".to_string()));
    assert!(names.contains(&"test".to_string()));
    assert_eq!(p.report.topics_materialized, 1);
    assert_eq!(p.report.topics_created, 5);

    let song = p.topics.iter().find(|t| t.name == "阿松大").unwrap();
    assert_eq!(song.parent_id, None, "parent_id=1 的看板挂到我们 topics 的根");
    // 成员按重建路径排序：'Games/a.png' < 'b.png'（ASCII 序），重跑稳定
    assert_eq!(song.file_ids, vec!["fa".to_string(), "fb".to_string()]);
    assert!(!song.materialized);

    let test = p.topics.iter().find(|t| t.name == "test").unwrap();
    assert_eq!(test.parent_id.as_deref(), Some(song.id.as_str()), "层级照搬（§4.6 规则 1）");
    assert!(test.materialized);
    // 复算集合 = size<1MiB 的非回收站条目 = b.png + c.mp4；视频成员计 skipped_type，
    // 因此 topic_files_added 可以小于 file_count（规则 9）
    assert_eq!(test.file_ids, vec!["fb".to_string()]);
    assert_eq!(p.report.topic_members_skipped_type, 1);
    assert!(p.report.warnings.iter().any(|w| w.contains("快照") && w.contains("test")));
}

/// 规则 7：计数断言是硬门禁——复算数 ≠ `file_count` 就跳过，宁可不导也不导错名单。
#[test]
fn count_assertion_blocks_a_wrong_bucket_guess() {
    let p = plan();
    assert!(!topic_names(&p).contains(&"bad-count".to_string()));
    // 602（未标定键）+ 607（两信号不符）+ 608（断言不过）
    assert_eq!(p.report.topics_skipped_unverifiable, 3);
    assert!(p.report.warnings.iter().any(|w| w.contains("bad-count") && w.contains("计数断言不过")));
}

/// 规则 8：不为迁移实现通用筛选器 DSL，未标定的键一律不复算。
#[test]
fn uncalibrated_filters_are_skipped_not_guessed() {
    let p = plan();
    assert!(!topic_names(&p).contains(&"smart-tags".to_string()));
    assert!(p
        .report
        .warnings
        .iter()
        .any(|w| w.contains("smart-tags") && w.contains("未标定键")));
}

/// 规则 2：智能父级没落库，手动子看板不陪葬——降级挂最近的已迁祖先，这里挂到根。
#[test]
fn manual_child_of_a_skipped_smart_parent_is_reparented() {
    let p = plan();
    let child = p.topics.iter().find(|t| t.name == "manual-under-skipped").unwrap();
    assert_eq!(child.parent_id, None, "父级 602 没落库，链上没有已迁祖先 → 挂根");
    assert_eq!(p.report.topics_reparented, 1);
    assert!(p.report.warnings.iter().any(|w| w.contains("降级挂到最近的已迁祖先")));
}

/// 规则 3/4（v4.9）：查重键是 `(父级, name)`；命中同名专题时**不新建、成员并进去**，
/// 该节点仍写进映射表，所以它的子看板能继续挂在同一个专题下。
#[test]
fn same_named_topic_merges_members_and_still_adopts_children() {
    let p = plan();
    assert_eq!(p.report.topics_merged_name, 1);
    assert!(
        !p.topics
            .iter()
            .any(|t| !t.merge_into_existing && t.name == "已有专题"),
        "不新建同名的（并入已有那条不算新建）"
    );
    let merged = p
        .topics
        .iter()
        .find(|t| t.id == "exist1")
        .expect("同名命中后要变成一条并入已有专题的计划");
    assert!(merged.merge_into_existing);
    assert_eq!(merged.file_ids, vec!["fb".to_string()], "看板 604 的成员并进 exist1");
    // 新建的四个专题共 5 个成员（阿松大 2 + test 1 + manual-under-skipped 1 + child-of-existing 1），
    // 合并那条再贡献 1 个
    assert_eq!(p.report.topic_files_added, 6);
    // exist1 原本没有封面，合并后有了成员 → 补一张（用户钉过的封面不会被碰）
    assert_eq!(p.report.topics_covered, 1);

    let child = p.topics.iter().find(|t| t.name == "child-of-existing").unwrap();
    assert_eq!(child.parent_id.as_deref(), Some("exist1"), "子看板挂进那个已有专题");
    assert_eq!(p.report.topics_reparented, 1, "只有 manual-under-skipped 算降级；这条不算");
}

/// §4 表 `board_entries.entry_kind` 行：出现 0（文件夹）时跳过该成员并上报。
#[test]
fn folder_members_are_skipped_with_a_report() {
    let p = plan();
    let only = p.topics.iter().find(|t| t.name == "folder-only").unwrap();
    assert!(only.file_ids.is_empty());
    assert!(p.report.warnings.iter().any(|w| w.contains("entry_kind=0")));
}

/// ⑧：`tag_groups` 本机 0 行；真有行时丢弃并上报条数。
#[test]
fn tag_groups_are_dropped_with_a_report() {
    let p = plan();
    assert!(p.report.warnings.iter().any(|w| w.contains("tag_groups") && w.contains("丢弃")));
}

// ---------------------------------------------------------------- ⑭ 标定表

#[test]
fn only_the_calibrated_size_bucket_is_recomputed() {
    assert_eq!(parse_filters("{}"), Some(None));
    assert_eq!(parse_filters(""), Some(None));
    assert_eq!(
        parse_filters(r#"{"size":[{"should":"extra_small"}]}"#),
        Some(Some(CalibratedFilter::ExtraSmall))
    );
    // 其余桶与别的键：本机无样本、未标定 → None = 不复算
    assert_eq!(parse_filters(r#"{"size":[{"should":"small"}]}"#), None);
    assert_eq!(parse_filters(r#"{"tags":[{"should":"x"}]}"#), None);
    assert_eq!(parse_filters(r#"{"size":[{"must":"extra_small"}]}"#), None);
    assert_eq!(parse_filters(r#"{"size":[{"should":"extra_small"},{"should":"small"}]}"#), None);
    assert_eq!(parse_filters(r#"{"size":[{"should":"extra_small"}],"rating":[{}]}"#), None);
    assert_eq!(parse_filters("not json"), None);
}

/// EXTRA_SMALL_BYTES 是⑭标定出来的：<1MiB 进桶，恰好 1MiB 不进。
#[test]
fn extra_small_boundary_is_exactly_one_mebibyte() {
    assert_eq!(EXTRA_SMALL_BYTES, 1024 * 1024);
    let src = source_conn();
    let source = read_from(&src, None).unwrap();
    let mut bucket: Vec<String> = source
        .entries
        .values()
        .filter(|e| e.kind != 0 && e.size < EXTRA_SMALL_BYTES)
        .map(|e| e.rel_path.clone())
        .collect();
    bucket.sort();
    // b.png(1000) 与 c.mp4(500) 进桶；回收站里的 z.mp4 不在 entries 集合里（⑫）
    assert_eq!(bucket, vec!["b.png".to_string(), "c.mp4".to_string()]);
}

/// ⑥：64 位 id 不过 JSON。报告里只允许出现计数与字符串。
#[test]
fn report_carries_no_64bit_ids_through_json() {
    let p = plan();
    let json = serde_json::to_string(&p.report).unwrap();
    // 源库那些 id 若被塞进报告，序列化后会精度丢失成 …300 之类的值
    for id in ["600", "601", "646087413270029312"] {
        assert!(!json.contains(&format!("\"{}\"", id)), "报告里不该出现源库 id：{}", id);
    }
    let back: MigrationReport = serde_json::from_str(&json).unwrap();
    assert_eq!(back, p.report, "报告必须能原样过一遍 JSON");
}

/// 落库那一路（§4.6 规则 1 的父子关系要真的写进 topics.parent_id）。
#[test]
fn applied_topics_keep_the_hierarchy() {
    let src = source_conn();
    let our = our_conn();
    let source = read_from(&src, None).unwrap();
    let index = OurIndex::load(&our).unwrap();
    let p = build_plan(&source, ROOT, &index, &our, "22").unwrap();
    apply_plan(&our, &p, 100, None).unwrap();

    let all = topics::get_all_topics(&our).unwrap();
    let song = all.iter().find(|t| t.name == "阿松大").unwrap();
    let test = all.iter().find(|t| t.name == "test").unwrap();
    assert_eq!(test.parent_id.as_deref(), Some(song.id.as_str()));
    assert_eq!(test.file_count, 1);
    assert_eq!(song.file_count, 2);
    // 专题封面：导入绕过了前端那条「归入成员时取首图当封面」的路径（useTopics.ts:89-98），
    // 落库时必须自己补上，否则专题卡片是空封面。
    assert_eq!(song.cover_file_id.as_deref(), Some("fa"), "首个成员即封面（按重建路径排序后的第一张）");
    assert_eq!(test.cover_file_id.as_deref(), Some("fb"));
    // 同名命中的那个已有专题：成员并进来了，空封面被补上（v4.9 的合并语义）
    assert_eq!(topics::get_topic_files(&our, "exist1").unwrap(), vec!["fb".to_string()]);
    let exist_cover: Option<String> = our
        .query_row("SELECT cover_file_id FROM topics WHERE id='exist1'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(exist_cover.as_deref(), Some("fb"), "已有专题原本没封面，合并后补了首张成员");
    // 子看板挂进了它
    let child = all.iter().find(|t| t.name == "child-of-existing").unwrap();
    assert_eq!(topics::get_topic_files(&our, &child.id).unwrap(), vec!["fa".to_string()]);
}

/// 重跑安全：第二次探测的写入项应当全为零（并集/仅为空时填/同名不新建都是幂等的）。
#[test]
fn second_pass_writes_nothing_new() {
    let src = source_conn();
    let our = our_conn();
    let source = read_from(&src, None).unwrap();
    let index = OurIndex::load(&our).unwrap();
    let first = build_plan(&source, ROOT, &index, &our, "22").unwrap();
    apply_plan(&our, &first, 100, None).unwrap();

    // 重新读一遍我们侧状态再探测（真实使用里 import 前会重新扫盘/重载索引）
    let index2 = OurIndex::load(&our).unwrap();
    let second = build_plan(&source, ROOT, &index2, &our, "22").unwrap();
    assert_eq!(second.report.tags_unioned, 0);
    assert_eq!(second.report.descriptions_written, 0);
    assert_eq!(second.report.source_urls_written, 0);
    assert_eq!(second.report.topics_created, 0);
    assert_eq!(second.report.topic_files_added, 0);
    assert_eq!(second.report.topics_merged_name, 6, "第一次并入夹具里已有的「已有专题」，第二次连自己新建的 5 个也一起命中");
    assert_eq!(second.report.topics_covered, 0, "第一次已经把空封面补齐了，第二次没什么可补");
    assert!(
        second.topics.iter().all(|t| t.file_ids.is_empty()),
        "成员都在里面了，第二次不该再并任何文件"
    );
    assert!(!has_anything_to_migrate(&second.report), "第二次不该写迁移记录（§6.1 第 3 条）");
}

// ---------------------------------------------------------------- 发现与错误路径

#[test]
fn discovery_filters_registrations_without_a_library() {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let current = Some(normalize_path(ROOT));
    // 真实存在的目录（我们的仓库根下没有 .pixcall → 应当被过滤）
    push_library(&mut out, &mut seen, "C:/Windows/Temp", &current);
    assert!(out.is_empty(), "没有 .pixcall 的注册项一律过滤（§1 本机 D:\\资源 就是这种）");

    push_library(&mut out, &mut seen, "  ", &current);
    assert!(out.is_empty());
}

#[test]
fn tag_ids_without_a_vocabulary_row_are_dropped_with_a_report() {
    let src = source_conn();
    src.execute("DELETE FROM tags WHERE id = 501", []).unwrap();
    let our = our_conn();
    let source = read_from(&src, None).unwrap();
    let index = OurIndex::load(&our).unwrap();
    let p = build_plan(&source, ROOT, &index, &our, "22").unwrap();
    let a = p.edits.iter().find(|e| e.file_id == "fa").unwrap();
    assert_eq!(a.tags.as_deref().unwrap(), &["test2".to_string(), "极乐净土".to_string()]);
    assert!(p.report.warnings.iter().any(|w| w.contains("查不到名字")));
}
