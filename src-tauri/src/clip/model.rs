//! CLIP 模型加载和推理
//! 支持 ONNX 格式的 CLIP 模型，使用 ONNX Runtime 进行 GPU 加速推理

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use once_cell::sync::OnceCell;
use ort::session::Session;
use ort::value::Tensor;
use tauri::Emitter;
use reqwest::Client;
use sha2::{Sha256, Digest};

use super::ClipConfig;
use super::preprocessor::{ImagePreprocessor, TextPreprocessor};
use super::models::{ModelSpec, get_model_spec};

/// 下载超时时间（秒）
const DOWNLOAD_TIMEOUT_SECS: u64 = 300; // 5分钟
/// 连接超时时间（秒）
const CONNECT_TIMEOUT_SECS: u64 = 30; // 30秒
/// 重试次数
const MAX_RETRY_COUNT: u32 = 3;

/// 全局模型状态
static MODEL_STATE: OnceCell<std::sync::Mutex<ModelState>> = OnceCell::new();

struct ModelState {
    is_loaded: bool,
    model_name: String,
}

/// CLIP 模型结构
pub struct ClipModel {
    config: ClipConfig,
    image_preprocessor: ImagePreprocessor,
    text_preprocessor: TextPreprocessor,
    vision_session: Option<Session>,
    text_session: Option<Session>,
    model_spec: Arc<dyn ModelSpec>,
    is_gpu_active: bool,
}

impl ClipModel {
    /// 获取模型专属缓存目录
    fn get_model_cache_dir(cache_dir: &PathBuf, model_name: &str) -> PathBuf {
        cache_dir.join(model_name)
    }

    /// 加载 CLIP 模型
    pub async fn load(config: &ClipConfig, app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let model_spec = get_model_spec(&config.model_name)
            .ok_or_else(|| format!("Unsupported model: {}", config.model_name))?;

        // 获取模型专属缓存目录
        let model_cache_dir = Self::get_model_cache_dir(&config.cache_dir, model_spec.name());
        
        // 确保模型目录存在
        if !model_cache_dir.exists() {
            tokio::fs::create_dir_all(&model_cache_dir)
                .await
                .map_err(|e| format!("Failed to create model cache directory: {}", e))?;
        }

        // 获取模型文件列表
        let model_files = model_spec.model_files();
        let total_files = model_files.len();

        // 下载所有模型文件
        let mut downloaded_paths: std::collections::HashMap<String, PathBuf> = std::collections::HashMap::new();
        for (file_index, model_file) in model_files.iter().enumerate() {
            let file_path = Self::ensure_model_file(&model_file, &model_cache_dir, app_handle, file_index, total_files).await?;
            downloaded_paths.insert(model_file.name.clone(), file_path);
        }

        // 创建预处理器，使用模型规格中的参数
        let image_preprocessor = ImagePreprocessor::new(
            model_spec.image_size(),
            model_spec.image_mean(),
            model_spec.image_std(),
        );
        let mut text_preprocessor = TextPreprocessor::new(model_spec.max_text_length());
        
        // 加载 tokenizer
        let tokenizer_path = downloaded_paths.get("tokenizer.json")
            .ok_or("tokenizer.json not found in model files")?;
        text_preprocessor.load_tokenizer(tokenizer_path)
            .map_err(|e| format!("Failed to load tokenizer: {}", e))?;

        log::info!("CLIP model files ready: {}", config.model_name);
        
        // 初始化 ONNX Runtime 会话
        let (vision_session, text_session, is_gpu_active) = Self::init_sessions_from_spec(
            &downloaded_paths,
            model_spec.as_ref(),
            config.use_gpu,
        ).map_err(|e| {
            let error_msg = e.to_string();
            log::error!("Failed to initialize ONNX sessions: {}", error_msg);
            
            // 检查是否是文件损坏导致的错误
            let is_corrupt = error_msg.contains("Protobuf parsing failed") || 
                error_msg.contains("Invalid protobuf") ||
                error_msg.contains("corrupt") ||
                error_msg.contains("invalid model") ||
                error_msg.contains("ModelWrapper");
            
            if is_corrupt {
                format!("模型文件可能已损坏。请尝试删除该模型后重新下载。错误: {}", error_msg)
            } else {
                format!("Failed to initialize ONNX sessions: {}", error_msg)
            }
        })?;

        log::info!("CLIP model loaded successfully with {} acceleration", 
            if is_gpu_active { "GPU (DirectML)" } else { "CPU" });
        
        // 标记模型为已加载
        let state = MODEL_STATE.get_or_init(|| {
            std::sync::Mutex::new(ModelState {
                is_loaded: false,
                model_name: config.model_name.clone(),
            })
        });
        
        if let Ok(mut s) = state.lock() {
            s.is_loaded = true;
            s.model_name = config.model_name.clone();
        }

        Ok(Self {
            config: config.clone(),
            image_preprocessor,
            text_preprocessor,
            vision_session: Some(vision_session),
            text_session: Some(text_session),
            model_spec,
            is_gpu_active,
        })
    }

