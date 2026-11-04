/**
 * 渐变填充图层属性页的停靠点条(上游 gradient_ui/properties_panel.rs + stop_strip 移植):
 * 组合条=透明度标记(▼,上方)/颜色标记(▲,下方)/段中点菱形;点条带上半=加透明度停靠点、
 * 下半=加颜色停靠点;拖标记移位(跨位重排由引擎排序,下标经 gradientStopIndexAfter 跟踪)、
 * 拖出条带 28/26px=撕离删除(保底 2 个);双击颜色标记/字段行色块=取色卡(确定一条
 * gradient.fill.stop color 命令);选中标记的字段行=颜色/不透明度/中点/位置/删除。
 * 拖动中 80ms 节流+在途背压提交(coalesce 合一步历史,与画布 Live 手势同款),本地快照
 * 渲染防引擎回包顶手指;条带渲染与引擎 Ramp 同公式( midpointRemap 分段线性)。
 * 条带地址一律渐变空间(反向只作用于画布输出,上游 track_fill reverse=false 口径)。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { markInteractiveRender, runCommand } from '../editorStore';
import { error as logError } from '../../../utils/logger';
import { ColorPicker, type RGB } from './ColorPicker';
import { gradientStopIndexAfter, layerRampCss, stopIndexAfterEdit } from '../toolLogic';
import type { GradientFillInfo } from '../gradientFill';

const CHECKER = 'repeating-conic-gradient(rgba(128,128,128,0.45) 0% 25%, transparent 0% 50%)';
/** 撕离删除的越界距离(上游 stop_strip off 阈值:下方 28px/上方 26px)。 */
const TEAR_BELOW = 28;
const TEAR_ABOVE = 26;
/** 双击判定窗口(上游 DOUBLE_CLICK)。 */
const DOUBLE_CLICK = 450;

type Sel = { kind: 'color' | 'opacity' | 'mid'; index: number };

/** 指向条带的三角标记(▲=下方颜色停靠点 / ▼=上方透明度停靠点;外圈描边、内芯填色)。 */
const triStyle = (size: number, color: string, up: boolean): React.CSSProperties => ({
  width: 0,
  height: 0,
  borderLeft: `${size}px solid transparent`,
  borderRight: `${size}px solid transparent`,
  ...(up
    ? { borderBottom: `${Math.round(size * 0.85)}px solid ${color}` }
    : { borderTop: `${Math.round(size * 0.85)}px solid ${color}` }),
});

type Drag =
  | { kind: 'color'; origIndex: number; curIdx: number; t: number; tornOff: boolean; moved: boolean; down: [number, number]; bar: DOMRect; stops: Array<[number, string]>; mids: number[] }
  | { kind: 'opacity'; origIndex: number; curIdx: number; t: number; tornOff: boolean; moved: boolean; down: [number, number]; bar: DOMRect; ops: Array<[number, number]>; stops: Array<[number, string]>; mids: number[] }
  | { kind: 'mid'; seg: number; a: number; b: number; value: number; moved: boolean; down: [number, number]; bar: DOMRect; stops: Array<[number, string]>; mids: number[] };

/** 条带拖动进行中(AdjustmentProps 的读回 effect 用:拖动中跳过 gradient.fill.get,
 * 标记渲染走本地快照,防引擎回包顶手指+省每 tick 一条 IPC)。 */
let stripDragDepth = 0;
export function isGradientLayerStripDragging(): boolean {
  return stripDragDepth > 0;
}

