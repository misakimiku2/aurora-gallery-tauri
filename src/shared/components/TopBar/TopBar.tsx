import React from 'react';
import { LayoutMode, SortOption, SortDirection, SearchScope } from '../../api/types';
import { NavigationButtons, NavigationButtonsProps } from './NavigationButtons';
import { SortControls, SortControlsProps } from './SortControls';
import { SearchInput, SearchInputProps } from './SearchInput';
import { LayoutSwitcher } from '../Grid';

export interface SharedTopBarProps {
  onGoBack?: () => void;
  onGoForward?: () => void;
  onNavigateUp?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  canNavigateUp?: boolean;
  onRefresh: () => void;
  layoutMode: LayoutMode;
  onLayoutModeChange: (mode: LayoutMode) => void;
  sortBy: SortOption;
  sortDirection: SortDirection;
  onSortChange: (option: SortOption) => void;
  onSortDirectionChange: () => void;
  searchQuery: string;
  onSearchChange: (query: string) => void;
  onPerformSearch: (query: string) => Promise<void>;
  searchScope: SearchScope;
  onSearchScopeChange: (scope: SearchScope) => void;
  searchPlaceholder?: string;
  title?: string;
  t: (key: string) => string;
}

export const SharedTopBar: React.FC<SharedTopBarProps> = ({
  onGoBack,
  onGoForward,
  onNavigateUp,
  canGoBack = false,
  canGoForward = false,
  canNavigateUp = false,
  onRefresh,
  layoutMode,
  onLayoutModeChange,
  sortBy,
  sortDirection,
  onSortChange,
  onSortDirectionChange,
  searchQuery,
  onSearchChange,
  onPerformSearch,
  searchScope,
  onSearchScopeChange,
  searchPlaceholder,
  title,
  t,
}) => {
  const navProps: NavigationButtonsProps = {
    onGoBack,
    onGoForward,
    onNavigateUp,
    onRefresh,
    canGoBack,
    canGoForward,
    canNavigateUp,
    t,
  };

  const sortProps: SortControlsProps = {
    sortBy,
    sortDirection,
    onSortChange,
    onSortDirectionChange,
    t,
  };

  const searchProps: SearchInputProps = {
    searchQuery,
    onSearchChange,
    onPerformSearch,
    searchScope,
    onSearchScopeChange,
    placeholder: searchPlaceholder,
    t,
  };

  return (
    <div className="h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center px-4 justify-between shrink-0 z-30 space-x-4">
      <NavigationButtons {...navProps} />

      <div className="flex-1 flex justify-center">
        <SearchInput {...searchProps} />
      </div>

      <div className="flex items-center space-x-2 min-w-fit">
        <SortControls {...sortProps} />
        <LayoutSwitcher mode={layoutMode} onChange={onLayoutModeChange} />
      </div>
    </div>
  );
};

export default SharedTopBar;