    /// 根据 ModelSpec 初始化 ONNX Runtime 会话
    fn init_sessions_from_spec(
        downloaded_paths: &std::collections::HashMap<String, PathBuf>,
        _model_spec: &dyn ModelSpec,
        use_gpu: bool,
    ) -> Result<(Session, Session, bool), Box<dyn std::error::Error>> {
        let builder = Session::builder()?;
        let mut actual_gpu_active = false;
        
        let builder = if use_gpu {
            #[cfg(target_os = "windows")]
            {
                log::info!("Attempting to enable DirectML Execution Provider...");
                let dml_provider = ort::execution_providers::DirectMLExecutionProvider::default()
                    .with_device_id(0);
                
                match builder.clone().with_execution_providers([dml_provider.build()]) {
                    Ok(b) => {
                        log::info!("DirectML Execution Provider enabled successfully!");
                        actual_gpu_active = true;
                        b
                    }
                    Err(e) => {
                        log::warn!("DirectML failed: {}, falling back to CPU...", e);
                        Session::builder()?
                    }
                }
            }
            
            #[cfg(not(target_os = "windows"))]
            {
                log::info!("GPU acceleration only supported on Windows (DirectML), using CPU");
                builder
            }
        } else {
            log::info!("GPU acceleration disabled, using CPU");
            builder
        };

        // 检查是否使用单一模型文件（如 SigLIP 2）
        // 如果存在 model.onnx，则使用它同时作为 vision 和 text 模型
        if let Some(model_path) = downloaded_paths.get("model.onnx") {
            log::info!("Using unified model file: {:?}", model_path);
            // 对于单一模型文件，vision 和 text 使用同一个 session
            // 需要创建两个独立的 session，因为 Session 不支持 Clone
            let vision_session = Session::builder()?.commit_from_file(model_path)?;
            let text_session = builder.commit_from_file(model_path)?;
            log::info!("Unified model loaded for both vision and text");
            return Ok((vision_session, text_session, actual_gpu_active));
        }

        // 使用分离的 vision_model.onnx 和 text_model.onnx（CLIP 模型）
        let vision_model_path = downloaded_paths.get("vision_model.onnx")
            .ok_or("vision_model.onnx not found in model files")?;
        let text_model_path = downloaded_paths.get("text_model.onnx")
            .ok_or("text_model.onnx not found in model files")?;

        let vision_session = builder.clone().commit_from_file(vision_model_path)?;
        log::info!("Vision model loaded: {:?}", vision_model_path);

        let text_session = builder.commit_from_file(text_model_path)?;
        log::info!("Text model loaded: {:?}", text_model_path);
        
        Ok((vision_session, text_session, actual_gpu_active))
    }

    /// 验证文件完整性
    /// 
    /// # 参数
    /// * `file_path` - 文件路径
    /// * `expected_size` - 预期文件大小（可选）
    /// * `expected_hash` - 预期 SHA256 哈希值（可选）
    ///
    /// # 返回
    /// 如果文件有效返回 `Ok(())`，否则返回错误信息
    fn verify_file(
        file_path: &PathBuf,
        expected_size: Option<u64>,
        expected_hash: Option<&str>,
    ) -> Result<(), String> {
        // 检查文件是否存在
        if !file_path.exists() {
            return Err("File does not exist".to_string());
        }

        // 获取文件元数据
        let metadata = std::fs::metadata(file_path)
            .map_err(|e| format!("Failed to read file metadata: {}", e))?;
        let actual_size = metadata.len();

        // 验证文件大小
        if let Some(expected) = expected_size {
            if actual_size != expected {
                log::warn!(
                    "File size mismatch for {:?}: expected {}, got {}",
                    file_path, expected, actual_size
                );
                return Err(format!(
                    "File size mismatch: expected {} bytes, got {} bytes",
                    expected, actual_size
                ));
            }
        }

        // 验证文件哈希
        if let Some(expected) = expected_hash {
            let mut file = std::fs::File::open(file_path)
                .map_err(|e| format!("Failed to open file for hashing: {}", e))?;
            let mut hasher = Sha256::new();
            std::io::copy(&mut file, &mut hasher)
                .map_err(|e| format!("Failed to read file for hashing: {}", e))?;
            let result = hasher.finalize();
            let actual_hash = format!("{:x}", result);

            if actual_hash != expected {
                log::warn!(
                    "File hash mismatch for {:?}: expected {}, got {}",
                    file_path, expected, actual_hash
                );
                return Err(format!(
                    "File hash mismatch: expected {}, got {}",
                    expected, actual_hash
                ));
            }
        }

        log::debug!("File verification passed for {:?}", file_path);
        Ok(())
    }

