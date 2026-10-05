//! Eagle 库适配器（第二期；规格书 `docs/Eagle数据迁移-格式调研.md`，与 v1 冲突处以 §13 实测为准）。
//!
//! 职责与 `pixcall.rs` 同形：库发现（调研 §1）、解码（§2/§3.1）、分类顺序（§4.8 变体）、
//! `name+ext` 匹配（§13.3 实测标定）、手动夹/智能夹规则（P2b 拍板）。**合并策略不在这里**——
//! 全部走 `super` 的共享函数（`merge_tag_lists` / `fill_if_empty` / `apply_plan` /
//! `find_topic_by_name` / `new_topic_id` / `record_import`），不许另写平行的实现。
//!
//! 与 PixCall 的两条结构性不同（mod.rs 头两条 per-source 禁令的出处）：
//! 1. **Eagle 的库不是 SQLite**，是 `.library/` 目录里的一堆 JSON + 实体文件，所以这里没有
//!    「复制 db+wal」的快照——「快照」就是 `read_source` 一次性解码出的内存结构
//!    （`SourceData`），probe 与 import 共用同一份（§6.2 末条约束的 Eagle 等价物）。
//! 2. **Eagle 导入即把文件复制进库、不留原始路径**（官方口径），所以这里没有路径 join；
//!    join 键是 `name+ext`（M6 实测：`file_index.name` 含扩展名 → 键 = `显示名.扩展名` 小写），
//!    命中后再用 size + width/height 复核（§13.3：实测样例两侧全相等，零误报）。

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::{
    existing_vocabulary, fill_if_empty, find_topic_by_import_seed, find_topic_by_name, is_indexable,
    merge_tag_lists, new_topic_id, AnnotationEdit, MigrationPlan, MigrationReport, OurIndex,
    TopicCreate, TrashItem,
};
use crate::db::file_index::FileIndexEntry;
use crate::db::file_metadata;
use crate::db::{generate_id, normalize_path};
use crate::file_types;

pub const SOURCE_NAME: &str = "eagle";

/// 本模块内部统一用 String 错误（与 `AppDbPool` 一致，Tauri 命令返回值可直接序列化）。
type Res<T> = Result<T, String>;

fn blank(value: Option<&str>) -> bool {
    value.map(|v| v.trim().is_empty()).unwrap_or(true)
}

/// 未命中明细的收集器（与 pixcall 的 `UnmatchedSet` 同形）：计数不受限，明细只留前 50 条
/// （报告要走 serde→JSON→webview）。Eagle 装的是「显示名.ext」而不是路径（H2 拍板）。
#[derive(Default)]
struct UnmatchedItems {
    seen: HashSet<String>,
    items: Vec<String>,
}

impl UnmatchedItems {
    fn push(&mut self, item: String) {
        if self.seen.insert(item.clone()) && self.items.len() < 50 {
            self.items.push(item);
        }
    }
    fn into_parts(self) -> (usize, Vec<String>) {
        let mut items = self.items;
        items.sort();
        (self.seen.len(), items)
    }
}

// ---------------------------------------------------------------- 库发现（调研 §1）

/// 一个 Eagle 库。`root` 就是 `<Name>.library` 目录本身（与 PixCall 的「`.pixcall`
/// 所在目录才是根」不同——Eagle 的库目录自带 metadata.json 与 images/）。
#[derive(Debug, Clone)]
pub struct DiscoveredLibrary {
    pub root: String,
    /// `%APPDATA%\Eagle\Settings` 的 `rootDir` 指向的那一个（§13.4 实测）
    pub is_current: bool,
}

/// 有效性判据（两个独立实现一致，调研 §1）：`metadata.json` 是文件 **且** `images/` 是目录。
pub fn is_valid_library(path: &str) -> bool {
    let p = Path::new(path);
    p.join("metadata.json").is_file() && p.join("images").is_dir()
}

/// §1 发现顺序：① 我们根自身 / 一级子目录 / **父目录** 下的 `*.library`（Eagle-viewer
/// 的兜底做法：验收人把库建在资源根旁边时靠这一步找到）；② `%APPDATA%\Eagle\Settings`
/// 的 `libraryHistory`（**过滤已不存在的项**——PixCall 那条「注册了没建库」的教训）
/// 与 `rootDir`。多于一个时由 UI 给选择列表。
pub fn discover(our_root: Option<&str>) -> Vec<DiscoveredLibrary> {
    let settings = read_settings();
    let current = settings
        .as_ref()
        .and_then(|(_, cur)| cur.as_deref())
        .map(normalize_path);

    let mut out: Vec<DiscoveredLibrary> = Vec::new();
    let mut seen = HashSet::new();

    if let Some(root) = our_root {
        let normalized = normalize_path(root);
        // ① 我们根自身就是库（用户直接指到 `<Name>.library` 上）
        push_library(&mut out, &mut seen, &normalized, &current);
        // ② 给定根下与父目录里的 *.library
        scan_for_libraries(Path::new(&normalized), &mut out, &mut seen, &current);
        if let Some(parent) = Path::new(&normalized).parent() {
            scan_for_libraries(parent, &mut out, &mut seen, &current);
        }
    }
    // ③ Settings 注册的各条
    if let Some((history, _)) = settings {
        for root in history {
            push_library(&mut out, &mut seen, &normalize_path(&root), &current);
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
    if root.is_empty() || !is_valid_library(root) {
        // 注册了但库没了 / 根本没装过 —— 一律过滤（§1 本机现状给出的硬要求）
        return;
    }
    if !seen.insert(root.to_string()) {
        return;
    }
    out.push(DiscoveredLibrary {
        root: root.to_string(),
        is_current: current.as_deref() == Some(root),
    });
}

/// 扫一个目录下的一级子目录，找名字以 `.library` 结尾且过有效性判据的。
fn scan_for_libraries(
    dir: &Path,
    out: &mut Vec<DiscoveredLibrary>,
    seen: &mut HashSet<String>,
    current: &Option<String>,
) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut names: Vec<String> = entries
        .flatten()
        .filter(|e| e.path().is_dir())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .filter(|n| n.ends_with(".library"))
        .collect();
    names.sort();
    for name in names {
        let path = dir.join(name).to_string_lossy().to_string();
        push_library(out, seen, &normalize_path(&path), current);
    }
}

/// `%APPDATA%\Eagle\Settings`（**无扩展名**的 JSON）：`libraryHistory: string[]` +
/// `rootDir`（当前库，§13.4 实测）。Eagle 没运行/没装过 → None，发现退回扫盘。
fn read_settings() -> Option<(Vec<String>, Option<String>)> {
    let appdata = std::env::var("APPDATA").ok()?;
    let file = Path::new(&appdata).join("Eagle").join("Settings");
    let text = std::fs::read_to_string(file).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    let history = value
        .get("libraryHistory")
        .and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let current = value
        .get("rootDir")
        .and_then(Value::as_str)
        .map(str::to_string);
    Some((history, current))
}

// ---------------------------------------------------------------- 解码（调研 §2/§3.1/§8.4）

/// 库头与条目的 `metadata.json` **同名**，只能按内容分类、不按文件路径猜（§8.4）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum JsonKind {
    /// 有字符串 `id` → 条目级
    Item,
    /// 无字符串 id、但有 `folders`/`smartFolders` 键 → 库头
    Header,
    Other,
}

fn classify_json(v: &Value) -> JsonKind {
    if v.get("id").map(Value::is_string).unwrap_or(false) {
        return JsonKind::Item;
    }
    if v.get("folders").is_some() || v.get("smartFolders").is_some() {
        return JsonKind::Header;
    }
    JsonKind::Other
}

/// 条目级解码结果（§3.1：除按目录名取到的 id 外**全部 Optional 化**——缺键容忍）。
#[derive(Debug, Clone)]
pub struct Item {
    /// 条目 id：**以目录名为准**（§2；实测 49/49 目录名 == JSON id，不一致时听目录的）
    pub id: String,
    /// 显示名（不含扩展名；缺键按空串，匹配时自然落 unmatched）
    pub name: String,
    pub ext: String,
    pub size: Option<i64>,
    pub width: Option<i64>,
    pub height: Option<i64>,
    /// 标签名本身（D4：没有 tag id、没有词表）
    pub tags: Vec<String>,
    /// 夹 id 数组。**空数组是 Eagle 主流形态**（实测 49/49），不是错误：条目照常挂标注、
    /// 只是不进任何专题。
    pub folders: Vec<String>,
    pub annotation: Option<String>,
    pub url: Option<String>,
    /// 软删除（Eagle 的回收站是原地的 `isDeleted`，文件不动）
    pub is_deleted: bool,
    /// 三级回退后有没有实体文件。全落空 = 无实体条目（Bookmark 类，§8.3）→ 不参与匹配。
    pub has_entity: bool,
    /// C 档搬运用：三级回退**定位到的那个文件本身**（`<ID>.info/` 内的绝对路径）。
    /// `has_entity` 的 superset——有它就一定有 `has_entity == true`；A 档不动文件，可以只看后者。
    pub entity_path: Option<String>,
    /// 图上矩形标注条数（Eagle 4.0 build22+；P4 拍板丢弃 + 上报）
    pub comments: usize,
    // star（P5 不迁）/ palettes / order / noThumbnail / btime / mtime 等一律忽略：
    // btime 实测是源文件的文件系统创建时间而非「加入库的时间」（§13.2 更正），本来也不迁。
}

