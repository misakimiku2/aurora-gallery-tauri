import React from 'react';
import { ImageViewer } from '../ImageViewer';
import { ImageComparer } from '../ImageComparer';
import { isAndroidSync } from '../../utils/androidPlatform';
import { AppState, FileNode, FileType, TabState } from '../../types';

interface ViewerPaneProps {
  activeTab: TabState;
  state: AppState;
  displayFileIds: string[];
  t: (key: string) => string;
  onLayoutToggle: (part: 'sidebar' | 'metadata') => void;
  closeViewer: () => void;
  handleViewerNavigate: (direction: 'next' | 'prev' | 'random') => void;
  goBack: () => void;
  goForward: () => void;
  isAndroidDevice: boolean;
  handleAndroidDelete: (ids: string[]) => void;
  requestDelete: (ids: string[]) => void;
  handleViewInExplorer: (id: string) => void;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  enterFolder: (folderId: string, options?: { scrollToItemId?: string, resetScroll?: boolean }) => void;
  handleViewerSearch: (query: string) => void;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  handlePasteTags: (targetIds: string[]) => void;
  handleCopyTags: (ids: string[]) => void;
  handleAIAnalysis: (ids: string[]) => void;
  handleOpenCompareAndClearSelection: (imageIds: string[]) => void;
  handleAddToCompareCanvas: (tabId: string, imageIds: string[]) => void;
  updateTabById: (tabId: string, updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  handleCloseTab: (e: any, id: string) => void;
  setIsReferenceMode: React.Dispatch<React.SetStateAction<boolean>>;
  handleReferenceModeChange: (inReferenceMode: boolean) => void;
  isReferenceMode: boolean;
}

// 查看器区域：大图预览（ImageViewer）+ 图片对比画布（ImageComparer）
export const ViewerPane = ({
  activeTab,
  state,
  displayFileIds,
  t,
  onLayoutToggle,
  closeViewer,
  handleViewerNavigate,
  goBack,
  goForward,
  isAndroidDevice,
  handleAndroidDelete,
  requestDelete,
  handleViewInExplorer,
  setState,
  enterFolder,
  handleViewerSearch,
  updateActiveTab,
  handlePasteTags,
  handleCopyTags,
  handleAIAnalysis,
  handleOpenCompareAndClearSelection,
  handleAddToCompareCanvas,
  updateTabById,
  handleCloseTab,
  setIsReferenceMode,
  handleReferenceModeChange,
  isReferenceMode,
}: ViewerPaneProps) => {
  return (
    <>
      {activeTab.viewingFileId && !isAndroidSync() && (
        <ImageViewer
          file={state.files[activeTab.viewingFileId]}
          sortedFileIds={displayFileIds.filter(id => state.files[id].type === FileType.IMAGE)}
          files={state.files}
          layout={state.layout}
          slideshowConfig={state.slideshowConfig}
          onLayoutToggle={onLayoutToggle}
          onClose={closeViewer}
          onNext={(random) => handleViewerNavigate(random ? 'random' : 'next')}
          onPrev={() => handleViewerNavigate('prev')}
          onNavigateBack={goBack}
          onNavigateForward={goForward}
          canGoBack={activeTab.history.currentIndex > 0}
          canGoForward={activeTab.history.currentIndex < activeTab.history.stack.length - 1}
          onDelete={(id) => isAndroidDevice ? handleAndroidDelete([id]) : requestDelete([id])}
          onViewInExplorer={handleViewInExplorer}
          onCopyToFolder={(fileId) => setState(s => ({ ...s, activeModal: { type: 'copy-to-folder', data: { fileIds: [fileId] } } }))}
          onMoveToFolder={(fileId) => setState(s => ({ ...s, activeModal: { type: 'move-to-folder', data: { fileIds: [fileId] } } }))}
          onNavigateToFolder={(fid, options) => enterFolder(fid, options && options.targetId ? { scrollToItemId: options.targetId } : undefined)}
          searchQuery={activeTab.searchQuery}
          onSearch={handleViewerSearch}
          searchScope={activeTab.searchScope}
          onSearchScopeChange={(scope) => updateActiveTab({ searchScope: scope })}
          onUpdateSlideshowConfig={(cfg) => setState(s => ({ ...s, slideshowConfig: cfg }))}
          onPasteTags={(id) => handlePasteTags([id])}
          onEditTags={() => setState(s => ({ ...s, activeModal: { type: 'edit-tags', data: { fileId: activeTab.viewingFileId } } }))}
          onCopyTags={() => handleCopyTags([activeTab.viewingFileId!])}
          onAIAnalysis={(id) => handleAIAnalysis([id])}
          isAISearchEnabled={state.settings.search.isAISearchEnabled}
          onToggleAISearch={() => setState(s => ({ ...s, settings: { ...s.settings, search: { ...s.settings.search, isAISearchEnabled: !s.settings.search.isAISearchEnabled } } }))}
          t={t}
          activeTab={activeTab}
          tabs={state.tabs}
          handleOpenCompareInNewTab={handleOpenCompareAndClearSelection}
          handleAddToCompareCanvas={handleAddToCompareCanvas}
        />
      )}
      {state.tabs.map(tab => tab.isCompareMode && (
        <div key={tab.id} className={`w-full h-full flex-1 flex flex-col overflow-hidden ${tab.id === state.activeTabId ? 'flex' : 'hidden'}`}>
          <ImageComparer
            selectedFileIds={tab.selectedFileIds}
            files={state.files}
            people={state.people}
            topics={state.topics}
            customTags={state.customTags}
            resourceRoot={state.settings.paths.resourceRoot}
            cachePath={state.settings.paths.cacheRoot}
            isActiveTab={tab.id === state.activeTabId}
            onClose={() => {
              updateTabById(tab.id, { isCompareMode: false });
              setIsReferenceMode(false);
            }}
            onCloseTab={() => {
              handleCloseTab({ stopPropagation: () => { } } as any, tab.id);
              setIsReferenceMode(false);
            }}
            onReady={() => {
              // 图片加载完成后的回调，不需要清空 selectedFileIds
              // 保留此回调用于未来可能的用途
            }}
            onLayoutToggle={onLayoutToggle}
            onNavigateBack={goBack}
            onSelect={(id) => updateTabById(tab.id, { selectedFileIds: [id] })}
            onSelectedFileIdsChange={(ids) => updateTabById(tab.id, { selectedFileIds: ids })}
            sessionName={tab.sessionName}
            onSessionNameChange={(name) => updateTabById(tab.id, { sessionName: name })}
            layoutProp={state.layout}
            canGoBack={tab.history.currentIndex > 0}
            t={t}
            onReferenceModeChange={handleReferenceModeChange}
            isReferenceMode={isReferenceMode}
          />
        </div>
      ))}
    </>
  );
};
