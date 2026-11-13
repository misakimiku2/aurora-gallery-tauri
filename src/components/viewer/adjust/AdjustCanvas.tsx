import React, { useCallback, useEffect, useRef } from 'react';
import {
  AdjustCropNorm,
  AdjustParams,
  cssFilterForTone,
} from '../../../utils/adjust';
import {
  AdjustedFrame,
  buildAdjustedFrame,
  frameCropRect,
} from '../../../utils/adjustCanvasDraw';

export interface AdjustCanvasProps {
  /** 展示用原图 URL(asset 协议;WebView 解码已按 EXIF 自动转正) */
  src: string;
  params: AdjustParams;
  /** 开启裁剪拖拽交互(调整抽屉的裁剪态) */
  interactive?: boolean;
  /** 显示裁剪覆盖层(暗色遮罩 + 九宫格 + 手柄) */
  showCropUI?: boolean;
  /** 锁定裁剪宽高比 w/h;null = 自由 */
  cropAspect?: number | null;
  onCropChange?: (crop: AdjustCropNorm | null) => void;
  className?: string;
  style?: React.CSSProperties;
}

type DragMode =
  | { kind: 'none' }
  | { kind: 'move'; start: AdjustCropNorm; grabX: number; grabY: number }
  | {
      kind: 'resize';
      corner: string;
      anchor: { x: number; y: number };
      startRect: AdjustCropNorm;
      aspect: number | null;
    };

const HANDLE_HIT = 14; // 命中半径(逻辑像素)

/**
 * 调整预览画布(Canvas2D,视口尺寸 —— 前端不持有全尺寸像素缓冲,验收口径 1)。
 *
 * 渲染管线(与 Rust bake_edits / 缩略图联动同口径):
 *   WebView 转正后的 <img> → buildAdjustedFrame(flip/rotate90/拉直)
 *   → ctx.filter(CSS 内建 + SVG #aurora-adjust-tt,公式与 Rust apply_tone_rgb 一致)
 *   → 裁剪子矩形 contain 摆放进视口。
 * 交互态(showCropUI)额外画:框外暗遮罩、九宫格、四角/四边手柄。
 */
