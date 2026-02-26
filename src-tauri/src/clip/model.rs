//! CLIP 模型加载和推理
//! 支持 ONNX 格式的 CLIP 模型，使用 ONNX Runtime 进行 GPU 加速推理

use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, Instant};
use std::collections::HashMap;
use once_cell::sync::OnceCell;
use ort::session::Session;
use ort::value::Tensor;
use tauri::Emitter;
use reqwest::Client;
use sha2::{Sha256, Digest};

use super::ClipConfig;
use super::preprocessor::{ImagePreprocessor, TextPreprocessor};
use super::models::{ModelSpec, get_model_spec};

/// 嵌入中文标签翻译文件
const TAGS_CN_CSV: &str = include_str!("models/Tags-cn_2024_ver-1.0.csv");

/// 标签翻译器，将英文标签翻译为中文
pub struct TagTranslator {
    en_to_zh: HashMap<String, String>,
}

impl TagTranslator {
    pub fn load() -> Self {
        let mut en_to_zh = HashMap::new();
        
        let mut rdr = csv::Reader::from_reader(TAGS_CN_CSV.as_bytes());
        for result in rdr.records() {
            if let Ok(record) = result {
                if record.len() >= 5 {
                    // 将下划线替换为空格，与 LabelMapper 保持一致
                    let en_tag = record[1].replace('_', " ").trim().to_string();
                    let zh_tag = record[4].trim().to_string();
                    if !en_tag.is_empty() && !zh_tag.is_empty() {
                        en_to_zh.insert(en_tag, zh_tag);
                    }
                }
            }
        }
        
        log::info!("Loaded {} Chinese tag translations", en_to_zh.len());
        Self { en_to_zh }
    }
    
    pub fn translate(&self, tag: &str, language: &str) -> String {
        if language == "zh" {
            self.en_to_zh.get(tag).map(|s| s.clone()).unwrap_or_else(|| tag.to_string())
        } else {
            tag.to_string()
        }
    }
    
    pub fn translate_tags(&self, tags: &[(String, f32)], language: &str) -> Vec<(String, f32)> {
        if language == "zh" {
            tags.iter()
                .map(|(tag, prob)| (self.translate(tag, language), *prob))
                .collect()
        } else {
            tags.to_vec()
        }
    }
}

/// 全局标签翻译器
static TAG_TRANSLATOR: OnceCell<TagTranslator> = OnceCell::new();

/// 获取全局标签翻译器
pub fn get_tag_translator() -> &'static TagTranslator {
    TAG_TRANSLATOR.get_or_init(TagTranslator::load)
}

/// 推理结果，包含 Embedding 或标签
#[derive(Clone)]
pub struct InferenceResult {
    pub embedding: Vec<f32>,
    pub tags: Option<Vec<(String, f32)>>,
}

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
    vision_session: Option<Arc<std::sync::Mutex<Session>>>,
    text_session: Option<Arc<std::sync::Mutex<Session>>>,
    model_spec: Arc<dyn ModelSpec>,
    is_gpu_active: bool,
    label_mapper: Option<LabelMapper>,
}

/// 标签映射器，将索引转换为可读标签
struct LabelMapper {
    /// 标签列表（按索引排序）
    tags: Vec<String>,
}

impl LabelMapper {
    pub fn load(path: &std::path::Path) -> Result<Self, String> {
        let file = std::fs::File::open(path)
            .map_err(|e| format!("Failed to open tags file: {}", e))?;
        let mut rdr = csv::Reader::from_reader(file);
        
        let mut tags = Vec::new();
        // CSV 格式通常为: id,name,category,count
        for result in rdr.records() {
            let record = result.map_err(|e| format!("Failed to read tag record: {}", e))?;
            if record.len() >= 2 {
                // 将下划线替换为空格，如 "long_hair" -> "long hair"
                // 这样更符合自然语言搜索习惯，且 UI 展示更美观
                let tag_name = record[1].replace('_', " ").trim().to_string();
                tags.push(tag_name);
            }
        }
        
        log::info!("Loaded {} tags from {:?}", tags.len(), path);
        Ok(Self { tags })
    }

    pub fn map_probs(&self, probs: &[f32], threshold: f32) -> Vec<(String, f32)> {
        let mut results = Vec::new();
        for (i, &prob) in probs.iter().enumerate() {
            if prob >= threshold {
                if let Some(tag) = self.tags.get(i) {
                    results.push((tag.clone(), prob));
                }
            }
        }
        // 按概率降序排序
        results.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        results
    }
}

impl ClipModel {
    /// 获取模型专属缓存目录
    fn get_model_cache_dir(model_cache_dir: &PathBuf, model_name: &str) -> PathBuf {
        model_cache_dir.join(model_name)
    }

