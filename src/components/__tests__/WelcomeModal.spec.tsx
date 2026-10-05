import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WelcomeModal } from '../modals/WelcomeModal';
import { AppSettings } from '../../types';
import { lanShareStart, pixcallDiscover, pixcallProbe, pixcallImport, eagleDiscover, eagleProbe, eagleImport } from '../../api/tauri-bridge';
import { androidApkDownloadUrl } from '../../api/tauri-bridge/updater';
import { aiService } from '../../services/aiService';

// vi.mock 的工厂在 hoisted import 阶段就会被调用，外层 const 还没初始化 → 用 vi.hoisted
const { pixcallReport } = vi.hoisted(() => ({
  pixcallReport: {
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
    excludedTrashNames: [{ name: 'z.mp4', originFolder: 'Zenless Zone Zero' }],
    unmatched: 0,
    unmatchedPaths: [] as string[],
    warnings: [] as string[],
  },
}));

vi.mock('../../api/tauri-bridge', () => ({
  lanShareStart: vi.fn(async () => ({ port: 8765, local_ip: '192.168.1.10' })),
  lanShareStop: vi.fn(async () => {}),
  // PixCall 迁移（welcome 第 1 步来源按钮）。默认「发现 1 个库」：welcome 的来源按钮
  // 按「发现 ≥1 库」才渲染，返回空会让按钮整颗消失、原流程用例点不到按钮。
  pixcallDiscover: vi.fn(async () => [{ root: 'C:/Pix', isCurrent: true }]),
  pixcallProbe: vi.fn(async () => pixcallReport),
  pixcallImport: vi.fn(async () => pixcallReport),
  pixcallImportRecords: vi.fn(async () => []),
  listenPixcallProgress: vi.fn(async () => () => {}),
  // Eagle 第二来源（welcome-eagle-card 用）。默认「本机没有 Eagle 库」，Eagle 相关用例各自覆盖。
  eagleDiscover: vi.fn(async () => [] as unknown[]),
  // C 档：probe 返回「报告 + 搬运预览」，不再是裸报告
  eagleProbe: vi.fn(async () => ({
    report: pixcallReport,
    takeover: {
      targetRoot: 'C:/Gallery/Test',
      totalItems: 49,
      alreadyHere: 0,
      skippedExisting: 0,
      toLink: 49,
      toCopy: 0,
      bytes: 268435456,
      linkSupported: true,
      warnings: [] as string[],
    },
  })),
  eagleImport: vi.fn(async () => pixcallReport),
  listenEagleProgress: vi.fn(async () => () => {}),
}));

vi.mock('../../api/tauri-bridge/updater', () => ({
  // 默认失败 → 二维码回退发行页（个别用例单独 mockResolvedValue 覆盖为直链）
  androidApkDownloadUrl: vi.fn(async () => {
    throw new Error('offline');
  }),
}));

vi.mock('../../services/aiService', () => ({
  aiService: {
    checkConnection: vi.fn(async () => ({ status: 'connected', result: null })),
  },
}));

const makeSettings = (): AppSettings => ({
  theme: 'system',
  language: 'zh',
  autoStart: false,
  exitAction: 'ask',
  animateOnHover: false,
  autoExtractPalette: false,
  paths: { resourceRoot: '/pics', cacheRoot: '' },
  search: {} as AppSettings['search'],
  ai: {
    provider: 'openai',
    openai: { apiKey: '', endpoint: '', model: '' },
    ollama: { endpoint: '', model: '' },
    lmstudio: { endpoint: '', model: '' },
    autoTag: true,
    autoDescription: true,
    enhancePersonDescription: false,
    enableOCR: false,
    enableTranslation: false,
    targetLanguage: 'zh',
    confidenceThreshold: 0.5,
  },
  clip: {} as AppSettings['clip'],
  performance: { refreshInterval: 1000 },
  lanShare: {
    enabled: false,
    port: 8765,
    accessCode: '',
    allowEdit: true,
    allowUpload: true,
  },
  defaultLayoutSettings: {
    layoutMode: 'grid' as AppSettings['defaultLayoutSettings']['layoutMode'],
    sortBy: 'name' as AppSettings['defaultLayoutSettings']['sortBy'],
    sortDirection: 'asc' as AppSettings['defaultLayoutSettings']['sortDirection'],
    groupBy: 'none' as AppSettings['defaultLayoutSettings']['groupBy'],
  },
});

