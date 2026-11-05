/**
 * 编辑器会话 store:模块级订阅单例(项目惯例),按 Tab 分会话。
 * React 态(docId/revision/state/tool/选项)走订阅通知;
 * 高频态(视图变换/指针位置/离屏位图)放 runtime,由画布直接读写,不触发渲染。
 */
import type { EditorDocState, EditorTool, RunOutcome } from './editorTypes';
import { editorClose, editorDuplicateMove, editorExportDocument, editorExportEstimate, editorExportLayerPng, editorExportPreview, editorRun, editorSave, editorSaveAs, editorSelectionOutline, editorState } from './editorBridge';
import { chainSegments, selectMaskPaintStroke, type SelectMaskStroke } from './toolLogic';
import { defaultGradient, type GradientPreset } from './gradientPresets';
import { humanBytes, validSetting, type ExportSettingsJson } from './exportDialogMath';
import { save as saveDialog } from '@tauri-apps/plugin-dialog';
import type { ViewTransform } from './viewMath';

export interface ToolOptions {
  brushSize: number;
  brushHardness: number;
  brushOpacity: number;
  brushFlow: number;
  /** blur/sharpen/smudge 的强度(引擎 strength,1..100)。 */
  retouchStrength: number;
  feather: number;
  tolerance: number;
  antiAlias: boolean;
  gradientStyle: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
  /** 渐变工具当前渐变(可编辑副本;预设点击=载入副本,渐变面板 stop 编辑改此副本)。 */
  gradientCurrent: GradientPreset;
  /** 渐变模式(上游 gradient_classic,默认 false=Live 渐变填充图层;true=经典像素渐变)。 */
  gradientClassic: boolean;
  /** 渐变反向(引擎 paint.gradient reverse)。 */
  gradientReverse: boolean;
  /** 渐变仿色(引擎 dither,默认开;减少色带)。 */
  gradientDither: boolean;
  /** 渐变不透明度 0..1(引擎 opacity 1..100;与画笔不透明度分开)。 */
  gradientOpacity: number;
  /** 渐变混合模式(上游 gradient_blend_mode):经典=paint.gradient mode;Live=建层带 mode、
   * 选中渐变图层时同步 layer.setProps blend。 */
  gradientBlend: string;
  /** 选框工具形状(矩形/椭圆/单行/单列);提交给 select.rect 的 ellipse/line。 */
  marqueeShape: 'rect' | 'ellipse' | 'row' | 'column';
  /** 选区四态(选项条显式模式,上游 selection_mode):无修饰键时用;修饰键优先。 */
  selectionMode: 'replace' | 'add' | 'subtract' | 'intersect';
  /** 移动工具 Auto-Select(上游 move_auto_select,默认开):按下时拾取光标下的图层;Ctrl 临时反转。 */
  moveAutoSelect: boolean;
  /** Auto-Select 的拾取目标(PS 选项条 图层/组 下拉;组=最外层编组)。 */
  moveTarget: 'layer' | 'group';
  /** 裁剪比例预设(上游 crop_ratio key):''=自由/whr=W×H×分辨率/original=原始比例/
   * 1:1/4:5/5:7/2:3/16:9/preset:*=尺寸预设/front=前景图像(即用即弃)。 */
  cropRatio: string;
  /** W×H×分辨率模式的长度字段(带单位,"4 in"/"1024 px";空=自由该侧)。 */
  cropWidth: string;
  cropHeight: string;
  /** 分辨率字段(数字)与单位。 */
  cropResolution: string;
  cropResolutionUnit: 'px/in' | 'px/cm';
  /** 裁剪角度约束(旋转吸附 15° 步进)常开;按住 Shift 临时反转。 */
  cropSnapAngle: boolean;
  /** 磁性套索检测宽度(上游 magnetic_width,1..256 px,默认 10):跟随边缘的走廊半径。 */
  magneticWidth: number;
  /** 磁性套索对比度(上游 magnetic_contrast,1..100%,默认 10):弱于此值的边缘忽略。 */
  magneticContrast: number;
  /** 磁性套索频率(上游 magnetic_frequency,0..100,默认 57):自动落点的疏密。 */
  magneticFrequency: number;
  /** 磁性套索笔压调制检测宽度(上游 magnetic_pressure,默认关;仅笔设备生效)。 */
  magneticPressure: boolean;
}

