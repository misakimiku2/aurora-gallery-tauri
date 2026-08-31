
import React, { useState, useRef, useCallback, useEffect } from 'react';
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
    source?: 'long-press' | null;
  }>({ visible: false, x: 0, y: 0, type: null });

  const closeContextMenu = useCallback(() => setContextMenu(prev => ({ ...prev, visible: false })), []);

  // 传给左侧 <Sidebar>（React.memo）的 onContextMenu：state / activeTab 每次渲染都换
  // 引用，直接 useCallback([state]) 还是会破 memo，用 ref 固定函数身份。
  const stateRef = useRef(state);
  stateRef.current = state;
  const activeTabRef = useRef(activeTab);
  activeTabRef.current = activeTab;
  const handleContextMenu = useCallback((e: React.MouseEvent, type: 'file' | 'tag' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person', id: string) => {
    e.preventDefault(); e.stopPropagation();
    const currentState = stateRef.current;
    const currentTab = activeTabRef.current;
    let menuType: any = null;
    if (type === 'file') {
      if (!currentTab.selectedFileIds.includes(id)) {
        updateActiveTab({ selectedFileIds: [id], lastSelectedId: id });
        menuType = currentState.files[id]?.type === FileType.FOLDER ? 'folder-single' : 'file-single';
      } else {
        if (currentTab.selectedFileIds.length > 1) {
          const selectedItems = currentTab.selectedFileIds.map(fileId => currentState.files[fileId]);
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
          menuType = currentState.files[id]?.type === FileType.FOLDER ? 'folder-single' : 'file-single';
        }
      }
    }
    else if (type === 'tag') { if (!currentTab.selectedTagIds.includes(id)) { updateActiveTab({ selectedTagIds: [id] }); menuType = 'tag-single'; } else { menuType = currentTab.selectedTagIds.length > 1 ? 'tag-multi' : 'tag-single'; } }
    else if (type === 'tag-background') { menuType = 'tag-background'; }
    else if (type === 'root-folder') { menuType = 'root-folder'; }
    else if (type === 'tab') { menuType = 'tab'; }
    else if (type === 'person') { menuType = 'person'; }
    else { if (currentTab.viewMode === 'tags-overview') { menuType = 'tag-background'; } else { menuType = 'background'; } }
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, type: menuType, targetId: id });
  }, [updateActiveTab]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (contextMenu.visible) {
        const menuElement = document.querySelector('[data-testid="context-menu"]');
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

    const handleTouchMove = () => {
      if (contextMenu.visible) {
        closeContextMenu();
      }
    };

    const handleOrientationChange = () => {
      if (contextMenu.visible && contextMenu.source === 'long-press') {
        closeContextMenu();
      }
    };

    document.addEventListener('mousedown', handleClick);
    document.addEventListener('wheel', handleWheel, true);
    document.addEventListener('touchmove', handleTouchMove, true);
    window.addEventListener('orientationchange', handleOrientationChange);
    screen.orientation?.addEventListener?.('change', handleOrientationChange);

    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('wheel', handleWheel, true);
      document.removeEventListener('touchmove', handleTouchMove, true);
      window.removeEventListener('orientationchange', handleOrientationChange);
      screen.orientation?.removeEventListener?.('change', handleOrientationChange);
    };
  }, [contextMenu.visible, contextMenu.source, closeContextMenu]);

  return {
    contextMenu,
    setContextMenu,
    closeContextMenu,
    handleContextMenu
  };
};
