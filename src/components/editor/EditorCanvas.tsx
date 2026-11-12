/**
 * 编辑器画布:三层结构。
 *  0) CSS 棋盘格(由显示 canvas 自绘,锚定文档原点)
 *  1) 文档位图:离屏 canvas,revision 变化整幅替换;live 描边期间按 damage 矩形局部贴图
 *  2) overlay:选区框/笔刷圆环/工具预览(蚂蚁线等)
 * 交互:滚轮=绕指针缩放(PS 习惯)、空格/中键/抓手=平移、缩放工具点击、[/] 调笔径。
 * 画笔族(brush/eraser/blur/sharpen/smudge):落笔 begin → 每帧批量 push(引擎在文档克隆上
 * 渲染真像素,返回 damage 增量帧直接贴进离屏位图)→ 抬笔 commit(fromLive 命中则跳过整幅重渲)。
 */
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { editorFoldDuplicateMove, editorMaskSnapshot, editorMagneticSnap, editorMagneticTrace, editorMoveFrame, editorMoveHover, editorPlace, editorRender, editorRun, editorSelectMaskView, editorSelectionTransformBegin, editorState, editorStrokeBegin, editorStrokeCancel, editorStrokeCommit, editorStrokePush, editorTakeBackMade, editorTransformBegin } from './editorBridge';
import type { StrokeFrame } from './editorBridge';
import { applyRunOutcome, cancelTransform, closeExportDialog, closePathsDialog, closeSelectMask, closeShapeDialog, commitTransform, confirmExportDialog, confirmPathsDialog, confirmSelectMask, confirmShapeDialog, duplicateMove, exportLayerAsPng, finishTransformCommit, getSession, markInteractiveRender, openExportDialog, openSelectMask, openShapeDialog, paintSelectMaskStroke, PATH_TOOLS, refreshPathsList, refreshSelectionOutline, refreshWorkPath, runCommand, saveAsSession, saveSession, selectMaskDefaultOpacity, SELECT_MASK_MODES, setOptions, setTransformSession, setTransformSplit, setTool, showEditorNotice, subscribeSession, syncTransformProjection, updateSession, updateSelectMask, updateShapeDialog, type SelectMaskMode } from './editorStore';
import type { EditorSession, ToolOptions } from './editorStore';
import { isWhrKey, whrCommitParams, whrRatio } from './cropSize';
import type { EditorTool } from './editorTypes';
import { clampPan, docToScreen, fitToView, screenToDoc, zoomAbout, ZOOM_STEP } from './viewMath';
import {
  BRUSH_FAMILY, brushSizeStep, bucketParams, constrain45, constrainMove, constrainPolygonPoint, constrainStrokePoint, cropCorners, cropDrawn,
  cropFitted, cropFittedRatio, cropFrameAngle, cropHitTurned, cropNormalizedAngle, cropResizedTurned, cropTurnedAngle, cropTurnCursorDir, cutPathAtLength, effectiveMode, gradientLiveCreateParams, gradientLiveAt, gradientLiveHit, gradientMidDragParams, gradientParams, gradientStopDragParams, gradientStopIndexAfter, initialMods,
  isMaskTarget, lassoParams, magneticPressureWidth, magneticSpacing, marqueeParams, marqueeRect, moveBounds, moveDirtyRect, movePickParams, moveSelectRectParams, nearMagneticStart, nextGradientTool, nextLassoTool, nextMarqueeShape, nextPathTool, nextPenTool, nextShapeTool, nextTypeTool,
  isShapeClick, SHAPE_GROUP, shapeBounds, shapeDialogGeometry, shapeDialogKind, shapeFillStroke, shapeGeometry,
  pathLength, resolveSelectionMode, rgbToHex, sampleHex, selectMode, singleLineParams, snap45, strokeCommand,
  strokeParams, TOOL_KEYS, trackMods,
  CROP_HANDLE_PX, CROP_MIN_FRAME, CROP_MIN_LINE_PX,
  type BrushFamilyTool, type CropRect, type DragPoint, type DragMods, type StrokeAxis,
} from './toolLogic';
import {
  affApply, affInvert, applyReplace, boxHandleAt, boxOfShape, CARET_BLINK_MS, charCount, clickSelection,
  columnWidthVec, flowKey, imeRange, insideBox, layerNameFromText, lineSelectionSpan, lineToText, makesBox,
  MAX_CLICKS, normText, resizeBoxCalc, smartQuotes, TYPE_PLACEHOLDER, TYPE_TOOLS, wordBoundary, lineBoxHit,
  type CaretSegment, type TextEditSession, type TypeInfoLine, type TextShapeBox,
} from './typeLogic';
import { CHAR_TOGGLE_KEYS, styleAt, type CharStyleJson } from './typeStyle';
import { fetchGradientFill, type GradientFillInfo } from './gradientFill';
import { ColorPicker, type RGB } from './panels/ColorPicker';
import { PickerCard } from './panels/PickerCard';
import { ShapeDialog } from './ShapeDialog';
import { closing as penClosing, overFirstAnchor, penBreakHandle, penDown, penFromJson, penGrabHandle, penMove, penToJson, penUndoLastPoint, penUp, curvePoints, pathLines, resumeAt, shift45 as penShift45, type EnginePathJson } from './penLogic';
import { withResumedSubpath, type EditSubpath } from './pathEdit';
import { getCachedPathGeo } from './panels/PathsPanel';
import { activePathName, pathRows } from './pathsPanelLogic';
import type { EnginePathJson as WorkPathJson } from './penLogic';
import {
  addAnchor as peAddAnchor, anchorsIn as peAnchorsIn, bendSegment as peBendSegment, clonePath as peClone, convertPoint as peConvertPoint,
  deleteAnchor as peDeleteAnchor, evalSeg as peEval, hitPath as peHit, moveAnchors as peMoveAnchors, moveHandle as peMoveHandle,
  shownHandles as peShownHandles, subpathAnchors as peSubpathAnchors, translatePath as peTranslate, pickShapeAt,
  type EditPath, type Handle as PeHandle, type KnotRef, type PathHit, type Pt,
} from './pathEdit';
import type { EditorLayer } from './editorTypes';
import type { PenPath as PenDraft } from './penLogic';
import { error as logError } from '../../utils/logger';
import {
  acceptsOutsideClick, applyDrag, applyModeDrag, corners, handleTolerance, hitTest, insideQuad, modeAllows, quadIsAffine, quadUnchanged, quadScale,
  nudgeTransform, pointOnQuad, readout as transformReadout, restoreStep, rotateAboutPivot, scaleAboutPivot, setPivotAnchor, skewAboutPivot, movePivotTo,
  stepEq, stepOf, Homography,
  type Gesture, type Hit, type Quad, type RectF, type TransformMode, type TransformSession, type TransformStep, type TransformMods,
} from './transformLogic';
import {
  handleAnchor, meshControlBounds, meshDragPoint, meshEval, meshIdentity, meshNx, meshNy, meshParamAt, meshPoint, meshPull, previewSamples,
  psdWarpToShort, quickSplitKind, resetWarp, resizeWarp, splitWarp, surfaceAt, triangleOrder, warpCustom, warpGridId, warpHit,
  warpMap, warpToMesh, WARP_PRESETS, WARP_STYLE_ZH, type Pt as WPt, type SplitKind, type WarpMesh, type WarpObject,
} from './warpLogic';

/** Warp 拖拽(上游 WarpDrag):锚/柄跟指针,其余面片跟指针表面。 */
type WarpDrag =
  | { kind: 'point'; index: number; start: WPt; pts0: WPt[] }
  | { kind: 'surface'; s: number; t: number; start: WPt; pts0: WPt[] };

const BRUSH_TOOLS: ReadonlySet<string> = BRUSH_FAMILY;
/** 直接选择族工具(上游 direct_select/anchor_tools 的指针接管者)。 */
const DS_TOOLS: ReadonlySet<string> = new Set(['directSelect', 'addAnchor', 'deleteAnchor', 'convertPoint']);
/** 图层树里按 id 找层(路径选择按下拾取后查 kind;inspect 树顶层=最上层,同序遍历)。 */
const findLayerTree = (layers: { id: number; kind: string; hasVectorMask?: boolean; children?: { id: number; kind: string; hasVectorMask?: boolean; children?: unknown[] }[] }[], id: number | null): { id: number; kind: string; hasVectorMask?: boolean } | null => {
  if (id == null) return null;
  for (const l of layers) {
    if (l.id === id) return l;
    if (l.children) {
      const found = findLayerTree(l.children as never, id);
      if (found) return found;
    }
  }
  return null;
};
/** 离屏位图像素上限(约 36MP);超过则首屏降采样,信息面板取色按 rasterScale 折算。 */
const RASTER_PIXEL_BUDGET = 36_000_000;
/** 交互期降载(PS「低分辨率预览」同款)的视口像素上限(约 4MP):拖动滑杆/渐变时泵按
 * 视口 dpr² 出图,把高频交互的每帧上传从 96MB 级压到 ~10MB 级;下限 1MP 兜底极小窗口。 */
const RASTER_VIEWPORT_BUDGET = 4_000_000;
/** 交互期但拿不到视口尺寸(挂起/隐藏)时的降载预算(约 2MP)。 */
const RASTER_INTERACTIVE_FALLBACK = 2_000_000;

/**
 * 精确十字光标(PS Precise Cursor 口径):黑影垫底 + 白芯的双色自绘光标。原生 crosshair
 * 跟随 Windows 系统主题(深色系统=纯白),在浅色画面上完全看不见(用户报障);双色版
 * 任何底色都可见。选框/套索族/吸管/渐变/油漆桶共用。
 */
const CROSSHAIR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="21" height="21"><g fill="none" stroke-linecap="round"><path d="M10.5 1.5V19.5M1.5 10.5H19.5" stroke="rgba(0,0,0,0.8)" stroke-width="3"/><path d="M10.5 1.5V19.5M1.5 10.5H19.5" stroke="#ffffff" stroke-width="1.3"/></g></svg>`;
const CROSSHAIR_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(CROSSHAIR_SVG)}") 10 10, crosshair`;

/** 图层树里找 id(inspect 的展示序含 children;变换 end_if_left 的"层被删"判定用)。 */
function findLayerById(layers: EditorLayer[], id: number): boolean {
  for (const l of layers) {
    if (l.id === id) return true;
    if (l.children && findLayerById(l.children, id)) return true;
  }
  return false;
}

/** 裁剪手势的回退快照(press 时的框;尺寸不满足/取消时恢复)。 */
type CropRestore = { rect: CropRect; angle: number; edited: boolean };

/** type.info 返回(引擎 journal:false 查询;字符索引=Unicode 标量,行盒=文字空间 px,
 * transform=引擎 Affine 六元组 [a,b,c,d,e,f])。 */
interface TypeInfoJson {
  layer: number;
  text: string;
  /** serde 外标签:'Point' | {Box:{x,y,width,height}} | {Path:…} | {Area:…}。 */
  shape: unknown;
  transform: number[];
  antialias: string;
  orientation: string;
  /** 层已有 Warp Text(doc/src/text.rs TextWarp,snake_case;style="warpNone"=无)。 */
  warp?: { style: string; value: number; horizontal_distortion: number; vertical_distortion: number; horizontal: boolean } | null;
  lines: TypeInfoLine[];
  runs: { start: number; end: number; style: Record<string, unknown> }[];
  bounds: [number, number, number, number] | null;
  pxPerPt: number;
}

/** 裁剪比例预设 key → width/height(上游 chrome_ui::crop_ratio;'original'=文档尺寸;
 * whr/preset:*=W×H×分辨率模式,按字段换算,上游 crop_size::ratio)。 */
