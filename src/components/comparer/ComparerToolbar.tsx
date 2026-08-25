import React from 'react';
import { Sidebar, ChevronLeft, Scan, Magnet, Eye, Plus, MoreVertical, Save, FolderOpen, RefreshCcw, PanelRight } from 'lucide-react';

interface ComparerToolbarProps {
  isReferenceMode: boolean;
  isAndroid: boolean;
  isSnappingEnabled: boolean;
  isEditingTitle: boolean;
  sessionName: string;
  imageCount: number;
  layoutProp?: { isSidebarVisible?: boolean; isMetadataVisible?: boolean };
  t: (key: string) => string;
  onLayoutToggle?: (part: 'sidebar' | 'metadata') => void;
  onClose: () => void;
  onCloseTab?: () => void;
  setIsSnappingEnabled: (v: boolean) => void;
  toggleReferenceMode: () => void;
  handleOpenAddImageModal: () => void;
  handleOpenAndroidMenu: (e: React.MouseEvent) => void;
  handleSaveSession: () => void;
  handleLoadSession: () => void;
  handleViewAll: () => void;
  handleReset: () => void;
  setIsEditingTitle: (v: boolean) => void;
  setSessionName: (v: string) => void;
  onSessionNameChange?: (name: string) => void;
}

export const ComparerToolbar: React.FC<ComparerToolbarProps> = ({
  isReferenceMode,
  isAndroid,
  isSnappingEnabled,
  isEditingTitle,
  sessionName,
  imageCount,
  layoutProp,
  t,
  onLayoutToggle,
  onClose,
  onCloseTab,
  setIsSnappingEnabled,
  toggleReferenceMode,
  handleOpenAddImageModal,
  handleOpenAndroidMenu,
  handleSaveSession,
  handleLoadSession,
  handleViewAll,
  handleReset,
  setIsEditingTitle,
  setSessionName,
  onSessionNameChange,
}) => {
  return (
    <div
      id="comparer-toolbar"
      className={`bg-white/90 dark:bg-[#262626]/90 backdrop-blur-md flex items-center px-4 justify-between shrink-0 transition-transform duration-200 ease-out h-14 relative z-10`}
    >
      <div className="flex items-center space-x-2">
        {!isReferenceMode && (
          <button
            onClick={() => onLayoutToggle?.('sidebar')}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${layoutProp?.isSidebarVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
            title={t('viewer.toggleSidebar')}
          >
            <Sidebar size={18} />
          </button>
        )}

        <button
          onClick={() => { onCloseTab ? onCloseTab() : onClose(); }}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
          title={t('viewer.close')}
        >
          <ChevronLeft size={18} />
        </button>
      </div>

      <div className="flex-1 text-center truncate px-4 font-medium text-gray-800 dark:text-gray-200 flex justify-center items-center">
        <div className="text-gray-900 dark:text-gray-100 font-semibold flex items-center text-lg">
          {isEditingTitle ? (
            <input
              autoFocus
              className="bg-transparent border-b-2 border-blue-500 outline-none text-center px-2 py-1 min-w-[200px]"
              value={sessionName}
              onChange={(e) => {
                if (isEditingTitle) {
                  setSessionName(e.currentTarget.value);
                  onSessionNameChange?.(e.currentTarget.value);
                }
              }}
              onBlur={() => setIsEditingTitle(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setIsEditingTitle(false);
              }}
            />
          ) : (
            <div
              className="cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800 px-4 py-1 rounded transition-colors flex items-center"
              onClick={() => setIsEditingTitle(true)}
            >
              <Scan size={20} className="mr-3 text-blue-500" />
              {sessionName}
            </div>
          )}
          <span className="ml-3 text-sm font-normal text-gray-500 dark:text-gray-400 bg-gray-100 dark:bg-[#3a3a3a] px-3 py-1 rounded-full">
            {imageCount} / 24
          </span>
        </div>
      </div>

      <div className="flex items-center space-x-2">
        {!isAndroid && (
          <button
            onClick={() => setIsSnappingEnabled(!isSnappingEnabled)}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-all ${isSnappingEnabled ? 'text-blue-500' : 'text-gray-400'}`}
            title={`吸附功能 (A): ${isSnappingEnabled ? 'ON' : 'OFF'}`}
          >
            <Magnet size={18} className={isSnappingEnabled ? 'text-blue-500' : 'text-gray-400'} />
          </button>
        )}

        {!isAndroid && (
          <button
            onClick={toggleReferenceMode}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-all ${isReferenceMode ? 'text-blue-500' : 'text-gray-400'}`}
            title={`参考模式 (R): ${isReferenceMode ? 'ON' : 'OFF'}`}
          >
            <Eye size={18} className={isReferenceMode ? 'text-blue-500' : 'text-gray-400'} />
          </button>
        )}

        {/* Android 添加图片按钮 */}
        {isAndroid && (
          <button
            onClick={handleOpenAddImageModal}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
            title="添加图片"
          >
            <Plus size={18} />
          </button>
        )}

        {/* Android 更多按钮 */}
        {isAndroid && (
          <button
            onMouseDown={handleOpenAndroidMenu}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
            title="更多"
          >
            <MoreVertical size={18} />
          </button>
        )}

        {!isAndroid && (
          <button
            onClick={handleSaveSession}
            disabled={imageCount === 0}
            className={`p-2 rounded ${imageCount === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-800'} text-gray-600 dark:text-gray-300`}
            title="保存对比信息"
          >
            <Save size={18} />
          </button>
        )}

        {!isAndroid && (
          <button
            onClick={handleLoadSession}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
            title="读取对比信息"
          >
            <FolderOpen size={18} />
          </button>
        )}

        {!isAndroid && <div className="w-px h-4 bg-gray-200 dark:bg-gray-700 mx-1" />}

        {!isAndroid && (
          <button
            onClick={handleViewAll}
            disabled={imageCount === 0}
            className={`p-2 rounded ${imageCount === 0 ? 'opacity-50 cursor-not-allowed' : 'hover:bg-gray-100 dark:hover:bg-gray-800'} text-gray-600 dark:text-gray-300 transition-colors`}
            title="查看全部"
          >
            <Scan size={18} />
          </button>
        )}

        {!isAndroid && (
          <button
            onClick={handleReset}
            className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300 transition-colors"
            title="重置画布"
          >
            <RefreshCcw size={18} />
          </button>
        )}

        {!isReferenceMode && (
          <button
            onClick={() => onLayoutToggle?.('metadata')}
            className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${layoutProp?.isMetadataVisible ? 'text-blue-500 dark:text-blue-400' : 'text-gray-500 dark:text-gray-400'}`}
            title={t('viewer.toggleMeta')}
          >
            <PanelRight size={18} />
          </button>
        )}
      </div>
    </div>
  );
};
