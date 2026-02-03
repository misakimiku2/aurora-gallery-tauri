
import { FileNode, FileType, TabState, SortOption, SortDirection, AiSearchFilter } from '../types';

interface SearchWorkerInput {
  allFiles: FileNode[];
  activeTab: TabState;
  sortBy: SortOption;
  sortDirection: SortDirection;
  isAISearchEnabled: boolean;
  topics: any;
}

interface SearchWorkerOutput {
  allMatchingFileIds: string[];
  totalResults: number;
}

self.onmessage = (e: MessageEvent<SearchWorkerInput>) => {
  const { allFiles, activeTab, sortBy, sortDirection, isAISearchEnabled, topics } = e.data;

  let candidates: FileNode[] = [];

  // 1. 基础过滤逻辑
  if (activeTab.aiFilter && (isAISearchEnabled || activeTab.aiFilter.filePaths)) {
    const { keywords, colors, people, description, filePaths } = activeTab.aiFilter;
    const filePathSet = filePaths && filePaths.length > 0 ? new Set(filePaths) : null;

    candidates = allFiles.filter(f => {
      if (f.type !== FileType.IMAGE) return false;
      if (filePathSet) return filePathSet.has(f.path);
      
      if (!keywords.length && !colors.length && !people.length && !description) return false;

      if (keywords.length > 0) {
        const lowerKeywords = keywords.map(k => k.toLowerCase());
        const hasMatch = lowerKeywords.some(lk => 
           f.tags?.some(t => t.toLowerCase().includes(lk)) ||
           f.aiData?.objects?.some(o => o.toLowerCase().includes(lk)) ||
           f.aiData?.tags?.some(t => t.toLowerCase().includes(lk)) ||
           f.description?.toLowerCase().includes(lk) ||
           f.aiData?.description?.toLowerCase().includes(lk)
        );
        if (!hasMatch) return false;
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
  } else if (activeTab.activePersonId) {
     const pId = activeTab.activePersonId;
     candidates = allFiles.filter(f => f.type === FileType.IMAGE && f.aiData?.faces?.some(face => face.personId === pId));
  } else if (activeTab.activeTags.length > 0) {
     const tagSet = new Set(activeTab.activeTags);
     candidates = allFiles.filter(f => f.type !== FileType.FOLDER && f.tags?.some(t => tagSet.has(t)));
  } else if (activeTab.activeTopicId) {
     const topic = topics[activeTab.activeTopicId];
     candidates = topic ? (topic.fileIds || []).map((id: string) => allFiles.find(f => f.id === id)).filter(Boolean) : [];
  } else {
    if (activeTab.searchQuery) {
      candidates = allFiles;
    } else {
      const parentId = activeTab.folderId;
      candidates = allFiles.filter(f => f.parentId === parentId);
    }
  }

  // 2. 关键词通用搜索
  if (activeTab.searchQuery && !activeTab.searchQuery.startsWith('tag:') && !activeTab.aiFilter) {
    const query = activeTab.searchQuery.toLowerCase();
    const parts = query.split(' or ').map(p => p.trim()).filter(p => p);
    candidates = candidates.filter(f => parts.some(p => 
      f.name.toLowerCase().includes(p) ||
      f.tags?.some(t => t.toLowerCase().includes(p)) ||
      f.description?.toLowerCase().includes(p) ||
      f.aiData?.sceneCategory?.toLowerCase().includes(p)
    ));
  }

  // 3. 时间过滤
  if (activeTab.dateFilter.start && activeTab.dateFilter.end) {
    const start = new Date(activeTab.dateFilter.start).getTime();
    const end = new Date(activeTab.dateFilter.end).getTime();
    const min = Math.min(start, end);
    const max = Math.max(start, end) + 86400000;
    candidates = candidates.filter(f => {
      const d = activeTab.dateFilter.mode === 'created' ? f.createdAt : f.updatedAt;
      if (!d) return false;
      const t = new Date(d).getTime();
      return t >= min && t < max;
    });
  }

  // 4. 排序
  const sorted = [...candidates].sort((a, b) => {
    if (a.type !== b.type) return a.type === FileType.FOLDER ? -1 : 1;
    let res = 0;
    if (sortBy === 'date') res = (a.createdAt || '').localeCompare(b.createdAt || '');
    else if (sortBy === 'size') res = (a.meta?.sizeKb || 0) - (b.meta?.sizeKb || 0);
    else res = (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase());
    return res * (sortDirection === 'asc' ? 1 : -1);
  });

  const matchingIds = sorted.map(f => f.id);
  
  self.postMessage({
    allMatchingFileIds: matchingIds,
    totalResults: matchingIds.length
  });
};
