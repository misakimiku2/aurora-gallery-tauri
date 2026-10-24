/**
 * 剪贴蒙版（PS 的 Clipping Mask，2026-10-24 第二轮）。
 *
 * **语义**：`clipped` 的层只显示在**同分段内下方最近的基础层**（非剪贴层）有像素的
 * 地方——吃的是基础层的 alpha（与图层蒙版的黑白语义无关）。连续多个剪贴层
 * （A 剪 B 剪 C 基础）全部裁进同一个基础层 C，与 PS 一致。
 *
 * **分段边界**：剪贴不跨组——组成员的剪贴基础层只在组内找；组行本身不参与
 * （它没有像素）。平层与组内各自独立，判定与渲染/导出共用这一份（`splitSegments`
 * 同一口径），否则又是"预览一种样、导出另一种样"。
 *
 * 数据损坏容忍：`clipped` 的层若往下找不到基础层（比如下面的层被删了），
 * 渲染与导出都按普通层处理——不报错、不丢层。
 */
import type { EditorLayer } from '../../types';
import { isGroupRow } from './layerGroups';
import { setLayerClipped } from './layerModel';

/**
 * 往下找剪贴基础层：同分段内（平层：遇到组行/组成员停；组内：遇到非本组成员停）
 * 第一个非剪贴层。返回 undefined = 没有基础层（不可剪贴）。
 */
export function findClipBase(layers: EditorLayer[], id: string): EditorLayer | undefined {
  const i = layers.findIndex(l => l.id === id);
  if (i < 0) return undefined;
  const groupId = layers[i].groupId;
  for (let j = i - 1; j >= 0; j -= 1) {
    const below = layers[j];
    if (isGroupRow(below)) return undefined; // 组行在成员之上，出现在下面说明已出本组
    if (groupId ? below.groupId !== groupId : below.groupId !== undefined) return undefined;
    if (!below.clipped) return below;
    // 下面的层也是剪贴层 → 链式剪贴，继续往下找共同的基础层
  }
  return undefined;
}

/** 这一层能不能剪贴（面板按钮/Alt+点/Ctrl+Alt+G 的守卫）：组行、分段最底一层不可。 */
export function canClipLayer(layers: EditorLayer[], id: string): boolean {
  const layer = layers.find(l => l.id === id);
  if (!layer || isGroupRow(layer) || !layer.source) return false;
  return !!findClipBase(layers, id);
}

/** 切换剪贴态。不可剪贴时原样返回（调用方据此不置 dirty）。 */
export function toggleClipped(layers: EditorLayer[], id: string): EditorLayer[] {
  const layer = layers.find(l => l.id === id);
  if (!layer) return layers;
  if (!layer.clipped && !canClipLayer(layers, id)) return layers;
  return setLayerClipped(layers, id, !layer.clipped);
}
