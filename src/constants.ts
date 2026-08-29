import { TabState, LayoutMode, SortOption, SortDirection, GroupByOption } from './types';

// LAN 根目录虚拟文件夹 ID：容纳资源根目录下未归入子文件夹的散落图片
export const LAN_ROOT_IMAGES_ID = '__lan_root_images__';

// 安卓设备根目录虚拟文件夹 ID：容纳 MediaStore 根目录散落图片
export const ANDROID_ROOT_IMAGES_ID = '__android_root_images__';

// 安卓设备根节点 ID 前缀：桌面端浏览某台安卓设备的入口（<prefix><deviceKey>）。
// 它是一台设备的"顶层文件夹"，子节点 = 该设备的顶层图片文件夹（+ 根目录图片虚拟文件夹），
// 因此桌面端可以用常规文件界面（FileGrid）浏览安卓设备，而不是安卓端的 FoldersOverview。
export const ANDROID_DEVICE_ROOT_PREFIX = '__android_device_root__:';

export const androidDeviceRootId = (key: string) => `${ANDROID_DEVICE_ROOT_PREFIX}${key}`;

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
