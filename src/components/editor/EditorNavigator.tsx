/**
 * 全览图（PS 的 Navigator 面板，UI 设计 §4 的面板组之首）。
 *
 * 显示整张图的缩略，并把**当前视口**画成一个框 —— 缩放到 400% 之后，这是唯一能让
 * 用户知道「我在图的哪个位置」的东西。Phase 1 只读，不接受点击导航（那需要一个
 * 从面板到画布的命令通道，留到接裁剪时一起做）。
 */
import React, { useEffect, useRef, useState } from 'react';
import type { EditorViewSnapshot } from './editorViewStore';

interface EditorNavigatorProps {
  /** 高质量缩略图（由 `useEditorThumbnail` 逐级降采样生成） */
  thumb?: string;
  /** 代理图尺寸 */
  imgWidth: number;
  imgHeight: number;
  view?: EditorViewSnapshot;
  /** 点击/拖动全览图 → 请画布把该点移到视口中央（代理图像素坐标） */
  onNavigate?: (imgX: number, imgY: number) => void;
}

/** 全览区固定高度（CSS px） */
const BOX_HEIGHT = 128;

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

export const EditorNavigator: React.FC<EditorNavigatorProps> = ({
  thumb,
  imgWidth,
  imgHeight,
  view,
  onNavigate,
}) => {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [boxW, setBoxW] = useState(0);

  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const measure = () => setBoxW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const ready = Boolean(thumb && imgWidth > 0 && imgHeight > 0 && boxW > 0);
  const scale = ready ? Math.min(boxW / imgWidth, BOX_HEIGHT / imgHeight, 1) : 0;
  const dispW = imgWidth * scale;
  const dispH = imgHeight * scale;
  const offX = (boxW - dispW) / 2;
  const offY = (BOX_HEIGHT - dispH) / 2;

  // 当前视口在图片坐标系里的矩形
  let frame: { left: number; top: number; width: number; height: number } | null = null;
  if (ready && view && view.scale > 0) {
    const { scale: vs, x, y, containerWidth: cw, containerHeight: ch } = view;
    const left = Math.max(0, (0 - x) / vs);
    const top = Math.max(0, (0 - y) / vs);
    const right = Math.min(imgWidth, (cw - x) / vs);
    const bottom = Math.min(imgHeight, (ch - y) / vs);
    if (right > left && bottom > top && (right - left < imgWidth || bottom - top < imgHeight)) {
      frame = {
        left: offX + left * scale,
        top: offY + top * scale,
        width: (right - left) * scale,
        height: (bottom - top) * scale,
      };
    }
  }

  // 点击 / 拖动全览图导航（PS 的 Navigator 就是这样：点哪儿看哪儿）
  const navigateFromEvent = (clientX: number, clientY: number) => {
    const el = boxRef.current;
    if (!el || !onNavigate || !ready || scale <= 0) return;
    const r = el.getBoundingClientRect();
    onNavigate(
      clamp((clientX - r.left - offX) / scale, 0, imgWidth),
      clamp((clientY - r.top - offY) / scale, 0, imgHeight),
    );
  };

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !onNavigate) return;
    e.preventDefault();
    navigateFromEvent(e.clientX, e.clientY);
    // 按住拖动 = 连续导航（跟 PS 一样是可以"扫"过去的）
    const onMove = (ev: MouseEvent) => navigateFromEvent(ev.clientX, ev.clientY);
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  return (
    <div
      ref={boxRef}
      onMouseDown={onMouseDown}
      className="relative w-full rounded border border-neutral-200 dark:border-neutral-700 bg-neutral-100 dark:bg-neutral-900 overflow-hidden"
      // 指针保持普通箭头：全览图是辅助面板，用十字线太抢眼（用户实测反馈）
      style={{ height: BOX_HEIGHT }}
    >
      {ready ? (
        <>
          <img
            src={thumb}
            alt="全览"
            draggable={false}
            className="absolute select-none"
            style={{ left: offX, top: offY, width: dispW, height: dispH }}
          />
          {frame && (
            <div
              className="absolute pointer-events-none border border-blue-500 dark:border-blue-400"
              style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
            />
          )}
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[10px] text-neutral-400">
          等待代理图…
        </div>
      )}
    </div>
  );
};
