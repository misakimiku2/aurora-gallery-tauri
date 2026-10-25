/**
 * 引擎显示桥的**纯函数**测试：`buildDisplayDocument` 的载荷形状（与 Rust
 * `DisplayDocument` 的 serde 契约一一对应）+ 开关的 localStorage 口径。
 *
 * 这里锁的是 M3 接线的"两端契约"：mode 标签嵌在 source 字段里、file 模式走
 * displaySourceOf（烘焙文件优先）、store 只看位图常驻、可见性剪除与导出同口径。
 */
import { describe, expect, it, beforeEach } from 'vitest';
import type { EditorCanvas, EditorLayer } from '../../../types';
import {
  buildDisplayDocument,
  engineDisplayEnabled,
  setEngineDisplayEnabled,
} from '../engineDisplay';
import { layerKey, maskKey } from '../layerBitmaps';

function makeLayer(overrides: Partial<EditorLayer> & { id: string }): EditorLayer {
  return {
    kind: 'image',
    naturalWidth: 32,
    naturalHeight: 24,
    box: { x: 0, y: 0, w: 32, h: 24, rotation: 0, flipH: false, flipV: false, skewX: 0, skewY: 0 },
    visible: true,
    ...overrides,
  } as EditorLayer;
}

const canvas: EditorCanvas = { width: 64, height: 48, background: 'white' };

describe('buildDisplayDocument', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('没上传 = file 模式（displaySourceOf 路径）；上传完成 = store 模式', () => {
    const plain = makeLayer({ id: 'a', source: 'C:/pics/a.png' });
    const doc = buildDisplayDocument(canvas, [plain]);
    expect(doc.groups).toHaveLength(1);
    expect(doc.groups[0].layers[0].source).toEqual({ mode: 'file', path: 'C:/pics/a.png' });

    // 上传完成（uploaded 集合里有键）→ store 模式
    const doc2 = buildDisplayDocument(canvas, [plain], new Set([layerKey('a')]));
    expect(doc2.groups[0].layers[0].source).toEqual({ mode: 'store' });
    expect(doc2.groups[0].layers[0].pixelWidth).toBe(32);
  });

  it('蒙版：上传完成 = store、没上传 = file、停用 = null（不进载荷）', () => {
    const withMask = makeLayer({
      id: 'b',
      source: 'C:/pics/b.png',
      mask: {
        source: 'C:/pics/m.png',
        naturalWidth: 32,
        naturalHeight: 24,
        disabled: false,
      },
    });
    const doc = buildDisplayDocument(canvas, [withMask]);
    expect(doc.groups[0].layers[0].mask?.source).toEqual({
      mode: 'file',
      path: 'C:/pics/m.png',
      matrix: null,
    });

    // 蒙版上传完成 → store
    const doc2 = buildDisplayDocument(canvas, [withMask], new Set([maskKey('b')]));
    expect(doc2.groups[0].layers[0].mask?.source).toEqual({ mode: 'store', matrix: null });

    // 停用 → 整个 mask 字段 null（与导出载荷"停用发 null"同口径）
    const disabled = makeLayer({
      id: 'c',
      source: 'C:/pics/c.png',
      mask: {
        source: 'C:/pics/m.png',
        naturalWidth: 32,
        naturalHeight: 24,
        disabled: true,
      },
    });
    const doc3 = buildDisplayDocument(canvas, [disabled]);
    expect(doc3.groups[0].layers[0].mask).toBeNull();
  });

  it('可见性剪除与导出同口径：隐藏层不进载荷、组行眼睛关 = 整组丢弃', () => {
    const base = makeLayer({ id: 'base', source: 'C:/a.png' });
    const hidden = makeLayer({ id: 'h', source: 'C:/h.png', visible: false });
    const member = makeLayer({ id: 'm1', source: 'C:/m1.png', groupId: 'g1' });
    const member2 = makeLayer({ id: 'm2', source: 'C:/m2.png', groupId: 'g1' });
    const groupRow = makeLayer({
      id: 'g1',
      kind: 'group',
      visible: false,
      collapsed: false,
    });
    const doc = buildDisplayDocument(canvas, [base, hidden, member, member2, groupRow]);
    expect(doc.groups).toHaveLength(1);
    expect(doc.groups[0].layers.map(l => l.id)).toEqual(['base']);
  });

  it('分段 = 组语义（组 opacity/blend 挂组段）+ 调色/不透明度/混合透传', () => {
    const member = makeLayer({
      id: 'm1',
      source: 'C:/m1.png',
      groupId: 'g1',
      opacity: 70,
      blend: 'multiply',
      adjust: { brightness: 15, contrast: 0, saturation: -20, temperature: 0 },
    });
    const groupRow = makeLayer({ id: 'g1', kind: 'group', opacity: 85, blend: 'screen' });
    const doc = buildDisplayDocument(canvas, [member, groupRow]);
    expect(doc.groups).toHaveLength(1);
    expect(doc.groups[0].opacity).toBe(85);
    expect(doc.groups[0].blend).toBe('screen');
    const l = doc.groups[0].layers[0];
    expect(l.opacity).toBe(70);
    expect(l.blend).toBe('multiply');
    expect(l.adjust).toEqual({ brightness: 15, contrast: 0, saturation: -20, temperature: 0 });
    expect(l.matrix).toHaveLength(6);
  });
});

describe('引擎显示开关', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('localStorage 口径 + set 往返', () => {
    expect(engineDisplayEnabled()).toBe(false);
    setEngineDisplayEnabled(true);
    expect(engineDisplayEnabled()).toBe(true);
    expect(localStorage.getItem('aurora-editor-engine')).toBe('1');
    setEngineDisplayEnabled(false);
    expect(engineDisplayEnabled()).toBe(false);
    expect(localStorage.getItem('aurora-editor-engine')).toBeNull();
  });
});
