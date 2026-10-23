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
 * 撤销签名与代理图键都从这里取（各自只写一遍）；导出参数在调用处用
 * `composeMatrix(box, natural)` + `adjust` 拼装，矩阵不在这里重新推导。
 * 这是架构事实第 7 条（"字段逐处列举必漏"，已栽两次）的直接对策。
 */
import type { EditorCanvas, EditorDocument, EditorLayer, LayerBox } from '../../types';
import { BlendMode, normalizeBlendMode } from './blendModes';

/**
 * 文档模型版本。与 `EditorDocument.version` 共用同一个常量，避免两处各写一个数字。
 */
export const EDITOR_DOC_VERSION = 2 as const;

/**
 * 是否 v1 遗留文档。
 *
 * 判定要**同时**满足两条：没有 v2 的 `version`，**且确实带着 v1 那套平铺字段**。
 *
 * 只看 `version` 是不够的：从画廊打开的文档由 `openInEditor` 建出来就是
 * `{path, name, dirty}`（App 那边不知道图多大，画布与图层要等图加载才补），
 * 它同样没有 `version`——只看 version 会把**刚打开的图片**误判成旧文档并弹出警告。
 *
 * **不做迁移**（§7 已拍板）：迁移需要源图自然尺寸，而 v1 数据里没有。
 *
 * 注：Tab 目前根本没持久化（`useAppInit` 每次启动重建 `tabs: [defaultTab]`），
 * 所以这条今天只是防御性设计，将来加持久化时它就是判据。
 */
export function isLegacyEditorDocument(doc?: EditorDocument | null): boolean {
  if (!doc || doc.version === EDITOR_DOC_VERSION) return false;
  return Boolean(doc.crop || doc.rotation || doc.flipH || doc.flipV || doc.adjust);
}

/** 建画布。`background` 默认透明（PS 新建文档的默认也是白/透明二选一，这里取透明）。 */
export function createCanvas(
  width: number,
  height: number,
  background: EditorCanvas['background'] = 'transparent',
): EditorCanvas {
  return { width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)), background };
}

/**
 * 未变换的定界框：内容与框 1:1。
 *
 * 当前只被测试与 `createImageLayer` 的默认值用到；生产路径的定界框由
 * `createOrientedImageLayer` 直接算出（要按 EXIF 方向把框摆正）。
 */
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

/**
 * EXIF 方向（1..8）→ 图层的 rotation / flip 与"正确朝向下的显示尺寸"。
 *
 * **为什么需要它**：浏览器对 `<img>` 默认自动按 EXIF 转正，而 Rust `decode_file`
 * 拿的是存储方向的像素。不统一的话就是「屏幕正的、导出躺的」。对策是关掉浏览器的
 * 自动旋转（图层 img 设 `imageOrientation: 'none'`），把方向**一次性折进图层变换**。
 *
 * 这是设计稿 §5.1 的同一个哲学：低频算一次，不留第二个真源。
 *
 * 1..8 的标准映射（2/4 是镜像，5/7 是镜像+旋转），与 EXIF 规范一致。
 */
export function orientationToBox(
  natural: { width: number; height: number },
  orientation: number,
): { rotation: number; flipH: boolean; flipV: boolean; displayWidth: number; displayHeight: number } {
  const { width: w, height: h } = natural;
  const swaps = orientation === 5 || orientation === 6 || orientation === 7 || orientation === 8;
  const displayWidth = swaps ? h : w;
  const displayHeight = swaps ? w : h;

  switch (orientation) {
    case 2:
      return { rotation: 0, flipH: true, flipV: false, displayWidth, displayHeight };
    case 3:
      return { rotation: 180, flipH: false, flipV: false, displayWidth, displayHeight };
    case 4:
      return { rotation: 0, flipH: false, flipV: true, displayWidth, displayHeight };
    case 5:
      return { rotation: 270, flipH: true, flipV: false, displayWidth, displayHeight };
    case 6:
      return { rotation: 90, flipH: false, flipV: false, displayWidth, displayHeight };
    case 7:
      return { rotation: 90, flipH: true, flipV: false, displayWidth, displayHeight };
    case 8:
      return { rotation: 270, flipH: false, flipV: false, displayWidth, displayHeight };
    default:
      return { rotation: 0, flipH: false, flipV: false, displayWidth, displayHeight };
  }
}

/**
 * 建一个带 EXIF 方向的图片图层。
 *
 * 与 `createImageLayer` 的差别：这里先按**显示尺寸**（已转正）做 contain 适配，
 * 再把"内容尺寸 × 缩放"装进定界框，并按旋转后的包围盒把框摆到正中间。
 *
 * 例：存储 4000×3000、orientation 6（顺时针 90°）→ 显示 3000×4000；
 * 画布若就是 3000×4000，则定界框 w=4000、h=3000、rotation=90，
 * 中心落在画布中心，包围盒正好铺满。
 */
