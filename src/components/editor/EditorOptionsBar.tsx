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
}

/** 裁剪比例预设（UI 设计 §7.1 的平台封面清单，待拍板项第 1 条）。 */
const CROP_PRESETS: Array<{ label: string; ratio: number | null }> = [
  { label: '自由', ratio: null },
  { label: '原始比例', ratio: 0 },
  { label: '1:1', ratio: 1 },
  { label: '16:9', ratio: 16 / 9 },
  { label: '9:16', ratio: 9 / 16 },
  { label: '4:3', ratio: 4 / 3 },
];

const label = 'text-[11px] text-neutral-500 dark:text-neutral-400';
const chip =
  'px-2 h-6 rounded text-[11px] border border-neutral-200 dark:border-neutral-600 text-neutral-500 dark:text-neutral-400 bg-neutral-50 dark:bg-neutral-900 cursor-not-allowed';

export const EditorOptionsBar: React.FC<EditorOptionsBarProps> = ({
  tool,
  scale,
  onZoomTo,
  onFit,
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
          <span className="ml-auto text-[11px] text-neutral-400 dark:text-neutral-500">
            移动图片位置（拖动画布即可平移）
          </span>
        </>
      )}

      {tool === 'crop' && (
        <>
          <div className="flex items-center gap-1">
            {CROP_PRESETS.map(p => (
              <span key={p.label} className={chip}>
                {p.label}
              </span>
            ))}
          </div>
          <span className={`${label} ml-2`}>宽 × 高</span>
          <span className={chip}>— × —</span>
          <span className="ml-auto text-[11px] text-amber-600 dark:text-amber-400">
            裁剪尚未接入：下一步实现
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
