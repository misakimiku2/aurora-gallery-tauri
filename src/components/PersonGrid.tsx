import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Person, FileNode, TabState } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { User } from 'lucide-react';
import { useLayout, LayoutItem } from './useLayoutHook';

const PersonCard = React.memo(({
  person,
  files,
  isSelected,
  onPersonClick,
  onPersonDoubleClick,
  onStartRenamePerson,
  onPersonContextMenu,
  t,
  style
}: {
  person: Person;
  files: Record<string, FileNode>;
  isSelected: boolean;
  onPersonClick: (id: string, e: React.MouseEvent) => void;
  onPersonDoubleClick: (id: string) => void;
  onStartRenamePerson?: (id: string) => void;
  onPersonContextMenu: (e: React.MouseEvent, id: string) => void;
  t: (key: string) => string;
  style: any;
}) => {
  if (!person) return null;
  
  const coverFile = files[person.coverFileId];
  const hasCover = !!coverFile;
  const coverSrc = coverFile?.path ? convertFileSrc(coverFile.path) : null;
  const { width, height, x, y } = style;
  const avatarSize = Math.min(width, height - 60); // Allow space for text

  return (
    <div
      className="person-item absolute flex flex-col items-center group cursor-pointer perspective-1000"
      data-id={person.id}
      style={{ 
        left: x, 
        top: y, 
        width, 
        height,
        transition: 'all 0.3s cubic-bezier(0.25, 0.8, 0.25, 1)'
      }}
      onClick={(e) => onPersonClick(person.id, e)}
      onContextMenu={(e) => onPersonContextMenu(e, person.id)}
    >
      <div 
        className={`rounded-full p-1 transition-all duration-300 relative shadow-md transform group-hover:scale-105 group-hover:-translate-y-1 group-hover:shadow-2xl
          ${isSelected 
            ? 'bg-blue-600 ring-4 ring-blue-300/60 dark:ring-blue-700/60 shadow-lg' 
            : 'bg-gradient-to-tr from-gray-200 to-gray-300 dark:from-gray-700 dark:to-gray-600 hover:from-blue-400 hover:to-blue-600'
          }
        `}
        style={{ width: avatarSize, height: avatarSize }}
        onDoubleClick={() => onPersonDoubleClick(person.id)}
      >
        <div className="w-full h-full rounded-full bg-white dark:bg-gray-800 overflow-hidden border-[3px] border-white dark:border-gray-800 relative">
          <div className="w-full h-full transition-transform duration-500 group-hover:scale-110">
            {hasCover && coverSrc ? (
               person.faceBox ? (
                  <img 
                      src={coverSrc} 
                      alt={person.name}
                      className="absolute max-w-none"
                      decoding="async"
                      style={{
                          width: `${10000 / Math.max(person.faceBox.w, 2.0)}%`,
                          height: `${10000 / Math.max(person.faceBox.h, 2.0)}%`,
                          left: 0,
                          top: 0,
                          transformOrigin: 'top left',
                          transform: `translate3d(${-person.faceBox.x}%, ${-person.faceBox.y}%, 0)`,
                          willChange: 'transform, width, height',
                          backfaceVisibility: 'hidden',
                          imageRendering: 'auto'
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
              <div className="w-full h-full flex items-center justify-center bg-gray-100 dark:bg-gray-700 text-gray-300 dark:text-gray-500">
                <User size={avatarSize * 0.4} strokeWidth={1.5} />
              </div>
            )}
          </div>
        </div>
        
        {/* Count Badge */}
        <div className="absolute bottom-0 right-0 bg-white dark:bg-gray-800 text-gray-600 dark:text-gray-300 text-xs font-bold px-2 py-0.5 rounded-full border border-gray-200 dark:border-gray-700 shadow-sm z-10">
          {person.count}
        </div>
      </div>
      
      <div className="mt-4 text-center w-full px-2">
        <div 
          className={`font-bold text-base truncate transition-colors px-2 rounded-md ${isSelected ? 'text-blue-700 dark:text-blue-300 bg-blue-100 dark:bg-blue-900/50 ring-2 ring-blue-300/50 dark:ring-blue-700/50' : 'text-gray-800 dark:text-gray-100 group-hover:text-blue-600 dark:group-hover:text-blue-400'}`}
          onDoubleClick={() => onStartRenamePerson?.(person.id)}
        >
          {person.name}
        </div>
        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1 font-medium">
          {person.count} {t('context.files')}
        </div>
      </div>
    </div>
  );
});

interface PersonGridProps {
    people: Record<string, Person>;
    files: Record<string, FileNode>;
    selectedPersonIds: string[];
    onPersonClick: (id: string, e: React.MouseEvent) => void;
    onPersonDoubleClick: (id: string) => void;
    onPersonContextMenu: (e: React.MouseEvent, id: string) => void;
    onStartRenamePerson?: (id: string) => void;
    t: (key: string) => string;
    onBackgroundContextMenu?: (e: React.MouseEvent) => void;
    // Layout props
    thumbnailSize: number;
    containerRef?: React.RefObject<HTMLDivElement>;
    containerRect: { width: number, height: number };
    scrollTop: number;
    // Selection Box props (optional, if we want to render selection box here)
    // For now we assume the parent handles selection box global overlay, 
    // but the PersonGrid needs to handle the interaction potentially.
}

export const PersonGrid = ({
    people,
    files,
    selectedPersonIds,
    onPersonClick,
    onPersonDoubleClick,
    onPersonContextMenu,
    onStartRenamePerson,
    t,
    thumbnailSize = 140, // minLimit in FileGrid was 140
    containerRef,
    containerRect,
    scrollTop
}: PersonGridProps) => {

    // Filter valid people
    const peopleList = useMemo(() => {
        return Object.values(people).sort((a, b) => b.count - a.count);
    }, [people]);

    const peopleIds = useMemo(() => peopleList.map(p => p.id), [peopleList]);

    // Use shared layout hook
    const { layout, totalHeight } = useLayout(
        peopleIds,
        files, // layout worker ignores files for people-overview but needs the arg
        'grid', // layoutMode (ignored for people-overview)
        containerRect.width,
        thumbnailSize,
        'people-overview',
        undefined, // groupedTags
        people
    );

    // Scroll restoration when layout loads
    React.useEffect(() => {
        if (containerRef?.current && totalHeight > 0 && scrollTop > 0) {
            // Restore only if significant difference to avoid interfering with active scrolling
            if (Math.abs(containerRef.current.scrollTop - scrollTop) > 100) {
                 containerRef.current.scrollTop = scrollTop;
            }
        }
    }, [totalHeight]);

    // Virtualization
    const visibleItems = useMemo(() => {
        // 降低渲染缓冲区，从 800px 减少到 400px (约 2 排缩略图)
        const buffer = 400; 
        const minY = scrollTop - buffer;
        const maxY = scrollTop + containerRect.height + buffer;
        return layout.filter(item => item.y < maxY && item.y + item.height > minY);
    }, [layout, scrollTop, containerRect.height, totalHeight]);


    return (
        <div className="w-full min-w-0 h-full" style={{ position: 'relative' }}>
            {peopleIds.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-gray-400 w-full h-full min-h-[400px]">
                    <User size={80} strokeWidth={1.5} className="mb-4 opacity-20" />
                    <p className="text-xl font-medium">{t('sidebar.noPeople')}</p>
                </div>
            ) : (
                <div className="min-w-0" style={{ position: 'relative' }}>
                    <div
                        className="relative min-w-0"
                        style={{
                            width: '100%',
                            maxWidth: '100%',
                            height: totalHeight,
                            position: 'relative'
                        }}
                    >
                        {visibleItems.map((item) => {
                            const person = people[item.id];
                            if (!person) return null;
                            return (
                                <PersonCard
                                    key={person.id}
                                    person={person}
                                    files={files}
                                    isSelected={selectedPersonIds.includes(person.id)}
                                    onPersonClick={onPersonClick}
                                    onPersonDoubleClick={onPersonDoubleClick}
                                    onStartRenamePerson={onStartRenamePerson}
                                    onPersonContextMenu={onPersonContextMenu}
                                    t={t}
                                    style={item}
                                />
                            );
                        })}
                    </div>
                </div>
            )}
        </div>
    );
};
