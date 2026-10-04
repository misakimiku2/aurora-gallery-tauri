//! PixCall 库适配器（设计方案 §6.4「来源特定」的那一半）。
//!
//! 职责：库发现（§6.3）、只读快照（§6.2）、格式解码（⑦⑨⑪⑫⑭）、手动/智能判据
//! 与层级规则（§4.6）、§5 的跳过清单。**合并策略与 join 链不在这里**，那部分是
//! 来源无关的，在 `super`（`mod.rs`）。
//!
//! 所有 PixCall 侧的 id 都是 64 位（`646087413270029312` 这种），过一遍 JSON 就会
//! 丢精度（⑥），所以解码全程留在 Rust，`MigrationReport` 里只放计数与字符串。

use rusqlite::{params, Connection, OpenFlags};
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::{
    existing_vocabulary, fill_if_empty, find_topic_by_name, is_indexable, merge_tag_lists,
    new_topic_id, AnnotationEdit, MigrationPlan, MigrationReport, OurIndex, TopicCreate, TrashItem,
};
use crate::db::file_metadata;
use crate::db::normalize_path;

pub const SOURCE_NAME: &str = "pixcall";

/// 虚拟根（`id=1, name='Pixcall'`）与回收站根（`id=2, name='Trash'`）。
/// ①/⑫ 实测：两者的 `parent_id` 都是 -1，各库都从 1、2 起，路径重建与 Trash 排除都以此为锚。
const VIRTUAL_ROOT_ID: i64 = 1;
const TRASH_ROOT_ID: i64 = 2;

/// 未命中明细的收集器：计数不受限，路径明细只留前 50 条（报告要走 serde→JSON→webview，
/// 几千条路径会把 UI 卡住）。
#[derive(Default)]
struct UnmatchedSet {
    seen: HashSet<String>,
    paths: Vec<String>,
}

impl UnmatchedSet {
    fn push(&mut self, path: String) {
        if self.seen.insert(path.clone()) && self.paths.len() < 50 {
            self.paths.push(path);
        }
    }
    fn into_parts(self) -> (usize, Vec<String>) {
        let mut paths = self.paths;
        paths.sort();
        (self.seen.len(), paths)
    }
}

/// 本模块内部统一用 String 错误（与 `AppDbPool` 一致，Tauri 命令返回值可直接序列化）。
type Res<T> = Result<T, String>;

fn blank(value: Option<&str>) -> bool {
    value.map(|v| v.trim().is_empty()).unwrap_or(true)
}

// ---------------------------------------------------------------- 库发现（§6.3）

/// §6.3 发现顺序的产物。`root` 是 `.pixcall` 所在目录，即 PixCall 库根。
#[derive(Debug, Clone)]
pub struct DiscoveredLibrary {
    pub root: String,
    pub pixcall_dir: String,
    /// `%APPDATA%\Pixcall\config.json` 的 `library_path` 指向的那一个
    pub is_current: bool,
}

/// §6.3 发现顺序：① `<我们当前根>\.pixcall`；② `%APPDATA%\Pixcall\config.json` 的
/// `libraries[]`，**过滤掉没有 `.pixcall` 的**（本机 `D:\资源` 就是注册了没建库）。
/// 返回多于一个时由 UI 给选择列表（§6.1 第 3 条）。
///
/// `pixcall_root`（`.pixcall` 所在目录）与我们当前打开的库根**必须分开建模**：本机二者
/// 重合，但「我们根 = Videos、PixCall 根 = Videos\NVIDIA」这种子目录情形要能支持——
/// 路径精确匹配照样能中，所以这里只认 `.pixcall` 的位置，不认我们的根。
pub fn discover(our_root: Option<&str>) -> Vec<DiscoveredLibrary> {
    let registry = read_registry();
    let current = registry
        .as_ref()
        .and_then(|(_, cur)| cur.as_deref())
        .map(normalize_path);

    let mut out: Vec<DiscoveredLibrary> = Vec::new();
    let mut seen = HashSet::new();

    // ① 我们当前库根下并排着一个 .pixcall（本机就是这种情况）
    if let Some(root) = our_root {
        push_library(&mut out, &mut seen, root, &current);
    }
    // ② 注册表里的各条
    if let Some((libraries, _)) = registry {
        for root in libraries {
            push_library(&mut out, &mut seen, &root, &current);
        }
    }
    out.sort_by(|a, b| b.is_current.cmp(&a.is_current).then(a.root.cmp(&b.root)));
    out
}

fn push_library(
    out: &mut Vec<DiscoveredLibrary>,
    seen: &mut HashSet<String>,
    root: &str,
    current: &Option<String>,
) {
    let normalized = normalize_path(root);
    if normalized.is_empty() || normalized.ends_with("/.pixcall") {
        return;
    }
    let pixcall_dir = format!("{}/.pixcall", normalized);
    // 注册了但没建库、或根本没装过 —— 一律过滤（§1 本机现状给出的硬要求）
    if !Path::new(&pixcall_dir).is_dir() {
        return;
    }
    if !seen.insert(normalized.clone()) {
        return;
    }
    out.push(DiscoveredLibrary {
        root: normalized.clone(),
        pixcall_dir,
        is_current: current.as_deref() == Some(normalized.as_str()),
    });
}

