/**
 * 画笔的圆形光标环（画笔/橡皮工具）：直径 = 笔径 × 视口缩放，跟随鼠标。
 *
 * 系统光标在工具态被置为 `none`（ImageEditor）——**这个环就是唯一光标**，所以
 * 笔径再小也要保住 4px 的最小可见直径，不能藏。直接写 DOM style、不走 state
 * ——鼠标每动一下都 setState 会拖着整个编辑器重渲染。笔径/缩放经 ref 每次读取
 * （组件随 ImageEditor 重渲染时刷新），监听器只挂一次。
 */
import React, { useEffect, useRef } from 'react';

export const BrushCursor: React.FC<{
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** 笔径（文档像素） */
  size: number;
  /** 当前视口缩放（环的屏幕直径 = size × scale，下限 4px） */
  scale: number;
}> = ({ containerRef, size, scale }) => {
  const ringRef = useRef<HTMLDivElement | null>(null);
  const liveRef = useRef({ size, scale });
  liveRef.current = { size, scale };

  useEffect(() => {
    const container = containerRef.current;
    const ring = ringRef.current;
    if (!container || !ring) return;
    const place = (e: MouseEvent) => {
      const rect = container.getBoundingClientRect();
      // 环是唯一光标（系统光标已 none）：4px 下限保证永远可见
      const d = Math.max(4, liveRef.current.size * liveRef.current.scale);
      ring.style.width = `${d}px`;
      ring.style.height = `${d}px`;
      ring.style.left = `${e.clientX - rect.left - d / 2}px`;
      ring.style.top = `${e.clientY - rect.top - d / 2}px`;
      ring.style.opacity = '1';
    };
    const hide = () => {
      ring.style.opacity = '0';
    };
    container.addEventListener('mousemove', place);
    container.addEventListener('mouseleave', hide);
    return () => {
      container.removeEventListener('mousemove', place);
      container.removeEventListener('mouseleave', hide);
    };
  }, [containerRef]);

  // 白环 + 深色外影：任何底色上都看得清（PS 同款做法）
  return (
    <div
      ref={ringRef}
      aria-hidden
      className="absolute pointer-events-none rounded-full border border-white"
      style={{ opacity: 0, zIndex: 120, boxShadow: '0 0 0 1px rgba(0,0,0,0.55)' }}
    />
  );
};
