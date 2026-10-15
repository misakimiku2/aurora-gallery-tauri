import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { Channel } from '@tauri-apps/api/core';
import { DominantColor } from '../../types';
import { performanceMonitor } from '../../utils/performanceMonitor';
import { getGlobalCache } from '../../utils/thumbnailCache';
import { _isAndroid, _globalCacheRoot, _upgradingThumbnails } from './state';
import { readFileAsBase64 } from './files';
// 主色提取已抽到 utils 共享：AVIF 回落 与 视频抽帧（P1.5）必须用同一套口径，否则色差不可控
import { extractColorsFromImageData } from '../../utils/dominantColors';
import { extractVideoCover } from '../../utils/videoCover';
import { isWebDecodableVideo } from '../../utils/mediaExtensions';
import { isFfmpegAvailable } from './ffmpeg';
import { isAbsolutePath } from '../../utils/pathUtils';
// 临时诊断（视频封面排查，取证后删）：前端分支事件转发进终端日志
import { feLog, feBaseName } from '../../utils/feLog';

// 批量请求管理器
class ThumbnailBatcher {
  private batch: Map<string, Array<{
    resolve: (value: string | null) => void;
    reject: (reason?: any) => void;
    cacheRoot: string;
    onColors?: (colors: DominantColor[] | null) => void;
    signal?: AbortSignal;
  }>> = new Map();
  private timeoutId: ReturnType<typeof setTimeout> | null = null;
  // 在飞批次计数：允许最多 MAX_INFLIGHT 批并行发送，新请求可立即进入
  // 新批次，不必等旧批次整批完成（后端信号量仍保证解码不超载）。
  private inflight = 0;
  private readonly BATCH_DELAY = 50; // 50ms 聚合时间
  // 每批最多发送的路径数：清空缓存重建时避免一批堆积过多请求，
  // 防止"视口上方已滚过的请求"占满后端并发，当前视口迟迟轮不到。
  private readonly MAX_BATCH_SIZE = 8;
  private readonly MAX_INFLIGHT = 2;
  // 待发送路径总数上限。文件夹封面预取的配额改为按布局密度动态推算后，
  // 单次扫描最多可提交数百个路径；长距离快速滚动会让 batch 无限膨胀，
  // 而 processBatch 每轮都要 O(n) 复制整个 Map 再 reverse。
  private readonly MAX_PENDING_PATHS = 4000;

  /**
   * 超过上限时丢弃最旧的路径 —— Map 保持插入顺序，而批次按「最新优先」
   * 发送，队首恰好是最旧、最可能早已滚出视口的请求（滚动预取的请求正是
   * 最早入队的那一批），丢弃它们代价最小。
   */
  private enforceLimit(): void {
    while (this.batch.size > this.MAX_PENDING_PATHS) {
      const oldest = this.batch.keys().next().value;
      if (oldest === undefined) break;
      const list = this.batch.get(oldest);
      this.batch.delete(oldest);
      if (list) {
        for (const r of list) r.resolve(null);
      }
    }
  }

