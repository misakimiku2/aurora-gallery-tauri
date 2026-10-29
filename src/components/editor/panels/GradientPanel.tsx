/**
 * 渐变面板(渐变工具激活时替换右侧"颜色"面板):取色器 + 当前渐变停靠点编辑条。
 * 用户拍板口径:不放预设网格(预设走选项条色板弹层);上方取色窗与"颜色"面板同款
 * (ColorPicker 共用组件),编辑当前选中的颜色停靠点。
 * 编辑条上游口径(ui-egui gradient_ui::stop_strip):双行=透明度(棋盘格底)/颜色;
 * 点带内空白=该处插值色/插值 alpha 加点、拖动箭头标记=移位(跨位重排选中跟随)、
 * 拖出条外 24px=删除(颜色行最少保 2 个)。
 * 编辑直接改 ToolOptions.gradientCurrent(会话内副本),提交时 paint.gradient 发
 * stops+transparency(活引用交引擎按当前前景/背景解析);改色即固化为固定色(上游同语义)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getSession, setOptions, subscribeSession } from '../editorStore';
import { ColorPicker, type RGB } from './ColorPicker';
import {
  hexOf01, moveStopAt, presetCss, resolvePreset, sampleResolved, stopGapMid,
  type GradientPreset, type PresetStopColor,
} from '../gradientPresets';

const CHECKER = 'repeating-conic-gradient(rgba(128,128,128,0.45) 0% 25%, transparent 0% 50%)';

type Sel = { row: 'color' | 'opacity'; index: number };

const nameOf = (c: PresetStopColor): string =>
  c === 'foreground' ? '前景色' : c === 'background' ? '背景色' : hexOf01(c);

/** 指向条带的三角标记(▲=下方颜色停靠点 / ▼=上方透明度停靠点;外圈=描边、内芯=填色)。 */
const triStyle = (size: number, color: string, up: boolean): React.CSSProperties => ({
  width: 0,
  height: 0,
  borderLeft: `${size}px solid transparent`,
  borderRight: `${size}px solid transparent`,
  ...(up
    ? { borderBottom: `${Math.round(size * 0.85)}px solid ${color}` }
    : { borderTop: `${Math.round(size * 0.85)}px solid ${color}` }),
});

