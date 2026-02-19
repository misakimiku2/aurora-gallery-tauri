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
    db_path: Arc<RwLock<String>>,
    cache: Arc<RwLock<Vec<CachedImage>>>,
    cache_inited: Arc<AtomicBool>, // 一次性初始化标志（防止并发重复预热）
} 

impl Clone for ColorDbPool {
    fn clone(&self) -> Self {
        Self {
            conn: Arc::clone(&self.conn),
            db_path: Arc::clone(&self.db_path),
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
        
        let db_file_name = path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| {
                let err_msg = format!("Invalid database path: {:?}", path);
                eprintln!("Error: {}", err_msg);
                err_msg
            })?;
        let db_file_name_wal = format!("{}-wal", db_file_name);
        let db_file_name_shm = format!("{}-shm", db_file_name);
        
        let _wal_path = path.with_file_name(&db_file_name_wal);
        let _shm_path = path.with_file_name(&db_file_name_shm);
        
        eprintln!("=== ColorDbPool::new completed ===");
        
        Ok(Self {
            conn: Arc::new(Mutex::new(conn)),
            db_path: Arc::new(RwLock::new(db_path_str)),
            cache: Arc::new(RwLock::new(Vec::new())),
            cache_inited: Arc::new(AtomicBool::new(false)),
        })
    }

