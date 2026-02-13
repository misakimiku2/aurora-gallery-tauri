﻿import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { Person, FileNode, TabState, PersonSortOption, PersonGroupByOption, SortDirection, Topic } from '../types';
import { convertFileSrc } from '@tauri-apps/api/core';
import { User, ChevronDown } from 'lucide-react';
import { useLayout, LayoutItem } from './useLayoutHook';
import { getPinyinGroup } from '../utils/textUtils';

interface PersonGroup {
    id: string;
    title: string;
    personIds: string[];
}

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
  const avatarSize = Math.min(width, height - 60);

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

const GroupHeader = React.memo(({ group, collapsed, onToggle, t }: { group: PersonGroup, collapsed: boolean, onToggle: (id: string) => void, t: (key: string) => string }) => {
  return (
    <div 
      className="flex items-center py-2 px-4 bg-gray-50 dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 cursor-pointer select-none hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors sticky top-0 z-20"
      onClick={() => onToggle(group.id)}
    >
      <div className={`mr-2 p-1 rounded-full transition-transform duration-200 ${collapsed ? '-rotate-90' : 'rotate-0'}`}>
        <ChevronDown size={16} className="text-gray-500" />
      </div>
      <span className="font-bold text-sm text-gray-700 dark:text-gray-200">{group.title}</span>
      <span className="ml-2 text-xs text-gray-400 bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded-full">{group.personIds.length}</span>
    </div>
  );
});

interface PersonGridProps {
    people: Record<string, Person>;
    files: Record<string, FileNode>;
    topics?: Record<string, Topic>;
    selectedPersonIds: string[];
    onPersonClick: (id: string, e: React.MouseEvent) => void;
    onPersonDoubleClick: (id: string) => void;
    onPersonContextMenu: (e: React.MouseEvent, id: string) => void;
    onStartRenamePerson?: (id: string) => void;
    t: (key: string) => string;
    onBackgroundContextMenu?: (e: React.MouseEvent) => void;
    thumbnailSize: number;
    containerRef?: React.RefObject<HTMLDivElement>;
    containerRect: { width: number, height: number };
    scrollTop: number;
    // 排序和分组选项
    sortBy?: PersonSortOption;
    sortDirection?: SortDirection;
    groupBy?: PersonGroupByOption;
}

