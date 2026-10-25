/**
 * 编辑器画布:三层结构。
 *  0) CSS 棋盘格(由显示 canvas 自绘,锚定文档原点)
 *  1) 文档位图:全分辨率离屏 canvas,损伤时 putImageData 更新,显示层按视图变换 drawImage
 *  2) overlay:选区框/笔刷圆环/工具预览(M2 起逐步补齐蚂蚁线)
 * 交互:滚轮=绕指针缩放(PS 习惯)、空格/中键/抓手=平移、缩放工具点击、[/] 调笔径。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { editorRender } from './editorBridge';
import { getSession, refreshSelectionOutline, runCommand, setOptions, setTool, subscribeSession } from './editorStore';
import type { EditorSession } from './editorStore';
import type { EditorTool } from './editorTypes';
import { clampPan, fitToView, screenToDoc, zoomAbout, ZOOM_STEP } from './viewMath';
import {
  effectiveMode, initialMods, marqueeParams, marqueeRect, sampleHex,
  selectMode, TOOL_KEYS, trackMods, type DragPoint, type DragMods,
} from './toolLogic';

const BRUSH_TOOLS = new Set(['brush', 'eraser', 'blur', 'sharpen', 'smudge']);
/** 离屏位图像素上限(约 36MP);超过则首屏降采样,信息面板取色按 rasterScale 折算。 */
const RASTER_PIXEL_BUDGET = 36_000_000;

