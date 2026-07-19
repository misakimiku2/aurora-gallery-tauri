import { useRef, useCallback, useEffect } from 'react';
import { TabState, Person, AppState } from '../types';

// ── Debug logger for marquee performance ──
const MARQUEE_DBG = true;
let _moveSeq = 0;
let _moveExecSeq = 0;
let _dragSessionStart = 0;

function dbg(label: string, extra?: Record<string, unknown>) {
  if (!MARQUEE_DBG) return;
  const now = performance.now();
  const elapsed = _dragSessionStart ? (now - _dragSessionStart).toFixed(1) : '0';
  if (extra) {
    console.log(`[Marquee|+${elapsed}ms] ${label}`, extra);
  } else {
    console.log(`[Marquee|+${elapsed}ms] ${label}`);
  }
}

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
  /** Optional: layout data for DOM-free collision detection on mouseup */
  layoutRef?: React.MutableRefObject<LayoutItem[]>;
}

/**
 * Timestamp-based throttle (no setTimeout).
 * Executes at most once per `interval` ms, using performance.now().
 * Much more reliable than setTimeout because it bypasses the timer queue.
 */
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
  // ── isSelecting is ref-only — zero React renders during drag ──
  const isSelectingRef = useRef(false);
  const selectionRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const selectionBoxRef = useRef({ startX: 0, startY: 0, currentX: 0, currentY: 0 });
  const selectionBoundsRef = useRef({ left: 0, top: 0, right: 0, bottom: 0 });
  const overlayVisibleRef = useRef(false);
  // Cache container rect at mousedown — avoids forced layout in every rAF frame
  const cachedContainerLeft = useRef(0);
  const cachedContainerTop = useRef(0);

  const showOverlay = useCallback(() => {
    if (overlayVisibleRef.current) return;
    overlayVisibleRef.current = true;
    if (overlayRef.current) {
      overlayRef.current.style.display = 'block';
    }
    // Add CSS class to grid container to suppress transitions during drag
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
    // Remove CSS class from grid container
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
        const t0 = performance.now();
        const rect = container.getBoundingClientRect();
        const startX = e.clientX - rect.left + container.scrollLeft;
        const startY = e.clientY - rect.top + container.scrollTop;
        const rectCost = (performance.now() - t0).toFixed(2);

        selectionBoxRef.current = { startX, startY, currentX: startX, currentY: startY };
        isSelectingRef.current = true;
        _dragSessionStart = performance.now();
        _moveSeq = 0;
        _moveExecSeq = 0;

        dbg(`MOUSEDOWN at (${startX.toFixed(0)},${startY.toFixed(0)})`, {
          clientXY: `(${e.clientX},${e.clientY})`,
          containerRect: `(${rect.left.toFixed(0)},${rect.top.toFixed(0)} ${rect.width}x${rect.height})`,
          scroll: `(${container.scrollLeft},${container.scrollTop})`,
          getBoundingClientRectCost: rectCost + 'ms',
          viewMode: activeTab.viewMode,
        });

        // Cache container rect for rAF frames (avoids forced layout every frame)
        cachedContainerLeft.current = rect.left;
        cachedContainerTop.current = rect.top;

        // Direct DOM — no React re-render
        showOverlay();
        if (overlayRef.current) {
          overlayRef.current.style.left = `${startX}px`;
          overlayRef.current.style.top = `${startY}px`;
          overlayRef.current.style.width = '0px';
          overlayRef.current.style.height = '0px';
          dbg(`overlay init DOM write done`);
        }

        // Only clear selection if there's actually something selected
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
      } else {
        dbg(`MOUSEDOWN skipped: container is null`);
      }
    }
  }, [closeContextMenu, activeTab.viewMode, activeTab.selectedFileIds, activeTab.selectedTagIds, activeTab.selectedPersonIds, updateActiveTab, showOverlay]);

  // ── rAF‑throttled mousemove: uses requestAnimationFrame instead of setTimeout ──
  // This ensures DOM updates are synchronized with the browser's paint cycle
  // and avoids the unreliable setTimeout timer queue.
  const handleMouseMoveRef = useRef<(e: React.MouseEvent) => void>();

  useEffect(() => {
    dbg(`Creating RAF-THROTTLED mousemove handler (should only happen ONCE)`);

    handleMouseMoveRef.current = rafThrottle((e: React.MouseEvent) => {
      const t0 = performance.now();

      if (!isSelectingRef.current) {
        return;
      }

      _moveExecSeq++;

      const container = selectionRef.current;
      if (!container) return;

      // Use cached container rect (set at mousedown) — avoids forced layout
      const currentX = e.clientX - cachedContainerLeft.current + container.scrollLeft;
      const currentY = e.clientY - cachedContainerTop.current + container.scrollTop;

      const box = selectionBoxRef.current;
      box.currentX = currentX;
      box.currentY = currentY;

      // Direct DOM update — bypasses React entirely
      const ov = overlayRef.current;
      if (ov) {
        const left = Math.min(box.startX, box.currentX);
        const top = Math.min(box.startY, box.currentY);
        ov.style.left = `${left}px`;
        ov.style.top = `${top}px`;
        ov.style.width = `${Math.abs(box.currentX - box.startX)}px`;
        ov.style.height = `${Math.abs(box.currentY - box.startY)}px`;
        const totalCost = (performance.now() - t0).toFixed(3);

        if (_moveExecSeq % 15 === 0) {
          dbg(`MOVE#${_moveExecSeq} (rAF exec)`, {
            pos: `(${currentX.toFixed(0)},${currentY.toFixed(0)})`,
            totalCost: totalCost + 'ms',
            overlayStyle: `(${ov.style.left},${ov.style.top} ${ov.style.width}x${ov.style.height})`,
          });
        }
      }

      // Cache bounds for mouseup collision detection
      selectionBoundsRef.current = {
        left: Math.min(box.startX, box.currentX),
        top: Math.min(box.startY, box.currentY),
        right: Math.max(box.startX, box.currentX),
        bottom: Math.max(box.startY, box.currentY),
      };
    }, 16); // Max one rAF callback within 16ms window
  }, []);

  // Stable callback wrapper — identity never changes
  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    _moveSeq++;
    if (_moveSeq % 50 === 0) {
      dbg(`RAW MOVE#${_moveSeq} (raw event, before rAF throttle)`, {
        throttledExecCount: _moveExecSeq,
        throttleRatio: `${_moveExecSeq}/${_moveSeq}`,
      });
    }
    handleMouseMoveRef.current?.(e);
  }, []);

  // ── Optimized mouseup: layout‑data collision detection ──
  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isSelectingRef.current) {
      dbg(`MOUSEUP ignored: not selecting`);
      return;
    }

    const t0 = performance.now();
    const totalDragMs = (t0 - _dragSessionStart).toFixed(0);
    dbg(`MOUSEUP start`, {
      totalDragDuration: totalDragMs + 'ms',
      rawMoveEvents: _moveSeq,
      rAFExecs: _moveExecSeq,
      effectiveFPS: _moveExecSeq > 0 ? (_moveExecSeq / (parseFloat(totalDragMs) / 1000)).toFixed(1) : 'N/A',
    });

    const box = selectionBoxRef.current;

    // Hide overlay via direct DOM
    hideOverlay();
    isSelectingRef.current = false;

    // Ignore tiny drags (clicks)
    const dragW = Math.abs(box.currentX - box.startX);
    const dragH = Math.abs(box.currentY - box.startY);
    if (dragW < 5 && dragH < 5) {
      dbg(`MOUSEUP tiny drag ignored`, { dragW, dragH });
      _moveSeq = 0;
      _moveExecSeq = 0;
      _dragSessionStart = 0;
      return;
    }

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
    dbg(`MOUSEUP selection bounds (viewport)`, {
      sel: `(${selLeft.toFixed(0)},${selTop.toFixed(0)}) → (${selRight.toFixed(0)},${selBottom.toFixed(0)})`,
      size: `${(selRight - selLeft).toFixed(0)}x${(selBottom - selTop).toFixed(0)}`,
    });

    if (activeTab.viewMode === 'browser') {
      const selectedIds: string[] = [];

      const items = layoutRef?.current;
      dbg(`MOUSEUP layoutRef check`, { hasLayoutRef: !!items, itemCount: items?.length ?? 0 });

      if (items && items.length > 0) {
        const t3 = performance.now();
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
        dbg(`MOUSEUP layout collision DONE`, {
          cost: (performance.now() - t3).toFixed(3) + 'ms',
          itemsChecked: items.length,
          selectedCount: selectedIds.length,
        });
      } else {
        // Fallback: DOM query
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
      dbg(`MOUSEUP updateActiveTab`, { selectedCount: selectedIds.length });
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

    const totalCost = (performance.now() - t0).toFixed(3);
    dbg(`MOUSEUP COMPLETE`, { totalCost: totalCost + 'ms' });

    _moveSeq = 0;
    _moveExecSeq = 0;
    _dragSessionStart = 0;
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
