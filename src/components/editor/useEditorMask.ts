/**
 * 图层蒙版的**命令式流程**（2026-10-24 蒙版轮；2026-10-26 换 PS 口径）：给活动图层
 * 挂一张**空白蒙版**（点按钮 = 全白 reveal-all，Alt+点 = 全黑 hide-all，PS 同款）。
 * 纯数据操作在 `layerModel.setLayerMask`，画布预览在 `EditorCanvasLayers`（画过的
 * 蒙版 = `MaskedPixels` 合成画布，没画过 = CSS 壳读文件），导出在 Rust
 * `imaging::apply_mask`——这个 hook 只负责"点按钮会发生什么"。
 *
 * 2026-10-26 之前这里是"文件对话框选一张图当蒙版"——用户反馈不对：PS 的按钮就是
 * 建空白蒙版，选图导入还带来"竖屏图被拉伸铺满横屏画布"的观感问题（链接蒙版
 * 语义本来就是拉伸铺满，但作为默认入口很怪）。图片当蒙版的**数据结构**照旧支持
 * （工程里已有的图片蒙版一切照常），入口先撤。
 *
 * 空白蒙版的像素：**图层自然尺寸**（链接态 1:1，画上去的笔迹不变形），全白/全黑
 * 一张 canvas 进位图仓（文件由空闲烘焙补，source 指向稳定烘焙路径）。注册前先
 * **物化图层位图**——`MaskedPixels` 合成要两块位图都在，先备好图层那块，蒙版
 * 位图一落库显示就无缝切到合成画布（全白蒙版 = 画面不变；全黑 = 整层即刻隐藏）。
 */
import { useCallback } from 'react';
import type { EditorLayer } from '../../types';
import { isGroupRow } from './layerGroups';
import { setLayerMask } from './layerModel';
import {
  forgetBitmap,
  layerKey,
  maskKey,
  materializeBitmap,
  registerBlankBitmap,
} from './layerBitmaps';
import { allocatePaintName, blankCanvas, getPaintDir } from './brushBake';

export function useEditorMask(
  /** 活动图层（可能是组行——组蒙版不支持，hook 内挡掉） */
  active: EditorLayer | undefined,
  layers: EditorLayer[],
  activeLayerId: string | undefined,
  /** 面板的统一出口：没变化的 emit 会被调用方挡掉（不置 dirty、不进撤销栈） */
  emit: (next: { layers: EditorLayer[]; activeLayerId?: string }) => void,
  /** 添加后把选中对象切到蒙版（PS：刚建的蒙版处于选中态） */
  selectTarget?: (layerId: string, target: 'image' | 'mask') => void,
) {
  /**
   * 给活动图层挂一张空白蒙版。`color = 'white'`（reveal-all，按钮点出）或
   * `'black'`（hide-all，Alt+点，PS 同款）。已有蒙版 = 换成新的空白蒙版（可撤销；
   * 旧蒙版画过则位图作废——同键不同图，留着会张冠李戴）。
   */
  const addBlankMask = useCallback(
    async (color: 'white' | 'black') => {
      if (!active || isGroupRow(active) || !active.source) return;
      try {
        const key = maskKey(active.id);
        if (active.mask) forgetBitmap(key);
        // 先物化图层位图（MaskedPixels 的合成原料；已在内存则零开销）
        await materializeBitmap(layerKey(active.id), {
          sourcePath: active.source as string,
          width: active.naturalWidth,
          height: active.naturalHeight,
        });
        const name = allocatePaintName(key);
        const dir = await getPaintDir();
        const path = `${dir.replace(/[\\/]+$/, '')}/${name}`;
        // 蒙版像素 = 图层自然尺寸（链接态 1:1）；白/黑整个铺满
        const canvas = blankCanvas(active.naturalWidth, active.naturalHeight);
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.fillStyle = color === 'white' ? '#ffffff' : '#000000';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        registerBlankBitmap(key, canvas, name);
        emit({
          layers: setLayerMask(layers, active.id, {
            source: path,
            naturalWidth: active.naturalWidth,
            naturalHeight: active.naturalHeight,
          }),
          activeLayerId,
        });
        selectTarget?.(active.id, 'mask');
      } catch (e) {
        (await import('../../utils/logger')).error('[蒙版] 新建空白蒙版失败：', String(e));
      }
    },
    [active, layers, activeLayerId, emit, selectTarget],
  );

  /** 删除活动图层的蒙版（可撤销——蒙版进撤销签名）。选中对象回到图层本体。 */
  const removeMask = useCallback(() => {
    if (!active || !active.mask) return;
    emit({ layers: setLayerMask(layers, active.id, undefined), activeLayerId });
    selectTarget?.(active.id, 'image');
  }, [active, layers, activeLayerId, emit, selectTarget]);

  return { addBlankMask, removeMask };
}
