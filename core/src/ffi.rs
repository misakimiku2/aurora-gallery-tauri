//! UniFFI 导出的数据层接口（Kotlin 端直调）。
//!
//! M4a 0.1：除 `db_commands.rs` 已覆盖的桌面 command 外，把只依赖 `AppDbPool` 的
//! 人物 / 专题 / 文件元数据原语导出给 Kotlin。
//!
//! DTO 约定（见 `docs/Android/Kotlin版/M4a数据与整理任务清单.md` 0.1）：
//! - 不给 `db::` 结构体加 `uniffi::Record` 派生——`serde_json::Value` 与 `usize`
//!   都不是 UniFFI 类型，且改字段类型会动到 React 侧的 serde 契约；
//! - `ai_data` 透传原始 JSON 文本，不解析；
//! - 一律 `i64` 替代 `usize`（`u64` 会映射成 Kotlin `ULong`，和既有 DTO 的 `i64` 打架）；
//! - **标签不在 `FfiFileMetadata` 里**：D10=② 之后它的真源是 `tags` / `file_tags` 两张表，
//!   走 `set_file_tags` 一族（`db/tags.rs`），元数据那一列在安卓侧不再写。

use crate::collate;
use crate::db::{self, file_index, AppDbPool};
use crate::db::file_index::FileIndexEntry;
use std::collections::HashMap;
use std::sync::OnceLock;

static DB_POOL: OnceLock<AppDbPool> = OnceLock::new();

fn pool() -> &'static AppDbPool {
    DB_POOL.get().expect("数据库未初始化，请先调用 initDb")
}

/// 媒体库接口错误。
#[derive(Debug, thiserror::Error, uniffi::Error)]
pub enum AuroraError {
    #[error("数据库错误: {0}")]
    Database(String),
    #[error("缩略图生成错误: {0}")]
    Thumbnail(String),
}

fn db_err(e: rusqlite::Error) -> AuroraError {
    AuroraError::Database(e.to_string())
}

/// 一张 MediaStore 图片的原始信息（Kotlin 扫描后传入）。
#[derive(uniffi::Record)]
pub struct MediaImage {
    pub id: i64,
    pub content_uri: String,
    pub path: String,
    pub name: String,
    pub size: i64,
    pub date_added: i64,
    pub date_modified: i64,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub mime_type: String,
    pub bucket_id: String,
    pub bucket_name: String,
}

/// 文件夹（MediaStore bucket）。
#[derive(uniffi::Record)]
pub struct Folder {
    pub id: String,
    pub name: String,
    /// 该文件夹下图片数量（用于卡片角标）。
    pub image_count: i64,
    /// 封面图 content_uri（取该文件夹下最新一张图），无图时为 None。
    pub cover_uri: Option<String>,
    /// 最早一张子图的创建时间（epoch 秒；无图 = 0）。总览的日期排序与「创建时间」
    /// 日期筛选用（对齐 React 总览按 folder.createdAt 排序的语义）。
    pub created_at: i64,
    /// 最新一张子图的修改时间（epoch 秒；无图 = 0）。总览「修改时间」日期筛选用
    /// （该时间落在区间内 ⟺ 文件夹最近一次更新在区间内）。
    pub modified_at: i64,
}

/// 图片。
///
/// `size` / `created_at` / `format` 供 2.3 分组标题使用（分组规则对齐 React 版
/// `useFileSearch.ts`：`type` 取 `format.toUpperCase()`，`date` 取 `created_at` 的
/// `YYYY-MM`）；`modified_at` 是列表排序基准（`list_images` 的 ORDER BY 字段）。
#[derive(uniffi::Record)]
pub struct Image {
    pub id: String,
    pub name: String,
    pub content_uri: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    /// 文件大小（字节），列表模式展示用。
    pub size: i64,
    /// 添加时间（Unix 秒），date 分组用。
    pub created_at: i64,
    /// 修改时间（Unix 秒），列表排序基准。
    pub modified_at: i64,
    /// MIME 子类型（jpeg / png / webp…），type 分组用。
    pub format: Option<String>,
}

