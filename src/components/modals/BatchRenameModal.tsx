import React, { useState } from 'react';

interface BatchRenameModalProps {
    count: number;
    onConfirm: (pattern: string, startNum: number) => void;
    onClose: () => void;
    t: (key: string) => string;
}

export const BatchRenameModal: React.FC<BatchRenameModalProps> = ({ count, onConfirm, onClose, t }) => {
    const [pattern, setPattern] = useState('Image_###');
    const [startNum, setStartNum] = useState(1);
    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-96 animate-zoom-in">
            <h3 className="font-bold text-lg mb-1 text-gray-900 dark:text-white">{t('context.batchRename')}</h3>
            <p className="text-xs text-gray-500 mb-4">{t('meta.selected')} {count} {t('context.files')}</p>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" htmlFor="batch-rename-pattern">{t('settings.namePattern')}</label>
            <input
                id="batch-rename-pattern"
                name="batch-rename-pattern"
                className="w-full border dark:border-gray-600 rounded p-2 mb-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500 font-mono text-sm"
                value={pattern}
                onChange={e => setPattern(e.target.value)}
                placeholder="Name_###"
            />
            <p className="text-xs text-gray-400 mb-4">{t('settings.patternHelp')}</p>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" htmlFor="batch-rename-start">{t('settings.startNumber')}</label>
            <input
                type="number"
                id="batch-rename-start"
                name="batch-rename-start"
                className="w-full border dark:border-gray-600 rounded p-2 mb-4 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500"
                value={startNum}
                onChange={e => setStartNum(parseInt(e.target.value))}
            />
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button>
                <button onClick={() => onConfirm(pattern, startNum)} className="bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm">{t('settings.confirm')}</button>
            </div>
        </div>
    );
};
