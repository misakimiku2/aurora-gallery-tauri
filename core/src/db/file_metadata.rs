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
    pub category: Option<String>,
    pub updated_at: Option<i64>,
}

pub fn upsert_file_metadata(conn: &Connection, metadata: &FileMetadata) -> Result<()> {
    conn.execute(
        "INSERT INTO file_metadata (file_id, path, tags, description, source_url, ai_data, category, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(file_id) DO UPDATE SET
            path = excluded.path,
            tags = excluded.tags,
            description = excluded.description,
            source_url = excluded.source_url,
            ai_data = excluded.ai_data,
            category = excluded.category,
            updated_at = excluded.updated_at",
        params![
            metadata.file_id,
            metadata.path,
            metadata.tags,
            metadata.description,
            metadata.source_url,
            metadata.ai_data,
            metadata.category,
            metadata.updated_at
        ],
    )?;
    Ok(())
}

pub fn get_metadata_by_id(conn: &Connection, file_id: &str) -> Result<Option<FileMetadata>> {
    let mut stmt = conn.prepare(
        "SELECT file_id, path, tags, description, source_url, ai_data, category, updated_at FROM file_metadata WHERE file_id = ?1"
    )?;
    
    let mut rows = stmt.query_map(params![file_id], |row| {
        Ok(FileMetadata {
            file_id: row.get(0)?,
            path: row.get(1)?,
            tags: row.get(2)?,
            description: row.get(3)?,
            source_url: row.get(4)?,
            ai_data: row.get(5)?,
            category: row.get(6)?,
            updated_at: row.get(7)?,
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
        "SELECT file_id, path, tags, description, source_url, ai_data, category, updated_at FROM file_metadata"
    )?;
    
    let metadata_iter = stmt.query_map([], |row| {
        Ok(FileMetadata {
            file_id: row.get(0)?,
            path: row.get(1)?,
            tags: row.get(2)?,
            description: row.get(3)?,
            source_url: row.get(4)?,
            ai_data: row.get(5)?,
            category: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;

    let mut results = Vec::new();
    for item in metadata_iter {
        results.push(item?);
    }
    Ok(results)
}

pub fn get_metadata_under_path(conn: &Connection, root_path: &str) -> Result<Vec<FileMetadata>> {
    let pattern = format!("{}%", root_path.replace("\\", "/"));
    let mut stmt = conn.prepare(
        "SELECT file_id, path, tags, description, source_url, ai_data, category, updated_at FROM file_metadata WHERE path LIKE ?1"
    )?;
    
    let metadata_iter = stmt.query_map(params![pattern], |row| {
        Ok(FileMetadata {
            file_id: row.get(0)?,
            path: row.get(1)?,
            tags: row.get(2)?,
            description: row.get(3)?,
            source_url: row.get(4)?,
            ai_data: row.get(5)?,
            category: row.get(6)?,
            updated_at: row.get(7)?,
        })
    })?;

    let mut results = Vec::new();
    for item in metadata_iter {
        results.push(item?);
    }
    Ok(results)
}

/// 批量更新 category 字段（P1 内容分类用）。
/// 每条记录 (file_id, category) 在单事务内执行 UPDATE，避免长事务锁库。
pub fn update_category_batch(
    conn: &Connection,
    updates: &[(String, String)],
) -> Result<()> {
    if updates.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "UPDATE file_metadata SET category = ?1, updated_at = ?2 WHERE file_id = ?3",
        )?;
        let now = chrono::Utc::now().timestamp();
        for (file_id, category) in updates {
            stmt.execute(params![category, now, file_id])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// 取出所有有 tags 且在 file_index 中存在的记录的 (file_id, tags_json)，用于 P1 内容分类。
/// JOIN file_index 过滤掉已删除文件的残留 metadata，避免创建指向无效文件的专题。
pub fn get_all_tags_for_classification(conn: &Connection) -> Result<Vec<(String, serde_json::Value)>> {
    let mut stmt = conn.prepare(
        "SELECT m.file_id, m.tags FROM file_metadata m
         INNER JOIN file_index f ON m.file_id = f.file_id
         WHERE m.tags IS NOT NULL",
    )?;
    let iter = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, serde_json::Value>(1)?))
    })?;
    let mut out = Vec::new();
    for r in iter {
        out.push(r?);
    }
    Ok(out)
}

/// 统计每个 category 的数量（仅含 file_index 中存在的文件）。
pub fn get_category_stats(conn: &Connection) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT COALESCE(m.category, ''), COUNT(*)
         FROM file_metadata m
         INNER JOIN file_index f ON m.file_id = f.file_id
         GROUP BY m.category",
    )?;
    let iter = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
    })?;
    let mut out = Vec::new();
    for r in iter {
        out.push(r?);
    }
    Ok(out)
}

/// 返回 file_index 总文件数（用于前端展示"待处理"比例）。
pub fn count_indexed_files(conn: &Connection) -> Result<i64> {
    conn.query_row("SELECT COUNT(*) FROM file_index", [], |row| row.get(0))
}

/// 返回有 tags 的文件数（已跑过 WD14 打标签的）。
pub fn count_files_with_tags(conn: &Connection) -> Result<i64> {
    conn.query_row(
        "SELECT COUNT(*) FROM file_metadata m
         INNER JOIN file_index f ON m.file_id = f.file_id
         WHERE m.tags IS NOT NULL",
        [],
        |row| row.get(0),
    )
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
