import { describe, expect, it } from 'vitest';
import {
  BRUSH_FAMILY, brushSizeStep, bucketParams, chainSegments, constrain45, constrainMove, constrainPolygonPoint, constrainStrokePoint, constrainSquare,
  cropCorners, cropDrawn, cropFitted, cropFittedRatio, cropFrameAngle, cropHit, cropHitTurned, cropResized, cropStraightenAngle,
  cropTurnedAngle, docToRaster, effectiveMode, gradientParams, initialMods, isMaskTarget, lassoParams, marqueeParams, marqueeRect,
  moveBounds, magneticSpacing, cutPathAtLength, pathLength, nearMagneticStart,
  moveDirtyRect, nextLassoTool, nextMarqueeShape, normalizeRect, projectOn, reflectFromCenter,
  resolveSelectionMode, rgbToHex, sampleHex, selectMode, singleLineParams, snappedDir, strokeCommand,
  strokeParams, TOOL_KEYS, trackMods,
} from '../toolLogic';
import type { StrokeAxis } from '../toolLogic';
import type { ToolOptions } from '../editorStore';

const OPTS: ToolOptions = {
  brushSize: 24, brushHardness: 0.8, brushOpacity: 1, brushFlow: 1, retouchStrength: 50,
  feather: 0, tolerance: 32, antiAlias: true, gradientStyle: 'linear',
  gradientPreset: 'Foreground to Background', gradientReverse: false, gradientDither: true, gradientOpacity: 1,
  marqueeShape: 'rect',
  selectionMode: 'replace', moveAutoSelect: true, moveTarget: 'layer', cropRatio: '', cropSnapAngle: false,
  magneticWidth: 10, magneticContrast: 10, magneticFrequency: 57,
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
  it('覆盖一期全部工具(M/L 键在画布层做组内循环,不在表内)', () => {
    expect(TOOL_KEYS.v).toBe('move');
    expect(TOOL_KEYS.m).toBeUndefined();
    expect(TOOL_KEYS.l).toBeUndefined();
    expect(Object.keys(TOOL_KEYS)).toHaveLength(12);
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
    const p = strokeParams('brush', OPTS, '#3366cc', 2.5, false);
    expect(p).toEqual({
      size: 24, hardness: 0.8, opacity: 1, flow: 1,
      spacing: 0.25, smoothing: 0.1, color: '#3366cc', erase: false, zoom: 2.5,
    });
  });
  it('eraser:同管线,只多 erase:true', () => {
    const p = strokeParams('eraser', OPTS, '#3366cc', 1, false) as Record<string, unknown>;
    expect(p.erase).toBe(true);
    expect(p.size).toBe(24);
  });
  it('retouch 族:hardness/opacity/flow/spacing 换算百分数,强度走 strength', () => {
    const p = strokeParams('blur', OPTS, '#000000', 1, false) as Record<string, unknown>;
    expect(p.size).toBe(24);
    expect(p.hardness).toBe(80); // 0.8 → 80
    expect(p.opacity).toBe(100); // 1 → 100
    expect(p.flow).toBe(100);
    expect(p.spacing).toBe(25);
    expect(p.strength).toBe(50);
    expect('erase' in p).toBe(false);
  });
  it('retouch 不透明度下限 1(引擎 clamp 1..100)', () => {
    const p = strokeParams('smudge', { ...OPTS, brushOpacity: 0.005 }, '#000000', 1, false) as Record<string, unknown>;
    expect(p.opacity).toBe(1);
  });
  it('蒙版目标:strokeParams 带上 target:"mask"(live 描边走桥层直通,必须显式带)', () => {
    expect(strokeParams('brush', OPTS, '#ffffff', 1, true).target).toBe('mask');
    expect(strokeParams('eraser', OPTS, '#ffffff', 1, true).target).toBe('mask');
    expect(strokeParams('smudge', OPTS, '#ffffff', 1, true).target).toBe('mask');
    expect(strokeParams('brush', OPTS, '#ffffff', 1, false)).not.toHaveProperty('target');
  });
  it('isMaskTarget:channels.target.kind === layerMask(引擎 ChannelTarget 序列化)', () => {
    expect(isMaskTarget({ channels: { target: { kind: 'layerMask' } } })).toBe(true);
    expect(isMaskTarget({ channels: { target: { kind: 'composite' } } })).toBe(false);
    expect(isMaskTarget({})).toBe(false);
    expect(isMaskTarget(null)).toBe(false);
    expect(isMaskTarget(undefined)).toBe(false);
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
  it('gradientParams:from/to 取整 + 样式 + 预设 stops(活引用)+ 反向/仿色/不透明度', () => {
    expect(gradientParams([1.4, 2.6], [10, 8], { ...OPTS, gradientStyle: 'radial', gradientOpacity: 0.5 })).toEqual({
      from: [1, 3], to: [10, 8], style: 'radial',
      stops: [[0, 'foreground'], [1, 'background']],
      reverse: false, dither: true, opacity: 50,
    });
    expect(gradientParams([0, 0], [5, 5], { ...OPTS, gradientOpacity: 0.005 }).opacity).toBe(1);
    expect(gradientParams([0, 0], [5, 5], { ...OPTS, gradientOpacity: 2 }).opacity).toBe(100);
    // 透明度预设:transparency 以 0..100 下发
    const ft = gradientParams([0, 0], [5, 5], { ...OPTS, gradientPreset: 'Foreground to Transparent' });
    expect(ft.transparency).toEqual([[0, 100], [1, 0]]);
    expect(ft.stops).toEqual([[0, 'foreground'], [1, 'foreground']]);
  });
  it('bucketParams:坐标取整、容差钳 0..255、前景色、连续开', () => {
    expect(bucketParams(3.7, 8.2, OPTS, '#123456')).toEqual({
      x: 3, y: 8, tolerance: 32, contiguous: true, antiAlias: true,
      contents: 'foreground', color: '#123456', opacity: 100,
    });
    expect(bucketParams(0, 0, { ...OPTS, tolerance: 999 }, '#000000').tolerance).toBe(255);
    expect(bucketParams(0, 0, { ...OPTS, tolerance: -5 }, '#000000').tolerance).toBe(0);
  });
  it('蒙版目标:bucket/gradient 带 target:"mask"(引擎 routed 注入也认显式参数)', () => {
    expect(bucketParams(0, 0, OPTS, '#000000', true).target).toBe('mask');
    expect(bucketParams(0, 0, OPTS, '#000000', false)).not.toHaveProperty('target');
    expect(gradientParams([0, 0], [5, 5], OPTS, true).target).toBe('mask');
    expect(gradientParams([0, 0], [5, 5], OPTS)).not.toHaveProperty('target');
  });
});

describe('画笔 ⇧ 直线约束(上游 stroke_constraint.rs 口径)', () => {
  const close = (a: [number, number], b: [number, number]) => Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  it('锁距内吸附回起点;≥3 屏幕像素后锁定 0° 并保持方向;松开 Shift 解除', () => {
    const o: [number, number] = [10, 10];
    let axis: StrokeAxis | null = null;
    const p = (q: [number, number]) => { const r = constrainStrokePoint(axis, o, q, true, 1); axis = r.axis; return r.p; };
    expect(p([11, 11])).toEqual([10, 10]);  // 锁距(3 屏幕像素)内:回起点
    expect(p([30, 12])).toEqual([30, 10]);  // 锁定水平
    expect(p([60, 45])).toEqual([60, 10]);  // 方向记忆:指针偏向 45° 仍留在水平线
    const freed = constrainStrokePoint(axis, [60, 10], [70, 50], false, 1);
    expect(freed.p).toEqual([70, 50]);      // 松开 Shift:原样通过
    expect(freed.axis).toBeNull();          // 且丢弃锁定
  });
  it('垂直/45° 锁定与 45° 吸附几何(snappedDir/projectOn)', () => {
    let axis: StrokeAxis | null = null;
    const p = (q: [number, number]) => { const r = constrainStrokePoint(axis, [10, 10], q, true, 1); axis = r.axis; return r.p; };
    expect(close(p([9, 60]), [10, 60])).toBe(true);  // 垂直(cos90 浮点噪声用容差断言)
    axis = null;
    const q = p([40, 43]);
    expect(Math.abs(q[0] - 10 - (q[1] - 10))).toBeLessThan(1e-9); // 45° 线:投影两端等距
    expect(snappedDir([10, 10], [50, 13])).toEqual([1, 0]);       // 近水平 → 0°
    const d = snappedDir([10, 10], [40, 37])!;
    expect(Math.abs(d[0] - d[1])).toBeLessThan(1e-9);             // 近 45°
    expect(snappedDir([10, 10], [10, 10])).toBeNull();            // 重合:无方向
    expect(projectOn([0, 0], [1, 0], [30, 12])).toEqual([30, 0]); // 投影
  });
});

describe('裁剪工具几何(上游 crop_ui / crop_straighten 口径)', () => {
  it('cropHit:边=把手(小框内侧容差收缩)、内部=inside、框外=outside', () => {
    const r: [number, number, number, number] = [0, 0, 100, 50];
    expect(cropHit(r, [0, 0], 8)).toEqual({ kind: 'handle', hx: -1, hy: -1 });       // 左上角
    expect(cropHit(r, [50, 0], 8)).toEqual({ kind: 'handle', hx: 0, hy: -1 });       // 上边中点
    expect(cropHit(r, [95, 45], 8)).toEqual({ kind: 'handle', hx: 1, hy: 1 });       // 右下角(同时近两边)
    expect(cropHit(r, [95, 40], 8)).toEqual({ kind: 'handle', hx: 1, hy: 0 });       // 只近右缘
    expect(cropHit(r, [50, 25], 8)).toEqual({ kind: 'inside' });
    expect(cropHit(r, [200, 200], 8)).toEqual({ kind: 'outside' });
    // 小框:内侧容差收缩到边距 1/4,整框仍可移动
    const small: [number, number, number, number] = [0, 0, 4, 4];
    expect(cropHit(small, [2, 2], 8)).toEqual({ kind: 'inside' });
  });
  it('cropDrawn:ratio 固定比例(大延伸方向赢)、无 ratio ⇧ 正方形、alt 从中心', () => {
    // fixedRatio w:h = 2:1:dx=10, dy=30 → k = max(10/2, 30/1) = 30 → (60, 30)(上游测试同款)
    expect(cropDrawn([0, 0], [10, 30], 2, false, false)).toEqual([0, 0, 60, 30]);
    // dx=10, dy=3 → k = max(10/2, 3/1) = 5 → (10, 5)
    expect(cropDrawn([0, 0], [10, 3], 2, false, false)).toEqual([0, 0, 10, 5]);
    expect(cropDrawn([0, 0], [30, 20], null, true, false)).toEqual([0, 0, 30, 30]);  // ⇧ 正方形
    expect(cropDrawn([0, 0], [30, 20], null, false, false)).toEqual([0, 0, 30, 20]); // 自由
    expect(cropDrawn([10, 10], [30, 20], null, false, true)).toEqual([-10, 0, 30, 20]); // alt 从中心
  });
  it('cropResized:被拖边移动对边固定;ratio 两轴联动(角把手取相对伸缩更大者);alt 绕中心', () => {
    const r: [number, number, number, number] = [0, 0, 100, 50];
    // 右下角把手 d=(20,10):两轴都动,对边固定
    expect(cropResized(r, 1, 1, [20, 10], null, false)).toEqual([0, 0, 120, 60]);
    // 左边把手 d=(-20,0):右边缘固定
    expect(cropResized(r, -1, 0, [-20, 0], null, false)).toEqual([-20, 0, 100, 50]);
    // ratio 2:1 角把手:相对伸缩 w/2=60 vs h=60 → 相等,结果 120x60
    expect(cropResized(r, 1, 1, [20, 10], 2, false)).toEqual([0, 0, 120, 60]);
    // ratio 2:1 只拖上边(h=60):宽随比例联动=120,两轴都变(上游 resized 同款)
    expect(cropResized(r, 0, -1, [0, -10], 2, false)).toEqual([-10, -10, 110, 50]);
    // alt 绕中心:对边对称移动
    expect(cropResized(r, 1, 0, [20, 0], null, true)).toEqual([-20, 0, 120, 50]);
  });
  it('cropHitTurned/cropCorners:斜置框命中在其自身轴上;扫角/15° 吸附', () => {
    const r: [number, number, number, number] = [10, 10, 50, 30]; // 中心 (30,20)
    // 正置右上 (50,10) 绕中心转 90°(屏幕顺时针):dx=20,dy=-10 → (30+10, 20+20)=(40,40)
    const cs = cropCorners(r, 90);
    expect(cs[1][0]).toBeCloseTo(40);
    expect(cs[1][1]).toBeCloseTo(40);
    // 点在斜置框的自身轴上才能命中把手:局部右上角在页面 (40,40)
    expect(cropHitTurned(r, 90, [40, 40], 2).kind).toBe('handle');
    expect(cropHitTurned(r, 90, [30, 20], 2).kind).toBe('inside');
    expect(cropHitTurned(r, 90, [0, 0], 2).kind).toBe('outside');
    // grab=指向左(π),指针扫到上方(-π/2):归一化扫角 = +90
    expect(cropTurnedAngle([30, 20], Math.PI, 0, [30, 5], false)).toBeCloseTo(90);
    expect(cropTurnedAngle([0, 0], 0, 0, [10, 1], true)).toBeCloseTo(0);            // ⇧ 15° 吸附
  });
  it('cropFittedRatio:保中心只减不增;cropFitted:旋转后内含于画布的最大居中框', () => {
    const r: [number, number, number, number] = [0, 0, 100, 50];
    // 已是 2:1 → 原样;16:9(h·ratio=88.9 < w)→ 宽受限内缩、高不变
    expect(cropFittedRatio(r, 2)).toEqual(r);
    const f16 = cropFittedRatio(r, 16 / 9)!;
    expect(f16[2] - f16[0]).toBeCloseTo(800 / 9);
    expect(f16[3] - f16[1]).toBeCloseTo(50);
    expect((f16[0] + f16[2]) / 2).toBeCloseTo(50);
    // 拉直 fitted:200x100 框转 45° 内含于 1000x800:k = min(1000/(150√2), 800/(150√2)) = 800/(150√2)
    const fitted = cropFitted(200, 100, 1000, 800, 45)!;
    const k = 800 / (150 * Math.SQRT2);
    expect(fitted[2] - fitted[0]).toBeCloseTo(200 * k);
    expect(fitted[3] - fitted[1]).toBeCloseTo(100 * k);
    expect((fitted[0] + fitted[2]) / 2).toBeCloseTo(500);
    expect((fitted[1] + fitted[3]) / 2).toBeCloseTo(400);
    expect(cropFitted(0, 100, 1000, 800, 45)).toBeNull();
  });
  it('cropStraightenAngle/cropFrameAngle:近水平/近竖直线转到最近轴(引擎 straighten_angle)', () => {
    expect(cropStraightenAngle(100, 8.7)).toBeCloseTo(-(Math.atan(8.7 / 100) * 180) / Math.PI, 9); // 线向右下倾 atan(0.087)°
    expect(cropStraightenAngle(100, -8.7)).toBeCloseTo((Math.atan(8.7 / 100) * 180) / Math.PI, 9);
    expect(cropStraightenAngle(8.7, 100)).toBeCloseTo(5, 1);      // 近竖直 → 转到竖直
    // 线向右上倾 5°:图像顺时针转 5° 转平 → 框相对图像逆时针 5°(frame=-rot)
    expect(cropFrameAngle([0, 0], [100, -8.7], 1)).toBeCloseTo(-(Math.atan(8.7 / 100) * 180) / Math.PI, 9);
    expect(cropFrameAngle([0, 0], [1, 0], 10)).toBeNull();     // 线长不足
  });
});

describe('移动工具纯函数(photocraft move_ui/move_mods 口径)', () => {
  it('constrainMove:无 Shift 原样取整;4 方向锁主轴;8 方向锁 45°(投影长度)', () => {
    expect(constrainMove([10.4, -3.6], null, 0)).toEqual({ dx: 10, dy: -4 });
    // 整层(4 方向):水平为主锁 x 轴,投影长度=|dx|
    expect(constrainMove([15, 3], null, 4)).toEqual({ dx: 15, dy: 0 });
    expect(constrainMove([3, 15], null, 4)).toEqual({ dx: 0, dy: 15 });
    expect(constrainMove([-8, -2], null, 4)).toEqual({ dx: -8, dy: 0 });
    // 浮动像素(8 方向):[14,12] 40.6° → 最近 45° 方向,投影长度 18.38 → (13,13)(上游测试同款)
    expect(constrainMove([14, 12], null, 8)).toEqual({ dx: 13, dy: 13 });
    // 恰在 45° 方向上的偏移保持不变;5.7° 偏差的会被吸到 180° 轴上
    expect(constrainMove([10, 10], null, 8)).toEqual({ dx: 10, dy: 10 });
    expect(constrainMove([-10, -1], null, 8)).toEqual({ dx: -10, dy: 0 });
  });
  it('constrainMove:8° 迟滞——未越过半程线+8° 前保持上一方向', () => {
    // 45° 已锁定(prev),新偏移 30°(差 15°):半程 22.5°+8°=30.5° > 15° → 保持 45°
    const prev: [number, number] = [13, 13];
    const locked = constrainMove([17.3, 10], prev, 8);
    expect(locked.dx !== 0 && locked.dx === locked.dy).toBe(true); // 仍在 45° 线
    // 新偏移 0°(与 45° 差 45° > 30.5°)→ 切换到水平轴
    expect(constrainMove([20, 0], prev, 8)).toEqual({ dx: 20, dy: 0 });
    // prev 零向量不参与迟滞
    expect(constrainMove([0, 9], [0, 0], 4)).toEqual({ dx: 0, dy: 9 });
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
  it('moveBounds:链接层扩散——与根层同 linkGroup 的层并入脏矩形(引擎 with_links 口径)', () => {
    const layers = [
      { id: 1, bounds: [0, 0, 10, 10] as [number, number, number, number] | null, selected: false, linkGroup: 1 },
      { id: 2, bounds: [30, 30, 10, 10] as [number, number, number, number] | null, selected: true, linkGroup: 1 },
      { id: 3, bounds: [50, 0, 5, 5] as [number, number, number, number] | null, selected: false, linkGroup: 2 },
      { id: 4, bounds: [8, 8, 4, 4] as [number, number, number, number] | null, selected: false, linkGroup: null },
    ];
    // 选中 2(链组 1):1 一起动 → 并集 (0,0)-(40,40);3(组 2)与未链接的 4 不动
    expect(moveBounds(layers, null, 64, 64)).toEqual([0, 0, 40, 40]);
    // 无链接组:保持原并集行为
    expect(moveBounds([layers[3]], 4, 64, 64)).toEqual([8, 8, 4, 4]);
  });
});

describe('多边形套索(上游 constrained_polygon_point + lasso 组循环口径)', () => {
  it('Shift 45° 约束:八个方向全数吸附、长度保持、零长度原样', () => {
    const f = [100, 100];
    // 水平/垂直:已对齐的方向原样通过
    expect(constrainPolygonPoint(f, [180, 100])).toEqual([180, 100]);
    expect(constrainPolygonPoint(f, [100, 140])).toEqual([100, 140]);
    // 20°(dy=29.12,dx=80,长度 85.14)→ 吸附到 0°(水平),长度保持
    const shallow = constrainPolygonPoint(f, [180, 129.12]);
    expect(shallow[1]).toBeCloseTo(100, 6);
    expect(shallow[0]).toBeCloseTo(185.14, 2);
    // 75°(≥67.5°)→ 吸附到 90°(垂直),长度保持
    const steep = constrainPolygonPoint(f, [121.43, 180]);
    expect(steep[0]).toBeCloseTo(100, 2);
    expect(steep[1]).toBeCloseTo(182.82, 2);
    // 225° 对角方向(已对齐,原样)
    const diag = constrainPolygonPoint(f, [40, 40]);
    expect(diag[0]).toBeCloseTo(40, 6);
    expect(diag[1]).toBeCloseTo(40, 6);
    // 零长度与非有限输入原样返回
    expect(constrainPolygonPoint(f, [100, 100])).toEqual([100, 100]);
    expect(constrainPolygonPoint(f, [NaN, 50])).toEqual([NaN, 50]);
  });

  it('L 键套索组循环:组内三态轮转,组外回自由套索', () => {
    expect(nextLassoTool('lasso')).toBe('polygonLasso');
    expect(nextLassoTool('polygonLasso')).toBe('magneticLasso');
    expect(nextLassoTool('magneticLasso')).toBe('lasso');
    expect(nextLassoTool('move')).toBe('lasso');
    expect(nextLassoTool(undefined)).toBe('lasso');
  });
});

describe('磁性套索纯函数(上游 magnetic_lasso_ui 口径)', () => {
  it('自动落点间距:频率 100→8 屏幕 px、0→98、默认 57→≈47;除以缩放折文档 px', () => {
    expect(magneticSpacing(100, 1)).toBeCloseTo(8, 6);
    expect(magneticSpacing(0, 1)).toBeCloseTo(98, 6);
    expect(magneticSpacing(57, 1)).toBeCloseTo(46.7, 6);
    expect(magneticSpacing(57, 0.5)).toBeCloseTo(93.4, 1);
    expect(magneticSpacing(NaN, 1)).toBeCloseTo(46.7, 6);
  });

  it('pathLength / cutPathAtLength:截点插值、总长不足拒绝', () => {
    const l = [[0, 0], [30, 0], [30, 40]];
    expect(pathLength(l)).toBeCloseTo(70, 6);
    // 截 50:第二段走 20 → 截点 (30, 20),截头含前两点+截点
    const [head, at] = cutPathAtLength(l, 50)!;
    expect(head).toEqual([[0, 0], [30, 0], [30, 20]]);
    expect(at).toEqual([30, 20]);
    // 总长 < len+1 → null(上游 cut 生效条件)
    expect(cutPathAtLength(l, 70)).toBeNull();
    expect(cutPathAtLength(l, 69.5)).toBeNull();
    expect(cutPathAtLength([l[0]], 5)).toBeNull();
  });

  it('nearMagneticStart:半径内且总长 > 2×半径才闭合(防短边误闭合)', () => {
    const first = [100, 100];
    expect(nearMagneticStart(first, [104, 103], 8, 100)).toBe(true);
    expect(nearMagneticStart(first, [104, 103], 8, 15)).toBe(false); // 总长不足
    expect(nearMagneticStart(first, [120, 100], 8, 100)).toBe(false); // 距离出半径
    expect(nearMagneticStart(undefined, [104, 103], 8, 100)).toBe(false);
  });
});
