import { describe, expect, it } from 'vitest';
import {
  constrainSquare, docToRaster, effectiveMode, initialMods, marqueeParams, marqueeRect,
  normalizeRect, reflectFromCenter, sampleHex, selectMode,
  TOOL_KEYS, trackMods,
} from '../toolLogic';
import type { ToolOptions } from '../editorStore';

const OPTS: ToolOptions = {
  brushSize: 24, brushHardness: 0.8, brushOpacity: 1, brushFlow: 1,
  feather: 0, tolerance: 32, antiAlias: true, gradientStyle: 'linear', marqueeShape: 'rect',
};

describe('constrainSquare / reflectFromCenter', () => {
  it('以起点为角取较大边长,保持拖拽方向', () => {
    expect(constrainSquare({ x0: 10, y0: 10, x1: 30, y1: 20 })).toEqual({ x0: 10, y0: 10, x1: 30, y1: 30 });
    expect(constrainSquare({ x0: 10, y0: 10, x1: 2, y1: 20 })).toEqual({ x0: 10, y0: 10, x1: 0, y1: 20 });
  });
  it('从中心:起点反射到对侧,起点成为矩形中心', () => {
    const r = reflectFromCenter({ x0: 100, y0: 100, x1: 150, y1: 120 });
    expect(r).toEqual({ x0: 50, y0: 80, x1: 150, y1: 120 });
  });
});

describe('修饰键时序(photocraft 上游 Drag::marquee_mods 口径)', () => {
  it('按下时按住的键只定模式,不做形状约束', () => {
    const m = initialMods(true, false); // Shift 从按下就按住
    expect(marqueeRect({ x0: 0, y0: 0, x1: 30, y1: 10 }, m)).toEqual({ x: 0, y: 0, w: 30, h: 10 }); // 不约束成正方形
    expect(selectMode(m.pressShift, m.pressAlt)).toBe('add');
  });
  it('拖拽中途新按的 Shift 约束正方形', () => {
    let m = initialMods(false, false);
    m = trackMods(m, false, false);
    m = trackMods(m, true, false); // 中途按下 Shift(fresh)
    expect(marqueeRect({ x0: 0, y0: 0, x1: 30, y1: 10 }, m)).toEqual({ x: 0, y: 0, w: 30, h: 30 });
  });
  it('松开后再按也算新按(恢复约束)', () => {
    let m = initialMods(true, false);
    m = trackMods(m, false, false); // 松开 → released
    m = trackMods(m, true, false); // 再按 → fresh 约束,不再是 add 模式语义
    expect(marqueeRect({ x0: 0, y0: 0, x1: 30, y1: 10 }, m)).toEqual({ x: 0, y: 0, w: 30, h: 30 });
  });
  it('拖拽中途新按的 Alt 从中心', () => {
    let m = initialMods(false, false);
    m = trackMods(m, false, true);
    expect(marqueeRect({ x0: 100, y0: 100, x1: 150, y1: 120 }, m)).toEqual({ x: 50, y: 80, w: 100, h: 40 });
  });
});

describe('selectMode / effectiveMode', () => {
  it('按下时修饰键 → 模式', () => {
    expect(selectMode(false, false)).toBe('replace');
    expect(selectMode(true, false)).toBe('add');
    expect(selectMode(false, true)).toBe('subtract');
    expect(selectMode(true, true)).toBe('intersect');
  });
  it('无现有选区时减去/相交落回新选区(上游 document_selection_mode)', () => {
    expect(effectiveMode('subtract', false)).toBe('replace');
    expect(effectiveMode('intersect', false)).toBe('replace');
    expect(effectiveMode('subtract', true)).toBe('subtract');
    expect(effectiveMode('add', false)).toBe('add');
  });
});

describe('marqueeRect / normalizeRect', () => {
  it('任意方向拖拽归一化为正 x/y/w/h', () => {
    expect(normalizeRect({ x0: 20.6, y0: 10.2, x1: 5.3, y1: 30.9 })).toEqual({ x: 5, y: 10, w: 16, h: 21 });
  });
  it('宽或高不足 1px 视为点击返回 null', () => {
    expect(normalizeRect({ x0: 10, y0: 10, x1: 10.4, y1: 50 })).toBeNull();
    expect(normalizeRect({ x0: 10, y0: 10, x1: 50, y1: 9.6 })).toBeNull();
  });
  it('无约束时不改变拖拽矩形', () => {
    const m = initialMods(false, false);
    expect(marqueeRect({ x0: 1, y0: 2, x1: 31.4, y1: 22.9 }, m)).toEqual({ x: 1, y: 2, w: 30, h: 21 });
  });
});

describe('marqueeParams', () => {
  it('矩形:透传 feather/antiAlias/mode', () => {
    const p = marqueeParams({ x: 1, y: 2, w: 30, h: 21 }, { ...OPTS, feather: 3 }, 'replace');
    expect(p).toMatchObject({ x: 1, y: 2, width: 30, height: 21, ellipse: false, mode: 'replace', feather: 3, antiAlias: true });
  });
  it('椭圆形状与修饰键模式', () => {
    const p = marqueeParams({ x: 0, y: 0, w: 10, h: 10 }, { ...OPTS, marqueeShape: 'ellipse' }, 'intersect');
    expect(p).toMatchObject({ ellipse: true, mode: 'intersect' });
  });
});

describe('docToRaster / sampleHex', () => {
  it('大图降采样坐标折算并取整', () => {
    expect(docToRaster(100, 50, 0.5)).toEqual({ px: 50, py: 25 });
    expect(docToRaster(99.9, 0, 1)).toEqual({ px: 99, py: 0 });
  });
  it('画布内取色返回 #rrggbb,越界返回 null', () => {
    // jsdom 无 canvas 2d 实现,伪 ctx 只需 sampleHex 用到的面(canvas 尺寸 + getImageData)
    const makeCtx = (color: [number, number, number]) =>
      ({ canvas: { width: 2, height: 1 }, getImageData: () => ({ data: new Uint8ClampedArray(color) }) }) as unknown as CanvasRenderingContext2D;
    const ctx = makeCtx([255, 128, 0]);
    expect(sampleHex(ctx, 0, 0, 1)).toBe('#ff8000');
    expect(sampleHex(ctx, 1.9, 0.5, 1)).toBe('#ff8000');
    expect(sampleHex(ctx, 2, 0, 1)).toBeNull();
    expect(sampleHex(ctx, -1, 0, 1)).toBeNull();
  });
});

describe('TOOL_KEYS', () => {
  it('覆盖一期全部工具(M 键在画布层做组内循环,不在表内)', () => {
    expect(TOOL_KEYS.v).toBe('move');
    expect(TOOL_KEYS.m).toBeUndefined();
    expect(Object.keys(TOOL_KEYS)).toHaveLength(13);
  });
});