export function createOrientedImageLayer(opts: {
  id: string;
  source?: string;
  naturalWidth: number;
  naturalHeight: number;
  /** EXIF 方向 1..8，缺省 1 */
  orientation?: number;
  canvas: { width: number; height: number };
  name?: string;
  /** 传 `false` 时按 1:1 原尺寸放置（不缩放、不居中） */
  fitToCanvas?: boolean;
}): EditorLayer {
  const m = orientationToBox(
    { width: opts.naturalWidth, height: opts.naturalHeight },
    opts.orientation ?? 1,
  );
  const display = { width: m.displayWidth, height: m.displayHeight };
  const fit =
    opts.fitToCanvas === false
      ? { x: 0, y: 0, w: display.width, h: display.height }
      : fitLayerToCanvas(display, opts.canvas);

  // 定界框尺寸直接取自 fit，**不做"先算比例再乘回去"**：那一步的浮点往返会让
  // 无旋转的常见情况也得到 138.1395… 这种脏数字（单测当场抓到过）。
  // contain 等比，所以方向没换时 w/h 就是 fit 的 w/h，换了就互换。
  const swapped = m.displayWidth !== opts.naturalWidth || m.displayHeight !== opts.naturalHeight;
  const w = swapped ? fit.h : fit.w;
  const h = swapped ? fit.w : fit.h;

  return {
    id: opts.id,
    kind: 'image',
    source: opts.source,
    naturalWidth: opts.naturalWidth,
    naturalHeight: opts.naturalHeight,
    box: {
      // 定界框中心对准"显示区"的中心：旋转后包围盒才会落在 fit 里
      x: fit.x + fit.w / 2 - w / 2,
      y: fit.y + fit.h / 2 - h / 2,
      w,
      h,
      rotation: m.rotation,
      flipH: m.flipH,
      flipV: m.flipV,
      skewX: 0,
      skewY: 0,
    },
    visible: true,
    name: opts.name ?? baseNameOf(opts.source, '图层'),
  };
}

/**
 * 建一个图片图层（无 EXIF 方向的简写）。
 *
 * ⚠️ **当前只有测试在用**——生产路径（打开文档 / 导入图层）一律走
 * `createOrientedImageLayer`，因为那张图可能带 EXIF 方向。这里保留是为了给单测提供
 * 一个"方向 = 1"的清晰夹具，不要拿它去接线新功能。
 */
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
  return createOrientedImageLayer({ ...opts, orientation: 1 });
}

/**
 * 图层状态签名——**撤销栈的"这一步和上一步是否不同"的唯一判据**。
 * 要不要重跑 Rust 由 `buildLayerPreviewKey` 决定（那个键里既没有变换也没有 adjust）。
 *
 * 含**会改变画面或图层栈结构的字段**。`name` 不在里面：改名字不该产生一步撤销，
 * 也不该触发重新解码。
 *
 * **`id` 必须在里面**：两张同源同尺寸的图层（「复制图层」出来的）在其余字段上完全一样，
 * 只有 id 能区分。没有它，"把副本挪到另一层上下"会被判成"没变"，这一步就进不了撤销栈
 * （2026-10-24 加图层面板时被单测抓到）。
 *
 * ⚠️ 新增任何影响画面的字段，必须同步加到这里——`layerModel.spec.ts` 里有一条
 * "改任意一个字段签名必变"的单测盯着，漏了就是红的。
 */
