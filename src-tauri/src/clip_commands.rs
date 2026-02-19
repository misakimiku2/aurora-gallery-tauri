use crate::clip::embedding::ImageEmbedding;
use crate::clip::search::{SearchOptions, SearchResult};
use crate::db::{self, generate_id};
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
                log::info!("[CLIP Search] Loading model: {} (current: {}, loaded: {})", 
                    requested_model, current_model, is_loaded);
                
                if is_loaded {
                    guard.unload_model();
                }
                
                guard.set_model_name(&requested_model);
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
                log::info!("Loading model: {} (current: {}, loaded: {})", 
                    requested_model, current_model, is_loaded);
                
                if is_loaded {
                    guard.unload_model();
                }
                
                guard.set_model_name(&requested_model);
                guard.load_model(&app).await.map_err(|e| format!("Failed to load model: {}", e))?;
            }
        }
    }
    
    let mut guard = manager.write().await;
    
    let model = guard.model_mut()
        .ok_or("CLIP model not available")?;
    
    let image_embedding = model.encode_image(&image_path)?;
    
    let embedding_store = guard.embedding_store()
        .ok_or("Embedding store not available")?;
    
    let searcher = crate::clip::search::SimilaritySearcher::new(embedding_store.clone());
    let options = SearchOptions {
        top_k: top_k.unwrap_or(50),
        min_score: min_score.unwrap_or(0.0),
        include_score: true,
    };
    
    searcher.search(&image_embedding, &options, Some(&requested_model))
}

