import { describe, expect, it } from 'vitest';
import { computeRatioRect, normalizeRect, type CropArea } from '../cropGeometry';

/**
 * 比例约束的数学锁。
 *
 * 这些用例存在的意义：比例算错时**界面看起来完全正常**——框能拖、数字在变，
 * 只是比例差了零点几，或者贴边时被悄悄拧歪。肉眼几乎发现不了，只能靠断言。
 */

const DOC = 1000;

const aspect = (r: CropArea) => r.w / r.h;

describe('computeRatioRect', () => {
  it('角把手按比例求另一边，以更大的一边为准', () => {
    // 16:9 的框从左上角往右下拖
    const out = computeRatioRect(
      'se',
      { x: 100, y: 100 },
      { x: 900, y: 400 },
      { x: 100, y: 100, w: 400, h: 225 },
      16 / 9,
      DOC,
      DOC,
    );
    expect(out.x).toBe(100);
    expect(out.y).toBe(100);
    // 鼠标横向 800，按 16:9 高度应是 450 —— 比鼠标的 300 更大，所以以宽度为准
    expect(out.w).toBe(800);
    expect(out.h).toBe(450);
    expect(aspect(out)).toBeCloseTo(16 / 9, 1);
  });

  it('越界时按比例整体收缩，而不是把比例拧歪', () => {
    const ratio = 2;
    const out = computeRatioRect(
      'se',
      { x: 0, y: 0 },
      { x: 1200, y: 300 }, // 横向明显超出画布
      { x: 0, y: 0, w: 100, h: 50 },
      ratio,
      DOC,
      DOC,
    );
    expect(out.x).toBe(0);
    expect(out.y).toBe(0);
    expect(out.w).toBe(DOC); // 顶到右边界
    expect(out.h).toBe(500); // 高度跟着比例走，不是 300
    expect(out.w / out.h).toBeCloseTo(ratio, 5);
  });

  it('边把手：另一维以框中心对称扩展', () => {
    const out = computeRatioRect(
      'e',
      { x: 300, y: 200 },
      { x: 500, y: 200 },
      { x: 100, y: 100, w: 200, h: 200 }, // 中心 y = 200
      1,
      DOC,
      DOC,
    );
    expect(out.x).toBe(100);
    expect(out.w).toBe(400);
    expect(out.h).toBe(400);
    // 中心保持不动
    expect(out.y + out.h / 2).toBe(200);
    expect(aspect(out)).toBe(1);
  });

  it('从空白拉新框也守比例', () => {
    const out = computeRatioRect(
      'new',
      { x: 100, y: 100 },
      { x: 400, y: 200 }, // 宽 300、高 100，比例 1 时应取宽
      { x: 0, y: 0, w: 0, h: 0 },
      1,
      DOC,
      DOC,
    );
    expect(out.x).toBe(100);
    expect(out.y).toBe(100);
    expect(out.w).toBe(300);
    expect(out.h).toBe(300);
    expect(aspect(out)).toBe(1);
  });

  it('往左上拉新框时锚点仍在起点', () => {
    const out = computeRatioRect(
      'new',
      { x: 500, y: 500 },
      { x: 300, y: 380 },
      { x: 0, y: 0, w: 0, h: 0 },
      1,
      DOC,
      DOC,
    );
    // 宽 200、高 120 → 取大的 200，框向左上展开
    expect(out.w).toBe(200);
    expect(out.h).toBe(200);
    expect(out.x + out.w).toBe(500);
    expect(out.y + out.h).toBe(500);
  });

  it('结果永远不越出画布', () => {
    const ratio = 16 / 9;
    const cases: Array<[string, { x: number; y: number }]> = [
      ['se', { x: 5000, y: 5000 }],
      ['nw', { x: -5000, y: -5000 }],
      ['ne', { x: 5000, y: -5000 }],
      ['sw', { x: -5000, y: 5000 }],
      ['e', { x: 5000, y: 0 }],
      ['w', { x: -5000, y: 0 }],
      ['n', { x: 0, y: -5000 }],
      ['s', { x: 0, y: 5000 }],
    ];
    for (const [mode, cur] of cases) {
      const out = computeRatioRect(
        mode as never,
        { x: 500, y: 500 },
        cur,
        { x: 400, y: 400, w: 200, h: 112 },
        ratio,
        DOC,
        DOC,
      );
      expect(out.x).toBeGreaterThanOrEqual(0);
      expect(out.y).toBeGreaterThanOrEqual(0);
      expect(out.x + out.w).toBeLessThanOrEqual(DOC);
      expect(out.y + out.h).toBeLessThanOrEqual(DOC);
      // 允许 ±1px 的取整误差
      expect(Math.abs(out.w / out.h - ratio)).toBeLessThan(0.02);
    }
  });
});

describe('normalizeRect', () => {
  it('把负宽高翻转成正的（鼠标往左上拖）', () => {
    expect(normalizeRect({ x: 100, y: 100, w: -50, h: -30 })).toEqual({
      x: 50,
      y: 70,
      w: 50,
      h: 30,
    });
  });
});
