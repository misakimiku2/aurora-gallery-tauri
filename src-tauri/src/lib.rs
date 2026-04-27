pub mod color_extractor;
pub mod color_db;
pub mod color_worker;
pub mod db;
pub mod color_search;
pub mod thumbnail;
pub mod file_types;
pub mod image_utils;
pub mod scanner;
pub mod file_operations;
pub mod db_commands;
pub mod system_commands;
pub mod window_commands;
pub mod color_commands;

#[cfg(not(target_os = "android"))]
pub mod clip;
#[cfg(not(target_os = "android"))]
pub mod clip_commands;
#[cfg(not(target_os = "android"))]
pub mod work_extractor;
#[cfg(not(target_os = "android"))]
pub mod lan_share;
#[cfg(not(target_os = "android"))]
pub mod lan_share_commands;
#[cfg(not(target_os = "android"))]
pub mod updater;
#[cfg(not(target_os = "android"))]
pub mod update_downloader;
#[cfg(not(target_os = "android"))]
pub mod update_commands;

#[cfg(target_os = "android")]
pub mod android;

pub use thumbnail::{get_thumbnail, get_thumbnails_batch, save_remote_thumbnail, generate_drag_preview};
pub use color_search::{search_by_palette, search_by_color};
pub use file_types::SavedWindowState;
pub use window_commands::{get_window_state_path, get_initial_db_paths, save_window_state};
pub use db::AppDbPool;

#[cfg(not(target_os = "android"))]
pub use lan_share_commands::LanShareState;

#[cfg(target_os = "android")]
pub use android::{scan_device_images, scan_device_folders, scan_device_all, generate_thumbnail as android_generate_thumbnail, ThumbnailResult, AndroidImageInfo, AndroidFolderInfo, AndroidScanAllResult};

use std::fs;
use std::path::Path;
use std::sync::Arc;
use tauri::Manager;

#[cfg(target_os = "android")]
use jni::objects::{JObject, JString, JValue};

#[cfg(not(target_os = "android"))]
use tauri::tray::{TrayIconBuilder, TrayIconEvent};
#[cfg(not(target_os = "android"))]
use tauri::menu::{Menu, MenuItem};

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_scan_images() -> Result<Vec<AndroidImageInfo>, String> {
    let start = std::time::Instant::now();
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };
    let result = scan_device_images(&mut env, &activity_obj);
    let elapsed = start.elapsed();
    match &result {
        Ok(images) => log::info!("android_scan_images: found {} images in {:.2}s ({:.0} img/s)", images.len(), elapsed.as_secs_f64(), images.len() as f64 / elapsed.as_secs_f64().max(0.001)),
        Err(e) => log::error!("android_scan_images: failed in {:.2}s: {}", elapsed.as_secs_f64(), e),
    }
    result
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_scan_folders() -> Result<Vec<AndroidFolderInfo>, String> {
    let start = std::time::Instant::now();
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };
    let result = scan_device_folders(&mut env, &activity_obj);
    let elapsed = start.elapsed();
    match &result {
        Ok(folders) => log::info!("android_scan_folders: found {} folders in {:.2}s", folders.len(), elapsed.as_secs_f64()),
        Err(e) => log::error!("android_scan_folders: failed in {:.2}s: {}", elapsed.as_secs_f64(), e),
    }
    result
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_scan_all(since_timestamp: Option<i64>) -> Result<AndroidScanAllResult, String> {
    let start = std::time::Instant::now();
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };

    let since = since_timestamp.unwrap_or(0);
    let result = match crate::android::scan_device_all_via_kotlin(&mut env, &activity_obj, since) {
        Ok(r) => Ok(r),
        Err(e) => {
            log::warn!("android_scan_all: Kotlin method failed ({}), falling back to JNI cursor", e);
            crate::android::scan_device_all(&mut env, &activity_obj)
        }
    };

    let elapsed = start.elapsed();
    match &result {
        Ok(r) => {
            if since > 0 {
                log::info!("android_scan_all (incremental, since={}): found {} images, {} folders in {:.2}s", since, r.images.len(), r.folders.len(), elapsed.as_secs_f64());
            } else {
                log::info!("android_scan_all: found {} images, {} folders in {:.2}s ({:.0} img/s)", r.images.len(), r.folders.len(), elapsed.as_secs_f64(), r.images.len() as f64 / elapsed.as_secs_f64().max(0.001));
            }
        }
        Err(e) => log::error!("android_scan_all: failed in {:.2}s: {}", elapsed.as_secs_f64(), e),
    }
    result
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_save_scan_cache(app_data_dir: String, data: String, cache_type: Option<String>) -> Result<(), String> {
    use std::io::Write;
    let file_name = match cache_type.as_deref() {
        Some("folders") => "scan_cache_folders.json",
        _ => "scan_cache.json",
    };
    let cache_path = std::path::Path::new(&app_data_dir).join(file_name);
    if let Some(parent) = cache_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let mut file = std::fs::File::create(&cache_path)
        .map_err(|e| format!("Failed to create cache file: {:?}", e))?;
    let mut encoder = flate2::write::GzEncoder::new(&mut file, flate2::Compression::fast());
    encoder.write_all(data.as_bytes())
        .map_err(|e| format!("Failed to write cache: {:?}", e))?;
    encoder.finish()
        .map_err(|e| format!("Failed to finish compression: {:?}", e))?;
    log::info!("android_save_scan_cache: saved to {} ({} bytes)", cache_path.display(), file.metadata().map(|m| m.len()).unwrap_or(0));
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_load_scan_cache(app_data_dir: String, cache_type: Option<String>) -> Result<String, String> {
    use std::io::Read;
    let file_name = match cache_type.as_deref() {
        Some("folders") => "scan_cache_folders.json",
        _ => "scan_cache.json",
    };
    let cache_path = std::path::Path::new(&app_data_dir).join(file_name);
    if !cache_path.exists() {
        return Err("Cache file not found".to_string());
    }
    let file = std::fs::File::open(&cache_path)
        .map_err(|e| format!("Failed to open cache file: {:?}", e))?;
    let mut decoder = flate2::read::GzDecoder::new(file);
    let mut data = String::new();
    decoder.read_to_string(&mut data)
        .map_err(|e| format!("Failed to read cache: {:?}", e))?;
    log::info!("android_load_scan_cache: loaded from {} ({} bytes)", cache_path.display(), data.len());
    Ok(data)
}

#[cfg(target_os = "android")]
use std::collections::VecDeque;

#[cfg(target_os = "android")]
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};

