import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { BrowseItem, lanShareApi } from '../api';
import { BreadcrumbNav } from '@/shared/components/UI/BreadcrumbNav';
import { FileGrid } from '@/shared/components/Grid';
import { SharedTopBar } from '@/shared/components/TopBar';
import { HttpAdapter } from '@/shared/api/adapters/HttpAdapter';
import { LayoutMode, SortOption, SortDirection, SearchScope } from '@/shared/api/types';

interface BrowseScreenProps {
  currentPath: string;
  folders: BrowseItem[];
  images: BrowseItem[];
  token: string;
  allowEdit: boolean;
  onNavigate: (path: string) => void;
  onViewImage: (image: BrowseItem, index: number) => void;
  onLogout: () => void;
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
  sortBy: SortOption;
  sortDirection: SortDirection;
  onSortChange: (option: SortOption) => void;
  onSortDirectionChange: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  searchScope: SearchScope;
  onSearchScopeChange: (scope: SearchScope) => void;
  onRefresh: () => void;
  onGoBack?: () => void;
  onGoForward?: () => void;
  onNavigateUp?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  canNavigateUp?: boolean;
}

const t = (key: string): string => {
  const translations: Record<string, string> = {
    'nav.goBack': '后退',
    'nav.goForward': '前进',
    'nav.goUp': '向上',
    'nav.refresh': '刷新',
    'sort.sortBy': '排序',
    'sort.name': '名称',
    'sort.date': '日期',
    'sort.size': '大小',
    'sort.asc': '升序',
    'sort.desc': '降序',
    'search.placeholder': '搜索全局文件...',
    'search.scopeAll': '全部',
    'search.scopeFile': '文件名',
    'search.scopeFolder': '文件夹',
    'search.search': '搜索',
  };
  return translations[key] || key;
};

const BrowseScreen: React.FC<BrowseScreenProps> = ({
  currentPath,
  folders,
  images,
  token,
  allowEdit,
  onNavigate,
  onViewImage,
  onLogout,
  layoutMode,
  onLayoutModeChange,
  sortBy,
  sortDirection,
  onSortChange,
  onSortDirectionChange,
  searchQuery,
  onSearchChange,
  searchScope,
  onSearchScopeChange,
  onRefresh,
  onGoBack,
  onGoForward,
  onNavigateUp,
  canGoBack,
  canGoForward,
  canNavigateUp,
}) => {
  const [deviceCount, setDeviceCount] = useState(0);
  const [isSearching, setIsSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<{ folders: BrowseItem[]; images: BrowseItem[] } | null>(null);

  const api = useMemo(() => new HttpAdapter('', token), [token]);

  useEffect(() => {
    api.getDevices().then((devices) => {
      setDeviceCount(devices.length);
    }).catch(console.error);
  }, [api]);

  useEffect(() => {
    if (!searchQuery) {
      setSearchResults(null);
    }
  }, [searchQuery]);

  const handleFolderClick = (folder: BrowseItem) => {
    if (searchResults) {
      setSearchResults(null);
      onSearchChange('');
    }
    onNavigate(folder.path);
  };

  const handleImageClick = (image: BrowseItem, index: number) => {
    onViewImage(image, index);
  };

  const handlePerformSearch = useCallback(async (query: string) => {
    if (!query.trim()) {
      setSearchResults(null);
      onSearchChange('');
      return;
    }

    setIsSearching(true);
    try {
      const scope = searchScope === 'all' ? undefined : searchScope;
      const results = await lanShareApi.search(query, scope, token);
      setSearchResults({
        folders: results.folders,
        images: results.images,
      });
      onSearchChange(query);
    } catch (error) {
      console.error('Search error:', error);
      alert('搜索失败');
    } finally {
      setIsSearching(false);
    }
  }, [searchScope, token, onSearchChange]);

  const displayFolders = searchResults ? searchResults.folders : folders;
  const displayImages = searchResults ? searchResults.images : images;

  const sortedItems = useMemo(() => {
    const sortItems = <T extends BrowseItem>(items: T[]): T[] => {
      return [...items].sort((a, b) => {
        let comparison = 0;
        switch (sortBy) {
          case 'name':
            comparison = a.name.localeCompare(b.name);
            break;
          case 'date':
            comparison = 0;
            break;
          case 'size':
            comparison = (a.size || 0) - (b.size || 0);
            break;
        }
        return sortDirection === 'asc' ? comparison : -comparison;
      });
    };

    return {
      folders: sortItems(displayFolders),
      images: sortItems(displayImages),
    };
  }, [displayFolders, displayImages, sortBy, sortDirection]);

  const handleClearSearch = useCallback(() => {
    setSearchResults(null);
    onSearchChange('');
  }, [onSearchChange]);

  return (
    <div className="h-screen flex flex-col bg-white dark:bg-gray-900">
      <SharedTopBar
        onGoBack={searchResults ? handleClearSearch : onGoBack}
        onGoForward={onGoForward}
        onNavigateUp={onNavigateUp}
        canGoBack={searchResults ? true : canGoBack}
        canGoForward={canGoForward}
        canNavigateUp={canNavigateUp}
        onRefresh={onRefresh}
        layoutMode={layoutMode}
        onLayoutModeChange={onLayoutModeChange}
        sortBy={sortBy}
        sortDirection={sortDirection}
        onSortChange={onSortChange}
        onSortDirectionChange={onSortDirectionChange}
        searchQuery={searchQuery}
        onSearchChange={onSearchChange}
        onPerformSearch={handlePerformSearch}
        searchScope={searchScope}
        onSearchScopeChange={onSearchScopeChange}
        t={t}
      />

      <div className="flex items-center justify-between px-4 py-2 bg-gray-50 dark:bg-gray-800/50">
        <div className="flex items-center gap-4">
          {searchResults ? (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-blue-600 dark:text-blue-400">
                搜索结果
              </span>
              <button
                onClick={handleClearSearch}
                className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
              >
                (清除)
              </button>
            </div>
          ) : (
            <BreadcrumbNav
              currentPath={currentPath}
              onNavigate={onNavigate}
              rootLabel="根目录"
            />
          )}
          <div className="flex items-center gap-3 text-sm text-gray-500 dark:text-gray-400">
            {sortedItems.folders.length > 0 && (
              <span>文件夹 ({sortedItems.folders.length})</span>
            )}
            {sortedItems.images.length > 0 && (
              <span>图片 ({sortedItems.images.length})</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-500 dark:text-gray-400">
            {deviceCount} 个设备在线
          </span>
          <button
            onClick={onLogout}
            className="px-3 py-1.5 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-white/10 dark:hover:bg-white/20 text-gray-700 dark:text-white rounded-lg transition-colors"
          >
            退出
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-hidden">
        {isSearching ? (
          <div className="flex items-center justify-center h-full text-gray-400 dark:text-gray-600">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span>搜索中...</span>
            </div>
          </div>
        ) : (
          <FileGrid
            folders={sortedItems.folders}
            images={sortedItems.images}
            api={api}
            onFolderClick={handleFolderClick}
            onImageClick={handleImageClick}
            layoutMode={layoutMode}
            showLayoutSwitcher={false}
          />
        )}
      </div>
    </div>
  );
};

export default BrowseScreen;
