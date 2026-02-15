use rusqlite::{params, Connection, Result};
use std::path::Path;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileIndexEntry {
    pub file_id: String,
    pub parent_id: Option<String>,
    pub path: String,
    pub name: String,
    pub file_type: String, // "Image", "Folder", "Unknown"
    pub size: u64,
    pub created_at: i64,
    pub modified_at: i64,
    // Image specific
    pub width: Option<u32>,
    pub height: Option<u32>,
    pub format: Option<String>,
}

pub fn create_table(conn: &Connection) -> Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS file_index (
            file_id TEXT PRIMARY KEY,
            parent_id TEXT,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            file_type TEXT NOT NULL,
            size INTEGER DEFAULT 0,
            created_at INTEGER DEFAULT 0,
            modified_at INTEGER DEFAULT 0,
            width INTEGER,
            height INTEGER,
            format TEXT
        )",
        [],
    )?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_index_path ON file_index(path)",
        [],
    )?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_index_parent ON file_index(parent_id)",
        [],
    )?;

    Ok(())
}

pub fn batch_upsert(conn: &mut Connection, entries: &[FileIndexEntry]) -> Result<()> {
    let tx = conn.transaction()?;
    
    {
        let mut stmt = tx.prepare(
            "INSERT INTO file_index (
                file_id, parent_id, path, name, file_type, size, 
                created_at, modified_at, width, height, format
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
            ON CONFLICT(file_id) DO UPDATE SET
                parent_id = excluded.parent_id,
                path = excluded.path,
                name = excluded.name,
                file_type = excluded.file_type,
                size = excluded.size,
                created_at = excluded.created_at,
                modified_at = excluded.modified_at,
                width = excluded.width,
                height = excluded.height,
                format = excluded.format"
        )?;

        for entry in entries {
            stmt.execute(params![
                entry.file_id,
                entry.parent_id,
                entry.path,
                entry.name,
                entry.file_type,
                entry.size,
                entry.created_at,
                entry.modified_at,
                entry.width,
                entry.height,
                entry.format
            ])?;
        }
    }
    
    tx.commit()?;
    Ok(())
}

