import React, { useState } from 'react';
import { Search, X, Folder, ChevronDown, ChevronRight } from 'lucide-react';
import { FileNode, FileType } from '../../types';

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
    const [searchQuery, setSearchQuery] = useState(''); // 搜索状态
    // 初始化时将所有根目录 ID 添加到 expandedIds 中，让根目录默认展开
    const [expandedIds, setExpandedIds] = useState<string[]>(roots); // 跟踪展开的文件夹

    // 展开/折叠文件夹
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

    // 查找所有匹配的文件夹及其祖先文件夹
    const findMatchingFolders = (): Set<string> | null => {
        // 如果搜索框为空，返回 null，表示不需要过滤
        if (!searchQuery.trim()) {
            return null;
        }

        const matchingFolders = new Set<string>();
        const query = searchQuery.toLowerCase();

        // 递归遍历文件夹树，查找匹配的文件夹
        const traverse = (nodeId: string) => {
            const node = files[nodeId];
            if (!node || node.type !== FileType.FOLDER) return;

            // 检查当前文件夹是否匹配搜索条件
            const matches = node.name.toLowerCase().includes(query);

            // 获取子文件夹
            const folderChildren = node.children?.filter((childId: string) => files[childId]?.type === FileType.FOLDER) || [];

            // 检查是否有子文件夹匹配
            let hasMatchingChild = false;
            for (const childId of folderChildren) {
                traverse(childId);
                if (matchingFolders.has(childId)) {
                    hasMatchingChild = true;
                }
            }

            // 如果当前文件夹匹配或有匹配的子文件夹，添加到结果中
            if (matches || hasMatchingChild) {
                matchingFolders.add(nodeId);
            }
        };

        // 从所有根目录开始遍历
        roots.forEach((rootId: string) => traverse(rootId));

        return matchingFolders;
    };

    // 递归渲染文件夹树，支持搜索过滤
    const renderTree = (nodeId: string, depth = 0, matchingFolders?: Set<string> | null) => {
        const node = files[nodeId];
        if (!node || node.type !== FileType.FOLDER) return null;
        if (selectedFileIds.includes(nodeId)) return null;

        // 如果有搜索条件，检查当前文件夹是否应该显示
        const shouldShow = !matchingFolders || matchingFolders.has(nodeId);
        if (!shouldShow) return null;

        const expanded = expandedIds.includes(nodeId);
        const folderChildren = node.children?.filter((childId: string) => files[childId]?.type === FileType.FOLDER) || [];

        return (
            <div key={nodeId}>
                <div
                    className={`flex items-center py-1 px-2 cursor-pointer text-sm border border-transparent ${currentId === nodeId ? 'bg-blue-100 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border-l-4 border-blue-500 shadow-md font-semibold' : 'hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'}`}
                    style={{ paddingLeft: `${depth * 16 + 8}px` }}
                    onClick={() => setCurrentId(nodeId)}
                >
                    {/* 展开/折叠按钮 */}
                    <div
                        className="p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded"
                        onClick={(e) => handleToggle(e, nodeId)}
                    >
                        {folderChildren.length > 0 ? (
                            expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
                        ) : <div className="w-[14px]" />}
                    </div>
                    <Folder size={14} className="mr-2 text-blue-500" />
                    <span className="truncate">{node.name}</span>
                </div>
                {/* 只渲染展开的文件夹 */}
                {expanded && folderChildren.map((childId: string) => renderTree(childId, depth + 1, matchingFolders))}
            </div>
        );
    };

    const matchingFolders = findMatchingFolders();

    return (
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 shadow-xl w-96 h-[500px] flex flex-col animate-zoom-in">
            <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">
                {type === 'copy-to-folder' ? t('context.copyTo') : t('context.moveTo')}
            </h3>

            {/* 搜索框 */}
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
                    autoFocus
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

            <div className="flex-1 overflow-y-auto border border-gray-200 dark:border-gray-700 rounded mb-4 p-2 bg-gray-50 dark:bg-gray-900/50">
                {roots.map((rootId: string) => renderTree(rootId, 0, matchingFolders))}
            </div>
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className="px-3 py-1.5 text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded text-sm">
                    {t('settings.cancel')}
                </button>
                <button
                    onClick={() => currentId && onConfirm(currentId)}
                    disabled={!currentId}
                    className="bg-blue-600 disabled:opacity-50 text-white px-3 py-1.5 rounded hover:bg-blue-700 text-sm"
                >
                    {t('settings.confirm')}
                </button>
            </div>
        </div>
    );
};
