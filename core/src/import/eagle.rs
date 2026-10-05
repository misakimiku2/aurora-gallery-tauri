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
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use super::{
    existing_vocabulary, fill_if_empty, find_topic_by_name, is_indexable, merge_tag_lists,
    new_topic_id, AnnotationEdit, MigrationPlan, MigrationReport, OurIndex, TopicCreate, TrashItem,
};
use crate::db::file_metadata;
use crate::db::normalize_path;
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
    /// 磁盘 `imageCount`。**只在子节点上有**（§13.2 实测）；没有它就无法断言 → 跳过。
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
    Item {
        id: id.to_string(),
        has_entity: locate_entity(dir, &name, &ext),
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
fn locate_entity(dir: &Path, name: &str, ext: &str) -> bool {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return false;
    };
    let mut candidates: Vec<String> = Vec::new();
    for entry in entries.flatten() {
        if !entry.path().is_file() {
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
        candidates.push(file_name);
    }
    // ① 精确
    if !name.is_empty() && !ext.is_empty() && candidates.iter().any(|f| *f == format!("{}.{}", name, ext)) {
        return true;
    }
    // ② `<name>.*` 前缀（Windows 文件名大小写不敏感，回退层统一小写比）
    if !name.is_empty() {
        let prefix = format!("{}.", name.to_lowercase());
        if candidates.iter().any(|f| f.to_lowercase().starts_with(&prefix)) {
            return true;
        }
    }
    // ③ 目录内还有别的文件就算有实体（只判存在性——迁移不碰实体文件）
    !candidates.is_empty()
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
    let mut created = Vec::new();
    // source.folders 已是先序（父先于子，JSON 数组序）
    for node in &source.folders {
        let (parent_topic_id, reparented) = resolve_parent(
            &node.parent_id,
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
fn plan_smart_folders(
    source: &SourceData,
    our_conn: &Connection,
    matched_files: &HashMap<String, String>,
    eligible: &[&Item],
    report: &mut MigrationReport,
) -> Res<Vec<TopicCreate>> {
    let mut mapped: HashMap<String, Option<String>> = HashMap::new();
    let mut created = Vec::new();
    for node in &source.smart_folders {
        let recomputed = match select_members(&node.conditions, eligible) {
            Some(items) => items,
            None => {
                report.topics_skipped_unverifiable += 1;
                report.warnings.push(format!(
                    "智能夹「{}」的条件含未标定的 property/method/boolean，跳过不迁（P2b：只实现 type=equal 与 name=contain）",
                    node.name
                ));
                mapped.insert(node.id.clone(), None);
                continue;
            }
        };
        let Some(image_count) = node.image_count else {
            report.topics_skipped_unverifiable += 1;
            report.warnings.push(format!(
                "智能夹「{}」磁盘上没有 imageCount，无法做计数断言，跳过（P2b）",
                node.name
            ));
            mapped.insert(node.id.clone(), None);
            continue;
        };
        if recomputed.len() as i64 != image_count {
            report.topics_skipped_unverifiable += 1;
            report.warnings.push(format!(
                "智能夹「{}」复算得 {} 条 ≠ imageCount {}，计数断言不过，跳过（P2b；类型不支持的条目不在复算集里，源库含视频/字体/书签时会保守失败）",
                node.name,
                recomputed.len(),
                image_count
            ));
            mapped.insert(node.id.clone(), None);
            continue;
        }
        let member_file_ids: Vec<String> = recomputed
            .iter()
            .filter_map(|item| matched_files.get(&item.id).cloned())
            .collect();
        if member_file_ids.is_empty() {
            report.warnings.push(format!(
                "智能夹「{}」断言通过（{} 条）但没有一条命中我们的索引，不落空专题",
                node.name, image_count
            ));
            mapped.insert(node.id.clone(), None);
            continue;
        }

        let (parent_topic_id, reparented) = resolve_parent(
            &node.parent_id,
            |pid| {
                source
                    .smart_folders
                    .iter()
                    .find(|n| n.id == *pid)
                    .and_then(|n| n.parent_id.clone())
            },
            &mapped,
        );
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
            true,
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
    let existing_id =
        find_topic_by_name(our_conn, parent_topic_id.as_deref(), name).map_err(|e| e.to_string())?;
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
        id,
        name: name.to_string(),
        parent_id: parent_topic_id,
    })
}

#[cfg(test)]
mod tests;
