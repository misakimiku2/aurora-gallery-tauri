/**
 * 定界框 ↔ 仿射矩阵的单测。
 *
 * 三组黄金值把"两端共用同一组六参"锁死（设计稿 §3.1）；另有两组**交叉验证**——
 * 画布旋转/翻转在"图层铺满画布"这一特例下的结果，必须与 v1 的 `rotateCropRect` /
 * `flipCropRect` 逐项相等。旧实现因此成为新实现的黄金标准，迁移不是"重写 + 希望没写错"。
 */
import { describe, expect, it } from 'vitest';
import type { LayerBox } from '../../../types';
import { flipCropRect, rotateCropRect } from '../cropGeometry';
import {
  applyMatrix,
  composeMatrix,
  flipDocumentCanvas,
  layerAABB,
  normalizeDegrees,
  rotateDocumentCanvas,
  toCssMatrix,
} from '../layerTransform';

const box = (over: Partial<LayerBox> = {}): LayerBox => ({
  x: 0,
  y: 0,
  w: 100,
  h: 100,
  rotation: 0,
  flipH: false,
  flipV: false,
  skewX: 0,
  skewY: 0,
  ...over,
});

describe('composeMatrix 黄金值', () => {
  it('未变换 = 恒等 + 平移', () => {
    // 内容与框 1:1 且放在 (10,20)
    expect(composeMatrix(box({ x: 10, y: 20, w: 200, h: 100 }), { width: 200, height: 100 })).toEqual([
      1, 0, 0, 1, 10, 20,
    ]);
  });

  it('旋转 90°：线性部分 [0,1,-1,0]，左上角落到 (100,0)', () => {
    const m = composeMatrix(box({ rotation: 90 }), { width: 100, height: 100 });
    expect(m[0]).toBeCloseTo(0);
    expect(m[1]).toBeCloseTo(1);
    expect(m[2]).toBeCloseTo(-1);
    expect(m[3]).toBeCloseTo(0);
    expect(m[4]).toBeCloseTo(100);
    expect(m[5]).toBeCloseTo(0);
  });

  it('旋转 90° 后内容左上角确实转到右上角', () => {
    const m = composeMatrix(box({ rotation: 90 }), { width: 100, height: 100 });
    const p = applyMatrix(m, 0, 0);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(0);
    // 绕定界框中心 (50,50) 顺时针 90°：(0,0) 的相对坐标 (-50,-50) → (50,-50) → 绝对 (100,0)
  });

  it('水平翻转：框内镜像，内容左右边界互换', () => {
    const m = composeMatrix(box({ flipH: true }), { width: 100, height: 100 });
    expect(m[0]).toBeCloseTo(-1);
    expect(m[3]).toBeCloseTo(1);
    expect(applyMatrix(m, 0, 0).x).toBeCloseTo(100);
    expect(applyMatrix(m, 100, 0).x).toBeCloseTo(0);
  });

  it('缩放：内容被拉到定界框尺寸', () => {
    const m = composeMatrix(box({ w: 400, h: 200 }), { width: 100, height: 100 });
    expect(m[0]).toBeCloseTo(4);
    expect(m[3]).toBeCloseTo(2);
    expect(applyMatrix(m, 100, 100)).toEqual({ x: 400, y: 200 });
  });

  it('toCssMatrix 的顺序与 CSS 一致', () => {
    expect(toCssMatrix([1, 0, 0, 1, 5, 6])).toBe('matrix(1, 0, 0, 1, 5, 6)');
  });
});