/// `db::persons::FaceBox` 的 FFI 镜像。
#[derive(uniffi::Record)]
pub struct FfiFaceBox {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

/// `db::persons::Person` 的 FFI 镜像。
#[derive(uniffi::Record)]
pub struct FfiPerson {
    pub id: String,
    pub name: String,
    pub cover_file_id: String,
    pub count: i32,
    pub description: Option<String>,
    pub face_box: Option<FfiFaceBox>,
    pub updated_at: Option<i64>,
    pub character_tag_name: Option<String>,
    pub character_tag_index: Option<i32>,
}

impl From<db::persons::Person> for FfiPerson {
    fn from(p: db::persons::Person) -> Self {
        FfiPerson {
            id: p.id,
            name: p.name,
            cover_file_id: p.cover_file_id,
            count: p.count,
            description: p.description,
            face_box: p.face_box.map(|b| FfiFaceBox { x: b.x, y: b.y, w: b.w, h: b.h }),
            updated_at: p.updated_at,
            character_tag_name: p.character_tag_name,
            character_tag_index: p.character_tag_index,
        }
    }
}

impl From<FfiPerson> for db::persons::Person {
    fn from(p: FfiPerson) -> Self {
        db::persons::Person {
            id: p.id,
            name: p.name,
            cover_file_id: p.cover_file_id,
            count: p.count,
            description: p.description,
            face_box: p.face_box.map(|b| db::persons::FaceBox { x: b.x, y: b.y, w: b.w, h: b.h }),
            updated_at: p.updated_at,
            character_tag_name: p.character_tag_name,
            character_tag_index: p.character_tag_index,
        }
    }
}

/// `db::topics::CoverCropData` 的 FFI 镜像。
#[derive(uniffi::Record)]
pub struct FfiCoverCrop {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// `db::topics::Topic` 的 FFI 镜像。
///
/// UniFFI 不看 serde 属性，Kotlin 侧字段名是 `topicType`（React 拿到的是 `type`）。
/// 列表查询里 `file_ids` / `people_ids` 恒为空（懒加载），计数请用 `file_count`。
#[derive(uniffi::Record)]
pub struct FfiTopic {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub description: Option<String>,
    pub topic_type: Option<String>,
    pub cover_file_id: Option<String>,
    pub background_file_id: Option<String>,
    pub cover_crop: Option<FfiCoverCrop>,
    pub people_ids: Vec<String>,
    pub file_ids: Vec<String>,
    pub source_url: Option<String>,
    pub created_at: Option<i64>,
    pub updated_at: Option<i64>,
    pub source_type: Option<String>,
    pub work_name: Option<String>,
    pub work_name_cn: Option<String>,
    pub file_count: i32,
}

impl From<db::topics::Topic> for FfiTopic {
    fn from(t: db::topics::Topic) -> Self {
        FfiTopic {
            id: t.id,
            parent_id: t.parent_id,
            name: t.name,
            description: t.description,
            topic_type: t.topic_type,
            cover_file_id: t.cover_file_id,
            background_file_id: t.background_file_id,
            cover_crop: t.cover_crop.map(|c| FfiCoverCrop {
                x: c.x,
                y: c.y,
                width: c.width,
                height: c.height,
            }),
            people_ids: t.people_ids,
            file_ids: t.file_ids,
            source_url: t.source_url,
            created_at: t.created_at,
            updated_at: t.updated_at,
            source_type: t.source_type,
            work_name: t.work_name,
            work_name_cn: t.work_name_cn,
            file_count: t.file_count,
        }
    }
}

impl From<FfiTopic> for db::topics::Topic {
    fn from(t: FfiTopic) -> Self {
        db::topics::Topic {
            id: t.id,
            parent_id: t.parent_id,
            name: t.name,
            description: t.description,
            topic_type: t.topic_type,
            cover_file_id: t.cover_file_id,
            background_file_id: t.background_file_id,
            cover_crop: t.cover_crop.map(|c| db::topics::CoverCropData {
                x: c.x,
                y: c.y,
                width: c.width,
                height: c.height,
            }),
            people_ids: t.people_ids,
            file_ids: t.file_ids,
            source_url: t.source_url,
            created_at: t.created_at,
            updated_at: t.updated_at,
            source_type: t.source_type,
            work_name: t.work_name,
            work_name_cn: t.work_name_cn,
            file_count: t.file_count,
        }
    }
}

/// `db::topics::PaginatedFiles` 的 FFI 镜像。
///
/// `usize` 不是 UniFFI 类型；这里用 `i64` 而不是 `u64`，因为 UniFFI 把 `u64` 映射成
/// Kotlin 的 `ULong`（与 `Long` 混用得手动转换），而本文件既有 DTO 的计数/尺寸一律 `i64`。
#[derive(uniffi::Record)]
pub struct FfiPaginatedFiles {
    pub files: Vec<String>,
    pub total: i64,
    pub has_more: bool,
}

/// `db::file_metadata::FileMetadata` 的 FFI 镜像。
///
/// `tags` 列在库里是 JSON 文本，DTO 里收成 `Vec<String>`；非法值按空处理。
/// `ai_data` 只透传原始 JSON 文本，M4a 不解析。
#[derive(uniffi::Record)]
pub struct FfiFileMetadata {
    pub file_id: String,
    pub path: String,
    pub description: Option<String>,
    pub source_url: Option<String>,
    pub ai_data: Option<String>,
    pub category: Option<String>,
    pub updated_at: Option<i64>,
}

/// 一个文件当前的标签集合（顺序即 UI 显示顺序）。
#[derive(uniffi::Record)]
pub struct FileTags {
    pub file_id: String,
    pub tags: Vec<String>,
}

impl From<db::file_metadata::FileMetadata> for FfiFileMetadata {
    fn from(m: db::file_metadata::FileMetadata) -> Self {
        FfiFileMetadata {
            file_id: m.file_id,
            path: m.path,
            description: m.description,
            source_url: m.source_url,
            ai_data: m.ai_data.map(|v| v.to_string()),
            category: m.category,
            updated_at: m.updated_at,
        }
    }
}

impl From<FfiFileMetadata> for db::file_metadata::FileMetadata {
    fn from(m: FfiFileMetadata) -> Self {
        db::file_metadata::FileMetadata {
            file_id: m.file_id,
            path: m.path,
            // 标签的真源是 file_tags（D10=②），这一列安卓侧不写；置 None 以免
            // 整行 upsert 把别处写过的 JSON 值带回来当第二份数据。
            tags: None,
            description: m.description,
            source_url: m.source_url,
            ai_data: m.ai_data.as_deref().and_then(|s| serde_json::from_str(s).ok()),
            category: m.category,
            updated_at: m.updated_at,
        }
    }
}

/// 一个标签 + 它贴在多少张图上。计数为 0 = 只在词表里、还没贴到任何文件上。
#[derive(uniffi::Record)]
pub struct TagEntry {
    pub tag: String,
    pub count: i64,
}

/// 侧栏的一个标签分组。
///
/// 顺序（组的先后、组内标签的先后）全由 Rust 定，UI 侧不许再排 —— 见 M4a 清单 §1
/// 「排序规则只许有一套」。用 `Vec` 而不是 `Map`：Kotlin 的 `Map` 不保序。
#[derive(uniffi::Record)]
pub struct TagGroup {
    pub key: String,
    pub tags: Vec<TagEntry>,
}

/// 初始化数据库（Kotlin 端启动时调用，指向 filesDir 下的 db 文件）。
#[uniffi::export]
pub fn init_db(path: String) -> Result<(), AuroraError> {
    let p = AppDbPool::new(&path).map_err(AuroraError::Database)?;
    let _ = DB_POOL.set(p);
    Ok(())
}

/// 把 Kotlin 扫描的 MediaStore 图片写入索引（按 bucket 聚合出文件夹）。
///
/// 传入的是设备当前的全量快照，写入走 `reconcile_mediastore_snapshot`：
/// 快照外的 Folder/Image 行（被删除/改名的相册、已消失的图片）在同一事务里清除，
/// 索引不再只增不减。
#[uniffi::export]
pub fn upsert_media_images(images: Vec<MediaImage>) -> Result<(), AuroraError> {
    let p = pool();
    let mut guard = p.get_connection();
    let conn: &mut rusqlite::Connection = &mut *guard;

    // 聚合 bucket_id -> (bucket_name, folder_path)
    let mut bucket_info: HashMap<String, (String, String)> = HashMap::new();
    for img in &images {
        let dir = img
            .path
            .rsplit_once('/')
            .map(|(d, _)| d.to_string())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| img.bucket_name.clone());
        bucket_info
            .entry(img.bucket_id.clone())
            .or_insert((img.bucket_name.clone(), dir));
    }

