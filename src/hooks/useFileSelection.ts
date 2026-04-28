import { useCallback } from 'react';
import type { TabState } from '../types';

interface UseFileSelectionProps {
  activeTab: TabState;
  displayFileIds: string[];
  closeContextMenu: () => void;
  isSelecting: boolean;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  isAndroid?: boolean;
  isAndroidSelectionMode?: boolean;
  onOpenFile?: (id: string) => void;
  onEnterAndroidSelectionMode?: (id: string) => void;
}

export function useFileSelection({
  activeTab,
  displayFileIds,
  closeContextMenu,
  isSelecting,
  updateActiveTab,
  isAndroid = false,
  isAndroidSelectionMode = false,
  onOpenFile,
  onEnterAndroidSelectionMode,
}: UseFileSelectionProps) {
  const handleFileClick = useCallback((e: React.MouseEvent, id: string) => {
    e.stopPropagation();

    closeContextMenu();

    if (isSelecting) return;

    if (isAndroid) {
      if (isAndroidSelectionMode) {
        if (activeTab.selectedFileIds.includes(id)) {
          updateActiveTab({
            selectedFileIds: activeTab.selectedFileIds.filter(fileId => fileId !== id),
            lastSelectedId: id
          });
        } else {
          updateActiveTab({
            selectedFileIds: [...activeTab.selectedFileIds, id],
            lastSelectedId: id
          });
        }
      } else {
        if (onOpenFile) {
          onOpenFile(id);
        }
      }
      return;
    }

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
      let allFiles: string[] = displayFileIds;

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
  }, [activeTab, displayFileIds, closeContextMenu, isSelecting, updateActiveTab, isAndroid, isAndroidSelectionMode, onOpenFile]);

  const handleFileLongPress = useCallback((id: string) => {
    if (!isAndroid) return;
    if (onEnterAndroidSelectionMode) {
      onEnterAndroidSelectionMode(id);
    }
  }, [isAndroid, onEnterAndroidSelectionMode]);

  const handleAndroidRangeSelect = useCallback((id: string) => {
    if (!isAndroid || !isAndroidSelectionMode) return;
    if (activeTab.lastSelectedId && activeTab.selectedFileIds.length > 0) {
      const lastIndex = displayFileIds.indexOf(activeTab.lastSelectedId);
      const currentIndex = displayFileIds.indexOf(id);
      if (lastIndex !== -1 && currentIndex !== -1) {
        const start = Math.min(lastIndex, currentIndex);
        const end = Math.max(lastIndex, currentIndex);
        const rangeIds = displayFileIds.slice(start, end + 1);
        const merged = [...new Set([...activeTab.selectedFileIds, ...rangeIds])];
        updateActiveTab({
          selectedFileIds: merged,
          lastSelectedId: id
        });
      } else {
        updateActiveTab({
          selectedFileIds: [...activeTab.selectedFileIds, id],
          lastSelectedId: id
        });
      }
    } else {
      updateActiveTab({
        selectedFileIds: [...activeTab.selectedFileIds, id],
        lastSelectedId: id
      });
    }
  }, [isAndroid, isAndroidSelectionMode, activeTab, displayFileIds, updateActiveTab]);

  return { handleFileClick, handleFileLongPress, handleAndroidRangeSelect };
}