export const GradientLayerStops: React.FC<{ tabId: string; layerId: number; fill: GradientFillInfo }> = ({ tabId, layerId, fill }) => {
  const [, forceUpdate] = useState(0);
  const [sel, setSel] = useState<Sel>({ kind: 'color', index: 0 });
  const selRef = useRef<Sel>(sel);
  selRef.current = sel;
  const dragRef = useRef<Drag | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);
  /** 条带空白按下(抬笔未动=加对应类别的停靠点)。 */
  const barClickRef = useRef<{ t: number; half: 'opacity' | 'color'; moved: boolean; down: [number, number] } | null>(null);
  /** 上一次点击的标记(双击取色判定,手动计时,上游 click 同款)。 */
  const lastClickRef = useRef<{ key: string; time: number } | null>(null);
  /** 预览提交的手势序号/节流/在途背压(与画布 gradPreviewSend 同款)。 */
  const gestureRef = useRef({ seq: 0, lastSent: 0 });
  const inflightRef = useRef<{ busy: boolean; pending: null | (() => void) }>({ busy: false, pending: null });
  /** 双击颜色标记的字段取色卡(上游 Color Picker (Stop Color) 对话框口径:确定一条命令)。 */
  const [picker, setPicker] = useState<{ index: number; rgb: RGB; x: number; y: number } | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // 透明度停靠点(引擎空=全不透明,条带显示隐式 [0,100],[1,100])
  const ops: Array<[number, number]> = fill.transparency.length ? fill.transparency.map((q) => [...q] as [number, number]) : [[0, 100], [1, 100]];
  const stops = fill.stops;

  // 预览提交(80ms 节流 + 一次一条在途,尾沿合并)
  const previewSend = (cmd: string, params: Record<string, unknown>) => {
    const fire = () => {
      markInteractiveRender(tabId, 1200);
      gestureRef.current.lastSent = performance.now();
      inflightRef.current.busy = true;
      void runCommand(tabId, cmd, { layer: layerId, ...params, coalesce: `gradient-props-drag:${gestureRef.current.seq}` }, { noPull: true })
        .catch((err) => logError(`[editor] ${cmd} 失败`, err))
        .finally(() => {
          inflightRef.current.busy = false;
          const p = inflightRef.current.pending;
          inflightRef.current.pending = null;
          p?.();
        });
    };
    if (inflightRef.current.busy) inflightRef.current.pending = fire;
    else fire();
  };

  const commit = (params: Record<string, unknown>) => {
    void runCommand(tabId, 'gradient.fill.stop', { layer: layerId, ...params })
      .catch((err) => logError('[editor] gradient.fill.stop 失败', err));
  };

  // 拖动/条带按下期间:读回跳过由 isGradientLayerStripDragging 控制
  const beginDrag = () => {
    stripDragDepth += 1;
    gestureRef.current.seq += 1;
    gestureRef.current.lastSent = 0;
    // 交互期降载:条带拖动的预览与画布 Live 渐变同口径(视口预算出图,up 时回全分辨率)
    markInteractiveRender(tabId, 1200);
  };
  const endDrag = () => {
    stripDragDepth = Math.max(0, stripDragDepth - 1);
  };

  // 选中态随 fill 变化钳界(换层/停靠点减少)
  useEffect(() => {
    setSel((cur) => {
      if (cur.kind === 'color' && cur.index < stops.length) return cur;
      if (cur.kind === 'opacity' && cur.index < ops.length) return cur;
      if (cur.kind === 'mid' && cur.index < stops.length - 1) return cur;
      return { kind: 'color', index: 0 };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fill, stops.length, ops.length]);

  // 拖动:window move/up(GradientPanel 同款窗口监听;渲染用拖动快照,防引擎回包顶手指)
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const d = dragRef.current;
      const bc = barClickRef.current;
      if (bc) {
        if (Math.abs(e.clientX - bc.down[0]) + Math.abs(e.clientY - bc.down[1]) >= 2) bc.moved = true;
        return;
      }
      if (!d) return;
      const t = Math.min(1, Math.max(0, (e.clientX - d.bar.left) / Math.max(1, d.bar.width)));
      if (Math.abs(e.clientX - d.down[0]) + Math.abs(e.clientY - d.down[1]) >= 2) d.moved = true;
      if (d.kind === 'color') {
        d.tornOff = e.clientY > d.bar.bottom + TEAR_BELOW || e.clientY < d.bar.top - TEAR_ABOVE;
        if (d.moved && !d.tornOff && performance.now() - gestureRef.current.lastSent >= 80) {
          d.t = t;
          previewSend('gradient.fill.stop', { action: 'move', index: d.curIdx, location: d.t });
          d.curIdx = gradientStopIndexAfter(d.stops.map((q) => q[0]), d.origIndex, d.t);
        }
      } else if (d.kind === 'opacity') {
        d.tornOff = e.clientY > d.bar.bottom + TEAR_BELOW || e.clientY < d.bar.top - TEAR_ABOVE;
        if (d.moved && !d.tornOff && performance.now() - gestureRef.current.lastSent >= 80) {
          d.t = t;
          // 透明度停靠点跨位同样重排:引擎按当前排序下标寻址,发送后重算
          previewSend('gradient.fill.stop', { action: 'move', kind: 'opacity', index: d.curIdx, location: d.t });
          d.curIdx = gradientStopIndexAfter(d.ops.map((q) => q[0]), d.origIndex, d.t);
        }
      } else {
        const v = Math.min(0.95, Math.max(0.05, (t - d.a) / Math.max(1e-4, d.b - d.a)));
        d.value = v;
        if (d.moved && performance.now() - gestureRef.current.lastSent >= 80) {
          previewSend('gradient.fill.stop', { action: 'midpoint', index: d.seg, location: v });
        }
      }
      // DOM 标记逐帧跟手(ref 变化不触发渲染,move 里手动刷)
      forceUpdate((n) => n + 1);
    };
    const up = () => {
      markInteractiveRender(tabId, 0);
      const bc = barClickRef.current;
      barClickRef.current = null;
      if (bc && !bc.moved) {
        // 条带空白单击=加停靠点(上半=透明度/下半=颜色,上游 clicked 分支);选中新点
        if (bc.half === 'color') {
          setSel({ kind: 'color', index: stops.filter(([p]) => p <= bc.t).length });
          commit({ action: 'add', location: bc.t });
        } else {
          setSel({ kind: 'opacity', index: ops.filter(([p]) => p <= bc.t).length });
          commit({ action: 'add', kind: 'opacity', location: bc.t });
        }
        return;
      }
      const d = dragRef.current;
      dragRef.current = null;
      endDrag();
      if (!d) return;
      if (d.kind === 'color') {
        if (d.moved && d.tornOff) {
          commit({ action: 'delete', index: d.curIdx });
          setSel({ kind: 'color', index: 0 });
        } else if (d.moved) {
          commit({ action: 'move', index: d.curIdx, location: d.t });
          setSel({ kind: 'color', index: gradientStopIndexAfter(d.stops.map((q) => q[0]), d.origIndex, d.t) });
        }
      } else if (d.kind === 'opacity') {
        if (d.moved && d.tornOff) {
          commit({ action: 'delete', kind: 'opacity', index: d.curIdx });
          setSel({ kind: 'color', index: 0 });
        } else if (d.moved) {
          commit({ action: 'move', kind: 'opacity', index: d.curIdx, location: d.t });
          setSel({ kind: 'opacity', index: gradientStopIndexAfter(d.ops.map((q) => q[0]), d.origIndex, d.t) });
        }
      } else if (d.moved) {
        commit({ action: 'midpoint', index: d.seg, location: d.value });
        setSel({ kind: 'mid', index: d.seg });
      }
    };
    const cancel = () => {
      markInteractiveRender(tabId, 0);
      barClickRef.current = null;
      if (dragRef.current) {
        dragRef.current = null;
        endDrag();
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    return () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId, layerId, stops, ops]);

  // 取色卡:外点/Esc=取消
  useEffect(() => {
    if (!picker) return;
    const close = (ev: MouseEvent) => {
      if (pickerRef.current?.contains(ev.target as Node)) return;
      setPicker(null);
    };
    const esc = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setPicker(null);
    };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', esc);
    };
  }, [picker]);
  useLayoutEffect(() => {
    if (!picker) return;
    const el = pickerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(picker.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(picker.y, window.innerHeight - r.height - 4))}px`;
  }, [picker]);

  const openPicker = (index: number, cx: number, cy: number) => {
    const st = stops[index];
    if (!st) return;
    const h = st[1].replace('#', '');
    const q = (i: number) => Number.parseInt(h.slice(i * 2, i * 2 + 2) || '00', 16) / 255;
    setPicker({ index, rgb: [q(0), q(1), q(2)], x: cx, y: cy });
  };
  const commitPicker = () => {
    const p = picker;
    if (!p) return;
    const hex = `#${p.rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
    commit({ action: 'color', index: p.index, color: hex });
    setPicker(null);
  };

  // 标记按下:记快照开拖(渲染全走快照;引擎回包/读回在拖动中被跳过)
  const markerDown = (kind: 'color' | 'opacity' | 'mid', index: number) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !barRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const bar = barRef.current.getBoundingClientRect();
    beginDrag();
    if (kind === 'color') {
      dragRef.current = { kind: 'color', origIndex: index, curIdx: index, t: stops[index][0], tornOff: false, moved: false, down: [e.clientX, e.clientY], bar, stops: stops.map((q) => [...q] as [number, string]), mids: [...fill.midpoints] };
    } else if (kind === 'opacity') {
      dragRef.current = { kind: 'opacity', origIndex: index, curIdx: index, t: ops[index][0], tornOff: false, moved: false, down: [e.clientX, e.clientY], bar, ops: ops.map((q) => [...q] as [number, number]), stops: stops.map((q) => [...q] as [number, string]), mids: [...fill.midpoints] };
    } else {
      dragRef.current = { kind: 'mid', seg: index, a: stops[index][0], b: stops[index + 1]?.[0] ?? 1, value: fill.midpoints[index] ?? 0.5, moved: false, down: [e.clientX, e.clientY], bar, stops: stops.map((q) => [...q] as [number, string]), mids: [...fill.midpoints] };
    }
    setSel({ kind, index });
  };

  // 条带空白按下:记待判定单击(上半=透明度/下半=颜色;拖动不算)
  const onBarDown = (e: React.PointerEvent) => {
    if (e.button !== 0 || !barRef.current) return;
    const bar = barRef.current.getBoundingClientRect();
    const t = Math.min(1, Math.max(0, (e.clientX - bar.left) / Math.max(1, bar.width)));
    barClickRef.current = { t, half: e.clientY < bar.top + bar.height / 2 ? 'opacity' : 'color', moved: false, down: [e.clientX, e.clientY] };
  };

  const onMarkerDoubleClick = (index: number) => (e: React.MouseEvent) => {
    openPicker(index, e.clientX, e.clientY);
  };

  // 拖动中渲染用快照(被拖标记跟随指针;其余不动);静止=引擎读回
  const d = dragRef.current;
  const shownStops: Array<{ loc: number; hex: string; drag: boolean }> =
    d?.kind === 'color'
      ? d.stops.map((q, i) => ({ loc: i === d.origIndex ? d.t : q[0], hex: q[1], drag: i === d.origIndex })).sort((x, y) => x.loc - y.loc)
      : stops.map((q, i) => ({ loc: q[0], hex: q[1], drag: false }));
  const shownOps: Array<{ loc: number; a: number; drag: boolean }> =
    d?.kind === 'opacity'
      ? d.ops.map((q, i) => ({ loc: i === d.origIndex ? d.t : q[0], a: q[1], drag: i === d.origIndex })).sort((x, y) => x.loc - y.loc)
      : ops.map((q) => ({ loc: q[0], a: q[1], drag: false }));
  const shownMids: number[] = d ? d.mids : fill.midpoints;
  const rampFill = d
    ? { stops: shownStops.map((q) => [q.loc, q.hex] as [number, string]), midpoints: d.kind === 'mid' ? d.mids.map((m, i) => (i === d.seg ? d.value : m)) : shownMids, transparency: shownOps.map((q) => [q.loc, q.a] as [number, number]) }
    : { stops, midpoints: shownMids, transparency: ops };
  const rampCss = layerRampCss(rampFill);

  // 选中项数据(渲染自引擎读回;拖动中字段不跟手=上游同款)
  const selColor = sel.kind === 'color' ? stops[sel.index] : null;
  const selOpacity = sel.kind === 'opacity' ? ops[sel.index] : null;
  const locVal = (t: number) => Math.round(t * 1000) / 10;
  const setLoc = (kind: 'color' | 'opacity', index: number, loc: number) => {
    if (!Number.isFinite(loc)) return;
    const locs = (kind === 'color' ? stops : ops).map((q) => q[0]);
    const next = stopIndexAfterEdit(locs, { action: 'move', index, location: loc });
    if (next != null) setSel({ kind, index: next });
    commit(kind === 'color' ? { action: 'move', index, location: loc } : { action: 'move', kind: 'opacity', index, location: loc });
  };
  const setOpacityVal = (index: number, v: number) => {
    if (!Number.isFinite(v)) return;
    commit({ action: 'opacity', kind: 'opacity', index, opacity: v });
  };
  const setMidVal = (index: number, v: number) => {
    if (!Number.isFinite(v)) return;
    commit({ action: 'midpoint', index, location: Math.min(0.95, Math.max(0.05, v)) });
  };
  const removeSel = () => {
    const cur = selRef.current;
    if (cur.kind === 'mid') return;
    const count = cur.kind === 'color' ? stops.length : ops.length;
    if (count <= 2) return;
    commit(cur.kind === 'color' ? { action: 'delete', index: cur.index } : { action: 'delete', kind: 'opacity', index: cur.index });
    setSel({ kind: 'color', index: 0 });
  };

  const dark = document.documentElement.classList.contains('dark');
  const markerBorder = dark ? 'rgba(215,215,215,0.85)' : 'rgba(55,55,55,0.75)';
  const accent = 'rgb(2,132,199)';
  const dim = dark ? 'rgba(160,160,160,0.9)' : 'rgba(90,90,90,0.9)';
  // 高亮判定:拖动中=被拖件,静止=选中项
  const isSel = (kind: Sel['kind'], index: number): boolean => {
    if (d) {
      if (d.kind !== kind) return false;
      if (d.kind === 'mid') return d.seg === index;
      return d.origIndex === index;
    }
    return sel.kind === kind && sel.index === index;
  };
  const inputCls = 'w-14 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] tabular-nums text-neutral-700 dark:text-neutral-300';

  return (
    <div className="flex flex-col gap-1 text-[11px] text-neutral-700 dark:text-neutral-300">
      {/* 组合条:透明度标记 ▼ / 条带(点上半加透明、下半加颜色)/ 中点菱形 + 颜色标记 ▲ */}
      <div className="w-full select-none touch-none">
        <div className="relative h-[14px]">
          {shownOps.map((q, i) => {
            const t = q.loc;
            const a = q.a;
            const on = isSel('opacity', i);
            return (
              <button
                key={`o${i}-${t}`}
                title={`不透明度 ${Math.round(a)}% @ ${Math.round(t * 100)}%`}
                className={`absolute bottom-0 w-[15px] h-[14px] ${shownOps[i].drag ? 'invisible' : ''}`}
                style={{ left: `${t * 100}%`, transform: 'translateX(-50%)' }}
                onPointerDown={markerDown('opacity', i)}
              >
                <span className="absolute left-1/2 -translate-x-1/2 bottom-[1px] block" style={triStyle(6, on ? accent : dim, false)} />
                <span
                  className="absolute left-1/2 -translate-x-1/2 bottom-[4px] block w-[10px] h-[9px] rounded-[1px]"
                  style={{ background: `rgb(${Math.round((a / 100) * 255)},${Math.round((a / 100) * 255)},${Math.round((a / 100) * 255)})`, border: `1px solid ${on ? accent : dim}` }}
                />
              </button>
            );
          })}
        </div>
        <div
          ref={barRef}
          title="停靠点:点条带上半加透明度、下半加颜色;拖标记移位,拖出条带删除"
          className="relative h-6 w-full rounded-sm border border-black/15 dark:border-white/20"
          style={{ backgroundImage: `${rampCss}, ${CHECKER}`, backgroundSize: '100% 100%, 8px 8px' }}
          onPointerDown={onBarDown}
        />
        <div className="relative h-[18px]">
          {/* 段中点菱形(段宽 >1e-4 才有;颜色标记按钮在上层命中优先,上游 hit 同序) */}
          {shownStops.slice(0, -1).map((s, i) => {
            const nextLoc = shownStops[i + 1].loc;
            if (nextLoc - s.loc <= 1e-4) return null;
            const m = shownMids[i] ?? 0.5;
            const t = s.loc + (nextLoc - s.loc) * m;
            const on = isSel('mid', i);
            return (
              <button
                key={`m${i}-${t}`}
                title={`中点 ${Math.round(m * 100)}%(段 ${Math.round(s.loc * 100)}%–${Math.round(nextLoc * 100)}%)`}
                className="absolute top-[2px] w-[12px] h-[12px] flex items-center justify-center"
                style={{ left: `${t * 100}%`, transform: 'translateX(-50%)' }}
                onPointerDown={markerDown('mid', i)}
              >
                <span
                  className="block w-[7px] h-[7px] rotate-45"
                  style={{ background: on ? accent : dark ? '#6b6b6b' : '#9a9a9a', border: `1px solid ${on ? accent : dim}` }}
                />
              </button>
            );
          })}
          {shownStops.map((q, i) => {
            const t = q.loc;
            const hex = q.hex;
            const on = isSel('color', i);
            const hexShort = hex.length >= 9 ? hex.slice(0, 7) : hex;
            return (
              <button
                key={`c${i}-${t}`}
                title={`${hex} @ ${Math.round(t * 100)}%(双击取色)`}
                className={`absolute top-0 z-10 w-[15px] h-[16px] ${shownStops[i].drag ? 'invisible' : ''}`}
                style={{ left: `${t * 100}%`, transform: 'translateX(-50%)' }}
                onPointerDown={markerDown('color', i)}
                onDoubleClick={onMarkerDoubleClick(i)}
              >
                <span className="absolute left-1/2 -translate-x-1/2 top-[1px] block" style={triStyle(6, on ? accent : dim, true)} />
                <span
                  className="absolute left-1/2 -translate-x-1/2 top-[5px] block w-[10px] h-[10px] rounded-[1px]"
                  style={{ background: hexShort, border: `1px solid ${on ? accent : dim}` }}
                />
              </button>
            );
          })}
        </div>
      </div>
      {/* 选中标记的字段行(上游 stop_fields:颜色色块/不透明度/中点 + 位置 + 删除) */}
      {selColor ? (
        <div className="flex items-center gap-1.5">
          <button
            title="点击取色(确定后一条命令落到停靠点)"
            className="w-5 h-4 shrink-0 rounded-[2px] border border-black/20 dark:border-neutral-600"
            style={{ background: selColor[1].length >= 9 ? selColor[1].slice(0, 7) : selColor[1] }}
            onClick={(e) => openPicker(sel.index, e.clientX, e.clientY)}
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400 tabular-nums">{selColor[1]}</span>
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">位置</span>
          <input
            type="number" min={0} max={100} step={0.1} value={locVal(selColor[0])}
            onChange={(e) => setLoc('color', sel.index, Number(e.target.value) / 100)}
            className={inputCls}
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
          <div className="flex-1" />
          <button
            disabled={stops.length <= 2}
            onClick={removeSel}
            className="px-1.5 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 disabled:opacity-40"
            title="删除停靠点(至少保留 2 个)"
          >
            ✕
          </button>
        </div>
      ) : selOpacity ? (
        <div className="flex items-center gap-1.5">
          <span className="w-10 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400">不透明</span>
          <input
            type="number" min={0} max={100} step={1} value={Math.round(selOpacity[1])}
            onChange={(e) => setOpacityVal(sel.index, Number(e.target.value))}
            className={inputCls}
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">位置</span>
          <input
            type="number" min={0} max={100} step={0.1} value={locVal(selOpacity[0])}
            onChange={(e) => setLoc('opacity', sel.index, Number(e.target.value) / 100)}
            className={inputCls}
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
          <div className="flex-1" />
          <button
            disabled={ops.length <= 2}
            onClick={removeSel}
            className="px-1.5 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 disabled:opacity-40"
            title="删除停靠点(至少保留 2 个)"
          >
            ✕
          </button>
        </div>
      ) : sel.kind === 'mid' && stops[sel.index] && stops[sel.index + 1] ? (
        <div className="flex items-center gap-1.5">
          <span className="w-10 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400">中点</span>
          <input
            type="number" min={5} max={95} step={1} value={Math.round((fill.midpoints[sel.index] ?? 0.5) * 100)}
            onChange={(e) => setMidVal(sel.index, Number(e.target.value) / 100)}
            className={inputCls}
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%(段内位置)</span>
          <div className="flex-1" />
        </div>
      ) : null}
      {/* 双击颜色标记的取色卡(与画布 Live 取色卡同款交互) */}
      {picker &&
        createPortal(
          <div
            ref={pickerRef}
            className="fixed z-[1000] w-56 rounded-md bg-[#FAFAFA]/95 dark:bg-[#3a3a3a]/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 p-2"
            style={{ left: picker.x, top: picker.y }}
          >
            <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">拾色器(色标颜色)</div>
            <div className="h-44 flex flex-col">
              <ColorPicker
                value={picker.rgb}
                onCommit={(rgb) => setPicker((p) => (p ? { ...p, rgb } : p))}
                label={`色标 #${picker.index + 1}`}
              />
            </div>
            <div className="flex justify-end gap-1.5 mt-2">
              <button
                onClick={() => setPicker(null)}
                className="px-2 py-0.5 rounded text-[11px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
              >
                取消
              </button>
              <button onClick={commitPicker} className="px-2 py-0.5 rounded text-[11px] bg-sky-600 text-white hover:bg-sky-500">
                确定
              </button>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
};

