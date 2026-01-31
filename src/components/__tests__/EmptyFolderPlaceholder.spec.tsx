import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import EmptyFolderPlaceholder from '../EmptyFolderPlaceholder';

const t = (k: string) => {
  const map: Record<string, string> = {
    'context.noFiles': 'No files',
    'context.refreshing': 'Refreshing...',
    'context.refresh': 'Refresh',
    'context.ifEmptyTryRefresh': 'If empty for a while, try Refresh'
  };
  return map[k] || k;
};

describe('EmptyFolderPlaceholder', () => {
  it('shows empty state when not refreshing', () => {
    render(<EmptyFolderPlaceholder isRefreshing={false} onRefresh={() => {}} t={t} />);
    expect(screen.getByTestId('empty-placeholder-empty')).toBeInTheDocument();
    expect(screen.queryByTestId('empty-placeholder-refreshing')).toBeNull();
  });

  it('shows refreshing UI and calls onRefresh when button clicked', () => {
    const onRefresh = vi.fn();
    render(<EmptyFolderPlaceholder isRefreshing={true} onRefresh={onRefresh} t={t} />);
    expect(screen.getByTestId('empty-placeholder-refreshing')).toBeInTheDocument();
    const btn = screen.getByTestId('empty-refresh-button');
    fireEvent.click(btn);
    expect(onRefresh).toHaveBeenCalled();
  });
});
