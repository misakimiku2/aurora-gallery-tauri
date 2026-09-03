// Sprite 完整位图合成的 Web Worker（对应 spriteCache 的 full 合成）。
//
// 目标：把 composeFull（预览图解码 createImageBitmap + OffscreenCanvas 绘制 + 角标）
// 全部移出主线程 —— 滚动停止后的 idle 排空不再占用主线程，滚动帧稳定性更好。
// 主线程保留：静态 staticBody 兜底（同步、即时显示）、悬停动画、layerCache。
//
// 协议：
//   主线程 → worker: { type: 'compose', reqId, previewSrcs, count, category, theme, size, dpr }
//   worker → 主线程: { type: 'result', reqId, bmp: ImageBitmap }（transferable）或 { bmp: null }
//
// 说明：worker 无 HTMLImageElement/window。解码用 createImageBitmap(src)；
// 失败/超时按 src 冷却，避免反复触发 5s 解码卡住排水节奏。

/// <reference lib="webworker" />
import { composeFull, type IconCategory, type IconTheme } from '../utils/spriteComposer';
import { spriteDiag, setDiagSrcPrefix } from '../utils/spriteDiag';

// worker 与主线程各持有一份 spriteDiag 状态，src 短 id 必须错开前缀，否则图例会对不上号
setDiagSrcPrefix('W');

// 避免 lib.dom 与 lib.webworker 类型冲突，worker 侧使用最小 self 类型
const sw = self as unknown as {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent) => void) | null;
};

interface ComposePayload {
  type: 'compose';
  reqId: number;
  previewSrcs: string[];
  count: number | undefined;
  category: IconCategory;
  theme: IconTheme;
  size: number;
  dpr: number;
  folderId?: string; // 仅用于诊断关联
}

const DECODE_TIMEOUT_MS = 5000;
const SRC_COOLDOWN_MS = 8000;
const srcCooldown = new Map<string, number>();

const isCooling = (src: string): boolean => {
  const until = srcCooldown.get(src);
  if (until === undefined) return false;
  if (performance.now() < until) return true;
  srcCooldown.delete(src);
  return false;
};

// 解码结果写入 worker 本地 spriteDiag（每次合成结束后由 drainAll() 统一回传主线程）。
const decodeImage = (src: string): Promise<ImageBitmap | null> =>
  new Promise(resolve => {
    const startedAt = performance.now();
    const record = (ok: boolean, reason: string) => {
      spriteDiag.srcResult(src, ok, reason, performance.now() - startedAt);
    };
    if (!src) { resolve(null); return; }
    if (isCooling(src)) {
      // 与主线程同构：冷却期内直接跳过，不发起真实请求（诊断 case c）
      record(false, '冷却中·跳过请求');
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      srcCooldown.set(src, performance.now() + SRC_COOLDOWN_MS);
      record(false, `解码超时(>${DECODE_TIMEOUT_MS}ms)`);
      resolve(null);
    }, DECODE_TIMEOUT_MS);
    // worker 无 HTMLImageElement：先 fetch 为 blob 再解码（自定义协议不支持时 fetch
    // 会 reject → 走 null → 主线程能力探针检测到后回退内联合成）
    fetch(src)
      .then(r => (r.ok ? r.blob() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(createImageBitmap)
      .then(bmp => {
        clearTimeout(timer);
        srcCooldown.delete(src);
        record(true, 'ok');
        resolve(bmp);
      })
      .catch((err: unknown) => {
        clearTimeout(timer);
        srcCooldown.set(src, performance.now() + SRC_COOLDOWN_MS);
        // 关键诊断点（case d）：worker 内 fetch 自定义协议(asset://)失败的具体原因
        record(false, `fetch失败(${err instanceof Error ? err.message : String(err)})`);
        resolve(null);
      });
  });

const decodeAll = (srcs: string[]): Promise<(ImageBitmap | null)[]> =>
  Promise.all(srcs.map(decodeImage));

sw.onmessage = (e: MessageEvent) => {
  const data = (e.data || {}) as ComposePayload;
  if (data.type !== 'compose') return;
  const { reqId, previewSrcs, count, category, theme, size, dpr, folderId } = data;
  composeFull(
    previewSrcs || [],
    count,
    category,
    theme,
    size,
    dpr,
    undefined, // back/front 由 worker 自己合成（离主线程）
    undefined, // 无需滚动打断：worker 不占主线程
    decodeAll,
    folderId
  )
    .then(bmp => {
      // 合成级判定（no-srcs / all-or-nothing）发生在 worker 内，必须回传否则主线程永远看不到
      const diag = spriteDiag.drainAll();
      if (bmp) sw.postMessage({ type: 'result', reqId, bmp, diag }, [bmp]);
      else sw.postMessage({ type: 'result', reqId, bmp: null, diag });
    })
    .catch(() => {
      sw.postMessage({ type: 'result', reqId, bmp: null, diag: spriteDiag.drainAll() });
    });
};