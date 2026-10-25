/**
 * 编辑器画布:三层结构。
 *  0) CSS 棋盘格(由显示 canvas 自绘,锚定文档原点)
 *  1) 文档位图:全分辨率离屏 canvas,损伤时 putImageData 更新,显示层按视图变换 drawImage
 *  2) overlay:选区框/笔刷圆环/工具预览(M2 起逐步补齐蚂蚁线)
 * 交互:滚轮=绕指针缩放(PS 习惯)、空格/中键/抓手=平移、缩放工具点击、[/] 调笔径。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { editorRender } from './editorBridge';
import { getSession, setOptions, subscribeSession } from './editorStore';
import type { EditorSession } from './editorStore';
import { clampPan, fitToView, screenToDoc, zoomAbout, ZOOM_STEP } from './viewMath';

const BRUSH_TOOLS = new Set(['brush', 'eraser', 'blur', 'sharpen', 'smudge']);
/** 离屏位图像素上限(约 36MP);超过则首屏降采样,信息面板取色按 rasterScale 折算。 */
const RASTER_PIXEL_BUDGET = 36_000_000;

function makeCheckerPattern(ctx: CanvasRenderingContext2D): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = '#3f3f3f';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = '#313131';
  g.fillRect(0, 0, 8, 8);
  g.fillRect(8, 8, 8, 8);
  return ctx.createPattern(c, 'repeat');
}

