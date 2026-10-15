/**
 * 视频 P2 · 播放格式兜底前端桥（桌面专属 remux，2026-10-15）
 *
 * **为什么需要这一层**：`mkv / avi / flv / ts / 3gp` 里的视频流往往就是 H.264 + AAC
 * ——不是解不了，是**容器**不被 WebView2 认（设计方案 §12.1「A 类」）。
 * 后端用 `ffmpeg -c copy` 换个包装（MP4），产物本身同样是一个普通本地文件，
 * 于是直接复用**已有的 asset 协议 + Range**播放，本部桥只负责：
 *   ① 判定要不要转（原生可解容器一律不打扰）② 取产物路径 ③ 订阅转封装进度
 *
 * **安卓端不注册 `video_remux_*` 命令**（原生解码器通吃，设计方案 §12.5）——
 * 所有 invoke 失败一律降级为「不支持」，调用方保持原有行为，**不得**因此报错。
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

/** Rust `RemuxStatus` 的 snake_case 取值（两侧必须同步） */
export type RemuxStatus = 'direct' | 'pending' | 'ready' | 'failed';

export interface RemuxStateDto {
  /** 源文件路径（事件与返回体都带，便于调用方按 path 匹配） */
  path: string;
  status: RemuxStatus;
  /** 0.0–1.0；`pending` 期间由进度事件持续更新 */
  progress: number;
  /** 产物绝对路径；`direct` 时为 null（调用方直接播源） */
  output_path: string | null;
  /** 失败原因（自由文本；Rust 侧的稳定标记见 `remuxFailureKind`） */
  message: string | null;
}

export interface RemuxStats {
  files: number;
  bytes: number;
  limit_bytes: number;
}

/** 后端进度/完成事件名 */
export const REMUX_PROGRESS_EVENT = 'video-remux-progress';

/**
 * Rust 侧 message 的稳定标记 → 前端分类：
 * - `no_ffmpeg`：本机没有 ffmpeg 组件 → 提示去设置面板安装
 * - `remux_failed`：转封装失败（多半是编码也不支持 = B 类，或文件损坏）
 */
export type RemuxFailureKind = 'no_ffmpeg' | 'remux_failed';

export const remuxFailureKind = (message: string | null): RemuxFailureKind =>
  message === 'no_ffmpeg' ? 'no_ffmpeg' : 'remux_failed';

/**
 * 确保视频可播：返回四态，调用方据此决定怎么播。
 * - `direct` → 播源文件（原生可解容器，**行为零变化**）
 * - `pending` → 后台转封装中，等 `REMUX_PROGRESS_EVENT` 推送
 * - `ready`  → 播 `output_path`（第二次点开通常是缓存命中，无 ffmpeg 开销）
 * - `failed` → 降级 UI（提示 + 用系统播放器打开）
 *
 * `force = true`：连原生可解容器（mkv）也强制转封装 —— 用于「直播失败」后的兜底一次尝试
 * （容器可解 ≠ 一定播得了：里面的编码/音轨可能不被支持，换个包装就活了）。
 *
 * invoke 失败（安卓端 / 命令未注册）统一降级为 `failed`，不抛异常。
 */
export const ensureVideoPlayable = async (path: string, force = false): Promise<RemuxStateDto> => {
  try {
    return await invoke<RemuxStateDto>('video_remux_ensure', { path, force });
  } catch (e) {
    return { path, status: 'failed', progress: 0, output_path: null, message: 'unavailable' };
  }
};

/**
 * **只查缓存、绝不触发转封装** —— D6①：卡片悬停预览用它，意味着「滚动不会引发
 * 任何 GB 级转换」，只有已经在查看器里转过的文件才会被悬停复用。
 */
export const probeVideoRemuxCache = async (path: string): Promise<string | null> => {
  try {
    return await invoke<string | null>('video_remux_probe', { path });
  } catch {
    return null;
  }
};

/** 产物占用统计（设置面板显示） */
export const getVideoRemuxStats = async (): Promise<RemuxStats | null> => {
  try {
    return await invoke<RemuxStats>('video_remux_stats');
  } catch {
    return null;
  }
};

/** 清空产物；返回清理后的统计 */
export const clearVideoRemuxCache = async (): Promise<RemuxStats | null> => {
  try {
    return await invoke<RemuxStats>('video_remux_clear');
  } catch {
    return null;
  }
};

/** 订阅转封装进度/完成事件；不支持时返回 null */
export const onRemuxProgress = async (
  cb: (state: RemuxStateDto) => void
): Promise<UnlistenFn | null> => {
  try {
    return await listen<RemuxStateDto>(REMUX_PROGRESS_EVENT, (event) => cb(event.payload));
  } catch {
    return null;
  }
};
