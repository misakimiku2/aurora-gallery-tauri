import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { isTauriEnvironment, detectTauriEnvironmentAsync } from '../../utils/environment';

/**
 * 代理 HTTP 请求（用于绕过 CORS）
 * @param url 请求 URL
 * @param method HTTP 方法
 * @param headers 请求头
 * @param body 请求体
 * @returns 响应文本
 */
export const proxyHttpRequest = async (
  url: string,
  method: string = 'GET',
  headers: Record<string, string> = {},
  body?: string
): Promise<string> => {
  if (!isTauriEnvironment()) {
    throw new Error('Proxy HTTP request is only available in Tauri environment');
  }
  try {
    const result = await invoke<string>('proxy_http_request', {
      url,
      method,
      headers,
      body
    });
    return result;
  } catch (error) {
    console.error('Proxy HTTP request failed:', error);
    throw error;
  }
};

// ==================== CLIP 相关 API ====================

import { ClipSearchResult, ClipSearchOptions, ClipStats } from '../../types';

/**
 * 使用自然语言文本搜索图片
 * @param text 搜索文本
 * @param options 搜索选项
 * @returns 搜索结果列表
 */
export const clipSearchByText = async (
  text: string,
  options?: ClipSearchOptions,
  modelName?: string
): Promise<ClipSearchResult[]> => {
  if (!isTauriEnvironment()) {
    throw new Error('CLIP search is only available in Tauri environment');
  }
  try {
    const results = await invoke<ClipSearchResult[]>('clip_search_by_text', {
      text,
      topK: options?.top_k ?? 50,
      minScore: options?.min_score ?? 0.0,
      modelName,
    });
    return results;
  } catch (error) {
    console.error('CLIP text search failed:', error);
    throw error;
  }
};

/**
 * 使用图片搜索相似图片（以图搜图）
 * @param imagePath 图片路径
 * @param options 搜索选项
 * @returns 搜索结果列表
 */
export const clipSearchByImage = async (
  imagePath: string,
  options?: ClipSearchOptions,
  modelName?: string
): Promise<ClipSearchResult[]> => {
  if (!isTauriEnvironment()) {
    throw new Error('CLIP search is only available in Tauri environment');
  }
  try {
    const results = await invoke<ClipSearchResult[]>('clip_search_by_image', {
      imagePath,
      topK: options?.top_k ?? 50,
      minScore: options?.min_score ?? 0.0,
      modelName,
    });
    return results;
  } catch (error) {
    console.error('CLIP image search failed:', error);
    throw error;
  }
};

/**
 * 为指定图片生成 CLIP 嵌入向量
 * @param filePath 图片路径
 * @param fileId 文件 ID（可选）
 * @param autoAddTags 是否自动添加标签（WD14 模型）
 * @param tagThreshold 标签置信度阈值（WD14 模型）
 * @param language 标签语言（'zh' 或 'en'）
 * @returns 嵌入向量
 */
export const clipGenerateEmbedding = async (
  filePath: string,
  fileId?: string,
  autoAddTags?: boolean,
  tagThreshold?: number,
  language?: string
): Promise<number[]> => {
  if (!isTauriEnvironment()) {
    throw new Error('CLIP embedding is only available in Tauri environment');
  }
  try {
    const embedding = await invoke<number[]>('clip_generate_embedding', {
      filePath,
      fileId,
      autoAddTags,
      tagThreshold,
      language,
    });
    return embedding;
  } catch (error) {
    console.error('CLIP embedding generation failed:', error);
    throw error;
  }
};

/**
 * 获取指定文件的 CLIP 嵌入状态
 * @param fileId 文件 ID
 * @returns 是否已有嵌入
 */
export const clipGetEmbeddingStatus = async (fileId: string): Promise<boolean> => {
  if (!isTauriEnvironment()) {
    return false;
  }
  try {
    const hasEmbedding = await invoke<boolean>('clip_get_embedding_status', {
      fileId,
    });
    return hasEmbedding;
  } catch (error) {
    console.error('Failed to get CLIP embedding status:', error);
    return false;
  }
};

/**
 * 加载 CLIP 模型
 * @param modelName 模型名称 (SigLIP2-Base, SigLIP2-So400M, WD-EVA02-Large-Tagger-V3)
 */
export const clipLoadModel = async (modelName: string): Promise<void> => {
  if (!isTauriEnvironment()) {
    throw new Error('CLIP is only available in Tauri environment');
  }
  try {
    await invoke('clip_load_model', { modelName });
  } catch (error) {
    console.error('Failed to load CLIP model:', error);
    throw error;
  }
};

