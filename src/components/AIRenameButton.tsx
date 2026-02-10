import React from 'react';
import { Sparkles, Loader2 } from 'lucide-react';

interface AIRenameButtonProps {
  onClick: () => void;
  isGenerating: boolean;
  t: (key: string) => string;
  className?: string;
}

export const AIRenameButton: React.FC<AIRenameButtonProps> = ({
  onClick,
  isGenerating,
  t,
  className = '',
}) => {
  return (
    <button
      onClick={onClick}
      disabled={isGenerating}
      className={`
        p-1 rounded-md transition-all duration-200 flex-shrink-0
        text-gray-400 hover:text-purple-500 hover:bg-purple-50
        dark:text-gray-500 dark:hover:text-purple-400 dark:hover:bg-purple-900/20
        disabled:opacity-50 disabled:cursor-not-allowed
        focus:outline-none focus:ring-2 focus:ring-purple-500/30
        ${className}
      `}
      title={t('context.autoRename') || 'AI 自动命名'}
    >
      {isGenerating ? (
        <Loader2 size={14} className="animate-spin" />
      ) : (
        <Sparkles size={14} />
      )}
    </button>
  );
};
