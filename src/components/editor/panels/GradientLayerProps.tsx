/**
 * 渐变填充图层的属性页(上游 gradient_ui/properties_panel.rs 口径):
 * Gradient 段=停靠点条(GradientLayerStops:透明度/颜色/中点编辑+字段行);
 * Gradient Options 段=Style 五样式 / Angle / Scale(1..1000%) / Reverse / Dither / Align /
 * Reset Alignment,每个控件一条 gradient.fill.set(一次手势一步历史)。
 * 数值输入本地草稿跟手,失焦/回车提交(上游 numeric_row drag_stopped/lost_focus 口径)。
 */
import React, { useEffect, useState } from 'react';
import { runCommand } from '../editorStore';
import type { GradientFillInfo } from '../gradientFill';
import { GradientLayerStops } from './GradientLayerStops';

const STYLES: { v: string; label: string }[] = [
  { v: 'linear', label: '线性' },
  { v: 'radial', label: '径向' },
  { v: 'angle', label: '角度' },
  { v: 'reflected', label: '对称' },
  { v: 'diamond', label: '菱形' },
];

export const GradientLayerProps: React.FC<{ tabId: string; layerId: number; fill: GradientFillInfo }> = ({ tabId, layerId, fill }) => {
  const set = (patch: Record<string, unknown>) => {
    void runCommand(tabId, 'gradient.fill.set', { layer: layerId, ...patch }).catch((e) => console.error('[editor] gradient.fill.set', e));
  };

  // 角度/缩放本地草稿(输入中不回吸;fill 变化且输入框未聚焦时同步)
  const [angle, setAngle] = useState(String(Math.round(fill.angle * 10) / 10));
  const [scale, setScale] = useState(String(Math.round(fill.scale)));
  useEffect(() => {
    if (document.activeElement?.tagName === 'INPUT') return;
    setAngle(String(Math.round(fill.angle * 10) / 10));
    setScale(String(Math.round(fill.scale)));
  }, [fill]);

  const commitAngle = () => {
    const v = Number(angle);
    if (Number.isFinite(v) && Math.abs(v - fill.angle) > 1e-3) set({ angle: v });
  };
  const commitScale = () => {
    const v = Number(scale);
    if (Number.isFinite(v) && Math.abs(v - fill.scale) > 1e-3) set({ scale: Math.min(1000, Math.max(1, v)) });
  };

  const inputCls = 'w-16 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] tabular-nums text-neutral-700 dark:text-neutral-300';
  const checkCls = 'accent-sky-600';

  return (
    <div className="flex flex-col gap-1 text-[11px] text-neutral-700 dark:text-neutral-300">
      <GradientLayerStops tabId={tabId} layerId={layerId} fill={fill} />
      <div className="flex items-center gap-0.5 pt-1" title="渐变样式">
        {STYLES.map(({ v, label }) => (
          <button
            key={v}
            title={label}
            onClick={() => set({ style: v })}
            className={`px-1.5 h-6 rounded ${
              fill.style === v
                ? 'bg-sky-600/20 text-sky-700 dark:text-sky-300'
                : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="flex items-center gap-1.5">
        <span className="w-10 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400">角度</span>
        <input
          type="number" min={-180} max={180} step={0.1} value={angle}
          onChange={(e) => setAngle(e.target.value)}
          onBlur={commitAngle}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
          className={inputCls}
        />
        <span className="text-[10px] text-neutral-500 dark:text-neutral-400">°</span>
      </label>
      <label className="flex items-center gap-1.5">
        <span className="w-10 shrink-0 text-[10px] text-gray-500 dark:text-neutral-400">缩放</span>
        <input
          type="number" min={1} max={1000} step={1} value={scale}
          onChange={(e) => setScale(e.target.value)}
          onBlur={commitScale}
          onKeyDown={(e) => { if (e.key === 'Enter') (e.target as HTMLInputElement).blur(); e.stopPropagation(); }}
          className={inputCls}
        />
        <span className="text-[10px] text-neutral-500 dark:text-neutral-400">%</span>
      </label>
      <div className="flex gap-4">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={fill.reverse} onChange={(e) => set({ reverse: e.target.checked })} className={checkCls} />
          反向
        </label>
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={fill.dither} onChange={(e) => set({ dither: e.target.checked })} className={checkCls} />
          仿色
        </label>
        <label className="flex items-center gap-1.5" title="按图层边界布局渐变(关=按画布)">
          <input type="checkbox" checked={fill.align} onChange={(e) => set({ align: e.target.checked })} className={checkCls} />
          与图层对齐
        </label>
      </div>
      <div>
        <button
          onClick={() => set({ offset: [0, 0] })}
          className="px-2 py-0.5 rounded text-[10px] bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300"
          title="重置对齐:中心偏移归零"
        >
          重置对齐
        </button>
      </div>
    </div>
  );
};
