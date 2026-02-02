import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Tag, Image as ImageIcon } from 'lucide-react';
import { FileType, FileNode } from '../types';
import { LayoutItem } from './useLayoutHook';

interface TagItemProps {
  tag: string;
  count: number;
  isSelected: boolean;
  onTagClick: (tag: string, e: React.MouseEvent) => void;
  onTagDoubleClick: (tag: string) => void;
  onTagContextMenu: (e: React.MouseEvent, tag: string) => void;
  handleMouseEnter: (e: React.MouseEvent, tag: string) => void;
  handleMouseLeave: () => void;
  style?: React.CSSProperties;
}

const TagItem = React.memo(({ 
  tag, 
  count, 
  isSelected, 
  onTagClick, 
  onTagDoubleClick, 
  onTagContextMenu, 
  handleMouseEnter, 
  handleMouseLeave,
  style
}: TagItemProps) => {
  return (
    <div 
      key={tag} 
      data-tag={tag}
      className={`tag-item rounded-lg p-4 border-2 cursor-pointer group transition-all relative ${isSelected ? 'bg-blue-100 dark:bg-blue-900/50 border-blue-500 shadow-lg ring-2 ring-blue-300/50 dark:ring-blue-700/50' : 'bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-800 hover:border-blue-500 dark:hover:border-blue-500'}`} 
      style={style}
      onClick={(e) => { e.stopPropagation(); onTagClick && onTagClick(tag, e); }}
      onMouseDown={(e) => e.stopPropagation()}
      onDoubleClick={() => onTagDoubleClick && onTagDoubleClick(tag)} 
      onContextMenu={(e) => onTagContextMenu && onTagContextMenu(e, tag)}
      onMouseEnter={(e) => handleMouseEnter(e, tag)}
      onMouseLeave={handleMouseLeave}
    >
      <div className="flex items-center justify-between mb-2">
        <Tag size={20} className={`${isSelected ? 'text-blue-600' : 'text-blue-500 dark:text-blue-400'} group-hover:scale-110 transition-transform`} />
        <span className={`${isSelected ? 'bg-blue-200 dark:bg-blue-800 text-blue-800 dark:text-blue-200' : 'bg-gray-200 dark:bg-gray-700 text-gray-600 dark:text-gray-300'} text-xs px-2 py-0.5 rounded-full`}>{count}</span>
      </div>
      <div className="font-bold text-gray-800 dark:text-gray-200 truncate">{tag}</div>
      {isSelected && (<div className="absolute top-2 left-2 w-3 h-3 bg-blue-500 rounded-full ring-2 ring-white dark:ring-gray-900 shadow-md"></div>)}
    </div>
  );
});

interface TagsListProps {
  groupedTags: Record<string, string[]>;
  keys: string[];
  files: Record<string, FileNode>;
  selectedTagIds: string[];
  onTagClick: (tag: string, e: React.MouseEvent) => void;
  onTagDoubleClick: (tag: string) => void;
  onTagContextMenu: (e: React.MouseEvent, tag: string) => void;
  t: (key: string) => string;
  searchQuery?: string;
  layout: LayoutItem[];
  totalHeight: number;
  scrollTop: number;
  containerHeight: number;
}

