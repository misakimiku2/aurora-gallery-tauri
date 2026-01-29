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
    let old_normalized = old_path.replace("\\", "/");
    let new_normalized = new_path.replace("\\", "/");
    
    // 找出所有路径匹配的元数据
    let mut stmt = conn.prepare(
        "SELECT file_id, path FROM file_metadata WHERE path = ?1 OR path LIKE ?2"
    )?;
    
    let old_dir_prefix = if old_normalized.ends_with('/') { old_normalized.clone() } else { format!("{}/", old_normalized) };
    let _new_dir_prefix = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
    let dir_pattern = format!("{}%", old_dir_prefix);
    
    let rows = stmt.query_map(params![old_normalized, dir_pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    
    let mut updates = Vec::new();
    for row in rows {
        let (old_id, old_full_path) = row?;
        let relative_path = if old_full_path == old_normalized {
            "".to_string()
        } else {
            old_full_path[old_normalized.len()..].to_string()
        };
        
        // 确保新路径生成正确
        let new_full_path = match relative_path.as_str() {
            "" => new_normalized.clone(),
            _ => format!("{}{}", new_normalized.trim_end_matches('/'), relative_path),
        };
        
        let new_id = super::generate_id(&new_full_path);
        updates.push((old_id, new_id, new_full_path));
    }
    drop(stmt);
    
    // 使用显式事务一次性执行所有更新，避免频繁 IO
    // 由于 migrate_metadata 内部也可能使用连接，我们手动执行 UPDATE 以确保性能
    if !updates.is_empty() {
        // 由于我们传入的是 &Connection，无法直接创建 Transaction
        // 但我们可以直接执行 SQL。如果上层已经开启了事务，这里会参与上层事务。
        // 如果没有，这仍然比分散的 execute 快一些。
        for (old_id, new_id, new_full_path) in updates {
            conn.execute(
                "UPDATE file_metadata SET file_id = ?1, path = ?2 WHERE file_id = ?3",
                params![new_id, new_full_path, old_id],
            )?;
        }
    }
    
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
