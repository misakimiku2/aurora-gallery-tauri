/**
 * 工具选项条(文件信息栏之下):随当前工具显示设置项。
 * 画笔族选项(笔径/硬度/不透明度;blur 族加强度)直接进 live 描边参数;
 * 其余工具占位。
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
/** 顺序 dab 工具(blur/sharpen/smudge):有 strength(强度),参数单位是百分数。 */
const RETOUCH_TOOLS = new Set(['blur', 'sharpen', 'smudge']);
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
          {RETOUCH_TOOLS.has(s.tool) && (
            <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
              强度
              <input
                type="range" min={1} max={100} value={s.options.retouchStrength}
                onChange={(e) => setOptions(tabId, { retouchStrength: Number(e.target.value) })}
                className="w-20 accent-sky-600"
                title="工具强度(引擎 strength,1..100)"
              />
              <span className="w-8 tabular-nums text-neutral-700 dark:text-neutral-300">{s.options.retouchStrength}%</span>
            </label>
          )}
          <span className="text-neutral-400 dark:text-neutral-500">
            {s.tool === 'eraser' ? '擦除(锁定透明度的图层上涂背景色)' : '左键绘制;[ / ] 调笔径'}
          </span>
        </>
      ) : isMarquee ? (
        <>
          <span className="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300">
            {s.options.marqueeShape === 'rect' ? '矩形' : '椭圆'}
          </span>
          <span className="text-neutral-400 dark:text-neutral-500">右键工具图标或再按 M 切换形状</span>
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
          <span className="text-neutral-400 dark:text-neutral-500">按下时:Shift 添加 / Alt 减去 / Shift+Alt 相交;拖拽中:Shift 正方形 / Alt 从中心</span>
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
