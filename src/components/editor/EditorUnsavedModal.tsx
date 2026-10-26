import React from 'react';

/**
 * 编辑器未保存警告(应用自有弹窗样式,同 CloseConfirmationModal 的卡片语言):
 * 关闭编辑器标签或退出应用时,存在 dirty 会话则拦截并三选一——
 * 保存并继续 / 不保存 / 取消。
 */
interface EditorUnsavedModalProps {
  /** 关闭场景:tab=关标签;exit=退出应用。 */
  mode: 'tab' | 'exit';
  /** 会话文件名(exit 且多个 dirty 时显示计数)。 */
  name: string;
  /** dirty 会话数(exit 场景可能 >1)。 */
  count: number;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export const EditorUnsavedModal: React.FC<EditorUnsavedModalProps> = ({ mode, name, count, onSave, onDiscard, onCancel }) => {
  const message = mode === 'tab'
    ? `要保存对「${name}」的更改吗?不保存将丢失这些修改。`
    : count > 1
      ? `${count} 个编辑器标签有未保存的修改,退出前要保存吗?`
      : `退出前要保存对「${name}」的更改吗?`;

  return (
    <div className="fixed inset-0 z-[320] bg-black/50 flex items-center justify-center p-8 backdrop-blur-sm">
      <div
        className="bg-white dark:bg-gray-800 rounded-xl w-[400px] shadow-2xl border border-gray-200 dark:border-gray-700 animate-zoom-in"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="p-6">
          <h2 className="text-xl font-bold text-gray-800 dark:text-white mb-4">有未保存的修改</h2>
          <p className="text-sm text-gray-600 dark:text-gray-400 mb-6 break-all">{message}</p>

          <div className="flex justify-end gap-2">
            <button
              onClick={onDiscard}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30"
            >
              不保存
            </button>
            <button
              onClick={onCancel}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700"
            >
              取消
            </button>
            <button
              onClick={onSave}
              className="px-4 py-2 rounded-lg text-sm font-medium transition-colors bg-blue-600 text-white hover:bg-blue-500"
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
