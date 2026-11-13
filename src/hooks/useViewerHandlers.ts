import type { AppState, TabState } from '../types';
import { FileType } from '../types';
import { useEffect, useRef } from 'react';
import { info as logInfo } from '../utils/logger';
import { useNavigation } from './useNavigation';
import { discardAdjustViewerSession } from './useImageAdjust';

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
  // ── 调整会话治理(轻量编辑器,2026-11-14 用户拍板)────────────────────────
  // 关查看器的所有路径(后退钮=onNavigateBack 历史弹栈/Esc/关闭钮/closeViewer/
  // 原生桥)最终都表现为 activeTab.viewingFileId 非空 → 空。盯这个过渡统一收口:
  // 丢弃本会话全部未保存调整(参数行+网格角标/缩略图联动)+ 关编辑面板。
  // 换图(A→B)不触发;强杀应用遗留的参数行由 useImageAdjust 的加载登记在下次
  // 打开+关闭时自愈。丢弃的幂等性使 StrictMode 双跑无害。
  const prevViewingRef = useRef<string | null>(null);
  useEffect(() => {
    const prev = prevViewingRef.current;
    prevViewingRef.current = activeTab.viewingFileId;
    if (prev && prev !== activeTab.viewingFileId && !activeTab.viewingFileId) {
      discardAdjustViewerSession();
    }
  }, [activeTab.viewingFileId]);

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

    // 导航序列：混排图片与视频，只排除文件夹（设计文档 §5.1）。
    // 旧实现 === IMAGE 会让视频被排除在序列环之外，永远无法在混排里连续翻页。
    // random 分支（:53）也一并走同一序列。
    const mediaFileIds = displayFileIds.filter(id => state.files[id].type !== FileType.FOLDER);
    if (mediaFileIds.length === 0) return;

    let currentIndex = mediaFileIds.indexOf(activeTab.viewingFileId);

    // If current file is not in the list (shouldn't happen), start from beginning
    if (currentIndex === -1) {
      currentIndex = 0;
    }

    let nextIndex = currentIndex;
    if (direction === 'random') {
      nextIndex = Math.floor(Math.random() * mediaFileIds.length);
    } else if (direction === 'next') {
      nextIndex = (currentIndex + 1) % mediaFileIds.length;
    } else {
      nextIndex = (currentIndex - 1 + mediaFileIds.length) % mediaFileIds.length;
    }

    const nextId = mediaFileIds[nextIndex];
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
