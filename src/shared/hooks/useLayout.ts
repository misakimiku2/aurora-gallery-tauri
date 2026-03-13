import { useMemo, useRef, useCallback } from 'react';
import { LayoutMode, LayoutItem } from '../api/types';

export interface UseLayoutOptions {
  mode: LayoutMode;
  thumbnailSize: number;
  gap?: number;
  padding?: number;
  aspectRatios?: Record<string, number>;
}

export interface UseLayoutResult {
  layout: LayoutItem[];
  totalHeight: number;
  setAspectRatio: (id: string, ratio: number) => void;
}

interface LayoutCalculationResult {
  layout: LayoutItem[];
  totalHeight: number;
}

interface AspectRatios {
  [key: string]: number;
}

function calculateLayout(
  items: string[],
  aspectRatios: AspectRatios,
  containerWidth: number,
  mode: LayoutMode,
  thumbnailSize: number,
  gap: number,
  padding: number
): LayoutCalculationResult {
  const layout: LayoutItem[] = [];
  const GAP = gap;
  const PADDING = padding;

  const safeContainerWidth = containerWidth > 0 ? containerWidth : 1280;
  const availableWidth = Math.max(100, safeContainerWidth - PADDING * 2);

  if (mode === 'grid') {
    const minColWidth = thumbnailSize;
    const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
    const itemWidth = (availableWidth - (cols - 1) * GAP) / cols;
    const itemHeight = itemWidth + 40;

    items.forEach((id, index) => {
      const row = Math.floor(index / cols);
      const col = index % cols;
      layout.push({
        id,
        x: PADDING + col * (itemWidth + GAP),
        y: PADDING + row * (itemHeight + GAP),
        width: itemWidth,
        height: itemHeight,
      });
    });

    const rows = Math.ceil(items.length / cols);
    const totalHeight = PADDING + rows * (itemHeight + GAP);
    return { layout, totalHeight };
  }

  if (mode === 'masonry') {
    const minColWidth = thumbnailSize;
    const cols = Math.max(1, Math.floor((availableWidth + GAP) / (minColWidth + GAP)));
    const colWidth = (availableWidth - (cols - 1) * GAP) / cols;
    const colHeights = new Array(cols).fill(PADDING);

    items.forEach((id) => {
      const ratio = aspectRatios[id] || 1;
      const imgHeight = ratio > 0 ? colWidth / ratio : colWidth;
      const itemHeight = imgHeight + 40;

      let minCol = 0;
      for (let i = 1; i < cols; i++) {
        if (colHeights[i] < colHeights[minCol]) {
          minCol = i;
        }
      }

      const x = PADDING + minCol * (colWidth + GAP);
      const y = colHeights[minCol];

      layout.push({ id, x, y, width: colWidth, height: itemHeight });

      colHeights[minCol] += itemHeight + GAP;
    });

    const totalHeight = Math.max(...colHeights);
    return { layout, totalHeight };
  }

  if (mode === 'adaptive') {
    const targetHeight = thumbnailSize;
    let currentRow: { id: string; w: number }[] = [];
    let currentWidth = 0;
    let y = PADDING;

    items.forEach((id, index) => {
      const ratio = aspectRatios[id] || 1;
      const w = targetHeight * ratio;

      currentRow.push({ id, w });
      currentWidth += w;

      const gaps = Math.max(0, currentRow.length - 1) * GAP;

      if (currentWidth + gaps >= availableWidth || index === items.length - 1) {
        let scale = (availableWidth - gaps) / currentWidth;

        if (index === items.length - 1 && currentWidth + gaps < availableWidth / 2) {
          scale = 1;
        }

        const rowHeight = targetHeight * scale;
        let x = PADDING;

        currentRow.forEach((item) => {
          const finalW = item.w * scale;
          layout.push({
            id: item.id,
            x,
            y,
            width: finalW,
            height: rowHeight + 40,
          });
          x += finalW + GAP;
        });

        y += rowHeight + 40 + GAP;
        currentRow = [];
        currentWidth = 0;
      }
    });

    return { layout, totalHeight: y };
  }

  return { layout: [], totalHeight: 0 };
}

export function useLayout(
  items: string[],
  containerWidth: number,
  options: UseLayoutOptions
): UseLayoutResult {
  const aspectRatiosRef = useRef<AspectRatios>({});

  const mode = options.mode;
  const thumbnailSize = options.thumbnailSize;
  const gap = options.gap ?? 16;
  const padding = options.padding ?? 24;
  const externalAspectRatios = options.aspectRatios;

  const mergedAspectRatios = useMemo(() => {
    const ratios: AspectRatios = {};
    items.forEach((id) => {
      if (externalAspectRatios && externalAspectRatios[id] !== undefined) {
        ratios[id] = externalAspectRatios[id];
        aspectRatiosRef.current[id] = externalAspectRatios[id];
      } else if (aspectRatiosRef.current[id] !== undefined) {
        ratios[id] = aspectRatiosRef.current[id];
      } else {
        ratios[id] = 1;
      }
    });
    return ratios;
  }, [items, externalAspectRatios]);

  const setAspectRatio = useCallback((id: string, ratio: number) => {
    aspectRatiosRef.current[id] = ratio;
  }, []);

  const layoutResult = useMemo(() => {
    return calculateLayout(
      items,
      mergedAspectRatios,
      containerWidth,
      mode,
      thumbnailSize,
      gap,
      padding
    );
  }, [items, mergedAspectRatios, containerWidth, mode, thumbnailSize, gap, padding]);

  return {
    ...layoutResult,
    setAspectRatio,
  };
}

export default useLayout;