#[tauri::command]
pub async fn clip_generate_embedding(
    file_path: String,
    file_id: Option<String>,
) -> Result<Vec<f32>, String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    
    let mut guard = manager.write().await;
    
    if !guard.is_model_loaded() {
        return Err("CLIP model not loaded".to_string());
    }
    
    let model = guard.model_mut()
        .ok_or("CLIP model not available")?;
    
    let embedding = model.encode_image(&file_path)?;
    
    let config_clone = guard.config().clone();
    if let Some(embedding_store) = guard.embedding_store() {
        let id = file_id.unwrap_or_else(|| generate_id(&file_path));
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

    struct GenerationGuard;
    impl Drop for GenerationGuard {
        fn drop(&mut self) {
            IS_GENERATING.store(false, Ordering::SeqCst);
            log::info!("Global generating flag reset.");
        }
    }
    let _gen_guard = GenerationGuard;

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
                log::info!("[Embedding Gen] Loading model: {} (current: {}, loaded: {})", 
                    requested_model, current_model, is_loaded);
                
                if is_loaded {
                    guard.unload_model();
                }
                
                guard.set_model_name(&requested_model);
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
                if using_gpu { 32 } else { 4 }
            },
            "ViT-B-32" => {
                log::info!("[CLIP Batch] Matched ViT-B-32, GPU: {}", using_gpu);
                if using_gpu { 64 } else { 8 }
            },
            other => {
                log::warn!("[CLIP Batch] Unknown model name '{}', using default batch size", other);
                if using_gpu { 32 } else { 8 }
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
                match embedding_store.has_embedding(file_id) {
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
                    for (file_id, embedding) in batch_file_ids.iter().zip(embeddings.iter()) {
                        let image_embedding = ImageEmbedding {
                            file_id: file_id.clone(),
                            embedding: embedding.clone(),
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
                                        embedding: embeddings[i].clone(),
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
                        Ok(embedding) => {
                            let save_result = {
                                let guard = manager.read().await;
                                let embedding_store = guard.embedding_store().ok_or("Embedding store not available")?;
                                let image_embedding = ImageEmbedding {
                                    file_id: file_id.clone(),
                                    embedding,
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
    
    if guard.is_model_loaded() {
        log::info!("Unloading current model to switch to: {}", model_name);
        guard.unload_model();
    }
    
    guard.set_model_name(model_name);
    
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
pub async fn clip_get_model_status(model_name: String) -> Result<serde_json::Value, String> {
    use crate::clip::model::ModelInfo;
    
    let model_info = match model_name.as_str() {
        "ViT-B-32" => ModelInfo::vit_b_32(),
        "ViT-L-14" => ModelInfo::vit_l_14(),
        _ => return Err(format!("Unknown model: {}", model_name)),
    };
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    let guard = manager.read().await;
    let cache_dir = &guard.config().cache_dir;
    
    let model_cache_dir = cache_dir.join(&model_name);
    
    let image_model_file = model_info.image_model_url.split('/').last().unwrap_or("image_encoder.onnx");
    let text_model_file = model_info.text_model_url.split('/').last().unwrap_or("text_encoder.onnx");
    let tokenizer_file = model_info.tokenizer_url.split('/').last().unwrap_or("tokenizer.json");
    
    let image_path = model_cache_dir.join(image_model_file);
    let text_path = model_cache_dir.join(text_model_file);
    let tokenizer_path = model_cache_dir.join(tokenizer_file);
    
    let image_exists = image_path.exists();
    let text_exists = text_path.exists();
    let tokenizer_exists = tokenizer_path.exists();
    
    let is_downloaded = image_exists && text_exists && tokenizer_exists;
    
    let mut downloaded_size: u64 = 0;
    if image_exists {
        if let Ok(metadata) = std::fs::metadata(&image_path) {
            downloaded_size += metadata.len();
        }
    }
    if text_exists {
        if let Ok(metadata) = std::fs::metadata(&text_path) {
            downloaded_size += metadata.len();
        }
    }
    if tokenizer_exists {
        if let Ok(metadata) = std::fs::metadata(&tokenizer_path) {
            downloaded_size += metadata.len();
        }
    }
    
    let is_gpu_active = if let Some(model) = guard.model() {
        if model.model_name() == model_info.name {
            model.is_using_gpu()
        } else {
            false
        }
    } else {
        false
    };

    Ok(serde_json::json!({
        "model_name": model_info.name,
        "is_downloaded": is_downloaded,
        "is_gpu_active": is_gpu_active,
        "embedding_dim": model_info.embedding_dim,
        "image_size": model_info.image_size,
        "downloaded_size": downloaded_size,
        "files": {
            "image_encoder": image_exists,
            "text_encoder": text_exists,
            "tokenizer": tokenizer_exists,
        }
    }))
}

#[tauri::command]
pub async fn clip_delete_model(model_name: String) -> Result<(), String> {
    use crate::clip::model::ModelInfo;
    use std::fs;
    
    let model_info = match model_name.as_str() {
        "ViT-B-32" => ModelInfo::vit_b_32(),
        "ViT-L-14" => ModelInfo::vit_l_14(),
        _ => return Err(format!("Unknown model: {}", model_name)),
    };
    
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    let guard = manager.read().await;
    let cache_dir = &guard.config().cache_dir;
    
    let model_cache_dir = cache_dir.join(&model_name);
    
    let image_model_file = model_info.image_model_url.split('/').last().unwrap_or("image_encoder.onnx");
    let text_model_file = model_info.text_model_url.split('/').last().unwrap_or("text_encoder.onnx");
    let tokenizer_file = model_info.tokenizer_url.split('/').last().unwrap_or("tokenizer.json");
    
    let image_path = model_cache_dir.join(image_model_file);
    let text_path = model_cache_dir.join(text_model_file);
    let tokenizer_path = model_cache_dir.join(tokenizer_file);
    
    if image_path.exists() {
        fs::remove_file(&image_path).map_err(|e| format!("Failed to delete image model: {}", e))?;
    }
    if text_path.exists() {
        fs::remove_file(&text_path).map_err(|e| format!("Failed to delete text model: {}", e))?;
    }
    if tokenizer_path.exists() {
        fs::remove_file(&tokenizer_path).map_err(|e| format!("Failed to delete tokenizer: {}", e))?;
    }
    
    if model_cache_dir.exists() {
        let _ = fs::remove_dir(&model_cache_dir);
    }
    
    log::info!("Deleted CLIP model files for: {}", model_name);
    Ok(())
}

#[tauri::command]
pub async fn clip_open_model_folder() -> Result<(), String> {
    let manager = crate::clip::get_clip_manager().await
        .ok_or("CLIP manager not initialized")?;
    let guard = manager.read().await;
    let cache_dir = &guard.config().cache_dir;
    
    if !cache_dir.exists() {
        std::fs::create_dir_all(cache_dir)
            .map_err(|e| format!("Failed to create cache directory: {}", e))?;
    }
    
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("explorer")
            .arg(cache_dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(cache_dir)
            .spawn()
            .map_err(|e| format!("Failed to open folder: {}", e))?;
    }
    
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open")
            .arg(cache_dir)
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
