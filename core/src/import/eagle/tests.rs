//! Eagle 解码、匹配与智能夹规则的单元测试。
//!
//! 夹具是**真库形态的子集**（2026-10-05 从本机 `Test.library` 抄的结构，调研 §13）：
//! 根 `metadata.json`（folders/smartFolders/tagsGroups/applicationVersion）+
//! `images/<ID>.info/{metadata.json, <name>.<ext>, <name>_thumbnail.png}`。
//! 端到端的真数验证在 `eagle_real_library_smoke`（`#[ignore]`）。

use super::*;
use crate::db::file_metadata::FileMetadata;
use crate::db::{init_db, topics};
use crate::import::apply_plan;
use rusqlite::Connection;
use serde_json::json;

/// 每个测试一棵独立的临时库，Drop 时清掉。
struct Lib {
    root: PathBuf,
}

impl Lib {
    fn new(tag: &str) -> Lib {
        let millis = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0);
        let root = std::env::temp_dir().join(format!(
            "aurora-eagle-test-{}-{}-{}",
            tag,
            std::process::id(),
            millis
        ));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("images")).unwrap();
        Lib { root }
    }

    fn header(&self, v: Value) {
        write_json(&self.root.join("metadata.json"), &v);
    }

    /// 放一个 `<id>.info/` 条目目录；`files` 是实体/杂物文件名。
    fn item(&self, id: &str, meta: Value, files: &[&str]) {
        let dir = self.root.join("images").join(format!("{}.info", id));
        std::fs::create_dir_all(&dir).unwrap();
        write_json(&dir.join("metadata.json"), &meta);
        for f in files {
            std::fs::write(dir.join(f), b"px").unwrap();
        }
    }

    fn source(&self) -> SourceData {
        read_source(
            &DiscoveredLibrary {
                root: self.path(),
                is_current: false,
            },
            None,
        )
        .unwrap()
    }

    fn path(&self) -> String {
        self.root.to_string_lossy().to_string()
    }
}

