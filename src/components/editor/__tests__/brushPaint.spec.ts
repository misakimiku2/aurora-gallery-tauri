/**
 * 画笔纯函数面的单测：图章几何（间距/封口/前缀稳定）、颜色亮度（与 Rust mask 的
 * sRGB 系数锁死）、作画目标坐标变换（三种 target 与渲染侧同一套数学）。
 * canvas 绘制本体在 useEditorBrush（jsdom 无 canvas），走手测清单。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLayer, LayerBox } from '../../../types';
import { createIdentityBox } from '../layerModel';
import {
  BRUSH_SPACING_RATIO,
  brushSizeStep,
  colorLuminance,
  luminanceToHex,
  nextBrushSize,
  paintTargetOf,
  strokeDirtyRect,
  strokeStamps,
} from '../brushPaint';
import { applyMatrix, composeMatrix, invertAffine } from '../layerTransform';

const box = (over: Partial<LayerBox> = {}): LayerBox => ({
  ...createIdentityBox(200, 100),
  ...over,
});

const layerWith = (over: Partial<EditorLayer> = {}): EditorLayer => ({
  id: 'L1',
  name: '测试层',
  source: 'C:/img/a.png',
  naturalWidth: 200,
  naturalHeight: 100,
  box: box(),
  visible: true,
  ...over,
});

describe('strokeStamps（图章序列）', () => {
  it('空轨迹无图章；单点一个图章', () => {
    expect(strokeStamps([], 40)).toEqual([]);
    expect(strokeStamps([{ x: 5, y: 5 }], 40)).toEqual([{ x: 5, y: 5 }]);
  });

  it('间距 = 笔径 × 25%：40 笔径画 100px 直线 → 0,10,…,100 共 11 个图章', () => {
    expect(BRUSH_SPACING_RATIO).toBe(0.25);
    const stamps = strokeStamps([{ x: 0, y: 0 }, { x: 100, y: 0 }], 40);
    expect(stamps).toHaveLength(11);
    expect(stamps[0].x).toBeCloseTo(0);
    expect(stamps[10].x).toBeCloseTo(100); // 100 恰是 10 的倍数：落在等距序列里
    stamps.forEach((s, i) => {
      expect(s.x).toBeCloseTo(i * 10, 6);
      expect(s.y).toBe(0);
    });
  });

  it('绘制期间（final=false）不含强制终点；抬笔（final=true）补终点封口', () => {
    const pts = [{ x: 0, y: 0 }, { x: 95, y: 0 }];
    const live = strokeStamps(pts, 40); // 间距 10：0..90 共 10 个，95 不在其中
    expect(live).toHaveLength(10);
    expect(live[live.length - 1].x).toBeCloseTo(90);
    const final = strokeStamps(pts, 40, true);
    expect(final).toHaveLength(11);
    expect(final[10].x).toBeCloseTo(95);
  });

  it('前缀稳定（增量绘制只画尾巴的判据）：轨迹延长后，已有图章原样保留', () => {
    const short = strokeStamps([{ x: 0, y: 0 }, { x: 50, y: 0 }], 40);
    const long = strokeStamps(
      [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 30 }, { x: 120, y: 30 }],
      40,
    );
    expect(long.length).toBeGreaterThan(short.length);
    short.forEach((s, i) => {
      expect(long[i].x).toBeCloseTo(s.x, 9);
      expect(long[i].y).toBeCloseTo(s.y, 9);
    });
  });

  it('折线按弧长计距（拐角不重置、也不跳过）', () => {
    // L 形：横 30 + 竖 40 = 70 弧长，间距 10 → 0,10,…,70 共 8 个（70 落在终点上）
    const stamps = strokeStamps(
      [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }],
      40,
    );
    expect(stamps).toHaveLength(8);
    expect(stamps[3]).toMatchObject({ x: 30, y: 0 }); // 30 弧长处 = 拐点
    expect(stamps[4].x).toBeCloseTo(30);
    expect(stamps[4].y).toBeCloseTo(10);
  });

  it('笔径过小时间距钳到 1px（size 2 → 间距 0.5 → 1）', () => {
    const stamps = strokeStamps([{ x: 0, y: 0 }, { x: 5, y: 0 }], 2);
    expect(stamps.length).toBeGreaterThanOrEqual(6); // 0..5 每整像素一个
    expect(stamps[1].x).toBeCloseTo(1);
  });
});

describe('colorLuminance / luminanceToHex（蒙版灰度，与 Rust sRGB 系数锁死）', () => {
  it('黑白端点与三原色黄金值（0.2126/0.7152/0.0722 × 255 四舍五入）', () => {
    expect(colorLuminance('#ffffff')).toBe(255);
    expect(colorLuminance('#000000')).toBe(0);
    expect(colorLuminance('#ff0000')).toBe(54); // 54.21 → 54
    expect(colorLuminance('#00ff00')).toBe(182); // 182.38 → 182
    expect(colorLuminance('#0000ff')).toBe(18); // 18.41 → 18
  });

  it('带不带 #、大小写都认；非法输入按白（宁可全显示不弄没图层）', () => {
    expect(colorLuminance('FF00FF')).toBe(colorLuminance('#ff00ff'));
    expect(colorLuminance('not-a-color')).toBe(255);
  });

  it('luminanceToHex 出等值灰，超界钳位', () => {
    expect(luminanceToHex(182)).toBe('#b6b6b6');
    expect(luminanceToHex(300)).toBe('#ffffff');
    expect(luminanceToHex(-5)).toBe('#000000');
    expect(colorLuminance(luminanceToHex(96))).toBe(96);
  });
});

describe('paintTargetOf（作画目标坐标变换）', () => {
  const mLayerOf = (l: EditorLayer) =>
    composeMatrix(l.box, { width: l.naturalWidth, height: l.naturalHeight });

  it('图层本体：transform = inv(M_layer)，四角换算回文档坐标与图层矩阵重合', () => {
    const layer = layerWith({ box: box({ x: 10, y: 20, w: 400, h: 200, rotation: 30 }) });
    const target = paintTargetOf(layer, 'image');
    expect(target?.kind).toBe('layer');
    expect(target?.width).toBe(200);
    expect(target?.height).toBe(100);
    expect(target?.transform).toEqual(invertAffine(mLayerOf(layer)));
    // 语义检验：缓冲四角经 bufferToDoc（= inv(target.transform) = M_layer）落回图层内容四角
    const toDoc = invertAffine(target!.transform)!;
    const c = applyMatrix(toDoc, 0, 0);
    expect(c.x).toBeCloseTo(applyMatrix(mLayerOf(layer), 0, 0).x, 6);
  });

  it('链接蒙版：蒙版像素格 = 图层内容格按（蒙版自然/图层自然）缩放——四角重合', () => {
    const layer = layerWith({
      box: box({ x: 5, y: 5, w: 400, h: 200, rotation: 15 }),
      mask: { source: 'm.png', naturalWidth: 60, naturalHeight: 40 }, // 非等比 0.3/0.4
    });
    const target = paintTargetOf(layer, 'mask');
    expect(target?.kind).toBe('mask');
    expect(target?.width).toBe(60);
    expect(target?.height).toBe(40);
    const m = mLayerOf(layer);
    const corners: Array<[number, number, number, number]> = [
      [0, 0, 0, 0],
      [200, 0, 60, 0],
      [200, 100, 60, 40],
      [0, 100, 0, 40],
    ];
    for (const [lx, ly, mx, my] of corners) {
      const doc = applyMatrix(m, lx, ly);
      const px = applyMatrix(target!.transform, doc.x, doc.y);
      expect(px.x).toBeCloseTo(mx, 6);
      expect(px.y).toBeCloseTo(my, 6);
    }
  });

  it('解链蒙版：transform = inv(M_mask)', () => {
    const layer = layerWith({
      mask: { source: 'm.png', naturalWidth: 60, naturalHeight: 40, box: box({ x: 8, y: 9, w: 120, h: 80, rotation: 20 }) },
    });
    const target = paintTargetOf(layer, 'mask');
    expect(target?.transform).toEqual(
      invertAffine(composeMatrix(box({ x: 8, y: 9, w: 120, h: 80, rotation: 20 }), { width: 60, height: 40 })),
    );
  });

  it('画不进去的 target → null：无 source（组行）/无蒙版/蒙版停用', () => {
    expect(paintTargetOf(layerWith({ kind: 'group', source: undefined }), 'image')).toBeNull();
    expect(paintTargetOf(layerWith(), 'mask')).toBeNull();
    expect(
      paintTargetOf(layerWith({ mask: { source: 'm.png', naturalWidth: 8, naturalHeight: 4, disabled: true } }), 'mask'),
    ).toBeNull();
  });
});

describe('strokeDirtyRect（撤销补丁的脏矩形）', () => {
  const I: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  it('恒等变换：外接框 = 图章范围 ± (半径+1)，整数化并含闭区间端点', () => {
    const rect = strokeDirtyRect(
      [{ x: 10, y: 10 }, { x: 50, y: 10 }],
      5, // pad = 6
      I,
      100,
      100,
    );
    expect(rect).toEqual({ x: 4, y: 4, w: 53, h: 13 }); // 4..56 → w = 56-4+1
  });

  it('贴边与越界都夹进缓冲范围（负坐标不产生负宽高）', () => {
    const rect = strokeDirtyRect([{ x: 2, y: 2 }], 5, I, 100, 100);
    expect(rect).toEqual({ x: 0, y: 0, w: 9, h: 9 }); // 2+6 = 8 → 0..8
    const far = strokeDirtyRect([{ x: 300, y: 300 }], 5, I, 100, 100);
    expect(far).toBeNull(); // 整笔都在缓冲外
    expect(strokeDirtyRect([], 5, I, 100, 100)).toBeNull();
  });

  it('带旋转的变换：映射后的外接框包住变换后的图章区（角点法）', () => {
    // 文档 → 缓冲：绕原点转 90°再平移 100（图层旋转 90° 时 target.transform 的形状）
    const rot: [number, number, number, number, number, number] = [0, 1, -1, 0, 100, 0];
    // 文档 (10,10) 半径 5 的图章 → 缓冲中心 (100-10, 10) = (90,10)，pad 6 → x∈[84,96] y∈[4,16]
    const rect = strokeDirtyRect([{ x: 10, y: 10 }], 5, rot, 200, 200);
    expect(rect).toEqual({ x: 84, y: 4, w: 13, h: 13 });
  });

  it('映射后只有一角擦到缓冲 → 仍给出夹过的非空矩形', () => {
    const shift: [number, number, number, number, number, number] = [1, 0, 0, 1, 95, 0];
    const rect = strokeDirtyRect([{ x: 0, y: 50 }], 5, shift, 100, 100);
    // 缓冲 x ∈ [89,101] → 夹到 89..99；y ∈ [44,56]
    expect(rect).toEqual({ x: 89, y: 44, w: 11, h: 13 });
  });
});

describe('brushSizeStep / nextBrushSize（[ ] 调笔径，PS 分段步进）', () => {
  it('分段步长：≤10 ±1，≤50 ±5，再往上 ±10', () => {
    expect(brushSizeStep(1)).toBe(1);
    expect(brushSizeStep(10)).toBe(1);
    expect(brushSizeStep(11)).toBe(5);
    expect(brushSizeStep(50)).toBe(5);
    expect(brushSizeStep(51)).toBe(10);
    expect(brushSizeStep(300)).toBe(10);
  });

  it('步进并钳在 1..300（与选项条的滑杆同范围）', () => {
    expect(nextBrushSize(30, 1)).toBe(35);
    expect(nextBrushSize(35, -1)).toBe(30);
    expect(nextBrushSize(8, -1)).toBe(7);
    expect(nextBrushSize(1, -1)).toBe(1); // 下限不穿
    expect(nextBrushSize(295, 1)).toBe(300);
    expect(nextBrushSize(300, 1)).toBe(300); // 上限不穿
  });
});
