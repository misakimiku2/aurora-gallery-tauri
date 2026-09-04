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
    
    #[cfg(target_os = "android")]
    {
        return (app_data_dir.join("colors.db"), app_data_dir.join("metadata.db"));
    }

    #[cfg(not(target_os = "android"))]
    {
        let config_path = app_data_dir.join("user_data.json");
        
        if config_path.exists() {
            if let Ok(json_str) = fs::read_to_string(&config_path) {
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
}

#[cfg(not(target_os = "android"))]
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

#[cfg(target_os = "android")]
pub fn save_window_state(_app_handle: &tauri::AppHandle) {
    // No-op on Android
}

#[tauri::command]
pub async fn hide_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        save_window_state(&app_handle);
        let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn show_window(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
        window.show().map_err(|e| e.to_string())?;
        window.set_focus().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn set_window_min_size(app_handle: tauri::AppHandle, width: f64, height: f64) -> Result<(), String> {
    #[cfg(not(target_os = "android"))]
    {
        let window = app_handle.get_webview_window("main").ok_or("Window not found")?;
        window.set_min_size(Some(tauri::Size::Logical(tauri::LogicalSize { width, height })))
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn exit_app(app_handle: tauri::AppHandle) -> Result<(), String> {
    save_window_state(&app_handle);
    app_handle.exit(0);
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// 主窗口画面截图（设置弹窗低负载背景）
//
// 背景：图标档位调小后主网格同屏数百张卡片占满 WebView2 合成器预算，设置弹窗打开时
// 底层被 content-visibility:hidden（释放 GPU）。为避免底层变成空白，在主界面无弹窗时
// 把主窗口画面截成一张静态图，垫在弹窗下层（半透明遮罩+毛玻璃效果与原来一致）。
//
// 实现：WebView2 官方 CapturePreview（在 GPU 合成之后异步抓帧），比 PrintWindow 快且稳，
// 也能忠实包含 asset:// 缩略图等所有渲染内容（前端 html2canvas 会因跨源 canvas 污染失败）。
// 通过 tauri::WebviewWindow::with_webview 在 WebView2 UI 线程取得 ICoreWebView2Controller，
// 再取 ICoreWebView2 调用 CapturePreview；完成回调经 mpsc 返回 JPEG 字节。
// completed handler 的保活遵循 WebView2 COM 惯例：异步操作期间由 WebView2 持有引用，
// 本地 drop 后回调仍会正常触发（微软 C++ 示例同为局部对象用法）。
#[cfg(windows)]
#[tauri::command]
pub async fn capture_window_snapshot(app_handle: tauri::AppHandle) -> Result<String, String> {
    use base64::{engine::general_purpose, Engine as _};
    use std::sync::mpsc;
    use tauri::Manager;
    use webview2_com::Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG;
    use webview2_com::CapturePreviewCompletedHandler;
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::IStream;
    use windows::Win32::System::Com::StructuredStorage::{
        CreateStreamOnHGlobal, GetHGlobalFromStream,
    };
    use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};

    fn stream_to_vec(stream: IStream) -> windows::core::Result<Vec<u8>> {
        let hglobal: HGLOBAL = unsafe { GetHGlobalFromStream(&stream)? };
        let size = unsafe { GlobalSize(hglobal) };
        let ptr = unsafe { GlobalLock(hglobal) };
        if ptr.is_null() {
            return Err(windows::core::Error::from_win32());
        }
        let mut buf = vec![0u8; size];
        unsafe {
            std::ptr::copy_nonoverlapping(ptr as *const u8, buf.as_mut_ptr(), size);
        }
        let _ = unsafe { GlobalUnlock(hglobal) };
        Ok(buf)
    }

    let window = app_handle
        .get_webview_window("main")
        .ok_or("main window not found")?;

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();

    // with_webview 把闭包投递到 WebView2 UI 线程执行：controller 必须在创建它的线程使用。
    window
        .with_webview(move |webview| {
            let controller = webview.controller();

            // 内存流：CapturePreview 完成后把图片字节写入该流（fDeleteOnRelease = true）
            let stream: IStream = match unsafe {
                CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true)
            } {
                Ok(s) => s,
                Err(e) => {
                    let _ = tx.send(Err(format!("CreateStreamOnHGlobal: {e:?}")));
                    return;
                }
            };
            let stream_for_handler = stream.clone();

            // 获取 ICoreWebView2（CapturePreview 定义在其上，而非 controller）
            let core_webview = match unsafe { controller.CoreWebView2() } {
                Ok(w) => w,
                Err(e) => {
                    let _ = tx.send(Err(format!("CoreWebView2: {e:?}")));
                    return;
                }
            };

            let tx_on_error = tx.clone();
            let completed = CapturePreviewCompletedHandler::create(Box::new(
                move |result: windows::core::Result<()>| -> windows::core::Result<()> {
                    let out = result
                        .map_err(|e| format!("{e:?}"))
                        .and_then(|_| {
                            stream_to_vec(stream_for_handler).map_err(|e| format!("{e:?}"))
                        });
                    let _ = tx.send(out);
                    Ok(())
                },
            ));

            if let Err(e) = unsafe {
                core_webview.CapturePreview(COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_JPEG, &stream, &completed)
            } {
                let _ = tx_on_error.send(Err(format!("CapturePreview: {e:?}")));
            }
        })
        .map_err(|e| e.to_string())?;

    let bytes = rx
        .recv_timeout(std::time::Duration::from_secs(6))
        .map_err(|_| "capture preview timeout".to_string())?
        .map_err(|e| e)?;

    Ok(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

#[cfg(not(windows))]
#[tauri::command]
pub fn capture_window_snapshot(_app_handle: tauri::AppHandle) -> Result<String, String> {
    Err("capture_window_snapshot is only supported on Windows".into())
}
