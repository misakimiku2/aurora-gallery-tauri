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
import { Square, PlusSquare, MinusSquare, XSquare, X, Check, CircleOff, Ruler, Magnet, ChevronDown } from 'lucide-react';
import { clonePreset, GRADIENT_GROUPS, presetCss } from './gradientPresets';
import { peekGradientFill } from './gradientFill';
import { isWhrKey, normalizeLength, normalizeResolution, WHR_PRESETS, whrPresetFields } from './cropSize';
import { SHAPE_GROUP } from './toolLogic';
import { TYPE_TOOLS } from './typeLogic';
import { activePathName, pathRows } from './pathsPanelLogic';
import { EditorSelect, attachWheelCycle } from './editorSelect';
import { ColorPicker } from './panels/ColorPicker';
import { PickerCard } from './panels/PickerCard';
import { NumField } from './panels/TypePanel';
import { matchingAnchor, movePivotTo, rotateAboutPivot, scaleAboutPivot, setPivotAnchor, readout as transformReadout, type TransformMode, type TransformSession } from './transformLogic';
import { applyTypeStyle, fetchFontFaces, fetchFontFamilies, noteRecentFont, runCommand } from './editorStore';
import {
  AA_OPTIONS, aaKey, selectedStyleName, styleAt, styleColorHex, styleLabel, styleNames, shownScale,
  type CharStyleJson, type FaceInfoJson,
} from './typeStyle';

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

/** 应用一个比例菜单项(菜单点击与悬停滚轮共用):'front'=前景图像即用即弃回填字段;
 * 尺寸预设=回填 W/H/分辨率并切 W×H×分辨率;其余只换比例键(v 非空才内缩适配)。 */
const applyCropMenu = (tabId: string, v: string): void => {
  const s = getSession(tabId);
  if (!s) return;
  if (v === 'front') {
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
    return;
  }
  const preset = whrPresetFields(v);
  setOptions(tabId, {
    cropRatio: preset ? 'whr' : v,
    ...(preset ? { cropWidth: preset.w, cropHeight: preset.h, cropResolution: preset.res, cropResolutionUnit: 'px/in' as const } : {}),
  });
  if (v) s.runtime.cropFitRatio?.();
};

