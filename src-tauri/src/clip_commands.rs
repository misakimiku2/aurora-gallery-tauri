use crate::clip::embedding::ImageEmbedding;
use crate::clip::search::{SearchOptions, SearchResult};
use crate::db::{self, generate_id, AppDbPool};
use crate::db::file_metadata::{FileMetadata, upsert_file_metadata, get_metadata_by_id};
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

const TAGS_EN_CSV: &str = include_str!("clip/tags_info.csv");

static CANCEL_GENERATION: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static PAUSE_GENERATION: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));
static IS_GENERATING: Lazy<AtomicBool> = Lazy::new(|| AtomicBool::new(false));

fn reset_cancel_flag() {
    CANCEL_GENERATION.store(false, Ordering::SeqCst);
}

fn should_cancel() -> bool {
    CANCEL_GENERATION.load(Ordering::SeqCst)
}

async fn check_pause() {
    while PAUSE_GENERATION.load(Ordering::SeqCst) {
        if should_cancel() {
            break;
        }
        tokio::time::sleep(tokio::time::Duration::from_millis(100)).await;
    }
}

#[tauri::command]
pub async fn clip_search_by_text(
    text: String,
    top_k: Option<usize>,
    min_score: Option<f32>,
    model_name: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<SearchResult>, String> {
    log::info!("[CLIP Search] Starting text search: '{}' with model: {:?}", text, model_name);
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let requested_model = model_name.unwrap_or_else(|| "ViT-B-32".to_string());
    log::info!("[CLIP Search] Requested model: {}", requested_model);
    
    {
        let guard = manager.read().await;
        let current_model = guard.get_model_name();
        let is_loaded = guard.is_model_loaded();
        
        log::info!("[CLIP Search] Current model: {}, is_loaded: {}", current_model, is_loaded);
        
        if !is_loaded || current_model != requested_model {
            drop(guard);
            
            let mut guard = manager.write().await;
            let current_model = guard.get_model_name();
            let is_loaded = guard.is_model_loaded();
            
            if !is_loaded || current_model != requested_model {
                log::info!("[CLIP Search] Switching to model: {} (current: {}, loaded: {})", 
                    requested_model, current_model, is_loaded);
                
                // 使用 switch_model 切换模型和嵌入数据库
                guard.switch_model(&requested_model)?;
                guard.load_model(&app).await.map_err(|e| format!("Failed to load model: {}", e))?;
            }
        }
    }
    
    let mut guard = manager.write().await;
    
    let model = guard.model_mut()
        .ok_or("CLIP model not available")?;
    
    log::info!("[CLIP Search] Encoding text...");
    let text_embedding = model.encode_text(&text)?;
    log::info!("[CLIP Search] Text embedding dimension: {}", text_embedding.len());
    
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    let all_count = embedding_store.get_embedding_count().unwrap_or(0);
    log::info!("[CLIP Search] Total embeddings in store: {}", all_count);
    
    let searcher = crate::clip::search::SimilaritySearcher::new(embedding_store.clone());
    let options = SearchOptions {
        top_k: top_k.unwrap_or(50),
        min_score: min_score.unwrap_or(0.0),
        include_score: true,
    };
    
    let results = searcher.search(&text_embedding, &options, Some(&requested_model))?;
    log::info!("[CLIP Search] Search returned {} results", results.len());
    
    Ok(results)
}

#[tauri::command]
pub async fn clip_search_by_image(
    image_path: String,
    top_k: Option<usize>,
    min_score: Option<f32>,
    model_name: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<SearchResult>, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let requested_model = model_name.unwrap_or_else(|| "ViT-B-32".to_string());
    
    {
        let guard = manager.read().await;
        let current_model = guard.get_model_name();
        let is_loaded = guard.is_model_loaded();
        
        if !is_loaded || current_model != requested_model {
            drop(guard);
            
            let mut guard = manager.write().await;
            let current_model = guard.get_model_name();
            let is_loaded = guard.is_model_loaded();
            
            if !is_loaded || current_model != requested_model {
                log::info!("Switching to model: {} (current: {}, loaded: {})", 
                    requested_model, current_model, is_loaded);
                
                // 使用 switch_model 切换模型和嵌入数据库
                guard.switch_model(&requested_model)?;
                guard.load_model(&app).await.map_err(|e| format!("Failed to load model: {}", e))?;
            }
        }
    }
    
    let mut guard = manager.write().await;
    
    let model = guard.model_mut()
        .ok_or("CLIP model not available")?;
    
    let inference_result = model.encode_image(&image_path)?;
    let image_embedding = inference_result.embedding;
    
    let query_file_id = generate_id(&image_path);
    
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    let searcher = crate::clip::search::SimilaritySearcher::new(embedding_store.clone());
    let options = SearchOptions {
        top_k: top_k.unwrap_or(50),
        min_score: min_score.unwrap_or(0.0),
        include_score: true,
    };
    
    let results = if embedding_store.get_embedding(&query_file_id)?.is_some() {
        log::info!("[CLIP Image Search] Query file {} has embedding in store, excluding self", query_file_id);
        searcher.search_similar_exclude_self(&query_file_id, &options)?
    } else {
        log::info!("[CLIP Image Search] Query file {} not in store, searching directly", query_file_id);
        searcher.search(&image_embedding, &options, Some(&requested_model))?
    };
    
    log::info!("[CLIP Image Search] Found {} results", results.len());
    
    Ok(results)
}

#[tauri::command]
pub async fn clip_generate_embedding(
    file_path: String,
    file_id: Option<String>,
    auto_add_tags: Option<bool>,
    tag_threshold: Option<f32>,
    language: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<f32>, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let mut guard = manager.write().await;
    
    if !guard.is_model_loaded() {
        return Err("CLIP model not loaded".to_string());
    }
    
    let model = guard.model_mut()
        .ok_or("CLIP model not available")?;
    
    let inference_result = model.encode_image(&file_path)?;
    let embedding = inference_result.embedding;
    
    let config_clone = guard.config().clone();
    if let Some(embedding_store) = guard.embedding_store() {
        let id = file_id.unwrap_or_else(|| generate_id(&file_path));
        
        // 保存标签（如果是 Tagger 且开启了自动添加标签）
        let auto_add = auto_add_tags.unwrap_or(false);
        let threshold = tag_threshold.unwrap_or(0.35);
        let lang = language.unwrap_or_else(|| "en".to_string());
        if auto_add {
            if let Some(tags) = &inference_result.tags {
                // 翻译标签
                let translator = crate::clip::model::get_tag_translator();
                let translated_tags = translator.translate_tags(tags, &lang);
                save_tags_to_metadata(&id, &file_path, &translated_tags, threshold, &app)?;
            }
        }

        let image_embedding = ImageEmbedding {
            file_id: id,
            embedding: embedding.clone(),
            model_version: config_clone.model_name.clone(),
            created_at: chrono::Utc::now().timestamp(),
        };
        
        embedding_store.save_embedding(&image_embedding)?;
    }
    
    Ok(embedding)
}

#[tauri::command]
pub async fn clip_get_embedding_status(
    file_id: String,
) -> Result<bool, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let guard = manager.read().await;
    
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    embedding_store.has_embedding(&file_id)
}

#[tauri::command]
pub fn clip_cancel_embedding_generation() {
    CANCEL_GENERATION.store(true, Ordering::SeqCst);
    log::info!("Embedding generation cancellation requested");
}

#[tauri::command]
pub fn clip_pause_embedding_generation() {
    PAUSE_GENERATION.store(true, Ordering::SeqCst);
    log::info!("Embedding generation paused");
}

#[tauri::command]
pub fn clip_resume_embedding_generation() {
    PAUSE_GENERATION.store(false, Ordering::SeqCst);
    log::info!("Embedding generation resumed");
}

#[tauri::command]
pub async fn clip_update_config(use_gpu: bool, app: tauri::AppHandle) -> Result<(), String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;

    let mut guard = manager.write().await;
    guard.update_config(use_gpu, Some(&app)).await.map_err(|e| format!("Failed to update CLIP config: {}", e))
}

