/**
 * 工具选项条（UI 设计 §2 的 ② 区，对应 PS 的 options bar）。
 *
 * 内容随选中工具切换。**只给已经能用的工具配真实控件**；未接入的工具
 * 明说「尚未接入」，不放一堆点了没反应的假控件——那比没有更糟。
 */
import React, { useSyncExternalStore } from 'react';
import type { EditorToolId, LayerBox } from '../../types';
import { getEditorTool, AutoSelectMode } from './editorTools';
import type { BrushSettings } from './useEditorBrush';
import {
  getEditorColors,
  setForeground,
  setBackground,
  subscribeEditorColors,
} from './editorColorStore';
import { colorLuminance, luminanceToHex } from './brushPaint';

interface EditorOptionsBarProps {
  /** `null` = 没有选中工具：这条横栏只留提示，不给任何工具控件 */
  tool: EditorToolId | null;
  scale: number;
  onZoomTo: (scale: number) => void;
  onFit: () => void;
  /** 裁剪框当前尺寸（源图像素）；null = 还没开始拉框 */
  cropRect?: { x: number; y: number; w: number; h: number } | null;
  onCropCommit?: () => void;
  onCropCancel?: () => void;
  /** 当前裁剪宽高比（w/h）；null = 自由 */
  cropRatio?: number | null;
  /** 当前文档的宽高比，供「原始比例」预设使用 */
  docAspect?: number;
  onCropRatioChange?: (ratio: number | null) => void;
  /**
   * 活动图层的定界框——**工具级数值入口就放这条横栏**（设计稿 §10.1：
   * 文档栏放画布级快捷操作，工具级功能放这里；"旋转画布"与"旋转图层"因此不会混）。
   */
  layerBox?: LayerBox;
  onLayerBoxChange?: (patch: Partial<LayerBox>) => void;
  /** 吸附开关（拖动/缩放时贴画布边与中心） */
  snapEnabled?: boolean;
  onSnapToggle?: (enabled: boolean) => void;
  /**
   * 移动工具的「自动选择」（PS 选项条上的下拉）。
   * `layer` = 点谁选谁；`none` = 点画布不改选中层，换层只走图层面板。
   * 缺省按 `layer`——这是编辑器已经硬编码了很久的行为，UI 只是把它接上。
   */
  autoSelect?: AutoSelectMode;
  onAutoSelectChange?: (mode: AutoSelectMode) => void;
  /** 画笔/橡皮参数（大小/硬度/不透明度）；落笔瞬间取值，笔画中途改不影响当前笔 */
  brushSettings?: BrushSettings;
  onBrushSettingsChange?: (next: BrushSettings) => void;
  /** 选中对象是蒙版（画的是灰度：白 = 显示 / 黑 = 隐藏），选项条换提示口径 */
  maskTarget?: boolean;
}

/** 裁剪比例预设（UI 设计 §7.1 的平台封面清单）。`'doc'` = 跟随当前文档比例。 */
const CROP_PRESETS: Array<{ label: string; ratio: number | 'doc' | null }> = [
  { label: '自由', ratio: null },
  { label: '原始比例', ratio: 'doc' },
  { label: '1:1', ratio: 1 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '4:3', ratio: 4 / 3 },
];

const label = 'text-[11px] text-neutral-500 dark:text-neutral-400';
const chip =
  'px-2 h-6 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 text-neutral-500 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-900 cursor-not-allowed';
/** 可点击的比例按钮 */
const ratioBtn =
  'px-2 h-6 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700';
const ratioBtnActive =
  'px-2 h-6 rounded text-[11px] border border-blue-600 bg-blue-600 text-white';
/** 数值输入框（工具级参数，§10.1） */
const numInput =
  'h-6 px-1 rounded text-[11px] tabular-nums border border-neutral-200 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200';

/**
 * 吸附开关。
 *
 * 放在**工具选项条**而不是文档栏：它只作用于当前工具（拖动/缩放时贴边），
 * 与"旋转画布"那类文档级动作不是一个层级（设计稿 §10.1 的分界）。
 */
const SnapToggle: React.FC<{ enabled: boolean; onChange?: (v: boolean) => void }> = ({
  enabled,
  onChange,
}) => (
  <label
    className={`${label} flex items-center gap-1.5 cursor-pointer select-none shrink-0`}
    title="拖动 / 缩放时吸附到画布的四边与中心"
  >
    <input
      type="checkbox"
      checked={enabled}
      onChange={e => onChange?.(e.target.checked)}
      className="accent-blue-600"
    />
    吸附
  </label>
);

