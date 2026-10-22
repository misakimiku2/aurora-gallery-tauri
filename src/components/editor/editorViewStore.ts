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