#[tauri::command]
pub async fn clip_generate_embeddings_batch(
    app: tauri::AppHandle,
    file_paths: Vec<(String, String)>,
    use_gpu: bool,
    model_name: Option<String>,
    auto_add_tags: Option<bool>,
    tag_threshold: Option<f32>,
    language: Option<String>,
) -> Result<serde_json::Value, String> {
    if IS_GENERATING.swap(true, Ordering::SeqCst) {
        log::warn!("An embedding generation task is already running.");
        return Err("已经有一个任务正在运行，请等待或取消后再试。".to_string());
    }

    struct GenerationGuard {
        app: Option<tauri::AppHandle>,
        cancelled: bool,
    }
    impl Drop for GenerationGuard {
        fn drop(&mut self) {
            IS_GENERATING.store(false, Ordering::SeqCst);
            log::info!("Global generating flag reset.");
            
            // 如果任务被取消，确保发送取消事件
            if self.cancelled {
                if let Some(app) = &self.app {
                    let _ = app.emit("clip-embedding-cancelled", serde_json::json!({
                        "processed": 0,
                        "total": 0,
                    }));
                    log::info!("Sent clip-embedding-cancelled event from GenerationGuard");
                }
            }
        }
    }
    let mut _gen_guard = GenerationGuard { app: Some(app.clone()), cancelled: false };

    reset_cancel_flag();
    PAUSE_GENERATION.store(false, Ordering::SeqCst);
    
    let requested_model = model_name.unwrap_or_else(|| "ViT-B-32".to_string());
    log::info!("[Embedding Gen] Requested model: {}", requested_model);
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;

    {
        let mut guard = manager.write().await;
        guard.update_config(use_gpu, Some(&app)).await.map_err(|e| format!("Failed to update CLIP config: {}", e))?;
    }
    
    {
        let guard = manager.read().await;
        let current_model = guard.get_model_name();
        let is_loaded = guard.is_model_loaded();
        
        log::info!("[Embedding Gen] Current model: {}, is_loaded: {}", current_model, is_loaded);
        
        if !is_loaded || current_model != requested_model {
            drop(guard);
            
            let mut guard = manager.write().await;
            let current_model = guard.get_model_name();
            let is_loaded = guard.is_model_loaded();
            
            if !is_loaded || current_model != requested_model {
                log::info!("[Embedding Gen] Switching to model: {} (current: {}, loaded: {})", 
                    requested_model, current_model, is_loaded);
                
                // 使用 switch_model 切换模型和嵌入数据库
                guard.switch_model(&requested_model)?;
                guard.load_model(&app).await.map_err(|e| format!("Failed to load model: {}", e))?;
            }
        }
    }
    
    let (using_gpu, batch_size, model_name) = {
        let guard = manager.read().await;
        let model = guard.model().ok_or("CLIP model not available")?;
        let using_gpu = model.is_using_gpu();
        let current_model_name = guard.config().model_name.clone();
        
        log::info!("[CLIP Batch] Raw model name from config: '{}'", current_model_name);
        log::info!("[CLIP Batch] Model name bytes: {:?}", current_model_name.as_bytes());
        
        let batch_size = match current_model_name.as_str() {
            "ViT-L-14" => {
                log::info!("[CLIP Batch] Matched ViT-L-14, GPU: {}", using_gpu);
                if using_gpu { 32 } else { 16 }
            },
            "ViT-B-32" => {
                log::info!("[CLIP Batch] Matched ViT-B-32, GPU: {}", using_gpu);
                if using_gpu { 64 } else { 32 }
            },
            "WD-EVA02-Large-Tagger-V3" => {
                log::info!("[CLIP Batch] Matched WD-EVA02-Large-Tagger-V3 (High-Res), GPU: {}", using_gpu);
                if using_gpu { 16 } else { 16 }
            },
            other => {
                log::warn!("[CLIP Batch] Unknown model name '{}', using default batch size", other);
                if using_gpu { 32 } else { 16 }
            },
        };
        log::info!("[CLIP Batch] Final: Model: {}, GPU: {}, batch_size: {}", 
            current_model_name, using_gpu, batch_size);
        (using_gpu, batch_size, current_model_name)
    };
    
    log::info!("CLIP batch generation starting with {} ({} files)", 
        if using_gpu { "GPU acceleration" } else { "CPU fallback" },
        file_paths.len()
    );
    
    let auto_add_tags_enabled = auto_add_tags.unwrap_or(false);
    let tag_threshold_value = tag_threshold.unwrap_or(0.35);
    let lang = language.unwrap_or_else(|| "en".to_string());
    log::info!("CLIP batch tag settings: auto_add_tags={}, threshold={}, language={}", auto_add_tags_enabled, tag_threshold_value, lang);
    
    let total = file_paths.len();
    let mut processed_skipped_count = 0;
    let mut processed_count = 0;
    let mut success_count = 0;
    let mut failed_count = 0;
    let mut skipped_count = 0;
    let mut failed_files = Vec::new();
    let start_time = std::time::Instant::now();
    
    let mut files_to_process: Vec<(String, String)> = Vec::new();
    
    for chunk in file_paths.chunks(100) {
        if should_cancel() {
            log::info!("Embedding generation cancelled during filtering phase.");
            _gen_guard.cancelled = true;
            let _ = app.emit("clip-embedding-cancelled", serde_json::json!({
                "processed": processed_skipped_count,
                "total": total,
            }));
            return Ok(serde_json::json!({
                "total": total,
                "success": 0,
                "failed": 0,
                "cancelled": true,
            }));
        }

        {
            let guard = manager.read().await;
            let embedding_store = guard.embedding_store().ok_or("Embedding store not available")?;
            
            for (file_path, file_id) in chunk {
                match embedding_store.has_embedding_for_model(file_id, &model_name) {
                    Ok(true) => {
                        skipped_count += 1;
                    },
                    _ => {
                        files_to_process.push((file_path.clone(), file_id.clone()));
                    }
                }
            }
        }
        
        processed_skipped_count += chunk.len();
        
        let elapsed_ms = start_time.elapsed().as_millis() as u64;
        let _ = app.emit("clip-embedding-progress", serde_json::json!({
            "current": 0,
            "total": total,
            "progress": (processed_skipped_count as f32 / total as f32 * 5.0) as u32,
            "success": 0,
            "failed": 0,
            "skipped": skipped_count,
            "processed": 0,
            "timestamp": elapsed_ms,
            "stage": "filtering"
        }));
    }
    
    let filtered_count = files_to_process.len();
    log::info!("Filtered {} existing embeddings, {} files to process (total: {})", skipped_count, filtered_count, total);
    
    if filtered_count == 0 {
        log::warn!("No files to process! All {} files were skipped. This might indicate:", total);
        log::warn!("  1. All files already have embeddings");
        log::warn!("  2. file_id mismatch between file_index and embeddings.db");
        log::warn!("  3. Database connectivity issues");
    }
    
    let batches: Vec<_> = files_to_process.chunks(batch_size).collect();
    let total_batches = batches.len();
    
    log::info!("Starting batch processing: {} batches, batch_size={}", total_batches, batch_size);
    
    for (batch_idx, batch) in batches.iter().enumerate() {
        if should_cancel() {
            log::info!("Embedding generation cancelled at batch {}/{}", batch_idx, total_batches);
            _gen_guard.cancelled = true;
            let _ = app.emit("clip-embedding-cancelled", serde_json::json!({
                "processed": processed_count + skipped_count,
                "total": total,
            }));
            break;
        }
        
        check_pause().await;
        
        let batch_start = std::time::Instant::now();
        let batch_paths: Vec<String> = batch.iter().map(|(path, _)| path.clone()).collect();
        
        log::info!("Processing batch {}/{}: {} files", batch_idx + 1, total_batches, batch.len());
        
        if batch_paths.is_empty() {
            log::warn!("Batch {} has empty paths, skipping", batch_idx + 1);
            continue;
        }
        
        log::info!("Batch {} first file: {}", batch_idx + 1, batch_paths.first().unwrap_or(&"N/A".to_string()));
        
        log::info!("Batch {}: acquiring model lock...", batch_idx + 1);
        let embeddings_result = {
            let mut guard = manager.write().await;
            log::info!("Batch {}: got model lock", batch_idx + 1);
            let model = guard.model_mut().ok_or("CLIP model not available")?;
            log::info!("Batch {}: calling encode_images_batch with {} paths...", batch_idx + 1, batch_paths.len());
            model.encode_images_batch(&batch_paths)
        };
        log::info!("Batch {}: encode_images_batch returned", batch_idx + 1);
        
        match embeddings_result {
            Ok(embeddings) => {
                let save_result = {
                    let guard = manager.read().await;
                    let embedding_store = guard.embedding_store().ok_or("Embedding store not available")?;
                    
                    let mut batch_embeddings = Vec::with_capacity(batch.len());
                    for (_i, ((_path, file_id), result)) in batch.iter().zip(embeddings.iter()).enumerate() {
                        // 保存标签（如果是 Tagger 且开启了自动添加标签）
                        if auto_add_tags_enabled {
                            if let Some(tags) = &result.tags {
                                // 翻译标签
                                let translator = crate::clip::model::get_tag_translator();
                                let translated_tags = translator.translate_tags(tags, &lang);
                                let _ = save_tags_to_metadata(file_id, _path, &translated_tags, tag_threshold_value, &app);
                            }
                        }

                        let image_embedding = ImageEmbedding {
                            file_id: file_id.clone(),
                            embedding: result.embedding.clone(),
                            model_version: model_name.clone(),
                            created_at: chrono::Utc::now().timestamp(),
                        };
                        batch_embeddings.push(image_embedding);
                    }
                    
                    embedding_store.save_embeddings_batch(&batch_embeddings)
                };
                
                match save_result {
                    Ok(_) => success_count += batch.len(),
                    Err(e) => {
                        log::error!("Failed to save batch embeddings: {}", e);
                        for (i, (file_path, file_id)) in batch.iter().enumerate() {
                            if i < embeddings.len() {
                                let save_single_result = {
                                    let guard = manager.read().await;
                                    let embedding_store = guard.embedding_store().ok_or("Embedding store not available")?;
                                    let image_embedding = ImageEmbedding {
                                        file_id: file_id.clone(),
                                        embedding: embeddings[i].embedding.clone(),
                                        model_version: model_name.clone(),
                                        created_at: chrono::Utc::now().timestamp(),
                                    };
                                    embedding_store.save_embedding(&image_embedding)
                                };
                                
                                if let Err(e) = save_single_result {
                                    log::error!("Failed to save embedding for {}: {}", file_id, e);
                                    failed_count += 1;
                                    failed_files.push(file_path.clone());
                                } else {
                                    success_count += 1;
                                }
                            }
                        }
                    }
                }
            }
            Err(e) => {
                log::error!("Failed to encode batch {}: {}", batch_idx, e);
                for (file_path, file_id) in batch.iter() {
                    let single_result = {
                        let mut guard = manager.write().await;
                        let model = guard.model_mut().ok_or("CLIP model not available")?;
                        model.encode_image(file_path)
                    };
                    
                    match single_result {
                        Ok(result) => {
                            let save_result = {
                                let guard = manager.read().await;
                                let embedding_store = guard.embedding_store().ok_or("Embedding store not available")?;
                                
                                // 保存标签（如果是 Tagger 且开启了自动添加标签）
                                if auto_add_tags_enabled {
                                    if let Some(tags) = &result.tags {
                                        // 翻译标签
                                        let translator = crate::clip::model::get_tag_translator();
                                        let translated_tags = translator.translate_tags(tags, &lang);
                                        let _ = save_tags_to_metadata(file_id, file_path, &translated_tags, tag_threshold_value, &app);
                                    }
                                }

                                let image_embedding = ImageEmbedding {
                                    file_id: file_id.clone(),
                                    embedding: result.embedding,
                                    model_version: model_name.clone(),
                                    created_at: chrono::Utc::now().timestamp(),
                                };
                                embedding_store.save_embedding(&image_embedding)
                            };
                            
                            if let Err(e) = save_result {
                                log::error!("Failed to save embedding for {}: {}", file_id, e);
                                failed_count += 1;
                                failed_files.push(file_path.clone());
                            } else {
                                success_count += 1;
                            }
                        }
                        Err(e) => {
                            log::error!("Failed to encode image {}: {}", file_path, e);
                            failed_count += 1;
                            failed_files.push(file_path.clone());
                        }
                    }
                }
            }
        }
        
        processed_count += batch.len();
        let batch_elapsed = batch_start.elapsed().as_millis();
        
        let progress = if filtered_count > 0 {
            5 + (processed_count as f32 / filtered_count as f32 * 95.0) as u32
        } else {
            100
        };
        
        let elapsed_ms = start_time.elapsed().as_millis() as u64;
        
        if batch_idx % 5 == 0 || batch_idx == total_batches - 1 {
            let throughput = if batch_elapsed > 0 {
                (batch.len() as f64 / batch_elapsed as f64 * 1000.0) as u32
            } else {
                0
            };
            log::info!("CLIP batch {}/{} completed: {}/{} files ({}%), throughput: {} files/sec, batch_time: {}ms", 
                batch_idx + 1, total_batches, processed_count, filtered_count, progress, throughput, batch_elapsed);
        }
        
        let _ = app.emit("clip-embedding-progress", serde_json::json!({
            "current": processed_count,
            "total": filtered_count,
            "progress": progress,
            "success": success_count,
            "failed": failed_count,
            "skipped": skipped_count,
            "processed": processed_count,
            "timestamp": elapsed_ms,
            "stage": "processing",
            "batch": batch_idx + 1,
            "total_batches": total_batches,
            "filtered_count": filtered_count,
        }));
    }
    
    let was_cancelled = should_cancel();
    let total_elapsed = start_time.elapsed();
    let throughput = if total_elapsed.as_secs() > 0 {
        (success_count as f64 / total_elapsed.as_secs_f64()) as u32
    } else {
        0
    };
    
    log::info!("CLIP embedding generation completed: {} success, {} failed, {} skipped, throughput: {} files/sec, total time: {:?}",
        success_count, failed_count, skipped_count, throughput, total_elapsed);
    
    let _ = app.emit("clip-embedding-completed", serde_json::json!({
        "total": total,
        "success": success_count,
        "failed": failed_count,
        "skipped": skipped_count,
        "cancelled": was_cancelled,
        "throughput": throughput,
        "elapsed_secs": total_elapsed.as_secs(),
    }));
    
    Ok(serde_json::json!({
        "total": total,
        "success": success_count,
        "failed": failed_count,
        "failed_files": failed_files,
        "cancelled": was_cancelled,
        "throughput": throughput,
        "elapsed_secs": total_elapsed.as_secs(),
    }))
}

