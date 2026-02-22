
import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
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
import { FileNode, FileType, TaskProgress, Person } from '../types';
import { ChevronRight, ChevronDown, Folder, HardDrive, Tag as TagIcon, Plus, User, Check, Copy, Settings, WifiOff, Wifi, Loader2, Maximize2, Brain, Book, Film, Network, ImageIcon, Pause, Layout, ArrowUpDown, Clock, SortAsc, SortDesc, Scan, Download } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { pauseColorExtraction, resumeColorExtraction, getThumbnail } from '../api/tauri-bridge';
import { subscribeToModelDownload, ModelDownloadInfo, getActiveDownloads } from '../utils/modelDownloadState';
import { getGlobalCache } from '../utils/thumbnailCache';

const TagPreviewThumbnail = ({ file, resourceRoot }: { file: FileNode; resourceRoot?: string }) => {
  const [src, setSrc] = useState<string | null>(() => {
    if (!file.path) return null;
    return getGlobalCache().get(file.path) || null;
  });

  useEffect(() => {
    let active = true;
    if (file.type === FileType.IMAGE && resourceRoot && !src) {
      getThumbnail(file.path, file.meta?.modified, resourceRoot).then(url => {
        if (active && url) {
          setSrc(url);
          getGlobalCache().set(file.path, url);
        }
      });
    }
    return () => { active = false; };
  }, [file.path, file.meta?.modified, resourceRoot, src]);

  const displaySrc = src || convertFileSrc(file.path);

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
  nodeId: string; // keep id for legacy uses
  currentFolderId: string;
  expandedSet?: Set<string>;
  hasFolderChildren?: boolean;
  onToggle: (id: string) => void;
  onNavigate: (id: string, options?: { resetScroll?: boolean }) => void;
  onContextMenu: (e: React.MouseEvent, type: 'file' | 'tag' | 'root-folder', id: string) => void;
  onDropOnFolder?: (targetFolderId: string, sourceIds: string[]) => void;
  depth?: number;
}

