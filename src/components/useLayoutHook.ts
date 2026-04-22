import { useState, useRef, useEffect, useMemo } from 'react';
import { LayoutMode, FileNode, FileType, Person } from '../types';
// @ts-ignore
import LayoutWorker from '../workers/layout.worker?worker';

export interface LayoutItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PersonGroup {
    id: string;
    title: string;
    personIds: string[];
}

export const useLayout = (
  items: string[],
  files: Record<string, FileNode>,
  layoutMode: LayoutMode,
  containerWidth: number,
  thumbnailSize: number,
  viewMode: 'browser' | 'tags-overview' | 'people-overview' | 'folders-overview',
  groupedTags?: Record<string, string[]>,
  people?: Record<string, Person>,
  searchQuery?: string,
  groupedPeople?: PersonGroup[],
  collapsedGroups?: Record<string, boolean>
) => {
  const aspectRatios = useMemo(() => {
    const ratios: Record<string, number> = {};
    if (viewMode === 'browser' || viewMode === 'folders-overview') {
      items.forEach(id => {
        const file = files[id];
        if (viewMode === 'folders-overview' && file?.type === FileType.FOLDER) {
          ratios[id] = file.coverImageWidth && file.coverImageHeight
            ? file.coverImageWidth / file.coverImageHeight
            : 1;
        } else {
          ratios[id] = file?.meta?.width && file?.meta?.height
            ? file.meta.width / file.meta.height
            : (file?.type === FileType.FOLDER ? 1 : 1);
        }
      });
    }
    return ratios;
  }, [items, files, viewMode]);

  const [layoutState, setLayoutState] = useState<{ layout: LayoutItem[], totalHeight: number }>({
      layout: [],
      totalHeight: 0
  });

  const workerRef = useRef<Worker | null>(null);

  // Initialize worker
  useEffect(() => {
    workerRef.current = new LayoutWorker();
    if (workerRef.current) {
        workerRef.current.onmessage = (e: MessageEvent) => {
            setLayoutState(e.data);
        }; 
    }
    return () => {
        workerRef.current?.terminate();
    }; 
  }, []);

  // Post message to worker when inputs change
  useEffect(() => {
      if (!workerRef.current) return;
      
      // If container width is 0, don't calculate yet
      if (containerWidth <= 0) return;

      workerRef.current.postMessage({
          items,
          aspectRatios, // Send pre-computed ratios (lightweight) instead of full files map
          layoutMode,
          containerWidth,
          thumbnailSize,
          viewMode,
          groupedTags,
          searchQuery,
          groupedPeople,
          collapsedGroups
      });
  }, [items, aspectRatios, layoutMode, containerWidth, thumbnailSize, viewMode, groupedTags, searchQuery, groupedPeople, collapsedGroups]);

  return layoutState;
};