#[tauri::command]
pub async fn clip_load_model(model_name: String, app: tauri::AppHandle) -> Result<(), String> {
    // 重置模型下载取消/暂停标志（新的下载任务从非暂停状态开始）
    crate::clip::model::MODEL_DOWNLOAD_CANCEL.store(false, std::sync::atomic::Ordering::SeqCst);
    crate::clip::model::MODEL_DOWNLOAD_PAUSE.store(false, std::sync::atomic::Ordering::SeqCst);
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let mut guard = manager.write().await;
    
    // 使用 switch_model 切换模型和嵌入数据库
    guard.switch_model(&model_name)?;
    
    // 加载模型
    guard.load_model(&app).await
}

/// 取消当前正在进行的模型下载
#[tauri::command]
pub fn clip_cancel_model_download() {
    crate::clip::model::MODEL_DOWNLOAD_CANCEL.store(true, std::sync::atomic::Ordering::SeqCst);
    // 取消时同时清除暂停标志，避免"卡死"在暂停等待中
    crate::clip::model::MODEL_DOWNLOAD_PAUSE.store(false, std::sync::atomic::Ordering::SeqCst);
    log::info!("Model download cancellation requested");
}

/// 暂停当前正在进行的模型下载（断点续传）
#[tauri::command]
pub fn clip_pause_model_download() -> Result<(), String> {
    // 如果已暂停，则忽略
    if crate::clip::model::MODEL_DOWNLOAD_PAUSE.load(std::sync::atomic::Ordering::SeqCst) {
        return Ok(());
    }
    crate::clip::model::MODEL_DOWNLOAD_PAUSE.store(true, std::sync::atomic::Ordering::SeqCst);
    log::info!("Model download pause requested");
    Ok(())
}

/// 继续已暂停的模型下载（基于 HTTP Range 断点续传）
#[tauri::command]
pub fn clip_resume_model_download() -> Result<(), String> {
    crate::clip::model::MODEL_DOWNLOAD_PAUSE.store(false, std::sync::atomic::Ordering::SeqCst);
    log::info!("Model download resume requested");
    Ok(())
}

#[tauri::command]
pub async fn clip_unload_model() -> Result<(), String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let mut guard = manager.write().await;
    guard.unload_model();
    Ok(())
}

#[tauri::command]
pub async fn clip_is_model_loaded() -> Result<bool, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let guard = manager.read().await;
    Ok(guard.is_model_loaded())
}

#[tauri::command]
pub async fn clip_get_embedding_count() -> Result<i64, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let guard = manager.read().await;
    
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    embedding_store.get_embedding_count()
}

#[tauri::command]
pub async fn clip_get_embedding_count_by_model(model_name: String) -> Result<i64, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let guard = manager.read().await;
    
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    embedding_store.get_embedding_count_by_model(&model_name)
}

#[tauri::command]
pub async fn clip_get_model_versions() -> Result<Vec<(String, i64)>, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let guard = manager.read().await;
    
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    embedding_store.get_model_versions()
}

#[tauri::command]
pub async fn clip_get_model_status(model_name: String) -> Result<serde_json::Value, String> {
    use crate::clip::models::get_model_spec;
    
    let model_spec = get_model_spec(&model_name)
        .ok_or_else(|| format!("Unknown model: {}", model_name))?;
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    let guard = manager.read().await;
    let model_cache_dir = &guard.config().model_cache_dir;
    
    let model_dir = model_cache_dir.join(&model_name);
    
    // 获取模型文件列表
    let model_files = model_spec.model_files();
    let mut files_status = serde_json::Map::new();
    let mut is_downloaded = true;
    let mut downloaded_size: u64 = 0;
    
    for model_file in &model_files {
        let file_path = model_dir.join(&model_file.name);
        // 校验文件是否存在且大小完整（防止下载一半被截断的文件被误认为完整）
        let valid = match std::fs::metadata(&file_path) {
            Ok(metadata) => {
                let size = metadata.len();
                downloaded_size += size;
                match model_file.expected_size {
                    Some(expected) => size == expected,
                    None => size > 0,
                }
            }
            Err(_) => false,
        };
        if !valid {
            is_downloaded = false;
        }
        files_status.insert(model_file.name.clone(), serde_json::json!(valid));
    }
    
    let is_gpu_active = if let Some(model) = guard.model() {
        if model.model_name() == model_spec.name() {
            model.is_using_gpu()
        } else {
            false
        }
    } else {
        false
    };

    Ok(serde_json::json!({
        "model_name": model_spec.name(),
        "display_name": model_spec.display_name(),
        "description": model_spec.description(),
        "is_downloaded": is_downloaded,
        "is_gpu_active": is_gpu_active,
        "embedding_dim": model_spec.embedding_dim(),
        "image_size": model_spec.image_size(),
        "downloaded_size": downloaded_size,
        "files": files_status
    }))
}

