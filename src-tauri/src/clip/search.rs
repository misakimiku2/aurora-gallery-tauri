//! CLIP 向量搜索功能

use std::collections::BinaryHeap;
use std::cmp::Ordering;
use serde::{Serialize, Deserialize};

use super::embedding::{EmbeddingStore, ImageEmbedding};
use super::model::cosine_similarity;

/// 搜索结果项
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SearchResult {
    /// 文件 ID
    pub file_id: String,
    /// 相似度分数 (0.0 - 1.0)
    pub score: f32,
    /// 排名
    pub rank: usize,
}

/// 搜索查询类型
#[derive(Debug, Clone)]
pub enum SearchQuery {
    /// 文本查询
    Text(String),
    /// 图像查询（以图搜图）
    Image(String),
    /// 向量查询（直接使用嵌入向量）
    Embedding(Vec<f32>),
}

/// 搜索选项
#[derive(Debug, Clone)]
pub struct SearchOptions {
    /// 返回结果数量
    pub top_k: usize,
    /// 最小相似度阈值
    pub min_score: f32,
    /// 是否包含分数
    pub include_score: bool,
}

impl Default for SearchOptions {
    fn default() -> Self {
        Self {
            top_k: 50,
            min_score: 0.0,
            include_score: true,
        }
    }
}

/// 相似度搜索器
pub struct SimilaritySearcher {
    embedding_store: EmbeddingStore,
}

impl SimilaritySearcher {
    /// 创建新的搜索器
    pub fn new(embedding_store: EmbeddingStore) -> Self {
        Self { embedding_store }
    }

    /// 搜索相似图片
    pub fn search(
        &self,
        query_embedding: &[f32],
        options: &SearchOptions,
        model_version: Option<&str>,
    ) -> Result<Vec<SearchResult>, String> {
        log::info!("[Search] Searching with model_version: {:?}", model_version);
        
        let embeddings = if let Some(model) = model_version {
            let result = self.embedding_store.get_embeddings_by_model(model)?;
            log::info!("[Search] Found {} embeddings for model '{}'", result.len(), model);
            
            if result.is_empty() {
                let all = self.embedding_store.get_all_embeddings()?;
                if !all.is_empty() {
                    let available_models: std::collections::HashSet<String> = all
                        .iter()
                        .map(|e| e.model_version.clone())
                        .collect();
                    log::warn!(
                        "[Search] No embeddings found for model '{}'. Available models: {:?}",
                        model,
                        available_models
                    );
                }
            }
            result
        } else {
            let result = self.embedding_store.get_all_embeddings()?;
            log::info!("[Search] Found {} total embeddings", result.len());
            result
        };
        
        log::info!("[Search] Query embedding dimension: {}", query_embedding.len());
        
        if !embeddings.is_empty() {
            log::info!("[Search] First embedding dimension: {}", embeddings[0].embedding.len());
        }
        
        let results = self.search_in_candidates(query_embedding, &embeddings, options);
        log::info!("[Search] search_in_candidates returned {} results", results.len());
        
        Ok(results)
    }

    /// 在候选集中搜索
    pub fn search_in_candidates(
        &self,
        query_embedding: &[f32],
        candidates: &[ImageEmbedding],
        options: &SearchOptions,
    ) -> Vec<SearchResult> {
        // 使用优先队列找到 top-k
        let mut heap: BinaryHeap<SearchItem> = BinaryHeap::new();

        for candidate in candidates {
            let score = cosine_similarity(query_embedding, &candidate.embedding);
            
            // 过滤低相似度结果
            if score < options.min_score {
                continue;
            }

            let item = SearchItem {
                file_id: candidate.file_id.clone(),
                score,
            };

            if heap.len() < options.top_k {
                heap.push(item);
            } else if let Some(worst) = heap.peek() {
                if score > worst.score {
                    heap.pop();
                    heap.push(item);
                }
            }
        }

        // 转换为结果列表并排序
        let mut results: Vec<SearchResult> = heap
            .into_sorted_vec()
            .into_iter()
            .enumerate()
            .map(|(rank, item)| SearchResult {
                file_id: item.file_id,
                score: item.score,
                rank: rank + 1,
            })
            .collect();

        // 按分数降序排序
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
        
        // 更新排名
        for (i, result) in results.iter_mut().enumerate() {
            result.rank = i + 1;
        }

        results
    }

    /// 批量搜索（多个查询）
    pub fn search_batch(
        &self,
        query_embeddings: &[(String, Vec<f32>)],
        options: &SearchOptions,
    ) -> Result<Vec<(String, Vec<SearchResult>)>, String> {
        let embeddings = self.embedding_store.get_all_embeddings()?;
        
        let results: Vec<(String, Vec<SearchResult>)> = query_embeddings
            .iter()
            .map(|(id, embedding)| {
                let search_results = self.search_in_candidates(embedding, &embeddings, options);
                (id.clone(), search_results)
            })
            .collect();

        Ok(results)
    }

    /// 搜索相似图片（排除自身）
    pub fn search_similar_exclude_self(
        &self,
        file_id: &str,
        options: &SearchOptions,
    ) -> Result<Vec<SearchResult>, String> {
        // 获取查询图片的嵌入
        let query_embedding = self.embedding_store.get_embedding(file_id)?
            .ok_or_else(|| format!("Embedding not found for file: {}", file_id))?;

        // 获取所有其他嵌入
        let all_embeddings = self.embedding_store.get_all_embeddings()?;
        let candidates: Vec<ImageEmbedding> = all_embeddings
            .into_iter()
            .filter(|e| e.file_id != file_id)
            .collect();

        // 执行搜索
        let results = self.search_in_candidates(&query_embedding.embedding, &candidates, options);

        Ok(results)
    }

