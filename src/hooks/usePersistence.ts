import { useEffect } from 'react';
import type { AppState, Person } from '../types';
import { isTauriEnvironment } from '../utils/environment';
import { isMockFileSystemActive } from '../utils/mockFileSystem';
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

    // 启动治理(2026-11-14):退化快照绝不落盘。自动保存每秒一次忠实快照内存,
    // 而 mock 兜底/扫描全失败会把 state.roots 变成假根或空——存盘就会顶掉
    // user_data.json 里的用户真实库根(实测发生过:rootPaths 被改写成 C:/Photos)。
    // - mock 激活=兜底态,数据是演示假数据;
    // - rootPaths 空=roots 为空(扫描失败/过渡)或根节点映射不出 path(节点缺失),
    //   真根仍留在盘上,等恢复正常状态的下一次快照。
    // 删根/换根等用户主动流走 handleChangePath 的显式保存,不经过这里。
    if (isMockFileSystemActive()) return;
    if (rootPaths.length === 0) return;

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
