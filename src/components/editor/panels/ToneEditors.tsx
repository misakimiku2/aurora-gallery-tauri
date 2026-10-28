/**
 * 色阶/曲线/渐变映射的完整编辑器(photocraft adjust_editors.rs 移植):
 * - Levels:通道+Auto / 256-bin 直方图 / 输入三手柄(按最近抓取,gamma 手柄=50% 灰映射点)/ 输出双手柄。
 * - Curves:点模式(点空白加点、命中拖动、拖出图外删点拖回恢复、Ctrl+点/右键/Delete 删、
 *   方向键微调)/ 自然三次样条画线(与引擎 curve_lut 同一条)/ 复合通道叠加显示单通道曲线 /
 *   铅笔模式(256 级 map 逐笔直线段、Shift 从上一笔终点连直线、Smooth 平滑按钮;
 *   模式切换经 layer.setAdjustment {pencil} 由引擎做 点↔map 转换,本地乐观同步)。
 * - GradientMap:停靠点条(点空白=该处插值色加点、拖动跨位重排且选中跟随)/
 *   选中点的颜色/位置/删除 / 最宽间隙中点加停靠点 / Reverse / Dither(映射无透明度,只有颜色停靠点)。
 * 编辑经 emit(100ms 节流+coalesce 合一步历史),拖动中本地态跟手。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pencil, Spline } from 'lucide-react';
import { editorHistogram } from '../editorBridge';
import {
  CURVE_DRAG_OFF, CURVE_HIT_RADIUS, CurvePoint, curveCanDelete, curveDelete, curveFromParams,
  curveHit, curveInsert, curveLut, curveMoveTo, isIdentityMap, mapToFitPoints, mapFromParams,
  mapToParams, pencilLine, pointsToMap, smoothCurveMap,
} from './curvePoints';
import {
  GradStop, moveMapStop, sampleStops, stopsFromParams, stopsToParams, widestGapMid,
} from './gradientStops';
import { autoLevels, channelColor, gammaFromPos, gammaPos, nearestHandle, readLevels, writeLevels } from './levelsMath';

/** 256-bin 直方图 4 组:复合 (R+G+B)/3 + R/G/B(桥 editor_histogram 的 channels)。 */
export type RgbHistograms = number[][];

const LEVEL_CHANS = [
  { key: '', label: 'RGB' },
  { key: 'red', label: '红' },
  { key: 'green', label: '绿' },
  { key: 'blue', label: '蓝' },
];
/** 曲线的复合通道参数键(单通道与色阶同键)。 */
const curveKey = (key: string) => (key === '' ? 'points' : key);

function isDarkTheme(): boolean {
  return document.documentElement.classList.contains('dark');
}

/** 主题(html.dark)感知;canvas 绘制颜色跟主题走。 */
function useDarkTheme(): boolean {
  const [dark, setDark] = useState(isDarkTheme);
  useEffect(() => {
    const ob = new MutationObserver(() => setDark(isDarkTheme()));
    ob.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => ob.disconnect();
  }, []);
  return dark;
}

/**
 * 直方图数据(keep-after-commit 口径,上游 tone.rs):revision 前进时,若距本层
 * 最后一次参数提交 <600ms(编辑器自己 commit,下方像素未变),保留旧数据只对齐
 * revision;否则异步重拉,拉取期间继续显示旧数据(Photoshop"高速缓存数据"语义)。
 */
export function useHistogram(
  tabId: string, docId: number | null, layerId: number, revision: number, enabled: boolean,
  lastEmitRef: React.MutableRefObject<number>,
): RgbHistograms | null {
  const [data, setData] = useState<RgbHistograms | null>(null);
  const cacheRev = useRef(-1);
  const dataRef = useRef<RgbHistograms | null>(null);
  const inflight = useRef(false);
  useEffect(() => {
    if (!enabled || docId == null || layerId <= 0) return;
    if (cacheRev.current === revision && !inflight.current) return;
    // 本层参数提交导致的 revision 前进:直方图描述的下方像素没变,不重拉
    // (仅当已有数据;空数据 keep 只会让直方图一直空白)
    if (dataRef.current && Date.now() - lastEmitRef.current < 600) {
      cacheRev.current = revision;
      return;
    }
    cacheRev.current = revision;
    // inflight:StrictMode 挂载双跑时第一次的结果被 cleanup 丢弃,第二次不得因
    // cacheRev 已占位而早退,否则直方图永远拉不到
    inflight.current = true;
    let cancelled = false;
    editorHistogram(docId, layerId, true)
      .then((r) => {
        if (!cancelled) {
          dataRef.current = (r.channels as RgbHistograms) ?? null;
          setData(dataRef.current);
        }
      })
      .catch((e) => console.error('[editor] editorHistogram', e))
      .finally(() => {
        inflight.current = false;
      });
    return () => {
      cancelled = true;
    };
  }, [tabId, docId, layerId, revision, enabled, lastEmitRef]);
  return data;
}

