/**
 * 可拖动取色卡(文字颜色/渐变色标拾色器共用壳):标题栏按住拖动(实时钳视口)、
 * 内容区 h-44 flex(ColorPicker 的 SV 方块 flex-1 满高——坏壳纯 h-44 会让它塌到
 * min-height、下方留大片空白)、外点/Esc 关闭可选(渐变色标=开,文字颜色=显式关闭)。
 * 位置存内部状态:关卡即弃,重开回初始位。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export const PickerCard: React.FC<{
  title: string;
  onClose: () => void;
  /** 初始位置(省略=视口居中;按实际卡尺寸钳进视口)。 */
  at?: { left: number; top: number };
  /** 拖动位置持久化键(localStorage):门控隐藏=组件卸载,重挂靠它回原位
   *  (SelectMaskDialog 位置持久化同口径)。省略=每次回初始位。 */
  storageKey?: string;
  /** 外点/Esc 关闭(渐变色标卡口径;文字颜色卡不传=只显式关)。 */
  closeOnOutside?: boolean;
  /** 底部按钮区(省略=单个「关闭」)。 */
  footer?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, onClose, at, storageKey, closeOnOutside, footer, children }) => {
  const cardRef = useRef<HTMLDivElement>(null);
  const loadPos = (): { left: number; top: number } | null => {
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (!raw) return null;
      const v = JSON.parse(raw) as { left?: number; top?: number };
      if (typeof v.left === 'number' && typeof v.top === 'number') return { left: v.left, top: v.top };
    } catch { /* 坏数据忽略,回初始位 */ }
    return null;
  };
  const [pos, setPos] = useState<{ left: number; top: number } | null>(loadPos);
  // 初始位定格一次(at 引用不随渲染变化)
  const atRef = useRef(at);
  const savePos = (p: { left: number; top: number }) => {
    setPos(p);
    if (storageKey) {
      try { localStorage.setItem(storageKey, JSON.stringify(p)); } catch { /* 配额/隐私模式忽略 */ }
    }
  };

  // 挂载即定位:已持久化 > at > 居中,按实际卡尺寸钳进视口(layout 阶段 setState 不闪帧)
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPos((prev) => {
      const base = prev ?? atRef.current ?? { left: (window.innerWidth - r.width) / 2, top: (window.innerHeight - r.height) / 2 };
      return {
        left: Math.max(4, Math.min(base.left, window.innerWidth - r.width - 4)),
        top: Math.max(4, Math.min(base.top, window.innerHeight - r.height - 4)),
      };
    });
  }, []);

  // 外点/Esc 关闭(渐变色标口径)
  useEffect(() => {
    if (!closeOnOutside) return;
    const close = (ev: MouseEvent) => {
      if (cardRef.current?.contains(ev.target as Node)) return;
      onClose();
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [closeOnOutside, onClose]);

  // 标题栏按住拖动:整卡跟随指针,实时钳视口
  const dragTitle = (e: React.PointerEvent) => {
    const card = cardRef.current;
    if (!card || e.button !== 0) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const base = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    const move = (ev: PointerEvent) => {
      savePos({
        left: Math.max(4, Math.min(base.left + ev.clientX - base.x, window.innerWidth - r.width - 4)),
        top: Math.max(4, Math.min(base.top + ev.clientY - base.y, window.innerHeight - r.height - 4)),
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return createPortal(
    <div
      ref={cardRef}
      className="fixed z-[1000] w-56 rounded-md bg-[#FAFAFA]/95 dark:bg-[#3a3a3a]/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 p-2"
      style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0 }}
    >
      <div
        onPointerDown={dragTitle}
        title="按住拖动"
        className="flex items-center mb-1 cursor-grab active:cursor-grabbing select-none"
      >
        <span className="flex-1 truncate text-[11px] text-neutral-500 dark:text-neutral-400">{title}</span>
      </div>
      <div className="h-44 flex flex-col">{children}</div>
      <div className="flex justify-end mt-1.5">
        {footer ?? (
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-0.5 rounded text-[11px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
          >
            关闭
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};
