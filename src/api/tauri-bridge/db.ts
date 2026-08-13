import { invoke } from '@tauri-apps/api/core';
import { isTauriEnvironment } from '../../utils/environment';

/**
 * 更新或插入文件元数据到数据库
 * @param metadata 元数据对象
 */
export const dbUpsertFileMetadata = async (metadata: {
  fileId: string;
  path: string;
  tags?: string[];
  description?: string;
  sourceUrl?: string;
  category?: string;
  aiData?: any;
  updatedAt?: number;
}): Promise<void> => {
  try {
    await invoke('db_upsert_file_metadata', { metadata });
  } catch (error) {
    console.error('Failed to upsert file metadata:', error);
    throw error;
  }
};

/**
 * 获取所有文件元数据
 * @returns 所有文件元数据列表
 */
export const dbGetAllFileMetadata = async (): Promise<Array<{
  fileId: string;
  path: string;
  tags?: string[];
  description?: string;
  sourceUrl?: string;
  category?: string;
  aiData?: any;
  updatedAt?: number;
}>> => {
  try {
    const result = await invoke<Array<{
      fileId: string;
      path: string;
      tags?: any;
      description?: string;
      sourceUrl?: string;
      category?: string;
      aiData?: any;
      updatedAt?: number;
    }>>('db_get_all_file_metadata');

    return result.map(item => ({
      fileId: item.fileId,
      path: item.path,
      tags: item.tags ? (typeof item.tags === 'string' ? JSON.parse(item.tags) : item.tags) : undefined,
      description: item.description,
      sourceUrl: item.sourceUrl,
      category: item.category,
      aiData: item.aiData,
      updatedAt: item.updatedAt,
    }));
  } catch (error) {
    console.error('Failed to get all file metadata:', error);
    throw error;
  }
};

/**
 * 复制文件元数据
 * @param srcPath 源文件路径
 * @param destPath 目标文件路径
 */
export const dbCopyFileMetadata = async (srcPath: string, destPath: string): Promise<void> => {
  try {
    await invoke('db_copy_file_metadata', { srcPath, destPath });
  } catch (error) {
    console.error('Failed to copy file metadata:', error);
    throw error;
  }
};

// ==========================================
// Database / Person APIs
// ==========================================

export const dbGetAllPeople = async (): Promise<any[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke('db_get_all_people');
  } catch (e) {
    console.error('Failed to get people from db:', e);
    return [];
  }
};

export const dbUpsertPerson = async (person: any): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_upsert_person', { person });
  } catch (e) {
    console.error('Failed to upsert person:', e);
    throw e;
  }
};

export const dbDeletePerson = async (id: string): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_delete_person', { id });
  } catch (e) {
    console.error('Failed to delete person:', e);
    throw e;
  }
};

export const dbUpdatePersonAvatar = async (personId: string, coverFileId: string, faceBox: any): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_update_person_avatar', { personId, coverFileId, faceBox });
  } catch (e) {
    console.error('Failed to update person avatar:', e);
    throw e;
  }
};

export const switchRootDatabase = async (newRootPath: string): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('switch_root_database', { newRootPath });
  } catch (e) {
    console.error('Failed to switch root database:', e);
    throw e;
  }
};

// ==========================================
// Database / Topic APIs
// ==========================================

export const dbGetAllTopics = async (): Promise<any[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke('db_get_all_topics');
  } catch (e) {
    console.error('Failed to get topics from db:', e);
    return [];
  }
};

export const dbUpsertTopic = async (topic: any): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_upsert_topic', { topic });
  } catch (e) {
    console.error('Failed to upsert topic:', e);
    throw e;
  }
};

export const dbDeleteTopic = async (id: string): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_delete_topic', { id });
  } catch (e) {
    console.error('Failed to delete topic:', e);
    throw e;
  }
};

// ===== Phase 0: topic_files / topic_people 关联表 API =====

