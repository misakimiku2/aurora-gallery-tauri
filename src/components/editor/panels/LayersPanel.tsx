/** 图层面板:混合模式/不透明度(当前层)、行(眼睛/蒙版缩略图/名称/选中)、增删复制/排列/添加蒙版。 */
import React, { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff, Plus, Copy, Trash2, ChevronUp, ChevronDown, Lock, Link2Off } from 'lucide-react';
import { runCommand, getSession, subscribeSession } from '../editorStore';
import { editorMaskSnapshot, type RenderedBitmap } from '../editorBridge';
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

/** 蒙版快照缓存(docId:layerId:revision → 位图):行内缩略图共用,revision 前移自然过期。 */
const maskThumbCache = new Map<string, RenderedBitmap>();
const MASK_THUMB_CACHE_MAX = 200;

/**
 * 蒙版缩略图(PS 口径):灰度快照(白=显示);点击=编辑蒙版 / Shift+点=停用或启用 /
 * Alt+点=灰度查看 / Ctrl+点=载入选区;禁用蒙版红叉;未链接角标(点它解链/复链)。
 */
const MaskThumb: React.FC<{
  tabId: string;
  docId: number;
  layer: EditorLayer;
  revision: number;
  info?: { enabled: boolean; linked: boolean };
  targeted: boolean;
}> = ({ tabId, docId, layer, revision, info, targeted }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const run = (cmd: string, params: Record<string, unknown> = {}) =>
    runCommand(tabId, cmd, params).catch((e) => console.error('[editor]', cmd, e));

  useEffect(() => {
    const key = `${docId}:${layer.id}:${revision}`;
    const draw = (bmp: RenderedBitmap) => {
      const cv = canvasRef.current;
      if (!cv) return;
      cv.width = bmp.width;
      cv.height = bmp.height;
      const ctx = cv.getContext('2d');
      if (!ctx) return;
      ctx.putImageData(new ImageData(bmp.rgba, bmp.width, bmp.height), 0, 0);
      if (info && !info.enabled) {
        // 禁用蒙版:PS 式红叉
        const lw = Math.max(2, cv.width / 12);
        ctx.strokeStyle = '#ff3b30';
        ctx.lineWidth = lw;
        ctx.beginPath();
        ctx.moveTo(lw / 2, lw / 2);
        ctx.lineTo(cv.width - lw / 2, cv.height - lw / 2);
        ctx.moveTo(cv.width - lw / 2, lw / 2);
        ctx.lineTo(lw / 2, cv.height - lw / 2);
        ctx.stroke();
      }
      forceUpdate((n) => n + 1);
    };
    const cached = maskThumbCache.get(key);
    if (cached) {
      draw(cached);
      return;
    }
    let cancelled = false;
    void editorMaskSnapshot(docId, layer.id, 64, 64)
      .then((bmp) => {
        if (cancelled) return;
        maskThumbCache.set(key, bmp);
        if (maskThumbCache.size > MASK_THUMB_CACHE_MAX) {
          const first = maskThumbCache.keys().next().value;
          if (first !== undefined) maskThumbCache.delete(first);
        }
        draw(bmp);
      })
      .catch((e) => console.error('[editor] 蒙版快照失败', e));
    return () => {
      cancelled = true;
    };
  }, [docId, layer.id, revision, info?.enabled]);

  const bmp = maskThumbCache.get(`${docId}:${layer.id}:${revision}`);
  const h = 18;
  const w = bmp ? Math.max(6, Math.round((bmp.width / Math.max(bmp.width, bmp.height)) * h)) : h;

  return (
    <span className="relative shrink-0 inline-flex items-center">
      <button
        onClick={(e) => {
          e.stopPropagation();
          if (e.shiftKey) {
            void run('layer.layerMask.enabled', { layer: layer.id });
            return;
          }
          if (e.altKey) {
            void run('view.layerMask', { layer: layer.id, mode: 'toggleGray' });
            return;
          }
          if (e.ctrlKey || e.metaKey) {
            void run('select.loadSelection', { channel: 'mask', layer: layer.id });
            return;
          }
          void run('layer.select', { layer: layer.id });
          void run('channel.target', { channel: 'mask' });
        }}
        title="图层蒙版(点=编辑蒙版 / Shift+点=停用或启用 / Alt+点=灰度查看 / Ctrl+点=载入选区)"
        className={`shrink-0 p-px rounded-[3px] ${targeted ? 'ring-1 ring-sky-500' : ''}`}
      >
        <canvas ref={canvasRef} style={{ width: w, height: h, imageRendering: 'pixelated' }} className="block rounded-[2px]" />
      </button>
      {info && !info.linked && (
        <button
          onClick={(e) => {
            e.stopPropagation();
            void run('layer.layerMask.linked', { layer: layer.id });
          }}
          title="蒙版未链接(点此重新链接;移动图层时蒙版不跟随)"
          className="absolute -right-1 -bottom-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
        >
          <Link2Off size={8} />
        </button>
      )}
    </span>
  );
};

