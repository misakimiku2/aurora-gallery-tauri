/**
 * 工具选项条(文件信息栏之下):随当前工具显示设置项。
 * 画笔族选项(笔径/硬度/不透明度;blur 族加强度)直接进 live 描边参数;
 * 其余工具占位。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSession, setOptions, subscribeSession } from './editorStore';
import type { ToolOptions } from './editorStore';
import type { EditorTool } from './editorTypes';
import { Square, PlusSquare, MinusSquare, XSquare, Check, CircleOff, Ruler, Magnet, ChevronDown } from 'lucide-react';

const TOOL_NAMES: Record<EditorTool, string> = {
  move: '移动', marquee: '矩形选框', lasso: '套索', polygonLasso: '多边形套索', crop: '裁剪工具', eyedropper: '吸管',
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
const SELECTION_TOOLS = new Set(['marquee', 'lasso', 'polygonLasso']);
const CROSSHAIR_HINT: Partial<Record<EditorTool, string>> = {
  eyedropper: '点击/拖动取色 → 前景色(按住拖动实时取样)',
  crop: '裁剪框交互(M2 后续切片接入)',
};

/** 渐变五样式(引擎 paint.gradient style;PS 选项条同序)。 */
const GRADIENT_STYLES: { style: ToolOptions['gradientStyle']; label: string }[] = [
  { style: 'linear', label: '线性' },
  { style: 'radial', label: '径向' },
  { style: 'angle', label: '角度' },
  { style: 'reflected', label: '对称' },
  { style: 'diamond', label: '菱形' },
];

/** 裁剪比例预设(上游 chrome_ui::CROP_RATIOS 的用户向子集)。 */
const CROP_RATIOS: { v: string; label: string }[] = [
  { v: '', label: '自由' },
  { v: 'original', label: '原始比例' },
  { v: '1:1', label: '1 : 1' },
  { v: '4:5', label: '4 : 5' },
  { v: '5:7', label: '5 : 7' },
  { v: '2:3', label: '2 : 3' },
  { v: '16:9', label: '16 : 9' },
];

