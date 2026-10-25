/**
 * 编辑器右侧面板栈(渲染在应用右侧面板槽位里,替换详情面板):
 * 自上而下 颜色 / 属性·调整·历史 / 导航器·信息 / 图层,组间分隔条可拖调高度。
 *
 * 高度分配原则(图层页脚永不消失的保证):
 * - 默认不测量、不定格——四组按 flex-grow 权重由布局期直接分配,总高永远恰好填满容器,
 *   任何挂载/过渡/窗口缩放时序下都不可能溢出(溢出会裁掉末组页脚)或欠填(下方留白)。
 * - 只有用户拖动分隔条时才把当前各组实际像素高冻结为固定值;
 *   此后容器尺寸再变化(窗口缩放等),按比例缩放各组并保持总高恰好填满。
 * - 容器高到低于各组 minHeight 之和时改为可滚动,页脚仍可达而不是被裁没。
 */
import React, { useEffect, useRef, useState } from 'react';
import { ColorPanel } from './panels/ColorPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { NavigatorInfoPanel } from './panels/NavigatorInfoPanel';
import { LayersPanel } from './panels/LayersPanel';

/** 属性/调整/历史 组(历史可用,属性·调整 M3 填充)。 */
const MidPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [tab, setTab] = useState<'props' | 'adjust' | 'history'>('history');
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex shrink-0 border-b border-black/10 dark:border-white/10">
        {([['props', '属性'], ['adjust', '调整'], ['history', '历史记录']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-2.5 py-1 text-[11px] ${tab === k ? 'text-sky-700 dark:text-neutral-100 border-b-2 border-sky-500' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-300'}`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 flex flex-col">
        {tab === 'history' && <HistoryPanel tabId={tabId} />}
        {tab === 'props' && <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">文档属性/蒙版属性(M3)</div>}
        {tab === 'adjust' && <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">16 种调整层(M3)</div>}
      </div>
    </div>
  );
};

/** 各组的最小高度(px)。 */
const MIN_H = [132, 120, 168, 132];
/** 未拖动时的初始权重(flex-grow,图层组最大)。 */
const GROW = [0.2, 0.26, 0.24, 0.3];
const GROUP_TITLES = ['颜色', '属性 · 调整 · 历史记录', '导航器 · 信息', '图层 · 路径'];
/** 分隔条高度(px)。 */
const DIVIDER_H = 10;

/** 把已定格的各组高度按新可用高缩放:比例保持、钳到各自最小值、误差补进末组,总高恒等于 avail。 */
const rescale = (prev: number[], avail: number): number[] => {
  const total = prev.reduce((a, b) => a + b, 0);
  if (total <= 0 || avail <= 0) return prev;
  const next = prev.map((h, i) => Math.max(MIN_H[i], (h / total) * avail));
  next[3] = Math.max(MIN_H[3], next[3] + (avail - next.reduce((a, b) => a + b, 0)));
  return next;
};

export const EditorRightPanels: React.FC<{ tabId: string }> = ({ tabId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** null=未拖动,按权重分配;拖动后为各组像素高(容器尺寸变化时按比例缩放)。 */
  const [heights, setHeights] = useState<number[] | null>(null);
  const heightsRef = useRef<number[] | null>(null);
  heightsRef.current = heights;

  // 拖动定格后容器高度变化:等比缩放各组,保持恰好填满
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(() => {
      if (!heightsRef.current) return;
      const avail = el.clientHeight - 3 * DIVIDER_H;
      setHeights((prev) => (prev ? rescale(prev, avail) : prev));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const onDividerDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    // 首次拖动:把当前布局冻结为像素值,之后只在相邻两组间转移高度
    setHeights(groupRefs.current.map((g) => (g ? g.getBoundingClientRect().height : MIN_H[0])));
    let lastY = e.clientY;
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - lastY;
      lastY = ev.clientY;
      setHeights((prev) => {
        if (!prev) return prev;
        const next = [...prev];
        const room = next[i + 1] - MIN_H[i + 1];
        const grow = Math.min(dy, room);
        next[i] = Math.max(MIN_H[i], next[i] + grow);
        next[i + 1] = Math.max(MIN_H[i + 1], next[i + 1] - (next[i] - prev[i]));
        return next;
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const groups: React.ReactNode[] = [
    <ColorPanel key="color" tabId={tabId} />,
    <MidPanel key="mid" tabId={tabId} />,
    <NavigatorInfoPanel key="nav" tabId={tabId} />,
    <LayersPanel key="layers" tabId={tabId} />,
  ];

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-panel overflow-y-auto overflow-x-hidden">
      {groups.map((g, i) => (
        <React.Fragment key={i}>
          <div
            ref={(el) => { groupRefs.current[i] = el; }}
            className="overflow-hidden"
            style={
              heights
                ? { height: heights[i], flexShrink: 0, minHeight: MIN_H[i] }
                : { flexGrow: GROW[i], flexBasis: 0, flexShrink: 1, minHeight: MIN_H[i] }
            }
            title={GROUP_TITLES[i]}
          >
            <div className="h-full flex flex-col overflow-hidden">{g}</div>
          </div>
          {i < groups.length - 1 && (
            <div
              onPointerDown={onDividerDown(i)}
              className="shrink-0 cursor-row-resize flex items-center px-2 hover:bg-sky-500/20 transition-colors"
              style={{ height: DIVIDER_H }}
              title="拖动调节面板高度"
            >
              <div className="h-[3px] w-full bg-black/10 dark:bg-white/25 rounded-sm" />
            </div>
          )}
        </React.Fragment>
      ))}
    </div>
  );
};
