/**
 * 图层像素的**会话内真身**（2026-10-26 画笔架构轮：内存位图为真身，文件退化为影子）。
 *
 * ## 角色
 *
 * v2.5 之前 `EditorLayer.source`（文件路径）是图层像素的唯一真身，画笔每笔都要
 * 整层 PNG 编码 + IPC 落盘，撤销/缩略图/全览全部跟文件对表——文件晚到一瞬间，
 * 撤销就是"整张图消失"、缩略图就是"占位符好几秒"（用户实测三症状，2026-10-25）。
 * 现在倒过来：**编辑会话内像素活在内存 canvas 里**，按 `layerId` 索引；文件只在
 * 空闲时后台烘焙（崩溃恢复 + 导出/保存的读盘来源），显示/撤销/缩略图/全览一律
 * 走内存，零编码、零 IPC。
 *
 * ## 键与版本
 *
 * - 键：图层本体 `layerKey(layerId)`，蒙版 `maskKey(layerId)`（`::mask` 后缀）；
 * - 每次像素变化 `version + 1` 并通知订阅者（显示/缩略图/全览用
 *   `useSyncExternalStore` 盯版本，不用碰 canvas 对象本身的身份）；
 * - `dirty` = 内存领先于 `bakedPath`（最后一次烘焙），空闲调度器据此决定烤谁。
 *
 * ## 逐出（LRU）与元数据
 *
 - 位图常驻内存是"真身"的代价（24MP ≈ 48MB/层）——**脏位图永不逐出**（逐出=丢笔迹），
 * 只有已烘焙（clean）的位图可逐出，重新物化时从 `bakedPath ?? sourcePath` 读回，
 * 内容与逐出时一致（烘焙后没动过才可能 clean）。元数据（路径/尺寸/paintName）
 * 永久保留——撤销补丁可能在位图被逐出后回来，得知道去哪读、读多大。
 *
 * ## 蒙版显示（2026-10-25 显示正确性轮）
 *
 * 曾经画过的蒙版显示走 blob URL（CSS mask-image 只认 URL）——任何像素变化
 * （撤销补丁、每笔结束）都要重编码 JPEG + 换 URL，浏览器重解码/重栅格化一下，
 * 即用户实测的"撤销刷新一下/画多了刷新"。现在**画过的蒙版由
 * `EditorCanvasLayers.MaskedPixels` 直接合成画布显示**（图层位图 × 蒙版亮度→
 * alpha，版本驱动、同帧重画），本模块只管位图本身；没画过/被逐出的蒙版照旧
 * CSS 壳读文件 URL（`displaySourceOf`）。
 */

/** 位图键：图层本体。 */
export function layerKey(layerId: string): string {
  return layerId;
}

/** 位图键：图层蒙版。 */
export function maskKey(layerId: string): string {
  return `${layerId}::mask`;
}

/** 一条位图的持久元数据（逐出后也保留——撤销补丁可能晚到）。 */
export interface BitmapMeta {
  /** 物化时读的文件（打开时的原图 / 工程解包路径）；新建空白层为 null */
  sourcePath: string | null;
  /** 最新已落盘的烘焙文件；null = 从没烤过 */
  bakedPath: string | null;
  /** 本键专属的烘焙文件名（稳定：重烤覆写同名文件，doc.source 只用换一次） */
  paintName: string | null;
  width: number;
  height: number;
}

interface BitmapEntry extends BitmapMeta {
  canvas: HTMLCanvasElement | null; // null = 已逐出（clean 才可能）
  version: number;
  dirty: boolean;
  lastTouch: number;
}

/** 常驻位图上限。超过时逐出最久未用的 **clean** 位图；脏的不动（宁超限不丢笔迹）。 */
const RESIDENT_LIMIT = 10;

const entries = new Map<string, BitmapEntry>();
/** 物化在飞（同键去重；失败不粘住）。 */
const inflight = new Map<string, Promise<HTMLCanvasElement>>();
const listeners = new Set<() => void>();

function notify(): void {
  listeners.forEach(l => l());
  if (settleTimer === null) settleTimer = window.setTimeout(pumpSettled, SETTLE_DELAY_MS);
}

