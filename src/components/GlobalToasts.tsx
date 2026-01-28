import React from 'react';
import { ToastItem } from './ToastItem';
import type { DeletionTask } from '../types';

type Props = {
  deletionTasks: DeletionTask[];
  undoDelete: (id: string) => void;
  dismissDelete: (id: string) => void;
  showDragHint: boolean;
  isCompareMode: boolean;
  toast: { msg: string; visible: boolean };
  t: (k: string) => string;
};

export const GlobalToasts: React.FC<Props> = ({ deletionTasks, undoDelete, dismissDelete, showDragHint, isCompareMode, toast, t }) => {
  return (
    <div className="absolute bottom-6 left-1/2 transform -translate-x-1/2 z-[110] flex flex-col-reverse items-center gap-2 pointer-events-none">
      {deletionTasks.map(task => (
        <ToastItem key={task.id} task={task} onUndo={() => undoDelete(task.id)} onDismiss={() => dismissDelete(task.id)} t={t} />
      ))}

      {toast.visible && (
        <div className="bg-black/80 text-white text-sm px-4 py-2 rounded-full shadow-lg backdrop-blur-sm animate-toast-up">
          {toast.msg}
        </div>
      )}

      {showDragHint && !isCompareMode && (
        <div className="bg-blue-600 dark:bg-blue-700 text-white text-sm px-4 py-2.5 rounded-full shadow-lg backdrop-blur-sm animate-toast-up flex items-center gap-2 pointer-events-auto">
          <span>{t('drag.multiSelectHint')}</span>
        </div>
      )}
    </div>
  );
};
