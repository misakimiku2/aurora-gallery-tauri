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
  const workerBusyRef = useRef<boolean>(false);
  const workerEpochRef = useRef<number>(0);
  const lastPostedKeyRef = useRef<string>('');
  const viewModeRef = useRef(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

  const createWorker = useCallback(() => {
      const epoch = ++workerEpochRef.current;
      const worker = new LayoutWorker();
      worker.onmessage = (e: MessageEvent) => {
          if (workerEpochRef.current !== epoch) return;
          workerBusyRef.current = false;
          if (e.data?.layout?.length > 0 && viewModeRef.current === 'folders-overview') {
              console.log(`[useLayout] Worker result: ${e.data.layout.length} items, totalHeight=${e.data.totalHeight?.toFixed(0)}`);
          }
          setLayoutState(e.data);
      };
      return worker;
  }, []);

  useEffect(() => {
    workerRef.current = createWorker();
    return () => {
        workerRef.current?.terminate();
    };
  }, [createWorker]);

  // Post message to worker when inputs change.
  // Short debounce (~15ms) coalesces same-frame changes. If the worker is still
  // busy computing a previous (now-stale) layout, terminate and recreate it so
  // only the latest input is processed — eliminates backlog during rapid pinching.
  useEffect(() => {
      if (!workerRef.current) return;
      if (containerWidth <= 0) return;
      if (items.length === 0) return;

      const itemsKey = items.join(',');
      const ratiosKey = Object.entries(aspectRatios).map(([k, v]) => `${k}:${v.toFixed(4)}`).join('|');
      const collapsedKey = collapsedGroups ? Object.entries(collapsedGroups).map(([k, v]) => `${k}:${v}`).join('|') : '';
      const postKey = `${itemsKey}|${ratiosKey}|${layoutMode}|${containerWidth}|${thumbnailSize}|${viewMode}|${searchQuery || ''}|${collapsedKey}`;

      if (postKey === lastPostedKeyRef.current) return;

      const timerId = setTimeout(() => {
          if (!workerRef.current) return;

          let worker = workerRef.current;
          if (workerBusyRef.current) {
              console.log(`[useLayout] Worker busy, terminating stale computation for thumbSize=${thumbnailSize}`);
              worker.terminate();
              worker = createWorker();
              workerRef.current = worker;
          }

          workerBusyRef.current = true;
          lastPostedKeyRef.current = postKey;

          if (viewMode === 'folders-overview') {
            console.log(`[useLayout] Posting to worker: items=${items.length}, aspectRatios=${Object.keys(aspectRatios).length}, layout=${layoutMode}, width=${containerWidth}, thumbSize=${thumbnailSize}`);
          }

          worker.postMessage({
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
      }, 15);

      return () => clearTimeout(timerId);
  }, [items, aspectRatios, layoutMode, containerWidth, thumbnailSize, viewMode, groupedTags, searchQuery, groupedPeople, collapsedGroups, createWorker]);

  return layoutState;
};
