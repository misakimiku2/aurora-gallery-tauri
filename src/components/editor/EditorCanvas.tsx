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
import { editorMaskSnapshot, editorMoveFrame, editorRender, editorStrokeBegin, editorStrokeCancel, editorStrokeCommit, editorStrokePush } from './editorBridge';
import type { StrokeFrame } from './editorBridge';
import { applyRunOutcome, getSession, refreshSelectionOutline, runCommand, saveAsSession, saveSession, setOptions, setTool, subscribeSession } from './editorStore';
import type { EditorSession } from './editorStore';
import type { EditorTool } from './editorTypes';
import { clampPan, fitToView, screenToDoc, zoomAbout, ZOOM_STEP } from './viewMath';
import {
  BRUSH_FAMILY, brushSizeStep, bucketParams, constrain45, effectiveMode, gradientParams, initialMods,
  isMaskTarget, lassoParams, marqueeParams, marqueeRect, moveBounds, moveDelta, moveDirtyRect, nextMarqueeShape,
  resolveSelectionMode, rgbToHex, sampleHex, selectMode, singleLineParams, strokeCommand,
  strokeParams, TOOL_KEYS, trackMods,
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
  /** 移动工具拖拽中(photocraft move_ui 口径:按下即切割浮动、拖动纯函数预览、提交一条命令)。 */
  const moveDragRef = useRef<{
    mode: 'float' | 'layer';
    startDoc: { x: number; y: number };
    bounds: [number, number, number, number] | null;
    lastDx: number;
    lastDy: number;
    /** rAF 语义的合帧:待发送的最新指针位置。 */
    pending: { x: number; y: number; shift: boolean } | null;
    flushing: boolean;
    /** float 模式:按下切割(select.float)完成后才可预览;失败则降级 layer。 */
    ready: Promise<void>;
  } | null>(null);
  /** 浮动件已提交偏移(select.float 结果回读;脏矩形计算用,选区/revision 变了作废)。 */
  const floatOffsetRef = useRef<{ x: number; y: number; rev: number; sel: string } | null>(null);
  /** 套索拖拽中(上游 lasso_ui 口径:每个 pointer 事件采一点、实线预览、<3 点=取消选择)。 */
  const lassoRef = useRef<{ points: number[][]; mods: DragMods } | null>(null);
  /** 裁剪框(文档坐标;null=未触碰默认框=整幅画布,提交无操作)。 */
  const cropRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  /** 裁剪拖画新框中。 */
  const cropDragRef = useRef<(DragPoint & { mods: DragMods }) | null>(null);
  /** 渐变拖线中(上游 classic 口径:拖方向线,松手一条命令)。 */
  const gradientRef = useRef<(DragPoint & { mods: DragMods }) | null>(null);
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
    // overlay:渐变方向线预览(上游 classic 口径:3px 黑(α140)垫底 + 1px 白,两端白色实心圆)
    if (gradientRef.current) {
      const g = gradientRef.current;
      const to = g.mods.liveShift ? constrain45([g.x0, g.y0], [g.x1, g.y1]) : [g.x1, g.y1];
      const ax = g.x0 * v.scale + v.ox;
      const ay = g.y0 * v.scale + v.oy;
      const bx = to[0] * v.scale + v.ox;
      const by = to[1] * v.scale + v.oy;
      octx.save();
      octx.lineCap = 'round';
      octx.beginPath();
      octx.moveTo(ax, ay);
      octx.lineTo(bx, by);
      octx.strokeStyle = 'rgba(0,0,0,0.55)';
      octx.lineWidth = 3;
      octx.stroke();
      octx.beginPath();
      octx.moveTo(ax, ay);
      octx.lineTo(bx, by);
      octx.strokeStyle = '#ffffff';
      octx.lineWidth = 1;
      octx.stroke();
      octx.fillStyle = '#ffffff';
      for (const [cx, cy] of [[ax, ay], [bx, by]]) {
        octx.beginPath();
        octx.arc(cx, cy, 3, 0, Math.PI * 2);
        octx.fill();
      }
      octx.restore();
    }

    // overlay:裁剪框(上游 crop 口径简化版):框外 50% 遮罩 + 白边 + 三分线 + 角柄
    if (s.tool === 'crop') {
      const frame = cropDragRef.current ? marqueeRect(cropDragRef.current, cropDragRef.current.mods) : cropRef.current;
      if (frame) {
        const fx = frame.x * v.scale + v.ox;
        const fy = frame.y * v.scale + v.oy;
        const fw = frame.w * v.scale;
        const fh = frame.h * v.scale;
        octx.save();
        octx.fillStyle = 'rgba(0,0,0,0.5)';
        octx.fillRect(v.ox, v.oy, dw, fy - v.oy);
        octx.fillRect(v.ox, fy + fh, dw, v.oy + dh - (fy + fh));
        octx.fillRect(v.ox, fy, fx - v.ox, fh);
        octx.fillRect(fx + fw, fy, v.ox + dw - (fx + fw), fh);
        octx.strokeStyle = '#ffffff';
        octx.lineWidth = 1;
        octx.strokeRect(fx + 0.5, fy + 0.5, fw - 1, fh - 1);
        octx.strokeStyle = 'rgba(255,255,255,0.45)';
        octx.beginPath();
        for (let i = 1; i <= 2; i++) {
          octx.moveTo(fx + (fw * i) / 3, fy);
          octx.lineTo(fx + (fw * i) / 3, fy + fh);
          octx.moveTo(fx, fy + (fh * i) / 3);
          octx.lineTo(fx + fw, fy + (fh * i) / 3);
        }
        octx.stroke();
        octx.restore();
      }
    }

    // overlay:套索拖拽实线预览(上游 tool_feedback::draw_solid_path:白晕 3px + 黑线 1px,
    // 开放路径不闭合,点取整到像素中心保持 1px 线锐利)
    if (lassoRef.current) {
      const pts = lassoRef.current.points;
      if (pts.length >= 2) {
        const lassoPath = () => {
          octx.beginPath();
          pts.forEach(([x, y], i) => {
            const sx = Math.round(x * v.scale + v.ox) + 0.5;
            const sy = Math.round(y * v.scale + v.oy) + 0.5;
            if (i === 0) octx.moveTo(sx, sy);
            else octx.lineTo(sx, sy);
          });
        };
        octx.save();
        octx.lineJoin = 'round';
        octx.lineCap = 'round';
        lassoPath();
        octx.strokeStyle = 'rgba(255,255,255,0.55)';
        octx.lineWidth = 3;
        octx.stroke();
        lassoPath();
        octx.strokeStyle = '#000000';
        octx.lineWidth = 1;
        octx.stroke();
        octx.restore();
      }
    }

    // overlay:选框拖拽实时预览(约束同提交口径:拖拽中新按的 Shift=正方形 / Alt=从中心);
    // 单行/单列:贯穿整幅的 1px 定位线,跟随指针位置
    if (marqueeRef.current) {
      const m = marqueeRef.current;
      const shape = s.options.marqueeShape;
      if (shape === 'row' || shape === 'column') {
        octx.save();
        octx.setLineDash([4, 4]);
        octx.strokeStyle = '#ffffffcc';
        octx.lineWidth = 1;
        octx.beginPath();
        if (shape === 'row') {
          const sy = Math.round(m.y1) * v.scale + v.oy;
          octx.moveTo(v.ox, sy);
          octx.lineTo(v.ox + dw, sy);
        } else {
          const sx = Math.round(m.x1) * v.scale + v.ox;
          octx.moveTo(sx, v.oy);
          octx.lineTo(sx, v.oy + dh);
        }
        octx.stroke();
        octx.strokeStyle = '#000000cc';
        octx.lineDashOffset = 4;
        octx.stroke();
        octx.restore();
      } else {
        const r = marqueeRect(m, m.mods);
        if (r) {
          octx.save();
          octx.setLineDash([4, 4]);
          octx.strokeStyle = '#ffffffcc';
          octx.lineWidth = 1;
          octx.beginPath();
          if (shape === 'ellipse') {
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

  /** live 描边增量帧 → 离屏位图局部贴图(文档坐标矩形,rasterScale<1 时缩放绘制)。
   * 蒙版灰度查看期间跳过:增量帧是合成像素,贴进灰度位图会花屏;提交后 revision
   * 前移触发灰度快照整幅重拉(代价:灰度查看中描边无逐笔预览)。 */
  const applyStrokeFrame = useCallback((s: EditorSession | undefined, f: StrokeFrame) => {
    if (!s || !f.width || !f.height) return;
    if (s.state?.layerMaskView?.mode === 'gray') return;
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
    // 蒙版编辑目标(live 描边走桥层直通,不经引擎 routed 注入,必须显式带 target)
    const params = strokeParams(tool, s.options, rgbToHex(s.state?.foreground), s.runtime.view.scale, isMaskTarget(s.state));
    params.points = [[x, y, 1]];
    st.beginPromise = (async () => {
      try {
        const frame = await editorStrokeBegin(docId, strokeCommand(tool), params);
        st.started = true;
        applyStrokeFrame(s, frame);
      } catch (err) {
        // 隐藏层/无图层等引擎拒绝:无副作用,取消本地状态即可(日志可查)。
        // 失败也可能发生在引擎 begin 成功之后(帧解析/上屏抛错)——补发 cancel,
        // 不让 Rust 侧留下悬空 live(否则此后每次落笔都被拒)。
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

  /** 移动拖拽泵:单飞循环,把 pending 的最新指针位置合成一帧预览(纯函数,不入历史)。 */
  const flushMove = useCallback(async () => {
    const st = moveDragRef.current;
    if (!st || st.flushing || !st.pending) return;
    st.flushing = true;
    try {
      while (moveDragRef.current === st) {
        const p = st.pending;
        st.pending = null;
        if (!p) break;
        await st.ready;
        const { dx, dy } = moveDelta(p.x - st.startDoc.x, p.y - st.startDoc.y, p.shift);
        if (dx === st.lastDx && dy === st.lastDy) continue;
        const s = getSession(tabId);
        if (!s?.state || s.docId == null) break;
        const dirty = moveDirtyRect(st.bounds, st.lastDx, st.lastDy, dx, dy, s.state.width, s.state.height);
        st.lastDx = dx;
        st.lastDy = dy;
        if (dirty.w > 0) {
          try {
            const frame = await editorMoveFrame(s.docId, st.mode, dx, dy, dirty.x, dirty.y, dirty.w, dirty.h);
            applyStrokeFrame(getSession(tabId), frame);
          } catch (err) {
            // 浮动被并发命令撤掉等瞬时态:跳过这帧(不 logError,提交时会兜底)
            console.debug('[editor] move preview frame skipped', err);
          }
        }
      }
    } finally {
      if (moveDragRef.current === st) {
        st.flushing = false;
        if (st.pending) void flushMove();
      }
    }
  }, [tabId, applyStrokeFrame]);

  /** 方向键微移浮动选区后补帧(float 不推进 revision,不会触发整幅重渲)。 */
  const applyFloatOffsetFrame = useCallback((
    s: EditorSession, offset: [number, number], dx: number, dy: number,
  ) => {
    const sel = s.state?.selectionBounds;
    if (!sel || s.docId == null) return;
    const prev = floatOffsetRef.current;
    const prevOff = prev && prev.rev === s.revision && prev.sel === sel.join(',')
      ? { x: prev.x, y: prev.y }
      : { x: offset[0] - dx, y: offset[1] - dy };
    const dirty = moveDirtyRect(sel, prevOff.x, prevOff.y, offset[0], offset[1], s.state!.width, s.state!.height);
    floatOffsetRef.current = { x: offset[0], y: offset[1], rev: s.revision, sel: sel.join(',') };
    if (dirty.w > 0) {
      void editorMoveFrame(s.docId!, 'float', 0, 0, dirty.x, dirty.y, dirty.w, dirty.h)
        .then((frame) => applyStrokeFrame(getSession(tabId), frame))
        .catch((err) => console.debug('[editor] float offset frame skipped', err));
    }
  }, [tabId, applyStrokeFrame]);

  /** 移动工具落笔:有选区且活动层是像素层 → 切割浮动(上游口径:不看按下点是否在选区内);
   * 引擎拒绝(锁定/非像素层)降级整层;无选区直接整层。 */
  const beginMoveDrag = useCallback((
    s: EditorSession, x: number, y: number,
  ) => {
    const st0 = s.state!;
    const layer = st0.layers.find((l) => l.id === st0.activeLayer);
    const floatable = st0.hasSelection && layer?.kind === 'Pixel';
    const layerBounds = () => moveBounds(st0.layers, st0.activeLayer, st0.width, st0.height);
    const st = {
      mode: (floatable ? 'float' : 'layer') as 'float' | 'layer',
      startDoc: { x, y },
      bounds: floatable ? st0.selectionBounds : layerBounds(),
      lastDx: 0,
      lastDy: 0,
      pending: null as { x: number; y: number; shift: boolean } | null,
      flushing: false,
      ready: Promise.resolve(),
    };
    moveDragRef.current = st;
    if (floatable) {
      st.ready = runCommand(tabId, 'select.float', { dx: 0, dy: 0 })
        .then(() => undefined, () => {
          // 引擎拒绝(层锁定等):降级整层移动
          if (moveDragRef.current === st) {
            st.mode = 'layer';
            st.bounds = layerBounds();
          }
        });
    }
  }, [tabId]);

  /** 裁剪提交(上游 commit_crop 口径;image.crop,历史 "Crop",选区随裁剪清除):
   * 未触碰默认框/整幅框=无操作;框钳进画布(画布外扩展留待办)。 */
  const commitCrop = useCallback(() => {
    const s = getSession(tabId);
    if (!s?.state) return;
    const c = cropRef.current;
    cropRef.current = null;
    cropDragRef.current = null;
    if (!c) {
      scheduleDraw();
      return;
    }
    const x = Math.max(0, c.x);
    const y = Math.max(0, c.y);
    const w = Math.min(s.state.width, c.w - Math.max(0, -c.x));
    const h = Math.min(s.state.height, c.h - Math.max(0, -c.y));
    if (w < 1 || h < 1 || (x <= 0 && y <= 0 && w >= s.state.width && h >= s.state.height)) {
      scheduleDraw();
      return;
    }
    void runCommand(tabId, 'image.crop', { x, y, width: Math.round(w), height: Math.round(h) })
      .catch((err) => logError('[editor] image.crop 失败', err));
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  const cancelCrop = useCallback(() => {
    cropRef.current = null;
    cropDragRef.current = null;
    scheduleDraw();
  }, [scheduleDraw]);

  // 注册裁剪回调(选项条 ✓/⊘ 用,与 requestDraw 同机制)
  useEffect(() => {
    const s = getSession(tabId);
    if (!s) return;
    s.runtime.cropCommit = commitCrop;
    s.runtime.cropCancel = cancelCrop;
    return () => {
      if (s.runtime.cropCommit === commitCrop) s.runtime.cropCommit = null;
      if (s.runtime.cropCancel === cancelCrop) s.runtime.cropCancel = null;
    };
  }, [tabId, commitCrop, cancelCrop]);

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
  // 蒙版灰度查看(view.layerMask,视图态不推 revision):key 带上它,视图开合/换层都会重拉
  const maskViewKey = session?.state?.layerMaskView ? `${session.state.layerMaskView.layer}:${session.state.layerMaskView.mode}` : '';
  useEffect(() => {
    const s = getSession(tabId);
    if (!s || s.docId == null || !s.state) return;
    const key = `${s.docId}:${s.revision}:${maskViewKey}`;
    if (bitmapKeyRef.current === key) return;
    bitmapKeyRef.current = key;
    let cancelled = false;
    (async () => {
      try {
        const docPx = s.state!.width * s.state!.height;
        const rs = docPx > RASTER_PIXEL_BUDGET ? Math.sqrt(RASTER_PIXEL_BUDGET / docPx) : 1;
        const maxW = rs < 1 ? Math.round(s.state!.width * rs) : undefined;
        const maxH = rs < 1 ? Math.round(s.state!.height * rs) : undefined;
        // 灰度查看:位图换蒙版快照(灰度 RGBA,同一 rasterScale 管线);正常:合成渲染
        const gray = s.state!.layerMaskView?.mode === 'gray'
          ? s.state!.layerMaskView.layer
          : null;
        const bmp = gray != null
          ? await editorMaskSnapshot(s.docId!, gray, maxW ?? s.state!.width, maxH ?? s.state!.height)
          : await editorRender(s.docId!, maxW, maxH);
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
        // 从实际位图宽反推(蒙版快照按 k 步长取整,与请求的 maxW 有 ±1 差)
        s.runtime.rasterScale = bmp.width / s.state!.width;
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
  }, [tabId, docIdForBitmap, revisionForBitmap, stateReady, docW, docH, maskViewKey]);

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
      // Enter:裁剪=提交(上游双提交键之一);套索进行中=提交轮廓;否则落定浮动选区
      if (e.key === 'Enter') {
        e.preventDefault();
        if (s.tool === 'crop') {
          commitCrop();
          return;
        }
        const ls = lassoRef.current;
        const st = getSession(tabId);
        if (ls && st?.state) {
          if (ls.points.length >= 3) {
            const mode = resolveSelectionMode(ls.mods, st.options.selectionMode, st.state.hasSelection);
            lassoRef.current = null;
            void runCommand(tabId, 'select.lasso', lassoParams(ls.points, st.options, mode))
              .catch((err) => logError('[editor] select.lasso 失败', err));
          } else {
            lassoRef.current = null;
            scheduleDraw();
          }
        } else {
          void runCommand(tabId, 'select.drop', {}).catch(() => undefined);
        }
        return;
      }
      // Esc:取消进行中的裁剪框/套索轮廓(不提交任何命令,上游口径)
      if (e.key === 'Escape') {
        if (s.tool === 'crop' && (cropRef.current || cropDragRef.current)) {
          cancelCrop();
          return;
        }
        if (lassoRef.current) {
          lassoRef.current = null;
          scheduleDraw();
          return;
        }
      }
      // 方向键微移(上游 arrow_keys 口径:1px / Shift 10px):
      // 有选区 → 浮动选区像素(零历史,落定时一步 Move);无选区/不可浮 → 整层 translate
      if (s.tool === 'move' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const dist = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -dist : e.key === 'ArrowRight' ? dist : 0;
        const dy = e.key === 'ArrowUp' ? -dist : e.key === 'ArrowDown' ? dist : 0;
        if (s.state?.hasSelection) {
          void runCommand(tabId, 'select.float', { dx, dy })
            .then((r) => {
              // float 不推进 revision,不触发重渲:按结果 offset 补预览帧
              const s2 = getSession(tabId);
              const off = (r as { offset?: [number, number] } | null)?.offset;
              if (s2?.state && off) applyFloatOffsetFrame(s2, off, dx, dy);
            })
            .catch(() => {
              // 层不可浮(锁定/非像素层):降级整层
              void runCommand(tabId, 'layer.translate', { dx, dy }).catch((err) => logError('[editor] 移动失败', err));
            });
        } else {
          void runCommand(tabId, 'layer.translate', { dx, dy }).catch((err) => logError('[editor] 移动失败', err));
        }
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
        } else if (k2 === 's') {
          e.preventDefault();
          if (e.shiftKey) {
            // Ctrl+Shift+S 另存为(格式对话框,文档改绑新文件)
            void saveAsSession(tabId).then((r) => {
              if (!r) console.warn('[editor] 另存为跳过:会话未打开或文档无路径');
            }).catch((err) => logError('[editor] 另存为失败', err));
          } else {
            // Ctrl+S 保存(拍板:覆盖原图 + 同名 .psd 分层伴生;引擎原子写)。
            // 落盘后 saveSession 广播 aurora-editor-saved,App 监听刷新图库。
            void saveSession(tabId).then((r) => {
              if (!r) console.warn('[editor] 保存跳过:会话未打开或文档无路径');
            }).catch((err) => logError('[editor] Ctrl+S 保存失败', err));
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
        } else if (k === '\\') {
          // Ctrl+\ = 编辑目标切到活动图层的蒙版(上游 Cmd+\;无蒙版时引擎拒绝,静默)
          e.preventDefault();
          void runCommand(tabId, 'channel.target.layerMask', {}).catch(() => undefined);
        } else if (k === '2') {
          // Ctrl+2 = 回合成编辑目标(上游 Cmd+2)
          e.preventDefault();
          void runCommand(tabId, 'channel.target.composite', {}).catch(console.error);
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
        // M 键组内循环:矩形→椭圆→单行→单列(PS 口径四形态)
        const st = getSession(tabId);
        if (st?.tool === 'marquee') {
          setOptions(tabId, { marqueeShape: nextMarqueeShape(st.options.marqueeShape) });
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
    } else if (s.tool === 'move' && e.button === 0 && s.state) {
      beginMoveDrag(s, dx, dy);
    } else if (s.tool === 'lasso' && e.button === 0 && s.state) {
      // 套索:按下即起笔(上游绕过拖拽阈值口径),首点入列
      lassoRef.current = { points: [[dx, dy]], mods: initialMods(e.shiftKey, e.altKey) };
      scheduleDraw();
    } else if (s.tool === 'crop' && e.button === 0 && s.state) {
      // 裁剪:拖画新框(约束同选框:Shift 正方形 / Alt 从中心)
      cropDragRef.current = { x0: dx, y0: dy, x1: dx, y1: dy, mods: initialMods(e.shiftKey, e.altKey) };
      scheduleDraw();
    } else if (s.tool === 'gradient' && e.button === 0 && s.state) {
      // 渐变:拖方向线(Shift 吸附 45°;松手 ≥2px 才发命令)
      gradientRef.current = { x0: dx, y0: dy, x1: dx, y1: dy, mods: initialMods(e.shiftKey, e.altKey) };
      scheduleDraw();
    } else if (s.tool === 'bucket' && e.button === 0 && s.state) {
      // 油漆桶:纯点击即填(上游口径,无拖拽);Alt=临时吸管
      if (e.altKey) {
        eyedropRef.current = { last: performance.now() };
        pickColor(s);
      } else {
        void runCommand(tabId, 'paint.bucket', bucketParams(dx, dy, s.options, rgbToHex(s.state.foreground), isMaskTarget(s.state)))
          .catch((err) => logError('[editor] paint.bucket 失败', err));
      }
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
    const md = moveDragRef.current;
    if (md) {
      md.pending = { x: dx, y: dy, shift: e.shiftKey };
      void flushMove();
      return;
    }
    const ls = lassoRef.current;
    if (ls) {
      // 上游口径:每个 PointerMoved 事件都采一个顶点(无距离节流),仅完全重复去重
      const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
      const samples = native.getCoalescedEvents?.() ?? [];
      const list = samples.length ? samples : [native];
      for (const ev of list) {
        const [x, y] = screenToDoc(s.runtime.view, ev.clientX - rect.left, ev.clientY - rect.top);
        const last = ls.points[ls.points.length - 1];
        if (x !== last[0] || y !== last[1]) ls.points.push([x, y]);
      }
      scheduleDraw();
      return;
    }
    const cd = cropDragRef.current;
    if (cd) {
      cd.x1 = dx;
      cd.y1 = dy;
      cd.mods = trackMods(cd.mods, e.shiftKey, e.altKey);
      scheduleDraw();
      return;
    }
    const gr = gradientRef.current;
    if (gr) {
      gr.x1 = dx;
      gr.y1 = dy;
      gr.mods = trackMods(gr.mods, e.shiftKey, e.altKey);
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
    const md = moveDragRef.current;
    if (s && md && s.state) {
      moveDragRef.current = null;
      const rect = wrapRef.current!.getBoundingClientRect();
      const [ux, uy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
      const { dx, dy } = moveDelta(ux - md.startDoc.x, uy - md.startDoc.y, e.shiftKey);
      const moved = dx !== 0 || dy !== 0;
      if (md.mode === 'float') {
        if (moved) {
          // 提交总位移(累加进浮动件并保持浮动;落定=Enter/下一命令,上游口径)
          void runCommand(tabId, 'select.float', { dx, dy })
            .then((r) => {
              const off = (r as { offset?: [number, number] } | null)?.offset;
              const s2 = getSession(tabId);
              if (off && s2?.state) {
                floatOffsetRef.current = {
                  x: off[0], y: off[1], rev: s2.revision, sel: s2.state.selectionBounds?.join(',') ?? '',
                };
              }
              // 预览未覆盖到的最终位移补一帧(提交后 extra=0 即正式视图)
              const s3 = getSession(tabId);
              if ((dx !== md.lastDx || dy !== md.lastDy) && s3?.state && s3.docId != null) {
                const dirty = moveDirtyRect(md.bounds, md.lastDx, md.lastDy, dx, dy, s3.state.width, s3.state.height);
                if (dirty.w > 0) {
                  void editorMoveFrame(s3.docId, 'float', 0, 0, dirty.x, dirty.y, dirty.w, dirty.h)
                    .then((f) => applyStrokeFrame(s3, f))
                    .catch(() => undefined);
                }
              }
            })
            .catch((err) => logError('[editor] select.float 提交失败', err));
        } else {
          // 原地点击:放回(未动过的 piece 无变化、零历史)
          void runCommand(tabId, 'select.drop', {}).catch(() => undefined);
        }
      } else if (moved) {
        // 整层:一条 layer.translate 一步 "Move" 历史;revision 变化触发整幅重渲
        void runCommand(tabId, 'layer.translate', { dx, dy, ...(s.state.hasSelection ? { selection: true } : {}) })
          .catch((err) => logError('[editor] layer.translate 失败', err));
      }
    }
    const m = marqueeRef.current;
    marqueeRef.current = null;
    eyedropRef.current = null;
    const cd = cropDragRef.current;
    cropDragRef.current = null;
    const gr = gradientRef.current;
    gradientRef.current = null;
    if (s && gr && s.state) {
      // 上游口径:曼哈顿距离 <2px = 无操作;Shift 吸附 45° 方向
      const to: [number, number] = gr.mods.liveShift ? constrain45([gr.x0, gr.y0], [gr.x1, gr.y1]) : [gr.x1, gr.y1];
      if (Math.abs(gr.x1 - gr.x0) + Math.abs(gr.y1 - gr.y0) >= 2) {
        void runCommand(tabId, 'paint.gradient', gradientParams([gr.x0, gr.y0], to, s.options, isMaskTarget(s.state)))
          .catch((err) => logError('[editor] paint.gradient 失败', err));
      }
      scheduleDraw();
    }
    if (s && cd && s.state) {
      const r = marqueeRect(cd, cd.mods);
      // 拖出的框成为裁剪框(即使等于整幅——commit 时判无操作);近零位移保留原框
      if (r) cropRef.current = r;
      scheduleDraw();
    }
    const ls = lassoRef.current;
    lassoRef.current = null;
    if (s && ls && s.state) {
      // 上游 canvas.rs Lasso 分支:≥3 点提交 select.lasso;<3 点(含单击)= 取消选择
      if (ls.points.length >= 3) {
        const mode = resolveSelectionMode(ls.mods, s.options.selectionMode, s.state.hasSelection);
        void runCommand(tabId, 'select.lasso', lassoParams(ls.points, s.options, mode))
          .catch((err) => logError('[editor] select.lasso 失败', err));
      } else {
        void runCommand(tabId, 'select.deselect', {}).catch(console.error);
      }
      scheduleDraw();
    }
    if (s && m && s.state) {
      const shape = s.options.marqueeShape;
      // mode:按下时修饰键优先(空选区降级);无修饰键用选项条显式四态(上游 #1106 口径)
      const mode = resolveSelectionMode(m.mods, s.options.selectionMode, s.state.hasSelection);
      if (shape === 'row' || shape === 'column') {
        // 单行/单列:位置=释放点,点击即定位(PS 口径,不取消选择)
        const rect = wrapRef.current!.getBoundingClientRect();
        const [, uy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
        const [ux] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
        void runCommand(tabId, 'select.rect', singleLineParams(shape, shape === 'row' ? uy : ux, s.state.width, s.state.height, s.options, mode))
          .catch((err) => logError('[editor] select.rect line 失败', err));
      } else {
        const r = marqueeRect(m, m.mods);
        if (r) {
          void runCommand(tabId, 'select.rect', marqueeParams(r, s.options, mode))
            .catch((err) => logError('[editor] select.rect', err));
        } else {
          // 点击(近零位移)= 取消选择(PS 行为;无选区时引擎空转无历史步)
          void runCommand(tabId, 'select.deselect', {}).catch(console.error);
        }
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
    const md = moveDragRef.current;
    if (md?.mode === 'float') {
      // 浮动件已切割:必须 drop 放回(零历史),否则像素留在浮动态丢失显示
      void runCommand(tabId, 'select.drop', {}).catch(() => undefined);
    }
    moveDragRef.current = null;
    lassoRef.current = null;
    cropDragRef.current = null;
    gradientRef.current = null;
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
      onDoubleClick={() => {
        // 裁剪:框内双击提交(上游口径)
        if (getSession(tabId)?.tool === 'crop') commitCrop();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={displayRef} className="absolute inset-0" />
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      {session.loading && <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">正在打开…</div>}
      {session.error && <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 p-8 text-center">{session.error}</div>}
    </div>
  );
};
