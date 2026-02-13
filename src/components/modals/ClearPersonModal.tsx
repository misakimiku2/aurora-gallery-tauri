import React, { useState, useMemo, useCallback } from 'react';
import { User, Check } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import * as RW from 'react-window';
import { Person, FileNode, FileType, AiFace } from '../../types';

// Resolve FixedSizeList component from various module shapes
const FixedSizeListComp: any = (() => {
  const mod: any = RW as any;
  if (mod.FixedSizeList) return mod.FixedSizeList;
  if (mod.default && mod.default.FixedSizeList) return mod.default.FixedSizeList;
  if (mod.default && (typeof mod.default === 'function' || typeof mod.default === 'object')) return mod.default;
  return null;
})();

const ITEM_HEIGHT = 44;
const LIST_HEIGHT = 280;
const LIST_WIDTH = 288;

interface ClearPersonModalProps {
    files: Record<string, FileNode>;
    fileIds: string[];
    people: Record<string, Person>;
    onConfirm: (selectedPeople: string[]) => void;
    onClose: () => void;
    t: (key: string) => string;
}

interface PersonRowProps {
    index: number;
    style: React.CSSProperties;
    data: {
        peopleList: Person[];
        files: Record<string, FileNode>;
        selectedPeople: string[];
        handleTogglePerson: (personId: string) => void;
    };
}

const PersonRow = React.memo(({ index, style, data }: PersonRowProps) => {
    const { peopleList, files, selectedPeople, handleTogglePerson } = data;
    const p = peopleList[index];
    const coverFile = files[p.coverFileId];
    const hasCover = !!coverFile;
    const isSelected = selectedPeople.includes(p.id);

    return (
        <div
            style={style}
            onClick={() => handleTogglePerson(p.id)}
            className={`flex items-center p-2 rounded cursor-pointer group border border-transparent ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50 border-l-4 border-blue-500 shadow-md font-semibold' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}
        >
            <div className="w-8 h-8 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden mr-3 flex items-center justify-center relative flex-shrink-0">
                {hasCover ? (
                    p.faceBox ? (
                        <img
                            src={convertFileSrc(coverFile.path)}
                            alt={p.name}
                            className="absolute max-w-none"
                            decoding="async"
                            loading="lazy"
                            style={{
                                width: `${10000 / Math.max(p.faceBox.w, 2.0)}%`,
                                height: `${10000 / Math.max(p.faceBox.h, 2.0)}%`,
                                left: 0,
                                top: 0,
                                transformOrigin: 'top left',
                                transform: `translate3d(${-p.faceBox.x}%, ${-p.faceBox.y}%, 0)`,
                                willChange: 'transform',
                                backfaceVisibility: 'hidden',
                                imageRendering: 'auto'
                            }}
                        />
                    ) : (
                        <img src={convertFileSrc(coverFile.path)} alt={p.name} className="w-full h-full object-cover" decoding="async" loading="lazy" />
                    )
                ) : (
                    <User size={14} className="text-gray-400 dark:text-gray-500" />
                )}
            </div>
            <span className={`text-sm flex-1 truncate ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-800 dark:text-gray-200'}`}>{p.name}</span>
            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center flex-shrink-0 ${isSelected ? 'border-blue-600 bg-blue-600 ring-2 ring-blue-300/50 dark:ring-blue-700/50 shadow-sm' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'}`}>
                {isSelected && <Check size={14} className="text-white" strokeWidth={3} />}
            </div>
        </div>
    );
});

PersonRow.displayName = 'PersonRow';

export const ClearPersonModal: React.FC<ClearPersonModalProps> = ({ files, fileIds, people, onConfirm, onClose, t }) => {
    // Get all unique people from selected files 
    const peopleList = useMemo(() => {
        const allPeople = new Set<string>();
        fileIds.forEach((fileId: string) => {
            const file = files[fileId];
            if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
                file.aiData.faces.forEach((face: AiFace) => allPeople.add(face.personId));
            }
        });
        return Array.from(allPeople).map(personId => people[personId]).filter(Boolean);
    }, [files, fileIds, people]);

    const [selectedPeople, setSelectedPeople] = useState<string[]>(peopleList.map(p => p.id));

    const handleTogglePerson = useCallback((personId: string) => {
        setSelectedPeople(prev =>
            prev.includes(personId)
                ? prev.filter(id => id !== personId)
                : [...prev, personId]
        );
    }, []);

    const handleSelectAll = useCallback(() => {
        setSelectedPeople(peopleList.map(p => p.id));
    }, [peopleList]);

    const handleSelectNone = useCallback(() => {
        setSelectedPeople([]);
    }, []);

    const itemData = useMemo(() => ({
        peopleList,
        files,
        selectedPeople,
        handleTogglePerson
    }), [peopleList, files, selectedPeople, handleTogglePerson]);

    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-80 max-h-[500px] flex flex-col animate-zoom-in">
            <h3 className="font-bold text-lg mb-4 text-gray-900 dark:text-white">{t('context.selectPeopleToClear')}</h3>
            <div className="flex justify-between items-center mb-3 text-sm">
                <span className="text-gray-600 dark:text-gray-400">{t('context.selected')} {selectedPeople.length} / {peopleList.length}</span>
                <div className="space-x-2">
                    <button onClick={handleSelectAll} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200">{t('context.selectAll')}</button>
                    <button onClick={handleSelectNone} className="text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-200">{t('context.selectNone')}</button>
                </div>
            </div>
            <div className="flex-1 min-h-[200px] mb-4 border border-gray-100 dark:border-gray-700 rounded p-1">
                {peopleList.length === 0 ? (
                    <div className="flex items-center justify-center h-full text-gray-500 text-sm">
                        {t('sidebar.noPeople')}
                    </div>
                ) : FixedSizeListComp ? (
                    <FixedSizeListComp
                        height={LIST_HEIGHT}
                        itemCount={peopleList.length}
                        itemSize={ITEM_HEIGHT}
                        width={LIST_WIDTH}
                        itemData={itemData}
                        overscanCount={5}
                    >
                        {PersonRow}
                    </FixedSizeListComp>
                ) : (
                    <div className="overflow-y-auto h-full">
                        {peopleList.map((person, index) => (
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
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button>
                <button onClick={() => onConfirm(selectedPeople)} className="bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm">{t('settings.confirm')}</button>
            </div>
        </div>
    );
};
