import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import LanSharePanel from '../settings/LanSharePanel';
import { LanShareSettings } from '../../types';

vi.mock('../../api/tauri-bridge', () => ({
  lanShareStart: vi.fn(async () => ({ port: 8765, local_ip: '192.168.31.87' })),
  lanShareStop: vi.fn(async () => {}),
  // 服务在跑：面板才会算出 aurora-lan 二维码内容
  lanShareGetStatus: vi.fn(async () => ({ is_running: true, port: 8765, local_ip: '192.168.31.87', device_count: 0 })),
  lanShareGetDevices: vi.fn(async () => []),
  lanShareRenameDevice: vi.fn(async () => true),
  lanShareUpdateConfig: vi.fn(async () => {}),
  lanShareGetLocalIp: vi.fn(async () => '192.168.31.87'),
  lanShareRemoveDevice: vi.fn(async () => {}),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
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

const t = (key: string) => key;

const settings = (overrides?: Partial<LanShareSettings>): LanShareSettings => ({
  enabled: true,
  port: 8765,
  accessCode: '4321',
  allowEdit: true,
  allowUpload: true,
  ...overrides,
});

/** 等服务状态 / 设备列表这些挂载期异步回源落进 act */
const flush = async () => {
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 0));
  });
};

const renderPanel = async () => {
  render(<LanSharePanel t={t} settings={settings()} onUpdateSettings={vi.fn()} rootPath="/pics" />);
  await flush();
};

/** 模拟图片命中 HTTP 缓存：节点一挂上就已 complete（直接 await 调用，别返回函数——那样断言根本不会跑） */
const withCachedImage = async (run: () => Promise<void>) => {
  const proto = window.HTMLImageElement.prototype;
  const original = Object.getOwnPropertyDescriptor(proto, 'complete');
  Object.defineProperty(proto, 'complete', { configurable: true, get: () => true });
  try {
    await run();
  } finally {
    if (original) Object.defineProperty(proto, 'complete', original);
    else delete (proto as any).complete;
  }
};

describe('LanSharePanel 扫码连接二维码', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('二维码地址就绪时转圈占位，图片加载完成后收起', async () => {
    await renderPanel();
    const qr = screen.getByTestId('lan-connect-qr');
    expect(qr.getAttribute('src')).toContain('aurora-lan');
    expect(screen.getByTestId('lan-connect-qr-loading')).toBeInTheDocument();
    fireEvent.load(qr);
    expect(screen.queryByTestId('lan-connect-qr-loading')).toBeNull();
  });

  it('图片命中缓存（挂载即 complete）时转圈不留挂', async () => {
    await withCachedImage(async () => {
      await renderPanel();
      // 先确认码真的在渲染（否则「没有转圈」是空断言），再确认白底转圈盖不住它
      expect(screen.getByTestId('lan-connect-qr')).toBeInTheDocument();
      expect(screen.queryByTestId('lan-connect-qr-loading')).toBeNull();
    });
  });

  it('地址未就绪时不渲染二维码 img', async () => {
    await withCachedImage(async () => {
      render(<LanSharePanel t={t} settings={settings({ enabled: false })} onUpdateSettings={vi.fn()} rootPath="/pics" />);
      await flush();
      expect(screen.queryByTestId('lan-connect-qr')).toBeNull();
    });
  });

  it('回归：连续两次打开面板（同一份缓存图）都能出码', async () => {
    await withCachedImage(async () => {
      const first = render(<LanSharePanel t={t} settings={settings()} onUpdateSettings={vi.fn()} rootPath="/pics" />);
      await flush();
      expect(screen.queryByTestId('lan-connect-qr-loading')).toBeNull();
      first.unmount();

      render(<LanSharePanel t={t} settings={settings()} onUpdateSettings={vi.fn()} rootPath="/pics" />);
      await flush();
      expect(screen.getByTestId('lan-connect-qr')).toBeInTheDocument();
      expect(screen.queryByTestId('lan-connect-qr-loading')).toBeNull();
    });
  });
});