/** 一次性取某专题全量 file_ids（仅用于小专题 / Modal 差集计算） */
export const dbGetTopicFiles = async (topicId: string): Promise<string[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke<string[]>('db_get_topic_files', { topicId });
  } catch (e) {
    console.error('Failed to get topic files:', e);
    return [];
  }
};

export interface PaginatedTopicFiles {
  files: string[];
  total: number;
  hasMore: boolean;
}

/** 分页加载专题图片（详情页用，避免一次性返回 2 万个 id） */
export const dbGetTopicFilesPaginated = async (
  topicId: string,
  offset: number,
  limit: number
): Promise<PaginatedTopicFiles> => {
  if (!isTauriEnvironment()) return { files: [], total: 0, hasMore: false };
  try {
    const r = await invoke<PaginatedTopicFiles>('db_get_topic_files_paginated', {
      topicId,
      offset,
      limit,
    });
    return { files: r.files || [], total: r.total || 0, hasMore: !!r.hasMore };
  } catch (e) {
    console.error('Failed to get topic files paginated:', e);
    return { files: [], total: 0, hasMore: false };
  }
};

/** 批量取多个专题的封面预览图（cover_file_id 缺失时回退用，取前 N 张） */
export const dbGetTopicCoverPreviews = async (
  topicIds: string[],
  previewCount: number
): Promise<Record<string, string[]>> => {
  if (!isTauriEnvironment()) return {};
  try {
    const r = await invoke<Record<string, string[]>>('db_get_topic_cover_previews', {
      topicIds,
      previewCount,
    });
    return r || {};
  } catch (e) {
    console.error('Failed to get topic cover previews:', e);
    return {};
  }
};

/** 反查某文件所属的所有专题 id（走索引，<10ms） */
export const dbFindTopicsContainingFile = async (fileId: string): Promise<string[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke<string[]>('db_find_topics_containing_file', { fileId });
  } catch (e) {
    console.error('Failed to find topics containing file:', e);
    return [];
  }
};

/** 整体替换专题的 file 列表（仅在创建/重建时使用，新增请用 dbAddFilesToTopic） */
export const dbSetTopicFiles = async (topicId: string, fileIds: string[]): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_set_topic_files', { topicId, fileIds });
  } catch (e) {
    console.error('Failed to set topic files:', e);
    throw e;
  }
};

/** 单/批量添加图片到专题（INSERT OR IGNORE） */
export const dbAddFilesToTopic = async (topicId: string, fileIds: string[]): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_add_files_to_topic', { topicId, fileIds });
  } catch (e) {
    console.error('Failed to add files to topic:', e);
    throw e;
  }
};

/** 从专题中删除单张图片（单行 DELETE） */
export const dbRemoveFileFromTopic = async (topicId: string, fileId: string): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_remove_file_from_topic', { topicId, fileId });
  } catch (e) {
    console.error('Failed to remove file from topic:', e);
    throw e;
  }
};

/** 取某专题关联的人物 id 列表 */
export const dbGetTopicPeople = async (topicId: string): Promise<string[]> => {
  if (!isTauriEnvironment()) return [];
  try {
    return await invoke<string[]>('db_get_topic_people', { topicId });
  } catch (e) {
    console.error('Failed to get topic people:', e);
    return [];
  }
};

/** 整体替换专题的人物列表 */
export const dbSetTopicPeople = async (topicId: string, peopleIds: string[]): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_set_topic_people', { topicId, peopleIds });
  } catch (e) {
    console.error('Failed to set topic people:', e);
    throw e;
  }
};

/** 添加人物到专题 */
export const dbAddPeopleToTopic = async (topicId: string, peopleIds: string[]): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_add_people_to_topic', { topicId, peopleIds });
  } catch (e) {
    console.error('Failed to add people to topic:', e);
    throw e;
  }
};

/** 从专题中移除人物 */
export const dbRemovePersonFromTopic = async (topicId: string, peopleId: string): Promise<void> => {
  if (!isTauriEnvironment()) return;
  try {
    await invoke('db_remove_person_from_topic', { topicId, peopleId });
  } catch (e) {
    console.error('Failed to remove person from topic:', e);
    throw e;
  }
};