    /// 加载 CLIP 模型
    pub async fn load(config: &ClipConfig, app_handle: &tauri::AppHandle) -> Result<Self, String> {
        let model_spec = get_model_spec(&config.model_name)
            .ok_or_else(|| format!("Unsupported model: {}", config.model_name))?;

        // 获取模型专属缓存目录
        let model_cache_dir = Self::get_model_cache_dir(&config.model_cache_dir, model_spec.name());
        
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
            model_spec.image_tensor_format(),
        );
        let mut text_preprocessor = TextPreprocessor::new(model_spec.max_text_length());
        
        // 如果模型支持文本输入，加载 tokenizer
        if model_spec.max_text_length() > 0 {
            let tokenizer_path = downloaded_paths.get("tokenizer.json")
                .ok_or("tokenizer.json not found in model files, but required for text encoding")?;
            text_preprocessor.load_tokenizer(tokenizer_path)
                .map_err(|e| format!("Failed to load tokenizer: {}", e))?;
        }

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

        // 加载标签映射器（如果是 Tagger）
        let mut label_mapper = None;
        if model_spec.is_tagger() {
            if let Some(tags_file_name) = model_spec.tags_file() {
                if let Some(tags_path) = downloaded_paths.get(tags_file_name) {
                    label_mapper = Some(LabelMapper::load(tags_path)?);
                }
            }
        }