#[cfg(target_os = "android")]
use std::sync::Mutex;

#[cfg(target_os = "android")]
use tauri::Emitter;

#[cfg(target_os = "android")]
static THUMBNAIL_QUEUE: Mutex<VecDeque<(String, String, u64)>> = Mutex::new(VecDeque::new());

#[cfg(target_os = "android")]
static THUMBNAIL_SESSION: AtomicU64 = AtomicU64::new(0);

#[cfg(target_os = "android")]
static THUMBNAIL_ACTIVE_COUNT: AtomicUsize = AtomicUsize::new(0);

#[cfg(target_os = "android")]
static THUMBNAIL_PAUSED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "android")]
static VIEWER_OPEN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

#[cfg(target_os = "android")]
const MAX_THUMBNAIL_WORKERS: usize = 6;

#[cfg(target_os = "android")]
const VIEWER_OPEN_MAX_WORKERS: usize = 2;

#[cfg(target_os = "android")]
fn enqueue_thumbnail_job(app: &tauri::AppHandle, file_path: String, cache_dir: String) {
    let session_id = THUMBNAIL_SESSION.load(Ordering::SeqCst);
    log::info!("[ThumbnailWorker] Enqueuing job (LIFO): session={}, queue_len_before={}", session_id, {
        let queue = THUMBNAIL_QUEUE.lock().unwrap();
        queue.len()
    });
    {
        let mut queue = THUMBNAIL_QUEUE.lock().unwrap();
        queue.push_back((file_path, cache_dir, session_id));
    }
    spawn_workers_if_needed(app);
}

#[cfg(target_os = "android")]
fn spawn_workers_if_needed(app: &tauri::AppHandle) {
    if THUMBNAIL_PAUSED.load(Ordering::SeqCst) {
        return;
    }
    let max_workers = if VIEWER_OPEN.load(Ordering::SeqCst) {
        VIEWER_OPEN_MAX_WORKERS
    } else {
        MAX_THUMBNAIL_WORKERS
    };
    let active = THUMBNAIL_ACTIVE_COUNT.load(Ordering::SeqCst);
    if active >= max_workers {
        return;
    }
    let queue_len = {
        let queue = THUMBNAIL_QUEUE.lock().unwrap();
        queue.len()
    };
    if queue_len == 0 {
        return;
    }
    let to_spawn = max_workers.saturating_sub(active).min(queue_len);
    log::info!("[ThumbnailWorker] Spawning {} workers (active={}, queue={}, viewer_open={}, max={})", to_spawn, active, queue_len, VIEWER_OPEN.load(Ordering::SeqCst), max_workers);
    for _ in 0..to_spawn {
        THUMBNAIL_ACTIVE_COUNT.fetch_add(1, Ordering::SeqCst);
        let app = app.clone();
        tauri::async_runtime::spawn_blocking(move || {
            thumbnail_worker(&app);
            THUMBNAIL_ACTIVE_COUNT.fetch_sub(1, Ordering::SeqCst);
            spawn_workers_if_needed(&app);
        });
    }
}

