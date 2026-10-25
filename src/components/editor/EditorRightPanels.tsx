/**
 * 编辑器右侧面板栈(渲染在应用右侧面板槽位里,替换详情面板):
 * 自上而下 颜色 / 属性·调整·历史 / 导航器·信息 / 图层,组间分隔条可拖调高度。
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
const GROUP_TITLES = ['颜色', '属性 · 调整 · 历史记录', '导航器 · 信息', '图层 · 路径'];
/** 分隔条高度(px)——初始分配时要从容器里扣除,否则总高溢出把最后一组底部裁掉。 */
const DIVIDER_H = 10;

export const EditorRightPanels: React.FC<{ tabId: string }> = ({ tabId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [heights, setHeights] = useState<number[] | null>(null);

  // 首次测量容器高度,按权重分配(扣除分隔条;图层组最大)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const init = () => {
      if (heights) return;
      const avail = el.clientHeight - 3 * DIVIDER_H;
      if (avail > 100) setHeights([avail * 0.2, avail * 0.26, avail * 0.24, avail * 0.3]);
    };
    init();
    const ro = new ResizeObserver(init);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onDividerDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    if (!heights) return;
    (e.target as Element).setPointerCapture(e.pointerId);
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
    <div ref={containerRef} className="h-full flex flex-col bg-panel overflow-hidden">
      {heights === null
        ? groups.map((g, i) => (
            <div key={i} className="flex-1 min-h-0 overflow-hidden">
              {g}
            </div>
          ))
        : groups.map((g, i) => (
            <React.Fragment key={i}>
              <div className="shrink-0 overflow-hidden" style={{ height: heights[i] }} title={GROUP_TITLES[i]}>
                <div className="h-full flex flex-col overflow-hidden">{g}</div>
              </div>
              {i < groups.length - 1 && (
                <div
                  onPointerDown={onDividerDown(i)}
                  className="h-2.5 shrink-0 cursor-row-resize flex items-center px-2 hover:bg-sky-500/20 transition-colors"
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
