import React, { useState } from 'react';
import { User, Check } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Person, FileNode, FileType, AiFace } from '../../types';

interface ClearPersonModalProps {
    files: Record<string, FileNode>;
    fileIds: string[];
    people: Record<string, Person>;
    onConfirm: (selectedPeople: string[]) => void;
    onClose: () => void;
    t: (key: string) => string;
}

export const ClearPersonModal: React.FC<ClearPersonModalProps> = ({ files, fileIds, people, onConfirm, onClose, t }) => {
    // Get all unique people from selected files 
    const allPeople = new Set<string>();
    fileIds.forEach((fileId: string) => {
        const file = files[fileId];
        if (file && file.type === FileType.IMAGE && file.aiData?.faces) {
            file.aiData.faces.forEach((face: AiFace) => allPeople.add(face.personId));
        }
    });

    const peopleList = Array.from(allPeople).map(personId => people[personId]).filter(Boolean);
    const [selectedPeople, setSelectedPeople] = useState<string[]>(peopleList.map(p => p.id));

    const handleTogglePerson = (personId: string) => {
        setSelectedPeople(prev =>
            prev.includes(personId)
                ? prev.filter(id => id !== personId)
                : [...prev, personId]
        );
    };

    const handleSelectAll = () => {
        setSelectedPeople(peopleList.map(p => p.id));
    };

    const handleSelectNone = () => {
        setSelectedPeople([]);
    };

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
            <div className="flex-1 overflow-y-auto min-h-[200px] space-y-1 mb-4 border border-gray-100 dark:border-gray-700 rounded p-1">
                {peopleList.map((p: Person) => {
                    const coverFile = files[p.coverFileId];
                    const hasCover = !!coverFile;
                    const isSelected = selectedPeople.includes(p.id);
                    return (
                        <div key={p.id} onClick={() => handleTogglePerson(p.id)} className={`flex items-center p-2 rounded cursor-pointer group border border-transparent ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50 border-l-4 border-blue-500 shadow-md font-semibold' : 'hover:bg-gray-100 dark:hover:bg-gray-700'}`}>
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
                            <span className={`text-sm flex-1 ${isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-gray-800 dark:text-gray-200'}`}>{p.name}</span>
                            <div className={`w-5 h-5 rounded border-2 flex items-center justify-center ${isSelected ? 'border-blue-600 bg-blue-600 ring-2 ring-blue-300/50 dark:ring-blue-700/50 shadow-sm' : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800'}`}>
                                {isSelected && <Check size={14} className="text-white" strokeWidth={3} />}
                            </div>
                        </div>
                    );
                })}
            </div>
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">{t('settings.cancel')}</button>
                <button onClick={() => onConfirm(selectedPeople)} className="bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm">{t('settings.confirm')}</button>
            </div>
        </div>
    );
};
