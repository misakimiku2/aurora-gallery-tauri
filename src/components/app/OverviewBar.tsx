import React from 'react';
import { Tag, User, HardDrive, Search, Sparkles } from 'lucide-react';
import { AppState, Person, TabState } from '../../types';

interface OverviewBarProps {
  activeTab: TabState;
  state: AppState;
  t: (key: string) => string;
  setState: React.Dispatch<React.SetStateAction<AppState>>;
  peopleWithDisplayCounts: Record<string, Person>;
  displayFileIds: string[];
}

// 主内容区上方的概览条：标签总览 / 人物总览 / 当前文件夹路径
export const OverviewBar = ({
  activeTab,
  state,
  t,
  setState,
  peopleWithDisplayCounts,
  displayFileIds,
}: OverviewBarProps) => {
  return (
    activeTab.viewMode !== 'topics-overview' && activeTab.viewMode !== 'folders-overview' && state.settings.paths.resourceRoot !== 'android_media_store' && (
      <div className="h-[30px] flex items-center justify-between px-4 text-xs text-gray-500 dark:text-gray-400 bg-content backdrop-blur shrink-0 relative z-20">
        {activeTab.viewMode === 'tags-overview' ? (
          <div className="flex items-center w-full">
            <div className="flex items-center">
              <Tag size={12} className="mr-1" />
              <span className="font-medium">{t('context.allTagsOverview')}</span>
            </div>
            <div className="flex-1 flex justify-end">
              <button
                onClick={() => setState(s => ({ ...s, activeModal: { type: 'auto-generate-tags' } }))}
                className="flex items-center px-3 py-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 hover:bg-purple-100 dark:hover:bg-purple-900/50 rounded-lg transition-colors"
              >
                <Sparkles size={14} className="mr-1.5" />
                {t('tags.autoGenerate') || '自动生成标签'}
              </button>
            </div>
          </div>
        ) : activeTab.viewMode === 'people-overview' ? (
          <div className="flex items-center w-full">
            <div className="flex items-center">
              <User size={12} className="mr-1" />
              <span>{t('context.allPeople')}</span>
            </div>
            <div className="flex-1 flex justify-end items-center gap-3">
              <span className="text-[10px] opacity-60">
                {Object.keys(peopleWithDisplayCounts).length} {t('context.items')}
              </span>
              <button
                onClick={() => setState(s => ({ ...s, activeModal: { type: 'smart-create-person', data: {} } }))}
                className="flex items-center px-3 py-1.5 text-xs font-medium text-purple-600 dark:text-purple-400 bg-purple-50 dark:bg-purple-900/30 hover:bg-purple-100 dark:hover:bg-purple-900/50 rounded-lg transition-colors"
              >
                <Sparkles size={14} className="mr-1.5" />
                {t('context.smartCreatePerson') || '智能生成人物'}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex items-center w-full justify-between">
            <div className="flex items-center space-x-1 overflow-hidden">
              {!(activeTab.searchQuery || activeTab.aiFilter || activeTab.activeTags.length > 0 || activeTab.activePersonId || (activeTab.dateFilter.start && activeTab.dateFilter.end)) ? (
                <>
                  <HardDrive size={12} />
                  <span>/</span>
                  {state.files[activeTab.folderId]?.path || state.files[activeTab.folderId]?.name}
                </>
              ) : (
                <>
                  <Search size={12} className="text-blue-500" />
                  <span className="font-medium text-blue-500">{t('search.scopeAll')}</span>
                </>
              )}
              {activeTab.activeTags.length > 0 && activeTab.searchScope !== 'tag' && <span className="text-blue-600 font-bold ml-2">{t('context.filtered')}</span>}
            </div>
            <div className="text-[10px] opacity-60">
              {displayFileIds.length} {t('context.items')}
            </div>
          </div>
        )}
      </div>
    )
  );
};
