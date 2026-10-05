//! 来源无关那一半的单元测试：合并策略、join 链、报告与落库保护。
//!
//! PixCall 编码专用的解码测试在 `super::pixcall` 里（那些函数是模块私有的）。

use super::*;
use rusqlite::params;

fn our_db() -> Connection {
    let conn = Connection::open_in_memory().expect("in-memory db");
    crate::db::init_db(&conn).expect("init tables");
    conn
}

fn add_index_row(conn: &Connection, file_id: &str, path: &str, file_type: &str) {
    conn.execute(
        "INSERT INTO file_index (file_id, path, name, file_type, size, created_at, modified_at) \
         VALUES (?1, ?2, ?3, ?4, 0, 0, 0)",
        params![file_id, path, path.rsplit('/').next().unwrap_or(path), file_type],
    )
    .unwrap();
}

fn meta(
    file_id: &str,
    path: &str,
    tags: Option<Vec<&str>>,
    description: Option<&str>,
    source_url: Option<&str>,
) -> FileMetadata {
    FileMetadata {
        file_id: file_id.to_string(),
        path: path.to_string(),
        tags: tags.map(|list| {
            serde_json::Value::Array(list.iter().map(|t| serde_json::json!(t)).collect())
        }),
        description: description.map(str::to_string),
        source_url: source_url.map(str::to_string),
        source_urls: source_url.map(|s| vec![s.to_string()]),
        ai_data: None,
        category: None,
        updated_at: Some(1),
    }
}

// ---------------------------------------------------------------- 并集 / 仅为空时填

#[test]
fn union_keeps_our_order_and_appends_new_words() {
    let merged = merge_tag_lists(
        &["test2".into(), "枪".into()],
        &["枪".into(), "武器".into(), "gun".into()],
    );
    assert_eq!(merged, vec!["test2", "枪", "武器", "gun"]);
}

/// §3 的现成用例：`明日方舟：终末地` 两边都有，并集不许产生第二个。
#[test]
fn a_word_present_on_both_sides_stays_single() {
    let merged = merge_tag_lists(&["明日方舟：终末地".into()], &["明日方舟：终末地".into(), "卡缪".into()]);
    assert_eq!(merged, vec!["明日方舟：终末地", "卡缪"]);
}

/// ⑧：标签名里的 `·`、全角 `：`、纯 ASCII 原样保留，只做 trim + 去重。
#[test]
fn odd_characters_survive_normalization() {
    let merged = merge_tag_lists(&[], &["里昂·S·肯尼迪".into(), " CEP ".into(), "舒恩：助手".into()]);
    assert_eq!(
        merged,
        vec!["里昂·S·肯尼迪", "CEP", "舒恩：助手"]
    );
}

#[test]
fn fill_if_empty_yields_to_existing_content() {
    // §3 的 NTE 夹用例：我们侧已非空 → 让位，且要把「让位」报出来
    let (value, yielded) = fill_if_empty(Some("上一轮我给了四个主要抱怨"), Some("异环游戏内的截图\n"));
    assert_eq!(value, None);
    assert!(yielded);
}

/// ⑨：PixCall 的描述尾部带换行，落库前必须 trim。
#[test]
fn fill_if_empty_trims_the_trailing_newline() {
    let (value, yielded) = fill_if_empty(None, Some("TP9带后托\n"));
    assert_eq!(value.as_deref(), Some("TP9带后托"));
    assert!(!yielded);

    let (value, _) = fill_if_empty(Some("   "), Some("卡缪"));
    assert_eq!(value.as_deref(), Some("卡缪"));

    let (value, yielded) = fill_if_empty(None, Some("  \n"));
    assert_eq!(value, None);
    assert!(!yielded, "源侧空描述不该算让位");
}

// ---------------------------------------------------------------- join 链

/// §6.3：`\` → `/`、去盘符前导斜杠、去尾斜杠之后才比较。
#[test]
fn join_matches_after_normalize_and_back_slashes() {
    let conn = our_db();
    add_index_row(&conn, "abc123def", "C:/Users/M/Videos/NVIDIA/a.png", "Image");
    let index = OurIndex::load(&conn).unwrap();
    assert_eq!(
        index.find("C:\\Users\\M\\Videos\\NVIDIA\\a.png").map(|r| r.file_id.as_str()),
        Some("abc123def")
    );
    assert_eq!(index.find("/C:/Users/M/Videos/NVIDIA/a.png").map(|r| r.file_id.as_str()), Some("abc123def"));
}