    let folder_entries: Vec<FileIndexEntry> = bucket_info
        .iter()
        .map(|(bid, (name, path))| FileIndexEntry {
            file_id: db::generate_id(bid),
            parent_id: None,
            path: path.clone(),
            name: name.clone(),
            file_type: "Folder".into(),
            size: 0,
            created_at: 0,
            modified_at: 0,
            width: None,
            height: None,
            format: None,
        })
        .collect();

    let image_entries: Vec<FileIndexEntry> = images
        .iter()
        .map(|img| FileIndexEntry {
            file_id: db::generate_id(&img.content_uri),
            parent_id: Some(db::generate_id(&img.bucket_id)),
            path: img.content_uri.clone(),
            name: img.name.clone(),
            file_type: "Image".into(),
            size: img.size.max(0) as u64,
            created_at: img.date_added,
            modified_at: img.date_modified,
            width: img.width.map(|v| v as u32),
            height: img.height.map(|v| v as u32),
            format: img.mime_type.split('/').nth(1).map(|s| s.to_string()),
        })
        .collect();

    file_index::reconcile_mediastore_snapshot(conn, &folder_entries, &image_entries)
        .map_err(db_err)
}

/// 列出所有文件夹（bucket）。
#[uniffi::export]
pub fn list_folders() -> Vec<Folder> {
    let p = pool();
    let guard = p.get_connection();
    let conn = &*guard;

    let mut stmt = conn
        .prepare(
            "SELECT f.file_id, f.name,
                    (SELECT COUNT(*) FROM file_index i WHERE i.parent_id = f.file_id AND i.file_type = 'Image'),
                    (SELECT i.path FROM file_index i WHERE i.parent_id = f.file_id AND i.file_type = 'Image' ORDER BY i.modified_at DESC LIMIT 1),
                    (SELECT MIN(i.created_at) FROM file_index i WHERE i.parent_id = f.file_id AND i.file_type = 'Image'),
                    (SELECT MAX(i.modified_at) FROM file_index i WHERE i.parent_id = f.file_id AND i.file_type = 'Image')
             FROM file_index f WHERE f.file_type = 'Folder' ORDER BY f.name",
        )
        .expect("prepare list_folders");
    let rows = stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                image_count: row.get(2)?,
                cover_uri: row.get(3)?,
                // 无子图的文件夹 MIN/MAX 为 NULL → 0（Kotlin 端按「无日期」处理）
                created_at: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                modified_at: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
            })
        })
        .expect("query list_folders");

    rows.filter_map(|r| r.ok()).collect()
}

