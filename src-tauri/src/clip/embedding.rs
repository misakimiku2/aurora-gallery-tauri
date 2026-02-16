//! CLIP 向量嵌入存储和管理

use std::path::PathBuf;
use std::collections::HashMap;
use rusqlite::{Connection, params};
use serde::{Serialize, Deserialize};

/// 图像嵌入数据
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageEmbedding {
    /// 文件 ID
    pub file_id: String,
    /// 嵌入向量 (512 或 768 维)
    pub embedding: Vec<f32>,
    /// 模型版本
    pub model_version: String,
    /// 创建时间戳
    pub created_at: i64,
}

/// 嵌入存储管理器
#[derive(Clone)]
pub struct EmbeddingStore {
    db_path: PathBuf,
}

impl EmbeddingStore {
    /// 创建新的嵌入存储
    pub fn new(cache_dir: &PathBuf) -> Result<Self, String> {
        let db_path = cache_dir.join("embeddings.db");
        
        // 确保数据库表存在
        let conn = Connection::open(&db_path)
            .map_err(|e| format!("Failed to open embedding database: {}", e))?;
        
        Self::init_tables(&conn)?;
        drop(conn);
        
        Ok(Self { db_path })
    }

    /// 初始化数据库表
    fn init_tables(conn: &Connection) -> Result<(), String> {
        // 创建嵌入表
        conn.execute(
            "CREATE TABLE IF NOT EXISTS image_embeddings (
                file_id TEXT PRIMARY KEY,
                embedding BLOB NOT NULL,
                model_version TEXT NOT NULL,
                created_at INTEGER NOT NULL
            )",
            [],
        ).map_err(|e| format!("Failed to create embeddings table: {}", e))?;

