import { useEffect, type Dispatch, type SetStateAction } from 'react';

interface UseComparerShortcutsOptions {
  isActiveTab: boolean;
  isAddImageModalOpen: boolean;
  setIsAddImageModalOpen: Dispatch<SetStateAction<boolean>>;
  isReferenceMode: boolean;
  toggleReferenceMode: () => void;
  onClose: () => void;
  onCloseTab?: () => void;
  setIsSnappingEnabled: Dispatch<SetStateAction<boolean>>;
}

// 对比画布快捷键：
//   Esc —— 优先级1 关闭添加图片弹窗 / 优先级2 退出参考模式 / 优先级3 关闭标签页
//   A   —— 切换吸附功能
//   R   —— 切换参考模式
export function useComparerShortcuts({
  isActiveTab,
  isAddImageModalOpen,
  setIsAddImageModalOpen,
  isReferenceMode,
  toggleReferenceMode,
  onClose,
  onCloseTab,
  setIsSnappingEnabled,
}: UseComparerShortcutsOptions) {
  useEffect(() => {
    if (!isActiveTab) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // 优先级1: 如果添加图片窗口打开，关闭它
        if (isAddImageModalOpen) {
          setIsAddImageModalOpen(false);
          return;
        }
        // 优先级2: 如果处于参考模式，退出参考模式
        if (isReferenceMode) {
          toggleReferenceMode();
          return;
        }
        // 优先级3: 关闭标签页
        if (onCloseTab) onCloseTab();
        else onClose();
      }
      if (e.key === 'a' || e.key === 'A') {
        setIsSnappingEnabled(prev => !prev);
      }
      if (e.key === 'r' || e.key === 'R') {
        toggleReferenceMode();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, onCloseTab, toggleReferenceMode, isAddImageModalOpen, isReferenceMode, isActiveTab]);
}
