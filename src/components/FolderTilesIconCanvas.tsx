// 简洁瓷砖文件夹图标（Folder3DIcon variant='tiles'）的 Canvas 预合成版组件。
//
// 渲染策略（与 Folder3DIconCanvas 同构、更精简）：
//   - 静止：一张完整位图（圆角外框 + 左大右二 2×2 瓷砖 + 分类渐变），drawImage 一次贴图；
//     角标不进位图缓存，贴图后即时补画（drawTilesBadge）。
//   - 滚动兜底：立即绘制全局共享的「三槽灰块」static 位图（同步合成），真图由 idle 队列补全
//     （滚动中只排队，静止后串行合成），full 就绪后整幅覆盖。
//   - 悬停：与 DOM 100% 一致 —— 仅三张瓷砖各自 scale(1.05)（300ms ease），
//     外框/渐变/角标保持不动。rAF 逐帧重绘，瓷砖源（真图/灰块）延迟到首次悬停才解码。
//
// 与经典版的关键差异：tiles 悬停放大被各自槽位裁剪、不超出图标外框，canvas 无需 CANVAS_SCALE
// 留白，元素尺寸 = 图标尺寸。经典版需要的 back/front/shell 分层与 3D 透视在此处也不存在。
//
// 仅在 isSpriteSupported() 为 true 时由 FolderThumbnail 使用（folderIconStyle==='tiles'）；
// 不支持时回退 FolderTilesIcon DOM 版。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDarkTheme } from '../utils/folderTilesRenderer';
import {
  drawTilesBadge,
  drawTilesFrame,
  easeCss,
  loadImages,
  type IconCategory,
  type IconTheme,
  type TilesImage,
} from '../utils/tilesComposer';
import { getTilesFull, getTilesStatic, getTilesWorkerUsable, warmTilesWorker } from '../utils/tilesCache';
import { getGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge/state';

interface FolderTilesIconCanvasProps {
  previewSrcs?: string[];
  count?: number;
  category?: string;
  folderId?: string;
  className?: string;
  onImageError?: (index: number) => void;
}

export const FolderTilesIconCanvas: React.FC<FolderTilesIconCanvasProps> = React.memo(
  ({ previewSrcs, count, category = 'general', folderId = 'anon', className, onImageError }) => {
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    // 仅 canvas 的 CSS 尺寸同步到 state（其余一律命令式，避免挂载/翻转触发的整卡重渲染）
    const [styleSize, setStyleSize] = useState(32);
    // ---- 命令式状态（ref）----
    const sizeRef = useRef(0);
    const srcsRef = useRef<string[]>([]);
    const countRef = useRef(count);
    const folderIdRef = useRef(folderId);
    const catRef = useRef<IconCategory>(category === 'book' ? 'book' : category === 'sequence' ? 'sequence' : 'general');
    const controllerRef = useRef<AbortController | null>(null);
    const retryCountRef = useRef(0);
    const retryTimerRef = useRef<number | null>(null);
    const unmountedRef = useRef(false);
    // 最近一帧完整位图：尺寸/主题变化时用作等比过渡，避免真图闪回灰块
    const lastFullRef = useRef<ImageBitmap | null>(null);
    // 悬停动画源（真图解码结果；null 槽 = 灰块）。延迟到首次悬停才触发解码
    const imgsRef = useRef<TilesImage[]>([null, null, null]);
    const imgsReadyRef = useRef(false);
    const hoveringRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const progressRef = useRef(0); // 悬停动画进度（0..300ms）
    const dpr = useMemo(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1), []);
    void onImageError; // 与 FolderTilesIcon API 对齐；解码失败走 loadImages→null→占位灰块

    // 每次渲染同步最新 props 到 ref（保持可调用函数引用稳定，避免触发重渲染）
    srcsRef.current = (previewSrcs || []).filter(s => !!s).slice(0, 3);
    countRef.current = count;
    folderIdRef.current = folderId;
    catRef.current = category === 'book' ? 'book' : category === 'sequence' ? 'sequence' : 'general';

    const themeNow = (): IconTheme => (isDarkTheme() ? 'dark' : 'light');

    // 补画固定 px 角标（静止位图不含角标；仅 count>0 时 DOM 才显示）
    const paintBadge = useCallback((ctx: CanvasRenderingContext2D, S: number) => {
      const n = countRef.current;
      if (n !== undefined && n > 0) drawTilesBadge(ctx, S, n);
    }, []);

    // 立即绘制灰块静止主体（同步合成、无需队列）+ 角标 —— 滚动/换档后新卡即时显示完整图标
    const drawStatic = useCallback((S: number) => {
      const c = canvasRef.current;
      if (!c || S <= 0) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const bmp = getTilesStatic(catRef.current, themeNow(), S, dpr);
      if (bmp) {
        ctx.drawImage(bmp, 0, 0, S, S);
        paintBadge(ctx, S);
      }
    }, [dpr, paintBadge]);

    // 恢复/绘制静止态：优先贴最近一帧完整位图（含真缩略图），无则回退灰块 static
    const paintStaticState = useCallback((S: number) => {
      const c = canvasRef.current;
      if (!c || S <= 0) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      if (lastFullRef.current) {
        ctx.drawImage(lastFullRef.current, 0, 0, S, S);
        paintBadge(ctx, S);
      } else {
        drawStatic(S);
      }
    }, [drawStatic, paintBadge]);

    // 画一幅完整位图（真缩略图）覆盖当前画布并补角标
    const drawFull = useCallback((bmp: ImageBitmap, S: number) => {
      const c = canvasRef.current;
      if (!c) return;
      // 画布已被重分配（尺寸变化）：丢弃旧尺寸位图，避免只显示左上角
      if (sizeRef.current !== S) return;
      // 缓存命中且内容未变：跳过冗余重绘（滚动每次 idle 兜底会对全体可见卡 requestFull，
      // 命中缓存返回同一 ImageBitmap；若逐一重画 canvas 会造成每轮 idle 全体卡纹理解析/上传）
      if (lastFullRef.current === bmp) return;
      lastFullRef.current = bmp;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, S, S);
      ctx.drawImage(bmp, 0, 0, S, S);
      paintBadge(ctx, S);
    }, [paintBadge]);

    // 请求完整位图（真缩略图）。图源就绪失败时退避重试
    const requestFull = useCallback(() => {
      const S = sizeRef.current;
      if (S <= 0) return;
      const srcs = srcsRef.current;
      if (srcs.length === 0) return; // 无图源：灰块 static 即最终态
      // 滚动中仅当 worker 合成可用时才发起：worker 不占主线程，滚动中也能即时升级真缩略图；
      // 合成回退主线程时滚动中不发起（避免队列积压/挤兑/退避重试风暴，实测更卡），
      // 滚动停止后由 subscribeScrollState(idle) 兜底补发。
      if (getGlobalScrollState() !== 'idle' && !getTilesWorkerUsable()) return;
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      getTilesFull({
        folderId: folderIdRef.current,
        srcs,
        category: catRef.current,
        theme: themeNow(),
        size: S,
        signal: controller.signal,
      }).then(full => {
        if (controllerRef.current !== controller || unmountedRef.current) return;
        if (!full) {
          // 缩略图未就绪（缓存冷/生成中/解码失败）：有界退避重试。
          // 前几档大概率落在 spriteComposer 的 8s src 冷却窗口内 → 快速返回 null，
          // 预算耗尽后依赖 previewSrcs 变化 / 重挂载 / 悬停解码来恢复。
          const RETRY_DELAYS = [400, 1200, 3000, 6000, 10000, 15000, 20000];
          if (retryCountRef.current < RETRY_DELAYS.length) {
            const delay = RETRY_DELAYS[retryCountRef.current];
            retryCountRef.current++;
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              if (!unmountedRef.current) requestFull();
            }, delay);
          }
          return;
        }
        retryCountRef.current = 0;
        drawFull(full, S);
      });
    }, [drawFull]);

    // 尺寸/主题变化：重分配 canvas backing + 画静止主体 + 补 full（命令式，无重渲染）
    const redrawAtSize = useCallback((w: number) => {
      const S = Math.round(w);
      if (S <= 0) return;
      const c = canvasRef.current;
      if (!c) return;
      // 尺寸变化：终止基于旧尺寸的悬停动画帧，进度复位
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      progressRef.current = 0;
      sizeRef.current = S;
      const res = Math.max(2, dpr);
      const Sd = S;
      c.width = Sd * res;
      c.height = Sd * res;
      c.style.width = `${Sd}px`;
      c.style.height = `${Sd}px`;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        try { ctx.imageSmoothingQuality = 'high'; } catch { /* 旧实现 */ }
        ctx.setTransform(res, 0, 0, res, 0, 0);
        // 显式清整块画布（width 赋值相同时部分浏览器不会重置 backing）
        ctx.clearRect(0, 0, S, S);
        // 过渡显示：优先等比缩放最近完整位图，避免尺寸变化时真图闪回灰块；
        // 新尺寸完整位图由 requestFull 异步补上（cache 命中即微任务返回）
        paintStaticState(S);
      }
      retryCountRef.current = 0;
      requestFull();
    }, [dpr, paintStaticState, requestFull]);

    // 挂载：ResizeObserver（尺寸）+ MutationObserver（主题）+ 滚动状态订阅
    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      // StrictMode「挂载→清理→再挂载」：第二次挂载必须重置卸载标记
      unmountedRef.current = false;
      warmTilesWorker(); // 预热 spawn worker：滚动中即可用，无需等首次 idle
      const ro = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect.width;
        if (w && w > 0) {
          setStyleSize(Math.round(w));
          redrawAtSize(w);
        }
      });
      ro.observe(el);
      // 主题切换：直接命令式重绘主体（不触发 React 重渲染）
      const mo = new MutationObserver(() => {
        if (sizeRef.current > 0) redrawAtSize(sizeRef.current);
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      // 滚动状态：恢复 idle 时补发一次（滚动中已即时请求，此处兜底刷新）
      const unsub = subscribeScrollState(s => {
        if (s === 'idle' && sizeRef.current > 0) requestFull();
      });
      return () => {
        ro.disconnect();
        mo.disconnect();
        unsub();
        unmountedRef.current = true;
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        if (retryTimerRef.current !== null) clearTimeout(retryTimerRef.current);
        controllerRef.current?.abort();
      };
    }, [redrawAtSize, requestFull]);

    // folderId / previewSrcs 变化（缩略图升级/就绪）：重新请求 full
    const previewKey = (previewSrcs || []).filter(s => !!s).slice(0, 3).join('|');
    useEffect(() => {
      retryCountRef.current = 0; // 图源变化：重置退避重试预算
      if (sizeRef.current > 0) requestFull();
    }, [folderId, previewKey, requestFull]);

    // count 变化：静止时重画角标（不动整图）；hover 动画中由下一帧读取新 count
    const firstCountRef = useRef(true);
    useEffect(() => {
      if (firstCountRef.current) {
        firstCountRef.current = false;
        return;
      }
      if (rafRef.current === null && !hoveringRef.current && sizeRef.current > 0) {
        paintStaticState(sizeRef.current);
      }
    }, [count, paintStaticState]);

    // 悬停动画：dir=1 进入 / -1 离开，逐帧复刻 CSS transition（300ms ease，仅瓷砖放大）
    const animate = useCallback((dir: 1 | -1, images?: TilesImage[]) => {
      const S = sizeRef.current;
      if (S <= 0) return;
      const useImgs = images ?? imgsRef.current;
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      let t = progressRef.current;
      if (dir > 0 && t >= 300) t = 0;
      if (dir < 0 && t <= 0) t = 300;
      const t0 = performance.now();
      let last = t0;
      const step = (now: number) => {
        const dt = now - last;
        last = now;
        t = dir > 0 ? Math.min(300, t + dt) : Math.max(0, t - dt);
        progressRef.current = t;
        drawTilesFrame(
          ctx,
          S,
          themeNow(),
          catRef.current,
          useImgs,
          countRef.current,
          1 + 0.05 * easeCss(t / 300)
        );
        const done = dir > 0 ? t >= 300 : t <= 0;
        if (!done) {
          rafRef.current = requestAnimationFrame(step);
          return;
        }
        rafRef.current = null;
        progressRef.current = dir > 0 ? 300 : 0;
        // 离开动画结束：恢复静止位图（full/static + 角标）
        if (dir < 0) {
          ctx.clearRect(0, 0, S, S);
          paintStaticState(S);
        }
      };
      rafRef.current = requestAnimationFrame(step);
    }, [paintStaticState]);

    // 首次悬停时才解码预览图（滚动中不加载）。有图源但未解码时保持静止位图，
    // 解码完成若仍在悬停再从静止态用真图起动画（避免先放大灰块再闪换真图）。
    const ensureImgsAndAnimate = useCallback(() => {
      hoveringRef.current = true;
      const srcs = srcsRef.current;
      if (imgsReadyRef.current) {
        animate(1);
        return;
      }
      if (srcs.length === 0) {
        // 与 DOM 一致：无图源时用灰块占位做放大动画
        imgsReadyRef.current = true;
        animate(1);
        return;
      }
      loadImages(srcs).then(list => {
        if (unmountedRef.current) return;
        const imgs: TilesImage[] = [list[0] ?? null, list[1] ?? null, list[2] ?? null];
        imgsRef.current = imgs;
        imgsReadyRef.current = true;
        if (hoveringRef.current) animate(1, imgs); // 仍在悬停 → 用真图起动画
      });
    }, [animate]);

    return (
      <div
        ref={wrapRef}
        className={`relative w-full h-full select-none ${className || ''}`}
        onMouseEnter={() => ensureImgsAndAnimate()}
        onMouseLeave={() => {
          hoveringRef.current = false;
          // imgs 未就绪时进入侧还没起动画，画布仍是静止位图；仅在就绪后才播反向
          if (imgsReadyRef.current) animate(-1);
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ width: styleSize, height: styleSize }}
        />
      </div>
    );
  }
);