/** 256 竖条直方图(线性对齐最高 bin ×1.1,上游 tone.rs draw_histogram/histogram_scale_top)。 */
export const HistogramCanvas: React.FC<{
  hist: RgbHistograms | null;
  channel: number;
  color: string; // 通道色;复合由调用方按主题给灰
  className?: string;
}> = ({ hist, channel, color, className }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const dark = useDarkTheme();
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const bins = hist?.[Math.min(channel, hist.length - 1)];
    if (!bins || bins.length !== 256) return;
    const top = Math.max(1, Math.max(...bins)) * 1.1;
    ctx.fillStyle = color || (dark ? 'rgb(190,190,190)' : 'rgb(70,70,70)');
    for (let i = 0; i < 256; i++) {
      if (!bins[i]) continue;
      const x0 = Math.floor((i / 256) * w);
      const x1 = Math.floor(((i + 1) / 256) * w);
      const bh = Math.min(1, bins[i] / top) * h;
      ctx.fillRect(x0, h - bh, Math.max(1, x1 - x0), bh);
    }
  }, [hist, channel, color, dark]);
  // min-w-0:canvas 的 width 属性(=CSS 宽×dpr)是固有宽度,flex 项默认 min-width:auto
  // 会被它撑破容器出横向滚动条(dpr>1 必现),须显式允许收缩
  return <canvas ref={ref} className={`block min-w-0 ${className ?? ''}`} />;
};

/** 倒三角滑杆手柄(上游 handle:顶点朝上,宽 11px 高 9px,1px 描边)。
 * 描边+轻投影让白场手柄在浅色主题、黑场手柄在深色主题下都可辨。 */
const Handle: React.FC<{ pct: number; fill: string; title?: string }> = ({ pct, fill, title }) => {
  const dark = useDarkTheme();
  const stroke = dark ? 'rgba(225,225,225,0.75)' : 'rgba(45,45,45,0.65)';
  return (
    <div
      className="pointer-events-none absolute top-0 -translate-x-1/2"
      style={{ left: `${Math.min(100, Math.max(0, pct))}%`, filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.35))' }}
      title={title}
    >
      <svg width="12" height="10" viewBox="0 0 12 10">
        <polygon points="6,0.5 11.5,9.5 0.5,9.5" fill={fill} stroke={stroke} strokeWidth="1" />
      </svg>
    </div>
  );
};

// 不含宽度:调用方各自行宽语义不同(撑满 / 定宽);都带 w-full 会互相打架出横向滚动
const fieldCls =
  'bg-surface border border-black/10 dark:border-white/15 rounded px-1 py-0.5 text-[11px] text-gray-800 dark:text-neutral-200 tabular-nums';

const EditorFrame: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="flex flex-col gap-1.5 pt-0.5">{children}</div>
);

const ChanSelect: React.FC<{ value: number; onChange: (i: number) => void }> = ({ value, onChange }) => (
  <label className="flex items-center gap-1.5">
    <span className="text-[10px] text-gray-500 dark:text-neutral-400">通道</span>
    <select
      value={value}
      onChange={(e) => onChange(Number(e.target.value))}
      className="bg-surface border border-black/10 dark:border-white/15 rounded px-1 py-0.5 text-[11px] text-gray-800 dark:text-neutral-200"
    >
      {LEVEL_CHANS.map((c, i) => (
        <option key={c.key} value={i}>{c.label}</option>
      ))}
    </select>
  </label>
);

// -------------------------------------------------------------------------------------------
// Levels(色阶)