impl Item {
    /// 挂着标注的条目（§4.9 第 2 条：搁置的代价要在报告里可见）。
    fn annotated(&self) -> bool {
        !self.tags.is_empty()
            || !blank(self.annotation.as_deref())
            || !blank(self.url.as_deref())
    }
}

/// 报告明细里的条目呈现：「显示名.ext」（ext 为空时只剩显示名，Bookmark 常态）。
fn display_name(item: &Item) -> String {
    if item.ext.is_empty() {
        item.name.clone()
    } else {
        format!("{}.{}", item.name, item.ext)
    }
}

/// 手动夹树的先序节点（父先于子，顺序 = JSON 数组序，用户在 Eagle 里排的）。
#[derive(Debug, Clone)]
pub struct FolderNode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    /// 源侧父夹 id（根节点 None；Eagle 的子夹是完整对象嵌在 `children` 里、没有 parent 字段）
    pub parent_id: Option<String>,
}

/// 智能夹树的先序节点。**子智能夹按自己的独立 conditions 求值**（P2b：不实现父条件
/// 继承——样本不可分辨，按严的来）。
#[derive(Debug, Clone)]
pub struct SmartFolderNode {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub parent_id: Option<String>,
    pub conditions: Vec<ConditionGroup>,
    /// 磁盘 `imageCount`。**只在子节点上有**（§13.2 实测）。
    /// 没有它就无法做计数断言：早先整夹跳过，2026-10-06 改成「条件全标定则按条件自算成员落库、
    /// 但不算固化成快照专题」（实测库 TESTV2 = 无 imageCount 却有 12 个成员的父夹）。
    pub image_count: Option<i64>,
}

/// `conditions: [{ match: "AND"|"OR", boolean?: "TRUE"|"FALSE", rules: [...] }]`，组间 AND。
#[derive(Debug, Clone)]
pub struct ConditionGroup {
    /// `match` 键缺失时按 AND（严的一侧）
    pub match_all: bool,
    /// `boolean` 键不存在或 == "TRUE"；实测样本恒为 "TRUE"
    pub boolean_calibrated: bool,
    pub rules: Vec<SmartRule>,
}

#[derive(Debug, Clone)]
pub struct SmartRule {
    pub property: String,
    pub method: String,
    /// 原始 JSON 值：标定过的两对都取字符串；非字符串值按未标定处理
    pub value: Value,
}

/// 源库一次性读进来的全部数据——Eagle 的「快照」（纯内存 JSON 解码结果）。
/// probe 与 import 共用同一份，对齐 PixCall §6.2 末条的约束。
#[derive(Debug, Default)]
pub struct SourceData {
    pub root: String,
    /// 库头 `applicationVersion`（如 "4.0.0"）→ `import_records.source_schema_version`
    pub application_version: String,
    /// 条目，按目录 id 排序（报告可复现）
    pub items: Vec<Item>,
    /// 手动夹树（先序；密码夹子树整体不出现）
    pub folders: Vec<FolderNode>,
    /// 智能夹树（先序）
    pub smart_folders: Vec<SmartFolderNode>,
    /// 密码夹名字（warnings 上报，不解密、不列内容，D7）
    pub password_folders: Vec<String>,
    /// 标签组数（P3：丢弃 + 上报，PixCall 的 `tag_groups` 先例）
    pub tags_groups: usize,
    /// 解码期异常（条目 metadata.json 缺失/损坏等）：缺键容忍之外的硬损伤，跳过该条目并上报
    pub warnings: Vec<String>,
}

/// 读源库。`with_progress(done, total)` 给 probe 阶段的进度条用。
///
/// **全程纯只读**：Eagle 开着时直读也安全（§13.1-8 实测无锁、并发读无碍）。
/// `mtime.json` 只当增量提示、**绝不作为条目集合来源**（它的 `"all"` 是计数不是 id，
/// 且可能落后于真实状态）——干脆不读它，条目集合以 `readdir(images/)` 为准。
pub fn read_source(
    library: &DiscoveredLibrary,
    with_progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
) -> Res<SourceData> {
    let root = normalize_path(&library.root);
    if !is_valid_library(&root) {
        return Err(format!(
            "{} 不是有效的 Eagle 库（缺 metadata.json 或 images/）",
            root
        ));
    }

    // —— 库头（§3.2）——
    let header_path = Path::new(&root).join("metadata.json");
    let text = std::fs::read_to_string(&header_path)
        .map_err(|e| format!("读库头 metadata.json 失败：{}", e))?;
    let header: Value =
        serde_json::from_str(&text).map_err(|e| format!("库头 metadata.json 解析失败：{}", e))?;
    // §8.4：库头与条目 metadata.json 同名，按内容分类。这里分类出「条目」说明用户指到的
    // 不是库根（比如指到了某个 .info 里面），报错而不是猜。
    if classify_json(&header) != JsonKind::Header {
        return Err(format!(
            "{} 的 metadata.json 不是库头（没有 folders/smartFolders，倒是带条目 id？）",
            root
        ));
    }
    let application_version = header
        .get("applicationVersion")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let tags_groups = header
        .get("tagsGroups")
        .and_then(Value::as_array)
        .map(|a| a.len())
        .unwrap_or(0);

    let mut folders = Vec::new();
    let mut password_folders = Vec::new();
    if let Some(arr) = header.get("folders").and_then(Value::as_array) {
        walk_folders(arr, None, &mut folders, &mut password_folders);
    }
    let mut smart_folders = Vec::new();
    if let Some(arr) = header.get("smartFolders").and_then(Value::as_array) {
        walk_smart_folders(arr, None, &mut smart_folders);
    }

    // —— 条目（§3.1）——
    let images_dir = Path::new(&root).join("images");
    let mut item_dirs: Vec<(String, PathBuf)> = Vec::new();
    for entry in std::fs::read_dir(&images_dir)
        .map_err(|e| format!("读 images/ 失败：{}", e))?
        .flatten()
    {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().to_string();
        if let Some(id) = dir_name.strip_suffix(".info") {
            item_dirs.push((id.to_string(), path));
        }
    }
    item_dirs.sort_by(|a, b| a.0.cmp(&b.0));

    let total = item_dirs.len();
    let mut items = Vec::with_capacity(item_dirs.len());
    let mut warnings = Vec::new();
    for (done, (id, dir)) in item_dirs.iter().enumerate() {
        let decoded = std::fs::read_to_string(dir.join("metadata.json"))
            .ok()
            .and_then(|t| serde_json::from_str::<Value>(&t).ok())
            .filter(|v| classify_json(v) == JsonKind::Item);
        match decoded {
            Some(v) => items.push(decode_item(id, dir, &v)),
            None => warnings.push(format!(
                "条目 {}.info 的 metadata.json 缺失、损坏或不是条目级 JSON，已跳过该条目",
                id
            )),
        }
        if let Some(cb) = with_progress {
            cb(done + 1, total);
        }
    }

    Ok(SourceData {
        root,
        application_version,
        items,
        folders,
        smart_folders,
        password_folders,
        tags_groups,
        warnings,
    })
}

fn decode_item(id: &str, dir: &Path, v: &Value) -> Item {
    let name = v
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let ext = v
        .get("ext")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let entity = resolve_entity_file(dir, &name, &ext);
    Item {
        id: id.to_string(),
        has_entity: entity.is_some(),
        entity_path: entity.map(|p| p.to_string_lossy().to_string()),
        name,
        ext,
        size: v.get("size").and_then(Value::as_i64),
        width: v.get("width").and_then(Value::as_i64),
        height: v.get("height").and_then(Value::as_i64),
        tags: string_list(v.get("tags")),
        folders: string_list(v.get("folders")),
        annotation: v.get("annotation").and_then(Value::as_str).map(str::to_string),
        url: v.get("url").and_then(Value::as_str).map(str::to_string),
        is_deleted: v.get("isDeleted").and_then(Value::as_bool).unwrap_or(false),
        comments: v
            .get("comments")
            .and_then(Value::as_array)
            .map(|a| a.len())
            .unwrap_or(0),
    }
}

