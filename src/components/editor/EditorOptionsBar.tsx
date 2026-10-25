/**
 * 工具选项条(文件信息栏之下):随当前工具显示设置项。
 * 画笔族选项(笔径/硬度/不透明度;blur 族加强度)直接进 live 描边参数;
 * 其余工具占位。
 */
import React, { useEffect, useState } from 'react';
import { getSession, setOptions, subscribeSession } from './editorStore';
import type { EditorTool } from './editorTypes';
import { Square, PlusSquare, MinusSquare, XSquare, Check, CircleOff } from 'lucide-react';

const TOOL_NAMES: Record<EditorTool, string> = {
  move: '移动', marquee: '矩形选框', lasso: '套索', crop: '裁剪工具', eyedropper: '吸管',
  brush: '画笔', eraser: '橡皮擦', gradient: '渐变', bucket: '油漆桶',
  blur: '模糊', sharpen: '锐化', smudge: '涂抹', hand: '抓手', zoom: '缩放',
};

const SHAPE_NAMES: Record<string, string> = {
  rect: '矩形选框', ellipse: '椭圆选框', row: '单行选框', column: '单列选框',
};

/** 选区四态(上游 selection_mode 的选项条;无修饰键时用它,修饰键优先)。 */
const SEL_MODES: { mode: 'replace' | 'add' | 'subtract' | 'intersect'; label: string; icon: React.ReactNode }[] = [
  { mode: 'replace', label: '新选区', icon: <Square size={13} /> },
  { mode: 'add', label: '添加到选区', icon: <PlusSquare size={13} /> },
  { mode: 'subtract', label: '从选区减去', icon: <MinusSquare size={13} /> },
  { mode: 'intersect', label: '与选区交叉', icon: <XSquare size={13} /> },
];

const BRUSH_FAMILY = new Set(['brush', 'eraser', 'blur', 'sharpen', 'smudge']);
/** 顺序 dab 工具(blur/sharpen/smudge):有 strength(强度),参数单位是百分数。 */
const RETOUCH_TOOLS = new Set(['blur', 'sharpen', 'smudge']);
/** 选区类工具:羽化/消锯齿/四态模式提示共用。 */
const SELECTION_TOOLS = new Set(['marquee', 'lasso']);
const CROSSHAIR_HINT: Partial<Record<EditorTool, string>> = {
  eyedropper: '点击/拖动取色 → 前景色(按住拖动实时取样)',
  crop: '裁剪框交互(M2 后续切片接入)',
};

export const EditorOptionsBar: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  if (!s) return null;

  const isBrush = BRUSH_FAMILY.has(s.tool);

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
      ) : SELECTION_TOOLS.has(s.tool) ? (
        <>
          {s.tool === 'marquee' && (
            <span className="px-1.5 py-0.5 rounded bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300">
              {SHAPE_NAMES[s.options.marqueeShape] ?? '矩形选框'}
            </span>
          )}
          <div className="flex items-center gap-0.5" title="选区模式(修饰键临时优先:Shift 添加 / Alt 减去 / Shift+Alt 相交)">
            {SEL_MODES.map(({ mode, label, icon }) => (
              <button
                key={mode}
                title={label}
                onClick={() => setOptions(tabId, { selectionMode: mode })}
                className={`w-6 h-6 rounded flex items-center justify-center ${
                  s.options.selectionMode === mode
                    ? 'bg-sky-600/20 text-sky-700 dark:text-sky-300'
                    : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {icon}
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
          <span className="text-neutral-400 dark:text-neutral-500">
            {s.tool === 'marquee'
              ? '按下时:Shift 添加 / Alt 减去 / Shift+Alt 相交;拖拽中:Shift 正方形 / Alt 从中心'
              : '拖拽圈选;<3 点提交=取消选择;Esc 取消轮廓;按下时:Shift 添加 / Alt 减去 / Shift+Alt 相交'}
          </span>
        </>
      ) : s.tool === 'crop' ? (
        <>
          <span className="text-neutral-400 dark:text-neutral-500">拖画裁剪框;Enter / 双击提交,Esc 取消</span>
          <button
            title="提交裁剪 (Enter)"
            onClick={() => s.runtime.cropCommit?.()}
            className="flex items-center gap-1 px-2 py-0.5 rounded bg-sky-600 text-white text-[11px] hover:bg-sky-500"
          >
            <Check size={12} />裁剪
          </button>
          <button
            title="取消裁剪 (Esc)"
            onClick={() => s.runtime.cropCancel?.()}
            className="flex items-center gap-1 px-2 py-0.5 rounded border border-black/15 dark:border-white/15 text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10"
          >
            <CircleOff size={12} />取消
          </button>
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
