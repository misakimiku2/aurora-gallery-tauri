import { useCallback } from 'react';
import { AppState, Topic, Person, FileType, TabState } from '../types';
import {
  dbUpsertTopic,
  dbDeleteTopic,
  dbAddFilesToTopic,
  dbAddPeopleToTopic,
} from '../api/tauri-bridge';
import { isTauriEnvironment } from '../utils/environment';

interface UseTopicsProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  t: (key: string) => string;
  showToast: (msg: string) => void;
  handleNavigateTopics: () => void;
}

export const useTopics = ({
  state,
  setState,
  activeTab,
  t,
  showToast,
  handleNavigateTopics,
}: UseTopicsProps) => {

  const handleSmartCreateTopic = async (createdTopics: Topic[], createdPeople: Person[]) => {
    if (createdTopics.length === 0 && createdPeople.length === 0) return;

    setState(prev => {
      const newTopics = { ...prev.topics };
      createdTopics.forEach(topic => {
        newTopics[topic.id] = topic;
      });

      const newPeople = { ...prev.people };
      createdPeople.forEach(person => {
        newPeople[person.id] = person;
      });

      return { ...prev, topics: newTopics, people: newPeople };
    });
  };

  const handleManualAddToTopic = (topicId: string) => {
    let targetFileIds: string[] = [];
    let targetPersonIds: string[] = [];

    if (state.activeModal.type === 'add-to-topic' && state.activeModal.data) {
      if (state.activeModal.data.fileIds) targetFileIds = state.activeModal.data.fileIds;
      if (state.activeModal.data.personIds) targetPersonIds = state.activeModal.data.personIds;
    }

    if (targetFileIds.length === 0 && targetPersonIds.length === 0) {
      if (activeTab.viewMode === 'people-overview') {
        targetPersonIds = activeTab.selectedPersonIds;
      } else {
        targetFileIds = activeTab.selectedFileIds;
      }
    }

    if (targetFileIds.length === 0 && targetPersonIds.length === 0) {
      setState(s => ({ ...s, activeModal: { type: null } }));
      return;
    }

    let coverChanged = false;

    setState(current => {
      const topic = current.topics[topicId];
      if (!topic) return current;

      const updatedTopic = { ...topic };

      if (targetFileIds.length > 0) {
        const existingFiles = new Set(updatedTopic.fileIds || []);
        let added = 0;
        targetFileIds.forEach(id => {
          if (!existingFiles.has(id)) { existingFiles.add(id); added++; }
        });
        updatedTopic.fileIds = Array.from(existingFiles);
        // 列表态 fileCount 为权威数量；累加新增（去重后）
        if (added > 0) {
          updatedTopic.fileCount = (updatedTopic.fileCount ?? existingFiles.size - added) + added;
        }

        if (!updatedTopic.coverFileId && targetFileIds.length > 0) {
          const firstImageId = targetFileIds.find(id => {
            const file = current.files[id];
            return file && file.type === FileType.IMAGE;
          });
          if (firstImageId) {
            updatedTopic.coverFileId = firstImageId;
            coverChanged = true;
          }
        }
      }

      if (targetPersonIds.length > 0) {
        const existingPeople = new Set(updatedTopic.peopleIds || []);
        targetPersonIds.forEach(id => existingPeople.add(id));
        updatedTopic.peopleIds = Array.from(existingPeople);
      }

      updatedTopic.updatedAt = new Date().toISOString();

      if (isTauriEnvironment()) {
        // 关联表：单行 INSERT OR IGNORE，不再走 split/join 全量写
        if (targetFileIds.length > 0) {
          dbAddFilesToTopic(topicId, targetFileIds).catch(e => console.error('Failed to add files to topic:', e));
        }
        if (targetPersonIds.length > 0) {
          dbAddPeopleToTopic(topicId, targetPersonIds).catch(e => console.error('Failed to add people to topic:', e));
        }
        // 元数据变更（如 coverFileId）才 upsert topic
        if (coverChanged) {
          dbUpsertTopic({
            id: updatedTopic.id,
            parentId: updatedTopic.parentId,
            name: updatedTopic.name,
            description: updatedTopic.description,
            type: updatedTopic.type,
            coverFileId: updatedTopic.coverFileId,
            backgroundFileId: updatedTopic.backgroundFileId,
            coverCrop: updatedTopic.coverCrop,
            peopleIds: [],
            fileIds: [],
            sourceUrl: updatedTopic.sourceUrl,
            createdAt: updatedTopic.createdAt ? new Date(updatedTopic.createdAt).getTime() : undefined,
            updatedAt: updatedTopic.updatedAt ? new Date(updatedTopic.updatedAt).getTime() : undefined,
          }).catch(e => console.error('Failed to update topic metadata in DB:', e));
        }
      }

      return {
        ...current,
        topics: {
          ...current.topics,
          [topicId]: updatedTopic
        },
        activeModal: { type: null }
      };
    });
    showToast(t('context.saved'));
  };

  const handleCreateTopic = useCallback((parentId: string | null, name?: string, type?: string) => {
    const id = Math.random().toString(36).substr(2, 9);
    const newTopic: Topic = {
      id,
      parentId,
      name: name || t('context.newTopicDefault') || 'New Topic',
      type: type ? type.slice(0, 12) : 'TOPIC',
      peopleIds: [],
      fileIds: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    setState(prev => ({ ...prev, topics: { ...prev.topics, [id]: newTopic } }));

    if (isTauriEnvironment()) {
      // db_upsert_topic 仅写元数据，关联成员（fileIds/peopleIds）为空，新建时无需 set_topic_files
      dbUpsertTopic({
        id: newTopic.id,
        parentId: newTopic.parentId,
        name: newTopic.name,
        description: newTopic.description,
        type: newTopic.type,
        coverFileId: newTopic.coverFileId,
        backgroundFileId: newTopic.backgroundFileId,
        coverCrop: newTopic.coverCrop,
        peopleIds: [],
        fileIds: [],
        sourceUrl: newTopic.sourceUrl,
        createdAt: newTopic.createdAt ? new Date(newTopic.createdAt).getTime() : undefined,
        updatedAt: newTopic.updatedAt ? new Date(newTopic.updatedAt).getTime() : undefined,
      }).catch(e => console.error('Failed to save topic to DB:', e));
    }

    if (parentId === null) {
      handleNavigateTopics();
    }
  }, [t, handleNavigateTopics]);

  const handleUpdateTopic = useCallback((topicId: string, updates: Partial<Topic>) => {
    setState(prev => {
      const updatedTopic = { ...prev.topics[topicId], ...updates, updatedAt: new Date().toISOString() };

      if (isTauriEnvironment()) {
        // 仅元数据更新走 db_upsert_topic；成员变更须调用方用 dbAddFilesToTopic/dbRemoveFileFromTopic
        dbUpsertTopic({
          id: updatedTopic.id,
          parentId: updatedTopic.parentId,
          name: updatedTopic.name,
          description: updatedTopic.description,
          topicType: updatedTopic.type,
          coverFileId: updatedTopic.coverFileId,
          backgroundFileId: updatedTopic.backgroundFileId,
          coverCrop: updatedTopic.coverCrop,
          peopleIds: [],
          fileIds: [],
          sourceUrl: updatedTopic.sourceUrl,
          createdAt: updatedTopic.createdAt ? new Date(updatedTopic.createdAt).getTime() : undefined,
          updatedAt: updatedTopic.updatedAt ? new Date(updatedTopic.updatedAt).getTime() : undefined,
        }).catch(e => console.error('Failed to update topic in DB:', e));
      }

      return {
        ...prev,
        topics: {
          ...prev.topics,
          [topicId]: updatedTopic
        }
      };
    });
  }, []);

  const handleDeleteTopic = useCallback((topicId: string) => {
    setState(prev => {
      const newTopics = { ...prev.topics };
      delete newTopics[topicId];
      return { ...prev, topics: newTopics };
    });

    if (isTauriEnvironment()) {
      dbDeleteTopic(topicId).catch(e => console.error('Failed to delete topic from DB:', e));
    }
  }, []);

  const handleCreateRootTopic = useCallback(() => {
    setState(prev => ({ ...prev, activeModal: { type: 'create-topic', data: { parentId: null } } }));
  }, []);

  return {
    handleSmartCreateTopic,
    handleManualAddToTopic,
    handleCreateTopic,
    handleUpdateTopic,
    handleDeleteTopic,
    handleCreateRootTopic,
  };
};
