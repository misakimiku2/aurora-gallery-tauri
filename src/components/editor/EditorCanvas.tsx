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
import { editorFoldDuplicateMove, editorMaskSnapshot, editorMagneticSnap, editorMagneticTrace, editorMoveFrame, editorRender, editorRun, editorStrokeBegin, editorStrokeCancel, editorStrokeCommit, editorStrokePush } from './editorBridge';
import type { StrokeFrame } from './editorBridge';
import { applyRunOutcome, duplicateMove, exportLayerAsPng, getSession, refreshSelectionOutline, runCommand, saveAsSession, saveSession, setOptions, setTool, subscribeSession, updateSession } from './editorStore';
import type { EditorSession } from './editorStore';
import type { EditorTool } from './editorTypes';
import { clampPan, fitToView, screenToDoc, zoomAbout, ZOOM_STEP } from './viewMath';
import {
  BRUSH_FAMILY, brushSizeStep, bucketParams, constrain45, constrainMove, constrainPolygonPoint, constrainStrokePoint, cropCorners, cropDrawn,
  cropFitted, cropFittedRatio, cropFrameAngle, cropHitTurned, cropNormalizedAngle, cropResizedTurned, cropTurnedAngle, cutPathAtLength, effectiveMode, gradientParams, initialMods,
  isMaskTarget, lassoParams, magneticSpacing, marqueeParams, marqueeRect, moveBounds, moveDirtyRect, movePickParams, moveSelectRectParams, nearMagneticStart, nextLassoTool, nextMarqueeShape,
  pathLength, resolveSelectionMode, rgbToHex, sampleHex, selectMode, singleLineParams, strokeCommand,
  strokeParams, TOOL_KEYS, trackMods,
  CROP_HANDLE_PX, CROP_MIN_FRAME, CROP_MIN_LINE_PX,
  type BrushFamilyTool, type CropRect, type DragPoint, type DragMods, type StrokeAxis,
} from './toolLogic';
import { error as logError } from '../../utils/logger';

const BRUSH_TOOLS: ReadonlySet<string> = BRUSH_FAMILY;
/** 离屏位图像素上限(约 36MP);超过则首屏降采样,信息面板取色按 rasterScale 折算。 */
const RASTER_PIXEL_BUDGET = 36_000_000;

/** 裁剪手势的回退快照(press 时的框;尺寸不满足/取消时恢复)。 */
type CropRestore = { rect: CropRect; angle: number; edited: boolean };

