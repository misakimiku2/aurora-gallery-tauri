/**
 * 底部状态栏（UI 设计 §6 的 ⑥ 区）。
 *
 * 设计文档明确说这**不是装饰**：代理倍率与分辨率警告是两条硬指标的唯二可见反馈
 * 渠道——没有它们，用户会误判锐度、把"代理图放大后的插值"当成原图不清晰。
 */
import React from 'react';
import type { EditorToolId } from '../../types';
import { getEditorTool } from './editorTools';

interface EditorStatusBarProps {
  tool: EditorToolId;
  scale: number;
  /** 源图原始尺寸 */
  width: number;
  height: number;
  /** 代理图尺寸 */
  previewWidth: number;
  previewHeight: number;
  /** 空格是否按住（临时抓手） */
  spaceHeld?: boolean;
}

export const EditorStatusBar: React.FC<EditorStatusBarProps> = ({
  tool,
  scale,
  width,
  height,
  previewWidth,
  previewHeight,
  spaceHeld,
}) => {
  const def = getEditorTool(tool);
  const isProxy = previewWidth !== width || previewHeight !== height;
  // 代理图 1:1 显示是清晰上限，超过 100% 就开始插值 —— 这正是「分辨率不足」的时机
  const beyondProxy = scale > 1;

  // 工具提示随工具变。移动工具如实说明「没东西可移」，否则用户会以为它坏了
  // （实测反馈：以为移动工具和抓手是同一个）
  const hint = spaceHeld
    ? '空格 = 抓手（松开回到原工具）'
    : tool === 'move'
      ? '单图层：暂无可移动内容 · 按 H 或按住空格拖动画布'
      : tool === 'crop'
        ? '拖动拉框 · Enter 应用 · Esc 取消'
        : `快捷键 ${def.shortcut}`;

  return (
    <div className="h-6 shrink-0 flex items-center gap-3 px-3 border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[11px] text-neutral-500 dark:text-neutral-400 select-none">
      <span className="font-medium text-neutral-700 dark:text-neutral-200">
        {spaceHeld ? '抓手（临时）' : def.label}
      </span>
      <span>{hint}</span>

      <span className="flex-1" />

      {beyondProxy && (
        <span className="text-amber-600 dark:text-amber-400">
          已超出代理分辨率 · 当前为插值显示
        </span>
      )}
      <span className="tabular-nums">
        画布 {width}×{height}
      </span>
      {isProxy && (
        <span className="tabular-nums text-neutral-400 dark:text-neutral-500">
          代理 {previewWidth}×{previewHeight}
        </span>
      )}
      <span className="tabular-nums text-neutral-700 dark:text-neutral-200">
        {Math.round(scale * 100)}%
      </span>
    </div>
  );
};
