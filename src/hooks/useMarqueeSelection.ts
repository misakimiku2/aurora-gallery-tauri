
import { useState, useRef, useCallback } from 'react';
import { TabState, Person, AppState } from '../types';
import { throttle } from '../utils/debounce';

interface UseMarqueeSelectionProps {
  activeTab: TabState;
  state: AppState;
  updateActiveTab: (updates: Partial<TabState>) => void;
  closeContextMenu: () => void;
}

export const useMarqueeSelection = ({
  activeTab,
  state,
  updateActiveTab,
  closeContextMenu
}: UseMarqueeSelectionProps) => {
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionBox, setSelectionBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null);
  const selectionRef = useRef<HTMLDivElement>(null);
  const selectionBoundsRef = useRef({ left: 0, top: 0, right: 0, bottom: 0 });

  const handleMouseDown = (e: React.MouseEvent) => {
    // 关闭右键菜单
    closeContextMenu();

    if ((e.target as HTMLElement).closest('.file-item') || (e.target as HTMLElement).closest('.tag-item') || (e.target as HTMLElement).closest('[style*="left:"]')) {
      return;
    }

    // Start selection box
    if (e.button === 0) { // Left mouse button
      const container = selectionRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const startX = e.clientX - rect.left + container.scrollLeft;
        const startY = e.clientY - rect.top + container.scrollTop;
        setIsSelecting(true);
        setSelectionBox({
          startX: startX,
          startY: startY,
          currentX: startX,
          currentY: startY
        });

        // Clear selection on background click
        if (activeTab.viewMode === 'browser') {
          updateActiveTab({ selectedFileIds: [] });
        } else if (activeTab.viewMode === 'tags-overview') {
          updateActiveTab({ selectedTagIds: [] });
        } else if (activeTab.viewMode === 'people-overview') {
          updateActiveTab({ selectedPersonIds: [] });
        }
      }
    }
  };

  // Optimized mouse move handler with throttling
  const handleMouseMove = useCallback(
    throttle((e: React.MouseEvent) => {
      if (!isSelecting || !selectionBox) return;

      const container = selectionRef.current;
      if (container) {
        const rect = container.getBoundingClientRect();
        const currentX = e.clientX - rect.left + container.scrollLeft;
        const currentY = e.clientY - rect.top + container.scrollTop;

        // Update selection box coordinates
        setSelectionBox(prev => prev ? {
          ...prev,
          currentX,
          currentY
        } : null);

        // Calculate bounds for selection checking
        const left = Math.min(selectionBox.startX, currentX);
        const top = Math.min(selectionBox.startY, currentY);
        const right = Math.max(selectionBox.startX, currentX);
        const bottom = Math.max(selectionBox.startY, currentY);

        selectionBoundsRef.current = { left, top, right, bottom };
      }
    }, 16),
    [isSelecting, selectionBox]
  );

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (!isSelecting || !selectionBox) return;

    const container = selectionRef.current;
    if (!container) {
      setIsSelecting(false);
      setSelectionBox(null);
      return;
    }

    const containerRect = container.getBoundingClientRect();
    const selectionLeft = containerRect.left + (Math.min(selectionBox.startX, selectionBox.currentX) - container.scrollLeft);
    const selectionTop = containerRect.top + (Math.min(selectionBox.startY, selectionBox.currentY) - container.scrollTop);
    const selectionRight = containerRect.left + (Math.max(selectionBox.startX, selectionBox.currentX) - container.scrollLeft);
    const selectionBottom = containerRect.top + (Math.max(selectionBox.startY, selectionBox.currentY) - container.scrollTop);

    if (selectionRight - selectionLeft < 5 && selectionBottom - selectionTop < 5) {
      setIsSelecting(false);
      setSelectionBox(null);
      return;
    }

    if (activeTab.viewMode === 'browser') {
      const selectedIds: string[] = [];
      const allFileElements = container.querySelectorAll('.file-item');

      allFileElements.forEach(element => {
        const id = element.getAttribute('data-id');
        if (id) {
          const rect = element.getBoundingClientRect();
          if (rect.left < selectionRight &&
            rect.right > selectionLeft &&
            rect.top < selectionBottom &&
            rect.bottom > selectionTop) {
            selectedIds.push(id);
          }
        }
      });

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
          if (rect.left < selectionRight &&
            rect.right > selectionLeft &&
            rect.top < selectionBottom &&
            rect.bottom > selectionTop) {
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
          if (rect.left < selectionRight &&
            rect.right > selectionLeft &&
            rect.top < selectionBottom &&
            rect.bottom > selectionTop) {
            selectedPersonIds.push(id);
          }
        }
      });

      updateActiveTab({
        selectedPersonIds: selectedPersonIds,
        lastSelectedId: selectedPersonIds[selectedPersonIds.length - 1] || null
      });
    }

    setIsSelecting(false);
    setSelectionBox(null);
  }, [isSelecting, selectionBox, activeTab.viewMode, updateActiveTab]);

  return {
    isSelecting,
    selectionBox,
    selectionRef,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp
  };
};
