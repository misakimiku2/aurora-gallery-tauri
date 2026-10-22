/**
 * 编辑器视图状态（每 Tab 一份），给「全览图」面板用。
 *
 * 为什么需要它：全览图要画出**当前视口框**，而视口（scale/x/y）只存在于
 * `ImageEditor` 的 state 里；全览图挂在 `RightPanel` 树里，两者是兄弟节点。
 * 同 `editorPreviewCache` 的理由——不把高频变化的东西提升进 React 树。
 *
 * 用 rAF 节流：拖动/缩放时 transform 每帧都变，直接 notify 会让整个右侧面板
 * 跟着每帧重渲染。全览图是辅助信息，60fps 更新没有必要。
 */
export interface EditorViewSnapshot {
  scale: number;
  x: number;
  y: number;
  containerWidth: number;
  containerHeight: number;
  /** 代理图尺寸（全览图按这个画） */
  imgWidth: number;
  imgHeight: number;
}

const views = new Map<string, EditorViewSnapshot>();
const listeners = new Set<() => void>();
let flushScheduled = false;

/**
 * 「把某个点移到视口中央」的请求（全览图点击/拖动发出的）。
 *
 * `nonce` 用来区分「新的请求」与「上一次的旧值」——拖动时同一秒内会连发很多次，
 * 只比较坐标会让"拖回原位"被判定为没变化。
 */
export interface PanRequest {
  /** 代理图像素坐标 */
  imgX: number;
  imgY: number;
  nonce: number;
}

const panRequests = new Map<string, PanRequest>();
let panNonce = 0;

/** 请画布把 (imgX, imgY)（代理图像素）移到视口中央。 */
export function requestPanTo(tabId: string, imgX: number, imgY: number): void {
  panRequests.set(tabId, { imgX, imgY, nonce: ++panNonce });
  scheduleNotify();
}

export function peekPanRequest(tabId: string): PanRequest | undefined {
  return panRequests.get(tabId);
}

function scheduleNotify() {
  if (flushScheduled) return;
  flushScheduled = true;
  const flush = () => {
    flushScheduled = false;
    listeners.forEach(l => l());
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
  else setTimeout(flush, 16);
}

export function setEditorView(tabId: string, next: EditorViewSnapshot): void {
  const prev = views.get(tabId);
  if (
    prev &&
    prev.scale === next.scale &&
    prev.x === next.x &&
    prev.y === next.y &&
    prev.containerWidth === next.containerWidth &&
    prev.containerHeight === next.containerHeight &&
    prev.imgWidth === next.imgWidth &&
    prev.imgHeight === next.imgHeight
  ) {
    return; // 无变化不通知
  }
  views.set(tabId, next);
  scheduleNotify();
}

export function getEditorView(tabId: string): EditorViewSnapshot | undefined {
  return views.get(tabId);
}

export function clearEditorView(tabId: string): void {
  if (views.delete(tabId)) scheduleNotify();
}

export function subscribeEditorView(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
