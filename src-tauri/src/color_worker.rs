use std::sync::Arc;
use std::time::Duration;
use image::{ImageFormat, GenericImageView};
use std::fs::File;
use std::io::BufReader;
use rayon::{ThreadPoolBuilder};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter};
use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use crossbeam_channel::{unbounded, Sender, Receiver};
use tokio::task;

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

// 定义处理结果结构体
type ProcessingResult = Result<(String, Vec<color_extractor::ColorResult>), String>;

// 定义任务类型
type Task = String;

// 后台处理任务，持续提取待处理图片的主色调
pub async fn color_extraction_worker(
    pool: Arc<ColorDbPool>, 
    batch_size: usize,
    app_handle: Option<Arc<AppHandle>>
) {
    // 创建rayon线程池，根据CPU核心数调整线程数
    // 8核→6线程，16核→12线程，更多核心→固定16线程
    let num_cpus = num_cpus::get();
    let num_workers = match num_cpus {
        0..=8 => num_cpus - 2, // 8核→6线程
        9..=16 => num_cpus - 4, // 16核→12线程
        _ => 16, // 更多核心→固定16线程
    };
    let num_workers = num_workers.max(1); // 确保至少有1个线程
    
    // 创建rayon线程池
    let thread_pool = ThreadPoolBuilder::new()
        .num_threads(num_workers)
        .build()
        .expect("Failed to create thread pool");
    
    // 创建任务通道（无界）
    let (task_sender, task_receiver): (Sender<Task>, Receiver<Task>) = unbounded();
    
    // 创建结果通道（无界）
    let (result_sender, result_receiver): (Sender<ProcessingResult>, Receiver<ProcessingResult>) = unbounded();
    
    // 使用互斥锁跟踪当前处理的文件，用于进度报告
    let current_file = Arc::new(Mutex::new(String::new()));
    
    // 1. 启动生产者任务：持续从数据库获取待处理文件
    let pool_producer = pool.clone();
    let producer_handle = task::spawn(async move {
        producer_loop(pool_producer, batch_size, task_sender).await;
    });
    
    // 2. 启动多个消费者任务：并行处理文件
    let mut consumer_handles = Vec::new();
    for _ in 0..num_workers {
        let pool_consumer = pool.clone();
        let task_receiver_clone = task_receiver.clone();
        let result_sender_clone = result_sender.clone();
        let current_file_clone = current_file.clone();
        
        let handle = task::spawn_blocking(move || {
            consumer_loop(
                pool_consumer,
                task_receiver_clone,
                result_sender_clone,
                current_file_clone
            );
        });
        
        consumer_handles.push(handle);
    }
    
    // 3. 启动结果处理任务：批量保存到数据库
    let pool_result = pool.clone();
    let app_handle_result = app_handle.clone();
    let result_handle = task::spawn(async move {
        result_processor(
            pool_result,
            result_receiver,
            app_handle_result
        ).await;
    });
    
    // 等待所有任务完成（实际上不会完成，会一直运行）
    producer_handle.await.unwrap();
    for handle in consumer_handles {
        handle.await.unwrap();
    }
    result_handle.await.unwrap();
}

