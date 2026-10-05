import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import EagleImportSection from '../settings/EagleImportSection';
import { eagleDiscover, eagleImportRecords, eagleImport, eagleProbe } from '../../api/tauri-bridge';
import type { MigrationReport } from '../../api/tauri-bridge';

vi.mock('../../api/tauri-bridge', () => {
  const report: MigrationReport = {
    matched: 49,
    tagsUnioned: 31,
    tagsWordsAdded: 40,
    descriptionsWritten: 6,
    descriptionsSkippedExisting: 2,
    sourceUrlsWritten: 3,
    sourceUrlsSkippedExisting: 1,
    topicsCreated: 4,
    topicFilesAdded: 58,
    topicsMergedName: 2,
    topicsCovered: 1,
    topicsMaterialized: 3,
    topicsSkippedUnverifiable: 1,
    topicsReparented: 0,
    skippedUnsupportedType: 2,
    annotatedUnsupported: 0,
    topicMembersSkippedType: 0,
    excludedTrash: 1,
    excludedTrashNames: [{ name: 'deleted.png', originFolder: 'Ref' }],
    unmatched: 2,
    unmatchedPaths: [] as string[],
    unmatchedItems: ['orphan.png', 'renamed.jpg'],
    warnings: ['未标定的智能夹条件已跳过'],
  };
  return {
    eagleDiscover: vi.fn(async () => [{ root: 'C:/Libs/Test.library', isCurrent: true }]),
    eagleProbe: vi.fn(async () => report),
    eagleImport: vi.fn(async () => report),
    eagleImportRecords: vi.fn(async () => [] as unknown[]),
    eagleLastImportReport: vi.fn(async () => null),
    listenEagleProgress: vi.fn(async () => () => {}),
  };
});

const t = (key: string) => key;

/** 测试本地造报告：工厂里的那份给 bridge mock，这里给 report_json 解析路径用 */
const makeReport = (overrides: Partial<MigrationReport> = {}): MigrationReport => ({
  matched: 49,
  tagsUnioned: 31,
  tagsWordsAdded: 40,
  descriptionsWritten: 6,
  descriptionsSkippedExisting: 2,
  sourceUrlsWritten: 3,
  sourceUrlsSkippedExisting: 1,
  topicsCreated: 4,
  topicFilesAdded: 58,
  topicsMergedName: 2,
  topicsCovered: 1,
  topicsMaterialized: 3,
  topicsSkippedUnverifiable: 1,
  topicsReparented: 0,
  skippedUnsupportedType: 2,
  annotatedUnsupported: 0,
  topicMembersSkippedType: 0,
  excludedTrash: 1,
  excludedTrashNames: [],
  unmatched: 2,
  unmatchedPaths: [],
  unmatchedItems: ['orphan.png', 'renamed.jpg'],
  warnings: [],
  ...overrides,
});

const setup = () => render(<EagleImportSection t={t} currentRoot={null} onShowToast={() => {}} />);

