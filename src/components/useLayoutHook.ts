import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { LayoutMode, FileNode, FileType, Person } from '../types';
// @ts-ignore
import LayoutWorker from '../workers/layout.worker?worker';
import { lanNavStep, lanNavActive } from '../utils/lanNavTrace';

export interface LayoutItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type GetFileNode = (id: string) => FileNode | undefined;

// djb2 hash: O(n) pure-number, avoids building MB-scale strings for large item sets.
function hashStringArray(arr: string[]): number {
  let h = 5381;
  for (let i = 0; i < arr.length; i++) {
    const s = arr[i];
    if (!s) continue;
    for (let j = 0; j < s.length; j++) {
      h = ((h << 5) + h + s.charCodeAt(j)) | 0;
    }
    h = (h + 5381) | 0;
  }
  return h;
}

function hashRatios(obj: Record<string, number>): number {
  let h = 5381;
  for (const k in obj) {
    h = ((h << 5) + h + k.charCodeAt(0)) | 0;
    h = ((h << 5) + h + Math.round(obj[k] * 65536)) | 0;
  }
  return h;
}

export interface PersonGroup {
    id: string;
    title: string;
    personIds: string[];
}

export const useLayout = (
  items: string[],
  getFileNode: GetFileNode,
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
  // getFileNode 是稳定回调（从 App 的 filesRef 读取），不随 setFiles 改变引用。
  // 这样 aspectRatios memo 只在 items 真正变化时重算，而非每次 files 引用变化都重算。
  const aspectRatios = useMemo(() => {
    if (aspectRatiosOverride && Object.keys(aspectRatiosOverride).length > 0) {
      return aspectRatiosOverride;
    }
    const ratios: Record<string, number> = {};
    if (viewMode === 'browser' || viewMode === 'folders-overview') {
      items.forEach(id => {
        const file = getFileNode(id);
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
  }, [items, getFileNode, viewMode, aspectRatiosOverride]);

  const [layoutState, setLayoutState] = useState<{ layout: LayoutItem[], totalHeight: number, sortedByY: number[] }>({
      layout: [],
      totalHeight: 0,
      sortedByY: []
  });

  const workerRef = useRef<Worker | null>(null);
  // 版本号：每次 postMessage 递增。Worker 回传时比对，不匹配则丢弃。
  // 替代 terminate+recreate：Worker 计算很快（<5ms），让旧结果自然完成再处理新消息，
  // 比销毁+重建 Worker（Android WebView 需 200-400ms 加载脚本）快得多。
  const postVersionRef = useRef<number>(0);
  const lastPostedKeyRef = useRef<string>('');
  const viewModeRef = useRef(viewMode);
  useEffect(() => { viewModeRef.current = viewMode; }, [viewMode]);

  const createWorker = useCallback(() => {
      const worker = new LayoutWorker();
      worker.onmessage = (e: MessageEvent) => {
          const version = e.data?._version as number | undefined;
          // 版本不匹配 = 这是过期结果，丢弃
          if (version !== undefined && version !== postVersionRef.current) return;

          const layout: LayoutItem[] = e.data?.layout || [];
          if (layout.length > 0 && viewModeRef.current === 'folders-overview') {
              console.log(`[useLayout] Worker result: ${layout.length} items, totalHeight=${e.data?.totalHeight?.toFixed(0)}`);
          }
          if (layout.length > 0 && lanNavActive()) {
              lanNavStep('Worker layout result', `${layout.length} items`);
          }
          // Build index sorted by y (then x) so visibleItems can binary-search the viewport.
          // Cost is O(n log n) but only on layout changes (low frequency), not on every scroll.
          const sortedByY = layout.map((_, i) => i).sort((a, b) => {
              const dy = layout[a].y - layout[b].y;
              return dy !== 0 ? dy : layout[a].x - layout[b].x;
          });
          setLayoutState({ layout, totalHeight: e.data?.totalHeight || 0, sortedByY });
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
  // 不再 terminate+recreate：直接 post 新消息，用版本号丢弃过期结果。
  // containerWidth 取整到 1px 精度，避免亚像素抖动（1062→1061.64）触发重复计算。
  useEffect(() => {
      if (!workerRef.current) return;
      // 取整 containerWidth，避免 scrollbar 出现/消失导致的 0.36px 抖动
      const roundedWidth = Math.round(containerWidth);
      if (roundedWidth <= 0) return;
      if (items.length === 0) {
          if (lastPostedKeyRef.current !== '') {
              setLayoutState({ layout: [], totalHeight: 0, sortedByY: [] });
              lastPostedKeyRef.current = '';
          }
          return;
      }

      const itemsKey = hashStringArray(items);
      const ratiosKey = hashRatios(aspectRatios);
      const collapsedKey = collapsedGroups ? Object.entries(collapsedGroups).map(([k, v]) => `${k}:${v}`).join('|') : '';
      const postKey = `${itemsKey}|${ratiosKey}|${layoutMode}|${roundedWidth}|${thumbnailSize}|${viewMode}|${searchQuery || ''}|${collapsedKey}`;

      if (postKey === lastPostedKeyRef.current) return;

      const timerId = setTimeout(() => {
          if (!workerRef.current) return;

          const version = ++postVersionRef.current;
          lastPostedKeyRef.current = postKey;

          if (viewMode === 'folders-overview') {
            console.log(`[useLayout] Posting to worker: items=${items.length}, aspectRatios=${Object.keys(aspectRatios).length}, layout=${layoutMode}, width=${roundedWidth}, thumbSize=${thumbnailSize}`);
          }

          workerRef.current.postMessage({
              items,
              aspectRatios,
              layoutMode,
              containerWidth: roundedWidth,
              thumbnailSize,
              viewMode,
              groupedTags,
              searchQuery,
              groupedPeople,
              collapsedGroups,
              _version: version
          });
      }, 15);

      return () => clearTimeout(timerId);
  }, [items, aspectRatios, layoutMode, containerWidth, thumbnailSize, viewMode, groupedTags, searchQuery, groupedPeople, collapsedGroups]);

  return layoutState;
};
