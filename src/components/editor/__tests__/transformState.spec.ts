import { describe, expect, it } from 'vitest';
import { isPristine, isSameGeometry, isSameTransform } from '../transformState';

const base = { rotation: 90 as const, flipH: true, flipV: false };

describe('变换状态比较', () => {
  it('值相同但对象引用不同，应判定为相同', () => {
    const a = { ...base, crop: { x: 1, y: 2, w: 3, h: 4 }, adjust: { brightness: 10, contrast: 0, saturation: 0, temperature: 0 } };
    const b = { ...base, crop: { x: 1, y: 2, w: 3, h: 4 }, adjust: { brightness: 10, contrast: 0, saturation: 0, temperature: 0 } };
    expect(isSameTransform(a, b)).toBe(true);
  });

  it('裁剪 / 旋转 / 翻转任一不同就不相同', () => {
    const a = { ...base, crop: { x: 1, y: 2, w: 3, h: 4 } };
    expect(isSameTransform(a, { ...base, crop: { x: 1, y: 2, w: 3, h: 5 } })).toBe(false);
    expect(isSameTransform(a, { ...base, rotation: 180 as const, crop: { x: 1, y: 2, w: 3, h: 4 } })).toBe(false);
    expect(isSameTransform(a, { ...base, flipH: false, crop: { x: 1, y: 2, w: 3, h: 4 } })).toBe(false);
  });

  it('裁剪从无到有算变化（undefined 与整图矩形不等价）', () => {
    expect(isSameTransform({}, { rotation: 0, flipH: false, flipV: false })).toBe(true);
    expect(isSameTransform({}, { crop: { x: 0, y: 0, w: 10, h: 10 } })).toBe(false);
  });

  it('调色任一维不同就不相同', () => {
    const a = { adjust: { brightness: 10, contrast: 0, saturation: 0, temperature: 0 } };
    expect(isSameTransform(a, { adjust: { brightness: 11, contrast: 0, saturation: 0, temperature: 0 } })).toBe(false);
    expect(isSameTransform(a, { adjust: { brightness: 10, contrast: 1, saturation: 0, temperature: 0 } })).toBe(false);
  });
});

describe('几何部分比较（用于判断是否在拖滑杆）', () => {
  it('只改调色时几何不变', () => {
    const a = { ...base, adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 } };
    const b = { ...base, adjust: { brightness: 40, contrast: 10, saturation: 0, temperature: -5 } };
    expect(isSameGeometry(a, b)).toBe(true);
    // 但整体状态是变了
    expect(isSameTransform(a, b)).toBe(false);
  });

  it('改了裁剪则几何变了', () => {
    const a = { crop: { x: 0, y: 0, w: 1, h: 1 } };
    const b = { crop: { x: 0, y: 0, w: 2, h: 1 } };
    expect(isSameGeometry(a, b)).toBe(false);
  });
});

describe('是否处于未编辑状态', () => {
  it('空对象是 pristine', () => {
    expect(isPristine({})).toBe(true);
  });

  it('四项调色全 0 也算 pristine', () => {
    expect(
      isPristine({ adjust: { brightness: 0, contrast: 0, saturation: 0, temperature: 0 } }),
    ).toBe(true);
  });

  it('稍有改动就不是', () => {
    expect(isPristine({ rotation: 90 })).toBe(false);
    expect(isPristine({ flipV: true })).toBe(false);
    expect(
      isPristine({ adjust: { brightness: 1, contrast: 0, saturation: 0, temperature: 0 } }),
    ).toBe(false);
  });
});
