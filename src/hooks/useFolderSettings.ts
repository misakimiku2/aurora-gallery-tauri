import { useEffect, useRef, useCallback } from 'react';
import type { AppState, TabState, GroupByOption } from '../types';

interface UseFolderSettingsProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  activeTab: TabState;
  groupBy: GroupByOption;
  setGroupBy: React.Dispatch<React.SetStateAction<GroupByOption>>;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  savedDataLoaded: boolean;
  showToast: (msg: string) => void;
  t: (key: string) => string;
}

export function useFolderSettings({
  state,
  setState,
  activeTab,
  groupBy,
  setGroupBy,
  updateActiveTab,
  savedDataLoaded,
  showToast,
  t,
}: UseFolderSettingsProps) {
  const folderSettingsRef = useRef(state.folderSettings);

  useEffect(() => {
    folderSettingsRef.current = state.folderSettings;
  }, [state.folderSettings]);

  useEffect(() => {
    if (!savedDataLoaded) return;
    if (activeTab.viewMode !== 'browser') return;
    const folderId = activeTab.folderId;
    const savedSettings = folderSettingsRef.current[folderId];

    if (savedSettings) {
      let hasChanges = false;
      if (activeTab.layoutMode !== savedSettings.layoutMode) hasChanges = true;
      if (state.sortBy !== savedSettings.sortBy) hasChanges = true;
      if (state.sortDirection !== savedSettings.sortDirection) hasChanges = true;
      if (groupBy !== savedSettings.groupBy) hasChanges = true;

      if (hasChanges) {
        console.debug('[FolderSettings] Applying saved settings for folder', folderId, savedSettings);
        setState(prev => ({
          ...prev,
          sortBy: savedSettings.sortBy,
          sortDirection: savedSettings.sortDirection,
        }));
        setGroupBy(savedSettings.groupBy);
        updateActiveTab({ layoutMode: savedSettings.layoutMode });
      }
    }
  }, [activeTab.folderId, activeTab.id, activeTab.viewMode, savedDataLoaded]);

  useEffect(() => {
    if (!savedDataLoaded) return;

    if (activeTab.viewMode !== 'browser') return;
    const folderId = activeTab.folderId;
    const saved = state.folderSettings[folderId];

    if (saved) {
      const currentSettings = {
        layoutMode: activeTab.layoutMode,
        sortBy: state.sortBy,
        sortDirection: state.sortDirection,
        groupBy: groupBy
      };

      if (
        saved.layoutMode !== currentSettings.layoutMode ||
        saved.sortBy !== currentSettings.sortBy ||
        saved.sortDirection !== currentSettings.sortDirection ||
        saved.groupBy !== currentSettings.groupBy
      ) {
        setState(prev => ({
          ...prev,
          folderSettings: {
            ...prev.folderSettings,
            [folderId]: currentSettings
          }
        }));
      }
    }
  }, [activeTab.layoutMode, state.sortBy, state.sortDirection, groupBy, activeTab.folderId, activeTab.viewMode, state.folderSettings, savedDataLoaded]);

  const handleRememberFolderSettings = useCallback(() => {
    if (activeTab.viewMode !== 'browser') return;
    const folderId = activeTab.folderId;
    const folder = state.files[folderId];
    if (!folder || folder.type !== 'folder') return;

    const settings = {
      layoutMode: activeTab.layoutMode,
      sortBy: state.sortBy,
      sortDirection: state.sortDirection,
      groupBy: groupBy
    };

    const isCurrentlySaved = !!state.folderSettings[folderId];

    setState(prev => {
      const newFolderSettings = { ...prev.folderSettings };
      if (isCurrentlySaved) {
        delete newFolderSettings[folderId];
      } else {
        newFolderSettings[folderId] = settings;
      }
      return { ...prev, folderSettings: newFolderSettings };
    });

    showToast(isCurrentlySaved ? t('folderSettings.remember') : t('folderSettings.saved'));
  }, [activeTab, state, groupBy, setState, showToast, t]);

  return { handleRememberFolderSettings };
}