/// 大小写不敏感回退一次（§6.3：用户后改过名时会出现）。
#[test]
fn join_falls_back_to_case_insensitive_once() {
    let conn = our_db();
    add_index_row(&conn, "id1", "C:/L/Photo.PNG", "Image");
    let index = OurIndex::load(&conn).unwrap();
    assert_eq!(index.find("c:/l/photo.png").map(|r| r.file_id.as_str()), Some("id1"));
    // 精确命中优先：同一路径大小写不同都存在于索引时取精确那条
    add_index_row(&conn, "id2", "c:/l/photo.png", "Image");
    let index = OurIndex::load(&conn).unwrap();
    assert_eq!(index.find("c:/l/photo.png").map(|r| r.file_id.as_str()), Some("id2"));
}

/// §4.9 第 3 条：join 不许带 file_type 条件——文件夹行也要能命中（⑩ 文件夹备注）。
#[test]
fn join_also_resolves_folder_rows() {
    let conn = our_db();
    add_index_row(&conn, "fold1", "C:/L/NTE (Neverness To Everness)", "Folder");
    let index = OurIndex::load(&conn).unwrap();
    assert_eq!(
        index
            .find("C:/L/NTE (Neverness To Everness)")
            .map(|r| r.file_type.as_str()),
        Some("Folder")
    );
}

// ---------------------------------------------------------------- 词表与查重

#[test]
fn vocabulary_unions_the_json_column_and_the_tags_table() {
    let conn = our_db();
    file_metadata::upsert_file_metadata(
        &conn,
        &meta("f1", "C:/a.png", Some(vec!["王权", "test2"]), None, None),
    )
    .unwrap();
    crate::db::tags::add_tag_to_vocabulary(&conn, "只在词表里").unwrap();
    let vocab = existing_vocabulary(&conn).unwrap();
    assert!(vocab.contains("王权"));
    assert!(vocab.contains("只在词表里"));
    assert!(!vocab.contains("没有这个词"));
}

/// §4.6 规则 3：查重键是 `(父级, name)`，名字在树里不唯一。
#[test]
fn topic_name_lookup_is_scoped_to_the_parent() {
    let conn = our_db();
    conn.execute(
        "INSERT INTO topics (id, parent_id, name) VALUES ('root1', NULL, 'OPK')",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO topics (id, parent_id, name) VALUES ('kid1', 'root1', 'Koc')",
        [],
    )
    .unwrap();
    assert_eq!(
        find_topic_by_name(&conn, None, "Koc").unwrap(),
        None,
        "根下没有叫 Koc 的专题，子级那个不算"
    );
    assert_eq!(
        find_topic_by_name(&conn, Some("root1"), "Koc").unwrap().as_deref(),
        Some("kid1")
    );
    assert_eq!(
        find_topic_by_name(&conn, None, "OPK").unwrap().as_deref(),
        Some("root1")
    );
}

#[test]
fn generated_topic_ids_are_nine_chars_and_unique() {
    let conn = our_db();
    let a = new_topic_id(&conn, "seed-a");
    let b = new_topic_id(&conn, "seed-b");
    assert_eq!(a.len(), 9);
    assert_ne!(a, b);
    conn.execute("INSERT INTO topics (id, name) VALUES (?1, 'x')", params![&a]).unwrap();
    assert_ne!(new_topic_id(&conn, "seed-a"), a, "撞已有 id 要换一个新的");
}

// ---------------------------------------------------------------- 落库保护

/// §4.5 硬约束 1：`upsert_file_metadata` 是**全行覆盖**，导入器必须先读整行、
/// 只改需要的列、再写回整行。这条测试盯的就是「漏传字段把已有数据清空」。
#[test]
fn apply_preserves_columns_the_import_does_not_touch() {
    let conn = our_db();
    add_index_row(&conn, "f1", "C:/a.png", "Image");
    let mut existing = meta("f1", "C:/a.png", Some(vec!["test2"]), None, None);
    existing.ai_data = Some(serde_json::json!({"wd14": ["char:a"]}));
    existing.category = Some("anime".to_string());
    file_metadata::upsert_file_metadata(&conn, &existing).unwrap();

    let plan = MigrationPlan {
        report: MigrationReport::default(),
        edits: vec![AnnotationEdit {
            file_id: "f1".to_string(),
            path: "C:/a.png".to_string(),
            tags: Some(vec!["test2".to_string(), "极乐净土".to_string()]),
            description: Some("新描述".to_string()),
            source_urls: None,
        }],
        topics: Vec::new(),
        source_schema_version: "22".to_string(),
    };
    let report = apply_plan(&conn, &plan, 100, None).unwrap();
    assert_eq!(report, plan.report);

    let after = file_metadata::get_metadata_by_id(&conn, "f1").unwrap().unwrap();
    assert_eq!(after.tags.unwrap(), serde_json::json!(["test2", "极乐净土"]));
    assert_eq!(after.description.as_deref(), Some("新描述"));
    assert_eq!(after.category.as_deref(), Some("anime"), "category 被清空就是全行覆盖踩坑");
    assert_eq!(
        after.ai_data,
        Some(serde_json::json!({"wd14": ["char:a"]})),
        "ai_data 被清空就是全行覆盖踩坑"
    );
}

