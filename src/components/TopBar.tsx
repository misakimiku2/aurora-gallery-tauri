import React, { useState, useRef, useEffect, useMemo } from 'react';
import { TabState, AppState, SearchScope, LayoutMode, SortOption, DateFilter, GroupByOption, PersonSortOption, PersonGroupByOption, SortDirection } from '../types';
import { debounce } from '../utils/debounce';
import { isAndroidSync } from '../utils/androidPlatform';
import { ColorPickerPopover } from './ColorPickerPopover';
import {
  Sidebar, ChevronLeft, ChevronRight, ArrowUp, RefreshCw,
  Search, Palette, Loader2, Sliders, Filter, LayoutGrid, List, Grid, LayoutTemplate,
  ArrowDownUp, Calendar, PanelRight, X, Tag,
  FileText, Folder, Globe, ChevronDown, Check, Sun, Moon, Monitor,
  ChevronUp, Users, Sparkles, Image as ImageIcon, Upload
} from 'lucide-react';

interface TopBarProps {
  activeTab: TabState;
  state: AppState;
  toolbarQuery: string;
  groupedTags: Record<string, string[]>;
  tagSearchQuery: string;
  personSearchQuery?: string;
  onToggleSidebar: () => void;
  onGoBack: () => void;
  onGoForward: () => void;
  onNavigateUp: () => void;
  onSetTagSearchQuery: (query: string) => void;
  onSetPersonSearchQuery?: (query: string) => void;
  onTagClick: (tag: string, e: React.MouseEvent) => void;
  onRefresh: () => void;
  onSearchScopeChange: (scope: SearchScope) => void;
  onPerformSearch: (query: string) => Promise<void> | void;
  onSetToolbarQuery: (query: string) => void;
  onLayoutModeChange: (mode: LayoutMode) => void;
  onSortOptionChange: (option: SortOption) => void;
  onSortDirectionChange: () => void;
  onThumbnailSizeChange: (size: number) => void;
  onToggleMetadata: () => void;
  onToggleColorPicker?: () => void;
  isColorPickerVisible?: boolean;
  onToggleSettings: () => void;
  onUpdateDateFilter: (filter: DateFilter) => void;
  groupBy: GroupByOption;
  onGroupByChange: (option: GroupByOption) => void;
  isAISearchEnabled: boolean;
  onToggleAISearch: () => void;
  onRememberFolderSettings?: () => void;
  hasFolderSettings?: boolean;
  // --- Topic view specific controls ---
  topicLayoutMode?: LayoutMode;
  onTopicLayoutModeChange?: (mode: LayoutMode) => void;
  // --- Folders overview specific controls ---
  folderLayoutMode?: LayoutMode;
  onFolderLayoutModeChange?: (mode: LayoutMode) => void;
  // --- Pagination ---
  totalResults?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  // --- People view specific controls ---
  personSortBy?: PersonSortOption;
  personSortDirection?: SortDirection;
  personGroupBy?: PersonGroupByOption;
  onPersonSortByChange?: (option: PersonSortOption) => void;
  onPersonSortDirectionChange?: () => void;
  onPersonGroupByChange?: (option: PersonGroupByOption) => void;
  t: (key: string) => string;
  // --- CLIP Search ---
  isClipSearchEnabled?: boolean;
  onToggleClipSearch?: () => void;
  onClipSearch?: (query: string) => Promise<void>;
  clipEnabled?: boolean;
  clipModelName?: string;
  onOpenClipSettings?: () => void;
  showToast?: (message: string) => void;
  showLanUpload?: boolean;
  onUploadToLan?: () => void;
}

const PaginationControls = ({ current, total, pageSize, onPageChange, t }: { current: number, total: number, pageSize: number, onPageChange: (page: number) => void, t: any }) => {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center gap-1 ml-2 px-2 py-1 bg-surface rounded-md border border-subtle">
      <button 
        disabled={current <= 1}
        onClick={() => onPageChange(current - 1)}
        className="p-1 hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed rounded"
        title={t('search.prevPage') || 'Previous Page'}
      >
        <ChevronLeft size={16} />
      </button>
      
      <div className="flex items-center text-xs font-medium px-2 min-w-[80px] justify-center">
        <span className="text-blue-600 dark:text-blue-400">{current}</span>
        <span className="mx-1 text-gray-400">/</span>
        <span className="text-gray-600 dark:text-gray-400">{totalPages}</span>
        <span className="ml-2 text-[10px] text-gray-400 font-normal">({total})</span>
      </div>

      <button 
        disabled={current >= totalPages}
        onClick={() => onPageChange(current + 1)}
        className="p-1 hover:bg-surface disabled:opacity-30 disabled:cursor-not-allowed rounded"
        title={t('search.nextPage') || 'Next Page'}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
};

