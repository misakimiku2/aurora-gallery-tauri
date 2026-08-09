use crate::color_db;
use crate::color_extractor;
use crate::color_worker;
use std::collections::HashMap;
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
pub async fn get_dominant_colors(
    file_path: String, 
    count: usize, 
    thumbnail_path: Option<String>,
    app: tauri::AppHandle
) -> Result<Vec<color_extractor::ColorResult>, String> {
    use std::sync::Arc;
    
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    let file_path_for_db = file_path.clone();
    
    let db_result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        color_db::get_colors_by_file_path(&mut conn, &file_path_for_db)
    }).await.map_err(|e| format!("Failed to execute database query: {}", e))?;
    
    if let Ok(Some(colors)) = db_result {
        if !colors.is_empty() {
            return Ok(colors);
        }
    }
    
    let file_path_for_load = file_path.clone();
    let thumbnail_path_for_load = thumbnail_path.clone();

    let results = tokio::task::spawn_blocking(move || {
        let img = if let Some(tp) = thumbnail_path_for_load {
             image::open(tp).map_err(|e| e.to_string()).or_else(|_| color_worker::load_and_resize_image_optimized(&file_path_for_load, None))
        } else {
             color_worker::load_and_resize_image_optimized(&file_path_for_load, None)
        }.map_err(|e| format!("Failed to load image: {}", e))?;
        
        let colors = color_extractor::get_dominant_colors(&img, count);
        Ok::<Vec<color_extractor::ColorResult>, String>(colors)
    }).await.map_err(|e| e.to_string())??;

    let colors = results;
    
    if !colors.is_empty() {
        let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
        let file_path_for_save = file_path.clone();
        let colors_clone = colors.clone();
        
        let _ = tokio::task::spawn_blocking(move || {
            {
                let mut conn = pool.get_connection();
                match color_db::get_colors_by_file_path(&mut conn, &file_path_for_save) {
                    Ok(None) => {
                        let _ = color_db::add_pending_files(&mut conn, &[file_path_for_save.clone()]);
                    },
                    _ => {}
                }
            }
            
            pool.save_colors(&file_path_for_save, &colors_clone)
        }).await;
    }
    
    Ok(colors)
}

#[tauri::command]
pub async fn batch_get_colors(
    file_paths: Vec<String>,
    app: tauri::AppHandle,
) -> Result<HashMap<String, Vec<String>>, String> {
    let start = std::time::Instant::now();
    let total_paths = file_paths.len();
    if file_paths.is_empty() {
        return Ok(HashMap::new());
    }

    let pool = app.state::<std::sync::Arc<color_db::ColorDbPool>>().inner().clone();

    let result = tokio::task::spawn_blocking(move || {
        // 使用独立只读连接，避免与后台缓存预热线程争抢同一把 Mutex<Connection>，
        // 否则数万张图查询会被预热进程拖慢数秒。
        let mut conn = pool.open_read_connection()?;
        let mut all = std::collections::HashMap::new();
        // 分块查询：SQLite 单个 IN 子句的参数不能超过上限（默认 32766），
        // 大目录（数万张图）一次性全传会触发 "variable number must be between ?1 and ?32766"。
        const BATCH_SIZE: usize = 500;
        for chunk in file_paths.chunks(BATCH_SIZE) {
            match color_db::get_colors_by_file_paths(&mut conn, chunk) {
                Ok(map) => all.extend(map),
                Err(e) => return Err(e),
            }
        }
        Ok::<std::collections::HashMap<String, Vec<String>>, String>(all)
    }).await.map_err(|e| format!("Failed to execute database query: {}", e))?;

    let r = result.map_err(|e| format!("批量获取颜色数据失败: {}", e))?;
    log::info!("[ColorCommands] batch_get_colors: {} paths -> {} results in {:?}", total_paths, r.len(), start.elapsed());
    Ok(r)
}

#[tauri::command]
pub async fn add_pending_files_to_db(
    app: tauri::AppHandle,
    file_paths: Vec<String>
) -> Result<usize, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    let batch_size = 500;
    
    let task_result = tokio::task::spawn_blocking(move || {
        let mut total = 0usize;
        let mut conn = pool.get_connection();
        
        for chunk in file_paths.chunks(batch_size) {
            let chunk_vec: Vec<String> = chunk.iter().cloned().collect();
            
            match color_db::add_pending_files(&mut conn, &chunk_vec) {
                Ok(count) => total += count,
                Err(e) => eprintln!("Database error when adding batch: {}", e),
            }
        }
        
        Ok::<usize, String>(total)
    }).await;
    
    match task_result {
        Ok(inner_result) => inner_result,
        Err(e) => Err(format!("Task join error: {}", e)),
    }
}
