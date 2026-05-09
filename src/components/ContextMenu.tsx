
import React, { useState, useRef, useEffect } from 'react';
import {
  Layout, ExternalLink, FolderOpen, Copy, MoveHorizontal, Link,
  Type, Sparkles, User, XCircle, Tag, Clipboard, Image as ImageIcon,
  Trash2, FolderPlus, ChevronsDown, ChevronsUp, Edit3, Crop,
  RefreshCw, MousePointer2, Scan, ChevronRight, Plus, Search
} from 'lucide-react';
import { FileType, FileNode, Person, TabState, ClipSettings } from '../types';

import { isAndroidSync } from '../utils/androidPlatform';

interface ContextMenuProps {
  contextMenu: {
    visible: boolean;
    x: number;
    y: number;
    type: 'file-single' | 'file-multi' | 'folder-single' | 'folder-multi' | 'tag-single' | 'tag-multi' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person' | null;
    targetId?: string;
    source?: 'long-press' | null;
  };
  files: Record<string, FileNode>;
  activeTab: TabState;
  tabs: TabState[];
  peopleWithDisplayCounts: Record<string, Person>;
  aiConnectionStatus: string;
  displayFileIds: string[];
  clipSettings?: ClipSettings;
  isAndroid?: boolean;
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
  handleCreateTopic: () => void;
  handleCloseTab: (e: any, id: string) => void;
  handleCloseOtherTabs: (id: string) => void;
  handleCloseAllTabs: () => void;
  handleRefresh: () => void;
  handleCreateNewTag: () => void;
  handleCopyTags: (ids: string[]) => void;
  handlePasteTags: (ids: string[]) => void;
  showToast: (msg: string) => void;
  updateActiveTab: (updates: Partial<TabState>) => void;
  handleOpenCompareInNewTab: (ids: string[]) => void;
  handleAddToCompareCanvas: (tabId: string, imageIds: string[]) => void;
  handleCopyImageToClipboard: (fileId: string) => void;
  handleSearchSimilarImages?: (imageId: string) => void;
  openClipSettings?: () => void;
}

