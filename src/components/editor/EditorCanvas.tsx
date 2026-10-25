/**
 * 编辑器画布:三层结构。
 *  0) CSS 棋盘格(由显示 canvas 自绘,锚定文档原点)
 *  1) 文档位图:离屏 canvas,revision 变化整幅替换;live 描边期间按 damage 矩形局部贴图
 *  2) overlay:选区框/笔刷圆环/工具预览(蚂蚁线等)
 * 交互:滚轮=绕指针缩放(PS 习惯)、空格/中键/抓手=平移、缩放工具点击、[/] 调笔径。
 * 画笔族(brush/eraser/blur/sharpen/smudge):落笔 begin → 每帧批量 push(引擎在文档克隆上
 * 渲染真像素,返回 damage 增量帧直接贴进离屏位图)→ 抬笔 commit(fromLive 命中则跳过整幅重渲)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { editorRender, editorStrokeBegin, editorStrokeCancel, editorStrokeCommit, editorStrokePush } from './editorBridge';
import type { StrokeFrame } from './editorBridge';
import { applyRunOutcome, getSession, refreshSelectionOutline, runCommand, setOptions, setTool, subscribeSession } from './editorStore';
import type { EditorSession } from './editorStore';
import type { EditorTool } from './editorTypes';
import { clampPan, fitToView, screenToDoc, zoomAbout, ZOOM_STEP } from './viewMath';
import {
  BRUSH_FAMILY, brushSizeStep, effectiveMode, initialMods, marqueeParams, marqueeRect, rgbToHex,
  sampleHex, selectMode, strokeCommand, strokeParams, TOOL_KEYS, trackMods,
  type BrushFamilyTool, type DragPoint, type DragMods,
} from './toolLogic';
import { error as logError } from '../../utils/logger';

const BRUSH_TOOLS: ReadonlySet<string> = BRUSH_FAMILY;
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
  /** live 描边状态机(画笔族):pump 单飞循环,pointermove 只积累点。 */
  const strokeRef = useRef<{
    tool: BrushFamilyTool;
    docId: number;
    /** begin IPC 完成(失败则 failed=true 并清除)。 */
    started: boolean;
    failed: boolean;
    /** pointer up 已发生:排空后提交。 */
    ended: boolean;
    /** pump 循环运行中(单飞:同一时刻至多一个 push/commit 在途)。 */
    pumping: boolean;
    /** 待投点 [x,y,pressure,…] 平铺。 */
    pending: number[];
    beginPromise: Promise<void>;
  } | null>(null);
  /** 增量帧上屏的中转画布(整幅 putImageData 只支持原点,先入 scratch 再缩放贴图)。 */
  const scratchRef = useRef<HTMLCanvasElement | null>(null);
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

  /** live 描边增量帧 → 离屏位图局部贴图(文档坐标矩形,rasterScale<1 时缩放绘制)。 */
  const applyStrokeFrame = useCallback((s: EditorSession | undefined, f: StrokeFrame) => {
    if (!s || !f.width || !f.height) return;
    const off = s.runtime.offscreen;
    if (!off) return;
    let scratch = scratchRef.current;
    if (!scratch) {
      scratch = document.createElement('canvas');
      scratchRef.current = scratch;
    }
    if (scratch.width !== f.width || scratch.height !== f.height) {
      scratch.width = f.width;
      scratch.height = f.height;
    }
    const sctx = scratch.getContext('2d');
    if (!sctx) return;
    sctx.putImageData(new ImageData(f.rgba, f.width, f.height), 0, 0);
    const octx = off.getContext('2d');
    if (!octx) return;
    const rs = s.runtime.rasterScale;
    octx.imageSmoothingEnabled = rs < 1;
    octx.drawImage(scratch, 0, 0, f.width, f.height, f.x * rs, f.y * rs, f.width * rs, f.height * rs);
    scheduleDraw();
  }, [scheduleDraw]);

  /**
   * 描边泵:单飞循环,直到提交/失败才退出。
   * - 有待投点 → 一批 push(引擎渲染真像素,返回 damage 增量帧直接上屏);
   * - up 后排空 → commit(fromLive 命中时离屏位图已是提交像素,抬位 bitmapKey
   *   跳过整幅重渲,applyRunOutcome 只补状态/轮廓);
   * - 按住不动 → 重复投当前点驱动平滑追赶(上游 HOLD_REPEAT 口径)。
   */
  const pumpStroke = useCallback(async () => {
    const st = strokeRef.current;
    if (!st || st.pumping) return;
    st.pumping = true;
    try {
      while (strokeRef.current === st) {
        if (!st.started) {
          await st.beginPromise;
          if (st.failed || strokeRef.current !== st) return;
          continue;
        }
        const batch = st.pending;
        st.pending = [];
        if (batch.length) {
          const frame = await editorStrokePush(st.docId, batch);
          applyStrokeFrame(getSession(tabId), frame);
        } else if (st.ended) {
          const { outcome, frame } = await editorStrokeCommit(st.docId);
          applyStrokeFrame(getSession(tabId), frame);
          strokeRef.current = null;
          if ((outcome.result as { fromLive?: boolean } | null)?.fromLive === true) {
            // 增量帧(+补差帧)已把提交后的像素画进离屏位图:抬位 bitmapKey,
            // revision 变化触发的整幅重渲按 key 相同跳过
            bitmapKeyRef.current = `${st.docId}:${outcome.revision}`;
          }
          await applyRunOutcome(tabId, outcome, true);
          scheduleDraw();
          return;
        } else {
          const s = getSession(tabId);
          const p = s?.runtime.pointerDoc;
          if (s && p) {
            const frame = await editorStrokePush(st.docId, [p.x, p.y, 1]);
            applyStrokeFrame(s, frame);
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }
    } catch (err) {
      logError('[editor] live 描边中断,已取消', err);
      strokeRef.current = null;
      void editorStrokeCancel(st.docId).catch(() => undefined);
      scheduleDraw();
    } finally {
      if (strokeRef.current === st) st.pumping = false;
    }
  }, [tabId, applyStrokeFrame, scheduleDraw]);

  /** 落笔:建 live 描边(begin 渲染首点),随后的 move 点全部走 pump 批量投递。 */
  const beginStroke = useCallback((
    s: EditorSession, tool: BrushFamilyTool, x: number, y: number,
  ) => {
    const docId = s.docId;
    if (docId == null) return;
    const st = {
      tool, docId, started: false, failed: false, ended: false, pumping: false,
      pending: [] as number[],
      beginPromise: Promise.resolve(),
    };
    strokeRef.current = st;
    const params = strokeParams(tool, s.options, rgbToHex(s.state?.foreground), s.runtime.view.scale);
    params.points = [[x, y, 1]];
    st.beginPromise = (async () => {
      try {
        const frame = await editorStrokeBegin(docId, strokeCommand(tool), params);
        st.started = true;
        applyStrokeFrame(s, frame);
      } catch (err) {
        // 隐藏层/无图层等引擎拒绝:无副作用,取消本地状态即可(日志可查)。
        // 失败也可能发生在引擎 begin 成功之后(帧解析/上屏抛错)——补发 cancel,
        // 不让 Rust 侧留下悬空 live(否则此后每次落笔都被拒绝)。
        st.failed = true;
        logError(`[editor] ${strokeCommand(tool)} 落笔失败`, err);
        if (strokeRef.current === st) strokeRef.current = null;
        void editorStrokeCancel(docId).catch(() => undefined);
      }
    })();
    void st.beginPromise.then(() => {
      void pumpStroke();
    });
  }, [applyStrokeFrame, pumpStroke]);

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

  // 位图刷新:docId/revision 变化 → 重渲染整幅(描边提交 fromLive 已局部贴图,bitmapKey 相同跳过)。
  // deps 只含值级触发器——runCommand 先落 revision 再落 state 两次 notify,若 effect 每次渲染都重跑,
  // 第二次会 cancel 掉第一次的异步渲染(cancelled 标记)而 bitmapKey 已前移 → 跳过,整帧永久丢失
  // (撤销/重做后画布不刷新的根因;选区类命令不改像素所以从未暴露)。只有同一依赖再次变化
  // (revision 又动了)才应取消上一次渲染。docW/docH 覆盖裁剪等改尺寸的命令。
  const docIdForBitmap = session?.docId ?? null;
  const revisionForBitmap = session?.revision ?? -1;
  const stateReady = session?.state != null;
  const docW = session?.state?.width ?? 0;
  const docH = session?.state?.height ?? 0;
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, docIdForBitmap, revisionForBitmap, stateReady, docW, docH]);

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
      // [ / ] 调笔径:除 e.key 外还匹配物理键码——中文输入法下 e.key 是全角"【】"，
      // e.code(BracketLeft/Right)不受布局/输入法影响(PS 键位按物理键算)
      const brushKey = e.key === '[' || e.key === ']'
        ? (e.key === ']' ? 1 : -1)
        : e.code === 'BracketRight' ? 1 : e.code === 'BracketLeft' ? -1 : 0;
      if (brushKey !== 0) {
        e.preventDefault();
        // 上游 tools.in/decreaseBrushSize 口径:±25% 且至少 ±1px,钳 1..500
        const next = brushSizeStep(s.options.brushSize, brushKey as 1 | -1);
        setOptions(tabId, { brushSize: next });
        console.log(`[editor] brush size ${next}px`);
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        // 撤销/重做(与工具栏按钮同命令);e.code 兜底防 IME 吃掉字母键
        const k2 = e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y' : k;
        if (k2 === 'z') {
          e.preventDefault();
          const redo = e.shiftKey;
          if (redo ? s.state?.canRedo : s.state?.canUndo) {
            void runCommand(tabId, redo ? 'edit.redo' : 'edit.undo', {}).catch(console.error);
          }
        } else if (k2 === 'y') {
          e.preventDefault();
          if (s.state?.canRedo) {
            void runCommand(tabId, 'edit.redo', {}).catch(console.error);
          }
        } else if (k === 'd') {
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
    if (BRUSH_TOOLS.has(s.tool) && e.button === 0 && s.state) {
      // 一笔进行中时忽略再次按下(鼠标不会出现;触屏多指防把进行中描边的 live 顶掉)
      if (!strokeRef.current) beginStroke(s, s.tool as BrushFamilyTool, dx, dy);
    } else if (s.tool === 'marquee' && e.button === 0) {
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
    const st = strokeRef.current;
    if (st) {
      // 一帧内的合并采样点全部投给引擎(高刷鼠标下更平滑;上游回放所有样本的口径)
      const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
      const samples = native.getCoalescedEvents?.() ?? [];
      const list = samples.length ? samples : [native];
      for (const ev of list) {
        const [x, y] = screenToDoc(s.runtime.view, ev.clientX - rect.left, ev.clientY - rect.top);
        st.pending.push(x, y, 1);
      }
      void pumpStroke();
      scheduleDraw();
      return;
    }
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
    const stroke = strokeRef.current;
    if (s && stroke) {
      // 上游 commit 前的"补齐剩余点":终点本身也要投给引擎,再标记结束
      if (s.state) {
        const rect = wrapRef.current!.getBoundingClientRect();
        const [dx, dy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
        stroke.pending.push(dx, dy, 1);
      }
      stroke.ended = true;
      void pumpStroke();
    }
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

  const onPointerCancel = (e: React.PointerEvent) => {
    const stroke = strokeRef.current;
    if (stroke) {
      strokeRef.current = null;
      void editorStrokeCancel(stroke.docId).catch(() => undefined);
    }
    marqueeRef.current = null;
    eyedropRef.current = null;
    panRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    scheduleDraw();
  };

  const onPointerLeave = () => {
    const s = getSession(tabId);
    if (s && !strokeRef.current) {
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
      onPointerCancel={onPointerCancel}
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
