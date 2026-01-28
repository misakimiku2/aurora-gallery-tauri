use std::path::Path;
use std::sync::{Arc, Mutex, RwLock};
use std::sync::atomic::{AtomicBool, Ordering};
use rusqlite::{Connection, params};
use std::fs;
use std::time::{SystemTime, Duration};
use serde_json;
use palette::{FromColor, Srgb, Lab};

use crate::color_extractor::ColorResult;

#[derive(Clone, Debug)]
pub struct CachedImage {
    pub file_path: String,
    pub labs: Vec<Lab>,
}

// Helper for cache conversion
fn hex_to_lab(hex: &str) -> Option<Lab> {
    let hex = hex.trim_start_matches('#');
    if hex.len() != 6 { return None; }
    
    let r = u8::from_str_radix(&hex[0..2], 16).ok()?;
    let g = u8::from_str_radix(&hex[2..4], 16).ok()?;
    let b = u8::from_str_radix(&hex[4..6], 16).ok()?;
    
    let srgb = Srgb::new(r as f32 / 255.0, g as f32 / 255.0, b as f32 / 255.0);
    Some(Lab::from_color(srgb))
}

// 自定义结果类型
type Result<T> = std::result::Result<T, String>;

// 数据库连接池（简单实现，使用Mutex包裹）
pub struct ColorDbPool {
    conn: Arc<Mutex<Connection>>,
    db_path: String,
    cache: Arc<RwLock<Vec<CachedImage>>>,
    cache_inited: Arc<AtomicBool>, // 一次性初始化标志（防止并发重复预热）
} 

impl Clone for ColorDbPool {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
            db_path: self.db_path.clone(),
            cache: Arc::clone(&self.cache),
            cache_inited: Arc::clone(&self.cache_inited),
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
            cache: Arc::new(RwLock::new(Vec::new())),
            cache_inited: Arc::new(AtomicBool::new(false)),
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
    
    pub fn refresh_cache(&self) -> Result<()> {
        let cached_images = self.load_from_db_internal()?;
        
        let mut cache = self.cache.write().map_err(|e| e.to_string())?;
        *cache = cached_images;
        // 标记已完成一次初始化（使后续 ensure_cache_initialized 能快速返回）
        let _ = self.cache_inited.store(true, Ordering::SeqCst);
        eprintln!("[ColorDB] Cache refreshed with {} items (precomputed Labs)", cache.len());
        Ok(())
    }

    // Direct access to cache for high-performance searching
    // Runs the closure `f` with a reference to the cache, avoiding cloning.
    pub fn access_cache<F, R>(&self, f: F) -> Result<R>
    where F: FnOnce(&[CachedImage]) -> R 
    {
        // If cache already has entries, run the closure synchronously
        {
             let cache = self.cache.read().map_err(|e| e.to_string())?;
             if !cache.is_empty() {
                 return Ok(f(&cache));
             }
        }

        // Cache not ready — do NOT synchronously perform a full refresh here (avoid blocking callers).
        // Caller should either trigger a background preheat via `ensure_cache_initialized(true)`
        // or fall back to a DB-indexed fast-path.
        Err("cache_not_ready".to_string())
    }

    // Ensure the cache is initialized. If `background` is true this returns immediately and
    // performs a batched preload in a background thread; otherwise it blocks until the
    // initial refresh completes.
    pub fn ensure_cache_initialized(&self, background: bool) -> Result<()> {
        // Fast-path: if cache already initialized, return
        if self.cache_inited.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Avoid concurrent initializers
        let already = self.cache_inited.swap(true, Ordering::SeqCst);
        if already {
            return Ok(());
        }

        if background {
            let pool = self.clone();
            std::thread::spawn(move || {
                if let Err(e) = pool.refresh_cache_in_batches(500) {
                    eprintln!("[ColorDB] background preheat failed: {}", e);
                    // allow retry on next ensure call
                    let _ = pool.cache_inited.store(false, Ordering::SeqCst);
                } else {
                    eprintln!("[ColorDB] background preheat completed");
                }
            });
            Ok(())
        } else {
            // blocking initialization
            let res = self.refresh_cache();
            if res.is_err() {
                // clear flag so future attempts can retry
                let _ = self.cache_inited.store(false, Ordering::SeqCst);
            }
            res
        }
    }

    // Convenience async starter
    pub fn ensure_cache_initialized_async(&self) -> Result<()> {
        self.ensure_cache_initialized(true)
    }

