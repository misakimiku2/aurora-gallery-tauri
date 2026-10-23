/**
 * 裁剪框（PS 的裁剪工具覆盖层）。
 *
 * 坐标口径：**一律用画布像素坐标**（v2 里画布坐标 = 文档坐标），不用屏幕坐标。
 * 理由：裁剪最终是"改画布尺寸 + 图层反向平移"，屏幕坐标只是它的一次投影；
 * 若在屏幕坐标里存框，缩放或换倍率之后框就和内容对不上了。
 *
 * 投影链：画布像素 → × proxyScale → × transform.scale + transform.xy → 屏幕。
 *
 * `proxyScale` 是 v1 遗留的"代理图 / 源图"比例。v2 画布直接渲染原文件，**恒为 1**；
 * 保留参数是为了不重算投影公式（将来接"视口内原图切片"时还能用）。
 *
 * 交互（照 PS）：
 * - 在框内拖动 = 移动整框
 * - 拖 8 个把手 = 调整边/角
 * - 在框外拖动 = 重新拉一个新框
 * - Enter 确认 / Esc 取消
 *
 * 比例约束的数学在 `cropGeometry.ts`（纯函数 + 单测），这里只负责命中判定、
 * 屏幕投影与鼠标事件。
 */
import React, { useCallback, useRef } from 'react';
import type { Transform } from '../comparer/viewport';
import {
  CropArea,
  CropHandle,
  clampNumber,
  computeRatioRect,
  normalizeRect,
} from './cropGeometry';

export type { CropArea };

interface CropOverlayProps {
  /** 画布尺寸 —— 坐标基准（v2 裁剪/旋转后与源图自然尺寸已无关） */
  docWidth: number;
  docHeight: number;
  /** v1 的"代理图 / 源图"比例（≤ 1）。v2 恒为 1：画布直接显示原文件 */
  proxyScale: number;
  transform: Transform;
  rect: CropArea | null;
  /** 宽高比（w/h）。null / undefined = 自由裁剪 */
  aspectRatio?: number | null;
  onChange: (rect: CropArea) => void;
}

/** 把手命中半径（屏幕 px） */
const HANDLE_HIT = 10;
/** 把手视觉尺寸（屏幕 px） */
const HANDLE_SIZE = 8;

