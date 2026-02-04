import React, { useState } from 'react';

interface CreateTopicModalProps {
    onClose: () => void;
    // onCreate now accepts optional `type` (max 12 chars)
    onCreate: (name: string, type?: string) => void;
    t: (key: string) => string;
}

export const CreateTopicModal: React.FC<CreateTopicModalProps> = ({ onClose, onCreate, t }) => {
    const [name, setName] = useState('');
    // 默认类型为 TOPIC
    const [type, setType] = useState('TOPIC');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (trimmed) {
            onCreate(trimmed, type.trim().slice(0, 12));
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">
                    {t('context.newTopic')}
                </h3>
                <form onSubmit={handleSubmit}>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('context.topicNamePlaceholder') || '请输入专题名称'}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg mb-3 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        autoFocus
                    />

                    <div className="mb-4">
                        <label className="text-sm text-gray-600 dark:text-gray-300 mb-1 block">{t('context.type') || '类型 (最多12字)'}</label>
                        <input
                            type="text"
                            value={type}
                            maxLength={12}
                            onChange={(e) => setType(e.target.value.slice(0, 12))}
                            placeholder={t('context.typePlaceholder') || '请输入类型（最多12字）'}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        />
                        <div className="text-xs text-gray-400 mt-1">{type.length}/12</div>
                    </div>

                    <div className="flex justify-end space-x-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
                        >
                            {t('context.cancel') || '取消'}
                        </button>
                        <button
                            type="submit"
                            disabled={!name.trim()}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {t('context.create') || '创建'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};
