/**
 * ffmpeg 封面管线前端桥（P1.5-B，S1）。
 *
 * 桌面专属：安卓端不注册 `ffmpeg_status` 命令，调用方（设置面板）必须先判 `isAndroid`。
 * S4 将在此追加下载器命令（下载 / 暂停 / 继续 / 取消，事件形状对齐 CLIP 下载）。
 */
import { invoke } from '@tauri-apps/api/core';

export interface FfmpegStatus {
  /** ffmpeg 可用（定位成功且 `ffmpeg -version` 能跑通） */
  available: boolean;
  /** "system"（系统 PATH）/ "downloaded"（本应用下载副本）；不可用时 null */
  source: 'system' | 'downloaded' | null;
  /** ffmpeg 可执行文件路径 */
  path: string | null;
  /** `ffmpeg -version` 首行，如 "ffmpeg version n7.1-latest_lgpl..." */
  version: string | null;
}

/** 查询 ffmpeg 三态状态；invoke 失败（如安卓端无此命令）返回 null，由调用方按「未知」处理 */
export const getFfmpegStatus = async (): Promise<FfmpegStatus | null> => {
  try {
    return await invoke<FfmpegStatus>('ffmpeg_status');
  } catch {
    return null;
  }
};
