import React from 'react';
import { AndroidSelectionBar } from '../AndroidSelectionBar';
import { TopBar } from '../TopBar';
import { DEFAULT_LAYOUT_SETTINGS } from '../../constants';
import { AppState, FileNode, FileType, GroupByOption, LayoutMode, Person, PersonGroupByOption, PersonSortOption, SortDirection, TabState } from '../../types';

interface ToolbarPaneProps {
  lanUploadInputRef: React.RefObject<HTMLInputElement>;
  handleUploadFilesSelected: (e: React.ChangeEvent<HTMLInputElement>) => void;
  isAndroidDevice: boolean;
  isAndroidSelectionMode: boolean;
  activeTab: TabState;
  state: AppState;
  displayFileIds: string[];
  peopleWithDisplayCounts: Record<string, Person>;
  t: (key: string) => string;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  handleExitAndroidSelectionMode: () => void;
  handleDeselectAllAndroid: () => void;
  handleAndroidDelete: (ids: string[]) => void;
  setContextMenu: (menu: any) => void;
  toolbarQuery: string;
  groupedTags: Record<string, string[]>;
  tagSearchQuery: string;
  setTagSearchQuery: (q: string) => void;
  toggleSidebar: () => void;
  goBack: () => void;
  goForward: () => void;
  handleNavigateUp: () => void;
  handleTagClick: (tag: string, e: React.MouseEvent) => void;
  handleRefresh: () => void;
  handlePerformSearch: (query: string) => void;
  setToolbarQuery: (q: string) => void;
  setPersonSearchQuery: (q: string) => void;
  personSearchQuery: string;
  topicLayoutMode: LayoutMode;
  handleTopicLayoutModeChange: (mode: LayoutMode) => void;
  folderLayoutMode: LayoutMode;
  handleFolderLayoutModeChange: (mode: LayoutMode) => void;
  personSortBy: PersonSortOption;
  personSortDirection: SortDirection;
  personGroupBy: PersonGroupByOption;
  handlePersonSortByChange: (option: PersonSortOption) => void;
  handlePersonSortDirectionChange: () => void;
  handlePersonGroupByChange: (option: PersonGroupByOption) => void;
  isClipSearchEnabled: boolean;
  setIsClipSearchEnabled: (v: boolean) => void;
  openClipSettings: () => void;
  showToast: (msg: string) => void;
  showLanUpload: boolean;
  handleUploadToLan: () => void;
  totalResults: number;
  pageSize: number;
  groupBy: GroupByOption;
  setGroupBy: (g: GroupByOption) => void;
  handleRememberFolderSettings: () => void;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  toggleMetadata: () => void;
  toggleColorPicker: () => void;
  toggleSettings: () => void;
}

