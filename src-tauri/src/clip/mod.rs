//! CLIP (Contrastive Language-Image Pre-training) 模块
//! 提供自然语言图片搜索和以图搜图功能

pub mod model;
pub mod preprocessor;
pub mod embedding;
pub mod search;

use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use once_cell::sync::OnceCell;

use model::ClipModel;
use embedding::EmbeddingStore;

/// 全局 CLIP 管理器实例
static CLIP_MANAGER: OnceCell<Arc<RwLock<ClipManager>>> = OnceCell::new();

/// CLIP 模型配置
#[derive(Debug, Clone)]
pub struct ClipConfig {
    /// 模型名称
    pub model_name: String,
    /// 模型缓存目录
    pub cache_dir: PathBuf,
    /// 是否使用 GPU
    pub use_gpu: bool,
    /// 向量维度 (ViT-B/32 = 512, ViT-L/14 = 768)
    pub embedding_dim: usize,
}

impl Default for ClipConfig {
    fn default() -> Self {
        Self {
            model_name: "ViT-B-32".to_string(),
            cache_dir: PathBuf::from(".aurora_cache/clip"),
            use_gpu: true,  // 默认启用 GPU 加速
            embedding_dim: 512,
        }
    }
}

/// CLIP 管理器
pub struct ClipManager {
    config: ClipConfig,
    pub model: Option<ClipModel>,
    embedding_store: Option<EmbeddingStore>,
    is_initialized: bool,
}

impl ClipManager {
    /// 创建新的 CLIP 管理器
    pub fn new(config: ClipConfig) -> Self {
        Self {
            config,
            model: None,
            embedding_store: None,
            is_initialized: false,
        }
    }

    /// 初始化 CLIP 管理器
    pub async fn initialize(&mut self) -> Result<(), String> {
        if self.is_initialized {
            return Ok(());
        }

        // 确保缓存目录存在
        tokio::fs::create_dir_all(&self.config.cache_dir)
            .await
            .map_err(|e| format!("Failed to create cache directory: {}", e))?;

        // 初始化嵌入存储
        let embedding_store = EmbeddingStore::new(&self.config.cache_dir)?;
        self.embedding_store = Some(embedding_store);

        self.is_initialized = true;
        Ok(())
    }

    /// 加载 CLIP 模型
    pub async fn load_model(&mut self) -> Result<(), String> {
        if self.model.is_some() {
            return Ok(());
        }

        let model = ClipModel::load(&self.config).await?;
        self.model = Some(model);
        
        log::info!("CLIP model loaded successfully: {}", self.config.model_name);
        Ok(())
    }

    /// 卸载 CLIP 模型（释放内存）
    pub fn unload_model(&mut self) {
        if self.model.is_some() {
            self.model = None;
            log::info!("CLIP model unloaded");
        }
    }

    /// 检查模型是否已加载
    pub fn is_model_loaded(&self) -> bool {
        self.model.is_some()
    }

    /// 获取模型引用
    pub fn model(&self) -> Option<&ClipModel> {
        self.model.as_ref()
    }

    /// 获取模型可变引用
    pub fn model_mut(&mut self) -> Option<&mut ClipModel> {
        self.model.as_mut()
    }

    /// 获取嵌入存储引用
    pub fn embedding_store(&self) -> Option<&EmbeddingStore> {
        self.embedding_store.as_ref()
    }

    /// 获取配置
    pub fn config(&self) -> &ClipConfig {
        &self.config
    }

    /// 更新配置
    /// 如果配置发生关键变化（如 use_gpu），且模型已加载，则自动重载模型
    pub async fn update_config(&mut self, use_gpu: bool) -> Result<(), String> {
        let changed = self.config.use_gpu != use_gpu;
        
        if changed {
            log::info!("CLIP config changed: use_gpu = {}", use_gpu);
            self.config.use_gpu = use_gpu;
            
            // 如果模型已经加载，则需要重载以应用新配置
            if self.is_model_loaded() {
                log::info!("Reloading CLIP model to apply new hardware acceleration settings...");
                self.unload_model();
                self.load_model().await?;
            }
        }
        
        Ok(())
    }
}

/// 获取全局 CLIP 管理器
pub async fn get_clip_manager() -> Option<Arc<RwLock<ClipManager>>> {
    CLIP_MANAGER.get().cloned()
}

/// 初始化全局 CLIP 管理器
pub async fn init_clip_manager(cache_root: PathBuf) -> Result<Arc<RwLock<ClipManager>>, String> {
    let config = ClipConfig {
        cache_dir: cache_root.join("clip"),
        ..Default::default()
    };

    let manager = Arc::new(RwLock::new(ClipManager::new(config)));
    
    // 初始化但不加载模型（按需加载）
    {
        let mut guard = manager.write().await;
        guard.initialize().await?;
    }

    CLIP_MANAGER
        .set(manager.clone())
        .map_err(|_| "CLIP manager already initialized")?;

    Ok(manager)
}

/// 检查 CLIP 是否可用
pub fn is_clip_available() -> bool {
    CLIP_MANAGER.get().is_some()
}
