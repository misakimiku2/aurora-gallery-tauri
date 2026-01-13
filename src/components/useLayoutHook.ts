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

export const useLayout = (
  items: string[],
  files: Record<string, FileNode>,
  layoutMode: LayoutMode,
  containerWidth: number,
  thumbnailSize: number,
  viewMode: 'browser' | 'tags-overview' | 'people-overview',
  groupedTags?: Record<string, string[]>,
  people?: Record<string, Person>,
  searchQuery?: string
) => {
  // Compute aspect ratios efficiently (memoized)
  const aspectRatios = useMemo(() => {
    const ratios: Record<string, number> = {};
    if (viewMode === 'browser') {
      items.forEach(id => {
        const file = files[id];
        ratios[id] = file?.meta?.width && file?.meta?.height 
          ? file.meta.width / file.meta.height 
          : (file?.type === FileType.FOLDER ? 1 : 1);
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
    console.log('[useLayout] Initializing LayoutWorker...');
    workerRef.current = new LayoutWorker();
    if (workerRef.current) {
        workerRef.current.onmessage = (e: MessageEvent) => {
            console.log('[useLayout] Received result from worker:', e.data);
            setLayoutState(e.data);
        };
    }
    return () => {
        console.log('[useLayout] Terminating worker');
        workerRef.current?.terminate();
    };
  }, []);

  // Post message to worker when inputs change
  useEffect(() => {
      if (!workerRef.current) return;
      
      // If container width is 0, don't calculate yet
      if (containerWidth <= 0) return;

      console.log('[useLayout] Posting task to worker:', {
          itemsCount: items.length,
          containerWidth
      });

      workerRef.current.postMessage({
          items,
          aspectRatios, // Send pre-computed ratios (lightweight) instead of full files map
          layoutMode,
          containerWidth,
          thumbnailSize,
          viewMode
      });
  }, [items, aspectRatios, layoutMode, containerWidth, thumbnailSize, viewMode]);

  return layoutState;
};