export const CropOverlay: React.FC<CropOverlayProps> = ({
  docWidth,
  docHeight,
  proxyScale,
  transform,
  rect,
  aspectRatio,
  onChange,
}) => {
  // 源图坐标 → 屏幕坐标的合成比例
  const screenRatio = proxyScale * transform.scale;
  const dragRef = useRef<{
    mode: 'move' | 'new' | CropHandle;
    startX: number;
    startY: number;
    origin: CropArea;
  } | null>(null);

  /** 屏幕坐标 → 源图坐标 */
  const toDoc = useCallback(
    (clientX: number, clientY: number, bounds: DOMRect) => ({
      x: (clientX - bounds.left - transform.x) / screenRatio,
      y: (clientY - bounds.top - transform.y) / screenRatio,
    }),
    [transform.x, transform.y, screenRatio],
  );

  const hitTest = useCallback(
    (docX: number, docY: number): CropHandle | 'inside' | 'outside' => {
      if (!rect) return 'outside';
      const tol = HANDLE_HIT / screenRatio;
      const nearL = Math.abs(docX - rect.x) <= tol;
      const nearR = Math.abs(docX - (rect.x + rect.w)) <= tol;
      const nearT = Math.abs(docY - rect.y) <= tol;
      const nearB = Math.abs(docY - (rect.y + rect.h)) <= tol;
      const insideX = docX >= rect.x - tol && docX <= rect.x + rect.w + tol;
      const insideY = docY >= rect.y - tol && docY <= rect.y + rect.h + tol;

      if (nearL && nearT) return 'nw';
      if (nearR && nearT) return 'ne';
      if (nearL && nearB) return 'sw';
      if (nearR && nearB) return 'se';
      if (nearT && insideX) return 'n';
      if (nearB && insideX) return 's';
      if (nearL && insideY) return 'w';
      if (nearR && insideY) return 'e';
      if (insideX && insideY) return 'inside';
      return 'outside';
    },
    [rect, screenRatio],
  );

  const onMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    // 别让画布的「拖动平移」抢走这次按下
    e.stopPropagation();
    const bounds = e.currentTarget.getBoundingClientRect();
    const p = toDoc(e.clientX, e.clientY, bounds);
    const hit = hitTest(p.x, p.y);
    const ratio = aspectRatio ?? null;

    let mode: 'move' | 'new' | CropHandle;
    let origin: CropArea;

    if (hit === 'outside' || !rect) {
      const start: CropArea = {
        x: clampNumber(p.x, 0, docWidth),
        y: clampNumber(p.y, 0, docHeight),
        w: 0,
        h: 0,
      };
      mode = 'new';
      origin = start;
      onChange(start);
    } else {
      mode = hit === 'inside' ? 'move' : hit;
      origin = { ...rect };
    }
    dragRef.current = { mode, startX: p.x, startY: p.y, origin };

    const onMove = (ev: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const cur = toDoc(ev.clientX, ev.clientY, bounds);

      // 移动整框：不受比例影响（比例本来就没变）
      if (d.mode === 'move') {
        const dx = cur.x - d.startX;
        const dy = cur.y - d.startY;
        onChange({
          x: Math.round(clampNumber(d.origin.x + dx, 0, docWidth - d.origin.w)),
          y: Math.round(clampNumber(d.origin.y + dy, 0, docHeight - d.origin.h)),
          w: d.origin.w,
          h: d.origin.h,
        });
        return;
      }

      if (ratio) {
        onChange(
          computeRatioRect(
            d.mode,
            { x: d.startX, y: d.startY },
            cur,
            d.origin,
            ratio,
            docWidth,
            docHeight,
          ),
        );
        return;
      }

      // 自由裁剪：从空白拉新框
      if (d.mode === 'new') {
        const nx = clampNumber(Math.min(d.startX, cur.x), 0, docWidth);
        const ny = clampNumber(Math.min(d.startY, cur.y), 0, docHeight);
        const nw = clampNumber(Math.abs(cur.x - d.startX), 0, docWidth - nx);
        const nh = clampNumber(Math.abs(cur.y - d.startY), 0, docHeight - ny);
        onChange({ x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh) });
        return;
      }

      // 自由裁剪：拖把手
      const dx = cur.x - d.startX;
      const dy = cur.y - d.startY;
      const o = d.origin;
      let left = o.x;
      let top = o.y;
      let right = o.x + o.w;
      let bottom = o.y + o.h;
      if (d.mode.includes('w')) left = clampNumber(o.x + dx, 0, right);
      if (d.mode.includes('e')) right = clampNumber(o.x + o.w + dx, left, docWidth);
      if (d.mode.includes('n')) top = clampNumber(o.y + dy, 0, bottom);
      if (d.mode.includes('s')) bottom = clampNumber(o.y + o.h + dy, top, docHeight);

      const norm = normalizeRect({ x: left, y: top, w: right - left, h: bottom - top });
      onChange({
        x: Math.round(norm.x),
        y: Math.round(norm.y),
        w: Math.round(norm.w),
        h: Math.round(norm.h),
      });
    };

    const onUp = () => {
      dragRef.current = null;
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  };

  if (!rect) {
    return <div className="absolute inset-0" style={{ cursor: 'crosshair' }} onMouseDown={onMouseDown} />;
  }

  // 源图 → 屏幕
  const sx = transform.x + rect.x * screenRatio;
  const sy = transform.y + rect.y * screenRatio;
  const sw = rect.w * screenRatio;
  const sh = rect.h * screenRatio;

  const handles: Array<{ id: CropHandle; left: number; top: number; cursor: string }> = [
    { id: 'nw', left: 0, top: 0, cursor: 'nwse-resize' },
    { id: 'n', left: 0.5, top: 0, cursor: 'ns-resize' },
    { id: 'ne', left: 1, top: 0, cursor: 'nesw-resize' },
    { id: 'e', left: 1, top: 0.5, cursor: 'ew-resize' },
    { id: 'se', left: 1, top: 1, cursor: 'nwse-resize' },
    { id: 's', left: 0.5, top: 1, cursor: 'ns-resize' },
    { id: 'sw', left: 0, top: 1, cursor: 'nesw-resize' },
    { id: 'w', left: 0, top: 0.5, cursor: 'ew-resize' },
  ];

  return (
    <div className="absolute inset-0" style={{ cursor: 'crosshair' }} onMouseDown={onMouseDown}>
      {/* 框：box-shadow 铺满四周当遮罩，比四个 div 省事且没有接缝 */}
      <div
        className="absolute border border-white/90"
        style={{
          left: sx,
          top: sy,
          width: sw,
          height: sh,
          boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)',
          cursor: 'move',
        }}
      >
        {/* 三分线（PS 默认显示） */}
        <div className="absolute inset-0 pointer-events-none opacity-40">
          <div className="absolute left-1/3 top-0 bottom-0 w-px bg-white" />
          <div className="absolute left-2/3 top-0 bottom-0 w-px bg-white" />
          <div className="absolute top-1/3 left-0 right-0 h-px bg-white" />
          <div className="absolute top-2/3 left-0 right-0 h-px bg-white" />
        </div>

        {/* 尺寸读数 */}
        <div className="absolute left-1/2 -translate-x-1/2 -top-6 px-1.5 py-0.5 rounded bg-black/75 text-[11px] tabular-nums text-white whitespace-nowrap pointer-events-none">
          {Math.round(rect.w)} × {Math.round(rect.h)}
        </div>

        {handles.map(h => (
          <div
            key={h.id}
            className="absolute bg-white border border-neutral-700"
            style={{
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              left: sw * h.left - HANDLE_SIZE / 2,
              top: sh * h.top - HANDLE_SIZE / 2,
              cursor: h.cursor,
            }}
          />
        ))}
      </div>
    </div>
  );
};
