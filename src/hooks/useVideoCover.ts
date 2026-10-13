/**
 * 视频封面解析 hook（P1.5 消费方共用：面板大预览 / 标签预览 / 人物封面 / 专题封面 / 文件夹封面）。
 *
 * 行为：
 * - 非视频 / 无路径 → `{ isVideo: false, coverUrl: null }`，调用方走自己的图片分支；
 * - 视频 → 先同步查 getGlobalCache（命中且非视频自身 asset URL 直接返回），
 *   未命中再异步调 `getVideoCover` 生成（内部：磁盘缓存优先 → 前端抽帧 → 落库）。
 *
 * ⚠️ 三条红线（记忆 §2.1，动此文件前先读）：
 *   ① 消费方拿到的 coverUrl 只能是**封面 JPEG 的 URL**；本 hook 对
 *      「缓存值 === convertFileSrc(filePath)」的历史污染形态一律剔除；
 *   ② 抽帧失败 / 超时 / 不可解码容器 → coverUrl 保持 null，调用方降级占位图标，
 *      **绝不** fallback 到 convertFileSrc(filePath) 喂 <img>；
 *   ③ 远程路径（lan:// / android://）不抽帧（Thumbnail 需要本地文件），保持占位。
 */

import { useState, useEffect } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { getGlobalCache } from '../utils/thumbnailCache';
import { isVideoFile } from '../utils/mediaExtensions';
import { isRemotePath } from '../utils/remoteSource';

export interface UseVideoCoverResult {
  isVideo: boolean;
  /** 封面 JPEG 的 asset URL；未就绪 / 失败 / 非视频均为 null */
  coverUrl: string | null;
  /** 是否正在生成中（调用方可选用于骨架，但不强制） */
  loading: boolean;
}

export const useVideoCover = (
  filePath: string | undefined,
  resourceRoot?: string,
  format?: string,
  sizeBytes?: number
): UseVideoCoverResult => {
  const isVideo = !!filePath && isVideoFile(filePath, format);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!isVideo || !filePath || isRemotePath(filePath)) {
      setCoverUrl(null);
      setLoading(false);
      return;
    }

    // 同步缓存优先：网格 / 面板等其它消费方可能已生成过封面
    const cache = getGlobalCache();
    const videoUrl = convertFileSrc(filePath);
    const cached = cache.get(filePath);
    if (cached) {
      // 防御历史污染：缓存里绝不允许是视频自身的 asset:// 地址
      if (cached === videoUrl) {
        cache.delete(filePath);
      } else {
        setCoverUrl(cached);
        setLoading(false);
        return;
      }
    }

    const controller = new AbortController();
    let alive = true;
    setLoading(true);

    (async () => {
      try {
        // 动态导入避免 hooks → api/tauri-bridge 的循环依赖（与 ImageThumbnail 同款做法）
        const { getVideoCover } = await import('../api/tauri-bridge');
        const url = await getVideoCover(
          filePath,
          resourceRoot,
          controller.signal,
          undefined,
          undefined,
          sizeBytes
        );
        if (!alive) return;
        // 双保险：绝不让视频地址落到 <img>（见红线②）
        setCoverUrl(url && url !== videoUrl ? url : null);
      } catch {
        if (alive) setCoverUrl(null);
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
      controller.abort();
    };
  }, [isVideo, filePath, resourceRoot, sizeBytes]);

  return { isVideo, coverUrl, loading };
};

export default useVideoCover;