#[cfg(target_os = "android")]
fn thumbnail_worker(app: &tauri::AppHandle) {
    loop {
        if THUMBNAIL_PAUSED.load(Ordering::SeqCst) {
            let mut queue = THUMBNAIL_QUEUE.lock().unwrap();
            if let Some(job) = queue.pop_back() {
                queue.push_front(job);
            }
            drop(queue);
            log::info!("[ThumbnailWorker] Worker exiting due to pause, will respawn on resume");
            return;
        }

        let memory_pressure = crate::android::MemoryPressureMonitor::check();
        match memory_pressure {
            crate::android::MemoryPressure::Critical => {
                log::warn!("[ThumbnailWorker] Critical memory pressure, pausing");
                let mut queue = THUMBNAIL_QUEUE.lock().unwrap();
                if queue.len() > 10 {
                    let drain_count = queue.len() - 10;
                    queue.drain(..drain_count);
                    log::warn!("[ThumbnailWorker] Drained {} jobs from queue due to memory pressure", drain_count);
                }
                std::thread::sleep(std::time::Duration::from_secs(2));
                continue;
            }
            crate::android::MemoryPressure::Warning => {
                std::thread::sleep(std::time::Duration::from_millis(500));
            }
            crate::android::MemoryPressure::Normal => {}
        }

        let job = {
            let mut queue = THUMBNAIL_QUEUE.lock().unwrap();
            queue.pop_back()
        };

        match job {
            Some((file_path, cache_dir, session_id)) => {
                let current_session = THUMBNAIL_SESSION.load(Ordering::SeqCst);
                if session_id != current_session {
                    continue;
                }

                if THUMBNAIL_PAUSED.load(Ordering::SeqCst) {
                    let mut queue = THUMBNAIL_QUEUE.lock().unwrap();
                    queue.push_front((file_path, cache_dir, session_id));
                    log::info!("[ThumbnailWorker] Worker exiting due to pause during job, will respawn on resume");
                    return;
                }

                let start = std::time::Instant::now();
                let result = match call_kotlin_generate_thumbnail(&file_path, &cache_dir) {
                    Ok(Some(thumb_path)) => {
                        log::info!("[ThumbnailWorker] Kotlin thumbnail for {} in {:.0}ms", 
                            file_path.split('/').last().unwrap_or(&file_path), start.elapsed().as_millis());
                        Ok(crate::android::ThumbnailResult {
                            path: file_path.clone(),
                            thumbnail_path: Some(thumb_path),
                            width: 0,
                            height: 0,
                            upgrading: false,
                        })
                    }
                    Ok(None) => {
                        Ok(crate::android::ThumbnailResult {
                            path: file_path.clone(),
                            thumbnail_path: None,
                            width: 0,
                            height: 0,
                            upgrading: false,
                        })
                    }
                    Err(e) => {
                        log::warn!("[ThumbnailWorker] Kotlin thumbnail failed for {}: {}, falling back to Rust", 
                            file_path.split('/').last().unwrap_or(&file_path), e);
                        crate::android::generate_thumbnail(&file_path, std::path::Path::new(&cache_dir))
                    }
                };
                match result {
                    Ok(r) => {
                        if let Some(thumb_path) = r.thumbnail_path {
                            let current_session = THUMBNAIL_SESSION.load(Ordering::SeqCst);
                            if session_id == current_session {
                                if let Err(e) = app.emit("android:thumbnail-upgraded", serde_json::json!({
                                    "filePath": file_path,
                                    "thumbnailPath": thumb_path,
                                })) {
                                    log::warn!("[ThumbnailWorker] Failed to emit event: {}", e);
                                }
                            }
                        }
                    }
                    Err(e) => {
                        log::warn!("[ThumbnailWorker] generate_thumbnail FAILED for {}: {}", file_path, e);
                        if session_id == THUMBNAIL_SESSION.load(Ordering::SeqCst) {
                            if let Err(emit_err) = app.emit("android:thumbnail-upgrade-failed", serde_json::json!({
                                "filePath": file_path,
                                "error": e,
                            })) {
                                log::warn!("[ThumbnailWorker] Failed to emit failure event: {}", emit_err);
                            }
                        }
                    }
                }
            }
            None => break,
        }
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_get_thumbnail(
    app: tauri::AppHandle,
    file_path: String,
    cache_root: String,
    image_id: Option<i64>,
) -> Result<ThumbnailResult, String> {
    let cache_path = std::path::Path::new(&cache_root).to_path_buf();

    // Phase 1: Check file-decoded cache (instant if cached)
    {
        let fp = file_path.clone();
        let cp = cache_path.clone();
        let cached = tauri::async_runtime::spawn_blocking(move || {
            crate::android::check_thumbnail_cache(&fp, &cp)
        }).await.map_err(|e| e.to_string())?;

        if let Some(cached_path) = cached {
            return Ok(ThumbnailResult {
                path: file_path,
                thumbnail_path: Some(cached_path),
                width: 0,
                height: 0,
                upgrading: false,
            });
        }
    }

    // Phase 2: Get MINI_KIND system thumbnail (fast, pre-cached by MediaStore)
    if let Some(id) = image_id {
        let cp = cache_path.clone();
        let result = tauri::async_runtime::spawn_blocking(move || {
            let activity = ndk_context::android_context();
            let vm = match unsafe { jni::JavaVM::from_raw(activity.vm().cast()) } {
                Ok(vm) => vm,
                Err(_) => return None,
            };
            let mut env = match vm.attach_current_thread() {
                Ok(env) => env,
                Err(_) => return None,
            };
            let activity_obj = unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };
            match crate::android::get_android_system_thumbnail(&mut env, &activity_obj, id, &cp) {
                Ok(Some(tuple)) => Some(tuple),
                _ => None,
            }
        }).await;

        match result {
            Ok(Some((thumb_path, bmp_w, bmp_h))) => {
                let min_dim = bmp_w.min(bmp_h);
                if min_dim >= 200 {
                    return Ok(ThumbnailResult {
                        path: file_path,
                        thumbnail_path: Some(thumb_path),
                        width: bmp_w,
                        height: bmp_h,
                        upgrading: false,
                    });
                }
                // MINI_KIND too small: return it for immediate display, enqueue background upgrade
                enqueue_thumbnail_job(&app, file_path.clone(), cache_root.clone());
                return Ok(ThumbnailResult {
                    path: file_path,
                    thumbnail_path: Some(thumb_path),
                    width: bmp_w,
                    height: bmp_h,
                    upgrading: true,
                });
            }
            Ok(None) | Err(_) => {}
        }
    }

    // Fallback: synchronous file decode (no MINI_KIND available)
    let fp = file_path.clone();
    let cp = cache_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::android::generate_thumbnail(&fp, &cp)
    }).await;

    match result {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_thumbnail_navigate() -> Result<(), String> {
    THUMBNAIL_SESSION.fetch_add(1, Ordering::SeqCst);
    let mut queue = THUMBNAIL_QUEUE.lock().unwrap();
    queue.clear();
    Ok(())
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_get_image_preview(
    file_path: String,
    cache_root: String,
) -> Result<crate::android::ImagePreviewResult, String> {
    let cache_path = std::path::Path::new(&cache_root).to_path_buf();
    let fp = file_path.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        crate::android::generate_image_preview(&fp, &cache_path)
    }).await;

    match result {
        Ok(Ok(r)) => Ok(r),
        Ok(Err(e)) => Err(e),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_pause_thumbnail_workers() -> Result<(), String> {
    THUMBNAIL_PAUSED.store(true, Ordering::SeqCst);
    VIEWER_OPEN.store(true, Ordering::SeqCst);
    log::info!("[ThumbnailWorker] Viewer opened, paused thumbnail workers");
    Ok(())
}

#[cfg(target_os = "android")]
fn call_kotlin_generate_thumbnail(file_path: &str, cache_dir: &str) -> Result<Option<String>, String> {
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    let activity_obj = unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };

    let j_path = env.new_string(file_path)
        .map_err(|e| format!("Failed to create path string: {:?}", e))?;
    let j_cache = env.new_string(cache_dir)
        .map_err(|e| format!("Failed to create cache string: {:?}", e))?;

    let json_result = env.call_method(
        &activity_obj,
        "generateThumbnail",
        "(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;",
        &[
            jni::objects::JValue::Object(&j_path),
            jni::objects::JValue::Object(&j_cache),
        ],
    ).map_err(|e| format!("Failed to call generateThumbnail: {:?}", e))?;

    let jstr: jni::objects::JString = json_result.l()
        .map_err(|e| format!("Failed to get result: {:?}", e))?
        .into();
    let json: String = env.get_string(&jstr)
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .into();

    let parsed: serde_json::Value = serde_json::from_str(&json)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    if let Some(error) = parsed.get("error").and_then(|v| v.as_str()) {
        return Err(error.to_string());
    }

    let thumb_path = parsed.get("thumbnailPath").and_then(|v| v.as_str()).map(|s| s.to_string());
    Ok(thumb_path)
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_resume_thumbnail_workers(app: tauri::AppHandle) -> Result<(), String> {
    THUMBNAIL_PAUSED.store(false, Ordering::SeqCst);
    VIEWER_OPEN.store(false, Ordering::SeqCst);
    log::info!("[ThumbnailWorker] Viewer closed, resumed all workers");
    spawn_workers_if_needed(&app);
    Ok(())
}

#[cfg(target_os = "android")]
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NativePreviewResult {
    preview_path: String,
    original_width: i32,
    original_height: i32,
    is_downsampled: bool,
    is_animated_webp: bool,
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_get_native_preview(
    file_path: String,
    cache_root: String,
    max_dimension: i32,
) -> Result<NativePreviewResult, String> {
    let start = std::time::Instant::now();
    let fp = file_path.clone();
    let fp_for_log = file_path.clone();
    let cr = cache_root.clone();
    let md = max_dimension;

    let result = tauri::async_runtime::spawn_blocking(move || -> Result<NativePreviewResult, String> {
        let activity = ndk_context::android_context();
        let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
            .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
        let mut env = vm.attach_current_thread()
            .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
        let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };

        let j_path = env.new_string(&fp)
            .map_err(|e| format!("Failed to create path string: {:?}", e))?;
        let j_cache = env.new_string(&cr)
            .map_err(|e| format!("Failed to create cache string: {:?}", e))?;

        let json_result = env.call_method(
            &activity_obj,
            "generateImagePreview",
            "(Ljava/lang/String;Ljava/lang/String;I)Ljava/lang/String;",
            &[
                jni::objects::JValue::Object(&j_path),
                jni::objects::JValue::Object(&j_cache),
                jni::objects::JValue::Int(md),
            ],
        ).map_err(|e| format!("Failed to call generateImagePreview: {:?}", e))?;

        let jstr: jni::objects::JString = json_result.l()
            .map_err(|e| format!("Failed to get result: {:?}", e))?
            .into();
        let json: String = env.get_string(&jstr)
            .map_err(|e| format!("Failed to get string: {:?}", e))?
            .into();

        let parsed: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| format!("Failed to parse JSON: {}", e))?;

        if let Some(error) = parsed.get("error").and_then(|v| v.as_str()) {
            return Err(error.to_string());
        }

        Ok(NativePreviewResult {
            preview_path: parsed.get("previewPath").and_then(|v| v.as_str()).unwrap_or(&fp).to_string(),
            original_width: parsed.get("originalWidth").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            original_height: parsed.get("originalHeight").and_then(|v| v.as_i64()).unwrap_or(0) as i32,
            is_downsampled: parsed.get("isDownsampled").and_then(|v| v.as_bool()).unwrap_or(false),
            is_animated_webp: parsed.get("isAnimatedWebp").and_then(|v| v.as_bool()).unwrap_or(false),
        })
    }).await;

    let elapsed = start.elapsed();
    match &result {
        Ok(Ok(r)) => log::info!("[NativePreview] {} in {:.0}ms (downsampled={}, animated={})",
            fp_for_log.split('/').last().unwrap_or(&fp_for_log), elapsed.as_millis(), r.is_downsampled, r.is_animated_webp),
        Ok(Err(e)) => log::warn!("[NativePreview] {} FAILED in {:.0}ms: {}", fp_for_log.split('/').last().unwrap_or(&fp_for_log), elapsed.as_millis(), e),
        Err(e) => log::error!("[NativePreview] {} JOIN ERROR: {}", fp_for_log.split('/').last().unwrap_or(&fp_for_log), e),
    }

    result.map_err(|e| e.to_string())?
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn android_batch_get_thumbnails(
    app: tauri::AppHandle,
    image_ids: Vec<i64>,
    cache_root: String,
) -> Result<Vec<crate::android::ThumbnailResult>, String> {
    use crate::android::{get_android_system_thumbnail, batch_get_system_thumbnails};
    use std::path::Path;

    let cache_path = Path::new(&cache_root);
    let mut results: Vec<crate::android::ThumbnailResult> = Vec::new();
    let mut uncached_ids: Vec<i64> = Vec::new();

    for id in &image_ids {
        let cache_filename = format!("sys_{}_q80.jpg", id);
        let cache_file = cache_path.join(&cache_filename);
        if cache_file.exists() {
            results.push(crate::android::ThumbnailResult {
                path: String::new(),
                thumbnail_path: Some(cache_file.to_string_lossy().to_string()),
                width: 0,
                height: 0,
                upgrading: false,
            });
        } else {
            uncached_ids.push(*id);
        }
    }

    if !uncached_ids.is_empty() {
        let uncached_ids_clone = uncached_ids.clone();
        let batch_result = tauri::async_runtime::spawn_blocking(move || {
            let activity = ndk_context::android_context();
            let vm = match unsafe { jni::JavaVM::from_raw(activity.vm().cast()) } {
                Ok(vm) => vm,
                Err(e) => return Err(format!("Failed to get JavaVM: {:?}", e)),
            };
            let mut env = match vm.attach_current_thread() {
                Ok(env) => env,
                Err(e) => return Err(format!("Failed to attach thread: {:?}", e)),
            };
            let activity_obj = unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };

            batch_get_system_thumbnails(&mut env, &activity_obj, &uncached_ids_clone)
        }).await.map_err(|e| e.to_string())?;

        match batch_result {
            Ok(items) => {
                for item in items {
                    let min_dim = item.width.min(item.height);
                    let upgrading = min_dim > 0 && min_dim < 200;

                    if upgrading {
                        if item.thumbnail_path.is_some() {
                            let file_path = format!("media_store_id:{}", item.id);
                            enqueue_thumbnail_job(&app, file_path, cache_root.clone());
                        }
                    }

                    results.push(crate::android::ThumbnailResult {
                        path: String::new(),
                        thumbnail_path: item.thumbnail_path,
                        width: item.width,
                        height: item.height,
                        upgrading,
                    });
                }
            }
            Err(e) => {
                log::warn!("[BatchThumbnail] Kotlin batch failed ({}), falling back to individual", e);
                for id in uncached_ids {
                    let cp = cache_path.to_path_buf();
                    let individual_result = tauri::async_runtime::spawn_blocking(move || {
                        let activity = ndk_context::android_context();
                        let vm = match unsafe { jni::JavaVM::from_raw(activity.vm().cast()) } {
                            Ok(vm) => vm,
                            Err(_) => return None,
                        };
                        let mut env = match vm.attach_current_thread() {
                            Ok(env) => env,
                            Err(_) => return None,
                        };
                        let activity_obj = unsafe { jni::objects::JObject::from_raw(activity.context().cast()) };
                        match get_android_system_thumbnail(&mut env, &activity_obj, id, &cp) {
                            Ok(Some(tuple)) => Some(tuple),
                            _ => None,
                        }
                    }).await;

                    match individual_result {
                        Ok(Some((thumb_path, bmp_w, bmp_h))) => {
                            let min_dim = bmp_w.min(bmp_h);
                            let upgrading = min_dim > 0 && min_dim < 200;
                            if upgrading {
                                let file_path = format!("media_store_id:{}", id);
                                enqueue_thumbnail_job(&app, file_path, cache_root.clone());
                            }
                            results.push(crate::android::ThumbnailResult {
                                path: String::new(),
                                thumbnail_path: Some(thumb_path),
                                width: bmp_w,
                                height: bmp_h,
                                upgrading,
                            });
                        }
                        _ => {
                            results.push(crate::android::ThumbnailResult {
                                path: String::new(),
                                thumbnail_path: None,
                                width: 0,
                                height: 0,
                                upgrading: false,
                            });
                        }
                    }
                }
            }
        }
    }

    Ok(results)
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn check_android_permissions() -> Result<String, String> {
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    
    let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };
    
    let result = env.call_method(
        &activity_obj,
        "checkMediaPermissions",
        "()Ljava/lang/String;",
        &[],
    ).map_err(|e| format!("Failed to call checkMediaPermissions: {:?}", e))?;
    
    let jstr = result.l()
        .map_err(|e| format!("Failed to get result: {:?}", e))?;
    
    let java_str = unsafe { JString::from_raw(jstr.into_raw()) };
    let rust_string: String = env.get_string(&java_str)
        .map_err(|e| format!("Failed to get string: {:?}", e))?
        .into();
    
    Ok(rust_string)
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn request_android_permissions() -> Result<String, String> {
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    
    let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };
    
    env.call_method(
        &activity_obj,
        "requestMediaPermissions",
        "()V",
        &[],
    ).map_err(|e| format!("Failed to call requestMediaPermissions: {:?}", e))?;
    
    Ok("requested".to_string())
}

#[cfg(target_os = "android")]
#[tauri::command]
async fn set_android_status_bar(is_dark: bool) -> Result<(), String> {
    let activity = ndk_context::android_context();
    let vm = unsafe { jni::JavaVM::from_raw(activity.vm().cast()) }
        .map_err(|e| format!("Failed to get JavaVM: {:?}", e))?;
    let mut env = vm.attach_current_thread()
        .map_err(|e| format!("Failed to attach thread: {:?}", e))?;
    
    let activity_obj = unsafe { JObject::from_raw(activity.context().cast()) };
    
    env.call_method(
        &activity_obj,
        "setStatusBarStyle",
        "(Z)V",
        &[JValue::Bool(if is_dark { 1 } else { 0 })],
    ).map_err(|e| format!("Failed to call setStatusBarStyle: {:?}", e))?;
    
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    
    #[cfg(not(target_os = "android"))]
    let builder = builder
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
                let _ = window.unminimize();
            }
        }));
    
    let builder = builder
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init());
    
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(tauri_plugin_drag::init());
    
    #[cfg(target_os = "android")]
    let builder = builder.plugin(
        tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Debug)
            .targets([
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            ])
            .build()
    );
    
    #[cfg(not(target_os = "android"))]
    let builder = builder.plugin(
        tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .targets([
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::LogDir { file_name: None }),
                tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
            ])
            .build()
    );
    
    #[cfg(not(target_os = "android"))]
    let builder = builder.invoke_handler(tauri::generate_handler![
        db_commands::save_user_data,
        db_commands::load_user_data,
        search_by_palette,
        search_by_color,
        scanner::scan_directory,
        file_operations::db_copy_file_metadata,
        scanner::force_rescan,
        color_commands::add_pending_files_to_db,
        system_commands::get_platform,
        system_commands::get_default_paths,
        get_thumbnail,
        get_thumbnails_batch,
        save_remote_thumbnail,
        image_utils::get_avif_preview,
        image_utils::get_jxl_preview,
        generate_drag_preview,
        system_commands::read_file_as_base64,
        file_operations::ensure_directory,
        file_operations::file_exists,
        system_commands::open_path,
        file_operations::create_folder,
        file_operations::rename_file,
        file_operations::delete_file,
        file_operations::copy_file,
        file_operations::copy_image_colors,
        file_operations::move_file,
        file_operations::write_file_from_bytes,
        file_operations::scan_file,
        window_commands::hide_window,
        window_commands::show_window,
        window_commands::set_window_min_size,
        window_commands::exit_app,
        color_commands::get_dominant_colors,
        color_worker::pause_color_extraction,
        color_worker::resume_color_extraction,
        db_commands::force_wal_checkpoint,
        db_commands::get_wal_info,
        db_commands::db_get_all_people,
        db_commands::db_upsert_person,
        db_commands::db_delete_person,
        db_commands::db_update_person_avatar,
        db_commands::db_get_all_topics,
        db_commands::db_upsert_topic,
        db_commands::db_delete_topic,
        db_commands::db_upsert_file_metadata,
        db_commands::db_get_all_file_metadata,
        file_operations::db_copy_file_metadata,
        db_commands::switch_root_database,
        file_operations::copy_image_to_clipboard,
        db_commands::get_color_db_stats,
        db_commands::get_color_db_error_files,
        db_commands::retry_color_extraction,
        db_commands::delete_color_db_error_files,
        update_commands::check_for_updates_command,
        system_commands::open_external_link,
        update_commands::start_update_download,
        update_commands::pause_update_download,
        update_commands::resume_update_download,
        update_commands::cancel_update_download,
        update_commands::get_update_download_progress,
        update_commands::install_update,
        update_commands::open_update_download_folder,
        system_commands::proxy_http_request,
        clip_commands::clip_search_by_text,
        clip_commands::clip_search_by_image,
        clip_commands::clip_generate_embedding,
        clip_commands::clip_get_embedding_status,
        clip_commands::clip_load_model,
        clip_commands::clip_unload_model,
        clip_commands::clip_is_model_loaded,
        clip_commands::clip_get_embedding_count,
        clip_commands::clip_get_embedding_count_by_model,
        clip_commands::clip_get_model_versions,
        clip_commands::clip_get_model_status,
        clip_commands::clip_get_embedding_stats,
        clip_commands::clip_delete_model,
        clip_commands::clip_open_model_folder,
        clip_commands::clip_generate_embeddings_batch,
        clip_commands::clip_cancel_embedding_generation,
        clip_commands::clip_pause_embedding_generation,
        clip_commands::clip_resume_embedding_generation,
        clip_commands::clip_update_config,
        clip_commands::clip_generate_tags_from_embeddings,
        clip_commands::get_all_image_files,
        clip_commands::clip_get_character_tags,
        clip_commands::clip_search_by_character_tag,
        clip_commands::clip_get_detected_characters,
        clip_commands::clip_preview_tags_from_embeddings,
        clip_commands::clip_get_work_topics,
        clip_commands::clip_create_work_topics,
        lan_share_commands::lan_share_start,
        lan_share_commands::lan_share_stop,
        lan_share_commands::lan_share_get_status,
        lan_share_commands::lan_share_get_devices,
        lan_share_commands::lan_share_get_local_ip,
        lan_share_commands::lan_share_check_port,
        lan_share_commands::lan_share_update_config
    ]);

    #[cfg(target_os = "android")]
    let builder = builder.invoke_handler(tauri::generate_handler![
        db_commands::save_user_data,
        db_commands::load_user_data,
        system_commands::get_platform,
        system_commands::get_default_paths,
        get_thumbnail,
        get_thumbnails_batch,
        save_remote_thumbnail,
        image_utils::get_avif_preview,
        image_utils::get_jxl_preview,
        generate_drag_preview,
        system_commands::read_file_as_base64,
        file_operations::ensure_directory,
        file_operations::file_exists,
        system_commands::open_path,
        file_operations::create_folder,
        file_operations::rename_file,
        file_operations::delete_file,
        file_operations::copy_file,
        file_operations::move_file,
        file_operations::write_file_from_bytes,
        file_operations::scan_file,
        window_commands::hide_window,
        window_commands::show_window,
        window_commands::set_window_min_size,
        window_commands::exit_app,
        db_commands::force_wal_checkpoint,
        db_commands::get_wal_info,
        db_commands::db_get_all_people,
        db_commands::db_upsert_person,
        db_commands::db_delete_person,
        db_commands::db_update_person_avatar,
        db_commands::db_get_all_topics,
        db_commands::db_upsert_topic,
        db_commands::db_delete_topic,
        db_commands::db_upsert_file_metadata,
        db_commands::db_get_all_file_metadata,
        db_commands::switch_root_database,
        system_commands::proxy_http_request,
        android_scan_images,
        android_scan_folders,
        android_scan_all,
        android_save_scan_cache,
        android_load_scan_cache,
        android_get_thumbnail,
        android_batch_get_thumbnails,
        android_thumbnail_navigate,
        android_get_image_preview,
        android_pause_thumbnail_workers,
        android_resume_thumbnail_workers,
        android_get_native_preview,
        check_android_permissions,
        request_android_permissions,
        set_android_status_bar,
    ]);
    
    builder
        .setup(|app| {
            #[cfg(not(target_os = "android"))]
            {
                let show_item = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
                let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
                
                let app_handle = app.handle().clone();
                
                let tray_icon = app.default_window_icon()
                    .cloned()
                    .ok_or_else(|| {
                        log::warn!("No default window icon found, tray icon may not display correctly");
                        "No default window icon"
                    });
                
                let tray = TrayIconBuilder::new()
                    .tooltip("Aurora Gallery")
                    .icon(match tray_icon {
                        Ok(icon) => icon,
                        Err(_) => {
                            return Ok(());
                        }
                    })
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(move |app, event| {
                        match event.id.as_ref() {
                            "show" => {
                                if let Some(window) = app.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            "quit" => {
                                app.exit(0);
                            }
                            _ => {}
                        }
                    })
                    .on_tray_icon_event(move |_tray, event| {
                        match event {
                            TrayIconEvent::DoubleClick { .. } => {
                                if let Some(window) = app_handle.get_webview_window("main") {
                                    let _ = window.show();
                                    let _ = window.set_focus();
                                }
                            }
                            _ => {}
                        }
                    })
                    .build(app)?;
                
                app.manage(Some(tray));
            }
            
            let (db_path, app_db_path) = get_initial_db_paths(app.handle());
            
            let pool = match color_db::ColorDbPool::new(&db_path) {
                Ok(pool_instance) => {
                    {
                        let mut conn = pool_instance.get_connection();
                        if let Err(e) = color_db::init_db(&mut conn) {
                            log::error!("Failed to initialize color database: {}", e);
                        }
                        if let Err(e) = color_db::reset_processing_to_pending(&mut conn) {
                            log::error!("Failed to reset processing files to pending: {}", e);
                        }
                    }
                    if let Err(e) = pool_instance.ensure_cache_initialized_async() {
                        log::error!("Failed to start background color cache preheat: {}", e);
                    }
                    if let Err(e) = pool_instance.get_db_file_sizes() {
                        log::error!("Failed to get database file sizes: {}", e);
                    }
                    pool_instance
                },
                Err(e) => {
                    log::error!("Failed to create color database connection pool: {}", e);
                    panic!("Failed to create color database connection pool: {}", e);
                }
            };
            
            let pool_arc = Arc::new(pool);
            app.manage(pool_arc.clone());

            let app_db_pool = match AppDbPool::new(&app_db_path) {
                Ok(pool) => {
                    {
                        let conn = pool.get_connection();
                        if let Err(e) = db::init_db(&conn) {
                            log::error!("Failed to initialize app database: {}", e);
                        }
                    }
                    pool
                },
                Err(e) => {
                    panic!("Failed to create app database pool: {}", e);
                }
            };
            app.manage(app_db_pool);
            
            #[cfg(not(target_os = "android"))]
            app.manage(LanShareState::new());
            
            let batch_size = 50;
            let app_handle_new = app.handle().clone();
            let app_handle_arc = Arc::new(app_handle_new);

            let cache_root = {
                let home = std::env::var("HOME")
                    .or_else(|_| std::env::var("USERPROFILE"))
                    .ok();
                home.map(|h| {
                    if cfg!(windows) {
                        Path::new(&h).join("AppData").join("Local").join("Aurora").join("Cache")
                    } else if cfg!(target_os = "macos") {
                        Path::new(&h).join("Library").join("Application Support").join("Aurora").join("Cache")
                    } else {
                        Path::new(&h).join(".local").join("share").join("aurora").join("cache")
                    }
                })
            };
            
            #[cfg(not(target_os = "android"))]
            {
                let clip_cache_root = cache_root.clone().unwrap_or_else(|| {
                    let home = std::env::var("HOME")
                        .or_else(|_| std::env::var("USERPROFILE"))
                        .unwrap_or_else(|_| ".".to_string());
                    Path::new(&home).join(".aurora_cache")
                });
                
                let clip_root_path = {
                    let app_data_dir = app.handle().path().app_data_dir()
                        .expect("Failed to get app data directory");
                    let config_path = app_data_dir.join("user_data.json");
                    if config_path.exists() {
                        if let Ok(json_str) = fs::read_to_string(&config_path) {
                            if let Ok(data) = serde_json::from_str::<serde_json::Value>(&json_str) {
                                if let Some(root_paths) = data.get("rootPaths").and_then(|v| v.as_array()) {
                                    if let Some(first_root) = root_paths.get(0).and_then(|v| v.as_str()) {
                                        Path::new(first_root).to_path_buf()
                                    } else {
                                        app_data_dir.clone()
                                    }
                                } else {
                                    app_data_dir.clone()
                                }
                            } else {
                                app_data_dir.clone()
                            }
                        } else {
                            app_data_dir.clone()
                        }
                    } else {
                        app_data_dir.clone()
                    }
                };
                
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = clip::init_clip_manager(clip_root_path, clip_cache_root).await {
                        log::error!("Failed to initialize CLIP manager: {}", e);
                    } else {
                        log::info!("CLIP manager initialized successfully");
                    }
                });
            }
            
            #[cfg(not(target_os = "android"))]
            tauri::async_runtime::spawn(async move {
                color_worker::color_extraction_worker(
                    pool_arc,
                    batch_size,
                    Some(app_handle_arc),
                    cache_root
                ).await;
            });
            
            #[cfg(not(target_os = "android"))]
            if let Some(window) = app.get_webview_window("main") {
                let app_handle_for_state = app.handle();
                let path = get_window_state_path(app_handle_for_state);
                let mut state_restored = false;
                if path.exists() {
                    if let Ok(json) = fs::read_to_string(&path) {
                        if let Ok(state) = serde_json::from_str::<SavedWindowState>(&json) {
                            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width: state.width, height: state.height }));
                            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x: state.x, y: state.y }));
                            if state.maximized {
                                let _ = window.maximize();
                            }
                            state_restored = true;
                        }
                    }
                }
                if !state_restored {
                    let _ = window.center();
                }
                let _ = window.show();
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                save_window_state(window.app_handle());
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
