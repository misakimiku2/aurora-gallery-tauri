
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
import { ChevronRight, ChevronDown, Folder, HardDrive, Tag as TagIcon, Plus, User, Check, Copy, Settings, WifiOff, Wifi, Loader2, Maximize2, Brain, Book, Film, Network, ImageIcon, Pause, Layout } from 'lucide-react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { pauseColorExtraction, resumeColorExtraction } from '../api/tauri-bridge';

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
  
  const folderChildren = hasFolderChildren ? (node.children || []).filter(Boolean) : [];

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
          {folderChildren.length > 0 ? (
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
  isSelected?: boolean;
}

interface PeopleSectionControlledProps extends PeopleSectionProps {
  expanded: boolean;
  onToggleExpand: () => void;
}

const PeopleSection: React.FC<PeopleSectionControlledProps> = React.memo(({ people, files, onPersonSelect, onNavigateAllPeople, onContextMenu, onStartRenamePerson, onCreatePerson, t, isSelected, expanded, onToggleExpand }) => {
  const peopleList = useMemo(() => Object.values(people), [people]);

  const PersonCardInner: React.FC<{ person: Person }> = ({ person }) => {
    const coverFile = files[person.coverFileId];
    const coverSrc = useMemo(() => coverFile ? convertFileSrc(coverFile.path) : undefined, [coverFile?.path]);

    // clamp extreme faceBox scaling to avoid huge layout work
    const clamp = (v: number, minV: number, maxV: number) => Math.max(minV, Math.min(maxV, v));

    return (
      <div 
         key={person.id} 
         className="flex flex-col items-center group cursor-pointer"
         onClick={() => onPersonSelect(person.id)}
         onContextMenu={(e) => onContextMenu(e, 'person', person.id)}
         onDoubleClick={(e) => { e.stopPropagation(); onStartRenamePerson(person.id); }}
         title={person.name}
      >
         <div className="w-10 h-10 rounded-full border border-gray-200 dark:border-gray-800 overflow-hidden bg-gray-100 dark:bg-gray-800 hover:border-purple-500 dark:hover:border-purple-400 hover:ring-2 ring-purple-200 dark:ring-purple-900 transition-all shadow-sm relative">
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
         <span className="text-[10px] mt-1 text-gray-600 dark:text-gray-400 truncate w-full text-center group-hover:text-purple-600 dark:group-hover:text-purple-300">{person.name}</span>
         <span className="text-[9px] text-gray-500 dark:text-gray-500 truncate w-full text-center">{person.count} {t('sidebar.files')}</span>
      </div>
    );
  };

  const personCardEqual = (prev: { person: Person }, next: { person: Person }) => {
    const a = prev.person;
    const b = next.person;
    return a.id === b.id && a.name === b.name && a.coverFileId === b.coverFileId && a.count === b.count && JSON.stringify(a.faceBox || {}) === JSON.stringify(b.faceBox || {});
  };

  const PersonCard = React.memo(PersonCardInner, personCardEqual);

  return (
      <div className="select-none text-sm text-gray-600 dark:text-gray-300 relative">
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
           <div className="pl-6 pr-2 pb-2 mt-1">
             {peopleList.length === 0 ? (
                <div className="text-xs text-gray-400 italic py-1">{t('sidebar.noPeople')}</div>
             ) : (
                <div className="grid grid-cols-4 gap-2">
                  {peopleList.map(person => (
                    <PersonCard key={person.id} person={person} />
                  ))}
                </div>
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
  isSelected?: boolean;
}

interface TagSectionControlledProps extends TagSectionProps {
  expanded: boolean;
  onToggleExpand: () => void;
}

const TagSection: React.FC<TagSectionControlledProps> = React.memo(({ 
  files, customTags, onTagSelect, onNavigateAllTags, onContextMenu, 
  isCreatingTag, onStartCreateTag, onSaveNewTag, onCancelCreateTag, t, expanded, onToggleExpand, isSelected 
}) => {
    const [hoveredTag, setHoveredTag] = useState<string | null>(null);
    const [hoveredTagPos, setHoveredTagPos] = useState<{top: number, left: number} | null>(null);
    const [tagInputValue, setTagInputValue] = useState('');
  
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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

    Object.values(files).forEach((file: FileNode) => {
      if (file.tags) {
        file.tags.forEach(tag => {
          allTags.add(tag);
          counts[tag] = (counts[tag] || 0) + 1;
        });
      }
    });

    return {
      sortedTags: Array.from(allTags).sort((a, b) => a.localeCompare(b, "zh-CN")),
      tagCounts: counts
    };
  }, [files, customTags]);

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

  const handleMouseEnter = (e: React.MouseEvent, tag: string) => {
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
  };

  const handleMouseLeave = () => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredTag(null);
    setHoveredTagPos(null);
  };

  return (
    <div className="select-none text-sm text-gray-600 dark:text-gray-300 relative">
       <div 
        className={`flex items-center py-1 px-2 cursor-pointer transition-colors border border-transparent group relative mt-2 ${isSelected ? 'text-white border-l-4 shadow-md' : 'hover:bg-gray-200 dark:hover:bg-gray-800'}`}
        style={isSelected ? { backgroundColor: '#5391f6', borderLeftColor: 'rgba(83,145,246,0.28)' } : undefined}
      >
         <div className="p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded" onClick={() => onToggleExpand()}>
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
          className="pl-6 pr-2 pb-2 space-y-0.5 min-h-[40px]"
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

          {sortedTags.map(tag => (
            <div 
              key={tag}
              className="relative group"
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
                 <span className="pointer-events-none">{tag}</span>
                 <span className="text-[10px] text-gray-500 dark:text-gray-600 bg-gray-200 dark:bg-gray-800 px-1.5 rounded-full pointer-events-none">
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
                      <div key={img.id} className="aspect-square bg-gray-100 dark:bg-black rounded border border-gray-200 dark:border-gray-800 overflow-hidden">
                         {/* Note: In Tauri, file.url is a file path, not a usable URL. Use placeholder for now. */}
                         <div className="w-full h-full bg-gray-200 dark:bg-gray-700 flex items-center justify-center">
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
          {sortedTags.length === 0 && !isCreatingTag && (
             <div className="text-xs text-gray-400 italic px-2 py-1">{t('sidebar.rightClickToAdd')}</div>
          )}
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
          <div className="p-1 mr-1 rounded opacity-0"></div>
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
  t: (key: string) => string;
  aiConnectionStatus?: 'connected' | 'disconnected' | 'checking';
  activeViewMode?: string;
}> = React.memo(({ roots, files, people, customTags, currentFolderId, expandedIds, tasks, onToggle, onNavigate, onTagSelect, onNavigateAllTags, onPersonSelect, onNavigateAllPeople, onContextMenu, isCreatingTag, onStartCreateTag, onSaveNewTag, onCancelCreateTag, onOpenSettings, onRestoreTask, onPauseResume, onStartRenamePerson, onCreatePerson, onNavigateTopics, onCreateTopic, onDropOnFolder, activeViewMode = 'browser', t, aiConnectionStatus = 'disconnected' }) => {
  
  const minimizedTasks = tasks ? tasks.filter(task => task.minimized) : [];
  
  const handlePauseResume = (taskId: string, taskType: string) => {
    if (taskType !== 'color') return;
    onPauseResume(taskId, taskType);
  };

  // Memoize expanded ids as a Set to keep stable reference for TreeNode children
  const expandedSet = useMemo(() => new Set(expandedIds || []), [ (expandedIds || []).join('|') ]);

  // Only consider currentFolderId for node selection when in 'browser' view
  const currentFolderForNodes = activeViewMode === 'browser' ? currentFolderId : '';

  // active section controls which primary section is expanded in the sidebar
  const [activeSection, setActiveSection] = useState<'roots' | 'people' | 'tags' | 'topics' | null>('roots');

  // When tag creation starts externally, switch active section to tags
  useEffect(() => {
    if (isCreatingTag) setActiveSection('tags');
  }, [isCreatingTag]);

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
  const containerRef = useRef<HTMLDivElement | null>(null);
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
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setListHeight(el.clientHeight);
    });
    ro.observe(el);
    // set initial
    setListHeight(el.clientHeight);
    return () => ro.disconnect();
  }, []);

  

  const visibleNodes = useMemo(() => {
    const set = expandedSet || new Set<string>();
    const out: { id: string; depth: number; node: FileNode; hasFolderChildren: boolean }[] = [];
    const stack: { id: string; depth: number }[] = [];

    for (let i = roots.length - 1; i >= 0; --i) {
      stack.unshift({ id: roots[i], depth: 0 });
    }

    while (stack.length) {
      const { id, depth } = stack.shift()!;
      const node = files[id];
      if (!node || node.type !== FileType.FOLDER) continue;
      const children = node.children && node.children.length > 0 ? node.children.filter(childId => files[childId]?.type === FileType.FOLDER) : [];
      out.push({ id, depth, node, hasFolderChildren: children.length > 0 });
      if (set.has(id) && children.length > 0) {
        for (let i = children.length - 1; i >= 0; --i) {
          stack.unshift({ id: children[i], depth: depth + 1 });
        }
      }
    }
    return out;
  }, [roots, files, expandedSet]);

  // Low-frequency debug logging for virtualization slice (limit to once per 200ms)
  useEffect(() => {
    const now = Date.now();
    if (now - lastLogRef.current < 200) return;
    lastLogRef.current = now;

    const total = visibleNodes.length;
    const viewportRows = Math.max(1, Math.ceil(listHeight / rowHeight));
    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - bufferRows);
    const last = Math.min(total, first + viewportRows + bufferRows * 2);
    const rendered = Math.max(0, last - first);

    console.debug && console.debug('TreeSidebar.slice', { totalVisibleNodes: total, viewportRows, firstIndex: first, lastIndex: last - 1, renderedCount: rendered });
  }, [scrollTop, listHeight, visibleNodes.length, bufferRows, rowHeight]);

  // virtualization status log (kept minimal)
  console.debug && console.debug('TreeSidebar: FixedSizeList available=', !!FixedSizeListComp, 'visibleNodes=', visibleNodes.length);

  return (
    <div className="w-full h-full flex flex-col">
      <div className="p-3 font-bold text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider border-b border-gray-200 dark:border-gray-800">
        {t('sidebar.catalog')}
      </div>
      <div ref={containerRef} onScroll={handleScroll} className="flex-1 overflow-y-auto scrollbar-thin">
          <TopicSection 
            onNavigateTopics={handleNavigateTopics}
            onCreateTopic={onCreateTopic}
            t={t}
            isSelected={activeViewMode === 'topics-overview'}
          />

          <div className="my-2 border-t border-gray-200 dark:border-gray-800"></div>

          {/** Build visible nodes and render via react-window for virtualization; fallback to safe render if lib unresolved **/}
          {visibleNodes.length > 0 && (
          FixedSizeListComp ? (
            <FixedSizeListComp
              height={listHeight}
              itemCount={visibleNodes.length}
              itemSize={rowHeight}
              width={'100%'}
              itemData={{ visibleNodes, files, currentFolderId: currentFolderForNodes, expandedSet, onToggle: stableOnToggle, onNavigate: stableOnNavigate, onContextMenu: stableOnContextMenu, onDropOnFolder: stableOnDropOnFolder }}
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
          ) : (
            // Lightweight local virtualization when react-window is unavailable
            (() => {
              const total = visibleNodes.length;
              const totalHeight = total * rowHeight;
              const viewportRows = Math.ceil(listHeight / rowHeight);
              const first = Math.max(0, Math.floor(scrollTop / rowHeight) - bufferRows);
              const last = Math.min(total, first + viewportRows + bufferRows * 2);
              const topHeight = first * rowHeight;
              const bottomHeight = Math.max(0, (total - last) * rowHeight);
              const slice = visibleNodes.slice(first, last);

              return (
                <div style={{ height: totalHeight, position: 'relative' }}>
                  <div style={{ height: topHeight }} />
                  {slice.map((nodeItem) => (
                    <div key={nodeItem.id} style={{ height: rowHeight }}>
                      <TreeNode
                        node={nodeItem.node}
                        nodeId={nodeItem.id}
                        currentFolderId={currentFolderForNodes}
                        expandedSet={expandedSet}
                        hasFolderChildren={nodeItem.hasFolderChildren}
                        onToggle={stableOnToggle}
                        onNavigate={stableOnNavigate}
                        onContextMenu={stableOnContextMenu}
                        onDropOnFolder={stableOnDropOnFolder}
                        depth={nodeItem.depth}
                      />
                    </div>
                  ))}
                  <div style={{ height: bottomHeight }} />
                </div>
              );
            })()
          )
        )}
        
        <div className="my-2 border-t border-gray-200 dark:border-gray-800"></div>
        
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
          />

          <div className="my-2 border-t border-gray-200 dark:border-gray-800"></div>

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
        />
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