/** 裁剪比例预设 key → width/height(上游 chrome_ui::crop_ratio;'original'=文档尺寸)。 */
function cropPresetRatioOf(key: string, docW: number, docH: number): number | null {
  if (!key) return null;
  const [w, h] = key === 'original' ? [docW, docH] : key.split(':').map(Number);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return null;
  const k = w / h;
  return Number.isFinite(k) && k > 0 ? k : null;
}

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
  /** Shift 按住态(画笔族橡皮筋预览的绘制条件;约束本身用指针事件自带的 shiftKey)。 */
  const shiftRef = useRef(false);
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
    /** 待投点 [x,y,pressure,…] 平铺(已过 ⇧ 约束的落笔点)。 */
    pending: number[];
    beginPromise: Promise<void>;
    /** 灰度查看中画蒙版:begin 起帧就是蒙版灰度(引擎侧记录模式),applyStrokeFrame 不得跳过。 */
    maskFrames: boolean;
    /** ⇧ 直线约束状态(上游 stroke_constraint Axis;松开 Shift 置 null)。 */
    axis: StrokeAxis | null;
    /** 最近一个未约束的原始指针位置(Shift 刚按下时约束起点=它)。 */
    lastRaw: [number, number] | null;
    /** 最近一个已投点(提交成功后写入 runtime.lastStrokeEnd)。 */
    lastPoint: [number, number, number] | null;
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
    /** ⇧ 约束的上一帧锁定偏移(8° 迟滞保持方向稳定,上游 move_mods.last)。 */
    lastConstrain: [number, number] | null;
    /** Alt 按下(浮动态在 begin 已带 copy;整层态在首个 ≥2 屏幕像素的移动时复制)。 */
    alt: boolean;
    /** Alt 整层复制状态(上游 move_mods:首次真实移动才 duplicate,⌥-click 不复制):
     * pending=未触发 → dupPromise 建立后每帧等待 → done(副本成为选中,预览即移动副本)/failed(按普通移动继续)。 */
    altDup: 'pending' | 'done' | 'failed';
    dupPromise: Promise<void> | null;
    /** 复制发生前的历史长度(fold_duplicate_move 把复制+平移折叠成一步)。 */
    histBefore: number | null;
    /** rAF 语义的合帧:待发送的最新指针位置。 */
    pending: { x: number; y: number; shift: boolean } | null;
    flushing: boolean;
    /** float 模式:按下切割(select.float)完成后才可预览;失败则降级 layer。 */
    ready: Promise<void>;
  } | null>(null);
  /** 按下代次:pointerdown/up 各自递增;Auto-Select 的异步 pick 链靠它核对按下是否已被抬起/替换。 */
  const moveSeqRef = useRef(0);
  /** 层选框(move_box 口径:Auto-Select 命中空白/锁定层,拖框选层,松手 selectInRect)。 */
  const layerBoxRef = useRef<{ start: [number, number]; end: [number, number]; add: boolean } | null>(null);
  /** 浮动件已提交偏移(select.float 结果回读;脏矩形计算用,选区/revision 变了作废)。 */
  const floatOffsetRef = useRef<{ x: number; y: number; rev: number; sel: string } | null>(null);
  /** 套索拖拽中(上游 lasso_ui 口径:每个 pointer 事件采一点、实线预览、<3 点=取消选择)。 */
  const lassoRef = useRef<{ points: number[][]; mods: DragMods } | null>(null);
  /** 多边形套索进行中(上游 ui.polygon/polygon_mode:逐点连线,首击定运算模式)。
   * 提交走与自由套索同一条 select.lasso。 */
  const polygonRef = useRef<{ points: number[][]; mode: 'replace' | 'add' | 'subtract' | 'intersect' } | null>(null);
  /** 最近一次多边形闭合时刻:双击/三击的后续 click 不许再起新多边形(上游同口径)。 */
  const polygonClosedAt = useRef(0);
  /** 磁性套索进行中(上游 MagneticLasso):path=已钉边框、anchors=path 下标、live=末锚点到
   * 指针的追踪段、trail=自上一锚点起指针走过的路径(边在其附近找)。 */
  const magneticRef = useRef<{
    path: number[][]; anchors: number[]; live: number[][]; trail: number[][];
    mode: 'replace' | 'add' | 'subtract' | 'intersect'; freehand: boolean;
  } | null>(null);
  /** 磁性追踪单飞:一次一条 IPC 在途,期间最新指针位置进 queued,回包后重跑。 */
  const magneticBusy = useRef(false);
  const magneticQueued = useRef<{ x: number; y: number; fasten: boolean } | null>(null);
  /** 裁剪框(上游 crop_ui):未转矩形文档 px [x0,y0,x1,y1] + angle(屏幕顺时针度数)+
   * edited(是否被编辑过;未动默认框=离开丢弃/提交无操作)。null=未建框(draw 懒建)。 */
  const cropRef = useRef<{ rect: [number, number, number, number]; angle: number; edited: boolean } | null>(null);
  /** 裁剪手势(上游 CropDrag):press 快照 + restore(松手不满足最小尺寸时回退)。 */
  const cropDragRef = useRef<
    | { kind: 'draw'; anchor: [number, number]; restore: CropRestore }
    | { kind: 'move'; grab: [number, number]; restore: CropRestore }
    | { kind: 'resize'; hx: -1 | 0 | 1; hy: -1 | 0 | 1; press: [number, number]; keepRatio: number; restore: CropRestore }
    | { kind: 'rotate'; center: [number, number]; grab: number; from: number; restore: CropRestore }
    | null>(null);
  /** 裁剪把手的光标(指针命中变化时更新并触发重渲染)。 */
  const cropCursorRef = useRef<string | null>(null);
  /** 上一次的工具(离开裁剪工具时:未动默认框丢弃、已编辑框静默提交,#3368)。 */
  const prevToolRef = useRef<string | null>(null);
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
    // 工具切换检测:离开裁剪工具时未动默认框丢弃、已编辑框静默提交(上游 #3368 commit_on_leave)
    if (prevToolRef.current !== s.tool) {
      const leavingCrop = prevToolRef.current === 'crop' && s.tool !== 'crop';
      prevToolRef.current = s.tool;
      if (leavingCrop) {
        const f = cropRef.current;
        cropRef.current = null;
        cropDragRef.current = null;
        cropCursorRef.current = null;
        if (f?.edited) s.runtime.cropCommit?.();
      }
    }
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
    if (s.tool === 'crop') ensureCropFrame(s);

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
    // 替换模式画新多边形/磁性边框时隐藏旧选区蚂蚁线(上游 a_new_polygon_hides_the_selection;Esc 还原)
    const hideAnts =
      (s.tool === 'polygonLasso' && polygonRef.current?.mode === 'replace') ||
      (s.tool === 'magneticLasso' && magneticRef.current?.mode === 'replace');
    if (sel && !hideAnts) {
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
    // overlay:多边形套索实线预览(上游 solid_path:白晕 3px + 黑线 1px;末段橡皮筋画到
    // hover 点,Shift 按住时按 45° 约束后的点画)
    if (s.tool === 'polygonLasso' && polygonRef.current && polygonRef.current.points.length >= 1) {
      const pts = polygonRef.current.points;
      const hover = s.runtime.pointerDoc;
      const last = pts[pts.length - 1];
      const rubber = hover && last
        ? (shiftRef.current ? constrainPolygonPoint(last, [hover.x, hover.y]) : [hover.x, hover.y])
        : null;
      const polyPath = () => {
        octx.beginPath();
        pts.forEach(([x, y], i) => {
          const sx = Math.round(x * v.scale + v.ox) + 0.5;
          const sy = Math.round(y * v.scale + v.oy) + 0.5;
          if (i === 0) octx.moveTo(sx, sy);
          else octx.lineTo(sx, sy);
        });
        if (rubber) {
          octx.lineTo(Math.round(rubber[0] * v.scale + v.ox) + 0.5, Math.round(rubber[1] * v.scale + v.oy) + 0.5);
        }
      };
      octx.save();
      octx.lineJoin = 'round';
      octx.lineCap = 'round';
      polyPath();
      octx.strokeStyle = 'rgba(255,255,255,0.55)';
      octx.lineWidth = 3;
      octx.stroke();
      polyPath();
      octx.strokeStyle = '#000000';
      octx.lineWidth = 1;
      octx.stroke();
      octx.restore();
    }

    // overlay:磁性套索(实线边框 path+live;锚点 5×5 白方块+黑边;指针在起点上=闭合圆圈提示)
    if (s.tool === 'magneticLasso' && magneticRef.current && magneticRef.current.path.length >= 1) {
      const m = magneticRef.current;
      const pts = [...m.path, ...m.live.slice(1)];
      const magPath = () => {
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
      magPath();
      octx.strokeStyle = 'rgba(255,255,255,0.55)';
      octx.lineWidth = 3;
      octx.stroke();
      magPath();
      octx.strokeStyle = '#000000';
      octx.lineWidth = 1;
      octx.stroke();
      // 锚点(上游 draw:5×5 白方块 + 1px 黑描边)
      for (const i of m.anchors) {
        const p = m.path[i];
        if (!p) continue;
        const sx = Math.round(p[0] * v.scale + v.ox);
        const sy = Math.round(p[1] * v.scale + v.oy);
        octx.fillStyle = '#ffffff';
        octx.fillRect(sx - 2.5, sy - 2.5, 5, 5);
        octx.strokeStyle = '#000000';
        octx.lineWidth = 1;
        octx.strokeRect(sx - 2.5, sy - 2.5, 5, 5);
      }
      octx.restore();
      // Photoshop 的闭合光标:指针旁的小圆圈(上游 +12,+12 半径 4)
      const hover = s.runtime.pointerDoc;
      const first = m.path[0];
      if (hover && first) {
        const r = 8 / Math.max(0.01, v.scale);
        if (nearMagneticStart(first, [hover.x, hover.y], r, pathLength(m.path) + pathLength(m.live))) {
          const cx = hover.x * v.scale + v.ox + 12;
          const cy = hover.y * v.scale + v.oy + 12;
          octx.beginPath();
          octx.arc(cx, cy, 4, 0, Math.PI * 2);
          octx.strokeStyle = 'rgba(0,0,0,0.78)';
          octx.lineWidth = 3;
          octx.stroke();
          octx.beginPath();
          octx.arc(cx, cy, 4, 0, Math.PI * 2);
          octx.strokeStyle = '#ffffff';
          octx.lineWidth = 1.2;
          octx.stroke();
        }
      }
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

    // overlay:裁剪框(上游 crop_ui):框外遮罩(even-odd 挖洞,正置/斜置同一实现)+
    // 白边 + 三分线(框边线性插值,斜置跟随)+ 8 把手 + 拉直线 + 旋转角度 readout
    if (s.tool === 'crop' && cropRef.current) {
      const f = cropRef.current;
      const toS = (p: [number, number]): [number, number] => [p[0] * v.scale + v.ox, p[1] * v.scale + v.oy];
      const sc = cropCorners(f.rect, f.angle).map(toS);
      const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      octx.save();
      octx.beginPath();
      octx.rect(0, 0, cssW, cssH);
      octx.moveTo(sc[3][0], sc[3][1]);
      for (let i = 0; i < 4; i++) octx.lineTo(sc[i][0], sc[i][1]);
      octx.closePath();
      octx.fillStyle = 'rgba(0,0,0,0.5)';
      octx.fill('evenodd');
      octx.restore();
      octx.save();
      octx.strokeStyle = '#ffffff';
      octx.lineWidth = 1;
      octx.beginPath();
      sc.forEach(([px, py], i) => (i === 0 ? octx.moveTo(px, py) : octx.lineTo(px, py)));
      octx.closePath();
      octx.stroke();
      for (let i = 1; i <= 2; i++) {
        const t = i / 3;
        const top = lerp(sc[0], sc[1], t);
        const bottom = lerp(sc[3], sc[2], t);
        octx.beginPath();
        octx.moveTo(top[0], top[1]);
        octx.lineTo(bottom[0], bottom[1]);
        octx.stroke();
        const left = lerp(sc[0], sc[3], t);
        const right = lerp(sc[1], sc[2], t);
        octx.beginPath();
        octx.moveTo(left[0], left[1]);
        octx.lineTo(right[0], right[1]);
        octx.stroke();
      }
      // 8 把手(四角+边中点;小方块不随框转,小尺寸下不可辨)
      octx.fillStyle = '#ffffff';
      const mid = (a: [number, number], b: [number, number]): [number, number] => lerp(a, b, 0.5);
      for (const hp of [sc[0], mid(sc[0], sc[1]), sc[1], mid(sc[1], sc[2]), sc[2], mid(sc[2], sc[3]), sc[3], mid(sc[3], sc[0])]) {
        octx.fillRect(hp[0] - 3.5, hp[1] - 3.5, 7, 7);
      }
      octx.restore();
      // 拉直线拖画中(上游 crop_straighten:3px 阴影 + 1px 高亮)
      const line = s.runtime.cropStraightenLine;
      if (line) {
        const a = toS([line.x0, line.y0]);
        const b = toS([line.x1, line.y1]);
        octx.save();
        octx.lineCap = 'round';
        for (const [w, c] of [[3, 'rgba(0,0,0,0.55)'], [1, '#ffffff']] as const) {
          octx.beginPath();
          octx.moveTo(a[0], a[1]);
          octx.lineTo(b[0], b[1]);
          octx.strokeStyle = c;
          octx.lineWidth = w;
          octx.stroke();
        }
        octx.restore();
      }
      // 旋转中的角度 readout(指针旁;上游 draw_value_readout)
      if (cropDragRef.current?.kind === 'rotate' && s.runtime.pointerDoc) {
        const px = s.runtime.pointerDoc.x * v.scale + v.ox + 14;
        const py = s.runtime.pointerDoc.y * v.scale + v.oy - 10;
        octx.save();
        octx.font = '11px ui-sans-serif, system-ui';
        octx.fillStyle = 'rgba(0,0,0,0.6)';
        octx.fillText(`${f.angle.toFixed(1)}°`, px + 1, py + 1);
        octx.fillStyle = '#ffffff';
        octx.fillText(`${f.angle.toFixed(1)}°`, px, py);
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

    // overlay:层选框(移动工具 Auto-Select 命中空白/锁定层时按下拖框选层;
    // 上游 move_box::draw 口径 = 蚂蚁线矩形)
    if (layerBoxRef.current) {
      const lb = layerBoxRef.current;
      const lx = Math.min(lb.start[0], lb.end[0]) * v.scale + v.ox;
      const ly = Math.min(lb.start[1], lb.end[1]) * v.scale + v.oy;
      const lw = Math.abs(lb.end[0] - lb.start[0]) * v.scale;
      const lh = Math.abs(lb.end[1] - lb.start[1]) * v.scale;
      drawAnts((c) => {
        c.beginPath();
        c.rect(lx, ly, lw, lh);
      });
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

    // overlay:⇧ 橡皮筋(上游 draw_line_preview):画笔族按住 Shift、无进行中描边且
    // 上一笔终点在本文档——细黑线垫底+细白线从上一笔终点连到指针,预览 Shift+点击将画的直线
    if (BRUSH_TOOLS.has(s.tool) && shiftRef.current && !strokeRef.current
      && s.runtime.lastStrokeEnd && s.runtime.lastStrokeEnd.docId === s.docId && s.runtime.pointerDoc) {
      const end = s.runtime.lastStrokeEnd;
      const ax = end.x * v.scale + v.ox;
      const ay = end.y * v.scale + v.oy;
      const bx = s.runtime.pointerDoc.x * v.scale + v.ox;
      const by = s.runtime.pointerDoc.y * v.scale + v.oy;
      octx.save();
      octx.lineCap = 'round';
      for (const [w, c] of [[2.5, 'rgba(0,0,0,0.47)'], [1, 'rgba(255,255,255,0.9)']] as const) {
        octx.beginPath();
        octx.moveTo(ax, ay);
        octx.lineTo(bx, by);
        octx.strokeStyle = c;
        octx.lineWidth = w;
        octx.stroke();
      }
      octx.restore();
    }

    // 蚂蚁线动画:有选区或拖拽预览时逐帧推进相位(≈15px/s,近 photocraft 上游 10);
    // 选区消失后本循环自然停
    if (s.state.hasSelection || marqueeRef.current || layerBoxRef.current) {
      s.runtime.antsPhase = (s.runtime.antsPhase + 0.25) % 8;
      scheduleDraw();
    }
  }, [tabId]);

  /** live 描边增量帧 → 离屏位图局部贴图(文档坐标矩形,rasterScale<1 时缩放绘制)。
   * 蒙版灰度查看期间默认跳过(移动预览等合成帧会花屏);灰度描边(begin 起 maskFrames)
   * 的帧本身就是蒙版灰度,force=true 放行——这就是灰度查看中的逐笔预览。 */
  const applyStrokeFrame = useCallback((s: EditorSession | undefined, f: StrokeFrame, force = false) => {
    if (!s || !f.width || !f.height) return;
    if (s.state?.layerMaskView?.mode === 'gray' && !force) return;
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
    // 先清后贴:drawImage 是 source-over,擦不掉已有像素——帧里变透明的区域
    // (蒙版画出透明/擦除/移动走出的区域)必须 clearRect 才能落出透明与棋盘格,
    // 否则旧的不透明像素留在离屏位图上,要等提交整幅重渲才消失。
    octx.clearRect(f.x * rs, f.y * rs, f.width * rs, f.height * rs);
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
          applyStrokeFrame(getSession(tabId), frame, st.maskFrames);
        } else if (st.ended) {
          const { outcome, frame } = await editorStrokeCommit(st.docId);
          applyStrokeFrame(getSession(tabId), frame, st.maskFrames);
          strokeRef.current = null;
          // 记录描边终点(⇧+点击直线连接用;上游 last_stroke_end, undo 不清除它)
          const s0 = getSession(tabId);
          if (s0 && st.lastPoint) {
            s0.runtime.lastStrokeEnd = { docId: st.docId, x: st.lastPoint[0], y: st.lastPoint[1], pressure: st.lastPoint[2] };
          }
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
            applyStrokeFrame(s, frame, st.maskFrames);
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

  /** 落笔:建 live 描边(begin 渲染首点),随后的 move 点全部走 pump 批量投递。
   * Shift 按下且上一笔终点在本文档时,点列前置 [上一笔终点(含笔压)]——直线连接段
   * 属于同一笔、一步历史(上游 stroke_constraint connects + canvas.rs Down 口径)。 */
  const beginStroke = useCallback((
    s: EditorSession, tool: BrushFamilyTool, x: number, y: number, shift: boolean,
  ) => {
    const docId = s.docId;
    if (docId == null) return;
    const lastEnd = s.runtime.lastStrokeEnd;
    const connect = shift && lastEnd != null && lastEnd.docId === docId
      && Math.hypot(x - lastEnd.x, y - lastEnd.y) >= 0.25;
    const st = {
      tool, docId, started: false, failed: false, ended: false, pumping: false,
      pending: [] as number[],
      beginPromise: Promise.resolve(),
      // 灰度查看中编辑蒙版:begin 起向引擎要蒙版灰度帧(逐笔预览),否则合成帧
      maskFrames: isMaskTarget(s.state) && s.state?.layerMaskView?.mode === 'gray',
      axis: null as StrokeAxis | null,
      // 约束起点从落笔点起算(上游 last=描边最后一点含落笔;首个移动采样之前它就是落笔点)
      lastRaw: [x, y] as [number, number],
      lastPoint: [x, y, 1] as [number, number, number],
    };
    strokeRef.current = st;
    // 蒙版编辑目标(live 描边走桥层直通,不经引擎 routed 注入,必须显式带 target)
    const params = strokeParams(tool, s.options, rgbToHex(s.state?.foreground), s.runtime.view.scale, isMaskTarget(s.state));
    params.points = connect ? [[lastEnd!.x, lastEnd!.y, lastEnd!.pressure], [x, y, 1]] : [[x, y, 1]];
    st.beginPromise = (async () => {
      try {
        const frame = await editorStrokeBegin(docId, strokeCommand(tool), params, st.maskFrames);
        st.started = true;
        applyStrokeFrame(s, frame, st.maskFrames);
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
        const dirs = st.mode === 'float' ? 8 : 4;
        const { dx, dy } = constrainMove([p.x - st.startDoc.x, p.y - st.startDoc.y], st.lastConstrain, p.shift ? dirs : 0);
        st.lastConstrain = [dx, dy];
        if (dx === st.lastDx && dy === st.lastDy) continue;
        const s = getSession(tabId);
        if (!s?.state || s.docId == null) break;
        // Alt 整层复制(上游 move_mods:首个 ≥2 屏幕像素的移动才 duplicate,⌥-click 不复制):
        // in place 复制后副本成为选中,复制完成前各帧在此等待——之后预览移动的是副本,原件原位不动
        if (st.altDup === 'pending' && !st.dupPromise && Math.hypot(dx, dy) * s.runtime.view.scale >= 2) {
          st.dupPromise = runCommand(tabId, 'layer.duplicate', { inPlace: true })
            .then(() => { if (moveDragRef.current === st) st.altDup = 'done'; })
            .catch((err) => {
              logError('[editor] Alt 复制选中层失败,按普通移动继续', err);
              if (moveDragRef.current === st) st.altDup = 'failed';
            });
        }
        if (st.dupPromise) await st.dupPromise;
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

  /** 建移动拖拽状态(float=选区像素浮动 / layer=整层)。 */
  const startMoveDrag = useCallback((
    s: EditorSession, x: number, y: number, opts: { alt: boolean },
  ) => {
    const st0 = s.state!;
    const layer = st0.layers.find((l) => l.id === st0.activeLayer);
    const floatable = st0.hasSelection && (st0.selectedLayers.length <= 1) && (layer?.visible ?? false) && layer?.kind === 'Pixel';
    const layerBounds = () => moveBounds(st0.layers, st0.activeLayer, st0.width, st0.height);
    const st = {
      mode: (floatable ? 'float' : 'layer') as 'float' | 'layer',
      startDoc: { x, y },
      bounds: floatable ? st0.selectionBounds : layerBounds(),
      lastDx: 0,
      lastDy: 0,
      lastConstrain: null as [number, number] | null,
      alt: opts.alt,
      // 整层 Alt 复制不在按下时做(⌥-click 不得产生副本,上游 DUPLICATE_THRESHOLD 口径),
      // 首个 ≥2 屏幕像素的移动时在 flushMove 里触发
      altDup: (opts.alt && !floatable ? 'pending' : 'done') as 'pending' | 'done' | 'failed',
      dupPromise: null as Promise<void> | null,
      histBefore: st0.historyCurrent,
      pending: null as { x: number; y: number; shift: boolean } | null,
      flushing: false,
      ready: Promise.resolve(),
    };
    moveDragRef.current = st;
    if (floatable) {
      // ⌥=复制浮动(引擎 select.float copy:留原件浮副本);零位移只切浮动不入史
      st.ready = runCommand(tabId, 'select.float', { dx: 0, dy: 0, copy: opts.alt })
        .then(() => undefined, () => {
          // 引擎拒绝(层锁定等):降级整层移动
          if (moveDragRef.current === st) {
            st.mode = 'layer';
            st.bounds = layerBounds();
          }
        });
    }
  }, [tabId]);

  /** 层选框(move_box 口径):Auto-Select 命中空白/锁定层的按下改为拖框选层。 */
  const beginLayerBox = useCallback((s: EditorSession, x: number, y: number, add: boolean) => {
    layerBoxRef.current = { start: [x, y], end: [x, y], add };
    scheduleDraw();
  }, [scheduleDraw]);

  /** 移动工具落笔(上游 canvas.rs Move Down 分发):
   * ① 选区像素可浮动 → 直接切浮动(不做 Auto-Select,选中的像素就是活动层的);
   * ② Auto-Select(选项开且没按 Ctrl / 选项关且按了 Ctrl)→ 探测光标下图层:
   *    锁定层/背景命中 = 点击选中 + 拖出层选框(上游 #4058);完全空白 = 层选框;
   *    命中 = 选中(已选中的多选保持,引擎口径)后照常拖动;
   * ③ 其余 = 整层拖动(链接层随引擎 with_links 扩散)。
   * 探测是异步 IPC:seq 防「探测回来前已抬起/再次按下」。 */
  const beginMoveDrag = useCallback((
    s: EditorSession, x: number, y: number, mods: { alt: boolean; ctrl: boolean; shift: boolean },
  ) => {
    const st0 = s.state!;
    const layer = st0.layers.find((l) => l.id === st0.activeLayer);
    const pixelsFloatable = st0.hasSelection && st0.selectedLayers.length <= 1
      && (layer?.visible ?? false) && layer?.kind === 'Pixel';
    const seq = moveSeqRef.current;
    if (pixelsFloatable || s.options.moveAutoSelect === mods.ctrl) {
      // Ctrl 临时反转 Auto-Select(上游 move_auto_select != mods.command)
      startMoveDrag(s, x, y, { alt: mods.alt });
      return;
    }
    void (async () => {
      const pickMode = mods.shift ? 'add' : 'replace';
      try {
        const probe = (await runCommand(tabId, 'layer.pickAt', movePickParams(x, y, s.options, false))) as { layer: number | null } | null;
        if (moveSeqRef.current !== seq || !getSession(tabId)?.state) return;
        const hit = probe?.layer ?? null;
        const lock = hit != null ? s.state?.lockInfo?.[String(hit)] : undefined;
        const lockedHit = !!lock && (lock.position || lock.all || lock.background);
        const emptyAt = async () => {
          const list = (await runCommand(tabId, 'layer.pickAt', { x, y, list: true })) as { layers: unknown[] };
          return (list?.layers?.length ?? 0) === 0;
        };
        if (lockedHit || (!hit && (await emptyAt()))) {
          // 锁定层仍被点击选中(PS 口径);拖拽画层选框,松手替换/添加
          if (lockedHit) {
            await runCommand(tabId, 'layer.pickAt', movePickParams(x, y, s.options, true, pickMode)).catch(() => undefined);
            if (moveSeqRef.current !== seq) return;
          }
          beginLayerBox(s, x, y, mods.shift);
          return;
        }
        await runCommand(tabId, 'layer.pickAt', movePickParams(x, y, s.options, true, pickMode));
        if (moveSeqRef.current !== seq || !getSession(tabId)?.state) return;
        startMoveDrag(s, x, y, { alt: mods.alt });
      } catch {
        // 探测失败(会话已关等):退回整层拖动
        if (moveSeqRef.current === seq && getSession(tabId)?.state) startMoveDrag(s, x, y, { alt: mods.alt });
      }
    })();
  }, [tabId, startMoveDrag, beginLayerBox]);

  /** 进入裁剪工具/提交或取消后的默认框:选区 bounds ∩ 画布,否则整画布(上游 ensure_frame)。 */
  const ensureCropFrame = (s: EditorSession) => {
    if (cropRef.current || !s.state) return;
    const sel = s.state.selectionBounds;
    let rect: CropRect = sel
      ? [Math.max(0, sel[0]), Math.max(0, sel[1]), Math.min(s.state.width, sel[0] + sel[2]), Math.min(s.state.height, sel[1] + sel[3])]
      : [0, 0, s.state.width, s.state.height];
    if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) rect = [0, 0, s.state.width, s.state.height];
    cropRef.current = { rect, angle: 0, edited: false };
  };

  /** 多边形套索提交(上游 commit_polygon):≥3 点走 select.lasso(与自由套索同一命令),
   * 首击定的运算模式随行;<3 点静默丢弃;闭合后 350ms 内的 click 不再起新多边形。 */
  const commitPolygon = useCallback(() => {
    const poly = polygonRef.current;
    polygonRef.current = null;
    polygonClosedAt.current = Date.now();
    scheduleDraw();
    const st = getSession(tabId);
    if (poly && poly.points.length >= 3 && st?.state) {
      void runCommand(tabId, 'select.lasso', lassoParams(poly.points, st.options, poly.mode))
        .catch((err) => logError('[editor] select.lasso 失败', err));
    }
  }, [tabId]);

  /** 删上一个多边形顶点(上游 polygon_retract:⌫/Delete/右键;删空=取消并还原)。 */
  const retractPolygon = useCallback(() => {
    const poly = polygonRef.current;
    if (!poly) return false;
    poly.points.pop();
    if (poly.points.length === 0) polygonRef.current = null;
    scheduleDraw();
    return true;
  }, []);

  /** 磁性套索选项三元组+提交参数(选项条;宽度/对比度/频率)。 */
  const magneticOpts = useCallback(() => {
    const st = getSession(tabId);
    return {
      width: st?.options.magneticWidth ?? 10,
      contrast: st?.options.magneticContrast ?? 10,
      frequency: st?.options.magneticFrequency ?? 57,
      antiAlias: st?.options.antiAlias ?? true,
      feather: Math.min(1000, Math.max(0, st?.options.feather ?? 0)),
    };
  }, [tabId]);

  /** trail 增量(上游 extend_trail:点距 gap=(width/4).clamp(1,8),边在指针走过的路径附近找)。 */
  const extendTrail = (m: NonNullable<typeof magneticRef.current>, x: number, y: number, width: number) => {
    const gap = Math.min(8, Math.max(1, width / 4));
    const last = m.trail[m.trail.length - 1];
    if (!last || Math.hypot(last[0] - x, last[1] - y) >= gap) m.trail.push([x, y]);
  };

  /** 追踪驱动(上游 follow):trace 末锚点→吸附目标,累计够 spacing 就自动落点(fasten),
   * 否则整段挂 live。单飞:一条 IPC 在途时最新指针进 queued,回包后重跑。 */
  const magneticFollow = useCallback((q: { x: number; y: number }, fasten: boolean) => {
    if (magneticBusy.current) {
      magneticQueued.current = { ...q, fasten };
      return;
    }
    magneticBusy.current = true;
    void (async () => {
      try {
        const st = getSession(tabId);
        let m = magneticRef.current;
        if (!st?.state || !m || st.docId == null || m.freehand) return;
        const opts = magneticOpts();
        const every = magneticSpacing(opts.frequency, st.runtime.view.scale);
        const snapped = await editorMagneticSnap(st.docId, [q.x, q.y] as [number, number], opts.width, opts.contrast).catch(() => null);
        m = magneticRef.current;
        if (!m || st.docId == null) return;
        const target: number[] = snapped?.point ?? [q.x, q.y];
        for (let guard = 0; guard < 64; guard++) {
          m = magneticRef.current;
          if (!m || st.docId == null || m.freehand) return;
          const from = m.path[m.path.length - 1];
          if (!from) return;
          const live = await editorMagneticTrace(st.docId, from as [number, number], target as [number, number], m.trail, opts.width, opts.contrast).catch(() => null);
          m = magneticRef.current;
          if (!m || !live) return;
          const cut = cutPathAtLength(live.points, every);
          if (cut && fasten) {
            m.path.push(...cut[0].slice(1));
            m.anchors.push(m.path.length - 1);
            // 边沿指针从经过新点之后的路径找(上游 follow 的 trail 截断)
            let near = 0;
            let best = Infinity;
            m.trail.forEach((t, i) => {
              const d = Math.hypot(t[0] - cut[1][0], t[1] - cut[1][1]);
              if (d < best) { best = d; near = i; }
            });
            m.trail = [cut[1], ...m.trail.slice(near + 1)];
            continue;
          }
          m.live = live.points;
          return;
        }
      } finally {
        scheduleDraw();
        magneticBusy.current = false;
        const q2 = magneticQueued.current;
        magneticQueued.current = null;
        if (q2) magneticFollow(q2, q2.fasten);
      }
    })();
  }, [tabId, magneticOpts]);

  /** 磁性单击:live 段并入 path 并设锚点(上游 fasten_live)。 */
  const magneticFastenLive = useCallback(() => {
    const m = magneticRef.current;
    if (!m) return;
    if (m.live.length > 1) m.path.push(...m.live.slice(1));
    if (m.path.length > 1) m.anchors.push(m.path.length - 1);
    m.live = [];
    scheduleDraw();
  }, []);

  /** 磁性提交(上游 commit):path 即最终轮廓,select.magneticLasso {trace:false} 一条历史。 */
  const commitMagnetic = useCallback(() => {
    const m = magneticRef.current;
    magneticRef.current = null;
    magneticBusy.current = false;
    magneticQueued.current = null;
    polygonClosedAt.current = Date.now();
    scheduleDraw();
    const st = getSession(tabId);
    if (m && m.path.length >= 3 && st?.state) {
      const opts = magneticOpts();
      void runCommand(tabId, 'select.magneticLasso', {
        points: m.path, trace: false, mode: m.mode, antiAlias: opts.antiAlias, feather: opts.feather,
      }).catch((err) => logError('[editor] select.magneticLasso 失败', err));
    }
  }, [tabId, magneticOpts]);

  /** 磁性闭合(上游 close):Alt=直线连起点;否则沿边描回起点(末点与起点重复,去掉)再提交。 */
  const closeMagnetic = useCallback((alt: boolean) => {
    const st = getSession(tabId);
    const m = magneticRef.current;
    if (!m || !st?.state || st.docId == null) { magneticRef.current = null; return; }
    const first = m.path[0];
    const last = m.path[m.path.length - 1];
    if (!first || !last) { magneticRef.current = null; return; }
    if (alt) {
      m.path.push(first);
      commitMagnetic();
      return;
    }
    const opts = magneticOpts();
    void editorMagneticTrace(st.docId, last as [number, number], first as [number, number], m.trail, opts.width, opts.contrast)
      .then((r) => {
        const m2 = magneticRef.current;
        if (m2 && r.points.length > 2) m2.path.push(...r.points.slice(1, -1));
        commitMagnetic();
      })
      .catch(() => commitMagnetic());
  }, [tabId, magneticOpts, commitMagnetic]);

  /** 磁性删上一锚点(上游 remove_last_point):path 截回锚点、清 live,从指针位置重追
   * (fasten=false,不动指针可连按连删);只剩第一点再删=整条取消。 */
  const magneticRemoveLast = useCallback((px: number, py: number) => {
    const m = magneticRef.current;
    if (!m) return;
    if (m.anchors.length <= 1) {
      magneticRef.current = null;
      scheduleDraw();
      return;
    }
    m.anchors.pop();
    const keep = (m.anchors[m.anchors.length - 1] ?? 0) + 1;
    m.path = m.path.slice(0, Math.max(1, keep));
    m.live = [];
    scheduleDraw();
    magneticFollow({ x: px, y: py }, false);
  }, [magneticFollow]);

  /** 裁剪提交(上游 commit_crop):一条 image.crop——显式矩形允许超出画布(扩展区按背景色
   * 填充),带 angle 时引擎一步完成"转正+裁剪";x/y round,w/h round 后 ≥1。未动默认框
   * (=整画布)无操作;提交成功后适配视图(上游 fit_pending);被拒恢复框。 */
  const commitCrop = useCallback(() => {
    const s = getSession(tabId);
    const f = cropRef.current;
    cropRef.current = null;
    cropDragRef.current = null;
    if (s) {
      s.runtime.cropStraightenArmed = false;
      s.runtime.cropStraightenLine = null;
      if (s.cropAngle !== 0) updateSession(tabId, { cropAngle: 0 });
    }
    if (!f || !s?.state) {
      scheduleDraw();
      return;
    }
    const whole = f.rect[0] <= 0 && f.rect[1] <= 0 && f.rect[2] >= s.state.width && f.rect[3] >= s.state.height;
    if (!f.edited && whole) {
      scheduleDraw();
      return;
    }
    const params: Record<string, unknown> = {
      x: Math.round(f.rect[0]),
      y: Math.round(f.rect[1]),
      width: Math.max(1, Math.round(f.rect[2] - f.rect[0])),
      height: Math.max(1, Math.round(f.rect[3] - f.rect[1])),
    };
    if (Math.abs(f.angle) > 1e-9) params.angle = f.angle;
    void runCommand(tabId, 'image.crop', params)
      .then(() => {
        // 裁剪后适配视图(上游 fit_pending)
        const s2 = getSession(tabId);
        if (s2?.state && wrapRef.current && wrapRef.current.clientWidth > 0) {
          s2.runtime.view = fitToView(s2.state.width, s2.state.height, wrapRef.current.clientWidth, wrapRef.current.clientHeight);
        }
        console.log(`[editor] 已裁剪 ${params.width}x${params.height}${params.angle ? ` @${f.angle.toFixed(1)}°` : ''}`);
      })
      .catch((err) => {
        logError('[editor] image.crop 失败', err);
        cropRef.current = f; // 被拒:保持框(上游 keep/restore)
      });
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  const cancelCrop = useCallback(() => {
    cropRef.current = null;
    cropDragRef.current = null;
    const s = getSession(tabId);
    if (s) {
      s.runtime.cropStraightenArmed = false;
      s.runtime.cropStraightenLine = null;
      if (s.cropAngle !== 0) updateSession(tabId, { cropAngle: 0 });
    }
    scheduleDraw();
  }, [scheduleDraw]);

  /** 设置裁剪框角度(选项条角度输入框;无框时先建默认框)。归一到 (-180,180]。 */
  const cropSetAngle = useCallback((deg: number) => {
    const st = getSession(tabId);
    if (!st?.state) return;
    if (!cropRef.current) {
      const sel = st.state.selectionBounds;
      let rect: CropRect = sel
        ? [Math.max(0, sel[0]), Math.max(0, sel[1]), Math.min(st.state.width, sel[0] + sel[2]), Math.min(st.state.height, sel[1] + sel[3])]
        : [0, 0, st.state.width, st.state.height];
      if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) rect = [0, 0, st.state.width, st.state.height];
      cropRef.current = { rect, angle: 0, edited: false };
    }
    const a = cropNormalizedAngle(deg);
    cropRef.current = { ...cropRef.current, angle: a, edited: true };
    updateSession(tabId, { cropAngle: a });
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  /** 比例预设套用到当前框(选项条下拉 onChange;保中心只减不增,默认框适配不算编辑)。 */
  const cropFitRatio = useCallback(() => {
    const st = getSession(tabId);
    if (!st?.state) return;
    if (!cropRef.current) {
      const sel = st.state.selectionBounds;
      let rect: CropRect = sel
        ? [Math.max(0, sel[0]), Math.max(0, sel[1]), Math.min(st.state.width, sel[0] + sel[2]), Math.min(st.state.height, sel[1] + sel[3])]
        : [0, 0, st.state.width, st.state.height];
      if (rect[2] - rect[0] < 1 || rect[3] - rect[1] < 1) rect = [0, 0, st.state.width, st.state.height];
      cropRef.current = { rect, angle: 0, edited: false };
    }
    const f = cropRef.current;
    const preset = cropPresetRatioOf(st.options.cropRatio, st.state.width, st.state.height);
    if (f && preset != null) {
      const fitted = cropFittedRatio(f.rect, preset);
      if (fitted) cropRef.current = { ...f, rect: fitted };
    }
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  // 注册裁剪回调(选项条 ✓/⊘/比例 用)。会话可能在画布挂载后才创建:除挂载时注册外,
  // 订阅回调里每次通知补注册(requestDraw 同款模式),卸载时清掉。
  useEffect(() => {
    const register = (s: EditorSession) => {
      if (s.runtime.cropCommit !== commitCrop) s.runtime.cropCommit = commitCrop;
      if (s.runtime.cropCancel !== cancelCrop) s.runtime.cropCancel = cancelCrop;
      if (s.runtime.cropFitRatio !== cropFitRatio) s.runtime.cropFitRatio = cropFitRatio;
      if (s.runtime.cropSetAngle !== cropSetAngle) s.runtime.cropSetAngle = cropSetAngle;
    };
    const s0 = getSession(tabId);
    if (s0) register(s0);
    const un = subscribeSession(tabId, () => {
      const s = getSession(tabId);
      if (!s) return;
      if (s.runtime.requestDraw !== scheduleDraw) s.runtime.requestDraw = scheduleDraw;
      register(s);
      forceUpdate((n) => n + 1);
      scheduleDraw();
    });
    return () => {
      un();
      const s = getSession(tabId);
      if (!s) return;
      if (s.runtime.cropCommit === commitCrop) s.runtime.cropCommit = null;
      if (s.runtime.cropCancel === cancelCrop) s.runtime.cropCancel = null;
      if (s.runtime.cropFitRatio === cropFitRatio) s.runtime.cropFitRatio = null;
      if (s.runtime.cropSetAngle === cropSetAngle) s.runtime.cropSetAngle = null;
    };
  }, [tabId, commitCrop, cancelCrop, cropFitRatio, cropSetAngle]);

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
      // Shift 按住态:画笔族的橡皮筋预览(上一笔终点→指针的连线)随键即时显隐
      if (e.key === 'Shift') {
        shiftRef.current = true;
        scheduleDraw();
        return;
      }
      if (isTyping(e.target)) return;
      // [ / ] 调笔径:除 e.key 外还匹配物理键码——中文输入法下 e.key 是全角"【】"，
      // e.code(BracketLeft/Right)不受布局/输入法影响(PS 键位按物理键算)
      const brushKey = e.key === '[' || e.key === ']'
        ? (e.key === ']' ? 1 : -1)
        : e.code === 'BracketRight' ? 1 : e.code === 'BracketLeft' ? -1 : 0;
      if (brushKey !== 0 && s.tool === 'magneticLasso') {
        // 磁性套索:[ ] 调检测宽度 ±1(上游 keys 口径),钳 1..256
        e.preventDefault();
        const next = Math.min(256, Math.max(1, Math.round(s.options.magneticWidth) + brushKey));
        setOptions(tabId, { magneticWidth: next });
        return;
      }
      if (brushKey !== 0) {
        e.preventDefault();
        // 上游 tools.in/decreaseBrushSize 口径:±25% 且至少 ±1px,钳 1..500
        const next = brushSizeStep(s.options.brushSize, brushKey as 1 | -1);
        setOptions(tabId, { brushSize: next });
        console.log(`[editor] brush size ${next}px`);
        return;
      }
      // Enter:裁剪=提交(上游双提交键之一);多边形/套索进行中=提交轮廓;否则落定浮动选区
      if (e.key === 'Enter') {
        e.preventDefault();
        if (s.tool === 'crop') {
          commitCrop();
          return;
        }
        if (s.tool === 'polygonLasso' && polygonRef.current) {
          commitPolygon();
          return;
        }
        if (s.tool === 'magneticLasso' && magneticRef.current) {
          // 沿边闭合;⌥Enter 直线连起点(上游 close 口径)
          magneticBusy.current = false;
          magneticQueued.current = null;
          closeMagnetic(e.altKey);
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
      // Esc:取消进行中的裁剪框/多边形/磁性边框/套索轮廓(不提交任何命令,上游口径)
      if (e.key === 'Escape') {
        if (s.tool === 'crop' && (cropRef.current || cropDragRef.current)) {
          cancelCrop();
          return;
        }
        if (magneticRef.current) {
          magneticRef.current = null;
          magneticBusy.current = false;
          magneticQueued.current = null;
          scheduleDraw();
          return;
        }
        if (polygonRef.current) {
          polygonRef.current = null;
          scheduleDraw();
          return;
        }
        if (lassoRef.current) {
          lassoRef.current = null;
          scheduleDraw();
          return;
        }
      }
      // 裁剪框方向键微移(上游 arrow keys:1px / ⇧ 10px)
      if (s.tool === 'crop' && cropRef.current && !cropDragRef.current) {
        e.preventDefault();
        const d = e.shiftKey ? 10 : 1;
        const ddx = e.key === 'ArrowLeft' ? -d : e.key === 'ArrowRight' ? d : 0;
        const ddy = e.key === 'ArrowUp' ? -d : e.key === 'ArrowDown' ? d : 0;
        const f = cropRef.current;
        cropRef.current = { rect: [f.rect[0] + ddx, f.rect[1] + ddy, f.rect[2] + ddx, f.rect[3] + ddy], angle: f.angle, edited: true };
        scheduleDraw();
        return;
      }
      // 方向键微移(上游 arrow_keys/move_mods::nudge 口径:1px / Shift 10px):
      // 有选区 → 浮动选区像素(零历史,落定时一步 Move);无选区/不可浮 → 整层 translate;
      // Alt = 复制后微移(浮动像素:落定再浮副本移动;整层:桥层原子复制+平移+折叠一步)
      if (s.tool === 'move' && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        const dist = e.shiftKey ? 10 : 1;
        const dx = e.key === 'ArrowLeft' ? -dist : e.key === 'ArrowRight' ? dist : 0;
        const dy = e.key === 'ArrowUp' ? -dist : e.key === 'ArrowDown' ? dist : 0;
        const s0 = s.state;
        const applyFloat = (r: unknown) => {
          const s2 = getSession(tabId);
          const off = (r as { offset?: [number, number] } | null)?.offset;
          if (s2?.state && off) applyFloatOffsetFrame(s2, off, dx, dy);
        };
        const translate = () => void runCommand(tabId, 'layer.translate', { dx, dy }).catch((err) => logError('[editor] 移动失败', err));
        if (e.altKey && s0) {
          if (s0.hasSelection) {
            const floatCopy = () => runCommand(tabId, 'select.float', { dx, dy, copy: true }).then(applyFloat);
            // 已有浮动件:先落定(上游 float_selected copy 口径),再浮副本按 (dx,dy) 移动
            void (s0.floating ? runCommand(tabId, 'select.drop', {}).then(floatCopy) : floatCopy())
              .catch(() => void duplicateMove(tabId, dx, dy).catch((err) => logError('[editor] Alt 复制微移失败', err)));
          } else {
            void duplicateMove(tabId, dx, dy).catch((err) => logError('[editor] Alt 复制微移失败', err));
          }
          return;
        }
        if (s0?.hasSelection) {
          void runCommand(tabId, 'select.float', { dx, dy }).then(applyFloat).catch(translate);
        } else {
          translate();
        }
        return;
      }
      // PS 键位 Delete/Backspace(上游 edit.clear/edit.fill 同键):清除 = 清选区内容
      // (无选区=整层,引擎口径);Alt+=填充前景色;Ctrl+=填充背景色。preventDefault
      // 挡住 webview 的后退/删词默认行为
      if (e.key === 'Backspace' || e.key === 'Delete' || e.code === 'Backspace' || e.code === 'Delete') {
        e.preventDefault();
        if (s.tool === 'magneticLasso' && magneticRef.current) {
          // 磁性套索:⌫ 删上一锚点并从指针位置重追(不动指针可连按连删;上游 remove_last_point)
          magneticBusy.current = false;
          magneticQueued.current = null;
          const pd = s.runtime.pointerDoc;
          magneticRemoveLast(pd?.x ?? magneticRef.current.path[0]?.[0] ?? 0, pd?.y ?? magneticRef.current.path[0]?.[1] ?? 0);
          return;
        }
        if (s.tool === 'polygonLasso' && polygonRef.current) {
          // 多边形套索:⌫/Delete 删上一顶点(删空=取消),不清像素(上游 polygon_retract)
          retractPolygon();
          return;
        }
        if (e.altKey) {
          void runCommand(tabId, 'edit.fill', { contents: 'foreground' }).catch((err) => logError('[editor] 填充前景色失败', err));
        } else if (e.ctrlKey || e.metaKey) {
          void runCommand(tabId, 'edit.fill', { contents: 'background' }).catch((err) => logError('[editor] 填充背景色失败', err));
        } else {
          void runCommand(tabId, 'edit.clear', {}).catch((err) => logError('[editor] 清除失败', err));
        }
        return;
      }
      if (e.ctrlKey || e.metaKey) {
        const k = e.key.toLowerCase();
        // 撤销/重做/图层操作(与工具栏按钮同命令);e.code 兜底防 IME 吃掉字母键
        const k2 = e.code === 'KeyZ' ? 'z' : e.code === 'KeyY' ? 'y'
          : e.code === 'KeyJ' ? 'j' : e.code === 'KeyG' ? 'g'
            : e.code === 'KeyE' ? 'e' : e.code === 'KeyN' ? 'n'
              : e.code === 'KeyC' ? 'c' : e.code === 'KeyX' ? 'x' : e.code === 'KeyV' ? 'v' : k;
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
        } else if (k2 === 'e' && e.shiftKey) {
          e.preventDefault();
          // Ctrl+Shift+E 快速导出当前图层为 PNG(单层文档,不入历史)
          void exportLayerAsPng(tabId).then((r) => {
            if (!r) console.warn('[editor] 快速导出跳过:会话未打开或无活动图层');
          }).catch((err) => logError('[editor] 快速导出失败', err));
        } else if (k2 === 'e') {
          // Ctrl+E = 合并图层(单选=向下合并,上游 layer.mergeLayers 口径;
          // Ctrl+Shift+E 已被快速导出占用,合并可见走图层右键菜单)
          e.preventDefault();
          void runCommand(tabId, 'layer.mergeLayers', {}).catch((err) => logError('[editor] 合并图层失败', err));
        } else if (k2 === 'j') {
          // Ctrl+J = 通过拷贝的图层(带选区=仅拷选中像素);Ctrl+Shift+J = 通过剪切
          e.preventDefault();
          void runCommand(tabId, e.shiftKey ? 'layer.new.layerViaCut' : 'layer.new.layerViaCopy', {})
            .catch((err) => logError('[editor] 建图层失败', err));
        } else if (k2 === 'g') {
          // Ctrl+G = 编组;Ctrl+Shift+G = 解组(上游 Cmd+G / layer.ungroupLayers)
          e.preventDefault();
          void runCommand(tabId, e.shiftKey ? 'layer.ungroupLayers' : 'layer.groupLayers', {})
            .catch((err) => logError('[editor] 编组失败', err));
        } else if (k2 === 'n' && e.shiftKey) {
          // Ctrl+Shift+N = 新建图层(无对话框直建,上游 ⌥⇧⌘N 口径)
          e.preventDefault();
          void runCommand(tabId, 'layer.new.layer', {}).catch((err) => logError('[editor] 新建图层失败', err));
        } else if (k2 === 'c') {
          // Ctrl+C = 复制(选区软乘进 alpha,无选区=整层内容外接矩形);
          // Ctrl+Shift+C = 合并拷贝(可见层合成)。copy 不进历史;桥层后置镜像到 OS 剪贴板
          e.preventDefault();
          void runCommand(tabId, e.shiftKey ? 'edit.copyMerged' : 'edit.copy', {})
            .catch((err) => logError('[editor] 复制失败', err));
        } else if (k2 === 'x') {
          // Ctrl+X = 剪切 = 复制+清除(一条 "Cut Pixels" 历史;普通层清成透明、背景层填背景色;
          // 锁定层在复制前被拒,失败不污染剪贴板)
          e.preventDefault();
          void runCommand(tabId, 'edit.cut', {}).catch((err) => logError('[editor] 剪切失败', err));
        } else if (k2 === 'v') {
          // Ctrl+V = 粘贴(新栅格层插入活动层上方;桥层前置读 OS 剪贴板:自家镜像→原位,
          // 外部新图→画布居中);Ctrl+Shift+V = 原位粘贴(上游 pasteInPlace)
          e.preventDefault();
          void runCommand(tabId, e.shiftKey ? 'edit.pasteSpecial.pasteInPlace' : 'edit.paste', {})
            .catch((err) => logError('[editor] 粘贴失败', err));
        } else if (e.code === 'BracketRight' || k === ']') {
          // Ctrl+] = 上移一层;Ctrl+Shift+] = 移到最前(上游 Cmd+]/Cmd+Shift+];
          // e.code 兜底 IME 吃掉方括号键)
          e.preventDefault();
          void runCommand(tabId, e.shiftKey ? 'layer.arrange.bringToFront' : 'layer.arrange.bringForward', {})
            .catch((err) => logError('[editor] 移动层序失败', err));
        } else if (e.code === 'BracketLeft' || k === '[') {
          // Ctrl+[ = 下移一层;Ctrl+Shift+[ = 移到最后
          e.preventDefault();
          void runCommand(tabId, e.shiftKey ? 'layer.arrange.sendToBack' : 'layer.arrange.sendBackward', {})
            .catch((err) => logError('[editor] 移动层序失败', err));
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
      } else if (k === 'l') {
        // L 键套索组循环:自由套索 ⇄ 多边形套索(上游 lasso 组 L 循环口径)
        setTool(tabId, nextLassoTool(getSession(tabId)?.tool));
      } else if (TOOL_KEYS[k]) {
        setTool(tabId, TOOL_KEYS[k] as EditorTool);
      }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') {
        spaceRef.current = false;
        scheduleDraw();
      }
      if (e.key === 'Shift') {
        shiftRef.current = false;
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
    // 换到其他工具的第一次按下即丢弃进行中的多边形/磁性边框(上游 every_other_tool_drops 口径)
    if (s.tool !== 'polygonLasso' && polygonRef.current) {
      polygonRef.current = null;
      scheduleDraw();
    }
    if (s.tool !== 'magneticLasso' && magneticRef.current) {
      magneticRef.current = null;
      magneticBusy.current = false;
      magneticQueued.current = null;
      scheduleDraw();
    }
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
      if (!strokeRef.current) beginStroke(s, s.tool as BrushFamilyTool, dx, dy, e.shiftKey);
    } else if (s.tool === 'move' && e.button === 0 && s.state) {
      moveSeqRef.current += 1;
      beginMoveDrag(s, dx, dy, { alt: e.altKey, ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    } else if (s.tool === 'lasso' && e.button === 0 && s.state) {
      // 套索:按下即起笔(上游绕过拖拽阈值口径),首点入列
      lassoRef.current = { points: [[dx, dy]], mods: initialMods(e.shiftKey, e.altKey) };
      scheduleDraw();
    } else if (s.tool === 'polygonLasso' && e.button === 0 && s.state) {
      // 多边形套索(上游 polygon_click):单击加点;点距起点 8 屏幕 px 且 ≥3 点=闭合;
      // 首击定运算模式(修饰键,空选区 Alt 降级 replace);Shift 非 Alt=45° 约束;
      // 双击/三击闭合(首击已放最后一点,第二击不再起新多边形)。
      if (Date.now() - polygonClosedAt.current < 350) return;
      const poly = polygonRef.current;
      if (poly && poly.points.length >= 3) {
        const [p0] = poly.points;
        if (Math.hypot(p0[0] - dx, p0[1] - dy) < 8 / Math.max(0.01, s.runtime.view.scale)) {
          commitPolygon();
          return;
        }
      }
      if (!poly) {
        polygonRef.current = {
          points: [[dx, dy]],
          mode: resolveSelectionMode(initialMods(e.shiftKey, e.altKey), s.options.selectionMode, s.state.hasSelection),
        };
      } else {
        const last = poly.points[poly.points.length - 1];
        poly.points.push(e.shiftKey && !e.altKey && last ? constrainPolygonPoint(last, [dx, dy]) : [dx, dy]);
      }
      if (e.detail >= 2) {
        commitPolygon();
        return;
      }
      scheduleDraw();
    } else if (s.tool === 'magneticLasso' && e.button === 0 && s.state) {
      // 磁性套索(上游 magnetic_lasso_ui):首击吸附第一点并定模式;点在起点上=沿边闭合;
      // ⌥ 按下=自由画线段(拖动加点,抬起设锚点);普通单击=live 段钉成锚点。
      if (Date.now() - polygonClosedAt.current < 350) return;
      const m = magneticRef.current;
      if (m && m.path.length >= 1) {
        const total = pathLength(m.path) + pathLength(m.live);
        if (nearMagneticStart(m.path[0], [dx, dy], 8 / Math.max(0.01, s.runtime.view.scale), total)) {
          magneticBusy.current = false;
          magneticQueued.current = null;
          closeMagnetic(e.altKey);
          return;
        }
        if (e.altKey) {
          m.freehand = true;
          m.path.push([dx, dy]);
          scheduleDraw();
          return;
        }
      }
      if (!m) {
        magneticRef.current = {
          path: [], anchors: [], live: [], trail: [], freehand: false,
          mode: resolveSelectionMode(initialMods(e.shiftKey, e.altKey), s.options.selectionMode, s.state.hasSelection),
        };
        if (s.docId != null) {
          void editorMagneticSnap(s.docId, [dx, dy] as [number, number], s.options.magneticWidth, s.options.magneticContrast)
            .then((r) => {
              const m2 = magneticRef.current;
              if (!m2) return;
              m2.path = [r.point ?? [dx, dy]];
              m2.anchors = [0];
              scheduleDraw();
            })
            .catch(() => undefined);
        }
        return;
      }
      magneticFastenLive();
    } else if (s.tool === 'crop' && e.button === 0 && s.state) {
      // 拉直 armed:按下拖画标尺线(松手按长度生效,一次性)
      if (s.runtime.cropStraightenArmed) {
        s.runtime.cropStraightenLine = { x0: dx, y0: dy, x1: dx, y1: dy };
        scheduleDraw();
        return;
      }
      ensureCropFrame(s);
      const f = cropRef.current!;
      const restore: CropRestore = { rect: f.rect, angle: f.angle, edited: f.edited };
      const tol = CROP_HANDLE_PX / s.runtime.view.scale;
      const hit = cropHitTurned(f.rect, f.angle, [dx, dy], tol);
      if (hit.kind === 'handle') {
        // 把手:沿框自身轴调整(斜置=对边页面固定),对边/对角固定
        cropDragRef.current = {
          kind: 'resize', hx: hit.hx, hy: hit.hy, press: [dx, dy],
          keepRatio: (f.rect[2] - f.rect[0]) / (f.rect[3] - f.rect[1]), restore,
        };
      } else if (hit.kind === 'inside' && f.edited) {
        // 已编辑框内部:移动整框(纯平移,保持角度)
        cropDragRef.current = { kind: 'move', grab: [dx, dy], restore };
      } else if (hit.kind === 'inside') {
        // 未动默认框内部:拖画新框(#4461 口径)
        cropDragRef.current = { kind: 'draw', anchor: [dx, dy], restore };
      } else {
        // 框外:绕框中心旋转(⇧ 15° 吸附)
        const cx = (f.rect[0] + f.rect[2]) / 2;
        const cy = (f.rect[1] + f.rect[3]) / 2;
        cropDragRef.current = { kind: 'rotate', center: [cx, cy], grab: Math.atan2(dy - cy, dx - cx), from: f.angle, restore };
      }
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
      // 一帧内的合并采样点全部投给引擎(高刷鼠标下更平滑;上游回放所有样本的口径);
      // ⇧ 按住时每个采样点过直线约束(0°/45°/90° 锁定,上游 stroke_constraint 口径),
      // 投给引擎的是约束后的点——沿直线插值 dabs 由引擎的笔画机制完成
      const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
      const samples = native.getCoalescedEvents?.() ?? [];
      const list = samples.length ? samples : [native];
      for (const ev of list) {
        const [x, y] = screenToDoc(s.runtime.view, ev.clientX - rect.left, ev.clientY - rect.top);
        const raw: [number, number] = [x, y];
        const out = constrainStrokePoint(st.axis, st.lastRaw ?? raw, raw, ev.shiftKey, s.runtime.view.scale);
        st.axis = out.axis;
        st.lastRaw = raw;
        st.lastPoint = [out.p[0], out.p[1], 1];
        st.pending.push(out.p[0], out.p[1], 1);
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
    const lb = layerBoxRef.current;
    if (lb) {
      lb.end = [dx, dy];
      scheduleDraw();
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
    const poly = polygonRef.current;
    if (s.tool === 'polygonLasso' && poly) {
      // 多边形套索:hover 更新橡皮筋终点;⌥ 按住拖动=自由画线(≥1 文档 px 加点,
      // 松开 ⌥ 回直线段、多边形保持打开——上游 canvas.rs Move 分支口径)
      if ((e.buttons & 1) !== 0 && e.altKey) {
        const last = poly.points[poly.points.length - 1];
        if (!last || Math.hypot(last[0] - dx, last[1] - dy) >= 1) poly.points.push([dx, dy]);
      }
      scheduleDraw();
      return;
    }
    const mag = magneticRef.current;
    if (s.tool === 'magneticLasso' && mag) {
      // 磁性套索:hover/拖动持续喂点(上游按下抬起都采样);⌥ 拖=自由画线(≥0.5 px)
      if (mag.freehand) {
        if ((e.buttons & 1) !== 0) {
          const last = mag.path[mag.path.length - 1];
          if (!last || Math.hypot(last[0] - dx, last[1] - dy) >= 0.5) mag.path.push([dx, dy]);
        }
        scheduleDraw();
        return;
      }
      extendTrail(mag, dx, dy, s.options.magneticWidth);
      magneticFollow({ x: dx, y: dy }, true);
      return;
    }
    const cd = cropDragRef.current;
    if (cd) {
      const f = cropRef.current!;
      const preset = cropPresetRatioOf(s.options.cropRatio, s.state.width, s.state.height);
      if (cd.kind === 'draw') {
        cropRef.current = { rect: cropDrawn(cd.anchor, [dx, dy], preset, e.shiftKey, e.altKey), angle: 0, edited: true };
      } else if (cd.kind === 'move') {
        const ddx = dx - cd.grab[0];
        const ddy = dy - cd.grab[1];
        cropRef.current = { rect: [cd.restore.rect[0] + ddx, cd.restore.rect[1] + ddy, cd.restore.rect[2] + ddx, cd.restore.rect[3] + ddy], angle: f.angle, edited: true };
      } else if (cd.kind === 'resize') {
        // ratio 语义(上游 resize_ratio):预设始终生效;无预设时 ⇧=保持按下时框的比例
        const ratio = preset ?? (e.shiftKey ? cd.keepRatio : null);
        cropRef.current = {
          rect: cropResizedTurned(cd.restore.rect, f.angle, cd.hx, cd.hy, [dx - cd.press[0], dy - cd.press[1]], ratio, e.altKey),
          angle: f.angle,
          edited: true,
        };
      } else {
        // 角度约束开关(Shift 临时反转):开=旋转吸附 15° 步进
        const snap = e.shiftKey !== s.options.cropSnapAngle;
        cropRef.current = { rect: cd.restore.rect, angle: cropTurnedAngle(cd.center, cd.grab, cd.from, [dx, dy], snap), edited: true };
      }
      scheduleDraw();
      return;
    }
    if (s.tool === 'crop' && s.runtime.cropStraightenLine) {
      const line = s.runtime.cropStraightenLine;
      s.runtime.cropStraightenLine = { ...line, x1: dx, y1: dy };
      scheduleDraw();
      return;
    }
    // 裁剪悬停光标:把手=对应缩放箭头,已编辑框内部=move,其余 crosshair
    if (s.tool === 'crop' && cropRef.current && cropDragRef.current === null) {
      const f = cropRef.current;
      const hit = cropHitTurned(f.rect, f.angle, [dx, dy], CROP_HANDLE_PX / s.runtime.view.scale);
      const cur = hit.kind === 'handle'
        ? hit.hx !== 0 && hit.hy !== 0 ? (hit.hx * hit.hy > 0 ? 'nwse-resize' : 'nesw-resize') : hit.hx !== 0 ? 'ew-resize' : 'ns-resize'
        : hit.kind === 'inside' && f.edited ? 'move' : 'crosshair';
      if (cropCursorRef.current !== cur) {
        cropCursorRef.current = cur;
        forceUpdate((n) => n + 1);
      }
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
    // 磁性自由画线段(⌥ 拖)抬起=段末设锚点(上游 end_freehand)
    if (s && magneticRef.current?.freehand) {
      const m = magneticRef.current;
      if (m.path.length > 1) m.anchors.push(m.path.length - 1);
      m.freehand = false;
      scheduleDraw();
    }
    if (s && stroke) {
      // 上游 commit 前的"补齐剩余点":终点本身也要投给引擎(过 ⇧ 约束),再标记结束
      if (s.state) {
        const rect = wrapRef.current!.getBoundingClientRect();
        const [dx, dy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
        const out = constrainStrokePoint(stroke.axis, stroke.lastRaw ?? [dx, dy], [dx, dy], e.shiftKey, s.runtime.view.scale);
        stroke.axis = out.axis;
        stroke.lastPoint = [out.p[0], out.p[1], 1];
        stroke.pending.push(out.p[0], out.p[1], 1);
      }
      stroke.ended = true;
      void pumpStroke();
    }
    const md = moveDragRef.current;
    if (s && md && s.state) {
      moveDragRef.current = null;
      const rect = wrapRef.current!.getBoundingClientRect();
      const [ux, uy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
      const dirs = md.mode === 'float' ? 8 : 4;
      const { dx, dy } = constrainMove([ux - md.startDoc.x, uy - md.startDoc.y], md.lastConstrain, e.shiftKey ? dirs : 0);
      const moved = dx !== 0 || dy !== 0;
      // 多选层移动带选区一起走(上游 #7538 carries_selection)
      const carry = s.state.selectedLayers.length > 1 && s.state.hasSelection;
      if (md.mode === 'float') {
        if (moved) {
          // 提交总位移并**立即落定**(PS Move 工具口径,用户已验收"历史即 Move 一步";
          // 上游 photocraft 保持浮动到 Enter,我们此前因状态拉取掉件恰好是立即落定的
          // 行为,state() 改直调 inspect 后把它显式化)。drop 把选区随像素一起挪,
          // 蚂蚁线自动跟上;整幅重渲由 drop 的 revision 驱动
          void runCommand(tabId, 'select.float', { dx, dy })
            .then((r) => {
              const off = (r as { offset?: [number, number] } | null)?.offset;
              const s2 = getSession(tabId);
              if (off && s2?.state) {
                floatOffsetRef.current = {
                  x: off[0], y: off[1], rev: s2.revision, sel: s2.state.selectionBounds?.join(',') ?? '',
                };
              }
              // 落定前补一帧(piece 仍浮动,extra=0 即提交后的正式视图),整幅重渲到达前不闪旧位
              const s3 = getSession(tabId);
              if ((dx !== md.lastDx || dy !== md.lastDy) && s3?.state && s3.docId != null) {
                const dirty = moveDirtyRect(md.bounds, md.lastDx, md.lastDy, dx, dy, s3.state.width, s3.state.height);
                if (dirty.w > 0) {
                  void editorMoveFrame(s3.docId, 'float', 0, 0, dirty.x, dirty.y, dirty.w, dirty.h)
                    .then((f) => applyStrokeFrame(getSession(tabId), f))
                    .catch(() => undefined);
                }
              }
              return runCommand(tabId, 'select.drop', {});
            })
            .catch((err) => logError('[editor] select.float 提交失败', err));
        } else {
          // 原地点击:放回(未动过的 piece 无变化、零历史)
          void runCommand(tabId, 'select.drop', {}).catch(() => undefined);
        }
      } else if (moved && md.alt && md.altDup === 'done') {
        // Alt 拖动 = 复制选中层并移动:复制已在首个真实移动时发生(副本成为选中),
        // 这里提交平移,再把复制+平移折叠成一步 "Duplicate + Move"(上游 fold_history)
        void (async () => {
          await runCommand(tabId, 'layer.translate', { dx, dy, ...(carry ? { selection: true } : {}) });
          if (md.histBefore != null && s.docId != null) {
            const r = await editorFoldDuplicateMove(s.docId, md.histBefore);
            await applyRunOutcome(tabId, { revision: r.revision, viewRevision: 0, damage: null, result: r }, true);
          }
        })().catch((err) => logError('[editor] Alt 复制移动失败', err));
      } else if (moved) {
        // 整层:一条 layer.translate 一步 "Move" 历史;多选层带选区一起走(上游 #7538);
        // revision 变化触发整幅重渲
        void runCommand(tabId, 'layer.translate', { dx, dy, ...(carry ? { selection: true } : {}) })
          .catch((err) => logError('[editor] layer.translate 失败', err));
      }
    }
    moveSeqRef.current += 1;
    const lb = layerBoxRef.current;
    layerBoxRef.current = null;
    if (s && lb && s.state) {
      // 上游 move_box:松手按框选层(selectInRect,负宽高引擎归一);⇧=添加;
      // 点击(w=h=0)在画板外=取消图层选择,画布内空白点击不动选择(#4923)
      const w = lb.end[0] - lb.start[0];
      const h = lb.end[1] - lb.start[1];
      if (w === 0 && h === 0 && !lb.add) {
        const b = s.state;
        const outside = lb.start[0] < 0 || lb.start[1] < 0 || lb.start[0] >= b.width || lb.start[1] >= b.height;
        if (outside) void runCommand(tabId, 'select.deselectLayers', {}).catch(() => undefined);
      }
      if (w !== 0 && h !== 0) {
        void runCommand(tabId, 'layer.selectInRect', moveSelectRectParams(lb.start, w, h, s.options, lb.add))
          .catch((err) => logError('[editor] layer.selectInRect 失败', err));
      }
      scheduleDraw();
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
      const f = cropRef.current!;
      if (cd.kind === 'draw' || cd.kind === 'resize') {
        // 松手时不满足最小尺寸 → 回退到手势前矩形(上游 size_ok)
        const ok = f.rect[2] - f.rect[0] >= CROP_MIN_FRAME && f.rect[3] - f.rect[1] >= CROP_MIN_FRAME;
        if (!ok) cropRef.current = { rect: cd.restore.rect, angle: cd.restore.angle, edited: cd.restore.edited };
        else cropRef.current = { ...f, edited: true };
      }
      // 手势结束同步角度到会话(选项条角度输入框的显示源;拖动中靠指针旁 readout)
      if (cropRef.current && s.cropAngle !== cropRef.current.angle) updateSession(tabId, { cropAngle: cropRef.current.angle });
      scheduleDraw();
    }
    const sline = s?.runtime.cropStraightenLine;
    if (s && sline && s.state) {
      s.runtime.cropStraightenLine = null;
      // 线长 ≥3 屏幕像素才生效(上游 MIN_LINE_PX):角度=标尺线转到最近水平/垂直轴
      const deg = cropFrameAngle([sline.x0, sline.y0], [sline.x1, sline.y1], CROP_MIN_LINE_PX / s.runtime.view.scale);
      if (deg != null) {
        // 框保持自身比例(无框=画布比例),求旋转 deg 后仍完全内含于画布的最大居中框
        const frame = cropRef.current;
        const w = frame ? frame.rect[2] - frame.rect[0] : s.state.width;
        const h = frame ? frame.rect[3] - frame.rect[1] : s.state.height;
        const fitted = cropFitted(w, h, s.state.width, s.state.height, deg);
        if (fitted) {
          cropRef.current = { rect: fitted, angle: deg, edited: true };
          updateSession(tabId, { cropAngle: deg });
        }
      }
      s.runtime.cropStraightenArmed = false; // 一次性:画完一条线自动解除(上游 toggle 口径)
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
    if (md?.mode === 'layer' && md.alt && md.dupPromise) {
      // Alt 整层复制已发生但拖拽中断:退掉复制那一步(上游 move_mods::abandon 同款 undo;
      // 复制在途时等它落地再退,避免 undo 吃到别的步)
      void md.dupPromise.then(() => {
        if (md.altDup === 'done') void runCommand(tabId, 'edit.undo', {}).catch(() => undefined);
      });
    }
    moveDragRef.current = null;
    layerBoxRef.current = null;
    moveSeqRef.current += 1;
    lassoRef.current = null;
    // 裁剪手势中断:回退到手势前矩形;拉直线丢弃(armed 保持,可重画)
    const cdp = cropDragRef.current;
    if (cdp) cropRef.current = { rect: cdp.restore.rect, angle: cdp.restore.angle, edited: cdp.restore.edited };
    cropDragRef.current = null;
    const s0 = getSession(tabId);
    if (s0) s0.runtime.cropStraightenLine = null;
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
  const CROSSHAIR_TOOLS = new Set(['marquee', 'lasso', 'polygonLasso', 'magneticLasso', 'eyedropper', 'gradient', 'bucket']);
  const cursor =
    session.tool === 'hand' || spaceRef.current ? 'grab'
      : session.tool === 'zoom' ? 'zoom-in'
        : BRUSH_TOOLS.has(session.tool) ? 'none'
          : session.tool === 'crop' ? (cropCursorRef.current ?? 'crosshair')
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
      onDoubleClick={(e) => {
        // 裁剪:框内部双击提交(上游 commits_at:把手/框外不算);doc 坐标取双击位置
        const s = getSession(tabId);
        const f = cropRef.current;
        if (s?.tool !== 'crop' || !s.state || !f) return;
        const rect = wrapRef.current!.getBoundingClientRect();
        const [px, py] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
        const hit = cropHitTurned(f.rect, f.angle, [px, py], 0);
        if (hit.kind === 'inside') commitCrop();
      }}
      onContextMenu={(e) => {
        e.preventDefault();
        // 多边形套索画点中:右键=删上一顶点并吃掉菜单(上游 lasso_retracted 口径)
        if (getSession(tabId)?.tool === 'polygonLasso' && polygonRef.current) retractPolygon();
      }}
    >
      <canvas ref={displayRef} className="absolute inset-0" />
      <canvas ref={overlayRef} className="absolute inset-0 pointer-events-none" />
      {session.loading && <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">正在打开…</div>}
      {session.error && <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 p-8 text-center">{session.error}</div>}
    </div>
  );
};
