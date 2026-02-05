import React, { useState, useRef, useEffect, useMemo } from 'react';
import { TabState, AppState, SearchScope, LayoutMode, SortOption, DateFilter, GroupByOption } from '../types';
import { debounce } from '../utils/debounce';
import { ColorPickerPopover } from './ColorPickerPopover';
import { 
  Sidebar, ChevronLeft, ChevronRight, ArrowUp, RefreshCw, 
  Search, Palette, Loader2, Sliders, Filter, LayoutGrid, List, Grid, LayoutTemplate, 
  ArrowDownUp, Calendar, PanelRight, X, Tag, 
  FileText, Folder, Globe, ChevronDown, Check, Sun, Moon, Monitor,
  ChevronUp
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
  // --- Pagination ---
  totalResults?: number;
  pageSize?: number;
  onPageChange?: (page: number) => void;
  t: (key: string) => string;
} 

const PaginationControls = ({ current, total, pageSize, onPageChange, t }: { current: number, total: number, pageSize: number, onPageChange: (page: number) => void, t: any }) => {
  const totalPages = Math.ceil(total / pageSize);
  if (totalPages <= 1) return null;

  return (
    <div className="flex items-center gap-1 ml-2 px-2 py-1 bg-gray-100 dark:bg-gray-800 rounded-md border border-gray-200 dark:border-gray-700">
      <button 
        disabled={current <= 1}
        onClick={() => onPageChange(current - 1)}
        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed rounded"
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
        className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed rounded"
        title={t('search.nextPage') || 'Next Page'}
      >
        <ChevronRight size={16} />
      </button>
    </div>
  );
};

