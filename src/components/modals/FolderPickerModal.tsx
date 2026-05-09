import React, { useState } from 'react';
import { Search, X, Folder, ChevronDown, ChevronRight } from 'lucide-react';
import { FileNode, FileType } from '../../types';
import { isAndroidSync } from '../../utils/androidPlatform';

interface FolderPickerModalProps {
    type: 'copy-to-folder' | 'move-to-folder';
    files: Record<string, FileNode>;
    roots: string[];
    selectedFileIds: string[];
    onClose: () => void;
    onConfirm: (targetId: string) => void;
    t: (key: string) => string;
}

export const FolderPickerModal: React.FC<FolderPickerModalProps> = ({ type, files, roots, selectedFileIds, onClose, onConfirm, t }) => {
    const [currentId, setCurrentId] = useState<string | null>(null);
    const [searchQuery, setSearchQuery] = useState('');
    const [expandedIds, setExpandedIds] = useState<string[]>(roots);
    const [searchFocused, setSearchFocused] = useState(false);

    const isMobile = isAndroidSync();

    const handleToggle = (e: React.MouseEvent, nodeId: string) => {
        e.stopPropagation();
        setExpandedIds(prev => {
            if (prev.includes(nodeId)) {
                return prev.filter(id => id !== nodeId);
            } else {
                return [...prev, nodeId];
            }
        });
    };

    const findMatchingFolders = (): Set<string> | null => {
        if (!searchQuery.trim()) {
            return null;
        }

        const matchingFolders = new Set<string>();
        const query = searchQuery.toLowerCase();

        const traverse = (nodeId: string) => {
            const node = files[nodeId];
            if (!node || node.type !== FileType.FOLDER) return;

            const matches = node.name.toLowerCase().includes(query);

            const folderChildren = node.children?.filter((childId: string) => files[childId]?.type === FileType.FOLDER) || [];

            let hasMatchingChild = false;
            for (const childId of folderChildren) {
                traverse(childId);
                if (matchingFolders.has(childId)) {
                    hasMatchingChild = true;
                }
            }

            if (matches || hasMatchingChild) {
                matchingFolders.add(nodeId);
            }
        };

        roots.forEach((rootId: string) => traverse(rootId));

        return matchingFolders;
    };

    const renderTree = (nodeId: string, depth = 0, matchingFolders?: Set<string> | null) => {
        const node = files[nodeId];
        if (!node || node.type !== FileType.FOLDER) return null;
        if (selectedFileIds.includes(nodeId)) return null;

        const shouldShow = !matchingFolders || matchingFolders.has(nodeId);
        if (!shouldShow) return null;

        const expanded = expandedIds.includes(nodeId);
        const folderChildren = node.children?.filter((childId: string) => files[childId]?.type === FileType.FOLDER) || [];

        const itemPaddingY = isMobile ? 'py-3' : 'py-1';
        const iconSize = isMobile ? 18 : 14;
        const fontSize = isMobile ? 'text-base' : 'text-sm';
        const togglePadding = isMobile ? 'p-2 mr-2' : 'p-1 mr-1';

        return (
            <div key={nodeId}>
                <div
                    className={`flex items-center ${itemPaddingY} px-2 cursor-pointer ${fontSize} rounded-md ${currentId === nodeId ? 'bg-blue-600 text-white font-semibold' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
                    style={{ paddingLeft: `${depth * 16 + 8}px` }}
                    onClick={() => setCurrentId(nodeId)}
                >
                    <div
                        className={`${togglePadding} hover:bg-black/10 dark:hover:bg-white/10 rounded`}
                        onClick={(e) => handleToggle(e, nodeId)}
                    >
                        {folderChildren.length > 0 ? (
                            expanded ? <ChevronDown size={iconSize} /> : <ChevronRight size={iconSize} />
                        ) : <div style={{ width: `${iconSize}px` }} />}
                    </div>
                    <Folder size={iconSize} className={`mr-2 ${currentId === nodeId ? 'text-white' : 'text-blue-500'}`} />
                    <span className="truncate">{node.name}</span>
                </div>
                {expanded && folderChildren.map((childId: string) => renderTree(childId, depth + 1, matchingFolders))}
            </div>
        );
    };

    const matchingFolders = findMatchingFolders();

    const modalWidth = isMobile ? 'w-[90vw] max-w-lg' : 'w-[420px]';
    const buttonPadding = isMobile ? 'px-5 py-2.5' : 'px-3 py-1.5';
    const buttonTextSize = isMobile ? 'text-base' : 'text-sm';

    return (
        <div className={`bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl ${modalWidth} h-[calc(100vh-200px)] min-h-[400px] flex flex-col animate-zoom-in`}>
            <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">
                {type === 'copy-to-folder' ? t('context.copyTo') : t('context.moveTo')}
            </h3>

            <div className="relative mb-4">
                <Search size={14} className="absolute left-2.5 top-2.5 text-gray-400" />
                <input
                    type="text"
                    id="folder-picker-search"
                    name="folder-picker-search"
                    className="w-full border dark:border-gray-600 rounded pl-8 pr-2 py-2 bg-transparent text-gray-900 dark:text-white focus:outline-none focus:ring-2 ring-blue-500 text-sm"
                    placeholder={t('search.placeholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
                    readOnly={isMobile && !searchFocused}
                />
                {searchQuery && (
                    <button
                        className="absolute right-2.5 top-2.5 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        onClick={() => setSearchQuery('')}
                    >
                        <X size={14} />
                    </button>
                )}
            </div>

            <div className={`flex-1 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded mb-4 p-2 bg-gray-50 dark:bg-gray-900/50${isMobile ? ' no-scrollbar' : ''}`}>
                {roots.map((rootId: string) => renderTree(rootId, 0, matchingFolders))}
            </div>
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className={`${buttonPadding} text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded ${buttonTextSize}`}>
                    {t('settings.cancel')}
                </button>
                <button
                    onClick={() => currentId && onConfirm(currentId)}
                    disabled={!currentId}
                    className={`bg-blue-600 disabled:opacity-50 text-white ${buttonPadding} rounded hover:bg-blue-700 ${buttonTextSize}`}
                >
                    {t('settings.confirm')}
                </button>
            </div>
        </div>
    );
};
