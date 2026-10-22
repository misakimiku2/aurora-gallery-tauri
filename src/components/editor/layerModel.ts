/**
 * 最小图层模型（v2）的构造与判定——纯函数，无 React / DOM 依赖，可单测。
 *
 * 设计依据：`docs/图片编辑-最小图层模型设计.md` §2（模型）、§7（旧数据回退）、
 * §10（已拍板的七条）。
 *
 * ## 这个文件为什么独立存在
 *
 * v1 的编辑器是"图即画布"：`crop / rotation / flipH / flipV / adjust` 五个字段平铺在
 * 文档上，图永远铺满画布。v2 把它们拆成**画布**与**图层**两件事，画布可以先于图层
 * 存在（新建空白文档），图层也可以脱离画布（自由变形）。
 *
 * 拆开之后"一步操作改了哪些数"变多了，所以**所有会列举字段的地方都必须从这里取**——
 * 撤销快照签名、代理图缓存键、导出参数，三处共用同一个序列化，而不是各写一遍。
 * 这是架构事实第 7 条（"字段逐处列举必漏"，已栽两次）的直接对策。
 */
import type { EditorCanvas, EditorDocument, EditorLayer, LayerBox } from '../../types';

/**
 * 文档模型版本。与 `EditorDocument.version` 共用同一个常量，避免两处各写一个数字。
 */
export const EDITOR_DOC_VERSION = 2 as const;

/**
 * 是否 v1 遗留文档。
 *
 * 判定只看 `version`：不存在或不是 2，就是 v1 那套平铺字段的文档。**不做迁移**
 * （§7 已拍板）——迁移需要源图自然尺寸，而 v1 数据里没有，为了迁一个未发布功能的
 * 会话态去补一次异步解码不划算。
 *
 * 注：Tab 目前根本没持久化（`useAppInit` 每次启动重建 `tabs: [defaultTab]`），
 * 所以这条今天只是防御性设计，将来加持久化时它就是判据。
 */
export function isLegacyEditorDocument(doc?: EditorDocument | null): boolean {
  return !!doc && doc.version !== EDITOR_DOC_VERSION;
}

/** 建画布。`background` 默认透明（PS 新建文档的默认也是白/透明二选一，这里取透明）。 */
export function createCanvas(
  width: number,
  height: number,
  background: EditorCanvas['background'] = 'transparent',
): EditorCanvas {
  return { width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)), background };
}

/** 未变换的定界框：内容与框 1:1。 */
export function createIdentityBox(width: number, height: number): LayerBox {
  return {
    x: 0,
    y: 0,
    w: width,
    h: height,
    rotation: 0,
    flipH: false,
    flipV: false,
    skewX: 0,
    skewY: 0,
  };
}

/**
 * 图层内容按 **contain** 适配进画布（§10 第 5 条已拍板）。
 *
 * 取 PS「置入」的行为：整张图缩到画布内并居中。不按 1:1 原尺寸——一张 6000×4000
 * 塞进 1920×1080 画布，用户得先缩 30 倍才看得见全貌。
 */
export function fitLayerToCanvas(
  natural: { width: number; height: number },
  canvas: { width: number; height: number },
): { x: number; y: number; w: number; h: number } {
  const nw = natural.width;
  const nh = natural.height;
  const cw = canvas.width;
  const ch = canvas.height;
  if (!(nw > 0) || !(nh > 0) || !(cw > 0) || !(ch > 0)) return { x: 0, y: 0, w: 0, h: 0 };

  // 夹到 1：**小图不放大**。PS 的"置入"对小于画布的图保持原分辨率，放大只会得到一张糊图。
  const scale = Math.min(1, cw / nw, ch / nh);
  // 先取整再夹一次：round 可能把尺寸推到比画布大 1px，居中时会出现负偏移
  const w = Math.min(Math.round(nw * scale), cw);
  const h = Math.min(Math.round(nh * scale), ch);
  return { x: Math.round((cw - w) / 2), y: Math.round((ch - h) / 2), w, h };
}

/** 文件名（同时认 `\` 与 `/`），失败时给个兜底名。 */
function baseNameOf(path: string | undefined, fallback: string): string {
  if (!path) return fallback;
  const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
  const raw = i >= 0 ? path.slice(i + 1) : path;
  return raw.replace(/\.[^.]+$/, '') || fallback;
}

/** 建一个图片图层。默认适配方式 = contain 居中（已拍板）。 */
export function createImageLayer(opts: {
  id: string;
  source?: string;
  naturalWidth: number;
  naturalHeight: number;
  canvas: { width: number; height: number };
  name?: string;
  /** 传 `false` 时按 1:1 原尺寸放置（不居中、不缩放） */
  fitToCanvas?: boolean;
}): EditorLayer {
  const fit = opts.fitToCanvas === false
    ? { x: 0, y: 0, w: opts.naturalWidth, h: opts.naturalHeight }
    : fitLayerToCanvas({ width: opts.naturalWidth, height: opts.naturalHeight }, opts.canvas);

  return {
    id: opts.id,
    kind: 'image',
    source: opts.source,
    naturalWidth: opts.naturalWidth,
    naturalHeight: opts.naturalHeight,
    box: { ...createIdentityBox(0, 0), ...fit },
    visible: true,
    name: opts.name ?? baseNameOf(opts.source, '图层'),
  };
}

/**
 * 图层状态签名——**撤销栈的"这一步和上一步是否不同"、以及"要不要重跑 Rust"的唯一判据**。
 *
 * 只含**会改变画面**的字段。`id` 与 `name` 不在里面：改名字不该产生一步撤销，
 * 也不该触发重新解码。
 *
 * ⚠️ 新增任何影响画面的字段，必须同步加到这里——`layerModel.spec.ts` 里有一条
 * "改任意一个字段签名必变"的单测盯着，漏了就是红的。
 */
export function layerStateSignature(layer: EditorLayer): string {
  const b = layer.box;
  const a = layer.adjust;
  const adj = a ? `${a.brightness},${a.contrast},${a.saturation},${a.temperature}` : 'none';
  return [
    layer.source ?? 'none',
    layer.naturalWidth,
    layer.naturalHeight,
    layer.visible ? 1 : 0,
    b.x,
    b.y,
    b.w,
    b.h,
    b.rotation,
    b.flipH ? 1 : 0,
    b.flipV ? 1 : 0,
    b.skewX,
    b.skewY,
    adj,
  ].join('|');
}

/**
 * 图层图的缓存键（代理图 / 原图 URL 都用它）。
 *
 * **故意只含 `source`，不含任何变换**——这是 v2 相对 v1 最大的一处简化：
 * 变换全部交给 CSS（预览）与 Rust 仿射（导出），图层图本身是一张"没变换过"的图，
 * 所以移动/缩放/旋转都不必重跑解码。v1 的键要含 crop/rotation/flip，命中率极低。
 *
 * `adjust` 也不在键里：预览走 CSS `feColorMatrix`（架构事实第 4 条），拖滑杆不重跑 Rust。
 */
export function buildLayerPreviewKey(layer: EditorLayer): string | null {
  if (!layer.source) return null;
  return `${layer.source}#${layer.naturalWidth}x${layer.naturalHeight}`;
}

/** 文档的当前活动图层；没有就取最上面一层。 */
export function resolveActiveLayer(doc: EditorDocument): EditorLayer | undefined {
  const layers = doc.layers;
  if (!layers || layers.length === 0) return undefined;
  if (doc.activeLayerId) {
    const hit = layers.find(l => l.id === doc.activeLayerId);
    if (hit) return hit;
  }
  return layers[layers.length - 1];
}