/// 列出指定文件夹下的图片。
#[uniffi::export]
pub fn list_images(folder_id: String) -> Vec<Image> {
    let p = pool();
    let guard = p.get_connection();
    let conn = &*guard;

    let mut stmt = conn
        .prepare(
            "SELECT file_id, name, path, width, height, size, created_at, modified_at, format \
             FROM file_index \
             WHERE parent_id = ?1 AND file_type = 'Image' ORDER BY modified_at DESC",
        )
        .expect("prepare list_images");
    let rows = stmt
        .query_map([&folder_id], |row| {
            Ok(Image {
                id: row.get(0)?,
                name: row.get(1)?,
                content_uri: row.get(2)?,
                width: row.get(3)?,
                height: row.get(4)?,
                size: row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                created_at: row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                modified_at: row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                format: row.get(8)?,
            })
        })
        .expect("query list_images");

    rows.filter_map(|r| r.ok()).collect()
}

/// 缩略图目标尺寸（最长边，像素）。
const THUMBNAIL_SIZE: u32 = 256;

/// 按标签取图片行（M4a 4.1：侧栏点一个标签 = 筛出该标签下的全部图，跨文件夹）。
///
/// 为什么要在 Rust 侧多开这一条：安卓的 `list_images` 只按文件夹取，而侧栏标签上的
/// 计数（`get_grouped_tags`）是全库口径。只筛当前文件夹的话，徽标写 5、点进来剩 2 张，
/// 这两个数在同一屏上自相矛盾。
///
/// 并集 / 只认 Image / `modified_at DESC` 三条语义都在 `db::tags::images_with_any_tag`，
/// 那里带单测；这里只做 DTO 搬运。
#[uniffi::export]
pub fn list_images_by_tags(tags: Vec<String>) -> Result<Vec<Image>, AuroraError> {
    let conn = pool().get_connection();
    let rows = db::tags::images_with_any_tag(&conn, &tags).map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(|e| Image {
            id: e.file_id,
            name: e.name,
            content_uri: e.path,
            width: e.width,
            height: e.height,
            size: e.size as i64,
            created_at: e.created_at,
            modified_at: e.modified_at,
            format: e.format,
        })
        .collect())
}