export function subscribeBitmaps(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 版本快照（`useSyncExternalStore` 用；无位图 = 0，永远稳定）。 */
export function bitmapVersion(key: string): number {
  return entries.get(key)?.version ?? 0;
}

// ---- 版本的"防抖影子"（settled version，2026-10-25 显示正确性轮）----------------
//
// 图层笔划现在**逐帧合成进位图仓**（主画布 LayerPixels 订阅 bitmapVersion 即时
// 重画——这是跟手性的来源）。但图层面板的行缩略图若也盯即时版本，每帧都要
// thumbFromCanvas 整层重采样（24MP 逐级减半），必卡。settledBitmapVersion 在
// 版本停变 250ms 后才跟上：主画布走即时、行缩略图走 settled，同一个订阅两档。

const SETTLE_DELAY_MS = 250;
const settledVers = new Map<string, number>();
let settleTimer: number | null = null;

/** 版本停变后把 settled 镜像追平；只有真变了才再通知（否则会自我循环排Timer）。 */
function pumpSettled(): void {
  settleTimer = null;
  let changed = false;
  for (const [k, e] of entries) {
    if (settledVers.get(k) !== e.version) {
      settledVers.set(k, e.version);
      changed = true;
    }
  }
  if (changed) notify();
}

/** 版本的滞后镜像（行缩略图订阅用）：变更平息 SETTLE_DELAY_MS 后才追上当前值。 */
export function settledBitmapVersion(key: string): number {
  return settledVers.get(key) ?? bitmapVersion(key);
}

// ---- 笔划进行中标记（空闲烘焙让路）--------------------------------------------
//
// 逐帧合成 = 版本每帧 +1，空闲烘焙的 800ms 防抖会在长笔画中途到期，陷入
// "编码 → markBaked 发现版本又变了 → 再编码"的空转烧 CPU。笔划期间冻结烘焙
// （brushBake 订阅 strokeActive），全部笔划结束后补排一轮。

let strokeDepth = 0;
const strokeSettleListeners: Array<() => void> = [];

/** 开始一笔（可重入：理论上不会有并发笔划，防御性计数）。 */
export function beginStrokePause(): void {
  strokeDepth += 1;
}

/** 结束一笔；最后一笔结束时通知订阅者（brushBake 借此补排烘焙）。不配对的 end 忽略。 */
export function endStrokePause(): void {
  if (strokeDepth === 0) return;
  strokeDepth -= 1;
  if (strokeDepth === 0) strokeSettleListeners.forEach(f => f());
}

/** 是否有笔划进行中（空闲烘焙调度器让路的依据）。 */
export function strokeActive(): boolean {
  return strokeDepth > 0;
}

/** 订阅"所有笔划都已结束"（每批次最多通知一次）。 */
export function onStrokesSettled(fn: () => void): () => void {
  strokeSettleListeners.push(fn);
  return () => {
    const i = strokeSettleListeners.indexOf(fn);
    if (i >= 0) strokeSettleListeners.splice(i, 1);
  };
}

/** 渲染期无副作用读取位图（可能返回 undefined = 未物化/已逐出）。 */
export function peekBitmap(key: string): HTMLCanvasElement | undefined {
  const e = entries.get(key);
  if (!e || !e.canvas) return undefined;
  e.lastTouch = Date.now();
  return e.canvas;
}

/** 纯读取（不触碰 LRU 时钟）——render 期取像素用，重渲由版本订阅驱动。 */
export function readBitmap(key: string): HTMLCanvasElement | undefined {
  return entries.get(key)?.canvas ?? undefined;
}

export function bitmapMeta(key: string): BitmapMeta | undefined {
  const e = entries.get(key);
  if (!e) return undefined;
  return {
    sourcePath: e.sourcePath,
    bakedPath: e.bakedPath,
    paintName: e.paintName,
    width: e.width,
    height: e.height,
  };
}

function upsert(key: string, init: Partial<BitmapEntry> & { width: number; height: number }): BitmapEntry {
  const prev = entries.get(key);
  const entry: BitmapEntry = {
    sourcePath: null,
    bakedPath: null,
    paintName: null,
    canvas: null,
    version: 0,
    dirty: false,
    lastTouch: Date.now(),
    ...init,
  };
  if (prev) {
    // 重注册保留身份信息（版本/烘焙进度），只换画布本身
    entry.version = prev.version;
    entry.bakedPath = prev.bakedPath;
    entry.paintName = prev.paintName;
    entry.sourcePath = prev.sourcePath;
  }
  entries.set(key, entry);
  evictIfNeeded();
  return entry;
}

/** 逐出最久未用的 clean 位图（脏的跳过）。 */
function evictIfNeeded(): void {
  const resident = [...entries.values()].filter(e => e.canvas);
  if (resident.length <= RESIDENT_LIMIT) return;
  const evictable = resident.filter(e => !e.dirty).sort((a, b) => a.lastTouch - b.lastTouch);
  let budget = resident.length - RESIDENT_LIMIT;
  for (const e of evictable) {
    if (budget <= 0) break;
    e.canvas = null;
    budget -= 1;
  }
}

/** 新建空白层：注册一块全透明画布（脏——文件还不存在，空闲要烘焙）。 */
export function registerBlankBitmap(
  key: string,
  canvas: HTMLCanvasElement,
  paintName: string,
): void {
  upsert(key, { canvas, width: canvas.width, height: canvas.height, dirty: true, paintName });
  notify();
}

/** 复制图层：把源层的位图克隆给新键（脏——新层要有自己的烘焙文件）。 */
export function attachClonedBitmap(fromKey: string, toKey: string, paintName: string): boolean {
  const src = entries.get(fromKey);
  if (!src?.canvas) return false;
  const canvas = document.createElement('canvas');
  canvas.width = src.width;
  canvas.height = src.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) return false;
  ctx.drawImage(src.canvas, 0, 0);
  upsert(toKey, {
    canvas,
    width: src.width,
    height: src.height,
    dirty: true,
    paintName,
    sourcePath: src.sourcePath,
  });
  notify();
  return true;
}