/**
 * 取消当前正在进行的模型下载
 */
export const clipCancelModelDownload = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('clip_cancel_model_download');
  } catch (error) {
    console.error('Failed to cancel model download:', error);
  }
};

/**
 * 暂停当前正在进行的模型下载（断点续传，保留已下载部分）
 */
export const clipPauseModelDownload = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('clip_pause_model_download');
  } catch (error) {
    console.error('Failed to pause model download:', error);
    throw error;
  }
};

/**
 * 继续已暂停的模型下载（基于 HTTP Range 断点续传）
 */
export const clipResumeModelDownload = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('clip_resume_model_download');
  } catch (error) {
    console.error('Failed to resume model download:', error);
    throw error;
  }
};

/**
 * 更新 CLIP 配置（如 GPU 加速）
 * @param useGpu 是否启用 GPU 加速
 */
export const clipUpdateConfig = async (useGpu: boolean): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('clip_update_config', { useGpu });
  } catch (error) {
    console.error('Failed to update CLIP config:', error);
    throw error;
  }
};

/**
 * 卸载 CLIP 模型（释放内存）
 */
export const clipUnloadModel = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('clip_unload_model');
  } catch (error) {
    console.error('Failed to unload CLIP model:', error);
  }
};

/**
 * 检查 CLIP 模型是否已加载
 * @returns 是否已加载
 */
export const clipIsModelLoaded = async (): Promise<boolean> => {
  if (!isTauriEnvironment()) {
    return false;
  }
  try {
    const isLoaded = await invoke<boolean>('clip_is_model_loaded');
    return isLoaded;
  } catch (error) {
    console.error('Failed to check CLIP model status:', error);
    return false;
  }
};

/**
 * 获取 CLIP 嵌入向量数量
 * @returns 嵌入向量总数
 */
export const clipGetEmbeddingCount = async (): Promise<number> => {
  if (!isTauriEnvironment()) {
    return 0;
  }
  try {
    const count = await invoke<number>('clip_get_embedding_count');
    return count;
  } catch (error) {
    console.error('Failed to get CLIP embedding count:', error);
    return 0;
  }
};

/**
 * 获取指定模型的嵌入向量数量
 * @param modelName 模型名称
 * @returns 该模型的嵌入向量数量
 */
export const clipGetEmbeddingCountByModel = async (modelName: string): Promise<number> => {
  if (!isTauriEnvironment()) {
    return 0;
  }
  try {
    const count = await invoke<number>('clip_get_embedding_count_by_model', { modelName });
    return count;
  } catch (error) {
    console.error('Failed to get CLIP embedding count by model:', error);
    return 0;
  }
};

/**
 * 获取所有模型版本及其嵌入数量
 * @returns 模型版本和嵌入数量的列表
 */
export const clipGetModelVersions = async (): Promise<Array<[string, number]>> => {
  if (!isTauriEnvironment()) {
    return [];
  }
  try {
    const versions = await invoke<Array<[string, number]>>('clip_get_model_versions');
    return versions;
  } catch (error) {
    console.error('Failed to get model versions:', error);
    return [];
  }
};

/**
 * 嵌入向量统计信息
 */
export interface ClipEmbeddingStats {
  total_count: number;
  model_name: string;
  root_path: string;
}

/**
 * 获取嵌入向量统计信息（包括根目录路径）
 * @returns 嵌入向量统计信息
 */
export const clipGetEmbeddingStats = async (): Promise<ClipEmbeddingStats> => {
  if (!isTauriEnvironment()) {
    return {
      total_count: 0,
      model_name: '',
      root_path: '',
    };
  }
  try {
    const stats = await invoke<ClipEmbeddingStats>('clip_get_embedding_stats');
    return stats;
  } catch (error) {
    console.error('Failed to get embedding stats:', error);
    return {
      total_count: 0,
      model_name: '',
      root_path: '',
    };
  }
};

/**
 * 获取 CLIP 统计信息
 * @returns CLIP 统计信息
 */
export const clipGetStats = async (): Promise<ClipStats> => {
  if (!isTauriEnvironment()) {
    return {
      embedding_count: 0,
      is_model_loaded: false,
    };
  }
  try {
    const [count, isLoaded] = await Promise.all([
      clipGetEmbeddingCount(),
      clipIsModelLoaded(),
    ]);
    return {
      embedding_count: count,
      is_model_loaded: isLoaded,
    };
  } catch (error) {
    console.error('Failed to get CLIP stats:', error);
    return {
      embedding_count: 0,
      is_model_loaded: false,
    };
  }
};

