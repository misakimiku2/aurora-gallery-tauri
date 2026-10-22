import React, { useSyncExternalStore } from 'react';
import { MetadataPanel } from '../MetadataPanel';
import { MobileColorPickerSheet } from '../MobileColorPickerSheet';
import { EditorPanel } from '../editor/EditorPanel';
import { buildPreviewKey, peekPreview, subscribePreview } from '../editor/editorPreviewCache';
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
  // 编辑态：容器不变、内容换成 PS 式面板组（UI 设计 §1.2「模式驱动的双态」）。
  // 代理图元信息从模块级缓存订阅——它和编辑器画布不在同一棵子树里，这样不用
  // 把 0.5MB 的 data URL 提升到 React state（那会被 tabs 持久化带进 localStorage）。
  // 键必须与画布同源（含裁剪参数），否则裁完面板还显示旧尺寸。
  const editorDoc = activeTab.editorDocument;
  const editorMeta = useSyncExternalStore(
    subscribePreview,
    () => (editorDoc?.path ? peekPreview(buildPreviewKey(editorDoc.path, editorDoc.crop)) : undefined)
  );

  return (
    <>
      <div
        className="metadata-panel-container shrink-0 z-40 overflow-hidden bg-panel"
        style={{ width: state.layout.isMetadataVisible ? '20rem' : '0rem', transition: 'width 300ms ease-out' }}>
        <div
          className="h-full flex flex-col"
          style={{ width: '20rem', transform: state.layout.isMetadataVisible ? 'translateX(0)' : 'translateX(100%)', transition: 'transform 300ms ease-out', willChange: 'transform' }}>
          {activeTab.viewMode === 'editor' ? (
            <EditorPanel
              tabId={activeTab.id}
              previewDataUrl={editorMeta?.dataUrl}
              documentName={activeTab.editorDocument?.name || '未命名'}
              width={editorMeta?.width ?? 0}
              height={editorMeta?.height ?? 0}
              previewWidth={editorMeta?.previewWidth ?? 0}
              previewHeight={editorMeta?.previewHeight ?? 0}
            />
          ) : (
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
          )}
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
