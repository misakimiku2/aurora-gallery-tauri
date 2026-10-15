/**
 * 临时诊断通道（P1.5-B 视频封面排查专用，**取证后删**）。
 *
 * WebView 的 console 在 `npm run tauri:dev` 终端不可见——排查「请求是否发出 /
 * 走了哪个分支」时，把前端事件经 `frontend_debug_log` 命令转发进 tauri-plugin-log
 * （终端可见）。定位完成后本文件与 Rust 侧命令一并删除（项目惯例）。
 */
import { invoke } from '@tauri-apps/api/core';

/** 取路径 basename（诊断日志用，缩短输出） */
export const feBaseName = (p: string): string => p.split(/[\\/]/).pop() || p;

export const feLog = (scope: string, message: string): void => {
  try {
    invoke('frontend_debug_log', { scope, message }).catch(() => {});
  } catch {
    /* 非 Tauri 环境（测试）静默 */
  }
};
