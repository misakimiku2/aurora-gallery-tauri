import { describe, expect, it } from 'vitest';
import {
  applyMatrixToPixel,
  buildAdjustMatrix,
  isZeroAdjustments,
  toFeColorMatrixValues,
  ZERO_ADJUSTMENTS,
} from '../colorMatrix';

/**
 * 跨语言一致性测试。
 *
 * 预览走浏览器 SVG feColorMatrix（本文件）、导出走 Rust 逐像素（adjust.rs）。
 * 两边公式一旦漂移，用户就会看到「预览调暖了、导出是冷的」——这类 bug 极难自证，
 * 所以用**同一组采样值**在两端各断言一次：任何一边改了公式，那边的测试立刻红。
 */
describe('调色矩阵', () => {
  it('全 0 是单位矩阵', () => {
    const m = buildAdjustMatrix(ZERO_ADJUSTMENTS);
    expect(m.m).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
    expect(m.offset).toEqual([0, 0, 0]);
    expect(isZeroAdjustments(ZERO_ADJUSTMENTS)).toBe(true);
    expect(isZeroAdjustments(undefined)).toBe(true);
  });

  it('与 Rust 侧共享同一组采样值（120,90,60 + 20/30/40/50 → 190,100,29）', () => {
    const m = buildAdjustMatrix({ brightness: 20, contrast: 30, saturation: 40, temperature: 50 });
    expect(applyMatrixToPixel(m, [120, 90, 60])).toEqual([190, 100, 29]);
  });

  it('亮度是乘法（与 CSS brightness 同语义）', () => {
    const m = buildAdjustMatrix({ ...ZERO_ADJUSTMENTS, brightness: 50 });
    expect(applyMatrixToPixel(m, [100, 100, 100])).toEqual([150, 150, 150]);
  });

  it('对比度绕中灰转动，中灰基本不动', () => {
    const m = buildAdjustMatrix({ ...ZERO_ADJUSTMENTS, contrast: 50 });
    const mid = applyMatrixToPixel(m, [128, 128, 128]);
    expect(Math.abs(mid[0] - 128)).toBeLessThanOrEqual(1);
    expect(applyMatrixToPixel(m, [200, 200, 200])[0]).toBeGreaterThan(200);
  });

  it('饱和度 -100 变成灰度', () => {
    const m = buildAdjustMatrix({ ...ZERO_ADJUSTMENTS, saturation: -100 });
    const [r, g, b] = applyMatrixToPixel(m, [255, 0, 0]);
    expect(r).toBe(g);
    expect(g).toBe(b);
  });

  it('色温 +100 抬红压蓝', () => {
    const m = buildAdjustMatrix({ ...ZERO_ADJUSTMENTS, temperature: 100 });
    const [r, g, b] = applyMatrixToPixel(m, [100, 100, 100]);
    expect(r).toBeGreaterThan(100);
    expect(g).toBe(100);
    expect(b).toBeLessThan(100);
  });

  it('feColorMatrix 输出 20 个数，且偏移已 /255', () => {
    // 只开对比度：offset = 127.5*(1-c)
    const m = buildAdjustMatrix({ ...ZERO_ADJUSTMENTS, contrast: 50 });
    const values = toFeColorMatrixValues(m).split(' ');
    expect(values).toHaveLength(20);
    // 第 5 个数是红通道偏移，必须已归一化到 [-1, 1]
    const redOffset = Number(values[4]);
    expect(Math.abs(redOffset)).toBeLessThanOrEqual(1);
    expect(redOffset).toBeCloseTo((127.5 * (1 - 1.5)) / 255, 5);
  });
});