/// 按 id 集合取图片（M4a 3.2）。顺序/缺行/只认 Image 的语义在
/// `db::file_index::images_by_ids`（那里有注释），这里只做 DTO 搬运。
/// 消费方：专题详情网格（`getTopicFiles` 的成员 id 补齐成 Image）与专题封面。
#[uniffi::export]
pub fn list_images_by_ids(file_ids: Vec<String>) -> Result<Vec<Image>, AuroraError> {
    let conn = pool().get_connection();
    let rows = db::file_index::images_by_ids(&conn, &file_ids).map_err(db_err)?;
    Ok(rows
        .into_iter()
        .map(|e| Image {
            id: e.file_id,
            name: e.name,
            content_uri: e.path,
            width: e.width,
            height: e.height,
            size: e.size as i64,
            created_at: e.created_at,
            modified_at: e.modified_at,
            format: e.format,
        })
        .collect())
}

/// 用 Rust 解码原图字节生成 JPEG 缩略图（最长边 256px，保持宽高比）。
///
/// 用于「MINI_KIND 系统缩略图尺寸不足」时的兜底升级：Kotlin 端读取
/// `content://` 原图字节后传入，返回 JPEG 字节供缓存与显示。
#[uniffi::export]
pub fn generate_thumbnail(data: Vec<u8>) -> Result<Vec<u8>, AuroraError> {
    let img = image::load_from_memory(&data)
        .map_err(|e| AuroraError::Thumbnail(format!("解码失败: {e}")))?;
    let thumb = img.thumbnail(THUMBNAIL_SIZE, THUMBNAIL_SIZE);
    let mut cursor = std::io::Cursor::new(Vec::new());
    thumb
        .write_to(&mut cursor, image::ImageFormat::Jpeg)
        .map_err(|e| AuroraError::Thumbnail(format!("编码失败: {e}")))?;
    Ok(cursor.into_inner())
}