export const LevelsEditor: React.FC<{
  params: Record<string, unknown>;
  emit: (patch: Record<string, unknown>) => void;
  hist?: RgbHistograms | null;
  lastEmitRef?: React.MutableRefObject<number>;
  flushNow?: () => void;
}> = ({ params, emit, hist, lastEmitRef, flushNow }) => {
  const [ch, setCh] = useState(0);
  const key = LEVEL_CHANS[ch]?.key ?? '';
  const [l, setL] = useState<[number, number, number, number, number]>(() => readLevels(params, key));
  const dragging = useRef(false);
  useEffect(() => {
    // 拖动中跟手不回吸;自己提交的在途回包(emit 后 300ms 内到达的 params)也不回吸——
    // 快速松手再拖时,旧回包晚到会把手柄往回拉,以本地值为准,引擎值最终一致
    if (!dragging.current && (!lastEmitRef || Date.now() - lastEmitRef.current >= 300)) {
      setL(readLevels(params, key));
    }
  }, [params, key, lastEmitRef]);

  const apply = useCallback(
    (next: [number, number, number, number, number]) => {
      setL(next);
      emit(writeLevels(params, key, next));
    },
    [emit, params, key],
  );

  // Auto:当前通道直方图两端各裁 0.1%,gamma 重置 1,立即生效
  const onAuto = useCallback(() => {
    const bins = hist?.[ch];
    if (!bins) return;
    const [lo, hi] = autoLevels(bins);
    apply([lo, 1, hi, l[3], l[4]]);
  }, [hist, ch, apply, l]);

  // 输入滑杆:三手柄(黑/gamma/白),按下选最近者;黑≤白-2、白≥黑+2
  const trackRef = useRef<HTMLDivElement | null>(null);
  const grip = useRef<number | null>(null);
  const xval = (clientX: number) => {
    const el = trackRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(255, Math.max(0, ((clientX - r.left) / Math.max(1, r.width)) * 255));
  };
  const onTrackDown = (e: React.PointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件或指针已释放:跳过捕获,拖动仍走 pointermove */ }
    dragging.current = true;
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    grip.current = nearestHandle(
      [l[0], gammaPos(l[0], l[2], l[1]), l[2]].map((v) => (v / 255) * r.width),
      e.clientX - r.left,
    );
    move(e.clientX);
  };
  const move = (clientX: number) => {
    if (grip.current == null) return;
    const x = xval(clientX);
    const next = [...l] as [number, number, number, number, number];
    if (grip.current === 0) next[0] = Math.round(Math.min(x, l[2] - 2));
    else if (grip.current === 2) next[2] = Math.round(Math.max(x, l[0] + 2));
    else next[1] = Math.round(gammaFromPos(l[0], l[2], x) * 100) / 100;
    setL(next);
    emit(writeLevels(params, key, next));
  };
  const onTrackUp = () => {
    grip.current = null;
    outGrip.current = null;
    dragging.current = false;
    flushNow?.();
  };

  const chanColor = channelColor(key);
  const pct = (v: number) => (v / 255) * 100;

  // 输出滑杆双手柄
  const outGrip = useRef<number | null>(null);
  const onOutDown = (e: React.PointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件或指针已释放:跳过捕获,拖动仍走 pointermove */ }
    dragging.current = true;
    const el = trackRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    outGrip.current = nearestHandle([(l[3] / 255) * r.width, (l[4] / 255) * r.width], e.clientX - r.left);
    moveOut(e.clientX);
  };
  const moveOut = (clientX: number) => {
    if (outGrip.current == null) return;
    const v = Math.round(xval(clientX));
    const next = [...l] as [number, number, number, number, number];
    next[outGrip.current === 0 ? 3 : 4] = v;
    setL(next);
    emit(writeLevels(params, key, next));
  };

  const numField = (
    value: number, min: number, max: number, onChange: (v: number) => void, step = 1,
  ) => (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={Number.isFinite(value) ? value : ''}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        onChange(v);
      }}
      className={`${fieldCls} w-full min-w-0`}
    />
  );

  return (
    <EditorFrame>
      <div className="flex items-center justify-between">
        <ChanSelect value={ch} onChange={setCh} />
        <button
          onClick={onAuto}
          className="px-2 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 hover:bg-black/10 dark:hover:bg-white/15"
        >
          自动
        </button>
      </div>
      <HistogramCanvas hist={hist ?? null} channel={ch} color={chanColor} className="h-[110px] w-full rounded-sm bg-black/5 dark:bg-white/10" />
      {/* 输入色阶:轨道 + 三手柄 */}
      <div
        ref={trackRef}
        className="relative h-[11px] w-full touch-none"
        onPointerDown={onTrackDown}
        onPointerMove={(e) => dragging.current && grip.current != null && move(e.clientX)}
        onPointerUp={onTrackUp}
        onPointerCancel={onTrackUp}
      >
        <Handle pct={pct(l[0])} fill="#000000" title="输入黑场" />
        <Handle pct={pct(gammaPos(l[0], l[2], l[1]))} fill="rgb(128,128,128)" title="灰场(gamma)" />
        <Handle pct={pct(l[2])} fill="#ffffff" title="输入白场" />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          {numField(l[0], 0, 253, (v) => apply([Math.round(Math.min(v, l[2] - 2)), l[1], l[2], l[3], l[4]]), 1)}
        </div>
        <div className="flex-1 min-w-0">
          {numField(l[1], 0.01, 9.99, (v) => apply([l[0], Math.round(Math.min(9.99, Math.max(0.01, v)) * 100) / 100, l[2], l[3], l[4]]), 0.01)}
        </div>
        <div className="flex-1 min-w-0">
          {numField(l[2], 2, 255, (v) => apply([l[0], l[1], Math.round(Math.max(v, l[0] + 2)), l[3], l[4]]), 1)}
        </div>
      </div>
      {/* 输出色阶:渐变条 + 双手柄 */}
      <div className="text-[10px] text-gray-500 dark:text-neutral-400">输出色阶</div>
      <div
        className="h-[10px] w-full rounded-sm"
        style={{ background: `linear-gradient(to right, #000000, ${chanColor || '#ffffff'})` }}
      />
      <div
        className="relative h-[11px] w-full touch-none"
        onPointerDown={onOutDown}
        onPointerMove={(e) => dragging.current && outGrip.current != null && moveOut(e.clientX)}
        onPointerUp={onTrackUp}
        onPointerCancel={onTrackUp}
      >
        <Handle pct={pct(l[3])} fill="#000000" title="输出黑场" />
        <Handle pct={pct(l[4])} fill="#ffffff" title="输出白场" />
      </div>
      <div className="flex items-center gap-2">
        <div className="flex-1 min-w-0">
          {numField(l[3], 0, 255, (v) => apply([l[0], l[1], l[2], Math.round(v), l[4]]), 1)}
        </div>
        <div className="flex-1 min-w-0">
          {numField(l[4], 0, 255, (v) => apply([l[0], l[1], l[2], l[3], Math.round(v)]), 1)}
        </div>
      </div>
    </EditorFrame>
  );
};

