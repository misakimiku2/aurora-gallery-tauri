import { describe, expect, it } from 'vitest';
import {
  BRUSH_FAMILY, brushSizeStep, bucketParams, chainSegments, constrain45, constrainSquare,
  docToRaster, effectiveMode, gradientParams, initialMods, lassoParams, marqueeParams, marqueeRect,
  moveBounds, moveDelta, moveDirtyRect, nextMarqueeShape, normalizeRect, reflectFromCenter,
  resolveSelectionMode, rgbToHex, sampleHex, selectMode, singleLineParams, strokeCommand,
  strokeParams, TOOL_KEYS, trackMods,
} from '../toolLogic';
import type { ToolOptions } from '../editorStore';

const OPTS: ToolOptions = {
  brushSize: 24, brushHardness: 0.8, brushOpacity: 1, brushFlow: 1, retouchStrength: 50,
  feather: 0, tolerance: 32, antiAlias: true, gradientStyle: 'linear', marqueeShape: 'rect',
  selectionMode: 'replace',
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

describe('chainSegments(边界段 → 连续折线,蚂蚁线虚线沿路径跑)', () => {
  it('矩形 4 段串成 1 条闭合折线(5 点,末点回到起点)', () => {
    const polys = chainSegments([
      [2, 3, 10, 3], [10, 3, 10, 7], [10, 7, 2, 7], [2, 7, 2, 3],
    ]);
    expect(polys).toHaveLength(1);
    expect(polys[0]).toHaveLength(10); // 4 段 + 闭合点 = 5 点
    expect([polys[0][8], polys[0][9]]).toEqual([polys[0][0], polys[0][1]]);
  });
  it('台阶段(L 形轮廓,像素级短段)串成一条连续折线', () => {
    // 椭圆光栅化的典型台阶:水平 1px + 竖直 1px 交替首尾相接
    const polys = chainSegments([
      [0, 0, 1, 0], [1, 0, 1, 1], [1, 1, 2, 1], [2, 1, 2, 2], [2, 2, 0, 2], [0, 2, 0, 0],
    ]);
    expect(polys).toHaveLength(1);
    expect(polys[0]).toHaveLength(14); // 6 段 + 闭合点 = 7 点
  });
  it('两个分离的轮廓串成 2 条折线;顺序打乱也能接上', () => {
    const polys = chainSegments([
      [10, 10, 10, 20], [0, 0, 0, 5], [0, 5, 5, 5], [10, 20, 20, 20], [20, 20, 20, 10], [20, 10, 10, 10], [5, 5, 5, 0], [5, 0, 0, 0],
    ]);
    expect(polys).toHaveLength(2);
    expect(polys.every((p) => p.length === 10)).toBe(true); // 4 段 + 闭合点 = 5 点
  });
  it('空段集返回空', () => {
    expect(chainSegments([])).toEqual([]);
  });
});

describe('TOOL_KEYS', () => {
  it('覆盖一期全部工具(M 键在画布层做组内循环,不在表内)', () => {
    expect(TOOL_KEYS.v).toBe('move');
    expect(TOOL_KEYS.m).toBeUndefined();
    expect(Object.keys(TOOL_KEYS)).toHaveLength(13);
  });
});

describe('画笔族 live 描边参数(photocraft spec 口径)', () => {
  it('BRUSH_FAMILY 五工具;brush/eraser 走 paint.stroke,retouch 三工具走 paint.<tool>', () => {
    expect([...BRUSH_FAMILY]).toEqual(['brush', 'eraser', 'blur', 'sharpen', 'smudge']);
    expect(strokeCommand('brush')).toBe('paint.stroke');
    expect(strokeCommand('eraser')).toBe('paint.stroke');
    expect(strokeCommand('blur')).toBe('paint.blur');
    expect(strokeCommand('sharpen')).toBe('paint.sharpen');
    expect(strokeCommand('smudge')).toBe('paint.smudge');
  });
  it('brush:小数单位(size/hardness/opacity/flow 0..1)+ 前景色 + zoom', () => {
    const p = strokeParams('brush', OPTS, '#3366cc', 2.5);
    expect(p).toEqual({
      size: 24, hardness: 0.8, opacity: 1, flow: 1,
      spacing: 0.25, smoothing: 0.1, color: '#3366cc', erase: false, zoom: 2.5,
    });
  });
  it('eraser:同管线,只多 erase:true', () => {
    const p = strokeParams('eraser', OPTS, '#3366cc', 1) as Record<string, unknown>;
    expect(p.erase).toBe(true);
    expect(p.size).toBe(24);
  });
  it('retouch 族:hardness/opacity/flow/spacing 换算百分数,强度走 strength', () => {
    const p = strokeParams('blur', OPTS, '#000000', 1) as Record<string, unknown>;
    expect(p.size).toBe(24);
    expect(p.hardness).toBe(80); // 0.8 → 80
    expect(p.opacity).toBe(100); // 1 → 100
    expect(p.flow).toBe(100);
    expect(p.spacing).toBe(25);
    expect(p.strength).toBe(50);
    expect('erase' in p).toBe(false);
  });
  it('retouch 不透明度下限 1(引擎 clamp 1..100)', () => {
    const p = strokeParams('smudge', { ...OPTS, brushOpacity: 0.005 }, '#000000', 1) as Record<string, unknown>;
    expect(p.opacity).toBe(1);
  });
});

describe('brushSizeStep([ / ] 调笔径,上游 tools.*BrushSize 口径)', () => {
  it('±25% 且至少 ±1px', () => {
    expect(brushSizeStep(24, 1)).toBe(30);
    expect(brushSizeStep(24, -1)).toBe(18);
    expect(brushSizeStep(3, 1)).toBe(4); // 步长至少 1
    expect(brushSizeStep(3, -1)).toBe(2);
  });
  it('钳 1..500,往返不越界', () => {
    expect(brushSizeStep(1, -1)).toBe(1);
    expect(brushSizeStep(490, 1)).toBe(500);
    expect(brushSizeStep(500, 1)).toBe(500);
  });
});

describe('rgbToHex(引擎前景色 0..1 → #rrggbb)', () => {
  it('常规换算与钳位', () => {
    expect(rgbToHex([1, 0, 0])).toBe('#ff0000');
    expect(rgbToHex([0.2, 0.4, 0.6])).toBe('#336699');
    expect(rgbToHex([2, -1, 0.5])).toBe('#ff0080'); // 钳到 0..1
  });
  it('缺失/空值回退黑色', () => {
    expect(rgbToHex(undefined)).toBe('#000000');
    expect(rgbToHex(null)).toBe('#000000');
    expect(rgbToHex([])).toBe('#000000');
  });
});

describe('套索参数(photocraft select.lasso 口径)', () => {
  it('透传 points 文档坐标序列 + mode + antiAlias + feather', () => {
    const p = lassoParams([[1.5, 2], [10, 3], [5, 9]], OPTS, 'add');
    expect(p).toEqual({ points: [[1.5, 2], [10, 3], [5, 9]], mode: 'add', antiAlias: true, feather: 0 });
  });
  it('feather 钳 0..=1000(引擎越界报错,与 select.rect 的静默钳不同)', () => {
    expect(lassoParams([[0, 0], [1, 1], [2, 5]], { ...OPTS, feather: 5000 }, 'replace').feather).toBe(1000);
    expect(lassoParams([[0, 0], [1, 1], [2, 5]], { ...OPTS, feather: -3 }, 'replace').feather).toBe(0);
    expect(lassoParams([[0, 0], [1, 1], [2, 5]], { ...OPTS, feather: 60 }, 'replace').feather).toBe(60);
  });
});

describe('单行/单列选框 + 选区四态(photocraft select.rect line 口径)', () => {
  it('singleLineParams:row=整幅宽×1px 在 y 处;column=1px×整幅高在 x 处;位置钳进画布', () => {
    expect(singleLineParams('row', 12.6, 100, 80, OPTS, 'replace')).toEqual({
      x: 0, y: 13, width: 100, height: 1, line: 'row', mode: 'replace', antiAlias: true, feather: 0,
    });
    expect(singleLineParams('column', -5, 100, 80, OPTS, 'replace')).toEqual({
      x: 0, y: 0, width: 1, height: 80, line: 'column', mode: 'replace', antiAlias: true, feather: 0,
    });
    expect(singleLineParams('row', 999, 100, 80, OPTS, 'replace').y).toBe(79);
  });
  it('nextMarqueeShape:M 键四形态循环', () => {
    expect(nextMarqueeShape('rect')).toBe('ellipse');
    expect(nextMarqueeShape('ellipse')).toBe('row');
    expect(nextMarqueeShape('row')).toBe('column');
    expect(nextMarqueeShape('column')).toBe('rect');
  });
  it('resolveSelectionMode:修饰键优先且空选区降级;无修饰键用选项条显式模式(不降级)', () => {
    expect(resolveSelectionMode({ pressShift: true, pressAlt: false }, 'replace', false)).toBe('add');
    expect(resolveSelectionMode({ pressShift: false, pressAlt: true }, 'replace', false)).toBe('replace'); // 空选区 Alt 降级
    expect(resolveSelectionMode({ pressShift: false, pressAlt: true }, 'replace', true)).toBe('subtract');
    expect(resolveSelectionMode({ pressShift: false, pressAlt: false }, 'subtract', false)).toBe('subtract'); // 选项条显式保留
    expect(resolveSelectionMode({ pressShift: false, pressAlt: false }, 'intersect', true)).toBe('intersect');
    expect(resolveSelectionMode({ pressShift: false, pressAlt: false }, 'replace', true)).toBe('replace');
  });
});

describe('渐变/油漆桶参数(photocraft paint.gradient / paint.bucket 口径)', () => {
  it('constrain45:方向吸附到 45° 倍数,长度不变', () => {
    const h = constrain45([0, 0], [10, 2]); // 近水平:方向吸平,长度保留
    expect(h[1]).toBeCloseTo(0);
    expect(h[0]).toBeCloseTo(Math.hypot(10, 2));
    const diag = constrain45([0, 0], [5, 5]); // 已是 45°
    expect(diag[0]).toBeCloseTo(5);
    expect(diag[1]).toBeCloseTo(5);
    const h2 = constrain45([0, 0], [-10, 3]);
    expect(h2[1]).toBeCloseTo(0);
    expect(h2[0]).toBeCloseTo(-Math.hypot(10, 3));
    expect(constrain45([0, 0], [0, 0])).toEqual([0, 0]);   // 零长度原样
  });
  it('gradientParams:from/to 取整 + 样式 + 不透明度(1..100)+ dither', () => {
    expect(gradientParams([1.4, 2.6], [10, 8], { ...OPTS, gradientStyle: 'radial', brushOpacity: 0.5 })).toEqual({
      from: [1, 3], to: [10, 8], style: 'radial', opacity: 50, dither: true,
    });
    expect(gradientParams([0, 0], [5, 5], { ...OPTS, brushOpacity: 0.005 }).opacity).toBe(1);
    expect(gradientParams([0, 0], [5, 5], { ...OPTS, brushOpacity: 2 }).opacity).toBe(100);
  });
  it('bucketParams:坐标取整、容差钳 0..255、前景色、连续开', () => {
    expect(bucketParams(3.7, 8.2, OPTS, '#123456')).toEqual({
      x: 3, y: 8, tolerance: 32, contiguous: true, antiAlias: true,
      contents: 'foreground', color: '#123456', opacity: 100,
    });
    expect(bucketParams(0, 0, { ...OPTS, tolerance: 999 }, '#000000').tolerance).toBe(255);
    expect(bucketParams(0, 0, { ...OPTS, tolerance: -5 }, '#000000').tolerance).toBe(0);
  });
});

describe('移动工具纯函数(photocraft move_ui 口径)', () => {
  it('moveDelta:取整;Shift 约束到主轴', () => {
    expect(moveDelta(10.4, -3.6, false)).toEqual({ dx: 10, dy: -4 });
    expect(moveDelta(15, 3, true)).toEqual({ dx: 15, dy: 0 }); // 水平为主
    expect(moveDelta(3, 15, true)).toEqual({ dx: 0, dy: 15 }); // 垂直为主
    expect(moveDelta(-8, -2, true)).toEqual({ dx: -8, dy: 0 });
  });
  it('moveDirtyRect:上一帧 ∪ 当前帧偏移下的 bounds,再钳进画布', () => {
    // (10,10,20,20) 从 offset(0,0) 挪到 (5,5):并集 (10,10)-(35,35)
    expect(moveDirtyRect([10, 10, 20, 20], 0, 0, 5, 5, 100, 100)).toEqual({ x: 10, y: 10, w: 25, h: 25 });
    // 移出画布左上角:钳到 0
    expect(moveDirtyRect([2, 2, 10, 10], 0, 0, -8, -8, 100, 100)).toEqual({ x: 0, y: 0, w: 12, h: 12 });
    // 新旧位置都在画布外:空
    expect(moveDirtyRect([150, 2, 4, 4], 0, 0, 10, 0, 100, 100)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
    // bounds 为 null:空
    expect(moveDirtyRect(null, 0, 0, 5, 5, 100, 100)).toEqual({ x: 0, y: 0, w: 0, h: 0 });
  });
  it('moveBounds:选中层并集,无选中回退活动层;空 bounds 回退画布', () => {
    const layers = [
      { id: 1, bounds: [5, 5, 10, 10] as [number, number, number, number] | null, selected: false },
      { id: 2, bounds: [20, 8, 10, 4] as [number, number, number, number] | null, selected: true },
      { id: 3, bounds: [1, 30, 4, 4] as [number, number, number, number] | null, selected: true },
      { id: 4, bounds: null as [number, number, number, number] | null, selected: false },
    ];
    expect(moveBounds(layers, 1, 64, 64)).toEqual([1, 8, 29, 26]); // 选中 2+3 的并集
    // 无选中层:回退活动层;活动层无 bounds → 画布
    expect(moveBounds(layers.map((l) => ({ ...l, selected: false })), 4, 64, 64)).toEqual([0, 0, 64, 64]);
    expect(moveBounds(layers.map((l) => ({ ...l, selected: false })), 1, 64, 64)).toEqual([5, 5, 10, 10]);
    expect(moveBounds([], null, 64, 64)).toBeNull();
  });
});
