/**
 * 调整层属性编辑器(属性 tab):活动层是调整层时按 kind 渲染参数控件。
 * 编辑经 layer.setAdjustment(引擎合并语义:只写给出的键)+ coalesce 把拖动中
 * 的连续修改合成一步历史(上游 Properties 面板同口径 "properties-adjustment:<id>")。
 * levels/curves/gradientMap 的完整编辑器(直方图/曲线点/渐变停靠点)在 ToneEditors.tsx。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { getSession, runCommand, subscribeSession } from '../editorStore';
import type { EditorLayer } from '../editorTypes';
import { GradientMapEditor, CurvesEditor, LevelsEditor, useHistogram, type RgbHistograms } from './ToneEditors';
import {
  ADJUST_LABEL_ZH, COLOR_LOOKUP_BUILTINS, EDITOR_READY_KINDS, HUE_RANGES, PHOTO_FILTERS,
  SELECTIVE_RANGES, bool, num, photoFilterPresetFor, withArrayIndex, withRangeField,
} from './adjustments';

/** 滑杆行:本地态跟手(引擎回包滞后不顶手指),拖动结束后才回吸引擎值。 */
const SliderRow: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  decimals?: number;
  suffix?: string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step = 1, decimals = 0, suffix = '', onChange }) => {
  const [local, setLocal] = useState(value);
  const dragging = useRef(false);
  useEffect(() => {
    if (!dragging.current) setLocal(value);
  }, [value]);
  return (
    <label className="flex items-center gap-1.5 py-0.5">
      <span className="w-16 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400 truncate" title={label}>{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={local}
        onPointerDown={() => { dragging.current = true; }}
        onPointerUp={() => { dragging.current = false; }}
        onPointerCancel={() => { dragging.current = false; }}
        onChange={(e) => {
          const v = Number(e.target.value);
          setLocal(v);
          onChange(v);
        }}
        className="flex-1 min-w-0 accent-sky-600"
      />
      <span className="w-12 shrink-0 text-right tabular-nums text-[10px] text-neutral-700 dark:text-neutral-300">
        {local.toFixed(decimals)}{suffix}
      </span>
    </label>
  );
};

const CheckRow: React.FC<{ label: string; checked: boolean; onChange: (v: boolean) => void }> = ({ label, checked, onChange }) => (
  <label className="flex items-center gap-1.5 py-0.5 text-[11px] text-neutral-700 dark:text-neutral-300">
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="accent-sky-600" />
    {label}
  </label>
);

const SelectRow: React.FC<{
  label: string;
  value: string;
  disabled?: boolean;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
}> = ({ label, value, disabled, options, onChange }) => (
  <label className="flex items-center gap-1.5 py-0.5">
    <span className="w-16 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400 truncate">{label}</span>
    <select
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className="flex-1 min-w-0 bg-surface border border-black/10 dark:border-white/15 rounded px-1 py-0.5 text-[11px] text-gray-800 dark:text-neutral-200"
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  </label>
);

const ColorRow: React.FC<{ label: string; color: string; onChange: (hex: string) => void }> = ({ label, color, onChange }) => (
  <label className="flex items-center gap-1.5 py-0.5">
    <span className="w-16 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400 truncate">{label}</span>
    <input
      type="color"
      value={color}
      onChange={(e) => onChange(e.target.value)}
      className="h-5 w-8 cursor-pointer bg-transparent p-0"
    />
    <span className="text-[10px] text-neutral-500 dark:text-neutral-400 tabular-nums">{color}</span>
  </label>
);

/**
 * 调整参数提交器:100ms 节流 + 补丁累积(合并),经 coalesce 让引擎把拖动中的
 * 连续 setAdjustment 合成一步历史;卸载/换层时把未发的补丁冲掉。
 * lastEmitRef 供直方图 keep-after-commit 与编辑器回包静默窗口判断
 * (本层提交导致的 params/revision 变化不应回吸引擎旧值);flushNow 供抬手立即发送。
 */
function useAdjustEmitter(
  tabId: string, layerId: number,
): {
  emit: (patch: Record<string, unknown>) => void;
  flushNow: () => void;
  lastEmitRef: React.MutableRefObject<number>;
} {
  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<number | null>(null);
  const lastSent = useRef(0);
  const lastEmitRef = useRef(0);
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    void runCommand(tabId, 'layer.setAdjustment', { layer: layerId, coalesce: `properties-adjustment:${layerId}`, ...p })
      .catch((e) => console.error('[editor] layer.setAdjustment', e));
    lastSent.current = performance.now();
  }, [tabId, layerId]);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    flushRef.current();
  }, []);
  const emit = useCallback((patch: Record<string, unknown>) => {
    lastEmitRef.current = Date.now();
    pending.current = { ...(pending.current ?? {}), ...patch };
    const gap = performance.now() - lastSent.current;
    if (gap >= 100) {
      flush();
    } else if (timer.current == null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        flush();
      }, 100 - gap);
    }
  }, [flush]);
  const flushNow = useCallback(() => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    flushRef.current();
  }, []);
  return { emit, flushNow, lastEmitRef };
}

