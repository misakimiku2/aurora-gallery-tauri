use crate::clip::embedding::ImageEmbedding;
use crate::clip::search::{SearchOptions, SearchResult};
use crate::db::{self, generate_id, AppDbPool};
use crate::db::file_metadata::{FileMetadata, upsert_file_metadata, get_metadata_by_id};
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::{Emitter, Manager};

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
        
        // 保存标签（如果是 Tagger）
        if let Some(tags) = &inference_result.tags {
            save_tags_to_metadata(&id, &file_path, tags, &app)?;
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
        let batch_file_ids: Vec<String> = batch.iter().map(|(_, id)| id.clone()).collect();
        
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
                    for (i, ((_path, file_id), result)) in batch.iter().zip(embeddings.iter()).enumerate() {
                        // 保存标签（如果是 Tagger）
                        if let Some(tags) = &result.tags {
                            let _ = save_tags_to_metadata(file_id, _path, tags, &app);
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
                                
                                // 保存标签（如果是 Tagger）
                                if let Some(tags) = &result.tags {
                                    let _ = save_tags_to_metadata(file_id, file_path, tags, &app);
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
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let mut guard = manager.write().await;
    
    // 使用 switch_model 切换模型和嵌入数据库
    guard.switch_model(&model_name)?;
    
    // 加载模型
    guard.load_model(&app).await
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
        let exists = file_path.exists();
        if !exists {
            is_downloaded = false;
        } else {
            if let Ok(metadata) = std::fs::metadata(&file_path) {
                downloaded_size += metadata.len();
            }
        }
        files_status.insert(model_file.name.clone(), serde_json::json!(exists));
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
    app: &tauri::AppHandle,
) -> Result<(), String> {
    let pool = app.state::<AppDbPool>();
    let pool_inner = pool.inner().clone();
    
    let file_id = file_id.to_string();
    let file_path = db::normalize_path(file_path);
    // 只保留标签名称
    let tag_names: Vec<String> = tags.iter().map(|(name, _prob)| name.clone()).collect();
    
    tokio::task::spawn_blocking(move || {
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

        upsert_file_metadata(&conn, &metadata).map_err(|e| e.to_string())
    });

    Ok(())
}
