import type { AppState, TabState } from '../types';
import { FileType } from '../types';
import { info as logInfo } from '../utils/logger';
import { useNavigation } from './useNavigation';

interface UseViewerHandlersParams {
  activeTab: TabState;
  state: AppState;
  displayFileIds: string[];
  selectionRef: React.RefObject<HTMLElement | null>;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  pushHistory: ReturnType<typeof useNavigation>['pushHistory'];
}

/**
 * 查看器相关 handlers：关闭查看器、上一张/下一张/随机导航、跳转到指定图片。
 */
export const useViewerHandlers = ({
  activeTab,
  state,
  displayFileIds,
  selectionRef,
  updateActiveTab,
  pushHistory,
}: UseViewerHandlersParams) => {
  const closeViewer = () => {
    const currentScroll = selectionRef.current?.scrollTop || 0;
    if (activeTab.history.stack[activeTab.history.currentIndex].viewingId) {
      logInfo('[App] closeViewer.pop', { action: 'closeViewer', mode: 'pop', container: 'main', containerScroll: currentScroll });
      pushHistory(activeTab.folderId, null, activeTab.viewMode as any, activeTab.searchQuery, activeTab.searchScope, activeTab.activeTags, activeTab.activePersonId, activeTab.scrollTop, activeTab.aiFilter, activeTab.activeTopicId);
    } else {
      logInfo('[App] closeViewer.clear', { action: 'closeViewer', mode: 'clear', container: 'main', containerScroll: currentScroll });
      updateActiveTab({ viewingFileId: null });
    }
  };

  const handleViewerNavigate = (direction: 'next' | 'prev' | 'random') => {
    if (!activeTab.viewingFileId) return;

    // Filter to get only image file IDs
    const imageFileIds = displayFileIds.filter(id => state.files[id].type === FileType.IMAGE);
    if (imageFileIds.length === 0) return;

    const currentFile = state.files[activeTab.viewingFileId];
    let currentIndex = imageFileIds.indexOf(activeTab.viewingFileId);

    // If current file is not in image list (shouldn't happen), start from beginning
    if (currentIndex === -1) {
      currentIndex = 0;
    }

    let nextIndex = currentIndex;
    if (direction === 'random') {
      nextIndex = Math.floor(Math.random() * imageFileIds.length);
    } else if (direction === 'next') {
      nextIndex = (currentIndex + 1) % imageFileIds.length;
    } else {
      nextIndex = (currentIndex - 1 + imageFileIds.length) % imageFileIds.length;
    }

    const nextId = imageFileIds[nextIndex];
    updateActiveTab(prev => {
      const newStack = [...prev.history.stack];
      if (prev.history.currentIndex >= 0 && prev.history.currentIndex < newStack.length) {
        newStack[prev.history.currentIndex] = { ...newStack[prev.history.currentIndex], viewingId: nextId };
      }
      return { viewingFileId: nextId, selectedFileIds: [nextId], lastSelectedId: nextId, history: { ...prev.history, stack: newStack } };
    });
  };

  const handleViewerJump = (fileId: string) => {
    updateActiveTab(prev => {
      const newStack = [...prev.history.stack];
      if (prev.history.currentIndex >= 0 && prev.history.currentIndex < newStack.length) {
        newStack[prev.history.currentIndex] = { ...newStack[prev.history.currentIndex], viewingId: fileId };
      }
      return { viewingFileId: fileId, selectedFileIds: [fileId], lastSelectedId: fileId, history: { ...prev.history, stack: newStack } };
    });
  };

  return { closeViewer, handleViewerNavigate, handleViewerJump };
};