export interface EditorRuntime {
  /** 视图变换,画布拥有,导航器/信息轮询读。 */
  view: ViewTransform;
  /** 指针的文档坐标(浮点),无指针为 null。 */
  pointerDoc: { x: number; y: number } | null;
  /** 全分辨率离屏画布(文档尺寸);信息面板取色直接读它,不走 IPC。 */
  offscreen: HTMLCanvasElement | null;
  /** 离屏位图相对文档的缩放(大图降采样保护时 <1)。 */
  rasterScale: number;
  /** 交互期降载渲染的截止时刻(Date.now() ms;0=非交互):拖动调整滑杆/渐变等高频交互
   * 进行中,位图泵按视口预算出图(每帧从 96MB 级降到 ~10MB 级,GPU 纹理池不再被撑大),
   * 结束/过期回全分辨率——PS「低分辨率预览」同款。 */
  interactiveRenderUntil: number;
  /** 交互标记的过期唤醒定时器:到期清零并 notify,让泵以全分辨率补渲当前 revision。 */
  interactiveRenderTimer: number | null;
  viewW: number;
  viewH: number;
  /** 画布注册的重绘请求(视图动作/工具预览用)。 */
  requestDraw: (() => void) | null;
  /** 选区真实轮廓(mask 边界段,文档坐标;draw 每帧按 key 防抖拉取)。 */
  selectionOutline: number[][] | null;
  /** 已拉取轮廓对应的 key(revision:bounds:step);空 = 与当前不符需重拉。 */
  outlineKey: string;
  /** 正在拉取的 key(防重复请求)。 */
  outlineFetching: string;
  /** 蚂蚁线相位(动画帧推进,画布直写不走订阅)。 */
  antsPhase: number;
  /** 裁剪框提交/取消(画布注册,选项条 ✓/⊘ 调用)。 */
  cropCommit: (() => void) | null;
  cropCancel: (() => void) | null;
  /** 上一笔的终点(⇧+点击直线连接用;上游 last_stroke_end,按文档区分)。 */
  lastStrokeEnd: { docId: number; x: number; y: number; pressure: number } | null;
  /** 裁剪拉直模式 armed(选项条标尺按钮;画完一条线自动解除)。 */
  cropStraightenArmed: boolean;
  /** 拉直线拖画中(文档坐标;null=未在画)。 */
  cropStraightenLine: { x0: number; y0: number; x1: number; y1: number } | null;
  /** 比例预设套用到当前裁剪框(选项条下拉 onChange 调;画布注册)。 */
  cropFitRatio: (() => void) | null;
  /** 设置裁剪框角度(选项条角度输入框;画布注册,归一 (-180,180],无框先建默认框)。 */
  cropSetAngle: ((deg: number) => void) | null;
}

export interface EditorSession {
  tabId: string;
  fileId: string;
  docId: number | null;
  path: string | null;
  loading: boolean;
  error: string | null;
  revision: number;
  state: EditorDocState | null;
  tool: EditorTool;
  options: ToolOptions;
  runtime: EditorRuntime;
  /** 当前裁剪框角度(度,屏幕顺时针;选项条角度输入框的显示源)。 */
  cropAngle: number;
  /** Select and Mask 对话框状态(会话级;null=未打开)。预览零文档改动,OK 一步 select.refineEdge。 */
  selectMask: SelectMaskState | null;
  /** 导出为对话框状态(会话级;null=未打开)。定型走临时 Session,文档零改动、不入历史。 */
  exportDialog: ExportDialogState | null;
}

/** 导出为对话框字段(上游 export_dialog 的 fields;srcW/srcH=源尺寸,图层级导出
 * 打开时未知(0),首帧预览回填后种子 W/H 字段)。 */
export interface ExportDialogState extends ExportSettingsJson {
  layer: number | null;
  srcW: number;
  srcH: number;
}

const sessions = new Map<string, EditorSession>();
/** 模块级监听器注册表:子组件的订阅可能早于父组件 ensureSession(React 子 effect 先跑)。 */
const listeners = new Map<string, Set<() => void>>();

function notify(tabId: string): void {
  listeners.get(tabId)?.forEach((fn) => fn());
}

export function getSession(tabId: string): EditorSession | undefined {
  return sessions.get(tabId);
}

export function ensureSession(tabId: string, fileId: string): EditorSession {
  let s = sessions.get(tabId);
  if (s && s.fileId === fileId) return s;
  if (s) sessions.delete(tabId);
  s = {
    tabId,
    fileId,
    docId: null,
    path: null,
    loading: true,
    error: null,
    revision: 0,
    state: null,
    tool: 'move',
    options: {
      brushSize: 24,
      brushHardness: 0.8,
      brushOpacity: 1,
      brushFlow: 1,
      retouchStrength: 50,
      feather: 0,
      tolerance: 32,
      antiAlias: true,
      gradientStyle: 'linear',
      gradientClassic: false,
      gradientCurrent: defaultGradient(),
      gradientReverse: false,
      gradientDither: true,
      gradientOpacity: 1,
      gradientBlend: 'Normal',
      marqueeShape: 'rect',
      selectionMode: 'replace',
      moveAutoSelect: true,
      moveTarget: 'layer',
      cropRatio: '',
      cropSnapAngle: false,
      cropWidth: '',
      cropHeight: '',
      cropResolution: '',
      cropResolutionUnit: 'px/in',
      magneticWidth: 10,
      magneticContrast: 10,
      magneticFrequency: 57,
      /** 磁性套索笔压调制检测宽度(上游 magnetic_pressure,默认关;仅笔设备生效)。 */
      magneticPressure: false,
    },
    runtime: { view: { scale: 1, ox: 0, oy: 0 }, pointerDoc: null, offscreen: null, rasterScale: 1, interactiveRenderUntil: 0, interactiveRenderTimer: null, viewW: 0, viewH: 0, requestDraw: null, selectionOutline: null, outlineKey: '', outlineFetching: '', antsPhase: 0, cropCommit: null, cropCancel: null, lastStrokeEnd: null, cropStraightenArmed: false, cropStraightenLine: null, cropFitRatio: null, cropSetAngle: null },
    cropAngle: 0,
    selectMask: null,
    exportDialog: null,
  };
  sessions.set(tabId, s);
  return s;
}