/// `%APPDATA%\Pixcall\config.json`：`libraries: string[]`（各库绝对路径）+ `library_path`（当前库）。
fn read_registry() -> Option<(Vec<String>, Option<String>)> {
    let appdata = std::env::var("APPDATA").ok()?;
    let file = Path::new(&appdata).join("Pixcall").join("config.json");
    let text = std::fs::read_to_string(file).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let libraries = value
        .get("libraries")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let current = value
        .get("library_path")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((libraries, current))
}

// ---------------------------------------------------------------- 只读快照（§6.2）

/// §6.2 只读快照：`main.db` + `main.db-wal` 复制到临时目录再打开。
///
/// **不能带 `-shm`**——Pixcall 运行时那个文件被独占（实测 `cp` 直接 `Device or resource
/// busy`）。只复制 db+wal 时 SQLite 靠 WAL 帧校验和忽略撕裂的尾帧、自行恢复，失效模式
/// 是「读到略旧的快照」而不是「读到坏数据」。wal 可能不存在（本机 `thumbs.db`/`tasks.db`
/// /`hashtree.db` 当下就无 `-wal`），复制逻辑要容忍缺文件。
///
/// probe 与 import **必须共用这一份快照**（§6.2 末）：源库是活的（⑤ 记过十几分钟内
/// thumbnails 1171→5402），两次各读一份会让预览条数和实际导入条数对不上。所以句柄要
/// 活着跨过两次调用，由调用方持有；临时目录随 `Drop` 删除。
pub struct Snapshot {
    dir: PathBuf,
    conn: Connection,
    pub root: String,
    pub pixcall_dir: String,
}

impl Snapshot {
    pub fn open(library: &DiscoveredLibrary) -> Res<Snapshot> {
        let src_db = Path::new(&library.pixcall_dir)
            .join("database")
            .join("main.db");
        if !src_db.is_file() {
            return Err(format!("{} 下没有 database/main.db", library.pixcall_dir));
        }

        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        let dir = std::env::temp_dir().join(format!("aurora-pixcall-snapshot-{}", nanos));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

        let db_path = dir.join("main.db");
        if let Err(e) = std::fs::copy(&src_db, &db_path) {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("复制 main.db 失败：{}", e));
        }
        let src_wal = src_db.with_extension("db-wal");
        if src_wal.is_file() {
            // 目标名必须跟着 main.db 叫 main.db-wal，SQLite 才认这套 WAL
            let _ = std::fs::copy(&src_wal, dir.join("main.db-wal"));
        }

        let opened = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_PRIVATE_CACHE,
        );
        let conn = match opened {
            Ok(conn) => conn,
            Err(e) => {
                let _ = std::fs::remove_dir_all(&dir);
                return Err(format!("只读打开快照失败：{}", e));
            }
        };
        let _ = conn.execute_batch("PRAGMA query_only=ON;");

        let check: String = conn
            .query_row("PRAGMA integrity_check;", [], |row| row.get(0))
            .unwrap_or_else(|_| "(无返回)".to_string());
        if check != "ok" {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(format!("快照 integrity_check 不过：{}", check));
        }

        Ok(Snapshot {
            dir,
            conn,
            root: normalize_path(&library.root),
            pixcall_dir: library.pixcall_dir.clone(),
        })
    }

    /// §6.2 末条：记录并核对 `kvs['schema_version']`（本机 22）。
    /// 不认识的版本只做能安全做的那部分，并在报告里说明——版本判定交给调用方决定文案。
    pub fn schema_version(&self) -> String {
        self.conn
            .query_row("SELECT v FROM kvs WHERE k = 'schema_version'", [], |row| {
                row.get::<_, String>(0)
            })
            .unwrap_or_default()
    }

    pub fn connection(&self) -> &Connection {
        &self.conn
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        // 对 `.pixcall` 零写入、零删除、零改名（§6.2）：这里删的只是我们自己的临时副本。
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

// ---------------------------------------------------------------- 解码

/// `entries` 的一行（已解码成我们能用的形态）。
#[derive(Debug, Clone)]
struct Entry {
    #[allow(dead_code)]
    id: i64,
    name: String,
    /// ①：库里不存绝对路径，这是从虚拟根逐级拼 `name` 得到的相对路径
    rel_path: String,
    /// 0 = 文件夹，1 = 文件
    kind: i64,
    content_type: String,
    size: i64,
    /// ⑦：竖线分隔的 **tag id**，不是标签名
    tag_ids: Vec<i64>,
    description: Option<String>,
    link: Option<String>,
    /// ⑫：回收站项的「删前所在夹」名；正常条目为 NULL
    source_path: Option<String>,
}

impl Entry {
    fn annotated(&self) -> bool {
        !self.tag_ids.is_empty() || !blank(self.description.as_deref()) || !blank(self.link.as_deref())
    }
}

#[derive(Debug, Clone)]
struct Board {
    id: i64,
    parent_id: Option<i64>,
    name: String,
    description: Option<String>,
    filters: String,
    file_count: i64,
}

/// 源库一次性读进来的全部数据。`entries` **已排除 Trash 子树与两个虚拟根**（⑫），
/// Trash 单独放 `trash` 里只为列名字。
pub struct SourceData {
    entries: HashMap<i64, Entry>,
    trash: Vec<Entry>,
    tag_names: HashMap<i64, String>,
    boards: Vec<Board>,
    board_members: HashMap<i64, Vec<(i64, i64)>>,
    tag_groups_rows: i64,
}

/// ⑦：`entries.tags` 是竖线分隔的 tag id 串（实测原值形如
/// `'646086142005847040|646086152915231744'`），不是 JSON 数组、也不是逗号串。
fn decode_tag_ids(raw: Option<&str>) -> Vec<i64> {
    let Some(raw) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
        return Vec::new();
    };
    raw.split('|')
        .filter_map(|part| part.trim().parse::<i64>().ok())
        .collect()
}

