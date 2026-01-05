use std::sync::Arc;
use std::time::Duration;
use image::{ImageFormat, GenericImageView};
use std::fs::File;
use std::io::BufReader;
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

// 全局关闭状态
static IS_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

// 进度报告结构体
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorExtractionProgress {
    pub current: usize,
    pub total: usize,
    pub pending: usize,
    pub current_file: String,
}

// 暂停主色调提取
#[tauri::command]
pub fn pause_color_extraction() -> bool {
    IS_PAUSED.store(true, Ordering::SeqCst);
    true
}

// 保存并暂停主色调提取（立即保存缓冲区数据）
#[tauri::command]
pub async fn save_and_pause_color_extraction() -> bool {
    IS_PAUSED.store(true, Ordering::SeqCst);
    true
}

// 关闭主色调提取任务（保存缓冲区并设置关闭标志）
#[tauri::command]
pub async fn shutdown_color_extraction() -> bool {
    IS_SHUTTING_DOWN.store(true, Ordering::SeqCst);
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

// 检查是否正在关闭
pub fn is_shutting_down() -> bool {
    IS_SHUTTING_DOWN.load(Ordering::SeqCst)
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
    let num_workers = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let num_workers = num_workers.min(8); // 最多8个消费者线程
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
        // 检查是否暂停或关闭
        if is_paused() || is_shutting_down() {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if is_shutting_down() {
                // 关闭时，不再发送新任务，让队列自然清空
                eprintln!("Producer shutting down, stopping new task dispatch");
                break;
            }
            continue;
        }
        
        // 克隆pool，避免在循环中移动所有权
        let pool_clone = pool.clone();
        
        // 从数据库获取待处理文件
        let pending_files = match tokio::task::spawn_blocking(move || {
            let mut conn = pool_clone.get_connection();
            let files = color_db::get_pending_files(&mut conn, batch_size);
            
            // 立即将获取的文件状态更新为processing，避免重复获取
            if let Ok(ref files) = files {
                for file_path in files {
                    let _ = color_db::update_status(&mut conn, file_path, "processing");
                }
            }
            
            files
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
    loop {
        // 检查是否暂停或关闭
        if is_paused() || is_shutting_down() {
            if is_shutting_down() {
                // 如果正在关闭，排空当前接收到的任务并退出
                eprintln!("Consumer loop received shutdown signal, exiting.");
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        
        // 尝试接收任务（增加超时检查频率）
        match task_receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(file_path) => {
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
                                    Ok((file_path.clone(), colors))
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
                // 克隆处理结果以便后续检查错误状态
                let processing_result_clone = processing_result.clone();
                if result_sender.send(processing_result).is_err() {
                    // 通道已关闭，退出循环
                    eprintln!("Result sender closed, consumer exiting");
                    break;
                }
                
                // 如果处理失败，更新文件状态为error
                if let Err(error_msg) = processing_result_clone {
                    let pool_clone = pool.clone();
                    let file_path_clone = file_path.clone();
                    // 使用spawn_blocking在后台线程中更新状态
                    std::thread::spawn(move || {
                        let mut conn = pool_clone.get_connection();
                        if let Err(e) = color_db::update_status(&mut conn, &file_path_clone, "error") {
                            eprintln!("Failed to update status to error for {}: {}", file_path_clone, e);
                        } else {
                            eprintln!("Updated status to error for {}: {}", file_path_clone, error_msg);
                        }
                    });
                }
            },
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => {
                // 超时，继续循环
                continue;
            },
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                // 通道已关闭（生产者已退出），退出循环
                eprintln!("Task receiver disconnected, consumer exiting");
                break;
            }
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
    // 修复：优先使用待处理文件数作为总数，避免首次创建数据库时出现除零错误
    let pool_clone = pool.clone();
    let pending_count = match tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone.get_connection();
        color_db::get_pending_files_count(&mut conn)
    }).await {
        Ok(Ok(count)) => count,
        Ok(Err(e)) => {
            eprintln!("Failed to get pending files count: {}", e);
            0
        },
        Err(e) => {
            eprintln!("Failed to execute pending files query: {}", e);
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
    
    // 获取正在处理的文件数，用于进度报告
    let pool_clone = pool.clone();
    let initial_processing_count = match tokio::task::spawn_blocking(move || {
        let mut conn = pool_clone.get_connection();
        color_db::get_processing_files_count(&mut conn)
    }).await {
        Ok(Ok(count)) => count,
        Ok(Err(e)) => {
            eprintln!("Failed to get processing files count: {}", e);
            0
        },
        Err(e) => {
            eprintln!("Failed to execute processing files query: {}", e);
            0
        }
    };
    
    // 计算实际需要处理的总文件数（初始值）
    // 修复：优先使用 processing 文件数作为总数，解决首次启动时 pending=0 导致 total=0 的问题
    let mut total_files_to_process = pending_count + extracted_count + initial_processing_count;
    let mut should_report_progress = total_files_to_process > 0;
    let mut last_total_check_time = tokio::time::Instant::now();
    
    // 结果缓冲区，用于批量保存
    let mut result_buffer = Vec::new();
    let batch_save_threshold = 50; // 增大批量保存阈值，从20增加到50
    let mut processed_count = extracted_count; // 从已处理文件数开始计数
    let mut success_count = extracted_count; // 已处理的都是成功的
    let mut error_count = 0;
    let mut last_save_time = tokio::time::Instant::now();
    let auto_save_interval = Duration::from_secs(5); // 增加自动保存间隔，从500ms增加到5秒
    
    // WAL检查点相关变量
    let mut last_checkpoint_time = tokio::time::Instant::now();
    let checkpoint_interval = Duration::from_secs(60); // 每60秒执行一次WAL检查点
    let mut last_checkpoint_processed = processed_count; // 上次检查点时已处理的文件数
    let mut pause_checkpoint_executed = false; // 跟踪是否已经执行了暂停时的检查点
    
    // 持续处理结果
    loop {
        // 1. 尝试接收结果
        match result_receiver.try_recv() {
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
                
                // 定期重新计算总数（每1秒检查一次）
                let time_since_last_check = last_total_check_time.elapsed();
                let mut current_pending = 0;
                if time_since_last_check >= Duration::from_secs(1) {
                    let pool_clone = pool.clone();
                    let (new_pending, _new_extracted, new_processing) = match tokio::task::spawn_blocking(move || {
                        let mut conn = pool_clone.get_connection();
                        let pending = color_db::get_pending_files_count(&mut conn).unwrap_or(0);
                        let extracted = color_db::get_extracted_files_count(&mut conn).unwrap_or(0);
                        let processing = color_db::get_processing_files_count(&mut conn).unwrap_or(0);
                        (pending, extracted, processing)
                    }).await {
                        Ok((pending, extracted, processing)) => (pending, extracted, processing),
                        Err(_) => (0, 0, 0),
                    };
                    
                    current_pending = new_pending;
                    
                    // 使用processing状态的文件数量作为总数
                    let new_total = new_processing;
                    if new_total > 0 && total_files_to_process == 0 {
                        // 如果之前是0，现在有数据了，开始报告进度
                        total_files_to_process = new_total;
                        should_report_progress = true;
                    } else if new_total > total_files_to_process {
                        // 如果总数增加了（有新图片进来），更新总数
                        total_files_to_process = new_total;
                    }
                    last_total_check_time = tokio::time::Instant::now();
                }
                
                // 发送进度报告（只在数据库中有数据时才发送）
                if should_report_progress {
                    if let Some(app_handle) = &app_handle {
                        // 修复：使用待处理+已处理的总数，避免除零错误
                        let progress = ColorExtractionProgress {
                            current: processed_count,
                            total: total_files_to_process,
                            pending: current_pending,
                            current_file: String::new(),
                        };
                        let _ = app_handle.emit("color-extraction-progress", progress);
                    }
                }
                
                if processed_count % 50 == 0 {
                    eprintln!("Total processed: {} (Success: {}, Errors: {})", 
                             processed_count, success_count, error_count);
                }
                
                // 检查是否需要执行WAL检查点
                let checkpoint_elapsed = last_checkpoint_time.elapsed();
                let processed_since_last_checkpoint = processed_count - last_checkpoint_processed;
                
                // 调整触发阈值，增加检查点频率
                if checkpoint_elapsed >= checkpoint_interval || processed_since_last_checkpoint >= 200 {
                    // 检查WAL文件大小，避免在文件较小时执行检查点
                    let pool_clone = pool.clone();
                    let should_execute_checkpoint = match tokio::task::spawn_blocking(move || {
                        pool_clone.get_wal_info()
                    }).await {
                        Ok(Ok((wal_size, _))) => wal_size > 512 * 1024, // 只有当WAL文件大于512KB时才执行检查点
                        _ => true, // 如果获取失败，默认执行
                    };
                    
                    if should_execute_checkpoint {
                        eprintln!("Executing periodic WAL checkpoint after processing {} files ({} processed since last checkpoint)", 
                                 processed_since_last_checkpoint, processed_count);
                        let pool_clone = pool.clone();
                        let checkpoint_start = std::time::Instant::now();
                        tokio::task::spawn_blocking(move || {
                            match pool_clone.force_wal_checkpoint() {
                                Ok(_) => {
                                    let duration = checkpoint_start.elapsed();
                                    eprintln!("Periodic WAL checkpoint completed successfully in {:?}", duration);
                                    // 记录检查点后的数据库文件大小
                                    if let Err(e) = pool_clone.get_db_file_sizes() {
                                        eprintln!("Failed to get database file sizes after checkpoint: {}", e);
                                    }
                                },
                                Err(e) => {
                                    eprintln!("Failed to execute periodic WAL checkpoint: {}", e);
                                }
                            }
                        }).await.unwrap_or_else(|e| eprintln!("Failed to spawn WAL checkpoint task: {}", e));
                        
                        last_checkpoint_time = tokio::time::Instant::now();
                        last_checkpoint_processed = processed_count;
                    } else {
                        eprintln!("Skipping WAL checkpoint - WAL file is too small");
                    }
                }
            },
            Err(crossbeam_channel::TryRecvError::Empty) => {
                // 通道暂时为空，检查是否需要强制保存
                let elapsed_time = last_save_time.elapsed();
                if (!result_buffer.is_empty() && elapsed_time >= auto_save_interval) || is_paused() || is_shutting_down() {
                    save_batch_results(pool.clone(), &mut result_buffer).await;
                    last_save_time = tokio::time::Instant::now();
                    
                    // 如果是暂停或关闭状态，执行WAL检查点（只执行一次）
                    if (is_paused() || is_shutting_down()) && !pause_checkpoint_executed {
                        let reason = if is_paused() { "pause" } else { "shutdown" };
                        eprintln!("Executing WAL checkpoint due to {}", reason);
                        let pool_clone = pool.clone();
                        let checkpoint_start = std::time::Instant::now();
                        tokio::task::spawn_blocking(move || {
                            match pool_clone.force_full_checkpoint() {
                                Ok(_) => {
                                    let duration = checkpoint_start.elapsed();
                                    eprintln!("WAL checkpoint on {} completed successfully in {:?}", reason, duration);
                                },
                                Err(e) => {
                                    eprintln!("Failed to execute WAL checkpoint on {}: {}", reason, e);
                                }
                            }
                        }).await.unwrap_or_else(|e| eprintln!("Failed to spawn WAL checkpoint task: {}", e));
                        
                        pause_checkpoint_executed = true;
                    }
                }
                
                // 即使没有数据，也要检查是否正在关闭
                if is_shutting_down() {
                    // 如果正在关闭且通道空，则跳到关闭逻辑
                } else {
                    // 正常运行，且暂无数据，休眠一会
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            Err(crossbeam_channel::TryRecvError::Disconnected) => {
                // 通道关闭
                break;
            }
        }
        
        // 2. 批量保存逻辑
        if result_buffer.len() >= batch_save_threshold {
            save_batch_results(pool.clone(), &mut result_buffer).await;
            last_save_time = tokio::time::Instant::now();
        }

        // 3. 处理关闭逻辑
        if is_shutting_down() {
            eprintln!("Shutdown initiated, draining remaining results...");
            
            // 尽力排空通道
            while let Ok(result) = result_receiver.try_recv() {
                processed_count += 1;
                match result {
                    Ok((file_path, colors)) => {
                        result_buffer.push((file_path, colors));
                        success_count += 1;
                    },
                    Err(e) => {
                        error_count += 1;
                        eprintln!("Error during shutdown drain: {}", e);
                    }
                }
                if result_buffer.len() >= batch_save_threshold {
                    save_batch_results(pool.clone(), &mut result_buffer).await;
                }
            }
            
            // 最后一跳保存
            if !result_buffer.is_empty() {
                save_batch_results(pool.clone(), &mut result_buffer).await;
            }
            
            // 执行最终WAL检查点，确保所有数据写入主数据库
            eprintln!("Executing final WAL checkpoint before shutdown");
            let pool_clone = pool.clone();
            let pool_for_sizes = pool.clone();
            let checkpoint_start = std::time::Instant::now();
            match tokio::task::spawn_blocking(move || {
                pool_clone.force_full_checkpoint()
            }).await {
                Err(e) => eprintln!("Failed to spawn final WAL checkpoint task: {}", e),
                Ok(Err(e)) => eprintln!("Failed to execute final WAL checkpoint: {}", e),
                Ok(_) => {
                    let duration = checkpoint_start.elapsed();
                    eprintln!("Final WAL checkpoint completed successfully in {:?}", duration);
                    // 记录最终数据库文件大小
                    if let Err(e) = pool_for_sizes.get_db_file_sizes() {
                        eprintln!("Failed to get database file sizes after final checkpoint: {}", e);
                    }
                }
            }
            
            eprintln!("Shutdown complete. Final stats: {} processed, {} success, {} error.", 
                     processed_count, success_count, error_count);
            break;
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
    
    eprintln!("Saving batch of {} files to database", batch_data.len());
    
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
    } else {
        // 保存成功后，记录数据库文件大小
        let pool_clone = pool.clone();
        tokio::task::spawn_blocking(move || {
            if let Err(e) = pool_clone.get_db_file_sizes() {
                eprintln!("Failed to get database file sizes after batch save: {}", e);
            }
        }).await.unwrap_or_else(|e| eprintln!("Failed to spawn file size monitoring task: {}", e));
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
