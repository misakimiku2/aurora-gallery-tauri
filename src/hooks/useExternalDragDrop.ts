import { useState, useRef, useCallback } from 'react';
import type { DropAction } from '../components/DragDropOverlay';

interface UseExternalDragDropProps {
  isDraggingInternal: boolean;
  hoveredDropAction: DropAction | null;
  handleExternalCopyFiles: (files: File[], items: DataTransferItemList) => Promise<void>;
  handleExternalMoveFiles: (files: File[]) => Promise<void>;
}

export function useExternalDragDrop({
  isDraggingInternal,
  hoveredDropAction,
  handleExternalCopyFiles,
  handleExternalMoveFiles,
}: UseExternalDragDropProps) {
  const [isExternalDragging, setIsExternalDragging] = useState(false);
  const [externalDragItems, setExternalDragItems] = useState<string[]>([]);
  const [externalDragPosition, setExternalDragPosition] = useState<{ x: number; y: number } | null>(null);
  const externalDragCounter = useRef(0);

  const handleExternalDragEnter = useCallback((e: React.DragEvent) => {
    if (isDraggingInternal || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    const hasFiles = e.dataTransfer.types.includes('Files');
    const hasInternalData = e.dataTransfer.types.includes('application/json');

    if (hasFiles && !hasInternalData) {
      externalDragCounter.current++;
      if (externalDragCounter.current === 1) {
        setIsExternalDragging(true);
      }

      const itemCount = e.dataTransfer.items?.length || 0;
      if (itemCount > 0) {
        setExternalDragItems(Array(itemCount).fill(''));
      }
    }
  }, [isDraggingInternal]);

  const handleExternalDragOver = useCallback((e: React.DragEvent) => {
    if (isDraggingInternal || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    const hasFiles = e.dataTransfer.types.includes('Files');
    const hasInternalData = e.dataTransfer.types.includes('application/json');

    if (hasFiles && !hasInternalData) {
      setExternalDragPosition({ x: e.clientX, y: e.clientY });
    }
  }, [isDraggingInternal]);

  const handleExternalDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();

    externalDragCounter.current--;
    if (externalDragCounter.current <= 0) {
      externalDragCounter.current = 0;
      setIsExternalDragging(false);
      setExternalDragPosition(null);
      setExternalDragItems([]);
    }
  }, []);

  const handleExternalDrop = useCallback(async (e: React.DragEvent) => {
    if (isDraggingInternal || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    externalDragCounter.current = 0;
    setIsExternalDragging(false);
    setExternalDragPosition(null);
    setExternalDragItems([]);

    const files = Array.from(e.dataTransfer.files);
    const items = e.dataTransfer.items;

    if (files.length === 0 && items && items.length > 0) {
      if (hoveredDropAction === 'copy') {
        await handleExternalCopyFiles(files, items);
      }
      return;
    }

    if (files.length === 0) return;

    if (hoveredDropAction === 'copy') {
      await handleExternalCopyFiles(files, items);
    } else {
      await handleExternalMoveFiles(files);
    }
  }, [isDraggingInternal, hoveredDropAction, handleExternalCopyFiles, handleExternalMoveFiles]);

  return {
    isExternalDragging,
    externalDragItems,
    externalDragPosition,
    handleExternalDragEnter,
    handleExternalDragOver,
    handleExternalDragLeave,
    handleExternalDrop,
  };
}
