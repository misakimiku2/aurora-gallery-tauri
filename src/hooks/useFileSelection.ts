import { useCallback } from 'react';
import type { TabState } from '../types';

interface UseFileSelectionProps {
  activeTab: TabState;
  displayFileIds: string[];
  closeContextMenu: () => void;
  isSelecting: boolean;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
}

export function useFileSelection({
  activeTab,
  displayFileIds,
  closeContextMenu,
  isSelecting,
  updateActiveTab,
}: UseFileSelectionProps) {
  const handleFileClick = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();

    closeContextMenu();

    if (isSelecting) return;

    const isCtrl = e.ctrlKey || e.metaKey;
    const isShift = e.shiftKey;

    let newSelectedFileIds: string[];
    let newLastSelectedId: string = id;

    if (isCtrl) {
      if (activeTab.selectedFileIds.includes(id)) {
        newSelectedFileIds = activeTab.selectedFileIds.filter(fileId => fileId !== id);
      } else {
        newSelectedFileIds = [...activeTab.selectedFileIds, id];
      }
    } else if (isShift && activeTab.lastSelectedId && activeTab.selectedFileIds.length > 0) {
      const currentFolderId = activeTab.folderId;
      let allFiles: string[] = [];

      if (activeTab.searchQuery) {
        allFiles = displayFileIds;
      } else {
        allFiles = displayFileIds;
      }

      const lastIndex = allFiles.indexOf(activeTab.lastSelectedId);
      const currentIndex = allFiles.indexOf(id);

      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        newSelectedFileIds = allFiles.slice(start, end + 1);
      } else {
        newSelectedFileIds = [id];
      }
    } else {
      newSelectedFileIds = [id];
    }

    updateActiveTab({
      selectedFileIds: newSelectedFileIds,
      lastSelectedId: newLastSelectedId
    });
  }, [activeTab, displayFileIds, closeContextMenu, isSelecting, updateActiveTab]);

  return { handleFileClick };
}
