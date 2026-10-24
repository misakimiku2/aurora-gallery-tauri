/**
 * 画笔/橡皮的**命令式流程**（2026-10-24 画笔轮 → 26 架构轮 → 25 显示正确性轮）。
 *
 * ## 架构：内存位图是真身，文件是影子
 *
 * 落笔时按目标的位图键（`layerBitmaps`）物化像素缓冲，笔划期间图章先画进独立
 * **笔划缓冲**（一笔之内不叠深），同时**逐帧增量合成进位图仓**：
 *
 * 1. 物化就绪即建整幅**快照**（改前基准）；
 * 2. 每帧把新图章的文档空间脏区（经 target.transform 映射 + 夹紧）在仓里
 *    "复位 → 裁剪 → 重合整只笔划"（`compositeLayerRegion`；软边图章叠加不幂等
 *    所以必须回基准，裁剪保证区域外旧图章不重复叠）；
 * 3. 版本 +1 → 主画布的像素载体重画该层——**没有预览画布**（旧方案把"缓冲 +
 *    笔划"画在盖着一切的 overlay 上，不带蒙版、不参与层级/混合、分辨率还重采样
 *    ——"下层飞到最上/清晰度变化/蒙版消失"的元凶，已退役）；
 * 4. 抬笔：before 取自快照、after 取自仓，两块小位图作为**像素补丁**进撤销栈
 *    （`pushPaintOp`）——撤销就是把 before 写回仓，零文件依赖。
 *
 * **图层与蒙版走同一条路**（2026-10-25 统一）：蒙版位图的每次版本 +1 会让
 * `EditorCanvasLayers.MaskedPixels` 同帧重合"图层 × 蒙版"，所以蒙版笔划的实时
 * 显隐、撤销的原子重画天然正确——不再需要 live masking 预览引擎与 blob URL
 * 收场（那是"抬笔刷新一下"的根源）。蒙版笔划唯一额外做的事：顺带物化图层
 * 位图（MaskedPixels 合成需要它）。
 *
 * **全程不碰文件**：烘焙由 `brushBake` 的空闲调度器在停笔 800ms 后合并做（笔划
 * 期间 `beginStrokePause` 让路，见 layerBitmaps），导出/保存入口
 * `flushPaintBakes + remapDocBitmapSources`。
 *
 * ## 坐标（与渲染侧同一套数学，见 brushPaint.paintTargetOf）
 *
 * 图章永远画在**文档坐标**：笔划缓冲是画布尺寸、恒等变换；目标缓冲通过
 * `ctx.setTransform(target.transform)` 接收同样的图章——图层带旋转/缩放时
 * 笔触自动落成正确的形状。
 */
import { useCallback, useRef } from 'react';
import type { EditorDocument } from '../../types';
import { layerLocks, resolveActiveLayer } from './layerModel';
import {
  beginStrokePause,
  captureBitmapRect,
  endStrokePause,
  layerKey,
  maskKey,
  materializeBitmap,
  mutatePixels,
} from './layerBitmaps';
import { blankCanvas } from './brushBake';
import type { PaintPatch } from './historyStack';
import {
  colorLuminance,
  luminanceToHex,
  paintTargetOf,
  strokeDirtyRect,
  strokeStamps,
  type PaintTarget,
  type StampPoint,
} from './brushPaint';
import type { AffineMatrix } from './layerTransform';

/** 画笔设置（选项条_owned，ImageEditor 持有）。 */
export interface BrushSettings {
  /** 笔径（文档像素，1..300） */
  size: number;
  /** 硬度（0..100：100 = 硬边，0 = 全柔） */
  hardness: number;
  /** 笔画不透明度（1..100；一笔只乘一次，不在图章间叠深） */
  opacity: number;
}

export interface BrushSessionDeps {
  tool: 'brush' | 'eraser';
  settings: BrushSettings;
  foreground: string;
  background: string;
  doc: EditorDocument | undefined;
  transform: { x: number; y: number; scale: number };
  onDocumentChange: (next: EditorDocument) => void;
  /** 撤销栈的像素补丁入口（useEditorHistory.pushPaintOp） */
  pushPaintOp: (patch: PaintPatch) => void;
  flashNotice: (next: { status: 'done' | 'error'; text: string }, ttl?: number) => void;
}