type EditorProps = {
  params: Record<string, unknown>;
  emit: (patch: Record<string, unknown>) => void;
  hist?: RgbHistograms | null;
  /** 最近一次参数提交的时刻(Date.now);编辑器用它跳过自己提交的在途回包。 */
  lastEmitRef?: React.MutableRefObject<number>;
  /** 抬手立即发送节流中的补丁(手势结束尽快落地,缩小在途回包窗口)。 */
  flushNow?: () => void;
};

const BrightnessContrastEditor: React.FC<EditorProps> = ({ params, emit }) => {
  const legacy = bool(params, 'legacy');
  return (
    <>
      <SliderRow label="亮度" value={num(params, 'brightness', 0)} min={-150} max={150} onChange={(v) => emit({ brightness: v })} />
      <SliderRow label="对比度" value={num(params, 'contrast', 0)} min={legacy ? -100 : -50} max={100} onChange={(v) => emit({ contrast: v })} />
      <CheckRow label="使用旧版( legacy)" checked={legacy} onChange={(v) => emit({ legacy: v })} />
    </>
  );
};

const ExposureEditor: React.FC<EditorProps> = ({ params, emit }) => (
  <>
    <SliderRow label="曝光度" value={num(params, 'exposure', 0)} min={-20} max={20} step={0.01} decimals={2} onChange={(v) => emit({ exposure: v })} />
    <SliderRow label="位移" value={num(params, 'offset', 0)} min={-0.5} max={0.5} step={0.001} decimals={3} onChange={(v) => emit({ offset: v })} />
    <SliderRow label="灰度系数" value={num(params, 'gamma', 1)} min={0.01} max={9.99} step={0.01} decimals={2} onChange={(v) => emit({ gamma: v })} />
  </>
);

const VibranceEditor: React.FC<EditorProps> = ({ params, emit }) => (
  <>
    <SliderRow label="自然饱和度" value={num(params, 'vibrance', 0)} min={-100} max={100} onChange={(v) => emit({ vibrance: v })} />
    <SliderRow label="饱和度" value={num(params, 'saturation', 0)} min={-100} max={100} onChange={(v) => emit({ saturation: v })} />
  </>
);

const HueSaturationEditor: React.FC<EditorProps> = ({ params, emit }) => {
  const colorize = bool(params, 'colorize');
  const [rangeKey, setRangeKey] = useState('master');
  const isMaster = rangeKey === 'master';
  const rangeObj = (isMaster ? params : (params[rangeKey] ?? {})) as Record<string, unknown>;
  return (
    <>
      <SelectRow
        label="范围"
        value={rangeKey}
        disabled={colorize}
        onChange={setRangeKey}
        options={[{ value: 'master', label: '全图' }, ...HUE_RANGES.map((r) => ({ value: r.key, label: r.label }))]}
      />
      <SliderRow
        label="色相"
        value={num(rangeObj, 'hue', 0)}
        min={colorize && isMaster ? 0 : -180}
        max={colorize && isMaster ? 360 : 180}
        onChange={(v) => emit(isMaster ? { hue: v } : { [rangeKey]: withRangeField(params[rangeKey], 'hue', v) })}
      />
      <SliderRow
        label="饱和度"
        value={num(rangeObj, 'saturation', 0)}
        min={colorize && isMaster ? 0 : -100}
        max={100}
        onChange={(v) => emit(isMaster ? { saturation: v } : { [rangeKey]: withRangeField(params[rangeKey], 'saturation', v) })}
      />
      <SliderRow
        label="明度"
        value={num(rangeObj, 'lightness', 0)}
        min={-100}
        max={100}
        onChange={(v) => emit(isMaster ? { lightness: v } : { [rangeKey]: withRangeField(params[rangeKey], 'lightness', v) })}
      />
      <CheckRow label="着色" checked={colorize} onChange={(v) => emit({ colorize: v })} />
    </>
  );
};

