import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import LanSharePanel from '../settings/LanSharePanel';
import { AndroidDownloadCard } from '../settings/AndroidDownloadCard';
import { LanShareSettings } from '../../types';
import { androidApkDownloadUrl } from '../../api/tauri-bridge/updater';

vi.mock('../../api/tauri-bridge', () => ({
  lanShareStart: vi.fn(async () => ({ port: 8765, local_ip: '192.168.1.10' })),
  lanShareStop: vi.fn(async () => {}),
  lanShareGetStatus: vi.fn(async () => ({ is_running: false, port: 8765, local_ip: null, device_count: 0 })),
  lanShareGetDevices: vi.fn(async () => []),
  lanShareRenameDevice: vi.fn(async () => true),
  lanShareUpdateConfig: vi.fn(async () => {}),
  lanShareGetLocalIp: vi.fn(async () => null),
  lanShareRemoveDevice: vi.fn(async () => {}),
}));

vi.mock('../../api/tauri-bridge/updater', () => ({
  // 默认失败 → 二维码回退发行页（个别用例单独 mockResolvedValue 覆盖为直链）
  androidApkDownloadUrl: vi.fn(async () => {
    throw new Error('offline');
  }),
}));

vi.mock('../../utils/androidPlatform', () => ({
  isAndroidPlatform: vi.fn(async () => false),
}));

vi.mock('../lan-client/LanClientPanel', () => ({
  LanClientPanel: () => null,
}));

vi.mock('../android-client/androidClientApi', () => ({
  androidClientRegistry: { get: vi.fn(() => undefined), unregister: vi.fn() },
}));

const PAGE_URL = 'https://gitee.com/misakimiku2/aurora_gallery/releases';
const APK_URL = 'https://gitee.com/misakimiku2/aurora_gallery/releases/download/v2.0.0/AuroraGallery-v2.0.0.apk';

const lanShare = (overrides?: Partial<LanShareSettings>): LanShareSettings => ({
  enabled: false,
  port: 8765,
  accessCode: '',
  allowEdit: true,
  allowUpload: true,
  ...overrides,
});

const t = (key: string) => key;

/** 把挂载期的异步回源（服务状态 / APK 清单）落进 act，避免 act 警告掩盖真实时序 */
const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const renderPanel = async (settings: LanShareSettings) => {
  render(<LanSharePanel t={t} settings={settings} onUpdateSettings={vi.fn()} rootPath="/pics" />);
  await flush();
};

const renderCard = async () => {
  render(<AndroidDownloadCard t={t} />);
  await flush();
};

describe('LanSharePanel 安卓端下载卡显隐', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('共享未开启：显示下载卡', async () => {
    await renderPanel(lanShare({ enabled: false }));
    expect(screen.getByTestId('lan-android-download')).toBeInTheDocument();
  });

  it('共享已开启：不显示下载卡（让位给扫码连接二维码）', async () => {
    await renderPanel(lanShare({ enabled: true }));
    expect(screen.queryByTestId('lan-android-download')).toBeNull();
  });
});

describe('AndroidDownloadCard 下载链路', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('清单取不到时二维码回退发行页', async () => {
    await renderCard();
    expect(screen.getByTestId('lan-android-qr').getAttribute('src')).toContain(encodeURIComponent(PAGE_URL));
  });

  it('清单可取时二维码直连当前版本 APK', async () => {
    vi.mocked(androidApkDownloadUrl).mockResolvedValueOnce(APK_URL);
    await renderCard();
    // img 按 key 重挂载，每次重新查询节点
    await waitFor(() =>
      expect(screen.getByTestId('lan-android-qr').getAttribute('src')).toContain(encodeURIComponent(APK_URL))
    );
  });

  it('加载期间转圈占位，图片加载完成后收起', async () => {
    await renderCard();
    expect(screen.getByTestId('lan-android-qr-loading')).toBeInTheDocument();
    fireEvent.load(screen.getByTestId('lan-android-qr'));
    expect(screen.queryByTestId('lan-android-qr-loading')).toBeNull();
  });

  it('图片命中缓存（挂载即 complete）时转圈不留挂', async () => {
    // 缓存命中时 load 事件在 React 挂上 onLoad 前就已触发，只等 onLoad 会永远转圈
    const proto = window.HTMLImageElement.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'complete');
    Object.defineProperty(proto, 'complete', { configurable: true, get: () => true });
    try {
      await renderCard();
      // 先确认码在渲染，否则「没有转圈」是空断言
      expect(screen.getByTestId('lan-android-qr')).toBeInTheDocument();
      expect(screen.queryByTestId('lan-android-qr-loading')).toBeNull();
    } finally {
      if (original) Object.defineProperty(proto, 'complete', original);
      else delete (proto as any).complete;
    }
  });

  it('外链图片加载失败时给出可复制地址的提示，占位收起', async () => {
    await renderCard();
    fireEvent.error(screen.getByTestId('lan-android-qr'));
    expect(screen.queryByTestId('lan-android-qr-loading')).toBeNull();
    expect(screen.getByText('settings.lanShare.androidDownload.qrFailed')).toBeInTheDocument();
  });

  it('复制按钮写入当前扫码落点，2 秒后回显复原', async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    await renderCard();
    // 回源微任务已落进 act，此后才接管定时器验证 2 秒复原
    vi.useFakeTimers();
    try {
      fireEvent.click(screen.getByText('settings.lanShare.copy'));
      expect(writeText).toHaveBeenCalledWith(PAGE_URL);
      expect(screen.getByText('settings.lanShare.copied')).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(2000);
      });
      expect(screen.getByText('settings.lanShare.copy')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
