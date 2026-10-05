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
    filesLinked: 44,
    filesCopied: 0,
    filesAlreadyHere: 5,
  };
  return {
    eagleDiscover: vi.fn(async () => [{ root: 'C:/Libs/Test.library', isCurrent: true }]),
    eagleProbe: vi.fn(async () => ({ report, takeover: { targetRoot: 'C:/Videos/Test', totalItems: 49, alreadyHere: 5, skippedExisting: 0, toLink: 44, toCopy: 0, bytes: 134217728, linkSupported: true, warnings: [] } })),
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

const setup = (currentRoot: string | null = 'C:/Videos') =>
  render(<EagleImportSection t={t} currentRoot={currentRoot} onShowToast={() => {}} />);

/** 展开 + 点库行：probe 完应该停在意会确认这一步 */
const openAndProbe = async () => {
  fireEvent.click(await screen.findByTestId('eagle-source-header'));
  fireEvent.click(screen.getByTestId('eagle-library-row'));
  await screen.findByTestId('eagle-takeover-confirm');
};

describe('设置 → 从 Eagle 迁移（C 档：连文件接管）', () => {
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

  // C 档往用户盘上写文件，动手之前必须先给一眼账：多少个条目、多少字节、能不能硬链接
  it('点库行只是 probe：出迁入位置与条数，此刻还没碰用户的盘', async () => {
    setup();
    await openAndProbe();

    expect(eagleProbe).toHaveBeenCalledWith('C:/Libs/Test.library', 'C:/Videos/Test', true);
    expect(eagleImport).not.toHaveBeenCalled();
    // 目标目录 = <当前资源根>/<库名>（`.library` 后缀剥掉），不是把资源根换掉
    expect(screen.getByTestId('eagle-takeover-confirm').textContent).toContain('C:/Videos/Test');
    expect(screen.getByTestId('eagle-takeover-confirm').textContent).toContain('eagle.takeoverLinkMode');
  });

  it('确认之后才搬运：同一个根、同一个链接偏好，两条链读同一份快照', async () => {
    setup();
    await openAndProbe();
    fireEvent.click(screen.getByTestId('eagle-takeover-start'));

    await waitFor(() =>
      expect(eagleImport).toHaveBeenCalledWith('C:/Libs/Test.library', 'C:/Videos/Test', true)
    );
  });

  // Q1 的用户可见口径：不想与 Eagle 共用同一份数据就改成复制
  it('勾「改为复制导入」后按复制跑：probe 与 import 都带上 preferLink=false', async () => {
    setup();
    fireEvent.click(await screen.findByTestId('eagle-source-header'));
    fireEvent.click(screen.getByTestId('eagle-library-row'));
    // 偏好在 probe 之前就能改；改完重一次 probe 才是用户看到的账
    fireEvent.click(await screen.findByTestId('eagle-prefer-copy'));
    fireEvent.click(screen.getByTestId('eagle-library-row'));
    await screen.findByTestId('eagle-takeover-confirm');
    fireEvent.click(screen.getByTestId('eagle-takeover-start'));

    await waitFor(() =>
      expect(eagleImport).toHaveBeenCalledWith('C:/Libs/Test.library', 'C:/Videos/Test', false)
    );
  });

  it('确认框可以取消：取消后什么都不做', async () => {
    setup();
    await openAndProbe();
    fireEvent.click(screen.getByTestId('eagle-takeover-cancel'));

    await waitFor(() => expect(screen.queryByTestId('eagle-takeover-confirm')).toBeNull());
    expect(eagleImport).not.toHaveBeenCalled();
  });

  // 迁移是往**用户的资源根**里添文件，没有根就没有落点
  it('没有选资源目录时不许动手：给提示而不是替用户挑一个', async () => {
    setup(null);
    fireEvent.click(await screen.findByTestId('eagle-source-header'));
    fireEvent.click(screen.getByTestId('eagle-library-row'));

    expect(await screen.findByText('eagle.takeoverNoRoot')).toBeInTheDocument();
    await waitFor(() => expect(eagleProbe).not.toHaveBeenCalled());
    expect(eagleImport).not.toHaveBeenCalled();
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
    render(<EagleImportSection t={t} currentRoot="C:/Videos" onShowToast={() => {}} onImported={onImported} />);
    await openAndProbe();
    fireEvent.click(screen.getByTestId('eagle-takeover-start'));

    await waitFor(() => expect(onImported).toHaveBeenCalledTimes(1));
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
