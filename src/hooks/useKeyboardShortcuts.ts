import { useEffect, useRef } from 'react';
import type { TabState } from '../types';
import { isTextEditingTarget } from '../utils/keyboardTarget';

type Opts = {
  tabs: TabState[];
  activeTabId: string;
  selectedFileIds: string[];
  onSwitchTab: (id: string) => void;
  onCloseTab: (e: any, id: string) => void;
  onNewTab: () => void;
  onRefresh: () => void;
  onRequestDelete: (ids: string[]) => void;
  isReferenceMode?: boolean;
};

/**
 * Centralize window-level keyboard shortcuts so they can be tested and reused.
 * Keeps the same behaviour as the original inline useEffect in `App.tsx`.
 */
export function useKeyboardShortcuts(opts: Opts) {
  const optsRef = useRef<Opts>(opts);
  optsRef.current = opts;

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const { tabs, activeTabId, selectedFileIds, onSwitchTab, onCloseTab, onNewTab, onRefresh, onRequestDelete, isReferenceMode } = optsRef.current;

      // Ctrl+Tab: Switch to next tab (disabled in reference mode)
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault();
        if (isReferenceMode) return;
        if (!tabs || tabs.length === 0) return;
        const currentIndex = tabs.findIndex(tab => tab.id === activeTabId);
        const nextIndex = (currentIndex + 1) % tabs.length;
        const nextTabId = tabs[nextIndex].id;
        onSwitchTab(nextTabId);
        return;
      }

      // 编辑器标签页:屏蔽 Ctrl+W(关标签)/Ctrl+T(新建标签),防误触丢编辑上下文;
      // Ctrl+Tab 切标签保留(上方分支不受影响)
      const activeTab = tabs?.find(t => t.id === activeTabId);
      const inEditor = activeTab?.isEditorMode === true;

      // Ctrl+W: Close current tab (disabled in reference mode)
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        if (isReferenceMode || inEditor) return;
        if (tabs && tabs.length > 1) {
          onCloseTab(e as any, activeTabId);
        }
        return;
      }

      // Ctrl+T: New tab (disabled in reference mode)
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        if (isReferenceMode || inEditor) return;
        onNewTab();
        return;
      }

      // Ctrl+R: Refresh
      if (e.ctrlKey && e.key === 'r') {
        e.preventDefault();
        onRefresh();
        return;
      }

      // Delete: Delete selected files/folders
      if (e.key === 'Delete') {
        // 在输入框里删字符不该顺手删文件（查看器开着时右侧面板就是可编辑的）
        if (e.isComposing || isTextEditingTarget(e.target)) return;
        // 编辑器标签页:Delete/Backspace 是清除/填充像素的 PS 键位,不删图库文件
        if (inEditor) return;
        if (selectedFileIds && selectedFileIds.length > 0) {
          e.preventDefault();
          onRequestDelete(selectedFileIds);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);
}