function makeCheckerPattern(ctx: CanvasRenderingContext2D, dark: boolean): CanvasPattern | null {
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const g = c.getContext('2d');
  if (!g) return null;
  g.fillStyle = dark ? '#3f3f3f' : '#ffffff';
  g.fillRect(0, 0, 16, 16);
  g.fillStyle = dark ? '#313131' : '#d8d8d8';
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
  /** 选框拖拽中(文档坐标 + 修饰键时序跟踪,口径同 photocraft 上游 Drag)。 */
  const marqueeRef = useRef<(DragPoint & { mods: DragMods }) | null>(null);
  /** 吸管按下取色中(节流到每 40ms 一次 IPC)。 */
  const eyedropRef = useRef<{ last: number } | null>(null);
  const sessionRef = useRef<EditorSession | undefined>(undefined);
  /** 位图位图代数:docId+revision 变化时刷新离屏画布。 */
  const bitmapKeyRef = useRef('');
  /** 首幅位图落地后做一次 fit(viewW 在 draw 里就会被写非零,不能靠 ResizeObserver 判首次)。 */
  const fittedRef = useRef(false);

  const session = (sessionRef.current = getSession(tabId));

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

    // 棋盘格:锚定文档原点(平移时随文档走);配色随应用浅/深主题
    const isDark = document.documentElement.classList.contains('dark');
    dctx.save();
    dctx.translate(v.ox, v.oy);
    const pattern = makeCheckerPattern(dctx, isDark);
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
    octx.strokeStyle = isDark ? '#ffffff66' : '#00000055';
    octx.lineWidth = 1;
    octx.strokeRect(v.ox - 0.5, v.oy - 0.5, dw + 1, dh + 1);

    // overlay:选区蚂蚁线——真实 mask 轮廓(editor_selection_outline,引擎侧 outline.rs
    // 按 0.5 阈值提边界段),加减/羽化/反选后的形状都正确;轮廓到达前的过渡帧画 bounds 框。
    const drawAnts = (build: (c: CanvasRenderingContext2D) => void) => {
      octx.save();
      octx.lineWidth = 1;
      octx.setLineDash([4, 4]);
      octx.lineDashOffset = -s.runtime.antsPhase;
      octx.strokeStyle = '#ffffff';
      build(octx);
      octx.stroke();
      octx.lineDashOffset = -s.runtime.antsPhase + 4;
      octx.strokeStyle = '#000000';
      octx.stroke();
      octx.restore();
    };
    const sel = s.state.selectionBounds;
    if (sel) {
      refreshSelectionOutline(tabId); // 内部按 revision:bounds:step 防抖,选区没变不发请求
      const polys = s.runtime.selectionOutline;
      if (polys && polys.length) {
        drawAnts((c) => {
          c.beginPath();
          for (const poly of polys) {
            c.moveTo(poly[0] * v.scale + v.ox, poly[1] * v.scale + v.oy);
            for (let i = 2; i < poly.length; i += 2) {
              c.lineTo(poly[i] * v.scale + v.ox, poly[i + 1] * v.scale + v.oy);
            }
          }
        });
      }
      // 轮廓未就绪时不画兜底框:runCommand 已在 state 到达的同帧顺带拉取轮廓,
      // 用外接矩形兜底会让椭圆先闪成矩形(这正是要避免的)。
    }
    // overlay:选框拖拽实时预览(约束同提交口径:拖拽中新按的 Shift=正方形 / Alt=从中心)
    if (marqueeRef.current) {
      const m = marqueeRef.current;
      const r = marqueeRect(m, m.mods);
      if (r) {
        octx.save();
        octx.setLineDash([4, 4]);
        octx.strokeStyle = '#ffffffcc';
        octx.lineWidth = 1;
        octx.beginPath();
        if (s.options.marqueeShape === 'ellipse') {
          octx.ellipse((r.x + r.w / 2) * v.scale + v.ox, (r.y + r.h / 2) * v.scale + v.oy, (r.w / 2) * v.scale, (r.h / 2) * v.scale, 0, 0, Math.PI * 2);
        } else {
          octx.rect(r.x * v.scale + v.ox, r.y * v.scale + v.oy, r.w * v.scale, r.h * v.scale);
        }
        octx.stroke();
        octx.strokeStyle = '#000000cc';
        octx.lineDashOffset = 4;
        octx.stroke();
        octx.restore();
      }
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

    // 蚂蚁线动画:有选区或拖拽预览时逐帧推进相位(≈15px/s,近 photocraft 上游 10);
    // 选区消失后本循环自然停
    if (s.state.hasSelection || marqueeRef.current) {
      s.runtime.antsPhase = (s.runtime.antsPhase + 0.25) % 8;
      scheduleDraw();
    }
  }, [tabId]);

  // 订阅 store(tool/revision/docId/state 变化):驱动 React 更新 + 调度一帧画布重绘。
  // 重绘不能只靠 requestDraw 注册(挂载时 session 常未建好)或位图 effect(只在
  // revision 变化时画,画时 state 还没到):draw 直读 store,任何命令落地(选区/
  // 取色/图层)都当帧可见。这才是"提交后立即显示"的保证。
  useEffect(() => {
    const un = subscribeSession(tabId, () => {
      const s = getSession(tabId);
      if (s && s.runtime.requestDraw !== scheduleDraw) s.runtime.requestDraw = scheduleDraw;
      forceUpdate((n) => n + 1);
      scheduleDraw();
    });
    return un;
  }, [tabId, scheduleDraw]);

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
        if (!fittedRef.current && wrapRef.current && wrapRef.current.clientWidth > 0) {
          s.runtime.view = fitToView(s.state!.width, s.state!.height, wrapRef.current.clientWidth, wrapRef.current.clientHeight);
          fittedRef.current = true;
        }
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
      if (s && s.state && !fittedRef.current && wrap.clientWidth > 0) {
        s.runtime.view = fitToView(s.state.width, s.state.height, wrap.clientWidth, wrap.clientHeight);
        fittedRef.current = true;
      }
      scheduleDraw();
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [tabId, scheduleDraw]);

  // 键盘:空格临时抓手、[/] 笔径、工具单键、选区/颜色命令键
  useEffect(() => {
    if (!isActive) return undefined;
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    const down = (e: KeyboardEvent) => {
      const s = getSession(tabId);
      if (!s) return;
      if (e.code === 'Space') {
        spaceRef.current = true;
        scheduleDraw();
        return;
      }
      if (isTyping(e.target)) return;
      if (e.key === '[' || e.key === ']') {
        e.preventDefault();
        const step = e.key === '[' ? -1 : 1;
        const next = Math.min(500, Math.max(1, Math.round(s.options.brushSize * (step > 0 ? 1.15 : 1 / 1.15))));
        setOptions(tabId, { brushSize: next });
        console.log(`[editor] brush size ${next}px`);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        if (k === 'd') {
          e.preventDefault();
          void runCommand(tabId, 'select.deselect', {}).catch(console.error);
        } else if (k === 'a') {
          e.preventDefault();
          void runCommand(tabId, 'select.all', {}).catch(console.error);
        } else if (e.shiftKey && k === 'i') {
          e.preventDefault();
          void runCommand(tabId, 'select.inverse', {}).catch(console.error);
        }
        return;
      }
      if (e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'x') {
        void runCommand(tabId, 'tools.swapColors', {}).catch(console.error);
      } else if (k === 'd') {
        void runCommand(tabId, 'tools.defaultColors', {}).catch(console.error);
      } else if (k === 'm') {
        // M 键组内循环:已在选框工具上时切换矩形/椭圆(photocraft 上游口径)
        const st = getSession(tabId);
        if (st?.tool === 'marquee') {
          setOptions(tabId, { marqueeShape: st.options.marqueeShape === 'rect' ? 'ellipse' : 'rect' });
        } else {
          setTool(tabId, 'marquee');
        }
      } else if (TOOL_KEYS[k]) {
        setTool(tabId, TOOL_KEYS[k] as EditorTool);
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

  /** 吸管取色:offscreen 复合位图采样 → 前景色(拖动中 40ms 节流)。 */
  const pickColor = (s: EditorSession) => {
    const off = s.runtime.offscreen;
    const p = s.runtime.pointerDoc;
    if (!off || !p) return;
    const ctx = off.getContext('2d');
    if (!ctx) return;
    const hex = sampleHex(ctx, p.x, p.y, s.runtime.rasterScale);
    if (!hex) return;
    void runCommand(tabId, 'tools.setColors', { foreground: hex }).catch(console.error);
  };

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
      return;
    }
    const rect = wrapRef.current!.getBoundingClientRect();
    const [dx, dy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
    s.runtime.pointerDoc = { x: dx, y: dy };
    if (s.tool === 'marquee' && e.button === 0) {
      // 按下时的修饰键定选区运算模式;拖拽中途新按的键做形状约束(trackMods 跟踪)
      marqueeRef.current = { x0: dx, y0: dy, x1: dx, y1: dy, mods: initialMods(e.shiftKey, e.altKey) };
      scheduleDraw();
    } else if (s.tool === 'eyedropper' && e.button === 0) {
      eyedropRef.current = { last: performance.now() };
      pickColor(s);
    }
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
    if (marqueeRef.current) {
      marqueeRef.current.x1 = dx;
      marqueeRef.current.y1 = dy;
      marqueeRef.current.mods = trackMods(marqueeRef.current.mods, e.shiftKey, e.altKey);
      scheduleDraw();
    } else if (eyedropRef.current) {
      const now = performance.now();
      if (now - eyedropRef.current.last >= 40) {
        eyedropRef.current.last = now;
        pickColor(s);
      }
    } else if (BRUSH_TOOLS.has(s.tool)) {
      scheduleDraw();
    }
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const s = getSession(tabId);
    const m = marqueeRef.current;
    marqueeRef.current = null;
    eyedropRef.current = null;
    if (s && m && s.state) {
      const r = marqueeRect(m, m.mods);
      if (r) {
        // mode 由按下时的修饰键决定;无现有选区时减去/相交落回新选区(PS 口径)
        const mode = effectiveMode(selectMode(m.mods.pressShift, m.mods.pressAlt), s.state.hasSelection);
        void runCommand(tabId, 'select.rect', marqueeParams(r, s.options, mode))
          .catch((err) => console.error('[editor] select.rect', err));
      } else {
        // 点击(近零位移)= 取消选择(PS 行为;无选区时引擎空转无历史步)
        void runCommand(tabId, 'select.deselect', {}).catch(console.error);
      }
      scheduleDraw();
    }
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
  const CROSSHAIR_TOOLS = new Set(['marquee', 'lasso', 'crop', 'eyedropper', 'gradient', 'bucket']);
  const cursor =
    session.tool === 'hand' || spaceRef.current ? 'grab'
      : session.tool === 'zoom' ? 'zoom-in'
        : BRUSH_TOOLS.has(session.tool) ? 'none'
          : CROSSHAIR_TOOLS.has(session.tool) ? 'crosshair'
            : 'default';

  return (
    <div
      ref={wrapRef}
      className="relative flex-1 min-h-0 overflow-hidden bg-subtle"
      style={{ cursor, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerLeave}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={displayRef} className="absolute inset-0" />
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      {session.loading && <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">正在打开…</div>}
      {session.error && <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 p-8 text-center">{session.error}</div>}
    </div>
  );
};
