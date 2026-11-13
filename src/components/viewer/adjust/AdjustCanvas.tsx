import React, { useCallback, useEffect, useRef } from 'react';
import {
  AdjustCropNorm,
  AdjustParams,
  cssFilterForTone,
  fitCropToAspectPx,
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
  /** 首帧实际绘出后回调一次(查看器用它把底层 <img> 藏起来,消除切换闪动) */
  onFirstPaint?: () => void;
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
  onFirstPaint,
  className,
  style,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameRef = useRef<AdjustedFrame | null>(null);
  const viewRef = useRef({ vx: 0, vy: 0, scale: 1, dpr: 1, cssScale: 1 });
  const dragRef = useRef<DragMode>({ kind: 'none' });
  const rafRef = useRef<number | null>(null);
  const firstPaintRef = useRef(false);
  const stateRef = useRef({ params, interactive, showCropUI, cropAspect, onCropChange, onFirstPaint });
  stateRef.current = { params, interactive, showCropUI, cropAspect, onCropChange, onFirstPaint };

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
    // 交互态分两样:裁剪态画完整帧(叠加裁剪覆盖层);调整态(含应用裁剪后)
    // 呈现**裁剪结果**——所见即导出,后续影调都作用在裁剪后的图上
    // (2026-11-14 用户口径:应用裁剪 → 裁剪后的图片继续进行调整)。
    const { sx, sy, sw, sh } = (it && cropUI)
      ? { sx: 0, sy: 0, sw: frame.width, sh: frame.height }
      : frameCropRect(frame, p);
    const viewScale = Math.min(cw / sw, ch / sh);
    const vx = (cw - sw * viewScale) / 2;
    const vy = (ch - sh * viewScale) / 2;
    viewRef.current = { vx, vy, scale: viewScale, dpr, cssScale: viewRef.current.cssScale };

    ctx.save();
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    const filter = cssFilterForTone(p.tone);
    if (filter !== 'none') ctx.filter = filter;
    ctx.drawImage(frame.canvas, sx, sy, sw, sh, vx, vy, sw * viewScale, sh * viewScale);
    ctx.restore();

    // 冒烟调试钩子:视口映射 + 图像显示矩形(画布设备px 口径),CDP 直读
    (window as unknown as Record<string, unknown>).__adjustView = {
      vx, vy, scale: viewScale, bw: cw, bh: ch, ix: vx, iy: vy, iw: sw * viewScale, ih: sh * viewScale,
    };

    // 首帧已实际绘出 → 通知宿主(切换闪动的交接信号,每次挂载只报一次)
    if (!firstPaintRef.current) {
      firstPaintRef.current = true;
      stateRef.current.onFirstPaint?.();
    }

    // 裁剪覆盖层(不被影调滤镜影响)
    if (it && cropUI && p.geo.cropNorm) {
      const crop = p.geo.cropNorm;
      const x = vx + crop.x * frame.width * viewScale;
      const y = vy + crop.y * frame.height * viewScale;
      const w = crop.w * frame.width * viewScale;
      const h = crop.h * frame.height * viewScale;
      // ① 只压暗图像区。整幅查看器背景(信箱区+缩放后露出的四周)由宿主的
      //    非变换暗化层兜底(ImageViewer 裁剪态渲染)——本画布带着查看器的
      //    scale 变换,缩小图时画布自身盖不满视口,这里若画满会跟着缩进去,
      //    两层各画 0.55 会叠黑。图像区只归本画布管,暗度恰为单层 0.55。
      ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.fillRect(vx, vy, sw * viewScale, sh * viewScale);
      // ② 裁剪矩形区域重绘亮图(带影调滤镜)
      ctx.save();
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      const regionFilter = cssFilterForTone(p.tone);
      if (regionFilter !== 'none') ctx.filter = regionFilter;
      ctx.drawImage(
        frame.canvas,
        crop.x * frame.width, crop.y * frame.height, crop.w * frame.width, crop.h * frame.height,
        x, y, w, h
      );
      ctx.restore();
      // ③ 边框 + 九宫格
      ctx.save();
      // 冒烟调试钩子(沿用 __editorStoreLive 先例):裁剪矩形 + 帧尺寸,CDP 直读
      (window as unknown as Record<string, unknown>).__adjustCropRect = {
        x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(h),
        frameW: frame.width, frameH: frame.height,
      };
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

  // 比例预设切换 → 按像素比重排现有裁剪框(像素空间语义,2026-11-14 修)
  useEffect(() => {
    const frame = frameRef.current;
    if (cropAspect == null || !frame || !interactive) return;
    const crop = stateRef.current.params.geo.cropNorm;
    if (!crop) return;
    const fitted = fitCropToAspectPx(crop, cropAspect, frame.width / frame.height);
    stateRef.current.onCropChange?.(fitted);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cropAspect]);

  // ── 裁剪交互 ──────────────────────────────────────────────────────────────
  // 宿主(ImageViewer)把查看器的 translate/rotate/scale 叠在本组件的**包裹 div**
  // 上(AdjustCanvas 的 style prop 落在容器,canvas 只是容器的子元素;canvas
  // 自身 computed transform 恒为 none)。getBoundingClientRect 是变换后的包围
  // 盒:直接拿它映射指针,缩放≠1 时整体错位(缩小图拉框出现在指针左上、手柄
  // 全失灵的根因)。这里沿祖先链合成全部线性部分做逆变换:client → 画布布局
  // 坐标 → 设备像素。锚点用「包围盒中心 ↔ 布局中心」:translate/rotate/scale
  // 链无剪切,矩形中心必映到包围盒中心,故平移/各元素 transform-origin 全部
  // 被锚点吸收,只剩线性部分。
  const toCanvasPx = (clientX: number, clientY: number): { x: number; y: number } => {
    const cv = canvasRef.current!;
    const dpr = viewRef.current.dpr;
    const lw = cv.clientWidth || 1;
    const lh = cv.clientHeight || 1;
    const rect = cv.getBoundingClientRect();
    let dx = clientX - (rect.left + rect.width / 2);
    let dy = clientY - (rect.top + rect.height / 2);
    let ma = 1, mb = 0, mc = 0, md = 1;
    try {
      for (let el: HTMLElement | null = cv; el && el !== document.body; el = el.parentElement) {
        const t = window.getComputedStyle(el).transform;
        if (!t || t === 'none') continue;
        const m = new DOMMatrix(t);
        if (m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1) continue;
        // 先祖在左合成:L = M_anc × L_acc(平移分量已被中心锚点吸收,只留线性)
        const na = m.a * ma + m.c * mb;
        const nb = m.b * ma + m.d * mb;
        const nc = m.a * mc + m.c * md;
        const nd = m.b * mc + m.d * md;
        ma = na; mb = nb; mc = nc; md = nd;
      }
    } catch {
      // DOMMatrix 不可用 → 退化恒等(宿主未缩放时本就正确)
    }
    const det = ma * md - mb * mc;
    if (Math.abs(det) > 1e-9) {
      viewRef.current.cssScale = Math.sqrt(Math.abs(det)); // |scale|,旋转下同样成立
      const ux = (md * dx - mc * dy) / det;
      const uy = (-mb * dx + ma * dy) / det;
      dx = ux;
      dy = uy;
    }
    return { x: (lw / 2 + dx) * dpr, y: (lh / 2 + dy) * dpr };
  };

  const cursorForHit = (hit: string | null): string => {
    switch (hit) {
      case 'nw': case 'se': return 'nwse-resize';
      case 'ne': case 'sw': return 'nesw-resize';
      case 'n': case 's': return 'ns-resize';
      case 'e': case 'w': return 'ew-resize';
      case 'inside': return 'move';
      default: return 'crosshair';
    }
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
    // 命中半径按**视觉**恒定:画布被宿主缩放 cssScale 倍,布局半径要除回来
    // (否则缩小图时手柄/三分线的可点区跟着缩没,放大图时又大得离谱)
    const tol = (HANDLE_HIT * viewRef.current.dpr) / Math.max(viewRef.current.cssScale, 0.05);
    const pts: Array<[string, number, number]> = [
      ['nw', x, y], ['n', x + w / 2, y], ['ne', x + w, y],
      ['w', x, y + h / 2], ['e', x + w, y + h / 2],
      ['sw', x, y + h], ['s', x + w / 2, y + h], ['se', x + w, y + h],
    ];
    for (const [name, hx, hy] of pts) {
      if (Math.abs(px - hx) <= tol && Math.abs(py - hy) <= tol) return name;
    }
    // 三分线拖边(九宫格调形,对齐"画布"对比的直拖手感):
    // 竖 1/3 线→左缘、2/3 线→右缘;横 1/3 线→上缘、2/3 线→下缘
    if (py >= y && py <= y + h) {
      if (Math.abs(px - (x + w / 3)) <= tol) return 'w';
      if (Math.abs(px - (x + (2 * w) / 3)) <= tol) return 'e';
    }
    if (px >= x && px <= x + w) {
      if (Math.abs(py - (y + h / 3)) <= tol) return 'n';
      if (Math.abs(py - (y + (2 * h) / 3)) <= tol) return 's';
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
    // 捕获后 hover 不再更新,按下即锁定本次操作的光标
    cv.style.cursor = cursorForHit(hit);
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
      // 空白处按下 = 从按点拉新框('new' = 方向实时,框随指针起落)
      const { x: nx, y: ny } = frameNormFromCanvas(px, py);
      dragRef.current = {
        kind: 'resize',
        corner: 'new',
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
    if (drag.kind === 'none') {
      // 悬停光标反馈(手柄/三分线/框内各自成形,对齐"画布"对比的直拖手感)
      const { interactive: it, showCropUI: cropUI } = stateRef.current;
      const cv = canvasRef.current;
      if (it && cropUI && frameRef.current && cv) {
        const { x: px, y: py } = toCanvasPx(e.clientX, e.clientY);
        cv.style.cursor = cursorForHit(hitTestHandle(px, py));
      }
      return;
    }
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
    // 角/新拉框:方向**实时取自指针**(允许跨越锚点翻转——手柄拖拽不再变扭;
    // 新拉框框随指针起落,不再固定往右下)
    const isCorner = ['nw', 'ne', 'sw', 'se', 'new'].includes(drag.corner);
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
      const frameAspect = frame.width / frame.height;
      if (aspect && w > 0) {
        // 锁**像素比**:w_norm/h_norm = aspect / frameAspect
        // (2026-11-14 修:归一化坐标比在非方图上不等于屏幕比,1:1 会画出长方形)
        const maxW = right ? 1 - ax : ax;
        const maxH = down ? 1 - ay : ay;
        w = Math.min(w, maxW, (maxH * aspect) / frameAspect);
        h = (w * frameAspect) / aspect;
      } else {
        h = Math.abs(p.y - ay);
      }
      if (w > 0.001 && h > 0.001) {
        stateRef.current.onCropChange?.({ x: right ? ax : ax - w, y: down ? ay : ay - h, w, h });
      }
      return;
    }
    if (drag.corner === 'e' || drag.corner === 'w') {
      // 宽随指针;锁比例时高按像素比推导、纵向保中心(此前锁 1:1 拖边
      // 会画出长方形,2026-11-14 修)
      const aspect = drag.aspect;
      const frameAspect = frame.width / frame.height;
      const maxW = p.x >= ax ? 1 - ax : ax;
      let w = Math.min(Math.abs(p.x - ax), maxW);
      let y = drag.startRect.y;
      let h = drag.startRect.h;
      if (aspect && w > 0.001) {
        h = (w * frameAspect) / aspect;
        y = Math.max(0, drag.startRect.y + drag.startRect.h / 2 - h / 2);
        if (y + h > 1) {
          h = 1 - y;
          w = Math.min(w, (h * aspect) / frameAspect);
        }
      }
      if (w > 0.001) {
        stateRef.current.onCropChange?.({
          x: p.x >= ax ? ax : ax - w,
          y,
          w,
          h,
        });
      }
      return;
    }
    // n / s:高随指针;锁比例时宽按像素比推导、横向保中心
    const aspect = drag.aspect;
    const frameAspect = frame.width / frame.height;
    const maxH = p.y >= ay ? 1 - ay : ay;
    let h = Math.min(Math.abs(p.y - ay), maxH);
    let x = drag.startRect.x;
    let w = drag.startRect.w;
    if (aspect && h > 0.001) {
      w = (h * aspect) / frameAspect;
      x = Math.max(0, drag.startRect.x + drag.startRect.w / 2 - w / 2);
      if (x + w > 1) {
        w = 1 - x;
        h = Math.min(h, (w * frameAspect) / aspect);
      }
    }
    if (h > 0.001) {
      stateRef.current.onCropChange?.({
        x,
        y: p.y >= ay ? ay : ay - h,
        w,
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
    <div ref={containerRef} className={className} style={style}>
      <canvas
        ref={canvasRef}
        data-adjust-canvas="1"
        className="absolute inset-0 w-full h-full"
        style={{ touchAction: 'none', cursor: showCropUI ? 'crosshair' : 'default' }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        // 仅裁剪态拦 mousedown:容器的图片平移监听 mousedown;非裁剪放行 =
        // 调整态下按住画布任意处(图内/图外)都能平移(2026-11-14 用户实测修)
        onMouseDown={(e) => { if (showCropUI) e.stopPropagation(); }}
      />
    </div>
  );
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
