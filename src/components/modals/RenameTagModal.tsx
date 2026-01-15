import React, { useState } from 'react';

interface RenameTagModalProps {
    initialTag: string;
    onConfirm: (oldTag: string, newTag: string) => void;
    onClose: () => void;
    t: (key: string) => string;
}

export const RenameTagModal: React.FC<RenameTagModalProps> = ({ initialTag, onConfirm, onClose, t }) => {
    const [val, setVal] = useState(initialTag);
    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-80 animate-zoom-in">
            <h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.renameTag')}</h3>
            <input
                id="rename-tag-input"
                name="rename-tag-input"
                className="w-full border dark:border-gray-600 rounded p-2 mb-4 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500"
                value={val}
                onChange={e => setVal(e.target.value)}
                autoFocus
            />
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button>
                <button onClick={() => onConfirm(initialTag, val)} className="bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm">{t('settings.confirm')}</button>
            </div>
        </div>
    );
};
