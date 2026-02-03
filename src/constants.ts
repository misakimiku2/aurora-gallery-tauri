import { TabState } from './types';

export const DUMMY_TAB: TabState = {
    id: 'dummy',
    folderId: '',
    viewingFileId: null,
    viewMode: 'browser' as const,
    layoutMode: 'grid',
    searchQuery: '',
    searchScope: 'all',
    activeTags: [],
    activePersonId: null,
    activeTopicId: null,
    selectedFileIds: [],
    selectedTopicIds: [],
    lastSelectedId: null,
    selectedTagIds: [],
    selectedPersonIds: [],
    currentPage: 1,
    isCompareMode: false,
    dateFilter: { start: null, end: null, mode: 'created' },
    history: { stack: [], currentIndex: -1 },
    scrollTop: 0
};
