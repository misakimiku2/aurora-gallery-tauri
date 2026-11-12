import { useState, useRef, useCallback } from 'react';
import type { DropAction } from '../components/DragDropOverlay';

interface UseExternalDragDropProps {
  isDraggingInternal: boolean;
  /** 编辑器标签激活时禁用图库外部拖放链路:不弹覆盖层、不复制/移动(外部文件
   * 交给编辑器画布的 Place 拖放);根层仍对 drop preventDefault 防 webview 导航。 */
  disabled?: boolean;
  hoveredDropAction: DropAction | null;
  handleExternalCopyFiles: (files: File[], items: DataTransferItemList) => Promise<void>;
  handleExternalMoveFiles: (files: File[]) => Promise<void>;
}

export function useExternalDragDrop({
  isDraggingInternal,
  disabled,
  hoveredDropAction,
  handleExternalCopyFiles,
  handleExternalMoveFiles,
}: UseExternalDragDropProps) {
  const [isExternalDragging, setIsExternalDragging] = useState(false);
  const [externalDragItems, setExternalDragItems] = useState<string[]>([]);
  const [externalDragPosition, setExternalDragPosition] = useState<{ x: number; y: number } | null>(null);
  const externalDragCounter = useRef(0);

  const handleExternalDragEnter = useCallback((e: React.DragEvent) => {
    if (disabled || isDraggingInternal || e.altKey) return;

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
  }, [disabled, isDraggingInternal]);

  const handleExternalDragOver = useCallback((e: React.DragEvent) => {
    if (disabled) {
      // 编辑器态:阻止默认(松手导航到文件)但不弹覆盖层、不跟踪位置
      e.preventDefault();
      return;
    }
    if (isDraggingInternal || e.altKey) return;

    e.preventDefault();
    e.stopPropagation();

    const hasFiles = e.dataTransfer.types.includes('Files');
    const hasInternalData = e.dataTransfer.types.includes('application/json');

    if (hasFiles && !hasInternalData) {
      setExternalDragPosition({ x: e.clientX, y: e.clientY });
    }
  }, [disabled, isDraggingInternal]);

  const handleExternalDragLeave = useCallback((e: React.DragEvent) => {
    if (disabled) return;
    e.preventDefault();
    e.stopPropagation();

    externalDragCounter.current--;
    if (externalDragCounter.current <= 0) {
      externalDragCounter.current = 0;
      setIsExternalDragging(false);
      setExternalDragPosition(null);
      setExternalDragItems([]);
    }
  }, [disabled]);

  const handleExternalDrop = useCallback(async (e: React.DragEvent) => {
    if (disabled) {
      // 编辑器态:画布有自己的 Place drop;落在面板等非画布区域=吞掉防导航,不复制
      e.preventDefault();
      return;
    }
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
  }, [disabled, isDraggingInternal, hoveredDropAction, handleExternalCopyFiles, handleExternalMoveFiles]);

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