// -------------------------------------------------------------------------------------------
// Curves(曲线:点模式 + 铅笔模式)

const curveHandlePx = 7;
/** 曲线图左侧留给竖直渐变条的空隙(canvas 内、graph 之外)。 */
const CURVE_GRAPH_PAD = 12;

export const CurvesEditor: React.FC<{
  params: Record<string, unknown>;
  emit: (patch: Record<string, unknown>) => void;
  hist?: RgbHistograms | null;
  lastEmitRef?: React.MutableRefObject<number>;
  flushNow?: () => void;
}> = ({ params, emit, hist, lastEmitRef, flushNow }) => {
  const [ch, setCh] = useState(0);
  const key = curveKey(LEVEL_CHANS[ch]?.key ?? '');
  const [pts, setPts] = useState<CurvePoint[]>(() => curveFromParams(params[key]));
  const [selected, setSelected] = useState<number | null>(null);
  // 铅笔模式(上游两个模式按钮):mode 本地乐观切换,引擎回包后对齐;
  // 切换 emit({pencil}) 由引擎解析器做 点↔map 转换(全部通道)
  const [mode, setMode] = useState<'points' | 'pencil'>(params.pencil === true ? 'pencil' : 'points');
  const [map, setMap] = useState<number[]>(() => mapFromParams(params[key]));
  const dark = useDarkTheme();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const dragging = useRef(false);
  const drag = useRef<{ index: number | null; offset: [number, number]; removed: boolean } | null>(null);
  // 铅笔手势:active=按住画线中,last=上一采样点(Shift 从上一笔终点连直线;上游 egui temp 口径,
  // 跨通道/跨提交保留)
  const stroke = useRef<{ active: boolean; last: CurvePoint | null }>({ active: false, last: null });
  const keyRef = useRef(key);
  const pencilMode = mode === 'pencil';

  useEffect(() => {
    // 同色阶:拖动中与自己提交的在途回包(300ms 内)不回吸,防止快速松-按时曲线回跳;
    // 切通道必须重读(节流窗口内旧通道数据无效)
    const channelSwitched = keyRef.current !== key;
    keyRef.current = key;
    if (!channelSwitched && (dragging.current || (lastEmitRef && Date.now() - lastEmitRef.current < 300))) return;
    const p = params.pencil === true;
    setMode(p ? 'pencil' : 'points');
    if (p) {
      setMap(mapFromParams(params[key]));
      setSelected(null);
    } else {
      const next = curveFromParams(params[key]);
      setPts(next);
      setSelected((s) => (s != null && s < next.length ? s : null));
    }
  }, [params, key, lastEmitRef]);

  const push = useCallback(
    (next: CurvePoint[]) => {
      setPts(next);
      emit({ [key]: next.map((p) => [Math.round(p[0]), Math.round(p[1])]) });
    },
    [emit, key],
  );

  // 模式切换:本地乐观转换(引擎转换同一条样条),命令只发 pencil 标志
  const switchMode = useCallback(
    (toPencil: boolean) => {
      if (toPencil === (mode === 'pencil')) return;
      setSelected(null);
      if (toPencil) {
        setMode('pencil');
        setMap(mapToParams(pointsToMap(pts)));
      } else {
        setMode('points');
        setPts(mapToFitPoints(map));
      }
      emit({ pencil: toPencil });
    },
    [mode, pts, map, emit],
  );

  // Smooth:当前通道 map 单遍窗口均值(上游 curves_mode_row;仅铅笔模式可用)
  const onSmooth = useCallback(() => {
    const next = mapToParams(map);
    smoothCurveMap(next);
    setMap(next);
    emit({ [key]: next });
  }, [map, key, emit]);

  // 图内/屏幕坐标换算(0..255 电平;y 翻转)
  const geom = () => {
    const cv = canvasRef.current;
    if (!cv) return null;
    const r = cv.getBoundingClientRect();
    return { left: r.left, bottom: r.bottom, w: r.width, h: r.height };
  };
  const toVal = (clientX: number, clientY: number): [number, number] => {
    const g = geom()!;
    return [
      Math.min(255, Math.max(0, ((clientX - g.left - CURVE_GRAPH_PAD) / Math.max(1, g.w - CURVE_GRAPH_PAD)) * 255)),
      Math.min(255, Math.max(0, ((g.bottom - clientY) / g.h) * 255)),
    ];
  };
  const toScrX = (v: number) => CURVE_GRAPH_PAD + (v / 255) * ((geom()?.w ?? 0) - CURVE_GRAPH_PAD);
  const toScrY = (v: number) => (geom()?.h ?? 0) - (v / 255) * (geom()?.h ?? 0);

  const graphContains = (clientX: number, clientY: number) => {
    const g = geom();
    if (!g) return false;
    return clientX >= g.left + CURVE_GRAPH_PAD && clientX <= g.left + g.w && clientY <= g.bottom && clientY >= g.bottom - g.h;
  };
  const outsideWithMargin = (clientX: number, clientY: number) => {
    const g = geom();
    if (!g) return true;
    return (
      clientX < g.left - CURVE_DRAG_OFF || clientX > g.left + g.w + CURVE_DRAG_OFF ||
      clientY < g.bottom - g.h - CURVE_DRAG_OFF || clientY > g.bottom + CURVE_DRAG_OFF
    );
  };

  // 铅笔:一次采样=从 from 到 q 的直线段填进 map;按住连续画,Shift(或笔内继续)从上一采样点连
  const pencilStrokeAt = (e: React.PointerEvent) => {
    const q = toVal(e.clientX, e.clientY);
    const st = stroke.current;
    const from = st.active || e.shiftKey ? st.last ?? q : q;
    const next = map.slice();
    if (pencilLine(next, from, q)) {
      const rounded = mapToParams(next);
      setMap(rounded);
      emit({ [key]: rounded });
    }
    st.active = true;
    st.last = q;
  };

  const onPointerDown = (e: React.PointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件或指针已释放:跳过捕获,拖动仍走 pointermove */ }
    dragging.current = true;
    if (pencilMode) {
      pencilStrokeAt(e);
      return;
    }
    const del = e.ctrlKey || e.metaKey;
    const hit = curveHit(pts, toScrX, toScrY, e.clientX, e.clientY, CURVE_HIT_RADIUS);
    if (hit != null && del) {
      const next = [...pts];
      if (curveDelete(next, hit)) push(next);
      setSelected(null);
      drag.current = null;
      return;
    }
    if (hit != null) {
      setSelected(hit);
      const v = toVal(e.clientX, e.clientY);
      drag.current = { index: hit, offset: [pts[hit][0] - v[0], pts[hit][1] - v[1]], removed: false };
      return;
    }
    if (graphContains(e.clientX, e.clientY)) {
      const v = toVal(e.clientX, e.clientY);
      const next = [...pts];
      const idx = curveInsert(next, v);
      if (idx != null) {
        push(next);
        setSelected(idx);
        drag.current = { index: idx, offset: [0, 0], removed: false };
        return;
      }
    }
    drag.current = null;
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (pencilMode) {
      if (dragging.current) pencilStrokeAt(e);
      return;
    }
    if (!dragging.current || !drag.current) return;
    const outside = outsideWithMargin(e.clientX, e.clientY);
    const d = drag.current;
    if (d.index != null && outside && curveCanDelete(pts, d.index)) {
      const next = [...pts];
      curveDelete(next, d.index);
      push(next);
      drag.current = { index: null, offset: d.offset, removed: true };
      setSelected(null);
      return;
    }
    if (d.index != null) {
      const v = toVal(e.clientX, e.clientY);
      const next = [...pts];
      curveMoveTo(next, d.index, [v[0] + d.offset[0], v[1] + d.offset[1]]);
      push(next);
      return;
    }
    if (d.index == null && d.removed && !outside) {
      const v = toVal(e.clientX, e.clientY);
      const next = [...pts];
      const idx = curveInsert(next, [v[0] + d.offset[0], v[1] + d.offset[1]]);
      if (idx != null) {
        push(next);
        setSelected(idx);
        drag.current = { index: idx, offset: d.offset, removed: true };
      }
    }
  };

  const onPointerUp = () => {
    if (pencilMode) stroke.current.active = false; // 一次手势一次提交(经 flushNow 落地)
    dragging.current = false;
    drag.current = null;
    flushNow?.();
  };

  // 键盘:Delete/Backspace 删选中点;方向键微调(Shift ×10)——都立即提交(铅笔模式无点编辑)
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (pencilMode || selected == null || selected >= pts.length) return;
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      const next = [...pts];
      if (curveDelete(next, selected)) {
        push(next);
        setSelected(null);
      }
      return;
    }
    const step = e.shiftKey ? 10 : 1;
    const map: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step],
    };
    const d = map[e.key];
    if (d) {
      e.preventDefault();
      const next = [...pts];
      if (curveMoveTo(next, selected, [pts[selected][0] + d[0], pts[selected][1] + d[1]])) push(next);
    }
  };

  // 绘制:直方图背景 / 四分格 / 对角基线 / 渐变条 / 其他通道暗色叠加 / 曲线 / 点
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const w = cv.clientWidth;
    const h = cv.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    // graph 区(右侧 w-PAD 宽)与左侧竖渐变条(0..8)
    const gp = CURVE_GRAPH_PAD;
    const gw = w - gp;
    const X = (v: number) => gp + (v / 255) * gw;
    const Y = (v: number) => h - (v / 255) * h;
    // 直方图背景(0.75 不透明度的灰,上游 gamma_multiply(0.75))
    const bins = hist?.[ch];
    if (bins && bins.length === 256) {
      const top = Math.max(1, Math.max(...bins)) * 1.1;
      ctx.fillStyle = dark ? 'rgba(190,190,190,0.75)' : 'rgba(70,70,70,0.75)';
      for (let i = 0; i < 256; i++) {
        if (!bins[i]) continue;
        const x0 = gp + Math.floor((i / 256) * gw);
        const x1 = gp + Math.floor(((i + 1) / 256) * gw);
        const bh = Math.min(1, bins[i] / top) * h;
        ctx.fillRect(x0, h - bh, Math.max(1, x1 - x0), bh);
      }
    }
    // 四分格线 + 对角基线
    const sep = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.12)';
    ctx.strokeStyle = sep;
    ctx.lineWidth = 1;
    for (let i = 1; i < 4; i++) {
      const f = i / 4;
      ctx.beginPath();
      ctx.moveTo(gp + f * gw, 0);
      ctx.lineTo(gp + f * gw, h);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(gp, f * h);
      ctx.lineTo(w, f * h);
      ctx.stroke();
    }
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.3)' : 'rgba(0,0,0,0.25)';
    ctx.beginPath();
    ctx.moveTo(gp, h);
    ctx.lineTo(w, 0);
    ctx.stroke();
    // 底部/左侧渐变条
    const chanKey = LEVEL_CHANS[ch]?.key ?? '';
    const chanColor = channelColor(chanKey) || (dark ? '#e5e5e5' : '#333333');
    const grad = ctx.createLinearGradient(gp, 0, w, 0);
    grad.addColorStop(0, '#000000');
    grad.addColorStop(1, chanKey === '' ? '#ffffff' : chanColor);
    ctx.fillStyle = grad;
    ctx.fillRect(gp, h + 3, gw, 8);
    const vgrad = ctx.createLinearGradient(0, h, 0, 0);
    vgrad.addColorStop(0, '#000000');
    vgrad.addColorStop(1, chanKey === '' ? '#ffffff' : chanColor);
    ctx.fillStyle = vgrad;
    ctx.fillRect(0, 0, 8, h);
    const drawCurve = (points: CurvePoint[], color: string, width: number) => {
      const lut = curveLut(points);
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let i = 0; i < lut.length; i++) {
        const x = gp + (i / (lut.length - 1)) * gw;
        const y = Y(lut[i] * 255);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    const drawMapLine = (m: number[], color: string, width: number) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (let k = 0; k < m.length; k++) {
        const x = X(k);
        const y = Y(m[k]);
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };
    if (pencilMode) {
      // 铅笔:画 256 级 map 折线(点不可见);叠加通道读各自 map,恒等(阈值半电平)不画
      if (ch === 0) {
        for (const c of LEVEL_CHANS.slice(1)) {
          const cm = mapFromParams(params[c.key]);
          if (!isIdentityMap(cm)) drawMapLine(cm, channelColor(c.key) || '#888', 1);
        }
      }
      drawMapLine(map, ch === 0 ? (dark ? '#f0f0f0' : '#262626') : chanColor, 1.5);
    } else {
      // 复合通道编辑时,暗色叠加各单通道曲线(仅非恒等;PS 行为)
      if (ch === 0) {
        for (const c of LEVEL_CHANS.slice(1)) {
          const cp = curveFromParams(params[c.key]);
          const isIdentity = cp.length === 2 && cp[0][1] === 0 && cp[1][1] === 255;
          if (!isIdentity) drawCurve(cp, channelColor(c.key) || '#888', 1);
        }
      }
      drawCurve(pts, ch === 0 ? (dark ? '#f0f0f0' : '#262626') : chanColor, 1.5);
      // 控制点(7px 方块;选中实心+黑边)
      for (let i = 0; i < pts.length; i++) {
        const x = X(pts[i][0]);
        const y = Y(pts[i][1]);
        ctx.fillStyle = i === selected ? (dark ? '#f0f0f0' : '#262626') : dark ? '#1f1f1f' : '#fafafa';
        ctx.fillRect(x - curveHandlePx / 2, y - curveHandlePx / 2, curveHandlePx, curveHandlePx);
        ctx.strokeStyle = i === selected ? '#000000' : chanColor;
        ctx.lineWidth = 1;
        ctx.strokeRect(x - curveHandlePx / 2, y - curveHandlePx / 2, curveHandlePx, curveHandlePx);
      }
    }
  }, [pts, map, mode, params, ch, selected, hist, dark]);

  const sel = selected != null && selected < pts.length ? selected : null;

  return (
    <EditorFrame>
      {/* 通道 + 模式行(上游 curves_mode_row):点/铅笔两按钮 + Smooth(仅铅笔可用),并排省高度 */}
      <div className="flex items-center gap-1">
        <ChanSelect value={ch} onChange={setCh} />
        <div className="flex-1" />
        <button
          type="button"
          title="编辑点以修改曲线"
          onClick={() => switchMode(false)}
          className={`p-1 rounded ${!pencilMode ? 'bg-sky-600 text-white' : 'bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 hover:bg-black/10 dark:hover:bg-white/15'}`}
        >
          <Spline size={12} />
        </button>
        <button
          type="button"
          title="绘制以修改曲线"
          onClick={() => switchMode(true)}
          className={`p-1 rounded ${pencilMode ? 'bg-sky-600 text-white' : 'bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 hover:bg-black/10 dark:hover:bg-white/15'}`}
        >
          <Pencil size={12} />
        </button>
        <button
          type="button"
          title="平滑曲线值"
          disabled={!pencilMode}
          onClick={onSmooth}
          className="px-2 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 hover:bg-black/10 dark:hover:bg-white/15 disabled:opacity-40"
        >
          平滑
        </button>
      </div>
      {/* 宽度驱动正方形(aspect-ratio);包一层 block+min-w-0:canvas 固有宽=CSS宽×dpr,
          直接做 flex 项会被 min-width:auto 撑破面板(dpr>1 必现,曾致横向滚动+巨图) */}
      <div className="min-w-0 pl-3 pt-1">
        <canvas
          ref={canvasRef}
          tabIndex={0}
          className="block h-auto w-full cursor-crosshair rounded-sm bg-black/5 outline-none focus-visible:ring-1 focus-visible:ring-sky-500 dark:bg-white/10"
          style={{ aspectRatio: '1 / 1' }}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
          onContextMenu={(e) => {
            e.preventDefault();
            if (pencilMode) return;
            const hit = curveHit(pts, toScrX, toScrY, e.clientX, e.clientY, CURVE_HIT_RADIUS);
            if (hit != null) {
              const next = [...pts];
              if (curveDelete(next, hit)) {
                push(next);
                setSelected(null);
              }
            }
          }}
        />
      </div>
      <div className="flex items-center gap-1.5">
        <span className="flex-none whitespace-nowrap text-[10px] text-gray-500 dark:text-neutral-400">输入</span>
        <input
          type="number"
          min={0}
          max={255}
          disabled={pencilMode || sel == null}
          value={sel != null ? Math.round(pts[sel][0]) : ''}
          onChange={(e) => {
            if (sel == null) return;
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            const next = [...pts];
            curveMoveTo(next, sel, [v, pts[sel][1]]);
            push(next);
          }}
          className={`${fieldCls} w-14 flex-none`}
        />
        <span className="flex-none whitespace-nowrap text-[10px] text-gray-500 dark:text-neutral-400">输出</span>
        <input
          type="number"
          min={0}
          max={255}
          disabled={pencilMode || sel == null}
          value={sel != null ? Math.round(pts[sel][1]) : ''}
          onChange={(e) => {
            if (sel == null) return;
            const v = Number(e.target.value);
            if (!Number.isFinite(v)) return;
            const next = [...pts];
            curveMoveTo(next, sel, [pts[sel][0], v]);
            push(next);
          }}
          className={`${fieldCls} w-14 flex-none`}
        />
      </div>
      <div className="truncate text-[10px] text-neutral-500 dark:text-neutral-400">
        {pencilMode ? '拖动绘制 · Shift+点击连上一笔终点' : '点击加点 · Ctrl+点击/Delete 删 · 方向键微调'}
      </div>
    </EditorFrame>
  );
};

