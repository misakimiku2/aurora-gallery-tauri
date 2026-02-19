use std::sync::Arc;
use std::time::Duration;
use image::{ImageFormat, GenericImageView};
use image::codecs::jpeg::JpegDecoder;
use jxl_oxide::JxlImage;
use fast_image_resize as fr;
use std::num::NonZeroU32;
use std::fs::{self, File};
use std::io::{BufReader, Read};
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use tauri::{AppHandle, Emitter};
use serde::Serialize;
use crossbeam_channel::{unbounded, Sender, Receiver};
use tokio::task;

use crate::color_db::{self, ColorDbPool};
use crate::color_extractor;
use crate::image_utils::{is_jxl, ACTIVE_HEAVY_DECODES, MAX_CONCURRENT_HEAVY_DECODES};

// 全局暂停状态
static IS_PAUSED: AtomicBool = AtomicBool::new(false);

// 全局关闭状态
static IS_SHUTTING_DOWN: AtomicBool = AtomicBool::new(false);

// 全局批次ID计数器
static BATCH_ID_COUNTER: AtomicU64 = AtomicU64::new(0);

// 进度报告结构体
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColorExtractionProgress {
    pub batch_id: u64,           // 批次ID
    pub current: usize,          // 当前批次已处理数量
    pub total: usize,            // 当前批次总数量
    pub pending: usize,          // 待处理数量（用于显示）
    pub current_file: String,    // 当前处理的文件
    pub batch_completed: bool,   // 当前批次是否完成
}

// 批次状态结构体
#[derive(Debug, Clone)]
struct BatchState {
    id: u64,
    total: usize,
    processed: usize,
    started: bool,
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

// 生成新的批次ID
fn generate_batch_id() -> u64 {
    BATCH_ID_COUNTER.fetch_add(1, Ordering::SeqCst)
}

// 定义处理结果结构体（包含批次ID）
type ProcessingResult = Result<(u64, String, Vec<color_extractor::ColorResult>), (u64, String)>;

// 定义任务类型（包含批次ID和文件路径）
type Task = (u64, String);

// 后台处理任务，持续提取待处理图片的主色调
pub async fn color_extraction_worker(
    pool: Arc<ColorDbPool>,
    batch_size: usize,
    app_handle: Option<Arc<AppHandle>>,
    cache_root: Option<std::path::PathBuf>
) {
    // 创建任务通道（无界）
    let (task_sender, task_receiver): (Sender<Task>, Receiver<Task>) = unbounded();
    
    // 创建结果通道（无界）
    let (result_sender, result_receiver): (Sender<ProcessingResult>, Receiver<ProcessingResult>) = unbounded();

    // 创建批次信息通道（无界）
    let (batch_info_sender, batch_info_receiver): (Sender<(u64, usize)>, Receiver<(u64, usize)>) = unbounded();
    
    // 使用互斥锁跟踪当前处理的文件，用于进度报告
    let current_file = Arc::new(Mutex::new(String::new()));
    
    // 1. 启动生产者任务：持续从数据库获取待处理文件
    let pool_producer = pool.clone();
    let producer_handle = task::spawn(async move {
        producer_loop(pool_producer, batch_size, task_sender, batch_info_sender).await;
    });
    
    // 2. 启动多个消费者任务：并行处理文件
    // - 优先使用环境变量 AURORA_COLOR_WORKERS
    // - 否则使用 logical_cores（充分利用所有核心）
    // - 上限设置为逻辑核心数，充分利用 CPU 性能
    let logical_cores = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4);
    let env_workers = std::env::var("AURORA_COLOR_WORKERS").ok().and_then(|s| s.parse::<usize>().ok());
    let default_workers = logical_cores.max(4);
    let num_workers = env_workers.unwrap_or(default_workers).min(logical_cores);
    // 在基准模式下输出配置（方便快速验证）
    if std::env::var("AURORA_BENCH").as_deref().ok() == Some("1") {
        eprintln!("[AURORA_BENCH] logical_cores={} configured_color_workers={}", logical_cores, num_workers);
    }
    let mut consumer_handles = Vec::new();
    