export const EditorOptionsBar: React.FC<EditorOptionsBarProps> = ({
  tool,
  scale,
  onZoomTo,
  onFit,
  cropRect,
  onCropCommit,
  onCropCancel,
  cropRatio,
  docAspect,
  onCropRatioChange,
  layerBox,
  onLayerBoxChange,
  snapEnabled = true,
  onSnapToggle,
  autoSelect = 'layer',
  onAutoSelectChange,
  brushSettings,
  onBrushSettingsChange,
  maskTarget = false,
}) => {
  const def = getEditorTool(tool);
  const colors = useSyncExternalStore(subscribeEditorColors, getEditorColors);
  // 画笔画前景色；橡皮在蒙版上画背景色的亮度（图层上则是擦除，颜色不参与）
  const activeColor = tool === 'eraser' ? colors.background : colors.foreground;

  return (
    <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 select-none overflow-x-auto">
      <span className="text-[11px] font-medium text-neutral-800 dark:text-neutral-100 shrink-0">
        {tool === null ? '未选择工具' : def.label}
      </span>
      <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 shrink-0" />

      {tool === null && (
        <span className="text-[11px] text-neutral-400 dark:text-neutral-500">
          点左侧工具箱或按快捷键选择工具；滚轮缩放 / 空格平移始终可用
        </span>
      )}

      {tool === 'move' && (
        <>
          <span className={label}>自动选择</span>
          <select
            value={autoSelect}
            onChange={e => onAutoSelectChange?.(e.target.value as AutoSelectMode)}
            title="点画布时是否自动切到被点中的那一层"
            className="h-6 px-1 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-700 dark:text-neutral-200 outline-none cursor-pointer"
          >
            <option value="none">无</option>
            <option value="layer">图层</option>
          </select>
          <SnapToggle enabled={snapEnabled} onChange={onSnapToggle} />
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">
            拖动图层移动位置 · Ctrl+T 进入自由变换
          </span>
        </>
      )}

      {tool === 'crop' && (
        <>
          <div className="flex items-center gap-1">
            {CROP_PRESETS.map(p => {
              // 'doc' 要落到当前文档的真实比例上；拿不到就禁用这一项
              const value = p.ratio === 'doc' ? (docAspect ?? null) : p.ratio;
              // 浮点比较用容差：16/9 两次算出来是同值，但别指望 null/0 以外的相等
              const active = Math.abs((value ?? 0) - (cropRatio ?? 0)) < 1e-6;
              return (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => onCropRatioChange?.(value)}
                  disabled={p.ratio === 'doc' && !docAspect}
                  className={active ? ratioBtnActive : ratioBtn}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <span className={`${label} ml-2`}>宽 × 高</span>
          <span className="text-[11px] tabular-nums text-neutral-700 dark:text-neutral-200 w-24 shrink-0">
            {cropRect ? `${Math.round(cropRect.w)} × ${Math.round(cropRect.h)}` : '— × —'}
          </span>
          <div className="flex items-center gap-1 ml-1">
            <button
              type="button"
              onClick={onCropCommit}
              className="px-2.5 h-6 rounded text-[11px] bg-blue-600 text-white hover:bg-blue-700"
            >
              应用裁剪
            </button>
            <button
              type="button"
              onClick={onCropCancel}
              className="px-2.5 h-6 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              取消
            </button>
          </div>
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">
            Enter 应用 · Esc 取消 · 拖动框内可移动
          </span>
        </>
      )}

      {tool === 'hand' && (
        <>
          <label className={`${label} flex items-center gap-1.5`}>
            <input type="checkbox" disabled className="accent-blue-600" />
            滚动所有窗口
          </label>
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">
            按住空格可随时临时切换为抓手
          </span>
        </>
      )}

      {tool === 'zoom' && (
        <>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onZoomTo(1)}
              className="px-2 h-6 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              100%
            </button>
            <button
              type="button"
              onClick={onFit}
              className="px-2 h-6 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 text-neutral-700 dark:text-neutral-200 hover:bg-neutral-100 dark:hover:bg-neutral-700"
            >
              查看全部
            </button>
          </div>
          <span className={`${label} ml-2`}>当前 {Math.round(scale * 100)}%</span>
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">
            单击放大 · Alt+单击缩小
          </span>
        </>
      )}

      {/* 自由变换：图层级的数值入口（画布级旋转在文档栏，两者分处两地，§10.1） */}
      {tool === 'transform' && (
        <>
          <label className={label}>W</label>
          <input
            type="number"
            value={layerBox ? Math.round(layerBox.w) : 0}
            onChange={e => {
              if (!layerBox || !onLayerBoxChange) return;
              const v = Math.max(1, Math.round(Number(e.target.value) || 1));
              // 以定界框中心为锚：改尺寸不该让框跑掉
              onLayerBoxChange({ w: v, x: layerBox.x + (layerBox.w - v) / 2 });
            }}
            className={`${numInput} w-16`}
          />
          <label className={label}>H</label>
          <input
            type="number"
            value={layerBox ? Math.round(layerBox.h) : 0}
            onChange={e => {
              if (!layerBox || !onLayerBoxChange) return;
              const v = Math.max(1, Math.round(Number(e.target.value) || 1));
              onLayerBoxChange({ h: v, y: layerBox.y + (layerBox.h - v) / 2 });
            }}
            className={`${numInput} w-16`}
          />
          <label className={label}>角度</label>
          <input
            type="number"
            value={layerBox ? Math.round(layerBox.rotation) : 0}
            onChange={e => {
              if (!layerBox || !onLayerBoxChange) return;
              onLayerBoxChange({ rotation: Number(e.target.value) || 0 });
            }}
            className={`${numInput} w-16`}
          />
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() =>
                layerBox &&
                onLayerBoxChange?.({ rotation: ((layerBox.rotation - 90) % 360 + 360) % 360 })
              }
              className={ratioBtn}
              title="图层逆时针 90°（画布不转）"
            >
              −90°
            </button>
            <button
              type="button"
              onClick={() =>
                layerBox &&
                onLayerBoxChange?.({ rotation: ((layerBox.rotation + 90) % 360 + 360) % 360 })
              }
              className={ratioBtn}
              title="图层顺时针 90°（画布不转）"
            >
              +90°
            </button>
          </div>
          <SnapToggle enabled={snapEnabled} onChange={onSnapToggle} />
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">
            拖角缩放 · 四角外侧旋转 · Enter 提交 / Esc 取消
          </span>
        </>
      )}

      {/* 画笔/橡皮（2026-10-24 画笔轮）：大小/硬度/不透明度 + 颜色。
          参数改动只在**下一笔**生效（落笔瞬间取值）。 */}
      {(tool === 'brush' || tool === 'eraser') && brushSettings && onBrushSettingsChange && (
        <>
          <span className={label}>大小</span>
          <input
            type="range"
            min={1}
            max={300}
            step={1}
            value={brushSettings.size}
            onChange={e => onBrushSettingsChange({ ...brushSettings, size: Number(e.target.value) })}
            className="w-24 accent-blue-600"
            title="笔径（文档像素）"
          />
          <input
            type="number"
            min={1}
            max={300}
            value={brushSettings.size}
            onChange={e =>
              onBrushSettingsChange({
                ...brushSettings,
                size: Math.min(300, Math.max(1, Math.round(Number(e.target.value) || 1))),
              })
            }
            className={`${numInput} w-14`}
          />
          <span className={label}>硬度</span>
          <input
            type="range"
            min={0}
            max={100}
            step={1}
            value={brushSettings.hardness}
            onChange={e => onBrushSettingsChange({ ...brushSettings, hardness: Number(e.target.value) })}
            className="w-20 accent-blue-600"
            title="100 = 硬边，0 = 全柔边"
          />
          <span className="text-[11px] tabular-nums text-neutral-600 dark:text-neutral-300 w-7 text-center shrink-0">
            {brushSettings.hardness}
          </span>
          <span className={label}>不透明度</span>
          <input
            type="range"
            min={1}
            max={100}
            step={1}
            value={brushSettings.opacity}
            onChange={e => onBrushSettingsChange({ ...brushSettings, opacity: Number(e.target.value) })}
            className="w-20 accent-blue-600"
            title="笔画不透明度（一笔之内不叠深）"
          />
          <span className="text-[11px] tabular-nums text-neutral-600 dark:text-neutral-300 w-9 text-center shrink-0">
            {brushSettings.opacity}%
          </span>

          {/* 颜色：画笔 = 前景；橡皮 = 背景（只在蒙版上有意义，图层上是擦除）。
              蒙版目标下改画"颜色的亮度"，chip 直接显示将画出的灰 */}
          <label
            className="relative w-6 h-6 rounded border border-neutral-300 dark:border-neutral-500 shrink-0 cursor-pointer"
            style={{ backgroundColor: maskTarget ? luminanceToHex(colorLuminance(activeColor)) : activeColor }}
            title={
              maskTarget
                ? `蒙版作画：画的是颜色的亮度（白 = 显示 / 黑 = 隐藏），当前灰度 ${colorLuminance(activeColor)}`
                : tool === 'eraser'
                  ? '背景色（橡皮在蒙版上画它的亮度；图层上为擦除）'
                  : '前景色（画笔画它；右侧面板 / D / X 也可换）'
            }
          >
            <input
              type="color"
              value={activeColor}
              onChange={e =>
                tool === 'eraser' ? setBackground(e.target.value) : setForeground(e.target.value)
              }
              className="absolute inset-0 opacity-0 cursor-pointer"
            />
          </label>
          {maskTarget && (
            <span className="text-[10px] text-neutral-500 dark:text-neutral-400 shrink-0">
              蒙版：白 = 显示 / 黑 = 隐藏（当前灰度 {colorLuminance(activeColor)}）
            </span>
          )}
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500 shrink-0">
            {tool === 'brush' ? 'B 画笔' : 'E 橡皮'} · 选蒙版缩略图后可直接画蒙版 ·
            前景/背景色在右侧面板（D 复位 · X 交换）
          </span>
        </>
      )}

      {tool !== null &&
        !['move', 'crop', 'hand', 'zoom', 'transform', 'brush', 'eraser'].includes(tool) && (
          <span className="text-[11px] text-amber-600 dark:text-amber-400">
            「{def.label}」尚未接入（快捷键 {def.shortcut}）—— 先摆在这儿占位
          </span>
        )}
    </div>
  );
};
