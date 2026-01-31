import React from 'react';

export default function EmptyFolderPlaceholder({
  isRefreshing,
  onRefresh,
  t
}: {
  isRefreshing?: boolean;
  onRefresh: () => void;
  t: (k: string) => string;
}) {
  if (isRefreshing) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center text-gray-400" data-testid="empty-placeholder-refreshing">
        <div className="text-6xl mb-4 opacity-20 animate-pulse">📁</div>
        <p className="mb-2">{t('context.refreshing')}</p>
        <div className="flex items-center space-x-2">
          <button data-testid="empty-refresh-button" className="px-3 py-1 text-sm bg-gray-100 dark:bg-gray-800 rounded" onClick={onRefresh}>{t('context.refresh')}</button>
          <div className="text-xs opacity-60">{t('context.ifEmptyTryRefresh')}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-center text-gray-400" data-testid="empty-placeholder-empty">
      <div className="text-6xl mb-4 opacity-20">📁</div>
      <p>{t('context.noFiles')}</p>
    </div>
  );
}