const Row: React.FC<{
  tabId: string;
  layer: EditorLayer;
  depth: number;
  docId: number;
  revision: number;
  maskInfo?: Record<string, { enabled: boolean; linked: boolean }>;
  maskTargeted: boolean;
}> = ({ tabId, layer, depth, docId, revision, maskInfo, maskTargeted }) => {
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
      {layer.hasMask && (
        <MaskThumb
          tabId={tabId}
          docId={docId}
          layer={layer}
          revision={revision}
          info={maskInfo?.[String(layer.id)]}
          targeted={maskTargeted && layer.selected}
        />
      )}
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

/** 添加蒙版图标(PS 口径:实心圆点矩形)。 */
const AddMaskIcon: React.FC<{ size?: number }> = ({ size = 14 }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden>
    <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
    <circle cx="8" cy="8" r="3" fill="currentColor" />
  </svg>
);

export const LayersPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);

  const run = (cmd: string, params: Record<string, unknown> = {}) =>
    runCommand(tabId, cmd, params).catch((e) => console.error('[editor]', cmd, e));

  if (!s || !s.state) return <div className="px-2 py-1.5 text-[11px] text-gray-500 dark:text-neutral-400">图层</div>;
  const st = s.state;
  const active = st.layers.find((l) => l.id === st.activeLayer) ?? null;
  const maskTargeted = st.channels?.target?.kind === 'layerMask';

  // 添加蒙版(上游 add_mask_command 口径:永不替换已有蒙版;有选区→从选区显露,Alt→隐藏)
  const addMask = (alt: boolean) => {
    if (!active || active.hasMask) return;
    const cmd = st.hasSelection
      ? alt ? 'layer.layerMask.hideSelection' : 'layer.layerMask.revealSelection'
      : alt ? 'layer.layerMask.hideAll' : 'layer.layerMask.revealAll';
    void run(cmd, { layer: active.id });
  };

  const renderRows = (layers: EditorLayer[], depth = 0): React.ReactNode =>
    layers.map((l) => (
      <React.Fragment key={l.id}>
        <Row
          tabId={tabId}
          layer={l}
          depth={depth}
          docId={s.docId ?? 0}
          revision={s.revision}
          maskInfo={st.maskInfo}
          maskTargeted={maskTargeted}
        />
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
        <button
          title={active?.hasMask ? '已有图层蒙版' : st.hasSelection ? '添加蒙版(从选区显露;Alt=从选区隐藏)' : '添加蒙版(全部显露;Alt=全部隐藏)'}
          disabled={!active || active.hasMask}
          onClick={(e) => addMask(e.altKey)}
          className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 disabled:opacity-30"
        >
          <AddMaskIcon size={14} />
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
        {/* 删除(用户拍板口径:单入口,蒙版优先——带蒙版先删蒙版,再按才删图层) */}
        <button
          title={active?.hasMask ? '删除图层蒙版(再按一次删除图层)' : '删除图层'}
          disabled={!active}
          onClick={() => {
            if (!active) return;
            if (active.hasMask) void run('layer.layerMask.delete', { layer: active.id });
            else void run('layer.delete', { layer: active.id });
          }}
          className="p-1 text-gray-500 dark:text-neutral-400 hover:text-red-400 disabled:opacity-30"
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
};
