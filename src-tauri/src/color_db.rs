use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use rusqlite::{Connection, params};
use serde_json::Value;
use std::fs;
use std::io;
use std::time::{SystemTime, SystemTimeError};
use serde_json;

use crate::color_extractor::ColorResult;

// 自定义结果类型
type Result<T> = std::result::Result<T, String>;

// 数据库连接池（简单实现，使用Mutex包裹）
pub struct ColorDbPool {
    conn: Arc<Mutex<Connection>>,
}

impl Clone for ColorDbPool {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
        }
    }
}

impl ColorDbPool {
    pub fn new(path: &Path) -> Result<Self> {
        // 确保目录存在
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        
        let conn = Connection::open(path).map_err(|e| e.to_string())?;
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
        })
    }
    
    pub fn get_connection(&self) -> std::sync::MutexGuard<Connection> {
        self.conn.lock().unwrap()
    }
}

// 初始化数据库
pub fn init_db(conn: &mut Connection) -> Result<()> {
    // 创建主色调表
    conn.execute(
        "CREATE TABLE IF NOT EXISTS dominant_colors (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT UNIQUE NOT NULL,
            colors TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            status TEXT NOT NULL
        )",
        [],
    ).map_err(|e| e.to_string())?;
    
    // 创建索引
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_path ON dominant_colors(file_path)",
        [],
    ).map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_status ON dominant_colors(status)",
        [],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

// 添加待处理文件
pub fn add_pending_files(conn: &mut Connection, file_paths: &[String]) -> Result<()> {
    let current_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    
    for path in file_paths {
        tx.execute(
            "INSERT OR IGNORE INTO dominant_colors 
             (file_path, colors, created_at, updated_at, status) 
             VALUES (?, ?, ?, ?, ?)",
            params![
                path,
                "[]", // 空颜色数组
                current_ts,
                current_ts,
                "pending"
            ],
        ).map_err(|e| e.to_string())?;
    }
    
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// 保存主色调数据
pub fn save_colors(
    conn: &mut Connection, 
    file_path: &str, 
    colors: &[ColorResult]
) -> Result<()> {
    let current_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    
    let colors_json = serde_json::to_string(colors)
        .map_err(|e| e.to_string())?;
    
    conn.execute(
        "UPDATE dominant_colors 
         SET colors = ?, updated_at = ?, status = ? 
         WHERE file_path = ?",
        params![colors_json, current_ts, "extracted", file_path],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

// 批量保存主色调数据
pub fn batch_save_colors(
    conn: &mut Connection, 
    color_data: &[(&str, &[ColorResult])]
) -> Result<()> {
    let current_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    
    for (file_path, colors) in color_data {
        let colors_json = serde_json::to_string(colors)
            .map_err(|e| e.to_string())?;
        tx.execute(
            "UPDATE dominant_colors 
             SET colors = ?, updated_at = ?, status = ? 
             WHERE file_path = ?",
            params![colors_json, current_ts, "extracted", file_path],
        ).map_err(|e| e.to_string())?;
    }
    
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// 根据文件路径获取颜色数据
pub fn get_colors_by_file_path(
    conn: &mut Connection, 
    file_path: &str
) -> Result<Option<Vec<ColorResult>>> {
    let mut stmt = conn.prepare(
        "SELECT colors FROM dominant_colors WHERE file_path = ? AND status = ?"
    ).map_err(|e| e.to_string())?;
    
    match stmt.query_row(params![file_path, "extracted"], |row| {
        let colors_json: String = row.get(0)?;
        Ok(colors_json)
    }) {
        Ok(row) => {
            let colors: Vec<ColorResult> = serde_json::from_str(&row)
                .map_err(|e| e.to_string())?;
            Ok(Some(colors))
        },
        Err(_) => Ok(None)
    }
}

// 获取待处理文件列表
pub fn get_pending_files(
    conn: &mut Connection, 
    limit: usize
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT file_path FROM dominant_colors WHERE status = ? ORDER BY created_at ASC LIMIT ?"
    ).map_err(|e| e.to_string())?;
    
    let mut rows = stmt.query(params!["pending", limit])
        .map_err(|e| e.to_string())?;
    
    let mut files = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let file_path: String = row.get(0).map_err(|e| e.to_string())?;
        files.push(file_path);
    }
    
    Ok(files)
}

// 更新文件处理状态
pub fn update_status(
    conn: &mut Connection, 
    file_path: &str, 
    status: &str
) -> Result<()> {
    let current_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    
    conn.execute(
        "UPDATE dominant_colors 
         SET status = ?, updated_at = ? 
         WHERE file_path = ?",
        params![status, current_ts, file_path],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

// 删除颜色数据
pub fn delete_colors_by_file_path(
    conn: &mut Connection, 
    file_path: &str
) -> Result<()> {
    conn.execute(
        "DELETE FROM dominant_colors WHERE file_path = ?",
        params![file_path],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

// 批量删除颜色数据
pub fn batch_delete_colors(
    conn: &mut Connection, 
    file_paths: &[String]
) -> Result<()> {
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    
    for path in file_paths {
        tx.execute(
            "DELETE FROM dominant_colors WHERE file_path = ?",
            params![path],
        ).map_err(|e| e.to_string())?;
    }
    
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

// 获取所有已提取颜色的文件
pub fn get_all_extracted_files(
    conn: &mut Connection
) -> Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT file_path FROM dominant_colors WHERE status = ?"
    ).map_err(|e| e.to_string())?;
    
    let mut rows = stmt.query(params!["extracted"])
        .map_err(|e| e.to_string())?;
    
    let mut files = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let file_path: String = row.get(0).map_err(|e| e.to_string())?;
        files.push(file_path);
    }
    
    Ok(files)
}

// 获取数据库中文件总数
pub fn get_total_files(
    conn: &mut Connection
) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dominant_colors",
        [],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    
    Ok(count as usize)
}

// 获取待处理文件数量
pub fn get_pending_files_count(
    conn: &mut Connection
) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dominant_colors WHERE status = ?",
        params!["pending"],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    
    Ok(count as usize)
}

// 获取已处理文件数量
pub fn get_extracted_files_count(
    conn: &mut Connection
) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dominant_colors WHERE status = ?",
        params!["extracted"],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    
    Ok(count as usize)
}