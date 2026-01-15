import React, { useState } from 'react';
import { X } from 'lucide-react';
import { FileNode } from '../../types';

interface TagEditorProps {
    file: FileNode;
    files: Record<string, FileNode>;
    onUpdate: (fileId: string, updates: Partial<FileNode>) => void;
    onClose: () => void;
    t: (key: string) => string;
}

export const TagEditor: React.FC<TagEditorProps> = ({ file, files, onUpdate, onClose, t }) => {
    const [input, setInput] = useState('');
    const allTags = new Set<string>();
    Object.values(files).forEach((f: any) => f.tags.forEach((t: string) => allTags.add(t)));
    const allTagsList = Array.from(allTags);
    const addTag = (tag: string) => { if (!file.tags.includes(tag)) { onUpdate(file.id, { tags: [...file.tags, tag] }); } setInput(''); };
    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-96 animate-zoom-in">
            <h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.editTags')}</h3>
            <div className="flex flex-wrap gap-2 mb-4 p-2 bg-gray-50 dark:bg-gray-900 rounded border border-gray-100 dark:border-gray-700 min-h-[40px]">
                {file.tags.map((tag: string) => (
                    <span key={tag} className="px-2 py-1 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 rounded text-xs flex items-center">
                        {tag}
                        <button onClick={() => onUpdate(file.id, { tags: file.tags.filter((t: string) => t !== tag) })} className="ml-1 hover:text-red-500">
                            <X size={10} />
                        </button>
                    </span>
                ))}
            </div>
            <div className="relative mb-4">
                <input
                    id="add-tag-input"
                    name="add-tag-input"
                    className="w-full border dark:border-gray-600 rounded p-2 bg-transparent text-gray-900 dark:text-white text-sm focus:outline-none focus:ring-2 ring-blue-500"
                    placeholder={t('meta.addTagPlaceholder')}
                    value={input}
                    onChange={e => setInput(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') addTag(input); }}
                    autoFocus
                />
                {input && (
                    <div className="absolute top-full left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 mt-1 shadow-lg z-50 max-h-32 overflow-y-auto">
                        {allTagsList.filter(t => t.toLowerCase().includes(input.toLowerCase())).map(t => (
                            <div key={t} className="px-3 py-1.5 hover:bg-gray-100 dark:hover:bg-gray-700 text-xs cursor-pointer" onClick={() => addTag(t)}>{t}</div>
                        ))}
                    </div>
                )}
            </div>
            <div className="flex justify-end">
                <button onClick={onClose} className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 text-sm">{t('viewer.done')}</button>
            </div>
        </div>
    );
};