/// 读快照。`with_progress(done, total)` 给 §6.1 的 probe 阶段进度条用。
///
/// 内部函数按 `rusqlite::Result` 走，`?` 只管一种错误；边界上再统一收成 String，
/// 免得每一处都 `map_err`（本模块对外一律 `Res<T>`，与 `AppDbPool` 一致）。
pub fn read_source(
    snapshot: &Snapshot,
    with_progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
) -> Res<SourceData> {
    read_from(&snapshot.conn, with_progress).map_err(|e| e.to_string())
}

/// 从「已经打开好的源库连接」读全部数据。快照的复制/只读策略在 `Snapshot` 里，
/// 这一层只关心格式解码，所以单测可以直接喂一个内存库。
pub(crate) fn read_from(
    conn: &Connection,
    with_progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
) -> rusqlite::Result<SourceData> {
    let mut tag_names = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT id, name FROM tags")?;
        let rows = stmt.query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?)))?;
        for row in rows {
            let (id, name) = row?;
            tag_names.insert(id, name);
        }
    }

    let mut board_members: HashMap<i64, Vec<(i64, i64)>> = HashMap::new();
    {
        let mut stmt = conn.prepare("SELECT board_id, entry_id, entry_kind FROM board_entries")?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })?;
        for row in rows {
            let (board, entry, kind) = row?;
            board_members.entry(board).or_default().push((entry, kind));
        }
    }

    let mut boards = Vec::new();
    {
        let mut stmt = conn.prepare(
            "SELECT id, parent_id, name, description, filters, file_count FROM boards",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(Board {
                id: row.get(0)?,
                parent_id: row.get::<_, Option<i64>>(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                filters: row.get::<_, Option<String>>(4)?.unwrap_or_default(),
                file_count: row.get(5)?,
            })
        })?;
        for row in rows {
            boards.push(row?);
        }
    }

    // ①：路径靠 parent_id 链从虚拟根逐级拼 name，递归 CTE 一次拿到全部相对路径。
    // 起点写成 `parent_id = 1`（虚拟根的直接子节点），这行天然把 Trash 子树和两个
    // 虚拟根本身都挡在外面——⑫ 要求路径重建**显式排除 Trash 子树**，否则 Trash 条目
    // 会拼出一个根级相对路径，与真实根目录下的同名文件共用命名空间，可能假命中。
    const TREE_SQL: &str = "
        WITH RECURSIVE node(
            id, name, rel_path, kind, content_type, size, tags, description, link, source_path
        ) AS (
            SELECT id, name, name, kind, content_type, size, tags, description, link, source_path
              FROM entries WHERE parent_id = ?1
            UNION ALL
            SELECT e.id, e.name, node.rel_path || '/' || e.name, e.kind, e.content_type,
                   e.size, e.tags, e.description, e.link, e.source_path
              FROM entries e JOIN node ON e.parent_id = node.id
        )
        SELECT id, name, rel_path, kind, content_type, size, tags, description, link, source_path
          FROM node ORDER BY id";

    let total_entries: i64 = conn
        .query_row("SELECT COUNT(*) FROM entries", [], |row| row.get(0))
        .unwrap_or(0);

    let mut entries = HashMap::new();
    {
        let mut stmt = conn.prepare(TREE_SQL)?;
        let mut rows = stmt.query(params![VIRTUAL_ROOT_ID])?;
        let mut done = 0usize;
        while let Some(row) = rows.next()? {
            let id: i64 = row.get(0)?;
            entries.insert(
                id,
                Entry {
                    id,
                    name: row.get(1)?,
                    rel_path: row.get(2)?,
                    kind: row.get(3)?,
                    content_type: row.get(4)?,
                    size: row.get(5)?,
                    tag_ids: decode_tag_ids(row.get::<_, Option<String>>(6)?.as_deref()),
                    description: row.get(7)?,
                    link: row.get(8)?,
                    source_path: row.get(9)?,
                },
            );
            done += 1;
            if done % 512 == 0 {
                if let Some(cb) = with_progress {
                    cb(done, (total_entries as usize).max(done));
                }
            }
        }
    }

    // Trash 子树：判据是 `parent_id = 2` 的传递闭包，**不是 `is_deleted`**——⑫ 实测
    // 回收站里那条 mp4 的 `is_deleted` 仍为 0。
    let mut trash = Vec::new();
    {
        const TRASH_SQL: &str = "
            WITH RECURSIVE t(id) AS (
                SELECT id FROM entries WHERE id = ?1
                UNION ALL
                SELECT e.id FROM entries e JOIN t ON e.parent_id = t.id
            )
            SELECT e.id, e.name, e.kind, e.content_type, e.size, e.tags, e.description,
                   e.link, e.source_path
              FROM entries e JOIN t ON t.id = e.id WHERE e.id <> ?1";
        let mut stmt = conn.prepare(TRASH_SQL)?;
        let rows = stmt.query_map(params![TRASH_ROOT_ID], |row| {
            Ok(Entry {
                id: row.get(0)?,
                rel_path: row.get::<_, String>(1)?,
                name: row.get(1)?,
                kind: row.get(2)?,
                content_type: row.get(3)?,
                size: row.get(4)?,
                tag_ids: decode_tag_ids(row.get::<_, Option<String>>(5)?.as_deref()),
                description: row.get(6)?,
                link: row.get(7)?,
                source_path: row.get(8)?,
            })
        })?;
        for row in rows {
            trash.push(row?);
        }
    }

    let tag_groups_rows: i64 = conn
        .query_row("SELECT COUNT(*) FROM tag_groups", [], |row| row.get(0))
        .unwrap_or(0);

    if let Some(cb) = with_progress {
        cb(total_entries as usize, total_entries as usize);
    }

    Ok(SourceData {
        entries,
        trash,
        tag_names,
        boards,
        board_members,
        tag_groups_rows,
    })
}

