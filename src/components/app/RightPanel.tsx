import React from 'react';
import { MetadataPanel } from '../MetadataPanel';
import { MobileColorPickerSheet } from '../MobileColorPickerSheet';
import { isAndroidPlatformCached } from '../../api/tauri-bridge';
import { AppState, FileNode, Person, TabState, Topic } from '../../types';

interface RightPanelProps {
  state: AppState;
  activeTab: TabState;
  peopleWithDisplayCounts: Record<string, Person>;
  filesVersion: number;
  t: (key: string) => string;
  handleUpdateFile: (id: string, updates: Partial<FileNode>) => void;
  handleUpdatePerson: (personId: string, updates: Partial<Person>) => void;
  handleUpdateTopic: (topicId: string, updates: Partial<Topic>) => void;
  handleDeleteTopic: (topicId: string) => void;
  handleNavigateTopic: (topicId: string | null) => void;
  handleNavigatePerson: (personId: string | null) => void;
  handleNavigateFolder: (id: string, options?: { targetId?: string, resetScroll?: boolean }) => void;
  enterTagView: (tagName: string) => void;
  onPerformSearch: (query: string) => void;
  handlePerformSearch: (query: string) => void;
  toggleColorPicker: () => void;
}

// 右侧面板：元数据面板（桌面）+ 颜色选择器面板（安卓）
export const RightPanel = ({
  state,
  activeTab,
  peopleWithDisplayCounts,
  filesVersion,
  t,
  handleUpdateFile,
  handleUpdatePerson,
  handleUpdateTopic,
  handleDeleteTopic,
  handleNavigateTopic,
  handleNavigatePerson,
  handleNavigateFolder,
  enterTagView,
  onPerformSearch,
  handlePerformSearch,
  toggleColorPicker,
}: RightPanelProps) => {
  return (
    <>
      <div
        className="metadata-panel-container shrink-0 z-40 overflow-hidden bg-panel"
        style={{ width: state.layout.isMetadataVisible ? '20rem' : '0rem', transition: 'width 300ms ease-out' }}>
        <div
          className="h-full flex flex-col"
          style={{ width: '20rem', transform: state.layout.isMetadataVisible ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 300ms ease-out', willChange: 'transform' }}>
          <MetadataPanel
            files={state.files}
            selectedFileIds={activeTab.selectedFileIds}
            people={peopleWithDisplayCounts}
            topics={state.topics}
            selectedPersonIds={activeTab.selectedPersonIds}
            selectedTopicIds={activeTab.selectedTopicIds}
            onUpdate={handleUpdateFile}
            onUpdatePerson={handleUpdatePerson}
            onUpdateTopic={handleUpdateTopic}
            onDeleteTopic={handleDeleteTopic}
            onSelectTopic={handleNavigateTopic}
            onSelectPerson={handleNavigatePerson}
            onNavigateToFolder={handleNavigateFolder}
            onNavigateToTag={enterTagView}
            onSearch={onPerformSearch}
            t={t}
            activeTab={activeTab}
            resourceRoot={state.settings.paths.resourceRoot}
            cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)}
            filesVersion={filesVersion}
            settings={state.settings}
            aiConnectionStatus={state.aiConnectionStatus}
          />
        </div>
      </div>
      {isAndroidPlatformCached() && (
        <div
          className="color-picker-panel-container shrink-0 z-40 overflow-hidden bg-panel"
          style={{ width: state.layout.isColorPickerVisible ? '20rem' : '0rem', transition: 'width 300ms ease-out' }}>
          <div
            className="h-full flex flex-col"
            style={{ width: '20rem', transform: state.layout.isColorPickerVisible ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 300ms ease-out', willChange: 'transform' }}>
            <MobileColorPickerSheet
              onSearch={(color) => handlePerformSearch(`color:${color}`)}
              onClose={toggleColorPicker}
              t={t}
            />
          </div>
        </div>
      )}
    </>
  );
};
