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
  /**
   * 当前 Tab 处于**图片编辑态**时置 true：标签页级快捷键全部让路。
   *
   * 为什么必须让：编辑器的键位照 Photoshop（UI 设计 §8.2），与应用级键位正面冲突——
   * `Ctrl+T` 应用拿去开新标签、编辑器拿它进自由变换（一次按键做两件事）；
   * `Delete` 在编辑器里将来要删图层，绝不能顺手删文件；`Ctrl+W` 将来可能是选区。
   * 关掉整组而不是逐个打补丁，未来加编辑键位时才不用再回来改这里。
   */
  isEditorMode?: boolean;
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
      const { tabs, activeTabId, selectedFileIds, onSwitchTab, onCloseTab, onNewTab, onRefresh, onRequestDelete, isReferenceMode, isEditorMode } = optsRef.current;

      /**
       * 编辑态：**整组**标签页快捷键让路（UI 设计 §8.2）。
       *
       * 不是逐个 `if` 里判，而是整体 return——漏一个就是"按一下同时做两件事"，
       * 这类冲突只会在用户手上暴露；而且将来编辑器再加键位时不用回来改这里。
       *
       * 唯一保留 Ctrl+R：它是应用级刷新，编辑器不占用这个键。
       */
      if (isEditorMode) {
        const isAppRefresh = e.ctrlKey && e.key === 'r';
        if (!isAppRefresh) return;
      }

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

      // Ctrl+W: Close current tab (disabled in reference mode)
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        if (isReferenceMode) return;
        if (tabs && tabs.length > 1) {
          onCloseTab(e as any, activeTabId);
        }
        return;
      }

      // Ctrl+T: New tab (disabled in reference mode)
      if (e.ctrlKey && e.key === 't') {
        e.preventDefault();
        if (isReferenceMode) return;
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
