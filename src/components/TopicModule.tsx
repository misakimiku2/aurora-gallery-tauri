import React, { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { Topic, FileNode, Person, FileType } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { Image, User, Plus, Trash2, Folder, ExternalLink, ChevronRight, Layout, ArrowLeft, MoreHorizontal } from 'lucide-react';

interface TopicModuleProps {
    topics: Record<string, Topic>;
    files: Record<string, FileNode>;
    people: Record<string, Person>;
    currentTopicId: string | null;
    selectedTopicIds: string[];
    onNavigateTopic: (topicId: string | null) => void;
    onUpdateTopic: (topicId: string, updates: Partial<Topic>) => void;
    onCreateTopic: (parentId: string | null) => void;
    onDeleteTopic: (topicId: string) => void;
    onSelectTopics: (ids: string[]) => void;
    onSelectFiles: (ids: string[]) => void;
    t: (key: string) => string;
}

export const TopicModule: React.FC<TopicModuleProps> = ({ 
    topics, files, people, currentTopicId, selectedTopicIds,
    onNavigateTopic, onUpdateTopic, onCreateTopic, onDeleteTopic, onSelectTopics, onSelectFiles, t 
}) => {
    
    // Selection state for box selection
    const [isSelecting, setIsSelecting] = useState(false);
    const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
    const selectionRef = useRef<HTMLDivElement>(null);
    const lastSelectedIdRef = useRef<string | null>(null);
    
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

    const currentTopic = currentTopicId ? topics[currentTopicId] : null;

    const [coverHeight, setCoverHeight] = useState(350);
    const requestRef = useRef<number | undefined>(undefined);
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerRect, setContainerRect] = useState({ width: 0, height: 0 });

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
            >
                 <div className="flex justify-between items-center mb-6">
                    <h2 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center">
                        <Layout className="mr-3" />
                        {t('sidebar.topics')}
                    </h2>
                    <button 
                        onClick={() => onCreateTopic(null)}
                        className="bg-blue-600 text-white px-4 py-2 rounded-lg flex items-center hover:bg-blue-700 transition"
                    >
                        <Plus size={18} className="mr-2" />
                        {t('context.newTopic')}
                    </button>
                </div>

                <div className="relative" style={{ height: totalHeight }}>
                    {layoutItems.map(({ topic, x, y, width, height }) => {
                        const coverUrl = getCoverUrl(topic);
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
                            >
                                <div className={`absolute inset-0 transform transition-all duration-300 group-hover:-translate-y-2 group-hover:shadow-2xl rounded-xl ${isSelected ? 'ring-4 ring-blue-500 ring-offset-2 dark:ring-offset-gray-900 shadow-blue-500/20' : ''}`}>
                                    <div className="absolute inset-0 bg-gray-200 dark:bg-gray-800 rounded-xl overflow-hidden border border-gray-100 dark:border-gray-700 shadow-lg">
                                        {coverUrl ? (
                                            <div className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover:scale-105" style={{ backgroundImage: `url("${coverUrl}")` }} />
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

        return (
            <div 
                id="topic-gallery-container" 
                ref={setRefs}
                className="h-full overflow-y-auto bg-white dark:bg-gray-900"
                onMouseDown={handleMouseDown}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
            >
                {/* Header / Hero */}
                <div className="relative h-64 md:h-80 w-full overflow-hidden">
                    {/* Background */}
                    <div className="absolute inset-0">
                        {getCoverUrl(currentTopic) ? (
                            <div className="absolute inset-0 bg-cover bg-center blur-sm scale-110 opacity-50" style={{ backgroundImage: `url("${getCoverUrl(currentTopic)}")` }} />
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

                <div className="max-w-7xl mx-auto px-6 py-8 space-y-12">
                     
                     {/* Sub Topics */}
                     {!currentTopic.parentId && (
                        <section>
                             <div className="flex justify-between items-center mb-4">
                                <h3 className="text-xl font-bold flex items-center dark:text-gray-200">
                                    <Folder className="mr-2 text-yellow-500" />
                                    {t('context.subTopics') || 'Sub Topics'}
                                </h3>
                                <button onClick={() => onCreateTopic(currentTopic.id)} className="text-sm text-blue-500 hover:text-blue-400 font-medium">
                                    + {t('context.newTopic')}
                                </button>
                             </div>
                             
                             {subTopics.length > 0 ? (
                                 <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-6">
                                     {subTopics.map(sub => (
                                         <div 
                                            key={sub.id} 
                                            className={`topic-item group flex flex-col cursor-pointer transition-all duration-300`}
                                            data-topic-id={sub.id}
                                            style={{ zIndex: selectedTopicIds.includes(sub.id) ? 10 : 0 }}
                                            onClick={(e) => handleTopicClick(e, sub.id, allSubTopicIds)}
                                            onDoubleClick={(e) => handleTopicDoubleClick(e, sub.id)}
                                         >
                                             <div className={`relative aspect-[3/4] w-full transform transition-all duration-300 group-hover:-translate-y-2 rounded-xl ${selectedTopicIds.includes(sub.id) ? 'ring-4 ring-blue-500 ring-offset-2 dark:ring-offset-gray-900 shadow-blue-500/20' : ''}`}>
                                                 <div className="absolute inset-0 rounded-xl overflow-hidden shadow-lg border border-gray-100 dark:border-gray-700 bg-gray-200 dark:bg-gray-800">
                                                     {getCoverUrl(sub) ? (
                                                         <div className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover:scale-105" style={{ backgroundImage: `url("${getCoverUrl(sub)}")` }} />
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
                                     ))}
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
                     <section>
                        <h3 className="text-xl font-bold flex items-center mb-4 dark:text-gray-200">
                            <Image className="mr-2 text-green-500" />
                            {t('context.files') || 'Gallery'}
                        </h3>
                        {topicImages.length > 0 ? (
                            <div className="grid grid-cols-3 md:grid-cols-4 lg:grid-cols-6 gap-2">
                                {topicImages.map(file => (
                                    <div 
                                        key={file.id} 
                                        className="aspect-square rounded-lg overflow-hidden cursor-pointer relative group"
                                        onClick={() => onSelectFiles([file.id])} // Ideally should open image viewer
                                    >
                                        <div className="w-full h-full bg-cover bg-center transition-transform duration-500 group-hover:scale-110" style={{ backgroundImage: `url("${convertFileSrc(file.path)}")` }} />
                                    </div>
                                ))}
                            </div>
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
    return currentTopicId ? renderDetail() : renderGallery();
};
