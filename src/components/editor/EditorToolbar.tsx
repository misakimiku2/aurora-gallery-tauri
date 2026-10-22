/**
 * 左侧竖排工具栏（UI 设计 §3）。
 *
 * PS 的工具箱把同类工具叠在一个槽里长按展开；这里**首版不叠、一列排开**——
 * 工具总数 12 个，叠起来省不了多少高度，却把「有哪些工具」这件事藏起来了
 * （UI 设计 §3 的推荐，待拍板项第 9 条）。
 */
import React, { Fragment } from 'react';
import type { EditorToolId } from '../../types';
import { EDITOR_TOOLS } from './editorTools';

interface EditorToolbarProps {
  activeTool: EditorToolId;
  onSelect: (tool: EditorToolId) => void;
  /** 无文档时整条工具栏禁掉（例如新建空白画布的过渡态） */
  disabled?: boolean;
}

export const EditorToolbar: React.FC<EditorToolbarProps> = ({ activeTool, onSelect, disabled }) => {
  return (
    <div
      className="w-11 shrink-0 flex flex-col items-center py-2 gap-0.5 border-r border-neutral-200 dark:border-neutral-700 bg-white dark:bg-neutral-800 select-none overflow-y-auto"
    >
      {EDITOR_TOOLS.map(tool => {
        const active = tool.id === activeTool;
        const Icon = tool.icon;
        return (
          <Fragment key={tool.id}>
            {tool.dividerBefore && (
              <div className="w-6 h-px bg-neutral-200 dark:bg-neutral-700 my-1 shrink-0" />
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={() => onSelect(tool.id)}
              title={`${tool.label} (${tool.shortcut})${tool.available ? '' : ' · 尚未接入'}`}
              aria-pressed={active}
              className={[
                'w-8 h-8 shrink-0 rounded flex items-center justify-center transition-colors',
                active
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-neutral-600 dark:text-neutral-300 hover:bg-neutral-200 dark:hover:bg-neutral-700',
                // 未接入的工具压一档透明度：能被看到、但不装作可用
                tool.available ? '' : 'opacity-40',
                disabled ? 'cursor-not-allowed' : '',
              ].join(' ')}
            >
              <Icon size={16} />
            </button>
          </Fragment>
        );
      })}
    </div>
  );
};
