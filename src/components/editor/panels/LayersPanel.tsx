/** 图层面板:混合模式/不透明度(当前层)、行(眼睛/名称/蒙版标记/选中)、增删复制/排列。 */
import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Plus, Copy, Trash2, ChevronUp, ChevronDown, Lock } from 'lucide-react';
import { runCommand, getSession, subscribeSession } from '../editorStore';
import type { EditorLayer } from '../editorTypes';

/** 引擎英文标签 → 中文(混合模式,PS 中文版口径)。 */
const BLEND_ZH: Record<string, string> = {
  'Pass Through': '穿透', 'Normal': '正常', 'Dissolve': '溶解', 'Darken': '变暗', 'Multiply': '正片叠底',
  'Color Burn': '颜色加深', 'Linear Burn': '线性加深', 'Darker Color': '深色', 'Lighten': '变亮', 'Screen': '滤色',
  'Color Dodge': '颜色减淡', 'Linear Dodge': '线性减淡', 'Lighter Color': '浅色', 'Overlay': '叠加', 'Soft Light': '柔光',
  'Hard Light': '强光', 'Vivid Light': '亮光', 'Linear Light': '线性光', 'Pin Light': '点光', 'Hard Mix': '实色混合',
  'Difference': '差值', 'Exclusion': '排除', 'Subtract': '减去', 'Divide': '划分', 'Hue': '色相',
  'Saturation': '饱和度', 'Color': '颜色', 'Luminosity': '明度', 'Reflect': '反射', 'Glow': '发光',
  'Negation': '否定', 'Xor': '异或',
};
/** 图层类型 kind_name → 中文。 */
const KIND_ZH: Record<string, string> = {
  Pixel: '像素', Group: '编组', Adjustment: '调整', Fill: '填充', Type: '文字', Shape: '形状', 'Smart Object': '智能对象',
};

const Row: React.FC<{
  tabId: string;
  layer: EditorLayer;
  depth: number;
}> = ({ tabId, layer, depth }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(layer.name);

  const run = (cmd: string, params: Record<string, unknown> = {}) =>
    runCommand(tabId, cmd, params).catch((e) => console.error('[editor]', cmd, e));

  return (
    <div
      onClick={() => void run('layer.select', { layer: layer.id })}
      className={`group flex items-center gap-1.5 px-1.5 h-7 rounded cursor-default text-xs ${
        layer.selected ? 'bg-sky-600/25 text-neutral-900 dark:text-neutral-100' : 'text-gray-700 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10'
      }`}
      style={{ paddingLeft: 6 + depth * 12 }}
    >
      <button
        onClick={(e) => {
          e.stopPropagation();
          void run('layer.setProps', { layer: layer.id, visible: !layer.visible });
        }}
        className={`shrink-0 ${layer.visible ? 'text-gray-700 dark:text-neutral-300' : 'text-gray-400 dark:text-neutral-600'}`}
        title={layer.visible ? '隐藏图层' : '显示图层'}
      >
        {layer.visible ? <Eye size={13} /> : <EyeOff size={13} />}
      </button>
      {layer.hasMask && <span className="shrink-0 text-[9px] text-gray-500 dark:text-neutral-400 border border-black/20 dark:border-neutral-600 rounded-sm px-0.5" title="图层蒙版">蒙</span>}
      {layer.clipped && <span className="shrink-0 text-[9px] text-gray-500 dark:text-neutral-400" title="剪贴蒙版">↳</span>}
      {editing ? (
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === 'Enter') {
              void run('layer.setProps', { layer: layer.id, name });
              setEditing(false);
            }
            if (e.key === 'Escape') {
              setName(layer.name);
              setEditing(false);
            }
          }}
          onBlur={() => {
            if (name !== layer.name) void run('layer.setProps', { layer: layer.id, name });
            setEditing(false);
          }}
          className="flex-1 min-w-0 bg-surface border border-sky-500 rounded px-1 text-xs"
        />
      ) : (
        <span
          className="flex-1 truncate"
          onDoubleClick={(e) => {
            e.stopPropagation();
            setName(layer.name);
            setEditing(true);
          }}
          title={layer.name}
        >
          {layer.name}
        </span>
      )}
      <span className="shrink-0 text-[9px] text-gray-400 dark:text-neutral-600 uppercase">{KIND_ZH[layer.kind] ?? layer.kind}</span>
      <span className="shrink-0 text-[9px] text-gray-400 dark:text-neutral-600">{Math.round(layer.opacity * 100)}%</span>
    </div>
  );
};

