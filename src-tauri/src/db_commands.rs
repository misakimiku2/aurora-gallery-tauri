use crate::color_db;
use crate::db::{self, normalize_path, AppDbPool};
use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;

#[tauri::command]
pub async fn force_wal_checkpoint(app: tauri::AppHandle) -> Result<bool, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    let result = tokio::task::spawn_blocking(move || {
        pool.force_wal_checkpoint()
    }).await.map_err(|e| format!("Failed to execute WAL checkpoint: {}", e))?;
    
    result.map_err(|e| format!("WAL checkpoint error: {}", e))?;
    Ok(true)
}

#[tauri::command]
pub async fn get_wal_info(app: tauri::AppHandle) -> Result<(i64, i64), String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    let result = tokio::task::spawn_blocking(move || {
        pool.get_wal_info()
    }).await.map_err(|e| format!("Failed to get WAL info: {}", e))?;
    
    result
}

#[tauri::command]
pub async fn save_user_data(app_handle: tauri::AppHandle, data: serde_json::Value) -> Result<bool, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir).map_err(|e| e.to_string())?;
    }
    
    let config_path = app_data_dir.join("user_data.json");
    let json = serde_json::to_string_pretty(&data).map_err(|e| e.to_string())?;
    fs::write(config_path, json).map_err(|e| e.to_string())?;
    
    Ok(true)
}

#[tauri::command]
pub async fn load_user_data(app_handle: tauri::AppHandle) -> Result<Option<serde_json::Value>, String> {
    let app_data_dir = app_handle.path().app_data_dir().map_err(|e| e.to_string())?;
    let config_path = app_data_dir.join("user_data.json");
    
    if !config_path.exists() {
        return Ok(None);
    }
    
    let json_str = fs::read_to_string(config_path).map_err(|e| e.to_string())?;
    let data = serde_json::from_str(&json_str).map_err(|e| e.to_string())?;
    
    Ok(Some(data))
}

#[tauri::command]
pub fn db_get_all_people(pool: tauri::State<AppDbPool>) -> Result<Vec<db::persons::Person>, String> {
    let conn = pool.get_connection();
    db::persons::get_all_people(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_upsert_person(pool: tauri::State<AppDbPool>, person: db::persons::Person) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::upsert_person(&conn, &person).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_person(pool: tauri::State<AppDbPool>, id: String) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::delete_person(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_update_person_avatar(
    pool: tauri::State<AppDbPool>,
    person_id: String,
    cover_file_id: String,
    face_box: Option<db::persons::FaceBox>
) -> Result<(), String> {
    let conn = pool.get_connection();
    db::persons::update_person_avatar(&conn, &person_id, &cover_file_id, face_box.as_ref()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_get_all_topics(pool: tauri::State<AppDbPool>) -> Result<Vec<db::topics::Topic>, String> {
    let conn = pool.get_connection();
    db::topics::get_all_topics(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_upsert_topic(pool: tauri::State<AppDbPool>, topic: db::topics::Topic) -> Result<(), String> {
    let conn = pool.get_connection();
    db::topics::upsert_topic(&conn, &topic).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn db_delete_topic(pool: tauri::State<AppDbPool>, id: String) -> Result<(), String> {
    let conn = pool.get_connection();
    db::topics::delete_topic(&conn, &id).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn db_upsert_file_metadata(
    pool: tauri::State<'_, AppDbPool>, 
    mut metadata: db::file_metadata::FileMetadata
) -> Result<(), String> {
    metadata.path = normalize_path(&metadata.path);
    
    let conn = pool.get_connection();
    db::file_metadata::upsert_file_metadata(&conn, &metadata).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn switch_root_database(
    new_root_path: String,
    app_db_pool: tauri::State<'_, AppDbPool>,
    color_db_pool: tauri::State<'_, Arc<color_db::ColorDbPool>>,
) -> Result<(), String> {
    let root = Path::new(&new_root_path);
    
    let aurora_dir = root.join(".aurora");
    
    let metadata_db_path = aurora_dir.join("metadata.db");
    let colors_db_path = aurora_dir.join("colors.db");
    
    app_db_pool.switch(&metadata_db_path)?;
    
    color_db_pool.switch(&colors_db_path)?;
    
    let _ = color_db_pool.ensure_cache_initialized_async();
    
    Ok(())
}

#[tauri::command]
pub async fn get_color_db_stats(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        
        let total = color_db::get_pending_files_count(&mut conn).unwrap_or(0)
            + color_db::get_processing_files_count(&mut conn).unwrap_or(0)
            + color_db::get_extracted_files_count(&mut conn).unwrap_or(0)
            + color_db::get_error_files_count(&mut conn).unwrap_or(0);
        
        let extracted = color_db::get_extracted_files_count(&mut conn).unwrap_or(0);
        let error = color_db::get_error_files_count(&mut conn).unwrap_or(0);
        let pending = color_db::get_pending_files_count(&mut conn).unwrap_or(0);
        let processing = color_db::get_processing_files_count(&mut conn).unwrap_or(0);
        
        let (db_size, wal_size) = pool.get_db_file_sizes().unwrap_or((0, 0));
        
        serde_json::json!({
            "total": total,
            "extracted": extracted,
            "error": error,
            "pending": pending,
            "processing": processing,
            "dbSize": db_size,
            "walSize": wal_size
        })
    }).await.map_err(|e| format!("Failed to get color db stats: {}", e))?;
    
    Ok(result)
}

#[tauri::command]
pub async fn get_color_db_error_files(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();

    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        let error_files = color_db::cleanup_nonexistent_error_files(&mut conn)
            .unwrap_or_default();

        error_files.into_iter().map(|(path, timestamp)| {
            serde_json::json!({
                "path": path,
                "timestamp": timestamp
            })
        }).collect::<Vec<_>>()
    }).await.map_err(|e| format!("Failed to get error files: {}", e))?;

    Ok(result)
}

#[tauri::command]
pub async fn retry_color_extraction(
    app: tauri::AppHandle,
    file_paths: Option<Vec<String>>
) -> Result<usize, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        
        let reset_count = if let Some(paths) = file_paths.as_ref() {
            color_db::reset_error_files_to_pending(&mut conn, Some(paths))
        } else {
            color_db::reset_error_files_to_pending(&mut conn, None)
        };
        
        reset_count
    }).await.map_err(|e| format!("Failed to retry color extraction: {}", e))?;
    
    result.map_err(|e| e)
}

#[tauri::command]
pub async fn delete_color_db_error_files(
    app: tauri::AppHandle,
    file_paths: Vec<String>
) -> Result<usize, String> {
    let pool = app.state::<Arc<color_db::ColorDbPool>>().inner().clone();
    
    let result = tokio::task::spawn_blocking(move || {
        let mut conn = pool.get_connection();
        
        color_db::delete_error_files(&mut conn, &file_paths)
    }).await.map_err(|e| format!("Failed to delete color db error files: {}", e))?;
    
    result.map_err(|e| e)
}
