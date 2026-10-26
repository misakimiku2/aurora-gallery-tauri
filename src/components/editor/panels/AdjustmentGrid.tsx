/**
 * 调整面板一键列表(photocraft 上游 panels.rs adjustments_grid 口径):
 * 16 个图标按钮,点击执行 layer.newAdjustmentLayer.<kind>(插到活动层之上,
 * 有选区则选区成为其蒙版),成功后切到属性 tab 编辑参数(上游同行为)。
 */
import React from 'react';
import {
  Sun, Gauge, PenTool, Scan, Sparkles, Droplet, Blend, Contrast, CircleDot,
  SlidersHorizontal, MinusSquare, Layers, Square, Palette, SwatchBook, Grid3x3,
  type LucideIcon,
} from 'lucide-react';
import { runCommand } from '../editorStore';
import { ADJUSTMENT_KINDS } from './adjustments';

/** 上游图标名 → lucide 组件(顺序同 ADJUSTMENT_KINDS)。 */
const KIND_ICONS: Record<string, LucideIcon> = {
  brightnessContrast: Sun,
  levels: Gauge,
  curves: PenTool,
  exposure: Scan,
  vibrance: Sparkles,
  hueSaturation: Droplet,
  colorBalance: Blend,
  blackWhite: Contrast,
  photoFilter: CircleDot,
  channelMixer: SlidersHorizontal,
  invert: MinusSquare,
  posterize: Layers,
  threshold: Square,
  gradientMap: Palette,
  selectiveColor: SwatchBook,
  colorLookup: Grid3x3,
};

export const AdjustmentGrid: React.FC<{
  tabId: string;
  onAdded: () => void;
}> = ({ tabId, onAdded }) => {
  const add = (kind: string) => {
    void runCommand(tabId, `layer.newAdjustmentLayer.${kind}`, {})
      .then(() => onAdded())
      .catch((e) => console.error('[editor] 添加调整层失败', e));
  };

  return (
    <div className="p-2">
      <div className="text-[10px] text-gray-500 dark:text-neutral-400 mb-1.5">添加调整图层(作用于下方所有图层)</div>
      <div className="grid grid-cols-4 gap-1">
        {ADJUSTMENT_KINDS.map(({ kind, label }) => {
          const Icon = KIND_ICONS[kind] ?? Square;
          return (
            <button
              key={kind}
              onClick={() => add(kind)}
              title={label}
              className="flex flex-col items-center gap-0.5 py-1.5 rounded hover:bg-black/5 dark:hover:bg-white/10 text-gray-600 dark:text-neutral-300"
            >
              <Icon size={16} />
              <span className="text-[9px] leading-tight text-center">{label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
