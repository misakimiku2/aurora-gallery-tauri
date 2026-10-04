//! 多来源标注导入（设计方案 §6.4）。
//!
//! PixCall 是第一站，Eagle 是第二期。这里只放**与来源无关**的那一半：
//! 快照/只读访问的管理约定、合并策略（并集 / 仅为空时填 / 同名不新建 / `position` 续排）、
//! §4.7 报告结构、§6.5 迁移记录表。**来源特定的那一半**（库发现、格式解码、手动/智能判据、
//! 跳过清单，**以及下面第 2 条禁令涉及的 join 链**）在各适配器里（`pixcall.rs`）。
//!
//! 两条 per-source 禁令（设计方案 v4.16，来自 `docs/Eagle数据迁移-格式调研.md`）：
//! 1. **「复制 db+wal」不许进 trait 契约**——Eagle 的库不是 SQLite，是 `.library/` 目录：
//!    根 `metadata.json`（夹树 / 智能夹 / 标签组）+ 根 `mtime.json`（增量日志，含 `"all"` 计数键）
//!    + `images/<ID>.info/{metadata.json, <name>.<ext>, <name>_thumbnail.png}`。
//! 2. **「重建路径 → `normalize_path` → `file_index.path`」同样不许进契约**——这条链的前提是
//!    源侧记下了文件在真实目录里的位置，而 Eagle **导入即把文件复制进库、不留原始路径**
//!    （官方口径：「不是仅创建索引链接到原始文件」），左值在我们库里根本不存在。
//!    Eagle 期开工前要先拍板「文件从哪来」（调研 §5 四条路线、§10 P1），别照 PixCall 的写法抄。

use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

pub mod pixcall;

use crate::db::file_metadata::{self, FileMetadata};
use crate::db::{normalize_path, topics};

/// §4.9 第 1 条：全仓**唯一**一处问「我们支不支持这类文件」。
///
/// 今天 `video/*` 返回 false、`image/*` 返回 true。视频支持立项 = 改这一个函数
/// + scanner 收视频 + `file_index` 加 Video 类型，**导入器一行不改**：原本被
/// §4.8 ② 拦下的视频标注会自动走到 ④⑤ 正常落库。
/// 禁止在导入器其它地方散落 `== "image"` 或扩展名黑名单。
pub fn is_indexable(content_type: &str) -> bool {
    content_type.starts_with("image/")
}

/// §4.7：报告必须分栏，缺一栏在验收时就会看起来像丢数据。
///
/// **所有计数都是 u32；PixCall 的 64 位 id 一律不进这个结构**（⑥：过一遍 JSON 就
/// 精度丢失，而报告要走 serde→JSON→webview）。明细栏只放字符串（名字、路径）。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MigrationReport {
    /// ④ 路径命中的条目数（标注级）
    pub matched: u32,
    /// 并集写入 `file_metadata.tags` 的行数
    pub tags_unioned: u32,
    /// 词表净增词数（只算实际落库的那些词）
    pub tags_words_added: u32,
    pub descriptions_written: u32,
    /// 因我们侧已非空而让位的条数（§3 的 NTE 夹就是这个用例）
    pub descriptions_skipped_existing: u32,
    /// 追加进来的来源网址条数（P1(b)：我们已有的不动，只把源侧多出来的那条加到后面）
    pub source_urls_written: u32,
    /// 源侧那条网址我们已经有了、不重复添加的条数
    pub source_urls_skipped_existing: u32,
    /// 新建专题数（不含并到已有专题的那些）
    pub topics_created: u32,
    pub topic_files_added: u32,
    /// 同名命中已有专题、把成员**并进它**的个数（v4.9 拍板，取代原来的「让位不并」）。
    /// 仍不新建同名专题，也不改它的名字/父级。
    pub topics_merged_name: u32,
    /// 其中「原来没有封面、导入时补了一张（首张成员）」的个数。只在封面为空时写，
    /// 用户自己钉过的封面永不被覆盖。
    pub topics_covered: u32,
    /// 智能节点复算通过计数断言、固化为快照专题的个数（§4.6 规则 6/7）
    pub topics_materialized: u32,
    /// 断言不过或筛选含未标定键而跳过的智能节点（§4.6 规则 7/8）
    pub topics_skipped_unverifiable: u32,
    /// 父级未落库、降级挂到最近已迁祖先的节点数（§4.6 规则 2）
    pub topics_reparented: u32,
    /// §4.8 ②：`is_indexable` 为 false 的条目（今天即视频）
    pub skipped_unsupported_type: u32,
    /// 其中挂着标签、描述或来源链接的条数（§4.9 第 2 条：搁置的代价要在报告里可见）
    pub annotated_unsupported: u32,
    /// 合集成员里因类型被搁置的（§4.9 第 3 条）
    pub topic_members_skipped_type: u32,
    /// ① 排除的 Trash 子树条目数（⑫）
    pub excluded_trash: u32,
    /// Trash 项的名字清单（v4.5 拍板 A：不复制、只列名）
    pub excluded_trash_names: Vec<TrashItem>,
    /// ④ 路径不命中条数（不模糊猜，如实上报）
    pub unmatched: u32,
    pub unmatched_paths: Vec<String>,
    /// 规则外状态的说明（`tag_groups` 有行、标签挂在文件夹上、智能判据两信号不一致等）。
    /// 这些都不进计数栏，但不能静默吞掉。
    pub warnings: Vec<String>,
}

