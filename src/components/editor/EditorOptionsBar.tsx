/**
 * 工具选项条(文件信息栏之下):随当前工具显示设置项。
 * 画笔族选项(笔径/硬度/不透明度;blur 族加强度)直接进 live 描边参数;
 * 其余工具占位。
 */
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { getSession, markInteractiveRender, openSelectMask, setOptions, subscribeSession } from './editorStore';
import type { ToolOptions } from './editorStore';
import type { EditorTool } from './editorTypes';
import { BLEND_ZH } from './editorTypes';
import { Square, PlusSquare, MinusSquare, XSquare, Check, CircleOff, Ruler, Magnet, ChevronDown } from 'lucide-react';
import { clonePreset, GRADIENT_GROUPS, presetCss } from './gradientPresets';
import { peekGradientFill } from './gradientFill';
import { isWhrKey, normalizeLength, normalizeResolution, WHR_PRESETS, whrPresetFields } from './cropSize';
import { SHAPE_GROUP } from './toolLogic';
import { EditorSelect } from './editorSelect';
import { runCommand } from './editorStore';

/** [r,g,b] 0..1 → css(色芯片显示)。 */
const rgbCss = (c: number[] | undefined): string => {
  if (!c || c.length < 3) return '#000000';
  const [r, g, b] = c;
  return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
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
const SELECTION_TOOLS = new Set(['marquee', 'lasso', 'polygonLasso', 'magneticLasso']);
/** 磁性套索专属:宽度/对比度/频率。 */
const MAGNETIC_TOOL = 'magneticLasso';

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

/** 裁剪比例下拉全量(上游 crop_size::dropdown_options:自由 → W×H×分辨率 → 比例预设 →
 * 尺寸预设 → 前景图像)。 */
const CROP_MENU: { v: string; label: string }[] = [
  CROP_RATIOS[0],
  { v: 'whr', label: 'W × H × 分辨率' },
  ...CROP_RATIOS.slice(1),
  ...WHR_PRESETS.map((p) => ({ v: p.key, label: p.label })),
  { v: 'front', label: '前景图像' },
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
  // 渐变预设弹层(裁剪比例下拉同款毛玻璃)
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetPos, setPresetPos] = useState({ left: 0, top: 0 });
  const presetBtnRef = useRef<HTMLButtonElement | null>(null);
  const presetMenuRef = useRef<HTMLDivElement | null>(null);
  /** Live 不透明度拖动编号(coalesce 键;一次拖动合并为一个 undo 步)。 */
  const opacityDragRef = useRef(0);
  useEffect(() => {
    if (!presetOpen) return;
    const close = (e: MouseEvent) => {
      if (presetBtnRef.current?.contains(e.target as Node) || presetMenuRef.current?.contains(e.target as Node)) return;
      setPresetOpen(false);
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [presetOpen]);
  useLayoutEffect(() => {
    if (!presetOpen) return;
    const el = presetMenuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.left = `${Math.max(4, Math.min(presetPos.left, window.innerWidth - r.width - 4))}px`;
    el.style.top = `${Math.max(4, Math.min(presetPos.top, window.innerHeight - r.height - 4))}px`;
  }, [presetOpen, presetPos]);
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
  // 渐变工具当前渐变的色板(前景/背景活引用按当前颜色解析;棋盘格垫底显透明)
  const gradCss = s.tool === 'gradient'
    ? presetCss(s.options.gradientCurrent, s.state?.foreground, s.state?.background)
    : '';

  // Live 同步(上游 options_changed/opacity_changed):选中渐变填充图层(且非经典模式)时,
  // 选项条变化直接落到图层;没有选中渐变图层就只改工具选项,影响下一次拖拽
  const liveFill = s.tool === 'gradient' && !s.options.gradientClassic
    ? peekGradientFill(s.docId, s.state?.activeLayer ?? null, s.revision)
    : null;

  const isBrush = BRUSH_FAMILY.has(s.tool);

  return (
    <div className="h-8 shrink-0 flex items-center gap-3 px-3 bg-panel border-b border-black/10 dark:border-white/10 text-[11px]">
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
        </>
      ) : SELECTION_TOOLS.has(s.tool) ? (
        <>
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
          {s.tool === MAGNETIC_TOOL && (
            <>
              <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400" title="跟随边缘的检测宽度(px)">
                宽度
                <input
                  type="range" min={1} max={256} value={s.options.magneticWidth}
                  onChange={(e) => setOptions(tabId, { magneticWidth: Number(e.target.value) })}
                  className="w-20 accent-sky-600"
                />
                <span className="w-10 tabular-nums text-neutral-700 dark:text-neutral-300">{s.options.magneticWidth}px</span>
              </label>
              <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400" title="弱于此对比度的边缘被忽略(%)">
                对比度
                <input
                  type="range" min={1} max={100} value={s.options.magneticContrast}
                  onChange={(e) => setOptions(tabId, { magneticContrast: Number(e.target.value) })}
                  className="w-20 accent-sky-600"
                />
                <span className="w-10 tabular-nums text-neutral-700 dark:text-neutral-300">{s.options.magneticContrast}%</span>
              </label>
              <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400" title="自动落点的疏密(越高越密)">
                频率
                <input
                  type="range" min={0} max={100} value={s.options.magneticFrequency}
                  onChange={(e) => setOptions(tabId, { magneticFrequency: Number(e.target.value) })}
                  className="w-20 accent-sky-600"
                />
                <span className="w-9 tabular-nums text-neutral-700 dark:text-neutral-300">{s.options.magneticFrequency}</span>
              </label>
              <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400" title="用数位笔压感收窄检测宽度(仅笔设备生效;压得越重宽度越窄)">
                <input
                  type="checkbox" checked={s.options.magneticPressure}
                  onChange={(e) => setOptions(tabId, { magneticPressure: e.target.checked })}
                  className="accent-sky-600"
                />
                压感
              </label>
            </>
          )}
          {/* 选择并遮住…(PS 选框/套索选项条同款按钮;无选区且活动层无蒙版时禁用;
              Ctrl+Alt+R 可能被系统热键抢占,按钮入口不依赖快捷键) */}
          <button
            onClick={() => openSelectMask(tabId)}
            disabled={!s.state?.hasSelection && !s.state?.layers.find((l) => l.id === s.state?.activeLayer)?.hasMask}
            title="选择并遮住…(Ctrl+Alt+R;快捷键被系统热键占用时用此按钮)"
            className="px-2 py-0.5 rounded text-[11px] shrink-0 bg-black/5 dark:bg-white/10 text-neutral-600 dark:text-neutral-300 hover:bg-black/10 dark:hover:bg-white/15 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            选择并遮住…
          </button>
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
            比例:{CROP_MENU.find((r) => r.v === s.options.cropRatio)?.label ?? '自由'}
            <ChevronDown size={11} />
          </button>
          {isWhrKey(s.options.cropRatio) ? (
            <>
              <label className="flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400" title="输出宽度(可带单位:px/in/cm/mm;裸数字沿用上次单位)">
                W
                <input
                  value={s.options.cropWidth}
                  onChange={(e) => {
                    setOptions(tabId, { cropWidth: normalizeLength(e.target.value, s.options.cropWidth) });
                    s.runtime.cropFitRatio?.();
                  }}
                  placeholder="1024 px"
                  className="w-20 h-6 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] text-neutral-700 dark:text-neutral-200"
                />
              </label>
              <label className="flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400" title="输出高度(可带单位)">
                H
                <input
                  value={s.options.cropHeight}
                  onChange={(e) => {
                    setOptions(tabId, { cropHeight: normalizeLength(e.target.value, s.options.cropHeight) });
                    s.runtime.cropFitRatio?.();
                  }}
                  placeholder="768 px"
                  className="w-20 h-6 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] text-neutral-700 dark:text-neutral-200"
                />
              </label>
              <label className="flex items-center gap-1 text-[11px] text-neutral-500 dark:text-neutral-400" title="输出分辨率:物理单位按它换算;提交时写入文档(空=沿用文档 ppi;仅填分辨率=只改 ppi 不重采样)">
                分辨率
                <input
                  value={s.options.cropResolution}
                  onChange={(e) => setOptions(tabId, { cropResolution: normalizeResolution(e.target.value, s.options.cropResolution) })}
                  placeholder="300"
                  className="w-14 h-6 rounded border border-black/15 dark:border-white/15 bg-transparent px-1 text-[11px] text-neutral-700 dark:text-neutral-200"
                />
              </label>
              <EditorSelect
                value={s.options.cropResolutionUnit}
                onChange={(v) => setOptions(tabId, { cropResolutionUnit: v as 'px/in' | 'px/cm' })}
                title="分辨率单位"
                className="w-20"
                options={[
                  { value: 'px/in', label: 'px/in' },
                  { value: 'px/cm', label: 'px/cm' },
                ]}
              />
              <button
                title="交换 W 与 H (X)"
                onClick={() => {
                  setOptions(tabId, { cropWidth: s.options.cropHeight, cropHeight: s.options.cropWidth });
                  s.runtime.cropFitRatio?.();
                }}
                className="px-2 py-0.5 rounded border border-black/15 dark:border-white/15 text-[11px] text-neutral-600 dark:text-neutral-300 hover:bg-black/5 dark:hover:bg-white/10"
              >
                ⇄
              </button>
            </>
          ) : null}
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
                {CROP_MENU.map((r) => {
                  const preset = whrPresetFields(r.v);
                  return (
                    <div
                      key={r.v || 'free'}
                      className="mx-1.5 px-3 py-1.5 rounded hover:bg-blue-600 hover:text-white cursor-pointer whitespace-nowrap text-[12px] flex items-center gap-2"
                      onClick={() => {
                        if (r.v === 'front') {
                          // 前景图像:按文档尺寸(px)+文档分辨率回填字段并立即应用
                          // (上游 Front Image 即用即弃,裁剪工具内 I 键同款)
                          const doc = s.state;
                          if (doc) {
                            setOptions(tabId, {
                              cropRatio: 'whr',
                              cropWidth: `${doc.width} px`,
                              cropHeight: `${doc.height} px`,
                              cropResolution: doc.resolution ? String(Math.round(doc.resolution)) : '',
                            });
                            s.runtime.cropFitRatio?.();
                          }
                          setRatioOpen(false);
                          return;
                        }
                        // 尺寸预设:字段一并回填并切到 W×H×分辨率模式(preset key 不保留,
                        // 上游 crop_size::chosen 口径);比例预设只换 key
                        setOptions(tabId, {
                          cropRatio: preset ? 'whr' : r.v,
                          ...(preset ? { cropWidth: preset.w, cropHeight: preset.h, cropResolution: preset.res, cropResolutionUnit: 'px/in' as const } : {}),
                        });
                        if (r.v) s.runtime.cropFitRatio?.();
                        setRatioOpen(false);
                      }}
                    >
                      <span>{r.label}</span>
                      {s.options.cropRatio === r.v && <Check size={12} className="ml-auto opacity-80" />}
                    </div>
                  );
                })}
              </div>,
              document.body,
            )}
        </>
      ) : s.tool === 'gradient' ? (
        <>
          <EditorSelect
            value={s.options.gradientClassic ? 'classic' : 'live'}
            onChange={(v) => setOptions(tabId, { gradientClassic: v === 'classic' })}
            title="渐变模式:渐变图层=非破坏渐变填充图层(拖线创建/选中即可再编辑);经典渐变=直接涂在像素上"
            options={[
              { value: 'live', label: '渐变图层' },
              { value: 'classic', label: '经典渐变' },
            ]}
          />
          <EditorSelect
            value={s.options.gradientBlend}
            onChange={(v) => {
              setOptions(tabId, { gradientBlend: v });
              // Live 同步(上游 options_changed 的 blend 分支):选中渐变图层直接改它
              if (liveFill) void runCommand(tabId, 'layer.setProps', { layer: liveFill.layer, blend: v }).catch(() => undefined);
            }}
            title="混合模式:经典渐变=涂像素时的混合;渐变图层=改选中图层"
            options={(s.state?.blendModes ?? ['Normal']).map((b) => ({ value: b, label: BLEND_ZH[b] ?? b }))}
          />
          <button
            ref={presetBtnRef}
            title={`渐变预设:${s.options.gradientCurrent.name}(单击选择,双击建渐变填充图层;渐变工具激活时右侧面板可编辑停靠点)`}
            onClick={() => {
              const r = presetBtnRef.current?.getBoundingClientRect();
              if (r) setPresetPos({ left: r.left, top: r.bottom + 4 });
              setPresetOpen((v) => !v);
            }}
            className="h-4 w-24 rounded-sm border border-black/25 dark:border-white/30"
            style={{
              backgroundImage: `${gradCss}, repeating-conic-gradient(rgba(128,128,128,0.45) 0% 25%, transparent 0% 50%)`,
              backgroundSize: '100% 100%, 8px 8px',
            }}
          />
          <div className="flex items-center gap-0.5" title="渐变样式">
            {GRADIENT_STYLES.map(({ style, label }) => (
              <button
                key={style}
                title={label}
                onClick={() => {
                  setOptions(tabId, { gradientStyle: style });
                  if (liveFill) void runCommand(tabId, 'gradient.fill.set', { layer: liveFill.layer, style }).catch(() => undefined);
                }}
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
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
            不透明度
            <input
              type="range" min={1} max={100} value={Math.round(s.options.gradientOpacity * 100)}
              onPointerDown={() => { opacityDragRef.current += 1; markInteractiveRender(tabId, 1200); }}
              onPointerUp={() => { markInteractiveRender(tabId, 0); }}
              onPointerCancel={() => { markInteractiveRender(tabId, 0); }}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                setOptions(tabId, { gradientOpacity: v });
                // Live 同步(上游 opacity_changed):拖动 coalesce 成一个 undo 步
                if (liveFill) {
                  markInteractiveRender(tabId, 1200);
                  void runCommand(tabId, 'layer.setProps', { layer: liveFill.layer, opacity: v, coalesce: `gradient-tool-opacity:${opacityDragRef.current}` }).catch(() => undefined);
                }
              }}
              className="w-20 accent-sky-600"
            />
            <span className="w-8 tabular-nums text-neutral-700 dark:text-neutral-300">{Math.round(s.options.gradientOpacity * 100)}%</span>
          </label>
          <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400" title="反向:渐变起止互换">
            <input
              type="checkbox" checked={s.options.gradientReverse}
              onChange={(e) => {
                setOptions(tabId, { gradientReverse: e.target.checked });
                if (liveFill) void runCommand(tabId, 'gradient.fill.set', { layer: liveFill.layer, reverse: e.target.checked }).catch(() => undefined);
              }}
              className="accent-sky-600"
            />
            反向
          </label>
          <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400" title="仿色:抖动过渡减少色带">
            <input
              type="checkbox" checked={s.options.gradientDither}
              onChange={(e) => {
                setOptions(tabId, { gradientDither: e.target.checked });
                if (liveFill) void runCommand(tabId, 'gradient.fill.set', { layer: liveFill.layer, dither: e.target.checked }).catch(() => undefined);
              }}
              className="accent-sky-600"
            />
            仿色
          </label>
          {presetOpen &&
            createPortal(
              <div
                ref={presetMenuRef}
                className="fixed z-[1000] w-72 max-h-[60vh] overflow-y-auto rounded-md bg-[#FAFAFA]/90 dark:bg-[#3a3a3a]/90 backdrop-blur-md shadow-[0_8px_30px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.6)] text-gray-800 dark:text-gray-200 py-1.5"
              >
                {GRADIENT_GROUPS.map((g) => (
                  <div key={g.name}>
                    <div className="px-3 pt-1.5 pb-0.5 text-[10px] text-neutral-500 dark:text-neutral-400">{g.name}</div>
                    <div className="grid grid-cols-2 gap-1 px-2 pb-1">
                      {g.presets.map((p) => (
                        <button
                          key={p.name}
                          title={p.name}
                          onClick={() => {
                            // 单击=选为当前渐变(弹层保持开,上游预设面板同款;外点关闭)
                            setOptions(tabId, { gradientCurrent: clonePreset(p) });
                          }}
                          onDoubleClick={() => {
                            // 双击=建层(上游 Ev::Activate → gradient.presets.apply,PS 口径);
                            // 当前渐变同步载入=色板高亮跟随双击(上游 Ev::Activate 同款
                            // ui.selected.insert,选中态回显)
                            setOptions(tabId, { gradientCurrent: clonePreset(p) });
                            setPresetOpen(false);
                            void runCommand(tabId, 'gradient.presets.apply', { preset: p.name })
                              .catch((err) => console.error('[editor] gradient.presets.apply 失败', err));
                          }}
                          className={`h-5 rounded-sm border ${
                            s.options.gradientCurrent.name === p.name
                              ? 'border-sky-500 ring-1 ring-sky-500'
                              : 'border-black/15 dark:border-white/20 hover:border-sky-400'
                          }`}
                          style={{
                            backgroundImage: `${presetCss(p, s.state?.foreground, s.state?.background)}, repeating-conic-gradient(rgba(128,128,128,0.45) 0% 25%, transparent 0% 50%)`,
                            backgroundSize: '100% 100%, 8px 8px',
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </div>,
              document.body,
            )}
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
        </>
      ) : s.tool === 'pen' ? (
        // 上游钢笔选项条的操作提示文案(控件 二-4/二-5 随 vector_mode/路径面板接入)
        <span className="text-neutral-500 dark:text-neutral-400">单击=加锚点 · 拖拽=拉出手柄 · 点击首锚=闭合 · Alt=断开/抓柄 · Ctrl+Z/⌫=退点 · Enter/Esc=保留开放路径 · 切工具自动提交</span>
      ) : SHAPE_GROUP.has(s.tool) ? (
        <>
          {/* 形状族(上游 shape_options):fill=前景色开/关,stroke=背景色+宽度;
           * 描边样式按钮(虚线/端点/箭头)与选中形状联动编辑后置 */}
          <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400" title="填充=前景色(工具栏色芯片换色)">
            <input
              type="checkbox" checked={s.options.shapeFill}
              onChange={(e) => setOptions(tabId, { shapeFill: e.target.checked })}
              className="accent-sky-600"
            />
            填充
            <span className="inline-block w-3.5 h-3.5 rounded-sm border border-black/30 dark:border-neutral-500"
              style={{ background: rgbCss(s.state?.foreground) }} />
          </label>
          <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400" title="描边=背景色;0=无描边">
            描边
            <span className="inline-block w-3.5 h-3.5 rounded-sm border border-black/30 dark:border-neutral-500"
              style={{ background: rgbCss(s.state?.background) }} />
            <input
              type="number" min={0} max={288} value={s.options.strokeWidth}
              onChange={(e) => setOptions(tabId, { strokeWidth: Math.max(0, Math.min(288, Number(e.target.value) || 0)) })}
              className="w-14 px-1.5 py-0.5 text-[11px] rounded border border-subtle bg-panel text-gray-800 dark:text-gray-200 outline-none tabular-nums"
            />
            <span className="text-neutral-500 dark:text-neutral-400">px</span>
          </label>
          {s.tool === 'rectShape' && (
            <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400">
              半径
              <input
                type="number" min={0} max={1000} value={s.options.cornerRadius}
                onChange={(e) => setOptions(tabId, { cornerRadius: Math.max(0, Number(e.target.value) || 0) })}
                className="w-14 px-1.5 py-0.5 text-[11px] rounded border border-subtle bg-panel text-gray-800 dark:text-gray-200 outline-none tabular-nums"
              />
              <span className="text-neutral-500 dark:text-neutral-400">px</span>
            </label>
          )}
          {s.tool === 'polygonShape' && (
            <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400" title="3..100">
              边数
              <input
                type="number" min={3} max={100} value={s.options.polygonSides}
                onChange={(e) => setOptions(tabId, { polygonSides: Math.max(3, Math.min(100, Math.round(Number(e.target.value)) || 3)) })}
                className="w-14 px-1.5 py-0.5 text-[11px] rounded border border-subtle bg-panel text-gray-800 dark:text-gray-200 outline-none tabular-nums"
              />
            </label>
          )}
          {s.tool === 'lineShape' && (
            <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400" title="1..1000">
              粗细
              <input
                type="number" min={1} max={1000} value={s.options.lineWeight}
                onChange={(e) => setOptions(tabId, { lineWeight: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })}
                className="w-14 px-1.5 py-0.5 text-[11px] rounded border border-subtle bg-panel text-gray-800 dark:text-gray-200 outline-none tabular-nums"
              />
              <span className="text-neutral-500 dark:text-neutral-400">px</span>
            </label>
          )}
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
          <EditorSelect
            value={s.options.moveTarget}
            disabled={!s.options.moveAutoSelect}
            onChange={(v) => setOptions(tabId, { moveTarget: v as ToolOptions['moveTarget'] })}
            title="Auto-Select 的拾取目标:图层 / 最外层编组"
            options={[
              { value: 'layer', label: '图层' },
              { value: 'group', label: '组' },
            ]}
          />
        </>
      ) : null}
      <div className="flex-1" />
    </div>
  );
};