export const LayersPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);

  const run = (cmd: string, params: Record<string, unknown> = {}) =>
    runCommand(tabId, cmd, params).catch((e) => console.error('[editor]', cmd, e));

  if (!s || !s.state) return <div className="px-2 py-1.5 text-[11px] text-gray-500 dark:text-neutral-400">图层</div>;
  const st = s.state;
  const active = st.layers.find((l) => l.id === st.activeLayer) ?? null;

  const renderRows = (layers: EditorLayer[], depth = 0): React.ReactNode =>
    layers.map((l) => (
      <React.Fragment key={l.id}>
        <Row tabId={tabId} layer={l} depth={depth} />
        {l.children && l.expanded !== false && renderRows(l.children, depth + 1)}
      </React.Fragment>
    ));

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="px-2 py-1 text-[11px] text-gray-500 dark:text-neutral-400 shrink-0">图层</div>
      {/* 混合模式(当前层) */}
      <div className="px-2 pb-1 shrink-0">
        <select
          value={active?.blend ?? 'Normal'}
          disabled={!active}
          onChange={(e) => active && void run('layer.setProps', { layer: active.id, blend: e.target.value })}
          className="w-full bg-surface border border-black/10 dark:border-white/15 rounded px-1 py-0.5 text-[11px] text-gray-800 dark:text-neutral-200"
        >
          {(st.blendModes ?? ['Normal']).map((b) => (
            <option key={b} value={b}>{BLEND_ZH[b] ?? b}</option>
          ))}
        </select>
      </div>
      {/* 不透明度(当前层) */}
      <div className="flex items-center gap-1.5 px-2 pb-1.5 shrink-0">
        <span className="text-[10px] text-gray-500 dark:text-neutral-400 shrink-0">不透明度</span>
        <input
          type="range"
          min={0}
          max={100}
          value={Math.round((active?.opacity ?? 1) * 100)}
          disabled={!active}
          onChange={(e) => active && void run('layer.setProps', { layer: active.id, opacity: Number(e.target.value) / 100 })}
          className="flex-1 min-w-0 accent-sky-500"
        />
        <span className="text-[10px] text-gray-500 dark:text-neutral-400 w-8 text-right tabular-nums">{Math.round((active?.opacity ?? 1) * 100)}%</span>
      </div>
      {/* 行列表 */}
      <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-1 space-y-px">{renderRows(st.layers)}</div>
      {/* 页脚按钮 */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-t border-black/10 dark:border-white/10 shrink-0">
        <button title="新建图层" onClick={() => void run('layer.new.layer', {})} className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100">
          <Plus size={14} />
        </button>
        <button title="复制图层" disabled={!active} onClick={() => active && void run('layer.duplicate', { layer: active.id })} className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-30">
          <Copy size={14} />
        </button>
        <button title="上移一层" disabled={!active} onClick={() => active && void run('layer.arrange.bringForward', { layer: active.id })} className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-30">
          <ChevronUp size={14} />
        </button>
        <button title="下移一层" disabled={!active} onClick={() => active && void run('layer.arrange.sendBackward', { layer: active.id })} className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-30">
          <ChevronDown size={14} />
        </button>
        <div className="flex-1" />
        <button title="锁定透明像素" disabled={!active} onClick={() => active && void run('layer.toggleLockTransparency', { layer: active.id })} className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-30">
          <Lock size={14} />
        </button>
        <button title="删除图层" disabled={!active} onClick={() => active && void run('layer.delete', { layer: active.id })} className="p-1 text-gray-500 dark:text-neutral-400 hover:text-red-400 disabled:opacity-30">
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
};
