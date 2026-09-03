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
import { subscribeScrollState } from '../api/tauri-bridge/state';

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
    const controllerRef = useRef<AbortController | null>(null);
    const retryCountRef = useRef(0);
    const retryTimerRef = useRef<number | null>(null);
    const unmountedRef = useRef(false);
    // 最近一帧完整位图：尺寸变化时用作等比缩放过渡，避免缩略图闪白（占位卡为白色）
    const lastFullRef = useRef<ImageBitmap | null>(null);
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
      // 画布已被重分配（尺寸变化）：丢弃旧尺寸位图，避免画布上只出现左上角内容
      if (sizeRef.current !== S) return;
      lastFullRef.current = bmp; // 记录最近一帧完整位图，供尺寸变化时过渡缩放
      const ctx = c.getContext('2d');
      if (!ctx) return;
      // 显式清整块：drawFull 不经 redrawAtSize（如 previewKey 变化触发 getFull 时），
      // 直接 drawImage 会把新位图叠加在旧内容上。先 clearRect 保证底干净。
      ctx.clearRect(0, 0, S, S);
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

    // 恢复/绘制静止态：优先贴最近一帧完整位图（含真缩略图），无则回退 staticBody 灰卡占位。
    // 旧位图可能是按旧尺寸合成的（角标/图标是固定 px，等比缩放会不一致），故叠一层当前尺寸
    // 的 front（不透明，恰好覆盖旧前板区）再按当前尺寸重画角标 → 与最终合成帧严格一致。
    // 调用方需先保证画布已清、transform 已就位（与 redrawAtSize 的约定一致）。
    const paintStaticState = useCallback((S: number) => {
      const c = canvasRef.current;
      if (!c || S <= 0) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;
      if (lastFullRef.current) {
        ctx.drawImage(lastFullRef.current, 0, 0, S, S);
        const theme = isDarkTheme() ? 'dark' : 'light';
        const front = getFront(catRef.current, theme, S, dpr);
        if (front) ctx.drawImage(front, 0, 0, S, S);
        if (countRef.current !== undefined) drawBadge(ctx, S, countRef.current as number);
      } else {
        drawStatic(S);
      }
    }, [dpr, drawStatic]);

    // 请求完整位图（真缩略图）。滚动中也请求（缩略图滚动时就开始加载）；未就绪时退避重试。
    const requestFull = useCallback(() => {
      const S = sizeRef.current;
      if (S <= 0) return;
      // 无论滚动与否都先作废在途请求：避免旧尺寸位图被绘到重分配后的画布上（只显示左上角）
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
          // 缩略图未就绪（重启后缓存冷/缩略图生成中/解码失败）：指数退避持续重试，
          // 直到就绪或组件卸载。DOM 版 <img> 会自动重试加载，这里等效复刻，
          // 避免短暂失败后永久停留在占位灰卡（否则重启后个别文件夹缩略图空白）。
          //
          // 注意：RETRY_DELAYS 前几档(400/1200/3000/6000ms)很可能落在 spriteComposer
          // 的 8s src 冷却窗口内 → 直接返回 null、根本没发起请求，属于"无效重试"；
          // 预算耗尽后不再重试，依赖 previewSrcs 变化 / 重挂载 / 悬停解码来恢复。
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
    }, [dpr, drawFull]);

    // 尺寸变化：重分配 canvas backing + 画主体 + 补 full（不经过 state，无重渲染）
    const redrawAtSize = useCallback((S: number) => {
      if (S <= 0) return;
      const c = canvasRef.current;
      if (!c) return;
      // 尺寸变化：终止基于旧尺寸的悬停动画帧（继续绘制会污染新画布），进度复位
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      progressRef.current = 0;
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
        // 显式清整块画布：c.width = Sd*res 赋值相同时，部分浏览器（WebView2/Chromium）不会重置
        // backing，导致上一次 redrawAtSize 的 scaled lastFullRef 残留 → 多次快速 resize 时，
        // 不同中间尺寸的位图叠加，表现为"缩略图多了一层又一层"。
        ctx.clearRect(0, 0, S, S);
        // 过渡显示：优先把最近一帧完整位图（含缩略图）等比缩放到新尺寸，避免尺寸变化时
        // 缩略图闪白（占位卡为白色）；无历史位图（首次加载）才回退 staticBody 占位。
        // 新尺寸的完整位图由 requestFull 异步补上（cache 命中即微任务内返回）。
        paintStaticState(S);
      }
      retryCountRef.current = 0;
      requestFull();
    }, [dpr, paintStaticState, requestFull]);

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

    // previewSrcs 变化（缩略图升级/就绪）或 folderId/count 变化：重新请求 full
    const previewKey = (previewSrcs || []).filter(s => !!s).slice(0, 3).join('|');
    useEffect(() => {
      retryCountRef.current = 0; // 图源变化：重置退避重试预算
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
          if (!done) {
            rafRef.current = requestAnimationFrame(step);
            return;
          }
          rafRef.current = null;
          progressRef.current = dir > 0 ? 300 : 0;
          // 离开动画结束：动画帧可能一直用的是占位卡 imgs（解码未完成/失败/无图源），
          // 最后一帧会停在白卡上且没人再画回去 → 显式恢复静止位图（真图/灰卡）。
          if (dir < 0) {
            ctx.clearRect(0, 0, S, S);
            paintStaticState(S);
          }
        };
        rafRef.current = requestAnimationFrame(step);
      },
      [dpr, paintStaticState]
    );

    // 首次悬停时才解码预览图（滚动中不加载）。
    // 修复：有图源但未解码时【不再先用空 imgs 起动画】——那会导致"先闪白卡再换真图"。
    // 改为保持当前静止位图（通常已含真缩略图），解码完成后若仍在悬停，再从静止态用真图起动画。
    const ensureImgsAndAnimate = useCallback(() => {
      hoveringRef.current = true;
      const srcs = srcsRef.current;
      if (imgsReadyRef.current) {
        animate(1);
        return;
      }
      if (srcs.length === 0) {
        // 与 DOM 版一致：无图源时用灰卡占位做扇形动画。
        imgsReadyRef.current = true;
        animate(1);
        return;
      }
      loadImages(srcs).then(list => {
        imgsRef.current = list;
        imgsReadyRef.current = true;
        if (hoveringRef.current) animate(1, list); // 仍在悬停 → 用真图起动画（无白卡闪现）
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
          // imgs 未就绪时进入侧还没起动画（见 ensureImgsAndAnimate），画布仍是静止位图；
          // 直接 animate(-1) 会用空 imgs 播一遍"白卡扇出再收回"。故仅在 imgs 就绪时才反向。
          if (imgsReadyRef.current) animate(-1);
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