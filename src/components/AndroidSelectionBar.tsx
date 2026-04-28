import React, { useState, useRef, useEffect } from 'react';
import {
  X, CheckCheck, Trash2, MoreVertical,
  Layout, ExternalLink, Copy, MoveHorizontal, Link,
  Type, Sparkles, User, XCircle, Tag, Clipboard,
  FolderPlus, Edit3, Scan, Plus, Search
} from 'lucide-react';
import { FileType, FileNode, TabState, Person, ClipSettings } from '../types';

interface AndroidSelectionBarProps {
  selectedCount: number;
  totalCount: number;
  selectedFileIds: string[];
  files: Record<string, FileNode>;
  activeTab: TabState;
  tabs: TabState[];
  peopleWithDisplayCounts: Record<string, Person>;
  aiConnectionStatus: string;
  displayFileIds: string[];
  clipSettings?: ClipSettings;
  t: (key: string) => string;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDeselectAll: () => void;
  onDelete: (ids: string[]) => void;
  handleOpenInNewTab: (id: string) => void;
  handleViewInExplorer: (id: string) => void;
  enterFolder: (id: string, options?: any) => void;
  setModal: (type: string, data?: any) => void;
  startRename: (id: string) => void;
  handleAIAnalysis: (ids: string[]) => void;
  handleClearPersonInfo: (fileIds: string[], personIds?: string[]) => void;
  handleCopyTags: (ids: string[]) => void;
  handlePasteTags: (ids: string[]) => void;
  showToast: (msg: string) => void;
  handleOpenCompareInNewTab: (ids: string[]) => void;
  handleAddToCompareCanvas: (tabId: string, imageIds: string[]) => void;
  handleCopyImageToClipboard: (fileId: string) => void;
  handleSearchSimilarImages?: (imageId: string) => void;
  openClipSettings?: () => void;
}