export const ContextMenu: React.FC<ContextMenuProps> = ({
  contextMenu,
  files,
  activeTab,
  tabs,
  peopleWithDisplayCounts,
  aiConnectionStatus,
  displayFileIds,
  clipSettings,
  isAndroid,
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
  handleCreateTopic,
  handleCloseTab,
  handleCloseOtherTabs,
  handleCloseAllTabs,
  handleRefresh,
  handleCreateNewTag,
  handleCopyTags,
  handlePasteTags,
  showToast,
  updateActiveTab,
  handleOpenCompareInNewTab,
  handleAddToCompareCanvas,
  handleCopyImageToClipboard,
  handleSearchSimilarImages,
  openClipSettings
}) => {
  const [compareSubmenuOpen, setCompareSubmenuOpen] = useState(false);
  const compareMenuTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const [blockInteraction, setBlockInteraction] = useState(true);

  useEffect(() => {
    return () => {
      if (compareMenuTimeoutRef.current) {
        clearTimeout(compareMenuTimeoutRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!contextMenu.visible) {
      setBlockInteraction(true);
      return;
    }

    setBlockInteraction(true);

    const handleTouchEnd = () => {
      setTimeout(() => {
        setBlockInteraction(false);
      }, 100);
    };

    document.addEventListener('touchend', handleTouchEnd, { once: true });
    return () => {
      document.removeEventListener('touchend', handleTouchEnd);
      setBlockInteraction(true);
    };
  }, [contextMenu.visible]);

  const openCompareSubmenu = () => {
    if (compareMenuTimeoutRef.current) {
      clearTimeout(compareMenuTimeoutRef.current);
      compareMenuTimeoutRef.current = null;
    }
    setCompareSubmenuOpen(true);
  };

  const closeCompareSubmenu = () => {
    compareMenuTimeoutRef.current = setTimeout(() => {
      setCompareSubmenuOpen(false);
    }, 150);
  };

  if (!contextMenu.visible) return null;

  const isAndroidDevice = isAndroid ?? isAndroidSync();

  const menuItemClass = isAndroidDevice
    ? 'px-4 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center'
    : 'px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center';
  const menuItemStyle = isAndroidDevice ? { height: '50px', fontSize: '15px' } : undefined;
  const iconSize = isAndroidDevice ? 18 : 14;
  const deleteItemClass = isAndroidDevice
    ? 'px-4 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center'
    : 'px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer flex items-center';
  const purpleItemClass = isAndroidDevice
    ? 'px-4 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center'
    : 'px-4 py-2 hover:bg-purple-600 hover:text-white cursor-pointer flex items-center';
  const pinkItemClass = isAndroidDevice
    ? 'px-4 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center'
    : 'px-4 py-2 hover:bg-pink-600 hover:text-white cursor-pointer flex items-center';
  const plainMenuItemClass = isAndroidDevice
    ? 'px-4 hover:bg-blue-600 hover:text-white cursor-pointer'
    : 'px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer';
  const plainMenuItemStyle = isAndroidDevice ? { height: '50px', fontSize: '15px', display: 'flex', alignItems: 'center' } : undefined;
  const headerItemClass = isAndroidDevice
    ? 'px-4 font-bold bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-600 mb-1'
    : 'px-4 py-2 font-bold bg-gray-50 dark:bg-gray-700/50 border-b border-gray-100 dark:border-gray-600 mb-1';
  const headerItemStyle = isAndroidDevice ? { height: '50px', fontSize: '15px', display: 'flex', alignItems: 'center' } : undefined;

  const compareTabs = tabs.filter(tab => tab.isCompareMode);
  const hasCompareTabs = compareTabs.length > 0;

  return (
    <div
      data-testid="context-menu"
      className={`fixed bg-white ${['file-single', 'file-multi', 'folder-single', 'folder-multi', 'person'].includes(contextMenu.type || '')
        ? 'dark:bg-gray-800'
        : 'dark:bg-gray-800'
        } border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 text-gray-800 dark:text-gray-200 min-w-[180px] z-[1000] max-h-[80vh] overflow-y-auto`}
      style={{
        left: 0,
        top: 0,
        position: 'fixed',
        zIndex: 1000,
        ...(isAndroidDevice ? { fontSize: '15px' } : {}),
        ...(isAndroidDevice && blockInteraction ? { pointerEvents: 'none' as const } : {})
      }}
      onClickCapture={isAndroidDevice && blockInteraction ? (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); } : undefined}
      onMouseDownCapture={isAndroidDevice && blockInteraction ? (e: React.MouseEvent) => { e.stopPropagation(); e.preventDefault(); } : undefined}
      onTouchStartCapture={isAndroidDevice && blockInteraction ? (e: React.TouchEvent) => { e.stopPropagation(); } : undefined}
      ref={(el) => {
        if (el) {
          const rect = el.getBoundingClientRect();
          const menuWidth = rect.width;
          const menuHeight = rect.height;
          const screenWidth = window.innerWidth;
          const screenHeight = window.innerHeight;

          let x = contextMenu.x;
          if (x + menuWidth > screenWidth) {
            x = screenWidth - menuWidth - 10;
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
      {contextMenu.type === 'file-single' || contextMenu.type === 'file-multi' || contextMenu.type === 'folder-single' || contextMenu.type === 'folder-multi' ? (<>
        {contextMenu.type !== 'file-multi' && contextMenu.type !== 'folder-multi' && (
          <div className={menuItemClass} style={menuItemStyle} onClick={() => { handleOpenInNewTab(contextMenu.targetId!); closeContextMenu(); }}>
            <Layout size={iconSize} className="mr-2 opacity-70" />
            {contextMenu.type === 'folder-single' ? t('context.openFolderInNewTab') : t('context.openInNewTab')}
          </div>
        )}

        {!isAndroidDevice && (
          <div className={menuItemClass} style={menuItemStyle} onClick={() => { handleViewInExplorer(contextMenu.targetId!); closeContextMenu(); }}><ExternalLink size={iconSize} className="mr-2 opacity-70" /> {t('context.viewInExplorer')}</div>
        )}
        {contextMenu.type === 'file-single' && files[contextMenu.targetId!] && ((() => {
          const file = files[contextMenu.targetId!]; const parentId = file.parentId; const isUnavailable = activeTab.viewMode === 'browser' && activeTab.folderId === parentId; if (isUnavailable) return null; return (<div className={isAndroidDevice ? 'px-4 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center' : 'px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center'} style={isAndroidDevice ? { height: '50px', fontSize: '15px' } : undefined} onClick={() => { if (parentId) { enterFolder(parentId, { scrollToItemId: file.id }); closeContextMenu(); } }}>
            <FolderOpen size={iconSize} className="mr-2 opacity-70" />
            {t('context.openFolder')}
          </div>);
        })())}
        {!(isAndroidDevice && (contextMenu.type === 'file-multi' || contextMenu.type === 'folder-multi')) && (
          <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
        )}

        {!isAndroidDevice && contextMenu.type === 'file-single' && contextMenu.targetId && files[contextMenu.targetId]?.type === FileType.IMAGE && (
          <div className={menuItemClass} style={menuItemStyle} onClick={() => { handleCopyImageToClipboard(contextMenu.targetId!); closeContextMenu(); }}>
            <Clipboard size={iconSize} className="mr-2 opacity-70" />
            {t('context.copyImage')}
          </div>
        )}
        {!isAndroidDevice && contextMenu.type === 'file-single' && contextMenu.targetId && files[contextMenu.targetId]?.type === FileType.IMAGE && clipSettings?.enabled && handleSearchSimilarImages && (
          <div className={isAndroidDevice
            ? 'px-4 hover:bg-cyan-600 hover:text-white cursor-pointer flex items-center'
            : 'px-4 py-2 hover:bg-cyan-600 hover:text-white cursor-pointer flex items-center'
          } style={menuItemStyle} onClick={() => {
            if (!clipSettings?.modelName) {
              showToast('请先选择视觉模型');
              openClipSettings?.();
              closeContextMenu();
              return;
            }
            handleSearchSimilarImages(contextMenu.targetId!);
            closeContextMenu();
          }}>
            <Search size={iconSize} className="mr-2 opacity-70" />
            {t('context.searchSimilar') || '搜索相似图片'}
          </div>
        )}
        <div className={menuItemClass} style={menuItemStyle} onClick={() => { setModal('copy-to-folder', { fileIds: activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : contextMenu.targetId ? [contextMenu.targetId] : [] }); closeContextMenu(); }}>
          <Copy size={iconSize} className="mr-2 opacity-70" />
          {t('context.copyTo')}
        </div>
        <div className={menuItemClass} style={menuItemStyle} onClick={() => { setModal('move-to-folder', { fileIds: activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : contextMenu.targetId ? [contextMenu.targetId] : [] }); closeContextMenu(); }}>
          <MoveHorizontal size={iconSize} className="mr-2 opacity-70" />
          {t('context.moveTo')}
        </div>
        {contextMenu.type === 'folder-single' && (<div className={menuItemClass} style={menuItemStyle} onClick={() => { navigator.clipboard.writeText(files[contextMenu.targetId!]?.path || ''); showToast(t('context.copied')); closeContextMenu(); }}>
          <Link size={iconSize} className="mr-2 opacity-70" />
          {t('context.copyFolderPath')}
        </div>)}
        <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
        {(contextMenu.type === 'file-single' || contextMenu.type === 'folder-single') && contextMenu.targetId && (<div className={menuItemClass} style={menuItemStyle} onClick={() => { startRename(contextMenu.targetId!); closeContextMenu(); }}>
          <Type size={iconSize} className="mr-2 opacity-70" />
          {t('context.rename')}
        </div>)}
        {contextMenu.type === 'folder-single' && contextMenu.targetId && aiConnectionStatus === 'connected' && (
          <div className={purpleItemClass} style={menuItemStyle} onClick={() => {
            handleFolderAIAnalysis(contextMenu.targetId!);
            closeContextMenu();
          }}>
            <Sparkles size={iconSize} className="mr-2 opacity-70" /> {t('context.aiAnalyze')}
          </div>
        )}
        {contextMenu.type === 'file-single' && contextMenu.targetId && aiConnectionStatus === 'connected' && (
          <div className={purpleItemClass} style={menuItemStyle} onClick={() => {
            handleAIAnalysis([contextMenu.targetId!]);
            closeContextMenu();
          }}>
            <Sparkles size={iconSize} className="mr-2 opacity-70" /> {t('context.aiAnalyze')}
          </div>
        )}
        {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi') && (() => {
          const imageIds = activeTab.selectedFileIds.filter(id => files[id]?.type === FileType.IMAGE);
          const canCompare = imageIds.length >= 1 && imageIds.length <= 24;
          const itemClass = canCompare
            ? (isAndroidDevice
                ? 'px-4 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center'
                : 'px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center')
            : (isAndroidDevice
                ? 'px-4 flex items-center text-gray-400 cursor-default opacity-60'
                : 'px-4 py-2 flex items-center text-gray-400 cursor-default opacity-60');

          if (!hasCompareTabs) {
            if (imageIds.length < 2) return null;
            return (
              <div
                className={itemClass}
                style={menuItemStyle}
                onClick={canCompare ? () => { handleOpenCompareInNewTab(imageIds); closeContextMenu(); } : undefined}
              >
                <Scan size={iconSize} className="mr-2 opacity-70" />
                <div className="flex-1">{t('context.compareImages')}</div>
                <div className="text-xs text-gray-500 ml-3">{`${imageIds.length}/24`}</div>
              </div>
            );
          }

          if (imageIds.length === 0) return null;

          return (
            <div
              className="relative group/compare"
              onMouseEnter={openCompareSubmenu}
              onMouseLeave={closeCompareSubmenu}
              ref={(el) => {
                if (el) {
                  (el as any).__compareMenuItemRef = el;
                }
              }}
            >
              <div className={itemClass} style={menuItemStyle}>
                <Scan size={iconSize} className="mr-2 opacity-70" />
                <div className="flex-1">{t('context.compareImages')}</div>
                <ChevronRight size={iconSize} className="ml-2 opacity-70" />
              </div>
              {compareSubmenuOpen && (
                <div
                  className="fixed bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-xl text-sm py-1 min-w-[200px] z-[1001]"
                  onMouseEnter={openCompareSubmenu}
                  onMouseLeave={closeCompareSubmenu}
                  ref={(el) => {
                    if (el && contextMenu.visible) {
                      const rect = el.getBoundingClientRect();
                      const menuWidth = rect.width;
                      const menuHeight = rect.height;
                      const screenWidth = window.innerWidth;
                      const screenHeight = window.innerHeight;

                      const menuItemEl = (el?.parentElement as any)?.__compareMenuItemRef;
                      if (menuItemEl) {
                        const menuItemRect = menuItemEl.getBoundingClientRect();
                        let x = menuItemRect.right + 4;
                        let y = menuItemRect.top;

                        if (x + menuWidth > screenWidth) {
                          x = menuItemRect.left - menuWidth - 4;
                        }

                        if (y + menuHeight > screenHeight) {
                          y = screenHeight - menuHeight - 10;
                        }

                        el.style.left = `${x}px`;
                        el.style.top = `${y}px`;
                      }
                    }
                  }}
                >
                  {compareTabs.map(tab => {
                    const currentCount = tab.selectedFileIds.length;
                    const maxCount = 24;
                    const remainingSpace = maxCount - currentCount;
                    const canAdd = remainingSpace > 0 && imageIds.length <= remainingSpace;
                    const canvasName = tab.sessionName || `画布${tab.id.slice(0, 4)}`;

                    return (
                      <div
                        key={tab.id}
                        className={canAdd
                          ? 'px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center justify-between'
                          : 'px-4 py-2 flex items-center justify-between text-gray-400 cursor-default opacity-60'
                        }
                        onClick={canAdd ? () => {
                          handleAddToCompareCanvas(tab.id, imageIds);
                          closeContextMenu();
                        } : undefined}
                      >
                        <span className="truncate max-w-[120px]">{t('context.addToCanvas').replace('{name}', canvasName)}</span>
                        <span className="text-xs ml-2">{`${currentCount}/${maxCount}`}</span>
                      </div>
                    );
                  })}
                  <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
                  <div
                    className="px-4 py-2 hover:bg-blue-600 hover:text-white cursor-pointer flex items-center"
                    onClick={() => { handleOpenCompareInNewTab(imageIds); closeContextMenu(); }}
                  >
                    <Plus size={14} className="mr-2 opacity-70" />
                    <span>{t('context.newCanvas')}</span>
                  </div>
                </div>
              )}
            </div>
          );
        })()}
        {contextMenu.type === 'file-multi' && (<div className={menuItemClass} style={menuItemStyle} onClick={() => { setModal('batch-rename', null); closeContextMenu(); }}>
          <Type size={iconSize} className="mr-2 opacity-70" />
          {t('context.batchRename')}
        </div>)}
        {(contextMenu.type === 'file-multi') && aiConnectionStatus === 'connected' && (
          <div className={purpleItemClass} style={menuItemStyle} onClick={() => {
            handleAIAnalysis(activeTab.selectedFileIds);
            closeContextMenu();
          }}>
            <Sparkles size={iconSize} className="mr-2 opacity-70" /> {t('context.aiAnalyze')}
          </div>
        )}
        {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi') && Object.keys(peopleWithDisplayCounts).length > 0 && (<> <div className={purpleItemClass} style={menuItemStyle} onClick={() => { setModal('add-to-person', null); closeContextMenu(); }}><User size={iconSize} className="mr-2 opacity-70" /> {t('context.addToPerson')}</div><div className={purpleItemClass} style={menuItemStyle} onClick={() => {
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
        }}><XCircle size={iconSize} className="mr-2 opacity-70" /> {t('context.clearPersonInfo')}</div></>)}
        {(contextMenu.type === 'file-single' || contextMenu.type === 'file-multi') && (<div className={pinkItemClass} style={menuItemStyle} onClick={() => { const targetIds = activeTab.selectedFileIds.length > 0 ? activeTab.selectedFileIds : (contextMenu.targetId ? [contextMenu.targetId] : []); setModal('add-to-topic', { fileIds: targetIds }); closeContextMenu(); }}><Layout size={iconSize} className="mr-2 opacity-70" /> {t('context.addToTopic') || '添加到主题'}</div>)}
        {contextMenu.type === 'file-single' && contextMenu.targetId && (<>
          <div className={menuItemClass} style={menuItemStyle} onClick={() => { setModal('edit-tags', { fileId: contextMenu.targetId! }); closeContextMenu(); }}>
            <Tag size={iconSize} className="mr-2 opacity-70" />
            {t('context.editTags')}
          </div>
          <div className={menuItemClass} style={menuItemStyle} onClick={() => { handleCopyTags([contextMenu.targetId!]); closeContextMenu(); }}>
            <Copy size={iconSize} className="mr-2 opacity-70" />
            {t('context.copyTag')}
          </div>
        </>)}
        {(() => {
          const allAreFiles = activeTab.selectedFileIds.every(id => {
            const file = files[id];
            return file && file.type !== FileType.FOLDER;
          });
          return allAreFiles && (<div className={menuItemClass} style={menuItemStyle} onClick={() => { handlePasteTags(activeTab.selectedFileIds); closeContextMenu(); }}>
            <Clipboard size={iconSize} className="mr-2 opacity-70" />
            {t('context.pasteTag')}
          </div>);
        })()}

        {(contextMenu.type === 'folder-single' || contextMenu.type === 'folder-multi') && (
          <div className={menuItemClass} style={menuItemStyle} onClick={() => {
            const folderIds = contextMenu.type === 'folder-single' ? [contextMenu.targetId!] : activeTab.selectedFileIds;
            handleGenerateThumbnails(folderIds);
            closeContextMenu();
          }}>
            <ImageIcon size={iconSize} className="mr-2 opacity-70" /> {t('context.generateThumbnails')}
          </div>
        )}

        {!isAndroidDevice && (
          <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
        )}
        {!isAndroidDevice && (
          <div className={deleteItemClass} style={menuItemStyle} onClick={() => { requestDelete(activeTab.selectedFileIds); closeContextMenu(); }}><Trash2 size={iconSize} className="mr-2" /> {t('context.delete')}</div>
        )}
      </>) : null}
      {contextMenu.type === 'root-folder' && contextMenu.targetId && (<> <div className={menuItemClass} style={menuItemStyle} onClick={() => { handleCreateFolder(contextMenu.targetId); closeContextMenu(); }}><FolderPlus size={iconSize} className="mr-2 opacity-70" /> {t('context.createSubfolder')}</div><div className={menuItemClass} style={menuItemStyle} onClick={() => { handleExpandAll(contextMenu.targetId!); closeContextMenu(); }}><ChevronsDown size={iconSize} className="mr-2 opacity-70" /> {t('context.expandAll')}</div><div className={menuItemClass} style={menuItemStyle} onClick={() => { handleCollapseAll(contextMenu.targetId!); closeContextMenu(); }}><ChevronsUp size={iconSize} className="mr-2 opacity-70" /> {t('context.collapseAll')}</div> </>)}
      {(contextMenu.type === 'tag-single' || contextMenu.type === 'tag-multi') && contextMenu.targetId && (<>
        {contextMenu.type === 'tag-multi' ? (
          <div className={deleteItemClass} style={menuItemStyle} onClick={() => {
            requestDeleteTags(activeTab.selectedTagIds);
            closeContextMenu();
          }}>
            <Trash2 size={iconSize} className="mr-2 opacity-70" /> {t('context.deleteTag')}
          </div>
        ) : (
          <>
            <div className={headerItemClass} style={headerItemStyle}>{contextMenu.targetId}</div>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { enterTagView(contextMenu.targetId!); closeContextMenu(); }}>{t('context.viewTagged')}</div>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { navigator.clipboard.writeText(contextMenu.targetId!); closeContextMenu(); }}>{t('context.copyName')}</div>
            <div className={menuItemClass} style={menuItemStyle} onClick={() => { setModal('rename-tag', { tag: contextMenu.targetId! }); closeContextMenu(); }}><Edit3 size={iconSize} className="mr-2 opacity-70" /> {t('context.renameTag')}</div>
            <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
            <div className={isAndroidDevice
              ? 'px-4 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer'
              : 'px-4 py-2 hover:bg-red-600 text-red-500 dark:text-red-400 hover:text-white cursor-pointer'
            } style={isAndroidDevice ? { height: '50px', fontSize: '15px', display: 'flex', alignItems: 'center' } : undefined} onClick={() => { requestDeleteTags(activeTab.selectedTagIds.length > 0 ? activeTab.selectedTagIds : [contextMenu.targetId!]); closeContextMenu(); }}>{t('context.deleteTag')}</div>
          </>
        )}
      </>)}
      {contextMenu.type === 'person' && (<>
        {activeTab.selectedPersonIds.length > 1 ? (
          <>
            <div className={pinkItemClass} style={menuItemStyle} onClick={() => { setModal('add-to-topic', { personIds: activeTab.selectedPersonIds }); closeContextMenu(); }}><Layout size={iconSize} className="mr-2 opacity-70" /> {t('context.addToTopic') || '添加到主题'}</div>
            <div className={deleteItemClass} style={menuItemStyle} onClick={() => {
              setModal('confirm-delete-person', { personId: activeTab.selectedPersonIds });
              closeContextMenu();
            }}>
              <Trash2 size={iconSize} className="mr-2 opacity-70" /> {t('context.delete')}
            </div>
          </>
        ) : contextMenu.targetId ? (
          <>
            <div className={headerItemClass} style={headerItemStyle}>{peopleWithDisplayCounts[contextMenu.targetId]?.name}</div>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { enterTagView(contextMenu.targetId!); closeContextMenu(); }}>{t('context.viewTagged')}</div>
            <div className={menuItemClass} style={menuItemStyle} onClick={() => { handleSetAvatar(contextMenu.targetId!); closeContextMenu(); }}><Crop size={iconSize} className="mr-2 opacity-70" /> {t('context.setAvatar')}</div>
            <div className={menuItemClass} style={menuItemStyle} onClick={() => { setModal('rename-person', { personId: contextMenu.targetId! }); closeContextMenu(); }}><Edit3 size={iconSize} className="mr-2 opacity-70" /> {t('context.renamePerson')}</div>
            <div className={purpleItemClass} style={menuItemStyle} onClick={() => { setModal('smart-add-to-person', { personId: contextMenu.targetId! }); closeContextMenu(); }}><Sparkles size={iconSize} className="mr-2 opacity-70" /> {t('context.smartAddToPerson') || '智能添加图片'}</div>
            <div className={pinkItemClass} style={menuItemStyle} onClick={() => { setModal('add-to-topic', { personIds: [contextMenu.targetId!] }); closeContextMenu(); }}><Layout size={iconSize} className="mr-2 opacity-70" /> {t('context.addToTopic') || '添加到主题'}</div>
            <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
            <div className={deleteItemClass} style={menuItemStyle} onClick={() => {
              setModal('confirm-delete-person', { personId: contextMenu.targetId! });
              closeContextMenu();
            }}>
              <Trash2 size={iconSize} className="mr-2 opacity-70" /> {t('context.deletePerson')}
            </div>
          </>
        ) : null}
      </>)}
      {contextMenu.type === 'tab' && contextMenu.targetId && (<> <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={(e) => { handleCloseTab(e, contextMenu.targetId!); closeContextMenu(); }}>{t('context.closeTab')}</div><div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { handleCloseOtherTabs(contextMenu.targetId!); closeContextMenu(); }}>{t('context.closeOtherTabs')}</div><div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { handleCloseAllTabs(); closeContextMenu(); }}>{t('context.closeAllTabs')}</div> </>)}
      {contextMenu.type === 'background' && (<>
        {activeTab.viewMode === 'people-overview' ? (
          <>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { handleCreatePerson(); closeContextMenu(); }}>{t('context.newPerson')}</div>
            <div className={purpleItemClass} style={menuItemStyle} onClick={() => { setModal('smart-create-person', {}); closeContextMenu(); }}>
              <Sparkles size={iconSize} className="mr-2 opacity-70" /> {t('context.smartCreatePerson') || '智能创建人物'}
            </div>
          </>
        ) : activeTab.viewMode === 'topics-overview' ? (
          <>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { handleCreateTopic(); closeContextMenu(); }}>{t('context.newTopic') || '新建专题'}</div>
            <div className={purpleItemClass} style={menuItemStyle} onClick={() => { setModal('smart-create-topic', {}); closeContextMenu(); }}>
              <Sparkles size={iconSize} className="mr-2 opacity-70" /> {t('context.smartCreateTopic') || '智能创建专题'}
            </div>
          </>
        ) : (
          <>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { handleRefresh(); closeContextMenu(); }}>{t('context.refresh')}</div>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => {
              updateActiveTab({ selectedFileIds: displayFileIds });
              closeContextMenu();
            }}>{t('context.selectAll')}</div>
            <div className="border-t border-gray-200 dark:border-gray-600 my-1"></div>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { handleCreateFolder(); closeContextMenu(); }}>{t('context.newFolder')}</div>
            <div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { handleCreateNewTag(); closeContextMenu(); }}>{t('context.newTag')}</div>
          </>
        )}
      </>)}
      {contextMenu.type === 'tag-background' && (<div className={plainMenuItemClass} style={plainMenuItemStyle} onClick={() => { handleCreateNewTag(); closeContextMenu(); }}>{t('context.newTag')}</div>)}
    </div>
  );
};