const setup = (overrides?: Partial<Parameters<typeof WelcomeModal>[0]>) => {
  const onFinish = vi.fn();
  const onSelectFolder = vi.fn();
  const onUpdateSettings = vi.fn();
  const props = {
    show: true,
    onFinish,
    onSelectFolder,
    currentPath: '/pics',
    settings: makeSettings(),
    onUpdateSettings,
    t: (k: string) => k,
    scanProgress: null,
    isScanning: false,
    ...overrides,
  };
  render(<WelcomeModal {...props} />);
  return { onFinish, onUpdateSettings, props };
};

/** 从第 1 步一路走到第 3 步（AI 步）：要求 currentPath 已选。 */
const gotoStep3 = (overrides?: Partial<Parameters<typeof WelcomeModal>[0]>) => {
  const ctx = setup(overrides);
  fireEvent.click(screen.getByTestId('welcome-next-button')); // 1 -> 2
  fireEvent.click(screen.getByTestId('welcome-next-button')); // 2 -> 3
  return ctx;
};

/** 走到第 4 步（互联步）：AI 步用跳过通过。 */
const gotoStep4 = (overrides?: Partial<Parameters<typeof WelcomeModal>[0]>) => {
  const ctx = gotoStep3(overrides);
  fireEvent.click(screen.getByTestId('welcome-skip-button')); // 3 -> 4
  return ctx;
};