describe('rotateDocumentCanvas（画布级 90° 旋转）', () => {
  const canvas = { width: 200, height: 100 };

  it('画布宽高互换', () => {
    const out = rotateDocumentCanvas(canvas, [], true);
    expect(out.canvas).toEqual({ width: 100, height: 200 });
  });

  it('顺时针结果与 v1 rotateCropRect 逐项相等（交叉验证）', () => {
    const rect = { x: 5, y: 7, w: 30, h: 20 };
    const legacy = rotateCropRect(rect, canvas.width, canvas.height, true);
    const out = rotateDocumentCanvas(canvas, [box(rect)], true);

    expect(out.layers[0]).toMatchObject({
      x: legacy.x,
      y: legacy.y,
      w: legacy.w,
      h: legacy.h,
    });
  });

  it('逆时针结果与 v1 rotateCropRect 逐项相等（交叉验证）', () => {
    const rect = { x: 5, y: 7, w: 30, h: 20 };
    const legacy = rotateCropRect(rect, canvas.width, canvas.height, false);
    const out = rotateDocumentCanvas(canvas, [box(rect)], false);

    expect(out.layers[0]).toMatchObject({
      x: legacy.x,
      y: legacy.y,
      w: legacy.w,
      h: legacy.h,
    });
  });

  it('铺满画布的图层转完之后仍然铺满（画布也换了尺寸）', () => {
    const out = rotateDocumentCanvas(canvas, [box({ w: 200, h: 100 })], true);
    expect(out.canvas).toEqual({ width: 100, height: 200 });
    expect(out.layers[0]).toMatchObject({ x: 0, y: 0, w: 100, h: 200 });
  });

  it('来回转四次回到原样', () => {
    const start = box({ x: 13, y: 29, w: 40, h: 60, rotation: 17 });
    let state = { canvas, layers: [start] };
    for (let i = 0; i < 4; i += 1) state = rotateDocumentCanvas(state.canvas, state.layers, true);

    expect(state.canvas).toEqual(canvas);
    expect(state.layers[0].x).toBeCloseTo(start.x);
    expect(state.layers[0].y).toBeCloseTo(start.y);
    expect(state.layers[0].w).toBeCloseTo(start.w);
    expect(state.layers[0].rotation).toBeCloseTo(start.rotation);
  });
});

describe('flipDocumentCanvas（画布级翻转）', () => {
  const canvas = { width: 200, height: 100 };

  it('结果与 v1 flipCropRect 逐项相等（交叉验证）', () => {
    const rect = { x: 5, y: 7, w: 30, h: 20 };
    const legacy = flipCropRect(rect, canvas.width, canvas.height, true, false);
    const out = flipDocumentCanvas(canvas, [box(rect)], true, false);

    expect(out.layers[0]).toMatchObject({ x: legacy.x, y: legacy.y, w: legacy.w, h: legacy.h });
  });

  it('画布尺寸不变，角度取反', () => {
    const out = flipDocumentCanvas(canvas, [box({ rotation: 30 })], true, false);
    expect(out.canvas).toEqual(canvas);
    expect(out.layers[0].rotation).toBe(330);
  });

  it('翻两次回到原样', () => {
    const start = box({ x: 13, y: 29, w: 40, h: 60, rotation: 30 });
    const once = flipDocumentCanvas(canvas, [start], true, false);
    const twice = flipDocumentCanvas(once.canvas, once.layers, true, false);
    expect(twice.layers[0]).toMatchObject({
      x: start.x,
      y: start.y,
      rotation: start.rotation,
    });
  });
});

describe('layerAABB', () => {
  it('未旋转时就是定界框本身', () => {
    const a = layerAABB(box({ x: 10, y: 20, w: 30, h: 40 }));
    expect(a).toMatchObject({ l: 10, t: 20, r: 40, b: 60, cx: 25, cy: 40 });
  });

  it('旋转 45° 的正方形包围盒放大到 √2 倍', () => {
    const a = layerAABB(box({ w: 100, h: 100, rotation: 45 }));
    expect(a.width).toBeCloseTo(100 * Math.SQRT2);
    expect(a.cx).toBeCloseTo(50);
    expect(a.cy).toBeCloseTo(50);
  });
});

describe('normalizeDegrees', () => {
  it('负角与超圈都归一到 [0,360)', () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(450)).toBe(90);
    expect(normalizeDegrees(720)).toBe(0);
  });
});
