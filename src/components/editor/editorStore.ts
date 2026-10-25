/**
 * 编辑器会话 store:模块级订阅单例(项目惯例),按 Tab 分会话。
 * React 态(docId/revision/state/tool/选项)走订阅通知;
 * 高频态(视图变换/指针位置/离屏位图)放 runtime,由画布直接读写,不触发渲染。
 */
import type { EditorDocState, EditorTool, RunOutcome } from './editorTypes';
import { editorClose, editorRun, editorSelectionOutline, editorState } from './editorBridge';
import { chainSegments } from './toolLogic';
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
  /** 选框工具形状(矩形/椭圆/单行/单列);提交给 select.rect 的 ellipse/line。 */
  marqueeShape: 'rect' | 'ellipse' | 'row' | 'column';
  /** 选区四态(选项条显式模式,上游 selection_mode):无修饰键时用;修饰键优先。 */
  selectionMode: 'replace' | 'add' | 'subtract' | 'intersect';
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
      marqueeShape: 'rect',
      selectionMode: 'replace',
    },
    runtime: { view: { scale: 1, ox: 0, oy: 0 }, pointerDoc: null, offscreen: null, rasterScale: 1, viewW: 0, viewH: 0, requestDraw: null, selectionOutline: null, outlineKey: '', outlineFetching: '', antsPhase: 0, cropCommit: null, cropCancel: null },
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

export function subscribeSession(tabId: string, fn: () => void): () => void {
  let set = listeners.get(tabId);
  if (!set) {
    set = new Set();
    listeners.set(tabId, set);
  }
  set.add(fn);
  return () => set.delete(fn);
}

/** 跑引擎命令:推进 revision,并总是拉一份状态快照(工具态命令不推进 revision)。 */
export async function runCommand(tabId: string, cmd: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const s = sessions.get(tabId);
  if (!s || s.docId == null) throw new Error('editor session not open');
  const out = await editorRun(s.docId, cmd, params);
  await applyRunOutcome(tabId, out, out.revision > 0 || cmd.startsWith('tools.'));
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
  if (out.revision > 0 && out.revision !== s.revision) {
    updateSession(tabId, { revision: out.revision });
  }
  if (pullState) {
    // 文档还在(未被 file.close 关掉):拉状态供面板。tools.*(取色/换色)不推进
    // revision 但改了会话级前/背景色,芯片读 state,所以也要拉。
    try {
      const st = await editorState(s.docId);
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

/** 关闭会话(引擎文档释放),Tab 卸载时调用。 */
export function disposeSession(tabId: string): void {
  const s = sessions.get(tabId);
  if (!s) return;
  sessions.delete(tabId);
  listeners.delete(tabId);
  if (s.docId != null) {
    void editorClose(s.docId).catch(() => undefined);
  }
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