impl Drop for Lib {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write_json(path: &Path, v: &Value) {
    std::fs::write(path, serde_json::to_string(v).unwrap()).unwrap();
}

/// 条目 metadata（§3.1 常用键；缺的键靠解码侧容忍）。
fn item_meta(id: &str, name: &str, ext: &str) -> Value {
    json!({
        "id": id,
        "name": name,
        "ext": ext,
        "size": 1000,
        "width": 100,
        "height": 50,
        "tags": [],
        "folders": [],
        "isDeleted": false,
        "url": "",
        "annotation": "",
    })
}

fn meta_with(id: &str, name: &str, ext: &str, tags: &[&str], folders: &[&str]) -> Value {
    let mut v = item_meta(id, name, ext);
    v["tags"] = json!(tags);
    v["folders"] = json!(folders);
    v
}

fn rule(property: &str, method: &str, value: Value) -> Value {
    json!({"property": property, "method": method, "value": value})
}

fn group(match_: &str, rules: Vec<Value>) -> Value {
    json!({"match": match_, "boolean": "TRUE", "rules": rules})
}

fn our_db() -> Connection {
    let c = Connection::open_in_memory().unwrap();
    init_db(&c).unwrap();
    c
}

fn add_row(
    c: &Connection,
    file_id: &str,
    path: &str,
    name: &str,
    size: i64,
    w: Option<i64>,
    h: Option<i64>,
) {
    c.execute(
        "INSERT INTO file_index (file_id, path, name, file_type, size, width, height) \
         VALUES (?1, ?2, ?3, 'Image', ?4, ?5, ?6)",
        rusqlite::params![file_id, path, name, size, w, h],
    )
    .unwrap();
}

fn plan_for(lib: &Lib, our: &Connection) -> MigrationPlan {
    let source = lib.source();
    let index = OurIndex::load(our).unwrap();
    build_plan(&source, &index, our).unwrap()
}

// ---------------------------------------------------------------- 解码

#[test]
fn decode_tolerates_missing_keys_and_prefers_the_directory_name() {
    let lib = Lib::new("decode");
    lib.header(json!({"folders": [], "applicationVersion": "4.0.0"}));
    // 目录名 DIRID ≠ JSON 里的 id：以目录名为准（§2）
    lib.item("DIRID", json!({"id": "JSONID"}), &[]);
    let source = lib.source();
    assert_eq!(source.items.len(), 1);
    let item = &source.items[0];
    assert_eq!(item.id, "DIRID", "条目 id 以目录名为准");
    assert_eq!(item.name, "");
    assert_eq!(item.ext, "");
    assert_eq!(item.size, None);
    assert!(item.tags.is_empty() && item.folders.is_empty());
    assert!(!item.is_deleted);
    assert!(!item.has_entity, "目录里只有 metadata.json = 无实体条目");
    assert_eq!(source.application_version, "4.0.0");
}

/// §8.4：库头与条目 metadata.json 同名，按内容分类、不按文件路径猜。
#[test]
fn json_classification_is_by_content_not_by_path() {
    assert_eq!(
        classify_json(&json!({"id": "MGMYDH18YSIS1", "name": "a"})),
        JsonKind::Item
    );
    assert_eq!(
        classify_json(&json!({"folders": [], "smartFolders": [], "applicationVersion": "4.0.0"})),
        JsonKind::Header
    );
    // 条目也有 folders 键（夹 id 数组）——但它的 id 是字符串，先判 Item
    assert_eq!(classify_json(&json!({"folders": ["F1"]})), JsonKind::Header);
    assert_eq!(classify_json(&json!({"hello": 1})), JsonKind::Other);
}

#[test]
fn an_item_like_root_metadata_is_an_error_not_a_guess() {
    let lib = Lib::new("badroot");
    // 用户指错路径：根 metadata.json 是条目级 JSON
    write_json(&lib.root.join("metadata.json"), &json!({"id": "X", "name": "a"}));
    let err = read_source(
        &DiscoveredLibrary {
            root: lib.path(),
            is_current: false,
        },
        None,
    )
    .unwrap_err();
    assert!(err.contains("不是库头"), "实际：{}", err);
}

/// §8.4：`*_thumbnail.*` 一律不是实体；三级回退（精确 → 前缀 → 目录内文件）逐级兜底。
#[test]
fn thumbnails_are_never_the_entity_and_fallbacks_apply() {
    let lib = Lib::new("entity");
    lib.header(json!({"folders": []}));
    // 只有 thumbnail → 无实体（Bookmark 形态）
    lib.item("A1", item_meta("A1", "onlythumb", "png"), &["onlythumb_thumbnail.png"]);
    // 精确命中（thumbnail 并存也不干扰）
    lib.item("A2", item_meta("A2", "exact", "jpg"), &["exact.jpg", "exact_thumbnail.png"]);
    // 前缀回退：ext 对不上，但 <name>.* 存在
    lib.item("A3", item_meta("A3", "prefixed", "jpg"), &["prefixed.png"]);
    // 兜底：目录里只剩一个名字对不上的文件
    lib.item("A4", item_meta("A4", "renamed", "jpg"), &["whatever.dat"]);
    let source = lib.source();
    let by_id = |id: &str| source.items.iter().find(|i| i.id == id).unwrap();
    assert!(!by_id("A1").has_entity);
    assert!(by_id("A2").has_entity);
    assert!(by_id("A3").has_entity);
    assert!(by_id("A4").has_entity);
}

/// §2：条目集合以 `readdir(images/)` 为准。`mtime.json` 的 `"all"` 是计数不是 id、
/// 可能落后——绝不作为条目集合来源（这里干脆不读它）。
#[test]
fn item_set_comes_from_readdir_not_mtime() {
    let lib = Lib::new("readdir");
    lib.header(json!({"folders": []}));
    lib.item("B1", item_meta("B1", "a", "jpg"), &["a.jpg"]);
    write_json(
        &lib.root.join("mtime.json"),
        &json!({"B1": 1, "GHOST": 2, "all": 99}),
    );
    // images/ 下的杂项：非 .info 目录与散文件都不进条目集合
    std::fs::create_dir_all(lib.root.join("images").join("NOTINFO")).unwrap();
    std::fs::write(lib.root.join("images").join("loose.txt"), b"x").unwrap();
    let source = lib.source();
    assert_eq!(source.items.len(), 1);
    assert_eq!(source.items[0].id, "B1");
}

// ---------------------------------------------------------------- 匹配（§13.3 标定）

#[test]
fn name_ext_index_returns_every_candidate_case_insensitively() {
    let our = our_db();
    add_row(&our, "fa", "C:/L/a/twin.jpg", "twin.jpg", 1000, Some(100), Some(50));
    add_row(&our, "fb", "C:/L/b/TWIN.JPG", "TWIN.JPG", 1000, Some(100), Some(50));
    add_row(&our, "fc", "C:/L/other.png", "other.png", 1000, Some(100), Some(50));
    let index = OurIndex::load(&our).unwrap();
    let hits = index.find_by_name_ext("twin.jpg");
    assert_eq!(hits.len(), 2, "同键全部候选都返回，多义交给调用方，不加 file_type 条件");
    assert_eq!(hits[0].file_id, "fa", "按 path 排序保证可复现");
    assert!(index.find_by_name_ext("missing.jpg").is_empty());
    // 既有 path 索引的行为不变（pixcall 的 81 个用例护着的那一半）
    assert_eq!(
        index.find("C:/L/b/TWIN.JPG").map(|r| r.file_id.as_str()),
        Some("fb")
    );
}

#[test]
fn matching_is_case_insensitive_and_rechecks_size_and_dims() {
    let lib = Lib::new("match");
    lib.header(json!({"folders": []}));
    // Eagle 侧大小写与索引不同：键统一小写后命中
    lib.item("C1", meta_with("C1", "Photos", "PNG", &["T"], &[]), &["Photos.PNG"]);
    // size 不符
    let mut bad = item_meta("C2", "mismatch", "jpg");
    bad["size"] = json!(9999);
    lib.item("C2", bad, &["mismatch.jpg"]);
    // 我们侧宽高 NULL
    lib.item("C3", item_meta("C3", "nulldims", "jpg"), &["nulldims.jpg"]);

    let our = our_db();
    add_row(&our, "f1", "C:/L/photos.png", "photos.png", 1000, Some(100), Some(50));
    add_row(&our, "f2", "C:/L/mismatch.jpg", "mismatch.jpg", 1000, Some(100), Some(50));
    add_row(&our, "f3", "C:/L/nulldims.jpg", "nulldims.jpg", 1000, None, None);
    let p = plan_for(&lib, &our);

    assert_eq!(p.report.matched, 1);
    let hit = p.edits.iter().find(|e| e.file_id == "f1").unwrap();
    assert_eq!(hit.tags.as_deref(), Some(["T".to_string()].as_slice()), "命中并合并标注的是 C1");
    assert_eq!(p.report.unmatched, 2);
    let mut items = p.report.unmatched_items.clone();
    items.sort();
    assert_eq!(items, vec!["mismatch.jpg".to_string(), "nulldims.jpg".to_string()]);
    assert!(p.report.warnings.iter().any(|w| w.contains("mismatch.jpg") && w.contains("复核不过")));
    assert!(p.report.warnings.iter().any(|w| w.contains("nulldims.jpg") && w.contains("复核不过")));
}

#[test]
fn ambiguous_names_are_reported_not_guessed() {
    let lib = Lib::new("ambiguous");
    lib.header(json!({"folders": []}));
    lib.item("D1", item_meta("D1", "twin", "jpg"), &["twin.jpg"]);
    let our = our_db();
    add_row(&our, "fa", "C:/L/a/twin.jpg", "twin.jpg", 1000, Some(100), Some(50));
    add_row(&our, "fb", "C:/L/b/twin.jpg", "twin.jpg", 1000, Some(100), Some(50));
    let p = plan_for(&lib, &our);
    assert_eq!(p.report.matched, 0);
    assert_eq!(p.report.unmatched, 1);
    assert_eq!(p.report.unmatched_items, vec!["twin.jpg".to_string()]);
    assert!(p.report.warnings.iter().any(|w| w.contains("同名多义")));
}

#[test]
fn a_name_that_hits_nothing_goes_to_unmatched_items() {
    let lib = Lib::new("ghost");
    lib.header(json!({"folders": []}));
    lib.item("D2", item_meta("D2", "ghost", "jpg"), &["ghost.jpg"]);
    let p = plan_for(&lib, &our_db());
    assert_eq!(p.report.matched, 0);
    assert_eq!(p.report.unmatched, 1);
    assert_eq!(p.report.unmatched_items, vec!["ghost.jpg".to_string()]);
}

// ---------------------------------------------------------------- 分类顺序（§4.8 变体）

/// 顺序错了会把同一条目重复计入两栏：回收站里的 mp4 只能进 excluded_trash。
#[test]
fn trash_is_excluded_before_the_type_filter() {
    let lib = Lib::new("order");
    lib.header(json!({"folders": [{"id": "F1", "name": "游戏", "children": []}]}));
    let mut trashed = meta_with("E1", "trashed", "mp4", &["X"], &["F1"]);
    trashed["isDeleted"] = json!(true);
    lib.item("E1", trashed, &["trashed.mp4"]);
    // 正常的 mp4：skipped_unsupported_type + annotated_unsupported
    lib.item("E2", meta_with("E2", "video", "mp4", &["Y"], &[]), &["video.mp4"]);
    let p = plan_for(&lib, &our_db());

    assert_eq!(p.report.excluded_trash, 1);
    assert_eq!(p.report.excluded_trash_names[0].name, "trashed.mp4");
    assert_eq!(
        p.report.excluded_trash_names[0].origin_folder.as_deref(),
        Some("游戏"),
        "origin_folder 从夹树解析"
    );
    assert_eq!(p.report.skipped_unsupported_type, 1, "只有 video.mp4，回收站那条不算支持性问题");
    assert_eq!(p.report.annotated_unsupported, 1);
}

/// §8.3：Bookmark 类（无实体文件）不参与匹配，进 unmatched_items 并记类别计数，
/// 不许混进 skipped_unsupported_type。
#[test]
fn bookmarks_without_entity_go_to_unmatched_items() {
    let lib = Lib::new("bookmark");
    lib.header(json!({"folders": []}));
    // §8.3：Bookmark 无 ext、无 size（键整体缺失，靠解码侧容忍）
    lib.item(
        "G1",
        json!({"id": "G1", "name": "一些网页", "url": "https://eagle.cool", "isDeleted": false, "tags": [], "folders": []}),
        &["一些网页_thumbnail.png"],
    );
    let p = plan_for(&lib, &our_db());
    assert_eq!(p.report.unmatched, 1);
    assert_eq!(p.report.unmatched_items, vec!["一些网页".to_string()]);
    assert!(p.report.warnings.iter().any(|w| w.contains("无实体文件")));
    assert_eq!(p.report.skipped_unsupported_type, 0, "不是支持性问题，不许混栏");
}

// ---------------------------------------------------------------- 手动夹树（§4.6）

#[test]
fn folder_tree_creates_nested_topics_multi_membership_and_merges_same_names() {
    let lib = Lib::new("folders");
    lib.header(json!({
        "folders": [
            {"id": "F1", "name": "游戏", "description": "夹简介", "children": [
                {"id": "F11", "name": "子夹", "children": []}
            ]},
            {"id": "F2", "name": "已有专题", "children": []}
        ]
    }));
    lib.item("H1", meta_with("H1", "a", "jpg", &["T"], &["F1"]), &["a.jpg"]);
    // 一条同时属两个夹（D6）：嵌套子夹 + 根级同名夹
    lib.item("H2", meta_with("H2", "b", "jpg", &[], &["F11", "F2"]), &["b.jpg"]);

    let our = our_db();
    add_row(&our, "f1", "C:/L/a.jpg", "a.jpg", 1000, Some(100), Some(50));
    add_row(&our, "f2", "C:/L/b.jpg", "b.jpg", 1000, Some(100), Some(50));
    our.execute("INSERT INTO topics (id, name) VALUES ('exist1', '已有专题')", []).unwrap();
    let p = plan_for(&lib, &our);

    let f1 = p.topics.iter().find(|t| t.name == "游戏").unwrap();
    assert_eq!(f1.parent_id, None);
    assert_eq!(f1.file_ids, vec!["f1".to_string()]);
    assert_eq!(f1.description.as_deref(), Some("夹简介"), "夹描述非空时写入（§4.6 规则 5）");
    let f11 = p.topics.iter().find(|t| t.name == "子夹").unwrap();
    assert_eq!(f11.parent_id.as_deref(), Some(f1.id.as_str()), "先序父先落库，子挂父（§4.6 规则 1）");
    assert_eq!(f11.file_ids, vec!["f2".to_string()]);

    // 同名并入（v4.9）：不新建，成员并进已有专题
    let merged = p.topics.iter().find(|t| t.id == "exist1").unwrap();
    assert!(merged.merge_into_existing);
    assert_eq!(merged.file_ids, vec!["f2".to_string()]);
    assert_eq!(p.report.topics_merged_name, 1);
    assert_eq!(p.report.topics_created, 2);
    assert_eq!(p.report.topic_files_added, 3, "游戏 1 + 子夹 1 + 并入 1");

    // 落库后：层级 + 一条目多专题（topic_files 多对多）都真的在
    apply_plan(&our, &p, 100, None).unwrap();
    let all = topics::get_all_topics(&our).unwrap();
    let f1_row = all.iter().find(|t| t.name == "游戏").unwrap();
    let f11_row = all.iter().find(|t| t.name == "子夹").unwrap();
    assert_eq!(f11_row.parent_id.as_deref(), Some(f1_row.id.as_str()));
    assert_eq!(topics::get_topic_files(&our, "exist1").unwrap(), vec!["f2".to_string()]);
    assert_eq!(topics::get_topic_files(&our, &f11_row.id).unwrap(), vec!["f2".to_string()]);
}

#[test]
fn password_folders_skip_the_whole_subtree() {
    let lib = Lib::new("password");
    lib.header(json!({"folders": [
        {"id": "FP", "name": "密", "password": "AAAA", "children": [
            {"id": "FPC", "name": "夹内孩子", "children": []}
        ]},
        {"id": "F1", "name": "普通", "children": []}
    ]}));
    lib.item("I1", meta_with("I1", "a", "jpg", &[], &["FPC"]), &["a.jpg"]);
    let our = our_db();
    add_row(&our, "f1", "C:/L/a.jpg", "a.jpg", 1000, Some(100), Some(50));

    let source = lib.source();
    assert!(
        source.folders.iter().all(|n| n.id != "FP" && n.id != "FPC"),
        "密码夹的子树整体不出现（D7：不解密、不列内容）"
    );
    assert_eq!(source.password_folders, vec!["密".to_string()]);

    let p = plan_for(&lib, &our);
    assert!(!p.topics.iter().any(|t| t.name == "密" || t.name == "夹内孩子"));
    assert_eq!(p.report.topic_files_added, 0, "成员关系也不落");
    assert!(p.report.warnings.iter().any(|w| w.contains("密码夹") && w.contains("不解密")));
}

/// 实测（§13.2）：直接拖文件进 Eagle 不建普通夹，`folders` 树为空 + 条目 `folders:[]`
/// 是主流形态，不是错误——条目照常挂标注，只是不进任何专题。
#[test]
fn empty_folders_tree_is_the_mainstream_shape_not_an_error() {
    let lib = Lib::new("flat");
    lib.header(json!({"folders": [], "smartFolders": []}));
    lib.item("R1", meta_with("R1", "a", "jpg", &["T"], &[]), &["a.jpg"]);
    let our = our_db();
    add_row(&our, "f1", "C:/L/a.jpg", "a.jpg", 1000, Some(100), Some(50));
    let p = plan_for(&lib, &our);
    assert_eq!(p.report.matched, 1);
    assert_eq!(p.report.tags_unioned, 1);
    assert!(p.topics.is_empty());
    assert_eq!(p.report.topics_created, 0);
}

// ---------------------------------------------------------------- 智能夹（P2b）

#[test]
fn smart_folder_materializes_only_when_the_count_assertion_passes() {
    let lib = Lib::new("smart");
    lib.header(json!({
        "smartFolders": [
            // 实测标定：contain "HEAD" 大小写不敏感，命中小写 head1
            {"id": "S1", "name": "HEA", "conditions": [group("OR", vec![rule("name", "contain", json!("HEAD"))])], "imageCount": 1},
            // 实测标定：type=equal 与 ext 大小写不敏感比较
            {"id": "S2", "name": "JPGS", "conditions": [group("OR", vec![rule("type", "equal", json!("JPG"))])], "imageCount": 2},
            // 断言不过
            {"id": "S3", "name": "WRONG", "conditions": [group("OR", vec![rule("type", "equal", json!("jpg"))])], "imageCount": 999},
            // 未标定键
            {"id": "S4", "name": "RATED", "conditions": [group("AND", vec![rule("rating", "greater", json!(4))])], "imageCount": 1},
            // boolean 非 "TRUE" → 未标定
            {"id": "S5", "name": "BOOL", "conditions": [json!({"match": "OR", "boolean": "FALSE", "rules": [rule("type", "equal", json!("jpg"))]})], "imageCount": 2},
            // 没有 imageCount → 无法断言
            {"id": "S6", "name": "NOCOUNT", "conditions": [], "children": []}
        ]
    }));
    lib.item("K1", item_meta("K1", "head1", "jpg"), &["head1.jpg"]);
    lib.item("K2", item_meta("K2", "other", "jpg"), &["other.jpg"]);
    let our = our_db();
    add_row(&our, "f1", "C:/L/head1.jpg", "head1.jpg", 1000, Some(100), Some(50));
    add_row(&our, "f2", "C:/L/other.jpg", "other.jpg", 1000, Some(100), Some(50));
    let p = plan_for(&lib, &our);

    let hea = p.topics.iter().find(|t| t.name == "HEA").unwrap();
    assert!(hea.materialized);
    assert_eq!(hea.file_ids, vec!["f1".to_string()]);
    let jpgs = p.topics.iter().find(|t| t.name == "JPGS").unwrap();
    assert!(jpgs.materialized);
    assert_eq!(jpgs.file_ids, vec!["f1".to_string(), "f2".to_string()]);
    assert_eq!(p.report.topics_materialized, 2);
    assert_eq!(p.report.topics_skipped_unverifiable, 4, "S3 断言不过 + S4/S5 未标定 + S6 无 imageCount");
    assert!(p.report.warnings.iter().any(|w| w.contains("WRONG") && w.contains("计数断言不过")));
    assert!(p.report.warnings.iter().any(|w| w.contains("RATED") && w.contains("未标定")));
    assert!(p.report.warnings.iter().any(|w| w.contains("NOCOUNT") && w.contains("imageCount")));
}

/// 实测标定：contain 的 value 为空串 = 什么都不命中（OCR 夹 `value:""` 且 imageCount=0）。
/// 断言过（0==0）但成员为 0 → 不落空专题，warnings 说明。
#[test]
fn empty_contain_value_matches_nothing_and_creates_no_empty_topic() {
    let lib = Lib::new("ocr");
    lib.header(json!({"smartFolders": [
        {"id": "S1", "name": "OCR", "conditions": [group("OR", vec![rule("name", "contain", json!(""))])], "imageCount": 0}
    ]}));
    lib.item("L1", item_meta("L1", "head1", "jpg"), &["head1.jpg"]);
    let our = our_db();
    add_row(&our, "f1", "C:/L/head1.jpg", "head1.jpg", 1000, Some(100), Some(50));
    let p = plan_for(&lib, &our);
    assert!(p.topics.is_empty(), "不落空专题");
    assert_eq!(p.report.topics_created, 0);
    assert_eq!(p.report.topics_materialized, 0);
    assert!(p.report.warnings.iter().any(|w| w.contains("OCR") && w.contains("不落空专题")));
}

/// 子智能夹按自己的独立 conditions 求值（不实现父条件继承，按严的来）；
/// 父级没落库时子不陪葬，降级挂根（§4.6 规则 2）。
#[test]
fn smart_child_is_evaluated_independently_and_reparented_when_parent_skips() {
    let lib = Lib::new("smarttree");
    lib.header(json!({"smartFolders": [
        {"id": "P1", "name": "父", "conditions": [group("OR", vec![rule("color", "similar", json!("#ff0000"))])], "children": [
            {"id": "C1", "name": "子", "parent": "P1", "conditions": [group("OR", vec![rule("name", "contain", json!("head"))])], "imageCount": 1}
        ]}
    ]}));
    lib.item("M1", item_meta("M1", "head1", "jpg"), &["head1.jpg"]);
    let our = our_db();
    add_row(&our, "f1", "C:/L/head1.jpg", "head1.jpg", 1000, Some(100), Some(50));
    let p = plan_for(&lib, &our);

    let child = p.topics.iter().find(|t| t.name == "子").unwrap();
    assert_eq!(child.parent_id, None, "父级未标定没落库 → 降级挂根");
    assert!(child.materialized, "子按自己的独立条件求值，不受父连坐");
    assert_eq!(p.report.topics_reparented, 1);
    assert_eq!(p.report.topics_skipped_unverifiable, 1, "只有父（未标定 color）跳过");
}

// ---------------------------------------------------------------- 合并（共享策略）

#[test]
fn annotations_merge_with_our_side() {
    let lib = Lib::new("merge");
    lib.header(json!({"folders": []}));
    let mut a = meta_with("P1", "a", "jpg", &["Eagle标签", "共享"], &[]);
    a["annotation"] = json!("Eagle 的备注\n");
    a["url"] = json!("https://from.example/x");
    lib.item("P1", a, &["a.jpg"]);
    let our = our_db();
    add_row(&our, "f1", "C:/L/a.jpg", "a.jpg", 1000, Some(100), Some(50));
    file_metadata::upsert_file_metadata(
        &our,
        &FileMetadata {
            file_id: "f1".into(),
            path: "C:/L/a.jpg".into(),
            tags: Some(serde_json::json!(["我们的", "共享"])),
            description: Some("我们自己写的".into()),
            source_url: Some("https://ours.example/1".into()),
            source_urls: Some(vec!["https://ours.example/1".into()]),
            ai_data: None,
            category: None,
            updated_at: Some(1),
        },
    )
    .unwrap();
    let p = plan_for(&lib, &our);

    let e = p.edits.iter().find(|e| e.file_id == "f1").unwrap();
    // 并集保留我们已有顺序，新词追加（§4 映射表第一行）
    assert_eq!(
        e.tags.as_deref().unwrap(),
        &["我们的".to_string(), "共享".to_string(), "Eagle标签".to_string()][..]
    );
    // 描述让位（仅为空时填）
    assert_eq!(e.description, None);
    // 来源链接追加（P1(b)：我们已有的不动，源侧那条加到后面）
    assert_eq!(
        e.source_urls.as_deref(),
        Some(["https://ours.example/1".to_string(), "https://from.example/x".to_string()].as_slice())
    );
    assert_eq!(p.report.tags_unioned, 1);
    assert_eq!(p.report.descriptions_skipped_existing, 1);
    assert_eq!(p.report.source_urls_written, 1);

    apply_plan(&our, &p, 100, None).unwrap();
    let after = file_metadata::get_metadata_by_id(&our, "f1").unwrap().unwrap();
    assert_eq!(after.description.as_deref(), Some("我们自己写的"));
    assert_eq!(
        after.source_urls(),
        vec!["https://ours.example/1", "https://from.example/x"]
    );
}

/// annotation trim 后仅为空时填（PixCall ⑨ 同款；fill_if_empty 自带 trim）。
#[test]
fn annotation_fills_an_empty_description_after_trimming() {
    let lib = Lib::new("desc");
    lib.header(json!({"folders": []}));
    let mut a = item_meta("Q1", "a", "jpg");
    a["annotation"] = json!("  Eagle 的备注\n");
    lib.item("Q1", a, &["a.jpg"]);
    let our = our_db();
    add_row(&our, "f1", "C:/L/a.jpg", "a.jpg", 1000, Some(100), Some(50));
    let p = plan_for(&lib, &our);
    let e = p.edits.iter().find(|e| e.file_id == "f1").unwrap();
    assert_eq!(e.description.as_deref(), Some("Eagle 的备注"));
    assert_eq!(p.report.descriptions_written, 1);
}

// ---------------------------------------------------------------- 报告与杂项

/// H2 拍板：`unmatched_paths` 恒空（保留给 PixCall），`unmatched_items` 装「显示名.ext」；
/// `source_schema_version` = 库头 applicationVersion。
#[test]
fn report_columns_follow_the_h2_decision() {
    let lib = Lib::new("h2");
    lib.header(json!({"folders": [], "applicationVersion": "4.0.0"}));
    lib.item("N0", item_meta("N0", "ghost", "jpg"), &["ghost.jpg"]);
    let p = plan_for(&lib, &our_db());
    assert_eq!(p.report.unmatched_paths, Vec::<String>::new());
    assert_eq!(p.report.unmatched_items, vec!["ghost.jpg".to_string()]);
    assert_eq!(p.source_schema_version, "4.0.0");
    // 报告能原样过一遍 JSON（serde 往返）
    let json = serde_json::to_string(&p.report).unwrap();
    let back: MigrationReport = serde_json::from_str(&json).unwrap();
    assert_eq!(back, p.report);
}

/// 旧 `report_json`（没有 unmatchedItems 栏）反序列化不能破（H2：加新栏 + serde default）。
/// 旧记录的形态 = 现在的全栏减去新栏，所以拿序列化结果抹掉 `unmatchedItems` 来模拟。
#[test]
fn old_report_json_without_unmatched_items_still_deserializes() {
    let mut report = MigrationReport::default();
    report.matched = 3;
    report.unmatched = 1;
    report.unmatched_paths = vec!["C:/a.png".to_string()];
    report.unmatched_items = vec!["a.jpg".to_string()];
    let json = serde_json::to_string(&report).unwrap();
    let mut old: Value = serde_json::from_str(&json).unwrap();
    assert!(
        old.as_object_mut().unwrap().remove("unmatchedItems").is_some(),
        "新栏在序列化输出里，抹掉它就是旧 report_json 的形态"
    );
    let back: MigrationReport = serde_json::to_string(&old).and_then(|s| serde_json::from_str(&s)).unwrap();
    assert_eq!(back.unmatched_items, Vec::<String>::new(), "旧记录没有这一栏，反序列化为空数组");
    assert_eq!(back.unmatched_paths, vec!["C:/a.png".to_string()]);
    assert_eq!(back.matched, 3);
}

/// P3/P4：标签组与图上矩形标注都是丢弃 + 上报。
#[test]
fn tag_groups_and_comments_are_dropped_with_reports() {
    let lib = Lib::new("drops");
    lib.header(json!({
        "tagsGroups": [{"id": "g", "name": "Location", "tags": ["Kitchen"]}],
        "folders": []
    }));
    let mut c = item_meta("N1", "a", "jpg");
    c["comments"] = json!([{"id": "c1", "annotation": "图上的矩形区域标注"}]);
    lib.item("N1", c, &["a.jpg"]);
    let our = our_db();
    add_row(&our, "f1", "C:/L/a.jpg", "a.jpg", 1000, Some(100), Some(50));
    let p = plan_for(&lib, &our);
    assert!(p.report.warnings.iter().any(|w| w.contains("tagsGroups") && w.contains("丢弃")));
    assert!(p.report.warnings.iter().any(|w| w.contains("comments") && w.contains("丢弃")));
    // star（P5）完全不迁：不进报告、不进 edits——夹具里根本没给它留落点
}

// ---------------------------------------------------------------- 发现（调研 §1）

#[test]
fn discovery_requires_metadata_and_images() {
    // 不用 Lib::new（它会顺手建 images/），手工搭一个逐步补齐的目录
    let dir = std::env::temp_dir().join(format!(
        "aurora-eagle-validity-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.to_string_lossy().to_string();
    assert!(!is_valid_library(&path), "空目录不行");
    write_json(&dir.join("metadata.json"), &json!({}));
    assert!(!is_valid_library(&path), "metadata.json 是文件但缺 images/ 也不行");
    std::fs::create_dir_all(dir.join("images")).unwrap();
    assert!(is_valid_library(&path));
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn discovery_scans_children_and_filters_invalid_libraries() {
    let base = Lib::new("disc");
    let good = base.root.join("Test.library");
    std::fs::create_dir_all(good.join("images")).unwrap();
    write_json(&good.join("metadata.json"), &json!({"folders": []}));
    // 注册了没建库 / 建坏了：过滤（PixCall 那条「注册了没建库」的教训）
    let broken = base.root.join("Broken.library");
    std::fs::create_dir_all(&broken).unwrap();
    // 名字不合的目录不扫
    std::fs::create_dir_all(base.root.join("NotALibrary")).unwrap();

    let mut out = Vec::new();
    let mut seen = HashSet::new();
    let none: Option<String> = None;
    scan_for_libraries(&base.root, &mut out, &mut seen, &none);
    let roots: Vec<String> = out.iter().map(|l| l.root.clone()).collect();
    assert_eq!(roots, vec![normalize_path(good.to_str().unwrap())]);
    // 去重：再扫一遍不会出双份
    scan_for_libraries(&base.root, &mut out, &mut seen, &none);
    assert_eq!(out.len(), 1);
}

// ------------------------------------------------- 真实库 smoke（dev-only，调研 §10 ②）

/// 本机 `Test.library`（调研 §13 的实测库）存在时跑一遍 probe 链路（发现 → 读源 → 计划），
/// 逐栏打印报告。**不断言具体数字**，只断言链路不出错；不存在就早退。
/// 跑法：`cargo test -p aurora-core eagle_real_library_smoke -- --ignored --nocapture`
#[test]
#[ignore]
fn eagle_real_library_smoke() {
    const ROOT: &str = "C:\\Users\\misakimiku\\Pictures\\AuroraGallery\\Test.library";
    if !is_valid_library(ROOT) {
        println!("eagle_real_library_smoke：真实库不存在（{}），早退", ROOT);
        return;
    }

    // 发现链路：给资源根，应能扫到这个库（②扫一级子目录）
    let discovered = discover(Some("C:\\Users\\misakimiku\\Pictures\\AuroraGallery"));
    assert!(
        discovered
            .iter()
            .any(|l| normalize_path(&l.root) == normalize_path(ROOT)),
        "discover 应能从资源根扫到 Test.library，实际：{:?}",
        discovered
    );

    let library = DiscoveredLibrary {
        root: ROOT.to_string(),
        is_current: false,
    };
    let source = read_source(&library, None).expect("读真实库");

    // 我们的侧：用库自己的实体清单喂一个内存索引。smoke 验证的是解码 + 匹配 + 计划链路，
    // 不是真实命中率——那是调研 §13.3 拿真实 metadata.db 测过的（索引陈旧时 69.4%）。
    let our = our_db();
    for item in &source.items {
        if !item.has_entity {
            continue;
        }
        add_row(
            &our,
            &item.id,
            &format!(
                "{}/images/{}.info/{}.{}",
                source.root, item.id, item.name, item.ext
            ),
            &format!("{}.{}", item.name, item.ext),
            item.size.unwrap_or(0),
            item.width,
            item.height,
        );
    }
    let index = OurIndex::load(&our).unwrap();
    let plan = build_plan(&source, &index, &our).expect("出计划");

    // 逐栏打印（dev-only 报告输出）
    let r = &plan.report;
    println!("========== Eagle 真实库 probe 报告（{}） ==========", source.root);
    println!("source_schema_version:           {}", plan.source_schema_version);
    println!("matched:                         {}", r.matched);
    println!("tags_unioned:                    {}", r.tags_unioned);
    println!("tags_words_added:                {}", r.tags_words_added);
    println!("descriptions_written:            {}", r.descriptions_written);
    println!("descriptions_skipped_existing:   {}", r.descriptions_skipped_existing);
    println!("source_urls_written:             {}", r.source_urls_written);
    println!("source_urls_skipped_existing:    {}", r.source_urls_skipped_existing);
    println!("topics_created:                  {}", r.topics_created);
    println!("topic_files_added:               {}", r.topic_files_added);
    println!("topics_merged_name:              {}", r.topics_merged_name);
    println!("topics_covered:                  {}", r.topics_covered);
    println!("topics_materialized:             {}", r.topics_materialized);
    println!("topics_skipped_unverifiable:     {}", r.topics_skipped_unverifiable);
    println!("topics_reparented:               {}", r.topics_reparented);
    println!("skipped_unsupported_type:        {}", r.skipped_unsupported_type);
    println!("annotated_unsupported:           {}", r.annotated_unsupported);
    println!("topic_members_skipped_type:      {}", r.topic_members_skipped_type);
    println!("excluded_trash:                  {}", r.excluded_trash);
    println!("excluded_trash_names:            {:?}", r.excluded_trash_names);
    println!("unmatched:                       {}", r.unmatched);
    println!("unmatched_paths（恒空）:          {:?}", r.unmatched_paths);
    println!("unmatched_items:                 {:?}", r.unmatched_items);
    println!("warnings:");
    for w in &r.warnings {
        println!("  - {}", w);
    }
    println!(
        "解码条目 {} / 手动夹 {} / 智能夹 {} / 密码夹 {} / tagsGroups {}",
        source.items.len(),
        source.folders.len(),
        source.smart_folders.len(),
        source.password_folders.len(),
        source.tags_groups
    );
}

// ---------------------------------------------------------------- C 档：连文件接管
//
// 这几条测的是「搬完之后用户的图库能独立存在」这件事：实体从 `<ID>.info/` 里剥出来、
// 剥掉缩略图、按夹落进用户自己的资源根，并且**搬运进来的新行要能被 A 档认亲链命中**
// （Q8：先搬 → 后认亲，不另写一套）。

fn temp_target(tag: &str) -> PathBuf {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!(
        "aurora-eagle-target-{}-{}-{}",
        tag,
        std::process::id(),
        millis
    ));
    let _ = std::fs::remove_dir_all(&path);
    path
}

/// 一个带实体的条目（`size` 与真实文件一致，认亲复核要用）。
fn lib_with_item(tag: &str) -> Lib {
    let lib = Lib::new(tag);
    lib.header(json!({"folders": [], "applicationVersion": "4.0.0"}));
    let meta = json!({
        "id": "A1", "name": "bentley", "ext": "jpg", "size": 2,
        "width": 100, "height": 50, "tags": ["car"], "folders": [], "isDeleted": false
    });
    // `_thumbnail.png` 必须跟着：它就是验收人实测里那张「多余的第二张缩略图」
    lib.item("A1", meta, &["bentley.jpg", "bentley_thumbnail.png"]);
    lib
}

#[test]
fn takeover_copies_the_entity_and_never_the_thumbnail() {
    let lib = lib_with_item("take-basic");
    let target = temp_target("take-basic");
    let our_db_conn = our_db();
    let our = OurIndex::load(&our_db_conn).unwrap();

    let plan = plan_takeover(&lib.source(), &our, &target.to_string_lossy(), false).unwrap();
    let preview = takeover_preview(&plan);
    assert_eq!(preview.total_items, 1, "只有 1 个条目参与");
    assert_eq!(preview.to_copy, 1, "禁掉硬链接时走复制");

    let outcome = execute_takeover(&plan, None);
    assert_eq!(outcome.copied, 1);
    assert_eq!(outcome.files.len(), 1);

    let dst = Path::new(&outcome.files[0].path);
    assert!(dst.is_file(), "实体要真的落到目标目录里：{}", dst.display());
    assert_eq!(dst.file_name().unwrap(), "bentley.jpg");
    // ★ 目标目录里只有一张图：`.info` 这层目录与 `_thumbnail.png` 都不进图库
    let listed: Vec<String> = std::fs::read_dir(dst.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(listed, vec!["bentley.jpg".to_string()]);
    // 源库全程只读：实体还在原处
    assert!(lib
        .root
        .join("images/A1.info/bentley.jpg")
        .is_file());

    // ③ 搬运结果入库后，A 档的认亲链要能命中它（Q8）
    let mut conn = our_db();
    index_takeover(&mut conn, &outcome).unwrap();
    let reloaded = OurIndex::load(&conn).unwrap();
    assert!(
        !reloaded.find_by_name_ext("bentley.jpg").is_empty(),
        "搬进来的行要能被 name+ext 认亲命中"
    );
    let plan2 = build_plan(&lib.source(), &reloaded, &conn).unwrap();
    assert_eq!(plan2.report.matched, 1, "搬运完再认亲应当命中");
    assert_eq!(plan2.report.tags_unioned, 1, "标签照挂（A 档复用同一条链）");

    let _ = std::fs::remove_dir_all(&target);
}

#[test]
fn takeover_skips_what_we_already_have() {
    let lib = lib_with_item("take-skip");
    let target = temp_target("take-skip");
    let conn = our_db();
    // 我们库里已经有同一张图（同名 + 同 size + 同宽高）
    add_row(&conn, "EXISTING", "C:/our/bentley.jpg", "bentley.jpg", 2, Some(100), Some(50));
    let our = OurIndex::load(&conn).unwrap();

    let plan = plan_takeover(&lib.source(), &our, &target.to_string_lossy(), false).unwrap();
    let preview = takeover_preview(&plan);
    assert_eq!(preview.already_here, 1, "认亲命中 = 不搬");
    assert_eq!(preview.to_copy, 0, "没有东西要搬");

    let outcome = execute_takeover(&plan, None);
    assert_eq!(outcome.copied, 0);
    assert_eq!(outcome.already_here, 1);
    assert!(outcome.files.is_empty());

    let _ = std::fs::remove_dir_all(&target);
}

#[test]
fn takeover_mirrors_the_folder_tree_and_disambiguates_names() {
    let lib = Lib::new("take-tree");
    lib.header(json!({
        "folders": [
            {"id": "F1", "name": "Cars"},
            {"id": "F2", "name": "Cars", "children": []}
        ],
        "applicationVersion": "4.0.0"
    }));
    let meta_in_f = |id: &str, name: &str| -> Value {
        json!({"id": id, "name": name, "ext": "png", "size": 2, "width": 10, "height": 10,
               "tags": [], "folders": ["F1"], "isDeleted": false})
    };
    lib.item("A1", meta_in_f("A1", "same"), &["same.png"]);
    // 另一个夹也要有成员，且名字故意撞车 → 撞名加 `_<短id>`（Q5）
    let mut meta2 = meta_in_f("A2", "same");
    meta2["folders"] = json!(["F2"]);
    lib.item("A2", meta2, &["same.png"]);

    let target = temp_target("take-tree");
    let conn = our_db();
    let our = OurIndex::load(&conn).unwrap();
    let plan = plan_takeover(&lib.source(), &our, &target.to_string_lossy(), false).unwrap();
    let outcome = execute_takeover(&plan, None);

    let names: Vec<String> = outcome
        .files
        .iter()
        .map(|f| Path::new(&f.path).file_name().unwrap().to_string_lossy().to_string())
        .collect();
    assert_eq!(names.len(), 2, "两条都要搬进来，谁也不许丢");
    assert!(names.iter().any(|n| n.starts_with("same")), "落盘名以显示名为主：{:?}", names);
    assert!(
        names.iter().any(|n| n.contains("_A2") || n.contains("_A1")),
        "撞名要消歧：{:?}",
        names
    );
    // 有夹时按夹镜像一层目录（Q2）：两个夹同名，第二个要带短 id
    let parents: Vec<String> = outcome
        .files
        .iter()
        .map(|f| {
            Path::new(&f.path)
                .parent()
                .and_then(|p| p.file_name())
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default()
        })
        .collect();
    assert!(parents.iter().all(|p| p.starts_with("Cars")), "夹名镜像成目录：{:?}", parents);

    let _ = std::fs::remove_dir_all(&target);
}

#[test]
fn takeover_refuses_to_write_into_the_library() {
    let lib = lib_with_item("take-guard");
    let conn = our_db();
    let our = OurIndex::load(&conn).unwrap();
    // 目标落在库内部 → 必须报错，不能一层层把自己拷进去（硬约束 1：库只读）
    let inside = lib.root.join("images");
    let err = plan_takeover(
        &lib.source(),
        &our,
        &inside.to_string_lossy(),
        false,
    );
    assert!(err.is_err(), "往库里搬东西必须被拒");
    assert!(err.unwrap_err().contains("库"), "错误信息要点明是库的问题");
}

/// 同名不同图：我们索引里已经有一个 `bentley.jpg`（尺寸不同），搬进来的那张必须改名，
/// 否则认亲键变多义 → 两张都成 unmatched（Q5 那条「撞名才加后缀」的真正用途）。
#[test]
fn takeover_renames_when_the_name_would_become_ambiguous() {
    let lib = lib_with_item("take-name");
    let target = temp_target("take-name");
    let conn = our_db();
    // 同名但不同图（size 2 vs 999，宽高也不同）
    add_row(&conn, "OTHER", "C:/our/bentley.jpg", "bentley.jpg", 999, Some(1), Some(1));
    let our = OurIndex::load(&conn).unwrap();

    let plan = plan_takeover(&lib.source(), &our, &target.to_string_lossy(), false).unwrap();
    let outcome = execute_takeover(&plan, None);
    assert_eq!(outcome.copied, 1);

    let name = Path::new(&outcome.files[0].path)
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    assert!(name.contains("_A1"), "撞名要加短 id 后缀，实际落盘名：{}", name);

    // 落盘之后认亲键仍唯一 → 这条能被命中（而不是变成多义不命中）
    let mut conn2 = our_db();
    index_takeover(&mut conn2, &outcome).unwrap();
    let reloaded = OurIndex::load(&conn2).unwrap();
    assert_eq!(reloaded.find_by_name_ext(&name.to_lowercase()).len(), 1);

    let _ = std::fs::remove_dir_all(&target);
}

#[test]
fn takeover_is_idempotent_when_run_twice() {
    let lib = lib_with_item("take-twice");
    let target = temp_target("take-twice");
    let conn = our_db();
    let our = OurIndex::load(&conn).unwrap();
    let target_str = target.to_string_lossy().to_string();

    let first = execute_takeover(&plan_takeover(&lib.source(), &our, &target_str, false).unwrap(), None);
    assert_eq!(first.copied, 1);

    // 第二次：目标位置已有同尺寸文件 → 幂等跳过（Q7）
    let second = execute_takeover(&plan_takeover(&lib.source(), &our, &target_str, false).unwrap(), None);
    assert_eq!(second.copied, 0, "重跑不该再复制一遍");
    assert_eq!(second.skipped_existing, 1);

    let _ = std::fs::remove_dir_all(&target);
}
