/**
 * 编辑器代理图缓存（路径 → 代理图），带订阅。
 *
 * 两个用途：
 * 1. **性能**：同一张图反复打开不必重跑管线（实测 0.48s → 0ms）。
 * 2. **跨组件共享**：编辑器画布在 `ViewerPane` 树里，编辑面板在 `RightPanel` 树里，
 *    两者是兄弟节点。与其为了传一张 data URL 而提升状态（0.5MB 字符串进 React state
 *    会被 tabs 持久化带进 localStorage），不如放进模块级缓存 —— 面板按
 *    `activeTab.editorDocument.path` 直接取。
 *
 * ⚠️ 失效：Phase 1 没有保存回写，文件在打开期间不变，所以会话内不失效。
 * **保存功能上线后必须 `invalidatePreview(path)`**，否则用户改完看到的是旧图。
 */
export interface EditorPreviewMeta {
  /** 源图原始尺寸 */
  width: number;
  height: number;
  /** 代理图尺寸 */
  previewWidth: number;
  previewHeight: number;
  /** `data:image/jpeg;base64,...` */
  dataUrl: string;
}

const CACHE_LIMIT = 6;
const cache = new Map<string, EditorPreviewMeta>();
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach(l => l());
}

/**
 * 读缓存并把命中项挪到队尾（LRU）。
 *
 * **有副作用**（改变插入顺序），只能在事件处理里调用；`useSyncExternalStore` 的
 * getSnapshot 必须用 [`peekPreview`]，否则会「取快照 → 通知 → 再取快照」无限循环。
 */
export function takePreview(path: string): EditorPreviewMeta | undefined {
  const hit = cache.get(path);
  if (!hit) return undefined;
  cache.delete(path);
  cache.set(path, hit);
  return hit;
}

/** 无副作用读取，供 render 阶段 / getSnapshot 使用。 */
export function peekPreview(path: string): EditorPreviewMeta | undefined {
  return cache.get(path);
}

export function putPreview(path: string, meta: EditorPreviewMeta): void {
  cache.delete(path);
  cache.set(path, meta);
  while (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  notify();
}

/** 保存回写后调用（Phase 1 尚无保存功能，先留好入口）。 */
export function invalidatePreview(path: string): void {
  if (cache.delete(path)) notify();
}

export function subscribePreview(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
