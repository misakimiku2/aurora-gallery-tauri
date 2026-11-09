/**
 * 字符页签(二期 二-7,上游 type_tool.rs type_sections 的 Character 段+Type Options 移植):
 * 字体/样式/字号/行高/字距/追踪/缩放/基线偏移/颜色/仿粗斜全大写小写/下划线删除线/横竖/抗锯齿
 * +段落对齐与方向。目标=编辑会话的层选区(有选区只改选中字符,并入会话历史步),否则活动/
 * 选中 Type 层整层,否则改工具默认(下一层)。尺寸按层变换缩放显示(metricsAsShown)。
 * 段落字段(缩进/段距)与 OpenType 特征行后置(切片表口径)。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { EditorSelect, type EditorSelectOption } from '../editorSelect';
import { ColorPicker } from './ColorPicker';
import {
  applyTypeStyle, fetchFontFaces, fetchFontFamilies, getSession, noteRecentFont, setOptions,
  subscribeSession, runCommand, updateSession,
} from '../editorStore';
import {
  AA_OPTIONS, ALIGN_ITEMS, aaKey, axisLabel, axisValue, fauxToggleProps, kerningAt, kerningLabel,
  leadingShown, selectedStyleName, sliderAxes, styleAt, styleColorHex,
  styleLabel, styleNames, shownScale, type CharStyleJson, type FaceInfoJson, type ParaStyleJson,
} from '../typeStyle';

/** 标签+数值输入行(上游 num_field 的 icon+value 对;blur/Enter 提交,Esc 还原)。 */
const NumField: React.FC<{
  label: string;
  tip: string;
  value: number;
  min: number;
  max: number;
  unit?: string;
  width?: string;
  onCommit: (v: number) => void;
}> = ({ label, tip, value, min, max, unit = '', width = 'w-16', onCommit }) => {
  const [buf, setBuf] = useState<string>(String(Math.round(value * 100) / 100));
  // 外部值变化时无条件同步显示(引擎回写/样式切换;deps=value,用户敲字不触发)。
  // 条件同步(focusRef 跳过)会让过期 buf 在 blur 时把默认值写回文档——冒烟实证。
  useEffect(() => {
    setBuf(String(Math.round(value * 100) / 100));
  }, [value]);
  const commit = () => {
    const n = Number(buf);
    if (buf.trim() !== '' && Number.isFinite(n) && n >= min && n <= max && n !== Math.round(value * 100) / 100) {
      onCommit(n);
    } else {
      setBuf(String(Math.round(value * 100) / 100));
    }
  };
  return (
    <label className="flex items-center gap-1 min-w-0" title={tip}>
      <span className="w-6 shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400 text-center">{label}</span>
      <input
        value={buf}
        onChange={(e) => setBuf(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          // Enter=就地提交(保持焦点,后续可继续改);Escape=还原并离开。
          // 不用 blur 触发提交:React onBlur 委托在编程 blur 的链路上不可靠(冒烟实证)。
          e.stopPropagation();
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { setBuf(String(Math.round(value * 100) / 100)); (e.target as HTMLInputElement).blur(); }
        }}
        className={`${width} min-w-0 px-1.5 py-0.5 text-[11px] rounded border border-subtle bg-panel text-gray-800 dark:text-neutral-200 outline-none focus:border-sky-500 tabular-nums`}
      />
      {unit && <span className="text-[10px] text-neutral-500 dark:text-neutral-400">{unit}</span>}
    </label>
  );
};

/** 伪样式切换小按钮(T 字符组;上游 toggle_cell)。 */
const ToggleCell: React.FC<{ on: boolean; title: string; children: React.ReactNode; onClick: () => void }> = ({ on, title, children, onClick }) => (
  <button
    type="button"
    title={title}
    onClick={onClick}
    className={`w-8 h-6 rounded text-[12px] flex items-center justify-center transition-colors ${
      on
        ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/40'
        : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 border border-transparent'
    }`}
  >
    {children}
  </button>
);

const SECTION = 'px-3 py-1.5 text-[10px] text-neutral-500 dark:text-neutral-400 border-b border-black/5 dark:border-white/5';