  add(filePath: string, cacheRoot: string, onColors?: (colors: DominantColor[] | null) => void, signal?: AbortSignal): Promise<string | null> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        return resolve(null);
      }

      const handler = () => {
        // 如果在队列中被取消，尝试移除
        if (this.batch.has(filePath)) {
          const list = this.batch.get(filePath)!;
          const index = list.findIndex(r => r.resolve === resolve);
          if (index !== -1) {
            list.splice(index, 1);
            if (list.length === 0) this.batch.delete(filePath);
          }
        }
        resolve(null);
      }
      signal?.addEventListener('abort', handler);

      const request = {
        resolve: (val: string | null) => {
          signal?.removeEventListener('abort', handler);
          resolve(val);
        },
        reject: (err: any) => {
          signal?.removeEventListener('abort', handler);
          reject(err);
        },
        cacheRoot,
        onColors,
        signal
      };

      if (this.batch.has(filePath)) {
        this.batch.get(filePath)!.push(request);
      } else {
        this.batch.set(filePath, [request]);
        this.enforceLimit();
      }

      if (!this.timeoutId) {
        this.timeoutId = setTimeout(() => this.processBatch(), this.BATCH_DELAY);
      }
    });
  }

  private async processBatch() {
    this.timeoutId = null;
    // 有在飞批次时不重复调度（完成后会自己继续），
    // 但若 batch 非空且还有并发额度，则立即发送新批次。
    while (this.batch.size > 0 && this.inflight < this.MAX_INFLIGHT) {
      // 取出全部，最新优先（Map 插入顺序：旧在前、新在后，反转后新在前）
      const entries = Array.from(this.batch.entries()).reverse();
      this.batch.clear();

      const toSend = new Map(entries.slice(0, this.MAX_BATCH_SIZE));
      // 剩余放回，下一轮继续（仍然是"最新优先"选取）
      for (const [path, requests] of entries.slice(this.MAX_BATCH_SIZE)) {
        this.batch.set(path, requests);
      }

      // 过滤已取消的请求
      for (const [path, requests] of toSend) {
        const active = requests.filter(r => !r.signal?.aborted);
        if (active.length > 0) toSend.set(path, active);
        else toSend.delete(path);
      }
      if (toSend.size === 0) continue;

      this.inflight++;
      // fire-and-forget：不阻塞本循环，允许并行新批次（当前视口请求立即发送）
      this.sendBatch(toSend).finally(() => {
        this.inflight--;
        // 批次完成，若还有积压则继续调度下一批
        if (this.batch.size > 0 && this.inflight < this.MAX_INFLIGHT) {
          this.processBatch();
        }
      });
    }
  }

  private async sendBatch(currentBatch: Map<string, Array<{
    resolve: (value: string | null) => void;
    reject: (reason?: any) => void;
    cacheRoot: string;
    onColors?: (colors: DominantColor[] | null) => void;
    signal?: AbortSignal;
  }>>) {
    try {
      // 按照 cacheRoot 分组（保持优先级顺序）
      const batchesByRoot: Record<string, string[]> = {};

      for (const [path, items] of currentBatch.entries()) {
        const item = items[0]; // Use the first item's cacheRoot (assume same for same path)
        if (!batchesByRoot[item.cacheRoot]) {
          batchesByRoot[item.cacheRoot] = [];
        }
        batchesByRoot[item.cacheRoot].push(path);
      }

      // 并行发送所有分组的批量请求
      await Promise.all(Object.entries(batchesByRoot).map(async ([cacheRoot, paths]) => {
        // 临时诊断（取证后删）：本批发出的路径 basename 列表——定位「请求是否发出」
        feLog('batch', `send n=${paths.length} :: ${paths.map(feBaseName).join(' | ')}`);
        try {
          // 创建通道
          const channel = new Channel<{ path: string; url: string | null; colors?: DominantColor[] | null; fromCache?: boolean }>();

          // 监听通道消息 (流式结果！)
          channel.onmessage = ({ path, url, colors, fromCache }) => {
            const items = currentBatch.get(path);
            if (items) {
              if (url) {
                // Backend indicates whether it was served from disk cache
                if (fromCache) {
                  performanceMonitor.increment('thumbnailCacheHit');
                } else {
                  performanceMonitor.increment('thumbnailCacheMiss');
                }
                // 同时缓存原始路径（用于外部拖拽时作为图标）
                // 确保缓存存在，如果不存在则创建
                if (!(window as any).__AURORA_THUMBNAIL_PATH_CACHE__) {
                  // 简单的 LRU 缓存实现
                  const cache = new Map<string, { value: string; timestamp: number }>();
                  const maxSize = 1000;
                  (window as any).__AURORA_THUMBNAIL_PATH_CACHE__ = {
                    get: (key: string) => {
                      const item = cache.get(key);
                      if (item) {
                        cache.set(key, { ...item, timestamp: Date.now() });
                        return item.value;
                      }
                      return undefined;
                    },
                    set: (key: string, value: string) => {
                      if (cache.size >= maxSize) {
                        let oldestKey: string | null = null;
                        let oldestTime = Infinity;
                        for (const [k, v] of cache.entries()) {
                          if (v.timestamp < oldestTime) {
                            oldestTime = v.timestamp;
                            oldestKey = k;
                          }
                        }
                        if (oldestKey) cache.delete(oldestKey);
                      }
                      cache.set(key, { value, timestamp: Date.now() });
                    },
                    has: (key: string) => cache.has(key)
                  };
                }
                const pathCache = (window as any).__AURORA_THUMBNAIL_PATH_CACHE__;
                pathCache.set(path, url);

                const src = convertFileSrc(url);
                // 无论请求方是否已 abort（滚动离开视口），后端已生成缩略图，
                // 无条件写入内存缓存：组件滚动回来重新挂载时可直接命中，
                // 避免"磁盘缓存已有但前端不显示、需再次滚动才触发"的问题。
                const globalCache = getGlobalCache();
                if (globalCache.get(path) !== src) {
                  globalCache.set(path, src);
                }
                items.forEach(item => {
                  if (!item.signal?.aborted) item.resolve(src);
                });
              } else {
                items.forEach(item => {
                  if (!item.signal?.aborted) item.resolve(null);
                });
              }

              // 回调颜色数据
              if (colors) {
                items.forEach(item => {
                  if (item.onColors && !item.signal?.aborted) item.onColors(colors);
                });
              } else {
                items.forEach(item => {
                  if (item.onColors && !item.signal?.aborted) item.onColors(null);
                });
              }
            }
          };

          // 调用 Rust 的流式批量接口
          await invoke('get_thumbnails_batch', {
            filePaths: paths,
            cacheRoot: cacheRoot,
            onEvent: channel // 传递通道
          });
        } catch (err) {
          console.error('Batch processing failed:', err);
          // 局部失败
          paths.forEach(path => {
            const items = currentBatch.get(path);
            if (items) {
              items.forEach(item => {
                item.resolve(null);
                if (item.onColors) item.onColors(null);
              });
            }
          });
        }
      }));

    } catch (error) {
      console.error('Global batch error:', error);
      // 全局失败
      for (const items of currentBatch.values()) {
        items.forEach(item => {
          item.resolve(null);
          if (item.onColors) item.onColors(null);
        });
      }
    }
  }
}