fn string_list(v: Option<&Value>) -> Vec<String> {
    v.and_then(Value::as_array)
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// 实体文件定位三级回退（§8.4）：精确 `<name>.<ext>` → `<name>.*` 前缀 → 目录内最大文件。
/// `*_thumbnail.*` 一律排除、绝不当作条目实体；`metadata.json` 是 sidecar 本身，同样排除。
/// 三级都落空 = 无实体文件条目（Bookmark 类）。
///
/// C 档用它**定位到具体文件**（A 档只问有没有）。勘误点：原来第 ③ 级只判存在性，
/// 迁移要知道搬哪个文件，统一取目录中体积最大的那个——与 §8.4 的回退原本是同一件事。
fn resolve_entity_file(dir: &Path, name: &str, ext: &str) -> Option<PathBuf> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return None;
    };
    let mut candidates: Vec<(String, PathBuf, u64)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        if file_name == "metadata.json" || file_name == "Desktop.ini" {
            continue;
        }
        let stem = Path::new(&file_name)
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        // `<name>_thumbnail.png`（也见 .jpg/.webp）是预览图，不是实体（§2）
        if stem.ends_with("_thumbnail") {
            continue;
        }
        let size = entry.metadata().map(|m| m.len()).unwrap_or(0);
        candidates.push((file_name, path, size));
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0));
    // ① 精确
    if !name.is_empty() && !ext.is_empty() {
        let exact = format!("{}.{}", name, ext);
        if let Some(hit) = candidates.iter().find(|(f, _, _)| *f == exact) {
            return Some(hit.1.clone());
        }
    }
    // ② `<name>.*` 前缀（Windows 文件名大小写不敏感，回退层统一小写比）
    if !name.is_empty() {
        let prefix = format!("{}.", name.to_lowercase());
        let hit = candidates
            .iter()
            .find(|(f, _, _)| f.to_lowercase().starts_with(&prefix));
        if let Some(hit) = hit {
            return Some(hit.1.clone());
        }
    }
    // ③ 目录内体积最大的那个
    candidates
        .into_iter()
        .max_by_key(|(_, _, size)| *size)
        .map(|(_, path, _)| path)
}

/// 手动夹树递归（先序：父先于子）。**节点带 `password` → 该子树整体跳过**（D7：
/// 不解密、不列出其中内容），名字记下来给 warnings。
fn walk_folders(
    arr: &[Value],
    parent: Option<&str>,
    out: &mut Vec<FolderNode>,
    locked: &mut Vec<String>,
) {
    for node in arr {
        let Some(obj) = node.as_object() else { continue };
        let name = obj
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        // password 键存在且非 null 即视为加密（社区观察值是 base64 明文；空串/异型值
        // 也按加密处理——宁多跳过、不解密不列内容）
        if obj.get("password").map(|p| !p.is_null()).unwrap_or(false) {
            locked.push(name);
            continue;
        }
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }
        out.push(FolderNode {
            description: obj
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            parent_id: parent.map(str::to_string),
            id,
            name,
        });
        if let Some(children) = obj.get("children").and_then(Value::as_array) {
            walk_folders(children, obj.get("id").and_then(Value::as_str), out, locked);
        }
    }
}

fn walk_smart_folders(arr: &[Value], parent: Option<&str>, out: &mut Vec<SmartFolderNode>) {
    for node in arr {
        let Some(obj) = node.as_object() else { continue };
        let id = obj
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        if id.is_empty() {
            continue;
        }
        out.push(SmartFolderNode {
            description: obj
                .get("description")
                .and_then(Value::as_str)
                .map(str::to_string),
            parent_id: parent.map(str::to_string),
            conditions: parse_conditions(obj.get("conditions")),
            image_count: obj.get("imageCount").and_then(Value::as_i64),
            id: id.clone(),
            name: obj
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        });
        if let Some(children) = obj.get("children").and_then(Value::as_array) {
            walk_smart_folders(children, Some(&id), out);
        }
    }
}

