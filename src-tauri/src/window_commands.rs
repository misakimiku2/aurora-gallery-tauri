use crate::file_types::SavedWindowState;
use std::fs;
use std::path::Path;
use tauri::Manager;

pub fn get_window_state_path(app_handle: &tauri::AppHandle) -> std::path::PathBuf {
    app_handle.path().app_data_dir().unwrap_or_else(|_| std::path::PathBuf::from(".")).join("window_state.json")
}

pub fn get_initial_db_paths(app_handle: &tauri::AppHandle) -> (std::path::PathBuf, std::path::PathBuf) {
    let app_data_dir = app_handle.path().app_data_dir()
        .expect("Failed to get app data directory");
    
    let config_path = app_data_dir.join("user_data.json");
    
    if config_path.exists() {
        if let Ok(json_str) = fs::read_to_string(config_path) {
            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&json_str) {
                if let Some(root_paths) = data.get("rootPaths").and_then(|v| v.as_array()) {
                    if let Some(first_root) = root_paths.get(0).and_then(|v| v.as_str()) {
                        let root = Path::new(first_root);
                        let aurora_dir = root.join(".aurora");
                        return (aurora_dir.join("colors.db"), aurora_dir.join("metadata.db"));
                    }
                }
            }
        }
    }
    
    (app_data_dir.join("colors.db"), app_data_dir.join("metadata.db"))
}

pub fn save_window_state(app_handle: &tauri::AppHandle) {
    let window = match app_handle.get_webview_window("main") {
        Some(w) => w,
        None => return,
    };

    let path = get_window_state_path(app_handle);
    let mut state = if path.exists() {
        fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<SavedWindowState>(&s).ok())
            .unwrap_or(SavedWindowState::default())
    } else {
        SavedWindowState::default()
    };

    if window.is_maximized().unwrap_or(false) {
        state.maximized = true;
    } else {
        state.maximized = false;
        if !window.is_minimized().unwrap_or(false) {
            if let (Ok(pos), Ok(size), Ok(factor)) = (window.outer_position(), window.inner_size(), window.scale_factor()) {
                let l_pos = pos.to_logical::<f64>(factor);
                let l_size = size.to_logical::<f64>(factor);
                state.x = l_pos.x;
                state.y = l_pos.y;
                state.width = l_size.width;
                state.height = l_size.height;
            }
        }
    }
    
    if let Ok(json) = serde_json::to_string(&state) {
        let _ = fs::write(path, json);
    }
}

#[tauri::command]
pub async fn hide_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    save_window_state(&app_handle);
    let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
    window.hide().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn show_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
    window.show().map_err(|e| e.to_string())?;
    window.set_focus().map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_window_min_size(app_handle: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
    window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize { width, height })))
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn exit_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    save_window_state(&app_handle);
    app_handle.exit(0);
    Ok(())
}
