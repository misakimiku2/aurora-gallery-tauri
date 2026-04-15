import { useState, useCallback, useRef } from 'react';

interface VirtualScrollConfig {
  itemHeight: number;
  itemsPerRow: number;
  overscanRows: number;
  containerHeight: number;
}

interface VirtualScrollResult<T> {
  visibleItems: T[];
  startIndex: number;
  endIndex: number;
  onScroll: (scrollTop: number) => void;
  totalHeight: number;
  offsetY: number;
  scrollState: 'idle' | 'scrolling' | 'fast';
}

export function useVirtualScroll<T>(
  items: T[],
  config: VirtualScrollConfig
): VirtualScrollResult<T> {
  const { itemHeight, itemsPerRow, overscanRows, containerHeight } = config;
  
  const [scrollTop, setScrollTop] = useState(0);
  const scrollStateRef = useRef<'idle' | 'scrolling' | 'fast'>('idle');
  const lastScrollTimeRef = useRef(0);
  
  const totalRows = Math.ceil(items.length / itemsPerRow);
  const totalHeight = totalRows * itemHeight;
  
  const startRow = Math.floor(scrollTop / itemHeight);
  const endRow = Math.min(
    startRow + Math.ceil(containerHeight / itemHeight),
    totalRows
  );
  
  const visibleStartRow = Math.max(0, startRow - overscanRows);
  const visibleEndRow = Math.min(totalRows, endRow + overscanRows);
  
  const startIndex = visibleStartRow * itemsPerRow;
  const endIndex = Math.min(items.length, visibleEndRow * itemsPerRow);
  
  const visibleItems = items.slice(startIndex, endIndex);
  const offsetY = visibleStartRow * itemHeight;
  
  const onScroll = useCallback((newScrollTop: number) => {
    const now = Date.now();
    const timeSinceLastScroll = now - lastScrollTimeRef.current;
    
    if (timeSinceLastScroll < 50) {
      scrollStateRef.current = 'fast';
    } else if (timeSinceLastScroll < 200) {
      scrollStateRef.current = 'scrolling';
    } else {
      scrollStateRef.current = 'idle';
    }
    
    lastScrollTimeRef.current = now;
    setScrollTop(newScrollTop);
  }, []);
  
  return {
    visibleItems,
    startIndex,
    endIndex,
    onScroll,
    totalHeight,
    offsetY,
    scrollState: scrollStateRef.current,
  };
}

export function getThumbnailQuality(scrollState: 'idle' | 'scrolling' | 'fast'): {
  size: number;
  quality: number;
} {
  switch (scrollState) {
    case 'fast':
      return { size: 128, quality: 70 };
    case 'scrolling':
      return { size: 256, quality: 85 };
    case 'idle':
      return { size: 512, quality: 95 };
  }
}
