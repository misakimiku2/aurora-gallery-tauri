import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { WelcomeModal } from '../modals/WelcomeModal';
import { AppSettings } from '../../types';
import { lanShareStart } from '../../api/tauri-bridge';
import { androidApkDownloadUrl } from '../../api/tauri-bridge/updater';
import { aiService } from '../../services/aiService';

vi.mock('../../api/tauri-bridge', () => ({
  lanShareStart: vi.fn(async () => ({ port: 8765, local_ip: '192.168.1.10' })),
  lanShareStop: vi.fn(async () => {}),
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
    const qr = screen.getByTestId('welcome-android-qr');
    await waitFor(() =>
      expect(qr.getAttribute('src')).toContain(
        encodeURIComponent('https://gitee.com/misakimiku2/aurora_gallery/releases')
      )
    );
  });

  it('互联步：清单可取时二维码直连当前版本 APK', async () => {
    vi.mocked(androidApkDownloadUrl).mockResolvedValueOnce(
      'https://gitee.com/misakimiku2/aurora_gallery/releases/download/v2.0.0/AuroraGallery-v2.0.0.apk'
    );
    gotoStep4();
    const qr = screen.getByTestId('welcome-android-qr');
    await waitFor(() =>
      expect(qr.getAttribute('src')).toContain(
        encodeURIComponent(
          'https://gitee.com/misakimiku2/aurora_gallery/releases/download/v2.0.0/AuroraGallery-v2.0.0.apk'
        )
      )
    );
  });
});
