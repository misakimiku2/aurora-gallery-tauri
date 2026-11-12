// 已调整文件的模块级注册表(轻量快调 §5)。
//
// 消费方:
// 1. 网格角标(ImageThumbnail 按 filePath 订阅);
// 2. AVIF 兜底缩略图生成器(thumbnail.ts 按 filePath 取参数,canvas 套用后回写,
//    保证缓存键里的 adjust_tag 与内容一致);
// 3. 查看器 useImageAdjust(保存/清除时写入本表,网格即时联动)。
//
// 键 = 归一化路径(反斜杠统一为斜杠;Rust 侧 get_params_by_path 两种形态都兼容)。
// 启动引导走 edit_get_all_params(带 path,LEFT JOIN file_index),只有调过的图才有行。

import { useEffect, useState } from 'react';
import { editGetAllParams } from '../api/tauri-bridge/edits';
import { AdjustParams, sanitizeAdjustParams } from './adjust';

export const normalizeAdjustPath = (p?: string | null): string =>
  (p || '').replace(/\\/g, '/');

const paramsByPath = new Map<string, AdjustParams>();
const listeners = new Set<() => void>();
let version = 0;
let bootstrapPromise: Promise<void> | null = null;

const notify = (): void => {
  version++;
  listeners.forEach((fn) => fn());
};

export function getAdjustParams(path?: string | null): AdjustParams | null {
  if (!path) return null;
  return paramsByPath.get(normalizeAdjustPath(path)) || null;
}

export function hasAdjust(path?: string | null): boolean {
  return getAdjustParams(path) !== null;
}

export function setAdjustParams(path: string | null | undefined, params: AdjustParams | null): void {
  const key = normalizeAdjustPath(path);
  if (!key) return;
  if (params) paramsByPath.set(key, params);
  else paramsByPath.delete(key);
  notify();
}

export function subscribeAdjust(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function getAdjustVersion(): number {
  return version;
}

/** 应用启动时拉一次(只有调整过的行,量级可控);重复调用幂等。 */
export function bootstrapAdjustStore(): Promise<void> {
  if (bootstrapPromise) return bootstrapPromise;
  bootstrapPromise = editGetAllParams()
    .then((entries) => {
      for (const e of entries) {
        if (!e.path) continue;
        try {
          const parsed = sanitizeAdjustParams(JSON.parse(e.params));
          paramsByPath.set(normalizeAdjustPath(e.path), parsed);
        } catch {
          // 损坏行忽略(后端 bake/get 侧同样按损坏处理)
        }
      }
      notify();
    })
    .catch((e) => {
      console.warn('[adjustStore] bootstrap failed:', e);
      bootstrapPromise = null; // 失败允许重试
    });
  return bootstrapPromise;
}

/** 订阅某路径的调整状态变化(useSyncExternalStore 兼容的快照 = version)。 */
export function useAdjustVersion(path?: string | null): number {
  const [v, setV] = useState(() => version);
  useEffect(() => {
    const update = () => setV(version);
    update(); // 订阅时先对齐当前版本(bootstrap 可能已晚于挂载)
    return subscribeAdjust(update);
  }, [path]);
  return v;
}
