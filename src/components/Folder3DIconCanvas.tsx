// 经典 3D 文件夹图标的 Canvas 预合成版组件（与 Folder3DIcon variant='classic' 视觉一致）。
//
// 渲染策略：
//   - 静止：合成一张完整位图（后板 + 堆叠预览卡 + 前板 + 角标），drawImage 一次贴图 → 每卡 1 合成层。
//     预览卡位于后板与前板之间 → 前板遮挡预览卡下半部分（与 DOM 版 z-10 < z-20 一致）。
//   - 滚动兜底：立即绘制全局共享的 staticBody 位图（后板+灰卡+前板，单层贴图），
//     真图由 idle 队列补全（滚动中不请求；滚动停止后统一补全）。
//   - 悬停：rAF 逐帧复刻 DOM 的 CSS 动画（300ms ease + 扇形摊开 + 容器位移放大）。
//     预览图解码延迟到首次悬停才触发（滚动时卡片进出视口不做解码，避免抢占主线程）；
//     解码完成前用灰阶占位卡绘制，完成后若仍在悬停则用真实图重播动画。
//
// 性能要点（虚拟化高频挂载下的主线程成本）：
//   - 组件的尺寸/主题/滚动状态全部走 ref + 回调【命令式】驱动，只有 canvas 的 CSS 尺寸
//     同步进 React state（仅影响样式），因此【挂载只渲染一次】；滚动状态翻转、主题切换、
//     缩略图升级等都不再触发整卡重渲染 —— 避免"滚动停止时 200+ 张卡同时重渲染"的尖峰。
//   - 尺寸变化（窗口/面板/换档）由 ResizeObserver 回调直接重分配 backing + 重绘。
//   - 主题变化由模块内共享思路的 MutationObserver 回调直接重绘（不经过 state）。
//
// 仅在 isSpriteSupported() 为 true 时由 FolderThumbnail 使用；不支持时回退 DOM 版。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDarkTheme } from '../utils/folderTilesRenderer';
import { drawHoverFrame, drawBadge, loadImages, type IconCategory, type IconTheme } from '../utils/spriteComposer';
import { getFull, getStaticBody, getBack, getFront } from '../utils/spriteCache';
import { getGlobalScrollState, subscribeScrollState } from '../api/tauri-bridge/state';

interface Folder3DIconCanvasProps {
  previewSrcs?: string[];
  count?: number;
  category?: string;
  folderId?: string;
  className?: string;
  onImageError?: (index: number) => void;
}

// 画布相对图标的放大系数：扇形展开时卡片旋转 ±14° 的角会超出图标边界，
// DOM 版无 overflow 裁剪所以可见；canvas 像素边界即裁剪边界，故把画布放大居中
// （绘制仍用 0..size 坐标系，setTransform 平移缩放后视觉尺寸不变），留白容纳转角。
const CANVAS_SCALE = 1.15;

