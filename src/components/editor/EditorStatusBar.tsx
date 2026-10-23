/**
 * 底部状态栏（UI 设计 §6 的 ⑥ 区）。
 *
 * ## v2 之后口径变了
 *
 * 设计文档当初把「代理倍率 + 分辨率警告」定为两条必给的反馈渠道——那是画布还显示
 * 2048 代理图的年代。现在画布直接渲染**原文件**（设计稿 §4.4），代理只剩缩略图用途，
 * 所以：
 *
 * - **"代理 2048×1536" 这行删掉了**：画布不是它显示的，留着只会误导；
 * - **"已超出代理分辨率" 改成"放大显示"**：超过 100% 看到的是原图的插值，
 *   不是"代理图撑不住"，用警告色反而冤枉了图片本身。
 *
 * 仍然保留的是"当前缩放比"和"画布尺寸"——这两条才是判断"我看到的是不是真像素"的依据。
 */
import React from 'react';
import type { EditorToolId } from '../../types';
import { getEditorTool } from './editorTools';

interface EditorStatusBarProps {
  /** `null` = 没有选中工具 */
  tool: EditorToolId | null;
  scale: number;
  /** 画布尺寸（导出即按这个尺寸合成） */
  width: number;
  height: number;
  /** 空格是否按住（临时抓手） */
  spaceHeld?: boolean;
}

export const EditorStatusBar: React.FC<EditorStatusBarProps> = ({
  tool,
  scale,
  width,
  height,
  spaceHeld,
}) => {
  const def = getEditorTool(tool);
  // 超过 100% 是原图的插值放大——不是"分辨率不足"，所以只陈述事实、不用警告色
  const isUpscaled = scale > 1;

  // 工具提示随工具变。移动工具如实说明"能拖动图层"，否则用户会以为它坏了
  // （曾经它确实无事可做，被当成抓手的孪生兄弟）
  const hint = spaceHeld
    ? '空格 = 抓手（松开回到原工具）'
    : tool === null
      ? '点左侧工具箱选择工具 · 滚轮缩放 / 空格平移始终可用'
      : tool === 'move'
      ? '拖动图层移动 · Ctrl+T 进入自由变换 · 按 H 或按住空格平移画布'
      : tool === 'transform'
        ? '拖角缩放 · 四角外侧旋转 · Enter 提交 · Esc 取消'
        : tool === 'crop'
          ? '拖动拉框 · Enter 应用 · Esc 取消'
          : `快捷键 ${def.shortcut}`;

  return (
    <div className="h-6 shrink-0 flex items-center gap-3 px-3 border-t border-neutral-200 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-800 text-[11px] text-neutral-500 dark:text-neutral-400 select-none">
      <span className="font-medium text-neutral-700 dark:text-neutral-200">
        {spaceHeld ? '抓手（临时）' : tool === null ? '未选择工具' : def.label}
      </span>
      <span className="truncate">{hint}</span>

      <span className="flex-1" />

      {isUpscaled && (
        <span className="text-neutral-400 dark:text-neutral-500">放大显示（插值）</span>
      )}
      <span className="tabular-nums">
        画布 {width}×{height}
      </span>
      <span className="tabular-nums text-neutral-700 dark:text-neutral-200">
        {Math.round(scale * 100)}%
      </span>
    </div>
  );
};
