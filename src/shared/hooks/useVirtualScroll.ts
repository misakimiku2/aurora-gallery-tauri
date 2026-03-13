import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { LayoutItem } from '../api/types';

export interface UseVirtualScrollOptions {
  bufferSize?: number;
  containerHeight?: number;
}

export interface UseVirtualScrollResult {
  visibleItems: LayoutItem[];
  scrollTop: number;
  onScroll: (scrollTop: number) => void;
}

export function useVirtualScroll(
  layout: LayoutItem[],
  totalHeight: number,
  options: UseVirtualScrollOptions = {}
): UseVirtualScrollResult {
  const { bufferSize = 400, containerHeight = 0 } = options;
  const [scrollTop, setScrollTop] = useState(0);
  const scrollTopRef = useRef(scrollTop);

  useEffect(() => {
    scrollTopRef.current = scrollTop;
  }, [scrollTop]);

  const onScroll = useCallback((newScrollTop: number) => {
    setScrollTop(newScrollTop);
  }, []);

  const visibleItems = useMemo(() => {
    if (containerHeight === 0) {
      return layout;
    }

    const minY = scrollTop - bufferSize;
    const maxY = scrollTop + containerHeight + bufferSize;

    return layout.filter((item) => {
      return item.y < maxY && item.y + item.height > minY;
    });
  }, [layout, scrollTop, containerHeight, bufferSize]);

  return {
    visibleItems,
    scrollTop,
    onScroll,
  };
}

export default useVirtualScroll;
