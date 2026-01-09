import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Topic, FileNode, Person, FileType, CoverCropData } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Image, User, Plus, Trash2, Folder, ExternalLink, ChevronRight, Layout, ArrowLeft, MoreHorizontal, Edit2, FileImage, ExternalLinkIcon, Grid3X3, Rows, Columns } from 'lucide-react';
import { ImageThumbnail } from './FileGrid';

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
    onSelectFiles,
    onOpenFile,
    resourceRoot,
    cachePath 
}: {
    fileIds: string[],
    files: Record<string, FileNode>,
    layoutMode: LayoutMode,
    containerWidth: number,
    selectedFileIds: string[],
    onSelectFiles: (ids: string[]) => void,
    onOpenFile?: (id: string) => void,
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
                
                return (
                    <div 
                        key={file.id} 
                        className="absolute overflow-hidden cursor-pointer group rounded-lg transition-all duration-300"
                        style={{ 
                            left: item.x, 
                            top: item.y, 
                            width: item.width, 
                            height: item.height 
                        }}
                        onMouseDown={(e) => e.stopPropagation()}
                        onClick={(e) => {
                            e.stopPropagation();
                            onSelectFiles([file.id]);
                        }}
                        onDoubleClick={(e) => {
                            e.stopPropagation();
                            onOpenFile?.(file.id);
                        }}
                    >
                        <div className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover:scale-110 overflow-hidden relative">
                            <ImageThumbnail
                                src={''}
                                alt={file.name}
                                isSelected={selectedFileIds.includes(file.id)}
                                filePath={file.path}
                                modified={file.updatedAt}
                                size={undefined}
                                isHovering={false}
                                fileMeta={file.meta}
                                resourceRoot={resourceRoot}
                                cachePath={cachePath}
                            />

                            {/* Hover overlay to restore original hover feedback */}
                            <div className="absolute inset-0 pointer-events-none flex items-end p-2 opacity-0 group-hover:opacity-100 transition-opacity">
                                <div className="w-full bg-black/40 text-white text-xs rounded-md px-2 py-1 backdrop-blur-sm truncate">{file.name}</div>
                            </div>
                        </div>
                    </div>
                );
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
    onNavigateTopic: (topicId: string | null) => void;
    onUpdateTopic: (topicId: string, updates: Partial<Topic>) => void;
    onCreateTopic: (parentId: string | null, name?: string) => void;
    onDeleteTopic: (topicId: string) => void;
    onSelectTopics: (ids: string[]) => void;
    onSelectFiles: (ids: string[]) => void;
    // Optional: resource root and cache path for thumbnail generation
    resourceRoot?: string;
    cachePath?: string;
    // Called to open a file in viewer (double-click)
    onOpenFile?: (fileId: string) => void;
    t: (key: string) => string;
}

