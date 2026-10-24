/**
 * 图层蒙版的**命令式流程**（2026-10-24，进度文档 §5 第 9.5 条）：选一张现成图片
 * 设为活动图层的蒙版 / 删除蒙版。纯数据操作在 `layerModel.setLayerMask`，画布预览在
 * `EditorCanvasLayers` 的 `mask-image`，导出在 Rust `imaging::apply_mask`——这个 hook
 * 只负责"点按钮会发生什么"（对话框 + emit），照 `projectIo.ts` 的分工模式拆出，
 * 别把对话框流程塞回 EditorPanel。
 *
 * 蒙版上作画（画笔灰度编辑）要等画笔工具，这一版只有"选一张图当蒙版"。
 */
import { useCallback, useRef, useState } from 'react';
import type { EditorLayer } from '../../types';
import { isGroupRow } from './layerGroups';
import { setLayerMask } from './layerModel';
import { loadLayerProxy } from './layerProxy';

/** 蒙版候选图片的过滤（与「导入图层」同一张白名单；蒙版正常应是灰度 PNG） */
const MASK_IMAGE_FILTERS = [
  {
    name: '图片',
    extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff'],
  },
];

export function useEditorMask(
  /** 活动图层（可能是组行——组蒙版不支持，hook 内挡掉） */
  active: EditorLayer | undefined,
  layers: EditorLayer[],
  activeLayerId: string | undefined,
  /** 面板的统一出口：没变化的 emit 会被调用方挡掉（不置 dirty、不进撤销栈） */
  emit: (next: { layers: EditorLayer[]; activeLayerId?: string }) => void,
  /** 添加/删除后把选中对象切到蒙版（PS：刚建的蒙版处于选中态） */
  selectTarget?: (layerId: string, target: 'image' | 'mask') => void,
) {
  const [busy, setBusy] = useState(false);
  /** 对话框已开着就别再开（连点/回车重放） */
  const openingRef = useRef(false);

  /** 选一张图片设为活动图层的蒙版（已有蒙版 = 换一张）。用户取消时什么都不发生。 */
  const addMask = useCallback(async () => {
    if (!active || isGroupRow(active) || !active.source || openingRef.current) return;
    openingRef.current = true;
    setBusy(true);
    try {
      const { open } = await import('@tauri-apps/plugin-dialog');
      const picked = await open({
        title: '选择蒙版图片（白 = 显示 / 黑 = 隐藏）',
        multiple: false,
        filters: MASK_IMAGE_FILTERS,
      });
      if (!picked || typeof picked !== 'string') return;
      // 蒙版自然尺寸问 Rust（与开文档同一条路）：解链后的独立变换框要按它算矩阵，
      // 顺带把 EXIF 方向折算的事留给图层体系——蒙版按存储方向用（PNG 无方向）
      const res = await loadLayerProxy(picked);
      emit({
        layers: setLayerMask(layers, active.id, {
          source: picked,
          naturalWidth: res.naturalWidth,
          naturalHeight: res.naturalHeight,
        }),
        activeLayerId,
      });
      selectTarget?.(active.id, 'mask');
    } finally {
      openingRef.current = false;
      setBusy(false);
    }
  }, [active, layers, activeLayerId, emit, selectTarget]);

  /** 删除活动图层的蒙版（可撤销——蒙版进撤销签名）。选中对象回到图层本体。 */
  const removeMask = useCallback(() => {
    if (!active || !active.mask) return;
    emit({ layers: setLayerMask(layers, active.id, undefined), activeLayerId });
    selectTarget?.(active.id, 'image');
  }, [active, layers, activeLayerId, emit, selectTarget]);

  return { addMask, removeMask, busy };
}
