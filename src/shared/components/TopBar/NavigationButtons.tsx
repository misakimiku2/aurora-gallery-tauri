import React from 'react';
import { ChevronLeft, ChevronRight, ArrowUp, RefreshCw } from 'lucide-react';

export interface NavigationButtonsProps {
  onGoBack?: () => void;
  onGoForward?: () => void;
  onNavigateUp?: () => void;
  onRefresh: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  canNavigateUp?: boolean;
  t: (key: string) => string;
}

export const NavigationButtons: React.FC<NavigationButtonsProps> = ({
  onGoBack,
  onGoForward,
  onNavigateUp,
  onRefresh,
  canGoBack = false,
  canGoForward = false,
  canNavigateUp = false,
  t,
}) => {
  return (
    <div className="flex items-center space-x-2 min-w-fit">
      <div className="flex space-x-1">
        <button
          onClick={onGoBack}
          disabled={!canGoBack}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-600 dark:text-gray-300"
          title={t('nav.goBack') || '后退'}
        >
          <ChevronLeft size={18} />
        </button>
        <button
          onClick={onGoForward}
          disabled={!canGoForward}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-600 dark:text-gray-300"
          title={t('nav.goForward') || '前进'}
        >
          <ChevronRight size={18} />
        </button>
        <button
          onClick={onNavigateUp}
          disabled={!canNavigateUp}
          className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-30 text-gray-600 dark:text-gray-300"
          title={t('nav.goUp') || '向上'}
        >
          <ArrowUp size={18} />
        </button>
      </div>
      <button
        onClick={onRefresh}
        className="p-2 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-600 dark:text-gray-300"
        title={t('nav.refresh') || '刷新'}
      >
        <RefreshCw size={16} />
      </button>
    </div>
  );
};

export default NavigationButtons;