// ===== 人物（对应 db_commands.rs 的 4 个 command）=====

#[uniffi::export]
pub fn get_all_people() -> Result<Vec<FfiPerson>, AuroraError> {
    let conn = pool().get_connection();
    db::persons::get_all_people(&conn)
        .map(|v| v.into_iter().map(FfiPerson::from).collect())
        .map_err(db_err)
}

#[uniffi::export]
pub fn upsert_person(person: FfiPerson) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::persons::upsert_person(&conn, &person.into()).map_err(db_err)
}

#[uniffi::export]
pub fn delete_person(id: String) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::persons::delete_person(&conn, &id).map_err(db_err)
}

#[uniffi::export]
pub fn update_person_avatar(
    person_id: String,
    cover_file_id: String,
    face_box: Option<FfiFaceBox>,
) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    let box_ref = face_box
        .map(|b| db::persons::FaceBox { x: b.x, y: b.y, w: b.w, h: b.h });
    db::persons::update_person_avatar(&conn, &person_id, &cover_file_id, box_ref.as_ref())
        .map_err(db_err)
}

// ===== 专题（对应 db_commands.rs 的 14 个 command）=====

#[uniffi::export]
pub fn get_all_topics() -> Result<Vec<FfiTopic>, AuroraError> {
    let conn = pool().get_connection();
    db::topics::get_all_topics(&conn)
        .map(|v| v.into_iter().map(FfiTopic::from).collect())
        .map_err(db_err)
}

#[uniffi::export]
pub fn upsert_topic(topic: FfiTopic) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::topics::upsert_topic(&conn, &topic.into()).map_err(db_err)
}

#[uniffi::export]
pub fn delete_topic(id: String) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::topics::delete_topic(&conn, &id).map_err(db_err)
}

#[uniffi::export]
pub fn get_topic_files(topic_id: String) -> Result<Vec<String>, AuroraError> {
    let conn = pool().get_connection();
    db::topics::get_topic_files(&conn, &topic_id).map_err(db_err)
}

/// UniFFI 不认 `usize`，分页参数走 `i64`；负数按 0 处理。
fn as_index(v: i64) -> usize {
    v.max(0) as usize
}

#[uniffi::export]
pub fn get_topic_files_paginated(
    topic_id: String,
    offset: i64,
    limit: i64,
) -> Result<FfiPaginatedFiles, AuroraError> {
    let conn = pool().get_connection();
    let page = db::topics::get_topic_files_paginated(
        &conn,
        &topic_id,
        as_index(offset),
        as_index(limit),
    )
    .map_err(db_err)?;
    Ok(FfiPaginatedFiles {
        files: page.files,
        total: page.total as i64,
        has_more: page.has_more,
    })
}

#[uniffi::export]
pub fn get_topic_cover_previews(
    topic_ids: Vec<String>,
    preview_count: i64,
) -> Result<HashMap<String, Vec<String>>, AuroraError> {
    let conn = pool().get_connection();
    db::topics::get_topic_cover_previews(&conn, &topic_ids, as_index(preview_count))
        .map_err(db_err)
}

#[uniffi::export]
pub fn find_topics_containing_file(file_id: String) -> Result<Vec<String>, AuroraError> {
    let conn = pool().get_connection();
    db::topics::find_topics_containing_file(&conn, &file_id).map_err(db_err)
}

#[uniffi::export]
pub fn set_topic_files(topic_id: String, file_ids: Vec<String>) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::topics::set_topic_files(&conn, &topic_id, &file_ids).map_err(db_err)
}

#[uniffi::export]
pub fn add_files_to_topic(topic_id: String, file_ids: Vec<String>) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::topics::add_files_to_topic(&conn, &topic_id, &file_ids).map_err(db_err)
}