const TONES = [
  { key: 'shadows', label: '阴影' },
  { key: 'midtones', label: '中间调' },
  { key: 'highlights', label: '高光' },
];
const BALANCE_AXES = ['青 ⇄ 红', '洋红 ⇄ 绿', '黄 ⇄ 蓝'];

const ColorBalanceEditor: React.FC<EditorProps> = ({ params, emit }) => {
  const [tone, setTone] = useState('midtones');
  return (
    <>
      <div className="flex gap-1 py-0.5">
        {TONES.map((t) => (
          <button
            key={t.key}
            onClick={() => setTone(t.key)}
            className={`px-2 py-0.5 rounded text-[10px] ${tone === t.key ? 'bg-sky-600 text-white' : 'bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300'}`}
          >
            {t.label}
          </button>
        ))}
      </div>
      {BALANCE_AXES.map((axis, i) => (
        <SliderRow
          key={axis}
          label={axis}
          value={withArrayIndex(params[tone], i, 0)[i]}
          min={-100}
          max={100}
          onChange={(v) => emit({ [tone]: withArrayIndex(params[tone], i, v) })}
        />
      ))}
      <CheckRow label="保持明度" checked={bool(params, 'preserveLuminosity', true)} onChange={(v) => emit({ preserveLuminosity: v })} />
    </>
  );
};

const BlackWhiteEditor: React.FC<EditorProps> = ({ params, emit }) => {
  const tint = bool(params, 'tint');
  return (
    <>
      {HUE_RANGES.map((r, i) => (
        <SliderRow
          key={r.key}
          label={r.label}
          value={num(params, r.key, [40, 60, 40, 60, 20, 80][i])}
          min={-200}
          max={300}
          onChange={(v) => emit({ [r.key]: v })}
        />
      ))}
      <CheckRow label="着色" checked={tint} onChange={(v) => emit({ tint: v })} />
      {tint && (
        <ColorRow
          label="色相"
          color={typeof params.tintColor === 'string' ? params.tintColor : '#e1d3b3'}
          onChange={(hex) => emit({ tintColor: hex })}
        />
      )}
    </>
  );
};

const PhotoFilterEditor: React.FC<EditorProps> = ({ params, emit }) => {
  const preset = photoFilterPresetFor(params.color);
  return (
    <>
      <SelectRow
        label="滤镜"
        value={preset ?? 'custom'}
        onChange={(id) => {
          const f = PHOTO_FILTERS.find((x) => x.id === id);
          if (f) emit({ color: f.color });
        }}
        options={[
          ...PHOTO_FILTERS.map((f) => ({ value: f.id, label: f.label })),
          { value: 'custom', label: '自定义颜色…' },
        ]}
      />
      <ColorRow
        label="颜色"
        color={typeof params.color === 'string' ? params.color : '#ec8a00'}
        onChange={(hex) => emit({ color: hex })}
      />
      <SliderRow label="浓度" value={num(params, 'density', 25)} min={0} max={100} onChange={(v) => emit({ density: v })} suffix="%" />
      <CheckRow label="保持明度" checked={bool(params, 'preserveLuminosity', true)} onChange={(v) => emit({ preserveLuminosity: v })} />
    </>
  );
};

