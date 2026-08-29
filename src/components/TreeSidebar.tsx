
import React, { useState, useMemo, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import * as RW from 'react-window';

// Resolve FixedSizeList component from various module shapes
const FixedSizeListComp: any = (() => {
  const mod: any = RW as any;
  if (mod.FixedSizeList) return mod.FixedSizeList;
  if (mod.default && mod.default.FixedSizeList) return mod.default.FixedSizeList;
  if (mod.default && (typeof mod.default === 'function' || typeof mod.default === 'object')) return mod.default;
  // last resort: return null to allow fallback rendering
  return null;
})();
import { createPortal } from 'react-dom';
import { FileNode, FileType, TaskProgress, Person, PersonSortOption, SortDirection } from '../types';
import { ChevronRight, ChevronDown, Folder, HardDrive, Tag as TagIcon, Plus, User, Check, Copy, Settings, WifiOff, Wifi, Loader2, Maximize2, Brain, Book, Film, Network, ImageIcon, Pause, Layout, ArrowUpDown, Clock, SortAsc, SortDesc, Scan, Download } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { pauseColorExtraction, resumeColorExtraction, getThumbnail, isAndroidPlatformCached } from '../api/tauri-bridge';
import { subscribeToModelDownload, ModelDownloadInfo, getActiveDownloads } from '../utils/modelDownloadState';
import { getGlobalCache } from '../utils/thumbnailCache';
import { isRemotePath, getRemoteThumbnailUrl } from '../utils/remoteSource';
import NetworkSection from './lan-client/NetworkSection';
import MarqueeText from './MarqueeText';
import { PeopleCanvas } from './PeopleCanvas';
import { useAutoScrollbar } from '../hooks/useAutoScrollbar';
import { scrollProfiler } from '../utils/scrollProfiler';

const TagPreviewThumbnail = ({ file, resourceRoot }: { file: FileNode; resourceRoot?: string }) => {
  const isLan = isRemotePath(file.path) || (file.source === 'lan' && !!file.remotePath);
  const [src, setSrc] = useState<string | null>(() => {
    if (!file.path) return null;
    // 远程来源（桌面端服务/安卓设备）：直接使用远程缩略图 URL
    if (isLan && file.remotePath) {
      return getRemoteThumbnailUrl(file.path);
    }
    return getGlobalCache().get(file.path) || null;
  });

  useEffect(() => {
    let active = true;
    // 远程来源：缩略图 URL 直连，跳过本地生成
    if (isLan && file.remotePath) return () => { active = false; };
    if (file.type === FileType.IMAGE && resourceRoot && !src) {
      getThumbnail(file.path, file.meta?.modified, resourceRoot).then(url => {
        if (active && url) {
          setSrc(url);
          getGlobalCache().set(file.path, url);
        }
      });
    }
    return () => { active = false; };
  }, [file.path, file.meta?.modified, resourceRoot, src, isLan, file.remotePath]);

  // 远程来源：使用远程缩略图 URL；本地文件回退到 convertFileSrc
  const displaySrc = (isLan && file.remotePath)
    ? (src || getRemoteThumbnailUrl(file.path))
    : (src || convertFileSrc(file.path));

  return (
    <img 
      src={displaySrc} 
      alt="" 
      className="w-full h-full object-cover"
      style={{ 
        imageRendering: 'high-quality' as any,
        transform: 'translateZ(0)'
      }}
      loading="lazy"
    />
  );
};

interface TreeProps {
  node: FileNode;
  nodeId: string;
  currentFolderId: string;
  expandedSet?: Set<string>;
  hasFolderChildren?: boolean;
  onToggle: (id: string) => void;
  onNavigate: (id: string, options?: { resetScroll?: boolean }) => void;
  onContextMenu: (e: React.MouseEvent, type: 'file' | 'tag' | 'root-folder', id: string) => void;
  onDropOnFolder?: (targetFolderId: string, sourceIds: string[]) => void;
  depth?: number;
  useFolderIcon?: boolean;
}

const TreeNodeInner: React.FC<TreeProps> = ({ node, nodeId, currentFolderId, expandedSet, hasFolderChildren, onToggle, onNavigate, onContextMenu, onDropOnFolder, depth = 0, useFolderIcon }) => {
  const isAndroid = isAndroidPlatformCached();
  const [isDragOverNode, setIsDragOverNode] = useState(false);
  const isDragOverRef = useRef(false);
  

  if (!node || node.type !== FileType.FOLDER) return null;

  const isRoot = depth === 0;
  const isSelected = nodeId === currentFolderId;
  const expanded = !!(expandedSet && expandedSet.has(nodeId));
  
  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(nodeId);
  };

  const handleClick = () => {
    onNavigate(nodeId, { resetScroll: true });
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    if (isAndroid) return;
    onContextMenu(e, isRoot ? 'root-folder' : 'file', nodeId);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    if (!isDragOverRef.current) {
      isDragOverRef.current = true;
      setIsDragOverNode(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (isDragOverRef.current) {
      isDragOverRef.current = false;
      setIsDragOverNode(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverNode(false);

    try {
      const data = e.dataTransfer.getData('application/json');
      if (!data) return;

      const { type, ids } = JSON.parse(data);
      if (type !== 'file' || !ids || ids.length === 0) return;
      // Delegate validation/processing to parent to avoid passing large `files` here
      if (onDropOnFolder) {
        onDropOnFolder(nodeId, ids);
      }
    } catch (error) {
      console.error('Drop handling error:', error);
    }
  };

  const Icon = useFolderIcon
    ? (node.category === 'book' ? Book : node.category === 'sequence' ? Film : Folder)
    : isRoot 
      ? HardDrive 
      : (node.category === 'book' ? Book : node.category === 'sequence' ? Film : Folder);

  const iconColorClass = isSelected ? 'text-white' : (
      node.category === 'book' ? 'text-amber-500' :
      node.category === 'sequence' ? 'text-purple-500' :
      'text-blue-500 dark:text-blue-400'
  );

  return (
    <div className="select-none text-sm text-gray-600 dark:text-gray-300 tree-node-row">
      <div 
        className={`flex items-center px-2 cursor-pointer transition-colors border border-transparent group relative
          ${isDragOverNode ? 'bg-blue-500/30 dark:bg-blue-900/50 border-2 border-blue-400 dark:border-blue-500 ring-2 ring-blue-300/50 dark:ring-blue-700/50' : ''}
          ${isSelected && !isDragOverNode ? 'bg-blue-600 text-white rounded-lg' : !isDragOverNode ? 'hover:bg-surface rounded-lg' : ''}
        `}
        style={{ paddingLeft: `${depth * 12 + 8}px`, ...(isAndroid ? { height: '35px' } : {}), margin: '0 12px' }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div 
          className="p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded"
          onClick={handleToggle}
        >
          {hasFolderChildren ? (
            expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />
          ) : <div className="w-[14px]" />}
        </div>
        <Icon size={16} className={`mr-2 shrink-0 ${iconColorClass}`} />
        <MarqueeText className="flex-1 pointer-events-none" active={isSelected}>{node.name}</MarqueeText>
      </div>

      {/* children are rendered by the virtualized list in Sidebar to avoid recursion */}
    </div>
  );
};

// custom comparator: only re-render when essential props change
const treeNodeEqual = (prev: TreeProps, next: TreeProps) => {
  if (prev.node === next.node && prev.nodeId === next.nodeId && prev.depth === next.depth && prev.hasFolderChildren === next.hasFolderChildren) {
    const prevExpanded = !!(prev.expandedSet && prev.expandedSet.has(prev.nodeId));
    const nextExpanded = !!(next.expandedSet && next.expandedSet.has(next.nodeId));
    if (prevExpanded === nextExpanded && prev.currentFolderId === next.currentFolderId) return true;
  }
  return false;
};

const TreeNode = React.memo(TreeNodeInner, treeNodeEqual);

interface PeopleSectionProps {
  people: Record<string, Person>;
  files: Record<string, FileNode>;
  onPersonSelect: (personId: string) => void;
  onNavigateAllPeople: () => void;
  onContextMenu: (e: React.MouseEvent, type: 'person', id: string) => void;
  onStartRenamePerson: (personId: string) => void;
  onCreatePerson: () => void;
  t: (key: string) => string;
  roots: string[];
  isSelected?: boolean;
}

interface PeopleSectionControlledProps extends PeopleSectionProps {
  expanded: boolean;
  onToggleExpand: () => void;
  listHeight: number;
}

const ROW_HEIGHT = 88;
const COLS = 3;

const PeopleSection: React.FC<PeopleSectionControlledProps> = React.memo(({ 
  people, files, onPersonSelect, onNavigateAllPeople, onContextMenu, onStartRenamePerson, onCreatePerson, t, isSelected, 
  expanded, onToggleExpand, listHeight, roots
}) => {
  const isAndroid = isAndroidPlatformCached();
  const iconSize = isAndroid ? 18 : 14;
  const sortIconSize = isAndroid ? 18 : 14;
  const plusIconSize = isAndroid ? 16 : 14;
  const textClass = isAndroid ? 'text-sm' : 'text-xs';
  const iconMr = isAndroid ? 'mr-2.5' : 'mr-2';
  const chevronMr = isAndroid ? 'mr-1.5' : 'mr-1';
  const sortPad = isAndroid ? 'p-1.5' : 'p-1';
  const [sidebarSortBy, setSidebarSortBy] = useState<PersonSortOption>(() => {
    try {
      const saved = localStorage.getItem('aurora_sidebar_people_sort_by');
      return (saved as PersonSortOption) || 'count';
    } catch (e) {
      return 'count';
    }
  });
  
  const [sidebarSortDirection, setSidebarSortDirection] = useState<SortDirection>(() => {
    try {
      const saved = localStorage.getItem('aurora_sidebar_people_sort_direction');
      return (saved as SortDirection) || 'desc';
    } catch (e) {
      return 'desc';
    }
  });
  
  const handleTogglePersonSort = useCallback(() => {
    if (sidebarSortBy === 'name') {
      if (sidebarSortDirection === 'asc') {
        setSidebarSortDirection('desc');
        try { localStorage.setItem('aurora_sidebar_people_sort_direction', 'desc'); } catch (e) { }
      } else {
        setSidebarSortBy('count');
        setSidebarSortDirection('desc');
        try { 
          localStorage.setItem('aurora_sidebar_people_sort_by', 'count');
          localStorage.setItem('aurora_sidebar_people_sort_direction', 'desc');
        } catch (e) { }
      }
    } else if (sidebarSortBy === 'count') {
      if (sidebarSortDirection === 'asc') {
        setSidebarSortDirection('desc');
        try { localStorage.setItem('aurora_sidebar_people_sort_direction', 'desc'); } catch (e) { }
      } else {
        setSidebarSortBy('created');
        setSidebarSortDirection('desc');
        try { 
          localStorage.setItem('aurora_sidebar_people_sort_by', 'created');
          localStorage.setItem('aurora_sidebar_people_sort_direction', 'desc');
        } catch (e) { }
      }
    } else {
      if (sidebarSortDirection === 'asc') {
        setSidebarSortBy('name');
        setSidebarSortDirection('asc');
        try { 
          localStorage.setItem('aurora_sidebar_people_sort_by', 'name');
          localStorage.setItem('aurora_sidebar_people_sort_direction', 'asc');
        } catch (e) { }
      } else {
        setSidebarSortDirection('asc');
        try { localStorage.setItem('aurora_sidebar_people_sort_direction', 'asc'); } catch (e) { }
      }
    }
  }, [sidebarSortBy, sidebarSortDirection]);
  
  const sortedPeopleList = useMemo(() => {
    const peopleList = Object.values(people || {});
    return [...peopleList].sort((a, b) => {
      let comparison = 0;
      switch (sidebarSortBy) {
        case 'name':
          comparison = a.name.localeCompare(b.name, 'zh-CN');
          break;
        case 'count':
          comparison = a.count - b.count;
          break;
        case 'created':
          const fileA = files[a.coverFileId];
          const fileB = files[b.coverFileId];
          const dateA = fileA?.meta?.created ? new Date(fileA.meta.created).getTime() : 0;
          const dateB = fileB?.meta?.created ? new Date(fileB.meta.created).getTime() : 0;
          comparison = dateA - dateB;
          break;
        default:
          comparison = a.count - b.count;
      }
      return sidebarSortDirection === 'asc' ? comparison : -comparison;
    });
  }, [people, files, sidebarSortBy, sidebarSortDirection]);
  
  const sortedPeople = useMemo(() => {
    const result: Record<string, Person> = {};
    sortedPeopleList.forEach(person => {
      result[person.id] = person;
    });
    return result;
  }, [sortedPeopleList]);
  
  const availableHeight = Math.max(120, listHeight);

  const containerRef = useRef<HTMLDivElement>(null);
  // 左侧面板滚动条：滚动中显示、停止滚动后淡出，悬停滚动条区域时显示并放大（样式见 index.css）
  useAutoScrollbar(containerRef);
  const [containerWidth, setContainerWidth] = useState(200);
  const [localScrollTop, setLocalScrollTop] = useState(0);
  const [selectedPersonId, setSelectedPersonId] = useState<string | undefined>();
  const [isDarkMode, setIsDarkMode] = useState(() => document.documentElement.classList.contains('dark'));
  
  useEffect(() => {
    const observer = new MutationObserver(() => {
      setIsDarkMode(document.documentElement.classList.contains('dark'));
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);
  
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    
    const ro = new ResizeObserver(() => {
      setContainerWidth(el.clientWidth);
    });
    ro.observe(el);
    setContainerWidth(el.clientWidth);
    
    return () => ro.disconnect();
  }, [expanded]);

  const totalHeight = useMemo(() => {
    const rows = Math.ceil(sortedPeopleList.length / COLS);
    return rows * ROW_HEIGHT;
  }, [sortedPeopleList.length]);

  const handlePersonClick = useCallback((id: string, e: React.MouseEvent) => {
    setSelectedPersonId(id);
    onPersonSelect(id);
  }, [onPersonSelect]);

  const handlePersonDoubleClick = useCallback((id: string) => {
    onStartRenamePerson(id);
  }, [onStartRenamePerson]);

  const handlePersonContextMenu = useCallback((e: React.MouseEvent, id: string) => {
    onContextMenu(e, 'person', id);
  }, [onContextMenu]);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setLocalScrollTop(e.currentTarget.scrollTop);
  }, []);

  const getSortTitle = () => {
    if (sidebarSortBy === 'name') {
      return sidebarSortDirection === 'asc' ? `${t('sort.name')} A-Z` : `${t('sort.name')} Z-A`;
    } else if (sidebarSortBy === 'count') {
      return sidebarSortDirection === 'asc' ? `${t('person.fileCount')} ${t('sort.asc')}` : `${t('person.fileCount')} ${t('sort.desc')}`;
    } else {
      return sidebarSortDirection === 'asc' ? `${t('sort.date')} ${t('sort.oldest')}` : `${t('sort.date')} ${t('sort.newest')}`;
    }
  };

  return (
      <div
        data-sidebar-section="people"
        className="select-none text-sm text-gray-600 dark:text-gray-300 relative flex flex-col min-h-0 mt-2 first:mt-0 flex-none"
      >
        <div 
          className={`flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative ${isSelected ? 'text-white rounded-lg' : 'hover:bg-surface rounded-lg'}`}
          style={{ height: isAndroid ? '55px' : '40px', minHeight: isAndroid ? '55px' : '40px', flexShrink: 0, margin: '0 12px', ...(isSelected ? { backgroundColor: '#a855f7' } : {}) }}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('.expand-icon')) {
                e.stopPropagation();
                onToggleExpand();
              } else {
                onNavigateAllPeople();
              }
            }}
        >
          <div className={`expand-icon p-1 ${chevronMr} hover:bg-black/10 dark:hover:bg-white/10 rounded`}>
            {expanded ? <ChevronDown size={iconSize} /> : <ChevronRight size={iconSize} />}
          </div>
          <div className="flex items-center flex-1">
            <Brain size={iconSize} className={`${iconMr} ${isSelected ? 'text-white' : 'text-purple-500 dark:text-purple-400'}`} />
            <span className={`font-bold ${textClass} uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>{t('sidebar.people')} ({sortedPeopleList.length})</span>
          </div>
          {expanded && (
            <div 
              className={`${sortPad} flex items-center justify-center rounded transition-all hover:bg-black/10 dark:hover:bg-white/10 ${isSelected ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-purple-500'}`}
              onClick={(e) => {
                e.stopPropagation();
                handleTogglePersonSort();
              }}
              title={getSortTitle()}
            >
              {sidebarSortBy === 'name' ? (
                sidebarSortDirection === 'asc' ? <SortAsc size={sortIconSize} /> : <SortDesc size={sortIconSize} />
              ) : sidebarSortBy === 'count' ? (
                sidebarSortDirection === 'asc' ? <ArrowUpDown size={sortIconSize} className="rotate-180" /> : <ArrowUpDown size={sortIconSize} />
              ) : (
                <Clock size={sortIconSize} className={sidebarSortDirection === 'asc' ? 'rotate-180' : ''} />
              )}
            </div>
          )}
          <button 
           className={`p-1 rounded transition-colors opacity-0 group-hover:opacity-100 ${isSelected ? 'hover:bg-white/10 dark:hover:bg-white/10' : 'hover:bg-surface'} text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`}
           onClick={(e) => { e.stopPropagation(); onCreatePerson(); }}
           title={t('context.newPerson')}
          >
           <Plus size={plusIconSize} className={`${isSelected ? 'text-white' : ''}`} />
          </button>
        </div>

          {expanded && (
           <div 
             ref={containerRef}
             data-sidebar-list
             className={`pl-5 pr-3 pb-3 mt-1 overflow-y-auto ${isAndroid ? 'no-scrollbar' : 'auto-hide-scrollbar'} min-h-0 bg-panel`}
             style={{ 
               maxHeight: `${availableHeight}px`,
             }}
             onScroll={handleScroll}
           >
             {sortedPeopleList.length === 0 ? (
               <div className="text-xs text-gray-400 italic py-1">{t('sidebar.noPeople')}</div>
             ) : (
               <PeopleCanvas
                 people={sortedPeople}
                 files={files}
                 selectedPersonId={selectedPersonId}
                 onPersonClick={handlePersonClick}
                 onPersonDoubleClick={handlePersonDoubleClick}
                 onPersonContextMenu={handlePersonContextMenu}
                 width={containerWidth - 32}
                 height={totalHeight}
                 scrollTop={localScrollTop}
                 t={t}
                 isDarkMode={isDarkMode}
               />
             )}
           </div>
          )}
      </div>
  );
});

interface TagSectionProps {
  files: Record<string, FileNode>;
  customTags: string[];
  onTagSelect: (tag: string) => void;
  onNavigateAllTags: () => void;
  onContextMenu: (e: React.MouseEvent, type: 'file' | 'tag' | 'tag-background' | 'root-folder', id: string) => void;
  isCreatingTag: boolean;
  onStartCreateTag: () => void;
  onSaveNewTag: (tag: string) => void;
  onCancelCreateTag: () => void;
  t: (key: string) => string;
  roots: string[];
  isSelected?: boolean;
}

interface TagSectionControlledProps extends TagSectionProps {
  expanded: boolean;
  onToggleExpand: () => void;
  listHeight: number;
  rowHeight: number;
  FixedSizeListComp: any;
  filesVersion?: number;
}

const TagSection: React.FC<TagSectionControlledProps> = React.memo(({ 
  files, customTags, onTagSelect, onNavigateAllTags, onContextMenu, 
  isCreatingTag, onStartCreateTag, onSaveNewTag, onCancelCreateTag, t, expanded, onToggleExpand, isSelected, 
  listHeight, rowHeight, FixedSizeListComp, roots, filesVersion
}) => {
    const [hoveredTag, setHoveredTag] = useState<string | null>(null);
    const [hoveredTagPos, setHoveredTagPos] = useState<{top: number, left: number} | null>(null);
    const [tagInputValue, setTagInputValue] = useState('');
  
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tagListRef = useRef<HTMLDivElement | null>(null);
  // 左侧面板滚动条：滚动中显示、停止滚动后淡出，悬停滚动条区域时显示并放大（样式见 index.css）
  useAutoScrollbar(tagListRef);

  const availableHeight = Math.max(120, listHeight);

  const isAndroid = isAndroidPlatformCached();
  const iconSize = isAndroid ? 18 : 14;
  const plusIconSize = isAndroid ? 16 : 14;
  const textClass = isAndroid ? 'text-sm' : 'text-xs';
  const iconMr = isAndroid ? 'mr-2.5' : 'mr-2';
  const chevronMr = isAndroid ? 'mr-1.5' : 'mr-1';

  // 按需虚拟化（与 FolderSection / FileGrid 相同的 renderWindow 思路）：
  // 仅当视口越过已渲染窗口边界时才触发重渲染，窗口内滚动 React 完全不动。
  // 注意：此处 buffer 不能沿用 FileGrid 的 400px！树行高仅 28-35px，400px ≈ 12 行，
  // 会让 DOM 节点数翻倍、每帧合成/绘制成本上升（实测 p50 19ms → 23ms 恶化）。
  // 小 buffer(3 行) 保持 DOM 精简；重渲染本身开销很小（实测重渲染率与 p50 无关）。
  const bufferRows = 3;
  const [localScrollTop, setLocalScrollTop] = useState(0);
  const renderWindowRef = useRef<{ min: number; max: number } | null>(null);
  const tagScrollRafRef = useRef<number | null>(null);

  // 展开/收起或根目录切换时重置滚动位置与渲染窗口
  useEffect(() => {
    renderWindowRef.current = null;
    setLocalScrollTop(0);
    if (tagScrollRafRef.current !== null) {
      cancelAnimationFrame(tagScrollRafRef.current);
      tagScrollRafRef.current = null;
    }
  }, [expanded, roots]);

  // 卸载时取消挂起的 rAF
  useEffect(() => {
    return () => {
      if (tagScrollRafRef.current !== null) {
        cancelAnimationFrame(tagScrollRafRef.current);
        tagScrollRafRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (isCreatingTag) {
      setTagInputValue(t('context.newTagDefault'));
    }
  }, [isCreatingTag, t]);

  useEffect(() => {
    if (isCreatingTag && inputRef.current) {
        inputRef.current.focus();
        inputRef.current.select();
    }
  }, [isCreatingTag]);
  
  useEffect(() => {
    return () => {
      if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    };
  }, []);

  const { sortedTags, tagCounts } = useMemo(() => {
    const allTags = new Set<string>(customTags);
    const counts: Record<string, number> = {};
    
    // Initialize counts for custom tags
    customTags.forEach(tag => {
      counts[tag] = 0;
    });

    // Optimization: avoid Object.values() and forEach which create large temporary arrays and closures.
    // For 68k+ items, a simple for...in loop is much more memory-efficient.
    for (const id in files) {
      const file = files[id];
      const tags = file.tags;
      if (tags && tags.length > 0) {
        for (let i = 0; i < tags.length; i++) {
          const tag = tags[i];
          allTags.add(tag);
          counts[tag] = (counts[tag] || 0) + 1;
        }
      }
    }

    return {
      sortedTags: Array.from(allTags).sort((a, b) => a.localeCompare(b, "zh-CN")),
      tagCounts: counts
    };
  }, [filesVersion, customTags]);

  const suggestions = useMemo(() => {
    if (!isCreatingTag || !tagInputValue) return [];
    const lowerInput = tagInputValue.toLowerCase();
    return sortedTags.filter(t => 
        t.toLowerCase().includes(lowerInput) && t.toLowerCase() !== lowerInput
    ).slice(0, 5);
  }, [isCreatingTag, tagInputValue, sortedTags]);

  const previewImages = useMemo(() => {
    if (!hoveredTag) return [];
    // short-circuit traversal: iterate keys in reverse insertion order and collect up to 3
    const ids = Object.keys(files);
    const res: FileNode[] = [];
    for (let i = ids.length - 1; i >= 0 && res.length < 3; --i) {
      const f = files[ids[i]];
      if (!f) continue;
      if (f.type === FileType.IMAGE && f.tags && f.tags.includes(hoveredTag)) {
        res.push(f);
      }
    }
    return res;
  }, [hoveredTag, files]);

  const handleTagScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const st = e.currentTarget.scrollTop;
    const win = renderWindowRef.current;
    // 用缓存的 availableHeight 代替 clientHeight——clientHeight 会强制同步布局
    const containerH = availableHeight;
    // 创建标签时输入框需实时跟随列表，强制每帧更新窗口
    if (!isCreatingTag && win && st >= win.min && st + containerH <= win.max) return;
    // 越过窗口边界 → rAF 合并到每帧一次，更新渲染窗口并重渲染
    if (tagScrollRafRef.current !== null) return;
    tagScrollRafRef.current = requestAnimationFrame(() => {
      tagScrollRafRef.current = null;
      const el = tagListRef.current;
      if (!el) return;
      const st2 = el.scrollTop;
      const total = sortedTags.length;
      const viewportRows = Math.ceil(availableHeight / rowHeight);
      const first = Math.max(0, Math.floor(st2 / rowHeight) - bufferRows);
      const last = Math.min(total, first + viewportRows + bufferRows * 2);
      renderWindowRef.current = { min: first * rowHeight, max: last * rowHeight };
      setLocalScrollTop(st2);
    });
  }, [availableHeight, sortedTags.length, rowHeight, bufferRows, isCreatingTag]);

  const handleMouseEnter = useCallback((e: React.MouseEvent, tag: string) => {
    const target = e.currentTarget as HTMLElement;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    
    hoverTimerRef.current = setTimeout(() => {
      const rect = target.getBoundingClientRect();
      const PREVIEW_HEIGHT = 200;
      const VIEWPORT_HEIGHT = window.innerHeight;
      let top = rect.top;
      if (top + PREVIEW_HEIGHT > VIEWPORT_HEIGHT) {
        top = VIEWPORT_HEIGHT - PREVIEW_HEIGHT - 20; 
      }
      if (top < 10) top = 10;
      setHoveredTagPos({ top, left: rect.right + 10 });
      setHoveredTag(tag);
    }, 1000);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredTag(null);
    setHoveredTagPos(null);
  }, []);

  const listContent = useMemo(() => {
    if (!expanded) return null;
    if (sortedTags.length === 0) {
      return !isCreatingTag && <div className="text-xs text-gray-400 italic px-2 py-1">{t('sidebar.rightClickToAdd')}</div>;
    }

    const currentST = localScrollTop;

    if (FixedSizeListComp) {
      return (
        <FixedSizeListComp
          height={Math.min(sortedTags.length * rowHeight, availableHeight)}
          itemCount={sortedTags.length}
          itemSize={rowHeight}
          width={'100%'}
          initialScrollOffset={currentST}
          itemData={{ 
            tags: sortedTags, tagCounts, onTagSelect, onContextMenu, 
            handleMouseEnter, handleMouseLeave, hoveredTag, previewImages, hoveredTagPos, createPortal, t, roots 
          }}
        >
          {({ index, style, data }: any) => {
            const tag = data.tags[index];
            return (
              <div 
                style={style}
                key={tag}
                className="relative group"
                onMouseEnter={(e) => data.handleMouseEnter(e, tag)}
                onMouseLeave={data.handleMouseLeave}
                onContextMenu={(e) => !isAndroid && data.onContextMenu(e, 'tag', tag)}
              >
                <div 
                  className={`py-1 px-2 rounded cursor-pointer flex items-center justify-between transition-colors
                     hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:text-blue-700 dark:text-gray-300 dark:hover:text-blue-300 border border-transparent
                  `}
                  onClick={() => data.onTagSelect(tag)}
                >
                   <div className="flex items-center min-w-0">
                     <TagIcon size={12} className="mr-2 opacity-70 flex-none" />
                     <span className="pointer-events-none truncate">{tag}</span>
                   </div>
                   <span className="text-[10px] text-gray-500 dark:text-gray-600 bg-surface px-1.5 rounded-full pointer-events-none ml-2">
                     {data.tagCounts[tag] || 0}
                   </span>
                </div>
                
                {data.hoveredTag === tag && data.previewImages.length > 0 && data.hoveredTagPos && data.createPortal(
                  <div 
                    className="fixed z-[100] bg-white dark:bg-[#262626] border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl p-3 w-64 animate-fade-in pointer-events-none"
                    style={{ top: data.hoveredTagPos.top, left: data.hoveredTagPos.left }}
                  >
                    <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 border-b border-gray-200 dark:border-gray-700 pb-1 font-bold flex items-center justify-between">
                       <span>{data.t('sidebar.tagPreview')} "{data.hoveredTag}"</span>
                       <span className="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 rounded">{data.previewImages.length} {data.t('sidebar.recent')}</span>
                    </div>
                    <div className="grid grid-cols-3 gap-2">
                       {data.previewImages.map((img: any) => (
                        <div key={img.id} className="aspect-square bg-gray-100 dark:bg-black rounded border border-gray-200 dark:border-gray-800 overflow-hidden relative">
                           <TagPreviewThumbnail file={img} resourceRoot={data.roots?.[0]} />
                           <div className="absolute inset-0 flex items-center justify-center bg-surface -z-10">
                             <ImageIcon className="text-gray-400 dark:text-gray-500" size={20} />
                           </div>
                        </div>
                      ))}
                    </div>
                  </div>,
                  document.body
                )}
              </div>
            );
          }}
        </FixedSizeListComp>
      );
    }

    const total = sortedTags.length;
    const totalHeight = total * rowHeight;
    const viewportRows = Math.ceil(availableHeight / rowHeight);
    const first = Math.max(0, Math.floor(currentST / rowHeight) - bufferRows);
    const last = Math.min(total, first + viewportRows + bufferRows * 2);
    const slice = sortedTags.slice(first, last);

    // 用 absolute + transform 合成层定位（与 FileGrid 卡片一致）。
    // 滚动时浏览器只做合成平移、不重新布局，避免文档流强制重排。
    return (
      <div style={{ height: totalHeight, position: 'relative' }}>
        {slice.map((tag, i) => (
          <div 
            key={tag}
            className="relative group"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: rowHeight,
              transform: `translateY(${(first + i) * rowHeight}px)`,
              willChange: 'transform'
            }}
            onMouseEnter={(e) => handleMouseEnter(e, tag)}
            onMouseLeave={handleMouseLeave}
            onContextMenu={(e) => !isAndroid && onContextMenu(e, 'tag', tag)}
          >
            <div 
              className={`py-1 px-2 rounded cursor-pointer flex items-center justify-between transition-colors
                 hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:text-blue-700 dark:text-gray-300 dark:hover:text-blue-300 border border-transparent
              `}
              onClick={() => onTagSelect(tag)}
            >
               <div className="flex items-center min-w-0">
                 <TagIcon size={12} className="mr-2 opacity-70 flex-none" />
                 <span className="pointer-events-none truncate">{tag}</span>
               </div>
               <span className="text-[10px] text-gray-500 dark:text-gray-600 bg-surface px-1.5 rounded-full pointer-events-none ml-2">
                 {tagCounts[tag] || 0}
               </span>
            </div>
            
            {hoveredTag === tag && previewImages.length > 0 && hoveredTagPos && createPortal(
              <div 
                className="fixed z-[100] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl p-3 w-64 animate-fade-in pointer-events-none" 
                style={{ top: hoveredTagPos.top, left: hoveredTagPos.left }}
              >
                <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 border-b border-gray-200 dark:border-gray-700 pb-1 font-bold flex items-center justify-between">
                   <span>{t('sidebar.tagPreview')} "{hoveredTag}"</span>
                   <span className="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 rounded">{previewImages.length} {t('sidebar.recent')}</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  {previewImages.map(img => (
                    <div key={img.id} className="aspect-square bg-gray-100 dark:bg-black rounded border border-gray-200 dark:border-gray-800 overflow-hidden relative">
                       <TagPreviewThumbnail file={img} resourceRoot={roots?.[0]} />
                       <div className="absolute inset-0 flex items-center justify-center bg-gray-200 dark:bg-gray-700 -z-10">
                         <ImageIcon className="text-gray-400 dark:text-gray-500" size={20} />
                       </div>
                    </div>
                  ))}
                </div>
              </div>,
              document.body
            )}
          </div>
        ))}
      </div>
    );
  }, [expanded, sortedTags, tagCounts, onTagSelect, onContextMenu, rowHeight, availableHeight, FixedSizeListComp, handleMouseEnter, handleMouseLeave, hoveredTag, previewImages, hoveredTagPos, t, localScrollTop, sortedTags.length, isCreatingTag]);

  return (
    <div
      data-sidebar-section="tags"
      className="select-none text-sm text-gray-600 dark:text-gray-300 relative flex flex-col min-h-0 mt-2 first:mt-0 flex-none"
    >
       <div 
        className={`flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative ${isSelected ? 'text-white rounded-lg' : 'hover:bg-surface rounded-lg'}`}
        style={{ height: isAndroid ? '55px' : '40px', minHeight: isAndroid ? '55px' : '40px', flexShrink: 0, margin: '0 12px', ...(isSelected ? { backgroundColor: '#5391f6' } : {}) }}
      >
         <div className={`p-1 ${chevronMr} hover:bg-black/10 dark:hover:bg-white/10 rounded`} onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}>
           {expanded ? <ChevronDown size={iconSize} /> : <ChevronRight size={iconSize} />}
        </div>
        <div className="flex items-center flex-1" onClick={onNavigateAllTags}>
          <TagIcon size={iconSize} className={`${iconMr} ${isSelected ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`} />
          <span className={`font-bold ${textClass} uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>{t('sidebar.allTags')} ({sortedTags.length})</span>
        </div>
        <button 
           className={`p-1 rounded transition-colors opacity-0 group-hover:opacity-100 ${isSelected ? 'hover:bg-white/10 dark:hover:bg-white/10' : 'hover:bg-surface'} text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`}
           onClick={(e) => { e.stopPropagation(); onStartCreateTag(); }}
           title={t('context.newTag')}
        >
           <Plus size={plusIconSize} className={`${isSelected ? 'text-white' : ''}`} />
        </button>
      </div>

      {expanded && (
        <div 
          ref={tagListRef}
          data-sidebar-list
          className={`pl-5 pr-3 pb-3 space-y-0.5 min-h-[40px] overflow-y-auto ${isAndroid ? 'no-scrollbar' : 'auto-hide-scrollbar'} bg-panel`}
          style={{ 
            maxHeight: `${availableHeight}px`,
            // 合成边界：把滚动容器的布局/绘制与外部隔离，减少滚动时每帧重新合成的范围
            contain: 'layout paint style'
          }}
          onScroll={handleTagScroll}
          onContextMenu={(e) => { 
            if (isAndroid) return;
            e.preventDefault(); 
            e.stopPropagation(); 
            onContextMenu(e, 'tag-background', ''); 
          }}
        >
          {isCreatingTag && (
             <div className="py-1 px-2 relative z-20">
                 <input
                    ref={inputRef}
                    value={tagInputValue}
                    onChange={(e) => setTagInputValue(e.target.value)}
                    className="w-full bg-white dark:bg-[#3a3a3a] border border-blue-500 rounded px-2 py-1 text-sm text-gray-900 dark:text-gray-200 focus:outline-none shadow-sm placeholder-gray-400"
                    placeholder={t('context.enterTagName')}
                    onKeyDown={(e) => {
                       if (e.key === 'Enter') {
                          e.preventDefault();
                          onSaveNewTag(tagInputValue);
                       }
                       if (e.key === 'Escape') {
                          e.preventDefault();
                          onCancelCreateTag();
                       }
                    }}
                    onBlur={(e) => {
                       setTimeout(() => onSaveNewTag(tagInputValue), 150);
                    }}
                    onClick={e => e.stopPropagation()}
                 />
                 
                 {suggestions.length > 0 && (
                     <ul className="absolute left-2 right-2 top-full mt-1 bg-white dark:bg-[#3a3a3a] border border-gray-200 dark:border-gray-800 rounded-md shadow-lg z-50 overflow-hidden">
                         {suggestions.map(tag => (
                             <li 
                                key={tag}
                                onMouseDown={(e) => {
                                    e.preventDefault(); 
                                    onSaveNewTag(tag);
                                }}
                                className="px-2 py-1.5 hover:bg-blue-50 dark:hover:bg-blue-900/30 text-gray-700 dark:text-gray-200 cursor-pointer flex items-center text-xs"
                             >
                                <TagIcon size={10} className="mr-1.5 opacity-50"/>
                                {tag}
                             </li>
                         ))}
                     </ul>
                 )}
              </div>
          )}

          {listContent}
        </div>
      )}
    </div>
  );
});

interface TopicSectionProps {
  onNavigateTopics: () => void;
  onCreateTopic: () => void;
  t: (key: string) => string;
  isSelected?: boolean;
}

const TopicSection: React.FC<TopicSectionProps> = React.memo(({ onNavigateTopics, onCreateTopic, t, isSelected }) => {
  const isAndroid = isAndroidPlatformCached();
  const iconSize = isAndroid ? 18 : 14;
  const plusIconSize = isAndroid ? 16 : 14;
  const textClass = isAndroid ? 'text-sm' : 'text-xs';
  const iconMr = isAndroid ? 'mr-2.5' : 'mr-2';
  return (
      <div data-sidebar-section="topic" className="select-none text-sm text-gray-600 dark:text-gray-300 relative mt-2 first:mt-0">
        <div
          className={`flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative ${isSelected ? 'text-white rounded-lg' : 'hover:bg-surface rounded-lg'}`}
          style={{ height: isAndroid ? '55px' : '40px', minHeight: isAndroid ? '55px' : '40px', flexShrink: 0, margin: '0 12px', ...(isSelected ? { backgroundColor: '#ee5ea5' } : {}) }}
          onClick={onNavigateTopics}
        >
          <div className={`p-1 rounded w-[${isAndroid ? 26 : 22}px] h-[${isAndroid ? 26 : 22}px] flex items-center justify-center opacity-0`}>
            <ChevronRight size={iconSize} />
          </div>
          <div className="flex items-center flex-1">
            <Layout size={iconSize} className={`${iconMr} ${isSelected ? 'text-white' : 'text-pink-500 dark:text-pink-400'}`} />
            <span className={`font-bold ${textClass} uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>{t('sidebar.topics')}</span>
          </div>
          <button
           className={`p-1 rounded transition-colors opacity-0 group-hover:opacity-100 ${isSelected ? 'hover:bg-white/10 dark:hover:bg-white/10' : 'hover:bg-surface'} text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`}
           onClick={(e) => { e.stopPropagation(); onCreateTopic(); }}
           title={t('context.newTopic')}
          >
           <Plus size={plusIconSize} className={`${isSelected ? 'text-white' : ''}`} />
          </button>
        </div>
      </div>
  );
});

