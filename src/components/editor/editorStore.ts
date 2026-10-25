/**
 * 编辑器会话 store:模块级订阅单例(项目惯例),按 Tab 分会话。
 * React 态(docId/revision/state/tool/选项)走订阅通知;
 * 高频态(视图变换/指针位置/离屏位图)放 runtime,由画布直接读写,不触发渲染。
 */
import type { EditorDocState, EditorTool } from './editorTypes';
import { editorClose, editorRun, editorState } from './editorBridge';
import type { ViewTransform } from './viewMath';
import type { SelectionShape } from './toolLogic';

export interface ToolOptions {
  brushSize: number;
  brushHardness: number;
  brushOpacity: number;
  brushFlow: number;
  feather: number;
  tolerance: number;
  antiAlias: boolean;
  gradientStyle: 'linear' | 'radial' | 'angle' | 'reflected' | 'diamond';
  /** 选框工具形状(矩形/椭圆);提交给 select.rect 的 ellipse。 */
  marqueeShape: 'rect' | 'ellipse';
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
  /** 选框刚提交的形状(引擎只回外接 bounds;与 bounds 匹配时画形状蚂蚁线,否则退回 bounds 框)。 */
  selectionShape: SelectionShape | null;
  /** 蚂蚁线相位(动画帧推进,画布直写不走订阅)。 */
  antsPhase: number;
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
      feather: 0,
      tolerance: 32,
      antiAlias: true,
      gradientStyle: 'linear',
      marqueeShape: 'rect',
    },
    runtime: { view: { scale: 1, ox: 0, oy: 0 }, pointerDoc: null, offscreen: null, rasterScale: 1, viewW: 0, viewH: 0, requestDraw: null, selectionShape: null, antsPhase: 0 },
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
  if (out.revision > 0 && out.revision !== s.revision) {
    updateSession(tabId, { revision: out.revision });
  }
  if (out.revision > 0 || cmd.startsWith('tools.')) {
    // 文档还在(未被 file.close 关掉):拉状态供面板。tools.*(取色/换色)不推进
    // revision 但改了会话级前/背景色,芯片读 state,所以也要拉。
    try {
      const st = await editorState(s.docId);
      updateSession(tabId, { state: st });
      // 状态变化可能影响画布 overlay(选区蚂蚁线/图层可见性后的位图):调度一帧重绘。
      // React 重渲染不会重画 canvas,没有这步选区要等下一次交互才出现。
      s.runtime.requestDraw?.();
    } catch {
      /* 文档已关闭等;忽略 */
    }
  }
  return out.result;
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