export const EditorCanvas: React.FC<{ tabId: string; isActive: boolean }> = ({ tabId, isActive }) => {
  const wrapRef = useRef<HTMLDivElement>(null);
  const displayRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const [, forceUpdate] = useState(0);
  const spaceRef = useRef(false);
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const drawPending = useRef(false);
  const sessionRef = useRef<EditorSession | undefined>(undefined);
  /** 位图位图代数:docId+revision 变化时刷新离屏画布。 */
  const bitmapKeyRef = useRef('');

  const session = (sessionRef.current = getSession(tabId));

  // 订阅 store(tool/revision/docId 变化触发 React 更新)
  useEffect(() => {
    const un = subscribeSession(tabId, () => forceUpdate((n) => n + 1));
    return un;
  }, [tabId]);

  const scheduleDraw = useCallback(() => {
    if (drawPending.current) return;
    drawPending.current = true;
    requestAnimationFrame(() => {
      drawPending.current = false;
      draw();
    });
  }, []);

  const draw = useCallback(() => {
    const s = getSession(tabId);
    const display = displayRef.current;
    const overlay = overlayRef.current;
    const wrap = wrapRef.current;
    if (!s || !display || !overlay || !wrap) return;
    const dpr = window.devicePixelRatio || 1;
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (cssW === 0 || cssH === 0) return;

    // 尺寸同步(含 DPR)
    for (const cv of [display, overlay]) {
      if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
        cv.width = Math.round(cssW * dpr);
        cv.height = Math.round(cssH * dpr);
      }
      cv.style.width = `${cssW}px`;
      cv.style.height = `${cssH}px`;
    }
    s.runtime.viewW = cssW;
    s.runtime.viewH = cssH;

    const v = s.runtime.view;
    const dctx = display.getContext('2d');
    const octx = overlay.getContext('2d');
    if (!dctx || !octx) return;
    dctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    dctx.clearRect(0, 0, cssW, cssH);
    octx.clearRect(0, 0, cssW, cssH);
    if (!s.state || !s.runtime.offscreen) return;

    const docW = s.state.width;
    const docH = s.state.height;
    const dw = docW * v.scale;
    const dh = docH * v.scale;

    // 棋盘格:锚定文档原点(平移时随文档走)
    dctx.save();
    dctx.translate(v.ox, v.oy);
    const pattern = makeCheckerPattern(dctx);
    if (pattern) {
      dctx.fillStyle = pattern;
      dctx.fillRect(0, 0, dw, dh);
    }
    dctx.restore();

    // 文档位图
    dctx.imageSmoothingEnabled = v.scale < 1;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(s.runtime.offscreen, v.ox, v.oy, dw, dh);

    // overlay:文档外框
    octx.strokeStyle = '#00000088';
    octx.lineWidth = 1;
    octx.strokeRect(v.ox - 0.5, v.oy - 0.5, dw + 1, dh + 1);

    // overlay:选区边界(M1 简化为虚线框;M2 换蚂蚁线轮廓)
    const sel = s.state.selectionBounds;
    if (sel) {
      const [x, y, w, h] = sel;
      octx.save();
      octx.strokeStyle = '#ffffff';
      octx.setLineDash([4, 4]);
      octx.lineWidth = 1;
      octx.strokeRect(x * v.scale + v.ox, y * v.scale + v.oy, w * v.scale, h * v.scale);
      octx.strokeStyle = '#000000';
      octx.lineDashOffset = 4;
      octx.strokeRect(x * v.scale + v.ox, y * v.scale + v.oy, w * v.scale, h * v.scale);
      octx.restore();
    }

    // overlay:笔刷圆环光标(画笔族)
    if (BRUSH_TOOLS.has(s.tool) && s.runtime.pointerDoc) {
      const r = Math.max(1, (s.options.brushSize / 2) * v.scale);
      const [cx, cy] = [s.runtime.pointerDoc.x * v.scale + v.ox, s.runtime.pointerDoc.y * v.scale + v.oy];
      octx.beginPath();
      octx.arc(cx, cy, r, 0, Math.PI * 2);
      octx.strokeStyle = '#000000cc';
      octx.lineWidth = 1;
      octx.stroke();
      octx.beginPath();
      octx.arc(cx, cy, r - 1, 0, Math.PI * 2);
      octx.strokeStyle = '#ffffffcc';
      octx.stroke();
    }
  }, [tabId]);

  // 注册重绘请求 + 初始适配
  useEffect(() => {
    const s = getSession(tabId);
    if (!s) return;
    s.runtime.requestDraw = scheduleDraw;
    return () => {
      if (s.runtime.requestDraw === scheduleDraw) s.runtime.requestDraw = null;
    };
  }, [tabId, scheduleDraw]);

  // 位图刷新:docId/revision 变化 → 重渲染整幅(M1 简化;M2 起按损伤矩形增量)
  useEffect(() => {
    const s = getSession(tabId);
    if (!s || s.docId == null || !s.state) return;
    const key = `${s.docId}:${s.revision}`;
    if (bitmapKeyRef.current === key) return;
    bitmapKeyRef.current = key;
    let cancelled = false;
    (async () => {
      try {
        const docPx = s.state!.width * s.state!.height;
        const rs = docPx > RASTER_PIXEL_BUDGET ? Math.sqrt(RASTER_PIXEL_BUDGET / docPx) : 1;
        const bmp = await editorRender(s.docId!, rs < 1 ? Math.round(s.state!.width * rs) : undefined, rs < 1 ? Math.round(s.state!.height * rs) : undefined);
        if (cancelled) return;
        let canvas = s.runtime.offscreen;
        if (!canvas || canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas = document.createElement('canvas');
          canvas.width = bmp.width;
          canvas.height = bmp.height;
          s.runtime.offscreen = canvas;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) ctx.putImageData(new ImageData(bmp.rgba, bmp.width, bmp.height), 0, 0);
        s.runtime.rasterScale = rs;
        scheduleDraw();
      } catch (e) {
        if (!cancelled) console.error('[editor] render failed', e);
      }
    })();
    return () => {
      cancelled = true;
    };
  });

  // 容器尺寸观察
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return undefined;
    const ro = new ResizeObserver(() => {
      const s = getSession(tabId);
      if (s && s.state && s.runtime.viewW === 0) {
        // 首次有尺寸:适配视口
        s.runtime.view = fitToView(s.state.width, s.state.height, wrap.clientWidth, wrap.clientHeight);
      }
      scheduleDraw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [tabId, scheduleDraw]);

  // 键盘:空格临时抓手、[/] 笔径
  useEffect(() => {
    if (!isActive) return undefined;
    const down = (e: KeyboardEvent) => {
      const s = getSession(tabId);
      if (!s) return;
      if (e.code === 'Space') {
        spaceRef.current = true;
        scheduleDraw();
      } else if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const step = e.key === '[' ? -1 : 1;
        const next = Math.min(500, Math.max(1, Math.round(s.options.brushSize * (step > 0 ? 1.15 : 1 / 1.15))));
        setOptions(tabId, { brushSize: next });
        console.log(`[editor] brush size ${next}px`);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        scheduleDraw();
      }
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, [tabId, isActive, scheduleDraw]);

  // 滚轮缩放(非 passive 才能阻止页面滚动)
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const s = getSession(tabId);
      if (!s) return;
      const rect = el.getBoundingClientRect();
      const factor = Math.pow(ZOOM_STEP, -Math.sign(e.deltaY));
      s.runtime.view = zoomAbout(s.runtime.view, factor, e.clientX - rect.left, e.clientY - rect.top);
      scheduleDraw();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [tabId, scheduleDraw]);

  const onPointerDown = (e: React.PointerEvent) => {
    const s = getSession(tabId);
    if (!s) return;
    (e.target as Element).setPointerCapture(e.pointerId);
    const pan = spaceRef.current || e.button === 1 || s.tool === 'hand';
    if (pan) {
      panRef.current = { sx: e.clientX, sy: e.clientY, ox: s.runtime.view.ox, oy: s.runtime.view.oy };
      return;
    }
    if (s.tool === 'zoom' && s.state) {
      const rect = wrapRef.current!.getBoundingClientRect();
      const factor = e.altKey ? 1 / ZOOM_STEP : ZOOM_STEP;
      s.runtime.view = zoomAbout(s.runtime.view, factor, e.clientX - rect.left, e.clientY - rect.top);
      scheduleDraw();
    }
    // 其余工具的落笔交互在 M2 接入(tools/)
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const s = getSession(tabId);
    if (!s || !s.state) return;
    const rect = wrapRef.current!.getBoundingClientRect();
    if (panRef.current && s) {
      const p = panRef.current;
      s.runtime.view = clampPan(
        { scale: s.runtime.view.scale, ox: p.ox + (e.clientX - p.sx), oy: p.oy + (e.clientY - p.sy) },
        s.state.width, s.state.height, rect.width, rect.height,
      );
      scheduleDraw();
      return;
    }
    const [dx, dy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
    s.runtime.pointerDoc = { x: dx, y: dy };
    if (BRUSH_TOOLS.has(s.tool)) scheduleDraw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    panRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
  };

  const onPointerLeave = () => {
    const s = getSession(tabId);
    if (s) {
      s.runtime.pointerDoc = null;
      scheduleDraw();
    }
  };

  if (!session) return null;
  const cursor = session.tool === 'hand' || spaceRef.current ? 'grab' : session.tool === 'zoom' ? 'zoom-in' : BRUSH_TOOLS.has(session.tool) ? 'none' : 'default';

  return (
    <div
      ref={wrapRef}
      className="relative flex-1 min-h-0 overflow-hidden bg-[#262626]"
      style={{ cursor, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={displayRef} className="absolute inset-0" />
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      {session.loading && <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-400">正在打开…</div>}
      {session.error && <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 p-8 text-center">{session.error}</div>}
    </div>
  );
};