fn parse_conditions(v: Option<&Value>) -> Vec<ConditionGroup> {
    let Some(arr) = v.and_then(Value::as_array) else {
        return Vec::new();
    };
    arr.iter()
        .filter_map(|g| {
            let obj = g.as_object()?;
            Some(ConditionGroup {
                match_all: obj
                    .get("match")
                    .and_then(Value::as_str)
                    .map(|m| m.eq_ignore_ascii_case("AND"))
                    .unwrap_or(true),
                boolean_calibrated: match obj.get("boolean") {
                    None => true,
                    Some(b) => b.as_str() == Some("TRUE"),
                },
                rules: obj
                    .get("rules")
                    .and_then(Value::as_array)
                    .map(|rules| {
                        rules
                            .iter()
                            .filter_map(|r| {
                                let robj = r.as_object()?;
                                Some(SmartRule {
                                    property: robj.get("property").and_then(Value::as_str)?.to_string(),
                                    method: robj.get("method").and_then(Value::as_str)?.to_string(),
                                    value: robj.get("value").cloned().unwrap_or(Value::Null),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default(),
            })
        })
        .collect()
}

// ---------------------------------------------------------------- 智能夹标定（P2b）

/// 求值一条规则。`None` = 未标定（整个智能夹跳过，**不为迁移实现通用筛选器 DSL**，
/// 与 PixCall ⑭/规则 8 同一款）。
///
/// 当前标定表只有两对（§13.1-4 / §13.7 P2b 实测）：
/// * `(property="type", method="equal", value=扩展名串)` —— 与 ext **大小写不敏感**比较；
/// * `(property="name", method="contain", value=子串)` —— **大小写不敏感**包含
///   （实测值 "HEAD" 命中小写 head1(1)）；value 为**空串 = 什么都不命中**
///   （实测 OCR 夹 `value:""` 且 imageCount=0）。
fn eval_rule(rule: &SmartRule, item: &Item) -> Option<bool> {
    match (rule.property.as_str(), rule.method.as_str()) {
        ("type", "equal") => {
            let value = rule.value.as_str()?;
            Some(item.ext.eq_ignore_ascii_case(value))
        }
        ("name", "contain") => {
            let value = rule.value.as_str()?;
            Some(!value.is_empty() && item.name.to_lowercase().contains(&value.to_lowercase()))
        }
        _ => None,
    }
}

/// 求值一个条目是否命中整组条件：组间 AND，组内按 `match` 组合。
/// 组内先**全部**求值再组合——OR 短路会漏掉后面的未标定规则，而任何未标定键
/// 都要整个智能夹跳过。空 rules：AND 视为命中（无约束）、OR 视为不命中（无可选）。
fn evaluate_conditions(groups: &[ConditionGroup], item: &Item) -> Option<bool> {
    let mut result = true;
    for group in groups {
        if !group.boolean_calibrated {
            return None;
        }
        let mut hits = Vec::with_capacity(group.rules.len());
        for rule in &group.rules {
            hits.push(eval_rule(rule, item)?);
        }
        let group_hit = if group.match_all {
            hits.iter().all(|&h| h)
        } else {
            hits.iter().any(|&h| h)
        };
        result &= group_hit;
    }
    Some(result)
}

/// 对候选集（非软删、有实体、类型支持——见 build_plan 的 `eligible`）求值整个智能夹。
/// `None` = 条件含未标定键。
fn select_members<'a>(conditions: &[ConditionGroup], eligible: &[&'a Item]) -> Option<Vec<&'a Item>> {
    let mut out = Vec::new();
    for item in eligible {
        if evaluate_conditions(conditions, item)? {
            out.push(*item);
        }
    }
    Some(out)
}

// ---------------------------------------------------------------- 计划

/// 分类顺序（§4.8 变体，顺序固定——错了会把同一条目重复计入两栏）：
/// ① `isDeleted=true` → `excluded_trash`（软删条目连类型门都不用过）；
/// ①.5 无实体条目（Bookmark）→ 不参与匹配，进 `unmatched_items`；
/// ② `is_indexable`（ext→mime 后过全仓唯一的支持门禁）→ `skipped_unsupported_type`；
/// ③ 按 `name+ext` 匹配 + size/宽高复核；④ 命中的按「并集 / 仅为空时填」合并并计数。
///
/// 与 PixCall 的一处刻意不同：**这里没有「无标注就跳过匹配」**——Eagle 的夹成员关系
/// 挂在条目自己身上（`item.folders[]`），不带标注的成员也要参与匹配才能落 `topic_files`；
/// 全空条目多算出的 matched/unmatched 是如实的覆盖面报告（§13.3 的口径就是全量条目）。
pub fn build_plan(source: &SourceData, our: &OurIndex, our_conn: &Connection) -> Res<MigrationPlan> {
    let mut report = MigrationReport::default();
    let mut edits: Vec<AnnotationEdit> = Vec::new();
    let mut unmatched = UnmatchedItems::default();

    // 解码期异常（条目 metadata.json 缺失/损坏）
    for w in &source.warnings {
        report.warnings.push(w.clone());
    }
    // P3：标签组丢弃 + 上报（PixCall 的 tag_groups 先例）
    if source.tags_groups > 0 {
        report.warnings.push(format!(
            "源库 tagsGroups 有 {} 组（用户自定义标签分组），本期丢弃不迁",
            source.tags_groups
        ));
    }
    // D7：密码夹整体跳过
    for name in &source.password_folders {
        report.warnings.push(format!(
            "密码夹「{}」已整体跳过：不解密、不列出其中内容",
            name
        ));
    }

    // ⑤ 的「仅为空时填」要看我们侧现值；词表用于 `tags_words_added` 的净增口径
    let vocab = existing_vocabulary(our_conn).map_err(|e| e.to_string())?;
    let mut metadata_cache: HashMap<String, Option<file_metadata::FileMetadata>> = HashMap::new();
    let mut new_words: HashSet<String> = HashSet::new();

    // 条目 id → 命中的我们侧 file_id（夹树/智能夹的成员集合要用同一个命中结果）
    let mut matched_files: HashMap<String, String> = HashMap::new();
    // 因类型被拦下的条目按夹归组（§4.9 第 3 条：成员搁置的代价按夹可见）
    let mut type_skipped_by_folder: HashMap<String, u32> = HashMap::new();
    // 智能夹求值的候选集：非软删、有实体、类型支持。**在匹配之前收集**——断言对的是
    // Eagle 侧的条目数（imageCount），与我们这边命中没命中无关。
    let mut eligible: Vec<&Item> = Vec::new();
    let mut bookmarks = 0u32;

    for item in &source.items {
        // ① 软删（v4.5 拍板 A：不迁、不复制，报告只列名字；origin_folder 尽量从夹树解析）
        if item.is_deleted {
            report.excluded_trash += 1;
            report.excluded_trash_names.push(TrashItem {
                name: display_name(item),
                origin_folder: resolve_origin_folder(source, &item.folders),
            });
            continue;
        }
        // ①.5 无实体文件条目（Bookmark 类，§8.3）：键对它无效（无实体可复核），
        // 不参与匹配、进 unmatched_items；类别计数在循环后报一条
        if !item.has_entity {
            bookmarks += 1;
            unmatched.push(display_name(item));
            continue;
        }
        // ② 类型门禁：Eagle 侧只有扩展名 → file_types 的 ext→mime → 全仓唯一的 is_indexable
        let mime = file_types::mime_for_extension(&item.ext);
        if !mime.map(is_indexable).unwrap_or(false) {
            report.skipped_unsupported_type += 1;
            if item.annotated() {
                report.annotated_unsupported += 1;
            }
            for fid in &item.folders {
                *type_skipped_by_folder.entry(fid.clone()).or_insert(0) += 1;
            }
            continue;
        }
        eligible.push(item);

        // ③ 按 `name+ext` 匹配（§13.3 实测标定的主键；候选 >1 = 同名多义，不猜）
        let key = format!("{}.{}", item.name, item.ext).to_lowercase();
        let candidates = our.find_by_name_ext(&key);
        let row = if candidates.len() == 1 {
            candidates[0]
        } else {
            unmatched.push(display_name(item));
            if candidates.len() > 1 {
                report.warnings.push(format!(
                    "「{}」在我们索引里同名多义（{} 行），按不命中处理、不猜",
                    display_name(item),
                    candidates.len()
                ));
            }
            continue;
        };
        // 复核（§13.3：实测样例两侧全相等；我们侧 NULL 或不等 → 视为不命中）。
        // 顺带挡掉文件夹行（size=0、宽高 NULL 的 Folder 行就算同名也过不了）。
        let size_ok = item.size.map(|s| s == row.size).unwrap_or(false);
        let dims_ok = match (item.width, item.height, row.width, row.height) {
            (Some(w), Some(h), Some(rw), Some(rh)) => w == rw && h == rh,
            _ => false,
        };
        if !size_ok || !dims_ok {
            unmatched.push(display_name(item));
            report.warnings.push(format!(
                "「{}」命中了索引行（{}）但 size/宽高复核不过（源侧 {:?} 字节 {:?}×{:?}，我们侧 {} 字节 {:?}×{:?}），按不命中处理（§13.3）",
                display_name(item),
                row.path,
                item.size,
                item.width,
                item.height,
                row.size,
                row.width,
                row.height,
            ));
            continue;
        }
        report.matched += 1;
        matched_files.insert(item.id.clone(), row.file_id.clone());

        // ④ 合并（全部走共享策略，与 pixcall.rs 同款）
        let existing: Option<file_metadata::FileMetadata> = match metadata_cache.get(&row.file_id) {
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

        // —— 标签（名字字符串数组 → normalize → 与我们已有的并集，保留我们已有顺序）——
        if !item.tags.is_empty() {
            let current: Vec<String> = existing
                .as_ref()
                .and_then(|m| m.tags.clone())
                .and_then(|v| serde_json::from_value::<Vec<String>>(v).ok())
                .unwrap_or_default();
            let merged = merge_tag_lists(&current, &item.tags);
            let added: Vec<String> = merged
                .iter()
                .filter(|word| !current.iter().any(|c| c == *word))
                .cloned()
                .collect();
            if !added.is_empty() {
                edit.tags = Some(merged);
                report.tags_unioned += 1;
                for word in &added {
                    if !vocab.contains(word.as_str()) && new_words.insert(word.clone()) {
                        report.tags_words_added += 1;
                    }
                }
            }
        }

        // —— 备注（annotation：写入前 trim——fill_if_empty 自带；仅为空时填）——
        if !blank(item.annotation.as_deref()) {
            let (value, yielded) = fill_if_empty(
                existing.as_ref().and_then(|m| m.description.as_deref()),
                item.annotation.as_deref(),
            );
            if let Some(v) = value {
                edit.description = Some(v);
                report.descriptions_written += 1;
            } else if yielded {
                report.descriptions_skipped_existing += 1;
            }
        }

        // —— 来源链接（P1(b)：我们已有的不动，源侧那条不在列表里就追加；已有则不重复；
        // **不做 URL 合法性校验**，PixCall 期那条误存的 x.com/home 同款原样搬）——
        if !blank(item.url.as_deref()) {
            let current = existing.as_ref().map(|m| m.source_urls()).unwrap_or_default();
            let link = item.url.as_deref().unwrap_or_default().trim().to_string();
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

    if bookmarks > 0 {
        report.warnings.push(format!(
            "有 {} 个无实体文件的条目（Bookmark 类），不参与匹配、已计入不命中清单（调研 §8.3）",
            bookmarks
        ));
    }
    // P4：图上矩形标注丢弃 + 上报（PixCall 官方插件同样丢）
    let commented = source.items.iter().filter(|i| i.comments > 0).count();
    if commented > 0 {
        report.warnings.push(format!(
            "{} 个条目带图上矩形标注（comments），我们无对应机制，本期丢弃不迁（P4 拍板）",
            commented
        ));
    }

    // 专题：先手动夹树、再智能夹树（两棵树互不引用，各自先序）
    let mut topics = plan_folders(
        source,
        our_conn,
        &matched_files,
        &type_skipped_by_folder,
        &mut report,
    )?;
    topics.extend(plan_smart_folders(
        source,
        our_conn,
        &matched_files,
        &eligible,
        &mut report,
    )?);

    let (unmatched_count, unmatched_items) = unmatched.into_parts();
    report.unmatched = unmatched_count as u32;
    report.unmatched_items = unmatched_items;
    // H2 拍板：`unmatched_paths` 保留给 PixCall（它有路径可列），Eagle 恒为空数组
    report.unmatched_paths = Vec::new();

    Ok(MigrationPlan {
        report,
        edits,
        topics,
        source_schema_version: source.application_version.clone(),
    })
}

fn resolve_origin_folder(source: &SourceData, folders: &[String]) -> Option<String> {
    folders
        .iter()
        .find_map(|fid| source.folders.iter().find(|n| &n.id == fid))
        .map(|n| n.name.clone())
}

/// 规则 1/2：根节点挂我们 topics 的根（parent_id = NULL）；父级被跳过时沿源树链找
/// 最近的已迁祖先，一个都没有就挂根。`eagle_parent` 给出某个源夹 id 的源父 id。
fn resolve_parent(
    start: &Option<String>,
    mut eagle_parent: impl FnMut(&str) -> Option<String>,
    mapped: &HashMap<String, Option<String>>,
) -> (Option<String>, bool) {
    let mut current = start.clone();
    let mut reparented = false;
    let mut hops = 0;
    while let Some(parent_id) = current {
        hops += 1;
        if hops > 64 {
            return (None, reparented);
        }
        match mapped.get(&parent_id) {
            Some(Some(topic_id)) => return (Some(topic_id.clone()), reparented),
            Some(None) => {
                reparented = true;
                current = eagle_parent(&parent_id);
            }
            // 父级不在先序映射里（源树残缺）：挂根并上报
            None => return (None, true),
        }
    }
    (None, reparented)
}

/// 源树层级（1 起）。父在先序里一定先出现，所以一遍就能算出来。
fn parent_level(parent_id: &Option<String>, levels: &HashMap<String, usize>) -> usize {
    parent_id
        .as_ref()
        .and_then(|p| levels.get(p).copied())
        .unwrap_or(0)
        + 1
}

/// 我们侧专题**只有两级**（主专题 / 子专题），Eagle 的夹树却可以更深。
///
/// 规则（2026-10-06 验收人实测后定）：一级 = 主专题，二级及以下**一律压到二级**——
/// 挂到它那一支的一级祖先下面，而不是照搬源树的深度。照搬的话三级专题建出来也看不见
/// （专题面板只渲染两级），不如提前压平，层级关系还能保住主干。
///
/// 返回「该挂到哪个源节点下面」（`None` = 挂到我们 topics 的根）。
fn clamped_parent(
    node_id: &str,
    levels: &HashMap<String, usize>,
    parent_of: impl Fn(&str) -> Option<String>,
) -> Option<String> {
    let level = levels.get(node_id).copied().unwrap_or(1);
    if level <= 1 {
        return None;
    }
    let direct = parent_of(node_id);
    if level == 2 {
        return direct;
    }
    // 三级及以上：往上找到一级祖先，挂到它下面
    let mut current = direct.clone();
    while let Some(id) = current {
        if levels.get(&id).copied().unwrap_or(1) == 1 {
            return Some(id);
        }
        current = parent_of(&id);
    }
    direct
}

/// 手动夹树 → 专题。空 `folders[]` 的条目自然不是任何夹的成员（主流形态，不是错误）；
/// 夹本身即使没有任何命中成员也照建（棋盘层级要靠它，同 PixCall 的 folder-only）。
fn plan_folders(
    source: &SourceData,
    our_conn: &Connection,
    matched_files: &HashMap<String, String>,
    type_skipped_by_folder: &HashMap<String, u32>,
    report: &mut MigrationReport,
) -> Res<Vec<TopicCreate>> {
    let mut mapped: HashMap<String, Option<String>> = HashMap::new();
    let mut levels: HashMap<String, usize> = HashMap::new();
    let mut created = Vec::new();
    // source.folders 已是先序（父先于子，JSON 数组序）
    for node in &source.folders {
        levels.insert(node.id.clone(), parent_level(&node.parent_id, &levels));
        // 我们侧专题只有两级：三级及更深一律压到二级（挂那一支的一级祖先下面）
        let desired_parent = clamped_parent(&node.id, &levels, |pid| {
            source
                .folders
                .iter()
                .find(|n| n.id == pid)
                .and_then(|n| n.parent_id.clone())
        });
        let (parent_topic_id, reparented) = resolve_parent(
            &desired_parent,
            |pid| {
                source
                    .folders
                    .iter()
                    .find(|n| n.id == *pid)
                    .and_then(|n| n.parent_id.clone())
            },
            &mapped,
        );
        if reparented {
            report.topics_reparented += 1;
            report.warnings.push(format!(
                "夹「{}」的父级未落库，已降级挂到最近的已迁祖先（§4.6 规则 2）",
                node.name
            ));
        }

        // 成员顺序 = 条目遍历序（items 已按 id 排序），重跑稳定
        let mut member_file_ids: Vec<String> = Vec::new();
        for item in &source.items {
            if !item.folders.iter().any(|f| f == &node.id) {
                continue;
            }
            if let Some(file_id) = matched_files.get(&item.id) {
                if !member_file_ids.contains(file_id) {
                    member_file_ids.push(file_id.clone());
                }
            }
            // 未命中的成员已经在条目循环里进过 unmatched_items，这里不重复计
        }
        if let Some(skipped) = type_skipped_by_folder.get(&node.id) {
            report.topic_members_skipped_type += *skipped;
            report.warnings.push(format!(
                "夹「{}」的成员里有 {} 条是我们不支持的类型，已跳过该成员（§4.9 第 3 条）",
                node.name, skipped
            ));
        }

        let topic = plan_topic_node(
            our_conn,
            report,
            &format!("eagle-folder|{}", node.id),
            &node.name,
            node.description.as_deref(),
            parent_topic_id,
            member_file_ids,
            false,
        )?;
        mapped.insert(node.id.clone(), Some(topic.id.clone()));
        created.push(topic);
    }
    Ok(created)
}

/// 智能夹树 → 快照专题（拍板 P2b：**断言通过才固化**）。
///
/// 三道门（全过才落库）：
/// 1. 条件全部标定（只实现 `type=equal` 与 `name=contain`，其余整个夹跳过）；
/// 2. 磁盘上有 `imageCount`（只在子节点上有；没有的节点无法断言 → 跳过）；
/// 3. 复算成员数与 `imageCount` **精确相等**。
///
/// 复算集合是 Eagle 侧的 `eligible`（与我们这边命中与否无关）；固化时成员只取
/// 命中我们索引的那部分。断言过但命中成员为 0 → 不落空专题（空专题不算真的动了库）。
///
/// 2026-10-06 实测后补的一条：**被跳过的祖先仍然可能是层级的载体**。样本库里 `TESTV2`
/// 自己没有 `imageCount`（断言做不了 → 跳过），它的子智能夹 `HEA` 断言过了；按老逻辑 HEA
/// 会「沿链找最近的已迁祖先」——一个都没有，于是挂到了根上，变成一枚顶层专题。验收人要的是
/// **TESTV2 作主专题、HEA 作它的子专题**。所以这里改成两趟：
/// ① 先给每个节点求值（三道门）；② 再看哪些被跳过的节点**有后代要挂**，给它们建一枚
/// **只承载层级、不带成员的容器专题**——成员不猜：父夹的条件本来就断言不了，把子夹的成员
/// 抄上去等于报一组我们没验过的数。
fn plan_smart_folders(
    source: &SourceData,
    our_conn: &Connection,
    matched_files: &HashMap<String, String>,
    eligible: &[&Item],
    report: &mut MigrationReport,
) -> Res<Vec<TopicCreate>> {
    // ① 求值：命中成员的 file_id 列表；跳过 → None（warnings 已记原因）。
    //    返回值第二项 = 这个夹是**断言过**的还是「按条件自算但没断言」的（后者不计入
    //    `topics_materialized`，2026-10-06 实测库的 TESTV2 就是这种）。
    let mut evaluated: HashMap<String, Option<(Vec<String>, bool)>> = HashMap::new();
    for node in &source.smart_folders {
        // 空条件：我们求值器里「没有组」等于命中一切，Eagle 侧语义不明（实测库的「阿萨的」就是
        // 这个形态）。按「全部条目」落库会造出一枚含 49 条的专题，宁可不落。
        if node.conditions.is_empty() {
            report.topics_skipped_unverifiable += 1;
            report.warnings.push(format!(
                "智能夹「{}」没有条件，Eagle 侧语义不明（我们的求值器会当成「命中一切」），跳过不迁（P2b）",
                node.name
            ));
            evaluated.insert(node.id.clone(), None);
            continue;
        }
        let Some(recomputed) = select_members(&node.conditions, eligible) else {
            report.topics_skipped_unverifiable += 1;
            report.warnings.push(format!(
                "智能夹「{}」的条件含未标定的 property/method/boolean，跳过不迁（P2b：只实现 type=equal 与 name=contain）",
                node.name
            ));
            evaluated.insert(node.id.clone(), None);
            continue;
        };
        let asserted = match node.image_count {
            Some(image_count) => {
                if recomputed.len() as i64 != image_count {
                    report.topics_skipped_unverifiable += 1;
                    report.warnings.push(format!(
                        "智能夹「{}」复算得 {} 条 ≠ imageCount {}，计数断言不过，跳过（P2b；类型不支持的条目不在复算集里，源库含视频/字体/书签时会保守失败）",
                        node.name,
                        recomputed.len(),
                        image_count
                    ));
                    evaluated.insert(node.id.clone(), None);
                    continue;
                }
                true
            }
            None => {
                // 2026-10-06 实测修正：Eagle **只在子节点上写 imageCount**，父节点常常没有，
                // 但它同样是有成员的（实测库 TESTV2 = 全部 12 张 jpg）。断言做不了 ≠ 数据不可信：
                // 条件已全部标定的前提下按条件自算成员落库，但**不算「固化成快照专题」**
                // （那条计数与「新落入条件的文件不会自动加入」的说明只给断言过的夹）。
                report.warnings.push(format!(
                    "智能夹「{}」磁盘上没有 imageCount，无法做计数断言；条件已全部标定，按条件自算 {} 条落库（未断言）",
                    node.name,
                    recomputed.len()
                ));
                false
            }
        };

        let member_file_ids: Vec<String> = recomputed
            .iter()
            .filter_map(|item| matched_files.get(&item.id).cloned())
            .collect();
        if member_file_ids.is_empty() {
            report.warnings.push(format!(
                "智能夹「{}」{}但没有一条命中我们的索引，不落空专题",
                node.name,
                if asserted {
                    format!("断言通过（{} 条）", recomputed.len())
                } else {
                    format!("自算得 {} 条", recomputed.len())
                }
            ));
        }
        evaluated.insert(node.id.clone(), Some((member_file_ids, asserted)));
    }

    // ② 谁需要专题：自己有命中成员，或**后代需要**（被跳过的祖先因此成为容器）
    let mut needed: HashSet<String> = HashSet::new();
    for (id, value) in &evaluated {
        if value.as_ref().map_or(false, |(members, _)| !members.is_empty()) {
            needed.insert(id.clone());
        }
    }
    // 反向先序（子一定在父之后 → 反着走时子先被处理）把「需要」往上传
    for node in source.smart_folders.iter().rev() {
        if needed.contains(&node.id) {
            if let Some(parent_id) = &node.parent_id {
                needed.insert(parent_id.clone());
            }
        }
    }

    // ③ 建专题（先序，父先于子）
    let mut mapped: HashMap<String, Option<String>> = HashMap::new();
    let mut levels: HashMap<String, usize> = HashMap::new();
    let mut created = Vec::new();
    for node in &source.smart_folders {
        levels.insert(node.id.clone(), parent_level(&node.parent_id, &levels));
        if !needed.contains(&node.id) {
            mapped.insert(node.id.clone(), None);
            continue;
        }
        let (member_file_ids, asserted) = evaluated
            .get(&node.id)
            .cloned()
            .flatten()
            .unwrap_or_default();
        // 没成员的 = 被跳过的祖先（或断言过但没命中的夹）：只承载层级
        let is_container = member_file_ids.is_empty();
        if is_container {
            report.warnings.push(format!(
                "智能夹「{}」自身没能固化（见上一条提示），但它的子夹要挂在它下面 → 建了一枚只承载层级、没有成员的专题",
                node.name
            ));
        }
        let parent_of = |pid: &str| {
            source
                .smart_folders
                .iter()
                .find(|n| n.id == pid)
                .and_then(|n| n.parent_id.clone())
        };
        let desired_parent = clamped_parent(&node.id, &levels, parent_of);
        let (parent_topic_id, reparented) = resolve_parent(&desired_parent, parent_of, &mapped);
        if reparented {
            report.topics_reparented += 1;
            report.warnings.push(format!(
                "智能夹「{}」的父级未落库，已降级挂到最近的已迁祖先（§4.6 规则 2）",
                node.name
            ));
        }

        let topic = plan_topic_node(
            our_conn,
            report,
            &format!("eagle-smart|{}", node.id),
            &node.name,
            node.description.as_deref(),
            parent_topic_id,
            member_file_ids,
            // 「固化成快照专题」这条计数只给**断言通过**的夹：容器（父夹跳过）与
            // 「条件标定但无 imageCount」（自算成员）都不算，报告里各有 warnings 说明
            asserted && !is_container,
        )?;
        mapped.insert(node.id.clone(), Some(topic.id.clone()));
        created.push(topic);
    }
    Ok(created)
}

/// 查重 + 并入/新建（§4.6 规则 3/4，v4.9 全套，与 pixcall.rs 的分支同款）。
/// `materialized` = 智能夹固化（固化成功只在**真的建出专题**时才计数，同名让位的不算）。
#[allow(clippy::too_many_arguments)]
fn plan_topic_node(
    our_conn: &Connection,
    report: &mut MigrationReport,
    eagle_key: &str,
    name: &str,
    description: Option<&str>,
    parent_topic_id: Option<String>,
    member_file_ids: Vec<String>,
    materialized: bool,
) -> Res<TopicCreate> {
    let trimmed_description = description
        .map(str::trim)
        .filter(|d| !d.is_empty())
        .map(str::to_string);

    // 规则 3：查重键是 `(映射后的我们父级, name)`，不是裸名字
    let by_name =
        find_topic_by_name(our_conn, parent_topic_id.as_deref(), name).map_err(|e| e.to_string())?;
    // 兜底认领（2026-10-06）：同一枚源节点**以前**铸过的专题 id 还在，但父级变了。
    // 典型就是「改版后重跑」——早先的映射把子专题建在了根上，修好层级后该把它挪下去，
    // 而不是再建一枚重复的（父级一变，上面的 (父级, name) 查重就查不到了）。
    // 只在「它当前挂在根上、这次有父级」时认领：已经有父级的多半是用户自己整理的。
    let mut reparent_existing = false;
    let existing_id = match by_name {
        Some(id) => Some(id),
        None => match find_topic_by_import_seed(our_conn, eagle_key) {
            Some(id) if parent_topic_id.is_some() => {
                let current_parent: Option<String> = our_conn
                    .query_row(
                        "SELECT parent_id FROM topics WHERE id = ?1",
                        params![&id],
                        |row| row.get(0),
                    )
                    .unwrap_or(None);
                if current_parent.is_none() {
                    reparent_existing = true;
                    report.topics_reparented += 1;
                    report.warnings.push(format!(
                        "专题「{}」上次导入时是顶层（当时的父级没落库），这次按源树挪到父专题下面（不新建重复专题）",
                        name
                    ));
                    Some(id)
                } else {
                    None
                }
            }
            _ => None,
        },
    };
    if let Some(existing_id) = existing_id {
        // 规则 4（v4.9）：同名命中已有专题 → 不新建，成员并进去；名字/父级不改；
        // 封面与描述「空着才补」（落库侧的 merge_into_existing_topic）
        let already: HashSet<String> = {
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
                name
            ));
        }
        report.warnings.push(format!(
            "源节点「{}」在我们侧同父级下已有同名专题，成员已并入它（未新建同名专题）",
            name
        ));
        return Ok(TopicCreate {
            description: trimmed_description,
            file_ids: new_members,
            materialized,
            merge_into_existing: true,
            reparent_existing,
            id: existing_id,
            name: name.to_string(),
            parent_id: parent_topic_id,
        });
    }

    let id = new_topic_id(our_conn, eagle_key);
    report.topic_files_added += member_file_ids.len() as u32;
    report.topics_created += 1;
    if materialized {
        report.topics_materialized += 1;
        report.warnings.push(format!(
            "智能夹「{}」断言通过、固化为快照专题：新落入条件的文件不会自动加入（我们侧无智能专题机制，§4.6 规则 6）",
            name
        ));
    }
    Ok(TopicCreate {
        // 规则 5：描述非空时写入 `topics.description`
        description: trimmed_description,
        file_ids: member_file_ids,
        materialized,
        merge_into_existing: false,
        reparent_existing: false,
        id,
        name: name.to_string(),
        parent_id: parent_topic_id,
    })
}

#[cfg(test)]
mod tests;

// ---------------------------------------------------------------- C 档：连文件接管（讨论稿 §5 Q1–Q10）
//
// **为什么要有这一层**：我们是 Eagle 的竞品而不是它的插件，迁移的完成标准是「用户搬完之后
// 他的图库能独立存在」。把 `.library` 当资源根（路线 B）做不到这一点——文件还在 Eagle 的库里，
// 删掉 Eagle 就没了，而且 `.info` 这层目录与 `_thumbnail.png` 会把网格糊成一团
// （验收人 2026-10-06 实测：49 条目 = 49 个文件夹 / 每图 3 张缩略图）。所以 C 档把**实体文件**
// 从库里剥出来、剥掉 `.info` 与缩略图、按 Eagle 的夹结构落进用户自己的资源根，随后复用 A 档
// 的匹配链挂标注（Q8：先搬运、后认亲，不另写一套）。
//
// 三条硬约束（讨论稿 §6）：
// 1. **库只读**：只 `read` 源的实体文件，绝不 move、绝不写回 `.library`；
// 2. `is_indexable` 全仓单点门禁——这里不认扩展名黑名单，视频/字体在前一步就被拦下；
// 3. 幂等：目标路径已有同样大小的文件就跳过，中断后重跑安全（Q7，不做事务回滚）。

/// 目标位置 与 链接能力的预览（probe 之后、动手之前给用户看的那栏）。
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TakeoverPreview {
    pub target_root: String,
    /// 会参与搬运的条目数（含我们侧已有的那些——它们最终也进 wit 图库）
    pub total_items: u32,
    /// 我们图库里已经有同一张图 → 不搬，只挂标注
    pub already_here: u32,
    /// 目标位置已有同名文件（上次搬过）→ 跳过搬运
    pub skipped_existing: u32,
    pub to_link: u32,
    pub to_copy: u32,
    pub bytes: u64,
    /// 目标位置所在的卷支不支持硬链接（跨盘符 / 网络盘 / 非 NTFS）→ 只能复制（占同样空间）
    pub link_supported: bool,
    pub warnings: Vec<String>,
}

/// 搬完之后的产出，`eagle_import` 用它填报告的搬运栏并落索引。
#[derive(Debug, Default)]
pub struct TakeoverOutcome {
    pub linked: u32,
    pub copied: u32,
    /// 我们侧已经有同一张图、没搬只挂标注的条数（Q8：A 档退化成 C 的一步）
    pub already_here: u32,
    pub skipped_existing: u32,
    pub failed: u32,
    /// 搬进来的内容体量（硬链接同样计入——不额外占空间是另一回事，
    /// 报告里让用户知道搬了多少内容，不用两次数值口径）
    pub bytes: u64,
    /// 落盘时用得到：新建出来的目录（含 `<目标根>` 本身），按路径长度升序（父先于子）
    pub created_dirs: Vec<String>,
    pub files: Vec<TakeoverFile>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct TakeoverFile {
    pub path: String,
    /// Eagle 的 `width`/`height`：**走 `${name}.${ext}` 认亲时 size/宽高复核要用**，
    /// 这里直接带上，省掉导入后再排一次后台解图。
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Debug)]
struct PlannedFile {
    src: PathBuf,
    dst: PathBuf,
    size: u64,
    width: Option<u32>,
    height: Option<u32>,
}

/// `plan_takeover` 的产物。字段刻意私有：调用方只把它交给 `takeover_preview` /
/// `execute_takeover`，不许自己改文件名规则（Q5 的语义要保持单点）。
#[derive(Debug)]
pub struct TakeoverPlan {
    target_root: String,
    link_supported: bool,
    files: Vec<PlannedFile>,
    dirs: Vec<String>,
    total_items: u32,
    already_here: u32,
    skipped_existing: u32,
    warnings: Vec<String>,
}

impl TakeoverPlan {
    /// 最终落地的目标目录（归一化后）——报告里要能复核「搬到哪了」。
    pub fn target_root(&self) -> &str {
        &self.target_root
    }
}

/// 文件名/目录名净化：Windows 与 Unix 禁用字符集的交集之外的内容换成 `_`，
/// 再去首尾空白与点。空名给稳定占位（夹名可能就是空的）。
fn sanitize_name(raw: &str) -> String {
    const FORBIDDEN: &[char] = &['<', '>', ':', '"', '/', '\\', '|', '?', '*'];
    let cleaned: String = raw
        .chars()
        .filter(|c| !c.is_control() && !FORBIDDEN.contains(c))
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').to_string();
    if trimmed.is_empty() {
        "_".to_string()
    } else {
        trimmed
    }
}

fn short_id(id: &str) -> String {
    if id.len() > 6 {
        id[..6].to_string()
    } else {
        id.to_string()
    }
}

/// 库目录名 → 我们图库里的那个子目录名（`Test.library` → `Test`）。
pub fn library_dir_name(root: &str) -> String {
    let raw = Path::new(root)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| root.to_string());
    let stripped = raw.strip_suffix(".library").unwrap_or(&raw).to_string();
    sanitize_name(&stripped)
}

/// 大小/位置比较统一小写比（Windows 大小写不敏感）。判断 `child` 是否落在 `parent` 里。
fn path_is_inside(parent: &str, child: &str) -> bool {
    let p = parent.to_lowercase();
    let c = child.to_lowercase();
    if p == c {
        return true;
    }
    let p = p.trim_end_matches(['/', '\\']);
    c.starts_with(&format!("{}/", p)) || c.starts_with(&format!("{}\\", p))
}

/// 一个path 的最深**已存在**祖先（用于硬链接探测，避免为了探测就去建目录）。
fn existing_ancestor(path: &Path) -> Option<PathBuf> {
    let mut current = Some(path);
    while let Some(p) = current {
        if p.is_dir() {
            return Some(p.to_path_buf());
        }
        current = p.parent();
    }
    None
}

/// 目标卷支能不能建硬链接：探测文件必须落在**目标同一卷**上才准，
/// 所以拿最深已存在的祖先目录当探测位（通常是用户的资源根，早已存在）。
fn probe_hard_link_support(target: &Path) -> bool {
    let probe_dir = match existing_ancestor(target) {
        Some(dir) => dir,
        None => return false,
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let base = probe_dir.join(format!(".aurora-link-probe-{}", stamp));
    if std::fs::write(&base, b"").is_err() {
        return false;
    }
    let link = probe_dir.join(format!(".aurora-link-probe-{}.lnk", stamp));
    let ok = std::fs::hard_link(&base, &link).is_ok();
    let _ = std::fs::remove_file(&link);
    let _ = std::fs::remove_file(&base);
    ok
}

/// Eagle 手动夹树 → 目标目录下的相对子目录（Q2/Q3：有夹则镜像一层目录）。
/// 兄弟同名用短 id 消歧；父级缺失（源树残缺）就当成根级堆着。
fn folder_relative_paths(source: &SourceData) -> HashMap<String, String> {
    let mut rel: HashMap<String, String> = HashMap::new();
    let mut siblings: HashMap<String, HashSet<String>> = HashMap::new();
    for node in &source.folders {
        let name = sanitize_name(&node.name);
        let parent_rel = node
            .parent_id
            .as_ref()
            .and_then(|p| rel.get(p).cloned())
            .unwrap_or_default();
        let taken = siblings.entry(parent_rel.clone()).or_default();
        let mut final_name = name.clone();
        if !taken.insert(final_name.clone()) {
            final_name = format!("{}_{}", name, short_id(&node.id));
            let mut salt = 1u32;
            while !taken.insert(final_name.clone()) && salt < 64 {
                salt += 1;
                final_name = format!("{}_{}_{}", name, short_id(&node.id), salt);
            }
        }
        let value = if parent_rel.is_empty() {
            final_name
        } else {
            format!("{}/{}", parent_rel, final_name)
        };
        rel.insert(node.id.clone(), value);
    }
    rel
}

/// 一个条目在我们的索引里是不是已经精确到同一张图（A 档的认亲判据，与 build_plan 同一套）。
fn already_indexed(our: &OurIndex, item: &Item) -> bool {
    let key = format!("{}.{}", item.name, item.ext).to_lowercase();
    let candidates = our.find_by_name_ext(&key);
    if candidates.len() != 1 {
        return false;
    }
    let row = candidates[0];
    let size_ok = item.size.map(|s| s == row.size as i64).unwrap_or(false);
    let dims_ok = matches!(
        (item.width, item.height, row.width, row.height),
        (Some(w), Some(h), Some(rw), Some(rh)) if w == rw as i64 && h == rh as i64
    );
    size_ok && dims_ok
}

/// `name.ext` 撞了已占位的文件名 → 在扩展名前加 `_<短id>`（Q5：默认原名，撞名才加后缀）。
///
/// 「已占位」有两处来源，缺一不可：① 本次计划里已经用过的名字；② **我们索引里已有的
/// `name.ext`**——撞它等于给认亲键制造多义（`find_by_name_ext` >1 行按不命中处理），
/// 那这张图就白搬了。所以同名不同图的条目会以 `foo_<短id>.jpg` 落盘，宁可名字丑也不让键歧义。
fn planned_name(name: &str, id: &str, taken: &HashSet<String>, our: &OurIndex) -> String {
    let base = sanitize_name(name);
    if taken.contains(&base.to_lowercase()) || our.has_name_ext(&base.to_lowercase()) {
        let (stem, ext) = match base.rsplit_once('.') {
            Some((s, e)) => (s.to_string(), e.to_string()),
            None => (base, String::new()),
        };
        if ext.is_empty() {
            format!("{}_{}", stem, short_id(id))
        } else {
            format!("{}_{}.{}", stem, short_id(id), ext)
        }
    } else {
        base
    }
}

/// 计划搬运动作。**纯计算 + 只读源侧**：不建目录、不写任何文件。
pub fn plan_takeover(
    source: &SourceData,
    our: &OurIndex,
    target_root: &str,
    prefer_link: bool,
) -> Res<TakeoverPlan> {
    let target = normalize_path(target_root);
    if target.is_empty() {
        return Err("搬运需要一个目标目录".to_string());
    }
    // 不许把文件往源库自己里面塞：目标不能落在库内部（那样会一层层把自己拷进去）
    if path_is_inside(&source.root, &target) {
        return Err(format!(
            "目标目录 {} 在 Eagle 库内部，不能往库里搬东西（调研硬约束 1：库只读）",
            target
        ));
    }

    let link_supported = if prefer_link {
        probe_hard_link_support(Path::new(&target))
    } else {
        false
    };

    let folder_rel = folder_relative_paths(source);
    let mut taken: HashSet<String> = HashSet::new();
    let mut files: Vec<PlannedFile> = Vec::new();
    let mut dirs: Vec<String> = Vec::new();
    let mut total_items = 0u32;
    let mut already_here = 0u32;
    let mut skipped_existing = 0u32;
    let mut warnings = Vec::new();

    for item in &source.items {
        // 与 build_plan 同一条分类顺序（§4.8 变体）：软删 → 无实体 → 类型门禁
        if item.is_deleted {
            continue;
        }
        let entity = match &item.entity_path {
            Some(path) => PathBuf::from(path),
            None => continue,
        };
        let mime = file_types::mime_for_extension(&item.ext);
        if !mime.map(is_indexable).unwrap_or(false) {
            continue;
        }
        total_items += 1;

        // Q8：认亲优先——已经是同一张图就不搬，标注照挂（A 档退化成 C 的一步）
        if already_indexed(our, item) {
            already_here += 1;
            continue;
        }

        // Q2/Q3：多归属只落物理一份（主夹 = `folders[]` 里的第一个），其余夹关系走专题
        let rel_dir = item
            .folders
            .iter()
            .find_map(|fid| folder_rel.get(fid).cloned())
            .unwrap_or_default();
        let dest_dir = if rel_dir.is_empty() {
            target.clone()
        } else {
            normalize_path(&format!("{}/{}", target.trim_end_matches('/'), rel_dir))
        };
        if !dirs.contains(&dest_dir) {
            dirs.push(dest_dir.clone());
        }

        let base_name = display_name(item);
        let mut file_name = planned_name(&base_name, &item.id, &taken, our);
        let mut dst = PathBuf::from(&dest_dir).join(&file_name);
        // Q5/Q7：目标已存在 → 同尺寸就是上次搬过（幂等跳过），不同则加短 id 再比一次
        if dst.exists() {
            let same = std::fs::metadata(&dst)
                .map(|m| item.size.map(|s| m.len() == s as u64).unwrap_or(false))
                .unwrap_or(false);
            if same {
                skipped_existing += 1;
                taken.insert(file_name.to_lowercase());
                continue;
            }
            let (stem, ext) = display_name(item)
                .rsplit_once('.')
                .map(|(s, e)| (s.to_string(), e.to_string()))
                .unwrap_or_else(|| (display_name(item), String::new()));
            file_name = if ext.is_empty() {
                format!("{}_{}", stem, short_id(&item.id))
            } else {
                format!("{}_{}.{}", stem, short_id(&item.id), ext)
            };
            dst = PathBuf::from(&dest_dir).join(&file_name);
            if dst.exists() {
                warnings.push(format!(
                    "目标位置已经有 {}，跳过不覆盖（可能是同名不同图，认亲要靠用户自己确认）",
                    display_name(item)
                ));
                continue;
            }
        }
        taken.insert(file_name.to_lowercase());

        let size = std::fs::metadata(&entity).map(|m| m.len()).unwrap_or(0);
        files.push(PlannedFile {
            src: entity,
            dst,
            size,
            width: item.width.map(|w| w as u32),
            height: item.height.map(|h| h as u32),
        });
    }

    // 目标根自己也入库（用户第一次倒时它还不在索引里），并保证父先于子
    if !dirs.contains(&target) {
        dirs.push(target.clone());
    }
    dirs.sort_by_key(|p| p.matches('/').count());

    Ok(TakeoverPlan {
        target_root: target,
        link_supported,
        files,
        dirs,
        total_items,
        already_here,
        skipped_existing,
        warnings,
    })
}

/// 从计划导出 UI 要的那张预览表（同一个 plan，`eagle_import` 前的口估）。
pub fn takeover_preview(plan: &TakeoverPlan) -> TakeoverPreview {
    let bytes = plan.files.iter().map(|f| f.size).sum::<u64>();
    let links_possible = plan.link_supported;
    TakeoverPreview {
        target_root: plan.target_root.clone(),
        total_items: plan.total_items,
        already_here: plan.already_here,
        skipped_existing: plan.skipped_existing,
        to_link: if links_possible {
            plan.files.len() as u32
        } else {
            0
        },
        to_copy: if links_possible {
            0
        } else {
            plan.files.len() as u32
        },
        bytes,
        link_supported: links_possible,
        warnings: plan.warnings.clone(),
    }
}

/// 执行搬运：**硬链接优先、失败自动降级复制**（Q1）。源侧全程只读。
pub fn execute_takeover(
    plan: &TakeoverPlan,
    progress: Option<&(dyn Fn(usize, usize) + Send + Sync)>,
) -> TakeoverOutcome {
    let mut out = TakeoverOutcome::default();
    out.warnings = plan.warnings.clone();
    // 这两栏在计划阶段就定了（认亲命中 / 目标已有同尺寸文件），执行阶段只是照抄
    out.already_here = plan.already_here;
    out.skipped_existing = plan.skipped_existing;
    let total = plan.files.len();

    for dir in &plan.dirs {
        if std::path::Path::new(dir).exists() {
            continue;
        }
        if let Err(e) = std::fs::create_dir_all(dir) {
            out.warnings.push(format!("建目录 {} 失败：{}", dir, e));
        }
    }
    out.created_dirs = plan.dirs.clone();

    for (index, file) in plan.files.iter().enumerate() {
        let mut done = false;
        if plan.link_supported {
            match std::fs::hard_link(&file.src, &file.dst) {
                Ok(()) => {
                    out.linked += 1;
                    out.bytes += file.size;
                    done = true;
                }
                Err(e) => {
                    // 跨盘符/不支持就降级：这一条仍然得进去，不能凭空丢图
                    out.warnings.push(format!(
                        "「{}」硬链接失败（{}），已改为复制",
                        file.dst.display(),
                        e
                    ));
                }
            }
        }
        if !done {
            match std::fs::copy(&file.src, &file.dst) {
                Ok(size) => {
                    out.copied += 1;
                    out.bytes += size;
                    done = true;
                }
                Err(e) => {
                    out.warnings.push(format!(
                        "复制「{}」失败：{}（该图没有进图库，重跑会再试一次）",
                        file.dst.display(),
                        e
                    ));
                }
            }
        }
        if done {
            out.files.push(TakeoverFile {
                path: normalize_path(&file.dst.to_string_lossy()),
                width: file.width,
                height: file.height,
            });
        } else {
            out.failed += 1;
        }
        if let Some(cb) = progress {
            cb(index + 1, total);
        }
    }
    out
}

/// 把搬运结果写进 `file_index`（目录行 + 图片行），这样**不等重新扫描**就能在网格里看到。
///
/// 与 scanner 用的是同一张表和同一个 `generate_id(path)`；宽高三联取自 Eagle 的条目维度，
/// 省掉一次后台解图；`file_type` / `size` / 时间戳取自真文件系统。
pub fn index_takeover(conn: &mut Connection, outcome: &TakeoverOutcome) -> Res<u32> {
    if outcome.files.is_empty() {
        return Ok(0);
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let id_of_path = |path: &str| -> String { generate_id(path) };
    let existing_id = |path: &str| -> Option<String> {
        conn.query_row(
            "SELECT file_id FROM file_index WHERE path = ?1",
            [path],
            |row| row.get::<_, String>(0),
        )
        .ok()
    };

    let mut entries: Vec<FileIndexEntry> = Vec::new();
    for dir in &outcome.created_dirs {
        let file_id = id_of_path(dir);
        let parent_id = Path::new(dir)
            .parent()
            .map(|p| normalize_path(&p.to_string_lossy()))
            .and_then(|p| existing_id(&p).or_else(|| Some(id_of_path(&p))));
        let meta = std::fs::metadata(dir).ok();
        let name = Path::new(dir)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        entries.push(FileIndexEntry {
            file_id,
            parent_id,
            path: normalize_path(dir),
            name,
            file_type: "Folder".to_string(),
            size: 0,
            created_at: meta
                .as_ref()
                .and_then(|m| m.created().ok())
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))
                .unwrap_or(now),
            modified_at: meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))
                .unwrap_or(now),
            width: None,
            height: None,
            format: None,
        });
    }

    for file in &outcome.files {
        let meta = std::fs::metadata(&file.path).ok();
        let name = Path::new(&file.path)
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let format = Path::new(&file.path)
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_lowercase());
        let parent_path = Path::new(&file.path)
            .parent()
            .map(|p| normalize_path(&p.to_string_lossy()))
            .unwrap_or_default();
        let parent_id = if parent_path.is_empty() {
            None
        } else {
            existing_id(&parent_path).or_else(|| Some(id_of_path(&parent_path)))
        };
        entries.push(FileIndexEntry {
            file_id: id_of_path(&file.path),
            parent_id,
            path: normalize_path(&file.path),
            name,
            file_type: "Image".to_string(),
            size: meta.as_ref().map(|m| m.len()).unwrap_or(0),
            created_at: meta
                .as_ref()
                .and_then(|m| m.created().ok())
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))
                .unwrap_or(now),
            modified_at: meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0))
                .unwrap_or(now),
            width: file.width,
            height: file.height,
            format,
        });
    }

    let count = entries.len() as u32;
    crate::db::file_index::batch_upsert(conn, &entries).map_err(|e| e.to_string())?;
    Ok(count)
}
