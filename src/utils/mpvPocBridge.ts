/**
 * PoC-A 调试桥：把原生播放内核（libmpv）暴露到 DevTools，便于手动验证。
 *
 * 用法（应用起来后，DevTools Console）：
 * ```
 * await window.__AURORA_POC_MPV__.status()
 * await window.__AURORA_POC_MPV__.open('F:/SEX/某片.avi', 100, 100, 960, 540)
 * await window.__AURORA_POC_MPV__.command(['cycle', 'pause'])
 * await window.__AURORA_POC_MPV__.command(['seek', '30'])
 * await window.__AURORA_POC_MPV__.stop()
 * ```
 *
 * ⚠️ 仅用于 PoC 阶段验证「原生窗口能否嵌进 Tauri 窗口」。
 *    正式接入（ImageViewer 调用）后本文件整体删除。
 */

import { isTauriEnvironment } from './environment';

export type MpvPocBridge = {
  status: () => Promise<string>;
  open: (
    path: string,
    x: number,
    y: number,
    w: number,
    h: number,
    mode?: 'popup' | 'child'
  ) => Promise<string>;
  command: (args: string[]) => Promise<void>;
  stop: () => Promise<void>;
};

declare global {
  interface Window {
    __AURORA_POC_MPV__?: MpvPocBridge;
  }
}

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** 在 Tauri 环境下挂一个全局调试入口；非 Tauri 环境静默跳过。 */
export function installMpvPocBridge(): void {
  if (!isTauriEnvironment()) return;

  window.__AURORA_POC_MPV__ = {
    status: () => call('poc_mpv_status'),
    open: (path, x, y, w, h, mode) =>
      call('poc_mpv_open', { path, x, y, w, h, mode: mode ?? 'child' }),
    command: (args) => call('poc_mpv_command', { args }),
    stop: () => call('poc_mpv_stop'),
  };
}
