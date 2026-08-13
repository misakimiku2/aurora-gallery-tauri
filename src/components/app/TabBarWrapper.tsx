import React from 'react';
import { TabBar } from '../TabBar';
import { isAndroidPlatformCached, hideWindow, exitApp } from '../../api/tauri-bridge';
import { FileNode, Person, TabState, Topic } from '../../types';

interface TabBarWrapperProps {
  tabs: TabState[];
  activeTabId: string;
  files: Record<string, FileNode>;
  topics: Record<string, Topic>;
  people: Record<string, Person>;
  onSwitchTab: (id: string) => void;
  onCloseTab: (e: any, id: string) => void;
  onNewTab: () => void;
  onContextMenu: (e: React.MouseEvent, type: 'file' | 'tag' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person', id: string) => void;
  t: (key: string) => string;
  showWindowControls: boolean;
  isReferenceMode: boolean;
  onHoverChange: (isHovering: boolean) => void;
  exitActionRef: React.MutableRefObject<'ask' | 'minimize' | 'exit'>;
  setShowCloseConfirmation: React.Dispatch<React.SetStateAction<boolean>>;
}

// 顶部标签栏（TabBar）包装：非安卓端渲染，并处理关闭窗口时的退出偏好
export const TabBarWrapper = ({
  tabs,
  activeTabId,
  files,
  topics,
  people,
  onSwitchTab,
  onCloseTab,
  onNewTab,
  onContextMenu,
  t,
  showWindowControls,
  isReferenceMode,
  onHoverChange,
  exitActionRef,
  setShowCloseConfirmation,
}: TabBarWrapperProps) => {
  if (isAndroidPlatformCached()) return null;
  return (
    <TabBar
      tabs={tabs}
      activeTabId={activeTabId}
      files={files}
      topics={topics}
      people={people}
      onSwitchTab={onSwitchTab}
      onCloseTab={onCloseTab}
      onNewTab={onNewTab}
      onContextMenu={(e, id) => onContextMenu(e, 'tab', id)}
      onCloseWindow={async () => {
        // Check user's exit action preference from ref (always latest value)
        const exitAction = exitActionRef.current;

        if (exitAction === 'minimize') {
          // Minimize to tray
          await hideWindow();
        } else if (exitAction === 'exit') {
          // Exit immediately
          await exitApp();
        } else {
          // Ask user (default behavior)
          setShowCloseConfirmation(true);
        }
      }}
      t={t}
      showWindowControls={showWindowControls}
      isReferenceMode={isReferenceMode}
      onHoverChange={onHoverChange}
    />
  );
};
