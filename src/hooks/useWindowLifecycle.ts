import { useEffect, useRef } from 'react';
import { AppState } from '../types';
import { isTauriEnvironment } from '../utils/environment';
import { info as logInfo, warn as logWarn } from '../utils/logger';
import { translations } from '../utils/translations';
import {
  saveUserData as tauriSaveUserData,
  hideWindow,
  exitApp,
} from '../api/tauri-bridge';

interface UseWindowLifecycleProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  exitActionRef: React.MutableRefObject<'ask' | 'minimize' | 'exit'>;
  isLoading: boolean;
  setShowCloseConfirmation: (v: boolean) => void;
  rememberExitChoice: boolean;
  /**
   * 退出拦截(编辑器有未保存修改时):返回 true 表示已弹未保存警告、本次退出流程中止。
   * 在 X 关闭(onCloseRequested)与关闭确认弹窗的"退出"两处生效。
   */
  interceptExit?: () => boolean;
}

const saveUserData = async (data: any) => {
  if (!isTauriEnvironment()) return false;
  try {
    const result = await tauriSaveUserData(data);
    return result;
  } catch (error) {
    console.error('Failed to save user data via Tauri:', error);
    return false;
  }
};

export const useWindowLifecycle = ({
  state,
  setState,
  exitActionRef,
  isLoading,
  setShowCloseConfirmation,
  rememberExitChoice,
  interceptExit,
}: UseWindowLifecycleProps) => {
  // ref 持最新拦截器:onCloseRequested 监听只注册一次
  const interceptExitRef = useRef(interceptExit);
  interceptExitRef.current = interceptExit;

  useEffect(() => {
    exitActionRef.current = state.settings.exitAction;
  }, [state.settings.exitAction]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    const setupCloseListener = async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const currentWindow = getCurrentWindow();

        unlisten = await currentWindow.onCloseRequested(async (event) => {
          event.preventDefault();

          // 编辑器有未保存修改:弹未保存警告,本次关闭流程中止(由弹窗决定后续)
          if (interceptExitRef.current?.()) return;

          const exitAction = exitActionRef.current;

          if (exitAction === 'minimize') {
            await hideWindow();
          } else if (exitAction === 'exit') {
            currentWindow.destroy();
          } else {
            setShowCloseConfirmation(true);
          }
        });
      } catch (error) {
        logWarn('Window close listener not available', error);
      }
    };

    setupCloseListener();

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    const updateTitle = async () => {
      if (!isLoading && isTauriEnvironment()) {
        try {
          const { getCurrentWindow } = await import('@tauri-apps/api/window');
          const title = (translations as any)[state.settings.language]?.app?.title || 'Aurora Gallery';
          await getCurrentWindow().setTitle(title);
        } catch { }
      }
    };
    updateTitle();
  }, [state.settings.language, isLoading]);

  const handleExitConfirm = async (action: 'minimize' | 'exit') => {
    if (rememberExitChoice) {
      const newSettings = {
        ...state.settings,
        exitAction: action
      };
      setState(prev => ({ ...prev, settings: newSettings, activeModal: { type: null } }));
      await saveUserData({
        rootPaths: state.roots.map(id => state.files[id]?.path).filter(Boolean),
        customTags: state.customTags,
        people: state.people,
        settings: newSettings,
        fileMetadata: {}
      });
    } else {
      setState(s => ({ ...s, activeModal: { type: null } }));
    }
  };

  const handleCloseConfirmation = async (action: 'minimize' | 'exit', alwaysAsk: boolean) => {
    setShowCloseConfirmation(false);

    const exitActionToSave: 'ask' | 'minimize' | 'exit' = alwaysAsk ? 'ask' : action;

    const newSettings = {
      ...state.settings,
      exitAction: exitActionToSave
    };

    setState(prev => ({
      ...prev,
      settings: newSettings
    }));

    exitActionRef.current = exitActionToSave;

    try {
      const rootPaths = state.roots.map(id => state.files[id]?.path).filter(Boolean);
      await saveUserData({
        rootPaths,
        customTags: state.customTags,
        people: state.people,
        folderSettings: state.folderSettings,
        settings: newSettings,
        fileMetadata: {}
      });
    } catch (error) {
      console.error('Failed to save exit action preference:', error);
    }

    switch (action) {
      case 'minimize':
        await hideWindow();
        break;
      case 'exit':
        // 退出前拦截:编辑器有未保存修改 → 弹警告,本次退出中止
        if (interceptExitRef.current?.()) return;
        await exitApp();
        break;
    }
  };

  return {
    handleExitConfirm,
    handleCloseConfirmation,
  };
};