pub fn get_entries_under_path(conn: &Connection, root_path: &str) -> Result<Vec<FileIndexEntry>> {
    let pattern = format!("{}%", root_path);
    let mut stmt = conn.prepare("SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format FROM file_index WHERE path LIKE ?1")?;
    let rows = stmt.query_map(params![pattern], |row| {
        Ok(FileIndexEntry {
            file_id: row.get(0)?,
            parent_id: row.get(1)?,
            path: row.get(2)?,
            name: row.get(3)?,
            file_type: row.get(4)?,
            size: row.get(5)?,
            created_at: row.get(6)?,
            modified_at: row.get(7)?,
            width: row.get(8)?,
            height: row.get(9)?,
            format: row.get(10)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

pub fn get_all_entries(conn: &Connection) -> Result<Vec<FileIndexEntry>> {
    let mut stmt = conn.prepare("SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format FROM file_index")?;
    let rows = stmt.query_map([], |row| {
        Ok(FileIndexEntry {
            file_id: row.get(0)?,
            parent_id: row.get(1)?,
            path: row.get(2)?,
            name: row.get(3)?,
            file_type: row.get(4)?,
            size: row.get(5)?,
            created_at: row.get(6)?,
            modified_at: row.get(7)?,
            width: row.get(8)?,
            height: row.get(9)?,
            format: row.get(10)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

/// 获取所有图片文件（file_type = "Image"）
/// 用于 CLIP 嵌入向量生成
pub fn get_all_image_files(conn: &Connection) -> Result<Vec<FileIndexEntry>> {
    let mut stmt = conn.prepare(
        "SELECT file_id, parent_id, path, name, file_type, size, created_at, modified_at, width, height, format 
         FROM file_index 
         WHERE file_type = 'Image'"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(FileIndexEntry {
            file_id: row.get(0)?,
            parent_id: row.get(1)?,
            path: row.get(2)?,
            name: row.get(3)?,
            file_type: row.get(4)?,
            size: row.get(5)?,
            created_at: row.get(6)?,
            modified_at: row.get(7)?,
            width: row.get(8)?,
            height: row.get(9)?,
            format: row.get(10)?,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}

/// Lightweight query that only selects the minimal columns needed for UI-first-paint
/// (used to demonstrate/measure a fast-start strategy). Returns `FileIndexEntry` with
/// non-essential fields left empty to keep the shape consistent.
pub fn get_minimal_entries_under_path(conn: &Connection, root_path: &str) -> Result<Vec<FileIndexEntry>> {
    let pattern = format!("{}%", root_path);
    let mut stmt = conn.prepare("SELECT file_id, path, file_type, size, modified_at FROM file_index WHERE path LIKE ?1")?;
    let rows = stmt.query_map(params![pattern], |row| {
        Ok(FileIndexEntry {
            file_id: row.get(0)?,
            parent_id: None,
            path: row.get(1)?,
            name: String::new(),
            file_type: row.get(2)?,
            size: row.get(3)?,
            created_at: 0,
            modified_at: row.get(4)?,
            width: None,
            height: None,
            format: None,
        })
    })?;

    let mut entries = Vec::new();
    for row in rows {
        entries.push(row?);
    }
    Ok(entries)
}


#[cfg(test)]
mod bench_tests {
    use super::*;
    use rusqlite::Connection;
    use std::time::Instant;
    use std::fs;
    use std::env;

    #[test]
    fn bench_entries_fetch() {
        // 可通过环境变量 AURORA_BENCH_COUNT 调整样本大小（默认 68k）
        let n: usize = env::var("AURORA_BENCH_COUNT").ok().and_then(|s| s.parse().ok()).unwrap_or(68000);
        let tmpdir = env::temp_dir().join(format!("aurora_bench_{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmpdir);
        fs::create_dir_all(&tmpdir).unwrap();
        let db_path = tmpdir.join("bench.db");

        let mut conn = Connection::open(db_path).expect("open db");
        create_table(&conn).expect("create table");

        // 生成伪索引数据
        let mut entries = Vec::with_capacity(n);
        for i in 0..n {
            let path = format!("/bench/root/dir{}/file{}.jpg", i / 100, i);
            entries.push(FileIndexEntry {
                file_id: format!("id{}", i),
                parent_id: None,
                path: path.clone(),
                name: format!("file{}.jpg", i),
                file_type: "Image".into(),
                size: 1024,
                created_at: 0,
                modified_at: i as i64,
                width: Some(800),
                height: Some(600),
                format: Some("jpg".into()),
            });
        }

        // 批量写入（衡量写入成本不在此次基准主要关注点，但仍需要）
        batch_upsert(&mut conn, &entries).expect("batch upsert");

        // 测量当前（重字段）查询
        let t0 = Instant::now();
        let all = get_entries_under_path(&conn, "/bench/root").expect("get_entries_under_path");
        let dur_all = t0.elapsed();

        // 测量轻量查询
        let t1 = Instant::now();
        let minimal = get_minimal_entries_under_path(&conn, "/bench/root").expect("get_minimal_entries_under_path");
        let dur_min = t1.elapsed();

        println!("bench: inserted={}, get_entries_under_path -> {:?} (count={}), get_minimal -> {:?} (count={})", n, dur_all, all.len(), dur_min, minimal.len());

        assert_eq!(all.len(), minimal.len(), "row counts must match");

        // 清理
        let _ = fs::remove_dir_all(&tmpdir);
    }
}

pub fn delete_entries_by_ids(conn: &mut Connection, ids: &[String]) -> Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    
    let tx = conn.transaction()?;
    {
         for chunk in ids.chunks(900) {
             let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
             let sql = format!("DELETE FROM file_index WHERE file_id IN ({})", placeholders);
             let mut stmt = tx.prepare(&sql)?;
             stmt.execute(rusqlite::params_from_iter(chunk))?;
         }
    }
    tx.commit()?;
    Ok(())
}

pub fn delete_entries_by_path(conn: &Connection, path: &str) -> Result<()> {
    // 规范化路径
    let normalized_path = path.replace("\\", "/");
    
    // 删除记录
    conn.execute(
        "DELETE FROM file_index WHERE path = ? OR path LIKE ?",
        params![normalized_path, format!("{}/%", normalized_path.trim_end_matches('/'))],
    )?;
    
    Ok(())
}

pub fn delete_orphaned_entries(conn: &mut Connection, root_path: &str, existing_paths: &[String]) -> Result<usize> {
    use std::collections::HashSet;
    let tx = conn.transaction()?;
    
    let deleted_count = {
        // 1. 快速索引：将磁盘路径存入 HashSet，查找速度从 O(N) 变为 O(1)
        let existing_set: HashSet<&String> = existing_paths.iter().collect();

        // 2. 找出该目录下所有已经在数据库中的路径
        let pattern = format!("{}%", root_path);
        let mut stmt = tx.prepare("SELECT path FROM file_index WHERE path = ?1 OR path LIKE ?2")?;
        let db_paths: Vec<String> = stmt.query_map(params![root_path, pattern], |row| row.get(0))?
            .filter_map(|r| r.ok())
            .collect();
            
        // 3. 找出在数据库中但不在磁盘上的路径
        let to_delete: Vec<String> = db_paths.into_iter()
            .filter(|p| !existing_set.contains(p))
            .collect();
            
        let count = to_delete.len();
        
        // 分批删除
        for chunk in to_delete.chunks(900) {
            let placeholders = chunk.iter().map(|_| "?").collect::<Vec<_>>().join(",");
            let sql = format!("DELETE FROM file_index WHERE path IN ({})", placeholders);
            let mut stmt = tx.prepare(&sql)?;
            stmt.execute(rusqlite::params_from_iter(chunk))?;
        }
        count
    };
    
    tx.commit()?;
    Ok(deleted_count)
}

pub fn migrate_index_dir(conn: &Connection, old_path: &str, new_path: &str) -> Result<()> {
    let old_normalized = super::normalize_path(old_path);
    let new_normalized = super::normalize_path(new_path);
    
    // 找出新文件夹的名称
    let new_name = Path::new(&new_normalized)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_string();

    // 0. 清理目标路径及其子项的残留项（防止 UNIQUE 约束冲突）
    // 使用 lower() 确保大小写不敏感匹配，防止 abc -> ABC 这种重命名失败
    let new_dir_prefix_clean = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let new_dir_pattern = format!("{}%", new_dir_prefix_clean);
    conn.execute(
        "DELETE FROM file_index WHERE lower(path) = lower(?1) OR lower(path) LIKE lower(?2)",
        params![new_normalized, new_dir_pattern],
    )?;

    // 1. 更新顶层文件夹的路径和名称
    // ID 不变，ParentID 不变
    conn.execute(
        "UPDATE file_index SET path = ?1, name = ?2 WHERE path = ?3",
        params![new_normalized, new_name, old_normalized],
    )?;

    // 2. 批量更新子文件的路径 (Stable ID: ID and ParentID remain unchanged)
    // 使用 SQL 字符串拼接功能：new_path_prefix + SUBSTR(old_path, length(old_path_prefix) + 1)
    let old_dir_prefix = if old_normalized.ends_with('/') { old_normalized.clone() } else { format!("{}/", old_normalized) };
    let new_dir_prefix = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let dir_pattern = format!("{}%", old_dir_prefix);

    // SQLite SUBSTR starts at 1. We want to skip old_dir_prefix.
    // So if prefix char count is N, we want from N+1.
    // IMPORTANT: SUBSTR in SQLite uses character index, not byte index.
    let skip_len = (old_dir_prefix.chars().count() + 1) as i32;

    conn.execute(
        "UPDATE file_index SET path = ?1 || SUBSTR(path, ?2) WHERE path LIKE ?3",
        params![new_dir_prefix, skip_len, dir_pattern],
    )?;
    
    Ok(())
}