export const PersonGrid = ({
    people,
    files,
    topics = {},
    selectedPersonIds,
    onPersonClick,
    onPersonDoubleClick,
    onPersonContextMenu,
    onStartRenamePerson,
    t,
    thumbnailSize = 140,
    containerRef,
    containerRect,
    scrollTop,
    sortBy = 'count',
    sortDirection = 'desc',
    groupBy = 'none'
}: PersonGridProps) => {

    // 排序人物列表
    const sortedPeopleList = useMemo(() => {
        const peopleList = Object.values(people);
        
        // 创建新数组并排序，避免修改原数组
        return [...peopleList].sort((a, b) => {
            let comparison = 0;
            
            switch (sortBy) {
                case 'name':
                    comparison = a.name.localeCompare(b.name, 'zh-CN');
                    break;
                case 'count':
                    comparison = a.count - b.count;
                    break;
                case 'created':
                    // 使用 coverFileId 对应的文件创建时间作为人物的创建时间
                    const fileA = files[a.coverFileId];
                    const fileB = files[b.coverFileId];
                    const dateA = fileA?.meta?.created ? new Date(fileA.meta.created).getTime() : 0;
                    const dateB = fileB?.meta?.created ? new Date(fileB.meta.created).getTime() : 0;
                    comparison = dateA - dateB;
                    break;
                default:
                    comparison = a.count - b.count;
            }
            
            return sortDirection === 'asc' ? comparison : -comparison;
        });
    }, [people, files, sortBy, sortDirection]);

    // 分组逻辑
    const groupedPeople = useMemo(() => {
        if (groupBy === 'none') {
            return [{ id: 'all', title: t('context.allPeople') || '所有人物', personIds: sortedPeopleList.map(p => p.id) }];
        }
        
        const groups: Record<string, string[]> = {};
        
        sortedPeopleList.forEach(person => {
            let groupKey = '';
            
            switch (groupBy) {
                case 'name':
                    // 使用项目中已有的 getPinyinGroup 函数获取首字母
                    groupKey = getPinyinGroup(person.name);
                    break;
                    
                case 'topic':
                    // 按专题分组
                    const personTopics = Object.values(topics).filter(topic => 
                        topic.peopleIds?.includes(person.id)
                    );
                    if (personTopics.length > 0) {
                        // 人物可能属于多个专题，将其放入第一个专题
                        groupKey = personTopics[0].name;
                    } else {
                        groupKey = t('sidebar.noTopics') || '未分类';
                    }
                    break;
                    
                default:
                    groupKey = 'all';
            }
            
            if (!groups[groupKey]) {
                groups[groupKey] = [];
            }
            groups[groupKey].push(person.id);
        });
        
        // 转换为数组并排序
        return Object.entries(groups)
            .map(([key, personIds]) => ({
                id: key,
                title: key,
                personIds
            }))
            .sort((a, b) => {
                // 特殊分组排序
                if (a.id === '0-9') return -1;
                if (b.id === '0-9') return 1;
                if (a.id === '#') return 1;
                if (b.id === '#') return -1;
                if (a.id === (t('sidebar.noTopics') || '未分类')) return 1;
                if (b.id === (t('sidebar.noTopics') || '未分类')) return -1;
                return a.title.localeCompare(b.title, 'zh-CN');
            });
    }, [sortedPeopleList, groupBy, topics, t]);

    // 折叠状态
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
    
    const handleToggleGroup = useCallback((groupId: string) => {
        setCollapsedGroups(prev => ({
            ...prev,
            [groupId]: !prev[groupId]
        }));
    }, []);

    // 无分组时的布局计算（使用 hook）
    const { layout: noGroupLayout, totalHeight: noGroupTotalHeight } = useLayout(
        groupBy === 'none' ? sortedPeopleList.map(p => p.id) : [],
        files,
        'grid',
        containerRect.width,
        thumbnailSize,
        'people-overview'
    );

    // 分组布局计算（不使用 hook，直接计算）
    const groupLayouts = useMemo(() => {
        if (groupBy === 'none') {
            return {};
        }

        const GAP = 16;
        const PADDING = 24;
        const safeContainerWidth = containerRect.width > 0 ? containerRect.width : 1280;
        const availableWidth = Math.max(100, safeContainerWidth - (PADDING * 2));
        const minColWidth = thumbnailSize;
        const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
        const itemWidth = (availableWidth - (cols - 1) * GAP) / cols;
        const itemHeight = itemWidth + 60; // Extra space for text

        const layouts: Record<string, { layout: LayoutItem[], totalHeight: number }> = {};

        groupedPeople.forEach(group => {
            const layout: LayoutItem[] = [];
            const isCollapsed = collapsedGroups?.[group.id];

            if (!isCollapsed) {
                let colIndex = 0;
                let rowIndex = 0;

                const TOP_PADDING = 16; // 为选中时的 ring 效果预留空间

                group.personIds.forEach((personId) => {
                    const person = people[personId];
                    if (!person) return;

                    const x = PADDING + colIndex * (itemWidth + GAP);
                    const y = TOP_PADDING + rowIndex * (itemHeight + GAP);

                    layout.push({
                        id: personId,
                        x,
                        y,
                        width: itemWidth,
                        height: itemHeight
                    });

                    colIndex++;
                    if (colIndex >= cols) {
                        colIndex = 0;
                        rowIndex++;
                    }
                });

                const rowsInGroup = Math.ceil(group.personIds.length / cols);
                const totalHeight = TOP_PADDING + rowsInGroup * (itemHeight + GAP);
                layouts[group.id] = { layout, totalHeight };
            } else {
                layouts[group.id] = { layout: [], totalHeight: 0 };
            }
        });

        return layouts;
    }, [groupedPeople, groupBy, containerRect.width, thumbnailSize, collapsedGroups, people]);

    // 无分组时的虚拟化
    const noGroupVisibleItems = useMemo(() => {
        if (groupBy !== 'none') return [];
        const buffer = 400;
        const minY = scrollTop - buffer;
        const maxY = scrollTop + containerRect.height + buffer;
        return noGroupLayout.filter(item => item.y < maxY && item.y + item.height > minY);
    }, [noGroupLayout, scrollTop, containerRect.height, groupBy]);

    return (
        <div className="w-full min-w-0 h-full" style={{ position: 'relative' }}>
            {sortedPeopleList.length === 0 ? (
                <div className="flex flex-col items-center justify-center text-gray-400 w-full h-full min-h-[400px]">
                    <User size={80} strokeWidth={1.5} className="mb-4 opacity-20" />
                    <p className="text-xl font-medium">{t('sidebar.noPeople')}</p>
                </div>
            ) : groupBy === 'none' ? (
                // 无分组视图
                <div className="relative min-w-0" style={{ height: noGroupTotalHeight }}>
                    {noGroupVisibleItems.map((item) => {
                        if (item.id.startsWith('header:')) return null;
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
            ) : (
                // 分组视图
                <div className="w-full min-w-0">
                    {groupedPeople.map((group) => {
                        const { layout, totalHeight } = groupLayouts[group.id] || { layout: [], totalHeight: 0 };
                        const isCollapsed = !!collapsedGroups[group.id];

                        return (
                            <div key={group.id} className={isCollapsed ? '' : 'mb-1'}>
                                <GroupHeader
                                    group={group}
                                    collapsed={isCollapsed}
                                    onToggle={handleToggleGroup}
                                    t={t}
                                />
                                {!isCollapsed && (
                                    <div className="relative min-w-0 px-6 pt-6 pb-4" style={{ height: totalHeight + 24 }}>
                                        {layout.map((item) => {
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
                                )}
                            </div>
                        );
                    })}
                </div>
            )}
        </div>
    );
};
