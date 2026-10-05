import React from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, FolderOpen, Loader2, X } from 'lucide-react';
import { fillTemplate } from '../../utils/pixcallReport';
import { rootDisplayName } from '../../utils/rootHistory';

/**
 * 切根确认弹窗：手动换资源根、导入 PixCall 库时自动切根，**共用这一个**（设计方案 §13）。
 *
 * 为什么要有：切根 = 换一整份 `metadata.db`，当前库加的标签/专题/人物都留在那个库里
 * （不是 bug，是原设计）。以前这两处都是「点完直接切」，用户没有任何提示；
 * 指挥官 2026-10-05 拍板：补一个统一弹窗，两处用同一套文案。
 *
 * **welcome 的「使用 PixCall 库」刻意不用它**——那里是首次使用、第一步就是设置根目录，
 * 不存在「切换」的概念。
 *
 * 用 Portal 渲染到 body，跟 P3 的历史资源根弹窗同一手法（设置弹窗内有 overflow/层级限制）。
 */

interface Props {
  /** 要切到哪个根；空串/null 表示不显示 */
  targetPath: string | null;
  /** 切根+扫描正在进行：禁掉关闭与确认，按钮转圈（扫描 10 万张是小时级，不能让用户干等） */
  busy?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  t: (key: string) => string;
}

const SwitchRootConfirmDialog: React.FC<Props> = ({ targetPath, busy, onCancel, onConfirm, t }) => {
  if (!targetPath) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-[520] bg-black/70 flex items-center justify-center p-4"
      onClick={busy ? undefined : onCancel}
    >
      <div
        className="bg-content rounded-xl w-[520px] max-w-full shadow-2xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-subtle">
          <h4 className="flex items-center text-sm font-bold text-gray-800 dark:text-white">
            <AlertTriangle size={16} className="mr-2 text-amber-500" />
            {t('settings.switchRootConfirmTitle')}
          </h4>
          <button
            onClick={onCancel}
            disabled={busy}
            className="p-1 text-gray-500 dark:text-gray-400 hover:bg-surface rounded transition-colors disabled:opacity-40"
          >
            <X size={16} />
          </button>
        </div>

        <div className="px-4 py-4 space-y-3">
          {/* 切到哪：文件夹名在上、完整路径在下（与历史资源根弹窗同一观感） */}
          <div className="flex items-start gap-2.5 rounded-lg bg-surface px-3 py-2.5">
            <FolderOpen size={16} className="mt-0.5 shrink-0 text-blue-500" />
            <div className="min-w-0">
              <div className="text-sm font-medium text-gray-800 dark:text-white">
                {fillTemplate(t('settings.switchRootConfirmTarget'), { name: rootDisplayName(targetPath) })}
              </div>
              <div className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">{targetPath}</div>
            </div>
          </div>

          {/* 代价一：数据留在旧库 */}
          <p className="text-sm text-gray-700 dark:text-gray-300">
            {t('settings.switchRootConfirmMessage')}
          </p>

          {/* 代价二：派生数据重算 + 退路 */}
          <p className="text-xs text-gray-600 dark:text-gray-400 bg-surface rounded-lg px-3 py-2 border border-subtle">
            {t('settings.switchRootConfirmSub')}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-subtle bg-surface rounded-b-xl">
          <button
            onClick={onCancel}
            disabled={busy}
            className="px-3 py-1.5 text-sm rounded border border-subtle text-gray-700 dark:text-gray-300 hover:bg-white/60 dark:hover:bg-white/5 disabled:opacity-50"
          >
            {t('settings.cancel')}
          </button>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="px-3 py-1.5 text-sm font-medium rounded bg-blue-600 hover:bg-blue-500 text-white disabled:bg-blue-400 flex items-center"
          >
            {busy && <Loader2 size={14} className="mr-1.5 animate-spin" />}
            {busy ? t('settings.switchingRoot') : t('settings.switchRoot')}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

export default SwitchRootConfirmDialog;
