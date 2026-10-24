/**
 * 图层代理图的请求层（跨组件共享）。
 *
 * ## 为什么从 ImageEditor 里搬出来
 *
 * 代理图原本只有一个消费者——画布那个"活动图层"的缩略图。图层面板要**每一层**一张
 * 缩略图之后，请求方变成了两个（画布在 `ViewerPane` 树里，面板在 `RightPanel` 树里，
 * 是兄弟节点）。请求去重表如果各留一份，同一张图会被解码两次。
 *
 * ## 两条约束
 *
 * 1. **同路径只解一次**：`proxyPromises` 按路径合并。StrictMode 下 effect 会跑两遍，
 *    没有这张表就会把同一张 24MP 的图解码两次（每次 ~96MB RGBA）。
 * 2. **同时在跑的生成数 ≤ 2**（`ensureLayerPreview`）：一个文档可能有十层，一次性
 *    全丢给 Rust 就是十个全图解码并行，内存顶穿。所以排队，一格一格来。
 *    画布自己那条路（`loadLayerProxy` 直接调用）不排队——它是首屏的必经之路，
 *    排在一堆缩略图后面会让"打开图片"变成转圈。
 */
import { invoke } from '@tauri-apps/api/core';
import type { EditorLayer } from '../../types';
import { peekPreview, putPreview } from './editorPreviewCache';
import { buildLayerPreviewKey } from './layerModel';

/** `editor_load_layer_proxy` 的返回（camelCase 由 Rust 侧 serde 重命名） */
export interface LayerProxyResponse {
  naturalWidth: number;
  naturalHeight: number;
  /** EXIF 方向 1..8；1 = 不用转 */
  orientation: number;
  previewWidth: number;
  previewHeight: number;
  dataUrl: string;
}

/**
 * 按路径合并同一张图的代理请求。
 *
 * 失败**不缓存**（`delete` 后重新抛），否则一次偶发失败会把这路径永久钉死。
 */
const proxyPromises = new Map<string, Promise<LayerProxyResponse>>();

export function loadLayerProxy(path: string): Promise<LayerProxyResponse> {
  const hit = proxyPromises.get(path);
  if (hit) return hit;
  const p = invoke<LayerProxyResponse>('editor_load_layer_proxy', { path }).catch(e => {
    proxyPromises.delete(path);
    throw e;
  });
  proxyPromises.set(path, p);
  return p;
}

/** 同时在跑的缩略图生成数上限。见文件头的第 2 条约束。 */
const MAX_CONCURRENT = 2;

/** 排队中的任务（先进先出）。`running` 是当前在跑的数量。 */
let running = 0;
const waiting: Array<() => void> = [];
/** 已排队/正在生成的键：防止同一个图层在每次 re-render 时反复入队。**完成后要删掉**，
 * 否则缓存 LRU 淘汰之后这张缩略图就再也回不来了（面板会一直显示图标占位）。 */
const inflight = new Set<string>();
/** 失败过的键：本次会话内不再重试（否则一个坏文件会让面板反复解码）。 */
const failed = new Set<string>();

function acquire(work: () => void): void {
  if (running < MAX_CONCURRENT) {
    running += 1;
    work();
    return;
  }
  waiting.push(work);
}

function release(): void {
  const next = waiting.shift();
  if (next) next();
  else running -= 1;
}

/**
 * 确保某图层的代理图已进缓存（面板缩略图用）。
 *
 * 幂等：缓存命中、已排队、已失败都直接返回。**不抛错**——缩略图失败不该影响编辑，
 * 面板会退回图标占位。
 *
 * 刻意没有返回值：调用方是 effect，需要的是"最终缓存里会有"这件事，
 * 结果通过 `subscribePreview` 回到面板。
 */
export function ensureLayerPreview(layer: EditorLayer): void {
  const key = buildLayerPreviewKey(layer);
  if (!key || !layer.source) return;
  // 命中、在飞、已失败都直接返回。**注意 peek 而不是 take**：这里在 effect 里，
  // take 的 LRU 副作用会让每次 re-render 都改写队列顺序。
  if (peekPreview(key) || inflight.has(key) || failed.has(key)) return;
  inflight.add(key);

  const source = layer.source;
  acquire(() => {
    // 画笔的后台烘焙先落盘：source 可能是"预分配"路径（画面走内存画布、文件
    // 还在路上），直接读文件会 404 进 failed、缩略图永远占位
    import('./brushBake')
      .then(({ flushPaintBakes }) => flushPaintBakes())
      .then(() => loadLayerProxy(source))
      .then(res => {
        putPreview(key, {
          width: res.naturalWidth,
          height: res.naturalHeight,
          previewWidth: res.previewWidth,
          previewHeight: res.previewHeight,
          dataUrl: res.dataUrl,
        });
      })
      .catch(() => {
        failed.add(key);
      })
      .finally(() => {
        inflight.delete(key);
        release();
      });
  });
}