export function updateSession(tabId: string, patch: Partial<EditorSession>): void {
  const s = sessions.get(tabId);
  if (!s) return;
  Object.assign(s, patch);
  notify(tabId);
}

/**
 * 交互期降载渲染标记(PS「低分辨率预览」同款):ms>0 把泵的降载截止时刻续期到 now+ms
 * (拖动中每次 emit 都调,不通知——revision 推进自会唤醒泵);ms=0 立即结束(抬手/最终
 * 提交前调,随后的 revision 推进即以全分辨率出图)。续期同时重排过期唤醒定时器:到期
 * 清零并 notify,让泵对同一 revision 按全分辨率预算补渲(键含 rasterScale,两档必不同)——
 * 打字输入等没有"抬手"事件的提交路径靠它自愈,不存在标记泄漏。
 */
export function markInteractiveRender(tabId: string, ms: number): void {
  const s = sessions.get(tabId);
  if (!s) return;
  const until = ms > 0 ? Date.now() + ms : 0;
  const was = s.runtime.interactiveRenderUntil > 0;
  s.runtime.interactiveRenderUntil = until;
  if (s.runtime.interactiveRenderTimer != null) {
    window.clearTimeout(s.runtime.interactiveRenderTimer);
    s.runtime.interactiveRenderTimer = null;
  }
  if (until > 0) {
    s.runtime.interactiveRenderTimer = window.setTimeout(() => {
      s.runtime.interactiveRenderTimer = null;
      if (s.runtime.interactiveRenderUntil > 0 && Date.now() >= s.runtime.interactiveRenderUntil) {
        s.runtime.interactiveRenderUntil = 0;
        notify(tabId);
      }
    }, ms + 50);
  }
  if (was !== until > 0) notify(tabId);
}

// ---------------------------------------------------------------- Select and Mask

/** Select and Mask 七视图(上游 Mode;F 按 ALL 顺序循环)。 */
export const SELECT_MASK_MODES = ['onionSkin', 'marchingAnts', 'overlay', 'onBlack', 'onWhite', 'blackWhite', 'onLayers'] as const;
export type SelectMaskMode = (typeof SELECT_MASK_MODES)[number];
export const SELECT_MASK_MODE_ZH: Record<SelectMaskMode, string> = {
  onionSkin: '洋葱皮', marchingAnts: '蚂蚁线', overlay: '叠加', onBlack: '黑底', onWhite: '白底', blackWhite: '黑白', onLayers: '在图层上',
};
/** 每视图默认不透明度(%;无=0,上游 default_opacity)。 */
export function selectMaskDefaultOpacity(mode: SelectMaskMode): number {
  if (mode === 'onionSkin' || mode === 'overlay') return 50;
  if (mode === 'onBlack' || mode === 'onWhite') return 100;
  return 100;
}
export const SELECT_MASK_OUTPUTS = ['selection', 'layerMask', 'newLayer', 'newLayerWithMask', 'newDocument', 'newDocumentWithMask'] as const;
export const SELECT_MASK_OUTPUT_ZH: Record<string, string> = {
  selection: '选区', layerMask: '图层蒙版', newLayer: '新建图层', newLayerWithMask: '新建带蒙版的图层', newDocument: '新建文档', newDocumentWithMask: '新建带蒙版的文档',
};

/** Select and Mask 对话框状态(会话级;null=未打开;预览零文档改动)。 */
export interface SelectMaskState {
  open: boolean;
  /** 打开时锁定的活动层(预览与提交的目标层)。 */
  layerId: number | null;
  /** 以蒙版为起点(蒙版目标下打开;提交时带 target:"mask")。 */
  targetMask: boolean;
  // 全局精修(上游 spec 顺序与默认值)
  radius: number;
  smartRadius: boolean;
  smooth: number;
  feather: number;
  contrast: number;
  shiftEdge: number;
  decontaminate: boolean;
  amount: number;
  output: string;
  sampleAllLayers: boolean;
  // 视图
  viewMode: SelectMaskMode;
  /** 每视图独立不透明度(%;上游同款)。 */
  viewOpacity: Record<string, number>;
  showEdge: boolean;
  showOriginal: boolean;
  /** X 按住:临时显示原图。 */
  hideView: boolean;
  /** 精修选区轮廓(文档坐标段;泵写,MarchingAnts 视图蚂蚁线用)。 */
  outline: number[][] | null;
  // 边刷(上游 __brush/__brushMode/__brushSize + refineStrokes;UI 态,不进 prefs)
  brush: boolean;
  brushMode: 'add' | 'subtract';
  brushSize: number;
  refineStrokes: SelectMaskStroke[];
}

