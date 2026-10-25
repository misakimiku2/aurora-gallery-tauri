/**
 * 工具栏(横置):顶部信息栏之下的一行工具按钮 + 前/背景色芯片。
 * 长按子工具弹层在 M2 接入,M1 每组一个主形态。
 */
import React, { useEffect, useState } from 'react';
import {
  Move, BoxSelect, Lasso, Crop, Pipette, Brush, Eraser, Blend, PaintBucket,
  Droplet, Sparkles, Fingerprint, Hand, ZoomIn, ArrowLeftRight, RotateCcw,
} from 'lucide-react';
import type { EditorTool } from './editorTypes';
import { getSession, setTool, subscribeSession, runCommand } from './editorStore';

const GROUPS: { tool: EditorTool; label: string; icon: React.ReactNode; key: string }[] = [
  { tool: 'move', label: '移动 (V)', icon: <Move size={16} />, key: 'v' },
  { tool: 'marquee', label: '矩形选框 (M)', icon: <BoxSelect size={16} />, key: 'm' },
  { tool: 'lasso', label: '套索 (L)', icon: <Lasso size={16} />, key: 'l' },
  { tool: 'crop', label: '裁剪 (C)', icon: <Crop size={16} />, key: 'c' },
  { tool: 'eyedropper', label: '吸管 (I)', icon: <Pipette size={16} />, key: 'i' },
  { tool: 'brush', label: '画笔 (B)', icon: <Brush size={16} />, key: 'b' },
  { tool: 'eraser', label: '橡皮擦 (E)', icon: <Eraser size={16} />, key: 'e' },
  { tool: 'gradient', label: '渐变 (G)', icon: <Blend size={16} />, key: 'g' },
  { tool: 'bucket', label: '油漆桶 (K)', icon: <PaintBucket size={16} />, key: 'k' },
  { tool: 'blur', label: '模糊 (R)', icon: <Droplet size={16} />, key: 'r' },
  { tool: 'sharpen', label: '锐化 (U)', icon: <Sparkles size={16} />, key: 'u' },
  { tool: 'smudge', label: '涂抹 (S)', icon: <Fingerprint size={16} />, key: 's' },
  { tool: 'hand', label: '抓手 (H)', icon: <Hand size={16} />, key: 'h' },
  { tool: 'zoom', label: '缩放 (Z)', icon: <ZoomIn size={16} />, key: 'z' },
];

const rgbaCss = (c: number[] | undefined): string => {
  if (!c || c.length < 3) return '#000000';
  const [r, g, b] = c;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
};

export const EditorToolbar: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  if (!s) return null;

  const onKey = (which: 'swap' | 'reset') => {
    void runCommand(tabId, which === 'swap' ? 'tools.swapColors' : 'tools.defaultColors', {}).catch(console.error);
  };

  return (
    <div className="h-10 shrink-0 flex items-center gap-0.5 px-2 bg-[#252525] border-b border-neutral-800 overflow-x-auto select-none">
      {GROUPS.map(({ tool, label, icon }) => (
        <button
          key={tool}
          title={label}
          onClick={() => setTool(tabId, tool)}
          className={`w-8 h-8 shrink-0 rounded flex items-center justify-center transition-colors ${
            s.tool === tool ? 'bg-sky-600 text-white' : 'text-neutral-400 hover:bg-neutral-700/60 hover:text-neutral-200'
          }`}
        >
          {icon}
        </button>
      ))}
      <div className="w-px h-5 bg-neutral-700 mx-1.5 shrink-0" />
      <div className="relative w-9 h-8 shrink-0 mr-1">
        <button
          title="背景色"
          className="absolute right-0 bottom-0 w-[24px] h-[24px] rounded-sm border border-neutral-500"
          style={{ background: rgbaCss(s.state?.background) }}
        />
        <button
          title="前景色"
          className="absolute left-0 top-0 w-[24px] h-[24px] rounded-sm border border-neutral-300 z-10"
          style={{ background: rgbaCss(s.state?.foreground) }}
        />
      </div>
      <button title="切换前/背景色 (X)" onClick={() => onKey('swap')} className="w-7 h-8 shrink-0 text-neutral-400 hover:text-neutral-100">
        <ArrowLeftRight size={13} className="mx-auto" />
      </button>
      <button title="默认前/背景色 (D)" onClick={() => onKey('reset')} className="w-7 h-8 shrink-0 text-neutral-400 hover:text-neutral-100">
        <RotateCcw size={13} className="mx-auto" />
      </button>
    </div>
  );
};
