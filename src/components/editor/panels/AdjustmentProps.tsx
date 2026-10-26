/**
 * 调整层属性编辑器(属性 tab):活动层是调整层时按 kind 渲染参数控件。
 * 编辑经 layer.setAdjustment(引擎合并语义:只写给出的键)+ coalesce 把拖动中
 * 的连续修改合成一步历史(上游 Properties 面板同口径 "properties-adjustment:<id>")。
 * levels/curves/gradientMap 的完整编辑器(直方图/曲线点/渐变停靠点)下一切片。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { getSession, runCommand, subscribeSession } from '../editorStore';
import type { EditorLayer } from '../editorTypes';
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
 */
function useAdjustEmitter(tabId: string, layerId: number): (patch: Record<string, unknown>) => void {
  const pending = useRef<Record<string, unknown> | null>(null);
  const timer = useRef<number | null>(null);
  const lastSent = useRef(0);
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
  return useCallback((patch: Record<string, unknown>) => {
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
}

type EditorProps = { params: Record<string, unknown>; emit: (patch: Record<string, unknown>) => void };

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

const EDITORS: Record<string, React.FC<EditorProps>> = {
  brightnessContrast: BrightnessContrastEditor,
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
};

export const AdjustmentProps: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  const active: EditorLayer | null = s?.state?.layers.find((l) => l.id === s.state?.activeLayer) ?? null;
  const layerId = active?.id ?? 0;
  const emit = useAdjustEmitter(tabId, layerId);
  const emitRef = useRef(emit);
  emitRef.current = emit;

  if (!s?.state) return <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">属性</div>;
  const st = s.state;

  if (!active) {
    return <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">选中一个图层以查看其属性。</div>;
  }
  if (active.kind !== 'Adjustment') {
    return (
      <div className="p-2 text-[11px] text-neutral-500 dark:text-neutral-400">
        当前层是{active.name}(非调整层)。在「调整」页添加调整图层,或选中一个调整层编辑其参数。
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
      {ready && Editor ? (
        <Editor params={adj.params} emit={(patch) => emitRef.current(patch)} />
      ) : (
        <div className="text-neutral-500 dark:text-neutral-400 py-1">
          {kindLabel}的完整编辑器(直方图/曲线点/渐变停靠点)在下一切片接入;重置与剪贴已可用。
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