describe('设置 → 从 Eagle 导入标注', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('默认折叠成一行：库列表不出现，点开才出（与 PixCall 卡排同一条列表，不能摊开）', async () => {
    setup();
    await waitFor(() => expect(screen.getByTestId('eagle-source-header')).toBeInTheDocument());
    expect(screen.queryByTestId('eagle-library-row')).toBeNull();

    fireEvent.click(screen.getByTestId('eagle-source-header'));
    expect(screen.getByTestId('eagle-library-row')).toBeInTheDocument();
    // 路径不占版面，悬停才出（DOM 常驻）；Eagle 的库是 *.library 目录本身
    expect(screen.getByTestId('eagle-library-path').textContent).toBe('C:/Libs/Test.library');
  });

  it('折叠那一行自带「导过没有」：有记录报上次导入时间，没有则报发现几个库', async () => {
    setup();
    expect(await screen.findByText('eagle.foundLibraries')).toBeInTheDocument();

    vi.mocked(eagleImportRecords).mockResolvedValueOnce([
      {
        id: 1,
        source: 'eagle',
        sourceRoot: 'C:/Libs/Test.library',
        sourceSchemaVersion: '4.0.0',
        importedAt: 1760000000,
        reportJson: '{}',
        matched: 49,
        unmatched: 2,
        skippedExisting: 0,
        skippedUnsupportedType: 2,
        topicMembersSkippedType: 0,
      },
    ] as never);
    setup();
    expect(await screen.findByText(/eagle\.lastImported/)).toBeInTheDocument();
  });

  it('点库行 = probe 后 import 同一个根（与 PixCall 同款：两次读同一份快照）', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('eagle-source-header'));
    fireEvent.click(screen.getByTestId('eagle-library-row'));

    await waitFor(() => expect(eagleImport).toHaveBeenCalledWith('C:/Libs/Test.library'));
    expect(eagleProbe).toHaveBeenCalledWith('C:/Libs/Test.library');
  });

  it('发现不到 Eagle 库时整块不渲染', async () => {
    vi.mocked(eagleDiscover).mockResolvedValueOnce([] as never);
    const { container } = setup();
    await waitFor(() => expect(eagleDiscover).toHaveBeenCalled());
    expect(container).toBeEmptyDOMElement();
  });

  // 导入是 Rust 侧直接写库，不回读一次 state.files 就还停在旧值（与 PixCall 同一个坑）
  it('导入成功后回调 onImported，让上层回读元数据', async () => {
    const onImported = vi.fn();
    render(<EagleImportSection t={t} currentRoot={null} onShowToast={() => {}} onImported={onImported} />);
    fireEvent.click(await screen.findByTestId('eagle-source-header'));
    fireEvent.click(screen.getByTestId('eagle-library-row'));

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
  });

  // 库不在资源根下时点之前就说清；场景 C 会先弹切根确认
  it('场景 C：点 outside 的库先弹切根确认，确认后先切根再导入', async () => {
    const onSwitchRoot = vi.fn(async () => {});
    vi.mocked(eagleDiscover).mockResolvedValueOnce([
      { root: 'D:/Libs/Other.library', isCurrent: false, rootRelation: 'outside' },
    ] as never);
    render(
      <EagleImportSection
        t={t}
        currentRoot="C:/Videos"
        onShowToast={() => {}}
        onSwitchRoot={onSwitchRoot}
      />
    );
    fireEvent.click(await screen.findByTestId('eagle-source-header'));
    fireEvent.click(screen.getByTestId('eagle-library-row'));

    // 确认弹窗出现，且此刻什么都没干
    expect(await screen.findByText('settings.switchRootConfirmTitle')).toBeInTheDocument();
    expect(onSwitchRoot).not.toHaveBeenCalled();
    expect(eagleProbe).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText('settings.switchRoot'));
    await waitFor(() => expect(onSwitchRoot).toHaveBeenCalledWith('D:/Libs/Other.library'));
    await waitFor(() => expect(eagleProbe).toHaveBeenCalledWith('D:/Libs/Other.library'));
  });

  it('场景 C 的确认框可以取消，取消后既不切根也不导入', async () => {
    const onSwitchRoot = vi.fn(async () => {});
    vi.mocked(eagleDiscover).mockResolvedValueOnce([
      { root: 'D:/Libs/Other.library', isCurrent: false, rootRelation: 'outside' },
    ] as never);
    render(
      <EagleImportSection
        t={t}
        currentRoot="C:/Videos"
        onShowToast={() => {}}
        onSwitchRoot={onSwitchRoot}
      />
    );
    fireEvent.click(await screen.findByTestId('eagle-source-header'));
    fireEvent.click(screen.getByTestId('eagle-library-row'));
    fireEvent.click(await screen.findByText('settings.cancel'));

    await waitFor(() =>
      expect(screen.queryByText('settings.switchRootConfirmTitle')).toBeNull()
    );
    expect(onSwitchRoot).not.toHaveBeenCalled();
    expect(eagleProbe).not.toHaveBeenCalled();
  });

  // A/B 两种场景（same / inside）照旧不切根
  it('场景 A/B：同一个根或子目录时直接导入，不弹确认也不切根', async () => {
    const onSwitchRoot = vi.fn(async () => {});
    vi.mocked(eagleDiscover).mockResolvedValueOnce([
      { root: 'C:/Videos/Pics.library', isCurrent: true, rootRelation: 'inside' },
    ] as never);
    render(
      <EagleImportSection
        t={t}
        currentRoot="C:/Videos"
        onShowToast={() => {}}
        onSwitchRoot={onSwitchRoot}
      />
    );
    fireEvent.click(await screen.findByTestId('eagle-source-header'));
    fireEvent.click(screen.getByTestId('eagle-library-row'));

    await waitFor(() => expect(eagleProbe).toHaveBeenCalledWith('C:/Videos/Pics.library'));
    expect(onSwitchRoot).not.toHaveBeenCalled();
    expect(screen.queryByText('settings.switchRootConfirmTitle')).toBeNull();
    // 卡内不该有「会切根」那句提示，但要有绿色徽章
    expect(screen.queryByTestId('eagle-library-outside-hint')).toBeNull();
    expect(screen.getByTestId('eagle-library-inside-badge')).toBeInTheDocument();
  });

  // H2 新栏：未命中的 Eagle 条目名明细在「上次导入」展开区逐条可见
  it('「上次导入」展开区列出未命中条目明细（unmatchedItems）', async () => {
    vi.mocked(eagleImportRecords).mockResolvedValueOnce([
      {
        id: 1,
        source: 'eagle',
        sourceRoot: 'C:/Libs/Test.library',
        sourceSchemaVersion: '4.0.0',
        importedAt: 1760000000,
        reportJson: JSON.stringify(makeReport()),
        matched: 49,
        unmatched: 2,
        skippedExisting: 0,
        skippedUnsupportedType: 2,
        topicMembersSkippedType: 0,
      },
    ] as never);
    setup();
    fireEvent.click(await screen.findByTestId('eagle-source-header'));
    fireEvent.click(screen.getByText('eagle.lastReport'));

    expect(await screen.findByText('eagle.unmatchedItems')).toBeInTheDocument();
    expect(screen.getByText('orphan.png')).toBeInTheDocument();
    expect(screen.getByText('renamed.jpg')).toBeInTheDocument();
  });
});
