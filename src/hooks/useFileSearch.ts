import { useMemo, useState } from 'react';
import { FileNode, FileType, TabState, SearchScope, FileGroup, AppState } from '../types';

interface UseFileSearchProps {
  state: AppState;
  activeTab: TabState;
  groupBy: 'none' | 'type' | 'date' | 'size';
  t: (key: string) => string;
}

export const useFileSearch = ({ state, activeTab, groupBy, t }: UseFileSearchProps) => {
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});

  // 1. 缓存文件数组，避免重复执行 Object.values
  const allFiles = useMemo(() => Object.values(state.files) as FileNode[], [state.files]);

  // 2. 隔离搜索参数：只有这些参数变化才需要重新“检索”
  // 排除掉 scrollTop 等与检索无关的干扰项
  const searchCriteria = useMemo(() => ({
    query: activeTab.searchQuery,
    scope: activeTab.searchScope,
    aiFilter: activeTab.aiFilter,
    activeTags: activeTab.activeTags,
    activePersonId: activeTab.activePersonId,
    activeTopicId: activeTab.activeTopicId,
    dateFilter: activeTab.dateFilter,
    folderId: activeTab.folderId,
    sortBy: state.sortBy,
    sortDirection: state.sortDirection
  }), [
    activeTab.searchQuery, activeTab.searchScope, activeTab.aiFilter, 
    activeTab.activeTags, activeTab.activePersonId, activeTab.activeTopicId,
    activeTab.dateFilter, activeTab.folderId, state.sortBy, state.sortDirection
  ]);

  // 3. 核心检索逻辑：在主线程运行（68K 数据耗时约 10-20ms，远快于 Worker 通信开销）
  const allMatchingFileIds = useMemo(() => {
    let candidates: FileNode[] = [];

    // --- 筛选逻辑开始 ---
    if (searchCriteria.aiFilter && (state.settings.search.isAISearchEnabled || searchCriteria.aiFilter.filePaths)) {
      const { keywords, colors, people, description, filePaths } = searchCriteria.aiFilter;
      const filePathSet = filePaths && filePaths.length > 0 ? new Set(filePaths) : null;

      candidates = allFiles.filter(f => {
        if (f.type !== FileType.IMAGE) return false;
        if (filePathSet) return filePathSet.has(f.path);
        if (!keywords.length && !colors.length && !people.length && !description) return false;

        if (keywords.length > 0) {
          const lowerKeywords = keywords.map(k => k.toLowerCase());
          if (!lowerKeywords.some(lk => 
            f.tags?.some(t => t.toLowerCase().includes(lk)) ||
            f.aiData?.objects?.some(o => o.toLowerCase().includes(lk)) ||
            f.aiData?.tags?.some(t => t.toLowerCase().includes(lk)) ||
            f.description?.toLowerCase().includes(lk) ||
            f.aiData?.description?.toLowerCase().includes(lk)
          )) return false;
        }

        if (colors.length > 0) {
          const colorSet = new Set(colors.map(c => c.toLowerCase()));
          if (!f.meta?.palette?.some(p => colorSet.has(p.toLowerCase())) &&
              !f.aiData?.dominantColors?.some(p => colorSet.has(p.toLowerCase()))) return false;
        }

        if (people.length > 0) {
          const peopleSet = new Set(people.map(p => p.toLowerCase()));
          if (!f.aiData?.faces?.some(face => face.name && peopleSet.has(face.name.toLowerCase()))) return false;
        }

        if (description) {
          const ld = description.toLowerCase();
          if (!f.description?.toLowerCase().includes(ld) && !f.aiData?.description?.toLowerCase().includes(ld)) return false;
        }
        return true;
      });
    } else if (searchCriteria.activePersonId) {
      candidates = allFiles.filter(f => f.type === FileType.IMAGE && f.aiData?.faces?.some(face => face.personId === searchCriteria.activePersonId));
    } else if (searchCriteria.activeTags.length > 0) {
      const tagSet = new Set(searchCriteria.activeTags);
      candidates = allFiles.filter(f => f.type !== FileType.FOLDER && f.tags?.some(tag => tagSet.has(tag)));
    } else if (searchCriteria.activeTopicId) {
      const topic = state.topics[searchCriteria.activeTopicId];
      candidates = topic ? (topic.fileIds || []).map(id => state.files[id]).filter(Boolean) : [];
    } else {
      if (!state.files[activeTab.folderId] && !searchCriteria.query) return [];
      if (searchCriteria.query) {
        candidates = allFiles;
      } else {
        const folder = state.files[activeTab.folderId];
        candidates = (folder?.children || []).map(id => state.files[id]).filter(Boolean);
      }
    }

    // 关键词搜索
    if (searchCriteria.query && !searchCriteria.query.startsWith('tag:') && !searchCriteria.aiFilter) {
      const q = searchCriteria.query.toLowerCase();
      const scope = searchCriteria.scope || 'all';

      candidates = candidates.filter(f => {
        // According to scope, filter by type or content
        if (scope === 'file') {
          return f.type !== FileType.FOLDER && f.name.toLowerCase().includes(q);
        }
        if (scope === 'folder') {
          return f.type === FileType.FOLDER && f.name.toLowerCase().includes(q);
        }
        if (scope === 'tag') {
          return f.tags?.some(t => t.toLowerCase().includes(q));
        }
        
        // default: 'all'
        return f.name.toLowerCase().includes(q) || 
               f.tags?.some(t => t.toLowerCase().includes(q)) ||
               f.description?.toLowerCase().includes(q);
      });
    }

    // 时间过滤
    if (searchCriteria.dateFilter.start && searchCriteria.dateFilter.end) {
      const start = new Date(searchCriteria.dateFilter.start).getTime();
      const end = new Date(searchCriteria.dateFilter.end).getTime();
      const min = Math.min(start, end);
      const max = Math.max(start, end) + 86400000;
      candidates = candidates.filter(f => {
        const dStr = searchCriteria.dateFilter.mode === 'created' ? f.createdAt : f.updatedAt;
        if (!dStr) return false;
        const t = new Date(dStr).getTime();
        return t >= min && t < max;
      });
    }

    // 排序
    return [...candidates].sort((a, b) => {
      if (a.type !== b.type) return a.type === FileType.FOLDER ? -1 : 1;
      let res = 0;
      if (searchCriteria.sortBy === 'date') res = (a.createdAt || '').localeCompare(b.createdAt || '');
      else if (searchCriteria.sortBy === 'size') res = (a.meta?.sizeKb || 0) - (b.meta?.sizeKb || 0);
      else res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
      return res * (searchCriteria.sortDirection === 'asc' ? 1 : -1);
    }).map(f => f.id);
  }, [allFiles, searchCriteria, state.files, state.topics]);

  // 4. 分页切片逻辑
  const pageSize = 1000;
  const currentPage = activeTab.currentPage || 1;
  const totalResults = allMatchingFileIds.length;
  
  const displayFileIds = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return allMatchingFileIds.slice(start, start + pageSize);
  }, [allMatchingFileIds, currentPage]);

  const toggleGroup = (groupId: string) => {
    setCollapsedGroups(prev => ({ ...prev, [groupId]: !prev[groupId] }));
  };

  const groupedFiles = useMemo<FileGroup[]>(() => {
    if (groupBy === 'none') return [];
    const groups: Record<string, string[]> = {};
    displayFileIds.forEach(id => {
      const file = state.files[id];
      if (!file) return;
      let key = 'Other';
      if (groupBy === 'type') key = file.type === FileType.FOLDER ? t('groupBy.folder') : (file.meta?.format?.toUpperCase() || 'Unknown');
      else if (groupBy === 'date') key = file.createdAt ? file.createdAt.substring(0, 7) : 'Unknown';
      if (!groups[key]) groups[key] = [];
      groups[key].push(id);
    });
    return Object.entries(groups).map(([title, ids]) => ({ id: title, title, fileIds: ids }));
  }, [displayFileIds, groupBy, state.files, t]);

  return {
    displayFileIds,
    totalResults,
    pageSize,
    isSearching: false, // 恢复由于逻辑极快，无需显示 Searching
    groupedFiles,
    collapsedGroups,
    toggleGroup,
    allFiles
  };
};
