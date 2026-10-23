/**
 * 图层编组（PS 的组，2026-10-24）。
 *
 * **数据模型 = 扁平 + 连续段**：组是一个 `kind: 'group'` 的占位条目（无像素），
 * 成员层的 `groupId` 指向它；**成员在数组中必须紧贴着组行**（自底向上数组里
 * 成员在组行"之前"——组的底边界先入数组，组行在最顶）。这与 PS 的语义一致：
 * 面板上的组包着一段连续区间。折叠（`collapsed`）是纯 UI 态。
 *
 * 合成语义：组内成员先互相合成（各自的 opacity/blend 在组内生效）→ 组画布按
 * **组的** opacity/blend 叠到底板。CSS 预览用嵌套 div 天然等价；Rust 用
 * `composite` 的分段接口（见 editor_commands）。
 *
 * 搬出 layerModel（防膨胀，进度文档 §7）。
 */
import type { EditorLayer } from '../../types';

export function isGroupRow(layer: EditorLayer): boolean {
  return layer.kind === 'group';
}

/** 组行 id → 组行条目（找不到 / 不是组行返回 undefined） */
export function findGroupRow(layers: EditorLayer[], groupId: string): EditorLayer | undefined {
  const row = layers.find(l => l.id === groupId);
  return row && isGroupRow(row) ? row : undefined;
}

/**
 * 组行之后的**连续成员段**（自底向上数组里成员紧贴在组行前面）。
 * 数据损坏（成员段被别的层隔断 / 缺组行）时按损坏处截断——渲染与导出用同一份
 * 分段逻辑，保证"看到的就是导出的"。
 */
export function groupSegment(
  layers: EditorLayer[],
  groupId: string,
): { members: EditorLayer[]; row: EditorLayer | undefined } {
  const rowIndex = layers.findIndex(l => l.id === groupId && isGroupRow(l));
  if (rowIndex < 0) return { members: [], row: undefined };
  let start = rowIndex;
  while (start > 0 && layers[start - 1].groupId === groupId) start -= 1;
  return { members: layers.slice(start, rowIndex), row: layers[rowIndex] };
}

/**
 * 把选中层编成一组（PS 的 Ctrl+G）：成员按**原数组相对顺序**打包（面板上
 * 不相邻的选中层也会被聚到一起），组行插在成员段顶部。
 *
 * 单层也允许编组（PS 同款）——之后拖别的层进来不方便（拖拽跨组是待办），
 * 但"先组起来占个文件夹"是合理操作。
 */
export function createGroup(
  layers: EditorLayer[],
  memberIds: string[],
  name?: string,
): EditorLayer[] {
  const picked = memberIds
    .map(id => layers.find(l => l.id === id))
    .filter((l): l is EditorLayer => !!l && !isGroupRow(l));
  if (picked.length === 0) return layers;
  const pickedIds = new Set(picked.map(l => l.id));

  const rest = layers.filter(l => !pickedIds.has(l.id));
  // 插入位置 = 被打包的层里**数组序最靠前**的那位原来的下标（在 rest 里算）
  const firstIdx = layers.findIndex(l => pickedIds.has(l.id));
  const insertAt = Math.min(firstIdx, rest.length);

  const groupId = `grp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  const members = picked.map(l => ({ ...l, groupId }));
  const row: EditorLayer = {
    id: groupId,
    kind: 'group',
    name: name ?? '组',
    visible: true,
    // 组行不是像素：box/natural* 只做类型占位（零），渲染/导出都不会读它们
    naturalWidth: 0,
    naturalHeight: 0,
    box: { x: 0, y: 0, w: 0, h: 0, rotation: 0, flipH: false, flipV: false, skewX: 0, skewY: 0 },
  };
  const next = rest.slice();
  next.splice(insertAt, 0, ...members, row);
  return next;
}

/** 取消编组：删组行，成员回归普通层（保留原相对顺序与各自的属性）。 */
export function ungroup(layers: EditorLayer[], groupId: string): EditorLayer[] {
  if (!findGroupRow(layers, groupId)) return layers;
  return layers
    .filter(l => l.id !== groupId)
    .map(l => {
      if (l.groupId !== groupId) return l;
      const next = { ...l };
      delete next.groupId;
      return next;
    });
}

/** 删除组**连带成员**（PS 的"组和内容"）。活动层由调用方按 `removeLayer` 同样的规则重算。 */
export function deleteGroupWithMembers(layers: EditorLayer[], groupId: string): EditorLayer[] {
  if (!findGroupRow(layers, groupId)) return layers;
  return layers.filter(l => l.id !== groupId && l.groupId !== groupId);
}

/** 折叠 / 展开（纯 UI 态，不进签名、不进导出）。 */
export function setGroupCollapsed(
  layers: EditorLayer[],
  groupId: string,
  collapsed: boolean,
): EditorLayer[] {
  const i = layers.findIndex(l => l.id === groupId && isGroupRow(l));
  if (i < 0) return layers;
  if ((layers[i].collapsed === true) === collapsed) return layers;
  const next = layers.slice();
  if (collapsed) next[i] = { ...next[i], collapsed: true };
  else {
    const row = { ...next[i] };
    delete row.collapsed;
    next[i] = row;
  }
  return next;
}