/// 回收站项的呈现单元：名字 + 原所在夹（取自 `source_path`，⑫）。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TrashItem {
    pub name: String,
    pub origin_folder: Option<String>,
}

/// 一条待写入的 `file_metadata` 变更。
///
/// `tags` / `description` / `source_urls` 都是**合并后的最终值**，None 表示这一列不动。
/// 之所以在计划阶段就把最终值算好，是为了让 probe 的预览计数与 import 的实际写入
/// 出自同一次计算（§6.2 末：两次读取之间源库被写，预览条数就会和实际导入条数对不上）。
#[derive(Debug, Clone)]
pub struct AnnotationEdit {
    pub file_id: String,
    pub path: String,
    pub tags: Option<Vec<String>>,
    pub description: Option<String>,
    /// 合并后的**完整**来源网址列表（P1(b)：我们已有的保留，PixCall 的那条追加在后面）。
    pub source_urls: Option<Vec<String>>,
}

/// 一个待落库的专题。`materialized` = 由智能看板固化出来的快照专题；
/// `merge_into_existing` = 命中了同父级的同名已有专题，这一条是**并进去**而不是新建
/// （`id` 就是那个已有专题的 id，`file_ids` 只装我们侧还没有的成员）。
#[derive(Debug, Clone)]
pub struct TopicCreate {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub parent_id: Option<String>,
    pub file_ids: Vec<String>,
    pub materialized: bool,
    pub merge_into_existing: bool,
}

/// 来源无关的迁移计划：§4.7 报告的预览值 + 要落的东西。
#[derive(Debug, Clone)]
pub struct MigrationPlan {
    pub report: MigrationReport,
    pub edits: Vec<AnnotationEdit>,
    pub topics: Vec<TopicCreate>,
    /// 源侧的 schema/格式版本，落 `import_records.source_schema_version`（§6.2 末条）
    pub source_schema_version: String,
}

/// 我们这一侧的匹配状态：`file_index` 的 path → 行。
///
/// §6.3 的前置条件是「导入前我们这边必须已经扫过一次」，所以 `file_index` 为空时
/// 调用方要给出口，而不是让它去匹配出满屏 unmatched。
#[derive(Debug, Clone, Default)]
pub struct OurIndex {
    exact: HashMap<String, IndexedRow>,
    /// 大小写不敏感回退（§6.3：各轮实测 0 条需要，但用户后改过名时会出现）
    by_lower: HashMap<String, IndexedRow>,
}

#[derive(Debug, Clone)]
pub struct IndexedRow {
    pub file_id: String,
    pub path: String,
    pub file_type: String,
}

impl OurIndex {
    pub fn load(conn: &Connection) -> Result<Self> {
        let mut stmt =
            conn.prepare("SELECT file_id, path, file_type FROM file_index")?;
        let rows = stmt.query_map([], |row| {
            Ok(IndexedRow {
                file_id: row.get(0)?,
                path: row.get(1)?,
                file_type: row.get(2)?,
            })
        })?;
        let mut out = Self::default();
        for row in rows {
            let r = row?;
            let lower = r.path.to_lowercase();
            out.exact.insert(r.path.clone(), r.clone());
            out.by_lower.insert(lower, r);
        }
        Ok(out)
    }

    pub fn len(&self) -> usize {
        self.exact.len()
    }

    pub fn is_empty(&self) -> bool {
        self.exact.is_empty()
    }

    /// join 键：**只按 path**（§6.3），命中顺序 = 精确 → 大小写不敏感回退一次。
    ///
    /// §4.9 第 3 条明令不许在这里加 `file_type` 条件：视频支持落地后同一路径的
    /// `file_type` 会从「不存在」变成 `Video`，任何带类型条件的 join 都会在那天静默失效。
    pub fn find(&self, path: &str) -> Option<&IndexedRow> {
        let normalized = normalize_path(path);
        self.exact
            .get(&normalized)
            .or_else(|| self.by_lower.get(&normalized.to_lowercase()))
    }
}

