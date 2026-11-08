import { describe, expect, it } from 'vitest';
import {
  activePathName, copyPathName, freePathName, pathContextActions, pathRows, panelTargetPath,
  type PathListSummary,
} from '../pathsPanelLogic';

/** path.list 摘要样例:两条已存 + 工作路径 + 活动层矢量蒙版。 */
const sample = (): PathListSummary => ({
  paths: [{ name: 'Path 1', knots: 4, subpaths: 1 }, { name: '轮廓', knots: 6, subpaths: 2 }],
  workPath: { knots: 3, subpaths: 1 },
  layerPath: { kind: 'vectorMask', layer: 7, name: 'Layer 0 Vector Mask', knots: 5 },
});

describe('pathsPanelLogic(二期 二-4,上游 vector_ui.rs paths_panel 段移植)', () => {
  it('pathRows:行序=已存→工作路径→活动层路径;层行中文名与斜体口径;层形状不可拖', () => {
    const rows = pathRows(sample());
    expect(rows.map((r) => [r.key, r.name, r.kind])).toEqual([
      ['Path 1', 'Path 1', 'saved'],
      ['轮廓', '轮廓', 'saved'],
      ['work', '工作路径', 'work'],
      ['layer', 'Layer 0 矢量蒙版', 'layer'],
    ]);
    expect(rows.every((r) => r.deletable)).toBe(true);
    const shapeRows = pathRows({ paths: [], workPath: null, layerPath: { kind: 'shape', layer: 2, name: 'Rectangle 1 Shape Path', knots: 4 } });
    expect(shapeRows[0]).toMatchObject({ key: 'layer', name: 'Rectangle 1 形状路径', deletable: false });
    expect(pathRows(null)).toEqual([]);
  });

  it('panelTargetPath:层行消失回落工作路径;未选=工作路径;已存名不在行里照旧指派(上游 sel 口径)', () => {
    const rows = pathRows(sample());
    expect(panelTargetPath(rows, 'layer')).toBe('layer');
    expect(panelTargetPath(rows, null)).toBe('work');
    expect(panelTargetPath(rows, 'Path 1')).toBe('Path 1');
    // 层行没了:layer 目标回落 work;悬空的已存名上游不校验,照旧返回
    const noLayer = rows.filter((r) => r.kind !== 'layer');
    expect(panelTargetPath(noLayer, 'layer')).toBe('work');
    expect(panelTargetPath(noLayer, '幽灵路径')).toBe('幽灵路径');
  });

  it('activePathName:选中有效优先→工作路径→活动层路径;选中名不在行里跳过(上游 active_path_name)', () => {
    const rows = pathRows(sample());
    expect(activePathName(rows, '轮廓')).toBe('轮廓');
    expect(activePathName(rows, null)).toBe('work');
    expect(activePathName(rows, '不存在')).toBe('work');
    const onlyLayer = pathRows({ paths: [], workPath: null, layerPath: { kind: 'shape', layer: 2, name: 'R Shape Path', knots: 4 } });
    expect(activePathName(onlyLayer, null)).toBe('layer');
    expect(activePathName(pathRows({ paths: [], workPath: null, layerPath: null }), null)).toBeNull();
  });

  it('freePathName:首个空闲 Path N,N 从已存数+1 起(上游 free_path_name)', () => {
    expect(freePathName([])).toBe('Path 1');
    expect(freePathName(['Path 1'])).toBe('Path 2');
    expect(freePathName(['Path 1', 'Path 2'])).toBe('Path 3');
    // 空洞:Path 2 被占则跳到 3(即使只有一条)
    expect(freePathName(['Path 2'])).toBe('Path 3');
    // 上游从 len+1 起跳只进不回:3 条时不回填 Path 2 空洞
    expect(freePathName(['别的', 'Path 1', 'Path 3'])).toBe('Path 4');
  });

  it('copyPathName:首个空闲 <名> copy N(上游 Duplicate Path)', () => {
    expect(copyPathName('轮廓', ['轮廓'])).toBe('轮廓 copy 1');
    expect(copyPathName('轮廓', ['轮廓', '轮廓 copy 1'])).toBe('轮廓 copy 2');
    expect(copyPathName('轮廓', [])).toBe('轮廓 copy 1');
  });

  it('pathContextActions:菜单顺序与命令映射照上游;工作路径=存储;已存=复制+重命名;层行=删蒙版/删图层', () => {
    const rows = pathRows(sample());
    const work = pathContextActions(rows[2], ['Path 1', '轮廓'], null, true);
    expect(work.map((a) => a.label)).toEqual(['建立选区…', '填充路径', '描边路径…', '存储路径', '删除路径']);
    const save = work.find((a) => a.label === '存储路径')!;
    expect(save).toMatchObject({ kind: 'cmd', cmd: 'path.rename', params: { name: 'work', to: 'Path 3' } });

    const saved = pathContextActions(rows[0], ['Path 1', '轮廓'], { subpaths: [] }, true);
    expect(saved.map((a) => a.label)).toEqual(['建立选区…', '填充路径', '描边路径…', '复制路径', '重命名路径…', '删除路径']);
    const dup = saved.find((a) => a.label === '复制路径')!;
    expect(dup).toMatchObject({ kind: 'cmd', cmd: 'path.set', params: { name: 'Path 1 copy 1' } });

    const mask = pathContextActions(rows[3], [], null, true);
    expect(mask.find((a) => a.kind === 'delete')).toMatchObject({ label: '删除矢量蒙版', cmd: 'layer.vectorMask.delete' });

    const shapeRow = pathRows({ paths: [], workPath: null, layerPath: { kind: 'shape', layer: 9, name: 'R Shape Path', knots: 4 } })[0];
    const shape = pathContextActions(shapeRow, [], null, true);
    expect(shape.find((a) => a.kind === 'delete')).toMatchObject({ label: '删除路径', cmd: 'layer.delete' });
    expect(shape.find((a) => a.label === '重命名路径…')).toBeUndefined();
  });

  it('pathContextActions:活动层不可画时 fill/stroke 禁用,其余照常(上游 add_enabled 门)', () => {
    const rows = pathRows(sample());
    const actions = pathContextActions(rows[2], [], null, false);
    const fill = actions.find((a) => a.label === '填充路径')!;
    expect('disabled' in fill && fill.disabled).toBe(true);
    const stroke = actions.find((a) => a.label === '描边路径…')!;
    expect('disabled' in stroke && stroke.disabled).toBe(true);
    expect('disabled' in actions[0] && actions[0].disabled).toBe(false);
  });
});
