import { TabState, LayoutMode, SortOption, SortDirection, GroupByOption } from './types';

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

export const DEFAULT_LAYOUT_SETTINGS = {
    layoutMode: 'grid' as LayoutMode,
    sortBy: 'name' as SortOption,
    sortDirection: 'asc' as SortDirection,
    groupBy: 'none' as GroupByOption
};
