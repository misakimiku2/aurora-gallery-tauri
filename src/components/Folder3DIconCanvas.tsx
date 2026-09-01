// 经典 3D 文件夹图标的 Canvas 预合成版组件（与 Folder3DIcon variant='classic' 视觉一致）。
//
// 渲染策略：
//   - 静止：合成一张完整位图（后板 + 堆叠预览卡 + 前板 + 角标），drawImage 一次贴图 → 每卡 1 合成层。
//     预览卡位于后板与前板之间 → 前板遮挡预览卡下半部分（与 DOM 版 z-10 < z-20 一致）。
//   - 滚动兜底：合成前先画全局共享的 shell 位图（后板+前板+图标，单层贴图），照片稍后由 idle 队列补全。
//   - 悬停：rAF 逐帧复刻 DOM 的 CSS 动画（300ms ease + 扇形摊开 + 容器位移放大）。
//     预览图解码延迟到首次悬停才触发（滚动时卡片进出视口不做解码，避免抢占主线程）；
//     解码完成前用灰阶占位卡绘制，完成后若仍在悬停则用真实图重播动画。
//
// 仅在 isSpriteSupported() 为 true 时由 FolderThumbnail 使用；不支持时回退 DOM 版。

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { isDarkTheme } from '../utils/folderTilesRenderer';
import { drawHoverFrame, drawBadge, loadImages, type IconCategory, type IconTheme } from '../utils/spriteComposer';
import { getFull, getStaticBody, getBack, getFront, spriteStats } from '../utils/spriteCache';

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
// 1.15 已足够容纳（旋转最远角点约 1.03S），缩小留白可降低 canvas 光栅像素量。
const CANVAS_SCALE = 1.15;