export const GradientPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  // 默认选中第一个颜色停靠点(取色器开箱即用)
  const [sel, setSel] = useState<Sel>({ row: 'color', index: 0 });
  const selRef = useRef<Sel>(sel);
  selRef.current = sel;
  /** 拖动中的停靠点(带条带屏幕矩形;move/up 走窗口监听,dragRef 为空=无拖动)。 */
  const dragRef = useRef<{ row: 'color' | 'opacity'; index: number; rect: DOMRect } | null>(null);
  const colorBandRef = useRef<HTMLDivElement | null>(null);
  const opacityBandRef = useRef<HTMLDivElement | null>(null);

  const update = useCallback(
    (fn: (p: GradientPreset) => GradientPreset) => {
      const s = getSession(tabId);
      if (s) setOptions(tabId, { gradientCurrent: fn(s.options.gradientCurrent) });
    },
    [tabId],
  );

  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      const s = getSession(tabId);
      if (!s) return;
      const t = (e.clientX - d.rect.left) / Math.max(1, d.rect.width);
      const p = s.options.gradientCurrent;
      if (d.row === 'color') {
        const stops = p.stops.map((q) => [...q] as [number, PresetStopColor]);
        const idx = moveStopAt(stops, d.index, t);
        if (idx == null) return;
        d.index = idx;
        setSel({ row: 'color', index: idx });
        setOptions(tabId, { gradientCurrent: { ...p, stops } });
      } else {
        const op = p.opacity.map((q) => [...q] as [number, number]);
        const idx = moveStopAt(op, d.index, t);
        if (idx == null) return;
        d.index = idx;
        setSel({ row: 'opacity', index: idx });
        setOptions(tabId, { gradientCurrent: { ...p, opacity: op } });
      }
    };
    const up = (e: PointerEvent) => {
      const d = dragRef.current;
      dragRef.current = null;
      if (!d) return;
      // 拖出删除:指针落点超出条带上下 24px
      if (e.clientY < d.rect.top - 24 || e.clientY > d.rect.bottom + 24) {
        const s = getSession(tabId);
        const p = s?.options.gradientCurrent;
        if (!p) return;
        if (d.row === 'color' && p.stops.length > 2) {
          setOptions(tabId, { gradientCurrent: { ...p, stops: p.stops.filter((_, i) => i !== d.index) } });
          setSel({ row: 'color', index: 0 });
        } else if (d.row === 'opacity') {
          setOptions(tabId, { gradientCurrent: { ...p, opacity: p.opacity.filter((_, i) => i !== d.index) } });
          setSel({ row: 'color', index: 0 });
        }
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
  }, [tabId]);

  /** 在条带的 t 处加停靠点(颜色行取插值色、透明度行取插值 alpha),选中新点。 */
  const addStop = useCallback(
    (row: 'color' | 'opacity', t: number) => {
      const s = getSession(tabId);
      if (!s) return;
      const p = s.options.gradientCurrent;
      if (row === 'color') {
        if (p.stops.length >= 64) return;
        const c = sampleResolved(p, s.state?.foreground, s.state?.background, t).slice(0, 3) as RGB;
        const stops = [...p.stops.map((q) => [...q] as [number, PresetStopColor]), [t, c] as [number, PresetStopColor]];
        const idx = moveStopAt(stops, stops.length - 1, t) ?? 0;
        setOptions(tabId, { gradientCurrent: { ...p, stops } });
        setSel({ row: 'color', index: idx });
      } else {
        if (p.opacity.length >= 64) return;
        const a = Math.round(sampleResolved(p, s.state?.foreground, s.state?.background, t)[3] * 100) / 100;
        const op = [...p.opacity.map((q) => [...q] as [number, number]), [t, a] as [number, number]];
        const idx = moveStopAt(op, op.length - 1, t) ?? 0;
        setOptions(tabId, { gradientCurrent: { ...p, opacity: op } });
        setSel({ row: 'opacity', index: idx });
      }
    },
    [tabId],
  );

  const onBandDown = (row: 'color' | 'opacity') => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const band = e.currentTarget as HTMLDivElement;
    const r = band.getBoundingClientRect();
    addStop(row, Math.round(((e.clientX - r.left) / Math.max(1, r.width)) * 1000) / 1000);
  };

  const onMarkerDown = (row: 'color' | 'opacity', index: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const band = row === 'color' ? colorBandRef.current : opacityBandRef.current;
    if (!band) return;
    dragRef.current = { row, index, rect: band.getBoundingClientRect() };
    setSel({ row, index });
  };

  const setLocation = (row: 'color' | 'opacity', index: number, loc: number) => {
    const s = getSession(tabId);
    if (!s || !Number.isFinite(loc)) return;
    const p = s.options.gradientCurrent;
    if (row === 'color') {
      const stops = p.stops.map((q) => [...q] as [number, PresetStopColor]);
      const idx = moveStopAt(stops, index, loc);
      if (idx == null) return;
      setSel({ row, index: idx });
      setOptions(tabId, { gradientCurrent: { ...p, stops } });
    } else {
      const op = p.opacity.map((q) => [...q] as [number, number]);
      const idx = moveStopAt(op, index, loc);
      if (idx == null) return;
      setSel({ row, index: idx });
      setOptions(tabId, { gradientCurrent: { ...p, opacity: op } });
    }
  };

  const setColor = (index: number, rgb: RGB) => {
    update((p) => ({ ...p, stops: p.stops.map((q, i) => (i === index ? [q[0], [...rgb] as RGB] : q)) }));
  };
  const setOpacity = (index: number, a: number) => {
    if (!Number.isFinite(a)) return;
    update((p) => ({
      ...p,
      opacity: p.opacity.map((q, i) => (i === index ? [q[0], Math.round(Math.min(1, Math.max(0, a)) * 100) / 100] as [number, number] : q)),
    }));
  };

  const removeSel = () => {
    const cur = selRef.current;
    const s = getSession(tabId);
    const p = s?.options.gradientCurrent;
    if (!p) return;
    if (cur.row === 'color') {
      if (p.stops.length <= 2) return;
      setOptions(tabId, { gradientCurrent: { ...p, stops: p.stops.filter((_, i) => i !== cur.index) } });
    } else {
      setOptions(tabId, { gradientCurrent: { ...p, opacity: p.opacity.filter((_, i) => i !== cur.index) } });
    }
    setSel({ row: 'color', index: 0 });
  };

  const s = getSession(tabId);
  if (!s) return null;
  const cur = s.options.gradientCurrent;
  const fg = s.state?.foreground;
  const bg = s.state?.background;
  const colorCss = presetCss(cur, fg, bg);
  const alphaCss = `linear-gradient(to right, ${resolvePreset(cur, fg, bg)
    .map(([t, c]) => `rgba(0,0,0,${c[3].toFixed(4)}) ${(t * 100).toFixed(3)}%`)
    .join(', ')})`;
  const resolvedRgb = (c: PresetStopColor): RGB =>
    c === 'foreground'
      ? [fg?.[0] ?? 0, fg?.[1] ?? 0, fg?.[2] ?? 0]
      : c === 'background'
        ? [bg?.[0] ?? 0, bg?.[1] ?? 0, bg?.[2] ?? 0]
        : [...c] as RGB;
  const resolvedHex = (c: PresetStopColor): string => hexOf01(resolvedRgb(c));
  const dark = document.documentElement.classList.contains('dark');
  const markerBorder = dark ? 'rgba(215,215,215,0.85)' : 'rgba(55,55,55,0.75)';
  const selColor = sel.row === 'color' ? cur.stops[sel.index] : null;
  const selOpacity = sel.row === 'opacity' ? cur.opacity[sel.index] : null;
  const locVal = (t: number) => Math.round(t * 1000) / 10;

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden p-2 text-[11px] flex flex-col gap-2">
      {/* 取色窗(与"颜色"面板同款):编辑当前选中的颜色停靠点;改色即固化活引用 */}
      {selColor ? (
        <ColorPicker
          value={resolvedRgb(selColor[1])}
          onCommit={(rgb) => setColor(sel.index, rgb)}
          label={`${nameOf(selColor[1])} @ ${Math.round(selColor[0] * 100)}%`}
        />
      ) : (
        <div className="pointer-events-none opacity-40 text-neutral-500 dark:text-neutral-400">
          {selOpacity ? '已选中透明度停靠点(用下方"不透明"字段编辑)' : ''}
        </div>
      )}
      {/* 停靠点编辑条(上行透明度+▼标记 / 下行颜色+▲标记) */}
      <div className="w-full select-none touch-none">
        <div className="relative h-[13px]">
          {cur.opacity.map(([t, a], i) => {
            const on = sel.row === 'opacity' && sel.index === i;
            return (
              <button
                key={i}
                title={`不透明度 ${Math.round(a * 100)}% @ ${Math.round(t * 100)}%`}
                className="absolute -translate-x-1/2 bottom-0 w-[15px] h-[13px]"
                style={{ left: `${t * 100}%` }}
                onPointerDown={onMarkerDown('opacity', i)}
              >
                <span className="absolute left-1/2 -translate-x-1/2 bottom-[1px] block" style={triStyle(6, on ? 'rgb(2,132,199)' : markerBorder, false)} />
                <span className="absolute left-1/2 -translate-x-1/2 bottom-[3px] block" style={{ ...triStyle(4.5, '#f8f9fa', false), filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))' }} />
              </button>
            );
          })}
        </div>
        <div
          ref={opacityBandRef}
          title="透明度:点空白加停靠点 / 拖动标记移位 / 拖出删除"
          className="h-[13px] w-full rounded-sm border border-black/15 dark:border-white/20"
          style={{ backgroundImage: `${alphaCss}, ${CHECKER}`, backgroundSize: '100% 100%, 8px 8px' }}
          onPointerDown={onBandDown('opacity')}
        />
        <div
          ref={colorBandRef}
          title="颜色:点空白加停靠点 / 拖动标记移位 / 拖出删除;取色窗在上方"
          className="h-[13px] w-full rounded-sm border border-black/15 dark:border-white/20"
          style={{ background: colorCss }}
          onPointerDown={onBandDown('color')}
        />
        <div className="relative h-[13px]">
          {cur.stops.map(([t, c], i) => {
            const on = sel.row === 'color' && sel.index === i;
            return (
              <button
                key={i}
                title={`${nameOf(c)} @ ${Math.round(t * 100)}%`}
                className="absolute -translate-x-1/2 top-0 w-[15px] h-[13px]"
                style={{ left: `${t * 100}%` }}
                onPointerDown={onMarkerDown('color', i)}
              >
                <span className="absolute left-1/2 -translate-x-1/2 top-[1px] block" style={triStyle(6, on ? 'rgb(2,132,199)' : markerBorder, true)} />
                <span className="absolute left-1/2 -translate-x-1/2 top-[3px] block" style={{ ...triStyle(4.5, resolvedHex(c), true), filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))' }} />
              </button>
            );
          })}
        </div>
      </div>
      {/* 选中停靠点字段(颜色经上方取色窗;此处保留位置与删除) */}
      {selColor ? (
        <label className="flex items-center gap-1.5">
          <span className="w-3 h-3 shrink-0 rounded-sm border border-black/20 dark:border-neutral-600" style={{ background: resolvedHex(selColor[1]) }} />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400 tabular-nums">{resolvedHex(selColor[1])}</span>
          <div className="flex-1" />
          <input
            type="number" min={0} max={100} step={0.1} title="位置 %"
            value={locVal(selColor[0])}
            onChange={(e) => setLocation('color', sel.index, Number(e.target.value) / 100)}
            className="w-14 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] tabular-nums text-neutral-700 dark:text-neutral-300"
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
          <button
            disabled={cur.stops.length <= 2}
            onClick={removeSel}
            className="px-1.5 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 disabled:opacity-40"
            title="删除停靠点"
          >
            ✕
          </button>
        </label>
      ) : selOpacity ? (
        <label className="flex items-center gap-1.5">
          <span className="w-10 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400">不透明</span>
          <input
            type="number" min={0} max={100} step={1} title="不透明度 %"
            value={Math.round(selOpacity[1] * 100)}
            onChange={(e) => setOpacity(sel.index, Number(e.target.value) / 100)}
            className="w-14 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] tabular-nums text-neutral-700 dark:text-neutral-300"
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
          <div className="flex-1" />
          <input
            type="number" min={0} max={100} step={0.1} title="位置 %"
            value={locVal(selOpacity[0])}
            onChange={(e) => setLocation('opacity', sel.index, Number(e.target.value) / 100)}
            className="w-14 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] tabular-nums text-neutral-700 dark:text-neutral-300"
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
          <button
            onClick={removeSel}
            className="px-1.5 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
            title="删除停靠点"
          >
            ✕
          </button>
        </label>
      ) : null}
      <div>
        <button
          disabled={cur.stops.length >= 64}
          onClick={() => addStop('color', stopGapMid(cur.stops))}
          className="px-2 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 disabled:opacity-40"
        >
          添加停靠点
        </button>
      </div>
    </div>
  );
};
