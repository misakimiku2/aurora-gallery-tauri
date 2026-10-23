/**
 * 图层编组的模型操作（渲染分段与导出共用 `splitSegments`，见 EditorCanvasLayers）。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLayer } from '../../../types';
import {
  createGroup,
  deleteGroupWithMembers,
  groupSegment,
  isGroupRow,
  setGroupCollapsed,
  ungroup,
} from '../layerGroups';

function img(id: string): EditorLayer {
  return {
    id,
    name: id,
    naturalWidth: 10,
    naturalHeight: 10,
    box: { x: 0, y: 0, w: 10, h: 10, rotation: 0, flipH: false, flipV: false, skewX: 0, skewY: 0 },
    visible: true,
  };
}

describe('图层编组', () => {
  it('createGroup：成员打包 + 组行插在成员段顶部', () => {
    const next = createGroup([img('A'), img('B')], ['A', 'B']);
    expect(next).toHaveLength(3);
    const row = next.find(isGroupRow)!;
    expect(row.kind).toBe('group');
    // 自底向上数组：成员在前（底），组行在后（顶）
    expect(next[0].groupId).toBe(row.id);
    expect(next[1].groupId).toBe(row.id);
    expect(groupSegment(next, row.id).members).toHaveLength(2);
  });

  it('ungroup：删组行、成员回归平层', () => {
    const grouped = createGroup([img('A'), img('B')], ['A', 'B']);
    const row = grouped.find(isGroupRow)!;
    const next = ungroup(grouped, row.id);
    expect(next).toHaveLength(2);
    expect(next.every(l => !l.groupId)).toBe(true);
    expect(next.some(isGroupRow)).toBe(false);
  });

  it('deleteGroupWithMembers：组行与成员一起消失', () => {
    const grouped = createGroup([img('A'), img('B'), img('C')], ['A', 'B']);
    const row = grouped.find(isGroupRow)!;
    const next = deleteGroupWithMembers(grouped, row.id);
    expect(next.map(l => l.id)).toEqual(['C']);
  });

  it('折叠是 UI 态：不破坏成员，可来回切', () => {
    const grouped = createGroup([img('A')], ['A']);
    const row = grouped.find(isGroupRow)!;
    const folded = setGroupCollapsed(grouped, row.id, true);
    expect(folded.find(isGroupRow)!.collapsed).toBe(true);
    expect(groupSegment(folded, row.id).members).toHaveLength(1); // 成员还在
    const unfolded = setGroupCollapsed(folded, row.id, false);
    expect('collapsed' in (unfolded.find(isGroupRow)!)).toBe(false);
  });

  it('groupSegment 对损坏数据（缺组行）返回空成员', () => {
    expect(groupSegment([img('X')], 'nope').members).toHaveLength(0);
  });
});