interface CanvasSectionProps {
  onOpenCanvas: () => void;
  t: (key: string) => string;
  isSelected?: boolean;
}

const CanvasSection: React.FC<CanvasSectionProps> = React.memo(({ onOpenCanvas, t, isSelected }) => {
  const isAndroid = isAndroidPlatformCached();
  const iconSize = isAndroid ? 18 : 14;
  const textClass = isAndroid ? 'text-sm' : 'text-xs';
  const iconMr = isAndroid ? 'mr-2.5' : 'mr-2';
  return (
      <div data-sidebar-section="canvas" className="select-none text-sm text-gray-600 dark:text-gray-300 relative mt-2 first:mt-0">
        <div 
          className={`flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative ${isSelected ? 'text-white rounded-lg' : 'hover:bg-surface rounded-lg'}`}
          style={{ height: isAndroid ? '55px' : '40px', minHeight: isAndroid ? '55px' : '40px', flexShrink: 0, margin: '0 12px', ...(isSelected ? { backgroundColor: '#10b981' } : {}) }}
          onClick={onOpenCanvas}
        >
          <div className={`p-1 rounded w-[${isAndroid ? 26 : 22}px] h-[${isAndroid ? 26 : 22}px] flex items-center justify-center opacity-0`}>
            <ChevronRight size={iconSize} />
          </div>
          <div className="flex items-center flex-1">
            <Scan size={iconSize} className={`${iconMr} ${isSelected ? 'text-white' : 'text-emerald-500 dark:text-emerald-400'}`} />
            <span className={`font-bold ${textClass} uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>{t('sidebar.canvas')}</span>
          </div>
        </div>
      </div>
  );
});

interface FolderSectionProps {
  visibleNodes: any[];
  files: Record<string, FileNode>;
  roots: string[];
  currentFolderId: string;
  expandedSet: Set<string>;
  onToggle: (id: string) => void;
  onNavigate: (id: string, options?: { resetScroll?: boolean }) => void;
  onContextMenu: (e: React.MouseEvent, type: any, id: string) => void;
  onDropOnFolder?: (targetFolderId: string, sourceIds: string[]) => void;
  expanded: boolean;
  onToggleExpand: () => void;
  listHeight: number;
  rowHeight: number;
  FixedSizeListComp: any;
  containerRef: React.RefObject<HTMLDivElement>;
  t: (key: string) => string;
  sortMode?: 'name' | 'date';
  sortOrder?: 'asc' | 'desc';
  onToggleSort?: () => void;
  onNavigateHome?: () => void;
}

const FolderSection: React.FC<FolderSectionProps> = React.memo(({
  visibleNodes, files, roots, currentFolderId, expandedSet, onToggle, onNavigate, onContextMenu, onDropOnFolder,
  expanded, onToggleExpand, listHeight, rowHeight, FixedSizeListComp, containerRef, t,
  sortMode = 'name', sortOrder = 'asc', onToggleSort, onNavigateHome
}) => {
  // 左侧面板滚动条：滚动中显示、停止滚动后淡出，悬停滚动条区域时显示并放大（样式见 index.css）
  useAutoScrollbar(containerRef);
  // 滚动性能记录器：测量文件夹树滚动期间的帧耗时/掉帧（与文件网格共用「滚动性能记录」开关，
  // 会话按目标独立记录，报告区分文件网格与文件夹树）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    scrollProfiler.attach(el, 'tree-sidebar');
    return () => {
      scrollProfiler.detach(el);
    };
  }, [containerRef, expanded]);
  const isSingleRoot = roots.length === 1;
  const rootId = roots[0];
  const rootNode = files[rootId];
  const isSelected = isSingleRoot && currentFolderId === rootId;
  const isAndroid = isAndroidPlatformCached();
  const iconSize = isAndroid ? 18 : 14;
  const sortIconSize = isAndroid ? 18 : 14;
  const textClass = isAndroid ? 'text-sm' : 'text-xs';
  const iconMr = isAndroid ? 'mr-2.5' : 'mr-2';
  const chevronMr = isAndroid ? 'mr-1.5' : 'mr-1';
  const sortPad = isAndroid ? 'p-1.5' : 'p-1';

  const displayNodes = useMemo(() => {
    if (isSingleRoot) {
      return visibleNodes.filter(n => n.id !== rootId);
    }
    return visibleNodes;
  }, [visibleNodes, isSingleRoot, rootId]);

  // Calculate actual viewport height available for the list
  // （由侧边栏按各分区固定部分实测后传入，见 Sidebar 中 listCap 计算）
  const availableHeight = Math.max(120, listHeight);

  const handleHeaderClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.expand-icon')) {
      e.stopPropagation();
      onToggleExpand();
    } else if (onNavigateHome) {
      onNavigateHome();
    } else {
      onNavigate(rootId, { resetScroll: true });
    }
  };

  const [isDragOver, setIsDragOver] = useState(false);
  const handleDragOver = (e: React.DragEvent) => {
    if (!isSingleRoot) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };
  const handleDragLeave = () => setIsDragOver(false);
  const handleDrop = (e: React.DragEvent) => {
    if (!isSingleRoot || !onDropOnFolder) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    try {
      const data = e.dataTransfer.getData('application/json');
      const { type, ids } = JSON.parse(data);
      if (type === 'file' && ids) onDropOnFolder(rootId, ids);
    } catch (err) {}
  };

  // 按需虚拟化（与 FileGrid 相同的 renderWindow 思路）：
  // scrollTop 由本组件局部管理，仅当视口越过已渲染窗口边界时才触发重渲染。
  // 窗口内滚动时 React 完全不动，滚动帧零 JS 重渲染，消除"滚动即整树重渲染"的掉帧根源。
  // 注意：此处 buffer 不能沿用 FileGrid 的 400px！树行高仅 28-35px，400px ≈ 12 行，
  // 会让 DOM 节点数翻倍、每帧合成/绘制成本上升（实测 p50 19ms → 23ms 恶化）。
  // 小 buffer(3 行) 保持 DOM 精简；重渲染本身开销很小（实测重渲染率与 p50 无关）。
  const bufferRows = 3;
  const [localScrollTop, setLocalScrollTop] = useState(0);
  const renderWindowRef = useRef<{ min: number; max: number } | null>(null);
  const sectionScrollRafRef = useRef<number | null>(null);

  // 滚动窗口变化后同步 DOM 节点数（供滚动性能记录器统计树节点挂载量）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const win = window as any;
    win.__AURORA_RENDER_COUNTS__ = win.__AURORA_RENDER_COUNTS__ || {};
    try {
      // 树节点标签现在用 MarqueeText 渲染（span.aurora-marquee）
      win.__AURORA_RENDER_COUNTS__.treeSidebarDOM = el.querySelectorAll('span.truncate, span.aurora-marquee').length;
    } catch {
      win.__AURORA_RENDER_COUNTS__.treeSidebarDOM = 0;
    }
  }, [localScrollTop, expanded]);

  const handleSectionScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const st = e.currentTarget.scrollTop;
    const win = renderWindowRef.current;
    // 用缓存的 availableHeight 代替 clientHeight——clientHeight 会强制同步布局
    const containerH = availableHeight;
    // 视口仍在已渲染窗口内 → 完全不触发 React 更新
    if (win && st >= win.min && st + containerH <= win.max) return;
    // 越过窗口边界 → rAF 合并到每帧一次，更新渲染窗口并重渲染
    if (sectionScrollRafRef.current !== null) return;
    sectionScrollRafRef.current = requestAnimationFrame(() => {
      sectionScrollRafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      const st2 = el.scrollTop;
      const total = displayNodes.length;
      const viewportRows = Math.ceil(availableHeight / rowHeight);
      const first = Math.max(0, Math.floor(st2 / rowHeight) - bufferRows);
      const last = Math.min(total, first + viewportRows + bufferRows * 2);
      renderWindowRef.current = { min: first * rowHeight, max: last * rowHeight };
      setLocalScrollTop(st2);
      // 统计真正的滚动窗口更新次数（供滚动性能记录器使用，不含 hover 等非滚动因素）。
      const _win = window as any;
      if (_win.__AURORA_RENDER_COUNTS__) {
        _win.__AURORA_RENDER_COUNTS__.treeSidebarRenders = (_win.__AURORA_RENDER_COUNTS__.treeSidebarRenders || 0) + 1;
      }
    });
  }, [availableHeight, displayNodes.length, rowHeight, bufferRows]);

  // 展开/收起或根目录切换时重置滚动位置与渲染窗口
  useEffect(() => {
    renderWindowRef.current = null;
    setLocalScrollTop(0);
    if (sectionScrollRafRef.current !== null) {
      cancelAnimationFrame(sectionScrollRafRef.current);
      sectionScrollRafRef.current = null;
    }
  }, [expanded, roots]);

  // 卸载时取消挂起的 rAF
  useEffect(() => {
    return () => {
      if (sectionScrollRafRef.current !== null) {
        cancelAnimationFrame(sectionScrollRafRef.current);
        sectionScrollRafRef.current = null;
      }
    };
  }, []);

  const listContent = useMemo(() => {
    if (!expanded) return null;
    if (displayNodes.length === 0) {
      return (
        <div className="px-10 py-4 text-xs text-gray-400 italic">
          {t('sidebar.noFolders')}
        </div>
      );
    }

    const currentST = localScrollTop;

    if (FixedSizeListComp) {
      return (
        <FixedSizeListComp
          height={Math.min(displayNodes.length * rowHeight, availableHeight)}
          itemCount={displayNodes.length}
          itemSize={rowHeight}
          width={'100%'}
          initialScrollOffset={currentST}
          itemData={{ visibleNodes: displayNodes, files, currentFolderId, expandedSet, onToggle, onNavigate, onContextMenu, onDropOnFolder, useFolderIcon: isAndroid }}
        >
          {({ index, style, data }: any) => {
            const nodeItem = data.visibleNodes[index];
            return (
              <div style={style} key={nodeItem.id}>
                <TreeNode
                  node={nodeItem.node}
                  nodeId={nodeItem.id}
                  currentFolderId={data.currentFolderId}
                  expandedSet={data.expandedSet}
                  hasFolderChildren={nodeItem.hasFolderChildren}
                  onToggle={data.onToggle}
                  onNavigate={data.onNavigate}
                  onContextMenu={data.onContextMenu}
                  onDropOnFolder={data.onDropOnFolder}
                  depth={nodeItem.depth}
                  useFolderIcon={data.useFolderIcon}
                />
              </div>
            );
          }}
        </FixedSizeListComp>
      );
    }

    // Manual virtualization fallback
    const total = displayNodes.length;
    const totalHeight = total * rowHeight;
    const viewportRows = Math.ceil(availableHeight / rowHeight);
    const first = Math.max(0, Math.floor(currentST / rowHeight) - bufferRows);
    const last = Math.min(total, first + viewportRows + bufferRows * 2);
    const slice = displayNodes.slice(first, last);

    // 用 absolute + transform 合成层定位（与 FileGrid 卡片一致）。
    // 每个节点绝对定位 + translateY，滚动时浏览器只做合成平移、不重新布局。
    // 避免文档流布局在滚动帧中的强制重排（这是此前 p50 卡在 ~22ms 的根因）。
    return (
      <div style={{ height: totalHeight, position: 'relative' }}>
        {slice.map((nodeItem, i) => (
          <div
            key={nodeItem.id}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              right: 0,
              height: rowHeight,
              transform: `translateY(${(first + i) * rowHeight}px)`,
              willChange: 'transform'
            }}
          >
            <TreeNode
              node={nodeItem.node}
              nodeId={nodeItem.id}
              currentFolderId={currentFolderId}
              expandedSet={expandedSet}
              hasFolderChildren={nodeItem.hasFolderChildren}
              onToggle={onToggle}
              onNavigate={onNavigate}
              onContextMenu={onContextMenu}
              onDropOnFolder={onDropOnFolder}
              depth={nodeItem.depth}
              useFolderIcon={isAndroid}
            />
          </div>
        ))}
      </div>
    );
  }, [
    expanded, displayNodes, rowHeight, availableHeight, FixedSizeListComp, 
    currentFolderId, expandedSet, t, onToggle, onNavigate, onContextMenu, onDropOnFolder,
    localScrollTop, displayNodes.length
  ]);

  return (
    <div
      data-sidebar-section="folder"
      className="select-none text-sm text-gray-600 dark:text-gray-300 relative flex flex-col min-h-0 mt-2 first:mt-0 flex-none"
    >
      <div 
        className={`flex items-center px-3 cursor-pointer transition-colors border border-transparent group relative
          ${isDragOver ? 'bg-blue-500/30 border-2 border-blue-400 ring-2 ring-blue-300/50' : ''}
          ${isSelected && !isDragOver ? 'bg-blue-600 text-white rounded-lg' : !isDragOver ? 'hover:bg-surface rounded-lg' : ''}`}
        style={{ height: isAndroid ? '55px' : '40px', minHeight: isAndroid ? '55px' : '40px', flexShrink: 0, margin: '0 12px' }}
        onClick={handleHeaderClick}
        onContextMenu={(e) => !isAndroid && isSingleRoot && onContextMenu(e, 'root-folder', rootId)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className={`expand-icon p-1 ${chevronMr} hover:bg-black/10 dark:hover:bg-white/10 rounded`}>
          {expanded ? <ChevronDown size={iconSize} /> : <ChevronRight size={iconSize} />}
        </div>
        <div className="flex items-center flex-1">
          <HardDrive size={iconSize} className={`${iconMr} ${isSelected ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`} />
          <span className={`font-bold ${textClass} uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>
            {isSingleRoot && rootNode ? rootNode.name : "本地相册"}
          </span>
        </div>
        {onToggleSort && (
          <div 
            className={`${sortPad} flex items-center justify-center rounded transition-all hover:bg-black/10 dark:hover:bg-white/10 ${isSelected ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-blue-500'}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSort();
            }}
            title={sortMode === 'name' ? (sortOrder === 'asc' ? 'A-Z' : 'Z-A') : (sortOrder === 'desc' ? t('sort.newest') : t('sort.oldest'))}
          >
            {sortMode === 'name' ? (
               sortOrder === 'asc' ? <SortAsc size={sortIconSize} /> : <SortDesc size={sortIconSize} />
            ) : (
               <Clock size={sortIconSize} className={sortOrder === 'asc' ? 'rotate-180' : ''} />
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div 
          ref={containerRef} 
          data-sidebar-list
          onScroll={handleSectionScroll} 
          className={`overflow-y-auto ${isAndroid ? 'no-scrollbar' : 'auto-hide-scrollbar'} min-h-0`}
          style={{ 
            maxHeight: `${availableHeight}px`,
            // 合成边界：把滚动容器的布局/绘制与外部隔离，减少滚动时每帧重新合成的范围
            contain: 'layout paint style'
          }}
        >
          {listContent}
        </div>
      )}
    </div>
  );
});

export const Sidebar: React.FC<{
  roots: string[];
  files: Record<string, FileNode>;
  people: Record<string, Person>;
  customTags: string[];
  currentFolderId: string;
  expandedIds: string[];
  tasks?: TaskProgress[];
  onToggle: (id: string) => void;
  onNavigate: (id: string, options?: { resetScroll?: boolean }) => void;
  onTagSelect: (tag: string) => void;
  onNavigateAllTags: () => void;
  onPersonSelect: (personId: string) => void;
  onNavigateAllPeople: () => void;
  onContextMenu: (e: React.MouseEvent, type: 'file' | 'tag' | 'tag-background' | 'root-folder' | 'person', id: string) => void;
  isCreatingTag: boolean;
  onStartCreateTag: () => void;
  onSaveNewTag: (tag: string) => void;
  onCancelCreateTag: () => void;
  onOpenSettings: () => void;
  onRestoreTask: (taskId: string) => void;
  onPauseResume: (taskId: string, taskType: string) => void;
  onStartRenamePerson: (personId: string) => void;
  onCreatePerson: () => void;
  onNavigateTopics: () => void;
  onCreateTopic: () => void;
  onDropOnFolder?: (targetFolderId: string, sourceIds: string[]) => void;
  onOpenCanvas?: () => void;
  onNavigateHome?: () => void;
  lanRoots?: string[];
  lanConnected?: boolean;
  lanLoading?: boolean;
  onNavigateNetworkFolder?: (folderId: string) => void;
  onNavigateNetworkHome?: () => void;
  onOpenLanSettings?: () => void;
  androidDevices?: import('./android-client/androidClientTypes').AndroidDeviceInfo[];
  androidActiveKey?: string;
  onNavigateAndroidFolder?: (folderId: string) => void;
  onNavigateAndroidHome?: (key: string) => void;
  onOpenAndroidSettings?: () => void;
  t: (key: string) => string;
  aiConnectionStatus?: 'connected' | 'disconnected' | 'checking';
  activeViewMode?: string;
  filesVersion?: number;
}> = React.memo(({ roots, files, people, customTags, currentFolderId, expandedIds, tasks, onToggle, onNavigate, onTagSelect, onNavigateAllTags, onPersonSelect, onNavigateAllPeople, onContextMenu, isCreatingTag, onStartCreateTag, onSaveNewTag, onCancelCreateTag, onOpenSettings, onRestoreTask, onPauseResume, onStartRenamePerson, onCreatePerson, onNavigateTopics, onCreateTopic, onDropOnFolder, onOpenCanvas, onNavigateHome, lanRoots, lanConnected = false, lanLoading = false, onNavigateNetworkFolder, onNavigateNetworkHome, onOpenLanSettings, androidDevices = [], androidActiveKey = '', onNavigateAndroidFolder, onNavigateAndroidHome, onOpenAndroidSettings, activeViewMode = 'browser', t, aiConnectionStatus = 'disconnected', filesVersion }) => {
  
  const minimizedTasks = tasks ? tasks.filter(task => task.minimized) : [];
  
  const handlePauseResume = (taskId: string, taskType: string) => {
    if (taskType !== 'color') return;
    onPauseResume(taskId, taskType);
  };

  // 模型下载进度状态
  const [modelDownloads, setModelDownloads] = useState<ModelDownloadInfo[]>([]);
  
  // 订阅模型下载进度
  useEffect(() => {
    // 初始化时获取当前活跃的下载
    const activeDownloads = getActiveDownloads();
    setModelDownloads(activeDownloads);
    
    // 订阅下载进度变化
    const unsubscribe = subscribeToModelDownload((modelName, info) => {
      setModelDownloads(prev => {
        const filtered = prev.filter(d => d.modelName !== modelName);
        if (info.status === 'downloading' || info.status === 'paused') {
          // 下载中或暂停都持续显示
          return [...filtered, info];
        } else if (info.status === 'completed' || info.status === 'error') {
          // 完成后短暂显示，然后移除
          return [...filtered, info];
        }
        return filtered;
      });
      
      // 如果是完成或错误状态，3秒后移除
      if (info.status === 'completed' || info.status === 'error') {
        setTimeout(() => {
          setModelDownloads(prev => prev.filter(d => d.modelName !== modelName));
        }, 3000);
      }
    });
    
    return () => {
      unsubscribe();
    };
  }, []);

  // Memoize expanded ids as a Set to keep stable reference for TreeNode children
  const expandedSet = useMemo(() => new Set(expandedIds || []), [ (expandedIds || []).join('|') ]);

  // Only consider currentFolderId for node selection when in 'browser' view
  const currentFolderForNodes = activeViewMode === 'browser' ? currentFolderId : '';

  // active section controls which primary section is expanded in the sidebar
  const [activeSection, setActiveSection] = useState<'roots' | 'people' | 'tags' | 'topics' | 'lanNetwork' | null>('roots');
  // 桌面端：当前展开文件夹列表的安卓设备 key（与 activeSection 互斥机制联动，
  // 同一时间只允许展开一个分区）
  const [expandedAndroidKey, setExpandedAndroidKey] = useState<string | null>(null);

  // 切换到其他分区时收起安卓设备文件夹列表（分区互斥）
  useEffect(() => {
    if (activeSection !== 'lanNetwork' && expandedAndroidKey !== null) {
      setExpandedAndroidKey(null);
    }
  }, [activeSection, expandedAndroidKey]);

  const handleToggleAndroidDevice = useCallback((key: string) => {
    setActiveSection('lanNetwork');
    setExpandedAndroidKey((prev) => (prev === key ? null : key));
  }, []);

  // Sidebar sorting state with persistence
  const [folderSortMode, setFolderSortMode] = useState<'name' | 'date'>(() => 
    (localStorage.getItem('aurora_sidebar_folder_sort_mode') as 'name' | 'date') || 'name'
  );
  const [folderSortOrder, setFolderSortOrder] = useState<'asc' | 'desc'>(() => 
    (localStorage.getItem('aurora_sidebar_folder_sort_order') as 'asc' | 'desc') || 'asc'
  );

  const handleToggleFolderSort = useCallback(() => {
    let nextMode: 'name' | 'date' = folderSortMode;
    let nextOrder: 'asc' | 'desc' = folderSortOrder;

    if (folderSortMode === 'name') {
      if (folderSortOrder === 'asc') {
        nextOrder = 'desc';
      } else {
        nextMode = 'date';
        nextOrder = 'desc'; // Newest first by default
      }
    } else {
      if (folderSortOrder === 'desc') {
        nextOrder = 'asc';
      } else {
        nextMode = 'name';
        nextOrder = 'asc';
      }
    }

    setFolderSortMode(nextMode);
    setFolderSortOrder(nextOrder);
    localStorage.setItem('aurora_sidebar_folder_sort_mode', nextMode);
    localStorage.setItem('aurora_sidebar_folder_sort_order', nextOrder);
  }, [folderSortMode, folderSortOrder]);

  // 网络（移动设备 / 局域网）分区的排序状态：与本地文件夹树完全独立，
  // 两套各自记忆，互不影响。
  const [networkSortMode, setNetworkSortMode] = useState<'name' | 'date'>(() =>
    (localStorage.getItem('aurora_sidebar_network_sort_mode') as 'name' | 'date') || 'name'
  );
  const [networkSortOrder, setNetworkSortOrder] = useState<'asc' | 'desc'>(() =>
    (localStorage.getItem('aurora_sidebar_network_sort_order') as 'asc' | 'desc') || 'asc'
  );

  const handleToggleNetworkSort = useCallback(() => {
    let nextMode: 'name' | 'date' = networkSortMode;
    let nextOrder: 'asc' | 'desc' = networkSortOrder;

    if (networkSortMode === 'name') {
      if (networkSortOrder === 'asc') {
        nextOrder = 'desc';
      } else {
        nextMode = 'date';
        nextOrder = 'desc'; // 时间排序默认最新在前
      }
    } else {
      if (networkSortOrder === 'desc') {
        nextOrder = 'asc';
      } else {
        nextMode = 'name';
        nextOrder = 'asc';
      }
    }

    setNetworkSortMode(nextMode);
    setNetworkSortOrder(nextOrder);
    localStorage.setItem('aurora_sidebar_network_sort_mode', nextMode);
    localStorage.setItem('aurora_sidebar_network_sort_order', nextOrder);
  }, [networkSortMode, networkSortOrder]);

  // New state to track if mouse is hovering the sidebar
  const [isSidebarHovered, setIsSidebarHovered] = useState(false);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleMouseEnterSidebar = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
    setIsSidebarHovered(true);
  }, []);

  const handleMouseLeaveSidebar = useCallback(() => {
    if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    hoverTimeoutRef.current = setTimeout(() => {
      setIsSidebarHovered(false);
      hoverTimeoutRef.current = null;
    }, 200);
  }, []);

  // When tag creation starts externally, switch active section to tags
  useEffect(() => {
    if (isCreatingTag) setActiveSection('tags');
  }, [isCreatingTag]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) clearTimeout(hoverTimeoutRef.current);
    };
  }, []);

  // Stable wrappers to avoid recreating callbacks on each render
  const stableOnToggle = useCallback((id: string) => {
    setActiveSection('roots');
    onToggle(id);
  }, [onToggle]);
  const stableOnNavigate = useCallback((id: string, options?: { resetScroll?: boolean }) => onNavigate(id, options), [onNavigate]);
  const stableOnContextMenu = useCallback((e: React.MouseEvent, type: 'file' | 'tag' | 'root-folder' | 'person' | 'tag-background', id?: string) => onContextMenu(e, type as any, id as any), [onContextMenu]);
  const stableOnDropOnFolder = useCallback((targetFolderId: string, sourceIds: string[]) => onDropOnFolder && onDropOnFolder(targetFolderId, sourceIds), [onDropOnFolder]);

  const handleNavigateAllPeople = useCallback(() => { setActiveSection('people'); onNavigateAllPeople(); }, [onNavigateAllPeople]);
  const handleNavigateAllTags = useCallback(() => { setActiveSection('tags'); onNavigateAllTags(); }, [onNavigateAllTags]);
  const handleNavigateTopics = useCallback(() => { setActiveSection('topics'); onNavigateTopics(); }, [onNavigateTopics]);

  // Virtualization helpers
  const containerRef = useRef<HTMLDivElement>(null);
  const sidebarHeightRef = useRef<HTMLDivElement | null>(null);
  const [listHeight, setListHeight] = useState(400);
  // 当前展开分区列表的精确可用高度 = 侧边栏内容高度 - 容器内边距 -
  // 各分区固定部分（标题行/设备行 + 外边距，展开分区的列表容器除外）。
  // 由下方 useLayoutEffect 实测计算，保证展开列表既不超出视口、也不挤压
  // 或覆盖下方栏目（此前按常量估算导致设备文件夹列表与"人物/所有标签"重叠）。
  const [listCap, setListCap] = useState(300);
  const rowHeight = isAndroidPlatformCached() ? 35 : 32;

  useEffect(() => {
    const el = sidebarHeightRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setListHeight(el.clientHeight);
    });
    ro.observe(el);
    // set initial
    setListHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  // 精确测量各分区固定部分高度并计算展开列表可用高度。
  // 依赖为影响分区固定部分的因素：分区切换、设备行数、画布入口有无、
  // 侧边栏高度；测量结果变化超过 1px 时才更新，避免渲染死循环。
  useLayoutEffect(() => {
    const container = sidebarHeightRef.current;
    if (!container) return;
    const sections = Array.from(
      container.querySelectorAll<HTMLElement>('[data-sidebar-section]')
    );
    let fixedTotal = 0;
    for (const el of sections) {
      const cs = window.getComputedStyle(el);
      const mt = parseFloat(cs.marginTop) || 0;
      const mb = parseFloat(cs.marginBottom) || 0;
      const listEl = el.querySelector<HTMLElement>('[data-sidebar-list]');
      const listH = listEl ? listEl.offsetHeight : 0;
      fixedTotal += el.offsetHeight + mt + mb - listH;
    }
    const cs = window.getComputedStyle(container);
    const padTop = parseFloat(cs.paddingTop) || 0;
    const padBottom = parseFloat(cs.paddingBottom) || 0;
    const cap = Math.max(120, listHeight - padTop - padBottom - fixedTotal);
    setListCap((prev) => (Math.abs(prev - cap) < 1 ? prev : cap));
  }, [activeSection, expandedAndroidKey, listHeight, androidDevices.length, !!onOpenCanvas]);

  // Cache to store folder-only children pointers to avoid repeating O(N) filtering of large mixed directories
  // Keyed by folder ID, tracks the children array reference and sorting to detect structural changes vs metadata-only changes
  const folderChildCache = useRef<Record<string, { children: string[], version: any, sortKey: string }>>({});

  const visibleNodes = useMemo(() => {
    const set = expandedSet || new Set<string>();
    const out: { id: string; depth: number; node: FileNode; hasFolderChildren: boolean }[] = [];
    const stack: { id: string; depth: number }[] = [];

    // Push roots in reverse order to the stack so they are popped in correct top-down order
    // But we need to sort roots too if there are multiple roots
    const sortedRoots = [...roots].sort((aId, bId) => {
      const a = files[aId];
      const b = files[bId];
      if (!a || !b) return 0;
      
      let res = 0;
      if (folderSortMode === 'name') {
        res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
      } else {
        const atime = Number(a.meta?.modified) || 0;
        const btime = Number(b.meta?.modified) || 0;
        res = atime - btime;
      }
      return folderSortOrder === 'asc' ? res : -res;
    });

    for (let i = sortedRoots.length - 1; i >= 0; --i) {
      stack.push({ id: sortedRoots[i], depth: 0 });
    }

    const sortKey = `${folderSortMode}_${folderSortOrder}`;

    while (stack.length > 0) {
      const { id, depth } = stack.pop()!;
      const node = files[id];
      if (!node || node.type !== FileType.FOLDER) continue;
      
      // Optimization: use cached folder-filtered and sorted children if the node structure hasn't changed.
      let folderChildrenEntry = folderChildCache.current[id];
      if (!folderChildrenEntry || folderChildrenEntry.version !== node.children || folderChildrenEntry.sortKey !== sortKey) {
        const filtered = (node.children || []).filter(childId => files[childId]?.type === FileType.FOLDER);
        
        filtered.sort((aId, bId) => {
          const a = files[aId];
          const b = files[bId];
          if (!a || !b) return 0;
          
          let res = 0;
          if (folderSortMode === 'name') {
            res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
          } else {
            const atime = Number(a.meta?.modified) || 0;
            const btime = Number(b.meta?.modified) || 0;
            res = atime - btime;
          }
          return folderSortOrder === 'asc' ? res : -res;
        });

        folderChildrenEntry = {
          version: node.children,
          sortKey,
          children: filtered
        };
        folderChildCache.current[id] = folderChildrenEntry;
      }
      
      const children = folderChildrenEntry.children;
      out.push({ id, depth, node, hasFolderChildren: children.length > 0 });
      
      if (set.has(id) && children.length > 0) {
        // Push children in reverse order so they are processed in correct top-to-bottom order (standard DFS)
        for (let i = children.length - 1; i >= 0; --i) {
          stack.push({ id: children[i], depth: depth + 1 });
        }
      }
    }
    return out;
  }, [roots, files, expandedSet, folderSortMode, folderSortOrder]);

  // publish sidebar visible-node counts and virtualization detection for debug/telemetry consumers
  useEffect(() => {
    const win = window as any;
    win.__AURORA_RENDER_COUNTS__ = win.__AURORA_RENDER_COUNTS__ || {};

    // logical count (how many nodes the virtualization/layout considers visible)
    win.__AURORA_RENDER_COUNTS__.treeSidebarLogical = visibleNodes.length;

    // total folder count (authoritative for virtualization detection)
    const totalFolders = Object.values(files || {}).filter(f => f.type === FileType.FOLDER).length;
    win.__AURORA_RENDER_COUNTS__.treeSidebarTotal = totalFolders;

    // DOM-mounted count (best-effort selector matching TreeNode structure)
    const el = sidebarHeightRef.current;
    try {
      // Tree nodes render a `span.aurora-marquee` for the label — use that as a proxy
      win.__AURORA_RENDER_COUNTS__.treeSidebarDOM = el ? el.querySelectorAll('span.truncate, span.aurora-marquee').length : 0;
    } catch (e) {
      win.__AURORA_RENDER_COUNTS__.treeSidebarDOM = 0;
    }

    // virtualization heuristics
    win.__AURORA_RENDER_COUNTS__.treeSidebarVirtualized = typeof visibleNodes.length === 'number' && totalFolders > 0 && visibleNodes.length < totalFolders;
    win.__AURORA_RENDER_COUNTS__.treeSidebarUsingReactWindow = !!FixedSizeListComp;
  }, [visibleNodes.length, isSidebarHovered, Object.keys(files).length]);

  return (
    <div 
      className="w-full h-full flex flex-col overflow-hidden"
      onMouseEnter={handleMouseEnterSidebar}
      onMouseLeave={handleMouseLeaveSidebar}
    >
      <div ref={sidebarHeightRef} className="flex-1 flex flex-col overflow-hidden pb-4 pt-2.5">
          <TopicSection 
            onNavigateTopics={handleNavigateTopics}
            onCreateTopic={onCreateTopic}
            t={t}
            isSelected={activeViewMode === 'topics-overview'}
          />

          <FolderSection 
             visibleNodes={visibleNodes}
             files={files}
             currentFolderId={currentFolderForNodes}
             expandedSet={expandedSet}
             onToggle={stableOnToggle}
             onNavigate={stableOnNavigate}
             onContextMenu={stableOnContextMenu}
             onDropOnFolder={stableOnDropOnFolder}
             expanded={activeSection === 'roots'}
             onToggleExpand={() => {
               if (activeSection !== 'roots' && roots.length === 1 && !expandedSet.has(roots[0])) {
                 onToggle(roots[0]);
               }
               setActiveSection(prev => prev === 'roots' ? null : 'roots');
             }}
             listHeight={listCap}
             rowHeight={rowHeight}
             FixedSizeListComp={FixedSizeListComp}
             containerRef={containerRef}
             t={t}
             roots={roots}
             sortMode={folderSortMode}
             sortOrder={folderSortOrder}
             onToggleSort={handleToggleFolderSort}
             onNavigateHome={onNavigateHome}
             />

          <NetworkSection
            expanded={activeSection === 'lanNetwork'}
            onToggleExpand={() => setActiveSection(prev => prev === 'lanNetwork' ? null : 'lanNetwork')}
            onNavigateHome={() => { setActiveSection('lanNetwork'); onNavigateNetworkHome?.(); }}
            onNavigateFolder={(id) => { setActiveSection('lanNetwork'); onNavigateNetworkFolder?.(id); }}
            onOpenSettings={() => onOpenLanSettings?.()}
            connected={lanConnected}
            loading={lanLoading}
            isSelected={activeViewMode === 'lan-folders-overview'}
            lanRoots={lanRoots || []}
            files={files}
            currentFolderId={currentFolderForNodes}
            listHeight={listCap}
            t={t}
            androidDevices={androidDevices}
            androidActiveKey={androidActiveKey}
            expandedAndroidKey={expandedAndroidKey}
            onToggleAndroidDevice={handleToggleAndroidDevice}
            onNavigateAndroidHome={(key) => { setActiveSection('lanNetwork'); onNavigateAndroidHome?.(key); }}
            onNavigateAndroidFolder={(id) => { setActiveSection('lanNetwork'); onNavigateAndroidFolder?.(id); }}
            onOpenAndroidSettings={() => onOpenAndroidSettings?.()}
            sortMode={networkSortMode}
            sortOrder={networkSortOrder}
            onToggleSort={handleToggleNetworkSort}
          />

          <PeopleSection
            people={people}
            files={files}
            onPersonSelect={onPersonSelect}
            onNavigateAllPeople={handleNavigateAllPeople}
            onContextMenu={onContextMenu}
            onStartRenamePerson={onStartRenamePerson}
            onCreatePerson={onCreatePerson}
            t={t}
            isSelected={activeViewMode === 'people-overview'}
            expanded={activeSection === 'people'}
            onToggleExpand={() => setActiveSection(prev => prev === 'people' ? null : 'people')}
            listHeight={listCap}
            roots={roots}
          />

        <TagSection 
          files={files} 
          customTags={customTags}
          onTagSelect={onTagSelect} 
          onNavigateAllTags={handleNavigateAllTags} 
          onContextMenu={onContextMenu}
          isCreatingTag={isCreatingTag}
          onStartCreateTag={onStartCreateTag}
          onSaveNewTag={onSaveNewTag}
          onCancelCreateTag={onCancelCreateTag}
          t={t}
          expanded={activeSection === 'tags'}
          onToggleExpand={() => setActiveSection(prev => prev === 'tags' ? null : 'tags')}
          isSelected={activeViewMode === 'tags-overview'}
          listHeight={listCap}
          rowHeight={28} /* Estimated height for tag item */
          FixedSizeListComp={FixedSizeListComp}
          roots={roots}
          filesVersion={filesVersion}
        />

        {onOpenCanvas && (
          <CanvasSection 
            onOpenCanvas={onOpenCanvas}
            t={t}
            isSelected={activeViewMode === 'canvas'}
          />
        )}
        
        <div className="flex-1" />
      </div>
      
      {minimizedTasks.length > 0 && (() => {
          const isAndroid = isAndroidPlatformCached();
          const taskLabelClass = isAndroid ? 'text-xs text-gray-400 uppercase font-bold mb-1.5 px-1' : 'text-[10px] text-gray-400 uppercase font-bold mb-1 px-1';
          const actionBtnPad = isAndroid ? 'p-1.5' : 'p-1';
          const actionIconSize = isAndroid ? 16 : 10;
          const restoreBtnClass = isAndroid
            ? `${actionBtnPad} hover:bg-black/10 dark:hover:bg-white/10 rounded text-gray-500`
            : `${actionBtnPad} hover:bg-surface rounded text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity`;
          return (
          <div className="p-2 bg-panel">
             <div className={taskLabelClass}>{t('sidebar.tasks')}</div>
             <div className="space-y-1">
                 {minimizedTasks.map(task => {
                    const percent = Math.round((task.current / task.total) * 100);
                    const progressColor = task.status === 'paused' ? 'bg-yellow-500' : 'bg-blue-500';
                    const progressColorLight = task.status === 'paused' ? 'rgba(234,179,8,0.15)' : 'rgba(59,130,246,0.15)';
                    const progressColorMid = task.status === 'paused' ? 'rgba(234,179,8,0.35)' : 'rgba(59,130,246,0.35)';
                    return (
                        <div key={task.id}
                          className={isAndroid
                            ? 'relative overflow-hidden border border-subtle rounded shadow-sm transition-colors animate-fade-in h-[53px] flex items-center cursor-pointer'
                            : 'bg-surface border border-subtle rounded p-2 text-xs shadow-sm group hover:bg-surface transition-colors animate-fade-in cursor-pointer'
                          }
                          onClick={() => onRestoreTask(task.id)}
                        >
                           {isAndroid && (
                             <>
                               <div
                                 className={`absolute inset-0 ${progressColor} transition-all duration-300`}
                                 style={{ width: `${percent}%` }}
                               />
                               <div
                                 className="absolute inset-y-0 left-0 w-1/3 animate-progress-wave"
                                 style={{
                                   background: `linear-gradient(90deg, transparent 0%, ${progressColorMid} 50%, transparent 100%)`,
                                 }}
                               />
                             </>
                           )}
                           <div className={`relative z-10 flex justify-between items-center w-full ${isAndroid ? 'px-3 text-sm' : 'p-2 text-xs'}`}>
                               <span className={isAndroid ? 'font-medium text-gray-800 dark:text-white truncate pr-1' : 'font-medium text-gray-700 dark:text-gray-200 truncate pr-2 flex-1'}>
                                 {task.title}
                               </span>
                               {isAndroid && <span className="text-gray-700 dark:text-gray-300 shrink-0">{percent}%</span>}
                               <div className="flex items-center space-x-1">
                                   {task.type === 'color' && (
                                     <button 
                                       onClick={(e) => { e.stopPropagation(); handlePauseResume(task.id, task.type); }}
                                       className={`${isAndroid ? 'p-1.5 hover:bg-black/10 dark:hover:bg-white/10' : 'p-1 hover:bg-surface'} rounded text-gray-500`}
                                       title={task.status === 'paused' ? t('tasks.resume') : t('tasks.pause')}
                                     >
                                       {task.status === 'paused' ? <Loader2 size={actionIconSize} className="animate-spin" /> : <Pause size={actionIconSize} />}
                                     </button>
                                   )}
                                   <button 
                                     onClick={(e) => { e.stopPropagation(); onRestoreTask(task.id); }}
                                     className={restoreBtnClass}
                                     title={t('tasks.restore')}
                                   >
                                     <Maximize2 size={actionIconSize} />
                                   </button>
                               </div>
                           </div>
                           {!isAndroid && (
                           <div className="w-full bg-surface h-1 rounded-full overflow-hidden">
                               <div className={`h-full rounded-full transition-all duration-300 ${progressColor}`} style={{ width: `${percent}%` }}></div>
                           </div>
                           )}
                        </div>
                    );
                 })}
             </div>
          </div>
          );
      })()}

      {modelDownloads.length > 0 && (
        <div className="p-2 bg-panel">
          {modelDownloads.map((download) => (
            <button
              key={download.modelName}
              onClick={() => window.dispatchEvent(new CustomEvent('navigate-to-ai-vision'))}
              title="点击打开 AI 视觉模型下载设置"
              className="w-full text-left mb-2 last:mb-0 p-2 bg-surface rounded-lg hover:bg-black/5 dark:hover:bg-white/5 transition-colors cursor-pointer group"
            >
              <div className="flex items-center justify-between text-xs mb-1">
                <div className="flex items-center text-gray-700 dark:text-gray-300">
                  <Download size={12} className={`mr-1.5 ${download.status === 'paused' ? 'text-yellow-500' : 'text-green-500'}`} />
                  <span className="font-medium">{download.displayName}</span>
                </div>
                <span className={`${download.status === 'paused' ? 'text-yellow-600' : 'text-gray-500 dark:text-gray-400'} flex items-center gap-1`}>
                  {download.status === 'completed' ? (
                    '完成'
                  ) : download.status === 'error' ? (
                    '失败'
                  ) : download.status === 'paused' ? (
                    '已暂停'
                  ) : (
                    `${download.fileIndex + 1}/${download.totalFiles} 文件`
                  )}
                  <ChevronRight size={12} className="opacity-0 group-hover:opacity-100 transition-opacity" />
                </span>
              </div>
              {(download.status === 'downloading' || download.status === 'paused') && (
                <>
                  <div className="w-full bg-surface h-1.5 rounded-full overflow-hidden">
                    <div 
                      className={`h-full rounded-full transition-all duration-300 ${download.status === 'paused' ? 'bg-yellow-500' : 'bg-green-500'}`} 
                      style={{ width: `${download.progress}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                    <span className="truncate max-w-[45%]">{download.fileName}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {download.progress}%
                      {download.status === 'paused' ? (
                        <span className="text-yellow-600">已暂停</span>
                      ) : (
                        <span className={download.speed > 0 ? "text-green-600" : "text-gray-400"}>
                          ({download.speed < 1024 ? `${download.speed} B/s` : download.speed < 1024 * 1024 ? `${(download.speed / 1024).toFixed(1)} KB/s` : `${(download.speed / 1024 / 1024).toFixed(1)} MB/s`})
                        </span>
                      )}
                    </span>
                  </div>
                </>
              )}
            </button>
          ))}
        </div>
      )}

      <div className="p-2">
         <button
           onClick={onOpenSettings}
           className="w-full flex items-center px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-surface rounded transition-colors"
         >
           <div className="flex items-center justify-between w-full">
             <div className="flex items-center">
               <Settings size={18} className="mr-3" />
               <span className="text-sm font-medium">{t('sidebar.settings')}</span>
             </div>
             <div className="ml-3 flex items-center">
               {aiConnectionStatus === 'checking' ? (
                 <Loader2 size={12} className="text-yellow-400 animate-spin" />
               ) : (
                 <span className={`w-2 h-2 rounded-full ${aiConnectionStatus === 'connected' ? 'bg-green-500' : 'bg-red-500'}`} />
               )}
             </div>
           </div>
         </button>
      </div>
    </div>
  );
});