// ==================== CLIP 模型管理 API ====================

export interface ClipModelStatus {
  model_name: string;
  is_downloaded: boolean;
  is_gpu_active: boolean;
  embedding_dim: number;
  image_size: number;
  downloaded_size: number;
  files: {
    image_encoder: boolean;
    text_encoder: boolean;
    tokenizer: boolean;
  };
}

/**
 * 获取 CLIP 模型下载状态
 * @param modelName 模型名称
 * @returns 模型状态
 */
export const clipGetModelStatus = async (modelName: string): Promise<ClipModelStatus> => {
  if (!isTauriEnvironment()) {
    return {
      model_name: modelName,
      is_downloaded: false,
      is_gpu_active: false,
      embedding_dim: 512,
      image_size: 224,
      downloaded_size: 0,
      files: {
        image_encoder: false,
        text_encoder: false,
        tokenizer: false,
      },
    };
  }
  try {
    const status = await invoke<ClipModelStatus>('clip_get_model_status', {
      modelName,
    });
    return status;
  } catch (error) {
    console.error('Failed to get CLIP model status:', error);
    throw error;
  }
};

/**
 * 删除 CLIP 模型文件
 * @param modelName 模型名称
 */
export const clipDeleteModel = async (modelName: string): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke('clip_delete_model', {
      modelName,
    });
  } catch (error) {
    console.error('Failed to delete CLIP model:', error);
    throw error;
  }
};

export interface ClipBatchEmbeddingResult {
  total: number;
  success: number;
  failed: number;
  failed_files: string[];
}

/**
 * 批量生成图片的 CLIP 嵌入向量
 * @param files 文件列表，每个元素为 [file_path, file_id] 元组
 * @param useGpu 是否启用 GPU 加速
 * @param modelName 模型名称
 * @param autoAddTags 是否自动添加标签（WD14 模型）
 * @param tagThreshold 标签置信度阈值（WD14 模型）
 * @param language 标签语言（'zh' 或 'en'）
 * @returns 处理结果
 */
export const clipGenerateEmbeddingsBatch = async (
  files: [string, string][],
  useGpu: boolean,
  modelName?: string,
  autoAddTags?: boolean,
  tagThreshold?: number,
  language?: string
): Promise<ClipBatchEmbeddingResult> => {
  if (!isTauriEnvironment()) {
    return {
      total: files.length,
      success: 0,
      failed: files.length,
      failed_files: files.map(f => f[0]),
    };
  }
  try {
    const result = await invoke<ClipBatchEmbeddingResult>('clip_generate_embeddings_batch', {
      filePaths: files,
      useGpu,
      modelName,
      autoAddTags,
      tagThreshold,
      language,
    });
    return result;
  } catch (error) {
    console.error('Failed to generate embeddings batch:', error);
    throw error;
  }
};

/**
 * 获取所有图片文件（从数据库查询）
 * 用于 CLIP 嵌入向量生成
 * @returns 图片文件列表，每个文件包含 id, path, name, format
 */
export const getAllImageFiles = async (): Promise<{ id: string; path: string; name: string; format?: string }[]> => {
  // 确保在 Tauri 环境中运行
  const isTauri = await detectTauriEnvironmentAsync();
  if (!isTauri) {
    console.warn('getAllImageFiles: Not in Tauri environment');
    throw new Error('此功能需要在 Tauri 应用环境中运行');
  }
  try {
    const result = await invoke<{ id: string; path: string; name: string; format?: string }[]>('get_all_image_files');
    return result;
  } catch (error) {
    console.error('Failed to get all image files:', error);
    throw error;
  }
};

/**
 * 从已有的嵌入向量生成标签（仅 WD14 模型）
 * @param modelName 模型名称
 * @param threshold 标签置信度阈值
 * @param language 标签语言（'zh' 或 'en'）
 * @returns 处理结果
 */
export const clipGenerateTagsFromEmbeddings = async (
  modelName?: string,
  threshold?: number,
  language?: string
): Promise<{ total: number; success: number; skipped: number }> => {
  if (!isTauriEnvironment()) {
    return { total: 0, success: 0, skipped: 0 };
  }
  try {
    const result = await invoke<{ total: number; success: number; skipped: number }>(
      'clip_generate_tags_from_embeddings',
      {
        modelName,
        threshold: threshold ?? 0.35,
        language,
      }
    );
    return result;
  } catch (error) {
    console.error('Failed to generate tags from embeddings:', error);
    throw error;
  }
};