export const TypePanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  /** type.info 快照(revision 变化重拉)与字体目录。 */
  const [info, setInfo] = useState<{ runs: { start: number; end: number; style: CharStyleJson }[]; paragraphs: { start: number; end: number; style: ParaStyleJson }[]; transform: number[]; orientation: string; antialias: string; shape: unknown } | null>(null);
  const [families, setFamilies] = useState<string[]>([]);
  const [faces, setFaces] = useState<FaceInfoJson[]>([]);
  const [colorPick, setColorPick] = useState<{ rgb: [number, number, number] } | null>(null);
  const infoKeyRef = useRef('');

  // 目标层:编辑会话的层,否则活动层/选中集里的 Type 层
  const ed = s?.textEdit ?? null;
  const st = s?.state ?? null;
  const findKind = (layers: { id: number; kind: string; children?: { id: number; kind: string }[] }[], id: number): string | null => {
    for (const l of layers) {
      if (l.id === id) return l.kind;
      if (l.children) { const f = findKind(l.children as never, id); if (f) return f; }
    }
    return null;
  };
  const targetLayer = ed?.layer ?? (() => {
    if (!st) return null;
    const ids = st.selectedLayers.length ? st.selectedLayers : st.activeLayer != null ? [st.activeLayer] : [];
    return ids.find((id) => findKind(st.layers, id) === 'Type') ?? null;
  })();
  const selA = ed ? Math.min(ed.caret, ed.anchor) : 0;
  const selB = ed ? Math.max(ed.caret, ed.anchor) : 0;
  const at = selA < selB ? selA : 0;

  // type.info 常驻拉取(revision/层变化);字体目录挂载一次
  const rev = s?.revision ?? 0;
  useEffect(() => {
    let alive = true;
    if (targetLayer == null) { setInfo(null); return undefined; }
    const key = `${targetLayer}:${rev}`;
    if (infoKeyRef.current === key) return undefined;
    infoKeyRef.current = key;
    void runCommand(tabId, 'type.info', { layer: targetLayer }, { noPull: true })
      .then((r) => { if (alive) setInfo(r as typeof info); })
      .catch(() => { if (alive) setInfo(null); });
    return () => { alive = false; };
  }, [tabId, targetLayer, rev]);
  useEffect(() => {
    void fetchFontFamilies(tabId).then((list) => setFamilies(list));
  }, [tabId]);
  const famShown = info ? styleAt(info.runs, at)?.font_family ?? '' : s?.options.typeFont ?? '';
  useEffect(() => {
    if (!famShown) return;
    let alive = true;
    void fetchFontFaces(tabId, famShown).then((f) => { if (alive) setFaces(f); });
    return () => { alive = false; };
  }, [tabId, famShown]);

  if (!s) return null;
  const c = info ? styleAt(info.runs, at) : null;
  const para = info ? (info.paragraphs.length ? (info.paragraphs.find((p) => at >= p.start && at < p.end) ?? info.paragraphs[info.paragraphs.length - 1])?.style ?? null : null) : null;
  const scale = shownScale(info?.transform);
  const hasTarget = c != null;

  // 样式提交入口:hasTarget=引擎命令;无目标=工具默认(applyTypeStyle 内部分流)
  const apply = (props: Record<string, unknown>) => { void applyTypeStyle(tabId, props); };

  // 字体下拉行:最近使用组 + 全部
  const famOptions: EditorSelectOption[] = [
    ...s.options.typeRecentFonts.filter((f) => families.includes(f) || families.length === 0).map((f) => ({ value: f, label: f, group: '最近使用' })),
    ...families.map((f) => ({ value: f, label: f })),
  ];
  const styleOpts = styleNames(faces).map((n) => ({ value: n, label: styleLabel(n) }));

  const pickFont = (f: string) => {
    noteRecentFont(tabId, f);
    // 换族时样式名回落该族首个(上游 options_bar:style 不在新族里取 first)
    const nextStyle = styleOpts.some((o) => o.value === s.options.typeStyle) ? s.options.typeStyle : 'Regular';
    setOptions(tabId, { typeFont: f, typeStyle: nextStyle });
    apply({ font: f });
  };

  const k = c ? kerningAt(c, ed && selA === selB ? ed.caret : null, info?.runs ?? []) : { mode: 'Metrics', kern: 0 };
  const styleShown = c ? selectedStyleName(c, faces) : s.options.typeStyle || 'Regular';
  const toggles = c ? fauxToggleProps(c) : [];
  // 点文本(非段落框/区域)禁 justify(上游 #7713;shape='Point' 是字符串,Box/Area 是对象)
  const shapeObj = info?.shape && typeof info.shape === 'object' ? (info.shape as Record<string, unknown>) : null;
  const pointText = !(shapeObj && ('Box' in shapeObj || 'Area' in shapeObj));
  const orientV = info ? info.orientation === 'Vertical' : s.tool === 'typeVertical';

  return (
    <div className="flex-1 min-h-0 overflow-y-auto text-[11px]">
      <div className={SECTION}>字符{ed ? '(编辑中)' : hasTarget ? '' : '(默认:无选中文字层)'}</div>
      <div className="p-2 space-y-1.5">
        {/* 字体 + 样式 */}
        <div className="flex items-center gap-1.5 min-w-0">
          <EditorSelect
            value={famShown}
            options={famOptions}
            onChange={pickFont}
            className="flex-1 min-w-0"
            searchable
            title="字体族(输入过滤)"
            disabled={families.length === 0}
          />
          <EditorSelect
            value={styleShown}
            options={styleOpts}
            onChange={(v) => { setOptions(tabId, { typeStyle: v }); apply({ fontStyle: v }); }}
            className="w-28 shrink-0"
            title="字体样式"
            disabled={faces.length === 0}
          />
        </div>
        {/* 字号 + 行高 */}
        <div className="flex items-center gap-1.5">
          <NumField label="T" tip="字号" value={(c?.size_pt ?? s.options.typeSize) * scale} min={0.1} max={1296}
            onCommit={(v) => { if (hasTarget) apply({ size: v / scale, metricsAsShown: true }); else apply({ size: v }); }} />
          <NumField label="A↕" tip="行距(字号×自动行距=自动)" value={c ? leadingShown(c, para, scale) : (Number(s.options.typeStyleDefaults.leading) || 12) * scale} min={0.1} max={5000}
            onCommit={(v) => apply({ leading: hasTarget && scale !== 1 ? v / scale : v, metricsAsShown: scale !== 1 ? true : undefined })} />
        </div>
        {/* 字距 + 追踪 */}
        <div className="flex items-center gap-1.5">
          <NumField label="K" tip="字距:Metrics/Optical 或 1/1000 em(编辑会话折叠 caret=前一对)" value={Number(kerningLabel(k)) || 0} min={-1000} max={10000}
            onCommit={(v) => apply({ kerning: v })} />
          <EditorSelect
            value=""
            alwaysBlank
            blankLabel="字距预设…"
            options={[
              { value: 'metrics', label: 'Metrics' },
              { value: 'optical', label: 'Optical' },
              ...[-100, -75, -50, -25, -10, 0, 10, 25, 50, 100, 200].map((n) => ({ value: String(n), label: String(n) })),
            ]}
            onChange={(v) => apply({ kerning: v === 'metrics' || v === 'optical' ? v : Number(v) })}
            className="w-24 shrink-0"
            title="字距预设"
          />
          <NumField label="VA" tip="字距追踪(1/1000 em)" value={c?.tracking ?? 0} min={-1000} max={10000} width="w-14"
            onCommit={(v) => apply({ tracking: v })} />
        </div>
        {/* 垂直/水平缩放 + 基线偏移 */}
        <div className="flex items-center gap-1.5">
          <NumField label="↕T" tip="垂直缩放 %" value={(c?.vertical_scale ?? 1) * 100} min={0} max={1000} unit="%"
            onCommit={(v) => apply({ verticalScale: v })} />
          <NumField label="↔T" tip="水平缩放 %" value={(c?.horizontal_scale ?? 1) * 100} min={0} max={1000} unit="%"
            onCommit={(v) => apply({ horizontalScale: v })} />
          <NumField label="Aª" tip="基线偏移(pt)" value={(c?.baseline_shift_pt ?? 0) * scale} min={-1296} max={1296}
            onCommit={(v) => apply({ baselineShift: scale !== 1 ? v / scale : v })} />
        </div>
        {/* 颜色 */}
        <div className="flex items-center gap-1.5">
          <span className="w-6 shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400 text-center">色</span>
          <button
            type="button"
            title="文字颜色(编辑中选区字符/整层)"
            className="w-8 h-5 rounded-sm border border-black/30 dark:border-neutral-500"
            style={{ background: c ? styleColorHex(c.color) : '#000000' }}
            onClick={() => c && setColorPick({ rgb: (() => { const h = styleColorHex(c.color); return [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]; })() })}
          />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">{c ? styleColorHex(c.color).toUpperCase() : ''}</span>
        </div>
        {/* 伪样式 6 toggle */}
        <div className="flex items-center gap-0.5">
          {toggles.map((t, i) => (
            <ToggleCell key={t.label} on={t.on} title={t.label} onClick={() => apply(t.props)}>
              {['B', 'I', 'TT', 'ᴛT', 'U', 'S'][i]}
            </ToggleCell>
          ))}
        </div>
      </div>

      {/* 段落:对齐 7 态 + 方向 3 态(点文本禁 justify=上游 #7713) */}
      <div className={SECTION}>段落</div>
      <div className="p-2 space-y-1.5">
        <div className="flex items-center gap-0.5">
          {ALIGN_ITEMS.map((a) => {
            const justify = a.key.startsWith('justify');
            const disabled = !hasTarget || (pointText && justify);
            const on = para?.align === a.key;
            return (
              <button
                key={a.key}
                type="button"
                title={a.label}
                disabled={disabled}
                onClick={() => apply({ align: a.key })}
                className={`w-8 h-6 rounded text-[10px] flex items-center justify-center transition-colors ${
                  on ? 'bg-sky-500/15 text-sky-700 dark:text-sky-300 border border-sky-500/40'
                    : disabled ? 'text-neutral-300 dark:text-neutral-600'
                      : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10 border border-transparent'
                }`}
              >
                {a.key === 'center' ? '≡C' : a.key === 'right' ? '≡R' : a.key === 'justifyLeft' ? '≡L,' : a.key === 'justifyCenter' ? '≡,C' : a.key === 'justifyRight' ? '≡,R' : a.key === 'justifyAll' ? '≡≡' : '≡L'}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-0.5">
          {['auto', 'ltr', 'rtl'].map((d) => (
            <ToggleCell key={d} on={para?.direction === d} title={d === 'auto' ? '自动段落方向' : d === 'ltr' ? '从左到右' : '从右到左'} onClick={() => apply({ direction: d })}>
              {d === 'auto' ? '¶↔' : d === 'ltr' ? '¶→' : '←¶'}
            </ToggleCell>
          ))}
        </div>
      </div>

      {/* 文字选项:抗锯齿 + 横竖(整层;上游 type_properties 的 Type Options 段) */}
      <div className={SECTION}>文字选项</div>
      <div className="p-2 space-y-1.5">
        <div className="flex items-center gap-1.5">
          <EditorSelect
            value={info ? aaKey(info.antialias) : s.options.typeAA}
            options={AA_OPTIONS}
            onChange={(v) => {
              setOptions(tabId, { typeAA: v });
              if (targetLayer != null) {
                const p = ed ? { layer: ed.layer, coalesce: ed.session } : { layer: targetLayer };
                void runCommand(tabId, `type.antiAlias.${v}`, p).catch((err) => console.error('[editor] type.antiAlias 失败', err));
              }
            }}
            className="flex-1"
            title="抗锯齿"
          />
          <ToggleCell on={!orientV} title="横排文字" onClick={() => targetLayer != null && void runCommand(tabId, 'type.orientation.horizontal', ed ? { layer: ed.layer, coalesce: ed.session } : { layer: targetLayer }).catch(() => undefined)}>H</ToggleCell>
          <ToggleCell on={orientV} title="竖排文字" onClick={() => targetLayer != null && void runCommand(tabId, 'type.orientation.vertical', ed ? { layer: ed.layer, coalesce: ed.session } : { layer: targetLayer }).catch(() => undefined)}>V</ToggleCell>
        </div>
      </div>

      {/* 变量轴滑杆(可变字体;上游 axis_sliders) */}
      {c && (() => {
        const axes = sliderAxes(faces, c.italic);
        const variations: Record<string, number> = {};
        if (info) {
          for (const run of info.runs) {
            for (const v of ((run.style as unknown as { variations?: { axis: string; value: number }[] }).variations ?? [])) variations[v.axis] = v.value;
          }
        }
        return axes.map((a) => (
          <div key={a[0]} className="px-2 py-1 flex items-center gap-2">
            <span className="w-10 shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400">{axisLabel(a[0])}</span>
            <input
              type="range" min={a[1]} max={a[3]} step={a[3] - a[1] >= 10 ? 1 : 0.01}
              value={axisValue(c, a, variations)}
              onChange={(e) => apply({ variations: { [a[0]]: Number(e.target.value) } })}
              className="flex-1 accent-sky-600"
            />
          </div>
        ));
      })()}

      {/* 取色卡(渐变 stop 同款 portal 卡) */}
      {colorPick && createPortal(
        <div
          className="fixed z-[1000] w-56 rounded-md bg-[#FAFAFA]/95 dark:bg-[#3a3a3a]/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 p-2"
          style={{ left: Math.max(4, window.innerWidth / 2 - 112), top: Math.max(4, window.innerHeight / 2 - 140) }}
        >
          <div className="text-[11px] text-neutral-500 dark:text-neutral-400 mb-1">文字颜色</div>
          <div className="h-44">
            <ColorPicker
              value={colorPick.rgb}
              onCommit={(rgb) => {
                const hex = `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
                apply({ color: hex });
              }}
              label="文字颜色"
            />
          </div>
          <div className="flex justify-end mt-1.5">
            <button type="button" onClick={() => setColorPick(null)} className="px-2 py-0.5 rounded text-[11px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300">关闭</button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
};
