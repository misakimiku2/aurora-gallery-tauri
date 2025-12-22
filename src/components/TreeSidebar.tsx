
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { FileNode, FileType, TaskProgress, Person } from '../types';
import { ChevronRight, ChevronDown, Folder, HardDrive, Tag as TagIcon, Plus, User, Check, Copy, Settings, WifiOff, Wifi, Loader2, Maximize2, Brain, Book, Film, Network, ImageIcon } from 'lucide-react';

interface TreeProps {
  files: Record<string, FileNode>;
  nodeId: string;
  currentFolderId: string;
  expandedIds: string[];
  onToggle: (id: string) => void;
  onNavigate: (id: string) => void;
  onContextMenu: (e: React.MouseEvent, type: 'file' | 'tag' | 'root-folder', id: string) => void;
  depth?: number;
}

const TreeNode: React.FC<TreeProps> = ({ files, nodeId, currentFolderId, expandedIds, onToggle, onNavigate, onContextMenu, depth = 0 }) => {
  const node = files[nodeId];

  if (!node || node.type !== FileType.FOLDER) return null;

  const isRoot = depth === 0;
  const isSelected = nodeId === currentFolderId;
  const expanded = expandedIds.includes(nodeId);
  
  const folderChildren = node.children?.filter(childId => files[childId]?.type === FileType.FOLDER) || [];

  const handleToggle = (e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(nodeId);
  };

  const handleClick = () => {
    onNavigate(nodeId);
  };

  const handleContextMenu = (e: React.MouseEvent) => {
    onContextMenu(e, isRoot ? 'root-folder' : 'file', nodeId);
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
          ${isSelected ? 'bg-blue-600 text-white border-l-4 border-blue-300 shadow-md' : 'hover:bg-gray-200 dark:hover:bg-gray-800'}
        `}
        style={{ paddingLeft: `${depth * 12 + 8}px` }}
        onClick={handleClick}
        onContextMenu={handleContextMenu}
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

      {expanded && folderChildren.map(childId => (
        <TreeNode 
          key={childId}
          files={files}
          nodeId={childId}
          currentFolderId={currentFolderId}
          expandedIds={expandedIds}
          onToggle={onToggle}
          onNavigate={onNavigate}
          onContextMenu={onContextMenu}
          depth={depth + 1}
        />
      ))}
    </div>
  );
};

interface PeopleSectionProps {
  people: Record<string, Person>;
  files: Record<string, FileNode>;
  onPersonSelect: (personId: string) => void;
  onNavigateAllPeople: () => void;
  onContextMenu: (e: React.MouseEvent, type: 'person', id: string) => void;
  onStartRenamePerson: (personId: string) => void;
  onCreatePerson: () => void;
  t: (key: string) => string;
}

const PeopleSection: React.FC<PeopleSectionProps> = ({ people, files, onPersonSelect, onNavigateAllPeople, onContextMenu, onStartRenamePerson, onCreatePerson, t }) => {
  const [expanded, setExpanded] = useState(true);
  const peopleList = useMemo(() => Object.values(people), [people]);

  return (
      <div className="select-none text-sm text-gray-600 dark:text-gray-300 relative">
        <div 
          className="flex items-center py-1 px-2 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-800 mt-2 group"
          onClick={(e) => {
              if ((e.target as HTMLElement).closest('.expand-icon')) {
                  e.stopPropagation();
                  setExpanded(!expanded);
              } else {
                  onNavigateAllPeople();
              }
          }}
        >
          <div className="expand-icon p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded">
            {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          </div>
          <div className="flex items-center flex-1">
            <Brain size={14} className="mr-2 text-purple-500 dark:text-purple-400" />
            <span className="font-bold text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider group-hover:text-black dark:group-hover:text-white transition-colors">{t('sidebar.people')} ({peopleList.length})</span>
          </div>
          <button 
           className="p-1 rounded hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors opacity-0 group-hover:opacity-100"
           onClick={(e) => { e.stopPropagation(); onCreatePerson(); }}
           title={t('context.newPerson')}
          >
           <Plus size={14} />
          </button>
        </div>

        {expanded && (
          <div className="pl-6 pr-2 pb-2 mt-1">
             {peopleList.length === 0 ? (
                 <div className="text-xs text-gray-400 italic py-1">{t('sidebar.noPeople')}</div>
             ) : (
                 <div className="grid grid-cols-4 gap-2">
                     {peopleList.map(person => {
                        const coverFile = files[person.coverFileId];
                        
                        return (
                           <div 
                              key={person.id} 
                              className="flex flex-col items-center group cursor-pointer"
                              onClick={() => onPersonSelect(person.id)}
                              onContextMenu={(e) => onContextMenu(e, 'person', person.id)}
                              onDoubleClick={(e) => {
                                  e.stopPropagation();
                                  onStartRenamePerson(person.id);
                              }}
                              title={person.name}
                           >
                              <div className="w-10 h-10 rounded-full border border-gray-200 dark:border-gray-700 overflow-hidden bg-gray-100 dark:bg-gray-800 hover:border-purple-500 dark:hover:border-purple-400 hover:ring-2 ring-purple-200 dark:ring-purple-900 transition-all shadow-sm relative">
                                 {coverFile ? (
                                   // Note: In Tauri, file.url and file.previewUrl are file paths, not usable URLs
                                   // Use placeholder for now - could be enhanced to load thumbnail separately
                                   <div className="w-full h-full flex items-center justify-center bg-gray-200 dark:bg-gray-700">
                                     <User size={16} className="text-gray-400 dark:text-gray-500" />
                                   </div>
                                 ) : (
                                   <div className="w-full h-full flex items-center justify-center text-gray-400"><User size={16}/></div>
                                 )}
                              </div>
                              <span className="text-[10px] mt-1 text-gray-600 dark:text-gray-400 truncate w-full text-center group-hover:text-purple-600 dark:group-hover:text-purple-300">{person.name}</span>
                              <span className="text-[9px] text-gray-500 dark:text-gray-500 truncate w-full text-center">{person.count} {t('sidebar.files')}</span>
                           </div>
                        );
                     })}
                 </div>
             )}
          </div>
        )}
      </div>
  );
};

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
}

const TagSection: React.FC<TagSectionProps> = ({ 
  files, customTags, onTagSelect, onNavigateAllTags, onContextMenu, 
  isCreatingTag, onStartCreateTag, onSaveNewTag, onCancelCreateTag, t 
}) => {
  const [expanded, setExpanded] = useState(false);
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);
  const [hoveredTagPos, setHoveredTagPos] = useState<{top: number, left: number} | null>(null);
  const [tagInputValue, setTagInputValue] = useState('');
  
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isCreatingTag) {
      setExpanded(true);
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

  const sortedTags = useMemo(() => {
    const allTags = new Set<string>(customTags);
    Object.values(files).forEach((file: FileNode) => {
      file.tags.forEach(tag => allTags.add(tag));
    });
    return Array.from(allTags).sort((a, b) => a.localeCompare(b, 'zh-CN'));
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
    const taggedFiles = Object.values(files)
      .filter((f: FileNode) => f.type === FileType.IMAGE && f.tags.includes(hoveredTag))
      .sort((a, b) => 1); 
    return taggedFiles.slice(-3).reverse();
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
        className="flex items-center py-1 px-2 cursor-pointer hover:bg-gray-200 dark:hover:bg-gray-800 mt-2 group"
      >
        <div className="p-1 mr-1 hover:bg-black/10 dark:hover:bg-white/10 rounded" onClick={() => setExpanded(!expanded)}>
           {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
        </div>
        <div className="flex items-center flex-1" onClick={onNavigateAllTags}>
          <TagIcon size={14} className="mr-2 text-blue-500 dark:text-blue-400" />
          <span className="font-bold text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider group-hover:text-black dark:group-hover:text-white transition-colors">{t('sidebar.allTags')} ({sortedTags.length})</span>
        </div>
        <button 
           className="p-1 rounded hover:bg-gray-300 dark:hover:bg-gray-700 text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 transition-colors opacity-0 group-hover:opacity-100"
           onClick={(e) => { e.stopPropagation(); onStartCreateTag(); }}
           title={t('context.newTag')}
        >
           <Plus size={14} />
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
                     <ul className="absolute left-2 right-2 top-full mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-md shadow-lg z-50 overflow-hidden">
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
                   {Object.values(files).filter((f: FileNode) => f.tags.includes(tag)).length}
                 </span>
              </div>
              
              {hoveredTag === tag && previewImages.length > 0 && hoveredTagPos && createPortal(
                <div 
                  className="fixed z-[100] bg-white dark:bg-[#2d3748] border border-gray-200 dark:border-gray-700 rounded-lg shadow-xl p-3 w-64 animate-fade-in pointer-events-none" 
                  style={{ top: hoveredTagPos.top, left: hoveredTagPos.left }}
                >
                  <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 border-b border-gray-200 dark:border-gray-600 pb-1 font-bold flex items-center justify-between">
                     <span>{t('sidebar.tagPreview')} "{hoveredTag}"</span>
                     <span className="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 rounded">{previewImages.length} {t('sidebar.recent')}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {previewImages.map(img => (
                      <div key={img.id} className="aspect-square bg-gray-100 dark:bg-black rounded border border-gray-200 dark:border-gray-700 overflow-hidden">
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
}

export const Sidebar: React.FC<{
  roots: string[];
  files: Record<string, FileNode>;
  people: Record<string, Person>;
  customTags: string[];
  currentFolderId: string;
  expandedIds: string[];
  tasks?: TaskProgress[];
  onToggle: (id: string) => void;
  onNavigate: (id: string) => void;
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
  onStartRenamePerson: (personId: string) => void;
  onCreatePerson: () => void;
  t: (key: string) => string;
}> = ({ roots, files, people, customTags, currentFolderId, expandedIds, tasks, onToggle, onNavigate, onTagSelect, onNavigateAllTags, onPersonSelect, onNavigateAllPeople, onContextMenu, isCreatingTag, onStartCreateTag, onSaveNewTag, onCancelCreateTag, onOpenSettings, onRestoreTask, onStartRenamePerson, onCreatePerson, t }) => {
  
  const minimizedTasks = tasks ? tasks.filter(task => task.minimized && task.status === 'running') : [];

  return (
    <div className="w-full h-full flex flex-col">
      <div className="p-3 font-bold text-gray-500 dark:text-gray-400 text-xs uppercase tracking-wider border-b border-gray-200 dark:border-gray-800">
        {t('sidebar.catalog')}
      </div>
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {roots.map(rootId => (
          <TreeNode 
            key={rootId}
            files={files}
            nodeId={rootId}
            currentFolderId={currentFolderId}
            expandedIds={expandedIds}
            onToggle={onToggle}
            onNavigate={onNavigate}
            onContextMenu={onContextMenu}
          />
        ))}
        
        <div className="my-2 border-t border-gray-200 dark:border-gray-800"></div>
        
        <PeopleSection 
           people={people}
           files={files}
           onPersonSelect={onPersonSelect}
           onNavigateAllPeople={onNavigateAllPeople}
           onContextMenu={onContextMenu}
           onStartRenamePerson={onStartRenamePerson}
           onCreatePerson={onCreatePerson}
           t={t}
        />

        <div className="my-2 border-t border-gray-200 dark:border-gray-800"></div>
        
        <TagSection 
          files={files} 
          customTags={customTags}
          onTagSelect={onTagSelect} 
          onNavigateAllTags={onNavigateAllTags} 
          onContextMenu={onContextMenu}
          isCreatingTag={isCreatingTag}
          onStartCreateTag={onStartCreateTag}
          onSaveNewTag={onSaveNewTag}
          onCancelCreateTag={onCancelCreateTag}
          t={t}
        />
      </div>
      
      {minimizedTasks.length > 0 && (
          <div className="border-t border-gray-200 dark:border-gray-800 p-2 bg-gray-50 dark:bg-gray-900/50">
             <div className="text-[10px] text-gray-400 uppercase font-bold mb-1 px-1">{t('sidebar.tasks')}</div>
             <div className="space-y-1">
                 {minimizedTasks.map(task => {
                    const percent = Math.round((task.current / task.total) * 100);
                    return (
                        <div key={task.id} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded p-2 text-xs shadow-sm cursor-pointer group hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors animate-fade-in" onClick={() => onRestoreTask(task.id)}>
                           <div className="flex justify-between items-center mb-1">
                               <span className="font-medium text-gray-700 dark:text-gray-200 truncate pr-2">{task.title}</span>
                               <Maximize2 size={10} className="text-gray-400 opacity-0 group-hover:opacity-100 transition-opacity"/>
                           </div>
                           <div className="w-full bg-gray-200 dark:bg-gray-700 h-1 rounded-full overflow-hidden">
                               <div className="bg-blue-500 h-full rounded-full transition-all duration-300" style={{ width: `${percent}%` }}></div>
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
           <Settings size={18} className="mr-3" />
           <span className="text-sm font-medium">{t('sidebar.settings')}</span>
         </button>
      </div>

      <div className="p-2 bg-gray-100 dark:bg-gray-850 border-t border-gray-200 dark:border-gray-700 text-xs text-gray-500 text-center">
        <div>{t('sidebar.localSupport')}</div>
      </div>
    </div>
  );
};
