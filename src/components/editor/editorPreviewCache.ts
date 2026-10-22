/**
 * 编辑器图层代理缓存（键 → 代理图），带订阅。
 *
 * ## 角色（v2 起变了）
 *
 * v1 里它是**唯一显示源**（画布就是这张 2048 的 JPEG）。现在画布直接渲染**原文件**
 * （`convertFileSrc`），放大到 100% 能看到真像素；代理图只服务两件事：
 *
 * 1. **缩略图**——右侧面板的图层行（40px）与全览图。从 3440px 直接缩到 40px 是
 *    64 倍降采样，浏览器会用低质近似（满屏锯齿），所以要一张 ≤2048 的中转图。
 * 2. **超大图打底**（尚未实现，见设计稿 §4.4）。
 *
 * ## 跨组件共享
 *
 * 画布在 `ViewerPane` 树里，面板在 `RightPanel` 树里，是兄弟节点。与其把 data URL
 * 提升到 React state，不如放在模块级缓存——面板按 `buildLayerPreviewKey` 直接取。
 *
 * ⚠️ 失效：尚无保存回写，文件在打开期间不变，所以会话内不失效。
 * **保存功能上线后必须 `invalidatePreview`**，否则用户改完看到的是旧图。
 *
 * ## 缓存键
 *
 * 由 `layerModel.buildLayerPreviewKey` 生成，**只含 source 与自然尺寸、不含任何变换**：
 * 变换交给 CSS 与 Rust 仿射后，图层图是"没变换过"的那张，所以移动/缩放/旋转都不必
 * 重跑解码（v1 的键要含 crop/rotation/flip，命中率极低）。
 */
export interface EditorPreviewMeta {
  /** 源图自然尺寸（存储方向，即未按 EXIF 转正的那个尺寸） */
  width: number;
  height: number;
  /** 代理图尺寸。源图本就小于上限时与 `width`/`height` 相同 */
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
