import React, { useRef } from 'react';
import {
  X, CheckCheck, Trash2, MoreVertical, XCircle, Share2
} from 'lucide-react';
import { FileNode, TabState, Person } from '../types';
import { androidShareImages } from '../api/tauri-bridge';

interface AndroidSelectionBarProps {
  selectedCount: number;
  totalCount: number;
  selectedFileIds: string[];
  files: Record<string, FileNode>;
  activeTab: TabState;
  peopleWithDisplayCounts: Record<string, Person>;
  t: (key: string) => string;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onDeselectAll: () => void;
  onDelete: (ids: string[]) => void;
  onShowContextMenu: (x: number, y: number) => void;
}

export const AndroidSelectionBar: React.FC<AndroidSelectionBarProps> = ({
  selectedCount,
  totalCount,
  selectedFileIds,
  files,
  activeTab,
  peopleWithDisplayCounts,
  t,
  onSelectAll,
  onClearSelection,
  onDeselectAll,
  onDelete,
  onShowContextMenu,
}) => {
  const moreButtonRef = useRef<HTMLButtonElement>(null);

  const handleMoreClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (moreButtonRef.current) {
      const rect = moreButtonRef.current.getBoundingClientRect();
      const x = rect.right;
      const y = rect.bottom + 4;
      onShowContextMenu(x, y);
    }
  };

  const handleShare = () => {
    const imagePaths = selectedFileIds
      .map(id => files[id]?.path)
      .filter((p): p is string => !!p);
    if (imagePaths.length > 0) {
      androidShareImages(imagePaths);
    }
  };

  return (
    <div className="h-14 bg-white dark:bg-[#262626] flex items-center px-3 justify-between shrink-0 z-30 android-topbar">
      <div className="flex items-center space-x-2 min-w-fit">
        <button
          onClick={onClearSelection}
          className="w-10 h-10 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-[#3a3a3a] text-gray-600 dark:text-gray-300"
        >
          <X size={20} />
        </button>
        <span className="text-gray-900 dark:text-white font-semibold text-sm">
          {selectedCount}/{totalCount}
        </span>
      </div>

      <div className="flex items-center space-x-1">
        <button
          onClick={selectedCount === totalCount ? onDeselectAll : onSelectAll}
          className="w-10 h-10 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-[#3a3a3a] text-gray-600 dark:text-gray-300"
          title={selectedCount === totalCount ? t('context.deselectAll') : t('context.selectAll')}
        >
          {selectedCount === totalCount ? <XCircle size={20} /> : <CheckCheck size={20} />}
        </button>

        <button
          onClick={() => onDelete(selectedFileIds)}
          className="w-10 h-10 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-[#3a3a3a] text-red-500 dark:text-red-400"
          title={t('context.delete')}
        >
          <Trash2 size={20} />
        </button>

        <button
          onClick={handleShare}
          className="w-10 h-10 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-[#3a3a3a] text-gray-600 dark:text-gray-300"
          title={t('viewer.share') || 'Share'}
        >
          <Share2 size={20} />
        </button>

        <button
          ref={moreButtonRef}
          onClick={handleMoreClick}
          onMouseDown={(e) => e.stopPropagation()}
          onTouchStart={(e) => e.stopPropagation()}
          className="w-10 h-10 flex items-center justify-center rounded hover:bg-gray-100 dark:hover:bg-[#3a3a3a] text-gray-600 dark:text-gray-300"
        >
          <MoreVertical size={20} />
        </button>
      </div>
    </div>
  );
};