/**
 * 预览从嵌入向量生成的标签（不保存）
 * @param modelName 模型名称
 * @param threshold 标签置信度阈值
 * @param language 标签语言（'zh' 或 'en'）
 * @returns 预览结果
 */
export const clipPreviewTagsFromEmbeddings = async (
  modelName?: string,
  threshold?: number,
  language?: string
): Promise<{ tags: { name: string; name_cn: string; count: number; sample_file_ids: string[] }[]; total_files: number; files_with_tags: number }> => {
  if (!isTauriEnvironment()) {
    return { tags: [], total_files: 0, files_with_tags: 0 };
  }
  try {
    const result = await invoke<{ tags: { name: string; name_cn: string; count: number; sample_file_ids: string[] }[]; total_files: number; files_with_tags: number }>(
      'clip_preview_tags_from_embeddings',
      {
        modelName,
        threshold: threshold ?? 0.35,
        language,
      }
    );
    return result;
  } catch (error) {
    console.error('Failed to preview tags from embeddings:', error);
    throw error;
  }
};

/**
 * 取消 CLIP 嵌入向量生成
 */
export const clipCancelEmbeddingGeneration = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke<void>('clip_cancel_embedding_generation');
  } catch (error) {
    console.error('Failed to cancel embedding generation:', error);
    throw error;
  }
};

/**
 * 暂停 CLIP 嵌入向量生成
 */
export const clipPauseEmbeddingGeneration = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke<void>('clip_pause_embedding_generation');
  } catch (error) {
    console.error('Failed to pause embedding generation:', error);
    throw error;
  }
};

/**
 * 继续 CLIP 嵌入向量生成
 */
export const clipResumeEmbeddingGeneration = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke<void>('clip_resume_embedding_generation');
  } catch (error) {
    console.error('Failed to resume embedding generation:', error);
    throw error;
  }
};

/**
 * 监听 CLIP 嵌入向量生成进度事件
 * @param callback 进度回调函数
 * @returns 取消监听的函数
 */
export const listenClipEmbeddingProgress = (callback: (data: {
  current: number;
  total: number;
  progress: number;
  success: number;
  failed: number;
  skipped?: number;
  processed?: number;
  timestamp?: number; // 已用时间（毫秒），用于计算预估时间
}) => void): Promise<() => void> => {
  return listen('clip-embedding-progress', (event: any) => {
    callback(event.payload);
  });
};

/**
 * 监听 CLIP 嵌入向量生成完成事件
 * @param callback 完成回调函数
 * @returns 取消监听的函数
 */
export const listenClipEmbeddingCompleted = (callback: (data: {
  total: number;
  success: number;
  failed: number;
  cancelled: boolean;
}) => void): Promise<() => void> => {
  return listen('clip-embedding-completed', (event: any) => {
    callback(event.payload);
  });
};

/**
 * 监听 CLIP 嵌入向量生成取消事件
 * @param callback 取消回调函数
 * @returns 取消监听的函数
 */
export const listenClipEmbeddingCancelled = (callback: (data: {
  processed: number;
  total: number;
}) => void): Promise<() => void> => {
  return listen('clip-embedding-cancelled', (event: any) => {
    callback(event.payload);
  });
};

// ==================== CLIP 模型下载进度 API ====================

export interface ClipModelDownloadProgress {
  model_name?: string;
  file_name: string;
  file_index: number;
  total_files: number;
  downloaded: number;
  total: number;
  progress: number;
  overall_progress: number;
  speed: number;
}

/**
 * 监听 CLIP 模型下载进度事件
 * @param callback 进度回调函数
 * @returns 取消监听的函数
 */
export const listenClipModelDownloadProgress = (callback: (data: ClipModelDownloadProgress) => void): Promise<() => void> => {
  return listen('clip-model-download-progress', (event: any) => {
    callback(event.payload);
  });
};

// ==================== 角色标签相关 API ====================

import { CharacterTag, DetectedCharacter } from '../../types';

/**
 * 获取所有角色标签（WD14 category=4）
 * @param language 语言（'zh' 或 'en'）
 * @returns 角色标签列表
 */
export const clipGetCharacterTags = async (language?: string): Promise<CharacterTag[]> => {
  if (!isTauriEnvironment()) {
    return [];
  }
  try {
    const tags = await invoke<CharacterTag[]>('clip_get_character_tags', {
      language,
    });
    return tags;
  } catch (error) {
    console.error('Failed to get character tags:', error);
    throw error;
  }
};

/**
 * 按角色标签搜索图片
 * @param tagIndex 标签索引
 * @param minScore 最小相似度阈值
 * @param maxResults 最大返回结果数
 * @returns 搜索结果列表
 */