/// 我们侧已有的词表（`file_metadata.tags` 各行的并集 ∪ `tags` 表）。
///
/// `tags_words_added` 要对着它算净增。桌面真源是 JSON 列（§4.5），`tags` 表在桌面库
/// 本机 0 行、只有 Kotlin 写，读进来只是为了让「同一库被 Kotlin 写过」的情形也算对。
pub fn existing_vocabulary(conn: &Connection) -> Result<HashSet<String>> {
    let mut words = HashSet::new();
    let mut stmt = conn.prepare("SELECT tags FROM file_metadata WHERE tags IS NOT NULL")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        if let Ok(serde_json::Value::Array(list)) =
            serde_json::from_str::<serde_json::Value>(&row?)
        {
            for item in list {
                if let Some(s) = item.as_str() {
                    let t = s.trim();
                    if !t.is_empty() {
                        words.insert(t.to_string());
                    }
                }
            }
        }
    }
    let mut stmt = conn.prepare("SELECT tag FROM tags")?;
    let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        words.insert(row?);
    }
    Ok(words)
}

/// 并集：保留我们已有的顺序，新词追加在后面（§4 映射表第一行）。
///
/// 两边都过一遍 trim + 去重，与 `core/src/db/tags.rs:39` 的 `normalize()` 同一形态；
/// 标签名里的 `·`、全角 `：`、纯 ASCII 原样保留，不做额外清洗（⑧）。
pub fn merge_tag_lists(existing: &[String], incoming: &[String]) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for tag in existing.iter().chain(incoming.iter()) {
        let t = tag.trim();
        if t.is_empty() || !seen.insert(t.to_string()) {
            continue;
        }
        out.push(t.to_string());
    }
    out
}

fn is_blank(value: Option<&str>) -> bool {
    value.map(|v| v.trim().is_empty()).unwrap_or(true)
}

/// 「仅为空时填」（§4）：我们侧已有内容就让位，不覆盖用户写过的东西。
///
/// 返回 `(要写入的值, 是否让位)`。要写入的值已 trim——PixCall 的描述尾部带换行
/// （⑨：5/5 文件夹备注、2/5 图片备注带 `\n`），不 trim 会把空行带进我们的描述框。
pub fn fill_if_empty(
    existing: Option<&str>,
    incoming: Option<&str>,
) -> (Option<String>, bool) {
    let incoming = incoming.map(str::trim).filter(|v| !v.is_empty());
    match incoming {
        None => (None, false),
        Some(_) if is_blank(existing) => (incoming.map(str::to_string), false),
        Some(_) => (None, true),
    }
}

/// 查重键是 `(映射后的我们父级, name)`，不是裸名字（§4.6 规则 3：名字在树里不唯一，
/// 裸名字查重会把不同父下的同名合集合并掉）。命中时返回已有专题的 id。
pub fn find_topic_by_name(
    conn: &Connection,
    parent_id: Option<&str>,
    name: &str,
) -> Result<Option<String>> {
    let mut stmt = conn.prepare("SELECT id FROM topics WHERE name = ?1")?;
    let rows = stmt.query_map(params![name], |row| row.get::<_, String>(0))?;
    for row in rows {
        let id = row?;
        let parent: Option<String> = conn.query_row(
            "SELECT parent_id FROM topics WHERE id = ?1",
            params![&id],
            |row| row.get(0),
        )?;
        if parent.as_deref() == parent_id {
            return Ok(Some(id));
        }
    }
    Ok(None)
}

/// 我们侧专题 id 的形态是 9 位小写 base36（前端 `Math.random().toString(36).substr(2,9)`）。
/// 导入器在 Rust 里造同形态的 id：md5(种子) 取前 9 个 hex 字符，撞已有行就加盐重算。
pub fn new_topic_id(conn: &Connection, seed: &str) -> String {
    for salt in 0..64u32 {
        let candidate = format!(
            "{:x}",
            md5::compute(format!("{}|{}", seed, salt))
        )[..9]
            .to_string();
        let taken: bool = conn
            .query_row(
                "SELECT 1 FROM topics WHERE id = ?1",
                params![&candidate],
                |_| Ok(true),
            )
            .unwrap_or(false);
        if !taken {
            return candidate;
        }
    }
    // 64 次都撞上在真实库里不可能发生；兜个可辨识的名字而不是 panic。
    "import000".to_string()
}