const SELECT_MASK_PREFS_KEY = 'aurora-editor:select-mask-fields';
/** 记住的上次标量值(localStorage;上游 prefs.dialogs 同款,Json 类参数不记)。 */
interface SelectMaskPrefs {
  radius: number;
  smartRadius: boolean;
  smooth: number;
  feather: number;
  contrast: number;
  shiftEdge: number;
  decontaminate: boolean;
  amount: number;
  output: string;
  sampleAllLayers: boolean;
}

function loadSelectMaskPrefs(): Partial<SelectMaskPrefs> {
  try {
    const raw = localStorage.getItem(SELECT_MASK_PREFS_KEY);
    return raw ? (JSON.parse(raw) as Partial<SelectMaskPrefs>) : {};
  } catch {
    return {};
  }
}

function saveSelectMaskPrefs(sm: SelectMaskState): void {
  try {
    const prefs: SelectMaskPrefs = {
      radius: sm.radius, smartRadius: sm.smartRadius, smooth: sm.smooth, feather: sm.feather,
      contrast: sm.contrast, shiftEdge: sm.shiftEdge, decontaminate: sm.decontaminate,
      amount: sm.amount, output: sm.output, sampleAllLayers: sm.sampleAllLayers,
    };
    localStorage.setItem(SELECT_MASK_PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* 存储不可用忽略 */
  }
}

/** 打开 Select and Mask(上游 select.selectAndMask:有选区或活动层有蒙版才可用;
 * 无选区有蒙版时 output 默认 layerMask;蒙版目标下以蒙版为起点)。 */
export function openSelectMask(tabId: string): boolean {
  const s = sessions.get(tabId);
  if (!s || !s.state || s.docId == null) return false;
  const active = s.state.layers.find((l) => l.id === s.state?.activeLayer) ?? null;
  const hasMask = active?.hasMask === true;
  if (!s.state.hasSelection && !hasMask) return false;
  const prefs = loadSelectMaskPrefs();
  const targetMask = isMaskTargetState(s) && hasMask;
  s.selectMask = {
    open: true,
    layerId: s.state.activeLayer,
    targetMask,
    radius: prefs.radius ?? 0,
    smartRadius: prefs.smartRadius ?? false,
    smooth: prefs.smooth ?? 0,
    feather: prefs.feather ?? 0,
    contrast: prefs.contrast ?? 0,
    shiftEdge: prefs.shiftEdge ?? 0,
    decontaminate: prefs.decontaminate ?? false,
    amount: prefs.amount ?? 100,
    output: s.state.hasSelection ? (prefs.output ?? 'selection') : 'layerMask',
    sampleAllLayers: prefs.sampleAllLayers ?? false,
    viewMode: 'onionSkin',
    viewOpacity: {},
    showEdge: false,
    showOriginal: false,
    hideView: false,
    outline: null,
    brush: false,
    brushMode: 'add',
    brushSize: 30,
    refineStrokes: [],
  };
  notify(tabId);
  return true;
}

function isMaskTargetState(s: EditorSession): boolean {
  return s.state?.channels?.target?.kind === 'layerMask';
}

/** 更新对话框字段(字段变化=预览键变化,位图泵自动重算)。 */
export function updateSelectMask(tabId: string, patch: Partial<SelectMaskState>): void {
  const s = sessions.get(tabId);
  if (!s?.selectMask?.open) return;
  s.selectMask = { ...s.selectMask, ...patch };
  notify(tabId);
}

/** 边刷在文档点 `at` 涂抹(start=新开一笔;subtract=Alt 反向;上游 canvas_brush→paint)。
 * 关闭时忽略;近点被点距过滤=同一引用直接返回(零通知),否则经 updateSelectMask
 * 通知→selectMaskKey 触发泵重算预览。 */
export function paintSelectMaskStroke(tabId: string, at: [number, number], start: boolean, subtract: boolean): void {
  const s = sessions.get(tabId);
  const sm = s?.selectMask;
  if (!sm?.open || !sm.brush) return;
  const next = selectMaskPaintStroke(sm.refineStrokes, at, start, subtract, sm.brushSize);
  if (next === sm.refineStrokes) return;
  updateSelectMask(tabId, { refineStrokes: next });
}

/** 关闭对话框(commit=确定:记上次标量值;取消:丢弃一切)。 */
export function closeSelectMask(tabId: string, commit: boolean): void {
  const s = sessions.get(tabId);
  if (!s?.selectMask) return;
  if (commit) saveSelectMaskPrefs(s.selectMask);
  s.selectMask = null;
  notify(tabId);
}

/** 确定:一条 select.refineEdge(**一步 "Select and Mask"** 历史;预览期间文档零改动,
 * 一切参数在该条提交)。成功记上次标量值并关闭;失败保持打开(引擎报错见日志)。 */
export function confirmSelectMask(tabId: string): void {
  const s = sessions.get(tabId);
  const sm = s?.selectMask;
  if (!s || !sm?.open || s.docId == null) return;
  const params: Record<string, unknown> = {
    radius: sm.radius,
    smartRadius: sm.smartRadius,
    smooth: sm.smooth,
    feather: sm.feather,
    contrast: sm.contrast,
    shiftEdge: sm.shiftEdge,
    decontaminate: sm.decontaminate,
    amount: sm.amount,
    output: sm.output,
    sampleAllLayers: sm.sampleAllLayers,
    ...(sm.refineStrokes.length > 0 ? { refineStrokes: sm.refineStrokes } : {}),
    ...(sm.targetMask ? { target: 'mask' } : {}),
  };
  void runCommand(tabId, 'select.refineEdge', params)
    .then(() => closeSelectMask(tabId, true))
    .catch((err) => console.error('[editor] select.refineEdge 失败', err));
}

// ===== 导出为对话框(上游 export_dialog;定型走临时 Session,文档零改动、不入历史)=====

const EXPORT_PREFS_KEY = 'aurora-editor:export-as';
/** 上游 SETTINGS:记忆的 14 键(path/源尺寸/图层不记,remembering_keeps_only_the_dialog_settings)。 */
const EXPORT_SETTING_KEYS = [
  'format', 'quality', 'lossless', 'transparency', 'scale', 'resample', 'metadata', 'tgaBits',
  'sizing', 'width', 'height', 'lockAspect', 'profile', 'embedProfile',
] as const;

/** 导出为保存对话框的格式过滤器(按当前所选格式单选;Windows 依此换扩展名)。 */
const EXPORT_FILTERS: Record<string, { name: string; extensions: string[] }> = {
  png: { name: 'PNG 图片', extensions: ['png'] },
  jpg: { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
  webp: { name: 'WebP 图片', extensions: ['webp'] },
  tif: { name: 'TIFF 图片', extensions: ['tif', 'tiff'] },
  tga: { name: 'TGA 图片', extensions: ['tga'] },
  ico: { name: 'ICO 图标', extensions: ['ico'] },
};

function loadExportPrefs(): Partial<ExportDialogState> {
  try {
    const raw = JSON.parse(localStorage.getItem(EXPORT_PREFS_KEY) ?? 'null') as Record<string, unknown> | null;
    if (!raw) return {};
    const out: Record<string, unknown> = {};
    for (const k of EXPORT_SETTING_KEYS) {
      const v = raw[k];
      if (validSetting(k, v)) out[k] = v;
    }
    return out as Partial<ExportDialogState>;
  } catch {
    return {};
  }
}

function saveExportPrefs(ed: ExportDialogState): void {
  try {
    const out: Record<string, unknown> = {};
    for (const k of EXPORT_SETTING_KEYS) out[k] = ed[k];
    localStorage.setItem(EXPORT_PREFS_KEY, JSON.stringify(out));
  } catch {
    /* 存储不可用忽略 */
  }
}

/** 打开导出为(上游 open():默认值→记忆种子覆盖;layer=图层级导出,源尺寸待首帧
 * 预览回填)。pixels 模式的显式尺寸跟记忆走(上游同款:上次导多大这次还多大)。 */
export function openExportDialog(tabId: string, layer: number | null = null): boolean {
  const s = sessions.get(tabId);
  if (!s || s.docId == null || !s.state) return false;
  const prefs = loadExportPrefs();
  s.exportDialog = {
    layer,
    srcW: layer != null ? 0 : s.state.width,
    srcH: layer != null ? 0 : s.state.height,
    format: prefs.format ?? 'png',
    quality: prefs.quality ?? 85,
    lossless: prefs.lossless ?? true,
    transparency: prefs.transparency ?? true,
    metadata: prefs.metadata ?? 'none',
    profile: prefs.profile ?? 'document',
    embedProfile: prefs.embedProfile ?? true,
    tgaBits: prefs.tgaBits ?? 'auto',
    sizing: prefs.sizing ?? 'scale',
    scale: prefs.scale ?? 100,
    width: prefs.width ?? s.state.width,
    height: prefs.height ?? s.state.height,
    lockAspect: prefs.lockAspect ?? true,
    resample: prefs.resample ?? 'bicubicAutomatic',
  };
  notify(tabId);
  return true;
}

/** 更新对话框字段(字段变化=预览键变化,对话框泵自动重算)。 */
export function updateExportDialog(tabId: string, patch: Partial<ExportDialogState>): void {
  const s = sessions.get(tabId);
  if (!s?.exportDialog) return;
  s.exportDialog = { ...s.exportDialog, ...patch };
  notify(tabId);
}

/** 关闭对话框(commit=确认导出后:记忆 14 键;取消:丢弃)。 */
export function closeExportDialog(tabId: string, commit: boolean): void {
  const s = sessions.get(tabId);
  if (!s?.exportDialog) return;
  if (commit) saveExportPrefs(s.exportDialog);
  s.exportDialog = null;
  notify(tabId);
}

/** 确定(上游 confirm):记忆设置 → 系统保存对话框(建议名=文档名/图层名.格式)→
 * editorExportDocument 落盘 → showEditorNotice + 广播 aurora-editor-saved
 * (导出目标在图库目录内时单文件重扫立即可见)。取消对话框=无副作用。 */
export async function confirmExportDialog(tabId: string): Promise<void> {
  const s = sessions.get(tabId);
  const ed = s?.exportDialog;
  if (!s || !ed || s.docId == null) return;
  saveExportPrefs(ed);
  const docName = s.state?.name ?? 'image';
  const stem = ed.layer != null
    ? exportLayerName(s.state?.layers.find((l) => l.id === ed.layer)?.name ?? 'layer')
    : exportLayerName(docName.replace(/\.[^.]+$/, ''));
  const dir = s.path ? s.path.replace(/[^\\/]+$/, '') : '';
  const target = await saveDialog({
    title: '导出为',
    defaultPath: `${dir}${stem}.${ed.format}`,
    filters: [EXPORT_FILTERS[ed.format] ?? { name: ed.format.toUpperCase(), extensions: [ed.format] }],
  });
  if (!target || typeof target !== 'string') return;
  try {
    const { layer, srcW: _srcW, srcH: _srcH, ...f } = ed;
    const r = await editorExportDocument(s.docId, layer, target, f as Record<string, unknown>);
    console.log(`[editor] 已导出 ${target} (${r.bytes} 字节, ${r.width}x${r.height})`);
    if (r.warnings.length > 0) console.warn('[editor] 导出警告:', r.warnings);
    showEditorNotice(`已导出 ${target.replace(/^.*[\\/]/, '')}(${humanBytes(r.bytes)})`);
    window.dispatchEvent(new CustomEvent('aurora-editor-saved', { detail: { path: target } }));
    closeExportDialog(tabId, true);
  } catch (err) {
    console.error('[editor] 导出失败', err);
    showEditorNotice(`导出失败:${err instanceof Error ? err.message : String(err)}`);
  }
}

export function setTool(tabId: string, tool: EditorTool): void {
  const s = sessions.get(tabId);
  if (!s || s.tool === tool) return;
  s.tool = tool;
  notify(tabId);
}

export function setOptions(tabId: string, patch: Partial<ToolOptions>): void {
  const s = sessions.get(tabId);
  if (!s) return;
  Object.assign(s.options, patch);
  notify(tabId);
}

// ===== 编辑器内状态提示(轻量 toast;与画布订阅解耦,跨组件直达)=====

/** 编辑器状态提示(text 展示于底部居中,seq 区分同文本连发以重置计时)。 */
export interface EditorNotice {
  text: string;
  seq: number;
}

let editorNotice: EditorNotice | null = null;
let editorNoticeSeq = 0;
const noticeListeners = new Set<(n: EditorNotice | null) => void>();

/** 弹一条编辑器内提示(2.6s 自动消失;纯状态反馈,不阻断交互)。 */
export function showEditorNotice(text: string): void {
  editorNotice = { text, seq: ++editorNoticeSeq };
  noticeListeners.forEach((fn) => fn(editorNotice));
}

export function subscribeEditorNotice(fn: (n: EditorNotice | null) => void): () => void {
  noticeListeners.add(fn);
  fn(editorNotice);
  return () => {
    noticeListeners.delete(fn);
  };
}

export function subscribeSession(tabId: string, fn: () => void): () => void {
  let set = listeners.get(tabId);
  if (!set) {
    set = new Set();
    listeners.set(tabId, set);
  }
  set.add(fn);
  return () => set.delete(fn);
}

/**
 * 跑引擎命令:推进 revision,并总是拉一份状态快照(工具态命令不推进 revision)。
 * opts.noPull:跳过状态快照(实时预览的节流提交用——拖动中面板不需要每帧跟,
 * 省一条 IPC;revision 照常推进,位图管线照常重渲,释放的最终提交不带 noPull 补拉一次)。
 */
export async function runCommand(tabId: string, cmd: string, params: Record<string, unknown> = {}, opts: { noPull?: boolean } = {}): Promise<unknown> {
  const s = sessions.get(tabId);
  if (!s || s.docId == null) throw new Error('editor session not open');
  const out = await editorRun(s.docId, cmd, params);
  // layer.pickAt/selectInRect 只改图层选择(不入史不推进 revision),选择一变面板就要跟上
  const pull = !opts.noPull && (out.revision > 0 || /^(tools|view|channel)\./.test(cmd) || /^layer\.(pickAt|selectInRect)$/.test(cmd));
  await applyRunOutcome(tabId, out, pull);
  return out.result;
}

/**
 * 命令落地后的公共收尾:推进 revision、拉状态快照(面板)、同步选区轮廓、
 * 请求一帧画布重绘。描边提交(stroke_commit)与 runCommand 共用这条路径。
 * 调用方若已把像素画进离屏位图(fromLive),先抬位画布的 bitmapKey 再进来,
 * 整幅重渲就会被跳过。
 */
export async function applyRunOutcome(tabId: string, out: RunOutcome, pullState: boolean): Promise<void> {
  const s = sessions.get(tabId);
  if (!s || s.docId == null) return;
  // revision 单调前进:快速连发时命令响应可能乱序,晚到的旧响应不回退水位
  if (out.revision > 0 && out.revision > s.revision) {
    updateSession(tabId, { revision: out.revision });
  }
  if (pullState) {
    // 文档还在(未被 file.close 关掉):拉状态供面板。tools.*(取色/换色)不推进
    // revision 但改了会话级前/背景色,芯片读 state,所以也要拉。
    try {
      const st = await editorState(s.docId);
      // 快速连发命令时多个 state 请求在途,响应可能乱序:晚到的旧快照会把 revision
      // 连同 params/图层一起回退(表现:色阶手柄松手后回跳),按 revision 丢弃
      if (typeof st.revision === 'number' && st.revision < s.revision) return;
      updateSession(tabId, { state: st });
      // 选区一变就同步拉轮廓:与 state 同帧到达,首帧即真实形状(椭圆不会先闪外接矩形);
      // 内部按 key 防抖,选区没变的命令不发请求。
      refreshSelectionOutline(tabId);
      // 状态变化可能影响画布 overlay(选区蚂蚁线/图层可见性后的位图):调度一帧重绘。
      // React 重渲染不会重画 canvas,没有这步选区要等下一次交互才出现。
      s.runtime.requestDraw?.();
    } catch {
      /* 文档已关闭等;忽略 */
    }
  }
}

/** 有未保存修改的编辑器会话(状态点同一水位:revision>saved_revision)。 */
export interface DirtySessionInfo {
  tabId: string;
  name: string;
}

/** 列出全部有未保存修改的会话(关闭标签/退出应用前的拦截查询)。 */
export function listDirtySessions(): DirtySessionInfo[] {
  const out: DirtySessionInfo[] = [];
  sessions.forEach((s) => {
    if (s.docId != null && s.state?.dirty) {
      out.push({ tabId: s.tabId, name: s.state?.name ?? s.path ?? '未命名' });
    }
  });
  return out;
}

/** 全部会话概览(冒烟/调试用:listDirtySessions 只报 dirty 会话,新开的文档查不到)。 */
export function debugSessions(): { tabId: string; tool: string; docId: number | null; path: string | null }[] {
  return [...sessions.values()].map((s) => ({ tabId: s.tabId, tool: s.tool, docId: s.docId, path: s.path }));
}

/** 指定 Tab 的编辑器会话是否有未保存修改(无会话=false)。 */
export function isSessionDirty(tabId: string): boolean {
  const s = sessions.get(tabId);
  return !!(s && s.docId != null && s.state?.dirty);
}

/** 关闭会话(引擎文档释放),Tab 卸载时调用。 */
export function disposeSession(tabId: string): void {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  listeners.delete(tabId);
  if (s.runtime.interactiveRenderTimer != null) {
    window.clearTimeout(s.runtime.interactiveRenderTimer);
    s.runtime.interactiveRenderTimer = null;
  }
  // 位图归零释放 backing(置宽高 0 立刻丢 96MB 级画布内存,仅靠断引用 GC 慢且 WebView2 不放账)
  if (s.runtime.offscreen) {
    s.runtime.offscreen.width = 0;
    s.runtime.offscreen.height = 0;
    s.runtime.offscreen = null;
  }
  if (s.docId != null) {
    void editorClose(s.docId).catch(() => undefined);
  }
}

/**
 * Ctrl+S 保存(拍板:覆盖原图 + 同名 .psd 分层伴生;引擎原子写)。
 * 落盘后广播 `aurora-editor-saved` 窗口事件——App 监听后做单文件重扫 +
 * 缩略图内存缓存失效(编辑器不耦合图库内部状态)。返回 null=无可存(未打开/无路径)。
 */
export async function saveSession(tabId: string): Promise<{ imagePath: string; psdPath: string } | null> {
  const s = sessions.get(tabId);
  if (!s || s.docId == null || !s.path) return null;
  const r = await editorSave(s.docId);
  console.log(`[editor] 已保存 ${r.imagePath} (+${r.psdExisted ? '更新' : '新建'}伴生 ${r.psdPath})`);
  window.dispatchEvent(new CustomEvent('aurora-editor-saved', { detail: { path: r.imagePath, psdPath: r.psdPath } }));
  // 已存水位在引擎侧推进:拉一份状态让状态点立即变绿
  try {
    updateSession(tabId, { state: await editorState(s.docId) });
  } catch { /* 文档已关 */ }
  return { imagePath: r.imagePath, psdPath: r.psdPath };
}

/** 另存为对话框的格式清单(引擎 photocraft_io 依扩展名真重编码的全集的用户向子集)。 */
const SAVE_FORMATS = [
  { name: 'PNG 图片', extensions: ['png'] },
  { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
  { name: 'WebP 图片', extensions: ['webp'] },
  { name: 'TIFF 图片', extensions: ['tif', 'tiff'] },
  { name: 'Photoshop 分层文档', extensions: ['psd'] },
];

/**
 * 另存为(PS 口径):格式对话框(按扩展名真重编码,不是改后缀)→ 落盘 →
 * 文档改绑新路径(此后 Ctrl+S 写新文件;平面格式自动带 .psd 伴生)。
 * 取消对话框返回 null。
 */
export async function saveAsSession(tabId: string): Promise<{ imagePath: string; psdPath: string | null } | null> {
  const s = sessions.get(tabId);
  if (!s || s.docId == null || !s.path) return null;
  const target = await saveDialog({
    title: '另存为',
    defaultPath: s.path,
    filters: SAVE_FORMATS,
  });
  if (!target || typeof target !== 'string') return null;
  const r = await editorSaveAs(s.docId, target);
  console.log(`[editor] 已另存为 ${r.imagePath}${r.psdPath ? ` (+伴生 ${r.psdPath})` : '(分层 psd)'}`);
  window.dispatchEvent(new CustomEvent('aurora-editor-saved', { detail: { path: r.imagePath, psdPath: r.psdPath } }));
  // 文档已改绑新路径:更新会话 path + 拉状态(状态点变绿);
  // 标签名跟随新文件名(广播给 App 改 tab.sessionName,编辑器不持有 tabs 状态)
  const newName = r.imagePath.replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.[^.]+$/, '') ?? null;
  if (newName) window.dispatchEvent(new CustomEvent('aurora-editor-renamed', { detail: { tabId, name: newName } }));
  try {
    updateSession(tabId, { path: r.imagePath, state: await editorState(s.docId) });
  } catch { /* 文档已关 */ }
  return r;
}

/**
 * 快速导出当前图层为 PNG(上游 Layer▸Quick Export as PNG 桌面路径):
 * 单层独立文档(内容边界裁剪、蒙版已应用、编组=整组合成、透明背景)→ 保存对话框
 * (默认文件名=图层名)→ 落盘。**不动会话路径、不入历史、dirty 不变**。
 * 取消对话框返回 null。
 */
export async function exportLayerAsPng(tabId: string): Promise<{ path: string; bytes: number } | null> {
  const s = sessions.get(tabId);
  if (!s || s.docId == null || !s.state?.activeLayer) return null;
  const layerId = s.state.activeLayer;
  const layerName = s.state.layers.find((l) => l.id === layerId)?.name ?? 'layer';
  const target = await saveDialog({
    title: '快速导出为 PNG',
    defaultPath: (s.path ? s.path.replace(/[^\\/]+$/, '') : '') + `${exportLayerName(layerName)}.png`,
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (!target || typeof target !== 'string') return null;
  const r = await editorExportLayerPng(s.docId, layerId, target);
  console.log(`[editor] 已快速导出图层 "${layerName}" → ${target} (${r.bytes} 字节, ${r.width}x${r.height})`);
  // 单文件重扫:导出目标在图库目录内时新文件立即可见(与保存同款信号)
  window.dispatchEvent(new CustomEvent('aurora-editor-saved', { detail: { path: target } }));
  return { path: r.path, bytes: r.bytes };
}

/** 图层导出的默认文件名(上游 export_name:非法字符→_,80 字上限,空名回退 layer)。 */
function exportLayerName(name: string): string {
  const cleaned = Array.from(name.slice(0, 80))
    .map((c) => (/[\x00-\x1f<>:"/\\|?*]/.test(c) ? '_' : c))
    .join('')
    .trim()
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
  return cleaned || 'layer';
}

/**
 * Alt 复制移动(上游 move_mods 的整层路径,桥层原子三步):in place 复制选中层
 * (副本成为选中)→ 平移 → 历史折叠一步 "Duplicate + Move"。走 applyRunOutcome
 * 的公共收尾(状态/轮廓/重绘),fabricated outcome 只带 revision。
 */
export async function duplicateMove(tabId: string, dx: number, dy: number): Promise<{ revision: number; layers: number[] }> {
  const s = sessions.get(tabId);
  if (!s || s.docId == null) throw new Error('editor session not open');
  const r = await editorDuplicateMove(s.docId, dx, dy);
  await applyRunOutcome(tabId, { revision: r.revision, viewRevision: 0, damage: null, result: r }, true);
  return r;
}

/**
 * 拉取选区真实轮廓(蚂蚁线数据)。draw 每帧调用,内部按
 * revision:bounds:step 防抖——选区没变就不发请求;无选区时清空。
 * step 采样步长按视图 zoom(photocraft 上游口径:2^floor(log2(1/zoom)),钳 1..64)。
 */
export function refreshSelectionOutline(tabId: string): void {
  const s = sessions.get(tabId);
  if (!s || s.docId == null || !s.state) return;
  const sel = s.state.selectionBounds;
  if (!s.state.hasSelection || !sel) {
    if (s.runtime.selectionOutline !== null) {
      s.runtime.selectionOutline = null;
      s.runtime.outlineKey = '';
    }
    return;
  }
  const step = Math.min(64, Math.max(1, Math.pow(2, Math.floor(Math.log2(1 / s.runtime.view.scale)))));
  const key = `${s.revision}:${sel.join(',')}:${step}`;
  if (s.runtime.outlineKey === key || s.runtime.outlineFetching === key) return;
  s.runtime.outlineFetching = key;
  void editorSelectionOutline(s.docId, step)
    .then((r) => {
      s.runtime.outlineFetching = '';
      // 段集先串接成连续折线再存:canvas 的 dash 在每个 moveTo 子路径重置,
      // 离散台阶段会全显成实线;折线内虚线才连续(上游 ants 沿边跑 dash 同理)。
      s.runtime.selectionOutline = r ? chainSegments(r.segments) : null;
      s.runtime.outlineKey = r ? key : '';
      s.runtime.requestDraw?.();
    })
    .catch((e) => {
      s.runtime.outlineFetching = '';
      console.error('[editor] selection outline', e);
    });
}
