import React, { useState, useMemo, useCallback } from 'react';
import { Search, User, Check } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as RW from 'react-window';
import { Person, FileNode } from '../../types';
import { cropToImgStyle, faceBoxToCrop } from '../../utils/cropStyle';

const FixedSizeListComp: any = (() => {
    const mod: any = RW as any;
    if (mod.FixedSizeList) return mod.FixedSizeList;
    if (mod.default && mod.default.FixedSizeList) return mod.default.FixedSizeList;
    if (mod.default && (typeof mod.default === 'function' || typeof mod.default === 'object')) return mod.default;
    return null;
})();

interface AddToPersonModalProps {
    people: Record<string, Person>;
    files: Record<string, FileNode>;
    onConfirm: (personIds: string[]) => void;
    onClose: () => void;
    t: (key: string) => string;
}

const ITEM_HEIGHT = 44;
const LIST_HEIGHT = 280;

interface RowProps {
    people: Person[];
    files: Record<string, FileNode>;
    selectedIds: Set<string>;
    toggleSelection: (personId: string) => void;
}

const PersonRow = ({ index, style, data }: { index: number; style: React.CSSProperties; data: RowProps }) => {
    const { people, files, selectedIds, toggleSelection } = data;
    const person = people[index];
    const coverFile = files[person.coverFileId];
    const hasCover = !!coverFile;
    const isSelected = selectedIds.has(person.id);

    return (
        <div
            style={style}
            onClick={() => toggleSelection(person.id)}
            className={`flex items-center px-2 py-1 mb-1 rounded-lg cursor-pointer group transition-colors ${isSelected
                ? 'bg-blue-100 dark:bg-blue-900/30'
                : 'hover:bg-surface'
                }`}
        >
            <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden mr-3 flex items-center justify-center relative flex-shrink-0">
                {hasCover ? (
                    person.faceBox ? (
                        <img
                            src={convertFileSrc(coverFile.path)}
                            alt={person.name}
                            className="absolute"
                            decoding="async"
                            loading="lazy"
                            style={{
                                ...cropToImgStyle(faceBoxToCrop(person.faceBox)),
                                imageRendering: 'auto'
                            }}
                        />
                    ) : (
                        <img src={convertFileSrc(coverFile.path)} alt={person.name} className="w-full h-full object-cover" decoding="async" loading="lazy" style={{ imageRendering: 'auto' }} />
                    )
                ) : (
                    <User size={14} className="text-gray-400 dark:text-gray-500" />
                )}
            </div>
            <span className={`text-sm truncate flex-1 ${isSelected ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-800 dark:text-gray-200'}`}>
                {person.name}
            </span>
            <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${isSelected ? 'border-blue-600 bg-blue-600' : 'border-gray-300 dark:border-gray-600'}`}>
                {isSelected && <Check size={12} className="text-white" strokeWidth={3} />}
            </div>
        </div>
    );
};

export const AddToPersonModal: React.FC<AddToPersonModalProps> = ({ people, files, onConfirm, onClose, t }) => {
    const [search, setSearch] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const filteredPeople = useMemo(() => {
        const peopleList = Object.values(people || {});
        if (!search.trim()) return peopleList;
        return peopleList.filter((p: Person) =>
            p.name.toLowerCase().includes(search.toLowerCase())
        );
    }, [people, search]);

    const toggleSelection = useCallback((personId: string) => {
        setSelectedIds(prev => {
            const newSet = new Set(prev);
            if (newSet.has(personId)) {
                newSet.delete(personId);
            } else {
                newSet.add(personId);
            }
            return newSet;
        });
    }, []);

    const handleConfirm = () => {
        if (selectedIds.size > 0) {
            onConfirm(Array.from(selectedIds));
        }
    };

    const rowProps = useMemo(() => ({
        people: filteredPeople,
        files,
        selectedIds,
        toggleSelection
    }), [filteredPeople, files, selectedIds, toggleSelection]);

    return (
        <div className="bg-content rounded-xl p-6 shadow-2xl border border-subtle w-80 max-h-[500px] flex flex-col animate-zoom-in">
            <h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.selectPerson')}</h3>
            <div className="relative mb-3">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                    id="add-to-person-search"
                    name="add-to-person-search"
                    className="w-full bg-surface border border-subtle rounded-lg pl-9 pr-2 py-2 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-sm"
                    placeholder={t('search.placeholderPeople')}
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    autoFocus
                />
            </div>
            <div className="flex-1 min-h-0 mb-4 bg-panel rounded-xl p-1 overflow-hidden">
                {filteredPeople.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-gray-500 text-sm py-8">
                        {t('sidebar.noPeople')}
                    </div>
                ) : FixedSizeListComp ? (
                    <FixedSizeListComp
                        height={LIST_HEIGHT}
                        width="100%"
                        itemCount={filteredPeople.length}
                        itemSize={ITEM_HEIGHT}
                        itemData={rowProps}
                        overscanCount={5}
                    >
                        {PersonRow}
                    </FixedSizeListComp>
                ) : (
                    <div className="overflow-y-auto" style={{ maxHeight: LIST_HEIGHT }}>
                        {filteredPeople.map((person: Person) => (
                            <div
                                key={person.id}
                                onClick={() => toggleSelection(person.id)}
                                className={`flex items-center px-2 py-1 mb-1 rounded-lg cursor-pointer transition-colors ${selectedIds.has(person.id)
                                    ? 'bg-blue-100 dark:bg-blue-900/30'
                                    : 'hover:bg-surface'
                                    }`}
                                style={{ height: ITEM_HEIGHT }}
                            >
                                <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden mr-3 flex items-center justify-center relative flex-shrink-0">
                                    {files[person.coverFileId] ? (
                                        person.faceBox ? (
                                            <img
                                                src={convertFileSrc(files[person.coverFileId].path)}
                                                alt={person.name}
                                                className="absolute"
                                                decoding="async"
                                                loading="lazy"
                                                style={{
                                                    ...cropToImgStyle(faceBoxToCrop(person.faceBox)),
                                                    imageRendering: 'auto'
                                                }}
                                            />
                                        ) : (
                                            <img src={convertFileSrc(files[person.coverFileId].path)} alt={person.name} className="w-full h-full object-cover" decoding="async" loading="lazy" style={{ imageRendering: 'auto' }} />
                                        )
                                    ) : (
                                        <User size={14} className="text-gray-400 dark:text-gray-500" />
                                    )}
                                </div>
                                <span className={`text-sm truncate flex-1 ${selectedIds.has(person.id) ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-800 dark:text-gray-200'}`}>
                                    {person.name}
                                </span>
                                <div className={`w-5 h-5 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-colors ${selectedIds.has(person.id) ? 'border-blue-600 bg-blue-600' : 'border-gray-300 dark:border-gray-600'}`}>
                                    {selectedIds.has(person.id) && <Check size={12} className="text-white" strokeWidth={3} />}
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
            <div className="flex justify-between items-center">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                    {selectedIds.size > 0 ? `${t('context.selected')}: ${selectedIds.size}` : ''}
                </span>
                <div className="flex space-x-2">
                    <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-surface rounded-lg text-sm transition-colors">
                        {t('settings.cancel')}
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={selectedIds.size === 0}
                        className={`px-3 py-1.5 rounded-lg text-sm text-white transition-colors ${selectedIds.size > 0
                            ? 'bg-blue-600 hover:bg-blue-700'
                            : 'bg-gray-400 cursor-not-allowed'
                            }`}
                    >
                        {t('settings.confirm')}
                    </button>
                </div>
            </div>
        </div>
    );
};