/// 文件夹行走同一条写入路径（§4.5 硬约束 2）。
#[test]
fn apply_writes_folder_rows_by_file_id() {
    let conn = our_db();
    add_index_row(&conn, "fold1", "C:/NTE", "Folder");
    let plan = MigrationPlan {
        report: MigrationReport::default(),
        edits: vec![AnnotationEdit {
            file_id: "fold1".to_string(),
            path: "C:/NTE".to_string(),
            tags: None,
            description: Some("异环游戏内的截图".to_string()),
            source_urls: None,
        }],
        topics: Vec::new(),
        source_schema_version: "22".to_string(),
    };
    apply_plan(&conn, &plan, 100, None).unwrap();
    let after = file_metadata::get_metadata_by_id(&conn, "fold1").unwrap().unwrap();
    assert_eq!(after.description.as_deref(), Some("异环游戏内的截图"));
}

/// 合集落库：新建专题 + 成员 `position` 从现有 `COUNT(*)` 续排（§4 表 topics 行，
/// 同 `core/src/db/topics.rs:405` 语义），且 `file_count` 缓存要跟上。
#[test]
fn apply_creates_topics_with_sequenced_members() {
    let conn = our_db();
    add_index_row(&conn, "f1", "C:/a.png", "Image");
    add_index_row(&conn, "f2", "C:/b.png", "Image");
    conn.execute("INSERT INTO topics (id, name) VALUES ('t1', '阿松大')", [])
        .unwrap();
    crate::db::topics::add_files_to_topic(&conn, "t1", &["f1".to_string()]).unwrap();

    let plan = MigrationPlan {
        report: MigrationReport::default(),
        edits: Vec::new(),
        topics: vec![TopicCreate {
            id: "t2".to_string(),
            name: "test".to_string(),
            description: Some("智能固化".to_string()),
            parent_id: Some("t1".to_string()),
            file_ids: vec!["f1".to_string(), "f2".to_string()],
            materialized: true,
            merge_into_existing: false,
            reparent_existing: false,
        }],
        source_schema_version: "22".to_string(),
    };
    apply_plan(&conn, &plan, 100, None).unwrap();

    let positions: Vec<(String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT file_id, position FROM topic_files WHERE topic_id = 't2' ORDER BY position")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(positions, vec![("f1".to_string(), 0), ("f2".to_string(), 1)]);

    let (parent, name, count): (Option<String>, String, i32) = conn.query_row(
        "SELECT parent_id, name, file_count FROM topics WHERE id = 't2'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
    ).unwrap();
    assert_eq!(parent.as_deref(), Some("t1"), "层级照搬（§4.6 规则 1）");
    assert_eq!(name, "test");
    assert_eq!(count, 2, "file_count 是 topic_files 的缓存列，必须由 add_files_to_topic 刷新");

    // 桌面在归入成员时拿第一张图当封面（useTopics.ts:89-98）；导入器绕过那条路径，
    // 所以必须在落库时补上，否则专题卡片是空封面。
    let cover: Option<String> = conn
        .query_row("SELECT cover_file_id FROM topics WHERE id = 't2'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(cover.as_deref(), Some("f1"), "封面 = 首个成员（position 最小的那张图）");

    // 重跑安全：成员已在表里，再导一次不产生第二行
    apply_plan(&conn, &plan, 200, None).unwrap();
    let rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM topic_files WHERE topic_id = 't2'", [], |r| r.get(0))
        .unwrap();
    assert_eq!(rows, 2);
}

#[test]
fn is_indexable_is_the_single_support_gate() {
    // §4.9：今天 video/* 为 false、image/* 为 true；视频立项时只改这一个函数
    assert!(is_indexable("image/png"));
    assert!(is_indexable("image/jpeg"));
    assert!(!is_indexable("video/mp4"));
    assert!(!is_indexable("application/folder"));
    assert!(!is_indexable("unknown"));
}

/// v4.9 拍板：同名命中已有专题时**并成员**，而不是「不新建也不并入」。
/// 并的时候三件事必须成立：不改名字与父级、封面与描述「空着才补」、成员按 position 续排。
#[test]
fn merge_appends_members_and_only_fills_empty_fields() {
    let conn = our_db();
    add_index_row(&conn, "f1", "C:/a.png", "Image");
    add_index_row(&conn, "f2", "C:/b.png", "Image");
    conn.execute(
        "INSERT INTO topics (id, name, parent_id, cover_file_id, description) VALUES ('ex1', '已有专题', NULL, NULL, NULL)",
        [],
    )
    .unwrap();
    topics::add_files_to_topic(&conn, "ex1", &["f1".to_string()]).unwrap();

    let plan = MigrationPlan {
        report: MigrationReport::default(),
        edits: Vec::new(),
        topics: vec![TopicCreate {
            id: "ex1".to_string(),
            name: "看板给的别名".to_string(),
            description: Some("看板简介".to_string()),
            parent_id: Some("somewhere-else".to_string()),
            file_ids: vec!["f2".to_string()],
            materialized: false,
            merge_into_existing: true,
            reparent_existing: false,
        }],
        source_schema_version: "22".to_string(),
    };
    apply_plan(&conn, &plan, 100, None).unwrap();

    let members: Vec<(String, i64)> = {
        let mut stmt = conn
            .prepare("SELECT file_id, position FROM topic_files WHERE topic_id='ex1' ORDER BY position")
            .unwrap();
        stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap()
            .map(|r| r.unwrap())
            .collect()
    };
    assert_eq!(members, vec![("f1".to_string(), 0), ("f2".to_string(), 1)], "成员并进已有专题，position 续排");

    let (name, parent, cover, description): (String, Option<String>, Option<String>, Option<String>) = conn
        .query_row(
            "SELECT name, parent_id, cover_file_id, description FROM topics WHERE id='ex1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(name, "已有专题", "名字不改——那是用户给专题起的");
    assert_eq!(parent, None, "父级不改——并入的就是原来那个位置");
    assert_eq!(cover.as_deref(), Some("f1"), "补的是按 position 的首张成员，不是这次新并的那张");
    assert_eq!(description.as_deref(), Some("看板简介"), "简介是空着的，填上");

    // 已经有封面和简介的专题：再并一次，两个字段都不许动
    conn.execute(
        "UPDATE topics SET cover_file_id='keepme', description='我自己写的' WHERE id='ex1'",
        [],
    )
    .unwrap();
    let second = MigrationPlan {
        topics: vec![TopicCreate {
            id: "ex1".to_string(),
            name: "看板给的别名".to_string(),
            description: Some("看板简介".to_string()),
            parent_id: None,
            file_ids: vec![],
            materialized: false,
            merge_into_existing: true,
            reparent_existing: false,
        }],
        ..plan.clone()
    };
    apply_plan(&conn, &second, 200, None).unwrap();
    let (cover, description): (Option<String>, Option<String>) = conn
        .query_row(
            "SELECT cover_file_id, description FROM topics WHERE id='ex1'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(cover.as_deref(), Some("keepme"), "用户钉过的封面不会被重跑打回");
    assert_eq!(description.as_deref(), Some("我自己写的"), "用户写过的简介不会被覆盖");
}

/// 合并那一路可能一条标注都不产生、只补了一张封面——`has_anything_to_migrate` 得认它，
/// 否则这么一次改动不会留下迁移记录。
#[test]
fn a_cover_only_merge_still_counts_as_a_migration() {
    let mut report = MigrationReport::default();
    assert!(!has_anything_to_migrate(&report));
    report.topics_covered = 1;
    assert!(has_anything_to_migrate(&report));
    let mut report = MigrationReport::default();
    report.topic_files_added = 1;
    assert!(has_anything_to_migrate(&report));
}

/// P2（2026-10-02，与上一条成对）：**只新建了一堆没有任何成员的专题，不算一次迁移。**
///
/// 这种报告的来源只有一个——选了一个与资源根无关的库：图一张都没进来，标签无处挂载，
/// 但 §4.6 的先序遍历仍会照着源侧的 boards 树建出一串空壳。
/// 把它们也算成「有东西可迁」的话，这次会照常执行、照常落 `import_records`、
/// UI 照常报成功，用户拿到的却是「有专题、没图」——正是那条反馈的根因。
///
/// 注意反例：`folder-only` 那种成员全是 `entry_kind=0` 的看板**允许**建出空专题
/// （它是源侧真实存在的节点，层级要靠它），只要本次别的地方真的加进了成员。
#[test]
fn empty_topics_alone_do_not_count_as_a_migration() {
    let mut report = MigrationReport::default();
    report.topics_created = 5;
    assert!(
        !has_anything_to_migrate(&report),
        "只建了 5 个空专题，一张图都没关联 → 不该执行、不该留迁移记录"
    );

    // 只要真的动到了东西就该算：给其中一个塞进成员即可
    report.topic_files_added = 1;
    assert!(has_anything_to_migrate(&report));
}
