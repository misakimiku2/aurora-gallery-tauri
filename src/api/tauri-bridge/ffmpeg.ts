/**
 * ffmpeg 封面管线前端桥（P1.5-B，桌面专属）。
 *
 * 安卓端不注册 ffmpeg_* 命令，调用方（设置面板）必须先判 `isAndroid`。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface FfmpegStatus {
  /** ffmpeg 可用（定位成功且 `ffmpeg -version` 能跑通） */
  available: boolean;
  /** "system"（系统 PATH）/ "downloaded"（本应用下载副本）；不可用时 null */
  source: 'system' | 'downloaded' | null;
  /** ffmpeg 可执行文件路径 */
  path: string | null;
  /** `ffmpeg -version` 首行，如 "ffmpeg version n7.1-latest_lgpl..." */
  version: string | null;
  /**
   * S5：下载副本的安装来源（读 install-info.json）。
   * "pinned" = SHA256 校验过的固定源；"latest" = 404 回退的**未校验**源（UI 需警示）。
   * 系统副本 / 未安装 / 旧副本（无 install-info.json）时为 null。
   */
  installSource: 'pinned' | 'latest' | null;
}

/** 查询 ffmpeg 三态状态；invoke 失败（如安卓端无此命令）返回 null，由调用方按「未知」处理 */
export const getFfmpegStatus = async (): Promise<FfmpegStatus | null> => {
  try {
    return await invoke<FfmpegStatus>('ffmpeg_status');
  } catch {
    return null;
  }
};

/**
 * 模块级可用性缓存（S3）：进程生命周期内只探测一次。
 *
 * 用途：`getVideoCover` 的失败分诊——「无 ffmpeg + 前端也解不了的容器」的封面失败
 * **不进 60s 负缓存**（否则 S4 下载完成后 60s 内仍不生成；无 ffmpeg 时后端 locate
 * 短路开销极小，允许反复试探）。设置面板不受此缓存影响（它走 getFfmpegStatus 原始查询）。
 */
let availabilityCache: boolean | null = null;

export const isFfmpegAvailable = async (): Promise<boolean> => {
  if (availabilityCache !== null) return availabilityCache;
  const status = await getFfmpegStatus();
  availabilityCache = status?.available ?? false;
  return availabilityCache;
};

/** S4 下载完成后调用：清掉缓存让下次判定重新探测 */
export const invalidateFfmpegAvailability = (): void => {
  availabilityCache = null;
};

// ── S4：下载器（BtbN LGPL 静态源 + SHA256 pin；事件形状对齐 CLIP 下载）────────

export type FfmpegDownloadStatus =
  | 'downloading'
  | 'paused'
  | 'verifying'
  | 'extracting'
  | 'completed'
  | 'failed';

export interface FfmpegDownloadProgress {
  downloaded: number;
  total: number;
  /** 0-100 */
  progress: number;
  /** bytes/sec */
  speed: number;
  status: FfmpegDownloadStatus;
  /** 回退 latest 源时的告警（该构建内容每日变、无官方校验和） */
  warning: string | null;
  /** status = failed 时的错误信息 */
  error: string | null;
}

/**
 * 监听下载进度（200ms 节流；暂停/校验/解压/完成/失败各态都会推事件）。
 * 返回取消监听函数。
 */
export const listenFfmpegDownloadProgress = (
  callback: (data: FfmpegDownloadProgress) => void
): Promise<() => void> =>
  listen('ffmpeg-download-progress', (event: any) => {
    callback(event.payload as FfmpegDownloadProgress);
  });

/** 启动下载（阻塞到完成/失败；进度经事件推送。重入时 reject「下载已在进行中」） */
export const ffmpegDownloadStart = (): Promise<void> => invoke<void>('ffmpeg_download_start');

export const ffmpegDownloadPause = (): Promise<void> => invoke<void>('ffmpeg_download_pause');
export const ffmpegDownloadResume = (): Promise<void> => invoke<void>('ffmpeg_download_resume');
/** 取消：中断下载并删除未完成的 part 文件 */
export const ffmpegDownloadCancel = (): Promise<void> => invoke<void>('ffmpeg_download_cancel');
/** 清理：删除整个 ffmpeg 下载目录（zip 残留 + 已装 exe），用于「重新下载」 */
export const ffmpegDownloadCleanup = (): Promise<void> => invoke<void>('ffmpeg_download_cleanup');

// ── 全局进度桥接（S4.1）：把 ffmpeg 下载进度灌进 CLIP 那套全局下载 store ──────
//
// 目的：设置面板关闭后，左侧面板底部仍显示下载进度条（指挥官实测反馈：
// CLIP 下载有这个全局条，ffmpeg 下载没有）。机制 = 复用
// `modelDownloadState.ts` 的全局 store + listeners（TreeSidebar 订阅渲染），
// ffmpeg 下载卡片点击跳「通用设置」而非 AI 视觉（navigateTo 字段）。

import {
  updateModelDownloadProgress,
  completeModelDownload,
  errorModelDownload,
} from '../../utils/modelDownloadState';

const FFMPEG_DOWNLOAD_KEY = 'ffmpeg';

let bridgeStarted = false;

/**
 * 启动 ffmpeg 下载 → 全局 store 的桥接（幂等：整个进程只挂一个监听器）。
 * 在设置面板挂载时调用即可——下载只能从面板发起，面板开过 = 桥已活，
 * 之后面板关闭/重开都不影响左侧面板的全局进度条。
 */
export const startFfmpegDownloadBridge = async (): Promise<void> => {
  if (bridgeStarted) return;
  bridgeStarted = true;
  try {
    await listenFfmpegDownloadProgress((p) => {
      const navigateTo = 'navigate-to-settings-general';
      switch (p.status) {
        case 'downloading':
        case 'verifying':
        case 'extracting':
          // verifying/extracting 阶段沿用 downloading 态（total 用事件携带的字节数）
          updateModelDownloadProgress(
            FFMPEG_DOWNLOAD_KEY,
            'FFmpeg',
            p.status === 'downloading' ? 'ffmpeg.zip' : p.status === 'verifying' ? '校验完整性…' : '安装中…',
            0,
            1,
            p.progress,
            p.downloaded,
            p.total,
            p.speed,
            'downloading',
            undefined,
            navigateTo
          );
          break;
        case 'paused':
          updateModelDownloadProgress(
            FFMPEG_DOWNLOAD_KEY,
            'FFmpeg',
            'ffmpeg.zip',
            0,
            1,
            p.progress,
            p.downloaded,
            p.total,
            0,
            'paused',
            undefined,
            navigateTo
          );
          break;
        case 'completed':
          completeModelDownload(FFMPEG_DOWNLOAD_KEY);
          break;
        case 'failed':
          errorModelDownload(FFMPEG_DOWNLOAD_KEY, p.error ?? '下载失败');
          break;
      }
    });
  } catch (e) {
    bridgeStarted = false; // 允许下次重试
    console.error('[ffmpeg] failed to start download bridge:', e);
  }
};