const TagsWidget = ({ groupedTags, onTagClick, t, tagSearchQuery, onSetTagSearchQuery }: { groupedTags: Record<string, string[]>, onTagClick: (tag: string, e: React.MouseEvent) => void, t: (key: string) => string, tagSearchQuery: string, onSetTagSearchQuery: (query: string) => void }) => {
  const [localSearchQuery, setLocalSearchQuery] = React.useState(tagSearchQuery);
  const [isFocused, setIsFocused] = React.useState(false);
  
  // 当外部tagSearchQuery变化时，更新本地状?
  React.useEffect(() => {
    setLocalSearchQuery(tagSearchQuery);
  }, [tagSearchQuery]);
  
  // 获取所有标签列表，用于智能联想
  const allTags = React.useMemo(() => {
    const tagsSet = new Set<string>();
    Object.values(groupedTags).forEach(tags => {
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
  const totalTags = Object.values(filteredGroupedTags).reduce((acc, curr) => acc + curr.length, 0);

  return (
    <div className="flex flex-col select-none bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg shadow-2xl overflow-hidden w-80 max-h-[550px] font-sans border border-gray-200 dark:border-gray-800 z-50">
      <div className="px-4 py-3 border-b border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
        <div className="flex items-center justify-between mb-3">
          <span className="font-bold text-sm tracking-wide">{t('sidebar.allTags')}</span>
          <span className="text-xs text-gray-500 dark:text-gray-400 bg-gray-200 dark:bg-gray-700 px-2 py-0.5 rounded-full">
            {totalTags}
          </span>
        </div>
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 transform -translate-y-1/2 text-gray-400" />
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
            className="w-full pl-8 pr-2 py-1.5 rounded-md border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 text-sm text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
          {localSearchQuery && (
            <button
              onClick={() => {
                setLocalSearchQuery('');
                onSetTagSearchQuery('');
              }}
              className="absolute right-2.5 top-1/2 transform -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            >
              <X size={14} />
            </button>
          )}
          
          {/* 智能联想下拉列表 */}
          {suggestedTags.length > 0 && (
            <div className="absolute top-full left-0 right-0 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-800 mt-1 rounded-lg shadow-xl z-50 max-h-40 overflow-y-auto scrollbar-thin scrollbar-thumb-gray-300 dark:scrollbar-thumb-gray-600">
              {suggestedTags.map(tag => (
                <div 
                  key={tag} 
                  className="px-4 py-2 hover:bg-blue-50 dark:hover:bg-blue-900/20 text-sm cursor-pointer text-gray-800 dark:text-gray-200"
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
              <div className="text-xs font-bold text-gray-400 dark:text-gray-500 mb-2 uppercase border-b border-gray-100 dark:border-gray-800 pb-1">{key}</div>
              <div className="flex flex-wrap gap-2">
                {filteredGroupedTags[key].map(tag => (
                  <button
                    key={tag}
                    onClick={(e) => onTagClick(tag, e)}
                    className="text-xs px-2.5 py-1 rounded-md bg-blue-50 dark:bg-blue-900/20 text-blue-600 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/40 border border-blue-100 dark:border-blue-900/30 transition-colors truncate max-w-full text-left"
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
          <div className="w-6 flex flex-col items-center py-2 space-y-1 bg-gray-50 dark:bg-gray-900/50 border-l border-gray-100 dark:border-gray-800 overflow-y-auto no-scrollbar">
            {keys.map(key => (
              <button
                key={key}
                onClick={() => {
                  const element = document.getElementById(`tag-widget-group-${key}`);
                  if (element) {
                    element.scrollIntoView({ behavior: 'smooth', block: 'start' });
                  }
                }}
                className="w-5 h-5 rounded-full flex items-center justify-center text-xs font-medium text-gray-600 dark:text-gray-400 hover:bg-blue-100 dark:hover:bg-blue-900/30 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
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
  t
}: { 
  dateFilter: DateFilter, 
  onUpdate: (f: DateFilter) => void,
  t: (key: string) => string
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
      <div className="flex flex-col select-none bg-white dark:bg-gray-800 text-gray-900 dark:text-white rounded-lg shadow-2xl overflow-hidden w-80 font-sans border border-gray-200 dark:border-gray-800 z-50">
          {/* Controls Header */}
          <div className="flex items-center justify-between px-4 py-4 bg-gray-50 dark:bg-gray-900/50 border-b border-gray-200 dark:border-gray-800">
              <div className="font-bold text-base tracking-wide pl-1 text-gray-800 dark:text-gray-100">
                  {year}年{month + 1}月
              </div>
              <div className="flex space-x-1">
                  <button onClick={handlePrevMonth} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                      <ChevronUp size={16} />
                  </button>
                  <button onClick={handleNextMonth} className="p-1 hover:bg-gray-200 dark:hover:bg-gray-700 rounded-full text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors">
                      <ChevronDown size={16} />
                  </button>
              </div>
          </div>

          {/* Grid */}
          <div className="px-4 py-4">
              <div className="grid grid-cols-7 mb-2">
                  {weekDays.map(d => (
                      <div key={d} className="text-center text-xs text-gray-400 dark:text-gray-500 font-bold py-1">
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
                      else if (status === 'in-range') bgClass = 'bg-blue-50 dark:bg-blue-900/20 text-gray-300 dark:text-gray-600';
                      
                      return (
                          <div key={`prev-${day}`} 
                               onClick={() => handleDateClick(day, 'prev')}
                               className={`h-8 w-8 mx-auto flex items-center justify-center text-xs font-medium relative transition-colors ${status !== 'in-range' ? 'rounded-full' : ''} ${bgClass}`}
                          >
                              {day}
                          </div>
                      );
                  })}

                  {/* Current Month Days */}
                  {Array.from({ length: daysInMonth }).map((_, i) => {
                      const day = i + 1;
                      const status = getDayStatus(day, 'current');
                      
                      let containerClass = "h-8 w-full flex items-center justify-center relative";
                      let btnClass = "h-8 w-8 flex items-center justify-center text-xs font-medium transition-all cursor-pointer rounded-full";
                      
                      if (status === 'selected') {
                          btnClass += ' bg-blue-500 text-white shadow-lg shadow-blue-500/30';
                      } else if (status === 'in-range') {
                          containerClass += ' bg-blue-50 dark:bg-blue-900/20'; // Continuous background
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
                              containerClass = "h-8 w-full flex items-center justify-center relative bg-gradient-to-r from-transparent from-50% to-blue-50 to-50% dark:to-blue-900/20";
                          }
                          if (currentTs === endTs && currentTs !== startTs) {
                              // End of range - fill left half
                              containerClass = "h-8 w-full flex items-center justify-center relative bg-gradient-to-l from-transparent from-50% to-blue-50 to-50% dark:to-blue-900/20";
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
                      else if (status === 'in-range') bgClass = 'bg-blue-50 dark:bg-blue-900/20 text-gray-300 dark:text-gray-600';

                      return (
                          <div key={`next-${day}`} 
                               onClick={() => handleDateClick(day, 'next')}
                               className={`h-8 w-8 mx-auto flex items-center justify-center text-xs font-medium relative transition-colors ${status !== 'in-range' ? 'rounded-full' : ''} ${bgClass}`}
                          >
                              {day}
                          </div>
                      );
                  })}
              </div>
          </div>

          {/* Mode Switcher */}
          <div className="p-4 border-t border-gray-200 dark:border-gray-800 bg-gray-50 dark:bg-gray-900/50">
              <div className="text-xs text-gray-500 dark:text-gray-400 mb-2 font-bold">{t('date.filterBy')}</div>
              <div className="flex gap-2">
                  <button
                      onClick={() => onUpdate({ ...dateFilter, mode: 'created' })}
                      className={`flex-1 py-1.5 px-2 text-xs font-medium rounded transition-all border ${
                          dateFilter.mode === 'created' 
                          ? 'bg-blue-500 border-blue-500 text-white shadow-sm' 
                          : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300'
                      }`}
                  >
                      {t('date.createdDate')}
                  </button>
                  <button
                      onClick={() => onUpdate({ ...dateFilter, mode: 'updated' })}
                      className={`flex-1 py-1.5 px-2 text-xs font-medium rounded transition-all border ${
                          dateFilter.mode === 'updated' 
                          ? 'bg-blue-500 border-blue-500 text-white shadow-sm' 
                          : 'bg-white dark:bg-gray-800 border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-gray-400 dark:hover:border-gray-500 hover:text-gray-800 dark:hover:text-gray-300'
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
  t
}) => {
  const [scopeMenuOpen, setScopeMenuOpen] = useState(false);
  const [viewMenuOpen, setViewMenuOpen] = useState(false);
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [filterMenuOpen, setFilterMenuOpen] = useState(false);
  const [tagsMenuOpen, setTagsMenuOpen] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  
  // Color Picker State
  const [isColorPickerOpen, setIsColorPickerOpen] = useState(false);
  const [isColorSearching, setIsColorSearching] = useState(false);
  const colorPickerContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isColorPickerOpen) return;
    
    const handleClickOutside = (event: MouseEvent) => {
      if (colorPickerContainerRef.current && !colorPickerContainerRef.current.contains(event.target as Node)) {
        setIsColorPickerOpen(false);
      }
    };
    
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isColorPickerOpen]);

  const isColorSearchQuery = useMemo(() => toolbarQuery.startsWith('color:'), [toolbarQuery]);
  const currentSearchColor = useMemo(() => isColorSearchQuery ? toolbarQuery.replace('color:', '') : '', [isColorSearchQuery, toolbarQuery]);

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
    <div className="h-14 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-800 flex items-center px-4 justify-between shrink-0 z-30 space-x-4">
      {/* Left: Navigation */}
      <div className="flex items-center space-x-2 min-w-fit">
        <button onClick={onToggleSidebar} className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${state.layout.isSidebarVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`} title={t('viewer.toggleSidebar')}>
          <Sidebar size={18} />
        </button>
        <div className="flex space-x-1">
          <button onClick={onGoBack} disabled={activeTab.history.currentIndex <= 0} className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-600 dark:text-gray-300">
            <ChevronLeft size={18} />
          </button>
          <button onClick={onGoForward} disabled={activeTab.history.currentIndex >= activeTab.history.stack.length - 1} className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-600 dark:text-gray-300">
            <ChevronRight size={18} />
          </button>
          <button onClick={onNavigateUp} className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300" title={t('viewer.up')}>
            <ArrowUp size={18} />
          </button>
        </div>
        <button onClick={() => onRefresh()} className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300" title={t('context.refresh')}>
          <RefreshCw size={16} />
        </button>
      </div>

      {/* Center: Search */}
      <div className="flex-1 max-w-2xl relative">
        <div className={`flex items-center bg-gray-100 dark:bg-gray-800 rounded-full px-3 py-1.5 transition-all border ${
          isColorSearchQuery
            ? 'border-blue-500 shadow-sm'
            : isAISearchEnabled 
              ? 'border-purple-500 shadow-sm shadow-purple-500/20' 
              : activeTab.searchQuery 
                ? 'border-blue-500 shadow-sm' 
                : 'border-transparent'
        }`}>
          
          {activeTab.viewMode !== 'people-overview' && activeTab.viewMode !== 'tags-overview' && (
            <div className="relative flex-shrink-0">
              <button 
                onClick={() => setScopeMenuOpen(!scopeMenuOpen)}
                className="flex items-center text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 mr-2 pr-2 border-r border-gray-300 dark:border-gray-800 whitespace-nowrap"
              >
                {getScopeIcon(activeTab.searchScope)}
                <ChevronDown size={12} className="ml-1 opacity-70"/>
              </button>
              {scopeMenuOpen && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setScopeMenuOpen(false)}></div>
                  <div className="absolute top-full left-0 mt-2 w-40 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl z-50 py-1 overflow-hidden animate-fade-in">
                    {[
                      { id: 'all', icon: Globe, label: t('search.scopeAll') },
                      { id: 'file', icon: FileText, label: t('search.scopeFile') },
                      { id: 'tag', icon: Tag, label: t('search.scopeTag') },
                      { id: 'folder', icon: Folder, label: t('search.scopeFolder') }
                    ].map((opt) => (
                      <button
                        key={opt.id}
                        onClick={() => { onSearchScopeChange(opt.id as SearchScope); setScopeMenuOpen(false); }}
                        className={`w-full text-left px-3 py-2 text-xs flex items-center hover:bg-blue-50 dark:hover:bg-blue-900/20 ${activeTab.searchScope === opt.id ? 'text-blue-600 dark:text-blue-400 font-bold' : 'text-gray-700 dark:text-gray-300'}`}
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
             {isColorSearching ? (
                <Loader2 size={16} className="mr-2 flex-shrink-0 text-blue-500 animate-spin" />
             ) : (
                <button
                  onClick={() => setIsColorPickerOpen(!isColorPickerOpen)}
                  className={`mr-2 flex-shrink-0 cursor-pointer hover:text-blue-500 transition-colors ${isAISearchEnabled ? 'text-purple-500' : 'text-gray-400'} flex items-center`}
                  title="Search by color"
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
          </div>
          
          {isColorSearchQuery && (
            <div 
                className="w-4 h-4 rounded-full border border-gray-300 dark:border-gray-700 mr-2 flex-shrink-0 shadow-sm"
                style={{ backgroundColor: currentSearchColor }}
            />
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
                  : isAISearchEnabled 
                    ? t('settings.aiSmartSearch') 
                    : t('search.placeholder')
            }
            value={
              activeTab.viewMode === 'people-overview' ? (personSearchQuery || '') :
              activeTab.viewMode === 'tags-overview' ? tagSearchQuery : toolbarQuery
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
          />

          <div className="flex items-center space-x-1 ml-2 flex-shrink-0">
             {toolbarQuery && (
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
                  className="p-1 rounded-full hover:bg-gray-200 dark:hover:bg-gray-700 text-gray-400 flex-shrink-0"
                >
                  <X size={14} />
                </button>
             )}
              {/* AI 搜索模式切换按钮已移除（保留 props 与逻辑）*/}
          </div>
        </div>
      </div>

      {/* Right: Tools & Settings */}
      <div className="flex items-center space-x-2 min-w-fit">
        
        {/* Sort & Group Menu (hidden on topics view) */}
        {activeTab.viewMode !== 'topics-overview' && (
        <div className="relative">
           <button 
             onClick={() => setSortMenuOpen(!sortMenuOpen)}
             className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${sortMenuOpen ? 'bg-gray-100 dark:bg-gray-800 text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
             title={t('sort.sortBy')}
           >
             <ArrowDownUp size={18} />
           </button>
           {sortMenuOpen && (
             <>
               <div className="fixed inset-0 z-40" onClick={() => setSortMenuOpen(false)}></div>
               <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl z-50 py-2 animate-zoom-in">
                  <div className="px-3 py-1 text-xs font-bold text-gray-400 uppercase tracking-wider">{t('sort.sortBy')}</div>
                  {[
                    { id: 'name', label: t('sort.name') },
                    { id: 'date', label: t('sort.date') },
                    { id: 'size', label: t('sort.size') }
                  ].map(opt => (
                    <button
                      key={opt.id}
                      onClick={() => { onSortOptionChange(opt.id as SortOption); }}
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
                    >
                      {opt.label}
                      {state.sortBy === opt.id && <Check size={14} className="text-blue-500" />}
                    </button>
                  ))}
                  <div className="border-t border-gray-100 dark:border-gray-800 my-1"></div>
                  <button
                    onClick={onSortDirectionChange}
                    className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
                  >
                    {state.sortDirection === 'asc' ? t('sort.asc') : t('sort.desc')}
                    <ArrowDownUp size={14} className={state.sortDirection === 'asc' ? 'transform rotate-180' : ''}/>
                  </button>
                  
                  <div className="border-t border-gray-100 dark:border-gray-800 my-1"></div>
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
                      className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
                    >
                      {opt.label}
                      {groupBy === opt.id && <Check size={14} className="text-blue-500" />}
                    </button>
                  ))}
                  {onRememberFolderSettings && (
                    <>
                      <div className="border-t border-gray-100 dark:border-gray-800 my-1"></div>
                      <div className="w-full px-4 py-2 flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-700 select-none cursor-pointer" onClick={() => onRememberFolderSettings()}>
                        <span className="text-sm text-gray-700 dark:text-gray-200">{t('folderSettings.remember')}</span>
                        <button 
                            className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${hasFolderSettings ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
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
        {activeTab.viewMode !== 'topics-overview' && (
          <div className="relative">
             <button 
               onClick={() => setViewMenuOpen(!viewMenuOpen)}
               className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${viewMenuOpen ? 'bg-gray-100 dark:bg-gray-800 text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
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
                 <div className="absolute top-full right-0 mt-2 w-48 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-800 rounded-lg shadow-xl z-50 py-2 animate-zoom-in">
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
                        className="w-full text-left px-4 py-2 text-sm hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-between text-gray-700 dark:text-gray-200"
                      >
                        <div className="flex items-center">
                          <opt.icon size={16} className="mr-2 opacity-70"/> {opt.label}
                        </div>
                        {activeTab.layoutMode === opt.id && <Check size={14} className="text-blue-500" />}
                      </button>
                    ))}
                    
                    <div className="border-t border-gray-100 dark:border-gray-800 my-1"></div>
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
                        <div className="border-t border-gray-100 dark:border-gray-800 my-1"></div>
                        <div className="w-full px-4 py-2 flex items-center justify-between hover:bg-gray-100 dark:hover:bg-gray-700 select-none cursor-pointer" onClick={() => onRememberFolderSettings()}>
                          <span className="text-sm text-gray-700 dark:text-gray-200">{t('folderSettings.remember')}</span>
                          <button 
                              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${hasFolderSettings ? 'bg-blue-500' : 'bg-gray-300 dark:bg-gray-600'}`}
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

        {activeTab.viewMode === 'topics-overview' && onTopicLayoutModeChange && (
          <div className="flex items-center space-x-2 mr-2">
            <button
              className={`p-2 rounded ${topicLayoutMode === 'grid' ? 'bg-white dark:bg-gray-800 text-blue-500' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100'}`}
              title={t('layout.grid')}
              onClick={() => onTopicLayoutModeChange('grid')}
            ><Grid size={16} /></button>
            <button
              className={`p-2 rounded ${topicLayoutMode === 'adaptive' ? 'bg-white dark:bg-gray-800 text-blue-500' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100'}`}
              title={t('layout.adaptive')}
              onClick={() => onTopicLayoutModeChange('adaptive')}
            ><LayoutGrid size={16} /></button>
            <button
              className={`p-2 rounded ${topicLayoutMode === 'masonry' ? 'bg-white dark:bg-gray-800 text-blue-500' : 'text-gray-600 dark:text-gray-300 hover:bg-gray-100'}`}
              title={t('layout.masonry')}
              onClick={() => onTopicLayoutModeChange('masonry')}
            ><LayoutTemplate size={16} /></button>
          </div>
        )}

        {/* Date Filter (hidden on topics view) */}
        {activeTab.viewMode !== 'topics-overview' && (
        <div className="relative">
           <button 
             onClick={() => setFilterMenuOpen(!filterMenuOpen)}
             className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${filterMenuOpen || activeTab.dateFilter.start ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
             title={t('date.calendar')}
           >
             <Calendar size={18} />
           </button>
           {filterMenuOpen && (
             <>
               <div className="fixed inset-0 z-40" onClick={() => setFilterMenuOpen(false)}></div>
               <div className="absolute top-full right-0 mt-2 z-50 animate-zoom-in">
                  <CalendarWidget 
                      dateFilter={activeTab.dateFilter} 
                      onUpdate={onUpdateDateFilter}
                      t={t}
                  />
               </div>
             </>
           )}
        </div>
        )}

        {/* All Tags Widget (hidden on topics view) */}
        {activeTab.viewMode !== 'topics-overview' && (
        <div className="relative">
           <button 
             onClick={() => setTagsMenuOpen(!tagsMenuOpen)}
             className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${tagsMenuOpen ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
             title={t('sidebar.allTags')}
           >
             <Tag size={18} />
           </button>
           {tagsMenuOpen && (
             <>
               <div className="fixed inset-0 z-40" onClick={() => setTagsMenuOpen(false)}></div>
               <div className="absolute top-full right-0 mt-2 z-50 animate-zoom-in">
                  <TagsWidget 
                      groupedTags={groupedTags} 
                      onTagClick={(tag, e) => { onTagClick(tag, e); setTagsMenuOpen(false); }}
                      t={t}
                      tagSearchQuery={tagSearchQuery}
                      onSetTagSearchQuery={onSetTagSearchQuery}
                  />
               </div>
             </>
           )}
        </div>
        )}

        <div className="h-6 w-px bg-gray-300 dark:bg-gray-700 mx-1"></div>

        <button 
          onClick={onToggleMetadata}
          className={`p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 ${state.layout.isMetadataVisible ? 'text-blue-500' : 'text-gray-600 dark:text-gray-300'}`}
          title={t('viewer.toggleMeta')}
        >
          <PanelRight size={18} />
        </button>
      </div>
    </div>
  );
};
