import React from 'react';
import { FoldersOverview } from '../FoldersOverview';
import { TopicModule } from '../TopicModule';
import { FileGrid } from '../FileGrid';
import { AppState, FileNode, FileGroup, GroupByOption, LayoutMode, Person, SortDirection, TabState, Topic } from '../../types';
import type { LayoutItem } from '../../hooks/useMarqueeSelection';

interface MainContentAreaProps {
  activeTab: TabState;
  state: AppState;
  displayFileIds: string[];
  getFileNode: (id: string) => FileNode | undefined;
  t: (key: string) => string;
  peopleForOverview: Record<string, Person>;
  groupedTags: Record<string, string[]>;
  groupBy: GroupByOption;
  collapsedGroups: Record<string, boolean>;
  toggleGroup: (id: string) => void;
  isSelecting: boolean;
  fileGridLayoutRef: React.MutableRefObject<LayoutItem[]>;
  overlayRef: React.RefObject<HTMLDivElement>;
  selectionRef: React.RefObject<HTMLDivElement>;
  handleScroll: () => void;
  enterFolder: (folderId: string, options?: { scrollToItemId?: string, resetScroll?: boolean }) => void;
  handleFolderScrollTopChange: (scrollTop: number) => void;
  handleFolderLayoutModeChange: (mode: LayoutMode) => void;
  folderLayoutMode: LayoutMode;
  isAndroidSelectionMode: boolean;
  handleFolderLongPress: (id: string) => void;
  handleShowContextMenuForFile: (id: string, x: number, y: number) => void;
  handleFolderAndroidRangeSelect: (id: string) => void;
  handleFolderOrderChange: (ids: string[]) => void;
  handleFolderSelect: (id: string) => void;
  handleRefresh: (folderId?: string) => Promise<void>;
  panelWidthRem: number;
  lanRoots: string[];
  handleNavigateNetworkFolder: (folderId: string) => void;
  lanLoading: boolean;
  handleLanRefresh: () => Promise<void>;
  handleNavigateTopic: (topicId: string | null) => void;
  handleUpdateTopic: (topicId: string, updates: Partial<Topic>) => void;
  handleCreateTopic: (parentId: string | null, name?: string, type?: string) => void;
  handleDeleteTopic: (topicId: string) => void;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  handlePersonClick: (personId: string, e: React.MouseEvent) => void;
  handleNavigatePerson: (personId: string | null) => void;
  handleOpenTopicInNewTab: (topicId: string) => void;
  handleOpenPersonInNewTab: (personId: string) => void;
  handleOpenInNewTab: (fileId: string) => void;
  handleNavigateFolder: (id: string, options?: { targetId?: string, resetScroll?: boolean }) => void;
  handleFileDoubleClick: (id: string) => void;
  handleFileLongPress: (id: string) => void;
  topicLayoutMode: LayoutMode;
  handleTopicLayoutModeChange: (mode: LayoutMode) => void;
  showToast: (msg: string) => void;
  hoverPlayingId: string | null;
  setHoverPlayingId: (id: string | null) => void;
  handleFileClick: (e: React.MouseEvent, id: string) => void;
  handleContextMenu: (e: React.MouseEvent, type: 'file' | 'tag' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person', id: string) => void;
  handleRenameSubmit: (id: string, newName: string) => void;
  startRename: (id: string) => void;
  handleMouseDown: (e: React.MouseEvent) => void;
  handleMouseMove: (e: React.MouseEvent) => void;
  handleMouseUp: (e: React.MouseEvent) => void;
  handleOverviewTagClick: (tag: string, e: React.MouseEvent) => void;
  enterPersonView: (personId: string) => void;
  enterTagView: (tagName: string) => void;
  groupedFiles: FileGroup[];
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  handleUpdateFile: (id: string, updates: Partial<FileNode>) => void;
  handleDropOnFolder: (targetFolderId: string, sourceIds: string[]) => void;
  isExternalDragging: boolean;
  isDraggingInternal: boolean;
  setIsDraggingInternal: (v: boolean) => void;
  setDraggedFilePaths: (paths: string[]) => void;
  handleAndroidRangeSelect: (id: string) => void;
  personSortBy: import('../../types').PersonSortOption;
  personSortDirection: SortDirection;
  personGroupBy: import('../../types').PersonGroupByOption;
}

// 主内容区：文件夹总览（本地/LAN）+ 专题模块 + 文件网格
export const MainContentArea = ({
  activeTab,
  state,
  displayFileIds,
  getFileNode,
  t,
  peopleForOverview,
  groupedTags,
  groupBy,
  collapsedGroups,
  toggleGroup,
  isSelecting,
  fileGridLayoutRef,
  overlayRef,
  selectionRef,
  handleScroll,
  enterFolder,
  handleFolderScrollTopChange,
  handleFolderLayoutModeChange,
  folderLayoutMode,
  isAndroidSelectionMode,
  handleFolderLongPress,
  handleShowContextMenuForFile,
  handleFolderAndroidRangeSelect,
  handleFolderOrderChange,
  handleFolderSelect,
  handleRefresh,
  panelWidthRem,
  lanRoots,
  handleNavigateNetworkFolder,
  lanLoading,
  handleLanRefresh,
  handleNavigateTopic,
  handleUpdateTopic,
  handleCreateTopic,
  handleDeleteTopic,
  updateActiveTab,
  handlePersonClick,
  handleNavigatePerson,
  handleOpenTopicInNewTab,
  handleOpenPersonInNewTab,
  handleOpenInNewTab,
  handleNavigateFolder,
  handleFileDoubleClick,
  handleFileLongPress,
  topicLayoutMode,
  handleTopicLayoutModeChange,
  showToast,
  hoverPlayingId,
  setHoverPlayingId,
  handleFileClick,
  handleContextMenu,
  handleRenameSubmit,
  startRename,
  handleMouseDown,
  handleMouseMove,
  handleMouseUp,
  handleOverviewTagClick,
  enterPersonView,
  enterTagView,
  groupedFiles,
  setState,
  handleUpdateFile,
  handleDropOnFolder,
  isExternalDragging,
  isDraggingInternal,
  setIsDraggingInternal,
  setDraggedFilePaths,
  handleAndroidRangeSelect,
  personSortBy,
  personSortDirection,
  personGroupBy,
}: MainContentAreaProps) => {
  return (
    <div className="flex-1 overflow-hidden relative" id="main-content-area">
      <div style={{ display: activeTab.viewMode === 'folders-overview' ? 'contents' : 'none' }}>
        <FoldersOverview
          roots={state.roots}
          getFileNode={getFileNode}
          resourceRoot={state.settings.paths.resourceRoot}
          cachePath={state.settings.paths.cacheRoot}
          onFolderClick={enterFolder}
          thumbnailSize={state.thumbnailSize}
          onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
          t={t}
          isLoadingImages={state.isScanning}
          layoutMode={folderLayoutMode}
          onLayoutModeChange={handleFolderLayoutModeChange}
          isVisible={activeTab.viewMode === 'folders-overview'}
          scrollTop={activeTab.viewMode === 'folders-overview' ? activeTab.scrollTop : undefined}
          onScrollTopChange={handleFolderScrollTopChange}
          isAndroidSelectionMode={isAndroidSelectionMode}
          selectedFileIds={activeTab.selectedFileIds}
          onFileLongPress={handleFolderLongPress}
          onShowContextMenuForFile={handleShowContextMenuForFile}
          onAndroidRangeSelect={handleFolderAndroidRangeSelect}
          onFolderSelect={handleFolderSelect}
          onDisplayedIdsChange={handleFolderOrderChange}
          sortBy={state.sortBy}
          sortDirection={state.sortDirection}
          dateFilter={activeTab.dateFilter}
          onRefresh={() => handleRefresh()}
          panelWidthRem={panelWidthRem}
        />
      </div>
      <div style={{ display: activeTab.viewMode === 'lan-folders-overview' ? 'contents' : 'none' }}>
        <FoldersOverview
          roots={lanRoots}
          getFileNode={getFileNode}
          resourceRoot={state.settings.paths.resourceRoot}
          cachePath={state.settings.paths.cacheRoot}
          onFolderClick={handleNavigateNetworkFolder}
          thumbnailSize={state.thumbnailSize}
          onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
          t={t}
          isLoadingImages={lanLoading}
          layoutMode={folderLayoutMode}
          onLayoutModeChange={handleFolderLayoutModeChange}
          isVisible={activeTab.viewMode === 'lan-folders-overview'}
          isAndroidSelectionMode={isAndroidSelectionMode}
          selectedFileIds={activeTab.selectedFileIds}
          onFileLongPress={handleFolderLongPress}
          onShowContextMenuForFile={handleShowContextMenuForFile}
          onAndroidRangeSelect={handleFolderAndroidRangeSelect}
          onFolderSelect={handleFolderSelect}
          onDisplayedIdsChange={handleFolderOrderChange}
          sortBy={state.sortBy}
          sortDirection={state.sortDirection}
          onRefresh={handleLanRefresh}
          panelWidthRem={panelWidthRem}
        />
      </div>
      {activeTab.viewMode === 'topics-overview' ? (
        <TopicModule
          topics={state.topics}
          files={state.files}
          people={peopleForOverview}
          currentTopicId={activeTab.activeTopicId || null}
          selectedTopicIds={activeTab.selectedTopicIds || []} // Pass selectedTopicIds
          onNavigateTopic={handleNavigateTopic}
          onUpdateTopic={handleUpdateTopic}
          onCreateTopic={handleCreateTopic}
          onDeleteTopic={handleDeleteTopic}
          onSelectTopics={(ids, lastId) => {
            updateActiveTab({ selectedTopicIds: ids, selectedFileIds: [], selectedPersonIds: [], lastSelectedId: lastId ?? null });
          }}
          // onSelectFiles now accepts lastSelectedId; update to set both selectedFileIds and lastSelectedId
          onSelectFiles={(ids, lastId) => {
            updateActiveTab({ selectedFileIds: ids, selectedTopicIds: [], selectedPersonIds: [], lastSelectedId: lastId ?? null });
          }}
          onSelectPeople={(ids) => {
            updateActiveTab({ selectedPersonIds: ids, selectedFileIds: [], selectedTopicIds: [] });
          }}
          onSelectPerson={(pid, e) => {
            const isMultiSelect = e.ctrlKey || e.metaKey || e.shiftKey;
            if (!isMultiSelect) {
              updateActiveTab({ selectedFileIds: [], selectedTopicIds: [] });
            }
            handlePersonClick(pid, e);
          }}
          onNavigatePerson={handleNavigatePerson}
          onOpenTopicInNewTab={handleOpenTopicInNewTab}
          // New-tab & open-folder handlers for people/files inside TopicModule
          onOpenPersonInNewTab={handleOpenPersonInNewTab}
          onOpenFileInNewTab={handleOpenInNewTab}
          onOpenFileFolder={handleNavigateFolder}
          selectedFileIds={activeTab.selectedFileIds}
          selectedPersonIds={activeTab.selectedPersonIds}
          lastSelectedId={activeTab.lastSelectedId}
          // Provide resource root / cache for thumbnails and open action
          resourceRoot={state.settings.paths.resourceRoot}
          cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)}
          onOpenFile={handleFileDoubleClick}
          onFileLongPress={handleFileLongPress}
          t={t}
          scrollTop={activeTab.scrollTop}
          onScrollTopChange={(scrollTop) => { updateActiveTab({ scrollTop }); }}
          isVisible={!activeTab.viewingFileId}
          topicLayoutMode={(topicLayoutMode === 'grid' || topicLayoutMode === 'adaptive' || topicLayoutMode === 'masonry') ? topicLayoutMode : 'grid'}
          onTopicLayoutModeChange={handleTopicLayoutModeChange}
          onShowToast={showToast}
          hoverPlayingId={hoverPlayingId}
          onSetHoverPlayingId={setHoverPlayingId}
          onSmartCreateTopic={() => setState(prev => ({ ...prev, activeModal: { type: 'smart-create-topic', data: {} } }))}
        />
      ) : (
        <FileGrid
          displayFileIds={displayFileIds}
          isVisible={!activeTab.viewingFileId}
          getFileNode={getFileNode}
          files={activeTab.viewMode === 'tags-overview' || activeTab.viewMode === 'people-overview' ? state.files : undefined}
          activeTab={activeTab}
          sortBy={state.sortBy}
          sortDirection={state.sortDirection}
          renamingId={state.renamingId}
          thumbnailSize={state.thumbnailSize}
          resourceRoot={state.settings.paths.resourceRoot}
          cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)}
          hoverPlayingId={hoverPlayingId}
          onSetHoverPlayingId={setHoverPlayingId}
          onFileClick={handleFileClick}
          onFileDoubleClick={handleFileDoubleClick}
          onContextMenu={(e, id) => handleContextMenu(e, 'file', id)}
          onRenameSubmit={handleRenameSubmit}
          onRenameCancel={() => setState(s => ({ ...s, renamingId: null }))}
          onStartRename={startRename}
          settings={state.settings}
          containerRef={selectionRef}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onBackgroundContextMenu={(e) => handleContextMenu(e, 'background', '')}
          people={peopleForOverview}
          topics={state.topics}
          groupedTags={groupedTags}
          onPersonClick={(pid, e) => handlePersonClick(pid, e)}
          onPersonContextMenu={(e, pid) => handleContextMenu(e, 'person', pid)}
          onPersonDoubleClick={(pid) => enterPersonView(pid)}
          onStartRenamePerson={(personId) => setState(s => ({ ...s, activeModal: { type: 'rename-person', data: { personId } } }))}
          onTagClick={(tag, e) => handleOverviewTagClick(tag, e)}
          onTagContextMenu={(e, tag) => handleContextMenu(e, 'tag', tag)}
          onTagDoubleClick={(tag) => enterTagView(tag)}
          groupedFiles={groupedFiles}
          groupBy={groupBy}
          collapsedGroups={collapsedGroups}
          onToggleGroup={toggleGroup}
          isSelecting={isSelecting}
          layoutItemsRef={fileGridLayoutRef}
          marqueeOverlayRef={overlayRef}
          onScrollTopChange={(scrollTop) => { updateActiveTab({ scrollTop }); }}
          onConsumeScrollToItem={() => updateActiveTab({ scrollToItemId: undefined })}
          onScroll={handleScroll}
          t={t}
          onThumbnailSizeChange={(size) => setState(s => ({ ...s, thumbnailSize: size }))}
          onUpdateFile={handleUpdateFile}
          onDropOnFolder={handleDropOnFolder}
          onDragStart={(fileIds) => setState(s => ({ ...s, dragState: { ...s.dragState, isDragging: true, draggedFileIds: fileIds } }))}
          onDragEnd={() => setState(s => ({ ...s, dragState: { ...s.dragState, isDragging: false } }))}
          isDraggingOver={isExternalDragging}
          dragOverTarget={state.dragState.dragOverFolderId}
          isDraggingInternal={isDraggingInternal}
          setIsDraggingInternal={setIsDraggingInternal}
          setDraggedFilePaths={setDraggedFilePaths}
          draggedFileIds={state.dragState.draggedFileIds}
          onFileLongPress={handleFileLongPress}
          onShowContextMenuForFile={handleShowContextMenuForFile}
          isAndroidSelectionMode={isAndroidSelectionMode}
          onAndroidRangeSelect={handleAndroidRangeSelect}
          personSortBy={personSortBy}
          personSortDirection={personSortDirection}
          personGroupBy={personGroupBy}
          onRefresh={() => handleRefresh(activeTab.folderId)}
          panelWidthRem={panelWidthRem}
        />
      )}
    </div>
  );
};
