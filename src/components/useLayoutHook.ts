import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
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
  collapsedGroups?: Record<string, boolean>,
  aspectRatiosOverride?: Record<string, number>
) => {
  const aspectRatios = useMemo(() => {
    if (aspectRatiosOverride && Object.keys(aspectRatiosOverride).length > 0) {
      return aspectRatiosOverride;
    }
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
  }, [items, files, viewMode, aspectRatiosOverride]);

  const [layoutState, setLayoutState] = useState<{ layout: LayoutItem[], totalHeight: number }>({
      layout: [],
      totalHeight: 0
  });

  const workerRef = useRef<Worker | null>(null);
  const lastPostedKeyRef = useRef<string>('');

  // Initialize worker
  useEffect(() => {
    workerRef.current = new LayoutWorker();
    if (workerRef.current) {
        workerRef.current.onmessage = (e: MessageEvent) => {
            if (e.data?.layout?.length > 0 && e.data.layout[0]?.id && viewMode === 'folders-overview') {
              console.log(`[useLayout] Worker result: ${e.data.layout.length} items, totalHeight=${e.data.totalHeight?.toFixed(0)}`);
            }
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

      const itemsKey = items.join(',');
      const ratiosKey = Object.entries(aspectRatios).map(([k, v]) => `${k}:${v.toFixed(4)}`).join('|');
      const collapsedKey = collapsedGroups ? Object.entries(collapsedGroups).map(([k, v]) => `${k}:${v}`).join('|') : '';
      const postKey = `${itemsKey}|${ratiosKey}|${layoutMode}|${containerWidth}|${thumbnailSize}|${viewMode}|${searchQuery || ''}|${collapsedKey}`;

      if (postKey === lastPostedKeyRef.current) return;
      lastPostedKeyRef.current = postKey;

      if (viewMode === 'folders-overview') {
        console.log(`[useLayout] Posting to worker: items=${items.length}, aspectRatios=${Object.keys(aspectRatios).length}, layout=${layoutMode}, width=${containerWidth}, thumbSize=${thumbnailSize}`);
      }

      workerRef.current.postMessage({
          items,
          aspectRatios,
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
