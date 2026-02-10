import React from 'react';
import { Check, X } from 'lucide-react';

interface AIRenamePreviewProps {
  previewName: string;
  onApply: () => void;
  onCancel: () => void;
  t: (key: string) => string;
}

export const AIRenamePreview: React.FC<AIRenamePreviewProps> = ({
  previewName,
  onApply,
  onCancel,
  t,
}) => {
  return (
    <div className="flex items-start gap-2 mt-2">
      <div className="flex items-center gap-1.5 bg-green-50 dark:bg-green-900/20 text-green-700 dark:text-green-300 px-2.5 py-1 rounded-lg text-sm font-medium border border-green-200 dark:border-green-800 flex-1 min-w-0">
        <span className="break-all" title={previewName}>
          {previewName}
        </span>
      </div>
      <button
        onClick={onApply}
        className="p-1 rounded-md bg-green-500 hover:bg-green-600 text-white transition-colors flex-shrink-0"
        title={t('context.confirm') || '确认'}
      >
        <Check size={14} />
      </button>
      <button
        onClick={onCancel}
        className="p-1 rounded-md bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-600 dark:text-gray-300 transition-colors flex-shrink-0"
        title={t('context.cancel') || '取消'}
      >
        <X size={14} />
      </button>
    </div>
  );
};
