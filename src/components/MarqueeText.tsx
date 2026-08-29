import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * 侧边栏行文本：
 * - 未激活（行未选中）：与普通 truncate 一样显示省略号；
 * - 激活（行选中）且内容超出可显示宽度：来回滚动（marquee）展示全部内容。
 *
 * 结构：未滚动时文本直接作为行内容渲染（text-overflow: ellipsis 只对
 * 文本/inline 内容生效，包一层 inline-block 会失效变硬截断）；只有滚动时
 * 才包一层 inner span 供 transform 平移。
 *
 * 溢出检测：wrapper.scrollWidth - clientWidth（与滚动状态无关、纯布局值），
 * 挂载时测一次 + ResizeObserver / 延迟补测 / document.fonts.ready 兜底；
 * 滚动进行中跳过测量（内容被位移后 scrollWidth 会失真），避免来回抖动。
 */

// 所有 MarqueeText 实例共享一个 ResizeObserver，避免每行单独创建
let sharedResizeObserver: ResizeObserver | null = null;
const resizeCallbacks = new WeakMap<Element, () => void>();

const getSharedResizeObserver = (): ResizeObserver | null => {
  if (typeof ResizeObserver === 'undefined') return null;
  if (!sharedResizeObserver) {
    sharedResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        resizeCallbacks.get(entry.target)?.();
      }
    });
  }
  return sharedResizeObserver;
};

interface MarqueeTextProps {
  /** 额外类名（行内通常传 flex-1 接管剩余宽度） */
  className?: string;
  /** 仅在该行为激活（选中/当前）状态时才滚动，未激活显示省略号 */
  active?: boolean;
  /** 滚动速度（px/秒） */
  speed?: number;
  /** 悬停提示（传给外层元素） */
  title?: string;
  children: React.ReactNode;
}

const MarqueeText: React.FC<MarqueeTextProps> = ({
  className = '',
  active = false,
  speed = 32,
  title,
  children,
}) => {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(0);

  const scrollingRef = useRef(false);
  const scrolling = active && overflow > 0;
  scrollingRef.current = scrolling;

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    // 滚动中内容被位移，scrollWidth 不再反映真实文本宽度，跳过本次测量
    if (scrollingRef.current) return;
    const diff = wrap.scrollWidth - wrap.clientWidth;
    const next = diff > 2 ? Math.ceil(diff) : 0;
    setOverflow((prev) => (prev === next ? prev : next));
  }, []);

  // 行宽变化（拖动面板宽度/折叠侧栏）：若正在滚动，位移量已失效，
  // 先停掉滚动，稍后按新宽度重新测量
  const handleResize = useCallback(() => {
    if (scrollingRef.current) {
      setOverflow(0);
      window.setTimeout(measure, 80);
      return;
    }
    measure();
  }, [measure]);

  // 挂载时测量一次（依赖恒定，不会随渲染反复执行）
  useLayoutEffect(() => {
    measure();
  }, [measure]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const ro = getSharedResizeObserver();
    if (ro) {
      resizeCallbacks.set(wrap, handleResize);
      ro.observe(wrap);
    }

    // 字体异步加载 / 容器过渡动画会让首测结果失真，延迟补测兜底
    let cancelled = false;
    const reMeasure = () => {
      if (!cancelled) measure();
    };
    const timers = [120, 400, 1000, 2500].map((ms) => window.setTimeout(reMeasure, ms));
    document.fonts?.ready.then(reMeasure).catch(() => {});

    return () => {
      cancelled = true;
      timers.forEach((t) => window.clearTimeout(t));
      if (ro) {
        resizeCallbacks.delete(wrap);
        ro.unobserve(wrap);
      }
    };
  }, [handleResize]);

  const baseClass = `aurora-marquee ${scrolling ? '' : 'aurora-marquee-static'} ${className}`;

  // 未滚动：文本直接作为行内容，text-overflow: ellipsis 才会生效
  if (!scrolling) {
    return (
      <span ref={wrapRef} title={title} className={baseClass}>
        {children}
      </span>
    );
  }

  const duration = Math.min(12, Math.max(3.5, overflow / speed));
  return (
    <span ref={wrapRef} title={title} className={baseClass}>
      <span
        className="aurora-marquee-inner aurora-marquee-scrolling"
        style={
          {
            '--marquee-shift': `-${overflow}px`,
            '--marquee-duration': `${duration.toFixed(2)}s`,
          } as React.CSSProperties
        }
      >
        {children}
      </span>
    </span>
  );
};

export default MarqueeText;