export const TopicModule: React.FC<TopicModuleProps> = ({ 
    topics, files, people, currentTopicId, selectedTopicIds, selectedFileIds = [],
    onNavigateTopic, onUpdateTopic, onCreateTopic, onDeleteTopic, onSelectTopics, onSelectFiles,
    resourceRoot, cachePath, onOpenFile, t 
}) => {
    
    // Selection state for box selection
    const [isSelecting, setIsSelecting] = useState(false);
    const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
    const selectionRef = useRef<HTMLDivElement>(null);
    const lastSelectedIdRef = useRef<string | null>(null);
    
    // Context menu state
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number; type: 'blank' | 'single' | 'multiple'; topicId?: string } | null>(null);
    
    // Modal states
    const [showCreateModal, setShowCreateModal] = useState(false);
    const [showRenameModal, setShowRenameModal] = useState(false);
    const [showCoverModal, setShowCoverModal] = useState(false);
    const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
    const [currentEditingTopic, setCurrentEditingTopic] = useState<Topic | null>(null);
    const [deleteTargetIds, setDeleteTargetIds] = useState<string[]>([]);
    
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

    const [coverHeight, setCoverHeight] = useState(350);
    const requestRef = useRef<number | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });
    const [layoutMode, setLayoutMode] = useState<LayoutMode>('grid');

    // Click timer ref for distinguishing click vs dblclick on images
    const clickTimerRef = useRef<number | null>(null);

    useEffect(() => {
        return () => {
            if (clickTimerRef.current) {
                clearTimeout(clickTimerRef.current);
                clickTimerRef.current = null;
            }
        };
    }, []);

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
            // Add slight delay to prevent immediate closing from the same click that opened it
            setTimeout(() => {
                document.addEventListener('click', handleClickOutside);
                document.addEventListener('scroll', handleScroll, true); // Use capture phase for all scroll events
            }, 0);
        }
        
        return () => {
            document.removeEventListener('click', handleClickOutside);
            document.removeEventListener('scroll', handleScroll, true);
        };
    }, [contextMenu]);

    // Handle right-click context menu
    const handleContextMenu = useCallback((e: React.MouseEvent, topicId?: string) => {
        e.preventDefault();
        e.stopPropagation();
        
        if (!topicId) {
            // Clicked on blank area
            setContextMenu({ x: e.clientX, y: e.clientY, type: 'blank' });
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

    // Mouse event handlers for box selection
    const handleMouseDown = useCallback((e: React.MouseEvent) => {
        // Ignore if clicking on a topic item
        if ((e.target as HTMLElement).closest('.topic-item')) {
            return;
        }
        
        if (e.button === 0) { // Left mouse button
            const container = selectionRef.current;
            if (container) {
                const rect = container.getBoundingClientRect();
                const startX = e.clientX - rect.left + container.scrollLeft;
                const startY = e.clientY - rect.top + container.scrollTop;
                setIsSelecting(true);
                setSelectionBox({
                    startX,
                    startY,
                    currentX: startX,
                    currentY: startY
                });
                
                // Clear selection on background click
                onSelectTopics([]);
            }
        }
    }, [onSelectTopics]);

    const handleMouseMove = useCallback((e: React.MouseEvent) => {
        if (!isSelecting || !selectionBox) return;
        
        const container = selectionRef.current;
        if (container) {
            const rect = container.getBoundingClientRect();
            const currentX = e.clientX - rect.left + container.scrollLeft;
            const currentY = e.clientY - rect.top + container.scrollTop;
            
            setSelectionBox(prev => prev ? {
                ...prev,
                currentX,
                currentY
            } : null);
        }
    }, [isSelecting, selectionBox]);

    const handleMouseUp = useCallback((e: React.MouseEvent) => {
        if (!isSelecting || !selectionBox) return;
        
        const container = selectionRef.current;
        if (!container) {
            setIsSelecting(false);
            setSelectionBox(null);
            return;
        }
        
        // Calculate selection box boundaries
        const containerRect = container.getBoundingClientRect();
        const selectionLeft = containerRect.left + (Math.min(selectionBox.startX, selectionBox.currentX) - container.scrollLeft);
        const selectionTop = containerRect.top + (Math.min(selectionBox.startY, selectionBox.currentY) - container.scrollTop);
        const selectionRight = containerRect.left + (Math.max(selectionBox.startX, selectionBox.currentX) - container.scrollLeft);
        const selectionBottom = containerRect.top + (Math.max(selectionBox.startY, selectionBox.currentY) - container.scrollTop);
        
        // Check if selection box is too small
        if (selectionRight - selectionLeft < 5 && selectionBottom - selectionTop < 5) {
            setIsSelecting(false);
            setSelectionBox(null);
            return;
        }
        
        // Get all topic elements and check intersection
        const selectedIds: string[] = [];
        const topicElements = container.querySelectorAll('.topic-item');
        
        topicElements.forEach(element => {
            const id = element.getAttribute('data-topic-id');
            if (id) {
                const rect = element.getBoundingClientRect();
                
                // Check if element overlaps with selection box
                if (rect.left < selectionRight && 
                    rect.right > selectionLeft && 
                    rect.top < selectionBottom && 
                    rect.bottom > selectionTop) {
                    selectedIds.push(id);
                }
            }
        });
        
        onSelectTopics(selectedIds);
        setIsSelecting(false);
        setSelectionBox(null);
    }, [isSelecting, selectionBox, onSelectTopics]);

    // Handle topic click with ctrl/shift support
    const handleTopicClick = useCallback((e: React.MouseEvent, topicId: string, allTopicIds: string[]) => {
        e.stopPropagation();
        
        // Close context menu when clicking on a topic
        setContextMenu(null);
        
        if (e.ctrlKey || e.metaKey) {
            // Ctrl/Cmd+Click: Toggle selection
            if (selectedTopicIds.includes(topicId)) {
                onSelectTopics(selectedTopicIds.filter(id => id !== topicId));
            } else {
                onSelectTopics([...selectedTopicIds, topicId]);
            }
            lastSelectedIdRef.current = topicId;
        } else if (e.shiftKey && lastSelectedIdRef.current) {
            // Shift+Click: Range selection
            const lastIndex = allTopicIds.indexOf(lastSelectedIdRef.current);
            const currentIndex = allTopicIds.indexOf(topicId);
            
            if (lastIndex !== -1 && currentIndex !== -1) {
                const start = Math.min(lastIndex, currentIndex);
                const end = Math.max(lastIndex, currentIndex);
                const rangeIds = allTopicIds.slice(start, end + 1);
                
                // Merge with existing selection
                const newSelection = [...new Set([...selectedTopicIds, ...rangeIds])];
                onSelectTopics(newSelection);
            }
        } else {
            // Normal click: Single selection
            onSelectTopics([topicId]);
            lastSelectedIdRef.current = topicId;
        }
    }, [selectedTopicIds, onSelectTopics]);

    const handleTopicDoubleClick = useCallback((e: React.MouseEvent, topicId: string) => {
        e.stopPropagation();
        onNavigateTopic(topicId);
    }, [onNavigateTopic]);

    // Context menu action handlers
    const handleOpenInNewTab = useCallback((topicId: string) => {
        // TODO: Implement open in new tab functionality
        console.log('Open in new tab:', topicId);
        setContextMenu(null);
    }, []);

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
    
    const handleCreateTopicWithName = useCallback((name: string) => {
        onCreateTopic(currentTopicId, name);
        setShowCreateModal(false);
    }, [currentTopicId, onCreateTopic]);

    const { layoutItems, totalHeight } = useMemo(() => {
        if (currentTopicId) return { layoutItems: [], totalHeight: 0 };
        
        const rootTopics = Object.values(topics).filter(topic => !topic.parentId);
        rootTopics.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

        const GAP_X = 32; // Increased horizontal gap
        const GAP_Y = 48; // Increased vertical gap for title room
        const ASPECT = 0.75;
        
        const width = containerRect.width; 
        
        if (width <= 0) return { layoutItems: [], totalHeight: 0 };
        
        const minItemHeight = coverHeight;
        const minItemWidth = minItemHeight * ASPECT;
        
        const cols = Math.max(1, Math.floor((width + GAP_X) / (minItemWidth + GAP_X)));
        const itemWidth = (width - (cols - 1) * GAP_X) / cols;
        const itemHeight = itemWidth / ASPECT;
        
        const validItems = rootTopics.map((topic, index) => {
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
        
        const rows = Math.ceil(rootTopics.length / cols);
        const height = rows > 0 ? rows * itemHeight + (rows - 1) * GAP_Y : 0;
        
        return { layoutItems: validItems, totalHeight: height };

    }, [topics, currentTopicId, containerRect.width, coverHeight]);

    // View: Topic Gallery (Root)
    const renderGallery = () => {
        const rootTopics = Object.values(topics).filter(topic => !topic.parentId);
        rootTopics.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
        const allTopicIds = rootTopics.map(t => t.id);
        
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
                    <button 
                        onClick={handleCreateTopic}
                        className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center hover:bg-blue-700 transition"
                    >
                        <Plus size={18} className="mr-2" />
                        {t('context.newTopic')}
                    </button>
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
                                className={`topic-item group absolute cursor-pointer perspective-1000`}
                                data-topic-id={topic.id}
                                style={{ 
                                    left: x, 
                                    top: y, 
                                    width: width, 
                                    height: height,
                                    transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)',
                                    zIndex: isSelected ? 10 : 0
                                }}
                                onClick={(e) => handleTopicClick(e, topic.id, allTopicIds)}
                                onDoubleClick={(e) => handleTopicDoubleClick(e, topic.id)}
                                onContextMenu={(e) => handleContextMenu(e, topic.id)}
                            >
                                <div className={`absolute inset-0 transform transition-all duration-300 group-hover:-translate-y-2 group-hover:shadow-2xl rounded-xl ${isSelected ? 'ring-4 ring-blue-500 ring-offset-2 dark:ring-offset-gray-900 shadow-blue-500/20' : ''}`}>
                                    <div className="absolute inset-0 bg-gray-200 dark:bg-gray-800 rounded-xl overflow-hidden border border-gray-100 dark:border-gray-700 shadow-lg">
                                        {coverStyle ? (
                                            <div className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover:scale-105" style={coverStyle} />
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
                                            <p className="text-white/80 text-xs font-medium uppercase tracking-wider mb-1">
                                                {topic.createdAt ? new Date(topic.createdAt).getFullYear() : '2024'} ISSUE
                                            </p>
                                            <div className="flex justify-between items-end text-white">
                                                <div>
                                                    <div className="text-xs opacity-70 flex items-center mb-0.5">
                                                        <User size={10} className="mr-1" /> {personCount}
                                                    </div>
                                                    <div className="text-xs opacity-70 flex items-center">
                                                        <Folder size={10} className="mr-1" /> {subTopicCount}
                                                    </div>
                                                </div>
                                                <span className="text-xs border border-white/30 rounded-full px-2 py-0.5 backdrop-blur-sm">
                                                    READ
                                                </span>
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
                {selectionBox && selectionRef.current && (
                    <div
                        className="absolute pointer-events-none border-2 border-blue-500 bg-blue-500/10 z-50"
                        style={{
                            left: Math.min(selectionBox.startX, selectionBox.currentX) - selectionRef.current.scrollLeft,
                            top: Math.min(selectionBox.startY, selectionBox.currentY) - selectionRef.current.scrollTop,
                            width: Math.abs(selectionBox.currentX - selectionBox.startX),
                            height: Math.abs(selectionBox.currentY - selectionBox.startY),
                        }}
                    />
                )}            </div>
        );
    };

    // View: Topic Detail
    const renderDetail = () => {
        if (!currentTopic) return null;

        const subTopics = Object.values(topics).filter(t => t.parentId === currentTopic.id);
        const topicImages = (currentTopic.fileIds || []).map(id => files[id]).filter(f => f && f.type === FileType.IMAGE);
        const topicPeople = currentTopic.peopleIds.map(id => people[id]).filter(Boolean);
        const allSubTopicIds = subTopics.map(t => t.id);
        const heroUrl = getCoverUrl(currentTopic);

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
                                <button onClick={handleCreateTopic} className="text-sm text-blue-500 hover:text-blue-400 font-medium">
                                    + {t('context.newTopic')}
                                </button>
                             </div>
                             
                             {subTopics.length > 0 ? (
                                 <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                    {subTopics.map(sub => {
                                        const subCoverStyle = getCoverStyle(sub);
                                        return (
                                            <div 
                                                key={sub.id} 
                                                className={`topic-item group flex flex-col cursor-pointer transition-all duration-300`}
                                                data-topic-id={sub.id}
                                                style={{ zIndex: selectedTopicIds.includes(sub.id) ? 10 : 0 }}
                                                onClick={(e) => handleTopicClick(e, sub.id, allSubTopicIds)}
                                                onDoubleClick={(e) => handleTopicDoubleClick(e, sub.id)}
                                                onContextMenu={(e) => handleContextMenu(e, sub.id)}
                                            >
                                                <div className={`relative aspect-[3/4] w-full transform transition-all duration-300 group-hover:-translate-y-2 rounded-xl ${selectedTopicIds.includes(sub.id) ? 'ring-4 ring-blue-500 ring-offset-2 dark:ring-offset-gray-900 shadow-blue-500/20' : ''}`}>
                                                    <div className="absolute inset-0 rounded-xl overflow-hidden shadow-lg border border-gray-100 dark:border-gray-700 bg-gray-200 dark:bg-gray-800">
                                                        {subCoverStyle ? (
                                                            <div className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover:scale-105" style={subCoverStyle} />
                                                        ) : (
                                                            <div className="w-full h-full flex items-center justify-center bg-gradient-to-br from-indigo-500 to-purple-600">
                                                                <Layout size={32} className="text-white opacity-50" />
                                                            </div>
                                                        )}
                                                    </div>
                                                </div>
                                                
                                                <div className="mt-4 text-center px-1">
                                                    <h4 className="font-serif font-bold text-lg text-gray-900 dark:text-gray-100 truncate group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                                                        {sub.name}
                                                    </h4>
                                                    <div className="flex items-center justify-center text-xs text-gray-500 mt-1 space-x-3">
                                                        <span className="flex items-center"><User size={12} className="mr-1"/> {sub.peopleIds.length}</span>
                                                        <span className="flex items-center"><Folder size={12} className="mr-1"/> {sub.fileIds?.length || 0}</span>
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                 </div>
                             ) : (
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
                         {topicPeople.length > 0 ? (
                             <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-4">
                                 {topicPeople.map(p => {
                                      const coverFile = files[p.coverFileId];
                                      const bgStyle = coverFile ? {
                                        backgroundImage: `url("${convertFileSrc(coverFile.path)}")`,
                                        backgroundSize: p.faceBox ? `${10000 / Math.min(p.faceBox.w, 99.9)}% ${10000 / Math.min(p.faceBox.h, 99.9)}%` : 'cover',
                                        backgroundPosition: p.faceBox ? `${p.faceBox.x / (100 - Math.min(p.faceBox.w, 99.9)) * 100}% ${p.faceBox.y / (100 - Math.min(p.faceBox.h, 99.9)) * 100}%` : 'center',
                                      } : {};

                                      return (
                                        <div key={p.id} className="flex items-center space-x-3 bg-gray-50 dark:bg-gray-800 p-2 rounded-lg border border-gray-100 dark:border-gray-700">
                                            <div className="w-10 h-10 rounded-full bg-gray-200 flex-shrink-0 overflow-hidden" style={bgStyle}>
                                                {!coverFile && <User className="w-full h-full p-2 text-gray-400" />}
                                            </div>
                                            <div className="truncate text-sm font-medium dark:text-gray-200">{p.name}</div>
                                        </div>
                                      );
                                 })}
                             </div>
                         ) : (
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
                            <div className="flex items-center space-x-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1">
                                <button 
                                    className={`p-1.5 rounded-md transition-all ${layoutMode === 'grid' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                                    onClick={() => setLayoutMode('grid')}
                                    title={t('view.grid') || "网格视图"}
                                >
                                    <Grid3X3 size={16}/>
                                </button>
                                <button 
                                    className={`p-1.5 rounded-md transition-all ${layoutMode === 'adaptive' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                                    onClick={() => setLayoutMode('adaptive')}
                                    title={t('view.adaptive') || "自适应视图"}
                                >
                                    <Rows size={16}/>
                                </button>
                                <button 
                                    className={`p-1.5 rounded-md transition-all ${layoutMode === 'masonry' ? 'bg-white dark:bg-gray-700 shadow-sm text-blue-600 dark:text-blue-400' : 'text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700'}`}
                                    onClick={() => setLayoutMode('masonry')}
                                    title={t('view.masonry') || "瀑布流视图"}
                                >
                                    <Columns size={16}/>
                                </button>
                            </div>
                        </div>

                        {topicImages.length > 0 ? (
                            <TopicFileGrid 
                                fileIds={topicImages.map(f => f.id)}
                                files={files}
                                layoutMode={layoutMode}
                                containerWidth={containerRect.width}
                                selectedFileIds={selectedFileIds}
                                onSelectFiles={onSelectFiles}
                                onOpenFile={onOpenFile}
                                resourceRoot={resourceRoot}
                                cachePath={cachePath}
                            />
                        ) : (
                            <div className="text-sm text-gray-400 italic">No images in this topic.</div>
                        )}
                     </section>
                </div>
                
                {/* Selection Box */}
                {selectionBox && selectionRef.current && (
                    <div
                        className="absolute pointer-events-none border-2 border-blue-500 bg-blue-500/10 z-50"
                        style={{
                            left: Math.min(selectionBox.startX, selectionBox.currentX) - selectionRef.current.scrollLeft,
                            top: Math.min(selectionBox.startY, selectionBox.currentY) - selectionRef.current.scrollTop,
                            width: Math.abs(selectionBox.currentX - selectionBox.startX),
                            height: Math.abs(selectionBox.currentY - selectionBox.startY),
                        }}
                    />
                )}            </div>
        );
    };
    
    // Render context menu
    const renderContextMenu = () => {
        if (!contextMenu) return null;
        
        return (
            <div 
                className="context-menu fixed bg-white dark:bg-gray-800 shadow-lg rounded-lg border border-gray-200 dark:border-gray-700 py-1 z-50 min-w-[200px]"
                style={{ 
                    left: contextMenu.x, 
                    top: contextMenu.y 
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
                        <div className="border-t border-gray-200 dark:border-gray-700 my-1"></div>
                        <button
                            className="w-full px-4 py-2 text-left hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center text-red-600 dark:text-red-400"
                            onClick={() => handleDelete([contextMenu.topicId!])}
                        >
                            <Trash2 size={16} className="mr-3" />
                            {t('context.delete') || '删除'}
                        </button>
                    </>
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
                    onRename={(name) => {
                        onUpdateTopic(currentEditingTopic.id, { name });
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
    onCreate: (name: string) => void;
    t: (key: string) => string;
}

const CreateTopicModal: React.FC<CreateTopicModalProps> = ({ onClose, onCreate, t }) => {
    const [name, setName] = useState('');
    
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim()) {
            onCreate(name.trim());
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
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg mb-4 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        autoFocus
                    />
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
    onRename: (name: string) => void;
    t: (key: string) => string;
}

const RenameTopicModal: React.FC<RenameTopicModalProps> = ({ topic, onClose, onRename, t }) => {
    const [name, setName] = useState(topic.name);
    
    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (name.trim() && name !== topic.name) {
            onRename(name.trim());
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
                        className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg mb-4 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none"
                        autoFocus
                    />
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
                            disabled={!name.trim() || name === topic.name}
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
    onClose: () => void;
    onSetCover: (fileId: string, cropData: CoverCropData) => void;
    t: (key: string) => string;
}

const SetCoverModal: React.FC<SetCoverModalProps> = ({ topic, topics, files, onClose, onSetCover, t }) => {
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
    
    // 处理鼠标按下开始拖拽
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
        
        // 计算最小缩放
        const minScaleX = CROP_WIDTH / imgRef.current.naturalWidth;
        const minScaleY = CROP_HEIGHT / imgRef.current.naturalHeight;
        const minScale = Math.max(minScaleX, minScaleY);
        newScale = Math.max(minScale, Math.min(newScale, 5));
        
        const w = imgRef.current.naturalWidth * newScale;
        const h = imgRef.current.naturalHeight * newScale;
        
        let newX = position.x;
        let newY = position.y;
        
        // 以裁剪框中心为缩放中心
        const cx = (OFFSET_X + CROP_WIDTH/2 - position.x) / scale;
        const cy = (OFFSET_Y + CROP_HEIGHT/2 - position.y) / scale;
        
        newX = OFFSET_X + CROP_WIDTH/2 - cx * newScale;
        newY = OFFSET_Y + CROP_HEIGHT/2 - cy * newScale;
        
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
        // 重置缩放和位置
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
                <div className="p-4 border-b border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 rounded-t-lg">
                    <h3 className="font-bold text-lg text-gray-900 dark:text-white">
                        {t('context.setTopicCover') || '设置专题封面'}
                    </h3>
                </div>

                {/* Main Content Area */}
                <div className="flex-1 flex flex-row overflow-hidden">
                    {/* Left: Crop Preview - Fixed Width */}
                    <div className="flex-none p-6 flex flex-col items-center justify-center bg-gray-100 dark:bg-black/20 border-r border-gray-200 dark:border-gray-700">
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
                        
                        <div className="text-xs text-gray-500 text-center bg-white dark:bg-gray-800 px-3 py-1.5 rounded-full shadow-sm border border-gray-200 dark:border-gray-700">
                             {t('context.cropHint') || '拖拽图片调整位置 • 滚轮缩放'}
                        </div>
                    </div>
                    
                    {/* Right: File Selection - Flex 1 */}
                    <div className="flex-1 flex flex-col overflow-hidden bg-white dark:bg-gray-800">
                        <div className="p-4 border-b border-gray-200 dark:border-gray-700">
                            <input
                                type="text"
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                placeholder={t('context.searchFiles') || '搜索文件名...'}
                                className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
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
                                                        className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all shadow-sm ${
                                                            isSelected
                                                                ? 'border-blue-500 ring-2 ring-blue-500/30'
                                                                : 'border-transparent hover:border-blue-300 dark:hover:border-blue-700 hover:shadow-md'
                                                        }`}
                                                    >
                                                        <div className="relative aspect-square">
                                                            <div 
                                                                className="absolute inset-0 bg-cover bg-center"
                                                                style={{ backgroundImage: `url("${convertFileSrc(img.path)}")` }}
                                                            />
                                                            {isSelected && (
                                                                <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center">
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
                <div className="p-4 border-t border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-900 rounded-b-lg flex items-center justify-between">
                    {/* Zoom Control - Moved to footer */}
                    <div className="flex-1 max-w-xs mr-4">
                        {selectedFile && (
                            <div className="flex items-center space-x-3 bg-white dark:bg-gray-800 px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-700">
                                <span className="text-xs font-medium text-gray-500 whitespace-nowrap">缩放</span>
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
                            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition shadow-sm"
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
