/**
 * 全览图（Navigator）的**迷你像素源**（2026-10-26 架构轮）。
 *
 * 全览不再走 Rust `editor_render_document`（那条路要等烘焙落盘 + 全量解码合成，
 * 秒级延迟），改为前端直接渲染一份**迷你版文档**（复用 `EditorCanvasLayers` 的
 * DOM 合成：混合/蒙版/编组/剪贴语义与画布完全同源，所见即所得）。本模块给迷你
 * 版提供每一层的像素载体：
 *
 * - **画过的层**：位图仓的位图逐级降采样进一张 ≤`MINI_MAX_EDGE` 的小画布
 *   （版本化缓存，防抖 ~150ms 重生成——位图一笔一变，全览跟着走）；
 * - **没画过的层**：代理图缓存（2048 JPEG，面板行缩略图同款）→ 没有就临时
 *   读原文件 URL（代理到位后自动升级）。
 *
 * 订阅模型照 `layerBitmaps`：`subscribeMini` + `miniVersionOf`（render 期读用
 * `peekMini`，无副作用）。
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import type { EditorLayer } from '../../types';
import { buildLayerPreviewKey } from './layerModel';
import { peekPreview, subscribePreview } from './editorPreviewCache';
import {
  bitmapMeta,
  bitmapVersion,
  displaySourceOf,
  layerKey,
  peekBitmap,
  subscribeBitmaps,
} from './layerBitmaps';

/** 迷你画布最长边（全览显示区 ~320×128，2 倍余量保清晰）。 */
export const MINI_MAX_EDGE = 384;

interface MiniEntry {
  canvas: HTMLCanvasElement | null;
  /** 与位图仓版本对齐：位图变了、迷你还没重生成的窗口期里，用它识别"过期" */
  srcVersion: number;
  version: number;
}

const minis = new Map<string, MiniEntry>();
/** 挂载中的迷你文档声明感兴趣的键（只给这些键做重生成分配）。 */
const watched = new Set<string>();
const listeners = new Set<() => void>();
let regenTimer: number | null = null;

function notify(): void {
  listeners.forEach(l => l());
}

export function subscribeMini(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 迷你画布的版本（0 = 还没有；`useSyncExternalStore` 的快照）。 */
export function miniVersionOf(key: string): number {
  return minis.get(key)?.version ?? 0;
}

/** render 期无副作用读取迷你画布。 */
export function peekMini(key: string): HTMLCanvasElement | undefined {
  return minis.get(key)?.canvas ?? undefined;
}

/** 迷你文档挂载/卸载时声明/解除感兴趣的图层键。 */
export function watchMiniKeys(keys: string[], on: boolean): void {
  let added = false;
  for (const k of keys) {
    if (!watched.has(k)) added = true;
    if (on) watched.add(k);
    else watched.delete(k);
  }
  if (on && added) scheduleRegen();
}

/** 逐级减半降采样（与 `useEditorThumbnail.downscale` 同一套质量口径）。 */
function downscaleTo(source: HTMLCanvasElement, maxEdge: number): HTMLCanvasElement {
  const sw = source.width;
  const sh = source.height;
  const ratio = Math.min(1, maxEdge / Math.max(sw, sh));
  let cur: CanvasImageSource = source;
  let cw = sw;
  let ch = sh;
  while (cw > maxEdge * 2 && ch > maxEdge * 2) {
    const nw = Math.max(1, Math.floor(cw / 2));
    const nh = Math.max(1, Math.floor(ch / 2));
    const step = document.createElement('canvas');
    step.width = nw;
    step.height = nh;
    const ctx = step.getContext('2d');
    if (!ctx) break;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(cur, 0, 0, nw, nh);
    cur = step;
    cw = nw;
    ch = nh;
  }
  const out = document.createElement('canvas');
  out.width = Math.max(1, Math.round(sw * ratio));
  out.height = Math.max(1, Math.round(sh * ratio));
  const octx = out.getContext('2d');
  if (octx) {
    octx.imageSmoothingEnabled = true;
    octx.imageSmoothingQuality = 'high';
    octx.drawImage(cur, 0, 0, out.width, out.height);
  }
  return out;
}

function scheduleRegen(): void {
  if (regenTimer !== null) window.clearTimeout(regenTimer);
  regenTimer = window.setTimeout(() => {
    regenTimer = null;
    let changedAny = false;
    for (const key of watched) {
      const bitmap = peekBitmap(key);
      const entry = minis.get(key);
      if (!bitmap) continue; // 没画过的层走 URL 平面，不占迷你画布
      const srcVersion = bitmapVersion(key);
      if (entry?.canvas && entry.srcVersion === srcVersion) continue; // 没变
      const canvas = downscaleTo(bitmap, MINI_MAX_EDGE);
      minis.set(key, { canvas, srcVersion, version: (entry?.version ?? 0) + 1 });
      changedAny = true;
    }
    if (changedAny) notify();
  }, 150);
}

// 位图任何变化（画笔/撤销/重做）→ 防抖重生成被关注的迷你画布；
// 代理图缓存更新（没画过的层等到代理）→ 通知订阅者换 URL 平面。
subscribeBitmaps(() => scheduleRegen());
subscribePreview(() => notify());

/**
 * 迷你版的图层像素平面：迷你画布 → 代理 dataUrl → 原文件 URL（三级回退）。
 * render 期调用无副作用（不触发生成——生成都由订阅回调驱动）。
 */
/** 1×1 透明 PNG：注册过位图但还没烤/迷你画布还没生成的层用它占位——读一个
 * 不存在的烘焙路径只会 404 刷错误日志（新建空白层实测踩到），迷你画布马上就来。 */
const TRANSPARENT_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export function miniPixelUrlOf(layer: EditorLayer): string {
  const key = layerKey(layer.id);
  // 画过的层（位图在）：有代理用代理；烘焙文件已存在也可用；否则透明占位等迷你画布
  if (bitmapVersion(key) > 0) {
    const src = displaySourceOf(key, layer.source as string);
    const previewKey = buildLayerPreviewKey({ ...layer, source: src });
    const proxy = previewKey ? peekPreview(previewKey) : undefined;
    if (proxy) return proxy.dataUrl;
    const baked = bitmapMeta(key)?.bakedPath;
    if (baked) return convertFileSrc(baked);
    return TRANSPARENT_1PX;
  }
  return convertFileSrc(layer.source as string);
}
