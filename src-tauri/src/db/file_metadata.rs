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
