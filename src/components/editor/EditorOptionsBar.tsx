/**
 * 工具选项条(文件信息栏之下):随当前工具显示设置项。
 * M1 先做画笔族的笔径/硬度/不透明度(本地选项,M2 接引擎 ToolState);其余工具占位。
 */
import React, { useEffect, useState } from 'react';
import { getSession, setOptions, subscribeSession } from './editorStore';
import type { EditorTool } from './editorTypes';

const TOOL_NAMES: Record<EditorTool, string> = {
  move: '移动', marquee: '矩形选框', lasso: '套索', crop: '裁剪工具', eyedropper: '吸管',
  brush: '画笔', eraser: '橡皮擦', gradient: '渐变', bucket: '油漆桶',
  blur: '模糊', sharpen: '锐化', smudge: '涂抹', hand: '抓手', zoom: '缩放',
};

const BRUSH_FAMILY = new Set(['brush', 'eraser', 'blur', 'sharpen', 'smudge']);
const CROSSHAIR_HINT: Partial<Record<EditorTool, string>> = {
  eyedropper: '点击/拖动取色 → 前景色(按住拖动实时取样)',
  lasso: '套索拖拽(M2 后续切片接入)',
  crop: '裁剪框交互(M2 后续切片接入)',
};

export const EditorOptionsBar: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  if (!s) return null;

  const isBrush = BRUSH_FAMILY.has(s.tool);
  const isMarquee = s.tool === 'marquee';

  return (
    <div className="h-8 shrink-0 flex items-center gap-3 px-3 bg-panel border-b border-black/10 dark:border-white/10 text-[11px]">
      <span className="font-medium text-neutral-700 dark:text-neutral-200">{TOOL_NAMES[s.tool]}</span>
      {isBrush ? (
        <>
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            笔径
            <input
              type="range" min={1} max={500} value={s.options.brushSize}
              onChange={(e) => setOptions(tabId, { brushSize: Number(e.target.value) })}
              className="w-28 accent-sky-600"
              title="笔径([ / ] 调节)"
            />
            <span className="w-8 tabular-nums text-neutral-700 dark:text-neutral-300">{s.options.brushSize}px</span>
          </label>
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            硬度
            <input
              type="range" min={0} max={100} value={Math.round(s.options.brushHardness * 100)}
              onChange={(e) => setOptions(tabId, { brushHardness: Number(e.target.value) / 100 })}
              className="w-20 accent-sky-600"
            />
            <span className="w-8 tabular-nums text-neutral-700 dark:text-neutral-300">{Math.round(s.options.brushHardness * 100)}%</span>
          </label>
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            不透明度
            <input
              type="range" min={1} max={100} value={Math.round(s.options.brushOpacity * 100)}
              onChange={(e) => setOptions(tabId, { brushOpacity: Number(e.target.value) / 100 })}
              className="w-20 accent-sky-600"
            />
            <span className="w-8 tabular-nums text-neutral-700 dark:text-neutral-300">{Math.round(s.options.brushOpacity * 100)}%</span>
          </label>
        </>
      ) : isMarquee ? (
        <>
          <div className="flex items-center rounded border border-black/10 dark:border-white/15 overflow-hidden">
            {(['rect', 'ellipse'] as const).map((shape, i) => (
              <button
                key={shape}
                onClick={() => setOptions(tabId, { marqueeShape: shape })}
                className={`px-2 py-0.5 ${i === 1 ? 'border-l border-black/10 dark:border-white/15' : ''} ${
                  s.options.marqueeShape === shape
                    ? 'bg-sky-600 text-white'
                    : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {shape === 'rect' ? '矩形' : '椭圆'}
              </button>
            ))}
          </div>
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            羽化
            <input
              type="range" min={0} max={100} value={s.options.feather}
              onChange={(e) => setOptions(tabId, { feather: Number(e.target.value) })}
              className="w-20 accent-sky-600"
              title="羽化半径(px),只作用于新选区"
            />
            <span className="w-9 tabular-nums text-neutral-700 dark:text-neutral-300">{s.options.feather}px</span>
          </label>
          <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400">
            <input
              type="checkbox" checked={s.options.antiAlias}
              onChange={(e) => setOptions(tabId, { antiAlias: e.target.checked })}
              className="accent-sky-600"
            />
            消除锯齿
          </label>
          <span className="text-neutral-400 dark:text-neutral-500">Shift 添加 / Alt 减去 / Shift+Alt 相交;单击取消选择</span>
        </>
      ) : CROSSHAIR_HINT[s.tool] ? (
        <span className="text-neutral-400 dark:text-neutral-500">{CROSSHAIR_HINT[s.tool]}</span>
      ) : (
        <span className="text-neutral-400 dark:text-neutral-500">该工具的选项在 M2 接入</span>
      )}
      <div className="flex-1" />
      <span className="text-neutral-400 dark:text-neutral-500">编辑器 v3 · M2</span>
    </div>
  );
};