export const EditorOptionsBar: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  // 裁剪比例下拉(右键菜单同款毛玻璃弹层)与角度输入框的本地编辑态
  const [ratioOpen, setRatioOpen] = useState(false);
  const [ratioPos, setRatioPos] = useState({ left: 0, top: 0 });
  const [angleText, setAngleText] = useState<string | null>(null);
  const ratioBtnRef = useRef<HTMLButtonElement | null>(null);
  const ratioMenuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!ratioOpen) return;
    const close = (e: MouseEvent) => {
      // 按钮与菜单内部的 mousedown 不关(否则菜单在 click 到达前被卸载,选项点击丢失)
      if (ratioBtnRef.current?.contains(e.target as Node) || ratioMenuRef.current?.contains(e.target as Node)) return;
      setRatioOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [ratioOpen]);
  useLayoutEffect(() => {
    if (!ratioOpen) return;
    const el = ratioMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(ratioPos.left, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(ratioPos.top, window.innerHeight - r.height - 4))}px`;
  }, [ratioOpen, ratioPos]);
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
            {s.tool === 'eraser' ? '擦除(锁定透明度的图层上涂背景色);按住 Shift 画直线,Shift+点击连接上一笔' : '左键绘制;[ / ] 调笔径;按住 Shift 画直线,Shift+点击连接上一笔'}
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
          <button
            ref={ratioBtnRef}
            onClick={() => {
              const r = ratioBtnRef.current!.getBoundingClientRect();
              setRatioPos({ left: r.left, top: r.bottom + 4 });
              setRatioOpen((v) => !v);
            }}
            className="flex items-center gap-1 px-2 h-6 rounded border border-black/15 dark:border-white/15 text-[11px] text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10"
            title="比例预设:选定后当前框按比例内缩适配;拖画与调把手时保持该比例"
          >
            比例:{CROP_RATIOS.find((r) => r.v === s.options.cropRatio)?.label ?? '自由'}
            <ChevronDown size={11} />
          </button>
          <label className="flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400" title="裁剪框角度(度,顺时针为正);输入后回车应用">
            角度
            <input
              value={angleText ?? String(Math.round(s.cropAngle * 10) / 10)}
              onChange={(e) => setAngleText(e.target.value)}
              onBlur={() => {
                if (angleText != null) {
                  const v = parseFloat(angleText);
                  if (Number.isFinite(v)) s.runtime.cropSetAngle?.(v);
                }
                setAngleText(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                else if (e.key === 'Escape') setAngleText(null);
              }}
              className="w-14 h-6 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] text-neutral-700 dark:text-neutral-200"
            />
          </label>
          <button
            title="角度约束:旋转吸附 15° 步进;按住 Shift 临时反转"
            onClick={() => setOptions(tabId, { cropSnapAngle: !s.options.cropSnapAngle })}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border ${
              s.options.cropSnapAngle
                ? 'bg-sky-600/20 text-sky-700 dark:text-sky-300 border-sky-500/50'
                : 'border-black/15 dark:border-white/15 text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            <Magnet size={12} />约束
          </button>
          <button
            title="拉直:沿图里应水平(或应竖直)的线画一条线,自动转正并取最大内接框;再点一次解除"
            onClick={() => {
              s.runtime.cropStraightenArmed = !s.runtime.cropStraightenArmed;
              s.runtime.cropStraightenLine = null;
              forceUpdate((n) => n + 1);
            }}
            className={`flex items-center gap-1 px-2 py-0.5 rounded text-[11px] border ${
              s.runtime.cropStraightenArmed
                ? 'bg-sky-600/20 text-sky-700 dark:text-sky-300 border-sky-500/50'
                : 'border-black/15 dark:border-white/15 text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10'
            }`}
          >
            <Ruler size={12} />拉直
          </button>
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
          {ratioOpen &&
            createPortal(
              <div
                ref={ratioMenuRef}
                className="fixed z-[1000] rounded-md bg-[#FAFAFA]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 py-1.5 w-max"
              >
                {CROP_RATIOS.map((r) => (
                  <div
                    key={r.v || 'free'}
                    className="mx-1.5 px-3 py-1.5 rounded hover:bg-blue-600 hover:text-white cursor-pointer whitespace-nowrap text-[12px] flex items-center gap-2"
                    onClick={() => {
                      setOptions(tabId, { cropRatio: r.v });
                      if (r.v) s.runtime.cropFitRatio?.();
                      setRatioOpen(false);
                    }}
                  >
                    <span>{r.label}</span>
                    {s.options.cropRatio === r.v && <Check size={12} className="ml-auto opacity-80" />}
                  </div>
                ))}
              </div>,
              document.body,
            )}
        </>
      ) : s.tool === 'gradient' ? (
        <>
          <div className="flex items-center gap-0.5" title="渐变样式">
            {GRADIENT_STYLES.map(({ style, label }) => (
              <button
                key={style}
                title={label}
                onClick={() => setOptions(tabId, { gradientStyle: style })}
                className={`px-1.5 h-6 rounded text-[11px] ${
                  s.options.gradientStyle === style
                    ? 'bg-sky-600/20 text-sky-700 dark:text-sky-300'
                    : 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <span className="text-neutral-400 dark:text-neutral-500">拖画方向线(Shift 吸附 45°);前景色 → 背景色;小于 2px 无操作</span>
        </>
      ) : s.tool === 'bucket' ? (
        <>
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            容差
            <input
              type="range" min={0} max={255} value={s.options.tolerance}
              onChange={(e) => setOptions(tabId, { tolerance: Number(e.target.value) })}
              className="w-24 accent-sky-600"
              title="容差 0..255(颜色相近判定范围)"
            />
            <span className="w-8 tabular-nums text-neutral-700 dark:text-neutral-300">{s.options.tolerance}</span>
          </label>
          <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400">
            <input
              type="checkbox" checked={s.options.antiAlias}
              onChange={(e) => setOptions(tabId, { antiAlias: e.target.checked })}
              className="accent-sky-600"
            />
            消除锯齿
          </label>
          <span className="text-neutral-400 dark:text-neutral-500">点击填充(前景色);Alt+点击=取色</span>
        </>
      ) : s.tool === 'move' ? (
        <>
          <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400" title="按下时拾取光标下的图层(命中空白/锁定层=拖框选层);按住 Ctrl 临时反转">
            <input
              type="checkbox" checked={s.options.moveAutoSelect}
              onChange={(e) => setOptions(tabId, { moveAutoSelect: e.target.checked })}
              className="accent-sky-600"
            />
            自动选择
          </label>
          <select
            value={s.options.moveTarget}
            disabled={!s.options.moveAutoSelect}
            onChange={(e) => setOptions(tabId, { moveTarget: e.target.value as ToolOptions['moveTarget'] })}
            className="h-6 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] text-neutral-600 dark:text-neutral-300 disabled:opacity-40"
            title="Auto-Select 的拾取目标:图层 / 最外层编组"
          >
            <option value="layer">图层</option>
            <option value="group">组</option>
          </select>
          <span className="text-neutral-400 dark:text-neutral-500">
            拖动移动图层/选区像素;Alt 拖动=复制移动;Alt+方向键=复制微移;Shift 锁轴;Enter 落定浮动
          </span>
        </>
      ) : CROSSHAIR_HINT[s.tool] ? (
        <span className="text-neutral-400 dark:text-neutral-500">{CROSSHAIR_HINT[s.tool]}</span>
      ) : (
        <span className="text-neutral-400 dark:text-neutral-500">该工具的选项在 M2 接入</span>
      )}
      <div className="flex-1" />
      <span className="text-neutral-400 dark:text-neutral-500">编辑器 v3 · M3</span>
    </div>
  );
};