const thumbnailBatcher = new ThumbnailBatcher();

/**
 * 解析缩略图缓存目录（`getThumbnail` / `getVideoCover` 共用）。
 *
 * ⚠️ `rootPath` 必须是**绝对路径**。历史事故（2026-10-14 实测）：有调用方把根节点的
 * `id`（= `pathUtils.generateId` = `md5(path)[0..9]`，9 位 hex，如 `491b65a0d`）当成资源根传入
 * → 拼出的 `${id}/.Aurora_Cache` 是**相对路径** → 在 cwd 下建出游离缓存目录
 * （`src-tauri/<id>/.Aurora_Cache`），且封面永远命中不了正确缓存。
 * 这里显式拦截：非绝对路径一律忽略并回退全局缓存根，同时打印 error 便于定位调用方。
 */
function resolveThumbCachePath(rootPath: string | undefined, override?: string): string {
  if (override && override.trim() !== '') return override;

  if (rootPath && rootPath.trim() !== '' && rootPath !== 'android_media_store') {
    if (isAbsolutePath(rootPath)) {
      // 桌面端：缓存统一放在资源根目录下的 .Aurora_Cache（与图片缩略图一致），
      // 而非 _globalCacheRoot（AppData），避免文件夹图标与图片缓存路径分叉。
      return `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
    }
    console.error(
      '[Thumbnail] rootPath 不是绝对路径（疑似把节点 id 当资源根传入），已忽略并回退全局缓存:',
      rootPath
    );
    return _globalCacheRoot || '';
  }

  // android_media_store 或未提供 rootPath：优先全局缓存根
  if (_globalCacheRoot) return _globalCacheRoot;

  // 兜底：仅 android_media_store 会走到这里（其缓存根约定为 <root>/.Aurora_Cache）
  if (rootPath && rootPath.trim() !== '') {
    return `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
  }
  return '';
}

/**
 * 获取图片缩略图
 * @param filePath 图片文件路径
 * @param modified 文件修改时间（可选，用于缓存）
 * @param rootPath 资源根目录路径（可选，用于计算缓存目录）
 * @param signal AbortSignal (可选，用于取消请求)
 * @param onColors 颜色提取回调（可选）
 * @param cachePathOverride 缓存目录路径覆盖（可选，Android 端使用后端返回的 cacheRoot）
 * @returns 缩略图 Asset URL，如果失败则返回 null
 */
export const androidThumbnailNavigate = async (): Promise<void> => {
  if (!_isAndroid) return;
  try {
    await invoke('android_thumbnail_navigate');
  } catch {}
};

export const getThumbnail = async (filePath: string, modified?: string, rootPath?: string, signal?: AbortSignal, onColors?: (colors: DominantColor[] | null) => void, cachePathOverride?: string, mediaStoreId?: number): Promise<string | null> => {
  if (!filePath || filePath.trim() === '') return null;

  const cachePath = resolveThumbCachePath(rootPath, cachePathOverride);
  if (!cachePath) {
    console.error('[Thumbnail] No cache path available: cachePathOverride=', cachePathOverride, '_globalCacheRoot=', _globalCacheRoot, 'rootPath=', rootPath);
    return null;
  }

  if (_isAndroid) {
    const timerId = performanceMonitor.start('getThumbnail', undefined, true);
    try {
      const result = await invoke<{ path: string; thumbnailPath: string | null; width: number; height: number; upgrading: boolean } | null>(
        'android_get_thumbnail',
        { filePath, cacheRoot: cachePath, imageId: mediaStoreId ?? null }
      );
      if (result?.thumbnailPath) {
        const src = convertFileSrc(result.thumbnailPath);
        if (result.upgrading) {
          _upgradingThumbnails.add(filePath);
        }
        performanceMonitor.end(timerId, 'getThumbnail', { success: true });
        return src;
      }
      performanceMonitor.end(timerId, 'getThumbnail', { success: false });
      return null;
    } catch (err) {
      performanceMonitor.end(timerId, 'getThumbnail', { success: false, error: true });
      return null;
    }
  }

  const timerId = performanceMonitor.start('getThumbnail', undefined, true);
  try {
    const res = await thumbnailBatcher.add(filePath, cachePath, onColors, signal);

    if (!res && filePath.toLowerCase().endsWith('.avif') && !signal?.aborted) {
      const remoteRes = await generateAvifThumbnailAndColors(filePath, cachePath, onColors);
      performanceMonitor.end(timerId, 'getThumbnail', { success: !!remoteRes, fallback: true });
      return remoteRes;
    }

    performanceMonitor.end(timerId, 'getThumbnail', { success: !!res });
    return res;
  } catch (err) {
    performanceMonitor.end(timerId, 'getThumbnail', { success: false, error: true });
    throw err;
  }
};

/**
 * [FALLBACK] 前端辅助生成 AVIF 缩略图和主色调
 * 利用 WebView2 原生解码能力，生成后通过 save_remote_thumbnail 同步到后端
 */
const generateAvifThumbnailAndColors = async (
  filePath: string,
  cachePath: string,
  onColors?: (colors: DominantColor[] | null) => void
): Promise<string | null> => {
  try {
    // 1. 获取原始 Base64 (WebView2 原生支持)
    const rawBase64 = await readFileAsBase64(filePath);
    if (!rawBase64) return null;

    // 2. 使用 Canvas 缩放
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = async () => {
        const canvas = document.createElement('canvas');
        const TARGET_SIZE = 256;
        let w = img.width;
        let h = img.height;

        if (w < h) {
          h = Math.round((h * TARGET_SIZE) / w);
          w = TARGET_SIZE;
        } else {
          w = Math.round((w * TARGET_SIZE) / h);
          h = TARGET_SIZE;
        }

        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) return resolve(null);

        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, w, h);

        // 3. 提取颜色 (简单实现核心逻辑，或者使用第三方库，这里为了轻量化手动取样)
        const imageData = ctx.getImageData(0, 0, w, h).data;
        const colors = extractColorsFromImageData(imageData, 8);
        if (onColors) onColors(colors);

        // 4. 导出缩略图 Base64 (提升质量)
        const thumbBase64 = canvas.toDataURL('image/jpeg', 0.9);

        // 5. 同步回后端保存
        try {
          // 调用刚才在 Rust 中新增的命令
          const savedPath = await invoke<string>('save_remote_thumbnail', {
            filePath,
            thumbnailData: thumbBase64,
            colors: toRustColors(colors as DominantColorWithLab[]),
            cacheRoot: cachePath
          });

          if (savedPath) {
            const assetUrl = convertFileSrc(savedPath);
            // 更新本地路径缓存，防止 getDominantColors 再次触发
            (window as any).__AURORA_THUMBNAIL_PATH_CACHE__?.set(filePath, savedPath);
            resolve(assetUrl);
          } else {
            resolve(null);
          }
        } catch (e) {
          console.error('Failed to save remote thumbnail:', e);
          resolve(null);
        }
      };
      img.onerror = () => resolve(null);
      img.src = rawBase64;
    });
  } catch (error) {
    console.error('generateAvifThumbnailAndColors failed:', error);
    return null;
  }
};