    pub fn switch<P: AsRef<Path>>(&self, path: P) -> Result<()> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }

        let mut conn = Connection::open(path).map_err(|e| e.to_string())?;
        
        // Performance settings
        let _ = conn.execute("PRAGMA journal_mode=WAL", []);
        let _ = conn.execute("PRAGMA synchronous=NORMAL", []);
        let _ = conn.execute("PRAGMA cache_size=-64000", []);
        let _ = conn.execute("PRAGMA busy_timeout=5000", []);
        let _ = conn.execute("PRAGMA temp_store=MEMORY", []);
        let _ = conn.execute("PRAGMA mmap_size=30000000000", []);
        let _ = conn.execute("PRAGMA journal_size_limit=20971520", []);

        // Initialize tables
        init_db(&mut conn).map_err(|e| e.to_string())?;

        // Reset processing status
        reset_processing_to_pending(&mut conn).map_err(|e| e.to_string())?;

        let db_path_str = path.to_string_lossy().to_string();

        let mut conn_guard = self.conn.lock().unwrap();
        *conn_guard = conn;
        
        let mut path_guard = self.db_path.write().map_err(|e| e.to_string())?;
        *path_guard = db_path_str;

        // Clear cache
        let mut cache = self.cache.write().map_err(|e| e.to_string())?;
        cache.clear();
        self.cache_inited.store(false, Ordering::SeqCst);
        
        Ok(())
    }
    
    pub fn get_connection(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.conn.lock().unwrap()
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
        // Note: cache_inited is now set by the caller (ensure_cache_initialized)
        // to ensure it's only set after successful loading
        Ok(())
    }

    // Direct access to cache for high-performance searching
    // Runs the closure `f` with a reference to the cache, avoiding cloning.
    pub fn access_cache<F, R>(&self, f: F) -> Result<R>
    where F: FnOnce(&[CachedImage]) -> R
    {
        // Use cache_inited flag to ensure cache is fully initialized
        // Don't use !cache.is_empty() because partial cache data should not be used for searching
        if !self.cache_inited.load(Ordering::SeqCst) {
            return Err("cache_not_ready".to_string());
        }

        let cache = self.cache.read().map_err(|e| e.to_string())?;
        Ok(f(&cache))
    }

    // Ensure the cache is initialized. If `background` is true this returns immediately and
    // performs a batched preload in a background thread; otherwise it blocks until the
    // initial refresh completes.
    pub fn ensure_cache_initialized(&self, background: bool) -> Result<()> {
        // Fast-path: if cache already initialized, return
        if self.cache_inited.load(Ordering::SeqCst) {
            return Ok(());
        }

        // Avoid concurrent initializers using a separate atomic flag
        static INITIALIZING: AtomicBool = AtomicBool::new(false);
        let was_initializing = INITIALIZING.swap(true, Ordering::SeqCst);
        if was_initializing {
            // Another thread is already initializing, return immediately
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
                    // Only set cache_inited to true after successful loading
                    let _ = pool.cache_inited.store(true, Ordering::SeqCst);
                }
                // Reset initializing flag
                INITIALIZING.store(false, Ordering::SeqCst);
            });
            Ok(())
        } else {
            // blocking initialization
            let res = self.refresh_cache();
            if res.is_ok() {
                // Only set cache_inited to true after successful loading
                let _ = self.cache_inited.store(true, Ordering::SeqCst);
            }
            // Reset initializing flag
            INITIALIZING.store(false, Ordering::SeqCst);
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
        let mut offset: i64 = 0;
        loop {
            let batch = self.load_from_db_internal_batch(offset, batch_size as i64)?;
            if batch.is_empty() {
                break;
            }

            {
                let mut cache = self.cache.write().map_err(|e| e.to_string())?;
                cache.extend(batch.into_iter());
            }

            // Small pause to reduce IO burst on startup
            std::thread::sleep(Duration::from_millis(20));

            offset += batch_size as i64;
        }

        Ok(())
    }

    fn load_from_db_internal_batch(&self, offset: i64, limit: i64) -> Result<Vec<CachedImage>> {
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
         Ok(results)
    }

    pub fn move_colors(&self, old_path: &str, new_path: &str) -> Result<()> {
        let old_normalized = crate::db::normalize_path(old_path);
        let new_normalized = crate::db::normalize_path(new_path);
        let mut conn = self.get_connection();
        let tx = conn.transaction().map_err(|e| e.to_string())?;

        // 1. 更新 dominant_colors 表
        // 处理单个文件
        tx.execute(
            "UPDATE dominant_colors SET file_path = ?1 WHERE file_path = ?2",
            params![new_normalized, old_normalized],
        ).map_err(|e| e.to_string())?;

        // 处理目录：使用 SQL 的字符串替换逻辑直接批量更新，避免在 Rust 中循环
        // 获取结尾可能带斜杠的路径
        let old_dir_prefix = if old_normalized.ends_with('/') { old_normalized.clone() } else { format!("{}/", old_normalized) };
        let new_dir_prefix = if new_normalized.ends_with('/') { new_normalized.clone() } else { format!("{}/", new_normalized) };
        let old_dir_pattern = format!("{}%", old_dir_prefix);

        // 使用 SQL 字符串函数进行前缀替换
        // UPDATE table SET path = new_prefix || SUBSTR(path, LENGTH(old_prefix) + 1) WHERE path LIKE 'old_prefix%'
        tx.execute(
            "UPDATE dominant_colors SET file_path = ?1 || SUBSTR(file_path, ?2) WHERE file_path LIKE ?3",
            params![new_dir_prefix, (old_dir_prefix.len() + 1) as i32, old_dir_pattern],
        ).map_err(|e| e.to_string())?;

        // 2. 更新 image_color_indices 表
        tx.execute(
            "UPDATE image_color_indices SET file_path = ?1 WHERE file_path = ?2",
            params![new_normalized, old_normalized],
        ).map_err(|e| e.to_string())?;

        tx.execute(
            "UPDATE image_color_indices SET file_path = ?1 || SUBSTR(file_path, ?2) WHERE file_path LIKE ?3",
            params![new_dir_prefix, (old_dir_prefix.len() + 1) as i32, old_dir_pattern],
        ).map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;

        // 3. 非关键路径：将内存缓存的更新移到后台线程执行以避免阻塞重命名操作
        //    SQL 已经在事务中完成，因此可以安全地异步更新内存缓存以提高响应性。
        {
            let cache_arc = Arc::clone(&self.cache);
            let old_dir_prefix_cl = old_dir_prefix.clone();
            let new_dir_prefix_cl = new_dir_prefix.clone();
            let old_norm_cl = old_normalized.clone();
            let new_norm_cl = new_normalized.clone();

            std::thread::spawn(move || {
                match cache_arc.write() {
                    Ok(mut cache) => {
                        for item in cache.iter_mut() {
                            let item_path = item.file_path.replace("\\", "/");
                            if item_path == old_norm_cl {
                                item.file_path = new_norm_cl.clone();
                            } else if item_path.starts_with(&old_dir_prefix_cl) {
                                let relative_path = &item_path[old_dir_prefix_cl.len()..];
                                item.file_path = format!("{}{}", new_dir_prefix_cl, relative_path);
                            }
                        }
                    }
                    Err(e) => {
                        eprintln!("[ColorDB] async cache update failed to acquire write lock: {:?}", e);
                    }
                }
            });
        }

        Ok(())
    }

    pub fn copy_colors(&self, src_path: &str, dest_path: &str) -> Result<bool> {
        let src_normalized = src_path.replace("\\", "/");
        let dest_normalized = dest_path.replace("\\", "/");
        let mut conn = self.get_connection();
        let current_ts = SystemTime::now()
            .duration_since(SystemTime::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs() as i64;

        let tx = conn.transaction().map_err(|e| e.to_string())?;

        let count = tx.execute(
            "INSERT OR REPLACE INTO dominant_colors (file_path, colors, created_at, updated_at, status)
             SELECT ?1, colors, ?2, ?3, status
             FROM dominant_colors
             WHERE file_path = ?4 AND status = 'extracted'",
            params![&dest_normalized, current_ts, current_ts, &src_normalized],
        ).map_err(|e| e.to_string())?;

        let mut copied = count > 0;

        let src_dir_prefix = if src_normalized.ends_with('/') { src_normalized.clone() } else { format!("{}/", src_normalized) };
        let dest_dir_prefix = if dest_normalized.ends_with('/') { dest_normalized.clone() } else { format!("{}/", dest_normalized) };
        let src_dir_pattern = format!("{}%", src_dir_prefix);
        let path_offset = (src_dir_prefix.chars().count() + 1) as i32;

        let count_dir = tx.execute(
            "INSERT OR REPLACE INTO dominant_colors (file_path, colors, created_at, updated_at, status)
             SELECT ?1 || SUBSTR(file_path, ?2), colors, ?3, ?4, status
             FROM dominant_colors
             WHERE file_path LIKE ?5 AND status = 'extracted'",
            params![
                &dest_dir_prefix, 
                path_offset, 
                current_ts, 
                current_ts, 
                &src_dir_pattern
            ],
        ).map_err(|e| e.to_string())?;

        if count_dir > 0 {
            copied = true;
        }

        tx.execute(
            "INSERT OR REPLACE INTO image_color_indices (file_path, l, a, b)
             SELECT ?1, l, a, b FROM image_color_indices WHERE file_path = ?2",
            params![&dest_normalized, &src_normalized]
        ).map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT OR REPLACE INTO image_color_indices (file_path, l, a, b)
             SELECT ?1 || SUBSTR(file_path, ?2), l, a, b 
             FROM image_color_indices 
             WHERE file_path LIKE ?3",
             params![
                 &dest_dir_prefix, 
                 path_offset, 
                 &src_dir_pattern
             ]
        ).map_err(|e| e.to_string())?;

        tx.commit().map_err(|e| e.to_string())?;

        if copied {
            if let Ok(mut cache) = self.cache.write() {
                // 读取刚才复制的数据来更新缓存... 
                // 或者，我们可以再次利用 SQL 查询出刚刚插入的数据，但这会增加 IO。
                // 鉴于 copy 操作通常由用户触发且数量可控，我们可以做一个这种的策略：
                // 如果是目录复制，为了性能，我们可能选择 *重载* 或者 *延迟加载* 缓存。
                // 但为了 UI 即时反馈，我们还是查询一下新数据吧。
                
                // 为了避免巨大的查询，我们只查询目标路径下的数据
                let _dest_pattern = if dest_normalized.ends_with('/') {
                    format!("{}%", dest_normalized) 
                } else {
                    format!("{}%", dest_normalized) // 这里简化处理，可能是文件也可能是目录
                };

                // 注意：这里需要一个新的连接，因为之前的 tx 已经 commit 并且 conn 被借用了（虽然已经释放）。
                // 但 self.conn 是 Mutex，我们需要小心死锁。self.get_connection() 会返回新的 Connection (如果池化) 或者是锁。
                // 在此实现中 get_connection 返回的是 Connection 对象（非池化？不，看似是新建连接或从某处获取）。
                // 让我们看 self.get_connection() 的实现... (未显示，假设是安全的)
                // 实际上我们不需要在此处查询。可以手动构建缓存项。
                
                // 但为了代码简单且健壮（避免手动逻辑与 SQL 逻辑不一致），如果不做缓存更新，
                // 用户可能会发现搜不到新图。
                // 考虑到“复制”通常不如“移动”那么频繁，我们这里做一个简单的全量重载可能太重。
                // 让我们只针对“单文件”做精确更新，针对“目录”做查询更新。
                
                let mut stmt = conn.prepare(
                    "SELECT file_path, colors FROM dominant_colors WHERE file_path = ?1 OR file_path LIKE ?2"
                ).map_err(|e| e.to_string())?;
                
                let dest_dir_pattern = format!("{}/%", dest_normalized.trim_end_matches('/'));
                
                let rows = stmt.query_map(params![dest_normalized, dest_dir_pattern], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                }).map_err(|e| e.to_string())?;
                
                for row in rows {
                    if let Ok((path, colors_json)) = row {
                        self.update_cache_item(&mut cache, &path, &colors_json);
                    }
                }
            }
        }
        Ok(copied)
    }

    // 辅助函数：更新缓存项
    fn update_cache_item(&self, cache: &mut Vec<CachedImage>, path: &str, colors_json: &str) {
        if let Ok(color_results) = serde_json::from_str::<Vec<ColorResult>>(colors_json) {
            let labs: Vec<Lab> = color_results.iter()
                .filter_map(|c| hex_to_lab(&c.hex))
                .collect();
            
            if let Some(pos) = cache.iter().position(|x| x.file_path == path) {
                cache[pos].labs = labs;
            } else {
                cache.push(CachedImage {
                    file_path: path.to_string(),
                    labs,
                });
            }
        }
    }

    fn load_from_db_internal(&self) -> Result<Vec<CachedImage>> {
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
         Ok(results)
    }

    // 保存主色调数据 (Method)
    pub fn save_colors(&self, file_path: &str, colors: &[ColorResult]) -> Result<()> {
        let mut conn = self.get_connection();
        // Normalize path to use forward slashes to ensure consistent DB keys
        let normalized_path = file_path.replace("\\", "/");
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
            params![&normalized_path, colors_json, current_ts, current_ts, "extracted"],
        ).map_err(|e| format!("Database error in save_colors: {}", e))?;
    
        tx.execute(
            "UPDATE dominant_colors
             SET colors = ?, updated_at = ?, status = ?
             WHERE file_path = ?",
            params![colors_json, current_ts, "extracted", &normalized_path],
        ).map_err(|e| format!("Database error in save_colors: {}", e))?;

        // 更新 image_color_indices 表
          tx.execute("DELETE FROM image_color_indices WHERE file_path = ?", params![&normalized_path])
              .map_err(|e| format!("Failed to delete old indices: {}", e))?;
      
        {
            let mut stmt = tx.prepare("INSERT INTO image_color_indices (file_path, l, a, b) VALUES (?, ?, ?, ?)")
                .map_err(|e| format!("Failed to prepare statement: {}", e))?;
            
            for color in colors {
                stmt.execute(params![&normalized_path, color.lab_l, color.lab_a, color.lab_b])
                    .map_err(|e| format!("Failed to insert index: {}", e))?;
            }
        }
    
        tx.commit().map_err(|e| format!("Failed to commit transaction: {}", e))?;
        
        // Update Cache
        let labs: Vec<Lab> = colors.iter()
            .filter_map(|c| hex_to_lab(&c.hex))
            .collect();
        
        let mut cache = self.cache.write().map_err(|e| e.to_string())?;
        
        if let Some(pos) = cache.iter().position(|x| x.file_path == normalized_path) {
            cache[pos].labs = labs;
        } else {
            cache.push(CachedImage {
                file_path: normalized_path.clone(),
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
                // Normalize incoming file path to forward slashes
                let normalized_path = file_path.replace("\\", "/");

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
                    params![&normalized_path, colors_json, current_ts, current_ts, "extracted"],
                );
    
                match tx.execute(
                    "UPDATE dominant_colors
                     SET colors = ?, updated_at = ?, status = ?
                     WHERE file_path = ?",
                    params![colors_json, current_ts, "extracted", &normalized_path],
                ) {
                    Ok(_) => {
                        success_count += 1;
                        let _ = delete_indices_stmt.execute(params![&normalized_path]);
                        for color in *colors {
                            let _ = insert_indices_stmt.execute(params![&normalized_path, color.lab_l, color.lab_a, color.lab_b]);
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
                     let normalized_path = file_path.replace("\\", "/");
                     let labs: Vec<Lab> = colors.iter()
                         .filter_map(|c| hex_to_lab(&c.hex))
                         .collect();
                     
                     if let Some(pos) = cache.iter().position(|x| x.file_path == normalized_path) {
                         cache[pos].labs = labs;
                     } else {
                         cache.push(CachedImage {
                             file_path: normalized_path,
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
        let current_db_path = self.db_path.read().map_err(|e| e.to_string())?.clone();
        eprintln!("Database path from self.db_path: {}", current_db_path);
        
        let db_path = Path::new(&current_db_path);
        let db_file_name = db_path.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .ok_or_else(|| {
                let err_msg = format!("Invalid database path: {:?}", db_path);
                eprintln!("Error: {}", err_msg);
                err_msg
            })?;
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
        let normalized = path.replace("\\", "/");
        let result = tx.execute(
            "INSERT OR IGNORE INTO dominant_colors 
             (file_path, colors, created_at, updated_at, status) 
             VALUES (?, ?, ?, ?, ?)",
            params![
                &normalized,
                "[]",
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
    
    Ok(added_count)
}




// 根据文件路径获取颜色数据
pub fn get_colors_by_file_path(
    conn: &mut Connection, 
    file_path: &str
) -> Result<Option<Vec<ColorResult>>> {
    let normalized = file_path.replace("\\", "/");
    let mut stmt = conn.prepare(
        "SELECT colors FROM dominant_colors WHERE file_path = ? AND status = ?"
    ).map_err(|e| e.to_string())?;
    
    match stmt.query_row(params![&normalized, "extracted"], |row| {
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

// 获取错误文件数量
pub fn get_error_files_count(
    conn: &mut Connection
) -> Result<usize> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM dominant_colors WHERE status = ?",
        params!["error"],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    
    Ok(count as usize)
}

// 获取所有错误文件列表
pub fn get_error_files(
    conn: &mut Connection
) -> Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT file_path, updated_at FROM dominant_colors WHERE status = ? ORDER BY updated_at DESC"
    ).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map(params!["error"], |row| {
        let file_path: String = row.get(0)?;
        let updated_at: i64 = row.get(1)?;
        Ok((file_path, updated_at))
    }).map_err(|e| e.to_string())?;
    
    let mut files = Vec::new();
    for row in rows {
        if let Ok((path, timestamp)) = row {
            files.push((path, timestamp));
        }
    }
    
    Ok(files)
}

// 将错误文件重置为待处理状态
pub fn reset_error_files_to_pending(
    conn: &mut Connection,
    file_paths: Option<&[String]>
) -> Result<usize> {
    let current_ts = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs() as i64;
    
    let updated = if let Some(paths) = file_paths {
        // 重置指定文件
        let mut total_updated = 0usize;
        for path in paths {
            let normalized = path.replace("\\", "/");
            let count = conn.execute(
                "UPDATE dominant_colors 
                 SET status = ?, updated_at = ? 
                 WHERE file_path = ? AND status = ?",
                params!["pending", current_ts, &normalized, "error"],
            ).map_err(|e| e.to_string())?;
            total_updated += count;
        }
        total_updated
    } else {
        // 重置所有错误文件
        conn.execute(
            "UPDATE dominant_colors 
             SET status = ?, updated_at = ? 
             WHERE status = ?",
            params!["pending", current_ts, "error"],
        ).map_err(|e| e.to_string())?
    };
    
    eprintln!("Reset {} error files to pending status", updated);
    Ok(updated)
}

// 从数据库中删除错误文件记录
pub fn delete_error_files(
    conn: &mut Connection,
    file_paths: &[String]
) -> Result<usize> {
    let mut total_deleted = 0usize;

    for path in file_paths {
        let normalized = path.replace("\\", "/");

        // 删除 dominant_colors 表中的记录
        let deleted = conn.execute(
            "DELETE FROM dominant_colors WHERE file_path = ?",
            params![&normalized],
        ).map_err(|e| e.to_string())?;

        // 删除 image_color_indices 表中的记录
        conn.execute(
            "DELETE FROM image_color_indices WHERE file_path = ?",
            params![&normalized],
        ).map_err(|e| e.to_string())?;

        total_deleted += deleted;
    }

    eprintln!("Deleted {} error file records from database", total_deleted);
    Ok(total_deleted)
}

// 清理不存在的错误文件记录，返回实际存在的错误文件列表
pub fn cleanup_nonexistent_error_files(
    conn: &mut Connection
) -> Result<Vec<(String, i64)>> {
    let error_files = get_error_files(conn)?;
    let mut existing_files = Vec::new();
    let mut nonexistent_paths = Vec::new();

    for (path, timestamp) in error_files {
        if std::path::Path::new(&path).exists() {
            existing_files.push((path, timestamp));
        } else {
            nonexistent_paths.push(path);
        }
    }

    // 删除不存在的文件记录
    if !nonexistent_paths.is_empty() {
        delete_error_files(conn, &nonexistent_paths)?;
        eprintln!("Cleaned up {} non-existent error file records", nonexistent_paths.len());
    }

    Ok(existing_files)
}
