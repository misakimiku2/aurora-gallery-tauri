import type { Dispatch, SetStateAction } from 'react';
import { AppState, Person, Topic } from '../types';
import { dbGetAllPeople, dbGetAllTopics } from '../api/tauri-bridge';

/**
 * 人物 / 专题表的公共加载逻辑。
 *
 * 此前同一段「dbGetAllPeople/dbGetAllTopics → 字段映射 → setState 整表替换」
 * 内联在三处（useAppInit 启动加载、useDirectoryScan 的 handleOpenFolder /
 * handleChangePath），M6a 阶段 2 起 `lan-share-data-changed` 事件（远端写操作
 * 失效通知）也要按 kind 回拉 people/topics——统一收敛到这里，勿再内联第四份。
 */

type SetAppState = Dispatch<SetStateAction<AppState>>;

/**
 * 从数据库读取全部人物并映射为 id → Person。
 * 读取失败（含非 Tauri 环境）返回 null，调用方据此保留内存现值。
 */
export const fetchPeopleMap = async (): Promise<Record<string, Person> | null> => {
  try {
    const dbPeople = await dbGetAllPeople();
    if (!Array.isArray(dbPeople)) return null;
    const peopleMap: Record<string, Person> = {};
    dbPeople.forEach((p: any) => { peopleMap[p.id] = p; });
    return peopleMap;
  } catch (e) {
    console.error('Failed to fetch people from db:', e);
    return null;
  }
};

/**
 * 从数据库读取全部专题并映射为 id → Topic（行字段 topicType → type 等）。
 * 读取失败（含非 Tauri 环境）返回 null，调用方据此保留内存现值。
 */
export const fetchTopicsMap = async (): Promise<Record<string, Topic> | null> => {
  try {
    const dbTopics = await dbGetAllTopics();
    if (!Array.isArray(dbTopics)) return null;
    const topicsMap: Record<string, Topic> = {};
    dbTopics.forEach((t: any) => {
      topicsMap[t.id] = {
        id: t.id,
        parentId: t.parentId,
        name: t.name,
        description: t.description,
        type: t.topicType,
        coverFileId: t.coverFileId,
        backgroundFileId: t.backgroundFileId,
        coverCrop: t.coverCrop,
        peopleIds: t.peopleIds || [],
        fileIds: t.fileIds || [],
        fileCount: t.fileCount ?? 0,
        sourceUrl: t.sourceUrl,
        createdAt: t.createdAt ? new Date(t.createdAt).toISOString() : undefined,
        updatedAt: t.updatedAt ? new Date(t.updatedAt).toISOString() : undefined,
      };
    });
    return topicsMap;
  } catch (e) {
    console.error('Failed to fetch topics from db:', e);
    return null;
  }
};

/**
 * 重载人物表：从数据库整体替换内存 state.people。
 * 空 DB（如切换根目录后）同样替换为空表；仅读取失败时保留现值。
 * 供 useDirectoryScan 与 `lan-share-data-changed`（kind=people）回拉使用。
 */
export const reloadPeople = async (setState: SetAppState): Promise<void> => {
  const people = await fetchPeopleMap();
  if (!people) return;
  setState(prev => ({ ...prev, people }));
};

/**
 * 重载专题表：从数据库整体替换内存 state.topics。
 * 空 DB（如切换根目录后）同样替换为空表；仅读取失败时保留现值。
 * 供 useDirectoryScan 与 `lan-share-data-changed`（kind=topics）回拉使用。
 */
export const reloadTopics = async (setState: SetAppState): Promise<void> => {
  const topics = await fetchTopicsMap();
  if (!topics) return;
  setState(prev => ({ ...prev, topics }));
};