// extractColorsFromImageData / rgbToLab 已于 P1.5 抽出到 '../../utils/dominantColors'
// —— AVIF 回落与视频抽帧共用同一份实现，避免两份拷贝出现色差。
import { DominantColorWithLab } from '../../utils/dominantColors';

/**
 * TS → Rust 的取色结构转换。
 *
 * ⚠️ Rust `ColorResult`（core/src/color_extractor.rs）是 **snake_case**：
 * `lab_l / lab_a / lab_b / is_dark`，且四个字段全都不是 Option —— serde 反序列化
 * 缺任何一个直接报错。TS 侧对象是 `labL/labA/labB/isDark`，
 * **不转换就 100% 落库失败**（封面抽成功了也被这一步拦下，2026-10-14 实测）。
 * AVIF 回落路径此前同样踩在这里（`colors` 原样透传）。
 */
const toRustColors = (colors: DominantColorWithLab[]) =>
  colors.map((c) => ({
    hex: c.hex,
    rgb: c.rgb,
    lab_l: c.labL ?? 0,
    lab_a: c.labA ?? 0,
    lab_b: c.labB ?? 0,
    is_dark: c.isDark,
  }));

/**
 * 视频封面（P1.5-A）：与 AVIF 回落同构，只是源头从 `<img>` 换成 `<video>` + seek。
 *
 * 链路：`<video>` seek 到非黑帧 → canvas 缩到短边 256 → 取主色 → save_remote_thumbnail 落进
 * **同一套缓存命名**（后端按 size+mtime+首 4096 字节算 md5），因此六个封面消费方无需改动。
 *
 * ⚠️ 写进缓存的必须是这里返回的**封面 JPEG 路径**，绝不能是源视频路径
 * （见记忆 §2.1：`asset://*.mp4` 一旦进缓存，所有卡片都会把它喂给 `<img>` 破图，
 * 对 GB 级文件还会引发海量读取与 WebView2 崩溃）。
 */
