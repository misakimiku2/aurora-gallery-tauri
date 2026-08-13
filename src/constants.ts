import { TabState, LayoutMode, SortOption, SortDirection, GroupByOption } from './types';

// LAN 根目录虚拟文件夹 ID：容纳资源根目录下未归入子文件夹的散落图片
export const LAN_ROOT_IMAGES_ID = '__lan_root_images__';

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
