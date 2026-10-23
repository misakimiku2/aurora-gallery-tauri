/**
 * 全览图（PS 的 Navigator 面板，UI 设计 §4 的面板组之首）。
 *
 * 显示**活动图层**的缩略（单图层时即整张文档），并把**当前视口**画成一个框 —— 缩放到
 * 400% 之后，这是唯一能让用户知道「我在图的哪个位置」的东西。点击/拖动可以导航。
 *
 * 布局用**缩略图自己的宽高**（`thumb.width/height`），不是"当前文档尺寸"：
 * 旋转 90° 时新尺寸先到、新缩略图后到（Image 解码异步），中间那一帧若用新尺寸撑
 * 旧图，就会把图拉变形（用户实测的"全览图拉伸一下"）。同理，两者比例对不上时
 * 不画视口框——否则框会跳到错误位置。
 */
import React, { useEffect, useRef, useState } from 'react';
import type { EditorViewSnapshot } from './editorViewStore';
import type { EditorThumb } from './useEditorThumbnail';

interface EditorNavigatorProps {
  /** 高质量缩略图（由 `useEditorThumbnail` 逐级降采样生成，自带宽高） */
  thumb?: EditorThumb;
  /** 当前文档尺寸（裁剪之后），视口框按它换算 */
  imgWidth: number;
  imgHeight: number;
  view?: EditorViewSnapshot;
  /** 点击/拖动全览图 → 请画布把该点移到视口中央（画布像素坐标） */
  onNavigate?: (imgX: number, imgY: number) => void;
  /** 缩略图也要套上当前调色滤镜，否则「画布偏暖、全览正常」 */
  imgFilter?: string;
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
  imgFilter,
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

  const thumbW = thumb?.width ?? 0;
  const thumbH = thumb?.height ?? 0;
  const ready = Boolean(thumb && thumbW > 0 && thumbH > 0 && boxW > 0);
  // 不放大缩略图：它本来就只有 320px，撑满盒子只会更糊
  const dispScale = ready ? Math.min(boxW / thumbW, BOX_HEIGHT / thumbH, 1) : 0;
  const dispW = thumbW * dispScale;
  const dispH = thumbH * dispScale;
  const offX = (boxW - dispW) / 2;
  const offY = (BOX_HEIGHT - dispH) / 2;

  /** 文档坐标 → 全览显示坐标的比例 */
  const docToDisp = imgWidth > 0 ? dispW / imgWidth : 0;

  // 缩略图与画布比例对不上：可能是新图还没解码完（旋转后那一瞬），
  // 也可能是多图层 / 图层比例≠画布——后者是常态，不是延迟
  const aspectMatches =
    ready && imgWidth > 0 && imgHeight > 0
      ? Math.abs(thumbW / thumbH - imgWidth / imgHeight) < 0.02
      : false;

  /**
   * 视口框。只有「视口确实没有盖住整份文档」时才画框并压暗框外。
   *
   * ⚠️ 缩小到「整份文档都装进了视口」（适应窗口）时，交出来的视口就是全图——
   * 这时**没有任何框外区域**，既不画框也不压暗（用户实测：缩小后全览图全暗了，
   * 就是这里把"盖满全图"误当成"没有框"退回了整块压暗）。
   */
  let frame: { left: number; top: number; width: number; height: number } | null = null;
  if (aspectMatches && docToDisp > 0 && view && view.scale > 0) {
    const { scale: vs, x, y, containerWidth: cw, containerHeight: ch } = view;
    const left = Math.max(0, (0 - x) / vs);
    const top = Math.max(0, (0 - y) / vs);
    const right = Math.min(imgWidth, (cw - x) / vs);
    const bottom = Math.min(imgHeight, (ch - y) / vs);
    if (right > left && bottom > top && (right - left < imgWidth || bottom - top < imgHeight)) {
      frame = {
        left: offX + left * docToDisp,
        top: offY + top * docToDisp,
        width: (right - left) * docToDisp,
        height: (bottom - top) * docToDisp,
      };
    }
  }

  // 点击 / 拖动导航（PS 的 Navigator 就是这样：点哪儿看哪儿）
  const navigateFromEvent = (clientX: number, clientY: number) => {
    const el = boxRef.current;
    if (!el || !onNavigate || !ready || docToDisp <= 0) return;
    const r = el.getBoundingClientRect();
    onNavigate(
      clamp((clientX - r.left - offX) / docToDisp, 0, imgWidth),
      clamp((clientY - r.top - offY) / docToDisp, 0, imgHeight),
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
            src={thumb!.src}
            alt="全览"
            draggable={false}
            className="absolute select-none"
            style={{ left: offX, top: offY, width: dispW, height: dispH, filter: imgFilter }}
          />
          {/*
            只压暗**视口框以外**的部分（用户明确要的效果）：四条矩形把框外的
            上/下/左/右盖住，框内保持原样——PS 的 Navigator 也是这个做法。
            框不存在 = 视口盖住了整份文档（适应窗口）或比例还没对上，
            此时**没有框外区域，什么都不压暗**——退回整块压暗就是"缩小后全暗"那个 bug。
          */}
          {frame && (
            <>
              <div
                className="pointer-events-none absolute inset-x-0 top-0 bg-black/35"
                style={{ height: Math.max(0, frame.top) }}
              />
              <div
                className="pointer-events-none absolute inset-x-0 bg-black/35"
                style={{
                  top: frame.top + frame.height,
                  height: Math.max(0, BOX_HEIGHT - frame.top - frame.height),
                }}
              />
              <div
                className="pointer-events-none absolute bg-black/35"
                style={{ left: 0, top: frame.top, width: Math.max(0, frame.left), height: frame.height }}
              />
              <div
                className="pointer-events-none absolute bg-black/35"
                style={{
                  left: frame.left + frame.width,
                  top: frame.top,
                  width: Math.max(0, boxW - frame.left - frame.width),
                  height: frame.height,
                }}
              />
            </>
          )}

          {frame && (
            <div
              className="absolute pointer-events-none border border-blue-500 dark:border-blue-400"
              style={{ left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
            />
          )}
        </>
      ) : (
        <div className="w-full h-full flex items-center justify-center text-[10px] text-neutral-400">
          等待缩略图…
        </div>
      )}
    </div>
  );
};
