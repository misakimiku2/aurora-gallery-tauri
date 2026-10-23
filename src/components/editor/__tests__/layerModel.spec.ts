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
  createLayerId,
  createOrientedImageLayer,
  documentGeometrySignature,
  documentStateSignature,
  duplicateLayer,
  EDITOR_DOC_VERSION,
  fitLayerToCanvas,
  isLegacyEditorDocument,
  layerBlend,
  layerGeometrySignature,
  layerOpacity,
  layersTopDown,
  layerStateSignature,
  orientationToBox,
  removeLayer,
  reorderLayers,
  resolveActiveLayer,
  setLayerBlend,
  setLayerOpacity,
  setLayerVisible,
} from '../layerModel';
import { layerAABB } from '../layerTransform';

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

  it('没有 v2 版本号且带 v1 平铺字段才算是遗留', () => {
    // v1 文档：有 crop/rotation/adjust 但没有 version
    expect(isLegacyEditorDocument({ name: 'x', dirty: false, rotation: 90 })).toBe(true);
    expect(isLegacyEditorDocument({ name: 'x', dirty: false, crop: { x: 0, y: 0, w: 1, h: 1 } })).toBe(true);
    expect(isLegacyEditorDocument({ name: 'x', dirty: false, version: 2 })).toBe(false);
  });

  it('刚从画廊打开的新文档（无 version、无遗留字段）不算遗留', () => {
    // App.openInEditor 建出来的就是这个形状：画布与图层要等图加载才补，
    // 只看 version 会把它误判成旧文档并弹出警告——用户实测会立刻看到那句警告。
    expect(isLegacyEditorDocument({ name: 'photo.png', dirty: false, path: 'C:/a.png' })).toBe(false);
    // 空画布文档也一样
    expect(
      isLegacyEditorDocument({ name: '未命名-1', dirty: false, version: 2, layers: [] }),
    ).toBe(false);
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

  it('改名不产生新签名（不该进撤销栈）；改 id 要产生新签名', () => {
    const sig = layerStateSignature(layer());
    // 改名字只是标签，画面没变 ⇒ 不该灌一条撤销
    expect(layerStateSignature(layer({ name: 'renamed' }))).toBe(sig);
    // **id 必须进签名**：两张同源同尺寸的图层（复制出来的）只有 id 能区分，
    // 否则"把副本挪到另一层上下"会被判成"没变"，这一步就撤销不回来
    expect(layerStateSignature(layer({ id: 'L2' }))).not.toBe(sig);
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

describe('orientationToBox（EXIF 方向）', () => {
  // 手机竖拍的典型情况：存储 4000×3000 横向，EXIF 说"要顺时针转 90°"
  const natural = { width: 4000, height: 3000 };

  it('1 = 原样', () => {
    expect(orientationToBox(natural, 1)).toEqual({
      rotation: 0,
      flipH: false,
      flipV: false,
      displayWidth: 4000,
      displayHeight: 3000,
    });
  });

  it('6 = 顺时针 90°，显示尺寸宽高互换', () => {
    const m = orientationToBox(natural, 6);
    expect(m.rotation).toBe(90);
    expect([m.displayWidth, m.displayHeight]).toEqual([3000, 4000]);
  });

  it('8 = 逆时针 90°', () => {
    const m = orientationToBox(natural, 8);
    expect(m.rotation).toBe(270);
    expect([m.displayWidth, m.displayHeight]).toEqual([3000, 4000]);
  });

  it('3 = 180°，尺寸不变', () => {
    const m = orientationToBox(natural, 3);
    expect(m.rotation).toBe(180);
    expect([m.displayWidth, m.displayHeight]).toEqual([4000, 3000]);
  });

  it('2 / 4 = 纯镜像，尺寸不变', () => {
    expect(orientationToBox(natural, 2)).toMatchObject({ flipH: true, flipV: false, rotation: 0 });
    expect(orientationToBox(natural, 4)).toMatchObject({ flipH: false, flipV: true, rotation: 0 });
  });

  it('5 / 7 = 镜像 + 旋转，尺寸互换', () => {
    expect(orientationToBox(natural, 5)).toMatchObject({ flipH: true, rotation: 270 });
    expect(orientationToBox(natural, 7)).toMatchObject({ flipH: true, rotation: 90 });
    expect(orientationToBox(natural, 7).displayWidth).toBe(3000);
  });

  it('非法/未知值按 1 处理（不转，安全默认）', () => {
    for (const o of [0, 9, -1, 99]) {
      expect(orientationToBox(natural, o)).toMatchObject({ rotation: 0, flipH: false, flipV: false });
    }
  });
});

describe('createOrientedImageLayer', () => {
  it('orientation 6：定界框铺满"转正后"的画布', () => {
    const canvas = createCanvas(3000, 4000); // 竖版
    const l = createOrientedImageLayer({
      id: 'L1',
      source: 'C:/a.jpg',
      naturalWidth: 4000, // 存储是横版
      naturalHeight: 3000,
      orientation: 6,
      canvas,
    });

    // 内容尺寸不变，只是转了 90°——交换 w/h 会让内容被拉伸
    expect(l.box.w).toBe(4000);
    expect(l.box.h).toBe(3000);
    expect(l.box.rotation).toBe(90);

    const aabb = layerAABB(l.box);
    expect(aabb.l).toBeCloseTo(0);
    expect(aabb.t).toBeCloseTo(0);
    expect(aabb.width).toBeCloseTo(3000);
    expect(aabb.height).toBeCloseTo(4000);
  });

  it('orientation 1：与 createImageLayer 结果一致', () => {
    const canvas = createCanvas(800, 600);
    const a = createOrientedImageLayer({
      id: 'L1',
      naturalWidth: 1600,
      naturalHeight: 1200,
      orientation: 1,
      canvas,
    });
    const b = createImageLayer({
      id: 'L1',
      naturalWidth: 1600,
      naturalHeight: 1200,
      canvas,
    });
    expect(a.box).toEqual(b.box);
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

/**
 * 图层面板的列表操作。
 *
 * 这一组盯的是**顺序**与**活动层落点**——两者错了都不会报错，只会表现为
 * "点了删除结果选中了别的层""上移变成了下移"这类只能靠人肉发现的怪行为。
 */
describe('图层面板的列表操作', () => {
  const ids = (ls: EditorLayer[]) => ls.map(l => l.id);
  const three = () => [layer({ id: 'A' }), layer({ id: 'B' }), layer({ id: 'C' })];

  it('layersTopDown 自顶向下，且不改入参', () => {
    const all = three();
    expect(ids(layersTopDown(all))).toEqual(['C', 'B', 'A']);
    expect(ids(all)).toEqual(['A', 'B', 'C']);
  });

  it('setLayerVisible 切可见性；值没变时返回原引用', () => {
    const all = three();
    const next = setLayerVisible(all, 'B', false);
    expect(next[1].visible).toBe(false);
    expect(all[1].visible).toBe(true); // 入参没被改
    expect(setLayerVisible(next, 'B', false)).toBe(next); // 无变化 ⇒ 同引用（不置 dirty）
    expect(setLayerVisible(all, 'zzz', false)).toBe(all);
  });

  it('removeLayer 删非活动层，活动层不变', () => {
    const r = removeLayer(three(), 'A', 'C');
    expect(ids(r.layers)).toEqual(['B', 'C']);
    expect(r.activeLayerId).toBe('C');
  });

  it('removeLayer 删的正是活动层时，落到它下面那层', () => {
    // PS 的口径：删掉 C 之后选中 B（原来被 C 挡着的那层），而不是 A
    const r = removeLayer(three(), 'C', 'C');
    expect(ids(r.layers)).toEqual(['A', 'B']);
    expect(r.activeLayerId).toBe('B');
  });

  it('removeLayer 删最底层的活动层时往上找', () => {
    expect(removeLayer(three(), 'A', 'A').activeLayerId).toBe('B');
  });

  it('removeLayer 删空后活动层为 undefined', () => {
    const r = removeLayer([layer({ id: 'A' })], 'A', 'A');
    expect(r.layers).toEqual([]);
    expect(r.activeLayerId).toBeUndefined();
  });

  it('removeLayer 找不到时原样返回', () => {
    const all = three();
    const r = removeLayer(all, 'zzz', 'A');
    expect(r.layers).toBe(all);
    expect(r.activeLayerId).toBe('A');
  });

  it('duplicateLayer 插在原层上方，并深拷贝 box', () => {
    const all = three();
    const r = duplicateLayer(all, 'B', 'B2');
    expect(ids(r.layers)).toEqual(['A', 'B', 'B2', 'C']);
    expect(r.newLayerId).toBe('B2');
    expect(r.layers[1].name).toBe('photo');
    expect(r.layers[2].name).toBe('photo 副本');
    // 浅拷贝会让拖动副本时把原件一起拖走
    expect(r.layers[2].box).not.toBe(r.layers[1].box);
    // 不透明度也跟着复制（`...src` 浅拷贝会带上，这条是防止有人改成逐字段重建时漏掉）
    expect(duplicateLayer([layer({ id: 'B', opacity: 40 })], 'B', 'B2').layers[1].opacity).toBe(40);
  });

  it('duplicateLayer 找不到原层时什么也不做', () => {
    const all = three();
    const r = duplicateLayer(all, 'zzz', 'X');
    expect(r.layers).toBe(all);
    expect(r.newLayerId).toBeUndefined();
  });

  /**
   * 拖拽排序。`position` 是**显示口径**（above = 盖住目标），而数组是自底向上，
   * 所以这里每一条都在验"显示上看到的结果"和"数组里真正落的位置"是否一致：
   * 数组 [A,B,C] 显示出来是 C / B / A。
   */
  it('reorderLayers 把底层拖到顶上 = 数组末尾', () => {
    const next = reorderLayers(three(), 'A', 'C', 'above');
    expect(ids(next)).toEqual(['B', 'C', 'A']);
    expect(ids(layersTopDown(next))).toEqual(['A', 'C', 'B']); // 显示：A 在最上
  });

  it('reorderLayers 把顶层拖到底下 = 数组开头', () => {
    const next = reorderLayers(three(), 'C', 'A', 'below');
    expect(ids(next)).toEqual(['C', 'A', 'B']);
    expect(ids(layersTopDown(next))).toEqual(['B', 'A', 'C']); // 显示：C 在最下
  });

  it('reorderLayers 中间层插到目标上方/下方', () => {
    expect(ids(reorderLayers(three(), 'B', 'C', 'above'))).toEqual(['A', 'C', 'B']);
    expect(ids(reorderLayers(three(), 'B', 'A', 'below'))).toEqual(['B', 'A', 'C']);
  });

  it('reorderLayers 放回原位 / 拖到自己身上时返回原引用（不置 dirty）', () => {
    const all = three();
    // C 本来就在 B 上方，再拖到 B 上方 = 没动
    expect(reorderLayers(all, 'C', 'B', 'above')).toBe(all);
    expect(reorderLayers(all, 'B', 'B', 'above')).toBe(all);
    expect(reorderLayers(all, 'zzz', 'A', 'above')).toBe(all);
    expect(reorderLayers(all, 'A', 'zzz', 'below')).toBe(all);
  });

  it('reorderLayers 不改入参', () => {
    const all = three();
    reorderLayers(all, 'A', 'C', 'above');
    expect(ids(all)).toEqual(['A', 'B', 'C']);
  });

  it('createLayerId 同毫秒内也不会撞（连点两次复制不会串层）', () => {
    expect(createLayerId()).not.toBe(createLayerId());
  });

  /**
   * 图层操作要能被撤销：`visible`、`opacity` 与数组顺序都必须进签名。
   * 反过来，**只换选中层不进签名**——否则"点一下图层"就会灌一条撤销历史。
   */
  it('可见性/顺序进撤销签名，选区不进', () => {
    const base = {
      name: 'd',
      dirty: false,
      version: 2 as const,
      canvas: createCanvas(100, 100),
      layers: three(),
    } as EditorDocument;

    expect(documentStateSignature({ ...base, layers: setLayerVisible(three(), 'B', false) })).not.toBe(
      documentStateSignature(base),
    );
    expect(
      documentStateSignature({ ...base, layers: reorderLayers(three(), 'A', 'C', 'above') }),
    ).not.toBe(documentStateSignature(base));
    expect(documentStateSignature({ ...base, activeLayerId: 'A' })).toBe(
      documentStateSignature(base),
    );
  });
});

/**
 * 不透明度（2026-10-24 加）。
 *
 * 这一组盯的是**两个签名各收什么**：状态签名要能看见它（改了就进撤销栈），
 * 几何签名要看不见它（只拖滑杆要合并成一步，否则拖一次灌上百条历史）。
 */
describe('图层不透明度', () => {
  it('layerOpacity 缺省 100，脏数据一律落回 100', () => {
    expect(layerOpacity(layer())).toBe(100);
    expect(layerOpacity(layer({ opacity: 40 }))).toBe(40);
    expect(layerOpacity(layer({ opacity: -5 }))).toBe(0);
    expect(layerOpacity(layer({ opacity: 250 }))).toBe(100);
    expect(layerOpacity(layer({ opacity: Number.NaN }))).toBe(100);
    expect(layerOpacity(layer({ opacity: 39.6 }))).toBe(40); // 取整
  });

  it('setLayerOpacity 钳位、无变化返回原引用、回到 100 时删字段', () => {
    const all = [layer({ id: 'A' }), layer({ id: 'B' })];

    const half = setLayerOpacity(all, 'A', 50);
    expect(half[0].opacity).toBe(50);
    expect(all[0].opacity).toBeUndefined(); // 入参没被改
    expect(setLayerOpacity(half, 'A', 50)).toBe(half); // 无变化 ⇒ 同引用（不置 dirty）

    const back = setLayerOpacity(half, 'A', 100);
    expect('opacity' in back[0]).toBe(false); // 文档保持干净
    expect(setLayerOpacity(all, 'zzz', 30)).toBe(all);
  });

  it('进状态签名（能撤销），不进几何签名（拖滑杆合并一步）', () => {
    const a = layer();
    const b = layer({ opacity: 50 });
    expect(layerStateSignature(a)).not.toBe(layerStateSignature(b));
    expect(layerGeometrySignature(a)).toBe(layerGeometrySignature(b));

    const base = { name: 'd', dirty: false, version: 2 as const, canvas: createCanvas(100, 100) };
    expect(documentStateSignature({ ...base, layers: [a] } as EditorDocument)).not.toBe(
      documentStateSignature({ ...base, layers: [b] } as EditorDocument),
    );
  });
});

/**
 * 混合模式（2026-10-24 加）。
 *
 * 名字是**两端共用的一份字符串**（CSS `mix-blend-mode` 同名），所以这里的重点不是公式，
 * 而是"读/写/签名"：脏数据落 normal、回 normal 删字段、改了要能撤销。
 */
describe('图层混合模式', () => {
  it('layerBlend 缺省与脏数据一律落 normal', () => {
    expect(layerBlend(layer())).toBe('normal');
    expect(layerBlend(layer({ blend: 'multiply' }))).toBe('multiply');
    expect(layerBlend(layer({ blend: 'hue' }))).toBe('normal'); // 非可分离，这轮不做
    expect(layerBlend(layer({ blend: 42 as unknown as string }))).toBe('normal');
  });

  it('setLayerBlend 切模式；回 normal 时删字段；无变化返回原引用', () => {
    const all = [layer({ id: 'A' }), layer({ id: 'B' })];

    const next = setLayerBlend(all, 'A', 'multiply');
    expect(next[0].blend).toBe('multiply');
    expect(all[0].blend).toBeUndefined(); // 入参没被改
    expect(setLayerBlend(next, 'A', 'multiply')).toBe(next);

    const back = setLayerBlend(next, 'A', 'normal');
    expect('blend' in back[0]).toBe(false); // 文档保持干净
    expect(setLayerBlend(all, 'zzz', 'screen')).toBe(all);
  });

  it('进状态签名（改混合模式能撤销）', () => {
    const a = layer();
    const b = layer({ blend: 'multiply' });
    expect(layerStateSignature(a)).not.toBe(layerStateSignature(b));
  });

  it('复制图层会带上混合模式', () => {
    const r = duplicateLayer([layer({ id: 'B', blend: 'screen' })], 'B', 'B2');
    expect(r.layers[1].blend).toBe('screen');
  });
});

