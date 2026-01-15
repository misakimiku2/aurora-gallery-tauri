import React from 'react';
import { LucideIcon } from 'lucide-react';

interface ConfirmModalProps {
    title: string;
    message: string;
    subMessage?: string;
    confirmText?: string;
    confirmIcon?: LucideIcon;
    onClose: () => void;
    onConfirm: () => void;
    t: (key: string) => string;
}

export const ConfirmModal: React.FC<ConfirmModalProps> = ({ title, message, subMessage, confirmText, confirmIcon: Icon, onClose, onConfirm, t }) => (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl max-w-sm w-full animate-zoom-in">
        <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">{title}</h3>
        <p className="text-gray-700 dark:text-gray-300 mb-2 text-sm">{message}</p>
        {subMessage && <p className="text-sm text-gray-500 mb-6 bg-gray-50 dark:bg-gray-900/50 p-2 rounded border border-gray-100 dark:border-gray-700">{subMessage}</p>}
        <div className="flex justify-end space-x-3">
            <button onClick={onClose} className="px-4 py-2 rounded text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm">{t('settings.cancel')}</button>
            <button onClick={onConfirm} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 flex items-center text-sm font-medium">
                {Icon && <Icon size={16} className="mr-2" />}
                {confirmText || t('settings.confirm')}
            </button>
        </div>
    </div>
);
