import { useEffect } from 'react';
import type { AppState, Person } from '../types';
import { isTauriEnvironment } from '../utils/environment';
import { saveUserData as tauriSaveUserData } from '../api/tauri-bridge';

interface UsePersistenceProps {
  state: AppState;
  peopleWithDisplayCounts: Record<string, Person>;
}

export function usePersistence({ state, peopleWithDisplayCounts }: UsePersistenceProps) {
  const saveUserData = async (data: unknown) => {
    if (!isTauriEnvironment()) {
      return false;
    }

    try {
      const result = await tauriSaveUserData(data);
      return result;
    } catch (error) {
      console.error('Failed to save user data via Tauri:', error);
      return false;
    }
  };

  useEffect(() => {
    const isTauriEnv = isTauriEnvironment();

    if (!isTauriEnv) {
      return;
    }

    const rootPaths = state.roots.map(id => state.files[id]?.path).filter(Boolean);

    const dataToSave = {
      rootPaths,
      customTags: state.customTags,
      people: peopleWithDisplayCounts,
      topics: state.topics,
      folderSettings: state.folderSettings,
      settings: state.settings
    };

    const timer = setTimeout(async () => {
      try {
        await saveUserData(dataToSave);
      } catch (err) {
        console.error('Auto save failed:', err);
      }
    }, 1000);
    return () => clearTimeout(timer);
  }, [state.roots, state.customTags, state.people, state.topics, state.settings, state.folderSettings, peopleWithDisplayCounts]);
}
