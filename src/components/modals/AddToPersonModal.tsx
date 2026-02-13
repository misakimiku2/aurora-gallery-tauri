import React, { useState, useMemo, useCallback } from 'react';
import { Search, User, Check } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as RW from 'react-window';
import { Person, FileNode } from '../../types';

// Resolve FixedSizeList component from various module shapes
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
const LIST_WIDTH = 288;

interface PersonRowProps {
    index: number;
    style: React.CSSProperties;
    data: {
        people: Person[];
        files: Record<string, FileNode>;
        selectedIds: Set<string>;
        toggleSelection: (personId: string) => void;
    };
}

const PersonRow = React.memo(({ index, style, data }: PersonRowProps) => {
    const { people, files, selectedIds, toggleSelection } = data;
    const person = people[index];
    const coverFile = files[person.coverFileId];
    const hasCover = !!coverFile;
    const isSelected = selectedIds.has(person.id);

    return (
        <div
            style={style}
            onClick={() => toggleSelection(person.id)}
            className={`flex items-center p-2 rounded cursor-pointer group ${
                isSelected
                    ? 'bg-blue-100 dark:bg-blue-900/30'
                    : 'hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
        >
            <div className="relative mr-3 flex-shrink-0">
                <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden">
                    <div className="w-full h-full rounded-full overflow-hidden relative">
                        {hasCover ? (
                            person.faceBox ? (
                                <img
                                    src={convertFileSrc(coverFile.path)}
                                    alt={person.name}
                                    className="absolute max-w-none"
                                    decoding="async"
                                    loading="lazy"
                                    style={{
                                        width: `${10000 / Math.max(person.faceBox.w, 2.0)}%`,
                                        height: `${10000 / Math.max(person.faceBox.h, 2.0)}%`,
                                        left: 0,
                                        top: 0,
                                        transformOrigin: 'top left',
                                        transform: `translate3d(${-person.faceBox.x}%, ${-person.faceBox.y}%, 0)`,
                                        willChange: 'transform',
                                        backfaceVisibility: 'hidden',
                                        imageRendering: 'auto'
                                    }}
                                />
                            ) : (
                                <img
                                    src={convertFileSrc(coverFile.path)}
                                    alt={person.name}
                                    className="w-full h-full object-cover"
                                    decoding="async"
                                    loading="lazy"
                                />
                            )
                        ) : (
                            <div className="w-full h-full flex items-center justify-center">
                                <User size={14} className="text-gray-400 dark:text-gray-500" />
                            </div>
                        )}
                    </div>
                </div>
                {isSelected && (
                    <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 bg-blue-500 rounded-full flex items-center justify-center">
                        <Check size={10} className="text-white" />
                    </div>
                )}
            </div>
            <span className={`text-sm truncate ${isSelected ? 'text-blue-600 dark:text-blue-400 font-medium' : 'text-gray-800 dark:text-gray-200'}`}>
                {person.name}
            </span>
        </div>
    );
});

PersonRow.displayName = 'PersonRow';

export const AddToPersonModal: React.FC<AddToPersonModalProps> = ({ people, files, onConfirm, onClose, t }) => {
    const [search, setSearch] = useState('');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

    const filteredPeople = useMemo(() => {
        const peopleList = Object.values(people);
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

    const itemData = useMemo(() => ({
        people: filteredPeople,
        files,
        selectedIds,
        toggleSelection
    }), [filteredPeople, files, selectedIds, toggleSelection]);

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
            <div className="flex-1 min-h-[200px] mb-4 border border-gray-100 dark:border-gray-700 rounded p-1">
                {filteredPeople.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                        {t('sidebar.noPeople')}
                    </div>
                ) : FixedSizeListComp ? (
                    <FixedSizeListComp
                        height={LIST_HEIGHT}
                        itemCount={filteredPeople.length}
                        itemSize={ITEM_HEIGHT}
                        width={LIST_WIDTH}
                        itemData={itemData}
                        overscanCount={5}
                    >
                        {PersonRow}
                    </FixedSizeListComp>
                ) : (
                    <div className="overflow-y-auto h-full">
                        {filteredPeople.map((person, index) => (
                            <PersonRow
                                key={person.id}
                                index={index}
                                style={{ height: ITEM_HEIGHT }}
                                data={itemData}
                            />
                        ))}
                    </div>
                )}
            </div>
            <div className="flex justify-between items-center">
                <span className="text-xs text-gray-500 dark:text-gray-400">
                    {selectedIds.size > 0 ? `${t('context.selected')}: ${selectedIds.size}` : ''}
                </span>
                <div className="flex space-x-2">
                    <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">
                        {t('settings.cancel')}
                    </button>
                    <button
                        onClick={handleConfirm}
                        disabled={selectedIds.size === 0}
                        className={`px-3 py-1.5 rounded text-sm text-white transition-colors ${
                            selectedIds.size > 0
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
