
import { FileNode, FileType, TabState, SortOption, SortDirection } from '../types';
import { buildFolderDateKeys, compareInMainPipeline, FileNodeLookup } from '../utils/folderSort';

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
     // Phase 0 注意：列表态 topic.fileIds 为空。此 worker 未被引用（无 new Worker）；
     // 真正的搜索走 useFileSearch.ts（已用 dbGetTopicFiles 懒加载）。
     // 若未来启用此 worker，需调用方在 input 中传入 topic 的 fileIds。
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
  // 与 useFileSearch 保持同构：文件夹按 date 排序 key = 直接子图 MAX(createdAt)
  // （非递归；无日期恒最后）。仅当候选含文件夹时才建 id→node 查表与日期表。
  let folderDateKeys: Map<string, string> | null = null;
  if (sortBy === 'date' && candidates.some(f => f.type === FileType.FOLDER)) {
    const nodeMap = new Map<string, FileNode>(allFiles.map(f => [f.id, f]));
    const lookup: FileNodeLookup = (id) => nodeMap.get(id);
    folderDateKeys = buildFolderDateKeys(candidates, lookup);
  }
  const sorted = [...candidates].sort((a, b) =>
    compareInMainPipeline(a, b, sortBy, sortDirection, folderDateKeys)
  );

  const matchingIds = sorted.map(f => f.id);
  
  self.postMessage({
    allMatchingFileIds: matchingIds,
    totalResults: matchingIds.length
  });
};
