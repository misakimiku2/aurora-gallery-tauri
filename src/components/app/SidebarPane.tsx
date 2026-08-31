import React from 'react';
import { Sidebar } from '../TreeSidebar';
import { FileNode, Person, TaskProgress } from '../../types';

interface SidebarPaneProps {
  isSidebarVisible: boolean;
  roots: string[];
  files: Record<string, FileNode>;
  people: Record<string, Person>;
  customTags: string[];
  currentFolderId: string;
  expandedIds: string[];
  tasks: TaskProgress[];
  onToggle: (id: string) => void;
  onNavigate: (id: string, options?: { targetId?: string, resetScroll?: boolean }) => void;
  onTagSelect: (tag: string) => void;
  onNavigateAllTags: () => void;
  onPersonSelect: (personId: string) => void;
  onNavigateAllPeople: () => void;
  onContextMenu: (e: React.MouseEvent, type: 'file' | 'tag' | 'tag-background' | 'root-folder' | 'background' | 'tab' | 'person', id: string) => void;
  isCreatingTag: boolean;
  onStartCreateTag: () => void;
  onSaveNewTag: (tag: string) => void;
  onCancelCreateTag: () => void;
  onOpenSettings: () => void;
  onRestoreTask: (taskId: string) => void;
  onPauseResume: (taskId: string, taskType: string) => void;
  onStartRenamePerson: (personId: string) => void;
  onCreatePerson: () => void;
  onNavigateTopics: () => void;
  onCreateTopic: () => void;
  onDropOnFolder?: (targetFolderId: string, sourceIds: string[]) => void;
  onOpenCanvas?: () => void;
  onNavigateHome?: () => void;
  activeViewMode: string;
  aiConnectionStatus: 'checking' | 'connected' | 'disconnected';
  t: (key: string) => string;
  filesVersion: number;
  lanRoots: string[];
  lanConnected: boolean;
  lanLoading: boolean;
  onNavigateNetworkFolder: (folderId: string) => void;
  onNavigateNetworkHome: () => void;
  onOpenLanSettings: () => void;
  androidDevices: import('../android-client/androidClientTypes').AndroidDeviceInfo[];
  androidActiveKey: string;
  onNavigateAndroidFolder: (folderId: string) => void;
  onNavigateAndroidHome: (key: string) => void;
  onOpenAndroidSettings: () => void;
}

// 左侧边栏外层布局 + Sidebar 组装（宽度/位移动画由 React 状态驱动）
export const SidebarPane = ({
  isSidebarVisible,
  roots,
  files,
  people,
  customTags,
  currentFolderId,
  expandedIds,
  tasks,
  onToggle,
  onNavigate,
  onTagSelect,
  onNavigateAllTags,
  onPersonSelect,
  onNavigateAllPeople,
  onContextMenu,
  isCreatingTag,
  onStartCreateTag,
  onSaveNewTag,
  onCancelCreateTag,
  onOpenSettings,
  onRestoreTask,
  onPauseResume,
  onStartRenamePerson,
  onCreatePerson,
  onNavigateTopics,
  onCreateTopic,
  onDropOnFolder,
  onOpenCanvas,
  onNavigateHome,
  activeViewMode,
  aiConnectionStatus,
  t,
  filesVersion,
  lanRoots,
  lanConnected,
  lanLoading,
  onNavigateNetworkFolder,
  onNavigateNetworkHome,
  onOpenLanSettings,
  androidDevices,
  androidActiveKey,
  onNavigateAndroidFolder,
  onNavigateAndroidHome,
  onOpenAndroidSettings,
}: SidebarPaneProps) => {
  return (
    <div
      className="shrink-0 z-40 overflow-hidden bg-panel"
      style={{ width: isSidebarVisible ? '16rem' : '0rem', transition: 'width 300ms ease-out' }}>
      <div
        className="h-full flex flex-col"
        style={{
          width: '16rem',
          transform: isSidebarVisible ? 'translateX(0)' : 'translateX(-100%)',
          transition: 'transform 300ms ease-out',
          // 常驻合成层：文件夹树（含每行 Folder3DIcon 三图拼贴）在首次可见时一次栅格化，
          // 之后开合就只是平移合成层，不再逐帧重绘新露出的部分。安卓端实测左面板动画
          // 比右面板（内容为空）卡，主要就是这棵树的逐帧光栅化。
          willChange: 'transform',
        }}>
        <Sidebar
          roots={roots}
          files={files}
          people={people}
          customTags={customTags}
          currentFolderId={currentFolderId}
          expandedIds={expandedIds}
          tasks={tasks}
          onToggle={onToggle}
          onNavigate={onNavigate}
          onTagSelect={onTagSelect}
          onNavigateAllTags={onNavigateAllTags}
          onPersonSelect={onPersonSelect}
          onNavigateAllPeople={onNavigateAllPeople}
          onContextMenu={onContextMenu}
          isCreatingTag={isCreatingTag}
          onStartCreateTag={onStartCreateTag}
          onSaveNewTag={onSaveNewTag}
          onCancelCreateTag={onCancelCreateTag}
          onOpenSettings={onOpenSettings}
          onRestoreTask={onRestoreTask}
          onPauseResume={onPauseResume}
          onStartRenamePerson={onStartRenamePerson}
          onCreatePerson={onCreatePerson}
          onNavigateTopics={onNavigateTopics}
          onCreateTopic={onCreateTopic}
          onDropOnFolder={onDropOnFolder}
          onOpenCanvas={onOpenCanvas}
          onNavigateHome={onNavigateHome}
          activeViewMode={activeViewMode}
          aiConnectionStatus={aiConnectionStatus}
          t={t}
          filesVersion={filesVersion}
          lanRoots={lanRoots}
          lanConnected={lanConnected}
          lanLoading={lanLoading}
          onNavigateNetworkFolder={onNavigateNetworkFolder}
          onNavigateNetworkHome={onNavigateNetworkHome}
          onOpenLanSettings={onOpenLanSettings}
          androidDevices={androidDevices}
          androidActiveKey={androidActiveKey}
          onNavigateAndroidFolder={onNavigateAndroidFolder}
          onNavigateAndroidHome={onNavigateAndroidHome}
          onOpenAndroidSettings={onOpenAndroidSettings}
        />
      </div>
    </div>
  );
};