/// §4.5 硬约束 1：`upsert_file_metadata` 是**全行覆盖**，漏传字段就是把已有数据清空。
/// 所以导入器必须先读整行、只改需要的列、再写回整行。
///
/// §4.5 硬约束 2：folder 节点走同一条写入路径（`scanner.rs` 的元数据合并不区分
/// Image/Folder，`FileNode.description` 已存在），所以文件夹行按 file_id 正常 upsert。
fn apply_edit(conn: &Connection, edit: &AnnotationEdit, now: i64) -> Result<()> {
    let mut row = file_metadata::get_metadata_by_id(conn, &edit.file_id)?
        .unwrap_or_else(|| FileMetadata {
            file_id: edit.file_id.clone(),
            path: edit.path.clone(),
            tags: None,
            description: None,
            source_url: None,
            source_urls: None,
            ai_data: None,
            category: None,
            updated_at: None,
        });

    if let Some(tags) = &edit.tags {
        row.tags = Some(serde_json::Value::Array(
            tags.iter().map(|t| serde_json::Value::String(t.clone())).collect(),
        ));
    }
    if edit.description.is_some() {
        row.description = edit.description.clone();
    }
    if let Some(urls) = &edit.source_urls {
        row.set_source_urls(urls.clone());
    }
    row.path = edit.path.clone();
    row.updated_at = Some(now);
    file_metadata::upsert_file_metadata(conn, &row)
}

/// 把计划落库，返回 §4.7 报告。
///
/// 计划里的报告是探测阶段算好的预览值，这里只做「写的过程不出错」的核对，
/// 不再重算规则——两条链共用同一份快照与同一份计划，正是为了让预览条数
/// 与实际导入条数一致（§6.2 末）。
///
/// 合并是纯增量的（并集 / 仅为空时填 / 同名不新建 / `position` 续排），**重跑安全**。
pub fn apply_plan(
    conn: &Connection,
    plan: &MigrationPlan,
    now: i64,
    progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
) -> Result<MigrationReport> {
    let total = plan.edits.len() + plan.topics.len();
    let mut done = 0usize;

    // 不开外层事务：`topics::insert_topic_files` 内部自己起 `unchecked_transaction`，
    // 外面再包一层就是「在事务里再开事务」。中途失败留下的是半份**纯增量**结果，
    // 修好后重跑即可补齐（并集 / 仅为空时填 / 同名不新建 / position 续排，§6.1 第 3 条）。
    for edit in &plan.edits {
        apply_edit(conn, edit, now)?;
        done += 1;
        report_progress(progress, done, total);
    }
    for topic in &plan.topics {
        if topic.merge_into_existing {
            merge_into_existing_topic(conn, topic, now)?;
        } else {
            let mut created = topics::Topic {
                id: topic.id.clone(),
                parent_id: topic.parent_id.clone(),
                name: topic.name.clone(),
                description: topic.description.clone(),
                topic_type: Some("TOPIC".to_string()),
                ..Default::default()
            };
            created.created_at = Some(now);
            created.updated_at = Some(now);
            // 桌面在「新成员归入且专题还没有封面」时拿第一张图当封面
            // （`useTopics.ts:89-98`：`targetFileIds.find(id => file.type === IMAGE)`）。
            // 导入器直接落库、绕过了那条前端路径，所以这里补同一条规则。成员按 §4.9 的
            // `is_indexable` 过滤后全是 image/*，首个成员就是首张图。
            if created.cover_file_id.is_none() {
                created.cover_file_id = topic.file_ids.first().cloned();
            }
            topics::upsert_topic(conn, &created)?;
            topics::add_files_to_topic(conn, &created.id, &topic.file_ids)?;
        }
        done += 1;
        report_progress(progress, done, total);
    }

    Ok(plan.report.clone())
}