// -------------------------------------------------------------------------------------------
// GradientMap(渐变映射;预设下拉依赖渐变预设库,留待办)

export const GradientMapEditor: React.FC<{
  params: Record<string, unknown>;
  emit: (patch: Record<string, unknown>) => void;
  lastEmitRef?: React.MutableRefObject<number>;
  flushNow?: () => void;
}> = ({ params, emit, lastEmitRef, flushNow }) => {
  const [stops, setStops] = useState<GradStop[]>(() => stopsFromParams(params.stops));
  const [selected, setSelected] = useState(0);
  const dark = useDarkTheme();
  const dragging = useRef(false);
  const drag = useRef<{ index: number; offset: number } | null>(null);
  const barRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // 同色阶:拖动中与自己提交的在途回包(300ms 内)不回吸
    if (dragging.current || (lastEmitRef && Date.now() - lastEmitRef.current < 300)) return;
    setStops(stopsFromParams(params.stops));
  }, [params, lastEmitRef]);

  const sel = Math.min(selected, stops.length - 1);
  const push = useCallback(
    (next: GradStop[]) => {
      setStops(next);
      emit({ stops: stopsToParams(next) });
    },
    [emit],
  );

  const locOf = (clientX: number) => {
    const el = barRef.current;
    if (!el) return 0;
    const r = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - r.left) / Math.max(1, r.width)));
  };
  const hitStop = (clientX: number, clientY: number): number | null => {
    const el = barRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (clientY < r.bottom) return null; // 标记在条下方
    // 从右往左找(同位停靠点先命中视觉靠右者)
    for (let i = stops.length - 1; i >= 0; i--) {
      if (Math.abs(r.left + stops[i].at * r.width - clientX) <= 6) return i;
    }
    return null;
  };

  const onDown = (e: React.PointerEvent) => {
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* 合成事件或指针已释放:跳过捕获,拖动仍走 pointermove */ }
    dragging.current = true;
    const el = barRef.current;
    const r = el?.getBoundingClientRect();
    const hit = r ? hitStop(e.clientX, e.clientY) : null;
    if (hit != null) {
      setSelected(hit);
      drag.current = { index: hit, offset: e.clientX - (r!.left + stops[hit].at * r!.width) };
      return;
    }
    if (r && e.clientY <= r.bottom) {
      // 点条上空白 = 在该位置加停靠点,颜色取渐变在该处的插值色(上限 64)
      if (stops.length >= 64) return;
      const at = Math.round(locOf(e.clientX) * 1000) / 1000;
      const next = [...stops, { at, color: sampleStops(stops, at) }];
      const idx = moveMapStop(next, next.length - 1, at) ?? 0;
      push(next);
      setSelected(idx);
    }
  };
  const onMove = (e: React.PointerEvent) => {
    if (!dragging.current || !drag.current) return;
    const at = Math.round(locOf(e.clientX - drag.current.offset) * 1000) / 1000;
    const next = [...stops];
    const idx = moveMapStop(next, drag.current.index, at);
    if (idx == null) return;
    drag.current.index = idx;
    setSelected(idx);
    push(next);
  };
  const onUp = () => {
    dragging.current = false;
    drag.current = null;
    flushNow?.();
  };

  const cssGradient = useMemo(() => {
    const p = stopsToParams(stops);
    return `linear-gradient(to right, ${p.map(([at, color]) => `${color} ${(at * 100).toFixed(2)}%`).join(', ')})`;
  }, [stops]);

  const canRemove = stops.length > 2;

  return (
    <EditorFrame>
      {/* 渐变条 + 停靠点标记(标记地址不随 Reverse 变;Reverse 只改图像映射) */}
      <div
        className="relative w-full touch-none pb-11"
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
      >
        <div ref={barRef} className="h-[24px] w-full rounded-sm border border-black/15 dark:border-white/20" style={{ background: cssGradient }} />
        {stops.map((s, i) => {
          const border = i === sel ? 'rgb(2,132,199)' : (dark ? 'rgba(215,215,215,0.85)' : 'rgba(55,55,55,0.75)');
          return (
            <div key={i} className="pointer-events-none absolute -translate-x-1/2" style={{ left: `${s.at * 100}%`, top: 26, filter: 'drop-shadow(0 1px 1px rgba(0,0,0,0.25))' }}>
              <div
                className="mx-auto"
                style={{
                  width: 0, height: 0, borderLeft: '5px solid transparent', borderRight: '5px solid transparent',
                  borderTop: `5px solid ${border}`,
                }}
              />
              <div
                className="mx-auto h-[10px] w-[10px] border"
                style={{ background: s.color, borderColor: border }}
              />
            </div>
          );
        })}
      </div>
      {stops[sel] && (
        <>
          <label className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400">颜色</span>
            <input
              type="color"
              value={stops[sel].color}
              onChange={(e) => {
                const next = [...stops];
                next[sel] = { ...next[sel], color: e.target.value };
                push(next);
              }}
              className="h-5 w-8 cursor-pointer bg-transparent p-0"
            />
            <span className="text-[10px] text-neutral-500 dark:text-neutral-400 tabular-nums">{stops[sel].color}</span>
            <div className="flex-1" />
            <button
              disabled={!canRemove}
              onClick={() => {
                const next = [...stops];
                next.splice(sel, 1);
                push(next);
                setSelected(Math.min(sel, next.length - 1));
              }}
              className="px-1.5 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 disabled:opacity-40"
              title="删除停靠点"
            >
              ✕
            </button>
          </label>
          <label className="flex items-center gap-1.5">
            <span className="w-16 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400">位置</span>
            <input
              type="number"
              min={0}
              max={100}
              step={0.1}
              value={Math.round(stops[sel].at * 1000) / 10}
              onChange={(e) => {
                const v = Number(e.target.value);
                if (!Number.isFinite(v)) return;
                const next = [...stops];
                const idx = moveMapStop(next, sel, v / 100);
                if (idx == null) return;
                push(next);
                setSelected(idx);
              }}
              className={`${fieldCls} w-20 flex-none`}
            />
            <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
          </label>
        </>
      )}
      <div>
        <button
          disabled={stops.length >= 64}
          onClick={() => {
            const at = Math.round(widestGapMid(stops) * 1000) / 1000;
            const next = [...stops, { at, color: sampleStops(stops, at) }];
            const idx = moveMapStop(next, next.length - 1, at) ?? 0;
            push(next);
            setSelected(idx);
          }}
          className="px-2 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 disabled:opacity-40"
        >
          添加停靠点
        </button>
      </div>
      <div className="flex gap-4">
        {([['reverse', '反相'], ['dither', '抖动']] as const).map(([k, label]) => (
          <label key={k} className="flex items-center gap-1.5 py-0.5 text-[11px] text-neutral-700 dark:text-neutral-300">
            <input
              type="checkbox"
              checked={params[k] === true}
              onChange={(e) => emit({ [k]: e.target.checked })}
              className="accent-sky-600"
            />
            {label}
          </label>
        ))}
      </div>
    </EditorFrame>
  );
};