const TagsWidget = ({ groupedTags, onTagClick, t, tagSearchQuery, onSetTagSearchQuery, isMobile = false }: { groupedTags: Record<string, string[]>, onTagClick: (tag: string, e: React.MouseEvent) => void, t: (key: string) => string, tagSearchQuery: string, onSetTagSearchQuery: (query: string) => void, isMobile?: boolean }) => {
  const [localSearchQuery, setLocalSearchQuery] = React.useState(tagSearchQuery);
  const [isFocused, setIsFocused] = React.useState(false);
  
  // 当外部tagSearchQuery变化时，更新本地状?
  React.useEffect(() => {
    setLocalSearchQuery(tagSearchQuery);
  }, [tagSearchQuery]);
  
  // 获取所有标签列表，用于智能联想
  const allTags = React.useMemo(() => {
    const tagsSet = new Set<string>();
    Object.values(groupedTags || {}).forEach(tags => {
      tags.forEach(tag => tagsSet.add(tag));
    });
    return Array.from(tagsSet);
  }, [groupedTags]);
  
  // 过滤标签，只显示匹配搜索条件的标�?
  const filteredGroupedTags = React.useMemo(() => {
    if (!localSearchQuery) return groupedTags;
    
    const filtered: Record<string, string[]> = {};
    Object.entries(groupedTags).forEach(([key, tags]) => {
      const matchingTags = tags.filter(tag => 
        tag.toLowerCase().includes(localSearchQuery.toLowerCase())
      );
      if (matchingTags.length > 0) {
        filtered[key] = matchingTags;
      }
    });
    return filtered;
  }, [groupedTags, localSearchQuery]);
  
  // 智能联想的标签列�?
  const suggestedTags = React.useMemo(() => {
    if (!localSearchQuery || !isFocused) return [];
    return allTags
      .filter(tag => tag.toLowerCase().includes(localSearchQuery.toLowerCase()))
      .sort()
      .slice(0, 10);
  }, [allTags, localSearchQuery, isFocused]);
  
  const keys = Object.keys(filteredGroupedTags).sort();
  const totalTags = Object.values(filteredGroupedTags || {}).reduce((acc, curr) => acc + curr.length, 0);

  return (
    <div className={`flex flex-col select-none bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md text-gray-900 dark:text-white shadow-[0_12px_40px_rgba(0,0,0,0.15)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.7)] overflow-hidden font-sans border border-gray-200 dark:border-gray-800 z-50 ${isMobile ? 'w-full max-h-[70vh] rounded-t-2xl' : 'w-80 max-h-[550px] rounded-lg animate-zoom-in'}`}>
      <div className="px-4 py-3 border-b border-black/5 dark:border-white/10 dark:bg-white/5">
        <div className="flex items-center justify-between mb-3">
          <span className="font-bold text-sm tracking-wide">{t('sidebar.allTags')}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded-full">
            {totalTags}
          </span>
        </div>
        <div className="relative">
          <Search size={isMobile ? 16 : 14} className="absolute left-2.5 top-1/2 transform -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            id="tag-search-input"
            name="tag-search-input"
            placeholder={t('search.placeholder')}
            value={localSearchQuery}
            onChange={(e) => {
              setLocalSearchQuery(e.target.value);
              onSetTagSearchQuery(e.target.value);
            }}
            onFocus={() => setIsFocused(true)}
            onBlur={() => {
              // 延迟关闭，以便点击建议项时能触发点击事件
              setTimeout(() => setIsFocused(false), 200);
            }}
            className={`w-full pl-8 pr-2 ${isMobile ? 'py-2.5' : 'py-1.5'} rounded-md border border-gray-200 dark:border-gray-800 bg-surface text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
          />
          {localSearchQuery && (
            <button
              onClick={() => {
                setLocalSearchQuery('');
                onSetTagSearchQuery('');
              }}
              className="absolute right-2.5 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <X size={isMobile ? 16 : 14} />
            </button>
          )}
          
          {/* 智能联想下拉列表 */}
          {suggestedTags.length > 0 && (
            <div className="absolute top-full left-0 right-0 bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-800 mt-1 rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] z-50 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600">
              {suggestedTags.map(tag => (
                <div 
                  key={tag} 
                  className="px-4 py-2 hover:bg-blue-600 hover:text-white text-sm cursor-pointer text-gray-800 dark:text-gray-200"
                  onClick={() => {
                    setLocalSearchQuery(tag);
                    onSetTagSearchQuery(tag);
                  }}
                >
                  {tag}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="flex-1 flex overflow-hidden">
        {/* 标签列表内容 */}
        <div className="flex-1 overflow-y-auto p-4 scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600">
          {keys.length === 0 && (
            <div className="text-center text-gray-400 text-xs py-4 italic">{t('sidebar.noTagsFound')}</div>
          )}
          {keys.map(key => (
            <div id={`tag-widget-group-${key}`} key={key} className="mb-4 last:mb-0">
              <div className="text-xs font-bold text-gray-400 dark:text-gray-500 mb-2 uppercase border-b border-black/5 dark:border-white/10 pb-1">{key}</div>
              <div className="flex flex-wrap gap-2">
                {filteredGroupedTags[key].map(tag => (
                  <button
                    key={tag}
                    onClick={(e) => onTagClick(tag, e)}
                    className={`${isMobile ? 'text-sm px-3 py-1.5' : 'text-xs px-2.5 py-1'} rounded-md bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 border border-blue-100 dark:border-blue-900/30 transition-colors truncate max-w-full text-left`}
                    title={tag}
                  >
                    {tag}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
        {/* 字母索引�?*/}
        {keys.length > 0 && (
          <div className={`${isMobile ? 'w-8' : 'w-6'} flex flex-col items-center py-2 space-y-1 dark:bg-[#3a3a3a]/50 border-l border-black/5 dark:border-white/10 overflow-y-auto no-scrollbar`}>
            {keys.map(key => (
              <button
                key={key}
                onClick={() => {
                  const element = document.getElementById(`tag-widget-group-${key}`);
                  if (element) {
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className={`${isMobile ? 'w-7 h-7 text-sm' : 'w-5 h-5 text-xs'} rounded-full flex items-center justify-center font-medium text-gray-600 dark:text-gray-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:text-blue-600 dark:hover:text-blue-400 transition-colors`}
                title={key}
              >
                {key}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

const CalendarWidget = ({
  dateFilter,
  onUpdate,
  t,
  isMobile = false
}: {
  dateFilter: DateFilter,
  onUpdate: (f: DateFilter) => void,
  t: (key: string) => string,
  isMobile?: boolean
}) => {
  // Initialize view based on start date or current date
  const [viewDate, setViewDate] = useState(() => dateFilter.start ? new Date(dateFilter.start) : new Date());
  
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();

  const handlePrevMonth = () => setViewDate(new Date(year, month - 1, 1));
  const handleNextMonth = () => setViewDate(new Date(year, month + 1, 1));
  
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const firstDayOfWeek = new Date(year, month, 1).getDay(); // 0=Sun

  // Previous month days to fill grid
  const daysInPrevMonth = new Date(year, month, 0).getDate();
  const prevMonthDays = Array.from({ length: firstDayOfWeek }).map((_, i) => daysInPrevMonth - firstDayOfWeek + i + 1);

  // Next month days to fill grid (6 rows * 7 cols = 42 cells total)
  const totalCells = 42;
  const currentDaysCount = daysInMonth;
  const nextMonthDaysCount = totalCells - currentDaysCount - firstDayOfWeek;
  const nextMonthDays = Array.from({ length: nextMonthDaysCount }).map((_, i) => i + 1);

  const handleDateClick = (day: number, type: 'current' | 'prev' | 'next') => {
    let targetYear = year;
    let targetMonth = month;

    if (type === 'prev') {
        targetMonth -= 1;
        if (targetMonth < 0) { targetMonth = 11; targetYear -= 1; }
    } else if (type === 'next') {
        targetMonth += 1;
        if (targetMonth > 11) { targetMonth = 0; targetYear += 1; }
    }

    // Create date in local time at noon to avoid timezone rolling issues
    const clickedDate = new Date(targetYear, targetMonth, day, 12, 0, 0);
    const dateStr = clickedDate.toISOString();

    if (!dateFilter.start || (dateFilter.start && dateFilter.end)) {
        // Start new range
        onUpdate({ ...dateFilter, start: dateStr, end: null });
    } else {
        // Complete range
        const start = new Date(dateFilter.start);
        const current = new Date(dateStr);
        
        if (current < start) {
            onUpdate({ ...dateFilter, start: dateStr, end: dateFilter.start });
        } else {
            onUpdate({ ...dateFilter, end: dateStr });
        }
    }
    
    // If clicked prev/next month, update view
    if (type !== 'current') {
        setViewDate(new Date(targetYear, targetMonth, 1));
    }
  };

  const getDayStatus = (day: number, type: 'current' | 'prev' | 'next') => {
      if (!dateFilter.start) return 'none';
      
      let targetYear = year;
      let targetMonth = month;
      if (type === 'prev') targetMonth--;
      if (type === 'next') targetMonth++;

      const current = new Date(targetYear, targetMonth, day, 12, 0, 0);
      // Normalize comparison by using timestamps at noon
      const currentTs = current.getTime();
      
      const start = new Date(dateFilter.start);
      start.setHours(12, 0, 0, 0);
      const startTs = start.getTime();

      if (dateFilter.end) {
          const end = new Date(dateFilter.end);
          end.setHours(12, 0, 0, 0);
          const endTs = end.getTime();

          if (currentTs === startTs || currentTs === endTs) return 'selected';
          if (currentTs > startTs && currentTs < endTs) return 'in-range';
      } else {
          if (currentTs === startTs) return 'selected';
      }
      return 'none';
  };

  const weekDays = ['日', '一', '二', '三', '四', '五', '六'];

  return (
      <div className={`flex flex-col select-none bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md text-gray-900 dark:text-white shadow-[0_12px_40px_rgba(0,0,0,0.15)] dark:shadow-[0_12px_40px_rgba(0,0,0,0.7)] overflow-hidden font-sans border border-gray-200 dark:border-gray-800 z-50 ${isMobile ? 'w-full rounded-t-2xl' : 'w-80 rounded-lg animate-zoom-in'}`}>
          {/* Controls Header */}
          <div className={`flex items-center justify-between ${isMobile ? 'px-5 py-5' : 'px-4 py-4'} dark:bg-white/5 border-b border-black/5 dark:border-white/10`}>
              <div className={`font-bold ${isMobile ? 'text-lg' : 'text-base'} tracking-wide pl-1 text-gray-800 dark:text-gray-100`}>
                  {year}年{month + 1}月
              </div>
              <div className="flex space-x-1">
                  <button onClick={handlePrevMonth} className={`${isMobile ? 'p-2' : 'p-1'} hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors`}>
                      <ChevronUp size={isMobile ? 20 : 16} />
                  </button>
                  <button onClick={handleNextMonth} className={`${isMobile ? 'p-2' : 'p-1'} hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors`}>
                      <ChevronDown size={isMobile ? 20 : 16} />
                  </button>
              </div>
          </div>

          {/* Grid */}
          <div className={`${isMobile ? 'px-5 py-5' : 'px-4 py-4'}`}>
              <div className="grid grid-cols-7 mb-2">
                  {weekDays.map(d => (
                      <div key={d} className={`text-center ${isMobile ? 'text-sm' : 'text-xs'} text-gray-400 dark:text-gray-500 font-bold py-1`}>
                          {d}
                      </div>
                  ))}
              </div>
              <div className="grid grid-cols-7 gap-y-2">
                  {/* Prev Month Days */}
                  {prevMonthDays.map((day) => {
                      const status = getDayStatus(day, 'prev');
                      let bgClass = 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700';
                      if (status === 'selected') bgClass = 'bg-blue-500 text-white shadow-md rounded-full z-10 hover:bg-blue-600 dark:hover:bg-blue-700';
                      else if (status === 'in-range') bgClass = 'bg-blue-100 dark:bg-blue-900/40 text-gray-300 dark:text-gray-600';
                      
                      return (
                          <div key={`prev-${day}`} 
                               onClick={() => handleDateClick(day, 'prev')}
                               className={`${isMobile ? 'h-10 w-10' : 'h-8 w-8'} mx-auto flex items-center justify-center ${isMobile ? 'text-sm' : 'text-xs'} font-medium relative transition-colors ${status !== 'in-range' ? 'rounded-full' : ''} ${bgClass}`}
                          >
                              {day}
                          </div>
                      );
                  })}

                  {/* Current Month Days */}
                  {Array.from({ length: daysInMonth }).map((_, i) => {
                      const day = i + 1;
                      const status = getDayStatus(day, 'current');
                      
                      let containerClass = `${isMobile ? 'h-10' : 'h-8'} w-full flex items-center justify-center relative`;
                      let btnClass = `${isMobile ? 'h-10 w-10' : 'h-8 w-8'} flex items-center justify-center ${isMobile ? 'text-sm' : 'text-xs'} font-medium transition-all cursor-pointer rounded-full`;
                      
                      if (status === 'selected') {
                          btnClass += ' bg-blue-500 text-white shadow-lg shadow-blue-500/30';
                      } else if (status === 'in-range') {
                          containerClass += ' bg-blue-100 dark:bg-blue-900/40'; // Continuous background
                          btnClass += ' text-blue-600 dark:text-blue-300 rounded-none w-full';
                      } else {
                          btnClass += ' text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700';
                      }

                      // Adjust rounding for range ends visually
                      if (status === 'selected' && dateFilter.end && dateFilter.start) {
                          const currentTs = new Date(year, month, day, 12, 0, 0).getTime();
                          const startTs = new Date(dateFilter.start).setHours(12,0,0,0);
                          const endTs = new Date(dateFilter.end).setHours(12,0,0,0);
                          
                          if (currentTs === startTs && currentTs !== endTs) {
                              // Start of range - fill right half
                              containerClass = "h-8 w-full flex items-center justify-center relative bg-gradient-to-r from-transparent from-50% to-blue-100 to-50% dark:to-blue-900/40";
                          }
                          if (currentTs === endTs && currentTs !== startTs) {
                              // End of range - fill left half
                              containerClass = "h-8 w-full flex items-center justify-center relative bg-gradient-to-l from-transparent from-50% to-blue-100 to-50% dark:to-blue-900/40";
                          }
                      }

                      return (
                          <div key={`curr-${day}`} className={containerClass} onClick={() => handleDateClick(day, 'current')}>
                              <div className={btnClass}>
                                  {day}
                              </div>
                          </div>
                      );
                  })}

                  {/* Next Month Days */}
                  {nextMonthDays.map((day) => {
                      const status = getDayStatus(day, 'next');
                      let bgClass = 'text-gray-300 dark:text-gray-600 hover:text-gray-500 dark:hover:text-gray-400 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700';
                      if (status === 'selected') bgClass = 'bg-blue-500 text-white shadow-md rounded-full z-10 hover:bg-blue-600 dark:hover:bg-blue-700';
                      else if (status === 'in-range') bgClass = 'bg-blue-100 dark:bg-blue-900/40 text-gray-300 dark:text-gray-600';

                      return (
                          <div key={`next-${day}`} 
                               onClick={() => handleDateClick(day, 'next')}
                               className={`${isMobile ? 'h-10 w-10' : 'h-8 w-8'} mx-auto flex items-center justify-center ${isMobile ? 'text-sm' : 'text-xs'} font-medium relative transition-colors ${status !== 'in-range' ? 'rounded-full' : ''} ${bgClass}`}
                          >
                              {day}
                          </div>
                      );
                  })}
              </div>
          </div>

          {/* Mode Switcher */}
          <div className={`${isMobile ? 'p-5' : 'p-4'} border-t border-black/5 dark:border-white/10 dark:bg-[#3a3a3a]/50`}>
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-bold">{t('date.filterBy')}</div>
              <div className="flex gap-2">
                  <button
                      onClick={() => onUpdate({ ...dateFilter, mode: 'created' })}
                      className={`flex-1 ${isMobile ? 'py-2.5 px-3 text-sm' : 'py-1.5 px-2 text-xs'} font-medium rounded transition-all border ${
                          dateFilter.mode === 'created' 
                          ? 'bg-blue-500 border-blue-500 text-white shadow-sm' 
                          : 'bg-white dark:bg-white/10 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
                      }`}
                  >
                      {t('date.createdDate')}
                  </button>
                  <button
                      onClick={() => onUpdate({ ...dateFilter, mode: 'updated' })}
                      className={`flex-1 ${isMobile ? 'py-2.5 px-3 text-sm' : 'py-1.5 px-2 text-xs'} font-medium rounded transition-all border ${
                          dateFilter.mode === 'updated' 
                          ? 'bg-blue-500 border-blue-500 text-white shadow-sm' 
                          : 'bg-white dark:bg-white/10 border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-200'
                      }`}
                  >
                      {t('date.updatedDate')}
                  </button>
              </div>
              <div className="mt-4 flex justify-between items-center">
                  <div className="text-xs text-gray-600 dark:text-gray-400">
                      {dateFilter.start ? (
                          <span>{new Date(dateFilter.start).toLocaleDateString()} {dateFilter.end ? `- ${new Date(dateFilter.end).toLocaleDateString()}` : ''}</span>
                      ) : t('date.startDate')}
                  </div>
                  <button 
                    onClick={() => onUpdate({ start: null, end: null, mode: 'created' })}
                    className="text-xs text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 transition-colors font-medium"
                  >
                      {t('date.clearFilter')}
                  </button>
              </div>
          </div>
      </div>
  );
};

export const TopBar: React.FC<TopBarProps> = ({
  activeTab,
  state,
  toolbarQuery,
  groupedTags,
  tagSearchQuery,
  onToggleSidebar,
  onGoBack,
  onGoForward,
  onNavigateUp,
  onSetTagSearchQuery,
  onSetPersonSearchQuery,
  personSearchQuery,
  onTagClick,
  onRefresh,
  onSearchScopeChange,
  onPerformSearch,
  onSetToolbarQuery,
  onLayoutModeChange,
  onSortOptionChange,
  onSortDirectionChange,
  onThumbnailSizeChange,
  onToggleMetadata,
  onToggleColorPicker,
  isColorPickerVisible,
  onToggleSettings,
  onUpdateDateFilter,
  groupBy,
  onGroupByChange,
  isAISearchEnabled,
  onToggleAISearch,
  onRememberFolderSettings,
  hasFolderSettings,
  // Topic view props
  topicLayoutMode,
  onTopicLayoutModeChange,
  // Folders overview props
  folderLayoutMode,
  onFolderLayoutModeChange,
  // People view props
  personSortBy = 'count',
  personSortDirection = 'desc',
  personGroupBy = 'none',
  onPersonSortByChange,
  onPersonSortDirectionChange,
  onPersonGroupByChange,
  t,
  // CLIP Search
  isClipSearchEnabled = false,
  onToggleClipSearch,
  onClipSearch,
  clipEnabled = true,
  clipModelName,
  onOpenClipSettings,
  showToast,
  showLanUpload,
  onUploadToLan
}) => {
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [tagsMenuOpen, setTagsMenuOpen] = useState(false);
  const [personSortMenuOpen, setPersonSortMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const searchToggleRef = useRef(false);
  
  // Color Picker State
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isColorSearching, setIsColorSearching] = useState(false);
  const colorPickerContainerRef = useRef<HTMLDivElement>(null);
  
  // CLIP Search State
  const [isClipSearching, setIsClipSearching] = useState(false);

  const isAndroid = isAndroidSync();
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const [isCompactMode, setIsCompactMode] = useState(false);
  const [isSearchFocused, setIsSearchFocused] = useState(false);

  const getFolderDisplayName = () => {
    if (activeTab.viewMode === 'folders-overview') return t('sidebar.folders');
    if (activeTab.viewMode === 'lan-folders-overview') return t('sidebar.network.title') || '网络';
    if (activeTab.viewMode === 'tags-overview') return t('sidebar.allTags');
    if (activeTab.viewMode === 'topics-overview') {
      if (activeTab.activeTopicId) return (state.topics as any)?.[activeTab.activeTopicId]?.name || t('sidebar.topics');
      return t('sidebar.topics');
    }
    if (activeTab.viewMode === 'people-overview') {
      if (activeTab.activePersonId) return (state.people as any)?.[activeTab.activePersonId]?.name || t('context.allPeople');
      return t('context.allPeople');
    }
    if (activeTab.isCompareMode) return activeTab.sessionName || '画布01';
    if (activeTab.viewingFileId) {
      const file = state.files[activeTab.viewingFileId];
      if (file && file.parentId) {
        const parent = state.files[file.parentId];
        if (parent?.category === 'book' || parent?.category === 'sequence') return parent.name;
      }
      return file?.name || t('app.viewing');
    }
    if (activeTab.activeTags.length > 0) return `${activeTab.activeTags.length} ${t('app.filters')}`;
    return state.files[activeTab.folderId]?.name || '相册';
  };

  useEffect(() => {
    if (isAndroid && isSearchOpen && searchInputRef.current) {
      searchInputRef.current.focus();
    }
  }, [isAndroid, isSearchOpen]);

  useEffect(() => {
    if (!isAndroid) return;
    const handleCloseSearch = () => {
      if (isSearchOpen) {
        onSetToolbarQuery('');
        setIsSearchOpen(false);
        setIsCompactMode(false);
      }
    };
    window.addEventListener('close-android-search', handleCloseSearch);
    return () => window.removeEventListener('close-android-search', handleCloseSearch);
  }, [isAndroid, isSearchOpen, onSetToolbarQuery]);

  useEffect(() => {
    if (!isColorPickerOpen) return;
    // Android 端使用 MobileColorPickerSheet 自带的遮罩点击关闭，不需要 document mousedown 监听
    if (isAndroid) return;
    
    const handleClickOutside = (event: MouseEvent) => {
      if (colorPickerContainerRef.current && !colorPickerContainerRef.current.contains(event.target as Node)) {
        setIsColorPickerOpen(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isColorPickerOpen, isAndroid]);

  // Handle mouse side buttons (back/forward)
  useEffect(() => {
    const handleMouseUp = (e: MouseEvent) => {
      // 3: Back button, 4: Forward button
      if (e.button === 3) {
        if (activeTab.history.currentIndex > 0) {
          e.preventDefault();
          onGoBack();
        }
      } else if (e.button === 4) {
        if (activeTab.history.currentIndex < activeTab.history.stack.length - 1) {
          e.preventDefault();
          onGoForward();
        }
      }
    };

    window.addEventListener('mouseup', handleMouseUp);
    return () => window.removeEventListener('mouseup', handleMouseUp);
  }, [onGoBack, onGoForward, activeTab.history.currentIndex, activeTab.history.stack.length]);

  useEffect(() => {
    if (!isAndroid) return;
    const handleAndroidBack = () => {
      const openMenus = [sortMenuOpen, filterMenuOpen, tagsMenuOpen, scopeMenuOpen, viewMenuOpen];
      if (openMenus.some(Boolean)) {
        setSortMenuOpen(false);
        setFilterMenuOpen(false);
        setTagsMenuOpen(false);
        setScopeMenuOpen(false);
        setViewMenuOpen(false);
        (window as any).__androidBackHandled = true;
        return;
      }
      if (isColorPickerVisible) {
        onToggleColorPicker?.();
        (window as any).__androidBackHandled = true;
      }
    };
    window.addEventListener('android-back-press', handleAndroidBack);
    return () => window.removeEventListener('android-back-press', handleAndroidBack);
  }, [isAndroid, sortMenuOpen, filterMenuOpen, tagsMenuOpen, scopeMenuOpen, viewMenuOpen, isColorPickerVisible, onToggleColorPicker]);

  const isColorSearchQuery = useMemo(() => toolbarQuery.startsWith('color:'), [toolbarQuery]);
  const isPaletteSearchQuery = useMemo(() => toolbarQuery.startsWith('palette:'), [toolbarQuery]);
  const currentSearchColor = useMemo(() => {
    if (!isColorSearchQuery) return '';
    const color = toolbarQuery.replace('color:', '');
    return color.startsWith('#') ? color : '#' + color;
  }, [isColorSearchQuery, toolbarQuery]);
  const paletteColors = useMemo(() => {
    if (!isPaletteSearchQuery) return [];
    const rawPalette = toolbarQuery.replace('palette:', '');
    return rawPalette.split(',').map(c => c.trim().startsWith('#') ? c.trim() : '#' + c.trim());
  }, [isPaletteSearchQuery, toolbarQuery]);

  const pickerInitialColor = useMemo(() => {
    // 1. Current typing in toolbar
    if (currentSearchColor) return currentSearchColor;
    
    // 2. Active search query string
    if (activeTab.searchQuery.startsWith('color:')) {
      return activeTab.searchQuery.replace('color:', '');
    }
    
    // 3. AI Filter structured data (if parsed)
    if (activeTab.aiFilter && activeTab.aiFilter.colors && activeTab.aiFilter.colors.length > 0) {
        // Return the first color found in the filter
        return activeTab.aiFilter.colors[0];
    }
    
    return '#ffffff';
  }, [currentSearchColor, activeTab.searchQuery, activeTab.aiFilter]);

  // Debounce color search to prevent event flooding
  // Increased to 300ms to avoid UI lag during dragging when search results are large
  // This ensures smooth color picking interaction
  const debouncedColorSearch = useMemo(() => 
    debounce(async (color: string) => {
       setIsColorSearching(true);
       try {
         await onPerformSearch(`color:${color}`);
       } catch (e) {
         console.error(e);
       } finally {
         setIsColorSearching(false);
       }
    }, 300)
  , [onPerformSearch]);

  const handleColorSelect = (color: string) => {
    debouncedColorSearch(color);
  };

  const getScopeIcon = (scope: SearchScope) => {
    switch (scope) {
      case 'file': return <FileText size={14} />;
      case 'tag': return <Tag size={14} />;
      case 'folder': return <Folder size={14} />;
      default: return <Globe size={14} />;
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      if (activeTab.viewMode === 'tags-overview') {
        onSetTagSearchQuery(toolbarQuery);
        return;
      }
      if (activeTab.viewMode === 'people-overview') {
        onSetPersonSearchQuery && onSetPersonSearchQuery(toolbarQuery);
        return;
      }
      onPerformSearch(toolbarQuery);
    }
  };

  return (
    <div className={`h-14 bg-content flex items-center px-4 justify-between shrink-0 z-30 space-x-4 ${isAndroid ? 'android-topbar' : ''}`}>
      {/* Left: Navigation */}
      <div className="flex items-center space-x-2 min-w-fit">
        <button onClick={onToggleSidebar} className={`${isAndroid ? 'w-10 h-10 flex items-center justify-center rounded-xl' : 'w-9 h-9 flex items-center justify-center rounded-lg'} hover:bg-surface ${state.layout.isSidebarVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`} title={t('viewer.toggleSidebar')}>
          <Sidebar size={18} />
        </button>
        <button onClick={onGoBack} disabled={activeTab.history.currentIndex <= 0} className={`${isAndroid ? 'w-10 h-10 flex items-center justify-center rounded-xl' : 'w-9 h-9 flex items-center justify-center rounded-lg'} hover:bg-surface disabled:opacity-30 text-gray-600 dark:text-gray-300 ${isCompactMode ? 'hidden' : ''}`}>
          <ChevronLeft size={18} />
        </button>
        {!isAndroid && (
          <>
            <button onClick={onGoForward} disabled={activeTab.history.currentIndex >= activeTab.history.stack.length - 1} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface disabled:opacity-30 text-gray-600 dark:text-gray-300">
              <ChevronRight size={18} />
            </button>
            <button onClick={onNavigateUp} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface text-gray-600 dark:text-gray-300" title={t('viewer.up')}>
              <ArrowUp size={18} />
            </button>
            <button onClick={() => onRefresh()} className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface text-gray-600 dark:text-gray-300" title={t('context.refresh')}>
              <RefreshCw size={16} />
            </button>
          </>
        )}
        {isAndroid && !isCompactMode && (
          <>
            <button onClick={() => {
              if (!isSearchOpen) {
                const isPortrait = typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches;
                const anyPanelOpen = state.layout.isSidebarVisible || state.layout.isMetadataVisible;
                if (isPortrait && anyPanelOpen) {
                  setIsCompactMode(true);
                }
                searchToggleRef.current = true;
                setIsSearchOpen(true);
              }
            }} className={`w-10 h-10 flex items-center justify-center rounded-xl hover:bg-surface ${isSearchOpen ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}>
              <Search size={18} />
            </button>
            {activeTab.viewMode !== 'topics-overview' && activeTab.viewMode !== 'people-overview' && !isCompactMode && (
              <div className="relative">
                <button
                  onClick={() => setSortMenuOpen(!sortMenuOpen)}
                  className={`w-10 h-10 flex items-center justify-center rounded-xl hover:bg-surface ${sortMenuOpen ? 'bg-surface text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
                  title={t('sort.sortBy')}
                >
                  <ArrowDownUp size={18} />
                </button>
                {sortMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setSortMenuOpen(false)}></div>
                    <div className="absolute top-full left-0 mt-2 w-48 bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-800 rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] z-50 py-2 animate-zoom-in">
                      <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('sort.sortBy')}</div>
                      {[
                        { id: 'name', label: t('sort.name') },
                        { id: 'date', label: t('sort.date') },
                        { id: 'size', label: t('sort.size') }
                      ].map(opt => (
                        <button
                          key={opt.id}
                          onClick={() => { onSortOptionChange(opt.id as SortOption); }}
                          className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                        >
                          {opt.label}
                          {state.sortBy === opt.id && <Check size={14} className="text-blue-500 group-hover:text-white" />}
                        </button>
                      ))}
                      <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                      <button
                        onClick={onSortDirectionChange}
                        className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                      >
                        {state.sortDirection === 'asc' ? t('sort.asc') : t('sort.desc')}
                        <ArrowDownUp size={14} className={state.sortDirection === 'asc' ? 'transform rotate-180' : ''}/>
                      </button>
                      {activeTab.viewMode !== 'folders-overview' && activeTab.viewMode !== 'lan-folders-overview' && (
                      <>
                      <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                      <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('groupBy.title')}</div>
                      {[
                        { id: 'none', label: t('groupBy.none') },
                        { id: 'type', label: t('groupBy.type') },
                        { id: 'date', label: t('groupBy.date') },
                        { id: 'size', label: t('groupBy.size') }
                      ].map(opt => (
                        <button
                          key={opt.id}
                          onClick={() => onGroupByChange(opt.id as GroupByOption)}
                          className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                        >
                          {opt.label}
                          {groupBy === opt.id && <Check size={14} className="text-blue-500 group-hover:text-white" />}
                        </button>
                      ))}
                      </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {/* Center: Search or Folder Name */}
      {isAndroid && !isSearchOpen ? (
        <div className="flex-1 flex items-center justify-center px-4">
          <span className={`text-sm font-medium text-gray-700 dark:text-gray-300 truncate text-center ${
            typeof window !== 'undefined' && window.matchMedia('(orientation: portrait)').matches
              ? state.layout.isMetadataVisible
                ? 'max-w-[3em]'
                : state.layout.isSidebarVisible
                  ? 'max-w-[8em]'
                  : 'max-w-full'
              : 'max-w-full'
          }`}>
            {getFolderDisplayName()}
          </span>
        </div>
      ) : (
      <div className={`flex-1 ${isAndroid ? 'max-w-none' : 'max-w-2xl'} relative flex items-center`}>
        <div className={`flex-1 flex items-center rounded-full px-3 py-1.5 transition-all border ${
          isColorSearchQuery
            ? 'bg-surface border-blue-500 shadow-sm'
            : isClipSearchEnabled && clipEnabled && clipModelName !== 'WD-EVA02-Large-Tagger-V3'
              ? 'bg-surface border-green-500 shadow-sm shadow-green-500/20'
              : isAISearchEnabled
                ? 'bg-surface border-purple-500 shadow-sm shadow-purple-500/20'
                : activeTab.searchQuery
                  ? 'bg-surface border-blue-500 shadow-sm'
                  : isSearchFocused
                    ? 'bg-surface border-subtle'
                    : 'bg-surface border-transparent hover:border-subtle'
        }`}>
          
          {activeTab.viewMode !== 'people-overview' && activeTab.viewMode !== 'tags-overview' && (
            <div className="relative flex-shrink-0">
              <button 
                onClick={() => setScopeMenuOpen(!scopeMenuOpen)}
                className="flex items-center text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mr-2 pr-2 border-r border-subtle whitespace-nowrap"
              >
                {getScopeIcon(activeTab.searchScope)}
                <ChevronDown size={12} className="ml-1 opacity-70"/>
              </button>
              {scopeMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setScopeMenuOpen(false)}></div>
                  <div className="absolute top-full left-0 mt-2 w-40 bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-800 rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] z-50 py-1 overflow-hidden animate-fade-in">
                    {[
                      { id: 'all', icon: Globe, label: t('search.scopeAll') },
                      { id: 'file', icon: FileText, label: t('search.scopeFile') },
                      { id: 'tag', icon: Tag, label: t('search.scopeTag') },
                      { id: 'folder', icon: Folder, label: t('search.scopeFolder') }
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => { onSearchScopeChange(opt.id as SearchScope); setScopeMenuOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-xs flex items-center hover:bg-blue-600 hover:text-white ${activeTab.searchScope === opt.id ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-gray-700 dark:text-gray-300'}`}
                      >
                        <opt.icon size={14} className="mr-2"/> {opt.label}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          <div className="relative" ref={colorPickerContainerRef}>
             {isAndroid ? (
               <>
             {isColorSearching ? (
                <Loader2 size={18} className="mr-1 flex-shrink-0 text-blue-500 animate-spin" />
             ) : (
                <button
                  onClick={() => onToggleColorPicker?.()}
                  className={`mr-1 flex-shrink-0 w-8 h-8 flex items-center justify-center rounded-full hover:bg-surface transition-colors ${isColorPickerVisible ? 'bg-blue-100 dark:bg-blue-900 text-blue-600 dark:text-blue-400' : isAISearchEnabled ? 'text-purple-500' : 'text-gray-500 dark:text-gray-400'}`}
                  title={t('search.byColor')}
                >
                  <Palette size={18} />
                </button>
             )}
               </>
             ) : (
               <>
             {isColorSearching ? (
                <Loader2 size={16} className="mr-2 flex-shrink-0 text-blue-500 animate-spin" />
             ) : (
                <button
                  onClick={() => setIsColorPickerOpen(!isColorPickerOpen)}
                  className={`mr-2 flex-shrink-0 cursor-pointer hover:text-blue-500 transition-colors ${isAISearchEnabled ? 'text-purple-500' : 'text-gray-400'} flex items-center`}
                  title={t('search.byColor')}
                >
                  <Palette size={16} />
                </button>
             )}

             {isColorPickerOpen && (
                <div className="absolute top-full left-0 mt-2 z-50">
                    <ColorPickerPopover
                       onChange={handleColorSelect}
                       onClose={() => setIsColorPickerOpen(false)}
                       initialColor={pickerInitialColor}
                      t={t}
                    />
                </div>
             )}
               </>
             )}
          </div>
          
          {isColorSearchQuery && (
            <div 
                className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-700 mr-2 flex-shrink-0 shadow-sm"
                style={{ backgroundColor: currentSearchColor }}
            />
          )}
          
          {isPaletteSearchQuery && paletteColors.length > 0 && (
            <div className="flex -space-x-1 mr-2 flex-shrink-0">
              {paletteColors.slice(0, 5).map((color, i) => (
                <div
                  key={i}
                  className="w-4 h-4 rounded-full border border-white dark:border-gray-700 shadow-sm"
                  style={{ backgroundColor: color, zIndex: 5 - i }}
                />
              ))}
            </div>
          )}

          <input
            ref={searchInputRef}
            type="text"
            id="toolbar-search-input"
            name="toolbar-search-input"
            className="bg-transparent border-none focus:outline-none text-sm w-full text-gray-800 dark:text-gray-200 placeholder-gray-400 dark:placeholder-gray-500 min-w-0"
            placeholder={
              activeTab.viewMode === 'people-overview'
                ? '搜索人物'
                : activeTab.viewMode === 'tags-overview'
                  ? '搜索标签'
                  : isClipSearchEnabled && clipEnabled && clipModelName !== 'WD-EVA02-Large-Tagger-V3'
                    ? '输入自然语言描述，如：夕阳下的海滩、穿红色衣服的人...'
                    : isAISearchEnabled
                      ? t('settings.aiSmartSearch')
                      : activeTab.searchScope === 'file'
                        ? '搜索文件名...'
                        : activeTab.searchScope === 'tag'
                          ? '搜索标签...'
                          : activeTab.searchScope === 'folder'
                            ? '搜索文件夹...'
                            : '搜索...'
            }
            value={
              activeTab.viewMode === 'people-overview' ? (personSearchQuery || '') :
              activeTab.viewMode === 'tags-overview' ? tagSearchQuery :
              (isColorSearchQuery || isPaletteSearchQuery) ? '' : toolbarQuery
            }
            onChange={(e) => {
              const v = e.target.value;
              onSetToolbarQuery(v);
              if (activeTab.viewMode === 'tags-overview') {
                onSetTagSearchQuery(v);
              } else if (activeTab.viewMode === 'people-overview') {
                onSetPersonSearchQuery && onSetPersonSearchQuery(v);
              }
            }}
            onKeyDown={handleKeyDown}
            onFocus={() => setIsSearchFocused(true)}
            onBlur={() => {
              setIsSearchFocused(false);
              if (isAndroid && !toolbarQuery && !searchToggleRef.current) {
                setIsSearchOpen(false);
                setIsCompactMode(false);
              }
              searchToggleRef.current = false;
            }}
          />

          <div className="flex items-center space-x-1 ml-2 flex-shrink-0">
             {isAndroid && isSearchOpen && (
                <button
                  onClick={() => {
                    onSetToolbarQuery('');
                    setIsSearchOpen(false);
                    setIsCompactMode(false);
                  }}
                  className="p-1 rounded-full hover:bg-surface text-gray-400 flex-shrink-0"
                >
                  <X size={16} />
                </button>
             )}
             {!isAndroid && toolbarQuery && (
                <button
                  onClick={() => {
                    if (activeTab.viewMode === 'tags-overview') {
                      onSetToolbarQuery('');
                      onSetTagSearchQuery('');
                    } else if (activeTab.viewMode === 'people-overview') {
                      onSetToolbarQuery('');
                      onSetPersonSearchQuery && onSetPersonSearchQuery('');
                    } else {
                      onSetToolbarQuery('');
                      onPerformSearch('');
                    }
                  }}
                  className="p-1 rounded-full hover:bg-surface text-gray-400 flex-shrink-0"
                >
                  <X size={14} />
                </button>
             )}
             
             {!isAndroid && activeTab.viewMode !== 'people-overview' && activeTab.viewMode !== 'tags-overview' && (
               <button
                 onClick={() => {
                   if (!clipEnabled) {
                     onOpenClipSettings && onOpenClipSettings();
                   } else if (clipModelName === 'WD-EVA02-Large-Tagger-V3') {
                     showToast && showToast('WD-EVA02-Large-Tagger-V3模型不支持语义搜索');
                     onOpenClipSettings && onOpenClipSettings();
                   } else {
                     onToggleClipSearch && onToggleClipSearch();
                   }
                 }}
                 disabled={isClipSearching}
                 className={`flex-shrink-0 cursor-pointer transition-colors flex items-center ${
                   !clipEnabled
                     ? 'text-gray-300 dark:text-gray-600 hover:text-gray-400 dark:hover:text-gray-500'
                     : clipModelName === 'WD-EVA02-Large-Tagger-V3'
                       ? 'text-gray-300 dark:text-gray-600 hover:text-gray-400 dark:hover:text-gray-500'
                       : isClipSearchEnabled
                         ? 'text-green-500 hover:text-green-600'
                         : 'text-gray-400 hover:text-green-500'
                 }`}
                 title={
                   !clipEnabled 
                     ? '需要开启AI视觉功能' 
                     : clipModelName === 'WD-EVA02-Large-Tagger-V3'
                       ? 'WD-EVA02-Large-Tagger-V3模型不支持语义搜索'
                       : isClipSearchEnabled 
                         ? 'CLIP 语义搜索已启用' 
                         : '启用 CLIP 语义搜索'
                 }
               >
                 {isClipSearching ? (
                   <Loader2 size={16} className="animate-spin" />
                 ) : (
                   <Sparkles size={16} />
                 )}
               </button>
             )}
          </div>
        </div>
      </div>
      )}

      {/* Right: Tools & Settings */}
      <div className="flex items-center space-x-2 min-w-fit">
        
        {/* People View Sort & Group Menu */}
        {activeTab.viewMode === 'people-overview' && (
          <div className="relative">
             <button 
               onClick={() => setPersonSortMenuOpen(!personSortMenuOpen)}
               className={`w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface ${personSortMenuOpen ? 'bg-surface text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
               title={t('sort.sortBy')}
             >
               <Users size={18} />
             </button>
             {personSortMenuOpen && (
               <>
                 <div className="fixed inset-0 z-40" onClick={() => setPersonSortMenuOpen(false)}></div>
                 <div className="absolute top-full right-0 mt-2 w-48 bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-800 rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] z-50 py-2 animate-zoom-in">
                    <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('person.sortBy')}</div>
                    {[
                      { id: 'name', label: t('sort.name') },
                      { id: 'count', label: t('person.fileCount') },
                      { id: 'created', label: t('sort.date') }
                    ].map(opt => (
                      <button
                        key={opt.id}
                        onClick={() => { onPersonSortByChange?.(opt.id as PersonSortOption); }}
                        className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                      >
                        {opt.label}
                        {personSortBy === opt.id && <Check size={14} className="text-blue-500 group-hover:text-white" />}
                      </button>
                    ))}
                    <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                    <button
                      onClick={() => onPersonSortDirectionChange?.()}
                      className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                    >
                      {personSortDirection === 'asc' ? t('sort.asc') : t('sort.desc')}
                      <ArrowDownUp size={14} className={personSortDirection === 'asc' ? 'transform rotate-180' : ''}/>
                    </button>
                    
                    <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                    <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('groupBy.title')}</div>
                    {[
                      { id: 'none', label: t('groupBy.none') },
                      { id: 'name', label: t('person.groupByName') },
                      { id: 'topic', label: t('person.groupByTopic') }
                    ].map(opt => (
                      <button
                        key={opt.id}
                        onClick={() => onPersonGroupByChange?.(opt.id as PersonGroupByOption)}
                        className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                      >
                        {opt.label}
                        {personGroupBy === opt.id && <Check size={14} className="text-blue-500 group-hover:text-white" />}
                      </button>
                    ))}
                 </div>
               </>
             )}
          </div>
        )}
        
        {/* Sort & Group Menu (hidden on topics view, people view, and Android) */}
        {!isAndroid && activeTab.viewMode !== 'topics-overview' && activeTab.viewMode !== 'people-overview' && (
        <div className="relative">
           <button 
             onClick={() => setSortMenuOpen(!sortMenuOpen)}
             className={`w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface ${sortMenuOpen ? 'bg-surface text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
             title={t('sort.sortBy')}
           >
             <ArrowDownUp size={18} />
           </button>
           {sortMenuOpen && (
             <>
               <div className="fixed inset-0 z-40" onClick={() => setSortMenuOpen(false)}></div>
               <div className="absolute top-full right-0 mt-2 w-48 bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-800 rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] z-50 py-2 animate-zoom-in">
                  <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('sort.sortBy')}</div>
                  {[
                    { id: 'name', label: t('sort.name') },
                    { id: 'date', label: t('sort.date') },
                    { id: 'size', label: t('sort.size') }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => { onSortOptionChange(opt.id as SortOption); }}
                      className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                    >
                      {opt.label}
                      {state.sortBy === opt.id && <Check size={14} className="text-blue-500 group-hover:text-white" />}
                    </button>
                  ))}
                  <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                  <button
                    onClick={onSortDirectionChange}
                    className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                  >
                    {state.sortDirection === 'asc' ? t('sort.asc') : t('sort.desc')}
                    <ArrowDownUp size={14} className={state.sortDirection === 'asc' ? 'transform rotate-180' : ''}/>
                  </button>
                  
                  {activeTab.viewMode !== 'folders-overview' && activeTab.viewMode !== 'lan-folders-overview' && (
                  <>
                  <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                  <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('groupBy.title')}</div>
                  {[
                    { id: 'none', label: t('groupBy.none') },
                    { id: 'type', label: t('groupBy.type') },
                    { id: 'date', label: t('groupBy.date') },
                    { id: 'size', label: t('groupBy.size') }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => onGroupByChange(opt.id as GroupByOption)}
                      className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                    >
                      {opt.label}
                      {groupBy === opt.id && <Check size={14} className="text-blue-500 group-hover:text-white" />}
                    </button>
                  ))}
                  </>
                  )}
                  {onRememberFolderSettings && (
                    <>
                      <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                      <div className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded flex items-center justify-between hover:bg-black/10 dark:hover:bg-white/10 select-none cursor-pointer" onClick={() => onRememberFolderSettings()}>
                        <span className="text-sm text-gray-700 dark:text-gray-200">{t('folderSettings.remember')}</span>
                        <button 
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${hasFolderSettings ? 'bg-blue-500 group-hover:bg-blue-600' : 'bg-gray-300 dark:bg-gray-600 group-hover:bg-gray-400 dark:group-hover:bg-gray-500'}`}
                        >
                            <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition duration-200 ease-in-out ${hasFolderSettings ? 'translate-x-6' : 'translate-x-1'}`} />
                        </button>
                      </div>
                    </>
                  )}
               </div>
             </>
           )}
        </div>
        )}

        {/* View Mode Menu (or topic mode buttons) */}
        {activeTab.viewMode !== 'topics-overview' && activeTab.viewMode !== 'folders-overview' && activeTab.viewMode !== 'lan-folders-overview' && !isCompactMode && (
          <>
          {isAndroid ? (
            <button
              className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-600 dark:text-gray-300 hover:bg-surface focus:outline-none"
              title={t('layout.mode')}
              onClick={() => {
                const cycle: LayoutMode[] = ['grid', 'adaptive', 'masonry'];
                const idx = cycle.indexOf(activeTab.layoutMode);
                onLayoutModeChange(cycle[(idx + 1) % cycle.length]);
              }}
            >
              {activeTab.layoutMode === 'grid' && <Grid size={16} />}
              {activeTab.layoutMode === 'adaptive' && <LayoutGrid size={16} />}
              {activeTab.layoutMode === 'masonry' && <LayoutTemplate size={16} />}
            </button>
          ) : (
          <div className="relative">
             <button 
               onClick={() => setViewMenuOpen(!viewMenuOpen)}
               className={`w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface ${viewMenuOpen ? 'bg-surface text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
               title={t('layout.mode')}
             >
               {activeTab.layoutMode === 'grid' && <Grid size={18} />}
               {activeTab.layoutMode === 'adaptive' && <LayoutGrid size={18} />}
               {activeTab.layoutMode === 'list' && <List size={18} />}
               {activeTab.layoutMode === 'masonry' && <LayoutTemplate size={18} />}
             </button>
             {viewMenuOpen && (
               <>
                 <div className="fixed inset-0 z-40" onClick={() => setViewMenuOpen(false)}></div>
                 <div className="absolute top-full right-0 mt-2 w-48 bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-800 rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] z-50 py-2 animate-zoom-in">
                    <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('layout.mode')}</div>
                    {[
                      { id: 'grid', icon: Grid, label: t('layout.grid') },
                      { id: 'adaptive', icon: LayoutGrid, label: t('layout.adaptive') },
                      { id: 'list', icon: List, label: t('layout.list') },
                      { id: 'masonry', icon: LayoutTemplate, label: t('layout.masonry') }
                    ].map(opt => (
                      <button
                        key={opt.id}
                        onClick={() => { onLayoutModeChange(opt.id as LayoutMode); setViewMenuOpen(false); }}
                        className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                      >
                        <div className="flex items-center">
                          <opt.icon size={16} className="mr-2 opacity-70"/> {opt.label}
                        </div>
                        {activeTab.layoutMode === opt.id && <Check size={14} className="text-blue-500 group-hover:text-white" />}
                      </button>
                    ))}
                    
                    <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                    <div className="px-4 py-2">
                       <div className="flex justify-between text-xs text-gray-500 mb-1">
                          <span>{t('layout.small')}</span>
                          <span>{t('layout.large')}</span>
                       </div>
                       <input 
                         type="range" 
                         id="thumbnail-size-slider"
                         name="thumbnail-size-slider"
                         min={activeTab.viewMode === 'people-overview' ? 140 : 100}
                         max={activeTab.viewMode === 'people-overview' ? 450 : 480}
                         step="20"
                         value={state.thumbnailSize}
                         onChange={(e) => onThumbnailSizeChange(parseInt(e.target.value))}
                         className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                       />
                    </div>
                    {onRememberFolderSettings && (
                      <>
                        <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                        <div className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded flex items-center justify-between hover:bg-black/10 dark:hover:bg-white/10 select-none cursor-pointer" onClick={() => onRememberFolderSettings()}>
                          <span className="text-sm text-gray-700 dark:text-gray-200">{t('folderSettings.remember')}</span>
                          <button 
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${hasFolderSettings ? 'bg-blue-500 group-hover:bg-blue-600' : 'bg-gray-300 dark:bg-gray-600 group-hover:bg-gray-400 dark:group-hover:bg-gray-500'}`}
                          >
                              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition duration-200 ease-in-out ${hasFolderSettings ? 'translate-x-6' : 'translate-x-1'}`} />
                          </button>
                        </div>
                      </>
                    )}
                 </div>
               </>
             )}
          </div>
          )}
          </>
        )}

        {activeTab.viewMode === 'topics-overview' && onTopicLayoutModeChange && !isCompactMode && (
          <div className="flex items-center space-x-2 mr-2">
            <button
              className={`w-9 h-9 flex items-center justify-center rounded-lg ${topicLayoutMode === 'grid' ? 'bg-surface text-blue-500' : 'text-gray-600 dark:text-gray-300 hover:bg-surface'}`}
              title={t('layout.grid')}
              onClick={() => onTopicLayoutModeChange('grid')}
            ><Grid size={16} /></button>
            <button
              className={`w-9 h-9 flex items-center justify-center rounded-lg ${topicLayoutMode === 'adaptive' ? 'bg-surface text-blue-500' : 'text-gray-600 dark:text-gray-300 hover:bg-surface'}`}
              title={t('layout.adaptive')}
              onClick={() => onTopicLayoutModeChange('adaptive')}
            ><LayoutGrid size={16} /></button>
            <button
              className={`w-9 h-9 flex items-center justify-center rounded-lg ${topicLayoutMode === 'masonry' ? 'bg-surface text-blue-500' : 'text-gray-600 dark:text-gray-300 hover:bg-surface'}`}
              title={t('layout.masonry')}
              onClick={() => onTopicLayoutModeChange('masonry')}
            ><LayoutTemplate size={16} /></button>
          </div>
        )}

        {/* Folders overview layout menu */}
        {(activeTab.viewMode === 'folders-overview' || activeTab.viewMode === 'lan-folders-overview') && onFolderLayoutModeChange && !isCompactMode && (
          <>
          {isAndroid ? (
            <button
              className="w-10 h-10 flex items-center justify-center rounded-xl text-gray-600 dark:text-gray-300 hover:bg-surface focus:outline-none"
              title={t('layout.mode')}
              onClick={() => {
                const cycle: LayoutMode[] = ['grid', 'adaptive', 'masonry'];
                const idx = cycle.indexOf(folderLayoutMode || 'grid');
                onFolderLayoutModeChange(cycle[(idx + 1) % cycle.length]);
              }}
            >
              {folderLayoutMode === 'grid' && <Grid size={16} />}
              {folderLayoutMode === 'adaptive' && <LayoutGrid size={16} />}
              {folderLayoutMode === 'masonry' && <LayoutTemplate size={16} />}
            </button>
          ) : (
          <div className="relative">
             <button
               onClick={() => setViewMenuOpen(!viewMenuOpen)}
               className={`w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface ${viewMenuOpen ? 'bg-surface text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
               title={t('layout.mode')}
             >
               {folderLayoutMode === 'grid' && <Grid size={18} />}
               {folderLayoutMode === 'adaptive' && <LayoutGrid size={18} />}
               {folderLayoutMode === 'masonry' && <LayoutTemplate size={18} />}
             </button>
             {viewMenuOpen && (
               <>
                 <div className="fixed inset-0 z-40" onClick={() => setViewMenuOpen(false)}></div>
                 <div className="absolute top-full right-0 mt-2 w-48 bg-[#fafafa]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md border border-gray-200 dark:border-gray-800 rounded-lg shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] z-50 py-2 animate-zoom-in">
                    <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('layout.mode')}</div>
                    {[
                      { id: 'grid', icon: Grid, label: t('layout.grid') },
                      { id: 'adaptive', icon: LayoutGrid, label: t('layout.adaptive') },
                      { id: 'masonry', icon: LayoutTemplate, label: t('layout.masonry') }
                    ].map(opt => (
                      <button
                        key={opt.id}
                        onClick={() => { onFolderLayoutModeChange!(opt.id as LayoutMode); setViewMenuOpen(false); }}
                        className="group mx-2 w-[calc(100%-1rem)] px-4 py-2 rounded text-sm hover:bg-blue-600 hover:text-white flex items-center justify-between text-gray-700 dark:text-gray-200"
                      >
                        <div className="flex items-center">
                          <opt.icon size={16} className="mr-2 opacity-70"/> {opt.label}
                        </div>
                        {folderLayoutMode === opt.id && <Check size={14} className="text-blue-500 group-hover:text-white" />}
                      </button>
                    ))}

                    <div className="border-t border-black/5 dark:border-white/10 my-1"></div>
                    <div className="px-4 py-2">
                       <div className="flex justify-between text-xs text-gray-500 mb-1">
                          <span>{t('layout.small')}</span>
                          <span>{t('layout.large')}</span>
                       </div>
                       <input
                         type="range"
                         id="thumbnail-size-slider"
                         name="thumbnail-size-slider"
                         min={100}
                         max={480}
                         step="20"
                         value={state.thumbnailSize}
                         onChange={(e) => onThumbnailSizeChange(parseInt(e.target.value))}
                         className="w-full h-1.5 bg-gray-200 dark:bg-gray-700 rounded-lg appearance-none cursor-pointer accent-blue-500"
                       />
                    </div>
                 </div>
               </>
             )}
          </div>
          )}
          </>
        )}

        {/* Date Filter (hidden on topics view) */}
        {activeTab.viewMode !== 'topics-overview' && !isCompactMode && (
        <div className="relative">
           <button
             onClick={() => setFilterMenuOpen(!filterMenuOpen)}
             className={`${isAndroid ? 'w-10 h-10 rounded-xl' : 'w-9 h-9 rounded-lg'} flex items-center justify-center hover:bg-surface ${filterMenuOpen || activeTab.dateFilter.start ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
             title={t('date.calendar')}
           >
             <Calendar size={18} />
           </button>
           {filterMenuOpen && (
             isAndroid ? (
               <>
                 <div className="fixed inset-0 z-[200] bg-black/50" onClick={() => setFilterMenuOpen(false)}></div>
                 <div className="fixed bottom-0 left-0 right-0 z-[201] animate-slide-up pb-[env(safe-area-inset-bottom)]">
                   <div className="flex justify-center pt-2 pb-1">
                     <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></div>
                   </div>
                   <CalendarWidget
                        dateFilter={activeTab.dateFilter}
                        onUpdate={onUpdateDateFilter}
                        t={t}
                        isMobile
                    />
                 </div>
               </>
             ) : (
               <>
                 <div className="fixed inset-0 z-40" onClick={() => setFilterMenuOpen(false)}></div>
                 <div className="absolute top-full right-0 mt-2 z-50">
                   <CalendarWidget
                        dateFilter={activeTab.dateFilter}
                        onUpdate={onUpdateDateFilter}
                        t={t}
                    />
                 </div>
               </>
             )
           )}
        </div>
        )}

        {/* All Tags Widget (hidden on topics view) */}
        {activeTab.viewMode !== 'topics-overview' && !isCompactMode && (
        <div className="relative">
           <button
             onClick={() => setTagsMenuOpen(!tagsMenuOpen)}
             className={`${isAndroid ? 'w-10 h-10 rounded-xl' : 'w-9 h-9 rounded-lg'} flex items-center justify-center hover:bg-surface ${tagsMenuOpen ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
             title={t('sidebar.allTags')}
           >
             <Tag size={18} />
           </button>
           {tagsMenuOpen && (
             isAndroid ? (
               <>
                 <div className="fixed inset-0 z-[200] bg-black/50" onClick={() => setTagsMenuOpen(false)}></div>
                 <div className="fixed bottom-0 left-0 right-0 z-[201] animate-slide-up pb-[env(safe-area-inset-bottom)]">
                   <div className="flex justify-center pt-2 pb-1">
                     <div className="w-10 h-1 rounded-full bg-gray-300 dark:bg-gray-600"></div>
                   </div>
                   <TagsWidget
                        groupedTags={groupedTags}
                        onTagClick={(tag, e) => { onTagClick(tag, e); setTagsMenuOpen(false); }}
                        t={t}
                        tagSearchQuery={tagSearchQuery}
                        onSetTagSearchQuery={onSetTagSearchQuery}
                        isMobile
                    />
                 </div>
               </>
             ) : (
               <>
                 <div className="fixed inset-0 z-40" onClick={() => setTagsMenuOpen(false)}></div>
                 <div className="absolute top-full right-0 mt-2 z-50">
                   <TagsWidget
                        groupedTags={groupedTags}
                        onTagClick={(tag, e) => { onTagClick(tag, e); setTagsMenuOpen(false); }}
                        t={t}
                        tagSearchQuery={tagSearchQuery}
                        onSetTagSearchQuery={onSetTagSearchQuery}
                    />
                 </div>
               </>
             )
           )}
        </div>
        )}

        <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>

        {showLanUpload && (
          <button
            onClick={onUploadToLan}
            className="w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface text-blue-500 dark:text-blue-400"
            title={t('lanClient.uploadButton') || '上传图片到桌面'}
          >
            <Upload size={18} />
          </button>
        )}

        <button
          onClick={onToggleMetadata}
          className={`w-9 h-9 flex items-center justify-center rounded-lg hover:bg-surface ${state.layout.isMetadataVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
          title={t('viewer.toggleMeta')}
        >
          <PanelRight size={18} />
        </button>
      </div>
    </div>
  );
};