export const clipSearchByCharacterTag = async (
  tagIndex: number,
  minScore: number,
  maxResults?: number
): Promise<ClipSearchResult[]> => {
  if (!isTauriEnvironment()) {
    return [];
  }
  try {
    const results = await invoke<ClipSearchResult[]>('clip_search_by_character_tag', {
      tagIndex,
      minScore,
      maxResults,
    });
    return results;
  } catch (error) {
    console.error('Failed to search by character tag:', error);
    throw error;
  }
};

/**
 * 获取已检测到的角色列表
 * @param minScore 最小相似度阈值
 * @param minCount 最小匹配文件数
 * @param language 语言 ('zh' | 'en')
 * @returns 已检测到的角色列表
 */
export const clipGetDetectedCharacters = async (
  minScore: number,
  minCount?: number,
  language?: string
): Promise<DetectedCharacter[]> => {
  if (!isTauriEnvironment()) {
    return [];
  }
  try {
    const characters = await invoke<DetectedCharacter[]>('clip_get_detected_characters', {
      minScore,
      minCount: minCount ?? 1,
      language: language ?? 'en',
    });
    return characters;
  } catch (error) {
    console.error('Failed to get detected characters:', error);
    throw error;
  }
};

import { WorkTopicInfo, Topic } from '../../types';

export const clipGetWorkTopics = async (
  minScore: number,
  minCount?: number,
  language?: string
): Promise<WorkTopicInfo[]> => {
  if (!isTauriEnvironment()) {
    return [];
  }
  try {
    const topics = await invoke<WorkTopicInfo[]>('clip_get_work_topics', {
      minScore,
      minCount: minCount ?? 1,
      language: language ?? 'en',
    });
    return topics;
  } catch (error) {
    console.error('Failed to get work topics:', error);
    throw error;
  }
};

export const clipCreateWorkTopics = async (worksToCreate: import('../../types').WorkToCreate[]): Promise<import('../../types').CreateWorkTopicsResult> => {
  if (!isTauriEnvironment()) {
    return { topics: [], people: [] };
  }
  try {
    const result = await invoke<import('../../types').CreateWorkTopicsResult>('clip_create_work_topics', {
      worksToCreate,
    });
    return result;
  } catch (error) {
    console.error('Failed to create work topics:', error);
    throw error;
  }
};

// ==================== P1 自动内容分类 API ====================

import { ClassifyResult, CategoryStat, ClassifyProgress, ClassificationOverview } from '../../types';

export const classifyContentTypes = async (minScore?: number): Promise<ClassifyResult> => {
  if (!isTauriEnvironment()) {
    throw new Error('Content classification is only available in Tauri environment');
  }
  try {
    return await invoke<ClassifyResult>('classify_content_types', { minScore });
  } catch (error) {
    console.error('Failed to classify content types:', error);
    throw error;
  }
};

export const cancelContentClassification = async (): Promise<void> => {
  if (!isTauriEnvironment()) {
    return;
  }
  try {
    await invoke<void>('cancel_content_classification');
  } catch (error) {
    console.error('Failed to cancel content classification:', error);
    throw error;
  }
};

export const getContentCategoryStats = async (): Promise<ClassificationOverview> => {
  if (!isTauriEnvironment()) {
    return { totalIndexed: 0, totalWithTags: 0, categories: [] };
  }
  try {
    return await invoke<ClassificationOverview>('get_content_category_stats');
  } catch (error) {
    console.error('Failed to get content category stats:', error);
    throw error;
  }
};

export const isContentClassifying = async (): Promise<boolean> => {
  if (!isTauriEnvironment()) {
    return false;
  }
  try {
    return await invoke<boolean>('is_content_classifying');
  } catch (error) {
    console.error('Failed to check content classifying status:', error);
    return false;
  }
};

export const listenClassifyProgress = (
  callback: (progress: ClassifyProgress) => void
): Promise<() => void> => {
  return listen<ClassifyProgress>('classify-progress', (event) => {
    callback(event.payload);
  });
};

export const listenClassifyCompleted = (
  callback: (result: { total: number; classified: number; skipped: number; topicsCreated: number }) => void
): Promise<() => void> => {
  return listen('classify-completed', (event) => {
    callback(event.payload as any);
  });
};

export const listenClassifyCancelled = (
  callback: (reason: { reason: string; current?: number; total?: number }) => void
): Promise<() => void> => {
  return listen('classify-cancelled', (event) => {
    callback(event.payload as any);
  });
};
