/**
 * 合成载荷构造（导出 / 全览共用）的单测。
 *
 * 重点锁三件事：分段形状（Rust `DocumentRequest.groups` 只认这个）、可见性过滤
 * （Rust 分不清可见性，全靠这边剪）、蒙版字段（有 = 路径、无 = null）。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLayer, LayerBox } from '../../../types';
import { buildRenderGroups } from '../renderPayload';
import { createIdentityBox } from '../layerModel';

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

describe('buildRenderGroups', () => {
  it('平层 = 单成员组（opacity 100 / blend normal / mask null）', () => {
    const groups = buildRenderGroups([layer()]);
    expect(groups).toHaveLength(1);
    expect(groups[0].opacity).toBe(100);
    expect(groups[0].blend).toBe('normal');
    expect(groups[0].layers).toHaveLength(1);
    const l = groups[0].layers[0];
    expect(l.path).toBe('C:/img/a.png');
    expect(l.mask).toBeNull();
    expect(l.adjust).toBeNull();
    expect(l.opacity).toBe(100);
    expect(l.blend).toBe('normal');
    expect(l.matrix).toHaveLength(6);
  });

  it('组段：组行的 opacity/blend 作用于段，成员带各自的字段', () => {
    const member = layer({ id: 'm1', groupId: 'g1', opacity: 40, blend: 'multiply' });
    const row = { ...groupRow('g1'), opacity: 80, blend: 'screen' };
    // 自底向上：成员在组行之前
    const groups = buildRenderGroups([member, row, layer({ id: 'top' })]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({ opacity: 80, blend: 'screen' });
    expect(groups[0].layers[0]).toMatchObject({ opacity: 40, blend: 'multiply' });
    expect(groups[1].layers[0].path).toBe('C:/img/a.png');
  });

  it('隐藏层与无 source 的层被剪掉；组行隐藏 = 整组丢弃', () => {
    const hidden = layer({ id: 'h', visible: false });
    expect(buildRenderGroups([hidden])).toHaveLength(0);

    const member = layer({ id: 'm1', groupId: 'g1' });
    const rowHidden = { ...groupRow('g1'), visible: false };
    expect(buildRenderGroups([member, rowHidden])).toHaveLength(0);
  });

  it('蒙版：链接态 matrix 为 null（拉伸），解链带自己的矩阵；无蒙版为 null', () => {
    const linked = layer({ id: 'a', mask: { source: 'C:/img/m.png', naturalWidth: 64, naturalHeight: 32 } });
    const unlinked = layer({
      id: 'b',
      mask: {
        source: 'C:/img/m.png',
        naturalWidth: 64,
        naturalHeight: 32,
        box: box({ x: 5, y: 6, w: 50, h: 25 }),
      },
    });
    const groups = buildRenderGroups([linked, unlinked, layer({ id: 'c' })]);
    expect(groups[0].layers[0].mask).toEqual({ path: 'C:/img/m.png', matrix: null });
    const maskPayload = groups[1].layers[0].mask;
    expect(maskPayload?.path).toBe('C:/img/m.png');
    expect(maskPayload?.matrix).toHaveLength(6);
    expect(groups[2].layers[0].mask).toBeNull();
  });

  it('停用的蒙版按无蒙版发（mask: null）——数据在前端保留，只是不参与合成', () => {
    const disabled = layer({
      mask: { source: 'C:/img/m.png', naturalWidth: 8, naturalHeight: 4, disabled: true },
    });
    expect(buildRenderGroups([disabled])[0].layers[0].mask).toBeNull();
  });

  it('剪贴蒙版标志按层携带（clipped: true/false 显式写出）', () => {
    // 平层 = 每层一个单成员组（分段语义），各查各的
    const groups = buildRenderGroups([
      layer({ id: 'base' }),
      layer({ id: 'top', clipped: true }),
    ]);
    expect(groups[0].layers[0].clipped).toBe(false);
    expect(groups[1].layers[0].clipped).toBe(true);
  });

  it('调色与不透明度按层携带', () => {
    const groups = buildRenderGroups([
      layer({
        id: 'a',
        opacity: 65,
        blend: 'overlay',
        adjust: { brightness: 10, contrast: -5, saturation: 0, temperature: 20 },
      }),
    ]);
    const l = groups[0].layers[0];
    expect(l.opacity).toBe(65);
    expect(l.blend).toBe('overlay');
    expect(l.adjust).toEqual({ brightness: 10, contrast: -5, saturation: 0, temperature: 20 });
  });
});
