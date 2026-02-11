import { useCallback } from 'react';
import type { AppState, TabState, SearchScope, AiSearchFilter, GroupByOption } from '../types';
import { DUMMY_TAB, DEFAULT_LAYOUT_SETTINGS } from '../constants';

type Refs = {
  selectionRef: React.RefObject<HTMLElement | null>;
  activeTabRef: React.MutableRefObject<TabState | null>;
};

export const useNavigation = (
  state: AppState,
  setState: React.Dispatch<React.SetStateAction<AppState>>,
  refs: Refs,
  setGroupBy?: (groupBy: GroupByOption) => void
) => {
  const { selectionRef, activeTabRef } = refs;

  const setNavigationTimestamp = useCallback(() => {
    (window as any).__AURORA_NAV_TIMESTAMP__ = Date.now();
  }, []);

  const pushHistory = useCallback((folderId: string, viewingId: string | null, viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'topics-overview' = 'browser', searchQuery: string = '', searchScope: SearchScope = 'all', activeTags: string[] = [], activePersonId: string | null = null, nextScrollTop: number = 0, aiFilter: AiSearchFilter | null | undefined = null, activeTopicId: string | null = null, selectedTopicIds: string[] = [], selectedPersonIds: string[] = [], scrollToItemId?: string) => {
    // preserve original behaviour: set timestamp BEFORE state update
    (window as any).__AURORA_NAV_TIMESTAMP__ = Date.now();

    setState(prev => {
      const active = prev.tabs.find(t => t.id === prev.activeTabId) || DUMMY_TAB;
      const currentScrollTop = selectionRef.current?.scrollTop ?? active.scrollTop;
      const stackCopy = [...active.history.stack];
      if (active.history.currentIndex >= 0 && active.history.currentIndex < stackCopy.length) {
        stackCopy[active.history.currentIndex] = {
          ...stackCopy[active.history.currentIndex],
          scrollTop: currentScrollTop,
          currentPage: active.currentPage,
          selectedTopicIds: active.selectedTopicIds,
          selectedPersonIds: active.selectedPersonIds
        };
      }

      const newStack = [...stackCopy.slice(0, active.history.currentIndex + 1), { 
        folderId, viewingId, viewMode, searchQuery, searchScope, activeTags, activePersonId, aiFilter, 
        scrollTop: nextScrollTop, currentPage: 1, activeTopicId, selectedTopicIds, selectedPersonIds 
      }];

      return {
        ...prev,
        tabs: prev.tabs.map(t => t.id === prev.activeTabId ? {
          ...t,
          folderId,
          viewingFileId: viewingId,
          viewMode,
          searchQuery,
          searchScope,
          activeTags,
          activePersonId,
          aiFilter,
          scrollTop: nextScrollTop,
          currentPage: 1,
          activeTopicId,
          selectedTopicIds,
          selectedPersonIds,
          selectedFileIds: scrollToItemId ? [scrollToItemId] : (viewingId ? [viewingId] : []),
          scrollToItemId,
          selectedTagIds: [],
          history: { stack: newStack, currentIndex: newStack.length - 1 }
        } : t)
      };
    });
  }, [selectionRef, setState]);

  const goBack = useCallback(() => {
    setNavigationTimestamp();
    const currentScroll = selectionRef.current?.scrollTop || 0;
    setState(prev => {
      const active = prev.tabs.find(t => t.id === prev.activeTabId) || DUMMY_TAB;
      if (active.history.currentIndex > 0) {
        const newIndex = active.history.currentIndex - 1;
        const step = active.history.stack[newIndex];
        return {
          ...prev,
          tabs: prev.tabs.map(t => t.id === prev.activeTabId ? ({
            ...t,
            folderId: step.folderId,
            viewingFileId: step.viewingId,
            viewMode: step.viewMode,
            searchQuery: step.searchQuery,
            searchScope: step.searchScope,
            activeTags: step.activeTags || [],
            activePersonId: step.activePersonId,
            activeTopicId: step.activeTopicId || null,
            selectedTopicIds: step.selectedTopicIds || [],
            selectedPersonIds: step.selectedPersonIds || [],
            aiFilter: step.aiFilter,
            scrollTop: step.scrollTop || 0,
            currentPage: step.currentPage || 1,
            selectedFileIds: step.viewingId ? [step.viewingId] : [],
            selectedTagIds: [],
            history: { ...t.history, currentIndex: newIndex }
          }) : t)
        };
      }
      return prev;
    });
  }, [selectionRef, setNavigationTimestamp, setState]);

  const goForward = useCallback(() => {
    setNavigationTimestamp();
    const currentScroll = selectionRef.current?.scrollTop || 0;
    setState(prev => {
      const active = prev.tabs.find(t => t.id === prev.activeTabId) || DUMMY_TAB;
      if (active.history.currentIndex < active.history.stack.length - 1) {
        const newIndex = active.history.currentIndex + 1;
        const step = active.history.stack[newIndex];
        return {
          ...prev,
          tabs: prev.tabs.map(t => t.id === prev.activeTabId ? ({
            ...t,
            folderId: step.folderId,
            viewingFileId: step.viewingId,
            viewMode: step.viewMode,
            searchQuery: step.searchQuery,
            searchScope: step.searchScope,
            activeTags: step.activeTags || [],
            activePersonId: step.activePersonId,
            activeTopicId: step.activeTopicId || null,
            selectedTopicIds: step.selectedTopicIds || [],
            selectedPersonIds: step.selectedPersonIds || [],
            aiFilter: step.aiFilter,
            scrollTop: step.scrollTop || 0,
            currentPage: step.currentPage || 1,
            selectedFileIds: step.viewingId ? [step.viewingId] : [],
            selectedTagIds: [],
            history: { ...t.history, currentIndex: newIndex }
          }) : t)
        };
      }
      return prev;
    });
  }, [selectionRef, setNavigationTimestamp, setState]);

  const enterFolder = useCallback((folderId: string, options?: { scrollToItemId?: string, resetScroll?: boolean }) => {
    const scroll = selectionRef.current?.scrollTop || 0;
    const nextScroll = options?.resetScroll ? 0 : 0;
    pushHistory(folderId, null, 'browser', '', 'all', [], null, nextScroll, null, null, [], [], options?.scrollToItemId);
  }, [pushHistory, selectionRef]);

  const enterViewer = useCallback((fileId: string) => {
    const scrollTop = selectionRef.current?.scrollTop || 0;
    pushHistory((state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).folderId, fileId, 'browser', (state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).searchQuery, (state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).searchScope, (state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).activeTags, (state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).activePersonId, scrollTop, (state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).aiFilter, (state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).activeTopicId);
  }, [pushHistory, selectionRef, state.tabs, state.activeTabId]);

  const handleSwitchTab = useCallback((id: string) => {
    setState(s => ({ ...s, activeTabId: id }));
  }, [setState]);

  const handleCloseTab = useCallback((e: any, id: string) => {
    e?.stopPropagation && e.stopPropagation();
    setState(prev => {
      const newTabs = prev.tabs.filter(t => t.id !== id);
      if (newTabs.length === 0) return prev;
      let newActiveId = prev.activeTabId;
      if (id === prev.activeTabId) {
        const index = prev.tabs.findIndex(t => t.id === id);
        newActiveId = newTabs[Math.max(0, index - 1)].id;
      }
      return { ...prev, tabs: newTabs, activeTabId: newActiveId };
    });
  }, [setState]);

  const handleNewTab = useCallback(() => {
    const folderId = state.roots[0] || '';

    // Check for folder-specific settings, otherwise use global defaults
    const savedFolderSettings = state.folderSettings[folderId];
    const globalSettings = state.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS;

    const layoutMode = savedFolderSettings?.layoutMode || globalSettings.layoutMode;
    const sortBy = savedFolderSettings?.sortBy || globalSettings.sortBy;
    const sortDirection = savedFolderSettings?.sortDirection || globalSettings.sortDirection;
    const groupBySetting = savedFolderSettings?.groupBy || globalSettings.groupBy;

    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: folderId,
      layoutMode: layoutMode as any
    };
    newTab.history = { stack: [{ folderId: newTab.folderId, viewingId: null, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 };

    // Apply groupBy if setter is provided
    if (setGroupBy) {
      setGroupBy(groupBySetting as GroupByOption);
    }

    setState(prev => ({
      ...prev,
      tabs: [...prev.tabs, newTab],
      activeTabId: newTab.id,
      sortBy: sortBy,
      sortDirection: sortDirection
    }));
  }, [setState, state.roots, state.folderSettings, state.settings.defaultLayoutSettings, setGroupBy]);

  const handleOpenCompareInNewTab = useCallback((imageIds: string[]) => {
    // 生成新的画布名称
    const generateCanvasName = () => {
      const existingNames = state.tabs
        .filter(tab => tab.isCompareMode)
        .map(tab => tab.sessionName)
        .filter((name): name is string => !!name);

      let maxNum = 0;
      existingNames.forEach(name => {
        const match = name.match(/^画布(\d+)$/);
        if (match) {
          const num = parseInt(match[1], 10);
          if (num > maxNum) maxNum = num;
        }
      });

      return `画布${String(maxNum + 1).padStart(2, '0')}`;
    };

    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: (state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).folderId,
      selectedFileIds: imageIds,
      isCompareMode: true,
      sessionName: generateCanvasName(),
      history: {
        stack: [{
          folderId: (state.tabs.find(t => t.id === state.activeTabId) || DUMMY_TAB).folderId,
          viewingId: null,
          viewMode: 'browser',
          searchQuery: '',
          searchScope: 'all',
          activeTags: [],
          activePersonId: null
        }],
        currentIndex: 0
      }
    };

    setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  }, [setState, state.tabs, state.activeTabId]);

  return {
    pushHistory,
    enterFolder,
    enterViewer,
    goBack,
    goForward,
    handleSwitchTab,
    handleCloseTab,
    handleNewTab,
    handleOpenCompareInNewTab,
    setNavigationTimestamp
  };
};
