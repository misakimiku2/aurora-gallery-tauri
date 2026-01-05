use std::path::Path;
use std::sync::{Arc, Mutex};
use rusqlite::{Connection, params};
use std::fs;
use std::time::SystemTime;
use serde_json;

use crate::color_extractor::ColorResult;

// 自定义结果类型
type Result<T> = std::result::Result<T, String>;

// 数据库连接池（简单实现，使用Mutex包裹）
pub struct ColorDbPool {
    conn: Arc<Mutex<Connection>>,
    db_path: String,
}

impl Clone for ColorDbPool {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
            db_path: self.db_path.clone(),
        }
    }
}

impl ColorDbPool {
    pub fn new(path: &Path) -> Result<Self> {
        eprintln!("=== ColorDbPool::new called ===");
        eprintln!("Database path: {}", path.display());
        
        if let Some(parent) = path.parent() {
            eprintln!("Parent directory: {}", parent.display());
            match fs::create_dir_all(parent) {
                Ok(_) => eprintln!("Parent directory created/verified successfully"),
                Err(e) => eprintln!("Failed to create parent directory: {}", e),
            }
        }
        
        eprintln!("Opening database connection...");
        let conn = Connection::open(path).map_err(|e| {
            eprintln!("Failed to open database: {}", e);
            e.to_string()
        })?;
        eprintln!("Database connection opened successfully");
        
        // PRAGMA commands return the number of rows affected, not ()
        // We just need to ensure they don't error, so we ignore the result
        let _ = conn.execute("PRAGMA journal_mode=WAL", []);
        let _ = conn.execute("PRAGMA synchronous=NORMAL", []);
        let _ = conn.execute("PRAGMA cache_size=-64000", []);
        let _ = conn.execute("PRAGMA busy_timeout=5000", []);
        let _ = conn.execute("PRAGMA temp_store=MEMORY", []);
        let _ = conn.execute("PRAGMA mmap_size=30000000000", []);
        
        // WAL specific optimizations - 调整设置以减少过于频繁的检查点
        // 移除自动检查点设置，改为手动控制
        let _ = conn.execute("PRAGMA journal_size_limit=20971520", []); // 设置WAL文件大小限制为20MB
        
        let db_path_str = path.to_string_lossy().to_string();
        
        let db_file_name = path.file_name().unwrap().to_string_lossy();
        let db_file_name_wal = format!("{}-wal", db_file_name);
        let db_file_name_shm = format!("{}-shm", db_file_name);
        
        let _wal_path = path.with_file_name(&db_file_name_wal);
        let _shm_path = path.with_file_name(&db_file_name_shm);
        
        eprintln!("=== ColorDbPool::new completed ===");
        
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: db_path_str,
        })
    }
    
    pub fn get_connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
    }
    
    pub fn close(&self) {
        if let Ok(conn) = self.conn.try_lock() {
            let _ = conn.execute("PRAGMA wal_checkpoint(TRUNCATE)", []);
        }
    }
    
    // 手动执行WAL检查点
    pub fn force_wal_checkpoint(&self) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| format!("Failed to acquire database connection: {}", e))?;
        
        // 执行WAL检查点，使用TRUNCATE模式以真正执行检查点
        // wal_checkpoint是一个特殊的PRAGMA，需要通过query_row调用
        match conn.query_row(
            "PRAGMA wal_checkpoint(TRUNCATE)",
            [],
            |row| {
                let wal_size: i64 = row.get(0)?;
                let frames_in_wal: i64 = row.get(1)?;
                let frames_checkpointed: i64 = row.get(2)?;
                eprintln!("WAL checkpoint: wal_size={}, frames_in_wal={}, frames_checkpointed={}", 
                          wal_size, frames_in_wal, frames_checkpointed);
                
                // 如果检查点后WAL文件仍然较大，说明可能存在问题
                if frames_in_wal > 0 {
                    eprintln!("WARNING: WAL checkpoint completed but {} frames remain in WAL", frames_in_wal);
                }
                
                Ok(())
            }
        ) {
            Ok(_) => {
                eprintln!("WAL checkpoint executed successfully");
                Ok(())
            },
            Err(e) => {
                eprintln!("Failed to execute WAL checkpoint: {}", e);
                Err(format!("Failed to execute WAL checkpoint: {}", e))
            }
        }
    }
    
    // 强制执行完整的WAL检查点，确保所有数据写入主数据库
    pub fn force_full_checkpoint(&self) -> Result<()> {
        let conn = self.conn.lock().map_err(|e| format!("Failed to acquire database connection: {}", e))?;
        
        // 首先使用TRUNCATE模式执行检查点
        match conn.query_row(
            "PRAGMA wal_checkpoint(TRUNCATE)",
            [],
            |row| {
                let wal_size: i64 = row.get(0)?;
                let frames_in_wal: i64 = row.get(1)?;
                let frames_checkpointed: i64 = row.get(2)?;
                eprintln!("Full WAL checkpoint (TRUNCATE): wal_size={}, frames_in_wal={}, frames_checkpointed={}", 
                          wal_size, frames_in_wal, frames_checkpointed);
                Ok((wal_size, frames_in_wal))
            }
        ) {
            Ok((_wal_size, frames_in_wal)) => {
                // 如果还有frames在WAL中，尝试使用RESTART模式
                if frames_in_wal > 0 {
                    eprintln!("Attempting RESTART checkpoint to clear remaining {} frames", frames_in_wal);
                    match conn.query_row(
                        "PRAGMA wal_checkpoint(RESTART)",
                        [],
                        |row| {
                            let wal_size: i64 = row.get(0)?;
                            let frames_in_wal: i64 = row.get(1)?;
                            let frames_checkpointed: i64 = row.get(2)?;
                            eprintln!("Full WAL checkpoint (RESTART): wal_size={}, frames_in_wal={}, frames_checkpointed={}", 
                                      wal_size, frames_in_wal, frames_checkpointed);
                            Ok(())
                        }
                    ) {
                        Ok(_) => {
                            eprintln!("Full WAL checkpoint completed successfully");
                            Ok(())
                        },
                        Err(e) => {
                            eprintln!("Failed to execute RESTART checkpoint: {}", e);
                            Err(format!("Failed to execute RESTART checkpoint: {}", e))
                        }
                    }
                } else {
                    eprintln!("Full WAL checkpoint completed successfully");
                    Ok(())
                }
            },
            Err(e) => {
                eprintln!("Failed to execute full WAL checkpoint: {}", e);
                Err(format!("Failed to execute full WAL checkpoint: {}", e))
            }
        }
    }
    
    // 获取WAL文件大小信息
    pub fn get_wal_info(&self) -> Result<(i64, i64)> {
        if let Ok(conn) = self.conn.try_lock() {
            // 查询WAL文件大小和检查点状态，使用PASSIVE模式只查询不执行检查点
            match conn.query_row(
                "PRAGMA wal_checkpoint(PASSIVE)",
                [],
                |row| {
                    let wal_size: i64 = row.get(0)?;
                    let frames_in_wal: i64 = row.get(1)?;
                    let frames_checkpointed: i64 = row.get(2)?;
                    eprintln!("WAL info: size={}, frames_in_wal={}, frames_checkpointed={}", 
                              wal_size, frames_in_wal, frames_checkpointed);
                    Ok((wal_size, frames_checkpointed))
                }
            ) {
                Ok(result) => Ok(result),
                Err(e) => {
                    eprintln!("Failed to get WAL info: {}", e);
                    Err(format!("Failed to get WAL info: {}", e))
                }
            }
        } else {
            Err("Failed to acquire database connection".to_string())
        }
    }
    
    // 获取数据库文件大小
    pub fn get_db_file_sizes(&self) -> Result<(u64, u64)> {
        eprintln!("=== get_db_file_sizes called ===");
        eprintln!("Database path from self.db_path: {}", self.db_path);
        
        let db_path = Path::new(&self.db_path);
        let db_file_name = db_path.file_name().unwrap().to_string_lossy();
        let db_file_name_wal = format!("{}-wal", db_file_name);
        let wal_path = db_path.with_file_name(&db_file_name_wal);
        
        eprintln!("Resolved DB path: {}", db_path.display());
        eprintln!("Resolved WAL path: {}", wal_path.display());
        
        let db_size = fs::metadata(&db_path)
            .map(|m| {
                let size = m.len();
                eprintln!("DB file metadata found, size: {} bytes", size);
                size
            })
            .unwrap_or_else(|e| {
                eprintln!("Failed to get DB file metadata: {}", e);
                0
            });
        
        let wal_size = fs::metadata(&wal_path)
            .map(|m| {
                let size = m.len();
                eprintln!("WAL file metadata found, size: {} bytes", size);
                size
            })
            .unwrap_or_else(|e| {
                eprintln!("Failed to get WAL file metadata: {}", e);
                0
            });
        
        eprintln!("Database file sizes: DB={} bytes ({:.2} MB), WAL={} bytes ({:.2} MB)",
                  db_size, db_size as f64 / 1024.0 / 1024.0,
                  wal_size, wal_size as f64 / 1024.0 / 1024.0);
        eprintln!("=== get_db_file_sizes completed ===");
        
        Ok((db_size, wal_size))
    }
}