function cropPresetRatioOf(key: string, o: ToolOptions, docW: number, docH: number, docDpi: number): number | null {
  if (isWhrKey(key)) return whrRatio(o, docDpi);
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
  /** Alt 按住态(Select and Mask 边刷光标形态刷新;笔划方向用指针事件自带的 altKey)。 */
  const altRef = useRef(false);
  /** Select and Mask 边刷涂抹中(左键按住期间,move 连续 paint)。 */
  const smStrokeRef = useRef(false);
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
  /** 移动工具悬停高亮(上游 move_hover):缓存键=doc:rev:像素:组,resting 指针零每帧开销。 */
  const moveHoverRef = useRef<{ key: string; bounds: [number, number, number, number] | null } | null>(null);
  const moveHoverBusy = useRef(false);
  const moveHoverQueued = useRef<{ x: number; y: number; group: boolean } | null>(null);
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
  /** 裁剪框专属 undo/redo(上游 #3145:裁剪待定期间 Ctrl+Z/Redo 步进框快照而非文档;
   * press=当前手势按下时的快照,松手且框变化时推入 undo)。 */
  const cropHistoryRef = useRef<{
    undo: { rect: [number, number, number, number]; angle: number; edited: boolean }[];
    redo: { rect: [number, number, number, number]; angle: number; edited: boolean }[];
    press: { rect: [number, number, number, number]; angle: number; edited: boolean } | null;
  }>({ undo: [], redo: [], press: null });
  /** 上一次的工具(离开裁剪工具时:未动默认框丢弃、已编辑框静默提交,#3368)。 */
  const prevToolRef = useRef<string | null>(null);
  /** 渐变拖线中(上游 classic 口径:拖方向线,松手一条命令)。 */
  const gradientRef = useRef<(DragPoint & { mods: DragMods }) | null>(null);
  /** 形状族拖拽中(二期 二-1,上游 Drag:起点+当前点+全程最大位移[is_click 判定])。 */
  const shapeDragRef = useRef<{ tool: EditorTool; sx: number; sy: number; ex: number; ey: number; maxDev: number } | null>(null);
  // 路径选择(二-5):按下起点 + pickAt 代次(防探测回来前已抬起,Auto-Select 同款)
  const psDragRef = useRef<{ sx: number; sy: number } | null>(null);
  const psSeqRef = useRef(0);
  /** 钢笔草稿(二期 二-2,上游 app.ui.pen:编辑器态,Enter/闭合/切工具才提交)。 */
  const penRef = useRef<PenDraft | null>(null);
  /** 直接选择拖拽(二期 二-3,上游 direct_select::Drag):编辑预览或框选。 */
  const dsDragRef = useRef<
    | { kind: 'edit'; edit: DsEdit; base: EditPath; start: Pt; end: Pt; preview: EditPath | null }
    | { kind: 'marquee'; start: Pt; end: Pt; add: boolean }
    | null
  >(null);
  /** 直接选择的段点选(与 store.directSel.segment 同源,press 时写入)。 */
  type DsEdit =
    | { kind: 'anchors'; anchors: KnotRef[] }
    | { kind: 'handle'; knot: KnotRef; handle: PeHandle; from: Pt; independent: boolean }
    | { kind: 'segment'; knot: KnotRef; t: number }
    | { kind: 'convert'; knot: KnotRef };
  /** Live 渐变:选中渐变填充图层的信息(gradient.fill.get,revision 过期自动重拉)。 */
  const liveFillRef = useRef<GradientFillInfo | null>(null);
  /** Live 渐变手势:Draw=拖出新线(选中渐变图层时 redraw 它),Edit=拖选中图层的起止点/线,
   * Stop/Mid=拖色标/中点菱形(节流提交 gradient.fill.stop + coalesce 合一步历史=实时预览;
   * stops/mids 是按下时的快照,其余色标/段在拖动中不动,overlay 直接用它画)。
   * Hold=抬笔后的保持态:overlay 继续画本地终态几何,直到 refetch 落地(修订版防"松手闪回
   * 旧位"——直接清空手势会回退到过期的 liveFillRef),1s 兜底/再次按下时清除。 */
  const liveGradRef = useRef<
    | { kind: 'draw'; from: [number, number]; to: [number, number]; mods: DragMods; redraw: number | null; moved: boolean }
    | { kind: 'edit'; layer: number; which: 'start' | 'end' | 'line'; orig: { from: [number, number]; to: [number, number] }; grab: [number, number]; grabT: number; from: [number, number]; to: [number, number]; moved: boolean }
    | { kind: 'stop'; layer: number; from: [number, number]; to: [number, number]; reverse: boolean; stops: Array<[number, string]>; mids: number[]; origIndex: number; curIdx: number; t: number; tornOff: boolean; moved: boolean; down: [number, number] }
    | { kind: 'mid'; layer: number; from: [number, number]; to: [number, number]; reverse: boolean; stops: Array<[number, string]>; mids: number[]; seg: number; a: number; b: number; value: number; moved: boolean; down: [number, number] }
    | { kind: 'hold'; fill: GradientFillInfo; rev0: number; token: object }
    | null
  >(null);
  /** Live 渐变手势序号(coalesce 键一次手势一个,期间其他命令不得插入)+ 节流时间戳。 */
  const gradGestureRef = useRef({ seq: 0, lastSent: 0 });
  /** 预览提交的背压:一次只放一条在途,期间最新指针状态合并到尾沿、回包后补发
   * (防命令/渲染队列积压失控——积压时像素滞后滚雪球到秒级,用户报障根因)。 */
  const gradInflightRef = useRef<{ busy: boolean; pending: null | (() => void) }>({ busy: false, pending: null });
  /** hold 兜底计时器句柄(新手势/卸载时清)。 */
  const gradHoldTimerRef = useRef<number | null>(null);
  /** 自由变换(二-8,上游 transform_tool):会话真源 + 预览资源 + 手势/hover + 会话内步骤栈。
   * bg/tex = begin 时的两张离屏 canvas(隐藏层背景/层纹理,均覆盖 frame∩画布);
   * store.transform 是投影(松手/选项条提交时回写,选项条显示+键位判定用)。 */
  const transformRef = useRef<{
    session: TransformSession | null;
    docId: number | null;
    kind: string;
    bg: HTMLCanvasElement | null;
    tex: HTMLCanvasElement | null;
    rect: RectF | null;
    gesture: Gesture | null;
    hover: Hit | null;
    readout: string | null;
    /** Warp 模式拖拽(上游 WarpDrag):控制点/面片,每次从按下快照 pts0 重算。 */
    warpDrag: WarpDrag | null;
    /** 武装分割/快捷分割(Ctrl/Alt):抬起落线;pointer=跟随指针的文档点。 */
    warpSplit: { tool: SplitKind | null; placing: boolean; quick: boolean; pointer: Pt | null } | null;
    /** Warp 模式 hover 的控制点下标(光标/柄显隐用)。 */
    warpHover: number | null;
    /** 文字层 Warp Text:进入时读回的初始 warp(Esc 脏判定)+会话 coalesce key。 */
    warpType0: WarpObject | null;
    warpCoalesceKey: string | null;
    /** tex 相对 rect 的缩小倍数(变换选区的蒙版染色纹理;贴图源坐标除它)。 */
    texScale: number;
    steps: { settled: TransformStep | null; undo: TransformStep[]; redo: TransformStep[]; lastNudge: { at: number; step: TransformStep } | null };
  }>({ session: null, docId: null, kind: '', bg: null, tex: null, rect: null, gesture: null, hover: null, readout: null, warpDrag: null, warpSplit: null, warpHover: null, warpType0: null, warpCoalesceKey: null, texScale: 1, steps: { settled: null, undo: [], redo: [], lastNudge: null } });
  /** 上一次 Live 渐变无拖动点击(双击取色判定:同 grab 键 450ms 内,上游 DOUBLE_CLICK)。 */
  const gradLastClickRef = useRef<{ key: string; time: number } | null>(null);
  // ===== 文字编辑会话(二期 二-6,上游 type_tool.rs;会话态在 store.textEdit,这些是画布侧) =====
  /** type.info 缓存(上游 app.type_layout 的 key=docId:layer:revision 等价)。 */
  const typeInfoRef = useRef<{ key: string; info: TypeInfoJson } | null>(null);
  /** type.caret 段缓存(per revision;overlay 亮块/隐藏 input 定位共用)。 */
  const caretSegRef = useRef<{ key: string; segs: Map<number, CaretSegment> } | null>(null);
  /** 会话侧文本镜像(smartQuotes 前字符/提交判空;真值在引擎,info 刷新对齐)。 */
  const typeTextRef = useRef('');
  /** 段落框把手拖缩(上游 BoxResize:按下时的 shape/transform 快照+节流尾沿)。 */
  const typeResizeRef = useRef<{ handle: number; shape: TextShapeBox; transform: number[]; lastSent: number; pending: [number, number, number, number] | null } | null>(null);
  /** 文字工具空白处按下:拖框手势(松手 makesBox 判定,上游 pointer_up)。 */
  const typeDragRef = useRef<{ start: [number, number] } | null>(null);
  /** 可能是编辑既有文字的按下(异步 hitTest 确认期间挂起;上游 pointer_down 同步判定的 Web 等价)。 */
  const typePendingRef = useRef<{ start: [number, number]; detail: number; down: boolean } | null>(null);
  /** Move 双击进编辑时的返回工具(上游 text_edit_return_tool)。 */
  const typeReturnToolRef = useRef<EditorTool | null>(null);
  /** 会话键序号+caret 闪烁起点(上游 caret_blink_time)。 */
  const typeSeqRef = useRef(0);
  const typeBlinkRef = useRef(0);
  /** 承接 IME 的隐藏 textarea(候选窗锚定其元素矩形;上游 egui IMEOutput 的 Web 等价)。 */
  const typeInputRef = useRef<HTMLTextAreaElement>(null);
  /** 拖拽选字 caret 命中的节流时间戳(60ms;hitTest 是 journal:false 便宜查询,仍防洪水)。 */
  const typeMoveHitRef = useRef({ last: 0 });
  /** beforeinput 原生处理器(每渲染更新;React 的 onBeforeInput 是合成事件,Chromium 的
   * 原生 beforeinput 不派发它——insertText/insertParagraph 只能走原生监听)。 */
  const typeBeforeInputRef = useRef<(ev: InputEvent) => void>(() => undefined);
  /** 隐藏 textarea 的 ref 回调:元素出现/替换即挂原生监听(不能靠 effect——首渲染
   * session 未建时组件 return null,textarea 缺席,effect 空跑后 deps 不变不再重试)。 */
  const typeInputUnbindRef = useRef<(() => void) | null>(null);
  const attachTypeInput = useCallback((el: HTMLTextAreaElement | null) => {
    typeInputUnbindRef.current?.();
    typeInputUnbindRef.current = null;
    (typeInputRef as { current: HTMLTextAreaElement | null }).current = el;
    if (el) {
      const listener = (ev: Event) => typeBeforeInputRef.current(ev as InputEvent);
      el.addEventListener('beforeinput', listener);
      typeInputUnbindRef.current = () => el.removeEventListener('beforeinput', listener);
    }
  }, []);
  /** 双击色标/端点的取色卡(上游 Color Picker (Stop Color) 对话框:确定一条命令,取消不动)。 */
  const [stopPicker, setStopPicker] = useState<{ layer: number; index: number; rgb: RGB; x: number; y: number } | null>(null);
  const sessionRef = useRef<EditorSession | undefined>(undefined);
  /** 位图位图代数:docId+revision 变化时刷新离屏画布。 */
  const bitmapKeyRef = useRef('');
  /** 位图泵互斥(跨 effect 实例/StrictMode 双挂载):同一时刻只有一个渲染循环在跑。 */
  const bitmapBusyRef = useRef(false);
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
      const leavingPen = prevToolRef.current === 'pen' && s.tool !== 'pen';
      // 离开直接选择族=清空选择(上游 direct_selection 随工具语义)
      const leavingDs = prevToolRef.current !== null && DS_TOOLS.has(prevToolRef.current) && !DS_TOOLS.has(s.tool) && s.tool !== 'pen';
      prevToolRef.current = s.tool;
      if (leavingDs && (s.directSel.anchors.length || s.directSel.segment)) {
        updateSession(tabId, { directSel: { target: null, anchors: [], segment: null } });
      }
      if (leavingCrop) {
        const f = cropRef.current;
        cropRef.current = null;
        cropDragRef.current = null;
        cropCursorRef.current = null;
        cropHistoryRef.current = { undo: [], redo: [], press: null }; // 离开=框历史清空(上游 commit_on_leave→clear_history)
        if (f?.edited) s.runtime.cropCommit?.();
      }
      // 离开钢笔=草稿自动提交保留开放路径(上游 lib.rs commit_on_leave 口径)
      if (leavingPen) commitPen(false);
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

    // 文档位图;自由变换激活=抽层预览(上游 begin 抽层口径):rect(frame∩画布)区域
    // **先 clearRect 挖掉原像素**(bg 多为部分透明,叠加盖不住——单层图 bg 全透明,直接
    // 叠加=原像素透出="两张图"),重铺棋盘格再贴隐藏该层的合成;选区像素场景再把选区外
    // 区域贴回原样(非选中像素留在原地,split_selected 语义)。
    const tr = transformRef.current;
    dctx.imageSmoothingEnabled = v.scale < 1;
    dctx.imageSmoothingQuality = 'high';
    dctx.drawImage(s.runtime.offscreen, v.ox, v.oy, dw, dh);
    if (tr.session && tr.bg && tr.rect) {
      const [rx0, ry0, rx1, ry1] = tr.rect;
      const rw = rx1 - rx0, rh = ry1 - ry0;
      const rs = s.runtime.rasterScale || 1;
      // 显示坐标像素取整:分数坐标会让 clearRect/clip/bg 边缘与 offscreen 里置入层
      // 的边缘像素混色,原图位置残留一圈细外框(用户报障;提交重渲后才消失)
      const sx = Math.round(v.ox + rx0 * v.scale);
      const sy = Math.round(v.oy + ry0 * v.scale);
      const sw = Math.round(v.ox + rx1 * v.scale) - sx;
      const sh = Math.round(v.oy + ry1 * v.scale) - sy;
      dctx.save();
      dctx.beginPath();
      dctx.rect(sx, sy, sw, sh);
      dctx.clip();
      dctx.clearRect(sx, sy, sw, sh);
      const pattern = makeCheckerPattern(dctx, isDark);
      dctx.translate(v.ox, v.oy);
      if (pattern) {
        dctx.fillStyle = pattern;
        dctx.fillRect(0, 0, dw, dh);
      }
      dctx.restore();
      // bg 与 clear 同一取整矩形内绘制(硬边),不与矩形外像素混色
      dctx.drawImage(tr.bg, sx, sy, sw, sh);
      const polys = s.runtime.selectionOutline;
      if (polys && polys.length && s.state?.selectionBounds) {
        dctx.save();
        dctx.translate(v.ox, v.oy);
        dctx.scale(v.scale, v.scale);
        dctx.beginPath();
        dctx.rect(rx0, ry0, rw, rh);
        for (const poly of polys) {
          dctx.moveTo(poly[0], poly[1]);
          for (let i = 2; i < poly.length; i += 2) dctx.lineTo(poly[i], poly[i + 1]);
        }
        dctx.clip('evenodd');
        dctx.imageSmoothingEnabled = v.scale * rs < 1;
        dctx.drawImage(
          s.runtime.offscreen,
          rx0 * rs, ry0 * rs, rw * rs, rh * rs,
          rx0, ry0, rw, rh,
        );
        dctx.restore();
      }
    }

    // overlay:文档外框
    octx.strokeStyle = isDark ? '#ffffff66' : '#00000055';
    octx.lineWidth = 1;
    octx.strokeRect(v.ox - 0.5, v.oy - 0.5, dw + 1, dh + 1);

    // overlay:移动工具悬停高亮(上游 move_hover::draw):点击会拾取的层/组可见内容边界,
    // accent 色 1.5px 外描;无边界=无(Background/空白)。变换会话期间不画(ref 里可能是
    // place→beginTransform 异步窗口期取到的旧 bounds,用户报"原图位置残留蓝框")。
    if (s.tool === 'move' && moveHoverRef.current?.bounds && !moveDragRef.current && !tr.session) {
      const [bx0, by0, bx1, by1] = moveHoverRef.current.bounds;
      octx.strokeStyle = isDark ? '#38bdf8' : '#0284c7';
      octx.lineWidth = 1.5;
      octx.strokeRect(v.ox + bx0 * v.scale - 0.75, v.oy + by0 * v.scale - 0.75, (bx1 - bx0) * v.scale + 1.5, (by1 - by0) * v.scale + 1.5);
    }

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
    // Select and Mask 对话框:非蚂蚁线视图隐藏蚂蚁线;蚂蚁线视图描预览的精修选区轮廓
    // 自由变换激活:蚂蚁线随 quad 变换(上游 draw_selection 经 h 画),原位轮廓隐藏
    const smOpen = s.selectMask?.open === true && !s.selectMask.hideView;
    const smAnts = smOpen && s.selectMask?.viewMode === 'marchingAnts';
    // 变换选区/蒙版目标会话 bg=null(像素不动),靠 selection/targetMask 标志也保持 active
    const transformActive = tr.session != null && tr.rect != null && (tr.bg != null || tr.session.selection === true || tr.session.targetMask === true);
    const hideAnts =
      (s.tool === 'polygonLasso' && polygonRef.current?.mode === 'replace') ||
      (s.tool === 'magneticLasso' && magneticRef.current?.mode === 'replace') ||
      (smOpen && !smAnts) ||
      transformActive;
    if (sel && !hideAnts) {
      if (!smAnts) refreshSelectionOutline(tabId); // 内部按 revision:bounds:step 防抖,选区没变不发请求
      const polys = smAnts ? s.selectMask?.outline ?? null : s.runtime.selectionOutline;
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

    // overlay:自由变换(上游 draw_overlay):抽层背景已上屏(display canvas);这里画
    // 经 H 随动的蚂蚁线、quad 预览贴图(仿射单次 drawImage/透视 mesh 三角)、框+把手+参考点+读数。
    // overlay:Warp 模式(上游 draw_warp_content + draw_warp_overlay):弯贴图(自适应采样三角形,
    // 位移降序防折叠梳状)+ 弯曲网格线 + 控制点 + 随弯蚂蚁线 + 分割导引。框模式的 quad/把手/pivot
    // 不画(上游 draw_overlay 在 warp 分支直接 return);贴图 clip 到文档画布(像素不出画布)。
    if (transformActive && tr.session && tr.tex && tr.rect && tr.session.warp) {
      const warp = tr.session.warp;
      const m = warpToMesh(warp, 1, 1);
      const accent = isDark ? '#38bdf8' : '#0284c7';
      const scr = (p: WPt): [number, number] => [p[0] * v.scale + v.ox, p[1] * v.scale + v.oy];
      // 蚂蚁线随弯(上游 draw_selection warp 分支:直线段按 ~8/zoom px 分段逐点 warp)
      const transformedAnts = s.runtime.selectionOutline;
      if (transformedAnts && transformedAnts.length && sel) {
        const segLen = 8 / Math.max(1e-3, v.scale);
        drawAnts((c) => {
          for (const poly of transformedAnts) {
            let started = false;
            for (let i = 0; i + 3 < poly.length; i += 2) {
              const [ax, ay] = [poly[i], poly[i + 1]];
              const [bx, by] = [poly[i + 2], poly[i + 3]];
              const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / segLen));
              for (let k = started ? 1 : 0; k <= n; k++) {
                const [wx, wy] = warpMap(warp, ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n);
                const [sx, sy] = scr([wx, wy]);
                if (!started) { c.moveTo(sx, sy); started = true; } else c.lineTo(sx, sy);
              }
            }
          }
        });
      }
      // 预览贴图:自适应采样 + 三角仿射分片;拖拽/导引中低密度(帧预算),静止 250ms 后高密度
      const [rx0, ry0, rx1, ry1] = tr.rect;
      const tSessionW = tr.session;
      const fw = tSessionW.rect[2] - tSessionW.rect[0];
      const fh = tSessionW.rect[3] - tSessionW.rect[1];
      const maxAxis = tr.warpDrag || tr.warpSplit?.placing ? 28 : 96;
      const [us, vs] = previewSamples(m, v.scale, maxAxis);
      const row = us.length;
      const posDoc: WPt[] = [];
      const restDoc: WPt[] = [];
      for (const vv of vs) {
        for (const uu of us) {
          const sxp = tSessionW.rect[0] + uu * fw;
          const syp = tSessionW.rect[1] + vv * fh;
          posDoc.push(warpMap(warp, sxp, syp));
          restDoc.push([sxp, syp]);
        }
      }
      const affineFromTri = (s0: WPt, s1: WPt, s2: WPt, p0: [number, number], p1: [number, number], p2: [number, number]): [number, number, number, number, number, number] | null => {
        const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s1[1] - s0[1]) * (s2[0] - s0[0]);
        if (Math.abs(det) < 1e-9) return null;
        const a = ((p1[0] - p0[0]) * (s2[1] - s0[1]) - (p2[0] - p0[0]) * (s1[1] - s0[1])) / det;
        const c = ((p2[0] - p0[0]) * (s1[0] - s0[0]) - (p1[0] - p0[0]) * (s2[0] - s0[0])) / det;
        const b = ((p1[1] - p0[1]) * (s2[1] - s0[1]) - (p2[1] - p0[1]) * (s1[1] - s0[1])) / det;
        const d = ((p2[1] - p0[1]) * (s1[0] - s0[0]) - (p1[1] - p0[1]) * (s2[0] - s0[0])) / det;
        return [a, b, c, d, p0[0] - a * s0[0] - c * s0[1], p0[1] - b * s0[0] - d * s0[1]];
      };
      const srcAt = (i: number): WPt => {
        const uu = us[i % row], vv = vs[(i / row) | 0];
        // 源 tex 像素 = warp 前文档点 - tex 覆盖 rect 原点(frame 超出 rect 的部分为负,
        // drawImage 裁掉);tex 降采样时除 texScale
        const ts = tr.texScale || 1;
        return [(tSessionW.rect[0] + uu * fw - rx0) / ts, (tSessionW.rect[1] + vv * fh - ry0) / ts];
      };
      octx.save();
      octx.beginPath();
      octx.rect(v.ox, v.oy, docW * v.scale, docH * v.scale);
      octx.clip();
      const idxs = triangleOrder(posDoc, restDoc, row);
      for (let k = 0; k + 2 < idxs.length; k += 3) {
        const [i0, i1, i2] = [idxs[k], idxs[k + 1], idxs[k + 2]];
        const p0 = scr(posDoc[i0]), p1 = scr(posDoc[i1]), p2 = scr(posDoc[i2]);
        const s0 = srcAt(i0), s1 = srcAt(i1), s2 = srcAt(i2);
        const mm = affineFromTri(s0, s1, s2, p0, p1, p2);
        if (!mm) continue;
        octx.save();
        octx.beginPath();
        octx.moveTo(p0[0], p0[1]);
        octx.lineTo(p1[0], p1[1]);
        octx.lineTo(p2[0], p2[1]);
        octx.closePath();
        octx.clip();
        octx.transform(mm[0], mm[1], mm[2], mm[3], mm[4], mm[5]);
        octx.drawImage(tr.tex!, 0, 0);
        octx.restore();
      }
      octx.restore();
      // 网格线:patch 边界 accent 1px(40 段曲线);单面片加三分导引(0.75px 淡线)
      const curve = (fu: number | null, fv: number | null): Array<[number, number]> => {
        const out: Array<[number, number]> = [];
        for (let k = 0; k <= 40; k++) {
          const s2 = k / 40;
          out.push(scr(meshEval(m, fu ?? s2, fv ?? s2)));
        }
        return out;
      };
      const strokeCurve = (pts: Array<[number, number]>, w: number, style: string) => {
        if (pts.length < 2) return;
        octx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
        octx.lineWidth = w;
        octx.strokeStyle = style;
        octx.stroke();
      };
      const thin = isDark ? 'rgba(56,189,248,0.55)' : 'rgba(2,132,199,0.55)';
      for (const k of m.us) strokeCurve(curve(k, null), 1, accent);
      for (const k of m.vs) strokeCurve(curve(null, k), 1, accent);
      if (m.us.length === 2 && m.vs.length === 2) {
        for (const third of [1 / 3, 2 / 3]) {
          strokeCurve(curve(third, null), 0.75, thin);
          strokeCurve(curve(null, third), 0.75, thin);
        }
      }
      // 控制点(custom):锚=5px 白方块恒显;柄=2.75px 白圆,指针距柄/其锚 ≤56 屏幕px 或正在拖才显
      if (warp.style === 'custom') {
        const nx = meshNx(m), ny = meshNy(m);
        const pd = s.runtime.pointerDoc;
        const hoverScr = pd ? [pd.x * v.scale + v.ox, pd.y * v.scale + v.oy] : null;
        const dragged = tr.warpDrag?.kind === 'point'
          ? (() => { const nx2 = meshNx(m); return handleAnchor(tr.warpDrag!.index % nx2, (tr.warpDrag!.index / nx2) | 0); })()
          : null;
        const near = (p: [number, number]) => hoverScr != null && Math.hypot(hoverScr[0] - p[0], hoverScr[1] - p[1]) <= 56;
        const faint = isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.35)';
        for (let j = 0; j < ny; j++) {
          for (let i = 0; i < nx; i++) {
            if (i % 3 !== 0 && j % 3 !== 0) continue;
            const p = scr(meshPoint(m, i, j));
            if (i % 3 === 0 && j % 3 === 0) {
              octx.fillStyle = '#ffffff';
              octx.fillRect(p[0] - 2.5, p[1] - 2.5, 5, 5);
              octx.lineWidth = 0.75;
              octx.strokeStyle = faint;
              octx.strokeRect(p[0] - 2.5, p[1] - 2.5, 5, 5);
              continue;
            }
            const [ai, aj] = handleAnchor(i, j);
            const a = scr(meshPoint(m, ai, aj));
            if (!(near(p) || near(a) || (dragged != null && dragged[0] === ai && dragged[1] === aj))) continue;
            octx.beginPath();
            octx.moveTo(a[0], a[1]);
            octx.lineTo(p[0], p[1]);
            octx.lineWidth = 0.75;
            octx.strokeStyle = faint;
            octx.stroke();
            octx.beginPath();
            octx.arc(p[0], p[1], 2.75, 0, Math.PI * 2);
            octx.fillStyle = '#ffffff';
            octx.fill();
            octx.lineWidth = 0.75;
            octx.strokeStyle = faint;
            octx.stroke();
          }
        }
      }
      // 分割导引线(武装跟随指针;quick 抬起才定 kind,拖动中按当前指针实时判定)
      const guide = tr.warpSplit?.placing && tr.warpSplit.pointer ? tr.warpSplit : null;
      if (guide?.pointer) {
        const [gs, gt] = meshParamAt(m, guide.pointer);
        const kind = guide.quick ? quickSplitKind(m, warp.bounds, gs, gt) : guide.tool;
        if (kind === 'vertical' || kind === 'cross') {
          strokeCurve(curve(gs, null), 3, '#000000');
          strokeCurve(curve(gs, null), 1.25, '#ffffff');
        }
        if (kind === 'horizontal' || kind === 'cross') {
          strokeCurve(curve(null, gt), 3, '#000000');
          strokeCurve(curve(null, gt), 1.25, '#ffffff');
        }
      }
    }

    if (transformActive && tr.session && tr.tex && tr.rect && !tr.session.warp) {
      const hDoc = Homography.rectToQuad(tr.session.rect, tr.session.quad);
      const toScreen = (x: number, y: number): [number, number] => {
        const [dx, dy] = hDoc ? hDoc.apply(x, y) : [x, y];
        return [dx * v.scale + v.ox, dy * v.scale + v.oy];
      };
      // 蚂蚁线随动:原选区轮廓经 quad 映射(像素层带选区;蒙版目标第一刀不进变换)
      const transformedAnts = s.runtime.selectionOutline;
      if (transformedAnts && transformedAnts.length && sel) {
        drawAnts((c) => {
          c.beginPath();
          for (const poly of transformedAnts) {
            const [sx, sy] = toScreen(poly[0], poly[1]);
            c.moveTo(sx, sy);
            for (let i = 2; i < poly.length; i += 2) {
              const [px, py] = toScreen(poly[i], poly[i + 1]);
              c.lineTo(px, py);
            }
          }
        });
      }
      // 预览贴图:仿射=单次 drawImage;透视=mesh 三角形仿射分片(源=tex,越界裁掉)
      const tex = tr.tex;
      const [rx0, ry0, rx1, ry1] = tr.rect;
      const rw = rx1 - rx0, rh = ry1 - ry0;
      if (hDoc && quadIsAffine(tr.session.rect, tr.session.quad)) {
        octx.save();
        // 蒙版染色半透明叠加(上游 lone target 纹理 opacity 0.6)
        if (tr.session.targetMask) octx.globalAlpha = 0.6;
        octx.translate(v.ox, v.oy);
        octx.scale(v.scale, v.scale);
        octx.transform(hDoc.m[0], hDoc.m[3], hDoc.m[1], hDoc.m[4], hDoc.m[2], hDoc.m[5]);
        octx.drawImage(tex, rx0, ry0, rw, rh);
        octx.restore();
      } else if (hDoc) {
        // 蒙版染色半透明叠加(上游 lone target 纹理 opacity 0.6;透视 mesh 三角分支)
        if (tr.session.targetMask) octx.globalAlpha = 0.6;
        const n = 12;
        const fw = tr.session.rect[2] - tr.session.rect[0];
        const fh = tr.session.rect[3] - tr.session.rect[1];
        const srcPt = (u: number, vv: number): [number, number] => {
          // 源 tex 像素 = 文档点 - rect 原点(frame 超出 rect 的部分为负,drawImage 裁掉);
          // tex 降采样时除 texScale(变换选区的蒙版染色纹理)
          const ts = tr.texScale || 1;
          const dx = (tr.session!.rect[0] + u * fw - rx0) / ts;
          const dy = (tr.session!.rect[1] + vv * fh - ry0) / ts;
          return [dx, dy];
        };
        const affineFromTri = (s0: [number, number], s1: [number, number], s2: [number, number], p0: [number, number], p1: [number, number], p2: [number, number]): [number, number, number, number, number, number] | null => {
          const det = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s1[1] - s0[1]) * (s2[0] - s0[0]);
          if (Math.abs(det) < 1e-9) return null;
          const a = ((p1[0] - p0[0]) * (s2[1] - s0[1]) - (p2[0] - p0[0]) * (s1[1] - s0[1])) / det;
          const c = ((p2[0] - p0[0]) * (s1[0] - s0[0]) - (p1[0] - p0[0]) * (s2[0] - s0[0])) / det;
          const b = ((p1[1] - p0[1]) * (s2[1] - s0[1]) - (p2[1] - p0[1]) * (s1[1] - s0[1])) / det;
          const d = ((p2[1] - p0[1]) * (s1[0] - s0[0]) - (p1[1] - p0[1]) * (s2[0] - s0[0])) / det;
          return [a, b, c, d, p0[0] - a * s0[0] - c * s0[1], p0[1] - b * s0[0] - d * s0[1]];
        };
        for (let gy = 0; gy < n; gy++) {
          for (let gx = 0; gx < n; gx++) {
            const u0 = gx / n, u1 = (gx + 1) / n;
            const v0 = gy / n, v1 = (gy + 1) / n;
            const docPts: Array<[number, number]> = [
              [tr.session.rect[0] + u0 * fw, tr.session.rect[1] + v0 * fh],
              [tr.session.rect[0] + u1 * fw, tr.session.rect[1] + v0 * fh],
              [tr.session.rect[0] + u1 * fw, tr.session.rect[1] + v1 * fh],
              [tr.session.rect[0] + u0 * fw, tr.session.rect[1] + v1 * fh],
            ];
            const scr = docPts.map((p) => toScreen(p[0], p[1]));
            const srcs = [srcPt(u0, v0), srcPt(u1, v0), srcPt(u1, v1), srcPt(u0, v1)];
            for (const tri of [[0, 1, 2], [0, 2, 3]] as const) {
              const s0 = srcs[tri[0]], s1 = srcs[tri[1]], s2 = srcs[tri[2]];
              const p0 = scr[tri[0]], p1 = scr[tri[1]], p2 = scr[tri[2]];
              const m = affineFromTri(s0, s1, s2, p0, p1, p2);
              if (!m) continue;
              octx.save();
              octx.beginPath();
              octx.moveTo(p0[0], p0[1]);
              octx.lineTo(p1[0], p1[1]);
              octx.lineTo(p2[0], p2[1]);
              octx.closePath();
              octx.clip();
              octx.transform(m[0], m[1], m[2], m[3], m[4], m[5]);
              octx.drawImage(tex, 0, 0);
              octx.restore();
            }
          }
          octx.globalAlpha = 1;
        }
      }
      // 框线 + 把手(上游 draw_overlay:accent 1px 闭合折线 + 7×7 白芯方块;参考点=白圆+十字)
      const accent = isDark ? '#38bdf8' : '#0284c7';
      const scrQuad = tr.session.quad.map((q) => [q[0] * v.scale + v.ox, q[1] * v.scale + v.oy] as [number, number]);
      octx.save();
      octx.lineWidth = 1;
      octx.strokeStyle = accent;
      octx.beginPath();
      scrQuad.forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
      octx.closePath();
      octx.stroke();
      const hs = 7;
      for (const [x, y] of scrQuad) {
        octx.fillStyle = '#ffffff';
        octx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        octx.strokeRect(x - hs / 2 + 0.5, y - hs / 2 + 0.5, hs - 1, hs - 1);
      }
      for (let i = 0; i < 4; i++) {
        const [a, b] = [scrQuad[i], scrQuad[(i + 1) % 4]];
        const [x, y] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        octx.fillStyle = '#ffffff';
        octx.fillRect(x - hs / 2, y - hs / 2, hs, hs);
        octx.strokeRect(x - hs / 2 + 0.5, y - hs / 2 + 0.5, hs - 1, hs - 1);
      }
      const pxs = tr.session.pivot[0] * v.scale + v.ox;
      const pys = tr.session.pivot[1] * v.scale + v.oy;
      octx.beginPath();
      octx.arc(pxs, pys, 5, 0, Math.PI * 2);
      octx.fillStyle = '#ffffff';
      octx.fill();
      octx.strokeStyle = isDark ? '#000000cc' : '#00000080';
      octx.stroke();
      octx.beginPath();
      octx.moveTo(pxs - 8, pys); octx.lineTo(pxs + 8, pys);
      octx.moveTo(pxs, pys - 8); octx.lineTo(pxs, pys + 8);
      octx.strokeStyle = isDark ? '#000000aa' : '#00000066';
      octx.stroke();
      octx.restore();
      // 拖拽中实时读数(指针旁小黑条:旋转=角度、缩放=W/H%、平移=ΔX,ΔY;照裁剪 readout 先例)
      const pd = s.runtime.pointerDoc;
      if (tr.readout && pd) {
        const sx = pd.x * v.scale + v.ox;
        const sy = pd.y * v.scale + v.oy;
        octx.save();
        octx.font = '11px ui-monospace, monospace';
        const tw = octx.measureText(tr.readout).width;
        octx.fillStyle = 'rgba(20,20,20,0.85)';
        octx.fillRect(sx + 14, sy - 10, tw + 10, 18);
        octx.fillStyle = '#ffffff';
        octx.fillText(tr.readout, sx + 19, sy + 3);
        octx.restore();
      }
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

    // overlay:形状族拖拽预览(上游 draw_shape_preview:按最终几何画真填充+描边,再叠
    // accent 轮廓对比线;修饰键=实时状态。描边宽随 zoom 缩放,align=中心为近似——
    // 提交后由引擎 cache 出真渲染)。
    if (shapeDragRef.current && s.state) {
      const sd = shapeDragRef.current;
      const geom = shapeGeometry(s.options, sd.tool, [sd.sx, sd.sy], [sd.ex, sd.ey], shiftRef.current, altRef.current);
      if (geom) {
        const toScr = (x: number, y: number): [number, number] => [x * v.scale + v.ox, y * v.scale + v.oy];
        const path = new Path2D();
        if (geom.kind === 'line' && geom.from && geom.to) {
          const [ax, ay] = toScr(geom.from[0], geom.from[1]);
          const [bx, by] = toScr(geom.to[0], geom.to[1]);
          path.moveTo(ax, ay);
          path.lineTo(bx, by);
        } else if (geom.rect) {
          const [x, y, w, h] = geom.rect;
          const [sx, sy] = toScr(x, y);
          const sw = w * v.scale;
          const sh = h * v.scale;
          if (geom.kind === 'ellipse') {
            path.ellipse(sx + sw / 2, sy + sh / 2, sw / 2, sh / 2, 0, 0, Math.PI * 2);
          } else if (geom.kind === 'roundedRect' && geom.radii) {
            // 圆角矩形(TS DOM 未含 roundRect 的兼容环境手动构路径)
            const r = Math.min(geom.radii[0] * v.scale, sw / 2, sh / 2);
            path.moveTo(sx + r, sy);
            path.lineTo(sx + sw - r, sy);
            path.arcTo(sx + sw, sy, sx + sw, sy + r, r);
            path.lineTo(sx + sw, sy + sh - r);
            path.arcTo(sx + sw, sy + sh, sx + sw - r, sy + sh, r);
            path.lineTo(sx + r, sy + sh);
            path.arcTo(sx, sy + sh, sx, sy + sh - r, r);
            path.lineTo(sx, sy + r);
            path.arcTo(sx, sy, sx + r, sy, r);
            path.closePath();
          } else if (geom.kind === 'polygon' && geom.sides) {
            // 内接正多边形(顶点均分,起始角朝上)
            const n = geom.sides;
            const cx = sx + sw / 2;
            const cy = sy + sh / 2;
            for (let i = 0; i < n; i++) {
              const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
              const px = cx + (sw / 2) * Math.cos(a);
              const py = cy + (sh / 2) * Math.sin(a);
              if (i === 0) path.moveTo(px, py);
              else path.lineTo(px, py);
            }
            path.closePath();
          } else {
            path.rect(sx, sy, sw, sh);
          }
        }
        const { fill, stroke } = shapeFillStroke(s.options, s.state.foreground, s.state.background);
        octx.save();
        if (geom.kind !== 'line' && fill) {
          octx.fillStyle = fill;
          octx.fill(path);
        }
        if (stroke && typeof stroke.width === 'number') {
          octx.strokeStyle = typeof stroke.color === 'string' ? stroke.color : '#000000';
          octx.lineWidth = Math.max(1, stroke.width * v.scale);
          octx.lineJoin = 'miter';
          octx.stroke(path);
        }
        // accent 轮廓对比线(黑晕垫底,任意像素上可见;上游 contrast_path 口径)
        octx.beginPath();
        octx.strokeStyle = 'rgba(0,0,0,0.55)';
        octx.lineWidth = 3;
        octx.stroke(path);
        octx.strokeStyle = isDark ? '#38bdf8' : '#0284c7';
        octx.lineWidth = 1;
        octx.stroke(path);
        octx.restore();
      }
    }

    // overlay:已提交工作路径常驻轮廓(上游 draw_overlay paths 段+shows_anchors:钢笔族
    // 工具下 work path 显示 1px accent 轮廓+锚点方块,闭合子路径回绕首锚;路径本身无像素,
    // 此轮廓即 PS 闭合后画布上能看到的东西。路径选择工具同样编辑工作路径,同款显示。
    // 矢量蒙版被定向时优先显示蒙版路径——钢笔追加/路径选择拖移都作用在它上)
    const overlayPath = s.vectorMaskPath && PATH_TOOLS.has(s.tool)
      ? s.vectorMaskPath
      : (s.tool === 'pen' || s.tool === 'pathSelect') && s.workPath && s.state
        ? s.workPath
        : null;
    if (overlayPath && s.state) {
      const toScr = (q: [number, number]): [number, number] => [q[0] * v.scale + v.ox, q[1] * v.scale + v.oy];
      const accent = isDark ? '#38bdf8' : '#0284c7';
      octx.save();
      octx.lineJoin = 'round';
      octx.lineCap = 'round';
      for (const { pts, closed } of pathLines(overlayPath, toScr)) {
        if (pts.length < 2) continue;
        octx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
        if (closed) octx.closePath();
        octx.strokeStyle = accent;
        octx.lineWidth = 1;
        octx.stroke();
      }
      for (const sub of overlayPath.subpaths) {
        for (const k of sub.knots) {
          const [cx, cy] = toScr(k.anchor);
          octx.beginPath();
          octx.rect(cx - 3, cy - 3, 6, 6);
          octx.fillStyle = '#ffffff';
          octx.fill();
          octx.strokeStyle = accent;
          octx.lineWidth = 1;
          octx.stroke();
        }
      }
      octx.restore();
    }

    // overlay:直接选择族(上游 direct_select::draw_overlay):轮廓(编辑拖拽中=预览替换)+
    // 显示手柄(选中锚双手柄+点中段出入口,收回的不显)+锚点(选中 accent 实心)+框选蚂蚁线
    // +加/删锚悬停高亮(段 2.5px+预览锚 / 11px 框)。
    if (DS_TOOLS.has(s.tool) && s.state) {
      const toScr = (q: [number, number]): [number, number] => [q[0] * v.scale + v.ox, q[1] * v.scale + v.oy];
      const accent = isDark ? '#38bdf8' : '#0284c7';
      const dg = dsDragRef.current;
      const shown = dg?.kind === 'edit' && dg.preview ? dg.preview : s.workPath;
      if (shown) {
        octx.save();
        octx.lineJoin = 'round';
        octx.lineCap = 'round';
        for (const { pts, closed } of pathLines(shown, toScr)) {
          if (pts.length < 2) continue;
          octx.beginPath();
          pts.forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
          if (closed) octx.closePath();
          octx.strokeStyle = accent;
          octx.lineWidth = 1;
          octx.stroke();
        }
        if (s.directSel.target === 'work') {
          for (const { knot: r, handle: h } of peShownHandles(s.directSel, shown)) {
            const kn = shown.subpaths[r[0]]?.knots[r[1]];
            if (!kn) continue;
            const c: Pt = h === 'in' ? kn.in : kn.out;
            const [ax, ay] = toScr(kn.anchor);
            const [hx, hy] = toScr(c);
            octx.beginPath();
            octx.moveTo(ax, ay);
            octx.lineTo(hx, hy);
            octx.strokeStyle = accent;
            octx.lineWidth = 1;
            octx.stroke();
            octx.beginPath();
            octx.arc(hx, hy, 3, 0, Math.PI * 2);
            octx.fillStyle = accent;
            octx.fill();
          }
        }
        shown.subpaths.forEach((sp, si) => {
          sp.knots.forEach((kn, ki) => {
            const [cx, cy] = toScr(kn.anchor);
            const selected = s.directSel.target === 'work' && s.directSel.anchors.some((a) => a[0] === si && a[1] === ki);
            octx.beginPath();
            octx.rect(cx - 3, cy - 3, 6, 6);
            octx.fillStyle = selected ? accent : '#ffffff';
            octx.fill();
            octx.strokeStyle = accent;
            octx.lineWidth = 1;
            octx.stroke();
          });
        });
        // 悬停高亮(上游 anchor_tools::draw_hover:加=段高亮+预览锚,删=11px 框)
        const hov = s.runtime.pointerDoc;
        if (hov && !dg) {
          const tol = 6.0 / Math.max(v.scale, 1e-3);
          const effective: 'addAnchor' | 'deleteAnchor' | null = s.tool === 'addAnchor' ? (altRef.current ? 'deleteAnchor' : 'addAnchor') : s.tool === 'deleteAnchor' ? (altRef.current ? 'addAnchor' : 'deleteAnchor') : null;
          if (effective) {
            const hit = peHit(shown, [hov.x, hov.y], tol, []);
            const ok = hit && (effective === 'addAnchor' ? hit.kind === 'segment' : hit.kind === 'anchor');
            if (ok && hit.kind === 'segment') {
              const seg = (si => { const sp = shown.subpaths[si[0]]; if (!sp) return null; const n = sp.knots.length; const j = si[1] + 1 < n ? si[1] + 1 : sp.closed && n > 1 ? 0 : null; return j == null ? null : [sp.knots[si[1]].anchor, sp.knots[si[1]].out, sp.knots[j].in, sp.knots[j].anchor] as [Pt, Pt, Pt, Pt]; })(hit.knot);
              if (seg) {
                octx.beginPath();
                for (let i = 0; i <= 48; i++) {
                  const q = toScr(peEval(seg, i / 48));
                  if (i === 0) octx.moveTo(q[0], q[1]);
                  else octx.lineTo(q[0], q[1]);
                }
                octx.strokeStyle = accent;
                octx.lineWidth = 2.5;
                octx.stroke();
                const q = toScr(peEval(seg, hit.t));
                octx.beginPath();
                octx.rect(q[0] - 3, q[1] - 3, 6, 6);
                octx.fillStyle = '#ffffff';
                octx.fill();
                octx.strokeStyle = accent;
                octx.lineWidth = 1;
                octx.stroke();
              }
            } else if (ok && hit.kind === 'anchor') {
              const kn = shown.subpaths[hit.knot[0]]?.knots[hit.knot[1]];
              if (kn) {
                const [cx, cy] = toScr(kn.anchor);
                octx.beginPath();
                octx.rect(cx - 5.5, cy - 5.5, 11, 11);
                octx.strokeStyle = accent;
                octx.lineWidth = 1.5;
                octx.stroke();
                octx.beginPath();
                octx.rect(cx - 3, cy - 3, 6, 6);
                octx.fillStyle = accent;
                octx.fill();
              }
            }
          }
        }
        octx.restore();
      }
      // 框选蚂蚁线
      if (dg?.kind === 'marquee') {
        const pts = [dg.start, [dg.end[0], dg.start[1]] as Pt, dg.end, [dg.start[0], dg.end[1]] as Pt].map(toScr);
        octx.save();
        octx.setLineDash([4, 3]);
        octx.strokeStyle = isDark ? '#e5e5e5' : '#111111';
        octx.lineWidth = 1;
        octx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
        octx.closePath();
        octx.stroke();
        octx.setLineDash([]);
        octx.strokeStyle = 'rgba(0,0,0,0.5)';
        octx.beginPath();
        pts.forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
        octx.closePath();
        octx.stroke();
        octx.restore();
      }
    }

    // overlay:钢笔草稿(上游 vector_ui draw_overlay):曲线=curve_points 自适应弦
    // (黑晕垫底+1.5 accent);橡皮带虚线 4/3(非拖拽且指针在画布;终点=⇧ 时 45° 投影);
    // 末锚双手柄(仅 out 已拉出);锚点 6px 方块(末锚 accent 实心,余白底 accent 描边);
    // 悬停首锚=闭合提示(8px 实心+右下 11,11 处 3.5px 圆环,#4596)。
    if (s.tool === 'pen' && penRef.current && s.state) {
      const pen = penRef.current;
      const toScr = (q: [number, number]): [number, number] => [q[0] * v.scale + v.ox, q[1] * v.scale + v.oy];
      const accent = isDark ? '#38bdf8' : '#0284c7';
      const knots = pen.knots.map((k) => ({ anchor: [...k.anchor] as [number, number], in: [...k.in] as [number, number], out: [...k.out] as [number, number] }));
      if (penClosing(pen)) {
        // 闭合拖拽:首段随手柄弯曲(替身 out 临时接到首锚)
        const lastK = knots[knots.length - 1];
        const firstK = knots[0];
        if (lastK && firstK && (lastK.out[0] !== lastK.anchor[0] || lastK.out[1] !== lastK.anchor[1])) firstK.out = [...lastK.out];
      }
      octx.save();
      octx.lineJoin = 'round';
      octx.lineCap = 'round';
      if (knots.length >= 2) {
        const pts: [number, number][] = [];
        for (let i = 0; i + 1 < knots.length; i++) {
          pts.push(...curvePoints(knots[i].anchor, knots[i].out, knots[i + 1].in, knots[i + 1].anchor, toScr));
        }
        for (const [w, col] of [[3, 'rgba(0,0,0,0.55)'], [1.5, accent]] as const) {
          octx.beginPath();
          pts.forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
          octx.strokeStyle = col;
          octx.lineWidth = w;
          octx.stroke();
        }
      }
      const hov = s.runtime.pointerDoc;
      const lastKnot = pen.knots[pen.knots.length - 1];
      if (!pen.dragging && hov && lastKnot) {
        // 橡皮带:终点=⇧ 单击会落锚的位置
        const h = penShift45(lastKnot.anchor, [hov.x, hov.y], shiftRef.current);
        const [ax, ay] = toScr(lastKnot.anchor);
        const [bx, by] = toScr(h);
        octx.setLineDash([4, 3]);
        for (const [w, col] of [[3, 'rgba(0,0,0,0.55)'], [1, accent]] as const) {
          octx.beginPath();
          octx.moveTo(ax, ay);
          octx.lineTo(bx, by);
          octx.strokeStyle = col;
          octx.lineWidth = w;
          octx.stroke();
        }
        octx.setLineDash([]);
      }
      if (lastKnot && (lastKnot.out[0] !== lastKnot.anchor[0] || lastKnot.out[1] !== lastKnot.anchor[1])) {
        // 末锚双手柄:1px 线+3px 圆(上游 draw_handle)
        const [ax, ay] = toScr(lastKnot.anchor);
        for (const hnd of [lastKnot.in, lastKnot.out]) {
          const [hx, hy] = toScr(hnd);
          octx.beginPath();
          octx.moveTo(ax, ay);
          octx.lineTo(hx, hy);
          octx.strokeStyle = accent;
          octx.lineWidth = 1;
          octx.stroke();
          octx.beginPath();
          octx.arc(hx, hy, 3, 0, Math.PI * 2);
          octx.fillStyle = accent;
          octx.fill();
        }
      }
      pen.knots.forEach((k, i) => {
        // 锚点 6px 方块(上游 draw_anchor:末锚 accent 实心,余白底 1px accent 描边)
        const [cx, cy] = toScr(k.anchor);
        octx.beginPath();
        octx.rect(cx - 3, cy - 3, 6, 6);
        octx.fillStyle = i + 1 === pen.knots.length ? accent : '#ffffff';
        octx.fill();
        octx.strokeStyle = accent;
        octx.lineWidth = 1;
        octx.stroke();
      });
      if (hov && overFirstAnchor(pen, [hov.x, hov.y], 6.0 / Math.max(v.scale, 1e-3)) && pen.knots[0]) {
        const [cx, cy] = toScr(pen.knots[0].anchor);
        octx.fillStyle = accent;
        octx.fillRect(cx - 4, cy - 4, 8, 8);
        octx.beginPath();
        octx.arc(cx + 11, cy + 11, 3.5, 0, Math.PI * 2);
        octx.strokeStyle = accent;
        octx.lineWidth = 1.5;
        octx.stroke();
      }
      octx.restore();
    }

    // overlay:Live 渐变 widget(上游 gradient_ui::draw_overlay):非经典模式下恒显示——
    // 方向线 3px 黑(α90)+1.5px 白;径向/角度=圆、菱形=转置方、反射=虚线镜像;端点 8px
    // 圆环、色标 5px 实心点(反向折算位置)、中点 4.5px 菱形;被拖件 accent 高亮。
    // 拖拽中画手势本地态(指针跟手,不等引擎回包);蒙版目标下选中渐变图层仍显示(上游
    // live_mode:mask 目标 + active_gradient = Live)。
    if (s.tool === 'gradient' && !s.options.gradientClassic) {
      const lg = liveGradRef.current;
      const selFill0 = liveFillRef.current && liveFillRef.current.layer === s.state?.activeLayer ? liveFillRef.current : null;
      // hold(抬笔后的保持态)优先于过期的 liveFillRef:refetch 落地前 overlay 画本地终态
      const selFill = lg?.kind === 'hold' ? lg.fill : selFill0;
      if (!isMaskTarget(s.state) || selFill) {
        // 几何:静止=选中图层;拖拽=手势本地态。stops/mids 用快照 + 被拖件本地值覆盖,
        // 跨位重排只影响排序下标、不影响各点在画布上的位置
        let from: [number, number] | null = null;
        let to: [number, number] = [0, 0];
        let reverse = false;
        let stops: Array<[number, string]> = [];
        let ownedMids: number[] = [];
        let style: string = selFill?.style ?? s.options.gradientStyle;
        let grabbed: string | null = null;
        let skipStop = -1;
        if (lg?.kind === 'draw') {
          from = lg.from;
          to = lg.mods.liveShift ? snap45(lg.from, lg.to) : lg.to;
          // 重画=沿用图层自身反向;新线=选项条反向(将随 create 一起提交)
          reverse = lg.redraw != null ? selFill?.reverse ?? false : s.options.gradientReverse;
          stops = lg.redraw != null ? selFill?.stops ?? [] : [];
          ownedMids = lg.redraw != null ? selFill?.midpoints ?? [] : [];
          grabbed = 'end';
        } else if (lg?.kind === 'edit') {
          from = lg.from;
          to = lg.to;
          reverse = selFill?.reverse ?? false;
          stops = selFill?.stops ?? [];
          ownedMids = selFill?.midpoints ?? [];
          grabbed = lg.which;
        } else if (lg?.kind === 'stop') {
          from = lg.from;
          to = lg.to;
          reverse = lg.reverse;
          stops = lg.stops.map((q, i) => (i === lg.origIndex ? [lg.t, q[1]] : q));
          ownedMids = lg.mids;
          if (!lg.tornOff) grabbed = `stop:${lg.origIndex}`;
          skipStop = lg.origIndex;
        } else if (lg?.kind === 'mid') {
          from = lg.from;
          to = lg.to;
          reverse = lg.reverse;
          stops = lg.stops;
          ownedMids = lg.mids.map((m, i) => (i === lg.seg ? lg.value : m));
          grabbed = `mid:${lg.seg}`;
        } else if (selFill) {
          from = selFill.from;
          to = selFill.to;
          reverse = selFill.reverse;
          stops = selFill.stops;
          ownedMids = selFill.midpoints;
        }
        if (from) {
          // 每个色标拥有其后段的中点值(引擎 unpair 口径);按位置排序输出各段中点渐变位置
          const entries = stops.map((q, i) => ({ loc: q[0], owned: ownedMids[i] ?? 0.5 }));
          entries.sort((x, y) => x.loc - y.loc);
          const midPos: Array<[number, number, number]> = []; // [渐变位置 t, 段号, 值]
          for (let j = 0; j + 1 < entries.length; j++) {
            const a = entries[j].loc;
            const b = entries[j + 1].loc;
            if (b - a > 1e-4) midPos.push([a + (b - a) * entries[j].owned, j, entries[j].owned]);
          }
          const ax = from[0] * v.scale + v.ox;
          const ay = from[1] * v.scale + v.oy;
          const bx = to[0] * v.scale + v.ox;
          const by = to[1] * v.scale + v.oy;
          const at = (t: number): [number, number] => {
            const q = gradientLiveAt(from!, to, t, reverse);
            return [q[0] * v.scale + v.ox, q[1] * v.scale + v.oy];
          };
          const diamond = (x: number, y: number, r: number, fill: string, stroke: string) => {
            octx.beginPath();
            octx.moveTo(x, y - r);
            octx.lineTo(x + r, y);
            octx.lineTo(x, y + r);
            octx.lineTo(x - r, y);
            octx.closePath();
            octx.fillStyle = fill;
            octx.fill();
            octx.strokeStyle = stroke;
            octx.lineWidth = 1;
            octx.stroke();
          };
          const dual = (path: () => void) => {
            octx.beginPath();
            path();
            octx.strokeStyle = 'rgba(0,0,0,0.35)';
            octx.lineWidth = 3;
            octx.stroke();
            octx.beginPath();
            path();
            octx.strokeStyle = '#ffffff';
            octx.lineWidth = 1.5;
            octx.stroke();
          };
          octx.save();
          octx.lineCap = 'round';
          // 样式几何(上游 draw_overlay):径向/角度=圆,菱形=转置方,反射=虚线镜像
          const r = Math.hypot(bx - ax, by - ay);
          if (style === 'radial' || style === 'angle') {
            dual(() => { octx.arc(ax, ay, r, 0, Math.PI * 2); });
          } else if (style === 'diamond') {
            const dx = bx - ax;
            const dy = by - ay;
            dual(() => {
              octx.moveTo(ax + dx, ay + dy);
              octx.lineTo(ax - dy, ay + dx);
              octx.lineTo(ax - dx, ay - dy);
              octx.lineTo(ax + dy, ay - dx);
              octx.closePath();
            });
          } else if (style === 'reflected') {
            const mx = 2 * ax - bx;
            const my = 2 * ay - by;
            octx.setLineDash([5, 4]);
            octx.beginPath();
            octx.moveTo(ax, ay);
            octx.lineTo(mx, my);
            octx.strokeStyle = '#ffffff';
            octx.lineWidth = 1.5;
            octx.stroke();
            octx.setLineDash([]);
          }
          dual(() => { octx.moveTo(ax, ay); octx.lineTo(bx, by); });
          // 中点菱形(线上的段中点;被拖的 accent 填充)
          for (const [t, seg] of midPos) {
            const [sx, sy] = at(t);
            diamond(sx, sy, 4.5, grabbed === `mid:${seg}` ? '#0284c7' : '#ffffff', 'rgba(0,0,0,0.63)');
          }
          // 端点圆环(上游 8px:3.5px 黑 α90 垫底 + 2px 白/accent)
          for (const [cx, cy, kind] of [[ax, ay, 'start'], [bx, by, 'end']] as Array<[number, number, string]>) {
            octx.beginPath();
            octx.arc(cx, cy, 8, 0, Math.PI * 2);
            octx.strokeStyle = 'rgba(0,0,0,0.35)';
            octx.lineWidth = 3.5;
            octx.stroke();
            octx.beginPath();
            octx.arc(cx, cy, 8, 0, Math.PI * 2);
            octx.strokeStyle = grabbed === kind ? '#0284c7' : '#ffffff';
            octx.lineWidth = 2;
            octx.stroke();
          }
          // 色标点(5px 实心 stop 色 + 1.5px 白/accent 环 + 1px 黑 α110 外环);撕离中隐藏
          stops.forEach(([t, hex], i) => {
            if (i === skipStop && grabbed === null) return;
            const [sx, sy] = at(t);
            octx.beginPath();
            octx.arc(sx, sy, 5, 0, Math.PI * 2);
            octx.fillStyle = hex;
            octx.fill();
            octx.beginPath();
            octx.arc(sx, sy, 5.5, 0, Math.PI * 2);
            octx.strokeStyle = grabbed === `stop:${i}` ? '#0284c7' : '#ffffff';
            octx.lineWidth = 1.5;
            octx.stroke();
            octx.beginPath();
            octx.arc(sx, sy, 6.8, 0, Math.PI * 2);
            octx.strokeStyle = 'rgba(0,0,0,0.43)';
            octx.lineWidth = 1;
            octx.stroke();
          });
          octx.restore();
        }
      }
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
      // 旋转光标:双头弧线,弯向 p 所在象限的框角、随框转(上游 CursorIcon::None +
      // draw_turn_cursor:R=12、±0.75 rad、黑晕 3.5 + 白芯 1.5,箭头贴弧端)
      const rotDrag = cropDragRef.current?.kind === 'rotate';
      if (s.runtime.pointerDoc && (rotDrag || cropDragRef.current === null)) {
        const pd: [number, number] = [s.runtime.pointerDoc.x, s.runtime.pointerDoc.y];
        const outside = rotDrag
          || cropHitTurned(f.rect, f.angle, pd, CROP_HANDLE_PX / v.scale).kind === 'outside';
        const dir = cropTurnCursorDir(f.rect, f.angle, pd, outside);
        if (dir) {
          const ul = Math.hypot(dir[0], dir[1]);
          const ux = dir[0] / ul;
          const uy = dir[1] / ul;
          const px = s.runtime.pointerDoc.x * v.scale + v.ox;
          const py = s.runtime.pointerDoc.y * v.scale + v.oy;
          const R = 12;
          const HALF = 0.75;
          const ccx = px + ux * R;
          const ccy = py + uy * R;
          const mid = Math.atan2(-uy, -ux);
          const at = (a: number): [number, number] => [ccx + Math.cos(a) * R, ccy + Math.sin(a) * R];
          octx.save();
          octx.lineCap = 'round';
          octx.beginPath();
          for (let i = 0; i <= 16; i++) {
            const [ax, ay] = at(mid - HALF + (2 * HALF * i) / 16);
            if (i === 0) octx.moveTo(ax, ay);
            else octx.lineTo(ax, ay);
          }
          octx.strokeStyle = 'rgba(0,0,0,0.8)';
          octx.lineWidth = 3.5;
          octx.stroke();
          octx.strokeStyle = '#ffffff';
          octx.lineWidth = 1.5;
          octx.stroke();
          for (const [a, sign] of [[mid - HALF, -1], [mid + HALF, 1]] as [number, number][]) {
            const [tx0, ty0] = at(a);
            const tan: [number, number] = [-Math.sin(a) * sign, Math.cos(a) * sign];
            const nor: [number, number] = [Math.cos(a), Math.sin(a)];
            const tip: [number, number] = [tx0 + tan[0] * 2, ty0 + tan[1] * 2];
            octx.beginPath();
            octx.moveTo(tip[0] + tan[0] * 3.5, tip[1] + tan[1] * 3.5);
            octx.lineTo(tip[0] - tan[0] * 3 + nor[0] * 3.5, tip[1] - tan[1] * 3 + nor[1] * 3.5);
            octx.lineTo(tip[0] - tan[0] * 3 - nor[0] * 3.5, tip[1] - tan[1] * 3 - nor[1] * 3.5);
            octx.closePath();
            octx.fillStyle = '#ffffff';
            octx.fill();
            octx.strokeStyle = 'rgba(0,0,0,0.8)';
            octx.lineWidth = 1;
            octx.stroke();
          }
          octx.restore();
        }
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

    // overlay:Select and Mask 边刷光标(上游 canvas_brush):圆环=直径/2×zoom(min 1.5 屏幕 px),
    // 黑影垫底+白芯双描;十字臂恒有横臂(add=+),竖臂仅在正向模式(subtract=−,Alt 即时切换)
    if (s.selectMask?.open && s.selectMask.brush && s.runtime.pointerDoc && !s.selectMask.hideView) {
      const subtract = (s.selectMask.brushMode === 'subtract') !== altRef.current;
      const r = Math.max(1.5, (s.selectMask.brushSize / 2) * v.scale);
      const cx = s.runtime.pointerDoc.x * v.scale + v.ox;
      const cy = s.runtime.pointerDoc.y * v.scale + v.oy;
      octx.beginPath();
      octx.arc(cx, cy, r + 0.5, 0, Math.PI * 2);
      octx.strokeStyle = 'rgba(0,0,0,0.55)';
      octx.lineWidth = 1;
      octx.stroke();
      octx.beginPath();
      octx.arc(cx, cy, r, 0, Math.PI * 2);
      octx.strokeStyle = 'rgba(255,255,255,0.86)';
      octx.stroke();
      const arm = 3;
      octx.lineCap = 'butt';
      for (const [w, c] of [[2.5, 'rgba(0,0,0,0.55)'], [1, 'rgba(255,255,255,0.86)']] as const) {
        octx.beginPath();
        octx.moveTo(cx - arm, cy);
        octx.lineTo(cx + arm, cy);
        octx.strokeStyle = c;
        octx.lineWidth = w;
        octx.stroke();
        if (!subtract) {
          octx.beginPath();
          octx.moveTo(cx, cy - arm);
          octx.lineTo(cx, cy + arm);
          octx.strokeStyle = c;
          octx.lineWidth = w;
          octx.stroke();
        }
      }
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

    // overlay:文字编辑会话(二-6,上游 type_tool::draw_overlay):段落框+8 把手/点文本
    // 行下划线;选区亮块(逐行 caret 段拼四边形,竖排=列宽盒近似);caret 白晕黑芯闪烁;
    // IME 组字下划线。caret/边界段由 ensureTypeOverlay 异步补齐,缺段本帧跳过不画。
    const ted = s.textEdit;
    if (ted && s.state) {
      const info = typeInfoRef.current?.info;
      const segs = caretSegRef.current?.segs;
      const scr = (p: [number, number]): [number, number] => docToScreen(v, p[0], p[1]);
      const taccent = isDark ? '#38bdf8' : '#0284c7';
      if (info) {
        const shape = boxOfShape(info.shape);
        // 帧:段落文本=框+把手(角+边中点,上游 7px 白底 accent 描边);点文本=逐行下划线
        if (shape) {
          const corners = [
            [shape[0], shape[1]], [shape[0] + shape[2], shape[1]],
            [shape[0] + shape[2], shape[1] + shape[3]], [shape[0], shape[1] + shape[3]],
          ].map(([x, y]) => scr(affApply(info.transform, x, y)));
          octx.beginPath();
          corners.forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
          octx.closePath();
          octx.strokeStyle = taccent;
          octx.lineWidth = 1;
          octx.stroke();
          const mids = corners.map((p, i) => {
            const q = corners[(i + 1) % 4];
            return [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2] as [number, number];
          });
          for (const [hx, hy] of [...corners, ...mids]) {
            octx.fillStyle = '#ffffff';
            octx.fillRect(hx - 3.5, hy - 3.5, 7, 7);
            octx.strokeStyle = taccent;
            octx.lineWidth = 1;
            octx.strokeRect(hx - 3.5, hy - 3.5, 7, 7);
          }
        } else {
          const vertical = info.orientation === 'Vertical';
          for (const ln of info.lines) {
            // 行空间→文字空间(竖排 to_text (x,y)→(−y,x));横排=基线下 25% descent,竖排=列中线
            const y = vertical ? ln.baseline : ln.baseline + ln.descent * 0.25;
            const [tx0, ty0] = lineToText(Math.min(ln.x0, 0), y, vertical);
            const [tx1, ty1] = lineToText(Math.max(ln.x1, ln.x0 + 1), y, vertical);
            const [ax, ay] = scr(affApply(info.transform, tx0, ty0));
            const [bx, by] = scr(affApply(info.transform, tx1, ty1));
            octx.beginPath();
            octx.moveTo(ax, ay);
            octx.lineTo(bx, by);
            octx.strokeStyle = taccent;
            octx.globalAlpha = 0.8;
            octx.lineWidth = 1;
            octx.stroke();
            octx.globalAlpha = 1;
          }
        }
        const n0 = charCount(info.text);
        const a0 = Math.min(ted.caret, ted.anchor, n0);
        const b0 = Math.max(ted.caret, ted.anchor, n0);
        if (a0 < b0) {
          // 选区亮块:逐行 [span 起,止) 的 caret 段拼四边形;竖排列宽盒加宽(部分选中画整列)
          const vertical = info.orientation === 'Vertical';
          octx.fillStyle = taccent;
          octx.globalAlpha = 0.43;
          for (const ln of info.lines) {
            const sp = lineSelectionSpan(ln, a0, b0);
            if (!sp) continue;
            const sa = segs?.get(sp.span[0]);
            const sb = segs?.get(sp.span[1]);
            if (!sa || !sb) continue;
            const pts = vertical
              ? (() => {
                  const [wx, wy] = columnWidthVec(info.transform, ln, vertical);
                  return [
                    [sa[0][0] + wx / 2, sa[0][1] + wy / 2],
                    [sb[0][0] + wx / 2, sb[0][1] + wy / 2],
                    [sb[1][0] - wx / 2, sb[1][1] - wy / 2],
                    [sa[1][0] - wx / 2, sa[1][1] - wy / 2],
                  ] as [number, number][];
                })()
              : [sa[0], sb[0], sb[1], sa[1]];
            octx.beginPath();
            pts.map(scr).forEach(([x, y], i) => (i === 0 ? octx.moveTo(x, y) : octx.lineTo(x, y)));
            octx.closePath();
            octx.fill();
          }
          octx.globalAlpha = 1;
        } else {
          // caret 闪烁(上游 530ms 节奏;拖拽选字/交互后恒亮),白晕 3px+黑芯 1px(#6085)
          const elapsed = performance.now() - typeBlinkRef.current;
          if (ted.dragging || elapsed % (CARET_BLINK_MS * 2) < CARET_BLINK_MS) {
            const seg = segs?.get(Math.min(ted.caret, n0));
            if (seg) {
              const [x0, y0] = scr(seg[0]);
              const [x1, y1] = scr(seg[1]);
              octx.lineCap = 'round';
              octx.beginPath();
              octx.moveTo(x0, y0);
              octx.lineTo(x1, y1);
              octx.strokeStyle = '#ffffff';
              octx.lineWidth = 3;
              octx.stroke();
              octx.beginPath();
              octx.moveTo(x0, y0);
              octx.lineTo(x1, y1);
              octx.strokeStyle = '#000000';
              octx.lineWidth = 1;
              octx.stroke();
            }
          }
        }
        // IME 组字下划线(上游逐簇;按组字边界 caret 段中点连线近似)
        if (ted.preedit) {
          const sa = segs?.get(ted.preedit[0]);
          const sb = segs?.get(ted.preedit[0] + ted.preedit[1]);
          if (sa && sb) {
            const mid = (q: CaretSegment): [number, number] => [(q[0][0] + q[1][0]) / 2, (q[0][1] + q[1][1]) / 2];
            const [ax, ay] = scr(mid(sa));
            const [bx, by] = scr(mid(sb));
            octx.beginPath();
            octx.moveTo(ax, ay);
            octx.lineTo(bx, by);
            octx.strokeStyle = taccent;
            octx.lineWidth = 1.5;
            octx.stroke();
          }
        }
      }
      // 隐藏 textarea 跟随视图(平移/缩放后 IME 候选窗仍锚在 caret 上)
      positionTypeInput(caretSegRef.current?.segs.get(Math.min(ted.caret, charCount(typeTextRef.current))) ?? null);
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

  /** 悬停高亮拾取(上游 move_hover::target 的取数侧):单飞+尾沿排队;缓存键命中直接跳过。 */
  const fetchMoveHover = useCallback((x: number, y: number, group: boolean) => {
    const s = getSession(tabId);
    if (!s?.state || s.docId == null) return;
    const key = `${s.docId}:${s.revision}:${Math.floor(x)}:${Math.floor(y)}:${group}`;
    if (moveHoverRef.current?.key === key) return;
    if (moveHoverBusy.current) {
      moveHoverQueued.current = { x, y, group };
      return;
    }
    moveHoverBusy.current = true;
    void editorMoveHover(s.docId, Math.floor(x), Math.floor(y), group)
      .then((r) => {
        moveHoverRef.current = { key, bounds: r.bounds };
        scheduleDraw();
      })
      .catch(() => undefined)
      .finally(() => {
        moveHoverBusy.current = false;
        const q = moveHoverQueued.current;
        moveHoverQueued.current = null;
        if (q) fetchMoveHover(q.x, q.y, q.group);
      });
  }, [tabId, scheduleDraw]);

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
    // 新框=框专属历史清空(上游 ensure_frame clear_history)
    cropHistoryRef.current = { undo: [], redo: [], press: null };
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
   * 否则整段挂 live。单飞:一条 IPC 在途时最新指针进 queued,回包后重跑。
   * 压感:q 带触发该次追踪的指针压力(笔设备+选项开关时调制检测宽度,上游 settings)。 */
  const magneticFollow = useCallback((q: { x: number; y: number; pressure?: number; pen?: boolean }, fasten: boolean) => {
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
        const w = magneticPressureWidth(opts.width, q.pressure, q.pen === true, st.options.magneticPressure);
        const every = magneticSpacing(opts.frequency, st.runtime.view.scale);
        const snapped = await editorMagneticSnap(st.docId, [q.x, q.y] as [number, number], w, opts.contrast).catch(() => null);
        m = magneticRef.current;
        if (!m || st.docId == null) return;
        const target: number[] = snapped?.point ?? [q.x, q.y];
        for (let guard = 0; guard < 64; guard++) {
          m = magneticRef.current;
          if (!m || st.docId == null || m.freehand) return;
          const from = m.path[m.path.length - 1];
          if (!from) return;
          const live = await editorMagneticTrace(st.docId, from as [number, number], target as [number, number], m.trail, w, opts.contrast).catch(() => null);
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
    cropHistoryRef.current = { undo: [], redo: [], press: null }; // 提交=框历史清空(上游 clear_history)
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
    // W×H×分辨率模式:裁剪区重采样到精确 W×H + 写文档分辨率(引擎 image.crop target,
    // 一步完成;W/H 未填=不重采样,仅分辨率=只改 ppi;上游 crop_size::commit_params)
    if (isWhrKey(s.options.cropRatio)) Object.assign(params, whrCommitParams(s.options, s.state.resolution || 72));
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
    cropHistoryRef.current = { undo: [], redo: [], press: null }; // 取消=框历史清空(上游 cancel clear_history)
    const s = getSession(tabId);
    if (s) {
      s.runtime.cropStraightenArmed = false;
      s.runtime.cropStraightenLine = null;
      if (s.cropAngle !== 0) updateSession(tabId, { cropAngle: 0 });
    }
    scheduleDraw();
  }, [scheduleDraw]);

  // ===== 自由变换(二-8,上游 transform_tool)=====

  /** 会话落定:与上次落定不同则把旧落定推 undo(上游 Steps.settle;拖拽松手/字段提交调用;
   * 其他落定使微移链失效)。 */
  const settleTransformStep = useCallback(() => {
    const t = transformRef.current;
    if (!t.session) return;
    t.steps.lastNudge = null;
    const st = stepOf(t.session);
    if (t.steps.settled && stepEq(t.steps.settled, st)) return;
    if (t.steps.settled) {
      t.steps.undo.push(t.steps.settled);
      t.steps.redo = [];
    }
    t.steps.settled = st;
  }, []);

  /** 方向键微移(上游 nudge + Steps.nudged:500ms 内的连续微移并入同一步)。 */
  const nudgeTransformBox = useCallback((dx: number, dy: number) => {
    const t = transformRef.current;
    if (!t.session) return;
    const before = stepOf(t.session);
    t.session = nudgeTransform(t.session, dx, dy);
    const after = stepOf(t.session);
    const now = performance.now();
    const fold = t.steps.lastNudge != null && stepEq(t.steps.lastNudge.step, before) && now - t.steps.lastNudge.at <= 500;
    t.steps.lastNudge = { at: now, step: after };
    if (t.steps.settled && !stepEq(t.steps.settled, after) && !fold) {
      t.steps.undo.push(t.steps.settled);
      t.steps.redo = [];
    }
    t.steps.settled = after;
    syncTransformProjection(tabId, t.session);
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  /** 清理会话资源(提交/取消/层消失后;store.transform=null 由订阅或直接调用进入)。 */
  const clearTransform = useCallback(() => {
    transformRef.current = { session: null, docId: null, kind: '', bg: null, tex: null, rect: null, gesture: null, hover: null, readout: null, warpDrag: null, warpSplit: null, warpHover: null, warpType0: null, warpCoalesceKey: null, texScale: 1, steps: { settled: null, undo: [], redo: [], lastNudge: null } };
    scheduleDraw();
  }, [scheduleDraw]);

  /** Ctrl+T 进入自由变换(上游 begin:文字会话先提交;锁层/空内容/蒙版目标拒绝;零文档改动)。 */
  const beginTransform = useCallback(async () => {
    const s = getSession(tabId);
    if (!s || s.docId == null || !s.state) return;
    // 蒙版目标(target:"mask"):变换蒙版本身(上游 begin_lone;链接蒙版引擎自动落层变换)。
    // tex=蒙版灰度染色(带选区只显示选中部分),bg 空(像素层不动),提交带 target:"mask"。
    const maskTarget = isMaskTarget(s.state);
    void s.runtime.commitTextEdit?.(); // 打字中先进变换=先提交文字(上游 begin 口径)
    try {
      const r = await editorTransformBegin(s.docId, maskTarget ? 'mask' : undefined);
      const frame: RectF = r.frame;
      if (!(frame[2] - frame[0] > 0 && frame[3] - frame[1] > 0)) {
        showEditorNotice('没有可变换的内容');
        return;
      }
      // 预览资源:bg/tex 各自进离屏 canvas(同覆盖 rect)
      const mk = (w: number, h: number, px: Uint8ClampedArray<ArrayBuffer>): HTMLCanvasElement => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')?.putImageData(new ImageData(px, w, h), 0, 0);
        return c;
      };
      const session: TransformSession = {
        layer: r.layer,
        rect: frame,
        quad: corners(frame),
        pivot: [(frame[0] + frame[2]) / 2, (frame[1] + frame[3]) / 2],
        interpolation: 'bicubic',
        mode: 'free',
        targetMask: maskTarget,
        skewV: 0,
        kind: r.kind,
      };
      transformRef.current = {
        session, docId: s.docId, kind: r.kind,
        bg: r.bg.width > 0 ? mk(r.bg.width, r.bg.height, r.bg.rgba) : null,
        tex: mk(r.tex.width, r.tex.height, r.tex.rgba),
        rect: r.rect,
        gesture: null, hover: null, readout: null, warpDrag: null, warpSplit: null, warpHover: null, warpType0: null, warpCoalesceKey: null, texScale: r.texScale,
        steps: { settled: stepOf(session), undo: [], redo: [], lastNudge: null },
      };
      setTransformSession(tabId, session);
      scheduleDraw();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showEditorNotice(msg.includes('locked') ? '无法自由变换:图层已锁定' : `无法自由变换:${msg}`);
    }
  }, [tabId, scheduleDraw]);

  /** 变换选区(上游 begin_selection,Select › Transform Selection):只变换选区蒙版,
   * 像素不动(tex=蒙版染色降采样纹理;bg 空=无抽层);手势/把手/读数全复用框会话。 */
  const beginSelectionTransform = useCallback(async () => {
    const s = getSession(tabId);
    if (!s || s.docId == null || !s.state) return;
    if (transformRef.current.session) return; // 一次一个变换
    if (!s.state.selectionBounds) {
      showEditorNotice('需要先有选区');
      return;
    }
    try {
      const r = await editorSelectionTransformBegin(s.docId);
      const frame: RectF = r.frame;
      if (!(frame[2] - frame[0] > 0 && frame[3] - frame[1] > 0)) {
        showEditorNotice('没有可变换的选区');
        return;
      }
      const mk = (w: number, h: number, px: Uint8ClampedArray<ArrayBuffer>): HTMLCanvasElement => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        c.getContext('2d')?.putImageData(new ImageData(px, w, h), 0, 0);
        return c;
      };
      const session: TransformSession = {
        layer: r.layer,
        rect: frame,
        quad: corners(frame),
        pivot: [(frame[0] + frame[2]) / 2, (frame[1] + frame[3]) / 2],
        interpolation: 'bilinear', // 上游 begin_selection 口径(蒙版重采样默认双线性)
        mode: 'free',
        targetMask: false,
        skewV: 0,
        kind: 'Selection',
        selection: true,
      };
      transformRef.current = {
        session, docId: s.docId, kind: 'Selection',
        bg: null, // 像素不动
        tex: mk(r.tex.width, r.tex.height, r.tex.rgba),
        rect: r.rect,
        gesture: null, hover: null, readout: null, warpDrag: null, warpSplit: null, warpHover: null, warpType0: null, warpCoalesceKey: null, texScale: r.texScale,
        steps: { settled: stepOf(session), undo: [], redo: [], lastNudge: null },
      };
      setTransformSession(tabId, session);
      scheduleDraw();
    } catch (err) {
      showEditorNotice(`无法变换选区:${err instanceof Error ? err.message : String(err)}`);
    }
  }, [tabId, scheduleDraw]);

  /** ⌥⌘T 自由变换副本(上游 begin_copy):复制活动层(带选区=仅选中像素,Layer via Copy
   * 且引擎同步去选区)后进普通变换框;提交折叠成一步,Esc 收回复制层。 */
  const beginTransformCopy = useCallback(async () => {
    const s = getSession(tabId);
    if (!s || s.docId == null || !s.state) return;
    if (transformRef.current.session) return;
    try {
      const before = s.state.historyCurrent; // 复制前 past_len(折叠守卫 before+2)
      const selection = !!s.state.selectionBounds;
      // 不带 noPull:复制层成为活动层,必须拉新 state——否则 beginTransform 后
      // end_if_left 订阅看到"活动层换了"会立刻把新框提交掉(陈旧 activeLayer≠新层)。
      await runCommand(tabId, selection ? 'layer.new.layerViaCopy' : 'layer.duplicate', selection ? {} : { inPlace: true });
      const s2 = getSession(tabId);
      const made = s2?.state?.activeLayer ?? null;
      if (made == null) throw new Error('no duplicated layer');
      await beginTransform();
      const t = transformRef.current;
      if (!t.session) return; // beginTransform 失败=收回复制层(上游 take_back_made)
      t.session = { ...t.session, madeLayer: made, madeBefore: before };
      syncTransformProjection(tabId, t.session);
    } catch (err) {
      showEditorNotice(`无法变换副本:${err instanceof Error ? err.message : String(err)}`);
      // beginTransform 失败时收回复制层(上游 take_back_made 三重守卫在桥内)
      const s2 = getSession(tabId);
      if (s2?.docId != null && s2.state?.activeLayer != null) {
        void editorTakeBackMade(s2.docId, s2.state.activeLayer).catch(() => undefined);
      }
    }
  }, [tabId, beginTransform]);

  /** Place 拖放队列(上游 drop_places):文件放上画布→入队,无变换框时逐个
   * place_bytes(智能对象/fit 缩放/居中)+ 进变换框(made=Place:提交折叠成一步
   * "Place Embedded",Esc 收回)。上游 place_next_dropped 口径:一次一条,提交/取消
   * 落地后出队下一条;单条失败通知后继续队列。 */
  const placeQueueRef = useRef<File[]>([]);
  const placeBusyRef = useRef(false);
  const placeNextRef = useRef<() => void>(() => undefined);
  const placeNext = useCallback(async () => {
    if (placeBusyRef.current) return;
    const s = getSession(tabId);
    if (!s || s.docId == null || s.transform || s.transformCommitting) return;
    const file = placeQueueRef.current.shift();
    if (!file) return;
    placeBusyRef.current = true;
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const before = s.state?.historyCurrent ?? 0;
      // 蒙版目标先切回合成:placed 层没有蒙版,transform_begin('mask') 会报错
      // (上游 lone_target=None 落普通层;place 本就是层级操作,PS 亦退出蒙版定向)。
      if (isMaskTarget(s.state)) await runCommand(tabId, 'channel.target', { channel: 'composite' });
      const r = await editorPlace(s.docId, file.name, bytes);
      const made = r.layer;
      // 拉新 state(⌥⌘T noPull 教训:陈旧 activeLayer 会让 end_if_left 把新框立刻提交掉)
      const st = await editorState(s.docId);
      const s2 = getSession(tabId);
      if (s2 && typeof st.revision === 'number' && st.revision >= s2.revision) updateSession(tabId, { state: st });
      await beginTransform();
      const t = transformRef.current;
      if (!t.session) return; // begin 失败:placed 层保留(可撤销),队列继续
      t.session = { ...t.session, madeLayer: made, madeBefore: before, madeKind: 'place' };
      syncTransformProjection(tabId, t.session);
    } catch (err) {
      showEditorNotice(`无法置入 ${file.name}:${err instanceof Error ? err.message : String(err)}`);
    } finally {
      placeBusyRef.current = false;
    }
    void placeNextRef.current(); // 成功=框已开守卫拦截;失败=继续下一条(上游 Err 分支同款)
  }, [tabId, beginTransform]);
  useEffect(() => {
    placeNextRef.current = () => void placeNext();
  }, [placeNext]);
  /** store 侧出队入口(恒定标识:内部经 ref 恒读最新 placeNext)。 */
  const placeNextEntry = useCallback(() => placeNextRef.current(), []);

  /** 步退/步进(框打开期间 Ctrl+Z/Y 被劫持到框快照,上游 transform_undo_tests 口径)。 */
  const transformUndo = useCallback(() => {
    const t = transformRef.current;
    if (!t.session || !t.steps.undo.length) return;
    t.steps.lastNudge = null;
    t.steps.redo.push(stepOf(t.session));
    t.session = restoreStep(t.session, t.steps.undo.pop()!);
    syncTransformProjection(tabId, t.session);
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  const transformRedo = useCallback(() => {
    const t = transformRef.current;
    if (!t.session || !t.steps.redo.length) return;
    t.steps.lastNudge = null;
    t.steps.undo.push(stepOf(t.session));
    t.session = restoreStep(t.session, t.steps.redo.pop()!);
    syncTransformProjection(tabId, t.session);
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  /** 选项条字段编辑(经 runtime.transformField):mutate 真源 → 落定推栈 → 回写投影。 */
  const transformField = useCallback((fn: (s: TransformSession) => TransformSession) => {
    const t = transformRef.current;
    if (!t.session) return;
    settleTransformStep();
    t.session = fn(t.session);
    settleTransformStep();
    syncTransformProjection(tabId, t.session);
    scheduleDraw();
  }, [tabId, settleTransformStep, scheduleDraw]);

  /** 提交(✓/Enter/框外单击):store.commitTransform 统一置 transformCommitting(所有
   *  提交路径含切工具/切层自动提交),抽层预览保持到位图泵渲染出新文档上屏再无缝切。 */
  const commitTransformBox = useCallback(() => {
    if (!transformRef.current.session) return;
    void commitTransform(tabId);
  }, [tabId]);

  /** 进入 Warp 模式(上游 enter_warp):框未动=单面片恒等网格;框已变形=把仿射烙进 mesh 点
   * (框模式下的缩放/旋转保留,warp 在其上叠加)。切换是一步。 */
  const enterWarpBox = useCallback(() => {
    const t = transformRef.current;
    if (!t.session) return;
    if (t.session.targetMask) {
      // 蒙版目标不进 Warp(上游 enter_warp:t.target.is_some() keeps the box)
      showEditorNotice('蒙版目标不支持 Warp 变形');
      return;
    }
    if (t.kind === 'Type') {
      // 文字层 Warp Text(上游 enter_type_warp,#3004):桥已剥已有 warp 出框/纹理
      // (tex=无 warp 文字位图),会话=纯风格态(warp.mesh=null),预览=前端按风格网格
      // 变形贴纹理(零引擎调用);提交 edit.transform.warp 引擎转 TextWarp 重排
      // (unchanged 短路),Esc=纯丢弃(层从未被改,上游同口径)。
      settleTransformStep();
      const tSession = t.session;
      const initial: WarpObject = { style: 'none', bend: 0, hDistort: 0, vDistort: 0, vertical: false, bounds: tSession.rect, mesh: null };
      t.session = { ...tSession, warp: initial };
      settleTransformStep();
      syncTransformProjection(tabId, t.session);
      scheduleDraw();
      void (async () => {
        // 回读层已有 Warp Text(上游直读内存;我们走 type.info,仅 15 预设回显)
        try {
          const info = await runCommand(tabId, 'type.info', { layer: tSession.layer }, { noPull: true }) as TypeInfoJson;
          const cur = transformRef.current;
          if (!cur.session?.warp || cur.kind !== 'Type') return;
          const w = info.warp;
          if (w && w.style && w.style !== 'warpNone') {
            const back: WarpObject = {
              style: psdWarpToShort(w.style), bend: w.value,
              hDistort: w.horizontal_distortion, vDistort: w.vertical_distortion,
              vertical: !w.horizontal, bounds: cur.session.warp.bounds, mesh: null,
            };
            cur.session = { ...cur.session, warp: back };
            syncTransformProjection(tabId, cur.session);
            scheduleDraw();
          }
        } catch { /* 层已删/文档已换 */ }
      })();
      return;
    }
    settleTransformStep();
    const tSession = t.session;
    const rect = tSession.rect;
    const base = meshIdentity(rect, 1, 1);
    let points = base.points;
    if (!quadUnchanged(rect, tSession.quad)) {
      const h = Homography.rectToQuad(rect, tSession.quad);
      if (h) points = base.points.map((p) => h.apply(p[0], p[1]));
    }
    t.session = { ...tSession, warp: warpCustom({ us: base.us, vs: base.vs, points }, rect) };
    t.warpDrag = null;
    t.warpHover = null;
    t.warpSplit = null;
    settleTransformStep();
    syncTransformProjection(tabId, t.session);
    scheduleDraw();
  }, [tabId, settleTransformStep, scheduleDraw]);

  /** 退出 Warp 回框模式(上游 leave_warp):未提交的 warp 编辑直接丢弃(PS 口径)。 */
  const leaveWarpBox = useCallback(() => {
    const t = transformRef.current;
    if (!t.session?.warp) return;
    settleTransformStep();
    t.session = { ...t.session, warp: null };
    t.warpDrag = null;
    t.warpSplit = null;
    t.warpHover = null;
    setTransformSplit(tabId, null);
    settleTransformStep();
    syncTransformProjection(tabId, t.session);
    scheduleDraw();
  }, [tabId, settleTransformStep, scheduleDraw]);

  /** 框/Warp 模式切换(选项条 grid-3x3 按钮;没开框=先进框,上游 begin_warp 的 fresh 路径)。 */
  const toggleWarpBox = useCallback(() => {
    const t = transformRef.current;
    if (!t.session) {
      void beginTransform();
      return;
    }
    if (t.session.warp) leaveWarpBox();
    else enterWarpBox();
  }, [beginTransform, enterWarpBox, leaveWarpBox]);

  /** Warp 重置(上游 reset_warp):像素层=盒上默认单面片恒等网格;文字层=取消 Warp Text(none)。
   * 清拖拽/分割状态。 */
  const resetWarpBox = useCallback(() => {
    const t = transformRef.current;
    if (!t.session?.warp) return;
    transformField((v) => ({ ...v, warp: t.kind === 'Type' ? { style: 'none', bend: 0, hDistort: 0, vDistort: 0, vertical: false, bounds: v.rect, mesh: null } : resetWarp(v.rect) }));
    t.warpDrag = null;
    t.warpHover = null;
    t.warpSplit = null;
    setTransformSplit(tabId, null);
  }, [tabId, transformField]);

  /** 网格密度(上游 warpGrid 语义前端化):偶数 n×n 面片保形重拟,曲面不变。 */
  const setWarpGridBox = useCallback((n: number) => {
    const t = transformRef.current;
    if (!t.session?.warp) return;
    transformField((v) => (v.warp ? { ...v, warp: resizeWarp(v.warp, n) } : v));
    t.warpDrag = null;
    t.warpHover = null;
  }, [transformField]);

  /** 武装分割工具(选项条三按钮;落下=画布抬起时落线)。 */
  const armWarpSplitBox = useCallback((tool: 'cross' | 'vertical' | 'horizontal' | null) => {
    const t = transformRef.current;
    if (!t.session?.warp) return;
    t.warpSplit = tool ? { tool, placing: false, quick: false, pointer: null } : null;
    setTransformSplit(tabId, tool);
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  /** 静止后高密度重渲:拖拽中贴图走低密度帧预算,松手 250ms 无新拖拽才渲染一次
   * (上游大层 warp 提交本就是后台 job 的等价权衡;连续拖-松-拖时 timer 重置防卡顿)。 */
  const warpStillTimerRef = useRef<number | null>(null);
  const scheduleWarpStillRender = useCallback(() => {
    if (warpStillTimerRef.current != null) window.clearTimeout(warpStillTimerRef.current);
    warpStillTimerRef.current = window.setTimeout(() => {
      warpStillTimerRef.current = null;
      scheduleDraw();
    }, 250);
  }, [scheduleDraw]);

  const cancelTransformBox = useCallback(() => {
    const t = transformRef.current;
    if (!t.session) return;
    transformRef.current.gesture = null;
    cancelTransform(tabId);
    clearTransform();
    placeNextRef.current(); // Place 队列:取消后出队下一条(上游 place_next_dropped)
  }, [tabId, clearTransform]);

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
    const preset = cropPresetRatioOf(st.options.cropRatio, st.options, st.state.width, st.state.height, st.state.resolution || 72);
    if (f && preset != null) {
      const fitted = cropFittedRatio(f.rect, preset);
      if (fitted) {
        // W×H×分辨率:输出尺寸=显式指令,适配后的框=待提交裁剪(上游 #6750 sized→keyed);
        // 普通比例预设适配默认框不算编辑(#6750)
        cropRef.current = { ...f, rect: fitted, edited: isWhrKey(st.options.cropRatio) ? true : f.edited };
      }
    }
    scheduleDraw();
  }, [tabId, scheduleDraw]);

  // Live 渐变:选中 kind="Fill" 的图层时读回渐变信息(缓存按 revision 过期),供 widget/命中用。
  // 拖动中跳过(overlay 画手势本地态,读回纯属浪费一条 IPC);hold 态读回落地后清 hold
  // (revision 已前进=引擎终态已取回,overlay 交还给真实数据,无可见跳变)
  const activeLayer = session?.state?.layers.find((l) => l.id === session.state?.activeLayer) ?? null;
  useEffect(() => {
    let cancelled = false;
    const st = getSession(tabId);
    const layerId = st?.state?.activeLayer ?? null;
    if (!st?.docId || !layerId || activeLayer?.kind !== 'Fill') {
      liveFillRef.current = null;
      scheduleDraw();
      return;
    }
    if (liveGradRef.current && liveGradRef.current.kind !== 'hold') return;
    void fetchGradientFill(tabId, st.docId, layerId, st.revision).then((fill) => {
      if (cancelled) return;
      liveFillRef.current = fill && fill.layer === layerId ? fill : null;
      const lg = liveGradRef.current;
      if (lg?.kind === 'hold' && st.revision > lg.rev0) liveGradRef.current = null;
      st.runtime.requestDraw?.();
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [tabId, activeLayer?.kind, session?.docId, session?.revision, session?.state?.activeLayer, scheduleDraw, activeLayer]);

  /** 续画起点尝试(上游 pen_down 的 resume_at 调用,#6593):无草稿时按面板选中
   * (缓存几何)或工作路径找开放子路径端点。形状模式/蒙版定向不续画(上游同款)。 */
  const tryResumePen = (s: NonNullable<ReturnType<typeof getSession>>, x: number, y: number, tol: number): PenDraft | null => {
    if (s.options.penVectorMode === 'shape' || targetedVectorMaskLayer(s) != null) return null;
    const docId = s.docId;
    if (docId == null) return null;
    const sel = s.selectedPath;
    if (sel && sel !== 'work' && (s.pathsList?.paths ?? []).some((p) => p.name === sel)) {
      const geo = getCachedPathGeo(docId, sel, s.revision);
      return geo ? resumeAt(geo, docId, sel, x, y, tol) : null;
    }
    return s.workPath ? resumeAt(s.workPath, docId, 'work', x, y, tol) : null;
  };

  /** 活动层被定向的矢量蒙版(上游 targeted_vector_mask):channel.target=vectorMask 且
   * 活动层带矢量蒙版且非形状层(shape 层的路径是内容)。返回层 id。 */
  const targetedVectorMaskLayer = (s: NonNullable<ReturnType<typeof getSession>>): number | null => {
    if (s.state?.channels?.target?.kind !== 'vectorMask') return null;
    const l = findLayerTree(s.state.layers, s.state.activeLayer);
    return l && l.kind !== 'Shape' && l.hasVectorMask ? l.id : null;
  };

  /** 提交钢笔草稿(上游 pen_commit/commit_path 全分支:形状模式→续画原位替换→矢量蒙版
   * 追加→面板选中并入/替换工作路径;成功后面板目标=提交目标,上游 selected_path 口径)。
   * <2 锚丢弃。path.set/返回值=常驻轮廓数据源,就地入会话。 */
  const commitPen = (closed: boolean): Promise<void> => {
    const p = penRef.current;
    penRef.current = null;
    const s2 = getSession(tabId);
    if (!s2 || !p || p.knots.length < 2) {
      scheduleDraw();
      return Promise.resolve();
    }
    const json = penToJson(p, closed);
    // 形状模式(上游 commit_path shape 分支):shape.create kind:path 一步「New Shape Layer」;
    // 闭合=填充(前景,选项条开)+描边(背景,宽度>0);开放=无填充,描边=前景且宽度至少 1
    if (s2.options.penVectorMode === 'shape' && s2.state) {
      const fg = s2.state.foreground;
      const bg = s2.state.background;
      let fill: string | undefined;
      let stroke: Record<string, unknown> | undefined;
      if (closed) {
        const r = shapeFillStroke(s2.options, fg, bg);
        fill = r.fill;
        stroke = r.stroke;
      } else {
        stroke = shapeFillStroke({ ...s2.options, shapeFill: false, strokeWidth: Math.max(s2.options.strokeWidth, 1) }, fg, bg).stroke;
        if (stroke) stroke = { ...stroke, color: rgbToHex(fg) };
      }
      void runCommand(tabId, 'shape.create', { kind: 'path', path: json, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}) })
        .catch((err) => logError('[editor] shape.create 失败', err));
      scheduleDraw();
      return Promise.resolve();
    }
    // 续画(上游 resumed 分支,#6593):drawn 顶替原子路径(保 op 闭合);已变=退化并入
    if (p.resumes) {
      const resumed = p.resumes;
      return (async () => {
        try {
          const r = await runCommand(tabId, 'path.info', { name: resumed.path }, { noPull: true });
          const cur = (r as { path?: EnginePathJson } | null)?.path;
          if (!cur) throw new Error('resume target missing');
          const merged = withResumedSubpath(cur as unknown as EditPath, resumed.index, resumed.was as unknown as EditSubpath, json as unknown as EditPath);
          if (merged) {
            await runCommand(tabId, 'path.set', { name: resumed.path, path: merged });
          } else {
            await runCommand(tabId, 'path.set', { name: resumed.path, op: 'combine', path: json });
          }
          const s3 = getSession(tabId);
          if (!s3) return;
          if (resumed.path === 'work') {
            const fresh = (await runCommand(tabId, 'path.info', { name: 'work' }, { noPull: true }).catch(() => null)) as { path?: WorkPathJson } | null;
            if (fresh?.path) s3.workPath = fresh.path;
          }
          updateSession(tabId, { selectedPath: resumed.path });
          scheduleDraw();
        } catch (err) {
          logError('[editor] 续画提交失败', err);
        }
      })();
    }
    // 矢量蒙版定向(上游 targeted_vector_mask 分支,#196):子路径追加进蒙版
    const maskLayer = targetedVectorMaskLayer(s2);
    if (maskLayer != null) {
      return (async () => {
        try {
          const r = await runCommand(tabId, 'path.info', { name: 'layer' }, { noPull: true });
          const cur = (r as { path?: EnginePathJson } | null)?.path;
          if (!cur) throw new Error('no vector mask path');
          const merged: EnginePathJson = { ...cur, subpaths: [...cur.subpaths, ...json.subpaths] };
          await runCommand(tabId, 'layer.vectorMask.edit', { layer: maskLayer, path: merged });
          const s3 = getSession(tabId);
          if (s3) {
            s3.vectorMaskPath = merged;
            scheduleDraw();
          }
        } catch (err) {
          logError('[editor] vectorMask.edit 失败', err);
        }
      })();
    }
    // 工作路径/面板选中(上游 Path 模式主分支):选中有效=并入(op combine);
    // 无有效选中=新工作路径**替换**旧的上游口径
    return (async () => {
      await refreshPathsList(tabId);
      const s3 = getSession(tabId);
      if (!s3) return;
      const rows = pathRows(s3.pathsList ?? null);
      const sel = s3.selectedPath ?? null;
      const target = sel != null && rows.some((r0) => r0.key === sel) ? sel : null;
      const name = target ?? 'work';
      try {
        const r = await runCommand(tabId, 'path.set', { name, path: json, ...(target ? { op: 'combine' } : {}) });
        const s4 = getSession(tabId);
        const path = (r as { path?: WorkPathJson } | null)?.path;
        if (s4) {
          if (path && name === 'work') s4.workPath = path;
          updateSession(tabId, { selectedPath: name });
          scheduleDraw();
        }
      } catch (err) {
        logError('[editor] path.set 失败', err);
      }
    })();
  };

  /** Ctrl+Enter/选项条「建立选区」(上游 path_to_selection,#306):钢笔草稿在画先提交
   * (形状模式→形状层;续画/蒙版定向=交给 commitPen 的对应分支),再把当前路径
   * (面板选中→工作路径→活动层路径,上游 active_path_name)载入选区。 */
  const makeSelectionFromActivePath = async () => {
    const s = getSession(tabId);
    if (!s) return;
    const pen = penRef.current;
    if (pen && pen.knots.length >= 2) {
      penRef.current = null;
      if (s.options.penVectorMode === 'shape' && s.state) {
        const fg = s.state.foreground;
        const bg = s.state.background;
        const r0 = shapeFillStroke(s.options, fg, bg);
        try {
          await runCommand(tabId, 'shape.create', { kind: 'path', path: penToJson(pen, false), ...(r0.fill ? { fill: r0.fill } : {}), ...(r0.stroke ? { stroke: r0.stroke } : {}) });
        } catch (err) {
          logError('[editor] shape.create 失败', err);
          return;
        }
        updateSession(tabId, { selectedPath: 'layer' });
      } else {
        // 续画/蒙版定向的提交语义在 commitPen 里(原位替换/追加),复用之
        await commitPen(false);
      }
    }
    // 行表是异步摘要,提交后立即读会撞陈旧(新工作路径行还没到):强制刷新再判
    await refreshPathsList(tabId);
    const s2 = getSession(tabId);
    const name = activePathName(pathRows(s2?.pathsList ?? null), s2?.selectedPath ?? null);
    if (!name) {
      showEditorNotice('没有可建立选区的路径:先用钢笔画一条,或在路径面板选中一条。');
      return;
    }
    try {
      await runCommand(tabId, 'path.toSelection', { name });
    } catch (err) {
      showEditorNotice(`建立选区失败:${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // ===== 文字编辑会话(二期 二-6,上游 type_tool.rs 逐条移植;编辑=带 coalesce 的
  // type.edit,整会话一条「编辑文字」历史步;caret 几何/命中/导航走引擎 journal:false 查询) =====

  /** type.info(缓存 per docId:layer:revision;journal:false)。 */
  const fetchTypeInfo = async (layer: number): Promise<TypeInfoJson | null> => {
    const s = getSession(tabId);
    if (!s || s.docId == null) return null;
    const key = `${s.docId}:${layer}:${s.revision}`;
    if (typeInfoRef.current?.key === key) return typeInfoRef.current.info;
    try {
      const info = await runCommand(tabId, 'type.info', { layer }, { noPull: true }) as TypeInfoJson;
      typeInfoRef.current = { key, info };
      return info;
    } catch {
      return null;
    }
  };

  /** type.caret 段(缓存 per revision;journal:false,文档 px)。 */
  const fetchCaretSeg = async (layer: number, index: number): Promise<CaretSegment | null> => {
    const s = getSession(tabId);
    if (!s || s.docId == null) return null;
    const key = `${s.docId}:${layer}:${s.revision}`;
    if (caretSegRef.current?.key !== key) caretSegRef.current = { key, segs: new Map() };
    const hit = caretSegRef.current.segs.get(index);
    if (hit) return hit;
    try {
      const r = await runCommand(tabId, 'type.caret', { layer, index }, { noPull: true }) as { segment?: CaretSegment };
      const seg = r.segment ?? null;
      if (seg) caretSegRef.current.segs.set(index, seg);
      return seg;
    } catch {
      return null;
    }
  };

  /** 隐藏 textarea 摆到 caret 屏幕位(IME 候选窗锚定元素矩形;上游 egui IMEOutput 的 Web 等价)。 */
  const positionTypeInput = (seg: CaretSegment | null) => {
    const el = typeInputRef.current;
    const s = getSession(tabId);
    if (!el || !s) return;
    if (!seg) {
      el.style.left = '-100px';
      el.style.top = '-100px';
      return;
    }
    const [x0, y0] = docToScreen(s.runtime.view, seg[0][0], seg[0][1]);
    const [x1, y1] = docToScreen(s.runtime.view, seg[1][0], seg[1][1]);
    el.style.left = `${Math.min(x0, x1)}px`;
    el.style.top = `${Math.min(y0, y1)}px`;
    el.style.width = `${Math.max(1, Math.abs(x1 - x0))}px`;
    el.style.height = `${Math.max(1, Math.abs(y1 - y0))}px`;
  };

  /** 编辑会话仍归属本文档且层未变(上游 end_if_left 的家判定)。 */
  const typeSessionHome = (s: EditorSession): boolean =>
    !!s.textEdit && s.textEdit.docId === s.docId && s.state?.activeLayer === s.textEdit.layer;

  /** 树中查层(顶层=最上;返回首个 kind==='Type' 且可见且 bounds±tol 命中的层 id)。
   * inspect 的 bounds=[x0,y0,width,height](inspect.rs 口径,非 x1y1)。 */
  const topmostTypeLayerAt = (s: EditorSession, x: number, y: number, tol: number, want: number | null = null): number | null => {
    const walk = (ls: EditorLayer[]): number | null => {
      for (const l of ls) {
        if (l.kind === 'Type' && l.visible !== false && l.bounds) {
          const [bx, by, bw, bh] = l.bounds;
          if (x >= bx - tol && x <= bx + bw + tol && y >= by - tol && y <= by + bh + tol && (want == null || l.id === want)) return l.id;
        }
        if (l.children) {
          const f = walk(l.children as EditorLayer[]);
          if (f != null) return f;
        }
      }
      return null;
    };
    return walk(s.state?.layers ?? []);
  };

  /** 文字替换(上游 insert):选区 [a,b) → t;coalesce 并进会话历史步。 */
  const insertTypeText = async (t0: string) => {
    const s = getSession(tabId);
    const ed = s?.textEdit;
    if (!s || !ed) return;
    const a = Math.min(ed.caret, ed.anchor);
    const b = Math.max(ed.caret, ed.anchor);
    const t = normText(t0);
    if (a === b && t === '') return;
    const len = charCount(t);
    try {
      await runCommand(tabId, 'type.edit', { layer: ed.layer, replace: { start: a, end: b, text: t }, coalesce: ed.session });
      const s2 = getSession(tabId);
      if (s2?.textEdit) updateSession(tabId, { textEdit: { ...s2.textEdit, caret: a + len, anchor: a + len } });
      typeTextRef.current = applyReplace(typeTextRef.current, a, b, t);
      typeBlinkRef.current = performance.now();
      scheduleDraw();
    } catch (err) {
      logError('[editor] type.edit 失败', err);
    }
  };

  /** 键入(上游 insert_typed):智能引号(偏好默认开);IME 组字不走这里。 */
  const insertTyped = (s0: string) => {
    const s = getSession(tabId);
    if (!s?.textEdit) return;
    const at = Math.min(s.textEdit.caret, s.textEdit.anchor);
    const prev = at > 0 ? [...typeTextRef.current][at - 1] : undefined;
    void insertTypeText(smartQuotes(s0, prev));
  };

  /** IME 组字(上游 ime_update):preedit 写入图层排版回流,每次更新原位替换;提交定型。
   * 空组字且无进行中=输入法状态扰动(#1381),不动。 */
  const imeUpdateType = async (s0: string, commit: boolean) => {
    const s = getSession(tabId);
    const ed = s?.textEdit;
    if (!s || !ed) return;
    const t = normText(s0);
    const r = imeRange(ed.preedit, ed.caret, ed.anchor, charCount(typeTextRef.current), t);
    if (!r) return;
    const [start, end, len] = r;
    try {
      await runCommand(tabId, 'type.edit', { layer: ed.layer, replace: { start, end, text: t }, coalesce: ed.session });
      const s2 = getSession(tabId);
      if (!s2?.textEdit) return;
      updateSession(tabId, { textEdit: { ...s2.textEdit, caret: start + len, anchor: start + len, preedit: commit || len === 0 ? null : [start, len] } });
      typeTextRef.current = applyReplace(typeTextRef.current, start, end, t);
      typeBlinkRef.current = performance.now();
      scheduleDraw();
    } catch (err) {
      logError('[editor] IME 组字失败', err);
    }
  };

  /** 连击选词(上游 multi_click):2=词 3=行 4=段落 5=全选;命中点经 type.hitTest 定 caret。
   * count 由按下处的连击判定给出(pointerdown.detail 恒 1,靠时距自计)。 */
  const applyTypeClicks = async (layer: number, count: number, at: [number, number] | null, fallbackCaret: number) => {
    const s = getSession(tabId);
    const ed = s?.textEdit;
    if (!s || !ed || ed.layer !== layer) return;
    updateSession(tabId, { typeClicks: { layer, count, t: performance.now(), at: at ?? [0, 0] } });
    if (count < 2) return;
    const info = await fetchTypeInfo(layer);
    if (!info) return;
    let caret = fallbackCaret;
    let lineIdx: number | null = null;
    if (at) {
      try {
        const h = await runCommand(tabId, 'type.hitTest', { layer, x: at[0], y: at[1] }, { noPull: true }) as { index?: number; line?: number };
        if (typeof h.index === 'number') {
          caret = h.index;
          lineIdx = typeof h.line === 'number' ? h.line : null;
        }
      } catch {
        /* 脱靶=落回 fallback caret */
      }
    }
    const [a, b] = clickSelection(info.text, caret, info.lines, lineIdx, count);
    const s2 = getSession(tabId);
    if (s2?.textEdit && s2.textEdit.layer === layer) {
      updateSession(tabId, { textEdit: { ...s2.textEdit, caret: b, anchor: a } });
      typeBlinkRef.current = performance.now();
      scheduleDraw();
    }
  };

  /** 连击判定(上游 next_click_count 的时距语义,egui 自带时限/距离;Web 用自计时:
   * 同层 450ms 内且 ≤4 屏幕 px=连击递增到 5 后循环,否则重置为 1)。 */
  const typeClickCount = (s: EditorSession, layer: number, at: [number, number]): number => {
    const prev = s.typeClicks;
    if (prev && prev.layer === layer && prev.at && performance.now() - prev.t < 450
      && Math.hypot(prev.at[0] - at[0], prev.at[1] - at[1]) < 4 / Math.max(0.01, s.runtime.view.scale)) {
      return (prev.count % MAX_CLICKS) + 1;
    }
    return 1;
  };

  /** 开既有文字层的编辑会话(上游 pointer_down 命中分支/edit_at;count=连击判定)。 */
  const beginTypeEdit = (layer: number, offset: number, count: number, at: [number, number] | null, returnTool: EditorTool | null) => {
    const s = getSession(tabId);
    if (!s) return;
    typeReturnToolRef.current = returnTool;
    typeTextRef.current = '';
    updateSession(tabId, {
      textEdit: { layer, docId: s.docId, caret: offset, anchor: offset, session: `type-${Date.now()}-${++typeSeqRef.current}`, created: false, preedit: null, dragging: false },
    });
    void fetchTypeInfo(layer).then((info) => {
      if (info) typeTextRef.current = info.text;
      void applyTypeClicks(layer, count, at, offset);
      scheduleDraw();
    });
    typeInputRef.current?.focus();
    typeBlinkRef.current = performance.now();
    scheduleDraw();
  };

  /** 新建文字(type.create;上游 pointer_up + default_style_params):拖 ≥4 屏幕 px=段落框,
   * 否则点文本;占位文本默认开(偏好 fill_new_type_layers_with_placeholder),选中态,
   * 键入即替换;样式=选项条默认(字体/样式/字号/对齐/方向/字符页签改的其他键+前景色)。 */
  const createTypeText = async (start: [number, number], end: [number, number], vertical: boolean) => {
    const s = getSession(tabId);
    if (!s || s.textEdit) return;
    const minPx = 4 / Math.max(0.01, s.runtime.view.scale);
    const coalesce = `type-${Date.now()}-${++typeSeqRef.current}`;
    const o = s.options;
    const style: Record<string, unknown> = {
      font: o.typeFont, fontStyle: o.typeStyle, size: o.typeSize, align: o.typeAlign, direction: o.typeDirection,
      ...o.typeStyleDefaults,
      ...(s.state ? { color: rgbToHex(s.state.foreground) } : {}),
    };
    const base: Record<string, unknown> = { text: TYPE_PLACEHOLDER, orientation: vertical ? 'vertical' : 'horizontal', coalesce, ...style };
    const params = makesBox(start, end, minPx)
      ? { ...base, box: [Math.round(Math.min(start[0], end[0])), Math.round(Math.min(start[1], end[1])), Math.round(Math.abs(end[0] - start[0])), Math.round(Math.abs(end[1] - start[1]))] }
      : { ...base, x: Math.round(start[0]), y: Math.round(start[1]) };
    try {
      const r = await runCommand(tabId, 'type.create', params) as { layer?: number };
      if (typeof r.layer !== 'number') return;
      const s2 = getSession(tabId);
      if (!s2) return;
      typeTextRef.current = TYPE_PLACEHOLDER;
      updateSession(tabId, { textEdit: { layer: r.layer, docId: s2.docId, caret: charCount(TYPE_PLACEHOLDER), anchor: 0, session: coalesce, created: true, preedit: null, dragging: false } });
      void fetchTypeInfo(r.layer).then((info) => {
        if (info) {
          typeTextRef.current = info.text;
          scheduleDraw();
        }
      });
      typeInputRef.current?.focus();
      typeBlinkRef.current = performance.now();
      scheduleDraw();
    } catch (err) {
      logError('[editor] type.create 失败', err);
    }
  };

  /** 提交会话(上游 commit/commit_here,无 Type Mask 分支——S6 后置):新层空=删层,
   * 新层=按文字重命名;既有层只收尾。 */
  const commitType = async () => {
    const s = getSession(tabId);
    const ed = s?.textEdit;
    if (!s || !ed) return;
    updateSession(tabId, { textEdit: null, typeClicks: null });
    if (typeReturnToolRef.current && TYPE_TOOLS.has(s.tool)) setTool(tabId, typeReturnToolRef.current);
    typeReturnToolRef.current = null;
    typeInputRef.current?.blur();
    try {
      const info = await fetchTypeInfo(ed.layer);
      const text = info?.text ?? typeTextRef.current;
      if (ed.created) {
        if (text.trim() === '') {
          await runCommand(tabId, 'layer.delete', { layer: ed.layer });
        } else {
          await runCommand(tabId, 'type.edit', { layer: ed.layer, name: layerNameFromText(text), coalesce: ed.session });
        }
      }
    } catch (err) {
      logError('[editor] 文字提交失败', err);
    }
    scheduleDraw();
  };

  /** 文字工具按下(上游 pointer_down):会话中=把手/框内落 caret/框外提交;无会话=命中
   * 既有文字层(异步 hitTest 确认,期间挂起)或拖框手势。 */
  const typePointerDown = async (s: EditorSession, dx: number, dy: number, e: React.PointerEvent) => {
    const tol = 6 / Math.max(0.01, s.runtime.view.scale);
    const ed = s.textEdit;
    if (ed) {
      if (!typeSessionHome(s)) {
        // 编辑被留在别的文档/层(#6483 口径):提交后再按新点起字
        await commitType();
      }
      const info = await fetchTypeInfo(ed.layer);
      const s1 = getSession(tabId);
      if (!s1?.textEdit) return;
      if (info) {
        const shape = boxOfShape(info.shape);
        const h = shape ? boxHandleAt(shape, info.transform, dx, dy, tol) : null;
        if (h != null) {
          // 把手:快照按下时的框(上游 BoxResize;⌥ 镜像中心由此固定)
          typeResizeRef.current = { handle: h, shape: shape!, transform: [...info.transform], lastSent: 0, pending: null };
          return;
        }
        const [tx, ty] = affApply(affInvert(info.transform), dx, dy);
        const inBox = shape ? insideBox(shape, tx, ty) : false;
        // 命中=像素 bounds(inspect)或排版行盒(上游 text_point_inside;baseline 上方的
        // 点击在 ink 外但属于文字)
        const onGlyphs = topmostTypeLayerAt(s1, dx, dy, tol, ed.layer) != null
          || lineBoxHit(info.lines ?? [], info.transform, dx, dy, tol, info.orientation === 'Vertical');
        if (inBox || onGlyphs) {
          updateSession(tabId, { textEdit: { ...s1.textEdit, dragging: true } });
          const count = typeClickCount(s1, ed.layer, [dx, dy]);
          try {
            const ht = await runCommand(tabId, 'type.hitTest', { layer: ed.layer, x: dx, y: dy }, { noPull: true }) as { index?: number };
            const s2 = getSession(tabId);
            if (s2?.textEdit && s2.textEdit.layer === ed.layer) {
              const off = typeof ht.index === 'number' ? ht.index : s2.textEdit.caret;
              updateSession(tabId, { textEdit: { ...s2.textEdit, caret: off, anchor: e.shiftKey ? s2.textEdit.anchor : off, dragging: true } });
            }
          } catch {
            /* 脱靶:保持 caret,拖拽仍成立(上游 hit_char 最近点) */
          }
          typeBlinkRef.current = performance.now();
          void applyTypeClicks(ed.layer, count, [dx, dy], ed.caret);
          // 点击落 caret 后把焦点收回隐藏 input(浏览器点非可聚焦元素会掉到 body)
          typeInputRef.current?.focus();
          return;
        }
        // 框外点击=提交不起新文字(上游 commit_with + return true)
        void commitType();
        return;
      }
      return;
    }
    // ⇧点击=新文字盖旧字(上游 mods.shift 早退 → 落 box 手势)
    if (e.shiftKey) {
      typeDragRef.current = { start: [dx, dy] };
      return;
    }
    const id = topmostTypeLayerAt(s, dx, dy, tol);
    if (id != null) {
      // 命中像素 bounds:异步 hitTest 确认(命中=编辑;脱靶=转拖框/点文本)
      typePendingRef.current = { start: [dx, dy], detail: e.detail, down: true };
      try {
        const ht = await runCommand(tabId, 'type.hitTest', { layer: id, x: dx, y: dy }, { noPull: true }) as { index?: number; inside?: boolean };
        const pend = typePendingRef.current;
        typePendingRef.current = null;
        const s2 = getSession(tabId);
        if (!s2 || s2.textEdit) return;
        if (ht.inside) {
          await runCommand(tabId, 'layer.select', { layer: id });
          beginTypeEdit(id, typeof ht.index === 'number' ? ht.index : 0, typeClickCount(s, id, [dx, dy]), [dx, dy], null);
          return;
        }
        if (pend?.down) {
          // 未命中字形/框:按住中=转拖框;已抬起=点文本(上游 pointer_down false→box 手势)
          if (pend.down) typeDragRef.current = { start: pend.start };
        }
      } catch {
        const pend = typePendingRef.current;
        typePendingRef.current = null;
        if (pend?.down) typeDragRef.current = { start: pend.start };
      }
      return;
    }
    typeDragRef.current = { start: [dx, dy] };
  };

  /** 文字工具移动:把手拖缩(节流 80ms+尾沿,Live 同款)/拖拽选字 caret(60ms 节流)。 */
  const typePointerMove = (s: EditorSession, dx: number, dy: number, alt: boolean) => {
    const ed = s.textEdit;
    const rs = typeResizeRef.current;
    if (rs && ed) {
      const [px, py] = affApply(affInvert(rs.transform), dx, dy);
      const [x0, y0, w, h] = resizeBoxCalc(rs.handle, rs.shape, px, py, alt);
      const [ox, oy] = affApply(rs.transform, x0, y0);
      const box: [number, number, number, number] = [ox, oy, w, h];
      const now = performance.now();
      if (now - rs.lastSent > 80) {
        rs.lastSent = now;
        rs.pending = null;
        markInteractiveRender(tabId, 1200);
        void runCommand(tabId, 'type.edit', { layer: ed.layer, box, coalesce: ed.session }, { noPull: true }).catch(() => undefined);
      } else {
        rs.pending = box;
      }
      return;
    }
    if (ed?.dragging) {
      const now = performance.now();
      if (now - typeMoveHitRef.current.last > 60) {
        typeMoveHitRef.current.last = now;
        void runCommand(tabId, 'type.hitTest', { layer: ed.layer, x: dx, y: dy }, { noPull: true })
          .then((h) => {
            const s2 = getSession(tabId);
            const off = (h as { index?: number }).index;
            if (s2?.textEdit?.dragging && typeof off === 'number') {
              updateSession(tabId, { textEdit: { ...s2.textEdit, caret: off } });
              typeBlinkRef.current = performance.now();
              scheduleDraw();
            }
          })
          .catch(() => undefined);
      }
    }
  };

  /** 文字工具抬起(上游 pointer_up):框=拖缩尾沿补发/选字结束/拖框判定→type.create。 */
  const typePointerUp = (s: EditorSession, dx: number, dy: number) => {
    const ed = s.textEdit;
    const rs = typeResizeRef.current;
    if (rs) {
      typeResizeRef.current = null;
      if (rs.pending && ed) {
        void runCommand(tabId, 'type.edit', { layer: ed.layer, box: rs.pending, coalesce: ed.session }).catch(() => undefined);
      }
      return;
    }
    if (ed?.dragging) {
      updateSession(tabId, { textEdit: { ...ed, dragging: false } });
      typeBlinkRef.current = performance.now();
      scheduleDraw();
      return;
    }
    if (typePendingRef.current) {
      typePendingRef.current.down = false; // hitTest 确认回来后收尾(脱靶=点文本)
      return;
    }
    const drag = typeDragRef.current;
    typeDragRef.current = null;
    if (drag) void createTypeText(drag.start, [dx, dy], s.tool === 'typeVertical');
  };

  /** overlay 数据保障(上游 layout 缓存等价):info 文本镜像+caret 钳制+选区/组字边界段。 */
  /** ⇧⌘K/U/B/I/ 字符样式切换(上游 toggle_char_style):选区(空文本=全部)统一翻转,
   * 读回选区起点样式判 on;一条不 coalesce 的独立历史步(与打字会话步分开,逐键撤销)。 */
  const toggleCharStyle = async (key: string) => {
    const s = getSession(tabId);
    const ed = s?.textEdit;
    if (!s || !ed) return;
    const n = charCount(typeTextRef.current);
    const a = Math.min(ed.caret, ed.anchor);
    const b = Math.max(ed.caret, ed.anchor);
    if (!(a < b || n === 0)) return;
    try {
      const info = await runCommand(tabId, 'type.info', { layer: ed.layer }, { noPull: true }) as { runs?: { start: number; end: number; style: CharStyleJson }[] };
      const which = CHAR_TOGGLE_KEYS[key];
      const c = info.runs?.length ? styleAt(info.runs, a < b ? a : 0) : null;
      if (!c) return;
      const on = !which.read(c);
      await runCommand(tabId, 'type.setStyle', { layer: ed.layer, range: a < b ? [a, b] : [0, n], coalesce: ed.session, ...which.write(on) });
      typeBlinkRef.current = performance.now();
    } catch (err) {
      logError('[editor] 字符样式切换失败', err);
    }
  };

  /** overlay 数据保障(上游 layout 缓存等价):info 文本镜像+caret 钳制+选区/组字边界段。 */
  const ensureTypeOverlay = async (ed: TextEditSession) => {
    const info = await fetchTypeInfo(ed.layer);
    if (!info) return;
    typeTextRef.current = info.text;
    const n = charCount(info.text);
    const cur = getSession(tabId);
    if (cur?.textEdit && cur.textEdit.layer === ed.layer && (cur.textEdit.caret > n || cur.textEdit.anchor > n)) {
      updateSession(tabId, { textEdit: { ...cur.textEdit, caret: Math.min(cur.textEdit.caret, n), anchor: Math.min(cur.textEdit.anchor, n) } });
    }
    const a = Math.min(ed.caret, ed.anchor, n);
    const b = Math.max(ed.caret, ed.anchor, n);
    const idxs = new Set<number>([Math.min(ed.caret, n)]);
    for (const ln of info.lines) {
      const sp = lineSelectionSpan(ln, a, b);
      if (sp) {
        idxs.add(sp.span[0]);
        idxs.add(sp.span[1]);
      }
    }
    if (ed.preedit) {
      idxs.add(ed.preedit[0]);
      idxs.add(ed.preedit[0] + ed.preedit[1]);
    }
    await Promise.all([...idxs].map((i) => fetchCaretSeg(ed.layer, i)));
    scheduleDraw();
  };

  // 注册裁剪回调(选项条 ✓/⊘/比例 用)。会话可能在画布挂载后才创建:除挂载时注册外,
  // 订阅回调里每次通知补注册(requestDraw 同款模式),卸载时清掉。
  useEffect(() => {
    const register = (s: EditorSession) => {
      if (s.runtime.cropCommit !== commitCrop) s.runtime.cropCommit = commitCrop;
      if (s.runtime.cropCancel !== cancelCrop) s.runtime.cropCancel = cancelCrop;
      if (s.runtime.cropFitRatio !== cropFitRatio) s.runtime.cropFitRatio = cropFitRatio;
      if (s.runtime.cropSetAngle !== cropSetAngle) s.runtime.cropSetAngle = cropSetAngle;
      if (s.runtime.makeSelection !== makeSelectionFromActivePath) s.runtime.makeSelection = makeSelectionFromActivePath;
      if (s.runtime.commitTextEdit !== commitType) s.runtime.commitTextEdit = commitType;
      if (s.runtime.transformBeginSelection !== beginSelectionTransform) s.runtime.transformBeginSelection = beginSelectionTransform;
      if (s.runtime.transformBeginCopy !== beginTransformCopy) s.runtime.transformBeginCopy = beginTransformCopy;
      if (s.runtime.placeNext !== placeNextEntry) s.runtime.placeNext = placeNextEntry;
      if (s.runtime.transformCommit !== commitTransformBox) s.runtime.transformCommit = commitTransformBox;
      if (s.runtime.transformCancel !== cancelTransformBox) s.runtime.transformCancel = cancelTransformBox;
      if (s.runtime.transformField !== transformField) s.runtime.transformField = transformField;
      if (s.runtime.transformToggleWarp !== toggleWarpBox) s.runtime.transformToggleWarp = toggleWarpBox;
      if (s.runtime.transformResetWarp !== resetWarpBox) s.runtime.transformResetWarp = resetWarpBox;
      if (s.runtime.transformSetWarpGrid !== setWarpGridBox) s.runtime.transformSetWarpGrid = setWarpGridBox;
      if (s.runtime.transformArmWarpSplit !== armWarpSplitBox) s.runtime.transformArmWarpSplit = armWarpSplitBox;
    };
    const s0 = getSession(tabId);
    if (s0) register(s0);
    const un = subscribeSession(tabId, () => {
      const s = getSession(tabId);
      if (!s) return;
      if (s.runtime.requestDraw !== scheduleDraw) s.runtime.requestDraw = scheduleDraw;
      // 自由变换 end_if_left(上游 end_if_left 口径):store 会话被清(提交成功/取消/关闭标签)
      // =清理画布资源(提交落地时 transform 保持到泵上屏由 finishTransformCommit 清);
      // 活动层换了=自动提交;层被删/文档变了=取消。
      if (!s.transform && transformRef.current.session) {
        clearTransform();
      } else if (s.transform && transformRef.current.session && s.state) {
        const t = transformRef.current;
        const tSession = t.session!;
        const layerGone = s.docId !== t.docId || !findLayerById(s.state.layers, tSession.layer);
        if (layerGone) {
          cancelTransform(tabId);
          clearTransform();
          placeNextRef.current(); // Place 队列:层被删/文档变=取消,继续下一条
        } else if (s.state.activeLayer !== tSession.layer && !t.gesture && !s.transformCommitting && !tSession.selection) {
          // 切层=提交(切层命令作用于新层,框必须先落定;落地中跳过);变换选区不随层提交
          // (上游 switched_away:!t.selection,换层保持打开,换工具才提交)
          void commitTransform(tabId);
        }
      }
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
      if (s.runtime.makeSelection === makeSelectionFromActivePath) s.runtime.makeSelection = null;
      if (s.runtime.commitTextEdit === commitType) s.runtime.commitTextEdit = null;
      if (s.runtime.transformBeginSelection === beginSelectionTransform) s.runtime.transformBeginSelection = null;
      if (s.runtime.transformBeginCopy === beginTransformCopy) s.runtime.transformBeginCopy = null;
      if (s.runtime.placeNext === placeNextEntry) s.runtime.placeNext = null;
      if (s.runtime.transformCommit === commitTransformBox) s.runtime.transformCommit = null;
      if (s.runtime.transformCancel === cancelTransformBox) s.runtime.transformCancel = null;
      if (s.runtime.transformField === transformField) s.runtime.transformField = null;
      if (s.runtime.transformToggleWarp === toggleWarpBox) s.runtime.transformToggleWarp = null;
      if (s.runtime.transformResetWarp === resetWarpBox) s.runtime.transformResetWarp = null;
      if (s.runtime.transformSetWarpGrid === setWarpGridBox) s.runtime.transformSetWarpGrid = null;
      if (s.runtime.transformArmWarpSplit === armWarpSplitBox) s.runtime.transformArmWarpSplit = null;
    };
  }, [tabId, commitCrop, cancelCrop, cropFitRatio, cropSetAngle, makeSelectionFromActivePath, commitType, commitTransformBox, cancelTransformBox, transformField, clearTransform, toggleWarpBox, resetWarpBox, setWarpGridBox, armWarpSplitBox, beginSelectionTransform, beginTransformCopy, placeNextEntry]);

  // 文字会话数据保障(上游 layout 缓存 per revision 等价):revision/caret/anchor 变化即拉
  // info+选区/组字边界段,并把隐藏 textarea 钉到 caret 屏幕位(IME 候选窗锚点)
  const ted = session?.textEdit;
  const tedKey = ted && session ? `${session.docId}:${ted.layer}:${ted.caret}:${ted.anchor}:${ted.preedit?.join(',') ?? ''}` : '';
  const tedRev = session?.revision ?? 0;
  useEffect(() => {
    const s = getSession(tabId);
    if (!s?.textEdit || s.docId == null) return;
    const ed = s.textEdit;
    let alive = true;
    void ensureTypeOverlay(ed).then(() => {
      if (!alive) return;
      const s2 = getSession(tabId);
      if (!s2?.textEdit || s2.textEdit.layer !== ed.layer) return;
      void fetchCaretSeg(ed.layer, Math.min(s2.textEdit.caret, charCount(typeTextRef.current))).then((seg) => {
        if (alive) positionTypeInput(seg);
      });
    });
    return () => {
      alive = false;
    };
  }, [tabId, tedKey, tedRev]);

  // caret 闪烁节拍(上游 request_repaint_after 0.530s 等价:会话活跃期间周期重绘)
  const blinkOn = ted ? 1 : 0;
  useEffect(() => {
    if (!blinkOn) return undefined;
    const t = window.setInterval(() => scheduleDraw(), CARET_BLINK_MS);
    return () => window.clearInterval(t);
  }, [blinkOn, scheduleDraw]);

  // 活动层/文档离开编辑会话即提交(上游 end_if_left:另一层/另一文档激活=Photoshop 提交)
  const homeKey = ted && session ? `${session.docId}:${session.state?.activeLayer}:${ted.layer}:${ted.docId}` : '';
  useEffect(() => {
    const s = getSession(tabId);
    if (!s?.textEdit) return;
    if (!typeSessionHome(s)) void commitType();
  }, [tabId, homeKey]);

  // beforeinput 原生监听走 attachTypeInput ref 回调(元素缺席时 effect 空跑问题,见上)
  typeBeforeInputRef.current = (ev: InputEvent) => {
    // 组字文本让位(compositionupdate 接管);其余一律吞掉(文档才是真值)
    if (ev.inputType === 'insertCompositionText') return;
    ev.preventDefault();
    if (ev.inputType === 'insertText' && ev.data) insertTyped(ev.data);
    else if (ev.inputType === 'insertParagraph' || ev.inputType === 'insertLineBreak') void insertTypeText('\n');
  };

  // 注册重绘请求 + 初始适配
  useEffect(() => {
    const s = getSession(tabId);
    if (!s) return;
    s.runtime.requestDraw = scheduleDraw;
    return () => {
      if (s.runtime.requestDraw === scheduleDraw) s.runtime.requestDraw = null;
    };
  }, [tabId, scheduleDraw]);

  // 位图刷新泵:revision/docId/maskView 变化 → 渲染整幅上屏。**完成序、不取消**:循环每轮
  // 重读会话最新 revision,渲染上屏后若 key 又变了就继续下一轮——快速连发命令时渲染永远追
  // 最新、且每个在途渲染都活到上屏。旧实现按 effect 实例取消:提交间隔短于渲染耗时时,每个
  // 在途渲染都在上屏前被下一个 revision 的 cleanup 取消 → 像素全程冻结到指针停住才跳最新
  // (Live 渐变拖动预览"过好一会才变"的根因)。描边提交 fromLive 已局部贴图,key 相同即退出。
  // bitmapBusyRef 跨 effect 实例互斥(StrictMode 双挂载/重订阅也只有一个循环在跑)。
  const docIdForBitmap = session?.docId ?? null;
  const revisionForBitmap = session?.revision ?? -1;
  const stateReady = session?.state != null;
  const docW = session?.state?.width ?? 0;
  const docH = session?.state?.height ?? 0;
  // 蒙版灰度查看(view.layerMask,视图态不推 revision):key 带上它,视图开合/换层都会重拉
  const maskViewKey = session?.state?.layerMaskView ? `${session.state.layerMaskView.layer}:${session.state.layerMaskView.mode}` : '';
  // Select and Mask 对话框字段的值级键:字段变化(开/关/视图/参数)都要重新触发泵
  // (泵内部按完整键决定是否重算;outline 不入键防 notify 循环)
  const selectMaskKey = session?.selectMask?.open
    ? JSON.stringify([
        session.selectMask.viewMode, session.selectMask.viewOpacity, session.selectMask.showEdge,
        session.selectMask.showOriginal, session.selectMask.hideView, session.selectMask.radius,
        session.selectMask.smartRadius, session.selectMask.smooth, session.selectMask.feather,
        session.selectMask.contrast, session.selectMask.shiftEdge, session.selectMask.sampleAllLayers,
        session.selectMask.targetMask,
        session.selectMask.refineStrokes,
      ])
    : '';
  // 交互期降载标记(渲染时刻求值):翻转靠 markInteractiveRender 的 notify 唤醒本 effect,
  // 泵内部每轮再读实时截止时刻(mark 的续期不通知,靠 revision 推进唤醒)
  const interactiveRenderForBitmap = (session?.runtime.interactiveRenderUntil ?? 0) > Date.now();
  const bitmapPump = useCallback(async () => {
    if (bitmapBusyRef.current) return;
    bitmapBusyRef.current = true;
    try {
      for (;;) {
        const s = getSession(tabId);
        if (!s || s.docId == null || !s.state) return;
        // Select and Mask 对话框预览:精修选区 + 视图合成(零文档改动;参数键变化=重算,
        // 循环重读最新字段天然合并在途变化;X 按住=走下方正常渲染分支)
        const sm = s.selectMask;
        if (sm?.open && !sm.hideView) {
          const params: Record<string, unknown> = {
            radius: sm.radius, smartRadius: sm.smartRadius, smooth: sm.smooth, feather: sm.feather,
            contrast: sm.contrast, shiftEdge: sm.shiftEdge, sampleAllLayers: sm.sampleAllLayers,
            ...(sm.refineStrokes.length > 0 ? { refineStrokes: sm.refineStrokes } : {}),
            ...(sm.targetMask ? { target: 'mask' } : {}),
          };
          const op = sm.viewOpacity[sm.viewMode] ?? selectMaskDefaultOpacity(sm.viewMode);
          const key = `sm:${s.docId}:${s.revision}:${sm.viewMode}:${op}:${sm.showEdge}:${sm.showOriginal}:${JSON.stringify(params)}`;
          if (bitmapKeyRef.current === key) return;
          bitmapKeyRef.current = key;
          const bmp = await editorSelectMaskView(
            s.docId,
            { mode: sm.viewMode, opacity: op / 100, showEdge: sm.showEdge, showOriginal: sm.showOriginal },
            params,
          );
          let canvas = s.runtime.offscreen;
          if (!canvas || canvas.width !== bmp.width || canvas.height !== bmp.height) {
            canvas = document.createElement('canvas');
            canvas.width = bmp.width;
            canvas.height = bmp.height;
            s.runtime.offscreen = canvas;
          }
          const ctx = canvas.getContext('2d');
          if (ctx) ctx.putImageData(new ImageData(bmp.rgba, bmp.width, bmp.height), 0, 0);
          s.runtime.rasterScale = s.state.width > 0 ? bmp.width / s.state.width : 1;
          // 精修选区轮廓 → 会话(MarchingAnts 视图蚂蚁线画它;值同则不写防 notify 循环)
          const cur = getSession(tabId)?.selectMask;
          if (cur && JSON.stringify(cur.outline) !== JSON.stringify(bmp.outline)) {
            updateSession(tabId, { selectMask: { ...cur, outline: bmp.outline } });
          }
          scheduleDraw();
          continue;
        }
        const gray = s.state.layerMaskView?.mode === 'gray' ? s.state.layerMaskView.layer : null;
        // 交互期降载:标记未过期时按视口 dpr² 预算出图;过期/结束回全分辨率。
        // rs 入键——同一 revision 在两档预算间切换(过期唤醒/抬手终渲)也要重渲。
        const interactive = s.runtime.interactiveRenderUntil > 0 && Date.now() < s.runtime.interactiveRenderUntil;
        const wrap = wrapRef.current;
        const dpr = window.devicePixelRatio || 1;
        const vpPx = interactive && wrap ? wrap.clientWidth * wrap.clientHeight * dpr * dpr : 0;
        const budget = interactive ? (vpPx > 0 ? Math.min(RASTER_VIEWPORT_BUDGET, Math.max(1_000_000, vpPx)) : RASTER_INTERACTIVE_FALLBACK) : RASTER_PIXEL_BUDGET;
        const docPx = s.state.width * s.state.height;
        const rs = docPx > budget ? Math.sqrt(budget / docPx) : 1;
        const key = `${s.docId}:${s.revision}:${gray != null ? `${gray}:${s.state.layerMaskView?.mode ?? ''}` : ''}:${rs < 1 ? rs.toFixed(4) : '1'}`;
        if (bitmapKeyRef.current === key) return;
        bitmapKeyRef.current = key;
        const maxW = rs < 1 ? Math.round(s.state.width * rs) : undefined;
        const maxH = rs < 1 ? Math.round(s.state.height * rs) : undefined;
        // 灰度查看:位图换蒙版快照(灰度 RGBA,同一 rasterScale 管线);正常:合成渲染
        const bmp = gray != null
          ? await editorMaskSnapshot(s.docId, gray, maxW ?? s.state.width, maxH ?? s.state.height)
          : await editorRender(s.docId, maxW, maxH);
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
        s.runtime.rasterScale = bmp.width / s.state.width;
        if (!fittedRef.current && wrapRef.current && wrapRef.current.clientWidth > 0) {
          s.runtime.view = fitToView(s.state.width, s.state.height, wrapRef.current.clientWidth, wrapRef.current.clientHeight);
          fittedRef.current = true;
        }
        // 自由变换提交落地:新文档已渲染进 offscreen 并上屏,此刻解除抽层保持态——
        // 预览(变换后画面)与正常管线画面一致,无缝切换无闪回(提前解除会闪回原位)。
        if (s.transform && s.transformCommitting) {
          finishTransformCommit(tabId);
          placeNextRef.current(); // Place 队列:上一条已落地,出队下一条(上游 place_next_dropped)
        }
        scheduleDraw();
      }
    } catch (e) {
      console.error('[editor] render failed', e);
      // 提交落地中渲染失败:解除保持态让框关闭(否则卡在抽层预览永不回归正常管线)
      const sc = getSession(tabId);
      if (sc?.transformCommitting) {
        finishTransformCommit(tabId);
        placeNextRef.current();
      }
    } finally {
      bitmapBusyRef.current = false;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, scheduleDraw]);
  useEffect(() => {
    void bitmapPump();
  }, [bitmapPump, docIdForBitmap, revisionForBitmap, stateReady, docW, docH, maskViewKey, selectMaskKey, interactiveRenderForBitmap]);

  // 隐藏编辑 tab 释放位图(多开 N 个编辑 tab = N×96MB 级离屏):切走即归零 backing,
  // 切回重置 key 强制泵重渲(会话状态/历史不动,只重拉一次位图)
  useEffect(() => {
    if (isActive) return;
    const s = getSession(tabId);
    if (!s) return;
    if (s.runtime.offscreen) {
      s.runtime.offscreen.width = 0;
      s.runtime.offscreen.height = 0;
      s.runtime.offscreen = null;
    }
    bitmapKeyRef.current = '';
    // 切走标签:钢笔草稿提交回它所属的文档(runCommand 按 tabId 命中文档,上游 cancel_stale 保草稿口径)
    if (penRef.current) commitPen(false);
  }, [isActive, tabId]);
  useEffect(() => {
    if (!isActive) return;
    bitmapKeyRef.current = '';
    void bitmapPump();
    // 仅在激活沿触发;bitmapPump 引用变化时泵 effect 自己会跑
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

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

  /** 形状数值对话框确定(上游 shape_dialog::confirm:记忆偏好→geometry 校验→shape.create
   * 带选项条 fill/stroke;校验失败提示不入历史)。 */
  const commitShapeDialog = () => {
    const s = getSession(tabId);
    const st = confirmShapeDialog(tabId);
    if (!s || !st || !s.state) return;
    const [geom, err] = shapeDialogGeometry(st.kind, st.at, st);
    if (!geom || err) {
      if (err) showEditorNotice(`形状创建失败:${err}`);
      return;
    }
    const { fill, stroke } = shapeFillStroke(s.options, s.state.foreground, s.state.background);
    void runCommand(tabId, 'shape.create', { ...geom, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}) })
      .catch((e2) => logError('[editor] shape.create 失败', e2));
  };

  // -------------------------------------------------------------------------------------------
  // 直接选择/锚点工具(二期 二-3,上游 direct_select.rs + anchor_tools.rs;目标=work path)
  // -------------------------------------------------------------------------------------------

  /** 钢笔 Auto Add/Delete 的命中目标(上游 anchor_tools::pen_auto 的无修饰键调用方):
   * 草稿在画(非拖拽)=只对草稿(#6140),否则对工作路径;开放子路径端点留给钢笔
   * (首锚=闭合,末锚=断柄)。返回 null=钢笔自己处理(落新锚)。 */
  const penAutoTarget = (s: NonNullable<ReturnType<typeof getSession>>, x: number, y: number, tol: number): { onDraft: boolean; path: EditPath; hit: PathHit } | null => {
    if (penRef.current && !penRef.current.dragging) {
      const path = penToJson(penRef.current, false) as EditPath;
      const hit = peHit(path, [x, y], tol, []);
      if (!hit) return null;
      if (hit.kind === 'anchor') {
        const sp = path.subpaths[hit.knot[0]];
        if (sp && !sp.closed && (hit.knot[1] === 0 || hit.knot[1] + 1 === sp.knots.length)) return null;
      }
      if (hit.kind === 'handle') return null;
      return { onDraft: true, path, hit };
    }
    if (!penRef.current && s.workPath) {
      const hit = peHit(s.workPath, [x, y], tol, []);
      if (!hit) return null;
      if (hit.kind === 'anchor') {
        const sp = s.workPath.subpaths[hit.knot[0]];
        if (sp && !sp.closed && (hit.knot[1] === 0 || hit.knot[1] + 1 === sp.knots.length)) return null;
      }
      if (hit.kind === 'handle') return null;
      return { onDraft: false, path: s.workPath, hit };
    }
    return null;
  };

  /** 执行 Auto Add/Delete(上游 anchor_tools::edit_pen/apply):草稿=几何直改后重建;
   * 工作路径=一条命令一步历史;选中态里锚会移位→重置(上游 apply 同款)。 */
  const applyPenAuto = (auto: { onDraft: boolean; path: EditPath; hit: PathHit }): void => {
    const { hit } = auto;
    if (auto.onDraft && penRef.current) {
      const edited = hit.kind === 'segment'
        ? peAddAnchor(auto.path, hit.knot, hit.t)
        : hit.kind === 'anchor'
          ? peDeleteAnchor(auto.path, hit.knot)
          : null;
      if (edited !== null) {
        penRef.current = penFromJson(auto.path, penRef.current.resumes ?? null);
        updateSession(tabId, { directSel: { target: 'work', anchors: [], segment: null } });
      }
      return;
    }
    if (hit.kind === 'segment') {
      void runCommand(tabId, 'path.addAnchor', { subpath: hit.knot[0], knot: hit.knot[1], t: hit.t, name: 'work' })
        .catch((err) => logError('[editor] path.addAnchor 失败', err));
    } else if (hit.kind === 'anchor') {
      void runCommand(tabId, 'path.deleteAnchor', { subpath: hit.knot[0], knot: hit.knot[1], name: 'work' })
        .catch((err) => logError('[editor] path.deleteAnchor 失败', err));
    } else {
      return;
    }
    const s2 = getSession(tabId);
    if (s2?.directSel.target === 'work') updateSession(tabId, { directSel: { target: 'work', anchors: [], segment: null } });
  };

  /** 直接选择按下(上游 direct_select::press;convert=Pen+⌥/转换点工具;ownTool=转换点
   * 工具未命中也吃掉按下)。返回是否接管。 */
  const dsPress = (x: number, y: number, mods: { shift: boolean; alt: boolean }, convert: boolean, ownTool: boolean): boolean => {
    const s = getSession(tabId);
    if (!s) return false;
    const tol = 6.0 / Math.max(s.runtime.view.scale, 1e-3);
    const base = s.workPath;
    const handles = s.directSel.target === 'work' && base ? peShownHandles(s.directSel, base) : [];
    const found = base ? peHit(base, [x, y], tol, handles) : null;
    if (!found) {
      if (convert) return ownTool;
      dsDragRef.current = { kind: 'marquee', start: [x, y], end: [x, y], add: mods.shift };
      return true;
    }
    if (s.directSel.target !== 'work') updateSession(tabId, { directSel: { target: 'work', anchors: [], segment: null } });
    let edit: DsEdit;
    if (found.kind === 'handle') {
      const kn = base!.subpaths[found.knot[0]].knots[found.knot[1]];
      const from: Pt = found.handle === 'in' ? [...kn.in] as Pt : [...kn.out] as Pt;
      edit = { kind: 'handle', knot: found.knot, handle: found.handle, from, independent: mods.alt || convert };
    } else if (found.kind === 'anchor' && convert) {
      if (ownTool) updateSession(tabId, { directSel: { target: 'work', anchors: [found.knot], segment: null } });
      edit = { kind: 'convert', knot: found.knot };
    } else if (found.kind === 'segment' && convert) {
      // Pen+⌥ 在段上=无事(上游 Hit::Segment if convert => return true)
      return true;
    } else if (found.kind === 'anchor') {
      const ds = getSession(tabId)!.directSel;
      let anchors = [...ds.anchors];
      let noDrag = false;
      if (mods.alt) {
        anchors = peSubpathAnchors(base!, found.knot[0]);
      } else if (mods.shift) {
        const i = anchors.findIndex((a) => a[0] === found.knot[0] && a[1] === found.knot[1]);
        if (i >= 0) anchors.splice(i, 1);
        else anchors.push(found.knot);
        noDrag = i >= 0; // ⇧ 点选取消选中=不拖(上游同)
      } else if (!anchors.some((a) => a[0] === found.knot[0] && a[1] === found.knot[1])) {
        anchors = [found.knot];
      }
      updateSession(tabId, { directSel: { target: 'work', anchors, segment: null } });
      if (noDrag) return true;
      edit = { kind: 'anchors', anchors };
    } else if (found.kind === 'segment' && mods.alt) {
      const anchors = peSubpathAnchors(base!, found.knot[0]);
      updateSession(tabId, { directSel: { target: 'work', anchors, segment: null } });
      edit = { kind: 'anchors', anchors };
    } else {
      updateSession(tabId, { directSel: { target: 'work', anchors: [], segment: found.knot } });
      edit = { kind: 'segment', knot: found.knot, t: found.t };
    }
    dsDragRef.current = { kind: 'edit', edit, base: peClone(base!), start: [x, y], end: [x, y], preview: null };
    return true;
  };

  /** 编辑拖拽的预览(上游 Edit::preview:base 应用同一几何=预览即提交内容)。 */
  const dsPreview = (d: { edit: DsEdit; base: EditPath; start: Pt; end: Pt }): EditPath | null => {
    const p = peClone(d.base);
    const dd: Pt = [d.end[0] - d.start[0], d.end[1] - d.start[1]];
    switch (d.edit.kind) {
      case 'anchors': return peMoveAnchors(p, d.edit.anchors, dd);
      case 'handle': return peMoveHandle(p, d.edit.knot, d.edit.handle, [d.edit.from[0] + dd[0], d.edit.from[1] + dd[1]], d.edit.independent);
      case 'segment': return peBendSegment(p, d.edit.knot, d.edit.t, dd);
      case 'convert': return peConvertPoint(p, d.edit.knot, [d.end[0], d.end[1]]);
    }
  };

  /** 编辑拖拽/点击提交(上游 direct_select::release):位移 ≥1 屏幕px 才提交;Convert 点击
   * (未动)=收回成角点;⇧ 锚点拖拽 45° 锁定。 */
  const dsRelease = (x: number, y: number, shift: boolean, zoom: number): void => {
    const dg = dsDragRef.current;
    if (!dg || dg.kind !== 'edit') return;
    dsDragRef.current = null;
    const end: Pt = dg.edit.kind === 'anchors' && shift ? penShift45(dg.start, [x, y], true) : [x, y];
    const moved = Math.hypot(end[0] - dg.start[0], end[1] - dg.start[1]) * zoom >= 1.0;
    let cmd: string;
    let params: Record<string, unknown>;
    if (dg.edit.kind === 'convert' && !moved) {
      cmd = 'path.convertPoint';
      params = { subpath: dg.edit.knot[0], knot: dg.edit.knot[1] };
    } else if (!moved) {
      return;
    } else {
      const dd: Pt = [end[0] - dg.start[0], end[1] - dg.start[1]];
      switch (dg.edit.kind) {
        case 'anchors':
          cmd = 'path.moveAnchors';
          params = { anchors: dg.edit.anchors, move: dd };
          break;
        case 'handle':
          cmd = 'path.moveHandle';
          params = { subpath: dg.edit.knot[0], knot: dg.edit.knot[1], handle: dg.edit.handle, to: [dg.edit.from[0] + dd[0], dg.edit.from[1] + dd[1]], independent: dg.edit.independent };
          break;
        case 'segment':
          cmd = 'path.bendSegment';
          params = { subpath: dg.edit.knot[0], knot: dg.edit.knot[1], t: dg.edit.t, move: dd };
          break;
        case 'convert':
          cmd = 'path.convertPoint';
          params = { subpath: dg.edit.knot[0], knot: dg.edit.knot[1], out: end };
          break;
      }
    }
    void runCommand(tabId, cmd, { ...params, name: 'work' })
      .catch((err) => logError(`[editor] ${cmd} 失败`, err));
    scheduleDraw();
  };

  /** 框选收尾(上游 direct_select::marquee):首个有锚的路径(work)框内锚;⇧ 累加;
   * 空白点击=取消选择。 */
  const dsMarqueeEnd = (start: Pt, end: Pt, add: boolean): void => {
    const s = getSession(tabId);
    if (!s) return;
    const hits = s.workPath ? peAnchorsIn(s.workPath, [start[0], start[1], end[0], end[1]]) : [];
    const ds = s.directSel;
    if (hits.length && add && ds.target === 'work') {
      const merged = [...ds.anchors];
      for (const a of hits) if (!merged.some((b) => b[0] === a[0] && b[1] === a[1])) merged.push(a);
      updateSession(tabId, { directSel: { target: 'work', anchors: merged, segment: null } });
    } else if (hits.length) {
      updateSession(tabId, { directSel: { target: 'work', anchors: hits, segment: null } });
    } else if (!add) {
      updateSession(tabId, { directSel: { target: 'work', anchors: [], segment: null } });
    }
  };

  // 路径编辑族激活/revision 推进时刷新工作路径(常驻轮廓数据源;上游 draw_overlay 即时读
  // doc.work_path,我们经 path.info 拉取;commit/undo 都推进 revision=天然覆盖)。
  // 路径面板摘要则任何工具下都刷新——选项条「建立选区」/Ctrl+Enter/路径页签都吃它,
  // 刷新不能只挂在路径页签挂载期(否则其他页签下永远陈旧,按钮恒灰)。
  // 矢量蒙版被定向(channel.target=vectorMask)时拉活动层蒙版路径(path.info "layer"
  // 回落到活动层蒙版),画布轮廓/钢笔追加/路径选择拖移共用。
  useEffect(() => {
    const s = getSession(tabId);
    if (!s || s.docId == null) return;
    if (PATH_TOOLS.has(s.tool)) void refreshWorkPath(tabId);
    void refreshPathsList(tabId);
    const maskTargeted = s.state?.channels?.target?.kind === 'vectorMask';
    if (!maskTargeted) {
      if (s.vectorMaskPath != null) updateSession(tabId, { vectorMaskPath: null });
      return;
    }
    const docId = s.docId;
    void editorRun(docId, 'path.info', { name: 'layer' })
      .then((r) => {
        const s2 = getSession(tabId);
        if (!s2 || s2.docId !== docId) return;
        const path = (r.result as { path?: WorkPathJson } | null)?.path ?? null;
        if (s2.vectorMaskPath !== path) updateSession(tabId, { vectorMaskPath: path });
      })
      .catch(() => {
        const s2 = getSession(tabId);
        if (s2 && s2.vectorMaskPath != null) updateSession(tabId, { vectorMaskPath: null });
      });
  }, [tabId, session?.tool, session?.docId, session?.revision, session?.state?.channels?.target?.kind]);

  // 键盘:空格临时抓手、[/] 笔径、工具单键、选区/颜色命令键
  useEffect(() => {
    if (!isActive) return undefined;
    const isTyping = (t: EventTarget | null) =>
      t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement;
    const down = (e: KeyboardEvent) => {
      const s = getSession(tabId);
      if (!s) return;
      if (e.code === 'Space' && !s.textEdit) {
        // 文字会话中空格=键入空格(上游 Event::Text " "),不做平移
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
      // Alt 按住态:Select and Mask 边刷光标的 +/- 形态随键即时切换
      if (e.key === 'Alt') {
        altRef.current = true;
        // 钢笔拖拽中按 Alt=断开手柄对,此后只有 out 跟指针(上游 pen_break_handle,#3306)
        if (penRef.current?.dragging && !penRef.current.adjustingLast) penBreakHandle(penRef.current);
        scheduleDraw();
        return;
      }
      // 自由变换框(上游 shortcuts.rs:Enter=commit、Esc=cancel;Ctrl+Z/Y 劫持到框快照而非
      // 文档;方向键微移 1px/Shift 10px)。覆盖一切工具/对话框分支(变换是覆盖模式)。
      if (s.transform && transformRef.current.session) {
        if (s.transformCommitting) {
          // 提交落地中(等位图泵):吞掉一切键,框不可再操作
          e.preventDefault();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          cancelTransformBox();
          return;
        }
        if (e.key === 'Enter' && !e.ctrlKey && !e.metaKey && !isTyping(e.target)) {
          e.preventDefault();
          commitTransformBox();
          return;
        }
        if (e.ctrlKey || e.metaKey) {
          // 框打开期间 Ctrl 组合全部吞掉:Ctrl+Z/Y 步进框快照,其余防文档命令乱入(上游 is_enabled 口径)
          e.preventDefault();
          if (e.code === 'KeyZ' || e.code === 'KeyY') {
            if (e.code === 'KeyY' || e.shiftKey) transformRedo();
            else transformUndo();
          }
          return;
        }
        if (!isTyping(e.target) && !transformRef.current.session?.warp) {
          // Warp 模式下方向键不微移(上游 filter warp.is_none 口径)
          const step = e.shiftKey ? 10 : 1;
          if (e.key === 'ArrowLeft') { e.preventDefault(); nudgeTransformBox(-step, 0); return; }
          if (e.key === 'ArrowRight') { e.preventDefault(); nudgeTransformBox(step, 0); return; }
          if (e.key === 'ArrowUp') { e.preventDefault(); nudgeTransformBox(0, -step); return; }
          if (e.key === 'ArrowDown') { e.preventDefault(); nudgeTransformBox(0, step); return; }
        }
        return; // 其余键(含工具单键)吞掉——切工具走 setTool 自动提交,不经键盘
      }
      // Ctrl/Cmd+T = 进入自由变换(上游 edit.freeTransform;打字中=先提交再进框,
      // 上游 begin 先 type_tool::commit)。非输入框聚焦时才接管。
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.code === 'KeyT' && !isTyping(e.target)) {
        e.preventDefault(); // 浏览器新标签页快捷键,必须拦
        void beginTransform();
        return;
      }
      // Ctrl/Cmd+Alt+T = 自由变换副本(上游 edit.freeTransformCopy ⌥⌘T:复制层/选中像素
      // 后进框,提交折叠一步;Alt+Ctrl 组合有被系统软件抢占的风险,见 Ctrl+Alt+R 教训)
      if ((e.ctrlKey || e.metaKey) && e.altKey && !e.shiftKey && e.code === 'KeyT' && !isTyping(e.target)) {
        e.preventDefault();
        void beginTransformCopy();
        return;
      }
      // Ctrl/Cmd+Shift+T = 再次变换(上游 edit.transform.again:引擎从 journal 找最近的
      // edit.transform 参数重放到当前层新 bounds;无历史报错进提示条)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.code === 'KeyT' && !isTyping(e.target)) {
        e.preventDefault(); // 浏览器重开标签页快捷键,必须拦
        void runCommand(tabId, 'edit.transform.again', {}).catch((err) =>
          showEditorNotice(`无法重复变换:${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      // Ctrl/Cmd+Shift+Alt+T = 再次变换副本(上游 edit.transform.againCopy ⌥⇧⌘T:复制+重放,
      // 引擎内 purge_last+标签 "Transform Again",连按一次一步)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.altKey && e.code === 'KeyT' && !isTyping(e.target)) {
        e.preventDefault();
        void runCommand(tabId, 'edit.transform.againCopy', {}).catch((err) =>
          showEditorNotice(`无法重复变换:${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      // 导出为对话框打开期间接管键盘:Esc 取消(输入框中也生效)/Enter 确定(非输入)/其余吞掉
      if (s.exportDialog) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeExportDialog(tabId, false);
        } else if (e.key === 'Enter' && !isTyping(e.target)) {
          e.preventDefault();
          void confirmExportDialog(tabId);
        }
        return;
      }
      // 形状数值对话框:Enter 确定(非输入框中)/Esc 取消;其余键放行给输入框
      if (s.shapeDialog) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closeShapeDialog(tabId);
        } else if (e.key === 'Enter' && !isTyping(e.target)) {
          e.preventDefault();
          commitShapeDialog();
        }
        return;
      }
      // 路径面板对话框(描边路径/建立选区):Enter 确定(非输入框中)/Esc 取消;其余放行
      if (s.pathsDialog) {
        if (e.key === 'Escape') {
          e.preventDefault();
          closePathsDialog(tabId);
        } else if (e.key === 'Enter' && !isTyping(e.target)) {
          e.preventDefault();
          void confirmPathsDialog(tabId);
        }
        return;
      }
      // 钢笔草稿:Enter/Esc=提交并保留开放路径(上游 shortcuts.rs #1769,Esc 非丢弃);
      // Ctrl/Cmd+Enter 不在此提交——落到下方「当前路径载入选区」(先提交再选,上游 #306)
      if (s.tool === 'pen' && penRef.current && (e.key === 'Enter' || e.key === 'Escape') && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        commitPen(false);
        return;
      }
      // 文字编辑会话键盘(上游 handle_keys):会话活跃时单键工具快捷键必须让位;
      // 但焦点在面板输入控件(字号/下拉等,isTyping 且非隐藏 textarea)时同样让位——
      // 上游 egui_wants_keyboard_input 口径,否则 Ctrl+A/Enter 被吃成文字操作。
      if (isTyping(e.target) && e.target !== typeInputRef.current) return;
      // IME 组字中(keyCode 229/isComposing)不拦——组合文本走 textarea composition 事件。
      if (s.textEdit && TYPE_TOOLS.has(s.tool)) {
        const ed = s.textEdit;
        if (e.isComposing) return;
        const n = charCount(typeTextRef.current);
        const a = Math.min(ed.caret, ed.anchor, n);
        const b = Math.max(ed.caret, ed.anchor, n);
        const setTo = (to: number, extend: boolean) => {
          const s2 = getSession(tabId);
          if (!s2?.textEdit) return;
          updateSession(tabId, { textEdit: { ...s2.textEdit, caret: Math.min(to, n), anchor: extend ? s2.textEdit.anchor : Math.min(to, n) } });
          typeBlinkRef.current = performance.now();
          scheduleDraw();
        };
        const nav = (index: number, move: string, x?: number) =>
          runCommand(tabId, 'type.navigate', { layer: ed.layer, index, move, ...(x != null ? { x } : {}) }, { noPull: true }) as Promise<{ index?: number }>;
        if (e.ctrlKey || e.metaKey) {
          const code = e.code;
          // ⇧⌘K/U/B/I/:字符样式切换作用于选中字符(折叠 caret 非空文本不动=上游 format_range;
          // 开关态=选区起点样式,一条不 coalesce 的独立历史步,上游 toggle_char_style 口径)
          if (e.shiftKey && !e.altKey) {
            const kk = code === 'KeyK' ? 'k' : code === 'KeyU' ? 'u' : code === 'KeyB' ? 'b' : code === 'KeyI' ? 'i' : e.key === '/' ? '/' : null;
            if (kk && CHAR_TOGGLE_KEYS[kk]) {
              e.preventDefault();
              void toggleCharStyle(kk);
              return;
            }
          }
          if (code === 'KeyA') {
            // ⌘A 全选(上游 Key::A if m.command)
            e.preventDefault();
            updateSession(tabId, { textEdit: { ...ed, anchor: 0, caret: n } });
            typeBlinkRef.current = performance.now();
            scheduleDraw();
            return;
          }
          if (code === 'KeyZ' || code === 'KeyY') {
            // ⌘Z/⌘⇧Z/⌘Y 透传文档 undo/redo(上游 _ if m.command → handled=false);
            // undo 缩文后 caret 由 info 刷新钳制
            e.preventDefault();
            const redo = code === 'KeyY' || e.shiftKey;
            if (redo ? s.state?.canRedo : s.state?.canUndo) void runCommand(tabId, redo ? 'edit.redo' : 'edit.undo', {}).catch(console.error);
            return;
          }
          if (e.key === 'Enter') {
            // ⌘Enter 提交(上游 Key::Enter if m.command → commit_with)
            e.preventDefault();
            void commitType();
            return;
          }
          return; // 其余 Ctrl 组合同输入框口径不进工具
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          void insertTypeText('\n');
          return;
        }
        if (e.key === 'Escape') {
          // 偏好「Esc 提交」默认开(上游 use_esc_to_commit 默认 true)
          e.preventDefault();
          void commitType();
          return;
        }
        if (e.key === 'Tab' && !e.shiftKey) {
          // Tab 键入制表符(上游 Key::Tab → insert "\t")
          e.preventDefault();
          void insertTypeText('\t');
          return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
          e.preventDefault();
          if (a !== b) {
            void insertTypeText('');
            return;
          }
          const fwd = e.key === 'Delete';
          if (!fwd && e.ctrlKey) {
            // Ctrl+退格=删到行首(上游 (false,_,true)→line_edge start)
            void nav(a, 'lineStart').then((r) => {
              const s2 = getSession(tabId);
              if (s2?.textEdit && typeof r.index === 'number' && r.index !== s2.textEdit.caret) {
                updateSession(tabId, { textEdit: { ...s2.textEdit, anchor: r.index, caret: s2.textEdit.caret } });
                void insertTypeText('');
              }
            }).catch(() => undefined);
            return;
          }
          // Alt=词边界(上游 word_boundary);裸=±1
          const to = fwd
            ? (e.altKey ? wordBoundary(typeTextRef.current, a, true) : Math.min(a + 1, n))
            : (e.altKey ? wordBoundary(typeTextRef.current, a, false) : Math.max(a - 1, 0));
          if (to !== a) {
            updateSession(tabId, { textEdit: { ...ed, anchor: to, caret: a } });
            void insertTypeText('');
          }
          return;
        }
        if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
          // 竖排字流映射(上游 flow_key)后走横排同义分支;词/行导航=type.navigate 查询
          e.preventDefault();
          const fk = flowKey(e.key, s.tool === 'typeVertical');
          const cur = ed.caret;
          if (fk === 'ArrowLeft' || fk === 'ArrowRight') {
            const fwd = fk === 'ArrowRight';
            if (e.ctrlKey || e.metaKey || e.altKey) {
              void nav(cur, fwd ? 'wordNext' : 'wordPrev').then((r) => {
                if (typeof r.index === 'number') setTo(r.index, e.shiftKey);
              }).catch(() => undefined);
            } else if (a !== b && !e.shiftKey) {
              setTo(fwd ? b : a, false);
            } else {
              setTo(fwd ? cur + 1 : cur - 1, e.shiftKey);
            }
            return;
          }
          if (fk === 'ArrowUp' || fk === 'ArrowDown') {
            if (e.ctrlKey || e.metaKey) {
              setTo(fk === 'ArrowUp' ? 0 : n, e.shiftKey);
            } else {
              // 行步进保持列位:先取 caret 段的文档 x(上游 column 的 doc_x)
              void fetchCaretSeg(ed.layer, Math.min(cur, n)).then((seg) => {
                const x = seg ? seg[0][0] : undefined;
                return nav(Math.min(cur, n), fk === 'ArrowUp' ? 'linePrev' : 'lineNext', x);
              }).then((r) => {
                if (typeof r.index === 'number') setTo(r.index, e.shiftKey);
              }).catch(() => undefined);
            }
            return;
          }
          void nav(Math.min(cur, n), e.key === 'End' ? 'lineEnd' : 'lineStart').then((r) => {
            if (typeof r.index === 'number') setTo(r.index, e.shiftKey);
          }).catch(() => undefined);
          return;
        }
        // 其余单键不拦:textarea beforeinput 接文字(insertTyped),工具快捷键被 isTyping 让位
        return;
      }
      if (isTyping(e.target)) return;
      // Ctrl+Enter(上游 Cmd+Enter,#306):当前路径载入选区(钢笔草稿在画先提交)
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        void makeSelectionFromActivePath();
        return;
      }
      // 导出为入口(Ctrl+Alt+Shift+W,上游 Cmd+Alt+Shift+W 口径)
      if (e.code === 'KeyW' && e.ctrlKey && e.shiftKey && e.altKey) {
        e.preventDefault();
        openExportDialog(tabId);
        return;
      }
      // Select and Mask 入口(Ctrl+Alt+R,上游 Cmd+Alt+R):有选区或活动层有蒙版才可用
      if (e.code === 'KeyR' && e.ctrlKey && e.altKey) {
        e.preventDefault();
        // 打不开(无选区无蒙版)给提示;成功=对话框弹出已是显眼反馈。
        // 注意:键被系统热键抢占时这里根本收不到,选项条按钮是无快捷键依赖的入口
        if (!openSelectMask(tabId)) showEditorNotice('选择并遮住:需要先有选区,或活动层带蒙版');
        return;
      }
      // 对话框打开期间接管视图键(输入框聚焦让位):F 循环/O M V A T K Y 直选/J P 切换/
      // X 按住看原图/Enter=确定/Esc=取消(上游 select_mask_view::keys + dialogs)
      if (s.selectMask?.open) {
        const sm = s.selectMask;
        const key = e.key.toLowerCase();
        if (e.code === 'KeyX') {
          updateSelectMask(tabId, { hideView: true });
          return;
        }
        if (key === 'enter') {
          e.preventDefault();
          confirmSelectMask(tabId);
          return;
        }
        if (key === 'escape') {
          e.preventDefault();
          closeSelectMask(tabId, false);
          return;
        }
        if (key === 'f') {
          e.preventDefault();
          const i = SELECT_MASK_MODES.indexOf(sm.viewMode);
          updateSelectMask(tabId, { viewMode: SELECT_MASK_MODES[(i + 1) % SELECT_MASK_MODES.length] as SelectMaskMode });
          return;
        }
        const modeKey: Record<string, SelectMaskMode> = { o: 'onionSkin', m: 'marchingAnts', v: 'overlay', a: 'onBlack', t: 'onWhite', k: 'blackWhite', y: 'onLayers' };
        if (modeKey[key]) {
          e.preventDefault();
          updateSelectMask(tabId, { viewMode: modeKey[key] });
          return;
        }
        if (key === 'j') {
          e.preventDefault();
          updateSelectMask(tabId, { showEdge: !sm.showEdge });
          return;
        }
        if (key === 'p') {
          e.preventDefault();
          updateSelectMask(tabId, { showOriginal: !sm.showOriginal });
          return;
        }
        // R:边刷开关(提示条反馈生效态——唯一可见变化是小复选框+光标,不加提示难感知);
        // [ ] 调边刷直径(上游 apply_key:×0.9/×1.1 且至少 ±1,钳 1..1000;
        // 中文 IME 下 e.key 是全角【】,按 e.code 兜底——与画笔笔径键同款口径)
        if (key === 'r') {
          e.preventDefault();
          updateSelectMask(tabId, { brush: !sm.brush });
          showEditorNotice(sm.brush ? '边刷已关闭' : '边刷已开启:在画布上涂抹 · Alt 反向 · [ ] 调直径');
          return;
        }
        if (e.key === '[' || e.key === ']' || e.code === 'BracketLeft' || e.code === 'BracketRight') {
          e.preventDefault();
          const dir = e.key === ']' || e.code === 'BracketRight' ? 1 : -1;
          const size = sm.brushSize;
          const next = dir > 0 ? Math.max(size * 1.1, size + 1) : Math.min(size * 0.9, size - 1);
          updateSelectMask(tabId, { brushSize: Math.round(Math.min(1000, Math.max(1, next))) });
          return;
        }
        return; // 其余键不进工具(对话框模态)
      }
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
      if (s.tool === 'crop' && cropRef.current && !cropDragRef.current
        && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
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
      if (s.tool === 'directSelect' && s.directSel.anchors.length > 0 && !dsDragRef.current
        && ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
        // 直接选择箭头微移(上游 arrow_keys #4486):选中锚 1px(⇧10px),每按一步=一条
        // path.moveAnchors 命令=一步历史
        e.preventDefault();
        const dist = e.shiftKey ? 10 : 1;
        const ddx = e.key === 'ArrowLeft' ? -dist : e.key === 'ArrowRight' ? dist : 0;
        const ddy = e.key === 'ArrowUp' ? -dist : e.key === 'ArrowDown' ? dist : 0;
        void runCommand(tabId, 'path.moveAnchors', { anchors: s.directSel.anchors, move: [ddx, ddy], name: 'work' })
          .catch((err) => logError('[editor] 锚点微移失败', err));
        return;
      }
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
        if (s.tool === 'pen' && penRef.current) {
          // 钢笔草稿:⌫=退上一锚(上游 pen_undo_last_point;空=草稿取消)
          penRef.current = penUndoLastPoint(penRef.current);
          scheduleDraw();
          return;
        }
        if ((s.tool === 'pen' || s.tool === 'pathSelect') && !penRef.current && s.workPath && s.state) {
          // ⌫ 删工作路径(上游 delete_key_deletes_work_path #5702):钢笔/路径选择+无草稿+
          // 目标是工作路径(活动形状层挡在前面时不删——target_path 优先级)
          const active = findLayerTree(s.state.layers, s.state.activeLayer);
          if (active?.kind !== 'Shape') {
            void runCommand(tabId, 'path.delete', { name: 'work' }).catch((err) => logError('[editor] path.delete 失败', err));
            return;
          }
        }
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
          // 钢笔草稿逐点回退(上游 pen_undo_last_point):草稿锚是编辑器态非文档历史,
          // Ctrl+Z 优先吃掉;草稿不存在才落到文档 undo(重做不拦=上游同)
          if (s.tool === 'pen' && penRef.current && !e.shiftKey) {
            penRef.current = penUndoLastPoint(penRef.current);
            scheduleDraw();
            return;
          }
          // 框专属 undo(上游 #3145):裁剪工具+框栈非空时 Ctrl+Z/Redo 步进框快照而非文档;
          // 任一栈非空即拦截两向(空向吃掉按键=上游变灰语义),两栈全空才回落文档历史
          const hist = cropHistoryRef.current;
          if (s.tool === 'crop' && (hist.undo.length > 0 || hist.redo.length > 0)) {
            const redo = e.shiftKey;
            const stack = redo ? hist.redo : hist.undo;
            if (stack.length > 0 && cropRef.current) {
              const cur = { rect: cropRef.current.rect, angle: cropRef.current.angle, edited: cropRef.current.edited };
              const step = stack.pop()!;
              (redo ? hist.undo : hist.redo).push(cur);
              cropRef.current = { rect: step.rect, angle: step.angle, edited: step.edited };
              if (s.cropAngle !== cropRef.current.angle) updateSession(tabId, { cropAngle: cropRef.current.angle });
              scheduleDraw();
            }
            return;
          }
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
          // 外部新图→画布居中);Ctrl+Shift+V = 原位粘贴;Ctrl+Alt+Shift+V = 贴入选区内
          // (上游 pasteInto,Cmd+Alt+Shift+V 口径;贴入选区外走图层右键菜单,上游无快捷键)
          e.preventDefault();
          if (e.shiftKey && e.altKey) {
            if (!s.state?.hasSelection) {
              showEditorNotice('贴入选区内:需要先建一个选区');
            } else {
              void runCommand(tabId, 'edit.pasteSpecial.pasteInto', {})
                .catch((err) => logError('[editor] 贴入选区内失败', err));
            }
          } else {
            void runCommand(tabId, e.shiftKey ? 'edit.pasteSpecial.pasteInPlace' : 'edit.paste', {})
              .catch((err) => logError('[editor] 粘贴失败', err));
          }
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
        // W×H×分辨率模式:X=交换 W 与 H(上游 swap 口径);其余工具=交换前/背景色
        if (s.tool === 'crop' && isWhrKey(s.options.cropRatio)) {
          setOptions(tabId, { cropWidth: s.options.cropHeight, cropHeight: s.options.cropWidth });
          s.runtime.cropFitRatio?.();
          return;
        }
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
      } else if (k === 'g') {
        // G 键渐变组循环:渐变 ⇄ 油漆桶(上游 Tool::Gradient|PaintBucket 同键 'G' 口径)
        setTool(tabId, nextGradientTool(getSession(tabId)?.tool));
      } else if (k === 'u') {
        // U 键形状组循环:矩形→椭圆→三角形→多边形→直线(上游 Tool 组同键 'U' 口径)
        setTool(tabId, nextShapeTool(getSession(tabId)?.tool));
      } else if (k === 'p') {
        // P 键钢笔组循环:钢笔→添加锚点→删除锚点→转换点(上游 Tool P 组同键口径)
        setTool(tabId, nextPenTool(getSession(tabId)?.tool));
      } else if (k === 'a') {
        // A 键路径组循环:路径选择↔直接选择(上游 Tool::PathSelection|DirectSelection 同键)
        setTool(tabId, nextPathTool(getSession(tabId)?.tool));
      } else if (k === 't') {
        // T 键文字组循环:横排↔竖排(上游 Tool::Type|VerticalType 同键)
        setTool(tabId, nextTypeTool(getSession(tabId)?.tool));
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
      if (e.key === 'Alt') {
        altRef.current = false;
        scheduleDraw();
      }
      // X 松开:Select and Mask 视图恢复(按住=临时看原图)
      if (e.code === 'KeyX') {
        const s = getSession(tabId);
        if (s?.selectMask?.open && s.selectMask.hideView) updateSelectMask(tabId, { hideView: false });
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

  /**
   * Live 渐变预览提交(80ms 节流 + 在途背压 + noPull):一次只放一条命令在途,期间调用
   * 只记录尾沿回调,回包后补发最新状态——管线自 pace,命令/渲染队列不积压(积压时
   * 像素滞后滚雪球到秒级)。noPull 跳过状态快照(面板不需要逐帧跟,释放的最终提交
   * 不带 noPull 补拉一次)。onSent 在命令真正发出时执行(节流时间戳/curIdx 推进)。
   */
  const gradPreviewSend = (cmd: string, params: Record<string, unknown>, onSent?: () => void) => {
    const fire = () => {
      // 长拖续期:预览每发都把降载截止时刻往后推(拖动超过首按的 1200ms 仍是视口预算)
      markInteractiveRender(tabId, 1200);
      gradGestureRef.current.lastSent = performance.now();
      gradInflightRef.current.busy = true;
      onSent?.();
      void runCommand(tabId, cmd, { ...params, coalesce: `gradient-live-drag:${gradGestureRef.current.seq}` }, { noPull: true })
        .catch((err) => logError(`[editor] ${cmd} 失败`, err))
        .finally(() => {
          gradInflightRef.current.busy = false;
          const p = gradInflightRef.current.pending;
          gradInflightRef.current.pending = null;
          p?.();
        });
    };
    if (gradInflightRef.current.busy) gradInflightRef.current.pending = fire;
    else fire();
  };

  /** 双击色标/端点开取色卡(上游 edit_stop_color:端点=该端的那颗色标,反向折算)。 */
  const openStopColorPicker = (layer: number, at: number | 'start' | 'end', cx: number, cy: number) => {
    const fill = liveFillRef.current;
    if (!fill || fill.layer !== layer || !fill.stops.length) return;
    let index: number;
    if (at === 'start') index = fill.reverse ? fill.stops.length - 1 : 0;
    else if (at === 'end') index = fill.reverse ? 0 : fill.stops.length - 1;
    else index = Math.min(at, fill.stops.length - 1);
    const hex = fill.stops[index][1];
    const q = (i: number) => Number.parseInt(hex.replace('#', '').slice(i * 2, i * 2 + 2) || '00', 16) / 255;
    setStopPicker({ layer, index, rgb: [q(0), q(1), q(2)], x: cx, y: cy });
  };

  /** 取色卡确定:一条 gradient.fill.stop color 命令(6 位 hex,上游同款=该标 alpha 归 1)。 */
  const commitStopColor = () => {
    const sp = stopPicker;
    if (!sp) return;
    const hex = `#${sp.rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
    void runCommand(tabId, 'gradient.fill.stop', { layer: sp.layer, action: 'color', index: sp.index, color: hex })
      .catch((err) => logError('[editor] gradient.fill.stop 失败', err));
    setStopPicker(null);
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
    // Select and Mask 对话框模态:工具交互全部让位(缩放/平移仍可用);
    // 边刷开时左键=涂抹笔划起点(Alt 涂另一模式,上游 canvas_brush)
    if (s.selectMask?.open) {
      if (s.selectMask.brush && e.button === 0 && s.state) {
        smStrokeRef.current = true;
        const rect = wrapRef.current!.getBoundingClientRect();
        const [dx, dy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
        s.runtime.pointerDoc = { x: dx, y: dy };
        paintSelectMaskStroke(tabId, [dx, dy], true, e.altKey);
        scheduleDraw();
      }
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
    // 自由变换(二-8,上游 transform_tool::pointer Down):手势接管全部工具分支。
    // Alt+点击框内/外=参考点移到点击处再拖动(上游 1455 口径);框外按下总是记录
    // (单击=提交的判定在抬起,拖拽=旋转;Distort 模式框外拖拽惯性,上游同口径)。
    if (transformRef.current.session && e.button === 0) {
      const t = transformRef.current;
      if (s.transformCommitting) return; // 提交落地中(等位图泵):吞掉按下,框不可再操作
      const tSession = t.session!;
      if (tSession.warp) {
        // 文字层 Warp Text:画布无可拖/无分割(上游 warp_pointer 对 warps_type 直接 return)
        if (t.kind === 'Type') {
          scheduleDraw();
          return;
        }
        // Warp 模式按下(上游 warp_pointer Down):武装分割/Ctrl+Alt=快捷分割抬起落线;
        // 否则抓控制点(命中才把预设物化成 custom,#5750),再否则拖面片表面;网格外=不抓。
        const warp = tSession.warp;
        const mesh = warpToMesh(warp, 1, 1);
        const armed = t.warpSplit?.tool ?? null;
        if (armed || e.ctrlKey || e.metaKey || e.altKey) {
          t.warpSplit = { tool: armed, placing: true, quick: !armed, pointer: [dx, dy] };
        } else {
          const tol = handleTolerance(s.runtime.view.scale);
          const idx = warpHit(mesh, [dx, dy], tol);
          const surf = idx == null ? surfaceAt(mesh, [dx, dy]) : null;
          if (idx != null || surf != null) {
            if (warp.style !== 'custom') t.session = { ...tSession, warp: warpCustom(mesh, warp.bounds) };
            const pts0 = (t.session!.warp!.mesh as WarpMesh).points.map((p) => [...p] as WPt);
            t.warpDrag = idx != null
              ? { kind: 'point', index: idx, start: [dx, dy], pts0 }
              : { kind: 'surface', s: surf![0], t: surf![1], start: [dx, dy], pts0 };
          }
        }
        scheduleDraw();
        return;
      }
      const tol = handleTolerance(s.runtime.view.scale);
      let hit = hitTest(tSession, [dx, dy], tol);
      if (e.altKey && (hit.kind === 'inside' || hit.kind === 'outside')) {
        t.session = { ...tSession, pivot: [dx, dy] };
        syncTransformProjection(tabId, t.session);
        hit = { kind: 'pivot' };
      }
      if (modeAllows(tSession.mode, hit) || hit.kind === 'outside') {
        t.gesture = { hit, start: [dx, dy], quad0: tSession.quad, pivot0: tSession.pivot };
      }
      scheduleDraw();
      return;
    }
    // 文字工具(二-6,上游 pointer_down 分发):会话中=把手/落 caret/框外提交;
    // 空白/既有字层=拖框/编辑。整个手势消费掉,不再落画笔/形状分支。
    if (TYPE_TOOLS.has(s.tool) && e.button === 0 && s.state) {
      void typePointerDown(s, dx, dy, e);
      return;
    }
    if (BRUSH_TOOLS.has(s.tool) && e.button === 0 && s.state) {
      // 一笔进行中时忽略再次按下(鼠标不会出现;触屏多指防把进行中描边的 live 顶掉)
      if (!strokeRef.current) beginStroke(s, s.tool as BrushFamilyTool, dx, dy, e.shiftKey);
    } else if (s.tool === 'move' && e.button === 0 && s.state) {
      // Move 双击编辑文字层(上游 edit_at,#1132):命中文字=选中并进文字工具编辑,
      // 提交后回到移动工具;未命中=普通双击(无视)
      if (e.detail >= 2) {
        void (async () => {
          try {
            const h = await runCommand(tabId, 'type.hitTest', { x: dx, y: dy }, { noPull: true }) as { layer?: number; index?: number };
            if (typeof h.layer !== 'number' || getSession(tabId)?.textEdit) return;
            await runCommand(tabId, 'layer.select', { layer: h.layer });
            if (getSession(tabId)?.textEdit) return;
            beginTypeEdit(h.layer, typeof h.index === 'number' ? h.index : 0, 1, [dx, dy], 'move');
            setTool(tabId, 'type');
          } catch {
            /* 无文字层在指针下 */
          }
        })();
        return;
      }
      moveSeqRef.current += 1;
      moveHoverRef.current = null; // 拖拽开始=悬停高亮消失(上游 pressed 分支)
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
          const w0 = magneticPressureWidth(s.options.magneticWidth, e.pressure, e.pointerType === 'pen', s.options.magneticPressure);
          void editorMagneticSnap(s.docId, [dx, dy] as [number, number], w0, s.options.magneticContrast)
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
        // 拉直也是一次框手势(上游 straighten Down 同记 press_step)
        const fc = cropRef.current;
        cropHistoryRef.current.press = fc ? { rect: fc.rect, angle: fc.angle, edited: fc.edited } : { rect: [0, 0, s.state.width, s.state.height], angle: 0, edited: false };
        scheduleDraw();
        return;
      }
      ensureCropFrame(s);
      const f = cropRef.current!;
      const restore: CropRestore = { rect: f.rect, angle: f.angle, edited: f.edited };
      // 框专属 undo:按下时快照(上游 press_step),松手且框变化时入栈
      cropHistoryRef.current.press = { ...restore };
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
        // 框外:绕框中心旋转(⇧ 15° 吸附);拖拽中系统光标隐藏,自绘弧线
        const cx = (f.rect[0] + f.rect[2]) / 2;
        const cy = (f.rect[1] + f.rect[3]) / 2;
        cropDragRef.current = { kind: 'rotate', center: [cx, cy], grab: Math.atan2(dy - cy, dx - cx), from: f.angle, restore };
        if (cropCursorRef.current !== 'none') {
          cropCursorRef.current = 'none';
          forceUpdate((n) => n + 1);
        }
      }
      scheduleDraw();
    } else if (s.tool === 'gradient' && e.button === 0 && s.state) {
      // hold(上一次抬笔的保持态)在此清除:命中测试与「未命中=拖新线」都以它为起点
      if (liveGradRef.current?.kind === 'hold') liveGradRef.current = null;
      const fill = liveFillRef.current;
      const active = s.state.activeLayer;
      const sel = fill && fill.layer === active && s.state.layers.find((l) => l.id === active)?.visible !== false ? fill : null;
      // Live 渐变(上游 live_mode):非经典模式即 Live;蒙版目标例外——选中渐变填充图层
      // 仍 Live(编辑它的填充,上游同款),否则经典涂蒙版
      if (!s.options.gradientClassic && (!isMaskTarget(s.state) || sel)) {
        // Live 渐变(上游 gradient_ui::pointer):命中选中渐变图层的手柄/色标/中点/线=编辑它;
        // 未命中=拖出新线——已有选中渐变图层时重画它的 from/to,否则新建图层
        // 手势序号每次按下都递增:coalesce 键一次手势一个,连续手势不得并入上一步
        gradGestureRef.current.seq += 1;
        gradGestureRef.current.lastSent = 0;
        // Live 渐变拖动进交互期降载(预览 ~80ms/发,视口预算出图);抬手 mark(0) 回全分辨率
        markInteractiveRender(tabId, 1200);
        if (sel) {
          const hit = gradientLiveHit(sel.from, sel.to, sel.stops, sel.midpoints, sel.reverse, [dx, dy], 8 / Math.max(s.runtime.view.scale, 1e-3));
          if (hit?.kind === 'end' || hit?.kind === 'start') {
            liveGradRef.current = { kind: 'edit', layer: sel.layer, which: hit.kind, orig: { from: sel.from, to: sel.to }, grab: [dx, dy], grabT: 0, from: sel.from, to: sel.to, moved: false };
          } else if (hit?.kind === 'line') {
            liveGradRef.current = { kind: 'edit', layer: sel.layer, which: 'line', orig: { from: sel.from, to: sel.to }, grab: [dx, dy], grabT: hit.t, from: sel.from, to: sel.to, moved: false };
          } else if (hit?.kind === 'stop') {
            liveGradRef.current = {
              kind: 'stop', layer: sel.layer, from: sel.from, to: sel.to, reverse: sel.reverse,
              stops: sel.stops.map((q) => [...q] as [number, string]), mids: [...sel.midpoints],
              origIndex: hit.index, curIdx: hit.index, t: sel.stops[hit.index][0], tornOff: false, moved: false, down: [dx, dy],
            };
          } else if (hit?.kind === 'mid') {
            liveGradRef.current = {
              kind: 'mid', layer: sel.layer, from: sel.from, to: sel.to, reverse: sel.reverse,
              stops: sel.stops.map((q) => [...q] as [number, string]), mids: [...sel.midpoints],
              seg: hit.index, a: sel.stops[hit.index][0], b: sel.stops[hit.index + 1]?.[0] ?? 1,
              value: sel.midpoints[hit.index] ?? 0.5, moved: false, down: [dx, dy],
            };
          }
        }
        if (!liveGradRef.current) {
          liveGradRef.current = { kind: 'draw', from: [dx, dy], to: [dx, dy], mods: initialMods(e.shiftKey, e.altKey), redraw: sel ? sel.layer : null, moved: false };
        }
      } else {
        // 经典渐变:拖方向线(Shift 吸附 45°;松手 ≥2px 才发命令)
        gradientRef.current = { x0: dx, y0: dy, x1: dx, y1: dy, mods: initialMods(e.shiftKey, e.altKey) };
      }
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
    } else if (SHAPE_GROUP.has(s.tool) && e.button === 0 && s.state) {
      // 形状族(上游 shape 工具):记起点拖拽;直线点击无对话框=无操作,其余点击松手开数值对话框
      shapeDragRef.current = { tool: s.tool, sx: dx, sy: dy, ex: dx, ey: dy, maxDev: 0 };
      scheduleDraw();
    } else if (s.tool === 'pen' && e.button === 0 && s.state) {
      // 钢笔(上游 canvas.rs 派发序):Auto Add/Delete → ⌘ 直接选择 → ⌥ 转换点 → 落锚
      const tol = 6.0 / Math.max(s.runtime.view.scale, 1e-3);
      const mods = { shift: e.shiftKey, alt: e.altKey };
      if (!mods.shift && !mods.alt && !e.ctrlKey && !e.metaKey && s.options.penAutoAddDelete) {
        const auto = penAutoTarget(s, dx, dy, tol);
        if (auto) {
          applyPenAuto(auto);
          scheduleDraw();
          return;
        }
      }
      // ⌘/Ctrl=直接选择(草稿在画时的草稿直编=S6 后置;无草稿=编辑工作路径)
      if ((e.ctrlKey || e.metaKey) && !penRef.current) {
        dsPress(dx, dy, mods, false, false);
        scheduleDraw();
        return;
      }
      // Pen+⌥(无草稿)=转换点:锚上=角点/拖出平滑手柄;未命中=落新锚(上游 converting)
      if (mods.alt && !penRef.current) {
        if (dsPress(dx, dy, mods, true, false)) {
          scheduleDraw();
          return;
        }
      }
      // Alt 按在末锚手柄上=抓单柄;否则加锚/闭合替身/断末锚
      if (e.altKey && penRef.current && penGrabHandle(penRef.current, dx, dy, tol)) {
        scheduleDraw();
        return;
      }
      // 续画(上游 pen_down 的 resume_at,#6593):无草稿时按到开放子路径端点=接着画
      if ((!penRef.current || penRef.current.knots.length === 0) && !mods.shift && !mods.alt && !e.ctrlKey && !e.metaKey) {
        const resumed = tryResumePen(s, dx, dy, tol);
        if (resumed) {
          penRef.current = resumed;
          scheduleDraw();
          return;
        }
      }
      penRef.current = penDown(penRef.current, dx, dy, e.shiftKey, tol);
      scheduleDraw();
    } else if (s.tool === 'directSelect' && e.button === 0 && s.state) {
      dsPress(dx, dy, { shift: e.shiftKey, alt: e.altKey }, false, false);
      scheduleDraw();
    } else if (s.tool === 'pathSelect' && e.button === 0 && s.state && s.docId != null) {
      // 路径选择(上游 canvas.rs 按下分发=pick_shape_at):①layer.pickAt 像素快路径;
      // ②未中→几何拾取兜底(细描边/容差内,上游 pick_shape_at 口径):自上而下逐形状层
      // shape.info 拉路径,首个命中即选。代次防探测回来前已抬起。
      const tol = 6.0 / Math.max(s.runtime.view.scale, 1e-3);
      const seq = ++psSeqRef.current;
      const at: [number, number] = [dx, dy];
      void (async () => {
        try {
          const r = await runCommand(tabId, 'layer.pickAt', { x: dx, y: dy, select: false }, { noPull: true });
          const picked = (r as { layer?: number | null } | null)?.layer ?? null;
          const s2 = getSession(tabId);
          if (!s2 || psSeqRef.current !== seq) return;
          if (picked != null && findLayerTree(s2.state?.layers ?? [], picked)?.kind === 'Shape') {
            void runCommand(tabId, 'layer.select', { layer: picked }).catch(() => undefined);
            return;
          }
          // 几何兜底:收集形状层(树序=自上而下),逐层 shape.info 后命中测试
          const shapeIds: number[] = [];
          const collect = (ls: EditorLayer[]): void => {
            for (const l of ls) {
              if (l.visible && l.kind === 'Shape') shapeIds.push(l.id);
              if (l.children) collect(l.children);
            }
          };
          if (s2.state) collect(s2.state.layers);
          for (const id of shapeIds) {
            const info = await editorRun(s2.docId!, 'shape.info', { layer: id });
            const s3 = getSession(tabId);
            if (!s3 || psSeqRef.current !== seq) return;
            const inf = info.result as { path?: EditPath; fill?: unknown; live?: { kind?: string; rect?: [number, number, number, number] } | null } | null;
            if (!inf?.path) continue;
            const hit = pickShapeAt([{ id, path: inf.path, fill: inf.fill != null, live: inf.live ?? null }], at, tol);
            if (hit != null) {
              void runCommand(tabId, 'layer.select', { layer: hit }).catch(() => undefined);
              return;
            }
          }
        } catch {
          // 拾取失败=当作未命中(不选层,拖拽仍可移目标路径)
        }
      })();
      psDragRef.current = { sx: dx, sy: dy };
      scheduleDraw();
    } else if ((s.tool === 'addAnchor' || s.tool === 'deleteAnchor' || s.tool === 'convertPoint') && e.button === 0 && s.state) {
      // 锚点工具(上游 anchor_tools::click/convert):⌘=直接选择;⌥ 换加/删;转换点未命中=吃掉按下
      const mods = { shift: e.shiftKey, alt: e.altKey };
      if (e.ctrlKey || e.metaKey) {
        dsPress(dx, dy, mods, false, false);
        scheduleDraw();
        return;
      }
      const tol = 6.0 / Math.max(s.runtime.view.scale, 1e-3);
      if (s.tool === 'convertPoint') {
        dsPress(dx, dy, mods, true, true);
        scheduleDraw();
        return;
      }
      // add/delete:命中各自目标才动(段=加/锚=删,⌥ 互换=未命中时无事)
      const effective: 'addAnchor' | 'deleteAnchor' = s.tool === 'addAnchor' ? (mods.alt ? 'deleteAnchor' : 'addAnchor') : mods.alt ? 'addAnchor' : 'deleteAnchor';
      if (s.workPath) {
        const hit = peHit(s.workPath, [dx, dy], tol, []);
        const ok = hit && (effective === 'addAnchor' ? hit.kind === 'segment' : hit.kind === 'anchor');
        if (ok && hit.kind === 'segment') {
          void runCommand(tabId, 'path.addAnchor', { subpath: hit.knot[0], knot: hit.knot[1], t: hit.t, name: 'work' })
            .catch((err) => logError('[editor] path.addAnchor 失败', err));
          if (s.directSel.target === 'work') updateSession(tabId, { directSel: { target: 'work', anchors: [], segment: null } });
        } else if (ok && hit.kind === 'anchor') {
          void runCommand(tabId, 'path.deleteAnchor', { subpath: hit.knot[0], knot: hit.knot[1], name: 'work' })
            .catch((err) => logError('[editor] path.deleteAnchor 失败', err));
          if (s.directSel.target === 'work') updateSession(tabId, { directSel: { target: 'work', anchors: [], segment: null } });
        }
      }
      scheduleDraw();
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
    // 自由变换(上游 transform_tool::pointer Move/Up 共段):手势快照重算 quad/pivot
    // (修饰键中途按下/松开即时生效);无手势=hover 光标。框读数同步刷新。
    if (transformRef.current.session) {
      const t = transformRef.current;
      const tSession = t.session!;
      // 变换会话接管画布:移动工具悬停高亮失效(可能冻着 place 窗口期的旧 bounds)
      if (moveHoverRef.current) moveHoverRef.current = null;
      if (tSession.warp) {
        // 文字层 Warp Text:无 hover(光标恒 default,上游同)
        if (t.kind === 'Type') return;
        // Warp 模式 move(上游 warp_pointer Move):拖拽每次从按下快照 pts0 重算(非累积);
        // 分割导引跟随指针;无拖拽=控制点 hover(光标/柄显隐)。
        const warp = tSession.warp;
        if (t.warpSplit?.placing) {
          t.warpSplit.pointer = [dx, dy];
          scheduleDraw();
          return;
        }
        if (t.warpDrag) {
          const mesh = warp.mesh; // 抓到才物化,拖拽中恒存在
          const g = t.warpDrag;
          if (mesh) {
            if (g.kind === 'point') meshDragPoint(mesh, g.pts0, g.index, [dx - g.start[0], dy - g.start[1]]);
            else meshPull(mesh, g.pts0, g.s, g.t, [dx - g.start[0], dy - g.start[1]]);
          }
          scheduleDraw();
          return;
        }
        const mesh = warpToMesh(warp, 1, 1);
        const h = warpHit(mesh, [dx, dy], handleTolerance(s.runtime.view.scale));
        if (h !== t.warpHover) {
          t.warpHover = h;
          scheduleDraw();
          forceUpdate((n) => n + 1); // 光标形态经 React 渲染
        }
        return;
      }
      if (t.gesture) {
        const g = t.gesture;
        const mods: TransformMods = { shift: e.shiftKey, alt: e.altKey, command: e.ctrlKey || e.metaKey };
        // 类型层只接受仿射(上游 distort_refused:Distort/Perspective 降级普通缩放)
        const distortRefused = t.kind === 'Type';
        const effMods = distortRefused && g.hit.kind === 'corner' ? { ...mods, command: false } : mods;
        const mode = distortRefused && (tSession.mode === 'distort' || tSession.mode === 'perspective') ? 'free' : tSession.mode;
        const next = applyModeDrag({ quad: tSession.quad, pivot: tSession.pivot, mode }, g, [dx, dy], t.kind === 'Type', effMods);
        t.session = { ...tSession, quad: next.quad, pivot: next.pivot };
        // 读数:旋转=角度;缩放=W/H%;平移=ΔX,ΔY(上游 draw_live_readout 口径)
        if (g.hit.kind === 'outside') {
          const a0 = Math.atan2(g.start[1] - g.pivot0[1], g.start[0] - g.pivot0[0]);
          const a1 = Math.atan2(dy - g.pivot0[1], dx - g.pivot0[0]);
          let deg = ((a1 - a0) * 180) / Math.PI;
          deg = ((deg % 360) + 360) % 360;
          t.readout = `${deg.toFixed(1)}°`;
        } else if (g.hit.kind === 'corner' || g.hit.kind === 'edge') {
          const r = transformReadout(t.session!);
          t.readout = `W ${r.wPct.toFixed(1)}% H ${r.hPct.toFixed(1)}%`;
        } else {
          t.readout = `Δ ${Math.round(next.quad[0][0] - g.quad0[0][0])}, ${Math.round(next.quad[0][1] - g.quad0[0][1])} px`;
        }
        scheduleDraw();
        return;
      }
      const tol = handleTolerance(s.runtime.view.scale);
      const h = hitTest(tSession, [dx, dy], tol);
      if (JSON.stringify(h) !== JSON.stringify(t.hover)) {
        t.hover = h;
        scheduleDraw();
        forceUpdate((n) => n + 1); // 光标形态经 React 渲染(与 cropCursorRef 同款)
      }
      return;
    }
    // 文字工具(二-6,上游 pointer_move):段落框把手拖缩(节流)/拖拽选字 caret(节流)。
    if (TYPE_TOOLS.has(s.tool) && (typeResizeRef.current || s.textEdit?.dragging)) {
      typePointerMove(s, dx, dy, e.altKey);
      scheduleDraw();
      return;
    }
    // Select and Mask 边刷:按住拖动连续涂抹(Alt 即时反向;近点由纯函数按 max(size/8,1)
    // 点距过滤=零通知,跨过阈值才 updateSelectMask→泵重算预览)
    if (s.selectMask?.open) {
      if (smStrokeRef.current && (e.buttons & 1) !== 0) {
        paintSelectMaskStroke(tabId, [dx, dy], false, e.altKey);
      }
      scheduleDraw();
      return;
    }
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
    // 移动工具悬停高亮(上游 move_hover::target):Auto-Select 与 Ctrl 相异=高亮点击将
    // 拾取的层/组(同点击 pick 测试);有选区+活动层像素层=会移动选区像素,不高亮;
    // 按住任何键(拖拽中)不高亮。缓存键=doc:rev:像素:组,resting 指针零开销。
    if (s.tool === 'move' && s.state && !e.buttons) {
      const active = s.state.layers.find((l) => l.id === s.state?.activeLayer);
      const movesPixels = s.state.hasSelection && active?.kind === 'Pixel';
      if (s.options.moveAutoSelect !== e.ctrlKey && !movesPixels) {
        fetchMoveHover(dx, dy, s.options.moveTarget === 'group');
      } else if (moveHoverRef.current) {
        moveHoverRef.current = null;
        scheduleDraw();
      }
    } else if (s.tool !== 'move' && moveHoverRef.current) {
      moveHoverRef.current = null;
      scheduleDraw();
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
      magneticFollow({ x: dx, y: dy, pressure: e.pressure, pen: e.pointerType === 'pen' }, true);
      return;
    }
    const cd = cropDragRef.current;
    if (cd) {
      const f = cropRef.current!;
      const preset = cropPresetRatioOf(s.options.cropRatio, s.options, s.state.width, s.state.height, s.state.resolution || 72);
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
    const sd = shapeDragRef.current;
    if (sd) {
      // 形状族拖拽:实时更新终点+累计最大位移(is_click 判定用),修饰键=实时状态(上游 d.live)
      sd.ex = dx;
      sd.ey = dy;
      sd.maxDev = Math.max(sd.maxDev, Math.hypot(dx - sd.sx, dy - sd.sy));
      scheduleDraw();
      return;
    }
    if (DS_TOOLS.has(s.tool)) {
      // 直接选择族:编辑拖拽预览/框选跟随;纯悬停也要重绘(高亮随指针,上游即时模式)
      const dg = dsDragRef.current;
      if (dg?.kind === 'edit') {
        const end: Pt = dg.edit.kind === 'anchors' && e.shiftKey ? penShift45(dg.start, [dx, dy], true) : [dx, dy];
        dg.end = end;
        dg.preview = dsPreview({ edit: dg.edit, base: dg.base, start: dg.start, end });
        scheduleDraw();
        return;
      }
      if (dg?.kind === 'marquee') {
        dg.end = [dx, dy];
        scheduleDraw();
        return;
      }
      scheduleDraw();
      return;
    }
    if (s.tool === 'pen') {
      // 钢笔拖拽:拉出末锚手柄(⇧ 实时 45°,上游 pen_move 读实时修饰键);
      // 纯悬停也要重绘(橡皮带/闭合提示跟指针,上游即时模式每帧画,我们靠指针驱动重绘)
      if (penRef.current?.dragging) penMove(penRef.current, dx, dy, e.shiftKey);
      scheduleDraw();
      return;
    }
    // 裁剪悬停光标:把手=对应缩放箭头,已编辑框内部=move,其余 crosshair
    if (s.tool === 'crop' && cropRef.current && cropDragRef.current === null) {
      const f = cropRef.current;
      const hit = cropHitTurned(f.rect, f.angle, [dx, dy], CROP_HANDLE_PX / s.runtime.view.scale);
      // 框外=旋转区:系统光标隐藏,自绘双头弧线(上游 CursorIcon::None + draw_turn_cursor)
      const cur = hit.kind === 'handle'
        ? hit.hx !== 0 && hit.hy !== 0 ? (hit.hx * hit.hy > 0 ? 'nwse-resize' : 'nesw-resize') : hit.hx !== 0 ? 'ew-resize' : 'ns-resize'
        : hit.kind === 'inside' && f.edited ? 'move'
          : hit.kind === 'outside' ? 'none' : 'crosshair';
      if (cropCursorRef.current !== cur) {
        cropCursorRef.current = cur;
        forceUpdate((n) => n + 1);
      }
    }
    const lg = liveGradRef.current;
    if (lg) {
      if (lg.kind === 'draw') {
        lg.mods = trackMods(lg.mods, e.shiftKey, e.altKey);
        lg.to = lg.mods.liveShift ? snap45(lg.from, [dx, dy]) : [dx, dy];
        if (Math.abs(lg.to[0] - lg.from[0]) + Math.abs(lg.to[1] - lg.from[1]) >= 2) lg.moved = true;
        // 重画选中图层:节流 SET(coalesce)=实时预览;新图层还没有实体,无法命令预览
        if (lg.moved && lg.redraw != null && performance.now() - gradGestureRef.current.lastSent >= 80) {
          gradPreviewSend('gradient.fill.set', { layer: lg.redraw, from: [Math.round(lg.from[0]), Math.round(lg.from[1])], to: [Math.round(lg.to[0]), Math.round(lg.to[1])] });
        }
      } else if (lg.kind === 'stop') {
        if (Math.abs(dx - lg.down[0]) + Math.abs(dy - lg.down[1]) >= 2) lg.moved = true;
        // 上游 drag_to Grab::Stop:沿线投影得渐变位置;离线 >36 屏幕 px 且 >2 个色标=撕离
        // (释放才提交删除,拖回线内自动恢复移动);移动节流提交(coalesce 合一步历史)=实时预览
        const c = gradientStopDragParams(lg.from, lg.to, lg.reverse, [dx, dy], Math.max(s.runtime.view.scale, 1e-3), lg.stops.map((q) => q[0]), lg.origIndex, lg.curIdx);
        if (lg.moved && c) {
          if (c.action === 'delete') {
            lg.tornOff = true;
          } else {
            lg.tornOff = false;
            lg.t = c.location ?? lg.t;
            if (performance.now() - gradGestureRef.current.lastSent >= 80) {
              // 被拖色标会跨位重排:引擎按当前排序下标寻址,发出后按新位置重算(onSent 时机=真正发出)
              const locs = lg.stops.map((q) => q[0]);
              const t = lg.t;
              gradPreviewSend('gradient.fill.stop', { layer: lg.layer, action: 'move', index: lg.curIdx, location: t }, () => {
                lg.curIdx = gradientStopIndexAfter(locs, lg.origIndex, t);
              });
            }
          }
        }
      } else if (lg.kind === 'mid') {
        if (Math.abs(dx - lg.down[0]) + Math.abs(dy - lg.down[1]) >= 2) lg.moved = true;
        const c = gradientMidDragParams(lg.from, lg.to, lg.reverse, [dx, dy], lg.seg, lg.a, lg.b);
        if (lg.moved && c) {
          lg.value = c.location;
          if (performance.now() - gradGestureRef.current.lastSent >= 80) {
            gradPreviewSend('gradient.fill.stop', { layer: lg.layer, action: 'midpoint', index: lg.seg, location: lg.value });
          }
        }
      } else if (lg.kind === 'edit') {
        if (Math.abs(dx - lg.grab[0]) + Math.abs(dy - lg.grab[1]) >= 2) lg.moved = true;
        if (lg.which === 'line') {
          // 整线平移:按下的原始起止 + 当前指针相对抓点的总位移
          lg.from = [lg.orig.from[0] + (dx - lg.grab[0]), lg.orig.from[1] + (dy - lg.grab[1])];
          lg.to = [lg.orig.to[0] + (dx - lg.grab[0]), lg.orig.to[1] + (dy - lg.grab[1])];
        } else if (lg.which === 'start') {
          // 拖起点:提交被拖端,锚是固定的另一端(⇧ 吸附到锚的 45° 射线,上游同款)
          lg.from = e.shiftKey ? snap45(lg.orig.to, [dx, dy]) : [dx, dy];
        } else {
          lg.to = e.shiftKey ? snap45(lg.orig.from, [dx, dy]) : [dx, dy];
        }
        // 手柄/整线拖动:节流 SET(coalesce)=实时预览(引擎每帧从 from/to 重推角度/缩放)
        if (lg.moved && performance.now() - gradGestureRef.current.lastSent >= 80) {
          gradPreviewSend('gradient.fill.set', { layer: lg.layer, from: [Math.round(lg.from[0]), Math.round(lg.from[1])], to: [Math.round(lg.to[0]), Math.round(lg.to[1])] });
        }
      }
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
    smStrokeRef.current = false;
    // 交互期降载在此收口(渐变拖动等画布交互;滑杆类在各自 flushNow):mark(0) 的
    // notify 唤醒泵,随后的终提交 revision 推进即以全分辨率出图
    markInteractiveRender(tabId, 0);
    // Warp 模式抬起(上游 warp_pointer Up):分割落线(quick 抬起时判 kind);拖拽落定推栈。
    if (s && transformRef.current.session?.warp && (transformRef.current.warpSplit?.placing || transformRef.current.warpDrag)) {
      const t = transformRef.current;
      const tSession = t.session!;
      const rect = wrapRef.current?.getBoundingClientRect();
      const [ux, uy] = rect ? screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top) : [0, 0];
      if (t.warpSplit?.placing) {
        const sp = t.warpSplit;
        t.warpSplit = null;
        setTransformSplit(tabId, null);
        const mesh = warpToMesh(tSession.warp!, 1, 1);
        const kind = sp.quick ? quickSplitKind(mesh, tSession.warp!.bounds, ...meshParamAt(mesh, [ux, uy])) : sp.tool;
        const nw = kind ? splitWarp(tSession.warp!, [ux, uy], kind) : null;
        if (nw) {
          transformField((v) => ({ ...v, warp: nw }));
          t.warpDrag = null;
          t.warpHover = null;
        }
      } else if (t.warpDrag) {
        t.warpDrag = null;
        settleTransformStep();
        if (t.session) syncTransformProjection(tabId, t.session);
        scheduleWarpStillRender(); // 静止后高密度重渲一次(拖拽中低密度帧预算)
      }
      scheduleDraw();
      return;
    }
    // 自由变换抬起(上游 pointer Up):落定推栈+回写投影;框外单击=提交(#2851);
    // Pointercancel 兜底同款(手势快照重算,无"半途状态"要回收)。
    if (s && transformRef.current.session && transformRef.current.gesture) {
      const t = transformRef.current;
      const g = t.gesture!;
      t.gesture = null;
      t.readout = null;
      const rect = wrapRef.current?.getBoundingClientRect();
      const [dx, dy] = rect ? screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top) : g.start;
      if (acceptsOutsideClick(g, [dx, dy], handleTolerance(s.runtime.view.scale))) {
        void commitTransform(tabId); // store 置 null → 订阅清理 ref
        return;
      }
      settleTransformStep();
      if (t.session) syncTransformProjection(tabId, t.session);
      scheduleDraw();
      return;
    }
    // 文字工具抬起(二-6,上游 pointer_up):拖缩尾沿补发/选字结束/拖框判定→type.create
    if (s && TYPE_TOOLS.has(s.tool) && s.state) {
      const rect = wrapRef.current!.getBoundingClientRect();
      const [dx, dy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
      typePointerUp(s, dx, dy);
      return;
    }
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
    const lg = liveGradRef.current;
    if (s && lg && s.state && lg.kind !== 'hold') {
      const gradKey = `gradient-live-drag:${gradGestureRef.current.seq}`;
      // 终提交:清掉尾沿挂起(否则它会晚于终提交落地,把旧状态写回去);在途预览的发送序
      // 在终提交之前,引擎按到达序执行=终态正确。终提交不带 noPull(补拉一次状态给面板)。
      gradInflightRef.current.pending = null;
      const rev0 = s.revision;
      // hold:overlay 继续画本地终态,直到 refetch(revision 前进后触发)落地才交还,
      // 防"松手闪回旧位再跳回来"(直接清手势会回退到过期的 liveFillRef)
      const base = liveFillRef.current;
      const holdToken = {};
      const setHold = (fill: GradientFillInfo) => {
        liveGradRef.current = { kind: 'hold', fill, rev0, token: holdToken };
        if (gradHoldTimerRef.current != null) window.clearTimeout(gradHoldTimerRef.current);
        gradHoldTimerRef.current = window.setTimeout(() => {
          gradHoldTimerRef.current = null;
          if (liveGradRef.current && 'token' in liveGradRef.current && liveGradRef.current.token === holdToken) {
            liveGradRef.current = null;
            scheduleDraw();
          }
        }, 1000);
      };
      // 上游 gradient_ui::finish/click:Draw <2px 无操作;重画=SET from/to 一步;新建=create
      // (引擎自动插到活动层上方并选中);Edit moved=SET 一步;无拖动点击=线上加色标/
      // 双击色标或端点开取色;Stop/Mid moved=最终 stop 命令(节流发的已 coalesce 成同一步)
      if (lg.kind === 'draw' && lg.moved) {
        if (lg.redraw != null) {
          // 重画:节流 SET 已 coalesce 到本手势,最终一条同键合并成一步
          void runCommand(tabId, 'gradient.fill.set', { layer: lg.redraw, from: [Math.round(lg.from[0]), Math.round(lg.from[1])], to: [Math.round(lg.to[0]), Math.round(lg.to[1])], coalesce: gradKey })
            .catch((err) => logError('[editor] gradient.fill.set 失败', err));
          if (base && base.layer === lg.redraw) setHold({ ...base, from: [Math.round(lg.from[0]), Math.round(lg.from[1])], to: [Math.round(lg.to[0]), Math.round(lg.to[1])] });
        } else {
          void runCommand(tabId, 'gradient.fill.create', gradientLiveCreateParams(lg.from, lg.to, s.options))
            .catch((err) => logError('[editor] gradient.fill.create 失败', err));
        }
      } else if (lg.kind === 'edit' && lg.moved) {
        void runCommand(tabId, 'gradient.fill.set', { layer: lg.layer, from: [Math.round(lg.from[0]), Math.round(lg.from[1])], to: [Math.round(lg.to[0]), Math.round(lg.to[1])], coalesce: gradKey })
          .catch((err) => logError('[editor] gradient.fill.set 失败', err));
        if (base && base.layer === lg.layer) setHold({ ...base, from: [Math.round(lg.from[0]), Math.round(lg.from[1])], to: [Math.round(lg.to[0]), Math.round(lg.to[1])] });
      } else if (lg.kind === 'edit' && !lg.moved) {
        // 无拖动点击:线上加色标(位置=按下时折算的渐变位置);双击色标/端点=取色
        if (lg.which === 'line') {
          void runCommand(tabId, 'gradient.fill.stop', { layer: lg.layer, action: 'add', location: lg.grabT })
            .catch((err) => logError('[editor] gradient.fill.stop 失败', err));
        } else {
          const key = lg.which;
          const now = performance.now();
          const dbl = gradLastClickRef.current?.key === key && now - gradLastClickRef.current.time <= 450;
          gradLastClickRef.current = { key, time: now };
          if (dbl) {
            gradLastClickRef.current = null;
            openStopColorPicker(lg.layer, lg.which, e.clientX, e.clientY);
          }
        }
      } else if (lg.kind === 'stop') {
        if (lg.moved && lg.tornOff) {
          // 撕离删除释放才提交(拖动中只藏标记;与节流的 move 同 coalesce 键=同一历史步)
          void runCommand(tabId, 'gradient.fill.stop', { layer: lg.layer, action: 'delete', index: lg.curIdx, coalesce: gradKey })
            .catch((err) => logError('[editor] gradient.fill.stop 失败', err));
          if (base && base.layer === lg.layer) {
            // 剩余色标按原序保留;每个色标拥有其后段的 mid 值,末位的丢弃(引擎 unpair 口径)
            const rest = lg.stops.filter((_, i) => i !== lg.origIndex);
            const owned = lg.stops.map((_, i) => lg.mids[i] ?? 0.5).filter((_, i) => i !== lg.origIndex).slice(0, -1);
            setHold({ ...base, stops: rest, midpoints: owned });
          }
        } else if (lg.moved) {
          // 最终移动:节流发的最后一发可能已过期,补一条确定值(同键合并)
          void runCommand(tabId, 'gradient.fill.stop', { layer: lg.layer, action: 'move', index: lg.curIdx, location: lg.t, coalesce: gradKey })
            .catch((err) => logError('[editor] gradient.fill.stop 失败', err));
          if (base && base.layer === lg.layer) setHold({ ...base, stops: lg.stops.map((q, i) => (i === lg.origIndex ? [lg.t, q[1]] : q)), midpoints: lg.mids });
        } else {
          // 单击色标:仅记录双击判定(上游 click 只处理 Line 与双击取色)
          const key = `stop:${lg.origIndex}`;
          const now = performance.now();
          const dbl = gradLastClickRef.current?.key === key && now - gradLastClickRef.current.time <= 450;
          gradLastClickRef.current = dbl ? null : { key, time: now };
          if (dbl) openStopColorPicker(lg.layer, lg.origIndex, e.clientX, e.clientY);
        }
      } else if (lg.kind === 'mid' && lg.moved) {
        void runCommand(tabId, 'gradient.fill.stop', { layer: lg.layer, action: 'midpoint', index: lg.seg, location: lg.value, coalesce: gradKey })
          .catch((err) => logError('[editor] gradient.fill.stop 失败', err));
        if (base && base.layer === lg.layer) setHold({ ...base, stops: lg.stops, midpoints: lg.mids.map((m, i) => (i === lg.seg ? lg.value : m)) });
      }
      if (liveGradRef.current?.kind !== 'hold') liveGradRef.current = null;
      scheduleDraw();
    } else {
      liveGradRef.current = null;
    }
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
    const sd = shapeDragRef.current;
    shapeDragRef.current = null;
    if (s && sd && s.state) {
      const zoom = s.runtime.view.scale;
      const geom = shapeGeometry(s.options, sd.tool, [sd.sx, sd.sy], [sd.ex, sd.ey], e.shiftKey, e.altKey);
      if (isShapeClick(sd.maxDev, zoom)) {
        // 点击=数值创建对话框(上游 shape_dialog::open;直线无对话框=无操作)
        openShapeDialog(tabId, sd.tool, [Math.round(sd.sx), Math.round(sd.sy)]);
        forceUpdate((n) => n + 1);
      } else if (geom) {
        // 拖拽=按选项条 fill/stroke 直接创建(上游 finish_shape→create_shape)
        const { fill, stroke } = shapeFillStroke(s.options, s.state.foreground, s.state.background);
        void runCommand(tabId, 'shape.create', { ...geom, ...(fill ? { fill } : {}), ...(stroke ? { stroke } : {}) })
          .catch((err) => logError('[editor] shape.create 失败', err));
      }
      scheduleDraw();
    }
    if (s && penRef.current?.dragging) {
      // 钢笔抬笔:闭合拖拽(松手抖动内替身手柄收回)→ 提交闭合;否则继续画(上游 pen_up)
      const jitter = 2.0 / Math.max(s.runtime.view.scale, 1e-3);
      const r = penUp(penRef.current, jitter);
      if (r.closed) commitPen(true);
      scheduleDraw();
    }
    if (s && dsDragRef.current) {
      // 直接选择抬笔:编辑拖拽=一条命令一步历史(位移≥1 屏幕px);框选=选锚
      const rect = wrapRef.current!.getBoundingClientRect();
      const [ux, uy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
      const dg = dsDragRef.current;
      if (dg.kind === 'edit') {
        dsRelease(ux, uy, e.shiftKey, s.runtime.view.scale);
      } else {
        dsDragRef.current = null;
        dsMarqueeEnd(dg.start, [ux, uy], dg.add);
        scheduleDraw();
      }
    }
    const ps = psDragRef.current;
    psDragRef.current = null;
    if (s && ps && s.state) {
      // 路径选择抬笔(上游 path_selection_finish):点击(<0.5px)=按下已拾取,无事;
      // 拖拽=目标路径整体移动(活动形状层→shape.edit move;否则工作路径→path.set 平移)。
      // 矢量蒙版目标=二-5b(需先有蒙版目标入口)。
      const rect = wrapRef.current!.getBoundingClientRect();
      const [ux, uy] = screenToDoc(s.runtime.view, e.clientX - rect.left, e.clientY - rect.top);
      const dx = ux - ps.sx;
      const dy = uy - ps.sy;
      if (Math.abs(dx) + Math.abs(dy) >= 0.5) {
        const rx = Math.round(dx);
        const ry = Math.round(dy);
        // 目标路径优先级(上游 target_path):定向矢量蒙版→活动形状层→工作路径
        const maskLayer = targetedVectorMaskLayer(s);
        if (maskLayer != null) {
          void (async () => {
            try {
              const r = await runCommand(tabId, 'path.info', { name: 'layer' }, { noPull: true });
              const cur = (r as { path?: EnginePathJson } | null)?.path;
              if (!cur) return;
              const moved = peTranslate(cur as unknown as EditPath, [rx, ry]) as unknown as EnginePathJson;
              await runCommand(tabId, 'layer.vectorMask.edit', { layer: maskLayer, path: moved });
              const s2 = getSession(tabId);
              if (s2) {
                s2.vectorMaskPath = moved;
                scheduleDraw();
              }
            } catch (err) {
              logError('[editor] vectorMask.edit 失败', err);
            }
          })();
        } else {
          const active = findLayerTree(s.state.layers, s.state.activeLayer);
          if (active?.kind === 'Shape') {
            void runCommand(tabId, 'shape.edit', { layer: active.id, move: [rx, ry] })
              .catch((err) => logError('[editor] shape.edit 失败', err));
          } else if (s.workPath) {
            void runCommand(tabId, 'path.set', { name: 'work', path: peTranslate(s.workPath, [rx, ry]) })
              .then((r) => {
                const path = (r as { path?: WorkPathJson } | null)?.path;
                const s2 = getSession(tabId);
                if (s2 && path) {
                  s2.workPath = path;
                  scheduleDraw();
                }
              })
              .catch((err) => logError('[editor] path.set 失败', err));
          }
        }
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
    // 框专属 undo 推栈(上游 push_press_step):松手且框相对按下时变化 → 按下快照入 undo、清 redo
    const pressStep = cropHistoryRef.current.press;
    cropHistoryRef.current.press = null;
    const cf = cropRef.current;
    if (pressStep && cf && (cf.rect[0] !== pressStep.rect[0] || cf.rect[1] !== pressStep.rect[1] || cf.rect[2] !== pressStep.rect[2] || cf.rect[3] !== pressStep.rect[3] || cf.angle !== pressStep.angle || cf.edited !== pressStep.edited)) {
      cropHistoryRef.current.undo.push(pressStep);
      cropHistoryRef.current.redo = [];
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
    smStrokeRef.current = false;
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
    // hold 不是进行中的手势,中断不清(它由 refetch/1s 兜底/再次按下回收)
    if (liveGradRef.current?.kind !== 'hold') liveGradRef.current = null;
    marqueeRef.current = null;
    eyedropRef.current = null;
    panRef.current = null;
    // 文字手势中断:拖缩/拖框/挂起确认丢弃;编辑会话本身保留(仍可键入)
    typeResizeRef.current = null;
    typeDragRef.current = null;
    typePendingRef.current = null;
    // 自由变换手势中断:手势丢弃、当前 quad/pivot 保持(快照重算无半途状态),框仍打开
    if (transformRef.current.gesture) {
      transformRef.current.gesture = null;
      transformRef.current.readout = null;
      if (transformRef.current.session) syncTransformProjection(tabId, transformRef.current.session);
    }
    const st = getSession(tabId);
    if (st?.textEdit?.dragging) updateSession(tabId, { textEdit: { ...st.textEdit, dragging: false } });
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

  // 取色卡外点/Esc/钳位/拖动全在 PickerCard 壳内(2026-11-10 与文字颜色卡共用)

  if (!session) return null;
  const CROSSHAIR_TOOLS = new Set(['marquee', 'lasso', 'polygonLasso', 'magneticLasso', 'eyedropper', 'gradient', 'bucket', ...SHAPE_GROUP, 'pen']);
  // 自由变换光标:hover 把手=对角/单边 resize,框内/pivot=move,框外=crosshair
  // (旋转手势框外全程可用,近角反馈靠把手自绘;上游 CursorIcon 等价);
  // committed(提交落地中)=普通箭头(框暂不可操作)。
  const tHover = transformRef.current.session && !transformRef.current.gesture ? transformRef.current.hover : null;
  const transformCursor = (() => {
    if (session.transformCommitting) return 'default';
    // Warp 模式(上游 cursor()):预设网格处处十字;custom 时点在锚/柄上=十字,
    // 网格内(控制点包围盒近似)=grab,外=default;分割武装/快捷=十字导引。
    const wTr = transformRef.current;
    if (wTr.session?.warp) {
      if (wTr.kind === 'Type') return 'default'; // 文字层 Warp Text:恒普通箭头(上游 warps_type)
      if (wTr.warpSplit?.placing || wTr.warpSplit?.tool || wTr.warpDrag) return 'crosshair';
      if (wTr.warpHover != null) return 'crosshair';
      const w = wTr.session.warp;
      if (w.style !== 'custom') return 'crosshair';
      if (w.mesh) {
        const [bx0, by0, bx1, by1] = meshControlBounds(w.mesh);
        const pd = session.runtime.pointerDoc;
        if (pd && pd.x >= bx0 && pd.x <= bx1 && pd.y >= by0 && pd.y <= by1) return 'grab';
      }
      return 'default';
    }
    if (!tHover) return 'move';
    if (tHover.kind === 'corner') {
      // 角 i(顺时针 TL,TR,BR,BL)→ 两向 resize 光标(按 quad 走向近似,不随旋转精细跟随)
      return tHover.i === 0 || tHover.i === 2 ? 'nwse-resize' : 'nesw-resize';
    }
    if (tHover.kind === 'edge') {
      return tHover.i === 0 || tHover.i === 2 ? 'ns-resize' : 'ew-resize';
    }
    if (tHover.kind === 'pivot' || tHover.kind === 'inside') return 'move';
    return 'crosshair';
  })();
  const cursor =
    transformRef.current.session ? transformCursor
      : session.selectMask?.open
        ? // 对话框模态:边刷开=自绘圆环(原生光标隐藏),关=普通箭头(上游模态画布口径)
          session.selectMask.brush ? 'none' : 'default'
          : session.tool === 'hand' || spaceRef.current ? 'grab'
        : session.tool === 'zoom' ? 'zoom-in'
          : BRUSH_TOOLS.has(session.tool) ? 'none'
            : session.tool === 'crop' ? (cropCursorRef.current ?? 'crosshair')
              : TYPE_TOOLS.has(session.tool) ? 'text'
                : CROSSHAIR_TOOLS.has(session.tool) ? CROSSHAIR_CURSOR
                  : 'default';

  return (
    <div
      ref={wrapRef}
      data-editor-canvas=""
      className="relative flex-1 min-h-0 overflow-hidden bg-subtle"
      style={{ cursor, touchAction: 'none' }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onPointerLeave={onPointerLeave}
      onDragEnter={(e) => {
        // 外部文件拖入画布:拦截冒泡(dragenter 先于 dragover,App 根层靠它弹图库覆盖层)
        if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/json')) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDragOver={(e) => {
        // Place 拖放(上游 drop_places):仅外部文件拖入时拦截;内部卡片拖拽
        // (application/json)与无文档时不拦,图库链路照常
        if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/json')) return;
        e.preventDefault();
        e.stopPropagation();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('application/json')) return;
        e.preventDefault();
        e.stopPropagation();
        const files = Array.from(e.dataTransfer.files);
        const s = getSession(tabId);
        if (!files.length || !s || s.docId == null) return;
        placeQueueRef.current.push(...files);
        if (s.transform) {
          // #4833:已有变换框先提交;出队在提交落地(位图泵)/取消处接续
          if (!s.transformCommitting) void commitTransform(tabId);
        } else {
          void placeNextRef.current();
        }
      }}
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
      {/* IME 承接(二-6):隐藏 textarea 摆到 caret 屏幕位——OS 候选窗锚定其元素矩形
          (上游 egui IMEOutput 的 Web 等价);pointer-events 关掉,指针手势全走画布;
          beforeinput 走原生监听(typeBeforeInputRef),组字让位给 composition 事件 */}
      <textarea
        ref={attachTypeInput}
        className="pointer-events-none absolute z-0 m-0 resize-none overflow-hidden border-0 bg-transparent p-0 opacity-0 outline-none"
        style={{ left: '-100px', top: '-100px', width: 1, height: 1 }}
        spellCheck={false}
        aria-hidden
        tabIndex={-1}
        onChange={() => undefined}
        onCompositionUpdate={(e) => void imeUpdateType(e.data, false)}
        onCompositionEnd={(e) => void imeUpdateType(e.data, true)}
      />
      {session.shapeDialog && <ShapeDialog tabId={tabId} />}
      {session.loading && <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500 dark:text-neutral-400">正在打开…</div>}
      {session.error && <div className="absolute inset-0 flex items-center justify-center text-sm text-red-400 p-8 text-center">{session.error}</div>}
      {stopPicker && (
        <PickerCard
          title="拾色器(色标颜色)"
          at={{ left: stopPicker.x, top: stopPicker.y }}
          closeOnOutside
          onClose={() => setStopPicker(null)}
          footer={
            <>
              <button
                onClick={() => setStopPicker(null)}
                className="px-2 py-0.5 rounded text-[11px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
              >
                取消
              </button>
              <button onClick={commitStopColor} className="px-2 py-0.5 rounded text-[11px] bg-sky-600 text-white hover:bg-sky-500">
                确定
              </button>
            </>
          }
        >
          <ColorPicker
            value={stopPicker.rgb}
            onCommit={(rgb) => setStopPicker((sp) => (sp ? { ...sp, rgb } : sp))}
            label={`色标 #${stopPicker.index + 1}`}
          />
        </PickerCard>
      )}
    </div>
  );
};