    /// Return whether a successful initialization has been started/completed.
    pub fn is_cache_initialized(&self) -> bool {
        self.cache_inited.load(Ordering::SeqCst)
    }

    // Load DB rows in batches and append to cache to avoid big IO/CPU spike
    pub fn refresh_cache_in_batches(&self, batch_size: usize) -> Result<()> {
        eprintln!("[ColorDB] refresh_cache_in_batches start (batch_size={})", batch_size);
        let mut offset: i64 = 0;
        loop {
            let batch = self.load_from_db_internal_batch(offset, batch_size as i64)?;
            if batch.is_empty() {
                break;
            }

            {
                let mut cache = self.cache.write().map_err(|e| e.to_string())?;
                cache.extend(batch.into_iter());
                eprintln!("[ColorDB] preheated cache size={} (offset={})", cache.len(), offset);
            }

            // Small pause to reduce IO burst on startup
            std::thread::sleep(Duration::from_millis(20));

            offset += batch_size as i64;
        }

        // Final sanity log
        let cache_len = { self.cache.read().map_err(|e| e.to_string())?.len() };
        eprintln!("[ColorDB] refresh_cache_in_batches completed, total_cached={}", cache_len);
        Ok(())
    }

    fn load_from_db_internal_batch(&self, offset: i64, limit: i64) -> Result<Vec<CachedImage>> {
        eprintln!("[ColorDB] load_from_db_internal_batch called offset={} limit={}", offset, limit);
        let conn = self.conn.lock().map_err(|e| format!("Get connection failed: {}", e))?;

        let mut stmt = conn.prepare(
            "SELECT file_path, colors FROM dominant_colors WHERE status = 'extracted' LIMIT ? OFFSET ?"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map(params![limit, offset], |row| {
             let file_path: String = row.get(0)?;
             let colors_json: String = row.get(1)?;
             Ok((file_path, colors_json))
         }).map_err(|e| e.to_string())?;
 
         let mut results = Vec::new();
         for row in rows {
             if let Ok((file_path, colors_json)) = row {
                 if let Ok(colors) = serde_json::from_str::<Vec<ColorResult>>(&colors_json) {
                     let labs = colors.into_iter()
                         .filter_map(|c| hex_to_lab(&c.hex))
                         .collect();

                     results.push(CachedImage {
                         file_path,
                         labs,
                     });
                 }
             }
         }
         eprintln!("[ColorDB] Loaded {} images from DB (batch)", results.len());
         Ok(results)
    }

    pub fn copy_colors(&self, src_path: &str, dest_path: &str) -> Result<bool> {
        let conn = self.conn.lock().map_err(|e| e.to_string())?;
        
        let mut stmt = conn.prepare(
            "SELECT colors FROM dominant_colors WHERE file_path = ? AND status = 'extracted'"
        ).map_err(|e| e.to_string())?;
        
        let source_colors = match stmt.query_row(params![src_path], |row| {
            let colors: String = row.get(0)?;
            Ok(colors)
        }) {
            Ok(c) => Some(c),
            Err(rusqlite::Error::QueryReturnedNoRows) => None,
            Err(e) => return Err(e.to_string()),
        };
        
        drop(stmt);

        if let Some(colors) = source_colors {
            let current_ts = SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_secs() as i64;
            
            let count = conn.execute(
                "INSERT OR REPLACE INTO dominant_colors 
                 (file_path, colors, created_at, updated_at, status) 
                 VALUES (?, ?, ?, ?, ?)",
                params![
                    dest_path,
                    colors,
                    current_ts,
                    current_ts,
                    "extracted"
                ],
            ).map_err(|e| e.to_string())?;
            
            if count > 0 {
                eprintln!("[ColorDB] Copied colors from {} to {}", src_path, dest_path);
                
                if let Ok(color_results) = serde_json::from_str::<Vec<ColorResult>>(&colors) {
                     let labs: Vec<Lab> = color_results.iter()
                         .filter_map(|c| hex_to_lab(&c.hex))
                         .collect();
                     
                     let new_cached_item = CachedImage {
                         file_path: dest_path.to_string(),
                         labs,
                     };
                     
                     if let Ok(mut cache) = self.cache.write() {
                         cache.push(new_cached_item);
                     }
                }
                return Ok(true);
            }
        }
        
        Ok(false)
    }

    fn load_from_db_internal(&self) -> Result<Vec<CachedImage>> {
        eprintln!("[ColorDB] load_from_db_internal called");
        let conn = self.conn.lock().map_err(|e| format!("Get connection failed: {}", e))?;
        
        let mut stmt = conn.prepare(
            "SELECT file_path, colors FROM dominant_colors WHERE status = 'extracted'"
        ).map_err(|e| e.to_string())?;

        let rows = stmt.query_map([], |row| {
             let file_path: String = row.get(0)?;
             let colors_json: String = row.get(1)?;
             Ok((file_path, colors_json))
         }).map_err(|e| e.to_string())?;
 
         let mut results = Vec::new();
         for row in rows {
             if let Ok((file_path, colors_json)) = row {
                 if let Ok(colors) = serde_json::from_str::<Vec<ColorResult>>(&colors_json) {
                     let labs = colors.into_iter()
                         .filter_map(|c| hex_to_lab(&c.hex))
                         .collect();

                     results.push(CachedImage {
                         file_path,
                         labs,
                     });
                 }
             }
         }
         eprintln!("[ColorDB] Loaded {} images from DB", results.len());
         Ok(results)
    }

    // 保存主色调数据 (Method)
    pub fn save_colors(&self, file_path: &str, colors: &[ColorResult]) -> Result<()> {
        let mut conn = self.get_connection();
        let current_ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs() as i64;
    
        let colors_json = serde_json::to_string(colors)
            .map_err(|e| e.to_string())?;
    
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT OR IGNORE INTO dominant_colors 
             (file_path, colors, created_at, updated_at, status) 
             VALUES (?, ?, ?, ?, ?)",
            params![file_path, colors_json, current_ts, current_ts, "extracted"],
        ).map_err(|e| format!("Database error in save_colors: {}", e))?;
    
        tx.execute(
            "UPDATE dominant_colors
             SET colors = ?, updated_at = ?, status = ?
             WHERE file_path = ?",
            params![colors_json, current_ts, "extracted", file_path],
        ).map_err(|e| format!("Database error in save_colors: {}", e))?;

        // 更新 image_color_indices 表
        tx.execute("DELETE FROM image_color_indices WHERE file_path = ?", params![file_path])
           .map_err(|e| format!("Failed to delete old indices: {}", e))?;
      
        {
            let mut stmt = tx.prepare("INSERT INTO image_color_indices (file_path, l, a, b) VALUES (?, ?, ?, ?)")
                .map_err(|e| format!("Failed to prepare statement: {}", e))?;
            
            for color in colors {
                stmt.execute(params![file_path, color.lab_l, color.lab_a, color.lab_b])
                    .map_err(|e| format!("Failed to insert index: {}", e))?;
            }
        }
    
        tx.commit().map_err(|e| format!("Failed to commit transaction: {}", e))?;
        
        // Update Cache
        let labs: Vec<Lab> = colors.iter()
            .filter_map(|c| hex_to_lab(&c.hex))
            .collect();
        
        let mut cache = self.cache.write().map_err(|e| e.to_string())?;
        
        if let Some(pos) = cache.iter().position(|x| x.file_path == file_path) {
            cache[pos].labs = labs;
        } else {
            cache.push(CachedImage {
                file_path: file_path.to_string(),
                labs,
            });
        }
        Ok(())
    }

