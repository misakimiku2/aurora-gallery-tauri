
import React, { useState, useCallback, useEffect } from 'react';
import { TabState, FileType, AppState } from '../types';

interface UseContextMenuProps {
  state: AppState;
  activeTab: TabState;
  updateActiveTab: (updates: any) => void;
}

export const useContextMenu = ({
  state,
  activeTab,
  updateActiveTab
}: UseContextMenuProps) => {
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    type: 'file-single' | 'file-multi' | 'folder-single' | 'folder-multi' | 'tag-single' | 'tag-multi' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person' | null;
    targetId?: string;
  }>({ visible: false, x: 0, y: 0, type: null });

  const closeContextMenu = useCallback(() => setContextMenu(prev => ({ ...prev, visible: false })), []);

  const handleContextMenu = (e: React.MouseEvent, type: 'file' | 'tag' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person', id: string) => {
    e.preventDefault(); e.stopPropagation();
    let menuType: any = null;
    if (type === 'file') {
      if (!activeTab.selectedFileIds.includes(id)) {
        updateActiveTab({ selectedFileIds: [id], lastSelectedId: id });
        menuType = state.files[id]?.type === FileType.FOLDER ? 'folder-single' : 'file-single';
      } else {
        if (activeTab.selectedFileIds.length > 1) {
          const selectedItems = activeTab.selectedFileIds.map(fileId => state.files[fileId]);
          const allAreFolders = selectedItems.every(item => item && item.type === FileType.FOLDER);
          const allAreFiles = selectedItems.every(item => item && item.type !== FileType.FOLDER);

          if (allAreFolders) {
            menuType = 'folder-multi';
          } else if (allAreFiles) {
            menuType = 'file-multi';
          } else {
            menuType = 'file-multi';
          }
        } else {
          menuType = state.files[id]?.type === FileType.FOLDER ? 'folder-single' : 'file-single';
        }
      }
    }
    else if (type === 'tag') { if (!activeTab.selectedTagIds.includes(id)) { updateActiveTab({ selectedTagIds: [id] }); menuType = 'tag-single'; } else { menuType = activeTab.selectedTagIds.length > 1 ? 'tag-multi' : 'tag-single'; } }
    else if (type === 'tag-background') { menuType = 'tag-background'; }
    else if (type === 'root-folder') { menuType = 'root-folder'; }
    else if (type === 'tab') { menuType = 'tab'; }
    else if (type === 'person') { menuType = 'person'; }
    else { if (activeTab.viewMode === 'tags-overview') { menuType = 'tag-background'; } else { menuType = 'background'; } }
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, type: menuType, targetId: id });
  };

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (contextMenu.visible) {
        const menuElement = document.querySelector('.fixed.bg-white[data-testid="context-menu"]');
        if (!menuElement || !menuElement.contains(e.target as Node)) {
          closeContextMenu();
        }
      }
    };

    const handleWheel = () => {
      if (contextMenu.visible) {
        closeContextMenu();
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('wheel', handleWheel, true);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('wheel', handleWheel, true);
    };
  }, [contextMenu.visible, closeContextMenu]);

  return {
    contextMenu,
    setContextMenu,
    closeContextMenu,
    handleContextMenu
  };
};