export const Folder3DIconCanvas: React.FC<Folder3DIconCanvasProps> = React.memo(
  ({ previewSrcs, count, category = 'general', folderId = 'anon', className, onImageError }) => {
    const wrapRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const [size, setSize] = useState(0);
    const [theme, setTheme] = useState<IconTheme>(() => (isDarkTheme() ? 'dark' : 'light'));
    // 预览图解码结果（供悬停动画逐帧绘制）。首次悬停时才解码，避免滚动中主线程解码。
    const imgsRef = useRef<(HTMLImageElement | null)[]>([]);
    const imgsReadyRef = useRef(false);
    const hoveringRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const progressRef = useRef(0); // 悬停动画进度（0..300ms）
    const dpr = useMemo(() => (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1), []);
    const previewKey = useMemo(() => (previewSrcs || []).slice(0, 3).join('|'), [previewSrcs]);
    void onImageError; // 保留 API 对齐 Folder3DIcon；图片加载失败走 loadImage→null→占位色

    // 尺寸观察（容器变化：窗口/面板开合/换档）
    useEffect(() => {
      const el = wrapRef.current;
      if (!el) return;
      const ro = new ResizeObserver(entries => {
        const w = entries[0]?.contentRect.width;
        if (w && w > 0) setSize(Math.round(w));
      });
      ro.observe(el);
      return () => ro.disconnect();
    }, []);

    // 主题监听（.dark 类变化）
    useEffect(() => {
      const apply = () => setTheme(isDarkTheme() ? 'dark' : 'light');
      apply();
      const mo = new MutationObserver(apply);
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
      return () => mo.disconnect();
    }, []);

    // canvas backing 尺寸（渲染分辨率至少 2x：与合成位图同密度，全链路超采样，
    // 显示时 GPU 缩放到 1x CSS——与 DOM <img> 策略一致，缩略图/角标/边缘都锐利）
    useEffect(() => {
      if (size <= 0) return; // 首次尺寸上报前跳过，避免 0→S 两次分配清空
      const c = canvasRef.current;
      if (!c) return;
      const res = Math.max(2, dpr);
      const S = Math.max(1, Math.round(size));
      const Sd = Math.max(1, Math.round(S * CANVAS_SCALE));
      c.width = Sd * res;
      c.height = Sd * res;
      const ctx = c.getContext('2d');
      if (ctx) {
        ctx.imageSmoothingEnabled = true;
        try { ctx.imageSmoothingQuality = 'high'; } catch { /* 旧实现 */ }
        const pad = (Sd - S) / 2;
        ctx.setTransform(res, 0, 0, res, pad * res, pad * res);
      }
    }, [size, dpr]);

    // 合成与绘制：
    //  1) 立即绘制「静止完整态主体」（灰卡堆叠+前板）并补画角标——不依赖异步队列；
    //     滚动/换档后新卡也能即时显示完整图标（与 DOM 版静止态一致）。
    //  2) getFull 异步升级为真图位图（队列空闲后合成），到达后整幅覆盖。
    useEffect(() => {
      if (size <= 0) return;
      let cancelled = false;
      const c = canvasRef.current;
      if (!c) return;
      const ctx = c.getContext('2d');
      if (!ctx) return;

      const cat = (category || 'general') as IconCategory;
      const body = getStaticBody(cat, theme, size, dpr);
      if (body) {
        ctx.drawImage(body, 0, 0, size, size);
        if (count !== undefined) drawBadge(ctx, size, count);
      }

      const srcs = (previewSrcs || []).filter(s => !!s).slice(0, 3);
      const controller = new AbortController();
      getFull({
        folderId,
        previewSrcs: srcs,
        count,
        category: cat,
        theme,
        size,
        dpr,
        signal: controller.signal,
      }).then(full => {
        if (cancelled) {
          spriteStats.cancel++;
          return;
        }
        if (!full) return;
        const c2 = canvasRef.current;
        if (!c2) return;
        const ctx2 = c2.getContext('2d');
        if (!ctx2) return;
        ctx2.drawImage(full, 0, 0, size, size);
      });
      return () => {
        cancelled = true;
        controller.abort();
      };
    }, [size, theme, category, dpr, folderId, count, previewKey]);

    // 悬停动画：dir=1 进入 / -1 离开，逐帧复刻 CSS transition（300ms ease）。
    // imgs 从 ref 读取（首次悬停解码完成后，若仍在悬停则以真图重播）。
    const animate = useCallback(
      (dir: 1 | -1, images?: (HTMLImageElement | null)[]) => {
        const useImgs = images ?? imgsRef.current;
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
        const c = canvasRef.current;
        if (!c) return;
        const ctx = c.getContext('2d');
        if (!ctx) return;
        if (size <= 0) return;
        const cat = (category || 'general') as IconCategory;
        const back = getBack(cat, theme, size, dpr);
        const front = getFront(cat, theme, size, dpr);
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
          count,
          theme,
          size,
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
      // imgs 不入依赖：动画从 ref 读取最新解码结果
      [size, theme, category, count, dpr]
    );

    // 首次悬停时才解码预览图（滚动中不加载）；就绪后若仍在悬停则以真图重播
    const ensureImgsAndAnimate = useCallback(() => {
      hoveringRef.current = true;
      if (imgsReadyRef.current) {
        animate(1);
        return;
      }
      // 先以占位卡立即起动画（灰阶卡），解码完成后再换真图
      animate(1);
      const srcs = (previewSrcs || []).filter(s => !!s).slice(0, 3);
      if (srcs.length === 0) {
        imgsReadyRef.current = true;
        return;
      }
      loadImages(srcs).then(list => {
        imgsRef.current = list;
        imgsReadyRef.current = true;
        if (hoveringRef.current) animate(1, list); // 仍在悬停 → 用真图重播
      });
    }, [previewSrcs, previewKey, animate]);

    // 卸载清理
    useEffect(() => {
      return () => {
        if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      };
    }, []);

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
          style={{
            width: Math.max(1, Math.round(size * CANVAS_SCALE)),
            height: Math.max(1, Math.round(size * CANVAS_SCALE)),
          }}
        />
      </div>
    );
  }
);