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
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ColorPanel } from './panels/ColorPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { NavigatorInfoPanel } from './panels/NavigatorInfoPanel';
import { LayersPanel } from './panels/LayersPanel';
import { AdjustmentGrid } from './panels/AdjustmentGrid';
import { AdjustmentProps } from './panels/AdjustmentProps';

/** 属性/调整/历史 组:调整页=16 种调整层一键,属性页=选中调整层时的参数编辑器。
 * 双击蒙版缩略图等入口经 `aurora-editor-panel` 窗口事件请求切页(与 aurora-editor-saved 同款跨组件信号)。
 * 折叠口径:点已激活页签=收起/展开本组内容;折叠中点任意页签=展开并切换。 */
const MidPanel: React.FC<{ tabId: string; collapsed?: boolean; onToggle?: () => void }> = ({
  tabId, collapsed, onToggle,
}) => {
  const [tab, setTab] = useState<'props' | 'adjust' | 'history'>('history');
  const collapsedRef = useRef(!!collapsed);
  collapsedRef.current = !!collapsed;
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  useEffect(() => {
    const onPanel = (e: Event) => {
      const d = (e as CustomEvent<{ tabId?: string; tab?: 'props' | 'adjust' | 'history' }>).detail;
      if (d && (d.tabId == null || d.tabId === tabId) && d.tab) {
        setTab(d.tab);
        if (collapsedRef.current) toggleRef.current?.(); // 折叠中收到切页信号=顺带展开
      }
    };
    window.addEventListener('aurora-editor-panel', onPanel);
    return () => window.removeEventListener('aurora-editor-panel', onPanel);
  }, [tabId]);
  return (
    <div className="h-full min-h-0 flex flex-col">
      <div className="flex shrink-0 border-b border-black/10 dark:border-white/10">
        {([['props', '属性'], ['adjust', '调整'], ['history', '历史记录']] as const).map(([k, label]) => (
          <button
            key={k}
            onClick={() => {
              if (collapsed) { setTab(k); onToggle?.(); return; }
              if (tab === k) onToggle?.();
              else setTab(k);
            }}
            className={`px-2.5 py-1 text-[11px] ${tab === k ? 'text-sky-700 dark:text-neutral-100 border-b-2 border-sky-500' : 'text-neutral-500 dark:text-neutral-400 hover:text-neutral-800 dark:hover:text-neutral-300'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {!collapsed && (
        <div className="flex-1 min-h-0 flex flex-col">
          {tab === 'history' && <HistoryPanel tabId={tabId} />}
          {tab === 'props' && <AdjustmentProps tabId={tabId} />}
          {tab === 'adjust' && <AdjustmentGrid tabId={tabId} onAdded={() => setTab('props')} />}
        </div>
      )}
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

/** 把已定格的展开组高度按新可用高缩放:比例保持、钳到各自最小值、误差补进末个展开组;
 * 折叠组不参与(只占页签条高,bar 由调用方实测扣除),总高恒等于 avail。 */
const rescale = (prev: number[], expanded: number[], avail: number): number[] => {
  if (!expanded.length || avail <= 0) return prev;
  const next = [...prev];
  const total = expanded.reduce((a, i) => a + prev[i], 0);
  if (total > 0) for (const i of expanded) next[i] = Math.max(MIN_H[i], (prev[i] / total) * avail);
  else for (const i of expanded) next[i] = Math.max(MIN_H[i], avail / expanded.length);
  const last = expanded[expanded.length - 1];
  next[last] = Math.max(MIN_H[last], next[last] + (avail - expanded.reduce((a, i) => a + next[i], 0)));
  return next;
};

export const EditorRightPanels: React.FC<{ tabId: string }> = ({ tabId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<(HTMLDivElement | null)[]>([]);
  /** null=未拖动,按权重分配;拖动后为各组像素高(容器尺寸变化时按比例缩放)。 */
  const [heights, setHeights] = useState<number[] | null>(null);
  const heightsRef = useRef<number[] | null>(null);
  heightsRef.current = heights;
  /** 组折叠(内容收起只留页签条);点已激活页签切换,再点任意页签展开。 */
  const [collapsed, setCollapsed] = useState<boolean[]>([false, false, false, false]);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  const toggleCollapse = (i: number) => setCollapsed((prev) => prev.map((c, j) => (j === i ? !c : c)));

  // 展开组重新填满(折叠组页签条高按当前 DOM 实测扣除):容器尺寸变化与折叠切换时调用
  const rescaleExpanded = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setHeights((prev) => {
      if (!prev) return prev;
      const bars = collapsedRef.current.reduce(
        (a, c, i) => a + (c ? (groupRefs.current[i]?.getBoundingClientRect().height ?? 0) : 0), 0,
      );
      const avail = el.clientHeight - 3 * DIVIDER_H - bars;
      const expanded = [0, 1, 2, 3].filter((i) => !collapsedRef.current[i]);
      return rescale(prev, expanded, avail);
    });
  }, []);

  // 拖动定格后容器高度变化:等比缩放各组,保持恰好填满
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(rescaleExpanded);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rescaleExpanded]);

  // 折叠/展开切换:展开组立即重填(DOM 已按折叠态布局,页签条高可实测)
  useEffect(() => {
    rescaleExpanded();
  }, [collapsed, rescaleExpanded]);

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
    <MidPanel key="mid" tabId={tabId} collapsed={collapsed[1]} onToggle={() => toggleCollapse(1)} />,
    <NavigatorInfoPanel
      key="nav"
      tabId={tabId}
      collapsed={collapsed[2]}
      onToggle={() => toggleCollapse(2)}
    />,
    <LayersPanel key="layers" tabId={tabId} />,
  ];

  // 权重模式按展开组归一化:flex 分配是 grow×剩余空间(不除以 Σgrow),GROW 原设计四组之和=1,
  // 折叠一组后剩余权重不足 1 会底部留空,须把收起组的份额摊给展开组
  const growSum = GROW.reduce((a, g, i) => a + (collapsed[i] ? 0 : g), 0) || 1;

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-panel overflow-y-auto overflow-x-hidden">
      {groups.map((g, i) => (
        <React.Fragment key={i}>
          <div
            ref={(el) => { groupRefs.current[i] = el; }}
            className="overflow-hidden"
            style={
              collapsed[i]
                ? { flexShrink: 0 } // 折叠:只占页签条自然高,不参与权重/定格分配
                : heights
                  ? { height: heights[i], flexShrink: 0, minHeight: MIN_H[i] }
                  : { flexGrow: GROW[i] / growSum, flexBasis: 0, flexShrink: 1, minHeight: MIN_H[i] }
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
