import React, { useState, useMemo, useEffect, useCallback, useRef, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import { Topic, FileNode, Person, FileType, CoverCropData } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Image, User, Plus, Trash2, Folder, ExternalLink, ChevronRight, Layout, ArrowLeft, MoreHorizontal, Edit2, FileImage, ExternalLinkIcon, Grid3X3, Rows, Columns, FolderOpen, ArrowDownUp, Check } from 'lucide-react';
import { ImageThumbnail } from './FileGrid';
import { debug as logDebug, info as logInfo } from '../utils/logger';

type LayoutMode = 'grid' | 'adaptive' | 'masonry';

interface LayoutItem {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
}

const useLayout = (
    items: string[],
    files: Record<string, FileNode>,
    layoutMode: LayoutMode,
    containerWidth: number,
    thumbnailSize: number = 200
) => {
    const aspectRatios = useMemo(() => {
        const ratios: Record<string, number> = {};
        items.forEach(id => {
            const file = files[id];
            ratios[id] = file?.meta?.width && file?.meta?.height
                ? file.meta.width / file.meta.height
                : 1;
        });
        return ratios;
    }, [items, files]);

    return useMemo(() => {
        const layout: LayoutItem[] = [];
        let totalHeight = 0;
        const GAP = 16;
        const PADDING = 0; // TopicModule already has padding on container

        const safeContainerWidth = containerWidth > 0 ? containerWidth : 1280;
        // Subtract parent padding (approx 48px from px-6) if we want to be precise, 
        // but here we are passed the container width which should be the content width if we are careful.
        // Actually containerRect comes from ResizeObserver on the scrolling container, which includes padding? 
        // containerRef is on "topic-gallery-container" which has "px-6 py-8". 
        // So safeContainerWidth includes the padding. We should subtract it.
        const availableWidth = Math.max(100, safeContainerWidth - 48); // px-6 * 2 = 3rem = 48px

        if (layoutMode === 'grid') {
            const minColWidth = thumbnailSize;
            const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
            const itemWidth = (availableWidth - (cols - 1) * GAP) / cols;
            const itemHeight = itemWidth; // Square

            items.forEach((id, index) => {
                const row = Math.floor(index / cols);
                const col = index % cols;
                layout.push({
                    id,
                    x: col * (itemWidth + GAP),
                    y: row * (itemHeight + GAP),
                    width: itemWidth,
                    height: itemHeight
                });
            });
            const rows = Math.ceil(items.length / cols);
            totalHeight = rows * (itemHeight + GAP);
        } else if (layoutMode === 'adaptive') {
            let currentRow: any[] = [];
            let currentWidth = 0;
            let y = 0;
            const targetHeight = thumbnailSize;

            items.forEach((id) => {
                const aspect = aspectRatios[id];
                const w = targetHeight * aspect;

                if (currentWidth + w + GAP > availableWidth) {
                    // Determine scale to fit row exactly
                    const scale = (availableWidth - (currentRow.length - 1) * GAP) / currentWidth;
                    const rowHeight = targetHeight * scale;
                    if (rowHeight > targetHeight * 2.0) { // Limit max height boost
                        // If just one item and it's super wide (or row is very short), don't explode it?
                        // Standard adaptive logic usually accepts the height.
                    }

                    let x = 0;
                    currentRow.forEach(item => {
                        const finalW = item.w * scale;
                        layout.push({ id: item.id, x, y, width: finalW, height: rowHeight });
                        x += finalW + GAP;
                    });

                    y += rowHeight + GAP;
                    currentRow = [];
                    currentWidth = 0;
                }

                currentRow.push({ id, w });
                currentWidth += w;
            });

            // Last row - don't scale up, just place
            if (currentRow.length > 0) {
                let x = 0;
                currentRow.forEach(item => {
                    layout.push({ id: item.id, x, y, width: item.w, height: targetHeight });
                    x += item.w + GAP;
                });
                y += targetHeight + GAP;
            }
            totalHeight = y;

        } else if (layoutMode === 'masonry') {
            const minColWidth = thumbnailSize;
            const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
            const itemWidth = (availableWidth - (cols - 1) * GAP) / cols;
            const colHeights = new Array(cols).fill(0);

            items.forEach(id => {
                const aspect = aspectRatios[id];
                const imgHeight = itemWidth / aspect;

                let minCol = 0;
                let minHeight = colHeights[0];
                for (let i = 1; i < cols; i++) {
                    if (colHeights[i] < minHeight) {
                        minCol = i;
                        minHeight = colHeights[i];
                    }
                }

                layout.push({
                    id,
                    x: minCol * (itemWidth + GAP),
                    y: colHeights[minCol],
                    width: itemWidth,
                    height: imgHeight
                });

                colHeights[minCol] += imgHeight + GAP;
            });
            totalHeight = Math.max(...colHeights);
        }

        return { layout, totalHeight };
    }, [items, files, layoutMode, containerWidth, thumbnailSize, aspectRatios]);
};

// Extracted component to manage layout rendering properly
const TopicFileGrid = React.memo(({
    fileIds,
    files,
    layoutMode,
    containerWidth,
    selectedFileIds,
    // new: notify parent of a click (so parent can implement ctrl/shift/range selection)
    onFileClick,
    onOpenFile,
    onContextMenu,
    resourceRoot,
    cachePath
}: {
    fileIds: string[],
    files: Record<string, FileNode>,
    layoutMode: LayoutMode,
    containerWidth: number,
    selectedFileIds: string[],
    onFileClick?: (e: React.MouseEvent, id: string) => void,
    onOpenFile?: (id: string) => void,
    onContextMenu?: (e: React.MouseEvent, id: string) => void,
    resourceRoot?: string,
    cachePath?: string
}) => {
    // Calculate layout at the top level of this component
    const { layout, totalHeight } = useLayout(
        fileIds,
        files,
        layoutMode,
        containerWidth,
        200
    );

    return (
        <div className="relative w-full transition-all duration-300 ease-out" style={{ height: totalHeight }}>
            {layout.map(item => {
                const file = files[item.id];
                if (!file) return null;

                {
                    const isSelected = (selectedFileIds || []).includes(file.id);
                    return (
                        <div
                            key={file.id}
                            // Ensure outer wrapper does NOT scale on hover; only inner content scales
                            className={`absolute cursor-pointer group rounded-lg transform-gpu transition-all duration-300 file-item ${isSelected ? 'z-20' : ''}`}
                            data-file-id={file.id}
                            style={{
                                left: item.x,
                                top: item.y,
                                width: item.width,
                                height: item.height
                            }}
                            onMouseDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                                e.stopPropagation();
                                // Delegate click handling to parent when available so it can implement multi-select (ctrl/shift)
                                if (onFileClick) {
                                    onFileClick(e, file.id);
                                } else {
                                    // Fallback to single selection
                                    (typeof (onContextMenu) !== 'undefined') && onContextMenu(e, file.id);
                                }
                            }}
                            onDoubleClick={(e) => {
                                e.stopPropagation();
                                onOpenFile?.(file.id);
                            }}
                            onContextMenu={(e) => {
                                e.stopPropagation();
                                onContextMenu && onContextMenu(e, file.id);
                            }}
                        >
                            {/* Inner scaled container: handles hover scale and clipping of the image only */}
                            <div className="w-full h-full bg-cover bg-center overflow-hidden relative rounded-lg">
                                <div className="w-full h-full transition-shadow duration-300 origin-center group-hover:shadow-lg">
                                    <div className="w-full h-full transition-transform duration-500 group-hover:scale-110 origin-center">
                                        <ImageThumbnail
                                            src={''}
                                            alt={file.name}
                                            isSelected={isSelected}
                                            filePath={file.path}
                                            modified={file.updatedAt}
                                            size={undefined}
                                            isHovering={false}
                                            fileMeta={file.meta}
                                            resourceRoot={resourceRoot}
                                            cachePath={cachePath}
                                        />
                                    </div>

                                    {/* Hover overlay to restore original hover feedback (kept inside scaled area) */}
                                    <div className="absolute inset-0 pointer-events-none flex items-end p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                        <div className="w-full bg-black/40 text-white text-xs rounded-md px-2 py-1 backdrop-blur-sm truncate">{file.name}</div>
                                    </div>
                                </div>
                            </div>

                            {/* Selection overlay placed on outer container so it is NOT clipped by inner overflow-hidden */}
                            {isSelected && (
                                <div className="absolute inset-0 pointer-events-none rounded-lg z-30">
                                    <div className="absolute inset-0 rounded-lg ring-4 ring-blue-500 ring-offset-0 transition-all" />
                                    <div className="absolute top-2 right-2 bg-blue-600 text-white rounded-full w-7 h-7 flex items-center justify-center shadow-lg z-40">
                                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                        </svg>
                                    </div>
                                </div>
                            )}
                        </div>
                    );
                }
            })}
        </div>
    );
});

interface TopicModuleProps {
    topics: Record<string, Topic>;
    files: Record<string, FileNode>;
    people: Record<string, Person>;
    currentTopicId: string | null;
    selectedTopicIds: string[];
    selectedFileIds?: string[];
    // New: selected people for multi-select support (controlled by parent)
    selectedPersonIds?: string[];
    // New: last selected id (used for shift+range selection)
    lastSelectedId?: string | null;
    onNavigateTopic: (topicId: string | null) => void;
    onUpdateTopic: (topicId: string, updates: Partial<Topic>) => void;
    onCreateTopic: (parentId: string | null, name?: string, type?: string) => void;
    onDeleteTopic: (topicId: string) => void;
    onSelectTopics: (ids: string[], lastSelectedId?: string | null) => void;
    // Note: onSelectFiles now accepts an optional lastSelectedId to allow caller to set it
    onSelectFiles: (ids: string[], lastSelectedId?: string | null) => void;
    // New: allow bulk selection of people
    onSelectPeople?: (ids: string[]) => void;
    onSelectPerson?: (personId: string, e: React.MouseEvent) => void;
    onNavigatePerson?: (personId: string) => void;
    // Optional: provide a handler to open a topic/person/file in a new tab, or to open file folder
    onOpenTopicInNewTab?: (topicId: string) => void;
    onOpenPersonInNewTab?: (personId: string) => void;
    onOpenFileInNewTab?: (fileId: string) => void;
    onOpenFileFolder?: (folderId: string, options?: { targetId?: string }) => void;
    // Optional: resource root and cache path for thumbnail generation
    resourceRoot?: string;
    cachePath?: string;
    // Called to open a file in viewer (double-click)
    onOpenFile?: (fileId: string) => void;
    t: (key: string) => string;
    scrollTop?: number;
    onScrollTopChange?: (scrollTop: number) => void;
    isVisible?: boolean;
    // Optional: allow parent to control topic layout mode (TopBar will render buttons when provided)
    topicLayoutMode?: LayoutMode;
    onTopicLayoutModeChange?: (mode: LayoutMode) => void;
    onShowToast?: (message: string) => void;
}

