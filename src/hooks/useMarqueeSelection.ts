import { useRef, useCallback, useEffect } from 'react';
import { TabState, AppState } from '../types';

export interface LayoutItem {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UseMarqueeSelectionProps {
  activeTab: TabState;
  state: AppState;
  updateActiveTab: (updates: Partial<TabState>) => void;
  closeContextMenu: () => void;
  layoutRef?: React.MutableRefObject<LayoutItem[]>;
}

function rafThrottle<T extends (...args: any[]) => void>(
  func: T,
  intervalMs: number = 16,
): (...args: Parameters<T>) => void {
  let lastExec = 0;
  let rafId: number | null = null;
  let pendingArgs: Parameters<T> | null = null;

  const flush = () => {
    const now = performance.now();
    if (pendingArgs && now - lastExec >= intervalMs) {
      lastExec = now;
      func(...pendingArgs);
    }
    pendingArgs = null;
    rafId = null;
  };

  return (...args: Parameters<T>) => {
    pendingArgs = args;
    if (rafId === null) {
      rafId = requestAnimationFrame(flush);
    }
  };
}

export const useMarqueeSelection = ({
  activeTab,
  state,
  updateActiveTab,
  closeContextMenu,
  layoutRef,
}: UseMarqueeSelectionProps) => {
  const isSelectingRef = useRef(false);
  const selectionRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const selectionBoxRef = useRef({ startX: 0, startY: 0, currentX: 0, currentY: 0 });
  const selectionBoundsRef = useRef({ left: 0, top: 0, right: 0, bottom: 0 });
  const overlayVisibleRef = useRef(false);
  const cachedContainerLeft = useRef(0);
  const cachedContainerTop = useRef(0);

  const showOverlay = useCallback(() => {
    if (overlayVisibleRef.current) return;
    overlayVisibleRef.current = true;
    if (overlayRef.current) {
      overlayRef.current.style.display = 'block';
    }
    if (selectionRef.current) {
      selectionRef.current.classList.add('marquee-selecting');
    }
  }, []);

  const hideOverlay = useCallback(() => {
    if (!overlayVisibleRef.current) return;
    overlayVisibleRef.current = false;
    if (overlayRef.current) {
      overlayRef.current.style.display = 'none';
    }
    if (selectionRef.current) {
      selectionRef.current.classList.remove('marquee-selecting');
    }
  }, []);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    closeContextMenu();

    if (
      (e.target as HTMLElement).closest('.file-item') ||
      (e.target as HTMLElement).closest('.tag-item') ||
      (e.target as HTMLElement).closest('[style*="left:"]')
    ) {
      return;
    }

    if (e.button === 0) {
      const container = selectionRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const startX = e.clientX - rect.left + container.scrollLeft;
        const startY = e.clientY - rect.top + container.scrollTop;

        selectionBoxRef.current = { startX, startY, currentX: startX, currentY: startY };
        isSelectingRef.current = true;

        cachedContainerLeft.current = rect.left;
        cachedContainerTop.current = rect.top;

        showOverlay();
        if (overlayRef.current) {
          overlayRef.current.style.left = `${startX}px`;
          overlayRef.current.style.top = `${startY}px`;
          overlayRef.current.style.width = '0px';
          overlayRef.current.style.height = '0px';
        }

        const hasBrowserSelection = activeTab.viewMode === 'browser' && activeTab.selectedFileIds?.length > 0;
        const hasTagSelection = activeTab.viewMode === 'tags-overview' && activeTab.selectedTagIds?.length > 0;
        const hasPersonSelection = activeTab.viewMode === 'people-overview' && activeTab.selectedPersonIds?.length > 0;

        if (hasBrowserSelection) {
          updateActiveTab({ selectedFileIds: [] });
        } else if (hasTagSelection) {
          updateActiveTab({ selectedTagIds: [] });
        } else if (hasPersonSelection) {
          updateActiveTab({ selectedPersonIds: [] });
        }
      }
    }
  }, [closeContextMenu, activeTab.viewMode, activeTab.selectedFileIds, activeTab.selectedTagIds, activeTab.selectedPersonIds, updateActiveTab, showOverlay]);

  const handleMouseMoveRef = useRef<(e: React.MouseEvent) => void>();

  useEffect(() => {
    handleMouseMoveRef.current = rafThrottle((e: React.MouseEvent) => {
      if (!isSelectingRef.current) return;

      const container = selectionRef.current;
      if (!container) return;

      const currentX = e.clientX - cachedContainerLeft.current + container.scrollLeft;
      const currentY = e.clientY - cachedContainerTop.current + container.scrollTop;

      const box = selectionBoxRef.current;
      box.currentX = currentX;
      box.currentY = currentY;

      const ov = overlayRef.current;
      if (ov) {
        const left = Math.min(box.startX, box.currentX);
        const top = Math.min(box.startY, box.currentY);
        ov.style.left = `${left}px`;
        ov.style.top = `${top}px`;
        ov.style.width = `${Math.abs(box.currentX - box.startX)}px`;
        ov.style.height = `${Math.abs(box.currentY - box.startY)}px`;
      }

      selectionBoundsRef.current = {
        left: Math.min(box.startX, box.currentX),
        top: Math.min(box.startY, box.currentY),
        right: Math.max(box.startX, box.currentX),
        bottom: Math.max(box.startY, box.currentY),
      };
    }, 16);
  }, []);

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    handleMouseMoveRef.current?.(e);
  }, []);

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isSelectingRef.current) return;

    const box = selectionBoxRef.current;

    hideOverlay();
    isSelectingRef.current = false;

    const dragW = Math.abs(box.currentX - box.startX);
    const dragH = Math.abs(box.currentY - box.startY);
    if (dragW < 5 && dragH < 5) return;

    const container = selectionRef.current;
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const scrollLeft = container.scrollLeft;
    const scrollTop = container.scrollTop;

    const bounds = selectionBoundsRef.current;
    const selLeft = containerRect.left + bounds.left - scrollLeft;
    const selTop = containerRect.top + bounds.top - scrollTop;
    const selRight = containerRect.left + bounds.right - scrollLeft;
    const selBottom = containerRect.top + bounds.bottom - scrollTop;

    if (activeTab.viewMode === 'browser') {
      const selectedIds: string[] = [];
      const items = layoutRef?.current;

      if (items && items.length > 0) {
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          const vl = containerRect.left + item.x - scrollLeft;
          const vt = containerRect.top + item.y - scrollTop;
          const vr = vl + item.width;
          const vb = vt + item.height;

          if (vl < selRight && vr > selLeft && vt < selBottom && vb > selTop) {
            selectedIds.push(item.id);
          }
        }
      } else {
        const allFileElements = container.querySelectorAll('.file-item');
        allFileElements.forEach(element => {
          const id = element.getAttribute('data-id');
          if (id) {
            const rect = element.getBoundingClientRect();
            if (rect.left < selRight && rect.right > selLeft &&
                rect.top < selBottom && rect.bottom > selTop) {
              selectedIds.push(id);
            }
          }
        });
      }

      updateActiveTab({
        selectedFileIds: selectedIds,
        lastSelectedId: selectedIds[selectedIds.length - 1] || null
      });
    } else if (activeTab.viewMode === 'tags-overview') {
      const selectedTagIds: string[] = [];
      const tagElements = document.querySelectorAll('.tag-item');
      tagElements.forEach(element => {
        const tag = element.getAttribute('data-tag');
        if (tag) {
          const rect = element.getBoundingClientRect();
          if (rect.left < selRight && rect.right > selLeft &&
              rect.top < selBottom && rect.bottom > selTop) {
            selectedTagIds.push(tag);
          }
        }
      });
      if (selectedTagIds.length > 0) {
        updateActiveTab({ selectedTagIds });
      }
    } else if (activeTab.viewMode === 'people-overview') {
      const selectedPersonIds: string[] = [];
      const personElements = container.querySelectorAll('.person-item');
      personElements.forEach(element => {
        const id = element.getAttribute('data-id');
        if (id) {
          const rect = element.getBoundingClientRect();
          if (rect.left < selRight && rect.right > selLeft &&
              rect.top < selBottom && rect.bottom > selTop) {
            selectedPersonIds.push(id);
          }
        }
      });
      updateActiveTab({
        selectedPersonIds: selectedPersonIds,
        lastSelectedId: selectedPersonIds[selectedPersonIds.length - 1] || null
      });
    }
  }, [activeTab.viewMode, updateActiveTab, layoutRef, hideOverlay]);

  return {
    isSelecting: false,
    overlayRef,
    selectionRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
  };
};
