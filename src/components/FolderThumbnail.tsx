
import React, { useState, useMemo, useRef, useEffect } from 'react';
import { FileNode, FileType, LayoutMode } from '../types';
import { useInView } from '../hooks/useInView';
import { getGlobalCache } from '../utils/thumbnailCache';
import { performanceMonitor } from '../utils/performanceMonitor';
import { Folder, ImageIcon } from 'lucide-react';
import { Folder3DIcon } from './Folder3DIcon';
import { Folder3DIconCanvas } from './Folder3DIconCanvas';
import { isSpriteSupportedSafe } from '../utils/spriteCache';
import { isThumbnailUpgrading } from '../api/tauri-bridge';
import { GetFileNode } from './useLayoutHook';
import { isRemotePath, getRemoteThumbnailUrl, subscribeRemoteChange } from '../utils/remoteSource';

// 模块级 DFS 结果缓存：快速滚动时虚拟化会反复卸载/重挂载同一个文件夹卡片，
// 每次挂载都执行 findImagesDeeply 深搜整棵子树 + localeCompare 排序会占用渲染期主线程。
// 用 children 指纹（数量 + 头尾 id + 文件夹自身 updatedAt）判断内容是否变化，变化才重算。
const _deepImageCache = new Map<string, { fingerprint: string; images: FileNode[] }>();

const childrenFingerprint = (rootFolder: FileNode): string => {
    const kids = rootFolder.children || [];
    const first = kids[0] || '';
    const last = kids[kids.length - 1] || '';
    return `${kids.length}|${first}|${last}|${rootFolder.updatedAt || rootFolder.createdAt || ''}`;
};

const findImagesDeeply = (
    rootFolder: FileNode,
    getFileNode: GetFileNode,
    limit: number = 3
): FileNode[] => {
    const fp = childrenFingerprint(rootFolder);
    const cached = _deepImageCache.get(rootFolder.id);
    if (cached && cached.fingerprint === fp) return cached.images;

    const images: FileNode[] = [];
    const stack: string[] = [...(rootFolder.children || [])];
    const visited = new Set<string>();

    let traversalCount = 0;
    const MAX_TRAVERSAL = 500;

    while (stack.length > 0 && traversalCount < MAX_TRAVERSAL) {
        const id = stack.pop()!;
        if (visited.has(id)) continue;
        visited.add(id);
        traversalCount++;

        const node = getFileNode(id);
        if (!node) continue;

        if (node.type === FileType.IMAGE) {
            images.push(node);
        } else if (node.type === FileType.FOLDER && node.children) {
            stack.push(...node.children);
        }
    }

    const result = images
        .sort((a, b) => (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || ''))
        .slice(0, limit);
    _deepImageCache.set(rootFolder.id, { fingerprint: fp, images: result });
    return result;
};

/**
 * 文件夹角标数量：远程文件夹（安卓/LAN）的子节点通常尚未加载（children 为空数组），
 * 必须优先用服务端下发的 imageCount，否则角标会显示 0。
 */
const folderItemCount = (file: FileNode): number | undefined =>
  file.imageCount ?? (file.children?.length || undefined);

const AndroidFolderPlaceholder: React.FC<{ file: FileNode }> = React.memo(({ file }) => {
const count = folderItemCount(file) ?? 0;
  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-gradient-to-br from-gray-50 to-gray-200 dark:from-gray-800 dark:to-gray-750">
      <Folder size={48} className="text-gray-400 dark:text-gray-500" strokeWidth={1.2} />
      {count > 0 && (
        <div className="mt-1 flex items-center gap-0.5 text-gray-400 dark:text-gray-500">
          <ImageIcon size={10} />
          <span className="text-[10px]">{count}</span>
        </div>
      )}
    </div>
  );
});