export const Folder3DIconCanvas: React.FC<Folder3DIconCanvasProps> = React.memo(
  ({ previewSrcs, count, category = 'general', folderId = 'anon', className, onImageError }) => {
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    // 仅 canvas 的 CSS 尺寸同步到 state（其余一率命令式，避免挂载/翻转触发的整卡重渲染）
    const [styleSize, setStyleSize] = useState(32);
    // ---- 命令式状态（ref）----
    const sizeRef = useRef(0);
    const srcsRef = useRef<string[]>([]);
    const countRef = useRef(count);
    const folderIdRef = useRef(folderId);
    const catRef = useRef<IconCategory>(category === 'book' ? 'book' : category === 'sequence' ? 'sequence' : 'general');
    const scrollActiveRef = useRef(getGlobalScrollState() !== 'idle');
    const controllerRef = useRef<AbortController | null>(null);
    const retryCountRef = useRef(0);
    const retryTimerRef = useRef<number | null>(null);
    const unmountedRef = useRef(false);
    // 预览图解码结果（首次悬停才触发）
    const imgsRef = useRef<(HTMLImageElement | null)[]>([]);
    const imgsReadyRef = useRef(false);
    const hoveringRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const progressRef = useRef(0); // 悬停动画进度（0..300ms）
    const dpr = useMemo(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1), []);
    void onImageError; // 与 Folder3DIcon 保持 API 对齐；解码失败走 loadImage→null→占位色

    // 每次渲染同步最新 props 到 ref（保持可调用函数引用稳定，避免触发重渲染）
    srcsRef.current = (previewSrcs || []).filter(s => !!s).slice(0, 3);
    countRef.current = count;
    folderIdRef.current = folderId;
    catRef.current = category === 'book' ? 'book' : category === 'sequence' ? 'sequence' : 'general';

    // 画一幅完整位图（true 图/占位图）覆盖当前画布
    const drawFull = useCallback((bmp: ImageBitmap, S: number) => {
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(bmp, 0, 0, S, S);
    }, []);

    // 主体（staticBody 灰卡 + 前板）+ 角标 —— 命令式绘制，主题实时读取
    const drawStatic = useCallback((S: number) => {
      const c = canvasRef.current;
      if (!c || S <= 0) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      const body = getStaticBody(catRef.current, isDarkTheme() ? 'dark' : 'light', S, dpr);
      if (body) {
        ctx.drawImage(body, 0, 0, S, S);
        if (countRef.current !== undefined) drawBadge(ctx, S, countRef.current as number);
      }
    }, [dpr]);

    // 请求完整位图（真缩略图）。滚动中不入队；未就绪时延迟重试最多 2 次。
    const requestFull = useCallback(() => {
      const S = sizeRef.current;
      if (S <= 0) return;
      if (scrollActiveRef.current) return; // 滚动中不请求；滚动停止后由订阅回调补发
      controllerRef.current?.abort();
      const controller = new AbortController();
      controllerRef.current = controller;
      getFull({
        folderId: folderIdRef.current,
        previewSrcs: srcsRef.current,
        count: countRef.current,
        category: catRef.current,
        theme: isDarkTheme() ? 'dark' : 'light',
        size: S,
        dpr,
        signal: controller.signal,
      }).then(full => {
        if (controllerRef.current !== controller || unmountedRef.current) return;
        if (!full) {
          // 缩略图解码未完成/队列驱逐/单任务超时：延迟重试，就绪后自动补上
          if (retryCountRef.current < 2) {
            retryCountRef.current++;
            retryTimerRef.current = window.setTimeout(() => {
              retryTimerRef.current = null;
              if (!unmountedRef.current) requestFull();
            }, 400);
          }
          return;
        }
        retryCountRef.current = 0;
        drawFull(full, S);
      });
    }, [dpr, drawFull]);

    // 尺寸变化：重分配 canvas backing + 画主体 + 补 full（不经过 state，无重渲染）
    const redrawAtSize = useCallback((S: number) => {
      if (S <= 0) return;
      const c = canvasRef.current;
      if (!c) return;
      sizeRef.current = S;
      const res = Math.max(2, dpr);
      const Sd = Math.max(1, Math.round(S * CANVAS_SCALE));
      c.width = Sd * res;
      c.height = Sd * res;
      c.style.width = `${Sd}px`;
      c.style.height = `${Sd}px`;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        try { ctx.imageSmoothingQuality = 'high'; } catch { /* 旧实现 */ }
        const pad = (Sd - S) / 2;
        ctx.setTransform(res, 0, 0, res, pad * res, pad * res);
      }
      drawStatic(S);
      retryCountRef.current = 0;
      requestFull();
    }, [dpr, drawStatic, requestFull]);

    // 挂载：ResizeObserver（尺寸）+ MutationObserver（主题）+ 滚动状态订阅
    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      // StrictMode 会「挂载→清理→再挂载」，第二次挂载必须重置卸载标记，
      // 否则 getFull 的结果会被 unmountedRef=true 永久丢弃（缩略图空白）
      unmountedRef.current = false;
      const ro = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect.width;
        if (w && w > 0) {
          setStyleSize(Math.round(w)); // 仅同步 canvas 样式尺寸
          redrawAtSize(w);
        }
      });
      ro.observe(el);
      // 主题切换：直接命令式重绘主体（不触发 React 重渲染）
      const mo = new MutationObserver(() => {
        if (sizeRef.current > 0) redrawAtSize(sizeRef.current);
      });
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      // 滚动状态：滚动中不入队；恢复 idle 时立即补全当前卡
      const unsub = subscribeScrollState(s => {
        const active = s !== 'idle';
        scrollActiveRef.current = active;
        if (!active && sizeRef.current > 0) requestFull();
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

    // previewSrcs 变化（缩略图升级/就绪）或 folderId/count 变化：重新请求 full
    const previewKey = (previewSrcs || []).filter(s => !!s).slice(0, 3).join('|');
    useEffect(() => {
      if (sizeRef.current > 0) requestFull();
    }, [folderId, count, previewKey, requestFull]);

    // 悬停动画：dir=1 进入 / -1 离开，逐帧复刻 CSS transition（300ms ease）。
    // imgs 从 ref 读取（首次悬停解码完成后，若仍在悬停则以真图重播）。
    const animate = useCallback(
      (dir: 1 | -1, images?: (HTMLImageElement | null)[]) => {
        const S = sizeRef.current;
        if (S <= 0) return;
        const useImgs = images ?? imgsRef.current;
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        const c = canvasRef.current;
        if (!c) return;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        const back = getBack(catRef.current, isDarkTheme() ? 'dark' : 'light', S, dpr);
        const front = getFront(catRef.current, isDarkTheme() ? 'dark' : 'light', S, dpr);
        if (!back || !front) return;
        let t = progressRef.current;
        if (dir > 0 && t >= 300) t = 0;
        if (dir < 0 && t <= 0) t = 300;
        const t0 = performance.now();
        let last = t0;
        const input = {
          back,
          front,
          imgs: useImgs,
          count: countRef.current,
          theme: (isDarkTheme() ? 'dark' : 'light') as IconTheme,
          size: S,
        };
        const step = (now: number) => {
          const dt = now - last;
          last = now;
          t = dir > 0 ? Math.min(300, t + dt) : Math.max(0, t - dt);
          progressRef.current = t;
          drawHoverFrame(ctx, input, t);
          const done = dir > 0 ? t >= 300 : t <= 0;
          if (!done) rafRef.current = requestAnimationFrame(step);
          else rafRef.current = null;
        };
        rafRef.current = requestAnimationFrame(step);
      },
      [dpr]
    );

    // 首次悬停时才解码预览图（滚动中不加载）；就绪后若仍在悬停则以真图重播
    const ensureImgsAndAnimate = useCallback(() => {
      hoveringRef.current = true;
      if (imgsReadyRef.current) {
        animate(1);
        return;
      }
      // 先以灰阶占位卡立即起动画，解码完成后再换真图
      animate(1);
      const srcs = srcsRef.current;
      if (srcs.length === 0) {
        imgsReadyRef.current = true;
        return;
      }
      loadImages(srcs).then(list => {
        imgsRef.current = list;
        imgsReadyRef.current = true;
        if (hoveringRef.current) animate(1, list); // 仍在悬停 → 用真图重播
      });
    }, [animate]);

    const sd = Math.max(1, Math.round(styleSize * CANVAS_SCALE));
    return (
      <div
        ref={wrapRef}
        className={`relative w-full h-full select-none ${className || ''}`}
        onMouseEnter={() => ensureImgsAndAnimate()}
        onMouseLeave={() => {
          hoveringRef.current = false;
          animate(-1);
        }}
      >
        <canvas
          ref={canvasRef}
          className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2"
          style={{ width: sd, height: sd }}
        />
      </div>
    );
  }
);