        // 创建索引
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_embeddings_model ON image_embeddings(model_version)",
            [],
        ).map_err(|e| format!("Failed to create index: {}", e))?;

        Ok(())
    }

    /// 获取数据库连接
    fn get_connection(&self) -> Result<Connection, String> {
        Connection::open(&self.db_path)
            .map_err(|e| format!("Failed to open database: {}", e))
    }

    /// 保存或更新嵌入
    pub fn save_embedding(&self, embedding: &ImageEmbedding) -> Result<(), String> {
        let conn = self.get_connection()?;
        
        // 将向量转换为字节
        let embedding_bytes = embedding_to_bytes(&embedding.embedding);
        
        conn.execute(
            "INSERT OR REPLACE INTO image_embeddings (file_id, embedding, model_version, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![
                &embedding.file_id,
                &embedding_bytes,
                &embedding.model_version,
                embedding.created_at
            ],
        ).map_err(|e| format!("Failed to save embedding: {}", e))?;

        Ok(())
    }

    /// 批量保存嵌入
    pub fn save_embeddings_batch(&self, embeddings: &[ImageEmbedding]) -> Result<(), String> {
        let mut conn = self.get_connection()?;
        let tx = conn.transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        for embedding in embeddings {
            let embedding_bytes = embedding_to_bytes(&embedding.embedding);
            tx.execute(
                "INSERT OR REPLACE INTO image_embeddings (file_id, embedding, model_version, created_at)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    &embedding.file_id,
                    &embedding_bytes,
                    &embedding.model_version,
                    embedding.created_at
                ],
            ).map_err(|e| format!("Failed to save embedding: {}", e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(())
    }

    /// 获取单个嵌入
    pub fn get_embedding(&self, file_id: &str) -> Result<Option<ImageEmbedding>, String> {
        let conn = self.get_connection()?;
        
        let mut stmt = conn.prepare(
            "SELECT file_id, embedding, model_version, created_at FROM image_embeddings WHERE file_id = ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let result = stmt.query_row(params![file_id], |row| {
            let embedding_bytes: Vec<u8> = row.get(1)?;
            let embedding = bytes_to_embedding(&embedding_bytes);
            
            Ok(ImageEmbedding {
                file_id: row.get(0)?,
                embedding,
                model_version: row.get(2)?,
                created_at: row.get(3)?,
            })
        });

        match result {
            Ok(embedding) => Ok(Some(embedding)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(format!("Failed to get embedding: {}", e)),
        }
    }

    /// 获取所有嵌入
    pub fn get_all_embeddings(&self) -> Result<Vec<ImageEmbedding>, String> {
        let conn = self.get_connection()?;
        
        let mut stmt = conn.prepare(
            "SELECT file_id, embedding, model_version, created_at FROM image_embeddings"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let embeddings = stmt.query_map([], |row| {
            let embedding_bytes: Vec<u8> = row.get(1)?;
            let embedding = bytes_to_embedding(&embedding_bytes);
            
            Ok(ImageEmbedding {
                file_id: row.get(0)?,
                embedding,
                model_version: row.get(2)?,
                created_at: row.get(3)?,
            })
        }).map_err(|e| format!("Failed to query embeddings: {}", e))?;

        embeddings.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect embeddings: {}", e))
    }

    /// 获取指定模型版本的所有嵌入
    pub fn get_embeddings_by_model(&self, model_version: &str) -> Result<Vec<ImageEmbedding>, String> {
        log::info!("[EmbeddingStore] Getting embeddings for model: '{}'", model_version);
        
        let conn = self.get_connection()?;
        
        let mut stmt = conn.prepare(
            "SELECT file_id, embedding, model_version, created_at FROM image_embeddings WHERE model_version = ?1"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let embeddings = stmt.query_map(params![model_version], |row| {
            let embedding_bytes: Vec<u8> = row.get(1)?;
            let embedding = bytes_to_embedding(&embedding_bytes);
            
            Ok(ImageEmbedding {
                file_id: row.get(0)?,
                embedding,
                model_version: row.get(2)?,
                created_at: row.get(3)?,
            })
        }).map_err(|e| format!("Failed to query embeddings: {}", e))?;

        let result = embeddings.collect::<Result<Vec<_>, _>>()
            .map_err(|e| format!("Failed to collect embeddings: {}", e))?;
        
        log::info!("[EmbeddingStore] Found {} embeddings for model '{}'", result.len(), model_version);
        Ok(result)
    }

    /// 删除嵌入
    pub fn delete_embedding(&self, file_id: &str) -> Result<(), String> {
        let conn = self.get_connection()?;
        
        conn.execute(
            "DELETE FROM image_embeddings WHERE file_id = ?1",
            params![file_id],
        ).map_err(|e| format!("Failed to delete embedding: {}", e))?;

        Ok(())
    }

    /// 批量删除嵌入
    pub fn delete_embeddings_batch(&self, file_ids: &[String]) -> Result<(), String> {
        let mut conn = self.get_connection()?;
        let tx = conn.transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;

        for file_id in file_ids {
            tx.execute(
                "DELETE FROM image_embeddings WHERE file_id = ?1",
                params![file_id],
            ).map_err(|e| format!("Failed to delete embedding: {}", e))?;
        }

        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        Ok(())
    }

    /// 检查嵌入是否存在
    pub fn has_embedding(&self, file_id: &str) -> Result<bool, String> {
        let conn = self.get_connection()?;
        
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM image_embeddings WHERE file_id = ?1",
            params![file_id],
            |row| row.get(0),
        ).map_err(|e| format!("Failed to check embedding: {}", e))?;
        
        // 调试日志：记录查询结果
        if count > 0 {
            log::debug!("has_embedding: file_id={} found in database", file_id);
        }

        Ok(count > 0)
    }

    /// 获取嵌入数量
    pub fn get_embedding_count(&self) -> Result<i64, String> {
        let conn = self.get_connection()?;
        
        let count: i64 = conn.query_row(
            "SELECT COUNT(*) FROM image_embeddings",
            [],
            |row| row.get(0),
        ).map_err(|e| format!("Failed to count embeddings: {}", e))?;

        Ok(count)
    }

    /// 获取缺少嵌入的文件 ID 列表
    pub fn get_missing_embeddings(&self, file_ids: &[String]) -> Result<Vec<String>, String> {
        let mut conn = self.get_connection()?;
        
        // 创建临时表来存储查询的文件 ID
        conn.execute("CREATE TEMPORARY TABLE IF NOT EXISTS temp_file_ids (file_id TEXT PRIMARY KEY)", [])
            .map_err(|e| format!("Failed to create temp table: {}", e))?;
        
        // 插入文件 ID
        let tx = conn.transaction()
            .map_err(|e| format!("Failed to start transaction: {}", e))?;
        
        for file_id in file_ids {
            tx.execute(
                "INSERT OR IGNORE INTO temp_file_ids (file_id) VALUES (?1)",
                params![file_id],
            ).map_err(|e| format!("Failed to insert temp file_id: {}", e))?;
        }
        tx.commit()
            .map_err(|e| format!("Failed to commit transaction: {}", e))?;

        // 查询缺少嵌入的文件
        let mut stmt = conn.prepare(
            "SELECT t.file_id FROM temp_file_ids t 
             LEFT JOIN image_embeddings e ON t.file_id = e.file_id 
             WHERE e.file_id IS NULL"
        ).map_err(|e| format!("Failed to prepare statement: {}", e))?;

        let missing: Vec<String> = stmt.query_map([], |row| {
            row.get(0)
        }).map_err(|e| format!("Failed to query missing embeddings: {}", e))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("Failed to collect results: {}", e))?;

        // 清理临时表
        conn.execute("DROP TABLE IF EXISTS temp_file_ids", [])
            .map_err(|e| format!("Failed to drop temp table: {}", e))?;

        Ok(missing)
    }

    /// 清理旧版本模型的嵌入
    pub fn cleanup_old_versions(&self, current_version: &str) -> Result<usize, String> {
        let conn = self.get_connection()?;
        
        let deleted = conn.execute(
            "DELETE FROM image_embeddings WHERE model_version != ?1",
            params![current_version],
        ).map_err(|e| format!("Failed to cleanup old versions: {}", e))?;

        Ok(deleted)
    }
}

/// 将浮点向量转换为字节数组
fn embedding_to_bytes(embedding: &[f32]) -> Vec<u8> {
    embedding.iter()
        .flat_map(|&f| f.to_le_bytes().to_vec())
        .collect()
}

/// 将字节数组转换为浮点向量
fn bytes_to_embedding(bytes: &[u8]) -> Vec<f32> {
    bytes.chunks_exact(4)
        .map(|chunk| {
            let mut arr = [0u8; 4];
            arr.copy_from_slice(chunk);
            f32::from_le_bytes(arr)
        })
        .collect()
}

/// 嵌入缓存（内存中）
pub struct EmbeddingCache {
    cache: HashMap<String, Vec<f32>>,
    max_size: usize,
}

impl EmbeddingCache {
    /// 创建新的缓存
    pub fn new(max_size: usize) -> Self {
        Self {
            cache: HashMap::new(),
            max_size,
        }
    }

    /// 获取缓存的嵌入
    pub fn get(&self, file_id: &str) -> Option<&Vec<f32>> {
        self.cache.get(file_id)
    }

    /// 设置缓存
    pub fn set(&mut self, file_id: String, embedding: Vec<f32>) {
        if self.cache.len() >= self.max_size {
            // 简单的 LRU：随机移除一个
            if let Some(key) = self.cache.keys().next().cloned() {
                self.cache.remove(&key);
            }
        }
        self.cache.insert(file_id, embedding);
    }

    /// 批量设置缓存
    pub fn set_batch(&mut self, embeddings: &[(String, Vec<f32>)]) {
        for (file_id, embedding) in embeddings {
            self.set(file_id.clone(), embedding.clone());
        }
    }

    /// 清除缓存
    pub fn clear(&mut self) {
        self.cache.clear();
    }

    /// 获取缓存大小
    pub fn len(&self) -> usize {
        self.cache.len()
    }

    /// 检查是否为空
    pub fn is_empty(&self) -> bool {
        self.cache.is_empty()
    }
}