export const AndroidSelectionBar: React.FC<AndroidSelectionBarProps> = ({
  selectedCount,
  totalCount,
  selectedFileIds,
  files,
  activeTab,
  tabs,
  peopleWithDisplayCounts,
  aiConnectionStatus,
  displayFileIds,
  clipSettings,
  t,
  onSelectAll,
  onClearSelection,
  onDeselectAll,
  onDelete,
  handleOpenInNewTab,
  handleViewInExplorer,
  enterFolder,
  setModal,
  startRename,
  handleAIAnalysis,
  handleClearPersonInfo,
  handleCopyTags,
  handlePasteTags,
  showToast,
  handleOpenCompareInNewTab,
  handleAddToCompareCanvas,
  handleCopyImageToClipboard,
  handleSearchSimilarImages,
  openClipSettings,
}) => {
  const [moreMenuOpen, setMoreMenuOpen] = useState(false);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!moreMenuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (moreMenuRef.current && !moreMenuRef.current.contains(e.target as Node) &&
          moreButtonRef.current && !moreButtonRef.current.contains(e.target as Node)) {
        setMoreMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('touchstart', handleClick as any);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('touchstart', handleClick as any);
    };
  }, [moreMenuOpen]);

  const isSingleFile = selectedFileIds.length === 1;
  const isMultiFile = selectedFileIds.length > 1;
  const singleFileId = isSingleFile ? selectedFileIds[0] : null;
  const singleFile = singleFileId ? files[singleFileId] : null;
  const isFolder = singleFile?.type === FileType.FOLDER;

  const allSelectedImages = selectedFileIds.filter(id => files[id]?.type === FileType.IMAGE);
  const compareTabs = tabs.filter(tab => tab.isCompareMode);

  const allAreFiles = selectedFileIds.every(id => files[id]?.type !== FileType.FOLDER);

  return (
    <div className="h-14 bg-blue-600 dark:bg-blue-700 flex items-center px-3 justify-between shrink-0 z-30 android-topbar">
      <div className="flex items-center space-x-2 min-w-fit">
        <button
          onClick={onClearSelection}
          className="w-10 h-10 flex items-center justify-center rounded hover:bg-blue-500 text-white"
        >
          <X size={20} />
        </button>
        <span className="text-white font-semibold text-sm">
          {selectedCount}/{totalCount}
        </span>
      </div>

      <div className="flex items-center space-x-1">
        <button
          onClick={selectedCount === totalCount ? onDeselectAll : onSelectAll}
          className="w-10 h-10 flex items-center justify-center rounded hover:bg-blue-500 text-white"
          title={selectedCount === totalCount ? t('context.deselectAll') : t('context.selectAll')}
        >
          {selectedCount === totalCount ? <XCircle size={20} /> : <CheckCheck size={20} />}
        </button>

        <button
          onClick={() => onDelete(selectedFileIds)}
          className="w-10 h-10 flex items-center justify-center rounded hover:bg-blue-500 text-white"
          title={t('context.delete')}
        >
          <Trash2 size={20} />
        </button>

        <div className="relative">
          <button
            ref={moreButtonRef}
            onClick={() => setMoreMenuOpen(!moreMenuOpen)}
            className={`w-10 h-10 flex items-center justify-center rounded hover:bg-blue-500 text-white ${moreMenuOpen ? 'bg-blue-500' : ''}`}
          >
            <MoreVertical size={20} />
          </button>

          {moreMenuOpen && (
            <div
              ref={moreMenuRef}
              className="absolute right-0 top-full mt-2 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 min-w-[200px] z-[1001] max-h-[70vh] overflow-y-auto"
            >
              {isSingleFile && singleFileId && (
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { handleOpenInNewTab(singleFileId); setMoreMenuOpen(false); }}>
                  <Layout size={14} className="mr-2 opacity-70" />
                  {isFolder ? t('context.openFolderInNewTab') : t('context.openInNewTab')}
                </div>
              )}

              {isSingleFile && singleFileId && (
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { handleViewInExplorer(singleFileId); setMoreMenuOpen(false); }}>
                  <ExternalLink size={14} className="mr-2 opacity-70" />
                  {t('context.viewInExplorer')}
                </div>
              )}

              {isSingleFile && singleFile && singleFile.parentId && (() => {
                const isUnavailable = activeTab.viewMode === 'browser' && activeTab.folderId === singleFile.parentId;
                return (
                  <div className={`px-4 py-2 flex items-center ${isUnavailable ? 'text-gray-400 cursor-default' : 'hover:bg-blue-600 hover:text-white cursor-pointer text-gray-800 dark:text-gray-200'}`} onClick={() => { if (!isUnavailable && singleFile.parentId) { enterFolder(singleFile.parentId, { scrollToItemId: singleFile.id }); setMoreMenuOpen(false); } }}>
                    <FolderPlus size={14} className="mr-2 opacity-70" />
                    {t('context.openFolder')}
                  </div>
                );
              })()}

              <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>

              {isSingleFile && singleFileId && singleFile?.type === FileType.IMAGE && (
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { handleCopyImageToClipboard(singleFileId); setMoreMenuOpen(false); }}>
                  <Clipboard size={14} className="mr-2 opacity-70" />
                  {t('context.copyImage')}
                </div>
              )}

              {isSingleFile && singleFileId && singleFile?.type === FileType.IMAGE && clipSettings?.enabled && handleSearchSimilarImages && (
                <div className="px-4 py-2 hover:bg-cyan-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => {
                  if (!clipSettings?.modelName) {
                    showToast('请先选择视觉模型');
                    openClipSettings?.();
                    setMoreMenuOpen(false);
                    return;
                  }
                  handleSearchSimilarImages(singleFileId);
                  setMoreMenuOpen(false);
                }}>
                  <Search size={14} className="mr-2 opacity-70" />
                  {t('context.searchSimilar') || '搜索相似图片'}
                </div>
              )}

              <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { setModal('copy-to-folder', { fileIds: selectedFileIds }); setMoreMenuOpen(false); }}>
                <Copy size={14} className="mr-2 opacity-70" />
                {t('context.copyTo')}
              </div>

              <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { setModal('move-to-folder', { fileIds: selectedFileIds }); setMoreMenuOpen(false); }}>
                <MoveHorizontal size={14} className="mr-2 opacity-70" />
                {t('context.moveTo')}
              </div>

              {isSingleFile && isFolder && singleFileId && (
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { navigator.clipboard.writeText(files[singleFileId]?.path || ''); showToast(t('context.copied')); setMoreMenuOpen(false); }}>
                  <Link size={14} className="mr-2 opacity-70" />
                  {t('context.copyFolderPath')}
                </div>
              )}

              <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>

              {isSingleFile && singleFileId && (
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { startRename(singleFileId); setMoreMenuOpen(false); }}>
                  <Type size={14} className="mr-2 opacity-70" />
                  {t('context.rename')}
                </div>
              )}

              {isMultiFile && (
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { setModal('batch-rename', null); setMoreMenuOpen(false); }}>
                  <Type size={14} className="mr-2 opacity-70" />
                  {t('context.batchRename')}
                </div>
              )}

              {aiConnectionStatus === 'connected' && (
                <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { handleAIAnalysis(selectedFileIds); setMoreMenuOpen(false); }}>
                  <Sparkles size={14} className="mr-2 opacity-70" />
                  {t('context.aiAnalyze')}
                </div>
              )}

              {allSelectedImages.length >= 2 && allSelectedImages.length <= 24 && compareTabs.length === 0 && (
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { handleOpenCompareInNewTab(allSelectedImages); setMoreMenuOpen(false); }}>
                  <Scan size={14} className="mr-2 opacity-70" />
                  <div className="flex-1">{t('context.compareImages')}</div>
                  <div className="text-xs text-gray-500 ml-3">{`${allSelectedImages.length}/24`}</div>
                </div>
              )}

              {allSelectedImages.length >= 1 && allSelectedImages.length <= 24 && compareTabs.length > 0 && (
                <>
                  {compareTabs.map(tab => {
                    const currentCount = tab.selectedFileIds.length;
                    const remainingSpace = 24 - currentCount;
                    const canAdd = remainingSpace > 0 && allSelectedImages.length <= remainingSpace;
                    const canvasName = tab.sessionName || `画布${tab.id.slice(0, 4)}`;
                    return (
                      <div
                        key={tab.id}
                        className={canAdd
                          ? 'px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center justify-between text-gray-800 dark:text-gray-200'
                          : 'px-4 py-2 flex items-center justify-between text-gray-400 cursor-default opacity-60'
                        }
                        onClick={canAdd ? () => { handleAddToCompareCanvas(tab.id, allSelectedImages); setMoreMenuOpen(false); } : undefined}
                      >
                        <span className="truncate max-w-[120px]">{t('context.addToCanvas').replace('{name}', canvasName)}</span>
                        <span className="text-xs ml-2">{`${currentCount}/24`}</span>
                      </div>
                    );
                  })}
                  <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
                  <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { handleOpenCompareInNewTab(allSelectedImages); setMoreMenuOpen(false); }}>
                    <Plus size={14} className="mr-2 opacity-70" />
                    <span>{t('context.newCanvas')}</span>
                  </div>
                </>
              )}

              {Object.keys(peopleWithDisplayCounts).length > 0 && (
                <>
                  <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { setModal('add-to-person', null); setMoreMenuOpen(false); }}>
                    <User size={14} className="mr-2 opacity-70" />
                    {t('context.addToPerson')}
                  </div>
                  <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => {
                    const allPeople = new Set<string>();
                    let totalFaces = 0;
                    selectedFileIds.forEach(fid => {
                      const file = files[fid];
                      if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
                        file.aiData.faces.forEach(face => { allPeople.add(face.personId); });
                        totalFaces += file.aiData.faces.length;
                      }
                    });
                    if (totalFaces === 0) { setMoreMenuOpen(false); return; }
                    if (allPeople.size <= 1) {
                      handleClearPersonInfo(selectedFileIds);
                      setMoreMenuOpen(false);
                      showToast(t('context.saved'));
                    } else {
                      setModal('clear-person', { fileIds: selectedFileIds });
                      setMoreMenuOpen(false);
                    }
                  }}>
                    <XCircle size={14} className="mr-2 opacity-70" />
                    {t('context.clearPersonInfo')}
                  </div>
                </>
              )}

              <div className="px-4 py-2 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { setModal('add-to-topic', { fileIds: selectedFileIds }); setMoreMenuOpen(false); }}>
                <Layout size={14} className="mr-2 opacity-70" />
                {t('context.addToTopic') || '添加到主题'}
              </div>

              {isSingleFile && singleFileId && (
                <>
                  <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { setModal('edit-tags', { fileId: singleFileId }); setMoreMenuOpen(false); }}>
                    <Tag size={14} className="mr-2 opacity-70" />
                    {t('context.editTags')}
                  </div>
                  <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { handleCopyTags([singleFileId]); setMoreMenuOpen(false); }}>
                    <Copy size={14} className="mr-2 opacity-70" />
                    {t('context.copyTag')}
                  </div>
                </>
              )}

              {allAreFiles && (
                <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center text-gray-800 dark:text-gray-200" onClick={() => { handlePasteTags(selectedFileIds); setMoreMenuOpen(false); }}>
                  <Clipboard size={14} className="mr-2 opacity-70" />
                  {t('context.pasteTag')}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
