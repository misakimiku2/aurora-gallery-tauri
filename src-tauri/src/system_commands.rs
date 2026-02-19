use base64::{engine::general_purpose, Engine as _};
use std::collections::HashMap;
use std::fs;
use std::path::Path;

#[tauri::command]
pub async fn get_default_paths() -> Result<HashMap<String, String>, String> {
    use std::env;
    
    let mut paths = HashMap::new();
    
    let home = env::var("HOME")
        .or_else(|_| env::var("USERPROFILE"))
        .unwrap_or_else(|_| "C:\\Users\\User".to_string());
    
    let resource_root = if cfg!(windows) {
        format!("{}\\Pictures\\AuroraGallery", home)
    } else if cfg!(target_os = "macos") {
        format!("{}/Pictures/AuroraGallery", home)
    } else {
        format!("{}/Pictures/AuroraGallery", home)
    };
    
    let cache_root = if cfg!(windows) {
        format!("{}\\AppData\\Local\\Aurora\\Cache", home)
    } else if cfg!(target_os = "macos") {
        format!("{}/Library/Application Support/Aurora/Cache", home)
    } else {
        format!("{}/.local/share/aurora/cache", home)
    };
    
    paths.insert("resourceRoot".to_string(), resource_root);
    paths.insert("cacheRoot".to_string(), cache_root);
    
    Ok(paths)
}

#[tauri::command]
pub async fn open_path(path: String, is_file: Option<bool>) -> Result<(), String> {
    use std::process::Command;
    #[cfg(target_os = "windows")]
    use std::os::windows::process::CommandExt;
    
    let path_obj = Path::new(&path);
    
    if !path_obj.exists() {
        return Err(format!("Path does not exist: {}", path));
    }
    
    let absolute_path = if path_obj.is_absolute() {
        path.clone()
    } else {
        match std::env::current_dir() {
            Ok(current_dir) => {
                match path_obj.canonicalize() {
                    Ok(canonical) => canonical.to_string_lossy().to_string(),
                    Err(_) => {
                        current_dir.join(path_obj).to_string_lossy().to_string()
                    }
                }
            }
            Err(_) => path.clone(),
        }
    };
    
    let abs_path_obj = Path::new(&absolute_path);
    
    let is_context_menu = is_file.is_some();
    
    println!("open_path: path={}, is_file={:?}, is_context_menu={}", 
             path, is_file, is_context_menu);
    
    let result = if cfg!(windows) {
        #[cfg(target_os = "windows")]
        {
            let win_path = absolute_path.replace("/", "\\");
            
            if is_context_menu {
                let clean_path = win_path.trim_end_matches('\\');
                
                let raw_arg = format!("/select, \"{}\"", clean_path);
                
                println!("Windows command: explorer.exe [raw_arg] {}", raw_arg);
                
                Command::new("explorer.exe")
                    .raw_arg(raw_arg)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .stdin(std::process::Stdio::null())
                    .spawn()
                    .map(|_| ())
            } else {
                println!("Windows command: explorer.exe \"{}\"", win_path);
                Command::new("explorer.exe")
                    .arg(win_path)
                    .stdout(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .stdin(std::process::Stdio::null())
                    .spawn()
                    .map(|_| ())
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
             Ok(())
        }
    } else if cfg!(target_os = "macos") {
        if is_context_menu {
            println!("macOS command: open -R \"{}\"", absolute_path);
            Command::new("open")
                .arg("-R")
                .arg(&absolute_path)
                .spawn()
                .map(|_| ())
        } else {
            println!("macOS command: open \"{}\"", absolute_path);
            Command::new("open")
                .arg(&absolute_path)
                .spawn()
                .map(|_| ())
        }
    } else {
        let target_path = if is_context_menu {
            match abs_path_obj.parent() {
                Some(parent) => parent.to_string_lossy().to_string(),
                None => absolute_path.clone(),
            }
        } else {
            absolute_path.clone()
        };
        
        println!("Linux command: xdg-open \"{}\"", target_path);
        Command::new("xdg-open")
            .arg(target_path)
            .spawn()
            .map(|_| ())
    };
    
    match result {
        Ok(_) => {
            println!("Successfully started file manager for path: {}", absolute_path);
            Ok(())
        },
        Err(e) => {
            let error_msg = format!("Failed to start file manager for '{}': {}", absolute_path, e);
            println!("{}", error_msg);
            Err(error_msg)
        }
    }
}

#[tauri::command]
pub async fn read_file_as_base64(file_path: String) -> Result<Option<String>, String> {
    if !Path::new(&file_path).exists() {
        return Ok(None);
    }
    
    let file_bytes = fs::read(&file_path)
        .map_err(|e| format!("Failed to read file: {}", e))?;
    
    let extension = Path::new(&file_path)
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_lowercase())
        .unwrap_or_default();
    
    let mime_type = match extension.as_str() {
        "jpg" | "jpeg" => "image/jpeg",
        "png" => "image/png",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "tiff" | "tif" => "image/tiff",
        _ => "image/jpeg",
    };
    
    let base64_str = general_purpose::STANDARD.encode(&file_bytes);
    Ok(Some(format!("data:{};base64,{}", mime_type, base64_str)))
}

#[tauri::command]
pub async fn open_external_link(url: String) -> Result<(), String> {
    use std::process::Command;
    
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &url])
            .spawn()
            .map_err(|e| format!("Failed to open link: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open link: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("Failed to open link: {}", e))?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn proxy_http_request(
    url: String,
    method: String,
    headers: HashMap<String, String>,
    body: Option<String>
) -> Result<String, String> {
    let client = reqwest::Client::new();
    
    let mut request = match method.to_uppercase().as_str() {
        "GET" => client.get(&url),
        "POST" => client.post(&url),
        "PUT" => client.put(&url),
        "DELETE" => client.delete(&url),
        _ => return Err(format!("Unsupported HTTP method: {}", method))
    };
    
    for (key, value) in headers {
        request = request.header(&key, value);
    }
    
    if let Some(body_content) = body {
        request = request.body(body_content);
    }
    
    let response = request.send().await.map_err(|e| format!("Request failed: {}", e))?;
    
    let status = response.status();
    let text = response.text().await.map_err(|e| format!("Failed to read response: {}", e))?;
    
    if status.is_success() {
        Ok(text)
    } else {
        Err(format!("HTTP {}: {}", status, text))
    }
}
