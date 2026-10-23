/**
 * 裁剪状态机（`C` 工具 / 裁剪选项条 / Enter·Esc）。
 *
 * **非破坏性**：提交 = 改画布尺寸 + 所有图层反向平移，像素一个都不裁掉——图层
 * 只是露在画布外面被 `overflow:hidden` 挡住。导出按画布尺寸合成，所以成品与
 * "真裁掉"完全一致；而 Ctrl+Z 能把画布改回去、内容还在。
 *
 * 搬出 ImageEditor（2026-10-24 防膨胀批次 C，见进度文档 §7）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { EditorCanvas, EditorDocument, EditorToolId } from '../../types';
import { CropArea } from './CropOverlay';

export function useEditorCrop(
  tool: EditorToolId | null,
  canvas: EditorCanvas | undefined,
  doc: EditorDocument | undefined,
  onDocumentChange: (next: EditorDocument) => void,
  onToolChange: (tool: EditorToolId | null) => void,
) {
  /** 裁剪框（**画布坐标系**）。null = 不在裁剪态 */
  const [cropRect, setCropRect] = useState<CropArea | null>(null);
  const [cropRatio, setCropRatio] = useState<number | null>(null);

  // 切到裁剪工具时以全画布起步；离开即弃
  useEffect(() => {
    if (tool !== 'crop' || !canvas) {
      setCropRect(null);
      return;
    }
    setCropRect({ x: 0, y: 0, w: canvas.width, h: canvas.height });
  }, [tool, canvas]);

  const handleCropRatioChange = useCallback(
    (ratio: number | null) => {
      setCropRatio(ratio);
      if (!ratio || !canvas) return;
      setCropRect(prev => {
        if (!prev || canvas.height === 0) return prev;
        const cx = prev.x + prev.w / 2;
        const cy = prev.y + prev.h / 2;
        let w = prev.w;
        let h = w / ratio;
        if (h > canvas.height) {
          h = canvas.height;
          w = h * ratio;
        }
        if (w > canvas.width) {
          w = canvas.width;
          h = w / ratio;
        }
        return {
          x: Math.min(Math.max(cx - w / 2, 0), Math.max(0, canvas.width - w)),
          y: Math.min(Math.max(cy - h / 2, 0), Math.max(0, canvas.height - h)),
          w: Math.round(w),
          h: Math.round(h),
        };
      });
    },
    [canvas],
  );

  const commitCrop = useCallback(() => {
    if (!cropRect || !doc || !canvas) return;
    const w = Math.round(cropRect.w);
    const h = Math.round(cropRect.h);
    if (w < 1 || h < 1) return;
    const dx = Math.round(cropRect.x);
    const dy = Math.round(cropRect.y);
    onDocumentChange({
      ...doc,
      canvas: { ...canvas, width: w, height: h },
      layers: (doc.layers ?? []).map(l => ({
        ...l,
        box: { ...l.box, x: l.box.x - dx, y: l.box.y - dy },
      })),
      dirty: true,
    });
    onToolChange('move');
  }, [cropRect, doc, canvas, onDocumentChange, onToolChange]);

  const cancelCrop = useCallback(() => onToolChange('move'), [onToolChange]);

  return {
    cropRect,
    setCropRect,
    cropRatio,
    handleCropRatioChange,
    commitCrop,
    cancelCrop,
  };
}
