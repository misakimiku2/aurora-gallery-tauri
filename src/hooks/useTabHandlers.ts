import { useCallback } from 'react';
import type { AppState, FileNode, GroupByOption, TabState } from '../types';
import { FileType } from '../types';
import { DUMMY_TAB, DEFAULT_LAYOUT_SETTINGS } from '../constants';
import { generateId } from '../utils/pathUtils';
import { downloadLanImagesBatched } from '../components/lan-client/lanDownload';
import { isAndroidPlatformCached } from '../api/tauri-bridge';

interface UseTabHandlersParams {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  setGroupBy: React.Dispatch<React.SetStateAction<GroupByOption>>;
  isAndroidSelectionMode: boolean;
  setIsAndroidSelectionMode: (value: boolean) => void;
  handleOpenCompareInNewTab: (imageIds: string[]) => void;
  setLanDownloadProgress: React.Dispatch<React.SetStateAction<{ active: boolean; completed: number; total: number }>>;
  showToast: (msg: string) => void;
  t: (key: string) => string;
}

/**
 * 标签页/画布相关 handlers：新标签页打开（文件/专题/人物/画布）、
 * 图片加入比较画布、关闭其他/全部标签页等。
 */
export const useTabHandlers = ({
  state,
  setState,
  setGroupBy,
  isAndroidSelectionMode,
  setIsAndroidSelectionMode,
  handleOpenCompareInNewTab,
  setLanDownloadProgress,
  showToast,
  t,
}: UseTabHandlersParams) => {
  const handleOpenInNewTab = useCallback((fileId: string) => {
    const file = state.files[fileId];
    if (!file) return;
    const isFolder = file.type === FileType.FOLDER;
    const targetFolderId = isFolder ? fileId : (file.parentId || fileId);
    const targetViewingId = isFolder ? null : fileId;

    // Check for folder-specific settings, otherwise use global defaults
    const savedFolderSettings = state.folderSettings[targetFolderId];
    const globalSettings = state.settings.defaultLayoutSettings || DEFAULT_LAYOUT_SETTINGS;

    const layoutMode = savedFolderSettings?.layoutMode || globalSettings.layoutMode;
    const sortBy = savedFolderSettings?.sortBy || globalSettings.sortBy;
    const sortDirection = savedFolderSettings?.sortDirection || globalSettings.sortDirection;
    const groupBySetting = savedFolderSettings?.groupBy || globalSettings.groupBy;

    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: targetFolderId,
      viewingFileId: targetViewingId,
      layoutMode: layoutMode as any,
      selectedFileIds: [fileId],
      lastSelectedId: fileId,
      isCompareMode: false,
      history: { stack: [{ folderId: targetFolderId, viewingId: targetViewingId, viewMode: 'browser', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }
    };

    // Apply groupBy and sort settings
    setGroupBy(groupBySetting as any);
    setState(prev => ({
      ...prev,
      tabs: [...prev.tabs, newTab],
      activeTabId: newTab.id,
      sortBy: sortBy,
      sortDirection: sortDirection
    }));
  }, [state.files, state.folderSettings, state.settings.defaultLayoutSettings, setState]);

  const handleOpenTopicInNewTab = useCallback((topicId: string) => {
    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: state.roots[0] || '',
      viewMode: 'topics-overview',
      activeTopicId: topicId,
      selectedTopicIds: [topicId],
      isCompareMode: false,
      history: { stack: [{ folderId: state.roots[0] || '', viewingId: null, viewMode: 'topics-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: null }], currentIndex: 0 }
    };
    setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  }, [state.roots, setState]);

  const handleOpenPersonInNewTab = useCallback((personId: string) => {
    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: state.roots[0] || '',
      viewMode: 'people-overview',
      activePersonId: personId,
      selectedPersonIds: [personId],
      isCompareMode: false,
      history: { stack: [{ folderId: state.roots[0] || '', viewingId: null, viewMode: 'people-overview', searchQuery: '', searchScope: 'all', activeTags: [], activePersonId: personId }], currentIndex: 0 }
    };
    setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  }, [state.roots, setState]);

  const handleOpenCanvas = useCallback(() => {
    // 生成新的画布名称
    const generateCanvasName = () => {
      const existingNames = state.tabs
        .filter(tab => tab.isCompareMode)
        .map(tab => tab.sessionName)
        .filter((name): name is string => !!name);

      let maxNum = 0;
      existingNames.forEach(name => {
        const match = name.match(/^画布(\d+)$/);
        if (match) {
          maxNum = Math.max(maxNum, parseInt(match[1], 10));
        }
      });

      return `画布${String(maxNum + 1).padStart(2, '0')}`;
    };

    const newTab: TabState = {
      ...DUMMY_TAB,
      id: Math.random().toString(36).substr(2, 9),
      folderId: state.roots[0] || '',
      selectedFileIds: [],
      isCompareMode: true,
      sessionName: generateCanvasName(),
      history: {
        stack: [{
          folderId: state.roots[0] || '',
          viewingId: null,
          viewMode: 'browser',
          searchQuery: '',
          searchScope: 'all',
          activeTags: [],
          activePersonId: null
        }],
        currentIndex: 0
      }
    };
    setState(prev => ({ ...prev, tabs: [...prev.tabs, newTab], activeTabId: newTab.id }));
  }, [state.roots, state.tabs, setState]);

  const handleOpenCompareAndClearSelection = useCallback((imageIds: string[]) => {
    // 安卓端：限制为单个画布，先关闭所有现有比较模式 tab（避免无 TabBar UI 切换导致画布堆积）
    if (isAndroidPlatformCached()) {
      setState(prev => {
        const newTabs = prev.tabs.filter(t => !t.isCompareMode);
        // 若过滤后无 tab（异常情况），保留原 tabs 不动
        if (newTabs.length === 0) return prev;
        return { ...prev, tabs: newTabs };
      });
    }
    handleOpenCompareInNewTab(imageIds);
    if (isAndroidSelectionMode) {
      setIsAndroidSelectionMode(false);
    }
  }, [handleOpenCompareInNewTab, isAndroidSelectionMode, setState]);

  const handleAddToCompareCanvas = useCallback(async (tabId: string, imageIds: string[]) => {
    const targetTab = state.tabs.find(t => t.id === tabId);
    if (!targetTab || !targetTab.isCompareMode) return;

    const currentCount = targetTab.selectedFileIds.length;
    const maxCount = 24;
    const remainingSpace = maxCount - currentCount;

    if (remainingSpace <= 0) {
      showToast(t('context.canvasFull') || '画布已满');
      return;
    }

    // 只添加能容纳的图片
    let idsToAdd = imageIds.slice(0, remainingSpace);

    // 处理 LAN 来源图片：先下载到本地缓存，再以本地节点加入画布
    const lanIds = idsToAdd.filter(id => state.files[id]?.source === 'lan' && state.files[id]?.remotePath);
    if (lanIds.length > 0) {
      const cacheRoot = state.settings.paths.cacheRoot;
      if (!cacheRoot) {
        showToast(t('lanClient.downloadNoCache') || '缓存目录未配置，无法下载桌面图片');
        return;
      }
      const remotePaths = lanIds.map(id => state.files[id].remotePath!);
      setLanDownloadProgress({ active: true, completed: 0, total: lanIds.length });
      try {
        const results = await downloadLanImagesBatched(remotePaths, cacheRoot, (completed, total) => {
          setLanDownloadProgress({ active: true, completed, total });
        });

        // 为下载成功的图片创建本地 FileNode（复制 LAN 节点信息，改写路径与来源）
        const newLocalNodes: Record<string, FileNode> = {};
        const idMap: Record<string, string> = {};
        let failedCount = 0;
        results.forEach((res, idx) => {
          const lanId = lanIds[idx];
          const lanFile = state.files[lanId];
          if (res.success && lanFile) {
            const newId = generateId(res.localPath);
            newLocalNodes[newId] = {
              ...lanFile,
              id: newId,
              path: res.localPath,
              source: 'local',
              remotePath: undefined,
              parentId: null,
            };
            idMap[lanId] = newId;
          } else {
            failedCount++;
          }
        });

        // 合并本地节点到 state.files
        if (Object.keys(newLocalNodes).length > 0) {
          setState(prev => ({
            ...prev,
            files: { ...prev.files, ...newLocalNodes },
          }));
        }

        // 用新的本地 id 替换 LAN id；下载失败的 LAN id 予以剔除
        idsToAdd = idsToAdd
          .map(id => idMap[id] || id)
          .filter(id => !lanIds.includes(id) || idMap[id]);

        if (failedCount > 0) {
          showToast((t('lanClient.downloadPartialFail') || '部分桌面图片下载失败：{count} 张').replace('{count}', String(failedCount)));
        }
      } catch (err) {
        console.error('[LAN] Download failed:', err);
        showToast(t('lanClient.downloadFailed') || '下载桌面图片失败');
        // 下载整体失败时剔除所有 LAN id，仅添加本地图片
        idsToAdd = idsToAdd.filter(id => !lanIds.includes(id));
      } finally {
        setLanDownloadProgress({ active: false, completed: 0, total: 0 });
      }
    }

    const actuallyAdded = idsToAdd.length;
    if (actuallyAdded === 0) return;

    const sourceTabId = state.activeTabId;

    setState(prev => ({
      ...prev,
      activeTabId: tabId,
      tabs: prev.tabs.map(tab =>
        tab.id === tabId
          ? { ...tab, selectedFileIds: [...tab.selectedFileIds, ...idsToAdd] }
          : tab.id === sourceTabId
            ? { ...tab, selectedFileIds: [], lastSelectedId: null }
            : tab
      )
    }));

    // 退出 Android 多选模式
    if (isAndroidSelectionMode) {
      setIsAndroidSelectionMode(false);
    }

    // 显示提示
    if (actuallyAdded < imageIds.length) {
      showToast(t('context.partiallyAdded')?.replace('{added}', String(actuallyAdded)).replace('{total}', String(imageIds.length)) || `已添加 ${actuallyAdded}/${imageIds.length} 张图片（画布已满）`);
    } else {
      showToast(t('context.addedToCanvas') || '已添加到画布');
    }
  }, [state.tabs, state.files, state.settings.paths.cacheRoot, setState, showToast, t]);

  const handleCloseAllTabs = () => {
    setState(prev => {
      if (prev.tabs.length <= 1) return prev;
      // 保留第一个 tab，关闭其他所有 tab
      const firstTab = prev.tabs[0];
      return { ...prev, tabs: [firstTab], activeTabId: firstTab.id };
    });
  };

  const handleCloseOtherTabs = (id: string) => {
    setState(prev => {
      const keptTab = prev.tabs.find(t => t.id === id);
      if (!keptTab) return prev;
      return { ...prev, tabs: [keptTab], activeTabId: id };
    });
  };

  return {
    handleOpenInNewTab,
    handleOpenTopicInNewTab,
    handleOpenPersonInNewTab,
    handleOpenCanvas,
    handleOpenCompareAndClearSelection,
    handleAddToCompareCanvas,
    handleCloseAllTabs,
    handleCloseOtherTabs,
  };
};
