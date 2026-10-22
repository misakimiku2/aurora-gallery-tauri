import React from 'react';
import { ImageViewer } from '../ImageViewer';
import { ImageComparer } from '../ImageComparer';
import { ImageEditor } from '../editor/ImageEditor';
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
  /** 图片编辑（C11）：网格右键与查看器右键共用同一个实现（App 侧单点定义） */
  onOpenEditor?: (fileId: string) => void;
  /** 编辑器导出成功后回调（参数为导出到的完整路径），用于重扫目标文件夹 */
  onEditorFileCreated?: (targetPath: string) => void | Promise<void>;
  /** 新建空白文档：由 App 开一个新标签页（一个 Tab 一个文档） */
  onEditorNewDocument?: (canvas: { width: number; height: number; background: 'transparent' | 'white' | 'black' }) => void;
  /** 编辑器文档栏两端的面板开关（复用应用 TopBar 的同一套） */
  onToggleSidebar: () => void;
  isSidebarVisible: boolean;
  onToggleMetadata: () => void;
  isMetadataVisible: boolean;
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
  onOpenEditor,
  onEditorFileCreated,
  onEditorNewDocument,
  onToggleSidebar,
  isSidebarVisible,
  onToggleMetadata,
  isMetadataVisible,
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
      {/* 导航序列：混排图片与视频，只排除文件夹（设计文档 §5.1 最致命的一处）。
          旧实现 === IMAGE 会把视频排除在「上一个/下一个」环之外，导致视频无法参与连续翻页。 */}
      {activeTab.viewingFileId && !isAndroidSync() && (
        <ImageViewer
          file={state.files[activeTab.viewingFileId]}
          sortedFileIds={displayFileIds.filter(id => state.files[id].type !== FileType.FOLDER)}
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
          onOpenEditor={onOpenEditor}
          isAISearchEnabled={state.settings.search.isAISearchEnabled}
          onToggleAISearch={() => setState(s => ({ ...s, settings: { ...s.settings, search: { ...s.settings.search, isAISearchEnabled: !s.settings.search.isAISearchEnabled } } }))}
          t={t}
          activeTab={activeTab}
          tabs={state.tabs}
          handleOpenCompareInNewTab={handleOpenCompareAndClearSelection}
          handleAddToCompareCanvas={handleAddToCompareCanvas}
        />
      )}
      {/* 图片编辑器（C11）：与参考模式互斥——`viewMode === 'editor'` 与 `isCompareMode`
          不会同时成立（入口处强制清掉另一个），所以这里不需要额外的互斥门控。 */}
      {state.tabs.map(tab => tab.viewMode === 'editor' && (
        <div key={tab.id} className={`w-full h-full flex-1 flex flex-col overflow-hidden ${tab.id === state.activeTabId ? 'flex' : 'hidden'}`}>
          <ImageEditor
            tabId={tab.id}
            // v2：整份文档交给编辑器，不再"逐个字段喂"——
            // 那种写法每加一个字段就要补一处，已经漏过两次（面板旧尺寸、调色没反应）。
            document={tab.editorDocument}
            tool={tab.editorTool ?? 'move'}
            onToolChange={t => updateTabById(tab.id, { editorTool: t })}
            isActive={tab.id === state.activeTabId}
            onToggleSidebar={onToggleSidebar}
            isSidebarVisible={isSidebarVisible}
            onToggleMetadata={onToggleMetadata}
            isMetadataVisible={isMetadataVisible}
            onFileCreated={onEditorFileCreated}
            onNewDocument={onEditorNewDocument}
            onDocumentChange={next =>
              updateTabById(tab.id, { editorDocument: next })
            }
          />
        </div>
      ))}
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
