
import React from 'react';
import { 
  Layout, ExternalLink, FolderOpen, Copy, MoveHorizontal, Link, 
  Type, Sparkles, User, XCircle, Tag, Clipboard, Image as ImageIcon, 
  Trash2, FolderPlus, ChevronsDown, ChevronsUp, Edit3, Crop, 
  RefreshCw, MousePointer2 
} from 'lucide-react';
import { FileType, FileNode, Person, TabState } from '../types';

interface ContextMenuProps {
  contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    type: 'file-single' | 'file-multi' | 'folder-single' | 'folder-multi' | 'tag-single' | 'tag-multi' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person' | null;
    targetId?: string;
  };
  files: Record<string, FileNode>;
  activeTab: TabState;
  peopleWithDisplayCounts: Record<string, Person>;
  aiConnectionStatus: string;
  displayFileIds: string[];
  t: (key: string) => string;
  closeContextMenu: () => void;
  handleOpenInNewTab: (id: string) => void;
  handleViewInExplorer: (id: string) => void;
  enterFolder: (id: string, options?: any) => void;
  setModal: (type: string, data?: any) => void;
  startRename: (id: string) => void;
  handleFolderAIAnalysis: (id: string) => void;
  handleAIAnalysis: (ids: string[]) => void;
  handleClearPersonInfo: (fileIds: string[], personIds?: string[]) => void;
  handleGenerateThumbnails: (ids: string[]) => void;
  requestDelete: (ids: string[]) => void;
  handleCreateFolder: (parentId?: string) => void;
  handleExpandAll: (id: string) => void;
  handleCollapseAll: (id: string) => void;
  enterTagView: (tag: string) => void;
  requestDeleteTags: (tags: string[]) => void;
  handleSetAvatar: (id: string) => void;
  handleCreatePerson: () => void;
  handleCloseTab: (e: any, id: string) => void;
  handleCloseOtherTabs: (id: string) => void;
  handleCloseAllTabs: () => void;
  handleRefresh: () => void;
  handleCreateNewTag: () => void;
  handleCopyTags: (ids: string[]) => void;
  handlePasteTags: (ids: string[]) => void;
  showToast: (msg: string) => void;
  updateActiveTab: (updates: Partial<TabState>) => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  contextMenu,
  files,
  activeTab,
  peopleWithDisplayCounts,
  aiConnectionStatus,
  displayFileIds,
  t,
  closeContextMenu,
  handleOpenInNewTab,
  handleViewInExplorer,
  enterFolder,
  setModal,
  startRename,
  handleFolderAIAnalysis,
  handleAIAnalysis,
  handleClearPersonInfo,
  handleGenerateThumbnails,
  requestDelete,
  handleCreateFolder,
  handleExpandAll,
  handleCollapseAll,
  enterTagView,
  requestDeleteTags,
  handleSetAvatar,
  handleCreatePerson,
  handleCloseTab,
  handleCloseOtherTabs,
  handleCloseAllTabs,
  handleRefresh,
  handleCreateNewTag,
  handleCopyTags,
  handlePasteTags,
  showToast,
  updateActiveTab
}) => {
  if (!contextMenu.visible) return null;

  return (
    <div 
      data-testid="context-menu" 
      className={`fixed bg-white ${['file-single', 'file-multi', 'folder-single', 'folder-multi', 'person'].includes(contextMenu.type || '')
        ? 'dark:bg-gray-800'
        : 'dark:bg-gray-800'
        } border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 min-w-[180px] z-[60] max-h-[80vh] overflow-y-auto`} 
      style={{
        left: 0,
        top: 0,
        position: 'fixed',
        zIndex: 60
      }} 
      ref={(el) => {
        if (el) {
          const rect = el.getBoundingClientRect();
          const menuWidth = rect.width;
          const menuHeight = rect.height;
          const screenWidth = window.innerWidth;
          const screenHeight = window.innerHeight;

          let x = contextMenu.x;
          if (x + menuWidth > screenWidth) {
            x = screenWidth - menuWidth;
          }
          if (x < 0) {
            x = 0;
          }

          let y = contextMenu.y;
          if (y + menuHeight > screenHeight) {
            y = screenHeight - menuHeight;
          }
          if (y < 0) {
            y = 0;
          }

          el.style.left = `${x}px`;
          el.style.top = `${y}px`;
        }
      }}
    >
      {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi' || contextMenu.type === 'folder-single' || contextMenu.type === 'folder-multi') && (<>
        {contextMenu.type !== 'file-multi' && (
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleOpenInNewTab(contextMenu.targetId!); closeContextMenu(); }}>
            <Layout size={14} className="mr-2 opacity-70" />
            {contextMenu.type === 'folder-single' ? t('context.openFolderInNewTab') : t('context.openInNewTab')}
          </div>
        )}

        <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleViewInExplorer(contextMenu.targetId!); closeContextMenu(); }}><ExternalLink size={14} className="mr-2 opacity-70" /> {t('context.viewInExplorer')}</div>
        {contextMenu.type === 'file-single' && files[contextMenu.targetId!] && ((() => {
          const file = files[contextMenu.targetId!]; const parentId = file.parentId; const isUnavailable = activeTab.viewMode === 'browser' && activeTab.folderId === parentId; return (<div className={`px-4 py-2 flex items-center ${isUnavailable ? 'text-gray-400 cursor-default' : 'hover:bg-blue-600 hover:text-white cursor-pointer'}`} onClick={() => { if (!isUnavailable && parentId) { enterFolder(parentId, { scrollToItemId: file.id }); closeContextMenu(); } }}>
            <FolderOpen size={14} className="mr-2 opacity-70" />
            {t('context.openFolder')}
          </div>);
        })())}
        <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>

        <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('copy-to-folder', { fileIds: activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : contextMenu.targetId ? [contextMenu.targetId] : [] }); closeContextMenu(); }}>
          <Copy size={14} className="mr-2 opacity-70" />
          {t('context.copyTo')}
        </div>
        <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('move-to-folder', { fileIds: activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : contextMenu.targetId ? [contextMenu.targetId] : [] }); closeContextMenu(); }}>
          <MoveHorizontal size={14} className="mr-2 opacity-70" />
          {t('context.moveTo')}
        </div>
        {contextMenu.type === 'folder-single' && (<div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { navigator.clipboard.writeText(files[contextMenu.targetId!]?.path || ''); showToast(t('context.copied')); closeContextMenu(); }}>
          <Link size={14} className="mr-2 opacity-70" />
          {t('context.copyFolderPath')}
        </div>)}
        <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
        {(contextMenu.type === 'file-single' || contextMenu.type === 'folder-single') && contextMenu.targetId && (<div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { startRename(contextMenu.targetId!); closeContextMenu(); }}>
          <Type size={14} className="mr-2 opacity-70" />
          {t('context.rename')}
        </div>)}
        {contextMenu.type === 'folder-single' && contextMenu.targetId && aiConnectionStatus === 'connected' && (
          <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
            handleFolderAIAnalysis(contextMenu.targetId!);
            closeContextMenu();
          }}>
            <Sparkles size={14} className="mr-2 opacity-70" /> {t('context.aiAnalyze')}
          </div>
        )}
        {contextMenu.type === 'file-single' && contextMenu.targetId && aiConnectionStatus === 'connected' && (
          <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
            handleAIAnalysis([contextMenu.targetId!]);
            closeContextMenu();
          }}>
            <Sparkles size={14} className="mr-2 opacity-70" /> {t('context.aiAnalyze')}
          </div>
        )}
        {contextMenu.type === 'file-multi' && (() => {
          const imageIds = activeTab.selectedFileIds.filter(id => files[id]?.type === FileType.IMAGE);
          if (imageIds.length >= 2 && imageIds.length <= 24) {
            return (
              <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { updateActiveTab({ isCompareMode: true }); closeContextMenu(); }}>
                <ImageIcon size={14} className="mr-2 opacity-70" />
                {t('context.compareImages')}
              </div>
            );
          }
          return null;
        })()}
        {contextMenu.type === 'file-multi' && (<div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('batch-rename', null); closeContextMenu(); }}>
          <Type size={14} className="mr-2 opacity-70" />
          {t('context.batchRename')}
        </div>)}
        {(contextMenu.type === 'file-multi') && aiConnectionStatus === 'connected' && (
          <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
            handleAIAnalysis(activeTab.selectedFileIds);
            closeContextMenu();
          }}>
            <Sparkles size={14} className="mr-2 opacity-70" /> {t('context.aiAnalyze')}
          </div>
        )}
        {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi') && Object.keys(peopleWithDisplayCounts).length > 0 && (<> <div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('add-to-person', null); closeContextMenu(); }}><User size={14} className="mr-2 opacity-70" /> {t('context.addToPerson')}</div><div className="px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
          const fileIds = activeTab.selectedFileIds;
          const allPeople = new Set<string>();
          let totalFaces = 0;

          fileIds.forEach(fid => {
            const file = files[fid];
            if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
              file.aiData.faces.forEach(face => {
                allPeople.add(face.personId);
              });
              totalFaces += file.aiData.faces.length;
            }
          });

          if (totalFaces === 0) {
            closeContextMenu();
            return;
          }

          if (allPeople.size <= 1) {
            handleClearPersonInfo(fileIds);
            closeContextMenu();
            showToast(t('context.saved'));
          } else {
            setModal('clear-person', { fileIds });
            closeContextMenu();
          }
        }}><XCircle size={14} className="mr-2 opacity-70" /> {t('context.clearPersonInfo')}</div></>)}
        {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi') && (<div className="px-4 py-2 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center" onClick={() => { const targetIds = activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : (contextMenu.targetId ? [contextMenu.targetId] : []); setModal('add-to-topic', { fileIds: targetIds }); closeContextMenu(); }}><Layout size={14} className="mr-2 opacity-70" /> {t('context.addToTopic') || '添加到主题'}</div>)}
        {contextMenu.type === 'file-single' && contextMenu.targetId && (<>
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('edit-tags', { fileId: contextMenu.targetId! }); closeContextMenu(); }}>
            <Tag size={14} className="mr-2 opacity-70" />
            {t('context.editTags')}
          </div>
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleCopyTags([contextMenu.targetId!]); closeContextMenu(); }}>
            <Copy size={14} className="mr-2 opacity-70" />
            {t('context.copyTag')}
          </div>
        </>)}
        {(() => {
          const allAreFiles = activeTab.selectedFileIds.every(id => {
            const file = files[id];
            return file && file.type !== FileType.FOLDER;
          });
          return allAreFiles && (<div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handlePasteTags(activeTab.selectedFileIds); closeContextMenu(); }}>
            <Clipboard size={14} className="mr-2 opacity-70" />
            {t('context.pasteTag')}
          </div>);
        })()}

        {(contextMenu.type === 'folder-single' || contextMenu.type === 'folder-multi') && (
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => {
            const folderIds = contextMenu.type === 'folder-single' ? [contextMenu.targetId!] : activeTab.selectedFileIds;
            handleGenerateThumbnails(folderIds);
            closeContextMenu();
          }}>
            <ImageIcon size={14} className="mr-2 opacity-70" /> {t('context.generateThumbnails')}
          </div>
        )}

        <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
        <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center" onClick={() => { requestDelete(activeTab.selectedFileIds); closeContextMenu(); }}><Trash2 size={14} className="mr-2" /> {t('context.delete')}</div>
      </>)}
      {contextMenu.type === 'root-folder' && contextMenu.targetId && (<> <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleCreateFolder(contextMenu.targetId); closeContextMenu(); }}><FolderPlus size={14} className="mr-2 opacity-70" /> {t('context.createSubfolder')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleExpandAll(contextMenu.targetId!); closeContextMenu(); }}><ChevronsDown size={14} className="mr-2 opacity-70" /> {t('context.expandAll')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleCollapseAll(contextMenu.targetId!); closeContextMenu(); }}><ChevronsUp size={14} className="mr-2 opacity-70" /> {t('context.collapseAll')}</div> </>)}
      {(contextMenu.type === 'tag-single' || contextMenu.type === 'tag-multi') && contextMenu.targetId && (<>
        {contextMenu.type === 'tag-multi' ? (
          <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center" onClick={() => {
            requestDeleteTags(activeTab.selectedTagIds);
            closeContextMenu();
          }}>
            <Trash2 size={14} className="mr-2 opacity-70" /> {t('context.deleteTag')}
          </div>
        ) : (
          <>
            <div className="px-4 py-2 font-bold bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-600 mb-1">{contextMenu.targetId}</div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { enterTagView(contextMenu.targetId!); closeContextMenu(); }}>{t('context.viewTagged')}</div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { navigator.clipboard.writeText(contextMenu.targetId!); closeContextMenu(); }}>{t('context.copyName')}</div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('rename-tag', { tag: contextMenu.targetId! }); closeContextMenu(); }}><Edit3 size={14} className="mr-2 opacity-70" /> {t('context.renameTag')}</div>
            <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
            <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer" onClick={() => { requestDeleteTags(activeTab.selectedTagIds.length > 0 ? activeTab.selectedTagIds : [contextMenu.targetId!]); closeContextMenu(); }}>{t('context.deleteTag')}</div>
          </>
        )}
      </>)}
      {contextMenu.type === 'person' && (<>
        {activeTab.selectedPersonIds.length > 1 ? (
          <>
            <div className="px-4 py-2 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('add-to-topic', { personIds: activeTab.selectedPersonIds }); closeContextMenu(); }}><Layout size={14} className="mr-2 opacity-70" /> {t('context.addToTopic') || '添加到主题'}</div>
            <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center" onClick={() => {
              setModal('confirm-delete-person', { personId: activeTab.selectedPersonIds });
              closeContextMenu();
            }}>
              <Trash2 size={14} className="mr-2 opacity-70" /> {t('context.delete')}
            </div>
          </>
        ) : contextMenu.targetId ? (
          <>
            <div className="px-4 py-2 font-bold bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-600 mb-1">{peopleWithDisplayCounts[contextMenu.targetId]?.name}</div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { enterTagView(contextMenu.targetId!); closeContextMenu(); }}>{t('context.viewTagged')}</div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { handleSetAvatar(contextMenu.targetId!); closeContextMenu(); }}><Crop size={14} className="mr-2 opacity-70" /> {t('context.setAvatar')}</div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('rename-person', { personId: contextMenu.targetId! }); closeContextMenu(); }}><Edit3 size={14} className="mr-2 opacity-70" /> {t('context.renamePerson')}</div><div className="px-4 py-2 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center" onClick={() => { setModal('add-to-topic', { personIds: [contextMenu.targetId!] }); closeContextMenu(); }}><Layout size={14} className="mr-2 opacity-70" /> {t('context.addToTopic') || '添加到主题'}</div>
            <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
            <div className="px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center" onClick={() => {
              setModal('confirm-delete-person', { personId: contextMenu.targetId! });
              closeContextMenu();
            }}>
              <Trash2 size={14} className="mr-2 opacity-70" /> {t('context.deletePerson')}
            </div>
          </>
        ) : null}
      </>)}
      {contextMenu.type === 'tab' && contextMenu.targetId && (<> <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={(e) => { handleCloseTab(e, contextMenu.targetId!); closeContextMenu(); }}>{t('context.closeTab')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCloseOtherTabs(contextMenu.targetId!); closeContextMenu(); }}>{t('context.closeOtherTabs')}</div><div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCloseAllTabs(); closeContextMenu(); }}>{t('context.closeAllTabs')}</div> </>)}
      {contextMenu.type === 'background' && (<>
        {activeTab.viewMode === 'people-overview' ? (
          <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCreatePerson(); closeContextMenu(); }}>{t('context.newPerson')}</div>
        ) : (
          <>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleRefresh(); closeContextMenu(); }}>{t('context.refresh')}</div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => {
              updateActiveTab({ selectedFileIds: displayFileIds });
              closeContextMenu();
            }}>{t('context.selectAll')}</div>
            <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCreateFolder(); closeContextMenu(); }}>{t('context.newFolder')}</div>
            <div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCreateNewTag(); closeContextMenu(); }}>{t('context.newTag')}</div>
          </>
        )}
      </>)}
      {contextMenu.type === 'tag-background' && (<div className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer" onClick={() => { handleCreateNewTag(); closeContextMenu(); }}>{t('context.newTag')}</div>)}
    </div>
  );
};
