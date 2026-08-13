import { useCallback } from 'react';
import type { AppState, TabState } from '../types';
import { DUMMY_TAB } from '../constants';
import { useNavigation } from './useNavigation';

interface UsePersonTopicHandlersParams {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  activeTabRef: React.MutableRefObject<TabState>;
  pushHistory: ReturnType<typeof useNavigation>['pushHistory'];
  enterFolder: ReturnType<typeof useNavigation>['enterFolder'];
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  handleOpenPersonInNewTab: (personId: string) => void;
  lanConnected: boolean;
  handleOpenLanSettings: () => void;
}

/**
 * 人物/专题/标签页视图的导航与筛选 handlers：进入专题/人物/标签视图、
 * 返回上级目录、返回主页等。
 */
export const usePersonTopicHandlers = ({
  state,
  setState,
  activeTab,
  activeTabRef,
  pushHistory,
  enterFolder,
  updateActiveTab,
  handleOpenPersonInNewTab,
  lanConnected,
  handleOpenLanSettings,
}: UsePersonTopicHandlersParams) => {
  const handleNavigateTopic = useCallback((topicId: string | null) => {
    pushHistory(activeTab.folderId, null, 'topics-overview', '', 'all', [], null, 0, null, topicId, topicId ? [topicId] : []);
  }, [activeTab.folderId, pushHistory]);

  const handleNavigatePerson = useCallback((personId: string | null) => {
    pushHistory(activeTab.folderId, null, 'people-overview', '', 'all', [], null, 0, null, null, [], personId ? [personId] : []);
  }, [activeTab.folderId, pushHistory]);

  const handleNavigateTopics = useCallback(() => {
    if (activeTabRef.current.isCompareMode) {
      const newTab: TabState = {
        ...DUMMY_TAB,
        id: Math.random().toString(36).substr(2, 9),
        folderId: activeTabRef.current.folderId,
        viewMode: 'topics-overview',
        history: { stack: [{ folderId: activeTabRef.current.folderId, viewingId: null, viewMode: 'topics-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }
      };
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
    } else {
      handleNavigateTopic(null);
    }
  }, [handleNavigateTopic, setState]);

  const enterTagView = useCallback((tagName: string) => {
    if (activeTabRef.current.isCompareMode) {
      const newTab: TabState = {
        ...DUMMY_TAB,
        id: Math.random().toString(36).substr(2, 9),
        folderId: activeTabRef.current.folderId,
        viewMode: 'browser',
        searchScope: 'tag',
        activeTags: [tagName],
        history: { stack: [{ folderId: activeTabRef.current.folderId, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'tag', activeTags: [tagName], activePersonId: null }], currentIndex: 0 }
      };
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'browser', '', 'tag', [tagName], null, 0);
    }
  }, [pushHistory, setState]);

  const enterTagsOverview = useCallback(() => {
    if (activeTabRef.current.isCompareMode) {
      const newTab: TabState = {
        ...DUMMY_TAB,
        id: Math.random().toString(36).substr(2, 9),
        folderId: activeTabRef.current.folderId,
        viewMode: 'tags-overview',
        history: { stack: [{ folderId: activeTabRef.current.folderId, viewingId: null, viewMode: 'tags-overview', searchQuery: activeTabRef.current.searchQuery, searchScope: activeTabRef.current.searchScope, activeTags: activeTabRef.current.activeTags, activePersonId: null }], currentIndex: 0 }
      };
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'tags-overview', activeTabRef.current.searchQuery, activeTabRef.current.searchScope, activeTabRef.current.activeTags, null, 0);
    }
  }, [pushHistory, setState]);

  const enterPeopleOverview = useCallback(() => {
    if (activeTabRef.current.isCompareMode) {
      const newTab: TabState = {
        ...DUMMY_TAB,
        id: Math.random().toString(36).substr(2, 9),
        folderId: activeTabRef.current.folderId,
        viewMode: 'people-overview',
        history: { stack: [{ folderId: activeTabRef.current.folderId, viewingId: null, viewMode: 'people-overview', searchQuery: activeTabRef.current.searchQuery, searchScope: activeTabRef.current.searchScope, activeTags: activeTabRef.current.activeTags, activePersonId: null }], currentIndex: 0 }
      };
      setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'people-overview', activeTabRef.current.searchQuery, activeTabRef.current.searchScope, activeTabRef.current.activeTags, null, 0);
    }
  }, [pushHistory, setState]);

  const enterPersonView = useCallback((personId: string) => {
    if (activeTabRef.current.isCompareMode) {
      handleOpenPersonInNewTab(personId);
    } else {
      pushHistory(activeTabRef.current.folderId, null, 'browser', '', 'all', [], personId, 0);
    }
  }, [pushHistory, handleOpenPersonInNewTab]);

  const handleClearPersonFilter = () => updateActiveTab({ activePersonId: null });

  const handleNavigateHome = useCallback(() => {
    pushHistory('__android_folders_root__', null, 'folders-overview', '', 'all', [], null, 0);
  }, [pushHistory]);

  const handleNavigateNetworkHome = useCallback(() => {
    if (!lanConnected) {
      handleOpenLanSettings();
      return;
    }
    pushHistory('__lan_folders_root__', null, 'lan-folders-overview', '', 'all', [], null, 0);
  }, [pushHistory, lanConnected, handleOpenLanSettings]);

  const handleNavigateUp = () => {
    if (activeTab.activeTopicId) {
      const currentTopic = state.topics[activeTab.activeTopicId];
      if (currentTopic) handleNavigateTopic(currentTopic.parentId || null);
    } else if (activeTab.activePersonId) {
      enterPeopleOverview();
    } else if (activeTab.viewMode === 'folders-overview') {
      return;
    } else if (activeTab.viewMode === 'lan-folders-overview') {
      return;
    } else if (activeTab.viewMode === 'people-overview' || activeTab.viewMode === 'tags-overview' || activeTab.viewMode === 'topics-overview') {
      const isAndroid = state.settings.paths.resourceRoot === 'android_media_store';
      if (isAndroid) {
        pushHistory('__android_folders_root__', null, 'folders-overview', '', 'all', [], null, 0);
      } else {
        enterFolder(activeTab.folderId);
      }
    } else {
      const current = state.files[activeTab.folderId];
      if (current && current.parentId) {
        enterFolder(current.parentId);
      } else if (current?.source === 'lan') {
        // LAN 子文件夹无父级时回到网络总览视图
        pushHistory('__lan_folders_root__', null, 'lan-folders-overview', '', 'all', [], null, 0);
      } else {
        const isAndroid = state.settings.paths.resourceRoot === 'android_media_store';
        if (isAndroid && activeTab.viewMode === 'browser') {
          pushHistory('__android_folders_root__', null, 'folders-overview', '', 'all', [], null, 0);
        }
      }
    }
  };

  return {
    handleNavigateTopic,
    handleNavigatePerson,
    handleNavigateTopics,
    enterTagView,
    enterTagsOverview,
    enterPeopleOverview,
    enterPersonView,
    handleClearPersonFilter,
    handleNavigateHome,
    handleNavigateNetworkHome,
    handleNavigateUp,
  };
};