const ChannelMixerEditor: React.FC<EditorProps> = ({ params, emit }) => {
  const mono = bool(params, 'monochrome');
  const [ch, setCh] = useState('red');
  const channel = mono ? 'gray' : ch;
  const CHANNEL_OPTS = mono
    ? [{ value: 'gray', label: '灰' }]
    : [{ value: 'red', label: '红' }, { value: 'green', label: '绿' }, { value: 'blue', label: '蓝' }];
  const row = withArrayIndex(params[channel], 0, 0);
  return (
    <>
      <SelectRow label="输出通道" value={channel} disabled={mono} onChange={setCh} options={CHANNEL_OPTS} />
      {['红', '绿', '蓝'].map((label, i) => (
        <SliderRow key={label} label={label} value={row[i] ?? 0} min={-200} max={200} onChange={(v) => emit({ [channel]: withArrayIndex(params[channel], i, v) })} suffix="%" />
      ))}
      <SliderRow label="常数" value={row[3] ?? 0} min={-200} max={200} onChange={(v) => emit({ [channel]: withArrayIndex(params[channel], 3, v) })} suffix="%" />
      <CheckRow
        label="单色"
        checked={mono}
        onChange={(v) => emit(v ? { monochrome: true, gray: [40, 40, 20, 0] } : { monochrome: false })}
      />
    </>
  );
};

const SelectiveColorEditor: React.FC<EditorProps> = ({ params, emit }) => {
  const [rangeKey, setRangeKey] = useState('reds');
  return (
    <>
      <SelectRow
        label="颜色"
        value={rangeKey}
        onChange={setRangeKey}
        options={SELECTIVE_RANGES.map((r) => ({ value: r.key, label: r.label }))}
      />
      {['青', '洋红', '黄', '黑'].map((label, i) => (
        <SliderRow
          key={label}
          label={label}
          value={withArrayIndex(params[rangeKey], i, 0)[i] ?? 0}
          min={-100}
          max={100}
          onChange={(v) => emit({ [rangeKey]: withArrayIndex(params[rangeKey], i, v) })}
          suffix="%"
        />
      ))}
      <SelectRow
        label="方法"
        value={typeof params.method === 'string' ? params.method : 'relative'}
        onChange={(v) => emit({ method: v })}
        options={[{ value: 'relative', label: '相对' }, { value: 'absolute', label: '绝对' }]}
      />
    </>
  );
};

const PosterizeEditor: React.FC<EditorProps> = ({ params, emit }) => (
  <SliderRow label="色阶数" value={num(params, 'levels', 4)} min={2} max={255} onChange={(v) => emit({ levels: Math.round(v) })} />
);

const ThresholdEditor: React.FC<EditorProps> = ({ params, emit }) => (
  <SliderRow label="阈值色阶" value={num(params, 'level', 128)} min={1} max={255} onChange={(v) => emit({ level: Math.round(v) })} />
);

const ColorLookupEditor: React.FC<EditorProps> = ({ params, emit }) => {
  // 引擎 to_params 不回显已选 LUT(存的是数据本身),下拉选中态用本地记忆
  const [lut, setLut] = useState<string>('');
  return (
    <>
      <SelectRow
        label="3DLUT"
        value={lut}
        onChange={(id) => {
          setLut(id);
          emit({ lut: id === '' ? 'none' : id });
        }}
        options={[{ value: '', label: '无' }, ...COLOR_LOOKUP_BUILTINS.map((b) => ({ value: b.id, label: b.label }))]}
      />
      <SelectRow
        label="插值"
        value={typeof params.interpolation === 'string' ? params.interpolation : 'trilinear'}
        onChange={(v) => emit({ interpolation: v })}
        options={[{ value: 'trilinear', label: '三线性' }, { value: 'tetrahedral', label: '四面体' }]}
      />
      <CheckRow label="抖动" checked={bool(params, 'dither')} onChange={(v) => emit({ dither: v })} />
    </>
  );
};

/** 蒙版羽化的轨道曲线(上游 #6545:滑杆位置 p∈0..1 → 值 p³×max,低段精细)。 */
export function featherFromPos(pos01: number, max = 1000): number {
  const t = Math.min(1, Math.max(0, pos01));
  return Math.round(t * t * t * max);
}
export function featherToPos(value: number, max = 1000): number {
  const x = Math.min(max, Math.max(0, value)) / max;
  return Math.cbrt(x);
}

/**
 * 图层蒙版属性区段(上游 mask_props_ui 口径,双击蒙版缩略图进入):
 * 浓度 0..100%、羽化 0..1000px(x³ 轨道)、反相(target:"mask")。
 * 走 layer.layerMask.edit(至少一项参数;100ms 节流+coalesce 合一步历史),
 * 本地态跟手,自己提交的在途回包(300ms)不回吸——与调整编辑器同款防回跳。
 */
