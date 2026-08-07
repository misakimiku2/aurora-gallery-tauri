import React, { useState, useRef, useEffect, useCallback } from 'react';
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
    const [showScrollbar, setShowScrollbar] = useState(false);
    const [hoveringTrack, setHoveringTrack] = useState(false);
    const [isDragging, setIsDragging] = useState(false);

    const treeWrapRef = useRef<HTMLDivElement>(null);
    const treeRef = useRef<HTMLDivElement>(null);
    const thumbRef = useRef<HTMLDivElement>(null);
    const hideTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const dragRef = useRef<{
        startY: number;
        startScrollTop: number;
        thumbHeight: number;
        maxScroll: number;
        clientHeight: number;
    } | null>(null);

    const isMobile = isAndroidSync();

    // 同步自定义滚动条指示器的几何（高度与位置）
    const syncThumb = useCallback(() => {
        const el = treeRef.current;
        const thumb = thumbRef.current;
        if (!el || !thumb) return;
        const { scrollTop, scrollHeight, clientHeight } = el;
        const maxScroll = scrollHeight - clientHeight;
        if (maxScroll <= 0) {
            thumb.style.height = '0px';
            return;
        }
        const thumbHeight = Math.max(clientHeight * (clientHeight / scrollHeight), 24);
        const thumbTop = (scrollTop / maxScroll) * (clientHeight - thumbHeight);
        thumb.style.height = `${thumbHeight}px`;
        thumb.style.transform = `translateY(${thumbTop}px)`;
    }, []);

    // 滚动时显示滚动条，停止滚动 500ms 后淡出
    const handleTreeScroll = useCallback(() => {
        syncThumb();
        setShowScrollbar(true);
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
        }
        hideTimeoutRef.current = setTimeout(() => setShowScrollbar(false), 500);
    }, [syncThumb]);

    // 拖拽滚动条拖动滚动
    const handleThumbMouseMove = useCallback((e: MouseEvent) => {
        const drag = dragRef.current;
        const el = treeRef.current;
        if (!drag || !el) return;
        const travel = drag.clientHeight - drag.thumbHeight;
        if (travel <= 0) return;
        const deltaY = e.clientY - drag.startY;
        const newScrollTop = drag.startScrollTop + (deltaY / travel) * drag.maxScroll;
        el.scrollTop = Math.max(0, Math.min(newScrollTop, drag.maxScroll));
    }, []);

    const handleThumbMouseUp = useCallback(() => {
        dragRef.current = null;
        setIsDragging(false);
        window.removeEventListener('mousemove', handleThumbMouseMove);
        window.removeEventListener('mouseup', handleThumbMouseUp);
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
        }
        hideTimeoutRef.current = setTimeout(() => setShowScrollbar(false), 500);
    }, [handleThumbMouseMove]);

    const handleThumbMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        const el = treeRef.current;
        const thumb = thumbRef.current;
        if (!el || !thumb) return;
        const { scrollHeight, clientHeight, scrollTop } = el;
        const maxScroll = scrollHeight - clientHeight;
        if (maxScroll <= 0) return;
        const thumbHeight = parseFloat(thumb.style.height) || 0;
        dragRef.current = {
            startY: e.clientY,
            startScrollTop: scrollTop,
            thumbHeight,
            maxScroll,
            clientHeight,
        };
        if (hideTimeoutRef.current) {
            clearTimeout(hideTimeoutRef.current);
        }
        setIsDragging(true);
        setShowScrollbar(true);
        window.addEventListener('mousemove', handleThumbMouseMove);
        window.addEventListener('mouseup', handleThumbMouseUp);
    }, [handleThumbMouseMove, handleThumbMouseUp]);

    // 鼠标悬停在右侧滚动条轨道区域时显示滚动条
    const handleWrapMouseMove = useCallback((e: React.MouseEvent) => {
        const wrap = treeWrapRef.current;
        if (!wrap) return;
        const rect = wrap.getBoundingClientRect();
        setHoveringTrack(e.clientX >= rect.right - 14);
    }, []);

    const handleWrapMouseLeave = useCallback(() => {
        setHoveringTrack(false);
    }, []);

    // 挂载或搜索过滤后内容变化时同步滚动条几何
    useEffect(() => {
        if (isMobile) return;
        syncThumb();
    }, [isMobile, searchQuery, syncThumb]);

    // 卸载时清理定时器与拖拽监听
    useEffect(() => {
        return () => {
            if (hideTimeoutRef.current) {
                clearTimeout(hideTimeoutRef.current);
            }
            window.removeEventListener('mousemove', handleThumbMouseMove);
            window.removeEventListener('mouseup', handleThumbMouseUp);
        };
    }, [handleThumbMouseMove, handleThumbMouseUp]);

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

        const iconColorClass = currentId === nodeId
            ? 'text-white'
            : node.category === 'book' ? 'text-amber-500'
              : node.category === 'sequence' ? 'text-purple-500'
                : 'text-blue-500 dark:text-blue-400';

        return (
            <div key={nodeId}>
                <div
                    className={`flex items-center ${itemPaddingY} px-2 cursor-pointer transition-colors border border-transparent group relative ${fontSize} ${currentId === nodeId ? 'bg-blue-600 text-white font-semibold rounded-lg' : 'hover:bg-surface rounded-lg text-gray-700 dark:text-gray-300'}`}
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
                    <Folder size={iconSize} className={`mr-2 flex-shrink-0 ${iconColorClass}`} />
                    <span className="truncate pointer-events-none flex-1">{node.name}</span>
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
        <div className={`bg-content rounded-xl p-6 shadow-2xl border border-subtle ${modalWidth} h-[calc(100vh-200px)] min-h-[400px] flex flex-col animate-zoom-in`}>
            <h3 className="font-bold text-lg mb-2 text-gray-900 dark:text-white">
                {type === 'copy-to-folder' ? t('context.copyTo') : t('context.moveTo')}
            </h3>

            <div className="relative mb-4">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                    type="text"
                    id="folder-picker-search"
                    name="folder-picker-search"
                    className={`w-full bg-surface border border-subtle rounded-lg pl-9 pr-8 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent ${isMobile ? 'py-2.5 text-base' : 'py-2 text-sm'}`}
                    placeholder={isMobile ? t('search.placeholderMobile') : t('search.placeholder')}
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    onFocus={() => setSearchFocused(true)}
                    onBlur={() => setSearchFocused(false)}
                    readOnly={isMobile && !searchFocused}
                />
                {searchQuery && (
                    <button
                        className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                        onClick={() => setSearchQuery('')}
                    >
                        <X size={14} />
                    </button>
                )}
            </div>

            <div
                ref={treeWrapRef}
                onMouseMove={handleWrapMouseMove}
                onMouseLeave={handleWrapMouseLeave}
                className={`relative flex-1 min-h-0 mb-4${isMobile ? '' : ' pr-1'}`}
            >
                <div
                    ref={treeRef}
                    onScroll={handleTreeScroll}
                    className="h-full overflow-y-auto bg-panel rounded-xl p-2 no-scrollbar"
                >
                    {roots.map((rootId: string) => renderTree(rootId, 0, matchingFolders))}
                </div>
                {!isMobile && (
                    <div
                        ref={thumbRef}
                        onMouseDown={handleThumbMouseDown}
                        className={`absolute right-0.5 top-1 bottom-1 rounded-full cursor-grab active:cursor-grabbing select-none transition-[opacity,width] duration-300 ${isDragging
                            ? 'w-2 bg-gray-400 dark:bg-gray-600'
                            : 'w-1.5 hover:w-2 bg-gray-400/60 dark:bg-gray-600/60 hover:bg-gray-400 dark:hover:bg-gray-600'} ${showScrollbar || hoveringTrack || isDragging ? 'opacity-100' : 'opacity-0'}`}
                    />
                )}
            </div>
            <div className="flex justify-end space-x-2">
                <button onClick={onClose} className={`${buttonPadding} text-gray-600 dark:text-gray-400 hover:bg-surface rounded-lg ${buttonTextSize} transition-colors`}>
                    {t('settings.cancel')}
                </button>
                <button
                    onClick={() => currentId && onConfirm(currentId)}
                    disabled={!currentId}
                    className={`bg-blue-600 disabled:opacity-50 disabled:cursor-not-allowed text-white ${buttonPadding} rounded-lg hover:bg-blue-700 ${buttonTextSize} transition-colors`}
                >
                    {t('settings.confirm')}
                </button>
            </div>
        </div>
    );
};
