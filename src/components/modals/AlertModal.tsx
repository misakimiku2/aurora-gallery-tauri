import React from 'react';
import { AlertTriangle } from 'lucide-react';

interface AlertModalProps {
    message: string;
    onClose: () => void;
    t: (key: string) => string;
}

export const AlertModal: React.FC<AlertModalProps> = ({ message, onClose, t }) => (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl max-w-sm w-full animate-zoom-in">
        <div className="flex items-center mb-4 text-orange-500">
            <AlertTriangle className="mr-2" />
            <h3 className="font-bold text-lg">{t('settings.title')}</h3>
        </div>
        <p className="mb-6 text-gray-700 dark:text-gray-300">{message}</p>
        <div className="flex justify-end">
            <button onClick={onClose} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm font-medium">
                {t('settings.confirm')}
            </button>
        </div>
    </div>
);