// 中央区工具栏：安卓多选操作条（AndroidSelectionBar）或完整工具栏（TopBar）
export const ToolbarPane = ({
  lanUploadInputRef,
  handleUploadFilesSelected,
  isAndroidDevice,
  isAndroidSelectionMode,
  activeTab,
  state,
  displayFileIds,
  peopleWithDisplayCounts,
  t,
  updateActiveTab,
  handleExitAndroidSelectionMode,
  handleDeselectAllAndroid,
  handleAndroidDelete,
  setContextMenu,
  toolbarQuery,
  groupedTags,
  tagSearchQuery,
  setTagSearchQuery,
  toggleSidebar,
  goBack,
  goForward,
  handleNavigateUp,
  handleTagClick,
  handleRefresh,
  handlePerformSearch,
  setToolbarQuery,
  setPersonSearchQuery,
  personSearchQuery,
  topicLayoutMode,
  handleTopicLayoutModeChange,
  folderLayoutMode,
  handleFolderLayoutModeChange,
  personSortBy,
  personSortDirection,
  personGroupBy,
  handlePersonSortByChange,
  handlePersonSortDirectionChange,
  handlePersonGroupByChange,
  isClipSearchEnabled,
  setIsClipSearchEnabled,
  openClipSettings,
  showToast,
  showLanUpload,
  handleUploadToLan,
  totalResults,
  pageSize,
  groupBy,
  setGroupBy,
  handleRememberFolderSettings,
  setState,
  toggleMetadata,
  toggleColorPicker,
  toggleSettings,
}: ToolbarPaneProps) => {
  return (
    <>
      <input
        type="file"
        accept="image/*"
        multiple
        ref={lanUploadInputRef}
        onChange={handleUploadFilesSelected}
        className="hidden"
        aria-hidden="true"
      />
      {isAndroidDevice && isAndroidSelectionMode ? (
        <AndroidSelectionBar
          selectedCount={activeTab.selectedFileIds.length}
          totalCount={activeTab.viewMode === 'folders-overview' ? state.roots.filter(rid => state.files[rid]?.type === 'folder').length : displayFileIds.length}
          selectedFileIds={activeTab.selectedFileIds}
          files={state.files}
          activeTab={activeTab}
          peopleWithDisplayCounts={peopleWithDisplayCounts}
          t={t}
          onSelectAll={() => {
            if (activeTab.viewMode === 'folders-overview') {
              const folderIds = state.roots.filter(rid => state.files[rid]?.type === 'folder');
              updateActiveTab({ selectedFileIds: folderIds });
            } else {
              updateActiveTab({ selectedFileIds: displayFileIds });
            }
          }}
          onClearSelection={handleExitAndroidSelectionMode}
          onDeselectAll={handleDeselectAllAndroid}
          onDelete={handleAndroidDelete}
          onShowContextMenu={(x: number, y: number) => {
            const selectedItems = activeTab.selectedFileIds.map(fileId => state.files[fileId]);
            const allAreFolders = selectedItems.every(item => item && item.type === FileType.FOLDER);
            let menuType: 'file-single' | 'file-multi' | 'folder-single' | 'folder-multi';
            if (activeTab.selectedFileIds.length === 1) {
              const file = state.files[activeTab.selectedFileIds[0]];
              menuType = file?.type === FileType.FOLDER ? 'folder-single' : 'file-single';
            } else {
              menuType = allAreFolders ? 'folder-multi' : 'file-multi';
            }
            setContextMenu({ visible: true, x, y, type: menuType, targetId: activeTab.selectedFileIds[0] });
          }}
        />
      ) : (
        <TopBar
          activeTab={activeTab}
          state={state}
          toolbarQuery={toolbarQuery}
          groupedTags={groupedTags}
          tagSearchQuery={tagSearchQuery}
          onToggleSidebar={toggleSidebar}
          onGoBack={goBack}
          onGoForward={goForward}
          onNavigateUp={handleNavigateUp}
          onSetTagSearchQuery={setTagSearchQuery}
          onTagClick={handleTagClick}
          onRefresh={handleRefresh}
          onSearchScopeChange={(scope) => updateActiveTab({ searchScope: scope })}
          onPerformSearch={handlePerformSearch}
          onSetToolbarQuery={setToolbarQuery}
          onSetPersonSearchQuery={setPersonSearchQuery}
          personSearchQuery={personSearchQuery}
          onLayoutModeChange={(mode) => {
            updateActiveTab({ layoutMode: mode });
            // If not remembering this folder, update global default
            if (!state.folderSettings[activeTab.folderId]) {
              setState(s => ({
                ...s,
                settings: {
                  ...s.settings,
                  defaultLayoutSettings: {
                    ...(s.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS),
                    layoutMode: mode
                  }
                }
              }));
            }
          }}
          onSortOptionChange={(opt) => {
            // Reset scroll to top so the user sees the beginning of the new ordering
            // instead of jumping to a random place (the old scroll offset now maps
            // to different items after reordering).
            updateActiveTab({ scrollTop: 0 });
            setState(s => ({ ...s, sortBy: opt }));
            // If not remembering this folder, update global default
            if (!state.folderSettings[activeTab.folderId]) {
              setState(s => ({
                ...s,
                settings: {
                  ...s.settings,
                  defaultLayoutSettings: {
                    ...(s.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS),
                    sortBy: opt
                  }
                }
              }));
            }
          }}
          onSortDirectionChange={() => {
            // Reset scroll to top (see onSortOptionChange for rationale).
            updateActiveTab({ scrollTop: 0 });
            const newDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
            setState(s => ({ ...s, sortDirection: newDirection }));
            // If not remembering this folder, update global default
            if (!state.folderSettings[activeTab.folderId]) {
              setState(s => ({
                ...s,
                settings: {
                  ...s.settings,
                  defaultLayoutSettings: {
                    ...(s.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS),
                    sortDirection: newDirection
                  }
                }
              }));
            }
          }}
          onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
          onToggleMetadata={toggleMetadata}
          onToggleColorPicker={toggleColorPicker}
          isColorPickerVisible={state.layout.isColorPickerVisible}
          onToggleSettings={toggleSettings}
          onUpdateDateFilter={(f) => updateActiveTab({ dateFilter: f })}
          // Pagination
          totalResults={totalResults}
          pageSize={pageSize}
          onPageChange={(page) => updateActiveTab({ currentPage: page, scrollTop: 0 })}
          groupBy={groupBy}
          onGroupByChange={(groupByOption) => {
            setGroupBy(groupByOption);
            // If not remembering this folder, update global default
            if (!state.folderSettings[activeTab.folderId]) {
              setState(s => ({
                ...s,
                settings: {
                  ...s.settings,
                  defaultLayoutSettings: {
                    ...(s.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS),
                    groupBy: groupByOption
                  }
                }
              }));
            }
          }}
          isAISearchEnabled={state.settings.search.isAISearchEnabled}
          onToggleAISearch={() => setState(s => ({ ...s, settings: { ...s.settings, search: { ...s.settings.search, isAISearchEnabled: !s.settings.search.isAISearchEnabled } } }))}
          onRememberFolderSettings={activeTab.viewMode === 'browser' ? handleRememberFolderSettings : undefined}
          // Topic layout control (used when in topics-overview)
          topicLayoutMode={topicLayoutMode}
          onTopicLayoutModeChange={handleTopicLayoutModeChange}
          folderLayoutMode={folderLayoutMode}
          onFolderLayoutModeChange={handleFolderLayoutModeChange}
          hasFolderSettings={activeTab.viewMode === 'browser' ? !!state.folderSettings[activeTab.folderId] : false}
          // People view sort and group
          personSortBy={personSortBy}
          personSortDirection={personSortDirection}
          personGroupBy={personGroupBy}
          onPersonSortByChange={handlePersonSortByChange}
          onPersonSortDirectionChange={handlePersonSortDirectionChange}
          onPersonGroupByChange={handlePersonGroupByChange}
          t={t}
          // CLIP Search
          isClipSearchEnabled={isClipSearchEnabled}
          onToggleClipSearch={() => setIsClipSearchEnabled(!isClipSearchEnabled)}
          clipEnabled={state.settings.clip.enabled}
          clipModelName={state.settings.clip.modelName}
          onOpenClipSettings={openClipSettings}
          showToast={showToast}
          showLanUpload={showLanUpload}
          onUploadToLan={handleUploadToLan}
        />
      )}
    </>
  );
};
