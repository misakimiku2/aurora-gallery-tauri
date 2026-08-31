//! UniFFI 导出的媒体库接口（Kotlin 端直调）。
//!
//! 数据流（M1 阶段 1，架构决策 D1=A）：
//!   Kotlin 用 ContentResolver 扫 MediaStore → 经 `upsert_media_images` 单向传入 Rust
//!   → Rust 写入 file_index（folder=MediaStore bucket，image 的 path 存 content_uri）
//!   → Kotlin 经 `list_folders` / `list_images` 查询展示。

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
}

/// 图片。
#[derive(uniffi::Record)]
pub struct Image {
    pub id: String,
    pub name: String,
    pub content_uri: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

/// 初始化数据库（Kotlin 端启动时调用，指向 filesDir 下的 db 文件）。
#[uniffi::export]
pub fn init_db(path: String) -> Result<(), AuroraError> {
    let p = AppDbPool::new(&path).map_err(AuroraError::Database)?;
    let _ = DB_POOL.set(p);
    Ok(())
}

/// 把 Kotlin 扫描的 MediaStore 图片写入索引（按 bucket 聚合出文件夹）。
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

    file_index::batch_upsert(conn, &folder_entries)
        .map_err(|e| AuroraError::Database(e.to_string()))?;
    file_index::batch_upsert(conn, &image_entries)
        .map_err(|e| AuroraError::Database(e.to_string()))?;
    Ok(())
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
                    (SELECT i.path FROM file_index i WHERE i.parent_id = f.file_id AND i.file_type = 'Image' ORDER BY i.modified_at DESC LIMIT 1)
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
            "SELECT file_id, name, path, width, height FROM file_index \
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
            })
        })
        .expect("query list_images");

    rows.filter_map(|r| r.ok()).collect()
}

/// 缩略图目标尺寸（最长边，像素）。
const THUMBNAIL_SIZE: u32 = 256;

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
