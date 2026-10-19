/**
 * 视频 P2 · 播放格式兜底前端桥（桌面专属 remux，2026-10-15）
 *
 * **为什么需要这一层**：`mkv / avi / flv / ts / 3gp` 里的视频流往往就是 H.264 + AAC
 * ——不是解不了，是**容器**不被 WebView2 认（设计方案 §12.1「A 类」）。
 * 后端用 `ffmpeg -c copy` 换个包装（MP4），产物本身同样是一个普通本地文件，
 * 于是直接复用**已有的 asset 协议 + Range**播放，本部桥只负责：
 *   ① 判定要不要转（原生可解容器一律不打扰）② 取产物路径 ③ 订阅转封装进度
 *
 * **安卓端不注册 `video_remux_*` / `transcode_batch_*` 命令**（手机侧没有 ffmpeg，
 * 格式兜底全部在桌面做）—— 所有 invoke 失败一律降级为「不支持」，
 * 调用方保持原有行为，**不得**因此报错。
 *
 * ⚠️ 2026-10-19 更正：这里旧写法「原生解码器通吃，设计方案 §12.5」是**错的**，
 * 真机取证推翻了它（这台机的提取器清单里没有 AVI 也没有 ASF，海思 VC-1 解码器
 * 声明了却拉不起来）。桌面这套产物链路现在同时服务 WebView 与 LAN 手机，
 * 取证与判决见 P3 清单 §16。
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

/**
 * 告诉后端当前资源根，把视频产物目录对齐到媒体盘上的
 * `<根>/.Aurora_Cache/video-products`。
 *
 * **必须在启动时与切根后各调一次**：产物是 GB 级的，不报根就回落到
 * `%LOCALAPPDATA%`（本机 C: 只剩 20GB，两三支 avi 就把系统盘推到底）。
 * 失败静默 —— 安卓端没这条命令，返回值只用来打日志。
 */
export const configureVideoProducts = async (resourceRoot: string): Promise<string | null> => {
  if (!resourceRoot) return null;
  try {
    return await invoke<string | null>('video_products_configure', { resourceRoot });
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

/**
 * 视频 P3 · B 类批量预转队列（2026-10-19，桌面专属）
 *
 * 为什么单独一条队列：B 类（WMV/VC-1、MJPEG）手机连解码器都拉不起来，只能重编；
 * 实测 `h264_mf` 质量档 ~39x 实时，一只两小时的片子仍要三五分钟。真等点开才转，
 * 手机那头就是「按下播放然后等」，与「下载视频点开就能看」这条原则冲突。
 * A 类不在队列里 —— remux 秒级无损，点开时现转就够，批量做只会多占一份和原片等大的空间。
 */

/** Rust `transcode_batch::BatchStatusDto`（字段名逐一对齐，改一侧必须改另一侧） */
export interface TranscodeBatchStatus {
  running: boolean;
  total: number;
  done: number;
  succeeded: number;
  failed: number;
  current: string | null;
  current_progress: number;
  last_error: string | null;
  /** 空闲时现扫的候选数；跑起来后等于 total */
  candidates: number;
  bytes_planned: number;
  /** 按实测倍速的一半保守估的分钟数 */
  est_minutes: number;
  ffmpeg_present: boolean;
  output_dir: string | null;
  output_bytes: number;
  output_limit_bytes: number;
}

export const TRANSCODE_BATCH_EVENT = 'video-transcode-batch-progress';

/** 队列状态（顺带把产物目录按资源根对齐）；失败回 null，调用方按「不支持」处理 */
export const getTranscodeBatchStatus = async (
  resourceRoot: string
): Promise<TranscodeBatchStatus | null> => {
  try {
    return await invoke<TranscodeBatchStatus>('transcode_batch_status', {
      resourceRoot,
    });
  } catch {
    return null;
  }
};

/** 起队列（已在跑就原样返回当前状态，不排第二个线程） */
export const startTranscodeBatch = async (
  resourceRoot: string
): Promise<TranscodeBatchStatus | null> => {
  try {
    return await invoke<TranscodeBatchStatus>('transcode_batch_start', {
      resourceRoot,
    });
  } catch {
    return null;
  }
};

/**
 * 请求停止。**当前那只会跑完**（中途打断已转九成的片子更亏），
 * 所以点完按钮进度还会往前走一段，UI 别把它当卡死。
 */
export const stopTranscodeBatch = async (): Promise<TranscodeBatchStatus | null> => {
  try {
    return await invoke<TranscodeBatchStatus>('transcode_batch_stop');
  } catch {
    return null;
  }
};

/** 清空转码产物（与 remux 缓存分开的两个按钮：转好的重编要几十分钟，不能跟着「清缓存」一起被抹掉） */
export const clearTranscodeOutputs = async (): Promise<RemuxStats | null> => {
  try {
    return await invoke<RemuxStats>('transcode_clear_outputs');
  } catch {
    return null;
  }
};

/** 订阅队列进度；不支持时返回 null */
export const onTranscodeBatchProgress = async (
  cb: (s: TranscodeBatchStatus) => void
): Promise<UnlistenFn | null> => {
  try {
    return await listen<TranscodeBatchStatus>(TRANSCODE_BATCH_EVENT, (e) => cb(e.payload));
  } catch {
    return null;
  }
};