#[uniffi::export]
pub fn remove_file_from_topic(topic_id: String, file_id: String) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::topics::remove_file_from_topic(&conn, &topic_id, &file_id).map_err(db_err)
}

#[uniffi::export]
pub fn get_topic_people(topic_id: String) -> Result<Vec<String>, AuroraError> {
    let conn = pool().get_connection();
    db::topics::get_topic_people(&conn, &topic_id).map_err(db_err)
}

#[uniffi::export]
pub fn set_topic_people(topic_id: String, people_ids: Vec<String>) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::topics::set_topic_people(&conn, &topic_id, &people_ids).map_err(db_err)
}

#[uniffi::export]
pub fn add_people_to_topic(topic_id: String, people_ids: Vec<String>) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::topics::add_people_to_topic(&conn, &topic_id, &people_ids).map_err(db_err)
}

#[uniffi::export]
pub fn remove_person_from_topic(topic_id: String, people_id: String) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::topics::remove_person_from_topic(&conn, &topic_id, &people_id).map_err(db_err)
}

// ===== 文件元数据 =====

#[uniffi::export]
pub fn upsert_file_metadata(metadata: FfiFileMetadata) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::file_metadata::upsert_file_metadata(&conn, &metadata.into()).map_err(db_err)
}

#[uniffi::export]
pub fn get_all_file_metadata() -> Result<Vec<FfiFileMetadata>, AuroraError> {
    let conn = pool().get_connection();
    db::file_metadata::get_all_metadata(&conn)
        .map(|v| v.into_iter().map(FfiFileMetadata::from).collect())
        .map_err(db_err)
}

/// 按 id 读单条元数据；不存在返回 `null`（桌面走的是「全表拉进内存」，
/// Kotlin 侧的先读后写必须要这条，见 M4a 清单 0.1）。
///
/// 不含标签——标签走 `get_file_tags`。
#[uniffi::export]
pub fn get_file_metadata(file_id: String) -> Result<Option<FfiFileMetadata>, AuroraError> {
    let conn = pool().get_connection();
    db::file_metadata::get_metadata_by_id(&conn, &file_id)
        .map(|v| v.map(FfiFileMetadata::from))
        .map_err(db_err)
}

// ===== 标签（M4a 1.1：真源是 tags / file_tags，见 db/tags.rs）=====

/// 设置某张图的标签集合（整体替换）。词表由 Rust 维护，Kotlin 侧不拼任何 JSON。
#[uniffi::export]
pub fn set_file_tags(file_id: String, tags: Vec<String>) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::tags::set_file_tags(&conn, &file_id, &tags).map_err(db_err)
}

/// 批量贴标签（长按菜单 / 选择栏「更多」的粘贴），单事务。
#[uniffi::export]
pub fn add_tags_to_files(file_ids: Vec<String>, tags: Vec<String>) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::tags::add_tags_to_files(&conn, &file_ids, &tags).map_err(db_err)
}

#[uniffi::export]
pub fn get_file_tags(file_id: String) -> Result<Vec<String>, AuroraError> {
    let conn = pool().get_connection();
    db::tags::get_file_tags(&conn, &file_id).map_err(db_err)
}

#[uniffi::export]
pub fn get_files_by_tag(tag: String) -> Result<Vec<String>, AuroraError> {
    let conn = pool().get_connection();
    db::tags::get_files_by_tag(&conn, &tag).map_err(db_err)
}

/// 全量「文件 → 标签」映射：标签过滤（4.1）与一致性对照（1.3）的输入。
#[uniffi::export]
pub fn get_all_file_tags() -> Result<Vec<FileTags>, AuroraError> {
    let conn = pool().get_connection();
    db::tags::get_all_file_tags(&conn)
        .map(|v| v.into_iter().map(|(file_id, tags)| FileTags { file_id, tags }).collect())
        .map_err(db_err)
}

