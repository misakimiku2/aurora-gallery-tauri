import React from 'react';
import { LogOut } from 'lucide-react';

interface ExitConfirmModalProps {
    remember: boolean;
    onConfirm: (action: 'minimize' | 'exit') => void;
    onCancel: () => void; // Unused in usage? onClose handles it via cancel logic
    onRememberChange: (remember: boolean) => void;
    t: (key: string) => string;
}

export const ExitConfirmModal: React.FC<ExitConfirmModalProps> = ({ remember, onConfirm, onCancel, onRememberChange, t }) => {
    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl max-w-sm w-full animate-zoom-in">
            <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">{t('exitModal.title')}</h3>
            <p className="text-gray-700 dark:text-gray-300 mb-6 text-sm">{t('exitModal.message')}
            </p>

            <div className="flex items-center mb-6">
                <input
                    type="checkbox"
                    id="rememberChoice"
                    checked={remember}
                    onChange={(e) => onRememberChange(e.target.checked)}
                    className="mr-2"
                />
                <label htmlFor="rememberChoice" className="text-sm text-gray-600 dark:text-gray-400 select-none cursor-pointer">{t('exitModal.remember')}</label>
            </div>

            <div className="flex justify-end space-x-3">
                <button onClick={() => onConfirm('minimize')} className="px-4 py-2 rounded text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 text-sm border border-gray-300 dark:border-gray-600">
                    {t('exitModal.minimize')}
                </button>
                <button onClick={() => onConfirm('exit')} className="bg-red-600 text-white px-4 py-2 rounded hover:bg-red-700 flex items-center text-sm font-medium">
                    <LogOut size={16} className="mr-2" />
                    {t('exitModal.exit')}
                </button>
            </div>
        </div>
    );
};