interface StrokeSession {
  layerId: string;
  /** 位图键（layerKey / maskKey）——补丁与位图仓都认它 */
  bitmapKey: string;
  target: PaintTarget;
  /** 笔画不透明度 0..1（合成时一次乘上） */
  alpha: number;
  radius: number;
  hardnessInner: number; // 0..0.98：径向渐变的实心内圈比例
  /** 笔划颜色（#rrggbb；橡皮擦图层时无意义，只用 alpha） */
  color: string;
  /** 合成模式（作用于目标缓冲）：普通 / 橡皮擦图层 / 锁透明像素 */
  composite: 'over' | 'erase' | 'atop';
  /** 笔划缓冲（画布尺寸、恒等变换，全 alpha 图章） */
  stroke: HTMLCanvasElement;
  strokeCtx: CanvasRenderingContext2D;
  /** 目标像素缓冲（异步物化；抬笔时必须就绪） */
  buffer: HTMLCanvasElement | null;
  bufferPromise: Promise<HTMLCanvasElement>;
  /**
   * 落笔瞬间目标缓冲的整幅快照：逐帧合成的复位基准 + 撤销补丁 before 的出处。
   * null = 位图还没物化好（合成会等它——见 bufferPromise 的补建分支）。
   */
  snapshot: HTMLCanvasElement | null;
  /** 原始指针轨迹（文档坐标）——每帧重算图章、只画新增的尾巴 */
  points: StampPoint[];
  stampsDrawn: number;
  toDoc: (clientX: number, clientY: number) => StampPoint;
  raf: number;
}

