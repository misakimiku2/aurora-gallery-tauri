import React, { useEffect } from 'react';
import { Undo2, X } from 'lucide-react';
import { DeletionTask } from '../types';

interface ToastItemProps {
    task: DeletionTask;
    onUndo: () => void;
    onDismiss: () => void;
    t: (key: string) => string;
}

export const ToastItem: React.FC<ToastItemProps> = ({ task, onUndo, onDismiss: onDismissProp, t }) => {
    useEffect(() => {
        const timer = setTimeout(() => { onDismissProp(); }, 5000);
        return () => clearTimeout(timer);
    }, []);
    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl animate-toast-up overflow-hidden pointer-events-auto border border-gray-200 dark:border-gray-700 flex flex-col min-w-[300px]">
            <div className="px-4 py-3 flex items-center gap-3 relative z-10 justify-between">
                <div className="flex items-center">
                    <span className="text-sm text-gray-700 dark:text-gray-200 whitespace-nowrap">{t('context.deletedItems').replace('{count}', task.files.length.toString())}</span>
                    <button onClick={onUndo} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200 font-bold text-sm flex items-center whitespace-nowrap ml-2">
                        <Undo2 size={16} className="mr-1" /> {t('context.undo')}
                    </button>
                </div>
                <button onClick={onDismissProp} className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300">
                    <X size={16} />
                </button>
            </div>
            <div className="h-1 bg-gray-100 dark:bg-gray-700 w-full">
                <div className="h-full bg-blue-500 animate-countdown origin-left"></div>
            </div>
        </div>
    );
};