// 初始化数据库
pub fn init_db(conn: &mut Connection) -> Result<()> {
    conn.execute("PRAGMA foreign_keys=OFF", []).map_err(|e| format!("Failed to set foreign keys: {}", e))?;
    let _ = conn.execute("PRAGMA locking_mode=NORMAL", []);
    conn.execute("PRAGMA page_size=4096", []).map_err(|e| format!("Failed to set page size: {}", e))?;
    
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
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_path ON dominant_colors(file_path)",
        [],
    ).map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_status ON dominant_colors(status)",
        [],
    ).map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_created_at ON dominant_colors(created_at)",
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
        "INSERT OR IGNORE INTO dominant_colors 
         (file_path, colors, created_at, updated_at, status) 
         VALUES (?, ?, ?, ?, ?)",
        params![file_path, colors_json, current_ts, current_ts, "extracted"],
    ).map_err(|e| format!("Database error in save_colors: {}", e))?;
    
    conn.execute(
        "UPDATE dominant_colors
         SET colors = ?, updated_at = ?, status = ?
         WHERE file_path = ?",
        params![colors_json, current_ts, "extracted", file_path],
    ).map_err(|e| format!("Database error in save_colors: {}", e))?;
    
    Ok(())
}

// 批量保存主色调数据
pub fn batch_save_colors(
    conn: &mut Connection,
    color_data: &[(&str, &[ColorResult])]
) -> Result<()> {
    if color_data.is_empty() {
        return Ok(());
    }

    let current_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;

    // 记录开始时间
    let start_time = std::time::Instant::now();

    eprintln!("Starting database transaction for {} files", color_data.len());
    
    // 记录WAL检查点前状态
    match conn.query_row(
        "PRAGMA wal_checkpoint(PASSIVE)",
        [],
        |row| {
            let wal_size: i64 = row.get(0)?;
            let frames_in_wal: i64 = row.get(1)?;
            let frames_checkpointed: i64 = row.get(2)?;
            eprintln!("WAL status before transaction: size={}, frames_in_wal={}, frames_checkpointed={}", 
                      wal_size, frames_in_wal, frames_checkpointed);
            Ok(wal_size)
        }
    ) {
        Ok(wal_size) => {
            // 如果WAL文件较大，建议执行检查点
            if wal_size > 4000 * 1024 { // 4MB
                eprintln!("WAL file is large ({} bytes), consider executing checkpoint", wal_size);
            }
        },
        Err(e) => {
            eprintln!("Failed to get WAL status before transaction: {}", e);
        }
    }

    let tx = conn.transaction().map_err(|e| format!("Failed to start transaction: {}", e))?;

    let mut success_count = 0;
    let mut error_count = 0;

    for (file_path, colors) in color_data {
        let colors_json = match serde_json::to_string(colors) {
            Ok(json) => json,
            Err(e) => {
                eprintln!("Failed to serialize colors for {}: {}", file_path, e);
                error_count += 1;
                continue;
            }
        };

        match tx.execute(
            "INSERT OR IGNORE INTO dominant_colors 
             (file_path, colors, created_at, updated_at, status) 
             VALUES (?, ?, ?, ?, ?)",
            params![file_path, colors_json, current_ts, current_ts, "extracted"],
        ) {
            Ok(_) => {},
            Err(e) => {
                eprintln!("Database error for {}: {}", file_path, e);
                error_count += 1;
                continue;
            }
        }

        match tx.execute(
            "UPDATE dominant_colors
             SET colors = ?, updated_at = ?, status = ?
             WHERE file_path = ?",
            params![colors_json, current_ts, "extracted", file_path],
        ) {
            Ok(_) => {
                success_count += 1;
            },
            Err(e) => {
                eprintln!("Database error for {}: {}", file_path, e);
                error_count += 1;
            }
        }
    }

    // 提交事务
    match tx.commit() {
        Ok(_) => {
            let duration = start_time.elapsed();
            eprintln!("Transaction committed successfully: {} success, {} errors, took {:?}",
                     success_count, error_count, duration);
            
            // 验证数据是否真的写入了数据库
            match conn.query_row(
                "SELECT COUNT(*) FROM dominant_colors WHERE status = 'extracted'",
                [],
                |row| {
                    let count: i64 = row.get(0)?;
                    eprintln!("Total extracted records in database after transaction: {}", count);
                    Ok(count)
                }
            ) {
                Ok(count) => {
                    eprintln!("Database verification: {} extracted records found", count);
                },
                Err(e) => {
                    eprintln!("Failed to verify database records: {}", e);
                }
            }
            
            // 记录WAL检查点后状态
            match conn.query_row(
                "PRAGMA wal_checkpoint(PASSIVE)",
                [],
                |row| {
                    let wal_size: i64 = row.get(0)?;
                    let frames_in_wal: i64 = row.get(1)?;
                    let frames_checkpointed: i64 = row.get(2)?;
                    eprintln!("WAL status after transaction: size={}, frames_in_wal={}, frames_checkpointed={}", 
                              wal_size, frames_in_wal, frames_checkpointed);
                    Ok(wal_size)
                }
            ) {
                Ok(wal_size) => {
                    // 如果WAL文件较大，建议执行检查点
                    if wal_size > 4000 * 1024 { // 4MB
                        eprintln!("WAL file is large ({} bytes), consider executing checkpoint", wal_size);
                    }
                },
                Err(e) => {
                    eprintln!("Failed to get WAL status after transaction: {}", e);
                }
            }
            
            Ok(())
        },
        Err(e) => {
            let duration = start_time.elapsed();
            eprintln!("Transaction commit failed after {:?}: {}", duration, e);
            Err(format!("Failed to commit transaction: {}", e))
        }
    }
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

// 重置所有"processing"状态的文件为"pending"状态
pub fn reset_processing_to_pending(conn: &mut Connection) -> Result<usize> {
    let current_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    
    let updated = conn.execute(
        "UPDATE dominant_colors 
         SET status = ?, updated_at = ? 
         WHERE status = ?",
        params!["pending", current_ts, "processing"],
    ).map_err(|e| e.to_string())?;
    
    eprintln!("Reset {} files from 'processing' to 'pending' status", updated);
    Ok(updated)
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

// 获取正在处理文件数量
pub fn get_processing_files_count(
    conn: &mut Connection
) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dominant_colors WHERE status = ?",
        params!["processing"],
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
