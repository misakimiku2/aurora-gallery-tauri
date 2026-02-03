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

  // Cache all files array to avoid repeated Object.values() calls
  const allFiles = useMemo(() => Object.values(state.files) as FileNode[], [state.files]);

  // Memoized sort function with stable dependencies
  const sortFiles = useMemo(() => {
    return (files: FileNode[]) => {
      return [...files].sort((a, b) => { // Use spread to avoid mutating original
        if (a.type !== b.type) return a.type === FileType.FOLDER ? -1 : 1;
        
        let res: number = 0;
        if (state.sortBy === 'date') {
          const valA = a.createdAt || '';
          const valB = b.createdAt || '';
          res = valA.localeCompare(valB);
        } else if (state.sortBy === 'size') {
          const sizeA: number = a.meta?.sizeKb || 0;
          const sizeB: number = b.meta?.sizeKb || 0;
          res = sizeA - sizeB;
        } else {
          const valA = (a.name || '').toLowerCase();
          const valB = (b.name || '').toLowerCase();
          res = valA.localeCompare(valB);
        }
        
        if (res === 0) return 0;
        const modifier = state.sortDirection === 'asc' ? 1 : -1;
        return res * modifier;
      });
    };
  }, [state.sortBy, state.sortDirection]);

  // Optimized filtered children calculation
  const displayFileIds = useMemo(() => {
    let candidates: FileNode[] = [];

    // AI Search Filter Logic - Optimized with early exits and Set lookups
    if (activeTab.aiFilter && (state.settings.search.isAISearchEnabled || activeTab.aiFilter.filePaths)) {
      const { keywords, colors, people, description, filePaths } = activeTab.aiFilter;

      // Use a Set for fast file path matching
      const filePathSet = filePaths && filePaths.length > 0 ? new Set(filePaths) : null;

      candidates = allFiles.filter(f => {
        if (f.type !== FileType.IMAGE) return false;

        // Exact file path match (e.g. from color search) - O(1) with Set
        if (filePathSet) {
          return filePathSet.has(f.path);
        }

        // Early return if no criteria match
        if (!keywords.length && !colors.length && !people.length && !description) {
          return false;
        }

        // Check Keywords (Tags, Objects, Description) - Optimized with early exits
        if (keywords.length > 0) {
          const lowerKeywords = keywords.map(k => k.toLowerCase());
          const hasKeywordMatch = lowerKeywords.some(lowerK => {
            if (f.tags?.some(t => t.toLowerCase().includes(lowerK))) return true;
            if (f.aiData?.objects?.some(o => o.toLowerCase().includes(lowerK))) return true;
            if (f.aiData?.tags?.some(t => t.toLowerCase().includes(lowerK))) return true;
            if (f.description?.toLowerCase().includes(lowerK)) return true;
            if (f.aiData?.description?.toLowerCase().includes(lowerK)) return true;
            return false;
          });
          if (!hasKeywordMatch) return false;
        }

        // Check Colors - Optimized with Set for O(1) lookups
        if (colors.length > 0) {
          const colorSet = new Set(colors.map(c => c.toLowerCase()));
          const hasColorMatch =
            (f.meta?.palette?.some(p => colorSet.has(p.toLowerCase()))) ||
            (f.aiData?.dominantColors?.some(p => colorSet.has(p.toLowerCase())));
          if (!hasColorMatch) return false;
        }

        // Check People - Optimized with Set for O(1) lookups
        if (people.length > 0) {
          const peopleSet = new Set(people.map(p => p.toLowerCase()));
          const hasPeopleMatch = f.aiData?.faces?.some(face =>
            face.name && peopleSet.has(face.name.toLowerCase())
          );
          if (!hasPeopleMatch) return false;
        }

        // Check specific description intent - Early exit if no match
        if (description) {
          const lowerDesc = description.toLowerCase();
          const descMatch =
            (f.description?.toLowerCase().includes(lowerDesc)) ||
            (f.aiData?.description?.toLowerCase().includes(lowerDesc));
          if (!descMatch) return false;
        }

        return true;
      });

    } else if (activeTab.activePersonId) {
      // Optimized active person filter - use direct lookup
      const personId = activeTab.activePersonId;
      candidates = allFiles.filter(f =>
        f.type === FileType.IMAGE &&
        f.aiData?.faces &&
        f.aiData.faces.some(face => face.personId === personId)
      );
    }
    else if (activeTab.activeTags.length > 0) {
      // Optimized tag filter - use Set for faster lookups
      const activeTagsSet = new Set(activeTab.activeTags);
      candidates = allFiles.filter(f =>
        f.type !== FileType.FOLDER &&
        f.tags?.some(tag => activeTagsSet.has(tag))
      );
    }
    else if (activeTab.searchScope === 'tag' && (activeTab.searchQuery || '').startsWith('tag:')) {
      const tagName = (activeTab.searchQuery || '').replace('tag:', '');
      candidates = allFiles.filter((f) => f.tags?.includes(tagName));
    }
    else if (activeTab.activeTopicId) {
      // Topic View Filter
      const topicId = activeTab.activeTopicId;
      const topic = state.topics[topicId];

      if (topic) {
        // Get all images from this topic (only current topic, preserve order)
        candidates = (topic.fileIds || [])
          .map(id => state.files[id])
          .filter(f => f && f.type === FileType.IMAGE);
      } else {
        candidates = [];
      }
    }
    else {
      if (!state.files[activeTab.folderId]) {
        if (activeTab.searchQuery && activeTab.searchScope !== 'all') { /* continue */ } else { return []; }
      }

      if (activeTab.searchQuery) {
        candidates = allFiles;
      } else {
        const folder = state.files[activeTab.folderId];
        candidates = folder?.children?.map(id => state.files[id]).filter(Boolean) as FileNode[] || [];
      }
    }

    // Standard Search Logic (if AI Search is NOT active or falls back) - Optimized with early exits
    if (activeTab.searchQuery && !(activeTab.searchQuery || '').startsWith('tag:') && !activeTab.aiFilter) {
      const query = activeTab.searchQuery.toLowerCase();
      const queryParts = query.split(' or ').map(p => p.trim()).filter(p => p);

      // Optimized search with early exits
      candidates = candidates.filter(f => {
        // Check if file matches any search part
        return queryParts.some(part => {
          const lowerPart = part.toLowerCase();

          // Check name first (most common case)
          if (f.name.toLowerCase().includes(lowerPart)) return true;

          // Check tags
          if (f.tags?.some(t => t.toLowerCase().includes(lowerPart))) return true;

          // Check description if available
          if (f.description?.toLowerCase().includes(lowerPart)) return true;

          // Check source URL if available
          if (f.sourceUrl?.toLowerCase().includes(lowerPart)) return true;

          // Check AI data if available
          if (f.aiData) {
            if (f.aiData.sceneCategory?.toLowerCase().includes(lowerPart)) return true;
            if (f.aiData.objects?.some(obj => obj.toLowerCase().includes(lowerPart))) return true;
            if (f.aiData.extractedText?.toLowerCase().includes(lowerPart)) return true;
            if (f.aiData.translatedText?.toLowerCase().includes(lowerPart)) return true;
          }

          // Check search scope
          if (activeTab.searchScope === 'file') return f.type !== FileType.FOLDER;
          if (activeTab.searchScope === 'folder') return f.type === FileType.FOLDER;

          return false;
        });
      });
    }

    // Date filter optimization
    if (activeTab.dateFilter.start && activeTab.dateFilter.end) {
      const start = new Date(activeTab.dateFilter.start).getTime();
      const end = new Date(activeTab.dateFilter.end).getTime();
      const minTime = Math.min(start, end);
      const maxTime = Math.max(start, end) + 86400000;
      const mode = activeTab.dateFilter.mode;

      candidates = candidates.filter(f => {
        const dateStr = mode === 'created' ? f.createdAt : f.updatedAt;
        if (!dateStr) return false;
        const time = new Date(dateStr).getTime();
        return time >= minTime && time < maxTime;
      });
    }

    // Sort and return IDs
    if (activeTab.activeTopicId) {
      return candidates.map(f => f.id);
    }
    return sortFiles(candidates).map(f => f.id);
  }, [allFiles, activeTab, state.sortBy, state.sortDirection, state.settings.search.isAISearchEnabled, state.files, state.topics]);

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
      if (groupBy === 'type') {
        key = file.type === FileType.FOLDER ? t('groupBy.folder') : (file.meta?.format?.toUpperCase() || 'Unknown');
      } else if (groupBy === 'date') {
        if (file.createdAt) {
          const date = new Date(file.createdAt);
          key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        } else {
          key = 'Unknown';
        }
      } else if (groupBy === 'size') {
        const sizeKb = file.meta?.sizeKb || 0;
        if (sizeKb < 1024) key = t('groupBy.small');
        else if (sizeKb < 10240) key = t('groupBy.medium');
        else key = t('groupBy.large');
      }
      
      if (!groups[key]) groups[key] = [];
      groups[key].push(id);
    });
    
    return Object.entries(groups)
      .map(([title, ids]) => ({ id: title, title, fileIds: ids }))
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [displayFileIds, groupBy, state.files, t]);

  return {
    displayFileIds,
    groupedFiles,
    collapsedGroups,
    toggleGroup,
    allFiles
  };
};
