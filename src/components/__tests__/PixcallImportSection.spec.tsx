import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import PixcallImportSection from '../settings/PixcallImportSection';
import { pixcallDiscover, pixcallImportRecords, pixcallImport, pixcallProbe } from '../../api/tauri-bridge';
import type { MigrationReport } from '../../api/tauri-bridge';

vi.mock('../../api/tauri-bridge', () => {
  const report: MigrationReport = {
    matched: 13,
    tagsUnioned: 8,
    tagsWordsAdded: 9,
    descriptionsWritten: 9,
    descriptionsSkippedExisting: 1,
    sourceUrlsWritten: 5,
    sourceUrlsSkippedExisting: 0,
    topicsCreated: 2,
    topicFilesAdded: 1461,
    topicsMergedName: 0,
    topicsCovered: 0,
    topicsMaterialized: 1,
    topicsSkippedUnverifiable: 0,
    topicsReparented: 0,
    skippedUnsupportedType: 52,
    annotatedUnsupported: 1,
    topicMembersSkippedType: 0,
    excludedTrash: 1,
    excludedTrashNames: [{ name: 'z.mp4', originFolder: 'Zen' }],
    unmatched: 0,
    unmatchedPaths: [] as string[],
    warnings: [] as string[],
  };
  return {
    pixcallDiscover: vi.fn(async () => [{ root: 'C:/Pix', isCurrent: true }]),
    pixcallProbe: vi.fn(async () => report),
    pixcallImport: vi.fn(async () => report),
    pixcallImportRecords: vi.fn(async () => [] as unknown[]),
    listenPixcallProgress: vi.fn(async () => () => {}),
  };
});

const t = (key: string) => key;

const setup = () => render(<PixcallImportSection t={t} currentRoot={null} onShowToast={() => {}} />);

describe('设置 → 从 PixCall 导入标注', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('默认折叠成一行：库列表不出现，点开才出（后续来源排同一列，不能摊开）', async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId('pixcall-source-header')).toBeInTheDocument());
    expect(screen.queryByTestId('pixcall-library-row')).toBeNull();

    fireEvent.click(screen.getByTestId('pixcall-source-header'));
    expect(screen.getByTestId('pixcall-library-row')).toBeInTheDocument();
    // 路径不占版面，悬停才出（DOM 常驻）
    expect(screen.getByTestId('pixcall-library-path').textContent).toBe('C:/Pix');
  });

  it('折叠那一行自带「导过没有」：有记录报上次导入时间，没有则报发现几个库', async () => {
    setup();
    expect(await screen.findByText('import.foundLibraries')).toBeInTheDocument();

    vi.mocked(pixcallImportRecords).mockResolvedValueOnce([
      {
        id: 1,
        source: 'pixcall',
        sourceRoot: 'C:/Pix',
        sourceSchemaVersion: '22',
        importedAt: 1760000000,
        reportJson: '{}',
        matched: 13,
        unmatched: 0,
        skippedExisting: 1,
        skippedUnsupportedType: 52,
        topicMembersSkippedType: 0,
      },
    ] as never);
    setup();
    expect(await screen.findByText(/import\.lastImported/)).toBeInTheDocument();
  });

  it('点库行 = probe 后 import 同一个根（§6.2 两次读必须同一份快照）', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('pixcall-source-header'));
    fireEvent.click(screen.getByTestId('pixcall-library-row'));

    await waitFor(() => expect(pixcallImport).toHaveBeenCalledWith('C:/Pix'));
    expect(pixcallProbe).toHaveBeenCalledWith('C:/Pix');
  });

  it('发现不到 PixCall 库时整块不渲染', async () => {
    vi.mocked(pixcallDiscover).mockResolvedValueOnce([] as never);
    const { container } = setup();
    await waitFor(() => expect(pixcallDiscover).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });
});