    for _ in 0..num_workers {
        let pool_consumer = pool.clone();
        let task_receiver_clone = task_receiver.clone();
        let result_sender_clone = result_sender.clone();
        let current_file_clone = current_file.clone();
        let cache_root_clone = cache_root.clone();
        
        let handle = task::spawn_blocking(move || {
            consumer_loop(
                pool_consumer,
                task_receiver_clone,
                result_sender_clone,
                current_file_clone,
                cache_root_clone
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
            app_handle_result,
            batch_info_receiver
        ).await;
    });
    
    // 等待所有任务完成（实际上不会完成，会一直运行）
    producer_handle.await.unwrap();
    for handle in consumer_handles {
        handle.await.unwrap();
    }
    result_handle.await.unwrap();
}

// 生产者循环：持续从数据库获取待处理文件，按批次管理
async fn producer_loop(
    pool: Arc<ColorDbPool>,
    batch_size: usize,
    task_sender: Sender<Task>,
    batch_info_sender: Sender<(u64, usize)>
) {
    // 等待时间变量，用于文件聚合
    let mut debounce_deadline: Option<tokio::time::Instant> = None;
    let debounce_duration = Duration::from_secs(2); // 基础等待2秒
    let mut last_pending_count: usize = 0; // 上次检测到的数量
    
    loop {
        // 检查是否暂停或关闭
        if is_paused() || is_shutting_down() {
            tokio::time::sleep(Duration::from_millis(500)).await;
            if is_shutting_down() {
                eprintln!("Producer shutting down, stopping new task dispatch");
                break;
            }
            continue;
        }
        
        // 克隆pool
        let pool_clone = pool.clone();
        
        // 检查待处理文件数量
        let pending_count = match tokio::task::spawn_blocking(move || {
            let mut conn = pool_clone.get_connection();
            color_db::get_pending_files_count(&mut conn)
        }).await {
            Ok(Ok(count)) => count,
            Ok(Err(e)) => {
                eprintln!("Failed to get pending files count: {}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            },
            Err(e) => {
                eprintln!("Failed to execute database query: {}", e);
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        
        if pending_count == 0 {
            // 没有待处理文件，重置防抖计时器
            debounce_deadline = None;
            last_pending_count = 0;
            tokio::time::sleep(Duration::from_millis(500)).await;
            continue;
        }
        
        // 文件防抖逻辑：等待更多文件被添加完成 (Sliding Window)
        if debounce_deadline.is_none() {
            // 首次检测到待处理文件，开始等待
            debounce_deadline = Some(tokio::time::Instant::now() + debounce_duration);
            last_pending_count = pending_count;
            eprintln!("Detected {} pending files, waiting for file copy to complete...", pending_count);
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        
        let deadline = debounce_deadline.unwrap();
        let now = tokio::time::Instant::now();
        
        // 如果文件数量增加，延长等待时间（滑动窗口）
        if pending_count > last_pending_count {
            eprintln!("Pending files increased ({} -> {}), extending wait window...", last_pending_count, pending_count);
            debounce_deadline = Some(now + Duration::from_millis(1500)); // 延长1.5秒
            last_pending_count = pending_count;
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }

        if now < deadline {
            // 还在等待期，继续等待
            tokio::time::sleep(Duration::from_millis(200)).await;
            continue;
        }
        
        // 等待期结束，重新获取最终的待处理文件数量
        let pool_clone = pool.clone();
        let final_pending_count = match tokio::task::spawn_blocking(move || {
            let mut conn = pool_clone.get_connection();
            color_db::get_pending_files_count(&mut conn)
        }).await {
            Ok(Ok(count)) => count,
            Ok(Err(_)) | Err(_) => {
                tokio::time::sleep(Duration::from_millis(100)).await;
                continue;
            }
        };
        
        if final_pending_count == 0 {
            debounce_deadline = None;
            continue;
        }
        
        // 创建新批次
        let batch_id = generate_batch_id();
        eprintln!("=== Starting new batch {} with {} files ===", batch_id, final_pending_count);
        
        // 发送批次信息给结果处理器
        if let Err(e) = batch_info_sender.send((batch_id, final_pending_count)) {
            eprintln!("Failed to send batch info: {}", e);
        }

        // 重置防抖计时器
        debounce_deadline = None;
        last_pending_count = 0;
        
        // 获取所有待处理文件并发送到任务队列
        let mut batch_files_sent = 0;
        let batch_total = final_pending_count; // 锁定当前批次的总数

        loop {
            // 如果已经发送了足够的文件，就停止当前批次
            if batch_files_sent >= batch_total {
                eprintln!("Batch {} limit reached ({}/{} dispatched), deferring remaining files to next batch", 
                         batch_id, batch_files_sent, batch_total);
                break;
            }

            let pool_clone = pool.clone();
            
            // 计算剩余需要获取的文件数，不能超过设定的 batch_size
            let remaining = batch_total - batch_files_sent;
            let current_batch_limit = batch_size.min(remaining);

            // 获取一批待处理文件
            let pending_files = match tokio::task::spawn_blocking(move || {
                let mut conn = pool_clone.get_connection();
                let files = color_db::get_pending_files(&mut conn, current_batch_limit);
                
                // 立即将获取的文件状态更新为processing
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
                    break;
                },
                Err(e) => {
                    eprintln!("Failed to execute database query: {}", e);
                    break;
                }
            };
            
            if pending_files.is_empty() {
                // 该批次所有文件已发送完毕
                break;
            }
            
            // 将文件路径发送到任务队列（带批次ID）
            for file_path in pending_files {
                if task_sender.send((batch_id, file_path)).is_err() {
                    eprintln!("Task sender closed, producer exiting");
                    return;
                }
                batch_files_sent += 1;
            }
            
            // 短暂睡眠
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        
        eprintln!("Batch {} dispatched {} files to processing queue", batch_id, batch_files_sent);
        
        // 等待一段时间后检查是否有新文件
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

// 消费者循环：从队列获取任务并处理（带批次支持）
fn consumer_loop(
    pool: Arc<ColorDbPool>,
    task_receiver: Receiver<Task>,
    result_sender: Sender<ProcessingResult>,
    current_file: Arc<Mutex<String>>,
    cache_root: Option<std::path::PathBuf>
) {
    // 持续从任务队列获取任务
    loop {
        // 检查是否暂停或关闭
        if is_paused() || is_shutting_down() {
            if is_shutting_down() {
                eprintln!("Consumer loop received shutdown signal, exiting.");
                break;
            }
            std::thread::sleep(Duration::from_millis(200));
            continue;
        }
        
        // 尝试接收任务
        match task_receiver.recv_timeout(Duration::from_millis(50)) {
            Ok((batch_id, file_path)) => {
                // 更新当前处理的文件
                let _ = *current_file.lock().unwrap() = file_path.clone();

                // 识别重载格式并进入信号量保护
                let is_heavy = file_path.to_lowercase().ends_with(".jxl") || file_path.to_lowercase().ends_with(".avif");
                
                if is_heavy {
                    // 等待直到活跃重载任务少于阈值
                    while ACTIVE_HEAVY_DECODES.load(Ordering::Relaxed) >= MAX_CONCURRENT_HEAVY_DECODES {
                        std::thread::sleep(Duration::from_millis(100));
                        if is_shutting_down() { break; }
                    }
                    ACTIVE_HEAVY_DECODES.fetch_add(1, Ordering::SeqCst);
                }

                // 可选基准：测量 load / extract 时间（仅在 AURORA_BENCH=1 时输出）
                let bench = std::env::var("AURORA_BENCH").as_deref().ok() == Some("1");
                let t_start = std::time::Instant::now();
                let img_res = load_and_resize_image_optimized(&file_path, cache_root.as_deref());
                let t_after_load = std::time::Instant::now();

                if is_heavy {
                    ACTIVE_HEAVY_DECODES.fetch_sub(1, Ordering::SeqCst);
                }

                // 处理图片（解码 + 提取）并记录耗时
                let processing_result: ProcessingResult = match img_res {
                    Ok(img) => {
                        let colors = color_extractor::get_dominant_colors(&img, 8);
                        let t_after_extract = std::time::Instant::now();

                        if bench {
                            let load_ms = (t_after_load - t_start).as_millis();
                            let extract_ms = (t_after_extract - t_after_load).as_millis();
                            eprintln!("[AURORA_BENCH] file={} load_ms={} extract_ms={}", file_path, load_ms, extract_ms);
                        }

                        if colors.is_empty() {
                            Err((batch_id, format!("No colors extracted from file: {}", file_path)))
                        } else {
                            Ok((batch_id, file_path.clone(), colors))
                        }
                    },
                    Err(e) => {
                        if bench {
                            let load_ms = (t_after_load - t_start).as_millis();
                            eprintln!("[AURORA_BENCH] file={} load_ms={} error={}", file_path, load_ms, e);
                        }
                        Err((batch_id, format!("Failed to load image {}: {}", file_path, e)))
                    }
                };

                // 克隆结果用于后续错误处理
                let result_clone = processing_result.clone();

                if result_sender.send(processing_result).is_err() {
                    eprintln!("Result sender closed, consumer exiting");
                    break;
                }

                // Throttle CPU: Sleep after processing to avoid continuous 100% usage
                // 优化：减少休眠时间以提高 SSD 环境下的处理速度
                // 对于普通格式给 1ms 喘息时间，JXL/AVIF 给 10ms
                let sleep_ms = if is_heavy { 10 } else { 1 };
                std::thread::sleep(Duration::from_millis(sleep_ms));

                // 如果处理失败，更新文件状态为error
                if let Err((_, error_msg)) = result_clone {
                    let pool_clone = pool.clone();
                    let file_path_clone = file_path.clone();
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
                continue;
            },
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => {
                eprintln!("Task receiver disconnected, consumer exiting");
                break;
            }
        }
    }
}

// 结果处理器：批量保存结果到数据库（带批次管理）
async fn result_processor(
    pool: Arc<ColorDbPool>,
    result_receiver: Receiver<ProcessingResult>,
    app_handle: Option<Arc<AppHandle>>,
    batch_info_receiver: Receiver<(u64, usize)>
) {
    use std::collections::HashMap;
    
    // 批次状态跟踪：batch_id -> (total, processed, started)
    let mut batch_states: HashMap<u64, BatchState> = HashMap::new();
    
    // 结果缓冲区，用于批量保存
    let mut result_buffer: Vec<(String, Vec<color_extractor::ColorResult>)> = Vec::new();
    // 降低保存阈值，减少单次数据库事务锁定时间，从而减少对生产者线程的阻塞
    // 这解决了任务暂停前进度更新停滞/卡顿的问题
    let batch_save_threshold = 20; 
    let mut last_save_time = tokio::time::Instant::now();
    let auto_save_interval = Duration::from_secs(2); // 缩短自动保存间隔
    
    // 统计计数
    let mut total_success_count = 0usize;
    let mut total_error_count = 0usize;
    
    // WAL检查点相关变量
    let mut last_checkpoint_time = tokio::time::Instant::now();
    let checkpoint_interval = Duration::from_secs(60);
    let mut total_processed_since_checkpoint = 0usize;
    let mut pause_checkpoint_executed = false;
    
    // 持续处理结果
    loop {
        // 0. 优先处理批次信息更新
        while let Ok((id, total)) = batch_info_receiver.try_recv() {
            batch_states.entry(id)
                .and_modify(|s| {
                    if s.total != total {
                        eprintln!("=== Updating batch {} total: {} -> {} ===", id, s.total, total);
                        s.total = total;
                    }
                })
                .or_insert(BatchState {
                    id,
                    total,
                    processed: 0,
                    started: true,
                });
        }

        // 1. 尝试接收结果
        match result_receiver.try_recv() {
            Ok(result) => {
                let (batch_id, file_path, colors_opt, is_error) = match result {
                    Ok((bid, path, colors)) => (bid, path, Some(colors), false),
                    Err((bid, err_msg)) => {
                        eprintln!("Error processing file: {}", err_msg);
                        (bid, String::new(), None, true)
                    }
                };
                
                // 更新批次状态
                let batch_state = batch_states.entry(batch_id).or_insert_with(|| {
                    // 获取该批次的总文件数（processing状态的文件数）
                    let pool_clone = pool.clone();
                    let count = std::thread::spawn(move || {
                        let mut conn = pool_clone.get_connection();
                        color_db::get_processing_files_count(&mut conn).unwrap_or(0)
                    }).join().unwrap_or(0);
                    
                    eprintln!("=== New batch {} detected, total files: {} ===", batch_id, count);
                    
                    BatchState {
                        id: batch_id,
                        total: count,
                        processed: 0,
                        started: false,
                    }
                });
                
                batch_state.processed += 1;
                total_processed_since_checkpoint += 1;
                
                if is_error {
                    total_error_count += 1;
                } else {
                    total_success_count += 1;
                    if let Some(colors) = colors_opt {
                        result_buffer.push((file_path, colors));
                    }
                }
                
                // 发送进度报告
                if let Some(app_handle) = &app_handle {
                    let batch_completed = batch_state.processed >= batch_state.total && batch_state.total > 0;
                    
                    let progress = ColorExtractionProgress {
                        batch_id,
                        current: batch_state.processed,
                        total: batch_state.total,
                        pending: batch_state.total.saturating_sub(batch_state.processed),
                        current_file: String::new(),
                        batch_completed,
                    };
                    let _ = app_handle.emit("color-extraction-progress", progress);
                    
                    // 如果批次完成，从跟踪列表移除（延迟清理）
                    if batch_completed {
                        eprintln!("=== Batch {} completed: {}/{} ===", batch_id, batch_state.processed, batch_state.total);
                    }
                }
                
                if (total_success_count + total_error_count) % 50 == 0 {
                    eprintln!("Total processed: {} (Success: {}, Errors: {})", 
                             total_success_count + total_error_count, total_success_count, total_error_count);
                }
                
                // 检查WAL检查点
                let checkpoint_elapsed = last_checkpoint_time.elapsed();
                if checkpoint_elapsed >= checkpoint_interval || total_processed_since_checkpoint >= 200 {
                    let pool_clone = pool.clone();
                    let should_checkpoint = match tokio::task::spawn_blocking(move || {
                        pool_clone.get_wal_info()
                    }).await {
                        Ok(Ok((wal_size, _))) => wal_size > 512 * 1024,
                        _ => true,
                    };
                    
                    if should_checkpoint {
                        let pool_clone = pool.clone();
                        let checkpoint_start = std::time::Instant::now();
                        tokio::task::spawn_blocking(move || {
                            match pool_clone.force_wal_checkpoint() {
                                Ok(_) => {
                                    let duration = checkpoint_start.elapsed();
                                    eprintln!("Periodic WAL checkpoint completed in {:?}", duration);
                                },
                                Err(e) => eprintln!("WAL checkpoint failed: {}", e)
                            }
                        }).await.unwrap_or_else(|e| eprintln!("Checkpoint task failed: {}", e));
                        
                        last_checkpoint_time = tokio::time::Instant::now();
                        total_processed_since_checkpoint = 0;
                    }
                }
            },
            Err(crossbeam_channel::TryRecvError::Empty) => {
                // 通道暂时为空
                let elapsed_time = last_save_time.elapsed();
                if (!result_buffer.is_empty() && elapsed_time >= auto_save_interval) || is_paused() || is_shutting_down() {
                    let batch_data: Vec<_> = result_buffer.drain(0..).collect();
                    if is_shutting_down() || is_paused() {
                        save_batch_results(pool.clone(), batch_data).await;
                    } else {
                        tokio::task::spawn(save_batch_results(pool.clone(), batch_data));
                    }
                    last_save_time = tokio::time::Instant::now();
                    
                    if (is_paused() || is_shutting_down()) && !pause_checkpoint_executed {
                        let reason = if is_paused() { "pause" } else { "shutdown" };
                        eprintln!("Executing WAL checkpoint due to {}", reason);
                        let pool_clone = pool.clone();
                        tokio::task::spawn_blocking(move || {
                            let _ = pool_clone.force_full_checkpoint();
                        }).await.unwrap_or_else(|e| eprintln!("Checkpoint task failed: {}", e));
                        pause_checkpoint_executed = true;
                    }
                }
                
                if is_shutting_down() {
                    // 继续到关闭逻辑
                } else {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            },
            Err(crossbeam_channel::TryRecvError::Disconnected) => {
                break;
            }
        }
        
        // 2. 批量保存逻辑
        if result_buffer.len() >= batch_save_threshold {
            let batch_data: Vec<_> = result_buffer.drain(0..).collect();
            tokio::task::spawn(save_batch_results(pool.clone(), batch_data));
            last_save_time = tokio::time::Instant::now();
        }

        // 3. 清理已完成的批次（保留最近5个用于查询）
        if batch_states.len() > 10 {
            let mut completed: Vec<u64> = batch_states.iter()
                .filter(|(_, state)| state.processed >= state.total && state.total > 0)
                .map(|(id, _)| *id)
                .collect();
            completed.sort();
            // 移除较老的已完成批次
            for id in completed.iter().take(completed.len().saturating_sub(5)) {
                batch_states.remove(id);
            }
        }

        // 4. 处理关闭逻辑
        if is_shutting_down() {
            eprintln!("Shutdown initiated, draining remaining results...");
            
            while let Ok(result) = result_receiver.try_recv() {
                match result {
                    Ok((_bid, file_path, colors)) => {
                        result_buffer.push((file_path, colors));
                        total_success_count += 1;
                    },
                    Err((_bid, e)) => {
                        total_error_count += 1;
                        eprintln!("Error during shutdown drain: {}", e);
                    }
                }
                if result_buffer.len() >= batch_save_threshold {
                    let batch_data: Vec<_> = result_buffer.drain(0..).collect();
                    save_batch_results(pool.clone(), batch_data).await;
                }
            }
            
            if !result_buffer.is_empty() {
                let batch_data: Vec<_> = result_buffer.drain(0..).collect();
                save_batch_results(pool.clone(), batch_data).await;
            }
            
            // 执行最终WAL检查点
            eprintln!("Executing final WAL checkpoint before shutdown");
            let pool_clone = pool.clone();
            match tokio::task::spawn_blocking(move || {
                pool_clone.force_full_checkpoint()
            }).await {
                Err(e) => eprintln!("Final checkpoint task failed: {}", e),
                Ok(Err(e)) => eprintln!("Final checkpoint failed: {}", e),
                Ok(_) => eprintln!("Final WAL checkpoint completed")
            }
            
            eprintln!("Shutdown complete. Final stats: {} success, {} error.", 
                     total_success_count, total_error_count);
            break;
        }
    }
    
    // 保存剩余的结果
    if !result_buffer.is_empty() {
        let batch_data: Vec<_> = result_buffer.drain(0..).collect();
        save_batch_results(pool.clone(), batch_data).await;
    }
}

// 批量保存结果到数据库
async fn save_batch_results(
    pool: Arc<ColorDbPool>,
    batch_data: Vec<(String, Vec<color_extractor::ColorResult>)>
) {
    if batch_data.is_empty() {
        return;
    }
    
    eprintln!("Saving batch of {} files to database", batch_data.len());
    
    // 保存结果到数据库
    let pool_clone = pool.clone();
    let save_result = tokio::task::spawn_blocking(move || {
        
        // 将结果转换为batch_save_colors所需的格式
        let batch_data_refs: Vec<(&str, &[color_extractor::ColorResult])> = batch_data
            .iter()
            .map(|(file_path, colors)| (file_path.as_str(), colors.as_slice()))
            .collect();
        
        pool_clone.batch_save_colors(&batch_data_refs)
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

// 优化后的图像加载和缩放逻辑
pub fn load_and_resize_image_optimized(file_path: &str, cache_root: Option<&std::path::Path>) -> Result<image::DynamicImage, String> {
    let image_path = std::path::Path::new(file_path);
    
    // 1. 尝试使用缩略图缓存 (如果存在)
    if let Some(root) = cache_root {
        if let Ok(metadata) = fs::metadata(image_path) {
            let size = metadata.len();
            let modified = metadata.modified()
                .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
                .unwrap_or(0);
            
            if let Ok(mut file) = File::open(image_path) {
                let mut buffer = [0u8; 4096];
                let bytes_read = file.read(&mut buffer).unwrap_or(0);
                
                let cache_key = format!("{}-{}-{:?}", size, modified, &buffer[..bytes_read]);
                let hash_str = format!("{:x}", md5::compute(cache_key.as_bytes()));
                let cache_filename = if hash_str.len() >= 24 { hash_str[..24].to_string() } else { format!("{:0>24}", hash_str) };
                
                let jpg_cache = root.join(format!("{}.jpg", cache_filename));
                let webp_cache = root.join(format!("{}.webp", cache_filename));
                
                let thumb_path = if jpg_cache.exists() {
                    Some(jpg_cache)
                } else if webp_cache.exists() {
                    Some(webp_cache)
                } else {
                    None
                };
                
                if let Some(tp) = thumb_path {
                    if let Ok(img) = image::open(tp) {
                        return Ok(img);
                    }
                }
            }
        }
    }

    // 2. 缓存未命中，从原图加载
    use std::io::Seek;
    
    // Read header to identify format and magic bytes
    let mut file = File::open(image_path).map_err(|e| e.to_string())?;
    let mut header = [0u8; 1024];
    let n = file.read(&mut header).unwrap_or(0);
    let buf = &header[..n];

    let is_jxl_file = image_path.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase() == "jxl").unwrap_or(false) || is_jxl(buf);
    
    let img = if is_jxl_file {
        // Special handling for JXL using jxl-oxide
        let jxl_image = JxlImage::builder().open(image_path).map_err(|e| format!("JXL error: {:?}", e))?;
        
        let render = jxl_image.render_frame(0).map_err(|e| format!("JXL render error: {:?}", e))?;
        let framebuffer = render.image_all_channels();
        
        let width = framebuffer.width() as u32;
        let height = framebuffer.height() as u32;
        let channels = framebuffer.channels();
        let buf = framebuffer.buf();
        
        if channels == 3 {
            use rayon::prelude::*;
            let pixels: Vec<u8> = buf.par_iter().map(|&val| (val * 255.0).clamp(0.0, 255.0) as u8).collect();
            image::DynamicImage::ImageRgb8(image::RgbImage::from_raw(width, height, pixels).ok_or("Failed to create RGB image")?)
        } else {
            use rayon::prelude::*;
            let pixels: Vec<u8> = buf.par_iter().map(|&val| (val * 255.0).clamp(0.0, 255.0) as u8).collect();
            image::DynamicImage::ImageRgba8(image::RgbaImage::from_raw(width, height, pixels).ok_or("Failed to create RGBA image")?)
        }
    } else {
        let format = image::guess_format(buf).ok();

        file.seek(std::io::SeekFrom::Start(0)).map_err(|e| e.to_string())?;
        let reader = BufReader::new(file);

        if format == Some(ImageFormat::Jpeg) {
            // JPEG 优化加载：解码时降采样
            let mut decoder = JpegDecoder::new(reader).map_err(|e| e.to_string())?;
            // 目标是 256px，利用 JpegDecoder 的 scale 功能
            let _ = decoder.scale(256, 256);
            image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?
        } else {
            // 其他格式：正常加载后使用 fast_image_resize
            let mut img_reader = image::io::Reader::new(reader);
            if let Some(fmt) = format {
                img_reader.set_format(fmt);
            } else {
                img_reader = img_reader.with_guessed_format().map_err(|e| e.to_string())?;
            }
            img_reader.no_limits();
            img_reader.decode().map_err(|e| e.to_string())?
        }
    };

    let (width, height) = img.dimensions();
    let target_size = 256;
    if width <= target_size && height <= target_size {
        return Ok(img);
    }

        let (dst_width, dst_height) = if width < height {
            let ratio = height as f32 / width as f32;
            (target_size, (target_size as f32 * ratio) as u32)
        } else {
            let ratio = width as f32 / height as f32;
            ((target_size as f32 * ratio) as u32, target_size)
        };

        let src_width = NonZeroU32::new(width).ok_or("Invalid width")?;
        let src_height = NonZeroU32::new(height).ok_or("Invalid height")?;
        let dst_width_nz = NonZeroU32::new(dst_width).ok_or("Invalid dst width")?;
        let dst_height_nz = NonZeroU32::new(dst_height).ok_or("Invalid dst height")?;

        let pixel_type = if img.color().has_alpha() {
            fr::PixelType::U8x4
        } else {
            fr::PixelType::U8x3
        };

        let src_image = fr::Image::from_vec_u8(
            src_width,
            src_height,
            if pixel_type == fr::PixelType::U8x4 { img.to_rgba8().into_raw() } else { img.to_rgb8().into_raw() },
            pixel_type,
        ).map_err(|e| e.to_string())?;

        let mut dst_image = fr::Image::new(dst_width_nz, dst_height_nz, src_image.pixel_type());
        let mut resizer = fr::Resizer::new(fr::ResizeAlg::Convolution(fr::FilterType::Hamming));
        resizer.resize(&src_image.view(), &mut dst_image.view_mut()).map_err(|e| e.to_string())?;

        if pixel_type == fr::PixelType::U8x4 {
            Ok(image::DynamicImage::ImageRgba8(
                image::RgbaImage::from_raw(dst_width, dst_height, dst_image.buffer().to_vec())
                    .ok_or("Failed to create RgbaImage")?
            ))
        } else {
            Ok(image::DynamicImage::ImageRgb8(
                image::RgbImage::from_raw(dst_width, dst_height, dst_image.buffer().to_vec())
                    .ok_or("Failed to create RgbImage")?
            ))
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
    
    // 2. 加载图片 (此处暂时不传递 cache_root，因为 process_single_file 通常在已知路径时调用)
    let img = load_and_resize_image_optimized(&file_path, None)?;
    
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
        pool_clone.save_colors(&file_path_clone, &colors_clone)
    }).await.map_err(|e| format!("Failed to save colors: {}", e))?
        .map_err(|e| format!("Database error: {}", e))?;
    
    Ok(())
}