const MaskPropsSection: React.FC<{
  tabId: string;
  docId: number | null;
  layerId: number;
  enabled: boolean;
  density: number; // 0..100(%)
  feather: number; // 0..1000 px
}> = ({ tabId, docId, layerId, enabled, density, feather }) => {
  const [local, setLocal] = useState({ density, feather });
  const dragging = useRef(false);
  const lastEmit = useRef(0);
  const timer = useRef<number | null>(null);
  const pending = useRef<Record<string, unknown> | null>(null);
  useEffect(() => {
    if (!dragging.current && Date.now() - lastEmit.current >= 300) setLocal({ density, feather });
  }, [density, feather]);
  const flush = useCallback(() => {
    const p = pending.current;
    if (!p) return;
    pending.current = null;
    void runCommand(tabId, 'layer.layerMask.edit', { document: docId, layer: layerId, coalesce: `pixel-mask:${docId}:${layerId}`, ...p })
      .catch((e) => console.error('[editor] layerMask.edit', e));
  }, [tabId, docId, layerId]);
  const flushRef = useRef(flush);
  flushRef.current = flush;
  useEffect(() => () => {
    if (timer.current != null) window.clearTimeout(timer.current);
    flushRef.current();
  }, []);
  const emitField = (field: 'density' | 'feather', value: number) => {
    lastEmit.current = Date.now();
    pending.current = { ...(pending.current ?? {}), [field]: value };
    setLocal((prev) => ({ ...prev, [field]: value }));
    if (timer.current == null) {
      timer.current = window.setTimeout(() => {
        timer.current = null;
        flushRef.current();
      }, 100);
    }
  };
  const slider = (field: 'density' | 'feather', label: string, max: number, unit: string, curve: boolean) => {
    const toPos = (v: number) => (curve ? featherToPos(v, max) : v / max) * 1000;
    const toVal = (pos: number) => (curve ? featherFromPos(pos / 1000, max) : Math.round((pos / 1000) * max));
    return (
      <label className="flex items-center gap-1.5 py-0.5">
        <span className="w-16 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400 truncate" title={label}>{label}</span>
        <input
          type="range"
          min={0}
          max={1000}
          value={Math.round(toPos(local[field]))}
          onPointerDown={() => { dragging.current = true; }}
          onPointerUp={() => { dragging.current = false; flushRef.current(); }}
          onPointerCancel={() => { dragging.current = false; flushRef.current(); }}
          onChange={(e) => emitField(field, toVal(Number(e.target.value)))}
          className="flex-1 min-w-0 accent-sky-600"
        />
        <span className="w-12 shrink-0 text-right tabular-nums text-[10px] text-neutral-700 dark:text-neutral-300">
          {Math.round(local[field])}{unit}
        </span>
      </label>
    );
  };
  return (
    <div className="rounded border border-black/10 dark:border-white/15 bg-black/[0.03] dark:bg-white/[0.04] px-1.5 py-1 mb-1.5">
      <div className="flex items-center gap-2 pb-0.5">
        <span className="font-medium text-neutral-800 dark:text-neutral-200">图层蒙版</span>
        {!enabled && <span className="text-[10px] text-amber-600 dark:text-amber-400">已停用</span>}
        <div className="flex-1" />
        <button
          title="反相蒙版(黑白互换;作用于蒙版通道)"
          onClick={() => void runCommand(tabId, 'image.adjustments.invert', { target: 'mask' }).catch((e) => console.error('[editor] invert mask', e))}
          className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      {slider('density', '浓度', 100, '%', false)}
      {slider('feather', '羽化', 1000, ' px', true)}
    </div>
  );
};

const EDITORS: Record<string, React.FC<EditorProps>> = {  brightnessContrast: BrightnessContrastEditor,
  exposure: ExposureEditor,
  vibrance: VibranceEditor,
  hueSaturation: HueSaturationEditor,
  colorBalance: ColorBalanceEditor,
  blackWhite: BlackWhiteEditor,
  photoFilter: PhotoFilterEditor,
  channelMixer: ChannelMixerEditor,
  selectiveColor: SelectiveColorEditor,
  posterize: PosterizeEditor,
  threshold: ThresholdEditor,
  colorLookup: ColorLookupEditor,
  levels: LevelsEditor,
  curves: CurvesEditor,
  gradientMap: GradientMapEditor,
};