const generateVideoCoverAndColors = async (
  filePath: string,
  cachePath: string,
  onColors?: (colors: DominantColor[] | null) => void,
  signal?: AbortSignal,
  sizeBytes?: number
): Promise<string | null> => {
  try {
    const result = await extractVideoCover(filePath, { sizeBytes, signal });
    if (!result) return null;

    if (onColors) onColors(result.colors);

    const savedPath = await invoke<string>('save_remote_thumbnail', {
      filePath,
      thumbnailData: result.dataUrl,
      colors: toRustColors(result.colors),
      cacheRoot: cachePath,
    });

    if (!savedPath) return null;
    const assetUrl = convertFileSrc(savedPath);
    // 回填路径缓存，避免下一次挂载又触发抽帧
    getGlobalCache().set(filePath, assetUrl);
    // 主色提取链路（MetadataPanel / PaletteSection 的 getDominantColors）从
    // __AURORA_THUMBNAIL_PATH_CACHE__ 取封面**文件路径**交给 Rust image::open——
    // 视频也必须回填（存原始 savedPath，不是 asset URL），与 AVIF 回落路径同口径。
    (window as any).__AURORA_THUMBNAIL_PATH_CACHE__?.set(filePath, savedPath);
    return assetUrl;
  } catch (error) {
    console.error('[VideoCover] generateVideoCoverAndColors failed:', error);
    return null;
  }
};

/**
 * 视频封面入口（P1.5-A 建立，P1.5-B S3 改为后端优先）。
 *
 * **B 口径**：封面主生成方是后端 ffmpeg 管线（`get_thumbnails_batch` 视频分支，
 * 覆盖**所有** 12 种容器，缓存未命中时自动生成）；本函数保留前端 canvas 抓帧
 * 作为「无 ffmpeg 时的兜底」（仅 mp4/m4v/mov/webm，`extractVideoCover` 内部门禁）。
 * 链路：磁盘缓存/后端生成优先 → 无 ffmpeg 或后端失败 → 前端兜底 → 失败分诊进负缓存。
 */
// 在途请求去重：同一个视频在短时间内会被多个 effect 实例重复请求
// （2026-10-14 实测日志：每张卡片因视口状态变化触发了 3 次），
// 抽帧是串行的，不去重等于把同一帧抽三遍。
const inflightVideoCovers = new Map<string, Promise<string | null>>();

// 失败负缓存：抽帧失败的文件在 60s 内不再重试。
// 4500 文件夹实测教训：失败没有任何记忆时，滚动中每次挂载都会重新排队抽一遍，
// 串行队列被重复请求冲垮，越滚越糟。只缓存在内存（失败可能是暂态的：IO 竞争、超时），
// 下次会话或 60s 后照常重试。
const failedVideoCovers = new Map<string, number>();
const VIDEO_COVER_NEGATIVE_CACHE_MS = 60_000;

