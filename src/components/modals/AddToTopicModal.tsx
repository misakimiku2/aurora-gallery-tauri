import React, { useState } from 'react';
import { Layout, ChevronsDown, ChevronRight } from 'lucide-react';
import { Topic } from '../../types';

interface AddToTopicModalProps {
    topics: Record<string, Topic>;
    onConfirm: (topicId: string) => void;
    onClose: () => void;
    t: (key: string) => string;
}

export const AddToTopicModal: React.FC<AddToTopicModalProps> = ({ topics, onConfirm, onClose, t }) => {
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});

    const mainTopics = Object.values(topics).filter((t: any) => !t.parentId);
    const getSubTopics = (parentId: string) => Object.values(topics).filter((t: any) => t.parentId === parentId);

    const toggleExpand = (id: string, e: React.MouseEvent) => {
        e.stopPropagation();
        setExpanded(prev => ({ ...prev, [id]: !prev[id] }));
    };

    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-96 max-h-[500px] flex flex-col animate-zoom-in">
            <h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('sidebar.topics')}</h3>
            <div className="flex-1 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded p-2 mb-4 max-h-[300px]">
                {mainTopics.length === 0 && <div className="text-gray-500 text-center py-4 text-sm">{t('context.noFiles')}</div>}
                {mainTopics.map((topic: any) => {
                    const subTopics = getSubTopics(topic.id);
                    const hasSubs = subTopics.length > 0;
                    const isExpanded = expanded[topic.id];
                    const isSelected = selectedId === topic.id;

                    return (
                        <div key={topic.id} className="mb-1">
                            <div
                                className={`flex items-center p-2 rounded cursor-pointer ${isSelected ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200'}`}
                                onClick={() => setSelectedId(topic.id)}
                            >
                                <div
                                    className={`p-1 mr-1 rounded hover:bg-gray-200 dark:hover:bg-gray-600 ${hasSubs ? 'visible' : 'invisible'}`}
                                    onClick={(e) => toggleExpand(topic.id, e)}
                                >
                                    {isExpanded ? <ChevronsDown size={14} /> : <ChevronRight size={14} />}
                                </div>
                                <Layout size={16} className="mr-2" />
                                <span className="truncate text-sm">{topic.name}</span>
                            </div>

                            {hasSubs && isExpanded && (
                                <div className="ml-6 border-l border-gray-200 dark:border-gray-700 pl-2 mt-1 space-y-1">
                                    {subTopics.map((sub: any) => (
                                        <div
                                            key={sub.id}
                                            className={`flex items-center p-2 rounded cursor-pointer ${selectedId === sub.id ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'hover:bg-gray-100 dark:hover:bg-gray-700 text-gray-800 dark:text-gray-200'}`}
                                            onClick={() => setSelectedId(sub.id)}
                                        >
                                            <Layout size={14} className="mr-2 opacity-70" />
                                            <span className="truncate text-sm">{sub.name}</span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
            </div>
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button>
                <button
                    onClick={() => selectedId && onConfirm(selectedId)}
                    disabled={!selectedId}
                    className={`px-3 py-1.5 rounded text-sm text-white transition-colors ${selectedId ? 'bg-blue-600 hover:bg-blue-700' : 'bg-gray-400 cursor-not-allowed'}`}
                >
                    {t('settings.confirm')}
                </button>
            </div>
        </div>
    );
};