export function layerStateSignature(layer: EditorLayer): string {
  const b = layer.box;
  const a = layer.adjust;
  const adj = a ? `${a.brightness},${a.contrast},${a.saturation},${a.temperature}` : 'none';
  return [
    layer.id,
    layer.source ?? 'none',
    layer.naturalWidth,
    layer.naturalHeight,
    layer.visible ? 1 : 0,
    layerOpacity(layer),
    layerBlend(layer),
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
 * 图层**几何**签名：与 `layerStateSignature` 的差别是**不含 adjust 与 opacity**。
 *
 * 同样含 `id`（理由见上）。不含 adjust / opacity 是为了把"只拖滑杆"（调色、不透明度）
 * 识别出来合并成一步撤销——否则拖一次滑杆能灌进去上百条历史。
 * 注意这两个字段**仍在** `layerStateSignature` 里：画面确实变了，必须能撤销。
 *
 * 用途：判断"用户是不是只是在拖调色滑杆"——是的话，连续的变化要合并成一步撤销，
 * 否则拖一次滑杆能灌进去上百条历史，Ctrl+Z 要按几百下才回得去（沿用 v1 的 700ms 合并）。
 */
export function layerGeometrySignature(layer: EditorLayer): string {
  const b = layer.box;
  return [
    layer.id,
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
  ].join('|');
}

/** 整份文档的状态签名（画布 + 全部图层，含 adjust）——撤销栈的"是否变了"判据。 */
export function documentStateSignature(doc: EditorDocument): string {
  const c = doc.canvas;
  const canvasPart = c ? `${c.width}x${c.height}:${c.background}` : 'none';
  return `${canvasPart}|${(doc.layers ?? []).map(layerStateSignature).join('+')}`;
}

/** 整份文档的几何签名（不含 adjust）——用于把"只动调色"识别出来并合并撤销。 */
export function documentGeometrySignature(doc: EditorDocument): string {
  const c = doc.canvas;
  const canvasPart = c ? `${c.width}x${c.height}:${c.background}` : 'none';
  return `${canvasPart}|${(doc.layers ?? []).map(layerGeometrySignature).join('+')}`;
}

/**
 * 图层图的缓存键（代理图 / 原图 URL 都用它）。
 *
 * **故意只含 `source` 与自然尺寸，不含任何变换**——这是 v2 相对 v1 最大的一处简化：
 * 变换全部交给 CSS（预览）与 Rust 仿射（导出），图层图本身是一张"没变换过"的图，
 * 所以移动/缩放/旋转都不必重跑解码。v1 的键要含 crop/rotation/flip，命中率极低。
 *
 * `adjust` 也不在键里：预览走 CSS `feColorMatrix`（架构事实第 4 条），拖滑杆不重跑 Rust。
 */
export function buildLayerPreviewKey(layer: EditorLayer): string | null {
  if (!layer.source) return null;
  return `${layer.source}#${layer.naturalWidth}x${layer.naturalHeight}`;
}

// ============================================================================
// 图层列表操作（图层面板用）——全部是纯函数，不改入参
//
// **数组顺序恒定是「自底向上」**（下标 0 最靠下，最后一个是顶层的绘制顺序），
// 而面板显示必须反过来（第一行 = 最上层）。这一层反转只在 `layersTopDown` 里做一次，
// 别的地方都不许再自行倒序——两处各倒一次就是"上移变成了下移"这类怪 bug 的来源。
// ============================================================================

/** 新建图层 id。**带随机后缀**：连点两次「复制」可能落在同一毫秒，纯时间戳会撞 id，
 *  React key 撞了图层的选中/渲染就会互相串。 */
export function createLayerId(): string {
  return `layer-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function indexOfLayer(layers: EditorLayer[], id: string): number {
  return layers.findIndex(l => l.id === id);
}

/**
 * 读混合模式（缺省 / 未知值都落 `normal`）。
 *
 * 与不透明度同理：**别处不要自己写 `layer.blend ?? 'normal'`**，Rust 侧的
 * `BlendMode::parse` 也是"认不出来就 Normal"，两边口径必须一致。
 */
export function layerBlend(layer: EditorLayer): BlendMode {
  return normalizeBlendMode(layer.blend);
}

/**
 * 设混合模式。值没变时返回原数组引用；回到 `normal` 时**删字段**（文档保持干净，
 * 与 `setLayerOpacity` 回到 100 时删字段同一个理由）。
 */
export function setLayerBlend(
  layers: EditorLayer[],
  id: string,
  blend: BlendMode,
): EditorLayer[] {
  const i = indexOfLayer(layers, id);
  if (i < 0) return layers;
  const next = normalizeBlendMode(blend);
  if (layerBlend(layers[i]) === next) return layers;
  const copy = layers.slice();
  const target: EditorLayer = { ...copy[i] };
  if (next === 'normal') delete target.blend;
  else target.blend = next;
  copy[i] = target;
  return copy;
}

/**
 * 读不透明度并钳到 0..100（缺省 / 脏数据都落 100）。
 *
 * 统一走这里，别处不要自己写 `layer.opacity ?? 100`：Rust 侧对应 `unwrap_or(100).min(100)`，
 * 两边口径必须一致，否则 `.aurora` 往返一次数值就漂了。
 */
export function layerOpacity(layer: EditorLayer): number {
  const raw = layer.opacity;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return 100;
  return Math.min(100, Math.max(0, Math.round(raw)));
}

/**
 * 设不透明度（0..=100）。值没变时返回原数组引用——调用方据此不置 dirty。
 *
 * 回到 100 时**删掉字段**而不是写 100：文档要保持干净（和 `normalizeAdjust` 把全 0
 * 的 adjust 折成 undefined 是同一个理由），`.aurora` 里也就不会出现满屏 `opacity: 100`。
 */
export function setLayerOpacity(layers: EditorLayer[], id: string, opacity: number): EditorLayer[] {
  const i = indexOfLayer(layers, id);
  if (i < 0) return layers;
  const next = Math.min(100, Math.max(0, Math.round(opacity)));
  if (layerOpacity(layers[i]) === next) return layers;
  const copy = layers.slice();
  const target: EditorLayer = { ...copy[i] };
  if (next === 100) delete target.opacity;
  else target.opacity = next;
  copy[i] = target;
  return copy;
}

/** 面板显示顺序：自顶向下（数组本身是自底向上）。 */
export function layersTopDown(layers: EditorLayer[]): EditorLayer[] {
  return layers.slice().reverse();
}

/**
 * 切换某图层可见性。
 *
 * 「不可见」只存在于文档里：画布用 `opacity: 0` 隐藏，**导出必须跳过**（否则用户
 * 关掉的眼睛在成品里又睁开了）——见 `ImageEditor.handleExport` 的 filter。
 */
export function setLayerVisible(layers: EditorLayer[], id: string, visible: boolean): EditorLayer[] {
  const i = indexOfLayer(layers, id);
  if (i < 0 || layers[i].visible === visible) return layers;
  const next = layers.slice();
  next[i] = { ...next[i], visible };
  return next;
}

/**
 * 删除图层，并给出删除后的活动图层。
 *
 * 删掉的正是活动层时，活动层落到**它下面那层**（PS：删完选中下层，因为下层原来被它挡着）；
 * 删的是最底层就往上找一层。删空了返回 `undefined`。
 */
export function removeLayer(
  layers: EditorLayer[],
  id: string,
  activeLayerId?: string,
): { layers: EditorLayer[]; activeLayerId?: string } {
  const i = indexOfLayer(layers, id);
  if (i < 0) return { layers, activeLayerId };
  const next = layers.filter(l => l.id !== id);
  const nextActive = activeLayerId === id ? next[Math.max(0, i - 1)]?.id : activeLayerId;
  return { layers: next, activeLayerId: nextActive };
}

/**
 * 复制图层（PS 的 Ctrl+J 语义）：插在**原图层上方**，名字加「 副本」。
 *
 * `box` 与 `adjust` 必须深拷贝：共享同一个对象的话，之后拖动副本会连带拖动原件
 * （`{...layer, box}` 是浅拷贝，`box` 仍指向同一个引用）。
 */
export function duplicateLayer(
  layers: EditorLayer[],
  id: string,
  newId: string,
): { layers: EditorLayer[]; newLayerId?: string } {
  const i = indexOfLayer(layers, id);
  if (i < 0) return { layers, newLayerId: undefined };
  const src = layers[i];
  const copy: EditorLayer = {
    ...src,
    id: newId,
    name: `${src.name} 副本`,
    box: { ...src.box },
    adjust: src.adjust ? { ...src.adjust } : undefined,
  };
  const next = layers.slice();
  next.splice(i + 1, 0, copy);
  return { layers: next, newLayerId: newId };
}

/**
 * 拖拽排序：把 `draggedId` 放到 `targetId` 的**显示上方/下方**。
 *
 * 参数 `position` 用的是**显示口径**（用户在列表里看到的上下），不是数组下标口径：
 * - `'above'` = 盖住目标层（数组里更靠后、更晚绘制）
 * - `'below'` = 被目标层盖住（数组里更靠前）
 *
 * 这一层转换必须在这里做完——调用方（面板）只知道自己看到的是"上面/下面"，
 * 让它去算 `+1/-1` 就是把"自底向上"这个反直觉的约定又泄漏出去一次。
 *
 * 位置没变化时返回**原数组引用**，调用方据此不置 dirty、不产生一步空撤销。
 */
export function reorderLayers(
  layers: EditorLayer[],
  draggedId: string,
  targetId: string,
  position: 'above' | 'below',
): EditorLayer[] {
  const from = indexOfLayer(layers, draggedId);
  const to = indexOfLayer(layers, targetId);
  if (from < 0 || to < 0 || from === to) return layers;

  const moved = layers[from];
  const rest = layers.filter((_, i) => i !== from);
  const targetIdx = rest.findIndex(l => l.id === targetId);
  if (targetIdx < 0) return layers;
  const insertAt = position === 'above' ? targetIdx + 1 : targetIdx;
  const next = rest.slice();
  next.splice(insertAt, 0, moved);

  // 顺序真的变了吗？（拖到自己原来的位置上下 = 没动）
  const unchanged = next.every((l, i) => l.id === layers[i].id);
  return unchanged ? layers : next;
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
