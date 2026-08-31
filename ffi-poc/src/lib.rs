//! M0 PoC：验证「Kotlin 直调 Rust 核心」通信管道的载荷实现。
//!
//! 本 crate 只做一件事：读一个 SQLite 数据库，返回文件夹列表与指定文件夹下的图片列表。
//! 数据来自桌面版库导出的子集（poc-data.db），用于与导出源做快照对照。

use rusqlite::Connection;
use std::path::PathBuf;
use std::sync::OnceLock;

uniffi::setup_scaffolding!();

/// 数据库路径（默认指向 crate 目录下的 poc-data.db，S5 时由 Kotlin 端通过 `init` 覆盖为 filesDir 路径）。
static DB_PATH: OnceLock<PathBuf> = OnceLock::new();

fn db_path() -> PathBuf {
    DB_PATH
        .get()
        .cloned()
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("poc-data.db"))
}

fn open_db() -> Connection {
    Connection::open(db_path()).expect("无法打开 poc-data.db")
}

/// 设置数据库路径（S5 在安卓端启动时调用，指向 filesDir 下拷贝出的 poc-data.db）。
#[uniffi::export]
pub fn init(db_path: String) {
    let _ = DB_PATH.set(PathBuf::from(db_path));
}

/// 一个文件夹。
#[derive(uniffi::Record)]
pub struct Folder {
    pub id: String,
    pub name: String,
    pub path: String,
}

/// 一张图片的元数据。
#[derive(uniffi::Record)]
pub struct Image {
    pub id: String,
    pub name: String,
    pub path: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
}

/// 列出所有文件夹（file_type = 'Folder'）。
#[uniffi::export]
pub fn list_folders() -> Vec<Folder> {
    let conn = open_db();
    let mut stmt = conn
        .prepare("SELECT file_id, name, path FROM file_index WHERE file_type = 'Folder' ORDER BY path")
        .expect("prepare list_folders");

    let rows = stmt
        .query_map([], |row| {
            Ok(Folder {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
            })
        })
        .expect("query list_folders");

    let mut out = Vec::new();
    for r in rows {
        out.push(r.expect("row list_folders"));
    }
    out
}

/// 列出指定文件夹（folder_id）下的图片（file_type = 'Image'）。
#[uniffi::export]
pub fn list_images(folder_id: String) -> Vec<Image> {
    let conn = open_db();
    let mut stmt = conn
        .prepare(
            "SELECT file_id, name, path, width, height, format FROM file_index \
             WHERE parent_id = ?1 AND file_type = 'Image' ORDER BY modified_at DESC",
        )
        .expect("prepare list_images");

    let rows = stmt
        .query_map([&folder_id], |row| {
            Ok(Image {
                id: row.get(0)?,
                name: row.get(1)?,
                path: row.get(2)?,
                width: row.get(3)?,
                height: row.get(4)?,
                format: row.get(5)?,
            })
        })
        .expect("query list_images");

    let mut out = Vec::new();
    for r in rows {
        out.push(r.expect("row list_images"));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folders_are_non_empty() {
        let folders = list_folders();
        assert!(!folders.is_empty(), "poc-data.db 中应有文件夹");
        for f in &folders {
            assert!(!f.id.is_empty());
            assert!(!f.name.is_empty());
        }
    }

    #[test]
    fn images_belong_to_known_folders() {
        let folders = list_folders();
        let mut total = 0usize;
        for f in folders {
            let imgs = list_images(f.id);
            total += imgs.len();
        }
        // 3 个文件夹合计约 200 张图
        assert!(total >= 100, "子集图片数应接近 200，实际 {total}");
    }
}