export const AdjustmentProps: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  const active: EditorLayer | null = s?.state?.layers.find((l) => l.id === s.state?.activeLayer) ?? null;
  const layerId = active?.id ?? 0;
  const { emit, flushNow, lastEmitRef } = useAdjustEmitter(tabId, layerId);
  const emitRef = useRef(emit);
  emitRef.current = emit;
  const flushNowRef = useRef(flushNow);
  flushNowRef.current = flushNow;
  // 色阶/曲线的直方图数据(调整层下方合成;keep-after-commit:本层提交不重拉)
  const needsHist = active?.adjustment?.kind === 'levels' || active?.adjustment?.kind === 'curves';
  const hist = useHistogram(tabId, s?.docId ?? null, layerId, s?.revision ?? 0, !!needsHist, lastEmitRef);

  if (!s?.state) return <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">属性</div>;
  const st = s.state;

  if (!active) {
    return <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">选中一个图层以查看其属性。</div>;
  }
  // 蒙版目标+该层有蒙版:属性页顶部显示蒙版区段(浓度/羽化;上游双击蒙版缩略图进入)
  const maskSection =
    st.channels?.target?.kind === 'layerMask' && active.hasMask ? (
      <MaskPropsSection
        tabId={tabId}
        docId={s.docId ?? null}
        layerId={active.id}
        enabled={st.maskInfo?.[String(active.id)]?.enabled ?? true}
        density={(st.maskInfo?.[String(active.id)]?.density ?? 1) * 100}
        feather={st.maskInfo?.[String(active.id)]?.feather ?? 0}
      />
    ) : null;
  if (active.kind !== 'Adjustment') {
    return (
      <div className="p-2 text-[11px] flex flex-col gap-0.5 overflow-y-auto min-h-0">
        {maskSection}
        <div className="text-neutral-500 dark:text-neutral-400">
          当前层是{active.name}(非调整层)。在「调整」页添加调整图层,或选中一个调整层编辑其参数。
        </div>
      </div>
    );
  }
  const adj = active.adjustment;
  if (!adj) {
    return <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">正在读取调整参数…</div>;
  }
  if (adj.unsupported) {
    return (
      <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        此调整(PSD 导入)不被支持,按原始字节保留,不可编辑。
      </div>
    );
  }
  const kindLabel = ADJUST_LABEL_ZH[adj.kind] ?? adj.kind;
  const Editor = EDITORS[adj.kind];
  const ready = EDITOR_READY_KINDS.has(adj.kind);

  return (
    <div className="p-2 text-[11px] flex flex-col gap-0.5 overflow-y-auto min-h-0">
      <div className="flex items-center gap-2 pb-1">
        <span className="font-medium text-neutral-800 dark:text-neutral-200">{kindLabel}</span>
        <div className="flex-1" />
        {/* 重置为默认(引擎口径:setAdjustment 无参数 = 重置该 kind 默认) */}
        <button
          title="重置为默认参数"
          onClick={() => void runCommand(tabId, 'layer.setAdjustment', { layer: active.id, coalesce: `properties-reset:${active.id}` }).catch((e) => console.error('[editor] 重置调整', e))}
          className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <RotateCcw size={12} />
        </button>
      </div>
      {maskSection}
      {ready && Editor ? (
        <Editor params={adj.params} emit={(patch) => emitRef.current(patch)} hist={hist} lastEmitRef={lastEmitRef} flushNow={() => flushNowRef.current()} />
      ) : (
        <div className="text-neutral-500 dark:text-neutral-400 py-1">
          {kindLabel}暂无专属编辑器;重置与剪贴已可用。
        </div>
      )}
      {/* 本地预演合并(与引擎 layer.setAdjustment 的合并语义一致的回显来源注释):
          控件值来自引擎 params(to_params 口径),拖动中由控件本地态跟随 */}
      <CheckRow
        label="剪贴到下方图层"
        checked={active.clipped}
        onChange={(v) => void runCommand(tabId, 'layer.setProps', { layer: active.id, clipped: v }).catch((e) => console.error('[editor] clipped', e))}
      />
    </div>
  );
};