    // 批量保存主色调数据 (Method)
    pub fn batch_save_colors(
        &self,
        color_data: &[(&str, &[ColorResult])]
    ) -> Result<()> {
        if color_data.is_empty() {
            return Ok(());
        }
        let mut conn = self.get_connection();
        let current_ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs() as i64;
    
        let start_time = std::time::Instant::now();
        
        let tx = conn.transaction().map_err(|e| format!("Failed to start transaction: {}", e))?;
    
        let mut success_count = 0;
        let mut error_count = 0;
        
        {
            let mut delete_indices_stmt = tx.prepare("DELETE FROM image_color_indices WHERE file_path = ?")
                .map_err(|e| format!("Failed to prepare delete statement: {}", e))?;
            let mut insert_indices_stmt = tx.prepare("INSERT INTO image_color_indices (file_path, l, a, b) VALUES (?, ?, ?, ?)")
                .map_err(|e| format!("Failed to prepare insert statement: {}", e))?;
    
            for (file_path, colors) in color_data {
                let colors_json = match serde_json::to_string(colors) {
                    Ok(json) => json,
                    Err(e) => {
                        eprintln!("Failed to serialize colors for {}: {}", file_path, e);
                        error_count += 1;
                        continue;
                    }
                };
    
                let _ = tx.execute(
                    "INSERT OR IGNORE INTO dominant_colors 
                     (file_path, colors, created_at, updated_at, status) 
                     VALUES (?, ?, ?, ?, ?)",
                    params![file_path, colors_json, current_ts, current_ts, "extracted"],
                );
    
                match tx.execute(
                    "UPDATE dominant_colors
                     SET colors = ?, updated_at = ?, status = ?
                     WHERE file_path = ?",
                    params![colors_json, current_ts, "extracted", file_path],
                ) {
                    Ok(_) => {
                        success_count += 1;
                        let _ = delete_indices_stmt.execute(params![file_path]);
                        for color in *colors {
                            let _ = insert_indices_stmt.execute(params![file_path, color.lab_l, color.lab_a, color.lab_b]);
                        }
                    },
                    Err(e) => {
                        eprintln!("Database error for {}: {}", file_path, e);
                        error_count += 1;
                    }
                }
            }
        }
    
        match tx.commit() {
            Ok(_) => {
                let duration = start_time.elapsed();
                eprintln!("Transaction committed successfully: {} success, {} errors, took {:?}",
                         success_count, error_count, duration);
                
                // Update Cache (only for successful items currently in color_data)
                // Note: Actual success tracking per item is loose here, assuming optimistic update of cache is okay.
                // Or I can iterate color_data again.
                // To be safe, let's only strictly update cache if transaction committed.
                let mut cache = self.cache.write().map_err(|e| e.to_string())?;
                for (file_path, colors) in color_data {
                     let labs: Vec<Lab> = colors.iter()
                         .filter_map(|c| hex_to_lab(&c.hex))
                         .collect();
                     
                     if let Some(pos) = cache.iter().position(|x| x.file_path == *file_path) {
                         cache[pos].labs = labs;
                     } else {
                         cache.push(CachedImage {
                             file_path: file_path.to_string(),
                             labs,
                         });
                     }
                }
                Ok(())
            },
            Err(e) => Err(format!("Failed to commit transaction: {}", e))
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

    pub fn delete_colors_by_path(&self, path: &str) -> Result<()> {
        let normalized_path = path.replace("\\", "/");
        let mut conn = self.get_connection();
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // 1. 删除 dominant_colors 记录
        tx.execute(
            "DELETE FROM dominant_colors WHERE file_path = ?",
            params![normalized_path],
        ).map_err(|e| e.to_string())?;

        let dir_pattern = format!("{}/%", normalized_path.trim_end_matches('/'));
        tx.execute(
            "DELETE FROM dominant_colors WHERE file_path LIKE ?",
            params![dir_pattern],
        ).map_err(|e| e.to_string())?;

        // 2. 删除 image_color_indices 记录
        tx.execute(
            "DELETE FROM image_color_indices WHERE file_path = ?",
            params![normalized_path],
        ).map_err(|e| e.to_string())?;

        tx.execute(
            "DELETE FROM image_color_indices WHERE file_path LIKE ?",
            params![dir_pattern],
        ).map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;

        // 3. 更新内存缓存
        if let Ok(mut cache) = self.cache.write() {
            cache.retain(|item| {
                let item_path = item.file_path.replace("\\", "/");
                item_path != normalized_path && !item_path.starts_with(&(normalized_path.trim_end_matches('/').to_string() + "/"))
            });
        }

        Ok(())
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

    conn.execute(
        "CREATE TABLE IF NOT EXISTS image_color_indices (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT NOT NULL,
            l REAL NOT NULL,
            a REAL NOT NULL,
            b REAL NOT NULL
        )",
        [],
    ).map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_color_indices_file_path ON image_color_indices(file_path)",
        [],
    ).map_err(|e| e.to_string())?;
    
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_color_indices_lab ON image_color_indices(l, a, b)",
        [],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

// 添加待处理文件（只添加数据库中不存在的文件）
// 返回实际添加的文件数量
pub fn add_pending_files(conn: &mut Connection, file_paths: &[String]) -> Result<usize> {
    if file_paths.is_empty() {
        return Ok(0);
    }
    
    let current_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    
    let mut added_count = 0usize;
    
    for path in file_paths {
        // 使用 INSERT OR IGNORE 来避免重复
        // 已存在的文件（无论是 pending、processing 还是 extracted）都会被忽略
        let result = tx.execute(
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
        
        if result > 0 {
            added_count += 1;
        }
    }
    
    tx.commit().map_err(|e| e.to_string())?;
    
    if added_count > 0 {
        eprintln!("Added {} new files to pending queue (out of {} requested)", added_count, file_paths.len());
    }
    
    Ok(added_count)
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
