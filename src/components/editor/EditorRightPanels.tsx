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
import { GradientPanel } from './panels/GradientPanel';
import { HistoryPanel } from './panels/HistoryPanel';
import { NavigatorInfoPanel } from './panels/NavigatorInfoPanel';
import { LayersPanel } from './panels/LayersPanel';
import { AdjustmentGrid } from './panels/AdjustmentGrid';
import { AdjustmentProps } from './panels/AdjustmentProps';
import { getSession, subscribeSession } from './editorStore';

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

export const EditorRightPanels: React.FC<{ tabId: string }> = ({ tabId }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const groupRefs = useRef<(HTMLDivElement | null)[]>([]);
  // 工具切换(渐变工具激活时第一组换渐变编辑器)与选项变化都要重渲染
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  /** 前三组(0 颜色/1 属性/2 导航器)的高度:null=未拖动按 GROW 百分比定宽,拖动后为像素。 */
  const [heights, setHeights] = useState<number[] | null>(null);
  const heightsRef = useRef<number[] | null>(null);
  heightsRef.current = heights;
  /** 组折叠(内容收起只留页签条);点已激活页签切换,再点任意页签展开。 */
  const [collapsed, setCollapsed] = useState<boolean[]>([false, false, false, false]);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;

  // 收起/展开不重分配前三组(高度原样保留);省出的空间由图层组(flex-grow 恒弹性)吸收——
  // 图层页脚因此永远钉在面板底部(用户口径),列表区变高变矮。
  // heights[i] 存的是「组 i 展开时应恢复的高」:收起瞬间记下当前展开高,拖拽冻结不覆盖折叠组
  const toggleCollapse = (i: number) => {
    if (i < 3) {
      setHeights((prev) => {
        const arr = prev ?? ([0, 1, 2].map((j) => (groupRefs.current[j]?.getBoundingClientRect().height ?? MIN_H[j])) as number[]).concat(0);
        const out = [...arr];
        out[i] = collapsedRef.current[i]
          ? (arr[i] || MIN_H[i]) // 展开:沿用记录的展开高
          : (groupRefs.current[i] ? Math.round(groupRefs.current[i].getBoundingClientRect().height) : MIN_H[i]); // 收起:记当前展开高
        return out;
      });
    }
    setCollapsed((prev) => prev.map((c, j) => (j === i ? !c : c)));
  };

  // 图层组有最小高:前三组之和把它顶穿容器(会裁页脚/出滚动条)时按比例压回前三组
  const fitOverflow = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    setHeights((prev) => {
      const bars = collapsedRef.current.reduce(
        (a, c, i) => a + (c && i < 3 ? (groupRefs.current[i]?.getBoundingClientRect().height ?? 0) : 0), 0,
      );
      const budget = el.clientHeight - (groupRefs.current.length - 1) * DIVIDER_H - bars - MIN_H[3];
      const expanded = [0, 1, 2].filter((i) => !collapsedRef.current[i]);
      const cur = expanded.map((i) => (prev ? prev[i] : (groupRefs.current[i]?.getBoundingClientRect().height ?? MIN_H[i])));
      const total = cur.reduce((a, b) => a + b, 0);
      if (total <= budget || total <= 0) return prev;
      const next = prev ? [...prev] : [0, 0, 0, 0];
      expanded.forEach((i, k) => { next[i] = Math.max(MIN_H[i], Math.round(cur[k] * (budget / total))); });
      return next;
    });
  }, []);

  // 拖动定格后容器高度变化(窗口缩放):前三组超高才压回,否则图层组弹性自然吸收
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(fitOverflow);
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitOverflow]);

  // 展开/收起后同理兜底(展开把前三组像素高加回来时可能顶穿)
  useEffect(() => {
    fitOverflow();
  }, [collapsed, fitOverflow]);

  // 分隔条拖动 = 调整它上方最近的展开组(前三组)的高度,底边跟随指针;下方各组整体推移,
  // 高度变化全部由图层组(flex-grow)吸收——页脚恒在底部。前三组全折叠时无可调组(不动作)。
  const onDividerDown = (i: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture(e.pointerId);
    const el = containerRef.current;
    if (!el) return;
    let a = -1;
    for (let j = Math.min(i, 2); j >= 0; j--) {
      if (!collapsedRef.current[j]) { a = j; break; }
    }
    const g = a >= 0 ? groupRefs.current[a] : null;
    if (!g) return;
    if (!heightsRef.current) {
      // 冻结:展开组记当前 DOM 高;折叠组沿用记录的展开高(heights 非空,见 toggleCollapse)
      setHeights([0, 1, 2]
        .map((j) => (collapsedRef.current[j] ? (heightsRef.current?.[j] ?? MIN_H[j]) : (groupRefs.current[j]?.getBoundingClientRect().height ?? MIN_H[j])))
        .concat(0));
    }
    const gTop = g.getBoundingClientRect().top;
    // 抓点通常不在组底边上:记录指针相对底边的偏移,拖动中补偿(否则按下瞬间组高跳变)
    const grabOffset = e.clientY - (gTop + g.getBoundingClientRect().height);
    let others = 0;
    for (let j = 0; j < 3; j++) {
      if (j === a) continue;
      const gg = groupRefs.current[j];
      if (gg) others += gg.getBoundingClientRect().height;
    }
    const maxA = Math.max(MIN_H[a], el.clientHeight - others - (groupRefs.current.length - 1) * DIVIDER_H - MIN_H[3]);
    const move = (ev: PointerEvent) => {
      const next = Math.round(Math.min(maxA, Math.max(MIN_H[a], ev.clientY - gTop - grabOffset)));
      setHeights((prev) => {
        const arr = prev ?? [MIN_H[0], MIN_H[1], MIN_H[2], 0];
        if (arr[a] === next) return prev;
        const out = [...arr];
        out[a] = next;
        return out;
      });
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 渐变工具激活:第一组内容由颜色面板换为渐变编辑器(用户口径;"颜色"对活引用仍可达=切回其他工具)
  const gradientTool = getSession(tabId)?.tool === 'gradient';
  const groups: React.ReactNode[] = [
    gradientTool ? <GradientPanel key="gradient" tabId={tabId} /> : <ColorPanel key="color" tabId={tabId} />,
    <MidPanel key="mid" tabId={tabId} collapsed={collapsed[1]} onToggle={() => toggleCollapse(1)} />,
    <NavigatorInfoPanel
      key="nav"
      tabId={tabId}
      collapsed={collapsed[2]}
      onToggle={() => toggleCollapse(2)}
    />,
    <LayersPanel key="layers" tabId={tabId} />,
  ];

  // 权重(容器高的百分比)只作为前三组的初始布局;图层组恒 flex-grow 吸满剩余高
  return (
    <div ref={containerRef} className="h-full flex flex-col bg-panel overflow-y-auto overflow-x-hidden">
      {groups.map((g, i) => (
        <React.Fragment key={i}>
          <div
            ref={(el) => { groupRefs.current[i] = el; }}
            className="overflow-hidden"
            style={
              collapsed[i]
                ? { flexShrink: 0 } // 折叠:只占页签条自然高,不参与高度分配
                : i === 3
                  ? { flexGrow: 1, flexBasis: 0, minHeight: MIN_H[3] } // 图层组恒吸满剩余高(页脚恒在底部)
                  : heights
                    ? { height: heights[i], flexShrink: 0, minHeight: MIN_H[i] }
                    : { flexBasis: `${GROW[i] * 100}%`, flexShrink: 0, minHeight: MIN_H[i] }
            }
            title={i === 0 && gradientTool ? '渐变' : GROUP_TITLES[i]}
          >
            <div className="h-full flex flex-col overflow-hidden">{g}</div>
          </div>
          {/* 分隔条只在组间(末组下方无);拖它=移动边界,跨折叠组在最近展开组间转移高度 */}
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
