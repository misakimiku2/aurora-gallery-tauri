use rusqlite::{params, Connection, Result};
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
            path TEXT NOT NULL,
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
    // 规范化路径，确保以正斜杠处理以便匹配子项
    let normalized_path = path.replace("\\", "/");
    
    // 删除完全匹配的文件记录
    conn.execute(
        "DELETE FROM file_index WHERE path = ?",
        params![normalized_path],
    )?;
    
    // 如果是目录，删除其下所有内容 (LIKE 'path/%')
    let dir_pattern = format!("{}/%", normalized_path.trim_end_matches('/'));
    conn.execute(
        "DELETE FROM file_index WHERE path LIKE ?",
        params![dir_pattern],
    )?;
    
    Ok(())
}
