import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Search, Image as ImageIcon, Check, Folder, User, Tag, Layout, ChevronRight, X, FolderOpen, ArrowUpDown, Layers, ArrowUp, ArrowDown } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getCurrentWindow, LogicalSize, LogicalPosition } from '@tauri-apps/api/window';
import { FileNode, Person, Topic, FileType } from '../../types';
import { ImageThumbnail } from '../ImageThumbnail';
import { isTauriEnvironment } from '../../utils/environment';
import * as RW from 'react-window';

// Resolve FixedSizeList component from various module shapes
const FixedSizeListComp: any = (() => {
    const mod: any = RW as any;
    if (mod.FixedSizeList) return mod.FixedSizeList;
    if (mod.default && mod.default.FixedSizeList) return mod.default.FixedSizeList;
    if (mod.default && (typeof mod.default === 'function' || typeof mod.default === 'object')) return mod.default;
    return null;
})();

type SortByOption = 'name' | 'date' | 'size';
type GroupByOption = 'none' | 'type' | 'date' | 'size';
type SortDirection = 'asc' | 'desc';

interface GroupedImages {
    title: string;
    items: FileNode[];
}

interface AddImageModalProps {
    files: Record<string, FileNode>;
    people: Record<string, Person>;
    topics: Record<string, Topic>;
    customTags: string[];
    resourceRoot?: string;
    cachePath?: string;
    existingImageIds: string[]; // 画布中已存在的图片ID
    onConfirm: (selectedIds: string[]) => void;
    onClose: () => void;
    t: (key: string) => string;
}

type CategoryType = 'folders' | 'topics' | 'people' | 'tags';

interface TreeNode {
    id: string;
    name: string;
    type: 'folder' | 'topic' | 'person' | 'tag';
    depth: number;
    hasChildren: boolean;
    isExpanded?: boolean;
    count?: number;
    coverFileId?: string;
}