// ---------------------------------------------------------------- 智能看板标定

/// §4.6 规则 8：**只实现标定过的筛选键**。当前标定表只有下面这一条。
///
/// 标定过程（⑭）：`'test'` 的 `file_count=1457`，对 5402 条非回收站文件复算
/// `count(size < 1048576) = 1457` 精确相等；能产出 1457 的阈值窗口是
/// (1048441, 1049387] 字节，窗口内 1 MiB 是唯一整数边界；像素维度完全对不上
/// （min 边 <1600 会给 5396），排除。
const EXTRA_SMALL_BYTES: i64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CalibratedFilter {
    /// `{"size":[{"should":"extra_small"}]}` → 文件字节 < 1 MiB
    ExtraSmall,
}

/// 解析 `boards.filters`。
/// * `Some(None)` —— 手动看板（`'{}'` 或空）
/// * `Some(Some(f))` —— 智能看板且筛选已标定
/// * `None` —— 智能看板，但含未标定的键/桶（small/medium/large/extra_large、tags、
///   rating、日期、`must`/`must_not` 组合等）→ 按规则 8 不复算、直接跳过并上报。
///   **不为迁移实现通用筛选器 DSL**——那是产品功能，另立项。
fn parse_filters(filters: &str) -> Option<Option<CalibratedFilter>> {
    let trimmed = filters.trim();
    if trimmed.is_empty() || trimmed == "{}" {
        return Some(None);
    }
    let obj = serde_json::from_str::<Value>(trimmed).ok()?.as_object().cloned()?;
    if obj.len() != 1 {
        return None;
    }
    let (key, sizes) = obj.into_iter().next()?;
    if key != "size" {
        return None;
    }
    let items = sizes.as_array()?;
    if items.len() != 1 {
        return None;
    }
    let item = items[0].as_object()?;
    if item.len() != 1 {
        return None;
    }
    let (clause, term) = item.into_iter().next()?;
    if clause != "should" {
        return None;
    }
    match term.as_str() {
        Some("extra_small") => Some(Some(CalibratedFilter::ExtraSmall)),
        _ => None,
    }
}

/// ①：把 PixCall 的相对路径拼成绝对路径（`.pixcall` 所在目录 + 相对路径）。
fn absolute_path(pixcall_root: &str, rel: &str) -> String {
    normalize_path(&format!("{}/{}", pixcall_root, rel))
}

// ---------------------------------------------------------------- 计划