    /// 获取嵌入存储
    pub fn embedding_store(&self) -> &EmbeddingStore {
        &self.embedding_store
    }
}

/// 搜索项（用于优先队列）
#[derive(Debug, Clone)]
struct SearchItem {
    file_id: String,
    score: f32,
}

impl Eq for SearchItem {}

impl PartialEq for SearchItem {
    fn eq(&self, other: &Self) -> bool {
        self.score == other.score
    }
}

impl Ord for SearchItem {
    fn cmp(&self, other: &Self) -> Ordering {
        // 最小堆（分数低的在顶部，方便移除）
        self.score.partial_cmp(&other.score)
            .unwrap_or(Ordering::Equal)
            .reverse()
    }
}

impl PartialOrd for SearchItem {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

/// 向量索引（用于大规模数据集）
pub struct VectorIndex {
    /// 向量维度
    dim: usize,
    /// 索引数据
    vectors: Vec<(String, Vec<f32>)>,
}

impl VectorIndex {
    /// 创建新的向量索引
    pub fn new(dim: usize) -> Self {
        Self {
            dim,
            vectors: Vec::new(),
        }
    }

    /// 从嵌入存储构建索引
    pub fn from_embeddings(embeddings: &[ImageEmbedding]) -> Self {
        if embeddings.is_empty() {
            return Self::new(512);
        }

        let dim = embeddings[0].embedding.len();
        let vectors: Vec<(String, Vec<f32>)> = embeddings
            .iter()
            .map(|e| (e.file_id.clone(), e.embedding.clone()))
            .collect();

        Self { dim, vectors }
    }

    /// 添加向量
    pub fn add(&mut self, file_id: String, vector: Vec<f32>) {
        self.vectors.push((file_id, vector));
    }

    /// 批量添加向量
    pub fn add_batch(&mut self, items: &[(String, Vec<f32>)]) {
        for (file_id, vector) in items {
            self.vectors.push((file_id.clone(), vector.clone()));
        }
    }

    /// 搜索最近邻
    pub fn search(&self, query: &[f32], top_k: usize) -> Vec<SearchResult> {
        let mut results: Vec<SearchResult> = self.vectors
            .iter()
            .map(|(file_id, vector)| {
                let score = cosine_similarity(query, vector);
                SearchResult {
                    file_id: file_id.clone(),
                    score,
                    rank: 0,
                }
            })
            .collect();

        // 按分数排序
        results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));

        // 截取 top-k
        results.truncate(top_k);

        // 更新排名
        for (i, result) in results.iter_mut().enumerate() {
            result.rank = i + 1;
        }

        results
    }

    /// 获取向量数量
    pub fn len(&self) -> usize {
        self.vectors.len()
    }

    /// 检查是否为空
    pub fn is_empty(&self) -> bool {
        self.vectors.is_empty()
    }

    /// 清空索引
    pub fn clear(&mut self) {
        self.vectors.clear();
    }
}

/// 混合搜索（结合多种搜索方式）
pub struct HybridSearcher {
    clip_searcher: SimilaritySearcher,
}

impl HybridSearcher {
    /// 创建新的混合搜索器
    pub fn new(clip_searcher: SimilaritySearcher) -> Self {
        Self { clip_searcher }
    }

    /// 执行混合搜索
    /// 
    /// 目前支持：
    /// - CLIP 语义搜索
    /// - 未来可扩展：颜色搜索、标签搜索等
    pub fn search(
        &self,
        query_embedding: &[f32],
        options: &SearchOptions,
        model_version: Option<&str>,
    ) -> Result<Vec<SearchResult>, String> {
        self.clip_searcher.search(query_embedding, options, model_version)
    }

    /// 加权混合搜索结果
    pub fn merge_results(
        results_list: &[Vec<SearchResult>],
        weights: &[f32],
        top_k: usize,
    ) -> Vec<SearchResult> {
        use std::collections::HashMap;

        let mut merged: HashMap<String, f32> = HashMap::new();

        // 加权累加分数
        for (results, weight) in results_list.iter().zip(weights.iter()) {
            for result in results {
                let score = merged.entry(result.file_id.clone()).or_insert(0.0);
                *score += result.score * weight;
            }
        }

        // 转换为结果列表
        let mut final_results: Vec<SearchResult> = merged
            .into_iter()
            .map(|(file_id, score)| SearchResult {
                file_id,
                score,
                rank: 0,
            })
            .collect();

        // 排序并截取
        final_results.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
        final_results.truncate(top_k);

        // 更新排名
        for (i, result) in final_results.iter_mut().enumerate() {
            result.rank = i + 1;
        }

        final_results
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cosine_similarity() {
        let a = vec![1.0, 0.0, 0.0];
        let b = vec![1.0, 0.0, 0.0];
        assert!((cosine_similarity(&a, &b) - 1.0).abs() < 1e-6);

        let c = vec![0.0, 1.0, 0.0];
        assert!((cosine_similarity(&a, &c)).abs() < 1e-6);
    }

    #[test]
    fn test_vector_index() {
        let mut index = VectorIndex::new(3);
        
        index.add("file1".to_string(), vec![1.0, 0.0, 0.0]);
        add.add("file2".to_string(), vec![0.0, 1.0, 0.0]);
        add.add("file3".to_string(), vec![0.0, 0.0, 1.0]);

        let results = index.search(&[1.0, 0.0, 0.0], 2);
        
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].file_id, "file1");
        assert!(results[0].score > 0.99);
    }
}
