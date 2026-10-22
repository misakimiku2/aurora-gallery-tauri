/**
 * 工具选项条（UI 设计 §2 的 ② 区，对应 PS 的 options bar）。
 *
 * 内容随选中工具切换。Phase 1 只给已经能用的工具配真实控件；未接入的工具
 * 明说「尚未接入」，不放一堆点了没反应的假控件——那比没有更糟。
 */
import React from 'react';
import type { EditorToolId } from '../../types';
import { getEditorTool } from './editorTools';

interface EditorOptionsBarProps {
  tool: EditorToolId;
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

/** 裁剪比例预设（UI 设计 §7.1 的平台封面清单，待拍板项第 1 条）。 */

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
}) => {
  const def = getEditorTool(tool);

  return (
    <div className="h-9 shrink-0 flex items-center gap-2 px-3 border-b border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 select-none overflow-x-auto">
      <span className="text-[11px] font-medium text-neutral-800 dark:text-neutral-100 shrink-0">
        {def.label}
      </span>
      <span className="w-px h-4 bg-neutral-200 dark:bg-neutral-700 shrink-0" />

      {tool === 'move' && (
        <>
          <span className={label}>自动选择</span>
          <span className={chip}>无</span>
          <label className={`${label} flex items-center gap-1.5 ml-2`}>
            <input type="checkbox" disabled className="accent-blue-600" />
            显示变换控件
          </label>
          <span className="ml-auto text-[11px] text-amber-600 dark:text-amber-400">
            单图层文档：暂无可移动内容（图层功能在 Phase 2）
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

      {!['move', 'crop', 'hand', 'zoom'].includes(tool) && (
        <span className="text-[11px] text-amber-600 dark:text-amber-400">
          「{def.label}」尚未接入（快捷键 {def.shortcut}）—— 先摆在这儿占位
        </span>
      )}
    </div>
  );
};