/// §4.8 分类顺序：① 排除 Trash 子树 → ② `is_indexable` 为 false 者计
/// `skipped_unsupported_type` → ③ 合集按 ⑪/§4.6 分态 → ④ 剩余做路径匹配 →
/// ⑤ 命中的按「并集 / 仅为空时填 / 同名跳过」合并并计数。
///
/// **顺序错了会把同一条目重复计入两栏**（回收站里的 mp4 既算视频又算未命中），
/// 且 ② 与 ④ 的区分必须靠 `content_type` 而不是「在不在 file_index 里」：视频不在
/// 索引里是**支持性问题**，被删的图不在索引里是**缺失问题**，两者不能混在一栏。
pub fn build_plan(
    source: &SourceData,
    pixcall_root: &str,
    our: &OurIndex,
    our_conn: &Connection,
    schema_version: &str,
) -> Res<MigrationPlan> {
    let mut report = MigrationReport::default();
    let mut edits: Vec<AnnotationEdit> = Vec::new();
    let mut unmatched = UnmatchedSet::default();

    if source.tag_groups_rows > 0 {
        // §4 映射表：`tag_groups` 本机仍 0 行，遇到时按「丢弃 + 上报」处理。
        report.warnings.push(format!(
            "源库 tag_groups 有 {} 行（用户自定义标签分组），本期丢弃不迁",
            source.tag_groups_rows
        ));
    }

    // ① Trash 子树（⑫）：不迁、不复制，只在报告列名字（v4.5 拍板 A）
    report.excluded_trash = source.trash.len() as u32;
    for item in &source.trash {
        report.excluded_trash_names.push(TrashItem {
            name: item.name.clone(),
            origin_folder: item
                .source_path
                .clone()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty()),
        });
    }

    // ⑤ 的「仅为空时填」要看我们侧现值；词表用于 `tags_words_added` 的净增口径
    let vocab = existing_vocabulary(our_conn).map_err(|e| e.to_string())?;
    let mut metadata_cache: HashMap<String, Option<file_metadata::FileMetadata>> = HashMap::new();
    let mut new_words: HashSet<String> = HashSet::new();

    // 按 id 排序遍历，保证报告可复现
    let mut ids: Vec<i64> = source.entries.keys().copied().collect();
    ids.sort_unstable();

    for id in ids {
        let Some(entry) = source.entries.get(&id) else {
            continue;
        };
        // ②：文件夹是容器，不受「我们支不支持这类文件」的门禁——⑩ 实测文件夹备注有展示位
        if entry.kind != 0 && !is_indexable(&entry.content_type) {
            report.skipped_unsupported_type += 1;
            // §4.9 第 2 条：视频标注是「已解码、暂不落地」，不是丢弃。搁置的代价
            // （本机 1 条）必须在报告里可见。
            if entry.annotated() {
                report.annotated_unsupported += 1;
            }
            continue;
        }
        if !entry.annotated() {
            continue;
        }

        // ④：join 永远只按 path（§4.9 第 3 条），不许加 file_type 条件
        let path = absolute_path(pixcall_root, &entry.rel_path);
        let Some(row) = our.find(&path) else {
            // 不命中就如实上报，不按名字/尺寸/mtime 模糊猜测（§6.3：猜错会把标签
            // 贴到别人的图上）
            unmatched.push(path);
            continue;
        };
        report.matched += 1;

        let existing: Option<file_metadata::FileMetadata> =
            match metadata_cache.get(&row.file_id) {
                Some(hit) => hit.clone(),
                None => {
                    let hit = file_metadata::get_metadata_by_id(our_conn, &row.file_id)
                        .map_err(|e| e.to_string())?;
                    metadata_cache.insert(row.file_id.clone(), hit.clone());
                    hit
                }
            };

        let mut edit = AnnotationEdit {
            file_id: row.file_id.clone(),
            path: row.path.clone(),
            tags: None,
            description: None,
            source_urls: None,
        };

        // —— 标签（⑦ 解码 → normalize → 与我们已有的并集，保留我们已有顺序）——
        if !entry.tag_ids.is_empty() {
            if entry.kind == 0 {
                // §4.4：文件夹**标签**被 `EditSection.tsx:41` 的 FOLDER 门禁挡着，
                // 写进去在 UI 上看不见。本机 PixCall 的标签 8 条全挂在文件上，此路 0 条。
                report.warnings.push(format!(
                    "跳过挂在文件夹「{}」上的 {} 个标签：我们侧不展示文件夹标签",
                    entry.rel_path,
                    entry.tag_ids.len()
                ));
            } else {
                let incoming: Vec<String> = entry
                    .tag_ids
                    .iter()
                    .filter_map(|tag_id| source.tag_names.get(tag_id).cloned())
                    .collect();
                let missing = entry.tag_ids.len() - incoming.len();
                if missing > 0 {
                    report.warnings.push(format!(
                        "{}：{} 个标签 id 在源库 tags 表里查不到名字，已丢弃",
                        entry.rel_path, missing
                    ));
                }
                let current: Vec<String> = existing
                    .as_ref()
                    .and_then(|m| m.tags.clone())
                    .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                    .unwrap_or_default();
                let merged = merge_tag_lists(&current, &incoming);
                let added: Vec<String> = merged
                    .iter()
                    .filter(|word| !current.iter().any(|c| c == *word))
                    .cloned()
                    .collect();
                if !added.is_empty() {
                    edit.tags = Some(merged);
                    report.tags_unioned += 1;
                    // 净增只对「我们词表里本来没有」的词计一遍：`明日方舟：终末地`
                    // 两边都有，正好验词表并集不产生重复词（§3）
                    for word in &added {
                        if !vocab.contains(word.as_str()) && new_words.insert(word.clone()) {
                            report.tags_words_added += 1;
                        }
                    }
                }
            }
        }

        // —— 描述（⑨：写入前必须 trim；⑩：文件与文件夹同一条路径）——
        if !blank(entry.description.as_deref()) {
            let (value, yielded) = fill_if_empty(
                existing.as_ref().and_then(|m| m.description.as_deref()),
                entry.description.as_deref(),
            );
            if let Some(v) = value {
                edit.description = Some(v);
                report.descriptions_written += 1;
            } else if yielded {
                // §4.7：没有这一栏，「Pixcall 有 5 条夹子备注、实际写进 4 条」
                // 就会看起来像丢数据（本机现成的 NTE 夹用例）
                report.descriptions_skipped_existing += 1;
            }
        }

        // —— 来源链接（P1(b)：一张图可以有多个来源网址。我们已有的**一个不动**，
        // 源侧那条若不在我们的列表里就追加到后面；已经有了就不重复添加。
        // **不做 URL 合法性校验**——本机有一条误存的 x.com/home，原样搬）——
        if !blank(entry.link.as_deref()) {
            let current = existing.as_ref().map(|m| m.source_urls()).unwrap_or_default();
            let link = entry.link.as_deref().unwrap_or_default().trim().to_string();
            if current.iter().any(|u| u == &link) {
                report.source_urls_skipped_existing += 1;
            } else {
                let mut merged = current;
                merged.push(link);
                edit.source_urls = Some(merged);
                report.source_urls_written += 1;
            }
        }

        if edit.tags.is_some() || edit.description.is_some() || edit.source_urls.is_some() {
            edits.push(edit);
        }
    }

    // ③ 合集（含层级与智能固化）
    let topics = plan_topics(source, pixcall_root, our, our_conn, &mut report, &mut unmatched)?;

    let (unmatched_count, unmatched_paths) = unmatched.into_parts();
    report.unmatched = unmatched_count as u32;
    report.unmatched_paths = unmatched_paths;

    Ok(MigrationPlan {
        report,
        edits,
        topics,
        source_schema_version: schema_version.to_string(),
    })
}

