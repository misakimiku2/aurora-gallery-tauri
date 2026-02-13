import React from 'react';
import { AppState, 
  TabState, 
  Person, 
  Topic, 
  FileNode, 
  AppSettings,
  UpdateInfo,
  DownloadProgress
} from '../types';
import { Trash2, FilePlus, Merge, AlertTriangle } from 'lucide-react';

// Import from their original locations
import { SettingsModal as SettingsModalComp } from './SettingsModal';
import { CloseConfirmationModal as CloseConfirmationModalComp } from './CloseConfirmationModal';
import { WelcomeModal as WelcomeModalComp } from './modals/WelcomeModal';
import { AlertModal as AlertModalComp } from './modals/AlertModal';
import { ConfirmModal as ConfirmModalComp } from './modals/ConfirmModal';
import { RenameTagModal as RenameTagModalComp } from './modals/RenameTagModal';
import { RenamePersonModal as RenamePersonModalComp } from './modals/RenamePersonModal';
import { BatchRenameModal as BatchRenameModalComp } from './modals/BatchRenameModal';
import { AIBatchRenameModal as AIBatchRenameModalComp } from './modals/AIBatchRenameModal';
import { AddToPersonModal as AddToPersonModalComp } from './modals/AddToPersonModal';
import { ClearPersonModal as ClearPersonModalComp } from './modals/ClearPersonModal';
import { AddToTopicModal as AddToTopicModalComp } from './modals/AddToTopicModal';
import { TagEditor as TagEditorComp } from './modals/TagEditor';
import { FolderPickerModal as FolderPickerModalComp } from './modals/FolderPickerModal';
import { ExitConfirmModal as ExitConfirmModalComp } from './modals/ExitConfirmModal';
import { CropAvatarModal as CropAvatarModalComp } from './modals/CropAvatarModal';
import { CreateTopicModal as CreateTopicModalComp } from './modals/CreateTopicModal';
import { RenameTopicModal as RenameTopicModalComp } from './modals/RenameTopicModal';
import { UpdateModal as UpdateModalComp } from './modals/UpdateModal';

interface AppModalsProps {
  state: AppState;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  t: (key: string) => string;
  activeTab: TabState;
  peopleWithDisplayCounts: Record<string, Person>;
  handleManualAddPerson: (personIds: string[]) => void | Promise<void>;
  handleManualAddToTopic: (topicId: string) => void | Promise<void>;
  handleRenameTag: (oldTag: string, newName: string) => void | Promise<void>;
  handleBatchRename: (pattern: string, startNum: number) => void | Promise<void>;
  handleAIBatchRename: (newNames: Record<string, string>) => void | Promise<void>;
  handleRenamePerson: (personId: string, newName: string) => void | Promise<void>;
  handleConfirmDeleteTags: (tags: string[]) => void | Promise<void>;
  handleDeletePerson: (idOrIds: string | string[]) => void | Promise<void>;
  handleCreateTopic: (parentId: string | null, name?: string, type?: string) => void;
  handleUpdateTopic: (topicId: string, updates: Partial<Topic>) => void;
  handleUpdateFile: (fileId: string, updates: Partial<FileNode>) => void;
  handleCopyFiles: (fileIds: string[], targetFolderId: string) => void | Promise<void>;
  handleMoveFiles: (fileIds: string[], targetFolderId: string) => void | Promise<void>;
  handleResolveFileCollision: (sourceId: string, desiredName: string) => void | Promise<void>;
  handleResolveFolderMerge: (sourceId: string, targetId: string) => void | Promise<void>;
  handleResolveExtensionChange: (sourceId: string, desiredName: string) => void | Promise<void>;
  handleSaveAvatarCrop: (personId: string, box: any) => void | Promise<void>;
  handleExitConfirm: (action: 'minimize' | 'exit') => void | Promise<void>;
  handleClearPersonInfo: (fileIds: string[], personIds?: string[]) => void | Promise<void>;
  showToast: (msg: string) => void;
  rememberExitChoice: boolean;
  setRememberExitChoice: (val: boolean) => void;
  // Settings specific
  handleChangePath: (type: 'resource' | 'cache') => void | Promise<void>;
  // Welcome specific
  showWelcome: boolean;
  handleWelcomeFinish: () => void;
  handleOpenFolder: () => void | Promise<void>;
  // Scan progress passed to Welcome modal
  scanProgress?: { processed: number; total: number } | null;
  isScanning?: boolean;
  // Close confirmation
  showCloseConfirmation: boolean;
  setShowCloseConfirmation: (val: boolean) => void;
  handleCloseConfirmation: (action: 'minimize' | 'exit', alwaysAsk: boolean) => void | Promise<void>;
  // Update modal
  updateInfo: UpdateInfo | null;
  downloadProgress: DownloadProgress | null;
  onStartDownload: () => void;
  onPauseDownload: () => void;
  onResumeDownload: () => void;
  onCancelDownload: () => void;
  onInstallUpdate: () => void;
  onOpenDownloadFolder: () => void;
  onIgnoreUpdate: () => void;
  onDismissUpdate: () => void;
  // About panel
  onCheckUpdate: () => void;
  isCheckingUpdate: boolean;
}

