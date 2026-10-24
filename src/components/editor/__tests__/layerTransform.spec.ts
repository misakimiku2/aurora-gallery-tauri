/**
 * 定界框 ↔ 仿射矩阵的单测。
 *
 * 三组黄金值把"两端共用同一组六参"锁死（设计稿 §3.1）；另有两组**交叉验证**——
 * 画布旋转/翻转在"图层铺满画布"这一特例下的结果，必须与 v1 的 `rotateCropRect` /
 * `flipCropRect` 逐项相等。旧实现因此成为新实现的黄金标准，迁移不是"重写 + 希望没写错"。
 */
import { describe, expect, it } from 'vitest';
import type { EditorLayer, LayerBox } from '../../../types';
import { flipCropRect, rotateCropRect } from '../cropGeometry';
import {
  applyMatrix,
  composeMatrix,
  flipDocumentCanvas,
  invertAffine,
  layerAABB,
  maskShellSpec,
  multiplyAffine,
  normalizeDegrees,
  pointInBox,
  rotateDocumentCanvas,
  toCssMatrix,
  type AffineMatrix,
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

  it('顺时针：图层包围盒与 v1 rotateCropRect 逐项相等（交叉验证）', () => {
    const rect = { x: 5, y: 7, w: 30, h: 20 };
    const legacy = rotateCropRect(rect, canvas.width, canvas.height, true);
    const out = rotateDocumentCanvas(canvas, [box(rect)], true);

    // v1 的 crop 是**轴对齐矩形**，正好等于"定界框旋转后的包围盒"
    const aabb = layerAABB(out.layers[0]);
    expect(aabb.l).toBeCloseTo(legacy.x);
    expect(aabb.t).toBeCloseTo(legacy.y);
    expect(aabb.width).toBeCloseTo(legacy.w);
    expect(aabb.height).toBeCloseTo(legacy.h);
  });

  it('逆时针：图层包围盒与 v1 rotateCropRect 逐项相等（交叉验证）', () => {
    const rect = { x: 5, y: 7, w: 30, h: 20 };
    const legacy = rotateCropRect(rect, canvas.width, canvas.height, false);
    const out = rotateDocumentCanvas(canvas, [box(rect)], false);

    const aabb = layerAABB(out.layers[0]);
    expect(aabb.l).toBeCloseTo(legacy.x);
    expect(aabb.t).toBeCloseTo(legacy.y);
    expect(aabb.width).toBeCloseTo(legacy.w);
    expect(aabb.height).toBeCloseTo(legacy.h);
  });

  it('**不交换 w/h**：内容尺寸不变，只加角度（交换会让内容被拉伸）', () => {
    const src = box({ x: 5, y: 7, w: 30, h: 20 });
    const out = rotateDocumentCanvas(canvas, [src], true).layers[0];
    expect(out.w).toBe(30);
    expect(out.h).toBe(20);
    expect(out.rotation).toBe(90);
  });

  it('铺满画布的图层转完之后包围盒仍然铺满（画布也换了尺寸）', () => {
    const out = rotateDocumentCanvas(canvas, [box({ w: 200, h: 100 })], true);
    expect(out.canvas).toEqual({ width: 100, height: 200 });
    const aabb = layerAABB(out.layers[0]);
    expect(aabb.l).toBeCloseTo(0);
    expect(aabb.t).toBeCloseTo(0);
    expect(aabb.width).toBeCloseTo(100);
    expect(aabb.height).toBeCloseTo(200);
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

describe('pointInBox（移动工具选中判定）', () => {
  it('未旋转：框内 true、框外 false', () => {
    const b = box({ x: 0, y: 0, w: 100, h: 100 });
    expect(pointInBox(b, 50, 50)).toBe(true);
    expect(pointInBox(b, 0, 0)).toBe(true);
    expect(pointInBox(b, 150, 50)).toBe(false);
    expect(pointInBox(b, 50, 150)).toBe(false);
  });

  it('旋转 45° 后按**本地坐标**判定，不是按包围盒', () => {
    const b = box({ x: 0, y: 0, w: 100, h: 100, rotation: 45 });
    // 中心右侧 60px：落在旋转后的菱形里（本地坐标 ±42.4），但已在原矩形的 x 范围外
    expect(pointInBox(b, 110, 50)).toBe(true);
    // 再远就出去了（本地 56.6 > 50）
    expect(pointInBox(b, 130, 50)).toBe(false);
  });

  it('落在包围盒但不在框内 → false（这正是"看起来在图上却点不中"的坑）', () => {
    const b = box({ x: 0, y: 0, w: 100, h: 100, rotation: 45 });
    // 左上角的外接方形顶点在旋转后是空的
    expect(pointInBox(b, 1, 1)).toBe(false);
  });
});

describe('normalizeDegrees', () => {
  it('负角与超圈都归一到 [0,360)', () => {
    expect(normalizeDegrees(-90)).toBe(270);
    expect(normalizeDegrees(450)).toBe(90);
    expect(normalizeDegrees(720)).toBe(0);
  });
});

describe('multiplyAffine / invertAffine（蒙版解链与剪贴蒙版的坐标换算）', () => {
  const M: AffineMatrix = [1.5, 0.2, -0.3, 0.9, 7.0, -4.0];
  const N: AffineMatrix = [0.8, -0.1, 0.4, 1.2, 3.0, 5.0];

  /** 依次作用两个矩阵（先 first 后 second），返回结果点 */
  const viaTwo = (first: AffineMatrix, second: AffineMatrix, x: number, y: number) => {
    const mid = applyMatrix(second, x, y);
    return applyMatrix(first, mid.x, mid.y);
  };

  it('复合语义 = 先 inner 后 outer（与 CSS 嵌套一致），逐点等价于两次 applyMatrix', () => {
    const composed = multiplyAffine(M, N);
    const twice = viaTwo(M, N, 13.7, 42.1);
    const once = applyMatrix(composed, 13.7, 42.1);
    expect(once.x).toBeCloseTo(twice.x, 9);
    expect(once.y).toBeCloseTo(twice.y, 9);
  });

  it('乘以逆 = 恒等（平移/缩放/旋转组合）', () => {
    const inv = invertAffine(M);
    expect(inv).not.toBeNull();
    const round = multiplyAffine(M, inv as AffineMatrix);
    // 恒等 = [1, 0, 0, 1, 0, 0]：只有 a/d 是 1，b/c/e/f 全 0
    const identity = [1, 0, 0, 1, 0, 0];
    for (let i = 0; i < 6; i += 1) {
      expect(round[i]).toBeCloseTo(identity[i], 9);
    }
  });

  it('invertAffine 对 composeMatrix 的产物可逆；退化矩阵返回 null', () => {
    const m = composeMatrix(box({ x: 12, y: -5, w: 220, h: 90, rotation: 37, flipH: true }), {
      width: 400,
      height: 300,
    });
    const inv = invertAffine(m);
    expect(inv).not.toBeNull();
    // 映射再逆映射回到原点
    const mapped = applyMatrix(m, 55.5, -3.25);
    const back = applyMatrix(inv as AffineMatrix, mapped.x, mapped.y);
    expect(back.x).toBeCloseTo(55.5, 6);
    expect(back.y).toBeCloseTo(-3.25, 6);

    expect(invertAffine([1, 2, 2, 4, 0, 0])).toBeNull(); // 行列式 0
  });

  it('嵌套换算：容器带 M_outer，想要画布空间 M_child ⇒ 给子元素 inv(M_outer)·M_child', () => {
    const outer = composeMatrix(box({ x: 10, y: 20, w: 300, h: 150, rotation: 30 }), {
      width: 600,
      height: 300,
    });
    const child = composeMatrix(box({ x: -40, y: 5, w: 200, h: 100, rotation: 90, flipV: true }), {
      width: 200,
      height: 100,
    });
    const local = multiplyAffine(invertAffine(outer) as AffineMatrix, child);
    // 语义检验：在容器外用 child 映射点，与在容器内用 local 映射同一个点，结果一致
    const direct = applyMatrix(child, 3.3, 7.7);
    const nested = viaTwo(outer, local, 3.3, 7.7);
    expect(nested.x).toBeCloseTo(direct.x, 6);
    expect(nested.y).toBeCloseTo(direct.y, 6);
  });
});

describe('maskShellSpec（蒙版壳几何：链接/解链的壳尺寸与矩阵）', () => {
  /** 最小图层（maskShellSpec 只读 natural 尺寸 / box / mask） */
  const layerWith = (over: Partial<EditorLayer> = {}): EditorLayer => ({
    id: 'L1',
    name: '测试层',
    naturalWidth: 300,
    naturalHeight: 200,
    box: box(),
    visible: true,
    ...over,
  });
  const maskImg = { source: 'mask.png', naturalWidth: 60, naturalHeight: 40 };

  it('无蒙版 → null', () => {
    expect(maskShellSpec(layerWith())).toBeNull();
  });

  it('蒙版被停用（disabled）→ null：合成按无蒙版走（PS 的 Shift+点缩略图）', () => {
    const layer = layerWith({ mask: { ...maskImg, disabled: true } });
    expect(maskShellSpec(layer)).toBeNull();
  });

  it('链接（mask 无 box）：壳 = **图层**内容框——尺寸取图层自然尺寸，蒙版靠 mask-size 拉伸铺满', () => {
    const layer = layerWith({
      box: box({ x: 50, y: 60, w: 600, h: 400, rotation: 30 }),
      mask: { ...maskImg },
    });
    const spec = maskShellSpec(layer);
    expect(spec).not.toBeNull();
    expect(spec?.width).toBe(300);
    expect(spec?.height).toBe(200);
    expect(spec?.matrix).toEqual(composeMatrix(layer.box, { width: 300, height: 200 }));
  });

  it('链接壳映射的是图层内容坐标：壳四角与图层内容四角在画布上重合（按蒙版尺寸建壳就是 2026-10-24 踩的坑）', () => {
    const layer = layerWith({
      box: box({ x: 50, y: 60, w: 600, h: 400, rotation: 30 }),
      mask: { ...maskImg },
    });
    const spec = maskShellSpec(layer)!;
    const mLayer = composeMatrix(layer.box, { width: 300, height: 200 });
    for (const [x, y] of [[0, 0], [300, 0], [300, 200], [0, 200]] as const) {
      const shellCorner = applyMatrix(spec.matrix, x, y);
      const layerCorner = applyMatrix(mLayer, x, y);
      expect(shellCorner.x).toBeCloseTo(layerCorner.x, 9);
      expect(shellCorner.y).toBeCloseTo(layerCorner.y, 9);
    }
  });

  it('解链：壳 = 蒙版自己的内容框，蒙版 1:1', () => {
    const mbox = box({ x: 10, y: 20, w: 120, h: 80, rotation: 15 });
    const layer = layerWith({ box: box({ x: 50, y: 60, w: 600, h: 400 }), mask: { ...maskImg, box: mbox } });
    const spec = maskShellSpec(layer)!;
    expect(spec.width).toBe(60);
    expect(spec.height).toBe(40);
    expect(spec.matrix).toEqual(composeMatrix(mbox, { width: 60, height: 40 }));
  });

  it('解链框 = 图层框拷贝时（toggleMaskLink 的起步态）：蒙版四角映射到与图层内容相同的画布矩形——解链瞬间画面不动', () => {
    const lbox = box({ x: 50, y: 60, w: 600, h: 400, rotation: 30 });
    const layer = layerWith({ box: lbox, mask: { ...maskImg, box: { ...lbox } } });
    const mLayer = composeMatrix(lbox, { width: 300, height: 200 });
    const spec = maskShellSpec(layer)!;
    const layerCorners = [[0, 0], [300, 0], [300, 200], [0, 200]].map(([x, y]) => applyMatrix(mLayer, x, y));
    const maskCorners = [[0, 0], [60, 0], [60, 40], [0, 40]].map(([x, y]) => applyMatrix(spec.matrix, x, y));
    layerCorners.forEach((c, i) => {
      expect(maskCorners[i].x).toBeCloseTo(c.x, 6);
      expect(maskCorners[i].y).toBeCloseTo(c.y, 6);
    });
  });
});
