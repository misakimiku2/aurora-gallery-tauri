import { useState, useRef, useCallback } from 'react';
import { AppState, TabState } from '../types';
import { dbUpsertFileMetadata } from '../api/tauri-bridge';
import { info as logInfo } from '../utils/logger';

interface UseTagsProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  t: (key: string) => string;
  showToast: (msg: string) => void;
  groupedTags: Record<string, string[]>;
  closeContextMenu: () => void;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
}

export const useTags = ({
  state,
  setState,
  activeTab,
  t,
  showToast,
  groupedTags,
  closeContextMenu,
  updateActiveTab,
}: UseTagsProps) => {

  const [isCreatingTag, setIsCreatingTag] = useState(false);

  // 传给左侧 <Sidebar>（React.memo）的回调：state 每次渲染都换引用，用 ref 固定身份，
  // 否则 App 每次重渲染都会把整棵文件夹树重渲一遍。
  const stateRef = useRef(state);
  stateRef.current = state;

  const requestDeleteTags = (tags: string[]) => {
    setState(s => ({ ...s, activeModal: { type: 'confirm-delete-tag', data: { tags } } }));
  };

  const handleConfirmDeleteTags = (tags: string[]) => {
    setState(prev => {
      const newFiles = { ...prev.files };
      const newCustomTags = prev.customTags.filter(tag => !tags.includes(tag));
      const affectedFileIds: string[] = [];

      Object.entries(newFiles).forEach(([id, file]) => {
        if (file.tags && file.tags.some(tag => tags.includes(tag))) {
          newFiles[id] = { ...file, tags: file.tags.filter(tag => !tags.includes(tag)) };
          affectedFileIds.push(id);
        }
      });

      affectedFileIds.forEach(id => {
        const file = newFiles[id];
        if (file) {
          dbUpsertFileMetadata({
            fileId: id,
            path: file.path,
            tags: file.tags,
            description: file.description,
            sourceUrl: file.sourceUrl,
            category: file.category,
            aiData: file.aiData,
            updatedAt: Date.now()
          }).catch(err => console.error('Failed to persist tag deletion:', err));
        }
      });

      return {
        ...prev,
        files: newFiles,
        customTags: newCustomTags
      };
    });
  };

  const handleCopyTags = (ids: string[]) => {
    const allTags = new Set<string>();
    ids.forEach(id => state.files[id]?.tags.forEach(t => allTags.add(t)));
    setState(s => ({ ...s, clipboard: { action: 'copy', items: { type: 'tag', ids: Array.from(allTags) } } }));
    showToast(t('context.copied'));
  };

  const handlePasteTags = (targetIds: string[]) => {
    if (state.clipboard.items.type !== 'tag') return;
    const tagsToAdd = state.clipboard.items.ids;
    setState(prev => {
      const newFiles = { ...prev.files };
      targetIds.forEach(id => {
        const file = newFiles[id];
        if (file) {
          const newTags = Array.from(new Set([...file.tags, ...tagsToAdd]));
          newFiles[id] = { ...file, tags: newTags };
        }
      });
      return { ...prev, files: newFiles };
    });
    showToast("Tags pasted");
  };

  const handleCreateNewTag = useCallback(() => {
    setIsCreatingTag(true);
    if (!stateRef.current.layout.isSidebarVisible) {
      logInfo('[App] ensureSidebarOpen', { action: 'ensureSidebarOpen' });
      setState(s => ({ ...s, layout: { ...s.layout, isSidebarVisible: true } }));
    }
  }, [setState]);

  const handleSaveNewTag = useCallback((name: string) => {
    if (name && name.trim()) {
      const tag = name.trim();
      if (!stateRef.current.customTags.includes(tag)) {
        setState(s => ({ ...s, customTags: [...s.customTags, tag] }));
      }
    }
    setIsCreatingTag(false);
  }, [setState]);

  const handleCancelCreateTag = useCallback(() => {
    setIsCreatingTag(false);
  }, []);

  const handleOverviewTagClick = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation();

    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    let newSelectedTagIds: string[];

    const allTags = groupedTags ? Object.values(groupedTags).flat() : [];

    if (isCtrl) {
      if (activeTab.selectedTagIds.includes(tag)) {
        newSelectedTagIds = activeTab.selectedTagIds.filter(tagId => tagId !== tag);
      } else {
        newSelectedTagIds = [...activeTab.selectedTagIds, tag];
      }
    } else if (isShift && activeTab.selectedTagIds.length > 0) {
      const lastSelectedTag = activeTab.selectedTagIds[activeTab.selectedTagIds.length - 1];
      const lastIndex = allTags.indexOf(lastSelectedTag);
      const currentIndex = allTags.indexOf(tag);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        newSelectedTagIds = allTags.slice(start, end + 1);
      } else {
        newSelectedTagIds = [tag];
      }
    } else {
      newSelectedTagIds = [tag];
    }

    updateActiveTab({ selectedTagIds: newSelectedTagIds });
  };

  const handleTagClick = (tag: string, e: React.MouseEvent) => {
    e.stopPropagation();
    closeContextMenu();
    updateActiveTab({ activeTags: [tag] });
  };

  const handleRenameTag = (oldTag: string, newTag: string) => {
    if (!newTag.trim() || oldTag === newTag) return;

    const trimmedNewTag = newTag.trim();

    setState(prev => {
      const newFiles = { ...prev.files };
      let newCustomTags = [...prev.customTags];

      Object.values(newFiles).forEach(file => {
        if (file.tags && file.tags.includes(oldTag)) {
          file.tags = file.tags.map(tag => tag === oldTag ? trimmedNewTag : tag);
        }
      });

      if (newCustomTags.includes(oldTag)) {
        newCustomTags = newCustomTags.map(tag => tag === oldTag ? trimmedNewTag : tag);
      }

      const newTabs = prev.tabs.map(tab => {
        let updatedTab = { ...tab };

        if (updatedTab.searchQuery === oldTag) {
          updatedTab.searchQuery = trimmedNewTag;
        }

        if (updatedTab.activeTags.includes(oldTag)) {
          updatedTab.activeTags = updatedTab.activeTags.map(tag => tag === oldTag ? trimmedNewTag : tag);
        }

        if (updatedTab.selectedTagIds.includes(oldTag)) {
          updatedTab.selectedTagIds = updatedTab.selectedTagIds.map(tag => tag === oldTag ? trimmedNewTag : tag);
        }

        return updatedTab;
      });

      return {
        ...prev,
        files: newFiles,
        customTags: newCustomTags,
        tabs: newTabs,
        activeModal: { type: null }
      };
    });
  };

  const handleClearTagFilter = (tagToRemove: string) => updateActiveTab(prev => ({ activeTags: prev.activeTags.filter(t => t !== tagToRemove) }));
  const handleClearAllTags = () => updateActiveTab({ activeTags: [] });

  return {
    isCreatingTag,
    requestDeleteTags,
    handleConfirmDeleteTags,
    handleCopyTags,
    handlePasteTags,
    handleCreateNewTag,
    handleSaveNewTag,
    handleCancelCreateTag,
    handleOverviewTagClick,
    handleTagClick,
    handleRenameTag,
    handleClearTagFilter,
    handleClearAllTags,
  };
};