export const AdjustCanvas: React.FC<AdjustCanvasProps> = ({
  src,
  params,
  interactive = false,
  showCropUI = false,
  cropAspect = null,
  onCropChange,
  className,
  style,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<AdjustedFrame | null>(null);
  const viewRef = useRef({ vx: 0, vy: 0, scale: 1, dpr: 1 });
  const dragRef = useRef<DragMode>({ kind: 'none' });
  const rafRef = useRef<number | null>(null);
  const stateRef = useRef({ params, interactive, showCropUI, cropAspect, onCropChange });
  stateRef.current = { params, interactive, showCropUI, cropAspect, onCropChange };

  // 1) 加载位图
  useEffect(() => {
    if (!src) {
      imgRef.current = null;
      frameRef.current = null;
      return;
    }
    let cancelled = false;
    const img = new Image();
    // asset 协议对每响应带 Access-Control-Allow-Origin(见 ImageViewer.tsx 2154 注释)
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      if (cancelled) return;
      imgRef.current = img;
      // ⚠️ 帧必须在这里重建:参数 effect 只在 params 变化时跑,异步加载完成时它早已
      // 跳过(imgRef 当时还是 null)——否则画布空白,直到用户动一下几何参数才显形。
      frameRef.current = buildAdjustedFrame(img, stateRef.current.params);
      scheduleDraw();
    };
    img.onerror = () => {
      if (!cancelled) {
        imgRef.current = null;
        frameRef.current = null;
        scheduleDraw();
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  // 2) 参数变化 → 重建几何帧(影调在 draw 时经 ctx.filter 施加,不进帧)
  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    frameRef.current = buildAdjustedFrame(img, params);
    scheduleDraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const draw = useCallback(() => {
    rafRef.current = null;
    const cv = canvasRef.current;
    const frame = frameRef.current;
    if (!cv) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cw = Math.max(1, Math.round(cv.clientWidth * dpr));
    const ch = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== cw || cv.height !== ch) {
      cv.width = cw;
      cv.height = ch;
    }
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!frame) return;

    const { params: p, interactive: it, showCropUI: cropUI } = stateRef.current;
    // 交互态画完整帧(裁剪覆盖层叠加);非交互态直接呈现裁剪结果
    const { sx, sy, sw, sh } = it
      ? { sx: 0, sy: 0, sw: frame.width, sh: frame.height }
      : frameCropRect(frame, p);
    const viewScale = Math.min(cw / sw, ch / sh);
    const vx = (cw - sw * viewScale) / 2;
    const vy = (ch - sh * viewScale) / 2;
    viewRef.current = { vx, vy, scale: viewScale, dpr };

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const filter = cssFilterForTone(p.tone);
    if (filter !== 'none') ctx.filter = filter;
    ctx.drawImage(frame.canvas, sx, sy, sw, sh, vx, vy, sw * viewScale, sh * viewScale);
    ctx.restore();

    // 裁剪覆盖层(不被影调滤镜影响)
    if (it && cropUI && p.geo.cropNorm) {
      const crop = p.geo.cropNorm;
      const x = vx + crop.x * frame.width * viewScale;
      const y = vy + crop.y * frame.height * viewScale;
      const w = crop.w * frame.width * viewScale;
      const h = crop.h * frame.height * viewScale;
      ctx.save();
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.beginPath();
      ctx.rect(0, 0, cw, ch);
      ctx.rect(x, y, w, h);
      ctx.fill('evenodd');
      // 边框 + 九宫格
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      ctx.lineWidth = Math.max(1, 1.5 * dpr);
      ctx.strokeRect(x, y, w, h);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = Math.max(1, 1 * dpr);
      ctx.beginPath();
      for (let i = 1; i < 3; i++) {
        ctx.moveTo(x + (w * i) / 3, y);
        ctx.lineTo(x + (w * i) / 3, y + h);
        ctx.moveTo(x, y + (h * i) / 3);
        ctx.lineTo(x + w, y + (h * i) / 3);
      }
      ctx.stroke();
      // 四角 + 四边手柄
      ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
      const r = 4 * dpr;
      const pts: Array<[number, number]> = [
        [x, y], [x + w / 2, y], [x + w, y],
        [x, y + h / 2], [x + w, y + h / 2],
        [x, y + h], [x + w / 2, y + h], [x + w, y + h],
      ];
      for (const [px, py] of pts) {
        ctx.beginPath();
        ctx.arc(px, py, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
    }
  }, []);

  const scheduleDraw = useCallback(() => {
    if (rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => draw());
  }, [draw]);

  // 3) 尺寸自适应
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => scheduleDraw());
    ro.observe(el);
    return () => ro.disconnect();
  }, [scheduleDraw]);

  useEffect(() => {
    scheduleDraw();
  }, [params, interactive, showCropUI, scheduleDraw]);

  // ── 裁剪交互 ──────────────────────────────────────────────────────────────
  const toCanvasPx = (clientX: number, clientY: number): { x: number; y: number } => {
    const cv = canvasRef.current!;
    const rect = cv.getBoundingClientRect();
    const dpr = viewRef.current.dpr;
    return { x: (clientX - rect.left) * dpr, y: (clientY - rect.top) * dpr };
  };

  const hitTestHandle = (px: number, py: number): string | null => {
    const frame = frameRef.current;
    const crop = stateRef.current.params.geo.cropNorm;
    if (!frame || !crop) return null;
    const { vx, vy, scale } = viewRef.current;
    const x = vx + crop.x * frame.width * scale;
    const y = vy + crop.y * frame.height * scale;
    const w = crop.w * frame.width * scale;
    const h = crop.h * frame.height * scale;
    const tol = HANDLE_HIT * viewRef.current.dpr;
    const pts: Array<[string, number, number]> = [
      ['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y],
      ['w', x, y + h / 2], ['e', x + w, y + h / 2],
      ['sw', x, y + h], ['s', x + w / 2, y + h], ['se', x + w, y + h],
    ];
    for (const [name, hx, hy] of pts) {
      if (Math.abs(px - hx) <= tol && Math.abs(py - hy) <= tol) return name;
    }
    if (px >= x && px <= x + w && py >= y && py <= y + h) return 'inside';
    return null;
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const { interactive: it, showCropUI: cropUI, params: p } = stateRef.current;
    if (!it || !cropUI) return;
    e.stopPropagation();
    e.preventDefault();
    const cv = canvasRef.current!;
    cv.setPointerCapture(e.pointerId);
    const { x: px, y: py } = toCanvasPx(e.clientX, e.clientY);
    const hit = hitTestHandle(px, py);
    const frame = frameRef.current;
    if (!frame) return;
    if (hit && hit !== 'inside') {
      const crop = p.geo.cropNorm!;
      // 固定对角锚点(像素坐标,配合锁比例换算)
      const fx = (v: number): number => v * frame.width;
      const fy = (v: number): number => v * frame.height;
      const anchor =
        hit === 'se' ? { x: fx(crop.x), y: fy(crop.y) }
        : hit === 'sw' ? { x: fx(crop.x + crop.w), y: fy(crop.y) }
        : hit === 'ne' ? { x: fx(crop.x), y: fy(crop.y + crop.h) }
        : hit === 'nw' ? { x: fx(crop.x + crop.w), y: fy(crop.y + crop.h) }
        : hit === 'e' ? { x: fx(crop.x), y: 0 }
        : hit === 'w' ? { x: fx(crop.x + crop.w), y: 0 }
        : hit === 's' ? { x: 0, y: fy(crop.y) }
        : { x: 0, y: fy(crop.y + crop.h) };
      dragRef.current = {
        kind: 'resize',
        corner: hit,
        anchor,
        startRect: { ...crop },
        aspect: stateRef.current.cropAspect,
      };
    } else if (hit === 'inside') {
      dragRef.current = { kind: 'move', start: { ...p.geo.cropNorm! }, grabX: px, grabY: py };
    } else {
      // 空白处按下 = 从锚点拉新框
      const { x: nx, y: ny } = frameNormFromCanvas(px, py);
      dragRef.current = {
        kind: 'resize',
        corner: 'se',
        anchor: { x: nx * frame.width, y: ny * frame.height },
        startRect: { x: clamp01(nx), y: clamp01(ny), w: 0.001, h: 0.001 },
        aspect: stateRef.current.cropAspect,
      };
      stateRef.current.onCropChange?.({ x: clamp01(nx), y: clamp01(ny), w: 0.001, h: 0.001 });
    }
  };

  const frameNormFromCanvas = (px: number, py: number): { x: number; y: number } => {
    const frame = frameRef.current!;
    const { vx, vy, scale } = viewRef.current;
    return {
      x: (px - vx) / (scale * frame.width),
      y: (py - vy) / (scale * frame.height),
    };
  };

  const handlePointerMove = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (drag.kind === 'none') return;
    if (drag.kind === 'move') {
      const frame = frameRef.current;
      if (!frame) return;
      const { x: px, y: py } = toCanvasPx(e.clientX, e.clientY);
      const dpx = (px - drag.grabX) / (viewRef.current.scale * frame.width);
      const dpy = (py - drag.grabY) / (viewRef.current.scale * frame.height);
      let nx = drag.start.x + dpx;
      let ny = drag.start.y + dpy;
      nx = Math.min(Math.max(nx, 0), 1 - drag.start.w);
      ny = Math.min(Math.max(ny, 0), 1 - drag.start.h);
      stateRef.current.onCropChange?.({ x: nx, y: ny, w: drag.start.w, h: drag.start.h });
      return;
    }
    // resize:锚点 = 固定对角;锁比例时按实时方向重建(允许跨越锚点反向)
    const frame = frameRef.current;
    if (!frame) return;
    const { x: px, y: py } = toCanvasPx(e.clientX, e.clientY);
    const p = frameNormFromCanvas(px, py);
    const ax = drag.anchor.x / frame.width;
    const ay = drag.anchor.y / frame.height;
    const isCorner = ['nw', 'ne', 'sw', 'se'].includes(drag.corner);
    if (isCorner) {
      const right = drag.corner === 'se' || drag.corner === 'ne' ? true
        : drag.corner === 'sw' || drag.corner === 'nw' ? false
        : p.x >= ax;
      const down = drag.corner === 'se' || drag.corner === 'sw' ? true
        : drag.corner === 'ne' || drag.corner === 'nw' ? false
        : p.y >= ay;
      let w = Math.abs(p.x - ax);
      let h = Math.abs(p.y - ay);
      const aspect = drag.aspect;
      if (aspect && w > 0) {
        // 锁比例:宽随指针、高按比例,双向夹进 [0,1] 盒
        const maxW = right ? 1 - ax : ax;
        const maxH = down ? 1 - ay : ay;
        w = Math.min(w, maxW, maxH * aspect);
        h = w / aspect;
      } else {
        w = Math.abs(p.x - ax);
        h = Math.abs(p.y - ay);
      }
      if (w > 0.001 && h > 0.001) {
        stateRef.current.onCropChange?.({ x: right ? ax : ax - w, y: down ? ay : ay - h, w, h });
      }
      return;
    }
    if (drag.corner === 'e' || drag.corner === 'w') {
      // 宽随指针、高/纵向保持
      const w = Math.abs(p.x - ax);
      if (w > 0.001) {
        stateRef.current.onCropChange?.({
          x: p.x >= ax ? ax : ax - w,
          y: drag.startRect.y,
          w,
          h: drag.startRect.h,
        });
      }
      return;
    }
    // n / s:高随指针、宽/横向保持
    const h = Math.abs(p.y - ay);
    if (h > 0.001) {
      stateRef.current.onCropChange?.({
        x: drag.startRect.x,
        y: p.y >= ay ? ay : ay - h,
        w: drag.startRect.w,
        h,
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<HTMLCanvasElement>): void => {
    const drag = dragRef.current;
    if (drag.kind !== 'none') {
      dragRef.current = { kind: 'none' };
      const cv = canvasRef.current;
      if (cv?.hasPointerCapture(e.pointerId)) cv.releasePointerCapture(e.pointerId);
      // 收尾:把过小的框清掉
      const crop = stateRef.current.params.geo.cropNorm;
      if (crop && (crop.w < 0.01 || crop.h < 0.01)) {
        stateRef.current.onCropChange?.(null);
      }
    }
  };

  return (
    <div ref={containerRef} className={className} style={{ ...style, position: 'relative' }}>
      <canvas
        ref={canvasRef}
        className="absolute inset-0 w-full h-full"
        style={{ touchAction: 'none' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  );
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
