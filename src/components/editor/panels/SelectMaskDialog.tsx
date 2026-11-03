/**
 * Select and Mask(选择并遮住)对话框(上游 filter_dialog + select_mask_view::controls 口径):
 * 视图区(七视图 select + 每视图不透明度 + Show Edge/Show Original)= 对话框打开期间画布的
 * 显示方式(位图泵按参数键拉 editorSelectMaskView);全局精修参数(半径/智能半径/平滑/羽化/
 * 对比度/移置边缘);去污色 + 数量;输出目标;采样所有图层。确定=一条 select.refineEdge
 * (一步 "Select and Mask");取消=丢弃(预览零改动)。键盘(F/O/M/V/A/T/K/Y/J/P/X/Enter/Esc)
 * 由画布全局键处理;对话框不做首字段聚焦(上游同款,键盘留给视图)。
 * 输出暂缺「新建文档」两项目标(我们的多标签文档模型未接会话内新文档,待办)。
 */
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import {
  closeSelectMask, confirmSelectMask, getSession, SELECT_MASK_MODES, SELECT_MASK_MODE_ZH,
  SELECT_MASK_OUTPUTS, SELECT_MASK_OUTPUT_ZH, selectMaskDefaultOpacity, subscribeSession, updateSelectMask,
  type SelectMaskMode,
} from '../editorStore';

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

export const SelectMaskDialog: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  React.useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  const sm = s?.selectMask;
  if (!s || !sm?.open) return null;

  const op = sm.viewOpacity[sm.viewMode] ?? selectMaskDefaultOpacity(sm.viewMode);
  const hasOpacity = sm.viewMode === 'onionSkin' || sm.viewMode === 'overlay' || sm.viewMode === 'onBlack' || sm.viewMode === 'onWhite';
  const isMaskOutput = sm.output === 'layerMask';
  // 去污只在输出为选区/蒙版时生效(引擎把 selection/layerMask 输出自动升级 newLayerWithMask)
  const patch = (p: Parameters<typeof updateSelectMask>[1]) => updateSelectMask(tabId, p);

  return createPortal(
    <div className="fixed inset-0 z-[900] flex items-start justify-center pt-14 pointer-events-none">
      <div
        className="pointer-events-auto w-[380px] max-h-[80vh] overflow-y-auto rounded-md bg-[#FAFAFA]/95 dark:bg-[#3a3a3a]/95 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 p-3 text-[11px] flex flex-col gap-1.5"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center">
          <span className="text-[12px] font-medium">选择并遮住</span>
          <div className="flex-1" />
          <span className="text-[10px] text-neutral-500 dark:text-neutral-400">F 循环视图 · X 按住看原图 · Enter 确定 Esc 取消</span>
        </div>
        {/* 视图(上游 select_mask_view::controls) */}
        <label className="flex items-center gap-1.5">
          <span className={`${labelCls} w-14`}>视图</span>
          <select
            value={sm.viewMode}
            onChange={(e) => patch({ viewMode: e.target.value as SelectMaskMode })}
            className="flex-1 h-6 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] text-neutral-700 dark:text-neutral-300"
          >
            {SELECT_MASK_MODES.map((m) => (
              <option key={m} value={m}>{SELECT_MASK_MODE_ZH[m]}</option>
            ))}
          </select>
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
          <select
            value={sm.output}
            onChange={(e) => patch({ output: e.target.value })}
            className="flex-1 h-6 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] text-neutral-700 dark:text-neutral-300"
          >
            {SELECT_MASK_OUTPUTS.filter((o) => o !== 'newDocument' && o !== 'newDocumentWithMask').map((o) => (
              <option key={o} value={o}>{SELECT_MASK_OUTPUT_ZH[o]}</option>
            ))}
          </select>
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