/// 侧栏标签分组 + 计数。`locale` 是界面语言（`zh` / `en`），只影响组内次序。
///
/// 词表搜索（React 的 `tagSearchQuery`）留给 UI 侧：那是输入即时响应的过滤，
/// 不该每敲一个字过一次 FFI。
#[uniffi::export]
pub fn get_grouped_tags(locale: String) -> Result<Vec<TagGroup>, AuroraError> {
    let conn = pool().get_connection();
    let counts = db::tags::tag_counts(&conn).map_err(db_err)?;
    Ok(collate::group_tags(&counts, &locale)
        .into_iter()
        .map(|(key, items)| TagGroup {
            key,
            tags: items
                .into_iter()
                .map(|(tag, count)| TagEntry { tag, count })
                .collect(),
        })
        .collect())
}

/// 往词表里加一个词（不贴到任何文件上，计数 0）。
#[uniffi::export]
pub fn add_tag_to_vocabulary(tag: String) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::tags::add_tag_to_vocabulary(&conn, &tag).map_err(db_err)
}

/// 重命名并级联到词表与所有文件。桌面不落的库这里落（D14=修正）；
/// 会话态（当前筛选中的标签、选中的标签、各 tab 的搜索词）由 Kotlin 侧自己改。
#[uniffi::export]
pub fn rename_tag(old_tag: String, new_tag: String) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::tags::rename_tag(&conn, &old_tag, &new_tag).map_err(db_err)
}

/// 删除标签：词表 + 所有文件上的它，一个事务。
#[uniffi::export]
pub fn delete_tags(tags: Vec<String>) -> Result<(), AuroraError> {
    let conn = pool().get_connection();
    db::tags::delete_tags(&conn, &tags).map_err(db_err)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(tags: Option<serde_json::Value>) -> db::file_metadata::FileMetadata {
        db::file_metadata::FileMetadata {
            file_id: "f1".into(),
            path: "content://media/external/images/media/1".into(),
            tags,
            description: Some("一句描述".into()),
            source_url: Some("https://example.com".into()),
            ai_data: Some(serde_json::json!({"wd14": ["a", 1], "嵌套": {"k": [1, 2]}})),
            category: Some("插画".into()),
            updated_at: Some(1_700_000_000),
        }
    }

    /// 2.1 的先读后写要把这一行原样拼回去，任何一列在往返中变形都会在整行 upsert
    /// 时把用户数据写没。
    #[test]
    fn file_metadata_ffi_round_trip_keeps_every_column() {
        let original = row(None);
        let back: db::file_metadata::FileMetadata = FfiFileMetadata::from(original.clone()).into();

        assert_eq!(back.file_id, original.file_id);
        assert_eq!(back.path, original.path);
        assert_eq!(back.description, original.description);
        assert_eq!(back.source_url, original.source_url);
        assert_eq!(back.ai_data, original.ai_data);
        assert_eq!(back.category, original.category);
        assert_eq!(back.updated_at, original.updated_at);
    }

    /// 标签的真源已搬到 `file_tags`。旧的 `file_metadata.tags` 列既不读出也不写回，
    /// 免得留第二份数据——这条把该行为钉住。
    #[test]
    fn legacy_json_tags_column_is_never_read_or_written() {
        let original = row(Some(serde_json::json!(["旧列里的", "标签"])));
        let ffi = FfiFileMetadata::from(original);
        let back: db::file_metadata::FileMetadata = ffi.into();
        assert_eq!(back.tags, None);
    }

    /// `ai_data` 只透传不解析：M4a 不读它的结构，但必须原样带回。
    #[test]
    fn ai_data_survives_as_opaque_json_text() {
        let original = row(None);
        let ffi = FfiFileMetadata::from(original.clone());
        let text = ffi.ai_data.clone().expect("ai_data should pass through");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&text).unwrap(),
            original.ai_data.unwrap()
        );
    }
}
