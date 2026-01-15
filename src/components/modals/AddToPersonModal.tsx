import React, { useState } from 'react';
import { Search, User } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Person, FileNode } from '../../types';

interface AddToPersonModalProps {
    people: Record<string, Person>;
    files: Record<string, FileNode>;
    onConfirm: (personId: string) => void;
    onClose: () => void;
    t: (key: string) => string;
}

export const AddToPersonModal: React.FC<AddToPersonModalProps> = ({ people, files, onConfirm, onClose, t }) => {
    const [search, setSearch] = useState('');
    const filteredPeople = Object.values(people).filter((p: Person) => p.name.toLowerCase().includes(search.toLowerCase()));
    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-80 max-h-[500px] flex flex-col animate-zoom-in">
            <h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.selectPerson')}</h3>
            <div className="relative mb-3">
                <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
                <input
                    id="add-to-person-search"
                    name="add-to-person-search"
                    className="w-full border dark:border-gray-600 rounded pl-8 pr-2 py-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500 text-sm"
                    placeholder={t('search.placeholder')}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    autoFocus
                />
            </div>
            <div className="flex-1 overflow-y-auto min-h-[200px] space-y-1 mb-4 border border-gray-100 dark:border-gray-700 rounded p-1">
                {filteredPeople.map((p: Person) => {
                    const coverFile = files[p.coverFileId];
                    const hasCover = !!coverFile;
                    return (
                        <div key={p.id} onClick={() => onConfirm(p.id)} className="flex items-center p-2 hover:bg-gray-100 dark:hover:bg-gray-700 rounded cursor-pointer group">
                            <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden mr-3 flex items-center justify-center relative">
                                {hasCover ? (
                                    p.faceBox ? (
                                        <img
                                            src={convertFileSrc(coverFile.path)}
                                            alt={p.name}
                                            className="absolute max-w-none"
                                            decoding="async"
                                            style={{
                                                width: `${10000 / Math.max(p.faceBox.w, 2.0)}%`,
                                                height: `${10000 / Math.max(p.faceBox.h, 2.0)}%`,
                                                left: 0,
                                                top: 0,
                                                transformOrigin: 'top left',
                                                transform: `translate3d(${-p.faceBox.x}%, ${-p.faceBox.y}%, 0)`,
                                                willChange: 'transform, width, height',
                                                backfaceVisibility: 'hidden'
                                            }}
                                        />
                                    ) : (
                                        <img src={convertFileSrc(coverFile.path)} alt={p.name} className="w-full h-full object-cover" />
                                    )
                                ) : (
                                    <User size={14} className="text-gray-400 dark:text-gray-500" />
                                )}
                            </div>
                            <span className="text-sm text-gray-800 dark:text-gray-200">{p.name}</span>
                        </div>
                    );
                })}
            </div>
            <div className="flex justify-end">
                <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button>
            </div>
        </div>
    );
};
