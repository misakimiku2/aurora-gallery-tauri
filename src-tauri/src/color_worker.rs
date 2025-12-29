use std::sync::Arc;
use std::time::Duration;
use image::{ImageFormat, GenericImageView};
use std::fs::File;
use std::io::BufReader;
use rayon::ThreadPoolBuilder;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::color_db::{self, ColorDbPool};
use crate::color_extractor;

// 全局暂停状态
static IS_PAUSED: AtomicBool = AtomicBool::new(false);

// 进度报告结构体
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorExtractionProgress {
    pub current: usize,
    pub total: usize,
    pub current_file: String,
}

// 暂停主色调提取
#[tauri::command]
pub fn pause_color_extraction() -> bool {
    IS_PAUSED.store(true, Ordering::SeqCst);
    true
}

// 恢复主色调提取
#[tauri::command]
pub fn resume_color_extraction() -> bool {
    IS_PAUSED.store(false, Ordering::SeqCst);
    true
}

// 检查是否暂停
pub fn is_paused() -> bool {
    IS_PAUSED.load(Ordering::SeqCst)
}

// 后台处理任务，持续提取待处理图片的主色调
pub async fn color_extraction_worker(
    pool: Arc<ColorDbPool>, 
    batch_size: usize,
    app_handle: Option<Arc<AppHandle>>
) {
    // 创建rayon线程池，限制使用CPU核心数为总核心数的一半
    // 例如：8核CPU只使用4核，确保前端流畅
    let num_cpus = num_cpus::get();
    let thread_pool = ThreadPoolBuilder::new()
        .num_threads(num_cpus / 2)
        .build()
        .expect("Failed to create thread pool");
    
    // 使用互斥锁跟踪当前处理的文件，用于进度报告
    let current_file = Arc::new(Mutex::new(String::new()));
    
    loop {
        // 检查是否暂停
        if is_paused() {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        
        // 处理一批待处理文件
        let pool_clone = pool.clone();
        let app_handle_clone = app_handle.clone();
        let current_file_clone = current_file.clone();
        
        if let Err(e) = process_pending_files(
            pool_clone, 
            batch_size, 
            &thread_pool, 
            app_handle_clone,
            current_file_clone
        ).await {
            eprintln!("Error processing pending files: {}", e);
        }
        
        // 短暂睡眠，避免CPU空转
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// 处理一批待处理文件
async fn process_pending_files(
    pool: Arc<ColorDbPool>, 
    batch_size: usize,
    _thread_pool: &rayon::ThreadPool,
    app_handle: Option<Arc<AppHandle>>,
    current_file: Arc<Mutex<String>>
) -> Result<(), String> {
    // 1. 获取总文件数和待处理文件列表
    let pool_clone_for_stats = pool.clone();
    let (total_files, pending_files) = tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone_for_stats.get_connection();
        let total = color_db::get_total_files(&mut conn).map_err(|e| e.to_string())?;
        let pending = color_db::get_pending_files(&mut conn, batch_size).map_err(|e| e.to_string())?;
        Ok((total, pending))
    }).await.map_err(|e| format!("Failed to get stats: {}", e))?
        .map_err(|e: String| format!("Database error: {}", e))?;
    
    if pending_files.is_empty() {
        return Ok(());
    }
    
    // 获取已处理文件数
    let pool_clone_for_extracted = pool.clone();
    let extracted_count = tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone_for_extracted.get_connection();
        color_db::get_extracted_files_count(&mut conn)
    }).await.map_err(|e| format!("Failed to get extracted count: {}", e))?
        .map_err(|e| format!("Database error: {}", e))?;
    
    // 2. 并行处理每个文件
    let _pending_files_len = pending_files.len();
    let app_handle_clone = app_handle.clone();
    let current_file_clone = current_file.clone();
    let total_files_clone = total_files;
    
    // 创建一个原子计数器来跟踪当前处理的文件数量
    let processed_count = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let processed_count_clone = processed_count.clone();
    
    let results: Vec<_> = {
        // 使用rayon线程池处理文件，这会尊重我们设置的核心数限制
        _thread_pool.install(|| {
            pending_files.into_iter().map(|file_path: String| {
                // 更新当前处理的文件
                *current_file_clone.lock().unwrap() = file_path.clone();
                
                // 获取当前处理的文件索引
                let current = processed_count_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
                
                // 发送进度报告（在rayon线程中同步发送）
                if let Some(app_handle) = &app_handle_clone {
                    let progress = ColorExtractionProgress {
                        current: extracted_count + current,
                        total: total_files_clone,
                        current_file: file_path.clone(),
                    };
                    
                    // 忽略发送失败的情况，不影响主流程
                    let _ = app_handle.emit("color-extraction-progress", progress);
                }
                
                // 只处理同步部分，不包含异步操作
                let pool_sync = pool.clone();
                let file_path_sync = file_path.clone();
                
                // 1. 加载和处理图片（同步操作）
                let img_result: Result<image::DynamicImage, String> = {
                    let file = File::open(&file_path_sync)
                        .map_err(|e| format!("Failed to open file: {}", e))?;
                    
                    let reader = BufReader::new(file);
                    let mut img = image::load(reader, ImageFormat::from_path(&file_path_sync).unwrap_or(ImageFormat::Jpeg))
                        .map_err(|e| format!("Failed to load image: {}", e))?;
                    
                    // 等比例缩小图片到256px，以较小边为准
                    let (width, height) = img.dimensions();
                    let max_dim = 256;
                    
                    if width > max_dim || height > max_dim {
                        let (new_width, new_height) = if width < height {
                            let scale = max_dim as f32 / width as f32;
                            (max_dim, (height as f32 * scale) as u32)
                        } else {
                            let scale = max_dim as f32 / height as f32;
                            ((width as f32 * scale) as u32, max_dim)
                        };
                        
                        img = img.resize_exact(new_width, new_height, image::imageops::FilterType::Triangle);
                    }
                    
                    Ok(img)
                };
                
                let img = img_result?;
                let colors = color_extractor::get_dominant_colors(&img, 8);
                
                // 2. 保存到数据库（同步操作）
                if colors.is_empty() {
                    // 更新状态为错误
                    let mut conn = pool_sync.get_connection();
                    color_db::update_status(&mut conn, &file_path_sync, "error")
                        .map_err(|e| format!("Failed to update status: {}", e))?;
                    
                    return Err(format!("No colors extracted from file: {}", file_path_sync));
                }
                
                // 保存到数据库
                let mut conn = pool_sync.get_connection();
                color_db::save_colors(&mut conn, &file_path_sync, &colors)
                    .map_err(|e| format!("Failed to save colors: {}", e))?;
                
                // 返回成功处理的结果
                Ok(())
            }).collect::<Vec<Result<(), String>>>()
        })
    };
    
    // 转换结果格式，适配后续的汇总逻辑
    let results: Vec<Result<Result<(), String>, String>> = results.into_iter().map(|res| {
        Ok(res)
    }).collect();
    
    // 3. 汇总结果
    let mut success_count = 0;
    let mut error_count = 0;
    
    for result in results {
        match result {
            Ok(Ok(_)) => success_count += 1,
            Ok(Err(e)) => {
                error_count += 1;
                eprintln!("Error processing file: {}", e);
            },
            Err(e) => {
                error_count += 1;
                eprintln!("Task error: {}", e);
            }
        }
    }
    
    eprintln!("Processed {} files: {} success, {} errors", success_count + error_count, success_count, error_count);
    
    Ok(())
}