export const AddImageModal: React.FC<AddImageModalProps> = ({
    files,
    people,
    topics,
    customTags,
    resourceRoot,
    cachePath,
    existingImageIds,
    onConfirm,
    onClose,
    t
}) => {
    const [activeCategory, setActiveCategory] = useState<CategoryType>('folders');
    const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState('');
    const [searchInputValue, setSearchInputValue] = useState(''); // 输入框的值
    const [isSearchMode, setIsSearchMode] = useState(false); // 是否处于搜索模式
    const [expandedNodes, setExpandedNodes] = useState<Set<string>>(new Set());
    const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
    const modalRef = useRef<HTMLDivElement>(null);
    const gridContainerRef = useRef<HTMLDivElement>(null);
    const [gridHeight, setGridHeight] = useState(400);
    const [scrollTop, setScrollTop] = useState(0);
    const rowHeight = 160; // 图片卡片高度
    const columnCount = 5; // 每行5列
    const PAGE_SIZE = 500; // 每页显示数量
    const [currentPage, setCurrentPage] = useState(1); // 当前页码

    // 排序和分组状态（从 localStorage 读取默认值）
    const [sortBy, setSortBy] = useState<SortByOption>(() => {
        try {
            return (localStorage.getItem('aurora_add_image_sort_by') as SortByOption) || 'name';
        } catch {
            return 'name';
        }
    });
    const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
        try {
            return (localStorage.getItem('aurora_add_image_sort_direction') as SortDirection) || 'asc';
        } catch {
            return 'asc';
        }
    });
    const [groupBy, setGroupBy] = useState<GroupByOption>(() => {
        try {
            return (localStorage.getItem('aurora_add_image_group_by') as GroupByOption) || 'none';
        } catch {
            return 'none';
        }
    });
    const [showSortMenu, setShowSortMenu] = useState(false);
    const [showGroupMenu, setShowGroupMenu] = useState(false);
    const sortMenuRef = useRef<HTMLDivElement>(null);
    const groupMenuRef = useRef<HTMLDivElement>(null);
    // 展开的分组
    const [expandedGroups, setExpandedGroups] = useState<Set<number>>(new Set());

    // 窗口大小恢复相关
    const originalWindowStateRef = useRef<{ width: number; height: number; x: number; y: number } | null>(null);

    // 获取已存在图片的集合
    const existingIdsSet = useMemo(() => new Set(existingImageIds), [existingImageIds]);

    // 获取所有图片文件（排除已存在的）
    const imageFiles = useMemo(() => {
        return Object.values(files).filter(f => 
            f.type === FileType.IMAGE && !existingIdsSet.has(f.id)
        );
    }, [files, existingIdsSet]);

    // 获取标签列表
    const allTags = useMemo(() => {
        const tagSet = new Set<string>(customTags);
        Object.values(files).forEach(file => {
            if (file.tags && !existingIdsSet.has(file.id)) {
                file.tags.forEach(tag => tagSet.add(tag));
            }
        });
        return Array.from(tagSet).sort((a, b) => a.localeCompare(b, 'zh-CN'));
    }, [customTags, files, existingIdsSet]);

    // 获取根专题（parentId 为 null 的专题）
    const rootTopics = useMemo(() => {
        return Object.values(topics)
            .filter(t => !t.parentId)
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
    }, [topics]);

    // 获取子专题
    const getChildTopics = useCallback((parentId: string) => {
        return Object.values(topics)
            .filter(t => t.parentId === parentId)
            .sort((a, b) => (a.name || '').localeCompare(b.name || '', 'zh-CN'));
    }, [topics]);

    // 获取人物列表
    const peopleList = useMemo(() => {
        return Object.values(people).sort((a, b) => 
            (a.name || '').localeCompare(b.name || '', 'zh-CN')
        );
    }, [people]);

    // 获取根文件夹
    const rootFolders = useMemo(() => {
        return Object.values(files).filter(f => 
            f.type === FileType.FOLDER && !f.parentId
        ).sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }, [files]);

    // 获取文件夹的子文件夹
    const getChildFolders = useCallback((folderId: string) => {
        const folder = files[folderId];
        if (!folder?.children) return [];
        return folder.children
            .map(id => files[id])
            .filter((f): f is FileNode => f?.type === FileType.FOLDER)
            .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    }, [files]);

    // 构建树形节点列表（扁平化）
    const treeNodes = useMemo(() => {
        const nodes: TreeNode[] = [];
        
        switch (activeCategory) {
            case 'folders': {
                const traverse = (folderId: string, depth: number) => {
                    const folder = files[folderId];
                    if (!folder || folder.type !== FileType.FOLDER) return;
                    
                    const childFolders = getChildFolders(folderId);
                    const isExpanded = expandedNodes.has(folderId);
                    
                    nodes.push({
                        id: folderId,
                        name: folder.name,
                        type: 'folder',
                        depth,
                        hasChildren: childFolders.length > 0,
                        isExpanded
                    });
                    
                    if (isExpanded) {
                        childFolders.forEach(child => traverse(child.id, depth + 1));
                    }
                };
                
                rootFolders.forEach(folder => traverse(folder.id, 0));
                break;
            }
            case 'topics': {
                const traverseTopics = (topic: Topic, depth: number) => {
                    const childTopics = getChildTopics(topic.id);
                    const isExpanded = expandedNodes.has(topic.id);
                    
                    // 计算该专题下可添加的图片数量（排除已存在的）
                    const availableCount = topic.fileIds?.filter(id => 
                        !existingIdsSet.has(id) && files[id]?.type === FileType.IMAGE
                    ).length || 0;
                    
                    nodes.push({
                        id: topic.id,
                        name: topic.name,
                        type: 'topic',
                        depth,
                        hasChildren: childTopics.length > 0,
                        isExpanded,
                        count: availableCount,
                        coverFileId: topic.coverFileId
                    });
                    
                    if (isExpanded) {
                        childTopics.forEach(child => traverseTopics(child, depth + 1));
                    }
                };
                
                rootTopics.forEach(topic => traverseTopics(topic, 0));
                break;
            }
            case 'people': {
                peopleList.forEach(person => {
                    // 计算该人物下可添加的图片数量
                    const availableCount = Object.values(files).filter(f => 
                        f.type === FileType.IMAGE && 
                        !existingIdsSet.has(f.id) &&
                        f.aiData?.faces?.some(face => face.personId === person.id)
                    ).length;
                    
                    nodes.push({
                        id: person.id,
                        name: person.name,
                        type: 'person',
                        depth: 0,
                        hasChildren: false,
                        count: availableCount,
                        coverFileId: person.coverFileId
                    });
                });
                break;
            }
            case 'tags': {
                allTags.forEach(tag => {
                    const count = imageFiles.filter(img => img.tags?.includes(tag)).length;
                    nodes.push({
                        id: tag,
                        name: tag,
                        type: 'tag',
                        depth: 0,
                        hasChildren: false,
                        count
                    });
                });
                break;
            }
        }
        
        return nodes;
    }, [activeCategory, files, rootFolders, getChildFolders, expandedNodes, rootTopics, getChildTopics, peopleList, allTags, imageFiles, existingIdsSet]);

    // 执行搜索
    const executeSearch = useCallback(() => {
        const query = searchInputValue.trim();
        setSearchQuery(query);
        setIsSearchMode(query.length > 0);
        setCurrentPage(1); // 重置到第一页
    }, [searchInputValue]);

    // 清除搜索
    const clearSearch = useCallback(() => {
        setSearchInputValue('');
        setSearchQuery('');
        setIsSearchMode(false);
        setCurrentPage(1);
    }, []);

    // 排序函数
    const sortImages = useCallback((images: FileNode[]): FileNode[] => {
        const sorted = [...images];
        sorted.sort((a, b) => {
            let comparison = 0;
            switch (sortBy) {
                case 'name':
                    comparison = a.name.localeCompare(b.name, 'zh-CN');
                    break;
                case 'date':
                    const dateA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
                    const dateB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
                    comparison = dateA - dateB;
                    break;
                case 'size':
                    const sizeA = a.meta?.sizeKb || 0;
                    const sizeB = b.meta?.sizeKb || 0;
                    comparison = sizeA - sizeB;
                    break;
            }
            return sortDirection === 'asc' ? comparison : -comparison;
        });
        return sorted;
    }, [sortBy, sortDirection]);

    // 分组函数
    const groupImages = useCallback((images: FileNode[]): GroupedImages[] => {
        if (groupBy === 'none') {
            return [{ title: '', items: images }];
        }

        const groups: Record<string, FileNode[]> = {};

        images.forEach(img => {
            let key = '';
            switch (groupBy) {
                case 'type': {
                    const ext = img.name.split('.').pop()?.toLowerCase() || 'unknown';
                    key = ext.toUpperCase();
                    break;
                }
                case 'date': {
                    const date = img.updatedAt ? new Date(img.updatedAt) : new Date();
                    key = date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' });
                    break;
                }
                case 'size': {
                    const sizeKb = img.meta?.sizeKb || 0;
                    if (sizeKb < 100) {
                        key = '< 100 KB';
                    } else if (sizeKb < 1024) {
                        key = '100 KB - 1 MB';
                    } else if (sizeKb < 5120) {
                        key = '1 MB - 5 MB';
                    } else {
                        key = '> 5 MB';
                    }
                    break;
                }
            }
            if (!groups[key]) {
                groups[key] = [];
            }
            groups[key].push(img);
        });

        // 对分组进行排序
        const sortedKeys = Object.keys(groups).sort((a, b) => {
            if (groupBy === 'size') {
                // 按大小范围排序
                const sizeOrder = ['< 100 KB', '100 KB - 1 MB', '1 MB - 5 MB', '> 5 MB'];
                return sizeOrder.indexOf(a) - sizeOrder.indexOf(b);
            }
            return a.localeCompare(b, 'zh-CN');
        });

        return sortedKeys.map(key => ({
            title: `${key} (${groups[key].length})`,
            items: groups[key]
        }));
    }, [groupBy]);

    // 根据当前选中的节点或搜索条件获取要显示的图片
    const allDisplayedImages = useMemo(() => {
        // 如果处于搜索模式，进行全局文件名搜索
        if (isSearchMode && searchQuery.trim()) {
            const query = searchQuery.toLowerCase();
            return imageFiles.filter(img => 
                img.name.toLowerCase().includes(query)
            );
        }

        // 非搜索模式下，根据分类和选中节点显示图片
        let filtered: FileNode[] = [];

        switch (activeCategory) {
            case 'folders': {
                if (selectedNodeId) {
                    const folder = files[selectedNodeId];
                    if (folder) {
                        // 只获取当前文件夹中的图片（不包括子文件夹）
                        folder.children?.forEach(childId => {
                            const child = files[childId];
                            if (child?.type === FileType.IMAGE && !existingIdsSet.has(child.id)) {
                                filtered.push(child);
                            }
                        });
                    }
                }
                break;
            }
            case 'topics': {
                if (selectedNodeId) {
                    const topic = topics[selectedNodeId];
                    if (topic?.fileIds) {
                        filtered = topic.fileIds
                            .map(id => files[id])
                            .filter((f): f is FileNode => 
                                f?.type === FileType.IMAGE && !existingIdsSet.has(f.id)
                            );
                    }
                }
                break;
            }
            case 'people': {
                if (selectedNodeId) {
                    filtered = imageFiles.filter(img => {
                        if (!img.aiData?.faces) return false;
                        return img.aiData.faces.some(face => face.personId === selectedNodeId);
                    });
                }
                break;
            }
            case 'tags': {
                if (selectedNodeId) {
                    filtered = imageFiles.filter(img => 
                        img.tags?.includes(selectedNodeId)
                    );
                }
                break;
            }
        }

        // 应用排序
        return sortImages(filtered);
    }, [activeCategory, files, selectedNodeId, topics, imageFiles, searchQuery, isSearchMode, existingIdsSet, sortImages]);

    // 分组后的图片
    const groupedImages = useMemo(() => {
        return groupImages(allDisplayedImages);
    }, [allDisplayedImages, groupImages]);

    // 分页后的图片
    const displayedImages = useMemo(() => {
        const startIndex = (currentPage - 1) * PAGE_SIZE;
        return allDisplayedImages.slice(startIndex, startIndex + PAGE_SIZE);
    }, [allDisplayedImages, currentPage]);

    // 总页数
    const totalPages = useMemo(() => {
        return Math.ceil(allDisplayedImages.length / PAGE_SIZE);
    }, [allDisplayedImages.length]);

    // 切换节点展开状态
    const toggleNode = (nodeId: string) => {
        setExpandedNodes(prev => {
            const next = new Set(prev);
            if (next.has(nodeId)) {
                next.delete(nodeId);
            } else {
                next.add(nodeId);
            }
            return next;
        });
    };

    // 最大图片数量限制
    const MAX_IMAGES = 24;

    // 计算当前总图片数（画布中已有的 + 已选择的）
    const totalImageCount = existingImageIds.length + selectedIds.size;
    const canAddMore = totalImageCount < MAX_IMAGES;
    const remainingSlots = Math.max(0, MAX_IMAGES - existingImageIds.length);

    // 切换图片选择
    const toggleImageSelection = (imageId: string) => {
        // 如果图片已存在于画布中，不允许选择
        if (existingIdsSet.has(imageId)) return;
        
        // 如果已达到上限且尝试添加新图片，则阻止
        if (!selectedIds.has(imageId) && !canAddMore) return;
        
        setSelectedIds(prev => {
            const next = new Set(prev);
            if (next.has(imageId)) {
                next.delete(imageId);
            } else {
                next.add(imageId);
            }
            return next;
        });
    };

    // 全选当前页显示的图片
    const selectAllDisplayed = () => {
        // 检查是否会导致超出限制
        const availableSlots = MAX_IMAGES - existingImageIds.length;
        const currentSelectedCount = selectedIds.size;
        const canSelectCount = Math.min(displayedImages.length, availableSlots - (selectedIds.size - currentSelectedCount));
        
        const newSelected = new Set(selectedIds);
        let addedCount = 0;
        for (const img of displayedImages) {
            if (newSelected.size >= availableSlots) break;
            if (!newSelected.has(img.id)) {
                newSelected.add(img.id);
                addedCount++;
            }
        }
        setSelectedIds(newSelected);
    };

    // 清除选择
    const clearSelection = () => {
        setSelectedIds(new Set());
    };

    // 处理确认
    const handleConfirm = () => {
        onConfirm(Array.from(selectedIds));
    };

    // 处理分类切换
    const handleCategoryChange = (category: CategoryType) => {
        setActiveCategory(category);
        setSelectedNodeId(null);
        setExpandedNodes(new Set());
        setSearchQuery('');
    };

    // 更新网格容器高度
    useEffect(() => {
        if (gridContainerRef.current) {
            setGridHeight(gridContainerRef.current.clientHeight);
        }
    }, []);

    // 监听窗口大小变化
    useEffect(() => {
        const handleResize = () => {
            if (gridContainerRef.current) {
                setGridHeight(gridContainerRef.current.clientHeight);
            }
        };
        window.addEventListener('resize', handleResize);
        return () => window.removeEventListener('resize', handleResize);
    }, []);

    // 组件挂载时：如果窗口太小，临时扩大窗口
    useEffect(() => {
        const resizeWindowForModal = async () => {
            if (!isTauriEnvironment()) return;

            try {
                const window = getCurrentWindow();
                const windowSize = await window.innerSize();
                const windowPos = await window.outerPosition();

                const MODAL_MIN_WIDTH = 770;
                const MODAL_MIN_HEIGHT = 650;
                const PADDING = 40;

                const needsResize = windowSize.width < MODAL_MIN_WIDTH + PADDING ||
                                    windowSize.height < MODAL_MIN_HEIGHT + PADDING;

                if (needsResize) {
                    const newWidth = Math.max(windowSize.width, MODAL_MIN_WIDTH + PADDING);
                    const newHeight = Math.max(windowSize.height, MODAL_MIN_HEIGHT + PADDING);

                    // 保存原始窗口状态
                    originalWindowStateRef.current = {
                        width: windowSize.width,
                        height: windowSize.height,
                        x: windowPos.x,
                        y: windowPos.y
                    };

                    // 计算屏幕中心位置
                    const screenWidth = (window as any).screen?.width || 1920;
                    const screenHeight = (window as any).screen?.height || 1080;

                    // 居中显示
                    const newX = Math.max(0, Math.min(windowPos.x, screenWidth - newWidth));
                    const newY = Math.max(0, Math.min(windowPos.y, screenHeight - newHeight));

                    await window.setSize(new LogicalSize(newWidth, newHeight));
                    await window.setPosition(new LogicalPosition(newX, newY));

                    console.log('[AddImageModal] Resized window for modal:', windowSize.width, 'x', windowSize.height, '->', newWidth, 'x', newHeight);
                }
            } catch (error) {
                console.error('Failed to resize window for modal:', error);
            }
        };

        resizeWindowForModal();

        // 组件卸载时恢复窗口大小
        return () => {
            const restoreWindowSize = async () => {
                if (originalWindowStateRef.current && isTauriEnvironment()) {
                    try {
                        const window = getCurrentWindow();
                        const { width, height, x, y } = originalWindowStateRef.current;
                        await window.setSize(new LogicalSize(width, height));
                        await window.setPosition(new LogicalPosition(x, y));
                        console.log('[AddImageModal] Restored window size to', width, 'x', height);
                        originalWindowStateRef.current = null;
                    } catch (error) {
                        console.error('Failed to restore window size:', error);
                    }
                }
            };

            restoreWindowSize();
        };
    }, []);

    // 点击外部关闭
    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (modalRef.current && !modalRef.current.contains(e.target as Node)) {
                onClose();
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [onClose]);

    // 点击外部关闭排序/分组菜单
    useEffect(() => {
        const handleClickOutsideMenus = (e: MouseEvent) => {
            if (sortMenuRef.current && !sortMenuRef.current.contains(e.target as Node)) {
                setShowSortMenu(false);
            }
            if (groupMenuRef.current && !groupMenuRef.current.contains(e.target as Node)) {
                setShowGroupMenu(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutsideMenus);
        return () => document.removeEventListener('mousedown', handleClickOutsideMenus);
    }, []);

    // 滚动页面关闭排序/分组菜单
    useEffect(() => {
        const handleScrollCloseMenus = () => {
            setShowSortMenu(false);
            setShowGroupMenu(false);
        };
        window.addEventListener('scroll', handleScrollCloseMenus, true);
        return () => window.removeEventListener('scroll', handleScrollCloseMenus, true);
    }, []);

    // 添加ESC键关闭支持
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [onClose]);

    // 默认展开根文件夹并选中第一个
    useEffect(() => {
        if (activeCategory === 'folders' && rootFolders.length > 0) {
            const firstRoot = rootFolders[0];
            setExpandedNodes(new Set([firstRoot.id]));
            setSelectedNodeId(firstRoot.id);
        } else if (activeCategory === 'topics' && rootTopics.length > 0) {
            // 专题默认不展开，只选中第一个根专题
            setSelectedNodeId(rootTopics[0].id);
        }
    }, [activeCategory, rootFolders, rootTopics]);

    // 虚拟滚动行数据
    const rowData = useMemo(() => {
        const rows: FileNode[][] = [];
        for (let i = 0; i < displayedImages.length; i += columnCount) {
            rows.push(displayedImages.slice(i, i + columnCount));
        }
        return rows;
    }, [displayedImages]);

    // 渲染树节点
    const renderTreeNode = (node: TreeNode) => {
        const isSelected = selectedNodeId === node.id;
        
        const getIcon = () => {
            switch (node.type) {
                case 'folder':
                    return node.isExpanded ? 
                        <FolderOpen size={16} className="mr-2 text-blue-500" /> : 
                        <Folder size={16} className="mr-2 text-blue-500" />;
                case 'topic':
                    return <Layout size={16} className="mr-2 text-pink-500" />;
                case 'person':
                    const coverFile = node.coverFileId ? files[node.coverFileId] : null;
                    return coverFile ? (
                        <img 
                            src={convertFileSrc(coverFile.path)} 
                            alt={node.name}
                            className="w-5 h-5 rounded-full object-cover mr-2"
                        />
                    ) : (
                        <User size={16} className="mr-2 text-purple-500" />
                    );
                case 'tag':
                    return <Tag size={16} className="mr-2 text-blue-500" />;
            }
        };

        return (
            <button
                key={node.id}
                onClick={() => {
                    if ((node.type === 'folder' || node.type === 'topic') && node.hasChildren) {
                        toggleNode(node.id);
                    }
                    setSelectedNodeId(node.id);
                }}
                className={`w-full flex items-center px-3 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors ${
                    isSelected ? 'bg-blue-50 dark:bg-blue-900/20 border-l-2 border-blue-500' : ''
                }`}
                style={{ paddingLeft: `${12 + node.depth * 16}px` }}
            >
                {(node.type === 'folder' || node.type === 'topic') && node.hasChildren && (
                    <ChevronRight 
                        size={14} 
                        className={`mr-1 transition-transform ${node.isExpanded ? 'rotate-90' : ''}`}
                    />
                )}
                {(node.type !== 'folder' && node.type !== 'topic') && <div className="w-[14px]" />}
                {getIcon()}
                <span className="text-sm text-gray-700 dark:text-gray-300 truncate flex-1">
                    {node.name}
                </span>
                {node.count !== undefined && (
                    <span className="ml-auto text-xs text-gray-400">
                        {node.count}
                    </span>
                )}
            </button>
        );
    };

    // 渲染虚拟滚动行
    const renderRow = ({ index, style }: { index: number; style: React.CSSProperties }) => {
        const row = rowData[index];
        return (
            <div style={style} className="grid grid-cols-5 gap-3 px-4">
                {row.map((file) => {
                    const isSelected = selectedIds.has(file.id);
                    return (
                        <div
                            key={file.id}
                            onClick={() => toggleImageSelection(file.id)}
                            className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all duration-200 ${
                                isSelected 
                                    ? 'border-blue-500 ring-2 ring-blue-500/20' 
                                    : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                            }`}
                        >
                            <div className="relative aspect-square bg-gray-100 dark:bg-gray-800">
                                <ImageThumbnail
                                    src={''}
                                    alt={file.name}
                                    isSelected={isSelected}
                                    filePath={file.path}
                                    modified={file.updatedAt}
                                    isHovering={false}
                                    fileMeta={file.meta}
                                    resourceRoot={resourceRoot}
                                    cachePath={cachePath}
                                />
                                {isSelected && (
                                    <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center">
                                        <div className="bg-blue-500 rounded-full p-1.5 shadow-lg">
                                            <Check size={16} className="text-white" />
                                        </div>
                                    </div>
                                )}
                            </div>
                            <div className="p-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800">
                                <p className="text-xs text-gray-600 dark:text-gray-300 truncate">
                                    {file.name}
                                </p>
                            </div>
                        </div>
                    );
                })}
            </div>
        );
    };

    return (
        <div 
            className="fixed inset-0 z-[200] bg-black/70 flex items-center justify-center p-4 animate-fade-in"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
        >
            <div 
                ref={modalRef}
                className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl overflow-hidden flex flex-col w-full max-w-6xl h-[85vh] pointer-events-auto"
                onClick={(e) => e.stopPropagation()}
                onMouseDown={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-center justify-between p-4 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-black/20">
                    <h3 className="font-bold text-lg text-gray-800 dark:text-white flex items-center">
                        <ImageIcon size={20} className="mr-2 text-blue-500" />
                        {t('comparer.addImages') || '添加图片到画布'}
                    </h3>
                    <button 
                        onClick={onClose}
                        className="p-2 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-lg transition-colors"
                    >
                        <X size={20} className="text-gray-500" />
                    </button>
                </div>

                {/* Main Content */}
                <div className="flex-1 flex overflow-hidden">
                    {/* Left: Category Navigation */}
                    <div className="w-56 border-r border-gray-200 dark:border-gray-800 flex flex-col bg-gray-50/50 dark:bg-black/10">
                        <div className="p-2 space-y-1">
                            <button
                                onClick={() => handleCategoryChange('folders')}
                                className={`w-full flex items-center px-3 py-2 rounded-lg text-left transition-colors ${
                                    activeCategory === 'folders' 
                                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' 
                                        : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                                }`}
                            >
                                <Folder size={18} className="mr-2" />
                                <span className="text-sm font-medium">{t('sidebar.folders') || '文件目录'}</span>
                            </button>
                            <button
                                onClick={() => handleCategoryChange('topics')}
                                className={`w-full flex items-center px-3 py-2 rounded-lg text-left transition-colors ${
                                    activeCategory === 'topics' 
                                        ? 'bg-pink-100 dark:bg-pink-900/30 text-pink-700 dark:text-pink-300' 
                                        : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                                }`}
                            >
                                <Layout size={18} className="mr-2" />
                                <span className="text-sm font-medium">{t('sidebar.topics') || '专题'}</span>
                            </button>
                            <button
                                onClick={() => handleCategoryChange('people')}
                                className={`w-full flex items-center px-3 py-2 rounded-lg text-left transition-colors ${
                                    activeCategory === 'people' 
                                        ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300' 
                                        : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                                }`}
                            >
                                <User size={18} className="mr-2" />
                                <span className="text-sm font-medium">{t('sidebar.people') || '人物'}</span>
                            </button>
                            <button
                                onClick={() => handleCategoryChange('tags')}
                                className={`w-full flex items-center px-3 py-2 rounded-lg text-left transition-colors ${
                                    activeCategory === 'tags' 
                                        ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300' 
                                        : 'hover:bg-gray-200 dark:hover:bg-gray-800 text-gray-700 dark:text-gray-300'
                                }`}
                            >
                                <Tag size={18} className="mr-2" />
                                <span className="text-sm font-medium">{t('sidebar.tags') || '标签'}</span>
                            </button>
                        </div>
                        <div className="border-t border-gray-200 dark:border-gray-800 my-2" />
                        <div className="flex-1 overflow-y-auto">
                            {treeNodes.map(node => renderTreeNode(node))}
                        </div>
                    </div>

                    {/* Right: Image Grid */}
                    <div className="flex-1 flex flex-col bg-white dark:bg-gray-900">
                        {/* Search and Actions */}
                        <div className="p-4 border-b border-gray-200 dark:border-gray-800 flex items-center gap-3">
                            <div className="relative flex-1">
                                <input
                                    type="text"
                                    placeholder={t('search.placeholder') || '搜索文件名，按Enter执行...'}
                                    value={searchInputValue}
                                    onChange={(e) => setSearchInputValue(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'Enter') {
                                            executeSearch();
                                        }
                                    }}
                                    className="w-full pl-10 pr-10 py-2 border border-gray-300 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white focus:ring-2 focus:ring-blue-500 outline-none text-sm"
                                />
                                <Search size={16} className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400" />
                                {searchInputValue && (
                                    <button
                                        onClick={clearSearch}
                                        className="absolute right-3 top-1/2 transform -translate-y-1/2 p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded"
                                    >
                                        <X size={14} className="text-gray-400" />
                                    </button>
                                )}
                            </div>
                            {/* 升序/降序按钮 */}
                            <button
                                onClick={() => {
                                    const newDirection = sortDirection === 'asc' ? 'desc' : 'asc';
                                    setSortDirection(newDirection);
                                    try { localStorage.setItem('aurora_add_image_sort_direction', newDirection); } catch {}
                                }}
                                className="p-2 rounded-lg transition-colors text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800"
                                title={sortDirection === 'asc' ? '升序' : '降序'}
                            >
                                {sortDirection === 'asc' ? <ArrowUp size={18} /> : <ArrowDown size={18} />}
                            </button>
                            {/* 排序按钮 */}
                            <div className="relative" ref={sortMenuRef}>
                                <button
                                    onClick={() => setShowSortMenu(!showSortMenu)}
                                    className={`p-2 rounded-lg transition-colors flex items-center gap-1 ${showSortMenu ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                                    title={t('comparer.sortBy') || '排序方式'}
                                >
                                    <ArrowUpDown size={18} />
                                </button>
                                {showSortMenu && (
                                    <div className="absolute right-0 top-full mt-1 w-36 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
                                        <button
                                            onClick={() => {
                                                setSortBy('name');
                                                try { localStorage.setItem('aurora_add_image_sort_by', 'name'); } catch {}
                                                setShowSortMenu(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between ${sortBy === 'name' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                        >
                                            <span>{t('comparer.sortByName') || '按名称'}</span>
                                            {sortBy === 'name' && (sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                                        </button>
                                        <button
                                            onClick={() => {
                                                setSortBy('date');
                                                try { localStorage.setItem('aurora_add_image_sort_by', 'date'); } catch {}
                                                setShowSortMenu(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between ${sortBy === 'date' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                        >
                                            <span>{t('comparer.sortByDate') || '按时间'}</span>
                                            {sortBy === 'date' && (sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                                        </button>
                                        <button
                                            onClick={() => {
                                                setSortBy('size');
                                                try { localStorage.setItem('aurora_add_image_sort_by', 'size'); } catch {}
                                                setShowSortMenu(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm flex items-center justify-between ${sortBy === 'size' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                        >
                                            <span>{t('comparer.sortBySize') || '按大小'}</span>
                                            {sortBy === 'size' && (sortDirection === 'asc' ? <ArrowUp size={14} /> : <ArrowDown size={14} />)}
                                        </button>
                                    </div>
                                )}
                            </div>
                            {/* 分组按钮 */}
                            <div className="relative" ref={groupMenuRef}>
                                <button
                                    onClick={() => setShowGroupMenu(!showGroupMenu)}
                                    className={`p-2 rounded-lg transition-colors flex items-center gap-1 ${showGroupMenu ? 'bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400' : 'text-gray-600 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-800'}`}
                                    title={t('comparer.groupBy') || '分组方式'}
                                >
                                    <Layers size={18} />
                                    {groupBy !== 'none' && <span className="w-2 h-2 bg-blue-500 rounded-full" />}
                                </button>
                                {showGroupMenu && (
                                    <div className="absolute right-0 top-full mt-1 w-32 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-50">
                                        <button
                                            onClick={() => {
                                                setGroupBy('none');
                                                try { localStorage.setItem('aurora_add_image_group_by', 'none'); } catch {}
                                                setShowGroupMenu(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm ${groupBy === 'none' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                        >
                                            {t('comparer.groupByNone') || '无'}
                                        </button>
                                        <button
                                            onClick={() => {
                                                setGroupBy('type');
                                                try { localStorage.setItem('aurora_add_image_group_by', 'type'); } catch {}
                                                setShowGroupMenu(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm ${groupBy === 'type' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                        >
                                            {t('comparer.groupByType') || '按类型'}
                                        </button>
                                        <button
                                            onClick={() => {
                                                setGroupBy('date');
                                                try { localStorage.setItem('aurora_add_image_group_by', 'date'); } catch {}
                                                setShowGroupMenu(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm ${groupBy === 'date' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                        >
                                            {t('comparer.groupByDate') || '按日期'}
                                        </button>
                                        <button
                                            onClick={() => {
                                                setGroupBy('size');
                                                try { localStorage.setItem('aurora_add_image_group_by', 'size'); } catch {}
                                                setShowGroupMenu(false);
                                            }}
                                            className={`w-full px-3 py-2 text-left text-sm ${groupBy === 'size' ? 'bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400' : 'text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700'}`}
                                        >
                                            {t('comparer.groupBySize') || '按大小'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        </div>

                        {/* Image Grid with Virtual Scroll */}
                        <div 
                            ref={gridContainerRef}
                            className="flex-1 overflow-hidden"
                        >
                            {displayedImages.length === 0 ? (
                                <div className="h-full flex flex-col items-center justify-center text-gray-400 dark:text-gray-500">
                                    <ImageIcon size={64} className="mb-4 opacity-20" />
                                    <p className="text-sm">
                                        {!selectedNodeId 
                                            ? (t('comparer.selectNode') || '请选择左侧项目查看图片')
                                            : (t('comparer.noImages') || '暂无图片')
                                        }
                                    </p>
                                </div>
                            ) : groupBy !== 'none' ? (
                                // 分组显示模式
                                <div className="overflow-y-auto h-full p-4">
                                    {groupedImages.map((group, groupIndex) => {
                                        const isExpanded = expandedGroups.has(groupIndex);
                                        return (
                                            <div key={groupIndex} className="mb-4">
                                                {group.title && (
                                                    <button
                                                        onClick={() => {
                                                            setExpandedGroups(prev => {
                                                                const next = new Set(prev);
                                                                if (next.has(groupIndex)) {
                                                                    next.delete(groupIndex);
                                                                } else {
                                                                    next.add(groupIndex);
                                                                }
                                                                return next;
                                                            });
                                                        }}
                                                        className="w-full flex items-center justify-between px-2 py-2 text-left hover:bg-gray-100 dark:hover:bg-gray-800 rounded-lg transition-colors mb-2"
                                                    >
                                                        <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">
                                                            {group.title}
                                                        </h4>
                                                        <ChevronRight 
                                                            size={16} 
                                                            className={`text-gray-400 transition-transform ${isExpanded ? 'rotate-90' : ''}`}
                                                        />
                                                    </button>
                                                )}
                                                {isExpanded && (
                                                    <div className="grid grid-cols-5 gap-3">
                                                        {group.items.map((file) => {
                                                            const isSelected = selectedIds.has(file.id);
                                                            return (
                                                                <div
                                                                    key={file.id}
                                                                    onClick={() => toggleImageSelection(file.id)}
                                                                    className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all duration-200 ${
                                                                        isSelected 
                                                                            ? 'border-blue-500 ring-2 ring-blue-500/20' 
                                                                            : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                                                                    }`}
                                                                >
                                                                    <div className="relative aspect-square bg-gray-100 dark:bg-gray-800">
                                                                        <ImageThumbnail
                                                                            src={''}
                                                                            alt={file.name}
                                                                            isSelected={isSelected}
                                                                            filePath={file.path}
                                                                            modified={file.updatedAt}
                                                                            isHovering={false}
                                                                            fileMeta={file.meta}
                                                                            resourceRoot={resourceRoot}
                                                                            cachePath={cachePath}
                                                                        />
                                                                        {isSelected && (
                                                                            <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center">
                                                                                <div className="bg-blue-500 rounded-full p-1.5 shadow-lg">
                                                                                    <Check size={16} className="text-white" />
                                                                                </div>
                                                                            </div>
                                                                        )}
                                                                    </div>
                                                                    <div className="p-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800">
                                                                        <p className="text-xs text-gray-600 dark:text-gray-300 truncate">
                                                                            {file.name}
                                                                        </p>
                                                                    </div>
                                                                </div>
                                                            );
                                                        })}
                                                    </div>
                                                )}
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : FixedSizeListComp ? (
                                <FixedSizeListComp
                                    height={gridHeight}
                                    itemCount={rowData.length}
                                    itemSize={rowHeight}
                                    width="100%"
                                    onScroll={({ scrollTop }: { scrollTop: number }) => setScrollTop(scrollTop)}
                                >
                                    {renderRow}
                                </FixedSizeListComp>
                            ) : (
                                // Fallback without virtual scroll
                                <div className="overflow-y-auto h-full p-4">
                                    <div className="grid grid-cols-5 gap-3">
                                        {displayedImages.map((file) => {
                                            const isSelected = selectedIds.has(file.id);
                                            return (
                                                <div
                                                    key={file.id}
                                                    onClick={() => toggleImageSelection(file.id)}
                                                    className={`cursor-pointer rounded-lg overflow-hidden border-2 transition-all duration-200 ${
                                                        isSelected 
                                                            ? 'border-blue-500 ring-2 ring-blue-500/20' 
                                                            : 'border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                                                    }`}
                                                >
                                                    <div className="relative aspect-square bg-gray-100 dark:bg-gray-800">
                                                        <ImageThumbnail
                                                            src={''}
                                                            alt={file.name}
                                                            isSelected={isSelected}
                                                            filePath={file.path}
                                                            modified={file.updatedAt}
                                                            isHovering={false}
                                                            fileMeta={file.meta}
                                                            resourceRoot={resourceRoot}
                                                            cachePath={cachePath}
                                                        />
                                                        {isSelected && (
                                                            <div className="absolute inset-0 bg-blue-500/20 flex items-center justify-center">
                                                                <div className="bg-blue-500 rounded-full p-1.5 shadow-lg">
                                                                    <Check size={16} className="text-white" />
                                                                </div>
                                                            </div>
                                                        )}
                                                    </div>
                                                    <div className="p-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-100 dark:border-gray-800">
                                                        <p className="text-xs text-gray-600 dark:text-gray-300 truncate">
                                                            {file.name}
                                                        </p>
                                                    </div>
                                                </div>
                                            );
                                        })}
                                    </div>
                                </div>
                            )}
                        </div>

                        {/* Selection Info */}
                        <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-800 flex items-center justify-between">
                            <span className="text-sm text-gray-600 dark:text-gray-400">
                                {t('comparer.selectedCount') || '已选择'}: 
                                <span className="font-semibold text-blue-600 dark:text-blue-400 ml-1">
                                    {selectedIds.size}
                                </span>
                                {' '}{t('comparer.images') || '张图片'}
                                {allDisplayedImages.length > 0 && (
                                    <span className="ml-2 text-gray-400">
                                        ({t('comparer.totalResults') || '共找到'}: {allDisplayedImages.length})
                                    </span>
                                )}
                            </span>
                            <span className={`text-sm font-medium ${totalImageCount >= MAX_IMAGES ? 'text-red-500' : 'text-gray-600 dark:text-gray-400'}`}>
                                {t('comparer.totalCount') || '总计'}: 
                                <span className="mx-1">{totalImageCount}</span>
                                /
                                <span className="mx-1">{MAX_IMAGES}</span>
                                {totalImageCount >= MAX_IMAGES && (
                                    <span className="ml-2 text-xs">({t('comparer.limitReached') || '已达到上限'})</span>
                                )}
                            </span>
                        </div>

                        {/* Pagination */}
                        {totalPages > 1 && (
                            <div className="px-4 py-2 bg-gray-50 dark:bg-gray-800/50 border-t border-gray-200 dark:border-gray-800 flex items-center justify-center gap-2">
                                <button
                                    onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                                    disabled={currentPage === 1}
                                    className="px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {t('pagination.prev') || '上一页'}
                                </button>
                                <span className="text-sm text-gray-600 dark:text-gray-400 mx-2">
                                    {t('pagination.page') || '第'} {currentPage} / {totalPages} {t('pagination.pageOf') || '页'}
                                </span>
                                <button
                                    onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                                    disabled={currentPage === totalPages}
                                    className="px-3 py-1 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                                >
                                    {t('pagination.next') || '下一页'}
                                </button>
                                <span className="text-xs text-gray-400 ml-2">
                                    ({t('pagination.perPage') || '每页'} {PAGE_SIZE} {t('pagination.items') || '条'})
                                </span>
                            </div>
                        )}
                    </div>
                </div>

                {/* Footer */}
                <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-black/20 flex items-center justify-between">
                    <div className="text-sm text-gray-500 dark:text-gray-400">
                        {t('comparer.canvasCount') || '画布中'}: 
                        <span className="font-medium text-gray-700 dark:text-gray-300">{existingImageIds.length}</span>
                        {' '}{t('comparer.images') || '张'}
                    </div>
                    <div className="flex items-center gap-3">
                        {/* 清除按钮 */}
                        <button
                            onClick={() => setSelectedIds(new Set())}
                            disabled={selectedIds.size === 0}
                            className="p-2 rounded-lg transition-colors text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-30 disabled:cursor-not-allowed"
                            title={t('comparer.clearSelection') || '清除选择'}
                        >
                            <X size={20} />
                        </button>
                        <button
                            onClick={onClose}
                            className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-200 bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                        >
                            {t('settings.cancel') || '取消'}
                        </button>
                        <button
                            onClick={handleConfirm}
                            disabled={selectedIds.size === 0 || totalImageCount > MAX_IMAGES}
                            className="px-6 py-2 text-sm font-bold text-white bg-blue-600 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center"
                        >
                            <Check size={16} className="mr-1.5" />
                            {t('comparer.confirmAdd') || '确认添加'} 
                            {selectedIds.size > 0 && ` (${selectedIds.size})`}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
