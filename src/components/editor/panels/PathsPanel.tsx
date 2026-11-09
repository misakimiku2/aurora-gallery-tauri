/**
 * 路径面板(二期 二-4,上游 vector_ui.rs paths_panel 段逐行移植):
 * 行列表(已存路径 → 工作路径 → 活动层形状路径/矢量蒙版,后两者斜体)+ 文档比例缩略图 +
 * 单击选中 / Ctrl+点缩略图=载入选区(Shift/Alt 运算)/ 双击重命名(工作路径双击=弹存名,#6238)/
 * 右键菜单(建立选区/填充/描边/存储或复制/重命名/删除)+ 底部七按钮 + 行拖到垃圾桶删除(#6553)。
 * 描边/建立选区走会话级对话框(Enter/Esc 由画布键盘接管,同 shapeDialog 模式)。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { editorRun } from '../editorBridge';
import {
  confirmPathsDialog, closePathsDialog, getSession, openPathsDialog, runCommand,
  showEditorNotice, subscribeSession, updatePathsDialog, updateSession, PATH_STROKE_TOOLS,
} from '../editorStore';
import { freePathName, pathContextActions, pathRows, panelTargetPath, type PathMenuAction, type PathRow } from '../pathsPanelLogic';
import { pathLines, type EnginePathJson } from '../penLogic';
import { EditorIcon, type EditorIconName } from '../editorIcons';
import { EditorSelect } from '../editorSelect';

/** 行几何缓存:docId:key:revision → path.info 的完整几何(缩略图与复制路径用)。 */
const geoCache = new Map<string, EnginePathJson>();
const GEO_CACHE_MAX = 200;
function geoCachePut(key: string, geo: EnginePathJson): void {
  geoCache.set(key, geo);
  if (geoCache.size > GEO_CACHE_MAX) {
    const first = geoCache.keys().next().value;
    if (first !== undefined) geoCache.delete(first);
  }
}

/** 供画布续画取选中路径的缓存几何(面板缩略图拉取时填充;缺失=不续画,画新路径)。 */
export function getCachedPathGeo(docId: number, key: string, rev: number): EnginePathJson | null {
  return geoCache.get(`${docId}:${key}:${rev}`) ?? null;
}

/** 行的删除命令(拖到垃圾桶与右键删除共用;上游 delete 映射)。层形状路径不可拖。 */
function rowDeleteAction(row: PathRow, layerId: number | null): { cmd: string; params: Record<string, unknown> } | null {
  if (row.kind === 'work') return { cmd: 'path.delete', params: { name: 'work' } };
  if (row.kind === 'saved') return { cmd: 'path.delete', params: { name: row.name } };
  if (row.name.endsWith('矢量蒙版')) return { cmd: 'layer.vectorMask.delete', params: {} };
  // 形状层的路径即形状:删除路径=删除图层(上游 #6552)
  return layerId != null ? { cmd: 'layer.delete', params: { layer: layerId } } : null;
}

/** 文档比例缩略图(上游 thumb:28×28 内按文档长宽比居中适配,路径线深灰)。 */
const PathThumb: React.FC<{
  geo: EnginePathJson | null;
  docW: number;
  docH: number;
  dark: boolean;
}> = ({ geo, docW, docH, dark }) => {
  const ref = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const cv = ref.current;
    if (!cv) return;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const S = 28;
    cv.width = S * dpr;
    cv.height = S * dpr;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, S, S);
    ctx.fillStyle = dark ? '#dedede' : '#f0f0f0';
    ctx.fillRect(0, 0, S, S);
    if (!geo || docW < 1 || docH < 1) return;
    // 等比适配进 28×28(上游 channels_panel::fit_thumb 的居中适配)
    const scale = Math.min(S / docW, S / docH);
    const ox = S / 2 - (docW * scale) / 2;
    const oy = S / 2 - (docH * scale) / 2;
    const map = (q: [number, number]): [number, number] => [ox + q[0] * scale, oy + q[1] * scale];
    ctx.strokeStyle = '#282828';
    ctx.lineWidth = 1;
    ctx.lineJoin = 'round';
    for (const { pts, closed } of pathLines(geo, map)) {
      if (pts.length < 2) continue;
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
      if (closed) ctx.closePath();
      ctx.stroke();
    }
  }, [geo, docW, docH, dark]);
  return <canvas ref={ref} style={{ width: 28, height: 28 }} className="block rounded-[2px]" />;
};

