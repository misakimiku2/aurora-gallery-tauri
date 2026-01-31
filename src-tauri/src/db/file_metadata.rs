use rusqlite::{params, Connection, Result};
use serde::{Deserialize, Serialize};
use serde_json;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetadata {
    pub file_id: String,
    pub path: String,
    pub tags: Option<serde_json::Value>,
    pub description: Option<String>,
    pub source_url: Option<String>,
    pub ai_data: Option<serde_json::Value>,
    pub updated_at: Option<i64>,
}

pub fn upsert_file_metadata(conn: &Connection, metadata: &FileMetadata) -> Result<()> {
    conn.execute(
        "INSERT INTO file_metadata (file_id, path, tags, description, source_url, ai_data, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(file_id) DO UPDATE SET
            path = excluded.path,
            tags = excluded.tags,
            description = excluded.description,
            source_url = excluded.source_url,
            ai_data = excluded.ai_data,
            updated_at = excluded.updated_at",
        params![
            metadata.file_id,
            metadata.path,
            metadata.tags,
            metadata.description,
            metadata.source_url,
            metadata.ai_data,
            metadata.updated_at
        ],
    )?;
    Ok(())
}

pub fn get_metadata_by_id(conn: &Connection, file_id: &str) -> Result<Option<FileMetadata>> {
    let mut stmt = conn.prepare(
        "SELECT file_id, path, tags, description, source_url, ai_data, updated_at FROM file_metadata WHERE file_id = ?1"
    )?;
    
    let mut rows = stmt.query_map(params![file_id], |row| {
        Ok(FileMetadata {
            file_id: row.get(0)?,
            path: row.get(1)?,
            tags: row.get(2)?,
            description: row.get(3)?,
            source_url: row.get(4)?,
            ai_data: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;

    if let Some(result) = rows.next() {
        Ok(Some(result?))
    } else {
        Ok(None)
    }
}

pub fn get_all_metadata(conn: &Connection) -> Result<Vec<FileMetadata>> {
    let mut stmt = conn.prepare(
        "SELECT file_id, path, tags, description, source_url, ai_data, updated_at FROM file_metadata"
    )?;
    
    let metadata_iter = stmt.query_map([], |row| {
        Ok(FileMetadata {
            file_id: row.get(0)?,
            path: row.get(1)?,
            tags: row.get(2)?,
            description: row.get(3)?,
            source_url: row.get(4)?,
            ai_data: row.get(5)?,
            updated_at: row.get(6)?,
        })
    })?;

    let mut results = Vec::new();
    for item in metadata_iter {
        results.push(item?);
    }
    Ok(results)
}

pub fn delete_metadata_by_path(conn: &Connection, path: &str) -> Result<()> {
    let normalized_path = path.replace("\\", "/");
    
    // 删除单个文件元数据
    conn.execute(
        "DELETE FROM file_metadata WHERE path = ?",
        params![normalized_path],
    )?;
    
    // 如果是目录，递归删除
    let dir_pattern = format!("{}/%", normalized_path.trim_end_matches('/'));
    conn.execute(
        "DELETE FROM file_metadata WHERE path LIKE ?",
        params![dir_pattern],
    )?;
    
    Ok(())
}

pub fn migrate_metadata(conn: &Connection, old_id: &str, new_id: &str, new_path: &str) -> Result<()> {
    let normalized_path = new_path.replace("\\", "/");
    // 清理目标路径残留 (大小写不敏感)
    conn.execute(
        "DELETE FROM file_metadata WHERE lower(path) = lower(?1)",
        params![normalized_path],
    )?;
    conn.execute(
        "UPDATE file_metadata SET file_id = ?1, path = ?2 WHERE file_id = ?3",
        params![new_id, normalized_path, old_id],
    )?;
    Ok(())
}

pub fn copy_metadata(conn: &Connection, src_id: &str, dest_id: &str, dest_path: &str) -> Result<()> {
    let normalized_path = dest_path.replace("\\", "/");
    if let Some(mut meta) = get_metadata_by_id(conn, src_id)? {
        meta.file_id = dest_id.to_string();
        meta.path = normalized_path;
        upsert_file_metadata(conn, &meta)?;
    }
    Ok(())
}

pub fn migrate_metadata_dir(conn: &Connection, old_path: &str, new_path: &str) -> Result<()> {
    let old_normalized = super::normalize_path(old_path);
    let new_normalized = super::normalize_path(new_path);
    
    // 0. 清理目标路径残留 (大小写不敏感)
    let new_dir_prefix_clean = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let new_dir_pattern = format!("{}%", new_dir_prefix_clean);
    conn.execute(
        "DELETE FROM file_metadata WHERE lower(path) = lower(?1) OR lower(path) LIKE lower(?2)",
        params![new_normalized, new_dir_pattern],
    )?;

    // 1. 更新顶层文件夹 (如果有 metadata 的话)
    conn.execute(
        "UPDATE file_metadata SET path = ?1 WHERE path = ?2",
        params![new_normalized, old_normalized],
    )?;

    // 2. 批量更新子文件的路径 (Stable ID: ID remains unchanged)
    let old_dir_prefix = if old_normalized.ends_with('/') { old_normalized.clone() } else { format!("{}/", old_normalized) };
    let new_dir_prefix = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let dir_pattern = format!("{}%", old_dir_prefix);
    
    // SQLite SUBSTR starts at 1. Skip prefix char count.
    // IMPORTANT: SUBSTR in SQLite uses character index, not byte index.
    let skip_len = (old_dir_prefix.chars().count() + 1) as i32;

    conn.execute(
        "UPDATE file_metadata SET path = ?1 || SUBSTR(path, ?2) WHERE path LIKE ?3",
        params![new_dir_prefix, skip_len, dir_pattern],
    )?;
    
    Ok(())
}

pub fn copy_metadata_dir(conn: &Connection, src_path: &str, dest_path: &str) -> Result<()> {
    let src_normalized = src_path.replace("\\", "/");
    let dest_normalized = dest_path.replace("\\", "/");
    
    let mut stmt = conn.prepare(
        "SELECT file_id, path FROM file_metadata WHERE path = ?1 OR path LIKE ?2"
    )?;
    
    let dir_pattern = format!("{}/%", src_normalized.trim_end_matches('/'));
    let rows = stmt.query_map(params![src_normalized, dir_pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    
    let mut tasks = Vec::new();
    for row in rows {
        let (src_id, src_full_path) = row?;
        let relative_path = if src_full_path == src_normalized {
            "".to_string()
        } else {
            src_full_path[src_normalized.len()..].to_string()
        };
        
        let dest_full_path = format!("{}{}", dest_normalized, relative_path);
        let dest_id = super::generate_id(&dest_full_path);
        tasks.push((src_id, dest_id, dest_full_path));
    }
    
    for (src_id, dest_id, dest_full_path) in tasks {
        copy_metadata(conn, &src_id, &dest_id, &dest_full_path)?;
    }
    
    Ok(())
}