/// 同名命中已有专题：并成员，不改它的名字与父级；封面和描述都「空着才补」。
///
/// 验收人 2026-09-29 拍板把 §4.6 规则 4 从「不新建也不合并成员」改成「同名就合并」。
/// 并成员走 `add_files_to_topic`（`INSERT OR IGNORE` + position 从现有 `COUNT(*)` 续排），
/// 计划阶段已经把在我们侧已存在的成员筛掉，所以重跑时这里是空操作。
///
/// 封面这条口子是为「幸存下来的子专题」开的：删父专题那阵子不级联，子专题行还在但
/// 封面永远是空的（`阿松大`/`test` 那次就是），光靠新建时补封面治不了它。
/// 用户钉过的封面、写过的简介一律不动。
fn merge_into_existing_topic(conn: &Connection, topic: &TopicCreate, now: i64) -> Result<()> {
    if !topic.file_ids.is_empty() {
        topics::add_files_to_topic(conn, &topic.id, &topic.file_ids)?;
    }

    let cover_empty: bool = conn.query_row(
        "SELECT COALESCE(cover_file_id, '') = '' FROM topics WHERE id = ?1",
        params![&topic.id],
        |row| row.get(0),
    )?;
    if cover_empty {
        // 首张成员按 position 取——可能是原来就在里面的那张，不只是这次新并进来的
        let first: Option<String> = conn
            .query_row(
                "SELECT file_id FROM topic_files WHERE topic_id = ?1 ORDER BY position LIMIT 1",
                params![&topic.id],
                |row| row.get(0),
            )
            .ok();
        if let Some(file_id) = first {
            conn.execute(
                "UPDATE topics SET cover_file_id = ?2, updated_at = ?3 WHERE id = ?1",
                params![&topic.id, file_id, now],
            )?;
        }
    }

    if let Some(description) = &topic.description {
        let description_empty: bool = conn.query_row(
            "SELECT COALESCE(description, '') = '' FROM topics WHERE id = ?1",
            params![&topic.id],
            |row| row.get(0),
        )?;
        if description_empty {
            conn.execute(
                "UPDATE topics SET description = ?2, updated_at = ?3 WHERE id = ?1",
                params![&topic.id, description, now],
            )?;
        }
    }
    Ok(())
}

fn report_progress(progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>, done: usize, total: usize) {
    if let Some(cb) = progress {
        cb(done, total);
    }
}

/// 这一份报告里有没有实际可迁的东西。
///
/// §6.1 第 3 条：probe 发现 0 条可迁标注时显示「未发现可迁移的标注」，且**不写迁移记录**。
/// 算上并进来的成员与补上的封面——同名合并那一路可能一条标注都不产生但确实动了库。
///
/// **P2（2026-10-02）：这里刻意不看 `topics_created`。**
/// 「只新建了几个没有任何成员的专题」不算真的动了库。这种情形唯一的来源是
/// **选了一个与资源根无关的库**——图一张都没进来，label 无处挂载，
/// 但 §4.6 的先序遍历仍会照着源侧的 boards 树建出一串空壳（它们的子看板还会挂上来，
/// 于是 `topics_created` 是正的）。把这些也算成「有东西可迁」的话，这条路会照常执行、
/// 照常落 `import_records`、UI 照常报成功，而用户拿到的只是「有专题、没图」，
/// 全程不会有任何异常提示——正是「有 tag 但没图」那条反馈的根。
///
/// 反过来，单个看板为空是**合法**的，不能据此跳过它：
/// 夹具里的 `folder-only` 成员全是 `entry_kind=0`（文件夹）而被 §4.9 拦下，
/// `file_ids` 因此为空，但它本身是源侧真实存在的节点，必须照建（棋盘层级要靠它）。
/// 所以「该不该执行」要在**整次导入**这层判断，不能在单个看板这层。
pub fn has_anything_to_migrate(report: &MigrationReport) -> bool {
    report.tags_unioned + report.descriptions_written + report.source_urls_written > 0
        || report.topic_files_added > 0
        || report.topics_covered > 0
}

/// §6.5：落一条迁移记录。写不写由调用方决定（见 `has_anything_to_migrate`）。
///
/// `report_json` 存的是 §4.7 全栏，设置面板「上次导入报告」展开区读这一列——
/// v4.5 拍板 A 的 `excluded_trash_names` 名字明细就在这里，welcome 卡片只给计数。
pub fn record_import(
    conn: &Connection,
    source: &str,
    source_root: &str,
    source_schema_version: &str,
    report: &MigrationReport,
    now: i64,
) -> Result<i64> {
    let report_json = serde_json::to_string(report)
        .map_err(|e| rusqlite::Error::InvalidParameterName(e.to_string()))?;
    let summary = crate::db::import_records::InsertSummary {
        matched: report.matched as i64,
        unmatched: report.unmatched as i64,
        // §6.5 只有 skipped_existing 一列：描述与来源链接两类让位合并计
        skipped_existing: (report.descriptions_skipped_existing
            + report.source_urls_skipped_existing) as i64,
        skipped_unsupported_type: report.skipped_unsupported_type as i64,
        topic_members_skipped_type: report.topic_members_skipped_type as i64,
    };
    crate::db::import_records::insert(
        conn,
        source,
        source_root,
        source_schema_version,
        &report_json,
        &summary,
        now,
    )
}

#[cfg(test)]
mod tests;
