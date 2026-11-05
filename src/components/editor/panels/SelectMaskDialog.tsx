/**
 * Select and Mask(选择并遮住)对话框(上游 filter_dialog + select_mask_view::controls 口径):
 * 视图区(七视图 select + 每视图不透明度 + Show Edge/Show Original)= 对话框打开期间画布的
 * 显示方式(位图泵按参数键拉 editorSelectMaskView);全局精修参数(半径/智能半径/平滑/羽化/
 * 对比度/移置边缘);边刷(R 切换,画布涂抹处=精修发生处,Alt 反向,[ ] 调径,可清除);
 * 去污色 + 数量;输出目标;采样所有图层。确定=一条 select.refineEdge
 * (一步 "Select and Mask");取消=丢弃(预览零改动)。键盘(F/O/M/V/A/T/K/Y/J/P/X/R/[ ]/Enter/Esc)
 * 由画布全局键处理;对话框不做首字段聚焦(上游同款,键盘留给视图)。
 * 输出暂缺「新建文档」两项目标(我们的多标签文档模型未接会话内新文档,待办)。
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  closeSelectMask, confirmSelectMask, getSession, SELECT_MASK_MODES, SELECT_MASK_MODE_ZH,
  SELECT_MASK_OUTPUTS, SELECT_MASK_OUTPUT_ZH, selectMaskDefaultOpacity, showEditorNotice, subscribeSession, updateSelectMask,
  type SelectMaskMode,
} from '../editorStore';
import { EditorSelect } from '../editorSelect';

const numCls = 'w-14 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] tabular-nums text-neutral-700 dark:text-neutral-300';
const labelCls = 'text-neutral-500 dark:text-neutral-400 shrink-0';
const sectionCls = 'text-[10px] font-medium text-neutral-500 dark:text-neutral-400 mt-1';
const sliderCls = 'flex-1 accent-sky-600 min-w-0';

/** 滑杆 + 数值框(同步;拖动即提交=预览跟随,泵按参数键合并重算)。 */
const Slider: React.FC<{
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  suffix?: string;
  onChange: (v: number) => void;
}> = ({ label, value, min, max, step = 1, suffix, onChange }) => (
  <label className="flex items-center gap-1.5">
    <span className={`${labelCls} w-14`}>{label}</span>
    <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} className={sliderCls} />
    <input
      type="number" min={min} max={max} step={step} value={value}
      onChange={(e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) onChange(Math.min(max, Math.max(min, v)));
      }}
      className={numCls}
    />
    {suffix ? <span className="text-[10px] text-neutral-500 dark:text-neutral-400 w-4">{suffix}</span> : null}
  </label>
);

// 对话框位置持久化(localStorage;跨编辑器会话/软件重启保留,用户拍板)
const SM_POS_KEY = 'aurora-editor:select-mask-pos';
function loadSelectMaskPos(): { x: number; y: number } | null {
  try {
    const p = JSON.parse(localStorage.getItem(SM_POS_KEY) ?? 'null') as { x: number; y: number } | null;
    return p && typeof p.x === 'number' && typeof p.y === 'number' ? p : null;
  } catch {
    return null;
  }
}
function saveSelectMaskPos(p: { x: number; y: number }): void {
  try {
    localStorage.setItem(SM_POS_KEY, JSON.stringify(p));
  } catch {
    /* 存储不可用忽略 */
  }
}
const clampPos = (p: { x: number; y: number }): { x: number; y: number } => ({
  x: Math.min(Math.max(p.x, 4), window.innerWidth - 384),
  y: Math.min(Math.max(p.y, 4), window.innerHeight - 120),
});