    /// 确保模型文件存在且完整，如果不存在或损坏则下载（支持进度事件和重试）
    async fn ensure_model_file(
        model_file: &super::models::ModelFile,
        cache_dir: &PathBuf,
        app_handle: &tauri::AppHandle,
        file_index: usize,
        total_files: usize,
    ) -> Result<PathBuf, String> {
        let file_name = &model_file.name;
        let file_path = cache_dir.join(file_name);
        let url = &model_file.url;

        // 检查文件是否存在且完整
        if file_path.exists() {
            log::debug!("Model file exists: {:?}, verifying integrity...", file_path);
            match Self::verify_file(&file_path, model_file.expected_size, model_file.expected_hash.as_deref()) {
                Ok(()) => {
                    log::info!("Model file verified: {:?}", file_path);
                    return Ok(file_path);
                }
                Err(e) => {
                    log::warn!("Model file verification failed: {}, re-downloading...", e);
                    // 删除损坏的文件
                    if let Err(delete_err) = tokio::fs::remove_file(&file_path).await {
                        log::error!("Failed to delete corrupt file: {}", delete_err);
                    }
                }
            }
        }

        // 创建带超时的 HTTP 客户端
        let client = Client::builder()
            .connect_timeout(Duration::from_secs(CONNECT_TIMEOUT_SECS))
            .timeout(Duration::from_secs(DOWNLOAD_TIMEOUT_SECS))
            .build()
            .map_err(|e| format!("Failed to create HTTP client: {}", e))?;

        // 重试逻辑
        let mut last_error = String::new();
        for attempt in 1..=MAX_RETRY_COUNT {
            log::info!("Downloading model file from {} to {:?} (attempt {}/{})", url, file_path, attempt, MAX_RETRY_COUNT);
            
            // 发送开始下载进度（0%）
            let _ = app_handle.emit("clip-model-download-progress", serde_json::json!({
                "file_name": file_name,
                "file_index": file_index,
                "total_files": total_files,
                "downloaded": 0,
                "total": 0,
                "progress": 0,
                "overall_progress": (file_index * 100) / total_files,
            }));
            
            match Self::download_file_with_client(&client, url, &file_path, app_handle, file_index, total_files, file_name).await {
                Ok(()) => {
                    log::info!("Downloaded model file: {:?}", file_path);
                    return Ok(file_path);
                }
                Err(e) => {
                    last_error = e;
                    log::warn!("Download attempt {}/{} failed: {}", attempt, MAX_RETRY_COUNT, last_error);
                    
                    // 如果不是最后一次尝试，等待后重试
                    if attempt < MAX_RETRY_COUNT {
                        let delay = Duration::from_secs(2 * attempt as u64); // 递增延迟
                        log::info!("Waiting {:?} before retry...", delay);
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }
        
        Err(format!("Failed to download after {} attempts: {}", MAX_RETRY_COUNT, last_error))
    }
    
    /// 使用客户端下载文件
    async fn download_file_with_client(
        client: &Client,
        url: &str,
        file_path: &PathBuf,
        app_handle: &tauri::AppHandle,
        file_index: usize,
        total_files: usize,
        file_name: &str,
    ) -> Result<(), String> {
        let response = client.get(url)
            .send()
            .await
            .map_err(|e| {
                if e.is_timeout() {
                    format!("Connection timeout: {}", e)
                } else if e.is_connect() {
                    format!("Connection error: {}", e)
                } else {
                    format!("Failed to download {}: {}", url, e)
                }
            })?;

        if !response.status().is_success() {
            return Err(format!("HTTP {}: {}", response.status(), url));
        }

        let total_size = response.content_length().unwrap_or(0);
        
        let mut stream = response.bytes_stream();
        let mut downloaded: u64 = 0;
        let mut file = tokio::fs::File::create(file_path)
            .await
            .map_err(|e| format!("Failed to create file: {}", e))?;
        
        use futures_util::StreamExt;
        
        let mut last_emit_time = Instant::now();
        let mut last_speed_time = Instant::now() - Duration::from_secs(1);
        let mut last_downloaded_for_speed: u64 = 0;
        let progress_emit_interval = Duration::from_millis(200);
        let speed_calc_interval = Duration::from_millis(500);
        let mut current_speed: u64 = 0;
        
        loop {
            let chunk_result = tokio::time::timeout(progress_emit_interval, stream.next()).await;
            
            match chunk_result {
                Ok(Some(chunk)) => {
                    let chunk = chunk.map_err(|e| format!("Failed to download chunk: {}", e))?;
                    let chunk_size = chunk.len() as u64;
                    
                    tokio::io::AsyncWriteExt::write_all(&mut file, &chunk)
                        .await
                        .map_err(|e| format!("Failed to write file chunk: {}", e))?;
                    
                    downloaded += chunk_size;
                }
                Ok(None) => break,
                Err(_) => {
                }
            }
            
            let now = Instant::now();
            
            if now.duration_since(last_speed_time) >= speed_calc_interval {
                let elapsed_secs = now.duration_since(last_speed_time).as_secs_f64();
                if elapsed_secs > 0.0 {
                    let bytes_since_last = downloaded.saturating_sub(last_downloaded_for_speed);
                    current_speed = (bytes_since_last as f64 / elapsed_secs) as u64;
                }
                last_speed_time = now;
                last_downloaded_for_speed = downloaded;
            }
            
            if now.duration_since(last_emit_time) >= progress_emit_interval {
                let file_progress = if total_size > 0 {
                    (downloaded as f64 / total_size as f64) * 100.0
                } else {
                    0.0
                };
                
                let overall_progress = ((file_index as f64 * 100.0) + file_progress) / total_files as f64;
                
                let _ = app_handle.emit("clip-model-download-progress", serde_json::json!({
                    "file_name": file_name,
                    "file_index": file_index,
                    "total_files": total_files,
                    "downloaded": downloaded,
                    "total": total_size,
                    "progress": file_progress as u32,
                    "overall_progress": overall_progress as u32,
                    "speed": current_speed,
                }));
                
                last_emit_time = now;
            }
        }
        
        tokio::io::AsyncWriteExt::flush(&mut file)
            .await
            .map_err(|e| format!("Failed to flush file: {}", e))?;
        
        let overall_progress = ((file_index + 1) * 100) / total_files;
        let _ = app_handle.emit("clip-model-download-progress", serde_json::json!({
            "file_name": file_name,
            "file_index": file_index,
            "total_files": total_files,
            "downloaded": total_size,
            "total": total_size,
            "progress": 100,
            "overall_progress": overall_progress,
            "speed": 0,
        }));
        
        Ok(())
    }
    
    /// 检查模型文件是否存在于本地
    pub fn check_local_model_files(cache_dir: &PathBuf, model_name: &str) -> Result<bool, String> {
        let model_spec = get_model_spec(model_name)
            .ok_or_else(|| format!("Unknown model: {}", model_name))?;
        
        // 使用模型专属子目录
        let model_cache_dir = cache_dir.join(model_name);
        
        // 检查所有模型文件是否存在
        let model_files = model_spec.model_files();
        for model_file in model_files {
            let file_path = model_cache_dir.join(&model_file.name);
            if !file_path.exists() {
                return Ok(false);
            }
        }
        
        Ok(true)
    }

    /// 编码图像 - 使用 ONNX Runtime GPU 推理
    pub fn encode_image(&mut self, image_path: &str) -> Result<Vec<f32>, String> {
        // 检查文件是否存在
        if !std::path::Path::new(image_path).exists() {
            return Err(format!("Image file not found: {}", image_path));
        }

        // 获取会话 - 需要可变引用
        let session = self.vision_session.as_mut()
            .ok_or("Vision model not loaded")?;

        // 预处理图像为 NCHW 格式张量
        let tensor_data = self.image_preprocessor.preprocess(image_path)
            .map_err(|e| format!("Failed to preprocess image: {}", e))?;

        // 创建输入 Tensor - 使用 (shape, data) 元组格式
        let image_size = self.model_spec.image_size();
        let input_shape: Vec<i64> = vec![1, 3, image_size as i64, image_size as i64];
        let input_tensor = Tensor::from_array((input_shape, tensor_data.into_boxed_slice()))
            .map_err(|e| format!("Failed to create input tensor: {}", e))?;

        // 执行推理 - session.run 需要可变引用
        let outputs = session.run(vec![(self.model_spec.vision_input_name(), input_tensor)])
            .map_err(|e| format!("Failed to run inference: {}", e))?;

        // 提取嵌入向量 - try_extract_tensor 返回 (Shape, &[f32])
        let (_shape, embedding_data): (&ort::tensor::Shape, &[f32]) = outputs[self.model_spec.vision_output_name()]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract embedding: {}", e))?;

        // 转换为 Vec<f32> 并归一化
        let mut vec: Vec<f32> = embedding_data.iter().copied().collect();
        normalize_vector(&mut vec);

        Ok(vec)
    }

    /// 编码文本 - 使用 ONNX Runtime GPU 推理
    pub fn encode_text(&mut self, text: &str) -> Result<Vec<f32>, String> {
        // 验证文本不为空
        if text.trim().is_empty() {
            return Err("Empty text provided".to_string());
        }

        // 获取会话 - 需要可变引用
        let session = self.text_session.as_mut()
            .ok_or("Text model not loaded")?;

        // 预处理文本
        let (input_ids, _attention_mask) = self.text_preprocessor.preprocess(text)
            .map_err(|e| format!("Failed to preprocess text: {}", e))?;

        // 创建输入 Tensors - 使用 (shape, data) 元组格式
        let input_ids_shape: Vec<i64> = vec![1, input_ids.len() as i64];
        let input_ids_data: Vec<i64> = input_ids.into_iter().map(|x| x as i64).collect();
        let input_ids_tensor = Tensor::from_array((input_ids_shape, input_ids_data.into_boxed_slice()))
            .map_err(|e| format!("Failed to create input_ids tensor: {}", e))?;

        // 执行推理 - session.run 需要可变引用
        // 只传递 input_ids，因为 attention_mask 不是这个模型的有效输入
        let outputs = session.run(vec![(self.model_spec.text_input_name(), input_ids_tensor)])
            .map_err(|e| format!("Failed to run inference: {}", e))?;

        // 提取嵌入向量
        let (_shape, embedding_data): (&ort::tensor::Shape, &[f32]) = outputs[self.model_spec.text_output_name()]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract embedding: {}", e))?;

        // 转换为 Vec<f32> 并归一化
        let mut vec: Vec<f32> = embedding_data.iter().copied().collect();
        normalize_vector(&mut vec);

        Ok(vec)
    }

    /// 批量编码图像 - 使用 GPU 批量推理
    pub fn encode_images_batch(&mut self, image_paths: &[String]) -> Result<Vec<Vec<f32>>, String> {
        log::info!("encode_images_batch called with {} images", image_paths.len());
        
        if image_paths.is_empty() {
            log::info!("Empty image_paths, returning empty result");
            return Ok(Vec::new());
        }

        // 对于小批量，使用串行处理（避免 GPU 启动开销）
        if image_paths.len() <= 4 {
            log::info!("Small batch ({}), using serial processing", image_paths.len());
            let mut results = Vec::with_capacity(image_paths.len());
            for (i, path) in image_paths.iter().enumerate() {
                log::info!("Processing image {}/{}: {}", i + 1, image_paths.len(), path);
                results.push(self.encode_image(path)?);
            }
            return Ok(results);
        }

        // 大批量使用真正的批量推理
        log::info!("Large batch ({}), using GPU batch processing", image_paths.len());
        self.encode_images_batch_gpu(image_paths)
    }

    /// GPU 批量推理
    fn encode_images_batch_gpu(&mut self, image_paths: &[String]) -> Result<Vec<Vec<f32>>, String> {
        log::info!("[CLIP Batch] GPU active: {}, model: {}, batch_size: {}", 
            self.is_gpu_active, self.model_spec.name(), image_paths.len());
        log::info!("encode_images_batch_gpu started: {} images", image_paths.len());
        
        let session = self.vision_session.as_mut()
            .ok_or("Vision model not loaded")?;

        let batch_size = image_paths.len();
        let image_size = self.model_spec.image_size();

        // 使用多线程批量预处理所有图像
        // 根据 CPU 核心数动态调整线程数，但至少使用 8 个线程
        let num_threads = std::cmp::max(8, num_cpus::get() / 2);
        log::info!("Preprocessing {} images using rayon ({} threads)...", batch_size, num_threads);
        let preprocess_start = std::time::Instant::now();
        
        let tensors = self.image_preprocessor.preprocess_batch(image_paths, num_threads)
            .map_err(|e| format!("Failed to preprocess batch: {}", e))?;
        
        let preprocess_elapsed = preprocess_start.elapsed().as_millis();
        let avg_preprocess_time = if batch_size > 0 { preprocess_elapsed as f64 / batch_size as f64 } else { 0.0 };
        log::info!("Preprocessing completed in {}ms (avg {:.2}ms per image)", preprocess_elapsed, avg_preprocess_time);
        
        // 合并为批次张量
        let mut batch_data: Vec<f32> = Vec::with_capacity(batch_size * 3 * image_size * image_size);
        for tensor in tensors {
            batch_data.extend(tensor);
        }

        // 创建批次输入 Tensor: [batch_size, 3, image_size, image_size]
        log::info!("Creating input tensor with shape [{}, 3, {}, {}]", batch_size, image_size, image_size);
        let input_shape: Vec<i64> = vec![batch_size as i64, 3, image_size as i64, image_size as i64];
        let input_tensor = Tensor::from_array((input_shape, batch_data.into_boxed_slice()))
            .map_err(|e| format!("Failed to create batch input tensor: {}", e))?;

        // 执行批量推理 - session.run 需要可变引用
        log::info!("Running ONNX inference...");
        let inference_start = std::time::Instant::now();
        let inputs: Vec<(&str, Tensor<f32>)> = vec![(self.model_spec.vision_input_name(), input_tensor)];
        let outputs = session.run(inputs)
            .map_err(|e| format!("Failed to run batch inference: {}", e))?;
        let inference_elapsed = inference_start.elapsed().as_millis();
        log::info!("ONNX inference completed in {}ms", inference_elapsed);

        // 提取嵌入向量
        let (shape, embeddings_data): (&ort::tensor::Shape, &[f32]) = outputs[self.model_spec.vision_output_name()]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract batch embeddings: {}", e))?;

        // 转换为 Vec<Vec<f32>> 并归一化
        let embedding_dim = self.model_spec.embedding_dim();
        let actual_batch_size = shape[0] as usize;
        let mut results = Vec::with_capacity(actual_batch_size);
        
        // 将扁平化的张量转换为每行一个向量的格式
        let flat_embeddings: Vec<f32> = embeddings_data.iter().copied().collect();
        for i in 0..actual_batch_size {
            let start = i * embedding_dim;
            let end = start + embedding_dim;
            if end <= flat_embeddings.len() {
                let mut vec = flat_embeddings[start..end].to_vec();
                normalize_vector(&mut vec);
                results.push(vec);
            }
        }

        Ok(results)
    }

    /// 获取嵌入维度
    pub fn embedding_dim(&self) -> usize {
        self.model_spec.embedding_dim()
    }

    /// 检查是否真正使用了 GPU 加速
    pub fn is_using_gpu(&self) -> bool {
        self.is_gpu_active
    }

    /// 获取模型名称
    pub fn model_name(&self) -> &str {
        self.model_spec.name()
    }
}

/// 向量归一化 (L2 归一化)
fn normalize_vector(vec: &mut [f32]) {
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    if norm > 0.0 {
        for x in vec.iter_mut() {
            *x /= norm;
        }
    }
}

/// 计算两个向量之间的余弦相似度
/// 注意：输入向量必须是归一化后的
pub fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    
    a.iter().zip(b.iter()).map(|(x, y)| x * y).sum()
}

/// 计算向量与查询向量的相似度并排序
pub fn rank_by_similarity(query: &[f32], candidates: &[(String, Vec<f32>)]) -> Vec<(String, f32)> {
    let mut results: Vec<(String, f32)> = candidates
        .iter()
        .map(|(id, embedding)| {
            let similarity = cosine_similarity(query, embedding);
            (id.clone(), similarity)
        })
        .collect();

    // 按相似度降序排序
    results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    results
}