export const FolderThumbnail = React.memo(({ file, getFileNode, mode, resourceRoot, cachePath, folderIconStyle }: { file: FileNode; getFileNode: GetFileNode, mode: LayoutMode, resourceRoot?: string, cachePath?: string, folderIconStyle?: 'classic' | 'tiles' | 'canvas' }) => {
  const isAndroid = resourceRoot === 'android_media_store';
  const [ref, isInView, wasInView] = useInView({ rootMargin: '600px' });

  const imageChildren = useMemo(() => {
      if (!file.children || file.children.length === 0) return [];
      return findImagesDeeply(file, getFileNode, 3);
  }, [file, getFileNode]);

  // 远程文件夹（安卓设备 / LAN）：封面来自设备的远程缩略图接口，
  // 本地 getThumbnail 无法生成，且子节点通常尚未展开（imageChildren 为空）。
  // 与本地文件夹一致，最多取 3 张做堆叠封面。
  const remoteCoverPaths = useMemo(() => {
      const fromNode = (file.coverImagePaths || []).filter(isRemotePath).slice(0, 3);
      if (fromNode.length > 0) return fromNode;
      if (isRemotePath(file.coverImagePath)) return [file.coverImagePath as string];
      const remoteChildren = imageChildren.filter((img) => isRemotePath(img.path)).slice(0, 3);
      return remoteChildren.length > 0 ? remoteChildren.map((img) => img.path) : undefined;
  }, [file.coverImagePath, file.coverImagePaths, imageChildren]);

  const [remoteCoverSrcs, setRemoteCoverSrcs] = useState<string[]>(() =>
      remoteCoverPaths ? remoteCoverPaths.map(getRemoteThumbnailUrl) : []
  );

  useEffect(() => {
      if (!remoteCoverPaths) {
        setRemoteCoverSrcs((prev) => (prev.length === 0 ? prev : []));
        return;
      }
      const refresh = () => setRemoteCoverSrcs(remoteCoverPaths.map(getRemoteThumbnailUrl));
      refresh();
      // 设备重连 / token 刷新后 URL 会变，需要重新解析
      return subscribeRemoteChange(refresh);
  }, [remoteCoverPaths]);

  const [previewSrcs, setPreviewSrcs] = useState<string[]>(() => {
      const cache = getGlobalCache();
      const cachedUrls = imageChildren.map(child => {
          return cache.get(child.path) || null; 
      });
      return cachedUrls.filter((url): url is string => !!url);
  });

  const [upgradingPaths, setUpgradingPaths] = useState<Set<string>>(() => {
    const set = new Set<string>();
    imageChildren.forEach(img => {
      if (isThumbnailUpgrading(img.path)) set.add(img.path);
    });
    return set;
  });

  const previewCountedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const cache = getGlobalCache();
    imageChildren.forEach(img => {
      if (cache.get(img.path) && !previewCountedRef.current.has(img.path)) {
        performanceMonitor.increment('thumbnailCacheHit');
        previewCountedRef.current.add(img.path);
      }
    });
  }, [imageChildren]);

  // 本地可生成缩略图的子节点（远程路径交由远程缩略图接口处理）
  const localImageChildren = useMemo(
    () => imageChildren.filter((img) => !isRemotePath(img.path)),
    [imageChildren]
  );

  useEffect(() => {
    // 远程封面：直接走远程缩略图 URL，无需本地生成
    if (remoteCoverPaths) return;
    // 组件被虚拟化渲染即表示在视口附近，直接加载（不依赖 IntersectionObserver，
    // 否则快速滚动时 observer 回调延迟会导致缩略图永远不加载）
    if (!resourceRoot || localImageChildren.length === 0) return;
    const expected = Math.min(3, localImageChildren.length);
    // 已填满 → 无需再请求（previewSrcs 变化会重跑本 effect，未满则继续补）
    if (previewSrcs.length === expected) return;

    // 修复「重启/硬刷新后图源一直为空 → 灰卡」：
    //  1) 不再把 AbortSignal 传给 getThumbnail —— effect cleanup / 虚拟化卸载不会中断
    //     底层缩略图生成。ThumbnailBatcher 生成成功会无条件写入 getGlobalCache，
    //     卡片滚动回来重新挂载时即可直接命中，无需再次滚动触发。
    //  2) 只保护本组件的 setState/重试链（alive 标志），卸载后不再 setState。
    //  3) 启动期后端忙于批量颜色/扫描时可能一次拿不到 → 有界退避补试。
    let alive = true;
    let attempt = 0;
    const RETRY_DELAYS = [1500, 4000, 9000];

    const loadPreviews = async () => {
      if (!alive) return;
      try {
        const { getThumbnail } = await import('../api/tauri-bridge');

        const promises = localImageChildren.map(async (img: FileNode) => {
            const cache = getGlobalCache();
            const cached = cache.get(img.path);
            if (cached) {
                return cached;
            }

            const url = await getThumbnail(img.path, img.updatedAt, resourceRoot, undefined, undefined, undefined, img.mediaStoreId);
            if (url) {
                cache.set(img.path, url);
                const isUpgrading = isThumbnailUpgrading(img.path);
                if (isUpgrading) {
                  setUpgradingPaths(prev => new Set(prev).add(img.path));
                }
            }
            return url;
        });

        const thumbnails = await Promise.all(promises);
        if (!alive) return; // 已卸载/被新一轮 effect 取代：只留缓存，不碰 setState

        const validThumbnails = thumbnails.filter((t): t is string => !!t);
        setPreviewSrcs(prev => {
            if (prev.length === validThumbnails.length && prev.every((val, index) => val === validThumbnails[index])) {
                return prev;
            }
            return validThumbnails;
        });

        // 未填满且还在线 → 稍后补试（坏文件返回 null 会被过滤，补试次数有界）
        if (validThumbnails.length < expected && attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt];
          attempt++;
          setTimeout(() => { if (alive) void loadPreviews(); }, delay);
        }
      } catch (error) {
        if (!alive) return;
        console.error('Failed to load folder previews:', error);
        if (attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt];
          attempt++;
          setTimeout(() => { if (alive) void loadPreviews(); }, delay);
        }
      }
    };

    void loadPreviews();

    return () => {
      alive = false;
      // 不再 controller.abort()：底层生成继续，完成后写入 getGlobalCache 供下次挂载命中
    };
  }, [isInView, wasInView, localImageChildren, resourceRoot, previewSrcs.length, remoteCoverPaths, file.id]);

  useEffect(() => {
    const handler = (e: Event) => {
      const { filePath, thumbnailSrc } = (e as CustomEvent).detail;
      const matchIndex = imageChildren.findIndex(img => img.path === filePath);
      console.log('[FolderThumbnail] aurora:thumbnail-upgraded:', filePath, 'matchIndex=', matchIndex, 'imageChildren.length=', imageChildren.length);
      if (matchIndex === -1) return;
      setUpgradingPaths(prev => {
        const next = new Set(prev);
        next.delete(filePath);
        return next;
      });
      const cache = getGlobalCache();
      const updated = imageChildren.slice(0, 3).map(img => cache.get(img.path)).filter((url): url is string => !!url);
      console.log('[FolderThumbnail] Updated URLs from cache:', updated, 'prev previewSrcs length=', previewSrcs.length);
      setPreviewSrcs(prev => {
        if (updated.length === prev.length && updated.every((val, idx) => val === prev[idx])) return prev;
        return updated;
      });
    };
    const failHandler = (e: Event) => {
      const { filePath: failedPath } = (e as CustomEvent).detail;
      const matchIndex = imageChildren.findIndex(img => img.path === failedPath);
      if (matchIndex === -1) return;
      setUpgradingPaths(prev => {
        const next = new Set(prev);
        next.delete(failedPath);
        return next;
      });
    };
    window.addEventListener('aurora:thumbnail-upgraded', handler);
    window.addEventListener('aurora:thumbnail-upgrade-failed', failHandler);
    return () => {
      window.removeEventListener('aurora:thumbnail-upgraded', handler);
      window.removeEventListener('aurora:thumbnail-upgrade-failed', failHandler);
    };
  }, [imageChildren]);

  useEffect(() => {
    if (upgradingPaths.size === 0 || !resourceRoot) return;
    let cancelled = false;
    let retryCount = 0;
    const maxRetries = 3;
    const retryDelay = 5000;

    const checkUpgrades = async () => {
      if (cancelled || retryCount >= maxRetries) return;
      retryCount++;
      await new Promise<void>(resolve => setTimeout(resolve, retryDelay));
      if (cancelled) return;
      try {
        const { getThumbnail, isThumbnailUpgrading: isUpgrading } = await import('../api/tauri-bridge');
        const stillUpgrading: string[] = [];
        for (const imgPath of upgradingPaths) {
          const img = imageChildren.find(i => i.path === imgPath);
          if (!img) continue;
          const thumbnail = await getThumbnail(img.path, img.updatedAt, resourceRoot, undefined, undefined, undefined, img.mediaStoreId);
          if (thumbnail && !isUpgrading(img.path)) {
            const cache = getGlobalCache();
            cache.set(img.path, thumbnail);
          } else if (isUpgrading(img.path)) {
            stillUpgrading.push(imgPath);
          }
        }
        if (!cancelled) {
          const cache = getGlobalCache();
          const updated = imageChildren.slice(0, 3).map(img => cache.get(img.path)).filter((url): url is string => !!url);
          setPreviewSrcs(prev => {
            if (updated.length === prev.length && updated.every((val, idx) => val === prev[idx])) return prev;
            return updated;
          });
          if (stillUpgrading.length < upgradingPaths.size) {
            setUpgradingPaths(new Set(stillUpgrading));
          }
          if (stillUpgrading.length > 0) {
            checkUpgrades();
          }
        }
      } catch {
        if (!cancelled) checkUpgrades();
      }
    };

    checkUpgrades();
    return () => { cancelled = true; };
  }, [upgradingPaths, imageChildren, resourceRoot]);

  const hasUpgrading = upgradingPaths.size > 0;
  const effectivePreviewSrcs = remoteCoverPaths ? remoteCoverSrcs : previewSrcs;

  if (isAndroid && imageChildren.length === 0 && !remoteCoverPaths) {
    return (
      <div ref={ref} className="w-full h-full relative flex flex-col items-center justify-center bg-transparent">
        <AndroidFolderPlaceholder file={file} />
      </div>
    );
  }

  return (
    <div ref={ref} className="w-full h-full relative flex flex-col items-center justify-center bg-transparent">
      <div className="relative w-full aspect-square p-2" style={{ maxHeight: '100%' }}>
         {folderIconStyle === 'canvas' && isSpriteSupportedSafe() ? (
            <Folder3DIconCanvas
               previewSrcs={effectivePreviewSrcs}
               count={folderItemCount(file)}
               category={file.category}
               folderId={file.id}
            />
         ) : (
            <Folder3DIcon
               previewSrcs={effectivePreviewSrcs}
               count={folderItemCount(file)}
               category={file.category}
               variant={folderIconStyle === 'canvas' ? undefined : folderIconStyle}
            />
         )}
         {hasUpgrading && (
           <div className="absolute inset-0 bg-black/30 flex items-center justify-center z-10 rounded-lg">
             <svg className="animate-spin h-5 w-5 text-white/70" viewBox="0 0 24 24" fill="none">
               <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
               <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
             </svg>
           </div>
         )}
      </div>
    </div>
  );
});