export const SelectMaskDialog: React.FC<{ tabId: string; active: boolean }> = ({ tabId, active }) => {
  const [, forceUpdate] = useState(0);
  React.useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  // 标题栏拖拽(null=未定位;位置持久化到 localStorage,首次打开居中于编辑器画布)
  const cardRef = React.useRef<HTMLDivElement>(null);
  const dragRef = React.useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(loadSelectMaskPos);
  const s = getSession(tabId);
  const sm = s?.selectMask;
  // 每次打开:已有位置钳进视口(窗口缩放后可能出屏);没有则居中于编辑器画布(data-editor-canvas)
  React.useLayoutEffect(() => {
    if (!sm?.open) return;
    setPos((p) => {
      if (p) return clampPos(p);
      const cv = document.querySelector('[data-editor-canvas]');
      const card = cardRef.current;
      if (!cv || !card) return null;
      const cr = cv.getBoundingClientRect();
      const kr = card.getBoundingClientRect();
      return clampPos({
        x: Math.round(cr.left + cr.width / 2 - kr.width / 2),
        y: Math.round(cr.top + cr.height / 2 - kr.height / 2),
      });
    });
  }, [sm?.open]);
  const onTitlePointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    const r = cardRef.current?.getBoundingClientRect();
    if (!r) return;
    const base = pos ?? { x: r.left, y: r.top };
    setPos(base);
    dragRef.current = { sx: e.clientX, sy: e.clientY, ox: base.x, oy: base.y };
    (e.target as Element).setPointerCapture(e.pointerId);
  };
  const onTitlePointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    setPos(clampPos({ x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy }));
  };
  const onTitlePointerUp = (e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    // 拖动结束持久化(钳位后的位置即用户放置的位置)
    setPos((p) => {
      if (p) saveSelectMaskPos(p);
      return p;
    });
  };
  if (!active || !s || !sm?.open) return null;

  const op = sm.viewOpacity[sm.viewMode] ?? selectMaskDefaultOpacity(sm.viewMode);
  const hasOpacity = sm.viewMode === 'onionSkin' || sm.viewMode === 'overlay' || sm.viewMode === 'onBlack' || sm.viewMode === 'onWhite';
  const isMaskOutput = sm.output === 'layerMask';
  // 去污只在输出为选区/蒙版时生效(引擎把 selection/layerMask 输出自动升级 newLayerWithMask)
  const patch = (p: Parameters<typeof updateSelectMask>[1]) => updateSelectMask(tabId, p);

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-center justify-center pointer-events-none">
      <div
        ref={cardRef}
        className="pointer-events-auto w-[380px] max-h-[80vh] overflow-y-auto rounded-md bg-[#FAFAFA]/95 dark:bg-[#3a3a3a]/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 p-3 text-[11px] flex flex-col gap-1.5"
        style={pos ? { position: 'fixed', left: pos.x, top: pos.y } : undefined}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div
          className="flex items-center cursor-grab active:cursor-grabbing select-none touch-none shrink-0"
          title="按住拖动窗口"
          onPointerDown={onTitlePointerDown}
          onPointerMove={onTitlePointerMove}
          onPointerUp={onTitlePointerUp}
          onPointerCancel={onTitlePointerUp}
        >
          <span className="text-[12px] font-medium">选择并遮住</span>
          <div className="flex-1" />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">F 循环视图 · X 按住看原图 · Enter 确定 Esc 取消</span>
        </div>
        {/* 视图(上游 select_mask_view::controls) */}
        <label className="flex items-center gap-1.5">
          <span className={`${labelCls} w-14`}>视图</span>
          <EditorSelect
            value={sm.viewMode}
            onChange={(v) => patch({ viewMode: v as SelectMaskMode })}
            className="flex-1"
            options={SELECT_MASK_MODES.map((m) => ({ value: m, label: SELECT_MASK_MODE_ZH[m] }))}
          />
        </label>
        {hasOpacity ? (
          <Slider label="不透明度" value={op} min={0} max={100} suffix="%" onChange={(v) => patch({ viewOpacity: { ...sm.viewOpacity, [sm.viewMode]: v } })} />
        ) : null}
        <div className="flex gap-1.5">
          <button
            onClick={() => patch({ showEdge: !sm.showEdge })}
            title="显示精修带(J;半径带宽 + 笔刷涂抹区)"
            className={`px-2 py-0.5 rounded text-[10px] ${sm.showEdge ? 'bg-sky-600/20 text-sky-700 dark:text-sky-300' : 'bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300'}`}
          >
            显示边缘
          </button>
          <button
            onClick={() => patch({ showOriginal: !sm.showOriginal })}
            title="显示精修前的选区(P)"
            className={`px-2 py-0.5 rounded text-[10px] ${sm.showOriginal ? 'bg-sky-600/20 text-sky-700 dark:text-sky-300' : 'bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300'}`}
          >
            显示原始选区
          </button>
        </div>
        {/* 边刷(上游 brush_controls;画布涂抹处=精修发生处,R 切换,[ ] 调径) */}
        <div className={sectionCls}>边刷</div>
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox" checked={sm.brush}
            onChange={(e) => {
              patch({ brush: e.target.checked });
              showEditorNotice(e.target.checked ? '边刷已开启:在画布上涂抹 · Alt 反向 · [ ] 调直径' : '边刷已关闭');
            }}
            className="accent-sky-600"
          />
          边缘笔刷 (R)
        </label>
        {sm.brush ? (
          <>
            <label className="flex items-center gap-1.5">
              <span className={`${labelCls} w-14`}>模式</span>
              <EditorSelect
                value={sm.brushMode}
                onChange={(v) => patch({ brushMode: v as 'add' | 'subtract' })}
                className="flex-1"
                options={[
                  { value: 'add', label: '扩展检测区域' },
                  { value: 'subtract', label: '恢复原始边缘' },
                ]}
              />
            </label>
            <Slider label="大小" value={sm.brushSize} min={1} max={1000} suffix="px" onChange={(v) => patch({ brushSize: Math.round(v) })} />
            <div className="text-[10px] text-neutral-500 dark:text-neutral-400">在图像上涂抹头发或毛发等细节;Alt 涂出另一模式</div>
          </>
        ) : null}
        {sm.refineStrokes.length > 0 ? (
          <button
            onClick={() => {
              patch({ refineStrokes: [] });
              showEditorNotice('已清除边刷笔划');
            }}
            title="清除已画的边刷笔划"
            className="px-2 py-0.5 rounded text-[10px] self-start bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
          >
            清除笔刷笔划
          </button>
        ) : null}
        {/* 全局精修(上游 spec 顺序) */}
        <div className={sectionCls}>全局精修</div>
        <Slider label="半径" value={sm.radius} min={0} max={250} suffix="px" onChange={(v) => patch({ radius: v })} />
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={sm.smartRadius} onChange={(e) => patch({ smartRadius: e.target.checked })} className="accent-sky-600" />
          智能半径
        </label>
        <Slider label="平滑" value={sm.smooth} min={0} max={100} onChange={(v) => patch({ smooth: v })} />
        <Slider label="羽化" value={sm.feather} min={0} max={1000} suffix="px" onChange={(v) => patch({ feather: v })} />
        <Slider label="对比度" value={sm.contrast} min={0} max={100} suffix="%" onChange={(v) => patch({ contrast: v })} />
        <Slider label="移置边缘" value={sm.shiftEdge} min={-100} max={100} suffix="%" onChange={(v) => patch({ shiftEdge: v })} />
        {/* 去污 + 输出 + 采样(上游 spec 顺序:Decontaminate/Amount/Output/Sample All Layers) */}
        <div className={sectionCls}>去污</div>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={sm.decontaminate} onChange={(e) => patch({ decontaminate: e.target.checked })} className="accent-sky-600" />
          去污色(输出为选区/蒙版时自动改为新建带蒙版的图层)
        </label>
        {sm.decontaminate ? <Slider label="数量" value={sm.amount} min={0} max={100} suffix="%" onChange={(v) => patch({ amount: v })} /> : null}
        <div className={sectionCls}>输出到</div>
        <label className="flex items-center gap-1.5">
          <EditorSelect
            value={sm.output}
            onChange={(v) => patch({ output: v })}
            className="flex-1"
            options={SELECT_MASK_OUTPUTS.map((o) => ({ value: o, label: SELECT_MASK_OUTPUT_ZH[o] }))}
          />
        </label>
        <label className="flex items-center gap-1.5" title="精修采样全部图层的合成(关=仅当前层)">
          <input type="checkbox" checked={sm.sampleAllLayers} onChange={(e) => patch({ sampleAllLayers: e.target.checked })} className="accent-sky-600" />
          采样所有图层
        </label>
        {isMaskOutput ? <div className="text-[10px] text-neutral-500 dark:text-neutral-400">输出到图层蒙版:背景层将转为普通层</div> : null}
        <div className="flex justify-end gap-1.5 pt-1.5">
          <button
            onClick={() => patch({
              radius: 0, smartRadius: false, smooth: 0, feather: 0, contrast: 0, shiftEdge: 0,
              decontaminate: false, amount: 100, sampleAllLayers: false,
              showEdge: false, showOriginal: false,
              brush: false, brushMode: 'add', brushSize: 30, refineStrokes: [],
            })}
            className="px-2 py-0.5 rounded text-[11px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
          >
            重置
          </button>
          <button
            onClick={() => closeSelectMask(tabId, false)}
            className="px-2 py-0.5 rounded text-[11px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
          >
            取消
          </button>
          <button
            onClick={() => confirmSelectMask(tabId)}
            className="px-3 py-0.5 rounded text-[11px] bg-sky-600 text-white hover:bg-sky-500"
          >
            确定
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