describe('WelcomeModal 四步向导', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // clearAllMocks 不恢复 mockResolvedValue 的实现（只在用例间清调用记录），
    // 逐例重设发现 mock 的默认值，防止上个用例的覆盖串到下个用例。
    vi.mocked(pixcallDiscover).mockResolvedValue([{ root: 'C:/Pix', isCurrent: true }]);
    vi.mocked(eagleDiscover).mockResolvedValue([]);
  });

  it('第 1 步未选文件夹时下一步禁用', () => {
    setup({ currentPath: null });
    expect(screen.getByTestId('welcome-step-content-1')).toBeInTheDocument();
    expect(screen.getByTestId('welcome-next-button')).toBeDisabled();
  });

  it('第 1 步有文件夹时下一步进入第 2 步，第 2 步下一步进入 AI 步（共 4 步）', () => {
    gotoStep3();
    expect(screen.getByTestId('welcome-step-content-3')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome-step-content-4')).toBeNull();
  });

  it('AI 步：编辑仅存草稿不落盘，跳过不写设置且前进到互联步', () => {
    const { onUpdateSettings, onFinish } = gotoStep3();
    const input = screen.getByTestId('welcome-ai-endpoint-input');
    fireEvent.change(input, { target: { value: 'http://localhost:1234' } });
    expect(onUpdateSettings).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('welcome-skip-button'));
    expect(screen.getByTestId('welcome-step-content-4')).toBeInTheDocument();
    expect(onFinish).not.toHaveBeenCalled();
    expect(onUpdateSettings).not.toHaveBeenCalled();
  });

  it('AI 步：下一步提交 ai 草稿并进入互联步', () => {
    const { onUpdateSettings } = gotoStep3();
    fireEvent.change(screen.getByTestId('welcome-ai-endpoint-input'), {
      target: { value: 'http://localhost:1234' },
    });
    fireEvent.click(screen.getByTestId('welcome-next-button'));
    expect(onUpdateSettings).toHaveBeenCalledTimes(1);
    expect(onUpdateSettings.mock.calls[0][0]).toMatchObject({
      ai: { openai: { endpoint: 'http://localhost:1234' } },
    });
    expect(screen.getByTestId('welcome-step-content-4')).toBeInTheDocument();
  });

  it('AI 步：切换 provider 后输入框跟随切换', () => {
    gotoStep3();
    fireEvent.click(screen.getByTestId('welcome-ai-provider-lmstudio'));
    expect(screen.getByTestId('welcome-ai-endpoint-input')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome-ai-apikey-input')).toBeNull();
  });

  it('AI 步：测试连接成功显示已连接', async () => {
    gotoStep3();
    fireEvent.click(screen.getByTestId('welcome-ai-test-button'));
    await waitFor(() => expect(screen.getByTestId('welcome-ai-test-result')).toHaveAttribute('data-state', 'connected'));
    expect(aiService.checkConnection).toHaveBeenCalled();
  });

  it('互联步：跳过完成不写 lanShare', () => {
    const { onUpdateSettings, onFinish } = gotoStep4();
    fireEvent.click(screen.getByTestId('welcome-skip-button'));
    expect(onFinish).toHaveBeenCalledTimes(1);
    const lanShareUpdate = onUpdateSettings.mock.calls.find(
      (c) => 'lanShare' in (c[0] as object)
    );
    expect(lanShareUpdate).toBeUndefined();
  });

  it('互联步：开启开关后完成 → 启动服务并写 lanShare.enabled，再回调 onFinish', async () => {
    const { onUpdateSettings, onFinish } = gotoStep4();
    fireEvent.click(screen.getByTestId('welcome-mobile-toggle'));
    // 等服务启动成功（info 卡出现）后再点完成，模拟真实用户时序
    await waitFor(() => expect(screen.getByTestId('welcome-mobile-info')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('welcome-next-button'));
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    expect(lanShareStart).toHaveBeenCalledWith(
      expect.objectContaining({ enabled: true, accessCode: expect.any(String) }),
      '/pics'
    );
    const lanShareUpdate = onUpdateSettings.mock.calls.find(
      (c) => 'lanShare' in (c[0] as object)
    );
    expect(lanShareUpdate).toBeDefined();
    expect((lanShareUpdate![0] as any).lanShare.enabled).toBe(true);
  });

  it('步骤指示器共 4 个，第 4 步可点回第 3 步', () => {
    gotoStep4();
    expect(screen.getAllByTestId(/^welcome-step-dot-/)).toHaveLength(4);
    fireEvent.click(screen.getByTestId('welcome-step-dot-3'));
    expect(screen.getByTestId('welcome-step-content-3')).toBeInTheDocument();
  });

  it('第 2 步不再显示主色调提取提示', () => {
    setup({ currentPath: '/pics' });
    fireEvent.click(screen.getByTestId('welcome-next-button'));
    expect(screen.queryByText('welcome.step2ColorExtractDesc')).toBeNull();
  });

  it('AI 步：第一个服务商显示为「在线」短标签', () => {
    gotoStep3();
    expect(screen.getByTestId('welcome-ai-provider-openai')).toHaveTextContent('welcome.aiProviderOnline');
  });

  it('互联步：品牌区显示安卓端扫码下载二维码（取直链失败时回退发行页）', async () => {
    gotoStep4();
    await waitFor(() =>
      expect(screen.getByTestId('welcome-android-qr').getAttribute('src')).toContain(
        encodeURIComponent('https://gitee.com/misakimiku2/aurora_gallery/releases')
      )
    );
  });

  it('互联步：清单可取时二维码直连当前版本 APK', async () => {
    vi.mocked(androidApkDownloadUrl).mockResolvedValueOnce(
      'https://gitee.com/misakimiku2/aurora_gallery/releases/download/v2.0.0/AuroraGallery-v2.0.0.apk'
    );
    gotoStep4();
    // 每次重新查询：二维码地址变化时 <img> 按 key 重挂载，不能持有旧节点引用
    await waitFor(() =>
      expect(screen.getByTestId('welcome-android-qr').getAttribute('src')).toContain(
        encodeURIComponent(
          'https://gitee.com/misakimiku2/aurora_gallery/releases/download/v2.0.0/AuroraGallery-v2.0.0.apk'
        )
      )
    );
  });

  it('互联步：二维码生成期间显示转圈，图片加载完成后收起', () => {
    gotoStep4();
    expect(screen.getByTestId('welcome-qr-loading')).toBeInTheDocument();
    fireEvent.load(screen.getByTestId('welcome-android-qr'));
    expect(screen.queryByTestId('welcome-qr-loading')).toBeNull();
  });

  it('互联步：图片命中缓存（挂载即 complete）时转圈不留挂', () => {
    // 缓存命中时 load 事件在 React 挂上 onLoad 前就已触发，只等 onLoad 会永远转圈
    const proto = window.HTMLImageElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'complete');
    Object.defineProperty(proto, 'complete', { configurable: true, get: () => true });
    try {
      gotoStep4();
      // 先确认码在渲染，否则「没有转圈」是空断言
      expect(screen.getByTestId('welcome-android-qr')).toBeInTheDocument();
      expect(screen.queryByTestId('welcome-qr-loading')).toBeNull();
    } finally {
      if (original) Object.defineProperty(proto, 'complete', original);
      else delete (proto as any).complete;
    }
  });

  it('互联步：文案与二维码底部对齐', () => {
    gotoStep4();
    const row = screen.getByTestId('welcome-qr-row');
    expect(row.className).toContain('items-end');
  });

  // ---------------------------------------------------------------- 第 1 步「使用 PixCall 库」
  // 设计方案 §6.1 第 3 条：两颗按钮互斥、卡片模式驱动、pixcall 模式的下一步门禁是 import 完成。

  it('没传 onTakeoverPixcall 时不出任何来源按钮（非 Tauri 与老调用点行为不变）', () => {
    setup();
    expect(screen.queryByTestId('welcome-use-pixcall')).toBeNull();
    expect(screen.queryByTestId('welcome-use-eagle')).toBeNull();
  });

  it('pixcall 模式：单库自动接管 → probe → import，完成后放开下一步', async () => {
    const takeover = vi.fn(async () => {});
    setup({ currentPath: null, onTakeoverPixcall: takeover });
    // 门禁按发现结果显示：按钮要等第 1 步的发现 promise 回来才渲染
    fireEvent.click(await screen.findByTestId('welcome-use-pixcall'));

    await waitFor(() => expect(pixcallImport).toHaveBeenCalledWith('C:/Pix'));
    // 「接管 PixCall 库」= 复用现成的切根 + 扫描链，且必须扫完才 probe（§6.3 前置条件）
    expect(takeover).toHaveBeenCalledWith('C:/Pix');
    expect(pixcallProbe).toHaveBeenCalledWith('C:/Pix');

    // 结果区必须带「未覆盖已有内容」与「回收站计数」「视频待补」几栏，缺一栏在验收时就像丢数据（§4.7）
    const row = await screen.findByTestId('welcome-pixcall-result');
    expect(row.textContent).toContain('import.done');
    expect(row.textContent).toContain('import.statTags');
    expect(row.textContent).toContain('import.noteExisting');
    expect(row.textContent).toContain('import.noteTrash');
    expect(row.textContent).toContain('import.noteVideo');
    // 库只印文件夹名，整串路径留给悬停（DOM 常驻、CSS 控制可见）
    const library = screen.getByTestId('pixcall-library-row');
    expect(library.textContent).toContain('Pix');
    expect(screen.getByTestId('pixcall-library-path').textContent).toBe('C:/Pix');
    expect(screen.getByTestId('welcome-next-button')).toBeEnabled();
  });

  it('pixcall 模式下文件夹卡片让位（模式驱动，不是两块并存）', async () => {
    setup({ onTakeoverPixcall: async () => {} });
    expect(screen.getByText('welcome.currentPath')).toBeInTheDocument();
    fireEvent.click(await screen.findByTestId('welcome-use-pixcall'));
    await waitFor(() => expect(pixcallProbe).toHaveBeenCalled());
    expect(screen.queryByText('welcome.currentPath')).toBeNull();
    expect(screen.getByTestId('welcome-pixcall-card')).toBeInTheDocument();
  });

  it('未发现 PixCall 库时不放行下一步，但用户可以回头选文件夹', async () => {
    // 门禁按发现结果显示：第 1 步的发现要回 1 库按钮才出；卡内会再发现一次
    // （注册表可能在两次之间变化），第二次回空走卡内「没有找到库」的错误态——
    // 这是门禁之后「未发现库」语义的保留路径。
    vi.mocked(pixcallDiscover)
      .mockResolvedValueOnce([{ root: 'C:/Pix', isCurrent: true }])
      .mockResolvedValue([]);
    setup({ currentPath: null, onTakeoverPixcall: async () => {} });
    fireEvent.click(await screen.findByTestId('welcome-use-pixcall'));
    await waitFor(() => expect(screen.getByText('import.noPixcallLibrary')).toBeInTheDocument());
    expect(screen.getByTestId('welcome-next-button')).toBeDisabled();
    // 两颗按钮互斥：回头点「选择文件夹」就回到 folder 模式的门禁
    expect(pixcallProbe).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------- 第 1 步来源按钮门禁
  // 显示口径与设置页一致：按发现结果显示——发现进行中不出（避免闪现点了报错的按钮）、
  // 发现为空不出、发现 ≥1 库才出；「或」分隔线只画在第一颗可见来源按钮之前。

  it('PixCall 发现为空时不渲染 PixCall 按钮，Eagle 接管第二入口位（分隔线移到 Eagle 前）', async () => {
    vi.mocked(pixcallDiscover).mockResolvedValue([]);
    vi.mocked(eagleDiscover).mockResolvedValue([{ root: 'C:/Libs/Test.library', isCurrent: true }]);
    setup({ onTakeoverPixcall: async () => {} });
    expect(await screen.findByTestId('welcome-use-eagle')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome-use-pixcall')).toBeNull();
    expect(screen.getAllByText('welcome.or')).toHaveLength(1);
  });

  it('eagle 模式：还没选资源目录时不许动手，卡内给「选择资源目录」这条路', async () => {
    vi.mocked(eagleDiscover).mockResolvedValue([{ root: 'C:/Libs/Test.library', isCurrent: true }]);
    setup({ currentPath: null, onTakeoverPixcall: async () => {} });
    fireEvent.click(await screen.findByTestId('welcome-use-eagle'));

    expect(await screen.findByText('eagle.takeoverNoRoot')).toBeInTheDocument();
    expect(await screen.findByTestId('welcome-eagle-pick-root')).toBeInTheDocument();
    // 关键：不再把 Eagle 库切成本应用的资源根（那是路线 B，网格会退化成 .info 文件夹）
    expect(eagleProbe).not.toHaveBeenCalled();
    expect(eagleImport).not.toHaveBeenCalled();
    expect(screen.getByTestId('welcome-next-button')).toBeDisabled();
  });

  it('eagle 模式：选好资源目录 → 出迁入位置与条数 → 确认后 probe/import 同一个根，完成后放开下一步', async () => {
    vi.mocked(eagleDiscover).mockResolvedValue([{ root: 'C:/Libs/Test.library', isCurrent: true }]);
    const takeover = vi.fn(async () => {});
    setup({ currentPath: 'C:/Gallery', onTakeoverPixcall: takeover });
    fireEvent.click(await screen.findByTestId('welcome-use-eagle'));

    // 单库自动 probe（零写入），落点 = 用户选的资源根 + 库名，而不是把根切到库上
    await waitFor(() => expect(eagleProbe).toHaveBeenCalledWith('C:/Libs/Test.library', 'C:/Gallery/Test', true));
    expect(takeover).not.toHaveBeenCalled();
    expect(eagleImport).not.toHaveBeenCalled();
    expect(await screen.findByTestId('welcome-eagle-confirm').then(el => el.textContent)).toContain('C:/Gallery/Test');

    fireEvent.click(screen.getByTestId('welcome-eagle-start'));
    await waitFor(() => expect(eagleImport).toHaveBeenCalledWith('C:/Libs/Test.library', 'C:/Gallery/Test', true));

    const row = await screen.findByTestId('welcome-eagle-result');
    expect(row.textContent).toContain('eagle.done');
    expect(row.textContent).toContain('eagle.statTags');
    // 库只印文件夹名，整串路径留给悬停（DOM 常驻、CSS 控制可见）
    expect(screen.getByTestId('eagle-library-path').textContent).toBe('C:/Libs/Test.library');
    expect(screen.getByTestId('welcome-next-button')).toBeEnabled();
  });

  it('两边都发现不到库时只剩「选择文件夹」，连分隔线都不出', async () => {
    vi.mocked(pixcallDiscover).mockResolvedValue([]);
    vi.mocked(eagleDiscover).mockResolvedValue([]);
    setup({ onTakeoverPixcall: async () => {} });
    await waitFor(() => expect(pixcallDiscover).toHaveBeenCalled());
    expect(screen.queryByTestId('welcome-use-pixcall')).toBeNull();
    expect(screen.queryByTestId('welcome-use-eagle')).toBeNull();
    expect(screen.queryByText('welcome.or')).toBeNull();
    expect(screen.getByText('welcome.selectFolder')).toBeInTheDocument();
  });

  it('两路库都发现时两颗按钮连排，且「或」分隔线只出现一条', async () => {
    vi.mocked(eagleDiscover).mockResolvedValue([{ root: 'C:/Libs/Test.library', isCurrent: true }]);
    setup({ onTakeoverPixcall: async () => {} });
    expect(await screen.findByTestId('welcome-use-pixcall')).toBeInTheDocument();
    expect(await screen.findByTestId('welcome-use-eagle')).toBeInTheDocument();
    expect(screen.getAllByText('welcome.or')).toHaveLength(1);
  });

  it('发现进行中两颗来源按钮都不渲染（不留点了只能报错的按钮）', () => {
    vi.mocked(pixcallDiscover).mockImplementation(() => new Promise<never[]>(() => {}));
    vi.mocked(eagleDiscover).mockImplementation(() => new Promise<never[]>(() => {}));
    setup({ onTakeoverPixcall: async () => {} });
    expect(screen.queryByTestId('welcome-use-pixcall')).toBeNull();
    expect(screen.queryByTestId('welcome-use-eagle')).toBeNull();
    expect(screen.queryByText('welcome.or')).toBeNull();
    expect(screen.getByText('welcome.selectFolder')).toBeInTheDocument();
  });
});