/** 画一批图章（径向渐变实现硬度：内圈实心 → 边缘淡出）。 */
function drawStamps(
  ctx: CanvasRenderingContext2D,
  stamps: StampPoint[],
  from: number,
  radius: number,
  inner: number,
  color: string,
) {
  const r = Math.max(0.5, radius);
  for (let i = from; i < stamps.length; i += 1) {
    const p = stamps[i];
    const g = ctx.createRadialGradient(p.x, p.y, r * inner, p.x, p.y, r);
    g.addColorStop(0, color);
    g.addColorStop(1, `${color}00`); // 同色透明（#rrggbb → #rrggbb00）
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** 缓冲的整幅快照（笔划的改前基准）。 */
function snapshotOf(buffer: HTMLCanvasElement): HTMLCanvasElement | null {
  const snap = blankCanvas(buffer.width, buffer.height);
  const ctx = snap.getContext('2d');
  if (!ctx) return null;
  ctx.drawImage(buffer, 0, 0);
  return snap;
}

/** 从快照读一块像素（撤销补丁的 before；rect 已被 strokeDirtyRect 夹进缓冲范围）。 */
function regionImageData(
  snapshot: HTMLCanvasElement | null,
  rect: { x: number; y: number; w: number; h: number },
): ImageData | null {
  if (!snapshot || rect.w <= 0 || rect.h <= 0) return null;
  const ctx = snapshot.getContext('2d');
  if (!ctx) return null;
  try {
    return ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  } catch {
    return null;
  }
}

interface IntRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 一批图章的文档空间外接框（± pad）。 */
function stampsDocRect(stamps: StampPoint[], from: number, pad: number): IntRect | null {
  if (from >= stamps.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = from; i < stamps.length; i += 1) {
    const p = stamps[i];
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { x: minX - pad, y: minY - pad, w: maxX - minX + pad * 2, h: maxY - minY + pad * 2 };
}

/** 矩形四角经仿射映射后的整数外接框（保守包络，带旋转也安全）。 */
function mapRectBBox(m: AffineMatrix, r: IntRect): IntRect {
  const [a, b, c, d, e, f] = m;
  const pts: Array<[number, number]> = [
    [r.x, r.y],
    [r.x + r.w, r.y],
    [r.x, r.y + r.h],
    [r.x + r.w, r.y + r.h],
  ];
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [px, py] of pts) {
    const x = px * a + py * c + e;
    const y = px * b + py * d + f;
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  return { x: Math.floor(x0), y: Math.floor(y0), w: Math.ceil(x1) - Math.floor(x0), h: Math.ceil(y1) - Math.floor(y0) };
}

function clampRect(r: IntRect, w: number, h: number): IntRect | null {
  const x = Math.max(0, r.x);
  const y = Math.max(0, r.y);
  const x1 = Math.min(w, r.x + r.w);
  const y1 = Math.min(h, r.y + r.h);
  if (x1 <= x || y1 <= y) return null;
  return { x, y, w: x1 - x, h: y1 - y };
}

/**
 * 笔划的**增量合成进位图仓**（图层/蒙版同一条路）：把 [from, stamps) 这段新图章
 * 覆盖的区域重建——先从快照复位（软边图章叠加不幂等，区域重画必须回到改前基准），
 * 再裁剪着把**整只笔划**按目标变换合成进来（与一次性合成同一口径，区域外的旧
 * 图章不会被重复叠）。版本 +1 → 主画布重画该层（图层 = LayerPixels 直拷，
 * 蒙版 = MaskedPixels 重合"图层 × 蒙版"）。
 */
function compositeLayerRegion(s: StrokeSession, stamps: StampPoint[], from: number): boolean {
  const snap = s.snapshot;
  if (!snap) return false;
  const docRect = stampsDocRect(stamps, from, s.radius + 1);
  if (!docRect) return true; // 这段没有新图章：无事可做，不是失败
  const r = clampRect(mapRectBBox(s.target.transform, docRect), snap.width, snap.height);
  if (!r) return true; // 区域整个落在缓冲外
  return mutatePixels(s.bitmapKey, ctx => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(snap, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    ctx.beginPath();
    ctx.rect(r.x, r.y, r.w, r.h);
    ctx.clip();
    const m = s.target.transform;
    ctx.setTransform(m[0], m[1], m[2], m[3], m[4], m[5]);
    ctx.globalAlpha = s.alpha;
    ctx.globalCompositeOperation =
      s.composite === 'erase' ? 'destination-out' : s.composite === 'atop' ? 'source-atop' : 'source-over';
    ctx.drawImage(s.stroke, 0, 0);
  });
}

/** 半截笔迹善后：位图仓整幅回到快照（笔画中途层被删 / 合成失败，这一笔彻底没发生）。 */
function restoreLayerFromSnapshot(s: StrokeSession): void {
  const snap = s.snapshot;
  if (!snap) return;
  mutatePixels(s.bitmapKey, ctx => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, snap.width, snap.height);
    ctx.drawImage(snap, 0, 0);
  });
}

export function useEditorBrush(opts: { deps: BrushSessionDeps }) {
  const depsRef = useRef(opts.deps);
  depsRef.current = opts.deps;
  const sessionRef = useRef<StrokeSession | null>(null);

  const finishStroke = useCallback(async () => {
    const s = sessionRef.current;
    sessionRef.current = null;
    window.removeEventListener('pointermove', onStrokeMove);
    window.removeEventListener('pointerup', onStrokeUp);
    if (!s) return;
    cancelAnimationFrame(s.raf);

    const d = depsRef.current;
    try {
      const buffer = await s.bufferPromise;
      // 补上最后一段的强制封口图章（绘制期间的前缀稳定序列见 brushPaint）
      const finalStamps = strokeStamps(s.points, s.radius * 2, true);
      const from = s.stampsDrawn;
      drawStamps(s.strokeCtx, finalStamps, s.stampsDrawn, s.radius, s.hardnessInner, s.color);
      s.stampsDrawn = finalStamps.length;
      // 笔画期间层被删了：只丢弃，不报错；把逐帧合进去的半截笔迹从快照抹回去
      const gone = !(d.doc?.layers ?? []).some(l => l.id === s.layerId);
      if (gone) {
        restoreLayerFromSnapshot(s);
        s.snapshot = null;
        return;
      }
      const rect = strokeDirtyRect(finalStamps, s.radius, s.target.transform, buffer.width, buffer.height);
      if (!rect) {
        s.snapshot = null;
        return;
      }
      // 位图仓在笔划期间已被逐帧写到最新，快照就是改前基准。极慢物化
      // （pointerup 之后才就绪）= 一次都没合过 → 此刻补建快照并整笔一次合成。
      let coverFrom = from;
      if (!s.snapshot) {
        s.snapshot = snapshotOf(buffer);
        coverFrom = 0;
      }
      const ok = compositeLayerRegion(s, finalStamps, coverFrom);
      const before = regionImageData(s.snapshot, rect);
      const after = captureBitmapRect(s.bitmapKey, rect);
      if (ok && before && after) {
        d.pushPaintOp({ key: s.bitmapKey, x: rect.x, y: rect.y, before, after });
        // 只置 dirty（source/几何都没变 → 签名不变，不会多出撤销步）
        const doc = d.doc;
        if (doc) d.onDocumentChange({ ...doc, dirty: true });
      }
      s.snapshot = null;
    } catch (e) {
      // 完整错误进日志（控制台 + 日志文件）——提示条只露前半句，日志里能看全链路
      (await import('../../utils/logger')).error('[画笔] 这一笔合成失败：', String(e));
      // 位图仓可能留着逐帧合成的半截笔迹：回到快照 = 这一笔彻底没发生
      restoreLayerFromSnapshot(s);
      s.snapshot = null;
      d.flashNotice({ status: 'error', text: `这一笔没能画上：${String(e)}` }, 8000);
    } finally {
      endStrokePause(); // 空闲烘焙让路的解除（最后一笔结束时 brushBake 补排）
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onStrokeMove = useCallback(
    (e: PointerEvent) => {
      const s = sessionRef.current;
      if (!s) return;
      if (e.buttons === 0) {
        void finishStroke(); // 指针在窗外抬起漏了事件：按结束处理
        return;
      }
      const p = s.toDoc(e.clientX, e.clientY);
      const last = s.points[s.points.length - 1];
      if (last && Math.hypot(p.x - last.x, p.y - last.y) < 0.5) return; // 手抖去抖
      s.points.push(p);
      // 每帧重算图章序列、只画新增的尾巴（全量算很便宜，避免增量状态机）
      cancelAnimationFrame(s.raf);
      s.raf = requestAnimationFrame(() => {
        const stamps = strokeStamps(s.points, s.radius * 2);
        const from = s.stampsDrawn;
        drawStamps(s.strokeCtx, stamps, s.stampsDrawn, s.radius, s.hardnessInner, s.color);
        s.stampsDrawn = stamps.length;
        // 增量合成进位图仓——主画布订阅版本自己重画（层级/蒙版/清晰度全对）；
        // 快照未就绪（位图物化中）的帧先攒着，就绪时会一次补合
        if (s.snapshot) compositeLayerRegion(s, stamps, from);
      });
    },
    [finishStroke],
  );

  const onStrokeUp = useCallback(() => void finishStroke(), [finishStroke]);

  /**
   * 画布 mousedown 入口（brush/eraser 工具时由 ImageEditor 调）。
   * 返回 true = 事件已消费（不管有没有真的落笔，都别再走选层逻辑）。
   */
  const beginStroke = useCallback(
    (e: React.MouseEvent, container: HTMLElement): boolean => {
      const d = depsRef.current;
      const doc = d.doc;
      if (!doc?.canvas) return false;
      if (sessionRef.current) return true; // 上一笔还没结束（多点触控等）：忽略
      const layer = resolveActiveLayer(doc);
      if (!layer || layer.kind === 'group') {
        d.flashNotice({ status: 'error', text: '先在图层面板选中一个像素图层' });
        return true;
      }
      const locks = layerLocks(layer);
      if (locks.pixel) {
        d.flashNotice({ status: 'error', text: '该图层已锁定像素，不能作画' });
        return true;
      }
      const targetSel = doc.activeTarget === 'mask' && layer.mask ? 'mask' : 'image';
      const target = paintTargetOf(layer, targetSel);
      if (!target) {
        d.flashNotice({
          status: 'error',
          text:
            targetSel === 'mask'
              ? '蒙版不可作画（已停用或没有像素）'
              : '该图层不可作画（没有像素或被压成线）',
        });
        return true;
      }
      // 颜色：画图层 = 前景；橡皮擦图层 = 无色（只吃 alpha，锁透明像素时干脆禁用）；
      // 蒙版 = 灰度（画笔用前景亮度、橡皮用背景亮度——PS 的"橡皮=画背景色"在灰度
      // 蒙版上的口径）
      let color = '#ffffff';
      let composite: StrokeSession['composite'] = 'over';
      if (target.kind === 'mask') {
        color = luminanceToHex(colorLuminance(d.tool === 'brush' ? d.foreground : d.background));
      } else if (d.tool === 'brush') {
        color = d.foreground;
        if (locks.transparent) composite = 'atop'; // 锁透明像素：只画进已有像素
      } else {
        if (locks.transparent) {
          d.flashNotice({ status: 'error', text: '已锁定透明像素，橡皮不可用（不许改 alpha）' });
          return true;
        }
        composite = 'erase';
      }

      const size = Math.min(300, Math.max(1, Math.round(d.settings.size)));
      const stroke = blankCanvas(doc.canvas.width, doc.canvas.height);
      const strokeCtx = stroke.getContext('2d');
      if (!strokeCtx) return false;

      const bitmapKey = target.kind === 'mask' ? maskKey(layer.id) : layerKey(layer.id);
      const sourcePath =
        target.kind === 'mask' && layer.mask
          ? layer.mask.source
          : (layer.source as string);
      const rect = container.getBoundingClientRect();
      const t = d.transform; // 视口变换取落笔瞬间（笔画中滚轮缩放极罕见，不追）

      const session: StrokeSession = {
        layerId: layer.id,
        bitmapKey,
        target,
        alpha: Math.min(1, Math.max(0.01, d.settings.opacity / 100)),
        radius: size / 2,
        hardnessInner: Math.min(0.98, Math.max(0, d.settings.hardness / 100)),
        color,
        composite,
        stroke,
        strokeCtx,
        buffer: null,
        snapshot: null,
        bufferPromise: materializeBitmap(bitmapKey, {
          sourcePath,
          width: target.width,
          height: target.height,
        }).then(b => {
          if (sessionRef.current === session) {
            session.buffer = b;
            if (!session.snapshot) {
              // 就绪即建快照，把落笔至今的图章一次合成进位图仓——此后逐帧增量
              session.snapshot = snapshotOf(b);
              compositeLayerRegion(session, strokeStamps(session.points, session.radius * 2), 0);
            }
          }
          return b;
        }),
        points: [],
        stampsDrawn: 0,
        toDoc: (clientX, clientY) => ({
          x: (clientX - rect.left - t.x) / t.scale,
          y: (clientY - rect.top - t.y) / t.scale,
        }),
        raf: 0,
      };
      sessionRef.current = session;
      beginStrokePause(); // 笔划期间空闲烘焙让路（版本逐帧 +1，别空转编码）
      // 蒙版笔划：显示走 MaskedPixels（图层 × 蒙版合成），顺带物化图层位图——
      // 没有它合成不出来（LayerElement 的 effect 也会兜底物化）
      if (target.kind === 'mask' && layer.source) {
        void materializeBitmap(layerKey(layer.id), {
          sourcePath: layer.source as string,
          width: layer.naturalWidth,
          height: layer.naturalHeight,
        }).catch(() => undefined);
      }
      window.addEventListener('pointermove', onStrokeMove);
      window.addEventListener('pointerup', onStrokeUp);
      onStrokeMove(e.nativeEvent as PointerEvent);
      return true;
    },
    [onStrokeMove, onStrokeUp],
  );

  return { beginStroke, isPainting: () => !!sessionRef.current };
}
