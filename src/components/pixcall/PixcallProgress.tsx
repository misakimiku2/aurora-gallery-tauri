import React from 'react';
import { Loader2 } from 'lucide-react';

/**
 * 迁移进度条（设计方案 §6.1 第 3 条：进度条语义随阶段切换）。
 *
 * welcome 卡片与设置面板共用：一行「阶段名 + 百分比」配一条细进度。
 * `percent` 为 null 时是不确定态（读快照、切根这些算不出分母的阶段），用呼吸条。
 */

interface Props {
  label: string;
  percent: number | null;
}

const PixcallProgress: React.FC<Props> = ({ label, percent }) => (
  <div data-testid="pixcall-progress">
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="flex min-w-0 items-center gap-1.5 font-medium text-blue-600 dark:text-blue-400">
        <Loader2 size={13} className="shrink-0 animate-spin" />
        <span className="truncate">{label}</span>
      </span>
      {percent !== null && (
        <span className="shrink-0 font-mono tabular-nums text-gray-400 dark:text-gray-500">{percent}%</span>
      )}
    </div>
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
      {percent === null ? (
        <div className="h-full w-1/3 animate-pulse rounded-full bg-blue-600 dark:bg-blue-400" />
      ) : (
        <div
          className="h-full rounded-full bg-blue-600 transition-all duration-300 dark:bg-blue-400"
          style={{ width: `${percent}%` }}
        />
      )}
    </div>
  </div>
);

export default PixcallProgress;