export const AppModals: React.FC<AppModalsProps> = ({
  state,
  setState,
  t,
  activeTab,
  peopleWithDisplayCounts,
  handleManualAddPerson,
  handleManualAddToTopic,
  handleRenameTag,
  handleBatchRename,
  handleAIBatchRename,
  handleRenamePerson,
  handleConfirmDeleteTags,
  handleDeletePerson,
  handleCreateTopic,
  handleUpdateTopic,
  handleUpdateFile,
  handleCopyFiles,
  handleMoveFiles,
  handleResolveFileCollision,
  handleResolveFolderMerge,
  handleResolveExtensionChange,
  handleSaveAvatarCrop,
  handleExitConfirm,
  handleClearPersonInfo,
  showToast,
  rememberExitChoice,
  setRememberExitChoice,
  handleChangePath,
  showWelcome,
  handleWelcomeFinish,
  handleOpenFolder,
  showCloseConfirmation,
  setShowCloseConfirmation,
  handleCloseConfirmation,
  isScanning = false,
  updateInfo,
  downloadProgress,
  onStartDownload,
  onPauseDownload,
  onResumeDownload,
  onCancelDownload,
  onInstallUpdate,
  onOpenDownloadFolder,
  onIgnoreUpdate,
  onDismissUpdate,
  onCheckUpdate,
  isCheckingUpdate,
}) => {
  const closeModals = () => setState(s => ({ ...s, activeModal: { type: null } }));

  return (
    <>
      {/* Main Modal Overlay */}
      {state.activeModal.type && (
        <div className="fixed inset-0 z-[100] bg-black/50 flex items-center justify-center p-4">
          {state.activeModal.type === 'alert' && state.activeModal.data && (
            <AlertModalComp 
              message={state.activeModal.data.message} 
              onClose={closeModals} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'add-to-person' && (
            <AddToPersonModalComp 
              people={peopleWithDisplayCounts} 
              files={state.files} 
              onConfirm={handleManualAddPerson} 
              onClose={closeModals} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'add-to-topic' && (
            <AddToTopicModalComp 
              topics={state.topics} 
              onConfirm={handleManualAddToTopic} 
              onClose={closeModals} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'rename-tag' && state.activeModal.data && (
            <RenameTagModalComp 
              initialTag={state.activeModal.data.tag} 
              onConfirm={handleRenameTag} 
              onClose={closeModals} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'batch-rename' && (
            <BatchRenameModalComp
              key="batch-rename"
              count={activeTab.selectedFileIds.length}
              onConfirm={handleBatchRename}
              onClose={closeModals}
              onAutoRename={() => setState(s => ({ ...s, activeModal: { type: 'ai-batch-rename' } }))}
              t={t}
            />
          )}

          {state.activeModal.type === 'ai-batch-rename' && (
            <AIBatchRenameModalComp
              key="ai-batch-rename"
              files={activeTab.selectedFileIds.map(id => state.files[id]).filter(Boolean)}
              settings={state.settings}
              people={state.people}
              onConfirm={(newNames) => {
                handleAIBatchRename(newNames);
                closeModals();
              }}
              onClose={closeModals}
              onBack={() => setState(s => ({ ...s, activeModal: { type: 'batch-rename' } }))}
              t={t}
            />
          )}
          
          {state.activeModal.type === 'rename-person' && state.activeModal.data && (
            <RenamePersonModalComp 
              initialName={peopleWithDisplayCounts[state.activeModal.data.personId]?.name || ''} 
              onConfirm={(newName: string) => handleRenamePerson(state.activeModal.data.personId, newName)} 
              onClose={closeModals} 
              t={t} 
            />
          )}

          {state.activeModal.type === 'create-topic' && (
            <CreateTopicModalComp
              onClose={closeModals}
              onCreate={(name, type) => {
                handleCreateTopic(state.activeModal.data?.parentId || null, name, type);
                closeModals();
              }}
              t={t}
            />
          )}

          {state.activeModal.type === 'rename-topic' && state.activeModal.data && (
            <RenameTopicModalComp
              topic={state.topics[state.activeModal.data.topicId]}
              onClose={closeModals}
              onRename={(name, type) => {
                handleUpdateTopic(state.activeModal.data.topicId, { name, ...(typeof type === 'string' ? { type } : {}) });
                closeModals();
              }}
              t={t}
            />
          )}
          
          {state.activeModal.type === 'confirm-delete-tag' && state.activeModal.data && (
            <ConfirmModalComp 
              title={t('context.deleteTagConfirmTitle')} 
              message={t('context.deleteTagConfirmMsg')} 
              confirmText={t('context.deleteTagConfirmBtn')} 
              confirmIcon={Trash2} 
              onClose={closeModals} 
              onConfirm={() => { 
                handleConfirmDeleteTags(state.activeModal.data.tags); 
                closeModals(); 
              }} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'confirm-delete-person' && state.activeModal.data && (
            <ConfirmModalComp 
              title={t('context.deletePersonConfirmTitle')} 
              message={t('context.deletePersonConfirmMsg')} 
              subMessage={typeof state.activeModal.data.personId === 'string' ? peopleWithDisplayCounts[state.activeModal.data.personId]?.name : `${state.activeModal.data.personId.length}`} 
              confirmText={t('settings.confirm')} 
              confirmIcon={Trash2} 
              onClose={closeModals} 
              onConfirm={() => { 
                handleDeletePerson(state.activeModal.data.personId); 
                closeModals(); 
              }} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'edit-tags' && state.activeModal.data && (
            <TagEditorComp 
              file={state.files[state.activeModal.data.fileId]} 
              files={state.files} 
              onUpdate={handleUpdateFile} 
              onClose={closeModals} 
              t={t} 
            />
          )}
          
          {(state.activeModal.type === 'copy-to-folder' || state.activeModal.type === 'move-to-folder') && (
            <FolderPickerModalComp 
              type={state.activeModal.type} 
              files={state.files} 
              roots={state.roots} 
              selectedFileIds={state.activeModal.data?.fileIds || activeTab.selectedFileIds} 
              onClose={closeModals} 
              onConfirm={(targetId: string) => { 
                const fileIds = state.activeModal.data?.fileIds || activeTab.selectedFileIds; 
                if (state.activeModal.type === 'copy-to-folder') handleCopyFiles(fileIds, targetId); 
                else handleMoveFiles(fileIds, targetId); 
                closeModals(); 
              }} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'confirm-rename-file' && state.activeModal.data && (
            <ConfirmModalComp 
              title={t('settings.collisionTitle')} 
              message={t('settings.fileCollisionMsg')} 
              subMessage={`"${state.activeModal.data.desiredName}"`} 
              confirmText={t('settings.renameAuto')} 
              confirmIcon={FilePlus} 
              onClose={closeModals} 
              onConfirm={() => { 
                handleResolveFileCollision(state.activeModal.data.sourceId, state.activeModal.data.desiredName); 
                closeModals(); 
              }} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'confirm-merge-folder' && state.activeModal.data && (
            <ConfirmModalComp 
              title={t('settings.collisionTitle')} 
              message={t('settings.folderCollisionMsg')} 
              subMessage={t('settings.mergeDesc')} 
              confirmText={t('settings.mergeFolder')} 
              confirmIcon={Merge} 
              onClose={closeModals} 
              onConfirm={() => { 
                handleResolveFolderMerge(state.activeModal.data.sourceId, state.activeModal.data.targetId); 
                closeModals(); 
              }} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'confirm-extension-change' && state.activeModal.data && (
            <ConfirmModalComp 
              title={t('settings.extensionChangeTitle')} 
              message={t('settings.extensionChangeMsg')} 
              subMessage={t('settings.extensionChangeConfirm')} 
              confirmText={t('settings.confirm')} 
              confirmIcon={AlertTriangle} 
              onClose={closeModals} 
              onConfirm={() => { 
                handleResolveExtensionChange(state.activeModal.data.sourceId, state.activeModal.data.desiredName); 
                closeModals(); 
              }} 
              t={t} 
            />
          )}
          
          {state.activeModal.type === 'confirm-overwrite-file' && state.activeModal.data && (
            <ConfirmModalComp 
              title={t('settings.collisionTitle')} 
              message={state.activeModal.data.files.length === 1 ? t('settings.fileOverwriteMsg') : t('settings.filesOverwriteMsg').replace('%count%', state.activeModal.data.files.length.toString())} 
              subMessage={state.activeModal.data.files.slice(0, 5).join(', ') + (state.activeModal.data.files.length > 5 ? `...` : '')} 
              confirmText={t('settings.confirm')} 
              confirmIcon={AlertTriangle} 
              onClose={() => { 
                state.activeModal.data.onCancel?.(); 
                closeModals(); 
              }} 
              onConfirm={() => { 
                state.activeModal.data.onConfirm?.(); 
                closeModals(); 
              }} 
              t={t} 
            />
          )}

          {state.activeModal.type === 'crop-avatar' && state.activeModal.data && (
            <CropAvatarModalComp
              fileUrl={state.activeModal.data.fileUrl}
              initialBox={state.activeModal.data.initialBox}
              personId={state.activeModal.data.personId}
              allFiles={state.files}
              people={peopleWithDisplayCounts}
              onConfirm={(box: any) => handleSaveAvatarCrop(state.activeModal.data.personId, box)}
              onClose={closeModals}
              t={t}
              resourceRoot={state.settings.paths.resourceRoot}
              cachePath={state.settings.paths.cacheRoot || (state.settings.paths.resourceRoot ? `${state.settings.paths.resourceRoot}${state.settings.paths.resourceRoot.includes('\\') ? '\\' : '/'}.Aurora_Cache` : undefined)}
            />
          )}

          {state.activeModal.type === 'exit-confirm' && (
            <ExitConfirmModalComp
              remember={rememberExitChoice}
              onRememberChange={setRememberExitChoice}
              onConfirm={handleExitConfirm}
              onCancel={closeModals}
              t={t}
            />
          )}

          {state.activeModal.type === 'clear-person' && state.activeModal.data && (
            <ClearPersonModalComp
              files={state.files}
              fileIds={state.activeModal.data.fileIds}
              people={peopleWithDisplayCounts}
              onConfirm={(personIds: string[]) => {
                handleClearPersonInfo(state.activeModal.data.fileIds, personIds);
                closeModals();
                showToast(t('context.saved'));
              }}
              onClose={closeModals}
              t={t}
            />
          )}
        </div>
      )}

      {/* Settings Modal */}
      {state.isSettingsOpen && (
        <SettingsModalComp
          state={state}
          onClose={() => setState(s => ({ ...s, isSettingsOpen: false }))}
          onUpdateSettings={(updates) => {
            setState(s => ({ ...s, ...updates }));
          }}
          onUpdateSettingsData={(updates) => {
            setState(s => {
              const newSettings = { ...s.settings, ...updates };
              return { ...s, settings: newSettings };
            });
          }}
          onUpdatePath={handleChangePath}
          onUpdateAIConnectionStatus={(status) => setState(s => ({ ...s, aiConnectionStatus: status }))}
          t={t}
          updateInfo={updateInfo}
          onCheckUpdate={onCheckUpdate}
          isCheckingUpdate={isCheckingUpdate}
          downloadProgress={downloadProgress}
          onInstallUpdate={onInstallUpdate}
          onOpenDownloadFolder={onOpenDownloadFolder}
        />
      )}

      {/* Close Confirmation */}
      {showCloseConfirmation && (
        <CloseConfirmationModalComp
          onClose={() => setShowCloseConfirmation(false)}
          onAction={handleCloseConfirmation}
          t={t}
        />
      )}

      {/* Welcome Modal */}
      <WelcomeModalComp
        show={showWelcome}
        onFinish={handleWelcomeFinish}
        onSelectFolder={handleOpenFolder}
        currentPath={state.roots.length > 0 ? state.files[state.roots[0]]?.path : ''}
        settings={state.settings}
        onUpdateSettings={(updates: Partial<AppSettings>) => setState(s => ({ ...s, settings: { ...s.settings, ...updates } }))}
        t={t}
        scanProgress={state.scanProgress || null}
        isScanning={state.isScanning}
      />

      {/* Update Modal */}
      <UpdateModalComp
        isOpen={state.activeModal.type === 'update' && !!updateInfo}
        updateInfo={updateInfo}
        downloadProgress={downloadProgress}
        onClose={() => {
          onDismissUpdate();
          closeModals();
        }}
        onStartDownload={onStartDownload}
        onPauseDownload={onPauseDownload}
        onResumeDownload={onResumeDownload}
        onCancelDownload={onCancelDownload}
        onInstall={onInstallUpdate}
        onOpenFolder={onOpenDownloadFolder}
        onIgnore={() => {
          onIgnoreUpdate();
          closeModals();
        }}
        t={t}
      />
    </>
  );
};