        Ok(Self {
            config: config.clone(),
            image_preprocessor,
            text_preprocessor,
            vision_session: Some(vision_session),
            text_session: Some(text_session),
            model_spec,
            is_gpu_active,
            label_mapper,
        })
    }

    /// 根据 ModelSpec 初始化 ONNX Runtime 会话
    fn init_sessions_from_spec(
        downloaded_paths: &std::collections::HashMap<String, PathBuf>,
        _model_spec: &dyn ModelSpec,
        use_gpu: bool,
    ) -> Result<(Arc<std::sync::Mutex<Session>>, Arc<std::sync::Mutex<Session>>, bool), Box<dyn std::error::Error>> {
        let mut actual_gpu_active = false;
        
        let builder = if use_gpu {
            #[cfg(target_os = "windows")]
            {
                log::info!("Attempting to enable DirectML Execution Provider...");
                let dml_provider = ort::execution_providers::DirectMLExecutionProvider::default()
                    .with_device_id(0);
                
                match Session::builder()?.with_execution_providers([dml_provider.build()]) {
                    Ok(b) => {
                        log::info!("DirectML Execution Provider enabled successfully!");
                        actual_gpu_active = true;
                        b
                    }
                    Err(e) => {
                        log::warn!("DirectML failed: {}, falling back to CPU...", e);
                        let cpu_threads = num_cpus::get();
                        log::info!("Configuring CPU session with {} threads", cpu_threads);
                        Session::builder()?
                            .with_intra_threads(cpu_threads)?
                    }
                }
            }
            
            #[cfg(not(target_os = "windows"))]
            {
                log::info!("GPU acceleration only supported on Windows (DirectML), using CPU");
                let cpu_threads = num_cpus::get();
                log::info!("Configuring CPU session with {} threads", cpu_threads);
                Session::builder()?
                    .with_intra_threads(cpu_threads)?
            }
        } else {
            let cpu_threads = num_cpus::get();
            log::info!("GPU acceleration disabled, using CPU with {} threads", cpu_threads);
            Session::builder()?
                .with_intra_threads(cpu_threads)?
        };

        // 检查是否使用单一模型文件（如 SigLIP 2）
        // 如果存在 model.onnx，则使用它同时作为 vision 和 text 模型
        if let Some(model_path) = downloaded_paths.get("model.onnx") {
            log::info!("Using unified model file: {:?}", model_path);
            // 对于单一模型文件，vision 和 text 优化为共享同一个 Session 实例（节省 VRAM）
            // 由于 Session::run 可能需要 &mut self，使用 Mutex 包装以满足共享可变性
            let unified_session = Arc::new(std::sync::Mutex::new(builder.commit_from_file(model_path)?));
            log::info!("Unified model loaded successfully (Session shared + Mutex protected)");
            
            // 获取锁以记录 IO 信息
            {
                let session = unified_session.lock().map_err(|e| format!("Failed to lock session: {}", e))?;
                log::info!("[CLIP Model] Unified Session Inputs: {:?}", session.inputs().iter().map(|i| i.name()).collect::<Vec<_>>());
                log::info!("[CLIP Model] Unified Session Outputs: {:?}", session.outputs().iter().map(|o| o.name()).collect::<Vec<_>>());
            }
            return Ok((unified_session.clone(), unified_session, actual_gpu_active));
        }

        // 使用分离的 vision_model.onnx 和 text_model.onnx（CLIP 模型）
        let vision_model_path = downloaded_paths.get("vision_model.onnx")
            .ok_or("vision_model.onnx not found in model files")?;
        let text_model_path = downloaded_paths.get("text_model.onnx")
            .ok_or("text_model.onnx not found in model files")?;

        let vision_session = Arc::new(std::sync::Mutex::new(builder.clone().commit_from_file(vision_model_path)?));
        log::info!("Vision model loaded: {:?}", vision_model_path);

        let text_session = Arc::new(std::sync::Mutex::new(builder.commit_from_file(text_model_path)?));
        log::info!("Text model loaded: {:?}", text_model_path);
        
        {
            let s_vision = vision_session.lock().map_err(|e| format!("Failed to lock vision session: {}", e))?;
            log::info!("[CLIP Model] Vision Session Inputs: {:?}", s_vision.inputs().iter().map(|i| i.name()).collect::<Vec<_>>());
            log::info!("[CLIP Model] Vision Session Outputs: {:?}", s_vision.outputs().iter().map(|o| o.name()).collect::<Vec<_>>());
            
            let s_text = text_session.lock().map_err(|e| format!("Failed to lock text session: {}", e))?;
            log::info!("[CLIP Model] Text Session Inputs: {:?}", s_text.inputs().iter().map(|i| i.name()).collect::<Vec<_>>());
            log::info!("[CLIP Model] Text Session Outputs: {:?}", s_text.outputs().iter().map(|o| o.name()).collect::<Vec<_>>());
        }
        
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
    pub fn check_local_model_files(model_cache_dir: &PathBuf, model_name: &str) -> Result<bool, String> {
        let model_spec = get_model_spec(model_name)
            .ok_or_else(|| format!("Unknown model: {}", model_name))?;
        
        // 使用模型专属子目录
        let model_dir = model_cache_dir.join(model_name);
        
        // 检查所有模型文件是否存在
        let model_files = model_spec.model_files();
        for model_file in model_files {
            let file_path = model_dir.join(&model_file.name);
            if !file_path.exists() {
                return Ok(false);
            }
        }
        
        Ok(true)
    }

    /// 编码图像 - 使用 ONNX Runtime GPU 推理
    pub fn encode_image(&mut self, image_path: &str) -> Result<InferenceResult, String> {
        // 检查文件是否存在
        if !std::path::Path::new(image_path).exists() {
            return Err(format!("Image file not found: {}", image_path));
        }

        // 获取会话锁
        let mut session_guard = self.vision_session.as_ref()
            .ok_or("Vision model not loaded")?
            .lock()
            .map_err(|e| format!("Failed to lock vision session: {}", e))?;
        let session = &mut *session_guard;

        // 预处理图像为 NCHW 格式张量
        let tensor_data = self.image_preprocessor.preprocess(image_path)
            .map_err(|e| format!("Failed to preprocess image: {}", e))?;

        // 创建输入 Tensor - 使用 (shape, data) 元组格式
        let image_size = self.model_spec.image_size();
        let input_shape: Vec<i64> = match self.model_spec.image_tensor_format() {
            crate::clip::models::ImageTensorFormat::Nchw => vec![1, 3, image_size as i64, image_size as i64],
            crate::clip::models::ImageTensorFormat::Nhwc => vec![1, image_size as i64, image_size as i64, 3],
        };
        let input_tensor = Tensor::from_array((input_shape, tensor_data.into_boxed_slice()))
            .map_err(|e| format!("Failed to create input tensor: {}", e))?;

        // 执行推理 - session.run 需要可变引用
        let requires_text = session.inputs().iter().any(|i| i.name() == self.model_spec.text_input_name());
        let outputs = if requires_text {
            // 统一模型（如 SigLIP2）需要同时提供视觉和文本输入。
            let dummy_text_len = self.model_spec.dummy_text_input_length();
            let text_shape = vec![1i64, dummy_text_len as i64];
            let text_data = vec![0i64; dummy_text_len]; // 全部用 0（padding token）填充
            let input_ids_tensor = ort::value::Tensor::from_array((text_shape, text_data.into_boxed_slice()))
                .map_err(|e| format!("Failed to create dummy input_ids tensor: {}", e))?;
                
            let inputs_dict = ort::inputs![
                self.model_spec.vision_input_name() => input_tensor,
                self.model_spec.text_input_name() => input_ids_tensor,
            ];
            
            session.run(inputs_dict)
                .map_err(|e| format!("Failed to run inference: {}", e))?
        } else {
            session.run(vec![(self.model_spec.vision_input_name(), input_tensor)])
                .map_err(|e| format!("Failed to run inference: {}", e))?
        };

        // 提取嵌入向量
        let output_node = self.model_spec.vision_output_name();
        
        // 诊断：记录所有输出节点
        let available_outputs: Vec<String> = outputs.keys().map(|k| k.to_string()).collect();
        log::info!("[CLIP Debug] Vision - Available output nodes: {:?}", available_outputs);
        log::info!("[CLIP Debug] Vision - Expected output node: {}", output_node);
        
        let (_shape, embedding_data): (&ort::tensor::Shape, &[f32]) = outputs.get(output_node)
            .ok_or_else(|| format!("Output node '{}' not found. Available: {:?}", output_node, outputs.keys().collect::<Vec<_>>()))?
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract embedding from '{}': {:?}", output_node, e))?;

        // 诊断：记录原始嵌入数据
        let raw_norm: f32 = embedding_data.iter().map(|x| x * x).sum::<f32>().sqrt();
        let raw_mean: f32 = embedding_data.iter().sum::<f32>() / embedding_data.len() as f32;
        log::info!("[CLIP Debug] Vision - Raw embedding: shape={:?}, norm={:.4}, mean={:.6}, first 5={:?}", 
            _shape, raw_norm, raw_mean, embedding_data.iter().take(5).collect::<Vec<_>>());

        // 转换为 Vec<f32> 并归一化
        let mut embedding: Vec<f32> = embedding_data.iter().copied().collect();
        normalize_vector(&mut embedding);

        // 如果是 Tagger，提取标签
        let mut tags = None;
        if self.model_spec.is_tagger() {
            if let Some(mapper) = &self.label_mapper {
                let tagger_node = self.model_spec.tagger_output_name();
                if let Some(tag_output) = outputs.get(tagger_node) {
                    let (_shape, prob_data): (&ort::tensor::Shape, &[f32]) = tag_output
                        .try_extract_tensor::<f32>()
                        .map_err(|e| format!("Failed to extract tags from '{}': {:?}", tagger_node, e))?;
                    
                    // 使用较低阈值返回更多标签，实际过滤在 save_tags_to_metadata 中进行
                    tags = Some(mapper.map_probs(prob_data, 0.1));
                }
            }
        }

        Ok(InferenceResult { embedding, tags })
    }

    /// 编码文本 - 使用 ONNX Runtime GPU 推理
    pub fn encode_text(&mut self, text: &str) -> Result<Vec<f32>, String> {
        // 验证文本不为空
        if text.trim().is_empty() {
            return Err("Empty text provided".to_string());
        }

        // 获取会话锁
        let mut session_guard = self.text_session.as_ref()
            .ok_or("Text model not loaded")?
            .lock()
            .map_err(|e| format!("Failed to lock text session: {}", e))?;
        let session = &mut *session_guard;

        // 预处理文本
        let (input_ids, _attention_mask) = self.text_preprocessor.preprocess(text)
            .map_err(|e| format!("Failed to preprocess text: {}", e))?;

        // 创建输入 Tensors - 使用 (shape, data) 元组格式
        let input_ids_shape: Vec<i64> = vec![1, input_ids.len() as i64];
        let input_ids_data: Vec<i64> = input_ids.into_iter().map(|x| x as i64).collect();
        let input_ids_tensor = Tensor::from_array((input_ids_shape, input_ids_data.into_boxed_slice()))
            .map_err(|e| format!("Failed to create input_ids tensor: {}", e))?;

        let attention_mask_shape: Vec<i64> = vec![1, _attention_mask.len() as i64];
        let attention_mask_data: Vec<i64> = _attention_mask.into_iter().map(|x| x as i64).collect();
        let attention_mask_tensor = Tensor::from_array((attention_mask_shape, attention_mask_data.into_boxed_slice()))
            .map_err(|e| format!("Failed to create attention_mask tensor: {}", e))?;

        // 执行推理 - session.run 需要可变引用
        let requires_vision = session.inputs().iter().any(|i| i.name() == self.model_spec.vision_input_name());
        let has_attention_mask = session.inputs().iter().any(|i| i.name() == "attention_mask");

        let outputs = if requires_vision {
            // 统一模型（如 SigLIP2）需要同时提供视觉和文本输入。
            // 虚拟 pixel_values 必须使用模型要求的正确尺寸！
            let (n, c, h, w) = self.model_spec.dummy_vision_input_shape()
                .unwrap_or((1, 3, self.model_spec.image_size(), self.model_spec.image_size()));
            
            let vision_shape: Vec<i64> = match self.model_spec.image_tensor_format() {
                crate::clip::models::ImageTensorFormat::Nchw => vec![n as i64, c as i64, h as i64, w as i64],
                crate::clip::models::ImageTensorFormat::Nhwc => vec![n as i64, h as i64, w as i64, c as i64],
            };
            
            let vision_data_size = n * c * h * w;
            let vision_data = vec![0.0f32; vision_data_size];
            log::debug!("[CLIP Debug] 为文本编码提供虚拟 pixel_values，形状: {:?}", vision_shape);
            let pixel_values_tensor = ort::value::Tensor::from_array((vision_shape, vision_data.into_boxed_slice()))
                .map_err(|e| format!("Failed to create dummy pixel_values tensor: {}", e))?;
                
            let mut inputs: Vec<(&str, ort::value::Value)> = vec![
                (self.model_spec.text_input_name(), input_ids_tensor.into()),
                (self.model_spec.vision_input_name(), pixel_values_tensor.into()),
            ];

            if has_attention_mask {
                inputs.push(("attention_mask", attention_mask_tensor.into()));
            }
            
            session.run(inputs)
                .map_err(|e| format!("Failed to run inference: {}", e))?
        } else {
            let mut inputs: Vec<(&str, ort::value::Value)> = vec![
                (self.model_spec.text_input_name(), input_ids_tensor.into()),
            ];
            
            if has_attention_mask {
                inputs.push(("attention_mask", attention_mask_tensor.into()));
            }

            session.run(inputs)
                .map_err(|e| format!("Failed to run inference: {}", e))?
        };

        // 提取嵌入向量
        // 诊断：记录实际可用的输出节点名称
        let available_outputs: Vec<String> = outputs.keys().map(|k| k.to_string()).collect();
        log::info!("[CLIP Debug] Text - Available output nodes: {:?}", available_outputs);
        log::info!("[CLIP Debug] Text - Expected text output node: {}", self.model_spec.text_output_name());
        
        let output_node = self.model_spec.text_output_name();
        let (_shape, embedding_data): (&ort::tensor::Shape, &[f32]) = outputs.get(output_node)
            .ok_or_else(|| format!("Text output node '{}' not found. Available: {:?}", output_node, outputs.keys().collect::<Vec<_>>()))?
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract embedding from '{}': {:?}. Available: {:?}", 
                output_node, e, available_outputs))?;

        // 转换为 Vec<f32> 并归一化
        let mut vec: Vec<f32> = embedding_data.iter().copied().collect();
        let raw_norm = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
        log::info!("[CLIP Debug] Text output shape: {:?}, raw norm: {:.4}, first 5: {:?}", _shape, raw_norm, vec.iter().take(5).collect::<Vec<_>>());
        
        normalize_vector(&mut vec);

        Ok(vec)
    }

    /// 批量编码图像 - 使用 GPU 批量推理，支持自动降级
    pub fn encode_images_batch(&mut self, image_paths: &[String]) -> Result<Vec<InferenceResult>, String> {
        log::info!("encode_images_batch called with {} images", image_paths.len());
        
        if image_paths.is_empty() {
            log::info!("Empty image_paths, returning empty result");
            return Ok(Vec::new());
        }

        // WD14 (Tagger) 模型在 DirectML 上批量推理不稳定，使用流水线串行处理
        // 但在 CPU 模式下可以使用批量推理
        if self.model_spec.is_tagger() && self.is_gpu_active {
            log::info!("Tagger model ({}) with GPU, using pipelined serial processing for DirectML compatibility", 
                self.model_spec.name());
            return self.encode_images_pipelined(image_paths);
        }

        // 对于小批量，使用串行处理
        if image_paths.len() <= 4 {
            log::info!("Small batch ({}), using serial processing", image_paths.len());
            let mut results = Vec::with_capacity(image_paths.len());
            for (i, path) in image_paths.iter().enumerate() {
                log::info!("Processing image {}/{}: {}", i + 1, image_paths.len(), path);
                results.push(self.encode_image(path)?);
            }
            return Ok(results);
        }

        // 大批量使用真正的批量推理，带自动降级机制
        log::info!("Large batch ({}), using batch processing with auto-fallback", image_paths.len());
        self.encode_images_batch_with_fallback(image_paths)
    }

    /// 流水线串行处理 - CPU预处理与GPU推理并行
    /// 在GPU推理当前图像时，CPU同时预处理下一张图像
    fn encode_images_pipelined(&mut self, image_paths: &[String]) -> Result<Vec<InferenceResult>, String> {
        use std::sync::mpsc;
        use std::thread;

        let total = image_paths.len();
        if total == 0 {
            return Ok(Vec::new());
        }

        log::info!("Pipelined processing: {} images", total);
        let start_time = std::time::Instant::now();

        // 创建通道：预处理线程 -> 推理线程
        // 使用 Option 来区分正常数据和结束信号
        let (tx, rx) = mpsc::sync_channel::<Result<(usize, String, Vec<f32>), String>>(2);

        // 预处理线程
        let preprocess_paths = image_paths.to_vec();
        let preprocessor = self.image_preprocessor.clone();
        let preprocess_handle = thread::spawn(move || {
            for (i, path) in preprocess_paths.iter().enumerate() {
                match preprocessor.preprocess(path) {
                    Ok(tensor) => {
                        if tx.send(Ok((i, path.clone(), tensor))).is_err() {
                            break;
                        }
                    }
                    Err(e) => {
                        log::error!("Failed to preprocess {}: {}", path, e);
                        let _ = tx.send(Err(format!("Preprocess failed for {}: {}", path, e)));
                        break;
                    }
                }
            }
        });

        // 主线程：GPU推理
        let mut results: Vec<Option<InferenceResult>> = vec![None; total];
        let mut processed = 0;
        let mut preprocess_error: Option<String> = None;

        // 获取会话锁（整个批次共用）
        let mut session_guard = self.vision_session.as_ref()
            .ok_or("Vision model not loaded")?
            .lock()
            .map_err(|e| format!("Failed to lock vision session: {}", e))?;
        let session = &mut *session_guard;

        let image_size = self.model_spec.image_size();
        let input_shape: Vec<i64> = match self.model_spec.image_tensor_format() {
            crate::clip::models::ImageTensorFormat::Nchw => vec![1, 3, image_size as i64, image_size as i64],
            crate::clip::models::ImageTensorFormat::Nhwc => vec![1, image_size as i64, image_size as i64, 3],
        };

        while let Ok(msg) = rx.recv() {
            match msg {
                Ok((idx, _path, tensor_data)) => {
                    // 创建输入 Tensor
                    let input_tensor = match Tensor::from_array((input_shape.clone(), tensor_data.into_boxed_slice())) {
                        Ok(t) => t,
                        Err(e) => {
                            log::error!("Failed to create input tensor: {}", e);
                            continue;
                        }
                    };

                    // 执行推理
                    let outputs = match session.run(vec![(self.model_spec.vision_input_name(), input_tensor)]) {
                        Ok(o) => o,
                        Err(e) => {
                            log::error!("Failed to run inference: {}", e);
                            continue;
                        }
                    };

                    // 提取嵌入向量
                    let output_node = self.model_spec.vision_output_name();
                    let embedding_data = match outputs.get(output_node) {
                        Some(output) => match output.try_extract_tensor::<f32>() {
                            Ok((_shape, data)) => data,
                            Err(e) => {
                                log::error!("Failed to extract embedding: {:?}", e);
                                continue;
                            }
                        },
                        None => {
                            log::error!("Output node '{}' not found", output_node);
                            continue;
                        }
                    };

                    let mut embedding: Vec<f32> = embedding_data.iter().copied().collect();
                    normalize_vector(&mut embedding);

                    // 提取标签
                    let mut tags = None;
                    if let Some(mapper) = &self.label_mapper {
                        let tagger_node = self.model_spec.tagger_output_name();
                        if let Some(tag_output) = outputs.get(tagger_node) {
                            if let Ok((_shape, prob_data)) = tag_output.try_extract_tensor::<f32>() {
                                // 使用较低阈值返回更多标签，实际过滤在 save_tags_to_metadata 中进行
                                tags = Some(mapper.map_probs(prob_data, 0.1));
                            }
                        }
                    }

                    results[idx] = Some(InferenceResult { embedding, tags });
                    processed += 1;

                    if processed % 8 == 0 || processed == total {
                        log::info!("Pipelined: {}/{} images processed", processed, total);
                    }
                }
                Err(e) => {
                    preprocess_error = Some(e);
                    break;
                }
            }
        }

        // 等待预处理线程结束
        let _ = preprocess_handle.join();

        let elapsed = start_time.elapsed().as_millis();
        let throughput = if elapsed > 0 { processed as f64 / elapsed as f64 * 1000.0 } else { 0.0 };
        log::info!("Pipelined processing completed: {}/{} images in {}ms ({:.1} files/sec)", 
            processed, total, elapsed, throughput);

        // 检查是否有预处理错误
        if let Some(e) = preprocess_error {
            return Err(e);
        }

        // 收集结果（过滤掉 None，保持原始顺序）
        let final_results: Vec<InferenceResult> = results.into_iter()
            .filter_map(|r| r)
            .collect();
        
        if final_results.len() != total {
            return Err(format!("Only {}/{} images were successfully processed", final_results.len(), total));
        }

        Ok(final_results)
    }

    /// 带自动降级的批量推理
    fn encode_images_batch_with_fallback(&mut self, image_paths: &[String]) -> Result<Vec<InferenceResult>, String> {
        let total_count = image_paths.len();
        let mut current_batch_size = total_count;
        let min_batch_size = 4;
        
        loop {
            log::info!("Attempting batch inference with batch_size={}", current_batch_size);
            
            match self.encode_images_batch_gpu(&image_paths[..current_batch_size]) {
                Ok(results) => {
                    if current_batch_size == total_count {
                        return Ok(results);
                    }
                    
                    log::info!("Batch {} succeeded, processing remaining {} images", 
                        current_batch_size, total_count - current_batch_size);
                    
                    let mut all_results = results;
                    let remaining = &image_paths[current_batch_size..];
                    
                    for path in remaining {
                        match self.encode_image(path) {
                            Ok(result) => all_results.push(result),
                            Err(e) => {
                                log::error!("Failed to encode image {}: {}", path, e);
                                return Err(e);
                            }
                        }
                    }
                    return Ok(all_results);
                }
                Err(e) => {
                    let is_layer_norm_error = e.contains("LayerNormalization") || 
                        e.contains("Non-zero status code");
                    
                    if is_layer_norm_error && current_batch_size > min_batch_size {
                        let new_batch_size = current_batch_size / 2;
                        log::warn!(
                            "LayerNormalization error at batch_size={}, auto-reducing to {}",
                            current_batch_size, new_batch_size
                        );
                        current_batch_size = new_batch_size;
                    } else if current_batch_size > min_batch_size {
                        log::warn!(
                            "Batch inference failed at batch_size={}, trying smaller batch: {}",
                            current_batch_size, e
                        );
                        current_batch_size = current_batch_size / 2;
                    } else {
                        log::warn!("Batch inference failed at min batch_size, falling back to serial processing: {}", e);
                        let mut results = Vec::with_capacity(total_count);
                        for path in image_paths {
                            results.push(self.encode_image(path)?);
                        }
                        return Ok(results);
                    }
                }
            }
        }
    }

    /// GPU 批量推理
    fn encode_images_batch_gpu(&mut self, image_paths: &[String]) -> Result<Vec<InferenceResult>, String> {
        log::info!("[CLIP Batch] GPU active: {}, model: {}, batch_size: {}", 
            self.is_gpu_active, self.model_spec.name(), image_paths.len());
        log::info!("encode_images_batch_gpu started: {} images", image_paths.len());
        
        // 获取会话锁
        let mut session_guard = self.vision_session.as_ref()
            .ok_or("Vision model not loaded")?
            .lock()
            .map_err(|e| format!("Failed to lock vision session: {}", e))?;
        let session = &mut *session_guard;

        let batch_size = image_paths.len();
        let image_size = self.model_spec.image_size();

        // 使用多线程批量预处理所有图像
        // CPU模式使用全部逻辑核心，GPU模式使用一半核心避免抢占资源
        let num_threads = if self.is_gpu_active {
            std::cmp::max(4, num_cpus::get() / 2)
        } else {
            num_cpus::get()
        };
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

        // 创建批次输入 Tensor
        let input_shape: Vec<i64> = match self.model_spec.image_tensor_format() {
            crate::clip::models::ImageTensorFormat::Nchw => vec![batch_size as i64, 3, image_size as i64, image_size as i64],
            crate::clip::models::ImageTensorFormat::Nhwc => vec![batch_size as i64, image_size as i64, image_size as i64, 3],
        };
        log::info!("Creating input tensor with shape {:?}", input_shape);
        let input_tensor = Tensor::from_array((input_shape, batch_data.into_boxed_slice()))
            .map_err(|e| format!("Failed to create batch input tensor: {}", e))?;

        // 执行批量推理 - session.run 需要可变引用
        log::info!("Running ONNX inference...");
        let inference_start = std::time::Instant::now();
        
        let requires_text = session.inputs().iter().any(|i| i.name() == self.model_spec.text_input_name());
        let outputs = if requires_text {
            // 统一模型（如 SigLIP2）需要同时提供视觉和文本输入。
            // 批量推理时 pixel_values 的 batch 是 N，文本 batch 固定为 1（ONNX 广播）。
            // 虚拟 input_ids 必须使用模型正常的文本长度（如 64），而不是 [1, 1]。
            let dummy_text_len = self.model_spec.dummy_text_input_length();
            log::info!("统一模型批量推理：提供虚拟 input_ids，形状 [1, {}]", dummy_text_len);
            let text_shape = vec![1i64, dummy_text_len as i64];
            let text_data = vec![0i64; dummy_text_len]; // 全部用 0（padding token）填充
            let input_ids_tensor = ort::value::Tensor::from_array((text_shape, text_data.into_boxed_slice()))
                .map_err(|e| format!("Failed to create dummy input_ids tensor: {}", e))?;
                
            let inputs_dict = ort::inputs![
                self.model_spec.vision_input_name() => input_tensor,
                self.model_spec.text_input_name() => input_ids_tensor,
            ];
            
            session.run(inputs_dict)
                .map_err(|e| format!("Failed to run batch inference: {}", e))?
        } else {
            let inputs: Vec<(&str, ort::value::Tensor<f32>)> = vec![(self.model_spec.vision_input_name(), input_tensor)];
            session.run(inputs)
                .map_err(|e| format!("Failed to run batch inference: {}", e))?
        };
        let inference_elapsed = inference_start.elapsed().as_millis();
        log::info!("ONNX inference completed in {}ms", inference_elapsed);

        // 提取嵌入向量
        let output_node = self.model_spec.vision_output_name();
        let (emb_shape, embeddings_data): (&ort::tensor::Shape, &[f32]) = outputs.get(output_node)
            .ok_or_else(|| format!("Batch vision output node '{}' not found. Available: {:?}", output_node, outputs.keys().collect::<Vec<_>>()))?
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("Failed to extract batch embeddings from '{}': {:?}", output_node, e))?;
 
        let embedding_dim = self.model_spec.embedding_dim();
        let actual_batch_size = if emb_shape.is_empty() {
             return Err(format!("Empty embedding shape for node '{}'", output_node));
        } else {
             emb_shape[0] as usize
        };

        // 如果是 Tagger，提取标签
        let mut all_tags: Option<Vec<Vec<(String, f32)>>> = None;
        if self.model_spec.is_tagger() {
            if let Some(mapper) = &self.label_mapper {
                let tagger_node = self.model_spec.tagger_output_name();
                if let Some(tag_output) = outputs.get(tagger_node) {
                    let (tag_shape, prob_data): (&ort::tensor::Shape, &[f32]) = tag_output
                        .try_extract_tensor::<f32>()
                        .map_err(|e| format!("Failed to extract batch tags: {:?}", e))?;
                    
                    let tag_count = tag_shape[1] as usize;
                    let mut batch_tags = Vec::with_capacity(actual_batch_size);
                    for i in 0..actual_batch_size {
                        let start = i * tag_count;
                        let end = start + tag_count;
                        if end <= prob_data.len() {
                            // 使用较低阈值返回更多标签，实际过滤在 save_tags_to_metadata 中进行
                            batch_tags.push(mapper.map_probs(&prob_data[start..end], 0.1));
                        }
                    }
                    all_tags = Some(batch_tags);
                }
            }
        }

        let mut results = Vec::with_capacity(actual_batch_size);
        let flat_embeddings: &[f32] = embeddings_data;
        for i in 0..actual_batch_size {
            let start = i * embedding_dim;
            let end = start + embedding_dim;
            if end <= flat_embeddings.len() {
                let mut embedding = flat_embeddings[start..end].to_vec();
                normalize_vector(&mut embedding);
                
                let tags = all_tags.as_ref().and_then(|t| t.get(i).cloned());
                results.push(InferenceResult { embedding, tags });
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

/// 计算 SigLIP 风格的相似度分数
/// SigLIP 使用 sigmoid loss，相似度 = sigmoid(dot_product * logit_scale + logit_bias)
/// logit_scale = exp(t_prime)，初始化 t_prime = log(1/0.07) ≈ 2.66，所以 logit_scale ≈ 14.3
/// logit_bias 初始化为 -10，用于平衡正负样本
pub fn siglip_similarity(a: &[f32], b: &[f32], logit_scale: f32, logit_bias: f32) -> f32 {
    if a.len() != b.len() {
        return 0.0;
    }
    
    // 计算点积（对于归一化向量，点积等于余弦相似度）
    let dot_product: f32 = a.iter().zip(b.iter()).map(|(x, y)| x * y).sum();
    
    // 应用 sigmoid 函数
    // logit = dot_product * logit_scale + logit_bias
    let logit = dot_product * logit_scale + logit_bias;
    1.0 / (1.0 + (-logit).exp())
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
