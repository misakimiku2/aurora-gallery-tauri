import React from 'react';
import { Filter, FileText, Tag, Folder, Globe, X, Brain, Calendar, ChevronLeft, ChevronRight } from 'lucide-react';
import { Person, TabState } from '../../types';

interface FilterChipsBarProps {
  activeTab: TabState;
  t: (key: string) => string;
  setToolbarQuery: (q: string) => void;
  onPerformSearch: (query: string) => void;
  updateActiveTab: (updates: Partial<TabState> | ((prev: TabState) => Partial<TabState>)) => void;
  peopleWithDisplayCounts: Record<string, Person>;
  handleClearPersonFilter: () => void;
  handleClearTagFilter: (tag: string) => void;
  totalResults: number;
  pageSize: number;
}

// 当前筛选条件 chips 条 + 分页/计数显示
export const FilterChipsBar = ({
  activeTab,
  t,
  setToolbarQuery,
  onPerformSearch,
  updateActiveTab,
  peopleWithDisplayCounts,
  handleClearPersonFilter,
  handleClearTagFilter,
  totalResults,
  pageSize,
}: FilterChipsBarProps) => {
  return (
    (activeTab.activeTags.length > 0 || activeTab.dateFilter.start || activeTab.activePersonId || activeTab.aiFilter || activeTab.searchQuery || totalResults > pageSize) && (
      <div className="flex items-center px-4 py-2 bg-content space-x-2 overflow-x-auto shrink-0 z-20">
        <div className="flex items-center text-xs text-gray-500 dark:text-gray-400 mr-2 shrink-0">
          <Filter size={12} className="mr-1" />
          {t('context.filters')}
        </div>

        {activeTab.searchQuery && !activeTab.aiFilter && (
          <div className="flex items-center bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs border border-blue-200 dark:border-blue-800 whitespace-nowrap">
            {activeTab.searchScope === 'file' ? <FileText size={10} className="mr-1" /> :
              activeTab.searchScope === 'tag' ? <Tag size={10} className="mr-1" /> :
                activeTab.searchScope === 'folder' ? <Folder size={10} className="mr-1" /> :
                  <Globe size={10} className="mr-1" />}
            <span>{activeTab.searchQuery}</span>
            <button onClick={() => { setToolbarQuery(''); onPerformSearch(''); }} className="ml-1.5 hover:text-red-500 font-bold"><X size={12} /></button>
          </div>
        )}

        {activeTab.aiFilter && (
          activeTab.aiFilter.originalQuery.startsWith('color:') ? (
            <div className="flex items-center bg-surface text-gray-800 dark:text-gray-200 px-2 py-0.5 rounded-full text-xs border border-subtle whitespace-nowrap shadow-sm">
              <div
                className="w-3 h-3 rounded-full border border-gray-300 dark:border-gray-500 mr-1.5 flex-shrink-0 shadow-sm"
                style={{ backgroundColor: activeTab.aiFilter.originalQuery.replace('color:', '').startsWith('#') ? activeTab.aiFilter.originalQuery.replace('color:', '') : '#' + activeTab.aiFilter.originalQuery.replace('color:', '') }}
              />
              <span className="font-mono">{activeTab.aiFilter.originalQuery.replace('color:', '')}</span>
              <button onClick={() => updateActiveTab({ aiFilter: null })} className="ml-1.5 hover:text-red-500 text-gray-400"><X size={12} /></button>
            </div>
          ) : activeTab.aiFilter.originalQuery.startsWith('palette:') ? (
            <div className="flex items-center bg-surface text-gray-800 dark:text-gray-200 px-2 py-0.5 rounded-full text-xs border border-subtle whitespace-nowrap shadow-sm">
              <div className="flex -space-x-1 mr-1.5">
                {activeTab.aiFilter.originalQuery.replace('palette:', '').split(',').map((c, i) => (
                  <div
                    key={i}
                    className="w-3 h-3 rounded-full border border-white dark:border-gray-700 flex-shrink-0 shadow-sm z-10"
                    style={{ backgroundColor: c.startsWith('#') ? c : '#' + c }}
                  />
                ))}
              </div>
              <span className="font-mono text-[10px] text-gray-500 dark:text-gray-400">{t('meta.atmosphere')}</span>
              <button onClick={() => updateActiveTab({ aiFilter: null })} className="ml-1.5 hover:text-red-500 text-gray-400"><X size={12} /></button>
            </div>
          ) : (
            <div className="flex items-center bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 px-2 py-0.5 rounded-full text-xs border border-purple-200 dark:border-purple-800 whitespace-nowrap">
              <Brain size={10} className="mr-1" />
              <span>{t('settings.aiSmartSearch')}: "{activeTab.aiFilter.originalQuery}"</span>
              <button onClick={() => updateActiveTab({ aiFilter: null })} className="ml-1.5 hover:text-red-500"><X size={12} /></button>
            </div>
          )
        )}

        {activeTab.dateFilter.start && (
          <div className="flex items-center bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs border border-blue-200 dark:border-blue-800 whitespace-nowrap">
            <Calendar size={10} className="mr-1" />
            <span>{new Date(activeTab.dateFilter.start).toLocaleDateString()} {activeTab.dateFilter.end ? `- ${new Date(activeTab.dateFilter.end).toLocaleDateString()}` : ''}</span>
            <button onClick={() => updateActiveTab({ dateFilter: { start: null, end: null, mode: 'created' as const } })} className="ml-1.5 hover:text-red-500"><X size={12} /></button>
          </div>
        )}

        {activeTab.activePersonId && peopleWithDisplayCounts[activeTab.activePersonId] && (
          <div className="flex items-center bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-200 px-2 py-0.5 rounded-full text-xs border border-purple-200 dark:border-purple-800 whitespace-nowrap">
            <Brain size={10} className="mr-1" />
            <span>{peopleWithDisplayCounts[activeTab.activePersonId].name}</span>
            <button onClick={() => handleClearPersonFilter()} className="ml-1.5 hover:text-red-500"><X size={12} /></button>
          </div>
        )}

        {activeTab.activeTags.map(tag => (
          <div key={tag} className="flex items-center bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-200 px-2 py-0.5 rounded-full text-xs border border-blue-200 dark:border-blue-800 whitespace-nowrap">
            <span>{tag}</span>
            <button onClick={() => handleClearTagFilter(tag)} className="ml-1.5 hover:text-red-500"><X size={12} /></button>
          </div>
        ))}

        <button onClick={() => {
          setToolbarQuery('');
          updateActiveTab({
            activeTags: [],
            activePersonId: null,
            searchQuery: '',
            dateFilter: { start: null, end: null, mode: 'created' as const },
            aiFilter: null
          });
        }} className="text-xs text-gray-500 hover:text-red-500 underline ml-2 whitespace-nowrap">{t('context.clearAll')}</button>

        {/* Pagination & Count Display */}
        <div className="flex-1" />
        {totalResults > 0 && (
          totalResults > pageSize ? (
            <div className="flex items-center gap-1 ml-4 pr-1 px-1 bg-surface rounded shadow-sm border border-subtle">
              <button
                disabled={(activeTab.currentPage || 1) <= 1}
                onClick={() => updateActiveTab({ currentPage: (activeTab.currentPage || 1) - 1, scrollTop: 0 })}
                className="p-1 hover:bg-surface/70 disabled:opacity-20 rounded transition-colors"
                title={t('search.prevPage')}
              >
                <ChevronLeft size={14} />
              </button>
              <div className="flex items-center text-[11px] font-medium px-2 min-w-[60px] justify-center select-none">
                <span className="text-blue-500 font-bold">{activeTab.currentPage || 1}</span>
                <span className="mx-1 text-gray-400">/</span>
                <span className="text-gray-600 dark:text-gray-400">{Math.ceil(totalResults / pageSize)}</span>
                <span className="ml-1 text-[9px] text-gray-400 font-normal">({totalResults})</span>
              </div>
              <button
                disabled={(activeTab.currentPage || 1) >= Math.ceil(totalResults / pageSize)}
                onClick={() => updateActiveTab({ currentPage: (activeTab.currentPage || 1) + 1, scrollTop: 0 })}
                className="p-1 hover:bg-surface/70 disabled:opacity-20 rounded transition-colors"
                title={t('search.nextPage')}
              >
                <ChevronRight size={14} />
              </button>
            </div>
          ) : (
            (activeTab.searchQuery || activeTab.aiFilter || activeTab.activeTags.length > 0 || activeTab.activePersonId) && (
              <div className="flex items-center text-[11px] font-medium px-2 py-0.5 bg-surface rounded border border-subtle text-gray-500">
                {totalResults} {t('context.items')}
              </div>
            )
          )
        )}
      </div>
    )
  );
};