/** 行右键菜单(样式与图层右键菜单同一设计语言;上游 path_context_actions 顺序)。 */
const PathContextMenu: React.FC<{
  tabId: string;
  row: PathRow;
  layerId: number | null;
  canPaint: boolean;
  rowPathJson: EnginePathJson | null;
  existingNames: string[];
  pos: { x: number; y: number };
  onClose: () => void;
  onRename: () => void;
}> = ({ tabId, row, layerId, canPaint, rowPathJson, existingNames, pos, onClose, onRename }) => {
  const run = (cmd: string, params: Record<string, unknown>, label: string) =>
    runCommand(tabId, cmd, params).catch((e) => showEditorNotice(`${label}失败:${e instanceof Error ? e.message : String(e)}`));
  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const close = () => onClose();
    window.addEventListener('mousedown', close);
    window.addEventListener('blur', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('blur', close);
    };
  }, [onClose]);
  // 按实际尺寸钳进视口(图层右键菜单同款;渲染期估算会被实际高度溢出)
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(pos.x, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(pos.y, window.innerHeight - r.height - 4))}px`;
  }, [pos.x, pos.y]);

  const actions = pathContextActions(row, existingNames, rowPathJson, canPaint);
  const act = (a: PathMenuAction) => {
    if (a.kind === 'selection') {
      openPathsDialog(tabId, { kind: 'selection', name: row.key });
    } else if (a.kind === 'stroke') {
      openPathsDialog(tabId, { kind: 'stroke', name: row.key });
    } else if (a.kind === 'fill') {
      void run('path.fill', { name: row.key }, a.label);
    } else if (a.kind === 'rename') {
      onRename();
    } else if (a.kind === 'cmd') {
      void run(a.cmd, a.params, a.label);
    } else if (a.kind === 'delete') {
      const del = rowDeleteAction(row, layerId);
      if (del) void run(del.cmd, del.params, a.label);
    }
  };
  const itemCls = 'mx-1.5 px-3 py-1.5 rounded hover:bg-blue-600 hover:text-white cursor-pointer whitespace-nowrap text-[12px] disabled:opacity-40 disabled:pointer-events-none';
  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-[1000] rounded-md bg-[#FAFAFA]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 py-1.5 w-max"
      style={{ left: 0, top: 0 }}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      {actions.map((a) => (
        <button
          key={a.label}
          disabled={'disabled' in a && !!a.disabled}
          className={`${itemCls} block w-full text-left`}
          onClick={() => { act(a); onClose(); }}
        >
          {a.label}
        </button>
      ))}
    </div>,
    document.body,
  );
};

/** 描边路径/建立选区对话框(上游 stroke_path_dialog + pen_dialog 的 path.toSelection spec;
 * Enter/Esc 由画布键盘接管,此处输入框内回车也提交)。 */
const PathsDialog: React.FC<{ tabId: string }> = ({ tabId }) => {
  const s = getSession(tabId);
  const dlg = s?.pathsDialog;
  const firstRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (dlg?.kind === 'selection') firstRef.current?.select();
  }, [dlg?.kind]);
  if (!s || !dlg) return null;
  const field = 'w-28 px-2 py-1 text-sm rounded-md border border-subtle bg-panel text-gray-800 dark:text-gray-200 outline-none focus:border-sky-500';
  const label = 'w-20 text-right text-xs text-gray-500 dark:text-neutral-400';
  const title = dlg.kind === 'stroke' ? '描边路径' : '建立选区';
  return createPortal(
    <div className="fixed inset-0 z-[600] flex items-center justify-center p-4" onKeyDown={(e) => {
      if (e.key === 'Enter' && e.target instanceof HTMLInputElement) {
        e.preventDefault();
        void confirmPathsDialog(tabId);
      }
    }}>
      <div className="absolute inset-0 bg-black/30" onClick={() => closePathsDialog(tabId)} />
      <div className="relative w-72 rounded-lg bg-surface border border-black/10 dark:border-white/15 shadow-xl p-4 select-none">
        <div className="text-sm font-medium text-gray-800 dark:text-gray-100 mb-3">{title}</div>
        <div className="space-y-2.5">
          {dlg.kind === 'stroke' ? (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>工具</span>
                <EditorSelect
                  value={dlg.tool}
                  onChange={(v) => updatePathsDialog(tabId, { tool: v })}
                  className="w-28"
                  options={PATH_STROKE_TOOLS.map((t) => ({ value: t.id, label: t.label }))}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>模拟压力</span>
                <input
                  type="checkbox"
                  checked={dlg.simulatePressure}
                  className="w-4 h-4 accent-sky-600"
                  onChange={(e) => updatePathsDialog(tabId, { simulatePressure: e.target.checked })}
                />
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>羽化(px)</span>
                <input
                  ref={firstRef}
                  type="number"
                  min={0}
                  max={250}
                  className={field}
                  value={dlg.feather}
                  onChange={(e) => {
                    const n = Number.parseFloat(e.target.value);
                    updatePathsDialog(tabId, { feather: Number.isFinite(n) ? Math.min(250, Math.max(0, n)) : 0 });
                  }}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>消除锯齿</span>
                <input
                  type="checkbox"
                  checked={dlg.antiAlias}
                  className="w-4 h-4 accent-sky-600"
                  onChange={(e) => updatePathsDialog(tabId, { antiAlias: e.target.checked })}
                />
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className={label}>操作</span>
                <EditorSelect
                  value={dlg.mode}
                  onChange={(v) => updatePathsDialog(tabId, { mode: v as typeof dlg.mode })}
                  className="w-28"
                  options={[
                    { value: 'replace', label: '新选区' },
                    { value: 'add', label: '添加到选区' },
                    { value: 'subtract', label: '从选区减去' },
                    { value: 'intersect', label: '与选区交叉' },
                  ]}
                />
              </div>
            </>
          )}
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={() => closePathsDialog(tabId)}
            className="px-3 py-1.5 text-xs rounded-md border border-subtle text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/10">取消</button>
          <button onClick={() => void confirmPathsDialog(tabId)}
            className="px-3 py-1.5 text-xs rounded-md bg-sky-600 text-white hover:bg-sky-500">确定</button>
        </div>
      </div>
    </div>,
    document.body,
  );
};

const PATH_FOOTER_TIPS: Record<string, string> = {
  fill: '用前景色填充路径',
  stroke: '用画笔描边路径(Alt=对话框)',
  load: '将路径作为选区载入',
  work: '从选区建立工作路径',
  mask: '添加矢量蒙版',
  new: '创建新路径',
  trash: '删除路径',
};

interface DragState { name: string; cmd: string; params: Record<string, unknown>; x: number; y: number; }

export const PathsPanel: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  const st = s?.state ?? null;
  const rows = s ? pathRows(s.pathsList) : [];
  const rowsSig = `${s?.docId ?? ''}:${s?.revision ?? 0}:${rows.map((r) => r.key).join('|')}`;

  // 行几何的异步回填:行集(含 revision)变化后逐行拉 path.info(缩略图/复制路径用)
  useEffect(() => {
    const s2 = getSession(tabId);
    if (!s2?.docId || !s2.pathsList) return;
    const docId = s2.docId;
    const rev = s2.revision;
    const list = pathRows(s2.pathsList);
    let cancelled = false;
    void (async () => {
      let fetched = false;
      for (const row of list) {
        const key = `${docId}:${row.key}:${rev}`;
        if (geoCache.has(key)) continue;
        try {
          const r = await editorRun(docId, 'path.info', { name: row.key });
          const geo = (r.result as { path?: EnginePathJson } | null)?.path ?? null;
          if (geo) {
            geoCachePut(key, geo);
            fetched = true;
          }
        } catch {
          // 行几何拉不到(如层行无路径)=缩略图留灰底
        }
        if (cancelled) return;
      }
      if (fetched) forceUpdate((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [tabId, rowsSig]);

  // path.list 摘要由画布常驻 effect 刷新(路径页签不挂载时也要新鲜——选项条按钮/Ctrl+Enter 吃它)

  const [renaming, setRenaming] = useState<{ key: string; text: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; row: PathRow } | null>(null);
  // 行拖到垃圾桶(#6553):按下记录起点,移动超阈值成拖拽,松在垃圾桶上=删除
  const [drag, setDrag] = useState<DragState | null>(null);
  const pendingDrag = useRef<{ x: number; y: number; row: PathRow } | null>(null);
  const suppressClick = useRef(false);
  const trashRef = useRef<HTMLButtonElement | null>(null);

  if (!s || !st) return <div className="px-2 py-1.5 text-[11px] text-gray-500 dark:text-neutral-400">路径</div>;
  const sel = panelTargetPath(rows, s.selectedPath);
  const dark = document.documentElement.classList.contains('dark');
  const docW = st.width || 1;
  const docH = st.height || 1;
  const active = st.layers.find((l) => l.id === st.activeLayer) ?? null;
  const canPaint = active?.kind === 'Pixel';
  const existingNames = s.pathsList?.paths.map((p) => p.name) ?? [];
  const layerId = s.pathsList?.layerPath?.layer ?? null;

  const run = (cmd: string, params: Record<string, unknown>, label: string) =>
    runCommand(tabId, cmd, params).catch((e) => showEditorNotice(`${label}失败:${e instanceof Error ? e.message : String(e)}`));

  // 前景色 hex(footer 填充用;引擎 inspect 的 foreground 是 0..1 浮点)
  const byte = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0');
  const fgHex = `#${byte(st.foreground[0] ?? 0)}${byte(st.foreground[1] ?? 0)}${byte(st.foreground[2] ?? 0)}`;

  // 画笔族描边的"当前选项"(引擎会话 tools 不镜像我们的选项条,显式传参=同款"当前选项")
  const brushStrokeParams = (): Record<string, unknown> => ({
    size: s.options.brushSize,
    hardness: s.options.brushHardness,
    opacity: Math.round(s.options.brushOpacity * 100),
  });

  // 垃圾桶动作(选中目标的删除;上游 footer 的 delete_layer_path 分支:层矢量蒙版=删蒙版,
  // 层形状路径保持 path.delete——上游原样,引擎报"no path named layer"即显示为提示)
  const shapeRowSelected = rows.some((r) => r.kind === 'layer' && !r.name.endsWith('矢量蒙版'));
  const trashAction = sel === 'layer' && !shapeRowSelected
    ? { cmd: 'layer.vectorMask.delete', params: {} as Record<string, unknown> }
    : { cmd: 'path.delete', params: { name: sel } };

  /** 行内重命名提交(上游 rename 字段口径:工作路径按建议名提交即存储;已存路径名未变不动;
   * 成功后该路径保持为面板目标)。 */
  const commitRename = () => {
    const r = renaming;
    if (!r) return;
    setRenaming(null);
    const row = rows.find((x) => x.key === r.key);
    const to = r.text.trim();
    if (!row || !to || (row.kind !== 'work' && to === row.name)) return;
    runCommand(tabId, 'path.rename', { name: r.key, to })
      .then(() => updateSession(tabId, { selectedPath: to }))
      .catch((e) => showEditorNotice(`重命名路径失败:${e instanceof Error ? e.message : String(e)}`));
  };

  const startDragWatch = (e: React.PointerEvent, row: PathRow) => {
    if (!row.deletable) return;
    const rowEl = e.currentTarget as HTMLElement;
    pendingDrag.current = { x: e.clientX, y: e.clientY, row };
    let started: DragState | null = null;
    const move = (ev: PointerEvent) => {
      const p = pendingDrag.current;
      if (!p) return;
      if (!started && Math.hypot(ev.clientX - p.x, ev.clientY - p.y) > 4) {
        const del = rowDeleteAction(p.row, layerId);
        if (!del) return;
        started = { name: p.row.name, cmd: del.cmd, params: del.params, x: ev.clientX, y: ev.clientY };
        setDrag(started);
        return;
      }
      if (started) {
        started.x = ev.clientX;
        started.y = ev.clientY;
        setDrag({ ...started });
      }
    };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      pendingDrag.current = null;
      if (started) {
        // 抬起仍落在原行内才抑制紧随的 click(行上小拖拽);拖到垃圾桶等行外释放时
        // click 事件本就不落在行上,置位会吞掉下一次无关行点击
        const r = rowEl.getBoundingClientRect();
        if (ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom) {
          suppressClick.current = true;
        }
        const rect = trashRef.current?.getBoundingClientRect();
        if (rect && ev.clientX >= rect.left && ev.clientX <= rect.right && ev.clientY >= rect.top && ev.clientY <= rect.bottom) {
          void run(started.cmd, started.params, '删除路径');
        }
        setDrag(null);
      }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // 底部七按钮(上游 items 顺序:视觉 L→R = 填充/描边/载入选区/建工作路径/矢量蒙版/新建/删除)
  const footerButtons: { icon: EditorIconName; key: string; cmd?: string; params?: Record<string, unknown> }[] = [
    { icon: 'paint-bucket', key: 'fill', cmd: 'path.fill', params: { name: sel, color: fgHex } },
    { icon: 'circle', key: 'stroke' },
    { icon: 'square-dashed', key: 'load', cmd: 'path.toSelection', params: { name: sel } },
    { icon: 'spline', key: 'work', cmd: 'select.toWorkPath', params: { tolerance: 2.0 } },
    { icon: 'square', key: 'mask', cmd: 'layer.vectorMask.fromPath', params: { name: sel } },
    { icon: 'square-plus', key: 'new', cmd: 'path.set', params: { name: freePathName(existingNames), path: { subpaths: [] } } },
    { icon: 'trash', key: 'trash', cmd: trashAction.cmd, params: trashAction.params },
  ];

  return (
    <div className="flex flex-col min-h-0 flex-1">
      <div className="flex-1 min-h-0 overflow-y-auto px-1 pb-1 flex flex-col">
        {rows.length === 0 && (
          <div className="px-1.5 py-1.5 text-[11px] leading-snug text-gray-500 dark:text-neutral-400 shrink-0">
            用钢笔工具(P)作画,或从选区建立工作路径。
          </div>
        )}
        {rows.map((row) => {
          const geo = geoCache.get(`${s.docId}:${row.key}:${s.revision}`) ?? null;
          const selected = s.selectedPath === row.key;
          const proposed = row.kind === 'work' ? freePathName(existingNames) : row.kind === 'saved' ? row.name : null;
          return (
            <div
              key={row.key}
              className={`relative flex items-center gap-2 h-9 px-1.5 rounded cursor-default text-xs select-none shrink-0 ${
                selected ? 'bg-sky-600/25 text-neutral-900 dark:text-neutral-100' : 'text-gray-700 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10'
              } border-b border-black/5 dark:border-white/5`}
              title={row.kind === 'layer' ? '活动层的形状路径/矢量蒙版(临时)' : undefined}
              onPointerDown={(e) => startDragWatch(e, row)}
              onClick={() => {
                if (suppressClick.current) {
                  suppressClick.current = false;
                  return;
                }
                updateSession(tabId, { selectedPath: row.key });
              }}
              onDoubleClick={() => {
                // 已存路径双击=重命名;工作路径双击=弹存名(上游 #6238);层行不重命名
                if (proposed != null && renaming?.key !== row.key) setRenaming({ key: row.key, text: proposed });
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setMenu({ x: e.clientX, y: e.clientY, row });
              }}
            >
              <button
                className="shrink-0 rounded-[2px] overflow-hidden"
                title="Ctrl+点=将路径作为选区载入(Shift=添加 / Alt=减去 / Shift+Alt=交叉)"
                onDoubleClick={(e) => e.stopPropagation()}
                onClick={(e) => {
                  // Ctrl/Cmd+点缩略图=只把该路径载入选区,不改面板目标(上游 load 分支)
                  if (!(e.ctrlKey || e.metaKey)) return;
                  e.stopPropagation();
                  const mode = e.shiftKey && e.altKey ? 'intersect' : e.altKey ? 'subtract' : e.shiftKey ? 'add' : 'replace';
                  void run('path.toSelection', { name: row.key, mode }, '建立选区');
                }}
              >
                <PathThumb geo={geo} docW={docW} docH={docH} dark={dark} />
              </button>
              {renaming?.key === row.key ? (
                <input
                  autoFocus
                  value={renaming.text}
                  onChange={(e) => setRenaming({ key: row.key, text: e.target.value })}
                  onClick={(e) => e.stopPropagation()}
                  onPointerDown={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    e.stopPropagation();
                    if (e.key === 'Enter') commitRename();
                    if (e.key === 'Escape') setRenaming(null);
                  }}
                  onBlur={commitRename}
                  onFocus={(e) => e.target.select()}
                  className="flex-1 min-w-0 bg-surface border border-sky-500 rounded px-1 text-xs"
                />
              ) : (
                <span className={`flex-1 truncate ${row.kind !== 'saved' ? 'italic' : ''}`} title={row.name}>
                  {row.name}
                </span>
              )}
            </div>
          );
        })}
        {/* 点空处取消选中(上游 #1419:新建填充/调整层随后以选区为蒙版) */}
        <div className="flex-1 min-h-[24px]" onClick={() => updateSession(tabId, { selectedPath: null })} />
      </div>
      {/* 页脚七按钮 */}
      <div className="flex items-center gap-0.5 px-2 py-1 border-t border-black/10 dark:border-white/10 shrink-0">
        {footerButtons.map((b) => (
          <button
            key={b.key}
            ref={b.key === 'trash' ? trashRef : undefined}
            title={PATH_FOOTER_TIPS[b.key]}
            onClick={(e) => {
              if (b.key === 'stroke') {
                if (e.altKey) {
                  // Alt 点描边=对话框(上游 #2978 同款入口)
                  openPathsDialog(tabId, { kind: 'stroke', name: sel });
                } else {
                  void run('path.stroke', { name: sel, tool: 'brush', ...brushStrokeParams() }, '描边路径');
                }
                return;
              }
              if (b.cmd) void run(b.cmd, b.params ?? {}, PATH_FOOTER_TIPS[b.key]);
            }}
            className="p-1 text-gray-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100"
          >
            <EditorIcon name={b.icon} size={14} />
          </button>
        ))}
      </div>
      {menu && (
        <PathContextMenu
          tabId={tabId}
          row={menu.row}
          layerId={layerId}
          canPaint={canPaint}
          rowPathJson={geoCache.get(`${s.docId}:${menu.row.key}:${s.revision}`) ?? null}
          existingNames={existingNames}
          pos={{ x: menu.x, y: menu.y }}
          onClose={() => setMenu(null)}
          onRename={() => {
            const proposed = menu.row.kind === 'work' ? freePathName(existingNames) : menu.row.name;
            setRenaming({ key: menu.row.key, text: proposed });
          }}
        />
      )}
      {drag && createPortal(
        <div
          className="fixed z-[1100] pointer-events-none px-2 py-1 rounded bg-[#FAFAFA]/95 dark:bg-[#3a3a3a]/95 shadow-lg text-[11px] text-gray-800 dark:text-gray-200"
          style={{ left: drag.x + 10, top: drag.y + 8 }}
        >
          {drag.name}
        </div>,
        document.body,
      )}
      <PathsDialog tabId={tabId} />
    </div>
  );
};