/// §4.6：按树迁移 boards。返回要新建的专题；查重/让位/降级/固化都记在报告里。
fn plan_topics(
    source: &SourceData,
    pixcall_root: &str,
    our: &OurIndex,
    our_conn: &Connection,
    report: &mut MigrationReport,
    unmatched: &mut UnmatchedSet,
) -> Res<Vec<TopicCreate>> {
    // 规则 1：**先序遍历** boards 树，父节点先落库拿到我们的 topic id，子节点再用它做 parent。
    let mut children: HashMap<i64, Vec<&Board>> = HashMap::new();
    let ids: HashSet<i64> = source.boards.iter().map(|b| b.id).collect();
    let mut roots: Vec<&Board> = Vec::new();
    for board in &source.boards {
        match board.parent_id {
            None | Some(VIRTUAL_ROOT_ID) => roots.push(board),
            Some(p) if ids.contains(&p) => children.entry(p).or_default().push(board),
            // 父不在本批（源库残缺）：按根处理并上报
            Some(p) => {
                report.warnings.push(format!(
                    "看板「{}」的父级 {} 不在 boards 里，按根处理",
                    board.name, p
                ));
                roots.push(board);
            }
        }
    }
    let mut ordered: Vec<&Board> = Vec::with_capacity(source.boards.len());
    {
        let mut stack: Vec<&Board> = roots.clone();
        stack.sort_by_key(|b| b.id);
        stack.reverse();
        let mut visited: HashSet<i64> = HashSet::new();
        while let Some(board) = stack.pop() {
            if !visited.insert(board.id) {
                continue;
            }
            ordered.push(board);
            if let Some(kids) = children.get(&board.id) {
                let mut kids = kids.clone();
                kids.sort_by_key(|b| b.id);
                kids.reverse();
                stack.extend(kids);
            }
        }
        // 环上的看板进不了先序序列：补在最后处理（父级解析时自会降级并上报）
        for board in &source.boards {
            if !visited.contains(&board.id) {
                report
                    .warnings
                    .push(format!("看板「{}」的父级链存在环，按末位处理", board.name));
                ordered.push(board);
            }
        }
    }

    // board id → 我们侧 topic id（None = 该节点没落库，子节点走降级）
    let mut mapped: HashMap<i64, Option<String>> = HashMap::new();
    let mut created: Vec<TopicCreate> = Vec::new();
    let mut folder_members: u32 = 0;

    for board in ordered {
        // ⑪：手动 = `filters` 为 `'{}'` 且 `board_entries` 有行；智能 = `filters` 非空、
        // 成员不落表。**两个信号同时校验，任一不符就按智能处理并上报。**
        let manual_signals = (
            parse_filters(&board.filters).map(|f| f.is_none()).unwrap_or(false),
            source
                .board_members
                .get(&board.id)
                .map(|m: &Vec<(i64, i64)>| !m.is_empty())
                .unwrap_or(false),
        );
        let is_manual = manual_signals.0 && manual_signals.1;
        if manual_signals.0 && !manual_signals.1 {
            report.warnings.push(format!(
                "看板「{}」filters 为 {{}} 但 board_entries 无行，两信号不符，按智能处理（⑪）",
                board.name
            ));
        }

        let (parent_topic_id, reparented) = resolve_parent(board, source, &mapped);
        if reparented {
            report.topics_reparented += 1;
            let reason = board
                .parent_id
                .and_then(|p| source.boards.iter().find(|b| b.id == p))
                .map(|b| b.name.clone())
                .unwrap_or_else(|| "上级".to_string());
            report.warnings.push(format!(
                "看板「{}」的父级「{}」未落库，已降级挂到最近的已迁祖先（§4.6 规则 2）",
                board.name, reason
            ));
        }

        // —— 成员集合 ——
        let mut materialized_now = false;
        let member_file_ids: Vec<String> = if is_manual {
            let members = source
                .board_members
                .get(&board.id)
                .cloned()
                .unwrap_or_default();
            manual_members(
                &members,
                source,
                pixcall_root,
                our,
                report,
                unmatched,
                &mut folder_members,
            )
        } else {
            match parse_filters(&board.filters) {
                Some(Some(CalibratedFilter::ExtraSmall)) => {
                    // 规则 6/7：复算成员，**计数断言是硬门禁**——复算数必须精确等于
                    // `boards.file_count` 才允许落表。这条断言把「猜筛选语义」变成
                    // 「可验证复算或放弃」：猜错桶边界必然过不了断言。
                    let recomputed: Vec<&Entry> = source
                        .entries
                        .values()
                        .filter(|e| e.kind != 0 && e.size < EXTRA_SMALL_BYTES)
                        .collect();
                    if recomputed.len() as i64 != board.file_count {
                        report.topics_skipped_unverifiable += 1;
                        report.warnings.push(format!(
                            "智能看板「{}」复算得 {} 条 ≠ file_count {}，计数断言不过，跳过（§4.6 规则 7；file_count 是缓存值，源库增长时本断言会保守失败）",
                            board.name,
                            recomputed.len(),
                            board.file_count
                        ));
                        mapped.insert(board.id, None);
                        continue;
                    }
                    // 固化成功只在**真的建出专题**时才计数（同名让位的那条不算），
                    // 所以这里只置标记，累加放到查重之后。
                    materialized_now = true;
                    let mut ids = Vec::with_capacity(recomputed.len());
                    let mut by_path: Vec<&Entry> = recomputed;
                    by_path.sort_by(|a, b| a.rel_path.cmp(&b.rel_path));
                    for entry in by_path {
                        if !is_indexable(&entry.content_type) {
                            report.topic_members_skipped_type += 1;
                            continue;
                        }
                        match our.find(&absolute_path(pixcall_root, &entry.rel_path)) {
                            Some(row) => ids.push(row.file_id.clone()),
                            None => unmatched.push(absolute_path(pixcall_root, &entry.rel_path)),
                        }
                    }
                    ids
                }
                // 两个信号不符走到这里（`filters` 是 `'{}'` 但成员表为空）：没有可复算
                // 的筛选，按智能处理后同样只能跳过并上报。
                Some(None) => {
                    report.topics_skipped_unverifiable += 1;
                    report.warnings.push(format!(
                        "看板「{}」的 filters 为 {{}} 却没有 board_entries 行，无可复算的筛选，跳过（⑪ 两信号不符）",
                        board.name
                    ));
                    mapped.insert(board.id, None);
                    continue;
                }
                // 规则 8：含未标定的键/桶 → 不复算、直接跳过并上报
                _ => {
                    report.topics_skipped_unverifiable += 1;
                    report.warnings.push(format!(
                        "智能看板「{}」的筛选含未标定键（filters={}），跳过不迁（§4.6 规则 8）",
                        board.name, board.filters
                    ));
                    mapped.insert(board.id, None);
                    continue;
                }
            }
        };

        // 规则 3：查重键是 `(映射后的我们父级, name)`，不是裸名字
        let existing_id =
            find_topic_by_name(our_conn, parent_topic_id.as_deref(), &board.name).map_err(|e| e.to_string())?;
        if let Some(existing_id) = existing_id {
            // 规则 4（v4.9 改）：同名命中已有专题时**不新建，但把成员并进去**。
            // 名字/父级一律不改；封面与描述「空着才补」（见 `merge_into_existing_topic`）。
            // 该节点仍写进映射表，所以它的子看板可以继续挂在同一个专题下。
            let already: std::collections::HashSet<String> = {
                let mut stmt = our_conn
                    .prepare("SELECT file_id FROM topic_files WHERE topic_id = ?1")
                    .map_err(|e| e.to_string())?;
                let rows = stmt
                    .query_map(params![&existing_id], |row| row.get::<_, String>(0))
                    .map_err(|e| e.to_string())?;
                rows.filter_map(|r| r.ok()).collect()
            };
            let new_members: Vec<String> = member_file_ids
                .into_iter()
                .filter(|file_id| !already.contains(file_id))
                .collect();
            report.topic_files_added += new_members.len() as u32;
            report.topics_merged_name += 1;

            let cover_empty: bool = our_conn
                .query_row(
                    "SELECT COALESCE(cover_file_id, '') = '' FROM topics WHERE id = ?1",
                    params![&existing_id],
                    |row| row.get(0),
                )
                .unwrap_or(false);
            if cover_empty && !(already.is_empty() && new_members.is_empty()) {
                report.topics_covered += 1;
                report.warnings.push(format!(
                    "同名专题「{}」原来没有封面，导入时补了第一张成员（已有的封面不会覆盖）",
                    board.name
                ));
            }
            report.warnings.push(format!(
                "看板「{}」在我们侧同父级下已有同名专题，成员已并入它（未新建同名专题）",
                board.name
            ));
            created.push(TopicCreate {
                description: board
                    .description
                    .as_deref()
                    .map(str::trim)
                    .filter(|d| !d.is_empty())
                    .map(str::to_string),
                file_ids: new_members,
                materialized: !is_manual,
                merge_into_existing: true,
                id: existing_id.clone(),
                name: board.name.clone(),
                parent_id: parent_topic_id,
            });
            mapped.insert(board.id, Some(existing_id));
            continue;
        }

        let id = new_topic_id(our_conn, &format!("pixcall-board|{}", board.id));
        if materialized_now {
            report.topics_materialized += 1;
            report.warnings.push(format!(
                "看板「{}」按已标定筛选固化为快照专题：新落入条件的文件不会自动加入（我们侧无智能专题机制，§4.6 规则 6）",
                board.name
            ));
        }
        report.topic_files_added += member_file_ids.len() as u32;
        created.push(TopicCreate {
            id: id.clone(),
            name: board.name.clone(),
            // 规则 5：`boards.description` 非空时写入 `topics.description`
            description: board
                .description
                .as_deref()
                .map(str::trim)
                .filter(|d| !d.is_empty())
                .map(str::to_string),
            parent_id: parent_topic_id,
            file_ids: member_file_ids,
            materialized: !is_manual,
            merge_into_existing: false,
        });
        report.topics_created += 1;
        mapped.insert(board.id, Some(id));
    }

    if folder_members > 0 {
        report.warnings.push(format!(
            "合集成员里有 {} 条 entry_kind=0（文件夹），我们 topic_files 的文件夹语义未定义，已跳过该成员（§4 表 entry_kind 行）",
            folder_members
        ));
    }
    Ok(created)
}

