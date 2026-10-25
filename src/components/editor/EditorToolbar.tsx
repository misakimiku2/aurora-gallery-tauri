/**
 * 左侧工具栏:PS 分组(长按子工具弹层在 M2 接入,M1 每组一个主形态)+ 前/背景色芯片。
 */
import React, { useEffect, useState } from 'react';
import {
  Move, BoxSelect, Lasso, Crop, Pipette, Brush, Eraser, Blend, PaintBucket,
  Droplet, Sparkles, Fingerprint, Hand, ZoomIn, ArrowLeftRight, RotateCcw,
} from 'lucide-react';
import type { EditorTool } from './editorTypes';
import { getSession, setTool, subscribeSession, runCommand } from './editorStore';

const GROUPS: { tool: EditorTool; label: string; icon: React.ReactNode; key: string }[] = [
  { tool: 'move', label: '移动 (V)', icon: <Move size={18} />, key: 'v' },
  { tool: 'marquee', label: '矩形选框 (M)', icon: <BoxSelect size={18} />, key: 'm' },
  { tool: 'lasso', label: '套索 (L)', icon: <Lasso size={18} />, key: 'l' },
  { tool: 'crop', label: '裁剪 (C)', icon: <Crop size={18} />, key: 'c' },
  { tool: 'eyedropper', label: '吸管 (I)', icon: <Pipette size={18} />, key: 'i' },
  { tool: 'brush', label: '画笔 (B)', icon: <Brush size={18} />, key: 'b' },
  { tool: 'eraser', label: '橡皮擦 (E)', icon: <Eraser size={18} />, key: 'e' },
  { tool: 'gradient', label: '渐变 (G)', icon: <Blend size={18} />, key: 'g' },
  { tool: 'bucket', label: '油漆桶 (G)', icon: <PaintBucket size={18} />, key: 'k' },
  { tool: 'blur', label: '模糊 (R)', icon: <Droplet size={18} />, key: 'r' },
  { tool: 'sharpen', label: '锐化 (R)', icon: <Sparkles size={18} />, key: 'u' },
  { tool: 'smudge', label: '涂抹 (R)', icon: <Fingerprint size={18} />, key: 's' },
  { tool: 'hand', label: '抓手 (H)', icon: <Hand size={18} />, key: 'h' },
  { tool: 'zoom', label: '缩放 (Z)', icon: <ZoomIn size={18} />, key: 'z' },
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
    <div className="w-12 shrink-0 flex flex-col items-center gap-0.5 py-1.5 bg-[#252525] border-r border-neutral-800 select-none">
      {GROUPS.map(({ tool, label, icon, key }) => (
        <button
          key={tool}
          title={label}
          onClick={() => setTool(tabId, tool)}
          className={`w-9 h-9 rounded flex items-center justify-center transition-colors ${
            s.tool === tool ? 'bg-sky-600 text-white' : 'text-neutral-400 hover:bg-neutral-700/60 hover:text-neutral-200'
          }`}
        >
          {icon}
          <span className="sr-only">{key}</span>
        </button>
      ))}
      <div className="mt-2 relative w-10 h-10">
        <button
          title="背景色"
          className="absolute right-0 bottom-0 w-6.5 h-6.5 w-[26px] h-[26px] rounded-sm border border-neutral-500"
          style={{ background: rgbaCss(s.state?.background) }}
        />
        <button
          title="前景色"
          className="absolute left-0 top-0 w-[26px] h-[26px] rounded-sm border border-neutral-300 z-10"
          style={{ background: rgbaCss(s.state?.foreground) }}
        />
      </div>
      <div className="flex gap-1 mt-1">
        <button title="切换前/背景色 (X)" onClick={() => onKey('swap')} className="text-neutral-400 hover:text-neutral-100 p-0.5">
          <ArrowLeftRight size={13} />
        </button>
        <button title="默认前/背景色 (D)" onClick={() => onKey('reset')} className="text-neutral-400 hover:text-neutral-100 p-0.5">
          <RotateCcw size={13} />
        </button>
      </div>
    </div>
  );
};
