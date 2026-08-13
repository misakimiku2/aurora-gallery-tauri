import { invoke, convertFileSrc } from '@tauri-apps/api/core';
import { Channel } from '@tauri-apps/api/core';
import { DominantColor } from '../../types';
import { performanceMonitor } from '../../utils/performanceMonitor';
import { getGlobalCache } from '../../utils/thumbnailCache';
import { _isAndroid, _globalCacheRoot, _upgradingThumbnails } from './state';
import { readFileAsBase64 } from './files';

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

  let cachePath: string;
  if (cachePathOverride && cachePathOverride.trim() !== '') {
    cachePath = cachePathOverride;
  } else if (rootPath && rootPath.trim() !== '' && rootPath !== 'android_media_store') {
    // 桌面端：缓存统一放在资源根目录下的 .Aurora_Cache（与图片缩略图一致），
    // 而非 _globalCacheRoot（AppData），避免文件夹图标与图片缓存路径分叉。
    cachePath = `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
  } else if (_globalCacheRoot) {
    cachePath = _globalCacheRoot;
  } else if (rootPath && rootPath.trim() !== '') {
    cachePath = `${rootPath}${rootPath.includes('\\') ? '\\' : '/'}.Aurora_Cache`;
  } else {
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
            colors,
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

/**
 * 从 Canvas ImageData 中提取主色调 (简单中值切分或频率统计)
 */
function extractColorsFromImageData(data: Uint8ClampedArray, count: number): DominantColor[] {
  const colorMap: Record<string, number> = {};
  const step = 4 * 4; // 步进抽样提高性能

  for (let i = 0; i < data.length; i += step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const a = data[i + 3];
    if (a < 128) continue; // 忽略透明像素

    // 简单的颜色量化，减少 key 数量 (每 8 位取高 5 位)
    const qr = r & 0xF8;
    const qg = g & 0xF8;
    const qb = b & 0xF8;
    const key = `${qr},${qg},${qb}`;
    colorMap[key] = (colorMap[key] || 0) + 1;
  }

  const sorted = Object.entries(colorMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, count);

  return sorted.map(([key, _]) => {
    const [r, g, b] = key.split(',').map(Number);
    const hex = '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');

    // 粗略计算 LAB (这里可以用更精准的库，若为了极速则保持此简版)
    const { l, a, b: lab_b } = rgbToLab(r, g, b);

    // 补充 DominantColor 必须的字段
    const rgb: [number, number, number] = [r, g, b];
    const isDark = (r * 0.299 + g * 0.587 + b * 0.114) < 128; // 感知亮度阈值

    return { hex, rgb, isDark, labL: l, labA: a, labB: lab_b, percentage: 0 }; // percentage 暂时设为 0
  });
}

function rgbToLab(r: number, g: number, b: number) {
  // 简化的 RGB -> LAB 转换逻辑
  let rf = r / 255, gf = g / 255, bf = b / 255;
  rf = rf > 0.04045 ? Math.pow((rf + 0.055) / 1.055, 2.4) : rf / 12.92;
  gf = gf > 0.04045 ? Math.pow((gf + 0.055) / 1.055, 2.4) : gf / 12.92;
  bf = bf > 0.04045 ? Math.pow((bf + 0.055) / 1.055, 2.4) : bf / 12.92;

  let x = (rf * 0.4124 + gf * 0.3576 + bf * 0.1805) * 100;
  let y = (rf * 0.2126 + gf * 0.7152 + bf * 0.0722) * 100;
  let z = (rf * 0.0193 + gf * 0.1192 + bf * 0.9505) * 100;

  x /= 95.047; y /= 100.0; z /= 108.883;
  x = x > 0.008856 ? Math.pow(x, 1 / 3) : (7.787 * x) + (16 / 116);
  y = y > 0.008856 ? Math.pow(y, 1 / 3) : (7.787 * y) + (16 / 116);
  z = z > 0.008856 ? Math.pow(z, 1 / 3) : (7.787 * z) + (16 / 116);

  return { l: (116 * y) - 16, a: 500 * (x - y), b: 200 * (y - z) };
}