#[tauri::command]
pub async fn clip_delete_model(model_name: String) -> Result<(), String> {
    use crate::clip::models::get_model_spec;
    use std::fs;
    
    let model_spec = get_model_spec(&model_name)
        .ok_or_else(|| format!("Unknown model: {}", model_name))?;
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    let guard = manager.read().await;
    let model_cache_dir = &guard.config().model_cache_dir;
    
    let model_dir = model_cache_dir.join(&model_name);
    
    // 删除所有模型文件
    let model_files = model_spec.model_files();
    for model_file in model_files {
        let file_path = model_dir.join(&model_file.name);
        if file_path.exists() {
            fs::remove_file(&file_path).map_err(|e| format!("Failed to delete {}: {}", model_file.name, e))?;
        }
    }
    
    // 尝试删除模型目录（如果为空）
    if model_dir.exists() {
        let _ = fs::remove_dir(&model_dir);
    }
    
    log::info!("Deleted CLIP model files for: {}", model_name);
    Ok(())
}

#[tauri::command]
pub async fn clip_open_model_folder() -> Result<(), String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    let guard = manager.read().await;
    let model_cache_dir = &guard.config().model_cache_dir;
    
    if !model_cache_dir.exists() {
        std::fs::create_dir_all(model_cache_dir)
            .map_err(|e| format!("Failed to create model cache directory: {}", e))?;
    }
    
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(model_cache_dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(model_cache_dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(model_cache_dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    
    Ok(())
}

#[tauri::command]
pub async fn get_all_image_files(app: tauri::AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let pool = app.state::<db::AppDbPool>().inner().clone();
    
    let files = tokio::task::spawn_blocking(move || {
        let conn = pool.get_connection();
        db::file_index::get_all_image_files(&conn)
            .map_err(|e| format!("Database error: {}", e))
    })
    .await
    .map_err(|e| format!("Task error: {}", e))??;
    
    let result: Vec<serde_json::Value> = files.into_iter()
        .map(|entry| {
            serde_json::json!({
                "id": entry.file_id,
                "path": entry.path,
                "name": entry.name,
                "format": entry.format,
            })
        })
        .collect();
    
    Ok(result)
}

#[tauri::command]
pub async fn clip_get_embedding_stats() -> Result<serde_json::Value, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let guard = manager.read().await;
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    let total_count = embedding_store.get_embedding_count()?;
    let root_path = guard.config().root_path.to_string_lossy().to_string();
    let model_name = guard.get_model_name();
    
    Ok(serde_json::json!({
        "total_count": total_count,
        "model_name": model_name,
        "root_path": root_path,
    }))
}

/// 将识别到的标签保存到文件元数据数据库中
fn save_tags_to_metadata(
    file_id: &str,
    file_path: &str,
    tags: &[(String, f32)],
    threshold: f32,
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let pool = app.state::<AppDbPool>();
    let pool_inner = pool.inner().clone();
    
    let file_id = file_id.to_string();
    let file_path = db::normalize_path(file_path);
    // 只保留超过阈值的标签名称
    let tag_names: Vec<String> = tags
        .iter()
        .filter(|(_, prob)| *prob >= threshold)
        .map(|(name, _prob)| name.clone())
        .collect();
    
    // 同步执行数据库操作，确保在返回前完成
    let conn = pool_inner.get_connection();
    
    // 获取现有元数据，保留其他字段
    let mut metadata = match get_metadata_by_id(&conn, &file_id) {
        Ok(Some(m)) => m,
        _ => FileMetadata {
            file_id: file_id.clone(),
            path: file_path,
            tags: None,
            description: None,
            source_url: None,
            ai_data: None,
            category: None,
            updated_at: Some(chrono::Utc::now().timestamp()),
        },
    };

    // 更新标签 - 转换为 JSON 数组
    metadata.tags = Some(serde_json::to_value(tag_names).unwrap_or_default());
    metadata.updated_at = Some(chrono::Utc::now().timestamp());

    upsert_file_metadata(&conn, &metadata).map_err(|e| e.to_string())?;

    Ok(())
}

/// 将图片关联到人物（更新 ai_data.faces）
fn link_files_to_persons(
    file_tags_map: &std::collections::HashMap<String, std::collections::HashSet<String>>,
    tag_to_person_id: &std::collections::HashMap<String, String>,
    person_names: &std::collections::HashMap<String, String>,
    conn: &rusqlite::Connection,
) -> Result<(), String> {
    use std::collections::HashSet;
    
    let mut updated_count = 0;
    let mut not_found_count = 0;
    
    log::info!("[link_files_to_persons] 开始处理 {} 个文件", file_tags_map.len());
    
    for (file_id, new_tags) in file_tags_map {
        let mut metadata = match get_metadata_by_id(&conn, file_id) {
            Ok(Some(m)) => m,
            Ok(None) => {
                let file_path = match db::file_index::get_path_by_id(&conn, file_id) {
                    Ok(Some(path)) => path,
                    Ok(None) => {
                        log::warn!("[link_files_to_persons] 文件 {} 在 file_index 中不存在，跳过", file_id);
                        not_found_count += 1;
                        continue;
                    }
                    Err(e) => {
                        log::error!("[link_files_to_persons] 获取文件 {} 路径失败: {}", file_id, e);
                        not_found_count += 1;
                        continue;
                    }
                };
                
                FileMetadata {
                    file_id: file_id.clone(),
                    path: db::normalize_path(&file_path),
                    tags: None,
                    description: None,
                    source_url: None,
                    ai_data: None,
                    category: None,
                    updated_at: Some(chrono::Utc::now().timestamp()),
                }
            }
            Err(e) => {
                log::error!("[link_files_to_persons] 获取文件 {} 元数据失败: {}", file_id, e);
                not_found_count += 1;
                continue;
            }
        };
        
        let mut ai_data: serde_json::Value = metadata.ai_data.clone().unwrap_or_else(|| {
            serde_json::json!({
                "analyzed": false,
                "analyzedAt": chrono::Utc::now().to_rfc3339(),
                "description": "",
                "tags": [],
                "faces": [],
                "sceneCategory": "",
                "confidence": 1.0,
                "dominantColors": [],
                "objects": []
            })
        });
        
        let faces = ai_data.get("faces").and_then(|f| f.as_array()).cloned().unwrap_or_default();
        let mut new_faces = faces.clone();
        let existing_person_ids: HashSet<String> = new_faces
            .iter()
            .filter_map(|f| f.get("personId").and_then(|p| p.as_str().map(|s| s.to_string())))
            .collect();
        
        let mut ai_data_changed = false;
        
        for tag_name in new_tags {
            if let Some(person_id) = tag_to_person_id.get(tag_name) {
                if !existing_person_ids.contains(person_id) {
                    let person_name = person_names.get(person_id).cloned().unwrap_or_default();
                    let new_face = serde_json::json!({
                        "id": db::generate_id(&format!("face_{}", file_id)),
                        "personId": person_id,
                        "name": person_name,
                        "confidence": 1.0,
                        "box": { "x": 0, "y": 0, "w": 0, "h": 0 }
                    });
                    new_faces.push(new_face);
                    ai_data_changed = true;
                    log::info!("[link_files_to_persons] 为文件 {} 添加人物关联: {} ({})", file_id, person_name, person_id);
                }
            }
        }
        
        if ai_data_changed {
            if let Some(obj) = ai_data.as_object_mut() {
                obj.insert("faces".to_string(), serde_json::Value::Array(new_faces));
            }
            metadata.ai_data = Some(ai_data);
            metadata.updated_at = Some(chrono::Utc::now().timestamp());
            
            upsert_file_metadata(&conn, &metadata)
                .map_err(|e| format!("Failed to update metadata: {}", e))?;
            updated_count += 1;
        }
    }
    
    log::info!("[link_files_to_persons] 完成: 更新 {} 个文件, 未找到 {} 个文件", updated_count, not_found_count);
    
    Ok(())
}

/// 标签条目，包含标签名和类别
struct TagEntry {
    name: String,
    category: i32,
}

/// 标签映射器，用于将嵌入向量（标签概率）转换为标签
struct TagMapper {
    tags: Vec<TagEntry>,
}

impl TagMapper {
    fn load_embedded() -> Result<Self, String> {
        let mut rdr = csv::Reader::from_reader(TAGS_EN_CSV.as_bytes());
        
        let mut tags = Vec::new();
        for result in rdr.records() {
            let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
            if record.len() >= 3 {
                let tag_name = record[1].replace('_', " ").trim().to_string();
                let category: i32 = record[2].parse().unwrap_or(-1);
                tags.push(TagEntry { name: tag_name, category });
            }
        }
        
        log::info!("Loaded {} tags from embedded file", tags.len());
        Ok(Self { tags })
    }
    
    fn load(tags_path: &std::path::Path) -> Result<Self, String> {
        let file = std::fs::File::open(tags_path)
            .map_err(|e| format!("Failed to open tags file: {}", e))?;
        let mut rdr = csv::Reader::from_reader(file);
        
        let mut tags = Vec::new();
        for result in rdr.records() {
            let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
            if record.len() >= 3 {
                let tag_name = record[1].replace('_', " ").trim().to_string();
                let category: i32 = record[2].parse().unwrap_or(-1);
                tags.push(TagEntry { name: tag_name, category });
            }
        }
        
        log::info!("Loaded {} tags for tag generation", tags.len());
        Ok(Self { tags })
    }
    
    fn probs_to_tags(&self, probs: &[f32], threshold: f32) -> Vec<(String, f32)> {
        let mut results = Vec::new();
        for (i, &prob) in probs.iter().enumerate() {
            if prob >= threshold {
                if let Some(entry) = self.tags.get(i) {
                    results.push((entry.name.clone(), prob));
                }
            }
        }
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results
    }
    
    fn probs_to_general_tags(&self, probs: &[f32], threshold: f32) -> Vec<(String, f32)> {
        let mut results = Vec::new();
        for (i, &prob) in probs.iter().enumerate() {
            if prob >= threshold {
                if let Some(entry) = self.tags.get(i) {
                    if entry.category == 0 {
                        results.push((entry.name.clone(), prob));
                    }
                }
            }
        }
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results
    }
}

#[tauri::command]
pub async fn clip_generate_tags_from_embeddings(
    app: tauri::AppHandle,
    model_name: Option<String>,
    threshold: f32,
    language: Option<String>,
) -> Result<serde_json::Value, String> {
    let requested_model = model_name.unwrap_or_else(|| "WD-EVA02-Large-Tagger-V3".to_string());
    let lang = language.unwrap_or_else(|| "en".to_string());
    
    if requested_model != "WD-EVA02-Large-Tagger-V3" {
        return Err("标签生成仅支持 WD-EVA02-Large-Tagger-V3 模型".to_string());
    }
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    // 获取嵌入存储
    let (embeddings, _root_path, _model_cache_dir) = {
        let mut guard = manager.write().await;
        
        // 切换到 WD14 模型
        guard.switch_model(&requested_model)?;
        
        let embedding_store = guard.embedding_store()
            .ok_or("Embedding store not available")?;
        
        // 获取所有嵌入向量
        let embeddings = embedding_store.get_all_embeddings()?;
        let root_path = guard.config().root_path.clone();
        let model_cache_dir = guard.config().model_cache_dir.clone();
        
        (embeddings, root_path, model_cache_dir)
    };
    
    if embeddings.is_empty() {
        return Ok(serde_json::json!({
            "total": 0,
            "success": 0,
            "skipped": 0,
            "message": "没有找到嵌入向量，请先生成嵌入向量"
        }));
    }

    let mapper = TagMapper::load_embedded()?;
    
    log::info!("开始从 {} 个嵌入向量生成标签，阈值: {}", embeddings.len(), threshold);
    
    let mut success_count = 0;
    let mut skipped_count = 0;
    let total = embeddings.len();
    
    for (idx, embedding) in embeddings.iter().enumerate() {
        // 发送进度事件
        if idx % 50 == 0 || idx == total - 1 {
            let _ = app.emit("clip-tag-generation-progress", serde_json::json!({
                "current": idx + 1,
                "total": total,
                "progress": ((idx + 1) as f64 / total as f64 * 100.0) as u32,
            }));
        }
        
        // 获取文件路径
        let file_path = {
            let pool = app.state::<AppDbPool>();
            let conn = pool.get_connection();
            match db::file_index::get_path_by_id(&conn, &embedding.file_id) {
                Ok(Some(path)) => path,
                _ => {
                    skipped_count += 1;
                    continue;
                }
            }
        };
        
        // 将嵌入向量转换为标签（只生成 General 标签）
        let tags = mapper.probs_to_general_tags(&embedding.embedding, threshold);
        
        if tags.is_empty() {
            skipped_count += 1;
            continue;
        }
        
        // 翻译标签
        let translator = crate::clip::model::get_tag_translator();
        let translated_tags = translator.translate_tags(&tags, &lang);
        
        // 保存标签
        if let Err(e) = save_tags_to_metadata(&embedding.file_id, &file_path, &translated_tags, threshold, &app) {
            log::error!("Failed to save tags for {}: {}", embedding.file_id, e);
            skipped_count += 1;
        } else {
            success_count += 1;
        }
    }
    
    // 发送完成事件
    let _ = app.emit("clip-tag-generation-completed", serde_json::json!({
        "total": total,
        "success": success_count,
        "skipped": skipped_count,
    }));
    
    log::info!("标签生成完成: 总数={}, 成功={}, 跳过={}", total, success_count, skipped_count);
    
    Ok(serde_json::json!({
        "total": total,
        "success": success_count,
        "skipped": skipped_count,
    }))
}

// ==================== 标签预览相关命令 ====================

#[derive(Serialize, Clone)]
pub struct PreviewTag {
    pub name: String,
    pub name_cn: String,
    pub count: usize,
    pub sample_file_ids: Vec<String>,
}

#[derive(Serialize)]
pub struct TagsPreviewResult {
    pub tags: Vec<PreviewTag>,
    pub total_files: usize,
    pub files_with_tags: usize,
}

#[tauri::command]
pub async fn clip_preview_tags_from_embeddings(
    _app: tauri::AppHandle,
    model_name: Option<String>,
    threshold: f32,
    language: Option<String>,
) -> Result<TagsPreviewResult, String> {
    let requested_model = model_name.unwrap_or_else(|| "WD-EVA02-Large-Tagger-V3".to_string());
    let lang = language.unwrap_or_else(|| "en".to_string());
    
    if requested_model != "WD-EVA02-Large-Tagger-V3" {
        return Err("标签预览仅支持 WD-EVA02-Large-Tagger-V3 模型".to_string());
    }
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let (embeddings, _model_cache_dir) = {
        let mut guard = manager.write().await;
        guard.switch_model(&requested_model)?;
        
        let embedding_store = guard.embedding_store()
            .ok_or("Embedding store not available")?;
        
        let embeddings = embedding_store.get_all_embeddings()?;
        let model_cache_dir = guard.config().model_cache_dir.clone();
        
        (embeddings, model_cache_dir)
    };
    
    if embeddings.is_empty() {
        return Ok(TagsPreviewResult {
            tags: Vec::new(),
            total_files: 0,
            files_with_tags: 0,
        });
    }

    let mapper = TagMapper::load_embedded()?;
    let translator = crate::clip::model::get_tag_translator();
    
    log::info!("开始预览标签，阈值: {}, 嵌入数量: {}", threshold, embeddings.len());
    
    let mut tag_files: std::collections::HashMap<String, Vec<(String, f32)>> = std::collections::HashMap::new();
    let mut files_with_tags = 0;
    
    for embedding in &embeddings {
        let tags = mapper.probs_to_general_tags(&embedding.embedding, threshold);
        if !tags.is_empty() {
            files_with_tags += 1;
            for (tag, score) in tags {
                tag_files.entry(tag)
                    .or_insert_with(Vec::new)
                    .push((embedding.file_id.clone(), score));
            }
        }
    }
    
    let mut preview_tags: Vec<PreviewTag> = tag_files
        .into_iter()
        .map(|(tag, files)| {
            let mut sorted_files = files;
            sorted_files.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            
            let sample_file_ids: Vec<String> = sorted_files
                .iter()
                .take(3)
                .map(|(id, _)| id.clone())
                .collect();
            
            let name_cn = translator.translate(&tag, &lang);
            
            PreviewTag {
                name: tag,
                name_cn,
                count: sorted_files.len(),
                sample_file_ids,
            }
        })
        .collect();
    
    preview_tags.sort_by(|a, b| b.count.cmp(&a.count));
    
    log::info!("标签预览完成: {} 个标签, {} 个文件有标签", preview_tags.len(), files_with_tags);
    
    Ok(TagsPreviewResult {
        tags: preview_tags,
        total_files: embeddings.len(),
        files_with_tags,
    })
}

// ==================== 角色标签相关命令 ====================

use serde::Serialize;

#[derive(Serialize, Clone)]
pub struct CharacterTag {
    pub tag_id: String,
    pub name: String,
    pub name_cn: String,
    pub index: usize,
}

#[derive(Serialize, Clone)]
pub struct DetectedCharacter {
    pub tag_name: String,
    pub tag_name_cn: String,
    pub tag_index: usize,
    pub file_count: usize,
    pub max_score: f32,
    pub sample_file_id: String,
}

#[tauri::command]
pub async fn clip_get_character_tags(
    model_name: Option<String>,
    language: Option<String>,
) -> Result<Vec<CharacterTag>, String> {
    let _ = &language;
    let requested_model = model_name.unwrap_or_else(|| "WD-EVA02-Large-Tagger-V3".to_string());
    
    if requested_model != "WD-EVA02-Large-Tagger-V3" {
        return Err("角色标签仅支持 WD-EVA02-Large-Tagger-V3 模型".to_string());
    }
    
    let mut rdr = csv::Reader::from_reader(TAGS_EN_CSV.as_bytes());
    
    let mut character_tags = Vec::new();
    let mut index = 0;
    
    for result in rdr.records() {
        let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
        if record.len() >= 3 {
            let category: i32 = record[2].parse().unwrap_or(-1);
            if category == 4 {
                let tag_id = record[0].to_string();
                let name = record[1].replace('_', " ").trim().to_string();
                
                character_tags.push(CharacterTag {
                    tag_id,
                    name: name.clone(),
                    name_cn: name,
                    index,
                });
            }
        }
        index += 1;
    }
    
    log::info!("Loaded {} character tags (category=4)", character_tags.len());
    Ok(character_tags)
}

#[tauri::command]
pub async fn clip_search_by_character_tag(
    tag_index: usize,
    min_score: f32,
    max_results: Option<usize>,
    model_name: Option<String>,
) -> Result<Vec<SearchResult>, String> {
    let requested_model = model_name.unwrap_or_else(|| "WD-EVA02-Large-Tagger-V3".to_string());
    
    if requested_model != "WD-EVA02-Large-Tagger-V3" {
        return Err("角色标签搜索仅支持 WD-EVA02-Large-Tagger-V3 模型".to_string());
    }
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let mut guard = manager.write().await;
    guard.switch_model(&requested_model)?;
    
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    let embeddings = embedding_store.get_all_embeddings()?;
    
    let mut results: Vec<SearchResult> = embeddings
        .into_iter()
        .filter_map(|emb| {
            if tag_index < emb.embedding.len() {
                let score = emb.embedding[tag_index];
                if score >= min_score {
                    return Some(SearchResult {
                        file_id: emb.file_id,
                        score,
                        rank: 0,
                    });
                }
            }
            None
        })
        .collect();
    
    results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    
    if let Some(max) = max_results {
        results.truncate(max);
    }
    
    for (i, result) in results.iter_mut().enumerate() {
        result.rank = i + 1;
    }
    
    log::info!("Found {} files matching character tag at index {} (min_score={})", 
        results.len(), tag_index, min_score);
    
    Ok(results)
}

#[tauri::command]
pub async fn clip_get_detected_characters(
    min_score: f32,
    min_count: usize,
    model_name: Option<String>,
    language: Option<String>,
    _app: tauri::AppHandle,
) -> Result<Vec<DetectedCharacter>, String> {
    let requested_model = model_name.unwrap_or_else(|| "WD-EVA02-Large-Tagger-V3".to_string());
    let lang = language.unwrap_or_else(|| "en".to_string());
    
    if requested_model != "WD-EVA02-Large-Tagger-V3" {
        return Err("角色检测仅支持 WD-EVA02-Large-Tagger-V3 模型".to_string());
    }
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let (embeddings, _) = {
        let mut guard = manager.write().await;
        guard.switch_model(&requested_model)?;
        
        let embedding_store = guard.embedding_store()
            .ok_or("Embedding store not available")?;
        
        let embeddings = embedding_store.get_all_embeddings()?;
        
        (embeddings, ())
    };
    
    let mut rdr = csv::Reader::from_reader(TAGS_EN_CSV.as_bytes());
    
    let mut character_indices: Vec<(usize, String)> = Vec::new();
    let mut index = 0;
    
    for result in rdr.records() {
        let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
        if record.len() >= 3 {
            let category: i32 = record[2].parse().unwrap_or(-1);
            if category == 4 {
                let name = record[1].replace('_', " ").trim().to_string();
                character_indices.push((index, name));
            }
        }
        index += 1;
    }
    
    let cn_tags_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("clip")
        .join("Tags-cn_2024_ver-1.0.csv");
    
    let mut cn_translations: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if lang == "zh" && cn_tags_path.exists() {
        let cn_file = std::fs::File::open(&cn_tags_path)
            .map_err(|e| format!("Failed to open cn tags file: {}", e))?;
        let mut cn_rdr = csv::Reader::from_reader(cn_file);
        
        for result in cn_rdr.records() {
            let record = result.map_err(|e| format!("Failed to read cn tag record: {}", e))?;
            if record.len() >= 5 {
                let category: i32 = record[2].parse().unwrap_or(-1);
                if category == 4 {
                    let name = record[1].replace('_', " ").trim().to_string();
                    let cn_name = record[4].trim().to_string();
                    cn_translations.insert(name, cn_name);
                }
            }
        }
        log::info!("Loaded {} Chinese translations for character tags", cn_translations.len());
    }
    
    log::info!("Loaded {} character tags, embedding count: {}, first embedding dim: {}", 
        character_indices.len(), 
        embeddings.len(),
        embeddings.first().map(|e| e.embedding.len()).unwrap_or(0)
    );
    
    if !character_indices.is_empty() {
        log::info!("First 5 character indices: {:?}", &character_indices[..5.min(character_indices.len())]);
    }
    
    if !embeddings.is_empty() {
        let first_emb = &embeddings[0];
        for &(tag_index, ref name) in character_indices.iter().take(5) {
            if tag_index < first_emb.embedding.len() {
                log::info!("First embedding[{}] ({}) = {}", tag_index, name, first_emb.embedding[tag_index]);
            }
        }
        
        let max_vals: Vec<f32> = first_emb.embedding.iter().cloned().take(10).collect();
        log::info!("First 10 embedding values: {:?}", max_vals);
        
        let max_val = first_emb.embedding.iter().cloned().fold(0.0_f32, f32::max);
        log::info!("Max embedding value in first embedding: {}", max_val);
        
        let mut max_idx = 0;
        let mut max_v: f32 = 0.0;
        for (i, &v) in first_emb.embedding.iter().enumerate() {
            if v > max_v {
                max_v = v;
                max_idx = i;
            }
        }
        log::info!("Max value {} at index {} in first embedding", max_v, max_idx);
    }
    
    let effective_min_score = min_score;
    
    let mut character_stats: std::collections::HashMap<usize, (usize, f32, String)> = 
        std::collections::HashMap::new();
    
    for emb in &embeddings {
        for &(tag_index, _) in &character_indices {
            if tag_index < emb.embedding.len() {
                let score = emb.embedding[tag_index];
                if score >= effective_min_score {
                    let entry = character_stats.entry(tag_index).or_insert((0, 0.0, String::new()));
                    entry.0 += 1;
                    if score > entry.1 {
                        entry.1 = score;
                        entry.2 = emb.file_id.clone();
                    }
                }
            }
        }
    }
    
    let mut detected: Vec<DetectedCharacter> = character_indices
        .into_iter()
        .filter_map(|(tag_index, name)| {
            if let Some((count, max_score, sample_file_id)) = character_stats.remove(&tag_index) {
                if count >= min_count {
                    let cn_name = cn_translations.get(&name).cloned().unwrap_or_else(|| name.clone());
                    return Some(DetectedCharacter {
                        tag_name: name.clone(),
                        tag_name_cn: cn_name,
                        tag_index,
                        file_count: count,
                        max_score,
                        sample_file_id,
                    });
                }
            }
            None
        })
        .collect();
    
    detected.sort_by(|a, b| b.file_count.cmp(&a.file_count));
    
    log::info!("Detected {} characters with min_count={}", detected.len(), min_count);
    
    Ok(detected)
}

#[tauri::command]
pub async fn clip_get_work_topics(
    min_score: f32,
    min_count: usize,
    model_name: Option<String>,
    language: Option<String>,
    app: tauri::AppHandle,
) -> Result<Vec<crate::work_extractor::WorkTopicInfo>, String> {
    use crate::work_extractor::{extract_work_name, WorkTopicInfo, WorkCharacter};
    use std::collections::HashMap;
    
    let requested_model = model_name.unwrap_or_else(|| "WD-EVA02-Large-Tagger-V3".to_string());
    let _lang = language.unwrap_or_else(|| "en".to_string());
    
    if requested_model != "WD-EVA02-Large-Tagger-V3" {
        return Err("作品专题仅支持 WD-EVA02-Large-Tagger-V3 模型".to_string());
    }
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let (embeddings, _) = {
        let mut guard = manager.write().await;
        guard.switch_model(&requested_model)?;
        
        let embedding_store = guard.embedding_store()
            .ok_or("Embedding store not available")?;
        
        let embeddings = embedding_store.get_all_embeddings()?;
        
        (embeddings, ())
    };
    
    let mut rdr = csv::Reader::from_reader(TAGS_EN_CSV.as_bytes());
    
    let mut character_tags: Vec<(usize, String)> = Vec::new();
    let mut index = 0;
    
    for result in rdr.records() {
        let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
        if record.len() >= 3 {
            let category: i32 = record[2].parse().unwrap_or(-1);
            if category == 4 {
                let name = record[1].to_string();
                character_tags.push((index, name));
            }
        }
        index += 1;
    }
    
    let cn_tags_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("clip")
        .join("Tags-cn_2024_ver-1.0.csv");
    
    let mut cn_translations: HashMap<String, String> = HashMap::new();
    if cn_tags_path.exists() {
        let cn_file = std::fs::File::open(&cn_tags_path)
            .map_err(|e| format!("Failed to open cn tags file: {}", e))?;
        let mut cn_rdr = csv::Reader::from_reader(cn_file);
        
        for result in cn_rdr.records() {
            let record = result.map_err(|e| format!("Failed to read cn tag record: {}", e))?;
            if record.len() >= 5 {
                let category: i32 = record[2].parse().unwrap_or(-1);
                if category == 4 {
                    let name = record[1].to_string();
                    let cn_name = record[4].trim().to_string();
                    cn_translations.insert(name, cn_name);
                }
            }
        }
    }
    
    let mut character_stats: HashMap<usize, (usize, f32, String)> = HashMap::new();
    
    for emb in &embeddings {
        for &(tag_index, _) in &character_tags {
            if tag_index < emb.embedding.len() {
                let score = emb.embedding[tag_index];
                if score >= min_score {
                    let entry = character_stats.entry(tag_index).or_insert((0, 0.0, String::new()));
                    entry.0 += 1;
                    if score > entry.1 {
                        entry.1 = score;
                        entry.2 = emb.file_id.clone();
                    }
                }
            }
        }
    }
    
    let detected: Vec<(usize, String, Option<String>, usize, String)> = character_tags
        .iter()
        .filter_map(|(tag_index, name)| {
            if let Some((count, _max_score, sample_file_id)) = character_stats.remove(tag_index) {
                if count >= min_count {
                    let cn_name = cn_translations.get(name).cloned();
                    return Some((*tag_index, name.clone(), cn_name, count, sample_file_id));
                }
            }
            None
        })
        .collect();
    
    use std::collections::HashSet;
    
    // 预先建立 tag_index 到 work_name 的映射，用于高效收集 file_ids
    let mut tag_to_work: HashMap<usize, String> = HashMap::new();
    let mut work_file_ids: HashMap<String, HashSet<String>> = HashMap::new();
    for (tag_idx, tag_name, tag_name_cn, _, _) in &detected {
        if let Some(extraction) = extract_work_name(tag_name, tag_name_cn.as_deref()) {
            tag_to_work.insert(*tag_idx, extraction.work_name);
        }
    }

    // 单次遍历 embeddings 收集所有作品的 file_ids
    for emb in &embeddings {
        for (tag_idx, work_name) in &tag_to_work {
            if *tag_idx < emb.embedding.len() && emb.embedding[*tag_idx] >= min_score {
                work_file_ids.entry(work_name.clone()).or_default().insert(emb.file_id.clone());
            }
        }
    }
    
    let mut work_characters: HashMap<String, Vec<WorkCharacter>> = HashMap::new();
    let mut work_names_cn: HashMap<String, String> = HashMap::new();
    
    let app_db_pool = app.state::<db::AppDbPool>();
    let conn = app_db_pool.get_connection();
    let existing_people = db::persons::get_all_people(&conn)
        .map_err(|e| format!("Failed to get persons: {}", e))?;
    
    let person_by_tag: HashMap<String, String> = existing_people
        .iter()
        .filter_map(|p| {
            p.character_tag_name.as_ref().map(|tag_name: &String| {
                (tag_name.clone(), p.id.clone())
            })
        })
        .collect();
    
    for (_tag_index, tag_name, tag_name_cn, image_count, cover_file_id) in detected {
        if let Some(extraction) = extract_work_name(&tag_name, tag_name_cn.as_deref()) {
            let work_name = extraction.work_name.clone();
            
            let person_id = person_by_tag.get(&tag_name).cloned();
            
            let character = WorkCharacter {
                tag_name: tag_name.clone(),
                tag_name_cn: tag_name_cn.clone(),
                person_id,
                image_count,
                cover_file_id: Some(cover_file_id.clone()),
            };
            
            work_characters.entry(work_name.clone()).or_default().push(character);
            
            if let Some(cn) = extraction.work_name_cn {
                work_names_cn.entry(work_name).or_insert(cn);
            }
        }
    }
    
    let existing_topics = db::topics::get_all_topics(&conn)
        .map_err(|e| format!("Failed to get topics: {}", e))?;
    
    let existing_topic_by_work: HashMap<String, String> = existing_topics
        .iter()
        .filter_map(|t| {
            t.work_name.as_ref().map(|wn| (wn.clone(), t.id.clone()))
        })
        .collect();
    
    let mut work_topics: Vec<WorkTopicInfo> = work_characters
        .into_iter()
        .map(|(work_name, characters)| {
            let character_count = characters.len();
            let image_count: usize = characters.iter().map(|c| c.image_count).sum();
            let work_name_cn = work_names_cn.get(&work_name).cloned();
            let existing_topic_id = existing_topic_by_work.get(&work_name).cloned();
            let cover_file_id = characters.first().and_then(|c| c.cover_file_id.clone());
            let sample_file_ids = characters.iter()
                .filter_map(|c| c.cover_file_id.clone())
                .take(4)
                .collect();
            let file_ids = work_file_ids.get(&work_name).cloned().unwrap_or_default().into_iter().collect();
            
            WorkTopicInfo {
                work_name,
                work_name_cn,
                character_count,
                image_count,
                characters,
                existing_topic_id,
                cover_file_id,
                sample_file_ids,
                file_ids,
            }
        })
        .collect();
    
    work_topics.sort_by(|a, b| b.image_count.cmp(&a.image_count));
    
    log::info!("Found {} work topics", work_topics.len());
    
    Ok(work_topics)
}

#[tauri::command]
pub async fn clip_create_work_topics(
    works_to_create: Vec<crate::work_extractor::WorkToCreate>,
    app: tauri::AppHandle,
) -> Result<crate::work_extractor::CreateWorkTopicsResult, String> {
    use crate::work_extractor::{extract_work_name, get_work_display_name, CreateWorkTopicsResult};
    use std::collections::{HashMap, HashSet};
    
    let work_names: Vec<String> = works_to_create.iter().map(|w| w.name.clone()).collect();
    let work_types: HashMap<String, Option<String>> = works_to_create.iter().map(|w| (w.name.clone(), w.topic_type.clone())).collect();
    let work_cover_ids: HashMap<String, Option<String>> = works_to_create.iter().map(|w| (w.name.clone(), w.cover_file_id.clone())).collect();
    
    log::info!("[clip_create_work_topics] 开始创建专题, work_names: {:?}", work_names);
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let (embeddings, _) = {
        let mut guard = manager.write().await;
        guard.switch_model("WD-EVA02-Large-Tagger-V3")?;
        
        let embedding_store = guard.embedding_store()
            .ok_or("Embedding store not available")?;
        
        let embeddings = embedding_store.get_all_embeddings()?;
        
        (embeddings, ())
    };
    
    log::info!("[clip_create_work_topics] 加载了 {} 个 embeddings", embeddings.len());
    
    let mut rdr = csv::Reader::from_reader(TAGS_EN_CSV.as_bytes());
    
    let mut character_tags: Vec<(usize, String)> = Vec::new();
    let mut index = 0;
    
    for result in rdr.records() {
        let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
        if record.len() >= 3 {
            let category: i32 = record[2].parse().unwrap_or(-1);
            if category == 4 {
                let name = record[1].to_string();
                character_tags.push((index, name));
            }
        }
        index += 1;
    }
    
    log::info!("[clip_create_work_topics] 加载了 {} 个角色标签", character_tags.len());
    
    let cn_tags_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("src")
        .join("clip")
        .join("Tags-cn_2024_ver-1.0.csv");
    
    let mut cn_translations: HashMap<String, String> = HashMap::new();
    if cn_tags_path.exists() {
        let cn_file = std::fs::File::open(&cn_tags_path)
            .map_err(|e| format!("Failed to open cn tags file: {}", e))?;
        let mut cn_rdr = csv::Reader::from_reader(cn_file);
        
        for result in cn_rdr.records() {
            let record = result.map_err(|e| format!("Failed to read cn tag record: {}", e))?;
            if record.len() >= 5 {
                let category: i32 = record[2].parse().unwrap_or(-1);
                if category == 4 {
                    let name = record[1].to_string();
                    let cn_name = record[4].trim().to_string();
                    cn_translations.insert(name, cn_name);
                }
            }
        }
    }
    
    log::info!("[clip_create_work_topics] 加载了 {} 个中文翻译", cn_translations.len());
    
    let mut tag_to_work: HashMap<String, String> = HashMap::new();
    for (_, tag_name) in &character_tags {
        if let Some(extraction) = extract_work_name(tag_name, cn_translations.get(tag_name).map(|s| s.as_str())) {
            let work_name = extraction.work_name;
            if work_names.contains(&work_name) {
                tag_to_work.insert(tag_name.clone(), work_name);
            }
        }
    }
    
    log::info!("[clip_create_work_topics] tag_to_work 映射数量: {}", tag_to_work.len());
    for (tag, work) in tag_to_work.iter().take(10) {
        log::info!("[clip_create_work_topics]   标签 '{}' -> 作品 '{}'", tag, work);
    }
    
    let mut files_by_work: HashMap<String, Vec<String>> = HashMap::new();
    let min_score = 0.1f32;
    
    log::info!("[clip_create_work_topics] 开始遍历 embeddings, min_score = {}", min_score);
    
    if let Some(first_emb) = embeddings.first() {
        log::info!("[clip_create_work_topics] 第一个 embedding 维度: {}", first_emb.embedding.len());
        
        let max_val = first_emb.embedding.iter().cloned().fold(0.0f32, f32::max);
        let min_val = first_emb.embedding.iter().cloned().fold(1.0f32, f32::min);
        log::info!("[clip_create_work_topics] 第一个 embedding 最大值: {}, 最小值: {}", max_val, min_val);
        
        let mut high_vals: Vec<(usize, f32)> = first_emb.embedding.iter().enumerate()
            .map(|(i, &v)| (i, v))
            .filter(|(_, v)| *v > 0.1)
            .collect();
        high_vals.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        log::info!("[clip_create_work_topics] 第一个 embedding 前10个高分值: {:?}", high_vals.iter().take(10).collect::<Vec<_>>());
    }
    
    if let Some(first_char_tag) = character_tags.first() {
        log::info!("[clip_create_work_topics] 第一个角色标签索引: {}, 名称: {}", first_char_tag.0, first_char_tag.1);
    }
    if let Some(last_char_tag) = character_tags.last() {
        log::info!("[clip_create_work_topics] 最后一个角色标签索引: {}, 名称: {}", last_char_tag.0, last_char_tag.1);
    }
    
    let mut total_matches = 0usize;
    let mut sample_logged = false;
    let mut high_score_count = 0usize;
    let mut file_character_tags: HashMap<String, HashSet<String>> = HashMap::new();
    
    for emb in &embeddings {
        let mut file_works: std::collections::HashSet<String> = std::collections::HashSet::new();
        
        for &(tag_index, ref tag_name) in &character_tags {
            if tag_index < emb.embedding.len() {
                let score = emb.embedding[tag_index];
                if score >= min_score {
                    high_score_count += 1;
                    if let Some(work_name) = tag_to_work.get(tag_name) {
                        file_works.insert(work_name.clone());
                        total_matches += 1;
                        
                        file_character_tags
                            .entry(emb.file_id.clone())
                            .or_default()
                            .insert(tag_name.clone());
                        
                        if !sample_logged && work_names.contains(work_name) {
                            log::info!("[clip_create_work_topics] 样例匹配: file_id={}, tag={}, score={}, work={}", 
                                emb.file_id, tag_name, score, work_name);
                            sample_logged = true;
                        }
                    }
                }
            }
        }
        
        for work_name in file_works {
            files_by_work.entry(work_name).or_default().push(emb.file_id.clone());
        }
    }
    
    log::info!("[clip_create_work_topics] 高分标签数 (score >= {}): {}", min_score, high_score_count);
    log::info!("[clip_create_work_topics] 总匹配次数: {}", total_matches);
    log::info!("[clip_create_work_topics] files_by_work 结果 (共 {} 个作品):", files_by_work.len());
    for (work, files) in files_by_work.iter() {
        log::info!("[clip_create_work_topics]   作品 '{}' 有 {} 个图片", work, files.len());
    }
    
    let mut characters_by_work: HashMap<String, Vec<(String, Option<String>, String)>> = HashMap::new();
    
    for emb in &embeddings {
        for &(tag_index, ref tag_name) in &character_tags {
            if tag_index < emb.embedding.len() {
                let score = emb.embedding[tag_index];
                if score >= min_score {
                    if let Some(work_name) = tag_to_work.get(tag_name) {
                        let cn_name = cn_translations.get(tag_name).cloned();
                        characters_by_work
                            .entry(work_name.clone())
                            .or_default()
                            .push((tag_name.clone(), cn_name, emb.file_id.clone()));
                    }
                }
            }
        }
    }
    
    let mut character_stats_by_work: HashMap<String, HashMap<String, (Option<String>, usize, Option<String>)>> = HashMap::new();
    for (work_name, chars) in characters_by_work {
        let mut stats: HashMap<String, (Option<String>, usize, Option<String>)> = HashMap::new();
        for (tag_name, cn_name, file_id) in chars {
            let entry = stats.entry(tag_name).or_insert((cn_name.clone(), 0, None));
            entry.1 += 1;
            if entry.0.is_none() && cn_name.is_some() {
                entry.0 = cn_name;
            }
            if entry.2.is_none() {
                entry.2 = Some(file_id);
            }
        }
        character_stats_by_work.insert(work_name, stats);
    }
    
    let app_db_pool = app.state::<db::AppDbPool>();
    let conn = app_db_pool.get_connection();
    
    let existing_people = db::persons::get_all_people(&conn)
        .map_err(|e| format!("Failed to get persons: {}", e))?;
    
    log::info!("[clip_create_work_topics] 数据库中有 {} 个人物", existing_people.len());
    
    let person_by_tag: HashMap<String, String> = existing_people
        .iter()
        .filter_map(|p| {
            p.character_tag_name.as_ref().map(|tag_name| {
                (tag_name.clone(), p.id.clone())
            })
        })
        .collect();
    
    let mut people_by_work: HashMap<String, Vec<String>> = HashMap::new();
    
    for person in &existing_people {
        if let Some(tag_name) = &person.character_tag_name {
            if let Some(extraction) = extract_work_name(tag_name, cn_translations.get(tag_name).map(|s| s.as_str())) {
                let work_name = extraction.work_name;
                if work_names.contains(&work_name) {
                    people_by_work.entry(work_name.clone()).or_default().push(person.id.clone());
                    log::info!("[clip_create_work_topics]   人物 '{}' (tag: '{}') 属于作品 '{}'", person.name, tag_name, work_name);
                }
            }
        }
    }
    
    log::info!("[clip_create_work_topics] people_by_work 结果:");
    for (work, people) in people_by_work.iter() {
        log::info!("[clip_create_work_topics]   作品 '{}' 有 {} 个人物", work, people.len());
    }
    
    let mut created_topics: Vec<db::topics::Topic> = Vec::new();
    let mut created_people: Vec<db::persons::Person> = Vec::new();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    
    for work_name in work_names {
        let existing_topic = db::topics::find_topic_by_work_name(&conn, &work_name)
            .map_err(|e| format!("Failed to find topic: {}", e))?;
        
        if existing_topic.is_some() {
            log::info!("[clip_create_work_topics] 作品 '{}' 的专题已存在，跳过", work_name);
            continue;
        }
        
        let work_name_cn = crate::work_extractor::get_series_name_cn(&work_name);
        
        let display_name = get_work_display_name(&work_name, "zh");
        let work_name_cn_value = work_name_cn.unwrap_or_else(|| display_name.clone());
        
        let topic_id = db::generate_id(&format!("work_topic_{}", work_name));
        let mut people_ids = people_by_work.get(&work_name).cloned().unwrap_or_default();
        let file_ids = files_by_work.get(&work_name).cloned().unwrap_or_default();
        
        if let Some(character_stats) = character_stats_by_work.get(&work_name) {
            for (tag_name, (cn_name, image_count, sample_file_id)) in character_stats {
                if !person_by_tag.contains_key(tag_name) {
                    let new_person_id = db::generate_id(&format!("person_{}", tag_name));
                    
                    let person_name = if let Some(cn) = cn_name {
                        cn.clone()
                    } else if let Some(extraction) = extract_work_name(tag_name, None) {
                        extraction.character_name
                    } else {
                        tag_name.clone()
                    };
                    
                    let cover_file_id = sample_file_id.clone().unwrap_or_default();
                    
                    let new_person = db::persons::Person {
                        id: new_person_id.clone(),
                        name: person_name.clone(),
                        cover_file_id,
                        count: *image_count as i32,
                        description: None,
                        face_box: None,
                        updated_at: Some(now),
                        character_tag_name: Some(tag_name.clone()),
                        character_tag_index: None,
                    };
                    
                    match db::persons::upsert_person(&conn, &new_person) {
                        Ok(_) => {
                            log::info!("[clip_create_work_topics]   创建新人物 '{}' (tag: '{}', 图片数: {}, 封面: {})", person_name, tag_name, image_count, new_person.cover_file_id);
                            people_ids.push(new_person_id);
                            created_people.push(new_person);
                        }
                        Err(e) => {
                            log::error!("[clip_create_work_topics]   创建人物失败: {}", e);
                        }
                    }
                }
            }
        }
        
        log::info!("[clip_create_work_topics] 创建专题 '{}' (work_name: '{}')", display_name, work_name);
        log::info!("[clip_create_work_topics]   people_ids 数量: {}", people_ids.len());
        log::info!("[clip_create_work_topics]   file_ids 数量: {}", file_ids.len());
        
        let cover_file_id = work_cover_ids.get(&work_name)
            .and_then(|c| c.clone())
            .or_else(|| {
                if let Some(stats) = character_stats_by_work.get(&work_name) {
                    for (_, (_, _, sample)) in stats {
                        if sample.is_some() {
                            return sample.clone();
                        }
                    }
                }
                None
            });

        let custom_type = work_types.get(&work_name).and_then(|t| t.clone()).or(Some("TOPIC".to_string()));

        let file_count = file_ids.len() as i32;
        let topic = db::topics::Topic {
            id: topic_id.clone(),
            parent_id: None,
            name: display_name,
            description: None,
            topic_type: custom_type,
            cover_file_id,
            background_file_id: None,
            cover_crop: None,
            people_ids,
            file_ids,
            source_url: None,
            created_at: Some(now),
            updated_at: Some(now),
            source_type: Some("auto_work".to_string()),
            work_name: Some(work_name.clone()),
            work_name_cn: Some(work_name_cn_value),
            file_count,
        };

        db::topics::upsert_topic(&conn, &topic)
            .map_err(|e| format!("Failed to create topic: {}", e))?;
        // Phase 0: 同步成员到 topic_files / topic_people 关联表
        db::topics::set_topic_files(&conn, &topic_id, &topic.file_ids)
            .map_err(|e| format!("Failed to set topic_files: {}", e))?;
        db::topics::set_topic_people(&conn, &topic_id, &topic.people_ids)
            .map_err(|e| format!("Failed to set topic_people: {}", e))?;

        created_topics.push(topic);
        log::info!("[clip_create_work_topics] Created topic for work: {}", work_name);
    }
    
    let mut tag_to_person_id: HashMap<String, String> = HashMap::new();
    let mut person_names: HashMap<String, String> = HashMap::new();
    
    // 添加已存在的人物
    for person in &existing_people {
        person_names.insert(person.id.clone(), person.name.clone());
        if let Some(ref tag_name) = person.character_tag_name {
            tag_to_person_id.insert(tag_name.clone(), person.id.clone());
        }
    }
    
    // 添加新创建的人物
    for person in &created_people {
        person_names.insert(person.id.clone(), person.name.clone());
        if let Some(ref tag_name) = person.character_tag_name {
            tag_to_person_id.insert(tag_name.clone(), person.id.clone());
        }
    }
    
    log::info!("[clip_create_work_topics] 开始关联文件到人物, 共 {} 个文件需要处理", file_character_tags.len());
    link_files_to_persons(&file_character_tags, &tag_to_person_id, &person_names, &conn)?;
    
    Ok(CreateWorkTopicsResult {
        topics: created_topics,
        people: created_people,
    })
}