export const EditorOptionsBar: React.FC<{ tabId: string; active?: boolean }> = ({ tabId, active = true }) => {
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
  // 比例按钮悬停滚轮=步进应用菜单项(与 EditorSelect 滚轮同口径;弹层开着交给菜单滚动)。
  // deps 带 isCrop:按钮只在裁剪工具分支挂载,工具切换后需重跑才能绑上
  const isCrop = getSession(tabId)?.tool === 'crop';
  useEffect(() => {
    const el = ratioBtnRef.current;
    if (!el || ratioOpen || !isCrop) return undefined;
    return attachWheelCycle(el, CROP_MENU.length, () => CROP_MENU.findIndex((r) => r.v === getSession(tabId)?.options.cropRatio), (i) => applyCropMenu(tabId, CROP_MENU[i].v));
  }, [tabId, ratioOpen, isCrop]);
  const s = getSession(tabId);
  if (!s) return null;
  // 建立选区按钮的可用性(上游 has_path:面板选中→工作路径→活动层路径;钢笔草稿在画
  // 的情形由画布侧 Ctrl+Enter 兜底,按钮不为此追踪草稿)
  const hasPathForSelection = activePathName(pathRows(s.pathsList), s.selectedPath) != null;
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
      {s.transform ? (
        // 自由变换框打开:变换字段替换当前工具选项(上游 options_bar 同位)
        <TransformOptionsInline tabId={tabId} />
      ) : isBrush ? (
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
                  return (
                    <div
                      key={r.v || 'free'}
                      className="mx-1.5 px-3 py-1.5 rounded hover:bg-blue-600 hover:text-white cursor-pointer whitespace-nowrap text-[12px] flex items-center gap-2"
                      onClick={() => {
                        applyCropMenu(tabId, r.v);
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
        <>
          {/* 钢笔模式(上游 vector_mode 下拉):形状=提交建形状层;路径=进工作路径 */}
          <EditorSelect
            value={s.options.penVectorMode}
            onChange={(v) => setOptions(tabId, { penVectorMode: v as 'path' | 'shape' })}
            className="w-20"
            title="钢笔绘制目标"
            options={[{ value: 'path', label: '路径' }, { value: 'shape', label: '形状' }]}
          />
          {s.options.penVectorMode === 'shape' && (
            <label className="flex items-center gap-1.5 text-neutral-500 dark:text-neutral-400" title="描边=背景色;0=无描边;开放路径描边=前景色且宽度至少 1">
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
          )}
          <label className="flex items-center gap-1 text-neutral-500 dark:text-neutral-400" title="点击段=加锚、点击锚=删锚(开放子路径端点除外);⇧/⌥/⌘ 按住时关闭">
            <input
              type="checkbox" checked={s.options.penAutoAddDelete}
              onChange={(e) => setOptions(tabId, { penAutoAddDelete: e.target.checked })}
              className="accent-sky-600"
            />
            自动添加/删除
          </label>
          {s.options.penVectorMode === 'path' && (
            <button
              title="把当前路径(钢笔草稿先提交)作为选区载入 (Ctrl+Enter)"
              disabled={!hasPathForSelection}
              onClick={() => getSession(tabId)?.runtime.makeSelection?.()}
              className="px-2 py-0.5 text-[11px] rounded border border-subtle text-gray-600 dark:text-gray-300 hover:bg-black/5 dark:hover:bg-white/10 disabled:opacity-30"
            >
              建立选区
            </button>
          )}
          <span className="text-neutral-500 dark:text-neutral-400">单击=加锚点 · 拖拽=拉出手柄 · 点击首锚=闭合 · Alt=断开/抓柄/转换点 · Ctrl=直接选择 · Ctrl+Z/⌫=退点 · Enter/Esc=保留开放路径</span>
        </>
      ) : s.tool === 'directSelect' ? (
        <span className="text-neutral-500 dark:text-neutral-400">点选锚点(⇧ 加减 / Alt 整条子路径)· 空白拖拽=框选 · 拖锚/手柄/段编辑 · 方向键微移(⇧×10)</span>
      ) : s.tool === 'addAnchor' || s.tool === 'deleteAnchor' ? (
        <span className="text-neutral-500 dark:text-neutral-400">{s.tool === 'addAnchor' ? '点击段=加锚点(曲线原形分割) · Alt=换删除锚点 · Ctrl=直接选择' : '点击锚=删除(邻锚以原手柄接续) · Alt=换添加锚点 · Ctrl=直接选择'}</span>
      ) : s.tool === 'convertPoint' ? (
        <span className="text-neutral-500 dark:text-neutral-400">点击锚=转角点 · 从锚拖拽=拉出平滑手柄 · 拖手柄=单独动 · Ctrl=直接选择</span>
      ) : TYPE_TOOLS.has(s.tool) ? (
        // 文字工具选项条(二-7,上游 options_bar):横竖切换/字体/样式/字号/抗锯齿/对齐/段落方向/
        // 文字颜色;会话中加 ✓ 提交(取消=Esc 提交后 Ctrl+Z 一步全撤)。完整字符字段在「字符」页签。
        <TypeOptionsInline tabId={tabId} active={active} />
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

/** 目标层参数(无编辑会话=活动/选中 Type 层;无目标 null)。 */
const layerParams = (tabId: string): Record<string, unknown> | null => {
  const s = getSession(tabId);
  if (!s?.state) return null;
  const ids = s.state.selectedLayers.length ? s.state.selectedLayers : s.state.activeLayer != null ? [s.state.activeLayer] : [];
  const kindOf = (id: number): string | null => {
    type KindNode = { id: number; kind: string; children?: KindNode[] };
    const walk = (ls: KindNode[], id: number): string | null => {
      for (const l of ls) {
        if (l.id === id) return l.kind;
        if (l.children) { const f = walk(l.children, id); if (f) return f; }
      }
      return null;
    };
    return walk(s.state!.layers as unknown as KindNode[], id);
  };
  const id = ids.find((i) => kindOf(i) === 'Type');
  return id != null ? { layer: id } : null;
};

/** 引擎 Orientation 读回(选项条按钮态;无目标=工具侧)。 */
const orientV = (tool?: string): boolean => tool === 'typeVertical';

/** 会话中文字符样式回显(选区起点 run;无会话=工具默认)。上游 options_bar 的 shown。
 *  active=本标签非前台/设置模态打开时,portal 的文字颜色卡要藏起(EditorShell 传入)。 */
const TypeOptionsInline: React.FC<{ tabId: string; active?: boolean }> = ({ tabId, active = true }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  const [families, setFamilies] = useState<string[]>([]);
  const [faces, setFaces] = useState<FaceInfoJson[]>([]);
  const [info, setInfo] = useState<{ runs: { start: number; end: number; style: CharStyleJson }[]; transform: number[]; antialias: string } | null>(null);
  const [colorPick, setColorPick] = useState<[number, number, number] | null>(null);
  const [sizeBuf, setSizeBuf] = useState('12');
  const sizeBufRef = useRef(sizeBuf);
  sizeBufRef.current = sizeBuf;
  const sizeInputRef = useRef<HTMLInputElement>(null);
  const ed = s?.textEdit ?? null;

  useEffect(() => { void fetchFontFamilies(tabId).then(setFamilies); }, [tabId]);
  const at = ed ? Math.min(ed.caret, ed.anchor) : 0;
  const rev = s?.revision ?? 0;
  useEffect(() => {
    let alive = true;
    const layer = getSession(tabId)?.textEdit?.layer;
    if (layer == null) { setInfo(null); return undefined; }
    void runCommand(tabId, 'type.info', { layer }, { noPull: true })
      .then((r) => { if (alive) setInfo(r as never); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [tabId, ed?.layer, rev]);
  const c = info ? styleAt(info.runs, at) : null;
  const scale = shownScale(info?.transform);
  const fam = c?.font_family ?? s?.options.typeFont ?? 'Inter';
  useEffect(() => {
    let alive = true;
    void fetchFontFaces(tabId, fam).then((f) => { if (alive) setFaces(f); });
    return () => { alive = false; };
  }, [tabId, fam]);
  const sizeShown = (c?.size_pt ?? s?.options.typeSize ?? 12) * scale;
  useEffect(() => { setSizeBuf(String(Math.round(sizeShown * 100) / 100)); }, [sizeShown]);
  // 字号提交闭包(滚轮恒读最新:闭包里 scale/apply 随渲染变;每渲染刷新)
  const applySizeRef = useRef<(n: number) => void>(() => undefined);
  applySizeRef.current = (n: number) => {
    if (Number.isFinite(n) && n >= 0.1 && n <= 1296 && Math.abs(n - sizeShown) > 0.01) {
      apply(scale !== 1 ? { size: n / scale, metricsAsShown: true } : { size: n });
    } else setSizeBuf(String(Math.round(sizeShown * 100) / 100));
  };
  // 悬停滚轮调字号(同字符页签 NumField:一格=±1、Shift=±10,停手 300ms 提交一次)
  useEffect(() => {
    const el = sizeInputRef.current;
    if (!el) return undefined;
    let acc = 0;
    let timer: number | null = null;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      acc += e.deltaY * (e.deltaMode === 1 ? 16 : 1);
      let steps = 0;
      while (Math.abs(acc) >= 100) {
        steps += acc > 0 ? -1 : 1;
        acc -= acc > 0 ? 100 : -100;
      }
      if (!steps) return;
      const cur = Number(sizeBufRef.current);
      if (!Number.isFinite(cur)) return;
      const next = Math.min(1296, Math.max(0.1, cur + steps * (e.shiftKey ? 10 : 1)));
      setSizeBuf(String(Math.round(next * 100) / 100));
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => { applySizeRef.current(next); }, 300);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      if (timer != null) window.clearTimeout(timer);
    };
  }, []);
  if (!s) return null;
  const styleShown = c ? selectedStyleName(c, faces) : s.options.typeStyle || 'Regular';
  const apply = (props: Record<string, unknown>) => { void applyTypeStyle(tabId, props); };
  const styleOpts = styleNames(faces).map((n) => ({ value: n, label: styleLabel(n) }));
  const hex = c ? styleColorHex(c.color) : '';
  const aa = info ? aaKey(info.antialias) : s.options.typeAA;
  const btn = 'w-6 h-6 rounded text-[11px] flex items-center justify-center transition-colors ';
  const idle = 'text-neutral-500 dark:text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10';
  const onCls = 'bg-sky-500/15 text-sky-700 dark:text-sky-300';
  const vTarget = ed ? orientV() : s.tool === 'typeVertical';
  const scopeParams = ed ? { layer: ed.layer, coalesce: ed.session } : layerParams(tabId);

  return (
    <>
      {/* 横竖切换(type.orientation.*;上游 options_bar 的 orientation 钮) */}
      <button
        type="button" title={vTarget ? '切换为横排' : '切换为竖排'}
        onClick={() => {
          const to = vTarget ? 'horizontal' : 'vertical';
          if (scopeParams) void runCommand(tabId, `type.orientation.${to}`, scopeParams).catch(() => undefined);
        }}
        className={btn + idle}
      >
        T
      </button>
      <EditorSelect
        value={fam}
        searchable
        options={[
          ...s.options.typeRecentFonts.map((f) => ({ value: f, label: f, group: '最近使用' })),
          ...families.map((f) => ({ value: f, label: f })),
        ]}
        onChange={(v) => {
          noteRecentFont(tabId, v);
          const keep = styleOpts.some((o) => o.value === s.options.typeStyle);
          setOptions(tabId, { typeFont: v, typeStyle: keep ? s.options.typeStyle : 'Regular' });
          apply({ font: v });
        }}
        className="w-36 shrink-0"
        title="字体族"
        disabled={families.length === 0}
      />
      <EditorSelect
        value={styleShown}
        options={styleOpts}
        onChange={(v) => { setOptions(tabId, { typeStyle: v }); apply({ fontStyle: v }); }}
        className="w-24 shrink-0"
        title="字体样式"
        disabled={faces.length === 0}
      />
      {/* 字号(×层变换显示;metricsAsShown) */}
      <span className="text-[11px] text-neutral-500 dark:text-neutral-400" title="字号">T</span>
      <input
        ref={sizeInputRef}
        value={sizeBuf}
        onChange={(e) => setSizeBuf(e.target.value)}
        onBlur={() => {
          const n = Number(sizeBuf);
          if (Number.isFinite(n) && n >= 0.1 && n <= 1296 && Math.abs(n - sizeShown) > 0.01) {
            apply(scale !== 1 ? { size: n / scale, metricsAsShown: true } : { size: n });
          } else setSizeBuf(String(Math.round(sizeShown * 100) / 100));
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLInputElement).blur(); }
          e.stopPropagation();
        }}
        className="w-14 px-1.5 py-0.5 text-[11px] rounded border border-subtle bg-panel text-gray-800 dark:text-neutral-200 outline-none focus:border-sky-500 tabular-nums"
        title="字号 pt"
      />
      <EditorSelect
        value={aa}
        options={AA_OPTIONS}
        onChange={(v) => {
          setOptions(tabId, { typeAA: v });
          if (scopeParams) void runCommand(tabId, `type.antiAlias.${v}`, scopeParams).catch(() => undefined);
        }}
        className="w-20 shrink-0"
        title="抗锯齿"
      />
      <div className="w-px h-5 bg-black/10 dark:bg-white/15 mx-1" />
      {(['left', 'center', 'right'] as const).map((a) => (
        <button
          key={a} type="button" title={a === 'left' ? '左对齐' : a === 'center' ? '居中对齐' : '右对齐'}
          onClick={() => { setOptions(tabId, { typeAlign: a }); apply({ align: a }); }}
          className={btn + (s.options.typeAlign === a ? onCls : idle)}
        >
          {a === 'left' ? '≡L' : a === 'center' ? '≡C' : '≡R'}
        </button>
      ))}
      <div className="w-px h-5 bg-black/10 dark:bg-white/15 mx-1" />
      {['auto', 'ltr', 'rtl'].map((d) => (
        <button
          key={d} type="button" title={d === 'auto' ? '自动段落方向' : d === 'ltr' ? '从左到右' : '从右到左'}
          onClick={() => { setOptions(tabId, { typeDirection: d }); apply({ direction: d }); }}
          className={btn + (s.options.typeDirection === d ? onCls : idle)}
        >
          {d === 'auto' ? '¶↔' : d === 'ltr' ? '¶→' : '←¶'}
        </button>
      ))}
      <div className="w-px h-5 bg-black/10 dark:bg-white/15 mx-1" />
      {/* 文字颜色芯片(取色卡;编辑中=选区/整层,无目标=工具默认) */}
      <button
        type="button" title="文字颜色"
        className="w-7 h-5 rounded-sm border border-black/30 dark:border-neutral-500"
        style={{ background: hex || rgbCss(s.state?.foreground) }}
        onClick={() => { const h = hex || '#000000'; setColorPick([parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255]); }}
      />
      {colorPick && active && (
        <PickerCard
          title="文字颜色"
          storageKey="aurora-editor-text-color-card"
          onClose={() => setColorPick(null)}
        >
          <ColorPicker
            value={colorPick}
            onCommit={(rgb) => {
              const h = `#${rgb.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`;
              apply({ color: h });
            }}
          />
        </PickerCard>
      )}
      {ed && (
        <button
          type="button" title="提交文字编辑 (Ctrl+Enter);取消=Esc 提交后 Ctrl+Z 一步全撤"
          onClick={() => s.runtime.commitTextEdit?.()}
          className={btn + idle + ' ml-1 text-emerald-600 dark:text-emerald-400'}
        >
          <Check size={13} />
        </button>
      )}
    </>
  );
};

// ===== 自由变换选项段(二-8,上游 transform_tool::options_bar)=====
// 字段:9 宫格参考点 / X / Y / W / H(恒等比,上游链接口径) / 角度 / 斜切 H·V / 模式 / 插值
// / ✓✗。改值走 runtime.transformField(mutate 画布 ref 真源+落定推栈+回写投影);
// 显示源 = store.transform 投影(拖拽中不逐帧更新,松手后跟随,读数在画布上实时)。

const TRANSFORM_MODES: Array<{ v: TransformMode; label: string }> = [
  { v: 'free', label: '自由' },
  { v: 'rotate', label: '旋转' },
  { v: 'skew', label: '斜切' },
  { v: 'distort', label: '扭曲' },
  { v: 'perspective', label: '透视' },
];
const INTERP_OPTIONS = [
  { value: 'bicubic', label: '三次' },
  { value: 'bilinear', label: '两次线性' },
  { value: 'nearest', label: '邻近(硬边)' },
];

const TransformOptionsInline: React.FC<{ tabId: string }> = ({ tabId }) => {
  const [, forceUpdate] = useState(0);
  useEffect(() => subscribeSession(tabId, () => forceUpdate((n) => n + 1)), [tabId]);
  const s = getSession(tabId);
  const t = s?.transform;
  if (!s || !t) return null;
  const r = transformReadout(t);
  const anchor = matchingAnchor(t.quad, t.pivot);
  const field = (fn: (v: TransformSession) => TransformSession) => () => s.runtime.transformField?.(fn);
  // 窄窗口适配(编辑器列可低至 ~640px):字段定宽+保底(shrink 允许微缩但 min-w 兜住),
  // 砍斜切 H/V 字段(与 Ctrl+边拖手势冗余;数值化后置),总宽 ≈600px 不再挤压变形。
  const lbl = 'w-4 shrink-0 text-[10px] text-neutral-500 dark:text-neutral-400 text-center';
  const fw = 'w-[3.25rem] min-w-[3rem]';
  const fa = 'w-11 min-w-[2.75rem]';
  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-nowrap" data-testid="transform-options">
      {/* 9 宫格参考点(上游 anchor_grid_widget;0..8 = TL..BR) */}
      <div className="shrink-0 grid grid-cols-3 gap-[2px] p-[3px] border border-black/15 dark:border-white/15 rounded" title="参考点位置">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
          <button
            key={i}
            type="button"
            onClick={() => s.runtime.transformField?.((v) => setPivotAnchor(v, i))}
            className={`h-[7px] w-[7px] ${anchor === i ? 'bg-sky-500' : 'bg-neutral-400 dark:bg-neutral-600 hover:bg-sky-400'}`}
          />
        ))}
      </div>
      <span className={lbl}>X</span>
      <NumField compact label="" tip="参考点 X(方向键微移整框)" value={t.pivot[0]} min={-300000} max={300000} unit="" onCommit={(x) => s.runtime.transformField?.((v) => movePivotTo(v, x, v.pivot[1]))} width={fw} />
      <span className={lbl}>Y</span>
      <NumField compact label="" tip="参考点 Y" value={t.pivot[1]} min={-300000} max={300000} unit="" onCommit={(y) => s.runtime.transformField?.((v) => movePivotTo(v, v.pivot[0], y))} width={fw} />
      <span className="w-px h-4 shrink-0 bg-black/10 dark:bg-white/10" />
      <span className={lbl}>W</span>
      <NumField compact label="" tip="宽度百分比(恒等比;负值=水平镜像)" value={r.wPct} min={-1000000} max={1000000} unit="%" onCommit={(w) => s.runtime.transformField?.((v) => {
        const cur = transformReadout(v).wPct;
        const k = w / (Math.abs(cur) < 1e-9 ? 1e-9 : cur);
        return scaleAboutPivot(v, k, k);
      })} width={fw} />
      <span className={lbl}>H</span>
      <NumField compact label="" tip="高度百分比(恒等比;负值=垂直镜像)" value={r.hPct} min={-1000000} max={1000000} unit="%" onCommit={(h) => s.runtime.transformField?.((v) => {
        const cur = transformReadout(v).hPct;
        const k = h / (Math.abs(cur) < 1e-9 ? 1e-9 : cur);
        return scaleAboutPivot(v, k, k);
      })} width={fw} />
      <span className={lbl}>角</span>
      <NumField compact label="" tip="旋转(绕参考点;±180°)" value={r.angleDeg} min={-180} max={180} unit="°" onCommit={(a) => s.runtime.transformField?.((v) => {
        const cur = transformReadout(v).angleDeg;
        return rotateAboutPivot(v, ((a - cur) * Math.PI) / 180);
      })} width={fa} />
      <span className="w-px h-4 shrink-0 bg-black/10 dark:bg-white/10" />
      <EditorSelect
        value={t.mode}
        options={TRANSFORM_MODES.map((m) => ({ value: m.v, label: m.label }))}
        onChange={(v) => field((cur) => ({ ...cur, mode: v as TransformMode }))()}
        className="w-14 shrink-0"
        title="变换模式(Edit › Transform;扭曲/透视=Ctrl/⌘ 拖角,透视=Ctrl+⌥+⇧ 拖角;斜切=Ctrl+拖边)"
      />
      <EditorSelect
        value={t.interpolation}
        options={INTERP_OPTIONS}
        onChange={(v) => field((cur) => ({ ...cur, interpolation: v }))()}
        className="w-12 shrink-0"
        title="插值(提交重采样方式)"
      />
      <button
        type="button" title="应用变换 (Enter)"
        onClick={() => s.runtime.transformCommit?.()}
        className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-emerald-600 dark:text-emerald-400 hover:bg-black/5 dark:hover:bg-white/10"
      >
        <Check size={14} />
      </button>
      <button
        type="button" title="取消变换 (Esc);无改动=零历史"
        onClick={() => s.runtime.transformCancel?.()}
        className="h-6 w-6 shrink-0 flex items-center justify-center rounded text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
      >
        <X size={14} />
      </button>
    </div>
  );
};