export const TagsList = React.memo(({ 
  groupedTags, 
  keys, 
  files, 
  selectedTagIds, 
  onTagClick, 
  onTagDoubleClick, 
  onTagContextMenu, 
  t, 
  searchQuery,
  layout,
  totalHeight,
  scrollTop,
  containerHeight
}: TagsListProps) => {
  const [hoveredTag, setHoveredTag] = useState<string | null>(null);
  const [hoveredTagPos, setHoveredTagPos] = useState<{ top: number, left: number } | null>(null);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  
  // Tag counts
  const tagCounts = useMemo(() => {
      const counts: Record<string, number> = {};
      Object.values(files).forEach((f: FileNode) => {
          if (f.tags) {
              f.tags.forEach((t: string) => {
                  counts[t] = (counts[t] || 0) + 1;
              });
          }
      });
      return counts;
  }, [files]);

  // Preview images logic
  const previewImages = useMemo(() => {
    if (!hoveredTag) return [];
    const res: FileNode[] = [];
    const allFiles = Object.values(files);
    // Find last 3 images with this tag
    for (let i = allFiles.length - 1; i >= 0 && res.length < 3; i--) {
        const f = allFiles[i];
        if (f.type === FileType.IMAGE && f.tags?.includes(hoveredTag)) {
            res.push(f);
        }
    }
    return res;
  }, [hoveredTag, files]);

  // Filter keys for the index-bar (still needed visually)
  const filteredKeys = useMemo(() => {
    const query = searchQuery?.toLowerCase().trim();
    if (!query) return keys;
    return keys.filter(key => {
        const tags = groupedTags[key];
        return tags?.some(tag => tag.toLowerCase().includes(query));
    });
  }, [keys, groupedTags, searchQuery]);

  const visibleItems = useMemo(() => {
    const buffer = 400; 
    const minY = scrollTop - buffer;
    const maxY = scrollTop + containerHeight + buffer;
    return layout.filter(item => item.y < maxY && item.y + item.height > minY);
  }, [layout, scrollTop, containerHeight]);

  const handleMouseEnter = useCallback((e: React.MouseEvent, tag: string) => {
    const target = e.currentTarget as HTMLElement;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    
    hoverTimerRef.current = setTimeout(() => {
      const rect = target.getBoundingClientRect();
      const PREVIEW_WIDTH = 256; 
      const PREVIEW_HEIGHT = 120;
      
      let left = rect.left + (rect.width / 2) - (PREVIEW_WIDTH / 2);
      let top = rect.bottom + 10;

      if (left < 10) left = 10;
      if (left + PREVIEW_WIDTH > window.innerWidth) left = window.innerWidth - PREVIEW_WIDTH - 10;
      if (top + PREVIEW_HEIGHT > window.innerHeight) top = rect.top - PREVIEW_HEIGHT - 10;

      setHoveredTagPos({ top, left });
      setHoveredTag(tag);
    }, 600);
  }, []);

  const handleMouseLeave = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    setHoveredTag(null);
    setHoveredTagPos(null);
  }, []);
  
  // 计算并维护字母索引栏相对于视口的 top（使其垂直居中于文件列表区域）
  const [indexTop, setIndexTop] = useState<number | null>(null);

  const computeIndexTop = useCallback(() => {
    try {
      const container = document.getElementById('file-grid-container');
      if (container) {
        const rect = container.getBoundingClientRect();
        const top = rect.top + rect.height / 2; // 相对于视口的 y
        setIndexTop(Math.round(top));
        return;
      }
    } catch (e) {
      // ignore
    }
    // fallback: 视口中心
    setIndexTop(Math.round(window.innerHeight / 2));
  }, []);

  useEffect(() => {
    computeIndexTop();
    const onResize = () => computeIndexTop();
    const onScroll = () => computeIndexTop();
    window.addEventListener('resize', onResize);
    window.addEventListener('scroll', onScroll, true);
    const ro = new MutationObserver(() => computeIndexTop());
    ro.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ['class', 'style'] });
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('scroll', onScroll, true);
      ro.disconnect();
    };
  }, [computeIndexTop]);

  return (
    <div className="relative" style={{ height: totalHeight }}>
      {/* 字母索引栏 */}
      {filteredKeys.length > 0 && createPortal(
        <div className="fixed transform -translate-y-1/2 z-[110] bg-white/80 dark:bg-gray-900/80 backdrop-blur-sm rounded-full px-1 py-2 shadow-md border border-gray-200 dark:border-gray-800 transition-all duration-300"
             style={{ right: 'calc(20px + var(--metadata-panel-width, 0px))', top: indexTop != null ? `${indexTop}px` : '50%' }}
             onMouseEnter={() => {
              const metadataPanel = document.querySelector('.metadata-panel-container') as HTMLElement | null;
              if (metadataPanel) {
                metadataPanel.style.zIndex = '10';
              }
            }}
            onMouseLeave={() => {
              const metadataPanel = document.querySelector('.metadata-panel-container') as HTMLElement | null;
              if (metadataPanel) {
                metadataPanel.style.zIndex = '40';
              }
            }}
        >
          <div className="flex flex-col items-center space-y-1">
            {filteredKeys.map((group: string) => (
              <button
                key={group}
                onClick={() => {
                  const headerItem = layout.find(item => item.id === `header:${group}`);
                  if (headerItem) {
                    const container = document.getElementById('file-grid-container'); 
                    if (container) {
                      container.scrollTo({ top: headerItem.y, behavior: 'smooth' });
                    }
                  }
                }}
                className="w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                title={group}
              >
                {group}
              </button>
            ))}
          </div>
        </div>,
        // 渲染到 body，确保 fixed 相对于视口
        (typeof document !== 'undefined' ? document.body : null) as Element
      )}
      
      {/* 标签列表内容 */}
      {layout.length === 0 && (
          <div className="flex flex-col items-center justify-center h-full text-gray-400">
              <Tag size={64} className="mb-4 opacity-20"/>
              <p>{t('sidebar.noTagsFound')}</p>
          </div>
      )}

      {visibleItems.map(item => {
          if (item.id.startsWith('header:')) {
              const group = item.id.replace('header:', '');
              // Count tags in this group for display
              const countInGroup = groupedTags[group]?.length || 0;
              return (
                  <div 
                    key={item.id} 
                    id={`tag-group-${group}`} 
                    className="absolute flex items-center border-b border-gray-100 dark:border-gray-800 transition-colors"
                    style={{
                        left: item.x,
                        top: item.y,
                        width: item.width,
                        height: item.height,
                        zIndex: 10,
                        backgroundColor: 'inherit' // Helps with backdrop logic
                    }}
                  >
                       <div className="w-8 h-8 rounded-lg bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-400 flex items-center justify-center font-bold text-lg mr-3 shadow-sm border border-blue-100 dark:border-blue-900/50">
                          {group}
                       </div>
                       <span className="text-xs font-medium text-gray-400 dark:text-gray-500 uppercase tracking-wider">
                          {countInGroup} {t('context.items')}
                       </span>
                  </div>
              );
          } else if (item.id.startsWith('tag:')) {
              const tag = item.id.replace('tag:', '');
              const count = tagCounts[tag] || 0;
              const isSelected = selectedTagIds.includes(tag);
              return (
                 <TagItem 
                     key={item.id}
                     tag={tag}
                     count={count}
                     isSelected={isSelected}
                     onTagClick={onTagClick}
                     onTagDoubleClick={onTagDoubleClick}
                     onTagContextMenu={onTagContextMenu}
                     handleMouseEnter={handleMouseEnter}
                     handleMouseLeave={handleMouseLeave}
                     style={{
                         position: 'absolute',
                         left: item.x,
                         top: item.y,
                         width: item.width,
                         height: item.height
                     }}
                 />
              );
          }
          return null;
      })}

      {hoveredTag && previewImages.length > 0 && hoveredTagPos && createPortal(
        <div 
          className="fixed z-[100] bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl p-3 w-64 animate-fade-in pointer-events-none" 
          style={{ top: hoveredTagPos.top, left: hoveredTagPos.left }}
        >
          <div className="text-sm text-gray-800 dark:text-gray-200 mb-2 border-b border-gray-200 dark:border-gray-700 pb-1 font-bold flex items-center justify-between">
             <span>{t('sidebar.tagPreview')} "{hoveredTag}"</span>
             <span className="text-[10px] bg-gray-100 dark:bg-gray-700 px-1.5 rounded">{previewImages.length} {t('sidebar.recent')}</span>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {previewImages.map((f: any) => (
              <div key={f.id} className="aspect-square bg-gray-100 dark:bg-black rounded border border-gray-200 dark:border-gray-800 overflow-hidden">
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
  );
}, (prev, next) => {
    return prev.groupedTags === next.groupedTags && 
           prev.files === next.files && 
           prev.selectedTagIds === next.selectedTagIds &&
           prev.keys === next.keys &&
           prev.searchQuery === next.searchQuery &&
           prev.layout === next.layout &&
           prev.totalHeight === next.totalHeight &&
           prev.scrollTop === next.scrollTop &&
           prev.containerHeight === next.containerHeight; 
});
