use crate::color_db;
use crate::color_extractor;
use crate::color_worker;
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
