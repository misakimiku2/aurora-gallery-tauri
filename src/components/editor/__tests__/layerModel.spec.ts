/**
 * 最小图层模型的构造与判定单测。
 *
 * 这里最重要的一组是 `layerStateSignature` 的"改任意字段必变"——它把架构事实第 7 条
 * （新增字段漏列举）从"靠人记得全局搜 `flipV`"变成"漏了就红"。
 */
import { describe, expect, it } from 'vitest';
import type { EditorDocument, EditorLayer, LayerBox } from '../../../types';
import {
  buildLayerPreviewKey,
  createCanvas,
  createIdentityBox,
  createImageLayer,
  documentGeometrySignature,
  documentStateSignature,
  EDITOR_DOC_VERSION,
  fitLayerToCanvas,
  isLegacyEditorDocument,
  layerGeometrySignature,
  layerStateSignature,
  resolveActiveLayer,
} from '../layerModel';

const box = (over: Partial<LayerBox> = {}): LayerBox => ({
  ...createIdentityBox(200, 100),
  ...over,
});

const layer = (over: Partial<EditorLayer> = {}): EditorLayer => ({
  id: 'L1',
  kind: 'image',
  source: 'C:/img/photo.png',
  naturalWidth: 200,
  naturalHeight: 100,
  box: box(),
  visible: true,
  name: 'photo',
  ...over,
});

describe('isLegacyEditorDocument', () => {
  it('没有文档不算遗留', () => {
    expect(isLegacyEditorDocument(undefined)).toBe(false);
    expect(isLegacyEditorDocument(null)).toBe(false);
  });

  it('version 缺失或不是 2 都算遗留', () => {
    expect(isLegacyEditorDocument({ name: 'x', dirty: false })).toBe(true);
    expect(isLegacyEditorDocument({ name: 'x', dirty: false, version: 2 })).toBe(false);
  });

  it('与常量同源，不会两处各写一个数字', () => {
    expect(EDITOR_DOC_VERSION).toBe(2);
  });
});

describe('createCanvas', () => {
  it('尺寸取整、背景默认透明', () => {
    expect(createCanvas(1920.6, 1080.4)).toEqual({
      width: 1921,
      height: 1080,
      background: 'transparent',
    });
    expect(createCanvas(10, 10, 'white').background).toBe('white');
  });

  it('负数夹到 0', () => {
    expect(createCanvas(-5, 10).width).toBe(0);
  });
});

describe('fitLayerToCanvas（contain 居中，已拍板）', () => {
  it('大图缩到画布内并居中', () => {
    // 3440×1440 → 1920×1080：受宽限制，scale = 1920/3440
    const fit = fitLayerToCanvas({ width: 3440, height: 1440 }, { width: 1920, height: 1080 });
    expect(fit.w).toBe(1920);
    expect(fit.h).toBe(804);
    expect(fit.x).toBe(0);
    expect(fit.y).toBe(138); // (1080 - 804) / 2
  });

  it('竖图受高限制', () => {
    const fit = fitLayerToCanvas({ width: 1000, height: 4000 }, { width: 1920, height: 1080 });
    expect(fit.h).toBe(1080);
    expect(fit.w).toBe(270); // 1000 * 0.27
    expect(fit.x).toBe(825); // (1920 - 270) / 2
  });

  it('小图保持原尺寸、不放大（PS 置入行为）', () => {
    const fit = fitLayerToCanvas({ width: 100, height: 100 }, { width: 1920, height: 1080 });
    expect(fit).toEqual({ x: 910, y: 490, w: 100, h: 100 });
  });

  it('退化输入返回零尺寸而不是 NaN', () => {
    expect(fitLayerToCanvas({ width: 0, height: 100 }, { width: 1920, height: 1080 })).toEqual({
      x: 0,
      y: 0,
      w: 0,
      h: 0,
    });
  });
});

describe('createImageLayer', () => {
  it('默认按 contain 居中落位', () => {
    const l = createImageLayer({
      id: 'L1',
      source: 'C:/dir/photo.png',
      naturalWidth: 3440,
      naturalHeight: 1440,
      canvas: { width: 1920, height: 1080 },
    });
    expect(l.box.w).toBe(1920);
    expect(l.box.y).toBe(138);
    expect(l.box.rotation).toBe(0);
    expect(l.box.skewX).toBe(0);
  });

  it('名字取文件名（去掉扩展名）', () => {
    const l = createImageLayer({
      id: 'L1',
      source: 'C:/dir/my photo.png',
      naturalWidth: 10,
      naturalHeight: 10,
      canvas: { width: 100, height: 100 },
    });
    expect(l.name).toBe('my photo');
  });

  it('无 source 时有兜底名', () => {
    const l = createImageLayer({
      id: 'L1',
      naturalWidth: 10,
      naturalHeight: 10,
      canvas: { width: 100, height: 100 },
    });
    expect(l.name).toBe('图层');
  });

  it('fitToCanvas=false 时按 1:1 原尺寸放在原点', () => {
    const l = createImageLayer({
      id: 'L1',
      naturalWidth: 3000,
      naturalHeight: 2000,
      canvas: { width: 800, height: 600 },
      fitToCanvas: false,
    });
    expect(l.box).toMatchObject({ x: 0, y: 0, w: 3000, h: 2000 });
  });
});