/// 规则 1/2：`parent_id = 1`（或 NULL）挂到我们 topics 的根（我们侧根专题 parent_id 为
/// NULL）；其余挂到「其父 board 映射出的 topic」。父级被跳过时沿链找最近的已迁祖先，
/// 一个都没有就挂根——子看板是用户手工维护的成员集合，父级只是个查询条件，不该连坐。
fn resolve_parent(
    board: &Board,
    source: &SourceData,
    mapped: &HashMap<i64, Option<String>>,
) -> (Option<String>, bool) {
    let mut current = board.parent_id;
    let mut reparented = false;
    let mut hops = 0;
    while let Some(parent_id) = current.filter(|p| *p != VIRTUAL_ROOT_ID) {
        hops += 1;
        if hops > 64 {
            return (None, reparented);
        }
        match mapped.get(&parent_id) {
            Some(Some(topic_id)) => return (Some(topic_id.clone()), reparented),
            Some(None) => {
                reparented = true;
                current = source
                    .boards
                    .iter()
                    .find(|b| b.id == parent_id)
                    .and_then(|b| b.parent_id);
            }
            None => {
                // 父级还没处理到（环或数据异常）：挂根并上报
                return (None, true);
            }
        }
    }
    (None, reparented)
}

/// 手动看板的成员：`board_entries` 逐条 join 到我们的 `file_index`。
fn manual_members(
    members: &[(i64, i64)],
    source: &SourceData,
    pixcall_root: &str,
    our: &OurIndex,
    report: &mut MigrationReport,
    unmatched: &mut UnmatchedSet,
    folder_members: &mut u32,
) -> Vec<String> {
    let mut out: Vec<(String, i64, String)> = Vec::with_capacity(members.len());
    for (entry_id, entry_kind) in members {
        if *entry_kind == 0 {
            // §4 表 `board_entries.entry_kind` 行：本机 4 条全为 1（文件）。
            *folder_members += 1;
            continue;
        }
        let Some(entry) = source.entries.get(entry_id) else {
            unmatched.push(format!("(源库里查不到的 entry {})", entry_id));
            continue;
        };
        if !is_indexable(&entry.content_type) {
            // §4.9 第 3 条：成员也走同一个 is_indexable；视频支持后重导入会追加成员
            report.topic_members_skipped_type += 1;
            continue;
        }
        let path = absolute_path(pixcall_root, &entry.rel_path);
        match our.find(&path) {
            Some(row) => out.push((entry.rel_path.clone(), *entry_id, row.file_id.clone())),
            None => unmatched.push(path),
        }
    }
    // 成员顺序按重建路径排序：重跑稳定，且不依赖 PixCall 的 64 位 id 大小
    out.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.cmp(&b.1)));
    out.into_iter().map(|(_, _, file_id)| file_id).collect()
}

#[cfg(test)]
mod tests;