// 处理单个文件，提取主色调并保存到数据库
async fn process_single_file(pool: Arc<ColorDbPool>, file_path: String) -> Result<(), String> {
    // 1. 检查文件是否存在
    if !std::path::Path::new(&file_path).exists() {
        // 更新状态为错误
        let pool_clone = pool.clone();
        let file_path_clone = file_path.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = pool_clone.get_connection();
            color_db::update_status(&mut conn, &file_path_clone, "error")
        }).await.map_err(|e| format!("Failed to update status: {}", e))?
            .map_err(|e| format!("Database error: {}", e))?;
        
        return Err(format!("File does not exist: {}", file_path));
    }
    
    // 2. 加载图片
    let file_path_clone = file_path.clone();
    // 直接在当前线程处理图片，避免异步任务的复杂类型推断
    let img = {
        let file = File::open(&file_path_clone)
            .map_err(|e| format!("Failed to open file: {}", e))?;
        
        let reader = BufReader::new(file);
        let mut img = image::load(reader, ImageFormat::from_path(&file_path_clone).unwrap_or(ImageFormat::Jpeg))
            .map_err(|e| format!("Failed to load image: {}", e))?;
        
        // 等比例缩小图片到256px，以较小边为准
        let (width, height) = img.dimensions();
        let max_dim = 256;
        
        if width > max_dim || height > max_dim {
            let (new_width, new_height) = if width < height {
                let scale = max_dim as f32 / width as f32;
                (max_dim, (height as f32 * scale) as u32)
            } else {
                let scale = max_dim as f32 / height as f32;
                ((width as f32 * scale) as u32, max_dim)
            };
            
            img = img.resize_exact(new_width, new_height, image::imageops::FilterType::Triangle);
        }
        
        img
    };
    
    // 3. 提取主色调
    let colors = color_extractor::get_dominant_colors(&img, 8);
    
    if colors.is_empty() {
        // 更新状态为错误
        let pool_clone = pool.clone();
        let file_path_clone = file_path.clone();
        tokio::task::spawn_blocking(move || {
            let mut conn = pool_clone.get_connection();
            color_db::update_status(&mut conn, &file_path_clone, "error")
        }).await.map_err(|e| format!("Failed to update status: {}", e))?
            .map_err(|e| format!("Database error: {}", e))?;
        
        return Err(format!("No colors extracted from file: {}", file_path));
    }
    
    // 4. 保存到数据库
    let pool_clone = pool.clone();
    let file_path_clone = file_path.clone();
    let colors_clone = colors.clone();
    tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone.get_connection();
        color_db::save_colors(&mut conn, &file_path_clone, &colors_clone)
    }).await.map_err(|e| format!("Failed to save colors: {}", e))?
        .map_err(|e| format!("Database error: {}", e))?;
    
    Ok(())
}
