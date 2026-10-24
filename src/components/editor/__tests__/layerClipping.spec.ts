/**
 * 剪贴蒙版判定的单测：分段边界（不跨组）、链式剪贴（A剪B剪C基础）、
 * 组行/最底层不可剪贴、数据损坏容忍。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLayer, LayerBox } from '../../../types';
import { createIdentityBox } from '../layerModel';
import { canClipLayer, findClipBase, toggleClipped } from '../layerClipping';

const box = (over: Partial<LayerBox> = {}): LayerBox => ({
  ...createIdentityBox(100, 50),
  ...over,
});

const layer = (over: Partial<EditorLayer> = {}): EditorLayer => ({
  id: over.id ?? 'L1',
  kind: 'image',
  source: 'C:/img/a.png',
  naturalWidth: 100,
  naturalHeight: 50,
  box: box(),
  visible: true,
  name: over.id ?? 'L1',
  ...over,
});

const groupRow = (id: string): EditorLayer => ({
  ...layer({ id, kind: 'group', source: undefined }),
  source: undefined,
  naturalWidth: 0,
  naturalHeight: 0,
  box: box({ x: 0, y: 0, w: 0, h: 0 }),
});

describe('findClipBase / canClipLayer', () => {
  it('平层：基础层 = 正下方那层；最底层不可剪贴', () => {
    const layers = [layer({ id: 'base' }), layer({ id: 'top' })];
    expect(findClipBase(layers, 'top')?.id).toBe('base');
    expect(canClipLayer(layers, 'top')).toBe(true);
    expect(findClipBase(layers, 'base')).toBeUndefined();
    expect(canClipLayer(layers, 'base')).toBe(false);
  });

  it('链式剪贴：连续剪贴层裁进同一个基础层', () => {
    const layers = [
      layer({ id: 'base' }),
      layer({ id: 'mid', clipped: true }),
      layer({ id: 'top', clipped: true }),
    ];
    expect(findClipBase(layers, 'mid')?.id).toBe('base');
    expect(findClipBase(layers, 'top')?.id).toBe('base');
  });

  it('数据损坏：整串都是剪贴层（没有基础）时按不可剪贴处理', () => {
    const layers = [layer({ id: 'a', clipped: true }), layer({ id: 'b', clipped: true })];
    expect(findClipBase(layers, 'b')).toBeUndefined();
    expect(canClipLayer(layers, 'b')).toBe(false);
  });

  it('组内：剪贴基础层只在组内找，不跨出组', () => {
    // 自底向上：组成员在组行之前
    const layers = [
      layer({ id: 'outside' }),
      layer({ id: 'm1', groupId: 'g1' }),
      layer({ id: 'm2', groupId: 'g1' }),
      groupRow('g1'),
      layer({ id: 'top' }),
    ];
    expect(findClipBase(layers, 'm2')?.id).toBe('m1');
    // 组内最底成员下面是组外层 → 不可剪贴（不跨组）
    expect(findClipBase(layers, 'm1')).toBeUndefined();
    expect(canClipLayer(layers, 'm1')).toBe(false);
    // 组行上方的平层：正下方是组行 → 边界，不可剪贴
    expect(canClipLayer(layers, 'top')).toBe(false);
  });

  it('组行本身不可剪贴', () => {
    const layers = [layer({ id: 'base' }), groupRow('g1')];
    expect(canClipLayer(layers, 'g1')).toBe(false);
  });
});

describe('toggleClipped', () => {
  it('切换开/关；不可剪贴时原样返回', () => {
    const layers = [layer({ id: 'base' }), layer({ id: 'top' })];
    const on = toggleClipped(layers, 'top');
    expect(on[1].clipped).toBe(true);
    const off = toggleClipped(on, 'top');
    expect('clipped' in off[1]).toBe(false);

    // 最底层不可剪贴：返回原引用
    expect(toggleClipped(layers, 'base')).toBe(layers);
  });
});