export const TopicModule: React.FC<TopicModuleProps> = ({
    topics, files, people, currentTopicId, selectedTopicIds, selectedFileIds = [], selectedPersonIds = [], lastSelectedId = null,
    onNavigateTopic, onUpdateTopic, onCreateTopic, onDeleteTopic, onSelectTopics, onSelectFiles,
    onSelectPeople, onSelectPerson, onNavigatePerson, onOpenTopicInNewTab, onOpenPersonInNewTab, onOpenFileInNewTab, onOpenFileFolder, resourceRoot, cachePath, onOpenFile, t,
    scrollTop, onScrollTopChange, isVisible = true, topicLayoutMode, onTopicLayoutModeChange, onShowToast
}) => {

    // Selection state for box selection
    const [isSelecting, setIsSelecting] = useState(false);
    const selectionRef = useRef<HTMLDivElement>(null);
    const selectionOverlayRef = useRef<HTMLDivElement>(null);
    const lastSelectedIdRef = useRef<string | null>(null);

    const dragStateRef = useRef<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
    const selectionRafRef = useRef<number | null>(null);
    const detachSelectionListenersRef = useRef<(() => void) | null>(null);
    const isDocTrackingSelectionRef = useRef(false);

    const clearSelectionOverlay = useCallback(() => {
        if (selectionRafRef.current) {
            cancelAnimationFrame(selectionRafRef.current);
            selectionRafRef.current = null;
        }
        const overlay = selectionOverlayRef.current;
        if (overlay) {
            overlay.style.display = 'none';
            overlay.style.width = '0px';
            overlay.style.height = '0px';
            overlay.style.transform = 'translate(0px, 0px)';
        }
    }, []);

    const updateSelectionOverlay = useCallback(() => {
        const overlay = selectionOverlayRef.current;
        const container = selectionRef.current;
        const dragState = dragStateRef.current;
        if (!overlay || !container || !dragState) return;

        const left = Math.min(dragState.startX, dragState.currentX) - container.scrollLeft;
        const top = Math.min(dragState.startY, dragState.currentY) - container.scrollTop;
        const width = Math.abs(dragState.currentX - dragState.startX);
        const height = Math.abs(dragState.currentY - dragState.startY);

        overlay.style.display = 'block';
        overlay.style.left = `${left}px`;
        overlay.style.top = `${top}px`;
        overlay.style.width = `${width}px`;
        overlay.style.height = `${height}px`;
    }, []);

    const scheduleSelectionOverlayRender = useCallback(() => {
        if (selectionRafRef.current) return;
        selectionRafRef.current = requestAnimationFrame(() => {
            selectionRafRef.current = null;
            updateSelectionOverlay();
        });
    }, [updateSelectionOverlay]);

    const updateSelectionFromPointer = useCallback((clientX: number, clientY: number) => {
        const container = selectionRef.current;
        const dragState = dragStateRef.current;
        if (!container || !dragState) return;

        const rect = container.getBoundingClientRect();
        dragState.currentX = clientX - rect.left + container.scrollLeft;
        dragState.currentY = clientY - rect.top + container.scrollTop;
        scheduleSelectionOverlayRender();
    }, [scheduleSelectionOverlayRender]);

    const detachSelectionListeners = useCallback(() => {
        if (detachSelectionListenersRef.current) {
            detachSelectionListenersRef.current();
            detachSelectionListenersRef.current = null;
        }
        isDocTrackingSelectionRef.current = false;
    }, []);

    useEffect(() => {
        return () => {
            dragStateRef.current = null;
            clearSelectionOverlay();
            detachSelectionListeners();
        };
    }, [clearSelectionOverlay, detachSelectionListeners]);

    // Context menu state
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: 'blank' | 'single' | 'multiple' | 'person' | 'file' | 'multiplePerson' | 'multipleFile'; topicId?: string; personId?: string; fileId?: string } | null>(null);
    const contextMenuRef = useRef<HTMLDivElement | null>(null);

    // Reposition menu to ensure it fits within viewport
    useEffect(() => {
        const el = contextMenuRef.current;
        if (!el || !contextMenu) return;

        // Use requestAnimationFrame to ensure the DOM has been updated by React (via Portal)
        const rafId = requestAnimationFrame(() => {
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;

            let left = contextMenu.x;
            let top = contextMenu.y;

            if (left + rect.width > window.innerWidth) {
                left = Math.max(8, window.innerWidth - rect.width - 8);
            }
            if (top + rect.height > window.innerHeight) {
                top = Math.max(8, window.innerHeight - rect.height - 8);
            }

            el.style.left = `${left}px`;
            el.style.top = `${top}px`;
            el.style.visibility = 'visible'; // Show it once positioned
        });

        return () => cancelAnimationFrame(rafId);
    }, [contextMenu]);

    // Modal states
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showRenameModal, setShowRenameModal] = useState(false);
    const [showCoverModal, setShowCoverModal] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [currentEditingTopic, setCurrentEditingTopic] = useState<Topic | null>(null);
    const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);

    const [topicSortMode, setTopicSortMode] = useState<'name' | 'time'>(() => {
        return (localStorage.getItem('aurora_topic_sort_mode') as 'name' | 'time') || 'time';
    });
    const [topicSortOrder, setTopicSortOrder] = useState<'asc' | 'desc'>(() => {
        return (localStorage.getItem('aurora_topic_sort_order') as 'asc' | 'desc') || 'desc';
    });
    const [showTopicSortMenu, setShowTopicSortMenu] = useState(false);
    const topicSortButtonRef = useRef<HTMLButtonElement>(null);

    const sortTopics = useCallback((topicsList: Topic[]) => {
        return [...topicsList].sort((a, b) => {
            let comparison = 0;
            if (topicSortMode === 'name') {
                comparison = (a.name || '').localeCompare(b.name || '');
            } else {
                comparison = (a.createdAt || '').localeCompare(b.createdAt || '');
            }
            return topicSortOrder === 'asc' ? comparison : -comparison;
        });
    }, [topicSortMode, topicSortOrder]);

    const toggleSortMode = (mode: 'name' | 'time') => {
        if (topicSortMode === mode) {
            const nextOrder = topicSortOrder === 'asc' ? 'desc' : 'asc';
            setTopicSortOrder(nextOrder);
            localStorage.setItem('aurora_topic_sort_order', nextOrder);
        } else {
            setTopicSortMode(mode);
            localStorage.setItem('aurora_topic_sort_mode', mode);
        }
        setShowTopicSortMenu(false);
    };

    // Helper to get cover image URL
    const getCoverUrl = (topic: Topic) => {
        if (topic.coverFileId && files[topic.coverFileId]) {
            return convertFileSrc(files[topic.coverFileId].path);
        }
        // Fallback to first image in topic
        if (topic.fileIds && topic.fileIds.length > 0) {
            const firstFile = files[topic.fileIds[0]];
            if (firstFile) return convertFileSrc(firstFile.path);
        }
        return null; // Should render placeholder
    };

    const getCoverStyle = (topic: Topic): React.CSSProperties | undefined => {
        const coverUrl = getCoverUrl(topic);
        if (!coverUrl) return undefined;

        const style: React.CSSProperties = {
            backgroundImage: `url("${coverUrl}")`,
            backgroundRepeat: 'no-repeat'
        };

        const crop = topic.coverCrop;
        if (crop && crop.width > 0 && crop.height > 0) {
            const safeWidth = Math.min(Math.max(crop.width, 0.1), 99.9);
            const safeHeight = Math.min(Math.max(crop.height, 0.1), 99.9);

            const sizeW = 10000 / safeWidth;
            const sizeH = 10000 / safeHeight;

            const posX = (crop.x / (100 - safeWidth)) * 100;
            const posY = (crop.y / (100 - safeHeight)) * 100;

            style.backgroundSize = `${sizeW}% ${sizeH}%`;
            style.backgroundPosition = `${posX}% ${posY}%`;
        } else {
            style.backgroundSize = 'cover';
            style.backgroundPosition = 'center';
        }

        return style;
    };

    const currentTopic = currentTopicId ? topics[currentTopicId] : null;

    // Local selection state for people in topic view (click to select, second click to navigate)
    const [clickedOncePerson, setClickedOncePerson] = useState<string | null>(null);
    const clickTimerRef = useRef<number | null>(null);

    const [coverHeight, setCoverHeight] = useState(350);
    const requestRef = useRef<number | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
    const [layoutMode, setLayoutMode] = useState<LayoutMode>(() => {
        return (localStorage.getItem('aurora_topic_layout_mode') as LayoutMode) || 'grid';
    });

    // Cleanup timer on unmount
    useEffect(() => {
        return () => {
            if (clickTimerRef.current) {
                window.clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
            }
        };
    }, []);

    const handlePersonClickLocal = (personId: string, e: React.MouseEvent) => {
        e.stopPropagation();
        // Notify parent to update global selection state
        onSelectPerson && onSelectPerson(personId, e);

        if (clickedOncePerson === personId) {
            // Second click �?navigate
            onNavigatePerson && onNavigatePerson(personId);
            setClickedOncePerson(null);
            if (clickTimerRef.current) {
                window.clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
            }
        } else {
            setClickedOncePerson(personId);
            // Clear previous timer if exists
            if (clickTimerRef.current) {
                window.clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
            }
        }
    };

    const handlePersonContextMenu = useCallback((e: React.MouseEvent, personId: string) => {
        e.preventDefault();
        e.stopPropagation();
        // If multiple people are selected and the clicked one is part of selection, show multiple-person menu
        if ((selectedPersonIds || []).length > 1 && (selectedPersonIds || []).includes(personId)) {
            setContextMenu({ x: e.clientX, y: e.clientY, type: 'multiplePerson' });
            return;
        }
        // Otherwise: ensure the clicked person is selected (but don't clear an existing multi-selection unnecessarily)
        if (!((selectedPersonIds || []).includes(personId))) {
            if (typeof onSelectPeople === 'function') {
                onSelectPeople([personId]);
            } else {
                onSelectPerson && onSelectPerson(personId, e);
            }
        }
        setContextMenu({ x: e.clientX, y: e.clientY, type: 'person', personId });
    }, [onSelectPerson, onSelectPeople, selectedPersonIds]);

    const removePeopleFromCurrentTopic = useCallback((personIds: string[]) => {
        if (!currentTopic || personIds.length === 0) {
            setContextMenu(null);
            return;
        }

        const idsToRemove = new Set(personIds);
        const topicsToUpdate: Record<string, string[]> = {};

        const markTopic = (topicId: string) => {
            const topic = topics[topicId];
            if (!topic) return;
            const existingPeople = topic.peopleIds || [];
            const filtered = existingPeople.filter(pid => !idsToRemove.has(pid));
            if (filtered.length !== existingPeople.length) {
                topicsToUpdate[topicId] = filtered;
            }
        };

        markTopic(currentTopic.id);
        if (!currentTopic.parentId) {
            const traverse = (parentId: string) => {
                Object.values(topics).forEach(child => {
                    if (child.parentId === parentId) {
                        markTopic(child.id);
                        traverse(child.id);
                    }
                });
            };
            traverse(currentTopic.id);
        }

        if (Object.keys(topicsToUpdate).length === 0) {
            setContextMenu(null);
            return;
        }

        Object.entries(topicsToUpdate).forEach(([topicId, newPeople]) => {
            onUpdateTopic(topicId, { peopleIds: newPeople });
        });

        if (onShowToast) {
            onShowToast(t('context.removedFromTopic') || '已从专题中移除');
        }

        if (typeof onSelectPeople === 'function') {
            onSelectPeople([]);
        }

        setContextMenu(null);
    }, [currentTopic, topics, onSelectPeople, onUpdateTopic, onShowToast, t]);

    // Callback ref to set both containerRef and selectionRef
    const setRefs = useCallback((node: HTMLDivElement | null) => {
        (containerRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        (selectionRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
    }, []);

    useEffect(() => {
        const elem = containerRef.current;
        if (!elem) return;

        const observer = new ResizeObserver(entries => {
            for (const entry of entries) {
                const { width, height } = entry.contentRect;
                setContainerRect({ width, height });
            }
        });

        observer.observe(elem);
        return () => observer.disconnect();
    }, []);

    // Scroll Restoration Logic
    const isRestoringScrollRef = useRef(false);
    const hasRestoredRef = useRef(false);
    const restoreTimeoutRef = useRef<any>(null);

    // Reset restoration flag when navigation occurs or visibility changes
    useLayoutEffect(() => {
        if (isVisible) {
            hasRestoredRef.current = false;
            if (restoreTimeoutRef.current) {
                clearTimeout(restoreTimeoutRef.current);
            }
            isRestoringScrollRef.current = false;
        }
    }, [currentTopicId, isVisible]);

    // Perform restoration
    useLayoutEffect(() => {
        if (!isVisible) return;

        let rafId: number;
        let timeoutId: any;

        const attemptRestore = () => {
            if (!containerRef.current || hasRestoredRef.current) return;

            const targetScroll = scrollTop || 0;

            // Wait for width to be ready
            if (containerRect.width <= 0) {
                rafId = requestAnimationFrame(attemptRestore);
                return;
            }

            if (targetScroll > 0) {
                const currentScrollHeight = containerRef.current.scrollHeight;
                const clientHeight = containerRef.current.clientHeight;
                const maxScroll = Math.max(0, currentScrollHeight - clientHeight);

                // If target is unreachable currently, wait
                // But if we are very close or valid, try to set logic

                // Try to set it first
                isRestoringScrollRef.current = true;
                containerRef.current.scrollTop = targetScroll;

                const currentScroll = containerRef.current.scrollTop;
                const isClamped = Math.abs(currentScroll - targetScroll) > 20; // 20px tolerance

                // If strictly unreachable (e.g. content not loaded), continue retrying
                if (isClamped) {
                    // Check if height is plausibly going to increase? 
                    // Just keep retrying until timeout
                    rafId = requestAnimationFrame(attemptRestore);
                } else {
                    // Success
                    hasRestoredRef.current = true;
                    logInfo('[TopicModule] restoredScroll.success', { topicId: currentTopicId || 'root', targetScroll, actual: currentScroll });

                    if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
                    restoreTimeoutRef.current = setTimeout(() => {
                        isRestoringScrollRef.current = false;
                    }, 100);
                }
            } else {
                // Explicitly reset to 0
                if (Math.abs(containerRef.current.scrollTop) > 5) { // Only force if drift > 5px
                    isRestoringScrollRef.current = true;
                    containerRef.current.scrollTop = 0;

                    if (restoreTimeoutRef.current) clearTimeout(restoreTimeoutRef.current);
                    restoreTimeoutRef.current = setTimeout(() => {
                        isRestoringScrollRef.current = false;
                    }, 50);
                }
                hasRestoredRef.current = true;
            }
        };

        if (!hasRestoredRef.current) {
            attemptRestore();
        }

        // Safety timeout to stop infinite retries
        const safetyTimeout = setTimeout(() => {
            if (containerRef.current && !hasRestoredRef.current) {
                // Final attempt force
                if ((scrollTop || 0) > 0) {
                    logInfo('[TopicModule] safetyRestoreScroll.timeout', { target: scrollTop, current: containerRef.current.scrollTop, scrollHeight: containerRef.current.scrollHeight });
                }
                hasRestoredRef.current = true;
            }
            if (rafId) cancelAnimationFrame(rafId);
        }, 2000);

        return () => {
            if (rafId) cancelAnimationFrame(rafId);
            clearTimeout(safetyTimeout);
        };
    }, [currentTopicId, scrollTop, containerRect.width, isVisible]);

    // Track scroll position
    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        const handleScroll = () => {
            if (isRestoringScrollRef.current) return;
            onScrollTopChange?.(container.scrollTop);
        };

        container.addEventListener('scroll', handleScroll, { passive: true });
        return () => container.removeEventListener('scroll', handleScroll);
    }, [containerRect, onScrollTopChange]); // Re-bind when containerRect changes (meaning layout might have changed), or when onScrollTopChange changes. Also implicitly when containerRef.current (node) changes because of effect cleanup/re-run if we used valid dependencies.
    // Note: containerRef.current is not a valid dependency for useEffect in standard React unless we use the callback ref pattern for force update. 
    // However, since we have the ResizeObserver effect above, `containerRect` changes will act as a signal that the container is ready/changed.

    const handleWheel = useCallback((e: WheelEvent) => {
        if (e.ctrlKey) {
            e.preventDefault();
            const delta = e.deltaY > 0 ? -20 : 20;

            if (requestRef.current) cancelAnimationFrame(requestRef.current);

            requestRef.current = requestAnimationFrame(() => {
                setCoverHeight(prev => Math.min(600, Math.max(200, prev + delta)));
            });
        }
    }, []);

    useEffect(() => {
        const container = containerRef.current;
        if (container) {
            container.addEventListener('wheel', handleWheel, { passive: false });
            return () => {
                container.removeEventListener('wheel', handleWheel);
                if (requestRef.current) cancelAnimationFrame(requestRef.current);
            };
        }
    }, [handleWheel]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (showTopicSortMenu && !target.closest('.topic-sort-container')) {
                setShowTopicSortMenu(false);
            }
        };
        if (showTopicSortMenu) {
            document.addEventListener('mousedown', handleClickOutside);
            return () => document.removeEventListener('mousedown', handleClickOutside);
        }
    }, [showTopicSortMenu]);

    // Close context menu when clicking anywhere or scrolling
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            // Check if click is outside the context menu
            const target = e.target as HTMLElement;
            if (!target.closest('.context-menu')) {
                setContextMenu(null);
            }
        };

        const handleScroll = () => {
            setContextMenu(null);
        };

        if (contextMenu) {
            // Use mousedown and capture phase to ensure we catch the event before stopPropagation()
            // Add slight delay to avoid catching the same event that opened the menu
            const timeoutId = setTimeout(() => {
                document.addEventListener('mousedown', handleClickOutside, true);
                document.addEventListener('scroll', handleScroll, true);
            }, 0);
            return () => {
                clearTimeout(timeoutId);
                document.removeEventListener('mousedown', handleClickOutside, true);
                document.removeEventListener('scroll', handleScroll, true);
            };
        }
    }, [contextMenu]);

    // Handle right-click context menu
    const handleContextMenu = useCallback((e: React.MouseEvent, topicId?: string) => {
        e.preventDefault();
        e.stopPropagation();

        if (!topicId) {
            // Clicked on blank area
            setContextMenu({ x: e.clientX, y: e.clientY, type: 'blank' });
            // Clear selections when right-clicking blank
            onSelectTopics([]);
            if (typeof onSelectPeople === 'function') onSelectPeople([]);
            onSelectFiles && onSelectFiles([], null);
            setClickedOncePerson(null);
        } else if (selectedTopicIds.length > 1 && selectedTopicIds.includes(topicId)) {
            // Right-clicked on a selected topic when multiple are selected
            setContextMenu({ x: e.clientX, y: e.clientY, type: 'multiple' });
        } else {
            // Right-clicked on a single topic
            if (!selectedTopicIds.includes(topicId)) {
                onSelectTopics([topicId]);
            }
            setContextMenu({ x: e.clientX, y: e.clientY, type: 'single', topicId });
        }
    }, [selectedTopicIds, onSelectTopics]);

    const finalizeSelection = useCallback((clientX?: number, clientY?: number) => {
        if (!dragStateRef.current) return;

        if (typeof clientX === 'number' && typeof clientY === 'number') {
            updateSelectionFromPointer(clientX, clientY);
        }

        const container = selectionRef.current;
        const dragState = dragStateRef.current;
        if (!container || !dragState) {
            dragStateRef.current = null;
            setIsSelecting(false);
            clearSelectionOverlay();
            detachSelectionListeners();
            return;
        }

        const width = Math.abs(dragState.currentX - dragState.startX);
        const height = Math.abs(dragState.currentY - dragState.startY);

        if (width < 5 && height < 5) {
            dragStateRef.current = null;
            setIsSelecting(false);
            clearSelectionOverlay();
            detachSelectionListeners();
            return;
        }

        const containerRect = container.getBoundingClientRect();
        const selectionLeft = containerRect.left + (Math.min(dragState.startX, dragState.currentX) - container.scrollLeft);
        const selectionTop = containerRect.top + (Math.min(dragState.startY, dragState.currentY) - container.scrollTop);
        const selectionRight = containerRect.left + (Math.max(dragState.startX, dragState.currentX) - container.scrollLeft);
        const selectionBottom = containerRect.top + (Math.max(dragState.startY, dragState.currentY) - container.scrollTop);

        const selectedIds: string[] = [];
        const topicElements = container.querySelectorAll('.topic-item');
        topicElements.forEach(element => {
            const id = element.getAttribute('data-topic-id');
            if (id) {
                const rect = element.getBoundingClientRect();
                if (rect.left < selectionRight &&
                    rect.right > selectionLeft &&
                    rect.top < selectionBottom &&
                    rect.bottom > selectionTop) {
                    selectedIds.push(id);
                }
            }
        });

        const selectedPersonIds: string[] = [];
        const personElements = container.querySelectorAll('.person-item');
        personElements.forEach(element => {
            const id = element.getAttribute('data-person-id');
            if (id) {
                const rect = element.getBoundingClientRect();
                if (rect.left < selectionRight && rect.right > selectionLeft && rect.top < selectionBottom && rect.bottom > selectionTop) {
                    selectedPersonIds.push(id);
                }
            }
        });

        const selectedFileIdsFromBox: string[] = [];
        const fileElements = container.querySelectorAll('.file-item');
        fileElements.forEach(element => {
            const id = element.getAttribute('data-file-id');
            if (id) {
                const rect = element.getBoundingClientRect();
                if (rect.left < selectionRight && rect.right > selectionLeft && rect.top < selectionBottom && rect.bottom > selectionTop) {
                    selectedFileIdsFromBox.push(id);
                }
            }
        });

        if (selectedIds.length > 0) onSelectTopics(selectedIds);
        if (selectedPersonIds.length > 0 && typeof onSelectPeople === 'function') onSelectPeople(selectedPersonIds);
        if (selectedFileIdsFromBox.length > 0) onSelectFiles(selectedFileIdsFromBox, selectedFileIdsFromBox[selectedFileIdsFromBox.length - 1]);

        dragStateRef.current = null;
        setIsSelecting(false);
        clearSelectionOverlay();
        detachSelectionListeners();
    }, [onSelectTopics, onSelectPeople, onSelectFiles, updateSelectionFromPointer, clearSelectionOverlay, detachSelectionListeners]);

    // Mouse event handlers for box selection
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        if ((e.target as HTMLElement).closest('.topic-item')) {
            return;
        }

        if (e.button === 0) {
            const container = selectionRef.current;
            if (container) {
                const rect = container.getBoundingClientRect();
                const startX = e.clientX - rect.left + container.scrollLeft;
                const startY = e.clientY - rect.top + container.scrollTop;

                dragStateRef.current = { startX, startY, currentX: startX, currentY: startY };
                setIsSelecting(true);
                scheduleSelectionOverlayRender();

                const handleDocMove = (event: MouseEvent) => {
                    updateSelectionFromPointer(event.clientX, event.clientY);
                };

                const handleDocUp = (event: MouseEvent) => {
                    finalizeSelection(event.clientX, event.clientY);
                };

                document.addEventListener('mousemove', handleDocMove);
                document.addEventListener('mouseup', handleDocUp);
                detachSelectionListenersRef.current = () => {
                    document.removeEventListener('mousemove', handleDocMove);
                    document.removeEventListener('mouseup', handleDocUp);
                };
                isDocTrackingSelectionRef.current = true;

                // Clear topic selection and also clear people/files selection on background start
                onSelectTopics([]);
                if (typeof onSelectPeople === 'function') onSelectPeople([]);
                onSelectFiles && onSelectFiles([], null);
                // Clear local single-click state too
                setClickedOncePerson(null);
            }
        }
    }, [onSelectTopics, updateSelectionFromPointer, finalizeSelection, scheduleSelectionOverlayRender]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (isDocTrackingSelectionRef.current) return;
        updateSelectionFromPointer(e.clientX, e.clientY);
    }, [updateSelectionFromPointer]);

    const handleMouseUp = useCallback((e: React.MouseEvent) => {
        finalizeSelection(e.clientX, e.clientY);
    }, [finalizeSelection]);

    // Handle topic click with ctrl/shift support
    const handleTopicClick = useCallback((e: React.MouseEvent, topicId: string, allTopicIds: string[]) => {
        e.stopPropagation();

        // Close context menu when clicking on a topic
        setContextMenu(null);

        // Sync local ref with prop if it changed externally (e.g. from App state)
        if (lastSelectedId !== lastSelectedIdRef.current) {
            lastSelectedIdRef.current = lastSelectedId;
        }

        if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd+Click: Toggle selection
            let newSelection = [];
            if (selectedTopicIds.includes(topicId)) {
                newSelection = selectedTopicIds.filter(id => id !== topicId);
            } else {
                newSelection = [...selectedTopicIds, topicId];
            }
            
            // Clear other selection types when selecting topics first
            if (typeof onSelectPeople === 'function') onSelectPeople([]);
            onSelectFiles && onSelectFiles([], null);
            // Clear local single-click person state
            setClickedOncePerson(null);
            
            onSelectTopics(newSelection, topicId);
            lastSelectedIdRef.current = topicId;
        } else if (e.shiftKey && lastSelectedIdRef.current) {
            // Shift+Click: Range selection
            const lastIndex = allTopicIds.indexOf(lastSelectedIdRef.current);
            const currentIndex = allTopicIds.indexOf(topicId);

            // Clear other selection types when selecting topics first
            if (typeof onSelectPeople === 'function') onSelectPeople([]);
            onSelectFiles && onSelectFiles([], null);
            setClickedOncePerson(null);

            if (lastIndex !== -1 && currentIndex !== -1) {
                const start = Math.min(lastIndex, currentIndex);
                const end = Math.max(lastIndex, currentIndex);
                const rangeIds = allTopicIds.slice(start, end + 1);

                // Merge with existing selection
                const newSelection = [...new Set([...selectedTopicIds, ...rangeIds])];
                onSelectTopics(newSelection, topicId);
            } else {
                // Fallback if range invalid
                 onSelectTopics([topicId], topicId);
            }
        } else {
            // Normal click: Single selection
            // Clear other selection types when selecting topics first
            if (typeof onSelectPeople === 'function') onSelectPeople([]);
            onSelectFiles && onSelectFiles([], null);
            // Clear local single-click person state
            setClickedOncePerson(null);
            
            onSelectTopics([topicId], topicId);
            lastSelectedIdRef.current = topicId;

        }
    }, [selectedTopicIds, lastSelectedId, onSelectTopics, onSelectPeople, onSelectFiles]);

    const handleTopicDoubleClick = useCallback((e: React.MouseEvent, topicId: string) => {
        e.stopPropagation();
        onNavigateTopic(topicId);
    }, [onNavigateTopic]);

    // Context menu action handlers
    const handleOpenInNewTab = useCallback((topicId: string) => {
        if (typeof onOpenTopicInNewTab === 'function') {
            onOpenTopicInNewTab(topicId);
        } else {
            // Fallback: navigate in current tab
            onNavigateTopic(topicId);
        }
        setContextMenu(null);
    }, [onOpenTopicInNewTab, onNavigateTopic]);

    const handleSetCover = useCallback((topicId: string) => {
        const topic = topics[topicId];
        if (topic) {
            setCurrentEditingTopic(topic);
            setShowCoverModal(true);
        }
        setContextMenu(null);
    }, [topics]);

    const handleRename = useCallback((topicId: string) => {
        const topic = topics[topicId];
        if (topic) {
            setCurrentEditingTopic(topic);
            setShowRenameModal(true);
        }
        setContextMenu(null);
    }, [topics]);

    const handleDelete = useCallback((topicIds: string[]) => {
        setDeleteTargetIds(topicIds);
        setShowDeleteConfirm(true);
        setContextMenu(null);
    }, []);

    const confirmDelete = useCallback(() => {
        deleteTargetIds.forEach(id => onDeleteTopic(id));
        setShowDeleteConfirm(false);
        setDeleteTargetIds([]);
        onSelectTopics([]);
    }, [deleteTargetIds, onDeleteTopic, onSelectTopics]);

    const handleCreateTopic = useCallback(() => {
        setShowCreateModal(true);
        setContextMenu(null);
    }, []);

    const handleCreateTopicWithName = useCallback((name: string, type?: string) => {
        onCreateTopic(currentTopicId, name, type ? type.slice(0, 12) : undefined);
        setShowCreateModal(false);
    }, [currentTopicId, onCreateTopic]);

    const handleFileContextMenu = useCallback((e: React.MouseEvent, fileId: string) => {
        e.preventDefault();
        e.stopPropagation();
        // If multiple files are selected and the clicked one is part of selection, show multiple-file menu
        if ((selectedFileIds || []).length > 1 && (selectedFileIds || []).includes(fileId)) {
            setContextMenu({ x: e.clientX, y: e.clientY, type: 'multipleFile' });
            return;
        }
        // Otherwise, if clicked file is not selected, select it (single selection)
        if (!((selectedFileIds || []).includes(fileId))) {
            onSelectFiles && onSelectFiles([fileId], fileId);
        }
        setContextMenu({ x: e.clientX, y: e.clientY, type: 'file', fileId });
    }, [onSelectFiles, selectedFileIds]);

    // Helpers to log scroll positions and delegate opens
    const getContainerScroll = () => containerRef.current ? containerRef.current.scrollTop : 0;


    const handleOpenFileLocal = (fileId: string) => {
        const scroll = getContainerScroll();
        const file = files[fileId];
        const target = file?.type === FileType.FOLDER ? 'folder' : 'viewer';
        logInfo('[TopicModule] open', { action: 'open', target, fileId, topicId: currentTopicId || 'root', containerScroll: scroll });
        if (onOpenFile) onOpenFile(fileId);
    };

    const handleOpenFolderLocal = (folderId: string, targetId?: string) => {
        const scroll = getContainerScroll();
        logInfo('[TopicModule] enterFolder', { action: 'enterFolder', folderId, topicId: currentTopicId || 'root', containerScroll: scroll, targetId });
        if (onOpenFileFolder) onOpenFileFolder(folderId, { targetId });
    };

    const handleOpenInNewTabLocal = (fileId: string) => {
        const scroll = getContainerScroll();
        logInfo('[TopicModule] openInNewTab', { action: 'openInNewTab', fileId, topicId: currentTopicId || 'root', containerScroll: scroll });
        if (onOpenFileInNewTab) onOpenFileInNewTab(fileId);
    };


    const removeFilesFromCurrentTopic = useCallback((fileIds: string[]) => {
        if (!currentTopic || fileIds.length === 0) {
            setContextMenu(null);
            return;
        }

        const fileIdSet = new Set(fileIds);
        const previousFileIds = currentTopic.fileIds || [];
        const newFiles = previousFileIds.filter(id => !fileIdSet.has(id));

        if (newFiles.length === previousFileIds.length) {
            setContextMenu(null);
            return;
        }

        onUpdateTopic(currentTopic.id, { fileIds: newFiles });
        onSelectFiles && onSelectFiles([], null);
        if (onShowToast) {
            onShowToast(t('context.removedFromTopic') || '已从专题中移除');
        }
        setContextMenu(null);
    }, [currentTopic, onUpdateTopic, onSelectFiles, onShowToast, t]);

    const { layoutItems, totalHeight } = useMemo(() => {
        if (currentTopicId) return { layoutItems: [], totalHeight: 0 };

        const rootTopics = Object.values(topics).filter(topic => !topic.parentId);
        const sortedRootTopics = sortTopics(rootTopics);

        const GAP_X = 32; // Increased horizontal gap
        const GAP_Y = 48; // Increased vertical gap for title room
        const ASPECT = 0.75;

        const width = containerRect.width;

        if (width <= 0) return { layoutItems: [], totalHeight: 0 };

        const minItemHeight = coverHeight;
        const minItemWidth = minItemHeight * ASPECT;

        const cols = Math.max(1, Math.floor((width + GAP_X) / (minItemWidth + GAP_X)));
        const itemWidth = minItemWidth;
        const itemHeight = minItemHeight;

        const validItems = sortedRootTopics.map((topic, index) => {
            const row = Math.floor(index / cols);
            const col = index % cols;
            return {
                topic,
                x: col * (itemWidth + GAP_X),
                y: row * (itemHeight + GAP_Y),
                width: itemWidth,
                height: itemHeight
            };
        });

        const rows = Math.ceil(sortedRootTopics.length / cols);
        const height = rows > 0 ? rows * itemHeight + (rows - 1) * GAP_Y : 0;

        return { layoutItems: validItems, totalHeight: height };

    }, [topics, currentTopicId, containerRect.width, coverHeight, sortTopics]);

    // View: Topic Gallery (Root)
    const renderGallery = () => {
        const rootTopics = Object.values(topics).filter(topic => !topic.parentId);
        const sortedRootTopics = sortTopics(rootTopics);
        const allTopicIds = sortedRootTopics.map(t => t.id);

        return (
            <div
                id="topic-gallery-container"
                ref={setRefs}
                className="p-6 h-full overflow-y-auto"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onContextMenu={(e) => handleContextMenu(e)}
            >
                <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center">
                        <Layout className="mr-3" />
                        {t('sidebar.topics')}
                    </h2>
                    <div className="flex items-center space-x-2">
                        <div className="relative topic-sort-container">
                            <button
                                ref={topicSortButtonRef}
                                onClick={() => setShowTopicSortMenu(!showTopicSortMenu)}
                                className={`p-2 rounded-lg transition border ${showTopicSortMenu ? 'bg-blue-50 dark:bg-blue-900/20 border-blue-200 dark:border-blue-800 text-blue-600 dark:text-blue-400' : 'bg-white dark:bg-gray-800 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700'}`}
                                title={t('sort.sortBy')}
                            >
                                <ArrowDownUp size={18} />
                            </button>
                            {showTopicSortMenu && (
                                <div className="absolute right-0 mt-2 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 z-[60]">
                                    <button
                                        onClick={() => toggleSortMode('name')}
                                        className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
                                    >
                                        <span className="text-sm">{t('sort.name')}</span>
                                        {topicSortMode === 'name' && (
                                            <div className="flex items-center">
                                                <Check size={14} className="text-blue-500 mr-1" />
                                                <span className="text-[10px] uppercase font-bold text-gray-500">{topicSortOrder === 'asc' ? '↑' : '↓'}</span>
                                            </div>
                                        )}
                                    </button>
                                    <button
                                        onClick={() => toggleSortMode('time')}
                                        className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
                                    >
                                        <span className="text-sm">{t('sort.date')}</span>
                                        {topicSortMode === 'time' && (
                                            <div className="flex items-center">
                                                <Check size={14} className="text-blue-500 mr-1" />
                                                <span className="text-[10px] uppercase font-bold text-gray-500">{topicSortOrder === 'asc' ? '↑' : '↓'}</span>
                                            </div>
                                        )}
                                    </button>
                                </div>
                            )}
                        </div>
                        <button
                            onClick={handleCreateTopic}
                            className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center hover:bg-blue-700 transition shadow-sm"
                        >
                            <Plus size={18} className="mr-2" />
                            {t('context.newTopic')}
                        </button>
                    </div>
                </div>

                <div className="relative" style={{ height: totalHeight }}>
                    {layoutItems.map(({ topic, x, y, width, height }) => {
                        const coverStyle = getCoverStyle(topic);
                        const personCount = topic.peopleIds.length;
                        const subTopicCount = Object.values(topics).filter(t => t.parentId === topic.id).length;
                        const isSelected = selectedTopicIds.includes(topic.id);

                        return (
                            <div
                                key={topic.id}
                                className={`topic-item group/topic absolute cursor-pointer perspective-1000`}
                                data-topic-id={topic.id}
                                style={{
                                    left: x,
                                    top: y,
                                    width: width,
                                    height: height,
                                    transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                                    zIndex: isSelected ? 10 : 0
                                }}
                                onMouseDown={(e) => e.stopPropagation()}
                                onClick={(e) => handleTopicClick(e, topic.id, allTopicIds)}
                                onDoubleClick={(e) => handleTopicDoubleClick(e, topic.id)}
                                onContextMenu={(e) => handleContextMenu(e, topic.id)}
                            >
                                <div className={`absolute inset-0 transform transition-all duration-300 group-hover:shadow-2xl rounded-xl ${isSelected ? 'ring-4 ring-blue-500 ring-offset-0 dark:ring-offset-0 shadow-blue-500/20' : ''}`}>
                                    <div className="absolute inset-0 bg-gray-200 dark:bg-gray-800 rounded-xl overflow-hidden border border-gray-100 dark:border-gray-800 shadow-lg">
                                        {coverStyle ? (
                                            <div className="w-full h-full overflow-hidden">
                                                <div className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover/topic:scale-110 origin-center" style={coverStyle} />
                                            </div>
                                        ) : (
                                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600">
                                                <Layout size={48} className="text-white opacity-50" />
                                            </div>
                                        )}

                                        {/* Magazine Title Overlay */}
                                        <div className="absolute top-0 left-0 right-0 p-4 bg-gradient-to-b from-black/60 to-transparent">
                                            <h3 className="text-white font-serif text-2xl font-bold tracking-widest uppercase drop-shadow-md truncate">
                                                {topic.name}
                                            </h3>
                                        </div>

                                        {/* Info Overlay */}
                                        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black/80 via-black/40 to-transparent pt-12">
                                            <div className="flex justify-between items-end text-white">
                                                <div>
                                                    <div className="text-xs opacity-70 flex items-center mb-0.5">
                                                        <User size={10} className="mr-1" /> {personCount}
                                                    </div>
                                                    <div className="text-xs opacity-70 flex items-center">
                                                        <Folder size={10} className="mr-1" /> {subTopicCount}
                                                    </div>
                                                </div>
                                                {topic.type && topic.type.trim() ? (
                                                    <span className="text-xs border border-white/30 rounded-full px-2 py-0.5 backdrop-blur-sm">
                                                        {topic.type.length > 12 ? `${topic.type.slice(0, 12)}…` : topic.type}
                                                    </span>
                                                ) : null}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        );
                    })}
                    {layoutItems.length === 0 && (
                        <div className="absolute inset-0 flex items-center justify-center text-gray-400" style={{ height: 200 }}>
                            {/* Empty state placeholder */}
                        </div>
                    )}
                </div>
                {/* Selection Box */}
                <div
                    ref={selectionOverlayRef}
                    className="absolute pointer-events-none border-2 border-blue-500 bg-blue-500/10 z-50 hidden"
                    style={{ display: 'none', left: 0, top: 0 }}
                />            </div>
        );
    };

    // View: Topic Detail
    const renderDetail = () => {
        if (!currentTopic) return null;

        const subTopics = Object.values(topics).filter(t => t.parentId === currentTopic.id);
        const sortedSubTopics = sortTopics(subTopics);
        const topicImages = (currentTopic.fileIds || []).map(id => files[id]).filter(f => f && f.type === FileType.IMAGE);
        // File click handler for multi-select support
        const handleFileClickLocal = (e: React.MouseEvent, id: string) => {
            e.stopPropagation();
            if (isSelecting) return;

            // When selecting a file, clear people selection and local single-click state
            if (typeof onSelectPeople === 'function') onSelectPeople([]);
            setClickedOncePerson(null);

            const isCtrl = e.ctrlKey || e.metaKey;
            const isShift = e.shiftKey;

            let newSelectedFileIds: string[] = [];
            const allFileIds = topicImages.map(f => f.id);

            if (isCtrl) {
                // Toggle
                if ((selectedFileIds || []).includes(id)) {
                    newSelectedFileIds = (selectedFileIds || []).filter(fid => fid !== id);
                } else {
                    newSelectedFileIds = [...(selectedFileIds || []), id];
                }
                // Notify parent and set lastSelectedId
                onSelectFiles(newSelectedFileIds, id);
                return;
            } else if (isShift) {
                // Range selection using lastSelectedId (from props)
                let lastId = lastSelectedId;
                if (!lastId) {
                    lastId = (selectedFileIds && selectedFileIds.length > 0) ? selectedFileIds[0] : id;
                }

                const lastIndex = allFileIds.indexOf(lastId!);
                const currentIndex = allFileIds.indexOf(id);

                if (lastIndex !== -1 && currentIndex !== -1) {
                    const start = Math.min(lastIndex, currentIndex);
                    const end = Math.max(lastIndex, currentIndex);
                    newSelectedFileIds = allFileIds.slice(start, end + 1);
                } else {
                    newSelectedFileIds = [id];
                }
                onSelectFiles(newSelectedFileIds, id);
                return;
            } else {
                // Normal click
                newSelectedFileIds = [id];
                onSelectFiles(newSelectedFileIds, id);
                return;
            }
        };

        // Aggregate people for main topics (include descendant subtopics). For subtopics, keep direct people only.
        let topicPeople = currentTopic.peopleIds.map(id => people[id]).filter(Boolean);
        // Map personId -> number of descendant subtopics (excluding current topic)
        const peopleSubtopicCount: Record<string, number> = {};
        if (!currentTopic.parentId && topics) {
            const stack: string[] = [currentTopic.id];
            const collected = new Set<string>();
            while (stack.length > 0) {
                const tid = stack.pop()!;
                const t = topics[tid];
                if (!t) continue;
                (t.peopleIds || []).forEach(pid => collected.add(pid));
                if (tid !== currentTopic.id) {
                    (t.peopleIds || []).forEach(pid => {
                        peopleSubtopicCount[pid] = (peopleSubtopicCount[pid] || 0) + 1;
                    });
                }
                Object.values(topics).forEach(sub => {
                    if (sub.parentId === tid) stack.push(sub.id);
                });
            }
            topicPeople = Array.from(collected).map(id => people[id]).filter(Boolean);
        }
        const allSubTopicIds = sortedSubTopics.map(t => t.id);
        const backgroundFile = currentTopic.backgroundFileId ? files[currentTopic.backgroundFileId] : null;
        const heroUrl = backgroundFile ? convertFileSrc(backgroundFile.path) : getCoverUrl(currentTopic);

        return (
            <div
                id="topic-gallery-container"
                ref={setRefs}
                className="h-full overflow-y-auto bg-white dark:bg-gray-900"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onContextMenu={(e) => handleContextMenu(e)}
            >
                {/* Header / Hero */}
                <div className="relative h-64 md:h-80 w-full overflow-hidden">
                    {/* Background */}
                    <div className="absolute inset-0">
                        {heroUrl ? (
                            <div className="absolute inset-0 bg-cover bg-center blur-sm scale-110 opacity-50" style={{ backgroundImage: `url("${heroUrl}")` }} />
                        ) : (
                            <div className="absolute inset-0 bg-gradient-to-r from-slate-900 to-slate-800" />
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-white dark:from-gray-900 via-transparent to-transparent" />
                    </div>

                    <div className="absolute bottom-6 left-6 right-6 z-10 flex flex-col md:flex-row items-end justify-between">
                        <div>
                            <h1 className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white mb-2 font-serif tracking-tight">
                                {currentTopic.name}
                            </h1>
                            <p className="text-gray-600 dark:text-gray-300 max-w-2xl line-clamp-2">
                                {currentTopic.description || t('sidebar.noDescription')}
                            </p>
                        </div>
                        {currentTopic.sourceUrl && (
                            <a
                                href={currentTopic.sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="flex items-center text-blue-500 hover:text-blue-400 mt-2 md:mt-0 bg-white/10 backdrop-blur-md px-3 py-1 rounded-full text-sm"
                            >
                                <ExternalLink size={14} className="mr-1" />
                                Source
                            </a>
                        )}
                    </div>
                </div>

                <div className="w-full px-6 py-8 space-y-12">

                    {/* Sub Topics */}
                    {!currentTopic.parentId && (
                        <section>
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="text-xl font-bold flex items-center dark:text-gray-200">
                                    <Folder className="mr-2 text-yellow-500" />
                                    {t('context.subTopics') || 'Sub Topics'}
                                </h3>
                                <div className="flex items-center space-x-3">
                                    <div className="relative topic-sort-container">
                                        <button
                                            onClick={() => setShowTopicSortMenu(!showTopicSortMenu)}
                                            className={`flex items-center space-x-1 text-sm font-medium transition ${showTopicSortMenu ? 'text-blue-500' : 'text-gray-500 hover:text-blue-400'}`}
                                            title={t('sort.sortBy')}
                                        >
                                            <ArrowDownUp size={14} />
                                            <span>{topicSortMode === 'name' ? t('sort.name') : t('sort.date')}</span>
                                        </button>
                                        {showTopicSortMenu && (
                                            <div className="absolute right-0 mt-2 w-40 bg-white dark:bg-gray-800 rounded-lg shadow-xl border border-gray-200 dark:border-gray-700 py-1 z-30">
                                                <button
                                                    onClick={() => toggleSortMode('name')}
                                                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
                                                >
                                                    <span className="text-xs">{t('sort.name')}</span>
                                                    {topicSortMode === 'name' && <Check size={12} className="text-blue-500" />}
                                                </button>
                                                <button
                                                    onClick={() => toggleSortMode('time')}
                                                    className="w-full px-4 py-2 text-left hover:bg-gray-50 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
                                                >
                                                    <span className="text-xs">{t('sort.date')}</span>
                                                    {topicSortMode === 'time' && <Check size={12} className="text-blue-500" />}
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <button onClick={handleCreateTopic} className="text-sm text-blue-500 hover:text-blue-400 font-medium">
                                        + {t('context.newTopic')}
                                    </button>
                                </div>
                            </div>

                            {sortedSubTopics.length > 0 ? (() => {
                                const subSafeWidth = containerRect.width > 0 ? containerRect.width : 1280;
                                const subAvailableWidth = Math.max(100, subSafeWidth - 48); // px-6 * 2
                                const subGap = 32; // Use same GAP_X as main gallery
                                const subGapY = 20; // vertical gap between subtopic rows (reduced)
                                const ASPECT = 0.75;

                                const subItemHeight = coverHeight;
                                const subItemWidth = subItemHeight * ASPECT;
                                const subCols = Math.max(1, Math.floor((subAvailableWidth + subGap) / (subItemWidth + subGap)));

                                const subTotalGridWidth = subCols * subItemWidth + (subCols - 1) * subGap;

                                const subTextAreaHeight = 64;
                                const subTotalItemHeight = subItemHeight + subTextAreaHeight;

                                const subRows = Math.ceil(sortedSubTopics.length / subCols);
                                const subTotalHeight = subRows * subTotalItemHeight + Math.max(0, subRows - 1) * subGapY; // Use GAP_Y = subGapY

                                return (
                                    <div className="relative w-full transition-all duration-300 ease-out" style={{ height: subTotalHeight }}>
                                        {sortedSubTopics.map((sub, index) => {
                                            const subCoverStyle = getCoverStyle(sub);
                                            const row = Math.floor(index / subCols);
                                            const col = index % subCols;
                                            const x = col * (subItemWidth + subGap);
                                            const y = row * (subTotalItemHeight + subGapY);

                                            return (
                                                <div
                                                    key={sub.id}
                                                    className={`topic-item group/sub flex flex-col cursor-pointer absolute transition-all duration-300 ease-out`}
                                                    data-topic-id={sub.id}
                                                    style={{
                                                        zIndex: selectedTopicIds.includes(sub.id) ? 10 : 0,
                                                        left: x,
                                                        top: y,
                                                        width: subItemWidth
                                                    }}
                                                    onMouseDown={(e) => e.stopPropagation()}
                                                    onClick={(e) => handleTopicClick(e, sub.id, allSubTopicIds)}
                                                    onDoubleClick={(e) => handleTopicDoubleClick(e, sub.id)}
                                                    onContextMenu={(e) => handleContextMenu(e, sub.id)}
                                                >
                                                    <div className={`relative aspect-[3/4] w-full transform transition-transform duration-300 origin-center group-hover:scale-105 rounded-xl ${selectedTopicIds.includes(sub.id) ? 'ring-4 ring-blue-500 ring-offset-0 dark:ring-offset-0 shadow-blue-500/20' : ''}`}>
                                                        <div className="absolute inset-0 rounded-xl overflow-hidden shadow-lg border border-gray-100 dark:border-gray-800 bg-gray-200 dark:bg-gray-800">
                                                            {subCoverStyle ? (
                                                                <div className="w-full h-full overflow-hidden">
                                                                    <div className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover/sub:scale-110 origin-center" style={subCoverStyle} />
                                                                </div>
                                                            ) : (
                                                                <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600">
                                                                    <Layout size={32} className="text-white opacity-50" />
                                                                </div>
                                                            )}

                                                            {/* 类型角标（可选） */}
                                                            {sub.type && sub.type.trim() ? (
                                                                <div className="absolute top-3 right-3">
                                                                    <span className="text-xs border border-white/30 rounded-full px-2 py-0.5 backdrop-blur-sm bg-black/20 text-white">
                                                                        {sub.type.length > 12 ? `${sub.type.slice(0, 12)}…` : sub.type}
                                                                    </span>
                                                                </div>
                                                            ) : null}
                                                        </div>
                                                    </div>

                                                    <div className="mt-2 text-center px-1">
                                                        <h4 className="font-serif font-bold text-lg text-gray-900 dark:text-gray-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                                            {sub.name}
                                                        </h4>
                                                        <div className="flex items-center justify-center text-xs text-gray-500 mt-1 space-x-3">
                                                            <span className="flex items-center"><User size={12} className="mr-1" /> {sub.peopleIds.length}</span>
                                                            <span className="flex items-center"><Folder size={12} className="mr-1" /> {sub.fileIds?.length || 0}</span>
                                                        </div>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })() : (
                                <div className="text-sm text-gray-400 italic">No sub-topics yet.</div>
                            )}
                        </section>
                    )}

                    {/* People */}
                    <section>
                        <h3 className="text-xl font-bold flex items-center mb-4 dark:text-gray-200">
                            <User className="mr-2 text-purple-500" />
                            {t('context.people') || 'People'}
                        </h3>
                        {topicPeople.length > 0 ? (() => {
                            // Match the "Files" grid behavior: fixed padding + fixed gap + smooth layout transition
                            const ITEM_SIZE = 120;
                            const PADDING_X = 20;
                            const GAP_X = 20;
                            const GAP_Y = 36;
                            const ITEM_HEIGHT = ITEM_SIZE + 28; // avatar + name/spacing

                            const safeWidth = containerRect.width > 0 ? containerRect.width : 1280;
                            const availableWidth = Math.max(100, safeWidth - PADDING_X * 2);
                            const cols = Math.max(1, Math.floor((availableWidth + GAP_X) / (ITEM_SIZE + GAP_X)));
                            const rows = Math.ceil(topicPeople.length / cols);
                            const totalHeight = rows * ITEM_HEIGHT + Math.max(0, rows - 1) * GAP_Y;

                            return (
                                <div className="relative w-full transition-all duration-300 ease-out" style={{ height: totalHeight }}>
                                    {topicPeople.map((p, index) => {
                                        const coverFile = files[p.coverFileId];
                                        const subCount = peopleSubtopicCount && (peopleSubtopicCount[p.id] || 0);

                                        const row = Math.floor(index / cols);
                                        const col = index % cols;
                                        const x = PADDING_X + col * (ITEM_SIZE + GAP_X);
                                        const y = row * (ITEM_HEIGHT + GAP_Y);

                                        return (
                                            <div
                                                key={p.id}
                                                className="absolute transition-all duration-300 ease-out person-item"
                                                data-person-id={p.id}
                                                style={{ left: x, top: y, width: ITEM_SIZE }}
                                            >
                                                <div
                                                    className="group/person flex flex-col items-center gap-2 cursor-pointer"
                                                    title={p.name}
                                                    onClick={(e) => handlePersonClickLocal(p.id, e)}
                                                    onContextMenu={(e) => handlePersonContextMenu(e, p.id)}
                                                >
                                                    <div className={`relative w-[120px] h-[120px] rounded-full bg-gray-100 dark:bg-gray-800 border-2 border-transparent group-hover/person:border-blue-500/50 transition-all shadow-md ${((selectedPersonIds || []).includes(p.id)) ? 'ring-4 ring-blue-500 ring-offset-0' : (clickedOncePerson === p.id ? 'ring-4 ring-blue-500 ring-offset-0' : '')}`}>
                                                        <div className="relative w-full h-full rounded-full overflow-hidden">
                                                            <div className="w-full h-full transition-transform duration-500 group-hover/person:scale-110">
                                                                {coverFile ? (
                                                                    p.faceBox ? (
                                                                        <img
                                                                            src={convertFileSrc(coverFile.path)}
                                                                            className="absolute max-w-none"
                                                                            decoding="async"
                                                                            style={{
                                                                                width: `${10000 / Math.min(p.faceBox.w, 99.9)}%`,
                                                                                height: `${10000 / Math.min(p.faceBox.h, 99.9)}%`,
                                                                                left: 0,
                                                                                top: 0,
                                                                                transformOrigin: 'top left',
                                                                                transform: `translate3d(${-p.faceBox.x}%, ${-p.faceBox.y}%, 0)`,
                                                                            }}
                                                                        />
                                                                    ) : (
                                                                        <img
                                                                            src={convertFileSrc(coverFile.path)}
                                                                            className="w-full h-full object-cover"
                                                                        />
                                                                    )
                                                                ) : (
                                                                    <User className="w-full h-full p-6 text-gray-400" />
                                                                )}
                                                            </div>
                                                        </div>

                                                        {subCount > 1 && (
                                                            <div className="absolute -top-2 -right-2 bg-blue-600 text-white text-xs font-bold rounded-full w-8 h-8 flex items-center justify-center shadow-lg border-2 border-white dark:border-gray-900 opacity-0 group-hover/person:opacity-100 transform scale-90 group-hover/person:scale-100 transition-all duration-150 pointer-events-none">
                                                                {subCount}
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="text-sm font-bold dark:text-gray-200 truncate text-center w-full group-hover/person:text-blue-500 transition-colors">{p.name}</div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            );
                        })() : (
                            <div className="text-sm text-gray-400 italic">No people added.</div>
                        )}
                    </section>

                    {/* Files Grid (Simplistic for now) */}
                    <section className="files-section">
                        <div className="flex justify-between items-center mb-4">
                            <h3 className="text-xl font-bold flex items-center dark:text-gray-200">
                                <Image className="mr-2 text-green-500" />
                                {t('context.files') || 'Gallery'}
                            </h3>
                            {/* Topic layout controls: hidden when parent provides external control */}
                            {!onTopicLayoutModeChange && (
                                <div className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                                    <button
                                        className={`p-1.5 rounded-md transition-all ${(/* use internal state */ layoutMode) === 'grid' ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                                        onClick={() => { setLayoutMode('grid'); localStorage.setItem('aurora_topic_layout_mode', 'grid'); }}
                                        title={t('view.grid') || "网格视图"}
                                    >
                                        <Grid3X3 size={16} />
                                    </button>
                                    <button
                                        className={`p-1.5 rounded-md transition-all ${(/* use internal state */ layoutMode) === 'adaptive' ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                                        onClick={() => { setLayoutMode('adaptive'); localStorage.setItem('aurora_topic_layout_mode', 'adaptive'); }}
                                        title={t('view.adaptive') || "自适应视图"}
                                    >
                                        <Rows size={16} />
                                    </button>
                                    <button
                                        className={`p-1.5 rounded-md transition-all ${(/* use internal state */ layoutMode) === 'masonry' ? 'bg-white dark:bg-gray-700 text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                                        onClick={() => { setLayoutMode('masonry'); localStorage.setItem('aurora_topic_layout_mode', 'masonry'); }}
                                        title={t('view.masonry') || '瀑布流视图'}
                                    >
                                        <Columns size={16} />
                                    </button>
                                </div>
                            )}

                            {/* When parent controls layout, we still render the grid using external mode */}
                        </div>

                        {topicImages.length > 0 ? (
                            <TopicFileGrid
                                fileIds={topicImages.map(f => f.id)}
                                files={files}
                                layoutMode={topicLayoutMode ?? layoutMode}
                                containerWidth={containerRect.width}
                                selectedFileIds={selectedFileIds}
                                onFileClick={handleFileClickLocal}
                                onOpenFile={handleOpenFileLocal}
                                onContextMenu={handleFileContextMenu}
                                resourceRoot={resourceRoot}
                                cachePath={cachePath}
                            />
                        ) : (
                            <div className="text-sm text-gray-400 italic">No images in this topic.</div>
                        )}
                    </section>
                </div>

                {/* Selection Box */}
                <div
                    ref={selectionOverlayRef}
                    className="absolute pointer-events-none border-2 border-blue-500 bg-blue-500/10 z-50 hidden"
                    style={{ display: 'none', left: 0, top: 0 }}
                />            </div>
        );
    };

    // Render context menu
    const renderContextMenu = () => {
        if (!contextMenu) return null;

        const menu = (
            <div
                ref={contextMenuRef}
                className="context-menu fixed bg-white dark:bg-gray-800 shadow-lg rounded-lg border border-gray-200 dark:border-gray-800 py-1 z-50 min-w-[200px]"
                style={{
                    left: contextMenu.x,
                    top: contextMenu.y,
                    visibility: 'hidden' // Hidden until positioned by useEffect
                }}
                onClick={(e) => e.stopPropagation()}
            >
                {contextMenu.type === 'blank' && (
                    <button
                        className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center text-gray-700 dark:text-gray-200"
                        onClick={handleCreateTopic}
                    >
                        <Plus size={16} className="mr-3" />
                        {t('context.newTopic')}
                    </button>
                )}

                {contextMenu.type === 'single' && contextMenu.topicId && (
                    <>
                        <button
                            className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center text-gray-700 dark:text-gray-200"
                            onClick={() => handleOpenInNewTab(contextMenu.topicId!)}
                        >
                            <ExternalLinkIcon size={16} className="mr-3" />
                            {t('context.openInNewTab') || '在新标签页中打开'}
                        </button>
                        <button
                            className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center text-gray-700 dark:text-gray-200"
                            onClick={() => handleSetCover(contextMenu.topicId!)}
                        >
                            <FileImage size={16} className="mr-3" />
                            {t('context.setCover') || '设置专题封面'}
                        </button>
                        <button
                            className="w-full px-4 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center text-gray-700 dark:text-gray-200"
                            onClick={() => handleRename(contextMenu.topicId!)}
                        >
                            <Edit2 size={16} className="mr-3" />
                            {t('context.rename') || '重命名'}
                        </button>
                        <div className="border-t border-gray-200 dark:border-gray-800 my-1"></div>
                        <button
                            className="w-full px-4 py-2 text-left hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center text-red-600 dark:text-red-400"
                            onClick={() => handleDelete([contextMenu.topicId!])}
                        >
                            <Trash2 size={16} className="mr-3" />
                            {t('context.delete') || '删除'}
                        </button>
                    </>
                )}

                {contextMenu.type === 'person' && contextMenu.personId && (
                    <>
                        <div className="w-full px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer flex items-center text-gray-700 dark:text-gray-200" onClick={() => { if (onOpenPersonInNewTab) onOpenPersonInNewTab(contextMenu.personId!); else onNavigatePerson && onNavigatePerson(contextMenu.personId!); setContextMenu(null); }}>
                            <ExternalLinkIcon size={14} className="mr-3" /> {t('context.openInNewTab')}
                        </div>
                        <div className="w-full px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer flex items-center text-red-600 dark:text-red-400" onClick={() => { removePeopleFromCurrentTopic([contextMenu.personId!]); }}>
                            <Trash2 size={14} className="mr-3" /> {t('context.removeFromTopic') || '从专题中移除'}
                        </div>
                    </>
                )}

                {contextMenu.type === 'multiplePerson' && (
                    <div className="w-full px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer flex items-center text-red-600 dark:text-red-400" onClick={() => { removePeopleFromCurrentTopic(selectedPersonIds || []); }}>
                        <Trash2 size={14} className="mr-3" /> {t('context.removeFromTopic') || '从专题中移除'}
                    </div>
                )}

                {contextMenu.type === 'file' && contextMenu.fileId && (
                    <>
                        <div className="w-full px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer flex items-center text-gray-700 dark:text-gray-200" onClick={() => { if (onOpenFileInNewTab) { handleOpenInNewTabLocal(contextMenu.fileId!); } else { handleOpenFileLocal(contextMenu.fileId!); } setContextMenu(null); }}>
                            <ExternalLinkIcon size={14} className="mr-3" /> {t('context.openInNewTab')}
                        </div>
                        <div className={`px-4 py-2 flex items-center ${(() => { const file = currentTopic && currentTopic.fileIds ? files[contextMenu.fileId!] : null; const parentId = file ? file.parentId : null; const isUnavailable = parentId == null; return isUnavailable ? 'text-gray-400 cursor-default' : 'hover:bg-blue-600 dark:hover:bg-blue-700 hover:text-white cursor-pointer'; })()}`} onClick={() => { const file = files[contextMenu.fileId!]; const parentId = file ? file.parentId : null; if (parentId) handleOpenFolderLocal(parentId, contextMenu.fileId!); setContextMenu(null); }}>
                            <FolderOpen size={14} className="mr-3 opacity-70" />
                            {t('context.openFolder')}
                        </div>
                        <div className="w-full px-4 py-2 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer flex items-center text-gray-700 dark:text-gray-200" onClick={() => {
                            if (currentTopicId) {
                                onUpdateTopic(currentTopicId, { backgroundFileId: contextMenu.fileId });
                                if (onShowToast) onShowToast(t('context.setAsBackgroundSuccess') || '已设置为专题背景');
                            }
                            setContextMenu(null);
                        }}>
                            <FileImage size={14} className="mr-3" /> {t('context.setAsBackground') || '设置为专题背景'}
                        </div>
                        <div className="border-t border-gray-200 dark:border-gray-800 my-1"></div>
                        <div className="w-full px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer flex items-center text-red-600 dark:text-red-400" onClick={() => { removeFilesFromCurrentTopic([contextMenu.fileId!]); }}>
                            <Trash2 size={14} className="mr-3" /> {t('context.removeFromTopic') || '从专题中移除'}
                        </div>
                    </>
                )}

                {contextMenu.type === 'multipleFile' && (
                    <div className="w-full px-4 py-2 hover:bg-red-50 dark:hover:bg-red-900/20 cursor-pointer flex items-center text-red-600 dark:text-red-400" onClick={() => { removeFilesFromCurrentTopic(selectedFileIds || []); }}>
                        <Trash2 size={14} className="mr-3" /> {t('context.removeFromTopic') || '从专题中移除'}
                    </div>
                )}

                {contextMenu.type === 'multiple' && (
                    <button
                        className="w-full px-4 py-2 text-left hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center text-red-600 dark:text-red-400"
                        onClick={() => handleDelete(selectedTopicIds)}
                    >
                        <Trash2 size={16} className="mr-3" />
                        {t('context.delete') || '删除'}
                    </button>
                )}
            </div>
        );

        // Render via portal so it doesn't get clipped by scrollable containers
        return createPortal(menu, document.body);
    };
    return (
        <>
            {currentTopicId ? renderDetail() : renderGallery()}
            {renderContextMenu()}

            {/* Create Topic Modal */}
            {showCreateModal && (
                <CreateTopicModal
                    onClose={() => setShowCreateModal(false)}
                    onCreate={handleCreateTopicWithName}
                    t={t}
                />
            )}

            {/* Rename Topic Modal */}
            {showRenameModal && currentEditingTopic && (
                <RenameTopicModal
                    topic={currentEditingTopic}
                    onClose={() => {
                        setShowRenameModal(false);
                        setCurrentEditingTopic(null);
                    }}
                    onRename={(name, type) => {
                        onUpdateTopic(currentEditingTopic.id, { name, ...(typeof type === 'string' ? { type } : {}) });
                        setShowRenameModal(false);
                        setCurrentEditingTopic(null);
                    }}
                    t={t}
                />
            )}

            {/* Set Cover Modal */}
            {showCoverModal && currentEditingTopic && (
                <SetCoverModal
                    topic={currentEditingTopic}
                    topics={topics}
                    files={files}
                    resourceRoot={resourceRoot}
                    cachePath={cachePath}
                    onClose={() => {
                        setShowCoverModal(false);
                        setCurrentEditingTopic(null);
                    }}
                    onSetCover={(fileId, cropData) => {
                        onUpdateTopic(currentEditingTopic.id, { coverFileId: fileId, coverCrop: cropData });
                        setShowCoverModal(false);
                        setCurrentEditingTopic(null);
                    }}
                    t={t}
                />
            )}

            {/* Delete Confirmation Modal */}
            {showDeleteConfirm && (
                <DeleteConfirmModal
                    count={deleteTargetIds.length}
                    onClose={() => {
                        setShowDeleteConfirm(false);
                        setDeleteTargetIds([]);
                    }}
                    onConfirm={confirmDelete}
                    t={t}
                />
            )}
        </>
    );
};

// Modal Components

interface CreateTopicModalProps {
    onClose: () => void;
    onCreate: (name: string, type?: string) => void;
    t: (key: string) => string;
}

const CreateTopicModal: React.FC<CreateTopicModalProps> = ({ onClose, onCreate, t }) => {
    const [name, setName] = useState('');
    // 默认类型�?TOPIC
    const [type, setType] = useState('TOPIC');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmed = name.trim();
        if (trimmed) {
            onCreate(trimmed, type.trim().slice(0, 12));
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">
                    {t('context.newTopic')}
                </h3>
                <form onSubmit={handleSubmit}>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('context.topicNamePlaceholder') || '请输入专题名称'}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg mb-3 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        autoFocus
                    />

                    <div className="mb-4">
                        <label className="text-sm text-gray-600 dark:text-gray-300 mb-1 block">{t('context.type') || '类型 (最�?2�?'}</label>
                        <input
                            type="text"
                            value={type}
                            maxLength={12}
                            onChange={(e) => setType(e.target.value.slice(0, 12))}
                            placeholder={t('context.typePlaceholder') || '请输入类型（最�?2字）'}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        />
                        <div className="text-xs text-gray-400 mt-1">{type.length}/12</div>
                    </div>

                    <div className="flex justify-end space-x-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
                        >
                            {t('context.cancel') || '取消'}
                        </button>
                        <button
                            type="submit"
                            disabled={!name.trim()}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {t('context.create') || '创建'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

interface RenameTopicModalProps {
    topic: Topic;
    onClose: () => void;
    // onRename now accepts optional `type` (max 12 chars)
    onRename: (name: string, type?: string) => void;
    t: (key: string) => string;
}

const RenameTopicModal: React.FC<RenameTopicModalProps> = ({ topic, onClose, onRename, t }) => {
    const [name, setName] = useState(topic.name);
    const [type, setType] = useState<string>(topic.type || '');

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        const trimmedName = name.trim();
        const trimmedType = type.trim().slice(0, 12);
        if (trimmedName && (trimmedName !== topic.name || trimmedType !== (topic.type || ''))) {
            onRename(trimmedName, trimmedType);
        }
    };

    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-xl font-bold mb-4 text-gray-900 dark:text-white">
                    {t('context.rename') || '重命名'}
                </h3>
                <form onSubmit={handleSubmit}>
                    <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder={t('context.topicNamePlaceholder') || '请输入专题名称'}
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg mb-3 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        autoFocus
                    />

                    {/* 新增：类型字段（最�?2字） */}
                    <div className="mb-4">
                        <label className="text-sm text-gray-600 dark:text-gray-300 mb-1 block">{t('context.type') || '类型 (最�?2�?'}</label>
                        <input
                            type="text"
                            value={type}
                            maxLength={12}
                            onChange={(e) => setType(e.target.value.slice(0, 12))}
                            placeholder={t('context.typePlaceholder') || '请输入类型（最�?2字）'}
                            className="w-full px-3 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                        />
                        <div className="text-xs text-gray-400 mt-1">{type.length}/12</div>
                    </div>

                    <div className="flex justify-end space-x-3">
                        <button
                            type="button"
                            onClick={onClose}
                            className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
                        >
                            {t('context.cancel') || '取消'}
                        </button>
                        <button
                            type="submit"
                            disabled={!name.trim() || (name.trim() === topic.name && type.trim() === (topic.type || ''))}
                            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                            {t('context.confirm') || '确认'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

interface DeleteConfirmModalProps {
    count: number;
    onClose: () => void;
    onConfirm: () => void;
    t: (key: string) => string;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({ count, onClose, onConfirm, t }) => {
    return (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={onClose}>
            <div className="bg-white dark:bg-gray-800 rounded-lg p-6 w-96 shadow-xl" onClick={(e) => e.stopPropagation()}>
                <div className="flex items-center mb-4">
                    <div className="w-12 h-12 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center mr-4">
                        <Trash2 className="text-red-600 dark:text-red-400" size={24} />
                    </div>
                    <h3 className="text-xl font-bold text-gray-900 dark:text-white">
                        {t('context.confirmDelete') || '确认删除'}
                    </h3>
                </div>
                <p className="text-gray-600 dark:text-gray-300 mb-6">
                    {count === 1
                        ? (t('context.deleteTopicWarning') || '确定要删除这个专题吗？此操作无法撤销。')
                        : (t('context.deleteTopicsWarning') || `确定要删除这 ${count} 个专题吗？此操作无法撤销。`)}
                </p>
                <div className="flex justify-end space-x-3">
                    <button
                        onClick={onClose}
                        className="px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
                    >
                        {t('context.cancel') || '取消'}
                    </button>
                    <button
                        onClick={onConfirm}
                        className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition"
                    >
                        {t('context.delete') || '删除'}
                    </button>
                </div>
            </div>
        </div>
    );
};

interface SetCoverModalProps {
    topic: Topic;
    topics: Record<string, Topic>;
    files: Record<string, FileNode>;
    resourceRoot?: string;
    cachePath?: string;
    onClose: () => void;
    onSetCover: (fileId: string, cropData: CoverCropData) => void;
    t: (key: string) => string;
}

const SetCoverModal: React.FC<SetCoverModalProps> = ({ topic, topics, files, resourceRoot, cachePath, onClose, onSetCover, t }) => {
    const [selectedFileId, setSelectedFileId] = useState<string | null>(() => {
        if (topic.coverFileId) return topic.coverFileId;
        if (topic.fileIds?.length) {
            for (const id of topic.fileIds) {
                if (files[id]?.type === FileType.IMAGE) return id;
            }
        }
        return null;
    });
    const [searchQuery, setSearchQuery] = useState('');
    const [scale, setScale] = useState(1);
    const [position, setPosition] = useState({ x: 0, y: 0 });
    const [isDragging, setIsDragging] = useState(false);
    const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
    const imgRef = useRef<HTMLImageElement>(null);
    const containerRef = useRef<HTMLDivElement>(null);

    // 定义裁剪区域尺寸
    const VIEWPORT_SIZE = 500;
    const CROP_WIDTH = 300;  // 3:4 ratio
    const CROP_HEIGHT = 400;
    const OFFSET_X = (VIEWPORT_SIZE - CROP_WIDTH) / 2;
    const OFFSET_Y = (VIEWPORT_SIZE - CROP_HEIGHT) / 2;

    // Get all images from this topic
    const topicImages = (topic.fileIds || [])
        .map(id => files[id])
        .filter(f => f && f.type === FileType.IMAGE);

    // Group by sub-topic if this is a parent topic
    const imageGroups: { name: string; images: FileNode[] }[] = [];

    if (!topic.parentId) {
        // This is a parent topic, group by sub-topics
        const subTopics = Object.values(topics).filter(t => t.parentId === topic.id);

        // Images directly in parent topic
        const directImages = topicImages.filter(img => {
            return !subTopics.some(sub => sub.fileIds?.includes(img.id));
        });

        if (directImages.length > 0) {
            imageGroups.push({ name: topic.name, images: directImages });
        }

        // Images in each sub-topic
        subTopics.forEach(sub => {
            const subImages = (sub.fileIds || [])
                .map(id => files[id])
                .filter(f => f && f.type === FileType.IMAGE);
            if (subImages.length > 0) {
                imageGroups.push({ name: sub.name, images: subImages });
            }
        });
    } else {
        // This is a sub-topic, just show all images
        imageGroups.push({ name: topic.name, images: topicImages });
    }

    // Filter by search query
    const filteredGroups = imageGroups.map(group => ({
        ...group,
        images: group.images.filter(img =>
            img.name.toLowerCase().includes(searchQuery.toLowerCase())
        )
    })).filter(group => group.images.length > 0);

    const selectedFile = selectedFileId ? files[selectedFileId] : null;

    // 处理图片加载
    const handleImageLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
        const img = e.currentTarget;
        // 计算最小缩放比例，确保图片能覆盖整个裁剪框
        const minScaleX = CROP_WIDTH / img.naturalWidth;
        const minScaleY = CROP_HEIGHT / img.naturalHeight;
        const initialScale = Math.max(minScaleX, minScaleY, 0.5);

        // 居中显示
        const initialPosition = {
            x: (VIEWPORT_SIZE - img.naturalWidth * initialScale) / 2,
            y: (VIEWPORT_SIZE - img.naturalHeight * initialScale) / 2
        };

        setScale(initialScale);
        setPosition(initialPosition);
    };

    // 处理鼠标按下开始拖�?
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        e.preventDefault();
        setIsDragging(true);
        setDragStart({ x: e.clientX - position.x, y: e.clientY - position.y });
    }, [position]);

    // 处理鼠标移动拖拽
    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (isDragging && imgRef.current) {
            let newX = e.clientX - dragStart.x;
            let newY = e.clientY - dragStart.y;

            const w = imgRef.current.naturalWidth * scale;
            const h = imgRef.current.naturalHeight * scale;

            // 计算边界限制
            const minX = OFFSET_X + CROP_WIDTH - w;
            const maxX = OFFSET_X;
            const minY = OFFSET_Y + CROP_HEIGHT - h;
            const maxY = OFFSET_Y;

            // 应用边界限制
            if (newX > maxX) newX = maxX;
            if (newX < minX) newX = minX;
            if (newY > maxY) newY = maxY;
            if (newY < minY) newY = minY;

            setPosition({ x: newX, y: newY });
        }
    }, [isDragging, dragStart, scale]);

    // 处理鼠标释放
    const handleMouseUp = useCallback(() => {
        setIsDragging(false);
    }, []);

    // 处理滚轮缩放
    const handleWheel = useCallback((e: WheelEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!imgRef.current) return;

        const ZOOM_SPEED = 0.1;
        const direction = Math.sign(e.deltaY);
        let newScale = scale;

        if (direction < 0) {
            newScale = scale * (1 + ZOOM_SPEED);
        } else {
            newScale = scale / (1 + ZOOM_SPEED);
        }

        // 计算最小缩�?
        const minScaleX = CROP_WIDTH / imgRef.current.naturalWidth;
        const minScaleY = CROP_HEIGHT / imgRef.current.naturalHeight;
        const minScale = Math.max(minScaleX, minScaleY);
        newScale = Math.max(minScale, Math.min(newScale, 5));

        const w = imgRef.current.naturalWidth * newScale;
        const h = imgRef.current.naturalHeight * newScale;

        let newX = position.x;
        let newY = position.y;

        // 以裁剪框中心为缩放中�?
        const cx = (OFFSET_X + CROP_WIDTH / 2 - position.x) / scale;
        const cy = (OFFSET_Y + CROP_HEIGHT / 2 - position.y) / scale;

        newX = OFFSET_X + CROP_WIDTH / 2 - cx * newScale;
        newY = OFFSET_Y + CROP_HEIGHT / 2 - cy * newScale;

        // 应用边界限制
        const minX = OFFSET_X + CROP_WIDTH - w;
        const maxX = OFFSET_X;
        const minY = OFFSET_Y + CROP_HEIGHT - h;
        const maxY = OFFSET_Y;

        if (newX > maxX) newX = maxX;
        if (newX < minX) newX = minX;
        if (newY > maxY) newY = maxY;
        if (newY < minY) newY = minY;

        setScale(newScale);
        setPosition({ x: newX, y: newY });
    }, [scale, position]);

    // 注册滚轮事件
    useEffect(() => {
        const el = containerRef.current;
        if (el) {
            el.addEventListener('wheel', handleWheel, { passive: false });
            return () => el.removeEventListener('wheel', handleWheel);
        }
    }, [handleWheel]);

    // 处理文件选择
    const handleImageSelect = useCallback((fileId: string) => {
        setSelectedFileId(fileId);
        // 重置缩放和位�?
        setScale(1);
        setPosition({ x: 0, y: 0 });
    }, []);

    // 处理保存
    const handleSave = useCallback(() => {
        if (!imgRef.current || !selectedFileId) return;

        const natW = imgRef.current.naturalWidth;
        const natH = imgRef.current.naturalHeight;

        // 计算裁剪框在原图中的位置和尺寸（百分比）
        const x = (OFFSET_X - position.x) / scale;
        const y = (OFFSET_Y - position.y) / scale;
        const w = CROP_WIDTH / scale;
        const h = CROP_HEIGHT / scale;

        const safeNatW = Math.max(1, natW);
        const safeNatH = Math.max(1, natH);
        const rawXPercent = (x / safeNatW) * 100;
        const rawYPercent = (y / safeNatH) * 100;
        const widthPercent = Math.min(Math.max((w / safeNatW) * 100, 0.1), 100);
        const heightPercent = Math.min(Math.max((h / safeNatH) * 100, 0.1), 100);
        const xPercent = Math.min(Math.max(rawXPercent, 0), Math.max(0, 100 - widthPercent));
        const yPercent = Math.min(Math.max(rawYPercent, 0), Math.max(0, 100 - heightPercent));

        onSetCover(selectedFileId, {
            x: xPercent,
            y: yPercent,
            width: widthPercent,
            height: heightPercent
        });
    }, [selectedFileId, scale, position, onSetCover]);

    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4" onClick={onClose} onMouseUp={handleMouseUp} onMouseLeave={handleMouseUp}>
            <div className="bg-white dark:bg-gray-800 rounded-lg w-full max-w-6xl h-[85vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
                {/* Header */}
                <div className="p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 rounded-t-lg">
                    <h3 className="font-bold text-lg text-gray-900 dark:text-white">
                        {t('context.setCover') || '设置专题封面'}
                    </h3>
                </div>

                {/* Main Content Area */}
                <div className="flex-1 flex flex-row overflow-hidden">
                    {/* Left: Crop Preview - Fixed Width */}
                    <div className="flex-none p-6 flex flex-col items-center justify-center bg-gray-100 dark:bg-black/20 border-r border-gray-200 dark:border-gray-800">
                        <div
                            ref={containerRef}
                            className="relative bg-gray-200 dark:bg-black overflow-hidden cursor-move select-none shadow-lg rounded-lg mb-4"
                            style={{ width: VIEWPORT_SIZE, height: VIEWPORT_SIZE }}
                            onMouseDown={handleMouseDown}
                            onMouseMove={handleMouseMove}
                        >
                            {selectedFile && (
                                <>
                                    <img
                                        ref={imgRef}
                                        src={convertFileSrc(selectedFile.path)}
                                        draggable={false}
                                        onLoad={handleImageLoad}
                                        className="max-w-none absolute origin-top-left pointer-events-none"
                                        style={{
                                            transform: `translate(${position.x}px, ${position.y}px) scale(${scale})`
                                        }}
                                        alt="Cover preview"
                                    />

                                    {/* Crop mask overlay */}
                                    <div className="absolute inset-0 pointer-events-none">
                                        <svg width="100%" height="100%">
                                            <defs>
                                                <mask id="topicCropMask">
                                                    <rect x="0" y="0" width="100%" height="100%" fill="white" />
                                                    <rect x={OFFSET_X} y={OFFSET_Y} width={CROP_WIDTH} height={CROP_HEIGHT} fill="black" rx="8" />
                                                </mask>
                                            </defs>
                                            <rect x="0" y="0" width="100%" height="100%" fill="rgba(0,0,0,0.6)" mask="url(#topicCropMask)" />

                                            <rect
                                                x={OFFSET_X}
                                                y={OFFSET_Y}
                                                width={CROP_WIDTH}
                                                height={CROP_HEIGHT}
                                                fill="none"
                                                stroke="white"
                                                strokeWidth="2"
                                                rx="8"
                                                style={{ filter: 'drop-shadow(0 0 2px rgba(0,0,0,0.5))' }}
                                            />
                                        </svg>
                                    </div>
                                </>
                            )}

                            {!selectedFile && (
                                <div className="absolute inset-0 flex items-center justify-center text-gray-400 text-center">
                                    <div>
                                        <FileImage size={48} className="mx-auto mb-2 opacity-50" />
                                        <p>{t('context.selectImage') || '请选择图片'}</p>
                                    </div>
                                </div>
                            )}
                        </div>

                        <div className="text-xs text-gray-500 text-center bg-white dark:bg-gray-800 px-3 py-1.5 rounded-full shadow-sm border border-gray-200 dark:border-gray-800">
                            {t('context.cropHint') || '拖拽图片调整位置 �?滚轮缩放'}
                        </div>
                    </div>

                    {/* Right: File Selection - Flex 1 */}
                    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-800">
                        <div className="p-4 border-b border-gray-200 dark:border-gray-800">
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder={t('context.searchFiles') || '搜索文件�?..'}
                                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                            />
                        </div>

                        {/* Image Grid */}
                        <div className="flex-1 overflow-y-auto p-4 content-start">
                            {filteredGroups.length === 0 ? (
                                <div className="text-center text-gray-400 py-8 flex flex-col items-center">
                                    <FileImage size={48} className="mb-4 opacity-20" />
                                    <span>{t('context.noImages') || '没有找到图片'}</span>
                                </div>
                            ) : (
                                filteredGroups.map(group => (
                                    <div key={group.name} className="mb-6 last:mb-0">
                                        {!topic.parentId && (
                                            <h5 className="font-bold text-xs uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-3 ml-1">
                                                {group.name}
                                            </h5>
                                        )}
                                        <div className="grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                                            {group.images.map(img => {
                                                const isSelected = selectedFileId === img.id;
                                                return (
                                                    <div
                                                        key={img.id}
                                                        onClick={() => handleImageSelect(img.id)}
                                                        className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all shadow-sm ${isSelected
                                                            ? 'border-blue-500 ring-2 ring-blue-500/30'
                                                            : 'border-transparent hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md'
                                                            }`}
                                                    >
                                                        <div className="relative aspect-square">
                                                            <ImageThumbnail
                                                                src={''}
                                                                alt={img.name}
                                                                isSelected={isSelected}
                                                                filePath={img.path}
                                                                modified={img.updatedAt}
                                                                isHovering={false}
                                                                fileMeta={img.meta}
                                                                resourceRoot={resourceRoot}
                                                                cachePath={cachePath}
                                                            />
                                                            {isSelected && (
                                                                <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center pointer-events-none">
                                                                    <div className="bg-blue-500 rounded-full p-1">
                                                                        <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}>
                                                                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                                                                        </svg>
                                                                    </div>
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="p-2 bg-gray-50 dark:bg-gray-900 border-t border-gray-100 dark:border-gray-800">
                                                            <p className="text-xs text-gray-600 dark:text-gray-300 truncate font-medium">
                                                                {img.name}
                                                            </p>
                                                        </div>
                                                    </div>
                                                );
                                            })}
                                        </div>
                                    </div>
                                ))
                            )}
                        </div>
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900 rounded-b-lg flex items-center justify-between">
                    {/* Zoom Control - Moved to footer */}
                    <div className="flex-1 max-w-xs mr-4">
                        {selectedFile && (
                            <div className="flex items-center space-x-3 bg-white dark:bg-gray-800 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-800">
                                <span className="text-xs font-medium text-gray-500 whitespace-nowrap">{t('context.zoom') || '缩放'}</span>
                                <span className="text-xs text-gray-400 select-none">-</span>
                                <input
                                    type="range"
                                    min="0.1"
                                    max="5"
                                    step="0.01"
                                    value={scale}
                                    onChange={(e) => {
                                        const newScale = parseFloat(e.target.value);
                                        if (imgRef.current) {
                                            const minScaleX = CROP_WIDTH / imgRef.current.naturalWidth;
                                            const minScaleY = CROP_HEIGHT / imgRef.current.naturalHeight;
                                            const minScale = Math.max(minScaleX, minScaleY);
                                            if (newScale >= minScale) setScale(newScale);
                                        } else {
                                            setScale(newScale);
                                        }
                                    }}
                                    className="flex-1 h-1 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-600"
                                />
                                <span className="text-xs text-gray-400 select-none">+</span>
                            </div>
                        )}
                    </div>

                    <div className="flex space-x-3">
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition shadow-sm"
                        >
                            {t('context.cancel') || '取消'}
                        </button>
                        <button
                            onClick={handleSave}
                            disabled={!selectedFileId}
                            className="px-6 py-2 text-sm font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition disabled:opacity-50 disabled:cursor-not-allowed shadow-md hover:shadow-lg transform active:scale-95 duration-100"
                        >
                            {t('context.confirm') || '确认'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};