describe('layerStateSignature', () => {
  it('改任意一个影响画面的字段，签名都必须变', () => {
    const base = layer();
    const baseSig = layerStateSignature(base);

    const mutations: Array<[string, Partial<EditorLayer>]> = [
      ['source', { source: 'C:/img/other.png' }],
      ['naturalWidth', { naturalWidth: 201 }],
      ['naturalHeight', { naturalHeight: 101 }],
      ['visible', { visible: false }],
      ['box.x', { box: box({ x: 1 }) }],
      ['box.y', { box: box({ y: 1 }) }],
      ['box.w', { box: box({ w: 201 }) }],
      ['box.h', { box: box({ h: 101 }) }],
      ['box.rotation', { box: box({ rotation: 90 }) }],
      ['box.flipH', { box: box({ flipH: true }) }],
      ['box.flipV', { box: box({ flipV: true }) }],
      ['box.skewX', { box: box({ skewX: 5 }) }],
      ['box.skewY', { box: box({ skewY: 5 }) }],
      [
        'adjust',
        { adjust: { brightness: 1, contrast: 0, saturation: 0, temperature: 0 } },
      ],
    ];

    for (const [label, over] of mutations) {
      expect(layerStateSignature(layer(over)), label).not.toBe(baseSig);
    }
  });

  it('改 id / name 不产生新签名（不该进撤销栈）', () => {
    const sig = layerStateSignature(layer());
    expect(layerStateSignature(layer({ id: 'L2' }))).toBe(sig);
    expect(layerStateSignature(layer({ name: 'renamed' }))).toBe(sig);
  });
});

describe('文档级签名（撤销栈用）', () => {
  const doc = (over: Partial<EditorDocument> = {}): EditorDocument =>
    ({
      name: 'doc',
      dirty: false,
      version: 2 as const,
      canvas: createCanvas(800, 600),
      layers: [layer()],
      ...over,
    }) as unknown as EditorDocument;

  it('画布尺寸或背景变了，签名必变', () => {
    const base = documentStateSignature(doc());
    expect(documentStateSignature(doc({ canvas: createCanvas(801, 600) }))).not.toBe(base);
    expect(documentStateSignature(doc({ canvas: createCanvas(800, 600, 'white') }))).not.toBe(base);
  });

  it('图层变了，签名必变', () => {
    const base = documentStateSignature(doc());
    const withMoved = doc({
      layers: [layer({ box: box({ x: 40 }) })],
    });
    expect(documentStateSignature(withMoved)).not.toBe(base);
  });

  it('只动调色时几何签名不变——这是"合并成一步撤销"的判据', () => {
    const before = doc();
    const after = doc({
      layers: [layer({ adjust: { brightness: 30, contrast: 0, saturation: 0, temperature: 0 } })],
    });
    expect(documentGeometrySignature(after)).toBe(documentGeometrySignature(before));
    expect(documentStateSignature(after)).not.toBe(documentStateSignature(before));
  });

  it('layerGeometrySignature 不理会 adjust', () => {
    const a = layer();
    const b = layer({ adjust: { brightness: 30, contrast: 0, saturation: 0, temperature: 0 } });
    expect(layerGeometrySignature(a)).toBe(layerGeometrySignature(b));
    expect(layerStateSignature(a)).not.toBe(layerStateSignature(b));
  });
});

describe('buildLayerPreviewKey', () => {
  it('无 source 就没有键', () => {
    expect(buildLayerPreviewKey(layer({ source: undefined }))).toBeNull();
  });

  it('变换变了键不变——图层图是"没变换过"的那张', () => {
    const a = buildLayerPreviewKey(layer());
    const b = buildLayerPreviewKey(
      layer({ box: box({ x: 999, rotation: 90, flipH: true }) }),
    );
    expect(a).toBe(b);
  });

  it('调色变了键也不变（预览走 CSS，不重跑 Rust）', () => {
    const a = buildLayerPreviewKey(layer());
    const b = buildLayerPreviewKey(
      layer({ adjust: { brightness: 50, contrast: 0, saturation: 0, temperature: 0 } }),
    );
    expect(a).toBe(b);
  });

  it('换源或换尺寸则换键', () => {
    expect(buildLayerPreviewKey(layer({ source: 'C:/img/a.png' }))).not.toBe(
      buildLayerPreviewKey(layer({ source: 'C:/img/b.png' })),
    );
    expect(buildLayerPreviewKey(layer({ naturalWidth: 400 }))).not.toBe(
      buildLayerPreviewKey(layer()),
    );
  });
});

describe('resolveActiveLayer', () => {
  const doc = (over: Partial<EditorDocument>) =>
    ({
      name: 'doc',
      dirty: false,
      version: 2 as const,
      ...over,
    }) as unknown as EditorDocument;

  it('没有图层时返回 undefined', () => {
    expect(resolveActiveLayer(doc({ layers: [] }))).toBeUndefined();
  });

  it('有 activeLayerId 就用它', () => {
    const layers = [layer({ id: 'A' }), layer({ id: 'B' })];
    expect(resolveActiveLayer(doc({ layers, activeLayerId: 'A' }))?.id).toBe('A');
  });

  it('否则取最上面一层', () => {
    const layers = [layer({ id: 'A' }), layer({ id: 'B' })];
    expect(resolveActiveLayer(doc({ layers }))?.id).toBe('B');
  });
});