// 生产者循环：持续从数据库获取待处理文件
async fn producer_loop(
    pool: Arc<ColorDbPool>,
    batch_size: usize,
    task_sender: Sender<Task>
) {
    loop {
        // 检查是否暂停
        if is_paused() {
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        
        // 克隆pool，避免在循环中移动所有权
        let pool_clone = pool.clone();
        
        // 从数据库获取待处理文件
        let pending_files = match tokio::task::spawn_blocking(move || {
            let mut conn = pool_clone.get_connection();
            color_db::get_pending_files(&mut conn, batch_size)
        }).await {
            Ok(Ok(files)) => files,
            Ok(Err(e)) => {
                eprintln!("Failed to get pending files: {}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            },
            Err(e) => {
                eprintln!("Failed to execute database query: {}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        
        if pending_files.is_empty() {
            // 没有待处理文件，睡眠500毫秒后再次检查
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        
        // 将文件路径发送到任务队列
        for file_path in pending_files {
            if task_sender.send(file_path).is_err() {
                // 通道已关闭，退出循环
                break;
            }
        }
        
        // 短暂睡眠，避免过于频繁的数据库查询
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

// 消费者循环：从队列获取任务并处理
fn consumer_loop(
    pool: Arc<ColorDbPool>,
    task_receiver: Receiver<Task>,
    result_sender: Sender<ProcessingResult>,
    current_file: Arc<Mutex<String>>
) {
    // 持续从任务队列获取任务
    for file_path in task_receiver {
        // 检查是否暂停
        if is_paused() {
            std::thread::sleep(Duration::from_millis(500));
            continue;
        }
        
        // 更新当前处理的文件
        let _ = *current_file.lock().unwrap() = file_path.clone();
        
        // 1. 加载和处理图片
        let processing_result: ProcessingResult = match File::open(&file_path) {
            Ok(file) => {
                let reader = BufReader::new(file);
                match image::load(reader, ImageFormat::from_path(&file_path).unwrap_or(ImageFormat::Jpeg)) {
                    Ok(mut img) => {
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
                        
                        let colors = color_extractor::get_dominant_colors(&img, 8);
                        
                        if colors.is_empty() {
                            Err(format!("No colors extracted from file: {}", file_path))
                        } else {
                            Ok((file_path, colors))
                        }
                    },
                    Err(e) => {
                        Err(format!("Failed to load image: {}", e))
                    }
                }
            },
            Err(e) => {
                Err(format!("Failed to open file: {}", e))
            }
        };
        
        // 将处理结果发送到结果队列
        if result_sender.send(processing_result).is_err() {
            // 通道已关闭，退出循环
            break;
        }
    }
}

// 结果处理器：批量保存结果到数据库
async fn result_processor(
    pool: Arc<ColorDbPool>,
    result_receiver: Receiver<ProcessingResult>,
    app_handle: Option<Arc<AppHandle>>
) {
    // 获取总文件数，用于进度报告
    let pool_clone = pool.clone();
    let total_files = match tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone.get_connection();
        color_db::get_total_files(&mut conn)
    }).await {
        Ok(Ok(count)) => count,
        Ok(Err(e)) => {
            eprintln!("Failed to get total files: {}", e);
            0
        },
        Err(e) => {
            eprintln!("Failed to execute database query: {}", e);
            0
        }
    };
    
    // 获取已处理文件数，用于进度报告
    let pool_clone = pool.clone();
    let extracted_count = match tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone.get_connection();
        color_db::get_extracted_files_count(&mut conn)
    }).await {
        Ok(Ok(count)) => count,
        Ok(Err(e)) => {
            eprintln!("Failed to get extracted files count: {}", e);
            0
        },
        Err(e) => {
            eprintln!("Failed to execute database query: {}", e);
            0
        }
    };
    
    // 结果缓冲区，用于批量保存
    let mut result_buffer = Vec::new();
    let batch_save_threshold = 5; // 每5个结果批量保存一次，进一步减少可能丢失的数据量
    let mut processed_count = extracted_count; // 从已处理文件数开始计数
    let mut success_count = extracted_count; // 已处理的都是成功的
    let mut error_count = 0;
    let mut last_save_time = tokio::time::Instant::now();
    let auto_save_interval = Duration::from_secs(2); // 自动保存间隔：2秒，进一步缩短自动保存时间
    
    // 持续处理结果
    loop {
        // 检查是否有结果需要处理
        match result_receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(result) => {
                processed_count += 1;
                
                match result {
                    Ok((file_path, colors)) => {
                        result_buffer.push((file_path, colors));
                        success_count += 1;
                    },
                    Err(e) => {
                        error_count += 1;
                        eprintln!("Error processing file: {}", e);
                    }
                }
                
                // 发送进度报告
                if let Some(app_handle) = &app_handle {
                    let progress = ColorExtractionProgress {
                        current: processed_count,
                        total: total_files,
                        current_file: String::new(), // 不再跟踪单个文件
                    };
                    
                    // 忽略发送失败的情况，不影响主流程
                    let _ = app_handle.emit("color-extraction-progress", progress);
                }
                
                // 打印处理统计
                if processed_count % 10 == 0 {
                    eprintln!("Processed {} files: {} success, {} errors", 
                             processed_count, success_count, error_count);
                }
            },
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                // 超时，检查是否需要保存
            },
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                // 通道关闭，退出循环
                break;
            }
        }
        
        // 检查是否需要保存：达到阈值、暂停状态或超过自动保存间隔
        let elapsed_time = last_save_time.elapsed();
        let should_save = result_buffer.len() >= batch_save_threshold || 
                         is_paused() || 
                         (elapsed_time >= auto_save_interval && !result_buffer.is_empty());
        
        if should_save {
            // 保存当前缓冲区的结果
            save_batch_results(pool.clone(), &mut result_buffer).await;
            last_save_time = tokio::time::Instant::now(); // 重置自动保存时间
        }
        
        // 检查是否暂停
        if is_paused() {
            // 短暂睡眠，避免CPU占用过高
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
    }
    
    // 保存剩余的结果
    if !result_buffer.is_empty() {
        save_batch_results(pool.clone(), &mut result_buffer).await;
    }
}

// 批量保存结果到数据库
async fn save_batch_results(
    pool: Arc<ColorDbPool>,
    result_buffer: &mut Vec<(String, Vec<color_extractor::ColorResult>)>
) {
    if result_buffer.is_empty() {
        return;
    }
    
    // 创建一个临时缓冲区，避免移动原始缓冲区
    let batch_data: Vec<(String, Vec<color_extractor::ColorResult>)> = result_buffer.drain(0..).collect();
    
    // 保存结果到数据库
    let pool_clone = pool.clone();
    let save_result = tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone.get_connection();
        
        // 将结果转换为batch_save_colors所需的格式
        let batch_data_refs: Vec<(&str, &[color_extractor::ColorResult])> = batch_data
            .iter()
            .map(|(file_path, colors)| (file_path.as_str(), colors.as_slice()))
            .collect();
        
        color_db::batch_save_colors(&mut conn, &batch_data_refs)
    }).await;
    
    if let Err(e) = save_result {
        eprintln!("Failed to execute batch save: {}", e);
    } else if let Err(e) = save_result.unwrap() {
        eprintln!("Failed to batch save colors: {}", e);
    }
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