const TreeNodeInner: React.FC<TreeProps> = ({ node, nodeId, currentFolderId, expandedSet, hasFolderChildren, onToggle, onNavigate, onContextMenu, onDropOnFolder, depth = 0 }) => {
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

  const Icon = isRoot 
    ? HardDrive 
    : (node.category === 'book' ? Book : node.category === 'sequence' ? Film : Folder);

  const iconColorClass = isSelected ? 'text-white' : (
      node.category === 'book' ? 'text-amber-500' :
      node.category === 'sequence' ? 'text-purple-500' :
      'text-blue-500 dark:text-blue-400'
  );

  return (
    <div className="select-none text-sm text-gray-600 dark:text-gray-300">
      <div 
        className={`flex items-center py-1 px-2 cursor-pointer transition-colors border border-transparent group relative
          ${isDragOverNode ? 'bg-blue-500/30 dark:bg-blue-900/50 border-2 border-blue-400 dark:border-blue-500 ring-2 ring-blue-300/50 dark:ring-blue-700/50' : ''}
          ${isSelected && !isDragOverNode ? 'bg-blue-600 text-white border-l-4 border-blue-300 shadow-md' : !isDragOverNode ? 'hover:bg-gray-200 dark:hover:bg-gray-800' : ''}
        `}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
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
        <Icon size={16} className={`mr-2 ${iconColorClass}`} />
        <span className="truncate pointer-events-none flex-1">{node.name}</span>
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
  rowHeight: number;
  scrollTop: number;
  bufferRows: number;
  FixedSizeListComp: any;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  isHovered: boolean;
}

const PeopleSection: React.FC<PeopleSectionControlledProps> = React.memo(({ 
  people, files, onPersonSelect, onNavigateAllPeople, onContextMenu, onStartRenamePerson, onCreatePerson, t, isSelected, 
  expanded, onToggleExpand, listHeight, rowHeight, scrollTop, bufferRows, FixedSizeListComp, onScroll, isHovered, roots
}) => {
  const peopleList = useMemo(() => Object.values(people), [people]);
  
  const peopleRows = useMemo(() => {
    const rows = [];
    for (let i = 0; i < peopleList.length; i += 4) {
      rows.push(peopleList.slice(i, i + 4));
    }
    return rows;
  }, [peopleList]);

  const availableHeight = Math.max(200, listHeight - 180);

  // Performance Optimization: Freeze rendering when not hovered
  const frozenScrollTop = useRef(scrollTop);
  useEffect(() => {
    if (isHovered) {
      frozenScrollTop.current = scrollTop;
    }
  }, [scrollTop, isHovered]);

  // Force update when roots change (indicates a database switch)
  useEffect(() => {
    frozenScrollTop.current = scrollTop;
  }, [roots]);

  const PersonCardInner: React.FC<{ person: Person }> = ({ person }) => {
    const coverFile = files[person.coverFileId];
    const coverSrc = useMemo(() => coverFile ? convertFileSrc(coverFile.path) : undefined, [coverFile?.path]);

    // clamp extreme faceBox scaling to avoid huge layout work
    const clamp = (v: number, minV: number, maxV: number) => Math.max(minV, Math.min(maxV, v));

    return (
      <div
         key={person.id}
         className="flex flex-col items-center group cursor-pointer h-full justify-start pt-1"
         onClick={() => onPersonSelect(person.id)}
         onContextMenu={(e) => onContextMenu(e, 'person', person.id)}
         onDoubleClick={(e) => { e.stopPropagation(); onStartRenamePerson(person.id); }}
         title={person.name}
      >
         <div className="w-10 h-10 rounded-full border border-gray-200 dark:border-gray-800 overflow-hidden bg-gray-100 dark:bg-gray-800 hover:border-purple-500 dark:hover:border-purple-400 hover:ring-2 ring-purple-200 dark:ring-purple-900 transition-all shadow-sm relative flex-shrink-0">
            {coverFile ? (
                person.faceBox ? (
                   <img
                     src={coverSrc}
                     alt={person.name}
                     className="absolute max-w-none"
                     decoding="async"
                     style={{
                         width: `${clamp(10000 / Math.max(person.faceBox.w, 2.0), 0, 1000)}%`,
                         height: `${clamp(10000 / Math.max(person.faceBox.h, 2.0), 0, 1000)}%`,
                         left: 0,
                         top: 0,
                         transformOrigin: 'top left',
                         transform: `translate3d(${-person.faceBox.x}%, ${-person.faceBox.y}%, 0)`,
                         willChange: 'transform, width, height',
                         backfaceVisibility: 'hidden'
                     }}
                   />
                ) : (
                   <img
                     src={coverSrc}
                     alt={person.name}
                     className="w-full h-full object-cover"
                   />
                )
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-400"><User size={16}/></div>
            )}
         </div>
         <span className="text-[10px] mt-1.5 text-gray-600 dark:text-gray-400 truncate w-full text-center leading-tight group-hover:text-purple-600 dark:group-hover:text-purple-300">{person.name}</span>
         <span className="text-[9px] text-gray-500 dark:text-gray-500 truncate w-full text-center leading-tight">{person.count} {t('sidebar.files')}</span>
      </div>
    );
  };

  const personCardEqual = (prev: { person: Person }, next: { person: Person }) => {
    const a = prev.person;
    const b = next.person;
    return a.id === b.id && a.name === b.name && a.coverFileId === b.coverFileId && a.count === b.count && JSON.stringify(a.faceBox || {}) === JSON.stringify(b.faceBox || {});
  };

  const PersonCard = React.memo(PersonCardInner, personCardEqual);

  const listContent = useMemo(() => {
    if (!expanded) return null;
    if (peopleList.length === 0) {
      return <div className="text-xs text-gray-400 italic py-1">{t('sidebar.noPeople')}</div>;
    }

    const currentST = isHovered ? scrollTop : frozenScrollTop.current;

    if (FixedSizeListComp) {
      return (
        <FixedSizeListComp
          height={Math.min(peopleRows.length * rowHeight, availableHeight)}
          itemCount={peopleRows.length}
          itemSize={rowHeight}
          width={'100%'}
          initialScrollOffset={currentST}
          itemData={{ rows: peopleRows, PersonCard }}
        >
          {({ index, style, data }: any) => (
            <div style={style} className="grid grid-cols-4 gap-1 px-1">
              {data.rows[index].map((person: Person) => (
                <data.PersonCard key={person.id} person={person} />
              ))}
            </div>
          )}
        </FixedSizeListComp>
      );
    }

    const total = peopleRows.length;
    const totalHeight = total * rowHeight;
    const viewportRows = Math.ceil(availableHeight / rowHeight);
    const first = Math.max(0, Math.floor(currentST / rowHeight) - bufferRows);
    const last = Math.min(total, first + viewportRows + bufferRows * 2);
    const topHeight = first * rowHeight;
    const bottomHeight = Math.max(0, (total - last) * rowHeight);
    const slice = peopleRows.slice(first, last);

    return (
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ height: topHeight }} />
        {slice.map((row, rowIdx) => (
          <div key={rowIdx} className="grid grid-cols-4 gap-1 px-1" style={{ height: rowHeight }}>
            {row.map(person => (
              <PersonCard key={person.id} person={person} />
            ))}
          </div>
        ))}
        <div style={{ height: bottomHeight }} />
      </div>
    );
  }, [expanded, peopleRows, rowHeight, availableHeight, FixedSizeListComp, PersonCard, t, (isHovered ? scrollTop : null), peopleRows.length]);

  return (
      <div className={`select-none text-sm text-gray-600 dark:text-gray-300 relative flex flex-col min-h-0 ${expanded ? 'flex-initial' : 'flex-none'}`}>
        <div 
          className={`flex items-center py-1 px-2 cursor-pointer transition-colors border border-transparent group relative mt-2 ${isSelected ? 'text-white border-l-4 shadow-md' : 'hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          style={isSelected ? { backgroundColor: '#a855f7', borderLeftColor: 'rgba(168,85,247,0.35)' } : undefined}
            onClick={(e) => {
              if ((e.target as HTMLElement).closest('.expand-icon')) {
                e.stopPropagation();
                onToggleExpand();
              } else {
                onNavigateAllPeople();
              }
            }}
        >
          <div className="expand-icon p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
          <div className="flex items-center flex-1">
            <Brain size={14} className={`mr-2 ${isSelected ? 'text-white' : 'text-purple-500 dark:text-purple-400'}`} />
            <span className={`font-bold text-xs uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>{t('sidebar.people')} ({peopleList.length})</span>
          </div>
          <button 
           className={`p-1 rounded transition-colors opacity-0 group-hover:opacity-100 ${isSelected ? 'hover:bg-white/10 dark:hover:bg-white/10' : 'hover:bg-gray-300 dark:hover:bg-gray-700'} text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`}
           onClick={(e) => { e.stopPropagation(); onCreatePerson(); }}
           title={t('context.newPerson')}
          >
           <Plus size={14} className={`${isSelected ? 'text-white' : ''}`} />
          </button>
        </div>

          {expanded && (
           <div 
             className="pl-6 pr-2 pb-2 mt-1 overflow-y-auto scrollbar-thin min-h-0"
             style={{ 
               maxHeight: `${availableHeight}px`,
               contentVisibility: 'auto'
             }}
             onScroll={onScroll}
           >
             {listContent}
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
  scrollTop: number;
  bufferRows: number;
  FixedSizeListComp: any;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  isHovered: boolean;
  filesVersion?: number;
}

const TagSection: React.FC<TagSectionControlledProps> = React.memo(({ 
  files, customTags, onTagSelect, onNavigateAllTags, onContextMenu, 
  isCreatingTag, onStartCreateTag, onSaveNewTag, onCancelCreateTag, t, expanded, onToggleExpand, isSelected, 
  listHeight, rowHeight, scrollTop, bufferRows, FixedSizeListComp, onScroll, isHovered, roots, filesVersion
}) => {
    const [hoveredTag, setHoveredTag] = useState<string | null>(null);
    const [hoveredTagPos, setHoveredTagPos] = useState<{top: number, left: number} | null>(null);
    const [tagInputValue, setTagInputValue] = useState('');
  
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const availableHeight = Math.max(200, listHeight - 180);

  // Performance Optimization: Freeze sidebar rendering when not hovered
  const frozenScrollTop = useRef(scrollTop);
  useEffect(() => {
    if (isHovered) {
      frozenScrollTop.current = scrollTop;
    }
  }, [scrollTop, isHovered]);

  // Force update when roots change (indicates a database switch)
  useEffect(() => {
    frozenScrollTop.current = scrollTop;
  }, [roots]);

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

    // Force real scrollTop if currently creating a tag to ensure the new input and list stay in sync
    const currentST = (isHovered || isCreatingTag) ? scrollTop : frozenScrollTop.current;

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
                onContextMenu={(e) => data.onContextMenu(e, 'tag', tag)}
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
                   <span className="text-[10px] text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 rounded-full pointer-events-none ml-2">
                     {data.tagCounts[tag] || 0}
                   </span>
                </div>
                
                {data.hoveredTag === tag && data.previewImages.length > 0 && data.hoveredTagPos && data.createPortal(
                  <div 
                    className="fixed z-[100] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl p-3 w-64 animate-fade-in pointer-events-none" 
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
    const topHeight = first * rowHeight;
    const bottomHeight = Math.max(0, (total - last) * rowHeight);
    const slice = sortedTags.slice(first, last);

    return (
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ height: topHeight }} />
        {slice.map(tag => (
          <div 
            key={tag}
            className="relative group"
            style={{ height: rowHeight }}
            onMouseEnter={(e) => handleMouseEnter(e, tag)}
            onMouseLeave={handleMouseLeave}
            onContextMenu={(e) => onContextMenu(e, 'tag', tag)}
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
               <span className="text-[10px] text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 rounded-full pointer-events-none ml-2">
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
        <div style={{ height: bottomHeight }} />
      </div>
    );
  }, [expanded, sortedTags, tagCounts, onTagSelect, onContextMenu, rowHeight, availableHeight, FixedSizeListComp, handleMouseEnter, handleMouseLeave, hoveredTag, previewImages, hoveredTagPos, t, (isHovered || isCreatingTag ? scrollTop : null), sortedTags.length]);

  return (
    <div className={`select-none text-sm text-gray-600 dark:text-gray-300 relative flex flex-col min-h-0 ${expanded ? 'flex-initial' : 'flex-none'}`}>
       <div 
        className={`flex items-center py-1 px-2 cursor-pointer transition-colors border border-transparent group relative mt-2 ${isSelected ? 'text-white border-l-4 shadow-md' : 'hover:bg-gray-200 dark:hover:bg-gray-800'}`}
        style={isSelected ? { backgroundColor: '#5391f6', borderLeftColor: 'rgba(83,145,246,0.28)' } : undefined}
      >
         <div className="p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded" onClick={(e) => { e.stopPropagation(); onToggleExpand(); }}>
           {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <div className="flex items-center flex-1" onClick={onNavigateAllTags}>
          <TagIcon size={14} className={`mr-2 ${isSelected ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`} />
          <span className={`font-bold text-xs uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>{t('sidebar.allTags')} ({sortedTags.length})</span>
        </div>
        <button 
           className={`p-1 rounded transition-colors opacity-0 group-hover:opacity-100 ${isSelected ? 'hover:bg-white/10 dark:hover:bg-white/10' : 'hover:bg-gray-300 dark:hover:bg-gray-700'} text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`}
           onClick={(e) => { e.stopPropagation(); onStartCreateTag(); }}
           title={t('context.newTag')}
        >
           <Plus size={14} className={`${isSelected ? 'text-white' : ''}`} />
        </button>
      </div>

      {expanded && (
        <div 
          className="pl-6 pr-2 pb-2 space-y-0.5 min-h-[40px] overflow-y-auto scrollbar-thin"
          style={{ 
            maxHeight: `${availableHeight}px`,
            contentVisibility: 'auto'
          }}
          onScroll={onScroll}
          onContextMenu={(e) => { 
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
                    className="w-full bg-white dark:bg-gray-800 border border-blue-500 rounded px-2 py-1 text-sm text-gray-900 dark:text-gray-200 focus:outline-none shadow-sm placeholder-gray-400"
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
                     <ul className="absolute left-2 right-2 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded-md shadow-lg z-50 overflow-hidden">
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
  return (
      <div className="select-none text-sm text-gray-600 dark:text-gray-300 relative">
        <div
          className={`flex items-center py-1 px-2 cursor-pointer transition-colors border border-transparent group relative mt-2 ${isSelected ? 'text-white border-l-4 shadow-md' : 'hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          style={isSelected ? { backgroundColor: '#ee5ea5', borderLeftColor: 'rgba(238,94,165,0.32)' } : undefined}
          onClick={onNavigateTopics}
        >
          <div className="p-1 mr-1 rounded w-[22px] h-[22px] flex items-center justify-center opacity-0">
            <ChevronRight size={14} />
          </div>
          <div className="flex items-center flex-1">
            <Layout size={14} className={`mr-2 ${isSelected ? 'text-white' : 'text-pink-500 dark:text-pink-400'}`} />
            <span className={`font-bold text-xs uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>{t('sidebar.topics')}</span>
          </div>
          <button
           className={`p-1 rounded transition-colors opacity-0 group-hover:opacity-100 ${isSelected ? 'hover:bg-white/10 dark:hover:bg-white/10' : 'hover:bg-gray-300 dark:hover:bg-gray-700'} text-gray-400 hover:text-gray-600 dark:hover:text-gray-200`}
           onClick={(e) => { e.stopPropagation(); onCreateTopic(); }}
           title={t('context.newTopic')}
          >
           <Plus size={14} className={`${isSelected ? 'text-white' : ''}`} />
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
  return (
      <div className="select-none text-sm text-gray-600 dark:text-gray-300 relative">
        <div 
          className={`flex items-center py-1 px-2 cursor-pointer transition-colors border border-transparent group relative mt-2 ${isSelected ? 'text-white border-l-4 shadow-md' : 'hover:bg-gray-200 dark:hover:bg-gray-800'}`}
          style={isSelected ? { backgroundColor: '#10b981', borderLeftColor: 'rgba(16,185,129,0.32)' } : undefined}
          onClick={onOpenCanvas}
        >
          <div className="p-1 mr-1 rounded w-[22px] h-[22px] flex items-center justify-center opacity-0">
            <ChevronRight size={14} />
          </div>
          <div className="flex items-center flex-1">
            <Scan size={14} className={`mr-2 ${isSelected ? 'text-white' : 'text-emerald-500 dark:text-emerald-400'}`} />
            <span className={`font-bold text-xs uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>{t('sidebar.canvas')}</span>
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
  scrollTop: number;
  bufferRows: number;
  FixedSizeListComp: any;
  containerRef: React.RefObject<HTMLDivElement>;
  onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  t: (key: string) => string;
  isHovered: boolean;
  sortMode?: 'name' | 'date';
  sortOrder?: 'asc' | 'desc';
  onToggleSort?: () => void;
}

const FolderSection: React.FC<FolderSectionProps> = React.memo(({
  visibleNodes, files, roots, currentFolderId, expandedSet, onToggle, onNavigate, onContextMenu, onDropOnFolder,
  expanded, onToggleExpand, listHeight, rowHeight, scrollTop, bufferRows, FixedSizeListComp, containerRef, onScroll, t, isHovered,
  sortMode = 'name', sortOrder = 'asc', onToggleSort
}) => {
  const isSingleRoot = roots.length === 1;
  const rootId = roots[0];
  const rootNode = files[rootId];
  const isSelected = isSingleRoot && currentFolderId === rootId;

  const displayNodes = useMemo(() => {
    if (isSingleRoot) {
      return visibleNodes.filter(n => n.id !== rootId);
    }
    return visibleNodes;
  }, [visibleNodes, isSingleRoot, rootId]);

  // Calculate actual viewport height available for the list
  const availableHeight = Math.max(200, listHeight - 180);

  const handleHeaderClick = (e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.expand-icon')) {
      e.stopPropagation();
      onToggleExpand();
    } else if (isSingleRoot) {
      onNavigate(rootId, { resetScroll: true });
      if (!expanded) {
        onToggleExpand();
        if (!expandedSet.has(rootId)) onToggle(rootId);
      }
    } else {
      onToggleExpand();
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

  // Performance Optimization: Freeze sidebar rendering when not hovered to improve main grid scroll performance
  const frozenScrollTop = useRef(scrollTop);
  useEffect(() => {
    if (isHovered) {
      frozenScrollTop.current = scrollTop;
    }
  }, [scrollTop, isHovered]);

  // Force update scroll position when roots change (e.g. after a root directory switch)
  // this ensures the UI refreshes immediately without waiting for mouse hover
  useEffect(() => {
    frozenScrollTop.current = scrollTop;
  }, [roots]);

  const listContent = useMemo(() => {
    if (!expanded) return null;
    if (displayNodes.length === 0) {
      return (
        <div className="px-10 py-4 text-xs text-gray-400 italic">
          {t('sidebar.noFolders')}
        </div>
      );
    }

    const currentST = isHovered ? scrollTop : frozenScrollTop.current;

    if (FixedSizeListComp) {
      return (
        <FixedSizeListComp
          height={Math.min(displayNodes.length * rowHeight, availableHeight)}
          itemCount={displayNodes.length}
          itemSize={rowHeight}
          width={'100%'}
          initialScrollOffset={currentST}
          itemData={{ visibleNodes: displayNodes, files, currentFolderId, expandedSet, onToggle, onNavigate, onContextMenu, onDropOnFolder }}
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
    const topHeight = first * rowHeight;
    const bottomHeight = Math.max(0, (total - last) * rowHeight);
    const slice = displayNodes.slice(first, last);

    return (
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ height: topHeight }} />
        {slice.map((nodeItem) => (
          <div key={nodeItem.id} style={{ height: rowHeight }}>
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
            />
          </div>
        ))}
        <div style={{ height: bottomHeight }} />
      </div>
    );
  }, [
    expanded, displayNodes, rowHeight, availableHeight, FixedSizeListComp, 
    currentFolderId, expandedSet, t, onToggle, onNavigate, onContextMenu, onDropOnFolder,
    (isHovered ? scrollTop : null), displayNodes.length // Ensure re-memoize when node count changes even if frozen
  ]);

  return (
    <div className={`select-none text-sm text-gray-600 dark:text-gray-300 relative flex flex-col min-h-0 ${expanded ? 'flex-initial' : 'flex-none'}`}>
      <div 
        className={`flex items-center py-1 px-2 cursor-pointer transition-colors border border-transparent group relative mt-2 
          ${isDragOver ? 'bg-blue-500/30 border-2 border-blue-400 ring-2 ring-blue-300/50' : ''}
          ${isSelected && !isDragOver ? 'bg-blue-600 text-white border-l-4 border-blue-300 shadow-md' : !isDragOver ? 'hover:bg-gray-200 dark:hover:bg-gray-800' : ''}`}
        onClick={handleHeaderClick}
        onContextMenu={(e) => isSingleRoot && onContextMenu(e, 'root-folder', rootId)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <div className="expand-icon p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded">
          {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <div className="flex items-center flex-1">
          <HardDrive size={14} className={`mr-2 ${isSelected ? 'text-white' : 'text-blue-500 dark:text-blue-400'}`} />
          <span className={`font-bold text-xs uppercase tracking-wider transition-colors ${isSelected ? 'text-white' : 'text-gray-500 dark:text-gray-400 group-hover:text-black dark:group-hover:text-white'}`}>
            {isSingleRoot && rootNode ? rootNode.name : "文件目录"}
          </span>
        </div>
        {onToggleSort && (
          <div 
            className={`p-1 flex items-center justify-center rounded transition-all hover:bg-black/10 dark:hover:bg-white/10 ${isSelected ? 'text-white/80 hover:text-white' : 'text-gray-400 hover:text-blue-500'}`}
            onClick={(e) => {
              e.stopPropagation();
              onToggleSort();
            }}
            title={sortMode === 'name' ? (sortOrder === 'asc' ? 'A-Z' : 'Z-A') : (sortOrder === 'desc' ? t('sort.newest') : t('sort.oldest'))}
          >
            {sortMode === 'name' ? (
               sortOrder === 'asc' ? <SortAsc size={14} /> : <SortDesc size={14} />
            ) : (
               <Clock size={14} className={sortOrder === 'asc' ? 'rotate-180' : ''} />
            )}
          </div>
        )}
      </div>

      {expanded && (
        <div 
          ref={containerRef} 
          onScroll={onScroll} 
          className="overflow-y-auto scrollbar-thin min-h-0"
          style={{ 
            maxHeight: `${availableHeight}px`,
            contentVisibility: 'auto'
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
  t: (key: string) => string;
  aiConnectionStatus?: 'connected' | 'disconnected' | 'checking';
  activeViewMode?: string;
  filesVersion?: number;
}> = React.memo(({ roots, files, people, customTags, currentFolderId, expandedIds, tasks, onToggle, onNavigate, onTagSelect, onNavigateAllTags, onPersonSelect, onNavigateAllPeople, onContextMenu, isCreatingTag, onStartCreateTag, onSaveNewTag, onCancelCreateTag, onOpenSettings, onRestoreTask, onPauseResume, onStartRenamePerson, onCreatePerson, onNavigateTopics, onCreateTopic, onDropOnFolder, onOpenCanvas, activeViewMode = 'browser', t, aiConnectionStatus = 'disconnected', filesVersion }) => {
  
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
        if (info.status === 'downloading') {
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
  const [activeSection, setActiveSection] = useState<'roots' | 'people' | 'tags' | 'topics' | null>('roots');

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
  const rowHeight = 32; // px per row
  const [scrollTop, setScrollTop] = useState(0);
  const rafRef = useRef<number | null>(null);
  const bufferRows = 2;
  const lastLogRef = useRef<number>(0);

  const handleScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    const st = target.scrollTop;
    if (rafRef.current) cancelAnimationFrame(rafRef.current);
    rafRef.current = requestAnimationFrame(() => {
      setScrollTop(st);
      rafRef.current = null;
    });
  }, []);

  useEffect(() => {
    const el = sidebarHeightRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setListHeight(el.clientHeight);
    });
    ro.observe(el);
    // set initial
    setListHeight(el.clientHeight);
    // reset scroll top when switching sections to avoid carry-over
    setScrollTop(0);
    return () => ro.disconnect();
  }, [activeSection, roots]);

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
    const totalFolders = Object.values(files).filter(f => f.type === FileType.FOLDER).length;
    win.__AURORA_RENDER_COUNTS__.treeSidebarTotal = totalFolders;

    // DOM-mounted count (best-effort selector matching TreeNode structure)
    const el = sidebarHeightRef.current;
    try {
      // Tree nodes render a `span.truncate` for the label — use that as a proxy
      win.__AURORA_RENDER_COUNTS__.treeSidebarDOM = el ? el.querySelectorAll('span.truncate').length : 0;
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
      <div className="p-3 font-bold text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider border-b border-gray-200 dark:border-gray-800">
        {t('sidebar.catalog')}
      </div>
      <div ref={sidebarHeightRef} className="flex-1 flex flex-col overflow-hidden pb-4">
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
             listHeight={listHeight}
             rowHeight={rowHeight}
             scrollTop={scrollTop}
             bufferRows={bufferRows}
             FixedSizeListComp={FixedSizeListComp}
             containerRef={containerRef}
             onScroll={handleScroll}
             t={t}
             roots={roots}
             isHovered={isSidebarHovered}
             sortMode={folderSortMode}
             sortOrder={folderSortOrder}
             onToggleSort={handleToggleFolderSort}
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
            listHeight={listHeight}
            rowHeight={88}
            scrollTop={scrollTop}
            bufferRows={bufferRows}
            FixedSizeListComp={FixedSizeListComp}
            onScroll={handleScroll}
            isHovered={isSidebarHovered}
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
          listHeight={listHeight}
          rowHeight={28} /* Estimated height for tag item */
          scrollTop={scrollTop}
          bufferRows={bufferRows}
          FixedSizeListComp={FixedSizeListComp}
          onScroll={handleScroll}
          isHovered={isSidebarHovered}
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
      
      {minimizedTasks.length > 0 && (
          <div className="border-t border-gray-200 dark:border-gray-800 p-2 bg-gray-50 dark:bg-gray-900/50">
             <div className="text-[10px] text-gray-400 uppercase font-bold mb-1 px-1">{t('sidebar.tasks')}</div>
             <div className="space-y-1">
                 {minimizedTasks.map(task => {
                    const percent = Math.round((task.current / task.total) * 100);
                    return (
                        <div key={task.id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded p-2 text-xs shadow-sm group hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors animate-fade-in" onClick={() => onRestoreTask(task.id)}>
                           <div className="flex justify-between items-center mb-1">
                               <span className="font-medium text-gray-700 dark:text-gray-200 truncate pr-2 flex-1">{task.title}</span>
                               <div className="flex items-center space-x-1">
                                   {task.type === 'color' && (
                                     <button 
                                       onClick={(e) => { e.stopPropagation(); handlePauseResume(task.id, task.type); }}
                                       className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-500"
                                       title={task.status === 'paused' ? t('tasks.resume') : t('tasks.pause')}
                                     >
                                       {task.status === 'paused' ? <Loader2 size={10} className="animate-spin" /> : <Pause size={10} />}
                                     </button>
                                   )}
                                   <button 
                                     onClick={(e) => { e.stopPropagation(); onRestoreTask(task.id); }}
                                     className="p-1 hover:bg-gray-200 dark:hover:bg-gray-600 rounded text-gray-500 opacity-0 group-hover:opacity-100 transition-opacity"
                                     title={t('tasks.restore')}
                                   >
                                     <Maximize2 size={10} />
                                   </button>
                               </div>
                           </div>
                           <div className="w-full bg-gray-200 dark:bg-gray-700 h-1 rounded-full overflow-hidden">
                               <div className={`h-full rounded-full transition-all duration-300 ${task.status === 'paused' ? 'bg-yellow-500' : 'bg-blue-500'}`} style={{ width: `${percent}%` }}></div>
                           </div>
                        </div>
                    );
                 })}
             </div>
          </div>
      )}

      {modelDownloads.length > 0 && (
        <div className="p-2 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          {modelDownloads.map((download) => (
            <div key={download.modelName} className="mb-2 last:mb-0">
              <div className="flex items-center justify-between text-xs mb-1">
                <div className="flex items-center text-gray-700 dark:text-gray-300">
                  <Download size={12} className="mr-1.5 text-green-500" />
                  <span className="font-medium">{download.displayName}</span>
                </div>
                <span className="text-gray-500 dark:text-gray-400">
                  {download.status === 'completed' ? (
                    '完成'
                  ) : download.status === 'error' ? (
                    '失败'
                  ) : (
                    `${download.fileIndex + 1}/${download.totalFiles} 文件`
                  )}
                </span>
              </div>
              {download.status === 'downloading' && (
                <>
                  <div className="w-full bg-gray-200 dark:bg-gray-700 h-1.5 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-green-500 rounded-full transition-all duration-300" 
                      style={{ width: `${download.progress}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-[10px] text-gray-500 dark:text-gray-400 mt-0.5">
                    <span className="truncate max-w-[45%]">{download.fileName}</span>
                    <span className="flex items-center gap-1 shrink-0">
                      {download.progress}%
                      <span className={download.speed > 0 ? "text-green-600" : "text-gray-400"}>
                        ({download.speed < 1024 ? `${download.speed} B/s` : download.speed < 1024 * 1024 ? `${(download.speed / 1024).toFixed(1)} KB/s` : `${(download.speed / 1024 / 1024).toFixed(1)} MB/s`})
                      </span>
                    </span>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="p-2 border-t border-gray-200 dark:border-gray-800">
         <button 
           onClick={onOpenSettings}
           className="w-full flex items-center px-4 py-2 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 rounded transition-colors"
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

      <div className="p-2 bg-gray-100 dark:bg-gray-850 border-t border-gray-200 dark:border-gray-800 text-xs text-gray-500 text-center">
        <div>{t('sidebar.localSupport')}</div>
      </div>
    </div>
  );
});