/** 读文件字节（自定义 IPC；返回完整 dataUrl 要剥前缀——plugin-fs 的 scope 拦绝对路径）。 */
async function readFileBytes(source: string): Promise<Uint8Array<ArrayBuffer>> {
  const { invoke } = await import('@tauri-apps/api/core');
  const b64 = await invoke<string | null>('read_file_as_base64', { filePath: source });
  if (!b64) throw new Error(`无法读取图层文件：${source}`);
  const payload = b64.startsWith('data:') ? b64.slice(b64.indexOf(',') + 1) : b64;
  const bin = atob(payload);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/**
 * 物化位图（读 `bakedPath ?? sourcePath` → 解码 → canvas）。已在内存则直接返回。
 * 同键去重；**失败不缓存**。调用方：画笔落笔、撤销补丁回填、（将来）超大图打底。
 */
export function materializeBitmap(
  key: string,
  opts: { sourcePath: string; width: number; height: number },
): Promise<HTMLCanvasElement> {
  const hit = peekBitmap(key);
  if (hit) return Promise.resolve(hit);
  const flying = inflight.get(key);
  if (flying) return flying;

  const meta = entries.get(key);
  const readFrom = meta?.bakedPath ?? opts.sourcePath;
  const width = meta?.width ?? opts.width;
  const height = meta?.height ?? opts.height;

  const p = (async () => {
    const bytes = await readFileBytes(readFrom);
    const bitmap = await createImageBitmap(new Blob([bytes]));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('无法创建 2D 上下文');
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();
    upsert(key, { canvas, width, height, sourcePath: opts.sourcePath });
    notify();
    return canvas;
  })();
  inflight.set(
    key,
    p.catch(e => {
      throw e;
    }),
  );
  const clear = () => inflight.delete(key);
  p.then(clear, clear);
  return p;
}

/** 确保位图常驻（撤销/重做补丁落进被逐出的键时先调它）。 */
export async function ensureBitmapResident(
  key: string,
  fallback: { sourcePath: string; width: number; height: number },
): Promise<HTMLCanvasElement | null> {
  const hit = peekBitmap(key);
  if (hit) return hit;
  try {
    return await materializeBitmap(key, fallback);
  } catch {
    return null;
  }
}

/**
 * 像素变更入口：`fn` 在位图上作画（ctx 已 save/restore 包好），version+1、置脏、
 * 通知订阅者（显示层重画 + 空闲烘焙调度器接手）。位图必须在内存。
 */
export function mutatePixels(key: string, fn: (ctx: CanvasRenderingContext2D) => void): boolean {
  const e = entries.get(key);
  if (!e?.canvas) return false;
  const ctx = e.canvas.getContext('2d');
  if (!ctx) return false;
  ctx.save();
  fn(ctx);
  ctx.restore();
  e.version += 1;
  e.dirty = true;
  e.lastTouch = Date.now();
  notify();
  return true;
}

/** 读一块像素（撤销补丁用；位图不在内存返回 null）。 */
export function captureBitmapRect(
  key: string,
  rect: { x: number; y: number; w: number; h: number },
): ImageData | null {
  const e = entries.get(key);
  if (!e?.canvas || rect.w <= 0 || rect.h <= 0) return null;
  const ctx = e.canvas.getContext('2d');
  if (!ctx) return null;
  try {
    return ctx.getImageData(rect.x, rect.y, rect.w, rect.h);
  } catch {
    return null;
  }
}

/** 写回一块像素（撤销/重做；同样走版本推进 + 置脏——烤过的文件又落后了）。 */
export function applyBitmapPatch(
  key: string,
  pixels: ImageData,
  x: number,
  y: number,
): boolean {
  const e = entries.get(key);
  if (!e?.canvas) return false;
  const ctx = e.canvas.getContext('2d');
  if (!ctx) return false;
  ctx.putImageData(pixels, x, y);
  e.version += 1;
  e.dirty = true;
  e.lastTouch = Date.now();
  notify();
  return true;
}

/**
 * 烘焙成功回填：记录最终路径；`sinceVersion` 是烘焙**快照时**的版本——编码期间
 * 用户又落了一笔（版本变了）就**保持脏**，让下一轮空闲烘焙补上（审计 P1#3：
 * 无条件清脏会让 encode 窗口内的那一笔永远进不了文件）。
 */
export function markBaked(key: string, absPath: string, sinceVersion?: number): void {
  const e = entries.get(key);
  if (!e) return;
  e.bakedPath = absPath;
  if (sinceVersion === undefined || e.version === sinceVersion) {
    e.dirty = false;
  }
}

/**
 * 确保键有稳定烘焙文件名（有就返回现有的，没有就分配并记进元数据）。
 * 文件名本身是纯字符串（不碰 IPC），分配方：新建空白层 / 克隆层 / 烘焙兜底。
 */
export function ensurePaintName(key: string, allocate: () => string): string {
  const e = entries.get(key);
  if (!e) return allocate(); // 没元数据也至少返回一个一致的名字给调用方
  if (!e.paintName) e.paintName = allocate();
  return e.paintName;
}

/** 需要烘焙的键（空闲调度器扫这个）。 */
export function dirtyBitmapKeys(): string[] {
  return [...entries.entries()].filter(([, e]) => e.dirty).map(([k]) => k);
}

/**
 * 一个图层/蒙版的**显示与缩略图该读的文件**：画过（有烘焙文件）用 `bakedPath`，
 * 否则用文档里的 `source`（打开时的原文件）。位图被 LRU 逐出（只逐 clean）后
 * 显示回退 `<img>` 时用它——直接读 `source` 会把画过的笔迹全丢掉。
 * 脏位图永不被逐出，所以不存在"bakedPath 落后于画面"的窗口。
 */
export function displaySourceOf(key: string, docSource: string): string {
  return entries.get(key)?.bakedPath ?? docSource;
}

/**
 * 彻底忘掉一个键：位图 + 元数据。**只在"像素身份变了"时用**——蒙版被
 * 换成另一张图（同键但内容来源变了），旧位图再留着就是永久张冠李戴；普通删除
 * 蒙版不调它（撤销删除还要靠这份位图恢复笔迹）。图层本体在整个会话内键恒定，
 * 不需要。
 */
export function forgetBitmap(key: string): void {
  const e = entries.get(key);
  if (e) {
    e.canvas = null;
    e.dirty = false;
    e.version = 0;
    e.paintName = null;
    e.bakedPath = null;
  }
  settledVers.delete(key); // 版本归零，滞后镜像跟着清（别让行缩略图多等一拍）
  notify();
}