export const getVideoCover = async (
  filePath: string,
  rootPath?: string,
  signal?: AbortSignal,
  onColors?: (colors: DominantColor[] | null) => void,
  cachePathOverride?: string,
  sizeBytes?: number
): Promise<string | null> => {
  if (!filePath || filePath.trim() === '') return null;
  if (signal?.aborted) return null;

  const __n = feBaseName(filePath);
  feLog('video', `req ${__n}`);

  const inflight = inflightVideoCovers.get(filePath);
  if (inflight) {
    feLog('video', `inflight-hit ${__n}`);
    return inflight;
  }

  const failedAt = failedVideoCovers.get(filePath);
  if (failedAt && Date.now() - failedAt < VIDEO_COVER_NEGATIVE_CACHE_MS) {
    feLog('video', `negcache-hit ${__n}`);
    return null;
  }

  const work = (async (): Promise<string | null> => {
  const cachePath = resolveThumbCachePath(rootPath, cachePathOverride);

  if (!cachePath) return null;

  // 磁盘缓存优先（P1.5 消费方扩容后补的缺口）：
  // 抽帧结果以前抽过就落在 <cacheRoot>/.Aurora_Cache 里（与图片缩略图同一套命名），
  // 复用图片批处理管线里的 Rust `find_existing_video_cover` 查一次即可——
  // 命中直接返回封面 JPEG，**不重新抽帧**。否则每次重启 / 每次新消费方挂载
  // 都会把整个文件夹的视频重新 serial 抽一遍（4500 文件夹场景不可忍）。
  // 安卓端不走这条（本地文件语义不同，且抽帧链路本身也不覆盖安卓）。
  if (!_isAndroid) {
    try {
      const cached = await getThumbnail(filePath, undefined, undefined, signal, undefined, cachePath);
      feLog('video', `thumb ${cached ? 'hit' : 'miss'} ${__n}`);
      // 双保险：缓存里绝不允许是视频自身的 asset:// 地址（记忆 §2.1 污染形态）
      if (cached && cached !== convertFileSrc(filePath)) {
        return cached;
      }
    } catch {
      // 磁盘查询失败不阻断抽帧主链路
      feLog('video', `thumb throw ${__n}`);
    }
    if (signal?.aborted) return null;
  }

  const timerId = performanceMonitor.start('getVideoCover', undefined, true);
  try {
    const res = await generateVideoCoverAndColors(filePath, cachePath, onColors, signal, sizeBytes);
    feLog('video', `gen ${res ? 'ok' : 'null'} ${__n}`);
    performanceMonitor.end(timerId, 'getVideoCover', { success: !!res });
    return res;
  } catch (err) {
    performanceMonitor.end(timerId, 'getVideoCover', { success: false, error: true });
    return null;
  }
  })();

  inflightVideoCovers.set(filePath, work);
  try {
    const res = await work;
    if (res) {
      failedVideoCovers.delete(filePath);
      feLog('video', `done ok ${__n}`);
    } else {
      // 修复（2026-10-15 排障）：aborted 的「失败」不进负缓存——那是快速滚动时
      // 请求被批处理剔除的正常结果（后端根本没收到），下次挂载自然重试即可；
      // 写负缓存会把「滚动路过」误当「生成失败」，叠加「停下不重试」→ 永久空白。
      if (signal?.aborted) {
        feLog('video', `done null(aborted,no-negcache) ${__n}`);
        return res;
      }
      // 失败分诊（P1.5-B S3）：封面主生成方已是后端 ffmpeg 管线（B 口径）。
      // 「无 ffmpeg + 前端也解不了的容器」（mkv/avi/…）在下载 ffmpeg 前注定拿不到封面，
      // **不进负缓存**——否则 S4 下载完成后 60s 内仍不生成（计划 §6 风险表明确要求核对）。
      // 无 ffmpeg 时后端 locate 短路（纯路径检查，无 spawn），反复试探开销可忽略。
      // 其余失败（canvas 兜底超时 / 有 ffmpeg 但 extract 失败的坏文件）照旧进负缓存防风暴。
      if (!isWebDecodableVideo(filePath) && !(await isFfmpegAvailable())) {
        feLog('video', `done null(no-ffmpeg,no-negcache) ${__n}`);
        return res;
      }
      failedVideoCovers.set(filePath, Date.now());
      feLog('video', `done null(negcache-set) ${__n}`);
    }
    return res;
  } finally {
    inflightVideoCovers.delete(filePath);
  }
};
