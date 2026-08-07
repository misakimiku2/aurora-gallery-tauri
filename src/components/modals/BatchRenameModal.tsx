import React, { useState } from 'react';
import { Sparkles } from 'lucide-react';
import { AppState } from '../../types';

interface BatchRenameModalProps {
    count: number;
    onConfirm: (pattern: string, startNum: number) => void;
    onClose: () => void;
    onAutoRename?: () => void;
    aiConnectionStatus: AppState['aiConnectionStatus'];
    t: (key: string) => string;
}

export const BatchRenameModal: React.FC<BatchRenameModalProps> = ({ count, onConfirm, onClose, onAutoRename, aiConnectionStatus, t }) => {
    const [pattern, setPattern] = useState('Image_###');
    const [startNum, setStartNum] = useState(1);

    const aiConnected = aiConnectionStatus === 'connected';

    return (
        <div className="bg-content rounded-xl p-6 shadow-2xl border border-subtle w-96 animate-zoom-in">
            <div className="flex items-center justify-between mb-1">
                <h3 className="font-bold text-lg text-gray-900 dark:text-white">{t('context.batchRename')}</h3>
                {onAutoRename && aiConnected && (
                    <button
                        onClick={onAutoRename}
                        className="flex items-center gap-1 px-2 py-1 text-sm text-purple-600 dark:text-purple-400 hover:bg-surface rounded-lg transition-colors"
                        title={t('context.autoRename')}
                    >
                        <Sparkles className="w-4 h-4" />
                        {t('context.autoRename')}
                    </button>
                )}
            </div>
            <p className="text-xs text-gray-500 mb-4">{t('meta.selected')} {count} {t('context.files')}</p>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1" htmlFor="batch-rename-pattern">{t('settings.namePattern')}</label>
            <input
                id="batch-rename-pattern"
                name="batch-rename-pattern"
                className="w-full bg-surface border border-subtle rounded-lg px-3 py-2 mb-2 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent font-mono text-sm"
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
                className="w-full bg-surface border border-subtle rounded-lg px-3 py-2 mb-4 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                value={startNum}
                onChange={e => setStartNum(parseInt(e.target.value))}
            />
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-surface rounded-lg text-sm transition-colors">{t('settings.cancel')}</button>
                <button onClick={() => onConfirm(pattern, startNum)} className="bg-blue-600 text-white px-3 py-1.5 rounded-lg hover:bg-blue-700 text-sm transition-colors">{t('settings.confirm')}</button>
            </div>
        </div>
    );
};
